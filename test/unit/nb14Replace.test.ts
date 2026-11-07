import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken, GuildFlushBatch, LateCommit, RestoreOutcome, RestoreStop, RetireOutcome } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { initDataReadiness, type DataReadinessDriver } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import {
  appendDataTracked,
  confirmWrite,
  deleteDataTracked,
  deleteGuildNamespace,
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
import { LEASED } from '../helpers/readinessRig';

// NB14 test 1 (wip-redesign/sheets/NB14.md) and the check's row 8: a restore that replaces a server's data on
// Postgres, over a real WorkingSetManager and readiness driver. The scripted backend models the copy-in and the
// move-out: a restore copies batch X in and keeps it, a replace first moves the live rows into a new batch R.

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
const MAIN = 'The list reads the data of the bot behind the web panel it asks; if the main database was replaced meanwhile, check once that bot runs on the new main.';
const tail = (g: string, x: number) => `Entry ${x} stays listed either way, unless it had passed the graveyard's keep time (GRAVEYARD_TTL_DAYS, 14 days by default) and the graveyard sweep removed it, data and all. Running smdb graveyard restore ${g} ${x} --replace is then safe: it copies entry ${x} in and moves whatever the server holds into a new entry, so nothing is lost.`;
const liveText = (g: string, x: number) => `server ${g} has data saved since entry ${x} was deleted; nothing was restored. To put entry ${x} in place and move the current data to the graveyard as a new entry, run: smdb graveyard restore ${g} ${x} --replace`;
const unknownMoved = (g: string, x: number, r: number) => `can't confirm whether server ${g} was restored: the database did not confirm the commit. Within a minute, if it was restored, \`smdb graveyard list\` lists entry ${r}, which holds the server's data from before, and entry ${x} was copied in; if not, no entry ${r} is listed and nothing changed. ${tail(g, x)} ${MAIN}`;
const unknownPlain = (g: string, x: number, noData = false) => `can't confirm whether server ${g} was restored: the database did not confirm the commit; the outcome is fixed within a minute.${noData ? ' The server had no data, so no entry was added.' : ''} ${tail(g, x)} ${MAIN}`;
const lateText = (g: string, x: number, late: LateCommit, r?: number) => `${late.committed
  ? `can't confirm whether server ${g} was restored on the main database: ${late.old} confirmed the restore only after this process stopped writing there (${late.why}).`
  : `can't confirm whether server ${g} was restored: the database did not confirm the commit, and this process stopped writing to ${late.old} while it waited (${late.why}).`}${r === undefined ? '' : ` If the restore landed on ${late.old}, the server's data from before is entry ${r} there.`} Once the bot runs on the main database, run: smdb graveyard restore ${g} ${x} --replace. It is safe whether or not this restore reached that database: it copies entry ${x} in and moves whatever the server holds into a new entry, so nothing is lost; if that database lists no entry ${x}, the restore answers "no graveyard entry for this guild" and changes nothing.`;
const CHANGED = "the server's data changed during the replace; nothing was restored; try again in a moment";
const incompleteText = (put: number, taken: number) => `the restore stopped: the database put ${put} of ${taken} row(s) in place; nothing was restored; see the bot log`;
const NO_ENTRY = 'no graveyard entry for this guild';
const ALREADY_RUNNING = 'a restore of this server is already running; nothing was restored; its answer comes within a minute';
const REPLACE_INVALID = 'replace must be true or false';

type RestoreArgs = [guildId: string, retiredAt: number | null, token: FenceToken, beforeCommit: () => RestoreStop | null, deadline: bigint, replace?: boolean];
type Batch = { retiredAt: number; reason: string; usedAt?: number; docs: Map<string, string>; streams: Map<string, string> };

/** FakeStore with a graveyard whose restore copies a batch in and keeps it, and whose replace moves the live rows out first. */
class ReplaceStore extends FakeStore {
  readonly graveyard = new Map<string, Batch[]>();
  readonly order: string[] = [];
  readonly restoreCalls: RestoreArgs[] = [];
  restoreImpl: ((...args: RestoreArgs) => Promise<RestoreOutcome>) | null = null;
  /** The database's clock ahead of this process's (negative: behind). */
  skew = 0;

  now(): number {
    return Date.now() + this.skew;
  }

  override async flushGuild(guildId: string, batch: GuildFlushBatch, token: FenceToken) {
    this.order.push(`flush:${batch.upserts.map(u => u.key.filename).join(',')}`);
    return super.flushGuild(guildId, batch, token);
  }

  override async restoreGuild(...args: RestoreArgs): Promise<RestoreOutcome> {
    this.order.push('restore');
    this.restoreCalls.push(args);
    if (this.restoreImpl) return this.restoreImpl(...args);
    const [guildId, retiredAt, , beforeCommit, , replace = false] = args;
    const plan = this.plan(guildId, retiredAt, replace);
    if (!plan.ok) return plan.answer;
    const stop = beforeCommit();
    if (stop) return { ok: false, reason: stop };
    return this.commit(guildId, plan.batch, replace);
  }

  plan(guildId: string, retiredAt: number | null, replace: boolean): { ok: true; batch: Batch } | { ok: false; answer: RestoreOutcome } {
    const batches = this.graveyard.get(guildId) ?? [];
    const batch = retiredAt === null ? [...batches].sort((a, b) => a.retiredAt - b.retiredAt).at(-1) : batches.find(b => b.retiredAt === retiredAt);
    if (!batch) return { ok: false, answer: { ok: false, reason: 'no-entry' } };
    if (!replace && this.liveRows(guildId).length > 0) return { ok: false, answer: { ok: false, reason: 'live-rows', retiredAt: batch.retiredAt } };
    return { ok: true, batch };
  }

  /** The committed transaction: the move-out (replace), then the copy-in stamping X. */
  commit(guildId: string, batch: Batch, replace: boolean): Extract<RestoreOutcome, { ok: true }> {
    let replaced: { retiredAt: number; moved: number; reason: string } | null = null;
    if (replace) {
      const moved = this.retireNow(guildId, `replaced-by-restore-${batch.retiredAt}`);
      if (moved.ok && moved.moved > 0) replaced = { retiredAt: moved.retiredAt, moved: moved.moved, reason: `replaced-by-restore-${batch.retiredAt}` };
    }
    for (const [row, doc] of batch.docs) this.docs.set(row, doc);
    for (const [row, chunk] of batch.streams) this.streams.set(row, chunk);
    batch.usedAt = this.now();
    return { ok: true, copied: batch.docs.size + batch.streams.size, retiredAt: batch.retiredAt, reason: batch.reason, usedAt: batch.usedAt, ...(replace ? { replaced } : {}) };
  }

  liveRows(guildId: string): string[] {
    return [...this.docs.keys(), ...this.streams.keys()].filter(row => row.startsWith(`${guildId}|`));
  }

  /** MOVE_OUT_SQL: every live row of the guild into one new batch, named above every batch of the guild. */
  retireNow(guildId: string, reason: string): RetireOutcome {
    const own = (row: string) => row.startsWith(`${guildId}|`);
    const docs = new Map([...this.docs].filter(([row]) => own(row)));
    const streams = new Map([...this.streams].filter(([row]) => own(row)));
    const list = this.graveyard.get(guildId) ?? [];
    const retiredAt = Math.max(this.now(), ...list.map(b => b.retiredAt + 1));
    if (docs.size + streams.size === 0) return { ok: true, moved: 0, retiredAt };
    for (const row of docs.keys()) this.docs.delete(row);
    for (const row of streams.keys()) this.streams.delete(row);
    list.push({ retiredAt, reason, docs, streams });
    this.graveyard.set(guildId, list);
    return { ok: true, moved: docs.size + streams.size, retiredAt };
  }

  override async retireGuild(guildId: string, reason: string): Promise<RetireOutcome> {
    return this.retireNow(guildId, reason);
  }

  bury(guildId: string, retiredAt: number, docs: Record<string, unknown>, streams: Record<string, string> = {}): Batch {
    const list = this.graveyard.get(guildId) ?? [];
    const batch: Batch = {
      retiredAt, reason: 'webui-operator-delete',
      docs: new Map(Object.entries(docs).map(([f, v]) => [`${guildId}|m/${f}`, JSON.stringify(v, null, 2)])),
      streams: new Map(Object.entries(streams).map(([f, v]) => [`${guildId}|m/${f}`, v])),
    };
    list.push(batch);
    this.graveyard.set(guildId, list);
    return batch;
  }

  batchOf(guildId: string, retiredAt: number): Batch | undefined {
    return this.graveyard.get(guildId)?.find(b => b.retiredAt === retiredAt);
  }
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};
const opts = (guildId: string) => ({ guildId, category: 'm' });
const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(c => c.map(String).join(' '));
const pretty = (v: unknown) => JSON.stringify(v, null, 2);

let drivers: DataReadinessDriver[] = [];
let warn: ReturnType<typeof vi.spyOn>;
const TTL_BEFORE = process.env.GRAVEYARD_TTL_DAYS;

function setup(): { store: ReplaceStore; ws: WorkingSetManager; driver: DataReadinessDriver } {
  const store = new ReplaceStore();
  const ws = initWorkingSet(store);
  const driver = initDataReadiness(store, ws, { held: false });
  drivers.push(driver);
  driver.onLeaseChanged({ ...LEASED, claims: { 0: 7 } });
  setGuildDataBackend(store);
  setOwnerInfoProvider(() => ({ nodeId: 'node-a', processId: 'process-a', shardCount: 1, claimOf: () => 7 }));
  setBackendKind('postgres');
  return { store, ws, driver };
}

async function readyGuild(ws: WorkingSetManager): Promise<string> {
  const guildId = freshGuild();
  expect(await ws.hydrate(guildId, { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 })).toBe('ready');
  return guildId;
}

const restoreRequest = (guildId: string, body: Record<string, unknown>) => ({
  guildId, module: '', filename: '', op: 'restore-graveyard' as const, contentJson: JSON.stringify(body),
});
const setOf = (ws: WorkingSetManager, guildId: string) => (ws as unknown as { sets: Map<string, unknown> }).sets.get(guildId);

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setMaintenanceGate(null);
  for (const driver of drivers.splice(0)) driver.stop();
  setGuildDataBackend(null);
  if (TTL_BEFORE === undefined) delete process.env.GRAVEYARD_TTL_DAYS;
  else process.env.GRAVEYARD_TTL_DAYS = TTL_BEFORE;
});

describe('the mode', () => {
  it('a replace passes the mode and the chosen entry', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.bury(g, 5, { 'a.json': { v: 1 } });
    expect(await applyOperatorDataWrite(restoreRequest(g, { retiredAt: 5, replace: true }))).toMatchObject({ ok: true, retiredAt: 5 });
    expect(store.restoreCalls).toHaveLength(1);
    expect(store.restoreCalls[0][0]).toBe(g);
    expect(store.restoreCalls[0][1]).toBe(5);
    expect(store.restoreCalls[0][5]).toBe(true);
  });

  it.each([['the string "true"', 'true'], ['1', 1], ['null', null]] as const)('replace as %s answers invalid and calls nothing', async (_name, value) => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    expect(await applyOperatorDataWrite(restoreRequest(g, { retiredAt: 5, replace: value }))).toEqual({ ok: false, code: 'invalid', error: REPLACE_INVALID });
    expect(store.restoreCalls).toEqual([]);
    expect(store.order).toEqual([]);
  });

  it('replace false or absent is a plain restore', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.bury(g, 5, { 'a.json': { v: 1 } });
    await applyOperatorDataWrite(restoreRequest(g, { retiredAt: 5, replace: false }));
    expect(store.restoreCalls[0][5]).toBe(false);
  });
});

describe('the live-data refusal', () => {
  it('is a field with the entry, beside the text', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.restoreImpl = async () => ({ ok: false, reason: 'live-rows', retiredAt: 5 });
    expect(await applyOperatorDataWrite(restoreRequest(g, {}))).toEqual({ ok: false, code: 'invalid', refusal: 'live-data', retiredAt: 5, error: liveText(g, 5) });
  });

  it("no-entry, already running and the schema mismatch carry no refusal", async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.restoreImpl = async () => ({ ok: false, reason: 'no-entry' });
    const noEntry = await applyOperatorDataWrite(restoreRequest(g, {}));
    expect(noEntry).toEqual({ ok: false, code: 'invalid', error: NO_ENTRY });
    store.restoreImpl = async () => ({ ok: false, reason: 'schema-mismatch' });
    expect(await applyOperatorDataWrite(restoreRequest(g, {}))).not.toHaveProperty('refusal');
    const hold = deferred<RestoreOutcome>();
    store.restoreImpl = () => hold.promise;
    const first = applyOperatorDataWrite(restoreRequest(g, {}));
    await vi.waitFor(() => expect(store.restoreCalls).toHaveLength(3));
    expect(await applyOperatorDataWrite(restoreRequest(g, {}))).not.toHaveProperty('refusal');
    hold.resolve({ ok: false, reason: 'no-entry' });
    await first;
  });
});

describe('writes before, during and after the replace', () => {
  it('a write accepted before the replace moves into the new entry', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.bury(g, 5, { 'a.json': { v: 'x' } });
    expect(saveDataTracked('b.json', opts(g), { v: 1 }).outcome).toBe('saved');
    const answer = await restoreGuildFromGraveyard(g, 5, undefined, true);
    expect(answer).toMatchObject({ ok: true, retiredAt: 5 });
    expect(store.order).toEqual(['flush:b.json', 'restore']);
    const r = (answer as { replaced: { retiredAt: number } }).replaced.retiredAt;
    expect(store.batchOf(g, r)?.docs.get(`${g}|m/b.json`)).toBe(pretty({ v: 1 }));
    expect(store.batchOf(g, r)?.reason).toBe('replaced-by-restore-5');
  });

  it('writes during the replace are refused; another guild\'s are accepted', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    const other = await readyGuild(ws);
    const hold = deferred<RestoreOutcome>();
    store.restoreImpl = () => hold.promise;
    const restoring = restoreGuildFromGraveyard(g, 5, undefined, true);
    await vi.waitFor(() => expect(store.restoreCalls).toHaveLength(1));
    warn.mockClear();
    const fn = vi.fn((v: unknown) => v);
    const results = runInLedger(openLedger('panel'), 'm', () => ({
      save: saveDataTracked('a.json', opts(g), { v: 2 }),
      append: appendDataTracked('l.jsonl', opts(g), 'x\n'),
      del: deleteDataTracked('a.json', opts(g)),
      update: updateData('b.json', opts(g), {}, fn),
    }));
    for (const result of Object.values(results)) expect(result).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(lines(warn)).toEqual(['Write', 'Append', 'Delete', 'Update'].map(w => `[Data] ${w} for guild ${g} refused: its data is being restored from the graveyard`));
    expect(saveDataTracked('a.json', opts(other), { v: 1 }).outcome).toBe('saved');
    hold.resolve({ ok: false, reason: 'no-entry' });
    await restoring;
  });

  it.each([
    ['a plain restore answering ok', false, 'ok'],
    ['a replace answering ok', true, 'ok'],
    ['a plain restore answering unknown', false, 'unknown'],
    ['a replace answering unknown', true, 'unknown'],
  ] as const)('a command that read before %s cannot save or append after it', async (_name, replace, end) => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    if (replace) {
      saveDataTracked('a.json', opts(g), { v: 'before' });
      await ws.flushGuildNow(g, SECOND);
    }
    const batch = store.bury(g, 5, { 'a.json': { v: 'restored' } }, { 'l.jsonl': 'restored\n' });
    const gate = deferred<void>();
    const oldRun = runInLedger(openLedger('interaction'), 'm', async () => {
      loadData('a.json', opts(g), { v: 'default' });
      await gate.promise;
      return { save: saveDataTracked('a.json', opts(g), { v: 'stale' }), append: appendDataTracked('l.jsonl', opts(g), 'stale\n') };
    });
    if (end === 'unknown') {
      store.restoreImpl = async (guildId, _x, _t, _b, _d, mode = false) => {
        const done = store.commit(guildId, batch, mode);
        return { ok: false, reason: 'unknown', retiredAt: 5, ...(mode ? { replaced: done.replaced ?? null } : {}) };
      };
    }
    await applyOperatorDataWrite(restoreRequest(g, { retiredAt: 5, replace }));
    await vi.waitFor(() => expect(ws.stateOf(g)).toBe('ready'));
    warn.mockClear();
    gate.resolve();
    const r = await oldRun;
    expect(r.save).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(r.append).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(lines(warn)).toEqual([
      `[Data] Write for guild ${g} refused: it comes from a command that started before the server's data was restored from the graveyard`,
      `[Data] Append for guild ${g} refused: it comes from a command that started before the server's data was restored from the graveyard`,
    ]);
    expect(loadData('a.json', opts(g), null)).toEqual({ v: 'restored' });
    await ws.flushGuildNow(g, SECOND);
    expect(store.streams.get(`${g}|m/l.jsonl`)).toBe('restored\n');
    expect(store.doc(g, 'a.json')).toBe(pretty({ v: 'restored' }));
  });
});

