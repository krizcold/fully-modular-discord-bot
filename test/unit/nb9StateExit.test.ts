import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShardClaims, l14Line, l15Line, type ShardClaimsDeps } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings, type ClaimRow, type Me, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import { MemClaimStore } from '../helpers/fakeClaimStore';

// NB9 test 3, the cells that drive only takes (part 2): O2 C5, S1 C4, S3 C1, S0 C6 and S4 C1's take side. Each row
// runs ShardClaims against the claims fake, whose take, re-take and page read run NB9's gate over rows written as
// NB4's take and release, a standby's take and 12's spread leave them; each asserts the next phase (meta and the
// attempt), which process holds which rows, and the lines logged.

const T = claimTimings(30);
const FAR = 10_000_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function row(shardCount: number, shardId: number, holder: { processId: string; nodeId: string; nodeName: string }, over: Partial<ClaimRow> = {}): ClaimRow {
  return {
    shardCount, shardId, claim: 100 + shardCount * 10 + shardId, holderProcess: holder.processId, holderNode: holder.nodeId,
    holderName: holder.nodeName, homeNode: holder.nodeId, released: false, reserved: false, takenAt: 0, renewedAt: 0,
    ttlMs: T.ttlMs, expiresUpMs: FAR, extended: false, ...over,
  };
}

const M = (name: string, processId = `p-${name}`): Me => ({ processId, nodeId: `n-${name}`, nodeName: name.toUpperCase() });

function machine(store: MemClaimStore, me: Me) {
  const lines: string[] = [];
  const log = { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
  const outcomes = { lost: [] as Pair[][] };
  const deps: ShardClaimsDeps = {
    store, me, timings: T, capacity: 4, takeoverSeconds: 30, returns: false, restartable: true, startedAt: 0,
    fitness: () => null, gateClosed: () => false, isStopping: () => false, stopServingStep: () => undefined,
    noteLapsed: () => undefined, noteLost: lost => { outcomes.lost.push(lost); }, restartForShards: () => true, log,
    countSetting: () => null,
  };
  return { claims: new ShardClaims(deps), lines, outcomes };
}

function fakeStore() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  return new MemClaimStore(() => Date.now());
}

function beforeTake(store: MemClaimStore, n: number, change: () => void): void {
  const take = store.take.bind(store);
  let sent = 0;
  store.take = (request, onBegin) => {
    sent += 1;
    if (sent === n) change();
    return take(request, onBegin);
  };
}

const rowsOf = (store: MemClaimStore, count: number) => [...store.rows.values()].filter(r => r.shardCount === count).sort((a, b) => a.shardId - b.shardId);

