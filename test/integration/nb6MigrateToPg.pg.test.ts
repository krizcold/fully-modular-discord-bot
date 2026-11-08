import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { openJobSession, type PgSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { moduleShaOf } from '../../src/bot/internalSetup/utils/sharedModules';
import { jsonBot, realService, resetDatabase, schemas, sessionsGone, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, MARKER, readJson, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';
import { BIN, INSTALLED, MODULE_JSON, NODE_BIN, NUL, seedShared, sharedOpts } from '../helpers/nb6MigrateRig';

// NB6 test 28: rows 68 and 70 against a real Postgres. The copy transaction holds the shared rows as bytea, the
// read-back hashes them in SQL, and a byte changed in a row before S6 fails the job with nothing switched.

let rig: PgRig;
const G = '282828282828282801';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => { rig = await startRig(); }, 180_000);
afterAll(async () => { await stopRig(rig); });
beforeEach(async () => {
  wipeRoot();
  await resetDatabase(rig);
  await sessionsGone(rig);
  useDatabaseUrl(rig.url);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('row 68: a move to Postgres', () => {
  it('stores every shared doc, line, module and module file byte for byte, with the sha the bytes give', async () => {
    jsonBot();
    seedShared(G);
    const service = realService(new FakeHost(), sharedOpts);
    await service.post({ jobId: 'job-nb6pg-68-01', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const docs = (await rig.admin.query("SELECT key, body, sha, encode(sha256(body), 'hex') AS h, updated_by FROM smdb_data.shared_docs ORDER BY key COLLATE \"C\"")).rows;
    const expected: Record<string, Buffer> = {
      'config.json': Buffer.from('{"prefix":"!"}'), 'global/appstore/installed.json': Buffer.from(JSON.stringify(INSTALLED)),
      'global/m/a.json': Buffer.from('{"a":1}'), 'global/m/bin.dat': BIN, 'global/m/zero.json': NUL,
    };
    expect(docs.map(d => d.key)).toEqual(Object.keys(expected));
    for (const d of docs) {
      expect(Buffer.isBuffer(d.body)).toBe(true);
      expect((d.body as Buffer).equals(expected[d.key]), d.key).toBe(true);
      expect(d.sha).toBe(sha(expected[d.key]));
      expect(d.h).toBe(d.sha);
      expect(d.updated_by).toBe('migration/job-nb6pg-68-01');
    }
    const lines = (await rig.admin.query('SELECT key, line FROM smdb_data.shared_lines ORDER BY seq')).rows;
    expect(lines.map(l => [l.key, (l.line as Buffer).toString('utf8')])).toEqual([['global/m/log.jsonl', '{"e":1}'], ['global/m/log.jsonl', '{"e":2}']]);
    const files = [{ rel: 'lib/bin.node', bytes: NODE_BIN }, { rel: 'module.json', bytes: Buffer.from(MODULE_JSON) }];
    const mods = (await rig.admin.query('SELECT module, sha, version, file_count, bytes::int AS bytes, updated_by FROM smdb_data.shared_modules')).rows;
    expect(mods).toEqual([{
      module: 'mod1', sha: moduleShaOf(files.map(f => ({ rel: f.rel, sha: sha(f.bytes) }))), version: '1.2.0', file_count: 2,
      bytes: NODE_BIN.length + MODULE_JSON.length, updated_by: 'migration/job-nb6pg-68-01',
    }]);
    const stored = (await rig.admin.query('SELECT rel, bytes FROM smdb_data.shared_module_files WHERE module = $1 ORDER BY rel COLLATE "C"', ['mod1'])).rows;
    expect(stored.map(f => f.rel)).toEqual(['lib/bin.node', 'module.json']);
    expect((stored[0].bytes as Buffer).equals(NODE_BIN)).toBe(true);
    expect(job.counts).toMatchObject({ documents: 1, sharedDocs: 5, sharedLines: 2, modules: 1, moduleFiles: 2 });
    expect(job.closedTails).toEqual(['global/m/log.jsonl']);
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres' });
  });
});

describe('row 70: a byte changed in a row before S6', () => {
  /** The job's own session, so a fault can change a row inside the copy transaction. */
  function capturing(): { opts: { connect: (url: string, app: string, kind: 'job' | 'probe') => Promise<PgSession> }; session: () => PgSession } {
    let first: PgSession | null = null;
    return {
      opts: {
        connect: async (url, app, kind) => {
          const s = await openJobSession(url, app, kind, 2000);
          if (kind === 'job' && !first) first = s;
          return s;
        },
      },
      session: () => first!,
    };
  }

  it('a body changed with its sha fails the job at verifying with decision 19\'s text and leaves no store', async () => {
    jsonBot();
    seedShared(G);
    const cap = capturing();
    const service = realService(new FakeHost(), {
      ...sharedOpts, ...cap.opts,
      fault: async p => {
        if (p !== 'S6') return;
        await cap.session().query(`UPDATE smdb_data.shared_docs SET body = convert_to('{"a":9}', 'UTF8'), sha = encode(sha256(convert_to('{"a":9}', 'UTF8')), 'hex') WHERE key = 'global/m/a.json'`);
      },
    });
    await service.post({ jobId: 'job-nb6pg-70-01', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying' });
    expect(job.error).toBe('The shared files read back from the destination differ from the source (global/m/a.json: its bytes differ); nothing was switched');
    expect(await schemas(rig)).toEqual([]);
    expect(readJson(MARKER)).toMatchObject({ live: 'file' });
  });

  it('a body changed without its sha fails the job on the stored sha', async () => {
    jsonBot();
    seedShared(G);
    const cap = capturing();
    const service = realService(new FakeHost(), {
      ...sharedOpts, ...cap.opts,
      fault: async p => {
        if (p !== 'S6') return;
        await cap.session().query(`UPDATE smdb_data.shared_docs SET body = body || '\\x00'::bytea WHERE key = 'global/m/bin.dat'`);
      },
    });
    await service.post({ jobId: 'job-nb6pg-70-02', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying' });
    expect(job.error).toBe('The shared files read back from the destination differ from the source (global/m/bin.dat: its stored sha does not match its bytes); nothing was switched');
    expect(await schemas(rig)).toEqual([]);
  });

  it('a module file changed fails the job with the module files\' text', async () => {
    jsonBot();
    seedShared(G);
    const cap = capturing();
    const service = realService(new FakeHost(), {
      ...sharedOpts, ...cap.opts,
      fault: async p => {
        if (p !== 'S6') return;
        await cap.session().query(`UPDATE smdb_data.shared_module_files SET bytes = '\\x00'::bytea WHERE module = 'mod1' AND rel = 'lib/bin.node'`);
        await cap.session().query(`UPDATE smdb_data.shared_modules SET sha = $1 WHERE module = 'mod1'`, [
          moduleShaOf([{ rel: 'lib/bin.node', sha: sha(Buffer.from([0])) }, { rel: 'module.json', sha: sha(Buffer.from(MODULE_JSON)) }]),
        ]);
      },
    });
    await service.post({ jobId: 'job-nb6pg-70-03', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying' });
    expect(job.error).toBe('The module files read back from the destination differ from the source (mod1/lib/bin.node: its bytes differ); nothing was switched');
    expect(await schemas(rig)).toEqual([]);
  });
});
