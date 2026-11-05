import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  bot: true,
  replaying: false,
  raw: null as string | null,
  outcomes: [] as any[],
  saves: [] as any[],
  reads: 0,
  refusals: [] as Array<[string, string]>,
  retried: [] as string[],
  unregistered: [] as unknown[],
  events: [] as any[],
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', () => ({
  DataBackendUnavailableError: class extends Error { causeKey = 'io'; },
  onWriterTake: () => undefined,
  readRawStrict: () => { h.reads++; return h.raw; },
  saveDataTracked: (_f: string, _o: unknown, data: unknown) => {
    h.saves.push(JSON.parse(JSON.stringify(data)));
    return h.outcomes.length ? h.outcomes.shift() : { outcome: 'saved', ticket: {} };
  },
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/writeLedger', () => ({
  markRetried: (doc: string) => { h.retried.push(doc); },
  outsideLedgers: (fn: () => unknown) => fn(),
  recordRefusal: (cause: string, doc: string) => { h.refusals.push([cause, doc]); },
}));
vi.mock('../../src/bot/internalSetup/utils/premiumManager', () => ({
  errnoOf: (e: any) => e?.code ?? 'io',
  isBotProcess: () => h.bot,
  isPremiumReplaying: () => h.replaying,
  registerCacheStop: () => undefined,
  unregisterCacheStop: (t: unknown) => { h.unregistered.push(t); },
  stopCause: (k: string) => (k === 'deposed' ? 'writer-lost' : 'not-ready'),
  stopWords: (k: string) => `stop words ${k}`,
}));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({ emitEvent: (e: any) => { h.events.push(e); } }),
}));
vi.mock('../../src/bot/internalSetup/utils/maintenanceGate', () => ({ isMaintenanceGateClosed: () => false }));
vi.mock('../../src/bot/internalSetup/utils/writerLock', () => ({ writerLockDepth: () => 0 }));

import { DummyProvider, invalidateDummyCaches } from '../../src/bot/internalSetup/utils/payment/dummyProvider';

const REFUSED = { outcome: 'refused', cause: 'io' };
const DOC = 'global:payment-providers/dummy/state.json';
const VARIANT = { variantId: 'v_new', label: 'New', amount: 100, currency: 'USD', durationDays: 30, recurring: true, active: true };
let errors: string[];
let providers: DummyProvider[];

function make(): DummyProvider {
  const p = new DummyProvider();
  providers.push(p);
  return p;
}

function holdOne(p: DummyProvider): void {
  h.outcomes.push(REFUSED);
  p.adminSetVariant(VARIANT);
}

function heldLog(): string[] {
  return errors.filter(e => e.includes('holds changes the disk refused'));
}

