import * as fs from 'fs';
import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { me, startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';
import { setBackendKind } from '../helpers/backendKind';
import { ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { saveData } from '../../src/bot/internalSetup/utils/dataManager';
import {
  _resetMaintenance,
  _setMaintenanceSender,
  _setMaintenanceTiming,
  closeMaintenanceGate,
  maintenanceUnfit,
  markDiscordStarted,
  noteClaimsLapsed,
  restartForShards,
  watchDataBackend,
} from '../../src/bot/internalSetup/utils/maintenance';
import { isMaintenanceGateClosed, maintenanceCause } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { maintenanceFilePath, writeMaintenanceFile } from '../../src/utils/maintenanceFile';

// NB4 sheet [pg] 9 (T2): under either gate cause a process whose role is at NOLOGIN stays logged in and lapses
// nothing, since no process ticks the claim clock; after the login returns, its leave saves the held write and asks
// for one restart.

const ROLE = 'smdb_gate_role';
const T = claimTimings(6);
const A = me('a');
const bounded = async <V>(work: Promise<V>, ms: number, what: string): Promise<V> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(`timed out after ${ms} ms waiting for ${what}`)); }, ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
};
const until = async (check: () => Promise<boolean> | boolean, ms: number, what: string): Promise<void> => {
  const end = Date.now() + ms;
  for (;;) {
    if (await bounded(Promise.resolve(check()), Math.max(end - Date.now(), 1), what)) return;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise(resolve => { setTimeout(resolve, 100); });
  }
};

let rig: ClaimRig;
let locker: PoolClient | null = null;
let teardown: (() => Promise<void>) | null = null;
beforeAll(async () => {
  rig = await startClaimRig();
  await rig.direct.query(`CREATE ROLE ${ROLE} SUPERUSER LOGIN PASSWORD 'pw'`);
}, 180_000);
afterAll(async () => {
  await rig?.stop();
});
beforeEach(async () => {
  await rig.reset();
  for (const table of ['guild_data', 'guild_append', 'guild_ownership']) await rig.direct.query(`DELETE FROM smdb_data.${table}`);
  await rig.direct.query(`ALTER ROLE ${ROLE} LOGIN`);
});
afterEach(async () => {
  const failures: unknown[] = [];
  const held = locker;
  locker = null;
  if (held) {
    await bounded(held.query('ROLLBACK'), 10_000, 'the locker ROLLBACK').catch(error => { failures.push(error); });
    held.release(true);
  }
  const stop = teardown;
  teardown = null;
  if (stop) await bounded(stop(), 30_000, 'the claims, claim store and backend to stop').catch(error => { failures.push(error); });
  await bounded(rig.direct.query(`ALTER ROLE ${ROLE} LOGIN`), 10_000, 'ALTER ROLE LOGIN').catch(error => { failures.push(error); });
  _resetMaintenance();
  _setMaintenanceSender(null);
  setBackendKind(null);
  fs.rmSync(maintenanceFilePath(), { force: true });
  vi.restoreAllMocks();
  if (failures.length > 0) throw failures[0];
}, 60_000);

