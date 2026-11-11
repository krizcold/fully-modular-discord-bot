import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { keyTimesOfRows, mergeEarlier } from '../../src/bot/internalSetup/utils/ownerMessageRecord';
import { emptyStore, FakeDb, type Row } from '../helpers/fakePg';
import { FakeHost, MARKER, PG_URL, freshJsonBot, root, serviceFor, useDatabaseUrl, why, wipeRoot, writeJson } from '../helpers/migrationRig';

// NB26: a data migration carries NB23's owner-message key record (the meta rows owner-message:<key> of a Postgres bot,
// /data/owner-messages.json on this machine) with each key's own posted time, so the 90-day window keeps counting from
// the first post. A key held on both sides keeps the earlier time.

const G = '880000000000000001';
const DAY = 86_400_000;
const keysFile = () => path.join(root, 'owner-messages.json');
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
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

function jsonSource(keys: Record<string, string> | string | undefined): void {
  freshJsonBot();
  fs.mkdirSync(path.join(root, G, 'mod'), { recursive: true });
  fs.writeFileSync(path.join(root, G, 'mod', 'a.json'), '{"a":1}');
  if (typeof keys === 'string') fs.writeFileSync(keysFile(), keys);
  else if (keys !== undefined) fs.writeFileSync(keysFile(), JSON.stringify({ keys }, null, 2));
}

function pgSource(rows: Record<string, string>): FakeDb {
  wipeRoot();
  writeJson(MARKER, { live: 'postgres', storeId: 'store-p', flippedAt: 1 });
  const db = new FakeDb();
  const store = emptyStore('store-p');
  store.data.push({ guild_id: G, module: 'mod', filename: 'a.json', doc: '{"a":1}' });
  store.ownerKeys = Object.entries(rows).map(([key, at]) => ({ key: `owner-message:${key}`, value: JSON.stringify(at), updated_at: new Date(at) }));
  db.schemas.set('smdb_data', store);
  return db;
}

async function run(db: FakeDb, to: 'postgres' | 'file', extra = {}): Promise<any> {
  const service = serviceFor(db, new FakeHost(), extra);
  await service.post({ jobId: `job-nb26-${to}-${Math.random().toString(36).slice(2, 8)}`, to });
  await service.idle();
  return service.status().body.job;
}

/** The store's key rows as key -> posted time, with each row's value and updated_at checked to agree. */
function rowTimes(db: FakeDb): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of (db.schemas.get('smdb_data')!.ownerKeys ?? []) as Row[]) {
    const at = new Date(r.updated_at).toISOString();
    expect(JSON.parse(r.value)).toBe(at);
    expect(out[r.key]).toBeUndefined();
    out[r.key] = at;
  }
  return out;
}

const fileTimes = () => JSON.parse(fs.readFileSync(keysFile(), 'utf8')).keys as Record<string, string>;

describe('JSON to Postgres', () => {
  it('copies each key of the file as a row whose updated_at is its posted time; a key past 90 days is left out', async () => {
    const a = ago(10);
    const b = ago(1);
    jsonSource({ a, b, old: ago(100) });
    const db = new FakeDb();
    const job = await run(db, 'postgres');
    expect(job.state, why(job)).toBe('done');
    expect(rowTimes(db)).toEqual({ 'owner-message:a': a, 'owner-message:b': b });
    expect(fs.existsSync(keysFile())).toBe(true);
    expect(logs.find(l => l.includes('is done:'))).toContain('2 owner message keys');
  });

  it('a key the file gains before the commit is carried too', async () => {
    const a = ago(3);
    jsonSource({ a });
    const late = new Date().toISOString();
    const db = new FakeDb();
    const job = await run(db, 'postgres', {
      fault: (point: string) => { if (point === 'before-commit') fs.writeFileSync(keysFile(), JSON.stringify({ keys: { a, late } })); },
    });
    expect(job.state, why(job)).toBe('done');
    expect(rowTimes(db)).toEqual({ 'owner-message:a': a, 'owner-message:late': late });
  });

  it('a failed run leaves no rows and the run after it copies each key once', async () => {
    const a = ago(5);
    jsonSource({ a });
    const db = new FakeDb();
    const failed = await run(db, 'postgres', { fault: (point: string) => { if (point === 'S7') throw new Error('stop at S7'); } });
    expect(failed.state).toBe('failed');
    expect(db.schemas.get('smdb_data')?.ownerKeys ?? []).toEqual([]);
    const job = await run(db, 'postgres');
    expect(job.state, why(job)).toBe('done');
    expect(rowTimes(db)).toEqual({ 'owner-message:a': a });
  });

  it('an unreadable file copies no key, and the notes say so', async () => {
    jsonSource('{not json');
    const db = new FakeDb();
    const job = await run(db, 'postgres');
    expect(job.state, why(job)).toBe('done');
    expect(db.schemas.get('smdb_data')!.ownerKeys ?? []).toEqual([]);
    expect(job.notes.join(' ')).toContain('/data/owner-messages.json');
    expect(fs.readFileSync(keysFile(), 'utf8')).toBe('{not json');
  });
});

