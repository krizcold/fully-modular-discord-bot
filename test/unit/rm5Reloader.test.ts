import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// moduleReloader.ts's single load, reload, unload and bulk reload with a fake loader, registry and compile, and the
// real start bookkeeping (moduleCrashes) and load failure list.

const h = vi.hoisted(() => ({
  modules: new Map<string, any>(),
  unloads: [] as string[],
  drops: [] as string[],
  unloadThrow: null as null | { value: unknown },
  loads: [] as string[],
  load: (async () => { throw new Error('no load set'); }) as (manifest: any, modulePath: string) => Promise<any>,
  compile: ((cb: (error: unknown, stdout?: string, stderr?: string) => void) => cb(null, '', '')) as (cb: (error: unknown, stdout?: string, stderr?: string) => void) => void,
  manifests: [] as string[],
}));

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const exec = (command: string, _options: unknown, callback: (error: unknown, stdout?: string, stderr?: string) => void) => {
    if (command.includes('tsc')) return h.compile(callback);
    callback(null, '', '');
  };
  return { ...real, exec, default: { ...real, exec } };
});
vi.mock('../../src/bot/internalSetup/utils/moduleRegistry', () => ({
  getModuleRegistry: () => ({
    getModule: (name: string) => h.modules.get(name),
    register: (module: any) => { h.modules.set(module.manifest.name, module); },
    unloadModule: async (name: string) => {
      h.unloads.push(name);
      if (h.unloadThrow) throw h.unloadThrow.value;
      h.modules.delete(name);
      return true;
    },
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/moduleLoader', () => ({
  hotLoadRefusal: () => null,
  ModuleLoader: class {
    loadModule(manifest: any, modulePath: string) {
      h.loads.push(manifest.name);
      return h.load(manifest, modulePath);
    }
  },
}));
vi.mock('../../src/bot/internalSetup/utils/moduleEventManager', () => ({ getModuleEventManager: () => ({ registerListener: () => undefined }) }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', () => ({ getPanelManager: () => ({ registerPanel: () => undefined }) }));
vi.mock('../../src/bot/internalSetup/utils/ipcToggleHandler', () => ({ applyComponentToggleState: async () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/commandUtils', () => ({ reRegisterSlashCommands: async () => undefined }));
vi.mock('../../src/bot/internalSetup/events/clientReady/registerCommands', () => ({ isAutoCleanupEnabled: () => false }));
vi.mock('../../src/bot/internalSetup/utils/settings/settingsDiscovery', () => ({ clearSchemaCache: () => undefined, getModulesWithSettings: () => [] }));
vi.mock('../../src/bot/internalSetup/utils/settings/settingsPanelFactory', () => ({ createAllSettingsPanels: () => [] }));
vi.mock('../../src/bot/internalSetup/utils/clientApplication', () => ({ resolveClientApplication: async () => null }));
vi.mock('../../src/bot/internalSetup/utils/metrics/metricsCollector', () => ({ getMetricsCollector: () => ({ dropModule: (name: string) => { h.drops.push(name); } }) }));
vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => ({
  ...(await orig<any>()),
  findModuleManifests: () => h.manifests,
  getBuildRoot: () => path.join(process.env.DATA_DIR as string, 'rm5-no-build'),
}));

import { dataPath } from '../../src/utils/dataRoot';
import { storeRecordPath } from '../../src/bot/internalSetup/utils/sharedRecords';
import { clearLoadFailures, getLoadFailures } from '../../src/bot/internalSetup/utils/loadFailures';
import {
  _resetModuleCrashes, lateStarts, openStarts, startFailureOf, starting, startModule,
} from '../../src/bot/internalSetup/utils/moduleCrashes';
import {
  isReloading, loadModuleUnmarked, markReloading, reloadModule, reloadModules, reloadRefusedText, unloadModuleFromMemory, unmarkReloading,
} from '../../src/bot/internalSetup/utils/moduleReloader';

const client = {} as any;
const SMALL = 60_000;
const INITIALIZER_WAIT = 60_000;

function manifestOf(name: string): void {
  const file = dataPath('rm5mods', name, 'module.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ name, displayName: name, version: '1.0.0' }));
  h.manifests.push(file);
}

function fakeModule(name: string, initialize?: () => unknown): any {
  return {
    manifest: { name, displayName: name, version: '1.0.0' },
    path: dataPath('rm5mods', name),
    commands: initialize ? [{ name: `${name}-cmd`, initialize }] : [],
    events: new Map(),
    panels: [],
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Lets microtasks and I/O run until a fake timer is scheduled, so the advance that follows reaches it. */
async function untilTimer(): Promise<void> {
  for (let i = 0; i < 200 && vi.getTimerCount() === 0; i++) await new Promise(r => setImmediate(r));
  expect(vi.getTimerCount()).toBeGreaterThan(0);
}

let logs: string[];
let errors: string[];
let throwOnLog: ((line: string) => boolean) | null;
let throwOnError: ((line: string) => boolean) | null;
beforeEach(() => {
  h.modules.clear();
  h.unloads.length = 0;
  h.drops.length = 0;
  h.unloadThrow = null;
  h.loads.length = 0;
  h.manifests.length = 0;
  h.load = async manifest => fakeModule(manifest.name);
  h.compile = cb => cb(null, '', '');
  _resetModuleCrashes();
  clearLoadFailures();
  fs.rmSync(storeRecordPath(), { force: true });
  logs = [];
  errors = [];
  throwOnLog = null;
  throwOnError = null;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (throwOnLog?.(line)) throw new Error('stdout is closed');
    logs.push(line);
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (throwOnError?.(line)) throw new Error('stderr is closed');
    errors.push(line);
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  unmarkReloading('m');
  _resetModuleCrashes();
  fs.rmSync(storeRecordPath(), { force: true });
});

describe('loadModuleUnmarked', () => {
  it('a first load: Loaded line with its real time, a small duration, no unload and no metrics dropped', async () => {
    manifestOf('m');
    const result = await loadModuleUnmarked(client, 'm');
    expect(result).toMatchObject({ success: true, moduleName: 'm', late: false });
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(SMALL);
    const line = logs.map(l => /^\[Reloader\] Loaded: m \((\d+)ms\)$/.exec(l)).find(Boolean);
    expect(line, logs.join('\n')).toBeTruthy();
    expect(Number(line![1])).toBeLessThan(SMALL);
    expect(h.unloads).toEqual([]);
    expect(h.drops).toEqual([]);
    expect(h.modules.get('m')).toBeDefined();
  });

  it('a reload of a loaded module: the old copy is unloaded and its metrics dropped', async () => {
    manifestOf('m');
    const old = fakeModule('m');
    h.modules.set('m', old);
    const result = await loadModuleUnmarked(client, 'm');
    expect(result.success).toBe(true);
    expect(h.unloads).toEqual(['m']);
    expect(h.drops).toEqual(['m']);
    expect(h.modules.get('m')).not.toBe(old);
    expect(logs.some(l => /^\[Reloader\] Reloaded: m \(\d+ms\)$/.test(l))).toBe(true);
  });

  it('no manifest: the answer names it with a small duration and the load failure is recorded', async () => {
    const result = await loadModuleUnmarked(client, 'm');
    expect(result).toEqual({ success: false, moduleName: 'm', error: 'Module manifest not found', duration: expect.any(Number) });
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(SMALL);
    expect(getLoadFailures()).toContain('m');
  });

  it('an open start of the module refuses the load with T31 (d) and a small duration', async () => {
    manifestOf('m');
    const open = startModule('m', 'sha-open', '1.0.0', dataPath('rm5mods', 'm'));
    expect(typeof open).toBe('object');
    const result = await loadModuleUnmarked(client, 'm');
    expect(result).toEqual({ success: false, moduleName: 'm', error: reloadRefusedText('m', 'd'), duration: expect.any(Number), refused: 'starting' });
    expect(result.duration).toBeLessThan(SMALL);
    expect(h.loads).toEqual([]);
  });

  it('a load that throws undefined: answered as a failure, the start ended with "the load did not finish"', async () => {
    manifestOf('m');
    h.load = async () => { throw undefined; };
    const result = await loadModuleUnmarked(client, 'm');
    expect(result).toMatchObject({ success: false, moduleName: 'm', error: 'undefined', late: false });
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(SMALL);
    expect(openStarts.has('m')).toBe(false);
    expect(startFailureOf('m')).toBe('the load did not finish');
  });

  it('a late initializer whose rejection cannot be logged: T33 is logged and the bot goes on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    manifestOf('m');
    const pending = deferred();
    h.load = async manifest => fakeModule(manifest.name, () => pending.promise);
    const loading = loadModuleUnmarked(client, 'm');
    await untilTimer();
    await vi.advanceTimersByTimeAsync(INITIALIZER_WAIT + 1);
    const result = await loading;
    expect(result).toMatchObject({ success: true, late: true });
    throwOnError = line => line.startsWith('[Reloader] Command initialize failed for m:');
    pending.reject(new Error('late failure'));
    const t33 = '[Error] m: finishing its start failed (stderr is closed)';
    for (let i = 0; i < 200 && !errors.includes(t33); i++) await new Promise(r => setImmediate(r));
    expect(errors).toContain(t33);
  });
});

describe('reloadModule', () => {
  it('a module already marked as reloading is refused', async () => {
    markReloading('m');
    expect(await reloadModule(client, 'm')).toEqual({ success: false, moduleName: 'm', error: 'Module is already being reloaded' });
  });

  it('the mark is held while the compile runs: a second reload is refused, then the first succeeds', async () => {
    manifestOf('m');
    let held: ((error: unknown, stdout?: string, stderr?: string) => void) | null = null;
    h.compile = cb => { held = cb; };
    const first = reloadModule(client, 'm');
    for (let i = 0; i < 200 && !held; i++) await new Promise(r => setImmediate(r));
    expect(held).not.toBeNull();
    expect(isReloading('m')).toBe(true);
    expect(await reloadModule(client, 'm')).toEqual({ success: false, moduleName: 'm', error: 'Module is already being reloaded' });
    held!(null, '', '');
    const result = await first;
    expect(result.success).toBe(true);
    expect(isReloading('m')).toBe(false);
  });

  it('a failed compile: refused with its stderr, the failure recorded, nothing loaded', async () => {
    manifestOf('m');
    h.compile = cb => cb(Object.assign(new Error('Command failed: tsc'), { stdout: '', stderr: 'tsc ran out of memory' }));
    const result = await reloadModule(client, 'm');
    expect(result).toEqual({ success: false, moduleName: 'm', error: 'Compilation failed: tsc ran out of memory', duration: expect.any(Number) });
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(SMALL);
    expect(getLoadFailures()).toContain('m');
    expect(h.loads).toEqual([]);
    expect(h.modules.has('m')).toBe(false);
  });

  it('a successful reload answers no error field and a small duration', async () => {
    manifestOf('m');
    const result = await reloadModule(client, 'm');
    expect(result.success).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result, 'error')).toBe(false);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(SMALL);
  });
});

describe('unloadModuleFromMemory', () => {
  it('a module not being reloaded and not loaded: success', async () => {
    expect(await unloadModuleFromMemory(client, 'm')).toEqual({ success: true, moduleName: 'm', duration: 0 });
  });

  it('a module being reloaded is refused and kept loaded', async () => {
    h.modules.set('m', fakeModule('m'));
    markReloading('m');
    expect(await unloadModuleFromMemory(client, 'm')).toEqual({ success: false, moduleName: 'm', error: 'Module is currently being reloaded' });
    expect(h.unloads).toEqual([]);
    expect(h.drops).toEqual([]);
    expect(h.modules.has('m')).toBe(true);
  });
});

describe('reloadModules', () => {
  it('a module whose last change is unfinished is refused with T31 (f) and not loaded', async () => {
    manifestOf('m');
    fs.mkdirSync(path.dirname(storeRecordPath()), { recursive: true });
    fs.writeFileSync(storeRecordPath(), JSON.stringify({ docs: {}, modules: { m: { sha: 's1', applying: { from: 's1', to: 's2', version: '2.0.0' } } } }));
    const result = await reloadModules(client, ['m']);
    expect(result.reloaded).toEqual([]);
    expect(result.failed).toEqual([{ moduleName: 'm', error: reloadRefusedText('m', 'f') }]);
    expect(h.loads).toEqual([]);
  });

  it("the module's load runs inside its start's window", async () => {
    manifestOf('m');
    let seen: string[] = [];
    h.load = async manifest => {
      seen = [...starting].map(s => s.module);
      return fakeModule(manifest.name);
    };
    const result = await reloadModules(client, ['m']);
    expect(result.reloaded).toEqual(['m']);
    expect(seen).toEqual(['m']);
  });

  it("a load that throws: the start ends with the load's own error", async () => {
    manifestOf('m');
    h.load = async () => { throw new Error('the module file is broken'); };
    const result = await reloadModules(client, ['m']);
    expect(result.failed).toEqual([{ moduleName: 'm', error: 'the module file is broken' }]);
    expect(openStarts.has('m')).toBe(false);
    expect(startFailureOf('m')).toBe('the module file is broken');
  });

  it('a throw after the start went late leaves the start to its late task', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    manifestOf('m');
    const pending = deferred();
    h.load = async manifest => fakeModule(manifest.name, () => pending.promise);
    throwOnLog = line => line.startsWith('[Reloader] Reloaded: m v');
    const running = reloadModules(client, ['m']);
    await untilTimer();
    await vi.advanceTimersByTimeAsync(INITIALIZER_WAIT + 1);
    const result = await running;
    expect(result.failed).toEqual([{ moduleName: 'm', error: 'stdout is closed' }]);
    expect(lateStarts().map(s => s.module)).toEqual(['m']);
    expect(startFailureOf('m')).toBeUndefined();
    pending.resolve();
    for (let i = 0; i < 200 && openStarts.has('m'); i++) await new Promise(r => setImmediate(r));
    expect(openStarts.has('m')).toBe(false);
    expect(startFailureOf('m')).toBeUndefined();
  });

  it('an unload that throws undefined: the run rejects and the start ends with "the load did not finish"', async () => {
    manifestOf('m');
    h.modules.set('m', fakeModule('m'));
    h.unloadThrow = { value: undefined };
    let rejected = false;
    let reason: unknown = 'none';
    try {
      await reloadModules(client, ['m']);
    } catch (error) {
      rejected = true;
      reason = error;
    }
    expect(rejected).toBe(true);
    expect(reason).toBeUndefined();
    expect(openStarts.has('m')).toBe(false);
    expect(startFailureOf('m')).toBe('the load did not finish');
    expect(isReloading('m')).toBe(false);
  });
});
