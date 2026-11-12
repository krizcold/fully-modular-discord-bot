import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RequestsStoppedError,
  UnprotectedTransportError,
  gatedSweepDb,
  reservedSweepDb,
  type SweepDb,
  type SweepGate,
  type SweepPool,
} from '../../src/bot/internalSetup/fleet/guildRequests';
import { ANSWER_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { keepTransportClass } from '../../src/utils/databaseAddress';

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

let epochNow = 1;
const gate: SweepGate = { epoch: () => epochNow, refusal: () => null, stopWhy: () => 'moved' };

function clientWith(query: (config: any) => Promise<any>): FakeClient {
  return { query: vi.fn(query), release: vi.fn() };
}

function poolOf(connect: () => Promise<FakeClient>): SweepPool {
  return { connect } as unknown as SweepPool;
}

async function failureOf(run: Promise<unknown>): Promise<any> {
  try {
    await run;
  } catch (error) {
    return { error };
  }
  throw new Error('the statement did not fail');
}

afterEach(() => {
  epochNow = 1;
  vi.useRealTimers();
});

describe('gatedSweepDb: a failed connect', () => {
  it('the epoch moved during the connect: a stop error marked not sent', async () => {
    const db = gatedSweepDb(poolOf(async () => {
      epochNow = 2;
      throw new Error('connect refused');
    }), gate);
    const { error } = await failureOf(db.query(ANSWER_SQL, [], 2000));
    expect(error).toBeInstanceOf(RequestsStoppedError);
    expect(error.notSent).toBe(true);
    expect(error.why).toBe('moved');
  });

  it('the epoch held: the connect error itself, marked not sent', async () => {
    const cause = new Error('connect refused');
    const db = gatedSweepDb(poolOf(async () => { throw cause; }), gate);
    const { error } = await failureOf(db.query(ANSWER_SQL, [], 2000));
    expect(error).toBe(cause);
    expect(error).not.toBeInstanceOf(RequestsStoppedError);
    expect(error.notSent).toBe(true);
  });

  it('a thrown string becomes an Error marked not sent', async () => {
    const db = gatedSweepDb(poolOf(async () => { throw 'no route'; }), gate);
    const { error } = await failureOf(db.query(ANSWER_SQL, [], 2000));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('no route');
    expect(error.notSent).toBe(true);
  });
});

describe('gatedSweepDb: how the client goes back to the pool', () => {
  it('an unprotected client takes no carried statement and goes back undestroyed', async () => {
    const client = clientWith(async () => ({ rows: [] }));
    keepTransportClass(client, 'unprotected');
    const db = gatedSweepDb(poolOf(async () => client), gate);
    const { error } = await failureOf(db.query(ANSWER_SQL, [], 2000, undefined, true));
    expect(error).toBeInstanceOf(UnprotectedTransportError);
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release.mock.calls).toEqual([[]]);
  });

  it('an answered statement: the client goes back undestroyed', async () => {
    const client = clientWith(async () => ({ rows: [{ a: 1 }] }));
    const db = gatedSweepDb(poolOf(async () => client), gate);
    await expect(db.query(ANSWER_SQL, [], 2000)).resolves.toEqual({ rows: [{ a: 1 }] });
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeUndefined();
  });

  it('an error with no code (a broken socket): the client is destroyed and the error passes on', async () => {
    const cause = new Error('Connection terminated unexpectedly');
    const client = clientWith(async () => { throw cause; });
    const db = gatedSweepDb(poolOf(async () => client), gate);
    const { error } = await failureOf(db.query(ANSWER_SQL, [], 2000));
    expect(error).toBe(cause);
    expect(client.release.mock.calls).toEqual([[true]]);
  });

  it("a server's error with a code: the client goes back undestroyed and the error passes on", async () => {
    const cause = Object.assign(new Error('duplicate key'), { code: '23505' });
    const client = clientWith(async () => { throw cause; });
    const db = gatedSweepDb(poolOf(async () => client), gate);
    const { error } = await failureOf(db.query(ANSWER_SQL, [], 2000));
    expect(error).toBe(cause);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeUndefined();
  });

  it('a rejection with no value: the client is destroyed and the same empty value passes on', async () => {
    const client = clientWith(() => Promise.reject(undefined));
    const db = gatedSweepDb(poolOf(async () => client), gate);
    const { error } = await failureOf(db.query(ANSWER_SQL, [], 2000));
    expect(error).toBeUndefined();
    expect(client.release.mock.calls).toEqual([[true]]);
  });

  it('the epoch moved while an answered statement ran: a stop error marked sent, the client undestroyed', async () => {
    const client = clientWith(async () => {
      epochNow = 2;
      return { rows: [] };
    });
    const db = gatedSweepDb(poolOf(async () => client), gate);
    const { error } = await failureOf(db.query(ANSWER_SQL, [], 2000));
    expect(error).toBeInstanceOf(RequestsStoppedError);
    expect(error.notSent).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeUndefined();
  });

  it('the epoch moved while a failing statement ran: a stop error marked sent', async () => {
    const client = clientWith(async () => {
      epochNow = 2;
      throw Object.assign(new Error('canceling statement'), { code: '57014' });
    });
    const db = gatedSweepDb(poolOf(async () => client), gate);
    const { error } = await failureOf(db.query(ANSWER_SQL, [], 2000));
    expect(error).toBeInstanceOf(RequestsStoppedError);
    expect(error.notSent).toBe(false);
    expect(error.why).toBe('moved');
  });
});

