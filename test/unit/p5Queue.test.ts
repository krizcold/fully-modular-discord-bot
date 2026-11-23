import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P5 claim 13 (sheet P5, Revision 9, Z8): an expired event for a queued entry removes it from the queue, with one audit
// line of reason `ended-while-queued` and one notice, for every provider; any other state for a queued entry leaves it
// paused with its held endDate and startDate, taking only the state's autoRenew and meta (the queued-entry guard in
// copyProviderState), so resumeNext later grants its remainingDaysAtPause. Both backends. PayPal in P5's world, Stripe
// in P3's, Server Boosting and Discord in P1's world beside a manual grant of a higher tier, the Dummy in
// P1's world with the real Dummy provider.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { ServerBoostingProvider } from '../../src/bot/internalSetup/utils/payment/boostProvider';
import { DiscordProvider } from '../../src/bot/internalSetup/utils/payment/discordProvider';
import { EXTRA_PLANS, heldPayPal, IDS, p5World, planId, TIERS, type Delivered } from '../helpers/p5World';
import { SubscriptionNotifier } from '../../src/bot/internalSetup/utils/subscriptionNotifier';
import { onceEnd, z5End } from '../helpers/p5Model';
import type { PayPalEvent } from '../helpers/p5PayPal';
import { FINAL_CYCLES, HOUR, onceKit, PL16, PL17, PL18 } from '../helpers/p5pOnce';
import { heldStripe, IDS as P3_IDS, p3World } from '../helpers/p3World';
import { BUYER, p1World, SERVERS } from '../helpers/p1World';
import { DUMMY_VARIANT, dummyDriver } from '../helpers/p2DummyDriver';
import { noticePayloads, notices } from '../helpers/p1Mocks';

