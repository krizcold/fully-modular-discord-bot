import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ShardClaims, heldLines, l16Line, l17Line, redrawHeldLines, type ShardClaimsDeps,
} from '../../src/bot/internalSetup/fleet/shardClaims';
import type { HeldRow } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings, type ClaimRow, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import { MemClaimStore } from '../helpers/fakeClaimStore';

const heldLinesFor = (n: number, rows: HeldRow[]) => heldLines(n, rows, claimTimings(30).renewMs);

// NB9 test 25, the redraw's rows (29, 56, 59, 67, D5): ShardClaims.redraw against the claims fake, whose redraw runs
// the take gate over the rows a standby's take leaves (live, unreleased, holder this process).

const T = claimTimings(30);
const ME = { processId: 'p-s', nodeId: 'n-a', nodeName: 'A' };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function standbyRow(shardId: number, claim: number, over: Partial<ClaimRow> = {}): ClaimRow {
  return {
    shardCount: 4, shardId, claim, holderProcess: ME.processId, holderNode: ME.nodeId, holderName: ME.nodeName, homeNode: ME.nodeId,
    released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: T.ttlMs, expiresUpMs: 30_000, extended: false, ...over,
  };
}

function rig() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  const store = new MemClaimStore(() => Date.now());
  store.count = 4;
  store.reshard = { attempt: 'a', state: 'done', fromCount: 2, toCount: 4 };
  store.rows.set('4:0', standbyRow(0, 7));
  store.rows.set('4:1', standbyRow(1, 8));
  const outcomes = { stopSteps: 0, lost: [] as Pair[][], lapsed: [] as number[] };
  const lines: string[] = [];
  const log = { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
  const deps: ShardClaimsDeps = {
    store, me: ME, timings: T, capacity: 4, takeoverSeconds: 30, returns: true, restartable: true, startedAt: 0,
    fitness: () => null, gateClosed: () => false, isStopping: () => false,
    stopServingStep: () => { outcomes.stopSteps += 1; },
    noteLapsed: seconds => { outcomes.lapsed.push(seconds); },
    noteLost: lost => { outcomes.lost.push(lost); },
    restartForShards: () => true, log,
  };
  const claims = new ShardClaims(deps);
  const taken = { count: 4, processId: ME.processId, pairs: [{ shardCount: 4, shardId: 0, claim: 7 }, { shardCount: 4, shardId: 1, claim: 8 }] };
  return { store, claims, outcomes, lines, taken };
}

describe('ShardClaims.redraw (29, 59, D5)', () => {
  it('redraws every pair of taken above every stamp and holds them under W', async () => {
    const { store, claims, taken, outcomes } = rig();
    store.guildFloor = 20;
    const answer = await claims.redraw(taken);
    expect(answer?.lost).toEqual([]);
    expect(answer?.pairs.map(p => p.shardId)).toEqual([0, 1]);
    for (const p of answer!.pairs) expect(p.claim).toBeGreaterThan(20);
    expect(claims.heldPairs()).toEqual(answer!.pairs);
    expect(store.rows.get('4:0')?.claim).toBe(answer!.pairs[0].claim);
    expect(outcomes.stopSteps).toBe(0);
  });

  it('a pair whose row was released is not returned and is named lost for the step after the grant', async () => {
    const { store, claims, taken, outcomes } = rig();
    store.rows.set('4:1', standbyRow(1, 8, { released: true }));
    const answer = await claims.redraw(taken);
    expect(answer?.pairs.map(p => p.shardId)).toEqual([0]);
    expect(answer?.lost).toEqual([taken.pairs[1]]);
    expect(outcomes.lost).toEqual([]);
  });

  it('refused held: L32 redraw form, then NB4\'s loss for every pair of taken', async () => {
    const { store, claims, taken, outcomes, lines } = rig();
    store.rows.set('2:3', { ...standbyRow(3, 2), shardCount: 2, holderProcess: 'p-old', holderName: 'B', holderNode: 'n-b' });
    const answer = await claims.redraw(taken);
    expect(answer).toEqual({ shardCount: 4, pairs: [], lost: [] });
    expect(lines).toEqual(expect.arrayContaining(redrawHeldLines([{ shardCount: 2, shardId: 3, holderName: 'B' }])));
    expect(outcomes.stopSteps).toBe(1);
    expect(outcomes.lost).toEqual([taken.pairs]);
    expect(store.rows.get('4:0')?.claim).toBe(7);
  });

  it('refused count (meta absent, D9): the loss with no L32 line', async () => {
    const { store, claims, taken, outcomes, lines } = rig();
    store.count = null;
    const answer = await claims.redraw(taken);
    expect(answer?.pairs).toEqual([]);
    expect(outcomes.lost).toEqual([taken.pairs]);
    expect(lines.some(l => l.includes('Not serving the new shards'))).toBe(false);
  });

  it('a failed statement is retried every R until D, then the lapse; the loss step never runs', async () => {
    const { store, claims, taken, outcomes } = rig();
    store.takeMode = new Error('canceling statement due to lock timeout');
    const run = claims.redraw(taken);
    await vi.advanceTimersByTimeAsync(T.deadlineMs + 2 * T.renewMs);
    expect(await run).toBeNull();
    expect(store.redraws.length).toBeGreaterThan(1);
    expect(outcomes.lapsed).toHaveLength(1);
    expect(outcomes.stopSteps).toBe(1);
    expect(outcomes.lost).toEqual([]);
  });

  it('a redraw of no shard sends nothing', async () => {
    const { store, claims } = rig();
    expect(await claims.redraw({ count: 4, processId: ME.processId, pairs: [] })).toEqual({ shardCount: 4, pairs: [], lost: [] });
    expect(store.redraws).toEqual([]);
  });

  it('a taken process id other than this process\'s is a build error', async () => {
    const { claims } = rig();
    await expect(claims.redraw({ count: 4, processId: 'p-other', pairs: [] })).rejects.toThrow();
  });
});

