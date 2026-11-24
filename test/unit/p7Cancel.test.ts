import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P7 claim 10 as part 1 builds it (sheet P7, section 10; 4.7 and decision 11): premium refuses an admin's End now and
// queued Cancel & remove on a record whose provider declares `endedByProviderOnly` and follows that record, of either
// holder kind, with the provider's own `endedByProviderText`; a record the provider does not follow is removable; the
// Dummy's End now still ends its records. Discord declares PD11 word for word, so its refusal is unchanged (C2: P6's
// C1, C4 and C6 in p6Cancel.test.ts stay green). The faked provider of helpers/p7World.ts (D8; pp declares the flags
// in part 2), the real PremiumManager in the bot role over the JSON files and over the mirror rig.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { dataPath } from '../../src/utils/dataRoot';
import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { DiscordProvider } from '../../src/bot/internalSetup/utils/payment/discordProvider';
import { noticePayloads } from '../helpers/p1Mocks';
import { loadGuildPanel, panelText, type Node } from '../helpers/p1PanelRig';
import { mount, settle as cardSettle } from '../helpers/jsxRig';
import { PATREON_USERS, PTIER } from '../helpers/p7Patreon';
import { LOG, PT11 } from '../helpers/p7Rows';
import { BASE_URL, FOLLOWER_ENDED_TEXT, FOLLOWER_ID, GUILDS, p7World, USERS, type P7World } from '../helpers/p7World';

