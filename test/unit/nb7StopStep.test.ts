import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GuildRequestSweep } from '../../src/bot/internalSetup/fleet/guildRequests';
import type { DataWriteReply } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { ANSWER_SQL, REQUEST_CLAIM_SQL, UNANSWERED_BATCHES_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';

// NB7 decision 16 and section 7 (code review round 2, NB7-R2-T1 and NB7-R2-3): the holder's stop step ends only once
// the claim in flight, the unanswered-batch statement and every finished apply's answer write have answered, or at 2 s.

type Sent = { text: string; values: unknown[] };
const row = { id: 'r1', guild_id: '4194304', op: 'write', body: '{"module":"m","filename":"a.json","contentJson":"{}"}', requested_by: 'ALPHA', left_ms: '20000' };

function rig() {
  const sent: Sent[] = [];
  const held = new Map<string, Array<(v: unknown) => void>>();
  const hold = new Set<string>();
  const state = { stopping: false, ended: false };
  const applies: Array<(r: DataWriteReply) => void> = [];
  const s = new GuildRequestSweep({
    db: {
      query: (text, values) => {
        sent.push({ text, values });
        if (!hold.has(text)) return Promise.resolve({ rows: [], rowCount: 1 });
        return new Promise(resolve => {
          held.set(text, [...(held.get(text) ?? []), resolve as (v: unknown) => void]);
        }) as any;
      },
    },
    processId: () => 'p-a',
    pairs: () => [{ shardCount: 2, shardId: 1, claim: 9 }],
    stoppedServing: () => false,
    isStopping: () => state.stopping,
    apply: () => new Promise<DataWriteReply>(resolve => { applies.push(resolve); }),
    newId: () => 'b1',
  });
  const answer = (text: string, value: unknown) => {
    const waiting = held.get(text) ?? [];
    held.set(text, []);
    for (const resolve of waiting) resolve(value);
  };
  const stop = () => {
    state.stopping = true;
    void s.stopStep().then(() => { state.ended = true; });
  };
  return { s, sent, hold, held, state, applies, answer, stop };
}

const sentOf = (sent: Sent[], text: string) => sent.filter(x => x.text === text);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('NB7-R2-T1: the stop step waits for the pass in flight and for the unanswered-batch statement', () => {
  it('a claim on the wire at the stop: the step stays open until the claim and then the unapplied statement answer', async () => {
    const r = rig();
    r.hold.add(REQUEST_CLAIM_SQL);
    r.hold.add(UNANSWERED_BATCHES_SQL);
    void r.s.pass();
    await vi.advanceTimersByTimeAsync(0);
    r.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(r.state.ended).toBe(false);
    expect(sentOf(r.sent, UNANSWERED_BATCHES_SQL)).toHaveLength(0);
    r.answer(REQUEST_CLAIM_SQL, { rows: [row], rowCount: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(r.applies).toHaveLength(0);
    expect(sentOf(r.sent, UNANSWERED_BATCHES_SQL).length).toBeGreaterThanOrEqual(1);
    expect(r.state.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(r.state.ended).toBe(false);
    for (let i = 0; i < 3; i++) {
      r.answer(UNANSWERED_BATCHES_SQL, { rows: [], rowCount: 1 });
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(10);
    expect(r.state.ended).toBe(true);
    for (const x of sentOf(r.sent, UNANSWERED_BATCHES_SQL)) expect(x.values).toEqual([['b1'], []]);
  });

  it('a claim that never answers: the step ends at 2 s, not before', async () => {
    const r = rig();
    r.hold.add(REQUEST_CLAIM_SQL);
    void r.s.pass();
    await vi.advanceTimersByTimeAsync(0);
    r.stop();
    await vi.advanceTimersByTimeAsync(1990);
    expect(r.state.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(r.state.ended).toBe(true);
  });

  it('an unapplied statement that never answers: the step ends at 2 s, not before', async () => {
    const r = rig();
    r.hold.add(UNANSWERED_BATCHES_SQL);
    r.hold.add(REQUEST_CLAIM_SQL);
    void r.s.pass();
    await vi.advanceTimersByTimeAsync(0);
    r.state.stopping = true;
    r.answer(REQUEST_CLAIM_SQL, { rows: [row], rowCount: 1 });
    await vi.advanceTimersByTimeAsync(0);
    r.stop();
    await vi.advanceTimersByTimeAsync(1990);
    expect(sentOf(r.sent, UNANSWERED_BATCHES_SQL).length).toBeGreaterThanOrEqual(1);
    expect(r.state.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(r.state.ended).toBe(true);
  });
});

describe('NB7-R2-3: an apply that finishes inside the 2 s gets its answer written before the step ends', () => {
  it('the answer write of an apply finished 300 ms into the step is waited for', async () => {
    const r = rig();
    r.hold.add(REQUEST_CLAIM_SQL);
    const passed = r.s.pass();
    await vi.advanceTimersByTimeAsync(0);
    r.answer(REQUEST_CLAIM_SQL, { rows: [row], rowCount: 1 });
    await passed;
    expect(r.applies).toHaveLength(1);
    r.hold.add(ANSWER_SQL);
    r.stop();
    await vi.advanceTimersByTimeAsync(300);
    expect(r.state.ended).toBe(false);
    r.applies[0]({ ok: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(sentOf(r.sent, ANSWER_SQL).map(x => x.values)).toEqual([['r1', 'b1', '{"ok":true}']]);
    expect(r.state.ended).toBe(false);
    r.answer(ANSWER_SQL, { rows: [], rowCount: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(r.state.ended).toBe(true);
  });

  it('an apply that never finishes: the step ends at 2 s', async () => {
    const r = rig();
    r.hold.add(REQUEST_CLAIM_SQL);
    const passed = r.s.pass();
    await vi.advanceTimersByTimeAsync(0);
    r.answer(REQUEST_CLAIM_SQL, { rows: [row], rowCount: 1 });
    await passed;
    expect(r.applies).toHaveLength(1);
    r.stop();
    await vi.advanceTimersByTimeAsync(1990);
    expect(r.state.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(r.state.ended).toBe(true);
    expect(sentOf(r.sent, ANSWER_SQL)).toHaveLength(0);
  });
});
