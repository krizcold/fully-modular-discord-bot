import { describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  installed: [] as Array<{ name: string; version: string }>,
  update: null as unknown,
  all: null as unknown,
}));

vi.mock('../../src/bot/internalSetup/utils/appStoreManager', () => ({
  getAppStoreManager: () => ({
    getInstalledModules: () => store.installed,
    updateModule: async () => store.update,
    updateAllModules: async () => store.all,
  }),
}));

import { triggerAllModuleUpdates, triggerModuleUpdate } from '../../src/updater';

describe('the updater answers the Bot Manager', () => {
  it('passes on that the module list could not be confirmed after one module update', async () => {
    store.installed = [{ name: 'sa12mod', version: '1.0.0' }];
    const listUnconfirmed = "the module was updated, but the list of installed modules could not be saved (EIO)";
    store.update = { success: true, newVersion: '1.0.1', listUnconfirmed };
    expect(await triggerModuleUpdate('sa12mod')).toEqual({
      success: true, moduleName: 'sa12mod', oldVersion: '1.0.0', newVersion: '1.0.1', error: undefined, listUnconfirmed,
    });
  });

  it('counts every module an update-all tried: updated, failed and skipped', async () => {
    store.all = {
      updated: [{ moduleName: 'u1', oldVersion: '1', newVersion: '2' }],
      failed: [{ moduleName: 'f1', error: 'download failed' }, { moduleName: 'f2', error: 'download failed' }],
      skipped: [{ moduleName: 's1', reason: 'pinned' }],
      checkErrors: [],
    };
    const result = await triggerAllModuleUpdates();
    expect(result.totalAttempted).toBe(4);
    expect(result.totalUpdated).toBe(1);
    expect(result.success).toBe(false);
  });
});
