import { AsyncResource } from 'async_hooks';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken, GuildFlushBatch, RestoreOutcome, RestoreStop, RetireOutcome } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { initDataReadiness, type DataReadinessDriver } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { gateCauseNow } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { openLedger, runInLedger, runSealed, writesOf } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import {
  appendDataTracked,
  confirmWrite,
  deleteDataTracked,
  deleteGuildNamespace,
  drainForExit,
  guildDataOpOf,
  loadData,
  restoreGuildFromGraveyard,
  saveDataTracked,
  setGuildDataBackend,
  setOwnerInfoProvider,
  updateData,
  type WriteTicket,
} from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore } from '../helpers/fakeStore';
import { freshGuild } from '../helpers/gateRig';
import { batchExistsAnswer, isBatchExists, isFenced, isGraveInsert, scriptedPg } from '../helpers/nb11ScriptedPg';
import { LEASED } from '../helpers/readinessRig';

// NB11 tests 1 (wip-redesign/sheets/NB11.md): restoring a guild from the graveyard on Postgres, and deleting one, over
// a real WorkingSetManager and readiness driver; the backend's flush, retire and restore answers are scripted.

const SECOND = 1000;
const FLUSH_TEXT = "the server's unsaved changes are not confirmed saved yet; nothing was restored; try again in a moment";
const NOT_LOADED = "this server's data is not loaded in this bot process; nothing was restored; try again in a moment";
const ALREADY = 'a restore of this server is already running; nothing was restored; its answer comes within a minute';
const DELETE_RUNNING = "a delete of this server's data is running; nothing was restored; try again once it ends";
const DEPOSED = "another bot process now serves this server's data; nothing was restored";
const OUT_OF_TIME = 'the restore ran out of its 40 s before it could commit; nothing was restored; try again in a moment';
const NO_ENTRY = 'no graveyard entry for this guild';
const liveText = (r: number) => `live guild data exists; nothing was restored. To restore entry ${r}, delete this server's data, then restore with retiredAt ${r} before the bot saves anything new for the server; data it saves in between blocks the restore again. While the server's members are active, remove the bot from the server first and add it back after the restore.`;
const unknownText = (g: string, r: number) => `can't confirm whether server ${g} was restored: the database did not confirm the commit. Within a minute, if it was restored, the server's data is back and entry ${r} is gone from \`smdb graveyard list\`; if not, the entry is still listed, unless it had passed the graveyard's keep time (GRAVEYARD_TTL_DAYS, 14 days by default) and the graveyard sweep removed it, data and all. The list reads the data of the bot behind the web panel it asks; if the main database was replaced meanwhile, check once that bot runs on the new main.`;
const DELETE_FLUSH = "the server's unsaved changes are not confirmed saved yet; nothing was removed; try again in a moment";
const DELETE_ALREADY = "a delete of this server's data is already running; nothing was removed";
const RESTORE_RUNNING = 'a restore of this server from the graveyard is running; nothing was removed; try again once it ends';
const DELETE_TIMEOUT = 'the database did not finish the delete within its 40 s; nothing was removed; try again in a moment';
const DELETE_OUT_OF_TIME = 'the delete ran out of its 40 s before it could commit; nothing was removed; try again in a moment';
const DELETE_DEPOSED = "another bot process now serves this server's data; nothing was removed";
const DELETE_UNKNOWN = "can't confirm whether this server's data was deleted: the database did not confirm the commit. Within a minute, `smdb graveyard list` lists a new entry for this server with the reason webui-operator-delete if it was deleted; if no such entry is listed by then, it was not. The list reads the data of the bot behind the web panel it asks; if the main database was replaced meanwhile, check once that bot runs on the new main.";

type RestoreArgs = [guildId: string, retiredAt: number | null, token: FenceToken, beforeCommit: () => RestoreStop | null, deadline: bigint];
type RetireArgs = [guildId: string, reason: string, token: FenceToken, deadline?: bigint | null];

/** FakeStore with a graveyard: the retire moves a guild's rows into a batch and the restore moves one back, unless scripted. */
class ScriptedStore extends FakeStore {
  readonly graveyard = new Map<string, { retiredAt: number; reason: string; docs: Map<string, string>; streams: Map<string, string> }[]>();
  readonly order: string[] = [];
  readonly restoreCalls: RestoreArgs[] = [];
  readonly retireCalls: RetireArgs[] = [];
  restoreImpl: ((...args: RestoreArgs) => Promise<RestoreOutcome>) | null = null;
  retireImpl: ((...args: RetireArgs) => Promise<RetireOutcome>) | null = null;

  override async flushGuild(guildId: string, batch: GuildFlushBatch, token: FenceToken) {
    this.order.push('flush');
    return super.flushGuild(guildId, batch, token);
  }

  override async restoreGuild(...args: RestoreArgs): Promise<RestoreOutcome> {
    this.order.push('restore');
    this.restoreCalls.push(args);
    if (this.restoreImpl) return this.restoreImpl(...args);
    const [guildId, retiredAt, , beforeCommit] = args;
    const own = (row: string) => row.startsWith(`${guildId}|`);
    const batches = this.graveyard.get(guildId) ?? [];
    const batch = retiredAt === null ? batches[batches.length - 1] : batches.find(b => b.retiredAt === retiredAt);
    if (!batch) return { ok: false, reason: 'no-entry' };
    if ([...this.docs.keys(), ...this.streams.keys()].some(own)) return { ok: false, reason: 'live-rows', retiredAt: batch.retiredAt };
    const stop = beforeCommit();
    if (stop) return { ok: false, reason: stop };
    this.moveBack(guildId, batch);
    return { ok: true, moved: batch.docs.size + batch.streams.size, retiredAt: batch.retiredAt, reason: batch.reason };
  }

  /** The move of a committed restore: the batch's rows go live and leave the graveyard. */
  moveBack(guildId: string, batch: { docs: Map<string, string>; streams: Map<string, string> }): void {
    for (const [row, doc] of batch.docs) this.docs.set(row, doc);
    for (const [row, chunk] of batch.streams) this.streams.set(row, chunk);
    const batches = this.graveyard.get(guildId) ?? [];
    batches.splice(batches.indexOf(batch as never), 1);
  }

  override async retireGuild(...args: RetireArgs): Promise<RetireOutcome> {
    this.order.push('retire');
    this.retireCalls.push(args);
    if (this.retireImpl) return this.retireImpl(...args);
    return this.retireNow(args[0], args[1]);
  }

  retireNow(guildId: string, reason: string): RetireOutcome {
    const own = (row: string) => row.startsWith(`${guildId}|`);
    const docs = new Map([...this.docs].filter(([row]) => own(row)));
    const streams = new Map([...this.streams].filter(([row]) => own(row)));
    for (const row of docs.keys()) this.docs.delete(row);
    for (const row of streams.keys()) this.streams.delete(row);
    const list = this.graveyard.get(guildId) ?? [];
    const retiredAt = Date.now() + list.length;
    list.push({ retiredAt, reason, docs, streams });
    this.graveyard.set(guildId, list);
    return { ok: true, moved: docs.size + streams.size, retiredAt };
  }

  bury(guildId: string, retiredAt: number, docs: Record<string, unknown>): void {
    const list = this.graveyard.get(guildId) ?? [];
    list.push({ retiredAt, reason: 'webui-operator-delete', docs: new Map(Object.entries(docs).map(([f, v]) => [`${guildId}|m/${f}`, JSON.stringify(v)])), streams: new Map() });
    this.graveyard.set(guildId, list);
  }
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};
const opts = (guildId: string) => ({ guildId, category: 'm' });
const monoIn = (ms: number) => process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
const msLeft = (deadline: bigint) => Number(deadline - process.hrtime.bigint()) / 1e6;
const flushMicro = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

let drivers: DataReadinessDriver[] = [];
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

function setup(): { store: ScriptedStore; ws: WorkingSetManager; driver: DataReadinessDriver } {
  const store = new ScriptedStore();
  const ws = initWorkingSet(store);
  const driver = initDataReadiness(store, ws, { held: false });
  drivers.push(driver);
  driver.onLeaseChanged({ ...LEASED, claims: { 0: 7 } });
  setGuildDataBackend(store);
  setOwnerInfoProvider(() => ({ nodeId: 'node-a', processId: 'process-a', shardCount: 1, claimOf: () => 7 }));
  setBackendKind('postgres');
  return { store, ws, driver };
}

async function readyGuild(ws: WorkingSetManager, claim = 7): Promise<string> {
  const guildId = freshGuild();
  expect(await ws.hydrate(guildId, { nodeId: 'node-a', claim, processId: 'process-a', shardId: 0, shardCount: 1 })).toBe('ready');
  return guildId;
}

const restoreRequest = (guildId: string, retiredAt?: number, answerByMono?: string) => ({
  guildId, module: '', filename: '', op: 'restore-graveyard' as const,
  contentJson: JSON.stringify({ retiredAt }),
  ...(answerByMono === undefined ? {} : { answerByMono }),
});
const deleteRequest = (guildId: string, answerByMono?: string) => ({
  guildId, module: '', filename: '', op: 'delete-namespace' as const,
  ...(answerByMono === undefined ? {} : { answerByMono }),
});
const setOf = (ws: WorkingSetManager, guildId: string) => (ws as unknown as { sets: Map<string, unknown> }).sets.get(guildId);
const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(c => c.map(String).join(' '));

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setMaintenanceGate(null);
  for (const driver of drivers.splice(0)) driver.stop();
  setGuildDataBackend(null);
});

describe('writes accepted before the restore', () => {
  it('a write accepted before the restore is stored before the restore\'s transaction', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    const saved = saveDataTracked('a.json', opts(g), { v: 1 });
    expect(saved.outcome).toBe('saved');
    store.restoreImpl = async () => ({ ok: true, moved: 1, retiredAt: 5, reason: 'r' });
    const answer = await restoreGuildFromGraveyard(g, 5);
    expect(answer).toMatchObject({ ok: true, retiredAt: 5, reason: 'r', moved: 1 });
    expect(store.order).toEqual(['flush', 'restore']);
    expect(store.commits[0].batch.upserts).toEqual([{ key: { module: 'm', filename: 'a.json' }, doc: JSON.stringify({ v: 1 }, null, 2) }]);
    expect(await confirmWrite((saved as { ticket: WriteTicket }).ticket, 0)).toBe('ok');
  });
});