const U = USERS[0];
const U2 = USERS[1];
const H = `user:${U}`;
const H2 = `user:${U2}`;
const G = `guild:${GUILDS[0]}`;
const BACKENDS = [['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]] as const;
const DAY = 86_400_000;
const PD11 = "Discord manages this subscription, so the bot cannot end or remove it. It ends when the member's subscription ends in Discord or Discord refunds it.";
const PD12_SENTENCE = 'The bot cannot pause it in Discord; if you no longer want it, cancel it in Discord.';

function helpers(w: P7World) {
  return {
    record: (holder: string): any => w.stored()?.subscriptions?.[holder] ?? null,
    /** The faked provider's record of `providerSubId`, with where it sits. */
    heldOf(holder: string, providerSubId: string): { location: 'active' | 'paused'; sub: any } | null {
      const rec = w.stored()?.subscriptions?.[holder];
      if (rec?.active?.providerSubId === providerSubId) return { location: 'active', sub: rec.active };
      const queued = (rec?.paused ?? []).find((p: any) => p.providerSubId === providerSubId);
      return queued ? { location: 'paused', sub: queued } : null;
    },
    async install(holder: string, buyer: string, ptier: string, meta: Record<string, unknown> = {}): Promise<string> {
      const id = w.follower.install(holder, buyer, ptier, meta);
      await w.settle();
      return id;
    },
    since: (from: number) => w.notices().slice(from).map((n, i) => ({ ...n, payload: noticePayloads[from + i] as any })),
  };
}

describe.each(BACKENDS)('P7 part 1 on %s: C1, an admin cannot end or remove a followed record of an endedByProviderOnly provider', (_name, backend) => {
  const w = p7World(backend);
  const h = helpers(w);
  beforeEach(async () => { await w.setup({ faked: true }); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it.each([['a user', H, U, PTIER.A, PTIER.B], ['a server', G, U, PTIER.S, PTIER.B]] as const)(
    "C1 (%s holder): End now and the queued Cancel & remove throw the provider's endedByProviderText with premium's bytes unchanged and no notice (fails on a build that refuses only user: records, or throws Discord's PD11)",
    async (_kind, holder, buyer, low, high) => {
      const lowId = await h.install(holder, buyer, low);
      const highId = await h.install(holder, buyer, high);
      expect([h.heldOf(holder, lowId)?.location, h.heldOf(holder, highId)?.location]).toEqual(['paused', 'active']);
      const before = w.storedText();
      const audit = w.auditLines().length;
      const notices = w.notices().length;
      const endNow = await w.op('cancelPaidSubscriptionImmediately', holder);
      const removed = await w.op('cancelAndRemovePausedSubscription', holder, h.heldOf(holder, lowId)!.sub.id);
      expect([endNow.ok, endNow.error, removed.ok, removed.error]).toEqual([false, FOLLOWER_ENDED_TEXT, false, FOLLOWER_ENDED_TEXT]);
      expect(w.storedText()).toBe(before);
      expect(w.auditLines().length).toBe(audit);
      expect(w.notices().length).toBe(notices);
    },
  );

  it.each([['a user', H, PTIER.A, PTIER.B], ['a server', G, PTIER.S, PTIER.B]] as const)(
    'C1 (%s holder): a record the provider does not follow is removed by End now and by the queued Cancel & remove, with no notice',
    async (_kind, holder, low, high) => {
      const lowId = await h.install(holder, U, low, { followed: false });
      const highId = await h.install(holder, U, high, { followed: false });
      const notices = w.notices().length;
      const removed = await w.op('cancelAndRemovePausedSubscription', holder, h.heldOf(holder, lowId)!.sub.id);
      expect(removed).toMatchObject({ ok: true, result: true });
      expect(h.heldOf(holder, lowId)).toBeNull();
      expect(await w.op('cancelPaidSubscriptionImmediately', holder)).toMatchObject({ ok: true, result: true });
      expect(h.heldOf(holder, highId)).toBeNull();
      expect(h.since(notices)).toEqual([]);
    },
  );
});

describe('P7 part 1: C3, the refusal and the queue sentence come from the capability strings', () => {
  const w = p7World('json');
  const h = helpers(w);
  beforeEach(async () => { await w.setup({ faked: true }); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it("C3: Discord declares PD11 and PD12's sentence word for word; a changed endedByProviderText is what End now throws (fails on a build with the text written in premium)", async () => {
    const dp = new DiscordProvider();
    expect([(dp.capabilities as any).endedByProviderText, (dp.capabilities as any).queuedBilledText]).toEqual([PD11, PD12_SENTENCE]);
    await h.install(H, U, PTIER.A);
    const caps = getPaymentRegistry().get(FOLLOWER_ID)!.capabilities as any;
    caps.endedByProviderText = 'Another sentence the faked provider declares.';
    const before = w.storedText();
    expect(await w.op('cancelPaidSubscriptionImmediately', H)).toMatchObject({ ok: false, error: 'Another sentence the faked provider declares.' });
    expect(w.storedText()).toBe(before);
  });

  it("C3: the Dummy's End now still ends its user and server records and tells the member", async () => {
    const link = { providerId: 'dummy', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'dummy_monthly_999' }] } };
    expect((await w.op('setTier', 'dlow', { displayName: 'Dummy low', priority: 1, overrides: {}, kind: 'user', offerings: [{ id: 'o-d', label: 'Dummy low', providerLinks: [link] }] })).ok).toBe(true);
    expect((await w.op('setTier', 'gdummy', { displayName: 'Gold Dummy', priority: 1, overrides: {}, offerings: [{ id: 'o-gd', label: 'Gold Dummy', providerLinks: [link] }] })).ok).toBe(true);
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    for (const [holder, buyer, tierId, offeringId, id] of [[H2, U2, 'dlow', 'o-d', 'dummy_p7_c3u'], [G, U, 'gdummy', 'o-gd', 'dummy_p7_c3g']] as const) {
      getPaymentRegistry().emitEvent({ type: 'subscription.created', providerId: 'dummy', providerSubId: id, holder: holder as any, buyerId: buyer, tierId, offeringId, variantId: 'dummy_monthly_999', state: { status: 'active', startDate: iso(now), endDate: iso(now + 30 * DAY), autoRenew: true } } as any);
      await w.settle();
    }
    expect([h.record(H2)?.active?.providerId, h.record(G)?.active?.providerId]).toEqual(['dummy', 'dummy']);
    const from = w.notices().length;
    expect(await w.op('cancelPaidSubscriptionImmediately', H2)).toMatchObject({ ok: true, result: true });
    expect(await w.op('cancelPaidSubscriptionImmediately', G)).toMatchObject({ ok: true, result: true });
    expect([h.record(H2), h.record(G)]).toEqual([null, null]);
    expect(h.since(from).map(n => [n.to, n.kind])).toEqual([[H2, 'paid.sub.cancelled-by-user'], [G, 'paid.sub.cancelled-by-user']]);
  });
});

describe.each(BACKENDS)('P7 part 2 on %s: C1 with the Patreon provider', (_name, backend) => {
  const w = p7World(backend);
  const h = helpers(w);
  beforeEach(async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0, multiTier: true } });
    await w.advance(31_000);
  });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it.each([['a user', H, PTIER.A, PTIER.B], ['a server', G, PTIER.S, PTIER.B]] as const)(
    "C1 (%s holder): End now and the queued Cancel & remove on a followed Patreon record throw PT11 with premium's bytes unchanged (fails on P6's tree: Patreon declares no flag)",
    async (_kind, holder, low, high) => {
      expect((await w.op('linkAccount', 'patreon', PATREON_USERS[0], holder, U)).ok).toBe(true);
      w.fake.pledge(PATREON_USERS[0], low);
      w.fake.pledge(PATREON_USERS[0], high);
      await w.deliverAll();
      const m = w.fake.memberOf(PATREON_USERS[0])!;
      expect([h.heldOf(holder, `patreon:${m.id}:${low}`)?.location, h.heldOf(holder, `patreon:${m.id}:${high}`)?.location]).toEqual(['paused', 'active']);
      const before = w.storedText();
      const endNow = await w.op('cancelPaidSubscriptionImmediately', holder);
      const removed = await w.op('cancelAndRemovePausedSubscription', holder, h.heldOf(holder, `patreon:${m.id}:${low}`)!.sub.id);
      expect([endNow.ok, endNow.error, removed.ok, removed.error]).toEqual([false, PT11, false, PT11]);
      expect(w.storedText()).toBe(before);
    },
  );
});

