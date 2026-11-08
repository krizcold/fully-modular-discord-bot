import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonBot, realService, resetDatabase, schemas, sessionsGone, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, MARKER, readJson, root, seedFile, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';
import { CFG, MODS, seedShared, sharedFiles, sharedOpts, writeAt } from '../helpers/nb6MigrateRig';

// NB6 test 29: row 71 and cell 434 against a real Postgres. A move to JSON stages the shared rows, reads them back,
// places them and moves the old mirrors aside; and a round trip JSON to Postgres to JSON keeps every shared file and
// module file byte for byte.

let rig: PgRig;
const G = '292929292929292971';

beforeAll(async () => { rig = await startRig(); }, 180_000);
afterAll(async () => { await stopRig(rig); });
beforeEach(async () => {
  wipeRoot();
  await resetDatabase(rig);
  await sessionsGone(rig);
  useDatabaseUrl(rig.url);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

async function migrate(jobId: string, to: 'postgres' | 'file') {
  const service = realService(new FakeHost(), sharedOpts);
  await service.post({ jobId, to });
  await service.idle();
  await sessionsGone(rig);
  return service.status().body.job;
}

function supersededOf(jobId: string): string {
  const names = fs.readdirSync(path.join(root, '_superseded')).filter(n => n.endsWith(`-${jobId}`));
  expect(names).toHaveLength(1);
  return path.join(root, '_superseded', names[0]);
}

describe('row 71: a move to JSON with shared rows', () => {
  it('places the root config, the global files and the module folder, and moves the old mirrors aside', async () => {
    jsonBot();
    seedShared(G);
    expect(await migrate('job-nb6js-71-01', 'postgres'), 'to Postgres').toMatchObject({ state: 'done' });
    writeAt(CFG, '{"prefix":"old"}');
    fs.writeFileSync(path.join(root, 'global', 'm', 'a.json'), '{"a":"old"}');
    seedFile('global/m/extra.json', '{"x":1}');
    fs.writeFileSync(path.join(MODS, 'mod1', 'module.json'), '{"old":true}');
    const job = await migrate('job-nb6js-71-02', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    for (const [file, bytes] of Object.entries(sharedFiles())) expect(fs.readFileSync(file).equals(bytes), file).toBe(true);
    expect(fs.readFileSync(path.join(root, 'global', 'm', 'log.jsonl'), 'utf8')).toBe('{"e":1}\n{"e":2}\n');
    expect(fs.existsSync(path.join(root, 'global', 'm', 'extra.json'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'global', 'fleet', 'node.json'), 'utf8')).toBe('{"node":"local"}');
    expect(fs.readFileSync(path.join(root, 'global', 'metrics', 'totals.json'), 'utf8')).toBe('{"n":3}');
    const sup = supersededOf('job-nb6js-71-02');
    expect(fs.readFileSync(path.join(sup, 'config.json'), 'utf8')).toBe('{"prefix":"old"}');
    expect(fs.readFileSync(path.join(sup, 'global', 'm', 'a.json'), 'utf8')).toBe('{"a":"old"}');
    expect(fs.readFileSync(path.join(sup, 'global', 'm', 'extra.json'), 'utf8')).toBe('{"x":1}');
    expect(fs.readFileSync(path.join(sup, 'appstore-modules', 'mod1', 'module.json'), 'utf8')).toBe('{"old":true}');
    expect(job.counts).toMatchObject({ sharedDocs: 5, sharedLines: 2, modules: 1, moduleFiles: 2 });
    expect(readJson(MARKER)).toMatchObject({ live: 'file' });
    const retired = (await schemas(rig)).filter(s => s.startsWith('smdb_superseded_'));
    expect(retired).toHaveLength(1);
    const kept = await rig.admin.query(`SELECT count(*)::int AS n FROM "${retired[0]}".shared_docs`);
    expect(kept.rows[0].n).toBe(5);
  });
});

describe('cell 434: a round trip JSON to Postgres to JSON', () => {
  it('ends with every shared file and module file byte for byte as it began', async () => {
    jsonBot();
    seedShared(G);
    const before = Object.entries(sharedFiles());
    expect(await migrate('job-nb6js-rt-01', 'postgres'), 'to Postgres').toMatchObject({ state: 'done' });
    for (const [file] of before) fs.rmSync(file, { force: true });
    fs.rmSync(path.join(MODS, 'mod1'), { recursive: true, force: true });
    const job = await migrate('job-nb6js-rt-02', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    for (const [file, bytes] of before) expect(fs.readFileSync(file).equals(bytes), file).toBe(true);
  });
});
