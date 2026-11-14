import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realClient = vi.hoisted(() => ({ make: null as null | ((config: unknown) => unknown) }));
vi.mock('../../src/bot/internalSetup/utils/pgClient', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/pgClient')>();
  return { ...real, shortLivedClient: (config: any) => (realClient.make ? realClient.make(config) : real.shortLivedClient(config)) as any };
});

import { ANSWER_BOUND_MS, CHECK_STATEMENT_MS, largestStatement, type SharedStatement, type SharedTxOutcome, type SharedTxSpec } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { flushBoundMs } from '../../src/bot/internalSetup/utils/storableData';
import {
  _resetRowQueue, configureRowFlush, rowBackend, rowQueue, rowTicketState, useWebuiSessions, webuiSessionsOpen,
  type RowBackend, type WebuiRefusal, type WebuiSessionDeps,
} from '../../src/bot/internalSetup/utils/sharedStore';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

// L5 run A, rp1 chunk of sharedStore.ts: one shared transaction of the web UI on a session of its own (BEGIN and its
// bounds, the check step, ROLLBACK, the destroy of a session that cannot roll back and the mark it keeps), and the
// kick when the web UI's sessions are set. The sessions are fakes that answer as Postgres would: a query with values
// goes out as a prepared statement, which takes one command and exactly as many values as it has placeholders.

const ENTRY = 'postgres://bot:pw@a.example:5432/bot';
const MARGIN_MS = 10_000;

interface Sent { text: string; values: unknown[] | undefined; timeout: number | undefined; session: number; statementTimeout: number | null }

const rig = {
  sent: [] as Sent[],
  ended: [] as number[],
  destroyed: [] as number[],
  sessions: 0,
  connectFault: null as Error | null,
  endHangs: false,
  answer: null as null | ((text: string) => unknown),
  refuseCommit: null as WebuiRefusal | null,
};

function preparedFault(text: string, values: unknown[] | undefined): Error | null {
  if (!values || values.length === 0) return null;
  if (/;\s*\S/.test(text)) return Object.assign(new Error('cannot insert multiple commands into a prepared statement'), { code: '42601' });
  const want = new Set(text.match(/\$\d+/g) ?? []).size;
  if (values.length !== want) {
    return Object.assign(new Error(`bind message supplies ${values.length} parameters, but prepared statement "" requires ${want}`), { code: '08P01' });
  }
  return null;
}

function session() {
  rig.sessions += 1;
  const id = rig.sessions;
  let statementTimeout: number | null = null;
  return {
    connect: async () => {
      if (rig.connectFault) throw rig.connectFault;
    },
    query: async (q: { text: string; values?: unknown[]; query_timeout?: number }) => {
      rig.sent.push({ text: q.text, values: q.values, timeout: q.query_timeout, session: id, statementTimeout });
      const fault = preparedFault(q.text, q.values);
      if (fault) throw fault;
      for (const m of q.text.matchAll(/SET LOCAL statement_timeout = (\d+)/g)) statementTimeout = Number(m[1]);
      const res = await rig.answer?.(q.text);
      if (res instanceof Error) throw res;
      return (res ?? { rows: [], rowCount: 0 }) as { rows: any[] };
    },
    end: () => {
      if (rig.endHangs) return new Promise<void>(() => undefined);
      rig.ended.push(id);
      return Promise.resolve();
    },
    destroy: () => { rig.destroyed.push(id); },
  };
}

function deps(withSession = true): WebuiSessionDeps {
  return {
    target: async () => ({ entry: ENTRY, tag: '1:M', countAtStart: 0 }),
    commitCheck: () => rig.refuseCommit,
    select: async () => ({ rows: [] }),
    tag: () => '1:M',
    ...(withSession ? { session: () => session() } : {}),
  };
}

const st = (text: string, values: unknown[] = []): SharedStatement => ({ text, values });
const plain = (statements: SharedStatement[]): SharedTxSpec => ({ check: null, statements: () => statements });
const tx = (spec: SharedTxSpec): Promise<SharedTxOutcome> => rowBackend()!.sharedTx(spec);
const texts = () => rig.sent.map(s => s.text);
const answered = (code: string, message = 'boom') => Object.assign(new Error(message), { code, severity: 'ERROR' });

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  _resetRowQueue();
  Object.assign(rig, { sent: [], ended: [], destroyed: [], sessions: 0, connectFault: null, endHangs: false, answer: null, refuseCommit: null });
  realClient.make = null;
  setBackendKind('postgres');
  useWebuiSessions(deps());
});

