import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 63 (wip-redesign/sheets/NB6.md decisions 87 and 89, T24's boot form and 98's T28): a module version held
// back on this machine and the orphan sweep. The held entry comes from the real count and the real boot rule; the boot
// loop is the real ModuleLoader with `onModuleCode`; registerCommands runs over the fakes of c09-3.test.ts. Rows 313
// and 314.

const h = vi.hoisted(() => {
  process.env.GUILD_ID = 'g-test';
  return { manifests: [] as string[] };
});

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => [] }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  loadGlobalData: () => ({ guildId: 'g-test' }),
  saveGlobalData: () => true,
}));
vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => ({
  ...(await orig<any>()),
  findModuleManifests: () => h.manifests,
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { dataPath } from '../../src/utils/dataRoot';
import registerCommands from '../../src/bot/internalSetup/events/clientReady/registerCommands';
import { clearLoadFailures, getHeldBack, getLoadFailures, recordHeldBack, recordLoadFailure } from '../../src/bot/internalSetup/utils/loadFailures';
import { ModuleLoader } from '../../src/bot/internalSetup/utils/moduleLoader';
import { getModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';
import {
  _resetModuleCrashes, applyBootRule, closeWindow, countCrash, onModuleCode, openStarts, openWindow, startModule,
} from '../../src/bot/internalSetup/utils/moduleCrashes';
import { writeStoreRecord, type ModuleEntry } from '../../src/bot/internalSetup/utils/sharedRecords';

const CRASH_FILE = dataPath('global', 'appstore', 'cache', 'module-crashes.json');
const T24_BOOT = (module: string, version: string) =>
  `[ModuleLoader] ${module} ${version} was not loaded: this machine holds it back after the bot stopped twice while it was starting it (see the App Store tab)`;

let tmp: string;
let errors: string[];
let warns: string[];

function setAutoCleanup(on: boolean): void {
  const file = dataPath('global', 'appstore', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ autoCleanup: on }));
}

function setInstalled(names: string[]): void {
  const file = dataPath('global', 'appstore', 'installed.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ modules: Object.fromEntries(names.map(n => [n, { name: n }])) }));
}

function fakeClient(globalNames: string[]) {
  const deleted: string[] = [];
  const commands = {
    fetch: vi.fn(async (opts?: any) => {
      const m = new Map<string, any>();
      if (!opts?.guildId) for (const n of globalNames) m.set(n, { id: n, name: n, type: 1 });
      return m;
    }),
    create: vi.fn(async () => ({})),
    edit: vi.fn(async () => ({})),
    delete: vi.fn(async (id: string) => { deleted.push(id); }),
  };
  const client: any = { application: { commands }, guilds: { cache: new Map() } };
  return { client, deleted };
}

/** A module folder with its module.json, listed for the boot loop. */
function placed(name: string, version: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'module.json');
  fs.writeFileSync(manifest, JSON.stringify({ name, version, displayName: name, description: 'd', author: 'a', category: 'misc' }));
  h.manifests.push(manifest);
  return dir;
}

function entryOf(sha: string): ModuleEntry {
  return { sha, stamp: null, files: {}, main: null, built: { sha, buildId: null }, failedSha: null, retryAt: null };
}

/** Two stops counted against the version in place, then the boot rule: the entry gets `heldSha`. */
function heldInPlace(name: string, sha: string, version: string): void {
  for (const message of ['first stop', 'second stop']) {
    const start = startModule(name, sha, version, path.join(tmp, name));
    if (typeof start === 'string') throw new Error(start);
    openWindow(start);
    countCrash(new Error(message));
    closeWindow(start);
    openStarts.delete(name);
  }
  applyBootRule();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb6held-'));
  h.manifests = [];
  errors = [];
  warns = [];
  _resetModuleCrashes();
  clearLoadFailures();
  fs.rmSync(CRASH_FILE, { force: true });
  writeStoreRecord({ docs: {}, modules: {} });
  setAutoCleanup(true);
  setInstalled([]);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(ModuleLoader.prototype, 'loadModule').mockImplementation(async (m: any, p: string) => ({
    manifest: m, path: p, commands: [], events: new Map(), panels: [], exports: new Map(), initialized: false, importedFiles: [],
  }) as any);
});

