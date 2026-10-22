import { describe, expect, it, vi } from 'vitest';

// C33-4 (R44-J5): scheduleMigration refuses a source or target variant that the named offering does not carry for
// the named provider, so a migration never records a plan the subscribers cannot be moved to.
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({
    get: (id: string) => ({ id, capabilities: { supportsPriceMigration: true }, migrateSubscriptionPrice: async () => ({}) }),
  }),
}));

import { PremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';

const link = (providerId: string, ...variantIds: string[]) => ({
  providerId, enabled: true, mode: 'price',
  cache: { syncedAt: '2026-01-01T00:00:00Z', variants: variantIds.map(variantId => ({ variantId, label: variantId })) },
});

function rig() {
  const self: any = {
    ensureLoaded: () => {},
    save: vi.fn(() => true),
    writeAudit: () => {},
    config: {
      tiers: {
        gold: { offerings: [{ id: 'std', providerLinks: [link('stripe', 'v1', 'v2'), link('paypal', 'p1')] }] },
        plat: { offerings: [{ id: 'pro', providerLinks: [link('stripe', 'v3'), link('paypal', 'p2')] }] },
      },
      subscriptions: {},
      migrations: [],
    },
  };
  for (const k of Object.getOwnPropertyNames(PremiumManager.prototype)) {
    if (!(k in self)) self[k] = (PremiumManager.prototype as any)[k];
  }
  return self;
}

const base = {
  providerId: 'stripe', sourceTierId: 'gold', sourceOfferingId: 'std', sourceVariantId: 'v1',
  targetTierId: 'plat', targetOfferingId: 'pro', targetVariantId: 'v3',
  effectiveDate: new Date(Date.now() + 40 * 86400000).toISOString(), message: '',
};

describe('scheduleMigration checks both variants against the provider', () => {
  it('schedules when both variants are on the provider link', async () => {
    const self = rig();
    await expect(self.scheduleMigration(base)).resolves.toMatchObject({ status: 'pending' });
    expect(self.config.migrations).toHaveLength(1);
  });

  it.each([
    ['target on another provider', { targetVariantId: 'p2' }, "Target variant 'p2'"],
    ['source on another provider', { sourceVariantId: 'p1' }, "Source variant 'p1'"],
    ['target in another offering', { targetVariantId: 'v2' }, "Target variant 'v2'"],
    ['provider not linked', { providerId: 'other' }, "Source variant 'v1'"],
  ])('refuses a %s, naming the variant, and records nothing', async (_n, over, msg) => {
    const self = rig();
    await expect(self.scheduleMigration({ ...base, ...over })).rejects.toThrow(msg);
    expect(self.config.migrations).toHaveLength(0);
    expect(self.save).not.toHaveBeenCalled();
  });
});
