import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({
  load: vi.fn(),
  remove: vi.fn(async () => true),
  stamp: vi.fn(async () => true),
  show: vi.fn(async () => true),
}));

vi.mock('../../src/bot/internalSetup/utils/botManagerAPI', async importOriginal => ({
  ...(await importOriginal<object>()),
  checkForAllBotUpdates: async () => result,
}));
vi.mock('../../src/bot/internalSetup/utils/panel/persistentPanelStorage', async importOriginal => ({
  ...(await importOriginal<object>()),
  loadPersistentPanels: fx.load,
  removePersistentPanel: fx.remove,
  updatePersistentPanelState: fx.stamp,
}));
vi.mock('../../src/bot/internalSetup/utils/panel/persistentPanelResponse', async importOriginal => ({
  ...(await importOriginal<object>()),
  updatePanelDynamic: fx.show,
}));

import { recoverPersistentPanels } from '../../src/bot/internalSetup/utils/panel/persistentPanelRecovery';

const result = {
  success: true,
  lastChecked: '2026-10-28T00:00:00.000Z',
  baseCode: { checked: true, hasUpdates: false },
  modules: { checked: true, hasUpdates: false, totalInstalled: 0, updatesAvailable: 0, updates: [], errors: [] },
  summary: { totalUpdatesAvailable: 0, hasAnyUpdates: false },
};
const record = { messageId: 'm1', channelId: 'c1', userId: 'u1', createdAt: 0, lastUpdated: 0, state: 'a' };
const client = (fetch: () => Promise<unknown>) => ({ channels: { fetch }, guilds: { cache: new Map() } }) as never;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fx.load.mockResolvedValue({ update_manager: record });
  fx.remove.mockClear();
  fx.stamp.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('update panel recovery', () => {
  it('removes the update panel record when its channel is gone', async () => {
    await recoverPersistentPanels(client(async () => { throw Object.assign(new Error('gone'), { code: 10003 }); }));
    expect(fx.remove).toHaveBeenCalledWith('update_manager', undefined, undefined, 'm1');
  });

  it('removes the update panel record when its channel is not a text channel', async () => {
    await recoverPersistentPanels(client(async () => null));
    expect(fx.remove).toHaveBeenCalledWith('update_manager', undefined, undefined, 'm1');
  });

  it('stamps recovered with the check result once the panel shows it', async () => {
    await recoverPersistentPanels(client(async () => ({ isTextBased: () => true })));
    await vi.waitFor(() => expect(fx.stamp).toHaveBeenCalled());
    expect(fx.stamp).toHaveBeenCalledWith('update_manager', 'recovered', 'm1', undefined, undefined, { lastCheckResult: result });
  });
});
