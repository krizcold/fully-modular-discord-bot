import { randomUUID } from 'crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PostgresBackend, provisionStoreInTransaction, SCHEMA_VERSION } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import {
  ANSWER_SQL,
  CLEANUP_SQL,
  REQUEST_CLAIM_SQL,
  REQUEST_INSERT_SQL,
  SETTLE_INSERT_SQL,
  SETTLE_UPDATE_SQL,
  UNANSWERED_BATCHES_SQL,
  UNAPPLIED_REPLY,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { GuildRequestSweep, type SweepDb } from '../../src/bot/internalSetup/fleet/guildRequests';
import { holderStateOf } from '../../src/bot/internalSetup/fleet/claimStore';
import { answerGuildWrite, type DataWriteReply, type GuildDataWriteRequest } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { initDataReadiness, type DataReadinessDriver } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { DELETE_TEXTS, RESTORE_TEXTS, setGuildDataBackend, setOwnerInfoProvider } from '../../src/bot/internalSetup/utils/dataManager';
import { sendHopReply } from '../../src/webui/routes/config';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { WebuiDataReader, setWebuiDataStoreUrl } from '../../src/webui/utils/webuiDataReader';
import { _resetGuildRequests, _setGuildRequestDeps, planGuildChange, sendGuildChange, type Plan } from '../../src/webui/utils/guildRequests';
import { setBackendKind } from '../helpers/backendKind';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';
import { takeShard } from '../helpers/pgClaims';

// NB7 on real Postgres: the request table as provisioned, the holder check over NB4's rows, the holder's claim and
// answer, the settle against the claim, and the sender's answers.

const GUILD = String(1n << 22n);
const BOT_DOWN = { ok: false, status: 503, code: 'bot-down', error: 'the bot process is not running' };
const bot = { writerRoute: () => BOT_DOWN, writeGuildData: async () => BOT_DOWN, readGuildData: async () => BOT_DOWN } as any;

let rig: ClaimRig;
const pools: Pool[] = [];
const sweeps: GuildRequestSweep[] = [];

const sweepDb = (pool: Pool): SweepDb => ({ query: (text, values, boundMs) => pool.query({ text, values, query_timeout: boundMs } as any) });
function poolOf(url = rig.url): Pool {
  const pool = new Pool({ connectionString: url, max: 4 });
  pool.on('error', () => undefined);
  pools.push(pool);
  return pool;
}

beforeAll(async () => {
  rig = await startClaimRig();
  setBackendKind('postgres');
}, 180_000);

afterAll(async () => {
  driver?.stop();
  for (const s of sweeps) s.stop();
  _setGuildRequestDeps(null);
  setWebuiDataStoreUrl(null);
  for (const p of pools) await p.end().catch(() => undefined);
  await rig?.stop();
});

