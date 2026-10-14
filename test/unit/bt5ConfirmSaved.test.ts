import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dropPendingForGuild } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { noteScopeRefusal, noteScopeTicket, pendingFor, setLeft } from '../../src/bot/internalSetup/utils/dataBackends/scopeRecord';
import { setRouteOverride } from '../../src/bot/internalSetup/utils/dataBackends/routeResolver';
import {
  DataBackendUnavailableError,
  getWorkingSet,
  initWorkingSet,
  WorkingSetManager,
  type DirtyCarry,
} from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import {
  appendData,
  appendDataTracked,
  confirmSaved,
  confirmWrite,
  deleteData,
  deleteDataTracked,
  deleteGlobalModuleData,
  deleteModuleData,
  deleteRawAtomic,
  flushGuildOutcome,
  freezeGuildWrites,
  saveData,
  saveDataTracked,
  saveGlobalData,
  saveGlobalModuleData,
  saveGuildData,
  saveMark,
  saveModuleData,
  unfreezeGuildWrites,
  writeRawAtomic,
  type SaveMark,
  type WriteTicket,
} from '../../src/bot/internalSetup/utils/dataManager';
import { landed, openLedger, runInLedger, runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { FakeStore, tokenFor, type FlushMode } from '../helpers/fakeStore';
import { freshGuild, notReadyGuild, storeGuild, tick } from '../helpers/gateRig';

// BT-5, confirmSaved over the scope record (notes/BT.md, "BT-5 design sheet: final, after the re-read against
// c42cdd1"). It answers 'ok' only when every write the facade accepted for its scope after since is held by the
// store; otherwise the worst true answer, deposed, unavailable, held, pending, through confirmWrite and the record's
// lost marks.

const DATA = process.env.DATA_DIR!;
const file = (guildId: string, category: string, name: string) => path.join(DATA, guildId, category, name);
const LOST_MARKS_PER_SCOPE = 32;
/** This run's mark at a given stamp. */
const at = (stamp: number): SaveMark => ({ ...saveMark(), stamp });

/** Runs fake time on until the answer comes back; an answer that outlives its deadline fails the test. */
async function answer<T>(pending: Promise<T>, deadlineMs: number): Promise<T> {
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await vi.advanceTimersByTimeAsync(0);
  for (let waited = 0; !settled && waited < deadlineMs + 200; waited += 20) await vi.advanceTimersByTimeAsync(20);
  expect(settled, 'the answer came back by its deadline').toBe(true);
  return pending;
}

/** Holds every rename onto each target until it is opened; reached resolves once the target's first is held. */
function holdRenames(targets: string[]): { reached: (target: string) => Promise<void>; open: (target: string) => void } {
  const real = fs.promises.rename;
  const holds = new Map(targets.map(target => {
    let open: () => void = () => undefined;
    let reach: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const reached = new Promise<void>(resolve => { reach = resolve; });
    return [target, { gate, open, reached, reach }] as const;
  }));
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    const hold = holds.get(String(to));
    if (hold) {
      hold.reach();
      await hold.gate;
    }
    return real.call(fs.promises, from, to);
  });
  return { reached: target => holds.get(target)!.reached, open: target => holds.get(target)!.open() };
}

/** Every temp-file open for the target fails with EACCES, so each write attempt fails at once. */
function failOpens(target: string): void {
  const real = fs.promises.open as (...args: unknown[]) => Promise<unknown>;
  vi.spyOn(fs.promises, 'open').mockImplementation((async (...args: unknown[]) => {
    const opened = String(args[0]);
    if (opened.startsWith(`${target}.`) && opened.endsWith('.tmp')) throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' });
    return real.apply(fs.promises, args);
  }) as never);
}

/** A recycle as boot.ts runs it: the old manager's unflushed writes exported, it quiesced, and a successor adopting them. */
function recycle(old: WorkingSetManager, guildId: string, readOnly: { value: boolean }): { store: FakeStore; manager: WorkingSetManager } {
  const carry = old.exportDirty([guildId]);
  old.quiesce();
  const store = new FakeStore();
  store.isReadOnly = () => readOnly.value;
  const manager = initWorkingSet(store);
  manager.adoptDirty(carry);
  return { store, manager };
}

/**
 * count managers in one recycle chain, as boot.ts runs it: each adopts the carry before it, hydrates (applying it),
 * takes one unlanded write of the guild and is recycled away, so each carry holds the ones before it; the last is held
 * by a read-only successor.
 */
async function carriedLosses(count: number): Promise<{ guildId: string; before: SaveMark; first: SaveMark }> {
  const guildId = freshGuild();
  setRouteOverride(guildId, 'postgres');
  const before = saveMark();
  let first = saveMark();
  let carry: DirtyCarry[] = [];
  for (let i = 0; i < count; i++) {
    const readOnly = { value: true };
    const store = new FakeStore();
    store.isReadOnly = () => readOnly.value;
    const manager = initWorkingSet(store);
    manager.adoptDirty(carry);
    expect(await manager.hydrate(guildId, tokenFor())).toBe('ready');
    readOnly.value = false;
    expect(saveData('a.json', { guildId, category: 'm' }, { i })).toBe(true);
    if (i === 0) first = saveMark();
    carry = manager.exportDirty([guildId]);
    manager.quiesce();
  }
  const store = new FakeStore();
  store.isReadOnly = () => true;
  const successor = initWorkingSet(store);
  successor.adoptDirty(carry);
  expect(carry[0].fate.outcome()).toBe('kept');
  return { guildId, before, first };
}

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The working set, the state x exit table
// ---------------------------------------------------------------------------

