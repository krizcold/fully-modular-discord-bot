import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { premiumRig } from '../helpers/nb6PremiumRig';
import { DAY_MS, dummyRig } from '../helpers/nb6DummyRig';
import { freshWriterLock } from '../helpers/nb10Rig';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';

// NB25 decisions 1 and 2 on a Postgres bot: the plan findOrphansFor shows for a paused orphan, by the server's
// live active subscription, and an adoption whose tier is deleted during the resume (T7).

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
  holdResumes: false,
  resumeGates: [] as Gate[],
  resumes: [] as string[],
  pauses: [] as Array<[string, string | null, number | null | undefined]>,
};

function register(): void {
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { sells: ['guild'], supportsPause: true }, isConfigured: () => true,
    listSubscriptionsFor: async (holder: string) => fake.refs.filter(ref => ref.metadata.holder === holder).map(ref => JSON.parse(JSON.stringify(ref))),
    resumeSubscription: async (subId: string) => {
      fake.resumes.push(subId);
      if (fake.holdResumes) {
        const g = gate();
        fake.resumeGates.push(g);
        await g.promise;
      }
    },
    pauseSubscription: async (subId: string, resumesAt: string | null, days?: number | null) => {
      fake.pauses.push([subId, resumesAt, days]);
    },
  } as any);
}

const pausedRef = (over: { tierId?: string; offeringId?: string | null; days?: number } = {}) => ({
  providerSubId: 'orph',
  metadata: {
    holder: 'guild:70000000000000001', buyerId: '80000000000000001', tierId: over.tierId ?? 'silver',
    ...(over.offeringId === null ? {} : { offeringId: over.offeringId ?? (over.tierId === 'gold' ? 'o1' : 'o2') }),
    pausedDaysLeft: over.days ?? 12, pausedAt: AT,
  },
  state: { status: 'paused', startDate: new Date().toISOString(), endDate: new Date(Date.now() + 2 * DAY_MS).toISOString(), autoRenew: true },
  display: { amountLabel: '', periodLabel: '', statusLabel: 'paused' },
});