// NB9 test 25, the boot, running and re-take rows (56, 57, 67, 69, 74, 77): ShardClaims against the claims fake,
// whose take, re-take and page read run NB9's gate and read over rows written as NB4's take and release leave them.

const BOOT = { processId: 'p-b', nodeId: 'n-b', nodeName: 'B' };
const FAR = 10_000_000;

function liveRow(shardCount: number, shardId: number, holder: string, over: Partial<ClaimRow> = {}): ClaimRow {
  return {
    shardCount, shardId, claim: 100 + shardCount * 10 + shardId, holderProcess: `p-${holder}`, holderNode: `n-${holder}`,
    holderName: holder.toUpperCase(), homeNode: `n-${holder}`, released: false, reserved: false, takenAt: 0, renewedAt: 0,
    ttlMs: T.ttlMs, expiresUpMs: FAR, extended: false, ...over,
  };
}

/** A row NB4's release left: released and kept for its machine until its expiry. */
const keptRow = (shardCount: number, shardId: number, holder: string) => liveRow(shardCount, shardId, holder, { released: true });

function bootRig(opts: { setting?: number | null; capacity?: number } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.setSystemTime(Date.UTC(2026, 10, 7, 12));
  const store = new MemClaimStore(() => Date.now());
  const lines: string[] = [];
  const log = { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
  const outcomes = { stopSteps: 0, lost: [] as Pair[][] };
  const deps: ShardClaimsDeps = {
    store, me: BOOT, timings: T, capacity: opts.capacity ?? 4, takeoverSeconds: 30, returns: false, restartable: true, startedAt: 0,
    fitness: () => null, gateClosed: () => false, isStopping: () => false,
    stopServingStep: () => { outcomes.stopSteps += 1; },
    noteLapsed: () => undefined,
    noteLost: lost => { outcomes.lost.push(lost); },
    restartForShards: () => true, log, countSetting: () => opts.setting ?? null,
  };
  const claims = new ShardClaims(deps);
  return { store, claims, lines, outcomes };
}

/** Runs one change of the store right before the n-th take reaches it, as another machine's COMMIT between two reads. */
function beforeTake(store: MemClaimStore, n: number, change: () => void): void {
  const take = store.take.bind(store);
  let sent = 0;
  store.take = (request, onBegin) => {
    sent += 1;
    if (sent === n) change();
    return take(request, onBegin);
  };
}

const notTaking = (lines: string[]) => lines.filter(l => l.startsWith('[Shards] Not taking shards'));

describe('test 25: the boot take refused (56, 57, 69, 74, 77)', () => {
  it('held: L32 once per count waited on, a try every R, a new line when the count waited on changes; every try is a boot take', async () => {
    const { store, claims, lines } = bootRig();
    store.count = 4;
    store.rows.set('2:0', liveRow(2, 0, 'm2'));
    const run = claims.bootTake(async () => 4);
    await vi.advanceTimersByTimeAsync(3 * T.renewMs);
    expect(store.takes.length).toBeGreaterThanOrEqual(3);
    expect(notTaking(lines)).toEqual(heldLinesFor(4, [{ shardCount: 2, shardId: 0, holderName: 'M2' }]));
    store.rows.delete('2:0');
    store.rows.set('6:1', liveRow(6, 1, 'm3'));
    await vi.advanceTimersByTimeAsync(3 * T.renewMs);
    expect(notTaking(lines)).toHaveLength(2);
    expect(notTaking(lines)[1]).toContain('of the 6-shard set are still held by M3');
    store.rows.delete('6:1');
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect((await run)?.shardCount).toBe(4);
    expect(store.takes.every(t => t.boot === true)).toBe(true);
  });

  it("held in 'flipped' toward this boot's count: L13 once and no L32", async () => {
    const { store, claims, lines } = bootRig();
    store.count = 8;
    store.reshard = { attempt: 'a', state: 'flipped', fromCount: 4, toCount: 8 };
    store.rows.set('4:0', liveRow(4, 0, 'm1'));
    void claims.bootTake(async () => 8);
    await vi.advanceTimersByTimeAsync(3 * T.renewMs);
    expect(lines.filter(l => l.includes('The bot is switching to 8 shards'))).toEqual([
      '[Shards] The bot is switching to 8 shards: this process takes shards once the 4 old ones are released (still held by M1)',
    ]);
    expect(notTaking(lines)).toEqual([]);
  });

  it("a failed gate statement (40P01): a try after R with NB4's take-error line, no L32", async () => {
    const { store, claims, lines } = bootRig();
    store.count = 4;
    store.takeMode = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    void claims.bootTake(async () => 4);
    await vi.advanceTimersByTimeAsync(2 * T.renewMs);
    expect(store.takes.length).toBeGreaterThanOrEqual(2);
    expect(lines.filter(l => l.includes('the take failed (error: SQLSTATE 40P01 deadlock detected)'))).toHaveLength(1);
    expect(notTaking(lines)).toEqual([]);
  });

  it("77: the page read shows no attempt and meta 4 = W, the gate reads 'stopping' 4 -> 8: no line, nothing taken, then 12's change logged with L14", async () => {
    const { store, claims, lines } = bootRig();
    store.count = 4;
    store.rows.set('4:0', liveRow(4, 0, 'm2'));
    beforeTake(store, 1, () => { store.reshard = { attempt: 'a', state: 'stopping', fromCount: 4, toCount: 8 }; });
    void claims.bootTake(async () => 4);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.takes).toHaveLength(1);
    expect(store.takes[0]).toMatchObject({ boot: true, localCount: 4 });
    expect(store.takes[0].writesMeta).toBeUndefined();
    expect(lines).toEqual([]);
    expect([...store.rows.values()].filter(r => r.holderProcess === BOOT.processId)).toEqual([]);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(store.takes[1]).toMatchObject({ boot: true, localCount: 8, writesMeta: { kind: 'change', attempt: 'a' } });
    expect(lines).toEqual(['[Shards] Resharding to 8 shards: this process takes shards once every machine has stopped its 4 old ones (still held by M2)']);
  });
});

