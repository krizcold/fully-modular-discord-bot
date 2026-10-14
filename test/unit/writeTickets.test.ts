import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import {
  confirmFile,
  deleteRawAtomic,
  dropPendingForGuild,
  enqueueAppend,
  enqueueDelete,
  enqueueWrite,
  fileLandingRecords,
  filesPending,
  fileTicket,
  flushAll,
  writeRawAtomic,
  type FileTicket,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { setRouteOverride } from '../../src/bot/internalSetup/utils/dataBackends/routeResolver';
import {
  DataBackendUnavailableError,
  initWorkingSet,
  WorkingSetManager,
  type WsTicket,
} from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import {
  appendData,
  appendDataTracked,
  confirmWrite,
  deleteData,
  deleteDataOutcome,
  deleteDataTracked,
  flushGuildOutcome,
  freezeGuildWrites,
  saveData,
  saveDataOutcome,
  saveDataTracked,
  unfreezeGuildWrites,
} from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { FakeStore, tokenFor, type FlushCall, type FlushMode } from '../helpers/fakeStore';

// BT-1, write tickets (notes/BT.md, "BT-1 design sheet" and its refinements).
// A ticket answers 'ok' only once the store holds its write, or a later write
// or delete of the same document accepted on the same working set or file
// queue; otherwise it says what is true: 'pending', 'held', 'deposed' or
// 'unavailable'.

const GUILD = '100';

async function servedSet(store = new FakeStore(), guildId = GUILD): Promise<{ store: FakeStore; ws: WorkingSetManager }> {
  const ws = new WorkingSetManager(store);
  expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
  return { store, ws };
}

function save(ws: WorkingSetManager, filename: string, value: unknown, guildId = GUILD): WsTicket {
  expect(ws.save(guildId, 'm', filename, JSON.stringify(value))).toBe('accepted');
  return ws.ticketFor(guildId);
}

/** Runs fake time on until the answer comes back; an answer that outlives its deadline fails the test. */
async function answer<T>(pending: Promise<T>, deadlineMs: number): Promise<T> {
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await vi.advanceTimersByTimeAsync(0);
  for (let waited = 0; !settled && waited < deadlineMs + 200; waited += 20) await vi.advanceTimersByTimeAsync(20);
  expect(settled, 'the answer came back by its deadline').toBe(true);
  return pending;
}

// The operator route's answers for a write kept and retried, and for one that left the node unconfirmed.
const HELD = {
  ok: true,
  pending: true,
  note: 'it is not saved yet; this node retries while it serves this guild, and loses it if the bot stops, the guild moves or the node loses its database first',
};
const LEFT_UNCONFIRMED = {
  ok: false,
  code: 'backend-unavailable',
  error: 'this write left this node before it was confirmed saved (the guild moved or was unloaded, its data was deleted or restored from the graveyard, or the node switched databases), so whether it was saved is unknown; reload the data to check',
};

/** Holds every call of the fs function on the target until open; reached resolves once the first is held. */
function holdFs(name: 'rename' | 'appendFile', target: string): { reached: Promise<void>; open: () => void } {
  const real = fs.promises[name] as (...args: unknown[]) => Promise<void>;
  let open: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { open = resolve; });
  let reach: () => void = () => undefined;
  const reached = new Promise<void>(resolve => { reach = resolve; });
  vi.spyOn(fs.promises, name).mockImplementation((async (...args: unknown[]) => {
    if (String(args[name === 'rename' ? 1 : 0]) === target) {
      reach();
      await gate;
    }
    return real.apply(fs.promises, args);
  }) as never);
  return { reached, open };
}

/** Every unlink of the target fails with EPERM until heal. */
function failUnlinks(target: string): { heal: () => void } {
  const real = fs.promises.unlink;
  let failing = true;
  vi.spyOn(fs.promises, 'unlink').mockImplementation(async file => {
    if (failing && String(file) === target) throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' });
    return real.call(fs.promises, file);
  });
  return { heal: () => { failing = false; } };
}

/** The next `count` renames onto the target fail with EPERM; calls counts every rename onto it. */
function failRenames(target: string, count: number): { calls: () => number; heal: () => void } {
  const real = fs.promises.rename;
  let left = count;
  let calls = 0;
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === target) {
      calls += 1;
      if (left > 0) {
        left -= 1;
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
    }
    return real.call(fs.promises, from, to);
  });
  return { calls: () => calls, heal: () => { left = 0; } };
}

/** The next `count` temp-file opens for the target fail with EACCES, so each write attempt fails at once; onOpen sees every such open by its number. */
function failTmpOpens(target: string, count: number, onOpen: (n: number) => void = () => undefined): { calls: () => number } {
  const real = fs.promises.open as (...args: unknown[]) => Promise<unknown>;
  let left = count;
  let calls = 0;
  vi.spyOn(fs.promises, 'open').mockImplementation((async (...args: unknown[]) => {
    const file = String(args[0]);
    if (file.startsWith(`${target}.`) && file.endsWith('.tmp')) {
      calls += 1;
      onOpen(calls);
      if (left > 0) {
        left -= 1;
        throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' });
      }
    }
    return real.apply(fs.promises, args);
  }) as never);
  return { calls: () => calls };
}

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The working set, model-based
// ---------------------------------------------------------------------------

type WsOp =
  | { op: 'save' | 'append' | 'delete'; key: number }
  | { op: 'mode'; mode: FlushMode }
  | { op: 'tick'; ms: number }
  | { op: 'hold' | 'release' | 'evict' | 'rehydrate' | 'recycle' }
  | { op: 'confirm'; pick: number; deadline: number; wait: boolean };

const wsOp: fc.Arbitrary<WsOp> = fc.oneof(
  { weight: 24, arbitrary: fc.record({ op: fc.constantFrom('save' as const, 'append' as const, 'delete' as const), key: fc.integer({ min: 0, max: 2 }) }) },
  { weight: 8, arbitrary: fc.record({ op: fc.constant('mode' as const), mode: fc.constantFrom<FlushMode>('commit', 'unavailable', 'read-only', 'deposed') }) },
  { weight: 12, arbitrary: fc.record({ op: fc.constant('tick' as const), ms: fc.constantFrom(0, 20, 600, 1600) }) },
  { weight: 6, arbitrary: fc.constant<WsOp>({ op: 'hold' }) },
  { weight: 6, arbitrary: fc.constant<WsOp>({ op: 'release' }) },
  { weight: 9, arbitrary: fc.constantFrom<WsOp>({ op: 'evict' }, { op: 'rehydrate' }, { op: 'recycle' }) },
  { weight: 16, arbitrary: fc.record({ op: fc.constant('confirm' as const), pick: fc.nat(), deadline: fc.constantFrom(0, 30, 8000), wait: fc.boolean() }) },
);

interface Accepted {
  /** The working set object that took it: each hydrate of a new set is a new generation. */
  gen: number;
  key: string;
  kind: 'save' | 'append' | 'delete';
  payload: string;
  /** Its place among the writes its set accepted, from 1. */
  index: number;
  ticket: WsTicket;
  manager: WorkingSetManager;
}

/**
 * Whether a commit from the write's own set holds it: its appended line, or
 * the key's document as of a write accepted there at or after it.
 */
function landedFor(write: Accepted, commits: FlushCall[], genOf: Map<FenceToken, number>, setWrites: Accepted[]): boolean {
  return commits.some(commit => {
    if (genOf.get(commit.token) !== write.gen) return false;
    if (write.kind === 'append' && commit.batch.appends.some(a => a.key.filename === write.key && a.chunk.includes(write.payload))) return true;
    const upsert = commit.batch.upserts.find(u => u.key.filename === write.key);
    if (upsert) {
      const source = setWrites.find(w => w.kind === 'save' && w.payload === upsert.doc);
      return source !== undefined && source.key === write.key && source.index >= write.index;
    }
    if (commit.batch.deletes.some(d => d.filename === write.key)) {
      const last = setWrites.filter(w => w.key === write.key && w.kind !== 'append' && w.index <= commit.builtAt).at(-1);
      return last !== undefined && last.kind === 'delete' && last.index >= write.index;
    }
    return false;
  });
}

