import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ShardClaims,
  lossLine,
  releaseFailureLine,
  releaseLines,
} from '../../src/bot/internalSetup/fleet/shardClaims';
import { pairKey, type ClaimTimings, type NodeRow, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import type {
  ClaimStoreApi,
  PageRead,
  PageRow,
  ReleaseRequest,
  ReleasedRow,
  RenewRequest,
  TakeAnswer,
  TakeRequest,
} from '../../src/bot/internalSetup/fleet/claimStore';

// NB4 decisions 10, 11, 12, 15 and 16 over a scripted claims store: the reservation a running process sends, the
// restart reason it asks with, the reservations it gives up, the stop and the release.

const ME = { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' };
const T: ClaimTimings = { ttlMs: 30_000, renewMs: 5000, deadlineMs: 20_000, statementMs: 1500, lockMs: 750 };

function row(count: number, shardId: number, over: Partial<PageRow> = {}): PageRow {
  return {
    shardCount: count, shardId, claim: 1, holderProcess: ME.processId, holderNode: ME.nodeId, holderName: 'A',
    homeNode: ME.nodeId, released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000,
    expiresUpMs: 1e12, extended: false, renewedAgoMs: 0, ...over,
  };
}

function nodeB(over: Partial<NodeRow> = {}): NodeRow {
  return {
    nodeId: 'node-b', nodeName: 'B', processId: 'p-b', capacity: 4, takeoverSeconds: 30, fit: true, restartable: true,
    returns: true, seenAgoMs: 0, healthyForMs: 600_000, ...over,
  };
}

function page(rows: PageRow[], nodes: NodeRow[] = [], shardCount: number | null = 4): PageRead {
  return { shardCount, upMs: 1000, uPrimeMs: 1000, rows, nodes };
}

const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve));
};

interface RigOpts {
  boot: number[];
  count?: number;
  capacity?: number;
  returns?: boolean;
  restartable?: boolean;
  restart?: (reason: string) => boolean;
  /** Shards the first reservation take answers with. */
  reserve?: number[];
  onReserveTake?: (onBegin?: () => void) => void;
  release?: (req: ReleaseRequest) => Promise<ReleasedRow[]>;
  noteKeptAtStop?: () => void;
}

