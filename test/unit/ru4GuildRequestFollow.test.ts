import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetGuildRequests,
  _setGuildRequestDeps,
  endGuildRequests,
  NB7_TEXTS,
  sendGuildChange,
  type Plan,
  type RequestConn,
  type RequestDb,
} from '../../src/webui/utils/guildRequests';
import {
  POLL_SET_SQL,
  REPLY_READ_SQL,
  REQUEST_INSERT_SQL,
  REQUEST_POLL_SQL,
  SETTLE_INSERT_SQL,
  SETTLE_UPDATE_SQL,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { fakeBot, fakeTime, heldRow, requestPlan, writeOf } from '../helpers/nb7Rig';
import { setBackendKind } from '../helpers/backendKind';

// The request route's follow, settle and exit answers for a change sent to BRAVO, over a scripted request database.

class Delayed {
  constructor(readonly ms: number, readonly value: unknown) {}
}

interface Conn { server?: string; sqls: string[]; releases: Array<boolean | undefined> }
interface Statement { sql: string; values: unknown[]; boundMs: number; at: number }

const lost = () => new Error('Connection terminated unexpectedly');
const noRows = () => ({ rows: [], rowCount: 0 });

function gate<T = unknown>() {
  let open!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { open = resolve; fail = reject; });
  return { promise, open, fail };
}

const rig = {
  server: 'S1' as string | undefined,
  connectFail: null as Error | null,
  conns: [] as Conn[],
  statements: [] as Statement[],
  insert: (): unknown => noRows(),
  poll: (): unknown => undefined,
  settle: (_sql: string): unknown => noRows(),
  exitRead: (): unknown => noRows(),
  replyRead: null as null | (() => unknown),
  lastRow: undefined as any,
};

function answerOf(value: unknown, boundMs: number): Promise<any> {
  if (value instanceof Delayed) {
    return new Promise((resolve, reject) => {
      if (boundMs < value.ms) setTimeout(() => reject(new Error('Query read timeout')), boundMs);
      else setTimeout(() => resolve(value.value), value.ms);
    });
  }
  if (value instanceof Error) return Promise.reject(value);
  if (value instanceof Promise) return value;
  return Promise.resolve(value ?? noRows());
}

async function pollAnswer(ids: string[], boundMs: number): Promise<any> {
  const row = await answerOf(rig.poll(), boundMs).then(v => (v && 'rows' in v ? v.rows[0] : v));
  rig.lastRow = row;
  if (!row) return noRows();
  const { reply: _reply, ...states } = row;
  return { rows: [{ id: ids[0], ...states }], rowCount: 1 };
}

function answer(sql: string, values: unknown[], boundMs: number): Promise<any> {
  if (sql === REQUEST_INSERT_SQL) return answerOf(rig.insert(), boundMs);
  if (sql === POLL_SET_SQL) return pollAnswer(values[0] as string[], boundMs);
  if (sql === REPLY_READ_SQL) {
    if (rig.replyRead) return answerOf(rig.replyRead(), boundMs);
    const row = rig.lastRow;
    return answerOf(row && row.state === 'done' ? { rows: [{ reply: row.reply }], rowCount: 1 } : noRows(), boundMs);
  }
  if (sql === SETTLE_UPDATE_SQL || sql === SETTLE_INSERT_SQL) return answerOf(rig.settle(sql), boundMs);
  if (sql === REQUEST_POLL_SQL) return answerOf(rig.exitRead(), boundMs);
  return answerOf(undefined, boundMs);
}

const db = (): RequestDb => ({
  connect: async (): Promise<RequestConn> => {
    if (rig.connectFail) throw rig.connectFail;
    const conn: Conn = { server: rig.server, sqls: [], releases: [] };
    rig.conns.push(conn);
    return {
      server: conn.server,
      transport: 'verified',
      query: (sql, values, boundMs) => {
        conn.sqls.push(sql);
        rig.statements.push({ sql, values, boundMs, at: performance.now() });
        return answer(sql, values, boundMs);
      },
      release: destroy => { conn.releases.push(destroy); },
    };
  },
  end: async () => undefined,
});