async function runWorkingSet(ops: WsOp[]): Promise<void> {
  vi.useFakeTimers();
  const store = new FakeStore();
  const managers: WorkingSetManager[] = [];
  try {
    const genOf = new Map<FenceToken, number>();
    const byGen = new Map<number, Accepted[]>();
    store.buildIndex = token => byGen.get(genOf.get(token) ?? 0)?.length ?? 0;
    let manager = new WorkingSetManager(store);
    managers.push(manager);
    let gen = 0;
    let gens = 0;
    const readNewSet = async () => {
      const token = tokenFor();
      gen = ++gens;
      genOf.set(token, gen);
      byGen.set(gen, []);
      expect(await manager.hydrate(GUILD, token)).toBe('ready');
    };
    await readNewSet();

    const accepted: Accepted[] = [];
    const answered: { write: Accepted; outcome: string; commitsSeen: number; liveness: boolean }[] = [];
    const outstanding: Promise<void>[] = [];
    let unique = 0;
    const accept = (kind: Accepted['kind'], key: string, payload: string) => {
      const setWrites = byGen.get(gen)!;
      const write: Accepted = { gen, key, kind, payload, index: setWrites.length + 1, ticket: manager.ticketFor(GUILD), manager };
      setWrites.push(write);
      accepted.push(write);
    };
    const ask = (write: Accepted, deadline: number, liveness: boolean) => write.manager.confirm(write.ticket, deadline).then(outcome => {
      answered.push({ write, outcome, commitsSeen: store.commits.length, liveness });
    });

    for (const step of ops) {
      switch (step.op) {
        case 'save': {
          const key = `k${step.key}.json`;
          const payload = JSON.stringify({ w: ++unique });
          if (manager.save(GUILD, 'm', key, payload) === 'accepted') accept('save', key, payload);
          break;
        }
        case 'append': {
          const key = `k${step.key}.json`;
          const payload = `l${++unique};`;
          if (manager.append(GUILD, 'm', key, payload) === 'accepted') accept('append', key, payload);
          break;
        }
        case 'delete': {
          const key = `k${step.key}.json`;
          if (manager.delete(GUILD, 'm', key) === 'accepted') accept('delete', key, '');
          break;
        }
        case 'mode':
          store.mode = step.mode;
          break;
        case 'tick':
          await vi.advanceTimersByTimeAsync(step.ms);
          break;
        case 'hold':
          store.holding = true;
          break;
        case 'release':
          store.holding = false;
          store.release();
          await vi.advanceTimersByTimeAsync(0);
          break;
        case 'evict':
          manager.evict(GUILD);
          gen = 0;
          break;
        case 'rehydrate':
          // A fenced set is replaced by hydrate itself; any other is evicted first.
          if (manager.stateOf(GUILD) !== 'fenced') manager.evict(GUILD);
          await readNewSet();
          break;
        case 'recycle': {
          const carry = manager.exportDirty([GUILD]);
          manager.quiesce();
          manager = new WorkingSetManager(store);
          managers.push(manager);
          await readNewSet();
          manager.adoptDirty(carry);
          break;
        }
        case 'confirm': {
          if (accepted.length === 0) break;
          // Mostly one of the last few writes, the ones a flush on the wire or a requeue still holds.
          const recent = step.pick % 4 === 0 ? accepted.length : Math.min(3, accepted.length);
          const asked = ask(accepted[accepted.length - 1 - (Math.floor(step.pick / 4) % recent)], step.deadline, false);
          if (step.wait) await answer(asked, step.deadline);
          else outstanding.push(asked);
          break;
        }
      }
    }

    // The store heals, and every flush and every answer comes back.
    store.mode = 'commit';
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(outstanding);
    // Every write is asked once more. Liveness: with the store healthy and the
    // set kept, each of its writes is confirmed.
    const kept = manager.stateOf(GUILD) === 'ready';
    for (const write of accepted) await answer(ask(write, 8000, kept && write.gen === gen && write.manager === manager), 8000);
    for (const { write, outcome, commitsSeen, liveness } of answered) {
      if (liveness) expect(outcome, `liveness for write ${write.index} of set ${write.gen}`).toBe('ok');
      if (outcome === 'ok') {
        expect(landedFor(write, store.commits.slice(0, commitsSeen), genOf, byGen.get(write.gen)!), `write ${write.index} of set ${write.gen} answered ok`).toBe(true);
      }
    }
  } finally {
    for (const m of managers) m.quiesce();
    store.release();
    vi.useRealTimers();
  }
}

describe('working-set tickets, model-based', () => {
  it('answers ok only for a write its own set committed, and always once the store is healthy and the set kept', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    await fc.assert(fc.asyncProperty(fc.array(wsOp, { minLength: 1, maxLength: 40 }), runWorkingSet), { numRuns: 2000 });
  });
});

// ---------------------------------------------------------------------------
// The state x exit table, one row at a time
// ---------------------------------------------------------------------------

interface Row {
  row: string;
  expected: string[];
  run: () => Promise<string[]>;
}

