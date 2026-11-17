import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 regate chunk sa3: the folder syncs of the shadow rows a move to JSON keeps in the superseded folder (NB19 T20).
// Windows opens no folder for its sync, so a disk that fails the sync of named folders stands in for one.

const h = vi.hoisted(() => ({
  fail: null as null | { match: (dir: string) => boolean; kind: 'sync' | 'open'; errno: string },
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  const { DATA_ROOT } = await import('../../src/utils/dataRoot');
  const failing = (dirs: string[]) => {
    const f = h.fail;
    const dir = f ? dirs.find(d => f.match(d)) : undefined;
    return f && dir ? { failed: true, kind: f.kind, dir, errno: f.errno, error: null } : null;
  };
  const below = (dir: string, out: string[]) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory()) below(path.join(dir, e.name), out);
    out.push(dir);
  };
  return {
    ...real,
    syncFoldersUnder: async (root: string) => {
      const dirs: string[] = [];
      below(path.resolve(root), dirs);
      return failing(dirs) ?? real.syncFoldersUnder(root);
    },
    syncFolderChain: async (dir: string) => {
      const dirs: string[] = [];
      const top = path.resolve(DATA_ROOT);
      for (let at = path.resolve(dir); ; at = path.dirname(at)) {
        dirs.push(at);
        if (at === top || at === path.dirname(at) || !at.startsWith(top)) break;
      }
      return failing(dirs) ?? real.syncFolderChain(dir);
    },
  };
});

import { loadCredentials } from '../../src/utils/envLoader';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, MARKER, PG_URL, readJson, root, serviceFor, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

const G1 = '881300000000000101';
const G2 = '881300000000000102';
const CFG = path.join(root, 'cfg', 'config.json');
const MODS = path.join(root, 'srcmods');

beforeEach(() => {
  h.fail = null;
  wipeRoot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
  loadCredentials();
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  h.fail = null;
  vi.restoreAllMocks();
  delete process.env.DATA_BACKEND;
});

/** A folder directly inside this job's superseded folder. */
const inSuperseded = (name: string) => (dir: string) => path.basename(dir) === name && path.basename(path.dirname(path.dirname(dir))) === '_superseded';

function pgSource(db: FakeDb, storeId: string, shadow: boolean): void {
  writeJson(MARKER, { live: 'postgres', storeId, flippedAt: 1 });
  db.schemas.set('smdb_data', {
    ...emptyStore(storeId),
    data: [
      { guild_id: G1, module: 'm', filename: 'a.json', doc: '{"a":1}' },
      { guild_id: G2, module: 'm', filename: 'b.json', doc: '{"b":2}' },
      ...(shadow ? [{ guild_id: G2, module: 'm/', filename: '../m/b.json', doc: '{"shadow":1}' }] : []),
    ],
  });
}

async function run(db: FakeDb, jobId: string, fault?: (p: string) => void) {
  const service = serviceFor(db, new FakeHost(), { rootConfigPath: CFG, sourceModulesDir: MODS, ...(fault ? { fault } : {}) });
  const answer = await service.post({ jobId, to: 'file' });
  expect(answer.body.state, why(answer)).toBe('started');
  await service.idle();
  return service.status().body.job;
}

const supersededDir = () => {
  const names = fs.readdirSync(path.join(root, '_superseded'));
  expect(names).toHaveLength(1);
  return path.join(root, '_superseded', names[0]);
};

describe('the shadow rows kept in the superseded folder are synced before the placement', () => {
  it('a shadow folder the disk does not confirm fails the placement with nothing placed', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-sa3-shs1', true);
    h.fail = { match: inSuperseded('shadow'), kind: 'sync', errno: 'EIO' };
    const job = await run(db, 'job-sa3-shsync1');
    const shadow = path.join(supersededDir(), 'shadow');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'placing' });
    expect(job.error).toBe(`the migration's folders can't be confirmed as stored: the disk did not confirm the sync of ${shadow} (EIO). Check the disk, then restart the machine.`);
    expect(fs.existsSync(path.join(root, G1))).toBe(false);
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres' });
  });

  it('a shadow folder that cannot be opened for its sync tells the operator to run the migration again', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-sa3-shs2', true);
    h.fail = { match: inSuperseded('shadow'), kind: 'open', errno: 'EMFILE' };
    const job = await run(db, 'job-sa3-shsync2');
    const shadow = path.join(supersededDir(), 'shadow');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'placing' });
    expect(job.error).toBe(`the migration's folders can't be confirmed as stored: ${shadow} could not be opened for its sync (EMFILE). Run the migration again.`);
  });

  it('only the shadow folder is synced: an earlier staging folder moved aside is not', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-sa3-shs3', true);
    fs.mkdirSync(path.join(root, '.migrate-1', G1), { recursive: true });
    h.fail = { match: inSuperseded('.migrate-1'), kind: 'sync', errno: 'EIO' };
    const job = await run(db, 'job-sa3-shsync3');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(fs.existsSync(path.join(supersededDir(), 'shadow', G2))).toBe(true);
    expect(fs.existsSync(path.join(supersededDir(), '.migrate-1', G1))).toBe(true);
  });

  it('a move with no shadow rows does not sync a shadow folder it did not write', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-sa3-shs4', false);
    fs.mkdirSync(path.join(root, '.migrate-1'));
    h.fail = { match: inSuperseded('shadow'), kind: 'sync', errno: 'EIO' };
    const job = await run(db, 'job-sa3-shsync4', p => { if (p === 'S8') fs.mkdirSync(path.join(supersededDir(), 'shadow')); });
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(readJson(MARKER)).toMatchObject({ live: 'file' });
  });
});
