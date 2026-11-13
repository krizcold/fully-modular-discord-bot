import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import path from 'path';
import { applyRig } from '../helpers/nb6ApplyRig';
import { readStoreRecord, writeStoreRecord, type ApplyingIntent, type ModuleEntry } from '../../src/bot/internalSetup/utils/sharedRecords';
import { folderSha, restoreModule } from '../../src/bot/internalSetup/utils/moduleApply';
import { _resetModuleCrashes, closeWindow, countCrash, openWindow, startModule } from '../../src/bot/internalSetup/utils/moduleCrashes';

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const U_FILES = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };
const TO = 'b'.repeat(64);

beforeEach(() => rig.setup());
afterEach(async () => {
  _resetModuleCrashes();
  await rig.teardown();
});

const shared = () => rig.state.lines.filter(l => l.startsWith('[Shared]'));
const live = () => path.join(rig.state.source, 'm');

function seed(intent: Partial<ApplyingIntent>, entry: Partial<ModuleEntry> = {}): ApplyingIntent {
  const read = readStoreRecord();
  if (!read.ok) throw new Error(read.reason);
  const A: ApplyingIntent = { from: 'absent', to: TO, backup: null, displaced: 'backups', tag: '1:ALPHA', version: '2.0.0', updatedBy: 'BRAVO/p-bravo', ...intent };
  read.record.modules.m = {
    sha: A.from, stamp: null, files: {}, main: '1:ALPHA', built: null, failedSha: null, retryAt: null, heldSha: null, status: null, ...entry, applying: A,
  };
  writeStoreRecord(read.record);
  return A;
}

function crashes(sha: string, times: number): void {
  for (let i = 0; i < times; i += 1) {
    _resetModuleCrashes();
    const start = startModule('m', sha, '2.0.0', live(), { boot: true });
    if (typeof start === 'string') throw new Error(start);
    openWindow(start);
    countCrash(new Error(`crash ${i + 1}`));
    closeWindow(start);
  }
  _resetModuleCrashes();
}

const NOTHING_BACK = "[Shared] m: applying 2.0.0 was cut off when the bot process ended; nothing was put back: there was no previous version. This machine applies the database's current version of m again at this start.";

describe('restoreModule: what it refuses', () => {
  it('a module with no entry is refused with its own message', () => {
    expect(() => restoreModule('ghost', 'failed', null)).toThrowError(/^ghost has no apply to put back$/);
  });
});

