import type { Pool } from 'pg';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';

// NB4: a save lands only under the claim row of its shard. Tests that exercise the guild fence alone take that row
// directly: a new claim from claim_seq above every claim held, written to the shard's row for the process.

export async function takeShard(pool: Pool, opts: { processId: string; nodeId: string; shardId?: number; shardCount?: number }): Promise<FenceToken> {
  const shardId = opts.shardId ?? 0;
  const shardCount = opts.shardCount ?? 1;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('smdb_data_claim'))`);
    const floor = Number((await client.query(`SELECT GREATEST(
      COALESCE((SELECT max(claim) FROM smdb_data.guild_ownership), 0),
      COALESCE((SELECT max(claim) FROM smdb_data.shard_claims), 0))::text AS f`)).rows[0].f);
    let claim = Number((await client.query(`SELECT nextval('smdb_data.claim_seq')::text AS n`)).rows[0].n);
    if (claim <= floor) {
      claim = floor + 1;
      await client.query(`SELECT setval('smdb_data.claim_seq', $1)`, [claim]);
    }
    await client.query(`INSERT INTO smdb_data.shard_claims
        (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
      VALUES ($1, $2, $3, $4, $5, $5, $5, 30000, 30000)
      ON CONFLICT (shard_count, shard_id) DO UPDATE SET claim = EXCLUDED.claim, holder_process = EXCLUDED.holder_process,
        holder_node = EXCLUDED.holder_node, holder_name = EXCLUDED.holder_name, released = false, reserved = false`,
    [shardCount, shardId, claim, opts.processId, opts.nodeId]);
    await client.query('COMMIT');
    return { nodeId: opts.nodeId, claim, processId: opts.processId, shardId, shardCount };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
