import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend, type SharedStatement } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { FLUSH_STATEMENT_BYTES } from '../../src/bot/internalSetup/utils/storableData';
import { fixedDatabase } from '../helpers/fixedDatabase';

const backends: PostgresBackend[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const b of backends.splice(0)) await b.stop();
});

const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'p-a', shardId: 2, shardCount: 4 };
const FLUSH_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

interface Sent { sql: string; params?: unknown[] }
type Answer = unknown | Error;

function rig(answer: (sql: string, params?: unknown[]) => Answer, onRelease?: (destroy?: boolean) => void) {
  const backend = new PostgresBackend(fixedDatabase('postgres://nobody@127.0.0.1:9/none'));
  backends.push(backend);
  (backend as unknown as { state: string }).state = 'ready';
  const sent: Sent[] = [];
  const releases: Array<boolean | undefined> = [];
  const holds: Array<string | null> = [];
  backend.onHoldChanged(words => { holds.push(words); });
  const client = {
    query: (q: string | { text: string; values?: unknown[] }, params?: unknown[]) => {
      const sql = (typeof q === 'string' ? q : q.text).trim();
      const values = params ?? (typeof q === 'string' ? undefined : q.values);
      sent.push({ sql, params: values });
      const res = answer(sql, values);
      if (res instanceof Error) return Promise.reject(res);
      return Promise.resolve(res ?? { rows: [], rowCount: 0 });
    },
    release: (destroy?: boolean) => {
      releases.push(destroy);
      onRelease?.(destroy);
    },
    end: () => Promise.resolve(),
  };
  (backend.getPool() as unknown as { connect: unknown }).connect = async () => client;
  return { backend, sent, releases, holds };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise(resolve => setImmediate(resolve));
  expect(done()).toBe(true);
}
const settle = () => new Promise(resolve => setImmediate(resolve));

const readSql = /^SELECT claim, last_flush\b[\s\S]*FROM smdb_data\.guild_ownership WHERE guild_id = \$1 FOR SHARE$/;
const insertSql = /^INSERT INTO smdb_data\.guild_ownership/;
const row = (claim: unknown, mark: string | null, nodeId?: string) =>
  ({ rows: [{ claim, last_flush: mark, ...(nodeId ? { node_id: nodeId } : {}) }], rowCount: 1 });
const answered = (code: string, message = 'server error') => Object.assign(new Error(message), { code, severity: 'ERROR' });