describe('confirmSaved over a working set, the state x exit table', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('answers ok with nothing noted: a guild never written, and a postgres-routed guild with no working set', async () => {
    expect(await answer(confirmSaved(freshGuild(), { deadlineMs: 1000 }), 1000)).toBe('ok');
    const routed = freshGuild();
    setRouteOverride(routed, 'postgres');
    const ws = initWorkingSet(new FakeStore());
    expect(ws.has(routed)).toBe(false);
    expect(await answer(confirmSaved(routed, { deadlineMs: 1000 }), 1000)).toBe('ok');
  });

  it('answers ok once the write landed, before the call or during the wait', async () => {
    const { guildId, store, options } = await storeGuild();
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    expect(await answer(confirmSaved(guildId, { deadlineMs: 1000 }), 1000)).toBe('ok');
    expect(store.doc(guildId, 'a.json')).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(saveData('b.json', options, { b: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.doc(guildId, 'b.json')).toBe(JSON.stringify({ b: 1 }, null, 2));
    expect(await answer(confirmSaved(guildId, { deadlineMs: 0 }), 0)).toBe('ok');
  });

  it('answers pending at the deadline while the store holds the flush on the wire, and ok once it commits', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    expect(await answer(confirmSaved(guildId, { deadlineMs: 100 }), 100)).toBe('pending');
    store.holding = false;
    store.release();
    expect(await answer(confirmSaved(guildId, { deadlineMs: 1000 }), 1000)).toBe('ok');
  });

  it('waits 8 s by default: a write the store commits after 100 ms answers ok', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    const outcome = confirmSaved(guildId);
    await vi.advanceTimersByTimeAsync(100);
    store.holding = false;
    store.release();
    expect(await answer(outcome, 8000)).toBe('ok');
  });

  it('turns an evicted set\'s unlanded write into a lost mark, so the record no longer holds the set', async () => {
    const { guildId, options } = await storeGuild();
    const before = saveMark();
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    getWorkingSet()!.evict(guildId);
    expect(pendingFor(guildId, before.stamp)).toEqual({ tickets: [], lost: [{ stamp: before.stamp + 1, carry: null, deposed: false }], refused: [], pruned: false });
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 1000 }), 1000)).toBe('unavailable');
  });

  it('answers unavailable when a confirm throws', async () => {
    const guildId = freshGuild();
    const before = saveMark();
    const manager = { confirm: () => Promise.reject(new Error('the confirm failed')) };
    noteScopeTicket(guildId, { kind: 'ws', manager, set: { landedSeq: 0 }, guildId, seq: 1 } as unknown as WriteTicket);
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 1000 }), 1000)).toBe('unavailable');
  });

  it.each(['unavailable', 'read-only'] as FlushMode[])('answers held when the store refuses the commit (%s), and ok once it heals', async mode => {
    const { guildId, store, options } = await storeGuild();
    store.mode = mode;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    expect(await answer(confirmSaved(guildId, { deadlineMs: 1000 }), 1000)).toBe('held');
    expect(store.doc(guildId, 'a.json')).toBeUndefined();
    store.mode = 'commit';
    expect(await answer(confirmSaved(guildId, { deadlineMs: 1000 }), 1000)).toBe('ok');
  });

  it('answers deposed for a fenced set, by the call\'s own flush or by an earlier one', async () => {
    const own = await storeGuild();
    own.store.mode = 'deposed';
    expect(saveData('a.json', own.options, { a: 1 })).toBe(true);
    expect(await answer(confirmSaved(own.guildId, { deadlineMs: 1000 }), 1000)).toBe('deposed');
    const earlier = await storeGuild();
    earlier.store.mode = 'deposed';
    expect(saveData('a.json', earlier.options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(getWorkingSet()!.stateOf(earlier.guildId)).toBe('fenced');
    expect(await answer(confirmSaved(earlier.guildId, { deadlineMs: 1000 }), 1000)).toBe('deposed');
  });

  it('answers unavailable for a write its kept set dropped when the reclaim found another owner, also once the new set is read and written', async () => {
    const { guildId, store, options } = await storeGuild();
    const ws = getWorkingSet()!;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    ws.freezeRetained(guildId);
    store.reclaim = 'lost';
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    expect(store.doc(guildId, 'a.json')).toBeUndefined();
    expect(await answer(confirmSaved(guildId, { deadlineMs: 1000 }), 1000)).toBe('unavailable');
    const mark = saveMark();
    expect(saveData('b.json', options, { b: 1 })).toBe(true);
    expect(await answer(confirmSaved(guildId, { deadlineMs: 1000 }), 1000)).toBe('unavailable');
    expect(store.doc(guildId, 'b.json')).toBe(JSON.stringify({ b: 1 }, null, 2));
    expect(await answer(confirmSaved(guildId, { since: mark, deadlineMs: 1000 }), 1000)).toBe('ok');
  });

  it('answers ok for a set that left after its writes landed: evicted, or its manager quiesced', async () => {
    const evicted = await storeGuild();
    expect(saveData('a.json', evicted.options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(evicted.store.doc(evicted.guildId, 'a.json')).toBe(JSON.stringify({ a: 1 }, null, 2));
    getWorkingSet()!.evict(evicted.guildId);
    expect(await answer(confirmSaved(evicted.guildId, { deadlineMs: 1000 }), 1000)).toBe('ok');
    const quiesced = await storeGuild();
    expect(saveData('a.json', quiesced.options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(quiesced.store.doc(quiesced.guildId, 'a.json')).toBe(JSON.stringify({ a: 1 }, null, 2));
    getWorkingSet()!.quiesce();
    expect(await answer(confirmSaved(quiesced.guildId, { deadlineMs: 1000 }), 1000)).toBe('ok');
  });

  it('answers pending for writes a recycle carried while the successor keeps them, and unavailable once its prune drops them', async () => {
    const { guildId, options } = await storeGuild();
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    const readOnly = { value: true };
    const { manager } = recycle(getWorkingSet()!, guildId, readOnly);
    expect(await answer(confirmSaved(guildId, { deadlineMs: 100 }), 100)).toBe('pending');
    readOnly.value = false;
    expect(await manager.hydrate(guildId, tokenFor())).toBe('ready');
    expect(await answer(confirmSaved(guildId, { deadlineMs: 100 }), 100)).toBe('unavailable');
  });

  it('answers unavailable, not ok, for a carried write the successor later landed (a stated limit)', async () => {
    const { guildId, options } = await storeGuild();
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    const old = getWorkingSet()!;
    const carry = old.exportDirty([guildId]);
    old.quiesce();
    const after = new FakeStore();
    const successor = initWorkingSet(after);
    expect(await successor.hydrate(guildId, tokenFor())).toBe('ready');
    successor.adoptDirty(carry);
    expect(await answer(confirmSaved(guildId, { deadlineMs: 0 }), 0)).toBe('pending');
    await vi.advanceTimersByTimeAsync(600);
    expect(after.doc(guildId, 'a.json')).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(carry[0].fate.outcome()).toBe('landed');
    expect(await answer(confirmSaved(guildId, { deadlineMs: 100 }), 100)).toBe('unavailable');
  });

  it('answers unavailable for a set evicted during the wait, with its flush on the wire', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    const asked = confirmSaved(guildId, { deadlineMs: 8000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.flushesSent).toBe(1);
    getWorkingSet()!.evict(guildId);
    store.holding = false;
    store.release();
    expect(await answer(asked, 8000)).toBe('unavailable');
  });

  it('answers unavailable for a set recycled away during the wait while a write of it was on the wire, which no carry holds (DR4-2)', async () => {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    store.holding = true;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    expect(saveData('b.json', options, { b: 1 })).toBe(true);
    const asked = confirmSaved(guildId, { deadlineMs: 8000 });
    await vi.advanceTimersByTimeAsync(0);
    recycle(old, guildId, { value: true });
    store.holding = false;
    store.release();
    expect(await answer(asked, 8000)).toBe('unavailable');
    expect(await answer(confirmSaved(guildId, { deadlineMs: 0 }), 0)).toBe('unavailable');
  });

  it('answers pending for carried lost marks up to the bound, while the successor holds the writes', async () => {
    const { guildId, before } = await carriedLosses(LOST_MARKS_PER_SCOPE);
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 100 }), 100)).toBe('pending');
  });

  it('answers unavailable for a since below the mark the bound pruned, and pending from that mark on', async () => {
    const { guildId, before, first } = await carriedLosses(LOST_MARKS_PER_SCOPE + 1);
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 100 }), 100)).toBe('unavailable');
    expect(await answer(confirmSaved(guildId, { deadlineMs: 100 }), 100)).toBe('unavailable');
    expect(await answer(confirmSaved(guildId, { since: first, deadlineMs: 100 }), 100)).toBe('pending');
  });

  it('does not wait on a write accepted after the call, and counts it on the next call', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    const asked = confirmSaved(guildId, { deadlineMs: 8000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(saveData('b.json', options, { b: 1 })).toBe(true);
    store.release();
    expect(await answer(asked, 8000)).toBe('ok');
    expect(store.doc(guildId, 'b.json')).toBeUndefined();
    expect(getWorkingSet()!.writesSettled()).toBe(false);
    expect(await answer(confirmSaved(guildId, { deadlineMs: 0 }), 0)).toBe('pending');
    store.holding = false;
    store.release();
  });

  // A fenced set that then left (its drain, or a hydrate replacing it) leaves a deposed lost mark, as confirmWrite
  // answers its ticket.
  it('answers deposed for a fenced set that then left: evicted by its drain, or replaced by a hydrate', async () => {
    const drained = await storeGuild();
    drained.store.mode = 'deposed';
    expect(saveData('a.json', drained.options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getWorkingSet()!.stateOf(drained.guildId)).toBeNull();
    expect(await answer(confirmSaved(drained.guildId, { deadlineMs: 1000 }), 1000)).toBe('deposed');
    const replaced = await storeGuild();
    replaced.store.mode = 'deposed';
    expect(saveData('a.json', replaced.options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    replaced.store.mode = 'commit';
    expect(await getWorkingSet()!.hydrate(replaced.guildId, tokenFor())).toBe('ready');
    expect(await answer(confirmSaved(replaced.guildId, { deadlineMs: 1000 }), 1000)).toBe('deposed');
  });
});

// ---------------------------------------------------------------------------
// since, and the frames that default it
// ---------------------------------------------------------------------------

describe('since', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('excludes an older unlanded write, and a write noted after a mark is stamped above it', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    const before = saveMark();
    expect(saveData('old.json', options, { o: 1 })).toBe(true);
    const mark = saveMark();
    expect(mark.stamp).toBe(before.stamp + 1);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    expect(await answer(confirmSaved(guildId, { since: mark, deadlineMs: 0 }), 0)).toBe('ok');
    expect(await answer(confirmSaved(guildId, { since: at(mark.stamp - 1), deadlineMs: 0 }), 0)).toBe('pending');
    expect(await answer(confirmSaved(guildId, { deadlineMs: 0 }), 0)).toBe('pending');
    store.holding = false;
    store.release();
    expect(await answer(confirmSaved(guildId, { deadlineMs: 1000 }), 1000)).toBe('ok');
  });

  it('defaults to the open frame\'s mark inside a panel action or the console invoke, and to 0 outside every frame', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    expect(saveData('old.json', options, { o: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    const ledger = openLedger('panel');
    expect(ledger.openedMark).toEqual(saveMark());
    expect(await runInLedger(ledger, 'mod', () => answer(confirmSaved(guildId, { deadlineMs: 0 }), 0))).toBe('ok');
    expect(await answer(confirmSaved(guildId, { deadlineMs: 0 }), 0)).toBe('pending');
    expect(await runInLedger(ledger, 'mod', () => {
      expect(saveData('new.json', options, { n: 1 })).toBe(true);
      return answer(confirmSaved(guildId, { deadlineMs: 0 }), 0);
    })).toBe('pending');
    expect(await runSealed('console', null, 'mod', () => answer(confirmSaved(guildId, { deadlineMs: 0 }), 0))).toBe('ok');
    expect(await runSealed('console', null, 'mod', () => {
      expect(saveData('third.json', options, { t: 1 })).toBe(true);
      return answer(confirmSaved(guildId, { deadlineMs: 0 }), 0);
    })).toBe('pending');
    store.holding = false;
    store.release();
    expect(await answer(confirmSaved(guildId, { deadlineMs: 1000 }), 1000)).toBe('ok');
  });

  it('notes an absent delete that carries an earlier unlanded delete\'s ticket, so a since after the first delete still counts it', async () => {
    const guildId = freshGuild();
    setRouteOverride(guildId, 'postgres');
    const store = new FakeStore();
    store.docs.set(`${guildId}|m/x.json`, '{"x":1}');
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    const options = { guildId, category: 'm' };
    expect(deleteData('x.json', options)).toBe(true);
    store.holding = true;
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    const mark = saveMark();
    const tracked = deleteDataTracked('x.json', options);
    expect(tracked.outcome).toBe('absent');
    expect(tracked.outcome === 'absent' ? tracked.ticket?.kind : undefined).toBe('ws');
    expect(saveMark().stamp).toBe(mark.stamp + 1);
    expect(await answer(confirmSaved(guildId, { since: mark, deadlineMs: 0 }), 0)).toBe('pending');
    store.holding = false;
    store.release();
    expect(await answer(confirmSaved(guildId, { since: mark, deadlineMs: 1000 }), 1000)).toBe('ok');
    expect(store.doc(guildId, 'x.json')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The file queue, on the real filesystem under the test's DATA_DIR
// ---------------------------------------------------------------------------

describe('confirmSaved over the file queue', () => {
  it('answers unavailable for a file write dropped with its guild\'s namespace', async () => {
    const guildId = freshGuild();
    expect(saveData('a.json', { guildId, category: 'm' }, { a: 1 })).toBe(true);
    dropPendingForGuild(guildId);
    expect(await confirmSaved(guildId, { deadlineMs: 1000 })).toBe('unavailable');
    expect(fs.existsSync(file(guildId, 'm', 'a.json'))).toBe(false);
  });

  it('keeps answering unavailable for a dropped file write after a later write to the same file lands', async () => {
    const guildId = freshGuild();
    const before = saveMark();
    expect(saveData('a.json', { guildId, category: 'm' }, { a: 1 })).toBe(true);
    dropPendingForGuild(guildId);
    expect(saveData('a.json', { guildId, category: 'm' }, { a: 2 })).toBe(true);
    expect(await confirmSaved(guildId, { since: before, deadlineMs: 1000 })).toBe('unavailable');
    expect(JSON.parse(fs.readFileSync(file(guildId, 'm', 'a.json'), 'utf-8'))).toEqual({ a: 2 });
  });

  it('reads a held write again once the slower confirms are in: one that landed meanwhile answers ok', async () => {
    const guildId = freshGuild();
    const blocked = file(guildId, 'm', 'blocked.json');
    const onTheWire = file(guildId, 'm', 'wire.json');
    failOpens(blocked);
    const holds = holdRenames([onTheWire]);
    try {
      expect(saveData('blocked.json', { guildId, category: 'm' }, { b: 1 })).toBe(true);
      expect(saveData('wire.json', { guildId, category: 'm' }, { w: 1 })).toBe(true);
      await holds.reached(onTheWire);
      const outcome = confirmSaved(guildId, { deadlineMs: 5000 });
      // The blocked write's three attempts fail within 100 ms, so its first answer is held.
      await tick(300);
      vi.mocked(fs.promises.open).mockRestore();
      expect(saveData('blocked.json', { guildId, category: 'm' }, { b: 2 })).toBe(true);
      for (let i = 0; i < 100 && !fs.existsSync(blocked); i++) await tick(20);
      expect(fs.existsSync(blocked)).toBe(true);
      holds.open(onTheWire);
      expect(await outcome).toBe('ok');
    } finally {
      holds.open(onTheWire);
    }
  });

  it('narrows the file scope to the category\'s folder, and not to a folder whose name only begins with it', async () => {
    const guildId = freshGuild();
    const inA = file(guildId, 'a', 'one.json');
    const inAb = file(guildId, 'ab', 'two.json');
    const holds = holdRenames([inA, inAb]);
    try {
      expect(saveData('one.json', { guildId, category: 'a' }, { one: 1 })).toBe(true);
      expect(saveData('two.json', { guildId, category: 'ab' }, { two: 1 })).toBe(true);
      expect(saveData('three.json', { guildId, category: 'b' }, { three: 1 })).toBe(true);
      await holds.reached(inA);
      await holds.reached(inAb);
      expect(await confirmSaved(guildId, { category: 'b', deadlineMs: 5000 })).toBe('ok');
      expect(fs.readFileSync(file(guildId, 'b', 'three.json'), 'utf8')).toBe(JSON.stringify({ three: 1 }, null, 2));
      expect(await confirmSaved(guildId, { category: 'c', deadlineMs: 50 })).toBe('ok');
      expect(await confirmSaved(guildId, { category: 'a', deadlineMs: 50 })).toBe('pending');
      expect(await confirmSaved(guildId, { deadlineMs: 50 })).toBe('pending');
      holds.open(inA);
      expect(await confirmSaved(guildId, { category: 'a', deadlineMs: 5000 })).toBe('ok');
      expect(await confirmSaved(guildId, { category: 'ab', deadlineMs: 50 })).toBe('pending');
    } finally {
      holds.open(inA);
      holds.open(inAb);
    }
    expect(await confirmSaved(guildId, { deadlineMs: 5000 })).toBe('ok');
  });

  it('does not narrow a working set by category: its one ticket answers for the whole set', async () => {
    const { guildId, store } = await storeGuild();
    store.holding = true;
    expect(saveData('one.json', { guildId, category: 'a' }, { one: 1 })).toBe(true);
    expect(await confirmSaved(guildId, { category: 'b', deadlineMs: 0 })).toBe('pending');
    store.holding = false;
    store.release();
    expect(await confirmSaved(guildId, { category: 'b', deadlineMs: 2000 })).toBe('ok');
  });

  it('answers for the global scope apart from every guild, a global write naming a guild included', async () => {
    const mark = saveMark();
    const other = freshGuild();
    const viaModule = path.join(DATA, 'global', 'bt5g', 'g.json');
    const viaOptions = path.join(DATA, 'global', 'bt5g', 'h.json');
    const holds = holdRenames([viaModule, viaOptions]);
    try {
      expect(saveGlobalModuleData('g.json', 'bt5g', { g: 1 })).toBe(true);
      expect(saveData('h.json', { scope: 'global', guildId: other, category: 'bt5g' }, { h: 1 })).toBe(true);
      await holds.reached(viaModule);
      await holds.reached(viaOptions);
      expect(await confirmSaved('global', { since: mark, deadlineMs: 50 })).toBe('pending');
      expect(await confirmSaved('global', { since: mark, category: 'bt5other', deadlineMs: 50 })).toBe('ok');
      expect(await confirmSaved(other, { deadlineMs: 50 })).toBe('ok');
      holds.open(viaModule);
      expect(await confirmSaved('global', { since: mark, deadlineMs: 50 })).toBe('pending');
      holds.open(viaOptions);
      expect(await confirmSaved('global', { since: mark, deadlineMs: 5000 })).toBe('ok');
    } finally {
      holds.open(viaModule);
      holds.open(viaOptions);
    }
    expect(fs.readFileSync(viaOptions, 'utf8')).toBe(JSON.stringify({ h: 1 }, null, 2));
  });

  it('answers the worst of its entries: deposed over unavailable over held over pending over ok', async () => {
    const guildId = freshGuild();
    const blocked = file(guildId, 'm', 'blocked.json');
    const onTheWire = file(guildId, 'm', 'wire.json');
    const mixed = freshGuild();
    const mixedWire = file(mixed, 'm', 'wire.json');
    failOpens(blocked);
    const holds = holdRenames([onTheWire, mixedWire]);
    try {
      expect(saveData('done.json', { guildId: mixed, category: 'm' }, { d: 1 })).toBe(true);
      expect(saveData('wire.json', { guildId: mixed, category: 'm' }, { w: 1 })).toBe(true);
      await holds.reached(mixedWire);
      expect(await confirmSaved(mixed, { deadlineMs: 50 })).toBe('pending');

      expect(saveData('blocked.json', { guildId, category: 'm' }, { b: 1 })).toBe(true);
      expect(saveData('wire.json', { guildId, category: 'm' }, { w: 1 })).toBe(true);
      await holds.reached(onTheWire);
      expect(await confirmSaved(guildId, { deadlineMs: 1000 })).toBe('held');

      // A transformation moves the guild to the database: its file entries stay in its scope beside the set's.
      setRouteOverride(guildId, 'postgres');
      const store = new FakeStore();
      const ws = initWorkingSet(store);
      expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
      expect(saveData('set.json', { guildId, category: 'm' }, { s: 1 })).toBe(true);
      ws.evict(guildId);
      expect(await confirmSaved(guildId, { deadlineMs: 1000 })).toBe('unavailable');

      store.mode = 'deposed';
      expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
      expect(saveData('set.json', { guildId, category: 'm' }, { s: 2 })).toBe(true);
      expect(await confirmSaved(guildId, { deadlineMs: 1000 })).toBe('deposed');
    } finally {
      holds.open(onTheWire);
      holds.open(mixedWire);
      dropPendingForGuild(guildId);
    }
  });

  it('answers for a write a timer made outside every ledger, and for one a timer armed in another interaction made', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    setTimeout(() => { saveData('timer.json', options, { t: 1 }); }, 5);
    await tick(30);
    expect(await confirmSaved(guildId, { deadlineMs: 0 })).toBe('pending');
    store.holding = false;
    store.release();
    expect(await confirmSaved(guildId, { deadlineMs: 2000 })).toBe('ok');
    expect(store.doc(guildId, 'timer.json')).toBe(JSON.stringify({ t: 1 }, null, 2));

    store.holding = true;
    const armedIn = openLedger('interaction');
    runInLedger(armedIn, 'mod', () => { setTimeout(() => { saveData('armed.json', options, { a: 1 }); }, 5); });
    const asking = openLedger('interaction');
    await tick(30);
    expect(armedIn.tickets()).toHaveLength(1);
    expect(asking.tickets()).toHaveLength(0);
    expect(await runInLedger(asking, null, () => confirmSaved(guildId, { deadlineMs: 0 }))).toBe('pending');
    store.holding = false;
    store.release();
    expect(await runInLedger(asking, null, () => confirmSaved(guildId, { deadlineMs: 2000 }))).toBe('ok');
  });

  it('notes an absent file delete that carries a queued delete\'s ticket', async () => {
    const guildId = freshGuild();
    const target = file(guildId, 'm', 'x.json');
    const holds = holdRenames([target]);
    try {
      expect(writeRawAtomic(target, '{"w":1}')).toBe(true);
      await holds.reached(target);
      expect(deleteRawAtomic(target)).toBe(true);
      expect(await confirmSaved(guildId, { deadlineMs: 50 })).toBe('ok');
      const mark = saveMark();
      const tracked = deleteDataTracked('x.json', { guildId, category: 'm' });
      expect(tracked.outcome).toBe('absent');
      expect(tracked.outcome === 'absent' ? tracked.ticket?.kind : undefined).toBe('file');
      expect(saveMark().stamp).toBe(mark.stamp + 1);
      expect(await confirmSaved(guildId, { deadlineMs: 50 })).toBe('pending');
      holds.open(target);
      expect(await confirmSaved(guildId, { deadlineMs: 5000 })).toBe('ok');
    } finally {
      holds.open(target);
    }
    expect(fs.existsSync(target)).toBe(false);
  });

  it('does not note a raw atomic write or delete', async () => {
    const guildId = freshGuild();
    const target = file(guildId, 'm', 'raw.json');
    const holds = holdRenames([target]);
    try {
      const mark = saveMark();
      expect(writeRawAtomic(target, '{"r":1}')).toBe(true);
      await holds.reached(target);
      expect(deleteRawAtomic(target)).toBe(true);
      expect(saveMark().stamp).toBe(mark.stamp);
      expect(await confirmSaved(guildId, { deadlineMs: 50 })).toBe('ok');
    } finally {
      holds.open(target);
    }
  });

  it('notes every refusal (review round 1, D1): a frozen guild, a frozen-retained set, a set not ready', async () => {
    const frozen = freshGuild();
    const options = { guildId: frozen, category: 'm' };
    let mark = saveMark();
    freezeGuildWrites(frozen);
    try {
      expect(saveData('a.json', options, { a: 1 })).toBe(false);
      expect(appendData('log.jsonl', options, 'x\n')).toBe(false);
      expect(deleteData('a.json', options)).toBe(false);
    } finally {
      unfreezeGuildWrites(frozen);
    }
    expect(saveMark().stamp).toBe(mark.stamp + 3);
    expect(await confirmSaved(frozen, { since: mark, deadlineMs: 50 })).toBe('refused');

    const retained = await storeGuild();
    getWorkingSet()!.freezeRetained(retained.guildId);
    mark = saveMark();
    expect(saveDataTracked('a.json', retained.options, { a: 1 })).toEqual({ outcome: 'frozen' });
    expect(saveMark().stamp).toBe(mark.stamp + 1);
    expect(await confirmSaved(retained.guildId, { since: mark, deadlineMs: 50 })).toBe('refused');

    const notReady = notReadyGuild();
    mark = saveMark();
    expect(saveDataTracked('a.json', notReady, { a: 1 })).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(appendDataTracked('log.jsonl', notReady, 'x\n')).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(saveMark().stamp).toBe(mark.stamp + 2);
    expect(await confirmSaved(notReady.guildId, { since: mark, deadlineMs: 50 })).toBe('refused');
  });

  it('notes every accepted save, append and delete through each wrapper, one stamp each, under its scope', async () => {
    const guildId = freshGuild();
    const mark = saveMark();
    expect(saveModuleData('a.json', guildId, 'bt5w', { a: 1 })).toBe(true);
    expect(appendData('log.jsonl', { guildId, category: 'bt5w' }, 'x\n')).toBe(true);
    expect(deleteModuleData('a.json', guildId, 'bt5w')).toBe(true);
    expect(saveGuildData('b.json', guildId, { b: 1 }, 'bt5w')).toBe(true);
    expect(saveGlobalData('bt5-c.json', { c: 1 })).toBe(true);
    expect(saveGlobalModuleData('d.json', 'bt5w', { d: 1 })).toBe(true);
    expect(deleteGlobalModuleData('d.json', 'bt5w')).toBe(true);
    expect(saveMark().stamp).toBe(mark.stamp + 7);
    expect(await confirmSaved(guildId, { since: mark, category: 'bt5w', deadlineMs: 5000 })).toBe('ok');
    expect(await confirmSaved('global', { since: mark, deadlineMs: 5000 })).toBe('ok');
    expect(fs.existsSync(file(guildId, 'bt5w', 'a.json'))).toBe(false);
    expect(fs.readFileSync(file(guildId, 'bt5w', 'log.jsonl'), 'utf8')).toBe('x\n');
  });
});

// ---------------------------------------------------------------------------
// The invariant, model-based
// ---------------------------------------------------------------------------

type ScopeOp =
  | { op: 'save' | 'append' | 'delete'; key: number }
  | { op: 'mode'; mode: FlushMode }
  | { op: 'tick'; ms: number }
  | { op: 'hold' | 'release' | 'evict' | 'rehydrate' | 'recycle' | 'mark' }
  | { op: 'confirm'; pick: number; deadline: number; wait: boolean };

const scopeOp: fc.Arbitrary<ScopeOp> = fc.oneof(
  { weight: 24, arbitrary: fc.record({ op: fc.constantFrom('save' as const, 'append' as const, 'delete' as const), key: fc.integer({ min: 0, max: 2 }) }) },
  { weight: 6, arbitrary: fc.record({ op: fc.constant('mode' as const), mode: fc.constantFrom<FlushMode>('commit', 'unavailable', 'read-only', 'deposed') }) },
  { weight: 12, arbitrary: fc.record({ op: fc.constant('tick' as const), ms: fc.constantFrom(0, 20, 600, 1600) }) },
  { weight: 6, arbitrary: fc.constant<ScopeOp>({ op: 'hold' }) },
  { weight: 6, arbitrary: fc.constant<ScopeOp>({ op: 'release' }) },
  { weight: 8, arbitrary: fc.constantFrom<ScopeOp>({ op: 'evict' }, { op: 'rehydrate' }, { op: 'recycle' }) },
  { weight: 6, arbitrary: fc.constant<ScopeOp>({ op: 'mark' }) },
  { weight: 14, arbitrary: fc.record({ op: fc.constant('confirm' as const), pick: fc.nat(), deadline: fc.constantFrom(0, 30, 8000), wait: fc.boolean() }) },
);

async function runScope(ops: ScopeOp[]): Promise<void> {
  vi.useFakeTimers();
  const guildId = freshGuild();
  setRouteOverride(guildId, 'postgres');
  const store = new FakeStore();
  let manager = initWorkingSet(store);
  const managers = [manager];
  try {
    expect(await manager.hydrate(guildId, tokenFor())).toBe('ready');
    const options = { guildId, category: 'm' };
    const marks = [saveMark()];
    const accepted: { stamp: number; ticket: WriteTicket }[] = [];
    const outstanding: Promise<void>[] = [];
    let unique = 0;
    const take = (result: { outcome: string; ticket?: WriteTicket }) => {
      if (result.ticket) accepted.push({ stamp: saveMark().stamp, ticket: result.ticket });
    };
    const write = (fn: () => { outcome: string; ticket?: WriteTicket }) => {
      try {
        take(fn());
      } catch (error) {
        if (!(error instanceof DataBackendUnavailableError)) throw error;
      }
    };
    const ask = (since: SaveMark, deadline: number) => {
      const calledAt = saveMark().stamp;
      return confirmSaved(guildId, { since, deadlineMs: deadline }).then(outcome => {
        if (outcome !== 'ok') return;
        for (const { stamp, ticket } of accepted) {
          if (stamp > since.stamp && stamp <= calledAt) expect(landed(ticket), `a write stamped ${stamp}, asked since ${since.stamp}, answered ok`).toBe(true);
        }
      });
    };

    for (const step of ops) {
      switch (step.op) {
        case 'save':
          write(() => saveDataTracked(`k${step.key}.json`, options, { w: ++unique }));
          break;
        case 'append':
          write(() => appendDataTracked(`k${step.key}.json`, options, `l${++unique};`));
          break;
        case 'delete':
          write(() => deleteDataTracked(`k${step.key}.json`, options));
          break;
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
          manager.evict(guildId);
          break;
        case 'rehydrate':
          if (manager.stateOf(guildId) !== 'fenced') manager.evict(guildId);
          expect(await manager.hydrate(guildId, tokenFor())).toBe('ready');
          break;
        case 'recycle': {
          const carry = manager.exportDirty([guildId]);
          manager.quiesce();
          manager = initWorkingSet(store);
          managers.push(manager);
          expect(await manager.hydrate(guildId, tokenFor())).toBe('ready');
          manager.adoptDirty(carry);
          break;
        }
        case 'mark':
          marks.push(saveMark());
          break;
        case 'confirm': {
          const asked = ask(marks[step.pick % marks.length], step.deadline);
          if (step.wait) await answer(asked, step.deadline);
          else outstanding.push(asked);
          break;
        }
      }
    }

    store.mode = 'commit';
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(outstanding);
    for (const since of marks) await answer(ask(since, 8000), 8000);
  } finally {
    for (const m of managers) m.quiesce();
    store.release();
    vi.useRealTimers();
  }
}

describe('confirmSaved, model-based', () => {
  it('never answers ok while a write accepted for the guild after since and before the call has not landed', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    await fc.assert(fc.asyncProperty(fc.array(scopeOp, { minLength: 1, maxLength: 30 }), runScope), { numRuns: 400 });
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Review round 1 (notes/BT.md, "BT-5 review round 1"): D1 to D4
// ---------------------------------------------------------------------------

describe('review round 1: refused writes, the hold, since and pruning', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('answers refused for a save refused after the mark, outside every frame (a frozen guild)', async () => {
    const guildId = freshGuild();
    freezeGuildWrites(guildId);
    try {
      const mark = saveMark();
      expect(saveModuleData('state.json', guildId, 'm', { s: 1 })).toBe(false);
      expect(await answer(confirmSaved(guildId, { since: mark, deadlineMs: 1000 }), 1000)).toBe('refused');
    } finally {
      unfreezeGuildWrites(guildId);
    }
  });

  it('answers refused for a write refused in another context\'s ledger', async () => {
    const guildId = freshGuild();
    const mark = saveMark();
    freezeGuildWrites(guildId);
    try {
      runInLedger(openLedger('interaction'), 'm', () => {
        expect(saveData('a.json', { guildId, category: 'm' }, { a: 1 })).toBe(false);
      });
      expect(await answer(confirmSaved(guildId, { since: mark, deadlineMs: 1000 }), 1000)).toBe('refused');
    } finally {
      unfreezeGuildWrites(guildId);
    }
  });

  it('answers refused for a save that throws (the database is read-only), and for a set not ready', async () => {
    const { guildId, store, options } = await storeGuild();
    store.isReadOnly = () => true;
    const mark = saveMark();
    expect(() => saveData('a.json', options, { a: 1 })).toThrow(DataBackendUnavailableError);
    expect(await answer(confirmSaved(guildId, { since: mark, deadlineMs: 1000 }), 1000)).toBe('refused');
    const notReady = notReadyGuild();
    const second = saveMark();
    expect(saveData('b.json', notReady, { b: 1 })).toBe(false);
    expect(await answer(confirmSaved(notReady.guildId, { since: second, deadlineMs: 1000 }), 1000)).toBe('refused');
  });

  it('answers unavailable for a refused document later rewritten whole, and ok for a refusal before the mark', async () => {
    const guildId = freshGuild();
    const mark = saveMark();
    freezeGuildWrites(guildId);
    expect(saveData('a.json', { guildId, category: 'm' }, { a: 1 })).toBe(false);
    unfreezeGuildWrites(guildId);
    expect(saveData('a.json', { guildId, category: 'm' }, { a: 2 })).toBe(true);
    expect(await answer(confirmSaved(guildId, { since: mark, deadlineMs: 1000 }), 1000)).toBe('unavailable');
    expect(await answer(confirmSaved(guildId, { since: saveMark(), deadlineMs: 1000 }), 1000)).toBe('ok');
  });

  it('narrows refusals by category like file writes', async () => {
    const guildId = freshGuild();
    const mark = saveMark();
    freezeGuildWrites(guildId);
    try {
      expect(saveData('a.json', { guildId, category: 'a' }, { a: 1 })).toBe(false);
      expect(await answer(confirmSaved(guildId, { since: mark, category: 'b', deadlineMs: 1000 }), 1000)).toBe('ok');
      expect(await answer(confirmSaved(guildId, { since: mark, category: 'a', deadlineMs: 1000 }), 1000)).toBe('refused');
    } finally {
      unfreezeGuildWrites(guildId);
    }
  });

  it('answers unavailable for writes its quiesced manager still holds with no successor (the hold)', async () => {
    const { guildId, options } = await storeGuild();
    const before = saveMark();
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    getWorkingSet()!.quiesce();
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 100 }), 100)).toBe('unavailable');
  });

  it('answers unavailable for a since that saveMark never returned', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    const mark = saveMark();
    for (const since of [Date.now(), Number.NaN, -1, 1.5, 0, mark.stamp, { ...mark, run: 'an earlier run' }, at(mark.stamp + 1), at(-1), at(1.5), { run: mark.run }]) {
      expect(await answer(confirmSaved(guildId, { since: since as SaveMark, deadlineMs: 0 }), 0), JSON.stringify(since)).toBe('unavailable');
    }
    store.holding = false;
    store.release();
  });

  it('answers deposed, not unavailable, when the scope is pruned and a deposed mark after since is known', async () => {
    const guildId = freshGuild();
    const first = saveMark().stamp + 1;
    for (let i = 0; i < LOST_MARKS_PER_SCOPE + 1; i++) {
      const set = { landedSeq: 0 };
      noteScopeTicket(guildId, { kind: 'ws', manager: {}, set, guildId, seq: 1 } as unknown as WriteTicket);
      setLeft(set);
    }
    const fenced = { landedSeq: 0, state: 'fenced' };
    noteScopeTicket(guildId, { kind: 'ws', manager: {}, set: fenced, guildId, seq: 1 } as unknown as WriteTicket);
    setLeft(fenced);
    expect(pendingFor(guildId, first - 1).pruned).toBe(true);
    expect(await answer(confirmSaved(guildId, { since: at(first - 1), deadlineMs: 0 }), 0)).toBe('deposed');
  });

  it('answers refused over deposed when a scope holds both after since', async () => {
    const guildId = freshGuild();
    const since = saveMark();
    const fenced = { landedSeq: 0, state: 'fenced' };
    noteScopeTicket(guildId, { kind: 'ws', manager: {}, set: fenced, guildId, seq: 1 } as unknown as WriteTicket);
    setLeft(fenced);
    noteScopeRefusal(guildId, `guild:${guildId}:m/a.json`);
    expect(await answer(confirmSaved(guildId, { since, deadlineMs: 0 }), 0)).toBe('refused');
  });
});

// ---------------------------------------------------------------------------
// Delta round 1 (notes/BT.md, "BT-5 delta round 1")
// ---------------------------------------------------------------------------

describe('delta round 1: the hold after a recycle, and marks from another run', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('answers unavailable for carried writes once the successor keeping them is quiesced too (the hold after a recycle)', async () => {
    const { guildId, options } = await storeGuild();
    const before = saveMark();
    const tracked = saveDataTracked('a.json', options, { a: 1 });
    if (tracked.outcome !== 'saved') throw new Error(`the write was not accepted: ${tracked.outcome}`);
    const { manager } = recycle(getWorkingSet()!, guildId, { value: true });
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 100 }), 100)).toBe('pending');
    expect(await answer(confirmWrite(tracked.ticket, 100), 100)).toBe('pending');
    manager.quiesce();
    expect(getWorkingSet()).toBe(manager);
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 100 }), 100)).toBe('unavailable');
    expect(await answer(confirmWrite(tracked.ticket, 100), 100)).toBe('unavailable');
  });

  it('answers unavailable for a mark from another run of the bot, and takes this run\'s mark back from JSON', async () => {
    const { guildId, options } = await storeGuild();
    const mark = saveMark();
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    expect(await answer(confirmSaved(guildId, { since: JSON.parse(JSON.stringify(mark)) as SaveMark, deadlineMs: 1000 }), 1000)).toBe('ok');
    expect(await answer(confirmSaved(guildId, { since: { ...mark, run: 'an earlier run' }, deadlineMs: 1000 }), 1000)).toBe('unavailable');
    expect(await answer(confirmSaved(guildId, { since: mark.stamp as unknown as SaveMark, deadlineMs: 1000 }), 1000)).toBe('unavailable');
  });
});

