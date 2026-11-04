import fs from 'fs';
import path from 'path';
import { syncBuiltinESMExports } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { DATA_ROOT } from '../../src/utils/dataRoot';
import { loadCredentials } from '../../src/utils/envLoader';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, MARKER, PG_URL, freshJsonBot, readJson, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

// NB3 mutation gate, chunk 2: the job's checks of its copy (every document's hash, the graveyard entries and their
// reasons), where a Postgres source's shadow rows are written, and the bundle-import check when /data cannot be listed.

const G = ['880000000000000001', '880000000000000002', '880000000000000003', '880000000000000004', '880000000000000005', '880000000000000006'];

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
  syncBuiltinESMExports();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
});

/** The fake's sessions, with the rows of a statement rewritten by `edit` before the job sees them. */
function editing(db: FakeDb, edit: (sql: string, rows: any[]) => any[]) {
  return async (_url: string, app: string): Promise<PgSession> => {
    const client = db.connect(app);
    const session = {
      query: async (text: string, params: any[] = []) => {
        const res = await client.query(text, params);
        return { ...res, rows: edit(text.replace(/\s+/g, ' ').trim(), res.rows) };
      },
      end: () => client.end(),
      connection: { stream: { destroy: () => { void client.end(); } } },
    };
    return session as unknown as PgSession;
  };
}

function seedGraves(): void {
  freshJsonBot();
  seedFile(`${G[0]}/m/a.json`, '{"live":1}');
  seedFile(`_graveyard/${G[1]}-5/m/a.json`, '{"five":1}');
  seedFile(`_graveyard/${G[1]}-5/.graveyard.json`, JSON.stringify({ guildId: G[1], reason: 'left', ts: 5 }));
  seedFile(`_graveyard/${G[1]}-50/m/a.json`, '{"fifty":1}');
  seedFile(`_graveyard/${G[1]}-50/.graveyard.json`, JSON.stringify({ guildId: G[1], reason: 'kicked', ts: 50 }));
}

describe('NB3 L5 s2: the source read a second time', () => {
  it('a source that changed before its second read fails the job, which names the count and the first five documents', async () => {
    freshJsonBot();
    for (const g of G) seedFile(`${g}/m/a.json`, '{"v":1}');
    const db = new FakeDb();
    const service = serviceFor(db, new FakeHost(), {
      fault: p => { if (p === 'S7') for (const g of G) seedFile(`${g}/m/a.json`, '{"v":2}'); },
    });
    await service.post({ jobId: 'job-l5s2-hash-01', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading' });
    expect(job.error).toBe(`The source read a second time differs from the source in 6 document(s): ${G.slice(0, 5).map(g => `${g}/m/a.json`).join(', ')}`);
    expect(readJson(MARKER).live).toBe('file');
    expect(db.schemas.has('smdb_data')).toBe(false);
  });
});

describe('NB3 L5 s2: the graveyard entries of the copy', () => {
  it('copies two entries of one guild, 5 and 50, whose names sort apart from their keys, and the job is done', async () => {
    seedGraves();
    const db = new FakeDb();
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-l5s2-grave-01', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(db.schemas.get('smdb_data')!.grave.map(r => `${r.guild_id}-${r.retired_at}|${r.reason}|${r.doc}`).sort())
      .toEqual([`${G[1]}-50|kicked|{"fifty":1}`, `${G[1]}-5|left|{"five":1}`]);
  });

  it('a copy whose graveyard reason reads back other than the source\'s fails the job at verifying, and nothing is switched', async () => {
    seedGraves();
    const db = new FakeDb();
    const connect = editing(db, (sql, rows) => (/sha256\(convert_to\(doc, 'UTF8'\)\).*FROM smdb_data\.guild_data_graveyard/.test(sql)
      ? rows.map(r => (String(r.retired_at) === '50' ? { ...r, reason: 'banned' } : r))
      : rows));
    const service = serviceFor(db, new FakeHost(), { connect });
    await service.post({ jobId: 'job-l5s2-grave-02', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying' });
    expect(job.error).toBe('The copy in the database holds other graveyard entries or reasons than the source');
    expect(readJson(MARKER).live).toBe('file');
    expect(db.schemas.has('smdb_data')).toBe(false);
  });
});

describe('NB3 L5 s2: shadow rows of a Postgres source', () => {
  it('writes a guild\'s shadow row under the guild id and a graveyard entry\'s under <guild>-<retired_at>', async () => {
    const db = new FakeDb();
    writeJson(MARKER, { live: 'postgres', storeId: 'src-l5s2', flippedAt: 1 });
    db.schemas.set('smdb_data', {
      ...emptyStore('src-l5s2'),
      data: [
        { guild_id: G[0], module: 'm', filename: 'a.json', doc: '{"live":1}' },
        { guild_id: G[0], module: 'm/', filename: '../m/a.json', doc: '{"liveShadow":1}' },
      ],
      grave: [
        { guild_id: G[1], module: 'm', filename: 'b.json', kind: 'doc', doc: '{"grave":1}', retired_at: '100', reason: 'left' },
        { guild_id: G[1], module: 'm/', filename: '../m/b.json', kind: 'doc', doc: '{"graveShadow":1}', retired_at: '100', reason: 'left' },
      ],
    });
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-l5s2-shadow-01', to: 'file' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const runs = fs.readdirSync(path.join(root, '_superseded'));
    expect(runs).toHaveLength(1);
    const shadow = path.join(root, '_superseded', runs[0], 'shadow');
    expect(fs.readdirSync(shadow).sort()).toEqual([G[0], `${G[1]}-100`].sort());
    expect(fs.readFileSync(path.join(shadow, G[0], `${encodeURIComponent('m/')}__${encodeURIComponent('../m/a.json')}`), 'utf8')).toBe('{"liveShadow":1}');
    expect(fs.readFileSync(path.join(shadow, `${G[1]}-100`, `${encodeURIComponent('m/')}__${encodeURIComponent('../m/b.json')}`), 'utf8')).toBe('{"graveShadow":1}');
  });
});

describe('NB3 L5 s2: the bundle-import check', () => {
  it('a data root that cannot be listed for bundle imports holds none, and the job is done', async () => {
    freshJsonBot();
    seedFile(`${G[0]}/m/a.json`, '{"a":1}');
    const realReaddirSync = fs.readdirSync;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, ...rest: any[]) => {
      if (rest.length === 0 && path.resolve(String(p)) === path.resolve(DATA_ROOT)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (realReaddirSync as any)(p, ...rest);
    }) as typeof fs.readdirSync);
    syncBuiltinESMExports();
    const db = new FakeDb();
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-l5s2-bundle-01', to: 'postgres' });
    await service.idle();
    spy.mockRestore();
    syncBuiltinESMExports();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(readJson(MARKER).live).toBe('postgres');
  });
});
