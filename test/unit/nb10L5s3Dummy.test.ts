import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  bot: true,
  depth: 0,
  raw: null as string | null,
  saves: [] as any[],
  refusals: [] as Array<[string, string]>,
  registered: [] as unknown[],
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', () => ({
  DataBackendUnavailableError: class extends Error { causeKey = 'io'; },
  onWriterTake: () => undefined,
  onSharedApplied: () => () => undefined,
  readRawStrict: () => h.raw,
  saveDataTracked: (_f: string, _o: unknown, data: unknown) => {
    h.saves.push(JSON.parse(JSON.stringify(data)));
    return { outcome: 'saved', ticket: {} };
  },
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/writeLedger', () => ({
  markRetried: () => undefined,
  outsideLedgers: (fn: () => unknown) => fn(),
  recordRefusal: (cause: string, doc: string) => { h.refusals.push([cause, doc]); },
}));
vi.mock('../../src/bot/internalSetup/utils/premiumManager', () => ({
  errnoOf: (e: any) => e?.code ?? 'io',
  isBotProcess: () => h.bot,
  isPremiumReplaying: () => false,
  registerCacheStop: (t: unknown) => { h.registered.push(t); },
  unregisterCacheStop: () => undefined,
  stopCause: (k: string) => (k === 'deposed' ? 'writer-lost' : 'not-ready'),
  stopWords: (k: string) => `stop words ${k}`,
}));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({ emitEvent: () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/maintenanceGate', () => ({ isMaintenanceGateClosed: () => false }));
vi.mock('../../src/bot/internalSetup/utils/writerLock', () => ({ writerLockDepth: () => h.depth }));

import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';

// The Dummy provider's stop and deposition: what it refuses, what it records, and its rechecks of state.json.

const DOC = 'global:payment-providers/dummy/state.json';
const PURCHASE = { guildId: 'g1', tierId: 't', offeringId: 'o', variantId: 'dummy_monthly_999' } as any;
let providers: DummyProvider[];

function make(): DummyProvider {
  const p = new DummyProvider();
  providers.push(p);
  return p;
}

function stateWith(label: string): string {
  return JSON.stringify({
    variants: { v1: { variantId: 'v1', label, amount: 100, currency: 'USD', durationDays: 30, recurring: true, active: true } },
    products: {}, coupons: {}, subscriptions: {}, nextId: 1,
  });
}

beforeEach(() => {
  Object.assign(h, { bot: true, depth: 0, raw: null, saves: [], refusals: [], registered: [] });
  providers = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const p of providers) p.dispose();
  vi.restoreAllMocks();
});

describe('in the bot process', () => {
  it('joins the premium stop steps when made', () => {
    const p = make();
    expect(h.registered).toEqual([p]);
  });

  it('a purchase deposed while it waited on its coupon saves nothing and records the refusal', async () => {
    const p = make();
    const pending = p.initiatePurchase({ ...PURCHASE, couponCode: 'TEST20' });
    p.markStopped('deposed');
    // NB6 decision 71 (sheet 3145): a save refused at the accept throws T20 with the accept's cause words.
    await expect(pending).rejects.toThrow('The Dummy provider did not save this change (writer-lost), so nothing was changed at the provider.');
    expect(h.saves).toEqual([]);
    expect(h.refusals).toEqual([['writer-lost', DOC]]);
  });

  it('a purchase after a deposition fails with the stop named and changes nothing', async () => {
    const p = make();
    p.markStopped('deposed');
    await expect(p.initiatePurchase(PURCHASE)).rejects.toThrow('The Dummy provider changed nothing: stop words deposed.');
    expect(h.saves).toEqual([]);
    expect(await p.listSubscriptionsForGuild('g1')).toEqual([]);
  });

  it('adminSetProduct after a deposition refuses and stores nothing', () => {
    const p = make();
    expect(p.adminListProducts().map(x => x.productId)).toEqual(['dummy_product_standard']);
    p.markStopped('deposed');
    p.adminSetProduct({ productId: 'p_new', label: 'New', variantIds: [] } as any);
    expect(p.adminListProducts().map(x => x.productId)).not.toContain('p_new');
    expect(h.saves).toEqual([]);
    expect(h.refusals).toEqual([['writer-lost', DOC]]);
  });
});

describe('in the web UI process', () => {
  it('keeps the loaded copy while this process holds the writer lock', async () => {
    h.bot = false;
    h.depth = 1;
    h.raw = stateWith('First');
    const p = make();
    expect((await p.fetchVariant('v1'))?.label).toBe('First');
    h.raw = stateWith('Second');
    expect((await p.fetchVariant('v1'))?.label).toBe('First');
    h.depth = 0;
    expect((await p.fetchVariant('v1'))?.label).toBe('Second');
  });
});