describe("test 25: the count-writing takes and the boot's page read (74)", () => {
  /** Meta 4 with every row of 4 released by NB4's release, and the target 8 another machine's heartbeat wrote. */
  function stopped(store: MemClaimStore) {
    store.count = 4;
    store.reshard = { attempt: null, state: null, fromCount: null, toCount: null, target: 8, targetBy: 'M2', targetAt: Date.UTC(2026, 10, 6, 9) };
    for (let s = 0; s < 4; s++) store.rows.set(`4:${s}`, keptRow(4, s, s < 2 ? 'b' : 'm2'));
  }

  it("the page read shows no live row of the stored count: the first try is 13's direct change toward W", async () => {
    const { store, claims } = bootRig();
    stopped(store);
    const got = await claims.bootTake(async () => 8);
    expect(store.reads).toBe(1);
    expect(store.takes[0]).toMatchObject({ boot: true, localCount: 8, writesMeta: { kind: 'direct', from: 4 } });
    expect(got?.shardCount).toBe(8);
    expect(store.count).toBe(8);
  });

  it("refused 'count' (another machine changed the count first): no line, nothing written; the next try is NB4's boot take under meta, with L17 for this machine's setting", async () => {
    const { store, claims, lines } = bootRig({ setting: 6 });
    stopped(store);
    beforeTake(store, 1, () => {
      store.count = 8;
      store.reshard = { ...store.reshard, attempt: 'z', state: 'done', fromCount: 4, toCount: 8 };
      for (let s = 0; s < 4; s++) store.rows.delete(`4:${s}`);
    });
    const run = claims.bootTake(async () => 6);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.takes[0].writesMeta).toEqual({ kind: 'direct', from: 4 });
    expect(lines).toEqual([]);
    expect([...store.rows.values()]).toEqual([]);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    const got = await run;
    expect(store.takes[1].writesMeta).toBeUndefined();
    expect(got?.shardCount).toBe(8);
    expect(lines.filter(l => l.includes('FLEET_SHARD_COUNT'))).toEqual([l17Line(6, 8, { machine: 'M2', date: '2026-11-06' })]);
    expect(lines.filter(l => !l.includes('above this machine'))).toHaveLength(1);
  });

  it("13 refused 'held' by a row of the stored count: no L32, and the next try is NB4's boot take under the stored count", async () => {
    const { store, claims, lines } = bootRig();
    stopped(store);
    beforeTake(store, 1, () => { store.rows.set('4:2', liveRow(4, 2, 'm2')); });
    const run = claims.bootTake(async () => 8);
    await vi.advanceTimersByTimeAsync(T.renewMs + 1);
    const got = await run;
    expect(store.takes[0].writesMeta).toEqual({ kind: 'direct', from: 4 });
    expect(store.takes[1].writesMeta).toBeUndefined();
    expect(got?.shardCount).toBe(4);
    expect(store.count).toBe(4);
    expect(notTaking(lines)).toEqual([]);
  });

  it("13 refused 'held' by rows of other counts only: L32's take form once per wait", async () => {
    const { store, claims, lines } = bootRig();
    stopped(store);
    store.rows.set('2:1', liveRow(2, 1, 'm3'));
    void claims.bootTake(async () => 8);
    await vi.advanceTimersByTimeAsync(3 * T.renewMs);
    expect(store.takes.length).toBeGreaterThanOrEqual(3);
    expect(store.takes.every(t => t.writesMeta?.kind === 'direct')).toBe(true);
    expect(notTaking(lines)).toEqual(heldLinesFor(8, [{ shardCount: 2, shardId: 1, holderName: 'M3' }]));
  });

  it('a failed page read: the boot takes as NB4 does, under meta', async () => {
    const { store, claims } = bootRig();
    stopped(store);
    store.readMode = new Error('connection refused');
    const got = await claims.bootTake(async () => 8);
    expect(store.takes[0].writesMeta).toBeUndefined();
    expect(got?.shardCount).toBe(4);
  });

  it('no L17 when this machine\'s setting is the wanted count, nor with no setting', async () => {
    for (const setting of [8, null]) {
      const { store, claims, lines } = bootRig({ setting });
      store.count = 8;
      store.reshard = { attempt: null, state: null, fromCount: null, toCount: null, target: 8, targetBy: 'M2', targetAt: 0 };
      expect((await claims.bootTake(async () => 8))?.shardCount).toBe(8);
      expect(lines.filter(l => l.includes('FLEET_SHARD_COUNT'))).toEqual([]);
      vi.useRealTimers();
    }
  });

  it("L17 from Discord's recommendation when no target is stored", async () => {
    const { store, claims, lines } = bootRig({ setting: 2 });
    store.count = 4;
    store.rows.set('4:0', liveRow(4, 0, 'm2'));
    expect((await claims.bootTake(async () => 2))?.shardCount).toBe(4);
    expect(lines).toEqual([l17Line(2, 4, null)]);
  });
});