describe('writes while the restore runs', () => {
  it('a write during the restore is refused with the reason', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    const other = await readyGuild(ws);
    const hold = deferred<RestoreOutcome>();
    store.restoreImpl = () => hold.promise;
    const restoring = restoreGuildFromGraveyard(g, 5);
    await vi.waitFor(() => expect(store.restoreCalls).toHaveLength(1));
    warn.mockClear();
    const fn = vi.fn((v: unknown) => v);
    const ledger = openLedger('panel');
    const results = runInLedger(ledger, 'm', () => ({
      save: saveDataTracked('a.json', opts(g), { v: 2 }),
      append: appendDataTracked('l.jsonl', opts(g), 'x\n'),
      del: deleteDataTracked('a.json', opts(g)),
      update: updateData('b.json', opts(g), {}, fn),
    }));
    for (const result of Object.values(results)) expect(result).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(fn).not.toHaveBeenCalled();
    expect(lines(warn)).toEqual([
      `[Data] Write for guild ${g} refused: its data is being restored from the graveyard`,
      `[Data] Append for guild ${g} refused: its data is being restored from the graveyard`,
      `[Data] Delete for guild ${g} refused: its data is being restored from the graveyard`,
      `[Data] Update for guild ${g} refused: its data is being restored from the graveyard`,
    ]);
    expect(writesOf(ledger).refused).toBe(true);
    expect(saveDataTracked('a.json', opts(other), { v: 1 }).outcome).toBe('saved');
    hold.resolve({ ok: true, moved: 0, retiredAt: 5, reason: 'r' });
    await restoring;
  });

  it('a command that read before the restore cannot save over it', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    const gate = deferred<void>();
    const oldRun = runInLedger(openLedger('interaction'), 'm', async () => {
      const before = loadData('a.json', opts(g), { v: 'default' });
      await gate.promise;
      return {
        before,
        save: saveDataTracked('a.json', opts(g), { v: 'stale' }),
        update: updateData('a.json', opts(g), { v: 'default' }, () => ({ v: 'stale' })),
        del: deleteDataTracked('a.json', opts(g)),
        append: appendDataTracked('l.jsonl', opts(g), 'x\n'),
      };
    });
    store.bury(g, 5, { 'a.json': { v: 'restored' } });
    const reply = await applyOperatorDataWrite(restoreRequest(g, 5));
    expect(reply).toMatchObject({ ok: true, retiredAt: 5 });
    await vi.waitFor(() => expect(ws.stateOf(g)).toBe('ready'));
    warn.mockClear();
    gate.resolve();
    const r = await oldRun;
    expect(r.before).toEqual({ v: 'default' });
    expect(r.save).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(r.update).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(r.del).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(r.append.outcome).toBe('appended');
    expect(lines(warn)).toContain(`[Data] Write for guild ${g} refused: it comes from a command that started before the server's data was restored from the graveyard`);
    expect(loadData('a.json', opts(g), null)).toEqual({ v: 'restored' });
    const later = runInLedger(openLedger('interaction'), 'm', () => saveDataTracked('a.json', opts(g), { v: 'new' }));
    expect(later.outcome).toBe('saved');
  });

  it('after a restore answering live-rows, an older run\'s save is accepted', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    const gate = deferred<void>();
    const oldRun = runInLedger(openLedger('interaction'), 'm', async () => {
      await gate.promise;
      return saveDataTracked('a.json', opts(g), { v: 1 });
    });
    store.restoreImpl = async () => ({ ok: false, reason: 'live-rows', retiredAt: 5 });
    expect(await applyOperatorDataWrite(restoreRequest(g, 5))).toEqual({ ok: false, code: 'invalid', error: liveText(5) });
    gate.resolve();
    expect((await oldRun).outcome).toBe('saved');
  });

  it('a timer past its command\'s ledger is not held back', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    const interactionTick = runInLedger(openLedger('interaction'), 'm', () => AsyncResource.bind(() => saveDataTracked('t.json', opts(g), { n: 1 })));
    const panelTick = await runSealed('panel', null, 'm', async () => AsyncResource.bind(() => saveDataTracked('p.json', opts(g), { n: 1 })));
    store.bury(g, 5, { 'a.json': { v: 1 } });
    expect(await applyOperatorDataWrite(restoreRequest(g, 5))).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(ws.stateOf(g)).toBe('ready'));
    expect(interactionTick().outcome).toBe('refused');
    expect(panelTick().outcome).toBe('saved');
    const now = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(now + 16 * 60 * SECOND);
    expect(interactionTick().outcome).toBe('saved');
  });
});

describe('the flush before the transaction', () => {
  it('a flush the store refuses keeps the write, refuses the restore, and the write lands once the store recovers', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.mode = 'unavailable';
    const saved = saveDataTracked('a.json', opts(g), { v: 1 });
    expect(await restoreGuildFromGraveyard(g, 5)).toEqual({ ok: false, code: 'backend-unavailable', error: FLUSH_TEXT });
    expect(store.restoreCalls).toEqual([]);
    expect(ws.stateOf(g)).toBe('ready');
    expect(ws.dirtyGuildIds()).toContain(g);
    store.mode = 'commit';
    expect(await ws.flushGuildNow(g, SECOND)).toBe('ok');
    expect(store.doc(g, 'a.json')).toBe(JSON.stringify({ v: 1 }, null, 2));
    expect(await confirmWrite((saved as { ticket: WriteTicket }).ticket, 0)).toBe('ok');
  });

  it('a flush whose COMMIT landed without an answer keeps the write dirty, refuses the restore, and leaves the batch buried', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.bury(g, 5, { 'r.json': { r: 1 } });
    store.mode = 'landed-unavailable';
    const saved = saveDataTracked('a.json', opts(g), { v: 1 });
    expect(await restoreGuildFromGraveyard(g, 5)).toEqual({ ok: false, code: 'backend-unavailable', error: FLUSH_TEXT });
    expect(store.restoreCalls).toEqual([]);
    expect(store.doc(g, 'a.json')).toBe(JSON.stringify({ v: 1 }, null, 2));
    expect(ws.stateOf(g)).toBe('ready');
    expect(ws.dirtyGuildIds()).toContain(g);
    expect(store.graveyard.get(g)?.map(b => b.retiredAt)).toEqual([5]);
    expect(store.doc(g, 'r.json')).toBeUndefined();
    store.mode = 'commit';
    expect(await ws.flushGuildNow(g, SECOND)).toBe('ok');
    expect(store.doc(g, 'a.json')).toBe(JSON.stringify({ v: 1 }, null, 2));
    expect(ws.dirtyGuildIds()).not.toContain(g);
    expect(await confirmWrite((saved as { ticket: WriteTicket }).ticket, 0)).toBe('ok');
  });

  it('a flush still on the wire after 5 s refuses with the same text', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date', 'hrtime'] });
    store.holding = true;
    saveDataTracked('a.json', opts(g), { v: 1 });
    const restoring = restoreGuildFromGraveyard(g, 5);
    let answer: unknown;
    void restoring.then(value => { answer = value; });
    await vi.advanceTimersByTimeAsync(5 * SECOND + 50);
    expect(answer).toEqual({ ok: false, code: 'backend-unavailable', error: FLUSH_TEXT });
    expect(store.restoreCalls).toEqual([]);
    store.holding = false;
    store.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(store.doc(g, 'a.json')).toBe(JSON.stringify({ v: 1 }, null, 2));
  });

  it('a wall-clock step back does not stretch the flush wait (restore and delete)', async () => {
    const { store, ws } = setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date', 'hrtime'] });
    for (const op of ['restore', 'delete'] as const) {
      const g = await readyGuild(ws);
      store.holding = true;
      saveDataTracked('a.json', opts(g), { v: 1 });
      const running = op === 'restore' ? applyOperatorDataWrite(restoreRequest(g, 5)) : applyOperatorDataWrite(deleteRequest(g));
      let answer: any;
      void running.then(value => { answer = value; });
      await vi.advanceTimersByTimeAsync(10);
      vi.setSystemTime(Date.now() - 90 * SECOND);
      await vi.advanceTimersByTimeAsync(5 * SECOND + 50);
      expect(answer).toEqual({ ok: false, code: 'backend-unavailable', error: op === 'restore' ? FLUSH_TEXT : DELETE_FLUSH });
      expect(guildDataOpOf(g)).toBeUndefined();
      store.holding = false;
      store.release();
      await vi.advanceTimersByTimeAsync(100);
    }
  });
});

describe('a deposed flush or restore', () => {
  it('a deposed flush fences the set, counts once and drops the buffered events at once', async () => {
    const { store, ws, driver } = setup();
    const g = await readyGuild(ws);
    store.holding = true;
    saveDataTracked('a.json', opts(g), { v: 1 });
    const restoring = restoreGuildFromGraveyard(g, 5);
    await vi.waitFor(() => expect(store.flushesSent).toBeGreaterThan(0));
    const replay = vi.fn();
    expect(driver.admitEvent(g, replay)).toBe(false);
    store.mode = 'deposed';
    store.holding = false;
    store.release();
    expect(await restoring).toEqual({ ok: false, code: 'not-owner', error: DEPOSED });
    expect(ws.stateOf(g)).toBe('fenced');
    expect(() => saveDataTracked('a.json', opts(g), { v: 2 })).toThrow(expect.objectContaining({ causeKey: 'guild-fenced' }));
    await flushMicro();
    expect(replay).not.toHaveBeenCalled();
    expect(lines(warn).some(l => l.includes(`Dropping 1 buffered event(s) for guild ${g}`))).toBe(true);
    expect(lines(error).filter(l => l.includes('Deposed writer'))).toHaveLength(1);
    expect(ws.getCounters().fencedFlushRejections).toBe(1);
  });

  it('a deposed restore fences the set once, wakes its waiters not-ready and drops the buffered events at once', async () => {
    const { store, ws, driver } = setup();
    const g = await readyGuild(ws);
    const hold = deferred<RestoreOutcome>();
    store.restoreImpl = () => hold.promise;
    const restoring = restoreGuildFromGraveyard(g, 5);
    await vi.waitFor(() => expect(store.restoreCalls).toHaveLength(1));
    const waiting = ws.awaitReady(g, 10 * SECOND);
    const replay = vi.fn();
    expect(driver.admitEvent(g, replay)).toBe(false);
    hold.resolve({ ok: false, reason: 'deposed', currentOwner: { nodeId: 'node-b', claim: 9 } });
    expect(await restoring).toEqual({ ok: false, code: 'not-owner', error: DEPOSED });
    expect(await waiting).toBe('not-ready');
    await flushMicro();
    expect(replay).not.toHaveBeenCalled();
    expect(lines(warn).some(l => l.includes(`Dropping 1 buffered event(s) for guild ${g}`))).toBe(true);
    expect(() => saveDataTracked('a.json', opts(g), { v: 2 })).toThrow(expect.objectContaining({ causeKey: 'guild-fenced' }));
    expect(store.doc(g, 'a.json')).toBeUndefined();
    expect(ws.stateOf(g)).toBe('fenced');
    expect(lines(error).filter(l => l.includes('Deposed writer'))).toHaveLength(1);
    expect(ws.getCounters().fencedFlushRejections).toBe(1);
  });
});