// ---------------------------------------------------------------------------
// Delta rounds 2 and 3 (notes/BT.md, "BT-5 delta round 3"): the successor check asks whether the successor keeps the
// carry, not whether it holds any write of the guild
// ---------------------------------------------------------------------------

describe('delta rounds 2 and 3: the successor check keyed on the carry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('answers unavailable for carried writes its successor pruned, also once the guild is written again', async () => {
    const { guildId, options } = await storeGuild();
    const before = saveMark();
    const tracked = saveDataTracked('a.json', options, { a: 1 });
    if (tracked.outcome !== 'saved') throw new Error(`the write was not accepted: ${tracked.outcome}`);
    const readOnly = { value: true };
    const { manager, store } = recycle(getWorkingSet()!, guildId, readOnly);
    readOnly.value = false;
    expect(await manager.hydrate(guildId, tokenFor())).toBe('ready');
    expect(store.doc(guildId, 'a.json')).toBeUndefined();
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 0 }), 0)).toBe('unavailable');
    store.holding = true;
    expect(saveData('b.json', options, { b: 1 })).toBe(true);
    expect(manager.writesSettled()).toBe(false);
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 0 }), 0)).toBe('unavailable');
    expect(await answer(confirmWrite(tracked.ticket, 0), 0)).toBe('unavailable');
    store.holding = false;
    store.release();
  });

  it('answers unavailable from flushGuildOutcome for a set recycled away during its wait while a write of it was on the wire (DR4-2)', async () => {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    store.holding = true;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    expect(saveData('b.json', options, { b: 1 })).toBe(true);
    const asked = flushGuildOutcome(guildId, 8000);
    await vi.advanceTimersByTimeAsync(0);
    recycle(old, guildId, { value: true });
    store.holding = false;
    store.release();
    expect(await answer(asked, 8000)).toBe('unavailable');
  });

  it('answers unavailable from flushGuildOutcome for a carry the copy took writes past, and drops it', async () => {
    const { guildId, options } = await storeGuild();
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    const readOnly = { value: true };
    const { manager } = recycle(getWorkingSet()!, guildId, readOnly);
    expect(await answer(flushGuildOutcome(guildId, 0), 0)).toBe('pending');
    readOnly.value = false;
    expect(await answer(flushGuildOutcome(guildId, 0), 0)).toBe('unavailable');
    expect(await answer(flushGuildOutcome(guildId, 0), 0)).toBe('ok');
    expect(manager.dirtyGuildIds()).not.toContain(guildId);
  });

  it('keeps an applied carry until a batch built after it commits, held or on the wire included', async () => {
    const { guildId, options } = await storeGuild();
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    const old = getWorkingSet()!;
    const carry = old.exportDirty([guildId]);
    old.quiesce();
    const after = new FakeStore();
    after.mode = 'unavailable';
    const successor = initWorkingSet(after);
    expect(await successor.hydrate(guildId, tokenFor())).toBe('ready');
    successor.adoptDirty(carry);
    expect(carry[0].fate.outcome()).toBe('kept');
    await vi.advanceTimersByTimeAsync(600);
    expect(after.doc(guildId, 'a.json')).toBeUndefined();
    expect(carry[0].fate.outcome()).toBe('kept');
    after.mode = 'commit';
    after.holding = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(after.flushesSent).toBeGreaterThan(0);
    expect(carry[0].fate.outcome()).toBe('kept');
    after.holding = false;
    after.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(after.doc(guildId, 'a.json')).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(carry[0].fate.outcome()).toBe('landed');
  });

  it('keeps no carry once its set is exported again or fenced, or its manager quiesced', async () => {
    for (const leave of ['export', 'fence', 'quiesce'] as const) {
      const { guildId, options } = await storeGuild();
      expect(saveData('a.json', options, { a: 1 })).toBe(true);
      const old = getWorkingSet()!;
      const carry = old.exportDirty([guildId]);
      old.quiesce();
      const after = new FakeStore();
      after.holding = true;
      const successor = initWorkingSet(after);
      expect(await successor.hydrate(guildId, tokenFor())).toBe('ready');
      successor.adoptDirty(carry);
      expect(carry[0].fate.outcome(), leave).toBe('kept');
      if (leave === 'export') expect(successor.exportDirty([guildId])).toHaveLength(1);
      if (leave === 'quiesce') successor.quiesce();
      if (leave === 'fence') {
        after.holding = false;
        after.mode = 'deposed';
        await vi.advanceTimersByTimeAsync(600);
        expect(successor.stateOf(guildId)).toBe('fenced');
      }
      // An export forwards it into a carry no successor adopted yet; a fence or a quiesce drops it.
      expect(carry[0].fate.outcome(), leave).toBe(leave === 'export' ? 'carried' : 'dropped');
      after.holding = false;
      after.release();
      successor.quiesce();
    }
  });
});

