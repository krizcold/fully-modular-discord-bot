import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken, RestoreOutcome, RetireOutcome } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { initDataReadiness, type DataReadinessDriver } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { deleteGuildNamespace, restoreGuildFromGraveyard, setGuildDataBackend, setOwnerInfoProvider } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore } from '../helpers/fakeStore';
import { freshGuild } from '../helpers/gateRig';
import { LEASED } from '../helpers/readinessRig';

// NB11 fix round 2: a deposed flush on a delete says another process serves the data (NB11-R2-1), the flush and the
// connection are bounded by the deadline (NB11-R2-2), and a delete that threw says nothing was removed (NB11-R2-3).

const SECOND = 1000;
const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 };
const DELETE_DEPOSED = "another bot process now serves this server's data; nothing was removed";
const DELETE_FLUSH = "the server's unsaved changes are not confirmed saved yet; nothing was removed; try again in a moment";
const RESTORE_FLUSH = "the server's unsaved changes are not confirmed saved yet; nothing was restored; try again in a moment";
const monoIn = (ms: number) => process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));

class ScriptedStore extends FakeStore {
  restoreCalls = 0;
  retireCalls = 0;
  override async restoreGuild(): Promise<RestoreOutcome> { this.restoreCalls++; return { ok: false, reason: 'no-entry' }; }
  override async retireGuild(): Promise<RetireOutcome> { this.retireCalls++; return { ok: true, moved: 1 }; }
}

let drivers: DataReadinessDriver[] = [];
const backends: PostgresBackend[] = [];

function setup(): { store: ScriptedStore; ws: WorkingSetManager } {
  const store = new ScriptedStore();
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
  expect(await ws.hydrate(guildId, token)).toBe('ready');
  return guildId;
}

const deleteRequest = (guildId: string) => ({ guildId, module: '', filename: '', op: 'delete-namespace' as const });

function realBackend(): { backend: PostgresBackend; connect: ReturnType<typeof vi.fn> } {
  const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none' });
  backends.push(backend);
  const internals = backend as unknown as { state: string; provisioned: boolean };
  internals.state = 'ready';
  internals.provisioned = true;
  const connect = vi.fn(async () => { throw new Error('no connection may be opened'); });
  (backend.getPool() as unknown as { connect: unknown }).connect = connect;
  return { backend, connect };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const driver of drivers.splice(0)) driver.stop();
  setGuildDataBackend(null);
  for (const backend of backends.splice(0)) await backend.stop();
});

describe('a delete whose flush comes back deposed', () => {
  it('answers not-owner with the delete text and retires nothing', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    vi.spyOn(ws, 'flushGuildNow').mockResolvedValue('deposed');
    expect(await deleteGuildNamespace(g, 'test', 5 * SECOND)).toEqual({ ok: false, code: 'not-owner', error: DELETE_DEPOSED });
    expect(store.retireCalls).toBe(0);
  });

  it('keeps the flush text for held, pending and unavailable', async () => {
    const { ws } = setup();
    for (const answer of ['held', 'pending', 'unavailable'] as const) {
      const g = await readyGuild(ws);
      const spy = vi.spyOn(ws, 'flushGuildNow').mockResolvedValue(answer);
      expect(await deleteGuildNamespace(g, 'test', 5 * SECOND)).toEqual({ ok: false, code: 'backend-unavailable', error: DELETE_FLUSH });
      spy.mockRestore();
    }
  });
});

describe('the flush before the move is bounded by the time left', () => {
  it('a delete with 3 s left flushes for at most 3 s', async () => {
    const { ws } = setup();
    const g = await readyGuild(ws);
    const spy = vi.spyOn(ws, 'flushGuildNow').mockResolvedValue('pending');
    await deleteGuildNamespace(g, 'test', 30 * SECOND, monoIn(3 * SECOND));
    const bound = spy.mock.calls[0][1];
    expect(bound).toBeLessThanOrEqual(3 * SECOND);
    expect(bound).toBeGreaterThan(2 * SECOND);
  });

  it('a delete past its deadline flushes for 0 ms', async () => {
    const { ws } = setup();
    const g = await readyGuild(ws);
    const spy = vi.spyOn(ws, 'flushGuildNow').mockResolvedValue('pending');
    await deleteGuildNamespace(g, 'test', 30 * SECOND, monoIn(-SECOND));
    expect(spy.mock.calls[0][1]).toBe(0);
  });

  it('a restore with 2 s left flushes for at most 2 s, and a flush cut short refuses with nothing restored', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    const spy = vi.spyOn(ws, 'flushGuildNow').mockResolvedValue('pending');
    expect(await restoreGuildFromGraveyard(g, 5, monoIn(2 * SECOND))).toEqual({ ok: false, code: 'backend-unavailable', error: RESTORE_FLUSH });
    const bound = spy.mock.calls[0][1];
    expect(bound).toBeLessThanOrEqual(2 * SECOND);
    expect(bound).toBeGreaterThan(SECOND);
    expect(store.restoreCalls).toBe(0);
  });

  it('a restore with the full time left keeps its 5 s flush', async () => {
    const { ws } = setup();
    const g = await readyGuild(ws);
    const spy = vi.spyOn(ws, 'flushGuildNow').mockResolvedValue('pending');
    await restoreGuildFromGraveyard(g, 5, monoIn(40 * SECOND));
    expect(spy.mock.calls[0][1]).toBe(5 * SECOND);
  });
});

describe('the real restore and retire with less than the statement floor left', () => {
  it('the restore answers out-of-time without connecting', async () => {
    const { backend, connect } = realBackend();
    expect(await backend.restoreGuild('1', 5, token, () => null, monoIn(500))).toEqual({ ok: false, reason: 'out-of-time' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('the retire answers out-of-time without connecting', async () => {
    const { backend, connect } = realBackend();
    expect(await backend.retireGuild('1', 'test', token, monoIn(500))).toEqual({ ok: false, reason: 'out-of-time' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('with time left, both connect', async () => {
    const { backend, connect } = realBackend();
    expect((await backend.restoreGuild('1', 5, token, () => null, monoIn(40 * SECOND))).ok).toBe(false);
    expect((await backend.retireGuild('1', 'test', token, monoIn(40 * SECOND))).ok).toBe(false);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});

describe('a delete that threw', () => {
  it('says nothing was removed and points to the bot log', async () => {
    const { ws } = setup();
    const g = await readyGuild(ws);
    vi.spyOn(ws, 'flushGuildNow').mockRejectedValue(new Error("ENOSPC: no space left on device, mkdir '/data/_graveyard'"));
    expect(await applyOperatorDataWrite(deleteRequest(g))).toEqual({
      ok: false,
      code: 'io-error',
      error: "the delete stopped on an error in the bot (ENOSPC: no space left on device, mkdir '/data/_graveyard'); nothing was removed; see the bot log",
    });
  });
});