const workingSetRows: Row[] = [
  {
    row: 'a commit of a batch built at or after its sequence',
    expected: ['ok'],
    run: async () => {
      const { store, ws } = await servedSet();
      const ticket = save(ws, 'a.json', { a: 1 });
      const outcome = await answer(ws.confirm(ticket, 1000), 1000);
      expect(store.doc(GUILD, 'a.json')).toBe(JSON.stringify({ a: 1 }));
      return [outcome];
    },
  },
  {
    row: 'a flush on the wire was built before it, and its requeue then commits',
    expected: ['pending', 'pending', 'ok'],
    run: async () => {
      const { store, ws } = await servedSet();
      const first = save(ws, 'a.json', { a: 1 });
      store.holding = true;
      const firstAnswer = ws.confirm(first, 8000);
      const second = save(ws, 'b.json', { b: 1 });
      const onTheWire = await answer(ws.confirm(second, 0), 0);
      store.holding = false;
      store.release();
      expect(await answer(firstAnswer, 8000)).toBe('ok');
      expect(store.doc(GUILD, 'b.json')).toBeUndefined();
      const beforeRequeue = await answer(ws.confirm(second, 0), 0);
      const afterRequeue = await answer(ws.confirm(second, 1000), 1000);
      expect(store.doc(GUILD, 'b.json')).toBe(JSON.stringify({ b: 1 }));
      return [onTheWire, beforeRequeue, afterRequeue];
    },
  },
  {
    // The commit must trim only the buffer it carried, not the one the delete left behind it.
    row: 'a delete and a new append accepted while an append\'s flush is on the wire',
    expected: ['ok', 'ok', 'ok'],
    run: async () => {
      const { store, ws } = await servedSet();
      expect(ws.append(GUILD, 'm', 'log.jsonl', 'one;')).toBe('accepted');
      const first = ws.ticketFor(GUILD);
      store.holding = true;
      const firstAnswer = ws.confirm(first, 8000);
      expect(ws.delete(GUILD, 'm', 'log.jsonl')).toBe('accepted');
      const cleared = ws.ticketFor(GUILD);
      expect(ws.append(GUILD, 'm', 'log.jsonl', 'two;')).toBe('accepted');
      const second = ws.ticketFor(GUILD);
      store.holding = false;
      store.release();
      const outcomes = [await answer(firstAnswer, 8000), await answer(ws.confirm(second, 1000), 1000), await answer(ws.confirm(cleared, 0), 0)];
      expect(store.streams.get(`${GUILD}|m/log.jsonl`)).toBe('two;');
      return outcomes;
    },
  },
  ...([
    ['unreachable', 'unavailable', false],
    ['read-only', 'read-only', false],
    ['not proven to hold its master\'s term', 'read-only', true],
  ] as const).map(([why, mode, unproven]): Row => ({
    row: `the store refuses the commit (${why}), and the write is kept dirty and retried`,
    expected: ['held', 'ok'],
    run: async () => {
      const { store, ws } = await servedSet();
      store.mode = mode;
      store.unproven = unproven;
      const ticket = save(ws, 'a.json', { a: 1 });
      const refused = await answer(ws.confirm(ticket, 1000), 1000);
      expect(ws.writesSettled()).toBe(false);
      expect(store.doc(GUILD, 'a.json')).toBeUndefined();
      store.mode = 'commit';
      store.unproven = false;
      const healed = await answer(ws.confirm(ticket, 1000), 1000);
      expect(store.doc(GUILD, 'a.json')).toBe(JSON.stringify({ a: 1 }));
      return [refused, healed];
    },
  })),
  {
    row: 'the deadline passes with the flush still on the wire',
    expected: ['pending', 'pending'],
    run: async () => {
      const { store, ws } = await servedSet();
      const ticket = save(ws, 'a.json', { a: 1 });
      store.holding = true;
      const ownFlush = await answer(ws.confirm(ticket, 100), 100);
      const waitedFor = await answer(ws.confirm(ticket, 100), 100);
      store.holding = false;
      store.release();
      return [ownFlush, waitedFor];
    },
  },
  {
    row: 'the deadline passes with the write waiting to retry',
    expected: ['pending'],
    run: async () => {
      const { store, ws } = await servedSet();
      store.mode = 'unavailable';
      const ticket = save(ws, 'a.json', { a: 1 });
      await vi.advanceTimersByTimeAsync(600);
      expect(ws.writesSettled()).toBe(false);
      return [await answer(ws.confirm(ticket, 0), 0)];
    },
  },
  {
    row: 'deposed: a newer owner fenced the guild, by its own flush or a debounced one',
    expected: ['deposed', 'deposed'],
    run: async () => {
      const forced = await servedSet();
      forced.store.mode = 'deposed';
      const own = await answer(forced.ws.confirm(save(forced.ws, 'a.json', { a: 1 }), 1000), 1000);
      const debounced = await servedSet();
      debounced.store.mode = 'deposed';
      const ticket = save(debounced.ws, 'a.json', { a: 1 });
      await vi.advanceTimersByTimeAsync(600);
      expect(debounced.ws.stateOf(GUILD)).toBe('fenced');
      return [own, await answer(debounced.ws.confirm(ticket, 1000), 1000)];
    },
  },
  {
    row: 'evicted at a drain end',
    expected: ['unavailable'],
    run: async () => {
      const { ws } = await servedSet();
      const ticket = save(ws, 'a.json', { a: 1 });
      ws.evict(GUILD);
      return [await answer(ws.confirm(ticket, 1000), 1000)];
    },
  },
  {
    // Its requeue still runs on the evicted set and commits an empty batch
    // stamped past the write the eviction dropped.
    row: 'evicted with its flush on the wire and a write accepted during it',
    expected: ['unavailable', 'unavailable', 'unavailable'],
    run: async () => {
      const { store, ws } = await servedSet();
      const carried = save(ws, 'a.json', { a: 1 });
      store.holding = true;
      const onTheWire = ws.confirm(carried, 8000);
      const dropped = save(ws, 'b.json', { b: 1 });
      ws.evict(GUILD);
      store.holding = false;
      store.release();
      const forced = await answer(onTheWire, 8000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(store.doc(GUILD, 'b.json')).toBeUndefined();
      return [forced, await answer(ws.confirm(carried, 1000), 1000), await answer(ws.confirm(dropped, 1000), 1000)];
    },
  },
  {
    // The failed flush hands its keys back to the evicted set: they are never sent from it again.
    row: 'evicted with its flush on the wire, which the store then refuses',
    expected: ['unavailable'],
    run: async () => {
      const { store, ws } = await servedSet();
      const ticket = save(ws, 'a.json', { a: 1 });
      store.holding = true;
      store.mode = 'unavailable';
      void ws.confirm(ticket, 8000);
      ws.evict(GUILD);
      store.holding = false;
      store.release();
      await vi.advanceTimersByTimeAsync(0);
      store.mode = 'commit';
      const outcome = await answer(ws.confirm(ticket, 1000), 1000);
      expect(store.flushesSent).toBe(1);
      return [outcome];
    },
  },
  {
    // The refusal comes back to the confirm that sent it: nothing is left to hold the write for a retry.
    row: 'evicted or recycled away while its own forced flush is on the wire, which the store then refuses',
    expected: ['unavailable', 'unavailable'],
    run: async () => {
      const outcomes: string[] = [];
      for (const leave of [(ws: WorkingSetManager) => ws.evict(GUILD), (ws: WorkingSetManager) => ws.quiesce()]) {
        const { store, ws } = await servedSet();
        const ticket = save(ws, 'a.json', { a: 1 });
        store.holding = true;
        store.mode = 'unavailable';
        const forced = ws.confirm(ticket, 8000);
        expect(store.flushesSent).toBe(1);
        leave(ws);
        store.holding = false;
        store.release();
        outcomes.push(await answer(forced, 8000));
      }
      return outcomes;
    },
  },
  {
    row: 'evicted when its reclaim finds another node owned the guild since',
    expected: ['unavailable'],
    run: async () => {
      const { store, ws } = await servedSet();
      const ticket = save(ws, 'a.json', { a: 1 });
      ws.freezeRetained(GUILD);
      store.reclaim = 'lost';
      expect(await ws.hydrate(GUILD, tokenFor())).toBe('ready');
      expect(store.doc(GUILD, 'a.json')).toBeUndefined();
      return [await answer(ws.confirm(ticket, 1000), 1000)];
    },
  },
  {
    // The sheet's table lists the fenced drain under evicted (unavailable); its
    // refinements check fenced before gone, and the write was dropped when the
    // set was deposed, so the answer names that.
    row: 'evicted by the fenced drain after a deposition',
    expected: ['deposed'],
    run: async () => {
      const { store, ws } = await servedSet();
      store.mode = 'deposed';
      const ticket = save(ws, 'a.json', { a: 1 });
      await vi.advanceTimersByTimeAsync(600);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ws.stateOf(GUILD)).toBeNull();
      return [await answer(ws.confirm(ticket, 1000), 1000)];
    },
  },
  {
    row: 'replaced: evicted and read again, even once the new set commits the same document',
    expected: ['unavailable', 'unavailable'],
    run: async () => {
      const { ws } = await servedSet();
      const old = save(ws, 'a.json', { a: 1 });
      ws.evict(GUILD);
      expect(await ws.hydrate(GUILD, tokenFor())).toBe('ready');
      const before = await answer(ws.confirm(old, 1000), 1000);
      expect(await answer(ws.confirm(save(ws, 'a.json', { a: 2 }), 1000), 1000)).toBe('ok');
      return [before, await answer(ws.confirm(old, 1000), 1000)];
    },
  },
  {
    // The table says unavailable; deposed, as for the fenced drain above.
    row: 'replaced: a fenced set evicted and a new one read',
    expected: ['deposed'],
    run: async () => {
      const { store, ws } = await servedSet();
      store.mode = 'deposed';
      const ticket = save(ws, 'a.json', { a: 1 });
      await vi.advanceTimersByTimeAsync(600);
      store.mode = 'commit';
      expect(await ws.hydrate(GUILD, tokenFor())).toBe('ready');
      return [await answer(ws.confirm(ticket, 1000), 1000)];
    },
  },
  {
    // boot.ts quiesces in the same run as the export; the set's exported mark
    // keeps the rule without it (the next row).
    row: 'exported off its set at a recycle, asked before the quiesce',
    expected: ['unavailable'],
    run: async () => {
      const { ws } = await servedSet();
      const ticket = save(ws, 'a.json', { a: 1 });
      expect(ws.exportDirty([GUILD])).toHaveLength(1);
      return [await answer(ws.confirm(ticket, 1000), 1000)];
    },
  },
  {
    row: 'exported off its set at a recycle, and a later write on the unquiesced set commits; a write landed before the export stays ok',
    expected: ['ok', 'unavailable'],
    run: async () => {
      const { store, ws } = await servedSet();
      const landed = save(ws, 'c.json', { c: 1 });
      expect(await answer(ws.confirm(landed, 1000), 1000)).toBe('ok');
      const exported = save(ws, 'a.json', { a: 1 });
      expect(ws.exportDirty([GUILD])).toHaveLength(1);
      save(ws, 'b.json', { b: 1 });
      await vi.advanceTimersByTimeAsync(600);
      expect(store.doc(GUILD, 'b.json')).toBe(JSON.stringify({ b: 1 }));
      expect(store.doc(GUILD, 'a.json')).toBeUndefined();
      return [await answer(ws.confirm(landed, 1000), 1000), await answer(ws.confirm(exported, 1000), 1000)];
    },
  },
  {
    row: 'exported off its set at a recycle, asked while a later write\'s flush on the unquiesced set stays on the wire',
    expected: ['unavailable'],
    run: async () => {
      const { store, ws } = await servedSet();
      const exported = save(ws, 'a.json', { a: 1 });
      expect(ws.exportDirty([GUILD])).toHaveLength(1);
      store.holding = true;
      const sent = store.flushesSent;
      save(ws, 'b.json', { b: 1 });
      await vi.advanceTimersByTimeAsync(600);
      expect(store.flushesSent).toBe(sent + 1);
      const outcome = await answer(ws.confirm(exported, 100), 100);
      store.holding = false;
      store.release();
      return [outcome];
    },
  },
  {
    row: 'recycled: the manager answers unavailable; the facade says pending while the successor keeps the carry, and unavailable once it landed',
    expected: ['unavailable', 'pending', 'unavailable'],
    run: async () => {
      const guildId = '9100';
      setRouteOverride(guildId, 'postgres');
      const before = new FakeStore();
      before.mode = 'unavailable';
      const old = initWorkingSet(before);
      expect(await old.hydrate(guildId, tokenFor())).toBe('ready');
      const saved = saveDataTracked('a.json', { guildId, category: 'm' }, { a: 1 });
      if (saved.outcome !== 'saved') throw new Error(`the write was not accepted: ${saved.outcome}`);
      const ticket = saved.ticket;
      if (ticket.kind !== 'ws') throw new Error('a postgres-routed write took a file ticket');
      const carry = old.exportDirty([guildId]);
      old.quiesce();
      const after = new FakeStore();
      after.mode = 'unavailable';
      const successor = initWorkingSet(after);
      expect(await successor.hydrate(guildId, tokenFor())).toBe('ready');
      successor.adoptDirty(carry);
      const own = await answer(old.confirm(ticket, 100), 100);
      const carried = await answer(confirmWrite(ticket, 100), 100);
      after.mode = 'commit';
      expect(await answer(successor.flushGuildNow(guildId, 1000), 1000)).toBe('ok');
      return [own, carried, await answer(confirmWrite(ticket, 100), 100)];
    },
  },
  {
    row: 'the lease left, and the unload flush under the old fence commits',
    expected: ['ok'],
    run: async () => {
      const { store, ws } = await servedSet();
      const ticket = save(ws, 'a.json', { a: 1 });
      await ws.unloadToFrozenRetained(GUILD);
      expect(ws.stateOf(GUILD)).toBe('frozen-retained');
      expect(store.doc(GUILD, 'a.json')).toBe(JSON.stringify({ a: 1 }));
      return [await answer(ws.confirm(ticket, 0), 0)];
    },
  },
  {
    row: 'the lease left, and the store refuses the unload flush',
    expected: ['held'],
    run: async () => {
      const { store, ws } = await servedSet();
      store.mode = 'unavailable';
      const ticket = save(ws, 'a.json', { a: 1 });
      await ws.unloadToFrozenRetained(GUILD);
      expect(ws.stateOf(GUILD)).toBe('frozen-retained');
      return [await answer(ws.confirm(ticket, 1000), 1000)];
    },
  },
  {
    row: 'the lease left, and a newer owner claimed the guild',
    expected: ['deposed'],
    run: async () => {
      const { store, ws } = await servedSet();
      store.mode = 'deposed';
      const ticket = save(ws, 'a.json', { a: 1 });
      await ws.unloadToFrozenRetained(GUILD);
      return [await answer(ws.confirm(ticket, 1000), 1000)];
    },
  },
];

