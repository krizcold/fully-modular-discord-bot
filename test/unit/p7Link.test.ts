import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P7 claim 8 as part 1 builds it (sheet P7, section 10; 4.3 and 4.7): premium's half. An unlink by one payer removes
// only the link naming that holder and that buyer, then ends only the records whose `meta.patreonUserId` is that
// link's account (U3, F11), link first (decision 4); `setAccountHolder` moves a link to another holder in one save
// and refuses a buyer the link does not name. Part 3 adds the routes' half. The faked provider of helpers/p7World.ts
// (D8) installs the records as P7's pp will, the links are made by premium.linkAccount (the save the callback makes),
// the real PremiumManager in the bot role over the JSON files and over the mirror rig.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPremiumManager, settlePremiumInstalls } from '../../src/bot/internalSetup/utils/premiumManager';
import { setOpSettler } from '../../src/bot/internalSetup/utils/sharedOps';
import { setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { allowDropLines } from '../helpers/p1Guard';
import { PATREON_AUTHORIZE_URL, PATREON_USERS, PTIER, TIER_TITLE, type PatreonSettings } from '../helpers/p7Patreon';
import { BASE_URL, FOLLOWER_ID, GUILDS, guildName, p7World, providerLink, tierDefOf, USERS, W_MS, type P7World, type RouteAnswer } from '../helpers/p7World';
import { eventsSince, holderOf, links, LOG, memberReads, MIN, SEC, tiersAt } from '../helpers/p7Rows';

const [U1, U2, U3] = USERS;
const [P1, P2] = PATREON_USERS;
const G = `guild:${GUILDS[0]}`;
const BACKENDS = [['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]] as const;

const followerLinks = (w: P7World): Record<string, { holder: string; buyerId: string }> => ({ ...(w.stored()?.providerAccountLinks?.[FOLLOWER_ID] ?? {}) });
const followerRecords = (w: P7World, holder: string): any[] => {
  const rec = w.stored()?.subscriptions?.[holder];
  return [...(rec?.active ? [rec.active] : []), ...(rec?.paused ?? [])].filter((s: any) => s.providerId === FOLLOWER_ID);
};

describe.each(BACKENDS)('P7 part 1 on %s: U3, an unlink by one payer', (_name, backend) => {
  const w = p7World(backend);
  beforeEach(async () => {
    await w.setup({ faked: true });
    expect((await w.op('linkAccount', FOLLOWER_ID, P1, G, U1)).ok).toBe(true);
    expect((await w.op('linkAccount', FOLLOWER_ID, P2, G, U2)).ok).toBe(true);
    w.follower.install(G, U1, PTIER.S, { patreonUserId: P1 });
    w.follower.install(G, U2, PTIER.B, { patreonUserId: P2 });
    await w.settle();
    expect(followerRecords(w, G).map(s => s.providerMeta.patreonUserId).sort()).toEqual([P1, P2].sort());
  });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it.each([['the queued payer', U1, P1, P2], ['the active payer', U2, P2, P1]] as const)(
    "U3: an unlink by %s removes that payer's link and record and leaves the other payer's link and record at the same server (fails on P6's tree, which takes the first link and ends every record there)",
    async (_who, buyer, gone, kept) => {
      const answer = await w.op('unlinkProviderAccount', G, FOLLOWER_ID, buyer);
      expect(answer).toMatchObject({ ok: true, result: true });
      expect(Object.keys(followerLinks(w))).toEqual([kept]);
      expect(followerRecords(w, G).map(s => s.providerMeta.patreonUserId)).toEqual([kept]);
      expect(followerRecords(w, G)[0].status).toBe('active');
      expect(gone).not.toBe(kept);
    },
  );

  it('U3: an unlink naming a buyer no link of that server names answers false and changes nothing', async () => {
    const before = w.storedText();
    expect(await w.op('unlinkProviderAccount', G, FOLLOWER_ID, USERS[2])).toMatchObject({ ok: true, result: false });
    expect(w.storedText()).toBe(before);
  });
});

describe.each(BACKENDS)('P7 part 1 on %s: setAccountHolder', (_name, backend) => {
  const w = p7World(backend);
  const H1 = `user:${U1}`;
  beforeEach(async () => {
    await w.setup({ faked: true });
    expect((await w.op('linkAccount', FOLLOWER_ID, P1, H1, U1)).ok).toBe(true);
  });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it("moves the link to the new holder in one save and keeps its buyer; the stored document differs only in that link (fails on P6's tree: no setAccountHolder)", async () => {
    const before = w.stored();
    const moved = (getPremiumManager() as any).setAccountHolder(FOLLOWER_ID, P1, U1, G);
    await w.settle();
    expect(moved).toBe(true);
    expect(followerLinks(w)).toEqual({ [P1]: { holder: G, buyerId: U1 } });
    const after = w.stored();
    after.providerAccountLinks[FOLLOWER_ID][P1].holder = H1;
    expect(after).toEqual(before);
  });

  it('refuses a buyer the stored link does not name, and an account with no link, with nothing saved', async () => {
    const before = w.storedText();
    const pm = getPremiumManager() as any;
    expect(typeof pm.setAccountHolder).toBe('function');
    expect(pm.setAccountHolder(FOLLOWER_ID, P1, U2, G)).toBe(false);
    expect(pm.setAccountHolder(FOLLOWER_ID, P2, U2, G)).toBe(false);
    await w.settle();
    expect(w.storedText()).toBe(before);
    expect(pm.getAccountLink(FOLLOWER_ID, P1)).toEqual({ holder: H1, buyerId: U1 });
  });
});

// Part 3 (claims 2, 8, 10's C4; 4.2, 4.3, 4.7): the member routes of routes/guildSubscriptions.ts with a signed-in
// session per Discord user, the authorize URL the start route builds approved on the fake, the callback in the same
// session, the real op and the real PatreonProvider; the owner check asks the faked discord.js client.

const VIP = 'your own VIP';
const server = (g: number) => `the server ${guildName(GUILDS[g])}`;
const PAGE = {
  linked: (where: string) => `<h2>Patreon linked</h2><p>Your Patreon account now backs ${where}. The bot gives the tier your pledge pays for while Patreon shows it as paid.</p>`,
  noPledge: '<p>Patreon shows no paid pledge to this creator on your account now.</p>',
  trial: '<p>Patreon shows a free trial; the tier starts with its first charge.</p>',
  active: (tier: string, where: string) => `<p>${tier} is now active on ${where}.</p>`,
  queued: (tier: string, where: string) => `<p>${tier} is queued on ${where} behind a higher plan; Patreon keeps charging it.</p>`,
  notGiven: (ptier: string, where: string) => `<p>Patreon shows ${TIER_TITLE[ptier]} as paid, but the bot gave no tier for it on ${where}; the bot's log says why (the tier may not be set up here, or ${where} already has a plan at that level).</p>`,
  uncharged: (ptier: string, where: string) => `<p>Patreon shows ${TIER_TITLE[ptier]} on your pledge but no paid charge for it yet, so the bot gives no tier for it on ${where} until Patreon shows a paid charge.</p>`,
  notConfirmed: "<h2>Patreon link not confirmed</h2><p>Can't confirm whether your Patreon account was linked: premium did not confirm every save.</p>",
  cantConfirm: "<p>Can't confirm the tier yet: ",
  soon: 'The bot checks again within 10 minutes.</p>',
  hour: 'The bot checks again within an hour; if the tier has not appeared by then, start the link again.</p>',
  lag: "<p>Patreon's answer may lag a recent change; the bot checks again within 10 minutes.</p>",
  PT15: '<h2>Patreon link not completed</h2><p>This link was started from another sign-in, more than 10 minutes ago, or was already used, so nothing was linked. Sign in with Discord on this site and start the link again.</p>',
  PT16: '<h2>Patreon account already linked</h2><p>This Patreon account is linked to another Discord account, so nothing was linked. That account unlinks it first.</p>',
  PT17: '<h2>Another Patreon account is linked</h2><p>Your Discord account is already linked to another Patreon account, so nothing was linked. Unlink it first.</p>',
  PT18a: "<h2>Not the server's owner</h2><p>Only the server's owner can back it with a Patreon pledge, and Discord names another user as its owner, so nothing was linked.</p>",
  PT18c: '<h2>Patreon link not completed</h2><p>The bot is not in this server, or cannot see it, so it cannot check who owns it. Nothing was linked; add the bot to the server first.</p>',
  PT18b: "<h2>Patreon link not completed</h2><p>Can't confirm that you own this server: the bot could not ask Discord (",
  PT26: "<h2>Patreon link not confirmed</h2><p>Can't confirm whether your Patreon account was linked: the bot did not answer in time. Start the link again in a minute; if the first one was saved, nothing changes twice.</p>",
  PT27: `<h2>Patreon linking is not set up correctly</h2><p>This bot's Discord sign-in returns to https://login.example, but Patreon links return to ${BASE_URL}, so a link cannot complete. The bot's operator sets OAUTH_CALLBACK_URL and WEBUI_BASE_URL to the same address. Nothing was linked.</p>`,
  crossSite: "<h2>Patreon link not started</h2><p>This link was opened from another site, so nothing was linked. Copy the link into your browser's address bar and open it from there.</p>",
  afterSave: "<p>The bot stopped with an error after it saved the link, before premium confirmed the save: ",
  afterCheck: '<p>The bot stopped with an error after it checked the link, before premium confirmed the result: ',
  failed: '<h2>Patreon link failed</h2>',
};
const PT22 = (holder: string) => `Your Patreon account is unlinked, and its tier was removed from ${holder.replace(':', ' ')}.`;
const PT22B = (holder: string) => `Your Patreon account is unlinked, but can't confirm its tier was removed from ${holder.replace(':', ' ')}: `;
const PT22C = 'Your Patreon account is unlinked; it gave no tier here, so nothing else changed.';
const PT23 = 'Only the member who linked this Patreon pledge can unlink it.';
const PT29 = '[PatreonProvider] A Patreon link showed memberships of campaign';

/** The start route for Discord user `u` (null: signed out), `for` me or a server. */
const startFor = (w: P7World, user: string | null, forWhat: string, req: Record<string, unknown> = {}): Promise<RouteAnswer> =>
  w.memberRoute(user, 'get', '/patreon/start', { query: { for: forWhat }, ...req });

/** The link of Discord user `u` started, approved on Patreon by Patreon user `p`, and its callback in the same session. */
async function linkVia(w: P7World, u: number, opts: { p?: number; for?: string; session?: Record<string, any> } = {}): Promise<RouteAnswer> {
  const extra = opts.session ? { session: opts.session } : {};
  const started = await startFor(w, USERS[u], opts.for ?? 'me', extra);
  if (!started.redirect?.startsWith(`${PATREON_AUTHORIZE_URL}?`)) throw new Error(`the start answered ${started.status}: ${started.html ?? started.redirect}`);
  const approved = w.fake.approve(started.redirect, PATREON_USERS[opts.p ?? u]);
  return w.memberRoute(USERS[u], 'get', '/patreon/callback', { query: approved.query, ...extra });
}

const tokenCalls = (w: P7World) => w.fake.calls.filter(c => c.route === 'token').length;
/** The faked clock's time an answer took. */
async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const from = Date.now();
  const value = await work();
  return { value, ms: Date.now() - from };
}

const QUIET: Partial<PatreonSettings> = { maskUser: 'none', staleReads: 0, multiTier: false };

describe.each(BACKENDS)('P7 part 3 on %s: claim 2, the link', (_name, backend) => {
  const w = p7World(backend);
  afterEach(async () => {
    setMaintenanceGate(null);
    await w.teardown();
    vi.restoreAllMocks();
  });

  it("L-1: U signs in, opens start?for=me and approves on Patreon: the link is { holder: user:U, buyerId: U }, the scope sent is identity, and a pledge Patreon shows is installed at once (fails on P6's tree: no start route)", async () => {
    await w.setup({ settings: QUIET });
    w.fake.pledge(P1, PTIER.A);
    const page = await linkVia(w, 0);
    expect([page.status, page.html]).toEqual([200, expect.stringContaining(PAGE.linked(VIP))]);
    expect(page.html).toContain(PAGE.active('VIP', VIP));
    expect(links(w)).toEqual({ [P1]: { holder: `user:${U1}`, buyerId: U1 } });
    expect(w.fake.approvals.map(a => a.scope)).toEqual(['identity']);
    expect(tiersAt(w, `user:${U1}`)).toEqual([`${PTIER.A}:active`]);
    const rec = getPremiumManager().getSubscriptions(`user:${U1}` as any).active as any;
    expect([rec.buyerId, rec.providerMeta.patreonUserId, rec.providerMeta.memberId]).toEqual([U1, P1, w.fake.memberOf(P1)!.id]);
    expect(w.fake.unexpected).toEqual([]);
  });

  it("L-2 (F5): U's start URL completed in V's session answers PT15, runs no op and saves nothing (fails on a build that checks only the signature)", async () => {
    await w.setup({ settings: QUIET });
    w.fake.pledge(P1, PTIER.A);
    const started = await startFor(w, U1, 'me');
    const approved = w.fake.approve(String(started.redirect), P1);
    const page = await w.memberRoute(U2, 'get', '/patreon/callback', { query: approved.query });
    expect([page.status, page.html]).toEqual([400, PAGE.PT15]);
    expect([tokenCalls(w), links(w), tiersAt(w, `user:${U1}`), tiersAt(w, `user:${U2}`)]).toEqual([0, {}, [], []]);
  });

  it('L-3: an expired state, a reused nonce, and a state whose u is not the op\'s userId are refused with nothing saved', async () => {
    await w.setup({ settings: QUIET });
    const late = await startFor(w, U1, 'me');
    const lateApproved = w.fake.approve(String(late.redirect), P1);
    await w.advance(10 * MIN + SEC);
    expect((await w.memberRoute(U1, 'get', '/patreon/callback', { query: lateApproved.query })).html).toBe(PAGE.PT15);

    const once = await startFor(w, U1, 'me');
    const first = w.fake.approve(String(once.redirect), P1);
    const again = w.fake.approve(String(once.redirect), P1);
    expect((await w.memberRoute(U1, 'get', '/patreon/callback', { query: first.query })).status).toBe(200);
    expect(links(w)).toEqual({ [P1]: { holder: `user:${U1}`, buyerId: U1 } });
    const before = w.storedText();
    const calls = tokenCalls(w);
    expect((await w.memberRoute(U1, 'get', '/patreon/callback', { query: again.query })).html).toBe(PAGE.PT15);

    const other = await startFor(w, U2, 'me');
    const otherApproved = w.fake.approve(String(other.redirect), P2);
    const direct = await w.sharedOp('payment.oauthCallback', { providerId: 'patreon', query: otherApproved.query, userId: U3 });
    expect(direct.ok).toBe(false);
    await w.advance(10 * MIN + SEC);
    const stale = await w.sharedOp('payment.oauthCallback', { providerId: 'patreon', query: otherApproved.query, userId: U2 });
    expect(stale.ok).toBe(false);
    expect([w.storedText() === before, tokenCalls(w) - calls]).toEqual([true, 0]);
  });

  it('L-4 and L-5: a Patreon account linked to U and then linked by V answers PT16; U linked to P linking Q answers PT17; nothing changes', async () => {
    await w.setup({ settings: QUIET });
    expect((await linkVia(w, 0)).status).toBe(200);
    const before = w.storedText();
    const taken = await linkVia(w, 1, { p: 0 });
    expect([taken.status, taken.html]).toEqual([409, PAGE.PT16]);
    const second = await linkVia(w, 0, { p: 1 });
    expect([second.status, second.html]).toEqual([409, PAGE.PT17]);
    expect(w.storedText()).toBe(before);
    expect(links(w)).toEqual({ [P1]: { holder: `user:${U1}`, buyerId: U1 } });
  });

  it("L-6: a server pick by its owner links guild:G; by another user PT18a; Unknown Guild and Missing Access PT18c; a failing fetch, no answer within the op's time, or no client PT18b; nothing saved on a refusal", async () => {
    await w.setup({ settings: QUIET });
    const G1 = GUILDS[0];
    const refused: Array<[number, string]> = [];
    const tryLink = async (u: number, p: number): Promise<RouteAnswer> => {
      const page = await linkVia(w, u, { p, for: G1 });
      refused.push([page.status, String(page.html).slice(0, PAGE.PT18b.length)]);
      return page;
    };
    await tryLink(1, 1);
    for (const answer of ['unknown', 'missing', 'fail'] as const) {
      w.guildClient.answers.set(G1, answer);
      await tryLink(0, 0);
    }
    w.guildClient.answers.set(G1, 'hang');
    w.setPumpStep(100);
    const hung = await timed(() => tryLink(0, 0));
    w.setPumpStep(1);
    (w.provider as any).setClient(null);
    w.guildClient.answers.set(G1, { ownerId: U1 });
    await tryLink(0, 0);
    expect(refused).toEqual([
      [403, PAGE.PT18a.slice(0, PAGE.PT18b.length)],
      [403, PAGE.PT18c.slice(0, PAGE.PT18b.length)],
      [403, PAGE.PT18c.slice(0, PAGE.PT18b.length)],
      [503, PAGE.PT18b], [503, PAGE.PT18b], [503, PAGE.PT18b],
    ]);
    expect(hung.ms).toBeLessThanOrEqual(46 * SEC);
    expect(links(w)).toEqual({});
    (w.provider as any).setClient(w.guildClient);
    const owner = await linkVia(w, 0, { for: G1 });
    expect([owner.status, owner.html]).toEqual([200, expect.stringContaining(PAGE.linked(server(0)))]);
    expect(owner.html).toContain(`<a href="/guild/${G1}/subscription">`);
    expect(links(w)).toEqual({ [P1]: { holder: `guild:${G1}`, buyerId: U1 } });
    expect(w.guildClient.fetches.every(f => f.force)).toBe(true);
  });

  it('L-7: a relink with the same holder saves no link and reconciles (a pledge made after the first link installs at once)', async () => {
    await w.setup({ settings: QUIET, webhook: false });
    expect((await linkVia(w, 0)).html).toContain(PAGE.noPledge);
    const linkText = JSON.stringify(w.stored().providerAccountLinks);
    w.fake.pledge(P1, PTIER.A);
    const pm = getPremiumManager() as any;
    const saves = [vi.spyOn(pm, 'linkAccount'), vi.spyOn(pm, 'setAccountHolder')];
    const page = await linkVia(w, 0);
    expect(saves.map(s => s.mock.calls.length)).toEqual([0, 0]);
    for (const s of saves) s.mockRestore();
    expect(page.html).toContain(PAGE.active('VIP', VIP));
    expect(JSON.stringify(w.stored().providerAccountLinks)).toBe(linkText);
    expect(tiersAt(w, `user:${U1}`)).toEqual([`${PTIER.A}:active`]);
  });

  it('L-8 (D9, D19): signed out, the start redirects to /auth/discord; on another host it redirects to WEBUI_BASE_URL\'s before any nonce is stored; with OAUTH_CALLBACK_URL on another origin it shows PT27 and stores nothing', async () => {
    await w.setup({ settings: QUIET });
    const out = await startFor(w, null, 'me');
    expect([out.status, out.redirect]).toEqual([302, '/auth/discord']);
    const elsewhere = await startFor(w, U1, 'me', {
      headers: { host: 'other.example' }, hostname: 'other.example', originalUrl: '/guild/api/subscriptions/patreon/start?for=me',
      get: (name: string) => (name.toLowerCase() === 'host' ? 'other.example' : undefined),
    });
    expect(elsewhere.redirect).toBe(`${BASE_URL}/guild/api/subscriptions/patreon/start?for=me`);
    expect(w.sessions.get(U1)?.patreonLink).toBeUndefined();
    w.setCredentials({ OAUTH_CALLBACK_URL: 'https://login.example/auth/discord/callback' });
    const wrong = await startFor(w, U1, 'me');
    expect([wrong.status, wrong.html]).toEqual([503, PAGE.PT27]);
    expect(w.sessions.get(U1)?.patreonLink).toBeUndefined();
  });

  it("L-8b: a start whose Sec-Fetch-Site reads cross-site is refused with the open-it-from-the-address-bar text, stores nothing and sends nobody to Patreon, signed in or out (fails on a build without the check)", async () => {
    await w.setup({ settings: QUIET });
    for (const user of [U1, null]) {
      const refused = await startFor(w, user, 'me', { headers: { host: 'bot.example', 'sec-fetch-site': 'cross-site' } });
      expect([user, refused.status, refused.html, refused.redirect]).toEqual([user, 403, PAGE.crossSite, null]);
    }
    expect(w.sessions.get(U1)?.patreonLink).toBeUndefined();
  });

  it.each([['none'], ['same-origin'], ['same-site'], [undefined]] as const)("L-8c: a start whose Sec-Fetch-Site is %s goes to Patreon with the nonce stored (fails on a build that refuses all but same-origin)", async site => {
    await w.setup({ settings: QUIET });
    const headers: Record<string, string> = { host: 'bot.example', ...(site === undefined ? {} : { 'sec-fetch-site': site }) };
    const started = await startFor(w, U1, 'me', { headers });
    expect(started.redirect?.startsWith(`${PATREON_AUTHORIZE_URL}?`)).toBe(true);
    expect(w.sessions.get(U1)?.patreonLink?.holder).toBe(`user:${U1}`);
  });

  it("L-9 (D1, D20): with every Patreon call slowed to 20 s the answer comes within 45 s with the link saved and PT21's can't-confirm sentence; a web UI with no answer shows PT26; a gate closing after the exchange refuses with nothing saved (fails on a build with a timeout per call only)", async () => {
    await w.setup({ settings: QUIET });
    w.fake.pledge(P1, PTIER.A);
    w.setPumpStep(100);
    for (const route of ['token', 'identity', 'member'] as const) w.fake.slow(route, 20 * SEC);
    const slow = await timed(() => linkVia(w, 0));
    expect(slow.ms).toBeLessThanOrEqual(45 * SEC + SEC);
    expect([slow.value.status, slow.value.html]).toEqual([200, expect.stringContaining(PAGE.cantConfirm)]);
    expect(slow.value.html).toContain(PAGE.soon);
    expect(links(w)).toEqual({ [P1]: { holder: `user:${U1}`, buyerId: U1 } });
    w.fake.clearFaults();

    w.fake.pledge(P2, PTIER.A);
    const real = w.botManager.runSharedOp;
    w.botManager.runSharedOp = async () => ({ ok: false, code: 'no-answer', noAnswer: 'timeout', error: 'The bot did not answer within 60 s' });
    const silent = await linkVia(w, 1);
    w.botManager.runSharedOp = real;
    expect([silent.status, silent.html]).toEqual([504, PAGE.PT26]);

    const before = w.storedText();
    const held = w.fake.hold('identity');
    const started = await startFor(w, U2, 'me');
    const approved = w.fake.approve(String(started.redirect), P2);
    const answer = w.memberRoute(U2, 'get', '/patreon/callback', { query: approved.query });
    await held.reached;
    setMaintenanceGate({ cause: 'hook', message: 'down' });
    held.release();
    const closed = await answer;
    setMaintenanceGate(null);
    expect(closed.html).toContain(PAGE.failed);
    expect(closed.status).toBe(503);
    expect(w.storedText()).toBe(before);

    const linked = await linkVia(w, 1);
    expect(linked.status).toBe(200);
    // The exchange and /identity take 20 s, so the callback waits for the member's chain from 20 s into its 45 s; a
    // round's member read entering the chain 18 s in holds it for 30 s, past the budget.
    const relink = await startFor(w, U2, 'me');
    const relinkApproved = w.fake.approve(String(relink.redirect), P2);
    w.fake.slow('token', 10 * SEC, 1);
    w.fake.slow('identity', 10 * SEC, 1);
    const from = Date.now();
    const busy = w.memberRoute(U2, 'get', '/patreon/callback', { query: relinkApproved.query }).then(page => ({ page, ms: Date.now() - from }));
    await w.pump(new Promise<void>(resolve => { setTimeout(resolve, 18 * SEC); }));
    w.fake.fail('members', { status: 500 }, 1);
    w.fake.slow('member', 40 * SEC, 1);
    const round = w.round();
    const answered = await busy;
    await round;
    expect(answered.ms).toBeLessThanOrEqual(45 * SEC + SEC);
    expect([answered.page.status, answered.page.html]).toEqual([200, expect.stringContaining(PAGE.cantConfirm)]);
  }, 240_000);

  it("L-9b: a link whose tier save premium does not confirm answers that the bot can't confirm the link, not 'Patreon link failed'; a member read that throws after the link save answers PT21's can't-confirm sentence with the link kept (fails on a build whose page says the link failed)", async () => {
    await w.setup({ settings: QUIET, webhook: false });
    w.fake.pledge(P1, PTIER.A);
    const pm = getPremiumManager() as any;
    const realLink = pm.linkAccount;
    const stopAfterLink = vi.spyOn(pm, 'linkAccount').mockImplementation((...args: unknown[]) => {
      const saved = realLink.apply(pm, args);
      pm.stopped = 'stopping';
      return saved;
    });
    let page: RouteAnswer;
    try {
      page = await linkVia(w, 0);
    } finally {
      pm.stopped = null;
      stopAfterLink.mockRestore();
    }
    expect([page.status, String(page.html).startsWith(PAGE.notConfirmed), String(page.html).includes(PAGE.failed)]).toEqual([503, true, false]);
    expect(links(w)).toEqual({ [P1]: { holder: `user:${U1}`, buyerId: U1 } });

    w.fake.pledge(P2, PTIER.A);
    const read = vi.spyOn(w.provider as any, 'reconcileMember').mockRejectedValueOnce(new Error('[Test] the read threw'));
    const threw = await linkVia(w, 1);
    read.mockRestore();
    expect([threw.status, threw.html]).toEqual([200, expect.stringContaining(PAGE.linked(VIP))]);
    expect(threw.html).toContain(PAGE.cantConfirm);
    expect(threw.html).toContain(PAGE.soon);
    expect(links(w)[P2]).toEqual({ holder: `user:${U2}`, buyerId: U2 });
  });

  it.each([['premium.settled'], ["the op's settle after it returned"]] as const)("L-9c: a throw from %s after the link save answers the not-confirmed page with the error, never 'Patreon link failed', and the link is kept (fails on a build that answers a throw after the save as a failed link)", async where => {
    await w.setup({ settings: QUIET, webhook: false });
    w.fake.pledge(P1, PTIER.A);
    const boom = new Error('[Test] the step threw');
    const spy = where === 'premium.settled' ? vi.spyOn(getPremiumManager() as any, 'settled').mockRejectedValueOnce(boom) : null;
    if (!spy) setOpSettler(async () => { throw boom; });
    let page: RouteAnswer;
    try {
      page = await linkVia(w, 0);
    } finally {
      spy?.mockRestore();
      setOpSettler(settlePremiumInstalls);
    }
    expect([page.status, String(page.html).startsWith(PAGE.notConfirmed), String(page.html).includes(PAGE.failed)]).toEqual([503, true, false]);
    expect(page.html).toContain(`${PAGE.afterSave}[Test] the step threw.`);
    expect(links(w)).toEqual({ [P1]: { holder: `user:${U1}`, buyerId: U1 } });
  });

  it("L-9d: a relink to the same holder runs no save, so a throw from premium.settled answers the not-confirmed page saying the bot checked the link, never that it saved it (fails on a build that marks the op past its save without a save)", async () => {
    await w.setup({ settings: QUIET, webhook: false });
    w.fake.pledge(P1, PTIER.A);
    expect((await linkVia(w, 0)).html).toContain(PAGE.active('VIP', VIP));
    const spy = vi.spyOn(getPremiumManager() as any, 'settled').mockRejectedValueOnce(new Error('[Test] the step threw'));
    let page: RouteAnswer;
    try {
      page = await linkVia(w, 0);
    } finally {
      spy.mockRestore();
    }
    expect([page.status, String(page.html).startsWith(PAGE.notConfirmed), String(page.html).includes(PAGE.failed)]).toEqual([503, true, false]);
    expect(page.html).toContain(`${PAGE.afterCheck}[Test] the step threw.`);
    expect(page.html).not.toContain(PAGE.afterSave);
    expect(links(w)).toEqual({ [P1]: { holder: `user:${U1}`, buyerId: U1 } });
  });

  it('L-10 (D10): two callbacks of U, for P and Q, held so both pass /identity together: one link is saved, the other answers PT17 (fails on a build with an await between the check and the save)', async () => {
    await w.setup({ settings: QUIET });
    const second: Record<string, any> = { passport: { user: { id: U1 } }, save: (cb: (e?: unknown) => void) => cb() };
    const a = await startFor(w, U1, 'me');
    const b = await startFor(w, U1, 'me', { session: second });
    const qa = w.fake.approve(String(a.redirect), P1);
    const qb = w.fake.approve(String(b.redirect), P2);
    const holdA = w.fake.holdAnswer('identity');
    const holdB = w.fake.holdAnswer('identity');
    const first = w.memberRoute(U1, 'get', '/patreon/callback', { query: qa.query });
    const other = w.memberRoute(U1, 'get', '/patreon/callback', { query: qb.query, session: second });
    await Promise.all([holdA.reached, holdB.reached]);
    holdA.release();
    holdB.release();
    const pages = await Promise.all([first, other]);
    expect(pages.map(p => p.status).sort()).toEqual([200, 409]);
    expect(pages.find(p => p.status === 409)!.html).toBe(PAGE.PT17);
    expect(Object.keys(links(w))).toHaveLength(1);
  });

  it('L-11 (D3): a masked member links and is installed at once with meta patreonUserId U; a masked member whose pledge came after its link is installed by a relink', async () => {
    await w.setup({ settings: { ...QUIET, maskUser: 'all' } });
    w.fake.pledge(P1, PTIER.A);
    expect((await linkVia(w, 0)).html).toContain(PAGE.active('VIP', VIP));
    const rec = getPremiumManager().getSubscriptions(`user:${U1}` as any).active as any;
    expect(rec.providerMeta.patreonUserId).toBe(P1);
    expect((await linkVia(w, 1)).html).toContain(PAGE.noPledge);
    w.fake.pledge(P2, PTIER.A);
    await w.round();
    expect(tiersAt(w, `user:${U2}`)).toEqual([]);
    expect((await linkVia(w, 1)).html).toContain(PAGE.active('VIP', VIP));
    expect(tiersAt(w, `user:${U2}`)).toEqual([`${PTIER.A}:active`]);
    expect(getPremiumManager().getSubscriptions(`user:${U2}` as any).active?.providerMeta?.patreonUserId).toBe(P2);
  });

  it.each([['the VIP pick', 'me'], ['the server pick', GUILDS[0]]] as const)("L-12 (D6, D7) on %s: PT21's sentences for no pledge, a trial, active, queued, paid but unwired (PD3), paid at a held priority (PD14) and can't confirm; the page answers 200 with no payment page", async (_name, forWhat) => {
    allowDropLines('L3');
    const guild = forWhat !== 'me';
    const where = guild ? server(0) : VIP;
    const holder = guild ? `guild:${GUILDS[0]}` : `user:${U1}`;
    const wired = guild ? PTIER.S : PTIER.A;
    const tierName = guild ? 'Gold' : 'VIP';
    const unwired = guild ? PTIER.A2 : PTIER.S;
    const pages: string[] = [];
    let up = false;
    const run = async (prep: () => Promise<void> | void) => {
      if (up) await w.teardown();
      await w.setup({ settings: QUIET, webhook: false });
      up = true;
      allowDropLines('L3');
      await prep();
      const page = await linkVia(w, 0, { for: forWhat });
      expect([page.status, page.redirect]).toEqual([200, null]);
      expect(page.html).toContain(PAGE.linked(where));
      pages.push(String(page.html).slice(PAGE.linked(where).length));
    };
    await run(() => undefined);
    await run(() => { w.fake.startTrial(P1, wired); });
    await run(() => { w.fake.pledge(P1, wired); });
    await run(async () => {
      expect((await w.op('grantManual', holder, guild ? 'platinum' : 'star', 1)).ok).toBe(true);
      w.fake.pledge(P1, wired);
    });
    await run(() => { w.fake.pledge(P1, unwired); });
    await run(async () => {
      expect((await w.op('grantManual', holder, tierName.toLowerCase(), 1)).ok).toBe(true);
      w.fake.pledge(P1, wired);
    });
    await run(() => {
      w.fake.pledge(P1, wired);
      w.fake.fail('member', { status: 500 }, 1);
    });
    const guildLink = guild ? `<p><a href="/guild/${GUILDS[0]}/subscription">Back to the server page</a></p>` : '';
    expect(pages.slice(0, 6)).toEqual([
      PAGE.noPledge + guildLink,
      PAGE.trial + guildLink,
      PAGE.active(tierName, where) + guildLink,
      PAGE.queued(tierName, where) + guildLink,
      PAGE.notGiven(unwired, where) + guildLink,
      PAGE.notGiven(wired, where) + guildLink,
    ]);
    expect(pages[6].startsWith(PAGE.cantConfirm)).toBe(true);
    expect(pages[6]).toContain(PAGE.soon);
  });

  it("L-13 (E6), no webhook: a pledge made again within W of its cancel, then a relink: the result carries deferred and the page PT21's lag sentence, not the PD3 one; the callback's re-read W later installs (fails on a build that arms no re-read for a callback read)", async () => {
    await w.setup({ settings: QUIET, webhook: false });
    const m = w.fake.pledge(P1, PTIER.A);
    expect((await linkVia(w, 0)).html).toContain(PAGE.active('VIP', VIP));
    await w.advance(W_MS + SEC);
    w.fake.cancel(m);
    await w.round();
    expect(tiersAt(w, `user:${U1}`)).toEqual([]);
    await w.advance(MIN);
    w.fake.pledge(P1, PTIER.A);
    const reply: any[] = [];
    const real = w.botManager.runSharedOp;
    w.botManager.runSharedOp = async (name: string, args: unknown) => {
      const r = await real(name, args);
      reply.push(r);
      return r;
    };
    const page = await linkVia(w, 0);
    w.botManager.runSharedOp = real;
    expect(reply.at(-1)?.result?.deferred).toBe(true);
    expect(page.html).toContain(PAGE.lag);
    expect(page.html).not.toContain('but the bot gave no tier');
    expect(tiersAt(w, `user:${U1}`)).toEqual([]);
    await w.advance(W_MS + SEC);
    expect(tiersAt(w, `user:${U1}`)).toEqual([`${PTIER.A}:active`]);
  });

  it("L-14 (THE RE-READ RULE): a callback whose member read fails is read again W later and installs, while no round can install it (fails on a build whose callback arms no re-read)", async () => {
    await w.setup({ settings: QUIET, webhook: false });
    w.fake.pledge(P1, PTIER.A);
    w.fake.fail('members', { status: 500 }, 20);
    w.fake.fail('member', { status: 500 }, 1);
    const page = await linkVia(w, 0);
    expect([page.status, page.html]).toEqual([200, expect.stringContaining(PAGE.cantConfirm)]);
    expect(page.html).toContain(PAGE.soon);
    await w.advance(W_MS - 30 * SEC);
    expect(tiersAt(w, `user:${U1}`)).toEqual([]);
    await w.advance(31 * SEC);
    expect(tiersAt(w, `user:${U1}`)).toEqual([`${PTIER.A}:active`]);
  });

  it.each([['Pending'], ['Declined'], [null]] as const)("L-12b (E10), latest charge %s: a paid tier Patreon lists that the bot may not install yet gets PT21's no-paid-charge sentence, not the log one, and no tier (fails on a build that sends the member to the log)", async status => {
    await w.setup({ settings: QUIET, webhook: false });
    const m = w.fake.pledge(P1, PTIER.A);
    w.fake.setMember(m, { lastChargeStatus: status });
    const page = await linkVia(w, 0);
    expect([page.status, page.html]).toEqual([200, PAGE.linked(VIP) + PAGE.uncharged(PTIER.A, VIP)]);
    expect(tiersAt(w, `user:${U1}`)).toEqual([]);
  });

  it.each([['no offering on the VIP sells it (PD3)', 'unwired'], ['the VIP holds a plan at its priority (PD14)', 'held'], ['two offerings on the VIP sell it (PD4)', 'several']] as const)("L-12c (E10): a Pending charge on a tier the VIP cannot take, %s, gets PT21's wiring sentence, never the no-paid-charge one (fails on a build that lists every tier without a paid charge as waiting for one)", async (_name, why) => {
    await w.setup({ settings: QUIET, webhook: false });
    if (why === 'held') expect((await w.op('grantManual', `user:${U1}`, 'vip', 1)).ok).toBe(true);
    if (why === 'several') {
      allowDropLines('L3');
      const star = tierDefOf('star', true, false);
      star.offerings.push({ id: 'o-ba', label: 'Star from A', providerLinks: [providerLink('patreon', [PTIER.A])] });
      expect((await w.op('setTier', 'star', star)).ok).toBe(true);
    }
    const ptier = why === 'unwired' ? PTIER.S : PTIER.A;
    const m = w.fake.pledge(P1, ptier);
    w.fake.setMember(m, { lastChargeStatus: 'Pending' });
    const page = await linkVia(w, 0);
    expect([page.status, page.html]).toEqual([200, PAGE.linked(VIP) + PAGE.notGiven(ptier, VIP)]);
    expect(page.html).not.toContain('no paid charge');
  });

  it("F4 (E13), /identity's half: no data.id saves nothing; memberships or a member's campaign null or absent saves the link, reads no member and says can't confirm within the hour; only another campaign's member says can't confirm and logs PT29 once", async () => {
    const cases: Array<[string, Partial<PatreonSettings>]> = [
      ['memberships null', { nullField: new Set(['memberships'] as any) }],
      ['memberships absent', { absentField: new Set(['memberships'] as any) }],
      ['campaign null', { nullField: new Set(['campaign'] as any) }],
      ['campaign absent', { absentField: new Set(['campaign'] as any) }],
    ];
    await w.setup({ settings: { ...QUIET, nullField: new Set(['user.id'] as any) } });
    w.fake.pledge(P1, PTIER.A);
    const noId = await linkVia(w, 0);
    expect([noId.status, noId.html]).toEqual([400, expect.stringContaining(PAGE.failed)]);
    expect(links(w)).toEqual({});
    await w.teardown();
    for (const [name, settings] of cases) {
      await w.setup({ settings: { ...QUIET, ...settings } });
      w.fake.pledge(P1, PTIER.A);
      const page = await linkVia(w, 0);
      expect([name, page.status, links(w)[P1]?.holder, memberReads(w, w.fake.memberOf(P1)!).length]).toEqual([name, 200, `user:${U1}`, 0]);
      expect(page.html).toContain(PAGE.cantConfirm);
      expect(page.html).toContain(PAGE.hour);
      await w.teardown();
    }
    await w.setup({ settings: { ...QUIET, clientOfOtherCreator: true } });
    w.fake.otherMembership(P1);
    w.fake.otherMembership(P2);
    const first = await linkVia(w, 0);
    const second = await linkVia(w, 1);
    for (const page of [first, second]) {
      expect(page.html).toContain(PAGE.cantConfirm);
      expect(page.html).toContain(PAGE.hour);
    }
    // The rig captures no console line (part 2's note), so the log is checked on the JSON files.
    if (backend === 'json') expect(w.logged(PT29), w.logs.join('\n')).toHaveLength(1);
    expect(Object.keys(links(w)).sort()).toEqual([P1, P2].sort());
  });

  it.each([[true], [null]])("L10's page (E4, E10; is_free_trial %s): a member who has paid, holding a record, with a Declined latest charge, picks the server: the server gets the tier at once and PT21 shows no trial (fails on a build reading a trial from last_charge_status)", async isFreeTrial => {
    await w.setup({ settings: QUIET, webhook: false });
    const m = w.fake.pledge(P1, PTIER.A);
    expect((await linkVia(w, 0)).html).toContain(PAGE.active('VIP', VIP));
    w.fake.decline(m);
    w.fake.setMember(m, { isFreeTrial: isFreeTrial });
    await w.advance(W_MS + SEC);
    const page = await linkVia(w, 0, { for: GUILDS[0] });
    expect(page.html).toContain(PAGE.active('Gold', server(0)));
    expect(page.html).not.toContain(PAGE.trial);
    expect([tiersAt(w, `user:${U1}`), tiersAt(w, `guild:${GUILDS[0]}`)]).toEqual([[], [`${PTIER.A}:active`]]);
  });
});

describe.each(BACKENDS)('P7 part 3 on %s: claim 8, pick change and unlink; claim 10, C4', (_name, backend) => {
  const w = p7World(backend);
  const H = `user:${U1}`;
  const G1 = `guild:${GUILDS[0]}`;
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  const unlinkVip = (user: string) => w.memberRoute(user, 'delete', '/patreon/link');
  const unlinkServer = (user: string, guild: string) => w.memberRoute(user, 'delete', '/:guildId/provider-links/:providerId', { params: { guildId: guild, providerId: 'patreon' } });

  it('U1: a pick change from user:U to guild:G ends the user record and installs the server tier; stopped after the link save, the next round ends the old (PT24) and installs the new', async () => {
    await w.setup({ settings: QUIET, webhook: false });
    w.fake.pledge(P1, PTIER.A);
    await linkVia(w, 0);
    await w.advance(W_MS + SEC);
    const page = await linkVia(w, 0, { for: GUILDS[0] });
    expect(page.html).toContain(PAGE.active('Gold', server(0)));
    expect([links(w)[P1], tiersAt(w, H), tiersAt(w, G1)]).toEqual([{ holder: G1, buyerId: U1 }, [], [`${PTIER.A}:active`]]);

    await w.advance(W_MS + SEC);
    w.fake.fail('member', { status: 500 }, 1);
    const stopped = await linkVia(w, 0);
    expect(stopped.html).toContain(PAGE.cantConfirm);
    expect([links(w)[P1], tiersAt(w, H), tiersAt(w, G1)]).toEqual([{ holder: H, buyerId: U1 }, [], [`${PTIER.A}:active`]]);
    const ended = w.logged(LOG.PT24_TAIL).length;
    await w.round();
    expect([tiersAt(w, H), tiersAt(w, G1)]).toEqual([[`${PTIER.A}:active`], []]);
    if (backend === 'json') expect(w.logged(LOG.PT24_TAIL).length - ended, w.logs.join('\n')).toBe(1);
  });

  it("U2 and U6: the VIP unlink route removes the link and the record (PT22); with the record's save refused PT22b, and the next round ends it; with no record PT22c", async () => {
    await w.setup({ settings: QUIET, webhook: false });
    w.fake.pledge(P1, PTIER.A);
    await linkVia(w, 0);
    const done = await unlinkVip(U1);
    expect([done.status, done.body]).toEqual([200, { success: true, message: PT22(H) }]);
    expect([links(w), tiersAt(w, H)]).toEqual([{}, []]);

    await w.advance(W_MS + SEC);
    await linkVia(w, 0);
    expect(tiersAt(w, H)).toEqual([`${PTIER.A}:active`]);
    const pm = getPremiumManager() as any;
    const real = pm.cancelActiveImmediately;
    vi.spyOn(pm, 'cancelActiveImmediately').mockImplementation(async (...args: unknown[]) => {
      pm.stopped = 'stopping';
      try {
        return await real.apply(pm, args);
      } finally {
        pm.stopped = null;
      }
    });
    const refused = await unlinkVip(U1);
    vi.restoreAllMocks();
    expect(refused.status).toBe(200);
    expect(String(refused.body?.message)).toContain(PT22B(H));
    expect(String(refused.body?.message)).toMatch(/The bot removes it within an hour\.$/);
    expect(links(w)).toEqual({});
    await w.round();
    expect(tiersAt(w, H)).toEqual([]);

    await linkVia(w, 1);
    const none = await unlinkVip(U2);
    expect([none.status, none.body]).toEqual([200, { success: true, message: PT22C }]);
    const nothing = await unlinkVip(U3);
    expect(nothing.status).toBe(404);
  });

  it("U6b: a record a delivery installs just before the unlink, not yet in what the web UI read, answers PT22 and ends (fails on a build that picks PT22 or PT22c from the web UI's read before the op)", async () => {
    await w.setup({ settings: QUIET });
    await linkVia(w, 0);
    expect(tiersAt(w, H)).toEqual([]);
    const real = w.botManager.runSharedOp;
    let installed: string[] = [];
    w.botManager.runSharedOp = async (name: string, args: unknown) => {
      if (name === 'premium.unlinkProviderAccount') {
        w.fake.pledge(P1, PTIER.A);
        await w.deliverAll();
        installed = tiersAt(w, H);
      }
      return real(name, args);
    };
    let answer: RouteAnswer;
    try {
      answer = await unlinkVip(U1);
    } finally {
      w.botManager.runSharedOp = real;
    }
    expect(installed).toEqual([`${PTIER.A}:active`]);
    expect([answer.status, answer.body]).toEqual([200, { success: true, message: PT22(H) }]);
    expect([links(w), tiersAt(w, H)]).toEqual([{}, []]);
  });

  it("U3, the route's half: the server route's unlink by another admin answers 403 PT23 and changes nothing; by the payer it unlinks (fails on P6's tree)", async () => {
    await w.setup({ settings: QUIET, webhook: false });
    w.fake.pledge(P1, PTIER.S);
    await linkVia(w, 0, { for: GUILDS[0] });
    expect(tiersAt(w, G1)).toEqual([`${PTIER.S}:active`]);
    const before = w.storedText();
    const other = await unlinkServer(U2, GUILDS[0]);
    expect([other.status, other.body]).toEqual([403, { success: false, error: PT23 }]);
    expect(w.storedText()).toBe(before);
    const payer = await unlinkServer(U1, GUILDS[0]);
    expect([payer.status, payer.body]).toEqual([200, { success: true, message: PT22(G1) }]);
    expect([links(w), tiersAt(w, G1)]).toEqual([{}, []]);
  });

  it("U4 (E14): an unlink while a round's member read is in flight leaves no record at the old holder; a pick change made after a round listed the member, while its install waits in the member's chain, installs at the new holder only", async () => {
    await w.setup({ settings: QUIET, webhook: false });
    const m = w.fake.pledge(P1, PTIER.A);
    await linkVia(w, 0);
    await w.advance(W_MS + SEC);
    w.fake.changeTier(m, PTIER.B);
    const read = w.fake.holdAnswer('member');
    const round = w.round();
    await read.reached;
    await unlinkVip(U1);
    read.release();
    await round;
    expect([links(w), tiersAt(w, H)]).toEqual([{}, []]);

    await w.advance(W_MS + SEC);
    w.fake.changeTier(m, PTIER.A);
    const started = await startFor(w, U1, 'me');
    const approved = w.fake.approve(String(started.redirect), P1);
    const held = w.fake.holdAnswer('member');
    const callback = w.memberRoute(U1, 'get', '/patreon/callback', { query: approved.query });
    await held.reached;
    const from = w.emitted.length;
    const listed = w.round();
    await w.pump(new Promise<void>(resolve => { setTimeout(resolve, 2 * SEC); }));
    expect((getPremiumManager() as any).setAccountHolder('patreon', P1, U1, G1)).toBe(true);
    held.release();
    await Promise.all([callback, listed]);
    await w.settle();
    expect(eventsSince(w, from).filter(e => e.startsWith(`created ${H}`))).toEqual([]);
    expect([tiersAt(w, H), tiersAt(w, G1)]).toEqual([[], [`${PTIER.A}:active`]]);
  });

  it("C4: the server route's answer carries followed; a lookup then a save leaves premium-tiers.json as the same save alone", async () => {
    await w.setup({ settings: QUIET, webhook: false });
    w.fake.pledge(P1, PTIER.S);
    await linkVia(w, 0, { for: GUILDS[0] });
    const before = w.stored();
    const lookup = await w.memberRoute(U1, 'get', '/:guildId', { params: { guildId: GUILDS[0] } });
    expect(lookup.body.subscriptions.active).toMatchObject({ providerId: 'patreon', followed: true });
    expect((await w.op('setNotificationsChannelId', G1, '123456789012345678')).ok).toBe(true);
    const after = w.stored();
    expect(w.storedText()).not.toContain('"followed"');
    delete after.subscriptions[G1].notificationsChannelId;
    expect(after.subscriptions).toEqual(before.subscriptions);
  });
});
