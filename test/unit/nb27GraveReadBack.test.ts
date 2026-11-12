import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { FakeDb } from '../helpers/fakePg';
import { FakeHost, MARKER, PG_URL, freshJsonBot, root, seedFile, serviceFor, useDatabaseUrl, why } from '../helpers/migrationRig';

const G = '880000000000000027';
const H = '880000000000000028';
const shared = { rootConfigPath: path.join(root, 'cfg', 'config.json'), sourceModulesDir: path.join(root, 'srcmods') };
const GRAVES_DIFFER = 'The copy in the database holds other graveyard entries or reasons than the source';
const OWNERS_DIFFER = 'The copy in the database has other ownership rows than the guilds copied';

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
  const first = await service.post({ jobId: `job-nb27-${Math.random().toString(36).slice(2, 10)}`, to: 'postgres' });
  expect(first.status, why(first)).toBe(200);
  await service.idle();
  return service.status().body.job;
}

function grave(retiredAt: number, reason: string, usedAt?: number): void {
  const entry = path.join(root, '_graveyard', `${G}-${retiredAt}`);
  fs.mkdirSync(path.join(entry, 'mod'), { recursive: true });
  fs.writeFileSync(path.join(entry, 'mod', 'a.json'), `{"r":${retiredAt}}`);
  fs.writeFileSync(path.join(entry, '.graveyard.json'), JSON.stringify({ guildId: G, reason, ts: retiredAt, ...(usedAt === undefined ? {} : { usedAt }) }));
}

const GRAVE_READ = /^SELECT guild_id, retired_at::text AS retired_at, module, filename, kind, reason/;
const OWNER_READ = 'SELECT guild_id FROM smdb_data.guild_ownership';

function withReasons(reasons: Record<string, string>): Tamper {
  return (sql, _params, answer) => (GRAVE_READ.test(sql.trim())
    ? { ...answer, rows: answer.rows.map(r => ({ ...r, reason: reasons[String(r.retired_at)] })) }
    : answer);
}

function refused(job: any, text: string): void {
  expect(job.state, why(job)).toBe('failed');
  expect(job.error).toBe(text);
  expect(JSON.parse(fs.readFileSync(MARKER, 'utf8')).live).toBe('file');
}

describe('the graveyard read-back compares each entry field by field', () => {
  it('reasons that move a "|" and a line break across two entries are refused', async () => {
    freshJsonBot();
    grave(100, 'x');
    grave(200, `p|\n${G}-200|y`);
    refused(await run(new FakeDb(), withReasons({ 100: `x|\n${G}-200|p`, 200: 'y' })), GRAVES_DIFFER);
  });

  it('a copy that holds the same entries, reasons and restore times passes', async () => {
    freshJsonBot();
    grave(100, `x|\n${G}-200|p`);
    grave(200, 'line\nbreak', 7);
    const job = await run(new FakeDb(), (_sql, _params, answer) => answer);
    expect(job.state, why(job)).toBe('done');
    expect(JSON.parse(fs.readFileSync(MARKER, 'utf8')).live).toBe('postgres');
  });
});

describe('the ownership read-back compares each guild id', () => {
  it('one ownership row that names two guilds joined by a comma is refused', async () => {
    freshJsonBot();
    seedFile(`${G}/mod/a.json`, '{"a":1}');
    seedFile(`${H}/mod/a.json`, '{"b":2}');
    const job = await run(new FakeDb(), (sql, _params, answer) => (sql.trim() === OWNER_READ
      ? { ...answer, rows: [{ guild_id: `${G},${H}` }] }
      : answer));
    refused(job, OWNERS_DIFFER);
  });
});
