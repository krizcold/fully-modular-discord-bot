import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB5 section 8 test 12, its first rows (decision 16): a verify-full entry with an IP host reaches the migration's
// session as a config carrying ssl.host. The list refusal's new text is pinned in nb3L5s6Classify.test.ts.

const rig = vi.hoisted(() => ({ configs: [] as any[] }));

vi.mock('../../src/bot/internalSetup/utils/pgClient', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/pgClient')>();
  return {
    ...real,
    shortLivedClient: (config: any) => {
      rig.configs.push(config);
      return { connect: async () => undefined, end: async () => undefined, query: async () => ({ rows: [] }), on: () => undefined };
    },
  };
});

import { openJobSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, JOURNAL, MARKER, PG_URL, freshJsonBot, readJson, root, serviceFor, useDatabaseUrl, wipeRoot, writeJson } from '../helpers/migrationRig';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb5-mig-'));
const ca = path.join(dir, 'ca.crt');
fs.writeFileSync(ca, 'CA-BYTES');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the migration session on a verify-full IP entry', () => {
  it('connects with ssl.host set to the IP and no connectionString', async () => {
    await openJobSession(`postgresql://bot:pw@10.0.0.5:5432/bot?sslmode=verify-full&sslrootcert=${ca}`, 'smdb-migrate:job-nb5-0001', 'job');
    expect(rig.configs).toHaveLength(1);
    expect(rig.configs[0].connectionString).toBeUndefined();
    expect(rig.configs[0]).toMatchObject({ host: '10.0.0.5', ssl: { host: '10.0.0.5', ca: 'CA-BYTES' }, application_name: 'smdb-migrate:job-nb5-0001' });
  });
});

// Section 8 test 12, rounds 6 and 7 (decision 16): the owner channel setting carried by the migration, and S3's wait
// for a setting write in flight.

const CH = '500000000000000001';
const OTHER = '500000000000000009';
const G = '880000000000000001';
const channelFile = () => path.join(root, 'owner-channel.json');
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

function pgSource(channel: string | null): FakeDb {
  wipeRoot();
  writeJson(MARKER, { live: 'postgres', storeId: 'store-p', flippedAt: 1 });
  const db = new FakeDb();
  const store = emptyStore('store-p');
  store.data.push({ guild_id: G, module: 'mod', filename: 'a.json', doc: '{"a":1}' });
  if (channel !== null) store.ownerChannel = JSON.stringify(channel);
  db.schemas.set('smdb_data', store);
  return db;
}

function jsonSource(channel: unknown): void {
  freshJsonBot();
  fs.mkdirSync(path.join(root, G, 'mod'), { recursive: true });
  fs.writeFileSync(path.join(root, G, 'mod', 'a.json'), '{"a":1}');
  if (channel !== undefined) fs.writeFileSync(channelFile(), JSON.stringify({ channelId: channel }));
}

async function run(db: FakeDb, to: 'postgres' | 'file', host = new FakeHost(), extra = {}): Promise<any> {
  const service = serviceFor(db, host, extra);
  await service.post({ jobId: `job-nb5-${to}-${Math.random().toString(36).slice(2, 8)}`, to });
  await service.idle();
  return service.status().body.job;
}

