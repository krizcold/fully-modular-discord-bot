import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import path from 'path';
import { applyRig, fakeLoader, noFile, otherError, ownError, reloaderFakes } from '../helpers/nb6ApplyRig';
import { readStoreRecord, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import {
  applyModuleChange, beginBootApplies, finishApply, publisherAnswer, setModuleApplyClient, type ApplyResult,
} from '../../src/bot/internalSetup/utils/moduleApply';
import { clearLoadFailures, recordLoadFailure } from '../../src/bot/internalSetup/utils/loadFailures';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import type { CompileResult } from '../../src/bot/internalSetup/utils/moduleReloader';

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const U_FILES = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };
const NO_CLIENT = 'this process has no Discord client to load the module with';
const fakes = { ...reloaderFakes };

beforeEach(async () => {
  clearLoadFailures();
  await rig.setup();
});
afterEach(async () => {
  Object.assign(reloaderFakes, fakes);
  setStoppedServingHook(null);
  clearLoadFailures();
  await rig.teardown();
});

const shared = () => rig.state.lines.filter(l => l.startsWith('[Shared]'));

function blockBackups(): void {
  fs.mkdirSync(path.dirname(rig.state.backups), { recursive: true });
  fs.writeFileSync(rig.state.backups, 'not a folder');
}

describe('a swap that throws before the new folder is in place', () => {
  it('keeps the live version and removes the fetched folder', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    blockBackups();
    await expect(rig.apply('m', u)).rejects.toThrow(/EEXIST|ENOTDIR/);
    expect(rig.live('m')).toEqual(S_FILES);
    expect(fs.readdirSync(rig.state.source)).toEqual(['m']);
    expect(rig.entry('m')).toMatchObject({ applying: null });
  });

  it('leaves the caller\'s staged folder where it is', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    const staged = rig.writeTree(path.join(rig.state.root, 'staged', 'm'), U_FILES);
    blockBackups();
    await expect(rig.apply('m', u, { source: staged })).rejects.toThrow(/EEXIST|ENOTDIR/);
    expect(rig.readTree(staged)).toEqual(U_FILES);
    expect(rig.live('m')).toEqual(S_FILES);
  });
});

describe('the answers of an apply', () => {
  it('a boot apply answers loaded with nothing loaded yet', async () => {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    beginBootApplies();
    const result = await rig.apply('m', u);
    expect(result).toEqual({ outcome: 'loaded', reason: null, error: null, loaded: false });
  });

  it('an unload that fails without an error names the unload failed', async () => {
    await rig.inPlace('m', S_FILES);
    reloaderFakes.unloadModuleUnmarked = async (_c, module) => ({ success: false, moduleName: module });
    const result = await rig.apply('m', 'absent');
    expect(result.unloadFailed).toBe('the unload failed');
    expect(shared()).toContain("[Shared] m was removed from this machine's files, but unloading it failed (the unload failed); it keeps running until the bot restarts");
  });

  it('a kept move aside with no version leaves the version empty in its log', async () => {
    await rig.inPlace('m', S_FILES);
    const result = await applyModuleChange({ module: 'm', to: 'absent', source: 'rows', displaced: 'superseded', reason: 'pass', tag: '1:ALPHA', keep: 'failed' });
    expect(result.outcome).toBe('applied');
    const moved = shared().find(l => l.startsWith('[Shared] Moved'));
    expect(moved).toBeDefined();
    expect(moved!.endsWith("; the database's version  failed to load on this machine before, so this machine has no copy of m until it is updated, or uninstalled and installed again")).toBe(true);
  });

  it('a compile that fails with no error text names the compile failed', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    fakeLoader.compiles = [{ success: false, duration: 0, diagnostics: [] }];
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', error: 'the compile failed', kept: 'previous' });
  });

  it('a process with no Discord client fails the apply with that reason', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    setModuleApplyClient(null);
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', error: NO_CLIENT, kept: 'failed-too', previousError: NO_CLIENT });
  });

  it('a process that stops serving during the compile defers and loads nothing', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    let stopped = false;
    setStoppedServingHook(() => stopped);
    reloaderFakes.recompileTypeScript = async () => {
      stopped = true;
      return { success: true, duration: 0, diagnostics: [] };
    };
    const loads = fakeLoader.loads.length;
    const result = await rig.apply('m', u);
    expect(result).toEqual({ outcome: 'deferred', reason: 'stopped-serving', error: null, loaded: false });
    expect(fakeLoader.loads.length).toBe(loads);
  });
});