describe('working-set tickets, the state x exit table', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it.each(workingSetRows)('$row', async ({ expected, run }) => {
    expect(await run()).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// The file queue, on the real filesystem under the test's DATA_DIR
// ---------------------------------------------------------------------------

let places = 0;
const freshPath = (name: string) => path.join(process.env.DATA_DIR!, 'tickets', String(++places), name);

const fileRows: Row[] = [
  {
    row: 'file: the op lands',
    expected: ['ok'],
    run: async () => {
      const file = freshPath('lands.json');
      enqueueWrite(file, '{"a":1}');
      const outcome = await confirmFile(fileTicket(file), 5000);
      expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
      return [outcome];
    },
  },
  {
    row: 'file: a later op to the same path lands',
    expected: ['ok', 'ok', 'ok'],
    run: async () => {
      const file = freshPath('later.json');
      enqueueWrite(file, '{"v":1}');
      const first = fileTicket(file);
      enqueueWrite(file, '{"v":2}');
      const second = fileTicket(file);
      const outcomes = [await confirmFile(second, 5000), await confirmFile(first, 0)];
      expect(fs.readFileSync(file, 'utf8')).toBe('{"v":2}');
      enqueueDelete(file);
      outcomes.push(await confirmFile(fileTicket(file), 5000));
      expect(fs.existsSync(file)).toBe(false);
      return outcomes;
    },
  },
  {
    row: 'file: the flush fails on a directory where the file should be, and the entry stays queued',
    expected: ['held', 'ok'],
    run: async () => {
      const file = freshPath('blocked.json');
      fs.mkdirSync(file, { recursive: true });
      enqueueWrite(file, '{"a":1}');
      const ticket = fileTicket(file);
      const refused = await confirmFile(ticket, 10_000);
      expect(filesPending([file])).toBe(true);
      fs.rmSync(file, { recursive: true });
      const healed = await confirmFile(ticket, 10_000);
      expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
      return [refused, healed];
    },
  },
  {
    row: 'file: the flush fails on a file where its directory should be, and the entry stays queued',
    expected: ['held', 'ok'],
    run: async () => {
      const parent = freshPath('not-a-directory');
      fs.mkdirSync(path.dirname(parent), { recursive: true });
      fs.writeFileSync(parent, 'a file');
      const file = path.join(parent, 'inner.json');
      enqueueWrite(file, '{"a":1}');
      const ticket = fileTicket(file);
      const refused = await confirmFile(ticket, 10_000);
      expect(filesPending([file])).toBe(true);
      fs.rmSync(parent);
      const healed = await confirmFile(ticket, 10_000);
      expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
      return [refused, healed];
    },
  },
  {
    row: 'file: the deadline passes first',
    expected: ['pending', 'ok'],
    run: async () => {
      const file = freshPath('deadline.json');
      enqueueWrite(file, '{"a":1}');
      const ticket = fileTicket(file);
      return [await confirmFile(ticket, 0), await confirmFile(ticket, 5000)];
    },
  },
  {
    row: 'file: the deadline passes with its own flush still on the wire, and the entry stays queued',
    expected: ['pending', 'ok'],
    run: async () => {
      const file = freshPath('on-the-wire.json');
      const mkdir = fs.promises.mkdir;
      let open: () => void = () => undefined;
      const gate = new Promise<void>(resolve => { open = resolve; });
      const making = vi.spyOn(fs.promises, 'mkdir').mockImplementation(async (...args: Parameters<typeof mkdir>) => {
        await gate;
        return mkdir(...args);
      });
      try {
        enqueueWrite(file, '{"a":1}');
        const ticket = fileTicket(file);
        const atTheDeadline = await confirmFile(ticket, 50);
        expect(making).toHaveBeenCalledTimes(1);
        expect(filesPending([file])).toBe(true);
        open();
        const landed = await confirmFile(ticket, 5000);
        expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
        return [atTheDeadline, landed];
      } finally {
        open();
      }
    },
  },
];

describe('file-queue tickets, the state x exit table', () => {
  it.each(fileRows)('$row', async ({ expected, run }) => {
    expect(await run()).toEqual(expected);
  }, 30_000);

  it('confirms an append that joined one already being written only once its own line lands', async () => {
    const file = freshPath('joined-on-the-wire.jsonl');
    const appendFile = fs.promises.appendFile;
    let open: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const writing = vi.spyOn(fs.promises, 'appendFile').mockImplementation(async (...args: Parameters<typeof appendFile>) => {
      await gate;
      return appendFile(...args);
    });
    enqueueAppend(file, 'a;');
    const first = confirmFile(fileTicket(file), 5000);
    for (let turns = 0; turns < 400 && writing.mock.calls.length === 0; turns++) await new Promise(resolve => { setTimeout(resolve, 5); });
    expect(writing).toHaveBeenCalledTimes(1);
    enqueueAppend(file, 'b;');
    const second = fileTicket(file);
    open();
    expect(await first).toBe('ok');
    expect(await confirmFile(second, 0)).toBe('pending');
    expect(fs.readFileSync(file, 'utf8')).toBe('a;');
    expect(await confirmFile(second, 5000)).toBe('ok');
    expect(fs.readFileSync(file, 'utf8')).toBe('a;b;');
  });

  it('keeps a queued write or delete that an append follows, as one whole-file write', async () => {
    const file = freshPath('joined.jsonl');
    enqueueWrite(file, 'w;');
    const written = fileTicket(file);
    enqueueAppend(file, 'a;');
    const appended = fileTicket(file);
    expect(await confirmFile(appended, 5000)).toBe('ok');
    expect(await confirmFile(written, 0)).toBe('ok');
    expect(fs.readFileSync(file, 'utf8')).toBe('w;a;');
    enqueueDelete(file);
    const deleted = fileTicket(file);
    enqueueAppend(file, 'b;');
    expect(await confirmFile(fileTicket(file), 5000)).toBe('ok');
    expect(await confirmFile(deleted, 0)).toBe('ok');
    expect(fs.readFileSync(file, 'utf8')).toBe('b;');
  });

  it('flushes an op that replaced an append while that append was on the wire, untrimmed and unprompted', async () => {
    const replaced = freshPath('replaced.jsonl');
    enqueueAppend(replaced, 'a;');
    const onTheWire = confirmFile(fileTicket(replaced), 5000);
    enqueueWrite(replaced, 'w;');
    expect(await onTheWire).toBe('ok');
    for (let turns = 0; turns < 200 && filesPending([replaced]); turns++) await new Promise(resolve => { setTimeout(resolve, 10); });
    expect(filesPending([replaced])).toBe(false);
    expect(fs.readFileSync(replaced, 'utf8')).toBe('w;');

    const guildId = '9301';
    const dropped = path.join(process.env.DATA_DIR!, guildId, 'm', 'dropped.jsonl');
    enqueueAppend(dropped, 'a;');
    const flushing = confirmFile(fileTicket(dropped), 5000);
    dropPendingForGuild(guildId);
    enqueueAppend(dropped, 'bb;');
    const after = fileTicket(dropped);
    expect(await flushing).toBe('ok');
    expect(await confirmFile(after, 5000)).toBe('ok');
    expect(fs.readFileSync(dropped, 'utf8')).toBe('a;bb;');
  });

  it('answers unavailable for an op dropped from the queue without landing', async () => {
    const guildId = '9300';
    const file = path.join(process.env.DATA_DIR!, guildId, 'm', 'dropped.json');
    enqueueWrite(file, '{"a":1}');
    const ticket = fileTicket(file);
    dropPendingForGuild(guildId);
    expect(await confirmFile(ticket, 1000)).toBe('unavailable');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('answers unavailable for an op dropped from the queue without landing, with no time left to wait', async () => {
    const guildId = '9302';
    const file = path.join(process.env.DATA_DIR!, guildId, 'm', 'dropped.json');
    enqueueWrite(file, '{"a":1}');
    const ticket = fileTicket(file);
    dropPendingForGuild(guildId);
    expect(await confirmFile(ticket, 0)).toBe('unavailable');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('answers unavailable for an op dropped from the queue whose path is then written again and lands', async () => {
    const guildId = '9303';
    const file = path.join(process.env.DATA_DIR!, guildId, 'm', 'again.json');
    enqueueWrite(file, '{"v":1}');
    const dropped = fileTicket(file);
    dropPendingForGuild(guildId);
    enqueueWrite(file, '{"v":2}');
    expect(await confirmFile(fileTicket(file), 5000)).toBe('ok');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"v":2}');
    expect(await confirmFile(dropped, 1000)).toBe('unavailable');
  });

  it('answers unavailable, never held, for an op dropped from the queue whose path is written again and fails', async () => {
    const guildId = '9305';
    const file = path.join(process.env.DATA_DIR!, guildId, 'm', 'again-failing.json');
    enqueueWrite(file, '{"v":1}');
    const dropped = fileTicket(file);
    dropPendingForGuild(guildId);
    failTmpOpens(file, Number.POSITIVE_INFINITY);
    enqueueWrite(file, '{"v":2}');
    expect(await confirmFile(dropped, 5000)).toBe('unavailable');
    dropPendingForGuild(guildId);
  });

  it('answers unavailable for an op dropped from the queue during its own failing attempt', async () => {
    const guildId = '9306';
    const file = path.join(process.env.DATA_DIR!, guildId, 'm', 'drop-mid-attempt.json');
    failTmpOpens(file, Number.POSITIVE_INFINITY, n => { if (n === 1) dropPendingForGuild(guildId); });
    enqueueWrite(file, '{"v":1}');
    expect(await confirmFile(fileTicket(file), 5000)).toBe('unavailable');
    dropPendingForGuild(guildId);
  });

  it('counts a newer op arriving during a failed attempt as progress, so its count of attempts starts again', async () => {
    const file = freshPath('progress.json');
    const opens = failTmpOpens(file, 4, n => { if (n === 2) enqueueWrite(file, '{"v":2}'); });
    enqueueWrite(file, '{"v":1}');
    expect(await confirmFile(fileTicket(file), 5000)).toBe('ok');
    expect(opens.calls()).toBe(5);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"v":2}');
  });

  it('drops the landing record of every path dropped from the queue', () => {
    const guildId = '9304';
    const file = path.join(process.env.DATA_DIR!, guildId, 'm', 'record.json');
    enqueueWrite(file, '{"v":1}');
    fileTicket(file);
    const kept = fileLandingRecords();
    dropPendingForGuild(guildId);
    expect(fileLandingRecords()).toBe(kept - 1);
  });

  it('drops a ticketed path\'s landing record once its op lands, and the ticket still answers ok', async () => {
    const written = freshPath('retired.json');
    enqueueWrite(written, '{"a":1}');
    const writeTicket = fileTicket(written);
    const appended = freshPath('retired.jsonl');
    enqueueAppend(appended, 'a;');
    const appendTicket = fileTicket(appended);
    const kept = fileLandingRecords();
    expect(await confirmFile(writeTicket, 5000)).toBe('ok');
    expect(await confirmFile(appendTicket, 5000)).toBe('ok');
    expect(fileLandingRecords()).toBeLessThanOrEqual(kept - 2);
    expect(await confirmFile(writeTicket, 0)).toBe('ok');
    expect(await confirmFile(appendTicket, 0)).toBe('ok');
  });

  it('keeps no landing record for a path no ticket was issued for', async () => {
    const before = fileLandingRecords();
    const dir = path.join(process.env.DATA_DIR!, 'sessions', String(++places));
    fs.mkdirSync(dir, { recursive: true });
    const paths = Array.from({ length: 2000 }, (_, i) => path.join(dir, `sid${String(i).padStart(29, '0')}.json`));
    for (const file of paths) expect(writeRawAtomic(file, '{}')).toBe(true);
    await flushAll();
    for (const file of paths) expect(deleteRawAtomic(file)).toBe(true);
    await flushAll();
    expect(fs.readdirSync(dir)).toHaveLength(0);
    expect(fileLandingRecords()).toBeLessThanOrEqual(before);
  }, 120_000);
});

type FileOp =
  | { op: 'write' | 'append'; file: number; value: number }
  | { op: 'delete'; file: number }
  | { op: 'turn' }
  | { op: 'confirm'; pick: number; deadline: number };

const fileOp: fc.Arbitrary<FileOp> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ op: fc.constantFrom('write' as const, 'append' as const), file: fc.integer({ min: 0, max: 2 }), value: fc.nat(999) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('delete' as const), file: fc.integer({ min: 0, max: 2 }) }) },
  { weight: 2, arbitrary: fc.constant<FileOp>({ op: 'turn' }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('confirm' as const), pick: fc.nat(), deadline: fc.constantFrom(0, 5000) }) },
);