function expiredState(autoRenew: boolean): string {
  const past = new Date(Date.now() - 1000).toISOString();
  return JSON.stringify({
    variants: {}, products: {}, coupons: {}, nextId: 2,
    subscriptions: {
      dummy_1: { providerSubId: 'dummy_1', guildId: 'g1', tierId: 't', offeringId: 'o', variantId: 'x', durationDays: 30,
        startDate: past, endDate: past, autoRenew, status: 'active', createdAt: past, updatedAt: past },
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(h, { bot: true, replaying: false, raw: null, outcomes: [], saves: [], reads: 0, refusals: [], retried: [], unregistered: [], events: [] });
  errors = [];
  providers = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const p of providers) p.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a save the disk refuses in the bot', () => {
  it('is not held or retried when the refusal is writer-lost', () => {
    const p = make();
    h.outcomes.push({ outcome: 'refused', cause: 'writer-lost' });
    p.adminSetVariant(VARIANT);
    expect(h.retried).toEqual([]);
    vi.advanceTimersByTime(5_000);
    expect(h.saves.length).toBe(1);
    p.finalStop();
    expect(heldLog()).toEqual([]);
  });

  it('arms one retry for two refused saves', () => {
    const p = make();
    holdOne(p);
    holdOne(p);
    expect(h.retried).toEqual([DOC, DOC]);
    expect(h.saves.length).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
    p.dispose();
    vi.advanceTimersByTime(10_000);
    expect(h.saves.length).toBe(2);
  });

  it('retries at 1 s, 2 s and 4 s while refused', () => {
    const p = make();
    holdOne(p);
    h.outcomes.push(REFUSED, REFUSED, REFUSED);
    vi.advanceTimersByTime(999);
    expect(h.saves.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(h.saves.length).toBe(2);
    vi.advanceTimersByTime(1_000);
    expect(h.saves.length).toBe(3);
    vi.advanceTimersByTime(1_999);
    expect(h.saves.length).toBe(3);
    vi.advanceTimersByTime(1);
    expect(h.saves.length).toBe(4);
    expect(h.saves[3].variants.v_new.label).toBe('New');
  });

  it('keeps retrying a held change after a retry refused as writer-lost', () => {
    const p = make();
    holdOne(p);
    h.outcomes.push({ outcome: 'refused', cause: 'writer-lost' });
    vi.advanceTimersByTime(1_000);
    expect(h.saves.length).toBe(2);
    vi.advanceTimersByTime(2_000);
    expect(h.saves.length).toBe(3);
    vi.advanceTimersByTime(10_000);
    expect(h.saves.length).toBe(3);
  });

  it('starts again at 1 s after a retry that saved', () => {
    const p = make();
    holdOne(p);
    h.outcomes.push(REFUSED);
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(2_000);
    expect(h.saves.length).toBe(3);
    holdOne(p);
    expect(h.saves.length).toBe(4);
    vi.advanceTimersByTime(1_000);
    expect(h.saves.length).toBe(5);
  });

  it('does not write again when a later save already wrote the held change', () => {
    const p = make();
    holdOne(p);
    p.adminSetVariant({ ...VARIANT, label: 'Later' });
    expect(h.saves.length).toBe(2);
    vi.advanceTimersByTime(10_000);
    expect(h.saves.length).toBe(2);
  });

  it('is not retried after dispose', () => {
    const p = make();
    holdOne(p);
    p.dispose();
    vi.advanceTimersByTime(10_000);
    expect(h.saves.length).toBe(1);
  });

  it('arms no retry once disposed', () => {
    const p = make();
    p.dispose();
    holdOne(p);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(h.saves.length).toBe(1);
  });
});

describe('markStopped', () => {
  it('refuses every later change and keeps the first kind', () => {
    const p = make();
    p.markStopped('deposed');
    p.markStopped('stopping');
    p.adminSetVariant(VARIANT);
    expect(h.saves).toEqual([]);
    expect(h.refusals).toEqual([['writer-lost', DOC]]);
    expect(p.adminListVariants().map(v => v.variantId)).not.toContain('v_new');
  });

  it('leaves no retry timer behind', () => {
    const p = make();
    holdOne(p);
    expect(vi.getTimerCount()).toBe(1);
    p.markStopped('deposed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('names the deposition in the refusal of a provider call', async () => {
    const p = make();
    p.markStopped('deposed');
    p.markStopped('stopping');
    await expect(p.cancelSubscription('dummy_1')).rejects.toThrow('The Dummy provider changed nothing: stop words deposed.');
  });
});

describe('finalStop', () => {
  it('makes one last save of a held change, logs nothing and refuses later changes', () => {
    const p = make();
    holdOne(p);
    p.finalStop();
    expect(h.saves.length).toBe(2);
    expect(h.saves[1].variants.v_new.label).toBe('New');
    expect(heldLog()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    p.adminSetVariant({ ...VARIANT, variantId: 'v_after' });
    expect(h.saves.length).toBe(2);
    expect(h.refusals).toEqual([['not-ready', DOC]]);
  });

  it('writes nothing when nothing is held', () => {
    const p = make();
    p.finalStop();
    expect(h.saves).toEqual([]);
    expect(heldLog()).toEqual([]);
  });

  it('logs a held change the last save could not write as lost with this stop', () => {
    const p = make();
    holdOne(p);
    h.outcomes.push(REFUSED);
    p.finalStop();
    expect(h.saves.length).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(heldLog()).toEqual(['[DummyProvider] payment-providers/dummy/state.json holds changes the disk refused; they are lost with this stop']);
  });

  it('logs a held change after a deposition as taken by another process', () => {
    const p = make();
    holdOne(p);
    p.markStopped('deposed');
    p.finalStop();
    expect(h.saves.length).toBe(1);
    expect(heldLog()).toEqual(['[DummyProvider] payment-providers/dummy/state.json holds changes the disk refused; they are lost: another process took the data files']);
  });

  it('does nothing on a disposed provider', () => {
    const p = make();
    holdOne(p);
    p.dispose();
    p.finalStop();
    expect(h.saves.length).toBe(1);
    expect(heldLog()).toEqual([]);
    h.outcomes.length = 0;
    p.adminSetVariant({ ...VARIANT, variantId: 'v_after' });
    expect(h.saves.length).toBe(2);
    expect(h.refusals).toEqual([]);
  });
});

describe('dispose', () => {
  it('stops the tick', () => {
    h.raw = expiredState(false);
    const p = make();
    p.start();
    p.dispose();
    vi.advanceTimersByTime(60_000);
    expect(h.events).toEqual([]);
  });

  it('takes the provider out of the premium stop steps', () => {
    const p = make();
    p.dispose();
    expect(h.unregistered).toEqual([p]);
  });

  it('takes the provider out of the writer-take cache drop', () => {
    h.raw = JSON.stringify({ variants: { a: { ...VARIANT, variantId: 'a' } }, products: {}, coupons: {}, subscriptions: {}, nextId: 1 });
    const p = make();
    expect(p.adminListVariants().map(v => v.variantId)).toEqual(['a']);
    p.dispose();
    h.raw = JSON.stringify({ variants: { b: { ...VARIANT, variantId: 'b' } }, products: {}, coupons: {}, subscriptions: {}, nextId: 1 });
    invalidateDummyCaches();
    expect(p.adminListVariants().map(v => v.variantId)).toEqual(['a']);
  });
});

describe('start and the tick', () => {
  it('arms one tick when started twice', () => {
    h.raw = expiredState(false);
    const p = make();
    p.start();
    p.start();
    p.stop();
    vi.advanceTimersByTime(60_000);
    expect(h.events).toEqual([]);
  });

  it('arms no tick once stopped', () => {
    const p = make();
    p.markStopped('stopping');
    p.start();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires nothing after a stop', () => {
    h.raw = expiredState(false);
    const p = make();
    p.start();
    p.markStopped('stopping');
    vi.advanceTimersByTime(60_000);
    expect(h.events).toEqual([]);
    expect(h.saves).toEqual([]);
  });

  it('expires nothing while premium replays', () => {
    h.raw = expiredState(false);
    const p = make();
    p.start();
    h.replaying = true;
    vi.advanceTimersByTime(60_000);
    expect(h.events).toEqual([]);
    h.replaying = false;
    vi.advanceTimersByTime(60_000);
    expect(h.events.map(e => e.type)).toEqual(['subscription.expired']);
  });
});

describe('initiatePurchase', () => {
  it('saves the new subscription and answers it', async () => {
    const p = make();
    const res = await p.initiatePurchase({ guildId: 'g1', tierId: 't', offeringId: 'o', variantId: 'dummy_monthly_999' } as any);
    expect(res.providerSubId).toBe('dummy_1');
    expect(res.state?.status).toBe('active');
    expect(h.saves.length).toBe(1);
    expect(h.saves[0].subscriptions.dummy_1.guildId).toBe('g1');
  });
});

describe('admin changes while stopped', () => {
  it('adminDeleteVariant refuses and keeps the variant', () => {
    const p = make();
    p.markStopped('stopping');
    expect(p.adminDeleteVariant('dummy_monthly_999')).toBe(false);
    expect(p.adminListVariants().map(v => v.variantId)).toContain('dummy_monthly_999');
    expect(h.refusals).toEqual([['not-ready', DOC]]);
  });

  it('adminDeleteProduct refuses and keeps the product', () => {
    const p = make();
    p.markStopped('stopping');
    expect(p.adminDeleteProduct('dummy_product_standard')).toBe(false);
    expect(p.adminListProducts().map(x => x.productId)).toContain('dummy_product_standard');
    expect(h.refusals).toEqual([['not-ready', DOC]]);
  });

  it('adminSetCoupon refuses and stores nothing', () => {
    const p = make();
    p.markStopped('stopping');
    expect(p.adminSetCoupon({ code: 'NEW10', percentOff: 10, usedCount: 0, createdAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
    expect(p.adminListCoupons().map(c => c.code)).not.toContain('NEW10');
    expect(h.refusals).toEqual([['not-ready', DOC]]);
  });

  it('adminDeleteCoupon refuses and keeps the coupon', () => {
    const p = make();
    p.markStopped('stopping');
    expect(p.adminDeleteCoupon('TEST20')).toBe(false);
    expect(p.adminListCoupons().map(c => c.code)).toContain('TEST20');
    expect(h.refusals).toEqual([['not-ready', DOC]]);
  });
});