describe('test 3: cells that drive only takes (C1, 74, 77, D9)', () => {
  it("O2 C5: a restarting machine's boot take with a third local count takes under meta N, writes no meta and deletes no standby row", async () => {
    const store = fakeStore();
    const A = M('a');
    const standby = M('a', 'p-standby');
    store.count = 4;
    store.reshard = { attempt: 'r', state: 'standby', fromCount: 4, toCount: 8 };
    for (let s = 0; s < 4; s++) store.rows.set(`4:${s}`, row(4, s, M('a', 'p-a-old'), { released: true }));
    for (let s = 0; s < 8; s++) store.rows.set(`8:${s}`, row(8, s, standby));
    const before = rowsOf(store, 8).map(r => ({ ...r }));
    const { claims, lines } = machine(store, A);
    const got = await claims.bootTake(async () => 6);
    expect(store.takes.map(t => ({ boot: t.boot, localCount: t.localCount, writesMeta: t.writesMeta }))).toEqual([{ boot: true, localCount: 6, writesMeta: undefined }]);
    expect(got?.shardCount).toBe(4);
    expect(got?.pairs.map(p => p.shardId)).toEqual([0, 1, 2, 3]);
    expect(store.count).toBe(4);
    expect(store.reshard.state).toBe('standby');
    expect(rowsOf(store, 8)).toEqual(before);
    expect(lines).toEqual([]);
  });

  it("S1 C4: the start commits after the boot's page read: the take is refused 'count' with nothing held; its next try is 12, waiting with L14, then the change with L15", async () => {
    const store = fakeStore();
    const B = M('b');
    const A = M('a');
    store.count = 4;
    store.rows.set('4:0', row(4, 0, A));
    beforeTake(store, 1, () => { store.reshard = { attempt: 'r', state: 'stopping', fromCount: 4, toCount: 8 }; });
    const { claims, lines } = machine(store, B);
    const run = claims.bootTake(async () => 4);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.takes).toHaveLength(1);
    expect([...store.rows.values()].some(r => r.holderProcess === B.processId)).toBe(false);
    expect(lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(store.takes[1].writesMeta).toEqual({ kind: 'change', attempt: 'r' });
    expect(lines).toEqual([l14Line(8, 4, [{ shardCount: 4, shardId: 0, holderName: 'A' }])]);
    store.rows.get('4:0')!.released = true;
    await vi.advanceTimersByTimeAsync(T.renewMs);
    const got = await run;
    expect(got?.shardCount).toBe(8);
    expect(store.count).toBe(8);
    expect(store.reshard.state).toBe('done');
    expect(lines[1]).toBe(l15Line(4, 8, [0, 1, 2, 3, 4, 5, 6, 7], []));
  });

  it("S3 C1: a waiting boot's count change reads 'done' and is refused 'count'; its next try takes the spread row kept for it", async () => {
    const store = fakeStore();
    const B = M('b');
    store.count = 4;
    store.reshard = { attempt: 'r', state: 'stopping', fromCount: 4, toCount: 8 };
    store.rows.set('4:0', row(4, 0, M('a'), { released: true }));
    beforeTake(store, 1, () => {
      // Machine A's change committed first: meta 8, the attempt done, and shards 4 to 7 spread to B, released and kept.
      store.count = 8;
      store.reshard = { ...store.reshard, state: 'done' };
      store.rows.delete('4:0');
      for (let s = 0; s < 8; s++) {
        store.rows.set(`8:${s}`, s < 4 ? row(8, s, M('a')) : row(8, s, { processId: 'spread:r', nodeId: B.nodeId, nodeName: 'B' }, { released: true }));
      }
    });
    const { claims, lines } = machine(store, B);
    const run = claims.bootTake(async () => 8);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.takes[0].writesMeta).toEqual({ kind: 'change', attempt: 'r' });
    expect(rowsOf(store, 8).filter(r => r.shardId >= 4).every(r => r.holderProcess === 'spread:r')).toBe(true);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    const got = await run;
    expect(store.takes[1]).toMatchObject({ boot: true });
    expect(store.takes[1].writesMeta).toBeUndefined();
    expect(got?.shardCount).toBe(8);
    expect(got?.pairs.map(p => p.shardId)).toEqual([4, 5, 6, 7]);
    expect(store.count).toBe(8);
    expect(lines).toEqual([]);
  });

  it('S0 C6: every statement fails while 13 waits, then the copy shows a change another machine made: the next try takes the branch that read gives', async () => {
    const store = fakeStore();
    const B = M('b');
    store.count = 4;
    store.reshard = { attempt: null, state: null, fromCount: null, toCount: null, target: 8, targetBy: 'A', targetAt: 0 };
    for (let s = 0; s < 4; s++) store.rows.set(`4:${s}`, row(4, s, M('a'), { released: true }));
    store.takeMode = Object.assign(new Error('Connection terminated unexpectedly'), {});
    const { claims, lines } = machine(store, B);
    const run = claims.bootTake(async () => 8);
    await vi.advanceTimersByTimeAsync(3 * T.renewMs);
    expect(store.takes.length).toBeGreaterThanOrEqual(3);
    expect(store.takes.every(t => t.writesMeta?.kind === 'direct')).toBe(true);
    expect(lines.filter(l => l.includes('the take failed'))).toHaveLength(1);
    expect(store.count).toBe(4);
    // The switch: the new main shows A's direct change to 8 committed, its rows released and kept for A.
    store.count = 8;
    store.reshard = { ...store.reshard, attempt: 'd', state: 'done', fromCount: 4, toCount: 8 };
    store.rows.clear();
    for (let s = 0; s < 8; s++) store.rows.set(`8:${s}`, row(8, s, M('a'), { released: s >= 4, holderNode: s >= 4 ? B.nodeId : 'n-a', holderName: s >= 4 ? 'B' : 'A', holderProcess: s >= 4 ? 'spread:d' : 'p-a' }));
    store.takeMode = 'ok';
    await vi.advanceTimersByTimeAsync(2 * T.renewMs);
    const got = await run;
    const last = store.takes[store.takes.length - 1];
    expect(last.writesMeta).toBeUndefined();
    expect(got?.shardCount).toBe(8);
    expect(got?.pairs.map(p => p.shardId)).toEqual([4, 5, 6, 7]);
  });

  it("S0 C6: the copy's tail lost this machine's first take: NB5's re-take is refused 'count' (D9), NB4's loss runs, and the restart boots by 74 on the new main's read", async () => {
    const store = fakeStore();
    const B = M('b');
    const first = machine(store, B);
    const took = await first.claims.bootTake(async () => 4);
    expect(took?.shardCount).toBe(4);
    expect(store.count).toBe(4);
    first.claims.noteGranted();
    first.claims.stopServingForDatabase('the database moved');
    store.count = null;
    store.rows.clear();
    expect(await first.claims.moveClaims({ address: 'db2', generation: 0 })).toBe(true);
    expect(store.retakes).toHaveLength(1);
    expect(first.outcomes.lost.flat().map(p => p.shardId)).toEqual([0, 1, 2, 3]);
    expect(store.rows.size).toBe(0);
    expect(store.count).toBeNull();
    const restart = machine(store, M('b', 'p-b2'));
    const again = await restart.claims.bootTake(async () => 6);
    expect(store.takes[store.takes.length - 1]).toMatchObject({ boot: true, localCount: 6 });
    expect(again?.shardCount).toBe(6);
    expect(store.count).toBe(6);
  });

  it("S4 C1: a process of the old count with no row sends no running take while the page shows another count, and a take a change raced is refused 'count'; meta W and the spread rows stay", async () => {
    const store = fakeStore();
    const B = M('b');
    const A = M('a');
    store.count = 4;
    for (let s = 0; s < 4; s++) store.rows.set(`4:${s}`, row(4, s, A));
    const { claims, lines } = machine(store, B);
    const got = await claims.bootTake(async () => 4);
    expect(got?.pairs).toEqual([]);
    claims.noteGranted();
    // 12's change committed: meta 8, the rows of 4 gone, the spread rows released and kept for A.
    store.count = 8;
    store.reshard = { attempt: 'r', state: 'done', fromCount: 4, toCount: 8 };
    store.rows.clear();
    for (let s = 0; s < 8; s++) store.rows.set(`8:${s}`, row(8, s, { processId: 'spread:r', nodeId: A.nodeId, nodeName: 'A' }, { released: true, expiresUpMs: -1 }));
    const spreadRows = rowsOf(store, 8).map(r => ({ ...r }));
    await claims.renewOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.takes.filter(t => !t.boot)).toEqual([]);
    // The race: the page read still shows 4 (the change commits right after it).
    store.count = 4;
    for (let s = 0; s < 4; s++) store.rows.set(`4:${s}`, row(4, s, A, { expiresUpMs: -1 }));
    const read = store.readPage.bind(store);
    store.readPage = async () => {
      const page = await read();
      store.count = 8;
      for (let s = 0; s < 4; s++) store.rows.delete(`4:${s}`);
      return page;
    };
    await claims.renewOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.takes.filter(t => !t.boot)).toHaveLength(1);
    expect(store.count).toBe(8);
    expect(rowsOf(store, 8)).toEqual(spreadRows);
    expect(claims.snapshot().reserved).toEqual([]);
    expect(lines).toEqual([]);
  });
});

