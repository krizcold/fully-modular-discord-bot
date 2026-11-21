import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// P2 claims 1 to 5 (parts 1 and 2): the Dummy provider's record names its holder and its buyer; the load keeps only
// the records that fit and logs DL1 for the rest; the purchase guards DX1 to DX3 sit before any change; the list
// matches the whole holder key; it sells servers and users. The real DummyProvider beside the real PremiumManager in
// the bot role, on the JSON files and on the mirror rig. "A new process" is a new DummyProvider over the stored document.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { gh, uh } from '../helpers/p1Holder';
import { allowDropLines, droppedLines } from '../helpers/p1Guard';
import { BUYER, p1World, SERVERS } from '../helpers/p1World';
import { DUMMY_KEY, DUMMY_PATH, DUMMY_VARIANT, dummyDriver } from '../helpers/p2DummyDriver';

const FIXTURES = path.resolve(__dirname, '..', 'fixtures');
const P1_STATE = fs.readFileSync(path.join(FIXTURES, 'p2', 'dummy-state.p1.json'), 'utf8');
const OLD_STATE = fs.readFileSync(path.join(FIXTURES, 'p1', 'dummy-state.old.json'), 'utf8');
const A = SERVERS[0];
const B = SERVERS[1];
const COUPON = { code: 'P2SHAPE', percentOff: 10, usedCount: 0, createdAt: '2026-11-21T00:00:00.000Z' };
const DL1 = (n: number) => `[DummyProvider] payment-providers/dummy/state.json holds ${n} subscription record(s) this version does not read (its holder, buyer, id or status is not one this version writes). They are not loaded, and the next Dummy save writes the file without them. The bot may still hold a subscription for one of them: "Cancel & remove now" on a server's subscription page or "End now" under "Test purchase" for a user removes an active one from the bot, and "Cancel & remove" removes a queued one.`;
const DX1 = (text: string) => `The Dummy provider sold nothing: '${text}' is not a holder (expected guild:<id> or user:<id> with a Discord id).`;
const DX2 = 'The Dummy provider sold nothing: the purchase names no Discord user who pays.';
const DX3 = "The Dummy provider sold nothing: a user's subscription is paid by that user, and the buyer given is someone else.";

type Driver = ReturnType<typeof dummyDriver>;
type World = ReturnType<typeof p1World>;

let current: { w: World; driver: Driver } | null = null;
const role = process.env.BOT_PROCESS_ROLE;

async function world(backend: 'json' | 'rig'): Promise<{ w: World; driver: Driver }> {
  const driver = dummyDriver();
  const w = p1World(backend, driver);
  current = { w, driver };
  await w.setup();
  return current;
}