describe('Postgres to JSON', () => {
  it('merges the rows into this machine\'s file; a key held on both sides keeps the earlier time', async () => {
    const t1 = ago(20);
    const t2 = ago(2);
    const t3 = ago(4);
    const local = { both: ago(1), file: ago(6), later: ago(30) };
    const db = pgSource({ both: t1, row: t3, later: t2, old: ago(95) });
    fs.writeFileSync(keysFile(), JSON.stringify({ keys: local }));
    const job = await run(db, 'file');
    expect(job.state, why(job)).toBe('done');
    expect(fileTimes()).toEqual({ both: t1, row: t3, later: local.later, file: local.file });
    expect(logs.find(l => l.includes('is done:'))).toContain('3 owner message keys');
  });

  it('with no local file, the file holds the rows', async () => {
    const a = ago(7);
    const db = pgSource({ a });
    const job = await run(db, 'file');
    expect(job.state, why(job)).toBe('done');
    expect(fileTimes()).toEqual({ a });
  });

  it('an unreadable local file goes to the superseded folder and the rows are written in its place', async () => {
    const a = ago(7);
    const db = pgSource({ a });
    fs.writeFileSync(keysFile(), '{broken');
    const job = await run(db, 'file');
    expect(job.state, why(job)).toBe('done');
    expect(fileTimes()).toEqual({ a });
    const superseded = path.join(root, '_superseded', fs.readdirSync(path.join(root, '_superseded'))[0]);
    expect(fs.readFileSync(path.join(superseded, 'owner-messages.json'), 'utf8')).toBe('{broken');
    expect(job.notes.join(' ')).toContain(path.join(superseded, 'owner-messages.json'));
  });
});

describe('a refused placement', () => {
  it('leaves owner-messages.json unchanged when placeStaged refuses', async () => {
    const db = pgSource({ a: ago(7) });
    const before = JSON.stringify({ keys: { file: ago(3) } });
    fs.writeFileSync(keysFile(), before);
    fs.mkdirSync(path.join(root, '.migrate-1'));
    const other = '880000000000000002';
    const job = await run(db, 'file', {
      fault: (point: string) => {
        if (point !== 'S8') return;
        const names = fs.readdirSync(path.join(root, '_superseded'));
        fs.mkdirSync(path.join(root, other));
        fs.mkdirSync(path.join(root, '_superseded', names[0], other), { recursive: true });
      },
    });
    expect(job.state, why(job)).toBe('failed');
    expect(job.error).toContain('exists; nothing was moved');
    expect(fs.readFileSync(keysFile(), 'utf8')).toBe(before);
  });
});

describe('keyTimesOfRows', () => {
  it('takes the earlier of the value and updated_at, in both orders', () => {
    const t1 = '2026-11-01T00:00:00.000Z';
    const t2 = '2026-11-05T00:00:00.000Z';
    expect(keyTimesOfRows([
      { key: 'owner-message:v', value: JSON.stringify(t1), updated_at: new Date(t2) },
      { key: 'owner-message:u', value: JSON.stringify(t2), updated_at: new Date(t1) },
    ])).toEqual({ v: t1, u: t1 });
  });
});

describe('mergeEarlier', () => {
  it('keeps the earlier valid time, and never a time that does not parse over one that does', () => {
    const t1 = '2026-11-01T00:00:00.000Z';
    const t2 = '2026-11-05T00:00:00.000Z';
    expect(mergeEarlier({ a: t2, b: t1, c: 'x' }, { a: t1, b: 'nonsense', c: t2, d: t2 })).toEqual({ a: t1, b: t1, c: t2, d: t2 });
  });
});

describe('a round trip', () => {
  it('JSON to Postgres and back keeps each key once with its first posted time', async () => {
    const a = ago(30);
    const b = ago(1);
    jsonSource({ a, b });
    const db = new FakeDb();
    expect((await run(db, 'postgres')).state).toBe('done');
    fs.rmSync(keysFile());
    expect((await run(db, 'file')).state).toBe('done');
    expect(fileTimes()).toEqual({ a, b });
    expect((await run(db, 'postgres')).state).toBe('done');
    expect(rowTimes(db)).toEqual({ 'owner-message:a': a, 'owner-message:b': b });
  });
});