describe('restoreModule: the live folder and the previous version', () => {
  it('a file in the live place with no previous version is moved to backups, and nothing is put back', () => {
    fs.writeFileSync(live(), 'a stray file');
    seed({ from: 'absent' });
    const r = restoreModule('m', 'interrupted', null);
    expect(r).toMatchObject({ how: 'none', version: 'absent', from: null });
    expect(fs.existsSync(live())).toBe(false);
    const [name] = rig.backupsOf('m');
    expect(name).toMatch(/^m-\d+-interrupted$/);
    expect(fs.readFileSync(path.join(rig.state.backups, name), 'utf8')).toBe('a stray file');
    expect(rig.entry('m')).toBeUndefined();
    expect(shared()).toEqual([NOTHING_BACK]);
  });

  it('a live folder that holds the previous version is kept, and the backup of it stays where it is', () => {
    rig.writeTree(live(), S_FILES);
    const s = folderSha(live());
    const backup = rig.writeTree(path.join(rig.state.backups, 'm-500'), S_FILES);
    seed({ from: s, backup, displaced: 'backups' });
    const r = restoreModule('m', 'interrupted', null);
    expect(r).toMatchObject({ how: 'kept', version: s, from: live(), retryAt: null });
    expect(rig.live('m')).toEqual(S_FILES);
    expect(rig.built('m')).toEqual(S_FILES);
    expect(rig.readTree(backup)).toEqual(S_FILES);
    expect(rig.entry('m')).toMatchObject({ sha: s, applying: null });
    expect(shared()).toEqual(["[Shared] m: applying 2.0.0 was cut off when the bot process ended; kept the previous version in place. This machine applies the database's current version of m again at this start."]);
  });

  it('with no previous version the backups folder is not read: a file in its place does not stop the restore', () => {
    fs.mkdirSync(path.dirname(rig.state.backups), { recursive: true });
    fs.writeFileSync(rig.state.backups, 'not a folder');
    seed({ from: 'absent', displaced: 'backups', backup: null });
    const r = restoreModule('m', 'interrupted', null);
    expect(r).toMatchObject({ how: 'none', version: 'absent' });
    expect(fs.readFileSync(rig.state.backups, 'utf8')).toBe('not a folder');
    expect(rig.entry('m')).toBeUndefined();
    expect(shared()).toEqual([NOTHING_BACK]);
  });

  it('a backup whose content is not the previous version is never put in place', () => {
    const s = folderSha(rig.writeTree(path.join(rig.state.root, 's-ref', 'm'), S_FILES));
    const backup = rig.writeTree(path.join(rig.state.backups, 'm-500'), { ...S_FILES, 'index.js': 'edited by hand' });
    seed({ from: s, backup, displaced: 'backups' });
    const r = restoreModule('m', 'interrupted', null);
    expect(r).toMatchObject({ how: 'none', version: 'absent', from: null });
    expect(rig.live('m')).toBeNull();
    expect(rig.readTree(backup)).toEqual({ ...S_FILES, 'index.js': 'edited by hand' });
    expect(shared()).toEqual(["[Shared] m: applying 2.0.0 was cut off when the bot process ended, and no copy of the previous version was found, so this machine has no copy of m. This machine applies the database's current version of m again at this start."]);
  });

  it('with no backups folder at all, the restore finds no copy and does not throw', () => {
    const s = folderSha(rig.writeTree(path.join(rig.state.root, 's-ref', 'm'), S_FILES));
    seed({ from: s, backup: null, displaced: 'backups' });
    expect(fs.existsSync(rig.state.backups)).toBe(false);
    const r = restoreModule('m', 'failed', 'boom');
    expect(r).toMatchObject({ how: 'none', version: 'absent' });
    expect(rig.live('m')).toBeNull();
    expect(rig.entry('m')).toMatchObject({ sha: 'absent', failedSha: TO });
  });

  it('of several copies of the previous version, the newest by modification time is put back', () => {
    const s = folderSha(rig.writeTree(path.join(rig.state.root, 's-ref', 'm'), S_FILES));
    const copies = ['m-1', 'm-2', 'm-3'].map(n => rig.writeTree(path.join(rig.state.backups, n), S_FILES));
    const times = [1_000, 3_000, 2_000];
    copies.forEach((p, i) => fs.utimesSync(p, times[i], times[i]));
    seed({ from: s, backup: null, displaced: 'backups' });
    const r = restoreModule('m', 'interrupted', null);
    expect(r).toMatchObject({ how: 'copied', version: s, from: copies[1] });
    expect(rig.live('m')).toEqual(S_FILES);
    expect(shared()).toEqual([`[Shared] m: applying 2.0.0 was cut off when the bot process ended; put back the previous version from ${copies[1]}. This machine applies the database's current version of m again at this start.`]);
  });

  it("another module's backup with the same content is never taken as this module's copy", () => {
    const s = folderSha(rig.writeTree(path.join(rig.state.root, 's-ref', 'm'), S_FILES));
    rig.writeTree(path.join(rig.state.backups, 'other-9'), S_FILES);
    fs.writeFileSync(path.join(rig.state.backups, 'm-file'), 'a file');
    seed({ from: s, backup: null, displaced: 'backups' });
    const r = restoreModule('m', 'interrupted', null);
    expect(r).toMatchObject({ how: 'none', version: 'absent', from: null });
    expect(rig.live('m')).toBeNull();
    expect(rig.readTree(path.join(rig.state.backups, 'other-9'))).toEqual(S_FILES);
  });
});

