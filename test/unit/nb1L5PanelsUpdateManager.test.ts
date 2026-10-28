import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  check: vi.fn(),
  system: vi.fn(),
  all: vi.fn(),
  one: vi.fn(),
  stamp: vi.fn(async () => true),
  show: vi.fn(async () => true),
}));

vi.mock('../../src/bot/internalSetup/utils/botManagerAPI', async importOriginal => ({
  ...(await importOriginal<object>()),
  checkForAllBotUpdates: api.check,
  requestSystemUpdate: api.system,
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

import updateManagerPanel from '../../src/bot/internalSetup/panels/updateManager';

const result = {
  success: true,
  lastChecked: '2026-10-28T00:00:00.000Z',
  baseCode: { checked: true, hasUpdates: false },
  modules: { checked: true, hasUpdates: false, totalInstalled: 0, updatesAvailable: 0, updates: [], errors: [] },
  summary: { totalUpdatesAvailable: 0, hasAnyUpdates: false },
};
const modules = { totalUpdated: 0, updated: [], failed: [], skipped: [], checkErrors: [] };

let n = 0;
const ctx = (interaction: any) => ({
  client: null, interaction, panelId: 'update_manager', userId: 'u1', guildId: 'g1',
  accessMethod: 'direct_command', navigationStack: [],
}) as never;
const pressed = () => { n += 1; return ctx({ message: { id: `m${n}` } }); };
const states = () => api.stamp.mock.calls.map((c: any[]) => c[1]);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  api.check.mockResolvedValue(result);
  api.all.mockResolvedValue(modules);
  api.one.mockResolvedValue({ success: false, error: 'x' });
  api.stamp.mockClear();
  api.show.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the update manager stamps the stored panel it was pressed on', () => {
  it('onPersistentCreated stamps checked with the check result on the new message', async () => {
    updateManagerPanel.onPersistentCreated!(null as never, 'g9', 'm-new', 'c9');
    await vi.waitFor(() => expect(api.stamp).toHaveBeenCalled());
    expect(api.stamp).toHaveBeenCalledWith('update_manager', 'checked', 'm-new', 'g9', undefined, { lastCheckResult: result });
  });

  it('check_updates stamps checked with the result on the pressed message', async () => {
    const c = pressed();
    await updateManagerPanel.handleButton!(c, 'check_updates');
    await vi.waitFor(() => expect(api.stamp).toHaveBeenCalled());
    expect(api.stamp).toHaveBeenCalledWith('update_manager', 'checked', `m${n}`, 'g1', undefined, { lastCheckResult: result });
  });

  it.each(['update_system', 'update_everything'])('%s stamps updating, then update_triggered on success', async button => {
    api.system.mockResolvedValue({ success: true });
    await updateManagerPanel.handleButton!(pressed(), button);
    expect(api.stamp).toHaveBeenCalledWith('update_manager', 'updating', `m${n}`, 'g1', undefined, undefined);
    await vi.waitFor(() => expect(api.stamp).toHaveBeenCalledTimes(2));
    expect(states()).toEqual(['updating', 'update_triggered']);
  });

  it.each(['update_system', 'update_everything'])('%s stamps update_error when the manager refuses', async button => {
    api.system.mockResolvedValue({ success: false });
    await updateManagerPanel.handleButton!(pressed(), button);
    await vi.waitFor(() => expect(api.stamp).toHaveBeenCalledTimes(2));
    expect(states()).toEqual(['updating', 'update_error']);
  });

  it.each(['update_system', 'update_everything'])('%s stamps update_error when the request throws', async button => {
    api.system.mockRejectedValue(new Error('down'));
    await updateManagerPanel.handleButton!(pressed(), button);
    await vi.waitFor(() => expect(api.stamp).toHaveBeenCalledTimes(2));
    expect(states()).toEqual(['updating', 'update_error']);
  });

  it('updating all modules stamps modules_updated with the check and the update result', async () => {
    await updateManagerPanel.handleButton!(pressed(), 'update_modules');
    await vi.waitFor(() => expect(api.stamp).toHaveBeenCalled());
    expect(api.stamp).toHaveBeenCalledWith('update_manager', 'modules_updated', `m${n}`, 'g1', undefined, {
      lastCheckResult: result,
      lastModuleUpdate: { updated: [], failed: [], skipped: [], checkErrors: [] },
    });
  });

  it('a single module update stamps module_updated with the check and the update result', async () => {
    await updateManagerPanel.handleButton!(pressed(), 'update_module_alpha');
    await vi.waitFor(() => expect(api.stamp).toHaveBeenCalled());
    expect(api.stamp).toHaveBeenCalledWith('update_manager', 'module_updated', `m${n}`, 'g1', undefined, {
      lastCheckResult: result,
      lastSingleModuleUpdate: { success: false, error: 'x' },
    });
  });

  it('a press with no interaction or no message stamps nothing and does not throw', async () => {
    api.system.mockResolvedValue({ success: true });
    await expect(updateManagerPanel.handleButton!(ctx(null), 'update_system')).resolves.toBeTruthy();
    await expect(updateManagerPanel.handleButton!(ctx({}), 'update_system')).resolves.toBeTruthy();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(api.stamp).not.toHaveBeenCalled();
  });
});