afterEach(async () => {
  process.env.BOT_PROCESS_ROLE = 'bot';
  if (current) await current.w.teardown();
  current = null;
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

/** The stored state.json's text as a restore or another version leaves it, written before the next load. */
async function writeStored(w: World, text: string): Promise<void> {
  if (w.rig) {
    w.rig.m.state.rows.put(DUMMY_KEY, text);
    await runSharedPass();
    return;
  }
  fs.mkdirSync(path.dirname(DUMMY_PATH), { recursive: true });
  fs.writeFileSync(DUMMY_PATH, text);
}

/** A new process for the Dummy provider over what is stored, in the bot role or the web UI role. */
async function restart(w: World, driver: Driver, as: 'bot' | 'webui' = 'bot'): Promise<void> {
  await w.settle();
  await driver.detach();
  if (as === 'bot') process.env.BOT_PROCESS_ROLE = 'bot';
  else delete process.env.BOT_PROCESS_ROLE;
  await driver.attach(w.rig);
}

const record = (fields: Record<string, unknown>) => ({
  providerSubId: 'dummy_1', holder: gh(A), buyerId: BUYER, tierId: 'low', offeringId: 'o-low', variantId: DUMMY_VARIANT,
  durationDays: 30, startDate: '2026-11-20T00:00:00.000Z', endDate: '2099-12-20T00:00:00.000Z', autoRenew: true,
  status: 'active', createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z', ...fields,
});

describe.each([['json'], ['rig']] as const)('%s', backend => {
  describe('claim 1: a record is stored with its holder and its buyer', () => {
    it("a server's purchase stores holder and buyerId and no guildId; a new process lists it for its holder; an unrelated save keeps it", async () => {
      const { w, driver } = await world(backend);
      const bought = await w.purchase(A, 'low');
      expect(bought).toMatchObject({ ok: true });
      const id = bought.result.providerSubId as string;
      const stored = driver.document().subscriptions[id];
      expect(stored).toMatchObject({ providerSubId: id, holder: gh(A), buyerId: BUYER, status: 'active' });
      expect(stored).not.toHaveProperty('guildId');

      await restart(w, driver);
      expect((await driver.provider().listSubscriptionsFor(gh(A))).map(l => l.providerSubId)).toEqual([id]);
      expect(await driver.provider().listSubscriptionsFor(uh(A))).toEqual([]);
      expect(await driver.provider().listSubscriptionsFor(gh(B))).toEqual([]);

      const before = driver.document().subscriptions;
      expect(await w.sharedOp('dummy.adminSetCoupon', { args: [{ ...COUPON }] })).toMatchObject({ ok: true, result: true });
      await w.settle();
      expect(driver.document().coupons[COUPON.code]).toBeDefined();
      expect(driver.document().subscriptions).toEqual(before);
    });
  });

  describe("claim 2: the shape P1 leaves is not loaded, and DL1 says so", () => {
    describe.each([['bot'], ['webui']] as const)('in the %s role', as => {
      it.each([['p1', P1_STATE], ['old', OLD_STATE]] as const)('from the %s fixture: nothing listed, the catalogue and nextId kept, DL1 once, the bytes kept until a save', async (_name, text) => {
        allowDropLines('DL1');
        const fixture = JSON.parse(text);
        const droppedIds = Object.keys(fixture.subscriptions);
        const servers = [...new Set(Object.values<any>(fixture.subscriptions).map(s => s.guildId as string))];
        const { w, driver } = await world(backend);
        await writeStored(w, text);
        await restart(w, driver, as);
        const p = driver.provider();

        for (const server of servers) expect(await p.listSubscriptionsFor(gh(server))).toEqual([]);
        expect(await p.getSubscriptionState('dummy_1')).toBeNull();
        expect(p.adminListCoupons()).toEqual(Object.values(fixture.coupons));
        expect(p.adminListProducts()).toEqual(Object.values(fixture.products));
        expect(p.adminListVariants().map(v => v.variantId)).toEqual(Object.keys(fixture.variants));
        expect(droppedLines('DL1')).toEqual([DL1(droppedIds.length)]);

        p.invalidate();
        expect(await p.listSubscriptionsFor(gh(servers[0]))).toEqual([]);
        expect(droppedLines('DL1')).toEqual([DL1(droppedIds.length)]);
        await w.settle();
        expect(driver.bytes()).toBe(text);

        expect(await w.sharedOp('dummy.adminSetCoupon', { args: [{ ...COUPON }] })).toMatchObject({ ok: true, result: true });
        await w.settle();
        const saved = driver.document();
        expect(saved.subscriptions).toEqual({});
        expect(saved.variants).toEqual(fixture.variants);
        expect(saved.products).toEqual(fixture.products);
        const { [COUPON.code]: added, ...oldCoupons } = saved.coupons;
        expect(added).toMatchObject({ code: COUPON.code, percentOff: 10 });
        expect(oldCoupons).toEqual(fixture.coupons);
        expect(saved.nextId).toBe(fixture.nextId);

        const next = await p.initiatePurchase({ holder: gh(A), buyerId: BUYER, tierId: 'low', offeringId: 'o-low', variantId: DUMMY_VARIANT } as any);
        await w.settle();
        expect(next.providerSubId).toBe(`dummy_${fixture.nextId}`);
        expect(droppedIds).not.toContain(next.providerSubId);
        expect(droppedLines('DL1')).toEqual([DL1(droppedIds.length)]);
      });

      it('a file with records that fit and records that do not keeps the first, counts the rest, and keeps an unnamed field across a save', async () => {
        allowDropLines('DL1');
        const kept = { ...record({ providerSubId: 'dummy_1' }), later: { n: 1 } };
        const keptUser = record({ providerSubId: 'dummy_2', holder: uh(B), buyerId: B });
        const p1Shape: Record<string, unknown> = record({ providerSubId: 'dummy_3' });
        delete p1Shape.holder;
        p1Shape.guildId = A;
        const otherBuyer = record({ providerSubId: 'dummy_4', holder: uh(A), buyerId: B });
        const wrongKey = record({ providerSubId: 'dummy_9' });
        const pending = record({ providerSubId: 'dummy_6', status: 'pending' });
        const text = JSON.stringify({
          variants: JSON.parse(P1_STATE).variants, products: {}, coupons: {},
          subscriptions: { dummy_1: kept, dummy_2: keptUser, dummy_3: p1Shape, dummy_4: otherBuyer, dummy_5: wrongKey, dummy_6: pending },
          nextId: 7,
        }, null, 2);
        const { w, driver } = await world(backend);
        await writeStored(w, text);
        await restart(w, driver, as);
        const p = driver.provider();

        expect((await p.listSubscriptionsFor(gh(A))).map(l => l.providerSubId)).toEqual(['dummy_1']);
        expect((await p.listSubscriptionsFor(uh(B))).map(l => l.providerSubId)).toEqual(['dummy_2']);
        expect(await p.listSubscriptionsFor(uh(A))).toEqual([]);
        for (const id of ['dummy_3', 'dummy_4', 'dummy_5', 'dummy_6', 'dummy_9']) expect(await p.getSubscriptionState(id)).toBeNull();
        expect(droppedLines('DL1')).toEqual([DL1(4)]);

        expect(await w.sharedOp('dummy.adminSetCoupon', { args: [{ ...COUPON }] })).toMatchObject({ ok: true, result: true });
        await w.settle();
        const saved = driver.document();
        expect(Object.keys(saved.subscriptions)).toEqual(['dummy_1', 'dummy_2']);
        expect(saved.subscriptions.dummy_1).toEqual(kept);
        expect(saved.subscriptions.dummy_2).toEqual(keptUser);
        expect(saved.nextId).toBe(7);
      });
    });
  });

  describe("claim 4: the Dummy's own guards, before any change", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["holder 'abc'", { holder: 'abc', buyerId: BUYER }, DX1('abc')],
      ["holder '5'", { holder: '5', buyerId: BUYER }, DX1('5')],
      ["holder 'guild:05'", { holder: 'guild:05', buyerId: BUYER }, DX1('guild:05')],
      ['no buyer', { holder: gh(A) }, DX2],
      ["buyer 'abc'", { holder: gh(A), buyerId: 'abc' }, DX2],
      ["user:5 paid by '6'", { holder: 'user:5', buyerId: '6' }, DX3],
    ];
    it.each(cases)('%s: refused, the next purchase gets its id, the coupon count and the stored bytes unchanged', async (_name, owner, text) => {
      const { w, driver } = await world(backend);
      const p = driver.provider();
      const buy = (who: Record<string, unknown>) => p.initiatePurchase({ ...who, tierId: 'low', offeringId: 'o-low', variantId: DUMMY_VARIANT, couponCode: 'TEST20' } as any);
      expect((await buy({ holder: gh(A), buyerId: BUYER })).providerSubId).toBe('dummy_1');
      await w.settle();
      const bytes = driver.bytes();
      const used = () => p.adminListCoupons().find(c => c.code === 'TEST20')!.usedCount;
      expect(used()).toBe(1);

      let refused: unknown = null;
      try {
        await buy(owner);
      } catch (error) {
        refused = error;
      }
      await w.settle();
      expect(refused).toBeInstanceOf(Error);
      expect((refused as Error).message).toBe(text);
      expect(used()).toBe(1);
      expect(driver.bytes()).toBe(bytes);

      expect((await buy({ holder: gh(B), buyerId: BUYER })).providerSubId).toBe('dummy_2');
      expect(used()).toBe(2);
    });
  });

  describe('claim 5: the list is per holder, by the whole key (servers)', () => {
    it("each server's list has its own ids; a paused one is listed as paused, an expired one is not; the metadata names holder and buyer", async () => {
      const { w, driver } = await world(backend);
      const low = await w.purchase(A, 'low');
      const high = await w.purchase(A, 'high');
      const other = await w.purchase(B, 'mid');
      const gone = await w.purchase(B, 'low');
      expect([low.ok, high.ok, other.ok, gone.ok]).toEqual([true, true, true, true]);
      expect(await w.cancelNow(B)).toMatchObject({ ok: true });
      const ids = [low, high, other, gone].map(r => r.result.providerSubId as string);
      expect(driver.view(ids[0])?.status).toBe('paused');
      const state = driver.document().subscriptions;
      const expiredId = Object.keys(state).find(k => state[k].status === 'expired')!;
      expect(expiredId).toBeDefined();
      const p = driver.provider();

      const listA = await p.listSubscriptionsFor(gh(A));
      expect(listA.map(l => [l.providerSubId, l.state.status]).sort()).toEqual([[ids[0], 'paused'], [ids[1], 'active']].sort());
      const listB = await p.listSubscriptionsFor(gh(B));
      expect(listB.map(l => l.providerSubId)).not.toContain(expiredId);
      expect(listB.every(l => state[l.providerSubId].holder === gh(B))).toBe(true);
      for (const entry of [...listA, ...listB]) {
        const r = state[entry.providerSubId];
        expect(entry.metadata).toEqual({ holder: r.holder, buyerId: BUYER, tierId: r.tierId, offeringId: r.offeringId, variantId: r.variantId, couponCode: r.couponCode });
      }
      expect(await p.listSubscriptionsFor(uh(A))).toEqual([]);
      for (const text of ['abc', A, `guild:${A} `, 'guild:', `user:${A}x`]) expect(await p.listSubscriptionsFor(text as any)).toEqual([]);
    });
  });
});

