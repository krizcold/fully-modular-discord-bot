import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _setGuildRequestDeps,
  endGuildRequests,
  guildRequestDeps,
  NB7_TEXTS,
  sendGuildChange,
  type Plan,
  type RequestDb,
} from '../../src/webui/utils/guildRequests';
import {
  REQUEST_INSERT_SQL,
  REQUEST_POLL_SQL,
  SETTLE_INSERT_SQL,
  SETTLE_UPDATE_SQL,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { ROUTE_TEXT } from '../../src/webui/botManager';
import { fakeBot, fakeTime, GUILD, HANG, nb7Rig, resetNb7, type Rig } from '../helpers/nb7Rig';

const URL1 = 'postgres://one';
const WITHDRAWN = NB7_TEXTS.withdrawn('BRAVO', 'saved');
const pgError = (code: string, message = 'refused') => Object.assign(new Error(message), { code });
const pending = (over: Record<string, unknown> = {}) => ({ rows: [{ state: 'pending', reply: null, pickup_over: false, answer_over: false, ...over }] });
const done = (reply: string, over: Record<string, unknown> = {}) => ({ rows: [{ state: 'done', reply, pickup_over: false, answer_over: false, ...over }] });
const expired = (pickupOver = true) => ({ rows: [{ state: 'expired', reply: null, pickup_over: pickupOver, answer_over: false }] });

interface Pool {
  max: number;
  out: number;
  releases: number;
  /** How long a connection takes to hand out; a bound shorter than this fails at the bound. */
  connectMs: number;
  /** How long a statement of the SQL takes; a bound shorter than this fails at the bound. */
  queryMs: (sql: string) => number;
}

const wait = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, Math.max(0, ms)); });

/** The request pool as pg's runs it: at most max clients out, a connect and each statement bounded by its bound. */
function pooledDb(inner: RequestDb, pool: Pool): RequestDb {
  return {
    connect: async boundMs => {
      if (pool.out >= pool.max || pool.connectMs > boundMs) {
        await wait(boundMs);
        throw new Error(pool.out >= pool.max
          ? `every connection of the web UI's request pool was in use for ${Math.round(boundMs / 100) / 10} s`
          : `the database did not take a connection within ${Math.round(boundMs / 100) / 10} s`);
      }
      if (pool.connectMs > 0) await wait(pool.connectMs);
      const conn = await inner.connect(boundMs);
      pool.out += 1;
      let released = false;
      return {
        get server() { return conn.server; },
        get transport() { return conn.transport; },
        query: async (sql, values, bound) => {
          const ms = pool.queryMs(sql);
          if (ms > bound) {
            await wait(bound);
            throw new Error('Query read timeout');
          }
          if (ms > 0) await wait(ms);
          return conn.query(sql, values, bound);
        },
        release: destroy => {
          if (!released) {
            released = true;
            pool.out -= 1;
            pool.releases += 1;
          }
          conn.release(destroy);
        },
      };
    },
    end: () => inner.end(),
  };
}

let rig: Rig;
let pool: Pool;
let logs: string[];

beforeEach(() => {
  fakeTime();
  rig = nb7Rig();
  pool = { max: 2, out: 0, releases: 0, connectMs: 0, queryMs: () => 0 };
  const deps = guildRequestDeps();
  const inner = deps.requestDb;
  _setGuildRequestDeps({ ...deps, requestDb: url => pooledDb(inner(url), pool) });
  logs = [];
  const keep = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
});

