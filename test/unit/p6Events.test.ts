import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P6 claims 1 to 3 as part 1 builds them (sheet P6, section 10): the kinds Discord's store sells, the tier taken from
// the entitlement's SKU, and the state each gateway event gives. The real DiscordProvider and PremiumManager in the bot
// role over the JSON files (E1 and E6 also over the mirror rig), a real discord.js Client with the entitlement bridge attached, and the fake of
// helpers/p6Discord.ts as Discord (helpers/p6World.ts). Every event reaches the bridge through discord.js's own actions,
// so entitlementUpdate arrives as (old | null, new). Part 2 adds the rounds' halves: E5's install at the next check,
// E8's refusal at each round, and U1 to U4 (upgrades with the round 30 seconds after the events). Part 3: U5.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { dataPath } from '../../src/utils/dataRoot';
import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { PayPalProvider } from '../../src/bot/internalSetup/utils/payment/paypalProvider';
import { StripeProvider } from '../../src/bot/internalSetup/utils/payment/stripeProvider';
import { JOURNAL_KEY, PREMIUM_KEY } from '../helpers/nb6PremiumRig';
import { APP_ID, discordTime, ENTITLEMENT_TYPE, SKU, type FakeEntitlement } from '../helpers/p6Discord';
import { discordLink, GUILD, heldDiscord, p6World, START, tierDefOf, USERS } from '../helpers/p6World';
import { allowDropLines } from '../helpers/p1Guard';
import { noticePayloads } from '../helpers/p1Mocks';

const U = USERS[0];
const H = `user:${U}`;
const NAME = 'Discord App Monetization';
const MIN = 60_000;
const DAY = 86_400_000;

const PD1 = (id: string, sku: string) => `[DiscordProvider] Entitlement ${id} (SKU ${sku}) is for a server; this bot sells only user subscriptions through Discord, so no tier was given for it. Discord keeps billing it until it is cancelled or refunded in Discord.`;
const PD2 = 'Members buy Discord subscriptions in Discord; the bot cannot start one.';
const PD3 = (id: string, uid: string, sku: string) => `[PremiumManager] subscription.created from ${NAME} (subscription ${id}, user ${uid}) was not installed: no user tier has an offering that sells SKU '${sku}' through ${NAME}. Wire the SKU to one offering; the bot tries again at its next check.`;
const PD4 = (id: string, uid: string, sku: string, pairs: string) => `[PremiumManager] subscription.created from ${NAME} (subscription ${id}, user ${uid}) was not installed: SKU '${sku}' is sold by more than one offering (${pairs}). Wire it to one offering; the bot tries again at its next check.`;
const PD5 = (id: string, field: string) => `[DiscordProvider] Entitlement ${id} has a date that does not parse (${field}); the event was not applied. The next check reads it again.`;
const PD13 = (id: string, holderWords: string, label: string, variant: string) => `[PremiumManager] subscription.created from ${NAME} (subscription ${id}, ${holderWords}) was not installed: offering '${label}' does not sell variant '${variant}' through ${NAME}. The member cancels it in ${NAME}; the bot tries again at its next check.`;
const PD14 = (id: string, holderWords: string, tier: string) => `[PremiumManager] subscription.created from ${NAME} (subscription ${id}, ${holderWords}) was not installed: ${holderWords} already holds '${tier}' at that priority. If it replaces that subscription, it is installed once ${NAME} ends the old one; otherwise the member cancels it in ${NAME}.`;

const w = p6World('json');
const record = (holder = H): any => w.stored()?.subscriptions?.[holder] ?? null;
const heldOf = (id: string) => heldDiscord(w.stored()).find(h => h.sub.providerSubId === id) ?? null;
const discordEmits = () => w.emitted.filter(e => e.providerId === 'discord');
const iso = (ms: number) => new Date(ms).toISOString();

