import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShardClaims, type ShardClaimsDeps } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { ClaimFailure, ClaimTimeoutError, classifyFailure } from '../../src/bot/internalSetup/fleet/claimStore';
import { MemClaimStore } from '../helpers/fakeClaimStore';

// NB4 decisions 5, 6, 12, 14 and 16: the renewal lane, the local deadline asked at the moment of use, the classes of
// a failed renewal, the loss, the reservation only while fit, and the release lines at the stop.

const T = claimTimings(30);
const skew = { perf: 0, wall: 0 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  skew.perf = 0;
  skew.wall = 0;
});

const pgError = (code: string, message = `failed with ${code}`) => Object.assign(new Error(message), { code });

function rig(over: Partial<ShardClaimsDeps> = {}, me = { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' }) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  const store = new MemClaimStore(() => Date.now());
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const calls = { stopStep: 0, lapsed: [] as number[], lost: [] as number[][], restarts: [] as string[] };
  const state = { fit: null as string | null, gateClosed: false, stopping: false };
  const claims = new ShardClaims({
    store,
    me,
    timings: T,
    capacity: 4,
    takeoverSeconds: 30,
    returns: true,
    restartable: true,
    startedAt: 0,
    clocks: () => ({ perf: performance.now() + skew.perf, wall: Date.now() + skew.wall }),
    fitness: () => state.fit,
    gateClosed: () => state.gateClosed,
    isStopping: () => state.stopping,
    stopServingStep: () => { calls.stopStep += 1; },
    noteLapsed: seconds => { calls.lapsed.push(seconds); },
    noteLost: lost => { calls.lost.push(lost.map(p => p.shardId)); },
    restartForShards: reason => { calls.restarts.push(reason); return true; },
    log,
    ...over,
  });
  const lines = () => [...log.log.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].map(c => String(c[0]));
  return { store, claims, calls, state, lines, log };
}

async function booted(r: ReturnType<typeof rig>, count = 2) {
  r.claims.start();
  expect(await r.claims.firstRenewal()).toBe(true);
  const taken = await r.claims.bootTake(async () => count);
  r.claims.noteGranted();
  return taken!;
}

describe('the local deadline', () => {
  it('lapses at D, counted from the take, and not 1 ms earlier; a renewal that never completes does not move it', async () => {
    const r = rig();
    await booted(r);
    r.store.renewMode = 'hang';
    await vi.advanceTimersByTimeAsync(T.deadlineMs - 1);
    expect(r.claims.stoppedServing()).toBe(false);
    expect(r.calls.stopStep).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.calls.stopStep).toBe(1);
    expect(r.claims.stoppedServing()).toBe(true);
    expect(r.calls.lapsed).toEqual([20]);
    expect(r.lines()).toContain('[Shards] No claim renewal for 20 s; every shard leaves Discord and the unsaved changes are kept until a renewal completes');
  });

  it('a completed renewal moves D to its send', async () => {
    const r = rig();
    await booted(r);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    r.store.renewMode = 'hang';
    await vi.advanceTimersByTimeAsync(T.deadlineMs - 1);
    expect(r.calls.stopStep).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.calls.stopStep).toBe(1);
  });

  it('a wall clock 2 minutes ahead with the monotonic one 1 s on lapses at the first question, before any timer, once', async () => {
    const r = rig();
    await booted(r);
    r.store.renewMode = 'hang';
    vi.advanceTimersByTime(0);
    skew.wall = 120_000;
    skew.perf = 1_000;
    expect(r.claims.stoppedServing()).toBe(true);
    expect(r.calls.stopStep).toBe(1);
    expect(r.claims.stoppedServing()).toBe(true);
    await vi.advanceTimersByTimeAsync(T.deadlineMs);
    expect(r.calls.stopStep).toBe(1);
    expect(r.calls.lapsed).toHaveLength(1);
  });

  it('no lapse at D while the latest failure is refused and the gate is closed; a lapse once the gate is open', async () => {
    const r = rig();
    await booted(r);
    r.store.renewMode = pgError('28000');
    r.state.gateClosed = true;
    await vi.advanceTimersByTimeAsync(T.deadlineMs + 3 * T.renewMs);
    expect(r.calls.stopStep).toBe(0);
    expect(r.claims.latestFailureClass()).toEqual({ kind: 'refused' });
    r.state.gateClosed = false;
    expect(r.claims.stoppedServing()).toBe(true);
    expect(r.calls.stopStep).toBe(1);
  });

  it('refused renewals with the gate open the whole time: the deadline timer lapses at D and not 1 ms earlier', async () => {
    const r = rig();
    await booted(r);
    r.store.renewMode = pgError('28000');
    await vi.advanceTimersByTimeAsync(T.deadlineMs - 1);
    expect(r.claims.latestFailureClass()).toEqual({ kind: 'refused' });
    expect(r.calls.stopStep).toBe(0);
    expect(r.calls.lapsed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.calls.stopStep).toBe(1);
    expect(r.calls.lapsed).toEqual([20]);
    expect(r.lines()).toContain('[Shards] No claim renewal for 20 s; every shard leaves Discord and the unsaved changes are kept until a renewal completes');
  });

  it.each([
    ['unreachable', new Error('connect ECONNREFUSED')],
    ['timeout', new ClaimTimeoutError('the claim renewal')],
  ])('the hook gate closed holds off no lapse for %s renewals', async (_name, error) => {
    const r = rig();
    await booted(r);
    r.state.gateClosed = true;
    r.store.renewMode = error;
    await vi.advanceTimersByTimeAsync(T.deadlineMs);
    expect(r.calls.stopStep).toBe(1);
  });

  it('refused followed by unreachable lapses at D under a closed gate', async () => {
    const r = rig();
    await booted(r);
    r.state.gateClosed = true;
    r.store.renewMode = pgError('28000');
    await vi.advanceTimersByTimeAsync(T.renewMs * 2);
    r.store.renewMode = new Error('read ECONNRESET');
    await vi.advanceTimersByTimeAsync(T.deadlineMs);
    expect(r.calls.stopStep).toBe(1);
  });

  it('a renewal that returns every pair after D renews them, and the process stays stopped', async () => {
    const r = rig();
    const taken = await booted(r);
    r.store.renewMode = 'hang';
    await vi.advanceTimersByTimeAsync(T.deadlineMs);
    expect(r.calls.stopStep).toBe(1);
    const before = taken.pairs.map(p => r.store.rows.get(`2:${p.shardId}`)!.expiresUpMs);
    r.store.renewMode = 'ok';
    r.store.releaseHung();
    await vi.advanceTimersByTimeAsync(T.renewMs);
    taken.pairs.forEach((p, i) => {
      const row = r.store.rows.get(`2:${p.shardId}`)!;
      expect(row.expiresUpMs).toBe(r.store.clock.upMs + T.ttlMs);
      expect(row.expiresUpMs).toBeGreaterThan(before[i]);
      expect(row.holderProcess).toBe('p-a');
      expect(row.released).toBe(false);
    });
    expect(r.store.renewals.at(-1)!.pairs.map(p => p.shardId).sort()).toEqual(taken.pairs.map(p => p.shardId).sort());
    expect(r.claims.snapshot().held.map(p => p.shardId).sort()).toEqual(taken.pairs.map(p => p.shardId).sort());
    expect(r.claims.stoppedServing()).toBe(true);
    expect(r.calls.lapsed).toHaveLength(1);
  });

  it('a lapse during the exit drain freezes every set and logs; the stop goes on', async () => {
    const r = rig();
    await booted(r);
    r.store.renewMode = 'hang';
    r.state.stopping = true;
    await vi.advanceTimersByTimeAsync(T.deadlineMs);
    expect(r.calls.stopStep).toBe(1);
    expect(r.calls.lapsed).toEqual([]);
    expect(r.lines()).toContain('[Shards] No claim renewal for 20 s during the exit drain; every guild set is frozen');
  });
});

