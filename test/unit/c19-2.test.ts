import fs from 'fs';
import vm from 'vm';
import { transformSync } from '@babel/core';
import presetReact from '@babel/preset-react';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { GatewayIntentBits } from 'discord.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ manifests: [] as string[], devDir: '', loads: [] as string[], running: new Set<string>(), unloads: [] as string[], onCompile: null as null | (() => void), loaded: [] as any[] }));

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  const exec = (_command: string, ...rest: unknown[]) => {
    const callback = rest.find(arg => typeof arg === 'function') as ((e: null, out: string, err: string) => void) | undefined;
    state.onCompile?.();
    callback?.(null, '', '');
  };
  (exec as unknown as Record<symbol, unknown>)[promisify.custom] = async () => (state.onCompile?.(), { stdout: '', stderr: '' });
  return { ...actual, exec, default: { ...actual, exec } };
});

vi.mock('@internal/utils/pathHelpers', async importOriginal => {
  const actual = await importOriginal<typeof import('@internal/utils/pathHelpers')>();
  return {
    ...actual,
    findModuleManifests: () => state.manifests,
    getModulesDevDir: () => state.devDir,
    getBuildRoot: () => path.join(os.tmpdir(), 'smdb-c19-2-no-build-root'),
  };
});

vi.mock('@internal/utils/commandUtils', () => ({ reRegisterSlashCommands: async () => {} }));
vi.mock('@internal/utils/ipcToggleHandler', () => ({ applyComponentToggleState: async () => {} }));
vi.mock('@internal/events/clientReady/registerCommands', () => ({ isAutoCleanupEnabled: () => false }));
vi.mock('@internal/utils/settings/settingsDiscovery', () => ({ clearSchemaCache: () => {}, getModulesWithSettings: () => [] }));
vi.mock('@internal/utils/settings/settingsPanelFactory', () => ({ createAllSettingsPanels: () => [] }));
vi.mock('@internal/utils/metrics/metricsCollector', () => ({ getMetricsCollector: () => ({ dropModule: () => {} }) }));
vi.mock('@internal/utils/panelManager', () => ({ getPanelManager: () => ({ registerPanel: () => {} }) }));
vi.mock('@internal/utils/moduleEventManager', () => ({ getModuleEventManager: () => ({ registerListener: () => {} }) }));
vi.mock('@internal/utils/appStoreManager', () => ({
  getAppStoreManager: () => ({ isModuleInstalled: () => false, installModule: async () => {}, saveCredentials: () => {} }),
}));
vi.mock('@internal/utils/moduleRegistry', () => ({
  getModuleRegistry: () => ({
    getModule: (n: string) => (state.running.has(n) ? { manifest: { name: n }, commands: [] } : undefined),
    register: () => {},
    unloadModule: async (n: string) => { state.unloads.push(n); state.running.delete(n); },
  }),
}));

import { ModuleLoader } from '@internal/utils/moduleLoader';
import { reloadModule, reloadModules } from '@internal/utils/moduleReloader';
import { scanDevModules } from '@webui/routes/devmodules';

vi.spyOn(ModuleLoader.prototype, 'loadModule').mockImplementation(async (manifest: any, modulePath: string) => {
  state.loads.push(manifest.name);
  state.loaded.push(manifest);
  return { manifest, path: modulePath, commands: [], events: new Map(), panels: [], hooks: {} } as any;
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-c19-2-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function writeModule(dir: string, fields: Record<string, unknown>): string {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    version: '1.0.0', displayName: 'X', description: 'd', author: 'a', category: 'fun', ...fields,
  };
  fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify(manifest));
  return path.join(dir, 'module.json');
}

const client = (intents: number[]) => ({ options: { intents } }) as any;

beforeEach(() => {
  state.manifests = [];
  state.loads = [];
  state.unloads = [];
  state.onCompile = null;
  state.loaded = [];
  state.running = new Set();
  state.devDir = path.join(root, 'none');
});