describe.each([['json'], ['rig']] as const)('%s, users (part 2)', backend => {
  /** A world whose user tiers vlow, vmid, valt and vhigh are sold through the Dummy. */
  async function userWorld(): Promise<{ w: World; driver: Driver }> {
    const made = await world(backend);
    await made.w.addSoldUserTiers();
    expect(Object.keys(made.w.tiers('user')).sort()).toEqual(['valt', 'vhigh', 'vlow', 'vmid']);
    return made;
  }

  describe('claim 1: a record is stored with its holder and its buyer', () => {
    it('a purchase for a server and one for the user of the same number: two records, each with holder and buyerId; a new process lists each for its holder; an unrelated save keeps both', async () => {
      const { w, driver } = await userWorld();
      const server = await w.purchase(A, 'low');
      const user = await w.purchase(uh(A), 'vlow');
      expect([server.ok, user.ok]).toEqual([true, true]);
      const serverId = server.result.providerSubId as string;
      const userId = user.result.providerSubId as string;
      expect(serverId).not.toBe(userId);
      const stored = driver.document().subscriptions;
      expect(Object.keys(stored).sort()).toEqual([serverId, userId].sort());
      expect(stored[serverId]).toMatchObject({ providerSubId: serverId, holder: gh(A), buyerId: BUYER });
      expect(stored[userId]).toMatchObject({ providerSubId: userId, holder: uh(A), buyerId: A });
      for (const id of [serverId, userId]) expect(stored[id]).not.toHaveProperty('guildId');
      expect(w.recordOf(uh(A)).active).toMatchObject({ providerId: 'dummy', providerSubId: userId, buyerId: A });

      await restart(w, driver);
      expect((await driver.provider().listSubscriptionsFor(gh(A))).map(l => l.providerSubId)).toEqual([serverId]);
      expect((await driver.provider().listSubscriptionsFor(uh(A))).map(l => l.providerSubId)).toEqual([userId]);

      const before = driver.document().subscriptions;
      expect(await w.sharedOp('dummy.adminSetCoupon', { args: [{ ...COUPON }] })).toMatchObject({ ok: true, result: true });
      await w.settle();
      expect(driver.document().subscriptions).toEqual(before);
    });
  });

  describe('claim 3: sells is both kinds', () => {
    it("declares ['guild', 'user']; a user tier and a server tier with an enabled Dummy link save; a user purchase installs under the user with the buyer", async () => {
      const { w, driver } = await world(backend);
      expect(driver.provider().capabilities.sells).toEqual(['guild', 'user']);
      expect(await w.setUserTier('vmid')).toMatchObject({ ok: true });
      expect(await w.setTier('mid', 'MID again')).toMatchObject({ ok: true });
      expect(w.stored().tiers.vmid).toMatchObject({ kind: 'user', offerings: [{ providerLinks: [{ providerId: 'dummy', enabled: true }] }] });
      expect(w.stored().tiers.mid.offerings[0].providerLinks[0]).toMatchObject({ providerId: 'dummy', enabled: true });

      const bought = await w.purchase(uh(B), 'vmid');
      expect(bought).toMatchObject({ ok: true });
      expect(w.recordOf(uh(B)).active).toMatchObject({ tierId: 'vmid', providerId: 'dummy', buyerId: B });
      expect(driver.document().subscriptions[bought.result.providerSubId]).toMatchObject({ holder: uh(B), buyerId: B });
    });
  });

  describe("claim 4: the Dummy's own guards accept a user paid by that user", () => {
    it("user:5 paid by '5' is sold under user:5", async () => {
      const { w, driver } = await world(backend);
      const p = driver.provider();
      const bought = await p.initiatePurchase({ holder: 'user:5', buyerId: '5', tierId: 'low', offeringId: 'o-low', variantId: DUMMY_VARIANT, couponCode: 'TEST20' } as any);
      await w.settle();
      expect(bought.providerSubId).toBe('dummy_1');
      expect(driver.document().subscriptions.dummy_1).toMatchObject({ holder: 'user:5', buyerId: '5' });
      expect(p.adminListCoupons().find(c => c.code === 'TEST20')!.usedCount).toBe(1);
    });
  });

  describe('claim 5: the list is per holder, by the whole key (users)', () => {
    it("guild:A, user:A and user:B each list their own ids; a paused one is listed as paused, an expired one is not; the metadata names holder and buyer", async () => {
      const { w, driver } = await userWorld();
      const server = await w.purchase(A, 'low');
      const gone = await w.purchase(uh(A), 'vlow');
      expect(await w.cancelNow(uh(A))).toMatchObject({ ok: true });
      const userA = await w.purchase(uh(A), 'vmid');
      const highB = await w.purchase(uh(B), 'vhigh');
      const lowB = await w.purchase(uh(B), 'vlow');
      expect([server.ok, gone.ok, userA.ok, highB.ok, lowB.ok]).toEqual([true, true, true, true, true]);
      const id = (r: any) => r.result.providerSubId as string;
      const state = driver.document().subscriptions;
      expect(state[id(gone)].status).toBe('expired');
      expect(state[id(lowB)].status).toBe('paused');
      const p = driver.provider();

      const listed = async (holder: string) => (await p.listSubscriptionsFor(holder as any)).map(l => [l.providerSubId, l.state.status]).sort();
      expect(await listed(gh(A))).toEqual([[id(server), 'active']]);
      expect(await listed(uh(A))).toEqual([[id(userA), 'active']]);
      expect(await listed(uh(B))).toEqual([[id(highB), 'active'], [id(lowB), 'paused']].sort());
      expect(await listed(gh(B))).toEqual([]);
      for (const holder of [uh(A), uh(B)]) {
        for (const entry of await p.listSubscriptionsFor(holder as any)) {
          const r = state[entry.providerSubId];
          expect(entry.metadata).toEqual({ holder, buyerId: holder.slice('user:'.length), tierId: r.tierId, offeringId: r.offeringId, variantId: r.variantId, couponCode: r.couponCode });
        }
      }
      for (const text of [`user:${A} `, 'user:', `user:0${A}`]) expect(await p.listSubscriptionsFor(text as any)).toEqual([]);
    });
  });
});
