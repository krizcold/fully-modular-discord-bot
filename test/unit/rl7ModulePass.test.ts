import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 chunk rl7: the pass's module step (NB6 decision 49 steps 1 to 5 and decision 35's stale staged folders) over the
// rows the real publish writes, with the fake loader of the apply rig.

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import path from 'path';
import { syncBuiltinESMExports } from 'module';
import { dataPath } from '../../src/utils/dataRoot';
import { applyRig, fakeLoader } from '../helpers/nb6ApplyRig';
import { readStoreRecord, storeRecordPath, writeStoreRecord, type StoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const U_FILES = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };
const FAILING = { ...U_FILES, 'fail.txt': 'index.js threw: boom' };

beforeEach(() => rig.setup());
afterEach(async () => {
  await rig.teardown();
  syncBuiltinESMExports();
});

const shared = () => rig.state.lines.filter(l => l.startsWith('[Shared]'));

function editRecord(edit: (record: StoreRecord) => void): void {
  const read = readStoreRecord();
  if (!read.ok) throw new Error(read.reason);
  edit(read.record);
  writeStoreRecord(read.record);
}

/**
 * Another process's write landing between the pass's first read of the record and its read under the store lock: the
 * pass reads the live folder in between, so the edit lands on the first record read after that.
 */
function editAfterFolderRead(module: string, edit: (record: StoreRecord) => void): { fired: () => boolean } {
  const live = path.join(rig.state.source, module);
  const realExists = fs.existsSync;
  const realRead = fs.readFileSync;
  let armed = false;
  let fired = false;
  vi.spyOn(fs, 'existsSync').mockImplementation(((p: any) => {
    if (!fired && path.resolve(String(p)) === path.resolve(live)) armed = true;
    return realExists(p);
  }) as typeof fs.existsSync);
  vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
    if (armed && !fired && path.resolve(String(p)) === path.resolve(storeRecordPath())) {
      fired = true;
      const record = JSON.parse((realRead as any)(p, 'utf8')) as StoreRecord;
      edit(record);
      writeStoreRecord(record);
    }
    return (realRead as any)(p, ...rest);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  return { fired: () => fired };
}

describe('an entry whose main is not tag0 (49 step 4)', () => {
  it('a folder taken before the switch goes to _superseded when the row names another version, with T11\'s switch head', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    editRecord(r => { r.modules.m = { ...r.modules.m, main: '0' }; });
    rig.state.lines.length = 0;
    await rig.pass();
    expect(rig.live('m')).toEqual(U_FILES);
    expect(rig.entry('m')).toMatchObject({ sha: u, main: '1:ALPHA' });
    expect(rig.backupsOf('m')).toEqual([]);
    const moved = shared().filter(l => l.startsWith('[Shared] Moved'));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toContain(`[Shared] Moved ${path.join(rig.state.source, 'm')} to ${dataPath('_superseded')}`);
    expect(moved[0]).toContain('it held the version this machine took from the database before the switch to ALPHA (generation 1)');
  });

  it('a module with no folder whose row is its failed version is left as it is: nothing is unloaded or rewritten', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', FAILING, '2.0.0');
    await rig.apply('m', u);
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: u });
    editRecord(r => { r.modules.m = { ...r.modules.m, main: '0' }; });
    fs.rmSync(path.join(rig.state.source, 'm'), { recursive: true, force: true });
    fakeLoader.unloads = [];
    fakeLoader.loads = [];
    rig.state.lines.length = 0;
    await rig.pass();
    expect(fakeLoader.unloads).toEqual([]);
    expect(fakeLoader.loads).toEqual([]);
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: u, main: '0' });
    expect(shared()).toEqual([]);
  });

  it('the folder already holds the row\'s version: the entry takes tag0 as its main and nothing moves', async () => {
    const s = await rig.inPlace('m', S_FILES);
    editRecord(r => { r.modules.m = { ...r.modules.m, main: '0' }; });
    fakeLoader.loads = [];
    await rig.pass();
    expect(rig.entry('m')).toMatchObject({ sha: s, main: '1:ALPHA' });
    expect(rig.live('m')).toEqual(S_FILES);
    expect(fakeLoader.loads).toEqual([]);
    expect(rig.backupsOf('m')).toEqual([]);
  });

  it('an entry another process dropped while the pass looked at the folder is not written back', async () => {
    await rig.inPlace('m', S_FILES);
    editRecord(r => { r.modules.m = { ...r.modules.m, main: '0' }; });
    const hook = editAfterFolderRead('m', r => { delete r.modules.m; });
    await rig.pass();
    expect(hook.fired()).toBe(true);
    const read = readStoreRecord();
    if (!read.ok) throw new Error(read.reason);
    expect(read.record.modules.m).toBeUndefined();
    expect(shared()).toEqual([]);
  });
});

