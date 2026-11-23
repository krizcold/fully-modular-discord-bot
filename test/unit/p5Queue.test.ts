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
import { heldStripe, IDS as P3_IDS, p3World } from '../helpers/p3World';
import { BUYER, p1World, SERVERS } from '../helpers/p1World';
import { DUMMY_VARIANT, dummyDriver } from '../helpers/p2DummyDriver';
import { notices } from '../helpers/p1Mocks';

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
