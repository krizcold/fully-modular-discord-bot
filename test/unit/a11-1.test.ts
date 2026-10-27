import https from 'https';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const gatewayReplies: any[] = [];
vi.mock('../../src/bot/internalSetup/fleet/placement', async importOriginal => {
  const real: any = await importOriginal();
  const next = async () => {
    const info = gatewayReplies.shift() ?? null;
    return { info, error: info ? null : 'HTTP 401' };
  };
  return {
    ...real,
    realFetchGatewayInfoResult: real.fetchGatewayInfoResult,
    fetchGatewayInfo: vi.fn(async () => (await next()).info),
    fetchGatewayInfoResult: vi.fn(next),
  };
});

import * as placement from '../../src/bot/internalSetup/fleet/placement';
import { IdentifyLedger } from '../../src/bot/internalSetup/fleet/identifyLedger';
import { Registry } from '../../src/bot/internalSetup/fleet/registry';
import { _setFleetStateSources, getFleetState, liveReshardAdvised } from '../../src/bot/internalSetup/fleet/state';

afterEach(() => { delete process.env.FLEET_SHARD_COUNT; vi.restoreAllMocks(); });

const recovery = (extra: Record<string, any> = {}): any => ({
  adopted: true, holdDownUntil: 0, reshardAdvised: null, reshardApplied: null,
  reshardNeedsConfirm: null, reshardDeferred: null, reshardPaused: null, ...extra,
});

const baseSources = (extra: Record<string, any>): any => ({
  standalone: false, nodeId: 'n1', nodeName: 'n1', appVersion: '0', pinnedShardId: null, capacity: 4,
  recommendedShards: 2,
  runtime: { getCurrent: () => null, getLastHeartbeat: () => null, hasCurrentLease: () => false },
  ingest: { getClient: () => null },
  registry: null, controlClient: null, recovery: null, ledger: null, healthMonitor: null, refusedRegistrations: null,
  sync: null, migration: null, transformation: null, pinViolation: null, unassigned: null, termStamp: null,
  fleetConfig: null, witness: null, migrationActive: null,
  ...extra,
});

describe('A11-1 shard source names what decided the count', () => {
  it('an adopted plan reads plan, even with an override that was not applied', () => {
    process.env.FLEET_SHARD_COUNT = '4';
    expect((placement as any).decideShardSource({ adoptedPlan: true, overrideApplied: false, gatewayAnswered: true })).toBe('plan');
  });
  it('an applied override reads override', () => {
    process.env.FLEET_SHARD_COUNT = '4';
    expect((placement as any).decideShardSource({ adoptedPlan: true, overrideApplied: true, gatewayAnswered: true })).toBe('override');
  });
  it('no plan and no override: discord when it answered, fallback when it failed', () => {
    expect((placement as any).decideShardSource({ adoptedPlan: false, overrideApplied: false, gatewayAnswered: true })).toBe('discord');
    expect((placement as any).decideShardSource({ adoptedPlan: false, overrideApplied: false, gatewayAnswered: false })).toBe('fallback');
  });
  it('a failed /gateway/bot read names its cause', async () => {
    const real = (placement as any).realFetchGatewayInfoResult;
    expect((await real('')).error).toBe('no bot token is set');
    vi.spyOn(https, 'get').mockImplementation(((_url: any, _opts: any, cb: any) => {
      const res: any = new EventEmitter();
      res.statusCode = 401;
      const req: any = new EventEmitter();
      req.destroy = () => {};
      setImmediate(() => { cb(res); res.emit('data', '{}'); res.emit('end'); });
      return req;
    }) as any);
    const r = await real('t');
    expect(r.info).toBeNull();
    expect(r.error).toBe('HTTP 401');
  });
  it('a failed refresh names its cause in the warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ledger: any = new IdentifyLedger('t', { shardCount: 2, nodes: new Map(), shardTable: new Map() } as any, null, 2);
    await ledger.refresh();
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('/gateway/bot: HTTP 401');
  });
});

describe("A11-1 the reshard advice follows Discord's latest reading", () => {
  it('the ledger keeps the shard count of each successful refresh with its read time', async () => {
    const ledger: any = new IdentifyLedger('t', { shardCount: 2, nodes: new Map(), shardTable: new Map() } as any, null, 2);
    expect(ledger.getRecommendation().shards).toBe(2);
    gatewayReplies.push({ recommendedShards: 3, maxConcurrency: 1, sessionStartLimit: null });
    await ledger.refresh();
    expect(ledger.getRecommendation().shards).toBe(3);
    expect(typeof ledger.getRecommendation().readAt).toBe('number');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await ledger.refresh();
    expect(ledger.getRecommendation().shards).toBe(3);
  });
  it('advice appears when the live reading differs, and clears when it equals the running count', () => {
    expect(liveReshardAdvised(recovery(), 2, { shards: 3, readAt: 5 })).toEqual({ running: 2, recommended: 3, readAt: 5 });
    expect(liveReshardAdvised(recovery({ reshardAdvised: { running: 2, recommended: 3 } }), 2, { shards: 2, readAt: 6 })).toBeNull();
  });
  it('no advice beside a pending or applied reshard, or an override that differs', () => {
    expect(liveReshardAdvised(recovery({ reshardNeedsConfirm: { from: 2, to: 4 } }), 2, { shards: 3, readAt: 5 })).toBeNull();
    expect(liveReshardAdvised(recovery({ reshardApplied: { from: 2, to: 4 } }), 4, { shards: 3, readAt: 5 })).toBeNull();
    process.env.FLEET_SHARD_COUNT = '4';
    expect(liveReshardAdvised(recovery(), 2, { shards: 3, readAt: 5 })).toBeNull();
  });
  it('without any reading the boot advice stays, marked unread', () => {
    expect(liveReshardAdvised(recovery({ reshardAdvised: { running: 2, recommended: 3 } }), 2, null)).toEqual({ running: 2, recommended: 3, readAt: null });
  });
});

describe('A11-1 the fleet state carries the live reading and the shard source', () => {
  it('a master reads the ledger on every call and passes the shard source through', () => {
    const registry = new Registry();
    registry.shardCount = 2;
    let rec: any = { shards: 3, readAt: 100 };
    const ledger: any = { getRecommendation: () => rec, getNodeBackoff: () => null, getBudgetInfo: () => null };
    _setFleetStateSources(baseSources({ role: 'master', registry, ledger, shardSource: 'plan', recovery: recovery({ reshardAdvised: { running: 2, recommended: 5 } }) }));
    let s: any = getFleetState();
    expect(s.shardSource).toBe('plan');
    expect(s.recommendedShards).toBe(3);
    expect(s.recommendedAt).toBe(100);
    expect(s.recovery.reshardAdvised).toEqual({ running: 2, recommended: 3, readAt: 100 });
    rec = { shards: 2, readAt: 200 };
    s = getFleetState();
    expect(s.recommendedShards).toBe(2);
    expect(s.recommendedAt).toBe(200);
    expect(s.recovery.reshardAdvised).toBeNull();
  });
  it('a standalone master without a ledger shows the boot read time', () => {
    const registry = new Registry();
    registry.shardCount = 2;
    _setFleetStateSources(baseSources({ role: 'master', standalone: true, registry, recommendedShards: 3, recommendedAt: 50, shardSource: 'plan' }));
    const s: any = getFleetState();
    expect(s.recommendedShards).toBe(3);
    expect(s.recommendedAt).toBe(50);
  });
  it('a co-worker says the master set its shard count', () => {
    _setFleetStateSources(baseSources({ role: 'co-worker' }));
    expect((getFleetState() as any).shardSource).toBe('master');
  });
});
