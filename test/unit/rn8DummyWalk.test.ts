import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  backend: 'json' as 'json' | 'postgres',
  raw: null as string | null,
  saves: [] as any[],
  answers: new Map<string, any>(),
  batches: [] as any[],
}));

vi.mock('../../src/utils/envLoader', () => ({ resolveDataBackend: () => h.backend }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', () => ({
  DataBackendUnavailableError: class extends Error { causeKey = 'io'; },
  onWriterTake: () => undefined,
  onSharedApplied: () => () => undefined,
  readRawStrict: () => h.raw,
  saveDataTracked: (_f: string, _o: unknown, data: unknown) => {
    h.saves.push(JSON.parse(JSON.stringify(data)));
    return { outcome: 'saved', ticket: h.backend === 'postgres' ? { kind: 'row' } : { kind: 'file' } };
  },
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/writeLedger', () => ({
  currentLedger: () => undefined,
  markRetried: () => undefined,
  outsideLedgers: (fn: () => unknown) => fn(),
  runSealed: (_a: unknown, _b: unknown, _c: unknown, fn: () => unknown) => fn(),
  recordRefusal: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/sharedStore', () => ({
  rowOutcome: () => Promise.resolve('landed'),
  shaOf: (b: Buffer) => `sha-${b.length}`,
}));
vi.mock('../../src/bot/internalSetup/utils/premiumManager', () => ({
  errnoOf: (e: any) => e?.code ?? 'io',
  isBotProcess: () => true,
  registerCacheStop: () => undefined,
  unregisterCacheStop: () => undefined,
  stopCause: () => 'not-ready',
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

const T0 = Date.parse('2026-11-13T12:00:00.000Z');
const FUTURE = '2026-12-13T12:00:00.000Z';
const PAST = '2026-11-01T12:00:00.000Z';
const MONTHLY = 'dummy_monthly_999';
const VARIANTS = {
  [MONTHLY]: { variantId: MONTHLY, label: 'Monthly', amount: 999, currency: 'USD', durationDays: 30, recurring: true, active: true },
};

let providers: DummyProvider[];
let logs: string[];

function stateWith(fields: Record<string, unknown>): string {
  const r = {
    providerSubId: 'dummy_1', guildId: 'g1', tierId: 'gold', offeringId: 'o1', variantId: MONTHLY, durationDays: 30,
    startDate: PAST, endDate: FUTURE, autoRenew: true, status: 'active', createdAt: PAST, updatedAt: PAST, ...fields,
  };
  return JSON.stringify({ variants: VARIANTS, products: {}, coupons: {}, subscriptions: { dummy_1: r }, nextId: 10 }, null, 2);
}

async function tick(): Promise<void> {
  vi.advanceTimersByTime(60_000);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
  Object.assign(h, { backend: 'json', raw: null, saves: [], batches: [] });
  h.answers.clear();
  providers = [];
  logs = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
});

afterEach(() => {
  for (const p of providers) p.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a tick that only writes a record to premium\'s copy', () => {
  it.each(['json', 'postgres'] as const)('sends premium no walk batch on a %s bot', async backend => {
    h.backend = backend;
    h.raw = stateWith({ autoRenew: true });
    h.answers.set('dummy_1', { status: 'active', endDate: FUTURE, autoRenew: false, variantId: MONTHLY, resumesAt: null });
    const p = new DummyProvider();
    providers.push(p);
    p.start();
    await tick();
    await tick();
    expect(h.saves.length).toBe(1);
    expect(h.saves[0].subscriptions.dummy_1.autoRenew).toBe(false);
    expect(logs).toContain("[DummyProvider] Subscription dummy_1 now matches the bot's copy (autoRenew was true, now false); they differed at two checks a minute apart");
    expect(h.batches).toEqual([]);
  });
});