const roleUrl = () => `postgres://${ROLE}:pw@${rig.container.getHost()}:${rig.container.getPort()}/${rig.container.getDatabase()}`;
const expiries = async () => (await rig.direct.query(`SELECT shard_id, expires_up_ms::text AS exp FROM smdb_data.shard_claims ORDER BY shard_id`)).rows;
const roleSessions = async (extra = ''): Promise<number> => (await rig.direct.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1${extra}`, [ROLE])).rows[0].n;

describe('NOLOGIN under either gate cause (sheet [pg] 9)', () => {
  it.each(['hook', 'login-refused'] as const)('%s: no lapse and no gateway stop past D + 2R, no row extended or expired; the login returns and the leave saves the held write and asks one restart', async cause => {
    const sent: any[] = [];
    _setMaintenanceSender(message => { sent.push(message); });
    _setMaintenanceTiming({ leaveRetryMs: 500, filePollMs: 300, leaveSaveBoundMs: 2000, restartResendMs: 600_000 });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const guildId = String(4n << 22n);
    const backend = new PostgresBackend(fixedDatabase(roleUrl()));
    backend.start();
    teardown = () => backend.stop();
    await until(() => backend.connectionState().state === 'ready', 30_000, 'the backend to be ready');
    setBackendKind('postgres');
    const ws = initWorkingSet(backend);
    const watcher = watchDataBackend(backend, { retryMs: 300 })!;
    const store = new ClaimStore(roleUrl(), T, () => backend.notifyLoginRefused());
    const gatewayStop = vi.fn();
    const claims = new ShardClaims({
      store, me: A, timings: T, capacity: 4, takeoverSeconds: 6, returns: true, restartable: true, startedAt: Date.now(),
      fitness: maintenanceUnfit, gateClosed: isMaintenanceGateClosed, isStopping: () => false,
      stopServingStep: gatewayStop, noteLapsed: noteClaimsLapsed, noteLost: () => undefined,
      restartForShards: reason => restartForShards(reason, maintenanceUnfit),
      log: { log: () => undefined, warn: () => undefined, error: () => undefined },
    });
    teardown = async () => {
      ws.evict(guildId);
      claims.beginStop();
      await claims.finishStop();
      await store.end();
      await backend.stop();
    };
    claims.start();
    expect(await bounded(claims.firstRenewal(), 10_000, 'the first renewal')).toBe(true);
    const taken = await bounded(claims.bootTake(async () => 1), 10_000, 'the boot take');
    if (!taken) throw new Error('no take');
    claims.noteGranted();
    markDiscordStarted();
    const pair = taken.pairs[0];
    const stored = async () => (await rig.direct.query(`SELECT count(*)::int AS n FROM smdb_data.guild_data WHERE guild_id = $1`, [guildId])).rows[0].n;
    const hydrated = ws.hydrate(guildId, { nodeId: A.nodeId, claim: pair.claim, processId: A.processId, shardId: pair.shardId, shardCount: pair.shardCount });
    expect(await bounded(hydrated, 10_000, 'the hydrate')).toBe('ready');

    locker = await rig.direct.connect();
    await locker.query('BEGIN');
    await locker.query('LOCK TABLE smdb_data.guild_data IN ACCESS EXCLUSIVE MODE');
    saveData('held.json', { guildId, category: 'm' }, { v: 1 });
    void ws.flushAllDirty();
    await until(async () => (await roleSessions(` AND wait_event_type = 'Lock'`)) > 0, 10_000, 'the flush to wait on the guild_data lock');

    if (cause === 'hook') {
      writeMaintenanceFile('maintenance', 'Moving the database.');
      closeMaintenanceGate('hook', 'Moving the database.');
    }
    const before = await expiries();
    const upBefore = (await rig.clock()).upMs;
    await rig.direct.query(`ALTER ROLE ${ROLE} NOLOGIN`);
    await until(async () => {
      await rig.direct.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [ROLE]);
      return (await roleSessions()) === 0;
    }, 10_000, `every ${ROLE} session to end`);
    const unlocked = locker;
    locker = null;
    await bounded(unlocked.query('ROLLBACK'), 10_000, 'the locker ROLLBACK');
    unlocked.release();
    expect(await stored()).toBe(0);

    await new Promise(resolve => { setTimeout(resolve, T.deadlineMs + 2 * T.renewMs + 1000); });
    expect(isMaintenanceGateClosed()).toBe(true);
    expect(maintenanceCause()).toBe(cause);
    expect(gatewayStop).not.toHaveBeenCalled();
    expect(claims.stoppedServing()).toBe(false);
    expect(claims.snapshot().stopped).toBeNull();
    expect(await expiries()).toEqual(before);
    expect((await rig.clock()).upMs).toBe(upBefore);
    expect(await stored()).toBe(0);
    expect(sent.filter(m => m.type === 'control:restart-bot')).toEqual([]);

    await rig.direct.query(`ALTER ROLE ${ROLE} LOGIN`);
    if (cause === 'hook') writeMaintenanceFile('running', 'Moving the database.');
    await bounded(watcher.probeNow(), 10_000, 'the watcher probe');
    await until(() => sent.some(m => m.type === 'control:restart-bot'), 30_000, 'the leave to ask a restart');
    const docs = (await rig.direct.query(`SELECT module, filename, doc FROM smdb_data.guild_data WHERE guild_id = $1`, [guildId])).rows;
    expect(docs).toEqual([{ module: 'm', filename: 'held.json', doc: JSON.stringify({ v: 1 }, null, 2) }]);
    await new Promise(resolve => { setTimeout(resolve, 1000); });
    expect(sent.filter(m => m.type === 'control:restart-bot')).toHaveLength(1);
    expect(gatewayStop).not.toHaveBeenCalled();
    expect(claims.stoppedServing()).toBe(false);
  }, 120_000);
});
