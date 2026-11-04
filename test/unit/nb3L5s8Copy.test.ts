import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { loadCredentials } from '../../src/utils/envLoader';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import {
  FakeHost, JOURNAL, MARKER, PG_URL, STORES, freshJsonBot, readJson, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson, why,
} from '../helpers/migrationRig';

// NB3 S4 to S6: the store-id rechecks, the rename aside, the ownership rows, the staging folder and the read-back.

const G1 = '880000000000000201';
const G2 = '880000000000000202';

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
  delete process.env.FLEET_SHARD_COUNT;
});

type Override = (sql: string, run: () => Promise<{ rows: any[]; command?: string }>) => Promise<{ rows: any[]; command?: string }> | undefined;

/** The fake's client, with an answer a test may change per statement. */
function connectWith(db: FakeDb, override: Override) {
  return async (_url: string, app: string): Promise<PgSession> => {
    const client = db.connect(app);
    return {
      query: (text: string, params: any[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        return override(sql, () => client.query(text, params)) ?? client.query(text, params);
      },
      end: () => client.end(),
    } as unknown as PgSession;
  };
}

async function runJob(db: FakeDb, jobId: string, to: 'file' | 'postgres', opts: { fault?: (p: string) => void | Promise<void>; override?: Override } = {}) {
  const service = serviceFor(db, new FakeHost(), {
    ...(opts.override ? { connect: connectWith(db, opts.override) } : {}),
    ...(opts.fault ? { fault: opts.fault } : {}),
  });
  const answer = await service.post({ jobId, to });
  expect(answer.body.state, why(answer)).toBe('started');
  await service.idle();
  return service.status().body.job;
}

function pgSource(db: FakeDb, storeId = 'src-s8'): void {
  writeJson(MARKER, { live: 'postgres', storeId, flippedAt: 1 });
  db.schemas.set('smdb_data', {
    ...emptyStore(storeId),
    data: [{ guild_id: G1, module: 'm', filename: 'a.json', doc: '{"a":1}' }, { guild_id: G2, module: 'm', filename: 'b.json', doc: '{"b":2}' }],
  });
}

function jsonSource(withGrave = false): void {
  freshJsonBot();
  seedFile(`${G1}/m/a.json`, '{"a":1}');
  seedFile(`${G2}/m/b.json`, '{"b":2}');
  if (withGrave) {
    seedFile(`_graveyard/${G1}-1700000000000/m/g.json`, '{"g":1}');
    seedFile(`_graveyard/${G1}-1700000000000/.graveyard.json`, JSON.stringify({ reason: 'left' }));
  }
}

/** A JSON bot whose database already holds a store this deployment served, so the job renames it aside. */
function servedStore(db: FakeDb, owners: Array<{ guild: string; node: string }> = []): void {
  jsonSource();
  writeJson(STORES, { storeIds: ['old-s8'] });
  writeJson(JOURNAL, { jobId: 'job-s8-prev', to: 'file', stage: 'switching', result: 'done', startedAt: 1, finishedAt: 2 });
  const s = emptyStore('old-s8');
  for (const o of owners) s.owners.push({ guild_id: o.guild, node_id: o.node, shard_id: 0, claim: '0', shard_count: 1, retired_at: null });
  db.schemas.set('smdb_data', s);
}

const stagingDir = () => {
  const names = fs.readdirSync(root).filter(n => n.startsWith('.migrate-'));
  expect(names).toHaveLength(1);
  return path.join(root, names[0]);
};

describe('S4: a Postgres source rechecked inside its read transaction', () => {
  it('refuses, naming both ids, when the store changed since the first check', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-s8-a');
    const job = await runJob(db, 'job-s8-s4-001', 'file', {
      fault: p => { if (p === 'S4') db.schemas.get('smdb_data')!.storeId = 'changed-s8'; },
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading' });
    expect(job.error).toBe("The database's store changed to changed-s8 since the first check (src-s8-a)");
    expect(readJson(MARKER).live).toBe('postgres');
    expect(fs.existsSync(path.join(root, G1))).toBe(false);
  });

  it('a failure after the read transaction began rolls it back', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-s8-b');
    const job = await runJob(db, 'job-s8-s4-002', 'file', { fault: p => { if (p === 'S5') throw new Error('stop at S5'); } });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'copying', error: 'stop at S5' });
    const sent = db.statements('smdb-migrate:job-s8-s4-002');
    expect(sent.indexOf('ROLLBACK')).toBeGreaterThan(sent.findIndex(s => /^BEGIN ISOLATION LEVEL REPEATABLE READ$/.test(s)));
  });
});