async function rig(o: RigOpts) {
  const count = o.count ?? 4;
  const clock = { now: 1_000_000 };
  const lines: string[] = [];
  const fmt = (a: unknown[]) => a.map(x => (x instanceof Error ? x.message : String(x))).join(' ');
  const log = {
    log: (...a: unknown[]) => { lines.push(fmt(a)); },
    warn: (...a: unknown[]) => { lines.push(fmt(a)); },
    error: (...a: unknown[]) => { lines.push(fmt(a)); },
  };
  const reservedKeys = new Set<string>();
  const lostKeys = new Set<string>();
  const pages: Array<PageRead | Error> = [];
  let lastPage: PageRead | Error = page([]);
  const calls = {
    takes: [] as TakeRequest[],
    renews: [] as RenewRequest[],
    releases: [] as ReleaseRequest[],
    restart: [] as string[],
    order: [] as string[],
    abandonRenewal: 0,
    stopStep: 0,
    noteLost: [] as Pair[][],
    noteLostAtStop: [] as Pair[][],
  };
  const gate: { wait: Promise<void> | null; open: () => void } = { wait: null, open: () => undefined };
  const holdRenewal = () => {
    gate.wait = new Promise<void>(resolve => { gate.open = () => { gate.wait = null; resolve(); }; });
  };
  let reserveLeft = o.reserve ?? [];
  const plan = { takes: [], wait: null, heldElsewhere: 0, elsewhere: [], waitingForOwner: 0, leftToOthers: 0 };
  const done = (ids: number[]): TakeAnswer => ({
    kind: 'done', shardCount: count, taken: ids.map(id => ({ pair: { shardCount: count, shardId: id, claim: 1 }, above: null })),
    plan, adopted: null, predecessorRenewedAt: new Map(),
  });
  const store: ClaimStoreApi = {
    async renew(req) {
      calls.renews.push(req);
      calls.order.push('renew');
      const g = gate.wait;
      if (g) await g;
      return {
        rows: req.pairs.map(p => ({ ...p, mine: !lostKeys.has(pairKey(p)), released: reservedKeys.has(pairKey(p)) })),
        at: clock.now,
        priorProcess: ME.processId,
      };
    },
    async take(req, onBegin) {
      calls.takes.push(req);
      if (req.boot) { onBegin?.(); return done(o.boot); }
      if (o.onReserveTake) o.onReserveTake(onBegin);
      else onBegin?.();
      const ids = reserveLeft;
      reserveLeft = [];
      for (const id of ids) reservedKeys.add(pairKey({ shardCount: count, shardId: id, claim: 1 }));
      return done(ids);
    },
    pause() { /* no NB4 path pauses */ },
    resume() { /* no NB4 path resumes */ },
    async retake() { throw new Error('NB4 never re-takes'); },
    async release(req, onSent, onConnected) {
      calls.releases.push(req);
      calls.order.push('release');
      onConnected?.();
      onSent?.();
      if (o.release) return o.release(req);
      return o.boot.map(id => ({ shardId: id, claim: 1, wasReserved: false, handedTo: null }));
    },
    async readPage() {
      const next = pages.length > 0 ? pages.shift()! : lastPage;
      lastPage = next;
      if (next instanceof Error) throw next;
      return next;
    },
    async readRow() { return { row: null, storedCount: count }; },
    abandonWork() { /* no query on the wire in these tests */ },
    abandonRenewal() { calls.abandonRenewal += 1; },
    async end() { /* nothing to close */ },
  };
  const claims: ShardClaims = new ShardClaims({
    store, me: ME, timings: T, capacity: o.capacity ?? 4, takeoverSeconds: 30, returns: o.returns ?? false,
    restartable: o.restartable ?? true, startedAt: 0, clocks: () => ({ perf: clock.now, wall: clock.now }),
    fitness: () => null, gateClosed: () => false, isStopping: () => false,
    stopServingStep: () => { calls.stopStep += 1; },
    noteLapsed: () => undefined,
    noteLost: lost => { calls.noteLost.push(lost); },
    noteLostAtStop: lost => { calls.noteLostAtStop.push(lost); },
    restartForShards: reason => { calls.restart.push(reason); return o.restart ? o.restart(reason) : false; },
    noteKeptAtStop: o.noteKeptAtStop,
    log,
  });
  const taken = await claims.bootTake(async () => count);
  expect(taken!.pairs.map(p => p.shardId)).toEqual(o.boot);
  claims.noteGranted();
  const cycle = async () => { await claims.renewOnce(); await flush(); };
  const reserveTakes = () => calls.takes.filter(t => !t.boot);
  const lose = (shardId: number) => { lostKeys.add(pairKey({ shardCount: count, shardId, claim: 1 })); };
  return { claims, calls, lines, clock, pages, cycle, reserveTakes, lose, holdRenewal, gate, setPage: (p: PageRead | Error) => { pages.push(p); } };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the reservation of a running process (decision 10)', () => {
  it('a stop that begins during the reservation plans no return, and the release hands nothing over', async () => {
    let claims: ShardClaims | null = null;
    const r = await rig({ boot: [0, 1], returns: true, reserve: [2], onReserveTake: onBegin => { onBegin?.(); claims!.beginStop(); } });
    claims = r.claims;
    r.setPage(page([row(4, 0, { homeNode: 'node-b' }), row(4, 1, { homeNode: 'node-b' })], [nodeB()]));
    await r.cycle();
    expect(r.reserveTakes()).toHaveLength(1);
    expect(r.claims.snapshot().returning).toEqual([]);
    expect(r.calls.restart).toEqual([]);
    await r.claims.finishStop();
    expect(r.calls.releases).toHaveLength(1);
    expect(r.calls.releases[0].handOvers).toEqual([]);
  });

  it('a page read with no stored count plans under the count this process took at boot', async () => {
    const r = await rig({ boot: [0, 1], reserve: [2, 3] });
    r.setPage(page([row(4, 0), row(4, 1)], [], null));
    await r.cycle();
    expect(r.reserveTakes()).toHaveLength(1);
    expect(r.reserveTakes()[0].reserve).toBe(true);
    expect(r.claims.snapshot().reserved.map(p => p.shardId)).toEqual([2, 3]);
  });

  it('a stored count that differs from the boot count sends a take even when no shard is free', async () => {
    const r = await rig({ boot: [0, 1] });
    const others = [0, 1, 2, 3, 4, 5].map(id => row(6, id, { holderProcess: 'p-b', holderNode: 'node-b', holderName: 'B', homeNode: 'node-b' }));
    r.setPage(page(others, [nodeB()], 6));
    await r.cycle();
    expect(r.reserveTakes()).toHaveLength(1);
    expect(r.reserveTakes()[0]).toMatchObject({ reserve: true, boot: false, localCount: 4 });
  });

  it('a reservation ages from the take\'s BEGIN, and is given up after the TTL with the seconds it waited', async () => {
    const r = await rig({
      boot: [0, 1], reserve: [2],
      onReserveTake: onBegin => { r0.clock.now += 10_000; onBegin?.(); },
    });
    const r0 = r;
    r.setPage(page([row(4, 0), row(4, 1)]));
    await r.cycle();
    expect(r.claims.snapshot().reserved.map(p => p.shardId)).toEqual([2]);
    r.setPage(new Error('connection reset'));
    r.clock.now += 25_000;
    await r.cycle();
    expect(r.lines.filter(l => l.includes('Gave up the reservation'))).toEqual([]);
    expect(r.claims.snapshot().reserved.map(p => p.shardId)).toEqual([2]);
    r.clock.now += 6000;
    await r.cycle();
    expect(r.lines.filter(l => l.includes('Gave up the reservation'))).toEqual([
      '[Shards] Gave up the reservation of shard 2: this process could not restart for 31 s (the restart request was not sent)',
    ]);
    expect(r.claims.snapshot().reserved).toEqual([]);
  });
});

