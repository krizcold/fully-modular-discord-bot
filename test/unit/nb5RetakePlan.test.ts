import { describe, expect, it } from 'vitest';
import { planRetake, type ClaimRow, type RetakeInput } from '../../src/bot/internalSetup/fleet/claimRules';

// NB5 decision 12 (d) as D2 amends it: each refusal of the move's re-take, over planRetake alone.

const me = { processId: 'p-a', nodeId: 'node-a', nodeName: 'NODE-A' };
const pair = { shardCount: 2, shardId: 1, claim: 40 };
const G = '880000000000000901';

const row = (over: Partial<ClaimRow> = {}): ClaimRow => ({
  shardCount: 2, shardId: 1, claim: 40, holderProcess: 'p-a', holderNode: 'node-a', holderName: 'NODE-A', homeNode: 'node-a',
  released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: 30_000, extended: false, ...over,
});

const input = (over: Partial<RetakeInput> = {}): RetakeInput => ({
  me, pairs: [pair], guildIds: [{ shardId: 1, guildIds: [G] }], generation: 2, generations: [2],
  rows: [], counts: [2], guildClaims: [{ guildId: G, shardCount: 2, shardId: 1, claim: 40 }], ...over,
});

describe('planRetake', () => {
  it('takes a pair whose row is missing or names this process, with guild rows at the held claim', () => {
    expect(planRetake(input())).toEqual([{ pair, row: null }]);
    const own = row({ claim: 61 });
    expect(planRetake(input({ rows: [own] }))).toEqual([{ pair, row: own }]);
  });

  it('refuses when a guild row of the shard carries a claim above the held one', () => {
    expect(planRetake(input({ guildClaims: [{ guildId: '880000000000000902', shardCount: 2, shardId: 1, claim: 41 }] }))).toEqual([]);
  });

  it('refuses when a guild this process holds in the shard carries a claim above the held one under another shard', () => {
    expect(planRetake(input({ guildClaims: [{ guildId: G, shardCount: 4, shardId: 3, claim: 57 }] }))).toEqual([]);
  });

  it('takes the pair when the only guild row above the held claim is of another shard and another guild', () => {
    expect(planRetake(input({ guildClaims: [{ guildId: '880000000000000903', shardCount: 2, shardId: 0, claim: 57 }] }))).toHaveLength(1);
  });

  it('refuses when any claim row carries another count', () => {
    expect(planRetake(input({ counts: [2, 4] }))).toEqual([]);
    expect(planRetake(input({ counts: [4], rows: [row({ shardCount: 4 })] }))).toEqual([]);
  });

  it("refuses when the shard's row names another process, below the held claim too", () => {
    expect(planRetake(input({ rows: [row({ holderProcess: 'p-y', claim: 57 })] }))).toEqual([]);
    expect(planRetake(input({ rows: [row({ holderProcess: 'p-y', claim: 12 })] }))).toEqual([]);
  });

  it.each([
    ['no generation row', [] as number[]],
    ['a row below the target', [1]],
    ['a row above the target', [3]],
    ['two rows', [2, 2]],
  ])("refuses when the generation table holds %s instead of the target's", (_name, generations) => {
    expect(planRetake(input({ generations }))).toEqual([]);
  });

  it('at generation 0 takes only when the target has no generation row', () => {
    expect(planRetake(input({ generation: 0, generations: [] }))).toHaveLength(1);
    expect(planRetake(input({ generation: 0, generations: [1] }))).toEqual([]);
  });
});
