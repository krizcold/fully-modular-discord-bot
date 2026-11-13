import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// moduleReloader.ts: a reload refused for an unfinished change (T31 f), and the initializer turn of a live load
// (decisions 67, 78, 99): the turn's begin, which returns are awaited, the failure record, the window, the log of a
// late rejection, and the timers the turn leaves behind. Fake modules from ModuleLoader.loadModule; tsc's exec answered
// at once.

const h = vi.hoisted(() => ({
  manifests: [] as string[],
  initialize: [] as Array<() => unknown>,
  state: undefined as undefined | 'f',
  applyOf: null as null | { from: string; to: string; version: string | null },
  tscRuns: 0,
}));

vi.mock('child_process', async orig => {
  const real = await orig<typeof import('child_process')>();
  const exec = (command: string, _options: unknown, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
    if (command.includes('tsc')) h.tscRuns += 1;
    callback(null, '', '');
  };
  return { ...real, exec, default: { ...real, exec } };
});
vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => ({
  ...(await orig<any>()),
  getBuildRoot: () => 'Z:/rm4-no-build-root',
  findModuleManifests: () => h.manifests,
}));
vi.mock('../../src/bot/internalSetup/utils/commandUtils', async orig => ({ ...(await orig<any>()), reRegisterSlashCommands: async () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcToggleHandler', async orig => ({ ...(await orig<any>()), applyComponentToggleState: async () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/settings/settingsDiscovery', async orig => ({ ...(await orig<any>()), getModulesWithSettings: () => [] }));
vi.mock('../../src/bot/internalSetup/utils/moduleCrashes', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/moduleCrashes')>();
  return {
    ...real,
    startStateOf: (module: string) => (h.state !== undefined ? h.state : real.startStateOf(module)),
    applyOfStart: (start: import('../../src/bot/internalSetup/utils/moduleCrashes').ModuleStart) => h.applyOf ?? real.applyOfStart(start),
  };
});

import fs from 'fs';
import path from 'path';
import type { Client } from 'discord.js';
import { ModuleLoader } from '../../src/bot/internalSetup/utils/moduleLoader';
import { getModuleRegistry, resetModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';
import { loadModuleUnmarked, reloadModule } from '../../src/bot/internalSetup/utils/moduleReloader';
import { _resetModuleCrashes, openStarts, startFailureOf, starting, type ModuleStart } from '../../src/bot/internalSetup/utils/moduleCrashes';
import { clearLoadFailures, getLoadFailures } from '../../src/bot/internalSetup/utils/loadFailures';

const client = { options: { intents: 0 } } as unknown as Client;
const INIT_FAILED = '[Reloader] Command initialize failed for m:';

function placeModule(): void {
  const dir = path.join(process.env.DATA_DIR!, 'rm4mods', 'm');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'module.json');
  fs.writeFileSync(manifest, JSON.stringify({ name: 'm', version: '1.0.0', displayName: 'm', description: 'a test module', author: 'a', category: 'misc' }));
  h.manifests = [manifest];
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let errors: unknown[][] = [];
let logs: string[] = [];
let onLog: (line: string) => void = () => undefined;

beforeEach(() => {
  h.manifests = [];
  h.initialize = [];
  h.state = undefined;
  h.applyOf = null;
  h.tscRuns = 0;
  errors = [];
  logs = [];
  onLog = () => undefined;
  _resetModuleCrashes();
  clearLoadFailures();
  resetModuleRegistry();
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(' ');
    logs.push(line);
    onLog(line);
  });
  vi.spyOn(ModuleLoader.prototype, 'loadModule').mockImplementation(async (manifest: any, modulePath: string) => ({
    manifest, path: modulePath, events: new Map(), panels: [], exports: new Map(), initialized: false, importedFiles: [],
    commands: h.initialize.map((initialize, i) => ({ name: `m-cmd${i}`, initialize })),
  }) as any);
  placeModule();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const name of getModuleRegistry().getAllModules().map(m => m.manifest.name)) await getModuleRegistry().unloadModule(name);
  resetModuleRegistry();
  _resetModuleCrashes();
  clearLoadFailures();
  vi.restoreAllMocks();
});

const initFailedLines = () => errors.filter(args => args[0] === INIT_FAILED);

describe('a reload while the module\'s last change is still being finished (T31 f)', () => {
  it('is refused with T31 (f) before any compile', async () => {
    h.state = 'f';
    const out = await reloadModule(client, 'm');
    expect(out).toEqual({ success: false, moduleName: 'm', error: 'm was not reloaded: this machine is still finishing its last change of m. Try again in a few minutes.' });
    expect(h.tscRuns).toBe(0);
  });
});