describe('the classes of a failed renewal', () => {
  it.each([
    [pgError('28000'), { kind: 'refused' }],
    [new ClaimTimeoutError('the claim renewal'), { kind: 'timeout' }],
    [Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), { kind: 'unreachable', detail: 'read ECONNRESET' }],
    [new Error('connect ECONNREFUSED 127.0.0.1:5432'), { kind: 'unreachable', detail: 'connect ECONNREFUSED 127.0.0.1:5432' }],
    [pgError('25006', 'cannot execute UPDATE in a read-only transaction'), { kind: 'error', code: '25006', message: 'cannot execute UPDATE in a read-only transaction' }],
    [pgError('53100', 'could not extend file'), { kind: 'error', code: '53100', message: 'could not extend file' }],
  ])('%s', (error, expected) => {
    expect(classifyFailure(error)).toEqual(expected);
    expect(classifyFailure(new ClaimFailure(classifyFailure(error)))).toEqual(expected);
  });
});

describe('a loss', () => {
  it('a renewal that returns the same number of rows with one claim changed is a loss: the stop step and the leave run', async () => {
    const r = rig();
    const taken = await booted(r);
    const row = r.store.rows.get(`2:${taken.pairs[1].shardId}`)!;
    row.claim = 99;
    row.holderProcess = 'p-other';
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.calls.stopStep).toBe(1);
    expect(r.calls.lost).toEqual([[taken.pairs[1].shardId]]);
    expect(r.claims.stoppedServing()).toBe(true);
    expect(r.claims.heldPairs().map(p => p.shardId)).toEqual([taken.pairs[0].shardId]);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.lines()).toContain(`[Shards] Shard ${taken.pairs[1].shardId}'s claim row holds claim 99 of A (process p-other), not this process's claim ${taken.pairs[1].claim}`);
  });

  it.each([
    ['after the last renewal that returned the pair', 1, true],
    ['at the last renewal that returned the pair', 0, false],
    ['before the last renewal that returned the pair, as a restore raise writes it', -1, false],
  ])('a row taken %s: the "taken" clause compares with that renewal, not with the one that found the loss', async (_name, offset, clause) => {
    const r = rig();
    const taken = await booted(r);
    const ats: number[] = [];
    const renew = r.store.renew.bind(r.store);
    r.store.renew = async request => {
      const answer = await renew(request);
      ats.push(answer.at);
      return answer;
    };
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(ats).toHaveLength(1);
    expect(r.store.renewals.at(-1)!.pairs.map(p => p.shardId)).toEqual(taken.pairs.map(p => p.shardId));
    expect(r.calls.lost).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    const row = r.store.rows.get(`2:${taken.pairs[1].shardId}`)!;
    Object.assign(row, { claim: 99, holderProcess: 'p-other', takenAt: ats[0] + offset });
    await vi.advanceTimersByTimeAsync(T.renewMs - 1_000);
    expect(ats).toHaveLength(2);
    expect(ats[1]).toBeGreaterThan(row.takenAt);
    expect(r.calls.lost).toEqual([[taken.pairs[1].shardId]]);
    await vi.advanceTimersByTimeAsync(0);
    const line = `[Shards] Shard ${taken.pairs[1].shardId}'s claim row holds claim 99 of A (process p-other), not this process's claim ${taken.pairs[1].claim}`;
    expect(r.lines().filter(l => l.startsWith(`[Shards] Shard ${taken.pairs[1].shardId}'s claim row`))).toEqual([clause ? `${line}; it was taken while this process could not renew it` : line]);
  });

  it('a row returned released is a loss', async () => {
    const r = rig();
    const taken = await booted(r);
    r.store.rows.get(`2:${taken.pairs[0].shardId}`)!.released = true;
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.calls.lost).toEqual([[taken.pairs[0].shardId]]);
  });
});

