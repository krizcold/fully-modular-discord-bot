import fs from 'fs';
import path from 'path';
import { format } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCredentials } from '../../src/utils/envLoader';
import { ownerMessagesFile } from '../../src/bot/internalSetup/utils/ownerMessageRecord';
import type { PgSession, ServiceOptions } from '../../src/bot/internalSetup/utils/dataMigration';
import { emptyStore, FakeDb, type Row } from '../helpers/fakePg';
import { FakeHost, MARKER, PG_URL, freshJsonBot, readJson, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

// L5 regate chunk sa3: the owner-message keys a migration carries (NB23), the ownership and graveyard read-backs, and
// the record of posted owner messages a move to JSON merges into.

const G1 = '881300000000000001';
const G2 = '881300000000000002';
const CFG = path.join(root, 'cfg', 'config.json');
const MODS = path.join(root, 'srcmods');
const KEYS_DIFFER = 'The record of posted owner messages in the copy differs from the source';
const KEYS_SQL = /^SELECT key, value, updated_at FROM smdb_data\.meta WHERE key LIKE 'owner-message:%'/;
const KEYS_UPSERT = /^INSERT INTO smdb_data\.meta AS m \(key, value, updated_at\)/;

let lines: string[];

beforeEach(() => {
  wipeRoot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
  delete process.env.FLEET_SHARD_COUNT;
  loadCredentials();
  lines = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { lines.push(format(...a)); });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DATA_BACKEND;
});

const recent = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const pgError = (code: string, text: string) => Object.assign(new Error(text), { code, severity: 'ERROR' });

type Intercept = (sql: string, forward: () => Promise<{ rows: Row[] }>) => Promise<{ rows: Row[] }> | undefined;

/** Job sessions whose statements an intercept may answer itself, without FakeDb seeing them. */
function connectVia(db: FakeDb, intercept: Intercept) {
  return async (_url: string, app: string): Promise<PgSession> => {
    const client = db.connect(app);
    return {
      query: (text: string, params: any[] = []) => intercept(text.replace(/\s+/g, ' ').trim(), () => client.query(text, params)) ?? client.query(text, params),
      end: () => client.end(),
    } as unknown as PgSession;
  };
}

async function run(db: FakeDb, jobId: string, to: 'postgres' | 'file', extra: ServiceOptions = {}) {
  const service = serviceFor(db, new FakeHost(), { rootConfigPath: CFG, sourceModulesDir: MODS, ...extra });
  const answer = await service.post({ jobId, to });
  expect(answer.body.state, why(answer)).toBe('started');
  await service.idle();
  return service.status().body.job;
}

function jsonSource(keys?: Record<string, string> | string): void {
  freshJsonBot();
  seedFile(`${G1}/m/a.json`, '{"a":1}');
  seedFile(`${G2}/m/b.json`, '{"b":2}');
  if (typeof keys === 'string') seedFile('owner-messages.json', keys);
  else if (keys) seedFile('owner-messages.json', JSON.stringify({ keys }));
}

function pgSource(db: FakeDb, storeId: string, ownerKeys: Row[] = []): void {
  writeJson(MARKER, { live: 'postgres', storeId, flippedAt: 1 });
  db.schemas.set('smdb_data', {
    ...emptyStore(storeId),
    data: [{ guild_id: G1, module: 'm', filename: 'a.json', doc: '{"a":1}' }],
    ownerKeys,
  });
}

const keyRow = (key: string, at: string) => ({ key: `owner-message:${key}`, value: JSON.stringify(at), updated_at: at });
const doneLine = (jobId: string) => {
  const found = lines.filter(l => l.startsWith(`[Migration] Migration ${jobId} (`) && l.includes(') is done: '));
  expect(found, lines.join('\n')).toHaveLength(1);
  return found[0];
};
const dbKeys = (db: FakeDb) => (db.schemas.get('smdb_data')?.ownerKeys ?? []).map(r => r.key).sort();