describe('the ok answer', () => {
  it('a replace names the entry it made, with its reason; keptUntil is the stamp plus the TTL', async () => {
    process.env.GRAVEYARD_TTL_DAYS = '2';
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    saveDataTracked('a.json', opts(g), { v: 'before' });
    await ws.flushGuildNow(g, SECOND);
    store.bury(g, 5, { 'a.json': { v: 'x' } });
    const answer = await restoreGuildFromGraveyard(g, 5, undefined, true);
    const usedAt = store.batchOf(g, 5)!.usedAt!;
    const r = Math.max(...store.graveyard.get(g)!.map(b => b.retiredAt));
    expect(answer).toEqual({ ok: true, retiredAt: 5, reason: 'webui-operator-delete', copied: 1, keptUntil: usedAt + 2 * DAY, replaced: { retiredAt: r, moved: 1, reason: 'replaced-by-restore-5' } });
    expect(r).toBeGreaterThan(5);
  });

  it('a replace of a server with no data answers replaced null and adds no entry', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.bury(g, 5, { 'a.json': { v: 'x' } });
    const answer = await restoreGuildFromGraveyard(g, 5, undefined, true);
    expect(answer).toMatchObject({ ok: true, retiredAt: 5, copied: 1, replaced: null });
    expect(store.graveyard.get(g)!.map(b => b.retiredAt)).toEqual([5]);
  });

  it("a plain restore's ok has copied and keptUntil and no replaced", async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.bury(g, 5, { 'a.json': { v: 'x' } });
    const answer = await restoreGuildFromGraveyard(g, 5);
    expect(answer).toEqual({ ok: true, retiredAt: 5, reason: 'webui-operator-delete', copied: 1, keptUntil: store.batchOf(g, 5)!.usedAt! + 14 * DAY });
    expect(store.batchOf(g, 5)).toBeDefined();
  });
});

