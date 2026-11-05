import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShardClaims, releaseFailureLine, type ShardClaimsDeps } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { MemClaimStore } from '../helpers/fakeClaimStore';

// Code review round 15: the release failure line when no pair is named (NB4-R15-DATA-1), and a take or row read cut
// off by the stop's destroy (NB4-R15-RUN-1).

const T = claimTimings(30);
const skew = { perf: 0, wall: 0 };
const NONE = '; any shard row still naming this process frees once its claim expires';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  skew.perf = 0;
  skew.wall = 0;
});

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

function rig(over: Partial<ShardClaimsDeps> = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  const store = new MemClaimStore(() => Date.now());
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const state = { stopping: false };
  const claims = new ShardClaims({
    store,
    me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' },
    timings: T,
    capacity: 4,
    takeoverSeconds: 30,
    returns: true,
    restartable: true,
    startedAt: 0,
    clocks: () => ({ perf: performance.now() + skew.perf, wall: Date.now() + skew.wall }),
    fitness: () => null,
    gateClosed: () => false,
    isStopping: () => state.stopping,
    stopServingStep: () => undefined,
    noteLapsed: () => undefined,
    noteLost: () => undefined,
    restartForShards: () => true,
    log,
    ...over,
  });
  const lines = () => [...log.log.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].map(c => String(c[0]));
  const stop = () => { state.stopping = true; claims.beginStop(); return claims.finishStop(); };
  return { store, claims, lines, stop };
}

describe('the release failure line with no pair named (NB4-R15-DATA-1)', () => {
  it.each([
    ['refused', { kind: 'refused' } as const, false, true],
    ['unreachable before connecting', { kind: 'unreachable', detail: 'ECONNREFUSED' } as const, false, false],
    ['no answer after sending', { kind: 'timeout' } as const, true, true],
    ['a server error', { kind: 'error', code: '55P03', message: 'lock timeout' } as const, false, true],
  ])('%s: one line, whatever the take did', (_name, failure, sent, connected) => {
    const line = releaseFailureLine([], failure as any, sent, connected);
    expect(line.startsWith('[Shards] The release did not complete (')).toBe(true);
    expect(line.endsWith(NONE)).toBe(true);
  });

  it('a stop while the renewal of a take acknowledged after D waits behind an interval renewal', async () => {
    const r = rig();
    r.claims.start();
    expect(await r.claims.firstRenewal()).toBe(true);
    r.store.takeMode = 'hang';
    const taking = r.claims.bootTake(async () => 2);
    await vi.advanceTimersByTimeAsync(0);
    r.store.renewMode = 'hang';
    await vi.advanceTimersByTimeAsync(T.renewMs);
    skew.perf += T.deadlineMs + 1000;
    skew.wall += T.deadlineMs + 1000;
    r.store.takeMode = 'ok';
    r.store.releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.takes.length).toBe(1);
    r.store.releaseMode = pgError('55P03', 'canceling statement due to lock timeout');
    const stopped = r.stop();
    r.store.releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    await stopped;
    expect(r.store.releases.length).toBe(1);
    expect(r.lines()).toContain(`[Shards] The release did not complete (error: SQLSTATE 55P03 canceling statement due to lock timeout)${NONE}`);
    expect(r.lines().filter(l => l.includes('held no shard') || l.includes('boot take may have claimed'))).toEqual([]);
    r.store.releaseHung();
    await vi.advanceTimersByTimeAsync(0);
    await taking;
  });
});

describe('a take or row read destroyed by the stop (NB4-R15-RUN-1)', () => {
  it('a boot take on the wire at the stop logs no cause and promises no retry', async () => {
    const r = rig();
    r.claims.start();
    expect(await r.claims.firstRenewal()).toBe(true);
    r.store.takeMode = 'hang';
    const taking = r.claims.bootTake(async () => 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.abandoned.work).toBe(0);
    const stopped = r.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(await taking).toBeNull();
    await stopped;
    expect(r.store.abandoned.work).toBe(1);
    expect(r.lines().filter(l => l.startsWith('[Shards] Cannot take shards yet'))).toEqual([]);
  });

  it('a boot take that fails before any stop still logs its cause', async () => {
    const r = rig();
    r.claims.start();
    expect(await r.claims.firstRenewal()).toBe(true);
    r.store.takeMode = pgError('57P01', 'terminating connection due to administrator command');
    const taking = r.claims.bootTake(async () => 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.lines().some(l => l.startsWith('[Shards] Cannot take shards yet: the take failed ('))).toBe(true);
    r.store.takeMode = 'ok';
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect((await taking)!.pairs).toHaveLength(2);
  });

  it('a loss whose row read is cut off by the stop names the stop as the cause', async () => {
    const r = rig();
    r.claims.start();
    expect(await r.claims.firstRenewal()).toBe(true);
    const taken = (await r.claims.bootTake(async () => 2))!;
    r.claims.noteGranted();
    const lost = taken.pairs[1];
    r.store.readMode = 'hang';
    Object.assign(r.store.rows.get(`2:${lost.shardId}`)!, { claim: 99, holderProcess: 'p-other' });
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.lines().filter(l => l.startsWith(`[Shards] Shard ${lost.shardId} `))).toEqual([]);
    const stopped = r.stop();
    await vi.advanceTimersByTimeAsync(0);
    await stopped;
    await vi.advanceTimersByTimeAsync(0);
    expect(r.lines()).toContain(`[Shards] Shard ${lost.shardId} is no longer held by this process; its claim row could not be read (not read: this process is stopping)`);
    expect(r.lines().filter(l => l.includes('unreachable'))).toEqual([]);
  });
});
