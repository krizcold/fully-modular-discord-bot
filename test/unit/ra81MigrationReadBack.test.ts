import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { moduleShaOf } from '../../src/bot/internalSetup/utils/sharedModules';
import { FakeDb } from '../helpers/fakePg';
import { FakeHost, MARKER, PG_URL, freshJsonBot, root, serviceFor, useDatabaseUrl, why } from '../helpers/migrationRig';

// L5 run A, chunk 81: what the read-back of a move to Postgres compares. The graveyard check compares the sorted
// keys of the source and the copy joined into one text; the shared check names the first destination file the source
// lacks, in the order of its rel.

const G = '880000000000000081';
const shared = { rootConfigPath: path.join(root, 'cfg', 'config.json'), sourceModulesDir: path.join(root, 'srcmods') };

beforeEach(() => {
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

type Rows = { rows: any[]; command?: string };
type Tamper = (sql: string, params: unknown[] | undefined, answer: Rows) => Rows;

function tampered(db: FakeDb, tamper: Tamper) {
  return async (_url: string, app: string): Promise<PgSession> => {
    const client = db.connect(app);
    return {
      query: async (text: string, params?: unknown[]) => tamper(text, params, await client.query(text, params as any[])),
      end: () => client.end(),
    };
  };
}

async function run(db: FakeDb, tamper: Tamper): Promise<any> {
  const service = serviceFor(db, new FakeHost(), { ...shared, connect: tampered(db, tamper) });
  const first = await service.post({ jobId: `job-ra81-${Math.random().toString(36).slice(2, 10)}`, to: 'postgres' });
  expect(first.status, why(first)).toBe(200);
  await service.idle();
  return service.status().body.job;
}

function grave(retiredAt: number, reason: string): void {
  const entry = path.join(root, '_graveyard', `${G}-${retiredAt}`);
  fs.mkdirSync(path.join(entry, 'mod'), { recursive: true });
  fs.writeFileSync(path.join(entry, 'mod', 'a.json'), `{"r":${retiredAt}}`);
  fs.writeFileSync(path.join(entry, '.graveyard.json'), JSON.stringify({ guildId: G, reason, ts: retiredAt }));
}

const GRAVE_READ = /^SELECT guild_id, retired_at::text AS retired_at, module, filename, kind, reason/;

describe('the graveyard read-back compares each entry field by field', () => {
  it('a copy whose reasons split the same joined text at another entry is refused', async () => {
    freshJsonBot();
    grave(100, 'x');
    grave(200, `p|\n${G}-200|y`);
    const db = new FakeDb();
    const reasons: Record<string, string> = { 100: `x|\n${G}-200|p`, 200: 'y' };
    const job = await run(db, (sql, _params, answer) => (GRAVE_READ.test(sql.trim())
      ? { ...answer, rows: answer.rows.map(r => ({ ...r, reason: reasons[String(r.retired_at)] })) }
      : answer));
    expect(job.state, why(job)).toBe('failed');
    expect(job.error).toBe('The copy in the database holds other graveyard entries or reasons than the source');
    expect(JSON.parse(fs.readFileSync(MARKER, 'utf8')).live).toBe('file');
  });
});

describe('the shared read-back names a module the source lacks by its first file in rel order', () => {
  it('the files come back z.js then a.js: the job fails naming zz/a.js', async () => {
    freshJsonBot();
    const db = new FakeDb();
    const files = [{ rel: 'z.js', h: '11' }, { rel: 'a.js', h: '22' }];
    const sha = moduleShaOf(files.map(f => ({ rel: f.rel, sha: f.h })));
    const job = await run(db, (sql, params, answer) => {
      const t = sql.trim();
      if (t === 'SELECT module, sha FROM smdb_data.shared_modules') return { ...answer, rows: [...answer.rows, { module: 'zz', sha }] };
      if (t.startsWith("SELECT rel, encode(sha256(bytes), 'hex') AS h FROM smdb_data.shared_module_files") && params?.[0] === 'zz') {
        return { ...answer, rows: files };
      }
      return answer;
    });
    expect(job.state, why(job)).toBe('failed');
    expect(job.error).toBe('The module files read back from the destination differ from the source (zz/a.js: not in the source); nothing was switched');
    expect(JSON.parse(fs.readFileSync(MARKER, 'utf8')).live).toBe('file');
  });
});
