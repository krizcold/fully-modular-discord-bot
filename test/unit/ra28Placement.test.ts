import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const httpsGet = vi.hoisted(() => ({ fn: null as null | ((...args: any[]) => any) }));
vi.mock('https', async importOriginal => {
  const real: any = await importOriginal();
  const get = (...args: any[]) => {
    if (!httpsGet.fn) throw new Error('no network in this test');
    return httpsGet.fn(...args);
  };
  return { ...real, default: { ...real, get }, get };
});

import { fetchGatewayInfoResult, parseGatewayInfo } from '../../src/bot/internalSetup/fleet/placement';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseGatewayInfo: what the bot reads from /gateway/bot', () => {
  it('reads every field of a full answer', () => {
    expect(parseGatewayInfo({
      shards: 4,
      session_start_limit: { total: 1000, remaining: 997, reset_after: 86_000, max_concurrency: 16 },
    })).toEqual({
      recommendedShards: 4,
      sessionStartLimit: { total: 1000, remaining: 997, resetAfterMs: 86_000, maxConcurrency: 16 },
    });
  });

  it('an answer without session_start_limit gives the shard count and no limit', () => {
    expect(parseGatewayInfo({ shards: 2 })).toEqual({ recommendedShards: 2, sessionStartLimit: null });
  });

  it('a limit whose total is not a number gives no limit', () => {
    expect(parseGatewayInfo({ shards: 3, session_start_limit: { total: 'abc', remaining: 5 } }))
      .toEqual({ recommendedShards: 3, sessionStartLimit: null });
  });

  it('missing or zero numbers fall back to 1 shard, 0 remaining and 0 ms', () => {
    expect(parseGatewayInfo({ shards: 0, session_start_limit: { total: 10 } })).toEqual({
      recommendedShards: 1,
      sessionStartLimit: { total: 10, remaining: 0, resetAfterMs: 0, maxConcurrency: 1 },
    });
  });

  it('max_concurrency that is not a positive integer reads as 1', () => {
    for (const mc of [0, -3, 2.5, 'x']) {
      expect(parseGatewayInfo({ shards: 1, session_start_limit: { total: 5, max_concurrency: mc } })
        .sessionStartLimit?.maxConcurrency).toBe(1);
    }
    expect(parseGatewayInfo({ shards: 1, session_start_limit: { total: 5, max_concurrency: 4 } })
      .sessionStartLimit?.maxConcurrency).toBe(4);
  });
});

describe('fetchGatewayInfoResult', () => {
  it('answers with the parsed information when Discord replies 200', async () => {
    httpsGet.fn = (_url: any, _opts: any, cb: any) => {
      const req = new EventEmitter() as any;
      req.destroy = () => undefined;
      const res = new EventEmitter() as any;
      res.statusCode = 200;
      queueMicrotask(() => {
        cb(res);
        res.emit('data', JSON.stringify({ shards: 6, session_start_limit: { total: 1000, remaining: 900, reset_after: 10, max_concurrency: 1 } }));
        res.emit('end');
      });
      return req;
    };
    const outcome = await Promise.race([
      fetchGatewayInfoResult('token'),
      new Promise(resolve => setTimeout(() => resolve('no answer'), 1000)),
    ]);
    expect(outcome).toEqual({
      info: { recommendedShards: 6, sessionStartLimit: { total: 1000, remaining: 900, resetAfterMs: 10, maxConcurrency: 1 } },
      error: null,
    });
  });
});
