import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 claims 5 and 22 (parts 3 and 4a): a tier of the wrong kind never reaches the store, and no method stores under
// a text that is not a holder key. Every call goes through its shared op on the real manager; the stored bytes, the
// audit log, the seller's call list and the notices are compared with what they were before the call.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { notices } from '../helpers/p1Mocks';
import { gh, uh } from '../helpers/p1Holder';
import { allowDropLines } from '../helpers/p1Guard';
import { brokenHolders, BUYER, p1World, purchaseOptions, SELLER_ID, SELLER_VARIANT, sellerListCall, sellerOffering, SERVERS, USERS, userTierDef } from '../helpers/p1World';

const w = p1World();
const X1 = (text: string) => `'${text}' is not a holder: expected guild:<id> or user:<id> with a Discord id.`;
const X11 = 'Price changes cannot be scheduled for a user tier: a user has no page to accept or decline one until the "My account" page exists.';
const state = () => ({ premium: w.storedText(), audit: w.auditText(), calls: JSON.stringify(w.seller.calls), notices: JSON.stringify(notices.sent) });
const schedule = (over: Record<string, unknown> = {}, inMs = 3_600_000) => w.op('scheduleMigration', {
  providerId: SELLER_ID, sourceTierId: 'low', sourceOfferingId: 'o-low', sourceVariantId: SELLER_VARIANT,
  targetTierId: 'mid', targetOfferingId: 'o-mid', targetVariantId: SELLER_VARIANT,
  effectiveDate: new Date(Date.now() + inMs).toISOString(), message: 'the price changes', ...over,
});

beforeEach(async () => {
  await w.setup();
  await w.addUserTiers();
});
afterEach(async () => { await w.teardown(); });

