import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetGuildRequests,
  _setGuildRequestDeps,
  endGuildRequests,
  NB7_TEXTS,
  sendGuildChange,
  type RequestDb,
} from '../../src/webui/utils/guildRequests';
import { GuildRequestSweep } from '../../src/bot/internalSetup/fleet/guildRequests';
import type { DataWriteReply } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import {
  ANSWER_SQL,
  REQUEST_CLAIM_SQL,
  REQUEST_POLL_SQL,
  SETTLE_UPDATE_SQL,
  UNANSWERED_BATCHES_SQL,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { fakeBot, fakeTime, heldRow, requestPlan, writeOf } from '../helpers/nb7Rig';
import { setBackendKind } from '../helpers/backendKind';

// NB7 code review round 4: the unanswered-batch statement leaves out the ids the process started (gatekeeper ruling
// 8: NB7-R4-DL1, R4-T1, R4-1), and the exit's withdrawal of an acknowledged insert says the panel withdrew it (NB7-R4-2).

const row = (id: string) => ({ id, guild_id: '4194304', op: 'write', body: '{"module":"m","filename":"a.json","contentJson":"{}"}', requested_by: 'ALPHA', left_ms: '20000' });
const lost = () => new Error('Connection terminated unexpectedly');

type Sent = { text: string; values: unknown[] };

function holder(claims: Array<(state: { stopping: boolean }) => unknown>) {
  const sent: Sent[] = [];
  const state = { stopping: false };
  const applies: Array<(r: DataWriteReply) => void> = [];
  let batch = 0;
  let claim = 0;
  const s = new GuildRequestSweep({
    db: {
      query: async (text, values) => {
        sent.push({ text, values });
        if (text === REQUEST_CLAIM_SQL) {
          const answer = claims[claim++]?.(state);
          if (answer instanceof Error) throw answer;
          return (answer as any) ?? { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      },
    },
    processId: () => 'p-b',
    pairs: () => [{ shardCount: 2, shardId: 1, claim: 9 }],
    stoppedServing: () => false,
    isStopping: () => state.stopping,
    apply: () => new Promise<DataWriteReply>(resolve => { applies.push(resolve); }),
    newId: () => `b${++batch}`,
  });
  return { s, sent, state, applies };
}

const sentOf = (sent: Sent[], text: string) => sent.filter(x => x.text === text);

describe('NB7-R4-DL1: a second claim of a started request never gets the unapplied answer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('a second claim with no answer: the statement for its batch leaves out the started id', async () => {
    const h = holder([() => ({ rows: [row('r1')], rowCount: 1 }), () => lost()]);
    await h.s.pass();
    expect(h.applies).toHaveLength(1);
    await h.s.pass();
    const unanswered = sentOf(h.sent, UNANSWERED_BATCHES_SQL);
    expect(unanswered).toHaveLength(1);
    expect(unanswered[0].values).toEqual([['b2'], ['r1']]);
    h.applies[0]({ ok: true });
    await h.s.stopStep();
    expect(sentOf(h.sent, ANSWER_SQL).map(x => x.values.slice(0, 2))).toEqual([['r1', 'b1']]);
  });

  it("a second claim whose rows come back after the stop began: the started row gets the first apply's answer under the new batch", async () => {
    const h = holder([
      () => ({ rows: [row('r1')], rowCount: 1 }),
      state => { state.stopping = true; return { rows: [row('r1')], rowCount: 1 }; },
    ]);
    await h.s.pass();
    await h.s.pass();
    expect(h.applies).toHaveLength(1);
    expect(sentOf(h.sent, UNANSWERED_BATCHES_SQL)).toHaveLength(0);
    h.applies[0]({ ok: true });
    await h.s.stopStep();
    expect(sentOf(h.sent, ANSWER_SQL).map(x => x.values.slice(0, 2))).toEqual([['r1', 'b2']]);
    expect(sentOf(h.sent, UNANSWERED_BATCHES_SQL)).toHaveLength(0);
  });

  it('rows after the stop began, one started and one not: the batch is answered unapplied without the started id', async () => {
    const h = holder([
      () => ({ rows: [row('r1')], rowCount: 1 }),
      state => { state.stopping = true; return { rows: [row('r1'), row('r2')], rowCount: 2 }; },
    ]);
    await h.s.pass();
    await h.s.pass();
    expect(h.applies).toHaveLength(1);
    const unanswered = sentOf(h.sent, UNANSWERED_BATCHES_SQL);
    expect(unanswered.length).toBeGreaterThanOrEqual(1);
    for (const x of unanswered) expect(x.values).toEqual([['b2'], ['r1']]);
    h.applies[0]({ ok: true });
    await h.s.stopStep();
    expect(sentOf(h.sent, ANSWER_SQL).map(x => x.values.slice(0, 2))).toEqual([['r1', 'b2']]);
  });
});

