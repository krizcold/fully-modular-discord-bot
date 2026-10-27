import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => (process.env.GUILD_ID = 'g-test', {
  local: [] as any[],
  realLocal: false,
  internalDir: null as null | (() => string[]),
  manifests: [] as string[] | null,
  compile: null as null | ((cb: (err: any, out?: any) => void) => void),
  rereg: async (): Promise<any> => null,
}));

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', async (orig) => {
  const real = await orig<any>();
  return { default: (...a: any[]) => (h.realLocal ? real.default(...a) : h.local) };
});
vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', () => ({ resolveNodeRole: () => 'master' }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async (orig) => ({
  ...(await orig<any>()),
  loadGlobalData: () => ({ guildId: 'g-test' }),
  saveGlobalData: () => true,
}));
vi.mock('../../src/bot/internalSetup/utils/commandUtils', async (orig) => ({
  ...(await orig<any>()),
  reRegisterSlashCommands: () => h.rereg(),
}));
vi.mock('fs', async (orig) => {
  const real = await orig<any>();
  const path = await import('path');
  const internalDir = path.resolve(__dirname, '../../src/bot/internalSetup/commands');
  return {
    ...real,
    readdirSync: (p: any, o?: any) =>
      h.internalDir && path.resolve(String(p)) === internalDir ? h.internalDir() : real.readdirSync(p, o),
  };
});
vi.mock('child_process', async (orig) => ({
  ...(await orig<any>()),
  exec: (_cmd: string, _opts: any, cb: (err: any, out?: any) => void) => {
    if (h.compile) h.compile(cb);
    else cb(Object.assign(new Error('tsc failed'), { stderr: 'tsc failed' }));
  },
}));
vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async (orig) => {
  const real = await orig<any>();
  return {
    ...real,
    findModuleManifests: () => (h.manifests === null ? real.findModuleManifests() : h.manifests),
    getBuildRoot: () => '/nonexistent-build-root-c09-3h',
  };
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { dataPath } from '../../src/utils/dataRoot';
import registerCommands from '../../src/bot/internalSetup/events/clientReady/registerCommands';
import { clearLoadFailures, getLoadFailures, recordLoadFailure } from '../../src/bot/internalSetup/utils/loadFailures';
import { reloadModule, reloadModules } from '../../src/bot/internalSetup/utils/moduleReloader';
import { ModuleLoader } from '../../src/bot/internalSetup/utils/moduleLoader';
import { getModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';
import { findModuleManifests, getModulesDir, getModulesDevDir } from '../../src/bot/internalSetup/utils/pathHelpers';
import { setupReloadIPCHandlers } from '../../src/bot/internalSetup/utils/ipcReloadHandler';

function writeJson(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
}

const setAutoCleanup = (on: boolean) => writeJson(dataPath('global', 'appstore', 'config.json'), { autoCleanup: on });
const setInstalled = (names: string[]) =>
  writeJson(dataPath('global', 'appstore', 'installed.json'), { modules: Object.fromEntries(names.map(n => [n, { name: n }])) });
const setComponents = (config: Record<string, boolean>) => writeJson(dataPath('global', 'appstore', 'component-config.json'), config);

class Coll<V> extends Map<string, V> {
  find(fn: (v: V) => boolean): V | undefined {
    for (const v of this.values()) if (fn(v)) return v;
    return undefined;
  }
}

interface FakeOptions {
  guild?: string[];
  onFetch?: () => Promise<void>;
  onDelete?: (key: string) => void | Promise<void>;
  failDelete?: Set<string>;
}

function fakeClient(globals: string[], opts: FakeOptions = {}) {
  const deleted: string[] = [];
  const commands = {
    fetch: vi.fn(async (o?: any) => {
      const m = new Coll<any>();
      const names = o?.guildId ? opts.guild ?? [] : globals;
      for (const n of names) m.set(n, { id: n, name: n, type: 1 });
      if (!o?.guildId) await opts.onFetch?.();
      return m;
    }),
    create: vi.fn(async () => ({})),
    edit: vi.fn(async () => ({})),
    delete: vi.fn(async (id: string, guildId?: string) => {
      const key = guildId ? `g:${id}` : id;
      if (opts.failDelete?.has(key)) throw Object.assign(new Error('Discord 500'), { code: 0 });
      deleted.push(key);
      await opts.onDelete?.(key);
    }),
  };
  const client: any = { application: { commands }, guilds: { cache: new Map() } };
  return { client, deleted };
}

let finishPending: ((ok: boolean) => void) | undefined;
const pendingReloads: Promise<unknown>[] = [];

function deferredCompile(): void {
  h.compile = (cb) => { finishPending = (ok) => (ok ? cb(null, { stdout: '', stderr: '' }) : cb(Object.assign(new Error('tsc failed'), { stderr: 'tsc failed' }))); };
}

let tmp: string;

beforeEach(() => {
  clearLoadFailures();
  h.local = [];
  h.realLocal = false;
  h.internalDir = null;
  h.manifests = [];
  h.compile = null;
  h.rereg = async () => null;
  setAutoCleanup(true);
  setInstalled([]);
  setComponents({});
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c09-3h-'));
});

afterEach(async () => {
  finishPending?.(false);
  finishPending = undefined;
  await Promise.all(pendingReloads.splice(0));
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a failed reload keeps the sweep off (C09-3h)', () => {
  it('skips the sweep after a bulk reload whose compile failed', async () => {
    const bulk = await reloadModules({} as any, ['bulk-mod']);
    expect(bulk.success).toBe(false);
    const { client, deleted } = fakeClient(['bulk-cmd']);
    const result = await registerCommands(client);
    expect(deleted).toEqual([]);
    expect(result?.sweep).toBe('skipped');
    expect(result?.note).toMatch(/bulk-mod/);
    expect(result?.note).toMatch(/until the bot restarts/);
  });

  it('skips the sweep after a bulk reload whose module has no manifest', async () => {
    h.compile = (cb) => cb(null, { stdout: '', stderr: '' });
    const bulk = await reloadModules({} as any, ['gone-mod']);
    expect(bulk.failed.map(f => f.moduleName)).toEqual(['gone-mod']);
    const { client, deleted } = fakeClient(['gone-cmd']);
    const result = await registerCommands(client);
    expect(deleted).toEqual([]);
    expect(result?.sweep).toBe('skipped');
    expect(result?.note).toMatch(/gone-mod/);
  });
});

describe('no sweep deletes while a module reload runs (C09-3h)', () => {
  it('skips when a reload is in flight as the local commands are read', async () => {
    deferredCompile();
    pendingReloads.push(reloadModules({} as any, ['slow-mod']));
    const { client, deleted } = fakeClient(['slow-cmd', 'other-cmd'], { guild: ['slow-guild'] });
    const result = await registerCommands(client);
    expect(deleted).toEqual([]);
    expect(result?.sweep).toBe('skipped');
    expect(result?.note).toMatch(/module reload was running/);
  });

  it('stops before the next deletion when a reload starts during the sweep', async () => {
    deferredCompile();
    let reload: Promise<unknown> | undefined;
    const { client, deleted } = fakeClient(['a', 'b'], {
      guild: ['ga'],
      onDelete: () => { if (!reload) pendingReloads.push(reload = reloadModule({} as any, 'late-mod')); },
    });
    const result = await registerCommands(client);
    expect(deleted).toEqual(['a']);
    expect(result).toMatchObject({ sweep: 'skipped', deleted: 1, failed: 0 });
    expect(result?.note).toMatch(/skipped after 1 deletion.*module reload was running/);
  });

  it('stops the guild loop when a reload starts during the last global deletion', async () => {
    deferredCompile();
    let reload: Promise<unknown> | undefined;
    const { client, deleted } = fakeClient(['a'], {
      guild: ['ga'],
      onDelete: () => { if (!reload) pendingReloads.push(reload = reloadModule({} as any, 'late-mod')); },
    });
    const result = await registerCommands(client);
    expect(deleted).toEqual(['a']);
    expect(deleted).not.toContain('g:ga');
    expect(result).toMatchObject({ sweep: 'skipped', deleted: 1, failed: 0 });
  });

  it('skips when a reload started and finished between the read and the first deletion', async () => {
    const modDir = path.join(tmp, 'quick-mod');
    writeJson(path.join(modDir, 'module.json'), {
      name: 'quick-mod', version: '1.0.0', displayName: 'Quick', description: 'd', author: 'a', category: 'misc',
    });
    h.manifests = [path.join(modDir, 'module.json')];
    setInstalled(['quick-mod']);
    h.compile = (cb) => cb(null, { stdout: '', stderr: '' });
    let reloaded: any;
    const { client, deleted } = fakeClient(['old-cmd'], {
      onFetch: async () => { reloaded ??= await reloadModule(client, 'quick-mod'); },
    });
    const result = await registerCommands(client);
    expect(reloaded?.success).toBe(true);
    expect(getLoadFailures()).toEqual([]);
    expect(deleted).toEqual([]);
    expect(result?.sweep).toBe('skipped');
    await getModuleRegistry().unloadModule('quick-mod');
  });
});

describe('the loader records its own failures (C09-3h)', () => {
  it('records a validation, a load and a command-file failure, and boot clears them', async () => {
    const mod = (name: string, manifest: any) => {
      writeJson(path.join(tmp, name, 'module.json'), manifest);
      return path.join(tmp, name, 'module.json');
    };
    const base = { version: '1.0.0', displayName: 'X', description: 'd', author: 'a', category: 'misc' };
    const invalid = mod('invalid-mod', { name: 'invalid-mod' });
    const boom = mod('boom-mod', { ...base, name: 'boom-mod' });
    const cmdMod = mod('cmd-mod', { ...base, name: 'cmd-mod' });
    const badCommand = path.join(tmp, 'cmd-mod', 'commands', 'bad.js');
    fs.mkdirSync(path.dirname(badCommand), { recursive: true });
    fs.writeFileSync(badCommand, "throw new Error('broken command file');\n");
    h.manifests = [invalid, boom, cmdMod];
    const realLoad = ModuleLoader.prototype.loadModule;
    vi.spyOn(ModuleLoader.prototype, 'loadModule').mockImplementation(async function (this: any, manifest: any, p: string) {
      if (manifest.name === 'boom-mod') throw new Error('load failed');
      return realLoad.call(this, manifest, p);
    });
    recordLoadFailure('from an earlier boot');

    const loaded = await new ModuleLoader({} as any).loadAllModules();

    const failures = getLoadFailures();
    expect(failures).not.toContain('from an earlier boot');
    expect(failures).toContain('invalid-mod');
    expect(failures).toContain('boom-mod');
    expect(failures).toContain(badCommand);
    expect(loaded.map(m => m.manifest.name)).toEqual(['cmd-mod']);
    await getModuleRegistry().unloadModule('cmd-mod');
  });

  it('skips one module.json it cannot check, records it, and loads the others', async () => {
    h.manifests = null;
    const modulesDir = getModulesDir();
    const devDir = getModulesDevDir();
    const lockedManifest = path.join(modulesDir, 'locked-mod', 'module.json');
    const openManifest = path.join(modulesDir, 'open-mod', 'module.json');
    const dirent = (name: string) => ({ name, isDirectory: () => true });
    const realReaddir = fs.readdirSync;
    const realRead = fs.readFileSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: any, o: any) =>
      p === modulesDir ? [dirent('locked-mod'), dirent('open-mod')] : realReaddir(p, o)) as any);
    vi.spyOn(fs, 'statSync').mockImplementation(((p: any) => {
      if (p === lockedManifest) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      if (p === modulesDir || p === openManifest) return {};
      if (p === devDir) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    }) as any);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, o: any) => p === openManifest
      ? JSON.stringify({ name: 'open-mod', version: '1.0.0', displayName: 'O', description: 'd', author: 'a', category: 'misc' })
      : realRead(p, o)) as any);
    vi.spyOn(ModuleLoader.prototype, 'loadModule').mockImplementation(async (manifest: any, p: string) => ({
      manifest, path: p, commands: [], events: new Map(), panels: [], exports: new Map(), initialized: false, importedFiles: [],
    }) as any);

    expect(findModuleManifests()).toEqual([openManifest]);
    const loaded = await new ModuleLoader({} as any).loadAllModules();

    expect(loaded.map(m => m.manifest.name)).toEqual(['open-mod']);
    expect(getLoadFailures()).toEqual(['locked-mod']);
    vi.restoreAllMocks();
    await getModuleRegistry().unloadModule('open-mod');
  });
});

