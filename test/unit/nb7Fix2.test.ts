import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetGuildRequests,
  _setGuildRequestDeps,
  endGuildRequests,
  NB7_TEXTS,
  remoteNoAnswerText,
  remoteRestoreNoAnswerCause,
  sendGuildChange,
  type RequestDb,
} from '../../src/webui/utils/guildRequests';
import { GuildRequestSweep } from '../../src/bot/internalSetup/fleet/guildRequests';
import {
  ANSWER_SQL,
  REQUEST_CLAIM_SQL,
  REQUEST_INSERT_SQL,
  REQUEST_POLL_SQL,
  SETTLE_INSERT_SQL,
  SETTLE_UPDATE_SQL,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { fakeBot, fakeTime, GUILD, heldRow, requestPlan, writeOf } from '../helpers/nb7Rig';
import { setBackendKind } from '../helpers/backendKind';

// NB7 code review round 2: the route's answer once the web UI exits (NB7-R2-1), one exit for both signal handlers
// (NB7-R2-2), and the holder's stop step waiting for each apply in flight and its answer write (NB7-R2-3).

type Sent = { sql: string; server: string };

const poll = (state: string, over: Record<string, unknown> = {}) => ({ rows: [{ state, reply: null, pickup_over: false, answer_over: false, ...over }] });
const lost = () => new Error('Connection terminated unexpectedly');

let sent: Sent[] = [];
let script: (sql: string) => unknown = () => undefined;

function answerOf(value: unknown): Promise<any> {
  if (value instanceof Error) return Promise.reject(value);
  if (value instanceof Promise) return value;
  return Promise.resolve(value ?? { rows: [], rowCount: 0 });
}

function install(): void {
  _resetGuildRequests();
  _setGuildRequestDeps({
    holderOf: async () => ({ rows: [heldRow()] }),
    readDoc: async () => null,
    currentUrl: () => 'postgres://current',
    requestDb: (): RequestDb => ({
      connect: async () => ({
        server: 'S1',
        query: (sql: string) => {
          sent.push({ sql, server: 'S1' });
          return answerOf(script(sql));
        },
        release: () => undefined,
      }),
      end: async () => undefined,
    }),
    nodeId: () => 'n-a',
    nodeName: () => 'ALPHA',
  });
  setBackendKind('postgres');
}

async function send() {
  const plan = await requestPlan('write');
  let value: any;
  void sendGuildChange(fakeBot().bot, plan, writeOf()).then(v => { value = v; });
  return async (ms = 1000) => { await vi.advanceTimersByTimeAsync(ms); return value; };
}

const count = (sql: string) => sent.filter(s => s.sql === sql).length;

beforeEach(() => {
  sent = [];
  script = () => undefined;
  fakeTime();
  install();
});
afterEach(() => {
  _setGuildRequestDeps(null);
  _resetGuildRequests();
  setBackendKind(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('NB7-R2-1: once the web UI exits, the route answers what the exit\'s settle showed', () => {
  it('a pending row the exit withdrew on the insert\'s server: not taken, nothing was saved', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    script = sql => (sql === REQUEST_POLL_SQL ? poll('pending') : sql === SETTLE_UPDATE_SQL ? { rows: [{ state: 'expired' }] } : undefined);
    const result = await send();
    await vi.advanceTimersByTimeAsync(10);
    const exit = endGuildRequests();
    const reply = await result();
    await exit;
    expect(reply).toMatchObject({ ok: false, code: 'not-taken', error: NB7_TEXTS.withdrawnAtExit('BRAVO', 'saved') });
    expect(reply.noAnswer).toBeUndefined();
  });

  it('a row already applying: the shutdown cause, never "did not answer in time"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    script = sql => (sql === REQUEST_POLL_SQL ? poll('applying') : undefined);
    const result = await send();
    await vi.advanceTimersByTimeAsync(10);
    const exit = endGuildRequests();
    const reply = await result();
    await exit;
    expect(reply).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'stopped', servedBy: 'BRAVO' });
  });

  it('an insert with no answer that the exit withdrew: the withdrawn text', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const gate: { fail?: (e: Error) => void } = {};
    script = sql => {
      if (sql === REQUEST_INSERT_SQL) return new Promise((_, reject) => { gate.fail = reject; });
      if (sql === SETTLE_INSERT_SQL) return { rows: [{ state: 'expired' }] };
      return undefined;
    };
    const result = await send();
    await vi.advanceTimersByTimeAsync(10);
    const exit = endGuildRequests();
    await vi.advanceTimersByTimeAsync(10);
    gate.fail!(lost());
    const reply = await result();
    await exit;
    expect(reply).toMatchObject({ ok: false, code: 'backend-unavailable', error: NB7_TEXTS.withdrawn('BRAVO', 'saved') });
  });

  it('the shutdown texts say the panel is shutting down and can\'t confirm', () => {
    expect(remoteNoAnswerText('stopped', 'BRAVO', 'write')).toBe("This web panel shut down before it read the answer from BRAVO; can't confirm whether the change was saved. Reload once the panel is back to check.");
    expect(remoteRestoreNoAnswerCause('stopped', 'BRAVO')).toBe('this web panel shut down before it read the answer from BRAVO');
  });
});