describe("P7 part 2 on the mirror rig: Patreon's settings cannot be read", () => {
  const w = p7World('rig');
  const h = helpers(w);
  const DOC = () => dataPath('global', 'payment-providers', 'credentials.json');
  const UNREAD = "payment-providers/credentials.json cannot be read now, so the bot can't confirm whether Patreon bills this subscription, and it does not end or remove it. Try again once it can be read.";
  beforeEach(async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0, multiTier: true } });
    await w.advance(31_000);
  });
  afterEach(async () => {
    fs.rmSync(DOC(), { force: true });
    await w.teardown();
    vi.restoreAllMocks();
  });

  it("End now and the queued Cancel & remove on a Patreon record answer that the bot can't confirm whether Patreon bills it, with premium's bytes unchanged (fails on a build whose text names Discord)", async () => {
    expect((await w.op('linkAccount', 'patreon', PATREON_USERS[0], H, U)).ok).toBe(true);
    w.fake.pledge(PATREON_USERS[0], PTIER.A);
    w.fake.pledge(PATREON_USERS[0], PTIER.B);
    await w.deliverAll();
    const m = w.fake.memberOf(PATREON_USERS[0])!;
    expect([h.heldOf(H, `patreon:${m.id}:${PTIER.A}`)?.location, h.heldOf(H, `patreon:${m.id}:${PTIER.B}`)?.location]).toEqual(['paused', 'active']);
    fs.mkdirSync(path.dirname(DOC()), { recursive: true });
    fs.writeFileSync(DOC(), '{"patreon": ');
    const before = w.storedText();
    const endNow = await w.op('cancelPaidSubscriptionImmediately', H);
    const removed = await w.op('cancelAndRemovePausedSubscription', H, h.heldOf(H, `patreon:${m.id}:${PTIER.A}`)!.sub.id);
    expect([endNow.ok, endNow.error, removed.ok, removed.error]).toEqual([false, UNREAD, false, UNREAD]);
    expect(w.storedText()).toBe(before);
  });

  it("part 4: the dev card shows Patreon's own can't-confirm text for a Patreon record while the settings cannot be read, not Discord's, and no End now or Cancel & remove (fails on today's card)", async () => {
    expect((await w.op('linkAccount', 'patreon', PATREON_USERS[0], H, U)).ok).toBe(true);
    w.fake.pledge(PATREON_USERS[0], PTIER.A);
    w.fake.pledge(PATREON_USERS[0], PTIER.B);
    await w.deliverAll();
    fs.mkdirSync(path.dirname(DOC()), { recursive: true });
    fs.writeFileSync(DOC(), '{"patreon": ');
    const card = await devCard(w, U);
    expect(card.text.split(UNREAD).length - 1).toBe(2);
    expect(card.text.includes(DISCORD_UNREAD)).toBe(false);
    expect(card.labels.filter(l => /^(Cancel|Renew again|End now)/.test(l))).toEqual([]);
  });

  it("part 4: the server card shows Patreon's can't-confirm text on a Patreon record while the settings cannot be read, with no Cancel or Cancel & remove now (fails on a card that keeps Cancel & remove now)", async () => {
    expect((await w.op('linkAccount', 'patreon', PATREON_USERS[0], G, U)).ok).toBe(true);
    w.fake.pledge(PATREON_USERS[0], PTIER.S);
    await w.deliverAll();
    fs.mkdirSync(path.dirname(DOC()), { recursive: true });
    fs.writeFileSync(DOC(), '{"patreon": ');
    const p = await serverPanel(w, U, GUILDS[0]);
    expect(p.view.subscriptions.active).toMatchObject({ providerId: 'patreon', followed: false, whyNot: 'unread' });
    const shown = p.shown();
    expect([shown.text.includes(UNREAD), shown.text.includes(DISCORD_UNREAD)]).toEqual([true, false]);
    expect(shown.labels.filter(l => /^(Cancel|Reactivate|Manage at provider)/.test(l))).toEqual([]);
  });
});