let fileRuns = 0;

// On Windows a file whose unlink is still under way refuses to open (EPERM) until the unlink completes, so a read made
// while a queued delete is on the wire waits for it (the facade's readers consult the queue and never meet this).
async function onDisk(file: string): Promise<string | null> {
  for (let tries = 0; ; tries++) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      if (code !== 'EPERM' || tries >= 50) throw error;
    }
    await new Promise<void>(resolve => { setTimeout(resolve, 20); });
  }
}

async function runFileQueue(ops: FileOp[]): Promise<void> {
  const dir = path.join(process.env.DATA_DIR!, 'file-queue', String(++fileRuns));
  // Per file, its content after each queued op (index 0: before any).
  const states = new Map<string, (string | null)[]>();
  const issued: { file: string; at: number; ticket: FileTicket }[] = [];
  const queued = (file: string, state: string | null) => {
    const list = states.get(file) ?? [null];
    list.push(state);
    states.set(file, list);
    issued.push({ file, at: list.length - 1, ticket: fileTicket(file) });
  };
  for (const step of ops) {
    if (step.op === 'turn') {
      await new Promise<void>(resolve => { setImmediate(resolve); });
      continue;
    }
    if (step.op === 'confirm') {
      if (issued.length === 0) continue;
      const { file, at, ticket } = issued[step.pick % issued.length];
      const outcome = await confirmFile(ticket, step.deadline);
      // A healthy disk confirms within the deadline; ok means the file holds this op or a later one.
      if (step.deadline > 0) expect(outcome).toBe('ok');
      if (outcome === 'ok') expect(states.get(file)!.slice(at)).toContain(await onDisk(file));
      continue;
    }
    const file = path.join(dir, `f${step.file}.txt`);
    const before = (states.get(file) ?? [null]).at(-1) ?? null;
    if (step.op === 'write') {
      enqueueWrite(file, `w${step.value};`);
      queued(file, `w${step.value};`);
    } else if (step.op === 'append') {
      enqueueAppend(file, `a${step.value};`);
      queued(file, `${before ?? ''}a${step.value};`);
    } else {
      enqueueDelete(file);
      queued(file, null);
    }
  }
  for (const { ticket } of issued) expect(await confirmFile(ticket, 5000)).toBe('ok');
  for (const [file, list] of states) expect(await onDisk(file)).toBe(list.at(-1));
}

