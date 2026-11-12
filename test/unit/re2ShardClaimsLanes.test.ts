import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShardClaims, l16Line, type ShardClaimsDeps, type StandbyEnd, type StandbyMode } from '../../src/bot/internalSetup/fleet/shardClaims';
import type { Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import { MemClaimStore } from '../helpers/fakeClaimStore';
import { AT, OLD, T, markDone, standbyStore } from '../helpers/standbyRig';

const ME = { processId: 'p-re2', nodeId: 'n-re2', nodeName: 'R' };

function build(store: MemClaimStore, over: Partial<ShardClaimsDeps> = {}) {
  const lines: string[] = [];
  const logged: string[] = [];
  let onLog: (() => void) | null = null;
  const text = (a: unknown[]) => a.map(x => (x instanceof Error ? x.message : String(x))).join(' ');
  const put = (...a: unknown[]) => { lines.push(text(a)); };
  const stops = { serving: 0 };
  const claims = new ShardClaims({
    store, me: ME, timings: T, capacity: 4, takeoverSeconds: 30, returns: false, restartable: true, startedAt: 0,
    fitness: () => null, gateClosed: () => false, isStopping: () => false, stopServingStep: () => { stops.serving += 1; },
    noteLapsed: () => undefined, noteLost: () => undefined, restartForShards: () => true, countSetting: () => null,
    reshardOverlap: () => true,
    log: {
      log: (...a: unknown[]) => {
        lines.push(text(a));
        logged.push(text(a));
        const hook = onLog;
        onLog = null;
        hook?.();
      },
      warn: put,
      error: put,
    },
    ...over,
  });
  return { claims, lines, logged, stops, armLog: (fn: () => void) => { onLog = fn; } };
}

const flush = () => new Promise<void>(resolve => { setImmediate(resolve); });

async function until(cond: () => boolean, rounds = 50): Promise<void> {
  for (let i = 0; i < rounds && !cond(); i++) await flush();
}

function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function plainStore(db?: { now: number }): MemClaimStore {
  const store = new MemClaimStore(db ? () => db.now : () => Date.now());
  store.count = 2;
  return store;
}

async function bootTwo(claims: ShardClaims): Promise<Pair[]> {
  const took = await claims.bootTake(async () => 2);
  expect(took?.pairs).toHaveLength(2);
  return took!.pairs;
}

describe('re2 stopLanes gives a renewal on the wire 2 s', () => {
  it('a renewal that answers within 2 s keeps its connection', async () => {
    fakeTimers();
    const store = plainStore();
    const r = build(store);
    store.renewMode = 'hang';
    const lane = r.claims.renewOnce();
    await flush();
    const stopped = r.claims.stopLanes();
    await vi.advanceTimersByTimeAsync(500);
    store.renewMode = 'ok';
    store.releaseHung();
    await lane;
    await stopped;
    expect(store.abandoned.renewal).toBe(0);
    expect(r.claims.snapshot().renewalError).toBeNull();
  });

  it('a renewal still hung after 2 s has its connection destroyed', async () => {
    fakeTimers();
    const store = plainStore();
    const r = build(store);
    store.renewMode = 'hang';
    const lane = r.claims.renewOnce();
    await flush();
    const stopped = r.claims.stopLanes();
    let done = false;
    void stopped.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).toBe(false);
    expect(store.abandoned.renewal).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    await lane;
    expect(store.abandoned.renewal).toBe(1);
  });
});

function standbyClaims(store: MemClaimStore, over: Partial<StandbyMode> = {}) {
  const ends: StandbyEnd[] = [];
  const done = { count: 0 };
  const standby: StandbyMode = { attempt: AT, count: 8, onEnd: end => { ends.push(end); }, onDone: () => { done.count += 1; }, ...over };
  const r = build(store, { me: { ...ME, nodeId: OLD.nodeId, nodeName: OLD.nodeName }, standby });
  return { ...r, ends, done };
}

/** One tick of the 1 s poll, and every statement it sends. */
async function pollOnce(store: MemClaimStore): Promise<string[]> {
  store.workStatements = [];
  await vi.advanceTimersByTimeAsync(1000);
  for (let i = 0; i < 5; i++) await flush();
  return [...store.workStatements];
}

const transactional = (statements: string[]) => statements.filter(s => /^(BEGIN|SELECT pg_advisory_xact_lock|SELECT 1 FROM smdb_data\.reshard)/.test(s));