// Part 4 (claim 10's C5 to C7; 4.2, 4.7): the server panel (GuildSubscriptionPanel.jsx) rendered on the server route's
// answer, the subscribe modal on that answer's tiers, and the dev card (AppStorePanel.jsx) on the dev lookup's answer;
// their calls go to the real routes.

const PT9 = 'Patreon manages this pledge. The member ends it on patreon.com or unlinks their Patreon account here; the tier ends when Patreon no longer shows it as paid. Refunds are made on Patreon.';
const PT19 = 'The bot does not follow this Patreon record (it was made by an earlier version or under another campaign), so it never ends it. Removing it does not change the member\'s pledge on Patreon.';
const PT19B = 'Patreon is not configured on this bot, so it does not follow this record. Removing it does not change the member\'s pledge on Patreon.';
const PT22 = (holder: string) => `Your Patreon account is unlinked, and its tier was removed from ${holder.replace(':', ' ')}.`;
const PT23 = 'Only the member who linked this Patreon pledge can unlink it.';
const PT28 = 'If you are asked to sign in with Discord first, open this link again afterwards.';
const PD19 = "This subscription carries another Discord application id than the one configured, so the bot does not follow it. If the configured id is wrong, fix it instead. Removing it does not stop that application's billing.";
const PD19B = "Discord is not configured on this bot, so it does not follow this subscription. Removing it does not stop Discord's billing.";
const DISCORD_UNREAD = "payment-providers/credentials.json cannot be read now, so the bot can't confirm whether Discord bills this subscription, and it does not end or remove it. Try again once it can be read.";
const PANEL = path.join(__dirname, '../../src/webui/public/assets/components/guild/GuildSubscriptionPanel.jsx');
const CARD = path.join(__dirname, '../../src/webui/public/components/AppStorePanel.jsx');
const ORIGIN = 'https://bot.example';
/** The dev page opened on a LAN address: the card's URL still names WEBUI_BASE_URL (4.2). */
const DEV_PAGE_ORIGIN = 'http://192.168.1.20:3000';
const START_ME = `${BASE_URL}/guild/api/subscriptions/patreon/start?for=me`;
const flushPanel = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise(resolve => { setImmediate(resolve); }); };

const MEMBER_ROUTES = ['/patreon/link', '/:guildId/provider-links/:providerId', '/:guildId/paid/expire-now', '/:guildId/paid/reactivate', '/:guildId/paused/:subscriptionId', '/:guildId/paid', '/:guildId'];

/**
 * The page's guildApi.js, its fetch answered by the member routes as `user` (the lists the panel loads on its own
 * answer empty); `calls` records each request as `METHOD path`.
 */
