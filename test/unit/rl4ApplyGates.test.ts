import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// applyModuleChange (NB6 decisions 43, 58, 61): the wait on a running reload, the mutex refusal, the reload counters
// the orphan sweep reads, which folder is taken as the incoming version, and the intent the swap records.

const probe = vi.hoisted(() => ({ isReloadingCalls: 0, cap: Infinity }));

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return {
    ...real,
    ...reloaderMock,
    // A cap turns a loop that never yields into a wrong answer the test sees, not a hung worker.
    isReloading: (module: string) => {
      probe.isReloadingCalls += 1;
      if (probe.isReloadingCalls > probe.cap) return false;
      return real.isReloading(module);
    },
  };
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { applyRig, fakeLoader, reloaderFakes } from '../helpers/nb6ApplyRig';
import { applyModuleChange, type ApplyResult } from '../../src/bot/internalSetup/utils/moduleApply';
import { markReloading, unmarkReloading } from '../../src/bot/internalSetup/utils/moduleReloader';
import { storeMutex, type StoreMutexHold } from '../../src/bot/internalSetup/utils/appStoreManager';
import { getReloadState } from '../../src/bot/internalSetup/utils/loadFailures';
import { endStart, startModule } from '../../src/bot/internalSetup/utils/moduleCrashes';
import { dataPath } from '../../src/utils/dataRoot';

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const U_FILES = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };

let pending: Promise<unknown> | null = null;
const temps: string[] = [];

beforeEach(async () => {
  probe.isReloadingCalls = 0;
  probe.cap = 50;
  pending = null;
  await rig.setup();
});

afterEach(async () => {
  unmarkReloading('m');
  probe.cap = Infinity;
  if (pending) await Promise.race([pending.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 1000))]);
  await rig.teardown();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const shared = () => rig.state.lines.filter(l => l.startsWith('[Shared]'));

function track(promise: Promise<ApplyResult>): { settled: () => ApplyResult | null; promise: Promise<ApplyResult> } {
  let result: ApplyResult | null = null;
  const tracked = promise.then(r => { result = r; return r; });
  pending = tracked;
  return { settled: () => result, promise: tracked };
}

// A hold of its own: an apply that never ends must not keep the store mutex from the tests after it.
const hold: StoreMutexHold = { release: () => undefined };
const applyHeld = (module: string, to: string) =>
  applyModuleChange({ module, to, source: 'rows', displaced: 'backups', reason: 'pass', tag: '1:ALPHA', version: '2.0.0', updatedBy: 'BRAVO/p-bravo' }, hold);

const polled = () => vi.waitFor(() => expect(probe.isReloadingCalls).toBeGreaterThanOrEqual(2), { timeout: 2000, interval: 5 });

describe('the wait on a reload of the module', () => {
  it('an apply waits while a reload of the module runs and applies once it ends', async () => {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    markReloading('m');
    const run = track(applyHeld('m', u));
    await polled();
    expect(probe.isReloadingCalls).toBeLessThan(50);
    expect(run.settled()).toBeNull();
    expect(fakeLoader.loads).toEqual([]);
    expect(rig.live('m')).toBeNull();
    unmarkReloading('m');
    const result = await run.promise;
    expect(result).toEqual({ outcome: 'applied', reason: null, error: null, loaded: true });
    expect(rig.live('m')).toEqual(U_FILES);
  });

  it('a reload that runs for 60 seconds ends the apply "reload" with nothing touched', async () => {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    markReloading('m');
    const t0 = Date.now();
    let clock = t0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const run = track(applyHeld('m', u));
    await polled();
    expect(run.settled()).toBeNull();
    clock = t0 + 60_000;
    await vi.waitFor(() => expect(run.settled()).not.toBeNull(), { timeout: 2000, interval: 5 });
    expect(run.settled()).toEqual({ outcome: 'deferred', reason: 'reload', error: null, loaded: false });
    expect(fakeLoader.loads).toEqual([]);
    expect(rig.live('m')).toBeNull();
    expect(rig.entry('m')).toBeUndefined();
  });

  it('an apply of the module started inside its own apply waits on that apply, not on the start it opened', async () => {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    let nested: ApplyResult | null = null;
    fakeLoader.duringLoad = async module => {
      fakeLoader.duringLoad = null;
      const start = startModule(module, u, '2.0.0', path.join(rig.state.source, module));
      if (typeof start === 'string') throw new Error(start);
      const t0 = Date.now();
      let clock = t0;
      const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
      probe.isReloadingCalls = 0;
      const inner = track(applyModuleChange({ module, to: u, source: 'rows', displaced: 'backups', reason: 'pass', tag: '1:ALPHA', version: '2.0.0', updatedBy: 'BRAVO/p-bravo' }, hold));
      try {
        await vi.waitFor(() => expect(inner.settled() !== null || probe.isReloadingCalls >= 2).toBe(true), { timeout: 2000, interval: 5 });
        clock = t0 + 60_000;
        await vi.waitFor(() => expect(inner.settled()).not.toBeNull(), { timeout: 2000, interval: 5 });
        nested = inner.settled();
      } finally {
        now.mockRestore();
        await endStart(start, 'replaced');
      }
    };
    const outer = await rig.apply('m', u);
    expect(nested).toEqual({ outcome: 'deferred', reason: 'reload', error: null, loaded: false });
    expect(outer).toEqual({ outcome: 'applied', reason: null, error: null, loaded: true });
  });
});

