import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestoreOutcome, RetireOutcome } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { initDataReadiness, type DataReadinessDriver } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import {
  deleteGuildNamespace,
  restoreGuildFromGraveyard,
  setGuildDataBackend,
  setOwnerInfoProvider,
} from '../../src/bot/internalSetup/utils/dataManager';
import { setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore } from '../helpers/fakeStore';
import { freshGuild } from '../helpers/gateRig';
import { LEASED } from '../helpers/readinessRig';

// NB11 (wip-redesign/sheets/NB11.md) on Postgres: the answers and log lines of a restore and a delete whose backend
// answers are scripted.

const DELETE_FAILED = 'guild data delete failed; nothing was removed';
const DELETE_ALREADY = "a delete of this server's data is already running; nothing was removed";
const unknownTail = "is gone from `smdb graveyard list`; if not, the entry is still listed, unless it had passed the graveyard's keep time (GRAVEYARD_TTL_DAYS, 14 days by default) and the graveyard sweep removed it, data and all.";
const unknownHead = (g: string) => `can't confirm whether server ${g} was restored: the database did not confirm the commit. Within a minute, if it was restored, the server's data is back and`;

class Scripted extends FakeStore {
  restoreImpl: (() => Promise<RestoreOutcome>) | null = null;
  retireImpl: (() => Promise<RetireOutcome>) | null = null;
  retireCalls = 0;
  override async restoreGuild(): Promise<RestoreOutcome> {
    if (this.restoreImpl) return this.restoreImpl();
    return { ok: false, reason: 'no-entry' };
  }
  override async retireGuild(): Promise<RetireOutcome> {
    this.retireCalls += 1;
    if (this.retireImpl) return this.retireImpl();
    return { ok: true, moved: 1 };
  }
}

let drivers: DataReadinessDriver[] = [];
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(c => c.map(String).join(' '));

function setup(): { store: Scripted; ws: WorkingSetManager } {
  const store = new Scripted();
  const ws = initWorkingSet(store);
  const driver = initDataReadiness(store, ws, { held: false });
  drivers.push(driver);
  driver.onLeaseChanged(LEASED);
  setGuildDataBackend(store);
  setOwnerInfoProvider(() => ({ nodeId: 'node-a', processId: 'process-a', shardCount: 1, claimOf: () => 7 }));
  setBackendKind('postgres');
  return { store, ws };
}

async function readyGuild(ws: WorkingSetManager): Promise<string> {
  const guildId = freshGuild();
  expect(await ws.hydrate(guildId, { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 })).toBe('ready');
  return guildId;
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  setMaintenanceGate(null);
  for (const driver of drivers.splice(0)) driver.stop();
  setGuildDataBackend(null);
  setBackendKind(null);
});

describe('a restore the database did not confirm', () => {
  it('with no retiredAt asked or answered, the reply names its entry and the log names no batch', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.restoreImpl = async () => ({ ok: false, reason: 'unknown' });
    const reply = await restoreGuildFromGraveyard(g);
    expect(reply).toEqual({ ok: false, code: 'backend-unavailable', error: `${unknownHead(g)} its entry ${unknownTail}` });
    expect(lines(error)).toContain(`[DataManager] Can't confirm whether guild ${g} was restored: the database did not confirm the commit`);
  });

  it('with no retiredAt asked but one answered, the reply and the log name the answered batch', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.restoreImpl = async () => ({ ok: false, reason: 'unknown', retiredAt: 9 });
    const reply = await restoreGuildFromGraveyard(g);
    expect(reply).toEqual({ ok: false, code: 'backend-unavailable', error: `${unknownHead(g)} entry 9 ${unknownTail}` });
    expect(lines(error)).toContain(`[DataManager] Can't confirm whether guild ${g} was restored from graveyard batch 9: the database did not confirm the commit`);
  });
});

