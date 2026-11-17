import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import path from 'path';
import { applyRig, fakeLoader, reloaderFakes } from '../helpers/nb6ApplyRig';
import { readStoreRecord, storeRecordPath, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { bootCompileModules, finishApply, folderSha } from '../../src/bot/internalSetup/utils/moduleApply';
import { clearLoadFailures } from '../../src/bot/internalSetup/utils/loadFailures';

const rig = applyRig();
const fakes = { ...reloaderFakes };
const TO = 'a'.repeat(64);
const STALE_MS = 10 * 60_000;

beforeEach(() => rig.setup());
afterEach(async () => {
  Object.assign(reloaderFakes, fakes);
  clearLoadFailures();
  await rig.teardown();
});

describe('folders the module code deletes hold files and subfolders', () => {
  it('sc3 finish backup: finishApply deletes a backup folder with a subfolder that holds the previous version', async () => {
    const backup = path.join(rig.state.backups, `m-${Date.now()}`);
    rig.writeTree(backup, { 'module.json': '{"name":"m","version":"0.1.0"}', 'lib/a.js': 'exports.a = 1;\n' });
    const from = folderSha(backup);
    const read = readStoreRecord();
    if (!read.ok) throw new Error(read.reason);
    read.record.modules.m = {
      sha: from, stamp: null, files: {}, main: '1:ALPHA', built: null, failedSha: null, retryAt: null, heldSha: null, status: null,
      applying: { from, to: TO, backup, displaced: 'backups', tag: '1:ALPHA', version: '1.0.0', updatedBy: 'BRAVO/p-bravo' },
    };
    writeStoreRecord(read.record);

    await expect(finishApply('m')).resolves.toBeUndefined();

    expect(rig.entry('m')).toMatchObject({ sha: TO, applying: null });
    expect(fs.existsSync(backup)).toBe(false);
  });

  it('sc3 stale staged: a pass deletes a staged folder older than 10 minutes with its subfolders', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    vi.setSystemTime(now);
    const staged = rig.writeTree(path.join(rig.state.source, `.incoming-q-${now - STALE_MS - 60_000}`), { 'index.js': 'old', 'sub/a.js': 'a' });
    await expect(rig.pass()).resolves.toBe(true);
    expect(fs.existsSync(staged)).toBe(false);
  });

  it('sc3 boot step throws: the dist folder of a module whose boot step threw is deleted with its subfolders', async () => {
    await rig.inPlace('m', { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' });
    fs.writeFileSync(path.join(rig.state.root, 'dist', '.build-complete'), 'image-2');
    rig.writeTree(path.join(rig.state.dist, 'm'), { 'index.js': 'exports.v = 1;\n', 'sub/a.js': '1;\n' });
    reloaderFakes.recompileTypeScript = async () => {
      fakeLoader.compileCalls += 1;
      fs.writeFileSync(storeRecordPath(), 'not a record');
      return { success: true, duration: 0, diagnostics: [] };
    };
    await bootCompileModules();
    expect(rig.state.lines.some(l => l.startsWith('[Error] m: finishing its start failed ('))).toBe(true);
    expect(fs.existsSync(path.join(rig.state.dist, 'm'))).toBe(false);
  });
});
