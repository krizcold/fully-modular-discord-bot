import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// premiumManager.ts on a JSON bot: a provider pause that fails with no error value is still logged as the pause's
// failure; a state event moves the active slot only for the active sub and keeps a paused state paused; the Dummy
// walk batch's save takes its audit lines and notices, is held when the disk refuses it, and is not applied while the
// file could not be read at its arrival; a cache whose first save is too large to store keeps its change; the reader's
// sha is null with no file; an adoption whose offering is gone names the offering.

const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
const notices = vi.hoisted(() => ({ sent: [] as Array<{ guildId: string; kind: string }> }));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async (guildId: string, kind: string) => {
    notices.sent.push({ guildId, kind });
    return { delivered: true, via: 'dm' };
  },
}));
const inject = vi.hoisted(() => ({ reads: [] as Error[], saves: [] as string[] }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  const { dataPath } = await import('../../src/utils/dataRoot');
  const premium = dataPath('global', 'premium-tiers.json');
  return {
    ...real,
    readRawStrict: (file: string) => {
      if (file === premium && inject.reads.length > 0) throw inject.reads.shift();
      return real.readRawStrict(file);
    },
    saveDataTracked: (file: string, opts: any, data: unknown) => {
      if (file === 'premium-tiers.json' && inject.saves.length > 0) return { outcome: 'refused', cause: inject.saves.shift() };
      return real.saveDataTracked(file, opts, data);
    },
  };
});

import { PremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { AUDIT, clearGlobal, jsonOf, linesOf, logged, paidSub, PREMIUM, quiet, settleQueue, state, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
let spies: ReturnType<typeof quiet>;
let managers: PremiumManager[] = [];
const provider = {
  pause: (): Promise<void> => Promise.resolve(),
  refs: [] as any[],
};

function manager(): PremiumManager {
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { supportsPause: true }, isConfigured: () => true,
    pauseSubscription: () => provider.pause(),
    listSubscriptionsForGuild: async () => provider.refs,
  } as any);
  const pm = new PremiumManager();
  managers.push(pm);
  pm.load();
  return pm;
}

const emit = (event: object) => getPaymentRegistry().emitEvent(event as any);
const read = (guildId: string, subId: string) => getPaymentRegistry().readSubscription('fake', guildId, subId);
const pausedSub = (id: string, subId: string) => ({ ...paidSub(id, subId, 'low'), status: 'paused' });
const later = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