describe('the read of the owner-message rows in the copy', () => {
  it('a read that answers 42P01 (no meta table) holds no keys, so a move with none is done', async () => {
    jsonSource();
    const db = new FakeDb();
    const job = await run(db, 'job-sa3-k42p01', 'postgres', {
      connect: connectVia(db, sql => (KEYS_SQL.test(sql) ? Promise.reject(pgError('42P01', 'relation "smdb_data.meta" does not exist')) : undefined)),
    });
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres' });
  });

  it('a read that answers 3F000 (no schema) holds no keys, so a move with none is done', async () => {
    jsonSource();
    const db = new FakeDb();
    const job = await run(db, 'job-sa3-k3f000', 'postgres', {
      connect: connectVia(db, sql => (KEYS_SQL.test(sql) ? Promise.reject(pgError('3F000', 'schema "smdb_data" does not exist')) : undefined)),
    });
    expect(job, why(job)).toMatchObject({ state: 'done' });
  });

  it('a read refused for another cause fails the copy with that cause', async () => {
    jsonSource();
    const db = new FakeDb();
    const job = await run(db, 'job-sa3-k42501', 'postgres', {
      connect: connectVia(db, sql => (KEYS_SQL.test(sql) ? Promise.reject(pgError('42501', 'permission denied for table meta')) : undefined)),
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'copying', error: 'permission denied for table meta' });
    expect(db.schemas.has('smdb_data')).toBe(false);
    expect(readJson(MARKER)).toMatchObject({ live: 'file' });
  });

  it('a read rejected with null fails the copy naming null', async () => {
    jsonSource();
    const db = new FakeDb();
    const job = await run(db, 'job-sa3-knull1', 'postgres', {
      connect: connectVia(db, sql => (KEYS_SQL.test(sql) ? Promise.reject(null) : undefined)),
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'copying', error: 'null' });
    expect(db.schemas.has('smdb_data')).toBe(false);
  });

  it('a copy whose rows read back without the key fails with the key record text', async () => {
    jsonSource({ k1: recent(5) });
    const db = new FakeDb();
    const job = await run(db, 'job-sa3-kback1', 'postgres', {
      connect: connectVia(db, sql => (KEYS_SQL.test(sql) ? Promise.resolve({ rows: [] }) : undefined)),
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'copying', error: KEYS_DIFFER });
    expect(db.schemas.has('smdb_data')).toBe(false);
    expect(readJson(MARKER)).toMatchObject({ live: 'file' });
  });
});

