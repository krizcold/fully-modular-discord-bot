import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShardClaims, type ShardClaimsDeps } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings, type ClaimTimings, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import type { ClaimStoreApi, PageRead, RenewAnswer, RenewRequest, TakeAnswer } from '../../src/bot/internalSetup/fleet/claimStore';

// NB4 decisions 6, 15 and 16: the heartbeat's fitness, the claim of a held shard, the deadline counted from the oldest
// renewal, the lapse exception asked again every R, the stop-serving step's failure lines, the loss's record rewrite
// and the restart request's waiting reason.

const T = claimTimings(30);
const S2 = (shardId: number, claim: number): Pair => ({ shardCount: 2, shardId, claim });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};

function done(pairs: Pair[]): TakeAnswer {
  return {
    kind: 'done',
    shardCount: 2,
    taken: pairs.map(pair => ({ pair, above: null })),
    plan: { wait: null, elsewhere: [], takes: [] } as never,
    predecessorRenewedAt: new Map(),
  };
}

const returned = (pairs: Pair[], released = false): RenewAnswer => ({
  rows: pairs.map(p => ({ ...p, mine: true, released })),
  at: 1,
  priorProcess: null,
});

class Store {
  renewals: RenewRequest[] = [];
  takes: TakeAnswer[] = [];
  page: PageRead = { shardCount: 2, upMs: 0, uPrimeMs: 0, rows: [], nodes: [] };
  renewImpl: (request: RenewRequest) => Promise<RenewAnswer> = async request => returned(request.pairs);
  async renew(request: RenewRequest): Promise<RenewAnswer> {
    this.renewals.push(request);
    return this.renewImpl(request);
  }
  async take(): Promise<TakeAnswer> {
    return this.takes.shift() ?? done([]);
  }
  async release() { return []; }
  async readPage() { return this.page; }
  async readRow() { return { row: null, storedCount: null }; }
  abandonWork() { /* nothing on the wire */ }
  abandonRenewal() { /* nothing on the wire */ }
  async end() { /* nothing to close */ }
}

function rig(over: Partial<ShardClaimsDeps> = {}, timings: ClaimTimings = T, fakeDate = false) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', ...(fakeDate ? ['Date' as const] : [])] });
  if (fakeDate) vi.setSystemTime(0);
  const store = new Store();
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const clock = { cur: { perf: 0, wall: 0 }, queue: [] as Array<{ perf: number; wall: number }> };
  const calls = {
    stopStep: 0,
    gateAsked: 0,
    lapsed: [] as number[],
    lost: [] as Array<[Pair[], Pair[]]>,
    lostAtStop: [] as Array<[Pair[], Pair[]]>,
    restarts: [] as string[],
  };
  const state = { fit: null as string | null, gateClosed: false, stopping: false, restartSends: true };
  const claims = new ShardClaims({
    store: store as unknown as ClaimStoreApi,
    me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' },
    timings,
    capacity: 4,
    takeoverSeconds: 30,
    returns: false,
    restartable: true,
    startedAt: 0,
    clocks: () => {
      const next = clock.queue.shift();
      if (next) clock.cur = next;
      return { ...clock.cur };
    },
    fitness: () => state.fit,
    gateClosed: () => { calls.gateAsked += 1; return state.gateClosed; },
    isStopping: () => state.stopping,
    stopServingStep: () => { calls.stopStep += 1; },
    noteLapsed: seconds => { calls.lapsed.push(seconds); },
    noteLost: (lost, still) => { calls.lost.push([lost, still]); },
    noteLostAtStop: (lost, still) => { calls.lostAtStop.push([lost, still]); },
    restartForShards: reason => { calls.restarts.push(reason); return state.restartSends; },
    log,
    ...over,
  });
  const at = (ms: number) => { clock.cur = { perf: ms, wall: ms }; };
  return { store, claims, calls, state, log, clock, at };
}

