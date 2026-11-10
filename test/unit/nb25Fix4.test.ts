import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { premiumRig } from '../helpers/nb6PremiumRig';
import { DAY_MS, dummyRig } from '../helpers/nb6DummyRig';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';

// NB25 code review round 4: the stale-list refusal's words, and orphan cancels held against adoptions of the
// same sub in one process.

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
  cancelGates: [] as Gate[],
  cancels: [] as string[],
  cancelFails: false,
};

function register(): void {
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { supportsPause: true, supportsCancel: true }, isConfigured: () => true,
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
    cancelSubscription: async (subId: string) => {
      fake.cancels.push(subId);
      const g = gate();
      fake.cancelGates.push(g);
      await g.promise;
      if (fake.cancelFails) throw new Error('provider said no');
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
const CANCEL_RUNNING = "Subscription 'orph' was not adopted: a cancel of it at the provider is running; reload the page when it has finished.";
const ADOPTION_RUNNING = "Subscription 'orph' was not cancelled: an adoption of it is running; reload the page when it has finished.";
const SECOND_CANCEL = "Subscription 'orph' was not cancelled: another cancel of it is already running; reload the page when it has finished.";

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
  fake.cancelGates = [];
  fake.cancels = [];
  fake.cancelFails = false;
});
afterEach(async () => {
  fake.listGate?.open();
  for (const g of fake.resumeGates) g.open();
  for (const g of fake.cancelGates) g.open();
  getPaymentRegistry().unregister('fake');
  await d.teardown();
});

describe('R4-ops-1: the stale-list refusal', () => {
  it('names an end after this adoption started when the other adoption ended during its list', async () => {
    const resumePlan = await planOf();
    fake.refs = [asActive(fake.refs[0])];
    const installPlan = await planOf();
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
    expect(fake.resumes).toEqual(['orph']);
  });
});

describe('R4-ops-2: an orphan cancel and an adoption of the same sub', () => {
  it('a cancel while the adoption resumes is refused and sends no cancel', async () => {
    const plan = await planOf();
    const first = r.pm().adoptOrphan('g1', 'fake', 'orph', plan);
    await until(() => fake.resumeGates.length === 1);
    await expect(r.pm().cancelOrphan('fake', 'orph')).rejects.toThrow(ADOPTION_RUNNING);
    expect(fake.cancels).toEqual([]);
    fake.resumeGates[0].open();
    expect(await first).toBe(true);
    await d.settle();
    expect(r.row()?.subscriptions?.g1?.active).toMatchObject({ providerSubId: 'orph', status: 'active' });
  });

  it('an adoption while the cancel runs is refused before any provider call', async () => {
    const plan = await planOf();
    const cancel = r.pm().cancelOrphan('fake', 'orph');
    await until(() => fake.cancelGates.length === 1);
    await expect(r.pm().adoptOrphan('g1', 'fake', 'orph', plan)).rejects.toThrow(CANCEL_RUNNING);
    expect(fake.resumes).toEqual([]);
    fake.cancelGates[0].open();
    expect(await cancel).toBe(true);
    await d.settle();
    expect(r.row()?.subscriptions?.g1?.active ?? null).toBeNull();
  });

  it('an adoption whose list was read before a cancel ended is refused as stale', async () => {
    const plan = await planOf();
    fake.listGate = gate();
    const adoption = r.pm().adoptOrphan('g1', 'fake', 'orph', plan);
    await until(() => fake.listed >= 2);
    const cancel = r.pm().cancelOrphan('fake', 'orph');
    await until(() => fake.cancelGates.length === 1);
    fake.cancelGates[0].open();
    expect(await cancel).toBe(true);
    fake.listGate.open();
    await expect(adoption).rejects.toThrow(STALE);
    expect(fake.resumes).toEqual([]);
    await d.settle();
    expect(r.row()?.subscriptions?.g1?.active ?? null).toBeNull();
  });

  it('a second cancel while one runs is refused, and a cancel after it ended is sent', async () => {
    const cancel = r.pm().cancelOrphan('fake', 'orph');
    await until(() => fake.cancelGates.length === 1);
    await expect(r.pm().cancelOrphan('fake', 'orph')).rejects.toThrow(SECOND_CANCEL);
    fake.cancelGates[0].open();
    expect(await cancel).toBe(true);
    const again = r.pm().cancelOrphan('fake', 'orph');
    await until(() => fake.cancelGates.length === 2);
    fake.cancelGates[1].open();
    expect(await again).toBe(true);
    expect(fake.cancels).toEqual(['orph', 'orph']);
  });

  it('a cancel the provider refuses frees the sub for a later cancel and adoption', async () => {
    fake.cancelFails = true;
    const cancel = r.pm().cancelOrphan('fake', 'orph');
    await until(() => fake.cancelGates.length === 1);
    fake.cancelGates[0].open();
    await expect(cancel).rejects.toThrow('provider said no');
    fake.cancelFails = false;
    const again = r.pm().cancelOrphan('fake', 'orph');
    await until(() => fake.cancelGates.length === 2);
    fake.cancelGates[1].open();
    expect(await again).toBe(true);
    expect(fake.cancels).toEqual(['orph', 'orph']);
    const plan = await planOf();
    const adoption = r.pm().adoptOrphan('g1', 'fake', 'orph', plan);
    await until(() => fake.resumeGates.length === 1);
    fake.resumeGates[0].open();
    expect(await adoption).toBe(true);
    expect(fake.resumes).toEqual(['orph']);
  });
});
