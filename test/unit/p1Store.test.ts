import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 claims 2, 17 and 20 (parts 3 and 4a): the store is keyed by holder, a provider account link stores its holder and its
// buyer, and the audit log names the holder. Every change goes through its shared op on the real manager; claim 2
// runs on the JSON files and on the mirror rig.
// P2 claim 12 (parts 0 and 2): the purchases of a server and of a user (claim 2) and their audit lines (claim 20) run
// again through the real Dummy provider; the created event is absent from its run.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { gh, uh } from '../helpers/p1Holder';
import { AUDIT, BUYER, defaultBuyer, eachSeller, LINKER, linkProvider, p1World, purchaseOptions, SELLER_ID, SELLER_VARIANT, SERVERS, USERS } from '../helpers/p1World';

const X12 = 'A provider account link needs the Discord id of the user who linked it; none was given.';

describe.each([['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]])('P1 claim 2 on %s: the store is keyed by holder', (_name, backend) => {
  eachSeller(['p1seller', 'dummy'], make => {
  const w = p1World(backend, make());
  beforeEach(async () => { await w.setup(); });
  afterEach(async () => { await w.teardown(); });

  it('a grant to a server, a grant to a user and a server purchase are stored under the three holder keys', async () => {
    await w.addUserTiers();
    const [server, other] = SERVERS;
    const user = USERS[0];

    expect(await w.grant(gh(server), 'low', 30)).toMatchObject({ ok: true });
    expect(await w.grant(uh(user), 'ulow', 30)).toMatchObject({ ok: true });
    expect(await w.purchase(gh(other), 'high')).toMatchObject({ ok: true });

    const doc = w.stored();
    expect(Object.keys(doc.subscriptions).sort()).toEqual([gh(server), gh(other), uh(user)].sort());
    expect(doc.subscriptions[gh(server)].active).toMatchObject({ tierId: 'low', source: 'manual' });
    expect(doc.subscriptions[uh(user)].active).toMatchObject({ tierId: 'ulow', source: 'manual' });
    expect(doc.subscriptions[gh(other)].active).toMatchObject({ tierId: 'high', source: 'paid', providerId: w.driver.id, buyerId: BUYER });
    expect(doc.subscriptions[gh(server)].active.buyerId).toBeUndefined();
    expect(doc.subscriptions[uh(user)].active.buyerId).toBeUndefined();
  });

  it("P2 claim 12: a user purchase and a server purchase are stored under the holders' keys, and guild:5 and user:5 hold different paid records", async () => {
    await w.addSoldUserTiers();
    const user = USERS[0];

    expect(await w.purchase(uh(user), 'vlow')).toMatchObject({ ok: true });
    expect(await w.purchase(gh('5'), 'low')).toMatchObject({ ok: true });
    expect(await w.purchase(uh('5'), 'vmid')).toMatchObject({ ok: true });

    const doc = w.stored();
    expect(Object.keys(doc.subscriptions).sort()).toEqual([uh(user), 'guild:5', 'user:5'].sort());
    expect(doc.subscriptions[uh(user)].active).toMatchObject({ tierId: 'vlow', source: 'paid', providerId: w.driver.id, buyerId: user });
    expect(doc.subscriptions['guild:5'].active).toMatchObject({ tierId: 'low', source: 'paid', buyerId: BUYER });
    expect(doc.subscriptions['user:5'].active).toMatchObject({ tierId: 'vmid', source: 'paid', buyerId: '5' });
    expect(doc.subscriptions['guild:5'].active.providerSubId).not.toBe(doc.subscriptions['user:5'].active.providerSubId);

    const serverBefore = JSON.stringify(doc.subscriptions['guild:5']);
    expect(await w.cancelNow(uh('5'))).toMatchObject({ ok: true });
    expect(w.stored().subscriptions['user:5']).toBeUndefined();
    expect(JSON.stringify(w.stored().subscriptions['guild:5'])).toBe(serverBefore);
    const installs = w.auditLines().filter(l => l.action === 'subscription.install.paid');
    expect(installs.map(l => [l.holder, l.metadata.buyerId])).toEqual([[uh(user), user], ['guild:5', BUYER], ['user:5', '5']]);
  });
  });

  eachSeller(['p1seller'], make => {
  const w = p1World(backend, make());
  beforeEach(async () => { await w.setup(); });
  afterEach(async () => { await w.teardown(); });

  it('a user purchase and an event install of each kind are stored under the holders\' keys, and guild:5 and user:5 hold different paid records', async () => {
    await w.addSoldUserTiers();
    const server = SERVERS[0];
    const user = USERS[0];

    expect(await w.purchase(uh(user), 'vlow')).toMatchObject({ ok: true });
    expect(await w.created(gh(server), 'mid')).toMatchObject({ ok: true });
    expect(await w.created(uh(USERS[1]), 'vhigh')).toMatchObject({ ok: true });
    expect(await w.purchase(gh('5'), 'low')).toMatchObject({ ok: true });
    expect(await w.created(uh('5'), 'vmid')).toMatchObject({ ok: true });

    const doc = w.stored();
    expect(Object.keys(doc.subscriptions).sort()).toEqual([uh(user), gh(server), uh(USERS[1]), 'guild:5', 'user:5'].sort());
    expect(doc.subscriptions[uh(user)].active).toMatchObject({ tierId: 'vlow', source: 'paid', providerId: SELLER_ID, buyerId: user });
    expect(doc.subscriptions[gh(server)].active).toMatchObject({ tierId: 'mid', source: 'paid', providerId: SELLER_ID, buyerId: BUYER });
    expect(doc.subscriptions[uh(USERS[1])].active).toMatchObject({ tierId: 'vhigh', source: 'paid', buyerId: USERS[1] });
    expect(doc.subscriptions['guild:5'].active).toMatchObject({ tierId: 'low', source: 'paid', buyerId: BUYER });
    expect(doc.subscriptions['user:5'].active).toMatchObject({ tierId: 'vmid', source: 'paid', buyerId: '5' });
    expect(doc.subscriptions['guild:5'].active.providerSubId).not.toBe(doc.subscriptions['user:5'].active.providerSubId);

    const serverBefore = JSON.stringify(doc.subscriptions['guild:5']);
    expect(await w.cancelNow(uh('5'))).toMatchObject({ ok: true });
    expect(w.stored().subscriptions['user:5']).toBeUndefined();
    expect(JSON.stringify(w.stored().subscriptions['guild:5'])).toBe(serverBefore);
    expect(w.auditLines().filter(l => l.action === 'subscription.install.paid').map(l => l.holder)).toEqual([uh(user), gh(server), uh(USERS[1]), 'guild:5', 'user:5']);
  });

  it('guild:5 and user:5 are two holders with two records, and a change to one leaves the other', async () => {
    await w.addUserTiers();
    expect(await w.grant(gh('5'), 'mid', null)).toMatchObject({ ok: true });
    expect(await w.grant(uh('5'), 'uhigh', 10)).toMatchObject({ ok: true });

    const doc = w.stored();
    expect(Object.keys(doc.subscriptions).sort()).toEqual(['guild:5', 'user:5']);
    expect(doc.subscriptions['guild:5'].active).toMatchObject({ tierId: 'mid', endDate: null });
    expect(doc.subscriptions['user:5'].active.tierId).toBe('uhigh');
    expect(doc.subscriptions['guild:5'].active.id).not.toBe(doc.subscriptions['user:5'].active.id);

    const userBefore = JSON.stringify(doc.subscriptions['user:5']);
    expect(await w.revoke(gh('5'))).toMatchObject({ ok: true });
    expect(Object.keys(w.stored().subscriptions)).toEqual(['user:5']);
    expect(JSON.stringify(w.stored().subscriptions['user:5'])).toBe(userBefore);
  });

  it('the keys are still the holder keys after a reload, and the getters read each holder by its key', async () => {
    await w.addUserTiers();
    expect(await w.grant(gh(SERVERS[0]), 'low', 30)).toMatchObject({ ok: true });
    expect(await w.grant(uh(USERS[0]), 'ulow', null)).toMatchObject({ ok: true });
    await w.reload();

    const mgr: any = getPremiumManager();
    expect(Object.keys(mgr.getAllSubscriptions()).sort()).toEqual([gh(SERVERS[0]), uh(USERS[0])].sort());
    expect(mgr.getSubscriptions(gh(SERVERS[0])).active.tierId).toBe('low');
    expect(mgr.getSubscriptions(uh(USERS[0])).active.tierId).toBe('ulow');
    expect(mgr.getHolderSubscriptions(uh(USERS[0])).active.tierId).toBe('ulow');
    expect(mgr.getHolderSubscriptions(uh(USERS[1]))).toBeNull();
    expect(mgr.getSubscriptions(gh(USERS[0]))).toEqual({ paused: [] });
  });
  });
});

describe('the getters given a text that is no holder key', () => {
  const w = p1World();
  beforeEach(async () => { await w.setup(); });
  afterEach(async () => { await w.teardown(); });

  it('answer an empty record and null, also for the name of an inherited member', async () => {
    expect(await w.grant(gh(SERVERS[0]), 'low', 30)).toMatchObject({ ok: true });
    const mgr: any = getPremiumManager();

    expect(mgr.getSubscriptions('constructor')).toEqual({ paused: [] });
    expect(mgr.getSubscriptions('__proto__')).toEqual({ paused: [] });
    expect(mgr.getSubscriptions(SERVERS[0])).toEqual({ paused: [] });
    expect(mgr.getHolderSubscriptions('toString')).toBeNull();
    expect(mgr.getHolderSubscriptions('constructor')).toBeNull();
    expect(mgr.getHolderSubscriptions(SERVERS[0])).toBeNull();
    expect(mgr.getHolderSubscriptions(gh(SERVERS[0])).active.tierId).toBe('low');
  });
});

describe("the world's default buyer", () => {
  it("is the user for a user's purchase and BUYER for a server's, and a named buyer wins", () => {
    expect(defaultBuyer(uh(USERS[0]))).toBe(USERS[0]);
    expect(purchaseOptions(uh(USERS[1])).buyerId).toBe(USERS[1]);
    expect(purchaseOptions(gh(SERVERS[0])).buyerId).toBe(BUYER);
    expect(purchaseOptions(SERVERS[1]).buyerId).toBe(BUYER);
    expect(purchaseOptions(uh(USERS[0]), BUYER).buyerId).toBe(BUYER);
  });
});

describe('P1 claim 17: a provider account link stores its holder and its buyer', () => {
  const w = p1World();
  let link: ReturnType<typeof linkProvider>;
  const callback = (query: Record<string, string>) => w.sharedOp('payment.oauthCallback', { providerId: LINKER, query });
  beforeEach(async () => {
    await w.setup();
    link = linkProvider();
    getPaymentRegistry().register(link.provider);
  });
  afterEach(async () => { await w.teardown(); });

  it('payment.oauthCallback stores { holder, buyerId }, still there after a reload', async () => {
    const reply = await callback({ account: 'acct-1', guild: SERVERS[0], buyer: BUYER });

    expect(reply).toMatchObject({ ok: true, result: { linked: gh(SERVERS[0]) } });
    expect(w.stored().providerAccountLinks).toStrictEqual({ [LINKER]: { 'acct-1': { holder: gh(SERVERS[0]), buyerId: BUYER } } });
    expect(w.recordOf(SERVERS[0]).active).toMatchObject({ source: 'paid', providerId: LINKER, providerSubId: `${LINKER}:acct-1:${SERVERS[0]}` });

    await w.reload();
    expect((getPremiumManager() as any).getAccountLink(LINKER, 'acct-1')).toStrictEqual({ holder: gh(SERVERS[0]), buyerId: BUYER });
    expect((await w.setTier('mid', 'Mid renamed')).ok).toBe(true);
    expect(w.stored().providerAccountLinks).toStrictEqual({ [LINKER]: { 'acct-1': { holder: gh(SERVERS[0]), buyerId: BUYER } } });
  });

  it("the callback's created event carries the holder and the buyer the provider answered, and no server id", async () => {
    const events: any[] = [];
    getPaymentRegistry().on('provider.event', (e: any) => events.push(e));

    expect(await callback({ account: 'acct-1', guild: SERVERS[0], buyer: BUYER })).toMatchObject({ ok: true });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'subscription.created', providerSubId: `${LINKER}:acct-1:${SERVERS[0]}`, holder: gh(SERVERS[0]), buyerId: BUYER });
    expect(events[0]).not.toHaveProperty('guildId');
  });

  it.each([['no buyer', undefined], ['a buyer that is no Discord id', 'abc']])('a callback that names %s answers X12 and links nothing', async (_what, buyer) => {
    const before = w.storedText();
    const audit = w.auditText();

    const reply = await callback({ account: 'acct-1', guild: SERVERS[0], ...(buyer === undefined ? {} : { buyer }) });

    expect(reply.ok).toBe(false);
    expect(reply.error).toContain(X12);
    expect(w.storedText()).toBe(before);
    expect(w.auditText()).toBe(audit);
    expect(w.recordOf(SERVERS[0])).toBeNull();
  });

  it.each([
    ['a user holder', uh(USERS[0]), `P1 Linker links accounts to servers only; it answered for user ${USERS[0]}, and nothing was linked.`],
    ['a text that is not a holder', 'guild:abc', "'guild:abc' is not a holder: expected guild:<id> or user:<id> with a Discord id."],
  ])('a callback that answers %s is refused with its own text, links nothing and raises no event', async (_what, holder, text) => {
    const events: any[] = [];
    getPaymentRegistry().on('provider.event', (e: any) => events.push(e));
    const before = w.storedText();
    const audit = w.auditText();

    const reply = await callback({ account: 'acct-1', holder, buyer: USERS[0] });

    expect(reply.ok).toBe(false);
    expect(reply.error).toBe(text);
    expect(events).toEqual([]);
    expect(w.storedText()).toBe(before);
    expect(w.auditText()).toBe(audit);
  });

  it('an account already linked to this server, called back with a state that names no valid buyer, answers X12, raises no event and keeps the link', async () => {
    expect(await callback({ account: 'acct-1', guild: SERVERS[0], buyer: BUYER })).toMatchObject({ ok: true });
    await w.settle();
    const events: any[] = [];
    getPaymentRegistry().on('provider.event', (e: any) => events.push(e));
    const before = w.storedText();
    const audit = w.auditText();

    const none = await callback({ account: 'acct-1', guild: SERVERS[0] });
    const text = await callback({ account: 'acct-1', guild: SERVERS[0], buyer: 'abc' });

    expect([none.ok, text.ok]).toEqual([false, false]);
    expect(none.error).toContain(X12);
    expect(text.error).toContain(X12);
    expect(events).toEqual([]);
    expect(w.storedText()).toBe(before);
    expect(w.auditText()).toBe(audit);
    expect((getPremiumManager() as any).getAccountLink(LINKER, 'acct-1')).toStrictEqual({ holder: gh(SERVERS[0]), buyerId: BUYER });
  });

  it('a second server linking the same account answers linkedElsewhere with the first holder and changes nothing', async () => {
    expect(await callback({ account: 'acct-1', guild: SERVERS[0], buyer: BUYER })).toMatchObject({ ok: true });
    const before = w.storedText();

    const second = await callback({ account: 'acct-1', guild: SERVERS[1], buyer: BUYER });

    expect(second).toMatchObject({ ok: true, result: { linkedElsewhere: gh(SERVERS[0]) } });
    expect(w.storedText()).toBe(before);
    expect(w.recordOf(SERVERS[1])).toBeNull();
  });

  it('a second link of the same account to the same holder by another user keeps the first buyer and writes nothing', async () => {
    const other = '80000000000000002';
    expect(await callback({ account: 'acct-1', guild: SERVERS[0], buyer: BUYER })).toMatchObject({ ok: true });
    await w.settle();
    const first = { [LINKER]: { 'acct-1': { holder: gh(SERVERS[0]), buyerId: BUYER } } };

    const again = await callback({ account: 'acct-1', guild: SERVERS[0], buyer: other });
    await w.settle();
    expect(again).toMatchObject({ ok: true, result: { linked: gh(SERVERS[0]) } });
    expect(w.stored().providerAccountLinks).toStrictEqual(first);

    const before = w.storedText();
    const audit = w.auditText();
    const byOp = await w.op('linkAccount', LINKER, 'acct-1', gh(SERVERS[0]), other);
    expect(byOp).toMatchObject({ ok: true, result: true });
    expect(w.storedText()).toBe(before);
    expect(w.auditText()).toBe(audit);
    await w.reload();
    expect((getPremiumManager() as any).getAccountLink(LINKER, 'acct-1')).toStrictEqual({ holder: gh(SERVERS[0]), buyerId: BUYER });
  });

  it("after keep-first the callback's created event carries the linked buyer, and a later install names that buyer", async () => {
    const other = '80000000000000002';
    const events: any[] = [];
    getPaymentRegistry().on('provider.event', (e: any) => events.push(e));
    expect(await callback({ account: 'acct-1', guild: SERVERS[0], buyer: BUYER })).toMatchObject({ ok: true });
    await w.settle();
    const subId = `${LINKER}:acct-1:${SERVERS[0]}`;

    expect(await callback({ account: 'acct-1', guild: SERVERS[0], buyer: other })).toMatchObject({ ok: true, result: { linked: gh(SERVERS[0]) } });
    await w.settle();
    expect((getPremiumManager() as any).getAccountLink(LINKER, 'acct-1')).toStrictEqual({ holder: gh(SERVERS[0]), buyerId: BUYER });
    expect(events.map(e => [e.type, e.buyerId])).toEqual([['subscription.created', BUYER], ['subscription.created', BUYER]]);

    getPaymentRegistry().emitEvent({
      type: 'subscription.expired', providerId: LINKER, providerSubId: subId, holder: gh(SERVERS[0]),
      state: { status: 'expired', startDate: new Date(Date.now() - 1000).toISOString(), endDate: new Date().toISOString(), autoRenew: false },
    } as any);
    await w.settle();
    expect(w.recordOf(SERVERS[0])?.active?.providerSubId).not.toBe(subId);

    expect(await callback({ account: 'acct-1', guild: SERVERS[0], buyer: other })).toMatchObject({ ok: true });
    await w.settle();
    expect(events.at(-1)).toMatchObject({ type: 'subscription.created', buyerId: BUYER });
    expect(w.recordOf(SERVERS[0]).active).toMatchObject({ providerId: LINKER, providerSubId: subId, buyerId: BUYER });
  });

  it('linkAccount through its op stores the link, and refuses a buyer that is no Discord id with X12', async () => {
    const good = await w.op('linkAccount', LINKER, 'acct-2', gh(SERVERS[1]), BUYER);
    expect(good).toMatchObject({ ok: true, result: true });
    const before = w.storedText();

    const none = await w.op('linkAccount', LINKER, 'acct-3', gh(SERVERS[1]));
    const text = await w.op('linkAccount', LINKER, 'acct-3', gh(SERVERS[1]), 'owner');
    const elsewhere = await w.op('linkAccount', LINKER, 'acct-2', gh(SERVERS[0]), BUYER);

    expect([none.ok, text.ok]).toEqual([false, false]);
    expect(none.error).toContain(X12);
    expect(text.error).toContain(X12);
    expect(elsewhere).toMatchObject({ ok: true, result: false });
    expect(w.storedText()).toBe(before);
    expect(w.stored().providerAccountLinks[LINKER]).toStrictEqual({ 'acct-2': { holder: gh(SERVERS[1]), buyerId: BUYER } });
  });

  it('after an unlink the account links again, to the user who links it then', async () => {
    const other = '80000000000000002';
    expect(await callback({ account: 'acct-1', guild: SERVERS[0], buyer: BUYER })).toMatchObject({ ok: true });
    expect(await w.op('unlinkProviderAccount', gh(SERVERS[0]), LINKER)).toMatchObject({ ok: true, result: true });
    expect(w.stored().providerAccountLinks).toEqual({});

    const again = await callback({ account: 'acct-1', guild: SERVERS[0], buyer: other });
    await w.settle();

    expect(again).toMatchObject({ ok: true, result: { linked: gh(SERVERS[0]) } });
    expect(w.stored().providerAccountLinks).toStrictEqual({ [LINKER]: { 'acct-1': { holder: gh(SERVERS[0]), buyerId: other } } });
  });

  it("unlinkProviderAccount(holder, provider) cancels that holder's subscriptions of the provider and removes the link", async () => {
    expect(await callback({ account: 'acct-1', guild: SERVERS[0], buyer: BUYER })).toMatchObject({ ok: true });
    expect(await callback({ account: 'acct-9', guild: SERVERS[1], buyer: BUYER })).toMatchObject({ ok: true });
    const otherBefore = JSON.stringify(w.recordOf(SERVERS[1]));

    const noLink = await w.op('unlinkProviderAccount', gh('70000000000000009'), LINKER);
    const reply = await w.op('unlinkProviderAccount', gh(SERVERS[0]), LINKER);

    expect(noLink).toMatchObject({ ok: true, result: false });
    expect(reply).toMatchObject({ ok: true, result: true });
    expect(link.calls).toEqual([`cancel ${LINKER}:acct-1:${SERVERS[0]} true`]);
    expect(w.recordOf(SERVERS[0])).toBeNull();
    expect(w.stored().providerAccountLinks).toStrictEqual({ [LINKER]: { 'acct-9': { holder: gh(SERVERS[1]), buyerId: BUYER } } });
    expect(JSON.stringify(w.recordOf(SERVERS[1]))).toBe(otherBefore);
  });
});

