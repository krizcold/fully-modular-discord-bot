import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  backend: 'json' as 'json' | 'postgres',
  bot: true,
  raw: null as string | null,
  readFails: false,
  reads: 0,
  outcomes: [] as any[],
  saves: [] as any[],
  rowAnswer: 'landed' as any,
  applied: new Map<string, () => void>(),
  refusals: [] as Array<[string, string]>,
  answers: new Map<string, any>(),
  batches: [] as any[],
}));

vi.mock('../../src/utils/envLoader', () => ({ resolveDataBackend: () => h.backend }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', () => ({
  DataBackendUnavailableError: class extends Error { causeKey = 'io'; },
  onWriterTake: () => undefined,
  onSharedApplied: (key: string, fn: () => void) => { h.applied.set(key, fn); return () => h.applied.delete(key); },
  readRawStrict: () => {
    h.reads++;
    if (h.readFails) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    return h.raw;
  },
  saveDataTracked: (_f: string, _o: unknown, data: unknown) => {
    h.saves.push(JSON.parse(JSON.stringify(data)));
    if (h.outcomes.length) return h.outcomes.shift();
    return { outcome: 'saved', ticket: h.backend === 'postgres' ? { kind: 'row' } : { kind: 'file' } };
  },
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/writeLedger', () => ({
  currentLedger: () => undefined,
  markRetried: () => undefined,
  outsideLedgers: (fn: () => unknown) => fn(),
  runSealed: (_a: unknown, _b: unknown, _c: unknown, fn: () => unknown) => fn(),
  recordRefusal: (cause: string, doc: string) => { h.refusals.push([cause, doc]); },
}));
vi.mock('../../src/bot/internalSetup/utils/sharedStore', () => ({
  rowOutcome: () => Promise.resolve(h.rowAnswer),
  shaOf: (b: Buffer) => `sha-${b.length}`,
}));
vi.mock('../../src/bot/internalSetup/utils/premiumManager', () => ({
  errnoOf: (e: any) => e?.code ?? 'io',
  isBotProcess: () => h.bot,
  registerCacheStop: () => undefined,
  unregisterCacheStop: () => undefined,
  stopCause: (k: string) => (k === 'deposed' ? 'writer-lost' : 'not-ready'),
  stopWords: (k: string) => `stop words ${k}`,
}));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({
    subscriptionReaderReady: () => true,
    subscriptionReaderSha: () => 'premium-sha',
    readSubscription: (_p: string, _g: string, id: string) => h.answers.get(id) ?? null,
    emitWalkBatch: (b: any) => { h.batches.push(b); },
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/maintenanceGate', () => ({ isMaintenanceGateClosed: () => false }));
vi.mock('../../src/bot/internalSetup/utils/writerLock', () => ({ writerLockDepth: () => 0 }));

import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';

const KEY = 'global/payment-providers/dummy/state.json';
const DOC = 'global:payment-providers/dummy/state.json';
const DAY_MS = 86_400_000;
const T0 = Date.parse('2026-11-13T12:00:00.000Z');
const FUTURE = '2026-12-13T12:00:00.000Z';
const PAST = '2026-11-01T12:00:00.000Z';
const MONTHLY = 'dummy_monthly_999';
const YEARLY = 'dummy_yearly_9999';
const VARIANTS = {
  [MONTHLY]: { variantId: MONTHLY, label: 'Monthly', amount: 999, currency: 'USD', durationDays: 30, recurring: true, active: true },
  [YEARLY]: { variantId: YEARLY, label: 'Yearly', amount: 9999, currency: 'USD', durationDays: 365, recurring: true, active: true },
};

let providers: DummyProvider[];
let warns: string[];
let logs: string[];

function rec(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerSubId: id, guildId: 'g1', tierId: 'gold', offeringId: 'o1', variantId: MONTHLY, durationDays: 30,
    startDate: PAST, endDate: FUTURE, autoRenew: true, status: 'active', createdAt: PAST, updatedAt: PAST, ...fields,
  };
}

function stateWith(...records: Array<Record<string, unknown>>): string {
  const subscriptions: Record<string, unknown> = {};
  for (const r of records) subscriptions[r.providerSubId as string] = r;
  return JSON.stringify({ variants: VARIANTS, products: {}, coupons: {}, subscriptions, nextId: 10 }, null, 2);
}

function make(): DummyProvider {
  const p = new DummyProvider();
  providers.push(p);
  return p;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function tick(): Promise<void> {
  vi.advanceTimersByTime(60_000);
  await flush();
}

const lastSaved = (id: string): any => h.saves[h.saves.length - 1]?.subscriptions?.[id];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
  Object.assign(h, {
    backend: 'json', bot: true, raw: null, readFails: false, reads: 0, outcomes: [], saves: [], rowAnswer: 'landed',
    refusals: [], batches: [],
  });
  h.applied.clear();
  h.answers.clear();
  providers = [];
  warns = [];
  logs = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
});

