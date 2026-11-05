import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShardClaims, copiedIdLine, type ShardClaimsDeps } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings, pairKey, type ClaimRow, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import type { PageRead, RenewAnswer, RenewRequest, TakeAnswer, TakeRequest } from '../../src/bot/internalSetup/fleet/claimStore';

// NB4 decisions 5, 6, 10, 12, 15 and 16: what the claims send, log and keep, against a scripted claim store.

const T = claimTimings(30);
const ME = { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' };
const P0: Pair = { shardCount: 2, shardId: 0, claim: 5 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };

type Done = Extract<TakeAnswer, { kind: 'done' }>;

function done(pairs: Pair[], over: Partial<Done> = {}): Done {
  return {
    kind: 'done',
    shardCount: pairs[0]?.shardCount ?? 2,
    taken: pairs.map(pair => ({ pair, above: null })),
    plan: { takes: [], wait: null, heldElsewhere: 0, elsewhere: [], waitingForOwner: 0, leftToOthers: 0 },
    adopted: null,
    predecessorRenewedAt: new Map(),
    ...over,
  };
}

function waiting(renewedAt: Record<number, number>, shardIds = [0], remainingMs = 20_000): Done {
  return done([], {
    plan: { takes: [], wait: { shardIds, remainingMs }, heldElsewhere: 0, elsewhere: [], waitingForOwner: 0, leftToOthers: 0 },
    predecessorRenewedAt: new Map(Object.entries(renewedAt).map(([k, v]) => [Number(k), v])),
  });
}

function claimRow(over: Partial<ClaimRow>): ClaimRow {
  return {
    shardCount: 2, shardId: 0, claim: 5, holderProcess: 'p-a', holderNode: 'node-a', holderName: 'A', homeNode: 'node-a',
    released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: T.ttlMs, expiresUpMs: 1e12, extended: false, ...over,
  };
}

function page(over: Partial<PageRead> = {}): PageRead {
  return { shardCount: 2, upMs: 0, uPrimeMs: 0, rows: [], nodes: [], ...over };
}

function rig(over: Partial<ShardClaimsDeps> = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  const off = { perf: 0, wall: 0 };
  const db = { at: 1000, prior: 'p-a' as string | null };
  const reservedKeys = new Set<string>();
  const takes: TakeAnswer[] = [];
  const store = {
    renew: vi.fn(async (req: RenewRequest): Promise<RenewAnswer> => ({
      rows: req.pairs.map(p => ({ ...p, mine: true, released: reservedKeys.has(pairKey(p)) })),
      at: db.at,
      priorProcess: db.prior,
    })),
    take: vi.fn(async (_req: TakeRequest, onBegin?: () => void): Promise<TakeAnswer> => {
      onBegin?.();
      return takes.shift() ?? done([]);
    }),
    release: vi.fn(async () => []),
    readPage: vi.fn(async (): Promise<PageRead> => page()),
    readRow: vi.fn(async () => ({ row: null as ClaimRow | null, storedCount: 2 as number | null })),
    abandonWork: vi.fn(),
    abandonRenewal: vi.fn(),
    end: vi.fn(async () => undefined),
  };
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const calls = { stopStep: 0, lapsed: [] as number[], lost: [] as number[][], restarts: [] as string[] };
  const state = { fit: null as string | null, stopping: false, restartAnswer: true };
  const claims = new ShardClaims({
    store,
    me: ME,
    timings: T,
    capacity: 4,
    takeoverSeconds: 30,
    returns: true,
    restartable: true,
    startedAt: 0,
    clocks: () => ({ perf: performance.now() + off.perf, wall: Date.now() + off.wall }),
    fitness: () => state.fit,
    gateClosed: () => false,
    isStopping: () => state.stopping,
    stopServingStep: () => { calls.stopStep += 1; },
    noteLapsed: seconds => { calls.lapsed.push(seconds); },
    noteLost: lost => { calls.lost.push(lost.map(p => p.shardId)); },
    restartForShards: reason => { calls.restarts.push(reason); return state.restartAnswer; },
    log,
    ...over,
  });
  const lines = () => [...log.log.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].map(c => String(c[0]));
  return { store, claims, calls, state, lines, log, off, db, reservedKeys, takes };
}

type Rig = ReturnType<typeof rig>;

async function bootWith(r: Rig, pairs: Pair[]) {
  r.takes.push(done(pairs));
  return r.claims.bootTake(async () => 2);
}

// A take acknowledged exactly D after its BEGIN.
function lateAck(r: Rig, pairs: Pair[], lateBy = T.deadlineMs) {
  r.store.take.mockImplementationOnce(async (_req, onBegin) => {
    onBegin?.();
    r.off.perf += lateBy;
    r.off.wall += lateBy;
    return done(pairs);
  });
}

// Granted with nothing held, then a reservation of shard 1 under count 4 through the work lane.
async function reserveOne(r: Rig) {
  const R: Pair = { shardCount: 4, shardId: 1, claim: 9 };
  r.state.restartAnswer = false;
  await bootWith(r, []);
  r.claims.noteGranted();
  r.store.readPage.mockImplementation(async () => page({ shardCount: 4 }));
  r.takes.push(done([R]));
  r.reservedKeys.add(pairKey(R));
  await r.claims.renewOnce();
  await flush();
  expect(r.claims.snapshot().reserved).toEqual([R]);
  return R;
}

describe('a loss', () => {
  it('logs that the leave could not start when noteLost throws', async () => {
    const boom = new Error('leave refused');
    const r = rig({ noteLost: () => { throw boom; } });
    await bootWith(r, [P0]);
    r.store.renew.mockImplementationOnce(async () => ({ rows: [], at: 2000, priorProcess: 'p-a' }));
    await r.claims.renewOnce();
    expect(r.log.error).toHaveBeenCalledWith('[Shards] Could not start the leave after a loss:', boom);
    expect(r.claims.heldPairs()).toEqual([]);
  });

  it('a held pair whose row came back under another holder is lost', async () => {
    const r = rig();
    await bootWith(r, [P0]);
    r.store.renew.mockImplementationOnce(async () => ({ rows: [{ ...P0, mine: false, released: false }], at: 2000, priorProcess: 'p-a' }));
    await r.claims.renewOnce();
    expect(r.calls.lost).toEqual([[0]]);
    expect(r.calls.stopStep).toBe(1);
  });

  it('a reservation the renewal no longer returns is lost', async () => {
    const r = rig();
    await reserveOne(r);
    r.store.renew.mockImplementationOnce(async () => ({ rows: [], at: 3000, priorProcess: 'p-a' }));
    await r.claims.renewOnce();
    expect(r.calls.lost).toEqual([[1]]);
    expect(r.claims.snapshot().reserved).toEqual([]);
  });

  it('a loss found while a page read is on the wire, then a stop: the line says the row was not read because the process is stopping', async () => {
    const r = rig();
    await bootWith(r, [P0]);
    r.claims.noteGranted();
    let rejectPage: ((e: Error) => void) | null = null;
    r.store.readPage.mockImplementationOnce(() => new Promise<PageRead>((_resolve, reject) => { rejectPage = reject; }));
    r.store.abandonWork.mockImplementation(() => { rejectPage?.(new Error('Connection terminated')); });
    await r.claims.renewOnce();
    r.store.renew.mockImplementationOnce(async () => ({ rows: [], at: 2000, priorProcess: 'p-a' }));
    await r.claims.renewOnce();
    expect(r.calls.lost).toEqual([[0]]);
    await r.claims.finishStop();
    await flush();
    expect(r.store.readRow).not.toHaveBeenCalled();
    expect(r.lines()).toContain('[Shards] Shard 0 is no longer held by this process; its claim row could not be read (not read: this process is stopping)');
  });
});

describe('the heartbeat and a copied node id', () => {
  it('a fit process with no restart sent says fit in its heartbeat', async () => {
    const r = rig();
    await r.claims.renewOnce();
    expect(r.store.renew.mock.calls[0][0].heartbeat.fit).toBe(true);
  });

  it('a node row with no prior process is not a copy', async () => {
    const r = rig();
    r.db.prior = null;
    await r.claims.renewOnce();
    await r.claims.renewOnce();
    await r.claims.renewOnce();
    expect(r.lines()).not.toContain(copiedIdLine('node-a'));
  });

  it('the copied id line repeats exactly 10 minutes after the last one, not earlier', async () => {
    const r = rig();
    await r.claims.renewOnce();
    r.db.prior = 'p-other';
    await r.claims.renewOnce();
    const count = () => r.lines().filter(l => l === copiedIdLine('node-a')).length;
    expect(count()).toBe(1);
    r.off.wall += 10 * 60_000 - 1;
    await r.claims.renewOnce();
    expect(count()).toBe(1);
    r.off.wall += 1;
    await r.claims.renewOnce();
    expect(count()).toBe(2);
  });
});

describe('the deadline before the grant', () => {
  it('a renewal completed before the grant arms the deadline, which lapses D after its send', async () => {
    const r = rig();
    await bootWith(r, [P0]);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    await r.claims.renewOnce();
    await vi.advanceTimersByTimeAsync(T.deadlineMs - 1);
    expect(r.calls.stopStep).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.calls.stopStep).toBe(1);
    expect(r.calls.lapsed).toEqual([20]);
    expect(r.lines()).toContain('[Shards] No claim renewal for 20 s; every shard leaves Discord and the unsaved changes are kept until a renewal completes');
  });
});

