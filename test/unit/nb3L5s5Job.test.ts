import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB3 L5 survivors, chunk 5: what the job writes into Postgres (rows, owners, graveyard reasons), its counts, the
// second read of a JSON source, the shadow notes of a move to JSON, insertRows' batches and the answers of post().

import { insertRows, type MigrationHost, type PgSession, type RunningMigration } from '../../src/bot/internalSetup/utils/dataMigration';
import { loadCredentials } from '../../src/utils/envLoader';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, JOURNAL, MARKER, PG_URL, freshJsonBot, readJson, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

const G1 = '770000000000000001';
const G2 = '770000000000000002';
const T1 = 1700000000000;
const T2 = 1700000000001;

beforeEach(() => {
  wipeRoot();
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
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
  delete process.env.FLEET_SHARD_COUNT;
});

describe('a move to Postgres stores every row as the JSON source holds it', () => {
  it('writes the documents, the stream and both graveyard entries with their reasons, and counts them', async () => {
    freshJsonBot();
    const files: Record<string, string> = {
      [`${G1}/m/a.json`]: '{"a":1}',
      [`${G1}/m/log.jsonl`]: '{"e":1}\n',
      [`_graveyard/${G1}-${T1}/m/old.json`]: '{"o":1}',
      [`_graveyard/${G2}-${T2}/m/old.jsonl`]: '{"s":2}\n',
    };
    for (const [rel, text] of Object.entries(files)) seedFile(rel, text);
    seedFile(`_graveyard/${G1}-${T1}/.graveyard.json`, JSON.stringify({ reason: 'left' }));
    seedFile(`_graveyard/${G2}-${T2}/.graveyard.json`, JSON.stringify({ reason: 'kicked' }));
    const db = new FakeDb();
    const service = serviceFor(db);
    await service.post({ jobId: 'job-l5s5-copy-01', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const bytes = Object.values(files).reduce((n, t) => n + Buffer.byteLength(t), 0);
    expect(job.counts).toEqual({ documents: 1, appendFiles: 1, graveyardEntries: 2, bytes, sharedDocs: 0, sharedLines: 0, modules: 0, moduleFiles: 0, sharedBytes: 0, providerKeys: 0 });
    const store = db.schemas.get('smdb_data')!;
    expect(store.data).toEqual([{ guild_id: G1, module: 'm', filename: 'a.json', doc: '{"a":1}' }]);
    expect(store.append.map(r => ({ guild_id: r.guild_id, module: r.module, filename: r.filename, chunk: r.chunk })))
      .toEqual([{ guild_id: G1, module: 'm', filename: 'log.jsonl', chunk: '{"e":1}\n' }]);
    const graves = [...store.grave].sort((a, b) => a.retired_at.localeCompare(b.retired_at));
    expect(graves).toEqual([
      { guild_id: G1, module: 'm', filename: 'old.json', kind: 'doc', doc: '{"o":1}', retired_at: String(T1), reason: 'left' },
      { guild_id: G2, module: 'm', filename: 'old.jsonl', kind: 'append', doc: '{"s":2}\n', retired_at: String(T2), reason: 'kicked' },
    ]);
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres' });
  });

  it('gives each copied guild one ownership row on this node, its shard of FLEET_SHARD_COUNT and claim 0', async () => {
    freshJsonBot();
    const g3 = String(1000000003n << 22n);
    seedFile(`${g3}/m/a.json`, '{}');
    process.env.FLEET_SHARD_COUNT = '4';
    const db = new FakeDb();
    const service = serviceFor(db);
    await service.post({ jobId: 'job-l5s5-owner-01', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(db.schemas.get('smdb_data')!.owners).toEqual([
      { guild_id: g3, node_id: 'node-test', shard_id: 3, claim: '0', shard_count: 4, retired_at: null },
    ]);
  });

  it('fails at the second read when a source document changed after the first read', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{"a":1}');
    const db = new FakeDb();
    const service = serviceFor(db, new FakeHost(), { fault: p => { if (p === 'S7') seedFile(`${G1}/m/a.json`, '{"a":2}'); } });
    await service.post({ jobId: 'job-l5s5-reread-01', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading' });
    expect(job.error).toBe(`The source read a second time differs from the source in 1 document(s): ${G1}/m/a.json`);
    expect(readJson(MARKER).live).toBe('file');
  });
});

describe('a move to JSON', () => {
  function pgSource(db: FakeDb): void {
    writeJson(MARKER, { live: 'postgres', storeId: 'src-l5s5', flippedAt: 1 });
    db.schemas.set('smdb_data', {
      ...emptyStore('src-l5s5'),
      data: [{ guild_id: G1, module: 'm', filename: 'a.json', doc: '{"a":1}' }, { guild_id: G2, module: 'm', filename: 'b.json', doc: '{"b":2}' }],
    });
  }

  it('names each shadowed row in the journal, a graveyard entry\'s with its retired time', async () => {
    const db = new FakeDb();
    pgSource(db);
    const s = db.schemas.get('smdb_data')!;
    s.data.push({ guild_id: G2, module: 'm/', filename: '../m/b.json', doc: '{"shadow":1}' });
    s.grave.push(
      { guild_id: G1, module: 'm', filename: 'old.json', kind: 'doc', doc: '{"o":1}', retired_at: String(T1), reason: 'left' },
      { guild_id: G1, module: 'm/', filename: '../m/old.json', kind: 'doc', doc: '{"o":2}', retired_at: String(T1), reason: 'left' },
    );
    const service = serviceFor(db);
    await service.post({ jobId: 'job-l5s5-shadow-01', to: 'file' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect([...job.shadow].sort()).toEqual([`${G1}-${T1}: ('m/', '../m/old.json')`, `${G2}: ('m/', '../m/b.json')`].sort());
    expect([...readJson(JOURNAL).shadow].sort()).toEqual([...job.shadow].sort());
  });

  it('reads no guild again at placing when the source has no shadowed row', async () => {
    const db = new FakeDb();
    pgSource(db);
    let mark = -1;
    const service = serviceFor(db, new FakeHost(), { fault: p => { if (p === 'S8') mark = db.log.length; } });
    await service.post({ jobId: 'job-l5s5-shadow-02', to: 'file' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(mark).toBeGreaterThan(0);
    expect(db.log.slice(mark).map(e => e.sql).filter(sql => /WHERE guild_id = \$1/.test(sql))).toEqual([]);
  });
});

describe('insertRows', () => {
  const recorder = () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const session = { query: async (sql: string, params: any[] = []) => { calls.push({ sql, params }); return { rows: [] }; }, end: async () => undefined };
    return { calls, session: session as unknown as PgSession };
  };

  it('sends nothing for no columns', async () => {
    const r = recorder();
    await expect(insertRows(r.session, 'INSERT x', [])).resolves.toBeUndefined();
    expect(r.calls).toEqual([]);
  });

  it('sends only the rows the first column counts', async () => {
    const r = recorder();
    await insertRows(r.session, 'INSERT x', [['a', 'b'], ['x', 'y', 'z']]);
    expect(r.calls).toEqual([{ sql: 'INSERT x', params: [['a', 'b'], ['x', 'y']] }]);
  });

  it('keeps rows whose values reach the byte bound exactly in one batch', async () => {
    const r = recorder();
    await insertRows(r.session, 'INSERT x', [['a', 'b']], 2);
    expect(r.calls).toEqual([{ sql: 'INSERT x', params: [['a', 'b']] }]);
  });

  it('counts a missing value as no bytes', async () => {
    const r = recorder();
    await insertRows(r.session, 'INSERT x', [[undefined, undefined], ['a', 'b']], 2);
    expect(r.calls).toEqual([{ sql: 'INSERT x', params: [[undefined, undefined], ['a', 'b']] }]);
  });
});

describe('post() answers', () => {
  it('refuses a bad job id, a bad direction and an empty or blank url with 400 and the reason', async () => {
    freshJsonBot();
    const db = new FakeDb();
    const service = serviceFor(db);
    expect(await service.post({ jobId: 'x', to: 'postgres' })).toEqual({ status: 400, body: { success: false, error: "jobId must be 8 to 40 letters, digits and '-'" } });
    expect(await service.post({ jobId: 'job-l5s5-post-01', to: 'sqlite' })).toEqual({ status: 400, body: { success: false, error: "to must be 'postgres' or 'file'" } });
    expect(await service.post({ jobId: 'job-l5s5-post-01', to: 'postgres', url: '' })).toEqual({ status: 400, body: { success: false, error: 'url must be a database address' } });
    await service.idle();
    expect(await service.post({ jobId: 'job-l5s5-post-01', to: 'postgres', url: '   ' })).toEqual({ status: 400, body: { success: false, error: 'url must be a database address' } });
    await service.idle();
    expect(db.sessions).toEqual([]);
    expect(service.status().body.job).toBeNull();
  });

  it('answers 409 naming the migration that holds the lock, and starts nothing', async () => {
    freshJsonBot();
    const host = new FakeHost();
    host.lock = { jobId: 'other-job-01', to: 'file' };
    const service = serviceFor(new FakeDb(), host);
    const answer = await service.post({ jobId: 'job-l5s5-held-01', to: 'postgres' });
    await service.idle();
    expect(answer).toEqual({ status: 409, body: { success: false, error: 'Migration other-job-01 (--to file) is running', jobId: 'other-job-01', to: 'file' } });
    expect(service.status().body.job).toBeNull();
  });

  it('answers 409 without a name when the lock is held by a migration it cannot name', async () => {
    freshJsonBot();
    const host: MigrationHost = {
      takeMigrationLock: (_job: RunningMigration) => false,
      releaseMigrationLock: () => undefined,
      migrationRunning: () => null,
      migrationBotState: () => ({ ok: true }),
      ownerChannelWriteSettled: () => true,
      sharedWritesSettled: () => true,
    };
    const service = serviceFor(new FakeDb(), host);
    const answer = await service.post({ jobId: 'job-l5s5-held-02', to: 'postgres' });
    await service.idle();
    expect(answer).toEqual({ status: 409, body: { success: false, error: 'A data migration is running' } });
  });

  it('answers 500 when the request throws, logs it, and releases the lock', async () => {
    freshJsonBot();
    (console.log as any).mockImplementation((line: unknown) => { if (/started$/.test(String(line))) throw new Error('log sink down'); });
    const host = new FakeHost();
    const service = serviceFor(new FakeDb(), host);
    const answer = await service.post({ jobId: 'job-l5s5-throw-01', to: 'postgres' });
    await service.idle();
    expect(answer).toEqual({ status: 500, body: { success: false, error: 'The request could not be answered: log sink down' } });
    expect(console.error).toHaveBeenCalledWith('[Migration] The request could not be answered: log sink down');
    expect(host.lock).toBeNull();
    expect(service.running()).toBeNull();
  });
});
