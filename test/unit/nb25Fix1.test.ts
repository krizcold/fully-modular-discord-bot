import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREMIUM_KEY, premiumRig } from '../helpers/nb6PremiumRig';
import { DAY_MS, dummyRig } from '../helpers/nb6DummyRig';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { pausedDaysLeft } from '../../src/bot/internalSetup/utils/premiumManager';

// NB25 code review round 1: a twin adoption in the same process is refused while one runs (C1); the orphan filter
// and the plans read the same cache (C2 and ops-1); an unreadable premium gives no plan that names a missing tier
// (C3); a recorded day count past 36500 falls back to the billing period (ops-2).

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  let registry: InstanceType<typeof real.PaymentProviderRegistry> | null = null;
  return { ...real, getPaymentRegistry: () => (registry ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

const r = premiumRig();
const d = dummyRig(r);
const AT = '2026-11-01T00:00:00.000Z';

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

const fake = {
  refs: [] as any[],
  list: null as Gate | null,
  listed: 0,
  resumeGates: [] as Gate[],
  resumes: [] as string[],
  pauses: [] as Array<[string, string | null, number | null | undefined]>,
};

function register(): void {
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { supportsPause: true }, isConfigured: () => true,
    listSubscriptionsForGuild: async (guildId: string) => {
      fake.listed += 1;
      if (fake.list) await fake.list.promise;
      return fake.refs.filter(ref => ref.metadata.guildId === guildId).map(ref => JSON.parse(JSON.stringify(ref)));
    },
    resumeSubscription: async (subId: string) => {
      fake.resumes.push(subId);
      const g = gate();
      fake.resumeGates.push(g);
      await g.promise;
    },
    pauseSubscription: async (subId: string, resumesAt: string | null, days?: number | null) => {
      fake.pauses.push([subId, resumesAt, days]);
    },
  } as any);
}

