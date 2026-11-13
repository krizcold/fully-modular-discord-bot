import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The pass's module step (passModule, sourceFolders and the stop check of modulePassStep) in
// src/bot/internalSetup/utils/moduleApply.ts, over NB6's apply rig.

const stop = vi.hoisted(() => ({ on: false }));

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<any>();
  return { ...real, isStopping: () => stop.on || real.isStopping() };
});

import fs from 'fs';
import path from 'path';
import { dataPath } from '../../src/utils/dataRoot';
import { applyRig, fakeLoader } from '../helpers/nb6ApplyRig';
import { readStoreRecord, writeStoreRecord, type ModuleEntry } from '../../src/bot/internalSetup/utils/sharedRecords';
import { startModule } from '../../src/bot/internalSetup/utils/moduleCrashes';

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const U_FILES = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };
const A_FILES = { 'module.json': '{"name":"a","version":"1.0.0"}', 'index.js': 'exports.a = 1;\n' };

beforeEach(() => rig.setup());
afterEach(async () => {
  stop.on = false;
  await rig.teardown();
});

const shared = () => rig.state.lines.filter(l => l.startsWith('[Shared]'));

function editEntry(module: string, edit: (entry: ModuleEntry | undefined) => ModuleEntry | undefined): void {
  const read = readStoreRecord();
  if (!read.ok) throw new Error(read.reason);
  const next = edit(read.record.modules[module]);
  if (next) read.record.modules[module] = next;
  else delete read.record.modules[module];
  writeStoreRecord(read.record);
}

function listInstalled(...modules: string[]): void {
  fs.mkdirSync(dataPath('global', 'appstore'), { recursive: true });
  fs.writeFileSync(dataPath('global', 'appstore', 'installed.json'), JSON.stringify({ modules: Object.fromEntries(modules.map(m => [m, { version: '1.0.0' }])) }));
}

describe('the pass on a folder that already holds the row', () => {
  it('writes a full entry for it without an apply', async () => {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    rig.writeTree(path.join(rig.state.source, 'm'), U_FILES);
    fakeLoader.loads = [];
    const compiles = fakeLoader.compileCalls;
    await rig.pass();
    expect(rig.entry('m')).toEqual({
      sha: u, stamp: null, files: {}, main: '1:ALPHA', built: null, failedSha: null, retryAt: null, heldSha: null, status: null, applying: null,
    });
    expect(fakeLoader.loads).toEqual([]);
    expect(fakeLoader.compileCalls).toBe(compiles);
  });

  it('leaves a module alone while a start of it is open', async () => {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    rig.writeTree(path.join(rig.state.source, 'm'), U_FILES);
    const start = startModule('m', u, '2.0.0', path.join(rig.state.source, 'm'));
    expect(typeof start).toBe('object');
    await rig.pass();
    expect(rig.entry('m')).toBeUndefined();
  });
});

describe('the pass on a module with no row', () => {
  it('whose folder is gone drops the entry without an unload', async () => {
    await rig.inPlace('m', S_FILES);
    fs.rmSync(path.join(rig.state.source, 'm'), { recursive: true, force: true });
    await rig.unpublish('m');
    fakeLoader.unloads = [];
    await rig.pass();
    expect(rig.entry('m')).toBeUndefined();
    expect(fakeLoader.unloads).toEqual([]);
    expect(shared()).toEqual([]);
  });

  it('whose entry another apply of the same pass dropped, with no folder, stays silent though listed as installed', async () => {
    await rig.inPlace('a', A_FILES);
    await rig.publish('a', { ...A_FILES, 'index.js': 'exports.a = 2;\n' }, '2.0.0');
    editEntry('m', () => ({
      sha: 'absent', stamp: null, files: {}, main: '1:ALPHA', built: null, failedSha: 'f'.repeat(64), retryAt: null, heldSha: null, status: null, applying: null,
    }));
    listInstalled('a', 'm');
    fakeLoader.duringLoad = module => {
      if (module === 'a') editEntry('m', () => undefined);
    };
    rig.state.lines.length = 0;
    await rig.pass();
    expect(rig.entry('a')?.applying ?? null).toBeNull();
    expect(rig.entry('m')).toBeUndefined();
    expect(shared()).toEqual([]);
  });
});

describe('the pass after the main database changed', () => {
  it('sets aside a folder whose entry was written under the old main, with T11 head b', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    editEntry('m', e => (e ? { ...e, main: '0:OLD' } : e));
    rig.state.lines.length = 0;
    await rig.pass();
    expect(rig.live('m')).toEqual(U_FILES);
    expect(rig.entry('m')).toMatchObject({ sha: u, main: '1:ALPHA' });
    const line = shared().find(l => l.startsWith('[Shared] Moved'));
    expect(line).toMatch(/: it held the version this machine took from the database before the switch to ALPHA \(generation 1\); the database's version is back in its place$/);
    expect(line).toContain('_superseded');
    expect(s).not.toBe(u);
  });
});

describe('the pass while an apply of the module runs', () => {
  it('skips the module while the apply fetches it, so the version is loaded once', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    rig.state.rows.fault = async sql => {
      if (!held && sql.startsWith('SELECT rel, mode, octet_length(bytes)')) {
        held = true;
        await gate;
      }
      return undefined;
    };
    fakeLoader.loads = [];
    const first = rig.apply('m', u, { source: 'rows' });
    await vi.waitFor(() => { if (!held) throw new Error('the fetch did not start'); }, { timeout: 5_000, interval: 5 });
    let passDone = false;
    const passing = rig.pass().then(() => { passDone = true; });
    try {
      await vi.waitFor(() => { if (!passDone) throw new Error('the pass waited on the running apply'); }, { timeout: 3_000, interval: 5 });
    } finally {
      release();
      await first;
      await passing;
    }
    expect(fakeLoader.loads).toEqual([{ module: 'm', sha: u }]);
    expect(rig.entry('m')).toMatchObject({ sha: u });
  });
});

describe('the pass on folders it cannot read', () => {
  it('logs a module folder it cannot read and tries again at the next pass', async () => {
    await rig.publish('m', U_FILES, '2.0.0');
    fs.writeFileSync(path.join(rig.state.source, 'm'), 'not a folder');
    await rig.pass();
    expect(shared()).toEqual([expect.stringMatching(/^\[Shared\] Could not read the module folder m \(.+\); the next pass tries again$/)]);
    expect(rig.entry('m')).toBeUndefined();
  });

  it('answers when the source modules folder does not exist', async () => {
    fs.rmSync(rig.state.source, { recursive: true, force: true });
    await expect(rig.pass()).resolves.toBe(true);
  });
});

describe('the pass while the bot stops', () => {
  it('applies no module once a stop began', async () => {
    await rig.publish('m', U_FILES, '2.0.0');
    stop.on = true;
    await expect(rig.pass()).resolves.toBe(true);
    expect(rig.live('m')).toBeNull();
    expect(rig.entry('m')).toBeUndefined();
    expect(fakeLoader.loads).toEqual([]);
  });
});
