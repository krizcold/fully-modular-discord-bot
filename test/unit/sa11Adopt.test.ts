import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREMIUM_KEY, premiumRig } from '../helpers/nb6PremiumRig';
import { DAY_MS, dummyRig, dummyTier } from '../helpers/nb6DummyRig';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';

// L5 survivors of premiumManager's orphan adoption (NB25): the card lines and plans of a paused orphan with no end
// date, a tier with two offerings, the stop check after the list, the entry check after the refresh, the count of
// ended adoptions and cancels, and the texts of a failed resume or re-pause.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  let registry: InstanceType<typeof real.PaymentProviderRegistry> | null = null;
  return { ...real, getPaymentRegistry: () => (registry ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));
type Refresh = { ok: true } | { ok: false; cause: string; local?: true };
const mirror = vi.hoisted(() => ({ calls: 0, steps: [] as Array<(() => Promise<Refresh>) | null> }));
vi.mock('../../src/bot/internalSetup/utils/sharedMirror', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedMirror')>();
  return {
    ...real,
    refreshShared: (keys: string[] | null, end?: (e: Promise<void>) => void) => {
      if (Array.isArray(keys) && keys.length === 1 && keys[0] === 'global/premium-tiers.json') {
        mirror.calls += 1;
        const step = mirror.steps.shift();
        if (step) return step();
      }
      return real.refreshShared(keys, end);
    },
  };
});

const r = premiumRig();
const d = dummyRig(r);
const AT = '2026-11-01T00:00:00.000Z';
const NOT_OK: Refresh = { ok: false, cause: 'no answer within 10 s' };
const NOT_UP = 'the current premium settings could not be brought up to date from the database (no answer within 10 s)';

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

const fake = {
  refs: [] as any[],
  list: null as Gate | null,
  withPause: true,
  resumeFail: null as { value: unknown } | null,
  pauseFail: null as { value: unknown } | null,
  resumes: [] as Array<{ id: string; end: string | null }>,
  pauses: [] as Array<[string, string | null, number | null | undefined]>,
  cancels: [] as string[],
};

function register(): void {
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { supportsPause: true, supportsCancel: true }, isConfigured: () => true,
    listSubscriptionsForGuild: async (guildId: string) => {
      const held = fake.list;
      if (held) await held.promise;
      return fake.refs.filter(ref => ref.metadata.guildId === guildId).map(ref => JSON.parse(JSON.stringify(ref)));
    },
    resumeSubscription: async (subId: string, end: string | null) => {
      fake.resumes.push({ id: subId, end });
      if (fake.resumeFail) throw fake.resumeFail.value;
    },
    ...(fake.withPause ? {
      pauseSubscription: async (subId: string, resumesAt: string | null, days?: number | null) => {
        fake.pauses.push([subId, resumesAt, days]);
        if (fake.pauseFail) throw fake.pauseFail.value;
      },
    } : {}),
    cancelSubscription: async (subId: string) => {
      fake.cancels.push(subId);
    },
  } as any);
}

/** A paused orphan of the fake provider; `days: null` records no days, and `end: null` gives it no period end. */
const pausedRef = (over: { tierId?: string; offeringId?: string; days?: number | null; end?: number | null; autoRenew?: boolean } = {}) => ({
  providerSubId: 'orph',
  metadata: {
    guildId: 'g1', tierId: over.tierId ?? 'silver', offeringId: over.offeringId ?? 'o2',
    ...(over.days === null ? {} : { pausedDaysLeft: over.days ?? 12, pausedAt: AT }),
  },
  state: {
    status: 'paused', startDate: new Date().toISOString(),
    endDate: over.end === null ? null : new Date(Date.now() + (over.end ?? 2 * DAY_MS)).toISOString(),
    autoRenew: over.autoRenew ?? true,
  },
  display: { amountLabel: '', periodLabel: '', statusLabel: 'paused' },
});
const noEnd = (autoRenew = true) => pausedRef({ days: null, end: null, autoRenew });

