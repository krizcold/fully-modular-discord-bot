import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addToStoreList, readStoreList } from '../../src/bot/internalSetup/utils/dataMigration';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, MARKER, PG_URL, STORES, readJson, seedFile, serviceFor, useDatabaseUrl, wipeRoot, freshJsonBot, writeJson } from '../helpers/migrationRig';

// NB3 decision 11: the durable list of the store ids this deployment served or minted.

beforeEach(() => {
  freshJsonBot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('the store list', () => {
  it('adds and never removes, and writes through a temp file', () => {
    expect(readStoreList()).toEqual([]);
    addToStoreList('a');
    addToStoreList('b');
    addToStoreList('a');
    expect(readStoreList()).toEqual(['a', 'b']);
    expect(readJson(STORES).storeIds).toEqual(['a', 'b']);
    const rename = vi.spyOn(fs, 'renameSync');
    syncBuiltinESMExports();
    addToStoreList('c');
    expect(rename).toHaveBeenCalled();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it('a move to JSON adds the source id only after the store id check passes', async () => {
    writeJson(MARKER, { live: 'postgres', storeId: 'store-src', flippedAt: 1 });
    const db = new FakeDb();
    db.schemas.set('smdb_data', emptyStore('store-other'));
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-stores-01', to: 'file' });
    await service.idle();
    expect(service.status().body.job.state).toBe('failed');
    expect(fs.existsSync(STORES)).toBe(false);
    db.schemas.set('smdb_data', emptyStore('store-src'));
    await service.post({ jobId: 'job-stores-02', to: 'file' });
    await service.idle();
    expect(readStoreList()).toEqual(['store-src']);
  });

  it('a move to Postgres refused before S8 adds nothing', async () => {
    seedFile('777777777777777777/mod/a.json', '{}');
    const db = new FakeDb();
    db.fail = sql => (/INSERT INTO smdb_data\.guild_data /.test(sql) ? Object.assign(new Error('disk full'), { code: '53100' }) : undefined);
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-stores-03', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job).toMatchObject({ state: 'failed', stage: 'copying' });
    expect(fs.existsSync(STORES)).toBe(false);
    expect(db.schemas.has('smdb_data')).toBe(false);
  });
});
