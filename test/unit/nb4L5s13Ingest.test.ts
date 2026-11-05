import { afterEach, describe, expect, it } from 'vitest';

import { IngestService } from '../../src/bot/internalSetup/ingest/ingestService';

// NB4: the gateway Client logs in with exactly the shards and count of this process's lease, shard 0 of 1 included.

const clients: Array<{ destroy(): unknown }> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.destroy();
});

function built(shards: number[] | null, shardCount = 1) {
  const svc = new IngestService();
  if (shards) svc.setShardPlan(shards, shardCount);
  const client = svc.buildClient({ intents: [] });
  clients.push(client);
  return { svc, options: client.options as { shards?: unknown; shardCount?: unknown } };
}

describe('the lease reaches the Client built after it', () => {
  it.each([
    [[0, 1], 2, [0, 1], 2],
    [[0], 2, [0], 2],
    [[1], 1, [1], 1],
    [[0, 1], 1, [0, 1], 1],
    [[3, 1], 4, [1, 3], 4],
  ])('lease %j of %i logs in shards %j of %i', (shards, shardCount, want, wantCount) => {
    const { options } = built(shards, shardCount);
    expect(options.shards).toEqual(want);
    expect(options.shardCount).toBe(wantCount);
  });

  it('lease [0] of 1 reaches the Client as shard 0 of 1', () => {
    const { options } = built([0], 1);
    expect(options.shards).toEqual([0]);
    expect(options.shardCount).toBe(1);
  });
});

describe('a lease changed after the Client was built', () => {
  it('moves the Client to the new shards', () => {
    const { svc, options } = built([0, 1], 2);
    svc.setShardPlan([3, 2], 4);
    expect(options.shards).toEqual([2, 3]);
    expect(options.shardCount).toBe(4);
  });

  it('an empty lease leaves the Client on its shards (discord.js refuses shards: [])', () => {
    const { svc, options } = built([0, 1], 2);
    svc.setShardPlan([], 3);
    expect(options.shards).toEqual([0, 1]);
    expect(options.shardCount).toBe(2);
    expect(svc.getShardPlan()).toEqual({ shards: [], shardCount: 3 });
  });
});