describe('file-queue tickets, generated sequences', () => {
  it('answers ok only once the file holds the op or a later one, and always on a healthy disk', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fileOp, { minLength: 1, maxLength: 25 }), runFileQueue), { numRuns: 100 });
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The facade and the operator route
// ---------------------------------------------------------------------------

describe('the facade keeps its answers, and issues a ticket for each accepted write', () => {
  it('answers file-mode writes as before, each with a ticket that confirms', async () => {
    const options = { guildId: '9400', category: 'm' };
    const saved = saveDataTracked('a.json', options, { a: 1 });
    if (saved.outcome !== 'saved') throw new Error(`the write was not accepted: ${saved.outcome}`);
    expect(await confirmWrite(saved.ticket, 5000)).toBe('ok');
    expect(saveDataOutcome('a.json', options, { a: 2 })).toBe('saved');
    expect(saveData('a.json', options, { a: 3 })).toBe(true);
    const appended = appendDataTracked('log.jsonl', options, 'one\n');
    if (appended.outcome !== 'appended') throw new Error(`the append was not accepted: ${appended.outcome}`);
    expect(await confirmWrite(appended.ticket, 5000)).toBe('ok');
    expect(appendData('log.jsonl', options, 'two\n')).toBe(true);
    const deleted = deleteDataTracked('a.json', options);
    if (deleted.outcome !== 'deleted') throw new Error(`the delete was not accepted: ${deleted.outcome}`);
    expect(await confirmWrite(deleted.ticket, 5000)).toBe('ok');
    expect(deleteDataTracked('a.json', options).outcome).toBe('absent');
    expect(deleteDataOutcome('a.json', options)).toBe('absent');
    expect(deleteData('a.json', options)).toBe(false);
  });

  it('answers a frozen guild as before, with no ticket', () => {
    const options = { guildId: '9401', category: 'm' };
    freezeGuildWrites('9401');
    try {
      expect(saveDataTracked('a.json', options, { a: 1 })).toEqual({ outcome: 'frozen' });
      expect(saveDataOutcome('a.json', options, { a: 1 })).toBe('frozen');
      expect(saveData('a.json', options, { a: 1 })).toBe(false);
      expect(appendDataTracked('log.jsonl', options, 'x\n')).toEqual({ outcome: 'frozen' });
      expect(appendData('log.jsonl', options, 'x\n')).toBe(false);
      expect(deleteDataTracked('a.json', options)).toEqual({ outcome: 'frozen' });
      expect(deleteDataOutcome('a.json', options)).toBe('frozen');
      expect(deleteData('a.json', options)).toBe(false);
    } finally {
      unfreezeGuildWrites('9401');
    }
  });

  it('answers a postgres-routed guild whose set is not ready as refused, naming why', () => {
    const guildId = '9402';
    setRouteOverride(guildId, 'postgres');
    initWorkingSet(new FakeStore());
    const options = { guildId, category: 'm' };
    expect(saveDataTracked('a.json', options, { a: 1 })).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(saveDataOutcome('a.json', options, { a: 1 })).toBe('refused');
    expect(appendDataTracked('log.jsonl', options, 'x\n')).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(appendData('log.jsonl', options, 'x\n')).toBe(false);
    expect(deleteDataTracked('a.json', options)).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(deleteDataOutcome('a.json', options)).toBe('refused');
  });

  it('still throws for a fenced guild', async () => {
    vi.useFakeTimers();
    const guildId = '9403';
    setRouteOverride(guildId, 'postgres');
    const store = new FakeStore();
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    store.mode = 'deposed';
    expect(saveDataTracked('a.json', { guildId, category: 'm' }, { a: 1 }).outcome).toBe('saved');
    await vi.advanceTimersByTimeAsync(600);
    for (const write of [
      () => saveDataTracked('a.json', { guildId, category: 'm' }, { a: 2 }),
      () => saveDataOutcome('a.json', { guildId, category: 'm' }, { a: 2 }),
      () => appendDataTracked('log.jsonl', { guildId, category: 'm' }, 'x\n'),
      () => appendData('log.jsonl', { guildId, category: 'm' }, 'x\n'),
      () => deleteDataTracked('a.json', { guildId, category: 'm' }),
      () => deleteDataOutcome('a.json', { guildId, category: 'm' }),
    ]) {
      expect(write).toThrow(DataBackendUnavailableError);
    }
  });

  it('answers a delete that finds an earlier delete of the document not landed as absent, with a ticket for that delete', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const guildId = '9404';
    setRouteOverride(guildId, 'postgres');
    const store = new FakeStore();
    store.docs.set(`${guildId}|m/x.json`, '{"x":1}');
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    const options = { guildId, category: 'm' };
    const findsItUnlanded = (state: string) => {
      expect(deleteDataOutcome('x.json', options), state).toBe('absent');
      expect(deleteData('x.json', options), state).toBe(false);
      const tracked = deleteDataTracked('x.json', options);
      expect(tracked.outcome, state).toBe('absent');
      expect(tracked.outcome === 'absent' ? tracked.ticket?.kind : undefined, state).toBe('ws');
    };
    expect(deleteData('x.json', options)).toBe(true);
    findsItUnlanded('dirty, in the debounce window');
    store.holding = true;
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    findsItUnlanded('on the wire');
    store.mode = 'unavailable';
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(0);
    findsItUnlanded('refused by the store, kept for the retry');
    store.mode = 'commit';
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.doc(guildId, 'x.json')).toBeUndefined();
    expect(deleteDataTracked('x.json', options)).toEqual({ outcome: 'absent' });
  });

  it('answers a file-mode delete that finds an earlier delete still queued as absent, with a ticket for that delete', async () => {
    const guildId = '9405';
    setRouteOverride(guildId, 'file');
    const options = { guildId, category: 'm' };
    const file = path.join(process.env.DATA_DIR!, guildId, 'm', 'x.json');
    const rename = holdFs('rename', file);
    expect(saveData('x.json', options, { w: 1 })).toBe(true);
    await rename.reached;
    expect(deleteData('x.json', options)).toBe(true);
    expect(deleteDataOutcome('x.json', options)).toBe('absent');
    expect(deleteData('x.json', options)).toBe(false);
    const tracked = deleteDataTracked('x.json', options);
    rename.open();
    if (tracked.outcome !== 'absent' || !tracked.ticket) throw new Error(`the queued delete took no ticket: ${JSON.stringify(tracked)}`);
    expect(await confirmWrite(tracked.ticket, 5000)).toBe('ok');
    expect(fs.existsSync(file)).toBe(false);
    expect(deleteDataTracked('x.json', options)).toEqual({ outcome: 'absent' });
  });
});