describe('every refusal leaves the set and the data', () => {
  it.each([
    ['no-entry', { ok: false, reason: 'no-entry' }, { ok: false, code: 'invalid', error: NO_ENTRY }],
    ['changed', { ok: false, reason: 'changed' }, { ok: false, code: 'invalid', error: CHANGED }],
    ['incomplete', { ok: false, reason: 'incomplete', step: 'copy-in', taken: 3, put: 2 }, { ok: false, code: 'backend-unavailable', error: incompleteText(2, 3) }],
    ['refused', { ok: false, reason: 'refused', detail: 'SQLSTATE 23505', code: '23505' }, { ok: false, code: 'backend-unavailable' }],
    ['unavailable', { ok: false, reason: 'unavailable', detail: 'gone' }, { ok: false, code: 'backend-unavailable' }],
    ['out-of-time', { ok: false, reason: 'out-of-time' }, { ok: false, code: 'backend-unavailable' }],
    ['maintenance', { ok: false, reason: 'maintenance' }, { ok: false, code: 'maintenance' }],
    ['node-stopping', { ok: false, reason: 'node-stopping' }, { ok: false }],
  ] as const)('%s: the set reopens, the same object, its docs unchanged', async (_name, outcome, reply) => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    saveDataTracked('a.json', opts(g), { v: 'mine' });
    await ws.flushGuildNow(g, SECOND);
    const before = setOf(ws, g);
    store.restoreImpl = async () => outcome as RestoreOutcome;
    expect(await applyOperatorDataWrite(restoreRequest(g, { retiredAt: 5, replace: true }))).toMatchObject(reply);
    expect(setOf(ws, g)).toBe(before);
    expect(ws.stateOf(g)).toBe('ready');
    expect(loadData('a.json', opts(g), null)).toEqual({ v: 'mine' });
    expect(store.doc(g, 'a.json')).toBe(pretty({ v: 'mine' }));
  });

  it('unknown after a move-out that moved rows: evicted, the text names X and R', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    const before = setOf(ws, g);
    store.restoreImpl = async () => ({ ok: false, reason: 'unknown', retiredAt: 5, replaced: { retiredAt: 900, moved: 2, reason: 'replaced-by-restore-5' } });
    expect(await restoreGuildFromGraveyard(g, 5, undefined, true)).toEqual({ ok: false, code: 'backend-unavailable', error: unknownMoved(g, 5, 900) });
    expect(setOf(ws, g)).not.toBe(before);
  });

  it('unknown after a move-out that moved nothing names no R and says the server had no data', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.restoreImpl = async () => ({ ok: false, reason: 'unknown', retiredAt: 5, replaced: null });
    expect(await restoreGuildFromGraveyard(g, 5, undefined, true)).toEqual({ ok: false, code: 'backend-unavailable', error: unknownPlain(g, 5, true) });
    store.restoreImpl = async () => ({ ok: false, reason: 'unknown', retiredAt: 5 });
    const g2 = await readyGuild(ws);
    expect(await restoreGuildFromGraveyard(g2, 5)).toEqual({ ok: false, code: 'backend-unavailable', error: unknownPlain(g2, 5) });
  });
});