// ---------------------------------------------------------------------------
// Delta round 4 (notes/BT.md, "BT-5 delta round 4: the verdicts and the redesign"): a write answers by the fate of
// the one carry that took it off, never by another carry of its guild
// ---------------------------------------------------------------------------

describe('delta round 4: the successor check keyed on the carry\'s own fate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('answers unavailable for a write whose carry was pruned, evicted or landed, after a second recycle carries a new write on (DR4-1)', async () => {
    for (const end of ['prune', 'evict', 'land'] as const) {
      const { guildId, options } = await storeGuild();
      const before = saveMark();
      const tracked = saveDataTracked('a.json', options, { a: 1 });
      if (tracked.outcome !== 'saved') throw new Error(`the write was not accepted: ${tracked.outcome}`);
      const readOnly = { value: true };
      const { manager: m2, store: s2 } = recycle(getWorkingSet()!, guildId, readOnly);
      if (end === 'prune') readOnly.value = false;
      expect(await m2.hydrate(guildId, tokenFor()), end).toBe('ready');
      readOnly.value = false;
      if (end === 'evict') {
        expect(await answer(confirmWrite(tracked.ticket, 0), 0), end).toBe('pending');
        m2.evict(guildId);
        expect(await m2.hydrate(guildId, tokenFor()), end).toBe('ready');
      }
      if (end === 'land') {
        await vi.advanceTimersByTimeAsync(600);
        expect(s2.doc(guildId, 'a.json'), end).toBe(JSON.stringify({ a: 1 }, null, 2));
      } else {
        expect(s2.doc(guildId, 'a.json'), end).toBeUndefined();
      }
      expect(await answer(confirmWrite(tracked.ticket, 0), 0), end).toBe('unavailable');
      expect(saveData('b.json', options, { b: 1 }), end).toBe(true);
      recycle(m2, guildId, { value: true });
      expect(await answer(confirmWrite(tracked.ticket, 0), 0), end).toBe('unavailable');
      expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 0 }), 0), end).toBe('unavailable');
    }
  });

  it('answers unavailable for a write on the wire at the export, which no carry holds, and pending for one made after it (DR4-2)', async () => {
    const { guildId, store, options } = await storeGuild();
    const before = saveMark();
    const old = getWorkingSet()!;
    store.holding = true;
    const a = saveDataTracked('a.json', options, { a: 1 });
    if (a.outcome !== 'saved') throw new Error(`the write was not accepted: ${a.outcome}`);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    const b = saveDataTracked('b.json', options, { b: 1 });
    if (b.outcome !== 'saved') throw new Error(`the write was not accepted: ${b.outcome}`);
    recycle(old, guildId, { value: true });
    store.mode = 'unavailable';
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.doc(guildId, 'a.json')).toBeUndefined();
    expect(await answer(confirmWrite(a.ticket, 0), 0)).toBe('unavailable');
    expect(await answer(confirmWrite(b.ticket, 0), 0)).toBe('pending');
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 0 }), 0)).toBe('unavailable');
  });

  it('answers unavailable for a write the old manager took after its export, which no carry holds', async () => {
    const { guildId, options } = await storeGuild();
    const a = saveDataTracked('a.json', options, { a: 1 });
    if (a.outcome !== 'saved') throw new Error(`the write was not accepted: ${a.outcome}`);
    const old = getWorkingSet()!;
    const carry = old.exportDirty([guildId]);
    const b = saveDataTracked('b.json', options, { b: 1 });
    if (b.outcome !== 'saved') throw new Error(`the write was not accepted: ${b.outcome}`);
    old.quiesce();
    const store = new FakeStore();
    store.isReadOnly = () => true;
    initWorkingSet(store).adoptDirty(carry);
    expect(await answer(confirmWrite(a.ticket, 0), 0)).toBe('pending');
    expect(await answer(confirmWrite(b.ticket, 0), 0)).toBe('unavailable');
  });

  it('answers pending for a set recycled away during the wait once nothing of it is on the wire (fp_harness J5f\'s shape)', async () => {
    for (const ask of ['confirmSaved', 'flushGuildOutcome'] as const) {
      const { guildId, store, options } = await storeGuild();
      const old = getWorkingSet()!;
      store.holding = true;
      expect(saveData('a.json', options, { a: 1 }), ask).toBe(true);
      await vi.advanceTimersByTimeAsync(600);
      expect(store.flushesSent, ask).toBe(1);
      const asked = ask === 'confirmSaved' ? confirmSaved(guildId, { deadlineMs: 8000 }) : flushGuildOutcome(guildId, 8000);
      await vi.advanceTimersByTimeAsync(0);
      store.mode = 'unavailable';
      store.holding = false;
      store.release();
      await vi.advanceTimersByTimeAsync(0);
      recycle(old, guildId, { value: true });
      expect(await answer(asked, 8000), ask).toBe('pending');
    }
  });

  it('answers unavailable from flushGuildOutcome once the successor keeping the carry is quiesced too (DR4-3)', async () => {
    const { guildId, options } = await storeGuild();
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    const { manager } = recycle(getWorkingSet()!, guildId, { value: true });
    expect(await answer(flushGuildOutcome(guildId, 100), 100)).toBe('pending');
    manager.quiesce();
    expect(await answer(flushGuildOutcome(guildId, 100), 100)).toBe('unavailable');
  });

  it('lands a carry applied over a newer write that was on the wire, with that write (DR4-4)', async () => {
    const { guildId, options } = await storeGuild();
    const tracked = saveDataTracked('a.json', options, { a: 1 });
    if (tracked.outcome !== 'saved') throw new Error(`the write was not accepted: ${tracked.outcome}`);
    const old = getWorkingSet()!;
    const carry = old.exportDirty([guildId]);
    old.quiesce();
    const after = new FakeStore();
    const successor = initWorkingSet(after);
    expect(await successor.hydrate(guildId, tokenFor())).toBe('ready');
    after.holding = true;
    expect(saveData('a.json', options, { a: 2 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(after.flushesSent).toBe(1);
    successor.adoptDirty(carry);
    expect(await answer(confirmWrite(tracked.ticket, 0), 0)).toBe('pending');
    after.holding = false;
    after.release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(after.doc(guildId, 'a.json')).toBe(JSON.stringify({ a: 2 }, null, 2));
    expect(successor.writesSettled()).toBe(true);
    expect(await answer(confirmWrite(tracked.ticket, 0), 0)).toBe('unavailable');
  });

  it('answers unavailable for a carry no successor adopted yet, and pending once one does', async () => {
    const { guildId, options } = await storeGuild();
    const tracked = saveDataTracked('a.json', options, { a: 1 });
    if (tracked.outcome !== 'saved') throw new Error(`the write was not accepted: ${tracked.outcome}`);
    const old = getWorkingSet()!;
    const carry = old.exportDirty([guildId]);
    old.quiesce();
    const store = new FakeStore();
    store.isReadOnly = () => true;
    const next = initWorkingSet(store);
    expect(await answer(confirmWrite(tracked.ticket, 0), 0)).toBe('unavailable');
    next.adoptDirty(carry);
    expect(await answer(confirmWrite(tracked.ticket, 0), 0)).toBe('pending');
  });

  it('answers unavailable for a lost mark of a set no carry took, while another carry of the guild is kept', async () => {
    const { guildId, options } = await storeGuild();
    const before = saveMark();
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    getWorkingSet()!.quiesce();
    const second = initWorkingSet(new FakeStore());
    expect(await second.hydrate(guildId, tokenFor())).toBe('ready');
    expect(saveData('b.json', options, { b: 1 })).toBe(true);
    recycle(second, guildId, { value: true });
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 0 }), 0)).toBe('unavailable');
  });

  it('forwards a carry applied here into the next export, unless the batch on the wire took it', async () => {
    for (const wire of [false, true]) {
      const { guildId, options } = await storeGuild();
      const tracked = saveDataTracked('a.json', options, { a: 1 });
      if (tracked.outcome !== 'saved') throw new Error(`the write was not accepted: ${tracked.outcome}`);
      const readOnly = { value: true };
      const { manager: m2, store: s2 } = recycle(getWorkingSet()!, guildId, readOnly);
      expect(await m2.hydrate(guildId, tokenFor())).toBe('ready');
      readOnly.value = false;
      if (wire) {
        s2.holding = true;
        await vi.advanceTimersByTimeAsync(600);
        expect(s2.flushesSent).toBe(1);
        // A later write keeps the next carry from being empty, so only the batch on the wire leaves the first out.
        expect(saveData('x.json', options, { x: 1 })).toBe(true);
      }
      recycle(m2, guildId, { value: true });
      expect(await answer(confirmWrite(tracked.ticket, 0), 0), `wire ${wire}`).toBe(wire ? 'unavailable' : 'pending');
      s2.holding = false;
      s2.release();
    }
  });

  it('answers each write of a set exported twice by its own carry', async () => {
    const { guildId, options } = await storeGuild();
    const before = saveMark();
    const a = saveDataTracked('a.json', options, { a: 1 });
    if (a.outcome !== 'saved') throw new Error(`the write was not accepted: ${a.outcome}`);
    const old = getWorkingSet()!;
    old.exportDirty([guildId]);
    const b = saveDataTracked('b.json', options, { b: 1 });
    if (b.outcome !== 'saved') throw new Error(`the write was not accepted: ${b.outcome}`);
    const second = old.exportDirty([guildId]);
    old.quiesce();
    const store = new FakeStore();
    store.isReadOnly = () => true;
    initWorkingSet(store).adoptDirty(second);
    expect(await answer(confirmWrite(a.ticket, 0), 0)).toBe('unavailable');
    expect(await answer(confirmWrite(b.ticket, 0), 0)).toBe('pending');
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 0 }), 0)).toBe('unavailable');
    expect(old.setCarries(old.setOf(guildId)!)?.map(fate => fate.outcome())).toEqual(['carried', 'kept']);
  });

  it('drops a carry a quiesced manager adopts', async () => {
    const { guildId, options } = await storeGuild();
    const tracked = saveDataTracked('a.json', options, { a: 1 });
    if (tracked.outcome !== 'saved') throw new Error(`the write was not accepted: ${tracked.outcome}`);
    const old = getWorkingSet()!;
    const carry = old.exportDirty([guildId]);
    old.quiesce();
    const store = new FakeStore();
    store.isReadOnly = () => true;
    const held = initWorkingSet(store);
    held.quiesce();
    held.adoptDirty(carry);
    expect(carry[0].fate.outcome()).toBe('dropped');
    expect(await answer(confirmWrite(tracked.ticket, 0), 0)).toBe('unavailable');
  });

  it('answers unavailable once the carry a write was forwarded into is dropped', async () => {
    const { guildId, options } = await storeGuild();
    const tracked = saveDataTracked('a.json', options, { a: 1 });
    if (tracked.outcome !== 'saved') throw new Error(`the write was not accepted: ${tracked.outcome}`);
    const { manager: m2 } = recycle(getWorkingSet()!, guildId, { value: true });
    const readOnly = { value: true };
    const { manager: m3 } = recycle(m2, guildId, readOnly);
    expect(await answer(confirmWrite(tracked.ticket, 0), 0)).toBe('pending');
    readOnly.value = false;
    expect(await m3.hydrate(guildId, tokenFor())).toBe('ready');
    expect(await answer(confirmWrite(tracked.ticket, 0), 0)).toBe('unavailable');
  });

  it('keeps an applied carry while a batch built before it commits, and lands it with the next', async () => {
    const { guildId, options } = await storeGuild();
    const tracked = saveDataTracked('a.json', options, { a: 1 });
    if (tracked.outcome !== 'saved') throw new Error(`the write was not accepted: ${tracked.outcome}`);
    const old = getWorkingSet()!;
    const carry = old.exportDirty([guildId]);
    old.quiesce();
    const after = new FakeStore();
    const successor = initWorkingSet(after);
    expect(await successor.hydrate(guildId, tokenFor())).toBe('ready');
    after.holding = true;
    expect(saveData('x.json', options, { x: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(after.flushesSent).toBe(1);
    successor.adoptDirty(carry);
    after.holding = false;
    after.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(after.doc(guildId, 'x.json')).toBe(JSON.stringify({ x: 1 }, null, 2));
    expect(after.doc(guildId, 'a.json')).toBeUndefined();
    expect(carry[0].fate.outcome()).toBe('kept');
    expect(await answer(confirmWrite(tracked.ticket, 0), 0)).toBe('pending');
    await vi.advanceTimersByTimeAsync(600);
    expect(after.doc(guildId, 'a.json')).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(carry[0].fate.outcome()).toBe('landed');
  });

  it('answers unavailable from flushGuildOutcome for a set recycled away during its wait that took a write after its export', async () => {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    store.holding = true;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    const asked = flushGuildOutcome(guildId, 8000);
    await vi.advanceTimersByTimeAsync(0);
    store.mode = 'unavailable';
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(0);
    const carry = old.exportDirty([guildId]);
    expect(saveData('c.json', options, { c: 1 })).toBe(true);
    old.quiesce();
    const next = new FakeStore();
    next.isReadOnly = () => true;
    initWorkingSet(next).adoptDirty(carry);
    expect(await answer(asked, 8000)).toBe('unavailable');
  });

  it('never answers pending from flushGuildOutcome for a manager held during its wait, with no carry', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    const asked = flushGuildOutcome(guildId, 8000);
    await vi.advanceTimersByTimeAsync(0);
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.doc(guildId, 'a.json')).toBe(JSON.stringify({ a: 1 }, null, 2));
    getWorkingSet()!.quiesce();
    expect(await answer(asked, 8000)).not.toBe('pending');
  });
});

