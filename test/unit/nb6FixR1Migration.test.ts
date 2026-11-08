import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCredentials } from '../../src/utils/envLoader';
import { flushAll, setGuildWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, shaOf } from '../../src/bot/internalSetup/utils/sharedStore';
import { moduleShaOf } from '../../src/bot/internalSetup/utils/sharedModules';
import type { ServiceOptions } from '../../src/bot/internalSetup/utils/dataMigration';
import { setBackendKind } from '../helpers/backendKind';
import { FakeDb } from '../helpers/fakePg';
import { FakeHost, PG_URL, freshJsonBot, root, seedFile, serviceFor, useDatabaseUrl, why, wipeRoot } from '../helpers/migrationRig';

// NB6 code review round 1, lane B finding 8 (out/NB6/review1-B.md; ruled in part-rulings.md "Code review round 1"):
// the migration's walk of a module folder keeps `.tmp` files, as the publish stores every file of the folder.

const CFG = path.join(root, 'cfg', 'config.json');
const MODS = path.join(root, 'srcmods');
const MANIFEST = '{"name":"mod1","version":"1.2.0"}';
const TMP = 'kept by the module\n';
const INSTALLED = { modules: { mod1: { name: 'mod1', version: '1.2.0', installedFrom: 'repo', installedAt: '2026-11-01T00:00:00.000Z' } } };

const opts = (): ServiceOptions => ({ rootConfigPath: CFG, sourceModulesDir: MODS });

beforeEach(async () => {
  await flushAll();
  wipeRoot();
  setBackendKind(null);
  setGuildWriteGate(null);
  _resetRowQueue();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
  delete process.env.FLEET_SHARD_COUNT;
  loadCredentials();
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  setBackendKind(null);
  setGuildWriteGate(null);
  _resetRowQueue();
  delete process.env.DATA_BACKEND;
});

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function seed(): void {
  freshJsonBot();
  seedFile('880000000000000001/m/a.json', '{"g":1}');
  write(CFG, '{"prefix":"!"}');
  seedFile('global/appstore/installed.json', JSON.stringify(INSTALLED));
  write(path.join(MODS, 'mod1', 'module.json'), MANIFEST);
}

async function run(db: FakeDb, jobId: string, to: 'postgres' | 'file') {
  const service = serviceFor(db, new FakeHost(), opts());
  await service.post({ jobId, to });
  await service.idle();
  return service.status().body.job;
}

const relsOf = (db: FakeDb) => [...db.schemas.get('smdb_data')!.moduleFiles!].map(f => f.rel).sort();

describe('B8: a .tmp file inside a module folder', () => {
  it('a move to Postgres stores it with the module, as the publish does', async () => {
    seed();
    write(path.join(MODS, 'mod1', 'x.tmp'), TMP);
    const db = new FakeDb();
    const job = await run(db, 'job-nb6fix-b8-01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(relsOf(db)).toEqual(['module.json', 'x.tmp']);
    const mod = db.schemas.get('smdb_data')!.modules![0];
    expect(mod.sha).toBe(moduleShaOf([{ rel: 'module.json', sha: shaOf(Buffer.from(MANIFEST)) }, { rel: 'x.tmp', sha: shaOf(Buffer.from(TMP)) }]));
  });

  it("a move to JSON of a module whose rows hold a .tmp file places it and passes S6's read-back", async () => {
    seed();
    const db = new FakeDb();
    const first = await run(db, 'job-nb6fix-b8-02', 'postgres');
    expect(first, why(first)).toMatchObject({ state: 'done' });
    // The rows the publish of a folder holding x.tmp stores: the file row, and the module's sha, count and bytes over every file.
    const store = db.schemas.get('smdb_data')!;
    store.moduleFiles!.push({ module: 'mod1', rel: 'x.tmp', bytes: Buffer.from(TMP), mode: 0o644 });
    const mod = store.modules![0];
    mod.sha = moduleShaOf([{ rel: 'module.json', sha: shaOf(Buffer.from(MANIFEST)) }, { rel: 'x.tmp', sha: shaOf(Buffer.from(TMP)) }]);
    mod.file_count = 2;
    mod.bytes = Buffer.byteLength(MANIFEST) + Buffer.byteLength(TMP);
    fs.rmSync(path.join(MODS, 'mod1'), { recursive: true, force: true });
    const job = await run(db, 'job-nb6fix-b8-03', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(fs.readFileSync(path.join(MODS, 'mod1', 'x.tmp'), 'utf8')).toBe(TMP);
    expect(fs.readFileSync(path.join(MODS, 'mod1', 'module.json'), 'utf8')).toBe(MANIFEST);
  });
});
