import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 9 (wip-redesign/sheets/NB6.md decisions 15, 35, 42, 44 and 61, T7 to T10, T30, T37; rows 57 to 60, 111 and
// 147 to 149, cells 459 and 460; part 19): install, update and uninstall through the real AppStoreManager on a Postgres
// bot. The module comes from a repository clone in the store's cache; the publish is the real publishModule or
// unpublishModule over scripted clients that answer as the shared tables do (helpers/sharedRows.ts); the apply is the
// real applyModuleChange with the fake loader and compile of helpers/nb6FakeLoader.ts. Row 67 is part 20's.

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
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { AppStoreManager, StoreWriteError } from '../../src/bot/internalSetup/utils/appStoreManager';
import { readStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import { setBackendKind } from '../helpers/backendKind';
import { applyRig, fakeLoader, moduleShaOfFiles } from '../helpers/nb6ApplyRig';
import { lost, pgError } from '../helpers/sharedRows';
import { webuiSessions } from '../helpers/nb6WebuiSession';

const rig = applyRig();
const REPO = 'r1';
const STORE = dataPath('global', 'appstore');
const INSTALLED = 'global/appstore/installed.json';
const INSTALLED_FILE = path.join(STORE, 'installed.json');
const CREDS = 'global/appstore/credentials/m.json';
const CREDS_FILE = path.join(STORE, 'credentials', 'm.json');
const MIB = 1024 * 1024;
const V1 = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n', 'only-1.js': '1' };
const V2 = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };

beforeEach(async () => {
  await rig.setup();
  h.dirs = { source: rig.state.source, build: rig.state.build, dist: rig.state.dist, dev: path.join(rig.state.root, 'modulesDev') };
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(path.join(STORE, 'repos.json'), JSON.stringify({ repositories: [{ id: REPO, name: 'Repo', url: 'https://github.com/example/r', branch: 'main', enabled: true }] }, null, 2));
});

afterEach(async () => {
  setStoppedServingHook(null);
  useWebuiSessions(null);
  await rig.teardown();
});

/** The repository clone in the store's cache holds this version of m. */
function clone(files: Record<string, string | Buffer>): void {
  const dir = path.join(STORE, 'cache', REPO);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const [rel, bytes] of Object.entries(files)) {
    const file = path.join(dir, 'Modules', 'm', ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
}

const staged = () => (fs.existsSync(rig.state.source) ? fs.readdirSync(rig.state.source).filter(n => n.startsWith('.incoming-')) : []);
const sqls = () => rig.state.pg.sent.map(s => s.sql);
const installedRow = () => JSON.parse(rig.state.rows.docs.get(INSTALLED)!.body.toString('utf8'));
const storeDoc = (key: string) => {
  const read = readStoreRecord();
  if (!read.ok) throw new Error(read.reason);
  return read.record.docs[key];
};

/** The next COMMIT's answer is lost: applied and its answer lost, or (not stored) never applied; the check answers or not. */
function loseNextCommit(check: boolean | 'not stored'): void {
  let committing: number | null = null;
  rig.state.rows.fault = (sql, _p, client) => {
    if (sql === 'COMMIT' && committing === null) {
      committing = client;
      return check === 'not stored' ? lost() : 'lose';
    }
    if (check === false && committing !== null && client !== committing && sql.startsWith('SELECT id')) return lost();
    return undefined;
  };
}

async function installed(): Promise<{ m: AppStoreManager; sha: string }> {
  clone(V1);
  const m = new AppStoreManager();
  await m.installModule('m', REPO);
  return { m, sha: moduleShaOfFiles(V1) };
}

describe('row 57: install and update land, then the apply', () => {
  it('install: the staged copy, then the rows and installed.json; the swap and load after the answer', async () => {
    clone(V1);
    const m = new AppStoreManager();
    let atCommit: { staged: string[]; live: unknown } | null = null;
    rig.state.rows.fault = sql => {
      if (sql === 'COMMIT' && !atCommit) atCommit = { staged: staged(), live: rig.live('m') };
      return undefined;
    };
    const answer = await m.installModule('m', REPO);
    const to = moduleShaOfFiles(V1);
    expect(answer).toMatchObject({ module: 'm', operation: 'install', version: '1.0.0', to, tag: '1:ALPHA', staged: null });
    expect((answer as { applied: unknown }).applied).toEqual({ outcome: 'applied', reason: null, error: null, loaded: true, text: null });
    expect(atCommit!.staged).toHaveLength(1);
    expect(atCommit!.live).toBeNull();
    expect(rig.state.rows.modules.get('m')?.sha).toBe(to);
    expect(installedRow().modules.m).toMatchObject({ name: 'm', version: '1.0.0', installedFrom: REPO, commitHash: 'a'.repeat(40) });
    expect(fs.readFileSync(INSTALLED_FILE).equals(rig.state.rows.docs.get(INSTALLED)!.body)).toBe(true);
    expect(storeDoc(INSTALLED)).toEqual({ sha: rig.state.rows.docs.get(INSTALLED)!.sha, stamp: null, main: '1:ALPHA' });
    expect(rig.live('m')).toEqual(V1);
    expect(rig.built('m')).toEqual(V1);
    expect(rig.entry('m')).toMatchObject({ sha: to, failedSha: null });
    expect(fakeLoader.loads).toEqual([{ module: 'm', sha: to }]);
    expect(staged()).toEqual([]);
    expect(m.isModuleInstalled('m')).toBe(true);
    expect(rig.state.rows.ops.size).toBe(1);
  });

  it('update: the new version is published and applied; the backup of the version the database held is deleted', async () => {
    const { m } = await installed();
    clone(V2);
    const result = await m.updateModule('m');
    const to = moduleShaOfFiles(V2);
    expect(result).toMatchObject({ success: true, newVersion: '2.0.0', applied: { outcome: 'applied', loaded: true, text: null } });
    expect(rig.state.rows.modules.get('m')?.sha).toBe(to);
    expect(installedRow().modules.m.version).toBe('2.0.0');
    expect(rig.live('m')).toEqual(V2);
    expect(rig.entry('m')).toMatchObject({ sha: to });
    expect(rig.backupsOf('m')).toEqual([]);
    expect(staged()).toEqual([]);
  });

  it('in the web UI the install ends at the publish: the staged folder is handed on, nothing local is swapped', async () => {
    clone(V1);
    dm.setGuildDataBackend(null);
    const s = webuiSessions(rig.state.rows);
    useWebuiSessions({
      target: async () => ({ entry: 'postgres://bot@db:5432/bot', tag: '1:ALPHA', countAtStart: 0 }),
      commitCheck: () => null,
      select: async (text, values) => {
        const res = await rig.state.rows.answer(text, values, 0, 999);
        if (res instanceof Error) throw res;
        return (res ?? { rows: [] }) as { rows: any[] };
      },
      tag: () => '1:ALPHA',
      session: config => s.session(config as Record<string, unknown>),
    });
    const m = new AppStoreManager();
    const answer = await m.installModule('m', REPO) as { staged: string; applied: unknown; to: string };
    expect(answer).toMatchObject({ module: 'm', operation: 'install', to: moduleShaOfFiles(V1), tag: '1:ALPHA', applied: null });
    expect(rig.readTree(answer.staged)).toEqual(V1);
    expect(rig.live('m')).toBeNull();
    expect(rig.entry('m')).toBeUndefined();
    expect(fakeLoader.loads).toEqual([]);
    expect(rig.state.rows.modules.get('m')?.sha).toBe(answer.to);
    expect(fs.readFileSync(INSTALLED_FILE).equals(rig.state.rows.docs.get(INSTALLED)!.body)).toBe(true);
  });
});

describe('row 58: installed.json changed on another machine', () => {
  const text = (done: string) => `m was not ${done}: the list of installed modules was changed on BRAVO at 2026-11-07T10:00:00.000Z while this ran. Try again.`;

  it('install: 409, rolled back, the staged copy deleted and nothing local changed', async () => {
    clone(V1);
    const m = new AppStoreManager();
    rig.state.rows.put(INSTALLED, '{"modules":{"other":{}}}');
    const error = await m.installModule('m', REPO).catch(e => e);
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error).toMatchObject({ status: 409, message: text('installed') });
    expect(sqls()[sqls().length - 1]).toBe('ROLLBACK');
    expect(rig.state.rows.modules.has('m')).toBe(false);
    expect(staged()).toEqual([]);
    expect(rig.live('m')).toBeNull();
    expect(fs.existsSync(INSTALLED_FILE)).toBe(false);
  });

  it('update: not updated, the version in place untouched', async () => {
    const { m, sha: s } = await installed();
    clone(V2);
    rig.state.rows.put(INSTALLED, '{"modules":{"m":{"version":"9.9.9"}}}');
    const result = await m.updateModule('m');
    expect(result).toEqual({ success: false, error: text('updated'), changedElsewhere: true, elsewhere: { kind: 'module', by: 'BRAVO' } });
    expect(rig.state.rows.modules.get('m')?.sha).toBe(s);
    expect(rig.live('m')).toEqual(V1);
    expect(rig.entry('m')).toMatchObject({ sha: s });
    expect(staged()).toEqual([]);
  });

  it('uninstall: not uninstalled, the module in place', async () => {
    const { m, sha: s } = await installed();
    rig.state.rows.put(INSTALLED, '{"modules":{}}');
    const error = await m.uninstallModule('m').catch(e => e);
    expect(error).toMatchObject({ status: 409, message: text('uninstalled') });
    expect(rig.state.rows.modules.get('m')?.sha).toBe(s);
    expect(rig.live('m')).toEqual(V1);
    expect(rig.entry('m')).toMatchObject({ sha: s });
  });
});

describe("row 59: 42's size texts, before anything is written", () => {
  it('a file over 16 MiB', async () => {
    clone({ ...V1, 'big.bin': Buffer.alloc(16 * MIB + 1) });
    const m = new AppStoreManager();
    await expect(m.installModule('m', REPO)).rejects.toThrow(
      'm has a file over 16 MiB (big.bin, 16.1 MiB), which a bot whose data is in a database cannot keep; it was not installed',
    );
    expect(sqls().some(q => q.includes('shared_module'))).toBe(false);
    expect(staged()).toEqual([]);
  });

  it('a module over 64 MiB, for an update', async () => {
    const { m, sha: s } = await installed();
    const big = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`part-${i}.bin`, Buffer.alloc(13 * MIB)]));
    clone({ ...V2, ...big });
    const result = await m.updateModule('m');
    expect(result).toEqual({ success: false, error: expect.stringMatching(/^m is 65\.1 MiB, over the 64 MiB a module can have on a bot whose data is in a database; it was not updated$/) });
    expect(rig.state.rows.modules.get('m')?.sha).toBe(s);
    expect(rig.live('m')).toEqual(V1);
    expect(staged()).toEqual([]);
  });
});