async function holding(r: ReturnType<typeof rig>, pairs: Pair[]) {
  r.store.takes.push(done(pairs));
  const taken = await r.claims.bootTake(async () => 2);
  expect(taken?.pairs).toEqual(pairs);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

describe('the heartbeat and the claim of a held shard', () => {
  it('a fresh fit process says fit in its first renewal heartbeat', async () => {
    const r = rig();
    await r.claims.renewOnce();
    expect(r.store.renewals).toHaveLength(1);
    expect(r.store.renewals[0].heartbeat.fit).toBe(true);
  });

  it('claimOf answers the claim of the shard asked for, and null for a shard not held', async () => {
    const r = rig();
    await holding(r, [S2(0, 5), S2(1, 9)]);
    expect(r.claims.claimOf(1)).toBe(9);
    expect(r.claims.claimOf(0)).toBe(5);
    expect(r.claims.claimOf(7)).toBeNull();
  });

  it('a second start makes no second renewal timer: after the stop no renewal is sent', async () => {
    const r = rig();
    r.claims.start();
    r.claims.start();
    await r.claims.finishStop();
    await vi.advanceTimersByTimeAsync(3 * T.renewMs);
    expect(r.store.renewals).toHaveLength(0);
  });
});

describe('the deadline counts from the oldest renewal of a held pair', () => {
  // Pair A is renewed by a renewal sent at 1000 that answers after a second take at 2000 returned A and B.
  async function split(r: ReturnType<typeof rig>, order: 'AB' | 'BA') {
    const A = S2(0, 1);
    const B = S2(1, 2);
    await holding(r, [A]);
    const wire = deferred<RenewAnswer>();
    r.store.renewImpl = () => wire.promise;
    r.at(1000);
    const renewal = r.claims.renewOnce();
    r.at(2000);
    await holding(r, order === 'AB' ? [A, B] : [B, A]);
    wire.resolve(returned([A]));
    await renewal;
  }

  it.each(['AB', 'BA'] as const)('held in order %s: lapses at D after the older send, not after the newer one', async order => {
    const r = rig();
    await split(r, order);
    r.at(1000 + T.deadlineMs - 1);
    expect(r.claims.stoppedServing()).toBe(false);
    expect(r.calls.stopStep).toBe(0);
    r.at(1000 + T.deadlineMs);
    expect(r.claims.stoppedServing()).toBe(true);
    expect(r.calls.stopStep).toBe(1);
    expect(r.calls.lapsed).toEqual([20]);
  });

  it('two sends with the same elapsed time: the first held pair counts, so a wall jump that only moves the other does not lapse', async () => {
    const r = rig({}, { ...T, deadlineMs: 10_200 });
    const A = S2(0, 1);
    const B = S2(1, 2);
    await holding(r, [A]);
    const wire = deferred<RenewAnswer>();
    r.store.renewImpl = () => wire.promise;
    r.clock.cur = { perf: 0, wall: 1000 };
    const renewal = r.claims.renewOnce();
    r.clock.cur = { perf: 1000, wall: 0 };
    await holding(r, [A, B]);
    wire.resolve(returned([A]));
    await renewal;
    r.clock.queue.push({ perf: 10_000, wall: 10_000 }, { perf: 10_000, wall: 10_500 });
    expect(r.claims.stoppedServing()).toBe(false);
    expect(r.calls.stopStep).toBe(0);
  });

  it('a process holding no shard never lapses', () => {
    const r = rig();
    r.at(10 * T.deadlineMs);
    expect(r.claims.stoppedServing()).toBe(false);
    expect(r.calls.stopStep).toBe(0);
    expect(r.calls.lapsed).toEqual([]);
  });
});

describe('the lapse exception is asked again every R', () => {
  it('refused with the gate closed: asked at D and then once per R; the lapse comes at the first R after the gate opens', async () => {
    const r = rig({ clocks: () => ({ perf: Date.now(), wall: Date.now() }) }, T, true);
    await holding(r, [S2(0, 1)]);
    r.claims.noteGranted();
    r.store.renewImpl = async () => { throw Object.assign(new Error('password authentication failed'), { code: '28000' }); };
    await r.claims.renewOnce();
    expect(r.claims.latestFailureClass()).toEqual({ kind: 'refused' });
    r.state.gateClosed = true;
    await vi.advanceTimersByTimeAsync(T.deadlineMs);
    expect(r.calls.gateAsked).toBe(1);
    await vi.advanceTimersByTimeAsync(T.renewMs - 1);
    expect(r.calls.gateAsked).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.calls.gateAsked).toBe(2);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.calls.gateAsked).toBe(3);
    expect(r.calls.stopStep).toBe(0);
    r.state.gateClosed = false;
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.calls.stopStep).toBe(1);
    expect(r.calls.lapsed).toEqual([35]);
    expect(r.claims.snapshot().stopped).toBe('lapse');
  });
});