describe('hot-load passes the boot gates', () => {
  it('refuses a module whose intent the session did not request', async () => {
    state.manifests = [writeModule(path.join(root, 'modules', 'halloffame'), { name: 'halloffame', requiredIntents: ['Guilds', 'MessageContent'] })];
    const res = await reloadModule(client([GatewayIntentBits.Guilds]), 'halloffame');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/MessageContent gateway intent this session did not request; restart the bot/);
    expect(res.error).toMatch(/privileged/);
    expect(state.loads).toEqual([]);
  });

  it('loads it when the session has the intent', async () => {
    state.manifests = [writeModule(path.join(root, 'modules', 'halloffame2'), { name: 'halloffame2', requiredIntents: ['Guilds', 'MessageContent'] })];
    const res = await reloadModule(client([GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent]), 'halloffame2');
    expect(res.success).toBe(true);
    expect(state.loads).toEqual(['halloffame2']);
  });

  it('refuses a camelCase name and an enabled:false manifest', async () => {
    state.manifests = [
      writeModule(path.join(root, 'modules', 'camel'), { name: 'myModule' }),
      writeModule(path.join(root, 'modules', 'off'), { name: 'off-mod', enabled: false }),
    ];
    const camel = await reloadModule(client([]), 'myModule');
    expect(camel.success).toBe(false);
    expect(camel.error).toMatch(/kebab-case/);
    const bulk = await reloadModules(client([]), ['off-mod']);
    expect(bulk.success).toBe(false);
    expect(bulk.reloaded).toEqual([]);
    expect(bulk.failed[0].error).toMatch(/disabled/);
    expect(state.loads).toEqual([]);
  });

  it('refuses a name with two manifests', async () => {
    state.manifests = [
      writeModule(path.join(root, 'modules', 'twin'), { name: 'twin' }),
      writeModule(path.join(root, 'modulesDev', 'repo', 'Modules', 'twin'), { name: 'twin' }),
    ];
    const res = await reloadModule(client([]), 'twin');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Two modules are named "twin"/);
    expect(state.loads).toEqual([]);
  });
});

describe('a refused reload leaves the running module loaded', () => {
  it('reloadModules does not unload a module whose new manifest is refused', async () => {
    state.manifests = [
      writeModule(path.join(root, 'modules', 'keep'), { name: 'keep-mod', requiredIntents: ['MessageContent'] }),
      writeModule(path.join(root, 'modules', 'fine'), { name: 'fine-mod' }),
    ];
    state.running = new Set(['keep-mod', 'fine-mod']);
    const bulk = await reloadModules(client([]), ['keep-mod', 'fine-mod']);
    expect(bulk.failed.map(f => f.moduleName)).toEqual(['keep-mod']);
    expect(bulk.reloaded).toEqual(['fine-mod']);
    expect(state.unloads).toEqual(['fine-mod']);
    expect(state.running.has('keep-mod')).toBe(true);
  });
});

describe('reloadModules gates the manifest the compile produced', () => {
  it('loads a module whose manifest appears only after the compile', async () => {
    const dir = path.join(root, 'dist', 'fresh');
    state.onCompile = () => { state.manifests = [writeModule(dir, { name: 'fresh-mod' })]; };
    const bulk = await reloadModules(client([]), ['fresh-mod']);
    expect(bulk.failed).toEqual([]);
    expect(bulk.reloaded).toEqual(['fresh-mod']);
  });

  it('refuses a new intent the compile brought and keeps the running copy', async () => {
    const dir = path.join(root, 'dist', 'grow');
    state.manifests = [writeModule(dir, { name: 'grow-mod' })];
    state.running = new Set(['grow-mod']);
    state.onCompile = () => { writeModule(dir, { name: 'grow-mod', version: '2.0.0', requiredIntents: ['MessageContent'] }); };
    const bulk = await reloadModules(client([]), ['grow-mod']);
    expect(bulk.failed[0].error).toMatch(/MessageContent/);
    expect(state.unloads).toEqual([]);
    expect(state.loads).toEqual([]);
    expect(state.running.has('grow-mod')).toBe(true);
  });

  it('loads the post-compile manifest version', async () => {
    const dir = path.join(root, 'dist', 'bump');
    state.manifests = [writeModule(dir, { name: 'bump-mod' })];
    state.running = new Set(['bump-mod']);
    state.onCompile = () => { writeModule(dir, { name: 'bump-mod', version: '2.0.0' }); };
    const bulk = await reloadModules(client([]), ['bump-mod']);
    expect(bulk.reloaded).toEqual(['bump-mod']);
    expect(state.loaded.map(m => m.version)).toEqual(['2.0.0']);
  });
});

