import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// P2 claims 9 and 10 (part 2): what a failed Dummy write answers, and the crash states S1 to S3 of sheet P2 section 4,
// for a server and for a user. The real DummyProvider beside the real PremiumManager, every change through
// applySharedOp. On the mirror rig an op is refused at its flush by another machine's write (the lock read of its key)
// or loses its answer; on the JSON files the disk refuses state.json alone (the Dummy's folder), as a refused folder
// does. "A new process" is a new DummyProvider and a new PremiumManager over what is stored. S3 is made as a restore
// makes it: state.json's bytes from before the purchases are written back before the new process starts.

const inject = vi.hoisted(() => ({ refuse: new Map<string, string>(), failRename: new Set<string>() }));
vi.mock('fs', async orig => {
  const real = await orig<any>();
  const nodePath = await import('path');
  const promises = {
    ...real.promises,
    rename: async (from: any, to: any) => {
      if (inject.failRename.has(nodePath.resolve(String(to)))) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return real.promises.rename(from, to);
    },
  };
  const wrapped = { ...real, promises };
  return { ...wrapped, default: wrapped };
});
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  const ledger = await import('../../src/bot/internalSetup/utils/dataBackends/writeLedger');
  // 'io' is answered as the facade answers a write it could not place; any other cause is thrown as the backend throws it.
  const guard = (filename: string, options: any): any => {
    const cause = inject.refuse.get(filename);
    if (!cause) return null;
    ledger.recordRefusal(cause as any, `global:${options.category ?? ''}/${filename}`);
    if (cause === 'io') return { outcome: 'refused', cause: 'io' };
    throw new real.DataBackendUnavailableError(cause as any);
  };
  return { ...real, saveDataTracked: (f: string, o: any, d: unknown) => guard(f, o) ?? real.saveDataTracked(f, o, d) };
});
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { unconfirmUnansweredRows } from '../../src/bot/internalSetup/utils/sharedStore';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { PREMIUM_KEY } from '../helpers/nb6PremiumRig';
import { gh, uh } from '../helpers/p1Holder';
import { allowDropLines, droppedLines } from '../helpers/p1Guard';
import { notices } from '../helpers/p1Mocks';
import { BUYER, PREMIUM, SERVERS, p1World } from '../helpers/p1World';
import { DUMMY_KEY, DUMMY_PATH, brokenAgreement, dummyDriver, ownerOf } from '../helpers/p2DummyDriver';

const A = SERVERS[0];
const B = SERVERS[1];
const DAY_MS = 86_400_000;
const LOCK_READ = 'SELECT body, sha, updated_by, updated_at FROM smdb_data.shared_docs';
const ELSEWHERE = 'another machine changed premium-tiers.json (or the Dummy state) at the same time';
const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'p2');
const COUPON = { code: 'P2CRASH', percentOff: 10, usedCount: 0, createdAt: '2026-11-21T00:00:00.000Z' };

const T20 = (words: string) => `The Dummy provider did not save this change (${words}), so nothing was changed at the provider.`;
const T23 = (reason: string) => `Can't confirm that the Dummy provider saved this change (${reason}), so the bot did not apply it. Check the subscription before trying again.`;
const SERVER_TAIL = ' If the purchase was saved, it is listed under "Subscriptions needing attention" on this server\'s subscription page, where it can be adopted or cancelled.';
const DT1 = " If the purchase was saved, the Dummy provider holds it for this user and the bot does not. A bot dev can adopt or cancel it under \"Test purchase\" in the Dummy Provider Settings.";
const TH1 = 'the disk did not take the write and the Dummy provider is trying again';
const NOT_FOUND = (id: string) => `Dummy subscription '${id}' not found.`;
const PL1 = (id: string, words: string) => `[PremiumManager] The Dummy provider holds no record of subscription ${id} (${words}), so nothing was cancelled there; the bot's copy was removed.`;
const T26 = '[DummyProvider] Subscription ';

/** The kinds a row runs for: its holder, its other holders, its two tiers (low queues behind high) and its tail. */
const KINDS = [
  { kind: 'server', who: gh(A), others: [uh(A), gh(B), uh(B)], low: 'low', high: 'high', buyer: BUYER, words: `guild ${A}`, tail: SERVER_TAIL },
  { kind: 'user', who: uh(A), others: [gh(A), gh(B), uh(B)], low: 'vlow', high: 'vhigh', buyer: A, words: `user ${A}`, tail: DT1 },
] as const;

type Driver = ReturnType<typeof dummyDriver>;
type World = ReturnType<typeof p1World>;
let current: { w: World; driver: Driver } | null = null;
const role = process.env.BOT_PROCESS_ROLE;

async function world(backend: 'json' | 'rig'): Promise<{ w: World; driver: Driver }> {
  const driver = dummyDriver();
  const w = p1World(backend, driver);
  current = { w, driver };
  await w.setup();
  await w.addSoldUserTiers();
  return current;
}