describe('S5 to JSON: the journal and the staging folder', () => {
  it('a JSON destination is not recorded as a database destination', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-s8-c');
    const job = await runJob(db, 'job-s8-s5-001', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(readJson(JOURNAL)).not.toHaveProperty('destination');
  });

  it('an empty staging folder of the same name already there does not fail the copy', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-s8-d');
    const job = await runJob(db, 'job-s8-s5-002', 'file', {
      fault: p => {
        if (p !== 'S5') return;
        const t = Date.now();
        fs.mkdirSync(path.join(root, `.migrate-${t}`));
        vi.spyOn(Date, 'now').mockReturnValueOnce(t);
      },
    });
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(fs.readFileSync(path.join(root, G1, 'm', 'a.json'), 'utf-8')).toBe('{"a":1}');
  });
});

describe('S5 to Postgres: the store renamed aside', () => {
  it('refuses, naming both ids, when the store changed since the first check', async () => {
    const db = new FakeDb();
    servedStore(db);
    const job = await runJob(db, 'job-s8-ren-01', 'postgres', { fault: p => { if (p === 'S5') db.schemas.get('smdb_data')!.storeId = 'moved-s8'; } });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'copying' });
    expect(job.error).toBe("The database's store changed from old-s8 to moved-s8 since the first check; it was not renamed");
    expect([...db.schemas.keys()]).toEqual(['smdb_data']);
    expect(db.schemas.get('smdb_data')!.storeId).toBe('moved-s8');
  });

  it('says none when the store id is gone since the first check', async () => {
    const db = new FakeDb();
    servedStore(db);
    const job = await runJob(db, 'job-s8-ren-02', 'postgres', { fault: p => { if (p === 'S5') db.schemas.get('smdb_data')!.storeId = null; } });
    expect(job.error, why(job)).toBe("The database's store changed from old-s8 to none since the first check; it was not renamed");
  });

  it('refuses, with the count, when another bot owns guilds of the store', async () => {
    const db = new FakeDb();
    servedStore(db, [{ guild: G1, node: 'other-node' }, { guild: G2, node: 'node-test' }]);
    const job = await runJob(db, 'job-s8-ren-03', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'copying' });
    expect(job.error).toBe('Store old-s8 has 1 guild(s) owned by another bot; it was not renamed');
    expect([...db.schemas.keys()]).toEqual(['smdb_data']);
    expect(db.schemas.get('smdb_data')!.storeId).toBe('old-s8');
    expect(readJson(MARKER).live).toBe('file');
  });

  it('renames a store whose guilds this bot alone owns', async () => {
    const db = new FakeDb();
    servedStore(db, [{ guild: G1, node: 'node-test' }]);
    const job = await runJob(db, 'job-s8-ren-04', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const aside = [...db.schemas.keys()].filter(n => n.startsWith('smdb_superseded_'));
    expect(aside).toHaveLength(1);
    expect(db.schemas.get(aside[0])!.storeId).toBe('old-s8');
  });

  it('an owner count read with no row counts as no other owner', async () => {
    const db = new FakeDb();
    servedStore(db);
    const job = await runJob(db, 'job-s8-ren-05', 'postgres', {
      override: sql => (/count\(\*\)::int AS n FROM smdb_data\.guild_ownership WHERE retired_at IS NULL AND node_id <> \$1/.test(sql) ? Promise.resolve({ rows: [] }) : undefined),
    });
    expect(job, why(job)).toMatchObject({ state: 'done' });
  });

  it('a failure after the copy transaction began rolls it back', async () => {
    const db = new FakeDb();
    jsonSource();
    const job = await runJob(db, 'job-s8-ren-06', 'postgres', { fault: p => { if (p === 'S6') throw new Error('stop at S6'); } });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying', error: 'stop at S6' });
    const sent = db.statements('smdb-migrate:job-s8-ren-06');
    expect(sent.lastIndexOf('ROLLBACK')).toBeGreaterThan(sent.lastIndexOf('BEGIN'));
    expect(db.schemas.has('smdb_data')).toBe(false);
  });
});

