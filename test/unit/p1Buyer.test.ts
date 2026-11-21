import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 claim 6 (part 4a): every paid subscription has its buyer. A purchase names the Discord user who pays (X4), and a
// user's subscription is paid by that user (X5); a created event without a buyer installs nothing (L3); a stored paid
// subscription has `buyerId` and its install line `metadata.buyerId`; a manual grant has none; a subscription the
// seller lists without a buyer cannot be adopted (X10), and the server's page does not adopt it by itself.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { notices } from '../helpers/p1Mocks';
import { allowDropLines } from '../helpers/p1Guard';
import { gh, uh } from '../helpers/p1Holder';
import { loadGuildPanel, panelFlush, panelText } from '../helpers/p1PanelRig';
import { AUDIT, BUYER, p1World, purchaseOptions, SELLER_ID, SELLER_VARIANT, sellerListCall, SERVERS, USERS } from '../helpers/p1World';

const w = p1World();
const X4 = 'A paid subscription needs the Discord id of the user who pays; none was given.';
const X5 = "A user's subscription is paid by that user; the buyer given is someone else.";
const X10 = "P1 Seller's record does not name the Discord user who paid; cancel it at P1 Seller instead";
const SERVER = gh(SERVERS[0]);
const USER = uh(USERS[0]);
const state = () => ({ premium: w.storedText(), audit: w.auditText(), calls: JSON.stringify(w.seller.calls), notices: JSON.stringify(notices.sent) });
const stored = () => ({ premium: w.storedText(), audit: w.auditText(), notices: JSON.stringify(notices.sent) });

let warned: string[] = [];
beforeEach(async () => {
  await w.setup();
  await w.addSoldUserTiers();
  warned = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(' ')); });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await w.teardown();
});

describe('P1 claim 6: a purchase names who pays', () => {
  it.each([
    ['a server purchase without buyerId', SERVER, 'low', { providerId: SELLER_ID, variantId: SELLER_VARIANT }, X4],
    ["a server purchase whose buyerId is 'abc'", SERVER, 'low', { providerId: SELLER_ID, variantId: SELLER_VARIANT, buyerId: 'abc' }, X4],
    ['a server purchase whose buyerId is a number', SERVER, 'low', { providerId: SELLER_ID, variantId: SELLER_VARIANT, buyerId: 80000000000000001 }, X4],
    ['a user purchase without buyerId', uh('5'), 'vlow', { providerId: SELLER_ID, variantId: SELLER_VARIANT }, X4],
    ["a purchase for user:5 whose buyer is '6'", uh('5'), 'vlow', { providerId: SELLER_ID, variantId: SELLER_VARIANT, buyerId: '6' }, X5],
  ])('%s is refused before any seller call and changes nothing', async (_what, holder, tierId, options, text) => {
    expect(await w.purchase(SERVER, 'mid')).toMatchObject({ ok: true });
    const before = state();

    const reply = await w.op('initiatePaidSubscription', holder, tierId, `o-${tierId}`, options);

    expect(reply.ok).toBe(false);
    expect(reply.error).toContain(text);
    expect(state()).toEqual(before);
  });

  it('a purchase for user:5 paid by user 5 is installed, with the seller told the holder and the buyer', async () => {
    const reply = await w.op('initiatePaidSubscription', uh('5'), 'vlow', 'o-vlow', purchaseOptions(uh('5')));

    expect(reply).toMatchObject({ ok: true });
    expect(w.recordOf(uh('5')).active).toMatchObject({ tierId: 'vlow', source: 'paid', buyerId: '5' });
    expect(w.seller.calls.map(c => c.method)).toEqual([sellerListCall(uh('5')).method, 'initiatePurchase']);
    expect(w.seller.calls[0]).toEqual(sellerListCall(uh('5')));
    expect(w.seller.calls[1].args[0]).toMatchObject({ holder: 'user:5', buyerId: '5' });
  });
});