describe('P1 claim 5: a tier of the wrong kind never reaches the store', () => {
  it.each([
    ['a manual grant of a user tier to a server', () => w.grant(gh(SERVERS[0]), 'ulow', 30), "'ULOW' is a user tier and cannot be given to a server."],
    ['a manual grant of a server tier to a user', () => w.grant(uh(USERS[0]), 'low', 30), "'LOW' is a server tier and cannot be given to a user."],
    ['a lifetime grant of a server tier to a user', () => w.grant(uh(USERS[0]), 'high', null), "'HIGH' is a server tier and cannot be given to a user."],
    ['a server purchase of a user tier', () => w.purchase(gh(SERVERS[0]), 'ulow'), "'ULOW' is a user tier and cannot be given to a server."],
    ['a user purchase of a server tier', () => w.purchase(uh(USERS[0]), 'low'), "'LOW' is a server tier and cannot be given to a user."],
    ['a user purchase of a server tier by a user with no record', () => w.purchase(uh(USERS[1]), 'high'), "'HIGH' is a server tier and cannot be given to a user."],
    ['a migration schedule whose source is a user tier', () => schedule({ sourceTierId: 'ulow' }), X11],
    ['a migration schedule whose target is a user tier', () => schedule({ targetTierId: 'uhigh' }), X11],
  ])('%s is refused with its text and changes nothing', async (_what, call, text) => {
    expect(await w.grant(gh(SERVERS[0]), 'mid', 30)).toMatchObject({ ok: true });
    expect(await w.grant(uh(USERS[0]), 'umid', 30)).toMatchObject({ ok: true });
    const before = state();

    const reply = await call();

    expect(reply.ok).toBe(false);
    expect(reply.error).toContain(text);
    expect(state()).toEqual(before);
  });

  it('a wrong-kind grant is refused for a holder with no record too, and makes none', async () => {
    const before = state();
    const reply = await w.grant(uh(USERS[1]), 'mid', 30);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("'MID' is a server tier and cannot be given to a user.");
    expect(state()).toEqual(before);
    expect(w.stored().subscriptions).toEqual({});
  });

  it('the seller sells both kinds: a purchase of a user tier is installed for a user and refused for a server, and the seller is called for the user only', async () => {
    expect((await w.op('setTier', 'usold', { ...userTierDef('ulow', 'U Sold'), priority: 4, offerings: [sellerOffering('o-usold', 'U Sold')] })).ok).toBe(true);
    const before = state();

    const refused = await w.op('initiatePaidSubscription', gh(SERVERS[0]), 'usold', 'o-usold', purchaseOptions(gh(SERVERS[0])));

    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("'U Sold' is a user tier and cannot be given to a server.");
    expect(state()).toEqual(before);
    expect(w.seller.calls).toEqual([]);

    const reply = await w.op('initiatePaidSubscription', uh(USERS[0]), 'usold', 'o-usold', purchaseOptions(uh(USERS[0])));

    expect(reply).toMatchObject({ ok: true });
    expect(w.recordOf(uh(USERS[0])).active).toMatchObject({ tierId: 'usold', source: 'paid', buyerId: USERS[0] });
    expect(w.seller.calls.map(c => c.method)).toEqual([sellerListCall(uh(USERS[0])).method, 'initiatePurchase']);
    expect(brokenHolders(w.stored())).toEqual([]);
  });

  it.each([
    ['a created event of a user tier for a server', gh(SERVERS[0]), 'usold', `guild ${SERVERS[0]}`, "'U Sold' is a user tier"],
    ['a created event of a server tier for a user', uh(USERS[0]), 'low', `user ${USERS[0]}`, "'LOW' is a server tier"],
  ])('%s installs nothing, logs L3 and changes nothing', async (_what, holder, tierId, words, why) => {
    expect((await w.op('setTier', 'usold', { ...userTierDef('ulow', 'U Sold'), priority: 4, offerings: [sellerOffering('o-usold', 'U Sold')] })).ok).toBe(true);
    expect(await w.grant(gh(SERVERS[0]), 'mid', 30)).toMatchObject({ ok: true });
    expect(await w.grant(uh(USERS[0]), 'umid', 30)).toMatchObject({ ok: true });
    const before = { premium: w.storedText(), audit: w.auditText(), notices: JSON.stringify(notices.sent) };
    const warned: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(' ')); });
    allowDropLines('L3');

    const reply = await w.created(holder, tierId);
    warn.mockRestore();

    expect(reply).toMatchObject({ ok: true });
    expect({ premium: w.storedText(), audit: w.auditText(), notices: JSON.stringify(notices.sent) }).toEqual(before);
    expect(w.seller.calls).toEqual([]);
    const lines = warned.filter(l => l.includes('was not installed'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^\\[PremiumManager\\] subscription\\.created from ${SELLER_ID} \\(subscription p1s_\\d+, ${words}\\) was not installed: ${why}$`));
  });

  it.each([
    ['an active listed subscription of a user tier, for a server', gh(SERVERS[0]), 'usold', false, "'U Sold' is a user tier and cannot be given to a server"],
    ['a paused listed subscription of a user tier, for a server', gh(SERVERS[0]), 'usold', true, "'U Sold' is a user tier and cannot be given to a server"],
    ['an active listed subscription of a server tier, for a user', uh(USERS[0]), 'low', false, "'LOW' is a server tier and cannot be given to a user"],
    ['a paused listed subscription of a server tier, for a user', uh(USERS[0]), 'low', true, "'LOW' is a server tier and cannot be given to a user"],
  ])('the adoption of %s is refused after its one list call: no resume call, nothing written, no notice', async (_what, holder, tierId, paused, reason) => {
    expect((await w.op('setTier', 'usold', { ...userTierDef('ulow', 'U Sold'), priority: 4, offerings: [sellerOffering('o-usold', 'U Sold')] })).ok).toBe(true);
    const record = w.orphan(holder, tierId, paused ? { paused: true, daysLeft: 12 } : {});
    const listed = await w.orphans(holder);
    expect(listed.map((o: any) => [o.ref.providerSubId, o.plan])).toEqual([[record.providerSubId, { kind: 'refuse', reason, line: `It cannot be adopted: ${reason}.` }]]);
    const before = { premium: w.storedText(), audit: w.auditText(), notices: JSON.stringify(notices.sent) };
    const callsBefore = w.seller.calls.length;

    const reply = await w.adopt(holder, record.providerSubId, paused ? { kind: 'resume', days: 12, from: 'recorded', autoRenew: true, call: true } : { kind: 'install' });

    expect(reply.ok).toBe(false);
    expect(reply.error).toContain(`Subscription '${record.providerSubId}' was not adopted: ${reason}.`);
    expect({ premium: w.storedText(), audit: w.auditText(), notices: JSON.stringify(notices.sent) }).toEqual(before);
    expect(w.seller.calls.slice(callsBefore)).toEqual([sellerListCall(holder)]);
    expect(w.seller.records.get(record.providerSubId)!.status).toBe(paused ? 'paused' : 'active');
  });

  it("the adoption's check after its resume: a tier deleted and made again as a user tier while the resume call is open ends with R1 and one pause call", async () => {
    const server = gh(SERVERS[0]);
    const days = 12;
    const record = w.orphan(server, 'low', { paused: true, daysLeft: days });
    const listed = await w.orphans(server);
    expect(listed[0].plan).toMatchObject({ kind: 'resume', call: true, days });
    let release!: () => void;
    w.seller.holdResume = new Promise<void>(resolve => { release = resolve; });
    const callsBefore = w.seller.calls.length;
    for (const level of ['log', 'warn'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);

    const pending = w.adopt(server, record.providerSubId, listed[0].plan);
    await vi.waitFor(() => expect(w.seller.calls.some(c => c.method === 'resumeSubscription')).toBe(true), { timeout: 5000, interval: 10 });
    // While the seller's resume call is open, as unit/nb25Adopt.test.ts changes premium during one.
    expect(getPremiumManager().deleteTier('low')).toBe(true);
    expect(getPremiumManager().setTier('low', { displayName: 'LOW', priority: 1, overrides: {}, offerings: [sellerOffering('o-low', 'LOW')] as any, kind: 'user' })).toBe(true);
    release();
    const reply = await pending;
    vi.restoreAllMocks();

    expect(reply.ok).toBe(false);
    expect(reply.error).toContain(`Subscription '${record.providerSubId}' was not adopted: it was resumed at P1 Seller, but not installed: tier 'low' is now a user tier. It was paused again at P1 Seller.`);
    expect(w.seller.calls.slice(callsBefore).map(c => c.method)).toEqual([sellerListCall(server).method, 'resumeSubscription', 'pauseSubscription']);
    expect(w.seller.calls[w.seller.calls.length - 1].args).toEqual([record.providerSubId, null, days]);
    expect(w.seller.records.get(record.providerSubId)).toMatchObject({ status: 'paused', pausedDaysLeft: days });
    expect(w.recordOf(server)).toBeNull();
    expect(w.stored().tiers.low.kind).toBe('user');
    expect(brokenHolders(w.stored())).toEqual([]);
    expect(w.auditLines().filter(l => l.action === 'subscription.adopt.orphan' || l.action === 'subscription.install.paid')).toEqual([]);
  });

  it('a due migration whose target tier was made again as a user tier records failed with N1 and calls no provider', async () => {
    expect(await w.purchase(SERVERS[0], 'low')).toMatchObject({ ok: true });
    const scheduled = await schedule({}, 400);
    expect(scheduled).toMatchObject({ ok: true });
    const id = scheduled.result.id;
    expect(await w.op('recordMigrationDecision', id, gh(SERVERS[0]), 'accepted')).toMatchObject({ ok: true, result: true });
    expect(await w.deleteTier('mid')).toMatchObject({ ok: true });
    expect((await w.op('setTier', 'mid', { ...userTierDef('umid', 'Mid as user'), priority: 2 })).ok).toBe(true);
    const callsBefore = w.seller.calls.length;
    await new Promise(resolve => setTimeout(resolve, 450));

    await getPremiumManager().processDueMigrations();
    await w.settle();

    const stored = w.stored().migrations.find((m: any) => m.id === id);
    expect(stored.status).toBe('applied');
    expect(stored.decisions).toHaveLength(1);
    expect(stored.decisions[0]).toMatchObject({ holder: gh(SERVERS[0]), decision: 'accepted', outcome: 'failed', outcomeNote: 'the target tier is now a user tier' });
    expect(w.seller.calls.slice(callsBefore)).toEqual([]);
    expect(w.recordOf(SERVERS[0]).active).toMatchObject({ tierId: 'low', variantId: SELLER_VARIANT });
  });

  it('a due migration whose target tier was deleted records failed and calls no provider, so the id made again as a user tier leaves N2 whole', async () => {
    expect(await w.purchase(SERVERS[0], 'low')).toMatchObject({ ok: true });
    const scheduled = await schedule({}, 400);
    expect(scheduled).toMatchObject({ ok: true });
    const id = scheduled.result.id;
    expect(await w.op('recordMigrationDecision', id, gh(SERVERS[0]), 'accepted')).toMatchObject({ ok: true, result: true });
    expect(await w.deleteTier('mid')).toMatchObject({ ok: true });
    const callsBefore = w.seller.calls.length;
    await new Promise(resolve => setTimeout(resolve, 450));

    const warned: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(' ')); });
    await getPremiumManager().processDueMigrations();
    await w.settle();
    warn.mockRestore();

    expect(warned.filter(l => l.includes('price change'))).toEqual([`[PremiumManager] The price change ${id} was not applied for guild ${SERVERS[0]}: the target tier no longer exists`]);
    const stored = w.stored().migrations.find((m: any) => m.id === id);
    expect(stored.status).toBe('applied');
    expect(stored.decisions).toHaveLength(1);
    expect(stored.decisions[0]).toMatchObject({ holder: gh(SERVERS[0]), decision: 'accepted', outcome: 'failed', outcomeNote: 'the target tier no longer exists' });
    expect(w.seller.calls.slice(callsBefore)).toEqual([]);
    expect(w.recordOf(SERVERS[0]).active).toMatchObject({ tierId: 'low', variantId: SELLER_VARIANT });

    expect((await w.op('setTier', 'mid', { ...userTierDef('umid', 'Mid as user'), priority: 2 })).ok).toBe(true);
    expect(w.recordOf(SERVERS[0]).active).toMatchObject({ tierId: 'low' });
    expect(brokenHolders(w.stored())).toEqual([]);
  });

  it('a record written by hand under user:1 that holds a paid subscription of a server tier gets no decision', async () => {
    expect(await w.purchase(SERVERS[0], 'low')).toMatchObject({ ok: true });
    // No writer of this tree stores a server tier's subscription under a user: the file is edited by hand.
    const doc = w.stored();
    const copy = JSON.parse(JSON.stringify(doc.subscriptions[gh(SERVERS[0])].active));
    doc.subscriptions['user:1'] = { active: { ...copy, id: 'hand-1', providerSubId: 'p1s_hand', buyerId: '1' }, paused: [] };
    await w.teardown();
    await w.setup({ seed: JSON.stringify(doc, null, 2) });

    const scheduled = await schedule();

    expect(scheduled).toMatchObject({ ok: true });
    expect(scheduled.result.decisions.map((d: any) => d.holder)).toEqual([gh(SERVERS[0])]);
    expect(w.stored().migrations[0].decisions.map((d: any) => d.holder)).toEqual([gh(SERVERS[0])]);
    expect(w.stored().subscriptions['user:1'].active.id).toBe('hand-1');
    expect(notices.sent.filter(n => n.kind === 'migration.scheduled').map(n => n.to)).toEqual([gh(SERVERS[0])]);
  });
});

describe('P1 claim 22: no method stores under a text that is not a holder key', () => {
  const methods: Array<[string, (holder: unknown) => unknown[]]> = [
    ['grantManual', h => [h, 'low', 30]],
    ['extendManual', h => [h, 5]],
    ['revokeManual', h => [h]],
    ['initiatePaidSubscription', h => [h, 'low', 'o-low', purchaseOptions(SERVERS[0])]],
    ['cancelPaidSubscription', h => [h]],
    ['reactivatePaidSubscription', h => [h]],
    ['cancelPaidSubscriptionImmediately', h => [h]],
    ['cancelAndRemovePausedSubscription', h => [h, 'some-subscription']],
    ['adoptOrphan', h => [h, SELLER_ID, 'p1s_1']],
    ['linkAccount', h => [SELLER_ID, 'acct-1', h, BUYER]],
    ['unlinkProviderAccount', h => [h, SELLER_ID]],
    ['recordMigrationDecision', h => ['some-migration', h, 'accepted']],
    ['setNotificationsChannelId', h => [h, '70000000000000777']],
  ];
  const bad: Array<[unknown, string]> = [['5', '5'], ['Guild:5', 'Guild:5'], ['guild:g1', 'guild:g1'], ['guild:05', 'guild:05'], [5, '5']];
  const table = methods.flatMap(([method, args]) => bad.map(([holder, shown]) => [method, holder, shown, args] as const));

  it.each(table)('%s with %j answers X1 and stores nothing', async (method, holder, shown, args) => {
    // The server '5' holds a subscription, so a method that took the bare id for its key would find a record.
    expect(await w.grant(gh('5'), 'mid', 30)).toMatchObject({ ok: true });
    expect(await w.purchase(gh('5'), 'low')).toMatchObject({ ok: true });
    const before = state();

    const reply = await w.op(method, ...args(holder));

    expect(reply.ok).toBe(false);
    expect(reply.error).toContain(X1(shown));
    expect(state()).toEqual(before);
  });

  it('the 13 methods are the ones of PREMIUM_METHODS that take a holder', async () => {
    const { PREMIUM_METHODS } = await import('../../src/bot/internalSetup/utils/sharedOps');
    const without = ['setTier', 'deleteTier', 'setMessages', 'resetMessages', 'setGlobalModuleConfig', 'cancelOrphan', 'unlinkAccount', 'setProviderActivation', 'setMigrationSilencePolicy', 'scheduleMigration', 'cancelMigration'];
    expect([...PREMIUM_METHODS].filter(m => !without.includes(m)).sort()).toEqual(methods.map(([m]) => m).sort());
    expect(PREMIUM_METHODS).toHaveLength(24);
  });
});