describe('restore refusals and errors', () => {
  it('a database answer of unavailable with no detail throws with "no detail" in its text', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.restoreImpl = async () => ({ ok: false, reason: 'unavailable' });
    const thrown = await restoreGuildFromGraveyard(g, 5).then(() => null, (e: { causeKey: string; message: string }) => e);
    expect(thrown?.causeKey).toBe('database-unreachable');
    expect(thrown?.message).toBe('[Data] The database did not answer or ended the connection (no detail); nothing was restored; try again in a moment');
  });

  it('a Postgres bot with no backend wired throws its reason', async () => {
    setBackendKind('postgres');
    setGuildDataBackend(null);
    const thrown = await restoreGuildFromGraveyard(freshGuild(), 5).then(() => null, (e: { causeKey: string; message: string }) => e);
    expect(thrown?.causeKey).toBe('database-unreachable');
    expect(thrown?.message).toBe('[Data] The database did not answer or ended the connection (no database backend in this process); nothing was restored; try again in a moment');
  });

  it('an error before the restore reached the database logs that it stopped, not a can\'t confirm', async () => {
    const { ws } = setup();
    const g = await readyGuild(ws);
    const boom = new Error('boom');
    vi.spyOn(ws, 'flushGuildNow').mockRejectedValue(boom);
    expect(await restoreGuildFromGraveyard(g, 5)).toEqual({ ok: false, code: 'io-error', error: 'the restore stopped on an error in the bot (boom); nothing was restored; see the bot log' });
    expect(error.mock.calls).toEqual([[`[Data] The restore of guild ${g} stopped on an error:`, boom]]);
  });
});

describe('the delete on Postgres', () => {
  it('a second delete while one runs answers already running and sends no second retire', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    const hold = deferred<RetireOutcome>();
    store.retireImpl = () => hold.promise;
    const first = deleteGuildNamespace(g, 'test', 1000);
    await vi.waitFor(() => expect(store.retireCalls).toBe(1));
    const second = deleteGuildNamespace(g, 'test', 1000);
    hold.resolve({ ok: true, moved: 1 });
    expect(await second).toEqual({ ok: false, code: 'invalid', error: DELETE_ALREADY });
    expect(await first).toEqual({ ok: true });
    expect(store.retireCalls).toBe(1);
  });

  it('a Postgres bot with no backend wired answers the delete failed', async () => {
    setup();
    setGuildDataBackend(null);
    expect(await deleteGuildNamespace(freshGuild(), 'test', 1000)).toEqual({ ok: false, code: 'io-error', error: DELETE_FAILED });
  });

  it('a flush answering deposed logs that another process serves the data', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    vi.spyOn(ws, 'flushGuildNow').mockResolvedValue('deposed');
    expect(await deleteGuildNamespace(g, 'test', 1000)).toEqual({ ok: false, code: 'not-owner', error: "another bot process now serves this server's data; nothing was removed" });
    expect(lines(error)).toContain(`[DataManager] Cannot retire guild ${g}: another bot process now serves its data; nothing was removed`);
    expect(store.retireCalls).toBe(0);
  });

  it('a flush not confirmed logs its answer', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    vi.spyOn(ws, 'flushGuildNow').mockResolvedValue('unavailable');
    expect(await deleteGuildNamespace(g, 'test', 1000)).toEqual({ ok: false, code: 'backend-unavailable', error: "the server's unsaved changes are not confirmed saved yet; nothing was removed; try again in a moment" });
    expect(lines(error)).toContain(`[DataManager] Cannot retire guild ${g}: its unflushed writes are not confirmed saved (unavailable); nothing was removed`);
    expect(store.retireCalls).toBe(0);
  });

  it('no owner info wired warns and retires nothing', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    setOwnerInfoProvider(() => null);
    expect(await deleteGuildNamespace(g, 'test', 1000)).toEqual({ ok: false, code: 'io-error', error: DELETE_FAILED });
    expect(lines(warn)).toContain(`[DataManager] Cannot retire guild ${g}: no owner info wired`);
    expect(store.retireCalls).toBe(0);
  });

  it('a retire that moved no row answers failed and logs no move', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.retireImpl = async () => ({ ok: true, moved: 0 });
    expect(await deleteGuildNamespace(g, 'test', 1000)).toEqual({ ok: false, code: 'io-error', error: DELETE_FAILED });
    expect(lines(log).filter(l => l.includes('moved to graveyard'))).toEqual([]);
  });

  it('a retire that moved rows answers ok and logs the move with its reason', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.retireImpl = async () => ({ ok: true, moved: 2 });
    expect(await deleteGuildNamespace(g, 'webui-operator-delete', 1000)).toEqual({ ok: true });
    expect(lines(log)).toContain(`[DataManager] Guild ${g} moved to graveyard (webui-operator-delete)`);
  });

  it('a retire answering unavailable with no detail says "no detail"', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.retireImpl = async () => ({ ok: false, reason: 'unavailable' });
    expect(await deleteGuildNamespace(g, 'test', 1000)).toEqual({ ok: false, code: 'backend-unavailable', error: 'the database did not answer or ended the connection (no detail); nothing was removed; try again in a moment' });
  });
});
