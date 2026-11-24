import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P6 claims 8 to 10 as part 3 builds them (sheet P6, section 10): Discord hosts a member's subscription, so the bot
// refuses an admin's End now and queued Cancel & remove on a `user:` Discord record it follows (PD11), removes one it
// does not follow (a pre-P6 `guild:` record, PD16; another application's or with Discord not configured, PD19 and
// PD19b), and tells a member whose Discord record is queued that Discord keeps billing it (PD12). The dev card and the
// server panel show the texts in place of the buttons Discord's records cannot use. Other providers keep their stored
// entries, notices and refusal lines (the Dummy rows here passed on 8a3db4b's src too). The real DiscordProvider and
// PremiumManager over the JSON files (C1, C3 and C7 also over the mirror rig), the Client and the fake of
// helpers/p6World.ts; the dev card (AppStorePanel.jsx) and the server panel (GuildSubscriptionPanel.jsx) rendered
// from the real lookup route's answer and the stored record.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { dataPath } from '../../src/utils/dataRoot';
import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { PayPalProvider } from '../../src/bot/internalSetup/utils/payment/paypalProvider';
import { PatreonProvider } from '../../src/bot/internalSetup/utils/payment/patreonProvider';
import { SubscriptionNotifier } from '../../src/bot/internalSetup/utils/subscriptionNotifier';
import { noticePayloads } from '../helpers/p1Mocks';
import { loadGuildPanel, panelText, type Node } from '../helpers/p1PanelRig';
import { mount, settle as cardSettle } from '../helpers/jsxRig';
import { allowDropLines } from '../helpers/p1Guard';
import { SKU, type FakeEntitlement } from '../helpers/p6Discord';
import { GUILD, heldDiscord, p6World, USERS, type P6World } from '../helpers/p6World';