describe('the claim and the set', () => {
  it('the restore carries the set\'s claim, and with no ready set restoreGuild is not called', async () => {
    const { store, ws } = setup();
    setOwnerInfoProvider(() => ({ nodeId: 'node-b', processId: 'process-b', shardCount: 1, claimOf: () => 8 }));
    const g = await readyGuild(ws, 7);
    store.restoreImpl = async () => ({ ok: true, moved: 0, retiredAt: 5, reason: 'r' });
    await restoreGuildFromGraveyard(g, 5);
    expect(store.restoreCalls[0][2]).toEqual({ nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 });
    const none = freshGuild();
    expect(await restoreGuildFromGraveyard(none, 5)).toEqual({ ok: false, code: 'backend-unavailable', error: NOT_LOADED });
    expect(store.restoreCalls).toHaveLength(1);
  });

  it.each<[string, RestoreOutcome, { code?: string; error?: string; throws?: string; message?: string }]>([
    ['live-rows', { ok: false, reason: 'live-rows', retiredAt: 5 }, { code: 'invalid', error: liveText(5) }],
    ['no-entry', { ok: false, reason: 'no-entry' }, { code: 'invalid', error: NO_ENTRY }],
    ['schema-mismatch', { ok: false, reason: 'schema-mismatch' }, { code: 'invalid', error: 'this bot refused the database at boot (its log says why); nothing was restored' }],
    ['refused 40P01', { ok: false, reason: 'refused', detail: 'SQLSTATE 40P01: deadlock detected', code: '40P01' }, { code: 'backend-unavailable', error: 'the database refused the restore (SQLSTATE 40P01: deadlock detected); nothing was restored; try again in a moment' }],
    ['refused 57014', { ok: false, reason: 'refused', detail: 'SQLSTATE 57014: canceling statement due to statement timeout', code: '57014' }, { code: 'backend-unavailable', error: 'the database refused the restore (SQLSTATE 57014: canceling statement due to statement timeout); nothing was restored; try again in a moment' }],
    ['refused 23505', { ok: false, reason: 'refused', detail: 'SQLSTATE 23505: duplicate key', code: '23505' }, { code: 'backend-unavailable', error: 'the database refused the restore (SQLSTATE 23505: duplicate key); nothing was restored; see the bot log' }],
    ['no-claim', { ok: false, reason: 'no-claim' }, { code: 'backend-unavailable', error: 'this bot process holds no usable claim on the database; nothing was restored; restart the bot' }],
    ['not-provisioned', { ok: false, reason: 'not-provisioned' }, { code: 'backend-unavailable', error: 'the database is not provisioned yet; nothing was restored; try again once the bot has started' }],
    ['out-of-time', { ok: false, reason: 'out-of-time' }, { code: 'backend-unavailable', error: OUT_OF_TIME }],
    ['maintenance', { ok: false, reason: 'maintenance' }, { throws: 'maintenance' }],
    ['node-stopping', { ok: false, reason: 'node-stopping' }, { throws: 'node-stopping', message: '[Data] This process is stopping; nothing was restored' }],
    ['unavailable', { ok: false, reason: 'unavailable', detail: 'Connection terminated' }, { throws: 'database-unreachable', message: '[Data] The database did not answer or ended the connection (Connection terminated); nothing was restored; try again in a moment' }],
  ])('a definite no (%s) reopens the same set and wakes its waiters ready', async (_name, outcome, expected) => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    const before = setOf(ws, g);
    const hold = deferred<void>();
    store.restoreImpl = async () => { await hold.promise; return outcome; };
    const restoring = restoreGuildFromGraveyard(g, 5);
    await vi.waitFor(() => expect(store.restoreCalls).toHaveLength(1));
    expect(ws.stateOf(g)).toBe('restoring');
    const waiting = ws.awaitReady(g, 10 * SECOND);
    hold.resolve();
    if (expected.throws) {
      const thrown: any = await restoring.catch(e => e);
      expect(thrown.causeKey).toBe(expected.throws);
      if (expected.message) expect(thrown.message).toBe(expected.message);
    } else {
      expect(await restoring).toEqual({ ok: false, code: expected.code, error: expected.error });
    }
    expect(await waiting).toBe('ready');
    expect(setOf(ws, g)).toBe(before);
    expect(ws.stateOf(g)).toBe('ready');
    expect(guildDataOpOf(g)).toBeUndefined();
  });

  it.each(['ok', 'unknown'] as const)('%s evicts a set holding nothing and starts the read before the answer', async kind => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    saveDataTracked('a.json', opts(g), { v: 1 });
    const held: number[] = [];
    const forget = (ws as any).forgetDirty.bind(ws);
    vi.spyOn(ws as any, 'forgetDirty').mockImplementation((set: any) => { held.push(set.dirtyKeys.size + set.appendBuf.size); return forget(set); });
    store.restoreImpl = async () => {
      store.docs.delete(`${g}|m/a.json`);
      return kind === 'ok' ? { ok: true, moved: 0, retiredAt: 5, reason: 'r' } : { ok: false, reason: 'unknown', retiredAt: 5 };
    };
    const hydrations = store.hydrationsSent;
    const reply = await applyOperatorDataWrite(restoreRequest(g, 5));
    expect(reply).toEqual(kind === 'ok'
      ? { ok: true, retiredAt: 5, reason: 'r', moved: 0 }
      : { ok: false, code: 'backend-unavailable', error: unknownText(g, 5) });
    expect(held).toEqual([0]);
    expect(store.hydrationsSent).toBeGreaterThan(hydrations);
    expect(guildDataOpOf(g)).toBeUndefined();
  });
});

describe('dispatch while a guild is in the map', () => {
  it('events wait and replay on the restored data', async () => {
    const { store, ws, driver } = setup();
    const g = await readyGuild(ws);
    store.bury(g, 5, { 'a.json': { v: 'restored' } });
    const hold = deferred<void>();
    const model = store.restoreGuild.bind(store);
    store.restoreImpl = async (...args) => { await hold.promise; store.restoreImpl = null; return model(...args); };
    const restoring = applyOperatorDataWrite(restoreRequest(g, 5));
    await vi.waitFor(() => expect(store.restoreCalls).toHaveLength(1));
    const seen: unknown[] = [];
    expect(driver.admitEvent(g, () => { seen.push(loadData('a.json', opts(g), null)); })).toBe(false);
    expect(seen).toEqual([]);
    hold.resolve();
    expect(await restoring).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(seen).toEqual([{ v: 'restored' }]));
  });

  it('interactions are held during a restore and during a delete', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    const hold = deferred<RestoreOutcome>();
    store.restoreImpl = () => hold.promise;
    const restoring = restoreGuildFromGraveyard(g, 5);
    await vi.waitFor(() => expect(store.restoreCalls).toHaveLength(1));
    expect(gateCauseNow(g, performance.now())).toBe('loading');
    hold.resolve({ ok: false, reason: 'no-entry' });
    await restoring;
    expect(gateCauseNow(g, performance.now())).toBe('admit');
    const retire = deferred<RetireOutcome>();
    store.retireImpl = () => retire.promise;
    const deleting = deleteGuildNamespace(g, 'test', 5 * SECOND);
    await vi.waitFor(() => expect(store.retireCalls).toHaveLength(1));
    expect(gateCauseNow(g, performance.now())).toBe('loading');
    retire.resolve({ ok: true, moved: 0, retiredAt: 5 });
    await deleting;
  });
});

describe('restore and delete exclude each other', () => {
  it('through the IPC handler, at once and with their own texts', async () => {
    const { store, ws } = setup();
    const g = freshGuild();
    store.docs.set(`${g}|m/x.json`, '{"x":1}');
    const retire = deferred<void>();
    store.retireImpl = async guildId => { await retire.promise; return store.retireNow(guildId, 'webui-operator-delete'); };
    const deleting = deleteGuildNamespace(g, 'webui-operator-delete', 5 * SECOND);
    await vi.waitFor(() => expect(store.retireCalls).toHaveLength(1));
    const hydrations = store.hydrationsSent;
    expect(await applyOperatorDataWrite(restoreRequest(g, 5))).toEqual({ ok: false, code: 'invalid', error: DELETE_RUNNING });
    expect(await applyOperatorDataWrite(deleteRequest(g))).toEqual({ ok: false, code: 'invalid', error: DELETE_ALREADY });
    expect(store.hydrationsSent).toBe(hydrations);
    expect(ws.stateOf(g)).toBeNull();
    expect(store.restoreCalls).toEqual([]);
    retire.resolve();
    expect(await deleting).toEqual({ ok: true });
    expect(store.graveyard.get(g)![0].docs.get(`${g}|m/x.json`)).toBe('{"x":1}');
    expect(store.docs.has(`${g}|m/x.json`)).toBe(false);

    const h = await readyGuild(ws);
    const hold = deferred<RestoreOutcome>();
    store.restoreImpl = () => hold.promise;
    const restoring = applyOperatorDataWrite(restoreRequest(h, 5));
    await vi.waitFor(() => expect(store.restoreCalls).toHaveLength(1));
    const started = performance.now();
    expect(await applyOperatorDataWrite(restoreRequest(h, 5))).toEqual({ ok: false, code: 'invalid', error: ALREADY });
    expect(await applyOperatorDataWrite(deleteRequest(h))).toEqual({ ok: false, code: 'invalid', error: RESTORE_RUNNING });
    expect(performance.now() - started).toBeLessThan(500);
    hold.resolve({ ok: false, reason: 'no-entry' });
    expect(await restoring).toEqual({ ok: false, code: 'invalid', error: NO_ENTRY });
  });

  it('a restore whose ready wait fails answers not loaded', async () => {
    const { store } = setup();
    store.hydrateMode = 'unavailable';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date', 'hrtime'] });
    const g = freshGuild();
    const reply = applyOperatorDataWrite(restoreRequest(g, 5));
    let answer: unknown;
    void reply.then(value => { answer = value; });
    await vi.advanceTimersByTimeAsync(3 * SECOND);
    expect(answer).toEqual({ ok: false, code: 'backend-unavailable', error: NOT_LOADED });
    expect(store.restoreCalls).toEqual([]);
  });
});

