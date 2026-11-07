import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import type { ClaimStoreApi, PageRead, RenewAnswer, RenewRequest, TakeAnswer } from '../../src/bot/internalSetup/fleet/claimStore';

// NB4 decision 6 and 12: after a loss the deadline timer is gone (no timer left open past the stop-serving step or
// the release), and the deadline and the release's 2 s wait work with a timer handle that has no unref.

const T = claimTimings(30);
const S2 = (shardId: number, claim: number): Pair => ({ shardCount: 2, shardId, claim });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function done(pairs: Pair[]): TakeAnswer {
  return {
    kind: 'done',
    shardCount: 2,
    taken: pairs.map(pair => ({ pair, above: null })),
    plan: { wait: null, elsewhere: [], takes: [] } as never,
    predecessorRenewedAt: new Map(),
  };
}

const returned = (pairs: Pair[]): RenewAnswer => ({
  rows: pairs.map(p => ({ ...p, mine: true, released: false })),
  at: 1,
  priorProcess: null,
});

class Store {
  takes: TakeAnswer[] = [];
  abandonedRenewal = 0;
  released = 0;
  page: PageRead = { shardCount: 2, upMs: 0, uPrimeMs: 0, rows: [], nodes: [] };
  renewImpl: (request: RenewRequest) => Promise<RenewAnswer> = async request => returned(request.pairs);
  async renew(request: RenewRequest): Promise<RenewAnswer> { return this.renewImpl(request); }
  async take(): Promise<TakeAnswer> { return this.takes.shift() ?? done([]); }
  async release() { this.released += 1; return []; }
  async readPage() { return this.page; }
  async readRow() { return { row: null, storedCount: null }; }
  abandonWork() { /* nothing on the wire */ }
  abandonRenewal() { this.abandonedRenewal += 1; }
  async end() { /* nothing to close */ }
}

function rig() {
  const store = new Store();
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const calls = { clocks: 0, stopStep: 0, lost: 0 };
  const claims = new ShardClaims({
    store: store as unknown as ClaimStoreApi,
    me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' },
    timings: T,
    capacity: 4,
    takeoverSeconds: 30,
    returns: false,
    restartable: true,
    startedAt: 0,
    clocks: () => { calls.clocks += 1; return { perf: 0, wall: 0 }; },
    fitness: () => null,
    gateClosed: () => false,
    isStopping: () => false,
    stopServingStep: () => { calls.stopStep += 1; },
    noteLapsed: () => undefined,
    noteLost: () => { calls.lost += 1; },
    restartForShards: () => true,
    log,
  });
  return { store, claims, calls, log };
}

async function holding(r: ReturnType<typeof rig>, pairs: Pair[]) {
  r.store.takes.push(done(pairs));
  const taken = await r.claims.bootTake(async () => 2);
  expect(taken?.pairs).toEqual(pairs);
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};

// The renewal answers shard 0 only: shard 1 is lost, the process stops serving with shard 0 still held.
async function lose(r: ReturnType<typeof rig>) {
  r.store.renewImpl = async request => returned(request.pairs.filter(p => p.shardId === 0));
  await r.claims.renewOnce();
  await flush();
  expect(r.claims.snapshot().stopped).toBe('loss');
  expect(r.claims.heldPairs()).toEqual([S2(0, 5)]);
  expect(r.calls.stopStep).toBe(1);
}

describe('the deadline timer after a loss', () => {
  it('a grant after a loss arms no deadline timer while a pair is still held', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const r = rig();
    await holding(r, [S2(0, 5), S2(1, 7)]);
    await lose(r);
    expect(vi.getTimerCount()).toBe(0);
    r.claims.noteGranted();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a grant with no pair held reads no clock and arms no deadline timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const r = rig();
    await holding(r, []);
    const before = r.calls.clocks;
    r.claims.noteGranted();
    expect(r.calls.clocks).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a loss after the grant clears the armed deadline timer at the stop-serving step', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const r = rig();
    await holding(r, [S2(0, 5), S2(1, 7)]);
    r.claims.noteGranted();
    expect(vi.getTimerCount()).toBe(1);
    await lose(r);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('no deadline timer is left open after the release that follows a loss', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const r = rig();
    await holding(r, [S2(0, 5), S2(1, 7)]);
    r.claims.noteGranted();
    await lose(r);
    await r.claims.finishStop();
    expect(r.store.released).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('timer handles without unref', () => {
  it('the deadline is armed without an error when setTimeout answers a plain number', async () => {
    const r = rig();
    await holding(r, [S2(0, 5)]);
    const armed: number[] = [];
    vi.stubGlobal('setTimeout', (_fn: () => void, ms: number) => { armed.push(ms); return 1; });
    vi.stubGlobal('clearTimeout', () => undefined);
    expect(() => r.claims.noteGranted()).not.toThrow();
    expect(armed).toEqual([T.deadlineMs]);
  });

  it('the release waits out a renewal on the wire and abandons it when setTimeout answers a plain number', async () => {
    const r = rig();
    r.store.renewImpl = () => new Promise<RenewAnswer>(() => undefined);
    void r.claims.renewOnce();
    const waits: number[] = [];
    vi.stubGlobal('setTimeout', (fn: () => void, ms: number) => { waits.push(ms); setImmediate(fn); return 1; });
    vi.stubGlobal('clearTimeout', () => undefined);
    await expect(r.claims.finishStop()).resolves.toBeUndefined();
    expect(waits).toEqual([2000]);
    expect(r.store.abandonedRenewal).toBe(1);
  });
});
