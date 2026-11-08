import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 49, the bot callers' rows (wip-redesign/sheets/NB6.md decisions 15, 44, 61 and 91, T7, T9, T18, T30 and T37;
// rows 146 and 221; part 20), and test 9's row 67 (two machines' auto-updaters). The module auto-updater, the update
// panel and updater/index.ts reach the apply only through the real updateModule, which publishes over scripted clients
// that answer as the shared tables do and applies with the fake loader of helpers/nb6FakeLoader.ts. The web UI's
// update routes and the `module:apply` rows are part 26b's.

const h = vi.hoisted(() => ({
  dirs: { source: '', build: '', dist: '', dev: '' },
  manager: null as unknown,
  reloads: [] as Array<string | string[]>,
  stamps: [] as unknown[][],
}));

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const execSync = (cmd: string) => {
    if (cmd.startsWith('git rev-parse HEAD')) return Buffer.from('a'.repeat(40));
    if (cmd.startsWith('git remote set-url') || cmd.startsWith('git fetch')) return Buffer.from('');
    throw new Error(`unexpected command in test: ${cmd.split(' ').slice(0, 2).join(' ')}`);
  };
  return { ...real, execSync, default: { ...real, execSync } };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => undefined }));

vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    getSourceModulesDir: () => h.dirs.source,
    getBuildModulesDir: () => h.dirs.build,
    getModulesDir: () => h.dirs.dist,
    getModulesDevDir: () => h.dirs.dev,
  };
});

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return {
    ...real,
    ...reloaderMock,
    reloadModule: async (_client: unknown, module: string) => {
      h.reloads.push(module);
      return { success: true, moduleName: module, duration: 1 };
    },
    reloadModules: async (_client: unknown, modules: string[]) => {
      h.reloads.push([...modules]);
      return { success: true, reloaded: [...modules], failed: [], totalDuration: 1 };
    },
  };
});

// The real moduleReloader reaches the panel through panelManager and this file; without the stub the panel would be
// evaluated inside the reloader's factory and bind the real reloadModule.
vi.mock('../../src/bot/internalSetup/utils/panel/persistentPanelRecovery', () => ({
  recoverPersistentPanels: async () => undefined,
  needsRecovery: async () => false,
  markAllPanelsRecovered: async () => undefined,
}));

vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<any>();
  return { ...real, getAppStoreManager: () => h.manager };
});

vi.mock('../../src/bot/internalSetup/utils/botManagerAPI', async orig => ({
  ...(await orig<object>()),
  checkForAllBotUpdates: async () => ({
    success: true,
    lastChecked: '2026-11-07T00:00:00.000Z',
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
  updatePanelDynamic: async () => true,
}));

import fs from 'fs';
import type { Client } from 'discord.js';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { AppStoreManager } from '../../src/bot/internalSetup/utils/appStoreManager';
import { startModuleAutoUpdater, stopModuleAutoUpdater } from '../../src/bot/internalSetup/utils/moduleAutoUpdater';
import { triggerAllModuleUpdates, triggerModuleUpdate } from '../../src/updater';
import updateManagerPanel from '../../src/bot/internalSetup/panels/updateManager';
import { markLate, startModule } from '../../src/bot/internalSetup/utils/moduleCrashes';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import { setBackendKind } from '../helpers/backendKind';
import { applyRig, moduleShaOfFiles, reloaderFakes } from '../helpers/nb6ApplyRig';
import { lost } from '../helpers/sharedRows';
import { updatedBy } from '../../src/bot/internalSetup/utils/sharedStore';

const rig = applyRig();
const REPO = 'r1';
const STORE = dataPath('global', 'appstore');
const V1 = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const V2 = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };
const FAILING = { ...V2, 'fail.txt': 'index.js threw: boom' };
const TAIL = 'The other machines try it when they apply it, and the App Store tab lists each machine where it fails.';

beforeEach(async () => {
  await rig.setup();
  h.dirs = { source: rig.state.source, build: rig.state.build, dist: rig.state.dist, dev: path.join(rig.state.root, 'modulesDev') };
  h.reloads = [];
  h.stamps = [];
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(path.join(STORE, 'repos.json'), JSON.stringify({ repositories: [{ id: REPO, name: 'Repo', url: 'https://github.com/example/r', branch: 'main', enabled: true }] }, null, 2));
  fs.writeFileSync(path.join(STORE, 'config.json'), JSON.stringify({ autoUpdate: true }));
});

afterEach(async () => {
  stopModuleAutoUpdater();
  setStoppedServingHook(null);
  await rig.teardown();
});

function clone(files: Record<string, string>): void {
  const dir = path.join(STORE, 'cache', REPO);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const [rel, bytes] of Object.entries(files)) {
    const file = path.join(dir, 'Modules', 'm', ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
}

/** m 1.0.0 installed through the real install; the clone then holds `next`. */
async function installed(next: Record<string, string>): Promise<{ m: AppStoreManager; sha: string }> {
  clone(V1);
  const m = new AppStoreManager();
  await m.installModule('m', REPO);
  h.manager = m;
  clone(next);
  return { m, sha: moduleShaOfFiles(V1) };
}

/** One tick of the auto-updater's 30 minute interval; resolves once the line `until` is logged. */
async function tick(until: RegExp): Promise<void> {
  let run: (() => void) | null = null;
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { run = fn; return 0; }) as never);
  try {
    startModuleAutoUpdater({} as Client);
  } finally {
    spy.mockRestore();
  }
  run!();
  await vi.waitFor(() => { if (!rig.state.lines.some(l => until.test(l))) throw new Error(`no line ${until}`); }, { timeout: 10_000, interval: 5 });
  await new Promise(resolve => setImmediate(resolve));
}