describe("re2 the end of a standby", () => {
  it('is reported once when two losses end it', async () => {
    fakeTimers();
    const store = standbyStore(4, 8);
    const r = standbyClaims(store);
    expect(await r.claims.firstRenewal()).toBe(true);
    const took = await r.claims.standbyTake();
    expect(took!.pairs.length).toBeGreaterThanOrEqual(2);
    const [a, b] = took!.pairs;
    store.rows.get(`8:${a.shardId}`)!.holderProcess = 'p-other';
    await r.claims.renewOnce();
    expect(r.ends).toEqual([{ kind: 'failed', cause: `shard ${a.shardId}'s claim is no longer this process's` }]);
    store.rows.get(`8:${b.shardId}`)!.holderProcess = 'p-other';
    await r.claims.renewOnce();
    expect(r.ends).toHaveLength(1);
    await r.claims.stopLanes();
  });

  it('stops the 1 s poll: only the renewal timer is left, and none after stopLanes', async () => {
    fakeTimers();
    const store = standbyStore(4, 8);
    const r = standbyClaims(store);
    r.claims.start();
    expect(vi.getTimerCount()).toBe(2);
    store.reshard = { ...store.reshard, attempt: 'ffffffff-0000-4000-8000-000000000001', toCount: 16 };
    await pollOnce(store);
    expect(r.ends).toEqual([{ kind: 'called-off', reason: null, replacedBy: 16 }]);
    expect(vi.getTimerCount()).toBe(1);
    await r.claims.stopLanes();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs a failed report of the end and goes on', async () => {
    fakeTimers();
    const store = standbyStore(4, 8);
    const r = standbyClaims(store, { onEnd: () => { throw new Error('the web UI channel is closed'); } });
    r.claims.start();
    store.reshard = { ...store.reshard, state: 'cancelled' };
    await pollOnce(store);
    expect(r.lines).toContain('[Shards] Could not report the end of this standby: the web UI channel is closed');
    await r.claims.stopLanes();
  });
});

describe('re2 the standby poll', () => {
  it('a row with no attempt but a to_count ends the standby as called off with no replacing count', async () => {
    fakeTimers();
    const store = standbyStore(4, 8);
    const r = standbyClaims(store);
    r.claims.start();
    store.reshard = { attempt: null, state: null, fromCount: null, toCount: 8 };
    await pollOnce(store);
    expect(r.ends).toEqual([{ kind: 'called-off', reason: null }]);
    expect(r.ends[0]).not.toHaveProperty('replacedBy');
    await r.claims.stopLanes();
  });

  it('a cancelled attempt read by the poll ends the standby with its reason', async () => {
    fakeTimers();
    const store = standbyStore(4, 8);
    const r = standbyClaims(store);
    r.claims.start();
    store.reshard = { ...store.reshard, state: 'cancelled' };
    store.attemptRow = { ...store.attemptRow, reason: 'B is not healthy' };
    await pollOnce(store);
    expect(r.ends).toEqual([{ kind: 'called-off', reason: 'B is not healthy' }]);
    await r.claims.stopLanes();
  });

  it('acts on nothing it read once the lanes stopped during the read', async () => {
    fakeTimers();
    const store = standbyStore(4, 8);
    const r = standbyClaims(store);
    const work = store.withWorkClient.bind(store);
    store.withWorkClient = (async (what: string, fn: any) => {
      const out = await work(what, fn);
      void r.claims.stopLanes();
      return out;
    }) as typeof store.withWorkClient;
    r.claims.start();
    store.reshard = { ...store.reshard, state: 'cancelled' };
    store.attemptRow = { ...store.attemptRow, reason: 'B is not healthy' };
    await pollOnce(store);
    expect(r.ends).toEqual([]);
  });

  it("a 'standby' attempt with no flip or call-off due sends only the read: no lock and no transaction", async () => {
    fakeTimers();
    const store = standbyStore(4, 8);
    const r = standbyClaims(store);
    r.claims.start();
    const statements = await pollOnce(store);
    expect(statements.length).toBeGreaterThan(0);
    expect(transactional(statements)).toEqual([]);
    expect(store.reshard.state).toBe('standby');
    expect(r.ends).toEqual([]);
    await r.claims.stopLanes();
  });

  it("a 'flipped' attempt with old rows still live sends only the read: no close transaction", async () => {
    fakeTimers();
    const store = standbyStore(4, 8);
    store.count = 8;
    store.reshard = { ...store.reshard, state: 'flipped' };
    const r = standbyClaims(store);
    r.claims.start();
    const statements = await pollOnce(store);
    expect(statements.length).toBeGreaterThan(0);
    expect(transactional(statements)).toEqual([]);
    expect(store.reshard.state).toBe('flipped');
    expect(store.rows.has('4:0')).toBe(true);
    await r.claims.stopLanes();
  });

  it("reports the reshard's end once, for 'done' with meta W", async () => {
    fakeTimers();
    const store = standbyStore(4, 8);
    markDone(store, 8);
    const r = standbyClaims(store);
    r.claims.start();
    await pollOnce(store);
    await pollOnce(store);
    expect(r.done.count).toBe(1);
    await r.claims.stopLanes();
  });

  it("does not report the end for a 'stopping' attempt with meta W", async () => {
    fakeTimers();
    const store = standbyStore(4, 8);
    store.count = 8;
    store.reshard = { ...store.reshard, state: 'stopping' };
    const r = standbyClaims(store);
    r.claims.start();
    await pollOnce(store);
    expect(r.done.count).toBe(0);
    await r.claims.stopLanes();
  });

  it("does not report the end for 'done' while meta is not W", async () => {
    fakeTimers();
    const store = standbyStore(4, 8);
    store.reshard = { ...store.reshard, state: 'done' };
    const r = standbyClaims(store);
    r.claims.start();
    await pollOnce(store);
    expect(store.count).toBe(4);
    expect(r.done.count).toBe(0);
    await r.claims.stopLanes();
  });

  it("logs a failed report of the reshard's end", async () => {
    fakeTimers();
    const store = standbyStore(4, 8);
    markDone(store, 8);
    const r = standbyClaims(store, { onDone: () => { throw new Error('the serve did not start'); } });
    r.claims.start();
    await pollOnce(store);
    expect(r.lines).toContain('[Shards] Could not report the end of the reshard: the serve did not start');
    await r.claims.stopLanes();
  });
});