afterEach(async () => {
  for (const name of getModuleRegistry().getAllModules().map(m => m.manifest.name)) await getModuleRegistry().unloadModule(name);
  _resetModuleCrashes();
  clearLoadFailures();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the boot loop skips a held version (87, 89)', () => {
  it('313: a held module at boot is not loaded, is recorded held back with T24, and the sweep is skipped with T28\'s held note', async () => {
    placed('held', '1.0.0');
    placed('plain', '1.0.0');
    writeStoreRecord({ docs: {}, modules: { held: entryOf('S1') } });
    heldInPlace('held', 'S1', '1.0.0');
    setInstalled(['held', 'plain']);
    recordHeldBack('left from a boot before');

    const loaded = await new ModuleLoader({} as any, { onModuleCode }).loadAllModules();

    expect(loaded.map(m => m.manifest.name)).toEqual(['plain']);
    expect((ModuleLoader.prototype.loadModule as any).mock.calls.map((c: any[]) => c[0].name)).toEqual(['plain']);
    expect(getHeldBack()).toEqual(['held']);
    expect(getLoadFailures()).toEqual([]);
    expect(errors).toContain(T24_BOOT('held', '1.0.0'));

    const { client, deleted } = fakeClient(['orphan-cmd']);
    const result = await registerCommands(client);
    expect(deleted).toEqual([]);
    expect(result).toEqual({
      sweep: 'skipped', deleted: 0, failed: 0,
      note: 'orphan sweep skipped: these modules are held back on this machine until they are updated, or uninstalled and installed again: held',
    });
    expect(warns).toContain('[Cleanup] Orphan command sweep skipped; their commands would be deleted. Held back on this machine until updated, or uninstalled and installed again: held');
  });

  it("a skip for an open start ('starting') records nothing held back and logs no T24", async () => {
    placed('busy', '1.0.0');
    writeStoreRecord({ docs: {}, modules: { busy: entryOf('B1') } });
    const open = startModule('busy', 'B1', '1.0.0', path.join(tmp, 'busy'));
    if (typeof open === 'string') throw new Error(open);

    const loaded = await new ModuleLoader({} as any, { onModuleCode }).loadAllModules();

    expect(loaded).toEqual([]);
    expect(getHeldBack()).toEqual([]);
    expect(errors.filter(e => e.includes('holds it back'))).toEqual([]);
    openStarts.delete('busy');
  });

  it('clearLoadFailures clears the held set too, and the sweep then runs', async () => {
    recordHeldBack('held');
    clearLoadFailures();
    expect(getHeldBack()).toEqual([]);
    const { client, deleted } = fakeClient(['orphan-cmd']);
    expect(await registerCommands(client)).toEqual({ sweep: 'done', deleted: 1, failed: 0 });
    expect(deleted).toEqual(['orphan-cmd']);
  });
});

describe("the sweep's notes (98's T28)", () => {
  it('314: a held module and a load failure: the note and the reason name both lists', async () => {
    recordHeldBack('held-a');
    recordHeldBack('held-b');
    recordLoadFailure('broken');
    const { client, deleted } = fakeClient(['orphan-cmd']);
    const result = await registerCommands(client);
    expect(deleted).toEqual([]);
    expect(result).toEqual({
      sweep: 'skipped', deleted: 0, failed: 0,
      note: 'orphan sweep skipped: these modules did not load, lack a dependency or could not be read (until the bot restarts): broken; these are held back on this machine until they are updated, or uninstalled and installed again: held-a, held-b',
    });
    expect(warns).toContain('[Cleanup] Orphan command sweep skipped; their commands would be deleted. Did not load, lack a dependency or could not be read: broken Held back until updated, or uninstalled and installed again: held-a, held-b');
  });

  it('load failures only: the two texts as before', async () => {
    recordLoadFailure('broken');
    const { client } = fakeClient(['orphan-cmd']);
    const result = await registerCommands(client);
    expect(result?.note).toBe('orphan sweep skipped until the bot restarts: these modules did not load, lack a dependency or could not be read: broken');
    expect(warns).toContain('[Cleanup] Orphan command sweep skipped; their commands would be deleted. Did not load, lack a dependency or could not be read: broken');
  });
});
