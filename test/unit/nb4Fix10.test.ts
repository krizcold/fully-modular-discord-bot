import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShardClaims, type ShardClaimsDeps } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import { MemClaimStore } from '../helpers/fakeClaimStore';

// Round 10 fix of NB4 (NB4-R10-RUN-1): the work cycle asks for the restart before it gives up a stale reservation, and
// the give-up line names the reason the request was last held back, never a fitness read taken at the give-up.

const T = claimTimings(30);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function rig(over: Partial<ShardClaimsDeps> = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  const store = new MemClaimStore(() => Date.now());
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const calls = { restarts: [] as string[] };
  const state = { fit: null as string | null, restart: true };
  const claims = new ShardClaims({
    store,
    me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' },
    timings: T,
    capacity: 4,
    takeoverSeconds: 30,
    returns: true,
    restartable: true,
    startedAt: 0,
    fitness: () => state.fit,
    gateClosed: () => false,
    isStopping: () => false,
    stopServingStep: () => undefined,
    noteLapsed: () => undefined,
    noteLost: () => undefined,
    restartForShards: reason => {
      calls.restarts.push(reason);
      return state.fit === null && state.restart;
    },
    log,
    ...over,
  });
  const lines = () => [...log.log.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].map(c => String(c[0]));
  return { store, claims, calls, state, lines };
}

async function reservedShard3(r: ReturnType<typeof rig>) {
  r.claims.start();
  expect(await r.claims.firstRenewal()).toBe(true);
  await r.claims.bootTake(async () => 4);
  r.claims.noteGranted();
  Object.assign(r.store.rows.get('4:3')!, { released: false, holderProcess: 'p-dead', holderNode: 'node-dead', expiresUpMs: 0 });
  r.claims['held'] = r.claims['held'].filter((p: Pair) => p.shardId !== 3);
  await vi.advanceTimersByTimeAsync(T.renewMs);
  expect(r.claims.snapshot().reserved.map(p => p.shardId)).toEqual([3]);
}

function ageReservation(r: ReturnType<typeof rig>) {
  const back = T.ttlMs + 1000;
  for (const res of r.claims['reserved'] as Array<{ at: { perf: number; wall: number } }>) {
    res.at = { perf: res.at.perf - back, wall: res.at.wall - back };
  }
}

const gaveUp = (r: ReturnType<typeof rig>) => r.lines().filter(l => l.startsWith('[Shards] Gave up the reservation of shard 3'));

describe('a process fit again at the TTL mark asks for its restart (NB4-R10-RUN-1)', () => {
  it('a save failed past TTL and then landed: one restart request, no give-up', async () => {
    const r = rig();
    r.state.restart = false;
    await reservedShard3(r);
    r.state.fit = 'a save is failing';
    r.state.restart = true;
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.claims.snapshot().restartWaiting).toBe('a save is failing');
    ageReservation(r);
    r.state.fit = null;
    const asked = r.calls.restarts.length;
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.calls.restarts.slice(asked)).toEqual(['take shard 3']);
    expect(gaveUp(r)).toEqual([]);
    expect(r.claims.snapshot()).toMatchObject({ pendingRestart: 'take shard 3', restartWaiting: null });
    expect(r.claims.snapshot().reserved.map(p => p.shardId)).toEqual([3]);
  });

  it('a fit process whose request was not sent names that, never "not fit"', async () => {
    const r = rig();
    r.state.restart = false;
    await reservedShard3(r);
    ageReservation(r);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    const lines = gaveUp(r);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/: this process could not restart for \d+ s \(the restart request was not sent\)$/);
    expect(r.lines().some(l => l.includes('not fit'))).toBe(false);
  });

  it('while page reads fail, the line names the fitness key that held the request back and the request is cleared', async () => {
    const r = rig();
    r.state.restart = false;
    await reservedShard3(r);
    r.state.fit = 'a save is failing';
    r.store.readMode = Object.assign(new Error('canceling statement'), { code: '57014' });
    ageReservation(r);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    const lines = gaveUp(r);
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('(a save is failing)')).toBe(true);
    expect(r.claims.snapshot()).toMatchObject({ reserved: [], pendingRestart: null, restartWaiting: null });
  });
});
