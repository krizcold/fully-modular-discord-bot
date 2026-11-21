import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

// P1 claims 8 and 9, parts 0, 3 and 4a: what the stacking keeps for every holder. Random sequences of changes to two
// servers and three users (one user has the first server's digits), each through its shared op with a holder key;
// after every step the stored document is read. Each property also counts the steps premium answered ok, so a world
// that refuses everything does not pass.
// K5: a step on one holder leaves every other holder's record as it was. K1 to K4: every queue entry is paused, no id
// twice in a record, no empty slot beside a queue, the queue in priority order with manual before paid at a tie. N1:
// every key of the store is a holder key. N2: every subscription's tier is of its holder's kind. N3: every paid
// subscription names its buyer, and a user's is that user. Every holder takes the manual and the paid steps, with
// tiers of both kinds offered to both kinds of holder (the wrong kind is refused). The same sequences run on the
// mirror rig with fewer steps. Nothing runs on the clock.
// Left out, as the sheet's section 4 says: a state event for a queued subscription (E1), a setTier that changes a
// priority (E2), price migrations and the expiry tick (E3). A failure prints its seed; SMDB_TEST_SEED replays it.
// P2 claim 12 (parts 0 and 2): claims 8 and 9 run again through the real Dummy provider, with the steps it can make
// (no delivery) for the two servers and the three users.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { allowDropLines, droppedLines } from '../helpers/p1Guard';
import { gh, uh } from '../helpers/p1Holder';
import { HOLDERS, SELLER_LIST_CALL, SERVERS, TIER_IDS, TWIN_USER, USERS, USER_HOLDERS, USER_SOLD_TIER_IDS, USER_TIER_IDS, brokenHolders, brokenStacking, eachSeller, p1World, type OpReply, type SellerDriver } from '../helpers/p1World';

type Step =
  | { t: 'grant'; h: number; tier: string; days: number | null }
  | { t: 'extend'; h: number; days: number }
  | { t: 'revoke'; h: number }
  | { t: 'cancelNow' | 'renewed' | 'cancelled' | 'expired' | 'redelivered'; h: number }
  | { t: 'purchase' | 'created'; h: number; tier: string }
  | { t: 'cancelQueued'; h: number; pick: number }
  | { t: 'deleteTier' | 'setTier'; tier: string };

const anyHolder = fc.constantFrom(0, 1, ...USER_HOLDERS);
const server = fc.constantFrom(0, 1);
const serverTier = fc.constantFrom(...TIER_IDS);
const user = fc.constantFrom(...USER_HOLDERS);
const soldUserTier = fc.constantFrom(...USER_SOLD_TIER_IDS);
const anyTier = fc.constantFrom(...TIER_IDS, ...USER_TIER_IDS, ...USER_SOLD_TIER_IDS);
const holderSteps: fc.Arbitrary<Step>[] = [
  fc.record({ t: fc.constant('grant' as const), h: anyHolder, tier: anyTier, days: fc.option(fc.integer({ min: 1, max: 60 }), { nil: null }) }),
  fc.record({ t: fc.constant('grant' as const), h: fc.constantFrom(...USER_HOLDERS), tier: fc.constantFrom(...USER_TIER_IDS), days: fc.option(fc.integer({ min: 1, max: 60 }), { nil: null }) }),
  fc.record({ t: fc.constant('extend' as const), h: anyHolder, days: fc.integer({ min: 1, max: 30 }) }),
  fc.record({ t: fc.constant('revoke' as const), h: anyHolder }),
  fc.record({ t: fc.constantFrom('cancelNow' as const, 'renewed' as const, 'cancelled' as const, 'expired' as const, 'redelivered' as const), h: anyHolder }),
  fc.record({ t: fc.constantFrom('purchase' as const, 'created' as const), h: server, tier: serverTier }),
  fc.record({ t: fc.constantFrom('purchase' as const, 'created' as const), h: user, tier: soldUserTier }),
  fc.record({ t: fc.constantFrom('purchase' as const, 'created' as const), h: anyHolder, tier: anyTier }),
  fc.record({ t: fc.constant('cancelQueued' as const), h: anyHolder, pick: fc.nat({ max: 5 }) }),
];
const tierSteps: fc.Arbitrary<Step>[] = [fc.record({ t: fc.constantFrom('deleteTier' as const, 'setTier' as const), tier: anyTier })];
/** The steps of a seller that takes no delivery: the manual and paid steps of the servers and the users (sheet P2, section 5). */
const sellerSteps: fc.Arbitrary<Step>[] = [
  fc.record({ t: fc.constant('grant' as const), h: anyHolder, tier: anyTier, days: fc.option(fc.integer({ min: 1, max: 60 }), { nil: null }) }),
  fc.record({ t: fc.constant('grant' as const), h: user, tier: fc.constantFrom(...USER_TIER_IDS), days: fc.option(fc.integer({ min: 1, max: 60 }), { nil: null }) }),
  fc.record({ t: fc.constant('extend' as const), h: anyHolder, days: fc.integer({ min: 1, max: 30 }) }),
  fc.record({ t: fc.constant('revoke' as const), h: anyHolder }),
  fc.record({ t: fc.constant('cancelNow' as const), h: anyHolder }),
  fc.record({ t: fc.constant('purchase' as const), h: server, tier: serverTier }),
  fc.record({ t: fc.constant('purchase' as const), h: user, tier: soldUserTier }),
  fc.record({ t: fc.constant('purchase' as const), h: anyHolder, tier: anyTier }),
  fc.record({ t: fc.constant('cancelQueued' as const), h: anyHolder, pick: fc.nat({ max: 5 }) }),
];
const sellerTierSteps: fc.Arbitrary<Step>[] = [fc.record({ t: fc.constantFrom('deleteTier' as const, 'setTier' as const), tier: anyTier })];
/** The steps a driver's seller can make. */
const stepsOf = (driver: SellerDriver, tiers: boolean): fc.Arbitrary<Step>[] =>
  driver.delivers ? [...holderSteps, ...(tiers ? tierSteps : [])] : [...sellerSteps, ...(tiers ? sellerTierSteps : [])];

