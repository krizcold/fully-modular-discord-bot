import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, MARKER, PG_URL, freshJsonBot, root, serviceFor, useDatabaseUrl, why, wipeRoot, writeJson } from '../helpers/migrationRig';

const G = '880000000000000001';
const CH = '500000000000000001';
const shared = { rootConfigPath: path.join(root, 'cfg', 'config.json'), sourceModulesDir: path.join(root, 'srcmods') };
const logs: string[] = [];

beforeEach(() => {
  logs.length = 0;
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  const capture = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});
afterEach(() => vi.restoreAllMocks());

type Hook = (sql: string, params: unknown[] | undefined) => { throw: unknown } | { params: unknown[] } | undefined;

/** FakeDb's sessions, with each statement first offered to the hook, which may throw a value or change the parameters. */
function hooked(db: FakeDb, hook: Hook) {
  return async (_url: string, app: string): Promise<PgSession> => {
    const client = db.connect(app);
    return {
      query: async (text: string, params?: unknown[]) => {
        const out = hook(text, params);
        if (out && 'throw' in out) throw out.throw;
        return client.query(text, (out && 'params' in out ? out.params : params) as any[]);
      },
      end: () => client.end(),
    };
  };
}

async function run(db: FakeDb, to: 'postgres' | 'file', extra: Record<string, unknown> = {}): Promise<any> {
  const service = serviceFor(db, new FakeHost(), { ...shared, ...extra });
  const first = await service.post({ jobId: `job-ra44-${to}-${Math.random().toString(36).slice(2, 8)}`, to });
  expect(first.status, why(first)).toBe(200);
  await service.idle();
  return service.status().body.job;
}

function pgSource(): FakeDb {
  wipeRoot();
  writeJson(MARKER, { live: 'postgres', storeId: 'store-p', flippedAt: 1 });
  const db = new FakeDb();
  const store = emptyStore('store-p');
  store.data.push({ guild_id: G, module: 'mod', filename: 'a.json', doc: '{"a":1}' });
  db.schemas.set('smdb_data', store);
  return db;
}

const isChannelRead = (sql: string) => /^SELECT value FROM smdb_data\.meta WHERE key = 'owner_channel'/.test(sql.trim());
const pgError = (code: string) => Object.assign(new Error(`server error ${code}`), { code, severity: 'ERROR' });

describe('the owner channel read of a Postgres session answers none only for a missing table or schema', () => {
  it('a 42P01 on the owner channel read is no setting: the move to JSON finishes and writes no channel file', async () => {
    const db = pgSource();
    const job = await run(db, 'file', { connect: hooked(db, sql => (isChannelRead(sql) ? { throw: pgError('42P01') } : undefined)) });
    expect(job.state, why(job)).toBe('done');
    expect(fs.readFileSync(path.join(root, G, 'mod', 'a.json'), 'utf8')).toBe('{"a":1}');
    expect(fs.existsSync(path.join(root, 'owner-channel.json'))).toBe(false);
  });

  it('a 3F000 on the owner channel read is no setting too', async () => {
    const db = pgSource();
    const job = await run(db, 'file', { connect: hooked(db, sql => (isChannelRead(sql) ? { throw: pgError('3F000') } : undefined)) });
    expect(job.state, why(job)).toBe('done');
    expect(fs.readFileSync(path.join(root, G, 'mod', 'a.json'), 'utf8')).toBe('{"a":1}');
  });

  it('any other error of the owner channel read fails the job with its text and leaves the source in place', async () => {
    const db = pgSource();
    const job = await run(db, 'file', { connect: hooked(db, sql => (isChannelRead(sql) ? { throw: pgError('57P01') } : undefined)) });
    expect(job.state, why(job)).toBe('failed');
    expect(job.error).toContain('server error 57P01');
    expect(fs.existsSync(path.join(root, G))).toBe(false);
    expect(JSON.parse(fs.readFileSync(MARKER, 'utf8')).live).toBe('postgres');
  });

  it('a null thrown by the owner channel read fails the job naming null, not a TypeError of the code check', async () => {
    const db = pgSource();
    const job = await run(db, 'file', { connect: hooked(db, sql => (isChannelRead(sql) ? { throw: null } : undefined)) });
    expect(job.state, why(job)).toBe('failed');
    expect(job.error).toBe('null');
  });
});

describe('the owner channel of the source read a second time', () => {
  it('a channel file removed before the second read fails the job with the differs text, and nothing is switched', async () => {
    freshJsonBot();
    fs.mkdirSync(path.join(root, G, 'mod'), { recursive: true });
    fs.writeFileSync(path.join(root, G, 'mod', 'a.json'), '{"a":1}');
    const channel = path.join(root, 'owner-channel.json');
    fs.writeFileSync(channel, JSON.stringify({ channelId: CH }));
    const db = new FakeDb();
    const job = await run(db, 'postgres', { fault: (point: string) => { if (point === 'S7') fs.rmSync(channel); } });
    expect(job.state, why(job)).toBe('failed');
    expect(job.error).toContain('The owner messages channel in the source read a second time differs from the source');
    expect(JSON.parse(fs.readFileSync(MARKER, 'utf8')).live).toBe('file');
    expect(db.schemas.has('smdb_data')).toBe(false);
  });
});