describe('the stop-serving step and the reports after it', () => {
  it('a failed lapse report is logged with its error', async () => {
    const boom = new Error('outage state not written');
    const r = rig({ noteLapsed: () => { throw boom; } });
    await holding(r, [S2(0, 1)]);
    r.at(T.deadlineMs);
    expect(r.claims.stoppedServing()).toBe(true);
    expect(r.log.error).toHaveBeenCalledWith('[Shards] Could not report the lapse:', boom);
  });

  it('a failed stop-serving step is logged with its error', async () => {
    const boom = new Error('gateway did not close');
    const r = rig({ stopServingStep: () => { throw boom; } });
    await holding(r, [S2(0, 1)]);
    r.at(T.deadlineMs);
    expect(r.claims.stoppedServing()).toBe(true);
    expect(r.log.error).toHaveBeenCalledWith('[Shards] The stop-serving step failed:', boom);
  });

  it('a loss after a lapse runs no second stop-serving step and keeps the lapse as the reason', async () => {
    const r = rig();
    const A = S2(0, 1);
    const B = S2(1, 2);
    await holding(r, [A, B]);
    r.at(T.deadlineMs);
    expect(r.claims.stoppedServing()).toBe(true);
    r.store.renewImpl = async () => returned([A]);
    await r.claims.renewOnce();
    expect(r.calls.lost).toEqual([[[B], [A]]]);
    expect(r.calls.stopStep).toBe(1);
    expect(r.claims.snapshot().stopped).toBe('lapse');
  });

  it('a loss outside a stop starts the leave naming the lost shard and the shards still held', async () => {
    const r = rig();
    const A = S2(0, 1);
    const B = S2(1, 2);
    await holding(r, [A, B]);
    r.store.renewImpl = async () => returned([A]);
    await r.claims.renewOnce();
    expect(r.calls.lost).toEqual([[[B], [A]]]);
    expect(r.calls.stopStep).toBe(1);
    expect(r.claims.heldPairs()).toEqual([A]);
  });

  it('a loss in the exit drain rewrites the record naming the lost shard and the shards still held', async () => {
    const r = rig();
    const A = S2(0, 1);
    const B = S2(1, 2);
    await holding(r, [A, B]);
    r.claims.beginStop();
    r.store.renewImpl = async () => returned([A]);
    await r.claims.renewOnce();
    expect(r.calls.lostAtStop).toEqual([[[B], [A]]]);
    expect(r.calls.lost).toEqual([]);
  });

  it('a failed record rewrite in the exit drain is logged with the error message', async () => {
    const r = rig({ noteLostAtStop: () => { throw new Error('disk full'); } });
    const A = S2(0, 1);
    const B = S2(1, 2);
    await holding(r, [A, B]);
    r.claims.beginStop();
    r.store.renewImpl = async () => returned([A]);
    await r.claims.renewOnce();
    expect(r.log.error).toHaveBeenCalledWith('[Shards] Could not rewrite the shard record:', 'disk full');
  });
});

describe('reservations and the restart request', () => {
  async function reserving(r: ReturnType<typeof rig>, pairs: Pair[]) {
    await holding(r, []);
    r.store.takes.push(done(pairs));
    r.claims.noteGranted();
    await r.claims.renewOnce();
    await flush();
    expect(r.claims.snapshot().reserved).toEqual(pairs);
  }

  it('a lost reservation leaves the reserved list; a reservation the renewal returned stays', async () => {
    const r = rig();
    r.state.restartSends = false;
    const R0 = S2(0, 1);
    const R1 = S2(1, 2);
    await reserving(r, [R0, R1]);
    r.store.renewImpl = async () => returned([R0], true);
    await r.claims.renewOnce();
    await flush();
    expect(r.calls.lost.map(([lost, still]) => [lost.map(p => p.shardId), still])).toEqual([[[1], []]]);
    expect(r.claims.snapshot().reserved).toEqual([R0]);
  });

  it('an unsent restart keeps its waiting reason when the gate closes', async () => {
    const r = rig();
    r.state.restartSends = false;
    await reserving(r, [S2(0, 1)]);
    expect(r.calls.restarts).toEqual(['take shard 0']);
    const snap = r.claims.snapshot();
    expect(snap.pendingRestart).toBe('take shard 0');
    expect(snap.restartWaiting).toBe('the restart request was not sent');
    r.state.gateClosed = true;
    expect(r.claims.snapshot().restartWaiting).toBe('the restart request was not sent');
  });

  it('a sent restart waits on nothing while the process serves with its gate open, even when unfit', async () => {
    const r = rig();
    await reserving(r, [S2(0, 1)]);
    expect(r.calls.restarts).toEqual(['take shard 0']);
    r.state.fit = 'memory';
    expect(r.claims.snapshot().restartWaiting).toBeNull();
    r.state.gateClosed = true;
    expect(r.claims.snapshot().restartWaiting).toBe('memory');
  });
});
