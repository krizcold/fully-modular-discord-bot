import { afterEach, describe, expect, it, vi } from 'vitest';

import { IngestService } from '../../src/bot/internalSetup/ingest/ingestService';

// NB4: the one Client of a process logs in with exactly its lease's shards, and REST keeps the operator's token.

const clients: Array<{ destroy(): unknown }> = [];
const envKeys = ['DISCORD_TOKEN', 'SHARDS', 'SHARD_COUNT'] as const;
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));

afterEach(async () => {
  for (const client of clients.splice(0)) await client.destroy();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

// The REST class discord.js loads (its CommonJS copy), read from a built Client.
function restPrototype(): { setToken(token: string | null): unknown } {
  const probe = new IngestService().buildClient({ intents: [] });
  clients.push(probe);
  return Object.getPrototypeOf(probe.rest);
}

function build(svc: IngestService) {
  const client = svc.buildClient({ intents: [] });
  clients.push(client);
  return client;
}

describe('the Client is built once per process', () => {
  it('a second build is refused with its reason and the first Client stays', () => {
    const svc = new IngestService();
    svc.setShardPlan([0], 1);
    const first = build(svc);
    expect(() => build(svc)).toThrow('[Ingest] buildClient() called twice');
    expect(svc.getClient()).toBe(first);
  });
});

describe('the REST token', () => {
  it('is the operator token without surrounding whitespace', () => {
    process.env.DISCORD_TOKEN = '  tok.en  ';
    const setToken = vi.spyOn(restPrototype(), 'setToken');
    build(new IngestService());
    expect(setToken).toHaveBeenCalledTimes(1);
    expect(setToken).toHaveBeenLastCalledWith('tok.en');
  });

  it('is never set when no token is configured', () => {
    delete process.env.DISCORD_TOKEN;
    const setToken = vi.spyOn(restPrototype(), 'setToken');
    build(new IngestService());
    expect(setToken).not.toHaveBeenCalled();
  });
});

describe('a sharding env left in the process environment', () => {
  it('an unreadable SHARDS never stops the lease from building its Client', () => {
    process.env.SHARDS = '{not json';
    const svc = new IngestService();
    svc.setShardPlan([0], 1);
    const options = build(svc).options as { shards?: unknown; shardCount?: unknown };
    expect(options.shards).toEqual([0]);
    expect(options.shardCount).toBe(1);
  });

  it('an invalid SHARD_COUNT never stops a lease of 2 from building its Client', () => {
    process.env.SHARD_COUNT = 'many';
    const svc = new IngestService();
    svc.setShardPlan([1, 0], 2);
    const options = build(svc).options as { shards?: unknown; shardCount?: unknown };
    expect(options.shards).toEqual([0, 1]);
    expect(options.shardCount).toBe(2);
  });
});
