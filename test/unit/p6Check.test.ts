import fs from 'fs';
import { AsyncResource } from 'async_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';

// P6 claims 5 and 6 (sheet P6, section 10, part 2): the rounds that read Discord's entitlements to catch what the gateway
// events missed, under the two rules every round follows. THE END RULE: absence from a list never ends a Discord record;
// a record ends only on its update or delete event, a single read of it showing `deleted` or an `ends_at` passed, or
// two 404s for it at least an hour apart while this round's /applications/@me names the configured application. THE
// INSTALL RULE: a read installs whatever current entitlement it sees, an incomplete read only delays an install, and a
// read is never evidence against end evidence this process gained in the last two hours. Also claim 4's D16 row and
// E7's burst row (a round armed from an event leaves the handler's store; ten events during a round run one more), and
// decision 8's rows on the mirror rig, where the second process is another machine's write of premium-tiers.json.
// The real DiscordProvider and PremiumManager in the bot role, a real discord.js Client with the bridge attached, and
// the fake of helpers/p6Discord.ts as Discord (helpers/p6World.ts). Rows not about read lag set `staleReads` 0.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { dataPath } from '../../src/utils/dataRoot';
import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { acceptedOpsRunning, setMaintenanceGate, setOrderRefusal } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { PREMIUM_KEY } from '../helpers/nb6PremiumRig';
import { APP_ID, SECOND_APP_ID, SECOND_TOKEN, SKU, type DiscordSettings, type FakeEntitlement } from '../helpers/p6Discord';
import { GUILD, heldDiscord, p6World, USERS, type P6World } from '../helpers/p6World';
import { allowDropLines } from '../helpers/p1Guard';