afterEach(() => {
  resetNb7();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const planOf = (leftMs = 60_000): Plan => ({
  kind: 'request',
  op: 'write',
  deadline: performance.now() + leftMs,
  holder: { shardCount: 2, shardId: 1, processId: 'p-b', name: 'BRAVO', url: URL1 },
});

const writeOf = (over: Record<string, unknown> = {}) => ({ guildId: GUILD, module: 'm', filename: 'a.json', op: 'write' as const, contentJson: '{"a":1}', expectSha: 'absent', ...over });

function send(plan: Plan = planOf(), payload: any = writeOf()) {
  const started = performance.now();
  const state: { value: any; at: number } = { value: undefined, at: -1 };
  void sendGuildChange(fakeBot().bot, plan, payload).then(v => { state.value = v; state.at = performance.now() - started; });
  return state;
}

const at = (script: (sql: string, values: unknown[]) => unknown) => { rig.script[URL1] = script; };
const count = (sql: string) => rig.statements.filter(s => s.sql === sql).length;
const answeredOk = (sql: string) => (sql === REQUEST_INSERT_SQL ? { rows: [], rowCount: 1 } : done('{"ok":true}'));

describe('the key check before a write is sent', () => {
  it('a module with a file named like the retire note is sent: the note name is refused only at the key start', async () => {
    at(answeredOk);
    const s = send(planOf(), writeOf({ module: 'm', filename: '.graveyard.json' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.value).toEqual({ ok: true, servedBy: 'BRAVO' });
    expect(count(REQUEST_INSERT_SQL)).toBe(1);
  });

  it('no module and a file named like the retire note: refused, nothing sent', async () => {
    at(answeredOk);
    const s = send(planOf(), writeOf({ module: undefined, filename: '.graveyard.json' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.value).toEqual({ ok: false, code: 'invalid', error: 'The data was not saved: it starts with ".graveyard.json", the name of the note a guild\'s retire writes', sender: true });
    expect(rig.statements).toHaveLength(0);
  });

  it('a .jsonl file is refused for a save, nothing sent', async () => {
    at(answeredOk);
    const s = send(planOf(), writeOf({ filename: 'x.jsonl' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.value).toMatchObject({ ok: false, code: 'invalid', error: 'The data was not saved: a .jsonl file is written by appends only' });
    expect(rig.statements).toHaveLength(0);
  });

  it('no file name under a module path of 1015 bytes is a key of 1016 bytes, within the 1024 limit: sent', async () => {
    at(answeredOk);
    const module = [...Array(5)].map(() => 'a'.repeat(200)).concat('b'.repeat(10)).join('/');
    expect(Buffer.byteLength(module)).toBe(1015);
    const s = send(planOf(), writeOf({ module, filename: undefined }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.value).toEqual({ ok: true, servedBy: 'BRAVO' });
    expect(count(REQUEST_INSERT_SQL)).toBe(1);
  });
});

describe('the connect of the insert', () => {
  it('a connection that takes 20 ms to hand out is taken: the bound is the 5 s step', async () => {
    pool.connectMs = 20;
    at(answeredOk);
    const s = send();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.value).toEqual({ ok: true, servedBy: 'BRAVO' });
  });

  it('a connect with no answer fails at 5 s, not at the deadline', async () => {
    pool.connectMs = Number.POSITIVE_INFINITY;
    const s = send();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(s.value).toEqual({
      ok: false, servedBy: 'BRAVO', sender: true, code: 'backend-unavailable',
      error: NB7_TEXTS.unreachable('BRAVO', 'the database did not take a connection within 5 s', 'saved'),
    });
    expect(s.at).toBe(5000);
  });

  it('a login refused at the connect (28000) is the sender\'s own maintenance answer', async () => {
    rig.connectFails[URL1] = pgError('28000', 'role is not permitted to log in');
    const s = send();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.value).toEqual({ ok: false, code: 'maintenance', sender: true });
  });

  it('a connect refused with SQLSTATE 53300 is unreachable, not maintenance', async () => {
    rig.connectFails[URL1] = pgError('53300', 'sorry, too many clients already');
    const s = send();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.value).toEqual({
      ok: false, servedBy: 'BRAVO', sender: true, code: 'backend-unavailable',
      error: NB7_TEXTS.unreachable('BRAVO', 'SQLSTATE 53300: sorry, too many clients already', 'saved'),
    });
  });
});

describe('a refusal before the insert gives its connection back to the pool of 2', () => {
  async function threeRefusals(plan: () => Plan) {
    const answers: any[] = [];
    for (let i = 0; i < 3; i++) {
      const s = send(plan());
      await vi.advanceTimersByTimeAsync(6000);
      answers.push(s.value);
    }
    return answers;
  }

  it('at the exit: three sends each answer the exit refusal', async () => {
    await endGuildRequests();
    const answers = await threeRefusals(() => planOf());
    for (const a of answers) expect(a).toEqual({ ok: false, code: 'stopping', error: ROUTE_TEXT.exiting, sender: true });
    expect(pool.out).toBe(0);
    expect(rig.statements).toHaveLength(0);
  });

  it('an unprotected transport: three sends each answer the certificate refusal', async () => {
    rig.transport[URL1] = 'unprotected';
    const answers = await threeRefusals(() => planOf());
    for (const a of answers) expect(a).toEqual({ ok: false, servedBy: 'BRAVO', sender: true, code: 'insecure-transport', status: 503, error: NB7_TEXTS.insecure('saved') });
    expect(pool.out).toBe(0);
  });

  it('too little time left: three sends each answer too slow', async () => {
    const answers = await threeRefusals(() => planOf(30_000));
    for (const a of answers) expect(a).toEqual({ ok: false, servedBy: 'BRAVO', sender: true, code: 'backend-unavailable', error: NB7_TEXTS.tooSlow('BRAVO', 'saved') });
    expect(pool.out).toBe(0);
  });
});

describe('the time left at the send', () => {
  it('exactly the answer span plus the 15 s margin (35 s for a write) is enough: the insert is sent', async () => {
    at(answeredOk);
    const s = send(planOf(35_000));
    await vi.advanceTimersByTimeAsync(1000);
    expect(count(REQUEST_INSERT_SQL)).toBe(1);
    expect(s.value).toEqual({ ok: true, servedBy: 'BRAVO' });
  });
});

describe('the settle of an insert with no answer', () => {
  it('a settle statement of 50 ms is answered within its 5 s bound: withdrawn', async () => {
    pool.queryMs = sql => (sql === SETTLE_INSERT_SQL ? 50 : 0);
    at(sql => (sql === REQUEST_INSERT_SQL ? pgError('08006') : sql === SETTLE_INSERT_SQL ? expired() : undefined));
    const s = send();
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.value).toEqual({ ok: false, servedBy: 'BRAVO', sender: true, code: 'backend-unavailable', error: WITHDRAWN });
    expect(count(SETTLE_INSERT_SQL)).toBe(1);
  });

  it('a settle with no answer fails at its 5 s bound and the retry 1 s later withdraws', async () => {
    let settles = 0;
    at(sql => {
      if (sql === REQUEST_INSERT_SQL) return pgError('08006');
      if (sql === SETTLE_INSERT_SQL) return ++settles === 1 ? HANG : expired();
      return undefined;
    });
    const s = send();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(s.value).toEqual({ ok: false, servedBy: 'BRAVO', sender: true, code: 'backend-unavailable', error: WITHDRAWN });
    expect(s.at).toBe(6000);
    expect(settles).toBe(2);
  });

  it('a settle that fails with exactly 1 s left is the last one: can\'t confirm', async () => {
    let settles = 0;
    at(sql => {
      if (sql === REQUEST_INSERT_SQL) return pgError('08006');
      if (sql === SETTLE_INSERT_SQL) return ++settles <= 6 ? HANG : expired();
      return undefined;
    });
    const s = send(planOf(36_000));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(settles).toBe(6);
    expect(s.value).toEqual({ ok: false, servedBy: 'BRAVO', sender: true, code: 'no-answer', noAnswer: 'lost' });
    expect(s.at).toBe(35_000);
  });

  it.each([
    ['withdrew before claim_by', expired(false)],
    ['found not pending', { rows: [] }],
  ])('a settle that %s proves the row is there: a later poll that finds no row is another database, no second settle', async (_name, first) => {
    let settles = 0;
    at(sql => {
      if (sql === REQUEST_INSERT_SQL) return pgError('08006');
      if (sql === SETTLE_INSERT_SQL) return ++settles === 1 ? first : expired();
      if (sql === REQUEST_POLL_SQL) return { rows: [] };
      return undefined;
    });
    const s = send();
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.value).toEqual({ ok: false, servedBy: 'BRAVO', sender: true, code: 'no-answer', noAnswer: 'lost' });
    expect(settles).toBe(1);
    expect(count(SETTLE_UPDATE_SQL)).toBe(0);
  });
});

describe('a done reply that says nothing ran', () => {
  it('not-held read before claim_by passed never proves it: can\'t confirm at the end of the follow', async () => {
    at(sql => (sql === REQUEST_INSERT_SQL ? { rows: [], rowCount: 1 } : done('{"ok":false,"code":"not-held"}')));
    const s = send();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(s.value).toEqual({ ok: false, servedBy: 'BRAVO', sender: true, code: 'no-answer', noAnswer: 'unsettled' });
    expect(s.at).toBe(55_000);
  });

  it('not-taken without unapplied is the holder\'s own answer, passed on', async () => {
    at(sql => (sql === REQUEST_INSERT_SQL ? { rows: [], rowCount: 1 } : done('{"ok":false,"code":"not-taken"}')));
    const s = send();
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.value).toEqual({ ok: false, code: 'not-taken', servedBy: 'BRAVO' });
  });

  it('unapplied with another code, after claim_by: the holder\'s own answer, passed on', async () => {
    at(sql => (sql === REQUEST_INSERT_SQL ? { rows: [], rowCount: 1 } : done('{"ok":false,"code":"conflict","unapplied":true}', { pickup_over: true })));
    const s = send();
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.value).toEqual({ ok: false, code: 'conflict', unapplied: true, servedBy: 'BRAVO' });
  });
});

describe('a request the web UI\'s exit settles', () => {
  it('a settle failed before the exit, the exit\'s own settle withdraws: withdrawn at the exit', async () => {
    let updates = 0;
    at(sql => {
      if (sql === REQUEST_INSERT_SQL) return { rows: [], rowCount: 1 };
      if (sql === SETTLE_UPDATE_SQL) return ++updates === 1 ? new Error('Connection terminated unexpectedly') : expired();
      return pending({ pickup_over: true });
    });
    const s = send();
    await vi.advanceTimersByTimeAsync(10);
    expect(updates).toBe(1);
    const exit = endGuildRequests();
    await vi.advanceTimersByTimeAsync(3000);
    await exit;
    expect(updates).toBe(2);
    expect(s.value).toEqual({ ok: false, servedBy: 'BRAVO', sender: true, code: 'not-taken', error: NB7_TEXTS.withdrawnAtExit('BRAVO', 'saved') });
  });

  it('a settle failed before the exit, the exit finds the row not pending and then expired: an earlier settle withdrew it, not taken', async () => {
    let updates = 0;
    let exited = false;
    at(sql => {
      if (sql === REQUEST_INSERT_SQL) return { rows: [], rowCount: 1 };
      if (sql === SETTLE_UPDATE_SQL) return ++updates === 1 ? new Error('Connection terminated unexpectedly') : { rows: [] };
      return exited ? expired() : pending({ pickup_over: true });
    });
    const s = send();
    await vi.advanceTimersByTimeAsync(10);
    exited = true;
    const exit = endGuildRequests();
    await vi.advanceTimersByTimeAsync(3000);
    await exit;
    expect(updates).toBe(2);
    expect(s.value).toEqual({ ok: false, servedBy: 'BRAVO', sender: true, code: 'not-taken', error: NB7_TEXTS.notTaken('BRAVO', 'saved') });
  });

  it('no settle before the exit, the exit finds the row not pending and then expired: withdrawn at the exit', async () => {
    let exited = false;
    at(sql => {
      if (sql === REQUEST_INSERT_SQL) return { rows: [], rowCount: 1 };
      if (sql === SETTLE_UPDATE_SQL) return { rows: [] };
      return exited ? expired() : pending();
    });
    const s = send();
    await vi.advanceTimersByTimeAsync(10);
    exited = true;
    const exit = endGuildRequests();
    await vi.advanceTimersByTimeAsync(3000);
    await exit;
    expect(count(SETTLE_UPDATE_SQL)).toBe(1);
    expect(s.value).toEqual({ ok: false, servedBy: 'BRAVO', sender: true, code: 'not-taken', error: NB7_TEXTS.withdrawnAtExit('BRAVO', 'saved') });
  });

  it('the row read expired on another server instance than the insert\'s proves nothing: can\'t confirm, logged as such', async () => {
    rig.server[URL1] = 'primary';
    let exited = false;
    at(sql => {
      if (sql === REQUEST_INSERT_SQL) return { rows: [], rowCount: 1 };
      if (sql === SETTLE_UPDATE_SQL) return { rows: [] };
      return exited ? expired() : pending();
    });
    const s = send();
    await vi.advanceTimersByTimeAsync(10);
    rig.server[URL1] = 'promoted standby';
    exited = true;
    const exit = endGuildRequests();
    await vi.advanceTimersByTimeAsync(3000);
    await exit;
    expect(s.value).toEqual({ ok: false, servedBy: 'BRAVO', sender: true, code: 'no-answer', noAnswer: 'stopped' });
    expect(logs).toContain(`[Main] Exiting; can't confirm whether the write of server ${GUILD} sent to BRAVO was saved`);
    expect(logs.some(l => l.includes('withdrew'))).toBe(false);
  });
});
