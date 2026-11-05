import { afterEach, describe, expect, it, vi } from 'vitest';
import { _setFleetStateSources, getFleetState } from '../../src/bot/internalSetup/fleet/state';
import type { NodeRow } from '../../src/bot/internalSetup/fleet/claimRules';
import type { PageRow, PageRead } from '../../src/bot/internalSetup/fleet/claimStore';

// The fleet page's claims and nodes tables (decision 21), read from a page this process read ageMs ago.

afterEach(() => {
  vi.useRealTimers();
});

const RENEW_MS = 5000;

function row(over: Partial<PageRow>): PageRow {
  return {
    shardCount: 4, shardId: 0, claim: 1, holderProcess: 'p-a', holderNode: 'node-a', holderName: 'A', homeNode: 'node-a',
    released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: 130_000, extended: false,
    renewedAgoMs: 0, ...over,
  };
}

function node(over: Partial<NodeRow>): NodeRow {
  return {
    nodeId: 'node-a', nodeName: 'A', processId: 'p-a', capacity: 4, takeoverSeconds: 30, fit: true, restartable: true,
    returns: true, seenAgoMs: 0, healthyForMs: 1000, ...over,
  };
}

function show(opts: {
  page: PageRead | null;
  held?: number[];
  ageMs?: number;
  processId?: string;
  claims?: boolean;
}) {
  vi.useFakeTimers({ toFake: ['performance', 'Date'] });
  vi.advanceTimersByTime(100_000);
  const now = performance.now();
  const snap = {
    processId: opts.processId ?? 'p-a',
    held: (opts.held ?? []).map(shardId => ({ shardCount: 4, shardId, claim: 1 })),
    reserved: [],
    page: opts.page,
    pageReadAt: opts.page ? now - (opts.ageMs ?? 0) : null,
    renewalError: null,
    pageReadError: null,
    pendingRestart: null,
    restartWaiting: null,
    returning: [],
    stopped: null,
    renewMs: RENEW_MS,
  };
  const claims = { snapshot: () => snap };
  _setFleetStateSources({
    nodeId: 'node-a', nodeName: 'A', appVersion: '1', shardSource: 'discord', recommendedShards: null, recommendedAt: null,
    runtime: { getCurrent: () => null, shardStatuses: () => [], getStillConnected: () => [] } as any,
    ingest: { getClient: () => null } as any,
    ledger: { getRecommendation: () => null, getBudgetInfo: () => null } as any,
    claims: opts.claims === false ? null : (claims as any),
  });
  return getFleetState();
}

function page(over: Partial<PageRead>): PageRead {
  return { shardCount: 2, upMs: 100_000, uPrimeMs: 100_000, rows: [], nodes: [node({})], ...over };
}

describe('the claims table', () => {
  it('shows exactly one row per shard of the count, never-taken rows not mine', () => {
    const state = show({ page: page({ shardCount: 3 }) });
    expect(state.claims.map(c => c.shardId)).toEqual([0, 1, 2]);
    for (const c of state.claims) expect(c).toMatchObject({ state: 'never-taken', mine: false, claim: null });
  });

  it('marks a row mine only when this process holds it', () => {
    const state = show({
      page: page({ rows: [row({ shardId: 0, holderProcess: 'p-a' }), row({ shardId: 1, holderProcess: 'p-b', holderNode: 'node-b' })] }),
    });
    expect(state.claims.map(c => c.mine)).toEqual([true, false]);
  });

  it('shows a live claim expiring in its rest from u-prime, less the read age', () => {
    const state = show({ page: page({ upMs: 100_000, uPrimeMs: 102_000, rows: [row({ expiresUpMs: 130_000 })] }), ageMs: 3000 });
    expect(state.claims[0]).toMatchObject({ state: 'held', expiresInMs: 25_000, expiredAgoMs: null });
  });

  it('shows an expired claim expired for its time at the read plus the read age', () => {
    const state = show({
      page: page({ upMs: 100_000, uPrimeMs: 101_000, rows: [row({ holderProcess: 'p-old', expiresUpMs: 90_000 })], nodes: [] }),
      ageMs: 4000,
    });
    expect(state.claims[0]).toMatchObject({ state: 'expired', expiresInMs: null, expiredAgoMs: 15_000, deferredMs: null });
  });
});

describe('the nodes table', () => {
  it('moves healthy time on by the read age', () => {
    const state = show({ page: page({ nodes: [node({ healthyForMs: 10_000 })] }), ageMs: 2000 });
    expect(state.nodes[0].healthyForMs).toBe(12_000);
  });

  it('gives a reason only for a node above its target', () => {
    const rows = [row({ shardId: 0 }), row({ shardId: 1 }), row({ shardId: 2 })];
    const nodes = [
      node({ nodeId: 'node-a', capacity: 2 }),
      node({ nodeId: 'node-b', nodeName: 'B', processId: 'p-b', capacity: 3, restartable: false }),
      node({ nodeId: 'node-c', nodeName: 'C', processId: 'p-c', capacity: 0, restartable: false }),
      node({ nodeId: 'node-d', nodeName: 'D', processId: 'p-d', capacity: 5, restartable: false }),
    ];
    const rowsB = [row({ shardId: 3, holderNode: 'node-b', holderProcess: 'p-b' }), row({ shardId: 4, holderNode: 'node-b', holderProcess: 'p-b' }), row({ shardId: 5, holderNode: 'node-b', holderProcess: 'p-b' })];
    const state = show({ page: page({ shardCount: 6, rows: [...rows, ...rowsB], nodes }) });
    const byId = new Map(state.nodes.map(n => [n.nodeId, n]));
    expect(byId.get('node-a')).toMatchObject({ held: 3, target: 2 });
    expect(byId.get('node-a')!.aboveReason).not.toBeNull();
    expect(byId.get('node-b')).toMatchObject({ held: 3, target: 3, aboveReason: null });
    expect(byId.get('node-c')).toMatchObject({ held: 0, target: 0, aboveReason: null });
    expect(byId.get('node-d')).toMatchObject({ held: 0, target: 5, aboveReason: null });
  });
});

describe('above target', () => {
  const nodes = [
    node({ nodeId: 'node-b', nodeName: 'B', processId: 'p-b', capacity: 3 }),
    node({ nodeId: 'node-a', nodeName: 'A', processId: 'p-a', capacity: 1 }),
  ];

  it('lists the held shards past this machine target, highest ids first to go', () => {
    const state = show({ page: page({ shardCount: 4, nodes }), held: [3, 1, 2] });
    expect(state.aboveTarget).toEqual([2, 3]);
  });

  it('is empty when no node row has this process', () => {
    const state = show({ page: page({ shardCount: 4, nodes }), held: [3, 1, 2], processId: 'p-z' });
    expect(state.aboveTarget).toEqual([]);
  });
});

describe('stale claims', () => {
  it('a read exactly 2R old is not stale, one past it is', () => {
    expect(show({ page: page({}), ageMs: 2 * RENEW_MS }).claimsStale).toBe(false);
    expect(show({ page: page({}), ageMs: 2 * RENEW_MS + 1 }).claimsStale).toBe(true);
  });

  it('a JSON bot without claims shows nothing stale', () => {
    const state = show({ page: null, claims: false });
    expect(state.claimsStale).toBe(false);
    expect(state.claims).toEqual([]);
  });
});
