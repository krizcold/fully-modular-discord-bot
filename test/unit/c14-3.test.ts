import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  installed: [] as any[],
  moduleCheck: { updatesAvailable: 0, updates: [], errors: [] } as any,
  updaterType: 'managed',
  status: { inProgress: false } as any,
  combined: null as any,
}));

vi.mock('../../src/bot/internalSetup/utils/appStoreManager', () => ({
  getAppStoreManager: () => ({
    getInstalledModules: () => h.installed,
    checkAllModulesForUpdates: async () => h.moduleCheck,
  }),
}));

vi.mock('../../src/updater/index', async (orig) => {
  const real = await orig<any>();
  return {
    ...real,
    getUpdaterType: () => h.updaterType,
    getUpdateStatus: () => ({ ...h.status }),
    checkForAllUpdates: async () => h.combined,
  };
});

import { SubscriptionNotifier } from '../../src/bot/internalSetup/utils/subscriptionNotifier';

const iso = '2026-11-03T15:30:00.000Z';
const unix = Math.floor(Date.parse(iso) / 1000);
const stamp = `<t:${unix}:f> (<t:${unix}:R>)`;

function combined(): any {
  return {
    success: true,
    partial: false,
    lastChecked: iso,
    baseCode: { checked: true, hasUpdates: false },
    modules: { checked: true, hasUpdates: false, totalInstalled: 0, updatesAvailable: 0, unchecked: 0, updates: [], errors: [] },
    summary: { totalUpdatesAvailable: 0, hasAnyUpdates: false },
  };
}

const ctx = (): any => ({
  client: null, interaction: null, panelId: 'update_manager', userId: 'u1', guildId: 'g1', accessMethod: 'direct_command', navigationStack: [],
});

beforeEach(() => { h.updaterType = 'managed'; h.status = { inProgress: false }; h.combined = null; });
afterEach(() => { vi.restoreAllMocks(); });

describe('C14-3 dates render in the reader\'s own zone', () => {
  const fmt = (type: any, p: any) => (new SubscriptionNotifier() as any).formatMessage(type, p) as string;

  it.each([
    'manual.grant.added', 'manual.grant.ending-soon', 'paid.sub.started', 'paid.sub.resumed-from-queue',
    'paid.sub.cancelled-by-user', 'migration.scheduled', 'migration.accepted',
  ])('%s shows the end date as Discord timestamp markup', (type) => {
    const t = fmt(type, { tierName: 'Gold', endDate: iso });
    expect(t).toContain(stamp);
    expect(t).not.toContain(new Date(iso).toLocaleDateString());
  });

  it('keeps the fallback words when there is no or a bad end date', () => {
    expect(fmt('migration.scheduled', { tierName: 'Gold' })).toContain('a future date');
    expect(fmt('manual.grant.added', { tierName: 'Gold', endDate: 'garbage' })).not.toContain('Invalid Date');
    expect(fmt('manual.grant.added', { tierName: 'Gold', endDate: 'garbage' })).not.toContain('<t:NaN');
  });

  it('the update panel shows Last Check as Discord timestamp markup', async () => {
    vi.resetModules();
    const p = await import('../../src/bot/internalSetup/panels/updateManager');
    const t = JSON.stringify(p.buildPanelView(ctx(), 'main', combined()));
    expect(t).toContain(`**Last Check:** ${stamp}`);
  });
});