/** A stored entry as text with its local id and every ISO time replaced by its whole minutes from START. */
function normalized(entry: unknown): string {
  return JSON.stringify(entry)
    .replace(/"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/g, '"<id>"')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, m => `<${Math.floor((Date.parse(m) - START) / MIN)}m>`);
}

async function bought(sku: string, u: string = U): Promise<FakeEntitlement> {
  const ent = w.fake.purchase(u, sku);
  await w.deliverAll();
  return ent;
}

describe('P6 part 1, claims 1 to 3: Discord gateway events for user subscriptions', () => {
  beforeEach(async () => { await w.setup({ settings: { updateEndsAt: 'past' } }); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it("E2: a server entitlement's three events change nothing and log PD1 once", async () => {
    const ent = w.fake.purchase(U, SKU.A, { guildId: GUILD });
    w.fake.endAt(ent, Date.now() + 5 * MIN);
    w.fake.refund(ent);
    const before = w.storedText();
    expect(await w.deliverAll()).toBe(3);
    expect(w.storedText()).toBe(before);
    expect(discordEmits()).toEqual([]);
    expect(w.logged('[DiscordProvider]')).toEqual([PD1(ent.id, SKU.A)]);
  });

  it('E2b: Discord sells users only; a server tier with an enabled Discord link is refused at save, a user tier with one is saved', async () => {
    expect(w.provider.capabilities.sells).toEqual(['user']);
    expect(w.stored().tiers.vip.offerings[0].providerLinks[0]).toMatchObject({ providerId: 'discord', enabled: true });
    const before = w.storedText();
    const refused = await w.op('setTier', 'gold', { ...tierDefOf('gold', true), offerings: [{ id: 'o-g', label: 'Gold monthly', providerLinks: [discordLink([SKU.B])] }] });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining(`${NAME} does not sell server subscriptions; turn its link off on offering 'Gold monthly'.`) });
    expect(w.storedText()).toBe(before);
  });

  it('E2c: initiatePurchase throws PD2', async () => {
    await expect(w.provider.initiatePurchase({ holder: H as any, buyerId: U, tierId: 'vip', offeringId: 'o-a', variantId: SKU.A })).rejects.toThrow(PD2);
  });

  it('E5: an unwired SKU installs nothing and logs PD3; wired to one offering, the next check (checkNow) installs it', async () => {
    allowDropLines('L3');
    const ent = await bought(SKU.UNWIRED);
    expect(record()).toBeNull();
    expect(w.logged('[PremiumManager] subscription.created')).toEqual([PD3(ent.id, U, SKU.UNWIRED)]);
    const wired = await w.op('setTier', 'nova', { displayName: 'Nova', priority: 3, overrides: {}, kind: 'user', offerings: [{ id: 'o-n', label: 'Nova', providerLinks: [discordLink([SKU.UNWIRED])] }] });
    expect(wired.ok).toBe(true);
    await w.advance(45_000);
    expect(await w.round()).toBe(true);
    expect(record()?.active).toMatchObject({ tierId: 'nova', offeringId: 'o-n', providerSubId: ent.id });
  });

  it("E5b (re-review of part 1): an offering with an old disabled Discord link for another SKU and an enabled one for the bought SKU installs it", async () => {
    const def = tierDefOf('vip', true);
    def.offerings[0].providerLinks = [discordLink([SKU.B], false), discordLink([SKU.A])];
    expect((await w.op('setTier', 'vip', def)).ok).toBe(true);
    const ent = await bought(SKU.A);
    expect(record()?.active).toMatchObject({ tierId: 'vip', offeringId: 'o-a', variantId: SKU.A, providerSubId: ent.id });
    expect(w.logged('[PremiumManager] subscription.created')).toEqual([]);
  });

  it('E5b: a SKU wired to two offerings installs nothing and PD4 names both', async () => {
    allowDropLines('L3');
    const def = tierDefOf('vip', true);
    def.offerings[1].providerLinks = [discordLink([SKU.A])];
    expect((await w.op('setTier', 'vip', def)).ok).toBe(true);
    const ent = await bought(SKU.A);
    expect(record()).toBeNull();
    expect(w.logged('[PremiumManager] subscription.created')).toEqual([PD4(ent.id, U, SKU.A, 'VIP/VIP, VIP/VIP plus')]);
  });

  it('E5b: a disabled link does not sell the SKU', async () => {
    const def = tierDefOf('vip', true);
    def.offerings[1].providerLinks = [discordLink([SKU.A], false)];
    expect((await w.op('setTier', 'vip', def)).ok).toBe(true);
    const ent = await bought(SKU.A);
    expect(record()?.active).toMatchObject({ tierId: 'vip', offeringId: 'o-a', providerSubId: ent.id });
  });

  it('E3: an update whose ends_at has passed (R1 past) expires the active record and resumes the queue', async () => {
    const a = await bought(SKU.A);
    const b = await bought(SKU.B);
    expect(heldOf(a.id)?.location).toBe('paused');
    expect(heldOf(b.id)?.location).toBe('active');
    w.fake.endAt(b, w.fake.updateEnd());
    await w.deliverAll();
    expect(heldOf(b.id)).toBeNull();
    expect(record().active).toMatchObject({ providerSubId: a.id, status: 'active', endDate: null, autoRenew: true });
    expect(w.auditLines().filter(l => l.action === 'subscription.expire.paid')).toHaveLength(1);
    expect(w.notices().map(n => n.kind)).toEqual(['paid.sub.started', 'paid.sub.started', 'paid.sub.paused-by-stacking', 'paid.sub.expired', 'paid.sub.resumed-from-queue']);
  });

  it('E4c: a delete expires the active record, with deleted set and with it absent', async () => {
    const a = await bought(SKU.A);
    w.fake.refund(a);
    expect(w.fake.queue[0].data.deleted).toBe(true);
    await w.deliverAll();
    expect(heldDiscord(w.stored())).toEqual([]);
    const a2 = await bought(SKU.A2);
    w.fake.removeByTooling(a2);
    delete w.fake.queue[0].data.deleted;
    await w.deliverAll();
    expect(heldDiscord(w.stored())).toEqual([]);
    expect(w.notices().filter(n => n.kind === 'paid.sub.expired')).toHaveLength(2);
  });

  it('E4c: a delete removes a queued record and leaves the active one', async () => {
    const a = await bought(SKU.A);
    const b = await bought(SKU.B);
    w.fake.refund(a);
    await w.deliverAll();
    expect(heldOf(a.id)).toBeNull();
    expect(record().active).toMatchObject({ providerSubId: b.id, status: 'active' });
    expect(record().paused).toEqual([]);
    expect(w.auditLines().filter(l => l.action === 'subscription.expire.paid' && l.metadata?.reason === 'ended-while-queued')).toHaveLength(1);
  });

  it('E4e: an ends_at that does not parse changes nothing: the NaN discord.js makes of it in an update event logs PD5, and REST text in a list page and in a single read is left alone', async () => {
    await w.teardown();
    await w.setup({ settings: { updateEndsAt: 'past', staleReads: 0, cancelShowsEndsAt: true } });
    const a = await bought(SKU.A);
    w.fake.memberCancel(a);
    await w.advance(31_000);
    expect(record().active).toMatchObject({ endDate: iso(a.endsAt!), autoRenew: false });
    const before = w.storedText();
    const raw = { ...w.fake.jsonOf(a), ends_at: 'the 31st of never' };
    w.fake.queue.push({ name: 'entitlementUpdate', data: raw, entitlementId: a.id, queuedAt: Date.now() });
    await w.deliverAll();
    expect(w.storedText()).toBe(before);
    expect(w.logged('[DiscordProvider]')).toEqual([PD5(a.id, 'ends_at')]);
    const real = w.fake.fetch.bind(w.fake);
    const reads: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const answer = await real(String(url), init);
      if (!String(url).includes('/entitlements')) return answer;
      const body = await answer.clone().json().catch(() => null);
      const bad = (e: any) => (e && e.id === a.id ? { ...e, ends_at: 'the 31st of never' } : e);
      if (Array.isArray(body)) return new Response(JSON.stringify(body.map(bad)), { status: answer.status, headers: { 'content-type': 'application/json' } });
      if (body && body.id === a.id) {
        reads.push(body.id);
        return new Response(JSON.stringify(bad(body)), { status: answer.status, headers: { 'content-type': 'application/json' } });
      }
      return answer;
    }));
    expect(await w.round()).toBe(true);
    w.fake.hiddenFromList.add(a.id);
    expect(await w.round()).toBe(true);
    expect(reads).toEqual([a.id]);
    expect(w.storedText()).toBe(before);
    expect(w.logged('[DiscordProvider]')).toEqual([PD5(a.id, 'ends_at')]);
    expect(w.logs.filter(l => /RangeError|Invalid time value|handler failed/.test(l))).toEqual([]);
  });

  it("E4e: a delete whose ends_at does not parse still ends the record, with endDate now (discord.js's NaN endsTimestamp)", async () => {
    const a = await bought(SKU.A);
    w.fake.queue.push({ name: 'entitlementDelete', data: { ...w.fake.jsonOf(a), deleted: true, ends_at: 'not a date' }, entitlementId: a.id, queuedAt: Date.now() });
    const at = Date.now();
    await w.deliverAll();
    expect(heldDiscord(w.stored())).toEqual([]);
    const expired = w.emitted.filter(e => e.type === 'subscription.expired');
    expect(expired).toHaveLength(1);
    expect(Math.abs(Date.parse(expired[0].state.endDate) - at)).toBeLessThan(MIN);
    expect(w.logs.filter(l => /RangeError|Invalid time value|handler failed/.test(l))).toEqual([]);
  });

  it("E4f: a test entitlement (no dates) installs with now as its start, and its update keeps the held startDate", async () => {
    await w.teardown();
    await w.setup({ settings: { testEvents: true } });
    const t = w.fake.testGrant({ userId: U }, SKU.A);
    await w.deliverAll();
    const installed = record()?.active;
    expect(installed).toMatchObject({ providerSubId: t.id, status: 'active', endDate: null });
    expect(Math.abs(Date.parse(installed.startDate) - Date.now())).toBeLessThan(MIN);
    await w.advance(30 * MIN);
    w.fake.endAt(t, Date.now() + DAY);
    await w.deliverAll();
    expect(record()?.active.startDate).toBe(installed.startDate);
    expect(w.emitted.filter(e => e.type === 'subscription.updated')).toHaveLength(1);
  });

  it('E8: with R10 a twin of a held SKU, and a second SKU at the same priority, meet PD14', async () => {
    await w.teardown();
    await w.setup({ settings: { allowTwin: true } });
    allowDropLines('L3');
    const a = await bought(SKU.A);
    const twin = await bought(SKU.A);
    const a2 = await bought(SKU.A2);
    expect(heldDiscord(w.stored()).map(h => h.sub.providerSubId)).toEqual([a.id]);
    expect(w.logged('[PremiumManager] subscription.created')).toEqual([PD14(twin.id, `user ${U}`, 'VIP'), PD14(a2.id, `user ${U}`, 'VIP')]);
    await w.advance(45_000);
    for (let round = 0; round < 2; round++) {
      const before = w.logs.length;
      expect(await w.round()).toBe(true);
      expect(w.logs.slice(before).filter(l => l.startsWith('[PremiumManager] subscription.created')).sort()).toEqual([PD14(twin.id, `user ${U}`, 'VIP'), PD14(a2.id, `user ${U}`, 'VIP')].sort());
    }
    expect(heldDiscord(w.stored()).map(h => h.sub.providerSubId)).toEqual([a.id]);
  });

  it('E8b (claim 11): with B active and A queued behind it, a purchase of A2 at the queued priority meets PD14, and the round after A ends installs it', async () => {
    await w.teardown();
    await w.setup({ settings: { updateEndsAt: 'past', staleReads: 0 } });
    allowDropLines('L3');
    await w.advance(31_000);
    const a = await bought(SKU.A);
    const b = await bought(SKU.B);
    const a2 = await bought(SKU.A2);
    expect(heldDiscord(w.stored()).map(h => [h.sub.providerSubId, h.location])).toEqual([[b.id, 'active'], [a.id, 'paused']]);
    expect(w.logged('[PremiumManager] subscription.created')).toEqual([PD14(a2.id, `user ${U}`, 'VIP')]);
    w.fake.endAt(a, w.fake.updateEnd());
    await w.deliverAll();
    expect(heldOf(a.id)).toBeNull();
    await w.advance(31_000);
    expect(heldDiscord(w.stored()).map(h => [h.sub.providerSubId, h.location])).toEqual([[b.id, 'active'], [a2.id, 'paused']]);
  });

  it("PD13: a created event from Discord naming a tier whose offering does not sell its variant", async () => {
    allowDropLines('L3');
    getPaymentRegistry().emitEvent({ type: 'subscription.created', providerId: 'discord', providerSubId: '86200000000000077', holder: H as any, buyerId: U, tierId: 'vip', offeringId: 'o-a', variantId: SKU.B, soldVariantOnly: true, state: { status: 'active', startDate: iso(Date.now()), endDate: null, autoRenew: true } });
    await w.settle();
    expect(record()).toBeNull();
    expect(w.logged('[PremiumManager] subscription.created')).toEqual([PD13('86200000000000077', `user ${U}`, 'VIP', SKU.B)]);
  });
});

