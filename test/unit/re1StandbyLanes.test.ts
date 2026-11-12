import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShardClaims, type ShardClaimsDeps, type StandbyEnd } from '../../src/bot/internalSetup/fleet/shardClaims';
import type { ClaimStoreApi, RenewAnswer, StandbyRenewRequest, StandbyTakeAnswer } from '../../src/bot/internalSetup/fleet/claimStore';
import type { ClaimTimings, Pair, TakePlan } from '../../src/bot/internalSetup/fleet/claimRules';

const ME = { processId: 'p-re1', nodeId: 'n-re1', nodeName: 'Re1' };
const AT = '22222222-2222-4222-8222-222222222222';
const T: ClaimTimings = { ttlMs: 1500, renewMs: 5, deadlineMs: 1000, statementMs: 2, lockMs: 1 };
const P0: Pair = { shardCount: 8, shardId: 0, claim: 101 };
const P1: Pair = { shardCount: 8, shardId: 1, claim: 102 };

type Step = StandbyTakeAnswer | ((onBegin?: () => void) => StandbyTakeAnswer);

function plan(over: Partial<TakePlan> = {}): TakePlan {
  return { takes: [], wait: null, heldElsewhere: 0, elsewhere: [], waitingForOwner: 0, leftToOthers: 0, ...over };
}

const done = (taken: Pair[], over: Partial<TakePlan> = {}): StandbyTakeAnswer => ({ kind: 'done', shardCount: 8, taken, plan: plan(over) });

function fakeStore(steps: Step[]) {
  const calls = { takes: 0, renewals: [] as StandbyRenewRequest['pairs'][], abandonWork: 0, abandonRenewal: 0 };
  let renewImpl = (req: StandbyRenewRequest): Promise<RenewAnswer> =>
    Promise.resolve({ rows: req.pairs.map(p => ({ shardCount: p.shardCount, shardId: p.shardId, claim: p.claim, mine: true, released: false })), at: 0, priorProcess: null });
  const store = {
    async standbyTake(_req: unknown, onBegin?: () => void): Promise<StandbyTakeAnswer> {
      calls.takes++;
      const step = steps.shift();
      if (!step) throw new Error('no scripted take left');
      if (typeof step === 'function') return step(onBegin);
      onBegin?.();
      return step;
    },
    renewStandby(req: StandbyRenewRequest): Promise<RenewAnswer> {
      calls.renewals.push(req.pairs);
      return renewImpl(req);
    },
    abandonWork() { calls.abandonWork++; },
    abandonRenewal() { calls.abandonRenewal++; },
    pause() { /* not used */ },
    resume() { /* not used */ },
  };
  return { store: store as unknown as ClaimStoreApi, calls, setRenew(fn: typeof renewImpl) { renewImpl = fn; } };
}

function build(store: ClaimStoreApi, over: Partial<ShardClaimsDeps> = {}, standbyOver: Partial<ShardClaimsDeps['standby'] & object> = {}) {
  const lines: string[] = [];
  const put = (level: string) => (...a: unknown[]) => { lines.push(`${level} ${a.map(String).join(' ')}`); };
  const ends: StandbyEnd[] = [];
  const progress: Array<[number, number]> = [];
  const now = { perf: 1_000, wall: 1_700_000_000_000 };
  const claims = new ShardClaims({
    store, me: ME, timings: T, capacity: 4, takeoverSeconds: 30, returns: false, restartable: true, startedAt: 0,
    clocks: () => ({ ...now }),
    fitness: () => null, gateClosed: () => false, isStopping: () => false, stopServingStep: () => undefined,
    noteLapsed: () => undefined, noteLost: () => undefined, restartForShards: () => true, countSetting: () => null,
    reshardOverlap: () => true, log: { log: put('log'), warn: put('warn'), error: put('error') },
    standby: {
      attempt: AT, count: 8,
      onEnd: end => { ends.push(end); },
      onProgress: (held, ready) => { progress.push([held, ready]); },
      ...standbyOver,
    },
    ...over,
  });
  return { claims, lines, ends, progress, now };
}

const fakeClocks = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
const dateClocks = () => () => ({ perf: Date.now(), wall: Date.now() });

afterEach(() => {
  vi.useRealTimers();
});

