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
  return { ...real, realFetchGatewayInfoResult: real.fetchGatewayInfoResult, fetchGatewayInfoResult: vi.fn(next) };
});

import * as placement from '../../src/bot/internalSetup/fleet/placement';
import { IdentifyLedger } from '../../src/bot/internalSetup/fleet/identifyLedger';

afterEach(() => { delete process.env.FLEET_SHARD_COUNT; vi.restoreAllMocks(); });

describe('A11-1 shard source names what decided the count', () => {
  it('a valid override reads override, whether or not Discord answered', () => {
    process.env.FLEET_SHARD_COUNT = '4';
    expect(placement.decideShardSource(true)).toBe('override');
    expect(placement.decideShardSource(false)).toBe('override');
  });
  it('without an override: discord when it answered, fallback when it failed', () => {
    expect(placement.decideShardSource(true)).toBe('discord');
    expect(placement.decideShardSource(false)).toBe('fallback');
    process.env.FLEET_SHARD_COUNT = '0';
    expect(placement.decideShardSource(false)).toBe('fallback');
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
    const ledger: any = new IdentifyLedger('t', 2, null, 2);
    await ledger.refresh();
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('/gateway/bot: HTTP 401');
  });
  it('the ledger keeps the shard count of each successful refresh with its read time', async () => {
    const ledger: any = new IdentifyLedger('t', 2, null, 2);
    expect(ledger.getRecommendation().shards).toBe(2);
    gatewayReplies.push({ recommendedShards: 3, sessionStartLimit: null });
    await ledger.refresh();
    expect(ledger.getRecommendation().shards).toBe(3);
    expect(typeof ledger.getRecommendation().readAt).toBe('number');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await ledger.refresh();
    expect(ledger.getRecommendation().shards).toBe(3);
  });
});
