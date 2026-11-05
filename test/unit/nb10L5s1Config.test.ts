import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 decision 12: premium-tiers.json is loaded as the file says, normalized once; the free tier, the guild records
// and the per-writer marks of eventsApplied keep what the file holds and drop what it cannot hold.

const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { clearGlobal, PREMIUM, quiet, settleQueue } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const manual = (id: string) => ({ id, tierId: 'free', source: 'manual', startDate: '2026-01-01T00:00:00.000Z', endDate: null, autoRenew: false, status: 'active', createdAt: '', updatedAt: '' });

function load(file: Record<string, unknown>): any {
  fs.writeFileSync(PREMIUM, JSON.stringify(file));
  return getPremiumManager().getFullConfig();
}

beforeAll(() => clearGlobal());
beforeEach(async () => {
  quiet();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  delete process.env.BOT_PROCESS_ROLE;
});
afterEach(async () => {
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('premium-tiers.json as loaded', () => {
  it('the free tier keeps its stored name and overrides, at priority 0 with no offerings; a tier without offerings has none', () => {
    const cfg = load({
      tiers: {
        free: { displayName: 'Basic', priority: 3, overrides: { mod: { a: 1 } }, offerings: [{ id: 'x', label: 'X' }] },
        gold: { displayName: 'Gold', priority: 5, overrides: {} },
        silver: { displayName: 'Silver', priority: 4, overrides: {}, offerings: 'none' },
      },
    });
    expect(cfg.tiers.free).toEqual({ displayName: 'Basic', priority: 0, overrides: { mod: { a: 1 } }, offerings: [] });
    expect(cfg.tiers.gold.offerings).toEqual([]);
    expect(cfg.tiers.silver.offerings).toEqual([]);
  });

  it('a file with no free tier answers one named Free', () => {
    const cfg = load({ tiers: { gold: { displayName: 'Gold', priority: 5, overrides: {}, offerings: [] } } });
    expect(cfg.tiers.free).toEqual({ displayName: 'Free', priority: 0, overrides: {}, offerings: [] });
  });

  it('a guild stored as null is dropped and the rest load', () => {
    const cfg = load({ tiers: {}, subscriptions: { g0: null, g1: { active: manual('m1'), paused: [] } } });
    expect(Object.keys(cfg.subscriptions)).toEqual(['g1']);
    expect(cfg.subscriptions.g1.active.id).toBe('m1');
  });

  it('paused entries that are no subscription are dropped', () => {
    const cfg = load({ tiers: {}, subscriptions: { g1: { active: manual('m1'), paused: ['junk', null, { tierId: 5 }] } } });
    expect(cfg.subscriptions.g1.paused).toEqual([]);
  });

  it('a guild that holds only its notices channel keeps it', () => {
    const cfg = load({ tiers: {}, subscriptions: { g2: { notificationsChannelId: 'c1' } } });
    expect(cfg.subscriptions).toEqual({ g2: { paused: [], notificationsChannelId: 'c1' } });
  });

  it('an empty guild record, or one with an empty channel, is dropped', () => {
    const cfg = load({ tiers: {}, subscriptions: { g3: { notificationsChannelId: '' }, g5: {}, g6: { paused: [] } } });
    expect(cfg.subscriptions).toEqual({});
  });

  it('a channel id that is not a string is not kept', () => {
    const cfg = load({ tiers: {}, subscriptions: { g4: { active: manual('m4'), paused: [], notificationsChannelId: 5 } } });
    expect(Object.keys(cfg.subscriptions.g4).sort()).toEqual(['active', 'paused']);
  });

  it('eventsApplied keeps only finite numbers', () => {
    fs.writeFileSync(PREMIUM, '{"tiers":{},"eventsApplied":{"w1":"x","w2":1e999,"w3":4,"w4":null}}');
    const cfg = getPremiumManager().getFullConfig();
    expect(cfg.eventsApplied).toEqual({ w3: 4 });
  });

  it('eventsApplied stored as null, or with no finite mark, is left out', () => {
    expect('eventsApplied' in load({ tiers: {}, eventsApplied: null })).toBe(false);
    resetPremiumManager();
    expect('eventsApplied' in load({ tiers: {}, eventsApplied: { w1: 'x' } })).toBe(false);
    resetPremiumManager();
    expect('eventsApplied' in load({ tiers: {} })).toBe(false);
  });
});
