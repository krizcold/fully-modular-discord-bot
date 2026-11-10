import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB19 round 1 fixes: the crash count after a FolderSyncError (F1), T9 in the panel's single update (F2, DL-5), the
// staged import's next step (F4) and writeFileSynced's one handle (F5, T14).

const h = vi.hoisted(() => ({
  fail: new Map<string, { kind: 'sync' | 'open' | 'earlier'; errno: string }>(),
  underFail: null as null | { kind: 'sync' | 'open' | 'earlier'; errno: string },
  update: null as any,
  reload: { success: true, moduleName: 'alpha', duration: 1 } as any,
  reloads: [] as string[],
  stamps: [] as unknown[],
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolderChainSync: (dir: string) => {
      const at = path.resolve(dir);
      const f = h.fail.get(at);
      return f ? { failed: true, kind: f.kind, dir: at, errno: f.errno, error: null } : { failed: false };
    },
    syncFoldersUnder: async (root: string) => {
      const f = h.underFail;
      return f ? { failed: true, kind: f.kind, dir: path.join(path.resolve(root), 'm'), errno: f.errno, error: null } : { failed: false };
    },
  };
});

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', () => ({
  reloadModule: async (_client: unknown, module: string) => {
    h.reloads.push(module);
    return h.reload;
  },
  reloadModules: async (_client: unknown, modules: string[]) => ({ success: true, reloaded: [...modules], failed: [], totalDuration: 1 }),
}));

vi.mock('../../src/bot/internalSetup/utils/botManagerAPI', async orig => ({
  ...(await orig<object>()),
  triggerModuleUpdate: async () => h.update,
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
  updatePanelDynamic: async () => true,
}));