afterEach(() => {
  vi.useRealTimers();
  useWebuiSessions(null);
  configureRowFlush({ backend: () => null });
  _resetRowQueue();
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('a transaction with no check', () => {
  it('commits on one session that is ended, never destroyed, and leaves no session open', async () => {
    const outcome = await tx(plain([st('SELECT 1')]));
    expect(outcome).toMatchObject({ kind: 'committed' });
    const ms = flushBoundMs(largestStatement([st('SELECT 1')]));
    expect(texts()).toEqual([`BEGIN; SET LOCAL statement_timeout = ${ms}`, 'SELECT 1', 'COMMIT']);
    expect(rig.ended).toEqual([1]);
    expect(rig.destroyed).toEqual([]);
    expect(webuiSessionsOpen()).toBe(0);
  });

  it('counts its session open while a statement is on the wire', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    rig.answer = text => (text === 'SELECT 1' ? held : undefined);
    const run = tx(plain([st('SELECT 1')]));
    await vi.waitFor(() => expect(texts()).toContain('SELECT 1'), { timeout: 1000, interval: 5 });
    expect(webuiSessionsOpen()).toBe(1);
    release();
    expect(await run).toMatchObject({ kind: 'committed' });
    expect(webuiSessionsOpen()).toBe(0);
  });

  it("a statement the server refuses fails at the 'statements' step and rolls back", async () => {
    rig.answer = text => (text === 'SELECT broken' ? answered('42P01', 'relation "broken" does not exist') : undefined);
    const outcome = await tx(plain([st('SELECT broken')]));
    expect(outcome).toMatchObject({ kind: 'failed', step: 'statements', code: '42P01' });
    expect(texts().slice(-1)).toEqual(['ROLLBACK']);
    expect(rig.destroyed).toEqual([]);
  });

  it('refused by the check before COMMIT: rolled back on a session that is ended and not destroyed', async () => {
    rig.refuseCommit = { refusal: 'the main database moved', held: false };
    const outcome = await tx(plain([st('SELECT 1')]));
    expect(outcome).toEqual({ kind: 'refused', phase: 'latched', detail: "the web panel cannot use the bot's main database now: the main database moved" });
    expect(texts()).not.toContain('COMMIT');
    expect(texts().slice(-1)).toEqual(['ROLLBACK']);
    expect(rig.ended).toEqual([1]);
    expect(rig.destroyed).toEqual([]);
  });

  it('refused before COMMIT and its ROLLBACK gets no answer: the session is destroyed', async () => {
    rig.refuseCommit = { refusal: 'the main database moved', held: true };
    rig.answer = text => (text === 'ROLLBACK' ? new Error('Connection terminated unexpectedly') : undefined);
    const outcome = await tx(plain([st('SELECT 1')]));
    expect(outcome).toMatchObject({ kind: 'refused', phase: 'held' });
    expect(rig.destroyed).toEqual([1]);
  });
});

describe('a transaction with a check', () => {
  const CHECK = 'SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)';
  const STMT = 'INSERT INTO smdb_data.shared_ops (id) VALUES ($1)';

  it('sends BEGIN, the check under 40 s, the size bound, then the statements, and commits', async () => {
    rig.answer = text => (text === CHECK ? new Promise(resolve => { setTimeout(() => resolve({ rows: [] }), 5); }) : undefined);
    const ms = flushBoundMs(largestStatement([st(STMT, ['op-1'])]));
    const outcome = await tx({ check: [st(CHECK, [['op-0']])], statements: () => [st(STMT, ['op-1'])] });
    expect(outcome).toMatchObject({ kind: 'committed' });
    expect(texts()).toEqual([`BEGIN; SET LOCAL statement_timeout = ${CHECK_STATEMENT_MS}`, CHECK, `SET LOCAL statement_timeout = ${ms}`, STMT, 'COMMIT']);
    const check = rig.sent.find(s => s.text === CHECK)!;
    expect(check.timeout).toBeGreaterThan(ANSWER_BOUND_MS - 5000);
    expect(check.timeout).toBeLessThanOrEqual(ANSWER_BOUND_MS);
    const bound = rig.sent.find(s => s.text === `SET LOCAL statement_timeout = ${ms}`)!;
    expect(bound.timeout).toBe(ms + MARGIN_MS);
    const insert = rig.sent.find(s => s.text === STMT)!;
    expect(insert.statementTimeout).toBe(ms);
    expect(insert.timeout).toBe(ms + MARGIN_MS);
    expect(rig.destroyed).toEqual([]);
  });

  it("a check the server refuses fails at the 'check' step", async () => {
    rig.answer = text => (text === CHECK ? answered('XX000') : undefined);
    const outcome = await tx({ check: [st(CHECK, [['op-0']])], statements: () => [st(STMT, ['op-1'])] });
    expect(outcome).toMatchObject({ kind: 'failed', step: 'check', code: 'XX000' });
    expect(texts()).not.toContain(STMT);
  });

  it('a check that finds the earlier attempt answers landed, rolls back and ends the session undestroyed', async () => {
    const outcome = await tx({ check: [st(CHECK, [['op-0']])], statements: () => 'landed' });
    expect(outcome).toEqual({ kind: 'landed' });
    expect(texts().slice(-1)).toEqual(['ROLLBACK']);
    expect(texts()).not.toContain('COMMIT');
    expect(rig.ended).toEqual([1]);
    expect(rig.destroyed).toEqual([]);
  });
});

describe('a session whose connect fails', () => {
  it("is destroyed, and its mark stays until the connect's bound plus 10 s when its end never answers", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    rig.connectFault = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    rig.endHangs = true;
    const outcome = await tx(plain([st('SELECT 1')]));
    expect(outcome).toMatchObject({ kind: 'failed', step: 'connect' });
    expect(rig.destroyed).toEqual([1]);
    expect(webuiSessionsOpen()).toBe(1);
    vi.advanceTimersByTime(14_999);
    expect(webuiSessionsOpen()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(webuiSessionsOpen()).toBe(0);
  });

  it("on node-postgres's own client, the destroy ends the client's socket", async () => {
    const socketDestroy = vi.fn();
    realClient.make = () => ({
      connect: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
      query: async () => ({ rows: [] }),
      end: async () => undefined,
      connection: { stream: { destroy: socketDestroy } },
    });
    useWebuiSessions(deps(false));
    const outcome = await tx(plain([st('SELECT 1')]));
    expect(outcome).toMatchObject({ kind: 'failed', step: 'connect' });
    expect(socketDestroy).toHaveBeenCalledTimes(1);
  });
});

describe('with no web UI sessions', () => {
  it("a transaction started after they were turned off sends nothing and says this process has no connection", async () => {
    const backend = rowBackend()!;
    useWebuiSessions(null);
    const outcome = await backend.sharedTx(plain([st('SELECT 1')]));
    expect(outcome).toEqual({ kind: 'failed', step: 'connect', detail: "this process has no connection to the bot's database" });
    expect(rig.sessions).toBe(0);
  });
});

describe('setting the web UI sessions', () => {
  async function ticks(n = 20): Promise<void> {
    for (let i = 0; i < n; i++) await new Promise<void>(resolve => { setImmediate(resolve); });
  }
  const accept = (name: string) =>
    rowQueue.accept(`global/rp1w/${name}`, dataPath('global', 'rp1w', name), { body: Buffer.from('{"w":1}') }, { sha: 'absent', caller: true });

  it('sends the ops accepted while they were off', async () => {
    useWebuiSessions(null);
    const t = accept('on.json');
    await ticks();
    expect(rig.sessions).toBe(0);
    useWebuiSessions(deps());
    await vi.waitFor(() => expect(rowTicketState(t)).toBe('landed'), { timeout: 1000, interval: 5 });
    expect(rig.sessions).toBe(1);
    expect(texts()).toContain('COMMIT');
  });

  it('turning them off starts no send', async () => {
    useWebuiSessions(null);
    const pool = { backend: null as RowBackend | null, calls: 0 };
    configureRowFlush({ backend: () => pool.backend });
    const t = accept('off.json');
    await ticks();
    pool.backend = { sharedTx: () => { pool.calls += 1; return new Promise(() => undefined); } };
    useWebuiSessions(null);
    await ticks();
    expect(pool.calls).toBe(0);
    expect(rowTicketState(t)).toBe('open');
  });
});