beforeEach(async () => {
  spies = quiet();
  process.env.BOT_PROCESS_ROLE = 'bot';
  inject.reads = [];
  inject.saves = [];
  notices.sent = [];
  reg.current = null;
  provider.pause = () => Promise.resolve();
  provider.refs = [];
  await settleQueue();
  clearGlobal();
});
afterEach(async () => {
  vi.useRealTimers();
  for (const pm of managers.splice(0)) pm.dispose();
  await settleQueue();
  reg.current = null;
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('a provider pause that fails with no error value', () => {
  it('is logged as the failed pause, and the install still ends', async () => {
    writePremium({ g1: { active: paidSub('s1', 'h1', 'high'), paused: [] } });
    const pm = manager();
    provider.pause = () => Promise.reject(undefined);
    emit({ type: 'subscription.created', providerId: 'fake', providerSubId: 'c1', guildId: 'g1', tierId: 'low', offeringId: 'o1', state: state() });
    await pm.settled(undefined);
    expect(logged(spies.warn)).toContain("[PremiumManager] provider pauseSubscription failed for 'fake': undefined");
    expect(logged(spies.error).filter(l => l.includes('installAsyncSubscription failed'))).toEqual([]);
  });
});

describe('a state event on a paused subscription', () => {
  it('an expiry of a paused sub leaves the active sub in its slot', async () => {
    writePremium({ g1: { active: paidSub('s1', 'a1', 'high'), paused: [pausedSub('p', 'p1')] } });
    manager();
    emit({ type: 'subscription.expired', providerId: 'fake', providerSubId: 'p1', guildId: 'g1', state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() } });
    await settleQueue();
    const stored = jsonOf(PREMIUM).subscriptions.g1;
    expect(stored.active.id).toBe('s1');
    expect(stored.paused.map((s: any) => [s.id, s.status])).toEqual([['p', 'expired']]);
  });

  it('a provider state of paused is stored as paused', async () => {
    writePremium({ g1: { active: paidSub('s1', 'a1', 'high'), paused: [pausedSub('p', 'p1')] } });
    manager();
    emit({ type: 'subscription.updated', providerId: 'fake', providerSubId: 'p1', guildId: 'g1', state: state('paused', 40) });
    await settleQueue();
    expect(jsonOf(PREMIUM).subscriptions.g1.paused.map((s: any) => s.status)).toEqual(['paused']);
  });
});

describe("the Dummy tick's walk batch on a JSON bot", () => {
  it("an expiry's audit line is written and its notice sent", async () => {
    writePremium({ g1: { active: paidSub('s1', 'a1', 'low'), paused: [] } });
    manager();
    getPaymentRegistry().emitWalkBatch({
      premiumSha: null,
      events: [{ type: 'subscription.expired', providerId: 'fake', providerSubId: 'a1', guildId: 'g1', state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() } }],
    } as any);
    await settleQueue();
    expect(notices.sent).toEqual([{ guildId: 'g1', kind: 'paid.sub.expired' }]);
    expect(linesOf(AUDIT).filter(l => l.action === 'subscription.expire.paid').map(l => l.subscriptionId)).toEqual(['s1']);
  });

  it('a save the disk refuses is held: the cache keeps the renewal', async () => {
    writePremium({ g1: { active: paidSub('s1', 'a1', 'low'), paused: [] } });
    manager();
    const end = later(90);
    inject.saves = ['io'];
    getPaymentRegistry().emitWalkBatch({
      premiumSha: null,
      events: [{ type: 'subscription.renewed', providerId: 'fake', providerSubId: 'a1', guildId: 'g1', state: { ...state(), endDate: end } }],
    } as any);
    expect(read('g1', 'a1')?.endDate).toBe(end);
  });

  it('a batch that arrives while premium-tiers.json could not be read is not applied', async () => {
    writePremium({ g1: { active: paidSub('s1', 'a1', 'low'), paused: [] } });
    const before = jsonOf(PREMIUM).subscriptions.g1.active.endDate;
    inject.reads = [Object.assign(new Error('permission denied'), { code: 'EACCES' })];
    const pm = manager();
    expect(pm.unreadableText()).toContain('premium-tiers.json cannot be read (EACCES)');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6_000);
    getPaymentRegistry().emitWalkBatch({
      premiumSha: null,
      events: [{ type: 'subscription.renewed', providerId: 'fake', providerSubId: 'a1', guildId: 'g1', state: { ...state(), endDate: later(90) } }],
    } as any);
    vi.useRealTimers();
    await settleQueue();
    expect(logged(spies.warn).filter(l => l.includes('was not applied: premium-tiers.json cannot be read'))).toHaveLength(1);
    expect(jsonOf(PREMIUM).subscriptions.g1.active.endDate).toBe(before);
  });
});

describe('a first save too large to store', () => {
  it('keeps the change in the cache when no drop was asked for', () => {
    writePremium({ g1: { active: paidSub('s1', 'a1', 'high'), paused: [pausedSub('p', 'p1')] } });
    manager();
    const resumesAt = later(12);
    inject.saves = ['unstorable'];
    emit({ type: 'subscription.paused', providerId: 'fake', providerSubId: 'p1', guildId: 'g1', resumesAt });
    expect(read('g1', 'p1')).toMatchObject({ status: 'paused', resumesAt });
  });
});

describe("the reader's sha", () => {
  it('is null when premium-tiers.json does not exist', () => {
    manager();
    expect(getPaymentRegistry().subscriptionReaderSha()).toBeNull();
  });
});

describe('an adoption of an active orphan whose offering is gone', () => {
  it('names the tier and the missing offering', async () => {
    writePremium({});
    const pm = manager();
    provider.refs = [{ providerSubId: 'orph', state: state(), metadata: { tierId: 'low', offeringId: 'o9' } }];
    await expect(pm.adoptOrphan('g1', 'fake', 'orph', { kind: 'install' })).rejects.toThrow("Subscription 'orph' was not adopted: tier 'low' has no offering 'o9'.");
  });
});