const paid = (providerSubId: string, tierId: string) => ({
  id: `s_${providerSubId}`, tierId, source: 'paid', offeringId: tierId === 'gold' ? 'o1' : 'o2', providerId: 'fake', providerSubId,
  purchasedSnapshot: { offeringLabel: '', variantLabel: '', amount: 0, currency: '', durationDays: 30, tierDisplayName: tierId, tierPriority: 1, purchasedAt: new Date().toISOString() },
  startDate: new Date().toISOString(), endDate: new Date(Date.now() + 20 * DAY_MS).toISOString(), autoRenew: true, status: 'active',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

const planOf = async () => (await r.pm().findOrphansForGuild('g1')).find(o => o.ref.providerSubId === 'orph')?.plan;
const adopt = (shown: unknown) => r.pm().adoptOrphan('g1', 'fake', 'orph', shown);
const active = () => r.row()?.subscriptions?.g1?.active;
const logged = (text: string) => r.m.state.lines.filter(l => l.includes(text));
const PERIOD = " The days come from Fake's current billing period, because the bot did not record them when it was paused.";

async function boot(withPause = true): Promise<void> {
  fake.withPause = withPause;
  await d.setup(true);
  register();
  fake.refs = [pausedRef()];
  fake.list = null;
  fake.resumeFail = null;
  fake.pauseFail = null;
  fake.resumes = [];
  fake.pauses = [];
  fake.cancels = [];
  mirror.calls = 0;
  mirror.steps = [];
}
async function down(): Promise<void> {
  fake.list?.open();
  mirror.steps = [];
  getPaymentRegistry().unregister('fake');
  await d.teardown();
}

describe('a paused orphan with no end date', () => {
  beforeEach(() => boot());
  afterEach(down);

  it('alone: the resume plan has no days, no at, and a card line with no ending', async () => {
    fake.refs = [noEnd()];
    expect(await planOf()).toStrictEqual({
      kind: 'resume', days: null, from: 'period', autoRenew: true, call: true,
      line: `Adopting resumes this paused subscription at Fake.${PERIOD}`,
    });
  });

  it('behind a live higher sub: the queue plan has no at and its line names no resume time', async () => {
    await d.otherPremium(config => { config.subscriptions.g1 = { active: paid('hi1', 'gold'), paused: [] }; });
    fake.refs = [noEnd()];
    expect(await planOf()).toStrictEqual({
      kind: 'queue', days: null, from: 'period', activeTierId: 'gold', activeTier: 'Gold',
      line: `Adopting queues this paused subscription behind Gold; it stays paused at Fake until its turn in the queue.${PERIOD}`,
    });
  });

  it('adopting it logs the resume as with no end date, resumes it with no end and installs it active', async () => {
    fake.refs = [noEnd()];
    const plan = await planOf();
    expect(await adopt(plan)).toBe(true);
    expect(logged('[PremiumManager] Adoption is resuming Fake subscription orph for guild g1 with no end date.')).toHaveLength(1);
    expect(logged('[PremiumManager] Adoption resumed Fake subscription orph for guild g1 with no end date; the bot may not have saved it yet.')).toHaveLength(1);
    expect(fake.resumes).toEqual([{ id: 'orph', end: null }]);
    await d.settle();
    expect(active()).toMatchObject({ providerSubId: 'orph', status: 'active', endDate: null });
  });

  it.each([
    [true, 'it charges on its next billing date.'],
    [false, 'it stays resumed with no end date.'],
  ])('the re-pause fails after the refresh failed, autoRenew %s: the reply names what happens next', async (autoRenew, tail) => {
    fake.refs = [noEnd(autoRenew)];
    const plan = await planOf();
    fake.pauseFail = { value: new Error('network down') };
    mirror.steps.push(null, async () => NOT_OK);
    await expect(adopt(plan)).rejects.toThrow(
      `Subscription 'orph' was not adopted: it was resumed at Fake, but not installed: ${NOT_UP}. ` +
      `Pausing it again failed (network down); unless it is paused at Fake, ${tail}`,
    );
    expect(fake.pauses).toEqual([['orph', null, null]]);
  });
});

describe('a tier with two offerings', () => {
  beforeEach(() => boot());
  afterEach(down);

  it('an orphan of its second offering plans a resume, and adopting it installs it active', async () => {
    const tier: any = dummyTier('Silver', 1, 'o1');
    tier.offerings.push({ ...tier.offerings[0], id: 'o2', label: 'Silver two' });
    r.pm().setTier('silver', tier);
    await d.settle();
    expect(r.pm().getAllTiers().silver.offerings.map((o: any) => o.id)).toEqual(['o1', 'o2']);
    const plan = await planOf();
    expect(plan).toMatchObject({ kind: 'resume', days: 12, from: 'recorded' });
    expect(await adopt(plan)).toBe(true);
    expect(fake.pauses).toEqual([]);
    await d.settle();
    expect(active()).toMatchObject({ providerSubId: 'orph', tierId: 'silver', offeringId: 'o2', status: 'active' });
  });
});

describe('premium stopped during the list', () => {
  beforeEach(() => boot());
  afterEach(down);

  it.each(['stopping', 'deposed'] as const)('marked %s: adopting answers false with no refresh and no provider call', async kind => {
    const plan = await planOf();
    const held = gate();
    fake.list = held;
    const run = adopt(plan);
    await new Promise(resolve => setTimeout(resolve, 20));
    r.pm().markStopped(kind);
    mirror.steps.push(async () => NOT_OK);
    held.open();
    await expect(run).resolves.toBe(false);
    expect(mirror.calls).toBe(0);
    expect(fake.resumes).toEqual([]);
    expect(fake.pauses).toEqual([]);
  });
});

describe('premium unreadable after the refresh', () => {
  beforeEach(() => boot());
  afterEach(down);

  it('the row turned unreadable during the list: adopting answers false and nothing is resumed', async () => {
    const plan = await planOf();
    await d.settle();
    const good = r.m.state.rows.docs.get(PREMIUM_KEY)!.body.toString('utf8');
    const held = gate();
    fake.list = held;
    const run = adopt(plan);
    await new Promise(resolve => setTimeout(resolve, 20));
    r.m.state.rows.put(PREMIUM_KEY, '{ not json');
    held.open();
    await expect(run).resolves.toBe(false);
    expect(fake.resumes).toEqual([]);
    expect(r.pm().cacheState()).toBe('unreadable');
    r.m.state.rows.put(PREMIUM_KEY, good);
    await runSharedPass();
  });
});

describe('another adoption and a cancel ended during the list', () => {
  beforeEach(() => boot());
  afterEach(down);

  it('the first adoption is refused as ended elsewhere, with no resume', async () => {
    const plan = await planOf();
    const held = gate();
    fake.list = held;
    const first = adopt(plan);
    await new Promise(resolve => setTimeout(resolve, 20));
    fake.list = null;
    await expect(adopt({ kind: 'queue' })).rejects.toThrow("Subscription 'orph' was not adopted: what adopting it does is not what this page showed");
    expect(await r.pm().cancelOrphan('fake', 'orph')).toBe(true);
    expect(fake.cancels).toEqual(['orph']);
    held.open();
    await expect(first).rejects.toThrow("Subscription 'orph' was not adopted: another adoption or cancel of it ended after this one started; reload the page.");
    expect(fake.resumes).toEqual([]);
  });
});

describe('a failed resume or re-pause', () => {
  afterEach(down);

  it('the resume rejects with no error value: the reply says so', async () => {
    await boot();
    const plan = await planOf();
    fake.resumeFail = { value: undefined };
    await expect(adopt(plan)).rejects.toThrow("Subscription 'orph' was not adopted: the resume call to Fake failed (undefined).");
    expect(fake.resumes).toHaveLength(1);
  });

  it('the re-pause rejects with no error value: the reply names it and the charge', async () => {
    await boot();
    const plan = await planOf();
    fake.pauseFail = { value: undefined };
    mirror.steps.push(null, async () => NOT_OK);
    await expect(adopt(plan)).rejects.toThrow(
      `Subscription 'orph' was not adopted: it was resumed at Fake, but not installed: ${NOT_UP}. ` +
      'Pausing it again failed (undefined); unless it is paused at Fake, it charges in 12 days.',
    );
    expect(fake.pauses).toEqual([['orph', null, 12]]);
  });

  it('a provider with no pause call: the reply says it has none', async () => {
    await boot(false);
    const plan = await planOf();
    expect(plan).toMatchObject({ kind: 'resume', days: 12 });
    mirror.steps.push(null, async () => NOT_OK);
    await expect(adopt(plan)).rejects.toThrow(
      `Subscription 'orph' was not adopted: it was resumed at Fake, but not installed: ${NOT_UP}. ` +
      'Pausing it again failed (Fake has no pause call); unless it is paused at Fake, it charges in 12 days.',
    );
    expect(fake.resumes).toHaveLength(1);
  });
});
