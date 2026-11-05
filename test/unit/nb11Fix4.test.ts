import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken, RestoreOutcome, RetireOutcome } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { initDataReadiness, type DataReadinessDriver } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { deleteGuildNamespace, restoreGuildFromGraveyard, setGuildDataBackend, setOwnerInfoProvider } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { ROUTE_TEXT, type BotManager } from '../../src/webui/botManager';
import { createConfigRoutes } from '../../src/webui/routes/config';
import { createGraveyardRoutes, graveyardRouteRefusal } from '../../src/webui/routes/graveyard';
import { setBackendKind } from '../helpers/backendKind';
import { call, startApp } from '../helpers/configRig';
import { FakeStore } from '../helpers/fakeStore';
import { freshGuild } from '../helpers/gateRig';
import { type Answer, isFenced, isLive, isMove, scriptedPg } from '../helpers/nb11ScriptedPg';
import { LEASED } from '../helpers/readinessRig';

// NB11 fix round 4: the bot log says can't confirm when COMMIT got no answer (NB11-R4-run-1), a delete whose ready
// wait fails says nothing was removed (NB11-R4-run-2), and a restore or a server's data delete refused while the bot
// starts or stops names a next step that works (NB11-R4-run-3).

const SECOND = 1000;
const G = '123456789012345678';
const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 };
const monoIn = (ms: number) => process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
const DELETE_NOT_LOADED = "this server's data is not loaded in this bot process; nothing was removed; try again in a moment";

const drivers: DataReadinessDriver[] = [];
const backends: PostgresBackend[] = [];
let error: ReturnType<typeof vi.spyOn>;
const lines = (): string[] => error.mock.calls.map((c: unknown[]) => c.map(String).join(' '));
const opLines = () => lines().filter(line => /restoreGuild|retireGuild/.test(line));

class AnsweringStore extends FakeStore {
  retireAnswer: RetireOutcome = { ok: false, reason: 'unknown' };
  restoreAnswer: () => Promise<RestoreOutcome> = async () => ({ ok: false, reason: 'unknown', retiredAt: 5 });
  override async retireGuild(): Promise<RetireOutcome> { return this.retireAnswer; }
  override async restoreGuild(): Promise<RestoreOutcome> { return this.restoreAnswer(); }
}

function setup(store: FakeStore): WorkingSetManager {
  const ws = initWorkingSet(store);
  const driver = initDataReadiness(store, ws, { held: false });
  drivers.push(driver);
  driver.onLeaseChanged(LEASED);
  setGuildDataBackend(store);
  setOwnerInfoProvider(() => ({ nodeId: 'node-a', processId: 'process-a', shardCount: 1, claimOf: () => 7 }));
  setBackendKind('postgres');
  return ws;
}

async function readyGuild(ws: WorkingSetManager): Promise<string> {
  const g = freshGuild();
  expect(await ws.hydrate(g, token)).toBe('ready');
  return g;
}

const isCommit = (sql: string) => sql === 'COMMIT';
const commitLost = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
function scripted(fail: (sql: string) => boolean, err: () => Error) {
  const rig = scriptedPg((sql: string): Answer => {
    if (fail(sql)) return err();
    if (isFenced(sql)) return { rows: [], rowCount: 1 };
    if (/^SELECT 1 FROM smdb_data\.guild_data_graveyard WHERE guild_id = \$1 AND retired_at = \$2/.test(sql)) return { rows: [{}], rowCount: 1 };
    if (isLive(sql)) return { rows: [{ present: false }], rowCount: 1 };
    if (isMove(sql)) return { rows: [{ taken: '1', put: '1', reason: 'test' }], rowCount: 1 };
    return undefined;
  });
  backends.push(rig.backend);
  return rig.backend;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const driver of drivers.splice(0)) driver.stop();
  setGuildDataBackend(null);
  for (const backend of backends.splice(0)) await backend.stop();
});

