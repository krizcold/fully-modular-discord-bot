import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB19 row 72 and case 40, the callers the web UI routes leave: the panel's update of every module, its update
// everything and the auto-updater's tick. The real AppStoreManager updates the module, and installed.json's folder
// chain fails, so each caller gets an updated entry with listUnconfirmed (T9) from the real update.

const h = vi.hoisted(() => ({
  fail: new Map<string, { kind: 'sync' | 'open' | 'earlier'; errno: string }>(),
  first: null as null | { dir: string; errno: string },
  reloads: [] as string[][],
  stamps: [] as unknown[][],
  shown: [] as unknown[],
  systemUpdates: 0,
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolderChainSync: (dir: string) => {
      const at = path.resolve(dir);
      if (h.first && real.folderSyncFailed()) return { failed: true, kind: 'earlier', dir: h.first.dir, errno: h.first.errno, error: null };
      const f = h.fail.get(at);
      if (!f) return real.syncFolderChainSync(dir);
      if (f.kind === 'sync') {
        real.noteFolderSyncFailure(at, f.errno);
        h.first ??= { dir: at, errno: f.errno };
      }
      return { failed: true, kind: f.kind, dir: at, errno: f.errno, error: null };
    },
  };
});

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const fsReal = await vi.importActual<any>('fs');
  const execSync = (cmd: string, opts: any = {}) => {
    if (cmd.startsWith('git rev-parse HEAD')) return Buffer.from(fsReal.readFileSync(path.join(opts.cwd, '.git', 'HEAD_HASH'), 'utf-8'));
    if (cmd.startsWith('git remote set-url') || cmd.startsWith('git fetch')) return Buffer.from('');
    throw new Error(`unexpected command in test: ${cmd.split(' ').slice(0, 2).join(' ')}`);
  };
  return { ...real, execSync, default: { ...real, execSync } };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => {} }));

vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => {
  const real = await orig<any>();
  const root = process.env.DATA_DIR as string;
  return {
    ...real,
    getModulesDir: () => path.join(root, 'runtime-modules'),
    getSourceModulesDir: () => path.join(root, 'appstore-modules'),
    getBuildModulesDir: () => path.join(root, 'build-modules'),
    getModulesDevDir: () => path.join(root, 'modulesDev'),
  };
});

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', () => ({
  reloadModule: async (_client: unknown, module: string) => ({ success: true, moduleName: module, duration: 1 }),
  reloadModules: async (_client: unknown, modules: string[]) => {
    h.reloads.push([...modules]);
    return { success: true, reloaded: [...modules], failed: [], totalDuration: 1 };
  },
}));