type World = ReturnType<typeof p1World>;
const files = p1World();
const rig = p1World('rig');
let w: World = files;
let renames = 0;
/**
 * The steps of the property that runs now: how many premium answered ok, after how many the acted holder's stored
 * record differs (an ok answer alone can be a step that changed nothing, as a revoke with no record), and how many
 * paid steps (a purchase, a created event) changed a user's record.
 */
const tally = { steps: 0, ok: 0, changed: 0, changedOnUsers: 0, paidOnUsers: 0 };
const noTally = { steps: 0, ok: 0, changed: 0, changedOnUsers: 0, paidOnUsers: 0 };
/**
 * A property must answer ok to one step in ten, change a record in one step in ten, change a user's at least once
 * and change a user's by a paid step at least once.
 */
const enoughOk = (): boolean => tally.ok * 10 >= tally.steps && tally.changed * 10 >= tally.steps && tally.changedOnUsers > 0 && tally.paidOnUsers > 0;

async function run(step: Step): Promise<OpReply | null> {
  if (!('h' in step)) {
    if (step.t === 'deleteTier') return w.deleteTier(step.tier);
    if (USER_TIER_IDS.includes(step.tier) || USER_SOLD_TIER_IDS.includes(step.tier)) return w.setUserTier(step.tier, `${step.tier} ${++renames}`);
    return w.setTier(step.tier, `${step.tier} ${++renames}`);
  }
  const id = HOLDERS[step.h];
  switch (step.t) {
    case 'grant': return w.grant(id, step.tier, step.days);
    case 'extend': return w.extend(id, step.days);
    case 'revoke': return w.revoke(id);
    case 'purchase': return w.purchase(id, step.tier);
    case 'created': return w.created(id, step.tier);
    case 'redelivered': return w.redelivered(id);
    case 'renewed': return w.renewed(id);
    case 'cancelled': return w.cancelled(id);
    case 'expired': return w.expired(id);
    case 'cancelNow': return w.cancelNow(id);
    case 'cancelQueued': return w.cancelQueued(id, step.pick);
  }
}

/** Runs the steps on a new world; what each step broke, collected and returned for the caller to assert on. */
async function broken(steps: Step[], checks: { others: boolean; stacking: boolean }): Promise<string[]> {
  const found: string[] = [];
  await w.setup();
  try {
    await w.addUserTiers();
    await w.addSoldUserTiers();
    for (const [index, step] of steps.entries()) {
      const before = w.stored().subscriptions ?? {};
      const reply = await run(step);
      tally.steps += 1;
      if (reply?.ok) tally.ok += 1;
      const doc = w.stored();
      if ('h' in step && JSON.stringify(doc.subscriptions?.[HOLDERS[step.h]]) !== JSON.stringify(before[HOLDERS[step.h]])) {
        tally.changed += 1;
        if ((USER_HOLDERS as readonly number[]).includes(step.h)) {
          tally.changedOnUsers += 1;
          if (step.t === 'purchase' || step.t === 'created') tally.paidOnUsers += 1;
        }
      }
      const where = `step ${index} ${JSON.stringify(step)}`;
      if (checks.others && 'h' in step) {
        const acted = HOLDERS[step.h];
        for (const other of new Set([...Object.keys(before), ...Object.keys(doc.subscriptions ?? {})])) {
          if (other === acted) continue;
          if (JSON.stringify(doc.subscriptions?.[other]) !== JSON.stringify(before[other])) found.push(`K5: ${where} changed the record of ${other}`);
        }
      }
      if (checks.stacking) for (const line of brokenStacking(doc)) found.push(`${line} after ${where}`);
      for (const line of brokenHolders(doc)) found.push(`${line} after ${where}`);
      if (found.length > 0) break;
    }
  } finally {
    await w.teardown();
  }
  return found;
}

