import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dirs: { source: '', build: '', dist: '', dev: '' } }));

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const execSync = (cmd: string) => {
    if (cmd.startsWith('git rev-parse HEAD')) return Buffer.from('a'.repeat(40));
    if (cmd.startsWith('git remote set-url') || cmd.startsWith('git fetch')) return Buffer.from('');
    throw new Error(`unexpected command in test: ${cmd.split(' ').slice(0, 2).join(' ')}`);
  };
  return { ...real, execSync, default: { ...real, execSync } };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => undefined }));

vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    getSourceModulesDir: () => h.dirs.source,
    getBuildModulesDir: () => h.dirs.build,
    getModulesDir: () => h.dirs.dist,
    getModulesDevDir: () => h.dirs.dev,
  };
});

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import { AppStoreManager, StoreWriteError, awaitStoreDoc, type StoreQueued } from '../../src/bot/internalSetup/utils/appStoreManager';
import { readStoreRecord, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import type { RowRefusal } from '../../src/bot/internalSetup/utils/sharedStore';
import { applyRig, moduleShaOfFiles } from '../helpers/nb6ApplyRig';

const rig = applyRig();
const REPO = 'r1';
const STORE = dataPath('global', 'appstore');
const INSTALLED = 'global/appstore/installed.json';
const MIB = 1024 * 1024;
const V1 = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const V2 = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };
const SAME_VERSION = '{"modules":{"m":{"version":"1.0.0"}}}';
const DOC_SQL = 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1';
const MODULES_SQL = 'SELECT module, sha, version, updated_by FROM smdb_data.shared_modules';
const LONG = `${'q'.repeat(210)}.js`;
const LONG_CAUSE = `the part "${'q'.repeat(40)}..." is 213 bytes; one part of a key holds at most 200`;

beforeEach(async () => {
  await rig.setup();
  h.dirs = { source: rig.state.source, build: rig.state.build, dist: rig.state.dist, dev: path.join(rig.state.root, 'modulesDev') };
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(path.join(STORE, 'repos.json'), JSON.stringify({ repositories: [{ id: REPO, name: 'Repo', url: 'https://github.com/example/r', branch: 'main', enabled: true }] }, null, 2));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rig.teardown();
});

const cloneDir = () => path.join(STORE, 'cache', REPO, 'Modules', 'm');

