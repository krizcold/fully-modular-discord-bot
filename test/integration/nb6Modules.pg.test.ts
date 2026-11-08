import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { fetchModule, publishModule } from '../../src/bot/internalSetup/utils/sharedModules';
import { _resetRowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { readStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { _resetModuleApply, _setModuleDirs, applyModuleChange, setModuleApplyClient } from '../../src/bot/internalSetup/utils/moduleApply';
import { _resetModuleCrashes } from '../../src/bot/internalSetup/utils/moduleCrashes';
import { setMainChooser } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { getNodeId } from '../../src/bot/internalSetup/fleet/nodeIdentity';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { fakeLoader } from '../helpers/nb6FakeLoader';
import { setView } from '../helpers/nb6Mirror';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';
import { sharedListener } from '../helpers/nb6Pg';

// NB6 test 27 [pg] (wip-redesign/sheets/NB6.md row 57, cell 423; decision 15, C4, C12), the publish and fetch half: a
// module folder with a binary file published on real Postgres, its bytea rows read back byte for byte, then fetched
// into a new folder byte for byte. The applier half (part 16): the real apply, with the fake loader of
// nb6FakeLoader.ts, takes the published rows into a second machine's module folder byte for byte, writes its entry and
// its status row.

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

const MIB = 1024 * 1024;
const INSTALLED = 'global/appstore/installed.json';
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const moduleSha = (files: Record<string, Buffer>) =>
  sha256(Object.keys(files).sort().map(rel => `${rel}\0${sha256(files[rel])}\n`).join(''));

let rig: ClaimRig;
let listener: Awaited<ReturnType<typeof sharedListener>>;
let root: string;

beforeAll(async () => {
  rig = await startClaimRig();
  listener = await sharedListener(rig.url);
}, 180_000);

afterAll(async () => {
  await listener?.end();
  await rig?.stop();
});

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  _resetRowQueue();
  setBackendKind('postgres');
  dm.setGuildDataBackend(rig.backend);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb6modpg-'));
  for (const table of ['shared_module_files', 'shared_modules', 'shared_docs', 'shared_ops']) await rig.direct.query(`DELETE FROM smdb_data.${table}`);
  listener.heard.length = 0;
});

afterEach(() => {
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Every byte value, then a pattern from a seed: bytes that are not UTF-8 text and hold U+0000. */
function binary(size: number, seed: number): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) b[i] = i < 256 ? i : (i * 31 + seed) & 0xff;
  return b;
}

function folder(name: string, files: Record<string, Buffer>): string {
  const dir = path.join(root, name);
  for (const [rel, bytes] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  return dir;
}

function readBack(dir: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  const walk = (at: string, rel: string) => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(at, e.name), r);
      else out[r] = fs.readFileSync(path.join(at, e.name));
    }
  };
  walk(dir, '');
  return out;
}

describe('row 57: the publish, then the fetch', () => {
  it('stores a folder with a binary file byte for byte and fetches it into a new folder byte for byte', async () => {
    const files: Record<string, Buffer> = {
      'index.js': Buffer.from('module.exports = { name: "pgmod" };\n'),
      'assets/logo.bin': binary(70_000, 3),
      'assets/empty.dat': Buffer.alloc(0),
    };
    const dir = folder('pgmod', files);
    const installed = Buffer.from(JSON.stringify({ pgmod: { version: '2.0.0' } }));
    const answer = await publishModule('pgmod', dir, installed, 'absent', { operation: 'install', version: '2.0.0' });
    expect(answer).toEqual({ kind: 'committed', sha: moduleSha(files), installedSha: sha256(installed), checked: false });

    const rows = (await rig.direct.query('SELECT rel, bytes FROM smdb_data.shared_module_files WHERE module = $1 ORDER BY rel', ['pgmod'])).rows;
    expect(rows.map(r => r.rel)).toEqual(Object.keys(files).sort());
    for (const r of rows) expect(Buffer.compare(r.bytes, files[r.rel])).toBe(0);
    const manifest = (await rig.direct.query('SELECT sha, version, file_count, bytes::text AS bytes FROM smdb_data.shared_modules WHERE module = $1', ['pgmod'])).rows[0];
    expect(manifest).toEqual({ sha: moduleSha(files), version: '2.0.0', file_count: 3, bytes: String(70_000 + files['index.js'].length) });
    const doc = (await rig.direct.query('SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1', [INSTALLED])).rows[0];
    expect(Buffer.compare(doc.body, installed)).toBe(0);
    expect(Number((await rig.direct.query('SELECT count(*)::int AS n FROM smdb_data.shared_ops')).rows[0].n)).toBe(1);

    const into = path.join(root, '.incoming-pgmod-1');
    const fetched = await fetchModule('pgmod', into);
    expect(fetched).toEqual({ ok: true, sha: moduleSha(files), files: 3, bytes: 70_000 + files['index.js'].length });
    const back = readBack(into);
    expect(Object.keys(back).sort()).toEqual(Object.keys(files).sort());
    for (const [rel, bytes] of Object.entries(files)) expect(Buffer.compare(back[rel], bytes)).toBe(0);
  });

  it('a file over 4 MiB goes out as an insert and appends and comes back whole through pieces', async () => {
    const files: Record<string, Buffer> = { 'big.bin': binary(9 * MIB + 17, 11), 'small.txt': Buffer.from('x') };
    const dir = folder('pgbig', files);
    const answer = await publishModule('pgbig', dir, Buffer.from('{"pgbig":{}}'), 'absent', { operation: 'install' });
    expect(answer).toMatchObject({ kind: 'committed', sha: moduleSha(files) });
    const stored = (await rig.direct.query("SELECT bytes FROM smdb_data.shared_module_files WHERE module = 'pgbig' AND rel = 'big.bin'")).rows[0].bytes;
    expect(Buffer.compare(stored, files['big.bin'])).toBe(0);

    const into = path.join(root, '.incoming-pgbig-1');
    expect(await fetchModule('pgbig', into)).toMatchObject({ ok: true, sha: moduleSha(files), files: 2 });
    const back = readBack(into);
    for (const [rel, bytes] of Object.entries(files)) expect(Buffer.compare(back[rel], bytes)).toBe(0);
  });

  it('notifies the module and installed.json at COMMIT', async () => {
    const files = { 'a.js': Buffer.from('1') };
    const installed = Buffer.from('{"pgn":{}}');
    await publishModule('pgn', folder('pgn', files), installed, 'absent', { operation: 'install' });
    const until = Date.now() + 10_000;
    while (listener.heard.length < 2 && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 50); });
    expect(listener.heard.map(n => JSON.parse(n))).toEqual([
      expect.objectContaining({ k: 'module', module: 'pgn', sha: moduleSha(files) }),
      expect.objectContaining({ k: 'doc', key: INSTALLED, sha: sha256(installed) }),
    ]);
  });
});

