// The statements of smdb_data.guild_requests (NB7), shared by the web UI that sends a change and the bot process that
// holds the guild's shard and applies it, with the spans both sides count by.

export type GuildRequestOp = 'write' | 'delete' | 'delete-namespace' | 'restore-graveyard';

/** The largest guild id the holder check can cast to bigint. */
export const MAX_GUILD_ID = 9223372036854775807n;

/** A holder may start a request only within this long after its insert. */
export const CLAIM_SPAN_S = 5;

/** How long after its insert a holder's apply must end: the answer span. */
export function answerSpanS(op: GuildRequestOp): number {
  return op === 'restore-graveyard' || op === 'delete-namespace' ? 50 : 20;
}

/** The deadline T of a change, from the start of its plan. */
export function changeDeadlineMs(op: GuildRequestOp): number {
  return op === 'restore-graveyard' || op === 'delete-namespace' ? 90_000 : 60_000;
}

/**
 * The shard of a guild and the claim row that serves it: Discord's formula over the stored count, the row's state
 * columns as NB4's state reads them (claimStore.ts holderStateOf), the claim clock and the holder's machine row.
 */
export const HOLDER_CHECK_SQL = `
WITH m AS (SELECT (value::jsonb ->> 'count')::int AS n FROM smdb_data.meta WHERE key = 'shard_count'),
     s AS (SELECT n, (($1::bigint >> 22) % n)::int AS shard FROM m)
SELECT s.n, s.shard, c.holder_process, c.holder_node, c.holder_name, c.claim::text AS claim, c.released, c.reserved,
       c.ttl_ms::text AS ttl_ms, c.expires_up_ms::text AS expires_up_ms,
       (extract(epoch FROM (now() - c.renewed_at)) * 1000)::float8 AS renewed_ago_ms,
       k.up_ms::text AS up_ms,
       d.process_id AS node_process_id, d.takeover_seconds AS node_takeover_seconds,
       (extract(epoch FROM (now() - d.seen_at)) * 1000)::float8 AS node_seen_ago_ms
  FROM s LEFT JOIN smdb_data.shard_claims c ON c.shard_count = s.n AND c.shard_id = s.shard
  LEFT JOIN smdb_data.claim_clock k ON k.id = 1
  LEFT JOIN smdb_data.shard_nodes d ON d.node_id = c.holder_node`;

/** The insert, which notifies the holder's listener with its for_process at COMMIT (NB6 decision 17). */
export const REQUEST_INSERT_SQL = `
WITH r AS (
INSERT INTO smdb_data.guild_requests
  (id, guild_id, shard_count, shard_id, for_process, op, body, requested_by, claim_by, answer_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9), now() + make_interval(secs => $10))
RETURNING for_process)
SELECT pg_notify('smdb_guild_requests', r.for_process) FROM r`;

export const REQUEST_POLL_SQL = `
SELECT state, reply, now() >= claim_by AS pickup_over, now() >= answer_by + interval '5 seconds' AS answer_over
  FROM smdb_data.guild_requests WHERE id = $1`;

/** The settle while the insert has no answer: the row it inserts holds the id against a late insert. */
export const SETTLE_INSERT_SQL = `
INSERT INTO smdb_data.guild_requests AS r
  (id, guild_id, shard_count, shard_id, for_process, op, body, requested_by, claim_by, answer_by, state, done_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now(), 'expired', now())
ON CONFLICT (id) DO UPDATE SET state = 'expired', done_at = now() WHERE r.state = 'pending'
RETURNING r.state`;

/** The settle once the insert is acknowledged. */
export const SETTLE_UPDATE_SQL = `
UPDATE smdb_data.guild_requests SET state = 'expired', done_at = now()
 WHERE id = $1 AND state = 'pending' RETURNING state`;

/** $1 this process's id, $2 the batch id, $3/$4/$5 its pairs (count, shard, claim), $6 free places. */
export const REQUEST_CLAIM_SQL = `
WITH pairs AS (SELECT * FROM unnest($3::int[], $4::int[], $5::bigint[]) AS p(shard_count, shard_id, claim)),
     pick AS (
       SELECT r.id, p.claim FROM smdb_data.guild_requests r
         JOIN pairs p ON p.shard_count = r.shard_count AND p.shard_id = r.shard_id
         JOIN smdb_data.shard_claims c ON c.shard_count = p.shard_count AND c.shard_id = p.shard_id
                                      AND c.claim = p.claim AND c.holder_process = $1 AND NOT c.released
        WHERE r.state = 'pending' AND r.for_process = $1 AND r.claim_by > now()
        ORDER BY r.created_at LIMIT $6
        FOR UPDATE OF r SKIP LOCKED)
UPDATE smdb_data.guild_requests r
   SET state = 'applying', claim_batch = $2, applier_claim = pick.claim, taken_at = now()
  FROM pick
 WHERE r.id = pick.id AND r.state = 'pending' AND r.claim_by > now()
RETURNING r.id, r.guild_id, r.op, r.body, r.requested_by,
          GREATEST((extract(epoch FROM r.answer_by - now()) * 1000)::bigint, 0) AS left_ms`;

export const UNAPPLIED_REPLY = '{"ok":false,"code":"not-taken","unapplied":true}';

export const UNANSWERED_BATCHES_SQL = `
UPDATE smdb_data.guild_requests
   SET state = 'done', reply = '${UNAPPLIED_REPLY}', done_at = now()
 WHERE claim_batch = ANY($1::uuid[]) AND state = 'applying' AND NOT (id = ANY($2::uuid[]))`;

export const ANSWER_SQL = `
UPDATE smdb_data.guild_requests SET state = 'done', reply = $3, done_at = now()
 WHERE id = $1 AND claim_batch = $2 AND state = 'applying'`;

export const ANSWER_READ_BACK_SQL = `SELECT state, reply FROM smdb_data.guild_requests WHERE id = $1`;

export const CLEANUP_SQL = `
DELETE FROM smdb_data.guild_requests WHERE id IN
  (SELECT id FROM smdb_data.guild_requests WHERE created_at < now() - interval '1 hour' LIMIT 500)`;

/**
 * What a failed statement proves. 'refused': the server answered with a SQLSTATE that means the statement rolled back.
 * 'unknown': no answer (a client bound, a connection ended, 57P01 to 57P03 or class 08), so it may have committed.
 */
export function failureOf(error: unknown): { kind: 'refused'; code: string; message: string } | { kind: 'unknown'; cause: string } {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && !/^57P0[123]$/.test(code) && !code.startsWith('08')) {
    return { kind: 'refused', code, message };
  }
  return { kind: 'unknown', cause: message };
}