describe('fitness gates the work lane', () => {
  it.each(['the data layer does not serve', 'maintenance mode maintenance', 'the maintenance gate is closed', 'leaving', 'a save is failing', 'the data backend is degraded'])(
    'unfit (%s): no reservation and no restart; fit again: the reservation and the request', async key => {
      const r = rig();
      await booted(r, 4);
      r.store.rows.get('4:3')!.released = false;
      const freed = r.store.rows.get('4:3')!;
      freed.holderProcess = 'p-dead';
      freed.holderNode = 'node-dead';
      freed.expiresUpMs = 0;
      r.claims['held'] = r.claims['held'].filter((p: { shardId: number }) => p.shardId !== 3);
      r.state.fit = key;
      const before = r.store.takes.length;
      await vi.advanceTimersByTimeAsync(T.renewMs * 2);
      expect(r.store.takes.length).toBe(before);
      expect(r.calls.restarts).toEqual([]);
      r.state.fit = null;
      await vi.advanceTimersByTimeAsync(T.renewMs);
      expect(r.store.takes.length).toBe(before + 1);
      expect(r.calls.restarts).toEqual(['take shard 3']);
    });

  it.each(['the data layer does not serve', 'maintenance mode maintenance', 'the maintenance gate is closed', 'leaving', 'a save is failing', 'the data backend is degraded'])(
    'unfit (%s) with a healthy home machine for a held shard: no return and no restart; fit again: the return and its request', async key => {
      const r = rig();
      await booted(r, 4);
      r.store.rows.get('4:1')!.homeNode = 'node-b';
      const b = {
        nodeId: 'node-b', nodeName: 'B', processId: 'p-b', capacity: 1, takeoverSeconds: 30, fit: true, restartable: true, returns: true,
        seenAgoMs: 0, healthyForMs: null, seenAt: Date.now(), healthySince: Date.now() - 301_000,
      };
      r.store.nodes.set('node-b', b);
      setInterval(() => { b.seenAt = Date.now(); }, 1_000);
      r.state.fit = key;
      await vi.advanceTimersByTimeAsync(T.renewMs * 2);
      expect(r.claims.snapshot().returning).toEqual([]);
      expect(r.calls.restarts).toEqual([]);
      r.state.fit = null;
      await vi.advanceTimersByTimeAsync(T.renewMs);
      expect(r.claims.snapshot().returning).toEqual([1]);
      expect(r.calls.restarts).toEqual(['return shard 1 to B']);
    });

  it('a reservation not followed by a restart request within TTL is given up and leaves the renewal', async () => {
    const r = rig({ restartForShards: () => false });
    await booted(r, 4);
    const freed = r.store.rows.get('4:3')!;
    Object.assign(freed, { holderProcess: 'p-dead', holderNode: 'node-dead', expiresUpMs: 0 });
    r.claims['held'] = r.claims['held'].filter((p: { shardId: number }) => p.shardId !== 3);
    await vi.advanceTimersByTimeAsync(T.renewMs * 2);
    expect(r.claims.snapshot().reserved.map(p => p.shardId)).toEqual([3]);
    r.state.fit = 'a save is failing';
    await vi.advanceTimersByTimeAsync(T.ttlMs);
    expect(r.claims.snapshot().reserved).toEqual([]);
    expect(r.lines().some(l => l.startsWith('[Shards] Gave up the reservation of shard 3: this process could not restart for') && l.endsWith('(a save is failing)'))).toBe(true);
    const last = r.store.renewals.at(-1)!;
    expect(last.pairs.map(p => p.shardId)).not.toContain(3);
  });
});

