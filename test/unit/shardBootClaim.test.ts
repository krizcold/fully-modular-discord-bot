import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  snapshots: [] as any[],
  owner: null as null | (() => any),
  maxClaim: null as number | null,
  seq: 0,
  failQuery: false,
  state: 'serving' as string,
  queries: [] as string[],
  connects: 0,
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
  return { ...real, getGuildDataBackend: () => h.backend, setOwnerInfoProvider: (fn: () => any) => { h.owner = fn; } };
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
import { bootShards, resolveBootClaim } from '../../src/bot/internalSetup/fleet/shardBoot';
import { getFleetState } from '../../src/bot/internalSetup/fleet/state';

// NB1 (wip-redesign/sheets/NB1.md, item 2): one claim number per boot, from smdb_data.claim_seq under an advisory
// lock, never at or below a claim a guild_ownership row holds; none on a JSON bot or a refused data layer.

const client = {
  query: async (sql: string, params?: unknown[]) => {
    h.queries.push(sql);
    if (h.failQuery) throw new Error('connection refused');
    if (/nextval\('smdb_data\.claim_seq'\)/.test(sql)) {
      h.seq += 1;
      return { rows: [{ claim: String(h.seq) }] };
    }
    if (/max\(claim\)/.test(sql)) return { rows: [{ claim: h.maxClaim === null ? null : String(h.maxClaim) }] };
    if (/setval\('smdb_data\.claim_seq'/.test(sql)) {
      h.seq = Number(params?.[0]);
      return { rows: [{ setval: String(h.seq) }] };
    }
    return { rows: [] };
  },
  release: () => {},
};
const fakePool = {
  connect: async () => { h.connects++; return client; },
  query: client.query,
};

function postgresBackend(over: { provisioned?: boolean; schemaMismatch?: boolean } = {}) {
  const backend = Object.create(PostgresBackend.prototype);
  backend.pool = fakePool;
  backend.getPool = () => fakePool;
  backend.provisioned = over.provisioned ?? true;
  backend.schemaMismatch = over.schemaMismatch ?? false;
  backend.stopped = false;
  backend.pendingSleeps = new Set();
  return backend;
}

beforeEach(() => {
  h.state = 'serving';
  h.queries = [];
  h.connects = 0;
  h.failQuery = false;
  h.maxClaim = null;
  h.seq = 0;
  h.backend = postgresBackend();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('resolveBootClaim', () => {
  it('answers null on a JSON bot, with no query', async () => {
    h.backend = null;
    expect(await resolveBootClaim()).toBeNull();
    expect(h.connects).toBe(0);
  });

  it('answers null at once when the data layer refused, with no query', async () => {
    h.state = 'refused';
    h.maxClaim = 50;
    expect(await resolveBootClaim()).toBeNull();
    expect(h.connects).toBe(0);
  });

  it('waits while the data layer starts, logs the wait every 30 s, and takes a claim once it serves', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    h.state = 'starting';
    let claim: number | null | undefined;
    const pending = resolveBootClaim().then(c => { claim = c; });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(claim).toBeUndefined();
    expect(h.connects).toBe(0);
    expect(log.mock.calls.filter(c => String(c[0]).includes('state: starting')).length).toBe(3);
    h.state = 'serving';
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(claim).toBe(1);
  });

  it('waits while the backend is not provisioned, then takes a claim', async () => {
    vi.useFakeTimers();
    h.backend = postgresBackend({ provisioned: false });
    let claim: number | null | undefined;
    const pending = resolveBootClaim().then(c => { claim = c; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(claim).toBeUndefined();
    expect(h.connects).toBe(0);
    h.backend.provisioned = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(claim).toBe(1);
  });

  it('answers null and logs it when the database\'s schema version is not this bot\'s', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.backend = postgresBackend({ provisioned: false, schemaMismatch: true });
    expect(await resolveBootClaim()).toBeNull();
    expect(h.connects).toBe(0);
    expect(error.mock.calls.filter(c => String(c[0]).startsWith('[Shards]'))).toHaveLength(1);
    expect(String(error.mock.calls[0][0])).toContain('another schema version');
  });

  it.each([true, false])('answers null for a stopped backend (provisioned: %s), with no query and no schema version text', async provisioned => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    h.backend = postgresBackend({ provisioned });
    h.backend.stopped = true;
    expect(await resolveBootClaim()).toBeNull();
    expect(h.connects).toBe(0);
    const lines = [...error.mock.calls, ...log.mock.calls].map(c => String(c[0]));
    expect(lines.some(l => l.includes('schema version'))).toBe(false);
    expect(lines.filter(l => l.startsWith('[Shards]'))).toEqual(['[Shards] No shard claim taken: the data backend stopped']);
  });

  it('ends the retry loop once the backend stops', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    h.failQuery = true;
    let claim: number | null | undefined;
    const pending = resolveBootClaim().then(c => { claim = c; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.connects).toBe(1);
    h.backend.stopped = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(claim).toBeNull();
    expect(h.connects).toBe(1);
  });

  it('takes no claim while the query fails, and tries again every 5 s', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.failQuery = true;
    let claim: number | null | undefined;
    const pending = resolveBootClaim().then(c => { claim = c; });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(claim).toBeUndefined();
    expect(h.connects).toBe(3);
    h.failQuery = false;
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(claim).toBe(1);
  });

  it('takes the claim under the advisory lock, in one transaction', async () => {
    await resolveBootClaim();
    expect(h.queries[0]).toBe('BEGIN');
    expect(h.queries[1]).toContain("pg_advisory_xact_lock(hashtext('smdb_data_claim'))");
    expect(h.queries.at(-1)).toBe('COMMIT');
  });

  it('claims above every stored claim when the sequence is behind: 50 stored, the sequence at 3, gives 51', async () => {
    h.maxClaim = 50;
    h.seq = 2;
    expect(await resolveBootClaim()).toBe(51);
    expect(h.seq).toBe(51);
    h.maxClaim = 51;
    expect(await resolveBootClaim()).toBe(52);
  });

  it('takes the sequence\'s number when it is above every stored claim', async () => {
    h.maxClaim = 4;
    h.seq = 9;
    expect(await resolveBootClaim()).toBe(10);
    expect(h.queries.some(q => q.includes('setval'))).toBe(false);
  });
});

describe('bootShards', () => {
  it('hands the same claim to the data layer, the owner info and the fleet state, with no term or epoch', async () => {
    h.maxClaim = 70;
    await bootShards();
    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0]).toEqual({ nodeId: 'node-new', claim: 71, shardCount: 2, shardIds: [0, 1] });
    const owner = h.owner?.();
    expect(owner).toEqual({ nodeId: 'node-new', claim: 71, shardCount: 2 });
    for (const view of [h.snapshots[0], owner]) {
      expect(view).not.toHaveProperty('term');
      expect(view).not.toHaveProperty('epoch');
    }
    expect(getFleetState().claim).toBe(71);
  });
});