function memberApi(w: P7World, user: string) {
  const calls: string[] = [];
  const source = fs.readFileSync(path.join(__dirname, '../../src/webui/public/assets/utils/guildApi.js'), 'utf8');
  const fetch = async (url: string, init: { method?: string } = {}) => {
    const method = (init.method ?? 'GET').toLowerCase();
    calls.push(`${method.toUpperCase()} ${url}`);
    const reply = (status: number, body: unknown) => ({ status, json: async () => body, clone: () => reply(status, body) });
    if (url.endsWith('/orphans')) return reply(200, { success: true, orphans: [] });
    if (url.endsWith('/migrations')) return reply(200, { success: true, migrations: [] });
    if (url.startsWith('/guild/api/panels/channels')) return reply(200, { success: true, channels: [] });
    const wanted = url.replace(/^\/guild\/api\/subscriptions/, '');
    for (const routePath of MEMBER_ROUTES) {
      const names: string[] = [];
      const hit = new RegExp(`^${routePath.replace(/:([A-Za-z]+)/g, (_m: string, n: string) => { names.push(n); return '([^/?]+)'; })}$`).exec(wanted);
      if (!hit) continue;
      const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(hit[i + 1])]));
      const answer = await w.memberRoute(user, method, routePath, { params });
      return reply(answer.status, answer.body);
    }
    throw new Error(`memberApi: no member route for ${method} ${url}`);
  };
  const api = new Function('fetch', 'window', 'console', `${source}\nreturn guildApi;`)(fetch, { location: { href: '' } }, console);
  return { api, calls };
}

/** The server panel on the server route's answer for `user`; its calls go to the server routes as that user. */
async function serverPanel(w: P7World, user: string, guild: string, confirmed = false) {
  const view = await w.memberRoute(user, 'get', '/:guildId', { params: { guildId: guild } });
  expect(view.status).toBe(200);
  const confirms: string[] = [];
  const { api, calls } = memberApi(w, user);
  const panel = loadGuildPanel(api, text => { confirms.push(text); return confirmed; });
  const props = { guild: { id: guild }, subData: view.body, onRefresh: async () => {} };
  panel.render(props);
  await flushPanel();
  const shown = () => {
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
    return { text: panelText(tree), labels: buttons.map(b => b.label), button: (label: string) => buttons.find(b => b.label === label)! };
  };
  return { view: view.body, confirms, calls, shown };
}

/** The dev routes (routes/appstore.ts) as the dev card calls them: `/appstore/<path>` to the route's last handler. */
async function devRoutes(w: P7World) {
  const { createAppStoreRoutes } = await import('../../src/webui/routes/appstore');
  const router: any = createAppStoreRoutes({
    storeDocsFirst: async () => null,
    migrationRunning: () => null,
    isRunning: () => false,
    listLoadedModules: async () => null,
    runSharedOp: (name: string, args: unknown) => w.sharedOp(name, args),
  } as any);
  return async (method: string, url: string, body?: unknown): Promise<any> => {
    const wanted = url.replace(/^\/appstore/, '');
    for (const layer of router.stack) {
      if (!layer.route || !layer.route.methods[method]) continue;
      const names: string[] = [];
      const pattern = new RegExp(`^${String(layer.route.path).replace(/:([A-Za-z]+)/g, (_m: string, n: string) => { names.push(n); return '([^/]+)'; })}$`);
      const hit = pattern.exec(wanted);
      if (!hit) continue;
      const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(hit[i + 1])]));
      const sent: any[] = [];
      let code = 200;
      const res: any = {
        status(c: number) { code = c; return res; },
        json(payload: unknown) { sent.push({ status: code, ...(payload as object) }); return res; },
      };
      const handlers = layer.route.stack;
      await w.pump(Promise.resolve(handlers[handlers.length - 1].handle({ query: {}, params, body: body ?? {}, protocol: 'https', get: () => 'bot.example' }, res, () => undefined)));
      await w.settle();
      if (sent.length !== 1) throw new Error(`devRoutes: ${method} ${url} answered ${sent.length} times`);
      return sent[0];
    }
    throw new Error(`devRoutes: no route ${method} ${url}`);
  };
}

