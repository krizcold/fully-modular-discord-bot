import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dropPendingForGuild } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { noteScopeRefusal, noteScopeTicket, pendingFor, setLeft } from '../../src/bot/internalSetup/utils/dataBackends/scopeRecord';
import { setBackendKind } from '../helpers/backendKind';
import {
  DataBackendUnavailableError,
  getWorkingSet,
  initWorkingSet,
  WorkingSetManager,
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
  saveData,
  saveDataTracked,
  saveGlobalData,
  saveGlobalModuleData,
  saveGuildData,
  saveMark,
  saveModuleData,
  writeRawAtomic,
  type SaveMark,
  type WriteTicket,
} from '../../src/bot/internalSetup/utils/dataManager';
import { landed, openLedger, runInLedger, runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { FakeStore, tokenFor, type FlushMode } from '../helpers/fakeStore';
import { freezeGuildWrites, unfreezeGuildWrites } from '../helpers/freezeGuild';
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
    setBackendKind('postgres');
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
    expect(pendingFor(guildId, before.stamp)).toEqual({ tickets: [], lost: [{ stamp: before.stamp + 1, deposed: false }], refused: [], pruned: false });
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 1000 }), 1000)).toBe('unavailable');
  });

  it('answers unavailable when a confirm throws', async () => {
    const guildId = freshGuild();
    const before = saveMark();
    const manager = { confirm: () => Promise.reject(new Error('the confirm failed')) };
    noteScopeTicket(guildId, { kind: 'ws', manager, set: { landedSeq: 0 }, guildId, seq: 1 } as unknown as WriteTicket);
    expect(await answer(confirmSaved(guildId, { since: before, deadlineMs: 1000 }), 1000)).toBe('unavailable');
  });

  it('answers held when the store refuses the commit, and ok once it heals', async () => {
    const { guildId, store, options } = await storeGuild();
    store.mode = 'unavailable';
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
    freezeGuildWrites(guildId);
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

  it.each(['commit', 'unavailable'] as FlushMode[])('flushGuildNow answers unavailable when its set is evicted during its own flush (store %s)', async mode => {
    const { guildId, store, options } = await storeGuild();
    const ws = getWorkingSet()!;
    store.holding = true;
    store.mode = mode;
    expect(saveData('a.json', options, { a: 1 })).toBe(true);
    expect(store.flushesSent).toBe(0);
    const asked = ws.flushGuildNow(guildId, 8000);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.flushesSent).toBe(1);
    ws.evict(guildId);
    store.holding = false;
    store.release();
    expect(await answer(asked, 8000)).toBe('unavailable');
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
    setBackendKind('postgres');
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

      // The guild's backend switches to the database: its file entries stay in its scope beside the set's.
      setBackendKind('postgres');
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

  it('notes every refusal (review round 1, D1): a frozen-retained set, a set not ready', async () => {
    const { guildId: frozen, options } = await storeGuild();
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
  | { op: 'hold' | 'release' | 'evict' | 'rehydrate' | 'mark' }
  | { op: 'confirm'; pick: number; deadline: number; wait: boolean };

const scopeOp: fc.Arbitrary<ScopeOp> = fc.oneof(
  { weight: 24, arbitrary: fc.record({ op: fc.constantFrom('save' as const, 'append' as const, 'delete' as const), key: fc.integer({ min: 0, max: 2 }) }) },
  { weight: 6, arbitrary: fc.record({ op: fc.constant('mode' as const), mode: fc.constantFrom<FlushMode>('commit', 'unavailable', 'deposed') }) },
  { weight: 12, arbitrary: fc.record({ op: fc.constant('tick' as const), ms: fc.constantFrom(0, 20, 600, 1600) }) },
  { weight: 6, arbitrary: fc.constant<ScopeOp>({ op: 'hold' }) },
  { weight: 6, arbitrary: fc.constant<ScopeOp>({ op: 'release' }) },
  { weight: 8, arbitrary: fc.constantFrom<ScopeOp>({ op: 'evict' }, { op: 'rehydrate' }) },
  { weight: 6, arbitrary: fc.constant<ScopeOp>({ op: 'mark' }) },
  { weight: 14, arbitrary: fc.record({ op: fc.constant('confirm' as const), pick: fc.nat(), deadline: fc.constantFrom(0, 30, 8000), wait: fc.boolean() }) },
);

async function runScope(ops: ScopeOp[]): Promise<void> {
  vi.useFakeTimers();
  const guildId = freshGuild();
  setBackendKind('postgres');
  const store = new FakeStore();
  const manager = initWorkingSet(store);
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
    manager.evict(guildId);
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
    const { guildId } = await storeGuild();
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
    const { guildId } = await storeGuild();
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

  it('answers unavailable for a refused document later rewritten whole, and ok for a refusal before the mark', async () => {
    const { guildId } = await storeGuild();
    const mark = saveMark();
    freezeGuildWrites(guildId);
    expect(saveData('a.json', { guildId, category: 'm' }, { a: 1 })).toBe(false);
    unfreezeGuildWrites(guildId);
    expect(saveData('a.json', { guildId, category: 'm' }, { a: 2 })).toBe(true);
    expect(await answer(confirmSaved(guildId, { since: mark, deadlineMs: 1000 }), 1000)).toBe('unavailable');
    expect(await answer(confirmSaved(guildId, { since: saveMark(), deadlineMs: 1000 }), 1000)).toBe('ok');
  });

  it('narrows refusals by category like file writes', async () => {
    const { guildId } = await storeGuild();
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

describe('a mark from another run', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
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

describe('absent deletes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
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
});

describe('a fenced set', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('answers deposed for a set fenced with its flush on the wire (DR7-1)', async () => {
    const { store, options } = await storeGuild();
    store.holding = true;
    const a = saveDataTracked('a.json', options, { a: 1 });
    if (a.outcome !== 'saved') throw new Error(`the write was not accepted: ${a.outcome}`);
    await vi.advanceTimersByTimeAsync(600);
    store.mode = 'deposed';
    store.holding = false;
    store.release();
    expect(await answer(confirmWrite(a.ticket, 5000), 5000)).toBe('deposed');
  });
});
