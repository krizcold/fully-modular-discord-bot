import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { FENCED_FLUSH_UPSERT, FENCED_OWNERSHIP_UPSERT, PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import type { DatabaseChooser } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedChooser } from '../helpers/fixedDatabase';

const URL = 'postgres://nobody@127.0.0.1:9/none';
const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'p-a', shardId: 2, shardCount: 4 };
const FLUSH_ID = '11111111-1111-4111-8111-111111111111';

const backends: PostgresBackend[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const b of backends.splice(0)) await b.stop();
});

type Result = { rows: Array<Record<string, unknown>>; rowCount: number };
interface Sent { sql: string; values: unknown[] }

// Postgres refuses a statement whose bind message carries another number of parameters than its text uses.
function wireError(sql: string, values: unknown[]): Error | null {
  let wanted = 0;
  for (const match of sql.matchAll(/\$(\d+)/g)) wanted = Math.max(wanted, Number(match[1]));
  if (values.length === wanted) return null;
  return Object.assign(new Error(`bind message supplies ${values.length} parameters, but prepared statement "" requires ${wanted}`), { code: '08P01', severity: 'ERROR' });
}

function scripted(answer: (sql: string, values: unknown[]) => Result | Error | undefined, chooser: DatabaseChooser = fixedChooser(URL)) {
  const backend = new PostgresBackend({ chooser });
  backends.push(backend);
  (backend as unknown as { state: string }).state = 'ready';
  const sent: Sent[] = [];
  const releases: Array<boolean | undefined> = [];
  const client = {
    query: async (q: string | { text: string; values?: unknown[] }, more?: unknown[]) => {
      const sql = typeof q === 'string' ? q : q.text;
      const values = (typeof q === 'string' ? more : q.values) ?? [];
      sent.push({ sql, values });
      const refused = wireError(sql, values);
      if (refused) throw refused;
      const res = answer(sql, values);
      if (res instanceof Error) throw res;
      return res ?? { rows: [], rowCount: 0 };
    },
    release: (destroy?: boolean) => { releases.push(destroy); },
  };
  (backend.getPool() as unknown as { connect: unknown }).connect = vi.fn(async () => client);
  return { backend, sent, releases };
}

const quiet = () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { log, error };
};
const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(c => String(c[0]));
const rows = (r: Array<Record<string, unknown>>, rowCount = r.length): Result => ({ rows: r, rowCount });

describe('rh1: hydrateGuild', () => {
  const answer = (sql: string, values: unknown[]): Result | undefined => {
    if (sql === FENCED_OWNERSHIP_UPSERT) return rows([], 1);
    if (/octet_length/.test(sql)) return rows([{ bytes: '64' }]);
    if (sql === 'SELECT module, filename, doc FROM smdb_data.guild_data WHERE guild_id = $1' && values[0] === 'g1') {
      return rows([{ module: 'm', filename: 'a.json', doc: '{"x":1}' }]);
    }
    if (sql === 'SELECT DISTINCT module, filename FROM smdb_data.guild_append WHERE guild_id = $1' && values[0] === 'g1') {
      return rows([{ module: 'm', filename: 'l.jsonl' }]);
    }
    return undefined;
  };

  it("answers the guild's documents and append keys read inside one transaction, and gives the client back", async () => {
    quiet();
    const { backend, sent, releases } = scripted(answer);
    const outcome = await backend.hydrateGuild('g1', token);
    expect(outcome).toEqual({
      ok: true,
      docs: [{ key: { module: 'm', filename: 'a.json' }, doc: '{"x":1}' }],
      appendKeys: [{ module: 'm', filename: 'l.jsonl' }],
    });
    expect(sent[0]).toEqual({ sql: 'BEGIN', values: [] });
    expect(sent[sent.length - 1]).toEqual({ sql: 'COMMIT', values: [] });
    expect(releases).toEqual([undefined]);
  });
});