describe('P1 claim 6: a created event without its buyer installs nothing', () => {
  it.each([
    ['a created event for a server that names no buyer', SERVER, 'low', null, `guild ${SERVERS[0]}`, 'it names no buyer'],
    ['a created event for a user that names no buyer', USER, 'vlow', null, `user ${USERS[0]}`, 'it names no buyer'],
    ['a created event for a user whose buyer is another user', USER, 'vlow', BUYER, `user ${USERS[0]}`, 'its buyer is not the user it is for'],
  ])('%s is not installed and logs L3', async (_what, holder, tierId, buyerId, words, why) => {
    expect(await w.purchase(SERVER, 'mid')).toMatchObject({ ok: true });
    const before = stored();
    allowDropLines('L3');

    await w.created(holder, tierId, buyerId);

    expect(stored()).toEqual(before);
    const lines = warned.filter(l => l.includes('was not installed'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^\\[PremiumManager\\] subscription\\.created from ${SELLER_ID} \\(subscription p1s_\\d+, ${words}\\) was not installed: ${why}$`));
  });

  it("a created event whose buyer is the text 'abc' is not installed either", async () => {
    const before = stored();
    allowDropLines('L3');
    const record = w.orphan(SERVER, 'low', { buyerId: 'abc' });

    await w.deliver(w.createdEvent(record));

    expect(stored()).toEqual(before);
    expect(warned.filter(l => l.includes('was not installed'))).toEqual([
      `[PremiumManager] subscription.created from ${SELLER_ID} (subscription ${record.providerSubId}, guild ${SERVERS[0]}) was not installed: it names no buyer`,
    ]);
  });
});

describe('P1 claim 6: what is stored', () => {
  it('a paid subscription stores its buyer, still there after a reload, and its install line names the buyer; a manual grant stores none', async () => {
    const other = gh(SERVERS[1]);
    expect(await w.purchase(SERVER, 'low')).toMatchObject({ ok: true });
    expect(await w.created(other, 'mid', '80000000000000042')).toMatchObject({ ok: true });
    expect(await w.purchase(USER, 'vlow')).toMatchObject({ ok: true });
    expect(await w.created(uh(USERS[1]), 'vmid')).toMatchObject({ ok: true });
    expect(await w.grant(gh('5'), 'high', 30)).toMatchObject({ ok: true });
    expect(await w.grant(uh('5'), 'vhigh', null)).toMatchObject({ ok: true });

    const buyers = () => Object.fromEntries(Object.entries<any>(w.stored().subscriptions).map(([key, record]) => [key, [record.active.source, record.active.buyerId]]));
    const expected = {
      [SERVER]: ['paid', BUYER],
      [other]: ['paid', '80000000000000042'],
      [USER]: ['paid', USERS[0]],
      [uh(USERS[1])]: ['paid', USERS[1]],
      'guild:5': ['manual', undefined],
      'user:5': ['manual', undefined],
    };
    expect(buyers()).toEqual(expected);

    await w.reload();
    expect(await w.op('setMessages', { moduleBlocked: 'blocked' })).toMatchObject({ ok: true });
    expect(buyers()).toEqual(expected);
    expect(warned.filter(l => l.includes('does not read'))).toEqual([]);

    const installs = w.auditLines().filter(l => l.action === 'subscription.install.paid');
    expect(installs.map(l => [l.holder, l.metadata.buyerId])).toEqual([
      [SERVER, BUYER], [other, '80000000000000042'], [USER, USERS[0]], [uh(USERS[1]), USERS[1]],
    ]);
    const grants = w.auditLines().filter(l => l.action === 'subscription.grant.manual');
    expect(grants).toHaveLength(2);
    expect(grants.map(l => l.metadata?.buyerId)).toEqual([undefined, undefined]);
  });

  it('a created event redelivered after its install line was lost writes the install line again, with the buyer', async () => {
    expect(await w.created(SERVER, 'low', '80000000000000042')).toMatchObject({ ok: true });
    const kept = w.auditText().split('\n').filter(l => l.trim() && JSON.parse(l).action !== 'subscription.install.paid');
    fs.writeFileSync(AUDIT, kept.length > 0 ? `${kept.join('\n')}\n` : '');
    await w.reload();

    expect(await w.redelivered(SERVER)).toMatchObject({ ok: true });

    const installs = w.auditLines().filter(l => l.action === 'subscription.install.paid');
    expect(installs.map(l => [l.holder, l.metadata])).toEqual([[SERVER, { variantId: SELLER_VARIANT, redelivered: true, buyerId: '80000000000000042' }]]);
  });
});

describe('P1 claim 6: a listed subscription without a buyer', () => {
  it('gets the plan refuse with X10, active or paused, and its adoption answers X10 after one list call and writes nothing', async () => {
    const active = w.orphan(SERVER, 'low', { buyerId: null });
    const paused = w.orphan(SERVER, 'high', { buyerId: null, paused: true, daysLeft: 12 });

    const listed = await w.orphans(SERVER);

    expect(listed.map(o => [o.ref.providerSubId, o.plan])).toEqual([
      [active.providerSubId, { kind: 'refuse', reason: X10, line: `It cannot be adopted: ${X10}.` }],
      [paused.providerSubId, { kind: 'refuse', reason: X10, line: `It cannot be adopted: ${X10}.` }],
    ]);

    for (const record of [active, paused]) {
      const before = stored();
      const callsBefore = w.seller.calls.length;
      const reply = await w.adopt(SERVER, record.providerSubId, { kind: 'install' });
      expect(reply.ok).toBe(false);
      expect(reply.error).toContain(`Subscription '${record.providerSubId}' was not adopted: ${X10}.`);
      expect(stored()).toEqual(before);
      expect(w.seller.calls.slice(callsBefore)).toEqual([sellerListCall(SERVER)]);
    }
    expect(w.recordOf(SERVER)).toBeNull();
  });

  it("for a user, a listed subscription whose buyer is another user is refused, and the user's own is adopted", async () => {
    const foreign = w.orphan(USER, 'vlow', { buyerId: BUYER });
    const own = w.orphan(USER, 'vhigh');
    const reason = 'its buyer is not the user it is for; cancel it at P1 Seller instead';

    const listed = await w.orphans(USER);
    expect(listed.map(o => [o.ref.providerSubId, o.plan.kind, o.plan.reason])).toEqual([
      [foreign.providerSubId, 'refuse', reason],
      [own.providerSubId, 'install', undefined],
    ]);

    const refused = await w.adopt(USER, foreign.providerSubId, listed[0].plan);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(`Subscription '${foreign.providerSubId}' was not adopted: ${reason}.`);
    expect(w.recordOf(USER)).toBeNull();

    expect(await w.adopt(USER, own.providerSubId, listed[1].plan)).toMatchObject({ ok: true, result: true });
    expect(w.recordOf(USER).active).toMatchObject({ tierId: 'vhigh', source: 'paid', buyerId: USERS[0], providerSubId: own.providerSubId });
    const adopted = w.auditLines().filter(l => l.action === 'subscription.install.paid');
    expect(adopted.map(l => [l.holder, l.metadata.buyerId])).toEqual([[USER, USERS[0]]]);
  });

  it("the server's page does not adopt it by itself and leaves it listed", async () => {
    const record = w.orphan(SERVER, 'low', { buyerId: null });
    const listing = await w.orphans(SERVER);
    const adoptCalls: unknown[][] = [];
    const api = {
      listOrphans: async () => ({ success: true, orphans: JSON.parse(JSON.stringify(listing)) }),
      adoptOrphan: async (...args: unknown[]) => { adoptCalls.push(args); return { success: true }; },
      listPendingMigrations: async () => ({ success: true, migrations: [] }),
      listGuildChannels: async () => ({ success: true, channels: [] }),
    };
    const panel = loadGuildPanel(api);
    const props = { guild: { id: SERVERS[0] }, subData: { subscriptions: { paused: [] }, tiers: w.tiers('guild'), providers: [] }, onRefresh: async () => {} };

    panel.render(props);
    await panelFlush();
    const shown = panelText(panel.render(props));

    expect(adoptCalls).toEqual([]);
    expect(shown).toContain(record.providerSubId);
    expect(shown).toContain(`It cannot be adopted: ${X10}.`);
    expect(w.recordOf(SERVER)).toBeNull();
  });
});
