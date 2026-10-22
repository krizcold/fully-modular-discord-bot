import { describe, expect, it, vi } from 'vitest';

// C35-3: a Free-baseline save must not rewrite a paid tier's stored values. Raising Free to a paid tier's value and
// lowering it again leaves the paid tier at the value the operator set.
const store = vi.hoisted(() => ({
  global: {} as Record<string, { values: Record<string, unknown>; hardLimits: Record<string, unknown>; moduleEnabled: boolean; disabledCommands: string[] }>,
  saved: [] as unknown[],
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    readRaw: () => null,
    saveGlobalData: (_name: string, data: unknown) => { store.saved.push(JSON.parse(JSON.stringify(data))); return true; },
    flushAll: async () => undefined,
    appendData: () => true,
  };
});
vi.mock('../../src/bot/internalSetup/utils/settings/settingsStorage', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/settings/settingsStorage')>();
  const blank = () => ({ values: {}, hardLimits: {}, moduleEnabled: true, disabledCommands: [] as string[] });
  return {
    ...real,
    loadGlobalModuleConfig: (m: string) => JSON.parse(JSON.stringify(store.global[m] ?? blank())),
    saveGlobalModuleConfig: (m: string, partial: Record<string, unknown>) => {
      store.global[m] = { ...(store.global[m] ?? blank()), ...partial } as any;
      return true;
    },
  };
});

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({ on: () => undefined, off: () => undefined, get: () => undefined }),
}));

import { PremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';

function rig() {
  store.global = { mod: { values: { limit: 5 }, hardLimits: {}, moduleEnabled: true, disabledCommands: [] } };
  const pm = new PremiumManager();
  expect(pm.setTier('gold', { displayName: 'Gold', priority: 10, overrides: { mod: { limit: 10 } }, offerings: [] })).toBe(true);
  return pm;
}

describe('a Free-baseline save keeps paid tier values', () => {
  it('raising Free to the paid value keeps the paid override stored', () => {
    const pm = rig();
    expect(pm.setGlobalModuleConfig('mod', { values: { limit: 10 } as any })).toBe(true);
    expect(pm.getTier('gold')?.overrides.mod).toEqual({ limit: 10 });
    pm.dispose();
  });

  it('raising then lowering Free leaves the paid tier at its own value', () => {
    const pm = rig();
    pm.setGlobalModuleConfig('mod', { values: { limit: 10 } as any });
    pm.setGlobalModuleConfig('mod', { values: { limit: 5 } as any });
    expect(pm.getTier('gold')?.overrides.mod).toEqual({ limit: 10 });
    pm.dispose();
  });

  it('an unrelated paid-tier save while Free equals the paid value keeps the paid override', () => {
    const pm = rig();
    pm.setGlobalModuleConfig('mod', { values: { limit: 10 } as any });
    const gold = pm.getTier('gold')!;
    expect(pm.setTier('gold', { ...gold, displayName: 'Gold Plus' })).toBe(true);
    pm.setGlobalModuleConfig('mod', { values: { limit: 5 } as any });
    expect(pm.getTier('gold')?.overrides.mod).toEqual({ limit: 10 });
    pm.dispose();
  });

  it('removing another key of the module while Free equals the paid value keeps the paid key', () => {
    store.global = { mod: { values: { limit: 5, perks: 5 }, hardLimits: {}, moduleEnabled: true, disabledCommands: [] } };
    const pm = new PremiumManager();
    pm.setTier('gold', { displayName: 'Gold', priority: 10, overrides: { mod: { limit: 10, perks: 3 } }, offerings: [] });
    pm.setGlobalModuleConfig('mod', { values: { limit: 10, perks: 5 } as any });
    const gold = pm.getTier('gold')!;
    expect(pm.setTier('gold', { ...gold, overrides: { mod: { limit: 10 } } })).toBe(true);
    pm.setGlobalModuleConfig('mod', { values: { limit: 5, perks: 5 } as any });
    expect(pm.getTier('gold')?.overrides.mod).toEqual({ limit: 10 });
    pm.dispose();
  });

  it('still drops a paid module switch-off that would be worse than Free', () => {
    store.global = { mod: { values: {}, hardLimits: {}, moduleEnabled: false, disabledCommands: [] } };
    const pm = new PremiumManager();
    pm.setTier('gold', { displayName: 'Gold', priority: 10, overrides: { mod: { _moduleEnabled: false, limit: 3 } }, offerings: [] });
    pm.setGlobalModuleConfig('mod', { moduleEnabled: true });
    expect(pm.getTier('gold')?.overrides.mod).toEqual({ limit: 3 });
    pm.dispose();
  });
});