function clone(files: Record<string, string | Buffer>): void {
  const dir = path.join(STORE, 'cache', REPO);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const [rel, bytes] of Object.entries(files)) {
    const file = path.join(cloneDir(), ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
}

async function installed(): Promise<AppStoreManager> {
  clone(V1);
  const m = new AppStoreManager();
  await m.installModule('m', REPO);
  expect(rig.state.rows.modules.get('m')?.sha).toBe(moduleShaOfFiles(V1));
  return m;
}

/** The update of m to V2 meets an installed.json another machine stored with m still at 1.0.0; atRollback runs when the refused publish rolls back. */
async function refusedUpdate(atRollback: () => void, stored = SAME_VERSION) {
  const m = await installed();
  clone(V2);
  rig.state.rows.put(INSTALLED, stored);
  let rolled = false;
  rig.state.rows.fault = (sql, params) => {
    if (sql === MODULES_SQL && (params?.length ?? 0) !== 0) {
      return Object.assign(new Error(`bind message supplies ${params!.length} parameters, but prepared statement "" requires 0`), { code: '08P01' });
    }
    if (sql === 'ROLLBACK' && !rolled) {
      rolled = true;
      atRollback();
    }
    return undefined;
  };
  const result = await m.updateModule('m');
  expect(rolled).toBe(true);
  expect(result).toMatchObject({ success: false, changedElsewhere: true });
  return result;
}

function selectAnswers(doc: (real: () => Promise<{ rows: any[] }>) => Promise<{ rows: any[] }>): void {
  const backend = rig.state.pg.backend as any;
  const real = backend.sharedSelect.bind(backend);
  vi.spyOn(backend, 'sharedSelect').mockImplementation(((text: string, values: unknown[], bound: number) =>
    (text === DOC_SQL ? doc(() => real(text, values, bound)) : real(text, values, bound))) as any);
}

describe("an update refused because installed.json changed elsewhere names what changed", () => {
  it("m's entry and its stored module row as the update started: only other modules changed", async () => {
    const result = await refusedUpdate(() => undefined);
    expect(result.elsewhere).toEqual({ kind: 'other', by: 'BRAVO' });
  });

  it("m's stored module row holds another sha: m itself changed", async () => {
    const result = await refusedUpdate(() => {
      const row = rig.state.rows.modules.get('m')!;
      rig.state.rows.modules.set('m', { ...row, sha: 'f'.repeat(64) });
    });
    expect(result.elsewhere).toEqual({ kind: 'module', by: 'BRAVO' });
  });

  it("m's stored module row is gone: m itself changed", async () => {
    const result = await refusedUpdate(() => { rig.state.rows.modules.delete('m'); });
    expect(result.elsewhere).toEqual({ kind: 'module', by: 'BRAVO' });
  });

  it("another module's row listed before m's, with another sha, does not count as m's change", async () => {
    const result = await refusedUpdate(() => {
      const row = rig.state.rows.modules.get('m')!;
      rig.state.rows.modules.clear();
      rig.state.rows.modules.set('a', { ...row, sha: 'e'.repeat(64) });
      rig.state.rows.modules.set('m', row);
    });
    expect(result.elsewhere).toEqual({ kind: 'other', by: 'BRAVO' });
  });

  it('installed.json no longer stored: m was removed', async () => {
    const result = await refusedUpdate(() => { rig.state.rows.docs.delete(INSTALLED); });
    expect(result.elsewhere).toEqual({ kind: 'removed', by: null });
  });

  it('a stored installed.json with no modules map: m was removed', async () => {
    const result = await refusedUpdate(() => { rig.state.rows.put(INSTALLED, '{}'); });
    expect(result.elsewhere).toEqual({ kind: 'removed', by: 'BRAVO' });
  });

  it('a body the driver answers as text is read as the text', async () => {
    selectAnswers(async real => {
      const res = await real();
      return { rows: res.rows.map(r => ({ ...r, body: r.body.toString('utf8') })) };
    });
    const result = await refusedUpdate(() => undefined);
    expect(result.elsewhere).toEqual({ kind: 'other', by: 'BRAVO' });
  });

  it("a row with a null body is read as empty text, whose parse error is the answer's", async () => {
    selectAnswers(async real => {
      const res = await real();
      return { rows: res.rows.map(r => ({ ...r, body: null })) };
    });
    const result = await refusedUpdate(() => undefined);
    expect(result.elsewhere).toEqual({ kind: 'unread', error: 'Unexpected end of JSON input', by: 'BRAVO' });
  });

  it("with no sha of m in the record at the start, the module rows are not compared", async () => {
    const m = await installed();
    const read = readStoreRecord();
    if (!read.ok) throw new Error(read.reason);
    const { m: _gone, ...others } = read.record.modules;
    writeStoreRecord({ ...read.record, modules: others });
    clone(V2);
    rig.state.rows.put(INSTALLED, SAME_VERSION);
    let rolled = false;
    rig.state.rows.fault = sql => {
      if (sql === 'ROLLBACK' && !rolled) {
        rolled = true;
        const row = rig.state.rows.modules.get('m');
        if (row) rig.state.rows.modules.set('m', { ...row, sha: 'f'.repeat(64) });
      }
      return undefined;
    };
    const result = await m.updateModule('m');
    expect(rolled).toBe(true);
    expect(result).toMatchObject({ success: false, changedElsewhere: true, elsewhere: { kind: 'other', by: 'BRAVO' } });
  });

  it("a backend with no shared read answers that there is no database", async () => {
    const backend = rig.state.pg.backend as any;
    const real = backend.sharedSelect;
    let cut = false;
    Object.defineProperty(backend, 'sharedSelect', { configurable: true, get: () => (cut ? undefined : real) });
    try {
      const result = await refusedUpdate(() => { cut = true; });
      expect(result.elsewhere).toEqual({ kind: 'unread', error: 'no database', by: 'BRAVO' });
    } finally {
      delete backend.sharedSelect;
    }
  });
});

function refusedTicket(refusal: RowRefusal): StoreQueued {
  return { file: 'x', ticket: { kind: 'row', key: 'global/appstore/x.json', seq: 0, op: { state: 'refused', refusal } as any } };
}

describe("awaitStoreDoc's answers for a refused store doc", () => {
  it('a refusal other than changed-elsewhere answers 500 with its whole-change text', async () => {
    const error = await awaitStoreDoc(refusedTicket({ cause: 'io' }), 'App Store settings', 1000, 'x.json').catch(e => e);
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.status).toBe(500);
    expect(error.message).toBe('The bot could not write to storage, so your change was not saved. Please try again.');
  });

  it('changed-elsewhere with no writer named answers 409 with the deleted text', async () => {
    const error = await awaitStoreDoc(refusedTicket({ cause: 'changed-elsewhere', at: new Date('2026-11-07T10:00:00.000Z') }), 'App Store settings', 1000, 'x.json').catch(e => e);
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.status).toBe(409);
    expect(error.by).toBeUndefined();
    expect(error.message).toBe('This data was deleted after your change read it, so your change was not saved. Reload to see the current values, then try again.');
  });

  it('changed-elsewhere with a writer and time names both', async () => {
    const error = await awaitStoreDoc(refusedTicket({ cause: 'changed-elsewhere', by: 'BRAVO', at: new Date('2026-11-07T10:00:00.000Z') }), 'App Store settings', 1000, 'x.json').catch(e => e);
    expect(error.status).toBe(409);
    expect(error.by).toBe('BRAVO');
    expect(error.message).toBe('x.json was changed on BRAVO at 2026-11-07T10:00:00.000Z while this change was being made; nothing was saved. Reload the App Store tab to see the current values.');
  });
});