describe('P6 part 1, claim 3 with R1 future: the end Discord gives ahead is kept and the minute checker ends it', () => {
  beforeEach(async () => { await w.setup({ settings: { updateEndsAt: 'future' } }); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it('E4: the update leaves the record active with endDate ends_at and autoRenew false; with Discord not answering any round, the checker expires it a minute after', async () => {
    const a = await bought(SKU.A);
    const end = w.fake.updateEnd();
    w.fake.endAt(a, end);
    await w.deliverAll();
    expect(record()?.active).toMatchObject({ providerSubId: a.id, status: 'active', endDate: iso(end), autoRenew: false });
    w.fake.fail(/./, { status: 503 }, 1000);
    await w.advance(end - Date.now() + MIN);
    expect(record()).toBeNull();
    expect(w.notices().map(n => n.kind)).toEqual(['paid.sub.started', 'paid.sub.expired']);
  });

  it("E4b: the update is read from discord.js's second argument (a client that never saw the create gets null first)", async () => {
    const a = await bought(SKU.A);
    await w.restart();
    const end = w.fake.updateEnd();
    w.fake.endAt(a, end);
    await w.deliverAll();
    expect(record()?.active).toMatchObject({ providerSubId: a.id, endDate: iso(end), autoRenew: false });
  });
});

const BACKENDS = [['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]] as const;

describe.each(BACKENDS)('P6 part 1, claims 1 and 2 on %s: the install and the journal', (_name, backend) => {
  const x = p6World(backend);
  const held = (holder = H): any => x.stored()?.subscriptions?.[holder] ?? null;
  /** Premium's stored copy replaced by `text` (the file, and on the rig its row too). */
  const store = (text: string): void => {
    fs.writeFileSync(dataPath('global', 'premium-tiers.json'), text);
    const row = x.rig?.m.state.rows.docs.get(PREMIUM_KEY);
    if (row) row.body = Buffer.from(text);
  };
  /** The events journal as text: the lines key on the rig, the file on the JSON files. */
  const journalText = (): string => {
    if (x.rig) return x.rig.lines(JOURNAL_KEY).map(l => JSON.stringify(l)).join('\n');
    const file = dataPath('global', 'premium-tiers.events.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  };
  beforeEach(async () => { await x.setup({ settings: { updateEndsAt: 'past' } }); });
  afterEach(async () => {
    await x.teardown();
    vi.restoreAllMocks();
  });

  it("E1: a user entitlement's create installs user:<uid> with the wired tier, the SKU as variant, the entitlement id, the application id and Discord's start as an ISO string", async () => {
    x.fake.purchase(U, SKU.A);
    const ent = [...x.fake.entitlements.values()][0];
    await x.deliverAll();
    const sub = held()?.active;
    expect(sub).toMatchObject({
      tierId: 'vip', offeringId: 'o-a', variantId: SKU.A, source: 'paid', providerId: 'discord', providerSubId: ent.id, buyerId: U,
      status: 'active', endDate: null, autoRenew: true, providerMeta: { skuId: SKU.A, type: ENTITLEMENT_TYPE.APPLICATION_SUBSCRIPTION, applicationId: APP_ID },
    });
    const start = new Date(Date.parse(discordTime(ent.startsAt!))).toISOString();
    expect(sub.startDate).toBe(start);
    const handed = x.emitted.find(e => e.type === 'subscription.created');
    expect([typeof handed?.state.startDate, handed?.state.startDate]).toEqual(['string', start]);
    expect(x.fake.unexpected).toEqual([]);
  });

  it('E6: a create while premium-tiers.json cannot be read is journaled, and installed after the replay once the file can be read', async () => {
    const good = x.storedText()!;
    store('{ not json');
    getPremiumManager().invalidate();
    getPremiumManager().getAllTiers();
    expect(getPremiumManager().cacheState()).toBe('unreadable');
    const ent = x.fake.purchase(U, SKU.B);
    await x.deliverAll();
    expect(x.storedText()).toBe('{ not json');
    expect(journalText()).toContain(ent.id);
    expect((x.rig ? x.rig.logged.bind(x.rig) : x.logged)('it is kept in premium-tiers.events.jsonl')).toHaveLength(1);
    store(good);
    getPremiumManager().invalidate();
    await x.advance(MIN);
    expect(held()?.active).toMatchObject({ tierId: 'star', offeringId: 'o-b', providerSubId: ent.id, status: 'active' });
  });
});

describe('P6 part 1, claim 2 E6b: created events of other providers with their tier set install as at 8a3db4b', () => {
  beforeEach(async () => { await w.setup(); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it('the Dummy for a user, PayPal for a server and Stripe for a user, each provider registered', async () => {
    getPaymentRegistry().register(new PayPalProvider());
    getPaymentRegistry().register(new StripeProvider());
    const U2 = USERS[1];
    expect((await w.op('setTier', 'dplus', { displayName: 'Dummy plus', priority: 3, overrides: {}, kind: 'user', offerings: [{ id: 'o-d', label: 'Dummy plus', providerLinks: [{ providerId: 'dummy', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'dummy_monthly_999' }] } }] }] })).ok).toBe(true);
    expect((await w.op('setTier', 'gpay', { displayName: 'Gold PayPal', priority: 1, overrides: {}, offerings: [{ id: 'o-p', label: 'Gold PayPal', providerLinks: [{ providerId: 'paypal', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'P-1' }] } }] }] })).ok).toBe(true);
    expect((await w.op('setTier', 'ustripe', { displayName: 'Stripe plus', priority: 3, overrides: {}, kind: 'user', offerings: [{ id: 'o-s', label: 'Stripe plus', providerLinks: [{ providerId: 'stripe', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'price_p6' }] } }] }] })).ok).toBe(true);
    const now = Date.now();
    const start = now - 3 * DAY;
    getPaymentRegistry().emitEvent({ type: 'subscription.created', providerId: 'dummy', providerSubId: 'dummy_p6_1', holder: H as any, buyerId: U, tierId: 'dplus', offeringId: 'o-d', variantId: 'dummy_monthly_999', state: { status: 'active', startDate: iso(start), endDate: iso(now + 30 * DAY), autoRenew: true } });
    getPaymentRegistry().emitEvent({ type: 'subscription.created', providerId: 'paypal', providerSubId: 'I-P6PAYPAL1', holder: `guild:${GUILD}` as any, buyerId: U, tierId: 'gpay', offeringId: 'o-p', variantId: 'P-1', soldVariantOnly: true, state: { status: 'active', startDate: iso(start), endDate: iso(now + 30 * DAY), autoRenew: true, meta: { paypalStatus: 'ACTIVE', planId: 'P-1' } } });
    getPaymentRegistry().emitEvent({ type: 'subscription.created', providerId: 'stripe', providerSubId: 'sub_P6E6B', holder: `user:${U2}` as any, buyerId: U2, tierId: 'ustripe', offeringId: 'o-s', variantId: 'price_p6', state: { status: 'active', startDate: iso(start), endDate: iso(now + 30 * DAY), autoRenew: true, meta: { stripeStatus: 'active', cancelAtPeriodEnd: false, pauseCollection: null, currentPeriodStart: iso(start), trialEnd: null } } });
    await w.settle();
    expect([normalized(record()?.active), normalized(record(`guild:${GUILD}`)?.active), normalized(record(`user:${U2}`)?.active)]).toEqual(E6B_PINNED);
  });
});