describe('row 57: the applier half', () => {
  let source: string;

  beforeEach(() => {
    fs.rmSync(dataPath('global', 'appstore'), { recursive: true, force: true });
    _resetModuleApply();
    _resetModuleCrashes();
    setView(1, 'ALPHA');
    source = path.join(root, 'applier', 'appstore-modules');
    const build = path.join(root, 'applier', 'build', 'bot', 'modules');
    const dist = path.join(root, 'applier', 'dist', 'bot', 'modules');
    for (const dir of [source, build, dist]) fs.mkdirSync(dir, { recursive: true });
    _setModuleDirs({ source, build, dist, backups: dataPath('global', 'appstore', 'cache', 'backups'), buildFile: path.join(root, 'applier', 'dist', '.build-complete') });
    fakeLoader.reset(source);
    setModuleApplyClient({} as never);
  });

  afterEach(() => {
    _setModuleDirs(null);
    _resetModuleApply();
    _resetModuleCrashes();
    setMainChooser(null);
  });

  it('the apply fetches the rows into the module folder byte for byte; the entry and the applied status row', async () => {
    const files: Record<string, Buffer> = {
      'index.js': Buffer.from('module.exports = { name: "pgapply" };\n'),
      'assets/logo.bin': binary(5 * MIB + 9, 7),
      'assets/empty.dat': Buffer.alloc(0),
    };
    const installed = Buffer.from(JSON.stringify({ modules: { pgapply: { version: '3.0.0' } } }));
    const published = await publishModule('pgapply', folder('stage/pgapply', files), installed, 'absent', { operation: 'install', version: '3.0.0' });
    expect(published).toMatchObject({ kind: 'committed', sha: moduleSha(files) });

    const result = await applyModuleChange({
      module: 'pgapply', to: moduleSha(files), source: 'rows', displaced: 'backups', reason: 'pass', tag: '1:ALPHA', version: '3.0.0', updatedBy: 'BRAVO/p-bravo',
    });
    expect(result).toEqual({ outcome: 'applied', reason: null, error: null, loaded: true });

    const back = readBack(path.join(source, 'pgapply'));
    expect(Object.keys(back).sort()).toEqual(Object.keys(files).sort());
    for (const [rel, bytes] of Object.entries(files)) expect(Buffer.compare(back[rel], bytes)).toBe(0);
    expect(fakeLoader.loads).toEqual([{ module: 'pgapply', sha: moduleSha(files) }]);

    const read = readStoreRecord();
    if (!read.ok) throw new Error(read.reason);
    expect(read.record.modules.pgapply).toMatchObject({ sha: moduleSha(files), main: '1:ALPHA', failedSha: null, applying: null, status: null });
    expect(fs.readdirSync(source)).toEqual(['pgapply']);

    const status = (await rig.direct.query('SELECT node_id, sha, state, error FROM smdb_data.shared_module_status WHERE module = $1', ['pgapply'])).rows;
    expect(status).toEqual([{ node_id: getNodeId(), sha: moduleSha(files), state: 'applied', error: null }]);
  });
});