/** Boots this process under 4 holding shards 0 and 1 (2 and 3 held by M2), then grants. */
async function runningUnderFour(r: ReturnType<typeof bootRig>) {
  r.store.count = 4;
  r.store.rows.set('4:2', liveRow(4, 2, 'm2'));
  r.store.rows.set('4:3', liveRow(4, 3, 'm2'));
  const got = await r.claims.bootTake(async () => 4);
  expect(got?.pairs.map(p => p.shardId)).toEqual([0, 1]);
  r.claims.noteGranted();
  // M2's rows expire: the next page read shows them takeable.
  for (const s of [2, 3]) r.store.rows.get(`4:${s}`)!.expiresUpMs = -1;
}

const runningTakes = (store: MemClaimStore) => store.takes.filter(t => !t.boot);

describe('test 25: the running take refused (69, C1)', () => {
  it("'held': L32's take form once per wait, nothing reserved, and the next tick tries again", async () => {
    const r = bootRig();
    await runningUnderFour(r);
    r.store.rows.set('6:0', liveRow(6, 0, 'm3'));
    await r.claims.renewOnce();
    await vi.advanceTimersByTimeAsync(0);
    await r.claims.renewOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(runningTakes(r.store)).toHaveLength(2);
    expect(runningTakes(r.store)[0]).toMatchObject({ boot: false, localCount: 4, reserve: true });
    expect(notTaking(r.lines)).toEqual(heldLinesFor(4, [{ shardCount: 6, shardId: 0, holderName: 'M3' }]));
    expect(r.claims.snapshot().reserved).toEqual([]);
  });

  it("'count' (a change committed after the page read): no line, nothing reserved", async () => {
    const r = bootRig();
    await runningUnderFour(r);
    const read = r.store.readPage.bind(r.store);
    r.store.readPage = async () => {
      const page = await read();
      r.store.count = 8;
      return page;
    };
    await r.claims.renewOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(runningTakes(r.store)).toHaveLength(1);
    expect(r.lines).toEqual([]);
    expect(r.claims.snapshot().reserved).toEqual([]);
    expect(r.store.count).toBe(8);
  });

  it('a failed gate statement: nothing reserved, no line, and the next tick tries again', async () => {
    const r = bootRig();
    await runningUnderFour(r);
    r.store.takeMode = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    await r.claims.renewOnce();
    await vi.advanceTimersByTimeAsync(0);
    await r.claims.renewOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(runningTakes(r.store)).toHaveLength(2);
    expect(r.lines).toEqual([]);
    expect(r.claims.snapshot().reserved).toEqual([]);
  });
});