describe('the late answers name the entry and the safe command (C6)', () => {
  const late = (committed: boolean): LateCommit => ({ committed, old: 'db-old:5432', why: 'the main database was replaced' });
  it.each([
    ['committed, a replace that moved rows', true, true],
    ['committed, a plain restore', true, false],
    ['not committed, a replace that moved rows', false, true],
    ['not committed, a plain restore', false, false],
  ] as const)('%s', async (_name, committed, replace) => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.restoreImpl = async () => ({
      ok: false, reason: 'unknown', retiredAt: 5, afterLatch: true, late: late(committed),
      ...(replace ? { replaced: { retiredAt: 900, moved: 2, reason: 'replaced-by-restore-5' } } : {}),
    });
    expect(await restoreGuildFromGraveyard(g, 5, undefined, replace)).toEqual({ ok: false, code: 'backend-unavailable', error: lateText(g, 5, late(committed), replace ? 900 : undefined) });
  });
});

describe('the IPC reply carries the new fields (C14)', () => {
  it('a replace answered ok passes keptUntil, copied and replaced, and has no moved', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    saveDataTracked('a.json', opts(g), { v: 'before' });
    await ws.flushGuildNow(g, SECOND);
    store.bury(g, 5, { 'a.json': { v: 'x' } });
    const reply = await applyOperatorDataWrite(restoreRequest(g, { retiredAt: 5, replace: true }));
    const usedAt = store.batchOf(g, 5)!.usedAt!;
    const r = Math.max(...store.graveyard.get(g)!.map(b => b.retiredAt));
    expect(reply).toStrictEqual({ ok: true, retiredAt: 5, reason: 'webui-operator-delete', keptUntil: usedAt + 14 * DAY, copied: 1, replaced: { retiredAt: r, moved: 1, reason: 'replaced-by-restore-5' } });
    expect(reply).not.toHaveProperty('moved');
  });

  it('a replace whose folder sync failed passes moveUnconfirmed beside them', async () => {
    const answer = { ok: true, retiredAt: 5, reason: 'webui-operator-delete', keptUntil: 99, replaced: { retiredAt: 7, reason: 'replaced-by-restore-5' }, moveUnconfirmed: 'EIO' };
    vi.resetModules();
    vi.doMock('../../src/bot/internalSetup/utils/dataManager', async orig => ({ ...(await orig<object>()), restoreGuildFromGraveyard: async () => answer }));
    vi.doMock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => ({ ...(await orig<object>()), awaitGuildDataReady: async () => true }));
    try {
      const fresh = await import('../../src/bot/internalSetup/utils/ipcDataHandler');
      const reply = await fresh.applyOperatorDataWrite(restoreRequest('42', { retiredAt: 5, replace: true }));
      expect(reply).toStrictEqual({ ok: true, retiredAt: 5, reason: 'webui-operator-delete', keptUntil: 99, replaced: { retiredAt: 7, reason: 'replaced-by-restore-5' }, moveUnconfirmed: 'EIO' });
      expect(reply).not.toHaveProperty('moved');
    } finally {
      vi.doUnmock('../../src/bot/internalSetup/utils/dataManager');
      vi.doUnmock('../../src/bot/internalSetup/utils/dataBackends/boot');
      vi.resetModules();
    }
  });
});