describe('an up-to-date module', () => {
  it('a pass with nothing to change writes no record, so a store write that fails raises no error', async () => {
    const s = await rig.inPlace('m', S_FILES);
    expect(rig.entry('m')).toMatchObject({ sha: s, main: '1:ALPHA', status: null });
    rig.state.lines.length = 0;
    const realOpen = fs.openSync;
    const tmpOf = `${storeRecordPath()}.`;
    let refused = 0;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (String(p).startsWith(tmpOf) && String(p).endsWith('.tmp')) {
        refused += 1;
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return (realOpen as any)(p, ...rest);
    }) as typeof fs.openSync);
    syncBuiltinESMExports();
    expect(await rig.pass()).toBe(true);
    expect(refused).toBe(0);
    expect(shared()).toEqual([]);
    expect(rig.entry('m')).toMatchObject({ sha: s, main: '1:ALPHA' });
  });
});

describe('the retry time (49 step 4)', () => {
  it('a retryAt equal to now has passed: the pass applies the row', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T12:00:00.000Z'));
    editRecord(r => { r.modules.m = { ...r.modules.m, retryAt: Date.now() }; });
    await rig.pass();
    expect(rig.live('m')).toEqual(U_FILES);
    expect(rig.entry('m')?.sha).toBe(u);
  });
});

describe('a module with no row, no folder and an entry (49 step 5)', () => {
  async function gone(): Promise<void> {
    await rig.inPlace('m', S_FILES);
    await rig.unpublish('m');
    fs.rmSync(path.join(rig.state.source, 'm'), { recursive: true, force: true });
    rig.state.lines.length = 0;
  }

  it('the entry is dropped', async () => {
    await gone();
    await rig.pass();
    const read = readStoreRecord();
    if (!read.ok) throw new Error(read.reason);
    expect(read.record.modules.m).toBeUndefined();
    expect(shared()).toEqual([]);
  });

  it('an entry another process began applying while the pass looked at the folder is kept with its intent', async () => {
    await gone();
    const intent = { from: 'absent', to: 'f'.repeat(64), backup: null, displaced: 'backups' as const, tag: '1:ALPHA', version: '3.0.0', updatedBy: 'BRAVO/p-bravo' };
    const hook = editAfterFolderRead('m', r => { r.modules.m = { ...r.modules.m, applying: intent }; });
    await rig.pass();
    expect(hook.fired()).toBe(true);
    const read = readStoreRecord();
    if (!read.ok) throw new Error(read.reason);
    expect(read.record.modules.m?.applying).toEqual(intent);
  });
});

describe('stale staged folders (35)', () => {
  const stage = (name: string) => rig.writeTree(path.join(rig.state.source, name), { 'index.js': `held by ${name}` });

  it('a .incoming folder of a module with a longer name, older than 10 minutes, is deleted', async () => {
    stage('.incoming-mod-1000');
    await rig.pass();
    expect(fs.existsSync(path.join(rig.state.source, '.incoming-mod-1000'))).toBe(false);
  });

  it('a folder whose name only ends like a staged one is kept', async () => {
    stage('.old.incoming-mod-1000');
    await rig.pass();
    expect(rig.readTree(path.join(rig.state.source, '.old.incoming-mod-1000'))).toEqual({ 'index.js': 'held by .old.incoming-mod-1000' });
  });

  it('a folder whose name only starts like a staged one is kept', async () => {
    stage('.incoming-mod-1000.bak');
    await rig.pass();
    expect(rig.readTree(path.join(rig.state.source, '.incoming-mod-1000.bak'))).toEqual({ 'index.js': 'held by .incoming-mod-1000.bak' });
  });
});