describe('delta round 5: a waiting carry bound to its copy, tombstones and append buffers on the wire', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('answers unavailable once the copy a carry waits for takes writes, before any prune runs (DR5-1)', async () => {
    const { guildId, options } = await storeGuild();
    const before = saveMark();
    const tracked = saveDataTracked('a.json', options, { a: 1 });
    if (tracked.outcome !== 'saved') throw new Error(`the write was not accepted: ${tracked.outcome}`);
    const readOnly = { value: true };
    recycle(getWorkingSet()!, guildId, readOnly);
    expect(await answer(confirmWrite(tracked.ticket, 0), 0)).toBe('pending');
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 0 }), 0)).toBe('pending');
    readOnly.value = false;
    expect(await answer(confirmWrite(tracked.ticket, 0), 0)).toBe('unavailable');
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 0 }), 0)).toBe('unavailable');
    expect(await answer(flushGuildOutcome(guildId, 0), 0)).toBe('unavailable');
  });

  it('keeps a carry applied to the set once its copy takes writes, until a batch built after it commits (DR5-1)', async () => {
    const { guildId, options } = await storeGuild();
    const tracked = saveDataTracked('a.json', options, { a: 1 });
    if (tracked.outcome !== 'saved') throw new Error(`the write was not accepted: ${tracked.outcome}`);
    const readOnly = { value: true };
    const { manager: m2, store: s2 } = recycle(getWorkingSet()!, guildId, readOnly);
    expect(await m2.hydrate(guildId, tokenFor())).toBe('ready');
    readOnly.value = false;
    expect(await answer(confirmWrite(tracked.ticket, 0), 0)).toBe('pending');
    await vi.advanceTimersByTimeAsync(600);
    expect(s2.doc(guildId, 'a.json')).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('answers an absent delete by the tombstone it found, so one on the wire at the export is unavailable (DR5-2)', async () => {
    const { guildId, store, options } = await storeGuild();
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    const old = getWorkingSet()!;
    store.holding = true;
    const first = deleteDataTracked('a.json', options);
    if (first.outcome !== 'deleted') throw new Error(`the delete was not accepted: ${first.outcome}`);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(2);
    const since = saveMark();
    expect(saveData('b.json', options, { b: 1 })).toBe(true);
    const again = deleteDataTracked('a.json', options);
    if (again.outcome !== 'absent' || !again.ticket) throw new Error(`the delete did not find the tombstone: ${again.outcome}`);
    expect(again.ticket.seq).toBe(first.ticket.seq);
    recycle(old, guildId, { value: true });
    store.mode = 'unavailable';
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.doc(guildId, 'a.json')).toBeDefined();
    expect(await answer(confirmWrite(first.ticket, 0), 0)).toBe('unavailable');
    expect(await answer(confirmWrite(again.ticket, 0), 0)).toBe('unavailable');
    expect(await answer(confirmSaved(guildId, { since, deadlineMs: 0 }), 0)).toBe('unavailable');
  });

  it('answers an absent delete ok once the batch holding its tombstone commits, before a later write lands (DR5-2)', async () => {
    const { guildId, store, options } = await storeGuild();
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    store.holding = true;
    expect(deleteDataTracked('a.json', options).outcome).toBe('deleted');
    await vi.advanceTimersByTimeAsync(600);
    expect(saveData('b.json', options, { b: 1 })).toBe(true);
    const again = deleteDataTracked('a.json', options);
    if (again.outcome !== 'absent' || !again.ticket) throw new Error(`the delete did not find the tombstone: ${again.outcome}`);
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.doc(guildId, 'a.json')).toBeUndefined();
    expect(store.doc(guildId, 'b.json')).toBeUndefined();
    expect(await answer(confirmWrite(again.ticket, 0), 0)).toBe('ok');
  });

  it('answers unavailable, conservatively, for a since between a write on the wire and a carried write of one set (DR5-3, a limit)', async () => {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    store.holding = true;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    const since = saveMark();
    const b = saveDataTracked('b.json', options, { b: 1 });
    if (b.outcome !== 'saved') throw new Error(`the write was not accepted: ${b.outcome}`);
    recycle(old, guildId, { value: true });
    store.mode = 'unavailable';
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(await answer(confirmWrite(b.ticket, 0), 0)).toBe('pending');
    expect(await answer(confirmSaved(guildId, { since, deadlineMs: 0 }), 0)).toBe('unavailable');
  });

  it('lands a carried append applied onto a buffer on the wire after that buffer, once (DR5-4)', async () => {
    const { guildId, options } = await storeGuild();
    expect(appendData('log.jsonl', options, 'carried\n')).toBe(true);
    const old = getWorkingSet()!;
    const carry = old.exportDirty([guildId]);
    old.quiesce();
    const after = new FakeStore();
    const successor = initWorkingSet(after);
    expect(await successor.hydrate(guildId, tokenFor())).toBe('ready');
    after.holding = true;
    expect(appendData('log.jsonl', options, 'newer\n')).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(after.flushesSent).toBe(1);
    expect(appendData('log.jsonl', options, 'later\n')).toBe(true);
    successor.adoptDirty(carry);
    after.holding = false;
    after.release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(after.streams.get(`${guildId}|m/log.jsonl`)).toBe('newer\ncarried\nlater\n');
    expect(carry[0].fate.outcome()).toBe('landed');
  });

  it('carries an append buffer whole, its start on the wire too, so a failed old batch\'s lines land once (delta round 6)', async () => {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    store.holding = true;
    expect(appendData('log.jsonl', options, 'x\n')).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    expect(appendData('log.jsonl', options, 'y\n')).toBe(true);
    const carry = old.exportDirty([guildId]);
    expect(carry[0].appends.map(append => append.chunk)).toEqual(['x\ny\n']);
    old.quiesce();
    store.mode = 'unavailable';
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(0);
    store.mode = 'commit';
    const successor = initWorkingSet(store);
    expect(await successor.hydrate(guildId, tokenFor())).toBe('ready');
    successor.adoptDirty(carry);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.streams.get(`${guildId}|m/log.jsonl`)).toBe('x\ny\n');
  });

  it('carries a whole append buffer again once the batch that held its start failed (DR5-4)', async () => {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    store.holding = true;
    expect(appendData('log.jsonl', options, 'x\n')).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    store.mode = 'unavailable';
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(appendData('log.jsonl', options, 'y\n')).toBe(true);
    expect(old.exportDirty([guildId])[0].appends.map(append => append.chunk)).toEqual(['x\ny\n']);
  });

  it('carries every append taken after a batch committed (DR5-4)', async () => {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    expect(appendData('log.jsonl', options, 'x\n')).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.streams.get(`${guildId}|m/log.jsonl`)).toBe('x\n');
    expect(appendData('log.jsonl', options, 'y\n')).toBe(true);
    expect(old.exportDirty([guildId])[0].appends.map(append => append.chunk)).toEqual(['y\n']);
  });

  it('carries the dirty writes of a set reclaimed while frozen, since no batch of it is on the wire then', async () => {
    const { guildId, store, options } = await storeGuild();
    const ws = getWorkingSet()!;
    const tracked = saveDataTracked('a.json', options, { a: 1 });
    if (tracked.outcome !== 'saved') throw new Error(`the write was not accepted: ${tracked.outcome}`);
    store.mode = 'unavailable';
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    ws.freezeRetained(guildId);
    const reclaimed = ws.hydrate(guildId, tokenFor());
    const carry = ws.exportDirty([guildId]);
    ws.quiesce();
    const next = new FakeStore();
    next.isReadOnly = () => true;
    initWorkingSet(next).adoptDirty(carry);
    expect(carry[0]?.docs.map(doc => doc.key)).toEqual(['m/a.json']);
    expect(await answer(confirmWrite(tracked.ticket, 0), 0)).toBe('pending');
    await reclaimed;
  });

  it('answers unavailable from flushGuildOutcome when only the later of two exports during its wait is adopted', async () => {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    store.holding = true;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    const asked = flushGuildOutcome(guildId, 8000);
    await vi.advanceTimersByTimeAsync(0);
    store.mode = 'unavailable';
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(0);
    old.exportDirty([guildId]);
    expect(saveData('b.json', options, { b: 1 })).toBe(true);
    const second = old.exportDirty([guildId]);
    old.quiesce();
    const next = new FakeStore();
    next.isReadOnly = () => true;
    initWorkingSet(next).adoptDirty(second);
    expect(old.setCarries(old.setOf(guildId)!)?.map(fate => fate.outcome())).toEqual(['carried', 'kept']);
    expect(await answer(asked, 8000)).toBe('unavailable');
  });

  it('leaves a carry that ended at or below the set\'s landed writes out of its carries', async () => {
    const { guildId, options } = await storeGuild();
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    const old = getWorkingSet()!;
    expect(old.exportDirty([guildId])).toEqual([]);
    expect(saveData('b.json', options, { b: 1 })).toBe(true);
    const carry = old.exportDirty([guildId]);
    old.quiesce();
    const next = new FakeStore();
    next.isReadOnly = () => true;
    initWorkingSet(next).adoptDirty(carry);
    expect(old.setCarries(old.setOf(guildId)!)?.map(fate => fate.outcome())).toEqual(['kept']);
  });

  it('keeps a carry dropped when a manager quiesced during its hydrate applies it', async () => {
    const { guildId, options } = await storeGuild();
    const tracked = saveDataTracked('a.json', options, { a: 1 });
    if (tracked.outcome !== 'saved') throw new Error(`the write was not accepted: ${tracked.outcome}`);
    const old = getWorkingSet()!;
    const carry = old.exportDirty([guildId]);
    old.quiesce();
    const copy = new FakeStore();
    copy.isReadOnly = () => true;
    const next = initWorkingSet(copy);
    next.adoptDirty(carry);
    const hydrating = next.hydrate(guildId, tokenFor());
    next.quiesce();
    expect(await hydrating).toBe('ready');
    expect(carry[0].fate.outcome()).toBe('dropped');
    expect(await answer(confirmWrite(tracked.ticket, 0), 0)).toBe('unavailable');
  });

  it('reads the copy a carry was adopted for, after its manager is retargeted', async () => {
    const { guildId, options } = await storeGuild();
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    const old = getWorkingSet()!;
    const carry = old.exportDirty([guildId]);
    old.quiesce();
    const copy = new FakeStore();
    copy.isReadOnly = () => true;
    const next = initWorkingSet(copy);
    next.adoptDirty(carry);
    next.retargetBackend(new FakeStore());
    expect(carry[0].fate.outcome()).toBe('kept');
    expect(next.dirtyGuildIds()).toEqual([guildId]);
  });

  it('answers an absent delete of a stream by the delete that tombstoned it (DR5-2)', async () => {
    const { options } = await storeGuild();
    expect(appendData('log.jsonl', options, 'x\n')).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    const first = deleteDataTracked('log.jsonl', options);
    if (first.outcome !== 'deleted') throw new Error(`the delete was not accepted: ${first.outcome}`);
    const again = deleteDataTracked('log.jsonl', options);
    if (again.outcome !== 'absent' || !again.ticket) throw new Error(`the delete did not find the tombstone: ${again.outcome}`);
    expect(again.ticket.seq).toBe(first.ticket.seq);
    expect(await answer(confirmWrite(again.ticket, 0), 0)).toBe('pending');
  });

  it('answers an absent delete of a carried tombstone by the carry that brought it (DR5-2)', async () => {
    const { guildId, options } = await storeGuild();
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(deleteDataTracked('a.json', options).outcome).toBe('deleted');
    const old = getWorkingSet()!;
    const carry = old.exportDirty([guildId]);
    old.quiesce();
    const successor = initWorkingSet(new FakeStore());
    expect(await successor.hydrate(guildId, tokenFor())).toBe('ready');
    successor.adoptDirty(carry);
    const again = deleteDataTracked('a.json', options);
    if (again.outcome !== 'absent' || !again.ticket) throw new Error(`the delete did not find the tombstone: ${again.outcome}`);
    expect(await answer(confirmWrite(again.ticket, 0), 0)).toBe('pending');
  });
});