const DAY = 86_400_000;
const T0 = Date.UTC(2027, 0, 31, 12);
const BACKENDS = [['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]] as const;

/** The audit lines of a queued entry's removal, for premium's subscription id. */
const queueEnds = (lines: any[], subscriptionId: string) => lines.filter(l => l.action === 'subscription.expire.paid' && l.subscriptionId === subscriptionId && l.metadata?.reason === 'ended-while-queued');
const msOf = (iso: string | null | undefined): number => Date.parse(String(iso));

describe.each(BACKENDS)('P5 claim 13 on %s: PayPal', (_name, backend) => {
  const w = p5World(backend);
  const HOLDER = `guild:${IDS[0]}`;
  beforeEach(async () => { await w.setup({ clock: T0, link: { gold: [EXTRA_PLANS.trial, planId('gold', 'cheap'), planId('gold', 'dear')] } }); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  const drain = async (): Promise<Delivered[]> => {
    const outs = await w.drain();
    await w.settle();
    outs.push(...await w.drain());
    return outs;
  };
  async function owned(level: 'low' | 'high', plan?: string): Promise<string> {
    const tierId = TIERS.guild[level];
    const reply = await w.buyMember(HOLDER, IDS[0], { tierId, plan: plan ?? planId(tierId, 'cheap') });
    if (!reply.subscriptionId) throw new Error(`the purchase made no subscription: ${JSON.stringify(reply.body)}`);
    w.fake.approve(reply.subscriptionId);
    await drain();
    return reply.subscriptionId;
  }
  const heldOf = (id: string) => heldPayPal(w.stored()).find(h => h.sub.providerSubId === id) ?? null;
  const ended = () => w.notices().filter(n => n.kind === 'paid.sub.expired');
  const record = () => w.stored()?.subscriptions?.[HOLDER] ?? null;

  it("a full refund of a queued subscription removes it: one audit line, one notice, and it never resumes", async () => {
    const high = await owned('high');
    const low = await owned('low');
    const queued = heldOf(low)!;
    expect(queued.location).toBe('paused');
    w.fake.refund(w.fake.latestSale(low)!.id);
    await drain();
    expect(heldOf(low)).toBeNull();
    expect(queueEnds(w.auditLines(), queued.sub.id)).toHaveLength(1);
    expect(ended()).toEqual([{ to: HOLDER, kind: 'paid.sub.expired' }]);
    expect(heldOf(high)?.location).toBe('active');
    w.fake.expire(high);
    await drain();
    expect(record()?.active ?? null).toBeNull();
    expect(w.auditLines().filter(l => l.action === 'subscription.resume')).toEqual([]);
  });

  it('a held queued one whose first payment failed is removed, and nothing resumes from it', async () => {
    const high = await owned('high');
    w.fake.fail('POST', /\/suspend$/, { status: 422, issue: 'SUBSCRIPTION_STATUS_INVALID' }, 20);
    const low = await owned('low', EXTRA_PLANS.trial);
    const queued = heldOf(low)!;
    expect(queued.location).toBe('paused');
    w.fake.changePlan(low, planId('gold', 'cheap'));
    w.fake.failPayment(low, { count: 1 });
    await drain();
    expect(heldOf(low)).toBeNull();
    expect(queueEnds(w.auditLines(), queued.sub.id)).toHaveLength(1);
    w.fake.expire(high);
    await drain();
    expect(record()?.active ?? null).toBeNull();
  });

  it('an active state with a later end for a queued entry leaves it paused with its held dates, taking the meta; it resumes with its days left', async () => {
    const high = await owned('high');
    const low = await owned('low');
    const queued = heldOf(low)!.sub;
    const meta = { paypalStatus: 'ACTIVE', planId: planId('gold', 'cheap'), computedEnd: new Date(T0 + 400 * DAY).toISOString(), marker: 'p5Queue' };
    getPaymentRegistry().emitEvent({ type: 'subscription.updated', providerId: 'paypal', providerSubId: low, holder: HOLDER as any, state: { status: 'active', startDate: new Date(T0 + DAY).toISOString(), endDate: new Date(T0 + 400 * DAY).toISOString(), autoRenew: false, meta } });
    await w.settle();
    const after = heldOf(low)!;
    expect(after.location).toBe('paused');
    expect(after.sub).toMatchObject({ status: 'paused', endDate: queued.endDate, startDate: queued.startDate, autoRenew: false, providerMeta: meta, remainingDaysAtPause: queued.remainingDaysAtPause });
    const from = Date.now();
    w.fake.expire(high);
    await drain();
    const resumed = heldOf(low)!;
    expect(resumed.location).toBe('active');
    expect(msOf(resumed.sub.endDate)).toBeGreaterThanOrEqual(from + queued.remainingDaysAtPause * DAY);
    expect(msOf(resumed.sub.endDate)).toBeLessThan(T0 + 400 * DAY);
  });

  it('an expired event for the active one ends it and resumes the queue, as before', async () => {
    const high = await owned('high');
    const low = await owned('low');
    w.fake.expire(high);
    await drain();
    expect([heldOf(high), heldOf(low)?.location]).toEqual([null, 'active']);
    expect(w.auditLines().filter(l => l.action === 'subscription.expire.paid').map(l => l.metadata?.reason)).toEqual([undefined]);
  });

  it('a declined price migration of a queued entry leaves it queued, paused, with its held end and auto-renew off', async () => {
    await owned('high');
    const low = await owned('low');
    const queued = heldOf(low)!.sub;
    const pm: any = getPremiumManager();
    const migration = await pm.scheduleMigration({
      providerId: 'paypal', sourceTierId: 'gold', sourceOfferingId: 'o-gold', sourceVariantId: planId('gold', 'cheap'),
      targetTierId: 'gold', targetOfferingId: 'o-gold', targetVariantId: planId('gold', 'dear'),
      effectiveDate: new Date(Date.now() + DAY).toISOString(), message: '',
    });
    await w.settle();
    expect(pm.recordMigrationDecision(migration.id, HOLDER, 'declined')).toBe(true);
    await w.settle();
    w.later(2 * DAY);
    await pm.processDueMigrations();
    await w.settle();
    expect(w.fake.subscriptions.get(low)!.status).toBe('CANCELLED');
    const after = heldOf(low)!;
    expect(after.location).toBe('paused');
    expect(after.sub).toMatchObject({ status: 'paused', endDate: queued.endDate, startDate: queued.startDate, autoRenew: false });
  });
});

describe.each(BACKENDS)('P5 claim 13 on %s: Stripe', (_name, backend) => {
  const w = p3World(backend);
  const HOLDER = `guild:${P3_IDS[0]}`;
  beforeEach(async () => {
    for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
    await w.setup();
    expect((await w.op('setTier', 'platinum', { displayName: 'Platinum', priority: 2, overrides: {}, offerings: [] })).ok).toBe(true);
    expect((await w.op('grantManual', HOLDER, 'platinum', 60)).ok).toBe(true);
  });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  const heldOf = () => heldStripe(w.stored()).find(h => h.holder === HOLDER) ?? null;
  async function queuedStripe(): Promise<string> {
    const bought = await w.buyMember(HOLDER, P3_IDS[1]);
    const session = w.fake.complete(bought.sessionId!, { paid: true });
    await w.drain();
    return session.subscription;
  }

  it("a refund of a queued subscription's latest charge removes it: one audit line, one notice, and it never resumes", async () => {
    const sub = await queuedStripe();
    const queued = heldOf()!;
    expect(queued.location).toBe('paused');
    w.fake.refund(w.fake.latestCharge(sub)!.id);
    await w.drain();
    expect(heldOf()).toBeNull();
    expect(queueEnds(w.auditLines(), queued.sub.id)).toHaveLength(1);
    expect(w.notices().filter(n => n.kind === 'paid.sub.expired')).toEqual([{ to: HOLDER, kind: 'paid.sub.expired' }]);
    expect((await w.op('revokeManual', HOLDER)).ok).toBe(true);
    expect(w.stored()?.subscriptions?.[HOLDER]?.active ?? null).toBeNull();
  });

  it('P5P B6 (review 1, B2): a queued Stripe entry resumed keeps a providerMeta equal to its queued one (no keptEnd)', async () => {
    await queuedStripe();
    const queued = heldOf()!;
    expect(queued.location).toBe('paused');
    expect((await w.op('revokeManual', HOLDER)).ok).toBe(true);
    const resumed = heldOf()!;
    expect(resumed.location).toBe('active');
    expect(resumed.sub.providerMeta).toEqual(queued.sub.providerMeta);
  });

  it('review 2 (A9): a manual grant of Gold in the active slot: a Stripe checkout of Gold is refused with no session', async () => {
    expect((await w.op('revokeManual', HOLDER)).ok).toBe(true);
    expect((await w.op('grantManual', HOLDER, 'gold', 30)).ok).toBe(true);
    const sessions = w.fake.calls.filter(c => c.method === 'POST' && c.path.startsWith('/v1/checkout/sessions')).length;
    const bought = await w.buyMember(HOLDER, P3_IDS[1]);
    expect([bought.status === 200, bought.sessionId]).toEqual([false, null]);
    expect(String(bought.body?.error ?? '')).toContain("You already have 'Gold' as a grant from this server's staff; a purchase at the same priority can start only after it ends or staff remove it.");
    expect(w.fake.calls.filter(c => c.method === 'POST' && c.path.startsWith('/v1/checkout/sessions')).length).toBe(sessions);
  });

  it.each(['invoice.paid', 'customer.subscription.updated'])('Stripe\'s pause failed and %s reads it active: it stays queued, paused, with its held end', async type => {
    w.fake.fail('POST', /^\/v1\/subscriptions\/sub_/, { status: 500 }, 20);
    const bought = await w.buyMember(HOLDER, P3_IDS[1]);
    const session = w.fake.complete(bought.sessionId!, { paid: true });
    const kept = w.fake.queue.filter(e => e.type === type);
    w.fake.queue.splice(0, w.fake.queue.length, ...w.fake.queue.filter(e => e.type !== type));
    await w.drain();
    const queued = heldOf()!;
    expect(queued.location).toBe('paused');
    expect(w.fake.subscriptions.get(session.subscription)!.pause_collection ?? null).toBeNull();
    const event = kept[0] ?? { id: 'evt_p5queue000001', object: 'event', type, created: Math.floor(Date.now() / 1000), api_version: '2024-11-20.acacia', data: { object: { ...w.fake.subscriptions.get(session.subscription) } } };
    await w.deliver(event as any);
    const after = heldOf()!;
    expect(after.location).toBe('paused');
    expect(after.sub).toMatchObject({ status: 'paused', endDate: queued.sub.endDate, startDate: queued.sub.startDate });
  });
});

describe.each(BACKENDS)('P5 claim 13 on %s: Server Boosting and Discord', (_name, backend) => {
  const w = p1World(backend);
  const G = SERVERS[0];
  const HOLDER = `guild:${G}`;
  beforeEach(async () => {
    await w.setup();
    for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
    notices.sent.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('p5Queue: no network'); }));
    expect((await w.grant(G, 'high', 60)).ok).toBe(true);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await w.teardown();
  });

  const queuedOf = (providerId: string) => (w.recordOf(G)?.paused ?? []).find((p: any) => p.providerId === providerId) ?? null;
  const ended = () => notices.sent.filter(n => n.kind === 'paid.sub.expired');
  /** The queued entry is removed with one line and one notice, and revoking the grant resumes nothing from it. */
  async function removed(providerId: string, id: string): Promise<void> {
    await w.settle();
    expect(queuedOf(providerId)).toBeNull();
    expect(queueEnds(w.auditLines(), id)).toHaveLength(1);
    expect(ended()).toEqual([{ to: HOLDER, kind: 'paid.sub.expired' }]);
    expect((await w.revoke(G)).ok).toBe(true);
    expect(w.recordOf(G)?.active ?? null).toBeNull();
  }

  it("Server Boosting's tick for a queued entry whose owner stopped boosting removes it", async () => {
    vi.stubEnv('BOOST_TARGET_GUILD_ID', '60000000000000001');
    const tiers = { low: { id: 'low', offerings: [{ id: 'o-low', providerLinks: [{ providerId: 'boost', enabled: true, priceConfig: { entries: [{ variantId: 'boost' }] } }] }] } };
    vi.spyOn(ServerBoostingProvider.prototype as any, 'premium').mockReturnValue({ getAllTiers: () => tiers });
    const members = new Map<string, any>([[BUYER, { premiumSince: new Date() }]]);
    const provider = new ServerBoostingProvider();
    (provider as any).client = { guilds: { fetch: async () => ({ members: { fetch: async () => undefined, cache: members } }), cache: new Map([[G, { ownerId: BUYER }]]) } };
    getPaymentRegistry().register(provider);
    await (provider as any).tickRun();
    await w.settle();
    const queued = queuedOf('boost');
    expect(queued).toMatchObject({ status: 'paused', providerSubId: `boost:${G}:${BUYER}:boost` });
    members.set(BUYER, { premiumSince: null });
    await (provider as any).tickRun();
    await removed('boost', queued.id);
  });

  it("Discord's entitlement delete for a queued entry (its gateway bridge) removes it", async () => {
    vi.stubEnv('DISCORD_APPLICATION_ID', '50000000000000001');
    vi.stubEnv('DISCORD_TOKEN', 'bot-token');
    const provider = new DiscordProvider();
    getPaymentRegistry().register(provider);
    const handlers: Record<string, (raw: any) => void> = {};
    provider.attachGatewayBridge((name, handler) => { handlers[name] = handler; });
    const raw = { id: '40000000000000901', sku_id: 'sku-low', guild_id: G, user_id: BUYER };
    // Discord's created event names no tier; premium installs one through an adoption, whose created event names it.
    getPaymentRegistry().emitEvent({ type: 'subscription.created', providerId: 'discord', providerSubId: raw.id, holder: HOLDER as any, buyerId: BUYER, tierId: 'low', offeringId: 'o-low', variantId: raw.sku_id, state: { status: 'active', startDate: new Date().toISOString(), endDate: new Date(Date.now() + 30 * DAY).toISOString(), autoRenew: true, meta: {} } });
    await w.settle();
    const queued = queuedOf('discord');
    expect(queued).toMatchObject({ status: 'paused', providerSubId: raw.id });
    handlers.entitlementDelete(raw);
    await removed('discord', queued.id);
  });
});

describe.each(BACKENDS)('P5 claim 13 on %s: the Dummy', (_name, backend) => {
  const driver = dummyDriver();
  const w = p1World(backend, driver);
  const G = SERVERS[0];
  beforeEach(async () => {
    await w.setup();
    for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
    notices.sent.length = 0;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await w.teardown();
  });

  async function queuedDummy(): Promise<any> {
    expect(await w.purchase(G, 'high')).toMatchObject({ ok: true });
    expect(await w.purchase(G, 'low')).toMatchObject({ ok: true });
    const queued = w.recordOf(G).paused.find((p: any) => p.tierId === 'low');
    expect(queued).toMatchObject({ status: 'paused', providerId: 'dummy' });
    return queued;
  }
  const walk = (type: 'subscription.expired' | 'subscription.renewed', queued: any, state: Record<string, unknown>) => {
    const sha = (getPremiumManager() as any).subscriptionReader.sha();
    getPaymentRegistry().emitWalkBatch({ premiumSha: sha, events: [{ type, providerId: 'dummy', providerSubId: queued.providerSubId, holder: `guild:${G}` as any, state: state as any }] });
  };

  it("a walk batch's expired event for a queued entry removes it, and nothing resumes from it", async () => {
    const queued = await queuedDummy();
    walk('subscription.expired', queued, { status: 'expired', startDate: queued.startDate, endDate: new Date().toISOString(), autoRenew: false, meta: {} });
    await w.settle();
    expect(w.recordOf(G).paused.find((p: any) => p.id === queued.id)).toBeUndefined();
    expect(queueEnds(w.auditLines(), queued.id)).toHaveLength(1);
    expect(notices.sent.filter(n => n.kind === 'paid.sub.expired')).toHaveLength(1);
    await w.cancelNow(G);
    expect(w.recordOf(G)?.active ?? null).toBeNull();
  });

  it('P5P B6 (review 1, B2): a queued Dummy entry resumed keeps a providerMeta equal to its queued one (no keptEnd)', async () => {
    const queued = await queuedDummy();
    await w.cancelNow(G);
    const resumed = w.recordOf(G).active;
    expect(resumed).toMatchObject({ id: queued.id, status: 'active' });
    expect(resumed.providerMeta).toEqual(queued.providerMeta);
  });

  it("a walk batch's renewed event for a queued entry leaves it paused with its held end", async () => {
    const queued = await queuedDummy();
    walk('subscription.renewed', queued, { status: 'active', startDate: new Date().toISOString(), endDate: new Date(Date.now() + 90 * DAY).toISOString(), autoRenew: true, meta: { walk: 1 } });
    await w.settle();
    const after = w.recordOf(G).paused.find((p: any) => p.id === queued.id);
    expect(after).toMatchObject({ status: 'paused', endDate: queued.endDate, startDate: queued.startDate, autoRenew: true, providerMeta: { walk: 1 } });
  });

  it('an accepted price migration of a queued entry leaves it queued, paused, with its held end', async () => {
    const queued = await queuedDummy();
    const pm: any = getPremiumManager();
    const migration = await pm.scheduleMigration({
      providerId: 'dummy', sourceTierId: 'low', sourceOfferingId: 'o-low', sourceVariantId: DUMMY_VARIANT,
      targetTierId: 'mid', targetOfferingId: 'o-mid', targetVariantId: DUMMY_VARIANT,
      effectiveDate: new Date(Date.now() + DAY).toISOString(), message: '',
    });
    await w.settle();
    // The holder's one decision is its active entry's; the queued entry's silence is applied under 'continue'.
    expect(migration.decisions.map((d: any) => d.providerSubId)).toContain(queued.providerSubId);
    expect(pm.setMigrationSilencePolicy('continue')).toBe(true);
    await w.settle();
    w.advance(2);
    await pm.processDueMigrations();
    await w.settle();
    const after = w.recordOf(G).paused.find((p: any) => p.id === queued.id);
    expect(after).toMatchObject({ status: 'paused', endDate: queued.endDate, tierId: 'mid' });
  });
});

// Sheet P5P, Q5: a pay-once subscription in the queue. Its payment is cancelled at PayPal (the second rule) instead of
// being suspended again; at a resume it is never activated, and premium's resumed end is kept in its meta (keptEnd).

const Q5_HOLDER = `guild:${IDS[0]}`;
const cancelPath = (id: string): RegExp => new RegExp(`^/v1/billing/subscriptions/${id}/cancel$`);
const onceRead = (id: string): PayPalEvent => ({ id: `WH-P5P-Q5-${id}-${Math.random().toString(36).slice(2)}`, event_version: '1.0', create_time: new Date().toISOString(), resource_type: 'subscription', resource_version: '2.0', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', summary: 'read', resource: { id }, links: [] });

describe.each(BACKENDS)('P5P Q5 on %s: a pay-once subscription in the queue [R1, R3, R8]', (_name, backend) => {
  const w = p5World(backend);
  const o = onceKit(w);
  beforeEach(async () => { await w.setup({ clock: T0 }); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });
  const record = () => w.stored()?.subscriptions?.[Q5_HOLDER] ?? null;
  const resumeWarnings = () => o.logged("[PremiumManager] provider resumeSubscription failed for 'paypal'");
  const pauseWarnings = () => o.logged("[PremiumManager] provider pauseSubscription failed for 'paypal'");
  /** The higher tier, renewing, held active. */
  const high = (plan: 'cheap' | 'dear' = 'cheap') => o.owned('guild', { level: 'high', renewing: true, plan: planId('platinum', plan) });
  /** The higher one ends at PayPal and its EXPIRED is delivered alone; premium resumes the queue. */
  async function endHigh(id: string): Promise<void> {
    w.fake.queue.length = 0;
    w.fake.expire(id);
    await w.deliverNext(0);
    await w.settle();
    await until(() => w.fake.queue.length > 0 || true);
  }
  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    await w.settle();
  }

  it.each(FINAL_CYCLES)('under %s: installed queued; the cancel follows (none when the read is EXPIRED); premium\'s suspend gets 422, reads it closed, no pause warning', async final => {
    await high();
    const id = await o.owned('guild', { settings: { finalCycle: final } });
    expect(o.heldOf(id)).toMatchObject({ location: 'paused', sub: { status: 'paused', autoRenew: false } });
    expect(o.cancels(id)).toBe(final === 'expire-at-payment' ? 0 : 1);
    expect(o.suspends(id)).toBe(1);
    expect(w.fake.subscriptions.get(id)!.status).toBe(final === 'expire-at-payment' ? 'EXPIRED' : 'CANCELLED');
    expect(pauseWarnings()).toEqual([]);
  });

  it("the cancel answering 503 at the install read, premium's suspend landing, the resend reading SUSPENDED: the cancel is made from SUSPENDED and lands; each later read keeps it queued with no suspend and no PL14", async () => {
    await high();
    const id = await o.buy('guild');
    w.fake.configure(id, { finalCycle: 'stays-active' });
    w.fake.approve(id);
    w.fake.fail('POST', cancelPath(id), { status: 503 });
    const first = await w.deliver(o.take('BILLING.SUBSCRIPTION.CREATED', id));
    expect(first.status).toBe(400);
    await w.settle();
    expect(w.fake.subscriptions.get(id)!.status).toBe('SUSPENDED');
    const held = o.heldOf(id)!.sub;
    const again = await w.deliver(onceRead(id));
    expect(again.status).toBe(200);
    expect([o.cancels(id), w.fake.subscriptions.get(id)!.status, o.suspends(id)]).toEqual([2, 'CANCELLED', 1]);
    await o.drain();
    expect(o.heldOf(id)).toMatchObject({ location: 'paused', sub: { status: 'paused', endDate: held.endDate, startDate: held.startDate, autoRenew: false } });
    expect(w.emitted.filter(e => e.providerSubId === id && e.type === 'subscription.paused')).toEqual([]);
    expect([o.suspends(id), o.logged('PayPal reported queued subscription')]).toEqual([1, []]);
  });

  it.each([['CANCELLED', 'stays-active'], ['EXPIRED', 'expire-at-payment']] as const)('the resume with the fake %s: its remaining days, one read and no other call, no resume warning', async (_status, final) => {
    const top = await high();
    const id = await o.owned('guild', { settings: { finalCycle: final } });
    const queued = o.heldOf(id)!.sub;
    const calls = w.fake.calls.length;
    const from = Date.now();
    await endHigh(top);
    const mine = w.fake.calls.slice(calls).filter(c => c.path.includes(id));
    expect(mine.map(c => `${c.method} ${c.path.split('?')[0]}`)).toEqual([`GET /v1/billing/subscriptions/${id}`]);
    expect(o.heldOf(id)?.location).toBe('active');
    expect(o.endOf(id)).toBeGreaterThanOrEqual(from + queued.remainingDaysAtPause * DAY);
    expect([o.activates(id), resumeWarnings()]).toEqual([0, []]);
  });

  it.each([['SUSPENDED', false], ['ACTIVE', true]] as const)('the resume with the fake %s (the cancel refused until then): one read and one cancel, PL16, no activate', async (status, suspendFails) => {
    const top = await high();
    const id = await o.buy('guild');
    w.fake.configure(id, { finalCycle: 'stays-active' });
    w.fake.approve(id);
    w.fake.fail('POST', cancelPath(id), { status: 503 });
    if (suspendFails) w.fake.fail('POST', new RegExp(`^/v1/billing/subscriptions/${id}/suspend$`), { status: 503 });
    expect((await w.deliver(o.take('BILLING.SUBSCRIPTION.CREATED', id))).status).toBe(400);
    await w.settle();
    expect(w.fake.subscriptions.get(id)!.status).toBe(status);
    const [cancelsBefore, readsBefore] = [o.cancels(id), o.reads(id)];
    await endHigh(top);
    await until(() => w.fake.subscriptions.get(id)!.status === 'CANCELLED');
    expect([o.reads(id) - readsBefore, o.cancels(id) - cancelsBefore, o.activates(id)]).toEqual([1, 1, 0]);
    expect(o.logged(PL16(id, 'guild'))).toHaveLength(1);
    expect(resumeWarnings()).toEqual([]);
  });

  it("the resume's cancel refused: the resume warning carries PC1's text, and no activate", async () => {
    const top = await high();
    const id = await o.buy('guild');
    w.fake.configure(id, { finalCycle: 'stays-active' });
    w.fake.approve(id);
    w.fake.fail('POST', cancelPath(id), { status: 503 });
    w.fake.fail('POST', new RegExp(`^/v1/billing/subscriptions/${id}/suspend$`), { status: 503 });
    await w.deliver(o.take('BILLING.SUBSCRIPTION.CREATED', id));
    await w.settle();
    w.fake.fail('POST', cancelPath(id), { status: 422, message: 'Refused by the p5p row.' });
    await endHigh(top);
    await until(() => resumeWarnings().length > 0);
    expect(resumeWarnings()).toEqual([`[PremiumManager] provider resumeSubscription failed for 'paypal': PayPal refused to cancel subscription ${id}: Refused by the p5p row. Its status at PayPal is ACTIVE.`]);
    expect(o.activates(id)).toBe(0);
  });

  it('keptEnd (X2, A3 part 2): a monthly pay-once queued behind a yearly tier and resumed after six months keeps its resumed end through later reads, and the checker frees it then', async () => {
    const top = await high('dear');
    const id = await o.owned('guild', { settings: { finalCycle: 'stays-active' } });
    w.later(180 * DAY);
    await endHigh(top);
    const resumed = o.heldOf(id)!;
    expect(resumed.location).toBe('active');
    expect(resumed.sub.providerMeta.keptEnd).toBe(resumed.sub.endDate);
    expect(onceEnd(w.fake, id)!).toBeLessThan(Date.now());
    for (const type of ['BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.EXPIRED']) {
      expect((await w.deliver({ ...onceRead(id), event_type: type })).status).toBe(200);
      expect(o.heldOf(id)?.sub).toMatchObject({ status: 'active', endDate: resumed.sub.endDate, autoRenew: false });
    }
    w.later(Date.parse(resumed.sub.endDate) - Date.now() - HOUR);
    await w.tick();
    expect(o.heldOf(id)?.location).toBe('active');
    w.later(2 * HOUR);
    await w.tick();
    expect(o.heldOf(id)).toBeNull();
  });

  it('keptEnd with a later sale taken after the resume (the cancel refused until then): the end stays keptEnd, PL17 once, and its refund changes nothing', async () => {
    const top = await high('dear');
    const id = await o.buy('guild');
    w.fake.configure(id, { finalCycle: 'stays-active', ignoreOverride: true });
    w.fake.approve(id);
    w.fake.fail('POST', cancelPath(id), { status: 503 }, 1000);
    w.fake.fail('POST', new RegExp(`^/v1/billing/subscriptions/${id}/suspend$`), { status: 503 });
    await w.deliver(o.take('BILLING.SUBSCRIPTION.CREATED', id));
    await w.settle();
    w.later(180 * DAY);
    await endHigh(top);
    await until(() => resumeWarnings().length > 0);
    const kept = o.heldOf(id)!.sub;
    expect(kept.providerMeta.keptEnd).toBe(kept.endDate);
    w.fake.renew(id, { at: Date.now() });
    const later = o.sales(id)[1];
    w.fake.clearFaults();
    w.fake.queue.length = 0;
    expect((await w.deliver(onceRead(id))).status).toBe(200);
    expect(o.heldOf(id)?.sub.endDate).toBe(kept.endDate);
    expect(o.logged(PL17(later, o.saleTime(later), id, 'guild'))).toHaveLength(1);
    w.fake.refund(later);
    await o.drain();
    expect(o.heldOf(id)?.sub).toMatchObject({ status: 'active', endDate: kept.endDate });
    expect(o.logged('PayPal took another payment')).toHaveLength(1);
  });

  it.each([['delivered', true], ['not delivered', false]] as const)('a later sale while queued (A1), its refund %s: queued with the same end and days, PL17 once, then it resumes with its days', async (_label, delivered) => {
    const top = await high();
    const id = await o.buy('guild');
    w.fake.configure(id, { finalCycle: 'stays-active', ignoreOverride: true });
    w.fake.approve(id);
    w.fake.fail('POST', cancelPath(id), { status: 503 }, 1000);
    w.fake.fail('POST', new RegExp(`^/v1/billing/subscriptions/${id}/suspend$`), { status: 503 });
    await w.deliver(o.take('BILLING.SUBSCRIPTION.CREATED', id));
    await w.settle();
    const queued = o.heldOf(id)!.sub;
    const due = Date.parse(w.fake.subscriptions.get(id)!.billing_info.next_billing_time);
    w.later(due - Date.now() + 60_000);
    w.fake.renew(id);
    const later = o.sales(id)[1];
    w.fake.clearFaults();
    w.fake.queue.length = 0;
    expect((await w.deliver(onceRead(id))).status).toBe(200);
    expect(o.logged(PL17(later, o.saleTime(later), id, 'guild'))).toHaveLength(1);
    w.fake.refund(later);
    if (delivered) await w.deliverNext(w.fake.queue.findIndex(e => e.event_type === 'PAYMENT.SALE.REFUNDED'));
    else await w.deliver(onceRead(id));
    expect(o.heldOf(id)).toMatchObject({ location: 'paused', sub: { endDate: queued.endDate, remainingDaysAtPause: queued.remainingDaysAtPause } });
    const T = o.saleTime(o.sales(id)[0]);
    expect(o.logged(PL18(later, id, 'guild', T, 'queue'))).toHaveLength(delivered ? 1 : 0);
    expect(o.logged('PayPal took another payment')).toHaveLength(1);
    const from = Date.now();
    await endHigh(top);
    expect(o.heldOf(id)?.location).toBe('active');
    expect(o.endOf(id)).toBeGreaterThanOrEqual(from + queued.remainingDaysAtPause * DAY);
  });

  it('a queued pay-once entry read unknown (pendingSale with omitLastPayment, review 1 B5): premium unchanged, the cancel tried again and landed', async () => {
    await high();
    const id = await o.buy('guild');
    w.fake.configure(id, { finalCycle: 'stays-active' });
    w.fake.approve(id);
    w.fake.fail('POST', cancelPath(id), { status: 503 });
    expect((await w.deliver(o.take('BILLING.SUBSCRIPTION.CREATED', id))).status).toBe(400);
    await w.settle();
    w.fake.queue.length = 0;
    expect(o.heldOf(id)?.location).toBe('paused');
    w.fake.configure(id, { pendingSale: true, omitLastPayment: true });
    const before = o.plain();
    const out = await w.deliver(onceRead(id));
    expect([out.status, o.plain(), w.fake.subscriptions.get(id)!.status]).toEqual([200, before, 'CANCELLED']);
  });

  it('a keptEnd set (Q6, review 1 B7): a read taking last_payment of a later sale while the list hides both moves the end on; the list released, the end goes back to keptEnd, never below', async () => {
    const top = await high('dear');
    const id = await o.buy('guild');
    w.fake.configure(id, { finalCycle: 'stays-active', ignoreOverride: true, listLag: true });
    w.fake.approve(id);
    w.fake.fail('POST', cancelPath(id), { status: 503 }, 1000);
    w.fake.fail('POST', new RegExp(`^/v1/billing/subscriptions/${id}/suspend$`), { status: 503 });
    await w.deliver(o.take('BILLING.SUBSCRIPTION.CREATED', id));
    await w.settle();
    w.later(2 * DAY);
    await endHigh(top);
    await until(() => resumeWarnings().length > 0);
    const keptEnd = o.heldOf(id)!.sub.providerMeta.keptEnd;
    expect(o.heldOf(id)!.sub.endDate).toBe(keptEnd);
    const due = Date.parse(w.fake.subscriptions.get(id)!.billing_info.next_billing_time);
    w.later(due - Date.now() + 60_000);
    w.fake.renew(id);
    w.fake.clearFaults();
    w.fake.queue.length = 0;
    await w.deliver(onceRead(id));
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
    expect(o.endOf(id)).toBeGreaterThan(Date.parse(keptEnd));
    w.fake.release(id, 'listLag');
    await w.deliver(onceRead(id));
    expect(onceEnd(w.fake, id)!).toBeLessThan(Date.parse(keptEnd));
    expect(o.heldOf(id)!.sub.endDate).toBe(keptEnd);
  });

  it('a full refund of its only sale while queued: it leaves the queue and never resumes', async () => {
    const top = await high();
    const id = await o.owned('guild', { settings: { finalCycle: 'expire-at-payment' } });
    expect(o.heldOf(id)?.location).toBe('paused');
    w.fake.refund(o.sales(id)[0]);
    await o.drain();
    expect(o.heldOf(id)).toBeNull();
    await endHigh(top);
    expect(record()?.active ?? null).toBeNull();
  });

  it('lpSkew of minus 30 seconds and listLag at the install read, then released: no PL17 for the one sale (Z4)', async () => {
    await high();
    const id = await o.owned('guild', { settings: { finalCycle: 'stays-active', lpSkew: -30, listLag: true } });
    w.fake.release(id, 'listLag');
    await w.deliver(onceRead(id));
    expect(o.heldOf(id)?.location).toBe('paused');
    expect(o.logged('PayPal took another payment')).toEqual([]);
  });

  it('a renewing PayPal entry resumed with days left gets keptEnd in its meta, its end following Z5 afterwards; the queued meta object is not changed', async () => {
    const top = await high();
    const id = await o.owned('guild', { renewing: true });
    const pm = o.premium();
    const queuedMeta = pm.config.subscriptions[Q5_HOLDER].paused[0].providerMeta;
    const metaText = JSON.stringify(queuedMeta);
    await endHigh(top);
    const resumed = pm.config.subscriptions[Q5_HOLDER].active;
    expect(resumed.providerMeta.keptEnd).toBe(resumed.endDate);
    expect(resumed.providerMeta).not.toBe(queuedMeta);
    expect(JSON.stringify(queuedMeta)).toBe(metaText);
    w.fake.queue.length = 0;
    await w.deliver(onceRead(id));
    const after = o.heldOf(id)!.sub;
    expect(after.providerMeta.keptEnd).toBeUndefined();
    expect(Date.parse(after.endDate)).toBe(z5End(w.fake, id, resumed).end);
  });

  it('an entry resumed with remainingDaysAtPause null gets no keptEnd (the null set on the queued entry in premium\'s memory: no writer leaves a paid PayPal entry so)', async () => {
    const top = await high();
    await o.owned('guild', { renewing: true });
    const pm = o.premium();
    pm.config.subscriptions[Q5_HOLDER].paused[0].remainingDaysAtPause = null;
    await endHigh(top);
    expect(pm.config.subscriptions[Q5_HOLDER].active.providerMeta.keptEnd).toBeUndefined();
  });

  it('the queue notice (B5): a pay-once active entry pushed into the queue gets the pay-once payload; a renewing one does not', async () => {
    const once = await o.owned('guild', { settings: { finalCycle: 'stays-active' } });
    noticePayloads.length = 0;
    notices.sent.length = 0;
    await o.owned('guild', { level: 'high', renewing: true });
    expect(o.heldOf(once)?.location).toBe('paused');
    const index = notices.sent.findIndex(n => n.kind === 'paid.sub.paused-by-stacking');
    expect(notices.sent.filter(n => n.kind === 'paid.sub.paused-by-stacking')).toHaveLength(1);
    expect(noticePayloads[index]).toMatchObject({ payOnce: true });
    await w.teardown();
    await w.setup({ clock: T0 });
    await o.owned('guild', { renewing: true });
    noticePayloads.length = 0;
    notices.sent.length = 0;
    await o.owned('guild', { level: 'high', renewing: true });
    const renewing = notices.sent.findIndex(n => n.kind === 'paid.sub.paused-by-stacking');
    expect(renewing).toBeGreaterThanOrEqual(0);
    expect((noticePayloads[renewing] as any).payOnce).toBeUndefined();
  });

  it("renewing entries (V5): a queued one PayPal expired still logs the resume warning with the activate's 422", async () => {
    const top = await high();
    const id = await o.owned('guild', { renewing: true });
    w.fake.expire(id);
    w.fake.queue.length = 0;
    await endHigh(top);
    await until(() => resumeWarnings().length > 0);
    expect(resumeWarnings()).toEqual(["[PremiumManager] provider resumeSubscription failed for 'paypal': The requested action could not be performed, semantically incorrect, or failed business validation."]);
  });
});

describe.each(BACKENDS)('P5P Q5 on %s: renewing PayPal entries at a resume (Z6)', (_name, backend) => {
  const w = p5World(backend);
  const o = onceKit(w);
  beforeEach(async () => { await w.setup({ clock: T0 }); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });
  const resumeWarnings = () => o.logged("[PremiumManager] provider resumeSubscription failed for 'paypal'");
  async function queuedBehind(): Promise<[string, string]> {
    const top = await o.owned('guild', { level: 'high', renewing: true });
    const id = await o.owned('guild', { renewing: true });
    return [top, id];
  }
  async function resume(top: string): Promise<void> {
    w.fake.queue.length = 0;
    w.fake.expire(top);
    await w.deliverNext(0);
    for (let i = 0; i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    await w.settle();
  }

  it("a renewing resume whose first read fails (review 1, B7): no activate, the resume warning with PayPal's answer", async () => {
    const [top, id] = await queuedBehind();
    w.fake.fail('GET', new RegExp(`^/v1/billing/subscriptions/${id}$`), { status: 500 });
    await resume(top);
    expect([o.activates(id), w.fake.subscriptions.get(id)!.status]).toEqual([0, 'SUSPENDED']);
    expect(resumeWarnings()).toEqual(["[PremiumManager] provider resumeSubscription failed for 'paypal': An internal server error has occurred."]);
  });

  it('an activate answered 422 while the fake reads ACTIVE: no resume warning', async () => {
    const [top, id] = await queuedBehind();
    w.fake.reactivate(id);
    w.fake.fail('POST', new RegExp(`^/v1/billing/subscriptions/${id}/activate$`), { status: 422, issue: 'SUBSCRIPTION_STATUS_INVALID' });
    await resume(top);
    expect([o.activates(id), resumeWarnings()]).toEqual([1, []]);
  });

  it("the same with the resume's read after the 422 answering 500: the resume warning names the original 422", async () => {
    const [top, id] = await queuedBehind();
    w.fake.reactivate(id);
    w.fake.fail('POST', new RegExp(`^/v1/billing/subscriptions/${id}/activate$`), { status: 422, message: 'Refused by the p5p row.' });
    const hold = w.fake.hold('POST', new RegExp(`^/v1/billing/subscriptions/${id}/activate$`));
    const resuming = resume(top);
    await hold.reached;
    w.fake.fail('GET', new RegExp(`^/v1/billing/subscriptions/${id}$`), { status: 500 });
    hold.release();
    await resuming;
    expect(resumeWarnings()).toEqual([`[PremiumManager] provider resumeSubscription failed for 'paypal': Refused by the p5p row.`]);
  });

  it('a pause of a renewing EXPIRED one still logs the pause warning (V5)', async () => {
    const id = await o.owned('guild', { renewing: true });
    w.fake.expire(id);
    w.fake.queue.length = 0;
    await o.owned('guild', { level: 'high', renewing: true });
    expect(o.logged("[PremiumManager] provider pauseSubscription failed for 'paypal'").length).toBeGreaterThan(0);
  });
});

describe('P5P Q5: the queue notice text (B5)', () => {
  const format = (payload: Record<string, unknown>): string => (new SubscriptionNotifier() as any).formatMessage('paid.sub.paused-by-stacking', payload, 'guild');

  it('a pay-once entry gets its own text; other entries keep today\'s', () => {
    expect(format({ tierName: 'Gold', providerName: 'PayPal', remainingDays: 20, payOnce: true })).toBe('**Subscription paused:** Your **Gold** (PayPal) subscription is queued behind a higher-tier plan. It was sold as one payment; its remaining paid time starts when it resumes. 20 days remaining.');
    expect(format({ tierName: 'Gold', providerName: 'PayPal', remainingDays: 20 })).toBe("**Subscription paused:** Your **Gold** (PayPal) subscription is queued behind a higher-tier plan and won't be billed until it resumes. 20 days remaining.");
    expect(format({ tierName: 'Gold', providerName: 'Stripe', remainingDays: 1 })).toBe("**Subscription paused:** Your **Gold** (Stripe) subscription is queued behind a higher-tier plan and won't be billed until it resumes. 1 day remaining.");
  });
});
