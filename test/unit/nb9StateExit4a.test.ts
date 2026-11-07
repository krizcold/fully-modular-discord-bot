import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { Reshard, l1Line, l3Line, l4Line, l4bLine } from '../../src/bot/internalSetup/fleet/reshard';
import { untilSeconds } from '../../src/bot/internalSetup/fleet/reshardRules';
import { claimTimings, type ClaimRow } from '../../src/bot/internalSetup/fleet/claimRules';
import { MemClaimStore } from '../helpers/fakeClaimStore';

// NB9 test 3, part 4a's cells on the serving side: O1 C1 (the start and the ask), O1 C2 (the refusals, 33), the
// second standby end (49) and S4 C1's hand-over (E4). A serving ShardClaims of count 4 runs over the claims fake with
// NB9's driver on its page reads; the reshard row is what decision 6's start, 12's count change and 11's call-off
// write through reshardStore.ts's statements.

const T = claimTimings(30);
const A = { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' };
const AT = 'a1b2c3d4-0000-4000-8000-0000000000bb';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function serving(opts: { target?: number; heldRows?: boolean; recommendation?: number } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  const store = new MemClaimStore(() => Date.now());
  const lines: string[] = [];
  const log = { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
  const sent: any[] = [];
  const leaves: Array<{ reason: string; handOver?: { attempt: string | null } }> = [];
  let driver: Reshard | null = null;
  const claims = new ShardClaims({
    store, me: A, timings: T, capacity: 4, takeoverSeconds: 30, returns: false, restartable: true, startedAt: 0,
    fitness: () => null, gateClosed: () => false, isStopping: () => false, stopServingStep: () => undefined,
    noteLapsed: () => undefined, noteLost: () => undefined, restartForShards: () => true, countSetting: () => null, log,
    onPage: page => driver?.onPage(page),
  });
  driver = new Reshard({
    claims, withWorkClient: (what, fn) => store.withWorkClient(what, fn), me: A, fitness: () => null, restartable: true,
    startLeave: (reason, handOver) => { leaves.push({ reason, handOver }); }, send: m => { sent.push(m); },
    intents: () => 513, maxConcurrency: () => 1, entry: () => 'postgres://db', log,
    budget: () => ({ stale: false, remaining: 900, resetAt: Date.now() + 3_600_000 }), recommendation: () => opts.recommendation ?? null,
    newAttempt: () => AT,
  });
  store.count = 4;
  claims.start();
  await claims.firstRenewal();
  if (opts.heldRows === false) {
    // Machine B's live rows hold every shard of 4, so this process's boot takes none (25's process that held no shard).
    for (let s = 0; s < 4; s++) {
      store.rows.set(`4:${s}`, {
        shardCount: 4, shardId: s, claim: 40 + s, holderProcess: 'p-b', holderNode: 'n-b', holderName: 'B', homeNode: 'n-b',
        released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: T.ttlMs, expiresUpMs: 10_000_000, extended: false,
      } as ClaimRow);
    }
  }
  const took = await claims.bootTake(async () => 4);
  if (opts.heldRows === false) expect(took?.pairs).toEqual([]);
  claims.noteGranted();
  if (opts.target !== undefined) store.reshard = { ...store.reshard, target: opts.target, targetBy: 'A', targetAt: Date.now() - 60_000 };
  return { store, claims, driver, lines, sent, leaves };
}

describe('test 3: the serving side of the overlap (6, 7, 33, 49) and S4 C1 (E4)', () => {
  it('P4 (part 5b): Discord recommends more shards and no machine has room: L18, and the wait says it cannot run', async () => {
    const r = await serving({ recommendation: 6 });
    r.store.nodeMemory.set('n-a', { room: false, freeMb: 100, useMb: 900, error: null, agoMs: 0 });
    await vi.advanceTimersByTimeAsync(T.renewMs);
    const reason = 'A has no room in memory (100 MB free, 900 MB used)';
    expect(r.driver.wait()).toEqual({ wanted: 6, source: 'discord', reason, cannot: true });
    expect(r.lines.some(l => l.startsWith(`[Shards] Discord recommends 6 shards (the bot runs 4), and a reshard beside the running shards cannot run: ${reason}.`))).toBe(true);
    expect(r.store.starts).toEqual([]);
  });

  it('O1 C1: W from the target, every machine with room: the start writes the overlap attempt with L1; the next tick asks with L3 once', async () => {
    const r = await serving({ target: 8 });
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.store.starts).toEqual([{ attempt: AT, from: 4, to: 8, method: 'overlap', reason: null }]);
    expect(r.store.reshard).toMatchObject({ attempt: AT, state: 'standby', fromCount: 4, toCount: 8 });
    expect(r.lines).toContain(l1Line(4, 8, Math.round(untilSeconds('overlap', 8, 1) / 60)));
    await vi.advanceTimersByTimeAsync(T.renewMs * 2);
    const asks = r.sent.filter(m => m.type === 'control:reshard-standby');
    expect(asks.length).toBeGreaterThanOrEqual(2);
    expect(asks[0]).toEqual({ type: 'control:reshard-standby', data: { attempt: AT, to: 8, intents: 513, maxConcurrency: 1, entry: 'postgres://db' } });
    expect(r.lines.filter(l => l === l3Line())).toHaveLength(1);
    expect(r.driver.wait()).toBeNull();
  });

  it("O1 C2: a 'memory' refusal logs L4 and calls the attempt off with failures + 1; a 'passing' one logs L4b once and calls nothing off", async () => {
    const r = await serving({ target: 8 });
    await vi.advanceTimersByTimeAsync(T.renewMs);
    await r.driver.onMessage({ type: 'reshard:standby-state', data: { attempt: AT, state: 'refused', kind: 'passing', reason: 'another operation is in progress' } });
    await r.driver.onMessage({ type: 'reshard:standby-state', data: { attempt: AT, state: 'refused', kind: 'passing', reason: 'another operation is in progress' } });
    expect(r.lines.filter(l => l === l4bLine('another operation is in progress'))).toHaveLength(1);
    expect(r.store.reshard.state).toBe('standby');
    await r.driver.onMessage({ type: 'reshard:standby-state', data: { attempt: AT, state: 'refused', kind: 'memory', reason: 'the memory reading is 20 min old' } });
    expect(r.lines).toContain(l4Line('the memory reading is 20 min old'));
    expect(r.store.reshard.state).toBe('cancelled');
    expect(r.store.attemptRow).toMatchObject({ reason: 'A could not start its new shards: the memory reading is 20 min old', failures: 1 });
    expect(r.lines.some(l => l.startsWith('[Shards] Called off the reshard to 8 shards: A could not start its new shards: the memory reading is 20 min old; the bot keeps 4 shards; the next try is after '))).toBe(true);
  });

  it('49: the second standby end calls the attempt off with failures + 1; the first does not', async () => {
    const r = await serving({ target: 8 });
    await vi.advanceTimersByTimeAsync(T.renewMs);
    await r.driver.onMessage({ type: 'reshard:standby-state', data: { attempt: AT, state: 'ended', reason: 'exit code 137, signal null' } });
    expect(r.store.reshard.state).toBe('standby');
    await r.driver.onMessage({ type: 'reshard:standby-state', data: { attempt: AT, state: 'ended', reason: 'exit code 1, signal null' } });
    expect(r.store.reshard.state).toBe('cancelled');
    expect(r.store.attemptRow).toMatchObject({ reason: 'the second bot process on A ended twice before the switch (last: exit code 1, signal null)', failures: 1 });
  });

  it("S4 C1 (E4): a process of the old count with no row hands over by 25 once the count change wrote meta 8, with the attempt as read", async () => {
    const r = await serving({ heldRows: false });
    r.store.count = 8;
    r.store.reshard = { attempt: AT, state: 'done', fromCount: 4, toCount: 8 };
    for (let s = 0; s < 8; s++) {
      r.store.rows.set(`8:${s}`, {
        shardCount: 8, shardId: s, claim: 200 + s, holderProcess: `spread:${AT}`, holderNode: 'n-b', holderName: 'B', homeNode: 'n-b',
        released: true, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: T.ttlMs, expiresUpMs: 10_000_000, extended: false,
      } as ClaimRow);
    }
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.leaves).toEqual([{ reason: 'Resharding to 8 shards: this process hands its shards to the new ones', handOver: { attempt: AT } }]);
    expect(r.claims.stoppedServing()).toBe(true);
    expect(r.store.count).toBe(8);
    expect([...r.store.rows.values()].filter(x => x.shardCount === 8 && x.released)).toHaveLength(8);
  });
});
