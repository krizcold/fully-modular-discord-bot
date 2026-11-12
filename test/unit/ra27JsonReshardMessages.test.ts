import { describe, expect, it } from 'vitest';

import { JsonReshard, l18Line, l19Line, l28Line, l4Line, l4bLine, l8Reason } from '../../src/bot/internalSetup/fleet/reshard';
import { l11Line, retryTime } from '../../src/bot/internalSetup/fleet/shardClaims';

const START = Date.UTC(2026, 10, 7, 10, 0, 0);
const FIFTEEN_MIN = 15 * 60_000;
const HOUR = 60 * 60_000;

function rig() {
  const h = {
    now: START,
    sent: [] as any[],
    lines: [] as string[],
    handOvers: [] as { reason: string; attempt: string }[],
    fitness: null as string | null,
    overlap: true,
    room: true as boolean | null,
    remaining: 1000,
    resetAt: START + HOUR,
  };
  let n = 0;
  const reshard = new JsonReshard({
    nodeName: 'A',
    countSetting: () => null,
    recommendation: () => 2,
    runningCount: () => 1,
    fitness: () => h.fitness,
    overlap: () => h.overlap,
    memory: () => ({ room: h.room, freeMb: 4000, useMb: 200, error: null, ageMs: 1000 }),
    startedAgoMs: () => 3_600_000,
    budget: () => ({ stale: false, remaining: h.remaining, resetAt: h.resetAt }),
    send: message => { h.sent.push(message); },
    intents: () => 1,
    maxConcurrency: () => 1,
    handOver: (reason, attempt) => { h.handOvers.push({ reason, attempt }); },
    newAttempt: () => `att-${++n}`,
    log: { log: line => { h.lines.push(String(line)); }, warn: line => { h.lines.push(String(line)); }, error: line => { h.lines.push(String(line)); } },
    now: () => h.now,
  });
  return { h, reshard };
}

function opened() {
  const r = rig();
  r.reshard.tick();
  const attempt = r.h.sent[r.h.sent.length - 1].data.attempt as string;
  r.h.lines.length = 0;
  return { ...r, attempt };
}

function stillOpen(r: ReturnType<typeof opened>) {
  expect(r.reshard.fields().reshard).toMatchObject({ attempt: r.attempt, from: 1, to: 2 });
  expect(r.reshard.fields().lastReshard).toBeNull();
  expect(r.h.handOvers).toEqual([]);
  expect(r.h.lines).toEqual([]);
}

describe('ra27 JsonReshard.onMessage: what it ignores', () => {
  it('ignores a function carrying a retire for the open attempt', () => {
    const r = opened();
    const fn = Object.assign(() => undefined, { type: 'reshard:retire', data: { attempt: r.attempt } });
    expect(r.reshard.onMessage(fn)).toBeNull();
    stillOpen(r);
  });

  it('ignores a retire for another attempt', () => {
    const r = opened();
    expect(r.reshard.onMessage({ type: 'reshard:retire', data: { attempt: 'other' } })).toBeNull();
    stillOpen(r);
  });

  it('ignores a retire with no data, without throwing', () => {
    const r = opened();
    expect(r.reshard.onMessage({ type: 'reshard:retire' })).toBeNull();
    stillOpen(r);
  });

  it('ignores another message type for the open attempt, even one that says ended', () => {
    const r = opened();
    expect(r.reshard.onMessage({ type: 'reshard:other', data: { attempt: r.attempt } })).toBeNull();
    expect(r.reshard.onMessage({ type: 'reshard:other', data: { attempt: r.attempt, state: 'ended', reason: 'x' } })).toBeNull();
    stillOpen(r);
  });

  it('ignores a standby-state that is neither refused nor ended', () => {
    const r = opened();
    expect(r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: r.attempt, state: 'running', reason: 'x' } })).toBeNull();
    expect(r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: r.attempt, state: 'started' } })).toBeNull();
    stillOpen(r);
  });
});

describe('ra27 JsonReshard.onMessage: a retire', () => {
  it('on an unfit process answers not accepted, logs L28 and calls the attempt off', () => {
    const r = opened();
    r.h.fitness = 'maintenance';
    expect(r.reshard.onMessage({ type: 'reshard:retire', data: { attempt: r.attempt } })).toEqual({ accepted: false, key: 'maintenance' });
    expect(r.h.handOvers).toEqual([]);
    expect(r.h.lines).toEqual([l28Line(2, 'maintenance', 1, START + FIFTEEN_MIN)]);
    expect(r.reshard.fields().reshard).toBeNull();
    expect(r.reshard.fields().lastReshard).toEqual({ from: 1, to: 2, method: 'overlap', state: 'cancelled', endedAt: START, reason: 'this process was not healthy (maintenance)' });
  });

  it('on a fit process hands over', () => {
    const r = opened();
    expect(r.reshard.onMessage({ type: 'reshard:retire', data: { attempt: r.attempt } })).toEqual({ accepted: true });
    expect(r.h.handOvers).toEqual([{ reason: l8Reason(2), attempt: r.attempt }]);
  });
});