describe('the write of the owner-message rows', () => {
  it('a move with no key sends no key write, so a database that refuses that write still gets the move', async () => {
    jsonSource();
    const db = new FakeDb();
    db.fail = sql => (KEYS_UPSERT.test(sql) ? pgError('42501', 'permission denied for table meta') : undefined);
    const job = await run(db, 'job-sa3-nokey1', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(dbKeys(db)).toEqual([]);
  });

  it('keys unchanged at the commit are not written or read again', async () => {
    jsonSource({ k1: recent(5) });
    const db = new FakeDb();
    let armed = false;
    db.fail = sql => (armed && /owner-message/.test(sql) ? pgError('57P01', 'terminating connection due to administrator command') : undefined);
    const job = await run(db, 'job-sa3-same01', 'postgres', { fault: p => { if (p === 'before-commit') armed = true; } });
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(dbKeys(db)).toEqual(['owner-message:k1']);
  });

  it('a record unreadable at the read is not copied even when it reads at the commit', async () => {
    jsonSource('not json');
    const db = new FakeDb();
    const job = await run(db, 'job-sa3-late01', 'postgres', {
      fault: p => { if (p === 'before-commit') fs.writeFileSync(ownerMessagesFile(), JSON.stringify({ keys: { late: recent(1) } })); },
    });
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(dbKeys(db)).toEqual([]);
    expect(doneLine('job-sa3-late01')).not.toContain('owner message key');
    expect(job.notes.some((n: string) => n.startsWith('The record of posted owner messages (/data/owner-messages.json) could not be read ('))).toBe(true);
  });
});

describe('the done line names the owner-message keys', () => {
  it('one key copied into the database', async () => {
    jsonSource({ k1: recent(5) });
    const db = new FakeDb();
    const job = await run(db, 'job-sa3-line01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(dbKeys(db)).toEqual(['owner-message:k1']);
    expect(doneLine('job-sa3-line01')).toContain('; 1 owner message key copied into the database');
  });

  it('two keys copied into the database', async () => {
    jsonSource({ k1: recent(5), k2: recent(6) });
    const db = new FakeDb();
    const job = await run(db, 'job-sa3-line02', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(doneLine('job-sa3-line02')).toContain('; 2 owner message keys copied into the database');
  });

  it('one key from the database merged into the record of a JSON bot', async () => {
    const db = new FakeDb();
    const at = recent(5);
    pgSource(db, 'src-sa3-line03', [keyRow('k1', at)]);
    const job = await run(db, 'job-sa3-line03', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(doneLine('job-sa3-line03')).toContain('; 1 owner message key from the database merged into /data/owner-messages.json');
    expect(doneLine('job-sa3-line03')).not.toContain('copied into the database');
    expect(JSON.parse(fs.readFileSync(ownerMessagesFile(), 'utf8'))).toEqual({ keys: { k1: at } });
  });
});

describe('the read-back of the ownership rows and the graveyard', () => {
  it('a copy with one ownership row fewer than its guilds fails at verifying', async () => {
    jsonSource();
    const db = new FakeDb();
    let armed = false;
    const job = await run(db, 'job-sa3-own001', 'postgres', {
      fault: p => { if (p === 'S6') armed = true; },
      connect: connectVia(db, (sql, forward) => {
        if (!armed || sql !== 'SELECT guild_id FROM smdb_data.guild_ownership') return undefined;
        return forward().then(res => ({ rows: res.rows.filter(r => String(r.guild_id) === G1) }));
      }),
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying', error: 'The copy in the database has other ownership rows than the guilds copied' });
    expect(db.schemas.has('smdb_data')).toBe(false);
  });

  it('graveyard rows read back in another order still match the source', async () => {
    jsonSource();
    seedFile(`_graveyard/${G1}-1000/m/g.json`, '{"g":1}');
    seedFile(`_graveyard/${G1}-1000/.graveyard.json`, JSON.stringify({ guildId: G1, reason: 'left', ts: 1000 }));
    seedFile(`_graveyard/${G2}-2000/m/g.json`, '{"g":2}');
    seedFile(`_graveyard/${G2}-2000/.graveyard.json`, JSON.stringify({ guildId: G2, reason: 'kicked', ts: 2000 }));
    const db = new FakeDb();
    let armed = false;
    let reversed = 0;
    const job = await run(db, 'job-sa3-grv001', 'postgres', {
      fault: p => { if (p === 'S6') armed = true; },
      connect: connectVia(db, (sql, forward) => {
        if (!armed || !/^SELECT guild_id, retired_at::text AS retired_at, module, filename, kind, reason, used_at/.test(sql)) return undefined;
        return forward().then(res => {
          reversed += 1;
          return { rows: [...res.rows].sort((a, b) => (String(a.guild_id) < String(b.guild_id) ? 1 : -1)) };
        });
      }),
    });
    expect(reversed).toBe(1);
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(db.schemas.get('smdb_data')!.grave.length).toBe(2);
  });
});

describe('a move to JSON merges the keys into the record of posted owner messages', () => {
  const aside = () => {
    const names = fs.readdirSync(path.join(root, '_superseded'));
    expect(names).toHaveLength(1);
    return path.join(root, '_superseded', names[0], 'owner-messages.json');
  };

  it('an unreadable record whose place in the superseded folder is taken refuses, keeping both', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-sa3-asd01');
    seedFile('owner-messages.json', 'not json');
    fs.mkdirSync(path.join(root, '.migrate-1'));
    let kept = '';
    const job = await run(db, 'job-sa3-asd001', 'file', {
      fault: p => {
        if (p !== 'S8') return;
        kept = aside();
        fs.writeFileSync(kept, 'earlier');
      },
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'placing', error: `${kept} exists; nothing was moved` });
    expect(fs.readFileSync(kept, 'utf8')).toBe('earlier');
    expect(fs.readFileSync(ownerMessagesFile(), 'utf8')).toBe('not json');
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres' });
  });

  function readsOfRecord(answer: (n: number, real: () => any) => any) {
    const real = fs.readFileSync;
    let n = 0;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (typeof p === 'string' && path.resolve(p) === path.resolve(ownerMessagesFile())) {
        n += 1;
        return answer(n, () => (real as any)(p, ...rest));
      }
      return (real as any)(p, ...rest);
    }) as typeof fs.readFileSync);
  }

  it('a record readable at the first look and not at the second fails naming its cause', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-sa3-rd2', [keyRow('k1', recent(5))]);
    const job = await run(db, 'job-sa3-read02', 'file', {
      fault: p => {
        if (p !== 'S8') return;
        readsOfRecord((n, real) => {
          if (n === 2) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
          return real();
        });
      },
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', error: 'The record of posted owner messages (/data/owner-messages.json) could not be read (EACCES)' });
  });

  it('a merged record that reads back with other keys fails with the key record text', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-sa3-rd3', [keyRow('k1', recent(5))]);
    const job = await run(db, 'job-sa3-read03', 'file', {
      fault: p => {
        if (p !== 'S8') return;
        readsOfRecord((n, real) => (n === 3 ? JSON.stringify({ keys: { other: recent(1) } }) : real()));
      },
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', error: KEYS_DIFFER });
  });
});
