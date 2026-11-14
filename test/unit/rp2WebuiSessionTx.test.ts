import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import {
  _resetRowQueue, configureRowFlush, latestRowTicket, rowBackend, rowQueue, rowTicketState, useWebuiSessions,
  type WebuiRefusal, type WebuiSessionClient,
} from '../../src/bot/internalSetup/utils/sharedStore';
import { cancelQueued } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { ANSWER_BOUND_MS, type SharedStatement, type SharedTxSpec } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { FLUSH_STATEMENT_BYTES, flushBoundMs } from '../../src/bot/internalSetup/utils/storableData';
import { setBackendKind } from '../helpers/backendKind';

// L5 run A, chunk rp2 (sharedStore.ts): the web UI's shared transaction on a session of its own (its size bounds,
// results, rollbacks, destroys and timeout answers), its read with no sessions, and the land-or-cancel's path match.

type Q = { text: string; values?: unknown[]; query_timeout?: number };
const MARGIN_MS = 10_000;
const ENTRY = 'postgres://bot@db:5432/bot';

const bytesOf = (st: SharedStatement) =>
  Buffer.byteLength(st.text) + st.values.reduce<number>((n, v) => n + (Buffer.isBuffer(v) ? v.length : v == null ? 0 : Buffer.byteLength(String(v))), 0);
const st = (text: string, values: unknown[] = [], next?: SharedStatement['next']): SharedStatement => ({ text, values, next });

function rig(answer?: (q: Q) => unknown, commitRefusal: WebuiRefusal | null = null) {
  const sent: Q[] = [];
  const destroyed: number[] = [];
  const client: WebuiSessionClient = {
    connect: async () => undefined,
    query: async q => {
      sent.push(q);
      const a = await answer?.(q);
      if (a instanceof Error) throw a;
      return (a ?? { rows: [], rowCount: 0 }) as { rows: any[] };
    },
    end: async () => undefined,
    destroy: () => { destroyed.push(1); },
  };
  useWebuiSessions({
    target: async () => ({ entry: ENTRY, tag: '1:ALPHA', countAtStart: 0 }),
    commitCheck: () => commitRefusal,
    select: async () => ({ rows: [] }),
    tag: () => '1:ALPHA',
    session: () => client,
  });
  setBackendKind('postgres');
  const backend = rowBackend()!;
  const tx = (statements: SharedStatement[], more: Partial<SharedTxSpec> = {}) => backend.sharedTx({ check: null, statements: () => statements, ...more });
  return { backend, sent, destroyed, tx, texts: () => sent.map(q => q.text) };
}

const pgError = (code: string, message = 'boom') => Object.assign(new Error(message), { code, severity: 'ERROR' });

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  _resetRowQueue();
  configureRowFlush({ backend: () => null });
});

