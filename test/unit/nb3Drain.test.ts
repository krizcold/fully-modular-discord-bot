import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushAll, saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { drainGuildWrites } from '../../src/bot/internalSetup/utils/dataMigration';
import { dataPath } from '../../src/utils/dataRoot';
import { failFlushes } from '../helpers/configRig';
import { setBackendKind } from '../helpers/backendKind';
import { FakeDb } from '../helpers/fakePg';
import { FakeHost, PG_URL, freshJsonBot, serviceFor, useDatabaseUrl, wipeRoot } from '../helpers/migrationRig';

// NB3 decision 4: the drain of the web UI's own file queue before the source is read (S3).

const G = '444444444444444444';

beforeEach(async () => {
  await flushAll();
  wipeRoot();
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('the drain', () => {
  it('lands queued guild writes before it answers', async () => {
    for (let i = 0; i < 5; i++) saveDataTracked(`d${i}.json`, { guildId: G, category: 'mod' }, { i });
    expect(await drainGuildWrites(2000)).toEqual([]);
    for (let i = 0; i < 5; i++) expect(fs.existsSync(dataPath(G, 'mod', `d${i}.json`))).toBe(true);
  });

  it('names a guild path whose flush keeps failing', async () => {
    const stuck = dataPath(G, 'mod', 'stuck.json');
    const undo = failFlushes(stuck);
    try {
      saveDataTracked('stuck.json', { guildId: G, category: 'mod' }, { s: 1 });
      expect(await drainGuildWrites(500)).toEqual([stuck]);
    } finally {
      undo();
      await flushAll();
    }
  });

  // sheets/NB6.md:1130-1131 (decision 39) amends sheets/NB3.md:935-936.
  it('a global path sharedKeyFor names holds the drain and is named when its flush keeps failing', async () => {
    const glob = dataPath('global', 'mod', 'g.json');
    const undo = failFlushes(glob);
    try {
      saveDataTracked('g.json', { scope: 'global', category: 'mod' }, { g: 1 });
      expect(await drainGuildWrites(500)).toEqual([glob]);
    } finally {
      undo();
      await flushAll();
    }
  });

  it('does not wait for a global path local to the machine', async () => {
    const local = dataPath('global', 'metrics', 'totals.json');
    const undo = failFlushes(local);
    try {
      saveDataTracked('totals.json', { scope: 'global', category: 'metrics' }, { t: 1 });
      const started = Date.now();
      expect(await drainGuildWrites(3000)).toEqual([]);
      expect(Date.now() - started).toBeLessThan(2500);
    } finally {
      undo();
      await flushAll();
    }
  });
});

describe('the drain inside a job (S3)', () => {
  beforeEach(() => {
    freshJsonBot();
    useDatabaseUrl(PG_URL);
    delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('a queued guild write whose first flush failed is in the copy', async () => {
    const target = dataPath(G, 'mod', 'queued.json');
    const realOpen = fs.promises.open;
    let refused = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation(((p: any, ...rest: any[]) => {
      if (refused === 0 && String(p).startsWith(`${target}.`) && String(p).endsWith('.tmp')) {
        refused += 1;
        return Promise.reject(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }));
      }
      return (realOpen as any)(p, ...rest);
    }) as typeof fs.promises.open);
    expect(saveDataTracked('queued.json', { guildId: G, category: 'mod' }, { q: 1 }).outcome).toBe('saved');
    for (let i = 0; i < 50 && refused === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(refused).toBe(1);
    expect(fs.existsSync(target)).toBe(false);
    const db = new FakeDb();
    const service = serviceFor(db, new FakeHost());
    expect((await service.post({ jobId: 'job-drain-0001', to: 'postgres' })).body.state).toBe('started');
    await service.idle();
    expect(service.status().body.job).toMatchObject({ state: 'done' });
    const onDisk = fs.readFileSync(dataPath(G, 'mod', 'queued.json'), 'utf-8');
    expect(JSON.parse(onDisk)).toEqual({ q: 1 });
    expect(db.schemas.get('smdb_data')?.data).toEqual([{ guild_id: G, module: 'mod', filename: 'queued.json', doc: onDisk }]);
  });

  it('a guild path whose flush keeps failing fails the job at draining, named, with nothing copied', async () => {
    const stuck = dataPath(G, 'mod', 'stuck.json');
    const undo = failFlushes(stuck);
    try {
      saveDataTracked('stuck.json', { guildId: G, category: 'mod' }, { s: 1 });
      const db = new FakeDb();
      const service = serviceFor(db, new FakeHost());
      await service.post({ jobId: 'job-drain-0002', to: 'postgres' });
      await service.idle();
      const job = service.status().body.job;
      expect(job).toMatchObject({ state: 'failed', stage: 'draining' });
      expect(job.error).toContain(stuck);
      expect(db.schemas.has('smdb_data')).toBe(false);
    } finally {
      undo();
      await flushAll();
    }
  });
});