const U = USERS[0];
const U2 = USERS[1];
const H = `user:${U}`;
const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;
const BACKENDS = [['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]] as const;
const S0: Partial<DiscordSettings> = { staleReads: 0 };

const PD1 = (id: string, sku: string) => `[DiscordProvider] Entitlement ${id} (SKU ${sku}) is for a server; this bot sells only user subscriptions through Discord, so no tier was given for it. Discord keeps billing it until it is cancelled or refunded in Discord.`;
const PD6 = "[DiscordProvider] Could not read the whole list of the app's entitlements from Discord (";
const PD7 = (id: string, uid: string) => `[DiscordProvider] Discord answered 404 for entitlement ${id} (user ${uid}) at two checks at least an hour apart, while this app's entitlements could be read; it was handed to premium as ended.`;
const PD8 = (id: string, uid: string, reason: string, n: number) => `[DiscordProvider] Could not read entitlement ${id} (user ${uid}) from Discord (${reason}); no change was made, and ${n} other held subscriptions were not read this round.`;
const PD10 = (id: string, who: string, uid: string) => `[DiscordProvider] Entitlement ${id} belongs to ${who} in Discord, but the bot holds it for user ${uid}; no change was made. Check the stored record.`;
const PD15 = (why: string, next: string) => `[DiscordProvider] The check stopped before it finished: ${why}. The next check runs ${next}.`;
const PD17 = (id: string, uid: string) => `[DiscordProvider] Discord answered 404 for entitlement ${id} (user ${uid}); its tier is kept. The bot ends it only if Discord answers 404 again at a check at least an hour later.`;
const PD18 = (id: string, uid: string, x: string, y: string) => `[DiscordProvider] Entitlement ${id} (user ${uid}) carries application ${x}, not the configured ${y}; the check does not read it, so only an end date the record already holds ends it. If ${y} is a typo, fix the configured application id; otherwise remove it on the dev page once that application no longer bills it.`;
const PD20 = (x: string, y: string) => `[DiscordProvider] The bot token belongs to application ${x}, but the configured application id is ${y}; this is likely a configuration error. The check reads nothing until they match.`;

const iso = (ms: number) => new Date(ms).toISOString();
/** A Discord user id of its own for each n. */
const user = (n: number): string => String(86500000000000100n + BigInt(n));

function helpers(w: P6World) {
  const h = {
    record: (holder = H): any => w.stored()?.subscriptions?.[holder] ?? null,
    heldOf: (id: string) => heldDiscord(w.stored()).find(x => x.sub.providerSubId === id) ?? null,
    calls: (route: string) => w.fake.calls.filter(c => c.route === route),
    singleCallsFor: (id: string) => w.fake.calls.filter(c => c.route === 'single' && c.path.split('?')[0].endsWith(`/${id}`)),
    started: () => w.notices().filter(n => n.kind === 'paid.sub.started').length,
    /** A purchase whose create event is delivered. */
    async buy(u: string, sku: string): Promise<FakeEntitlement> {
      const ent = w.fake.purchase(u, sku);
      await w.deliverAll();
      return ent;
    },
    /** A purchase whose create event is lost. */
    buyDropped(u: string, sku: string): FakeEntitlement {
      const ent = w.fake.purchase(u, sku);
      w.fake.drop(w.fake.queue.length - 1);
      return ent;
    },
    /** `n` entitlements that ended an hour ago, each a user's of its own, with no event left queued. */
    endedHistory(n: number, from = 1000): void {
      for (let i = 0; i < n; i++) w.fake.endAt(w.fake.purchase(user(from + i), SKU.A), Date.now() - HOUR);
      w.fake.queue.length = 0;
    },
  };
  return h;
}

/** The log lines of the round(s) a call ran: what was logged after `at`. */
const linesSince = (w: P6World, at: number): string[] => w.logs.slice(at);

describe.each(BACKENDS)('P6 part 2, claim 5 on %s: rounds install what events missed and save nothing when quiet', (_name, backend) => {
  const w = p6World(backend);
  const h = helpers(w);
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it('K1: a purchase whose create event was dropped is installed by the next round', async () => {
    await w.setup({ settings: S0 });
    const a = h.buyDropped(U, SKU.A);
    expect(h.heldOf(a.id)).toBeNull();
    await w.round();
    expect(h.record()?.active).toMatchObject({ tierId: 'vip', offeringId: 'o-a', providerSubId: a.id, status: 'active', endDate: null, autoRenew: true, providerMeta: { applicationId: APP_ID } });
    expect(h.started()).toBe(1);
    expect(w.fake.unexpected).toEqual([]);
  });

  it('K1: the round 30 seconds after a restart installs a purchase made while the bot was down', async () => {
    await w.setup({ settings: S0 });
    await w.advance(31 * SEC);
    const a = h.buyDropped(U, SKU.A);
    await w.restart();
    const restarted = Date.now();
    await w.advance(29 * SEC);
    expect(h.heldOf(a.id)).toBeNull();
    await w.advance(2 * SEC);
    expect(h.heldOf(a.id)?.location).toBe('active');
    const after = h.calls('me').filter(c => c.at >= restarted);
    expect(after.length).toBe(1);
    expect(after[0].at - restarted).toBeGreaterThanOrEqual(30 * SEC);
  });

  it('K2: a quiet round with one active and one queued Discord record emits nothing and saves nothing', async () => {
    await w.setup({ settings: { ...S0, cancelShowsEndsAt: true } });
    const a = await h.buy(U, SKU.A);
    const b = await h.buy(U, SKU.B);
    const c = await h.buy(U2, SKU.A);
    w.fake.memberCancel(c);
    expect([h.heldOf(a.id)?.location, h.heldOf(b.id)?.location]).toEqual(['paused', 'active']);
    await w.round();
    expect(h.heldOf(c.id)?.sub).toMatchObject({ endDate: iso(c.endsAt!), autoRenew: false });
    const text = w.storedText();
    const emitted = w.emitted.length;
    const save = vi.spyOn(getPremiumManager() as any, 'save');
    await w.round();
    await w.round();
    expect(save).not.toHaveBeenCalled();
    expect(w.storedText()).toBe(text);
    expect(w.emitted.slice(emitted)).toEqual([]);
  });

  it("K3: a refund whose delete event was dropped ends at the next round under R3 '200'", async () => {
    await w.setup({ settings: { ...S0, deletedRead: '200' } });
    const a = await h.buy(U, SKU.A);
    w.fake.refund(a);
    w.fake.drop(0);
    await w.round();
    expect(h.heldOf(a.id)).toBeNull();
    expect(w.notices().map(n => n.kind)).toEqual(['paid.sub.started', 'paid.sub.expired']);
    expect(w.logged('[DiscordProvider] Discord answered 404')).toEqual([]);
  });

  it('E7: a burst of ten update events during a round runs one more round, not ten', async () => {
    await w.setup({ settings: { ...S0, updateEndsAt: 'past' } });
    await w.advance(31 * SEC);
    const ents: FakeEntitlement[] = [];
    for (let i = 1; i <= 10; i++) ents.push(await h.buy(user(i), SKU.A));
    const held = w.fake.holdAnswer('list');
    const round = w.provider.checkNow();
    await held.reached;
    for (const e of ents) w.fake.endAt(e, w.fake.updateEnd());
    await w.deliverAll();
    held.release();
    await round;
    await w.settle();
    const mes = h.calls('me').length;
    await w.advance(10 * MIN);
    expect(h.calls('me').length).toBe(mes + 1);
  });
});

/** Runs fn once, at the first lock read of `key` in the mirror rig (its op's transaction holds the key's lock then). */
function atLockRead(w: P6World, key: string, fn: () => void): { fired: () => boolean } {
  let done = false;
  w.rig!.m.state.rows.fault = async (sql: string, params?: unknown[]) => {
    if (!done && sql.startsWith('SELECT body, sha, updated_by, updated_at FROM smdb_data.shared_docs') && params?.[0] === key) {
      done = true;
      fn();
    }
    return undefined;
  };
  return { fired: () => done };
}

describe.each([
  ['its own copy of the create event (R7 every)', 'event' as const],
  ['its next round only (R7 one)', 'round' as const],
])('P6 part 2, decision 8 on the mirror rig: another machine installs a purchase first, and this process meets it through %s', (_how, path) => {
  const w = p6World('rig');
  const h = helpers(w);
  afterEach(async () => {
    if (w.rig) w.rig.m.state.rows.fault = undefined;
    await w.teardown();
    vi.restoreAllMocks();
  });

  it('the save over the other machine\'s install is refused as changed elsewhere and the re-hand finds the record held: one record, one paid.sub.started, no refusal line', async () => {
    await w.setup({ settings: S0 });
    const rows = w.rig!.m.state.rows;
    const before = w.storedText()!;
    const a = w.fake.purchase(U, SKU.A);
    const copy = structuredClone(w.fake.queue[w.fake.queue.length - 1]);
    await w.deliverAll();
    const installed = w.storedText()!;
    const theirs = heldDiscord(JSON.parse(installed));
    expect(theirs.map(x => x.sub.providerSubId)).toEqual([a.id]);
    rows.put(PREMIUM_KEY, before);
    await runSharedPass();
    await w.restart();
    expect(getPremiumManager().getAllSubscriptions()[H as any]).toBeUndefined();
    const lock = atLockRead(w, PREMIUM_KEY, () => rows.put(PREMIUM_KEY, installed, 'BRAVO/p-bravo'));
    const lines = w.logs.length;
    if (path === 'event') {
      w.fake.queue.push(copy);
      await w.deliverAll();
    } else {
      await w.round();
    }
    const pm = getPremiumManager() as unknown as { openWork(): string | null };
    for (let i = 0; i < 120 && pm.openWork() !== null; i++) await w.advance(SEC);
    expect(pm.openWork()).toBeNull();
    expect(lock.fired()).toBe(true);
    const held = heldDiscord(w.stored());
    expect(held.map(x => [x.holder, x.location, x.sub.id])).toEqual([[H, 'active', theirs[0].sub.id]]);
    expect(h.started()).toBe(1);
    expect(linesSince(w, lines).filter(l => l.startsWith('[PremiumManager] subscription.created') || l.includes('could not be applied'))).toEqual([]);
  });
});

describe('P6 part 2, claims 5 and 6: rounds (the JSON files)', () => {
  const w = p6World('json');
  const h = helpers(w);
  afterEach(async () => {
    setMaintenanceGate(null);
    setOrderRefusal(false);
    await w.teardown();
    vi.restoreAllMocks();
  });

  it("K4: under R3 '404' the first round keeps the refunded record (PD17), a round 30 minutes later keeps it, the round 60 minutes after the first ends it (PD7)", async () => {
    await w.setup({ settings: { ...S0, deletedRead: '404' } });
    const a = await h.buy(U, SKU.A);
    w.fake.refund(a);
    w.fake.drop(0);
    const first = Date.now();
    await w.round();
    expect(h.heldOf(a.id)?.location).toBe('active');
    expect(w.logged(PD17(a.id, U)).length).toBeGreaterThanOrEqual(1);
    await w.advance(30 * MIN);
    await w.round();
    expect(h.heldOf(a.id)?.location).toBe('active');
    expect(w.logged(PD7(a.id, U))).toEqual([]);
    await w.advance(first + 60 * MIN - Date.now());
    await w.round();
    expect(h.heldOf(a.id)).toBeNull();
    expect(w.logged(PD7(a.id, U))).toHaveLength(1);
  });

  it('K5: R2 true shows a cancel as an end the next round writes, and a resume before the end clears it', async () => {
    await w.setup({ settings: { ...S0, cancelShowsEndsAt: true } });
    const a = await h.buy(U, SKU.A);
    w.fake.memberCancel(a);
    await w.round();
    expect(h.record().active).toMatchObject({ providerSubId: a.id, status: 'active', endDate: iso(a.endsAt!), autoRenew: false });
    w.fake.memberResume(a);
    await w.round();
    expect(h.record().active).toMatchObject({ providerSubId: a.id, status: 'active', endDate: null, autoRenew: true });
  });

  it('K5: R2 false shows nothing of a cancel or a resume, and rounds change nothing', async () => {
    await w.setup({ settings: { ...S0, cancelShowsEndsAt: false } });
    const a = await h.buy(U, SKU.A);
    const text = w.storedText();
    w.fake.memberCancel(a);
    await w.round();
    w.fake.memberResume(a);
    await w.round();
    expect(w.storedText()).toBe(text);
  });

  it('K6: R4 true: a test entitlement with no event (R9 false) is installed from the list, with now as its start', async () => {
    await w.setup({ settings: { ...S0, listsTests: true, testEvents: false } });
    const t = w.fake.testGrant({ userId: U }, SKU.A);
    expect(w.fake.queue).toEqual([]);
    await w.round();
    expect(h.record()?.active).toMatchObject({ providerSubId: t.id, status: 'active', endDate: null });
    expect(Math.abs(Date.parse(h.record().active.startDate) - Date.now())).toBeLessThan(MIN);
  });

  it('K6: R4 false and R9 false: a test entitlement is never installed (the accepted limit)', async () => {
    await w.setup({ settings: { ...S0, listsTests: false, testEvents: false } });
    const t = w.fake.testGrant({ userId: U }, SKU.A);
    await w.round();
    await w.advance(61 * MIN);
    await w.round();
    expect(h.heldOf(t.id)).toBeNull();
  });

  it("K6: R9 true installs a test entitlement from its event and ends it on its delete; R9 false with R4 true ends a deleted one at the next round under R3 '200'", async () => {
    await w.setup({ settings: { ...S0, listsTests: false, testEvents: true } });
    const t = w.fake.testGrant({ userId: U }, SKU.A);
    await w.deliverAll();
    expect(h.heldOf(t.id)?.location).toBe('active');
    w.fake.deleteTest(t);
    await w.deliverAll();
    expect(h.heldOf(t.id)).toBeNull();
    await w.teardown();
    await w.setup({ settings: { ...S0, listsTests: true, testEvents: false, deletedRead: '200' } });
    const t2 = w.fake.testGrant({ userId: U }, SKU.A);
    await w.round();
    expect(h.heldOf(t2.id)?.location).toBe('active');
    w.fake.deleteTest(t2);
    expect(w.fake.queue).toEqual([]);
    await w.round();
    expect(h.heldOf(t2.id)).toBeNull();
  });

  it("K7: a dropped create, then the member's cancel shown as ends_at (R2 true, R5 'any'): the next round installs it with endDate ends_at", async () => {
    await w.setup({ settings: { ...S0, cancelShowsEndsAt: true, excludeEnded: 'any' } });
    const a = h.buyDropped(U, SKU.A);
    w.fake.memberCancel(a);
    await w.round();
    expect(h.record()?.active).toMatchObject({ providerSubId: a.id, status: 'active', endDate: iso(a.endsAt!), autoRenew: false });
    const lists = h.calls('list');
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.every(c => new URLSearchParams(c.path.split('?')[1]).get('exclude_ended') === 'false')).toBe(true);
  });

  it('K8b: with 6000 entitlements a recent purchase whose event was dropped is installed at the first round', async () => {
    await w.setup({ settings: S0 });
    h.endedHistory(5999);
    const a = h.buyDropped(U, SKU.A);
    await w.round();
    expect(h.heldOf(a.id)?.location).toBe('active');
    expect(w.logged(PD6)).toHaveLength(1);
    expect(h.calls('list').length).toBe(50);
  }, 120_000);

  it('K8: a page that holds an id on the wrong side of its cursor makes the read incomplete (PD6); what was seen is installed', async () => {
    await w.setup({ settings: S0 });
    const ents: FakeEntitlement[] = [];
    for (let i = 0; i < 250; i++) ents.push(w.fake.purchase(user(i), SKU.A));
    for (const [i, e] of ents.entries()) if (i < 240) w.fake.endAt(e, Date.now() - HOUR);
    w.fake.queue.length = 0;
    const newest = ents[249];
    w.fake.editListPages((page, query) => {
      const before = query.get('before');
      return before !== null && w.fake.entitlements.has(before) ? [...page, w.fake.jsonOf(newest)] : page;
    });
    await w.round();
    expect(w.logged(PD6)).toHaveLength(1);
    for (const e of ents.slice(240)) expect(h.heldOf(e.id)?.location).toBe('active');
  });

  it('K9: a round is skipped, with no call, when Discord is not configured (and logs nothing), with the gate closed, with an order holding, and with premium unreadable', async () => {
    await w.setup({ settings: S0 });
    await w.advance(31 * SEC);
    const lines = w.logs.length;
    const calls = w.fake.calls.length;
    w.setCredentials({ applicationId: undefined });
    await w.round();
    expect(w.fake.calls.length).toBe(calls);
    expect(linesSince(w, lines).filter(l => l.includes('[DiscordProvider]'))).toEqual([]);
    w.setCredentials({ applicationId: APP_ID });
    setMaintenanceGate({ cause: 'hook', message: 'Down for a moment.' });
    await w.round();
    setMaintenanceGate(null);
    setOrderRefusal(true);
    await w.round();
    setOrderRefusal(false);
    const good = w.storedText()!;
    fs.writeFileSync(dataPath('global', 'premium-tiers.json'), '{ not json');
    getPremiumManager().invalidate();
    getPremiumManager().getAllTiers();
    expect(getPremiumManager().cacheState()).toBe('unreadable');
    await w.round();
    expect(w.fake.calls.length).toBe(calls);
    expect(linesSince(w, lines).filter(l => l.includes('[DiscordProvider]'))).toEqual([]);
    fs.writeFileSync(dataPath('global', 'premium-tiers.json'), good);
    getPremiumManager().invalidate();
  });

  it('K9: a timed round skipped while the gate is closed arms the next one 5 minutes later', async () => {
    await w.setup({ settings: S0 });
    setMaintenanceGate({ cause: 'hook', message: 'Down for a moment.' });
    const at = Date.now();
    await w.advance(31 * SEC);
    expect(h.calls('me')).toEqual([]);
    setMaintenanceGate(null);
    await w.advance(at + 30 * SEC + 5 * MIN - 2 * SEC - Date.now());
    expect(h.calls('me')).toEqual([]);
    await w.advance(4 * SEC);
    expect(h.calls('me')).toHaveLength(1);
  });

  it('K10: a pre-P6 guild: Discord record is never changed by a round', async () => {
    await w.setup({ settings: S0 });
    const donor = await h.buy(U2, SKU.A);
    const g = w.fake.purchase(U, SKU.A, { guildId: GUILD });
    w.fake.queue.length = 0;
    const doc = w.stored();
    const old = structuredClone(doc.subscriptions[`user:${U2}`].active);
    Object.assign(old, { id: `${old.id.slice(0, -1)}${old.id.endsWith('0') ? '1' : '0'}`, tierId: 'gold', offeringId: 'o-g', providerSubId: g.id, buyerId: U, providerMeta: { skuId: SKU.A, type: 8 } });
    doc.subscriptions[`guild:${GUILD}`] = { active: old, paused: [] };
    expect(donor.id).not.toBe(g.id);
    fs.writeFileSync(dataPath('global', 'premium-tiers.json'), JSON.stringify(doc, null, 2));
    getPremiumManager().invalidate();
    const before = JSON.stringify(getPremiumManager().getAllSubscriptions()[`guild:${GUILD}` as any]);
    await w.round();
    w.fake.refund(g);
    w.fake.queue.length = 0;
    await w.advance(61 * MIN);
    await w.round();
    expect(JSON.stringify(getPremiumManager().getAllSubscriptions()[`guild:${GUILD}` as any])).toBe(before);
    expect(h.singleCallsFor(g.id)).toEqual([]);
    expect(w.logged(PD1(g.id, SKU.A))).toHaveLength(1);
  });

  it("K11 (D4): the list's answer made before a refund's delete is applied does not reinstall the refunded record", async () => {
    await w.setup({ settings: S0 });
    const a = await h.buy(U, SKU.A);
    const held = w.fake.holdAnswer('list');
    const round = w.provider.checkNow();
    await held.reached;
    w.fake.refund(a);
    await w.deliverAll();
    expect(h.heldOf(a.id)).toBeNull();
    held.release();
    await round;
    await w.settle();
    expect(h.heldOf(a.id)).toBeNull();
    expect(h.started()).toBe(1);
  });

  it("K11 (D4): a single read's answer made before an update event is applied does not undo the update's end", async () => {
    await w.setup({ settings: { ...S0, updateEndsAt: 'future' } });
    const a = await h.buy(U, SKU.A);
    w.fake.hiddenFromList.add(a.id);
    const held = w.fake.holdAnswer('single');
    const round = w.provider.checkNow();
    await held.reached;
    const end = w.fake.updateEnd();
    w.fake.endAt(a, end);
    await w.deliverAll();
    expect(h.record().active).toMatchObject({ endDate: iso(end), autoRenew: false });
    held.release();
    await round;
    await w.settle();
    expect(h.record().active).toMatchObject({ endDate: iso(end), autoRenew: false });
  });

  it.each([
    ['the gate closing', () => setMaintenanceGate({ cause: 'hook', message: 'Down for a moment.' }), 'the bot entered maintenance'],
    ['an order arriving', () => setOrderRefusal(true), 'a save order holds'],
  ])('K12 (D5): %s between two calls stops the round before the next call (PD15), and the next check runs 5 minutes later', async (_what, close, why) => {
    await w.setup({ settings: S0 });
    await h.buy(U, SKU.A);
    await w.advance(31 * SEC);
    const lists = h.calls('list').length;
    const held = w.fake.hold('me');
    const round = w.provider.checkNow();
    await held.reached;
    close();
    held.release();
    await round;
    expect(h.calls('list').length).toBe(lists);
    expect(w.logged(PD15(why, 'within 5 minutes'))).toHaveLength(1);
    expect(acceptedOpsRunning()).toBe(0);
    setMaintenanceGate(null);
    setOrderRefusal(false);
    const mes = h.calls('me').length;
    await w.advance(5 * MIN - 2 * SEC);
    expect(h.calls('me').length).toBe(mes);
    await w.advance(4 * SEC);
    expect(h.calls('me').length).toBe(mes + 1);
  });

  it('K12 (D5): with every single read held to its timeout, 3b makes one call and logs one PD8', async () => {
    await w.setup({ settings: S0 });
    await w.advance(31 * SEC);
    const ents = [await h.buy(user(1), SKU.A), await h.buy(user(2), SKU.A), await h.buy(user(3), SKU.A)];
    for (const e of ents) w.fake.hiddenFromList.add(e.id);
    w.fake.fail('single', { noAnswer: true }, 100);
    const singles = h.calls('single').length;
    expect(await w.roundAdvancing(2 * MIN)).toBe(true);
    expect(h.calls('single').length - singles).toBe(1);
    const pd8 = w.logged('[DiscordProvider] Could not read entitlement');
    expect(pd8).toHaveLength(1);
    expect(pd8[0]).toBe(PD8(ents[0].id, user(1), 'no answer within 30 seconds', 2));
    expect(acceptedOpsRunning()).toBe(0);
    for (const e of ents) expect(h.heldOf(e.id)?.location).toBe('active');
  });

  it('K12 (D5): a round that reaches 5 minutes stops with PD15 and the next check is the hourly one', async () => {
    await w.setup({ settings: S0 });
    await w.advance(31 * SEC);
    const ents: FakeEntitlement[] = [];
    for (let i = 1; i <= 12; i++) ents.push(await h.buy(user(i), SKU.A));
    for (const e of ents) w.fake.hiddenFromList.add(e.id);
    w.fake.slow('single', 29 * SEC, 100);
    expect(await w.roundAdvancing(10 * MIN)).toBe(true);
    expect(w.logged(PD15('it ran for 5 minutes', 'within an hour'))).toHaveLength(1);
    expect(h.calls('single').length).toBeLessThan(12);
    expect(acceptedOpsRunning()).toBe(0);
  });

  it('K12 (D5, E5): a round whose 3b ended a record and that then reaches 5 minutes says the next check runs within a minute, and one runs 30 seconds after it', async () => {
    await w.setup({ settings: { ...S0, deletedRead: '200' } });
    await w.advance(31 * SEC);
    const ents: FakeEntitlement[] = [];
    for (let i = 1; i <= 12; i++) ents.push(await h.buy(user(i), SKU.A));
    for (const e of ents) w.fake.hiddenFromList.add(e.id);
    w.fake.refund(ents[0]);
    w.fake.drop(0);
    w.fake.slow('single', 29 * SEC, 100);
    expect(await w.roundAdvancing(10 * MIN)).toBe(true);
    expect(h.heldOf(ents[0].id)).toBeNull();
    expect(w.logged(PD15('it ran for 5 minutes', 'within a minute'))).toHaveLength(1);
    const ended = Date.now();
    const mes = h.calls('me').length;
    await w.advance(31 * SEC);
    expect(h.calls('me').length).toBe(mes + 1);
    expect(h.calls('me')[mes].at - ended).toBeLessThanOrEqual(31 * SEC);
  });

  it('K12 (4.4): after the first round the next one runs 60 minutes later with no event, and ends a refund whose delete event was dropped', async () => {
    await w.setup({ settings: { ...S0, deletedRead: '200' } });
    await w.advance(31 * SEC);
    const first = h.calls('me');
    expect(first).toHaveLength(1);
    const a = await h.buy(U, SKU.A);
    w.fake.refund(a);
    w.fake.drop(0);
    await w.advance(first[0].at + 59 * MIN - Date.now());
    expect(h.calls('me')).toHaveLength(1);
    expect(h.heldOf(a.id)?.location).toBe('active');
    await w.advance(2 * MIN);
    expect(h.heldOf(a.id)).toBeNull();
    const hourly = h.calls('me')[1];
    expect(hourly.at - first[0].at).toBeGreaterThanOrEqual(60 * MIN);
    expect(hourly.at - first[0].at).toBeLessThan(60 * MIN + 2 * SEC);
  });

  it('K15 (D18): update events 10 seconds apart with no round running get one round, 30 seconds after the first event', async () => {
    await w.setup({ settings: S0 });
    await w.advance(31 * SEC);
    const ents = [await h.buy(user(1), SKU.A), await h.buy(user(2), SKU.A), await h.buy(user(3), SKU.A)];
    const mes = h.calls('me').length;
    const t0 = Date.now();
    for (const [i, e] of ents.entries()) {
      if (i > 0) await w.advance(10 * SEC);
      w.fake.endAt(e, Date.now() + 24 * HOUR);
      await w.deliverAll();
    }
    await w.advance(t0 + 29 * SEC - Date.now());
    expect(h.calls('me').length).toBe(mes);
    await w.advance(2 * SEC);
    expect(h.calls('me').length).toBe(mes + 1);
    await w.advance(40 * SEC);
    expect(h.calls('me').length).toBe(mes + 1);
  });

  it('K13 (D15): a held record whose single read always answers 403, first in stored order, does not keep a later refunded record from ending within two rounds', async () => {
    await w.setup({ settings: { ...S0, deletedRead: '200' } });
    const x = await h.buy(U, SKU.A);
    const y = await h.buy(U2, SKU.A);
    w.fake.hiddenFromList.add(x.id);
    w.fake.fail(new RegExp(`/entitlements/${x.id}$`), { status: 403 }, 100);
    w.fake.refund(y);
    w.fake.drop(0);
    await w.round();
    await w.round();
    expect(h.heldOf(y.id)).toBeNull();
    expect(h.heldOf(x.id)?.location).toBe('active');
  });

  it('K13 (D15): a held record whose single read never answers, first in stored order, does not keep a later refunded record from ending within two rounds', async () => {
    await w.setup({ settings: { ...S0, deletedRead: '200' } });
    const x = await h.buy(U, SKU.A);
    const y = await h.buy(U2, SKU.A);
    w.fake.hiddenFromList.add(x.id);
    w.fake.fail(new RegExp(`/entitlements/${x.id}$`), { noAnswer: true }, 100);
    w.fake.refund(y);
    w.fake.drop(0);
    expect(await w.roundAdvancing(2 * MIN)).toBe(true);
    expect(w.logged(PD8(x.id, U, 'no answer within 30 seconds', 1)).length).toBeGreaterThanOrEqual(1);
    expect(await w.roundAdvancing(2 * MIN)).toBe(true);
    expect(h.heldOf(y.id)).toBeNull();
    expect(h.heldOf(x.id)?.location).toBe('active');
  });

  it('K13 (D15): with step 1 slowed past 3 minutes the read is incomplete, and 3a and 3b still run', async () => {
    await w.setup({ settings: { ...S0, deletedRead: '200' } });
    await w.advance(31 * SEC);
    const x = await h.buy(U, SKU.A);
    const y = await h.buy(U2, SKU.A);
    h.endedHistory(1200);
    w.fake.refund(y);
    w.fake.drop(0);
    w.fake.slow('list', 29 * SEC, 1000);
    expect(await w.roundAdvancing(10 * MIN)).toBe(true);
    expect(w.logged(PD6)).toHaveLength(1);
    expect(h.heldOf(y.id)).toBeNull();
    expect(h.heldOf(x.id)?.location).toBe('active');
  }, 120_000);

  it("K14 (D19): with R1 future, a same-priority create refused while the old record held the slot is installed within 31 seconds of the old one's ends_at", async () => {
    allowDropLines('L3');
    await w.setup({ settings: { ...S0, updateEndsAt: 'future', upgradeOrder: 'create-first' } });
    await w.advance(31 * SEC);
    const a = await h.buy(U, SKU.A);
    const a2 = w.fake.upgrade(a, SKU.A2);
    const end = a.endsAt!;
    await w.deliverAll();
    expect(h.record().active).toMatchObject({ providerSubId: a.id, endDate: iso(end) });
    await w.advance(end + 29 * SEC - Date.now());
    expect(h.heldOf(a2.id)).toBeNull();
    await w.advance(2 * SEC);
    expect(h.heldOf(a2.id)?.location).toBe('active');
    expect(Date.parse(h.heldOf(a2.id)!.sub.createdAt) - end).toBeLessThanOrEqual(31 * SEC);
  });

  it("K15 (D18): an update that arrives while a round runs gets its round 30 seconds after that round ends", async () => {
    await w.setup({ settings: { ...S0, updateEndsAt: 'past' } });
    await w.advance(31 * SEC);
    await h.buy(U, SKU.A);
    const b = await h.buy(U2, SKU.A);
    const held = w.fake.holdAnswer('list');
    const round = w.provider.checkNow();
    await held.reached;
    w.fake.endAt(b, w.fake.updateEnd());
    await w.deliverAll();
    await w.advance(10 * SEC);
    held.release();
    await round;
    await w.settle();
    const ended = Date.now();
    const mes = h.calls('me').length;
    await w.advance(29 * SEC);
    expect(h.calls('me').length).toBe(mes);
    await w.advance(2 * SEC);
    expect(h.calls('me').length).toBe(mes + 1);
    expect(h.calls('me')[mes].at - ended).toBeGreaterThanOrEqual(30 * SEC);
  });

  it("K16 (E3, R12): a refund's delete, then the post-event round's stale list: no reinstall and no second paid.sub.started", async () => {
    await w.setup({ settings: { staleReads: 40 } });
    await w.advance(41 * SEC);
    const a = await h.buy(U, SKU.A);
    await w.advance(41 * SEC);
    w.fake.refund(a);
    await w.deliverAll();
    expect(h.heldOf(a.id)).toBeNull();
    await w.advance(31 * SEC);
    expect(h.calls('list').some(c => c.at > a.history[0].at + 41 * SEC)).toBe(true);
    expect(h.heldOf(a.id)).toBeNull();
    expect(h.started()).toBe(1);
  });

  it('K17 (E3, R12): an update with ends_at T ahead, then a stale read showing null: endDate stays T and the checker ends it at T', async () => {
    await w.setup({ settings: { staleReads: 40, updateEndsAt: 'future' } });
    await w.advance(41 * SEC);
    const a = await h.buy(U, SKU.A);
    await w.advance(41 * SEC);
    const end = w.fake.updateEnd();
    w.fake.endAt(a, end);
    await w.deliverAll();
    await w.advance(31 * SEC);
    expect(h.record()?.active).toMatchObject({ providerSubId: a.id, endDate: iso(end), autoRenew: false });
    await w.advance(end + MIN - Date.now());
    expect(h.heldOf(a.id)).toBeNull();
  });

  it.each(['past', 'future'] as const)('K18 (E3, R12): a same-priority upgrade with stale reads, R1 %s: the old record is not reinstalled and the new one is installed', async r1 => {
    allowDropLines('L3');
    await w.setup({ settings: { staleReads: 40, updateEndsAt: r1, upgradeOrder: 'create-first' } });
    await w.advance(41 * SEC);
    const a = await h.buy(U, SKU.A);
    await w.advance(41 * SEC);
    const a2 = w.fake.upgrade(a, SKU.A2);
    await w.deliverAll();
    const starts = h.started();
    await w.advance(62 * MIN);
    expect(h.heldOf(a.id)).toBeNull();
    expect(h.heldOf(a2.id)?.location).toBe('active');
    expect(h.started()).toBe(starts + 1);
  });

  it('K18 (E15): an update whose ends_at T was ahead and has passed: a stale read showing the entitlement current does not reinstall it', async () => {
    allowDropLines('L3');
    await w.setup({ settings: { staleReads: 600, updateEndsAt: 'future', upgradeOrder: 'create-first' } });
    await w.advance(11 * MIN);
    const a = await h.buy(U, SKU.A);
    await w.advance(11 * MIN);
    const a2 = w.fake.upgrade(a, SKU.A2);
    const end = a.endsAt!;
    await w.deliverAll();
    await w.advance(end + 2 * MIN - Date.now());
    expect(h.heldOf(a.id)).toBeNull();
    await w.round();
    expect(h.heldOf(a.id)).toBeNull();
    await w.advance(10 * MIN);
    await w.round();
    expect(h.heldOf(a.id)).toBeNull();
    expect(h.heldOf(a2.id)?.location).toBe('active');
  });

  it("K19 (E6): a test entitlement (no dates) is installed from a read; read as deleted with no dates under R3 '200' it ends with endDate now", async () => {
    await w.setup({ settings: { ...S0, listsTests: true, testEvents: false, deletedRead: '200' } });
    const t = w.fake.testGrant({ userId: U }, SKU.A);
    await w.round();
    expect(h.heldOf(t.id)?.location).toBe('active');
    w.fake.deleteTest(t);
    const at = Date.now();
    await w.round();
    expect(h.heldOf(t.id)).toBeNull();
    const expired = w.emitted.filter(e => e.type === 'subscription.expired' && e.providerSubId === t.id);
    expect(expired).toHaveLength(1);
    expect(Math.abs(Date.parse(expired[0].state.endDate) - at)).toBeLessThan(MIN);
  });

  it("K19 (E6): a delete event whose ends_at does not parse, through discord.js's action, ends the record", async () => {
    await w.setup({ settings: S0 });
    const a = await h.buy(U, SKU.A);
    w.fake.queue.push({ name: 'entitlementDelete', data: { ...w.fake.jsonOf(a), deleted: true, ends_at: 'never' }, entitlementId: a.id, queuedAt: Date.now() });
    await w.deliverAll();
    expect(h.heldOf(a.id)).toBeNull();
  });

  it("U1b (E5): a same-priority upgrade whose old update was dropped: the round whose 3b ends the old record arms one 30 seconds later, which installs the new one", async () => {
    allowDropLines('L3');
    await w.setup({ settings: { ...S0, updateEndsAt: 'past', upgradeOrder: 'create-first', deletedRead: '200' } });
    await w.advance(31 * SEC);
    const a = await h.buy(U, SKU.A);
    const a2 = w.fake.upgrade(a, SKU.A2);
    w.fake.deliver(0);
    w.fake.drop(0);
    await w.settle();
    expect(h.record().active.providerSubId).toBe(a.id);
    await w.round();
    expect(h.heldOf(a.id)).toBeNull();
    expect(h.heldOf(a2.id)).toBeNull();
    await w.advance(31 * SEC);
    expect(h.heldOf(a2.id)?.location).toBe('active');
  });

  it('K20 (E10, R13): an entitlement an update ended and that becomes current again is left out for two hours, then installed', async () => {
    await w.setup({ settings: { ...S0, updateEndsAt: 'past' } });
    const a = await h.buy(U, SKU.A);
    w.fake.endAt(a, w.fake.updateEnd());
    await w.deliverAll();
    const ended = Date.now();
    expect(h.heldOf(a.id)).toBeNull();
    w.fake.revive(a);
    await w.round();
    await w.advance(ended + 119 * MIN - Date.now());
    await w.round();
    expect(h.heldOf(a.id)).toBeNull();
    await w.advance(2 * MIN);
    await w.round();
    expect(h.heldOf(a.id)?.location).toBe('active');
  });

  it('K20 (E10, R13): an entitlement a delete ended and that becomes current again is never installed again by this process', async () => {
    await w.setup({ settings: S0 });
    const a = await h.buy(U, SKU.A);
    w.fake.refund(a);
    await w.deliverAll();
    w.fake.revive(a);
    await w.advance(3 * HOUR);
    await w.round();
    expect(h.heldOf(a.id)).toBeNull();
  });

  it.each([
    ['500', { status: 500 }, 'Discord answered 500'],
    ['429', { status: 429 }, 'Discord answered 429'],
    ['no answer', { noAnswer: true }, 'no answer within 30 seconds'],
    ['a body that is not JSON', { body: 'text' }, 'the answer was not an entitlement'],
  ] as const)('N1: a held record absent from a complete list whose single read fails (%s) stays, round after round', async (_what, fault, reason) => {
    await w.setup({ settings: { ...S0, deletedRead: '404' } });
    const a = await h.buy(U, SKU.A);
    w.fake.refund(a);
    w.fake.drop(0);
    w.fake.fail('single', fault as any, 1000);
    for (let i = 0; i < 3; i++) {
      expect(await w.roundAdvancing(2 * MIN)).toBe(true);
      expect(h.heldOf(a.id)?.location).toBe('active');
      await w.advance(61 * MIN);
    }
    expect(h.heldOf(a.id)?.location).toBe('active');
    expect(w.logged(PD8(a.id, U, reason, 0)).length).toBeGreaterThanOrEqual(3);
    expect(w.logged(PD6)).toEqual([]);
  });

  it('N2: an incomplete list ends nothing: records it did not show stay while their single reads show them current', async () => {
    await w.setup({ settings: S0 });
    const a = await h.buy(U, SKU.A);
    h.endedHistory(150);
    const real = w.fake.fetch.bind(w.fake);
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const query = new URL(String(url)).searchParams;
      const later = query.has('after') || (query.has('before') && w.fake.entitlements.has(query.get('before')!));
      if (String(url).includes('/entitlements?') && later) return new Response(JSON.stringify({ message: 'Internal Server Error', code: 0 }), { status: 500 });
      return real(String(url), init);
    }));
    await w.round();
    await w.advance(61 * MIN);
    await w.round();
    expect(w.logged(PD6).length).toBeGreaterThanOrEqual(2);
    expect(h.heldOf(a.id)?.location).toBe('active');
    expect(h.singleCallsFor(a.id).length).toBeGreaterThanOrEqual(2);
  });

  it('N3: a single read naming another user changes nothing and logs PD10', async () => {
    await w.setup({ settings: S0 });
    const a = await h.buy(U, SKU.A);
    const text = w.storedText();
    w.fake.reassign(a, U2);
    await w.round();
    expect(w.storedText()).toBe(text);
    expect(w.logged(PD10(a.id, `user ${U2}`, U))).toHaveLength(1);
    w.fake.reassign(a, null, GUILD);
    await w.round();
    expect(w.storedText()).toBe(text);
    expect(w.logged(PD10(a.id, 'a server', U))).toHaveLength(1);
  });

  it('G1: DISCORD_APPLICATION_ID changed between the two 404 rounds: nothing ends, and those records are not read again (PD18 once)', async () => {
    await w.setup({ settings: { ...S0, deletedRead: '404' } });
    const a = await h.buy(U, SKU.A);
    w.fake.refund(a);
    w.fake.drop(0);
    await w.round();
    expect(w.logged(PD17(a.id, U))).toHaveLength(1);
    const second = w.fake.rotateApp();
    w.setCredentials({ applicationId: second.applicationId, token: second.token });
    const reads = h.singleCallsFor(a.id).length;
    for (let i = 0; i < 3; i++) {
      await w.advance(61 * MIN);
      await w.round();
    }
    expect(h.heldOf(a.id)?.location).toBe('active');
    expect(h.singleCallsFor(a.id).length).toBe(reads);
    expect(w.logged(PD18(a.id, U, APP_ID, SECOND_APP_ID))).toHaveLength(1);
  });

  it.each(['401', '403', '404', '200-empty'] as const)("G2: the token switched to another application with the old application id left configured (foreignApp '%s'): /applications/@me names another id, nothing ends, the round stops after @me with PD20", async foreignApp => {
    await w.setup({ settings: { ...S0, deletedRead: '404', foreignApp } });
    const a = await h.buy(U, SKU.A);
    const b = await h.buy(U2, SKU.A);
    w.fake.refund(b);
    w.fake.drop(0);
    w.fake.rotateApp();
    w.setCredentials({ token: SECOND_TOKEN });
    const lists = h.calls('list').length;
    const singles = h.calls('single').length;
    for (let i = 0; i < 4; i++) {
      await w.round();
      await w.advance(61 * MIN);
    }
    expect([h.heldOf(a.id)?.location, h.heldOf(b.id)?.location]).toEqual(['active', 'active']);
    expect(h.calls('list').length).toBe(lists);
    expect(h.calls('single').length).toBe(singles);
    expect(w.logged(PD20(SECOND_APP_ID, APP_ID))).toHaveLength(1);
  });

  it.each([
    ['a 500', { status: 500 }],
    ['no answer', { noAnswer: true }],
    ['a 2xx with no application id', { body: 'object' }],
  ] as const)('G2b (guard a): /applications/@me failing (%s) at every round for over an hour, the list answering and every single read 404: nothing ends until @me answers', async (_what, fault) => {
    await w.setup({ settings: { ...S0, deletedRead: '404' } });
    const a = await h.buy(U, SKU.A);
    w.fake.refund(a);
    w.fake.drop(0);
    w.fake.fail('me', fault as any, 1000);
    const t0 = Date.now();
    expect(await w.roundAdvancing(2 * MIN)).toBe(true);
    await w.advance(t0 + 62 * MIN - Date.now());
    expect(await w.roundAdvancing(2 * MIN)).toBe(true);
    expect(h.heldOf(a.id)?.location).toBe('active');
    const notFound = h.singleCallsFor(a.id).filter(c => c.status === 404).map(c => c.at);
    expect(notFound.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...notFound) - Math.min(...notFound)).toBeGreaterThanOrEqual(60 * MIN);
    expect(h.calls('list').some(c => c.status === 200)).toBe(true);
    expect(w.logged(PD7(a.id, U))).toEqual([]);
    w.fake.clearFaults();
    await w.round();
    expect(h.heldOf(a.id)).toBeNull();
    expect(w.logged(PD7(a.id, U))).toHaveLength(1);
  });

  it('G3: a 2xx between two 404s clears the first 404: no end until two more 404s an hour apart', async () => {
    await w.setup({ settings: S0 });
    const a = await h.buy(U, SKU.A);
    w.fake.hiddenFromList.add(a.id);
    const t0 = Date.now();
    const at = async (ms: number, live404: boolean): Promise<void> => {
      await w.advance(t0 + ms - Date.now());
      if (live404) w.fake.settings.notFoundLive.add(a.id);
      else w.fake.settings.notFoundLive.delete(a.id);
      await w.round();
    };
    await at(0, true);
    await at(30 * MIN, false);
    await at(61 * MIN, true);
    expect(h.heldOf(a.id)?.location).toBe('active');
    await at(91 * MIN, true);
    expect(h.heldOf(a.id)?.location).toBe('active');
    await at(122 * MIN, true);
    expect(h.heldOf(a.id)).toBeNull();
  });

  it('G4: a restart between the two 404s: no end until two 404s an hour apart in the new process', async () => {
    await w.setup({ settings: S0 });
    const a = await h.buy(U, SKU.A);
    w.fake.hiddenFromList.add(a.id);
    w.fake.settings.notFoundLive.add(a.id);
    const t0 = Date.now();
    await w.round();
    await w.advance(5 * MIN);
    await w.restart();
    await w.advance(t0 + 61 * MIN - Date.now());
    await w.round();
    expect(h.heldOf(a.id)?.location).toBe('active');
    await w.advance(t0 + 126 * MIN - Date.now());
    await w.round();
    expect(h.heldOf(a.id)).toBeNull();
  });

  it('G5: Discord answering 404 for a live entitlement: it ends after two 404s an hour apart, and the next round whose list shows it installs it again', async () => {
    await w.setup({ settings: S0 });
    const a = await h.buy(U, SKU.A);
    w.fake.hiddenFromList.add(a.id);
    w.fake.settings.notFoundLive.add(a.id);
    const t0 = Date.now();
    await w.round();
    await w.advance(t0 + 60 * MIN - Date.now());
    await w.round();
    expect(h.heldOf(a.id)).toBeNull();
    expect(w.logged(PD7(a.id, U))).toHaveLength(1);
    w.fake.hiddenFromList.delete(a.id);
    await w.round();
    expect(h.heldOf(a.id)?.location).toBe('active');
    expect(h.started()).toBe(2);
  });

  it("D16 (claim 4): a round armed by an update event emits just before an order's refusal starts: its first save is refused and held, not written", async () => {
    await w.setup({ settings: { ...S0, updateEndsAt: 'past' } });
    await w.advance(31 * SEC);
    const a = await h.buy(U, SKU.A);
    const b = h.buyDropped(U2, SKU.A);
    w.fake.endAt(a, w.fake.updateEnd());
    // Node's own timers carry the AsyncLocalStorage store of the code that created them into their callback; the
    // faked ones do not, so each callback is bound to the context it was created in, as Node binds it.
    const fakeSetTimeout = globalThis.setTimeout;
    const bound = ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => fakeSetTimeout(AsyncResource.bind(fn), ms, ...args)) as typeof setTimeout;
    globalThis.setTimeout = bound;
    try {
      await w.deliverAll();
    } finally {
      globalThis.setTimeout = fakeSetTimeout;
    }
    expect(h.heldOf(a.id)).toBeNull();
    const registry: any = getPaymentRegistry();
    const emit = registry.emitEvent;
    const seen: string[] = [];
    registry.emitEvent = (event: any) => {
      if (event.type === 'subscription.created' && event.providerSubId === b.id) {
        seen.push(event.providerSubId);
        setMaintenanceGate({ cause: 'order', message: 'Moving the main database.' });
        setOrderRefusal(true);
      }
      return emit.call(registry, event);
    };
    // The clock stops half a second after the round comes due: premium's first retry of a held save (1 second later,
    // inside runHeldResave, NX5 G8-9) is not watched (E8).
    await vi.advanceTimersByTimeAsync(30 * SEC + 500);
    for (let i = 0; i < 2000 && (seen.length === 0 || acceptedOpsRunning() > 0); i++) await new Promise<void>(resolve => { setImmediate(resolve); });
    for (let i = 0; i < 50; i++) await new Promise<void>(resolve => { setImmediate(resolve); });
    const heldSave = (getPremiumManager() as any).saveHeld;
    const stored = JSON.parse(fs.readFileSync(dataPath('global', 'premium-tiers.json'), 'utf8'));
    setMaintenanceGate(null);
    setOrderRefusal(false);
    expect(seen).toEqual([b.id]);
    expect(heldSave).toBe(true);
    expect(stored.subscriptions?.[`user:${U2}`]).toBeUndefined();
  });
});