afterEach(() => {
  useWebuiSessions(null);
  configureRowFlush({ backend: () => null });
  _resetRowQueue();
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('the size bound of a web UI shared transaction', () => {
  it('sends the bound once in BEGIN for statements of one size, and answers their results in order', async () => {
    const r = rig(q => (q.text.startsWith('SELECT') ? { rows: [{ v: q.text }], rowCount: 1 } : undefined));
    const a = st('SELECT 1 AS a');
    const b = st('SELECT 2 AS b');
    const ms = flushBoundMs(bytesOf(a));
    const outcome = await r.tx([a, b]);
    expect(r.texts()).toEqual([`BEGIN; SET LOCAL statement_timeout = ${ms}`, a.text, b.text, 'COMMIT']);
    expect(outcome.kind === 'committed' && outcome.results.map(x => x.rows)).toEqual([[{ v: a.text }], [{ v: b.text }]]);
  });

  it('sends no new bound for a statement smaller than the largest', async () => {
    const r = rig();
    const small = st('SELECT 1');
    const large = st('INSERT INTO smdb_data.shared_ops (id) VALUES ($1)', ['x'.repeat(100)]);
    const outcome = await r.tx([small, large]);
    expect(outcome.kind).toBe('committed');
    expect(r.texts()).toEqual([`BEGIN; SET LOCAL statement_timeout = ${flushBoundMs(bytesOf(large))}`, small.text, large.text, 'COMMIT']);
  });

  it('a larger statement added by next raises the bound first: SET LOCAL with no values and its client bound', async () => {
    const r = rig();
    const big = st('INSERT INTO smdb_data.shared_docs (key, body) VALUES ($1, $2)', ['k', Buffer.alloc(20_000, 0x61)]);
    const first = st('SELECT 1', [], () => [big]);
    const ms0 = flushBoundMs(bytesOf(first));
    const ms1 = flushBoundMs(bytesOf(big));
    expect(ms1).toBeGreaterThan(ms0);
    const outcome = await r.tx([first]);
    expect(outcome.kind).toBe('committed');
    expect(r.texts()).toEqual([`BEGIN; SET LOCAL statement_timeout = ${ms0}`, first.text, `SET LOCAL statement_timeout = ${ms1}`, big.text, 'COMMIT']);
    const raise = r.sent[2];
    expect(raise.values).toEqual([]);
    expect(raise.query_timeout).toBe(ms1 + MARGIN_MS);
    expect(r.sent[3].query_timeout).toBe(ms1 + MARGIN_MS);
    expect(r.sent[1].query_timeout).toBe(ms0 + MARGIN_MS);
  });

  it('COMMIT goes with no values under the 40 s answer bound', async () => {
    const r = rig();
    await r.tx([st('SELECT 1')]);
    const commit = r.sent[r.sent.length - 1];
    expect(commit.text).toBe('COMMIT');
    expect(commit.values).toEqual([]);
    expect(commit.query_timeout).toBe(ANSWER_BOUND_MS);
  });
});

describe('a web UI shared transaction that ends before COMMIT', () => {
  it('an oversize statement from next is not sent: failed build, rolled back, the session kept', async () => {
    const r = rig();
    const huge = st('INSERT INTO smdb_data.shared_docs (key, body) VALUES ($1, $2)', ['k', Buffer.alloc(FLUSH_STATEMENT_BYTES + 1, 0x62)]);
    const outcome = await r.tx([st('SELECT 1', [], () => [huge])]);
    expect(outcome).toMatchObject({ kind: 'failed', step: 'build', detail: expect.stringContaining('it was not sent') });
    expect(r.texts()).not.toContain(huge.text);
    expect(r.texts()).not.toContain('COMMIT');
    expect(r.texts()[r.texts().length - 1]).toBe('ROLLBACK');
    expect(r.destroyed).toEqual([]);
  });

  it('a next that throws: failed build, rolled back, the session kept', async () => {
    const r = rig();
    const outcome = await r.tx([st('SELECT 1', [], () => { throw new Error('no plan'); })]);
    expect(outcome).toEqual({ kind: 'failed', step: 'build', detail: 'no plan' });
    expect(r.texts()[r.texts().length - 1]).toBe('ROLLBACK');
    expect(r.destroyed).toEqual([]);
  });

  it('a next that stops: stopped, rolled back, the session kept', async () => {
    const r = rig();
    const outcome = await r.tx([st('SELECT 1', [], () => ({ stop: 'enough' }))]);
    expect(outcome).toEqual({ kind: 'stopped', value: 'enough' });
    expect(r.texts()[r.texts().length - 1]).toBe('ROLLBACK');
    expect(r.destroyed).toEqual([]);
  });

  it('the check before COMMIT refuses: refused, rolled back, COMMIT not sent, the session kept', async () => {
    const r = rig(undefined, { refusal: 'the main moved', held: false });
    const outcome = await r.tx([st('SELECT 1')]);
    expect(outcome).toMatchObject({ kind: 'refused', phase: 'latched' });
    expect(r.texts()).not.toContain('COMMIT');
    expect(r.texts()[r.texts().length - 1]).toBe('ROLLBACK');
    expect(r.destroyed).toEqual([]);
  });

  it('a statement the server answered with an error: rolled back, the session kept, no timeout answer', async () => {
    const r = rig(q => (q.text.startsWith('INSERT') ? pgError('23505', 'duplicate key') : undefined));
    const outcome = await r.tx([st('INSERT INTO smdb_data.shared_ops (id) VALUES ($1)', ['op-1'])]);
    expect(outcome).toMatchObject({ kind: 'failed', step: 'statements', code: '23505' });
    expect(outcome).not.toHaveProperty('timeout');
    expect(r.texts()[r.texts().length - 1]).toBe('ROLLBACK');
    expect(r.destroyed).toEqual([]);
  });

  it('a statement timeout (57014) answers its timeout, at a frozen clock elapsed 0 and not at the bound', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(500_000);
    const r = rig(q => (q.text.startsWith('INSERT') ? pgError('57014', 'canceling statement due to statement timeout') : undefined));
    const outcome = await r.tx([st('INSERT INTO smdb_data.shared_ops (id) VALUES ($1)', ['op-1'])]);
    expect(outcome).toMatchObject({ kind: 'failed', step: 'statements', code: '57014' });
    const timeout = (outcome as { timeout?: { elapsedMs: number; atBound: boolean } }).timeout;
    expect(timeout).toBeDefined();
    expect(timeout!.elapsedMs).toBe(0);
    expect(timeout!.atBound).toBe(false);
    expect(r.texts()).not.toContain('COMMIT');
  });
});

describe('a web UI COMMIT whose answer is lost', () => {
  it('is unknown and the session is destroyed, with no ROLLBACK', async () => {
    const r = rig(q => (q.text === 'COMMIT' ? Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) : undefined));
    const outcome = await r.tx([st('SELECT 1')]);
    expect(outcome).toMatchObject({ kind: 'unknown' });
    expect(r.texts()).not.toContain('ROLLBACK');
    expect(r.destroyed).toEqual([1]);
  });
});

describe('the web UI read with no sessions', () => {
  it('rejects with the words that this process has no connection to the database', async () => {
    const { backend } = rig();
    useWebuiSessions(null);
    await expect(backend.sharedSelect!('SELECT 1', [], 1000)).rejects.toThrow("this process has no connection to the bot's database");
  });
});

describe("the land-or-cancel's path match", () => {
  it("a cancel of a file the row queue does not hold leaves another file's queued row op alone", async () => {
    const key = 'global/rp2cancel/held.json';
    const held = dataPath('global', 'rp2cancel', 'held.json');
    const other = dataPath('global', 'rp2cancel', 'other.json');
    rowQueue.accept(key, held, { body: Buffer.from('{"a":1}') }, { sha: 'absent', caller: false });
    const ticket = latestRowTicket(key)!;
    expect(rowTicketState(ticket)).toBe('open');
    const answers = await cancelQueued([other]);
    expect(answers).toEqual([{ path: other, outcome: 'landed' }]);
    expect(rowTicketState(ticket)).toBe('open');
    const cancelled = await cancelQueued([held]);
    expect(cancelled).toMatchObject([{ path: held, outcome: 'cancelled', row: true }]);
    expect(rowTicketState(ticket)).toBe('refused');
  });
});
