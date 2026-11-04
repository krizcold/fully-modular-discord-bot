import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moveEarlierStaging, placeStaged, stageSnapshot, supersededName, walkJsonSource, type Snapshot } from '../../src/bot/internalSetup/utils/dataMigration';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, MARKER, PG_URL, readJson, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson } from '../helpers/migrationRig';

// NB3 decision 12: a JSON destination.

const G1 = '880000000000000001';
const G2 = '880000000000000002';
const NAME = /^\d{8}T\d{9}Z-[A-Za-z0-9-]{8,40}$/;

beforeEach(() => {
  wipeRoot();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

function snap(): Snapshot {
  const item = (guildId: string, module: string, filename: string, text: string, grave?: number) => ({
    guildId, module, filename, kind: filename.endsWith('.jsonl') ? 'append' as const : 'doc' as const, bytes: Buffer.from(text, 'utf8'),
    grave: grave !== undefined, retiredAt: grave,
  });
  return {
    items: [item(G1, 'mod', 'a.json', '{"a":1}'), item(G1, '', 'top.json', '{}'), item(G2, 'mod', 'l.jsonl', 'x\n'), item(G1, 'mod', 'old.json', '{"o":1}', 1700000000000)],
    graves: [{ guildId: G1, retiredAt: 1700000000000, reason: 'left' }],
    guilds: [G1, G2],
    leftOut: [],
    shadow: [],
  };
}

describe('the staging and the placement', () => {
  it('the superseded folder name has the UTC time with ms, no colon, and the job id', () => {
    const name = supersededName('job-json-0001', new Date(Date.UTC(2026, 9, 29, 1, 23, 45, 678)));
    expect(name).toBe('20261029T012345678Z-job-json-0001');
    expect(name).toMatch(NAME);
    expect(name).not.toContain(':');
  });

  it('stages every file and the graveyard note, then moves stale folders aside and the staged ones in, guild by guild', async () => {
    seedFile(`${G1}/stale.json`, '{"stale":true}');
    seedFile(`_graveyard/${G2}-1600000000000/x.json`, '{}');
    const staging = path.join(root, '.migrate-1');
    await stageSnapshot(snap(), staging);
    const back = await walkJsonSource(staging);
    expect(back.items).toHaveLength(4);
    expect(back.graves).toEqual([{ guildId: G1, retiredAt: 1700000000000, reason: 'left' }]);
    expect(readJson(path.join(staging, '_graveyard', `${G1}-1700000000000`, '.graveyard.json'))).toEqual({ guildId: G1, reason: 'left', ts: 1700000000000 });
    const superseded = path.join(root, '_superseded', supersededName('job-json-0002'));
    await placeStaged(root, staging, superseded);
    expect(fs.readFileSync(path.join(root, G1, 'mod', 'a.json'), 'utf-8')).toBe('{"a":1}');
    expect(fs.existsSync(path.join(root, G1, 'stale.json'))).toBe(false);
    expect(fs.readFileSync(path.join(superseded, G1, 'stale.json'), 'utf-8')).toBe('{"stale":true}');
    expect(fs.existsSync(path.join(superseded, '_graveyard', `${G2}-1600000000000`, 'x.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, '_graveyard', `${G1}-1700000000000`, 'mod', 'old.json'))).toBe(true);
    expect(fs.existsSync(staging)).toBe(false);
  });

  it('an earlier run\'s staging folder moves into the new run\'s superseded folder', async () => {
    seedFile('.migrate-123/880000000000000009/a.json', '{}');
    const superseded = path.join(root, '_superseded', supersededName('job-json-0003'));
    await moveEarlierStaging(root, superseded);
    expect(fs.existsSync(path.join(root, '.migrate-123'))).toBe(false);
    expect(fs.existsSync(path.join(superseded, '.migrate-123', '880000000000000009', 'a.json'))).toBe(true);
  });

  it('a target path that exists refuses before anything moves', async () => {
    seedFile(`${G1}/stale.json`, '{}');
    const staging = path.join(root, '.migrate-2');
    await stageSnapshot(snap(), staging);
    const superseded = path.join(root, '_superseded', supersededName('job-json-0004'));
    seedFile(`_superseded/${path.basename(superseded)}/${G1}/occupied.json`, '{}');
    await expect(placeStaged(root, staging, superseded)).rejects.toThrow(/exists/);
    expect(fs.existsSync(path.join(root, G1, 'stale.json'))).toBe(true);
    expect(fs.existsSync(path.join(staging, G1, 'mod', 'a.json'))).toBe(true);
  });
});

describe('a failure midway and a retry', () => {
  it('leaves P (some folders in, the source serving) and a retry ends in D', async () => {
    useDatabaseUrl(PG_URL);
    delete process.env.BOT_MANAGER_UPDATE_TOKEN;
    writeJson(MARKER, { live: 'postgres', storeId: 'store-p', flippedAt: 1 });
    const db = new FakeDb();
    const store = emptyStore('store-p');
    store.data.push({ guild_id: G1, module: 'mod', filename: 'a.json', doc: '{"a":1}' }, { guild_id: G2, module: 'mod', filename: 'b.json', doc: '{"b":2}' });
    db.schemas.set('smdb_data', store);
    const realRename = fs.promises.rename;
    let fail = true;
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (fail && path.resolve(String(to)) === path.resolve(path.join(root, G2))) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      return realRename(from, to);
    }) as any);
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-json-0005', to: 'file' });
    await service.idle();
    expect(service.status().body.job).toMatchObject({ state: 'failed', stage: 'placing' });
    expect(fs.existsSync(path.join(root, G1, 'mod', 'a.json'))).toBe(true);
    expect(readJson(MARKER).live).toBe('postgres');
    expect(db.schemas.get('smdb_data')?.storeId).toBe('store-p');
    fail = false;
    const again = await service.post({ jobId: 'job-json-0006', to: 'file' });
    expect(again.body).toMatchObject({ jobId: 'job-json-0006', state: 'started' });
    await service.idle();
    expect(service.status().body.job).toMatchObject({ jobId: 'job-json-0006', state: 'done' });
    expect(fs.readFileSync(path.join(root, G2, 'mod', 'b.json'), 'utf-8')).toBe('{"b":2}');
    expect(readJson(MARKER)).toMatchObject({ live: 'file', storeId: null, migration: 'job-json-0006' });
    expect(fs.readdirSync(path.join(root, '_superseded')).some(n => n.endsWith('job-json-0006'))).toBe(true);
    expect(db.schemas.has('smdb_data')).toBe(false);
  });
});