describe('the deadline', () => {
  it('maintenance or the deadline before COMMIT refuses and reopens the set', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.restoreImpl = async (_g, _r, _t, beforeCommit) => {
      setMaintenanceGate({ cause: 'hook', message: 'down for a moment' });
      return { ok: false, reason: beforeCommit() ?? 'unknown' } as RestoreOutcome;
    };
    expect(await restoreGuildFromGraveyard(g, 5).catch(e => e.causeKey)).toBe('maintenance');
    expect(ws.stateOf(g)).toBe('ready');
    setMaintenanceGate(null);
    store.restoreImpl = async (_g, _r, _t, beforeCommit) => ({ ok: false, reason: beforeCommit() ?? 'unknown' } as RestoreOutcome);
    expect(await restoreGuildFromGraveyard(g, 5, monoIn(1.5 * SECOND))).toEqual({ ok: false, code: 'backend-unavailable', error: OUT_OF_TIME });
    expect(ws.stateOf(g)).toBe('ready');
  });

  it('the real restore past the deadline at beforeCommit sends no ROLLBACK and no COMMIT, and reopens the set with its write', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.bury(g, 5, { 'r.json': { r: 1 } });
    const saved = saveDataTracked('a.json', opts(g), { v: 1 }) as { ticket: WriteTicket };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date', 'hrtime'] });
    const pg = scriptedPg(sql => {
      if (isFenced(sql)) return { rows: [], rowCount: 1 };
      if (/max\(retired_at\)/i.test(sql)) return { rows: [{ retired_at: '5' }], rowCount: 1 };
      if (isBatchExists(sql)) return batchExistsAnswer(sql, store.graveyard.get(g)?.some(b => b.retiredAt === 5) ?? false);
      if (/AS present/.test(sql)) return { rows: [{ present: false }], rowCount: 1 };
      if (/^WITH moved AS/.test(sql)) {
        vi.advanceTimersByTime(40.5 * SECOND);
        return { rows: [{ taken: '1', put: '1', reason: 'r' }], rowCount: 1 };
      }
      return undefined;
    });
    try {
      store.restoreImpl = (...args) => pg.backend.restoreGuild(...args);
      const reply = restoreGuildFromGraveyard(g, 5, monoIn(40 * SECOND));
      let answer: unknown;
      void reply.then(value => { answer = value; });
      await vi.advanceTimersByTimeAsync(SECOND);
      expect(answer).toEqual({ ok: false, code: 'backend-unavailable', error: OUT_OF_TIME });
      expect(pg.statements()).not.toContain('ROLLBACK');
      expect(pg.statements()).not.toContain('COMMIT');
      expect(pg.releases).toEqual([true]);
      expect(ws.stateOf(g)).toBe('ready');
      expect(guildDataOpOf(g)).toBeUndefined();
      expect(store.doc(g, 'a.json')).toBe(JSON.stringify({ v: 1 }, null, 2));
      expect(store.doc(g, 'r.json')).toBeUndefined();
      expect(store.graveyard.get(g)!.map(b => b.retiredAt)).toEqual([5]);
      expect(await confirmWrite(saved.ticket, 0)).toBe('ok');
    } finally {
      vi.useRealTimers();
      await pg.backend.stop();
    }
  });

  it('a request read after its deadline does nothing', async () => {
    const { store, ws } = setup();
    const g = freshGuild();
    store.docs.set(`${g}|m/x.json`, '{"x":1}');
    const flushes = store.flushesSent;
    const hydrations = store.hydrationsSent;
    const past = (process.hrtime.bigint() - 1_000_000_000n).toString();
    expect(await applyOperatorDataWrite(restoreRequest(g, 5, past))).toEqual({ ok: false, code: 'backend-unavailable', error: OUT_OF_TIME });
    expect(await applyOperatorDataWrite(deleteRequest(g, past))).toEqual({ ok: false, code: 'backend-unavailable', error: DELETE_OUT_OF_TIME });
    expect(store.flushesSent).toBe(flushes);
    expect(store.hydrationsSent).toBe(hydrations);
    expect(store.restoreCalls).toEqual([]);
    expect(store.retireCalls).toEqual([]);
    expect(ws.stateOf(g)).toBeNull();
    expect(store.docs.get(`${g}|m/x.json`)).toBe('{"x":1}');
  });

  it.each(['unavailable', 'unknown'] as const)('a restore that never answers settles by 45 s after the send (%s)', async reason => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date', 'hrtime'] });
    store.restoreImpl = (_g, _r, _t, _b, deadline) => new Promise(resolve => {
      setTimeout(() => resolve(reason === 'unavailable'
        ? { ok: false, reason, detail: "the database did not answer within the restore's 40 s" }
        : { ok: false, reason, retiredAt: 5 }), msLeft(deadline));
    });
    await flushMicro();
    const baseline = vi.getTimerCount();
    const sent = process.hrtime.bigint();
    const reply = applyOperatorDataWrite(restoreRequest(g, 5, (sent + 45_000_000_000n).toString()));
    let answer: any;
    let atAnswer: { op: unknown; state: unknown; gate: unknown; at: bigint } | null = null;
    void reply.then(value => {
      answer = value;
      atAnswer = { op: guildDataOpOf(g), state: ws.stateOf(g), gate: gateCauseNow(g, performance.now()), at: process.hrtime.bigint() };
    });
    await vi.advanceTimersByTimeAsync(45 * SECOND);
    expect(answer).toEqual(reason === 'unavailable'
      ? { ok: false, code: 'backend-unavailable', error: "[Data] The database did not answer or ended the connection (the database did not answer within the restore's 40 s); nothing was restored; try again in a moment" }
      : { ok: false, code: 'backend-unavailable', error: unknownText(g, 5) });
    expect(atAnswer!.at - sent <= 45_000_000_000n).toBe(true);
    expect(atAnswer!.op).toBeUndefined();
    expect(atAnswer!.state).not.toBe('restoring');
    expect(atAnswer!.gate).not.toBe('loading');
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it('a wall-clock step does not stretch the deadline', async () => {
    const { store, ws } = setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date', 'hrtime'] });
    for (const step of [30, 90]) {
      const g = await readyGuild(ws);
      const sent = process.hrtime.bigint();
      let commitAt: bigint | null = null;
      store.restoreImpl = async (_g, _r, _t, beforeCommit) => {
        vi.setSystemTime(Date.now() - step * SECOND);
        await vi.advanceTimersByTimeAsync(39 * SECOND);
        const stop = beforeCommit();
        if (!stop) commitAt = process.hrtime.bigint();
        return stop ? { ok: false, reason: stop } : { ok: true, moved: 0, retiredAt: 5, reason: 'r' };
      };
      expect(await applyOperatorDataWrite(restoreRequest(g, 5, (sent + 45_000_000_000n).toString()))).toEqual({ ok: false, code: 'backend-unavailable', error: OUT_OF_TIME });
      expect(commitAt).toBeNull();
    }
    const g = await readyGuild(ws);
    store.restoreImpl = async () => ({ ok: true, moved: 0, retiredAt: 5, reason: 'r' });
    const receipt = process.hrtime.bigint();
    await applyOperatorDataWrite(restoreRequest(g, 5, (receipt + 100_000_000_000n).toString()));
    expect(store.restoreCalls.at(-1)![4] - receipt).toBe(40_000_000_000n);
  });
});

describe('a throw leaves nothing behind', () => {
  /** A run admitted before the restore that loads, waits across it, then saves. */
  const olderRun = (g: string) => {
    const gate = deferred<void>();
    const run = runInLedger(openLedger('interaction'), 'm', async () => {
      loadData('a.json', opts(g), null);
      await gate.promise;
      return saveDataTracked('a.json', opts(g), { v: 'older' });
    });
    return { release: () => { gate.resolve(); return run; } };
  };

  it('a throw from the flush answers the error text, reopens the set, takes no barrier and replays a buffered event at once', async () => {
    const { store, ws, driver } = setup();
    const g = await readyGuild(ws);
    const before = setOf(ws, g);
    const older = olderRun(g);
    const hold = deferred<void>();
    vi.spyOn(ws, 'flushGuildNow').mockImplementationOnce(async () => { await hold.promise; throw new Error('boom'); });
    const restoring = restoreGuildFromGraveyard(g, 5);
    expect(ws.stateOf(g)).toBe('restoring');
    const replay = vi.fn();
    expect(driver.admitEvent(g, replay)).toBe(false);
    hold.resolve();
    expect(await restoring).toEqual({ ok: false, code: 'io-error', error: 'the restore stopped on an error in the bot (boom); nothing was restored; see the bot log' });
    await flushMicro();
    expect(replay).toHaveBeenCalledTimes(1);
    expect(setOf(ws, g)).toBe(before);
    expect(ws.stateOf(g)).toBe('ready');
    expect(guildDataOpOf(g)).toBeUndefined();
    expect(gateCauseNow(g, performance.now())).toBe('admit');
    expect(driver.admitEvent(g, () => {})).toBe(true);
    expect(store.restoreCalls).toEqual([]);
    expect((await older.release()).outcome).toBe('saved');
    expect(await ws.flushGuildNow(g, SECOND)).toBe('ok');
    expect(store.doc(g, 'a.json')).toBe(JSON.stringify({ v: 'older' }, null, 2));
  });

  it('a throw from restoreGuild answers can\'t confirm, evicts the set, takes the barrier and re-gates a buffered event at once', async () => {
    const { store, ws, driver } = setup();
    const g = await readyGuild(ws);
    const before = setOf(ws, g);
    const older = olderRun(g);
    const hold = deferred<void>();
    const committed = JSON.stringify({ v: 'committed' });
    store.restoreImpl = async () => {
      store.docs.set(`${g}|m/a.json`, committed);
      await hold.promise;
      throw new Error('boom');
    };
    const evict = vi.spyOn(ws, 'evict');
    const restoring = applyOperatorDataWrite(restoreRequest(g, 5));
    await vi.waitFor(() => expect(store.restoreCalls).toHaveLength(1));
    const seen: unknown[] = [];
    expect(driver.admitEvent(g, () => { seen.push(loadData('a.json', opts(g), 'absent')); })).toBe(false);
    hold.resolve();
    expect(await restoring).toEqual({ ok: false, code: 'backend-unavailable', error: unknownText(g, 5) });
    expect(guildDataOpOf(g)).toBeUndefined();
    expect(evict).toHaveBeenCalledWith(g);
    await vi.waitFor(() => expect(seen).toEqual([{ v: 'committed' }]), { timeout: 500 });
    expect(setOf(ws, g)).toBeDefined();
    expect(setOf(ws, g)).not.toBe(before);
    expect(ws.stateOf(g)).toBe('ready');
    expect(loadData('a.json', opts(g), null)).toEqual({ v: 'committed' });
    expect(gateCauseNow(g, performance.now())).toBe('admit');
    warn.mockClear();
    expect(await older.release()).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(lines(warn)).toContain(`[Data] Write for guild ${g} refused: it comes from a command that started before the server's data was restored from the graveyard`);
    expect(await ws.flushGuildNow(g, SECOND)).toBe('ok');
    expect(store.docs.get(`${g}|m/a.json`)).toBe(committed);
  });
});

describe('the delete', () => {
  it('a delete stuck on its retire ends with its deadline', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date', 'hrtime'] });
    store.retireImpl = (_g, _r, _t, deadline) => new Promise(resolve => {
      setTimeout(() => resolve({ ok: false, reason: 'unavailable', timedOut: true }), msLeft(deadline!));
    });
    const sent = process.hrtime.bigint();
    const reply = applyOperatorDataWrite(deleteRequest(g, (sent + 45_000_000_000n).toString()));
    let answer: any;
    void reply.then(value => { answer = value; });
    await vi.advanceTimersByTimeAsync(45 * SECOND);
    expect(answer).toEqual({ ok: false, code: 'backend-unavailable', error: DELETE_TIMEOUT });
    expect(guildDataOpOf(g)).toBeUndefined();
    expect(ws.stateOf(g)).toBeNull();
    expect(await ws.hydrate(g, { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 })).toBe('ready');
    expect(gateCauseNow(g, performance.now())).toBe('admit');
    expect(saveDataTracked('a.json', opts(g), { v: 1 }).outcome).toBe('saved');
  });

  it('a delete counts its deadline from the send', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    const receipt = process.hrtime.bigint();
    const sent = receipt - 4_000_000_000n;
    await applyOperatorDataWrite(deleteRequest(g, (sent + 45_000_000_000n).toString()));
    expect(store.retireCalls[0][3]! - sent).toBe(40_000_000_000n);
  });

  it('a slow retire completes', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    saveDataTracked('a.json', opts(g), { v: 1 });
    await ws.flushGuildNow(g, SECOND);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date', 'hrtime'] });
    const pg = scriptedPg(sql => {
      if (isFenced(sql)) return { rows: [], rowCount: 1 };
      if (isGraveInsert(sql) && sql.includes("'doc'")) return new Promise(resolve => { setTimeout(() => resolve({ rows: [], rowCount: 1 }), 9 * SECOND); });
      if (sql === 'COMMIT') store.retireNow(g, 'webui-operator-delete');
      return undefined;
    });
    try {
      store.retireImpl = (guildId, reason, token, deadline) => pg.backend.retireGuild(guildId, reason, token, deadline);
      const reply = applyOperatorDataWrite(deleteRequest(g, (process.hrtime.bigint() + 45_000_000_000n).toString()));
      let answer: unknown;
      void reply.then(value => { answer = value; });
      await vi.advanceTimersByTimeAsync(10 * SECOND);
      expect(answer).toEqual({ ok: true });
      const insert = pg.sent.find(s => isGraveInsert(s.sql))!;
      expect(insert.timeout).toBeGreaterThanOrEqual(39_900);
      expect(insert.timeout).toBeLessThanOrEqual(40_000);
      expect(pg.statements().filter(isGraveInsert)).toHaveLength(2);
      expect(pg.statements().at(-1)).toBe('COMMIT');
      expect(pg.releases).toEqual([undefined]);
      expect(store.doc(g, 'a.json')).toBeUndefined();
      expect(store.graveyard.get(g)!.at(-1)!.docs.get(`${g}|m/a.json`)).toBe(JSON.stringify({ v: 1 }, null, 2));
      expect(ws.stateOf(g)).toBeNull();
    } finally {
      vi.useRealTimers();
      await pg.backend.stop();
    }
  });

  it('the delete drops no write', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    const before = saveDataTracked('a.json', opts(g), { v: 1 });
    const retire = deferred<RetireOutcome>();
    store.retireImpl = async guildId => { await retire.promise; return store.retireNow(guildId, 'webui-operator-delete'); };
    const evict = vi.spyOn(ws, 'evict');
    const deleting = deleteGuildNamespace(g, 'webui-operator-delete', 5 * SECOND);
    await vi.waitFor(() => expect(store.retireCalls).toHaveLength(1));
    warn.mockClear();
    const during = [
      saveDataTracked('b.json', opts(g), { v: 2 }),
      appendDataTracked('l.jsonl', opts(g), 'x\n'),
      deleteDataTracked('a.json', opts(g)),
      updateData('c.json', opts(g), {}, v => v),
    ];
    for (const result of during) expect(result).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(lines(warn)).toEqual([
      `[Data] Write for guild ${g} refused: its data is being deleted`,
      `[Data] Append for guild ${g} refused: its data is being deleted`,
      `[Data] Delete for guild ${g} refused: its data is being deleted`,
      `[Data] Update for guild ${g} refused: its data is being deleted`,
    ]);
    expect(evict).not.toHaveBeenCalled();
    retire.resolve({ ok: true, moved: 1, retiredAt: 5 });
    expect(await deleting).toEqual({ ok: true });
    expect(evict).toHaveBeenCalledWith(g);
    expect(store.graveyard.get(g)![0].docs.get(`${g}|m/a.json`)).toBe(JSON.stringify({ v: 1 }, null, 2));
    expect(await confirmWrite((before as { ticket: WriteTicket }).ticket, 0)).toBe('ok');

    const fresh = freshGuild();
    store.docs.set(`${fresh}|m/x.json`, '{"x":1}');
    const held = deferred<RetireOutcome>();
    store.retireImpl = async guildId => { await held.promise; return store.retireNow(guildId, 'test'); };
    const second = deleteGuildNamespace(fresh, 'test', 5 * SECOND);
    await vi.waitFor(() => expect(store.retireCalls).toHaveLength(2));
    expect(await ws.hydrate(fresh, { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 })).toBe('ready');
    held.resolve({ ok: true, moved: 1, retiredAt: 5 });
    await second;
    expect(ws.stateOf(fresh)).toBeNull();
    expect(await ws.hydrate(fresh, { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 })).toBe('ready');
    expect(loadData('x.json', opts(fresh), null)).toBeNull();

    const third = await readyGuild(ws);
    store.retireImpl = async () => ({ ok: false, reason: 'unknown', retiredAt: 5, moved: 1 });
    expect(await deleteGuildNamespace(third, 'test', 5 * SECOND)).toEqual({ ok: false, code: 'backend-unavailable', error: DELETE_UNKNOWN });
    expect(ws.stateOf(third)).toBeNull();
  });
});