const UPGRADES = [] as Array<[string, 'A2' | 'B', 'create-first' | 'update-first', 'past' | 'future']>;
for (const to of ['A2', 'B'] as const) {
  for (const order of ['create-first', 'update-first'] as const) {
    for (const r1 of ['past', 'future'] as const) UPGRADES.push([`A to ${to} (${to === 'A2' ? 'same priority' : 'higher'}), ${order}, R1 ${r1}`, to, order, r1]);
  }
}

describe('P6 part 2, claim 3 U1 to U4: upgrades, with the round 30 seconds after the events', () => {
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it.each(UPGRADES)('%s: the member ends holding exactly the new record, without a tier for at most 31 seconds', async (_name, to, order, r1) => {
    allowDropLines('L3');
    await w.setup({ settings: { staleReads: 0, updateEndsAt: r1, upgradeOrder: order } });
    await w.advance(31_000);
    const a = await bought(SKU.A);
    const made = w.fake.upgrade(a, SKU[to]);
    const oldEnd = a.endsAt!;
    await w.deliverAll();
    await w.advance(Math.max(oldEnd - Date.now(), 0) + 2 * MIN);
    expect(heldDiscord(w.stored()).map(h => [h.sub.providerSubId, h.location])).toEqual([[made.id, 'active']]);
    const installed = Date.parse(heldOf(made.id)!.sub.createdAt);
    expect(installed - oldEnd).toBeLessThanOrEqual(31_000);
  });

  it('A to A2, create-first, R1 past, the events while a round runs: the new record is installed at most 31 seconds after that round ends', async () => {
    allowDropLines('L3');
    await w.setup({ settings: { staleReads: 0, updateEndsAt: 'past', upgradeOrder: 'create-first' } });
    await w.advance(31_000);
    const a = await bought(SKU.A);
    const held = w.fake.holdAnswer('list');
    const round = w.provider.checkNow();
    await held.reached;
    const made = w.fake.upgrade(a, SKU.A2);
    await w.deliverAll();
    expect(heldOf(a.id)).toBeNull();
    await w.advance(10_000);
    held.release();
    await round;
    await w.settle();
    const ended = Date.now();
    await w.advance(2 * MIN);
    expect(heldDiscord(w.stored()).map(h => [h.sub.providerSubId, h.location])).toEqual([[made.id, 'active']]);
    expect(Date.parse(heldOf(made.id)!.sub.createdAt) - ended).toBeLessThanOrEqual(31_000);
  });
});