describe('P1 claim 20: the audit log names the holder', () => {
  eachSeller(['p1seller', 'dummy'], make => {
  const w = p1World('json', make());
  beforeEach(async () => { await w.setup(); });
  afterEach(async () => { await w.teardown(); });

  it('every line a writer makes for a holder has `holder` and no `guildId`', async () => {
    await w.addUserTiers();
    const [a, b] = SERVERS;
    const u = USERS[0];
    const before = w.auditLines().length;
    expect(await w.grant(a, 'low', 30)).toMatchObject({ ok: true });
    expect(await w.extend(a, 5)).toMatchObject({ ok: true });
    expect(await w.purchase(a, 'high')).toMatchObject({ ok: true });
    expect(await w.cancelNow(a)).toMatchObject({ ok: true });
    expect(await w.revoke(a)).toMatchObject({ ok: true });
    if (w.delivers) expect(await w.created(b, 'mid')).toMatchObject({ ok: true });
    expect(await w.grant(uh(u), 'ulow', 30)).toMatchObject({ ok: true });
    expect(await w.grant(uh(u), 'uhigh', 30)).toMatchObject({ ok: true });
    expect(await w.revoke(uh(u))).toMatchObject({ ok: true });

    const lines = w.auditLines().slice(before);
    expect(lines.map(l => `${l.action} ${l.holder}`)).toEqual([
      `subscription.grant.manual ${gh(a)}`,
      `subscription.extend.manual ${gh(a)}`,
      `subscription.install.paid ${gh(a)}`,
      `subscription.pause ${gh(a)}`,
      `subscription.cancel.paid ${gh(a)}`,
      `subscription.resume ${gh(a)}`,
      `subscription.revoke.manual ${gh(a)}`,
      ...(w.delivers ? [`subscription.install.paid ${gh(b)}`] : []),
      `subscription.grant.manual ${uh(u)}`,
      `subscription.grant.manual ${uh(u)}`,
      `subscription.pause ${uh(u)}`,
      `subscription.resume ${uh(u)}`,
      `subscription.revoke.manual ${uh(u)}`,
    ]);
    expect(lines.filter(l => 'guildId' in l)).toEqual([]);
    expect(lines.find(l => l.action === 'subscription.install.paid' && l.holder === gh(a)).metadata.buyerId).toBe(BUYER);
  });
  });

  eachSeller(['p1seller'], make => {
  const w = p1World('json', make());
  beforeEach(async () => { await w.setup(); });
  afterEach(async () => { await w.teardown(); });

  it('readAuditEntries({ holder }) returns the lines of that holder only', async () => {
    await w.addUserTiers();
    expect(await w.grant(gh('5'), 'low', 30)).toMatchObject({ ok: true });
    expect(await w.grant(uh('5'), 'ulow', 30)).toMatchObject({ ok: true });
    expect(await w.grant(gh('55'), 'low', 30)).toMatchObject({ ok: true });

    const mgr: any = getPremiumManager();
    const server = await mgr.readAuditEntries({ holder: 'guild:5' });
    const user = await mgr.readAuditEntries({ holder: 'user:5' });
    const all = await mgr.readAuditEntries({ action: 'subscription.grant.manual' });

    expect(server.entries.map((e: any) => e.holder)).toEqual(['guild:5']);
    expect(user.entries.map((e: any) => e.holder)).toEqual(['user:5']);
    expect(all.entries.map((e: any) => e.holder)).toEqual(['guild:55', 'user:5', 'guild:5']);
  });

  it('lines already in the file are byte-equal after any number of saves, and are not read through `guildId`', async () => {
    await w.settle();
    const old = [
      JSON.stringify({ timestamp: '2026-10-01T10:00:00.000Z', actor: 'admin', action: 'subscription.grant.manual', guildId: SERVERS[0], tierId: 'low', subscriptionId: 'old-1' }),
      JSON.stringify({ timestamp: '2026-10-01T10:00:01.000Z', actor: 'admin', action: 'subscription.revoke.manual', guildId: SERVERS[0], subscriptionId: 'old-1' }),
    ].join('\n') + '\n';
    const made = fs.readFileSync(AUDIT, 'utf8');
    fs.writeFileSync(AUDIT, old + made);

    expect(await w.grant(SERVERS[0], 'low', 30)).toMatchObject({ ok: true });
    expect(await w.setTier('mid', 'Mid two')).toMatchObject({ ok: true });
    expect(await w.revoke(SERVERS[0])).toMatchObject({ ok: true });
    await w.reload();
    expect(await w.grant(SERVERS[1], 'mid', null)).toMatchObject({ ok: true });

    const now = fs.readFileSync(AUDIT, 'utf8');
    expect(now.startsWith(old + made)).toBe(true);
    expect(now.length).toBeGreaterThan((old + made).length);
    const read = await (getPremiumManager() as any).readAuditEntries({ holder: gh(SERVERS[0]) });
    expect(read.entries.map((e: any) => e.subscriptionId).includes('old-1')).toBe(false);
    expect(read.entries.map((e: any) => e.action).sort()).toEqual(['subscription.grant.manual', 'subscription.revoke.manual']);
  });
  });
});
