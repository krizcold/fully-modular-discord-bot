import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyStore, FakeDb, type Row } from '../helpers/fakePg';
import { FakeHost, PG_URL, freshJsonBot, seedFile, serviceFor, useDatabaseUrl, why, wipeRoot, writeJson, JOURNAL, STORES } from '../helpers/migrationRig';

// NB4 decision 25: the rename aside reads live shard claims only from a store that has the claims tables; a
// tables check with no answer row counts as no tables, so the rename goes ahead.

const G = '292929292929292929';
const OLD = 'store-old-r3';

beforeEach(() => {
  wipeRoot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function answering(db: FakeDb, tables: Row[], live: Row[]) {
  return async (_url: string, app: string) => {
    const client = db.connect(app);
    const query = client.query.bind(client);
    (client as { query: unknown }).query = async (text: string, params?: any[]) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (/to_regclass\('smdb_data\.shard_claims'\)/.test(sql)) return { rows: tables.map(r => ({ ...r })) };
      if (/FROM smdb_data\.shard_claims c JOIN smdb_data\.shard_nodes n/.test(sql)) return { rows: live.map(r => ({ ...r })) };
      return query(text, params);
    };
    return client;
  };
}

async function moveToPostgres(tag: string, tables: Row[], live: Row[]) {
  freshJsonBot();
  seedFile(`${G}/m/a.json`, '{"a":1}');
  writeJson(STORES, { storeIds: [OLD] });
  writeJson(JOURNAL, { jobId: 'job-dest-earlier', to: 'postgres', stage: 'committing', startedAt: 1, storeId: OLD });
  const db = new FakeDb();
  db.schemas.set('smdb_data', { ...emptyStore(OLD), data: [{ guild_id: '1', module: 'x', filename: 'y.json', doc: '{"keep":true}' }] });
  const service = serviceFor(db, new FakeHost(), { connect: answering(db, tables, live) as never });
  await service.post({ jobId: `job-l5r3-${tag}`, to: 'postgres' });
  await service.idle();
  return { job: service.status().body.job, db };
}

const LIVE: Row[] = [{ shard_id: 2, node_name: 'Gamma', takeover_seconds: 30, seen_ago_s: 3 }];

describe('the live-claims read before the rename aside', () => {
  it('with no answer row to the tables check, renames the old store aside and copies', async () => {
    const { job, db } = await moveToPostgres('norow', [], LIVE);
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(job.error ?? '').not.toMatch(/TypeError|Cannot read/);
    const aside = [...db.schemas.keys()].filter(k => k.startsWith('smdb_superseded_'));
    expect(aside).toHaveLength(1);
    expect(db.schemas.get(aside[0])!.storeId).toBe(OLD);
  });

  it('with the tables present and a live claim, refuses and renames nothing', async () => {
    const { job, db } = await moveToPostgres('live', [{ present: true }], LIVE);
    expect(job, why(job)).toMatchObject({ state: 'failed' });
    expect(job.error).toContain('shard 2 held by Gamma (seen 3 s ago)');
    expect([...db.schemas.keys()]).toEqual(['smdb_data']);
    expect(db.schemas.get('smdb_data')!.storeId).toBe(OLD);
  });

  it('with the tables check answering false, renames aside without reading claims', async () => {
    const { job, db } = await moveToPostgres('absent', [{ present: false }], LIVE);
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect([...db.schemas.keys()].filter(k => k.startsWith('smdb_superseded_'))).toHaveLength(1);
  });
});