describe('decision 16: the owner channel in the copy set', () => {
  it('a JSON bot with the file holding C migrated to Postgres: the transaction upserts owner_channel C after provisioning', async () => {
    jsonSource(CH);
    const db = new FakeDb();
    expect((await run(db, 'postgres')).state).toBe('done');
    expect(db.schemas.get('smdb_data')!.ownerChannel).toBe(JSON.stringify(CH));
    const sql = db.statements();
    const upsert = sql.findIndex(s => /INSERT INTO smdb_data\.meta .*'owner_channel'/.test(s));
    expect(upsert).toBeGreaterThan(sql.findIndex(s => /^INSERT INTO smdb_data\.meta .*'store_id'/.test(s)));
  });

  it('with no file, the transaction deletes the row', async () => {
    jsonSource(undefined);
    const db = new FakeDb();
    expect((await run(db, 'postgres')).state).toBe('done');
    expect(db.statements()).toContain("DELETE FROM smdb_data.meta WHERE key = 'owner_channel'");
    expect(db.schemas.get('smdb_data')!.ownerChannel).toBeUndefined();
  });

  it('a Postgres source with the row C migrated to JSON: the file holds C, an older file moved into the superseded folder', async () => {
    const db = pgSource(CH);
    fs.writeFileSync(channelFile(), JSON.stringify({ channelId: OTHER }));
    expect((await run(db, 'file')).state).toBe('done');
    expect(JSON.parse(fs.readFileSync(channelFile(), 'utf8'))).toEqual({ channelId: CH });
    const superseded = path.join(root, '_superseded', fs.readdirSync(path.join(root, '_superseded'))[0]);
    expect(JSON.parse(fs.readFileSync(path.join(superseded, 'owner-channel.json'), 'utf8'))).toEqual({ channelId: OTHER });
  });

  it('with no row, no file is left', async () => {
    const db = pgSource(null);
    fs.writeFileSync(channelFile(), JSON.stringify({ channelId: OTHER }));
    expect((await run(db, 'file')).state).toBe('done');
    expect(fs.existsSync(channelFile())).toBe(false);
  });

  it('the file changed between S4 and S7 fails the job with the differs text', async () => {
    jsonSource(CH);
    const job = await run(new FakeDb(), 'postgres', new FakeHost(), {
      fault: (point: string) => { if (point === 'S7') fs.writeFileSync(channelFile(), JSON.stringify({ channelId: OTHER })); },
    });
    expect(job.state).toBe('failed');
    expect(job.error).toBe('The owner messages channel in the source read a second time differs from the source');
  });

  it('an unreadable source value is not copied; the journal notes and the result line name it', async () => {
    jsonSource('abc');
    const db = new FakeDb();
    const job = await run(db, 'postgres');
    expect(job.state).toBe('done');
    expect(db.schemas.get('smdb_data')!.ownerChannel).toBeUndefined();
    const note = "The owner messages channel setting could not be read (the stored value is not a channel ID of 17 to 20 digits), so it was not copied; owner messages go to the owner's DMs until it is set again in the web panel";
    expect(job.notes).toEqual([note]);
    expect(readJson(JOURNAL).notes).toEqual([note]);
    expect(logs.find(l => l.includes('is done:'))).toContain(note);
  });
});

describe("decision 16, round 7: S3 waits for the owner channel's write in flight", () => {
  it('to Postgres: the job waits at S3 while the mark is set; the write lands, the mark clears, then S4 reads', async () => {
    jsonSource(undefined);
    const host = new FakeHost();
    host.ownerChannelMark = true;
    const db = new FakeDb();
    const service = serviceFor(db, host, { ownerChannelWaitMs: 2000 });
    await service.post({ jobId: 'job-nb5-wait-0001', to: 'postgres' });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(readJson(JOURNAL).stage).toBe('draining');
    fs.writeFileSync(channelFile(), JSON.stringify({ channelId: CH }));
    host.ownerChannelMark = false;
    await service.idle();
    expect(service.status().body.job.state).toBe('done');
    expect(db.schemas.get('smdb_data')!.ownerChannel).toBe(JSON.stringify(CH));
  });

  it('to JSON: the row written while the job waits is the one copied', async () => {
    const db = pgSource(null);
    const host = new FakeHost();
    host.ownerChannelMark = true;
    const service = serviceFor(db, host, { ownerChannelWaitMs: 2000 });
    await service.post({ jobId: 'job-nb5-wait-0002', to: 'file' });
    await new Promise(resolve => setTimeout(resolve, 150));
    db.schemas.get('smdb_data')!.ownerChannel = JSON.stringify(CH);
    host.ownerChannelMark = false;
    await service.idle();
    expect(service.status().body.job.state).toBe('done');
    expect(JSON.parse(fs.readFileSync(channelFile(), 'utf8'))).toEqual({ channelId: CH });
  });

  it('a mark that stays set past the bound refuses the job at S3 with nothing changed, and the lock is released', async () => {
    jsonSource(CH);
    const host = new FakeHost();
    host.ownerChannelMark = true;
    const db = new FakeDb();
    const job = await run(db, 'postgres', host, { ownerChannelWaitMs: 200 });
    expect(job).toMatchObject({ state: 'failed', error: 'An owner messages channel change is still being saved; run the migration once it ends' });
    expect(db.schemas.has('smdb_data')).toBe(false);
    expect(host.lock).toBeNull();
  });
});