vi.mock('../../src/bot/internalSetup/utils/botManagerAPI', async orig => ({
  ...(await orig<object>()),
  requestSystemUpdate: async () => {
    h.systemUpdates += 1;
    return { success: true };
  },
  checkForAllBotUpdates: async () => ({
    success: true,
    lastChecked: '2026-11-10T00:00:00.000Z',
    baseCode: { checked: true, hasUpdates: false },
    modules: { checked: true, hasUpdates: false, totalInstalled: 1, updatesAvailable: 0, updates: [], errors: [] },
    summary: { totalUpdatesAvailable: 0, hasAnyUpdates: false },
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/panel/persistentPanelStorage', async orig => ({
  ...(await orig<object>()),
  updatePersistentPanelState: async (...args: unknown[]) => { h.stamps.push(args); return true; },
}));
vi.mock('../../src/bot/internalSetup/utils/panel/persistentPanelResponse', async orig => ({
  ...(await orig<object>()),
  updatePanelDynamic: async (_context: unknown, _panel: unknown, response: unknown) => { h.shown.push(response); return true; },
}));

import { dataPath } from '../../src/utils/dataRoot';
import { syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { getAppStoreManager } from '../../src/bot/internalSetup/utils/appStoreManager';
import { startModuleAutoUpdater, stopModuleAutoUpdater } from '../../src/bot/internalSetup/utils/moduleAutoUpdater';
import updateManagerPanel from '../../src/bot/internalSetup/panels/updateManager';

const STORE = dataPath('global', 'appstore');
const INSTALLED = path.join(STORE, 'installed.json');
const CLONE = path.join(STORE, 'cache', 'official-modules');
const SOURCE = dataPath('appstore-modules');

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function publish(name: string, version: string): void {
  write(path.join(CLONE, 'Modules', name, 'module.json'), JSON.stringify({ name, version }));
  write(path.join(CLONE, 'Modules', name, 'index.ts'), 'export {};');
  write(path.join(CLONE, '.git', 'HEAD_HASH'), 'a'.repeat(40));
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const T1 = (kind: 'sync' | 'earlier' = 'earlier', file = INSTALLED) => {
  const { why, next } = syncWords(kind, path.resolve(STORE), 'EIO');
  return `${file} is written, but ${why}, so can't confirm it is stored. ${next}`;
};
const T11_SYNC = () => `[AppStoreManager] Repository Official Module Store is updated, but the repository list can't be confirmed as saved: ${T1('sync', path.join(STORE, 'repos.json'))}`;
const T9_SHAPE = () => new RegExp(`^Module alpha is updated, but the list of installed modules can't be confirmed as saved: ${escape(T1())} Its backup is kept at (.+alpha-\\d+)\\.$`);

/** Every string in a panel response, so a text is found whatever its builder nests it in. */
function texts(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') {
    const plain = typeof (value as { toJSON?: unknown }).toJSON === 'function' ? (value as { toJSON: () => unknown }).toJSON() : value;
    for (const v of Object.values(plain as object)) texts(v, out);
  }
  return out;
}

let errors: string[];
let warns: string[];
let logs: string[];
beforeEach(async () => {
  h.fail.clear();
  h.first = null;
  h.reloads.length = 0;
  h.stamps.length = 0;
  h.shown.length = 0;
  h.systemUpdates = 0;
  errors = [];
  warns = [];
  logs = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  for (const dir of [STORE, SOURCE, dataPath('build-modules'), dataPath('runtime-modules')]) fs.rmSync(dir, { recursive: true, force: true });
  publish('alpha', '1.0.0');
  const manager = getAppStoreManager();
  await new Promise(resolve => setTimeout(resolve, 50));
  await manager.installModule('alpha', 'official-modules');
  publish('alpha', '1.1.0');
  h.fail.set(path.resolve(STORE), { kind: 'sync', errno: 'EIO' });
});
afterEach(() => {
  stopModuleAutoUpdater();
  vi.restoreAllMocks();
});

/** The new version's files and entry are kept, and the backup T9 names is on disk. */
function newVersionKept(t9: string): void {
  const backup = T9_SHAPE().exec(t9)![1];
  expect(fs.existsSync(path.join(backup, 'module.json'))).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(SOURCE, 'alpha', 'module.json'), 'utf8')).version).toBe('1.1.0');
  expect(JSON.parse(fs.readFileSync(INSTALLED, 'utf8')).modules.alpha.version).toBe('1.1.0');
}

