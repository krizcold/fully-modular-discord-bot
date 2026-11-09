import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pools = vi.hoisted(() => [] as any[]);

vi.mock('pg', async orig => {
  const real = await orig<any>();
  class Pool {
    totalCount = 0;
    idleCount = 0;
    sent: string[] = [];
    ended = false;
    constructor(public options: any) { pools.push(this); }
    on() { return this; }
    async connect() {
      const pool = this;
      return {
        query: async (config: any) => { pool.sent.push(config.text); return { rows: [], rowCount: 0 }; },
        release: () => undefined,
        on: () => undefined,
      };
    }
    async end() { this.ended = true; }
  }
  return { ...real, Pool, default: { ...(real.default ?? real), Pool } };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => ({
  ...(await orig<any>()),
  getDataBootStatus: () => ({ state: 'serving' }),
}));

import {
  GuildRequestSweep,
  RequestsStoppedError,
  _resetGuildRequestPool,
  gatedSweepDb,
  startGuildRequestSweep,
  type SweepDeps,
  type SweepGate,
} from '../../src/bot/internalSetup/fleet/guildRequests';
import { ANSWER_READ_BACK_SQL, ANSWER_SQL, CLEANUP_SQL, REQUEST_CLAIM_SQL, UNANSWERED_BATCHES_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';

// NB5 test 20 (G9, H4, H5): the bot-side request sweep across a hold, a latch and a move. Every statement passes the
// gate: an earlier epoch or the backend's refusal at its entry, the epoch after its connect and at its answer.

const WHY = 'db1:5432/bot was replaced by node-b (generation 4)';
const STOPPED = `this process stopped writing to its database (${WHY})`;
const CONFIRMING = "the database answers again, but this process can't confirm yet that db1:5432/bot is still the main (checking)";
const OUTAGE = 'the database did not answer; this process checks that db1:5432/bot is still the main before writing to it';
const GUILD = '4194304';

type Answer = { rows?: any[]; rowCount?: number } | 'hang' | 'late' | Error;

function fakeGate() {
  const g = { e: 1, refusal: null as string | null };
  const gate: SweepGate = { epoch: () => g.e, refusal: () => g.refusal, stopWhy: () => WHY };
  return { g, gate };
}

function fakePool(script: (text: string, values: unknown[]) => Answer) {
  const state = { connects: 0, hold: false, sent: [] as string[], released: [] as Array<boolean | undefined> };
  const held: Array<() => void> = [];
  const late: Array<() => void> = [];
  const pool = {
    async connect() {
      state.connects += 1;
      if (state.hold) await new Promise<void>(resolve => held.push(resolve));
      return {
        query(config: any): Promise<any> {
          state.sent.push(config.text);
          const answer = script(config.text, config.values ?? []);
          if (answer === 'hang') return new Promise(() => undefined);
          if (answer === 'late') return new Promise(resolve => late.push(() => resolve({ rows: [{ x: 1 }], rowCount: 1 })));
          if (answer instanceof Error) return Promise.reject(answer);
          return Promise.resolve({ rows: answer.rows ?? [], rowCount: answer.rowCount ?? (answer.rows ?? []).length });
        },
        release(destroy?: boolean) { state.released.push(destroy); },
      };
    },
  };
  return { pool, state, releaseConnects: () => { for (const go of held.splice(0)) go(); }, answerLate: () => { for (const go of late.splice(0)) go(); } };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1', guild_id: GUILD, op: 'write', requested_by: 'ALPHA', left_ms: '20000',
  body: JSON.stringify({ module: 'm', filename: 'a.json', contentJson: '{"a":1}', expectSha: 'absent' }),
  ...over,
});

let ids = 0;
function sweepOver(script: (text: string, values: unknown[]) => Answer, over: Partial<SweepDeps> = {}) {
  const { g, gate } = fakeGate();
  const f = fakePool(script);
  const applied: any[] = [];
  const deps: SweepDeps = {
    db: gatedSweepDb(f.pool, gate),
    gate,
    processId: () => 'p-a',
    pairs: () => [{ shardCount: 2, shardId: 1, claim: 9 }],
    stoppedServing: () => false,
    isStopping: () => false,
    apply: async req => { applied.push(req); return { ok: true }; },
    serving: () => true,
    newId: () => `b${++ids}`,
    hrtime: () => 1_000_000_000n,
    ...over,
  };
  return { s: new GuildRequestSweep(deps), f, g, applied };
}

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let logs: { error: ReturnType<typeof vi.spyOn>; log: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn> };
const lines = (spy: ReturnType<typeof vi.spyOn>): string[] => spy.mock.calls.map((c: unknown[]) => String(c[0]));

beforeEach(() => {
  ids = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  logs = {
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
  };
});
afterEach(() => {
  _resetGuildRequestPool();
  setGuildDataBackend(null);
  setBackendKind(null);
  pools.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('G9: the gate on one statement', () => {
  it('(a) with the backend refusing, the statement is refused unsent with the refusal as its message, and nothing connects', async () => {
    const { g, gate } = fakeGate();
    const f = fakePool(() => ({ rows: [] }));
    g.refusal = CONFIRMING;
    const error = await gatedSweepDb(f.pool, gate).query(REQUEST_CLAIM_SQL, [], 2000).catch(e => e);
    expect(error.message).toBe(CONFIRMING);
    expect(error.notSent).toBe(true);
    expect(f.state.connects).toBe(0);
  });

  it('(b) a connect held while the epoch rises: the client is destroyed, nothing is sent, and the call is refused unsent', async () => {
    const { g, gate } = fakeGate();
    const f = fakePool(() => ({ rows: [] }));
    f.state.hold = true;
    const call = gatedSweepDb(f.pool, gate).query(REQUEST_CLAIM_SQL, [], 2000).catch(e => e);
    await flush();
    g.e = 2;
    f.releaseConnects();
    const error = await call;
    expect(error).toBeInstanceOf(RequestsStoppedError);
    expect(error.notSent).toBe(true);
    expect(error.message).toBe(STOPPED);
    expect(f.state.released).toEqual([true]);
    expect(f.state.sent).toEqual([]);
  });

  it('(c) an answer that arrives after the epoch rose is dropped, and the call is not marked unsent', async () => {
    const { g, gate } = fakeGate();
    const f = fakePool(() => 'late');
    const call = gatedSweepDb(f.pool, gate).query(REQUEST_CLAIM_SQL, [], 2000).catch(e => e);
    await flush();
    g.e = 2;
    f.answerLate();
    const error = await call;
    expect(error).toBeInstanceOf(RequestsStoppedError);
    expect(error.notSent).toBe(false);
    expect(error.rows).toBeUndefined();
  });

  it('(d) a statement of an earlier epoch is refused unsent before the refusal is read, with no connect', async () => {
    const { g, gate } = fakeGate();
    const f = fakePool(() => ({ rows: [] }));
    g.e = 3;
    g.refusal = CONFIRMING;
    const error = await gatedSweepDb(f.pool, gate).query(ANSWER_SQL, [], 2000, 2).catch(e => e);
    expect(error).toBeInstanceOf(RequestsStoppedError);
    expect(error.notSent).toBe(true);
    expect(f.state.connects).toBe(0);
  });
});

describe('G9: the sweep across a hold and a latch', () => {
  it('(e) held for three passes: no claim is sent, one line names the hold; once clear, the next pass claims and says it works again', async () => {
    const { s, f, g } = sweepOver(() => ({ rows: [] }));
    g.refusal = CONFIRMING;
    for (let i = 0; i < 3; i++) {
      await s.pass();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(f.state.sent.filter(t => t === REQUEST_CLAIM_SQL)).toHaveLength(0);
    expect(lines(logs.error).filter(l => l.startsWith('[GuildRequests] Cannot read'))).toEqual([
      `[GuildRequests] Cannot read the changes sent from other machines' panels (${CONFIRMING}); they are refused until this works`,
    ]);
    g.refusal = null;
    await s.pass();
    expect(f.state.sent.filter(t => t === REQUEST_CLAIM_SQL)).toHaveLength(1);
    expect(lines(logs.log)).toContain("[GuildRequests] Reading the changes sent from other machines' panels works again");
  });

  it('(f) a claim on the wire whose two rows answer after the epoch rose: nothing applied, answered or sent for its batch, even at a new epoch', async () => {
    let claims = 0;
    const { s, f, g, applied } = sweepOver(text => {
      if (text === REQUEST_CLAIM_SQL) return ++claims === 1 ? 'late' : { rows: [] };
      return { rows: [] };
    });
    const pass = s.pass();
    await flush();
    g.e = 2;
    f.answerLate();
    await pass;
    g.refusal = null;
    g.e = 3;
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    for (let i = 0; i < 5; i++) await s.pass();
    expect(applied).toEqual([]);
    expect(f.state.sent.filter(t => t === ANSWER_SQL)).toHaveLength(0);
    expect(f.state.sent.filter(t => t === UNANSWERED_BATCHES_SQL)).toHaveLength(0);
  });

  it('(g) an apply that answers frozen after the latch: no answer is sent, and the could-not-record line is logged once at once', async () => {
    let finish!: (reply: any) => void;
    const { s, f, g } = sweepOver(text => (text === REQUEST_CLAIM_SQL ? { rows: [row()] } : { rows: [], rowCount: 1 }), {
      apply: () => new Promise(resolve => { finish = resolve; }),
    });
    await s.pass();
    g.e = 2;
    finish({ ok: false, code: 'frozen', error: 'the guild is frozen' });
    await flush();
    expect(f.state.sent.filter(t => t === ANSWER_SQL)).toHaveLength(0);
    const expected = `[GuildRequests] Could not record the answer to the write of server ${GUILD} sent from ALPHA (${STOPPED}); its sender reads can't confirm. The answer was: frozen: the guild is frozen`;
    expect(lines(logs.error).filter(l => l === expected)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lines(logs.error).filter(l => l.includes('the answer to the write'))).toHaveLength(1);
  });

  it('(h) an answer on the wire across the latch: the can\'t-confirm line once, with no retry and no read-back', async () => {
    const { s, f, g } = sweepOver(text => (text === REQUEST_CLAIM_SQL ? { rows: [row()] } : text === ANSWER_SQL ? 'late' : { rows: [] }));
    await s.pass();
    await flush();
    expect(f.state.sent.filter(t => t === ANSWER_SQL)).toHaveLength(1);
    g.e = 2;
    f.answerLate();
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.state.sent.filter(t => t === ANSWER_SQL)).toHaveLength(1);
    expect(f.state.sent.filter(t => t === ANSWER_READ_BACK_SQL)).toHaveLength(0);
    const expected = `[GuildRequests] Can't confirm whether the answer to the write of server ${GUILD} sent from ALPHA was recorded: this process stopped writing to its database while it waited (${WHY}); its sender reads that answer or can't confirm. The answer was: saved`;
    expect(lines(logs.error)).toEqual([expected]);
  });

  it('(i) an answer refused by a hold that ends 3 s later is written once, after the hold, with nothing sent before', async () => {
    let finish!: (reply: any) => void;
    const { s, f, g } = sweepOver(text => (text === REQUEST_CLAIM_SQL ? { rows: [row()] } : { rows: [], rowCount: 1 }), {
      apply: () => new Promise(resolve => { finish = resolve; }),
    });
    await s.pass();
    g.refusal = OUTAGE;
    finish({ ok: true });
    await flush();
    await vi.advanceTimersByTimeAsync(2500);
    expect(f.state.sent.filter(t => t === ANSWER_SQL)).toHaveLength(0);
    g.refusal = null;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.state.sent.filter(t => t === ANSWER_SQL)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.state.sent.filter(t => t === ANSWER_SQL)).toHaveLength(1);
    expect(lines(logs.log)).toContain(`[GuildRequests] write of m/a.json for server ${GUILD}, sent from ALPHA: saved`);
  });

});

describe('G9 and H4: the pool follows the chosen entry', () => {
  it('(k) built from the chosen entry, built again from the new entry at a move, and the sweep\'s next cleanup goes to the new pool', async () => {
    setBackendKind('postgres');
    const listeners: Array<(entry: string) => void> = [];
    setGuildDataBackend(Object.assign(Object.create(PostgresBackend.prototype), {
      chosenEntry: () => 'postgres://bot@db2.example:5432/bot',
      onDatabaseChanged: (cb: (entry: string) => void) => { listeners.push(cb); },
      databaseEpoch: () => 1,
      refusalDetail: () => null,
    }));
    startGuildRequestSweep(() => ({ processId: 'p-a', shardCount: 2, leases: [{ leaseId: 'l1', shardId: 1, claim: 9 }] }) as any);
    expect(pools).toHaveLength(1);
    expect(pools[0].options).toMatchObject({ host: 'db2.example', port: 5432, database: 'bot', application_name: 'smdb-guild-requests' });
    expect(pools[0].options.connectionString).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pools[0].sent).toContain(CLEANUP_SQL);
    expect(listeners).toHaveLength(1);
    listeners[0]('postgres://bot@db3.example:5432/bot');
    expect(pools).toHaveLength(2);
    expect(pools[1].options).toMatchObject({ host: 'db3.example' });
    await flush();
    expect(pools[0].ended).toBe(true);
    const before = pools[0].sent.length;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(pools[1].sent).toContain(CLEANUP_SQL);
    expect(pools[0].sent.length).toBe(before);
  });
});

describe('H5: the answer line after an attempt that got no answer', () => {
  it('(l) a timed-out first attempt, then the epoch rises: the second is refused at entry, no read-back, and the can\'t-confirm line within 1 s', async () => {
    let answers = 0;
    let failedAt = 0;
    const { s, f, g } = sweepOver(text => {
      if (text === REQUEST_CLAIM_SQL) return { rows: [row({ left_ms: '3000' })] };
      if (text === ANSWER_SQL && ++answers === 1) { failedAt = Date.now(); return new Error('Query read timeout'); }
      return { rows: [], rowCount: 1 };
    });
    await s.pass();
    await flush();
    g.e = 2;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.state.sent.filter(t => t === ANSWER_SQL)).toHaveLength(1);
    expect(f.state.sent.filter(t => t === ANSWER_READ_BACK_SQL)).toHaveLength(0);
    const expected = `[GuildRequests] Can't confirm whether the answer to the write of server ${GUILD} sent from ALPHA was recorded: an attempt that got no answer may have landed, and no later attempt confirmed it (${STOPPED}); its sender reads that answer or can't confirm. The answer was: saved`;
    expect(lines(logs.error)).toEqual([expected]);
    expect(Date.now() - failedAt).toBeLessThanOrEqual(1000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines(logs.error).filter(l => l.startsWith('[GuildRequests] Could not record'))).toEqual([]);
    expect(lines(logs.error)).toHaveLength(1);
  });

  it('(m) a timed-out first attempt, then a hold past its time: nothing more is sent, and at its time the can\'t-confirm line names the hold', async () => {
    let answers = 0;
    const { s, f, g } = sweepOver(text => {
      if (text === REQUEST_CLAIM_SQL) return { rows: [row({ left_ms: '3000' })] };
      if (text === ANSWER_SQL) return ++answers === 1 ? new Error('Query read timeout') : { rows: [], rowCount: 0 };
      if (text === ANSWER_READ_BACK_SQL) return { rows: [{ state: 'done', reply: '{"ok":true}' }] };
      return { rows: [] };
    });
    await s.pass();
    await flush();
    g.refusal = OUTAGE;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.state.sent.filter(t => t === ANSWER_SQL)).toHaveLength(1);
    expect(f.state.sent.filter(t => t === ANSWER_READ_BACK_SQL)).toHaveLength(0);
    const expected = `[GuildRequests] Can't confirm whether the answer to the write of server ${GUILD} sent from ALPHA was recorded: an attempt that got no answer may have landed, and no later attempt confirmed it (${OUTAGE}); its sender reads that answer or can't confirm. The answer was: saved`;
    expect(lines(logs.error)).toEqual([expected]);
  });
});