describe('delta round 6: a fence after the export, and the reply gate\'s lower writes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('answers a carried write by its carry once the set\'s batch on the wire is deposed, and that batch\'s write unavailable (DR6-1, DR7-1)', async () => {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    store.holding = true;
    const a = saveDataTracked('a.json', options, { a: 1 });
    if (a.outcome !== 'saved') throw new Error(`the write was not accepted: ${a.outcome}`);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    const b = saveDataTracked('b.json', options, { b: 1 });
    if (b.outcome !== 'saved') throw new Error(`the write was not accepted: ${b.outcome}`);
    const readOnly = { value: true };
    const { manager: m2, store: s2 } = recycle(old, guildId, readOnly);
    store.mode = 'deposed';
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(old.stateOf(guildId)).toBe('fenced');
    expect(await answer(confirmWrite(a.ticket, 0), 0)).toBe('unavailable');
    expect(await answer(confirmWrite(b.ticket, 0), 0)).toBe('pending');
    expect(await m2.hydrate(guildId, tokenFor())).toBe('ready');
    readOnly.value = false;
    await vi.advanceTimersByTimeAsync(600);
    expect(s2.doc(guildId, 'b.json')).toBe(JSON.stringify({ b: 1 }, null, 2));
  });

  it('judges every write of a set in the reply gate\'s ledger, one on the wire at the export below a carried one included (DR6-2)', async () => {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    const ledger = openLedger('panel');
    store.holding = true;
    runInLedger(ledger, 'm', () => expect(saveData('a.json', options, { a: 1 })).toBe(true));
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    runInLedger(ledger, 'm', () => expect(saveData('b.json', options, { b: 1 })).toBe(true));
    recycle(old, guildId, { value: true });
    store.mode = 'unavailable';
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.doc(guildId, 'a.json')).toBeUndefined();
    expect(await answer(confirmSaved(guildId, { since: ledger.openedMark, deadlineMs: 0 }), 0)).toBe('unavailable');
    expect(await answer(verdictOf([ledger]), 8000)).toMatchObject({ ok: false, answer: 'unavailable' });
  });

  it('judges an absent delete below the set\'s latest write in the reply gate\'s ledger (DR6-2)', async () => {
    const { guildId, store, options } = await storeGuild();
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    const old = getWorkingSet()!;
    store.holding = true;
    expect(deleteDataTracked('a.json', options).outcome).toBe('deleted');
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(2);
    const ledger = openLedger('panel');
    runInLedger(ledger, 'm', () => {
      expect(saveData('b.json', options, { b: 1 })).toBe(true);
      expect(deleteDataTracked('a.json', options).outcome).toBe('absent');
    });
    recycle(old, guildId, { value: true });
    store.mode = 'unavailable';
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(await answer(verdictOf([ledger]), 8000)).toMatchObject({ ok: false, answer: 'unavailable' });
  });

  it('keeps a ledger entry\'s lowest unlanded seq, and starts it again once every write it held landed (DR6-2)', () => {
    const set = { landedSeq: 3 };
    const ticket = (seq: number) => ({ kind: 'ws', set, guildId: 'g', seq }) as never;
    const ledger = openLedger('panel');
    ledger.noteTicket(ticket(5), 'm');
    ledger.noteTicket(ticket(4), 'm');
    ledger.noteTicket(ticket(2), 'm');
    expect(ledger.tickets()).toMatchObject([{ from: 4 }]);
    set.landedSeq = 5;
    ledger.noteTicket(ticket(7), 'm');
    expect(ledger.tickets()).toMatchObject([{ from: 7 }]);
  });
});