// Part 3: the cells that drive the standby's lanes (7, 27, 45, 61). The standby is ShardClaims in standby mode over the
// claims fake, whose standby take, standby renewal and work-lane client answer as the real statements; the attempt is
// written as decision 6's start leaves it, the old rows as NB4's take leaves them, the old machine's row by its heartbeat.

const AT = 'a1b2c3d4-0000-4000-8000-000000000001';

function oldMachine(store: MemClaimStore, n: number) {
  const A = M('a');
  store.count = n;
  for (let s = 0; s < n; s++) store.rows.set(`${n}:${s}`, row(n, s, A));
  store.nodes.set(A.nodeId, {
    nodeId: A.nodeId, nodeName: A.nodeName, processId: A.processId, capacity: 8, takeoverSeconds: 30, fit: true,
    restartable: true, returns: false, seenAgoMs: 0, healthyForMs: null, seenAt: Date.now(), healthySince: Date.now(),
  });
  return A;
}

function standbyMachine(store: MemClaimStore, w: number) {
  const S = M('a', 'p-standby');
  const lines: string[] = [];
  const log = { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
  const ends: unknown[] = [];
  const done: number[] = [];
  const progress: Array<[number, number]> = [];
  const deps: ShardClaimsDeps = {
    store, me: S, timings: T, capacity: 8, takeoverSeconds: 30, returns: false, restartable: true, startedAt: 0,
    fitness: () => null, gateClosed: () => false, isStopping: () => false, stopServingStep: () => undefined,
    noteLapsed: () => undefined, noteLost: () => undefined, restartForShards: () => true, log, countSetting: () => null,
    standby: { attempt: AT, count: w, onEnd: end => { ends.push(end); }, onDone: () => { done.push(Date.now()); }, onProgress: (h, r) => { progress.push([h, r]); } },
  };
  return { claims: new ShardClaims(deps), lines, ends, done, progress, S };
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

async function standbyRunning(store: MemClaimStore, w = 8) {
  const m = standbyMachine(store, w);
  await m.claims.firstRenewal();
  await m.claims.standbyTake();
  return m;
}

describe('test 3: cells that drive the standby lanes (part 3)', () => {
  it('O2 C1 and O3 C1: the take writes ready false and logs L5; each renewal writes ready; L6 once all are ready', async () => {
    const store = fakeStore();
    oldMachine(store, 4);
    store.startAttempt(AT, 4, 8);
    const { claims, lines, progress } = standbyMachine(store, 8);
    expect(await claims.firstRenewal()).toBe(true);
    const took = await claims.standbyTake();
    expect(took?.count).toBe(8);
    expect(took?.pairs.map(p => p.shardId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(rowsOf(store, 8).map(r => r.holderProcess)).toEqual(Array(8).fill('p-standby'));
    expect([...store.ready.values()]).toEqual(Array(8).fill(false));
    expect(lines).toEqual(['[Shards] Standby for the reshard to 8 shards: took shard(s) 0, 1, 2, 3, 4, 5, 6, 7; connecting them to Discord']);
    claims.start();
    for (let s = 0; s < 8; s++) claims.setReady(s, true);
    claims.setReady(3, false);
    claims.setReady(3, true);
    await tick(T.renewMs);
    expect(store.standbyRenewals.at(-1)?.pairs.map(p => p.ready)).toEqual(Array(8).fill(true));
    expect([...store.ready.values()]).toEqual(Array(8).fill(true));
    expect(lines.filter(l => l.includes('are connected; waiting'))).toEqual(['[Shards] Standby: all 8 new shard(s) of this process are connected; waiting for the other machines']);
    expect(progress.at(-1)).toEqual([8, 8]);
    expect(store.renewals).toEqual([]);
    await claims.stopLanes();
  });

  it("O2 C2: a failed take is retried every R with NB4's take line", async () => {
    const store = fakeStore();
    oldMachine(store, 4);
    store.startAttempt(AT, 4, 8);
    const { claims, lines } = standbyMachine(store, 8);
    await claims.firstRenewal();
    store.takeMode = new Error('boom');
    const took = claims.standbyTake();
    await tick(1);
    store.takeMode = 'ok';
    await tick(T.renewMs);
    expect((await took)?.pairs).toHaveLength(8);
    expect(store.standbyTakes).toHaveLength(2);
    expect(lines[0]).toBe(`[Shards] Cannot take shards yet: the take failed (unreachable); retrying every ${T.renewMs / 1000} s`);
  });

  it('O1 C8 and O2 C8: a take after the call-off takes nothing and ends the standby with the stored reason', async () => {
    const store = fakeStore();
    oldMachine(store, 4);
    store.startAttempt(AT, 4, 8);
    store.reshard = { ...store.reshard, state: 'cancelled' };
    store.attemptRow = { ...store.attemptRow, reason: 'A is not healthy' };
    const { claims, ends } = standbyMachine(store, 8);
    await claims.firstRenewal();
    expect(await claims.standbyTake()).toBeNull();
    expect(rowsOf(store, 8)).toEqual([]);
    expect(ends).toEqual([{ kind: 'called-off', reason: 'A is not healthy' }]);
  });

  it('O2 C8: the poll reads the attempt called off and ends the standby once; a replaced attempt names no reason, and the count of the new attempt (E7)', async () => {
    const store = fakeStore();
    oldMachine(store, 4);
    store.startAttempt(AT, 4, 8);
    const { claims, ends } = await standbyRunning(store);
    claims.start();
    await tick(1000);
    expect(ends).toEqual([]);
    store.reshard = { ...store.reshard, state: 'cancelled' };
    store.attemptRow = { ...store.attemptRow, reason: 'A is not healthy' };
    await tick(3000);
    expect(ends).toEqual([{ kind: 'called-off', reason: 'A is not healthy' }]);
    await claims.stopLanes();

    const other = new MemClaimStore(() => Date.now());
    oldMachine(other, 4);
    other.startAttempt(AT, 4, 8);
    const second = await standbyRunning(other);
    second.claims.start();
    other.startAttempt('a1b2c3d4-0000-4000-8000-000000000002', 4, 8);
    await tick(1000);
    expect(second.ends).toEqual([{ kind: 'called-off', reason: null, replacedBy: 8 }]);
    await second.claims.stopLanes();
  });

  it("O2 C6: renewals that fail until D end the standby with L22's lapse cause", async () => {
    const store = fakeStore();
    oldMachine(store, 4);
    store.startAttempt(AT, 4, 8);
    const { claims, ends, lines } = await standbyRunning(store);
    claims.start();
    store.renewMode = new Error('down');
    await tick(T.deadlineMs + T.renewMs);
    expect(ends).toEqual([{ kind: 'failed', cause: `no claim renewal for ${T.deadlineMs / 1000} s` }]);
    expect(lines.filter(l => l.includes('every shard leaves Discord'))).toEqual([]);
    await claims.stopLanes();
  });

  it("O2 C6: a renewal that does not return a pair ends the standby with L22's loss cause", async () => {
    const store = fakeStore();
    oldMachine(store, 4);
    store.startAttempt(AT, 4, 8);
    const { claims, ends } = await standbyRunning(store);
    claims.start();
    store.rows.get('8:5')!.holderProcess = 'p-other';
    await tick(T.renewMs);
    expect(ends).toEqual([{ kind: 'failed', cause: "shard 5's claim is no longer this process's" }]);
    await claims.stopLanes();
  });

  it('O3 C3: at until_at the poll calls the attempt off (L11 with the next try), failures + 1, and ends the standby', async () => {
    const store = fakeStore();
    vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
    oldMachine(store, 4);
    store.startAttempt(AT, 4, 8, 60_000);
    const { claims, ends, lines } = await standbyRunning(store);
    claims.start();
    await tick(61_000);
    expect(store.reshard.state).toBe('cancelled');
    expect(store.attemptRow.failures).toBe(1);
    const reason = 'not all 8 new shards were connected within 1 min (0 were)';
    expect(store.attemptRow.reason).toBe(reason);
    expect(lines.filter(l => l.startsWith('[Shards] Called off'))).toEqual([
      `[Shards] Called off the reshard to 8 shards: ${reason}; the bot keeps 4 shards; the next try is after 2026-11-07 12:16 UTC`,
    ]);
    expect(ends).toEqual([{ kind: 'called-off', reason }]);
    await claims.stopLanes();
  });

  it('O4 C1: with every new shard ready and the old machine fit, the poll flips (meta W, L7)', async () => {
    const store = fakeStore();
    oldMachine(store, 4);
    store.startAttempt(AT, 4, 8);
    const { claims, lines, ends } = await standbyRunning(store);
    claims.start();
    for (let s = 0; s < 8; s++) claims.setReady(s, true);
    await tick(T.renewMs);
    await tick(1000);
    expect(store.count).toBe(8);
    expect(store.reshard.state).toBe('flipped');
    expect(lines).toContain('[Shards] All 8 new shards are connected: switched the bot to 8 shards; the 4 old shards save what they hold and stop, then the new ones serve');
    expect(ends).toEqual([]);
    await claims.stopLanes();
  });

  it('O7 C1 (45): with the old rows released, the poll closes (L9, the old rows deleted), then reads done and reports it once', async () => {
    const store = fakeStore();
    oldMachine(store, 4);
    store.startAttempt(AT, 4, 8);
    const { claims, lines, done } = await standbyRunning(store);
    store.count = 8;
    store.reshard = { ...store.reshard, state: 'flipped' };
    for (const r of rowsOf(store, 4)) r.released = true;
    claims.start();
    await tick(1000);
    expect(store.reshard.state).toBe('done');
    expect(rowsOf(store, 4)).toEqual([]);
    expect(lines).toContain("[Shards] The 4 old shards are released; each machine's new shards serve once its old bot process has stopped");
    await tick(3000);
    expect(done).toHaveLength(1);
    await claims.stopLanes();
  });

  it('45: stopLanes ends the poll and the renewals; the release at the stop still covers every row of the take', async () => {
    const store = fakeStore();
    oldMachine(store, 4);
    store.startAttempt(AT, 4, 8);
    const { claims } = await standbyRunning(store);
    claims.start();
    await tick(2000);
    await claims.stopLanes();
    const renewals = store.standbyRenewals.length;
    const polls = store.workStatements.length;
    await tick(30_000);
    expect(store.standbyRenewals).toHaveLength(renewals);
    expect(store.workStatements).toHaveLength(polls);
    await claims.finishStop();
    expect(rowsOf(store, 8).every(r => r.released && r.holderNode === 'n-a')).toBe(true);
  });

  it('14: a serving process reserves and returns nothing while an attempt is open', async () => {
    const store = fakeStore();
    const B = M('b');
    store.count = 4;
    store.startAttempt(AT, 4, 8);
    store.rows.set('4:0', row(4, 0, M('a')));
    store.rows.set('4:1', row(4, 1, M('a')));
    const { claims } = machine(store, B);
    await claims.firstRenewal();
    expect((await claims.bootTake(async () => 4))?.pairs.map(p => p.shardId)).toEqual([2, 3]);
    claims.noteGranted();
    Object.assign(store.rows.get('4:1')!, { released: true, homeNode: 'n-x', expiresUpMs: 0 });
    const takes = store.takes.length;
    const reads = store.reads;
    await claims.renewOnce();
    await tick(10);
    expect(store.reads).toBeGreaterThan(reads);
    expect(store.takes).toHaveLength(takes);
    expect(claims.snapshot().reserved).toEqual([]);
  });
});
