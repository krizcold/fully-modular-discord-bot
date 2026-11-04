import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCredentials } from '../../src/utils/envLoader';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, MARKER, PG_URL, freshJsonBot, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

// NB3 mutation gate, chunk 4: what the job's read of a whole source reports (leftOut) and compares (shadow rows).

const G1 = '990000000000000011';

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
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
});

describe('NB3 L5 s4: leftOut of a JSON source', () => {
  it('the job to Postgres names a .tmp file inside a guild folder under leftOut, and nothing else', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{"a":1}');
    seedFile(`${G1}/m/b.json.tmp`, 'half');
    const db = new FakeDb();
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-l5s4-left-01', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(job.leftOut).toEqual([path.join(root, G1, 'm', 'b.json.tmp')]);
    expect(db.schemas.get('smdb_data')!.data.map(r => `${r.module}/${r.filename}=${r.doc}`)).toEqual(['m/a.json={"a":1}']);
  });
});

describe('NB3 L5 s4: shadow rows read a second time', () => {
  it('the job to JSON fails when a shadow row changed before the second read, and places nothing', async () => {
    const db = new FakeDb();
    writeJson(MARKER, { live: 'postgres', storeId: 'src-l5s4', flippedAt: 1 });
    db.schemas.set('smdb_data', {
      ...emptyStore('src-l5s4'),
      data: [{ guild_id: G1, module: 'm', filename: 'a.json', doc: '{"new":1}' }, { guild_id: G1, module: '', filename: 'm/a.json', doc: '{"old":1}' }],
    });
    const service = serviceFor(db, new FakeHost(), {
      fault: point => {
        if (point === 'S7') db.schemas.get('smdb_data')!.data[1].doc = '{"old":2}';
      },
    });
    await service.post({ jobId: 'job-l5s4-shad-01', to: 'file' });
    await service.idle();
    const job = service.status().body.job;
    expect(job.state, why(job)).not.toBe('done');
    expect(why(job)).toContain('The source read a second time differs from the source in 1 document(s)');
    expect(fs.existsSync(path.join(root, G1))).toBe(false);
  });
});
