import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import type { ClaimStoreApi, RenewAnswer, RenewRequest, TakeAnswer } from '../../src/bot/internalSetup/fleet/claimStore';

// NB4 decisions 6 and 16: the renewal lane starts on any timer handle, and no deadline is armed once the process
// stopped serving or holds no shard.

const T = claimTimings(30);
const S2 = (shardId: number, claim: number): Pair => ({ shardCount: 2, shardId, claim });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function done(pairs: Pair[]): TakeAnswer {
  return {
    kind: 'done',
    shardCount: 2,
    taken: pairs.map(pair => ({ pair, above: null })),
    plan: { wait: null, elsewhere: [], takes: [] } as never,
    adopted: null,
    predecessorRenewedAt: new Map(),
  };
}

class Store {
  takes: TakeAnswer[] = [];
  renewImpl: (request: RenewRequest) => Promise<RenewAnswer> = async request =>
    ({ rows: request.pairs.map(p => ({ ...p, mine: true, released: false })), at: 1, priorProcess: null });
  async renew(request: RenewRequest): Promise<RenewAnswer> { return this.renewImpl(request); }
  async take(): Promise<TakeAnswer> { return this.takes.shift() ?? done([]); }
  async release() { return []; }
  async readPage() { return { shardCount: 2, upMs: 0, uPrimeMs: 0, rows: [], nodes: [] }; }
  async readRow() { return { row: null, storedCount: null }; }
  abandonWork() { /* nothing on the wire */ }
  abandonRenewal() { /* nothing on the wire */ }
  async end() { /* nothing to close */ }
}

function rig() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const store = new Store();
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const clocks = vi.fn(() => ({ perf: 0, wall: 0 }));
  const calls = { stopStep: 0, lost: [] as Array<[Pair[], Pair[]]> };
  const claims = new ShardClaims({
    store: store as unknown as ClaimStoreApi,
    me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' },
    timings: T,
    capacity: 4,
    takeoverSeconds: 30,
    returns: false,
    restartable: true,
    startedAt: 0,
    clocks,
    fitness: () => null,
    gateClosed: () => false,
    isStopping: () => false,
    stopServingStep: () => { calls.stopStep += 1; },
    noteLapsed: () => undefined,
    noteLost: (lost, still) => { calls.lost.push([lost, still]); },
    noteLostAtStop: () => undefined,
    restartForShards: () => true,
    log,
  });
  return { store, claims, calls, log, clocks };
}

describe('the renewal lane start', () => {
  it('starts when the interval handle has no unref', () => {
    const r = rig();
    const interval = vi.spyOn(globalThis, 'setInterval').mockReturnValue(1 as never);
    expect(() => r.claims.start()).not.toThrow();
    expect(interval).toHaveBeenCalledTimes(1);
    expect(interval.mock.calls[0][1]).toBe(T.renewMs);
    r.claims.start();
    expect(interval).toHaveBeenCalledTimes(1);
  });
});

describe('the deadline after the boot grant', () => {
  it('is not armed when a renewal lost one of two shards before the grant', async () => {
    const r = rig();
    r.store.takes.push(done([S2(0, 3), S2(1, 4)]));
    const taken = await r.claims.bootTake(async () => 2);
    expect(taken?.pairs).toEqual([S2(0, 3), S2(1, 4)]);
    r.store.renewImpl = async () => ({ rows: [{ ...S2(0, 3), mine: true, released: false }], at: 2, priorProcess: null });
    await r.claims.renewOnce();
    expect(r.calls.stopStep).toBe(1);
    expect(r.calls.lost).toEqual([[[S2(1, 4)], [S2(0, 3)]]]);
    expect(vi.getTimerCount()).toBe(0);
    r.claims.noteGranted();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * T.deadlineMs);
    expect(r.calls.stopStep).toBe(1);
  });

  it('reads no clock and arms nothing when the grant holds no shard', async () => {
    const r = rig();
    r.store.takes.push(done([]));
    const taken = await r.claims.bootTake(async () => 2);
    expect(taken?.pairs).toEqual([]);
    const before = r.clocks.mock.calls.length;
    r.claims.noteGranted();
    expect(r.clocks.mock.calls.length).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });
});
