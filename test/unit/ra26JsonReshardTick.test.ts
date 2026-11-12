import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonReshard, Reshard, l19Line, l27Line, l4Line, l4bLine, type JsonReshardDeps, type ReshardBudget } from '../../src/bot/internalSetup/fleet/reshard';
import { untilSeconds } from '../../src/bot/internalSetup/fleet/reshardRules';
import { retryTime } from '../../src/bot/internalSetup/fleet/shardClaims';

const START = Date.UTC(2026, 10, 11, 10, 0, 0);
const FIFTEEN_MIN = 15 * 60_000;

function jsonRig(over: Partial<JsonReshardDeps> = {}, opts: { remaining?: number } = {}) {
  const h = { now: START, sent: [] as any[], lines: [] as string[], warns: [] as string[] };
  let k = 0;
  const budget: ReshardBudget = { stale: false, remaining: opts.remaining ?? 1000, resetAt: START + 3_600_000 };
  const reshard = new JsonReshard({
    nodeName: 'A',
    countSetting: () => null,
    recommendation: () => 2,
    runningCount: () => 1,
    fitness: () => null,
    overlap: () => true,
    memory: () => ({ room: true, freeMb: 4000, useMb: 200, error: null, ageMs: 1000 }),
    startedAgoMs: () => 3_600_000,
    budget: () => budget,
    send: message => { h.sent.push(message); },
    intents: () => 1,
    maxConcurrency: () => 1,
    handOver: () => {},
    newAttempt: () => `att-${++k}`,
    log: {
      log: line => { h.lines.push(String(line)); },
      warn: line => { h.lines.push(String(line)); h.warns.push(String(line)); },
      error: line => { h.lines.push(String(line)); },
    },
    now: () => h.now,
    ...over,
  });
  const asks = () => h.sent.filter(m => m.type === 'control:reshard-standby');
  return { h, reshard, asks };
}

afterEach(() => { vi.useRealTimers(); });

describe('ra26 JsonReshard timer', () => {
  it('asks at the first 30 s tick after start', () => {
    vi.useFakeTimers();
    const r = jsonRig();
    r.reshard.start();
    vi.advanceTimersByTime(30_000);
    expect(r.asks()).toHaveLength(1);
    r.reshard.stop();
  });

  it('a second start keeps one timer, and stop ends it', () => {
    vi.useFakeTimers();
    const r = jsonRig();
    r.reshard.start();
    r.reshard.start();
    r.reshard.stop();
    vi.advanceTimersByTime(90_000);
    expect(r.asks()).toHaveLength(0);
  });

  it('stop ends the timer, and start after it runs it again', () => {
    vi.useFakeTimers();
    const r = jsonRig();
    r.reshard.start();
    r.reshard.stop();
    vi.advanceTimersByTime(90_000);
    expect(r.asks()).toHaveLength(0);
    r.reshard.start();
    vi.advanceTimersByTime(30_000);
    expect(r.asks()).toHaveLength(1);
    r.reshard.stop();
  });
});

describe('ra26 JsonReshard fields while an attempt is open', () => {
  it('shows the attempt with its age and nobody waited for', () => {
    const r = jsonRig();
    r.reshard.tick();
    r.h.now = START + 5000;
    expect(r.reshard.fields().reshard).toEqual({
      attempt: 'att-1', from: 1, to: 2, method: 'overlap', state: 'standby', startedAgoMs: 5000, untilMs: null, reason: null,
      connected: 0, waitingFor: [],
    });
  });
});