const DOWNGRADES = [
  ['create-first', 'past', ['paid.sub.paused-by-stacking', 'paid.sub.expired', 'paid.sub.resumed-from-queue']],
  ['create-first', 'future', ['paid.sub.paused-by-stacking', 'paid.sub.expired', 'paid.sub.resumed-from-queue']],
  ['update-first', 'past', ['paid.sub.expired', 'paid.sub.started']],
  ['update-first', 'future', ['paid.sub.paused-by-stacking', 'paid.sub.expired', 'paid.sub.resumed-from-queue']],
] as Array<['create-first' | 'update-first', 'past' | 'future', string[]]>;

describe('P6 part 3, claim 3 U5: a downgrade', () => {
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it.each(DOWNGRADES)('B to A, %s, R1 %s: the member ends holding A; queued at its install, A gets PD12 and never paid.sub.started (fails on the started notice put in the carry before the queue)', async (order, r1, kinds) => {
    allowDropLines('L3');
    await w.setup({ settings: { staleReads: 0, updateEndsAt: r1, upgradeOrder: order } });
    await w.advance(31_000);
    const b = await bought(SKU.B);
    const from = w.notices().length;
    const made = w.fake.downgrade(b, SKU.A);
    const oldEnd = b.endsAt!;
    await w.deliverAll();
    await w.advance(Math.max(oldEnd - Date.now(), 0) + 2 * MIN);
    expect(heldDiscord(w.stored()).map(h => [h.sub.providerSubId, h.location])).toEqual([[made.id, 'active']]);
    expect(w.notices().slice(from).map(n => n.kind)).toEqual(kinds);
    const queuedNotice = w.notices().findIndex((n, i) => i >= from && n.kind === 'paid.sub.paused-by-stacking');
    if (queuedNotice >= 0) expect(noticePayloads[queuedNotice]).toMatchObject({ tierName: 'VIP', providerName: NAME, billedWhileQueued: true });
  });
});

