import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _setGuildRequestDeps,
  endGuildRequests,
  guildRequestDeps,
  NB7_TEXTS,
  sendGuildChange,
  type RequestConn,
  type RequestDb,
} from '../../src/webui/utils/guildRequests';
import { POLL_SET_SQL, REPLY_READ_SQL, REQUEST_POLL_SQL, SETTLE_INSERT_SQL, SETTLE_UPDATE_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { fakeBot, fakeTime, GUILD, heldRow, isInsert, nb7Rig, requestPlan, resetNb7, writeOf, type Rig } from '../helpers/nb7Rig';

const URL1 = 'postgres://one';
const URL2 = 'postgres://two';
const pgError = (code: string, message = 'refused') => Object.assign(new Error(message), { code });
const poll = (state: string, over: Record<string, unknown> = {}) => ({ rows: [{ state, reply: null, pickup_over: false, answer_over: false, ...over }] });

interface Track {
  created: string[];
  handed: number;
  releases: Array<{ sql?: string; destroy?: boolean }>;
  delayMs: number;
}

function track(): Track {
  const t: Track = { created: [], handed: 0, releases: [], delayMs: 0 };
  const base = guildRequestDeps();
  _setGuildRequestDeps({
    ...base,
    requestDb: (url: string): RequestDb => {
      t.created.push(url);
      const db = base.requestDb(url);
      let ended = false;
      return {
        connect: async (bound: number): Promise<RequestConn> => {
          if (ended) throw new Error('Cannot use a pool after calling end on the pool');
          if (t.delayMs > 0) await new Promise<void>(resolve => { setTimeout(resolve, t.delayMs); });
          const conn = await db.connect(bound);
          t.handed += 1;
          let sql: string | undefined;
          return {
            get server() { return conn.server; },
            get transport() { return conn.transport; },
            query: (text, values, b) => { sql = text; return conn.query(text, values, b); },
            release: destroy => { t.releases.push({ sql, destroy }); conn.release(destroy); },
          };
        },
        end: async () => { ended = true; await db.end(); },
      };
    },
  });
  return t;
}

let rig: Rig;
beforeEach(() => {
  fakeTime();
  vi.advanceTimersByTime(10_000);
  rig = nb7Rig();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  resetNb7();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function send(op: 'write' | 'delete' | 'delete-namespace' | 'restore-graveyard' = 'write', payload: any = writeOf()) {
  const plan = await requestPlan(op);
  const answer = sendGuildChange(fakeBot().bot, plan, { ...payload, op });
  let value: any;
  void answer.then(v => { value = v; });
  return { answer, value: () => value, done: async (ms = 120_000) => { await vi.advanceTimersByTimeAsync(ms); return value; } };
}

const at = (url: string, script: (sql: string, values: unknown[]) => unknown) => { rig.script[url] = script; };
const doneOk = (sql: string) => (isInsert({ sql } as any) ? { rows: [], rowCount: 1 } : poll('done', { reply: '{"ok":true}' }));

describe('the request pool of a database URL', () => {
  it('a request to the web UI\'s current database leaves its pool open after the answer', async () => {
    at(URL1, doneOk);
    const first = await send();
    expect(await first.done(3000)).toMatchObject({ ok: true, servedBy: 'BRAVO' });
    expect(rig.ended).toEqual([]);
    const second = await send();
    expect(await second.done(3000)).toMatchObject({ ok: true, servedBy: 'BRAVO' });
    expect(rig.ended).toEqual([]);
  });

  it('another database\'s pool stays open while a second request still follows its row, and ends after it', async () => {
    rig.holder = () => ({ rows: [heldRow()], url: URL2 });
    const ids: string[] = [];
    let answerSecond = false;
    at(URL2, (sql, values) => {
      if (isInsert({ sql } as any)) {
        ids.push(String(values[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql === REQUEST_POLL_SQL) return values[0] === ids[0] || answerSecond ? poll('done', { reply: '{"ok":true}' }) : poll('pending');
      return undefined;
    });
    const first = await send();
    const second = await send();
    await vi.advanceTimersByTimeAsync(2000);
    expect(first.value()).toMatchObject({ ok: true });
    expect(second.value()).toBeUndefined();
    expect(rig.ended).toEqual([]);
    answerSecond = true;
    expect(await second.done(3000)).toMatchObject({ ok: true });
    expect(rig.ended).toEqual([URL2]);
  });

  it('a pool ended once its last request answered is not used again: the next request opens a new one', async () => {
    const t = track();
    rig.holder = () => ({ rows: [heldRow()], url: URL2 });
    at(URL2, doneOk);
    const first = await send();
    expect(await first.done(3000)).toMatchObject({ ok: true });
    expect(rig.ended).toEqual([URL2]);
    const second = await send();
    expect(await second.done(3000)).toMatchObject({ ok: true, servedBy: 'BRAVO' });
    expect(t.created).toEqual([URL2, URL2]);
  });
});

describe('the stored request body', () => {
  it('a restore with no module or filename stores both as empty strings', async () => {
    at(URL1, doneOk);
    const { done } = await send('restore-graveyard', { guildId: GUILD });
    await done(3000);
    const insert = rig.statements.find(isInsert)!;
    expect(insert.values[6]).toBe('{"module":"","filename":""}');
  });
});

describe('a statement on a connection classed unprotected', () => {
  it('the states-only poll still runs there: the expired row answers not taken', async () => {
    at(URL1, sql => {
      if (isInsert({ sql } as any)) {
        rig.transport[URL1] = 'unprotected';
        return { rows: [], rowCount: 1 };
      }
      return sql === REQUEST_POLL_SQL ? poll('expired', { pickup_over: true }) : undefined;
    });
    const { done } = await send();
    const value = await done(3000);
    expect(value).toMatchObject({ ok: false, code: 'not-taken', error: NB7_TEXTS.notTaken('BRAVO', 'saved') });
    expect(rig.statements.some(s => s.sql === POLL_SET_SQL)).toBe(true);
  });

  it('the reply read refused there gives its connection back', async () => {
    const t = track();
    at(URL1, sql => {
      if (isInsert({ sql } as any)) {
        rig.transport[URL1] = 'unprotected';
        return { rows: [], rowCount: 1 };
      }
      return sql === REQUEST_POLL_SQL ? poll('done', { reply: '{"ok":true}' }) : undefined;
    });
    const { done } = await send();
    const value = await done(120_000);
    expect(value).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'lost' });
    expect(rig.statements.some(s => s.sql === REPLY_READ_SQL)).toBe(false);
    expect(t.releases.some(r => r.sql === undefined)).toBe(true);
    expect(t.releases).toHaveLength(t.handed);
  });
});

describe('the connections of the request pool', () => {
  it('every connection a statement took is given back, and kept for reuse when its statement answered', async () => {
    const t = track();
    at(URL1, doneOk);
    const { done } = await send();
    expect(await done(3000)).toMatchObject({ ok: true });
    expect(t.handed).toBeGreaterThanOrEqual(3);
    expect(t.releases).toHaveLength(t.handed);
    expect(t.releases.filter(r => r.sql === POLL_SET_SQL).length).toBeGreaterThan(0);
    expect(t.releases.every(r => r.destroy !== true)).toBe(true);
  });

  it('a connection whose statement failed is destroyed, never kept', async () => {
    const t = track();
    let polls = 0;
    at(URL1, sql => {
      if (isInsert({ sql } as any)) return { rows: [], rowCount: 1 };
      if (sql === REQUEST_POLL_SQL) return ++polls === 1 ? new Error('Connection terminated unexpectedly') : poll('done', { reply: '{"ok":true}' });
      return undefined;
    });
    const { done } = await send();
    expect(await done(3000)).toMatchObject({ ok: true });
    const pollReleases = t.releases.filter(r => r.sql === POLL_SET_SQL);
    expect(pollReleases[0]).toEqual({ sql: POLL_SET_SQL, destroy: true });
    expect(pollReleases.slice(1).every(r => r.destroy !== true)).toBe(true);
    expect(t.releases).toHaveLength(t.handed);
  });

  it('a statement\'s bound counts the wait for its connection', async () => {
    const t = track();
    t.delayMs = 300;
    at(URL1, doneOk);
    const { done } = await send();
    expect(await done(5000)).toMatchObject({ ok: true });
    expect(rig.statements.find(s => s.sql === POLL_SET_SQL)!.boundMs).toBe(1700);
    expect(rig.statements.find(s => s.sql === REPLY_READ_SQL)!.boundMs).toBe(4700);
  });
});

describe('the poll per pool', () => {
  it('leaves no timer behind once the request answered', async () => {
    at(URL1, doneOk);
    const before = vi.getTimerCount();
    const { done } = await send();
    expect(await done(1000)).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(before);
  });

  it('sends no poll while its one request waits on its settle', async () => {
    let settles = 0;
    at(URL1, sql => {
      if (isInsert({ sql } as any)) return { rows: [], rowCount: 1 };
      if (sql === REQUEST_POLL_SQL) return poll('pending', { pickup_over: true });
      if (sql === SETTLE_UPDATE_SQL) {
        settles += 1;
        return new Error('Connection terminated unexpectedly');
      }
      return undefined;
    });
    const { done } = await send();
    await vi.advanceTimersByTimeAsync(5000);
    expect(settles).toBeGreaterThanOrEqual(3);
    expect(rig.statements.filter(s => s.sql === POLL_SET_SQL)).toHaveLength(1);
    expect(await done(120_000)).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'lost' });
  });
});

describe('the settle', () => {
  it('an exit settle that found the row not pending, then the row read expired: withdrawn at the exit', async () => {
    let stopped = false;
    at(URL1, sql => {
      if (isInsert({ sql } as any)) return { rows: [], rowCount: 1 };
      if (sql === SETTLE_UPDATE_SQL) return { rows: [] };
      if (sql === REQUEST_POLL_SQL) return stopped ? poll('expired', { pickup_over: true }) : poll('pending');
      return undefined;
    });
    const { done } = await send();
    await vi.advanceTimersByTimeAsync(600);
    expect(rig.statements.some(s => s.sql === SETTLE_UPDATE_SQL || s.sql === SETTLE_INSERT_SQL)).toBe(false);
    stopped = true;
    void endGuildRequests();
    const value = await done(3000);
    expect(value).toMatchObject({ ok: false, code: 'not-taken', error: NB7_TEXTS.withdrawnAtExit('BRAVO', 'saved') });
  });

  it('an insert-form settle that returned the row makes the next settle the update form', async () => {
    at(URL1, sql => {
      if (isInsert({ sql } as any)) return pgError('08006');
      if (sql === SETTLE_INSERT_SQL) return { rows: [{ state: 'expired', pickup_over: false }] };
      if (sql === SETTLE_UPDATE_SQL) return { rows: [{ state: 'expired', pickup_over: true }] };
      if (sql === REQUEST_POLL_SQL) return poll('pending', { pickup_over: true });
      return undefined;
    });
    const { done } = await send();
    const value = await done(5000);
    expect(value).toMatchObject({ ok: false, code: 'backend-unavailable', error: NB7_TEXTS.withdrawn('BRAVO', 'saved') });
    expect(rig.statements.filter(s => s.sql === SETTLE_INSERT_SQL || s.sql === SETTLE_UPDATE_SQL).map(s => s.sql)).toEqual([SETTLE_INSERT_SQL, SETTLE_UPDATE_SQL]);
  });
});