describe('NB7-R4-2: a change the exit withdrew says the panel withdrew it as it shut down', () => {
  let script: (sql: string) => unknown = () => undefined;

  beforeEach(() => {
    script = () => undefined;
    fakeTime();
    _resetGuildRequests();
    _setGuildRequestDeps({
      holderOf: async () => ({ rows: [heldRow()] }),
      readDoc: async () => null,
      currentUrl: () => 'postgres://current',
      requestDb: (): RequestDb => ({
        connect: async () => ({
          server: 'S1',
          query: (sql: string) => {
            const value = script(sql);
            if (value instanceof Error) return Promise.reject(value);
            if (value instanceof Promise) return value as Promise<any>;
            return Promise.resolve(value ?? { rows: [], rowCount: 0 });
          },
          release: () => undefined,
        }),
        end: async () => undefined,
      }),
      nodeId: () => 'n-a',
      nodeName: () => 'ALPHA',
    });
    setBackendKind('postgres');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    _setGuildRequestDeps(null);
    _resetGuildRequests();
    setBackendKind(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function send() {
    const plan = await requestPlan('write');
    let value: any;
    void sendGuildChange(fakeBot().bot, plan, writeOf()).then(v => { value = v; });
    return async (ms = 1000) => { await vi.advanceTimersByTimeAsync(ms); return value; };
  }

  const poll = (over: Record<string, unknown> = {}) => ({ rows: [{ state: 'pending', reply: null, pickup_over: false, answer_over: false, ...over }] });

  it('a pending row the exit withdrew: the shutdown text, never the pickup text', async () => {
    script = sql => (sql === REQUEST_POLL_SQL ? poll() : sql === SETTLE_UPDATE_SQL ? { rows: [{ state: 'expired' }] } : undefined);
    const result = await send();
    await vi.advanceTimersByTimeAsync(10);
    const exit = endGuildRequests();
    const reply = await result();
    await exit;
    expect(reply).toMatchObject({ ok: false, code: 'not-taken', error: NB7_TEXTS.withdrawnAtExit('BRAVO', 'saved') });
    expect(reply.error).toBe('This web panel is shutting down, so the change sent to BRAVO was withdrawn before BRAVO took it; nothing was saved. Try again once the panel is back.');
  });

  it("the route's own pickup-over settle, still in flight at the exit: the pickup text", async () => {
    const gate: { done?: (v: unknown) => void } = {};
    script = sql => {
      if (sql === REQUEST_POLL_SQL) return poll({ pickup_over: true });
      if (sql === SETTLE_UPDATE_SQL) return new Promise(resolve => { gate.done = resolve; });
      return undefined;
    };
    const result = await send();
    await vi.advanceTimersByTimeAsync(10);
    expect(gate.done).toBeDefined();
    const exit = endGuildRequests();
    gate.done!({ rows: [{ state: 'expired' }] });
    const reply = await result();
    await exit;
    expect(reply).toMatchObject({ ok: false, code: 'not-taken', error: NB7_TEXTS.notTaken('BRAVO', 'saved') });
  });
});