/** The dev card after its Look up of `userId`, with the providers the dev page lists. */
async function devCard(w: P7World, userId: string, confirmed = false) {
  const call = await devRoutes(w);
  const providers = (await call('get', '/appstore/premium/providers')).providers;
  const prompts: string[] = [];
  const inflight: Array<Promise<unknown>> = [];
  const answer = (method: string) => (url: string, body?: unknown) => {
    const p = url.endsWith('/orphans') ? Promise.resolve({ success: true, orphans: [] }) : call(method, url, body);
    inflight.push(p);
    return p;
  };
  const api = { get: answer('get'), post: answer('post'), put: answer('put'), delete: answer('delete') };
  const window = { location: { origin: DEV_PAGE_ORIGIN, href: '' } };
  const m = mount(CARD, 'DummyTestPurchase', { activated: true, showSuccess: () => {}, setError: () => {}, providers }, { api, window, confirm: (p: string) => { prompts.push(p); return confirmed; } });
  const drain = async () => {
    await cardSettle();
    while (inflight.length) { await inflight.shift(); await cardSettle(); }
  };
  await drain();
  const field = (name: string) => m.all(el => el.props.name === name)[0];
  field('kind').props.onChange({ target: { value: 'user' } });
  await drain();
  field('holderId').props.onChange({ target: { value: userId } });
  await drain();
  m.button(/^Look up$/).props.onClick();
  await drain();
  return {
    get text() { return m.tree ? m.text(m.tree) : ''; },
    get labels() { return m.all(el => el.type === 'button').map(el => m.text(el)); },
    prompts,
    click: async (label: RegExp) => { m.button(label).props.onClick(); await drain(); },
  };
}

describe.each(BACKENDS)('P7 part 4 on %s: C5, the server card and the dev card of a followed Patreon record', (_name, backend) => {
  const w = p7World(backend);
  const G0 = GUILDS[0];
  beforeEach(async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0, multiTier: true } });
    await w.advance(31_000);
  });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it('C5: the server card shows PT9 on the active and the queued record, Unlink Patreon, and no Cancel, Reactivate or Cancel & remove (fails on a card that keeps them)', async () => {
    expect((await w.op('linkAccount', 'patreon', PATREON_USERS[0], G, U)).ok).toBe(true);
    w.fake.pledge(PATREON_USERS[0], PTIER.S);
    w.fake.pledge(PATREON_USERS[0], PTIER.B);
    await w.deliverAll();
    const p = await serverPanel(w, U, G0);
    expect([p.view.subscriptions.active.followed, p.view.subscriptions.paused[0].followed]).toEqual([true, true]);
    const shown = p.shown();
    expect(shown.text.split(PT9).length - 1).toBe(2);
    expect(shown.labels.filter(l => /^(Cancel|Reactivate|Manage at provider|Unlink Patreon)/.test(l))).toEqual(['Unlink Patreon']);
  });

  it("C5: Unlink Patreon by another admin shows PT23 and changes nothing; by the payer it shows PT22 (fails on a card that drops the unlink's answer)", async () => {
    expect((await w.op('linkAccount', 'patreon', PATREON_USERS[0], G, U)).ok).toBe(true);
    w.fake.pledge(PATREON_USERS[0], PTIER.S);
    await w.deliverAll();
    const before = w.storedText();
    const other = await serverPanel(w, U2, G0, true);
    await other.shown().button('Unlink Patreon').onClick();
    expect(other.shown().text).toContain(PT23);
    expect(w.storedText()).toBe(before);
    const payer = await serverPanel(w, U, G0, true);
    await payer.shown().button('Unlink Patreon').onClick();
    expect(payer.shown().text).toContain(PT22(G));
    expect([getPremiumManager().getFullConfig().providerAccountLinks?.patreon ?? {}, w.stored()?.subscriptions?.[G]?.active ?? null]).toEqual([{}, null]);
  });

  it('C5: the dev card shows PT9 on the active and the queued record with no End now, Cancel or Cancel & remove, and the link URL with PT28 (fails on a card that shows them, or no URL)', async () => {
    expect((await w.op('linkAccount', 'patreon', PATREON_USERS[0], H, U)).ok).toBe(true);
    w.fake.pledge(PATREON_USERS[0], PTIER.A);
    w.fake.pledge(PATREON_USERS[0], PTIER.B);
    await w.deliverAll();
    const card = await devCard(w, U);
    expect(card.text.split(PT9).length - 1).toBe(2);
    expect(card.labels.filter(l => /^(Cancel|Renew again|End now)/.test(l))).toEqual([]);
    expect(card.text).toContain(START_ME);
    expect(card.text.includes(DEV_PAGE_ORIGIN)).toBe(false);
    expect(card.text).toContain(PT28);
  });

  it('C5: a Patreon record queued behind a higher manual plan shows PT9 and Unlink Patreon on its queued card, and the button unlinks it (fails on a card that offers Unlink only on an active Patreon record)', async () => {
    expect((await w.op('grantManual', G, 'platinum', 1)).ok).toBe(true);
    expect((await w.op('linkAccount', 'patreon', PATREON_USERS[0], G, U)).ok).toBe(true);
    w.fake.pledge(PATREON_USERS[0], PTIER.S);
    await w.deliverAll();
    const p = await serverPanel(w, U, G0, true);
    expect([p.view.subscriptions.active?.source, p.view.subscriptions.paused[0]?.providerId, p.view.subscriptions.paused[0]?.followed]).toEqual(['manual', 'patreon', true]);
    const shown = p.shown();
    expect(shown.text).toContain(PT9);
    expect(shown.labels.filter(l => /^Unlink Patreon/.test(l))).toEqual(['Unlink Patreon']);
    await shown.button('Unlink Patreon').onClick();
    expect(p.shown().text).toContain(PT22(G));
    expect(getPremiumManager().getFullConfig().providerAccountLinks?.patreon ?? {}).toEqual({});
  });
});

