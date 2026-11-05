import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Client always gets the claimed plan; an invalid SHARD_COUNT makes discord.js throw first. The
// maintenance cases mark this process as booted in maintenance, so they run after the ingest cases.

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<object>()),
  stopProcess: () => undefined,
}));

import { setBackendKind } from '../helpers/backendKind';
import { IngestService } from '../../src/bot/internalSetup/ingest/ingestService';
import {
  _resetMaintenance,
  _setMaintenanceSender,
  _setMaintenanceTiming,
  runMaintenanceBoot,
} from '../../src/bot/internalSetup/utils/maintenance';

const envCases = [
  ['SHARDS', '[2]'],
  ['SHARD_COUNT', '4'],
] as const;

const saved: Record<string, string | undefined> = {};
const realSend = process.send;
beforeEach(() => {
  for (const [name] of envCases) saved[name] = process.env[name];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const [name] of envCases) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  (process as { send?: unknown }).send = realSend;
  vi.restoreAllMocks();
});

describe('buildClient with a plan of shard 0 of 1', () => {
  it.each(envCases)('replaces %s=%s with the plan', async (name, value) => {
    process.env[name] = value;
    const svc = new IngestService();
    svc.setShardPlan([0], 1);
    const client = svc.buildClient({ intents: [] });
    expect(client.options.shards).toEqual([0]);
    expect(client.options.shardCount).toBe(1);
    await client.destroy();
  });

  it('throws for SHARD_COUNT=0 before any connection', () => {
    process.env.SHARD_COUNT = '0';
    const svc = new IngestService();
    svc.setShardPlan([0], 1);
    expect(() => svc.buildClient({ intents: [] })).toThrow();
  });

  it('writes no shard options for an empty plan', async () => {
    const svc = new IngestService();
    svc.setShardPlan([], 1);
    const client = svc.buildClient({ intents: [] });
    expect(client.options.shards).not.toEqual([]);
    await client.destroy();
  });
});

describe('the Postgres maintenance boot with a record of shard 0 of 1', () => {
  afterEach(() => {
    _resetMaintenance();
    _setMaintenanceSender(null);
  });

  const boot = async (shardIds: number[]) => {
    (process as { send?: unknown }).send = undefined;
    setBackendKind('postgres');
    _setMaintenanceSender(() => undefined);
    _setMaintenanceTiming({ filePollMs: 600_000 });
    let loggedIn: unknown = null;
    const client = await runMaintenanceBoot({ cause: 'hook', message: 'm' }, {
      shardRecord: () => ({ shardCount: 1, shardIds, processId: 'p', at: '' }),
      login: async c => { loggedIn = c; },
      retryMs: 600_000,
    });
    expect(loggedIn).toBe(client);
    return client!;
  };

  it.each(envCases)('replaces %s=%s with the plan', async (name, value) => {
    process.env[name] = value;
    const client = await boot([0]);
    expect(client.options.shards).toEqual([0]);
    expect(client.options.shardCount).toBe(1);
    await client.destroy();
  });

  it('connects each shard of a record once', async () => {
    const client = await boot([0, 0]);
    expect(client.options.shards).toEqual([0]);
    expect(client.options.shardCount).toBe(1);
    await client.destroy();
  });
});
