import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lock = vi.hoisted(() => ({ holder: null as { role: string; pid: number } | null }));
vi.mock('../../src/bot/internalSetup/utils/writerLock', async importOriginal => {
  const real = await importOriginal<any>();
  return { ...real, deposedHolder: () => lock.holder };
});

import fs from 'fs';
import type { FenceToken, RestoreOutcome, RetireOutcome } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { initDataReadiness, type DataReadinessDriver } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { restoreGuildDirFromGraveyard } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { deleteGuildNamespace, setGuildDataBackend, setOwnerInfoProvider } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { deposedText } from '../../src/bot/internalSetup/utils/writerLock';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore } from '../helpers/fakeStore';
import { freshGuild } from '../helpers/gateRig';
import { batchExistsAnswer, isBatchExists } from '../helpers/nb11ScriptedPg';
import { LEASED } from '../helpers/readinessRig';

// NB11 fix round 1: the writer-lock override keeps a can't confirm answer (NB11-L1, NB11-run-1), a socket errno is no
// SQLSTATE (NB11-L2, NB11-run-3), a delete with no usable claim says so (NB11-L3, NB11-run-2), and a JSON restore reads
// its stop and the writer lock before it removes the entry's note (NB11-L5).

const SECOND = 1000;
const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 };
const unknownText = (g: string, r: number) => `can't confirm whether server ${g} was restored: the database did not confirm the commit. Within a minute, if it was restored, the server's data is back and entry ${r} is gone from \`smdb graveyard list\`; if not, the entry is still listed, unless it had passed the graveyard's keep time (GRAVEYARD_TTL_DAYS, 14 days by default) and the graveyard sweep removed it, data and all.`;
const DELETE_UNKNOWN = "can't confirm whether this server's data was deleted: the database did not confirm the commit. Within a minute, `smdb graveyard list` lists a new entry for this server if it was deleted; if no new entry is listed by then, it was not.";
const DELETE_NO_CLAIM = 'this bot process holds no usable claim on the database; nothing was removed; restart the bot';
const HOLDER = { role: 'import', pid: 4242 };
const monoIn = (ms: number) => process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));

class ScriptedStore extends FakeStore {
  restoreImpl: () => Promise<RestoreOutcome> = async () => ({ ok: false, reason: 'no-entry' });
  retireImpl: () => Promise<RetireOutcome> = async () => ({ ok: true, moved: 1 });
  override async restoreGuild(): Promise<RestoreOutcome> { return this.restoreImpl(); }
  override async retireGuild(): Promise<RetireOutcome> { return this.retireImpl(); }
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

const restoreRequest = (guildId: string, retiredAt: number) => ({
  guildId, module: '', filename: '', op: 'restore-graveyard' as const, contentJson: JSON.stringify({ retiredAt }),
});
const deleteRequest = (guildId: string) => ({ guildId, module: '', filename: '', op: 'delete-namespace' as const });

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  lock.holder = null;
  vi.restoreAllMocks();
  for (const driver of drivers.splice(0)) driver.stop();
  setGuildDataBackend(null);
  for (const backend of backends.splice(0)) await backend.stop();
});

describe('a lost writer lock keeps every answer whose outcome may have landed', () => {
  it('a restore answering unknown keeps the can\'t confirm text, and the evicted set is read again', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.restoreImpl = async () => {
      lock.holder = HOLDER;
      return { ok: false, reason: 'unknown', retiredAt: 5 };
    };
    const hydrations = store.hydrationsSent;
    expect(await applyOperatorDataWrite(restoreRequest(g, 5))).toEqual({ ok: false, code: 'backend-unavailable', error: unknownText(g, 5) });
    expect(store.hydrationsSent).toBeGreaterThan(hydrations);
  });

  it('a restore whose restoreGuild threw keeps the can\'t confirm text', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.restoreImpl = async () => {
      lock.holder = HOLDER;
      throw new Error('boom');
    };
    expect(await applyOperatorDataWrite(restoreRequest(g, 5))).toEqual({ ok: false, code: 'backend-unavailable', error: unknownText(g, 5) });
  });

  it('a delete answering unknown keeps the can\'t confirm text', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.retireImpl = async () => {
      lock.holder = HOLDER;
      return { ok: false, reason: 'unknown' };
    };
    expect(await applyOperatorDataWrite(deleteRequest(g))).toEqual({ ok: false, code: 'backend-unavailable', error: DELETE_UNKNOWN });
  });

  it('a refusal known to have changed nothing still answers that another process took the data files', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.restoreImpl = async () => {
      lock.holder = HOLDER;
      return { ok: false, reason: 'live-rows', retiredAt: 5 };
    };
    expect(await applyOperatorDataWrite(restoreRequest(g, 5))).toEqual({ ok: false, code: 'held-elsewhere', error: deposedText(HOLDER) });
    const h = await readyGuild(ws);
    store.retireImpl = async () => ({ ok: false, reason: 'out-of-time' });
    expect(await applyOperatorDataWrite(deleteRequest(h))).toEqual({ ok: false, code: 'held-elsewhere', error: deposedText(HOLDER) });
  });
});

