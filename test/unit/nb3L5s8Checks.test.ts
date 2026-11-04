import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { flushAll, saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { dataPath } from '../../src/utils/dataRoot';
import { loadCredentials } from '../../src/utils/envLoader';
import { setBackendKind } from '../helpers/backendKind';
import { emptyStore, FakeDb, type Row } from '../helpers/fakePg';
import { FakeHost, MARKER, PG_URL, freshJsonBot, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

// NB3 S2 and S3: the texts of the store-id checks, the foreign-schema refusal and the drain refusal.

const G1 = '880000000000000101';
const G2 = '880000000000000102';

beforeEach(() => {
  wipeRoot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
  loadCredentials();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** The fake, except that the count read answers only the columns its SQL names, as Postgres does. */
function strictCounts(db: FakeDb) {
  return async (_url: string, app: string): Promise<PgSession> => {
    const client = db.connect(app);
    return {
      query: async (text: string, params: any[] = []) => {
        const res = await client.query(text, params);
        if (!/AS docs/.test(text)) return res;
        const row: Row = {};
        for (const [k, v] of Object.entries(res.rows[0])) if (new RegExp(`AS ${k}\\b`).test(text)) row[k] = v;
        return { ...res, rows: [row] };
      },
      end: () => client.end(),
    } as unknown as PgSession;
  };
}

async function runJob(db: FakeDb, jobId: string, to: 'file' | 'postgres', fault?: (p: string) => void | Promise<void>) {
  const service = serviceFor(db, new FakeHost(), { connect: strictCounts(db), ...(fault ? { fault } : {}) });
  const answer = await service.post({ jobId, to });
  expect(answer.body.state, why(answer)).toBe('started');
  await service.idle();
  return service.status().body.job;
}

describe('a Postgres source whose store id is not the marker\'s', () => {
  it('names both ids', async () => {
    const db = new FakeDb();
    writeJson(MARKER, { live: 'postgres', storeId: 'mk-a', flippedAt: 1 });
    db.schemas.set('smdb_data', emptyStore('db-b'));
    const job = await runJob(db, 'job-s8-ids-01', 'file');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toBe('The database holds store db-b, not the store /data/.backend.json names (mk-a)');
  });

  it('says none for a database with no store', async () => {
    const db = new FakeDb();
    writeJson(MARKER, { live: 'postgres', storeId: 'mk-a', flippedAt: 1 });
    const job = await runJob(db, 'job-s8-ids-02', 'file');
    expect(job.error, why(job)).toBe('The database holds store none, not the store /data/.backend.json names (mk-a)');
  });

  it('says none for a marker with no store id', async () => {
    const db = new FakeDb();
    writeJson(MARKER, { live: 'postgres', storeId: null, flippedAt: 1 });
    db.schemas.set('smdb_data', emptyStore('db-b'));
    const job = await runJob(db, 'job-s8-ids-03', 'file');
    expect(job.error, why(job)).toBe('The database holds store db-b, not the store /data/.backend.json names (none)');
  });
});

describe('a schema this deployment never served', () => {
  const fill = (s: ReturnType<typeof emptyStore>, n: { docs?: number; appends?: number; graves?: number; owners?: number }) => {
    for (let i = 0; i < (n.docs ?? 0); i++) s.data.push({ guild_id: G1, module: 'm', filename: `d${i}.json`, doc: '{}' });
    for (let i = 0; i < (n.appends ?? 0); i++) s.append.push({ guild_id: G1, module: 'm', filename: `s${i}.jsonl`, seq: i + 1, chunk: '{}\n' });
    for (let i = 0; i < (n.graves ?? 0); i++) s.grave.push({ guild_id: G1, module: 'm', filename: `g${i}.json`, kind: 'doc', doc: '{}', retired_at: '17', reason: 'left' });
    for (let i = 0; i < (n.owners ?? 0); i++) s.owners.push({ guild_id: G1, node_id: 'n', shard_id: 0, claim: '0', shard_count: 1, retired_at: null });
    return s;
  };
  const text = (id: string, d: number, a: number, g: number, o: number, empty: boolean) => `The database already holds store ${id} in schema smdb_data `
    + `(${d} documents, ${a} streams, ${g} graveyard rows, ${o} ownership rows), which this deployment never served`
    + (empty ? '; the schema holds no guild rows, so it can be dropped' : '');

  async function refusal(n: { docs?: number; appends?: number; graves?: number; owners?: number }, jobId: string): Promise<string> {
    freshJsonBot();
    seedFile(`${G2}/m/a.json`, '{"a":1}');
    const db = new FakeDb();
    db.schemas.set('smdb_data', fill(emptyStore('foreign'), n));
    const before = JSON.stringify(db.schemas.get('smdb_data'));
    const job = await runJob(db, jobId, 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(JSON.stringify(db.schemas.get('smdb_data'))).toBe(before);
    return job.error;
  }

  it('an empty schema is named as one that can be dropped', async () => {
    expect(await refusal({}, 'job-s8-for-01')).toBe(text('foreign', 0, 0, 0, 0, true));
  });

  it('a schema with documents and streams only is not called empty', async () => {
    expect(await refusal({ docs: 1, appends: 1 }, 'job-s8-for-02')).toBe(text('foreign', 1, 1, 0, 0, false));
  });

  it('a schema with a document and a graveyard row is not called empty', async () => {
    expect(await refusal({ docs: 1, graves: 1 }, 'job-s8-for-03')).toBe(text('foreign', 1, 0, 1, 0, false));
  });

  it('a schema with a graveyard row and an ownership row is not called empty, and names both counts', async () => {
    expect(await refusal({ graves: 1, owners: 1 }, 'job-s8-for-04')).toBe(text('foreign', 0, 0, 1, 1, false));
  });

  it('a schema with no store id says so', async () => {
    freshJsonBot();
    const db = new FakeDb();
    db.schemas.set('smdb_data', fill(emptyStore(null), { owners: 2 }));
    const job = await runJob(db, 'job-s8-for-05', 'postgres');
    expect(job.error, why(job)).toBe(text('with no id', 0, 0, 0, 2, false));
  });
});

describe('the drain at S3', () => {
  it('a refusal names every guild path still queued, comma separated', async () => {
    freshJsonBot();
    await flushAll();
    setBackendKind('file');
    const a = dataPath(G1, 'mod', 'stuck-a.json');
    const b = dataPath(G2, 'mod', 'stuck-b.json');
    const real = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(((p: any, ...rest: any[]) => {
      const s = String(p);
      if ((s.startsWith(`${a}.`) || s.startsWith(`${b}.`)) && s.endsWith('.tmp')) {
        return Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
      }
      return (real as any)(p, ...rest);
    }) as typeof fs.promises.open);
    try {
      saveDataTracked('stuck-a.json', { guildId: G1, category: 'mod' }, { a: 1 });
      saveDataTracked('stuck-b.json', { guildId: G2, category: 'mod' }, { b: 1 });
      const db = new FakeDb();
      const realNow = Date.now.bind(Date);
      const job = await runJob(db, 'job-s8-drain-1', 'postgres', p => {
        if (p !== 'S3') return;
        let t = realNow();
        vi.spyOn(Date, 'now').mockImplementation(() => (t += 6000));
      });
      expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'draining' });
      expect([
        `Guild writes of the web UI are still queued and could not be written: ${a}, ${b}`,
        `Guild writes of the web UI are still queued and could not be written: ${b}, ${a}`,
      ]).toContain(job.error);
      expect(db.schemas.has('smdb_data')).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await flushAll();
      setBackendKind(null);
    }
  });
});