describe('P7 part 4: C6, the Patreon offering in the subscribe modal', () => {
  const w = p7World('json');
  beforeEach(async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0 } });
  });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it('C6: the Patreon offering shows PT28 and a link button that navigates to start?for=<guildId>; it offers no variant to buy and calls no purchase (fails on a modal that sells Patreon variants)', async () => {
    const view = (await w.memberRoute(U, 'get', '/:guildId', { params: { guildId: GUILDS[0] } })).body;
    const { api, calls } = memberApi(w, U);
    const window = { location: { origin: ORIGIN, href: '', search: '', pathname: '/', hash: '' }, history: { replaceState() {} } };
    const m = mount(PANEL, 'SubscribeModal', {
      guildId: GUILDS[0], tierId: 'gold', tier: view.tiers.gold, providers: view.providers,
      willBePaused: false, activeTierName: null, onClose() {}, onSuccess() {},
    }, {
      guildApi: api, window, alert: () => {}, confirm: () => true, disabledButtonStyle: () => ({}), RefetchOverlay: 'RefetchOverlay', FirstLoadPlaceholder: 'FirstLoadPlaceholder',
    });
    await cardSettle();
    m.all(el => el.props.key === 'o-s')[0].props.onClick();
    await cardSettle();
    expect(m.text(m.tree!)).toContain(PT28);
    expect(m.all(el => typeof el.props.key === 'string' && el.props.key.startsWith('patreon:'))).toEqual([]);
    const link = m.button(/Patreon/);
    expect(link).toBeTruthy();
    await link.props.onClick();
    await cardSettle();
    expect(window.location.href).toBe(`/guild/api/subscriptions/patreon/start?for=${GUILDS[0]}`);
    const submit = m.button(/^Subscribe$/);
    if (submit && !submit.props.disabled) await submit.props.onClick();
    expect(calls).toEqual([]);
    const started = await w.memberRoute(U, 'get', '/patreon/start', { query: { for: GUILDS[0] } });
    expect(String(started.redirect)).toMatch(/^https:\/\/www\.patreon\.com\/oauth2\/authorize\?/);
  });

  it("guildApi's patreonUnlink calls the VIP unlink route and returns its PT22 answer", async () => {
    w.fake.pledge(PATREON_USERS[0], PTIER.A);
    expect((await w.op('linkAccount', 'patreon', PATREON_USERS[0], H, U)).ok).toBe(true);
    await w.round();
    expect(w.stored()?.subscriptions?.[H]?.active?.providerId).toBe('patreon');
    const { api, calls } = memberApi(w, U);
    expect(await api.patreonUnlink()).toEqual({ success: true, message: PT22(H) });
    expect(calls).toEqual(['DELETE /guild/api/subscriptions/patreon/link']);
    expect(getPremiumManager().getFullConfig().providerAccountLinks?.patreon ?? {}).toEqual({});
  });
});