describe('the stop and its release', () => {
  it('releases the held pairs with the completed line and sends no renewal after it', async () => {
    const r = rig();
    await booted(r);
    r.claims.beginStop();
    await r.claims.finishStop();
    expect(r.store.releases).toHaveLength(1);
    expect(r.lines()).toContain("[Shards] Released shards 0, 1: kept for this machine's next start for 30 s, then free to any machine with room");
    const sent = r.store.renewals.length;
    await vi.advanceTimersByTimeAsync(T.renewMs * 3);
    expect(r.store.renewals.length).toBe(sent);
    expect(r.store.abandoned.work).toBe(1);
  });

  it('a reservation given up before the stop is not sent as reserved and is in no release line', async () => {
    const r = rig({ restartForShards: () => false });
    await booted(r, 4);
    const freed = r.store.rows.get('4:3')!;
    Object.assign(freed, { holderProcess: 'p-dead', holderNode: 'node-dead', expiresUpMs: 0 });
    r.claims['held'] = r.claims['held'].filter((p: { shardId: number }) => p.shardId !== 3);
    await vi.advanceTimersByTimeAsync(T.renewMs * 2);
    expect(r.claims.snapshot().reserved.map(p => p.shardId)).toEqual([3]);
    const reservedRow = structuredClone(r.store.rows.get('4:3')!);
    expect(reservedRow).toMatchObject({ holderProcess: 'p-a', released: true, reserved: true });
    r.state.fit = 'a save is failing';
    await vi.advanceTimersByTimeAsync(T.ttlMs);
    expect(r.lines().some(l => l.startsWith('[Shards] Gave up the reservation of shard 3:'))).toBe(true);
    const before = r.lines();
    r.claims.beginStop();
    await r.claims.finishStop();
    expect(r.store.releases).toHaveLength(1);
    expect(r.store.releases[0].reserved).toEqual([]);
    expect(r.lines().filter(l => !before.includes(l))).toEqual(["[Shards] Released shards 0, 1, 2: kept for this machine's next start for 30 s, then free to any machine with room"]);
    expect(r.lines().some(l => l.includes('Shard 3') || l.includes('shards 3'))).toBe(false);
    for (const id of [0, 1, 2]) expect(r.store.rows.get(`4:${id}`)).toMatchObject({ holderProcess: 'p-a', released: true });
    expect(r.store.rows.get('4:3')).toMatchObject({ holderProcess: 'p-a', released: true, reserved: true, claim: reservedRow.claim });
  });

  it('a reservation still live at the stop is sent as reserved, gets the "stay kept" line and is recorded as kept', async () => {
    const kept: unknown[][] = [];
    const r = rig({ restartForShards: () => false, noteKeptAtStop: (...args) => { kept.push(args); } });
    await booted(r, 4);
    const freed = r.store.rows.get('4:3')!;
    Object.assign(freed, { holderProcess: 'p-dead', holderNode: 'node-dead', expiresUpMs: 0 });
    r.claims['held'] = r.claims['held'].filter((p: { shardId: number }) => p.shardId !== 3);
    await vi.advanceTimersByTimeAsync(T.renewMs * 2 + 500);
    expect(r.claims.snapshot().reserved.map(p => p.shardId)).toEqual([3]);
    const reservedRow = structuredClone(r.store.rows.get('4:3')!);
    expect(reservedRow).toMatchObject({ holderProcess: 'p-a', released: true, reserved: true });
    const before = r.lines();
    r.claims.beginStop();
    await r.claims.finishStop();
    expect(r.store.releases).toHaveLength(1);
    expect(r.store.releases[0].reserved).toEqual([{ shardCount: 4, shardId: 3, claim: reservedRow.claim }]);
    expect(r.lines().filter(l => !before.includes(l))).toEqual([
      "[Shards] Released shards 0, 1, 2: kept for this machine's next start for 30 s, then free to any machine with room",
      "[Shards] Reserved shards 3 stay kept for this machine's next start for 30 s, then free to any machine with room",
    ]);
    expect(r.lines().some(l => l.includes('no longer held'))).toBe(false);
    const after = r.store.rows.get('4:3')!;
    expect(after).toMatchObject({ holderProcess: 'p-a', holderNode: 'node-a', released: true, reserved: false, claim: reservedRow.claim });
    expect(after.expiresUpMs).toBeGreaterThan(reservedRow.expiresUpMs);
    expect(kept).toEqual([[4, [0, 1, 2, 3], []]]);
  });

  it('a process that never sent a take sends no release and logs no line', async () => {
    const r = rig();
    r.claims.start();
    await r.claims.firstRenewal();
    await r.claims.finishStop();
    expect(r.store.releases).toHaveLength(0);
    expect(r.lines().filter(l => l.includes('Release') || l.includes('release'))).toEqual([]);
  });

  it('a renewal on the wire gets 2 s, then its connection is destroyed and the release runs', async () => {
    const r = rig();
    await booted(r);
    r.store.renewMode = 'hang';
    await vi.advanceTimersByTimeAsync(T.renewMs);
    const stop = r.claims.finishStop();
    await vi.advanceTimersByTimeAsync(1999);
    expect(r.store.releases).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await stop;
    expect(r.store.abandoned.renewal).toBe(1);
    expect(r.store.releases).toHaveLength(1);
  });

  it.each([
    ['a server error', pgError('55P03', 'canceling statement due to lock timeout'), false, "[Shards] Could not release shards 0, 1 (SQLSTATE 55P03 canceling statement due to lock timeout); any machine with room may take them once their claims expire"],
    ['a connect error', new Error('connect ECONNREFUSED'), true, "[Shards] Could not reach the database to release shards 0, 1 (unreachable); any machine with room may take them once their claims expire"],
    ['a connect timeout', new ClaimTimeoutError('the release'), true, "[Shards] Could not reach the database to release shards 0, 1 (timeout); any machine with room may take them once their claims expire"],
    ['a timeout during the lock wait', new ClaimTimeoutError('the release'), false, "[Shards] The release of shards 0, 1 got no answer before its COMMIT was sent (timeout), so it did not apply; any machine with room may take them once their claims expire"],
  ] as const)('%s logs its line', async (_name, error, unsent, line) => {
    const r = rig();
    await booted(r);
    r.store.releaseMode = error;
    r.store.releaseUnsent = unsent;
    await r.claims.finishStop();
    expect(r.lines()).toContain(line);
    expect(r.lines().some(l => l.includes('may still have applied'))).toBe(false);
    expect([...r.store.rows.values()].filter(row => row.holderProcess === 'p-a').map(row => row.released)).toEqual([false, false]);
  });

  it('a timeout after the release statement, with the COMMIT sent, logs the may-still-have-applied line', async () => {
    const r = rig();
    await booted(r);
    r.store.releaseMode = new ClaimTimeoutError('the release');
    r.store.releaseFailsAt = 'commit';
    await r.claims.finishStop();
    expect(r.lines()).toContain("[Shards] The release of shards 0, 1 got no answer within 2 s (timeout); it may still have applied, and otherwise any machine with room may take them once their claims expire");
    expect(r.lines().some(l => l.includes('before its COMMIT was sent'))).toBe(false);
  });

  it('the release reports the connection before the lock wait and the send only after the statement', async () => {
    const r = rig();
    await booted(r);
    const order: string[] = [];
    const real = r.store.release.bind(r.store);
    (r.store as any).release = (request: Parameters<typeof real>[0], onSent?: () => void, onConnected?: () => void) =>
      real(request, () => { order.push('sent'); onSent?.(); }, () => { order.push('connected'); onConnected?.(); });
    r.store.releaseMode = 'hang';
    const stop = r.claims.finishStop();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['connected']);
    expect(r.store.releases).toHaveLength(1);
    r.store.releaseMode = 'ok';
    r.store.releaseHung();
    await stop;
    expect(order).toEqual(['connected', 'sent']);
    expect([...r.store.rows.values()].filter(row => row.holderProcess === 'p-a').every(row => row.released)).toBe(true);
  });

  it('a boot take whose COMMIT came after the stop began: the release covers its rows and names them', async () => {
    const r = rig();
    r.claims.start();
    await r.claims.firstRenewal();
    r.store.takeMode = 'hang';
    const boot = r.claims.bootTake(async () => 2);
    await vi.advanceTimersByTimeAsync(0);
    r.state.stopping = true;
    r.store.takeMode = 'ok';
    r.store.releaseHung();
    expect(await boot).toBeNull();
    await r.claims.finishStop();
    expect(r.store.releases).toHaveLength(1);
    expect(r.lines()).toContain("[Shards] Released shards 0, 1: kept for this machine's next start for 30 s, then free to any machine with room");
  });

  it('a lock wait that times out with no pair asked logs that the release did not complete and that any row naming this process frees at its expiry', async () => {
    const r = rig();
    r.claims.start();
    await r.claims.firstRenewal();
    r.store.takeMode = new Error('connection ended');
    r.state.stopping = false;
    const boot = r.claims.bootTake(async () => 2);
    await vi.advanceTimersByTimeAsync(0);
    r.state.stopping = true;
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(await boot).toBeNull();
    r.store.releaseMode = pgError('55P03', 'canceling statement due to lock timeout');
    await r.claims.finishStop();
    expect(r.lines().filter(l => l.startsWith('[Shards] The release') || l.startsWith('[Shards] Could not'))).toEqual(['[Shards] The release did not complete (error: SQLSTATE 55P03 canceling statement due to lock timeout); any shard row still naming this process frees once its claim expires']);
    expect(r.lines().some(l => l.includes('held no shard'))).toBe(false);
  });
});

