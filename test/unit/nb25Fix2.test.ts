import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREMIUM_KEY, premiumRig } from '../helpers/nb6PremiumRig';
import { DAY_MS, dummyRig } from '../helpers/nb6DummyRig';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';

// NB25 code review round 2: a running adoption answers a twin before its plan check (C2-1); an unreadable
// premium-tiers.json names the file and the next step on every orphan card (C3-1).

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
  resumeGates: [] as Gate[],
  resumes: [] as string[],
  pauses: [] as Array<[string, string | null, number | null | undefined]>,
};

function register(): void {
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { supportsPause: true }, isConfigured: () => true,
    listSubscriptionsForGuild: async (guildId: string) =>
      fake.refs.filter(ref => ref.metadata.guildId === guildId).map(ref => JSON.parse(JSON.stringify(ref))),
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

const pausedRef = () => ({
  providerSubId: 'orph',
  metadata: { guildId: 'g1', tierId: 'silver', offeringId: 'o2', pausedDaysLeft: 12, pausedAt: AT },
  state: { status: 'paused', startDate: new Date().toISOString(), endDate: new Date(Date.now() + 2 * DAY_MS).toISOString(), autoRenew: true },
  display: { amountLabel: '', periodLabel: '', statusLabel: 'paused' },
});
const asActive = (ref: any) => ({ ...ref, state: { ...ref.state, status: 'active', endDate: new Date(Date.now() + 12 * DAY_MS).toISOString() } });

const planOf = async () => (await r.pm().findOrphansForGuild('g1')).find(o => o.ref.providerSubId === 'orph')?.plan;
const until = async (fn: () => boolean) => vi.waitFor(() => expect(fn()).toBe(true), { timeout: 5000, interval: 5 });
const RUNNING = "Subscription 'orph' was not adopted: another adoption of it is already running; reload the page when it has finished.";

beforeEach(async () => {
  await d.setup(true);
  register();
  fake.refs = [pausedRef()];
  fake.resumeGates = [];
  fake.resumes = [];
  fake.pauses = [];
});
afterEach(async () => {
  for (const g of fake.resumeGates) g.open();
  getPaymentRegistry().unregister('fake');
  await d.teardown();
});

describe('C2-1: a twin of a running adoption', () => {
  it('whose shown plan no longer matches gets the running refusal with its next step, not R7', async () => {
    const plan = await planOf();
    expect(plan).toMatchObject({ kind: 'resume' });
    const first = r.pm().adoptOrphan('g1', 'fake', 'orph', plan);
    await until(() => fake.resumeGates.length === 1);
    fake.refs = [asActive(fake.refs[0])];
    const twin = r.pm().adoptOrphan('g1', 'fake', 'orph', plan);
    await expect(twin).rejects.toThrow(RUNNING);
    await expect(twin).rejects.not.toThrow('what adopting it does is not what this page showed');
    expect(fake.resumes).toEqual(['orph']);
    fake.resumeGates[0].open();
    expect(await first).toBe(true);
    await d.settle();
    expect(r.row()?.subscriptions?.g1?.active).toMatchObject({ providerSubId: 'orph', status: 'active' });
    expect(fake.pauses).toEqual([]);
  });

  it('a refused plan check releases the guard, so the next adoption is judged on its own plan', async () => {
    const plan = await planOf();
    await expect(r.pm().adoptOrphan('g1', 'fake', 'orph', { ...plan, days: 3 })).rejects.toThrow('what adopting it does is not what this page showed');
    const run = r.pm().adoptOrphan('g1', 'fake', 'orph', plan);
    await until(() => fake.resumeGates.length === 1);
    fake.resumeGates[0].open();
    expect(await run).toBe(true);
  });
});

describe('C3-1: premium-tiers.json unreadable in this process', () => {
  it('the card names the file, its cause and the next step, and offers no adoption', async () => {
    r.m.state.rows.put(PREMIUM_KEY, '{ not json');
    await runSharedPass();
    r.pm().getAllTiers();
    expect(r.pm().cacheState()).toBe('unreadable');
    const plan = await planOf();
    expect(plan?.kind).toBe('refuse');
    const reason = (plan as { reason: string }).reason;
    expect(reason).toMatch(/^premium-tiers\.json cannot be read in this process \(.+\); fix or restore it, then reload the page$/);
    expect(plan?.line).toBe(`It cannot be adopted: ${reason}.`);
    expect(fake.resumes).toEqual([]);
  });
});