afterEach(() => {
  for (const p of providers) p.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('another machine changes state.json', () => {
  it('drops the cache, so the next answer comes from the applied text', async () => {
    h.raw = stateWith(rec('dummy_1', { autoRenew: true }));
    const p = make();
    expect((await p.getSubscriptionState('dummy_1'))?.autoRenew).toBe(true);
    h.raw = stateWith(rec('dummy_1', { autoRenew: false }));
    expect((await p.getSubscriptionState('dummy_1'))?.autoRenew).toBe(true);
    h.applied.get(KEY)?.();
    expect((await p.getSubscriptionState('dummy_1'))?.autoRenew).toBe(false);
  });
});

describe('a change the database did not confirm', () => {
  const tail = "Can't confirm that the Dummy provider saved this change (the database's answer was lost), so the bot did not apply it. Check the subscription before trying again. If the provider saved it, the Dummy provider puts the subscription back to the bot's copy within about 2 minutes.";
  const calls: Array<[string, (p: DummyProvider) => Promise<unknown>]> = [
    ['cancel', p => p.cancelSubscription('dummy_1')],
    ['reactivate', p => p.reactivateSubscription('dummy_1')],
    ['pause', p => p.pauseSubscription('dummy_1', null)],
    ['resume', p => p.resumeSubscription('dummy_2', FUTURE)],
    ['migrate', p => p.migrateSubscriptionPrice('dummy_1', YEARLY, 'none')],
  ];
  it.each(calls)('%s answers T23 with the non-purchase tail', async (_name, call) => {
    h.backend = 'postgres';
    h.rowAnswer = 'unconfirmed';
    h.raw = stateWith(rec('dummy_1'), rec('dummy_2', { paused: true, status: 'paused', pausedAt: PAST, resumesAt: null }));
    const error: any = await call(make()).then(() => null, e => e);
    expect(error?.message).toBe(tail);
    expect(error?.code).toBe('unconfirmed');
  });
});

describe('a confirmed change on a Postgres bot', () => {
  it('leaves no 8 s bound timer behind once it answers', async () => {
    h.backend = 'postgres';
    h.raw = stateWith(rec('dummy_1'));
    const p = make();
    const state = await p.cancelSubscription('dummy_1');
    expect(state.autoRenew).toBe(false);
    expect(lastSaved('dummy_1').autoRenew).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a held save on a JSON bot', () => {
  it('answers at the accept, without waiting for the retry or the 8 s bound', async () => {
    h.backend = 'json';
    h.raw = stateWith(rec('dummy_1'));
    h.outcomes.push({ outcome: 'refused', cause: 'io' });
    const p = make();
    let answered: any = null;
    let failed: unknown = null;
    p.cancelSubscription('dummy_1').then(s => { answered = s; }, e => { failed = e; });
    await flush();
    expect(failed).toBeNull();
    expect(answered?.autoRenew).toBe(false);
  });
});

describe('reactivate', () => {
  it('refuses a record whose end date is exactly now, saving nothing', async () => {
    h.raw = stateWith(rec('dummy_1', { endDate: new Date(T0).toISOString(), autoRenew: false }));
    const p = make();
    const error: any = await p.reactivateSubscription('dummy_1').then(() => null, e => e);
    expect(error?.message).toBe("Dummy subscription 'dummy_1' is past its end date, so it was not reactivated.");
    expect(h.saves).toEqual([]);
  });
});

describe('a call on a record that does not exist', () => {
  const calls: Array<[string, (p: DummyProvider) => Promise<unknown>]> = [
    ['pause', p => p.pauseSubscription('nope', null)],
    ['resume', p => p.resumeSubscription('nope', null)],
    ['migrate', p => p.migrateSubscriptionPrice('nope', YEARLY, 'none')],
  ];
  it.each(calls)('%s answers T25 and saves nothing', async (_name, call) => {
    h.raw = stateWith(rec('dummy_1'));
    const error: any = await call(make()).then(() => null, e => e);
    expect(error?.message).toBe("Dummy subscription 'nope' not found.");
    expect(h.saves).toEqual([]);
  });
});

describe('migrate to another variant', () => {
  it('sets the end date one new duration from now', async () => {
    h.raw = stateWith(rec('dummy_1'));
    const p = make();
    const state = await p.migrateSubscriptionPrice('dummy_1', YEARLY, 'none');
    const expected = new Date(T0 + 365 * DAY_MS).toISOString();
    expect(state.endDate).toBe(expected);
    expect(lastSaved('dummy_1')).toMatchObject({ variantId: YEARLY, durationDays: 365, endDate: expected });
  });
});

describe('the tick against premium\'s answer', () => {
  const answerOf = (fields: Record<string, unknown> = {}) => ({ status: 'active', endDate: FUTURE, autoRenew: true, variantId: MONTHLY, resumesAt: null, ...fields });

  it('words a null value of a field other than endDate or resumesAt as null', async () => {
    h.raw = stateWith(rec('dummy_1', { autoRenew: null }));
    h.answers.set('dummy_1', answerOf({ autoRenew: true }));
    make().start();
    await tick();
    await tick();
    expect(lastSaved('dummy_1').autoRenew).toBe(true);
    expect(logs).toContain("[DummyProvider] Subscription dummy_1 now matches the bot's copy (autoRenew was null, now true); they differed at two checks a minute apart");
  });

  it('writes a record premium holds paused with pausedAt set to the write and logs it on a JSON bot', async () => {
    h.raw = stateWith(rec('dummy_1'));
    h.answers.set('dummy_1', answerOf({ status: 'paused' }));
    make().start();
    await tick();
    expect(h.saves).toEqual([]);
    await tick();
    expect(lastSaved('dummy_1')).toMatchObject({ status: 'paused', paused: true, resumesAt: null, pausedAt: new Date(T0 + 120_000).toISOString() });
    expect(logs).toContain("[DummyProvider] Subscription dummy_1 now matches the bot's copy (status was active, now paused); they differed at two checks a minute apart");
  });

  it('keeps pausedAt of a record already paused', async () => {
    h.raw = stateWith(rec('dummy_1', { status: 'paused', paused: true, pausedAt: PAST, resumesAt: null }));
    h.answers.set('dummy_1', answerOf({ status: 'paused', resumesAt: '2027-01-01T00:00:00.000Z' }));
    make().start();
    await tick();
    await tick();
    expect(lastSaved('dummy_1')).toMatchObject({ paused: true, pausedAt: PAST, resumesAt: '2027-01-01T00:00:00.000Z' });
  });

  it('keeps durationDays when premium\'s answer names the same variant', async () => {
    h.raw = stateWith(rec('dummy_1', { durationDays: 37 }));
    h.answers.set('dummy_1', answerOf({ endDate: '2027-02-01T00:00:00.000Z' }));
    make().start();
    await tick();
    await tick();
    expect(lastSaved('dummy_1')).toMatchObject({ endDate: '2027-02-01T00:00:00.000Z', durationDays: 37, variantId: MONTHLY });
  });

  it('writes a variant the provider no longer has and keeps durationDays', async () => {
    h.raw = stateWith(rec('dummy_1', { durationDays: 30 }));
    h.answers.set('dummy_1', answerOf({ variantId: 'gone_variant' }));
    make().start();
    await tick();
    await tick();
    expect(lastSaved('dummy_1')).toMatchObject({ variantId: 'gone_variant', durationDays: 30 });
  });

  it('expires a record whose answer leaves variantId out and agrees otherwise', async () => {
    h.raw = stateWith(rec('dummy_1', { endDate: PAST, autoRenew: false }));
    const answer: Record<string, unknown> = answerOf({ endDate: PAST, autoRenew: false });
    delete answer.variantId;
    h.answers.set('dummy_1', answer);
    make().start();
    await tick();
    expect(lastSaved('dummy_1')?.status).toBe('expired');
    expect(h.batches.flatMap(b => b.events).map((e: any) => [e.type, e.providerSubId])).toEqual([['subscription.expired', 'dummy_1']]);
  });

  it('forgets what it saw at a tick that found state.json unreadable', async () => {
    h.raw = stateWith(rec('dummy_1'));
    h.answers.set('dummy_1', answerOf({ status: 'paused' }));
    make().start();
    await tick();
    h.readFails = true;
    h.applied.get(KEY)?.();
    await tick();
    expect(warns.some(w => w.startsWith('[DummyProvider] Skipped the tick'))).toBe(true);
    h.readFails = false;
    await tick();
    expect(h.saves).toEqual([]);
    await tick();
    expect(lastSaved('dummy_1')?.status).toBe('paused');
  });

  it('does nothing once deposed', async () => {
    h.raw = stateWith(rec('dummy_1', { endDate: PAST, autoRenew: false }));
    const p = make();
    p.start();
    expect((await p.getSubscriptionState('dummy_1'))?.status).toBe('active');
    p.markStopped('deposed');
    await tick();
    expect(h.refusals).toEqual([]);
    expect(h.saves).toEqual([]);
    expect(warns).toEqual([]);
    expect((await p.getSubscriptionState('dummy_1'))?.status).toBe('active');
  });

  it('logs the walk event as not sent when the database answer was lost', async () => {
    h.backend = 'postgres';
    h.rowAnswer = 'unconfirmed';
    h.raw = stateWith(rec('dummy_1', { endDate: PAST, autoRenew: false }));
    make().start();
    await tick();
    expect(h.saves.length).toBe(1);
    expect(h.batches).toEqual([]);
    expect(warns).toContain("[DummyProvider] The subscription.expired event for subscription dummy_1 was not sent: can't confirm that the change was saved (the database's answer was lost)");
    expect(h.refusals.filter(([, d]) => d === DOC)).toEqual([]);
  });
});