describe('the mutex and the reload counters', () => {
  it('an apply that gets no store mutex ends busy with nothing touched', async () => {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    vi.spyOn(storeMutex, 'acquire').mockResolvedValueOnce(null);
    const result = await rig.apply('m', u);
    expect(result).toEqual({ outcome: 'busy', reason: 'busy', error: null, loaded: false });
    expect(fakeLoader.loads).toEqual([]);
    expect(rig.live('m')).toBeNull();
    expect(rig.entry('m')).toBeUndefined();
  });

  it('an apply counts as a running reload while it loads, and as one started after it ends', async () => {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    const before = getReloadState();
    let during: ReturnType<typeof getReloadState> | null = null;
    fakeLoader.duringLoad = () => { during = getReloadState(); };
    const result = await rig.apply('m', u);
    expect(result.outcome).toBe('applied');
    expect(during).toEqual({ inFlight: before.inFlight + 1, started: before.started + 1 });
    expect(getReloadState()).toEqual({ inFlight: before.inFlight, started: before.started + 1 });
  });
});

describe('the incoming version', () => {
  it('a staged folder whose content is not the row sha is not taken: the rows are fetched', async () => {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rl4-stage-'));
    temps.push(stage);
    const staged = rig.writeTree(path.join(stage, 'm'), S_FILES);
    const result = await rig.apply('m', u, { source: staged });
    expect(result.outcome).toBe('applied');
    expect(rig.live('m')).toEqual(U_FILES);
    expect(rig.readTree(staged)).toEqual(S_FILES);
  });

  it('a change whose source is the rows never takes a folder named rows in the working directory', async () => {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rl4-cwd-'));
    temps.push(cwd);
    const rows = rig.writeTree(path.join(cwd, 'rows'), U_FILES);
    const before = process.cwd();
    let result: ApplyResult;
    process.chdir(cwd);
    try {
      result = await rig.apply('m', u);
    } finally {
      process.chdir(before);
    }
    expect(result.outcome).toBe('applied');
    expect(rig.live('m')).toEqual(U_FILES);
    expect(rig.readTree(rows)).toEqual(U_FILES);
  });

  it('rows that changed after the change was read end "changed": no folder is swapped and the fetched copy is removed', async () => {
    const s = await rig.publish('m', S_FILES, '1.0.0');
    await rig.publish('m', U_FILES, '2.0.0');
    const result = await rig.apply('m', s);
    expect(result).toEqual({ outcome: 'deferred', reason: 'changed', error: null, loaded: false });
    expect(fakeLoader.loads).toEqual([]);
    expect(rig.live('m')).toBeNull();
    expect(fs.readdirSync(rig.state.source)).toEqual([]);
    expect(rig.entry('m')).toBeUndefined();
  });

  it('a fetch that fails before it wrote a file ends "fetch" with its cause', async () => {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    vi.spyOn(rig.state.pg.backend, 'sharedRead').mockResolvedValueOnce({ kind: 'failed', step: 'statements', detail: 'the database did not answer' } as any);
    const result = await rig.apply('m', u);
    expect(result).toEqual({ outcome: 'deferred', reason: 'fetch', error: 'the database did not answer', loaded: false });
    expect(fs.readdirSync(rig.state.source)).toEqual([]);
    expect(rig.entry('m')).toBeUndefined();
  });
});

describe('the intent the swap records', () => {
  it('a first install records from absent, no backup and the backups place while it loads', async () => {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    let applying: unknown = 'unread';
    fakeLoader.duringLoad = module => { applying = rig.entry(module)?.applying; };
    const result = await rig.apply('m', u);
    expect(result.outcome).toBe('applied');
    expect(applying).toEqual({ from: 'absent', to: u, backup: null, displaced: 'backups', tag: '1:ALPHA', version: '2.0.0', updatedBy: 'BRAVO/p-bravo' });
  });

  it('a switch that supersedes the version in place logs where the folder went and that the rows version is back', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    rig.state.lines.length = 0;
    const result = await rig.apply('m', u, { displaced: 'superseded' });
    expect(result.outcome).toBe('applied');
    const live = path.join(rig.state.source, 'm');
    const lines = shared();
    expect(lines).toHaveLength(1);
    const prefix = `[Shared] Moved ${live} to `;
    expect(lines[0].startsWith(prefix)).toBe(true);
    const dest = lines[0].slice(prefix.length, lines[0].indexOf(': it held'));
    expect(dest.startsWith(dataPath('_superseded'))).toBe(true);
    expect(lines[0]).toBe(`${prefix}${dest}: it held the version this machine took from the database before the switch to ALPHA (generation 1); the database's version is back in its place`);
  });

  it('a removal records no version and no updatedBy, whatever the change carried', async () => {
    const s = await rig.inPlace('m', S_FILES);
    let applying: unknown = 'unread';
    const unload = reloaderFakes.unloadModuleUnmarked;
    reloaderFakes.unloadModuleUnmarked = async (client, module) => {
      applying = rig.entry(module)?.applying;
      return unload(client, module);
    };
    let result: ApplyResult;
    try {
      result = await rig.apply('m', 'absent', { version: '1.0.0', updatedBy: 'BRAVO/p-bravo' });
    } finally {
      reloaderFakes.unloadModuleUnmarked = unload;
    }
    expect(result.outcome).toBe('applied');
    expect(applying).toEqual({ from: s, to: 'absent', backup: expect.stringMatching(/m-\d+$/), displaced: 'backups', tag: '1:ALPHA', version: null, updatedBy: null });
  });
});