describe('resolveFlush: the check and its flush place', () => {
  it('sends BEGIN, both reads and ROLLBACK with the right values', async () => {
    let reads = 0;
    const { backend, sent } = rig(sql => readSql.test(sql) ? (++reads === 1 ? { rows: [], rowCount: 0 } : row('7', OTHER_ID)) : undefined);
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, token)).toEqual({ fate: 'not-landed' });
    await until(() => sent.some(s => s.sql === 'ROLLBACK'));
    expect(sent.find(s => s.sql === 'BEGIN')?.params).toEqual([]);
    expect(sent.filter(s => readSql.test(s.sql)).map(s => s.params)).toEqual([['g1'], ['g1']]);
    expect(sent.find(s => s.sql === 'ROLLBACK')?.params).toEqual([]);
  });

  it('an insert that adds the row ends the check with ROLLBACK, gives the client back and frees the place', async () => {
    const { backend, sent, releases } = rig(sql => readSql.test(sql) ? { rows: [], rowCount: 0 } : insertSql.test(sql) ? { rows: [], rowCount: 1 } : undefined);
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, token)).toEqual({ fate: 'not-landed' });
    await until(() => releases.length === 1);
    await settle();
    expect(sent.map(s => s.sql.split(/\s+/)[0])).toEqual(['BEGIN', 'SELECT', 'INSERT', 'ROLLBACK']);
    expect(releases).toEqual([undefined]);
    expect(backend.sharedPlacesInUse().flush).toBe(0);
  });

  it('a read the database answered with an error destroys the client and frees the place', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend, releases } = rig(sql => readSql.test(sql) ? answered('42P01', 'relation does not exist') : undefined);
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, token)).toMatchObject({ fate: 'unknown', code: '42P01' });
    expect(releases).toEqual([true]);
    expect(backend.sharedPlacesInUse().flush).toBe(0);
  });

  it('a release that throws after a failed read still frees the place', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('release failed');
    const { backend } = rig(sql => readSql.test(sql) ? answered('42P01') : undefined, destroy => { if (destroy) throw boom; });
    await expect(backend.resolveFlush('g1', FLUSH_ID, 7, token)).rejects.toBe(boom);
    expect(backend.sharedPlacesInUse().flush).toBe(0);
  });

  it('a throw after the check ended gives the place back once', async () => {
    const boom = new Error('log sink failed');
    vi.spyOn(console, 'warn').mockImplementation(() => { throw boom; });
    const { backend, releases } = rig(sql => readSql.test(sql) ? row('9', OTHER_ID) : undefined);
    await expect(backend.resolveFlush('g1', FLUSH_ID, 5, { ...token, claim: 9 })).rejects.toBe(boom);
    await until(() => releases.length === 1);
    await settle();
    await settle();
    expect(backend.sharedPlacesInUse().flush).toBe(0);
  });

  it('a connect that fails answers unknown and starts the hold', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend, holds } = rig(() => undefined);
    (backend.getPool() as unknown as { connect: unknown }).connect = async () => { throw new Error('connect ECONNREFUSED'); };
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, token)).toMatchObject({ fate: 'unknown' });
    expect(holds.length).toBeGreaterThan(0);
    expect(holds[0]).toEqual(expect.any(String));
    expect(backend.sharedPlacesInUse().flush).toBe(0);
  });

  it('a ROLLBACK the database answered with an error destroys the client and starts no hold', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend, releases, holds } = rig(sql => readSql.test(sql) ? row('7', FLUSH_ID) : sql === 'ROLLBACK' ? answered('28000', 'role may not log in') : undefined);
    let refused = 0;
    backend.onLoginRefused(() => { refused += 1; });
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, token)).toEqual({ fate: 'landed' });
    await until(() => releases.length === 1);
    await settle();
    expect(releases).toEqual([true]);
    expect(holds).toEqual([]);
    expect(refused).toBe(0);
    expect(backend.connectionState().state).toBe('ready');
    expect(backend.sharedPlacesInUse().flush).toBe(0);
  });
});

describe('resolveFlush: what the row answers', () => {
  it('deposed names the current owner and sends the alert with its detail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend } = rig(sql => readSql.test(sql) ? row('9', OTHER_ID, 'node-b') : undefined);
    const alerts: Array<[string, string]> = [];
    backend.onAlert((event, detail) => { alerts.push([event, detail]); });
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, token)).toEqual({
      fate: 'deposed', landed: null, currentOwner: { nodeId: 'node-b', claim: 9 },
    });
    expect(alerts).toEqual([['deposed', 'deposed: guild g1 is held by claim 9; local claim 7']]);
  });

  it('a row under the very claim the save was sent with answers not-landed with no log line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { backend } = rig(sql => readSql.test(sql) ? row('7', OTHER_ID) : undefined);
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, token)).toEqual({ fate: 'not-landed' });
    expect(warn).not.toHaveBeenCalled();
  });
});

const op = (id: string, next?: SharedStatement['next']): SharedStatement => ({
  text: 'INSERT INTO smdb_data.shared_ops (id) VALUES ($1)', values: [id], ...(next ? { next } : {}),
});