describe('row 72: the panel\'s update of every module', () => {
  const press = (client: unknown, button: string) => updateManagerPanel.handleButton!({
    client, interaction: { message: { id: `p-${Math.random()}` } }, panelId: 'update_manager', userId: 'u1', guildId: 'g1',
    accessMethod: 'direct_command', navigationStack: [],
  } as never, button);
  const settled = (state: string) => vi.waitFor(() => { if (!h.stamps.some(s => s[1] === state)) throw new Error('not settled'); }, { timeout: 20_000, interval: 10 });
  const panelWarns = () => warns.filter(l => l.startsWith('[UpdateManagerPanel] '));

  it('with a client: the module is reloaded, then T9 is logged with its backup path', async () => {
    await press({}, 'update_modules');
    await settled('modules_updated');
    expect(h.reloads).toEqual([['alpha']]);
    const t9 = panelWarns().map(l => l.slice('[UpdateManagerPanel] '.length)).filter(l => T9_SHAPE().test(l));
    expect(t9, warns.join('\n')).toHaveLength(1);
    newVersionKept(t9[0]);
    expect([...logs, ...warns, ...errors].some(l => l.includes('Failed to update'))).toBe(false);
  });

  it('the refresh\'s repos.json save meets the EIO first, so T9 quotes it as earlier', async () => {
    await press({}, 'update_modules');
    await settled('modules_updated');
    expect(errors.filter(l => l === T11_SYNC())).toHaveLength(1);
    const t9 = panelWarns().find(l => T9_SHAPE().test(l.slice('[UpdateManagerPanel] '.length)));
    expect(t9).toContain('no folder sync is trusted since the disk did not confirm the sync of');
    expect(t9).not.toContain(`${INSTALLED} is written, but the disk did not confirm`);
  });

  it('with a client: no Hot-reloaded line for the module whose list is unconfirmed', async () => {
    await press({}, 'update_modules');
    await settled('modules_updated');
    expect(logs.filter(l => l.startsWith('[UpdateManagerPanel] Hot-reloaded'))).toEqual([]);
  });

  it('with no client: T9 is logged', async () => {
    await press(null, 'update_modules');
    await settled('modules_updated');
    expect(h.reloads).toEqual([]);
    const t9 = panelWarns().map(l => l.slice('[UpdateManagerPanel] '.length)).filter(l => T9_SHAPE().test(l));
    expect(t9).toHaveLength(1);
    newVersionKept(t9[0]);
  });
});

describe('row 72 and case 40: update everything', () => {
  it('logs and shows describeBulkModuleUpdate\'s text ending with T9, then requests the system update', async () => {
    await updateManagerPanel.handleButton!({
      client: {}, interaction: { message: { id: `p-${Math.random()}` } }, panelId: 'update_manager', userId: 'u1', guildId: 'g1',
      accessMethod: 'direct_command', navigationStack: [],
    } as never, 'update_everything');
    await vi.waitFor(() => { if (!h.stamps.some(s => s[1] === 'update_triggered')) throw new Error('not settled'); }, { timeout: 20_000, interval: 10 });
    expect(h.systemUpdates).toBe(1);
    const bulk = new RegExp(`^\\[UpdateManagerPanel\\] Updated 1 module\\(s\\)\\. (Module alpha is updated, .+)$`);
    const line = warns.map(l => bulk.exec(l)).find(Boolean);
    expect(line, warns.join('\n')).toBeTruthy();
    const t9 = line![1];
    expect(T9_SHAPE().test(t9)).toBe(true);
    newVersionKept(t9);
    const shown = h.shown.flatMap(r => texts(r)).join('\n');
    expect(shown).toContain(`Updated 1 module(s). ${t9} The Bot Manager is pulling`);
    expect(shown).not.toContain('module(s) updated.');
    expect(logs.some(l => l.includes('before system update'))).toBe(false);
  });
});

describe('row 72: the auto-updater\'s tick', () => {
  async function tick(): Promise<void> {
    write(path.join(STORE, 'config.json'), JSON.stringify({ autoUpdate: true }));
    let run: (() => void) | null = null;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { run = fn; return 0 as never; }) as never);
    startModuleAutoUpdater({} as never);
    expect(run).not.toBeNull();
    run!();
    await vi.waitFor(() => { if (!warns.some(l => l.startsWith('[ModuleAutoUpdater] Module alpha'))) throw new Error('no T9 yet'); }, { timeout: 20_000, interval: 10 });
  }

  it('reloads the module, then logs T9 with its backup path', async () => {
    await tick();
    expect(h.reloads).toEqual([['alpha']]);
    const t9 = warns.filter(l => l.startsWith('[ModuleAutoUpdater] ')).map(l => l.slice('[ModuleAutoUpdater] '.length)).filter(l => T9_SHAPE().test(l));
    expect(t9, warns.join('\n')).toHaveLength(1);
    newVersionKept(t9[0]);
    expect(errors.some(l => l.includes('Error during auto-update check'))).toBe(false);
  });

  it('no Hot-reloaded line for the module whose list is unconfirmed', async () => {
    await tick();
    expect(logs.filter(l => l.startsWith('[ModuleAutoUpdater] Hot-reloaded'))).toEqual([]);
  });
});