const U = USERS[0];
const U2 = USERS[1];
const H = `user:${U}`;
const H2 = `user:${U2}`;
const G = `guild:${GUILD}`;
const NAME = 'Discord App Monetization';
const DUMMY = 'Dummy (Development)';
const MIN = 60_000;
const DAY = 86_400_000;
const OTHER_APP = '86900000000000777';
const BACKENDS = [['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]] as const;
const CARD = path.join(__dirname, '../../src/webui/public/components/AppStorePanel.jsx');

const PD9 = 'Discord manages this subscription. The member cancels it in Discord; the tier ends when Discord reports that it ended or was refunded. The bot learns of a cancel only when Discord shows an end date, so a cancelled subscription can show as renewing until its end.';
const PD11 = "Discord manages this subscription, so the bot cannot end or remove it. It ends when the member's subscription ends in Discord or Discord refunds it.";
const PD12 = (tier: string) => `**Subscription paused:** Your **${tier}** (${NAME}) subscription is queued behind a higher-tier plan. The bot cannot pause it in Discord; if you no longer want it, cancel it in Discord.`;
const PD16 = "The bot no longer follows server subscriptions from Discord, so this record ends only when it is removed here or at an end date it already holds. Removing it does not stop Discord's billing; remove it once Discord no longer bills it.";
const PD19 = "This subscription carries another Discord application id than the one configured, so the bot does not follow it. If the configured id is wrong, fix it instead. Removing it does not stop that application's billing.";
const PD19B = "Discord is not configured on this bot, so it does not follow this subscription. Removing it does not stop Discord's billing.";
// Not in the sheet (fix-unread.md): the dev card and the admin's error while Discord's settings cannot be read.
const PD19C = "payment-providers/credentials.json cannot be read now, so the bot can't confirm whether Discord bills this subscription, and it does not end or remove it. Try again once it can be read.";
// Part 3's wording of PD14 when the held record is not this provider's (a manual grant or another provider's): the
// sheet's "installed once Discord ends the old one" is false there (fix-part1.md, lane 1 finding 2).
const PD14_OTHER = (id: string, uid: string, tier: string) => `[PremiumManager] subscription.created from ${NAME} (subscription ${id}, user ${uid}) was not installed: user ${uid} already holds '${tier}' at that priority. The bot tries again at each check, so it is installed once '${tier}' ends; otherwise the member cancels it in ${NAME}.`;
const PD14_SAME = (id: string, uid: string, tier: string) => `[PremiumManager] subscription.created from ${NAME} (subscription ${id}, user ${uid}) was not installed: user ${uid} already holds '${tier}' at that priority. If it replaces that subscription, it is installed once ${NAME} ends the old one; otherwise the member cancels it in ${NAME}.`;

const formatted = (kind: string, payload: unknown, holderKind: 'user' | 'guild' = 'user'): string => (new SubscriptionNotifier() as any).formatMessage(kind, payload, holderKind);
const iso = (ms: number) => new Date(ms).toISOString();

function helpers(w: P6World) {
  const h = {
    record: (holder = H): any => w.stored()?.subscriptions?.[holder] ?? null,
    heldOf: (id: string) => heldDiscord(w.stored()).find(x => x.sub.providerSubId === id) ?? null,
    async bought(sku: string, u: string = U): Promise<FakeEntitlement> {
      const ent = w.fake.purchase(u, sku);
      await w.deliverAll();
      return ent;
    },
    /** The notices sent since `from`, each with its payload. */
    since: (from: number) => w.notices().slice(from).map((n, i) => ({ ...n, payload: noticePayloads[from + i] as any })),
    /** A user tier and a server tier sold through the Dummy, and a server tier of priority 5. */
    async dummyTiers(): Promise<void> {
      const link = { providerId: 'dummy', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'dummy_monthly_999' }] } };
      expect((await w.op('setTier', 'dlow', { displayName: 'Dummy low', priority: 1, overrides: {}, kind: 'user', offerings: [{ id: 'o-d', label: 'Dummy low', providerLinks: [link] }] })).ok).toBe(true);
      expect((await w.op('setTier', 'gdummy', { displayName: 'Gold Dummy', priority: 1, overrides: {}, offerings: [{ id: 'o-gd', label: 'Gold Dummy', providerLinks: [link] }] })).ok).toBe(true);
      expect((await w.op('setTier', 'gtop', { displayName: 'Gold top', priority: 5, overrides: {}, offerings: [] })).ok).toBe(true);
    },
    /** A Dummy created event, as the Dummy provider emits one. */
    dummyCreated(holder: string, buyer: string, tierId: string, offeringId: string, providerSubId: string, more: Record<string, unknown> = {}): void {
      const now = Date.now();
      getPaymentRegistry().emitEvent({ type: 'subscription.created', providerId: 'dummy', providerSubId, holder: holder as any, buyerId: buyer, tierId, offeringId, variantId: 'dummy_monthly_999', state: { status: 'active', startDate: iso(now), endDate: iso(now + 30 * DAY), autoRenew: true }, ...more } as any);
    },
    /** The dev card mounted on the lookup route's answer for `userId`, after its Look up. */
    async card(userId: string, confirmed = false) {
      const lookup = await w.lookup(userId);
      expect(lookup.status).toBe(200);
      const prompts: string[] = [];
      const calls: Array<{ method: string; url: string }> = [];
      const answer = (method: string) => async (url: string) => {
        calls.push({ method, url });
        if (url === '/appstore/premium/tiers') return { success: true, tiers: {}, userTiers: {} };
        if (url === `/appstore/premium/users/${userId}`) return lookup.body;
        if (url === `/appstore/premium/users/${userId}/orphans`) return { success: true, orphans: [] };
        return { success: true };
      };
      const api = { get: answer('GET'), post: answer('POST'), put: answer('PUT'), delete: answer('DELETE') };
      const m = mount(CARD, 'DummyTestPurchase', { activated: true, showSuccess: () => {}, setError: () => {} }, { api, confirm: (p: string) => { prompts.push(p); return confirmed; } });
      await cardSettle();
      const field = (name: string) => m.all(el => el.props.name === name)[0];
      field('kind').props.onChange({ target: { value: 'user' } });
      await cardSettle();
      field('holderId').props.onChange({ target: { value: userId } });
      await cardSettle();
      m.button(/^Look up$/).props.onClick();
      await cardSettle();
      const labels = m.all(el => el.type === 'button').map(el => m.text(el));
      return {
        lookup: lookup.body,
        text: m.tree ? m.text(m.tree) : '',
        labels,
        prompts,
        calls,
        click: async (label: RegExp) => { m.button(label).props.onClick(); await cardSettle(); },
      };
    },
  };
  return h;
}