describe('the deadline counts from the send (T8)', () => {
  it('a renewal sent at R and answered 4 s later moves D to R + D, not to R + 4 s + D', async () => {
    const r = rig();
    await booted(r);
    r.store.renewMode = 'hang';
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.store.renewals).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4000);
    r.store.releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(T.deadlineMs - 4000 - 1);
    expect(r.calls.stopStep).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.calls.stopStep).toBe(1);
  });
});

describe('hung lanes under the client bounds (T9)', () => {
  it('a hung renewal times out at R, its connection counts as destroyed and later ticks send new ones', async () => {
    const r = rig();
    await booted(r);
    r.store.bounds = { renewMs: T.renewMs, workMs: 2 * T.renewMs };
    r.store.renewMode = 'hang';
    const before = r.store.renewals.length;
    await vi.advanceTimersByTimeAsync(T.renewMs * 6);
    expect(r.store.abandoned.renewal).toBeGreaterThanOrEqual(2);
    expect(r.store.renewals.length - before).toBeGreaterThanOrEqual(3);
    expect(r.claims.latestFailureClass()).toEqual({ kind: 'timeout' });
  });

  it('a page read that never answers: renewals go on every R, and the read is abandoned at 2R and sent again', async () => {
    const r = rig();
    await booted(r);
    r.store.bounds = { renewMs: T.renewMs, workMs: 2 * T.renewMs };
    await vi.advanceTimersByTimeAsync(T.renewMs);
    r.store.readMode = 'hang';
    const renewalsBefore = r.store.renewals.length;
    const readsBefore = r.store.reads;
    await vi.advanceTimersByTimeAsync(T.renewMs * 6);
    expect(r.store.renewals.length - renewalsBefore).toBe(6);
    expect(r.store.abandoned.work).toBeGreaterThanOrEqual(2);
    expect(r.store.reads - readsBefore).toBeGreaterThanOrEqual(2);
    expect(r.calls.stopStep).toBe(0);
  });

  it('a reservation that never answers: renewals go on every R and the work lane runs again after 2R', async () => {
    const r = rig();
    await booted(r, 4);
    r.store.bounds = { renewMs: T.renewMs, workMs: 2 * T.renewMs };
    const freed = r.store.rows.get('4:3')!;
    Object.assign(freed, { holderProcess: 'p-dead', holderNode: 'node-dead', expiresUpMs: 0 });
    r.claims['held'] = r.claims['held'].filter((p: { shardId: number }) => p.shardId !== 3);
    r.store.takeMode = 'hang';
    const renewalsBefore = r.store.renewals.length;
    const takesBefore = r.store.takes.length;
    await vi.advanceTimersByTimeAsync(T.renewMs * 6);
    expect(r.store.renewals.length - renewalsBefore).toBe(6);
    expect(r.store.takes.length - takesBefore).toBeGreaterThanOrEqual(2);
    expect(r.store.abandoned.work).toBeGreaterThanOrEqual(1);
    expect(r.calls.stopStep).toBe(0);
  });

  it('a boot take that never answers is retried after 2R', async () => {
    const r = rig();
    r.claims.start();
    await r.claims.firstRenewal();
    r.store.bounds = { renewMs: T.renewMs, workMs: 2 * T.renewMs };
    r.store.takeMode = 'hang';
    const boot = r.claims.bootTake(async () => 2);
    await vi.advanceTimersByTimeAsync(2 * T.renewMs - 1);
    expect(r.store.takes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(T.renewMs + 1);
    expect(r.store.takes).toHaveLength(2);
    expect(r.lines()).toContain(`[Shards] Cannot take shards yet: the take failed (timeout); retrying every ${T.renewMs / 1000} s`);
    r.store.takeMode = 'ok';
    r.store.releaseHung();
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect((await boot)!.pairs.map(p => p.shardId)).toEqual([0, 1]);
  });
});

describe('each lane single-flight, with no client bounds (NB4-R8-T3)', () => {
  it('a renewal still on the wire: later ticks send no second one, and the next tick after its answer sends exactly one', async () => {
    const r = rig();
    await booted(r);
    r.store.renewMode = 'hang';
    const before = r.store.renewals.length;
    await vi.advanceTimersByTimeAsync(3 * T.renewMs);
    expect(r.store.renewals.length - before).toBe(1);
    r.store.releaseHung();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.renewals.length - before).toBe(1);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.store.renewals.length - before).toBe(2);
    expect(r.calls.stopStep).toBe(0);
  });

  it('a page read still on the wire: completed renewals queue no work cycle behind it', async () => {
    const r = rig();
    await booted(r);
    r.store.readMode = 'hang';
    const renewalsBefore = r.store.renewals.length;
    const readsBefore = r.store.reads;
    await vi.advanceTimersByTimeAsync(4 * T.renewMs);
    expect(r.store.renewals.length - renewalsBefore).toBe(4);
    expect(r.store.reads - readsBefore).toBe(1);
    r.store.readMode = 'ok';
    r.store.releaseHung();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.reads - readsBefore).toBe(1);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.store.reads - readsBefore).toBe(2);
  });
});