describe('the restart reason (decisions 11 and 15)', () => {
  const homeB = (id: number) => row(4, id, { homeNode: 'node-b' });

  it('names every reservation and return, and after a stale reservation is given up the returns still wait', async () => {
    const r = await rig({ boot: [0, 1], returns: true, reserve: [2] });
    r.setPage(page([homeB(0), homeB(1)], [nodeB()]));
    await r.cycle();
    expect(r.calls.restart).toEqual(['take shard 2; return shard 0 to B; return shard 1 to B']);
    expect(r.claims.snapshot().pendingRestart).toBe('take shard 2; return shard 0 to B; return shard 1 to B');
    r.clock.now += 31_000;
    await r.cycle();
    expect(r.lines.some(l => l.startsWith('[Shards] Gave up the reservation of shard 2:'))).toBe(true);
    expect(r.claims.snapshot().pendingRestart).toBe('return shard 0 to B; return shard 1 to B');
  });

  it('names two reservations as shards in one list', async () => {
    const r = await rig({ boot: [0, 1], reserve: [2, 3] });
    r.setPage(page([row(4, 0), row(4, 1)]));
    await r.cycle();
    expect(r.calls.restart).toEqual(['take shards 2, 3']);
  });

  it('names a shard over the capacity as a move', async () => {
    const r = await rig({ boot: [0, 1], count: 2, capacity: 1, returns: true });
    r.setPage(page([row(2, 0), row(2, 1)], [nodeB()], 2));
    await r.cycle();
    expect(r.reserveTakes()).toEqual([]);
    expect(r.calls.restart).toEqual(['move shard 1 to B']);
  });

  it('a sent restart request is not sent again at the next page read', async () => {
    const r = await rig({ boot: [0, 1], reserve: [2], restart: () => true });
    r.setPage(page([row(4, 0), row(4, 1)]));
    await r.cycle();
    expect(r.calls.restart).toEqual(['take shard 2']);
    await r.cycle();
    await r.cycle();
    expect(r.calls.restart).toEqual(['take shard 2']);
    expect(r.claims.snapshot().pendingRestart).toBe('take shard 2');
  });

  it('a stop that begins while the request is asked leaves no restart pending', async () => {
    let claims: ShardClaims | null = null;
    const r = await rig({ boot: [0, 1], reserve: [2], restart: () => { claims!.beginStop(); return false; } });
    claims = r.claims;
    r.setPage(page([row(4, 0), row(4, 1)]));
    await r.cycle();
    expect(r.calls.restart).toEqual(['take shard 2']);
    expect(r.claims.snapshot().pendingRestart).toBeNull();
    expect(r.claims.snapshot().restartWaiting).toBeNull();
  });
});