describe("re2 the move's renewal (NB5 C5 (c), E1)", () => {
  it('waits for the renewal on the wire before it sends', async () => {
    const store = plainStore();
    const r = build(store);
    const held = await bootTwo(r.claims);
    const before = store.renewals.length;
    store.renewMode = 'hang';
    const lane = r.claims.renewOnce();
    await flush();
    expect(store.renewals).toHaveLength(before + 1);
    const move = r.claims.moveRenewal();
    await flush();
    await flush();
    expect(store.renewals).toHaveLength(before + 1);
    store.renewMode = 'ok';
    store.releaseHung();
    await lane;
    const answer = await move;
    expect(store.renewals).toHaveLength(before + 2);
    expect(answer).toEqual({ returned: held, missing: [] });
  });

  it("is sent after a boot take's renewal that waited for the lane, even when called as the lane's renewal settles", async () => {
    const store = plainStore();
    store.nodes.set(ME.nodeId, {
      nodeId: ME.nodeId, nodeName: ME.nodeName, processId: 'p-re2-old', capacity: 4, takeoverSeconds: 30, fit: true,
      restartable: true, returns: false, seenAgoMs: 0, healthyForMs: null, seenAt: Date.now(), healthySince: null, countSetting: 5,
    });
    const clock = { t: 1_000 };
    const r = build(store, { clocks: () => ({ perf: clock.t, wall: clock.t }), countSetting: () => 8 });
    const sent: string[] = [];
    const renew = store.renew.bind(store);
    store.renew = ((request, opts) => {
      sent.push(opts?.move ? 'move' : `renewal of ${request.pairs.length}`);
      return renew(request, opts);
    }) as typeof store.renew;
    const take = store.take.bind(store);
    store.take = (async (request, onBegin) => {
      const answer = await take(request, onBegin);
      clock.t += T.deadlineMs + 1000;
      return answer;
    }) as typeof store.take;
    store.renewMode = 'hang';
    const lane = r.claims.renewOnce();
    const boot = r.claims.bootTake(async () => 2);
    await until(() => store.takes.length === 1);
    for (let i = 0; i < 3; i++) await flush();
    expect(sent).toEqual(['renewal of 0']);
    let move: Promise<{ returned: Pair[]; missing: Pair[] }> | null = null;
    r.armLog(() => { queueMicrotask(() => queueMicrotask(() => { move = r.claims.moveRenewal(); })); });
    store.renewMode = 'ok';
    store.releaseHung();
    await lane;
    const took = await boot;
    await until(() => move !== null);
    expect(move).not.toBeNull();
    const answer = await move!;
    expect(r.logged).toContain(l16Line(5, 8));
    expect(sent).toEqual(['renewal of 0', 'renewal of 2', 'move']);
    expect(took?.pairs).toHaveLength(2);
    expect(answer.returned).toEqual(took!.pairs);
  });

  it('lets a renewal asked for during it settle once it answered', async () => {
    const store = plainStore();
    const r = build(store);
    await bootTwo(r.claims);
    store.renewMode = 'hang';
    const move = r.claims.moveRenewal();
    await flush();
    const lane = r.claims.renewOnce();
    let settled = false;
    void lane.then(() => { settled = true; });
    store.renewMode = 'ok';
    store.releaseHung();
    await move;
    await until(() => settled, 20);
    expect(settled).toBe(true);
  });

  it("ends the heartbeat's first-statement edge, so a later setting change writes no target", async () => {
    const store = plainStore();
    store.nodes.set(ME.nodeId, {
      nodeId: ME.nodeId, nodeName: ME.nodeName, processId: 'p-re2-old', capacity: 4, takeoverSeconds: 30, fit: true,
      restartable: true, returns: false, seenAgoMs: 0, healthyForMs: null, seenAt: Date.now(), healthySince: null, countSetting: 5,
    });
    const setting = { value: 8 };
    const r = build(store, { countSetting: () => setting.value });
    await r.claims.moveRenewal();
    expect(store.renewals[0].heartbeat.targetEdge).toBe(true);
    expect(store.targetWrites).toEqual([{ processId: ME.processId, target: 8 }]);
    setting.value = 9;
    await r.claims.renewOnce();
    expect(store.renewals[1].heartbeat.targetEdge).toBe(false);
    expect(store.targetWrites).toEqual([{ processId: ME.processId, target: 8 }]);
  });

  it("names as missing a held pair whose row came back as another process's", async () => {
    const db = { now: 5_000_000 };
    const store = plainStore(db);
    const r = build(store);
    await r.claims.firstRenewal();
    const [a, b] = await bootTwo(r.claims);
    store.rows.get(`2:${a.shardId}`)!.holderProcess = 'p-other';
    db.now += 10_000;
    const answer = await r.claims.moveRenewal();
    expect(answer).toEqual({ returned: [b], missing: [a] });
  });

  it('counts the deadline from the send of the move renewal that returned the pairs', async () => {
    fakeTimers();
    const clock = { t: 10_000 };
    const store = plainStore();
    const r = build(store, { clocks: () => ({ perf: clock.t, wall: clock.t }) });
    await bootTwo(r.claims);
    clock.t += T.deadlineMs - 1000;
    const answer = await r.claims.moveRenewal();
    expect(answer.missing).toEqual([]);
    clock.t += 2000;
    expect(r.claims.stoppedServing()).toBe(false);
    expect(r.claims.snapshot().stopped).toBeNull();
    expect(r.stops.serving).toBe(0);
    clock.t += T.deadlineMs;
    expect(r.claims.stoppedServing()).toBe(true);
    expect(r.claims.snapshot().stopped).toBe('lapse');
  });

  it("a loss after the move says the shard was taken while this process could not renew it", async () => {
    const db = { now: 7_000_000 };
    const store = plainStore(db);
    const r = build(store);
    const [a] = await bootTwo(r.claims);
    db.now += 1000;
    const moved = await r.claims.moveRenewal();
    expect(moved.missing).toEqual([]);
    db.now += 1000;
    store.rows.set(`2:${a.shardId}`, {
      ...store.rows.get(`2:${a.shardId}`)!, claim: 500, holderProcess: 'p-other', holderNode: 'n-b', holderName: 'B', takenAt: db.now,
    });
    db.now += 1000;
    await r.claims.renewOnce();
    const line = `[Shards] Shard ${a.shardId}'s claim row holds claim 500 of B (process p-other), not this process's claim ${a.claim}; it was taken while this process could not renew it`;
    await until(() => r.lines.includes(line));
    expect(r.lines).toContain(line);
  });
});