describe('every accepted write is stored, held or deposed (property)', () => {
  type Point = 'before' | 'deleting' | 'flushing' | 'restoring' | 'after';
  type Kind = 'save' | 'append' | 'delete' | 'update';
  const order: Record<Point, number> = { before: 0, deleting: 0, flushing: 1, restoring: 2, after: 3 };
  const step = fc.record({
    at: fc.constantFrom<Point>('before', 'deleting', 'flushing', 'restoring', 'after'),
    kind: fc.constantFrom<Kind>('save', 'append', 'delete', 'update'),
    other: fc.boolean(),
    doc: fc.constantFrom('a.json', 'b.json'),
  });
  const readWrite = fc.record({
    loadAt: fc.constantFrom<Point>('before', 'flushing', 'restoring', 'after'),
    saveAt: fc.constantFrom<Point>('flushing', 'restoring', 'after'),
    doc: fc.constantFrom('a.json', 'b.json'),
  });

  it('over random schedules of writes, read-then-write runs and a delete around a restore', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(step, { maxLength: 12 }),
      fc.array(readWrite, { maxLength: 3 }),
      fc.constantFrom('none', 'before', 'flushing', 'restoring', 'after'),
      fc.constantFrom('ok', 'unknown-committed', 'unknown-lost'),
      fc.constantFrom('commit', 'unavailable', 'deposed', 'landed-unavailable'),
      fc.constantFrom('ok', 'live-rows', 'deposed', 'unavailable', 'unknown-committed', 'unknown-lost'),
      async (steps, runs, deleteAt, retireAnswer, flushMode, restoreAnswer) => {
        const { store, ws } = setup();
        const g = await readyGuild(ws);
        const other = await readyGuild(ws);
        store.bury(g, 5, { 'a.json': { buried: true }, 'r.json': { restored: true } });
        const accepted: Array<{ guildId: string; doc: string; kind: Kind; bytes: string; ticket: WriteTicket }> = [];
        const rowOf = (guildId: string, doc: string) => `${guildId}|m/${doc}`;
        let n = 0;
        let inMap = false;
        const accept = (guildId: string, doc: string, kind: Kind, bytes: string, result: any) => {
          if (!result?.ticket) return;
          if (inMap && guildId === g) throw new Error(`a ${kind} was accepted while the guild was in the map`);
          accepted.push({ guildId, doc, kind, bytes, ticket: result.ticket });
        };
        const write = (guildId: string, kind: Kind, doc: string) => {
          const value = { n: ++n };
          const bytes = JSON.stringify(value, null, 2);
          try {
            if (kind === 'save') accept(guildId, doc, kind, bytes, saveDataTracked(doc, opts(guildId), value));
            else if (kind === 'update') accept(guildId, doc, kind, bytes, updateData<unknown>(doc, opts(guildId), {}, () => value));
            else if (kind === 'delete') accept(guildId, doc, kind, '', deleteDataTracked(doc, opts(guildId)));
            else accept(guildId, 'l.jsonl', kind, `${value.n}\n`, appendDataTracked('l.jsonl', opts(guildId), `${value.n}\n`));
          } catch (error) {
            if (String((error as Error)?.message).includes('accepted while the guild was in the map')) throw error;
          }
        };

        type Pending = { saveAt: Point; loadedBefore: boolean; gate: { resolve: (v: void) => void }; done: Promise<void>; savedAt: Point | null; outcome: string | null };
        const pending: Pending[] = [];
        let restoreEnded = false;
        const startRuns = (point: Point) => {
          for (const r of runs.filter(x => x.loadAt === point)) {
            const gate = deferred<void>();
            const entry: Pending = { saveAt: order[r.saveAt] < order[point] ? point : r.saveAt, loadedBefore: !restoreEnded, gate, done: Promise.resolve(), savedAt: null, outcome: null };
            entry.done = runInLedger(openLedger('interaction'), 'm', async () => {
              let loaded: unknown = null;
              try { loaded = loadData(r.doc, opts(g), null); } catch { /* a guild not served: the default */ }
              await gate.promise;
              const value = { n: ++n, from: loaded };
              entry.savedAt = current;
              try {
                const result: any = saveDataTracked(r.doc, opts(g), value);
                entry.outcome = result.outcome;
                accept(g, r.doc, 'save', JSON.stringify(value, null, 2), result);
              } catch (error) {
                if (String((error as Error)?.message).includes('accepted while the guild was in the map')) throw error;
                entry.outcome = 'threw';
              }
            });
            pending.push(entry);
          }
        };
        let current: Point = 'before';
        const at = async (point: Point) => {
          current = point;
          for (const entry of pending.filter(p => p.savedAt === null && order[p.saveAt] <= order[point] && point !== 'deleting')) {
            entry.gate.resolve();
            await entry.done;
          }
          for (const s of steps.filter(x => x.at === point)) write(s.other ? other : g, s.kind, s.doc);
          if (point !== 'deleting') startRuns(point);
        };
        const rehydrate = async () => {
          if (ws.stateOf(g) === null) await ws.hydrate(g, { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 });
        };
        const runDelete = async () => {
          store.retireImpl = async guildId => {
            await at('deleting');
            if (retireAnswer === 'unknown-lost') return { ok: false, reason: 'unknown', retiredAt: 5, moved: 1 };
            const moved = store.retireNow(guildId, 'test');
            return retireAnswer === 'ok' ? moved : { ok: false, reason: 'unknown', retiredAt: 5, moved: 1 };
          };
          const deleting = deleteGuildNamespace(g, 'test', SECOND);
          inMap = true;
          await deleting;
          inMap = false;
          await rehydrate();
        };
        const refusedDelete = async () => {
          const calls = store.retireCalls.length;
          expect(await deleteGuildNamespace(g, 'test', SECOND)).toEqual({ ok: false, code: 'invalid', error: RESTORE_RUNNING });
          expect(store.retireCalls).toHaveLength(calls);
        };

        await at('before');
        if (deleteAt === 'before') await runDelete();
        const hold = deferred<void>();
        const batch = store.graveyard.get(g)!.find(b => b.retiredAt === 5)!;
        let movedAt: number | null = null;
        let answered: string | null = null;
        store.restoreImpl = async () => {
          await at('restoring');
          if (deleteAt === 'restoring') await refusedDelete();
          await hold.promise;
          const live = [...store.docs.keys(), ...store.streams.keys()].some(row => row.startsWith(`${g}|`));
          const failure = restoreAnswer === 'deposed' || restoreAnswer === 'unavailable' || restoreAnswer === 'unknown-lost';
          const outcome: RestoreOutcome = live && !failure ? { ok: false, reason: 'live-rows', retiredAt: 5 }
            : restoreAnswer === 'ok' ? { ok: true, moved: 2, retiredAt: 5, reason: 'r' }
              : restoreAnswer === 'live-rows' ? { ok: false, reason: 'live-rows', retiredAt: 5 }
                : restoreAnswer === 'deposed' ? { ok: false, reason: 'deposed' }
                  : restoreAnswer === 'unavailable' ? { ok: false, reason: 'unavailable', detail: 'x' }
                    : { ok: false, reason: 'unknown', retiredAt: 5 };
          if (!live && (restoreAnswer === 'ok' || restoreAnswer === 'unknown-committed')) {
            store.moveBack(g, batch);
            movedAt = accepted.length;
          }
          answered = outcome.ok ? 'ok' : outcome.reason;
          return outcome;
        };
        store.holding = true;
        const restoring = restoreGuildFromGraveyard(g, 5).catch(() => undefined);
        inMap = true;
        await flushMicro();
        await at('flushing');
        if (deleteAt === 'flushing') await refusedDelete();
        store.mode = flushMode as never;
        store.holding = false;
        store.release();
        await flushMicro(50);
        store.mode = 'commit';
        hold.resolve();
        await restoring;
        inMap = false;
        restoreEnded = true;
        expect(guildDataOpOf(g)).toBeUndefined();
        await rehydrate();
        await at('after');
        if (deleteAt === 'after') await runDelete();
        current = 'after';
        for (const entry of pending) {
          entry.gate.resolve();
          await entry.done;
        }

        for (const guildId of [g, other]) await ws.flushGuildNow(guildId, SECOND);
        const answers = await Promise.all(accepted.map(w => confirmWrite(w.ticket, 0)));
        expect(answers).not.toContain('unavailable');
        const graveRows = (guildId: string, row: string) => (store.graveyard.get(guildId) ?? []).flatMap(b => [b.docs.get(row), b.streams.get(row)]);
        accepted.forEach((w, i) => {
          if (answers[i] === 'deposed') return;
          const row = rowOf(w.guildId, w.doc);
          if (w.kind === 'append') {
            expect([store.streams.get(row), ...graveRows(w.guildId, row)].some(text => text?.includes(w.bytes))).toBe(true);
            return;
          }
          if (accepted.slice(i + 1).some(later => later.guildId === w.guildId && later.doc === w.doc && later.kind !== 'append')) return;
          if (w.kind === 'delete' && movedAt !== null && i < movedAt && w.guildId === g && batch.docs.has(row)) return;
          if (w.kind === 'delete') expect(store.docs.has(row)).toBe(false);
          else expect([store.docs.get(row), ...graveRows(w.guildId, row)]).toContain(w.bytes);
        });

        const committed = movedAt !== null;
        const barrier = answered === 'ok' || answered === 'unknown';
        for (const entry of pending) {
          if (entry.savedAt === 'after' && entry.loadedBefore && barrier) expect(entry.outcome).toBe('refused');
          if (entry.savedAt !== null && entry.savedAt !== 'after' && entry.savedAt !== 'before') expect(entry.outcome === 'saved').toBe(false);
        }
        const restoredRow = rowOf(g, 'r.json');
        const restoredSomewhere = store.docs.has(restoredRow) || (store.graveyard.get(g) ?? []).some(b => b !== batch && b.docs.has(restoredRow));
        expect(restoredSomewhere).toBe(committed);
        expect((store.graveyard.get(g) ?? []).includes(batch)).toBe(!committed);
        for (const driver of drivers.splice(0)) driver.stop();
      },
    ), { numRuns: 200 });
  }, 120_000);
});