/** The server panel rendered on a guild record, with Discord in its providers. */
async function serverPanel(paid: any, paused: any[] = []) {
  const confirms: string[] = [];
  const panel = loadGuildPanel({
    listOrphans: async () => ({ success: true, orphans: [] }),
    listPendingMigrations: async () => ({ success: true, migrations: [] }),
    listGuildChannels: async () => ({ success: true, channels: [] }),
  }, text => { confirms.push(text); return false; });
  const dp = getPaymentRegistry().get('discord')!;
  const props = { guild: { id: GUILD }, subData: { subscriptions: { active: paid, paused }, tiers: { gold: { displayName: 'Gold', priority: 1 } }, providers: [{ id: dp.id, displayName: dp.displayName, capabilities: dp.capabilities }] }, onRefresh: async () => {} };
  panel.render(props);
  for (let i = 0; i < 5; i++) await new Promise(resolve => { setImmediate(resolve); });
  const tree = panel.render(props);
  const buttons: Array<{ label: string; onClick: () => unknown }> = [];
  const walk = (t: unknown): void => {
    if (Array.isArray(t)) { t.forEach(walk); return; }
    if (!t || typeof t !== 'object') return;
    const node = t as Node;
    if (node.type === 'button') buttons.push({ label: panelText(node).trim(), onClick: node.props?.onClick as () => unknown });
    (node.children || []).forEach(walk);
  };
  walk(tree);
  return { text: panelText(tree), labels: buttons.map(b => b.label), button: (label: string) => buttons.find(b => b.label === label)!, confirms };
}

/** A pre-P6 `guild:` Discord record, written by hand (the one hand-written record of the sheet, as K10's). */
async function preP6GuildRecord(w: P6World, h: ReturnType<typeof helpers>): Promise<any> {
  const donor = await h.bought(SKU.A, U2);
  const g = w.fake.purchase(U, SKU.A, { guildId: GUILD });
  w.fake.queue.length = 0;
  const doc = w.stored();
  const old = structuredClone(doc.subscriptions[H2].active);
  Object.assign(old, { id: `${old.id.slice(0, -1)}${old.id.endsWith('0') ? '1' : '0'}`, tierId: 'gold', offeringId: 'o-g', providerSubId: g.id, buyerId: U, providerMeta: { skuId: SKU.A, type: 8 } });
  doc.subscriptions[G] = { active: old, paused: [] };
  expect(donor.id).not.toBe(g.id);
  fs.writeFileSync(dataPath('global', 'premium-tiers.json'), JSON.stringify(doc, null, 2));
  getPremiumManager().invalidate();
  return old;
}