describe('S5 to Postgres: the shard count of the ownership rows', () => {
  async function shardCounts(value: string, jobId: string): Promise<number[]> {
    process.env.FLEET_SHARD_COUNT = value;
    const db = new FakeDb();
    jsonSource();
    const job = await runJob(db, jobId, 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    return db.schemas.get('smdb_data')!.owners.map(o => o.shard_count);
  }

  it('takes FLEET_SHARD_COUNT when it is a positive integer', async () => {
    expect(await shardCounts('4', 'job-s8-shd-01')).toEqual([4, 4]);
  });

  it('takes 1 for a FLEET_SHARD_COUNT of 0', async () => {
    expect(await shardCounts('0', 'job-s8-shd-02')).toEqual([1, 1]);
  });

  it('takes 1 for a negative FLEET_SHARD_COUNT', async () => {
    expect(await shardCounts('-2', 'job-s8-shd-03')).toEqual([1, 1]);
  });
});

describe('S6: the read-back of a Postgres copy', () => {
  it('a document that reads back with another hash fails the job, naming the database copy', async () => {
    const db = new FakeDb();
    jsonSource();
    let back = false;
    const job = await runJob(db, 'job-s8-rb-001', 'postgres', {
      fault: p => { if (p === 'S6') back = true; },
      override: (sql, run) => (back && /sha256.*FROM smdb_data\.guild_data$/.test(sql)
        ? run().then(r => ({ ...r, rows: r.rows.map((x, i) => (i === 0 ? { ...x, h: '00' } : x)) })) : undefined),
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying' });
    expect(job.error).toMatch(/^The copy in the database differs from the source in 1 document\(s\): /);
    expect(db.schemas.has('smdb_data')).toBe(false);
  });

  it('a graveyard entry that reads back with another reason fails the job, naming the database copy', async () => {
    const db = new FakeDb();
    jsonSource(true);
    let back = false;
    const job = await runJob(db, 'job-s8-rb-002', 'postgres', {
      fault: p => { if (p === 'S6') back = true; },
      override: (sql, run) => (back && /sha256.*FROM smdb_data\.guild_data_graveyard$/.test(sql)
        ? run().then(r => ({ ...r, rows: r.rows.map(x => ({ ...x, reason: 'other' })) })) : undefined),
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying' });
    expect(job.error).toBe('The copy in the database holds other graveyard entries or reasons than the source');
  });

  it('a missing ownership row fails the job', async () => {
    const db = new FakeDb();
    jsonSource();
    let back = false;
    const job = await runJob(db, 'job-s8-rb-003', 'postgres', {
      fault: p => { if (p === 'S6') back = true; },
      override: (sql, run) => (back && sql === 'SELECT guild_id FROM smdb_data.guild_ownership'
        ? run().then(r => ({ ...r, rows: r.rows.slice(1) })) : undefined),
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying' });
    expect(job.error).toBe('The copy in the database has other ownership rows than the guilds copied');
    expect(db.schemas.has('smdb_data')).toBe(false);
  });

  it('ownership rows read back in another order still verify', async () => {
    const db = new FakeDb();
    jsonSource();
    let back = false;
    const job = await runJob(db, 'job-s8-rb-004', 'postgres', {
      fault: p => { if (p === 'S6') back = true; },
      override: (sql, run) => (back && sql === 'SELECT guild_id FROM smdb_data.guild_ownership'
        ? run().then(r => ({ ...r, rows: [...r.rows].reverse() })) : undefined),
    });
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(db.schemas.get('smdb_data')!.owners.map(o => o.guild_id).sort()).toEqual([G1, G2]);
  });
});

describe('S6: the read-back of a staged JSON copy', () => {
  function stagedSource(db: FakeDb): void {
    pgSource(db, 'src-s8-st');
    db.schemas.get('smdb_data')!.grave.push({ guild_id: G1, module: 'm', filename: 'g.json', kind: 'doc', doc: '{"g":1}', retired_at: '1700000000000', reason: 'left' });
  }

  it('a staged document changed before the read-back fails the job, naming the staged copy', async () => {
    const db = new FakeDb();
    stagedSource(db);
    const job = await runJob(db, 'job-s8-st-001', 'file', {
      fault: p => { if (p === 'S6') fs.writeFileSync(path.join(stagingDir(), G1, 'm', 'a.json'), '{"a":2}'); },
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying' });
    expect(job.error).toMatch(/^The staged copy differs from the source in 1 document\(s\): /);
    expect(fs.existsSync(path.join(root, G1))).toBe(false);
    expect(readJson(MARKER).live).toBe('postgres');
  });

  it('a staged graveyard reason changed before the read-back fails the job, naming the staged copy', async () => {
    const db = new FakeDb();
    stagedSource(db);
    const job = await runJob(db, 'job-s8-st-002', 'file', {
      fault: p => {
        if (p === 'S6') fs.writeFileSync(path.join(stagingDir(), '_graveyard', `${G1}-1700000000000`, '.graveyard.json'), JSON.stringify({ reason: 'other' }));
      },
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying' });
    expect(job.error).toBe('The staged copy holds other graveyard entries or reasons than the source');
  });
});