describe("decision 15's size limits name the right file", () => {
  it('a file over 16 MiB in a subfolder is named by its path in the module', async () => {
    clone({ ...V1, 'sub/big.bin': Buffer.alloc(16 * MIB + 1), [LONG]: '1' });
    const m = new AppStoreManager();
    await expect(m.installModule('m', REPO)).rejects.toThrow(
      'm has a file over 16 MiB (sub/big.bin, 16.1 MiB), which a bot whose data is in a database cannot keep; it was not installed',
    );
    expect(rig.state.rows.modules.has('m')).toBe(false);
  });

  it('of two largest files of one size, the first the walk meets is named', async () => {
    clone({ ...V1, 'a.bin': Buffer.alloc(16 * MIB + 1), 'b.bin': Buffer.alloc(16 * MIB + 1) });
    const first = fs.readdirSync(cloneDir()).find(n => n === 'a.bin' || n === 'b.bin');
    const m = new AppStoreManager();
    await expect(m.installModule('m', REPO)).rejects.toThrow(
      `m has a file over 16 MiB (${first}, 16.1 MiB), which a bot whose data is in a database cannot keep; it was not installed`,
    );
  });

  it('a module of exactly 64 MiB is within the limit', async () => {
    const small = Buffer.byteLength(V1['module.json']) + Buffer.byteLength(V1['index.js']) + 1;
    clone({ ...V1, [LONG]: '1', 'p1.bin': Buffer.alloc(16 * MIB), 'p2.bin': Buffer.alloc(16 * MIB), 'p3.bin': Buffer.alloc(16 * MIB), 'p4.bin': Buffer.alloc(16 * MIB - small) });
    const m = new AppStoreManager();
    await expect(m.installModule('m', REPO)).rejects.toThrow(`m was not installed: its file ${LONG} cannot be stored for every machine (${LONG_CAUSE}), so nothing was changed.`);
  });

  it('a file of exactly 16 MiB is within the limit', async () => {
    clone({ ...V1, [LONG]: '1', 'big.bin': Buffer.alloc(16 * MIB) });
    const m = new AppStoreManager();
    await expect(m.installModule('m', REPO)).rejects.toThrow(`m was not installed: its file ${LONG} cannot be stored for every machine (${LONG_CAUSE}), so nothing was changed.`);
  });
});

describe('a path refusal names the first refused file in code-unit order', () => {
  const name = (lead: string) => `${lead}${'x'.repeat(209)}.js`;
  const cause = (lead: string) => `the part "${(lead + 'x'.repeat(209)).slice(0, 40)}..." is 213 bytes; one part of a key holds at most 200`;

  it.each([
    ['a', 'b'],
    ['a', 'B'],
  ])('of files led by %s and %s', async (x, y) => {
    clone({ ...V1, [name(x)]: '1', [name(y)]: '1' });
    const lead = x < y ? x : y;
    const m = new AppStoreManager();
    await expect(m.installModule('m', REPO)).rejects.toThrow(`m was not installed: its file ${name(lead)} cannot be stored for every machine (${cause(lead)}), so nothing was changed.`);
  });
});
