import { describe, expect, it } from 'vitest';
import { planRetake, type ClaimRow, type RetakeInput } from '../../src/bot/internalSetup/fleet/claimRules';

// planRetake's per-pair rules: the shard's row is the one of the pair's count and id, the guilds held in a shard are
// that shard's set, and a guild row of the shard is one of the pair's count.

const me = { processId: 'p-a', nodeId: 'node-a', nodeName: 'NODE-A' };
const G0 = '880000000000000100';
const G1 = '880000000000000101';

const row = (over: Partial<ClaimRow> = {}): ClaimRow => ({
  shardCount: 2, shardId: 1, claim: 40, holderProcess: 'p-a', holderNode: 'node-a', holderName: 'NODE-A', homeNode: 'node-a',
  released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: 30_000, extended: false, ...over,
});

const input = (over: Partial<RetakeInput> = {}): RetakeInput => ({
  me, pairs: [{ shardCount: 2, shardId: 1, claim: 40 }], guildIds: [], generation: 2, generations: [2],
  rows: [], counts: [2], guildClaims: [], ...over,
});

describe('planRetake per pair', () => {
  it("a row of another count under the pair's shard id is not the pair's row", () => {
    const other = row({ shardCount: 4, holderProcess: 'p-b', holderNode: 'node-b', holderName: 'NODE-B' });
    expect(planRetake(input({ rows: [other] }))).toEqual([{ pair: { shardCount: 2, shardId: 1, claim: 40 }, row: null }]);
  });

  it("a later claim on a guild held in another shard does not block this shard's pair", () => {
    const pairs = [{ shardCount: 2, shardId: 0, claim: 30 }, { shardCount: 2, shardId: 1, claim: 40 }];
    const guildIds = [{ shardId: 0, guildIds: [G0] }, { shardId: 1, guildIds: [G1] }];
    const later = [{ guildId: G1, shardCount: 4, shardId: 3, claim: 50 }];
    expect(planRetake(input({ pairs, guildIds, guildClaims: later }))).toEqual([{ pair: pairs[0], row: null }]);
  });

  it('a pair with no guild set is blocked by no guild row of another shard', () => {
    const later = [{ guildId: 'Stryker was here', shardCount: 4, shardId: 3, claim: 50 }, { guildId: G0, shardCount: 4, shardId: 3, claim: 50 }];
    expect(planRetake(input({ guildClaims: later }))).toHaveLength(1);
  });

  it("a later guild row under the pair's shard id but another count does not block the pair", () => {
    const later = [{ guildId: G1, shardCount: 4, shardId: 1, claim: 50 }];
    expect(planRetake(input({ guildIds: [{ shardId: 0, guildIds: [G0] }], guildClaims: later }))).toHaveLength(1);
  });
});
