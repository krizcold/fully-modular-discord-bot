// NB4 decision 23: the shard_claims part of NM9's restore raise, the fixture computer 2 builds the manager's restore
// against. $1 is the floor read before the restore: GREATEST(claim_seq.last_value, max(guild_ownership.claim),
// max(shard_claims.claim)). Every restored row at or below it gets its own number above it, in (shard_count, shard_id)
// order, and an expiry at or below the restored clock; the sequence ends above every number either table holds. Holders,
// homes, TTLs, the released and reserved flags and the clock row stay as restored.

export const RESTORE_RAISE_SQL = `
WITH clock AS (
  SELECT up_ms FROM smdb_data.claim_clock WHERE id = 1
), renumber AS (
  SELECT shard_count, shard_id, row_number() OVER (ORDER BY shard_count, shard_id) AS n
    FROM smdb_data.shard_claims
   WHERE claim <= $1::bigint
), raised AS (
  UPDATE smdb_data.shard_claims c
     SET claim = $1::bigint + r.n,
         expires_up_ms = LEAST(c.expires_up_ms, (SELECT up_ms FROM clock))
    FROM renumber r
   WHERE c.shard_count = r.shard_count AND c.shard_id = r.shard_id
  RETURNING c.claim
)
SELECT setval('smdb_data.claim_seq', GREATEST(
  $1::bigint,
  COALESCE((SELECT max(claim) FROM raised), 0),
  COALESCE((SELECT max(claim) FROM smdb_data.shard_claims WHERE claim > $1::bigint), 0),
  COALESCE((SELECT max(claim) FROM smdb_data.guild_ownership), 0)))::text AS seq`;

/** The floor of decision 23, read before the restore. */
export const RESTORE_FLOOR_SQL = `
SELECT GREATEST(
  (SELECT last_value FROM smdb_data.claim_seq),
  COALESCE((SELECT max(claim) FROM smdb_data.guild_ownership), 0),
  COALESCE((SELECT max(claim) FROM smdb_data.shard_claims), 0))::text AS floor`;