interface Held { text: string; finish: (rows: any[]) => void }

function heldDb(): { db: SweepDb; held: Held[]; sent: string[] } {
  const held: Held[] = [];
  const sent: string[] = [];
  const db: SweepDb = {
    query: text => {
      sent.push(text);
      return new Promise(resolve => { held.push({ text, finish: rows => resolve({ rows }) }); });
    },
  };
  return { db, held, sent };
}

async function until(check: () => boolean, boundMs = 1000): Promise<void> {
  const end = Date.now() + boundMs;
  while (!check()) {
    if (Date.now() > end) throw new Error('the condition did not hold in time');
    await new Promise(resolve => setImmediate(resolve));
  }
}

describe('reservedSweepDb', () => {
  it('a statement that waited too long gives up as not sent, and its slot is not kept', async () => {
    const inner = heldDb();
    const db = reservedSweepDb(inner.db, 1, 20);
    const first = db.query(ANSWER_SQL, ['a'], 2000);
    const { error } = await failureOf(db.query(ANSWER_SQL, ['b'], 2000));
    expect(error.message).toBe('timeout exceeded when trying to connect');
    expect(error.notSent).toBe(true);
    expect(inner.sent).toHaveLength(1);
    inner.held[0].finish([{ n: 1 }]);
    await expect(first).resolves.toEqual({ rows: [{ n: 1 }] });
    const third = db.query(ANSWER_SQL, ['c'], 2000);
    await until(() => inner.sent.length === 2, 500);
    inner.held[1].finish([{ n: 3 }]);
    await expect(third).resolves.toEqual({ rows: [{ n: 3 }] });
  });

  it('a statement handed a slot leaves no wait timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const inner = heldDb();
    const db = reservedSweepDb(inner.db, 1, 5000);
    const first = db.query(ANSWER_SQL, ['a'], 2000);
    const second = db.query(ANSWER_SQL, ['b'], 2000);
    await until(() => vi.getTimerCount() === 1);
    inner.held[0].finish([]);
    await first;
    await until(() => inner.held.length === 2);
    inner.held[1].finish([{ n: 2 }]);
    await expect(second).resolves.toEqual({ rows: [{ n: 2 }] });
    expect(vi.getTimerCount()).toBe(0);
  });
});