describe('the command listing records its own failures (C09-3h)', () => {
  it('records an internal command file that throws and skips the sweep', async () => {
    h.realLocal = true;
    h.internalDir = () => ['zz-missing-c09-3h.js', 'zz-missing-c09-3h.ts'];
    const { client, deleted } = fakeClient(['orphan-cmd'], { guild: ['orphan-guild'] });
    const result = await registerCommands(client);
    expect(getLoadFailures().some(f => f.startsWith('zz-missing-c09-3h'))).toBe(true);
    expect(deleted).toEqual([]);
    expect(result?.sweep).toBe('skipped');
  });

  it('records a module command listing that throws and skips the sweep', async () => {
    h.realLocal = true;
    vi.spyOn(getModuleRegistry(), 'getAllModules').mockImplementation(() => { throw new Error('registry broken'); });
    const { client, deleted } = fakeClient(['orphan-cmd'], { guild: ['orphan-guild'] });
    const result = await registerCommands(client);
    expect(getLoadFailures()).toContain('the module command listing');
    expect(deleted).toEqual([]);
    expect(result?.sweep).toBe('skipped');
  });

  it('records an internal command listing that throws and skips the sweep', async () => {
    h.realLocal = true;
    h.internalDir = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    const { client, deleted } = fakeClient(['orphan-cmd'], { guild: ['orphan-guild'] });
    const result = await registerCommands(client);
    expect(getLoadFailures()).toContain('the internal command listing');
    expect(deleted).toEqual([]);
    expect(result?.sweep).toBe('skipped');
  });
});