describe('a write that landed is confirmed while a second writer keeps its guild dirty', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('through the facade, while the second writer\'s flush stays on the wire', async () => {
    const guildId = '9200';
    setRouteOverride(guildId, 'postgres');
    const store = new FakeStore();
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    const options = { guildId, category: 'm' };
    const first = saveDataTracked('a.json', options, { a: 1 });
    if (first.outcome !== 'saved') throw new Error(`the write was not accepted: ${first.outcome}`);
    store.holding = true;
    await vi.advanceTimersByTimeAsync(600);
    expect(saveDataTracked('b.json', options, { b: 1 }).outcome).toBe('saved');
    store.release();
    await vi.advanceTimersByTimeAsync(600);
    expect(store.doc(guildId, 'a.json')).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(ws.writesSettled()).toBe(false);
    expect(await answer(confirmWrite(first.ticket, 8000), 8000)).toBe('ok');
    // The guild-wide answer waits on the second writer's flush instead.
    expect(await answer(flushGuildOutcome(guildId, 100), 100)).toBe('pending');
    store.holding = false;
    store.release();
  });

  it('through the operator route, while the second writer writes on through its flush', async () => {
    const guildId = '9201';
    setRouteOverride(guildId, 'postgres');
    const store = new FakeStore();
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    const options = { guildId, category: 'm' };
    expect(saveDataTracked('b.json', options, { b: 1 }).outcome).toBe('saved');
    store.holding = true;
    await vi.advanceTimersByTimeAsync(600);
    const reply = applyOperatorDataWrite({ guildId, module: 'm', filename: 'a.json', op: 'write', contentJson: '{"a":1}' });
    await vi.advanceTimersByTimeAsync(0);
    expect(saveDataTracked('c.json', options, { c: 1 }).outcome).toBe('saved');
    store.release();
    await vi.advanceTimersByTimeAsync(40);
    expect(saveDataTracked('d.json', options, { d: 1 }).outcome).toBe('saved');
    store.holding = false;
    store.release();
    expect(await answer(reply, 8000)).toEqual({ ok: true });
    expect(store.doc(guildId, 'a.json')).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(ws.writesSettled()).toBe(false);
  });

  it('answers a delete of a document that never existed on the operator route at once, whatever the guild has on the wire', async () => {
    const guildId = '9202';
    setRouteOverride(guildId, 'postgres');
    const store = new FakeStore();
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    expect(saveDataTracked('b.json', { guildId, category: 'm' }, { b: 1 }).outcome).toBe('saved');
    store.holding = true;
    await vi.advanceTimersByTimeAsync(600);
    const reply = applyOperatorDataWrite({ guildId, module: 'm', filename: 'none.json', op: 'delete' });
    expect(await answer(reply, 0)).toEqual({ ok: true });
    store.holding = false;
    store.release();
  });

  it('through the operator route in file mode, while another file of the guild fails its flush', async () => {
    vi.useRealTimers();
    const guildId = '9203';
    setRouteOverride(guildId, 'file');
    const blocked = path.join(process.env.DATA_DIR!, guildId, 'm', 'blocked.json');
    fs.mkdirSync(blocked, { recursive: true });
    enqueueWrite(blocked, '{"b":1}');
    const held = fileTicket(blocked);
    const reply = await applyOperatorDataWrite({ guildId, module: 'm', filename: 'a.json', op: 'write', contentJson: '{"a":1}' });
    expect(reply).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(process.env.DATA_DIR!, guildId, 'm', 'a.json'), 'utf8')).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(filesPending([blocked])).toBe(true);
    fs.rmSync(blocked, { recursive: true });
    expect(await confirmFile(held, 10_000)).toBe('ok');
  });
});