describe('restoreModule: the entry it writes', () => {
  it("a swap that threw on a removal sets no retry time", () => {
    rig.writeTree(live(), S_FILES);
    const s = folderSha(live());
    seed({ from: s, to: 'absent', version: null }, { sha: s });
    const r = restoreModule('m', 'swap', null);
    expect(r.retryAt).toBeNull();
    expect(rig.entry('m')).toMatchObject({ sha: s, retryAt: null, failedSha: null, status: null });
  });

  it('a swap that threw on a change to a version waits 10 minutes', () => {
    rig.writeTree(live(), S_FILES);
    const s = folderSha(live());
    seed({ from: s, to: TO }, { sha: s });
    const before = Date.now();
    const r = restoreModule('m', 'swap', null);
    expect(r.retryAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(rig.entry('m')?.retryAt).toBe(r.retryAt);
  });

  it("a crash line of another version does not count against the version that was being applied", () => {
    crashes('c'.repeat(64), 2);
    rig.writeTree(live(), S_FILES);
    const s = folderSha(live());
    seed({ from: s, to: TO }, { sha: s });
    restoreModule('m', 'interrupted', null);
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: null, status: null });
    expect(shared()).toEqual(["[Shared] m: applying 2.0.0 was cut off when the bot process ended; kept the previous version in place. This machine applies the database's current version of m again at this start."]);
  });

  it('an entry with no version but a failed sha stays', () => {
    seed({ from: 'absent' }, { failedSha: 'f'.repeat(64) });
    restoreModule('m', 'interrupted', null);
    expect(rig.entry('m')).toMatchObject({ sha: 'absent', failedSha: 'f'.repeat(64), retryAt: null, status: null, applying: null });
  });

  it('an entry with no version but a retry time stays', () => {
    seed({ from: 'absent' }, { retryAt: 12_345 });
    restoreModule('m', 'interrupted', null);
    expect(rig.entry('m')).toMatchObject({ sha: 'absent', failedSha: null, retryAt: 12_345, status: null, applying: null });
  });

  it('an entry with no version but a status not yet sent stays', () => {
    const status = { state: 'failed' as const, sha: TO, error: 'boom', at: '2026-11-13T00:00:00.000Z', seq: 4 };
    seed({ from: 'absent' }, { status });
    restoreModule('m', 'interrupted', null);
    expect(rig.entry('m')).toMatchObject({ sha: 'absent', failedSha: null, retryAt: null, status, applying: null });
  });
});

describe("restoreModule: the interrupted lines when there was no previous version", () => {
  it('after one stop while starting it: if it stops again, this machine keeps no copy of it', () => {
    crashes(TO, 1);
    seed({ from: 'absent' });
    restoreModule('m', 'interrupted', null);
    expect(shared()).toEqual([
      "[Shared] m: applying 2.0.0 was cut off when the bot stopped while it was starting 2.0.0; nothing was put back: there was no previous version. This machine applies the database's current version of m again at this start; if the bot stops again while starting 2.0.0, this machine keeps no copy of it.",
    ]);
  });

  it('after two stops while starting it: this machine keeps no copy of the module', () => {
    crashes(TO, 2);
    seed({ from: 'absent' });
    restoreModule('m', 'interrupted', null);
    expect(rig.entry('m')).toMatchObject({ sha: 'absent', failedSha: TO });
    expect(shared()).toEqual([
      '[Shared] m: applying 2.0.0 was cut off when the bot stopped while it was starting 2.0.0; nothing was put back: there was no previous version.',
      '[Shared] The bot stopped twice while it was starting m 2.0.0 on this machine (the error at the second stop: crash 2); this machine keeps no copy of m and does not try 2.0.0 again until m is updated, or uninstalled and installed again',
    ]);
  });
});

describe("the pass: T11's tail for a folder moved aside while a retry waits", () => {
  it('names the retry time and says this machine has no copy until then', async () => {
    await rig.inPlace('m', S_FILES);
    await rig.publish('m', U_FILES, '2.0.0');
    const at = Date.now() + 3_600_000;
    const read = readStoreRecord();
    if (!read.ok) throw new Error(read.reason);
    read.record.modules.m = { ...read.record.modules.m, retryAt: at };
    writeStoreRecord(read.record);
    fs.writeFileSync(path.join(live(), 'index.js'), 'edited by hand');
    rig.state.lines.length = 0;
    await rig.pass();
    expect(rig.live('m')).toBeNull();
    expect(rig.entry('m')).toMatchObject({ sha: 'absent', retryAt: at });
    const lines = shared();
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith(`; the database's version 2.0.0 could not be compiled on this machine, so this machine has no copy of m until it tries again after ${new Date(at).toISOString()}`)).toBe(true);
  });
});