describe('an install the bot refuses to hot-load says why', () => {
  it('carries the refusal text into the job', async () => {
    const { InstallQueue } = await import('../../src/webui/utils/installQueue');
    const queue = new InstallQueue();
    queue.setBotManager({ loadModule: async () => ({ success: false, error: 'Module is disabled (enabled: false)' }) } as any);
    const done = new Promise<any>(resolve => { queue.on('completed', resolve); queue.on('failed', resolve); });
    queue.enqueueInstall('c192-store-mod', 'r1');
    const job = await done;
    expect(job.loaded).toBe(false);
    expect(job.loadError).toBe('Module is disabled (enabled: false)');
  });

  it('the toast shows the refusal, and suggests a restart only for an intent refusal', () => {
    const code = transformSync(fs.readFileSync(new URL('../../src/webui/public/components/AppStorePanel.jsx', import.meta.url), 'utf-8'), {
      presets: [[presetReact, { runtime: 'classic' }]], babelrc: false, configFile: false,
    })!.code!;
    const ctx: Record<string, any> = { React: { useState: () => [], useEffect: () => {}, useRef: () => ({}) }, console };
    vm.createContext(ctx);
    vm.runInContext(code, ctx);
    const disabled = ctx.appStoreInstallToast({ moduleName: 'm', loaded: false, loadError: 'Module is disabled (enabled: false)' });
    expect(disabled.text).toContain('Module is disabled (enabled: false)');
    expect(disabled.text).not.toMatch(/Restart the bot to activate/);
    const intent = ctx.appStoreInstallToast({ moduleName: 'm', loaded: false, loadError: 'Needs the MessageContent gateway intent this session did not request; restart the bot to load it.' });
    expect(intent.text).toMatch(/restart the bot/i);
    const unknown = ctx.appStoreInstallToast({ moduleName: 'm', loaded: false });
    expect(unknown.text).toMatch(/could not confirm/i);
    expect(ctx.appStoreInstallToast({ moduleName: 'm', loaded: true }).kind).toBe('success');
  });
});

describe('Dev tab names the copy that runs', () => {
  it('shows SHADOWED with the store copy path, LOADED only for the dev path', () => {
    state.devDir = path.join(root, 'dev', 'modulesDev');
    writeModule(path.join(state.devDir, 'repo', 'Modules', 'shadow'), { name: 'shadow', version: '2.0.0' });
    writeModule(path.join(state.devDir, 'repo', 'Modules', 'mine'), { name: 'mine' });
    const storePath = path.join(root, 'modules', 'shadow');
    const repos = scanDevModules([
      { name: 'shadow', path: storePath, version: '1.0.0' },
      { name: 'mine', path: path.join(state.devDir, 'repo', 'Modules', 'mine'), version: '1.0.0' },
    ]);
    const mods = Object.fromEntries(repos[0].modules.map(m => [m.name, m]));
    expect(mods.shadow.loaded).toBe(false);
    expect(mods.shadow.shadowedBy).toEqual({ path: storePath, version: '1.0.0' });
    expect(mods.mine.loaded).toBe(true);
    expect(mods.mine.shadowedBy).toBeUndefined();
  });
});

describe('an install whose load got no answer does not claim it failed', () => {
  it('botManager.loadModule marks a transport failure unconfirmed', async () => {
    const { BotManager } = await import('../../src/webui/botManager');
    const fake = { sendIPCMessage: async () => { throw new Error('IPC request timed out; the operation may still complete in the background - check bot logs before retrying'); } };
    const res = await (BotManager.prototype as any).loadModule.call(fake, 'm');
    expect(res.success).toBe(false);
    expect(res.unconfirmed).toBe(true);
  });

  it('leaves loadError unset so the toast says it could not confirm', async () => {
    const { InstallQueue } = await import('../../src/webui/utils/installQueue');
    const queue = new InstallQueue();
    queue.setBotManager({ loadModule: async () => ({ success: false, unconfirmed: true, error: 'IPC request timed out; the operation may still complete in the background - check bot logs before retrying' }) } as any);
    const done = new Promise<any>(resolve => { queue.on('completed', resolve); queue.on('failed', resolve); });
    queue.enqueueInstall('c192-store-mod', 'r1');
    const job = await done;
    expect(job.loaded).toBe(false);
    expect(job.loadError).toBeUndefined();
  });
});
