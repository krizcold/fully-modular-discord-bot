import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  check: vi.fn(),
  system: vi.fn(),
  all: vi.fn(),
  stamp: vi.fn(async () => true),
  show: vi.fn(async () => true),
}));

vi.mock('../../src/bot/internalSetup/utils/botManagerAPI', async importOriginal => ({
  ...(await importOriginal<object>()),
  checkForAllBotUpdates: api.check,
  requestSystemUpdate: api.system,
  triggerAllModuleUpdates: api.all,
}));
vi.mock('../../src/bot/internalSetup/utils/panel/persistentPanelStorage', async importOriginal => ({
  ...(await importOriginal<object>()),
  updatePersistentPanelState: api.stamp,
}));
vi.mock('../../src/bot/internalSetup/utils/panel/persistentPanelResponse', async importOriginal => ({
  ...(await importOriginal<object>()),
  updatePanelDynamic: api.show,
}));

import updateManagerPanel from '../../src/bot/internalSetup/panels/updateManager';
import { describeBulkModuleUpdate, type BulkModuleUpdateResult } from '../../src/updater';

const check = {
  success: true,
  lastChecked: '2026-11-16T00:00:00.000Z',
  baseCode: { checked: true, hasUpdates: false },
  modules: { checked: true, hasUpdates: false, totalInstalled: 0, updatesAvailable: 0, updates: [], errors: [] },
  summary: { totalUpdatesAvailable: 0, hasAnyUpdates: false },
};

const TAIL = 'The Bot Manager is pulling the latest code and rebuilding.\n'
  + 'The bot will restart automatically when the new build is ready.\n'
  + 'This panel will refresh after restart.';

let n = 0;
const pressed = () => {
  n += 1;
  return {
    client: null, interaction: { message: { id: `sa4m${n}` } }, panelId: 'update_manager', userId: 'u1', guildId: 'g1',
    accessMethod: 'direct_command', navigationStack: [],
  } as never;
};

function bulk(updated: BulkModuleUpdateResult['updated']): BulkModuleUpdateResult {
  return { success: true, totalAttempted: updated.length, totalUpdated: updated.length, updated, failed: [], checkErrors: [], skipped: [] };
}

function contents(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) contents(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'content' && typeof v === 'string') out.push(v);
      else contents(v, out);
    }
  }
  return out;
}

async function pressEverything(moduleResult: BulkModuleUpdateResult): Promise<string> {
  api.all.mockResolvedValue(moduleResult);
  await updateManagerPanel.handleButton!(pressed(), 'update_everything');
  await vi.waitFor(() => expect(api.show).toHaveBeenCalled(), { timeout: 2000, interval: 5 });
  const shown = JSON.parse(JSON.stringify((api.show.mock.calls[0] as unknown[])[2]));
  const status = contents(shown).filter(t => t.includes('**Status:**') || t.includes('Bot Manager is pulling'));
  expect(status).toHaveLength(1);
  return status[0];
}

const lines = (spy: unknown) => (spy as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c.map(String).join(' '));

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  api.check.mockResolvedValue(check);
  api.system.mockResolvedValue({ success: true });
  api.stamp.mockClear();
  api.show.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('update everything: the module step before the system update, in the log and on the panel', () => {
  it('no module updated: the panel says the update is requested with no module count, and nothing is logged about modules', async () => {
    const text = await pressEverything(bulk([]));
    expect(text).toBe(`**Status:** Update requested\n\n${TAIL}`);
    expect(lines(console.log).filter(l => l.includes('module(s)'))).toEqual([]);
    expect(lines(console.warn)).toEqual([]);
  });

  it('two modules updated and both lists saved: the panel names the count, the log says it, nothing is warned', async () => {
    const result = bulk([
      { moduleName: 'alpha', oldVersion: '1.0.0', newVersion: '1.1.0' },
      { moduleName: 'beta', oldVersion: '2.0.0', newVersion: '2.1.0' },
    ]);
    const text = await pressEverything(result);
    expect(text).toBe(`**Status:** Update requested\n\n2 module(s) updated. ${TAIL}`);
    expect(lines(console.log)).toContain('[UpdateManagerPanel] Updated 2 module(s) before system update');
    expect(lines(console.warn)).toEqual([]);
  });

  it('one of two updated modules has a list that can not be confirmed: the panel and the warning carry the can\'t confirm text', async () => {
    const t9 = "Module alpha is updated, but the list of installed modules can't be confirmed as saved: sa4 T1.";
    const result = bulk([
      { moduleName: 'alpha', oldVersion: '1.0.0', newVersion: '1.1.0', listUnconfirmed: t9 },
      { moduleName: 'beta', oldVersion: '2.0.0', newVersion: '2.1.0' },
    ]);
    const described = describeBulkModuleUpdate(result);
    expect(described).toBe(`Updated 2 module(s). ${t9}`);
    const text = await pressEverything(result);
    expect(text).toBe(`**Status:** Update requested\n\n${described} ${TAIL}`);
    expect(lines(console.warn)).toEqual([`[UpdateManagerPanel] ${described}`]);
    expect(lines(console.log).filter(l => l.includes('before system update'))).toEqual([]);
  });
});