describe('sharedTx: statements, values and the client', () => {
  it('a committed transaction sends BEGIN and COMMIT with no values and gives the client back', async () => {
    const { backend, sent, releases } = rig(() => undefined);
    expect(await backend.sharedTx({ check: null, statements: () => [op('a')] })).toMatchObject({ kind: 'committed' });
    expect(sent.map(s => s.sql.split(/\s+/)[0])).toEqual(['BEGIN;', 'INSERT', 'COMMIT']);
    expect(sent[0].params).toBeUndefined();
    expect(sent[2].params).toEqual([]);
    expect(releases).toEqual([undefined]);
  });

  it('a check that finds the op landed rolls back and gives the client back', async () => {
    const { backend, sent, releases } = rig(() => undefined);
    const outcome = await backend.sharedTx({ check: [{ text: 'SELECT 1', values: [] }], statements: () => 'landed' });
    expect(outcome).toEqual({ kind: 'landed' });
    expect(sent.map(s => s.sql.split(/\s+/)[0])).toEqual(['BEGIN;', 'SELECT', 'ROLLBACK']);
    expect(sent[0].params).toEqual([]);
    expect(releases).toEqual([undefined]);
  });

  it('after a check, the statement bound is set with no values', async () => {
    const { backend, sent, releases } = rig(() => undefined);
    const outcome = await backend.sharedTx({ check: [{ text: 'SELECT 1', values: [] }], statements: () => [op('a')] });
    expect(outcome).toMatchObject({ kind: 'committed' });
    const set = sent.find(s => s.sql.startsWith('SET LOCAL statement_timeout'));
    expect(set).toBeDefined();
    expect(set!.params).toBeUndefined();
    expect(releases).toEqual([undefined]);
  });

  it('an oversized statement that a next() adds is never sent: rolled back, build failure, client given back', async () => {
    const huge = 'x'.repeat(FLUSH_STATEMENT_BYTES + 1);
    const { backend, sent, releases } = rig(() => undefined);
    const outcome = await backend.sharedTx({ check: null, statements: () => [op('a', () => [op(huge)])] });
    expect(outcome).toEqual({
      kind: 'failed', step: 'build',
      detail: `a statement carries ${FLUSH_STATEMENT_BYTES + 1} bytes of values, over the ${FLUSH_STATEMENT_BYTES} a statement may carry; it was not sent`,
    });
    expect(sent.some(s => s.params?.[0] === huge)).toBe(false);
    expect(sent.map(s => s.sql)).not.toContain('COMMIT');
    expect(sent[sent.length - 1].sql).toBe('ROLLBACK');
    expect(releases).toEqual([undefined]);
  });

  it('a next() that throws rolls back and gives the client back', async () => {
    const { backend, sent, releases } = rig(() => undefined);
    const outcome = await backend.sharedTx({ check: null, statements: () => [op('a', () => { throw new Error('bad answer'); })] });
    expect(outcome).toEqual({ kind: 'failed', step: 'build', detail: 'bad answer' });
    expect(sent[sent.length - 1].sql).toBe('ROLLBACK');
    expect(releases).toEqual([undefined]);
  });

  it('a next() that stops rolls back and gives the client back', async () => {
    const { backend, sent, releases } = rig(() => undefined);
    const outcome = await backend.sharedTx<string>({ check: null, statements: () => [{ ...op('a'), next: () => ({ stop: 'enough' }) }] });
    expect(outcome).toEqual({ kind: 'stopped', value: 'enough' });
    expect(sent[sent.length - 1].sql).toBe('ROLLBACK');
    expect(releases).toEqual([undefined]);
  });

  it('a COMMIT answered after the latch rose answers unknown and gives the uncut client back', async () => {
    const holder: { backend?: PostgresBackend } = {};
    const { backend, releases } = rig(sql => {
      if (sql === 'COMMIT') holder.backend!.latch({ kind: 'replaced', machine: 'machine-b', generation: 2 });
      return undefined;
    });
    holder.backend = backend;
    const outcome = await backend.sharedTx({ check: null, statements: () => [op('a')] });
    expect(outcome).toMatchObject({ kind: 'unknown' });
    expect(releases).toEqual([undefined]);
  });
});