describe("test 25: NB5's re-take through the gate (58, 67, D9)", () => {
  /** This process holds shards 0 to 3 of 4; the move's target lost shard 1's row, so the re-take asks for it. */
  async function moving(r: ReturnType<typeof bootRig>) {
    r.store.count = 4;
    const got = await r.claims.bootTake(async () => 4);
    expect(got?.pairs).toHaveLength(4);
    r.claims.noteGranted();
    r.claims.stopServingForDatabase('the database moved');
    r.store.rows.delete('4:1');
  }
  const target = { address: 'db2', generation: 0 };

  it("'held': the latch stays, no loss step, L32's re-take form once, and the next pass runs again", async () => {
    const r = bootRig();
    await moving(r);
    r.store.rows.set('2:0', liveRow(2, 0, 'm3'));
    expect(await r.claims.moveClaims(target)).toBe(false);
    expect(await r.claims.moveClaims(target)).toBe(false);
    expect(r.store.retakes).toHaveLength(2);
    expect(r.outcomes.lost).toEqual([]);
    expect(r.claims.databaseStopWhy()).toBe('the database moved');
    expect(r.lines.filter(l => l.startsWith('[Database] Not taking shard(s) 1 of the 4-shard set again on db2 yet'))).toHaveLength(1);
  });

  it("'count' (meta absent on the target, D9): NB4's loss for the pair, no L32", async () => {
    const r = bootRig();
    await moving(r);
    r.store.count = null;
    expect(await r.claims.moveClaims(target)).toBe(true);
    expect(r.outcomes.lost).toEqual([[{ shardCount: 4, shardId: 1, claim: expect.any(Number) }]]);
    expect(r.store.rows.has('4:1')).toBe(false);
    expect(r.lines.some(l => l.includes('Not taking shard(s)'))).toBe(false);
  });

  it('a failed gate statement: the latch stays, no loss step, no L32', async () => {
    const r = bootRig();
    await moving(r);
    r.store.retakeFailsAt = 'statement';
    r.store.retakeMode = Object.assign(new Error('deadlock detected'), { code: '40P01', severity: 'ERROR' });
    expect(await r.claims.moveClaims(target)).toBe(false);
    expect(r.outcomes.lost).toEqual([]);
    expect(r.lines.some(l => l.includes('Not taking shard(s)'))).toBe(false);
    expect(r.lines.some(l => l.includes('the re-take of shard 1 failed there'))).toBe(true);
  });

  it('passed: the pair is taken again under a new claim', async () => {
    const r = bootRig();
    await moving(r);
    expect(await r.claims.moveClaims(target)).toBe(true);
    expect(r.outcomes.lost).toEqual([]);
    expect(r.store.rows.get('4:1')?.holderProcess).toBe(BOOT.processId);
  });
});