describe('load failures recorded during the load', () => {
  async function applyRecording(what: (dist: string) => string): Promise<ApplyResult> {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    let first = true;
    fakeLoader.duringLoad = () => {
      if (first) recordLoadFailure(what(rig.state.dist));
      first = false;
    };
    return rig.apply('m', u);
  }

  it('one under the module\'s name fails the apply', async () => {
    const result = await applyRecording(() => 'm');
    expect(result).toMatchObject({ outcome: 'failed', error: 'm recorded a load failure', kept: 'previous' });
    expect(rig.live('m')).toEqual(S_FILES);
  });

  it('one for a file in the module\'s dist folder fails the apply', async () => {
    const result = await applyRecording(dist => path.join(dist, 'm', 'commands', 'ping.js'));
    expect(result).toMatchObject({ outcome: 'failed', error: 'm recorded a load failure' });
  });

  it('one for another module leaves the apply applied', async () => {
    const result = await applyRecording(() => 'other');
    expect(result).toMatchObject({ outcome: 'applied', loaded: true });
    expect(rig.live('m')).toEqual(U_FILES);
  });
});

describe('a load that hands its start to a late turn', () => {
  it('logs that the database\'s version is back in place of a folder set aside', async () => {
    await rig.inPlace('m', S_FILES);
    fs.writeFileSync(path.join(rig.state.source, 'm', 'index.js'), 'edited by hand');
    const u = await rig.publish('m', U_FILES, '2.0.0');
    reloaderFakes.loadModuleUnmarked = async (_c, module) => ({ success: true, moduleName: module, late: true });
    const result = await rig.apply('m', u);
    expect(result).toEqual({ outcome: 'loaded', reason: null, error: null, loaded: true });
    const moved = shared().filter(l => l.startsWith('[Shared] Moved'));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatch(/: it differed from the version this machine last took from the database \(changed outside the bot, or left by a crash\); the database's version is back in its place$/);
  });
});

describe('finishApply and the backup', () => {
  it('a module with no entry is left alone', async () => {
    await expect(finishApply('nothing-here')).resolves.toBeUndefined();
    expect(rig.entry('nothing-here')).toBeUndefined();
  });

  it('an update that loads deletes the backup of the previous version', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    const result = await rig.apply('m', u);
    expect(result.outcome).toBe('applied');
    expect(rig.backupsOf('m')).toEqual([]);
  });

  it('a backup changed while the apply ran is kept', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    fakeLoader.duringLoad = () => {
      const [name] = rig.backupsOf('m');
      fs.writeFileSync(path.join(rig.state.backups, name, 'notes.txt'), 'written during the apply');
    };
    const result = await rig.apply('m', u);
    expect(result.outcome).toBe('applied');
    const backups = rig.backupsOf('m');
    expect(backups).toHaveLength(1);
    expect(rig.readTree(path.join(rig.state.backups, backups[0]))).toEqual({ ...S_FILES, 'notes.txt': 'written during the apply' });
  });
});

describe('the previous version after a failed apply', () => {
  async function failThenCompile(second: CompileResult): Promise<ApplyResult> {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    fakeLoader.compiles = [ownError('m'), second];
    return rig.apply('m', u);
  }

  it('errors only in other modules\' files still load the previous version', async () => {
    const result = await failThenCompile(otherError());
    expect(result).toMatchObject({ outcome: 'failed', kept: 'previous' });
    expect('previousError' in result).toBe(false);
    expect(rig.entry('m')).toMatchObject({ built: { sha: expect.any(String) } });
  });

  it('a compile that fails naming no file leaves the previous version unloaded, with its error in the answer', async () => {
    const result = await failThenCompile(noFile());
    expect(result).toMatchObject({ outcome: 'failed', kept: 'failed-too', previousError: 'Command failed: tsc (killed)' });
    const answer = publisherAnswer('update', 'm', '2.0.0', result);
    expect(answer.text).toContain('the previous version did not load either (Command failed: tsc (killed))');
  });

  it('an entry gone while the previous version compiles still loads it', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    let calls = 0;
    reloaderFakes.recompileTypeScript = async () => {
      calls += 1;
      if (calls === 1) return ownError('m');
      const read = readStoreRecord();
      if (!read.ok) throw new Error(read.reason);
      delete read.record.modules.m;
      writeStoreRecord(read.record);
      return { success: true, duration: 0, diagnostics: [] };
    };
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', kept: 'previous' });
    expect(rig.live('m')).toEqual(S_FILES);
  });

  it('a new install whose compile names no file logs the retry, not a load failure', async () => {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    fakeLoader.compiles = [noFile()];
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', kept: 'none' });
    expect(shared()).toEqual([expect.stringMatching(/^\[Shared\] m 2\.0\.0 could not be compiled on this machine \(Command failed: tsc \(killed\)\); this machine keeps no copy of it and tries again after /)]);
  });
});