const E6B_PINNED = [
  '{"id":"<id>","tierId":"dplus","source":"paid","offeringId":"o-d","variantId":"dummy_monthly_999","providerId":"dummy","providerSubId":"dummy_p6_1","purchasedSnapshot":{"offeringLabel":"Dummy plus","variantLabel":"","amount":0,"currency":"","durationDays":null,"tierDisplayName":"Dummy plus","tierPriority":3,"purchasedAt":"<0m>"},"buyerId":"86500000000000001","startDate":"<-4320m>","endDate":"<43200m>","autoRenew":true,"status":"active","createdAt":"<0m>","updatedAt":"<0m>"}',
  '{"id":"<id>","tierId":"gpay","source":"paid","offeringId":"o-p","variantId":"P-1","providerId":"paypal","providerSubId":"I-P6PAYPAL1","providerMeta":{"paypalStatus":"ACTIVE","planId":"P-1"},"purchasedSnapshot":{"offeringLabel":"Gold PayPal","variantLabel":"","amount":0,"currency":"","durationDays":null,"tierDisplayName":"Gold PayPal","tierPriority":1,"purchasedAt":"<0m>"},"buyerId":"86500000000000001","startDate":"<-4320m>","endDate":"<43200m>","autoRenew":true,"status":"active","createdAt":"<0m>","updatedAt":"<0m>"}',
  '{"id":"<id>","tierId":"ustripe","source":"paid","offeringId":"o-s","variantId":"price_p6","providerId":"stripe","providerSubId":"sub_P6E6B","providerMeta":{"stripeStatus":"active","cancelAtPeriodEnd":false,"pauseCollection":null,"currentPeriodStart":"<-4320m>","trialEnd":null},"purchasedSnapshot":{"offeringLabel":"Stripe plus","variantLabel":"","amount":0,"currency":"","durationDays":null,"tierDisplayName":"Stripe plus","tierPriority":3,"purchasedAt":"<0m>"},"buyerId":"86500000000000002","startDate":"<-4320m>","endDate":"<43200m>","autoRenew":true,"status":"active","createdAt":"<0m>","updatedAt":"<0m>"}',
];