const paid = (providerSubId: string, tierId: string, endMs = 20 * DAY_MS) => ({
  id: `s_${providerSubId}`, tierId, source: 'paid', buyerId: '80000000000000001', offeringId: tierId === 'gold' ? 'o1' : 'o2', providerId: 'fake', providerSubId,
  purchasedSnapshot: { offeringLabel: '', variantLabel: '', amount: 0, currency: '', durationDays: 30, tierDisplayName: tierId, tierPriority: 1, purchasedAt: new Date().toISOString() },
  startDate: new Date().toISOString(), endDate: new Date(Date.now() + endMs).toISOString(), autoRenew: true, status: 'active',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

async function seed(subs: { active?: unknown; paused?: unknown[] }, tiers: Record<string, unknown> = {}): Promise<void> {
  await d.otherPremium(config => {
    config.subscriptions['guild:70000000000000001'] = { paused: [], ...subs };
    Object.assign(config.tiers, tiers);
  });
}

const listed = async () => (await r.pm().findOrphansFor('guild:70000000000000001')).find(o => o.ref.providerSubId === 'orph');
const planOf = async () => (await listed())?.plan;
const RESUME_12 = 'Adopting resumes this paused subscription at Fake; its next charge is in 12 days. The days are the ones the bot recorded when it paused it on 2026-11-01.';
const TIE_SILVER = "It cannot be adopted: the server already has a 'Silver' subscription of the same priority; cancel one of them or let it end first.";

beforeEach(async () => {
  await d.setup(true);
  register();
  fake.refs = [pausedRef()];
  fake.holdResumes = false;
  fake.resumeGates = [];
  fake.resumes = [];
  fake.pauses = [];
});
afterEach(async () => {
  for (const g of fake.resumeGates) g.open();
  while (writerLockDepth() > 0) releaseWriterLock();
  freshWriterLock('webui');
  takeWriterLock();
  releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  getPaymentRegistry().unregister('fake');
  await d.teardown();
});

describe("findOrphansFor's plan for a paused orphan", () => {
  it('one recorded day reads "1 day"', async () => {
    fake.refs = [pausedRef({ days: 1 })];
    expect((await planOf())?.line).toBe('Adopting resumes this paused subscription at Fake; its next charge is in 1 day. The days are the ones the bot recorded when it paused it on 2026-11-01.');
  });

  it('a tierId with no offeringId has no plan', async () => {
    fake.refs = [pausedRef({ offeringId: null })];
    const orphan = await listed();
    expect(orphan).toBeDefined();
    expect(orphan!.plan).toBeUndefined();
  });

  it('an active sub of the same priority whose status is not active leaves the slot free: resume', async () => {
    await seed({ active: { ...paid('same1', 'silver'), status: 'expired' } });
    expect(r.pm().getHolderSubscriptions('guild:70000000000000001')?.active).toMatchObject({ providerSubId: 'same1', tierId: 'silver', status: 'expired' });
    expect(Date.parse(r.pm().getHolderSubscriptions('guild:70000000000000001')!.active!.endDate!)).toBeGreaterThan(Date.now());
    expect(await planOf()).toMatchObject({ kind: 'resume', days: 12, line: RESUME_12 });
  });

  it('an active sub of the same priority whose end is this very moment leaves the slot free: resume', async () => {
    const end = Date.now() + 5 * DAY_MS;
    await seed({ active: { ...paid('same1', 'silver'), endDate: new Date(end).toISOString() } });
    expect(await planOf()).toMatchObject({ kind: 'refuse', line: TIE_SILVER });
    vi.setSystemTime(end);
    expect(Date.now()).toBe(end);
    expect(await planOf()).toMatchObject({ kind: 'resume', days: 12, line: RESUME_12 });
  });

  it('a live active sub whose tier is gone counts as priority 0: a higher orphan resumes', async () => {
    await seed({ active: paid('ghost1', 'ghost') });
    expect(r.pm().getHolderSubscriptions('guild:70000000000000001')?.active).toMatchObject({ providerSubId: 'ghost1', tierId: 'ghost', status: 'active' });
    expect(await planOf()).toMatchObject({ kind: 'resume', days: 12, line: RESUME_12 });
  });

  it('a live active sub whose tier is gone, against an orphan of priority 0: refused as a tie named by the tier id', async () => {
    const zero = { displayName: 'Zero', priority: 0, overrides: {}, offerings: [{ id: 'o0', label: 'Zero', providerLinks: [] }] };
    await seed({ active: paid('ghost1', 'ghost') }, { zero });
    fake.refs = [pausedRef({ tierId: 'zero', offeringId: 'o0' })];
    expect(await planOf()).toMatchObject({
      kind: 'refuse',
      line: "It cannot be adopted: the server already has a 'ghost' subscription of the same priority; cancel one of them or let it end first.",
    });
  });
});

describe('an adoption whose tier is deleted during the resume', () => {
  it('over a live lower sub: T7 names the deleted tier, and the orphan is paused again with its days', async () => {
    freshWriterLock('bot', new Set([process.pid]));
    expect(takeWriterLock().kind).toBe('taken');
    await seed({ active: paid('low1', 'silver') });
    fake.refs = [pausedRef({ tierId: 'gold' })];
    const plan = await planOf();
    expect(plan).toMatchObject({ kind: 'resume', days: 12 });
    fake.holdResumes = true;
    const run = r.pm().adoptOrphan('guild:70000000000000001', 'fake', 'orph', plan);
    await vi.waitFor(() => expect(fake.resumeGates).toHaveLength(1), { timeout: 5000, interval: 5 });
    await d.otherPremium(config => { delete config.tiers.gold; }, false);
    fake.resumeGates[0].open();
    await expect(run).rejects.toThrow("Subscription 'orph' was not adopted: it was resumed at Fake, but not installed: tier 'gold' does not exist. It was paused again at Fake.");
    expect(fake.pauses.filter(p => p[0] === 'orph')).toEqual([['orph', null, 12]]);
  });
});