describe.each(BACKENDS)('P6 part 3 on %s: C1, the admin cannot end or remove a followed user: Discord record', (_name, backend) => {
  const w = p6World(backend);
  const h = helpers(w);
  beforeEach(async () => {
    await w.setup({ settings: { staleReads: 0 } });
    await w.advance(45_000);
  });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it("C1: the soft cancel answers false and calls nothing; End now and the queued Cancel & remove answer PD11 with premium's bytes unchanged; the next check installs nothing new (fails on a build without PD11)", async () => {
    const a = await h.bought(SKU.A);
    const b = await h.bought(SKU.B);
    expect([h.heldOf(a.id)?.location, h.heldOf(b.id)?.location]).toEqual(['paused', 'active']);
    const calls = w.fake.calls.length;
    const soft = await w.op('cancelPaidSubscription', H);
    expect(soft).toMatchObject({ ok: true, result: false });
    const before = w.storedText();
    const endNow = await w.op('cancelPaidSubscriptionImmediately', H);
    const removed = await w.op('cancelAndRemovePausedSubscription', H, h.heldOf(a.id)!.sub.id);
    expect([endNow.ok, endNow.error, removed.ok, removed.error]).toEqual([false, PD11, false, PD11]);
    expect(w.storedText()).toBe(before);
    expect(w.fake.calls.length).toBe(calls);
    const notices = w.notices().length;
    const created = w.emitted.filter(e => e.type === 'subscription.created').length;
    expect(await w.round()).toBe(true);
    expect(w.storedText()).toBe(before);
    expect(w.emitted.filter(e => e.type === 'subscription.created').length).toBe(created);
    expect(w.notices().length).toBe(notices);
    expect(w.fake.unexpected).toEqual([]);
  });

  it('C3: a Discord record pushed out of the slot gets PD12; one bought under a held higher grant is queued and gets PD12, not paid.sub.started (fails on the started notice in the carry before the queue, pm:1578)', async () => {
    const a = await h.bought(SKU.A);
    const from = w.notices().length;
    await h.bought(SKU.B);
    const pushed = h.since(from);
    expect(pushed.map(n => n.kind)).toEqual(['paid.sub.started', 'paid.sub.paused-by-stacking']);
    expect(pushed[1].payload).toMatchObject({ tierName: 'VIP', providerName: NAME, billedWhileQueued: true });
    expect(formatted('paid.sub.paused-by-stacking', pushed[1].payload)).toBe(PD12('VIP'));
    expect(h.heldOf(a.id)?.location).toBe('paused');

    expect((await w.op('grantManual', H2, 'star', 1)).ok).toBe(true);
    const at = w.notices().length;
    const c = await h.bought(SKU.A, U2);
    expect(h.heldOf(c.id)).toMatchObject({ holder: H2, location: 'paused', sub: { status: 'paused', endDate: null, autoRenew: true } });
    const queued = h.since(at);
    expect(queued.map(n => n.kind)).toEqual(['paid.sub.paused-by-stacking']);
    expect(formatted('paid.sub.paused-by-stacking', queued[0].payload)).toBe(PD12('VIP'));
  });

  it('C7 (E16): a lookup, then a save: the stored records are what they were without the lookup, with no followed or whyNot field', async () => {
    await h.dummyTiers();
    await h.bought(SKU.A);
    await h.bought(SKU.B);
    h.dummyCreated(H2, U2, 'dlow', 'o-d', 'dummy_p6_c7');
    await w.settle();
    const before = [JSON.stringify(h.record(H)), JSON.stringify(h.record(H2))];
    const seen = await w.lookup(U);
    const seen2 = await w.lookup(U2);
    expect(seen.body.subscriptions.active).toMatchObject({ providerId: 'discord', followed: true });
    expect(seen.body.subscriptions.paused[0]).toMatchObject({ providerId: 'discord', followed: true });
    expect(seen2.body.subscriptions.active).toMatchObject({ providerId: 'dummy', followed: true });
    expect((await w.op('grantManual', G, 'gold', 1)).ok).toBe(true);
    expect([JSON.stringify(h.record(H)), JSON.stringify(h.record(H2))]).toEqual(before);
    expect(/"followed"|"whyNot"/.test(w.storedText()!)).toBe(false);
  });
});

describe('P6 on the mirror rig: Discord\'s settings cannot be read', () => {
  const w = p6World('rig');
  const h = helpers(w);
  const DOC = () => dataPath('global', 'payment-providers', 'credentials.json');
  const unreadable = () => {
    fs.mkdirSync(path.dirname(DOC()), { recursive: true });
    fs.writeFileSync(DOC(), '{"discord": ');
  };
  beforeEach(async () => {
    await w.setup({ settings: { staleReads: 0 } });
    await w.advance(45_000);
  });
  afterEach(async () => {
    fs.rmSync(DOC(), { force: true });
    await w.teardown();
    vi.restoreAllMocks();
  });

  it("End now and the queued Cancel & remove answer PD19c with premium's bytes unchanged; a round then reads nothing; once the settings read, no second paid.sub.started goes out (fails on the unread doc answering 'not configured')", async () => {
    const a = await h.bought(SKU.A);
    const b = await h.bought(SKU.B);
    expect([h.heldOf(a.id)?.location, h.heldOf(b.id)?.location]).toEqual(['paused', 'active']);
    unreadable();
    const before = w.storedText();
    const calls = w.fake.calls.length;
    const notices = w.notices().length;
    const created = w.emitted.filter(e => e.type === 'subscription.created').length;
    const endNow = await w.op('cancelPaidSubscriptionImmediately', H);
    const removed = await w.op('cancelAndRemovePausedSubscription', H, h.heldOf(a.id)!.sub.id);
    expect([endNow.ok, endNow.error, removed.ok, removed.error]).toEqual([false, PD19C, false, PD19C]);
    expect(w.storedText()).toBe(before);
    expect(await w.round()).toBe(true);
    expect(w.storedText()).toBe(before);
    expect(w.fake.calls.length).toBe(calls);
    fs.rmSync(DOC(), { force: true });
    expect(await w.round()).toBe(true);
    expect(w.storedText()).toBe(before);
    expect(w.emitted.filter(e => e.type === 'subscription.created').length).toBe(created);
    expect(w.notices().slice(notices).filter(n => n.kind === 'paid.sub.started')).toEqual([]);
    expect(w.fake.unexpected).toEqual([]);
  });

  it('the dev card shows PD19c for the active and the queued Discord record, no PD19b, and no End now or Cancel & remove', async () => {
    const a = await h.bought(SKU.A);
    await h.bought(SKU.B);
    unreadable();
    const card = await h.card(U);
    expect(card.lookup.subscriptions.active).toMatchObject({ followed: false, whyNot: 'unread' });
    expect(card.lookup.subscriptions.paused[0]).toMatchObject({ providerSubId: a.id, followed: false, whyNot: 'unread' });
    expect(card.text.split(PD19C).length - 1).toBe(2);
    expect(card.text.includes(PD19B)).toBe(false);
    expect(card.labels.filter(l => /^(Cancel|Renew again|End now|Cancel & remove)$/.test(l))).toEqual([]);
  });
});