describe('the start of a stop (decision 12)', () => {
  it('drops a restart not yet sent and sends no further reservation', async () => {
    const r = await rig({ boot: [0, 1], reserve: [2] });
    r.setPage(page([row(4, 0), row(4, 1)]));
    await r.cycle();
    expect(r.claims.snapshot().pendingRestart).toBe('take shard 2');
    r.claims.beginStop();
    expect(r.claims.snapshot().pendingRestart).toBeNull();
    expect(r.claims.snapshot().restartWaiting).toBeNull();
    const takes = r.reserveTakes().length;
    await r.cycle();
    expect(r.reserveTakes()).toHaveLength(takes);
    expect(r.calls.restart).toEqual(['take shard 2']);
  });

  it('keeps a restart already sent', async () => {
    const r = await rig({ boot: [0, 1], reserve: [2], restart: () => true });
    r.setPage(page([row(4, 0), row(4, 1)]));
    await r.cycle();
    r.claims.beginStop();
    expect(r.claims.snapshot().pendingRestart).toBe('take shard 2');
  });

  it('retire: a loss in its last renewal rewrites the record without starting a leave', async () => {
    const r = await rig({ boot: [0, 1] });
    r.lose(1);
    await r.claims.retire();
    expect(r.calls.noteLost).toEqual([]);
    expect(r.calls.noteLostAtStop.map(l => l.map(p => p.shardId))).toEqual([[1]]);
  });

  it('retire: waits for the renewal on the wire, then sends one more saying unfit', async () => {
    const r = await rig({ boot: [0, 1] });
    const before = r.calls.renews.length;
    r.holdRenewal();
    const wire = r.claims.renewOnce();
    const done = r.claims.retire();
    await flush();
    r.gate.open();
    await wire;
    await done;
    expect(r.calls.renews.length - before).toBe(2);
    expect(r.calls.renews[r.calls.renews.length - 1].heartbeat.fit).toBe(false);
  });

  it('retire and the stop handler together: the last renewal goes before the release', async () => {
    const r = await rig({ boot: [0, 1] });
    r.calls.order.length = 0;
    const a = r.claims.retire();
    const b = r.claims.finishStop();
    await Promise.all([a, b]);
    expect(r.calls.order).toEqual(['renew', 'release']);
  });

  it('finishStop: a renewal that answers a loss within 2 s rewrites the record only and keeps its connection', async () => {
    const r = await rig({ boot: [0, 1] });
    r.lose(1);
    r.holdRenewal();
    const wire = r.claims.renewOnce();
    const stop = r.claims.finishStop();
    await flush();
    r.gate.open();
    await wire;
    await stop;
    expect(r.calls.abandonRenewal).toBe(0);
    expect(r.calls.noteLost).toEqual([]);
    expect(r.calls.noteLostAtStop.map(l => l.map(p => p.shardId))).toEqual([[1]]);
    expect(r.calls.releases).toHaveLength(1);
  });

  it('finishStop: no lapse runs while the release waits past the deadline', async () => {
    const r = await rig({
      boot: [0, 1],
      release: () => new Promise(resolve => {
        setTimeout(() => resolve([0, 1].map(id => ({ shardId: id, claim: 1, wasReserved: false, handedTo: null }))), 25_000);
      }),
    });
    const stop = r.claims.finishStop();
    await flush();
    r.clock.now += 25_000;
    await vi.advanceTimersByTimeAsync(25_000);
    await stop;
    expect(r.calls.stopStep).toBe(0);
    expect(r.lines.filter(l => l.startsWith('[Shards] No claim renewal'))).toEqual([]);
    expect(r.lines).toContain("[Shards] Released shards 0, 1: kept for this machine's next start for 30 s, then free to any machine with room");
  });

  it('the release hands over only the shards still held', async () => {
    const r = await rig({ boot: [0, 1], count: 2, returns: true, restart: () => false });
    r.setPage(page([row(2, 0, { homeNode: 'node-b' }), row(2, 1, { homeNode: 'node-b' })], [nodeB()], 2));
    await r.cycle();
    expect(r.claims.snapshot().returning).toEqual([0, 1]);
    r.lose(0);
    await r.cycle();
    expect(r.claims.heldPairs().map(p => p.shardId)).toEqual([1]);
    await r.claims.finishStop();
    expect(r.calls.releases).toHaveLength(1);
    expect(r.calls.releases[0].handOvers).toEqual([{ shardId: 1, receiver: 'node-b', move: false }]);
  });

  it('a failed record of the kept shards is logged with its cause', async () => {
    const r = await rig({ boot: [0, 1], noteKeptAtStop: () => { throw new Error('disk full'); } });
    await r.claims.finishStop();
    expect(r.lines).toContain('[Shards] Could not record the shards the release kept for this machine: disk full');
  });
});

