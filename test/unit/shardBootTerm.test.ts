import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  snapshots: [] as any[],
  rows: [] as { nodeId: string; term: number }[],
  failRead: false,
  state: 'serving' as string,
  reads: 0,
  backend: null as any,
}));

vi.mock('../../src/bot/internalSetup/fleet/placement', async importOriginal => {
  const real: any = await importOriginal();
  return {
    ...real,
    fetchGatewayInfoResult: vi.fn(async () => ({ info: { recommendedShards: 2, sessionStartLimit: null }, error: null })),
  };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, getDataReadiness: () => ({ onLeaseChanged: (s: any) => h.snapshots.push(s) }) };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, cleanOrphanTmpFiles: vi.fn(async () => {}) };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, getDataBootStatus: () => ({ mode: 'postgres', state: h.state, banner: null, refusalReason: null }) };
});

vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, getGuildDataBackend: () => h.backend };
});

vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, getNodeId: () => 'node-new', getNodeName: () => 'Node New', getAppVersion: () => '1.0.0' };
});

vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => {
  const fake = { setShardPlan: () => {}, isStarted: () => false, start: vi.fn(async () => 'ok'), stop: vi.fn(async () => {}), getClient: () => null };
  return { getIngestService: () => fake };
});

import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { bootShards, resolveBootTerm, SHARD_BOOT_TERM } from '../../src/bot/internalSetup/fleet/shardBoot';

const fakePool = {
  query: async (sql: string) => {
    h.reads++;
    if (h.failRead) throw new Error('connection refused');
    expect(sql).toContain('max(term)');
    const max = h.rows.length ? String(Math.max(...h.rows.map(r => r.term))) : null;
    return { rows: [{ term: max }] };
  },
};
h.backend = Object.create(PostgresBackend.prototype);
h.backend.getPool = () => fakePool;

beforeEach(() => { h.state = 'serving'; h.reads = 0; h.failRead = false; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('shardBoot claims a term above every stored ownership row on Postgres', () => {
  it('does not grant while the stored term cannot be read, then grants above rows another node holds at the base term', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.rows = [{ nodeId: 'node-lost', term: SHARD_BOOT_TERM }];
    h.failRead = true;
    const boot = bootShards();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.snapshots).toHaveLength(0);
    h.failRead = false;
    await vi.advanceTimersByTimeAsync(10_000);
    await boot;
    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0].term).toBeGreaterThan(SHARD_BOOT_TERM);
  });

  it('gives a second boot of the same node a higher term than the first', async () => {
    h.rows = [{ nodeId: 'node-new', term: SHARD_BOOT_TERM }];
    const first = await resolveBootTerm();
    h.rows = [{ nodeId: 'node-new', term: first }];
    const second = await resolveBootTerm();
    expect(second).toBeGreaterThan(first);
  });

  it('starts at the base term on an empty table', async () => {
    h.rows = [];
    expect(await resolveBootTerm()).toBe(SHARD_BOOT_TERM);
  });

  it('returns the base term at once when the data layer refused, without reading the table', async () => {
    vi.useFakeTimers();
    h.state = 'refused';
    h.rows = [{ nodeId: 'node-lost', term: SHARD_BOOT_TERM + 5 }];
    expect(await resolveBootTerm()).toBe(SHARD_BOOT_TERM);
    expect(h.reads).toBe(0);
  });

  it('waits while starting, logs the wait every 30 s, and grants only after serving and the read', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    h.state = 'starting';
    h.rows = [{ nodeId: 'node-lost', term: SHARD_BOOT_TERM + 7 }];
    let term: number | null = null;
    const pending = resolveBootTerm().then(t => { term = t; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(term).toBeNull();
    expect(h.reads).toBe(0);
    expect(log.mock.calls.filter(c => String(c[0]).includes('state: starting')).length).toBeGreaterThan(1);
    h.state = 'serving';
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(h.reads).toBe(1);
    expect(term).toBe(SHARD_BOOT_TERM + 8);
  });
});
