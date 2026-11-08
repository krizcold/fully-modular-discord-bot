import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonBot, realService, resetDatabase, sessionsGone, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, root, seedFile, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';
import { BIN, MODS, NUL, seedShared, sharedOpts, writeAt } from '../helpers/nb6MigrateRig';

// NB6 test 71, cell 433 (C12): a global file that is not UTF-8 and one holding U+0000, and a module file of every byte
// value, go JSON to Postgres to JSON; the rows hold them as bytea and every byte comes back.

let rig: PgRig;
const G = '717171717171717101';
const EVERY_BYTE = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
const LINES = Buffer.concat([Buffer.from('{"ok":1}\n'), Buffer.from([0xff, 0x00, 0x0d]), Buffer.from('\n')]);

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

describe('cell 433: bytes that are not text, every byte compared', () => {
  it('keeps them as bytea in the rows and writes them back byte for byte', async () => {
    jsonBot();
    seedShared(G);
    writeAt(path.join(MODS, 'mod1', 'lib', 'every.bin'), EVERY_BYTE);
    seedFile('global/m/raw.jsonl', LINES);
    expect(await migrate('job-nb6by-433-01', 'postgres'), 'to Postgres').toMatchObject({ state: 'done' });

    const doc = await rig.admin.query("SELECT body FROM smdb_data.shared_docs WHERE key = 'global/m/bin.dat'");
    expect((doc.rows[0].body as Buffer).equals(BIN)).toBe(true);
    const nul = await rig.admin.query("SELECT body FROM smdb_data.shared_docs WHERE key = 'global/m/zero.json'");
    expect((nul.rows[0].body as Buffer).equals(NUL)).toBe(true);
    const file = await rig.admin.query("SELECT bytes FROM smdb_data.shared_module_files WHERE module = 'mod1' AND rel = 'lib/every.bin'");
    expect((file.rows[0].bytes as Buffer).equals(EVERY_BYTE)).toBe(true);
    const lines = await rig.admin.query("SELECT line FROM smdb_data.shared_lines WHERE key = 'global/m/raw.jsonl' ORDER BY seq");
    expect(lines.rows.map(r => (r.line as Buffer).toString('hex'))).toEqual([Buffer.from('{"ok":1}').toString('hex'), Buffer.from([0xff, 0x00, 0x0d]).toString('hex')]);

    for (const rel of ['global/m/bin.dat', 'global/m/zero.json', 'global/m/raw.jsonl']) fs.rmSync(path.join(root, ...rel.split('/')));
    fs.rmSync(path.join(MODS, 'mod1'), { recursive: true });
    const job = await migrate('job-nb6by-433-02', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(fs.readFileSync(path.join(root, 'global', 'm', 'bin.dat')).equals(BIN)).toBe(true);
    expect(fs.readFileSync(path.join(root, 'global', 'm', 'zero.json')).equals(NUL)).toBe(true);
    expect(fs.readFileSync(path.join(root, 'global', 'm', 'raw.jsonl')).equals(LINES)).toBe(true);
    expect(fs.readFileSync(path.join(MODS, 'mod1', 'lib', 'every.bin')).equals(EVERY_BYTE)).toBe(true);
  });
});