const settles = () => rig.statements.filter(s => s.sql === SETTLE_UPDATE_SQL || s.sql === SETTLE_INSERT_SQL);
const pollRow = (over: Record<string, unknown> = {}) => ({ state: 'pending', pickup_over: false, answer_over: false, reply: null, ...over });
const expired = (pickupOver: boolean) => ({ rows: [{ state: 'expired', pickup_over: pickupOver }], rowCount: 1 });
const notHeld = JSON.stringify({ ok: false, code: 'not-held' });

async function start(plan?: Plan) {
  const p = plan ?? await requestPlan('write');
  const box: { done: boolean; value?: any; error?: unknown } = { done: false };
  void sendGuildChange(fakeBot().bot, p, writeOf()).then(
    v => { box.done = true; box.value = v; },
    e => { box.done = true; box.error = e; },
  );
  return { plan: p, box };
}

/** Advances fake time in 250 ms steps until the change answered, at most 70 s. */
async function settled(box: { done: boolean; value?: any; error?: unknown }): Promise<any> {
  for (let i = 0; i < 280 && !box.done; i++) await vi.advanceTimersByTimeAsync(250);
  expect(box.done).toBe(true);
  if (box.error) throw box.error;
  return box.value;
}

async function exitNow() {
  const exit = endGuildRequests();
  await vi.advanceTimersByTimeAsync(10);
  return exit;
}

const noAnswer = (cause: string) => ({ ok: false, servedBy: 'BRAVO', sender: true, code: 'no-answer', noAnswer: cause });