describe('the operator route answers through the real confirmWrite', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  async function routedGuild(guildId: string): Promise<{ store: FakeStore; ws: WorkingSetManager }> {
    setRouteOverride(guildId, 'postgres');
    const store = new FakeStore();
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    return { store, ws };
  }

  const write = (guildId: string) => ({ guildId, module: 'm', filename: 'a.json', op: 'write' as const, contentJson: '{"a":1}' });

  it('held: the store refuses the commit, and the write is kept and retried', async () => {
    const { store } = await routedGuild('9600');
    store.mode = 'unavailable';
    expect(await answer(applyOperatorDataWrite(write('9600')), 8000)).toEqual(HELD);
    expect(store.doc('9600', 'a.json')).toBeUndefined();
  });

  it('deposed: a newer owner fenced the guild', async () => {
    const { store } = await routedGuild('9601');
    store.mode = 'deposed';
    expect(await answer(applyOperatorDataWrite(write('9601')), 8000)).toEqual({ ok: false, code: 'not-owner', error: 'guild ownership moved mid-write' });
  });

  it('pending: the deadline passes with its flush still on the wire', async () => {
    const { store } = await routedGuild('9602');
    store.holding = true;
    expect(await answer(applyOperatorDataWrite(write('9602')), 8000)).toEqual({ ok: true, pending: true });
    store.holding = false;
    store.release();
  });

  it('unavailable: the guild is unloaded while its forced flush is on the wire, which then commits', async () => {
    const { store, ws } = await routedGuild('9603');
    store.holding = true;
    const reply = applyOperatorDataWrite(write('9603'));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.flushesSent).toBe(1);
    ws.evict('9603');
    store.holding = false;
    store.release();
    expect(await answer(reply, 8000)).toEqual(LEFT_UNCONFIRMED);
  });

  it('unavailable in file mode: its op is dropped from the queue while an earlier op of the path is on the wire', async () => {
    vi.useRealTimers();
    const guildId = '9604';
    setRouteOverride(guildId, 'file');
    const file = path.join(process.env.DATA_DIR!, guildId, 'm', 'a.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rename = holdFs('rename', file);
    enqueueWrite(file, '{"first":1}');
    await rename.reached;
    const reply = applyOperatorDataWrite(write(guildId));
    await new Promise(resolve => { setTimeout(resolve, 30); });
    dropPendingForGuild(guildId);
    rename.open();
    expect(await reply).toEqual(LEFT_UNCONFIRMED);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"first":1}');
  });

  it('file mode: a fault that clears after one failed attempt is tried again in line and answers ok', async () => {
    vi.useRealTimers();
    const guildId = '9605';
    setRouteOverride(guildId, 'file');
    const file = path.join(process.env.DATA_DIR!, guildId, 'm', 'a.json');
    const renames = failRenames(file, 10);
    expect(await applyOperatorDataWrite(write(guildId))).toEqual({ ok: true });
    expect(renames.calls()).toBe(11);
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('file mode: a fault that never clears answers held after three attempts', async () => {
    vi.useRealTimers();
    const guildId = '9606';
    setRouteOverride(guildId, 'file');
    const file = path.join(process.env.DATA_DIR!, guildId, 'm', 'a.json');
    const renames = failRenames(file, Infinity);
    expect(await applyOperatorDataWrite(write(guildId))).toEqual(HELD);
    // Each attempt tries the rename ten times.
    expect(renames.calls()).toBe(30);
    expect(fs.existsSync(file)).toBe(false);
    renames.heal();
    expect(await confirmFile(fileTicket(file), 10_000)).toBe('ok');
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify({ a: 1 }, null, 2));
  });
});

describe('the operator route confirms a delete that finds an earlier delete of the document not landed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  async function guildHolding(guildId: string): Promise<FakeStore> {
    setRouteOverride(guildId, 'postgres');
    const store = new FakeStore();
    store.docs.set(`${guildId}|m/x.json`, '{"x":1}');
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    return store;
  }

  const remove = (guildId: string, filename = 'x.json') => ({ guildId, module: 'm', filename, op: 'delete' as const });

  it('a repeat delete while the first is held by an unreachable store answers held, and ok once the delete lands', async () => {
    const guildId = '9500';
    const store = await guildHolding(guildId);
    store.mode = 'unavailable';
    expect(await answer(applyOperatorDataWrite(remove(guildId)), 8000)).toEqual(HELD);
    expect(await answer(applyOperatorDataWrite(remove(guildId)), 8000)).toEqual(HELD);
    expect(store.doc(guildId, 'x.json')).toBe('{"x":1}');
    store.mode = 'commit';
    expect(await answer(applyOperatorDataWrite(remove(guildId)), 8000)).toEqual({ ok: true });
    expect(store.doc(guildId, 'x.json')).toBeUndefined();
  });

  it('a delete inside a module delete\'s debounce window answers only once the store dropped the document', async () => {
    const guildId = '9501';
    const store = await guildHolding(guildId);
    expect(deleteData('x.json', { guildId, category: 'm' })).toBe(true);
    const reply = applyOperatorDataWrite(remove(guildId));
    let storeHeldIt: boolean | undefined;
    void reply.then(() => { storeHeldIt = store.docs.has(`${guildId}|m/x.json`); });
    expect(await answer(reply, 8000)).toEqual({ ok: true });
    expect(storeHeldIt).toBe(false);
  });

  it('a delete while a module delete\'s flush is on the wire, which the store then refuses, answers held', async () => {
    const guildId = '9502';
    const store = await guildHolding(guildId);
    store.holding = true;
    expect(deleteData('x.json', { guildId, category: 'm' })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    const reply = applyOperatorDataWrite(remove(guildId));
    await vi.advanceTimersByTimeAsync(0);
    store.mode = 'unavailable';
    store.holding = false;
    store.release();
    expect(await answer(reply, 8000)).toEqual(HELD);
    expect(store.doc(guildId, 'x.json')).toBe('{"x":1}');
  });

  it('file mode: a delete queued behind a write on the wire, which the disk then refuses, answers held', async () => {
    vi.useRealTimers();
    const guildId = '9503';
    setRouteOverride(guildId, 'file');
    const file = path.join(process.env.DATA_DIR!, guildId, 'm', 'x.json');
    const rename = holdFs('rename', file);
    const unlink = failUnlinks(file);
    expect(saveData('x.json', { guildId, category: 'm' }, { w: 1 })).toBe(true);
    await rename.reached;
    expect(fs.existsSync(file)).toBe(false);
    expect(deleteData('x.json', { guildId, category: 'm' })).toBe(true);
    const reply = applyOperatorDataWrite(remove(guildId));
    rename.open();
    expect(await reply).toEqual(HELD);
    expect(fs.existsSync(file)).toBe(true);
    unlink.heal();
    expect(await applyOperatorDataWrite(remove(guildId))).toEqual({ ok: true });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('file mode: a delete queued behind an append on the wire that creates the file, which the disk then refuses, answers held', async () => {
    vi.useRealTimers();
    const guildId = '9504';
    setRouteOverride(guildId, 'file');
    const file = path.join(process.env.DATA_DIR!, guildId, 'm', 'x.jsonl');
    const appending = holdFs('appendFile', file);
    const unlink = failUnlinks(file);
    expect(appendData('x.jsonl', { guildId, category: 'm' }, 'a;')).toBe(true);
    await appending.reached;
    expect(fs.existsSync(file)).toBe(false);
    expect(deleteData('x.jsonl', { guildId, category: 'm' })).toBe(true);
    const reply = applyOperatorDataWrite(remove(guildId, 'x.jsonl'));
    appending.open();
    expect(await reply).toEqual(HELD);
    expect(fs.readFileSync(file, 'utf8')).toBe('a;');
    unlink.heal();
    expect(await applyOperatorDataWrite(remove(guildId, 'x.jsonl'))).toEqual({ ok: true });
    expect(fs.existsSync(file)).toBe(false);
  });
});