describe('re1 the standby take ends at a stop', () => {
  it('sends no take once a stop began', async () => {
    const f = fakeStore([done([P0])]);
    const r = build(f.store, { isStopping: () => true });
    expect(await r.claims.standbyTake()).toBeNull();
    expect(f.calls.takes).toBe(0);
    expect(r.lines).toEqual([]);
  });

  it('sends no take after the lanes stopped', async () => {
    const f = fakeStore([done([P0])]);
    const r = build(f.store);
    await r.claims.stopLanes();
    expect(await r.claims.standbyTake()).toBeNull();
    expect(f.calls.takes).toBe(0);
    expect(r.claims.heldPairs()).toEqual([]);
  });

  it('answers null without a retry line when the take fails after a stop began', async () => {
    let stopping = false;
    const f = fakeStore([() => { stopping = true; throw new Error('connection lost'); }, done([P0])]);
    const r = build(f.store, { isStopping: () => stopping });
    expect(await r.claims.standbyTake()).toBeNull();
    expect(f.calls.takes).toBe(1);
    expect(r.lines).toEqual([]);
  });
});

describe('re1 the standby take logs a failure at the first one and every 30 s', () => {
  it('logs again when the next failure comes exactly 30 s after the logged one', async () => {
    let r!: ReturnType<typeof build>;
    const f = fakeStore([
      () => { throw new Error('connection lost'); },
      () => { r.now.wall += 30_000; throw new Error('connection lost'); },
      { kind: 'not-standby', attempt: AT, state: 'cancelled', reason: 'stopped by hand', toCount: 8 },
    ]);
    r = build(f.store);
    expect(await r.claims.standbyTake()).toBeNull();
    expect(f.calls.takes).toBe(3);
    const warn = '[Shards] Cannot take shards yet: the take failed (unreachable); retrying every 0 s';
    expect(r.lines).toEqual([`warn ${warn}`, `warn ${warn}`]);
  });
});

describe('re1 the standby take reports how its attempt ended', () => {
  it('reports the replacing attempt and its count when another attempt replaced it', async () => {
    const f = fakeStore([{ kind: 'not-standby', attempt: '33333333-3333-4333-8333-333333333333', state: 'standby', reason: 'old reason', toCount: 6 }]);
    const r = build(f.store);
    expect(await r.claims.standbyTake()).toBeNull();
    expect(r.ends).toEqual([{ kind: 'called-off', reason: null, replacedBy: 6 }]);
  });

  it('names no replacing count when the reshard row holds no attempt', async () => {
    const f = fakeStore([{ kind: 'not-standby', attempt: null, state: null, reason: 'old reason', toCount: 6 }]);
    const r = build(f.store);
    expect(await r.claims.standbyTake()).toBeNull();
    expect(r.ends).toEqual([{ kind: 'called-off', reason: null }]);
    expect(r.ends[0]).not.toHaveProperty('replacedBy');
  });

  it("keeps the row's reason when its own attempt was called off", async () => {
    const f = fakeStore([{ kind: 'not-standby', attempt: AT, state: 'cancelled', reason: 'stopped by hand', toCount: 8 }]);
    const r = build(f.store);
    expect(await r.claims.standbyTake()).toBeNull();
    expect(r.ends).toEqual([{ kind: 'called-off', reason: 'stopped by hand' }]);
  });
});

describe("re1 the standby take waits while this machine's earlier standby holds rows", () => {
  it('takes nothing on a wait answer and takes on the next try', async () => {
    const f = fakeStore([done([], { wait: { shardIds: [0], remainingMs: 4000 } }), done([P0, P1])]);
    const r = build(f.store);
    const took = await r.claims.standbyTake();
    expect(f.calls.takes).toBe(2);
    expect(took).toEqual({ count: 8, pairs: [P0, P1] });
    expect(r.lines).toEqual(['log [Shards] Standby for the reshard to 8 shards: took shard(s) 0, 1; connecting them to Discord']);
    await r.claims.stopLanes();
  });
});

describe('re1 the standby take that took none', () => {
  it('logs the took-none line with the counts and no all-connected line', async () => {
    const f = fakeStore([done([], { heldElsewhere: 3 })]);
    const r = build(f.store);
    expect(await r.claims.standbyTake()).toEqual({ count: 8, pairs: [] });
    expect(r.lines).toEqual([
      "log [Shards] Standby for the reshard to 8 shards: took none (FLEET_SHARD_CAPACITY 4): 3 taken by other machines' standbys, 5 left to machines with room; this process runs this machine's bot once its old bot process stops",
    ]);
    expect(r.progress).toEqual([[0, 0]]);
    await r.claims.stopLanes();
  });

  it('sends no renewal when it took none, even when the take answered after the deadline', async () => {
    let r!: ReturnType<typeof build>;
    const f = fakeStore([onBegin => { onBegin?.(); r.now.perf += T.deadlineMs; r.now.wall += T.deadlineMs; return done([]); }]);
    r = build(f.store);
    expect(await r.claims.standbyTake()).toEqual({ count: 8, pairs: [] });
    expect(f.calls.renewals).toEqual([]);
    await r.claims.stopLanes();
  });
});

