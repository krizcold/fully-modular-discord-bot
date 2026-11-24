import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB46 rows 6 and 7 (wip-redesign/notes/NB46-cause.md): the end of a spare's boot starts in moduleCrashes.ts, and a
// reload by the web UI's IPC on a spare (moduleReloader.ts's reloadModule) with the fakes of rm5Reloader.test.ts.

const h = vi.hoisted(() => ({
  modules: new Map<string, any>(),
  manifests: [] as string[],
}));

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const exec = (_command: string, _options: unknown, callback: (error: unknown, stdout?: string, stderr?: string) => void) => callback(null, '', '');
  return { ...real, exec, default: { ...real, exec } };
});
vi.mock('../../src/bot/internalSetup/utils/moduleRegistry', () => ({
  getModuleRegistry: () => ({
    getModule: (name: string) => h.modules.get(name),
    register: (module: any) => { h.modules.set(module.manifest.name, module); },
    unloadModule: async (name: string) => { h.modules.delete(name); return true; },
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/moduleLoader', () => ({
  hotLoadRefusal: () => null,
  ModuleLoader: class {
    async loadModule(manifest: any, modulePath: string) {
      return { manifest, path: modulePath, commands: [], events: new Map(), panels: [] };
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
vi.mock('../../src/bot/internalSetup/utils/metrics/metricsCollector', () => ({ getMetricsCollector: () => ({ dropModule: () => undefined }) }));
vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => ({
  ...(await orig<any>()),
  findModuleManifests: () => h.manifests,
  getBuildRoot: () => path.join(process.env.DATA_DIR as string, 'nb46-no-build'),
}));

import { dataPath } from '../../src/utils/dataRoot';
import { storeRecordPath } from '../../src/bot/internalSetup/utils/sharedRecords';
import { clearLoadFailures } from '../../src/bot/internalSetup/utils/loadFailures';
import {
  _resetModuleCrashes, crashFilePath, endStart, endUnservedBootStarts, handToBootTurn, openStarts, startModule, startStateOf,
} from '../../src/bot/internalSetup/utils/moduleCrashes';
import { reloadModule, reloadRefusedText } from '../../src/bot/internalSetup/utils/moduleReloader';

const client = {} as any;
const SHA = 'a'.repeat(64);

function manifestOf(name: string): void {
  const file = dataPath('nb46mods', name, 'module.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ name, displayName: name, version: '1.0.0' }));
  h.manifests.push(file);
}

function bootStart(name: string) {
  const start = startModule(name, SHA, '1.0.0', dataPath('nb46mods', name), { boot: true });
  if (typeof start === 'string') throw new Error(start);
  handToBootTurn(start);
  return start;
}

function writeCrashLine(module: string, sha: string): void {
  fs.mkdirSync(path.dirname(crashFilePath()), { recursive: true });
  fs.writeFileSync(crashFilePath(), JSON.stringify({ [module]: { sha, n: 1, version: '1.0.0', error: 'boom', at: '2026-11-24T00:00:00.000Z' } }));
}

const crashLines = (): Record<string, { sha: string; n: number }> =>
  fs.existsSync(crashFilePath()) ? JSON.parse(fs.readFileSync(crashFilePath(), 'utf8')) : {};

beforeEach(() => {
  h.modules.clear();
  h.manifests.length = 0;
  _resetModuleCrashes();
  clearLoadFailures();
  fs.rmSync(storeRecordPath(), { force: true });
  fs.rmSync(crashFilePath(), { force: true });
  for (const level of ['log', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  _resetModuleCrashes();
  fs.rmSync(storeRecordPath(), { force: true });
  fs.rmSync(crashFilePath(), { force: true });
});

describe('row 6: a reload by IPC on a spare', () => {
  it("answers success after the boot's end, not T31 (c)", async () => {
    manifestOf('m');
    h.modules.set('m', { manifest: { name: 'm', displayName: 'm', version: '1.0.0' }, commands: [], events: new Map(), panels: [] });
    bootStart('m');
    expect(startStateOf('m')).toBe('c');
    await endUnservedBootStarts(0);
    const result = await reloadModule(client, 'm');
    expect(result.error).not.toBe(reloadRefusedText('m', 'c'));
    expect(result).toMatchObject({ success: true, moduleName: 'm' });
    expect(openStarts.has('m')).toBe(false);
  });
});

describe("row 7: a start ended 'unserved'", () => {
  it("keeps the crash line of the start's sha; 'ok' deletes it", async () => {
    writeCrashLine('m', SHA);
    const unserved = startModule('m', SHA, '1.0.0', dataPath('nb46mods', 'm'), { boot: true });
    if (typeof unserved === 'string') throw new Error(unserved);
    await endStart(unserved, 'unserved');
    expect(openStarts.has('m')).toBe(false);
    expect(crashLines().m).toMatchObject({ sha: SHA, n: 1 });

    const ok = startModule('m', SHA, '1.0.0', dataPath('nb46mods', 'm'), { boot: true });
    if (typeof ok === 'string') throw new Error(ok);
    await endStart(ok, 'ok');
    expect(crashLines().m).toBeUndefined();
  });
});
