import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { premiumRig } from '../helpers/nb6PremiumRig';
import { DAY_MS, dummyRig } from '../helpers/nb6DummyRig';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';

// NB25 code review round 3 (R3-ops-1): an adoption whose provider list was read before another adoption of the
// same sub ended is refused at the guard, even when that other adoption has already left it.

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
  listGate: null as Gate | null,
  listed: 0,
  resumeGates: [] as Gate[],
  resumeFails: false,
  resumes: [] as string[],
  pauses: [] as Array<[string, string | null, number | null | undefined]>,
};

function register(): void {
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { supportsPause: true }, isConfigured: () => true,
    listSubscriptionsForGuild: async (guildId: string) => {
      const refs = fake.refs.filter(ref => ref.metadata.guildId === guildId).map(ref => JSON.parse(JSON.stringify(ref)));
      fake.listed++;
      const held = fake.listGate;
      if (held) await held.promise;
      return refs;
    },
    resumeSubscription: async (subId: string) => {
      fake.resumes.push(subId);
      const g = gate();
      fake.resumeGates.push(g);
      await g.promise;
      if (fake.resumeFails) throw new Error('provider said no');
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
const STALE = "Subscription 'orph' was not adopted: another adoption or cancel of it ended after this one started; reload the page.";

beforeEach(async () => {
  await d.setup(true);
  register();
  fake.refs = [pausedRef()];
  fake.listGate = null;
  fake.listed = 0;
  fake.resumeGates = [];
  fake.resumeFails = false;
  fake.resumes = [];
  fake.pauses = [];
});
afterEach(async () => {
  fake.listGate?.open();
  for (const g of fake.resumeGates) g.open();
  getPaymentRegistry().unregister('fake');
  await d.teardown();
});

describe('R3-ops-1: an adoption whose list predates another adoption ending', () => {
  it('is refused at the guard and installs nothing from its stale list', async () => {
    const resumePlan = await planOf();
    expect(resumePlan).toMatchObject({ kind: 'resume' });
    fake.refs = [asActive(fake.refs[0])];
    const installPlan = await planOf();
    expect(installPlan).toMatchObject({ kind: 'install' });
    fake.refs = [pausedRef()];

    fake.resumeFails = true;
    const first = r.pm().adoptOrphan('g1', 'fake', 'orph', resumePlan);
    await until(() => fake.resumeGates.length === 1);

    fake.refs = [asActive(fake.refs[0])];
    const listed = fake.listed;
    fake.listGate = gate();
    const twin = r.pm().adoptOrphan('g1', 'fake', 'orph', installPlan);
    await until(() => fake.listed === listed + 1);

    fake.resumeGates[0].open();
    await expect(first).rejects.toThrow();
    fake.listGate.open();
    await expect(twin).rejects.toThrow(STALE);
    await d.settle();
    expect(fake.resumes).toEqual(['orph']);
    expect(r.row()?.subscriptions?.g1?.active ?? null).toBeNull();
  });

  it('an adoption that starts after the other one ended is judged on its own plan', async () => {
    const resumePlan = await planOf();
    fake.resumeFails = true;
    const first = r.pm().adoptOrphan('g1', 'fake', 'orph', resumePlan);
    await until(() => fake.resumeGates.length === 1);
    fake.resumeGates[0].open();
    await expect(first).rejects.toThrow();

    fake.resumeFails = false;
    fake.refs = [asActive(fake.refs[0])];
    const installPlan = await planOf();
    expect(installPlan).toMatchObject({ kind: 'install' });
    expect(await r.pm().adoptOrphan('g1', 'fake', 'orph', installPlan)).toBe(true);
    await d.settle();
    expect(r.row()?.subscriptions?.g1?.active).toMatchObject({ providerSubId: 'orph', status: 'active' });
  });
});
