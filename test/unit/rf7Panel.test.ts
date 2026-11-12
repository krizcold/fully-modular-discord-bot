import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  check: vi.fn(),
  all: vi.fn(),
  one: vi.fn(),
  stamp: vi.fn(async () => true),
  show: vi.fn(async () => true),
  reloads: [] as Array<string | string[]>,
}));

vi.mock('../../src/bot/internalSetup/utils/botManagerAPI', async importOriginal => ({
  ...(await importOriginal<object>()),
  checkForAllBotUpdates: api.check,
  triggerAllModuleUpdates: api.all,
  triggerModuleUpdate: api.one,
}));
vi.mock('../../src/bot/internalSetup/utils/panel/persistentPanelStorage', async importOriginal => ({
  ...(await importOriginal<object>()),
  updatePersistentPanelState: api.stamp,
}));
vi.mock('../../src/bot/internalSetup/utils/panel/persistentPanelResponse', async importOriginal => ({
  ...(await importOriginal<object>()),
  updatePanelDynamic: api.show,
}));
vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async importOriginal => ({
  ...(await importOriginal<object>()),
  reloadModule: async (_client: unknown, name: string) => {
    api.reloads.push(name);
    return { success: true, moduleName: name, duration: 1 };
  },
  reloadModules: async (_client: unknown, names: string[]) => {
    api.reloads.push([...names]);
    return { success: true, reloaded: [...names], failed: [], totalDuration: 1 };
  },
}));

import updateManagerPanel from '../../src/bot/internalSetup/panels/updateManager';

const check = {
  success: true,
  lastChecked: '2026-11-12T00:00:00.000Z',
  baseCode: { checked: true, hasUpdates: false },
  modules: { checked: true, hasUpdates: false, totalInstalled: 1, updatesAvailable: 0, updates: [], errors: [] },
  summary: { totalUpdatesAvailable: 0, hasAnyUpdates: false },
};

let n = 0;
let logs: string[];
let warns: string[];
let errors: string[];
const pressed = () => {
  n += 1;
  return {
    client: {}, interaction: { message: { id: `m${n}` } }, panelId: 'update_manager', userId: 'u1', guildId: 'g1',
    accessMethod: 'direct_command', navigationStack: [],
  } as never;
};
const join = (args: unknown[]) => args.map(String).join(' ');

beforeEach(() => {
  logs = [];
  warns = [];
  errors = [];
  api.reloads = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(join(a)); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(join(a)); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(join(a)); });
  api.check.mockResolvedValue(check);
  api.stamp.mockClear();
  api.show.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); });

async function press(button: string): Promise<void> {
  await updateManagerPanel.handleButton!(pressed(), button);
  await vi.waitFor(() => expect(api.stamp).toHaveBeenCalled(), { timeout: 2000, interval: 2 });
}

const panelLines = (lines: string[]) => lines.filter(l => l.startsWith('[UpdateManagerPanel]') && !/ pressed by /.test(l));

describe('update all modules: the log names what was applied and what was reloaded', () => {
  it('an update applied inside updateModule with no text logs only the hot-reload count, no warning, no second reload', async () => {
    api.all.mockResolvedValue({
      totalUpdated: 1,
      updated: [{ moduleName: 'alpha', oldVersion: '1.0.0', newVersion: '2.0.0', applied: { outcome: 'applied' } }],
      failed: [], skipped: [], checkErrors: [],
    });
    await press('update_modules');
    expect(panelLines(logs)).toEqual(['[UpdateManagerPanel] Hot-reloaded 1 module(s)']);
    expect(warns).toEqual([]);
    expect(errors).toEqual([]);
    expect(api.reloads).toEqual([]);
  });

  it('a downloaded update with no apply is reloaded and logged as downloaded, then hot-reloaded', async () => {
    api.all.mockResolvedValue({
      totalUpdated: 1,
      updated: [{ moduleName: 'beta', oldVersion: '1.0.0', newVersion: '2.0.0' }],
      failed: [], skipped: [], checkErrors: [],
    });
    await press('update_modules');
    expect(api.reloads).toEqual([['beta']]);
    expect(panelLines(logs)).toEqual([
      '[UpdateManagerPanel] Downloaded 1 module update(s), hot-reloading...',
      '[UpdateManagerPanel] Hot-reloaded 1 module(s)',
    ]);
    expect(warns).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('a mix: the applied one is counted and its text warned, only the downloaded one is reloaded', async () => {
    api.all.mockResolvedValue({
      totalUpdated: 3,
      updated: [
        { moduleName: 'alpha', oldVersion: '1.0.0', newVersion: '2.0.0', applied: { outcome: 'applied' } },
        { moduleName: 'gamma', oldVersion: '1.0.0', newVersion: '2.0.0', applied: { outcome: 'failed', text: 'gamma failed to load here' } },
        { moduleName: 'beta', oldVersion: '1.0.0', newVersion: '2.0.0' },
      ],
      failed: [], skipped: [], checkErrors: [],
    });
    await press('update_modules');
    expect(api.reloads).toEqual([['beta']]);
    expect(warns).toEqual(['[UpdateManagerPanel] gamma failed to load here']);
    expect(panelLines(logs)).toEqual([
      '[UpdateManagerPanel] Hot-reloaded 1 module(s)',
      '[UpdateManagerPanel] Downloaded 1 module update(s), hot-reloading...',
      '[UpdateManagerPanel] Hot-reloaded 1 module(s)',
    ]);
    expect(errors).toEqual([]);
  });
});

describe('update one module: a failure that is not unconfirmed', () => {
  it('logs the failure as an error, not as a warning', async () => {
    api.one.mockResolvedValue({ success: false, error: 'the clone could not be read' });
    await press('update_module_alpha');
    expect(errors).toEqual(['[UpdateManagerPanel] Failed to update alpha: the clone could not be read']);
    expect(warns).toEqual([]);
  });

  it('an unconfirmed failure is a warning with the answer text', async () => {
    api.one.mockResolvedValue({ success: false, unconfirmed: true, error: "Can't confirm alpha was saved" });
    await press('update_module_alpha');
    expect(warns).toEqual(["[UpdateManagerPanel] Can't confirm alpha was saved"]);
    expect(errors).toEqual([]);
  });
});
