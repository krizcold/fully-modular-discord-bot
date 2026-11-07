// NB9's reshard row SQL: decision 6's start, 8's flip, 10's close and 11's call-offs (with 32, 33 and 66). Each is one
// transaction under NB4's advisory lock that reads every fact it judges, decides by the pure verdict in
// reshardRules.ts and writes only when the verdict allows. A caller passes a client of the claims pool.

import {
  callOffVerdict, closeVerdict, flipVerdict, keptFailures, startVerdict, untilSeconds,
  type AskedCallOff, type FactNode, type FactRow, type ReshardFacts, type ReshardRow, type ReshardState, type StartRefusal,
} from './reshardRules';

export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

const CLAIM_LOCK = `SELECT pg_advisory_xact_lock(hashtext('smdb_data_claim'))`;
const ms = (expr: string) => `(extract(epoch FROM ${expr}) * 1000)::float8`;

/** C1: a store whose row 1 was deleted by hand gets provisioning's seed back before the start's FOR UPDATE read. */
export const RESHARD_SEED_SQL = `INSERT INTO smdb_data.reshard (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;

export const RESHARD_READ_SQL = `
SELECT r.attempt::text AS attempt, r.state, r.method, r.from_count, r.to_count, r.target, r.target_by,
       ${ms('r.target_at')} AS target_at, ${ms('r.started_at')} AS started_at, ${ms('r.until_at')} AS until_at,
       ${ms('r.retry_after')} AS retry_after, r.failures, r.reason,
       (SELECT (m.value::jsonb ->> 'count')::int FROM smdb_data.meta m WHERE m.key = 'shard_count') AS meta_count,
       (SELECT up_ms::text FROM smdb_data.claim_clock WHERE id = 1) AS up_ms,
       ${ms('now()')} AS now_ms
  FROM (SELECT 1) one LEFT JOIN smdb_data.reshard r ON r.id = 1`;

const ROWS_SQL = `
SELECT shard_count, shard_id, released, expires_up_ms::text AS expires_up_ms, ready, ttl_ms::text AS ttl_ms,
       ${ms('(now() - renewed_at)')} AS renewed_ago_ms, holder_process, holder_node, holder_name
  FROM smdb_data.shard_claims`;

const NODES_SQL = `
SELECT node_id, node_name, process_id, fit, restartable, reshard_overlap, takeover_seconds,
       ${ms('(now() - seen_at)')} AS seen_ago_ms, ${ms('(now() - started_at)')} AS started_ago_ms,
       memory_room, memory_free_mb, memory_use_mb, memory_error, ${ms('(now() - memory_at)')} AS memory_ago_ms
  FROM smdb_data.shard_nodes`;

/** Every fact the verdicts read, in the caller's transaction after the lock; `forUpdate` locks the reshard row first. */
export async function readFacts(client: SqlClient, forUpdate = false): Promise<ReshardFacts> {
  if (forUpdate) await client.query(`SELECT 1 FROM smdb_data.reshard WHERE id = 1 FOR UPDATE`);
  const r = (await client.query(RESHARD_READ_SQL)).rows[0] ?? {};
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const row: ReshardRow = {
    attempt: r.attempt ?? null,
    state: (r.state ?? null) as ReshardState | null,
    method: r.method ?? null,
    fromCount: num(r.from_count),
    toCount: num(r.to_count),
    target: num(r.target),
    targetBy: r.target_by ?? null,
    targetAtMs: num(r.target_at),
    startedAtMs: num(r.started_at),
    untilAtMs: num(r.until_at),
    retryAfterMs: num(r.retry_after),
    failures: Number(r.failures ?? 0),
    reason: r.reason ?? null,
  };
  const rows: FactRow[] = (await client.query(ROWS_SQL)).rows.map((x: any) => ({
    shardCount: Number(x.shard_count), shardId: Number(x.shard_id), released: x.released === true,
    expiresUpMs: Number(x.expires_up_ms), ready: x.ready === true, renewedAgoMs: Number(x.renewed_ago_ms),
    ttlMs: Number(x.ttl_ms), holderProcess: x.holder_process, holderNode: x.holder_node, holderName: x.holder_name,
  }));
  const nodes: FactNode[] = (await client.query(NODES_SQL)).rows.map((x: any) => ({
    nodeId: x.node_id, nodeName: x.node_name, processId: x.process_id, fit: x.fit === true, restartable: x.restartable === true,
    reshardOverlap: x.reshard_overlap !== false, seenAgoMs: Number(x.seen_ago_ms), takeoverSeconds: Number(x.takeover_seconds),
    startedAgoMs: Number(x.started_ago_ms ?? 0), memoryRoom: x.memory_room ?? null, memoryFreeMb: num(x.memory_free_mb),
    memoryUseMb: num(x.memory_use_mb), memoryError: x.memory_error ?? null, memoryAgoMs: num(x.memory_ago_ms),
  }));
  return { row, metaCount: num(r.meta_count), upMs: Number(r.up_ms ?? 0), nowMs: Number(r.now_ms), rows, nodes };
}

async function inTransaction<T>(client: SqlClient, fn: () => Promise<{ commit: boolean; answer: T }>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(CLAIM_LOCK);
    const { commit, answer } = await fn();
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return answer;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export interface StartRequest {
  /** A random UUID minted by the starting process. */
  attempt: string;
  /** W. */
  wanted: number;
  method: 'overlap' | 'stop-start';
  /** Why stop-start was chosen; null for overlap. */
  reason: string | null;
  /** This machine's name. */
  startedBy: string;
  maxConcurrency: number;
}

export type StartAnswer =
  | { kind: 'started'; fromCount: number; toCount: number; untilSeconds: number; deleted: number }
  | { kind: 'refused'; why: StartRefusal };

/**
 * Decision 6: the seed, the reshard row read FOR UPDATE with every condition, the delete of the released or expired
 * rows of counts other than N, and the attempt written. Two machines starting on one tick: the row lock lets one.
 */
export async function startReshard(client: SqlClient, request: StartRequest): Promise<StartAnswer> {
  return inTransaction<StartAnswer>(client, async () => {
    await client.query(RESHARD_SEED_SQL);
    const facts = await readFacts(client, true);
    const why = startVerdict(facts, request.wanted, request.method);
    if (why !== null) return { commit: false, answer: { kind: 'refused', why } };
    const n = facts.metaCount!;
    const deleted = (await client.query(`DELETE FROM smdb_data.shard_claims
      WHERE shard_count <> $1::int AND (released OR expires_up_ms <= $2::bigint) RETURNING 1`, [n, facts.upMs])).rows.length;
    const until = untilSeconds(request.method, request.wanted, request.maxConcurrency);
    await client.query(`UPDATE smdb_data.reshard SET attempt = $1::uuid, from_count = $2::int, to_count = $3::int,
        method = $4::text, state = $5::text, started_by = $6::text, started_at = now(),
        until_at = now() + make_interval(secs => $7::int), reason = $8::text, failures = $9::int,
        flipped_at = NULL, ended_at = NULL
      WHERE id = 1`, [
      request.attempt, n, request.wanted, request.method, request.method === 'overlap' ? 'standby' : 'stopping',
      request.startedBy, until, request.reason, keptFailures(facts.row, request.wanted),
    ]);
    return { commit: true, answer: { kind: 'started', fromCount: n, toCount: request.wanted, untilSeconds: until, deleted } };
  });
}

export type FlipAnswer = { kind: 'flipped'; fromCount: number; toCount: number } | { kind: 'not-yet'; row: ReshardRow };

/** Decision 8: meta 'shard_count' = W and the attempt 'flipped', in one transaction, only on every condition. */
export async function flipReshard(client: SqlClient, attempt: string): Promise<FlipAnswer> {
  return inTransaction<FlipAnswer>(client, async () => {
    const facts = await readFacts(client);
    if (!flipVerdict(facts, attempt)) return { commit: false, answer: { kind: 'not-yet', row: facts.row } };
    const w = facts.row.toCount!;
    await client.query(`UPDATE smdb_data.meta SET value = $1, updated_at = now() WHERE key = 'shard_count'`, [JSON.stringify({ count: w })]);
    await client.query(`UPDATE smdb_data.reshard SET state = 'flipped', flipped_at = now()
      WHERE id = 1 AND attempt = $1::uuid AND state = 'standby'`, [attempt]);
    return { commit: true, answer: { kind: 'flipped', fromCount: facts.row.fromCount!, toCount: w } };
  });
}

export type CloseAnswer =
  | { kind: 'closed'; fromCount: number; toCount: number; expired: number[] }
  | { kind: 'not-yet'; row: ReshardRow };

/**
 * Decision 10's close inside a transaction the caller holds under the lock: when the attempt is 'flipped' and
 * no from_count row is live, every from_count row is deleted and the attempt is 'done'.
 * `attempt` null closes whatever attempt is flipped.
 */
export async function closeIn(client: SqlClient, attempt: string | null): Promise<CloseAnswer> {
  const facts = await readFacts(client);
  const verdict = closeVerdict(facts, attempt);
  if (!verdict.close) return { kind: 'not-yet', row: facts.row };
  const { fromCount, toCount } = facts.row;
  await client.query(`DELETE FROM smdb_data.shard_claims WHERE shard_count = $1::int`, [fromCount]);
  await client.query(`UPDATE smdb_data.reshard SET state = 'done', ended_at = now(), failures = 0, retry_after = NULL
    WHERE id = 1 AND attempt = $1::uuid AND state = 'flipped'`, [facts.row.attempt]);
  return { kind: 'closed', fromCount: fromCount!, toCount: toCount!, expired: verdict.expired };
}

/** Decision 10's close as its own transaction: a standby's poll and a waiting process's check. */
export async function closeReshard(client: SqlClient, attempt: string | null): Promise<CloseAnswer> {
  return inTransaction<CloseAnswer>(client, async () => {
    const answer = await closeIn(client, attempt);
    return { commit: answer.kind === 'closed', answer };
  });
}

export type CallOffAnswer =
  | { kind: 'called-off'; attempt: string; fromCount: number; toCount: number; reason: string; retryAfterMs: number; retryNow: boolean }
  | { kind: 'none'; row: ReshardRow };

/**
 * Decision 11 with 32, 33 and 66: the open attempt is called off for the first reason that holds, or for the asker's
 * reason while it is 'standby' (a refused fork, the second standby end, the login budget). `attempt` names the
 * attempt the asker read; another attempt in the row is left as it is.
 */
export async function callOffReshard(client: SqlClient, attempt: string, asked?: AskedCallOff): Promise<CallOffAnswer> {
  return inTransaction<CallOffAnswer>(client, async () => {
    const facts = await readFacts(client, true);
    if (facts.row.attempt !== attempt) return { commit: false, answer: { kind: 'none', row: facts.row } };
    const verdict = callOffVerdict(facts, asked);
    if (!verdict) return { commit: false, answer: { kind: 'none', row: facts.row } };
    const res = await client.query(`UPDATE smdb_data.reshard SET state = 'cancelled', ended_at = now(), reason = $2::text,
        retry_after = now() + make_interval(secs => $3::int), failures = failures + $4::int
      WHERE id = 1 AND attempt = $1::uuid AND state IN ('standby', 'stopping')
      RETURNING ${ms('retry_after')} AS retry_after`, [attempt, verdict.reason, verdict.retryNow ? 0 : 15 * 60, verdict.failures]);
    return {
      commit: true,
      answer: {
        kind: 'called-off', attempt, fromCount: facts.row.fromCount!, toCount: facts.row.toCount!, reason: verdict.reason,
        retryAfterMs: Number(res.rows[0]?.retry_after ?? facts.nowMs),
        retryNow: verdict.retryNow,
      },
    };
  });
}