describe('the first renewal and the boot take after a stop began', () => {
  it('firstRenewal answers false without renewing once a stop began', async () => {
    const r = rig();
    r.state.stopping = true;
    expect(await r.claims.firstRenewal()).toBe(false);
    expect(r.store.renew).not.toHaveBeenCalled();
  });

  it('a take that fails after the stop began answers null and logs no retry line', async () => {
    const r = rig();
    r.store.take.mockImplementationOnce(async () => { r.state.stopping = true; throw new Error('connect ECONNREFUSED'); });
    const p = r.claims.bootTake(async () => 2);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(await p).toBeNull();
    expect(r.log.warn).not.toHaveBeenCalled();
    expect(r.store.take).toHaveBeenCalledTimes(1);
  });
});

describe('the boot wait for the previous process', () => {
  const copies = (r: Rig) => r.lines().filter(l => l === copiedIdLine('node-a')).length;

  async function run(r: Rig, answers: Done[], firstAt: number | null = 1000) {
    if (firstAt !== null) {
      r.db.at = firstAt;
      await r.claims.renewOnce();
    }
    r.takes.push(...answers, done([]));
    const p = r.claims.bootTake(async () => 2);
    await vi.advanceTimersByTimeAsync(10 * T.renewMs);
    return p;
  }

  it('the first wait answer is never a copy, however recent the predecessor renewed', async () => {
    const r = rig();
    await run(r, [waiting({ 0: 2000 })]);
    expect(copies(r)).toBe(0);
  });

  it('a predecessor that did not renew between two takes is not a copy', async () => {
    const r = rig();
    await run(r, [waiting({ 0: 2000 }), waiting({ 0: 2000 })]);
    expect(copies(r)).toBe(0);
  });

  it('a renewal at the same database time as this process\'s first renewal is not a copy', async () => {
    const r = rig();
    await run(r, [waiting({ 0: 900 }), waiting({ 0: 1000 })]);
    expect(copies(r)).toBe(0);
  });

  it('a copy is logged once per shard, and the next take asks for it as copied', async () => {
    const r = rig();
    await run(r, [waiting({ 0: 2000 }), waiting({ 0: 3000 }), waiting({ 0: 4000 })]);
    expect(copies(r)).toBe(1);
    expect([...(r.store.take.mock.calls[2][0].copied ?? [])]).toEqual([0]);
  });

  it('the wait line is not repeated when the remaining time drifts by exactly R', async () => {
    const r = rig();
    await run(r, [waiting({ 0: 100 }, [0], 20_000), waiting({ 0: 100 }, [0], 20_000 - 2 * T.renewMs)], null);
    const waits = r.lines().filter(l => l.startsWith('[Shards] Shards 0 are still claimed'));
    expect(waits).toEqual(["[Shards] Shards 0 are still claimed by this machine's previous bot process, which stopped without releasing them; taking them in 20 s"]);
  });

  it('a wait with no copy takes again only after R', async () => {
    const r = rig();
    r.takes.push(waiting({ 0: 100 }), done([]));
    const p = r.claims.bootTake(async () => 2);
    await vi.advanceTimersByTimeAsync(T.renewMs - 1);
    expect(r.store.take).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.store.take).toHaveBeenCalledTimes(2);
    expect(await p).not.toBeNull();
  });

  it('once every waited shard is a copy, the next take goes at once', async () => {
    const r = rig();
    r.db.at = 1000;
    await r.claims.renewOnce();
    r.takes.push(waiting({ 0: 2000 }), waiting({ 0: 3000 }), done([]));
    const p = r.claims.bootTake(async () => 2);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    await vi.advanceTimersByTimeAsync(T.renewMs - 1);
    expect(r.store.take).toHaveBeenCalledTimes(3);
    expect(await p).not.toBeNull();
  });

  it('while one waited shard is not a copy, the next take waits R', async () => {
    const r = rig();
    r.db.at = 1000;
    await r.claims.renewOnce();
    r.takes.push(waiting({ 0: 2000, 1: 500 }, [0, 1]), waiting({ 0: 3000, 1: 500 }, [0, 1]), done([]));
    const p = r.claims.bootTake(async () => 2);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    await vi.advanceTimersByTimeAsync(T.renewMs - 1);
    expect(copies(r)).toBe(1);
    expect(r.store.take).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.store.take).toHaveBeenCalledTimes(3);
    expect(await p).not.toBeNull();
  });
});