import { dataPath } from '../../src/utils/dataRoot';
import { resetFolderSyncFailureForTests, syncWords, writeFileSynced } from '../../src/bot/internalSetup/utils/folderChain';
import {
  _resetModuleCrashes, closeWindow, countCrash, crashFilePath, endStart, keptEnds, openWindow, retryKeptEnds, startModule,
  type ModuleStart,
} from '../../src/bot/internalSetup/utils/moduleCrashes';
import { importBundle, writeBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import updateManagerPanel from '../../src/bot/internalSetup/panels/updateManager';
import { setBackendKind } from '../helpers/backendKind';

const failAt = (dir: string, kind: 'sync' | 'open' | 'earlier' = 'sync', errno = 'EIO') => h.fail.set(path.resolve(dir), { kind, errno });

let errors: string[];
let warns: string[];
let logs: string[];
beforeEach(() => {
  h.fail.clear();
  h.underFail = null;
  h.update = null;
  h.reload = { success: true, moduleName: 'alpha', duration: 1 };
  h.reloads.length = 0;
  h.stamps.length = 0;
  resetFolderSyncFailureForTests();
  errors = [];
  warns = [];
  logs = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
});
afterEach(() => vi.restoreAllMocks());

describe('F1: a crash count write whose folder chain failed is in place', () => {
  beforeEach(() => {
    _resetModuleCrashes();
    fs.rmSync(crashFilePath(), { force: true });
  });
  afterEach(() => _resetModuleCrashes());

  const lines = () => JSON.parse(fs.readFileSync(crashFilePath(), 'utf8'));

  it('an end deletion, then a crash at the same sha, then the exit retry: the crash line stays', async () => {
    fs.mkdirSync(path.dirname(crashFilePath()), { recursive: true });
    fs.writeFileSync(crashFilePath(), JSON.stringify({ alpha: { sha: 'S', n: 1, version: '1.0.0', error: 'old', at: '2026-11-10T00:00:00.000Z' } }));
    failAt(path.dirname(crashFilePath()));

    const first = startModule('alpha', 'S', '1.0.0', dataPath('runtime-modules', 'alpha')) as ModuleStart;
    await endStart(first, 'ok');
    expect(lines().alpha).toBeUndefined();
    expect(keptEnds.has('alpha')).toBe(false);

    const second = startModule('alpha', 'S', '1.0.0', dataPath('runtime-modules', 'alpha')) as ModuleStart;
    openWindow(second);
    countCrash(new Error('boom'));
    closeWindow(second);
    expect(lines().alpha).toMatchObject({ sha: 'S', n: 1, error: 'boom' });
    expect(keptEnds.has('alpha')).toBe(false);

    retryKeptEnds();
    expect(lines().alpha).toMatchObject({ sha: 'S', n: 1, error: 'boom' });
    expect(errors.some(l => l.startsWith("[Error] The module crash count can't be confirmed as saved: "))).toBe(true);
    expect(errors.some(l => l.includes('could not be written'))).toBe(false);
  });
});

describe('F2: the panel logs T9 for a single update whatever the reload did', () => {
  const T9 = 'Module alpha is updated, but the list of installed modules can\'t be confirmed as saved: x. Its backup is kept at /b.';
  const press = (client: unknown) => updateManagerPanel.handleButton!({
    client, interaction: { message: { id: `p-${Math.random()}` } }, panelId: 'update_manager', userId: 'u1', guildId: 'g1',
    accessMethod: 'direct_command', navigationStack: [],
  } as never, 'update_module_alpha');
  const settled = () => vi.waitFor(() => { if (!h.stamps.some((s: any) => s[1] === 'module_updated')) throw new Error('not settled'); }, { timeout: 10_000, interval: 5 });
  const panel = (list: string[]) => list.filter(l => l.startsWith('[UpdateManagerPanel]') && !l.includes('pressed by'));

  beforeEach(() => {
    h.update = { success: true, moduleName: 'alpha', oldVersion: '1.0.0', newVersion: '2.0.0', listUnconfirmed: T9 };
  });

  it('the reload succeeds: T9, no Hot-reloaded line', async () => {
    await press({});
    await settled();
    expect(h.reloads).toEqual(['alpha']);
    expect(panel(warns)).toEqual([`[UpdateManagerPanel] ${T9}`]);
    expect(panel(logs).some(l => l.includes('Hot-reloaded'))).toBe(false);
  });

  it('the reload fails: its line and T9', async () => {
    h.reload = { success: false, moduleName: 'alpha', duration: 1, error: 'boom' };
    await press({});
    await settled();
    expect(panel(warns)).toEqual(['[UpdateManagerPanel] Hot-reload failed for alpha: boom', `[UpdateManagerPanel] ${T9}`]);
  });

  it('no client: T9', async () => {
    await press(null);
    await settled();
    expect(h.reloads).toEqual([]);
    expect(panel(warns)).toEqual([`[UpdateManagerPanel] ${T9}`]);
  });

  it('no listUnconfirmed: the Hot-reloaded line and no warning', async () => {
    h.update = { success: true, moduleName: 'alpha', oldVersion: '1.0.0', newVersion: '2.0.0' };
    await press({});
    await settled();
    expect(panel(warns)).toEqual([]);
    expect(panel(logs).some(l => l.startsWith('[UpdateManagerPanel] Hot-reloaded alpha'))).toBe(true);
  });
});

describe("F4: the staged import's failure names the next step", () => {
  let guilds = 870_000_000_000_000_000n;
  beforeEach(() => setBackendKind('file'));
  afterEach(() => setBackendKind(null));

  async function bundle(): Promise<{ g: string; file: string }> {
    const g = String(++guilds);
    const at = dataPath(g, 'm', 'a.json');
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, '{"new":1}');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nb19fix-bundle-')), 'b.dbex');
    await writeBundle(g, file);
    fs.writeFileSync(at, '{"live":1}');
    return { g, file };
  }
  async function message(): Promise<string> {
    const { g, file } = await bundle();
    try {
      await importBundle(file);
    } catch (error) {
      expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"live":1}');
      return (error as Error).message;
    }
    throw new Error('the import did not throw');
  }

  it("'sync': the live dir untouched, then check the disk and restart", async () => {
    h.underFail = { kind: 'sync', errno: 'EIO' };
    const text = await message();
    expect(text).toMatch(/^\[DataInterchange\] The staged import's folders can't be confirmed as stored: the disk did not confirm the sync of .* \(EIO\); the live guild dir was not touched\. Check the disk, then restart the machine\.$/);
    expect(text.split('the live guild dir was not touched')).toHaveLength(2);
  });

  it("'open': the live dir untouched, then run the import again", async () => {
    h.underFail = { kind: 'open', errno: 'EMFILE' };
    const text = await message();
    expect(text).toMatch(/could not be opened for its sync \(EMFILE\); the live guild dir was not touched\. Run the import again\.$/);
  });

  it("'earlier': the restart advice", async () => {
    h.underFail = { kind: 'earlier', errno: 'EIO' };
    const text = await message();
    expect(text.endsWith(`; the live guild dir was not touched. ${syncWords('earlier', 'x', 'EIO').next}`)).toBe(true);
  });
});

describe('F5: writeFileSynced writes and fsyncs through one handle', () => {
  it("opens the file once with 'w', writes, syncs and closes that handle", async () => {
    const target = dataPath('nb19fix', 'one', 'a.json');
    fs.rmSync(path.dirname(target), { recursive: true, force: true });
    const realOpen = fs.promises.open;
    const opens: Array<{ flags: unknown; calls: string[] }> = [];
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags?: any, ...rest: any[]) => {
      const fh = await (realOpen as any)(p, flags, ...rest);
      if (path.resolve(String(p)) !== path.resolve(target)) return fh;
      const seen = { flags, calls: [] as string[] };
      opens.push(seen);
      for (const name of ['writeFile', 'sync', 'close'] as const) {
        const fn = fh[name].bind(fh);
        fh[name] = async (...args: unknown[]) => { seen.calls.push(name); return fn(...args); };
      }
      return fh;
    }) as any);
    await writeFileSynced(target, '{"a":1}');
    expect(opens).toEqual([{ flags: 'w', calls: ['writeFile', 'sync', 'close'] }]);
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}');
  });
});