describe('ra27 JsonReshard.onMessage: refusals and ends', () => {
  it('an ended with a reason that is not text logs L11 with no reason recorded', () => {
    const r = opened();
    r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: r.attempt, state: 'ended', reason: 42 } });
    expect(r.h.lines).toEqual([l11Line(2, 'no reason recorded', 1, START + FIFTEEN_MIN)]);
    expect(r.reshard.fields().lastReshard).toMatchObject({ state: 'cancelled' });
    expect(r.reshard.fields().lastReshard!.reason).toBeNull();
  });

  it('an ended with no reason logs L11 with no reason recorded', () => {
    const r = opened();
    r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: r.attempt, state: 'ended' } });
    expect(r.h.lines).toEqual([l11Line(2, 'no reason recorded', 1, START + FIFTEEN_MIN)]);
    expect(r.reshard.fields().lastReshard!.reason).toBeNull();
  });

  it("an ended of kind 'passing' still calls the attempt off with L11", () => {
    const r = opened();
    r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: r.attempt, state: 'ended', kind: 'passing', reason: 'gone' } });
    expect(r.h.lines).toEqual([l11Line(2, 'gone', 1, START + FIFTEEN_MIN)]);
    expect(r.reshard.fields().reshard).toBeNull();
    expect(r.reshard.fields().lastReshard).toMatchObject({ state: 'cancelled', reason: 'gone' });
  });

  it("a passing refusal with no reason logs L4b with no reason recorded and records no call-off", () => {
    const r = opened();
    r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: r.attempt, state: 'refused', kind: 'passing' } });
    expect(r.h.lines).toEqual([l4bLine('no reason recorded')]);
    expect(r.reshard.fields()).toEqual({ reshard: null, lastReshard: null });
  });

  it('a memory refusal logs L4 only and calls the attempt off with the 15 min wait', () => {
    const r = opened();
    r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: r.attempt, state: 'refused', kind: 'memory', reason: 'no room' } });
    expect(r.h.lines).toEqual([l4Line('no room')]);
    expect(r.reshard.fields().reshard).toBeNull();
    expect(r.reshard.fields().lastReshard).toEqual({ from: 1, to: 2, method: 'overlap', state: 'cancelled', endedAt: START, reason: 'no room' });
    r.h.now = START + FIFTEEN_MIN - 1;
    r.reshard.tick();
    expect(r.h.sent).toHaveLength(1);
    expect(r.reshard.wait()!.reason).toBe(`the last try was called off (no room); the next try is after ${retryTime(START + FIFTEEN_MIN)}`);
  });

  it('a refusal with no reason and no kind logs nothing and calls the attempt off', () => {
    const r = opened();
    r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: r.attempt, state: 'refused' } });
    expect(r.h.lines).toEqual([]);
    expect(r.reshard.fields().reshard).toBeNull();
    expect(r.reshard.fields().lastReshard).toMatchObject({ state: 'cancelled', reason: null });
  });
});

describe('ra27 JsonReshard L18 and the budget clause', () => {
  const offReason = 'resharding beside the running shards is off on A (FLEET_RESHARD_OVERLAP=false)';
  const memReason = 'A has no room in memory (4000 MB free, 200 MB used)';

  it('logs L18 once for the same reason within the hour, again when the reason changes', () => {
    const r = rig();
    r.h.overlap = false;
    r.reshard.tick();
    r.reshard.tick();
    expect(r.h.lines).toEqual([l18Line(2, 1, offReason, true)]);
    r.h.now = START + 60_000;
    r.h.overlap = true;
    r.h.room = false;
    r.reshard.tick();
    expect(r.h.lines).toEqual([l18Line(2, 1, offReason, true), l18Line(2, 1, memReason, true)]);
    expect(r.reshard.wait()).toEqual({ wanted: 2, source: 'discord', reason: memReason, cannot: true });
  });

  it('logs L18 again for the same reason once a full hour has passed, not a millisecond before', () => {
    const r = rig();
    r.h.overlap = false;
    r.reshard.tick();
    r.h.now = START + HOUR - 1;
    r.reshard.tick();
    expect(r.h.lines).toHaveLength(1);
    r.h.now = START + HOUR;
    r.reshard.tick();
    expect(r.h.lines).toEqual([l18Line(2, 1, offReason, true), l18Line(2, 1, offReason, true)]);
  });

  it('waits on a short budget with the clause that names the logins a reshard needs', () => {
    const r = rig();
    r.h.remaining = 3;
    r.reshard.tick();
    const why = `Discord allows 3 more gateway logins until ${retryTime(START + HOUR)}, and a reshard needs 4`;
    expect(r.reshard.wait()).toEqual({ wanted: 2, source: 'discord', reason: why });
    expect(r.h.lines).toEqual([l19Line(2, 3, START + HOUR)]);
    expect(r.h.sent).toEqual([]);
  });
});