describe('P7 part 4: C7 and the dev card, records the bot does not follow', () => {
  const w = p7World('json');
  const G0 = GUILDS[0];
  beforeEach(async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0, multiTier: true } });
    await w.advance(31_000);
  });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it('C7: a pre-P7 server record (written by hand in the shape of the old callback) is never read, shows PT19 and only Cancel & remove now, whose confirm is PT19, and that removes it (fails on a card without PT19)', async () => {
    expect((await w.op('linkAccount', 'patreon', PATREON_USERS[0], G, U)).ok).toBe(true);
    w.fake.pledge(PATREON_USERS[0], PTIER.S);
    await w.deliverAll();
    const doc = w.stored();
    const old = doc.subscriptions[G].active;
    Object.assign(old, { providerSubId: `patreon:${PATREON_USERS[0]}:${G0}`, providerMeta: { patreonUserId: PATREON_USERS[0], patreonTierId: PTIER.S } });
    doc.providerAccountLinks.patreon = {};
    fs.writeFileSync(dataPath('global', 'premium-tiers.json'), JSON.stringify(doc, null, 2));
    getPremiumManager().invalidate();
    const from = w.fake.calls.length;
    expect(await w.round()).toBe(true);
    expect(w.fake.calls.slice(from).filter(c => c.route === 'member')).toEqual([]);
    expect(w.logged(LOG.PT18_TAIL)).toHaveLength(1);
    expect(w.stored().subscriptions[G].active.providerSubId).toBe(`patreon:${PATREON_USERS[0]}:${G0}`);

    const p = await serverPanel(w, U, G0, true);
    const shown = p.shown();
    expect(shown.text).toContain(PT19);
    expect(shown.text.includes(PT9)).toBe(false);
    expect(shown.labels.filter(l => /^(Cancel|Reactivate|Manage at provider)/.test(l))).toEqual(['Cancel & remove now']);
    await shown.button('Cancel & remove now').onClick();
    expect(p.confirms).toEqual([PT19]);
    expect(w.stored().subscriptions[G]?.active ?? null).toBeNull();
  });

  it("the dev card shows Patreon's PT19 for a record of another campaign, and PT19b with Patreon not configured, never Discord's PD19 or PD19b; End now's confirm is that text and removes the record (fails on today's card)", async () => {
    expect((await w.op('linkAccount', 'patreon', PATREON_USERS[0], H, U)).ok).toBe(true);
    w.fake.pledge(PATREON_USERS[0], PTIER.A);
    await w.deliverAll();
    w.setCredentials({ PATREON_CAMPAIGN_ID: '8100002' });
    const other = await devCard(w, U);
    expect(other.text).toContain(PT19);
    expect([other.text.includes(PD19), other.text.includes(PD19B)]).toEqual([false, false]);
    await other.click(/^End now$/);
    expect(other.prompts).toEqual([PT19]);

    w.setCredentials({ PATREON_CAMPAIGN_ID: undefined });
    const unset = await devCard(w, U, true);
    expect(unset.text).toContain(PT19B);
    expect([unset.text.includes(PD19), unset.text.includes(PD19B)]).toEqual([false, false]);
    await unset.click(/^End now$/);
    expect(unset.prompts).toEqual([PT19B]);
    expect(w.stored().subscriptions[H]?.active ?? null).toBeNull();
  });

  it('the server card shows PT19b on a Patreon record while Patreon is not configured, and only Cancel & remove now, whose confirm is PT19b (fails on a card without PT19b)', async () => {
    expect((await w.op('linkAccount', 'patreon', PATREON_USERS[0], G, U)).ok).toBe(true);
    w.fake.pledge(PATREON_USERS[0], PTIER.S);
    await w.deliverAll();
    w.setCredentials({ PATREON_CAMPAIGN_ID: undefined });
    const p = await serverPanel(w, U, G0);
    const shown = p.shown();
    expect([shown.text.includes(PT19B), shown.text.includes(PT9)]).toEqual([true, false]);
    expect(shown.labels.filter(l => /^(Cancel|Reactivate|Manage at provider)/.test(l))).toEqual(['Cancel & remove now']);
    await shown.button('Cancel & remove now').onClick();
    expect(p.confirms).toEqual([PT19B]);
  });
});