afterEach(async () => {
  inject.refuse.clear();
  inject.failRename.clear();
  process.env.BOT_PROCESS_ROLE = 'bot';
  if (current) {
    if (current.w.rig) current.w.rig.m.state.rows.fault = undefined;
    await current.w.teardown();
  }
  current = null;
  vi.restoreAllMocks();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

/** Every console.warn and console.error line from now on. */
function warnings(): () => string[] {
  const lines: string[] = [];
  for (const level of ['warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  }
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return () => lines;
}

/** Runs fn once, at the first lock read of `key` on the rig (its op holds the key then): another machine's write. */
function atLockRead(w: World, key: string, fn: () => void): void {
  const rows = w.rig!.m.state.rows;
  let done = false;
  rows.fault = async (sql, params) => {
    if (!done && sql.startsWith(LOCK_READ) && params?.[0] === key) {
      done = true;
      fn();
    }
    return undefined;
  };
}

/** The next save of premium-tiers.json is refused at its flush: another machine changed the row first. */
function premiumRefused(w: World): void {
  atLockRead(w, PREMIUM_KEY, () => {
    const config = JSON.parse(w.rig!.m.state.rows.docs.get(PREMIUM_KEY)!.body.toString('utf8'));
    config.messages = { ...(config.messages ?? {}), moduleBlocked: `from another machine ${Date.now()}` };
    w.rig!.m.state.rows.put(PREMIUM_KEY, JSON.stringify(config, null, 2));
  });
}

/** The next save of state.json is refused at its flush: another machine wrote the Dummy's state first. */
function dummyRefused(w: World): void {
  atLockRead(w, DUMMY_KEY, () => {
    const row = w.rig!.m.state.rows.docs.get(DUMMY_KEY);
    const state = row ? JSON.parse(row.body.toString('utf8')) : { variants: {}, products: {}, coupons: {}, subscriptions: {}, nextId: 5 };
    state.coupons = { ...state.coupons, ELSEWHERE: { ...COUPON, code: 'ELSEWHERE' } };
    w.rig!.m.state.rows.put(DUMMY_KEY, JSON.stringify(state, null, 2));
  });
}

/** Premium's save after the next Dummy op committed is refused at its flush (the tick's walk batch, applied after the Dummy's save landed). */
function premiumRefusedAfterDummy(w: World): void {
  const rows = w.rig!.m.state.rows;
  let stage = 0;
  rows.fault = async (sql, params) => {
    if (stage === 0 && sql.startsWith(LOCK_READ) && params?.[0] === DUMMY_KEY) stage = 1;
    else if (stage === 1 && sql === 'COMMIT') stage = 2;
    else if (stage === 2 && sql.startsWith(LOCK_READ) && params?.[0] === PREMIUM_KEY) {
      stage = 3;
      const config = JSON.parse(rows.docs.get(PREMIUM_KEY)!.body.toString('utf8'));
      config.messages = { ...(config.messages ?? {}), moduleBlocked: `from another machine ${Date.now()}` };
      rows.put(PREMIUM_KEY, JSON.stringify(config, null, 2));
    }
    return undefined;
  };
}

async function clearFault(w: World): Promise<void> {
  if (w.rig) w.rig.m.state.rows.fault = undefined;
  await runSharedPass();
}

/** A new process for both: a new DummyProvider and a new PremiumManager over what is stored. */
async function newProcess(w: World, driver: Driver): Promise<void> {
  await w.settle();
  await driver.detach();
  await driver.attach(w.rig);
  await w.reload();
}

const idOf = (reply: any): string => reply.result.providerSubId as string;
const started = (who: string) => notices.sent.filter(n => n.to === who && n.kind.startsWith('paid.sub.started'));
const answerOf = (who: string, id: string): any => getPaymentRegistry().readSubscription('dummy', who as any, id);
const viewOf = (r: any) => ({ status: r.paused ? 'paused' : r.status, endDate: r.endDate, autoRenew: r.autoRenew });
const listed = async (driver: Driver, who: string): Promise<string[]> => (await driver.provider().listSubscriptionsFor(who as any)).map(l => l.providerSubId);

describe.each(KINDS)('for a $kind', k => {
  describe('claim 9 on the mirror rig: a Dummy op that does not land', () => {
    it("a purchase whose Dummy op is refused answers T20; premium stores nothing and no notice is sent", async () => {
      const { w } = await world('rig');
      notices.sent.length = 0;
      dummyRefused(w);
      const reply = await w.purchase(k.who, k.low);
      await clearFault(w);
      expect(reply.ok).toBe(false);
      expect(reply.error).toContain(T20(ELSEWHERE));
      expect(w.recordOf(k.who)).toBeNull();
      expect(started(k.who)).toEqual([]);
    });

    it("a purchase whose answer is lost answers T23 with the tail of its kind; premium installs nothing", async () => {
      const { w, driver } = await world('rig');
      notices.sent.length = 0;
      const rows = w.rig!.m.state.rows;
      let lost = false;
      rows.fault = sql => {
        if (!lost && sql === 'COMMIT') {
          lost = true;
          return 'lose';
        }
        return undefined;
      };
      const buying = w.purchase(k.who, k.low);
      await vi.waitFor(() => expect(Object.keys(driver.document()?.subscriptions ?? {})).toHaveLength(1), { timeout: 8000, interval: 20 });
      unconfirmUnansweredRows('the test ended it');
      const reply = await buying;
      await clearFault(w);
      expect(reply.ok).toBe(false);
      expect(reply.error).toContain(`${T23("the database's answer was lost")}${k.tail}`);
      expect(w.recordOf(k.who)).toBeNull();
      expect(started(k.who)).toEqual([]);
    });

    it.each([
      ['cancel at period end', 'cancelPaidSubscription'],
      ['renew again', 'reactivatePaidSubscription'],
      ['cancel now', 'cancelPaidSubscriptionImmediately'],
    ])("%s whose Dummy op is refused answers not ok and premium's copy is unchanged", async (_name, op) => {
      const { w, driver } = await world('rig');
      expect((await w.purchase(k.who, k.low)).ok).toBe(true);
      if (op === 'reactivatePaidSubscription') expect((await w.op('cancelPaidSubscription', k.who)).ok).toBe(true);
      const before = w.recordOf(k.who);
      const recordBefore = driver.document().subscriptions;
      dummyRefused(w);
      const reply = await w.op(op, k.who);
      await clearFault(w);
      expect(reply.ok).toBe(false);
      expect(reply.error).toContain(T20(ELSEWHERE));
      expect(w.recordOf(k.who)).toEqual(before);
      expect(driver.document().subscriptions).toEqual(recordBefore);
    });
  });

  describe('claim 9 on the JSON files', () => {
    it('in the web UI role: a state.json write the disk refuses answers not ok and both files keep their bytes', async () => {
      const { w, driver } = await world('json');
      expect((await w.purchase(k.who, k.low)).ok).toBe(true);
      const before = { premium: w.storedText(), dummy: driver.bytes() };
      delete process.env.BOT_PROCESS_ROLE;
      inject.refuse.set('state.json', 'storage-failing');
      const reply = await w.purchase(k.who, k.high);
      inject.refuse.clear();
      process.env.BOT_PROCESS_ROLE = 'bot';
      await w.settle();
      expect(reply.ok).toBe(false);
      expect(reply.error).toContain(T20('storage-failing'));
      expect({ premium: w.storedText(), dummy: driver.bytes() }).toEqual(before);
    });

    it('in the bot role with the Dummy folder refusing writes: a purchase answers T23 with TH1 and installs nothing; the retry stores it, it is listed for its holder alone, and adopting it installs it', async () => {
      const { w, driver } = await world('json');
      notices.sent.length = 0;
      const premiumBefore = w.storedText();
      inject.refuse.set('state.json', 'storage-failing');
      const reply = await w.purchase(k.who, k.low);
      expect(reply.ok).toBe(false);
      expect(reply.error).toContain(`${T23(TH1)}${k.tail}`);
      expect(w.storedText()).toBe(premiumBefore);
      expect(w.recordOf(k.who)).toBeNull();
      expect(started(k.who)).toEqual([]);

      inject.refuse.clear();
      await vi.waitFor(() => expect(Object.keys(driver.document()?.subscriptions ?? {})).toHaveLength(1), { timeout: 8000, interval: 50 });
      await w.settle();
      const id = Object.keys(driver.document().subscriptions)[0];
      expect(driver.document().subscriptions[id]).toMatchObject({ holder: k.who, buyerId: k.buyer, status: 'active' });
      expect(await listed(driver, k.who)).toEqual([id]);
      for (const other of k.others) expect(await listed(driver, other)).toEqual([]);

      const orphans = await w.orphans(k.who);
      expect(orphans.map(o => [o.ref.providerSubId, o.plan.kind])).toEqual([[id, 'install']]);
      expect(await w.adopt(k.who, id, orphans[0].plan)).toMatchObject({ ok: true });
      expect(w.recordOf(k.who).active).toMatchObject({ providerId: 'dummy', providerSubId: id, buyerId: k.buyer });
    }, 30_000);

    it.each([
      ['storage-failing', TH1, 'the disk refused'],
      ['io', TH1, 'the disk refused'],
    ])('in the bot role, a purchase whose state.json save is held (%s) answers T23 with the reason of that cause, and the last stop names it', async (cause, reason, held) => {
      const lines = warnings();
      const { w, driver } = await world('json');
      inject.refuse.set('state.json', cause);
      const reply = await w.purchase(k.who, k.low);
      expect(reply.ok).toBe(false);
      expect(reply.error).toContain(`${T23(reason)}${k.tail}`);
      expect(w.recordOf(k.who)).toBeNull();
      driver.provider().finalStop();
      expect(lines().filter(l => l.includes('holds changes'))).toEqual([`[DummyProvider] payment-providers/dummy/state.json holds changes ${held}; they are lost with this stop`]);
    });

    it('in the bot role with the Dummy folder refusing writes: a cancel at period end answers held, and after the retry both files hold autoRenew off', async () => {
      const { w, driver } = await world('json');
      const bought = await w.purchase(k.who, k.low);
      expect(bought.ok).toBe(true);
      inject.refuse.set('state.json', 'storage-failing');
      const reply = await w.op('cancelPaidSubscription', k.who);
      expect(reply.ok).toBe(false);
      expect((reply as any).answer).toBe('held');
      inject.refuse.clear();
      await vi.waitFor(() => expect(driver.view(idOf(bought))?.autoRenew).toBe(false), { timeout: 8000, interval: 50 });
      await w.settle();
      expect(w.recordOf(k.who).active.autoRenew).toBe(false);
    }, 30_000);
  });

  describe('claim 10, S1: the Dummy holds a live record and premium holds no copy', () => {
    /** A purchase whose install premium's row refused, then a new process; answers the record's id. */
    async function s1(w: World, driver: Driver): Promise<string> {
      premiumRefused(w);
      const reply = await w.purchase(k.who, k.low);
      await clearFault(w);
      expect(reply.ok).toBe(false);
      expect(w.recordOf(k.who)).toBeNull();
      const ids = Object.keys(driver.document().subscriptions);
      expect(ids).toHaveLength(1);
      await newProcess(w, driver);
      return ids[0];
    }

    it('it is listed for its holder alone, refuses a second purchase, is not installed by five ticks, and adopting it installs it under the holder with its buyer', async () => {
      const { w, driver } = await world('rig');
      const id = await s1(w, driver);
      const orphans = await w.orphans(k.who);
      expect(orphans.map(o => [o.ref.providerSubId, o.plan.kind])).toEqual([[id, 'install']]);
      for (const other of k.others) expect(await listed(driver, other)).toEqual([]);

      const again = await w.purchase(k.who, k.low);
      expect(again.ok).toBe(false);
      expect(again.error).toContain(`Provider 'dummy' already has 1 subscription(s) for this ${k.kind === 'user' ? 'user' : 'guild'} that aren't tracked locally (${id}).`);
      expect(Object.keys(driver.document().subscriptions)).toEqual([id]);

      for (let i = 0; i < 5; i++) await w.tick();
      expect(await listed(driver, k.who)).toEqual([id]);
      expect(w.recordOf(k.who)).toBeNull();

      expect(await w.adopt(k.who, id, orphans[0].plan)).toMatchObject({ ok: true });
      const active = w.recordOf(k.who).active;
      expect(active).toMatchObject({ providerId: 'dummy', providerSubId: id, buyerId: k.buyer });
      const record = driver.document().subscriptions[id];
      expect([ownerOf(record), record.buyerId]).toEqual([k.who, active.buyerId]);
      expect(await listed(driver, k.who)).toEqual([id]);
      expect((await w.orphans(k.who)).map(o => o.ref.providerSubId)).toEqual([]);
      for (const other of k.others) expect(await listed(driver, other)).toEqual([]);
      expect(await brokenAgreement(w.stored(), driver, driver.document(), false, [k.who, ...k.others])).toEqual([]);
    }, 30_000);

    it('cancelling it at the provider leaves it expired and unlisted, and a new purchase is accepted', async () => {
      const { w, driver } = await world('rig');
      const id = await s1(w, driver);
      expect(await w.op('cancelOrphan', 'dummy', id)).toMatchObject({ ok: true });
      expect(driver.view(id)?.status).toBe('expired');
      expect(await listed(driver, k.who)).toEqual([]);
      const next = await w.purchase(k.who, k.low);
      expect(next).toMatchObject({ ok: true });
      expect(w.recordOf(k.who).active.providerSubId).toBe(idOf(next));
    }, 30_000);
  });

  describe("claim 10, S2: the Dummy's save stored and premium's refused", () => {
    /** Each case leaves S2 and answers the id whose view is compared, and what the end must be afterwards. */
    const cases: Array<[string, (w: World, driver: Driver) => Promise<string>]> = [
      ['cancel at period end', async w => {
        const bought = await w.purchase(k.who, k.low);
        premiumRefused(w);
        expect((await w.op('cancelPaidSubscription', k.who)).ok).toBe(false);
        return idOf(bought);
      }],
      ['renew again', async w => {
        const bought = await w.purchase(k.who, k.low);
        expect((await w.op('cancelPaidSubscription', k.who)).ok).toBe(true);
        premiumRefused(w);
        expect((await w.op('reactivatePaidSubscription', k.who)).ok).toBe(false);
        return idOf(bought);
      }],
      ['cancel now', async w => {
        const bought = await w.purchase(k.who, k.low);
        premiumRefused(w);
        expect((await w.cancelNow(k.who)).ok).toBe(false);
        return idOf(bought);
      }],
      ['the resume of the next', async w => {
        const high = await w.purchase(k.who, k.high);
        const low = await w.purchase(k.who, k.low);
        expect(w.recordOf(k.who).paused.map((p: any) => p.providerSubId)).toEqual([idOf(low)]);
        premiumRefused(w);
        expect((await w.cancelNow(k.who)).ok).toBe(false);
        expect(w.recordOf(k.who).active.providerSubId).toBe(idOf(high));
        return idOf(low);
      }],
    ];

    it.each(cases)('%s: after two ticks in a new process the record equals premium\'s copy and T26 is logged', async (_name, make) => {
      const lines = warnings();
      const { w, driver } = await world('rig');
      const id = await make(w, driver);
      await clearFault(w);
      const held = (): any => [w.recordOf(k.who)?.active, ...(w.recordOf(k.who)?.paused ?? [])].find(s => s?.providerSubId === id);
      const premiumBefore = held();
      expect(premiumBefore).toBeDefined();
      expect(viewOf(driver.document().subscriptions[id])).not.toEqual(viewOf(answerOf(k.who, id)));
      await newProcess(w, driver);
      await w.tick();
      await w.tick();
      expect(viewOf(driver.document().subscriptions[id])).toEqual(viewOf(answerOf(k.who, id)));
      expect(held()).toEqual(premiumBefore);
      expect([...lines(), ...(w.logged(T26))].some(l => l.startsWith(`${T26}${id} now matches the bot's copy`))).toBe(true);
    }, 30_000);

    it("the pause after a higher purchase whose premium save is refused: after two ticks in a new process the paused one equals premium's answer, T26 is logged, and the higher one is listed for its holder alone", async () => {
      const lines = warnings();
      const { w, driver } = await world('rig');
      const low = idOf(await w.purchase(k.who, k.low));
      const before = new Set(Object.keys(driver.document().subscriptions));
      premiumRefused(w);
      const bought = await w.purchase(k.who, k.high);
      await clearFault(w);
      expect(bought.ok).toBe(false);
      const high = Object.keys(driver.document().subscriptions).filter(id => !before.has(id));
      expect(high).toHaveLength(1);
      expect(w.recordOf(k.who).active).toMatchObject({ providerSubId: low, status: 'active' });
      expect(w.recordOf(k.who).paused).toEqual([]);
      expect(driver.view(low)?.status).toBe('paused');
      expect(viewOf(driver.document().subscriptions[low])).not.toEqual(viewOf(answerOf(k.who, low)));

      await newProcess(w, driver);
      await w.tick();
      await w.tick();
      expect(viewOf(driver.document().subscriptions[low])).toEqual(viewOf(answerOf(k.who, low)));
      expect([...lines(), ...(w.logged(T26))].some(l => l.startsWith(`${T26}${low} now matches the bot's copy`))).toBe(true);
      const orphans = await w.orphans(k.who);
      expect(orphans.map(o => [o.ref.providerSubId, o.plan.kind])).toEqual([[high[0], 'install']]);
      for (const other of k.others) expect(await listed(driver, other)).toEqual([]);
    }, 30_000);

    it('a renewal premium did not store is written back, then sent again and applied once: the end moves one period', async () => {
      const lines = warnings();
      const { w, driver } = await world('rig');
      const bought = await w.purchase(k.who, k.low);
      const id = idOf(bought);
      const endBefore = Date.parse(w.recordOf(k.who).active.endDate);
      w.advance(31);
      premiumRefusedAfterDummy(w);
      await w.tick();
      await clearFault(w);
      expect(Date.parse(driver.document().subscriptions[id].endDate)).toBe(endBefore + 30 * DAY_MS);
      expect(Date.parse(w.recordOf(k.who).active.endDate)).toBe(endBefore);

      await newProcess(w, driver);
      // A new process keeps the wall clock: the driver starts its fake clock from the real time again.
      w.advance(31);
      await w.tick();
      await w.tick();
      expect(viewOf(driver.document().subscriptions[id])).toEqual(viewOf(answerOf(k.who, id)));
      expect([...lines(), ...(w.logged(T26))].some(l => l.startsWith(`${T26}${id} now matches the bot's copy`))).toBe(true);
      await w.tick();
      expect(Date.parse(w.recordOf(k.who).active.endDate)).toBe(endBefore + 30 * DAY_MS);
      expect(Date.parse(driver.document().subscriptions[id].endDate)).toBe(endBefore + 30 * DAY_MS);
    }, 30_000);

    it('an expiry premium did not store is written back, then sent again and applied once: it is gone from both and the next is resumed', async () => {
      const lines = warnings();
      const { w, driver } = await world('rig');
      const high = await w.purchase(k.who, k.high);
      const low = await w.purchase(k.who, k.low);
      expect((await w.op('cancelPaidSubscription', k.who)).ok).toBe(true);
      w.advance(31);
      premiumRefusedAfterDummy(w);
      await w.tick();
      await clearFault(w);
      expect(driver.view(idOf(high))?.status).toBe('expired');
      expect(w.recordOf(k.who).active.providerSubId).toBe(idOf(high));

      await newProcess(w, driver);
      w.advance(31);
      await w.tick();
      await w.tick();
      expect(viewOf(driver.document().subscriptions[idOf(low)])).toEqual(viewOf(answerOf(k.who, idOf(low))));
      expect([...lines(), ...(w.logged(T26))].some(l => l.startsWith(`${T26}${idOf(high)} now matches the bot's copy`))).toBe(true);
      await w.tick();
      expect(driver.view(idOf(high))?.status).toBe('expired');
      expect(w.recordOf(k.who).active.providerSubId).toBe(idOf(low));
      expect(w.recordOf(k.who).paused).toEqual([]);
      expect(driver.view(idOf(low))?.status).toBe('active');
      expect(w.auditLines().filter(l => l.subscriptionId === w.recordOf(k.who).active.id && l.action === 'subscription.resume' && !l.metadata?.notSaved)).toHaveLength(1);
    }, 30_000);
  });

  describe('claim 10, S3: premium holds a copy and the Dummy has no record (state.json restored)', () => {
    /** A Dummy save, the purchases of low then high (low queued), then state.json written back to its earlier bytes and a new process. */
    async function s3(w: World, driver: Driver, cancelFirst: boolean): Promise<{ low: string; high: string; bytes: string }> {
      expect(driver.provider().adminSetCoupon({ ...COUPON })).toBe(true);
      await w.settle();
      const bytes = driver.bytes();
      expect(bytes).not.toBe('');
      const low = idOf(await w.purchase(k.who, k.low));
      const high = idOf(await w.purchase(k.who, k.high));
      if (cancelFirst) expect((await w.op('cancelPaidSubscription', k.who)).ok).toBe(true);
      await w.settle();
      await driver.detach();
      fs.writeFileSync(DUMMY_PATH, bytes);
      await driver.attach(null);
      await w.reload();
      return { low, high, bytes };
    }

    it('ten ticks change neither document; cancel at period end answers not found; End now removes it with PL1 and the next is active', async () => {
      const lines = warnings();
      const { w, driver } = await world('json');
      const { low, high, bytes } = await s3(w, driver, false);
      const premiumBytes = w.storedText();
      for (let i = 0; i < 10; i++) await w.tick();
      expect(w.storedText()).toBe(premiumBytes);
      expect(driver.bytes()).toBe(bytes);

      const cancel = await w.op('cancelPaidSubscription', k.who);
      expect(cancel.ok).toBe(false);
      expect(cancel.error).toContain(NOT_FOUND(high));
      expect(w.storedText()).toBe(premiumBytes);

      const ended = await w.cancelNow(k.who);
      expect(ended).toMatchObject({ ok: true, result: true });
      expect(w.recordOf(k.who).active).toMatchObject({ providerSubId: low, status: 'active' });
      expect(w.recordOf(k.who).paused).toEqual([]);
      const audit = w.auditLines().filter(l => l.action === 'subscription.cancel.paid');
      expect(audit[audit.length - 1]).toMatchObject({ holder: k.who, metadata: { immediately: true, providerRecordMissing: true } });
      expect(lines().filter(l => l.startsWith('[PremiumManager] The Dummy provider holds no record'))).toEqual([PL1(high, k.words)]);
      expect(driver.bytes()).toBe(bytes);
    }, 30_000);

    it('renew again answers not found; the queued one is removed through cancelAndRemovePausedSubscription with PL1', async () => {
      const lines = warnings();
      const { w, driver } = await world('json');
      const { low, high, bytes } = await s3(w, driver, true);
      const premiumBytes = w.storedText();

      const renew = await w.op('reactivatePaidSubscription', k.who);
      expect(renew.ok).toBe(false);
      expect(renew.error).toContain(NOT_FOUND(high));
      expect(w.storedText()).toBe(premiumBytes);

      expect(await w.cancelQueued(k.who, 0)).toMatchObject({ ok: true, result: true });
      expect(w.recordOf(k.who).paused).toEqual([]);
      expect(w.recordOf(k.who).active.providerSubId).toBe(high);
      const audit = w.auditLines().filter(l => l.action === 'subscription.cancel.paid');
      expect(audit[audit.length - 1]).toMatchObject({ holder: k.who, metadata: { fromPausedQueue: true, providerRecordMissing: true } });
      expect(lines().filter(l => l.startsWith('[PremiumManager] The Dummy provider holds no record'))).toEqual([PL1(low, k.words)]);
      expect(driver.bytes()).toBe(bytes);
    }, 30_000);
  });

  describe("PL1 is written once premium's removal lands", () => {
    const pl1Lines = (lines: () => string[], w: World): string[] =>
      [...lines(), ...w.logged('[PremiumManager] The Dummy provider holds no record')].filter(l => l.startsWith('[PremiumManager] The Dummy provider holds no record'));

    it("on the mirror rig, End now whose premium save another machine's write refuses logs no PL1 and premium keeps the copy; End now again logs it once", async () => {
      const lines = warnings();
      const { w, driver } = await world('rig');
      expect(driver.provider().adminSetCoupon({ ...COUPON })).toBe(true);
      await w.settle();
      const bytes = driver.bytes();
      const low = idOf(await w.purchase(k.who, k.low));
      const high = idOf(await w.purchase(k.who, k.high));
      await w.settle();
      await driver.detach();
      w.rig!.m.state.rows.put(DUMMY_KEY, bytes);
      await runSharedPass();
      await driver.attach(w.rig);
      await w.reload();
      expect(driver.view(high)).toBeNull();

      premiumRefused(w);
      const ended = await w.cancelNow(k.who);
      await clearFault(w);
      expect(ended.ok).toBe(false);
      expect(pl1Lines(lines, w)).toEqual([]);
      expect(w.recordOf(k.who).active.providerSubId).toBe(high);

      expect(await w.cancelNow(k.who)).toMatchObject({ ok: true, result: true });
      expect(w.recordOf(k.who).active.providerSubId).toBe(low);
      expect(pl1Lines(lines, w)).toEqual([PL1(high, k.words)]);
    }, 30_000);

    it('on the JSON files, End now whose premium save is held logs no PL1 until the retry stores the removal, then logs it once', async () => {
      const lines = warnings();
      const { w, driver } = await world('json');
      expect(driver.provider().adminSetCoupon({ ...COUPON })).toBe(true);
      await w.settle();
      const bytes = driver.bytes();
      const low = idOf(await w.purchase(k.who, k.low));
      const high = idOf(await w.purchase(k.who, k.high));
      await w.settle();
      await driver.detach();
      fs.writeFileSync(DUMMY_PATH, bytes);
      await driver.attach(null);
      await w.reload();
      const premiumBytes = w.storedText();

      inject.refuse.set('premium-tiers.json', 'storage-failing');
      const ended = await w.cancelNow(k.who);
      expect(ended.ok).toBe(false);
      expect(pl1Lines(lines, w)).toEqual([]);
      expect(w.storedText()).toBe(premiumBytes);

      inject.refuse.clear();
      await vi.waitFor(() => expect(w.recordOf(k.who)?.active?.providerSubId).toBe(low), { timeout: 8000, interval: 50 });
      await w.settle();
      expect(pl1Lines(lines, w)).toEqual([PL1(high, k.words)]);
    }, 30_000);

    it('on the JSON files, End now whose premium-tiers.json flush fails after the save was accepted logs no PL1 until the flush lands, then logs it once', async () => {
      const lines = warnings();
      const { w, driver } = await world('json');
      expect(driver.provider().adminSetCoupon({ ...COUPON })).toBe(true);
      await w.settle();
      const bytes = driver.bytes();
      const low = idOf(await w.purchase(k.who, k.low));
      const high = idOf(await w.purchase(k.who, k.high));
      await w.settle();
      await driver.detach();
      fs.writeFileSync(DUMMY_PATH, bytes);
      await driver.attach(null);
      await w.reload();
      const premiumBytes = w.storedText();

      inject.failRename.add(path.resolve(PREMIUM));
      const ended = await w.cancelNow(k.who);
      expect(ended).toMatchObject({ ok: false, answer: 'held' });
      expect(w.storedText()).toBe(premiumBytes);
      expect(pl1Lines(lines, w)).toEqual([]);
      expect(w.recordOf(k.who).active.providerSubId).toBe(high);

      inject.failRename.clear();
      await vi.waitFor(() => expect(pl1Lines(lines, w)).toHaveLength(1), { timeout: 20_000, interval: 50 });
      await w.settle();
      expect(w.recordOf(k.who).active.providerSubId).toBe(low);
      expect(pl1Lines(lines, w)).toEqual([PL1(high, k.words)]);
    }, 60_000);
  });

  it("T12: the cancel of a found record premium now holds is refused before the provider call, and the record stays live", async () => {
    const { w, driver } = await world('json');
    const id = idOf(await w.purchase(k.who, k.low));
    const before = { premium: w.storedText(), dummy: driver.bytes() };
    const calls = driver.calls().length;
    const reply = await w.op('cancelOrphan', 'dummy', id);
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe(`Subscription '${id}' was not cancelled at the provider: the bot holds it as a subscription. Reload the page to see it.`);
    expect(driver.calls().slice(calls)).toEqual([]);
    expect(driver.view(id)?.status).toBe('active');
    expect({ premium: w.storedText(), dummy: driver.bytes() }).toEqual(before);
  });

  it("T19: the cancel of a found record whose provider call throws answers the provider's error with the provider sentence", async () => {
    const { w, driver } = await world('json');
    const id = await driver.unheld(w, k.who, k.low);
    const before = { premium: w.storedText(), dummy: driver.bytes() };
    const asked: unknown[][] = [];
    (driver.provider() as any).cancelSubscription = async (...args: unknown[]) => {
      asked.push(args);
      throw new Error('The Dummy provider could not store the cancel.');
    };
    const reply = await w.op('cancelOrphan', 'dummy', id);
    expect(asked).toEqual([[id, true]]);
    expect(reply).toMatchObject({ ok: false, code: 'failed' });
    expect(reply.error).toBe("The Dummy provider could not store the cancel. A payment provider call this change made may already have taken effect; check the provider's dashboard.");
    expect(driver.view(id)?.status).toBe('active');
    expect({ premium: w.storedText(), dummy: driver.bytes() }).toEqual(before);
  });
});

describe("S5: a provider other than the Dummy whose cancel fails with the code 'not-found'", () => {
  it('End now answers not ok, premium keeps the subscription, and no PL1 is logged', async () => {
    const lines = warnings();
    const w = p1World('json');
    current = { w, driver: null as unknown as Driver };
    await w.setup();
    const bought = await w.purchase(A, 'low');
    expect(bought.ok).toBe(true);
    const before = w.storedText();
    w.seller.cancelSubscription = async () => { throw Object.assign(new Error('P1 Seller has no such subscription'), { code: 'not-found' }); };
    const ended = await w.cancelNow(A);
    expect(ended.ok).toBe(false);
    expect(ended.error).toContain('P1 Seller has no such subscription');
    expect(w.storedText()).toBe(before);
    expect(lines().filter(l => l.includes('holds no record'))).toEqual([]);
  });
});

describe("the last stop's log on the mirror rig, for a Dummy save the database did not take", () => {
  it.each(['database-backlog', 'database-unreachable'])('a save held for %s is named in database words', async cause => {
    const lines = warnings();
    const { w, driver } = await world('rig');
    inject.refuse.set('state.json', cause);
    driver.provider().adminSetCoupon({ ...COUPON });
    driver.provider().finalStop();
    expect([...lines(), ...w.logged('holds changes')].filter(l => l.includes('holds changes'))).toEqual(['[DummyProvider] payment-providers/dummy/state.json holds changes the database did not take; they are lost with this stop']);
  });
});

describe('claim 10, S3 from the P1 fixtures: the dropped records, then End now', () => {
  it('after the load DL1 is logged, and End now removes each server\'s subscriptions with PL1', async () => {
    allowDropLines('DL1');
    const lines = warnings();
    const premiumText = fs.readFileSync(path.join(FIXTURES, 'premium-tiers.p1.json'), 'utf8');
    const dummyText = fs.readFileSync(path.join(FIXTURES, 'dummy-state.p1.json'), 'utf8');
    const driver = dummyDriver();
    const w = p1World('json', driver);
    current = { w, driver };
    await w.setup({ seed: premiumText });
    await driver.detach();
    fs.mkdirSync(path.dirname(DUMMY_PATH), { recursive: true });
    fs.writeFileSync(DUMMY_PATH, dummyText);
    await driver.attach(null);
    await w.reload();
    expect(await driver.provider().getSubscriptionState('dummy_1')).toBeNull();
    expect(droppedLines('DL1')).toHaveLength(1);

    const servers = Object.keys(w.stored().subscriptions);
    expect(servers.length).toBeGreaterThan(0);
    const ended: string[] = [];
    for (const key of servers) {
      for (let i = 0; i < 5 && w.recordOf(key)?.active?.source === 'paid'; i++) {
        const id = w.recordOf(key).active.providerSubId;
        expect(await w.cancelNow(key)).toMatchObject({ ok: true, result: true });
        ended.push(PL1(id, `guild ${key.slice('guild:'.length)}`));
      }
      expect(w.recordOf(key)?.active ?? null).toBeNull();
    }
    expect(lines().filter(l => l.startsWith('[PremiumManager] The Dummy provider holds no record'))).toEqual(ended);
    expect(driver.bytes()).toBe(dummyText);
  }, 30_000);
});