describe('a renewal judged by the pairs it carried (NB4-DL-1, NB4-RUN-1)', () => {
  it('a renewal on the wire across the boot take is no loss, and the next renewal carries the taken pairs', async () => {
    const r = rig();
    r.claims.start();
    await r.claims.firstRenewal();
    r.store.renewMode = 'hang';
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.store.renewals.at(-1)!.pairs).toEqual([]);
    const taken = await r.claims.bootTake(async () => 2);
    expect(taken!.pairs).toHaveLength(2);
    r.store.renewMode = 'ok';
    r.store.releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.calls.lost).toEqual([]);
    expect(r.calls.stopStep).toBe(0);
    r.claims.noteGranted();
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.store.renewals.at(-1)!.pairs.map(p => p.shardId)).toEqual([0, 1]);
    expect(r.calls.lost).toEqual([]);
    expect(r.lines().filter(l => l.includes("not this process's claim"))).toEqual([]);
  });

  it('a reservation committed while a renewal is on the wire is no loss', async () => {
    const r = rig();
    await booted(r, 4);
    const freed = r.store.rows.get('4:3')!;
    Object.assign(freed, { holderProcess: 'p-dead', holderNode: 'node-dead', expiresUpMs: 0 });
    r.claims['held'] = r.claims['held'].filter((p: { shardId: number }) => p.shardId !== 3);
    r.store.takeMode = 'hang';
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.store.takes.at(-1)!.reserve).toBe(true);
    r.store.renewMode = 'hang';
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.store.renewals.at(-1)!.pairs.map(p => p.shardId)).not.toContain(3);
    r.store.takeMode = 'ok';
    r.store.releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.claims.snapshot().reserved.map(p => p.shardId)).toEqual([3]);
    r.store.renewMode = 'ok';
    r.store.releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.calls.lost).toEqual([]);
    expect(r.calls.stopStep).toBe(0);
    expect(r.claims.snapshot().reserved.map(p => p.shardId)).toEqual([3]);
  });
});

