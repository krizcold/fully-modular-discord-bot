import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { REQUEST_CLAIM_SQL, UNANSWERED_BATCHES_SQL, UNAPPLIED_REPLY } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';
import { takeShard } from '../helpers/pgClaims';

// NB7 code review round 4 (gatekeeper ruling 8) on real Postgres: the unanswered-batch statement leaves out the
// request ids its process started.

const GUILD = String(1n << 22n);
let rig: ClaimRig;

beforeAll(async () => {
  rig = await startClaimRig();
}, 180_000);

afterAll(async () => {
  await rig?.stop();
});

beforeEach(async () => {
  await rig.reset();
  await rig.direct.query(`DELETE FROM smdb_data.guild_requests`);
  await rig.direct.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('shard_count', '{"count":2}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
});

async function insertRow(): Promise<string> {
  const id = randomUUID();
  await rig.direct.query(
    `INSERT INTO smdb_data.guild_requests (id, guild_id, shard_count, shard_id, for_process, op, body, requested_by, claim_by, answer_by, created_at)
     VALUES ($1, $2, 2, 1, 'p-b', 'write', $3, 'ALPHA', now() + interval '5 seconds', now() + interval '20 seconds', now())`,
    [id, GUILD, JSON.stringify({ module: 'm', filename: 'a.json', contentJson: '{"v":1}' })]);
  return id;
}

describe('NB7-R4-DL1: the unanswered-batch statement leaves out the ids the process started', () => {
  it('a started row of the batch stays applying; the other gets the unapplied answer', async () => {
    const b = await takeShard(rig.direct, { processId: 'p-b', nodeId: 'n-b', shardId: 1, shardCount: 2 });
    const started = await insertRow();
    const other = await insertRow();
    const batch = randomUUID();
    const claimed = (await rig.direct.query(REQUEST_CLAIM_SQL, ['p-b', batch, [2], [1], [b.claim], 16])).rows.map(r => r.id).sort();
    expect(claimed).toEqual([started, other].sort());
    const changed = await rig.direct.query(UNANSWERED_BATCHES_SQL, [[batch], [started]]);
    expect(changed.rowCount).toBe(1);
    const rows = (await rig.direct.query(`SELECT id, state, reply FROM smdb_data.guild_requests WHERE id = ANY($1::uuid[])`, [[started, other]])).rows;
    expect(rows.find(r => r.id === started)).toMatchObject({ state: 'applying', reply: null });
    expect(rows.find(r => r.id === other)).toMatchObject({ state: 'done', reply: UNAPPLIED_REPLY });
  });

  it('an empty list of started ids leaves the statement answering the whole batch', async () => {
    const b = await takeShard(rig.direct, { processId: 'p-b', nodeId: 'n-b', shardId: 1, shardCount: 2 });
    const id = await insertRow();
    const batch = randomUUID();
    await rig.direct.query(REQUEST_CLAIM_SQL, ['p-b', batch, [2], [1], [b.claim], 16]);
    expect((await rig.direct.query(UNANSWERED_BATCHES_SQL, [[batch], []])).rowCount).toBe(1);
    expect((await rig.direct.query(`SELECT state, reply FROM smdb_data.guild_requests WHERE id = $1`, [id])).rows[0]).toMatchObject({ state: 'done', reply: UNAPPLIED_REPLY });
  });
});