afterEach(() => { vi.restoreAllMocks(); });

/** The failed installs a row logged other than a created event that ties the active priority, the one it allows. */
const TIE = /^\[PremiumManager\] installAsyncSubscription failed: Error: You already have a '/;
const untiedInstallFailures = (): string[] => droppedLines('install').filter(line => !TIE.test(line));

describe('P1 part 4a on the mirror rig: the same sequences with fewer steps', () => {
  it('claims 8 and 9: K1 to K5 and N1 to N3 hold after every step', async () => {
    w = rig;
    // A created event of the wrong kind is one of the steps: premium does not install it and says so (L3). One that
    // ties the active subscription's priority is refused by a throw, logged as a failed install.
    allowDropLines('L3', 'install');
    try {
      Object.assign(tally, noTally);
      await fc.assert(fc.asyncProperty(fc.array(fc.oneof(...holderSteps, ...tierSteps), { minLength: 4, maxLength: 12 }), async steps => {
        expect(await broken(steps, { others: true, stacking: true })).toEqual([]);
      }), { numRuns: 12 });
      expect({ ...tally, enough: tally.ok * 10 >= tally.steps && tally.changed * 10 >= tally.steps }).toMatchObject({ enough: true });
      expect(untiedInstallFailures()).toEqual([]);
    } finally {
      w = files;
    }
  }, 400_000);
});