describe('the guild loop (C09-3h)', () => {
  it('re-reads the switch before each guild deletion', async () => {
    const { client, deleted } = fakeClient([], { guild: ['ga', 'gb'], onDelete: () => setAutoCleanup(false) });
    const result = await registerCommands(client);
    expect(deleted).toEqual(['g:ga']);
    expect(result?.sweep).toBe('stopped');
  });

  it('does not run after the global loop stopped', async () => {
    const { client, deleted } = fakeClient(['a', 'b'], { guild: ['ga'], onDelete: () => setAutoCleanup(false) });
    const result = await registerCommands(client);
    expect(deleted).toEqual(['a']);
    expect(result).toMatchObject({ sweep: 'stopped', deleted: 1 });
  });
});

describe('a delete that throws is counted (C09-3h)', () => {
  it('gives failed 1 and a note instead of a clean done', async () => {
    const { client, deleted } = fakeClient(['bad', 'good'], { failDelete: new Set(['bad']) });
    const result = await registerCommands(client);
    expect(deleted).toEqual(['good']);
    expect(result).toMatchObject({ sweep: 'done', deleted: 1, failed: 1 });
    expect(result?.note).toMatch(/1 command\(s\) could not be deleted.*bot log/);
  });

  it('keeps both counts in a stop note', async () => {
    const { client } = fakeClient(['bad', 'good', 'third'], {
      failDelete: new Set(['bad']),
      onDelete: () => setAutoCleanup(false),
    });
    const result = await registerCommands(client);
    expect(result).toMatchObject({ sweep: 'stopped', deleted: 1, failed: 1 });
    expect(result?.note).toMatch(/stopped after 1 deletion\(s\), 1 failed/);
  });
});