describe('the boot take answer', () => {
  it('a take within the target logs no above-target line', async () => {
    const r = rig();
    await bootWith(r, [P0]);
    expect(r.lines().filter(l => l.includes('above this machine\'s target'))).toEqual([]);
  });

  it('an empty take acknowledged after D sends no renewal', async () => {
    const r = rig();
    lateAck(r, []);
    const taken = await r.claims.bootTake(async () => 2);
    expect(taken?.pairs).toEqual([]);
    expect(r.store.renew).not.toHaveBeenCalled();
  });

  it('a take acknowledged 1 ms before D is kept without a renewal', async () => {
    const r = rig();
    lateAck(r, [P0], T.deadlineMs - 1);
    const taken = await r.claims.bootTake(async () => 2);
    expect(taken?.pairs).toEqual([P0]);
    expect(r.store.renew).not.toHaveBeenCalled();
  });

  it('a take acknowledged exactly D after its BEGIN is renewed at once, and a pair it does not return leaves the set', async () => {
    const r = rig();
    lateAck(r, [P0]);
    r.store.renew.mockImplementationOnce(async () => ({ rows: [], at: 2000, priorProcess: 'p-a' }));
    const taken = await r.claims.bootTake(async () => 2);
    expect(r.store.renew).toHaveBeenCalledTimes(1);
    expect(r.store.renew.mock.calls[0][0].pairs).toEqual([P0]);
    expect(taken?.pairs).toEqual([]);
    expect(r.claims.heldPairs()).toEqual([]);
  });

  it('after the late renewal, the next renewal goes out on the wire', async () => {
    const r = rig();
    lateAck(r, [P0]);
    const taken = await r.claims.bootTake(async () => 2);
    expect(taken?.pairs).toEqual([P0]);
    await r.claims.renewOnce();
    expect(r.store.renew).toHaveBeenCalledTimes(2);
  });

  it('the late renewal keeps no pair whose row came back under another holder', async () => {
    const r = rig();
    lateAck(r, [P0]);
    r.store.renew.mockImplementationOnce(async () => ({ rows: [{ ...P0, mine: false, released: false }], at: 2000, priorProcess: 'p-a' }));
    const taken = await r.claims.bootTake(async () => 2);
    expect(taken?.pairs).toEqual([]);
  });

  it('a failed late renewal keeps nothing and records the failure class', async () => {
    const r = rig();
    lateAck(r, [P0]);
    r.store.renew.mockImplementationOnce(async () => { throw new Error('connect ECONNREFUSED'); });
    const taken = await r.claims.bootTake(async () => 2);
    expect(taken?.pairs).toEqual([]);
    expect(r.claims.latestFailureClass()).toEqual({ kind: 'unreachable', detail: 'connect ECONNREFUSED' });
  });

  it('a pair renewed by the late renewal and then taken by another process says it was taken while this process could not renew it', async () => {
    const r = rig();
    lateAck(r, [P0]);
    r.db.at = 5000;
    const taken = await r.claims.bootTake(async () => 2);
    expect(taken?.pairs).toEqual([P0]);
    r.store.renew.mockImplementationOnce(async () => ({ rows: [], at: 7000, priorProcess: 'p-a' }));
    r.store.readRow.mockImplementationOnce(async () => ({
      row: claimRow({ claim: 12, holderProcess: 'p-b', holderNode: 'node-b', holderName: 'B', takenAt: 6000 }),
      storedCount: 2,
    }));
    await r.claims.renewOnce();
    await flush();
    expect(r.lines()).toContain("[Shards] Shard 0's claim row holds claim 12 of B (process p-b), not this process's claim 5; it was taken while this process could not renew it");
  });
});

