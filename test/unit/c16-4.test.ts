import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ bulk: null as any }));

vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async (orig) => {
  const real = await orig<any>();
  return { ...real, getAppStoreManager: () => ({ updateAllModules: async () => h.bulk }) };
});
vi.mock('../../src/webui/utils/syncNudge', () => ({ nudgeSync: () => {} }));
vi.mock('../../src/webui/middleware/fleetGate', () => ({ requireMasterNode: (_q: any, _s: any, n: any) => n() }));

import { AppStoreManager } from '../../src/bot/internalSetup/utils/appStoreManager';
import { createUpdateRouter } from '../../src/webui/routes/update';

function fakeManager(check: any, results: Record<string, any>): any {
  return {
    checkAllModulesForUpdates: async () => check,
    updateModule: async (name: string) => results[name],
  };
}

const flagged = (moduleName: string, installedVersion = '1.0.0') => ({ moduleName, installedVersion, hasUpdate: true });

async function postModulesAndReload(reload: any = { success: true, reloaded: [] }): Promise<any> {
  const botManager: any = { reloadModules: vi.fn(async () => reload) };
  const router: any = createUpdateRouter(botManager);
  const layer = router.stack.find((l: any) => l.route?.path === '/modules-and-reload');
  const stack = layer.route.stack;
  let body: any;
  const res: any = { status: () => res, json: (b: any) => { body = b; return res; } };
  await stack[stack.length - 1].handle({ body: {}, params: {} }, res);
  return { body, botManager };
}

describe('C16-4 updateAllModules reports what it did not apply', () => {
  it('lists a flagged module whose version did not change as skipped', async () => {
    const m = fakeManager(
      { updates: [flagged('a'), flagged('b')], errors: [] },
      { a: { success: true, newVersion: '1.1.0' }, b: { success: true, newVersion: '1.0.0' } },
    );
    const r = await (AppStoreManager.prototype.updateAllModules as any).call(m);
    expect(r.updated.map((u: any) => u.moduleName)).toEqual(['a']);
    expect(r.skipped.map((s: any) => s.moduleName)).toEqual(['b']);
    expect(r.success).toBe(true);
  });

  it('carries the check errors even when nothing was flagged', async () => {
    const m = fakeManager({ updates: [], errors: [{ moduleName: 'c', error: 'Failed to refresh repository: x' }] }, {});
    const r = await (AppStoreManager.prototype.updateAllModules as any).call(m);
    expect(r.checkErrors).toEqual([{ moduleName: 'c', error: 'Failed to refresh repository: x' }]);
  });
});

describe('C16-4 /update/modules-and-reload answers success only when everything applied', () => {
  const base = { success: true, updated: [], failed: [], checkErrors: [], skipped: [] };

  it('a commit-only change that was skipped is not a success', async () => {
    h.bulk = { ...base, skipped: [{ moduleName: 'skipped-mod', reason: 'version unchanged' }] };
    const { body } = await postModulesAndReload();
    expect(body.success).toBe(false);
    expect(body.message).toContain('skipped-mod');
  });

  it('a failed update check is not a success', async () => {
    h.bulk = { ...base, checkErrors: [{ moduleName: 'unchecked-mod', error: 'Failed to refresh repository: x' }] };
    const { body } = await postModulesAndReload();
    expect(body.success).toBe(false);
    expect(body.message).toContain('unchecked-mod');
  });

  it('a partial update reloads what was applied and names what was not', async () => {
    h.bulk = { ...base, updated: [{ moduleName: 'a', oldVersion: '1.0.0', newVersion: '1.1.0' }], skipped: [{ moduleName: 'skipped-mod', reason: 'version unchanged' }] };
    const { body, botManager } = await postModulesAndReload();
    expect(botManager.reloadModules).toHaveBeenCalledWith(['a']);
    expect(body.success).toBe(false);
    expect(body.download.skipped.map((s: any) => s.moduleName)).toEqual(['skipped-mod']);
    expect(body.message).toContain('skipped-mod');
  });

  it('nothing flagged and nothing wrong is still a success', async () => {
    h.bulk = { ...base };
    const { body } = await postModulesAndReload();
    expect(body.success).toBe(true);
  });
});
