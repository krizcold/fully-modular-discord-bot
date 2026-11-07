import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { batchExistsAnswer, isBatch, isBatchExists, isBegin, isFenced, isLive, isMove } from '../helpers/nb11ScriptedPg';

// NB11 (wip-redesign/sheets/NB11.md): how a failed statement is named in the outage line and classified as an answer
// or no answer, and the statement and commit floors of a bounded transaction, over a client that records each
// statement's parameters and can reject with any value.

const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 };
const backends: PostgresBackend[] = [];
let errorSpy: ReturnType<typeof vi.spyOn>;

type Reply = { rows?: unknown[]; rowCount?: number } | { reject: unknown } | undefined;

function rig(answer: (sql: string) => Reply) {
  const backend = new PostgresBackend(fixedDatabase('postgres://nobody@127.0.0.1:9/none'));
  backends.push(backend);
  const internals = backend as unknown as { state: string; provisioned: boolean };
  internals.state = 'ready';
  internals.provisioned = true;
  const sent: { sql: string; values: unknown; timeout?: number }[] = [];
  const releases: (boolean | undefined)[] = [];
  const client = {
    query: (config: string | { text: string; values?: unknown; query_timeout?: number }, values?: unknown) => {
      const sql = (typeof config === 'string' ? config : config.text).trim();
      sent.push({ sql, values: typeof config === 'string' ? values : config.values, timeout: typeof config === 'string' ? undefined : config.query_timeout });
      const res = answer(sql);
      if (res && 'reject' in res) return Promise.reject(res.reject);
      return Promise.resolve(res ?? { rows: [], rowCount: 0 });
    },
    release: (destroy?: boolean) => { releases.push(destroy); },
  };
  const connect = vi.fn(async () => client);
  (backend.getPool() as unknown as { connect: unknown }).connect = connect;
  return { backend, sent, releases, connect, statements: () => sent.map(s => s.sql) };
}

const serverError = (code: string | undefined, severity: string | undefined, message = 'scripted') => {
  const error = new Error(message) as Error & { code?: string; severity?: string };
  if (code !== undefined) error.code = code;
  if (severity !== undefined) error.severity = severity;
  return error;
};

/** A thrown value that is no object and whose severity must never be read. */
function untouchable(): unknown {
  const fn = function notAnError() {};
  Object.defineProperty(fn, 'severity', { get() { throw new Error('severity read on a value that is no object'); } });
  return fn;
}

const emptyBatch = { upserts: [], deletes: [], appends: [] } as any;

function happy(override: (sql: string) => Reply | null = () => null) {
  return (sql: string): Reply => {
    const own = override(sql);
    if (own !== null) return own;
    if (isFenced(sql)) return { rows: [], rowCount: 1 };
    if (isBatch(sql)) return { rows: [{ retired_at: '5' }], rowCount: 1 };
    if (isBatchExists(sql)) return batchExistsAnswer(sql, true) as Reply;
    if (isLive(sql)) return { rows: [{ present: false }], rowCount: 1 };
    if (isMove(sql)) return { rows: [{ taken: '3', put: '3', reason: 'r' }], rowCount: 1 };
    return undefined;
  };
}

const outageLines = (): string[] => errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((line: string) => line.includes('entering outage'));

async function flushFailingWith(value: unknown) {
  const { backend } = rig(sql => (isFenced(sql) ? { reject: value } : undefined));
  const answer = await backend.flushGuild('1', emptyBatch, token);
  return { answer, said: outageLines(), state: backend.connectionState().state };
}

const CONNECTION = '[PostgresBackend] Database connection failed; entering outage:';
const operation = (code: string) => `[PostgresBackend] Database operation failed (SQLSTATE ${code}); entering outage:`;