describe('P6 part 3: records the bot does not follow, other providers, and the cards', () => {
  const w = p6World('json');
  const h = helpers(w);
  beforeEach(async () => {
    await w.setup({ settings: { staleReads: 0 } });
    await w.advance(45_000);
  });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it("C2: Patreon's unlink still removes its record; the Dummy's End now still ends its record and tells the member", async () => {
    getPaymentRegistry().register(new PatreonProvider());
    await h.dummyTiers();
    expect((await w.op('setTier', 'gpat', { displayName: 'Gold Patreon', priority: 1, overrides: {}, offerings: [{ id: 'o-pat', label: 'Gold Patreon', providerLinks: [{ providerId: 'patreon', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'tier-1' }] } }] }] })).ok).toBe(true);
    expect((await w.op('linkAccount', 'patreon', 'acct-1', G, U)).ok).toBe(true);
    const now = Date.now();
    getPaymentRegistry().emitEvent({ type: 'subscription.created', providerId: 'patreon', providerSubId: 'pat-1', holder: G as any, buyerId: U, tierId: 'gpat', offeringId: 'o-pat', variantId: 'tier-1', state: { status: 'active', startDate: iso(now), endDate: iso(now + 30 * DAY), autoRenew: true } } as any);
    h.dummyCreated(H2, U2, 'dlow', 'o-d', 'dummy_p6_c2');
    await w.settle();
    expect([h.record(G)?.active?.providerId, h.record(H2)?.active?.providerId]).toEqual(['patreon', 'dummy']);
    expect(await w.op('unlinkProviderAccount', G, 'patreon')).toMatchObject({ ok: true, result: true });
    expect(h.record(G)).toBeNull();
    const from = w.notices().length;
    expect(await w.op('cancelPaidSubscriptionImmediately', H2)).toMatchObject({ ok: true, result: true });
    expect(h.record(H2)).toBeNull();
    expect(h.since(from).map(n => [n.to, n.kind])).toEqual([[H2, 'paid.sub.cancelled-by-user']]);
  });

  it("C3: the Dummy's notices pushed out of the slot and installed under a held higher grant are 8a3db4b's", async () => {
    await h.dummyTiers();
    h.dummyCreated(H2, U2, 'dlow', 'o-d', 'dummy_p6_c3a');
    await w.settle();
    let from = w.notices().length;
    expect((await w.op('grantManual', H2, 'star', 1)).ok).toBe(true);
    const pushed = h.since(from).filter(n => n.kind.startsWith('paid.'));
    expect(pushed).toEqual([{ to: H2, kind: 'paid.sub.paused-by-stacking', payload: { tierName: 'Dummy low', providerName: DUMMY, remainingDays: 30 } }]);
    expect(formatted('paid.sub.paused-by-stacking', pushed[0].payload)).toBe("**Subscription paused:** Your **Dummy low** (Dummy (Development)) subscription is queued behind a higher-tier plan and won't be billed until it resumes. 30 days remaining.");
    expect((await w.op('grantManual', G, 'gtop', 1)).ok).toBe(true);
    from = w.notices().length;
    h.dummyCreated(G, U, 'gdummy', 'o-gd', 'dummy_p6_c3b');
    await w.settle();
    const end = h.record(G).paused[0].endDate;
    expect(h.since(from)).toEqual([{ to: G, kind: 'paid.sub.started', payload: { tierName: 'Gold Dummy', providerName: DUMMY, endDate: end } }]);
  });

  it("C4: a pre-P6 guild: Discord record's Cancel & remove now removes it, calls nothing and sends no notice; the server panel shows PD16 and only Cancel & remove now, whose confirm is PD16", async () => {
    const old = await preP6GuildRecord(w, h);
    const shown = await serverPanel(old);
    expect(shown.text).toContain(PD16);
    expect(shown.labels.filter(l => /^(Cancel|Reactivate|Manage at provider|Unlink Patreon)/.test(l))).toEqual(['Cancel & remove now']);
    await shown.button('Cancel & remove now').onClick();
    expect(shown.confirms).toEqual([PD16]);
    const calls = w.fake.calls.length;
    const from = w.notices().length;
    expect(await w.op('cancelPaidSubscriptionImmediately', G)).toMatchObject({ ok: true, result: true });
    expect(h.record(G)).toBeNull();
    expect(w.fake.calls.length).toBe(calls);
    expect(w.fake.unexpected).toEqual([]);
    expect(h.since(from)).toEqual([]);
  });

  it("C4: a queued guild: Discord record's card shows PD16, and its Cancel & remove confirm is PD16", async () => {
    const old = await preP6GuildRecord(w, h);
    const shown = await serverPanel(undefined, [{ ...old, status: 'paused' }]);
    expect(shown.text).toContain(PD16);
    await shown.button('Cancel & remove').onClick();
    expect(shown.confirms).toEqual([PD16]);
  });

  it("C5: Discord's refusal against a held manual grant at the same priority says it is installed once the grant ends; against a held Discord record, PD14", async () => {
    allowDropLines('L3');
    expect((await w.op('grantManual', H, 'vip', 1)).ok).toBe(true);
    const a = await h.bought(SKU.A);
    expect(w.logged('[PremiumManager] subscription.created')).toEqual([PD14_OTHER(a.id, U, 'VIP')]);
    const b = await h.bought(SKU.A, U2);
    const twin = await h.bought(SKU.A2, U2);
    expect(h.heldOf(b.id)?.location).toBe('active');
    expect(w.logged('[PremiumManager] subscription.created').slice(1)).toEqual([PD14_SAME(twin.id, U2, 'VIP')]);
  });

  it("C5: the Dummy's and PayPal's variant and same-priority refusal lines are 8a3db4b's", async () => {
    allowDropLines('L3');
    getPaymentRegistry().register(new PayPalProvider());
    await h.dummyTiers();
    expect((await w.op('setTier', 'gpay', { displayName: 'Gold PayPal', priority: 1, overrides: {}, offerings: [{ id: 'o-p', label: 'Gold PayPal', providerLinks: [{ providerId: 'paypal', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'P-1' }, { variantId: 'P-2' }] } }] }] })).ok).toBe(true);
    const now = Date.now();
    const paypal = (id: string, variantId: string) => getPaymentRegistry().emitEvent({ type: 'subscription.created', providerId: 'paypal', providerSubId: id, holder: G as any, buyerId: U, tierId: 'gpay', offeringId: 'o-p', variantId, soldVariantOnly: true, state: { status: 'active', startDate: iso(now), endDate: iso(now + 30 * DAY), autoRenew: true, meta: { paypalStatus: 'ACTIVE', planId: variantId } } } as any);
    h.dummyCreated(H2, U2, 'dlow', 'o-d', 'dummy_p6_c5a', { variantId: 'dummy_other', soldVariantOnly: true });
    await w.settle();
    h.dummyCreated(H2, U2, 'dlow', 'o-d', 'dummy_p6_c5b', { soldVariantOnly: true });
    await w.settle();
    h.dummyCreated(H2, U2, 'dlow', 'o-d', 'dummy_p6_c5c', { soldVariantOnly: true });
    await w.settle();
    paypal('I-P6C5A', 'P-9');
    await w.settle();
    paypal('I-P6C5B', 'P-1');
    await w.settle();
    paypal('I-P6C5C', 'P-2');
    await w.settle();
    expect(w.logged('[PremiumManager] subscription.created')).toEqual([
      "[PremiumManager] subscription.created from Dummy (Development) (subscription dummy_p6_c5a, user 86500000000000002) was not installed: offering 'Dummy low' does not sell variant 'dummy_other' through Dummy (Development). If Dummy (Development) keeps billing it, cancel it there; refund it at Dummy (Development) if it was paid.",
      "[PremiumManager] subscription.created from Dummy (Development) (subscription dummy_p6_c5c, user 86500000000000002) was not installed: user 86500000000000002 already holds 'Dummy low' at that priority. If Dummy (Development) keeps billing it, cancel it there; refund it at Dummy (Development) if it was paid.",
      "[PremiumManager] subscription.created from PayPal (subscription I-P6C5A, guild 86600000000000001) was not installed: offering 'Gold PayPal' does not sell variant 'P-9' through PayPal. If PayPal keeps billing it, cancel it there; refund it at PayPal if it was paid.",
      "[PremiumManager] subscription.created from PayPal (subscription I-P6C5C, guild 86600000000000001) was not installed: guild 86600000000000001 already holds 'Gold PayPal' at that priority. If PayPal keeps billing it, cancel it there; refund it at PayPal if it was paid.",
    ]);
  });

  it('C6 (E4): a user: record carrying another application id: the dev card shows PD19 and End now, whose confirm is PD19; End now removes it, calls nothing and sends no notice', async () => {
    const a = await h.bought(SKU.A);
    w.setCredentials({ applicationId: OTHER_APP });
    const card = await h.card(U);
    expect(card.lookup.subscriptions.active).toMatchObject({ providerSubId: a.id, followed: false, whyNot: 'other-app' });
    expect(card.text).toContain(PD19);
    expect(card.labels.filter(l => /^(Cancel|Renew again|End now|Cancel & remove)$/.test(l))).toEqual(['End now']);
    await card.click(/^End now$/);
    expect(card.prompts).toEqual([PD19]);
    const calls = w.fake.calls.length;
    const from = w.notices().length;
    expect(await w.op('cancelPaidSubscriptionImmediately', H)).toMatchObject({ ok: true, result: true });
    expect(h.record(H)).toBeNull();
    expect(w.fake.calls.length).toBe(calls);
    expect(h.since(from)).toEqual([]);
  });

  it('C6 (E4): queued under another application id, its Cancel & remove confirm is PD19 and it is removed; with the configured id the same record answers PD11', async () => {
    const a = await h.bought(SKU.A);
    await h.bought(SKU.B);
    const queuedId = h.heldOf(a.id)!.sub.id;
    expect((await w.op('cancelAndRemovePausedSubscription', H, queuedId))).toMatchObject({ ok: false, error: PD11 });
    w.setCredentials({ applicationId: OTHER_APP });
    const card = await h.card(U);
    expect(card.lookup.subscriptions.paused[0]).toMatchObject({ followed: false, whyNot: 'other-app' });
    await card.click(/^Cancel & remove$/);
    expect(card.prompts).toEqual([PD19]);
    expect(await w.op('cancelAndRemovePausedSubscription', H, queuedId)).toMatchObject({ ok: true, result: true });
    expect(h.heldOf(a.id)).toBeNull();
  });

  it('C6 (E13): with Discord not configured, the dev card shows PD19b and End now, and End now removes the record with no notice', async () => {
    const a = await h.bought(SKU.A);
    w.setCredentials({ applicationId: undefined });
    const card = await h.card(U);
    expect(card.lookup.subscriptions.active).toMatchObject({ providerSubId: a.id, followed: false, whyNot: 'not-configured' });
    expect(card.text).toContain(PD19B);
    expect(card.text.includes(PD19)).toBe(false);
    await card.click(/^End now$/);
    expect(card.prompts).toEqual([PD19B]);
    const from = w.notices().length;
    expect(await w.op('cancelPaidSubscriptionImmediately', H)).toMatchObject({ ok: true, result: true });
    expect(h.record(H)).toBeNull();
    expect(h.since(from)).toEqual([]);
  });

  it('claim 9: the dev card for a followed user: Discord record shows PD9 and none of its four buttons; a Dummy record keeps them', async () => {
    await h.dummyTiers();
    await h.bought(SKU.A);
    await h.bought(SKU.B);
    const card = await h.card(U);
    expect(card.text.split(PD9).length - 1).toBe(2);
    expect(card.labels.filter(l => /^(Cancel|Renew again|End now|Cancel & remove)$/.test(l))).toEqual([]);
    h.dummyCreated(H2, U2, 'dlow', 'o-d', 'dummy_p6_card');
    await w.settle();
    const dummy = await h.card(U2);
    expect(dummy.text.includes(PD9)).toBe(false);
    expect(dummy.labels.filter(l => /^(Cancel|Renew again|End now)$/.test(l))).toEqual(['Cancel', 'Renew again', 'End now']);
  });
});