describe('re1 a standby take answered at its deadline is renewed at once', () => {
  it('renews the taken pairs when exactly D passed since the take began', async () => {
    let r!: ReturnType<typeof build>;
    const f = fakeStore([onBegin => { onBegin?.(); r.now.perf += T.deadlineMs; r.now.wall += T.deadlineMs; return done([P0, P1]); }]);
    r = build(f.store);
    const took = await r.claims.standbyTake();
    expect(took).toEqual({ count: 8, pairs: [P0, P1] });
    expect(f.calls.renewals).toEqual([[{ ...P0, ready: false }, { ...P1, ready: false }]]);
    expect(r.ends).toEqual([]);
    await r.claims.stopLanes();
  });

  it('sends no renewal when the take answered before D', async () => {
    let r!: ReturnType<typeof build>;
    const f = fakeStore([onBegin => { onBegin?.(); r.now.perf += T.deadlineMs - 1; r.now.wall += T.deadlineMs - 1; return done([P0]); }]);
    r = build(f.store);
    await r.claims.standbyTake();
    expect(f.calls.renewals).toEqual([]);
    await r.claims.stopLanes();
  });
});

describe('re1 setReady reports progress only on a change of a held shard', () => {
  it('ignores a shard the standby does not hold and a repeat of the same state', async () => {
    const f = fakeStore([done([P0, P1])]);
    const r = build(f.store);
    await r.claims.standbyTake();
    expect(r.progress).toEqual([[2, 0]]);
    r.claims.setReady(5, true);
    expect(r.progress).toEqual([[2, 0]]);
    r.claims.setReady(0, true);
    expect(r.progress).toEqual([[2, 0], [2, 1]]);
    r.claims.setReady(0, true);
    expect(r.progress).toEqual([[2, 0], [2, 1]]);
    r.claims.setReady(1, true);
    expect(r.progress).toEqual([[2, 0], [2, 1], [2, 2]]);
    expect(r.lines.at(-1)).toBe('log [Shards] Standby: all 2 new shard(s) of this process are connected; waiting for the other machines');
    await r.claims.stopLanes();
  });

  it('reports a held single shard becoming ready', async () => {
    const f = fakeStore([done([P0])]);
    const r = build(f.store);
    await r.claims.standbyTake();
    r.claims.setReady(0, true);
    expect(r.progress).toEqual([[1, 0], [1, 1]]);
    await r.claims.stopLanes();
  });

  it('logs the failure when the progress report throws', async () => {
    const f = fakeStore([done([P0])]);
    const r = build(f.store, {}, { onProgress: () => { throw new Error('boom'); } });
    await r.claims.standbyTake();
    expect(r.lines).toContain('error [Shards] Could not report which new shards are connected: Error: boom');
    await r.claims.stopLanes();
  });
});

describe('re1 stopLanes stops the pre-serve lanes', () => {
  it('clears the renewal and poll timers and abandons the work lane', async () => {
    fakeClocks();
    const f = fakeStore([]);
    const r = build(f.store, { clocks: dateClocks() });
    r.claims.start();
    expect(vi.getTimerCount()).toBe(2);
    await r.claims.stopLanes();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.calls.abandonWork).toBe(1);
    expect(f.calls.abandonRenewal).toBe(0);
  });

  it('disarms the deadline, so no lapse ends the standby afterwards', async () => {
    fakeClocks();
    const f = fakeStore([done([P0])]);
    const r = build(f.store, { clocks: dateClocks() });
    await r.claims.standbyTake();
    expect(vi.getTimerCount()).toBe(1);
    await r.claims.stopLanes();
    await vi.advanceTimersByTimeAsync(T.deadlineMs * 3);
    expect(r.ends).toEqual([]);
    expect(r.claims.snapshot().stopped).toBeNull();
  });

  it('gives a renewal on the wire 2 s, then abandons it', async () => {
    fakeClocks();
    const f = fakeStore([]);
    f.setRenew(() => new Promise<RenewAnswer>(() => undefined));
    const r = build(f.store, { clocks: dateClocks() });
    void r.claims.renewOnce();
    let settled = false;
    const stopped = r.claims.stopLanes().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    expect(f.calls.abandonRenewal).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(f.calls.abandonRenewal).toBe(1);
    await stopped;
  });

  it('waits for a renewal that answers within 2 s and abandons nothing', async () => {
    fakeClocks();
    const f = fakeStore([]);
    let answer!: (a: RenewAnswer) => void;
    f.setRenew(() => new Promise<RenewAnswer>(resolve => { answer = resolve; }));
    const r = build(f.store, { clocks: dateClocks() });
    void r.claims.renewOnce();
    let settled = false;
    const stopped = r.claims.stopLanes().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    answer({ rows: [], at: 0, priorProcess: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(f.calls.abandonRenewal).toBe(0);
    await stopped;
  });
});