function batchOf(extra: Partial<GuildFlushBatch> = {}): GuildFlushBatch {
  return {
    upserts: [{ key: { module: 'm', filename: 'a.json' }, doc: '{}' }],
    deletes: [],
    appends: [],
    flushId: FLUSH_ID,
    ...extra,
  };
}

describe('rh1: flushGuild', () => {
  const fenced = (sql: string): Result | undefined => (sql === FENCED_FLUSH_UPSERT ? rows([], 1) : undefined);

  it('opens its transaction with BEGIN and the bound in one statement sent with no parameters, and lands', async () => {
    quiet();
    const { backend, sent } = scripted(fenced);
    const outcome = await backend.flushGuild('g1', batchOf(), token);
    expect(outcome).toEqual({ ok: true });
    expect(sent[0].sql).toMatch(/^BEGIN; SET LOCAL statement_timeout = \d+$/);
    expect(sent[0].values).toEqual([]);
  });

  it('a fence that matches no row rolls back and answers deposed', async () => {
    quiet();
    const { backend, sent } = scripted(() => undefined);
    const outcome = await backend.flushGuild('g1', batchOf(), token);
    expect(outcome).toMatchObject({ ok: false, reason: 'deposed' });
    expect(sent.find(s => s.sql === 'ROLLBACK')).toEqual({ sql: 'ROLLBACK', values: [] });
  });

  it('a COMMIT cancelled before the bound is logged as a statement of 1 KiB', async () => {
    const { error } = quiet();
    const cancelled = Object.assign(new Error('canceling statement due to user request'), { code: '57014', severity: 'ERROR' });
    const { backend } = scripted(sql => (sql === 'COMMIT' ? cancelled : fenced(sql)));
    const outcome = await backend.flushGuild('g1', batchOf(), token);
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable' });
    const line = lines(error).find(l => l.includes('(SQLSTATE 57014)'));
    expect(line).toMatch(/^\[PostgresBackend\] flushGuild for g1: a statement of 1 KiB was cancelled after 0 s, before the flush's \d+ s bound/);
  });

  const replaceBatch = () => batchOf({ replace: { docKeys: [{ module: 'm', filename: 'a.json' }], appendKeys: [], reason: 'replaced' } });
  const copyAnswer = (moved: string) => (sql: string): Result | undefined =>
    (/^WITH batch AS/.test(sql) ? rows([{ moved, retired_at: '5' }]) : fenced(sql));
  const movedLines = (spy: { mock: { calls: unknown[][] } }) => lines(spy).filter(l => l.startsWith('[Data] Guild g1: the re-save'));

  it('a replace that moved no row to the graveyard logs no move', async () => {
    const { log } = quiet();
    const { backend } = scripted(copyAnswer('0'));
    expect(await backend.flushGuild('g1', replaceBatch(), token)).toEqual({ ok: true });
    expect(movedLines(log)).toEqual([]);
  });

  it('a replace that moved rows to the graveyard logs how many and the batch', async () => {
    const { log } = quiet();
    const { backend } = scripted(copyAnswer('2'));
    expect(await backend.flushGuild('g1', replaceBatch(), token)).toEqual({ ok: true });
    expect(movedLines(log)).toHaveLength(1);
    expect(movedLines(log)[0]).toContain('moved 2 row(s) this process did not hold to the graveyard (batch 5)');
  });
});

describe('rh1: resolveFlush gives its flush place back once', () => {
  it('when reporting the failed connect throws, the place count returns to zero', async () => {
    quiet();
    const chooser: DatabaseChooser = { ...fixedChooser(URL), holdStarted() { throw new Error('hold report failed'); } };
    const { backend } = scripted(() => undefined, chooser);
    (backend.getPool() as unknown as { connect: unknown }).connect = vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
    });
    await expect(backend.resolveFlush('g1', FLUSH_ID, 7, token)).rejects.toThrow('hold report failed');
    expect(backend.sharedPlacesInUse().flush).toBe(0);
  });
});