const ORDERS = ['asc', 'desc'] as const;
const COMBOS: Array<Partial<DiscordSettings>> = [];
for (const firstWindow of ['oldest', 'newest'] as const) {
  for (const sortFirst of ORDERS) for (const sortAfter of ORDERS) for (const sortBefore of ORDERS) {
    for (const shortPageMidway of [false, true]) COMBOS.push({ firstWindow, sortFirst, sortAfter, sortBefore, shortPageMidway });
  }
}

describe('P6 part 2, claim 5 K8: step 1 over 250 entitlements under every paging setting of R6', () => {
  const w = p6World('json');
  const h = helpers(w);
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it.each(COMBOS.map(c => [JSON.stringify(c), c] as const))('every purchase whose event was dropped is installed in one round, %s', async (_name, combo) => {
    await w.setup({ settings: { ...S0, ...combo } });
    const ents: FakeEntitlement[] = [];
    for (let i = 0; i < 250; i++) ents.push(w.fake.purchase(user(i), SKU.A));
    const current = new Set([0, 1, 98, 99, 100, 101, 150, 198, 199, 200, 201, 248, 249]);
    for (const [i, e] of ents.entries()) if (!current.has(i)) w.fake.endAt(e, Date.now() - HOUR);
    w.fake.queue.length = 0;
    await w.round();
    for (const i of current) expect(h.heldOf(ents[i].id)?.location, `entitlement ${i}`).toBe('active');
    expect(w.logged(PD6)).toEqual([]);
  });
});
