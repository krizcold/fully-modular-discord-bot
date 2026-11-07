import { describe, expect, it } from 'vitest';

import { JsonReshard, l18Line, l4Line, l4bLine } from '../../src/bot/internalSetup/fleet/reshard';
import { l11Line } from '../../src/bot/internalSetup/fleet/shardClaims';

// NB9 decisions 15 and 33 for a JSON bot (code review 1, lane B findings 1 and 2, ruling E10): a 'passing' refusal
// logs L4b and counts nothing; an 'ended' from the web UI calls the attempt off with L11 and the 15 min backoff, two
// toward one count stop the tries with L18, and an 'ended' after the hand-over does nothing.

const START = Date.UTC(2026, 10, 7, 10, 0, 0);
const FIFTEEN_MIN = 15 * 60_000;

function rig() {
  const h = { now: START, sent: [] as any[], lines: [] as string[], handOvers: [] as string[] };
  let n = 0;
  const reshard = new JsonReshard({
    nodeName: 'A',
    countSetting: () => null,
    recommendation: () => 2,
    runningCount: () => 1,
    fitness: () => null,
    overlap: () => true,
    memory: () => ({ room: true, freeMb: 4000, useMb: 200, error: null, ageMs: 1000 }),
    startedAgoMs: () => 3_600_000,
    budget: () => ({ stale: false, remaining: 1000, resetAt: h.now + 3_600_000 }),
    send: message => { h.sent.push(message); },
    intents: () => 1,
    maxConcurrency: () => 1,
    handOver: (_reason, attempt) => { h.handOvers.push(attempt); },
    newAttempt: () => `att-${++n}`,
    log: { log: line => { h.lines.push(String(line)); }, warn: line => { h.lines.push(String(line)); }, error: line => { h.lines.push(String(line)); } },
    now: () => h.now,
  });
  const asks = () => h.sent.filter(m => m.type === 'control:reshard-standby');
  return { h, reshard, asks };
}

function lastAttempt(r: ReturnType<typeof rig>): string {
  const asks = r.asks();
  return asks[asks.length - 1].data.attempt;
}

describe("NB9 33: a 'passing' refusal of a JSON bot's ask", () => {
  it('logs L4b, counts nothing, and the next tick asks again', () => {
    const r = rig();
    r.reshard.tick();
    const reason = 'another operation is in progress';
    r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: lastAttempt(r), state: 'refused', kind: 'passing', reason } });
    expect(r.h.lines).toContain(l4bLine(reason));
    expect(r.h.lines).not.toContain(l4Line(reason));
    expect(r.reshard.fields()).toEqual({ reshard: null, lastReshard: null });
    r.reshard.tick();
    expect(r.asks()).toHaveLength(2);
    expect(r.asks()[0].data).toMatchObject({ from: 1, to: 2, json: true });
  });

  it('two in a row give no L18, and the tries go on', () => {
    const r = rig();
    const reason = 'a restart is in flight';
    for (let i = 0; i < 2; i++) {
      r.reshard.tick();
      r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: lastAttempt(r), state: 'refused', kind: 'passing', reason } });
    }
    r.reshard.tick();
    expect(r.asks()).toHaveLength(3);
    expect(r.h.lines.some(l => l.includes('cannot run'))).toBe(false);
    expect(r.reshard.wait()).toBeNull();
  });
});

describe("NB9 E10: the web UI's 'ended' for a JSON standby", () => {
  it('gives L11 with the reason and the retry time, one call-off, and no ask until the retry time', () => {
    const r = rig();
    r.reshard.tick();
    const reason = 'not every new shard was connected within 2 min';
    r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: lastAttempt(r), state: 'ended', reason } });
    expect(r.h.lines).toContain(l11Line(2, reason, 1, START + FIFTEEN_MIN));
    expect(r.reshard.fields().reshard).toBeNull();
    expect(r.reshard.fields().lastReshard).toMatchObject({ from: 1, to: 2, state: 'cancelled', reason });
    r.h.now = START + FIFTEEN_MIN - 1;
    r.reshard.tick();
    expect(r.asks()).toHaveLength(1);
    r.h.now = START + FIFTEEN_MIN;
    r.reshard.tick();
    expect(r.asks()).toHaveLength(2);
  });

  it('two toward one count give L18', () => {
    const r = rig();
    const reason = 'the bot process did not answer the retire within 5 s';
    r.reshard.tick();
    r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: lastAttempt(r), state: 'ended', reason } });
    r.h.now += FIFTEEN_MIN;
    r.reshard.tick();
    r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt: lastAttempt(r), state: 'ended', reason } });
    r.h.now += FIFTEEN_MIN;
    r.reshard.tick();
    expect(r.asks()).toHaveLength(2);
    expect(r.h.lines).toContain(l18Line(2, 1, 'two tries beside the running shards were called off', true));
  });

  it('after the hand-over does nothing', () => {
    const r = rig();
    r.reshard.tick();
    const attempt = lastAttempt(r);
    expect(r.reshard.onMessage({ type: 'reshard:retire', data: { attempt } })).toEqual({ accepted: true });
    const before = r.h.lines.length;
    r.reshard.onMessage({ type: 'reshard:standby-state', data: { attempt, state: 'ended', reason: 'the bot process did not answer the retire within 5 s' } });
    expect(r.h.lines.length).toBe(before);
    expect(r.reshard.fields().lastReshard).toMatchObject({ state: 'done' });
    expect(r.h.handOvers).toEqual([attempt]);
  });
});