describe('a loss found during the exit drain (NB4-DL-2)', () => {
  it('freezes, starts no leave and asks no restart; the release names the shard as no longer held', async () => {
    const r = rig();
    const taken = await booted(r);
    r.state.stopping = true;
    r.claims.beginStop();
    const lostShard = taken.pairs[1].shardId;
    Object.assign(r.store.rows.get(`2:${lostShard}`)!, { claim: 99, holderProcess: 'p-other' });
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.calls.stopStep).toBe(1);
    expect(r.calls.lost).toEqual([]);
    expect(r.calls.restarts).toEqual([]);
    await r.claims.finishStop();
    expect(r.lines()).toContain(`[Shards] Shard ${lostShard} was no longer held by this process at the release`);
  });
});

describe('a restart that waits (NB4-DL-3, NB4-RUN-4)', () => {
  it('a reservation whose request is held back shows the wait, not a restart; a lapse clears it', async () => {
    const r = rig({ restartForShards: () => false });
    await booted(r, 4);
    const freed = r.store.rows.get('4:3')!;
    Object.assign(freed, { holderProcess: 'p-dead', holderNode: 'node-dead', expiresUpMs: 0 });
    r.claims['held'] = r.claims['held'].filter((p: { shardId: number }) => p.shardId !== 3);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    r.state.fit = 'a save is failing';
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.claims.snapshot()).toMatchObject({ pendingRestart: 'take shard 3', restartWaiting: 'a save is failing' });
    r.store.renewMode = 'hang';
    await vi.advanceTimersByTimeAsync(T.deadlineMs);
    expect(r.calls.stopStep).toBe(1);
    expect(r.claims.snapshot()).toMatchObject({ pendingRestart: null, restartWaiting: null });
  });
});