describe('the state x exit table (Postgres cells)', () => {
  const SAVED = JSON.stringify({ v: 1 }, null, 2);
  const RESTORED = JSON.stringify({ v: 'restored' });
  type Cell = Awaited<ReturnType<typeof cellGuild>>;

  /** A ready guild with batch 5 (r.json) in the graveyard and, unless told not to, a write accepted before the operation. */
  async function cellGuild(options: { save?: boolean; holdFlush?: boolean } = {}) {
    const ctx = setup();
    const g = await readyGuild(ctx.ws);
    ctx.store.bury(g, 5, { 'r.json': { v: 'restored' } });
    if (options.holdFlush) ctx.store.holding = true;
    const saved = options.save === false ? null : (saveDataTracked('a.json', opts(g), { v: 1 }) as { ticket: WriteTicket });
    return { ...ctx, g, saved };
  }
  const batchOf = (c: Cell) => c.store.graveyard.get(c.g)!.find(b => b.retiredAt === 5);
  /** The model's restore with its live check left out: beforeCommit, then the move of batch 5. */
  const committing = (c: Cell, before: () => Promise<void> = async () => {}) => async (_g: string, _r: number | null, _t: FenceToken, beforeCommit: () => RestoreStop | null): Promise<RestoreOutcome> => {
    await before();
    const stop = beforeCommit();
    if (stop) return { ok: false, reason: stop };
    c.store.moveBack(c.g, batchOf(c)!);
    return { ok: true, moved: 1, retiredAt: 5, reason: 'r' };
  };
  /** Nothing was restored: the earlier write is stored (or lands once the set flushes), batch 5 is still in the graveyard. */
  async function expectNothingRestored(c: Cell): Promise<void> {
    if (c.ws.stateOf(c.g) === 'ready') expect(await c.ws.flushGuildNow(c.g, SECOND)).toBe('ok');
    if (c.saved) {
      expect(c.store.doc(c.g, 'a.json')).toBe(SAVED);
      expect(await confirmWrite(c.saved.ticket, 0)).toBe('ok');
    }
    expect(c.store.doc(c.g, 'r.json')).toBeUndefined();
    expect(batchOf(c)?.docs.get(`${c.g}|m/r.json`)).toBe(RESTORED);
  }
  /** Batch 5 was moved in: r.json is live, batch 5 is gone, and the earlier write is stored. */
  async function expectRestored(c: Cell): Promise<void> {
    expect(c.store.doc(c.g, 'r.json')).toBe(RESTORED);
    expect(batchOf(c)).toBeUndefined();
    if (c.saved) {
      expect(c.store.doc(c.g, 'a.json')).toBe(SAVED);
      expect(await confirmWrite(c.saved.ticket, 0)).toBe('ok');
    }
  }
  const restoreThrows = async (running: Promise<unknown>) => ((await running.catch(e => e)) as { causeKey?: string }).causeKey;

  it.each<[string, (c: Cell) => Promise<void>]>([
    ['P1 continue, P2 ok, P3 answered: evicted, the batch moved in', async c => {
      c.store.restoreImpl = committing(c);
      expect(await restoreGuildFromGraveyard(c.g, 5)).toEqual({ ok: true, retiredAt: 5, reason: 'r', moved: 1 });
      expect(c.ws.stateOf(c.g)).toBeNull();
      await expectRestored(c);
    }],
    ['P1 database drops (held): reopened, the write kept dirty and landing later', async c => {
      c.store.mode = 'unavailable';
      expect(await restoreGuildFromGraveyard(c.g, 5)).toEqual({ ok: false, code: 'backend-unavailable', error: FLUSH_TEXT });
      expect(c.store.restoreCalls).toEqual([]);
      expect(c.ws.stateOf(c.g)).toBe('ready');
      c.store.mode = 'commit';
      await expectNothingRestored(c);
    }],
    ['P1 takeover (deposed flush): fenced, the write dropped by the fence rule, its ticket deposed', async c => {
      c.store.mode = 'deposed';
      expect(await restoreGuildFromGraveyard(c.g, 5)).toEqual({ ok: false, code: 'not-owner', error: DEPOSED });
      expect(c.ws.stateOf(c.g)).toBe('fenced');
      expect(await confirmWrite(c.saved!.ticket, 0)).toBe('deposed');
      expect(c.store.doc(c.g, 'a.json')).toBeUndefined();
      expect(batchOf(c)).toBeDefined();
    }],
    ['P2 live rows: reopened, nothing moved', async c => {
      expect(await restoreGuildFromGraveyard(c.g, 5)).toEqual({ ok: false, code: 'invalid', error: liveText(5) });
      expect(c.ws.stateOf(c.g)).toBe('ready');
      await expectNothingRestored(c);
    }],
    ['P2 sweep first (no entry): reopened, the batch gone with the sweep', async c => {
      c.store.restoreImpl = async () => { c.store.graveyard.delete(c.g); return { ok: false, reason: 'no-entry' }; };
      expect(await restoreGuildFromGraveyard(c.g, 5)).toEqual({ ok: false, code: 'invalid', error: NO_ENTRY });
      expect(c.ws.stateOf(c.g)).toBe('ready');
      expect(await c.ws.flushGuildNow(c.g, SECOND)).toBe('ok');
      expect(c.store.doc(c.g, 'a.json')).toBe(SAVED);
      expect(c.store.doc(c.g, 'r.json')).toBeUndefined();
    }],
    ['P2 takeover: fenced, nothing moved, the earlier write stored by the P1 flush', async c => {
      c.store.restoreImpl = async () => ({ ok: false, reason: 'deposed' });
      expect(await restoreGuildFromGraveyard(c.g, 5)).toEqual({ ok: false, code: 'not-owner', error: DEPOSED });
      expect(c.ws.stateOf(c.g)).toBe('fenced');
      expect(c.store.doc(c.g, 'a.json')).toBe(SAVED);
      expect(batchOf(c)).toBeDefined();
    }],
    ['P2 deadline (less than 2 s at beforeCommit): out-of-time, reopened', async c => {
      c.store.restoreImpl = committing(c);
      expect(await restoreGuildFromGraveyard(c.g, 5, monoIn(1.5 * SECOND))).toEqual({ ok: false, code: 'backend-unavailable', error: OUT_OF_TIME });
      expect(c.ws.stateOf(c.g)).toBe('ready');
      await expectNothingRestored(c);
    }],
    ['P2 deadline (a statement\'s query_timeout): did not answer, reopened', async c => {
      c.store.restoreImpl = async () => ({ ok: false, reason: 'unavailable', detail: "the database did not answer within the restore's 40 s" });
      expect(await restoreThrows(restoreGuildFromGraveyard(c.g, 5))).toBe('database-unreachable');
      expect(c.ws.stateOf(c.g)).toBe('ready');
      await expectNothingRestored(c);
    }],
    ['P2 database drops: did not answer, the same set reopened', async c => {
      const before = setOf(c.ws, c.g);
      c.store.restoreImpl = async () => ({ ok: false, reason: 'unavailable', detail: 'Connection terminated' });
      expect(await restoreThrows(restoreGuildFromGraveyard(c.g, 5))).toBe('database-unreachable');
      expect(setOf(c.ws, c.g)).toBe(before);
      await expectNothingRestored(c);
    }],
    ['P2 maintenance: beforeCommit refuses, reopened', async c => {
      c.store.restoreImpl = committing(c, async () => { setMaintenanceGate({ cause: 'hook', message: 'down for a moment' }); });
      expect(await restoreThrows(restoreGuildFromGraveyard(c.g, 5))).toBe('maintenance');
      expect(c.ws.stateOf(c.g)).toBe('ready');
      setMaintenanceGate(null);
      await expectNothingRestored(c);
    }],
    ['P3 COMMIT answered with an error: refused, reopened', async c => {
      c.store.restoreImpl = async () => ({ ok: false, reason: 'refused', detail: 'SQLSTATE 40001: serialization', code: '40001' });
      expect(await restoreGuildFromGraveyard(c.g, 5)).toEqual({ ok: false, code: 'backend-unavailable', error: 'the database refused the restore (SQLSTATE 40001: serialization); nothing was restored; see the bot log' });
      expect(c.ws.stateOf(c.g)).toBe('ready');
      await expectNothingRestored(c);
    }],
    ['P3 database drops (unknown, rolled back): can\'t confirm, evicted, the batch still listed', async c => {
      c.store.restoreImpl = async () => ({ ok: false, reason: 'unknown', retiredAt: 5 });
      expect(await restoreGuildFromGraveyard(c.g, 5)).toEqual({ ok: false, code: 'backend-unavailable', error: unknownText(c.g, 5) });
      expect(c.ws.stateOf(c.g)).toBeNull();
      await expectNothingRestored(c);
    }],
    ['P3 deadline (COMMIT\'s query_timeout, committed): can\'t confirm, evicted, the data back', async c => {
      c.store.restoreImpl = async (g, r, t, beforeCommit) => { await committing(c)(g, r, t, beforeCommit); return { ok: false, reason: 'unknown', retiredAt: 5 }; };
      expect(await restoreGuildFromGraveyard(c.g, 5)).toEqual({ ok: false, code: 'backend-unavailable', error: unknownText(c.g, 5) });
      expect(c.ws.stateOf(c.g)).toBeNull();
      await expectRestored(c);
    }],
    ['P3 maintenance after COMMIT was sent: ok, evicted', async c => {
      c.store.restoreImpl = async (_g, _r, _t, beforeCommit) => {
        expect(beforeCommit()).toBeNull();
        setMaintenanceGate({ cause: 'hook', message: 'down for a moment' });
        c.store.moveBack(c.g, batchOf(c)!);
        return { ok: true, moved: 1, retiredAt: 5, reason: 'r' };
      };
      expect(await restoreGuildFromGraveyard(c.g, 5)).toEqual({ ok: true, retiredAt: 5, reason: 'r', moved: 1 });
      setMaintenanceGate(null);
      expect(c.ws.stateOf(c.g)).toBeNull();
      await expectRestored(c);
    }],
  ])('%s', async (_name, run) => {
    const c = await cellGuild();
    await run(c);
    expect(guildDataOpOf(c.g)).toBeUndefined();
  });

  it.each<[string, (c: Cell) => Promise<void>]>([
    ['P0 resume: a second restore answers already running before its ready wait', async c => {
      const hold = deferred<void>();
      c.store.restoreImpl = committing(c, () => hold.promise);
      const first = applyOperatorDataWrite(restoreRequest(c.g, 5));
      await vi.waitFor(() => expect(c.store.restoreCalls).toHaveLength(1));
      const hydrations = c.store.hydrationsSent;
      expect(await applyOperatorDataWrite(restoreRequest(c.g, 5))).toEqual({ ok: false, code: 'invalid', error: ALREADY });
      expect(c.store.hydrationsSent).toBe(hydrations);
      hold.resolve();
      expect(await first).toMatchObject({ ok: true, retiredAt: 5 });
      expect(c.store.restoreCalls).toHaveLength(1);
      await expectRestored(c);
    }],
    ['P0 maintenance: refused with the message, nothing flushed or restored', async c => {
      const flushes = c.store.flushesSent;
      setMaintenanceGate({ cause: 'hook', message: 'down for a moment' });
      expect(await applyOperatorDataWrite(restoreRequest(c.g, 5))).toMatchObject({ ok: false, code: 'maintenance' });
      expect(c.store.flushesSent).toBe(flushes);
      expect(c.store.restoreCalls).toEqual([]);
      setMaintenanceGate(null);
      await expectNothingRestored(c);
    }],
    ['P0 takeover: the set fenced, not-owner, restoreGuild not called', async c => {
      c.ws.depose(c.g);
      expect(await applyOperatorDataWrite(restoreRequest(c.g, 5))).toEqual({ ok: false, code: 'not-owner', error: DEPOSED });
      expect(c.store.restoreCalls).toEqual([]);
      expect(batchOf(c)).toBeDefined();
      expect(c.store.doc(c.g, 'r.json')).toBeUndefined();
    }],
    ['P0 deadline: out-of-time before the ready wait, nothing flushed', async c => {
      const flushes = c.store.flushesSent;
      expect(await applyOperatorDataWrite(restoreRequest(c.g, 5, (process.hrtime.bigint() - 1n).toString()))).toEqual({ ok: false, code: 'backend-unavailable', error: OUT_OF_TIME });
      expect(c.store.flushesSent).toBe(flushes);
      expect(c.ws.stateOf(c.g)).toBe('ready');
      await expectNothingRestored(c);
    }],
    ['P0 delete of G: a delete running refuses the restore; the delete moves the earlier write into its own batch', async c => {
      const retire = deferred<void>();
      c.store.retireImpl = async guildId => { await retire.promise; return c.store.retireNow(guildId, 'test'); };
      const deleting = deleteGuildNamespace(c.g, 'test', 5 * SECOND);
      await vi.waitFor(() => expect(c.store.retireCalls).toHaveLength(1));
      expect(await applyOperatorDataWrite(restoreRequest(c.g, 5))).toEqual({ ok: false, code: 'invalid', error: DELETE_RUNNING });
      retire.resolve();
      expect(await deleting).toEqual({ ok: true });
      expect(c.store.restoreCalls).toEqual([]);
      expect(c.store.graveyard.get(c.g)!.at(-1)!.docs.get(`${c.g}|m/a.json`)).toBe(SAVED);
      expect(batchOf(c)).toBeDefined();
    }],
    ['P1 maintenance: the gate closes during the flush; the flush lands and beforeCommit refuses', async c => {
      c.store.restoreImpl = committing(c);
      const restoring = restoreGuildFromGraveyard(c.g, 5);
      await vi.waitFor(() => expect(c.store.flushesSent).toBeGreaterThan(0));
      setMaintenanceGate({ cause: 'hook', message: 'down for a moment' });
      c.store.holding = false;
      c.store.release();
      expect(await restoreThrows(restoring)).toBe('maintenance');
      expect(c.ws.stateOf(c.g)).toBe('ready');
      setMaintenanceGate(null);
      await expectNothingRestored(c);
    }],
    ['P1 delete of G: refused as a restore running; the restore then commits', async c => {
      c.store.restoreImpl = committing(c);
      const restoring = restoreGuildFromGraveyard(c.g, 5);
      await vi.waitFor(() => expect(c.store.flushesSent).toBeGreaterThan(0));
      expect(await deleteGuildNamespace(c.g, 'test', 5 * SECOND)).toEqual({ ok: false, code: 'invalid', error: RESTORE_RUNNING });
      c.store.holding = false;
      c.store.release();
      expect(await restoring).toMatchObject({ ok: true });
      expect(c.store.retireCalls).toEqual([]);
      await expectRestored(c);
    }],
    ['P1 crash: a new manager reads the store; the unflushed write is lost as on any crash and nothing is restored', async c => {
      void restoreGuildFromGraveyard(c.g, 5);
      await vi.waitFor(() => expect(c.store.flushesSent).toBeGreaterThan(0));
      const next = initWorkingSet(c.store);
      expect(await next.hydrate(c.g, { nodeId: 'node-a', claim: 8, processId: 'process-a', shardId: 0, shardCount: 1 })).toBe('ready');
      expect(c.store.doc(c.g, 'a.json')).toBeUndefined();
      expect(c.store.doc(c.g, 'r.json')).toBeUndefined();
      expect(batchOf(c)).toBeDefined();
    }],
  ])('%s', async (name, run) => {
    const c = await cellGuild({ holdFlush: name.startsWith('P1') });
    await run(c);
    if (!name.includes('crash')) expect(guildDataOpOf(c.g)).toBeUndefined();
  });

  it.each<[string, (c: Cell) => Promise<void>]>([
    ['P2 crash: the server rolls the transaction back; a new manager reads no restored row', async c => {
      c.store.restoreImpl = () => new Promise(() => {});
      void restoreGuildFromGraveyard(c.g, 5);
      await vi.waitFor(() => expect(c.store.restoreCalls).toHaveLength(1));
      const next = initWorkingSet(c.store);
      expect(await next.hydrate(c.g, { nodeId: 'node-a', claim: 8, processId: 'process-a', shardId: 0, shardCount: 1 })).toBe('ready');
      expect(next.read(c.g, 'm', 'a.json')).toEqual({ status: 'ready', value: { v: 1 } });
      expect(c.store.doc(c.g, 'r.json')).toBeUndefined();
      expect(batchOf(c)).toBeDefined();
    }],
    ['P2 delete of G: refused as a restore running; the restore then commits', async c => {
      const hold = deferred<void>();
      c.store.restoreImpl = committing(c, () => hold.promise);
      const restoring = restoreGuildFromGraveyard(c.g, 5);
      await vi.waitFor(() => expect(c.store.restoreCalls).toHaveLength(1));
      expect(await applyOperatorDataWrite(deleteRequest(c.g))).toEqual({ ok: false, code: 'invalid', error: RESTORE_RUNNING });
      hold.resolve();
      expect(await restoring).toMatchObject({ ok: true });
      expect(c.store.retireCalls).toEqual([]);
      await expectRestored(c);
    }],
    ['P3 delete of G: refused as a restore running while COMMIT is on the wire', async c => {
      const hold = deferred<void>();
      c.store.restoreImpl = async (_g, _r, _t, beforeCommit) => {
        expect(beforeCommit()).toBeNull();
        await hold.promise;
        c.store.moveBack(c.g, batchOf(c)!);
        return { ok: true, moved: 1, retiredAt: 5, reason: 'r' };
      };
      const restoring = restoreGuildFromGraveyard(c.g, 5);
      await vi.waitFor(() => expect(c.store.restoreCalls).toHaveLength(1));
      expect(await deleteGuildNamespace(c.g, 'test', 5 * SECOND)).toEqual({ ok: false, code: 'invalid', error: RESTORE_RUNNING });
      hold.resolve();
      expect(await restoring).toMatchObject({ ok: true });
      await expectRestored(c);
    }],
    ['P4 resume: a restore again answers no entry, or live data naming the older entry', async c => {
      c.store.restoreImpl = committing(c);
      expect(await applyOperatorDataWrite(restoreRequest(c.g, 5))).toMatchObject({ ok: true });
      c.store.restoreImpl = null;
      expect(await applyOperatorDataWrite(restoreRequest(c.g, 5))).toEqual({ ok: false, code: 'invalid', error: NO_ENTRY });
      c.store.bury(c.g, 3, { 'o.json': { v: 'older' } });
      expect(await applyOperatorDataWrite(restoreRequest(c.g))).toEqual({ ok: false, code: 'invalid', error: liveText(3) });
      await expectRestored(c);
      expect(c.store.doc(c.g, 'o.json')).toBeUndefined();
    }],
    ['P4 delete of G: runs as any delete and moves the restored rows with the earlier write', async c => {
      c.store.restoreImpl = committing(c);
      expect(await applyOperatorDataWrite(restoreRequest(c.g, 5))).toMatchObject({ ok: true });
      expect(await applyOperatorDataWrite(deleteRequest(c.g))).toEqual({ ok: true });
      const moved = c.store.graveyard.get(c.g)!.at(-1)!;
      expect(moved.docs.get(`${c.g}|m/r.json`)).toBe(RESTORED);
      expect(moved.docs.get(`${c.g}|m/a.json`)).toBe(SAVED);
      expect(c.store.doc(c.g, 'r.json')).toBeUndefined();
    }],
    ['P4 database drops: the read after the evict fails and the readiness driver reads it again', async c => {
      c.store.restoreImpl = committing(c, async () => { c.store.hydrateMode = 'unavailable'; });
      expect(await applyOperatorDataWrite(restoreRequest(c.g, 5))).toMatchObject({ ok: true });
      expect(c.ws.stateOf(c.g)).not.toBe('ready');
      c.store.hydrateMode = 'ok';
      await vi.waitFor(() => expect(c.ws.stateOf(c.g)).toBe('ready'), { timeout: 4 * SECOND });
      expect(loadData('r.json', opts(c.g), null)).toEqual({ v: 'restored' });
      await expectRestored(c);
    }],
  ])('%s', async (name, run) => {
    const c = await cellGuild();
    await run(c);
    if (!name.includes('crash')) expect(guildDataOpOf(c.g)).toBeUndefined();
  }, 10_000);

  it.each<[string, RetireOutcome, unknown, boolean]>([
    ['D2 retire ok', { ok: true, moved: 1, retiredAt: 5 }, { ok: true }, true],
    ['D2 COMMIT with no answer (committed)', { ok: false, reason: 'unknown', retiredAt: 5, moved: 1 }, { ok: false, code: 'backend-unavailable', error: DELETE_UNKNOWN }, true],
    ['D2 COMMIT with no answer (rolled back)', { ok: false, reason: 'unknown', retiredAt: 5, moved: 1 }, { ok: false, code: 'backend-unavailable', error: DELETE_UNKNOWN }, false],
    ['D2 database drops before COMMIT', { ok: false, reason: 'unavailable', detail: 'Connection terminated' }, { ok: false, code: 'backend-unavailable', error: 'the database did not answer or ended the connection (Connection terminated); nothing was removed; try again in a moment' }, false],
    ['D2 statement timeout', { ok: false, reason: 'unavailable', timedOut: true }, { ok: false, code: 'backend-unavailable', error: DELETE_TIMEOUT }, false],
    ['D2 deadline', { ok: false, reason: 'out-of-time' }, { ok: false, code: 'backend-unavailable', error: DELETE_OUT_OF_TIME }, false],
    ['D2 takeover', { ok: false, reason: 'deposed' }, { ok: false, code: 'not-owner', error: DELETE_DEPOSED }, false],
  ])('%s', async (_name, outcome, expected, moves) => {
    const c = await cellGuild({ save: true });
    c.store.retireImpl = async guildId => { if (moves) c.store.retireNow(guildId, 'test'); return outcome; };
    expect(await deleteGuildNamespace(c.g, 'test', 5 * SECOND)).toEqual(expected);
    expect(c.ws.stateOf(c.g)).toBeNull();
    expect(guildDataOpOf(c.g)).toBeUndefined();
    expect(await confirmWrite(c.saved!.ticket, 0)).toBe('ok');
    if (moves) {
      expect(c.store.doc(c.g, 'a.json')).toBeUndefined();
      expect(c.store.graveyard.get(c.g)!.at(-1)!.docs.get(`${c.g}|m/a.json`)).toBe(SAVED);
    } else {
      expect(c.store.doc(c.g, 'a.json')).toBe(SAVED);
      expect(c.store.graveyard.get(c.g)!.map(b => b.retiredAt)).toEqual([5]);
    }
  });

  it('D1 flush not confirmed: refused, nothing evicted, the write lands later', async () => {
    const c = await cellGuild();
    c.store.mode = 'unavailable';
    expect(await deleteGuildNamespace(c.g, 'test', 5 * SECOND)).toEqual({ ok: false, code: 'backend-unavailable', error: DELETE_FLUSH });
    expect(c.ws.stateOf(c.g)).toBe('ready');
    expect(c.store.retireCalls).toEqual([]);
    c.store.mode = 'commit';
    await expectNothingRestored(c);
  });

  it('D1 takeover (deposed flush): refused naming the other process, the set fenced, nothing retired', async () => {
    const c = await cellGuild();
    c.store.mode = 'deposed';
    expect(await deleteGuildNamespace(c.g, 'test', 5 * SECOND)).toEqual({ ok: false, code: 'not-owner', error: DELETE_DEPOSED });
    expect(c.ws.stateOf(c.g)).toBe('fenced');
    expect(c.store.retireCalls).toEqual([]);
    expect(await confirmWrite(c.saved!.ticket, 0)).toBe('deposed');
    expect(c.store.graveyard.get(c.g)!.map(b => b.retiredAt)).toEqual([5]);
  });

  it('D1 maintenance: the gate closes during the flush; the flush lands and nothing is removed', async () => {
    const c = await cellGuild({ holdFlush: true });
    const deleting = deleteGuildNamespace(c.g, 'test', 5 * SECOND);
    await vi.waitFor(() => expect(c.store.flushesSent).toBeGreaterThan(0));
    setMaintenanceGate({ cause: 'hook', message: 'down for a moment' });
    c.store.holding = false;
    c.store.release();
    expect(await restoreThrows(deleting)).toBe('maintenance');
    setMaintenanceGate(null);
    expect(c.store.retireCalls).toEqual([]);
    expect(c.ws.stateOf(c.g)).toBe('ready');
    expect(guildDataOpOf(c.g)).toBeUndefined();
    await expectNothingRestored(c);
  });

  it('D1 restore of G: a restore during the delete\'s flush answers delete running; the delete then moves the write', async () => {
    const c = await cellGuild({ holdFlush: true });
    const deleting = deleteGuildNamespace(c.g, 'test', 5 * SECOND);
    await vi.waitFor(() => expect(c.store.flushesSent).toBeGreaterThan(0));
    expect(await applyOperatorDataWrite(restoreRequest(c.g, 5))).toEqual({ ok: false, code: 'invalid', error: DELETE_RUNNING });
    c.store.holding = false;
    c.store.release();
    expect(await deleting).toEqual({ ok: true });
    expect(c.store.restoreCalls).toEqual([]);
    expect(c.store.graveyard.get(c.g)!.at(-1)!.docs.get(`${c.g}|m/a.json`)).toBe(SAVED);
  });

  it('D2 maintenance: the gate closing while the retire is on the wire leaves its answer standing', async () => {
    const c = await cellGuild();
    const retire = deferred<void>();
    c.store.retireImpl = async guildId => { await retire.promise; return c.store.retireNow(guildId, 'test'); };
    const deleting = deleteGuildNamespace(c.g, 'test', 5 * SECOND);
    await vi.waitFor(() => expect(c.store.retireCalls).toHaveLength(1));
    setMaintenanceGate({ cause: 'hook', message: 'down for a moment' });
    retire.resolve();
    expect(await deleting).toEqual({ ok: true });
    setMaintenanceGate(null);
    expect(c.ws.stateOf(c.g)).toBeNull();
    expect(c.store.graveyard.get(c.g)!.at(-1)!.docs.get(`${c.g}|m/a.json`)).toBe(SAVED);
  });

  it('a crash after the restore committed: a new manager reads the restored rows', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.bury(g, 5, { 'a.json': { v: 'restored' } });
    expect(await restoreGuildFromGraveyard(g, 5)).toMatchObject({ ok: true });
    const next = initWorkingSet(store);
    expect(await next.hydrate(g, { nodeId: 'node-a', claim: 8, processId: 'process-a', shardId: 0, shardCount: 1 })).toBe('ready');
    expect(next.read(g, 'm', 'a.json')).toEqual({ status: 'ready', value: { v: 'restored' } });
  });
});