describe('NB7-R2-2: both exit handlers share one exit', () => {
  it('a second call joins the first: one read of the row and one log line', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    script = sql => (sql === REQUEST_POLL_SQL ? poll('applying') : undefined);
    const result = await send();
    await vi.advanceTimersByTimeAsync(10);
    const polls = count(REQUEST_POLL_SQL);
    const first = endGuildRequests();
    const second = endGuildRequests();
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([first, second]);
    await result();
    expect(count(REQUEST_POLL_SQL) - polls).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(`[Main] Exiting while BRAVO applies the write of server ${GUILD}; can't confirm whether it was saved`);
  });
});

describe('NB7-R2-3: the holder\'s stop step waits for each apply in flight and its answer write', () => {
  const row = { id: 'r1', guild_id: GUILD, op: 'write', body: '{}', requested_by: 'ALPHA', left_ms: '20000' };

  function sweepWith(apply: () => Promise<any>) {
    const texts: string[] = [];
    let claimed = false;
    const s = new GuildRequestSweep({
      db: {
        query: async text => {
          texts.push(text);
          if (text === REQUEST_CLAIM_SQL) {
            if (claimed) return { rows: [] };
            claimed = true;
            return { rows: [row] };
          }
          return { rows: [], rowCount: 1 };
        },
      },
      processId: () => 'p-a',
      pairs: () => [{ shardCount: 2, shardId: 1, claim: 9 }],
      stoppedServing: () => false,
      isStopping: () => false,
      apply,
      newId: () => 'b1',
    });
    return { s, texts };
  }

  it('an apply that ends inside the 2 s has its answer written before the step ends', async () => {
    const gate: { done?: (v: unknown) => void } = {};
    const { s, texts } = sweepWith(() => new Promise(resolve => { gate.done = resolve; }));
    await s.pass();
    expect(s.running()).toBe(1);
    let ended = false;
    void s.stopStep().then(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(300);
    expect(ended).toBe(false);
    gate.done!({ ok: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(texts).toContain(ANSWER_SQL);
    expect(ended).toBe(true);
  });

  it('an apply that never ends: the step ends at 2 s', async () => {
    const { s } = sweepWith(() => new Promise(() => undefined));
    await s.pass();
    let ended = false;
    void s.stopStep().then(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(1900);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(ended).toBe(true);
  });
});

describe('NB7-R5-1: the exit\'s settle reaches the server before the insert', () => {
  const duplicate = (constraint: string) => Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), { code: '23505', constraint });

  async function race(settle: () => unknown, error: Error, settleFirst = true) {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const gate: { fail?: (e: Error) => void; settle?: (v: unknown) => void } = {};
    script = sql => {
      if (sql === REQUEST_INSERT_SQL) return new Promise((_, reject) => { gate.fail = reject; });
      if (sql === SETTLE_INSERT_SQL) return settleFirst ? settle() : new Promise(resolve => { gate.settle = resolve; });
      return undefined;
    };
    const result = await send();
    await vi.advanceTimersByTimeAsync(10);
    const exit = endGuildRequests();
    await vi.advanceTimersByTimeAsync(10);
    gate.fail!(error);
    await vi.advanceTimersByTimeAsync(10);
    if (!settleFirst) gate.settle!(settle());
    const reply = await result();
    await exit;
    return reply;
  }

  it('the settle withdrew the id: the withdrawn-at-exit text, never the database refused the change', async () => {
    const reply = await race(() => ({ rows: [{ state: 'expired' }] }), duplicate('guild_requests_pkey'));
    expect(reply).toMatchObject({ ok: false, code: 'not-taken', error: NB7_TEXTS.withdrawnAtExit('BRAVO', 'saved') });
    expect(reply.noAnswer).toBeUndefined();
  });

  it('the insert\'s refusal comes back before the settle\'s answer: the route waits for the settle', async () => {
    const reply = await race(() => ({ rows: [{ state: 'expired' }] }), duplicate('guild_requests_pkey'), false);
    expect(reply).toMatchObject({ ok: false, code: 'not-taken', error: NB7_TEXTS.withdrawnAtExit('BRAVO', 'saved') });
  });

  it('the settle did not withdraw the id: the refusal stands', async () => {
    const error = duplicate('guild_requests_pkey');
    const reply = await race(() => ({ rows: [] }), error);
    expect(reply).toMatchObject({ ok: false, code: 'backend-unavailable', error: NB7_TEXTS.insertRefused('23505', error.message, 'saved') });
  });

  it('a duplicate key on another constraint: the refusal stands', async () => {
    const error = duplicate('some_other_key');
    const reply = await race(() => ({ rows: [{ state: 'expired' }] }), error);
    expect(reply).toMatchObject({ ok: false, code: 'backend-unavailable', error: NB7_TEXTS.insertRefused('23505', error.message, 'saved') });
  });

  it('a duplicate key with no exit: the refusal stands', async () => {
    const error = duplicate('guild_requests_pkey');
    script = sql => (sql === REQUEST_INSERT_SQL ? error : undefined);
    const result = await send();
    const reply = await result(10);
    expect(reply).toMatchObject({ ok: false, code: 'backend-unavailable', error: NB7_TEXTS.insertRefused('23505', error.message, 'saved') });
  });
});