describe('real clock', () => {
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const backend of backends.splice(0)) await backend.stop();
  });

  describe('the outage line a failed flush writes', () => {
    it("pg's own query timeout says the database did not answer in time", async () => {
      const { answer, said } = await flushFailingWith(new Error('Query read timeout'));
      expect(answer).toMatchObject({ ok: false, reason: 'unavailable' });
      expect(said).toEqual(['[PostgresBackend] Database did not answer in time; entering outage:']);
    });

    it('a rejection with null still answers unavailable and says the connection failed', async () => {
      const { answer, said, state } = await flushFailingWith(null);
      expect(answer).toMatchObject({ ok: false, reason: 'unavailable' });
      expect(said).toEqual([CONNECTION]);
      expect(state).toBe('outage');
    });

    it('a rejection with a value that is no object is not inspected: unavailable, connection failed', async () => {
      const { answer, said } = await flushFailingWith(untouchable());
      expect(answer).toMatchObject({ ok: false, reason: 'unavailable' });
      expect(said).toEqual([CONNECTION]);
    });

    it.each([
      ['FATAL 40001', '40001', 'FATAL'],
      ['PANIC 58030', '58030', 'PANIC'],
      ['ERROR 57P01', '57P01', 'ERROR'],
      ['ERROR 57P02', '57P02', 'ERROR'],
      ['ERROR 57P03', '57P03', 'ERROR'],
      ['ERROR 08006', '08006', 'ERROR'],
      ['a code with no severity', '23505', undefined],
    ] as const)('%s lost the session: the line says the connection failed', async (_name, code, severity) => {
      const { said } = await flushFailingWith(serverError(code, severity));
      expect(said).toEqual([CONNECTION]);
    });

    it.each([
      ['ERROR 22008 (08 not at the start)', '22008', 'ERROR'],
      ['ERROR 57P04', '57P04', 'ERROR'],
      ['ERROR 40001', '40001', 'ERROR'],
    ] as const)('%s was answered: no hold and no outage line (NB5 decision 13)', async (_name, code, severity) => {
      const { said, state } = await flushFailingWith(serverError(code, severity));
      expect(said).toEqual([]);
      expect(state).toBe('ready');
    });
  });

  describe('a restore whose move fails: answered or no answer', () => {
    async function restoreFailingWith(value: unknown) {
      const run = rig(happy(sql => (isMove(sql) ? { reject: value } : null)));
      const answer = await run.backend.restoreGuild('1', null, token, () => null, process.hrtime.bigint() + 40_000_000_000n);
      return { answer, statements: run.statements(), state: run.backend.connectionState().state, releases: run.releases };
    }

    it('a rejection with null answers unavailable and notes the outage', async () => {
      const { answer, statements, state, releases } = await restoreFailingWith(null);
      expect(answer).toEqual({ ok: false, reason: 'unavailable', detail: 'null' });
      expect(statements).not.toContain('COMMIT');
      expect(state).toBe('outage');
      expect(releases).toEqual([true]);
    });

    it('a rejection with a value that is no object answers unavailable without reading it', async () => {
      const { answer, state } = await restoreFailingWith(untouchable());
      expect(answer).toMatchObject({ ok: false, reason: 'unavailable' });
      expect(state).toBe('outage');
    });

    it.each([
      ['FATAL 40001', '40001', 'FATAL'],
      ['PANIC 40001', '40001', 'PANIC'],
      ['ERROR 57P01', '57P01', 'ERROR'],
      ['ERROR 57P02', '57P02', 'ERROR'],
      ['ERROR 57P03', '57P03', 'ERROR'],
      ['ERROR 08006', '08006', 'ERROR'],
      ['localized FEHLER 58030', '58030', 'FEHLER'],
    ] as const)('%s is no answer: unavailable, no COMMIT, the outage noted', async (_name, code, severity) => {
      const { answer, statements, state } = await restoreFailingWith(serverError(code, severity));
      expect(answer).toMatchObject({ ok: false, reason: 'unavailable' });
      expect(answer).not.toHaveProperty('code');
      expect(statements).not.toContain('COMMIT');
      expect(state).toBe('outage');
    });

    it.each([
      ['ERROR 22008 (08 not at the start)', '22008', 'ERROR'],
      ['localized FEHLER 22058 (58 not at the start)', '22058', 'FEHLER'],
      ['localized FEHLER 22053 (53 not at the start)', '22053', 'FEHLER'],
      ['ERROR 57P04', '57P04', 'ERROR'],
    ] as const)('%s was answered: refused with its code, the backend stays ready', async (_name, code, severity) => {
      const { answer, state } = await restoreFailingWith(serverError(code, severity, 'scripted refusal'));
      expect(answer).toEqual({ ok: false, reason: 'refused', detail: `SQLSTATE ${code}: scripted refusal`, code });
      expect(state).toBe('ready');
    });
  });

  describe('statements sent with no parameters', () => {
    it('BEGIN, COMMIT and a closing ROLLBACK carry an empty parameter list', async () => {
      const done = rig(happy());
      expect(await done.backend.restoreGuild('1', null, token, () => null, process.hrtime.bigint() + 40_000_000_000n)).toMatchObject({ ok: true });
      expect(done.sent.find(s => isBegin(s.sql))?.values).toEqual([]);
      expect(done.sent.find(s => s.sql === 'COMMIT')?.values).toEqual([]);

      const empty = rig(happy(sql => (isBatch(sql) ? { rows: [{ retired_at: null }], rowCount: 1 } : null)));
      expect(await empty.backend.restoreGuild('1', null, token, () => null, process.hrtime.bigint() + 40_000_000_000n)).toEqual({ ok: false, reason: 'no-entry' });
      const rollback = empty.sent.find(s => s.sql === 'ROLLBACK');
      expect(rollback).toBeDefined();
      expect(rollback!.values).toEqual([]);
    });
  });
});

describe('the floors with exactly the floor left (frozen monotonic clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'hrtime', 'performance', 'Date'] });
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const backend of backends.splice(0)) await backend.stop();
  });

  const exactly = (ms: number) => process.hrtime.bigint() + BigInt(ms) * 1_000_000n;

  it('the clock is frozen, so the time left is exactly what was given', () => {
    const before = process.hrtime.bigint();
    expect(process.hrtime.bigint()).toBe(before);
  });

  it('a restore with exactly the commit floor (2 s) left sends COMMIT and restores', async () => {
    const { backend, statements, sent } = rig(happy());
    expect(await backend.restoreGuild('1', null, token, () => null, exactly(2000))).toMatchObject({ ok: true, copied: 3, retiredAt: 5 });
    expect(statements()).toContain('COMMIT');
    expect(sent.find(s => s.sql === 'COMMIT')?.timeout).toBe(2000);
  });

  it('a restore with exactly the statement floor (1 s) left sends BEGIN and its closing ROLLBACK', async () => {
    const { backend, statements, releases } = rig(happy(sql => (isBatch(sql) ? { rows: [{ retired_at: null }], rowCount: 1 } : null)));
    expect(await backend.restoreGuild('1', null, token, () => null, exactly(1000))).toEqual({ ok: false, reason: 'no-entry' });
    expect(statements()[0]).toBe('BEGIN');
    expect(statements()).toContain('ROLLBACK');
    expect(releases).toEqual([undefined]);
  });

  it('a retire with exactly the statement floor (1 s) left connects and sends BEGIN', async () => {
    const { backend, statements, connect } = rig(sql => (isFenced(sql) ? { rows: [], rowCount: 1 } : undefined));
    expect(await backend.retireGuild('1', 'test', token, exactly(1000))).toEqual({ ok: false, reason: 'out-of-time' });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(statements()[0]).toBe('BEGIN');
    expect(statements()).not.toContain('COMMIT');
  });
});