describe('delta round 7: a set fenced after its export answers through its carries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  /** A guild hydrated on a store that holds its batches on the wire until released, with its manager. */
  async function heldGuild(): Promise<Awaited<ReturnType<typeof storeGuild>> & { old: WorkingSetManager }> {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    store.holding = true;
    return { guildId, store, old, options };
  }

  /**
   * The old batch comes back deposed, and the successor hydrates the guild before its copy takes writes, as a node
   * leased the guild again would (the copy's hydrate takes no claim, here and in production). That is the rare path:
   * usually another node holds the lease, the adoption waits unapplied and the prune drops it (DR10-C1; the usual
   * path's row follows the first of these).
   */
  async function deposeThenLand(store: FakeStore, old: WorkingSetManager, guildId: string, next: { manager: WorkingSetManager; store: FakeStore }, readOnly: { value: boolean }, before: () => Promise<void>): Promise<void> {
    store.mode = 'deposed';
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(old.stateOf(guildId)).toBe('fenced');
    await before();
    expect(await next.manager.hydrate(guildId, tokenFor())).toBe('ready');
    readOnly.value = false;
    await vi.advanceTimersByTimeAsync(600);
  }

  it('answers an append in the batch on the wire unavailable once that batch is deposed after the export, in the reply gate too, and the successor lands it (DR7-1)', async () => {
    const { guildId, store, old, options } = await heldGuild();
    const ledger = openLedger('panel');
    const x = runInLedger(ledger, 'm', () => appendDataTracked('log.jsonl', options, 'x\n'));
    if (x.outcome !== 'appended') throw new Error(`the append was not accepted: ${x.outcome}`);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    const y = appendDataTracked('log.jsonl', options, 'y\n');
    if (y.outcome !== 'appended') throw new Error(`the append was not accepted: ${y.outcome}`);
    const readOnly = { value: true };
    const next = recycle(old, guildId, readOnly);
    await deposeThenLand(store, old, guildId, next, readOnly, async () => {
      expect(await answer(confirmWrite(x.ticket, 0), 0)).toBe('unavailable');
      expect(await answer(confirmWrite(y.ticket, 0), 0)).toBe('pending');
      expect(await answer(verdictOf([ledger]), 8000)).toMatchObject({ ok: false, answer: 'unavailable' });
    });
    expect(next.store.streams.get(`${guildId}|m/log.jsonl`)).toBe('x\ny\n');
  });

  it('answers the carried append pending, then unavailable once the prune drops it, on the usual path where the guild is not served here again, in the reply gate too, and stores nothing (DR10-C1, DR11-C2)', async () => {
    const { guildId, store, old, options } = await heldGuild();
    const x = appendDataTracked('log.jsonl', options, 'x\n');
    if (x.outcome !== 'appended') throw new Error(`the append was not accepted: ${x.outcome}`);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    const ledger = openLedger('panel');
    const y = runInLedger(ledger, 'm', () => appendDataTracked('log.jsonl', options, 'y\n'));
    if (y.outcome !== 'appended') throw new Error(`the append was not accepted: ${y.outcome}`);
    const readOnly = { value: true };
    const next = recycle(old, guildId, readOnly);
    store.mode = 'deposed';
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(old.stateOf(guildId)).toBe('fenced');
    expect(await answer(confirmWrite(x.ticket, 0), 0)).toBe('unavailable');
    expect(await answer(confirmWrite(y.ticket, 0), 0)).toBe('pending');
    // Another node holds the guild, so no hydrate here applies the carry; the copy takes writes and the prune drops it.
    readOnly.value = false;
    await vi.advanceTimersByTimeAsync(600);
    expect(next.manager.dirtyGuildIds()).not.toContain(guildId);
    expect(await answer(confirmWrite(y.ticket, 0), 0)).toBe('unavailable');
    expect(await answer(verdictOf([ledger]), 8000)).toMatchObject({ ok: false, answer: 'unavailable' });
    expect(next.store.streams.get(`${guildId}|m/log.jsonl`)).toBeUndefined();
  });

  it('answers a document in the batch on the wire unavailable once that batch is deposed after the export, when its later version is carried (DR7-1)', async () => {
    const { guildId, store, old, options } = await heldGuild();
    const v1 = saveDataTracked('a.json', options, { n: 1 });
    if (v1.outcome !== 'saved') throw new Error(`the write was not accepted: ${v1.outcome}`);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    const v2 = saveDataTracked('a.json', options, { n: 2 });
    if (v2.outcome !== 'saved') throw new Error(`the write was not accepted: ${v2.outcome}`);
    const readOnly = { value: true };
    const next = recycle(old, guildId, readOnly);
    await deposeThenLand(store, old, guildId, next, readOnly, async () => {
      expect(await answer(confirmWrite(v1.ticket, 0), 0)).toBe('unavailable');
      expect(await answer(confirmWrite(v2.ticket, 0), 0)).toBe('pending');
    });
    expect(next.store.doc(guildId, 'a.json')).toBe(JSON.stringify({ n: 2 }, null, 2));
  });

  it('answers unavailable when confirm\'s own flush is the batch deposed after the export (DR7-1)', async () => {
    const { guildId, store, old, options } = await heldGuild();
    const x = appendDataTracked('log.jsonl', options, 'x\n');
    if (x.outcome !== 'appended') throw new Error(`the append was not accepted: ${x.outcome}`);
    const told = confirmWrite(x.ticket, 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.flushesSent).toBe(1);
    // A later write leaves the set dirty at the drain, so boot.ts exports it (DR8-T2).
    expect(appendData('log.jsonl', options, 'y\n')).toBe(true);
    const readOnly = { value: true };
    const next = recycle(old, guildId, readOnly);
    await deposeThenLand(store, old, guildId, next, readOnly, async () => {
      expect(await answer(told, 5000)).toBe('unavailable');
    });
    expect(next.store.streams.get(`${guildId}|m/log.jsonl`)).toBe('x\ny\n');
  });

  it('answers unavailable from flushGuildOutcome waiting on a batch deposed after the export (DR7-1)', async () => {
    const { guildId, store, old, options } = await heldGuild();
    expect(appendData('log.jsonl', options, 'x\n')).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    const told = flushGuildOutcome(guildId, 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(appendData('log.jsonl', options, 'y\n')).toBe(true);
    const readOnly = { value: true };
    const next = recycle(old, guildId, readOnly);
    await deposeThenLand(store, old, guildId, next, readOnly, async () => {
      expect(await answer(told, 5000)).toBe('unavailable');
    });
    expect(next.store.streams.get(`${guildId}|m/log.jsonl`)).toBe('x\ny\n');
  });

  it('answers unavailable from flushGuildOutcome whose own flush is the batch deposed after the export (DR7-1)', async () => {
    const { guildId, store, old, options } = await heldGuild();
    expect(appendData('log.jsonl', options, 'x\n')).toBe(true);
    const told = flushGuildOutcome(guildId, 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.flushesSent).toBe(1);
    expect(appendData('log.jsonl', options, 'y\n')).toBe(true);
    const readOnly = { value: true };
    const next = recycle(old, guildId, readOnly);
    await deposeThenLand(store, old, guildId, next, readOnly, async () => {
      expect(await answer(told, 5000)).toBe('unavailable');
    });
    expect(next.store.streams.get(`${guildId}|m/log.jsonl`)).toBe('x\ny\n');
  });

  it('still answers deposed for a set fenced with no export (DR7-1)', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    const a = saveDataTracked('a.json', options, { a: 1 });
    if (a.outcome !== 'saved') throw new Error(`the write was not accepted: ${a.outcome}`);
    await vi.advanceTimersByTimeAsync(600);
    const told = flushGuildOutcome(guildId, 5000);
    await vi.advanceTimersByTimeAsync(0);
    store.mode = 'deposed';
    store.holding = false;
    store.release();
    expect(await answer(told, 5000)).toBe('deposed');
    expect(await answer(confirmWrite(a.ticket, 0), 0)).toBe('deposed');
  });
});

