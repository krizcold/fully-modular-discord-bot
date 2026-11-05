import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshotFromPgRows, walkJsonSource } from '../../src/bot/internalSetup/utils/dataMigration';
import { loadCredentials } from '../../src/utils/envLoader';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, MARKER, PG_URL, root, serviceFor, snapshotRoot, useDatabaseUrl, why, wipeRoot, writeJson } from '../helpers/migrationRig';

// NB12 item 7 (wip-redesign/sheets/NB12.md, decisions 1 and 18): NB3's move applies the write rules at 'reading', with
// one tree rule shared with the writes.

const G1 = '880000000000000001';
const row = (module: string, filename: string, doc = '{}') => ({ guild_id: G1, module, filename, doc });
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('the Postgres source', () => {
  it('a row under a .tmp folder refuses naming it', () => {
    expect(() => snapshotFromPgRows([row('cache.tmp', 'x.json')], [], []))
      .toThrow(`The key cache.tmp/x.json of guild ${G1}: the part "cache.tmp" ends in ".tmp", which marks an interrupted write; nothing was written`);
  });

  it('a row with a 201-byte part refuses', () => {
    expect(() => snapshotFromPgRows([row('m', `${'a'.repeat(196)}.json`)], [], [])).toThrow(/is 201 bytes; one part of a key holds at most 200; nothing was written$/);
  });

  it.each([
    [['m/Users/1.json', 'm/users/2.json'], `The folders m/Users and m/users of guild ${G1} differ only in letter case; nothing was written`],
    [['w/kir.json', 'w/k\u0131r.json'], `The keys w/kir.json and w/k\u0131r.json of guild ${G1} differ only in letter case; nothing was written`],
  ])('%j refuses: differ only in letter case', (keys, text) => {
    const rows = keys.map(k => row(k.slice(0, k.indexOf('/')), k.slice(k.indexOf('/') + 1)));
    expect(() => snapshotFromPgRows(rows, [], [])).toThrow(text);
  });
});

describe('the JSON source', () => {
  it(".graveyard.json at a live guild's root refuses naming the file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb12mig-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, G1), { recursive: true });
    fs.writeFileSync(path.join(root, G1, '.graveyard.json'), '{}');
    await expect(walkJsonSource(root)).rejects.toThrow(/The key \.graveyard\.json of .+: it starts with "\.graveyard\.json"/);
  });
});

describe('the job (P6 continue and resume)', () => {
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
  });

  it("a Postgres source row 'cache.tmp/x.json' fails the job at reading naming it, with nothing written, and again on a second run", async () => {
    const db = new FakeDb();
    writeJson(MARKER, { live: 'postgres', storeId: 'src-nb12', flippedAt: 1 });
    db.schemas.set('smdb_data', {
      ...emptyStore('src-nb12'),
      data: [{ guild_id: G1, module: 'm', filename: 'a.json', doc: '{"a":1}' }, { guild_id: G1, module: 'cache.tmp', filename: 'x.json', doc: '{}' }],
      grave: [],
    });
    const service = serviceFor(db, new FakeHost());
    for (const jobId of ['job-nb12-0001', 'job-nb12-0002']) {
      await service.post({ jobId, to: 'file' });
      await service.idle();
      const job = service.status().body.job;
      expect(job, why(job)).toMatchObject({ jobId, state: 'failed', stage: 'reading' });
      expect(job.error).toContain('The key cache.tmp/x.json');
      expect(job.error).toContain('ends in ".tmp"');
      expect(fs.readdirSync(root).filter(n => n.startsWith('.migrate-'))).toEqual([]);
      expect(fs.existsSync(path.join(root, G1))).toBe(false);
      expect(db.schemas.get('smdb_data')?.storeId).toBe('src-nb12');
    }
    expect(Object.keys(snapshotRoot()).filter(k => k.startsWith(G1))).toEqual([]);
  });
});