describe('a failed page read', () => {
  it('after a stop began, a failed page read sends no restart request', async () => {
    const r = rig();
    await reserveOne(r);
    expect(r.calls.restarts).toEqual(['take shard 1']);
    r.state.stopping = true;
    r.store.readPage.mockImplementationOnce(async () => { throw new Error('connect ECONNREFUSED'); });
    await r.claims.renewOnce();
    await flush();
    expect(r.store.readPage).toHaveBeenCalledTimes(2);
    expect(r.calls.restarts).toEqual(['take shard 1']);
  });

  it('a stale reservation given up after a failed page read leaves no pending return in the restart reason', async () => {
    const r = rig();
    const P: Pair = { shardCount: 2, shardId: 0, claim: 5 };
    const R: Pair = { shardCount: 2, shardId: 1, claim: 9 };
    r.state.restartAnswer = false;
    await bootWith(r, [P]);
    r.claims.noteGranted();
    r.store.readPage.mockImplementation(async () => page({
      shardCount: 2,
      rows: [{ ...claimRow({ homeNode: 'node-b' }), renewedAgoMs: 0 }],
      nodes: [{
        nodeId: 'node-b', nodeName: 'B', processId: 'p-b', capacity: 4, takeoverSeconds: 30, fit: true, restartable: true,
        returns: true, seenAgoMs: 0, healthyForMs: 300_000,
      }],
    }));
    r.takes.push(done([R]));
    r.reservedKeys.add(pairKey(R));
    await r.claims.renewOnce();
    await flush();
    expect(r.claims.snapshot().reserved).toEqual([R]);
    expect(r.claims.snapshot().returning).toEqual([0]);
    expect(r.calls.restarts).toEqual(['take shard 1; return shard 0 to B']);
    r.off.perf += T.ttlMs;
    r.off.wall += T.ttlMs;
    r.store.readPage.mockImplementationOnce(async () => { throw new Error('connect ECONNREFUSED'); });
    await r.claims.renewOnce();
    await flush();
    expect(r.claims.snapshot().reserved).toEqual([]);
    expect(r.lines().some(l => l.startsWith('[Shards] Gave up the reservation of shard 1'))).toBe(true);
    expect(r.claims.snapshot().pendingRestart).toBeNull();
  });
});
