import { EventEmitter } from 'events';
import { syncBuiltinESMExports } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statementBytes, watchSession, type PgSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, JOURNAL, MARKER, PG_URL, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson } from '../helpers/migrationRig';

// NB3 L5 round 2: the statement bytes of an escaped array element, a timer handle without unref, a stale watchdog
// timer after a probe expired the statements, and the savepoint each readable superseded meta releases.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('statementBytes counts the escapes of a string array element', () => {
  it('counts braces, quotes and one byte per escaped character', () => {
    expect(statementBytes('x', [['a"b']])).toBe(1 + 2 + 3 + 2 + 1);
    expect(statementBytes('x', [['\\\\', 'q']])).toBe(1 + 2 + 1 + (2 + 2 + 2) + (1 + 2));
  });
});

describe('watchSession with a timer handle that has no unref', () => {
  it('answers the statement when setTimeout returns a plain number', async () => {
    vi.stubGlobal('setTimeout', () => 1);
    vi.stubGlobal('clearTimeout', () => undefined);
    const session = {
      query: async () => ({ rows: [{ n: 1 }] }),
      end: async () => undefined,
    } as unknown as PgSession;
    const w = watchSession(session, 1000);
    let answer: unknown;
    expect(() => { answer = w.query('SELECT 1'); }).not.toThrow();
    await expect(answer).resolves.toEqual({ rows: [{ n: 1 }] });
  });
});

describe('the watchdog after a probe expired its statements', () => {
  it('makes no second probe when the stale timer of the expired statement fires', async () => {
    vi.useFakeTimers();
    const stream = Object.assign(new EventEmitter(), { bytesWritten: 0, writableLength: 0, destroy() { /* gone */ } });
    const pending: Array<(v: unknown) => void> = [];
    const session = {
      query: () => new Promise(resolve => { pending.push(resolve); }),
      end: async () => undefined,
      connection: { stream },
    } as unknown as PgSession;
    const answers: Array<(v: boolean) => void> = [];
    let calls = 0;
    const busy = () => { calls += 1; return new Promise<boolean>(resolve => { answers.push(resolve); }); };
    const w = watchSession(session, 100, busy);

    const a = w.query('SELECT 1');
    a.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(1);
    pending[0]({ rows: [] });
    await flush();
    await vi.advanceTimersByTimeAsync(10);

    let bError = '';
    w.query('SELECT 2').catch((e: Error) => { bError = e.message; });
    vi.setSystemTime(Date.now() + 100);
    answers[0](false);
    await flush();
    expect(bError).toBe('The SELECT got no answer from the database within 0.1 s');
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toBe(1);
  });
});

describe('S0 releases the savepoint of each superseded meta it read', () => {
  beforeEach(() => {
    wipeRoot();
    useDatabaseUrl(PG_URL);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('sends RELEASE SAVEPOINT, never ROLLBACK TO SAVEPOINT, for readable metas', async () => {
    writeJson(MARKER, { live: 'postgres', storeId: 'src-1', flippedAt: 1 });
    writeJson(JOURNAL, {
      jobId: 'job-r2-file001', to: 'file', stage: 'switching', result: 'interrupted', error: 'x', startedAt: 1,
      sourceStoreId: 'src-1', source: { host: 'db.example', port: 5432, database: 'smdb' },
    });
    seedFile('.env', 'DATA_BACKEND=postgres\n');
    const db = new FakeDb();
    db.schemas.set('smdb_superseded_1', emptyStore('other-1'));
    db.schemas.set('smdb_superseded_2', emptyStore('other-2'));
    const jobId = 'job-r2-new0001';
    const answer = await serviceFor(db, new FakeHost()).post({ jobId, to: 'file' });
    expect(answer.body.error).toBe("can't confirm; neither smdb_data nor a superseded schema holds store src-1");
    const sent = db.statements(`smdb-migrate:${jobId}`);
    expect(sent.filter(s => s === 'RELEASE SAVEPOINT superseded_meta')).toHaveLength(2);
    expect(sent.filter(s => s.startsWith('ROLLBACK TO SAVEPOINT'))).toEqual([]);
  });
});