describe('the graveyard read-back compares the newest restore', () => {
  it('a copy whose used_at differs from the note fails the job, so no copy with another restore time is switched to', async () => {
    freshJsonBot();
    const entry = path.join(root, '_graveyard', `${G}-100`);
    fs.mkdirSync(path.join(entry, 'mod'), { recursive: true });
    fs.writeFileSync(path.join(entry, 'mod', 'a.json'), '{"a":1}');
    fs.writeFileSync(path.join(entry, '.graveyard.json'), JSON.stringify({ guildId: G, reason: 'left', ts: 100, usedAt: 5 }));
    const db = new FakeDb();
    const bump: Hook = (sql, params) => {
      if (!/^INSERT INTO smdb_data\.guild_data_graveyard/.test(sql.trim()) || !params) return undefined;
      const used = params[7] as Array<string | null>;
      return { params: [...params.slice(0, 7), used.map(u => (u === null ? null : '7'))] };
    };
    const job = await run(db, 'postgres', { connect: hooked(db, bump) });
    expect(job.state, why(job)).toBe('failed');
    expect(job.error).toContain('The copy in the database holds other graveyard entries or reasons than the source');
    expect(JSON.parse(fs.readFileSync(MARKER, 'utf8')).live).toBe('file');
  });

  it('the same copy without the change finishes, with used_at 5 stored', async () => {
    freshJsonBot();
    const entry = path.join(root, '_graveyard', `${G}-100`);
    fs.mkdirSync(path.join(entry, 'mod'), { recursive: true });
    fs.writeFileSync(path.join(entry, 'mod', 'a.json'), '{"a":1}');
    fs.writeFileSync(path.join(entry, '.graveyard.json'), JSON.stringify({ guildId: G, reason: 'left', ts: 100, usedAt: 5 }));
    const db = new FakeDb();
    const job = await run(db, 'postgres');
    expect(job.state, why(job)).toBe('done');
    expect(db.schemas.get('smdb_data')!.grave.map(r => r.used_at)).toEqual(['5']);
  });
});

describe('a guild stream with an open tail', () => {
  it('is named in the job and in a warning, for a guild and for a graveyard entry', async () => {
    freshJsonBot();
    fs.mkdirSync(path.join(root, G, 'mod'), { recursive: true });
    fs.writeFileSync(path.join(root, G, 'mod', 'log.jsonl'), '{"e":1}\n{"e":2}');
    fs.writeFileSync(path.join(root, G, 'mod', 'ok.jsonl'), '{"e":1}\n');
    const entry = path.join(root, '_graveyard', `${G}-100`);
    fs.mkdirSync(entry, { recursive: true });
    fs.writeFileSync(path.join(entry, 'top.jsonl'), '{"e":3}');
    fs.writeFileSync(path.join(entry, '.graveyard.json'), JSON.stringify({ guildId: G, reason: 'left', ts: 100 }));
    const db = new FakeDb();
    const job = await run(db, 'postgres');
    expect(job.state, why(job)).toBe('done');
    expect([...job.closedTails].sort()).toEqual([`mod/log.jsonl of guild ${G}`, `top.jsonl of graveyard entry ${G}-100`]);
    expect(logs.some(l => l.includes(`The stream mod/log.jsonl of guild ${G} did not end in a newline`))).toBe(true);
    expect(logs.some(l => l.includes(`The stream top.jsonl of graveyard entry ${G}-100 did not end in a newline`))).toBe(true);
    const chunks = db.schemas.get('smdb_data')!.append.filter(r => r.filename === 'log.jsonl').map(r => r.chunk).join('');
    expect(chunks).toBe('{"e":1}\n{"e":2}\n');
  });
});

describe('the refusal of an address list counts its addresses', () => {
  const cases: Array<[string, number]> = [
    ['postgres://a@h1/db,postgres://b@h2/db,postgres://c@h3/db', 3],
    ['postgres://a@h1/db, postgres://b@h2/db', 2],
    ['postgres://a@h1/db  postgres://b@h2/db', 2],
    ['postgres://a@h1/db postgres://b@h2/db', 2],
  ];
  for (const [url, n] of cases) {
    it(`${JSON.stringify(url)} lists ${n}`, async () => {
      freshJsonBot();
      const service = serviceFor(new FakeDb(), new FakeHost(), shared);
      const answer = await service.post({ jobId: 'job-ra44-list-0001', to: 'postgres', url });
      expect(answer.status, why(answer)).toBe(409);
      expect(answer.body.error).toBe(`DATA_BACKEND_URL lists ${n} database addresses (live copies on other machines); a migration needs one database address, so remove the live copies first`);
    });
  }
});
