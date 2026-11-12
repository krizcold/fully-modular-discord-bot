import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCredentials } from '../../src/utils/envLoader';
import { flushAll, setGuildWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, shaOf } from '../../src/bot/internalSetup/utils/sharedStore';
import type { PgSession, ServiceOptions } from '../../src/bot/internalSetup/utils/dataMigration';
import { setBackendKind } from '../helpers/backendKind';
import { FakeDb, emptyStore } from '../helpers/fakePg';
import { FakeHost, PG_URL, freshJsonBot, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

const G1 = '880000000000000147';
const ALL_TABLES = ['shared_docs', 'shared_lines', 'shared_modules', 'shared_module_files', 'shared_ops'];
const PRESENT_HEAD = "SELECT to_regclass('smdb_data.shared_docs') IS NOT NULL AND ";
const NEVER_SERVED = 'The database already holds store foreign in schema smdb_data (0 documents, 0 streams, 0 graveyard rows, 0 ownership rows), which this deployment never served';
const DROPPABLE = `${NEVER_SERVED}; the schema holds no guild rows, so it can be dropped`;

beforeEach(async () => {
  await flushAll();
  wipeRoot();
  setBackendKind(null);
  setGuildWriteGate(null);
  _resetRowQueue();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
  delete process.env.FLEET_SHARD_COUNT;
  loadCredentials();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  setBackendKind(null);
  setGuildWriteGate(null);
  _resetRowQueue();
});

const pgError = (code: string, text: string) => Object.assign(new Error(text), { code, severity: 'ERROR' });
const balanced = (sql: string) => sql.split('(').length === sql.split(')').length;

/**
 * Answers the shared tables check and the shared row count as Postgres would for the given tables: the column takes
 * the statement's alias, an unbalanced statement is a syntax error, and a count of a missing table is 42P01.
 */
function asPostgres(db: FakeDb, tables: string[], presentRows?: unknown[]) {
  const answer = (sql: string): { rows: any[] } | null => {
    if (sql.startsWith(PRESENT_HEAD)) {
      if (presentRows) return { rows: presentRows };
      if (!balanced(sql)) throw pgError('42601', 'syntax error');
      const named = [...sql.matchAll(/to_regclass\('smdb_data\.(\w+)'\)/g)].map(m => m[1]);
      const alias = /\bAS (\w+)$/.exec(sql)?.[1] ?? '?column?';
      return { rows: [{ [alias]: named.every(t => tables.includes(t)) }] };
    }
    if (/count\(\*\) FROM smdb_data\.shared_/.test(sql)) {
      if (!balanced(sql)) throw pgError('42601', 'syntax error at or near ")"');
      const store = db.schemas.get('smdb_data')!;
      const sizes: Record<string, number> = { shared_docs: store.docs?.length ?? 0, shared_lines: store.lines?.length ?? 0, shared_modules: store.modules?.length ?? 0 };
      let n = 0;
      for (const [, t] of sql.matchAll(/count\(\*\) FROM smdb_data\.(\w+)/g)) {
        if (!tables.includes(t)) throw pgError('42P01', `relation "smdb_data.${t}" does not exist`);
        n += sizes[t] ?? 0;
      }
      const alias = /\bAS (\w+)$/.exec(sql)?.[1] ?? '?column?';
      return { rows: [{ [alias]: n }] };
    }
    return null;
  };
  return async (_url: string, app: string): Promise<PgSession> => {
    const session = db.connect(app) as unknown as PgSession;
    return new Proxy(session as any, {
      get(target, prop) {
        if (prop === 'query') return async (sql: string, params?: unknown[]) => answer(sql) ?? target.query(sql, params);
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
      set(target, prop, value) {
        return Reflect.set(target, prop, value);
      },
    });
  };
}

function foreignWithOneDoc(): FakeDb {
  jsonBot();
  const db = new FakeDb();
  const body = Buffer.from('{}');
  db.schemas.set('smdb_data', { ...emptyStore('foreign'), docs: [{ key: 'global/x.json', body, sha: shaOf(body), rev: 1, updated_by: 'x' }] });
  return db;
}

function jsonBot(): void {
  freshJsonBot();
  seedFile(`${G1}/m/a.json`, '{"g":1}');
}

async function run(db: FakeDb, jobId: string, connect?: ServiceOptions['connect']) {
  const extra: ServiceOptions = { rootConfigPath: `${root}/cfg/config.json`, sourceModulesDir: `${root}/srcmods` };
  if (connect) extra.connect = connect;
  const service = serviceFor(db, new FakeHost(), extra);
  await service.post({ jobId, to: 'postgres' });
  await service.idle();
  return service.status().body.job;
}

describe('ra47: a store this deployment never served, by its shared tables', () => {
  it('counts the shared rows when every shared table is there, so a doc keeps it from being called droppable', async () => {
    const db = foreignWithOneDoc();
    const job = await run(db, 'job-ra47-tab-01', asPostgres(db, ALL_TABLES));
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toBe(NEVER_SERVED);
  });

  it('calls the store droppable when its module tables are missing, without counting its rows', async () => {
    const db = foreignWithOneDoc();
    const job = await run(db, 'job-ra47-tab-02', asPostgres(db, ['shared_docs', 'shared_lines', 'shared_ops']));
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toBe(DROPPABLE);
  });

  it('reads a check that answers no row as no shared tables', async () => {
    const db = foreignWithOneDoc();
    const job = await run(db, 'job-ra47-tab-03', asPostgres(db, ALL_TABLES, []));
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toBe(DROPPABLE);
  });
});

describe('ra47: a shared doc takes its rev from the sequence', () => {
  it('sends the doc insert with nextval in the rev column', async () => {
    const db = new FakeDb();
    jsonBot();
    seedFile('global/m/a.json', '{"a":1}');
    const job = await run(db, 'job-ra47-rev-01');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const docs = db.statements().filter(s => s.startsWith('INSERT INTO smdb_data.shared_docs '));
    expect(docs.length).toBeGreaterThan(0);
    for (const s of docs) expect(s).toBe("INSERT INTO smdb_data.shared_docs (key, body, sha, rev, updated_by) VALUES ($1, $2, $3, nextval('smdb_data.shared_rev_seq'), $4)");
  });
});