const updaterLines = () => rig.state.lines.filter(l => l.startsWith('[ModuleAutoUpdater]') && !/Started|Stopped/.test(l));

/** The next COMMIT's answer is lost and the landing check gets no answer either. */
function loseCommitAndCheck(): void {
  let committing: number | null = null;
  rig.state.rows.fault = (sql, _p, client) => {
    if (sql === 'COMMIT' && committing === null) {
      committing = client;
      return 'lose';
    }
    if (committing !== null && client !== committing && sql.startsWith('SELECT id')) return lost();
    return undefined;
  };
}

describe('rows 146 and 221: the module auto-updater on a Postgres bot', () => {
  it('each update is applied inside updateModule; no second reload, and the log names the outcome', async () => {
    await installed(V2);
    await tick(/^\[ModuleAutoUpdater\] Hot-reloaded/);
    expect(h.reloads).toEqual([]);
    expect(rig.live('m')).toEqual(V2);
    expect(rig.entry('m')).toMatchObject({ sha: moduleShaOfFiles(V2) });
    expect(updaterLines()).toEqual([
      '[ModuleAutoUpdater] 1 module update(s) available, downloading...',
      '[ModuleAutoUpdater] Hot-reloaded 1 module(s)',
    ]);
  });

  it('T9: the new version failed to load here; logged, the previous version kept, no reload', async () => {
    await installed(FAILING);
    await tick(/was updated, but it failed to load/);
    expect(h.reloads).toEqual([]);
    expect(rig.live('m')).toEqual(V1);
    expect(updaterLines()).toEqual([
      '[ModuleAutoUpdater] 1 module update(s) available, downloading...',
      `[ModuleAutoUpdater] m 2.0.0 was updated, but it failed to load on this machine (index.js threw: boom), so this machine keeps the previous version. ${TAIL}`,
    ]);
  });

  it('T30: the new version loaded and its start-up code still runs', async () => {
    await installed(V2);
    const u = moduleShaOfFiles(V2);
    const load = reloaderFakes.loadModuleUnmarked;
    reloaderFakes.loadModuleUnmarked = async (client, module) => {
      const out = await load(client, module);
      const begun = startModule(module, u, '2.0.0', path.join(rig.state.source, module));
      if (typeof begun === 'string') throw new Error(begun);
      begun.turnAt = Date.now();
      markLate(begun);
      return { ...out, start: begun, late: true };
    };
    try {
      await tick(/start-up code is still running/);
    } finally {
      reloaderFakes.loadModuleUnmarked = load;
    }
    expect(h.reloads).toEqual([]);
    expect(updaterLines()[1]).toBe('[ModuleAutoUpdater] m 2.0.0 was updated and loaded on this machine, and its start-up code is still running. The App Store tab lists this machine if that code fails within 10 minutes; this machine then keeps the previous version.');
  });

  it("T18: an open boot start of the version in place defers the apply; the pass applies the row after it", async () => {
    const { sha } = await installed(V2);
    const start = startModule('m', sha, '1.0.0', path.join(rig.state.source, 'm'), { boot: true });
    expect(typeof start).not.toBe('string');
    await tick(/This machine applies the database's current version/);
    expect(h.reloads).toEqual([]);
    expect(rig.live('m')).toEqual(V1);
    expect(rig.state.rows.modules.get('m')?.sha).toBe(moduleShaOfFiles(V2));
    expect(updaterLines()[1]).toBe("[ModuleAutoUpdater] m 2.0.0 was updated. This machine applies the database's current version of m at the first pass after it finishes starting m (its start-up code runs once the bot has connected to Discord, loaded its data and started the modules before it, and the bot waits for it for at most 10 minutes).");
  });
});

describe("row 67: two machines' auto-updaters", () => {
  /** rig.publish runs in this process; BRAVO's publish writes its own name as the writer of installed.json and of the module's row. */
  const byBravo = (module: string) => {
    rig.state.rows.docs.get('global/appstore/installed.json')!.updated_by = 'BRAVO/p-bravo';
    rig.state.rows.modules.get(module)!.updated_by = 'BRAVO/p-bravo';
  };

  it("the second machine's update is refused, logged as decision 15 words it, and its pass applies the stored version", async () => {
    await installed(V2);
    const bravo = { ...V2, 'bravo.js': 'exports.by = "BRAVO";\n' };
    const stored = await rig.publish('m', bravo, '2.0.0');
    byBravo('m');
    await tick(/was updated on another machine/);
    expect(updaterLines()).toEqual([
      '[ModuleAutoUpdater] 1 module update(s) available, downloading...',
      '[ModuleAutoUpdater] m was updated on another machine meanwhile; applying that version',
    ]);
    expect(h.reloads).toEqual([]);
    expect(rig.state.rows.modules.get('m')?.sha).toBe(stored);
    expect(rig.live('m')).toEqual(V1);
    await rig.pass();
    expect(rig.live('m')).toEqual(bravo);
    expect(rig.entry('m')).toMatchObject({ sha: stored });
  });

  it("another machine changed only another module's entry: the line says m was not updated, and nothing is applied for m", async () => {
    await installed(V2);
    await rig.publish('y', { 'module.json': '{"name":"y","version":"1.0.0"}', 'index.js': 'exports.y = 1;\n' }, '1.0.0');
    byBravo('y');
    const before = rig.state.rows.modules.get('m')?.sha;
    await tick(/was not updated|was updated/);
    expect(updaterLines()).toEqual([
      '[ModuleAutoUpdater] 1 module update(s) available, downloading...',
      '[ModuleAutoUpdater] m was not updated: the installed modules changed on another machine meanwhile; the next check tries again',
    ]);
    expect(h.reloads).toEqual([]);
    expect(rig.state.rows.modules.get('m')?.sha).toBe(before);
    expect(rig.live('m')).toEqual(V1);
  });

  it('the stored list cannot be read after the refusal: the line says so and nothing is applied for m', async () => {
    await installed(V2);
    await rig.publish('y', { 'module.json': '{"name":"y","version":"1.0.0"}', 'index.js': 'exports.y = 1;\n' }, '1.0.0');
    byBravo('y');
    rig.state.rows.fault = sql => (sql.startsWith('SELECT body, sha FROM smdb_data.shared_docs') ? new Error('connection reset') : undefined);
    await tick(/was not updated|was updated/);
    expect(updaterLines()).toEqual([
      '[ModuleAutoUpdater] 1 module update(s) available, downloading...',
      '[ModuleAutoUpdater] m was not updated: installed.json changed on another machine meanwhile, and this machine could not read the new list (connection reset)',
    ]);
    expect(h.reloads).toEqual([]);
    expect(rig.live('m')).toEqual(V1);
  });
});

describe('row 146: updater/index.ts carries the apply\'s answer', () => {
  it('triggerModuleUpdate: `applied` from updateModule', async () => {
    await installed(V2);
    const result = await triggerModuleUpdate('m');
    expect(result).toMatchObject({ success: true, moduleName: 'm', oldVersion: '1.0.0', newVersion: '2.0.0', applied: { outcome: 'applied', loaded: true, text: null } });
    expect(rig.live('m')).toEqual(V2);
  });

  it('triggerAllModuleUpdates: each updated module carries its `applied`', async () => {
    await installed(FAILING);
    const result = await triggerAllModuleUpdates();
    const applied = expect.objectContaining({ outcome: 'failed', loaded: false });
    expect(result.updated).toEqual([{
      moduleName: 'm', oldVersion: '1.0.0', newVersion: '2.0.0', applied,
      published: { module: 'm', operation: 'update', version: '2.0.0', to: moduleShaOfFiles(FAILING), tag: '1:ALPHA', updatedBy: updatedBy(), staged: null, applied },
    }]);
  });

  it("35's can't confirm text is carried with `unconfirmed`", async () => {
    await installed(V2);
    loseCommitAndCheck();
    const result = await triggerModuleUpdate('m');
    expect(result).toMatchObject({ success: false, unconfirmed: true, error: expect.stringMatching(/^Can't confirm whether m was updated: /) });
  });
});

describe('row 146: the update panel on a Postgres bot', () => {
  const press = (button: string) => updateManagerPanel.handleButton!({
    client: {}, interaction: { message: { id: `p-${button}` } }, panelId: 'update_manager', userId: 'u1', guildId: 'g1',
    accessMethod: 'direct_command', navigationStack: [],
  } as never, button);
  const settled = () => vi.waitFor(() => { if (h.stamps.length === 0 && !rig.state.lines.some(l => l.includes('Error updating'))) throw new Error('not settled'); }, { timeout: 10_000, interval: 5 });
  const panelLines = () => rig.state.lines.filter(l => l.startsWith('[UpdateManagerPanel]') && !l.includes('pressed by'));

  it('one module: no second reload; logged from the apply', async () => {
    await installed(V2);
    await press('update_module_m');
    await settled();
    expect(h.reloads).toEqual([]);
    expect(rig.live('m')).toEqual(V2);
    expect(panelLines()).toEqual(['[UpdateManagerPanel] Hot-reloaded m']);
  });

  it('T37: this process stopped serving its shards; the panel logs it and reloads nothing', async () => {
    await installed(V2);
    setStoppedServingHook(() => true);
    await press('update_module_m');
    await settled();
    expect(h.reloads).toEqual([]);
    expect(panelLines()).toEqual(["[UpdateManagerPanel] m 2.0.0 was updated. This machine's bot process stopped serving its shards and restarts; it tries to load the module after that restart."]);
  });

  it("can't confirm: the panel logs 35's text and does not call it a failure", async () => {
    await installed(V2);
    loseCommitAndCheck();
    await press('update_module_m');
    await settled();
    expect(h.reloads).toEqual([]);
    expect(panelLines()).toEqual([expect.stringMatching(/^\[UpdateManagerPanel\] Can't confirm whether m was updated: /)]);
  });

  it('all modules: T9 logged, no reload', async () => {
    await installed(FAILING);
    await press('update_modules');
    await settled();
    expect(h.reloads).toEqual([]);
    expect(panelLines()).toEqual([`[UpdateManagerPanel] m 2.0.0 was updated, but it failed to load on this machine (index.js threw: boom), so this machine keeps the previous version. ${TAIL}`]);
  });
});

describe('a JSON bot (guard)', () => {
  beforeEach(() => {
    dm.setGuildDataBackend(null);
    setBackendKind(null);
  });

  it('the auto-updater updates in place, then hot-reloads the updated modules once', async () => {
    await installed(V2);
    await tick(/Hot-reloaded/);
    expect(h.reloads).toEqual([['m']]);
    expect(rig.live('m')).toEqual(V2);
  });

  it('the panel reloads the module it updated', async () => {
    await installed(V2);
    await updateManagerPanel.handleButton!({
      client: {}, interaction: { message: { id: 'p-json' } }, panelId: 'update_manager', userId: 'u1', guildId: 'g1',
      accessMethod: 'direct_command', navigationStack: [],
    } as never, 'update_module_m');
    await vi.waitFor(() => { if (h.stamps.length === 0) throw new Error('not settled'); }, { timeout: 10_000, interval: 5 });
    expect(h.reloads).toEqual(['m']);
  });
});