describe('a delete with no usable claim', () => {
  it('answers its own text, not that the database did not answer', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.retireImpl = async () => ({ ok: false, reason: 'no-claim' });
    expect(await deleteGuildNamespace(g, 'test', 5 * SECOND)).toEqual({ ok: false, code: 'backend-unavailable', error: DELETE_NO_CLAIM });
  });

  it('the real retire answers no-claim before any connection', async () => {
    const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none' });
    backends.push(backend);
    (backend as unknown as { state: string }).state = 'ready';
    const connect = vi.fn(async () => { throw new Error('no connection may be opened'); });
    (backend.getPool() as unknown as { connect: unknown }).connect = connect;
    expect(await backend.retireGuild('1', 'test', { ...token, claim: null as unknown as number })).toEqual({ ok: false, reason: 'no-claim' });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('a socket errno is not a SQLSTATE', () => {
  const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' });
  const serverError = (code: string) => Object.assign(new Error('scripted refusal'), { code, severity: 'ERROR' });

  function scripted(fail: (sql: string) => Error | null) {
    const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none' });
    backends.push(backend);
    const internals = backend as unknown as { state: string; provisioned: boolean };
    internals.state = 'ready';
    internals.provisioned = true;
    const client = {
      query: (config: string | { text: string }) => {
        const sql = (typeof config === 'string' ? config : config.text).trim();
        const error = fail(sql);
        if (error) return Promise.reject(error);
        if (/^INSERT INTO smdb_data\.guild_ownership AS o\b/.test(sql)) return Promise.resolve({ rows: [], rowCount: 1 });
        if (isBatchExists(sql)) return Promise.resolve(batchExistsAnswer(sql, true));
        if (/AS present/.test(sql)) return Promise.resolve({ rows: [{ present: false }], rowCount: 1 });
        if (/^WITH moved AS/.test(sql)) return Promise.resolve({ rows: [{ taken: '1', put: '1', reason: 'r' }], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      release: () => {},
    };
    (backend.getPool() as unknown as { connect: unknown }).connect = vi.fn(async () => client);
    return backend;
  }

  it('EPIPE on the move answers unavailable and notes the outage', async () => {
    const backend = scripted(sql => (/^WITH moved AS/.test(sql) ? epipe() : null));
    expect(await backend.restoreGuild('1', 5, token, () => null, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'unavailable', detail: 'write EPIPE' });
    expect(backend.connectionState().state).not.toBe('ready');
  });

  it('EPIPE on COMMIT answers unknown', async () => {
    const backend = scripted(sql => (sql === 'COMMIT' ? epipe() : null));
    expect(await backend.restoreGuild('1', 5, token, () => null, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'unknown', retiredAt: 5 });
  });

  it('EPIPE on the retire answers unavailable, not refused', async () => {
    const backend = scripted(sql => (/^DELETE FROM smdb_data\.guild_data /.test(sql) ? epipe() : null));
    expect(await backend.retireGuild('1', 'test', token, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'unavailable', detail: 'write EPIPE' });
  });

  it('a server error with a SQLSTATE still answers refused', async () => {
    const backend = scripted(sql => (/^WITH moved AS/.test(sql) ? serverError('23505') : null));
    expect(await backend.restoreGuild('1', 5, token, () => null, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'refused', detail: 'SQLSTATE 23505: scripted refusal', code: '23505' });
    expect(backend.connectionState().state).toBe('ready');
  });
});

describe('the JSON restore before it removes the note', () => {
  let guilds = 810_000_000_000_000_000n;
  const fileGuild = () => String(++guilds);

  function bury(g: string, ms: number): string {
    const dir = dataPath('_graveyard', `${g}-${ms}`);
    fs.mkdirSync(path.join(dir, 'm'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'm', 'a.json'), '{"n":5}');
    fs.writeFileSync(path.join(dir, '.graveyard.json'), JSON.stringify({ guildId: g, reason: 'r', ts: ms }));
    return dir;
  }

  beforeEach(() => setBackendKind('file'));

  it('a writer lock lost during the note read refuses without touching the note', async () => {
    const g = fileGuild();
    const dir = bury(g, 1000);
    const unlink = vi.spyOn(fs.promises, 'unlink');
    const writeFile = vi.spyOn(fs.promises, 'writeFile');
    const progress = { renamed: false };
    expect(await restoreGuildDirFromGraveyard(g, 1000, { stop: () => null, writerLost: () => true, progress })).toEqual({ ok: false, why: 'writer-lost' });
    expect(unlink).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, '.graveyard.json'))).toBe(true);
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });

  it('a stop that comes during the note read refuses without touching the note', async () => {
    const g = fileGuild();
    const dir = bury(g, 1000);
    const unlink = vi.spyOn(fs.promises, 'unlink');
    let reads = 0;
    const stop = () => (++reads > 1 ? 'maintenance' as const : null);
    expect(await restoreGuildDirFromGraveyard(g, 1000, { stop, writerLost: () => false, progress: { renamed: false } })).toEqual({ ok: false, why: 'stopped', stop: 'maintenance' });
    expect(unlink).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, '.graveyard.json'))).toBe(true);
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });
});