describe('admission by the set\'s state (decision 9)', () => {
  it('a frozen-retained set: the restore and the delete answer frozen, and nothing is flushed, restored or retired', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    expect(saveDataTracked('a.json', opts(g), { v: 1 }).outcome).toBe('saved');
    await ws.unloadToFrozenRetained(g);
    expect(ws.stateOf(g)).toBe('frozen-retained');
    expect(store.doc(g, 'a.json')).toBe(JSON.stringify({ v: 1 }, null, 2));
    store.bury(g, 5, { 'r.json': { v: 'restored' } });
    const flushes = store.flushesSent;
    expect(await restoreGuildFromGraveyard(g, 5)).toEqual({ ok: false, code: 'frozen' });
    expect(await applyOperatorDataWrite(restoreRequest(g, 5))).toEqual({ ok: false, code: 'frozen' });
    expect(await applyOperatorDataWrite(deleteRequest(g))).toEqual({ ok: false, code: 'frozen' });
    expect(store.restoreCalls).toEqual([]);
    expect(store.retireCalls).toEqual([]);
    expect(store.flushesSent).toBe(flushes);
    expect(guildDataOpOf(g)).toBeUndefined();
    expect(ws.stateOf(g)).toBe('frozen-retained');
    expect(store.doc(g, 'a.json')).toBe(JSON.stringify({ v: 1 }, null, 2));
    expect(store.doc(g, 'r.json')).toBeUndefined();
    expect(store.graveyard.get(g)!.map(b => b.retiredAt)).toEqual([5]);
  });

  it('a set still hydrating: the restore answers not loaded and leaves the set to its read', async () => {
    const { store, ws } = setup();
    const g = freshGuild();
    store.docs.set(`${g}|m/a.json`, JSON.stringify({ v: 'stored' }));
    store.bury(g, 5, { 'r.json': { v: 'restored' } });
    store.hydrateMode = 'held';
    const hydrating = ws.hydrate(g, { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 });
    await vi.waitFor(() => expect(store.hydrationsSent).toBe(1));
    expect(ws.stateOf(g)).toBe('hydrating');
    expect(await restoreGuildFromGraveyard(g, 5)).toEqual({ ok: false, code: 'backend-unavailable', error: NOT_LOADED });
    expect(store.restoreCalls).toEqual([]);
    expect(guildDataOpOf(g)).toBeUndefined();
    expect(ws.stateOf(g)).toBe('hydrating');
    store.releaseHydrations('ok');
    expect(await hydrating).toBe('ready');
    expect(ws.read(g, 'm', 'a.json')).toEqual({ status: 'ready', value: { v: 'stored' } });
    expect(store.doc(g, 'r.json')).toBeUndefined();
    expect(store.graveyard.get(g)!.map(b => b.retiredAt)).toEqual([5]);
  });
});