describe('the disabled-command branch reports its deletions (C09-3d)', () => {
  const local = [{ name: 'off-cmd', description: 'd' }, { name: 'off-two', description: 'd' }];

  it('counts what it unregistered', async () => {
    setAutoCleanup(false);
    h.local = local;
    setComponents({ 'mod:command:off-cmd': false, 'mod:command:off-two': false });
    const { client, deleted } = fakeClient(['off-cmd', 'off-two']);
    const result = await registerCommands(client);
    expect(deleted).toEqual(['off-cmd', 'off-two']);
    expect(result).toMatchObject({ deleted: 2, failed: 0 });
  });

  it('counts a failed unregister and says so', async () => {
    setAutoCleanup(false);
    h.local = local;
    setComponents({ 'mod:command:off-cmd': false, 'mod:command:off-two': false });
    const { client, deleted } = fakeClient(['off-cmd', 'off-two'], { failDelete: new Set(['off-cmd']) });
    const result = await registerCommands(client);
    expect(deleted).toEqual(['off-two']);
    expect(result).toMatchObject({ deleted: 1, failed: 1 });
    expect(result?.note).toMatch(/1 disabled command\(s\) could not be unregistered/);
  });
});

describe('commands:reregister answers what registration did (C09-3h)', () => {
  async function ask(): Promise<any> {
    const sent: any[] = [];
    const hadSend = process.send;
    (process as any).send = (m: any) => { sent.push(m); return true; };
    const before = process.listeners('message').length;
    try {
      setupReloadIPCHandlers({} as any);
      process.emit('message' as any, { type: 'commands:reregister', requestId: 'r1', data: {} } as any);
      await vi.waitFor(() => expect(sent.find(m => m.requestId === 'r1')).toBeTruthy());
      return sent.find(m => m.requestId === 'r1').data;
    } finally {
      for (const l of process.listeners('message').slice(before)) process.off('message', l as any);
      (process as any).send = hadSend;
    }
  }

  it('maps a null result to success false', async () => {
    h.rereg = async () => null;
    const data = await ask();
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/not registered/);
  });

  it('passes the note through', async () => {
    h.rereg = async () => ({ sweep: 'skipped', deleted: 0, failed: 0, note: 'orphan sweep skipped: x' });
    expect(await ask()).toEqual({ success: true, note: 'orphan sweep skipped: x' });
  });
});