describe('P1 parts 0, 3 and 4a: two servers and three users', () => {
  it('one user of HOLDERS has the digits of a server, and the two keys differ', () => {
    expect(HOLDERS).toContain(gh(TWIN_USER));
    expect(HOLDERS).toContain(uh(TWIN_USER));
    expect(new Set(HOLDERS).size).toBe(HOLDERS.length);
  });

  eachSeller(['p1seller', 'dummy'], make => {
    const driver = make();
    const world = driver.delivers ? files : p1World('json', driver);
    afterEach(() => { w = files; });

    it("claim 8, K5: a step on one holder leaves every other holder's record as it was (and N1, N2, N3 hold)", async () => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      allowDropLines('L3', 'install');
      Object.assign(tally, noTally);
      w = world;
      await fc.assert(fc.asyncProperty(fc.array(fc.oneof(...stepsOf(driver, false)), { minLength: 1, maxLength: 25 }), async steps => {
        expect(await broken(steps, { others: true, stacking: false })).toEqual([]);
      }), { numRuns: 40 });
      expect({ ...tally, enough: enoughOk() }).toMatchObject({ enough: true });
      expect(untiedInstallFailures()).toEqual([]);
      w = files;
    }, 400_000);

    it('claim 9, K1 to K4, N1 to N3: the stored queue stays paused, without doubles, behind a filled slot and in order, under holder keys, tiers of the holder\'s kind and a buyer on every paid subscription', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      allowDropLines('L3', 'install');
      Object.assign(tally, noTally);
      w = world;
      await fc.assert(fc.asyncProperty(fc.array(fc.oneof(...stepsOf(driver, true)), { minLength: 1, maxLength: 25 }), async steps => {
        expect(await broken(steps, { others: true, stacking: true })).toEqual([]);
      }), { numRuns: 40 });
      expect({ ...tally, enough: enoughOk() }).toMatchObject({ enough: true });
      expect(untiedInstallFailures()).toEqual([]);
      w = files;
    }, 400_000);
  });

  it('the steps reach the stacking: a purchase above a grant queues the grant, and an expiry resumes it', async () => {
    await w.setup();
    try {
      const [a, b] = SERVERS;
      expect(await w.grant(a, 'low', 30)).toMatchObject({ ok: true });
      expect(await w.purchase(a, 'high')).toMatchObject({ ok: true });
      expect(await w.created(a, 'mid')).toMatchObject({ ok: true });
      expect(await w.grant(b, 'mid', null)).toMatchObject({ ok: true });
      const queued = w.recordOf(a);
      expect([queued.active.tierId, queued.active.source, queued.paused.map((p: any) => `${p.tierId}/${p.source}/${p.status}`)]).toEqual(['high', 'paid', ['mid/paid/paused', 'low/manual/paused']]);
      expect(w.calls().map(c => c.method)).toEqual([SELLER_LIST_CALL, 'initiatePurchase', 'pauseSubscription']);
      expect(await w.expired(a)).toMatchObject({ ok: true });
      const resumed = w.recordOf(a);
      expect([resumed.active.tierId, resumed.active.status, resumed.paused.map((p: any) => p.tierId)]).toEqual(['mid', 'active', ['low']]);
      expect(await w.cancelQueued(a, 0)).toMatchObject({ ok: true });
      expect(await w.cancelNow(a)).toMatchObject({ ok: true });
      expect(w.recordOf(a)).toBeNull();
      expect(w.recordOf(b).active).toMatchObject({ tierId: 'mid', source: 'manual', endDate: null });
      expect(Object.keys(w.stored().subscriptions)).toEqual([gh(b)]);
      expect(brokenStacking(w.stored())).toEqual([]);
    } finally {
      await w.teardown();
    }
  });

  it("the users' steps reach the stacking: a higher grant queues the lower one, a revoke resumes it, and a server tier is refused", async () => {
    await w.setup();
    try {
      await w.addUserTiers();
      const [u, v] = USERS.map(uh);
      expect(await w.grant(u, 'ulow', 30)).toMatchObject({ ok: true });
      expect(await w.grant(u, 'uhigh', 10)).toMatchObject({ ok: true });
      expect(await w.grant(v, 'umid', null)).toMatchObject({ ok: true });
      expect((await w.grant(v, 'high', 30)).ok).toBe(false);
      expect((await w.grant(gh(SERVERS[0]), 'uhigh', 30)).ok).toBe(false);
      const queued = w.recordOf(u);
      expect([queued.active.tierId, queued.paused.map((p: any) => `${p.tierId}/${p.source}/${p.status}`)]).toEqual(['uhigh', ['ulow/manual/paused']]);
      expect(await w.extend(u, 5)).toMatchObject({ ok: true });
      expect(await w.revoke(u)).toMatchObject({ ok: true });
      expect(w.recordOf(u).active).toMatchObject({ tierId: 'ulow', status: 'active' });
      expect(w.recordOf(u).paused).toEqual([]);
      expect(await w.cancelQueued(u, 0)).toBeNull();
      expect(Object.keys(w.stored().subscriptions).sort()).toEqual([u, v].sort());
      expect(w.recordOf(v).active).toMatchObject({ tierId: 'umid', endDate: null });
      expect(w.calls()).toEqual([]);
      expect(brokenStacking(w.stored())).toEqual([]);
      expect(brokenHolders(w.stored())).toEqual([]);
    } finally {
      await w.teardown();
    }
  });

  it('brokenStacking names each K a document breaks', () => {
    const tiers = { low: { priority: 1 }, high: { priority: 3 } };
    const sub = (id: string, tierId: string, source: string, status: string, providerSubId?: string) => ({ id, tierId, source, status, ...(providerSubId ? { providerId: 'p', providerSubId } : {}) });
    const doc = (record: object) => ({ tiers, subscriptions: { r: record } });
    expect(brokenStacking(doc({ active: sub('a', 'high', 'manual', 'active'), paused: [sub('b', 'low', 'paid', 'paused', 'x')] }))).toEqual([]);
    expect(brokenStacking(doc({ active: sub('a', 'high', 'manual', 'active'), paused: [sub('b', 'low', 'paid', 'active', 'x')] }))[0]).toMatch(/^K1: /);
    expect(brokenStacking(doc({ active: sub('a', 'high', 'manual', 'active'), paused: [sub('a', 'low', 'paid', 'paused', 'x')] }))[0]).toMatch(/^K2: /);
    expect(brokenStacking(doc({ active: sub('a', 'high', 'paid', 'active', 'x'), paused: [sub('b', 'low', 'paid', 'paused', 'x')] }))[0]).toMatch(/^K2: /);
    expect(brokenStacking(doc({ paused: [sub('b', 'low', 'paid', 'paused', 'x')] }))[0]).toMatch(/^K3: /);
    expect(brokenStacking(doc({ active: sub('a', 'high', 'manual', 'active'), paused: [sub('b', 'low', 'paid', 'paused', 'x'), sub('c', 'high', 'manual', 'paused')] }))[0]).toMatch(/^K4: /);
    expect(brokenStacking(doc({ active: sub('a', 'high', 'manual', 'active'), paused: [sub('b', 'low', 'paid', 'paused', 'x'), sub('c', 'low', 'manual', 'paused')] }))[0]).toMatch(/^K4: /);
  });

  it("the users' paid steps reach the stacking: a purchase above a created one queues it, an expiry resumes it, and every paid one names the user as its buyer", async () => {
    await w.setup();
    try {
      await w.addSoldUserTiers();
      const [u, v] = USERS.map(uh);
      expect(await w.created(u, 'vlow')).toMatchObject({ ok: true });
      expect(await w.purchase(u, 'vhigh')).toMatchObject({ ok: true });
      expect(await w.purchase(v, 'vmid')).toMatchObject({ ok: true });
      expect((await w.purchase(v, 'valt')).ok).toBe(false);
      expect((await w.purchase(v, 'high')).ok).toBe(false);
      const queued = w.recordOf(u);
      expect([queued.active.tierId, queued.active.buyerId, queued.paused.map((p: any) => `${p.tierId}/${p.source}/${p.status}/${p.buyerId}`)]).toEqual(['vhigh', USERS[0], [`vlow/paid/paused/${USERS[0]}`]]);
      expect(await w.renewed(u)).toMatchObject({ ok: true });
      expect(await w.expired(u)).toMatchObject({ ok: true });
      expect(w.recordOf(u).active).toMatchObject({ tierId: 'vlow', status: 'active', buyerId: USERS[0] });
      expect(w.recordOf(u).paused).toEqual([]);
      expect(w.recordOf(v).active).toMatchObject({ tierId: 'vmid', buyerId: USERS[1] });
      expect(Object.keys(w.stored().subscriptions).sort()).toEqual([u, v].sort());
      expect(brokenStacking(w.stored())).toEqual([]);
      expect(brokenHolders(w.stored())).toEqual([]);
    } finally {
      await w.teardown();
    }
  });

  it('brokenHolders names N3 on a paid subscription with no buyer, with a buyer that is no Discord id, and on a user\'s paid by someone else', () => {
    const tiers = { low: { priority: 1 }, vip: { priority: 1, kind: 'user' } };
    const paid = (id: string, tierId: string, buyerId?: unknown) => ({ id, tierId, source: 'paid', status: 'active', ...(buyerId === undefined ? {} : { buyerId }) });
    const doc = (subscriptions: object) => ({ tiers, subscriptions });
    expect(brokenHolders(doc({ 'guild:5': { active: paid('a', 'low', '6'), paused: [] }, 'user:5': { active: paid('b', 'vip', '5'), paused: [paid('c', 'vip', '5')] } }))).toEqual([]);
    expect(brokenHolders(doc({ 'guild:5': { active: paid('a', 'low'), paused: [] } }))[0]).toMatch(/^N3: /);
    expect(brokenHolders(doc({ 'guild:5': { active: paid('a', 'low', 'abc'), paused: [] } }))[0]).toMatch(/^N3: /);
    expect(brokenHolders(doc({ 'guild:5': { active: paid('a', 'low', '6'), paused: [paid('b', 'low')] } }))[0]).toMatch(/^N3: /);
    expect(brokenHolders(doc({ 'user:5': { active: paid('a', 'vip', '6'), paused: [] } }))[0]).toMatch(/^N3: /);
  });

  it('brokenHolders names N1 and N2 on a document that breaks them', () => {
    const tiers = { low: { priority: 1 }, vip: { priority: 1, kind: 'user' } };
    const sub = (id: string, tierId: string) => ({ id, tierId, source: 'manual', status: 'active' });
    const doc = (subscriptions: object) => ({ tiers, subscriptions });
    expect(brokenHolders(doc({ 'guild:5': { active: sub('a', 'low'), paused: [] }, 'user:5': { active: sub('b', 'vip'), paused: [sub('c', 'gone')] } }))).toEqual([]);
    expect(brokenHolders(doc({ '5': { active: sub('a', 'low'), paused: [] } }))[0]).toMatch(/^N1: /);
    expect(brokenHolders(doc({ 'guild:05': { active: sub('a', 'low'), paused: [] } }))[0]).toMatch(/^N1: /);
    expect(brokenHolders(doc({ 'guild:5': { active: sub('a', 'vip'), paused: [] } }))[0]).toMatch(/^N2: /);
    expect(brokenHolders(doc({ 'user:5': { active: sub('a', 'vip'), paused: [sub('b', 'low')] } }))[0]).toMatch(/^N2: /);
  });
});