const pausedRef = (metadata: Record<string, unknown> = { pausedDaysLeft: 12, pausedAt: AT }) => ({
  providerSubId: 'orph',
  metadata: { guildId: 'g1', tierId: 'silver', offeringId: 'o2', ...metadata },
  state: { status: 'paused', startDate: new Date().toISOString(), endDate: new Date(Date.now() + 2 * DAY_MS).toISOString(), autoRenew: true },
  display: { amountLabel: '', periodLabel: '', statusLabel: 'paused' },
});
const asActive = (ref: any) => ({ ...ref, state: { ...ref.state, status: 'active', endDate: new Date(Date.now() + 12 * DAY_MS).toISOString() } });
const paid = (providerSubId: string, tierId: string) => ({
  id: `s_${providerSubId}`, tierId, source: 'paid', offeringId: tierId === 'gold' ? 'o1' : 'o2', providerId: 'fake', providerSubId,
  purchasedSnapshot: { offeringLabel: '', variantLabel: '', amount: 0, currency: '', durationDays: 30, tierDisplayName: tierId, tierPriority: 1, purchasedAt: new Date().toISOString() },
  startDate: new Date().toISOString(), endDate: new Date(Date.now() + 20 * DAY_MS).toISOString(), autoRenew: true, status: 'active',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

const orphans = () => r.pm().findOrphansForGuild('g1');
const planOf = async () => (await orphans()).find(o => o.ref.providerSubId === 'orph')?.plan;
const until = async (fn: () => boolean) => vi.waitFor(() => expect(fn()).toBe(true), { timeout: 5000, interval: 5 });
const RUNNING = "Subscription 'orph' was not adopted: another adoption of it is already running; reload the page when it has finished.";

beforeEach(async () => {
  await d.setup(true);
  register();
  fake.refs = [pausedRef()];
  fake.list = null;
  fake.listed = 0;
  fake.resumeGates = [];
  fake.resumes = [];
  fake.pauses = [];
});
afterEach(async () => {
  fake.list?.open();
  for (const g of fake.resumeGates) g.open();
  getPaymentRegistry().unregister('fake');
  await d.teardown();
});

describe('C1: a second adoption of the same orphan while one runs in this process', () => {
  it('with the same resume plan: refused before any provider call; the first installs it and nothing is paused', async () => {
    const plan = await planOf();
    expect(plan).toMatchObject({ kind: 'resume' });
    const first = r.pm().adoptOrphan('g1', 'fake', 'orph', plan);
    await until(() => fake.resumeGates.length === 1);
    await expect(r.pm().adoptOrphan('g1', 'fake', 'orph', plan)).rejects.toThrow(RUNNING);
    expect(fake.resumes).toEqual(['orph']);
    fake.resumeGates[0].open();
    expect(await first).toBe(true);
    await d.settle();
    expect(r.row()?.subscriptions?.g1?.active).toMatchObject({ providerSubId: 'orph', status: 'active' });
    expect(fake.pauses).toEqual([]);
  });

  it('listed active after the first resume landed at the provider (an install plan): refused, and the first installs it', async () => {
    const plan = await planOf();
    const first = r.pm().adoptOrphan('g1', 'fake', 'orph', plan);
    await until(() => fake.resumeGates.length === 1);
    fake.refs = [asActive(fake.refs[0])];
    const install = await planOf();
    expect(install).toMatchObject({ kind: 'install' });
    await expect(r.pm().adoptOrphan('g1', 'fake', 'orph', install)).rejects.toThrow(RUNNING);
    fake.resumeGates[0].open();
    expect(await first).toBe(true);
    await d.settle();
    expect(r.row()?.subscriptions?.g1?.active).toMatchObject({ providerSubId: 'orph', status: 'active' });
    expect(fake.pauses).toEqual([]);
  });

  it('after the first ends, a later adoption is no longer refused for it', async () => {
    const plan = await planOf();
    const first = r.pm().adoptOrphan('g1', 'fake', 'orph', plan);
    await until(() => fake.resumeGates.length === 1);
    fake.resumeGates[0].open();
    expect(await first).toBe(true);
    await d.settle();
    await expect(r.pm().adoptOrphan('g1', 'fake', 'orph', plan)).rejects.toThrow("Subscription 'orph' is already in the local cache.");
  });
});

describe('C2: a sub premium saves while the provider list is open', () => {
  it('is not listed as an orphan, so no plan reads it as a tie with itself', async () => {
    fake.list = gate();
    const listing = orphans();
    await until(() => fake.listed === 1);
    await d.otherPremium(config => { config.subscriptions.g1 = { active: paid('orph', 'silver'), paused: [] }; });
    fake.list.open();
    expect((await listing).map(o => o.ref.providerSubId)).toEqual([]);
  });
});

describe('C3: premium-tiers.json unreadable in this process', () => {
  it('a paused orphan with metadata gets the file refusal, never a missing tier', async () => {
    r.m.state.rows.put(PREMIUM_KEY, '{ not json');
    await runSharedPass();
    r.pm().getAllTiers();
    expect(r.pm().cacheState()).toBe('unreadable');
    const plan = await planOf();
    expect(plan?.kind).toBe('refuse');
    const reason = (plan as { reason: string }).reason;
    expect(reason).toMatch(/^premium-tiers\.json cannot be read in this process \(.+\); fix or restore it, then reload the page$/);
    expect(reason).not.toContain('does not exist');
    expect(plan?.line).toBe(`It cannot be adopted: ${reason}.`);
  });
});

describe('ops-2: a recorded day count no Date can hold', () => {
  it.each([[36500, 'recorded'], [36501, 'period'], [100000000, 'period']])('%s days read as %s', (days, from) => {
    const left = pausedDaysLeft(pausedRef({ pausedDaysLeft: days, pausedAt: AT }) as any, Date.now());
    expect(left.from).toBe(from);
    expect(left.days).toBe(from === 'recorded' ? days : 2);
  });

  it('the card offers a resume with the period days, and the adoption sends a valid end', async () => {
    fake.refs = [pausedRef({ pausedDaysLeft: 100000000, pausedAt: AT })];
    const plan = await planOf();
    expect(plan).toMatchObject({ kind: 'resume', days: 2, from: 'period' });
    const run = r.pm().adoptOrphan('g1', 'fake', 'orph', plan);
    await until(() => fake.resumeGates.length === 1);
    fake.resumeGates[0].open();
    expect(await run).toBe(true);
  });
});