describe('a COMMIT with no answer in the bot log', () => {
  it('the restore logs can\'t confirm, never failed', async () => {
    const backend = scripted(isCommit, commitLost);
    expect(await backend.restoreGuild('1', 5, token, () => null, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'unknown', retiredAt: 5 });
    expect(opLines()).toEqual(["[PostgresBackend] restoreGuild of guild 1: COMMIT got no answer (read ECONNRESET); can't confirm whether it committed"]);
  });

  it('the retire logs can\'t confirm, never failed', async () => {
    const backend = scripted(isCommit, commitLost);
    expect(await backend.retireGuild('1', 'test', token, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'unknown' });
    expect(opLines()).toEqual(["[PostgresBackend] retireGuild of guild 1: COMMIT got no answer (read ECONNRESET); can't confirm whether it committed"]);
  });

  it('an answered COMMIT error and an error before COMMIT still log failed', async () => {
    const answered = scripted(isCommit, () => Object.assign(new Error('could not serialize'), { code: '40001', severity: 'ERROR' }));
    expect(await answered.restoreGuild('1', 5, token, () => null, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'refused' });
    const early = scripted(isMove, commitLost);
    expect(await early.restoreGuild('2', 5, token, () => null, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'unavailable' });
    const logged = opLines();
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatch(/^\[PostgresBackend\] restoreGuild failed for 1:/);
    expect(logged[1]).toMatch(/^\[PostgresBackend\] restoreGuild failed for 2:/);
    expect(logged.join('\n')).not.toContain("can't confirm");
  });

  it('a delete answered unknown logs can\'t confirm in DataManager, and no failed line', async () => {
    const store = new AnsweringStore();
    const ws = setup(store);
    const g = await readyGuild(ws);
    const reply = await deleteGuildNamespace(g, 'test', 5 * SECOND);
    expect(reply).toMatchObject({ ok: false, code: 'backend-unavailable' });
    expect(lines()).toEqual([`[DataManager] Can't confirm whether guild ${g} was retired: the database did not confirm the commit`]);
  });

  it('a delete refused for another reason still logs failed', async () => {
    const store = new AnsweringStore();
    store.retireAnswer = { ok: false, reason: 'unavailable', timedOut: true };
    const ws = setup(store);
    const g = await readyGuild(ws);
    await deleteGuildNamespace(g, 'test', 5 * SECOND);
    expect(lines()).toEqual([`[DataManager] Failed to retire guild ${g} (unavailable)`]);
  });

  it('a restore answered unknown logs can\'t confirm with the batch', async () => {
    const store = new AnsweringStore();
    const ws = setup(store);
    const g = await readyGuild(ws);
    expect(await restoreGuildFromGraveyard(g, 5)).toMatchObject({ ok: false, code: 'backend-unavailable' });
    expect(lines()).toEqual([`[DataManager] Can't confirm whether guild ${g} was restored from graveyard batch 5: the database did not confirm the commit`]);
  });

  it('a throw out of restoreGuild logs can\'t confirm', async () => {
    const store = new AnsweringStore();
    const boom = new Error('boom');
    store.restoreAnswer = async () => { throw boom; };
    const ws = setup(store);
    const g = await readyGuild(ws);
    await restoreGuildFromGraveyard(g, 5);
    expect(error.mock.calls).toEqual([[`[DataManager] Can't confirm whether guild ${g} was restored: the restore stopped on an error once it was sent to the database:`, boom]]);
  });
});

describe('a delete whose ready wait fails', () => {
  it('answers that nothing was removed', async () => {
    const store = new FakeStore();
    setup(store);
    store.hydrateMode = 'unavailable';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date', 'hrtime'] });
    const reply = applyOperatorDataWrite({ guildId: freshGuild(), module: '', filename: '', op: 'delete-namespace' });
    let answer: unknown;
    void reply.then(value => { answer = value; });
    await vi.advanceTimersByTimeAsync(3 * SECOND);
    expect(answer).toEqual({ ok: false, code: 'backend-unavailable', error: DELETE_NOT_LOADED });
  });
});

describe('a refusal while the bot starts or stops', () => {
  it.each([
    ['stopping', ROUTE_TEXT.stopping, 'the bot is stopping; nothing was restored; restore again once the bot is started', 'the bot is stopping; nothing was removed; delete again once the bot is started'],
    ['stopping', ROUTE_TEXT.restarting, 'the bot is restarting; nothing was restored; try again once the bot has started', 'the bot is restarting; nothing was removed; try again once the bot has started'],
    ['stopping', ROUTE_TEXT.exiting, 'the web panel is shutting down; nothing was restored; try again once it is back', 'the web panel is shutting down; nothing was removed; try again once it is back'],
    ['starting', ROUTE_TEXT.starting, 'the bot is starting; nothing was restored; try again once the bot has started', 'the bot is starting; nothing was removed; try again once the bot has started'],
  ] as const)('%s (%s) is worded for the restore and the delete', async (code, detail, restoreText, deleteText) => {
    expect(graveyardRouteRefusal(code, detail, 'restore')).toBe(restoreText);
    expect(graveyardRouteRefusal(code, detail, 'guild-delete')).toBe(deleteText);
    const reply = { ok: false, code, error: detail };
    const manager = { writeGuildData: async () => reply, isRunning: () => true, writeRefusal: () => null } as unknown as BotManager;
    const app = await startApp(a => {
      a.use('/api/data/graveyard', createGraveyardRoutes(manager));
      a.use('/api/config', createConfigRoutes(manager));
    });
    try {
      const restored = await call(app.url, 'POST', '/api/data/graveyard/restore', { guildId: G, retiredAt: 5 });
      expect(restored.status).toBe(503);
      expect(restored.body).toEqual({ success: false, error: restoreText });
      const deleted = await call(app.url, 'POST', '/api/config/data/delete-guild', { guildId: G });
      expect(deleted.status).toBe(503);
      expect(deleted.body).toEqual({ success: false, error: deleteText });
    } finally {
      await app.close();
    }
  });

  it('leaves other codes and a file write to hopFailure', () => {
    expect(graveyardRouteRefusal('held-elsewhere', 'x', 'restore')).toBeNull();
    expect(graveyardRouteRefusal('bot-down', undefined, 'guild-delete')).toBeNull();
  });
});