// Last: the exit drain closes the facade for the rest of this file.
describe('the exit', () => {
  it('restart or operator stop at each phase: P1 and P2 refuse node-stopping, P3 answers, D1 and D2 go on, P0 refuses', async () => {
    const { store, ws } = setup();
    const SAVED = JSON.stringify({ v: 1 }, null, 2);
    const [p1, p2, p3, d1, d2, p0] = [await readyGuild(ws), await readyGuild(ws), await readyGuild(ws), await readyGuild(ws), await readyGuild(ws), await readyGuild(ws)];
    for (const g of [p1, p2, p3, p0]) store.bury(g, 5, { 'r.json': { v: 'restored' } });
    for (const g of [p2, p3, d2]) {
      saveDataTracked('a.json', opts(g), { v: 1 });
      expect(await ws.flushGuildNow(g, SECOND)).toBe('ok');
    }
    const afterClose = deferred<void>();
    const commitP3 = deferred<void>();
    const retireD2 = deferred<void>();
    store.restoreImpl = async (g, _r, _t, beforeCommit) => {
      if (g === p3) {
        expect(beforeCommit()).toBeNull();
        await commitP3.promise;
      } else {
        await afterClose.promise;
        const stop = beforeCommit();
        if (stop) return { ok: false, reason: stop };
      }
      const batch = store.graveyard.get(g)!.find(b => b.retiredAt === 5)!;
      store.moveBack(g, batch);
      return { ok: true, moved: 1, retiredAt: 5, reason: 'r' };
    };
    store.retireImpl = async (g, reason) => {
      if (g === d2) await retireD2.promise;
      return store.retireNow(g, reason);
    };
    const runningP2 = restoreGuildFromGraveyard(p2, 5).catch(e => e);
    const runningP3 = restoreGuildFromGraveyard(p3, 5);
    const runningD2 = deleteGuildNamespace(d2, 'test', 5 * SECOND);
    await vi.waitFor(() => expect(store.restoreCalls.map(c => c[0]).sort()).toEqual([p2, p3].sort()));
    await vi.waitFor(() => expect(store.retireCalls.map(c => c[0])).toEqual([d2]));
    store.holding = true;
    const p1Saved = saveDataTracked('a.json', opts(p1), { v: 1 }) as { ticket: WriteTicket };
    const d1Saved = saveDataTracked('a.json', opts(d1), { v: 1 }) as { ticket: WriteTicket };
    const runningP1 = restoreGuildFromGraveyard(p1, 5).catch(e => e);
    const runningD1 = deleteGuildNamespace(d1, 'test', 5 * SECOND);
    await vi.waitFor(() => expect(store.flushesSent).toBeGreaterThanOrEqual(5));

    const drain = drainForExit(2 * SECOND);
    store.holding = false;
    store.release();
    await drain;
    expect(ws.stateOf(p3)).toBe('restoring');
    expect(guildDataOpOf(d2)).toBe('delete');

    afterClose.resolve();
    for (const running of [runningP1, runningP2]) {
      const thrown = await running;
      expect(thrown.causeKey).toBe('node-stopping');
      expect(thrown.message).toBe('[Data] This process is stopping; nothing was restored');
    }
    for (const g of [p1, p2]) {
      expect(ws.stateOf(g)).toBe('ready');
      expect(store.doc(g, 'a.json')).toBe(SAVED);
      expect(store.doc(g, 'r.json')).toBeUndefined();
      expect(store.graveyard.get(g)!.map(b => b.retiredAt)).toEqual([5]);
    }
    expect(await confirmWrite(p1Saved.ticket, 0)).toBe('ok');

    commitP3.resolve();
    expect(await runningP3).toMatchObject({ ok: true, retiredAt: 5 });
    expect(ws.stateOf(p3)).toBeNull();
    expect(store.doc(p3, 'r.json')).toBe(JSON.stringify({ v: 'restored' }));

    expect(await runningD1).toEqual({ ok: true });
    expect(await confirmWrite(d1Saved.ticket, 0)).toBe('ok');
    expect(store.graveyard.get(d1)!.at(-1)!.docs.get(`${d1}|m/a.json`)).toBe(SAVED);
    retireD2.resolve();
    expect(await runningD2).toEqual({ ok: true });
    expect(store.graveyard.get(d2)!.at(-1)!.docs.get(`${d2}|m/a.json`)).toBe(SAVED);

    const flushes = store.flushesSent;
    const thrown: any = await restoreGuildFromGraveyard(p0, 5).catch(e => e);
    expect(thrown.causeKey).toBe('node-stopping');
    expect(store.flushesSent).toBe(flushes);
    expect(store.graveyard.get(p0)!.map(b => b.retiredAt)).toEqual([5]);
    expect(ws.stateOf(p0)).toBe('ready');
  }, 20_000);

});