describe('delta round 8: a set that left answers for none of its writes, whatever its flush answers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('answers unavailable from flushGuildOutcome whose own batch commits on the old store after a recycle that exported nothing (DR8-1)', async () => {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    const before = saveMark();
    store.holding = true;
    const a = saveDataTracked('a.json', options, { a: 1 });
    if (a.outcome !== 'saved') throw new Error(`the write was not accepted: ${a.outcome}`);
    const told = flushGuildOutcome(guildId, 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.flushesSent).toBe(1);
    // boot.ts exports no set whose writes are all on the wire: it only quiesces it.
    old.quiesce();
    initWorkingSet(new FakeStore());
    store.holding = false;
    store.release();
    expect(await answer(told, 5000)).toBe('unavailable');
    expect(store.doc(guildId, 'a.json')).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(await answer(confirmWrite(a.ticket, 0), 0)).toBe('unavailable');
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 0 }), 0)).toBe('unavailable');
  });

  it('answers unavailable from flushGuildOutcome whose own batch commits on the old store after the export (DR8-1)', async () => {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    store.holding = true;
    expect(appendData('log.jsonl', options, 'x\n')).toBe(true);
    const told = flushGuildOutcome(guildId, 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.flushesSent).toBe(1);
    expect(appendData('log.jsonl', options, 'y\n')).toBe(true);
    const readOnly = { value: true };
    const next = recycle(old, guildId, readOnly);
    store.holding = false;
    store.release();
    expect(await answer(told, 5000)).toBe('unavailable');
    expect(store.streams.get(`${guildId}|m/log.jsonl`)).toBe('x\n');
    expect(await next.manager.hydrate(guildId, tokenFor())).toBe('ready');
    readOnly.value = false;
    await vi.advanceTimersByTimeAsync(600);
    expect(next.store.streams.get(`${guildId}|m/log.jsonl`)).toBe('x\ny\n');
  });

  it('still answers ok from flushGuildOutcome whose own batch commits on a set that stayed (DR8-1)', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    const told = flushGuildOutcome(guildId, 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.flushesSent).toBe(1);
    store.holding = false;
    store.release();
    expect(await answer(told, 5000)).toBe('ok');
  });

  it('answers unavailable from flushGuildOutcome whose own flush outlives its deadline after the set left (DR8-1)', async () => {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    store.holding = true;
    expect(appendData('log.jsonl', options, 'x\n')).toBe(true);
    const told = flushGuildOutcome(guildId, 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.flushesSent).toBe(1);
    old.quiesce();
    initWorkingSet(new FakeStore());
    expect(await answer(told, 100)).toBe('unavailable');
    store.holding = false;
    store.release();
  });

  it('answers unavailable from confirm whose own flush outlives its deadline after the set left (DR8-1)', async () => {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    store.holding = true;
    const a = saveDataTracked('a.json', options, { a: 1 });
    if (a.outcome !== 'saved') throw new Error(`the write was not accepted: ${a.outcome}`);
    const told = confirmWrite(a.ticket, 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.flushesSent).toBe(1);
    old.quiesce();
    initWorkingSet(new FakeStore());
    expect(await answer(told, 100)).toBe('unavailable');
    store.holding = false;
    store.release();
  });

  it('answers unavailable from flushGuildOutcome whose own flush is refused after its set was evicted (DR8-1)', async () => {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    store.holding = true;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    const told = flushGuildOutcome(guildId, 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.flushesSent).toBe(1);
    old.evict(guildId);
    store.mode = 'unavailable';
    store.holding = false;
    store.release();
    expect(await answer(told, 5000)).toBe('unavailable');
  });

  it('answers deposed from confirmWrite, and unavailable from confirmSaved, for a set recycled away with no export once its batch on the wire is deposed (DR8-T2, DR9-T2)', async () => {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    const before = saveMark();
    store.holding = true;
    const a = saveDataTracked('a.json', options, { a: 1 });
    if (a.outcome !== 'saved') throw new Error(`the write was not accepted: ${a.outcome}`);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    old.quiesce();
    initWorkingSet(new FakeStore());
    store.mode = 'deposed';
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(old.stateOf(guildId)).toBe('fenced');
    expect(await answer(confirmWrite(a.ticket, 0), 0)).toBe('deposed');
    // Its lost mark was taken at the quiesce, before the batch came back, and holds no carry.
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 0 }), 0)).toBe('unavailable');
  });
});

describe('gates_r7: the carry\'s prune and an append buffer\'s sent length', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('keeps a pruned carry dropped once its copy turns read-only again', async () => {
    const { guildId, options } = await storeGuild();
    const before = saveMark();
    const tracked = saveDataTracked('a.json', options, { a: 1 });
    if (tracked.outcome !== 'saved') throw new Error(`the write was not accepted: ${tracked.outcome}`);
    const readOnly = { value: true };
    recycle(getWorkingSet()!, guildId, readOnly);
    expect(await answer(confirmWrite(tracked.ticket, 0), 0)).toBe('pending');
    readOnly.value = false;
    expect(await answer(flushGuildOutcome(guildId, 0), 0)).toBe('unavailable');
    readOnly.value = true;
    expect(await answer(confirmWrite(tracked.ticket, 0), 0)).toBe('unavailable');
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 0 }), 0)).toBe('unavailable');
  });

  /** A carried append exported from one manager, and a successor serving the guild on its own store. */
  async function carriedAppend(): Promise<{ guildId: string; options: { guildId: string; category: string }; carry: DirtyCarry[]; successor: WorkingSetManager; after: FakeStore }> {
    const { guildId, options } = await storeGuild();
    expect(appendData('log.jsonl', options, 'carried\n')).toBe(true);
    const old = getWorkingSet()!;
    const carry = old.exportDirty([guildId]);
    old.quiesce();
    const after = new FakeStore();
    const successor = initWorkingSet(after);
    expect(await successor.hydrate(guildId, tokenFor())).toBe('ready');
    return { guildId, options, carry, successor, after };
  }

  it('applies a carried append ahead of the appends taken while a batch that committed was on the wire', async () => {
    const { guildId, options, carry, successor, after } = await carriedAppend();
    after.holding = true;
    expect(appendData('log.jsonl', options, 'first\n')).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(after.flushesSent).toBe(1);
    expect(appendData('log.jsonl', options, 'z\n')).toBe(true);
    after.holding = false;
    after.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(after.streams.get(`${guildId}|m/log.jsonl`)).toBe('first\n');
    successor.adoptDirty(carry);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(after.streams.get(`${guildId}|m/log.jsonl`)).toBe('first\ncarried\nz\n');
  });

  it('applies a carried append ahead of a buffer whose batch was refused', async () => {
    const { guildId, options, carry, successor, after } = await carriedAppend();
    after.holding = true;
    expect(appendData('log.jsonl', options, 'x\n')).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(after.flushesSent).toBe(1);
    after.mode = 'unavailable';
    after.holding = false;
    after.release();
    await vi.advanceTimersByTimeAsync(0);
    after.mode = 'commit';
    successor.adoptDirty(carry);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(after.streams.get(`${guildId}|m/log.jsonl`)).toBe('carried\nx\n');
  });
});

describe('delta round 9: the successor check asks the set its flush answered for', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  /**
   * The guild's set evicted while a batch of it is on the wire, a replacement read on the same manager taking one write,
   * and a recycle carrying that write to a successor that keeps it: the carry holds the replacement's write only.
   */
  async function replacedThenRecycled(guildId: string, options: { guildId: string; category: string }): Promise<void> {
    const old = getWorkingSet()!;
    old.evict(guildId);
    expect(await old.hydrate(guildId, tokenFor())).toBe('ready');
    expect(saveData('b.json', options, { b: 1 })).toBe(true);
    recycle(old, guildId, { value: true });
  }

  it('answers unavailable from flushGuildOutcome whose own flush is refused after its set was replaced and the replacement exported (DR9-1)', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    const told = flushGuildOutcome(guildId, 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.flushesSent).toBe(1);
    await replacedThenRecycled(guildId, options);
    store.mode = 'unavailable';
    store.holding = false;
    store.release();
    expect(await answer(told, 5000)).toBe('unavailable');
  });

  it('answers unavailable from flushGuildOutcome whose own batch commits after its set was replaced and the replacement exported (DR9-1)', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    const told = flushGuildOutcome(guildId, 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.flushesSent).toBe(1);
    await replacedThenRecycled(guildId, options);
    store.holding = false;
    store.release();
    expect(await answer(told, 5000)).toBe('unavailable');
    expect(store.doc(guildId, 'a.json')).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('answers unavailable from flushGuildOutcome waiting on a batch of a set replaced, and the replacement exported, meanwhile (DR9-1)', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    const a = saveDataTracked('a.json', options, { a: 1 });
    if (a.outcome !== 'saved') throw new Error(`the write was not accepted: ${a.outcome}`);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    const told = flushGuildOutcome(guildId, 5000);
    await vi.advanceTimersByTimeAsync(0);
    await replacedThenRecycled(guildId, options);
    expect(await answer(told, 5000)).toBe('unavailable');
    expect(await answer(confirmWrite(a.ticket, 0), 0)).toBe('unavailable');
    store.holding = false;
    store.release();
  });

  it('answers for no write queued on the successor from flushGuildOutcome after a recycle left a batch on the wire, while confirmSaved answers unavailable (DR9-2)', async () => {
    const { guildId, store, options } = await storeGuild();
    const old = getWorkingSet()!;
    const before = saveMark();
    store.holding = true;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.flushesSent).toBe(1);
    // boot.ts exports no set whose writes are all on the wire: it only quiesces it.
    old.quiesce();
    initWorkingSet(new FakeStore());
    expect(await answer(flushGuildOutcome(guildId, 0), 0)).toBe('ok');
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 0 }), 0)).toBe('unavailable');
    store.mode = 'unavailable';
    store.holding = false;
    store.release();
  });

  it('answers unavailable, a weaker true answer, from flushGuildOutcome whose own batch commits after its set was evicted with no recycle, as a graveyard restore evicts it (DR9-T1, DR10-C2)', async () => {
    const { guildId, store, options } = await storeGuild();
    const manager = getWorkingSet()!;
    store.holding = true;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    const told = flushGuildOutcome(guildId, 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.flushesSent).toBe(1);
    manager.evict(guildId);
    store.holding = false;
    store.release();
    expect(await answer(told, 5000)).toBe('unavailable');
    expect(store.doc(guildId, 'a.json')).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(await manager.hydrate(guildId, tokenFor())).toBe('ready');
  });
});