describe("row 60 and cell 459: the COMMIT's answer lost", () => {
  it('the landing check finds the op: installed and applied', async () => {
    clone(V1);
    const m = new AppStoreManager();
    loseNextCommit(true);
    const answer = await m.installModule('m', REPO);
    expect(answer).toMatchObject({ to: moduleShaOfFiles(V1), applied: { outcome: 'applied' } });
    expect(rig.live('m')).toEqual(V1);
    expect(staged()).toEqual([]);
  });

  it('the op was not stored: 42\'s text with the cause; the staged copy deleted', async () => {
    clone(V1);
    const m = new AppStoreManager();
    loseNextCommit('not stored');
    const error = await m.installModule('m', REPO).catch(e => e);
    expect(error).toMatchObject({ status: 500 });
    expect(error.message).toMatch(/^m was not installed: .*Connection terminated unexpectedly/);
    expect(staged()).toEqual([]);
    expect(rig.live('m')).toBeNull();
    expect(rig.entry('m')).toBeUndefined();
  });

  it("no answer from the check: 35's can't confirm text; the staged copy deleted and the record untouched", async () => {
    clone(V1);
    const m = new AppStoreManager();
    loseNextCommit(false);
    const error = await m.installModule('m', REPO).catch(e => e);
    expect(error).toMatchObject({ status: 202 });
    expect(error.message).toMatch(/^Can't confirm whether m was installed: the database did not answer the save \(.*Connection terminated unexpectedly.*\)\. The App Store tab shows the result once it does\.$/);
    expect(staged()).toEqual([]);
    expect(rig.live('m')).toBeNull();
    expect(rig.entry('m')).toBeUndefined();
    expect(fs.existsSync(INSTALLED_FILE)).toBe(false);
    expect(rig.state.rows.modules.get('m')?.sha).toBe(moduleShaOfFiles(V1));
  });
});

describe('row 111 and cell 460: nothing committed', () => {
  it('row 111: an error before COMMIT: 42\'s text with the cause', async () => {
    clone(V1);
    const m = new AppStoreManager();
    rig.state.rows.fault = sql => (sql.startsWith('DELETE FROM smdb_data.shared_module_files') ? pgError('53100', 'could not extend file: No space left on device') : undefined);
    const error = await m.installModule('m', REPO).catch(e => e);
    expect(error).toMatchObject({ status: 500 });
    expect(error.message).toMatch(/^m was not installed: .*No space left on device/);
    expect(sqls()).not.toContain('COMMIT');
    expect(staged()).toEqual([]);
    expect(rig.live('m')).toBeNull();
  });

  it("cell 460: a statement past its bound: T35's module form logged, 35's refusal text with T35's cause", async () => {
    clone({ ...V1, 'blob.bin': Buffer.alloc(MIB, 7) });
    const m = new AppStoreManager();
    rig.state.rows.fault = sql => (sql.startsWith('INSERT INTO smdb_data.shared_module_files') ? pgError('57014', 'canceling statement due to statement timeout') : undefined);
    const error = await m.installModule('m', REPO).catch(e => e);
    expect(error).toMatchObject({ status: 500 });
    expect(error.message).toMatch(/^m was not installed: a statement of \d+ KiB (did not finish within|was cancelled after) .*\(SQLSTATE 57014\)$/);
    expect(rig.state.lines.some(l => /^\[Shared\] Saving module m: .*Nothing was saved, and the install of m ended\.$/.test(l))).toBe(true);
    expect(staged()).toEqual([]);
  });
});

describe('rows 147 to 149: uninstall', () => {
  it('row 147: the unpublish answered: the removal, the credentials mirror and its entry gone, installed.json written', async () => {
    const { m } = await installed();
    await m.saveCredentialsAwaited('m', { KEY: 'v' });
    expect(fs.existsSync(CREDS_FILE)).toBe(true);
    const answer = await m.uninstallModule('m');
    expect(answer).toMatchObject({ module: 'm', operation: 'uninstall', to: 'absent', applied: { outcome: 'applied', text: null } });
    expect(rig.state.rows.modules.has('m')).toBe(false);
    expect(rig.state.rows.docs.has(CREDS)).toBe(false);
    expect(fs.existsSync(CREDS_FILE)).toBe(false);
    expect(storeDoc(CREDS)).toBeUndefined();
    expect(installedRow().modules.m).toBeUndefined();
    expect(fs.readFileSync(INSTALLED_FILE).equals(rig.state.rows.docs.get(INSTALLED)!.body)).toBe(true);
    expect(rig.live('m')).toBeNull();
    expect(rig.entry('m')).toBeUndefined();
    expect(rig.backupsOf('m')).toHaveLength(1);
    expect(fakeLoader.unloads).toEqual(['m']);
    expect(m.isModuleInstalled('m')).toBe(false);
  });

  it('row 148: the COMMIT answer lost and the check finds the op: the removal as 147', async () => {
    const { m } = await installed();
    loseNextCommit(true);
    const answer = await m.uninstallModule('m');
    expect(answer).toMatchObject({ to: 'absent', applied: { outcome: 'applied' } });
    expect(rig.live('m')).toBeNull();
    expect(rig.entry('m')).toBeUndefined();
  });

  it('row 149: no check answer: T10, nothing local changed', async () => {
    const { m, sha: s } = await installed();
    const before = fs.readFileSync(INSTALLED_FILE);
    loseNextCommit(false);
    const error = await m.uninstallModule('m').catch(e => e);
    expect(error).toMatchObject({ status: 202 });
    expect(error.message).toMatch(/^Can't confirm whether m was uninstalled: the database did not answer the save \(.*\)\. The App Store tab shows the result once it does\.$/);
    expect(rig.live('m')).toEqual(V1);
    expect(rig.entry('m')).toMatchObject({ sha: s });
    expect(fs.readFileSync(INSTALLED_FILE).equals(before)).toBe(true);
  });
});

describe("the publisher's answers after the apply (decision 61)", () => {
  it('T9: the version failed to load on this machine, which keeps no copy of it', async () => {
    clone({ ...V1, 'fail.txt': 'index.js threw: boom' });
    const m = new AppStoreManager();
    const answer = await m.installModule('m', REPO);
    expect((answer as { applied: unknown }).applied).toMatchObject({
      outcome: 'failed',
      loaded: false,
      text: 'm 1.0.0 was installed, but it failed to load on this machine (index.js threw: boom), so this machine keeps no copy of it. The other machines try it when they apply it, and the App Store tab lists each machine where it fails.',
    });
    expect(rig.live('m')).toBeNull();
  });

  it('T37: this process stopped serving its shards; the staged copy is deleted, the pass applies it after the restart', async () => {
    clone(V1);
    const m = new AppStoreManager();
    setStoppedServingHook(() => true);
    const answer = await m.installModule('m', REPO);
    expect((answer as { applied: unknown }).applied).toMatchObject({
      outcome: 'deferred',
      reason: 'stopped-serving',
      text: "m 1.0.0 was installed. This machine's bot process stopped serving its shards and restarts; it tries to load the module after that restart.",
    });
    expect(rig.state.rows.modules.get('m')?.sha).toBe(moduleShaOfFiles(V1));
    expect(staged()).toEqual([]);
    expect(rig.live('m')).toBeNull();
  });
});

describe("decision 35's last paragraph: the pass deletes a stale staged folder", () => {
  it('a staged folder over 10 minutes old is deleted; a newer one stays', async () => {
    const old = path.join(rig.state.source, `.incoming-m-${Date.now() - 11 * 60_000}`);
    const fresh = path.join(rig.state.source, `.incoming-n-${Date.now() - 9 * 60_000}`);
    rig.writeTree(old, V1);
    rig.writeTree(fresh, V1);
    await rig.pass();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('a staged folder this process holds for its publish stays, however old the clock says it is', async () => {
    clone(V1);
    const m = new AppStoreManager();
    let seen: { before: string[]; after: string[] } | null = null;
    rig.state.rows.fault = async sql => {
      if (sql !== 'COMMIT' || seen) return undefined;
      const real = Date.now.bind(Date);
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + 11 * 60_000);
      const before = staged();
      try {
        await rig.pass();
      } finally {
        clock.mockRestore();
      }
      seen = { before, after: staged() };
      return undefined;
    };
    await m.installModule('m', REPO);
    expect(seen!.before).toHaveLength(1);
    expect(seen!.after).toEqual(seen!.before);
    expect(rig.live('m')).toEqual(V1);
  });
});

describe('a JSON bot (guard)', () => {
  it('copies the module into place as before and answers true', async () => {
    dm.setGuildDataBackend(null);
    setBackendKind(null);
    clone(V1);
    const m = new AppStoreManager();
    expect(await m.installModule('m', REPO)).toBe(true);
    expect(rig.live('m')).toEqual(V1);
    expect(rig.built('m')).toEqual(V1);
    expect(JSON.parse(fs.readFileSync(INSTALLED_FILE, 'utf8')).modules.m.version).toBe('1.0.0');
    expect(staged()).toEqual([]);
  });
});