describe('the state x exit table (Postgres cells)', () => {
  type Cell = {
    name: string; flush?: 'unavailable' | 'deposed'; outcome?: RestoreOutcome; gate?: boolean;
    impl?: (store: ReplaceStore) => (...args: RestoreArgs) => Promise<RestoreOutcome>;
    reply: object; set: 'reopen' | 'evict' | 'fenced'; store: 'same' | 'restored';
    text?: (g: string, r: number) => string;
  };
  const late = (committed: boolean): LateCommit => ({ committed, old: 'db-old:5432', why: 'the main database was replaced' });
  const R900 = { retiredAt: 900, moved: 1, reason: 'replaced-by-restore-5' };
  const second: object[] = [];
  const cells: Cell[] = [
    { name: 'P0 maintenance', gate: true, reply: { ok: false, code: 'maintenance' }, set: 'reopen', store: 'same' },
    {
      name: 'P0 resume: a second restore is already running',
      impl: store => async (...args) => {
        second.push(await applyOperatorDataWrite(restoreRequest(args[0], { retiredAt: 5, replace: true })));
        const plan = store.plan(args[0], args[1], true);
        return plan.ok ? store.commit(args[0], plan.batch, true) : plan.answer;
      },
      reply: { ok: true, retiredAt: 5 }, set: 'evict', store: 'restored',
    },
    { name: 'P1 flush unavailable', flush: 'unavailable', reply: { ok: false, code: 'backend-unavailable' }, set: 'reopen', store: 'same' },
    { name: 'P1 flush deposed', flush: 'deposed', reply: { ok: false, code: 'not-owner' }, set: 'fenced', store: 'same' },
    { name: 'P2a no-entry', outcome: { ok: false, reason: 'no-entry' }, reply: { ok: false, code: 'invalid', error: NO_ENTRY }, set: 'reopen', store: 'same' },
    { name: 'P2a database drops', outcome: { ok: false, reason: 'unavailable', detail: 'gone' }, reply: { ok: false }, set: 'reopen', store: 'same' },
    { name: 'P2a takeover', outcome: { ok: false, reason: 'deposed' }, reply: { ok: false, code: 'not-owner' }, set: 'fenced', store: 'same' },
    { name: 'P2a deadline', outcome: { ok: false, reason: 'out-of-time' }, reply: { ok: false, code: 'backend-unavailable' }, set: 'reopen', store: 'same' },
    { name: 'P2b changed', outcome: { ok: false, reason: 'changed' }, reply: { ok: false, code: 'invalid', error: CHANGED }, set: 'reopen', store: 'same' },
    { name: 'P2b incomplete', outcome: { ok: false, reason: 'incomplete', step: 'move-out', taken: 3, put: 2 }, reply: { ok: false, code: 'backend-unavailable', error: incompleteText(2, 3) }, set: 'reopen', store: 'same' },
    { name: 'P2b maintenance', outcome: { ok: false, reason: 'maintenance' }, reply: { ok: false, code: 'maintenance' }, set: 'reopen', store: 'same' },
    { name: 'P2b refused', outcome: { ok: false, reason: 'refused', detail: 'x' }, reply: { ok: false, code: 'backend-unavailable' }, set: 'reopen', store: 'same' },
    { name: 'P2b restart', outcome: { ok: false, reason: 'node-stopping' }, reply: { ok: false, code: 'backend-unavailable', error: '[Data] This process is stopping; nothing was restored' }, set: 'reopen', store: 'same' },
    { name: 'P2b crash: the session ends before COMMIT', outcome: { ok: false, reason: 'unavailable' }, reply: { ok: false }, set: 'reopen', store: 'same' },
    {
      name: 'a throw out of restoreGuild (NB11 D4)',
      impl: () => async () => { throw new Error('Connection terminated unexpectedly'); },
      reply: { ok: false, code: 'backend-unavailable' }, set: 'evict', store: 'same',
    },
    { name: 'P3 unknown', outcome: { ok: false, reason: 'unknown', retiredAt: 5, replaced: R900 }, reply: { ok: false, code: 'backend-unavailable' }, set: 'evict', store: 'same' },
    {
      name: 'P3 late, committed',
      outcome: { ok: false, reason: 'unknown', retiredAt: 5, afterLatch: true, late: late(true), replaced: R900 },
      reply: { ok: false, code: 'backend-unavailable', error: '' }, set: 'evict', store: 'same',
    },
    {
      name: 'P3 late, not committed',
      outcome: { ok: false, reason: 'unknown', retiredAt: 5, afterLatch: true, late: late(false), replaced: R900 },
      reply: { ok: false, code: 'backend-unavailable', error: '' }, set: 'evict', store: 'same',
    },
    {
      name: 'P3 crash: COMMIT landed, its answer lost',
      impl: store => async (...args) => {
        const plan = store.plan(args[0], args[1], true);
        if (!plan.ok) return plan.answer;
        const done = store.commit(args[0], plan.batch, true);
        return { ok: false, reason: 'unknown', retiredAt: 5, replaced: done.replaced ?? null };
      },
      reply: { ok: false, code: 'backend-unavailable' }, set: 'evict', store: 'restored', text: (g, r) => unknownMoved(g, 5, r),
    },
    { name: 'P4 ok', reply: { ok: true, retiredAt: 5 }, set: 'evict', store: 'restored' },
  ];
  it.each(cells.map(c => [c.name, c] as const))('%s', async (_name, cell) => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    saveDataTracked('a.json', opts(g), { v: 'mine' });
    await ws.flushGuildNow(g, SECOND);
    store.bury(g, 5, { 'a.json': { v: 'x' } });
    const before = setOf(ws, g);
    if (cell.flush) {
      saveDataTracked('b.json', opts(g), { v: 1 });
      store.mode = cell.flush;
    }
    if (cell.outcome) store.restoreImpl = async () => cell.outcome!;
    if (cell.impl) store.restoreImpl = cell.impl(store);
    if (cell.gate) setMaintenanceGate({ cause: 'hook', message: 'maintenance' });
    second.length = 0;
    const lateOf = cell.outcome && !cell.outcome.ok && cell.outcome.reason === 'unknown' ? cell.outcome.late : undefined;
    const reply = lateOf ? { ...cell.reply, error: lateText(g, 5, lateOf, 900) } : cell.reply;
    const got = await applyOperatorDataWrite(restoreRequest(g, { retiredAt: 5, replace: true }));
    expect(got).toMatchObject(reply);
    setMaintenanceGate(null);
    if (cell.text) {
      const r = store.graveyard.get(g)!.find(b => b.reason === 'replaced-by-restore-5')!;
      expect(got).toMatchObject({ error: cell.text(g, r.retiredAt) });
    }
    store.mode = 'commit';
    if (cell.gate) expect(store.restoreCalls).toEqual([]);
    if (cell.impl && cell.name.startsWith('P0 resume')) expect(second).toEqual([{ ok: false, code: 'invalid', error: ALREADY_RUNNING }]);
    if (cell.set === 'reopen') expect(setOf(ws, g)).toBe(before);
    if (cell.set === 'fenced') expect(ws.stateOf(g)).toBe('fenced');
    if (cell.set === 'evict') expect(setOf(ws, g)).not.toBe(before);
    expect(store.batchOf(g, 5)?.docs.get(`${g}|m/a.json`)).toBe(pretty({ v: 'x' }));
    expect(store.doc(g, 'a.json')).toBe(pretty(cell.store === 'same' ? { v: 'mine' } : { v: 'x' }));
    if (cell.store === 'restored') {
      const r = store.graveyard.get(g)!.find(b => b.reason === 'replaced-by-restore-5')!;
      expect(r.docs.get(`${g}|m/a.json`)).toBe(pretty({ v: 'mine' }));
    }
  });
});

