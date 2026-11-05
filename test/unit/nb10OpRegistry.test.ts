import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 14: the machine net for decision 9. In the web UI process, outside an op frame, every public method of
// PremiumManager and the Dummy provider is called with valid arguments against seeded records (active, paused, manual
// and orphan subscriptions, a link, a pending and a due migration, a product and a coupon); each one that tried a file
// write (the shared gate saw it) or raised a payment event must be a registered op or named in ALLOWED with the reason.

const net = vi.hoisted(() => ({ current: '', writers: new Set<string>(), raisers: new Set<string>() }));
const fake = vi.hoisted(() => ({ provider: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => ({
  ...(await orig<any>()),
  getPaymentRegistry: () => ({
    on: () => undefined, off: () => undefined, startTickers: () => undefined,
    get: (id: string) => (id === 'fake' ? fake.provider : undefined),
    list: () => [fake.provider], listAll: () => [fake.provider],
    emitEvent: () => { net.raisers.add(net.current); },
  }),
}));

import { PremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { flushAll, setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { DUMMY_METHODS, isRegisteredOp, PREMIUM_METHODS } from '../../src/bot/internalSetup/utils/sharedOps';
import { dataPath } from '../../src/utils/dataRoot';
import { put } from '../helpers/configRig';
import { readSourceText } from '../helpers/sourceText';

const G = '123456789012345678';
const GP = '223456789012345678';
const GN = '323456789012345678';
const GO = '423456789012345678';
const now = () => new Date().toISOString();
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const variant = (variantId: string) => ({ variantId, label: variantId, amount: 100, currency: 'USD', durationDays: 30, recurring: true, active: true });
const OFFERING = { id: 'o1', label: 'Gold', providerLinks: [{ providerId: 'fake', enabled: true, mode: 'price', cache: { syncedAt: now(), variants: [variant('v1'), variant('v2')] } }] };
const TIER = { displayName: 'Gold', priority: 10, overrides: {}, offerings: [OFFERING] };
const providerState = () => ({ status: 'active', startDate: now(), endDate: future(30), autoRenew: true });
const manual = (id: string, status: string) => ({ id, tierId: 'gold', source: 'manual', startDate: now(), endDate: future(1), autoRenew: false, status, createdAt: '', updatedAt: '' });
const paid = (id: string, providerSubId: string, status: string) => ({
  id, tierId: 'gold', source: 'paid', offeringId: 'o1', variantId: 'v1', providerId: 'fake', providerSubId,
  purchasedSnapshot: { offeringLabel: '', variantLabel: '', amount: 0, currency: '', durationDays: 30, tierDisplayName: 'Gold', tierPriority: 10, purchasedAt: now() },
  startDate: now(), endDate: future(30), autoRenew: true, status, createdAt: now(), updatedAt: now(),
});
const migration = (id: string, effectiveDate: string) => ({
  id, providerId: 'fake', sourceTierId: 'gold', sourceOfferingId: 'o1', sourceVariantId: 'v1', targetTierId: 'gold', targetOfferingId: 'o1', targetVariantId: 'v2',
  effectiveDate, message: '', scheduledAt: now(), scheduledBy: 'admin', status: 'pending',
  decisions: [{ guildId: GP, subscriptionId: 'p1', providerSubId: 'ps1', decision: 'pending' }],
});

const PREMIUM_ARGS: Record<string, unknown[]> = {
  setTier: ['gold', TIER],
  deleteTier: ['silver'],
  setMessages: [{ moduleBlocked: 'x' }],
  resetMessages: [],
  setGlobalModuleConfig: ['mod', { moduleEnabled: false }, {}],
  grantManual: [GN, 'gold', 30],
  extendManual: [G, 5],
  revokeManual: [G],
  initiatePaidSubscription: [GN, 'gold', 'o1', { providerId: 'fake', variantId: 'v1' }],
  cancelPaidSubscription: [GP],
  reactivatePaidSubscription: [GP],
  cancelPaidSubscriptionImmediately: [GP],
  cancelAndRemovePausedSubscription: [G, 'paused1'],
  adoptOrphan: [GO, 'fake', 'orph1'],
  cancelOrphan: ['fake', 'orph1'],
  linkAccount: ['fake', 'acct2', GN],
  unlinkAccount: ['patreon', 'acct'],
  unlinkProviderAccount: [GP, 'fake'],
  recordMigrationDecision: ['mig1', GP, 'accepted'],
  setNotificationsChannelId: [G, 'c1'],
  setProviderActivation: ['dummy', true, false],
  setMigrationSilencePolicy: ['continue'],
  scheduleMigration: [{ providerId: 'fake', sourceTierId: 'gold', sourceOfferingId: 'o1', sourceVariantId: 'v1', targetTierId: 'gold', targetOfferingId: 'o1', targetVariantId: 'v2', effectiveDate: future(10), message: 'm' }],
  cancelMigration: ['mig1'],
  processDueMigrations: [],
  setFullConfig: [{ tiers: { gold: TIER }, subscriptions: {}, messages: {}, providerAccountLinks: {}, activatedProviders: {}, migrations: [] }],
};
const DUMMY_ARGS: Record<string, unknown[]> = {
  adminSetVariant: [variant('dv1')],
  adminDeleteVariant: ['dummy_weekly_249'],
  adminSetProduct: [{ productId: 'p1', label: 'P', variantIds: ['dummy_weekly_249'] }],
  adminDeleteProduct: ['dummy_product_standard'],
  adminSetCoupon: [{ code: 'C1', percentOff: 10, usedCount: 0, createdAt: now() }],
  adminDeleteCoupon: ['TEST20'],
  initiatePurchase: [{ guildId: G, tierId: 'gold', offeringId: 'o1', variantId: 'dummy_weekly_249', autoRenew: true }],
  cancelSubscription: ['dsub1', true],
  reactivateSubscription: ['dsub1'],
  pauseSubscription: ['dsub1', null],
  resumeSubscription: ['dsub2', null],
  migrateSubscriptionPrice: ['dsub1', 'dummy_monthly_999', 'none'],
};
// Public writers that are not ops, and why the web UI never reaches them outside a premium op's frame.
const ALLOWED: Record<string, string> = {
  'premium.processDueMigrations': 'run by the expiry ticker, which starts only in the bot process',
  'premium.setFullConfig': 'no caller in src',
  'dummy.initiatePurchase': 'called only by PremiumManager.initiatePaidSubscription, an op',
  'dummy.cancelSubscription': 'called only by the premium cancel ops',
  'dummy.reactivateSubscription': 'called only by premium.reactivatePaidSubscription',
  'dummy.pauseSubscription': 'called only by an install that pauses the active subscription, inside an op or the bot',
  'dummy.resumeSubscription': 'called only by the expiry ticker or an op that resumes a paused subscription',
  'dummy.migrateSubscriptionPrice': 'called only by processDueMigrations in the bot process',
};
const SKIP = new Set(['constructor', 'dispose', 'start', 'stop', 'finalStop', 'markStopped', 'startExpiryChecker', 'startReplayIfReady']);

/** The methods a class source declares without private or protected, that the prototype holds. */
function methodsOf(obj: object, source: string): string[] {
  const text = readSourceText(__dirname, source);
  const declared = new Set([...text.matchAll(/^ {2}(?:public )?(?:async )?([a-zA-Z][A-Za-z0-9]*)[ ]*(?:<[^>]*>)?[(]/gm)].map(m => m[1]));
  const proto = Object.getPrototypeOf(obj) as Record<string, unknown>;
  return [...declared].filter(name => !SKIP.has(name) && typeof proto[name] === 'function');
}

async function callEach(prefix: string, make: () => any, source: string, args: Record<string, unknown[]>): Promise<string[]> {
  const called: string[] = [];
  for (const name of methodsOf(make(), source)) {
    // A fresh instance per method, so one method's state (a stop, a reload) never hides another's write.
    const target = make();
    net.current = `${prefix}.${name}`;
    called.push(net.current);
    try {
      const result = target[name](...(args[name] ?? [G, 'gold', 30]));
      if (result && typeof result.then === 'function') await result.catch(() => undefined);
    } catch {
      // A method that throws on these arguments wrote nothing through them.
    }
    await new Promise(resolve => setTimeout(resolve, 5));
    target.dispose?.();
  }
  net.current = '';
  return called;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval'] });
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  net.writers.clear();
  net.raisers.clear();
  fake.provider = {
    id: 'fake', displayName: 'Fake',
    capabilities: { canInitiatePurchase: true, supportsCancel: true, supportsReactivate: true, supportsCoupons: false, supportsPause: true, supportsPriceMigration: true, mechanism: 'immediate' },
    isConfigured: () => true,
    initiatePurchase: async () => ({ providerSubId: 'new1', state: providerState() }),
    cancelSubscription: async () => undefined,
    reactivateSubscription: async () => undefined,
    pauseSubscription: async () => undefined,
    resumeSubscription: async () => undefined,
    migrateSubscriptionPrice: async () => undefined,
    fetchVariant: async () => null,
    listSubscriptionsForGuild: async (guildId: string) => (guildId === GO
      ? [{ providerSubId: 'orph1', metadata: { tierId: 'gold', offeringId: 'o1', variantId: 'v1' }, state: providerState() }]
      : []),
  };
  await flushAll();
  put(dataPath('global', 'premium-tiers.json'), {
    tiers: { gold: TIER, silver: { displayName: 'Silver', priority: 5, overrides: {}, offerings: [] } },
    subscriptions: {
      [G]: { active: manual('m1', 'active'), paused: [manual('paused1', 'paused')] },
      [GP]: { active: paid('p1', 'ps1', 'active'), paused: [paid('p2', 'ps2', 'paused')] },
    },
    messages: {},
    providerAccountLinks: { fake: { acct1: GP }, patreon: { acct: G } },
    activatedProviders: { fake: { defaultEnabled: false } },
    migrations: [migration('mig1', future(10)), migration('migDue', new Date(Date.now() - 60_000).toISOString())],
    migrationSilencePolicy: 'cancel',
  });
  const dummyRecord = (providerSubId: string, paused: boolean) => ({
    providerSubId, guildId: G, tierId: 'gold', offeringId: 'o1', variantId: 'dummy_weekly_249', durationDays: 7, startDate: now(), endDate: future(7),
    autoRenew: true, status: paused ? 'paused' : 'active', paused: paused ? true : undefined, pausedAt: paused ? now() : undefined, resumesAt: paused ? null : undefined, createdAt: now(), updatedAt: now(),
  });
  put(dataPath('global', 'payment-providers', 'dummy', 'state.json'), {
    variants: { dummy_weekly_249: variant('dummy_weekly_249'), dummy_monthly_999: variant('dummy_monthly_999') },
    products: { dummy_product_standard: { productId: 'dummy_product_standard', label: 'Standard', variantIds: ['dummy_weekly_249'] } },
    coupons: { TEST20: { code: 'TEST20', percentOff: 20, usedCount: 0, createdAt: now() } },
    subscriptions: { dsub1: dummyRecord('dsub1', false), dsub2: dummyRecord('dsub2', true) },
    nextId: 3,
  });
  setSharedWriteGate(() => { if (net.current) net.writers.add(net.current); return false; });
});

afterEach(() => {
  setSharedWriteGate(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function judge(prefix: string, registered: readonly string[], called: string[]): void {
  const seen = new Set([...net.writers, ...net.raisers].filter(Boolean));
  expect(registered.map(m => `${prefix}.${m}`).filter(op => !seen.has(op))).toEqual([]);
  const allowed = Object.keys(ALLOWED).filter(op => op.startsWith(`${prefix}.`));
  expect(allowed.filter(op => !called.includes(op) || !seen.has(op))).toEqual([]);
  expect([...seen].filter(op => !isRegisteredOp(op) && !(op in ALLOWED)).sort()).toEqual([]);
}

describe('the op registry net', () => {
  it('every PremiumManager method that writes or raises an event is a registered op, and every op is seen writing', async () => {
    const called = await callEach('premium', () => new PremiumManager(), path.resolve(__dirname, '../../src/bot/internalSetup/utils/premiumManager.ts'), PREMIUM_ARGS);
    judge('premium', PREMIUM_METHODS, called);
  });

  it('every Dummy provider method that writes or raises an event is a registered op, and every op is seen writing', async () => {
    const called = await callEach('dummy', () => new DummyProvider(), path.resolve(__dirname, '../../src/bot/internalSetup/utils/payment/dummyProvider.ts'), DUMMY_ARGS);
    judge('dummy', DUMMY_METHODS, called);
  });
});