describe('the initializer turn of a live load', () => {
  it('begins at the first initializer and keeps that time for the ones after it', async () => {
    let t = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 1000));
    const seen: Array<number | null | undefined> = [];
    h.initialize = [() => { seen.push(openStarts.get('m')?.turnAt); }, () => { seen.push(openStarts.get('m')?.turnAt); }];
    const out = await loadModuleUnmarked(client, 'm');
    expect(out.success).toBe(true);
    expect(typeof seen[0]).toBe('number');
    expect(seen[1]).toBe(seen[0]);
    expect(out.start?.turnAt).toBe(seen[0]);
  });

  it('an initializer that returns nothing logs no failure and records none', async () => {
    h.initialize = [() => undefined];
    const out = await loadModuleUnmarked(client, 'm');
    expect(out.success).toBe(true);
    expect(initFailedLines()).toEqual([]);
    expect(getLoadFailures()).toEqual([]);
    expect(startFailureOf('m')).toBeUndefined();
  });

  it('a return whose then cannot be read is the initializer\'s own throw: logged, and the start ends with no failure', async () => {
    const thrown = new Error('then exploded');
    h.initialize = [() => ({ get then() { throw thrown; } })];
    const out = await loadModuleUnmarked(client, 'm');
    expect(out.success).toBe(true);
    expect(initFailedLines()).toEqual([[INIT_FAILED, thrown]]);
    expect(getLoadFailures()).toEqual([]);
    expect(startFailureOf('m')).toBeUndefined();
    expect(openStarts.has('m')).toBe(false);
  });

  it('a promise that rejects within 60 s: logged, recorded as the module\'s load failure, the start ended with it', async () => {
    const thrown = new Error('init gave up');
    h.initialize = [() => Promise.reject(thrown)];
    const out = await loadModuleUnmarked(client, 'm');
    expect(out.success).toBe(true);
    expect(initFailedLines()).toEqual([[INIT_FAILED, thrown]]);
    expect(getLoadFailures()).toEqual(['m']);
    expect(startFailureOf('m')).toBe('init gave up');
  });

  it('a turn that settles within 60 s leaves no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h.initialize = [() => Promise.resolve()];
    expect(vi.getTimerCount()).toBe(0);
    const out = await loadModuleUnmarked(client, 'm');
    expect(out.success).toBe(true);
    expect(openStarts.has('m')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a turn past 60 s', () => {
  async function late(): Promise<{ pending: ReturnType<typeof deferred<void>>; start: ModuleStart }> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = deferred();
    let start: ModuleStart | undefined;
    h.initialize = [() => { start = openStarts.get('m'); return pending.promise; }];
    const run = loadModuleUnmarked(client, 'm');
    await vi.advanceTimersByTimeAsync(60_001);
    const out = await run;
    expect(out).toMatchObject({ success: true, late: true });
    expect(start).toBeDefined();
    return { pending, start: start! };
  }

  async function ended(): Promise<void> {
    await vi.waitFor(() => expect(openStarts.has('m')).toBe(false), { timeout: 2000, interval: 2 });
  }

  it('closes the start\'s window before the reload logs its end', async () => {
    let windowOpenAtEnd: boolean | undefined;
    let current: ModuleStart | undefined;
    onLog = line => {
      if (line.startsWith('[Reloader] Reloaded: ')) windowOpenAtEnd = current ? starting.has(current) : undefined;
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = deferred();
    h.initialize = [() => { current = openStarts.get('m'); return pending.promise; }];
    const run = loadModuleUnmarked(client, 'm');
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await run).toMatchObject({ success: true, late: true });
    expect(windowOpenAtEnd).toBe(false);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await ended();
  });

  it('settling before 10 minutes ends the start and leaves no timer behind', async () => {
    const { pending } = await late();
    pending.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await ended();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a late rejection of a load that is no apply logs the initializer failure', async () => {
    const { pending } = await late();
    const thrown = new Error('late failure');
    pending.reject(thrown);
    await vi.advanceTimersByTimeAsync(10);
    await ended();
    expect(initFailedLines()).toEqual([[INIT_FAILED, thrown]]);
    expect(startFailureOf('m')).toBe('late failure');
  });

  it('a late rejection of an apply\'s start leaves the log to the apply', async () => {
    h.applyOf = { from: 'sha-s', to: 'sha-u', version: '1.0.0' };
    const { pending } = await late();
    pending.reject(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(10);
    await ended();
    expect(initFailedLines()).toEqual([]);
    expect(startFailureOf('m')).toBe('late failure');
  });
});