describe('release and loss lines (decisions 12 and 16)', () => {
  const pair = (id: number): Pair => ({ shardCount: 4, shardId: id, claim: 7 });

  it('lists released shards in ascending order', () => {
    const rows = [2, 0, 3, 1].map(id => ({ shardId: id, claim: 7, wasReserved: false, handedTo: null }));
    expect(releaseLines([], [], rows, 30_000)).toEqual([
      "[Shards] Released shards 0, 1, 2, 3: kept for this machine's next start for 30 s, then free to any machine with room",
    ]);
    const reserved = [5, 4].map(id => ({ shardId: id, claim: 7, wasReserved: true, handedTo: null }));
    expect(releaseLines([], [], reserved, 30_000)).toEqual([
      "[Shards] Reserved shards 4, 5 stay kept for this machine's next start for 30 s, then free to any machine with room",
    ]);
  });

  it('a release sent to a database that became unreachable may still have applied', () => {
    expect(releaseFailureLine([pair(3), pair(1)], { kind: 'unreachable', detail: 'reset' }, true, true)).toBe(
      '[Shards] The release of shards 1, 3 got no answer within 2 s (unreachable); it may still have applied, and otherwise any machine with room may take them once their claims expire',
    );
  });

  it('a refused login says the release did not run', () => {
    expect(releaseFailureLine([pair(2)], { kind: 'refused' }, false, false)).toBe(
      '[Shards] Could not release shards 2 (the database refused the login); any machine with room may take them once their claims expire',
    );
  });

  it('a loss line with no read and no cause says no answer', () => {
    expect(lossLine(pair(1), null, '', ME.processId, null)).toBe(
      '[Shards] Shard 1 is no longer held by this process; its claim row could not be read (no answer)',
    );
  });

  it('a loss line with no row and no stored count says so', () => {
    expect(lossLine(pair(1), { row: null, storedCount: null }, '', ME.processId, null)).toBe(
      "[Shards] Shard 1 has no claim row under 4 shards (the database now runs no count); this process's claim 7 is gone",
    );
  });

  it('a row this process still holds under a newer claim is not called taken', () => {
    const read = { row: { claim: 9, holderName: 'A', holderProcess: ME.processId, takenAt: 5000 }, storedCount: 4 };
    expect(lossLine(pair(1), read, '', ME.processId, 1000)).toBe(
      "[Shards] Shard 1's claim row holds claim 9 of A (process p-a), not this process's claim 7",
    );
  });
});