beforeEach(async () => {
  setBackendKind('postgres');
  for (const s of sweeps.splice(0)) s.stop();
  _resetGuildRequests();
  setWebuiDataStoreUrl(rig.url);
  _setGuildRequestDeps({ nodeName: () => 'ALPHA', nodeId: () => 'n-alpha' });
  await rig.reset();
  await rig.direct.query(`DELETE FROM smdb_data.guild_requests`);
  await rig.direct.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('shard_count', '{"count":2}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
});

async function take(name: string, shardId: number): Promise<FenceToken> {
  return takeShard(rig.direct, { processId: `p-${name}`, nodeId: `n-${name}`, shardId, shardCount: 2 });
}

/** A sweep of the process that holds token, applying with flushGuild under that token. */
function sweepFor(token: FenceToken, applied: GuildDataWriteRequest[] = []): GuildRequestSweep {
  const s = new GuildRequestSweep({
    db: sweepDb(poolOf()),
    processId: () => token.processId,
    pairs: () => [{ shardCount: token.shardCount, shardId: token.shardId, claim: token.claim! }],
    stoppedServing: () => false,
    isStopping: () => false,
    apply: async (req): Promise<DataWriteReply> => {
      applied.push(req);
      const out = await rig.backend.flushGuild(req.guildId, { upserts: [{ key: { module: req.module, filename: req.filename }, doc: req.contentJson ?? '{}' }], deletes: [], appends: [] }, token);
      if (out.ok) return { ok: true };
      return out.reason === 'deposed' ? { ok: false, code: 'not-owner', error: 'deposed' } : { ok: false, code: 'backend-unavailable', error: 'unavailable' };
    },
  });
  sweeps.push(s);
  return s;
}

async function insertRow(over: { forProcess: string; shardId?: number; claimBySecs?: number; createdAgo?: string }): Promise<string> {
  const id = randomUUID();
  await rig.direct.query(
    `INSERT INTO smdb_data.guild_requests (id, guild_id, shard_count, shard_id, for_process, op, body, requested_by, claim_by, answer_by, created_at)
     VALUES ($1, $2, 2, $3, $4, 'write', $5, 'ALPHA', now() + make_interval(secs => $6), now() + interval '20 seconds', now() - $7::interval)`,
    [id, GUILD, over.shardId ?? 1, over.forProcess, JSON.stringify({ module: 'm', filename: 'a.json', contentJson: '{"v":1}' }), over.claimBySecs ?? 5, over.createdAgo ?? '0 seconds']);
  return id;
}
const stateOf = async (id: string) => (await rig.direct.query(`SELECT state, claim_batch FROM smdb_data.guild_requests WHERE id = $1`, [id])).rows[0];

describe('provisioning', () => {
  it('creates the table, its CHECKs and both indexes, at the raised version', async () => {
    const value = (await rig.direct.query(`SELECT value FROM smdb_data.meta WHERE key = 'schema_version'`)).rows[0].value;
    expect(value).toBe(JSON.stringify({ v: SCHEMA_VERSION }));
    const indexes = (await rig.direct.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'smdb_data' AND tablename = 'guild_requests' ORDER BY indexname`)).rows.map(r => r.indexname);
    expect(indexes).toEqual(['guild_requests_applying_idx', 'guild_requests_pending_idx', 'guild_requests_pkey']);
    await expect(rig.direct.query(`INSERT INTO smdb_data.guild_requests (id, guild_id, shard_count, shard_id, for_process, op, body, requested_by, claim_by, answer_by) VALUES ($1, '1', 1, 0, 'p', 'other', '{}', 'x', now(), now())`, [randomUUID()])).rejects.toMatchObject({ code: '23514' });
    await expect(rig.direct.query(`INSERT INTO smdb_data.guild_requests (id, guild_id, shard_count, shard_id, for_process, op, body, requested_by, claim_by, answer_by, state) VALUES ($1, '1', 1, 0, 'p', 'write', '{}', 'x', now(), now(), 'lost')`, [randomUUID()])).rejects.toMatchObject({ code: '23514' });
  });

  it('provisionStoreInTransaction creates it too; a database of the previous version is refused at boot', async () => {
    await rig.direct.query('CREATE DATABASE nb7fresh');
    const url = rig.url.replace(/\/[^/]*$/, '/nb7fresh');
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('BEGIN');
      await provisionStoreInTransaction(client);
      await client.query('COMMIT');
      expect((await client.query(`SELECT to_regclass('smdb_data.guild_requests') IS NOT NULL AS made`)).rows[0].made).toBe(true);
      await client.query(`DROP TABLE smdb_data.guild_requests`);
      await client.query(`UPDATE smdb_data.meta SET value = $1 WHERE key = 'schema_version'`, [JSON.stringify({ v: SCHEMA_VERSION - 1 })]);
    } finally {
      await client.end();
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const backend = new PostgresBackend({ url });
    backend.start();
    try {
      const found = JSON.stringify({ v: SCHEMA_VERSION - 1 });
      expect(await backend.provisionVerdict()).toEqual({ state: 'mismatch', found });
      expect(error).toHaveBeenCalledWith(`[PostgresBackend] schema-mismatch: smdb_data.meta schema_version is ${found}, expected {"v":${SCHEMA_VERSION}}; refusing to serve`);
    } finally {
      await backend.stop();
      error.mockRestore();
    }
    const check = new Client({ connectionString: url });
    await check.connect();
    try {
      expect((await check.query(`SELECT to_regclass('smdb_data.guild_requests') IS NOT NULL AS made`)).rows[0].made).toBe(false);
    } finally {
      await check.end();
    }
  });
});

describe('the holder check', () => {
  const reader = () => new WebuiDataReader();

  it('answers each NB4 state from real rows', async () => {
    const token = await take('b', 1);
    expect(holderStateOf((await reader().holderOf(GUILD)).rows)).toMatchObject({ kind: 'row', state: 'held', shardId: 1, shardCount: 2, holderProcess: 'p-b', holderNode: 'n-b' });
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET released = true, reserved = false WHERE shard_id = 1`);
    expect(holderStateOf((await reader().holderOf(GUILD)).rows)).toMatchObject({ state: 'kept' });
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET reserved = true, renewed_at = now() WHERE shard_id = 1`);
    expect(holderStateOf((await reader().holderOf(GUILD)).rows)).toMatchObject({ state: 'reserved' });
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET expires_up_ms = 0 WHERE shard_id = 1`);
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = 100`);
    expect(holderStateOf((await reader().holderOf(GUILD)).rows)).toMatchObject({ state: 'expired' });
    await rig.direct.query(`INSERT INTO smdb_data.shard_nodes (node_id, node_name, process_id, capacity, takeover_seconds, fit, restartable, returns, started_at, seen_at)
      VALUES ('n-b', 'B', 'p-b2', 4, 30, true, true, true, now(), now())`);
    expect(holderStateOf((await reader().holderOf(GUILD)).rows)).toMatchObject({ state: 'expired-deferred' });
    await rig.direct.query(`DELETE FROM smdb_data.shard_claims`);
    expect(holderStateOf((await reader().holderOf(GUILD)).rows)).toMatchObject({ state: 'none' });
    await rig.direct.query(`DELETE FROM smdb_data.meta WHERE key = 'shard_count'`);
    expect(holderStateOf((await reader().holderOf(GUILD)).rows)).toEqual({ kind: 'no-count' });
    expect(token.claim).toBeGreaterThan(0);
  });

  it('computes the shard as guildIdToShardId does for 1000 random snowflakes', async () => {
    await rig.direct.query(`UPDATE smdb_data.meta SET value = '{"count":7}' WHERE key = 'shard_count'`);
    const r = reader();
    for (let i = 0; i < 1000; i++) {
      const id = (BigInt(Math.floor(Math.random() * 2 ** 40)) << 22n) | BigInt(Math.floor(Math.random() * 2 ** 22));
      const check = holderStateOf((await r.holderOf(String(id))).rows);
      expect(check).toMatchObject({ kind: 'row', shardId: Number((id >> 22n) % 7n) });
    }
  });
});

describe('a request between two machines', () => {
  it('is claimed by the process it names only, applied under its fence, and the sender reads ok and the stored document', async () => {
    const a = await take('a', 0);
    const b = await take('b', 1);
    expect((await rig.backend.hydrateGuild(GUILD, b)).ok).toBe(true);
    const appliedA: GuildDataWriteRequest[] = [];
    const appliedB: GuildDataWriteRequest[] = [];
    sweepFor(a, appliedA).start();
    sweepFor(b, appliedB).start();
    const plan = await planGuildChange(bot, GUILD, 'write');
    expect(plan).toMatchObject({ kind: 'request', holder: { processId: 'p-b', shardId: 1 } });
    const reply = await sendGuildChange(bot, plan, { guildId: GUILD, module: 'm', filename: 'a.json', op: 'write', contentJson: '{"v":2}' });
    expect(reply).toMatchObject({ ok: true, servedBy: 'n-b' });
    expect(appliedA).toHaveLength(0);
    expect(appliedB).toHaveLength(1);
    expect((await rig.direct.query(`SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1 AND module = 'm' AND filename = 'a.json'`, [GUILD])).rows[0].doc).toBe('{"v":2}');
  }, 30_000);

  it('a row past claim_by, or naming another process, is never claimed', async () => {
    const b = await take('b', 1);
    const late = await insertRow({ forProcess: 'p-b', claimBySecs: -1 });
    const other = await insertRow({ forProcess: 'p-old' });
    const applied: GuildDataWriteRequest[] = [];
    await sweepFor(b, applied).pass();
    expect(applied).toHaveLength(0);
    expect((await stateOf(late)).state).toBe('pending');
    expect((await stateOf(other)).state).toBe('pending');
  });

  it('a claim row released or taken by another process claims nothing', async () => {
    const b = await take('b', 1);
    const id = await insertRow({ forProcess: 'p-b' });
    const applied: GuildDataWriteRequest[] = [];
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET released = true WHERE shard_id = 1`);
    await sweepFor(b, applied).pass();
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET released = false, holder_process = 'p-c' WHERE shard_id = 1`);
    await sweepFor(b, applied).pass();
    expect(applied).toHaveLength(0);
    expect((await stateOf(id)).state).toBe('pending');
  });

});

describe('the settle and the claim', () => {
  it('raced 200 times on two connections: exactly one wins each time, and the loser changes nothing', async () => {
    const b = await take('b', 1);
    const one = await poolOf().connect();
    const two = await poolOf().connect();
    try {
      for (let i = 0; i < 200; i++) {
        const id = await insertRow({ forProcess: 'p-b' });
        const batch = randomUUID();
        const [claimed, settled] = await Promise.all([
          one.query(REQUEST_CLAIM_SQL, ['p-b', batch, [2], [1], [b.claim], 16]),
          two.query(SETTLE_UPDATE_SQL, [id]),
        ]);
        const wonClaim = claimed.rows.some(r => r.id === id);
        const wonSettle = settled.rows.length === 1;
        expect(wonClaim !== wonSettle).toBe(true);
        const row = await stateOf(id);
        expect(row.state).toBe(wonClaim ? 'applying' : 'expired');
        if (!wonClaim) expect(row.claim_batch).toBeNull();
        await rig.direct.query(`DELETE FROM smdb_data.guild_requests WHERE id = $1`, [id]);
      }
    } finally {
      one.release();
      two.release();
    }
  }, 120_000);

  it('an insert-form settle before the insert: the insert fails with 23505 and nothing is applied', async () => {
    const b = await take('b', 1);
    const id = randomUUID();
    const values = [id, GUILD, 2, 1, 'p-b', 'write', JSON.stringify({ module: 'm', filename: 'a.json', contentJson: '{}' }), 'ALPHA'];
    expect((await rig.direct.query(SETTLE_INSERT_SQL, values)).rows).toEqual([{ state: 'expired' }]);
    await expect(rig.direct.query(REQUEST_INSERT_SQL, [...values, 5, 20])).rejects.toMatchObject({ code: '23505' });
    const applied: GuildDataWriteRequest[] = [];
    await sweepFor(b, applied).pass();
    expect(applied).toHaveLength(0);
    expect((await stateOf(id)).state).toBe('expired');
  });

  it('the unanswered-batch statement sent after a later claim committed on another connection answers the earlier batch only', async () => {
    const b = await take('b', 1);
    const one = await poolOf().connect();
    const two = await poolOf().connect();
    try {
      const first = await insertRow({ forProcess: 'p-b' });
      const lost = randomUUID();
      expect((await one.query(REQUEST_CLAIM_SQL, ['p-b', lost, [2], [1], [b.claim], 16])).rows.map(r => r.id)).toEqual([first]);
      const second = await insertRow({ forProcess: 'p-b' });
      const later = randomUUID();
      expect((await two.query(REQUEST_CLAIM_SQL, ['p-b', later, [2], [1], [b.claim], 16])).rows.map(r => r.id)).toEqual([second]);
      const changed = await one.query(UNANSWERED_BATCHES_SQL, [[lost], []]);
      expect(changed.rowCount).toBe(1);
      const rows = (await rig.direct.query(`SELECT id, state, reply, claim_batch FROM smdb_data.guild_requests WHERE id = ANY($1::uuid[])`, [[first, second]])).rows;
      expect(rows.find(r => r.id === first)).toMatchObject({ state: 'done', reply: UNAPPLIED_REPLY, claim_batch: lost });
      expect(rows.find(r => r.id === second)).toMatchObject({ state: 'applying', reply: null, claim_batch: later });
    } finally {
      one.release();
      two.release();
    }
  });

  it('ruling 8: the unanswered-batch statement leaves out the ids the process started, in the same batch', async () => {
    const b = await take('b', 1);
    const started = await insertRow({ forProcess: 'p-b' });
    const fresh = await insertRow({ forProcess: 'p-b' });
    const lost = randomUUID();
    expect((await rig.direct.query(REQUEST_CLAIM_SQL, ['p-b', lost, [2], [1], [b.claim], 16])).rows.map(r => r.id).sort()).toEqual([started, fresh].sort());
    const changed = await rig.direct.query(UNANSWERED_BATCHES_SQL, [[lost], [started, randomUUID()]]);
    expect(changed.rowCount).toBe(1);
    const rows = (await rig.direct.query(`SELECT id, state, reply, claim_batch, done_at FROM smdb_data.guild_requests WHERE id = ANY($1::uuid[])`, [[started, fresh]])).rows;
    expect(rows.find(r => r.id === started)).toMatchObject({ state: 'applying', reply: null, claim_batch: lost, done_at: null });
    expect(rows.find(r => r.id === fresh)).toMatchObject({ state: 'done', reply: UNAPPLIED_REPLY, claim_batch: lost });
    expect(rows.find(r => r.id === fresh)!.done_at).not.toBeNull();
    expect((await rig.direct.query(ANSWER_SQL, [started, lost, JSON.stringify({ ok: true })])).rowCount).toBe(1);
    expect((await rig.direct.query(`SELECT state, reply FROM smdb_data.guild_requests WHERE id = $1`, [started])).rows).toEqual([{ state: 'done', reply: JSON.stringify({ ok: true }) }]);
  });
});

let driver: DataReadinessDriver | null = null;

/** The bot process of token: its working set and readiness over the rig's backend, serving the token's shard. */
async function stack(token: FenceToken): Promise<void> {
  setBackendKind('postgres');
  setGuildDataBackend(rig.backend);
  setOwnerInfoProvider(() => ({ nodeId: token.nodeId, processId: token.processId, shardCount: 2, claimOf: s => (s === token.shardId ? token.claim : null) }));
  driver?.stop();
  const ws = initWorkingSet(rig.backend);
  driver = initDataReadiness(rig.backend, ws, { held: false });
  driver.onLeaseChanged({ nodeId: token.nodeId, processId: token.processId, claims: { [token.shardId]: token.claim }, shardCount: 2, shardIds: [token.shardId] });
  await driver.awaitInitialHydration(20_000);
}

/** A sweep of token's process that applies through the bot's own executor, after gate when one is given. */
function executorSweep(token: FenceToken, gate?: { reached: () => void; open: Promise<void> }): GuildRequestSweep {
  const s = new GuildRequestSweep({
    db: sweepDb(poolOf()),
    processId: () => token.processId,
    pairs: () => [{ shardCount: token.shardCount, shardId: token.shardId, claim: token.claim! }],
    stoppedServing: () => false,
    isStopping: () => false,
    apply: async req => {
      if (gate) {
        gate.reached();
        await gate.open;
      }
      return answerGuildWrite(req);
    },
  });
  sweeps.push(s);
  return s;
}

const shard1Guild = (n: bigint) => String(((2n * n) + 1n) << 22n);
const pause = (ms: number) => new Promise(resolve => { setTimeout(resolve, ms); });

async function answered(id: string, boundMs = 30_000): Promise<any> {
  const until = Date.now() + boundMs;
  for (;;) {
    const row = (await rig.direct.query(`SELECT state, reply FROM smdb_data.guild_requests WHERE id = $1`, [id])).rows[0];
    if (row?.state === 'done') return JSON.parse(row.reply);
    if (Date.now() > until) throw new Error(`request ${id} not answered within ${boundMs} ms (state ${row?.state})`);
    await pause(100);
  }
}

async function graveyardRequest(guildId: string, op: 'restore-graveyard' | 'delete-namespace', answerSecs: number, contentJson?: string): Promise<string> {
  const id = randomUUID();
  await rig.direct.query(
    `INSERT INTO smdb_data.guild_requests (id, guild_id, shard_count, shard_id, for_process, op, body, requested_by, claim_by, answer_by)
     VALUES ($1, $2, 2, 1, 'p-b', $3, $4, 'ALPHA', now() + interval '5 seconds', now() + make_interval(secs => $5))`,
    [id, guildId, op, JSON.stringify({ module: '', filename: '', contentJson }), answerSecs]);
  return id;
}

const docsOf = async (guildId: string) => (await rig.direct.query(`SELECT module, filename, doc FROM smdb_data.guild_data WHERE guild_id = $1 ORDER BY filename`, [guildId])).rows;
const graveOf = async (guildId: string) => (await rig.direct.query(`SELECT filename, doc, retired_at FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 ORDER BY filename`, [guildId])).rows;

describe('through the bot\'s own executor', () => {
  it('a holder whose pair was taken after its claim answers not-owner, the sender says so on its name, and the document is the new holder\'s', async () => {
    const g = shard1Guild(100n);
    const b = await take('b', 1);
    await stack(b);
    expect(await answerGuildWrite({ guildId: g, op: 'write', module: 'm', filename: 'seed.json', contentJson: '{}' })).toMatchObject({ ok: true });
    let reached = false;
    let open!: () => void;
    const s = executorSweep(b, { reached: () => { reached = true; }, open: new Promise<void>(resolve => { open = resolve; }) });
    const plan = await planGuildChange(bot, g, 'write');
    expect(plan).toMatchObject({ kind: 'request', holder: { processId: 'p-b' } });
    const replyP = sendGuildChange(bot, plan, { guildId: g, module: 'm', filename: 'a.json', op: 'write', contentJson: '{"by":"b"}' });
    for (let i = 0; i < 50 && !reached; i++) {
      await s.pass();
      await pause(100);
    }
    expect(reached).toBe(true);
    const c = await take('c', 1);
    expect((await rig.backend.hydrateGuild(g, c)).ok).toBe(true);
    expect(await rig.backend.flushGuild(g, { upserts: [{ key: { module: 'm', filename: 'a.json' }, doc: '{"by":"c"}' }], deletes: [], appends: [] }, c)).toEqual({ ok: true });
    open();
    const reply = await replyP;
    expect(reply).toMatchObject({ ok: false, code: 'not-owner', servedBy: 'n-b' });
    const row = (await rig.direct.query(`SELECT state, reply FROM smdb_data.guild_requests WHERE guild_id = $1 AND op = 'write'`, [g])).rows;
    expect(row).toHaveLength(1);
    expect(row[0].state).toBe('done');
    expect(JSON.parse(row[0].reply)).toMatchObject({ ok: false, code: 'not-owner' });
    const out: { status?: number; body?: any } = {};
    sendHopReply({ status(code: number) { out.status = code; return this; }, json(body: any) { out.body = body; return this; } } as any, reply);
    expect(out.status).toBe(503);
    expect(String(out.body.error)).toMatch(/^On n-b: Another bot process took over this guild's data, so the change was not saved/);
    expect((await docsOf(g)).find(d => d.filename === 'a.json')?.doc).toBe('{"by":"c"}');
  }, 60_000);

  it('a restore through the table with less time left than NB11\'s 5 s margin answers out-of-time and restores nothing', async () => {
    const g = shard1Guild(101n);
    const b = await take('b', 1);
    await stack(b);
    await rig.direct.query(`INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason) VALUES ($1, 'm', 'a.json', 'doc', '{"a":1}', 5, 'test')`, [g]);
    const id = await graveyardRequest(g, 'restore-graveyard', 4, JSON.stringify({ retiredAt: 5 }));
    await executorSweep(b).pass();
    expect(await answered(id)).toMatchObject({ ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.outOfTime });
    expect(await docsOf(g)).toEqual([]);
    expect(await graveOf(g)).toEqual([{ filename: 'a.json', doc: '{"a":1}', retired_at: expect.anything() }]);
  }, 60_000);

  it('a restore through the table with 50 s left restores the entry and answers ok', async () => {
    const g = shard1Guild(102n);
    const b = await take('b', 1);
    await stack(b);
    await rig.direct.query(`INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason) VALUES ($1, 'm', 'a.json', 'doc', '{"a":1}', 5, 'test')`, [g]);
    const id = await graveyardRequest(g, 'restore-graveyard', 50, JSON.stringify({ retiredAt: 5 }));
    await executorSweep(b).pass();
    expect(await answered(id)).toMatchObject({ ok: true, retiredAt: 5 });
    expect(await docsOf(g)).toEqual([{ module: 'm', filename: 'a.json', doc: '{"a":1}' }]);
    expect(await graveOf(g)).toEqual([]);
  }, 60_000);

  it('a restore through the table with 30 s left gets NB11\'s 25 s (answer_by less its 5 s margin): it restores the entry and answers ok', async () => {
    const g = shard1Guild(105n);
    const b = await take('b', 1);
    await stack(b);
    await rig.direct.query(`INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason) VALUES ($1, 'm', 'a.json', 'doc', '{"a":5}', 7, 'test')`, [g]);
    const id = await graveyardRequest(g, 'restore-graveyard', 30, JSON.stringify({ retiredAt: 7 }));
    await executorSweep(b).pass();
    expect(await answered(id)).toMatchObject({ ok: true, retiredAt: 7 });
    expect(await docsOf(g)).toEqual([{ module: 'm', filename: 'a.json', doc: '{"a":5}' }]);
    expect(await graveOf(g)).toEqual([]);
  }, 60_000);

  it('a namespace delete through the table with less time left than the margin answers out-of-time and removes nothing', async () => {
    const g = shard1Guild(103n);
    const b = await take('b', 1);
    await stack(b);
    expect(await answerGuildWrite({ guildId: g, op: 'write', module: 'm', filename: 'a.json', contentJson: '{"a":2}' })).toMatchObject({ ok: true });
    const id = await graveyardRequest(g, 'delete-namespace', 4);
    await executorSweep(b).pass();
    expect(await answered(id)).toMatchObject({ ok: false, code: 'backend-unavailable', error: DELETE_TEXTS.outOfTime });
    expect(await docsOf(g)).toEqual([{ module: 'm', filename: 'a.json', doc: JSON.stringify({ a: 2 }, null, 2) }]);
    expect(await graveOf(g)).toEqual([]);
  }, 60_000);

  it('a namespace delete through the table with 50 s left moves the data to the graveyard and answers ok', async () => {
    const g = shard1Guild(104n);
    const b = await take('b', 1);
    await stack(b);
    expect(await answerGuildWrite({ guildId: g, op: 'write', module: 'm', filename: 'a.json', contentJson: '{"a":3}' })).toMatchObject({ ok: true });
    const id = await graveyardRequest(g, 'delete-namespace', 50);
    await executorSweep(b).pass();
    expect(await answered(id)).toMatchObject({ ok: true });
    expect(await docsOf(g)).toEqual([]);
    expect(await graveOf(g)).toEqual([{ filename: 'a.json', doc: JSON.stringify({ a: 3 }, null, 2), retired_at: expect.anything() }]);
  }, 60_000);
});

describe('the sender\'s refusals and the cleanup', () => {
  it('a login refused: the insert answers the maintenance code', async () => {
    await take('b', 1);
    await rig.direct.query(`CREATE ROLE nb7_sender LOGIN PASSWORD 'pw'`);
    await rig.direct.query(`GRANT USAGE ON SCHEMA smdb_data TO nb7_sender`);
    await rig.direct.query(`GRANT ALL ON ALL TABLES IN SCHEMA smdb_data TO nb7_sender`);
    const url = `postgres://nb7_sender:pw@${rig.container.getHost()}:${rig.container.getPort()}/${rig.container.getDatabase()}`;
    await rig.direct.query(`ALTER ROLE nb7_sender NOLOGIN`);
    const plan: Plan = { kind: 'request', op: 'write', deadline: performance.now() + 60_000, holder: { shardCount: 2, shardId: 1, processId: 'p-b', name: 'n-b', url } };
    const reply = await sendGuildChange(bot, plan, { guildId: GUILD, module: 'm', filename: 'a.json', op: 'write', contentJson: '{}' });
    expect(reply).toMatchObject({ ok: false, code: 'maintenance' });
    expect((await rig.direct.query(`SELECT count(*)::int AS n FROM smdb_data.guild_requests`)).rows[0].n).toBe(0);
  });

  it('cleanup deletes rows older than an hour and keeps the others', async () => {
    const b = await take('b', 1);
    const old = await insertRow({ forProcess: 'p-x', createdAgo: '61 minutes' });
    const fresh = await insertRow({ forProcess: 'p-x', createdAgo: '59 minutes' });
    await rig.direct.query(CLEANUP_SQL);
    expect(await stateOf(old)).toBeUndefined();
    expect((await stateOf(fresh)).state).toBe('pending');
    expect(b.claim).toBeGreaterThan(0);
  });
});
