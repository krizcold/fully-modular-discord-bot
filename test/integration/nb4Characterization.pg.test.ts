import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, GatewayIntentBits } from 'discord.js';
import { Pool } from 'pg';

import { heartbeat, me, startClaimRig, TIMINGS, type ClaimRig } from '../helpers/pgClaimRig';
import { classifyFailure } from '../../src/bot/internalSetup/fleet/claimStore';

// NB4 B8: the Postgres, node-pg and discord.js behaviour the claims design leans on, pinned against the real thing.

let rig: ClaimRig;
beforeAll(async () => { rig = await startClaimRig(); }, 180_000);
afterAll(async () => { await rig?.stop(); });
beforeEach(async () => { await rig.reset(); });

const sleep = (ms: number) => new Promise(resolve => { setTimeout(resolve, ms); });

async function seedRow(claim: number) {
  await rig.direct.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
    VALUES (1, 0, $1, 'p-a', 'n-a', 'A', 'n-a', 30000, 30000)`, [claim]);
}

describe('Postgres', () => {
  it('now() is the transaction\'s start inside a multi-statement transaction', async () => {
    const client = await rig.direct.connect();
    try {
      await client.query('BEGIN');
      const first = (await client.query(`SELECT now()::text AS t, clock_timestamp()::text AS c`)).rows[0];
      await client.query('SELECT pg_sleep(0.05)');
      const second = (await client.query(`SELECT now()::text AS t, clock_timestamp()::text AS c`)).rows[0];
      await client.query('COMMIT');
      expect(second.t).toBe(first.t);
      expect(second.c).not.toBe(first.c);
    } finally {
      client.release();
    }
  });

  it('an UPDATE blocked on a row lock re-checks its WHERE on the new row version and updates nothing when the row changed', async () => {
    await seedRow(5);
    const holder = await rig.direct.connect();
    const other = await rig.direct.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE smdb_data.shard_claims SET claim = 6 WHERE shard_id = 0`);
      const blocked = other.query(`UPDATE smdb_data.shard_claims SET holder_process = 'p-b' WHERE shard_id = 0 AND claim = 5`);
      await sleep(200);
      await holder.query('COMMIT');
      expect((await blocked).rowCount).toBe(0);
      expect((await rig.row(0)).holder_process).toBe('p-a');
    } finally {
      holder.release();
      other.release();
    }
  });

  it('INSERT ... ON CONFLICT DO UPDATE waits for an uncommitted conflicting insert and checks its WHERE on the committed row', async () => {
    const holder = await rig.direct.connect();
    const other = await rig.direct.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count) VALUES ('g1', 'n-a', 0, 10, 1)`);
      const blocked = other.query(`INSERT INTO smdb_data.guild_ownership AS o (guild_id, node_id, shard_id, claim, shard_count) VALUES ('g1', 'n-b', 0, 5, 1)
        ON CONFLICT (guild_id) DO UPDATE SET node_id = EXCLUDED.node_id, claim = EXCLUDED.claim WHERE o.claim <= EXCLUDED.claim`);
      await sleep(200);
      await holder.query('COMMIT');
      expect((await blocked).rowCount).toBe(0);
      const row = (await rig.direct.query(`SELECT node_id, claim::text AS claim FROM smdb_data.guild_ownership WHERE guild_id = 'g1'`)).rows[0];
      expect(row).toEqual({ node_id: 'n-a', claim: '10' });
    } finally {
      holder.release();
      other.release();
    }
  });

  it('UPDATE\'s SET expressions read the row as it was before the update', async () => {
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = 1000, last_gap_ms = 0`);
    const row = (await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = up_ms + 500, last_gap_ms = up_ms RETURNING up_ms::text AS up, last_gap_ms::text AS gap`)).rows[0];
    expect(row).toEqual({ up: '1500', gap: '1000' });
  });

  it('lock_timeout ends a wait on pg_advisory_xact_lock with 55P03', async () => {
    const holder = await rig.direct.connect();
    const other = await rig.direct.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext('smdb_data_claim'))`);
      await other.query('BEGIN');
      await other.query(`SET LOCAL lock_timeout = 200`);
      const started = Date.now();
      const error = await other.query(`SELECT pg_advisory_xact_lock(hashtext('smdb_data_claim'))`).catch(e => e);
      expect(error.code).toBe('55P03');
      expect(Date.now() - started).toBeLessThan(2000);
      await other.query('ROLLBACK');
      await holder.query('COMMIT');
    } finally {
      holder.release();
      other.release();
    }
  });

  it('a renewal blocked on the clock row by an open transaction ends on the server within S, and the next renewal proceeds', async () => {
    const store = rig.store();
    const holder = await rig.direct.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE smdb_data.claim_clock SET up_ms = up_ms`);
      const started = Date.now();
      const failure = await store.renew({ me: me('a'), pairs: [], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat() }).then(() => null, (e: unknown) => classifyFailure(e));
      const took = Date.now() - started;
      expect(failure).not.toBeNull();
      expect(took).toBeLessThan(TIMINGS.renewMs);
      await sleep(200);
      const active = (await rig.direct.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'smdb-claims' AND state = 'active'`)).rows[0].n;
      expect(active).toBe(0);
      await holder.query('COMMIT');
      const ok = await store.renew({ me: me('a'), pairs: [], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat() });
      expect(ok.priorProcess).toBeNull();
    } finally {
      holder.release();
    }
  });
});

describe('node-pg', () => {
  it('query_timeout rejects the query, and release(true) closes its connection on the server', async () => {
    const pool = new Pool({ connectionString: rig.url, max: 1, application_name: 'smdb-characterize' });
    try {
      const client = await pool.connect();
      const pid = (await client.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      const error: unknown = await client.query({ text: 'SELECT pg_sleep(5)', query_timeout: 200 } as any).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(classifyFailure(error)).toEqual({ kind: 'timeout' });
      client.release(true);
      let alive = 1;
      for (let i = 0; i < 50 && alive > 0; i++) {
        await sleep(100);
        alive = (await rig.direct.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1`, [pid])).rows[0].n;
      }
      expect(alive).toBe(0);
    } finally {
      await pool.end();
    }
  });
});

describe('discord.js 14', () => {
  it('a Client with shards [] and a shardCount throws ClientInvalidProvidedShards; one without shards is accepted', () => {
    expect(() => new Client({ intents: [GatewayIntentBits.Guilds], shards: [], shardCount: 2 })).toThrow(/shard/i);
    let thrown: any = null;
    try { new Client({ intents: [GatewayIntentBits.Guilds], shards: [], shardCount: 2 }); } catch (error) { thrown = error; }
    expect(thrown?.code).toBe('ClientInvalidProvidedShards');
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    void client.destroy();
  });
});
