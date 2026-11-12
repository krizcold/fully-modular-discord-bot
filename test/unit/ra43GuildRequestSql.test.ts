import { describe, expect, it } from 'vitest';

import {
  ANSWER_READ_BACK_SQL,
  ANSWER_SQL,
  HOLDER_CHECK_SQL,
  HOLDER_MAP_SQL,
  POLL_SET_SQL,
  READ_ANSWERS_READ_BACK_SQL,
  READ_ANSWERS_SQL,
  REPLY_READ_SQL,
  REQUEST_CLAIM_SQL,
  SETTLE_INSERT_SQL,
  SETTLE_UPDATE_SQL,
  answerSpanS,
  failureOf,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

describe('ra43 answer spans of the data ops', () => {
  it('gives restore-graveyard and delete-namespace 50 s and the other data ops 20 s', () => {
    expect(answerSpanS('restore-graveyard')).toBe(50);
    expect(answerSpanS('delete-namespace')).toBe(50);
    expect(answerSpanS('write')).toBe(20);
    expect(answerSpanS('delete')).toBe(20);
  });
});

describe('ra43 statements of smdb_data.guild_requests', () => {
  it('maps every shard of the stored count to its claim row, in shard order', () => {
    const sql = flat(HOLDER_MAP_SQL);
    expect(sql).toContain("FROM smdb_data.meta WHERE key = 'shard_count'");
    expect(sql).toContain('generate_series(0, m.n - 1)');
    expect(sql).toContain('LEFT JOIN smdb_data.shard_claims c ON c.shard_count = s.n AND c.shard_id = s.shard');
    expect(sql).toMatch(/ORDER BY s\.shard$/);
  });

  it('finds the guild shard by the Discord formula over the stored count', () => {
    const sql = flat(HOLDER_CHECK_SQL);
    expect(sql).toContain('(($1::bigint >> 22) % n)::int AS shard');
    expect(sql).toContain('LEFT JOIN smdb_data.shard_claims c ON c.shard_count = s.n AND c.shard_id = s.shard');
    expect(sql).toContain('LEFT JOIN smdb_data.shard_nodes d ON d.node_id = c.holder_node');
  });

  it('polls only the states of the ids of the poll set', () => {
    const sql = flat(POLL_SET_SQL);
    expect(sql).toMatch(/^SELECT id, state, now\(\) >= claim_by AS pickup_over/);
    expect(sql).toContain("now() >= answer_by + interval '5 seconds' AS answer_over");
    expect(sql).toContain('FROM smdb_data.guild_requests WHERE id = ANY($1::uuid[])');
    expect(sql).not.toContain('reply');
  });

  it('reads a reply only from a done row', () => {
    expect(flat(REPLY_READ_SQL)).toBe("SELECT reply FROM smdb_data.guild_requests WHERE id = $1 AND state = 'done'");
  });

  it('settles an unacknowledged insert by an expired row that only overwrites a pending one', () => {
    const sql = flat(SETTLE_INSERT_SQL);
    expect(sql).toMatch(/^INSERT INTO smdb_data\.guild_requests AS r/);
    expect(sql).toContain("VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now(), 'expired', now())");
    expect(sql).toContain("ON CONFLICT (id) DO UPDATE SET state = 'expired', done_at = now() WHERE r.state = 'pending'");
    expect(sql).toMatch(/RETURNING r\.state, now\(\) >= r\.claim_by AS pickup_over$/);
  });

  it('settles an acknowledged insert by expiring the row only while it is pending', () => {
    expect(flat(SETTLE_UPDATE_SQL)).toBe(
      "UPDATE smdb_data.guild_requests SET state = 'expired', done_at = now() WHERE id = $1 AND state = 'pending' RETURNING state, now() >= claim_by AS pickup_over",
    );
  });

  it('claims only pending rows of this process on a held, unreleased claim before claim_by', () => {
    const sql = flat(REQUEST_CLAIM_SQL);
    const pick =
      "SELECT r.id, r.body, p.claim FROM smdb_data.guild_requests r JOIN pairs p ON p.shard_count = r.shard_count AND p.shard_id = r.shard_id JOIN smdb_data.shard_claims c ON c.shard_count = p.shard_count AND c.shard_id = p.shard_id AND c.claim = p.claim AND c.holder_process = $1 AND NOT c.released WHERE r.state = 'pending' AND r.for_process = $1 AND r.claim_by > now()";
    expect(sql).toContain(`dat AS ( ${pick} AND r.op = ANY($6::text[])`);
    expect(sql).toContain(`act AS ( ${pick} AND r.op = ANY($8::text[])`);
    expect(sql).toContain(`rd AS ( ${pick} AND r.op = ANY($10::text[])`);
  });

  it('answers the reads of a pass only on rows of its batch still applying', () => {
    expect(flat(READ_ANSWERS_SQL)).toBe(
      "UPDATE smdb_data.guild_requests r SET state = 'done', reply = a.reply, done_at = now() FROM unnest($1::uuid[], $2::text[]) AS a(id, reply) WHERE r.id = a.id AND r.claim_batch = $3 AND r.state = 'applying'",
    );
  });

  it('reads back id, state and reply of the answered reads', () => {
    expect(flat(READ_ANSWERS_READ_BACK_SQL)).toBe(
      'SELECT id, state, reply FROM smdb_data.guild_requests WHERE id = ANY($1::uuid[])',
    );
  });

  it('answers one row only when its batch matches and it is still applying', () => {
    expect(flat(ANSWER_SQL)).toBe(
      "UPDATE smdb_data.guild_requests SET state = 'done', reply = $3, done_at = now() WHERE id = $1 AND claim_batch = $2 AND state = 'applying'",
    );
  });

  it('reads back the state and reply of one answered row', () => {
    expect(flat(ANSWER_READ_BACK_SQL)).toBe('SELECT state, reply FROM smdb_data.guild_requests WHERE id = $1');
  });
});

describe('ra43 failureOf', () => {
  it('calls a thrown null or undefined an unknown outcome', () => {
    expect(failureOf(null)).toEqual({ kind: 'unknown', cause: 'null' });
    expect(failureOf(undefined)).toEqual({ kind: 'unknown', cause: 'undefined' });
  });

  it('calls a code with a sixth character an unknown outcome, at either end', () => {
    const lead = Object.assign(new Error('lead'), { code: 'x23505' });
    const tail = Object.assign(new Error('tail'), { code: '235050' });
    expect(failureOf(lead)).toEqual({ kind: 'unknown', cause: 'lead' });
    expect(failureOf(tail)).toEqual({ kind: 'unknown', cause: 'tail' });
  });

  it('calls a five-character SQLSTATE a refusal and 57P01 an unknown outcome', () => {
    const dup = Object.assign(new Error('dup'), { code: '23505' });
    const shut = Object.assign(new Error('shut'), { code: '57P01' });
    expect(failureOf(dup)).toEqual({ kind: 'refused', code: '23505', message: 'dup' });
    expect(failureOf(shut)).toEqual({ kind: 'unknown', cause: 'shut' });
  });
});