describe('the heartbeat columns and the target edge (31, 37, 52)', () => {
  const priorNode = (countSetting: number | null) => ({
    nodeId: 'n-b', nodeName: 'B', processId: 'p-old', capacity: 4, takeoverSeconds: 30, fit: true, restartable: true, returns: false,
    seenAgoMs: 0, healthyForMs: null, seenAt: 0, healthySince: null, countSetting,
  });

  it('each heartbeat carries the setting, FLEET_RESHARD_OVERLAP and the reading; the edge stays until a heartbeat completed', async () => {
    const r = bootRig();
    const memory = { room: true, freeMb: 900, useMb: 300, error: null, ageMs: 2000 };
    const claims = new ShardClaims({
      store: r.store, me: BOOT, timings: T, capacity: 4, takeoverSeconds: 30, returns: false, restartable: true, startedAt: 0,
      fitness: () => null, gateClosed: () => false, isStopping: () => false, stopServingStep: () => undefined,
      noteLapsed: () => undefined, noteLost: () => undefined, restartForShards: () => true,
      countSetting: () => 6, reshardOverlap: () => false, memoryReading: () => memory,
      log: { log: () => undefined, warn: () => undefined, error: () => undefined },
    });
    r.store.renewMode = new Error('connection refused');
    await claims.renewOnce();
    r.store.renewMode = 'ok';
    await claims.renewOnce();
    await claims.renewOnce();
    expect(r.store.renewals.map(x => x.heartbeat.targetEdge)).toEqual([true, true, false]);
    expect(r.store.renewals[2].heartbeat).toMatchObject({ countSetting: 6, reshardOverlap: false, memory });
  });

  it('a lost reply leaves the edge, and the retry finds its own value: one target write, no L16 for the lost one', async () => {
    const r = bootRig({ setting: 8 });
    r.store.nodes.set('n-b', priorNode(4));
    r.store.renewFailsAt = 'reply';
    r.store.renewMode = new Error('Connection terminated');
    await r.claims.renewOnce();
    r.store.renewMode = 'ok';
    await r.claims.renewOnce();
    expect(r.store.renewals.map(x => x.heartbeat.targetEdge)).toEqual([true, true]);
    expect(r.store.targetWrites).toEqual([{ processId: 'p-b', target: 8 }]);
    expect(r.store.reshard).toMatchObject({ target: 8, targetBy: 'B' });
    expect(r.lines).toEqual([]);
  });

  it('L16 when the first heartbeat wrote the target', async () => {
    const r = bootRig({ setting: null });
    r.store.nodes.set('n-b', priorNode(4));
    await r.claims.renewOnce();
    await r.claims.renewOnce();
    expect(r.store.targetWrites).toEqual([{ processId: 'p-b', target: null }]);
    expect(r.lines).toEqual([l16Line(4, null)]);
  });

  it('a first heartbeat from a machine with no row writes no target', async () => {
    const r = bootRig({ setting: 8 });
    await r.claims.renewOnce();
    expect(r.store.targetWrites).toEqual([]);
    expect(r.store.nodes.get('n-b')?.countSetting).toBe(8);
  });
});

describe('4 and 31: the first take carries FLEET_SHARD_COUNT and writes the target', () => {
  it('on an empty database the boot take sends the setting, and the target holds it after the COMMIT', async () => {
    const { store, claims } = bootRig({ setting: 6 });
    expect((await claims.bootTake(async () => 6))?.shardCount).toBe(6);
    expect(store.takes[0]).toMatchObject({ localCount: 6, countSetting: 6 });
    expect(store.reshard).toMatchObject({ target: 6, targetBy: 'B' });
  });

  it('with meta stored, no target is written', async () => {
    const { store, claims } = bootRig({ setting: 6 });
    store.count = 4;
    store.rows.set('4:0', liveRow(4, 0, 'm2'));
    await claims.bootTake(async () => 6);
    expect(store.reshard.target ?? null).toBeNull();
  });
});