describe('property: no version or batch is lost', () => {
  type End = 'ok' | 'no-entry' | 'changed' | 'refused' | 'deposed' | 'unavailable' | 'unknown-committed' | 'unknown-not';
  type Op =
    | { kind: 'save'; file: 'a.json' | 'b.json'; v: number }
    | { kind: 'append'; line: number }
    | { kind: 'stale' }
    | { kind: 'other'; v: number }
    | { kind: 'delete' }
    | { kind: 'restore'; replace: boolean; given: boolean; flush: 'ok' | 'held' | 'deposed'; end: End }
    | { kind: 'clock'; days: number }
    | { kind: 'sweep'; aheadDays: number };
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant('save' as const), file: fc.constantFrom('a.json' as const, 'b.json' as const), v: fc.integer({ min: 0, max: 99 }) }),
    fc.record({ kind: fc.constant('append' as const), line: fc.integer({ min: 0, max: 99 }) }),
    fc.record({ kind: fc.constant('stale' as const) }),
    fc.record({ kind: fc.constant('other' as const), v: fc.integer({ min: 0, max: 99 }) }),
    fc.record({ kind: fc.constant('delete' as const) }),
    fc.record({
      kind: fc.constant('restore' as const), replace: fc.boolean(), given: fc.boolean(),
      flush: fc.constantFrom('ok' as const, 'ok' as const, 'held' as const, 'deposed' as const),
      end: fc.constantFrom<End>('ok', 'no-entry', 'changed', 'refused', 'deposed', 'unavailable', 'unknown-committed', 'unknown-not'),
    }),
    fc.record({ kind: fc.constant('clock' as const), days: fc.integer({ min: -20, max: 20 }) }),
    fc.record({ kind: fc.constant('sweep' as const), aheadDays: fc.integer({ min: 0, max: 30 }) }),
  );

  it('every batch stays until its keep time, every stored version and accepted write stays, and R is above every batch before', async () => {
    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async ops => {
      const { store, ws } = setup();
      const g = await readyGuild(ws);
      const other = await readyGuild(ws);
      store.bury(g, 5, { 'a.json': { v: 'buried' } });
      const ttl = 14 * DAY;
      const swept = new Set<Batch>();
      let stale: string | null = null;
      let deleted = false;
      let seq = 0;
      const token = { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 };
      // The last accepted save of each document of G, and every accepted append line, each with its ticket.
      const acceptedDocs = new Map<string, { doc: string; ticket: WriteTicket }>();
      const acceptedLines: Array<{ line: string; ticket: WriteTicket }> = [];
      const save = (file: string, value: unknown) => {
        const answer = saveDataTracked(file, opts(g), value);
        if (answer.outcome === 'saved') acceptedDocs.set(`${g}|m/${file}`, { doc: pretty(value), ticket: answer.ticket });
      };
      const live = () => [...store.docs, ...store.streams].filter(([row]) => row.startsWith(`${g}|`)).map(([row, doc]) => `${row}=${doc}`);
      const batchRows = (batches: Iterable<Batch>) => [...batches].flatMap(b => [...b.docs, ...b.streams].map(([row, doc]) => `${row}=${doc}`));
      const held = () => new Set([...live(), ...batchRows(store.graveyard.get(g) ?? [])]);
      const kept = () => new Set([...held(), ...batchRows(swept)]);
      for (const o of ops) {
        const batchesBefore = [...(store.graveyard.get(g) ?? [])];
        const ready = ws.stateOf(g) === 'ready';
        const versions = o.kind === 'delete' || o.kind === 'restore' ? live() : [];
        if (o.kind === 'save' && ready) save(o.file, { v: o.v });
        if (o.kind === 'append' && ready) {
          const line = `${o.line}-${++seq}`;
          const answer = appendDataTracked('l.jsonl', opts(g), `${line}\n`);
          if (answer.outcome === 'appended') acceptedLines.push({ line, ticket: answer.ticket });
        }
        if (o.kind === 'other') saveDataTracked('a.json', opts(other), { v: o.v });
        if (o.kind === 'stale' && ready && stale !== null) save('a.json', JSON.parse(stale));
        if (o.kind === 'clock') store.skew = o.days * DAY;
        if (o.kind === 'delete' && !deleted && ready) {
          deleted = true;
          await deleteGuildNamespace(g, 'webui-operator-delete', SECOND);
          if (ws.stateOf(g) !== 'ready' && ws.stateOf(g) !== 'fenced') await ws.hydrate(g, token);
        }
        if (o.kind === 'restore' && ready) {
          stale = store.doc(g, 'a.json') ?? null;
          const newest = Math.max(...(store.graveyard.get(g) ?? []).map(b => b.retiredAt));
          const x = o.given ? 5 : null;
          if (o.flush !== 'ok') {
            save(`p${++seq}.json`, { v: seq });
            store.mode = o.flush === 'held' ? 'unavailable' : 'deposed';
          }
          const hadRows = live().length > 0;
          const calls = store.restoreCalls.length;
          store.restoreImpl = async (guildId, retiredAt, _t, beforeCommit, _d, replace = false) => {
            during.push(saveDataTracked('a.json', opts(g), { v: 'during' }).outcome);
            during.push(appendDataTracked('l.jsonl', opts(g), 'during\n').outcome);
            during.push(saveDataTracked('a.json', opts(other), { v: 'during' }).outcome);
            const plan = store.plan(guildId, retiredAt, replace);
            if (!plan.ok) return plan.answer;
            if (o.end === 'ok') return beforeCommit() ? { ok: false, reason: 'maintenance' } : store.commit(guildId, plan.batch, replace);
            if (o.end === 'unknown-committed') {
              const done = store.commit(guildId, plan.batch, replace);
              return { ok: false, reason: 'unknown', retiredAt: plan.batch.retiredAt, ...(replace ? { replaced: done.replaced ?? null } : {}) };
            }
            if (o.end === 'unknown-not') return { ok: false, reason: 'unknown', retiredAt: plan.batch.retiredAt };
            if (o.end === 'deposed') return { ok: false, reason: 'deposed' };
            if (o.end === 'unavailable') return { ok: false, reason: 'unavailable', detail: 'gone' };
            if (o.end === 'refused') return { ok: false, reason: 'refused', detail: 'x' };
            if (o.end === 'changed') return { ok: false, reason: 'changed' };
            return { ok: false, reason: 'no-entry' };
          };
          const during: string[] = [];
          const answer = await applyOperatorDataWrite(restoreRequest(g, { ...(x === null ? {} : { retiredAt: x }), replace: o.replace }));
          store.mode = 'commit';
          // No write of G is accepted while the restore holds it; another guild's is.
          if (store.restoreCalls.length > calls) expect(during).toEqual(['refused', 'refused', 'saved']);
          if (o.flush === 'ok') expect(store.restoreCalls).toHaveLength(calls + 1);
          else expect(store.restoreCalls).toHaveLength(calls);
          if (store.restoreCalls.length > calls) expect(store.restoreCalls.at(-1)![5]).toBe(o.replace);
          if (answer.ok && o.replace) {
            const made = store.graveyard.get(g)!.filter(b => !batchesBefore.includes(b));
            for (const b of made) expect(b.retiredAt).toBeGreaterThan(newest);
            if (hadRows) expect(made.map(b => b.reason)).toEqual([`replaced-by-restore-${(answer as { retiredAt: number }).retiredAt}`]);
            else expect(made).toEqual([]);
          }
          await vi.waitFor(() => expect(['ready', 'fenced']).toContain(ws.stateOf(g)));
        }
        if (o.kind === 'sweep') {
          const cutoff = store.now() + o.aheadDays * DAY - ttl;
          const list = store.graveyard.get(g) ?? [];
          for (const b of [...list]) {
            if (b.retiredAt < cutoff && (b.usedAt === undefined || b.usedAt < cutoff)) {
              swept.add(b);
              list.splice(list.indexOf(b), 1);
            }
          }
        }
        if (ws.stateOf(g) === 'ready') await ws.flushGuildNow(g, SECOND);
        const after = held();
        for (const v of versions) expect(after.has(v)).toBe(true);
        for (const b of batchesBefore) if (!swept.has(b)) expect(store.graveyard.get(g)).toContain(b);
        const everything = kept();
        for (const [row, { doc, ticket }] of acceptedDocs) {
          if (everything.has(`${row}=${doc}`)) continue;
          expect(await confirmWrite(ticket, 0)).toBe('deposed');
        }
        const streamed = [...everything].filter(e => e.startsWith(`${g}|m/l.jsonl=`)).flatMap(e => e.slice(e.indexOf('=') + 1).split('\n'));
        for (const { line, ticket } of acceptedLines) {
          if (streamed.includes(line)) continue;
          expect(await confirmWrite(ticket, 0)).toBe('deposed');
        }
      }
      for (const driver of drivers.splice(0)) driver.stop();
    }), { numRuns: 200 });
  });
});
