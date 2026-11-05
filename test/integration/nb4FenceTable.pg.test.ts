import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { fenceAdmits, type ClaimRow } from '../../src/bot/internalSetup/fleet/claimRules';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';

// NB4 decisions 8 and 9: a stamp lands exactly when the guild row is at or below the token's claim (or absent) and the
// shard's claim row holds that claim for this process, unreleased; expired rows included. A refusal names both rows.

let rig: ClaimRig;
beforeAll(async () => { rig = await startClaimRig(); }, 180_000);
afterAll(async () => { await rig?.stop(); });
beforeEach(async () => { await rig.reset(); });

type ShardRow = { claim: number; released: boolean; reserved: boolean; process: 'mine' | 'other' } | null;
const guildClaims = [null, 5, 9] as const;
const shardClaims = [7, 8, null] as const;
const tokenClaims = [7, 8] as const;
const processes = ['mine', 'other'] as const;
const releases = [[false, false], [true, false], [true, true]] as const;

const cases: Array<[number | null, ShardRow, number]> = [];
for (const g of guildClaims) for (const s of shardClaims) for (const t of tokenClaims) {
  if (s === null) { cases.push([g, null, t]); continue; }
  for (const p of processes) for (const [released, reserved] of releases) cases.push([g, { claim: s, released, reserved, process: p }, t]);
}

let guild = 900_000;
async function seed(g: number | null, row: ShardRow): Promise<string> {
  const guildId = String(++guild);
  if (g !== null) await rig.direct.query(`INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count) VALUES ($1, 'n-old', 0, $2, 1)`, [guildId, g]);
  if (row) {
    await rig.direct.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, released, reserved, ttl_ms, expires_up_ms)
      VALUES (1, 0, $1, $2, 'n-x', 'X', 'n-x', $3, $4, 30000, 0)`, [row.claim, row.process === 'mine' ? 'p-me' : 'p-other', row.released, row.reserved]);
  }
  return guildId;
}

const tokenOf = (claim: number): FenceToken => ({ nodeId: 'n-me', claim, processId: 'p-me', shardId: 0, shardCount: 1 });
const lands = (g: number | null, row: ShardRow, t: number) =>
  (g === null || g <= t) && row !== null && row.claim === t && row.process === 'mine' && !row.released;
/** The pure rule MemClaimStore and the property model run, over the same seeded rows; the table above is a second check. */
const admits = (g: number | null, row: ShardRow, t: number): boolean => {
  const claimRow: ClaimRow | undefined = row ? {
    shardCount: 1, shardId: 0, claim: row.claim, holderProcess: row.process === 'mine' ? 'p-me' : 'p-other', holderNode: 'n-x', holderName: 'X',
    homeNode: 'n-x', released: row.released, reserved: row.reserved, takenAt: 0, renewedAt: 0, ttlMs: 30000, expiresUpMs: 0, extended: false,
  } : undefined;
  const answer = fenceAdmits(claimRow, { shardCount: 1, shardId: 0, claim: t, processId: 'p-me' }, g ?? undefined);
  expect(answer).toBe(lands(g, row, t));
  return answer;
};
const batch = { upserts: [{ key: { module: 'm', filename: 'x.json' }, doc: '{"cell":1}' }], deletes: [], appends: [] };

/** The guild's stored bytes: its documents and its ownership row. */
async function stored(guildId: string) {
  const docs = (await rig.direct.query(`SELECT module, filename, doc FROM smdb_data.guild_data WHERE guild_id = $1`, [guildId])).rows;
  const own = (await rig.direct.query(`SELECT node_id, shard_id, claim::text AS claim, shard_count, retired_at FROM smdb_data.guild_ownership WHERE guild_id = $1`, [guildId])).rows;
  return { docs, own };
}

describe('the save fence over every combination (shard rows expired on the clock)', () => {
  it.each(cases)('guild %s, shard row %j, token %s', async (g, row, t) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const guildId = await seed(g, row);
    const seeded = await stored(guildId);
    const outcome = await rig.backend.flushGuild(guildId, batch, tokenOf(t));
    if (admits(g, row, t)) {
      expect(outcome).toEqual({ ok: true });
      const after = await stored(guildId);
      expect(after.docs).toEqual([{ module: 'm', filename: 'x.json', doc: '{"cell":1}' }]);
      expect(after.own).toEqual([expect.objectContaining({ node_id: 'n-me', claim: String(t), shard_id: 0, shard_count: 1, retired_at: null })]);
      return;
    }
    expect(outcome).toMatchObject({ ok: false, reason: 'deposed' });
    expect(await stored(guildId)).toEqual(seeded);
    const line = errors.mock.calls.map(c => String(c[0])).find(l => l.startsWith('[PostgresBackend] Flush rejected'))!;
    const guildPart = g === null ? `guild ${guildId} has no ownership row` : `guild ${guildId} is held by claim ${g} (n-old)`;
    const shardPart = row === null ? 'shard 0 of 1 has no claim row'
      : !row.released ? `shard 0 of 1 is held by claim ${row.claim} (X)`
        : row.reserved ? `shard 0 of 1 is reserved by claim ${row.claim} (X) for its restart`
          : `shard 0 of 1 was released by claim ${row.claim} (kept for X)`;
    expect(line).toBe(`[PostgresBackend] Flush rejected: deposed: ${guildPart}; ${shardPart}; local claim ${t}`);
    errors.mockRestore();
  });

  it.each(cases)('reclaim: guild %s, shard row %j, token %s', async (g, row, t) => {
    const guildId = await seed(g, row);
    if (g !== null) await rig.direct.query(`UPDATE smdb_data.guild_ownership SET node_id = 'n-me' WHERE guild_id = $1`, [guildId]);
    const seeded = await stored(guildId);
    const kept = admits(g, row, t);
    expect(await rig.backend.reclaimGuild(guildId, tokenOf(t))).toBe(kept ? 'kept' : 'lost');
    const after = await stored(guildId);
    expect(after.docs).toEqual([]);
    if (kept) expect(after.own).toEqual([expect.objectContaining({ node_id: 'n-me', claim: String(t), retired_at: null })]);
    else expect(after.own).toEqual(seeded.own);
  });
});
