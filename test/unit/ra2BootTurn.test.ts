import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// clientInitializer.ts's runInitializers: the handler ids each module's turn files under it (fileNewHandlers), a
// module's boot turn in its start's window (bootTurn: the 60 s and 10 minute bounds, the error lines, how the start
// ends) and the initializers no loaded module owns. Fake modules come from a stubbed ModuleLoader; a boot start is
// opened and handed to the turn as the boot loop does.

const h = vi.hoisted(() => ({ modules: [] as any[], unregistered: [] as any[] }));

vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/utils/envLoader', async orig => ({ ...(await orig<any>()), loadCredentials: () => ({}) }));
vi.mock('../../src/bot/internalSetup/utils/moduleLoader', async orig => {
  const { getModuleRegistry } = await import('../../src/bot/internalSetup/utils/moduleRegistry');
  return {
    ...(await orig<any>()),
    ModuleLoader: class {
      async loadAllModules() {
        for (const m of h.modules) getModuleRegistry().register(m);
        return [...h.modules, ...h.unregistered];
      }
    },
  };
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Client } from 'discord.js';
import { _resetBootModules, loadModules, registerModuleComponents, runInitializers } from '../../src/bot/internalSetup/clientInitializer';
import { resetModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';
import {
  _resetModuleCrashes, handToBootTurn, openStarts, startFailureOf, starting, startModule, type ModuleStart,
} from '../../src/bot/internalSetup/utils/moduleCrashes';
import { storeRecordPath, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';

type Cmd = { name?: string; initialize: (client: any) => unknown };

const LINE = (name: string) => `[Initializer] Error running initialize function for module: ${name}`;

function fakeModule(name: string, cmds: Cmd[]) {
  return {
    manifest: { name, version: '1.0.0', displayName: name, description: 'a test module', author: 'a', category: 'misc' },
    path: `/modules/${name}`, events: new Map(), panels: [], exports: new Map(), initialized: false, importedFiles: [],
    commands: cmds,
  } as any;
}

function newClient(): any {
  return {
    options: { intents: 0 }, on: () => undefined,
    buttonHandlers: new Map(), modalHandlers: new Map(), dropdownHandlers: new Map(), reactionHandlers: new Map(), reactionRemoveHandlers: new Map(),
  };
}

async function prepare(client: any, modules: any[], unregistered: any[] = []): Promise<void> {
  h.modules = modules;
  h.unregistered = unregistered;
  await loadModules(client as Client);
  registerModuleComponents(client as Client);
}

/** The boot loop's start of a module, handed to its initializer turn. */
function hand(name: string, opts: { sha?: string; boot?: boolean } = {}): ModuleStart {
  const dir = path.join(os.tmpdir(), 'ra2-modules', name);
  const start = startModule(name, opts.sha ?? null, '1.0.0', dir, opts.boot === false ? undefined : { boot: true });
  if (typeof start === 'string') throw new Error(`the start answered ${start}`);
  handToBootTurn(start);
  return start;
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise(resolve => setImmediate(resolve));
  if (!cond()) throw new Error(`${what} did not happen`);
}

let errors: MockInstance<typeof console.error>;
let warns: MockInstance<typeof console.warn>;
const errorLines = (): string[] => errors.mock.calls.map(c => String(c[0]));
const warnLines = (): string[] => warns.mock.calls.map(c => String(c[0]));

beforeEach(() => {
  resetModuleRegistry();
  _resetBootModules();
  _resetModuleCrashes();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetModuleRegistry();
  _resetBootModules();
  _resetModuleCrashes();
  fs.rmSync(storeRecordPath(), { force: true });
});

describe('the handler ids a module turn files', () => {
  it('files exactly the new ids of every kind under a module that had none, and names every info', async () => {
    const client = newClient();
    const infos: Record<string, any> = {};
    const mod = fakeModule('alpha', [{
      name: 'alpha-cmd',
      initialize: (c: any) => {
        for (const kind of ['buttonHandlers', 'modalHandlers', 'dropdownHandlers', 'reactionHandlers']) {
          infos[kind] = { label: kind };
          c[kind].set(`new-${kind}`, infos[kind]);
        }
        infos.reactionRemoveHandlers = [{ label: 'rr-1' }, { label: 'rr-2' }];
        c.reactionRemoveHandlers.set('new-reactionRemoveHandlers', infos.reactionRemoveHandlers);
      },
    }]);
    await prepare(client, [mod]);
    await runInitializers(client as Client);
    expect(mod.registeredInteractionIds).toEqual({
      buttons: ['new-buttonHandlers'], modals: ['new-modalHandlers'], dropdowns: ['new-dropdownHandlers'],
    });
    expect(mod.registeredReactionIds).toEqual({ reactions: ['new-reactionHandlers'], reactionRemoves: ['new-reactionRemoveHandlers'] });
    for (const kind of ['buttonHandlers', 'modalHandlers', 'dropdownHandlers', 'reactionHandlers']) expect(infos[kind]._moduleName, kind).toBe('alpha');
    expect(infos.reactionRemoveHandlers.map((i: any) => i._moduleName)).toEqual(['alpha', 'alpha']);
  });

  it('a new reaction-remove id with no infos is filed and the turn completes with no error', async () => {
    const client = newClient();
    const mod = fakeModule('beta', [{ name: 'beta-cmd', initialize: (c: any) => { c.reactionRemoveHandlers.set('rr-empty', undefined); } }]);
    await prepare(client, [mod]);
    await expect(runInitializers(client as Client)).resolves.toBeUndefined();
    expect(mod.registeredReactionIds).toEqual({ reactions: [], reactionRemoves: ['rr-empty'] });
    expect(errorLines()).toEqual([]);
  });
});

describe('a module boot turn', () => {
  it('a module with no initializer ends its start at once, opens no window and files nothing', async () => {
    const client = newClient();
    const mod = fakeModule('empty', []);
    await prepare(client, [mod]);
    const start = hand('empty');
    const run = runInitializers(client as Client);
    expect(starting.has(start)).toBe(false);
    expect(openStarts.has('empty')).toBe(false);
    await run;
    expect(mod.registeredInteractionIds).toBeUndefined();
    expect(mod.registeredReactionIds).toBeUndefined();
    expect(startFailureOf(start)).toBeUndefined();
  });

  it('the 10 minute bound counts from the first initializer, however long the first one took', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
    vi.setSystemTime(T0);
    const client = newClient();
    const first = deferred();
    const second = deferred();
    const mod = fakeModule('slow', [
      { name: 'slow-a', initialize: () => { vi.setSystemTime(T0 + 120_000); return first.promise; } },
      { name: 'slow-b', initialize: () => second.promise },
    ]);
    await prepare(client, [mod]);
    hand('slow');
    const run = runInitializers(client as Client);
    await vi.advanceTimersByTimeAsync(60_000);
    await run;
    expect(warnLines().some(l => l.startsWith("[Initializer] slow's initializers did not finish within 60 s"))).toBe(true);
    expect(openStarts.has('slow')).toBe(true);
    await vi.advanceTimersByTimeAsync(420_000);
    expect(warnLines().some(l => l.startsWith("[Initializer] slow's initializers did not finish within 10 minutes"))).toBe(true);
    expect(openStarts.has('slow')).toBe(false);
  });

  it('an initializer that returns nothing logs no error and its start ends ok', async () => {
    const client = newClient();
    await prepare(client, [fakeModule('quiet', [{ name: 'quiet-cmd', initialize: () => undefined }])]);
    const start = hand('quiet');
    await runInitializers(client as Client);
    expect(errorLines()).toEqual([]);
    expect(openStarts.has('quiet')).toBe(false);
    expect(startFailureOf(start)).toBeUndefined();
  });

  it('an answer whose then cannot be read counts as the initializer throwing: logged, and the start ends ok', async () => {
    const client = newClient();
    const answer = { get then(): unknown { throw new Error('then refused'); } };
    await prepare(client, [fakeModule('odd', [{ name: 'odd-cmd', initialize: () => answer }])]);
    const start = hand('odd');
    await runInitializers(client as Client);
    expect(errorLines()).toEqual([LINE('odd-cmd')]);
    expect(String(errors.mock.calls[0][1])).toContain('then refused');
    expect(openStarts.has('odd')).toBe(false);
    expect(startFailureOf(start)).toBeUndefined();
  });

  it("an initializer's throw is logged under the command's name and the start ends ok", async () => {
    const client = newClient();
    const thrown = new Error('the initializer broke');
    await prepare(client, [fakeModule('brk', [{ name: 'brk-cmd', initialize: () => { throw thrown; } }])]);
    const start = hand('brk');
    await runInitializers(client as Client);
    expect(errors.mock.calls).toEqual([[LINE('brk-cmd'), thrown]]);
    expect(startFailureOf(start)).toBeUndefined();
  });

  it("a nameless command's throw is logged as Unnamed Module", async () => {
    const client = newClient();
    const thrown = new Error('no name broke');
    await prepare(client, [fakeModule('anon', [{ initialize: () => { throw thrown; } }])]);
    hand('anon');
    await runInitializers(client as Client);
    expect(errors.mock.calls).toEqual([[LINE('Unnamed Module'), thrown]]);
  });

  it('a throw while filing the handler ids closes the window, logs the module and ends the start rejected', async () => {
    const client = newClient();
    await prepare(client, [fakeModule('bad', [{ name: 'bad-cmd', initialize: (c: any) => { c.reactionRemoveHandlers.set('rr-bad', {}); } }])]);
    const start = hand('bad');
    await runInitializers(client as Client);
    expect(starting.has(start)).toBe(false);
    expect(errorLines()).toEqual([LINE('bad')]);
    expect(openStarts.has('bad')).toBe(false);
    expect(startFailureOf(start)).toMatch(/not iterable/);
  });

  it("the same throw in an apply's start leaves the line to the apply", async () => {
    const sha = 'a'.repeat(64);
    fs.mkdirSync(path.dirname(storeRecordPath()), { recursive: true });
    writeStoreRecord({
      docs: {},
      modules: { app: { applying: { from: 'absent', to: sha, backup: null, displaced: 'backups', tag: null, version: '1.0.0', updatedBy: null } } as any },
    });
    const client = newClient();
    await prepare(client, [fakeModule('app', [{ name: 'app-cmd', initialize: (c: any) => { c.reactionRemoveHandlers.set('rr-bad', {}); } }])]);
    const start = hand('app', { sha, boot: false });
    await runInitializers(client as Client);
    expect(errorLines().filter(l => l.startsWith('[Initializer]'))).toEqual([]);
    expect(openStarts.has('app')).toBe(false);
    expect(startFailureOf(start)).toMatch(/not iterable/);
  });

  it('initializers that settle within 60 s close the window before the start ends', async () => {
    const client = newClient();
    await prepare(client, [fakeModule('fast', [{ name: 'fast-cmd', initialize: () => Promise.resolve() }])]);
    const start = hand('fast');
    await runInitializers(client as Client);
    expect(openStarts.has('fast')).toBe(false);
    expect(starting.has(start)).toBe(false);
    expect(startFailureOf(start)).toBeUndefined();
  });

  it('initializers that settle within 60 s leave no 60 s timer behind', async () => {
    const client = newClient();
    await prepare(client, [fakeModule('tidy', [{ name: 'tidy-cmd', initialize: () => Promise.resolve() }])]);
    hand('tidy');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await runInitializers(client as Client);
    expect(openStarts.has('tidy')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('initializers that settle after 60 s and within 10 minutes end the start ok and leave no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const client = newClient();
    const pending = deferred();
    await prepare(client, [fakeModule('late', [{ name: 'late-cmd', initialize: () => pending.promise }])]);
    const start = hand('late');
    const run = runInitializers(client as Client);
    await vi.advanceTimersByTimeAsync(60_000);
    await run;
    expect(vi.getTimerCount()).toBe(1);
    pending.resolve();
    await until(() => !openStarts.has('late'), 'the late start ending');
    expect(startFailureOf(start)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a late rejection whose reason cannot be made text: the start's end fails and says so", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const client = newClient();
    const pending = deferred();
    await prepare(client, [fakeModule('wry', [{ name: 'wry-cmd', initialize: () => pending.promise }])]);
    hand('wry');
    const run = runInitializers(client as Client);
    await vi.advanceTimersByTimeAsync(60_000);
    await run;
    pending.reject(Object.create(null));
    const ended = () => errorLines().some(l => l.startsWith('[Error] wry: finishing its start failed ('));
    await until(() => errorLines().includes(LINE('wry-cmd')), 'the rejection line');
    await until(ended, 'the T33 line');
    expect(ended()).toBe(true);
  });
});

describe('an initializer no loaded module owns', () => {
  it("its throw is logged under the command's name and the others still run", async () => {
    const client = newClient();
    const thrown = new Error('loose broke');
    const ran: string[] = [];
    const loose = fakeModule('loose', [{ name: 'loose-cmd', initialize: () => { throw thrown; } }]);
    const owned = fakeModule('owned', [{ name: 'owned-cmd', initialize: () => { ran.push('owned'); } }]);
    await prepare(client, [owned], [loose]);
    await runInitializers(client as Client);
    expect(errors.mock.calls).toEqual([[LINE('loose-cmd'), thrown]]);
    expect(ran).toEqual(['owned']);
  });
});