describe('ra26 JsonReshard tick', () => {
  it('asks once while an attempt is open', () => {
    const r = jsonRig();
    r.reshard.tick();
    r.reshard.tick();
    expect(r.asks()).toHaveLength(1);
  });

  it('asks nothing when FLEET_SHARD_COUNT is set', () => {
    const r = jsonRig({ countSetting: () => 3 });
    r.reshard.tick();
    expect(r.asks()).toHaveLength(0);
    expect(r.reshard.wait()).toBeNull();
  });

  it('asks nothing when Discord recommends fewer shards than run', () => {
    const r = jsonRig({ recommendation: () => 1, runningCount: () => 2 });
    r.reshard.tick();
    expect(r.asks()).toHaveLength(0);
    expect(r.reshard.wait()).toBeNull();
  });

  it('asks nothing when Discord recommends the running count', () => {
    const r = jsonRig({ recommendation: () => 2, runningCount: () => 2 });
    r.reshard.tick();
    expect(r.asks()).toHaveLength(0);
    expect(r.reshard.wait()).toBeNull();
  });

  it('waits with the unhealthy reason and asks nothing when unfit', () => {
    const r = jsonRig({ fitness: () => 'maintenance' });
    r.reshard.tick();
    expect(r.asks()).toHaveLength(0);
    expect(r.reshard.wait()).toEqual({ wanted: 2, source: 'discord', reason: 'A is not healthy' });
  });

  it('waits with the call-off reason and the retry time before the retry', () => {
    const r = jsonRig();
    r.reshard.tick();
    r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: 'att-1', state: 'ended', reason: 'the standby crashed' } });
    r.h.now = START + 1000;
    r.reshard.tick();
    expect(r.asks()).toHaveLength(1);
    expect(r.reshard.wait()).toEqual({
      wanted: 2, source: 'discord',
      reason: `the last try was called off (the standby crashed); the next try is after ${retryTime(START + FIFTEEN_MIN)}`,
    });
  });

  it("says 'no reason recorded' when the call-off had no reason", () => {
    const r = jsonRig();
    r.reshard.tick();
    r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: 'att-1', state: 'ended' } });
    r.reshard.tick();
    expect(r.reshard.wait()?.reason).toBe(`the last try was called off (no reason recorded); the next try is after ${retryTime(START + FIFTEEN_MIN)}`);
  });

  it('gives L18 and no ask when overlap is off on this machine', () => {
    const r = jsonRig({ overlap: () => false });
    r.reshard.tick();
    expect(r.asks()).toHaveLength(0);
    expect(r.reshard.wait()).toEqual({
      wanted: 2, source: 'discord', reason: 'resharding beside the running shards is off on A (FLEET_RESHARD_OVERLAP=false)', cannot: true,
    });
  });

  it('with no IPC channel names the missing web UI and asks nothing', () => {
    const r = jsonRig({ send: null });
    r.reshard.tick();
    expect(r.reshard.wait()).toEqual({ wanted: 2, source: 'discord', reason: 'A runs without the web UI', cannot: true });
  });

  it('starts when the budget holds exactly two logins per wanted shard', () => {
    const r = jsonRig({}, { remaining: 4 });
    r.reshard.tick();
    expect(r.asks()).toHaveLength(1);
    expect(r.reshard.wait()).toBeNull();
  });

  it('waits on a short budget with L19 once across ticks', () => {
    const r = jsonRig({}, { remaining: 3 });
    r.reshard.tick();
    r.reshard.tick();
    expect(r.asks()).toHaveLength(0);
    const l19 = l19Line(2, 3, START + 3_600_000);
    expect(r.h.warns.filter(l => l === l19)).toHaveLength(1);
    expect(r.reshard.wait()).toEqual({
      wanted: 2, source: 'discord',
      reason: `Discord allows 3 more gateway logins until ${retryTime(START + 3_600_000)}, and a reshard needs 4`,
    });
  });

  it('logs L27 with the call-off time in minutes', () => {
    const r = jsonRig();
    r.reshard.tick();
    const m = Math.round(untilSeconds('overlap', 2, 1) / 60);
    expect(m).toBe(10);
    expect(r.h.lines).toContain(l27Line(1, 2, 10));
  });
});

describe('ra26 JsonReshard onMessage', () => {
  it('answers null to a null message', () => {
    const r = jsonRig();
    r.reshard.tick();
    expect(r.reshard.onMessage(null)).toBeNull();
    expect(r.reshard.fields().reshard?.attempt).toBe('att-1');
  });
});

function dbRig() {
  const h = { lines: [] as string[], works: [] as string[] };
  const reshard = new Reshard({
    claims: { processId: 'p1', ownCount: () => 1, stopServingForReshard: () => true, noteHandOver: () => {} },
    withWorkClient: async <T>(what: string) => { h.works.push(what); return { kind: 'unchanged' } as unknown as T; },
    me: { nodeId: 'n1', nodeName: 'alpha' },
    fitness: () => null,
    restartable: true,
    startLeave: () => {},
    send: () => {},
    intents: () => 1,
    maxConcurrency: () => 1,
    entry: () => 'main',
    budget: () => null,
    recommendation: () => null,
    log: {
      log: line => { h.lines.push(String(line)); },
      warn: line => { h.lines.push(String(line)); },
      error: line => { h.lines.push(String(line)); },
    },
    now: () => START,
  });
  return { h, reshard };
}

describe("ra26 Reshard's answers from the web UI", () => {
  it('ignores an answer whose attempt is not a string', async () => {
    const r = dbRig();
    await r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: 5, state: 'refused', kind: 'memory', reason: 'no room' } });
    expect(r.h.lines).toEqual([]);
    expect(r.h.works).toEqual([]);
  });

  it('a memory refusal with no reason logs L4 with an empty reason', async () => {
    const r = dbRig();
    await r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: 'a1', state: 'refused', kind: 'memory' } });
    expect(r.h.lines).toEqual([l4Line('')]);
    expect(r.h.works).toEqual(['the call-off']);
  });

  it('a memory refusal with a non-string reason logs L4 with an empty reason', async () => {
    const r = dbRig();
    await r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: 'a1', state: 'refused', kind: 'memory', reason: 42 } });
    expect(r.h.lines).toEqual([l4Line('')]);
  });

  it('passing refusals log L4b once per reason of an attempt', async () => {
    const r = dbRig();
    const msg = (reason: string) => ({ type: 'reshard:standby-state', data: { attempt: 'a1', state: 'refused', kind: 'passing', reason } });
    await r.reshard.onMessage(msg('busy'));
    await r.reshard.onMessage(msg('busy'));
    await r.reshard.onMessage(msg('restarting'));
    expect(r.h.lines).toEqual([l4bLine('busy'), l4bLine('restarting')]);
    expect(r.h.works).toEqual([]);
  });

  it('a state other than refused or ended calls nothing off', async () => {
    const r = dbRig();
    await r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: 'a1', state: 'started' } });
    await r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: 'a1', state: 'started' } });
    expect(r.h.works).toEqual([]);
    await r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: 'a1', state: 'ended' } });
    await r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: 'a1', state: 'ended' } });
    expect(r.h.works).toEqual(['the call-off']);
  });
});
