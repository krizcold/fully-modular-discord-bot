import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, MARKER, PG_URL, freshJsonBot, root, seedFile, serviceFor, useDatabaseUrl, why, wipeRoot, writeJson } from '../helpers/migrationRig';

// The session check's label of a backend whose backend_type reads as null, and a move to JSON with no owner-message
// keys in the database, which leaves /data/owner-messages.json as it is.

const G = '840000000000000001';
const STOP = 'stop every bot and every other client of this database first';
const DAY = 86_400_000;
const keysFile = () => path.join(root, 'owner-messages.json');

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
  wipeRoot();
});

async function run(db: FakeDb, jobId: string, to: 'postgres' | 'file'): Promise<any> {
  const service = serviceFor(db, new FakeHost());
  await service.post({ jobId, to });
  await service.idle();
  return service.status().body.job;
}

function pgSource(): FakeDb {
  wipeRoot();
  writeJson(MARKER, { live: 'postgres', storeId: 'store-sb2', flippedAt: 1 });
  const db = new FakeDb();
  const store = emptyStore('store-sb2');
  store.data.push({ guild_id: G, module: 'mod', filename: 'a.json', doc: '{"a":1}' });
  db.schemas.set('smdb_data', store);
  return db;
}

describe('a counted backend whose kind reads as null', () => {
  it('is named by its application and role only, with no kind', async () => {
    freshJsonBot();
    seedFile(`${G}/mod/a.json`, '{}');
    const db = new FakeDb();
    db.sessions.push('psql');
    db.sessionMeta.set('psql', { role: 'dbm_admin', own: false, kind: null });
    const job = await run(db, 'job-sb2-kind-01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toBe(`1 other session(s) or worker(s) are connected to this database (psql as dbm_admin: 1); ${STOP}`);
    expect(db.schemas.has('smdb_data')).toBe(false);
  });
});

describe('a move to JSON with no owner-message keys in the database', () => {
  it('writes no /data/owner-messages.json where there was none', async () => {
    const job = await run(pgSource(), 'job-sb2-keys-01', 'file');
    expect(job.state, why(job)).toBe('done');
    expect(fs.readFileSync(path.join(root, G, 'mod', 'a.json'), 'utf-8')).toBe('{"a":1}');
    expect(fs.existsSync(keysFile())).toBe(false);
  });

  it("keeps this machine's record byte for byte, a key past 90 days included", async () => {
    const db = pgSource();
    const bytes = JSON.stringify({ keys: { old: new Date(Date.now() - 100 * DAY).toISOString(), fresh: new Date(Date.now() - DAY).toISOString() } });
    fs.writeFileSync(keysFile(), bytes);
    const job = await run(db, 'job-sb2-keys-02', 'file');
    expect(job.state, why(job)).toBe('done');
    expect(fs.readFileSync(keysFile(), 'utf-8')).toBe(bytes);
  });
});