beforeEach(() => {
  fakeTime();
  _resetGuildRequests();
  rig.server = 'S1';
  rig.connectFail = null;
  rig.conns = [];
  rig.statements = [];
  rig.insert = () => noRows();
  rig.poll = () => undefined;
  rig.settle = () => noRows();
  rig.exitRead = () => noRows();
  rig.replyRead = null;
  rig.lastRow = undefined;
  _setGuildRequestDeps({
    holderOf: async () => ({ rows: [heldRow()] }),
    readDoc: async () => null,
    currentUrl: () => 'postgres://one',
    requestDb: db,
    nodeId: () => 'n-a',
    nodeName: () => 'ALPHA',
  });
  setBackendKind('postgres');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  _setGuildRequestDeps(null);
  _resetGuildRequests();
  setBackendKind(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the send and its connections', () => {
  it('a refused connect names its SQLSTATE in the reply', async () => {
    rig.connectFail = Object.assign(new Error('sorry, too many clients already'), { code: '53300' });
    const { box } = await start();
    const reply = await settled(box);
    expect(reply.error).toBe(NB7_TEXTS.unreachable('BRAVO', 'SQLSTATE 53300: sorry, too many clients already', 'saved'));
  });

  it("an acknowledged insert's connection goes back to the pool once, not destroyed", async () => {
    rig.poll = () => pollRow({ state: 'done', pickup_over: true, reply: JSON.stringify({ ok: true }) });
    const { box } = await start();
    const reply = await settled(box);
    expect(reply).toMatchObject({ ok: true, servedBy: 'BRAVO' });
    const insertConn = rig.conns.find(c => c.sqls.includes(REQUEST_INSERT_SQL))!;
    expect(insertConn.releases).toEqual([undefined]);
  });

  it("an insert with no answer destroys its connection", async () => {
    rig.insert = () => lost();
    rig.settle = () => expired(true);
    const { box } = await start();
    const reply = await settled(box);
    expect(reply.error).toBe(NB7_TEXTS.withdrawn('BRAVO', 'saved'));
    const insertConn = rig.conns.find(c => c.sqls.includes(REQUEST_INSERT_SQL))!;
    expect(insertConn.releases).toEqual([true]);
  });

  it('a change that answered is not settled or logged again at a later exit', async () => {
    rig.poll = () => pollRow({ state: 'done', pickup_over: true, reply: JSON.stringify({ ok: true }) });
    const { box } = await start();
    expect(await settled(box)).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(1000);
    const before = rig.statements.length;
    const exit = endGuildRequests();
    await vi.advanceTimersByTimeAsync(2500);
    await exit;
    expect(rig.statements.length).toBe(before);
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('a reply read the database answers in 100 ms is read and answered', async () => {
    rig.poll = () => pollRow({ state: 'done', pickup_over: true });
    rig.replyRead = () => new Delayed(100, { rows: [{ reply: JSON.stringify({ ok: true }) }], rowCount: 1 });
    const { box } = await start();
    const reply = await settled(box);
    expect(reply).toMatchObject({ ok: true, servedBy: 'BRAVO' });
  });

  it.each(['5', 'null', 'true'])('a stored reply %s that is no object: the answer could not be read', async text => {
    rig.poll = () => pollRow({ state: 'done', pickup_over: true, reply: text });
    const { box } = await start();
    const reply = await settled(box);
    expect(reply).toEqual(noAnswer('lost'));
  });
});

describe('an insert still in flight at the exit', () => {
  it("a refusal other than a duplicate id stays the database's refusal, even after the exit withdrew the id", async () => {
    const insert = gate();
    rig.insert = () => insert.promise;
    rig.settle = () => ({ rows: [{ state: 'expired' }], rowCount: 1 });
    const { box } = await start();
    await vi.advanceTimersByTimeAsync(10);
    const exit = await exitNow();
    expect(settles().map(s => s.sql)).toEqual([SETTLE_INSERT_SQL]);
    insert.fail(Object.assign(new Error('null value in column "op"'), { code: '23502', constraint: 'guild_requests_pkey' }));
    const reply = await settled(box);
    await vi.advanceTimersByTimeAsync(2500);
    await exit;
    expect(reply.error).toBe(NB7_TEXTS.insertRefused('23502', 'null value in column "op"', 'saved'));
  });

  it("the exit's withdrawal on another server instance, then the insert lost: the panel shut down before the answer", async () => {
    const insert = gate();
    rig.insert = () => insert.promise;
    rig.settle = () => ({ rows: [{ state: 'expired' }], rowCount: 1 });
    const { box } = await start();
    await vi.advanceTimersByTimeAsync(10);
    rig.server = 'S2';
    const exit = await exitNow();
    insert.fail(lost());
    const reply = await settled(box);
    await vi.advanceTimersByTimeAsync(2500);
    await exit;
    expect(reply).toEqual(noAnswer('stopped'));
  });
});

describe('the follow at the exit', () => {
  it("a settle that failed before the exit, then the exit's own withdrawal: the shutdown text", async () => {
    rig.poll = () => pollRow({ pickup_over: true });
    rig.settle = () => lost();
    const { box } = await start();
    await vi.advanceTimersByTimeAsync(10);
    expect(settles()).toHaveLength(1);
    rig.settle = () => expired(true);
    const exit = await exitNow();
    const reply = await settled(box);
    await vi.advanceTimersByTimeAsync(2500);
    await exit;
    expect(reply.error).toBe(NB7_TEXTS.withdrawnAtExit('BRAVO', 'saved'));
  });

  async function pollAtExit(row: unknown) {
    const poll = gate();
    let first = true;
    rig.poll = () => {
      if (first) { first = false; return poll.promise; }
      return undefined;
    };
    const { box } = await start();
    await vi.advanceTimersByTimeAsync(10);
    expect(first).toBe(false);
    const exit = await exitNow();
    poll.open(row);
    const reply = await settled(box);
    await vi.advanceTimersByTimeAsync(2500);
    await exit;
    return reply;
  }

  it('a poll in flight at the exit reads the row expired after claim_by: the shutdown text', async () => {
    rig.exitRead = () => lost();
    const reply = await pollAtExit(pollRow({ state: 'expired', pickup_over: true }));
    expect(reply.error).toBe(NB7_TEXTS.withdrawnAtExit('BRAVO', 'saved'));
  });

  it('a poll in flight at the exit finds no row and the exit read none: the panel shut down before the answer', async () => {
    const reply = await pollAtExit(undefined);
    expect(reply).toEqual(noAnswer('stopped'));
  });

  it('a poll in flight at the exit reads the row applying: no reply is read for it', async () => {
    rig.exitRead = () => lost();
    rig.replyRead = () => ({ rows: [{ reply: JSON.stringify({ ok: true }) }], rowCount: 1 });
    const reply = await pollAtExit(pollRow({ state: 'applying' }));
    expect(reply).toEqual(noAnswer('stopped'));
    expect(rig.statements.filter(s => s.sql === REPLY_READ_SQL)).toHaveLength(0);
  });

  it('a not-held reply read at the exit before claim_by passed: can not confirm, never "nothing was saved"', async () => {
    const done = pollRow({ state: 'done', pickup_over: false, reply: notHeld });
    rig.exitRead = () => ({ rows: [done], rowCount: 1 });
    rig.replyRead = () => ({ rows: [{ reply: notHeld }], rowCount: 1 });
    const reply = await pollAtExit(done);
    expect(reply).toEqual(noAnswer('stopped'));
  });
});

describe('the follow until its end', () => {
  it('a not-held reply before claim_by, then reply reads that fail: the withdrawal can not be shown', async () => {
    rig.poll = () => pollRow({ state: 'done', pickup_over: false, reply: notHeld });
    let reads = 0;
    rig.replyRead = () => (++reads === 1 ? { rows: [{ reply: notHeld }], rowCount: 1 } : lost());
    const { box } = await start();
    const reply = await settled(box);
    expect(reads).toBeGreaterThan(1);
    expect(reply).toEqual(noAnswer('unsettled'));
  });

  it('a not-held reply before claim_by, then the row pending again and withdrawn at the end: nothing was saved', async () => {
    let polls = 0;
    rig.poll = () => (++polls === 1 ? pollRow({ state: 'done', pickup_over: false, reply: notHeld }) : pollRow());
    rig.settle = () => expired(true);
    const { box } = await start();
    const reply = await settled(box);
    expect(polls).toBeGreaterThan(2);
    expect(reply.error).toBe(NB7_TEXTS.notTaken('BRAVO', 'saved'));
  });

  it('a not-held reply before claim_by on every poll: the withdrawal can not be shown, and no settle is sent', async () => {
    rig.poll = () => pollRow({ state: 'done', pickup_over: false, reply: notHeld });
    const { box } = await start();
    const reply = await settled(box);
    expect(reply).toEqual(noAnswer('unsettled'));
    expect(settles()).toHaveLength(0);
  });

  it('a row applying until the follow ends: did not answer in time, and no settle is sent', async () => {
    rig.poll = () => pollRow({ state: 'applying' });
    rig.settle = () => lost();
    const { box } = await start();
    const reply = await settled(box);
    expect(reply).toEqual(noAnswer('timeout'));
    expect(settles()).toHaveLength(0);
  });

  it('a pending row withdrawn before claim_by at the end: the withdrawal can not be shown', async () => {
    rig.poll = () => pollRow();
    rig.settle = () => expired(false);
    const { box } = await start();
    const reply = await settled(box);
    expect(settles()).toHaveLength(1);
    expect(reply).toEqual(noAnswer('unsettled'));
  });

  it('a row expired before claim_by, then done after a failover: the holder saved it', async () => {
    let polls = 0;
    rig.poll = () => (++polls <= 2 ? pollRow({ state: 'expired', pickup_over: false }) : pollRow({ state: 'done', pickup_over: true, reply: JSON.stringify({ ok: true }) }));
    const { box } = await start();
    const reply = await settled(box);
    expect(polls).toBe(3);
    expect(reply).toMatchObject({ ok: true, servedBy: 'BRAVO' });
  });

  it('a settle that fails until the deadline: the answer could not be read, with no settle after the last retry', async () => {
    const plan = await requestPlan('write');
    let late = 0;
    rig.poll = () => pollRow({ pickup_over: true });
    rig.settle = () => {
      if (plan.deadline - performance.now() <= 1000) {
        late += 1;
        if (late > 1) return expired(true);
      }
      return lost();
    };
    const { box } = await start(plan);
    const reply = await settled(box);
    expect(reply).toEqual(noAnswer('lost'));
    expect(late).toBe(1);
  });
});
