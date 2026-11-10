import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { unconfirmUnansweredRows } from '../../src/bot/internalSetup/utils/sharedStore';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { refreshShared, runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { resetPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { setBackendKind } from '../helpers/backendKind';
import { AUDIT_KEY, JOURNAL_KEY, PREMIUM_KEY, premiumRig } from '../helpers/nb6PremiumRig';
import { DAY_MS, DUMMY_KEY, ELSEWHERE, MONTHLY, YEARLY, dummyRig } from '../helpers/nb6DummyRig';

// NB6 test 61 (wip-redesign/sheets/NB6.md decisions 71, 84 to 86, 94 to 96, 102, 108, 110 and 113; rows 268 to 271,
// 273, 274, 282, 283, 304, 316 to 324, 342 to 346, 349 to 351, 378, 379, 381, 392 to 402 and 411 to 415): the Dummy
// provider answers as an external provider, once its op settled, and its tick writes each record premium holds to
// premium's copy at two runs a minute apart, then walks the rest and sends their renewals and expiries to premium as
// one batch carried by its op. The real DummyProvider and the real PremiumManager in the bot process role, the real
// row flush over the scripted shared tables.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  let registry: InstanceType<typeof real.PaymentProviderRegistry> | null = null;
  return { ...real, getPaymentRegistry: () => (registry ??= new real.PaymentProviderRegistry()) };
});
const notices = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async (guildId: string, kind: string) => {
    notices.sent.push(`${kind}:${guildId}`);
    return { delivered: true, via: 'dm' };
  },
}));
const inject = vi.hoisted(() => ({ premium: [] as Array<{ cause: string; thrown: boolean } | null>, dummy: [] as Array<{ cause: string; thrown: boolean } | null> }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => {
      const queue = f === 'premium-tiers.json' ? inject.premium : f === 'state.json' ? inject.dummy : null;
      const refuse = queue && queue.length > 0 ? queue.shift() : null;
      if (refuse) {
        if (refuse.thrown) throw new real.DataBackendUnavailableError(refuse.cause as any);
        return { outcome: 'refused', cause: refuse.cause };
      }
      return real.saveDataTracked(f, o, d);
    },
  };
});

const r = premiumRig();
const d = dummyRig(r);
const LOCK_READ = 'SELECT body, sha, updated_by, updated_at FROM smdb_data.shared_docs';
const CHECK_READ = 'SELECT sha, updated_by, updated_at FROM smdb_data.shared_docs WHERE key = $1';

const T20 = (words: string) => `The Dummy provider did not save this change (${words}), so nothing was changed at the provider.`;
const T26 = (id: string, parts: string) => `[DummyProvider] Subscription ${id} now matches the bot's copy (${parts}); they differed at two checks a minute apart`;
const T16a = (type: string, id: string, words: string) => `[DummyProvider] The ${type} event for subscription ${id} was not sent: the change was not saved (${words})`;
const T34a = (type: string, id: string) => `[PremiumManager] The ${type} event for subscription ${id} was not applied: premium-tiers.json changed after the Dummy provider read it; the Dummy provider compares the subscription with the bot's copy again at its next checks`;

/** Holds every transaction at its BEGIN until released. */
function hold(): () => void {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  r.m.state.rows.fault = sql => (sql.startsWith('BEGIN') ? gate.then(() => undefined) : undefined);
  return () => {
    r.m.state.rows.fault = undefined;
    release();
  };
}

/** Runs fn once, at the first lock read of `key` (its op's transaction holds the key's advisory lock then). */
function atLockRead(key: string, fn: () => void | Promise<void>): void {
  let done = false;
  r.m.state.rows.fault = async (sql, params) => {
    if (!done && sql.startsWith(LOCK_READ) && params?.[0] === key) {
      done = true;
      await fn();
    }
    return undefined;
  };
}

/** Loses the answer of the next COMMIT (the commit is applied). */
function loseNextCommit(): void {
  let done = false;
  r.m.state.rows.fault = sql => {
    if (!done && sql === 'COMMIT') {
      done = true;
      return 'lose';
    }
    return undefined;
  };
}

const premiumSub = (guild = 'g1') => r.row()?.subscriptions?.[guild]?.active;
const t26Lines = () => r.logged('[DummyProvider] Subscription ');
const auditActions = () => r.lines(AUDIT_KEY).map(l => l.action);
const loads = () => r.pm().getAllTiers();

beforeEach(async () => {
  await d.setup();
  notices.sent.length = 0;
  inject.premium.length = 0;
  inject.dummy.length = 0;
});
afterEach(async () => {
  inject.premium.length = 0;
  inject.dummy.length = 0;
  await d.teardown();
});

/** Premium's next save is refused at the flush: another machine changed premium-tiers.json (its messages) first. */
function premiumRefusedElsewhere(): void {
  atLockRead(PREMIUM_KEY, () => {
    const config = r.row();
    config.messages = { ...(config.messages ?? {}), moduleBlocked: `from BRAVO ${Date.now()}` };
    r.m.state.rows.put(PREMIUM_KEY, JSON.stringify(config, null, 2));
  });
}

/** Guild g1's gold sub dummy_1, whose record autoRenew is false while premium's is true: premium's cancel save was refused after the Dummy's op landed. */
async function autoRenewDiffers(guild = 'g1'): Promise<string> {
  const bought = await d.buy(guild);
  premiumRefusedElsewhere();
  expect(await r.pm().cancelPaidSubscription(guild)).toBe(true);
  await d.settle();
  r.m.state.rows.fault = undefined;
  await runSharedPass();
  expect(d.record(bought.providerSubId).autoRenew).toBe(false);
  expect(premiumSub(guild).autoRenew).toBe(true);
  return bought.providerSubId;
}

describe('a Dummy method answers once its op settled (71)', () => {
  it('268: a purchase resolves after its op landed; premium installs it and its items ride the install save', async () => {
    const release = hold();
    let done = false;
    const buying = r.pm().initiatePaidSubscription('g1', 'gold', 'o1', { providerId: 'dummy', variantId: MONTHLY }).then(res => { done = true; return res; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(done).toBe(false);
    expect(premiumSub()).toBeUndefined();
    release();
    const result = await buying;
    await d.settle();
    expect(result.providerSubId).toBe('dummy_1');
    expect(d.record('dummy_1')).toMatchObject({ guildId: 'g1', status: 'active' });
    expect(premiumSub()).toMatchObject({ providerId: 'dummy', providerSubId: 'dummy_1', status: 'active' });
    expect(auditActions()).toContain('subscription.install.paid');
    expect(notices.sent).toEqual(['paid.sub.started:g1']);
  });

  it('269: refused at the accept: T20; nothing installed; the cache dropped, so the next purchase mints the same id', async () => {
    inject.dummy.push({ cause: 'unstorable', thrown: false });
    await expect(d.buy()).rejects.toThrow(T20('unstorable'));
    expect(premiumSub()).toBeUndefined();
    expect(d.record('dummy_1')).toBeNull();
    expect((await d.buy()).providerSubId).toBe('dummy_1');
  });

  it("269: refused at the flush by another machine's write: T20 with decision 27's words; nothing installed; the next purchase mints from the stored state", async () => {
    atLockRead(DUMMY_KEY, () => {
      r.m.state.rows.put(DUMMY_KEY, JSON.stringify({ variants: {}, products: {}, coupons: {}, subscriptions: {}, nextId: 5 }, null, 2));
    });
    await expect(d.buy()).rejects.toThrow(T20(ELSEWHERE));
    r.m.state.rows.fault = undefined;
    expect(premiumSub()).toBeUndefined();
    await runSharedPass();
    d.dummy.adminSetVariant({ variantId: MONTHLY, label: 'Monthly', amount: 999, currency: 'USD', durationDays: 30, recurring: true, active: true });
    await d.settle();
    expect((await d.buy()).providerSubId).toBe('dummy_5');
  });

  it("270: 'unconfirmed': T23's purchase form; nothing installed; the stored record is an orphan", async () => {
    loseNextCommit();
    const buying = d.buy().catch(error => error);
    await vi.waitFor(() => expect(d.record('dummy_1')).not.toBeNull());
    unconfirmUnansweredRows('the test ended it');
    const error = await buying;
    r.m.state.rows.fault = undefined;
    await runSharedPass();
    expect(error.code).toBe('unconfirmed');
    expect(error.reason).toBe("the database's answer was lost");
    expect(error.message).toBe(`Can't confirm that the Dummy provider saved this change (the database's answer was lost), so the bot did not apply it. Check the subscription before trying again. If the purchase was saved, it is listed under "Subscriptions needing attention" on this server's subscription page, where it can be adopted or cancelled.`);
    expect(premiumSub()).toBeUndefined();
    const orphans = await r.pm().findOrphansForGuild('g1');
    expect(orphans.map(o => o.ref.providerSubId)).toEqual(['dummy_1']);
  });

  it('270: past 8 s: T23 with the bound; when the op lands later the record is an orphan', async () => {
    const release = hold();
    const started = performance.now();
    const error = await d.buy().catch(e => e);
    expect(performance.now() - started).toBeGreaterThanOrEqual(7900);
    expect(error.code).toBe('unconfirmed');
    expect(error.reason).toBe('the database did not confirm it within 8 s');
    release();
    await d.settle();
    expect(d.record('dummy_1')).not.toBeNull();
    expect(premiumSub()).toBeUndefined();
  }, 30_000);

  it('271: two machines mint one dummy_N: one record stored; the other machine T20 and a reloaded nextId', async () => {
    const other = d.make();
    other.adminListVariants();
    expect((await d.buy()).providerSubId).toBe('dummy_1');
    const purchase = { guildId: 'g2', tierId: 'gold', offeringId: 'o1', variantId: MONTHLY };
    await expect(other.initiatePurchase(purchase)).rejects.toThrow(T20(ELSEWHERE));
    expect(Object.keys(d.stored().subscriptions)).toEqual(['dummy_1']);
    expect(d.record('dummy_1').guildId).toBe('g1');
    expect((await other.initiatePurchase(purchase)).providerSubId).toBe('dummy_2');
  });

  it('273: a lifecycle op refused at the flush: T20; premium changes nothing', async () => {
    await d.buy();
    const lines = auditActions().length;
    atLockRead(DUMMY_KEY, () => {
      const state = d.stored();
      state.nextId = 9;
      r.m.state.rows.put(DUMMY_KEY, JSON.stringify(state, null, 2));
    });
    await expect(r.pm().cancelPaidSubscription('g1')).rejects.toThrow(T20(ELSEWHERE));
    await d.settle();
    expect(premiumSub().autoRenew).toBe(true);
    expect(auditActions()).toHaveLength(lines);
    expect(notices.sent).toEqual(['paid.sub.started:g1']);
  });

  it('274: a call that finds nothing to change throws T25 before any change: no write, no line, no notice', async () => {
    await d.buy();
    await d.buy('g1', 'silver');
    const writes = d.writes(DUMMY_KEY);
    const lines = auditActions().length;
    await expect(d.dummy.cancelSubscription('dummy_9')).rejects.toThrow("Dummy subscription 'dummy_9' not found.");
    await expect(d.dummy.reactivateSubscription('dummy_9')).rejects.toThrow("Dummy subscription 'dummy_9' not found.");
    await expect(d.dummy.pauseSubscription('dummy_2', null)).rejects.toThrow("Dummy subscription 'dummy_2' is already paused, so it was not paused.");
    await expect(d.dummy.resumeSubscription('dummy_1', null)).rejects.toThrow("Dummy subscription 'dummy_1' is not paused, so it was not resumed.");
    await expect(d.dummy.reactivateSubscription('dummy_2')).rejects.toThrow("Dummy subscription 'dummy_2' is paused, so it was not reactivated.");
    d.later(31);
    await expect(d.dummy.reactivateSubscription('dummy_1')).rejects.toThrow("Dummy subscription 'dummy_1' is past its end date, so it was not reactivated.");
    await d.settle();
    expect(d.writes(DUMMY_KEY)).toBe(writes);
    expect(auditActions()).toHaveLength(lines);
    expect(notices.sent).toEqual(['paid.sub.started:g1', 'paid.sub.started:g1']);
  });

  it('274: an expired record is neither paused nor reactivated', async () => {
    await d.buy();
    await d.dummy.cancelSubscription('dummy_1', true);
    await expect(d.dummy.pauseSubscription('dummy_1', null)).rejects.toThrow("Dummy subscription 'dummy_1' is expired, so it was not paused.");
    await expect(d.dummy.reactivateSubscription('dummy_1')).rejects.toThrow("Dummy subscription 'dummy_1' is expired, so it was not reactivated.");
  });

  it('324: a price change to the variant the record already has: no change, a no-change save, the stored state', async () => {
    await d.buy();
    const before = d.record('dummy_1');
    const docs = d.writes(DUMMY_KEY);
    const state = await d.dummy.migrateSubscriptionPrice('dummy_1', MONTHLY, 'none');
    await d.settle();
    expect(state).toMatchObject({ status: 'active', startDate: before.startDate, endDate: before.endDate, autoRenew: before.autoRenew });
    expect(d.writes(DUMMY_KEY)).toBe(docs);
    expect(d.record('dummy_1')).toEqual(before);
  });
});

describe("the tick's reconcile (94, 96, 102)", () => {
  it('321, 379: autoRenew differs at two runs: written back to premium\'s; no event; T26 once its op landed with the check equal', async () => {
    await autoRenewDiffers();
    const premiumWrites = d.writes(PREMIUM_KEY);
    await d.tick();
    expect(d.record('dummy_1').autoRenew).toBe(false);
    expect(t26Lines()).toEqual([]);
    r.m.state.pg.sent.length = 0;
    await d.tick();
    expect(d.record('dummy_1').autoRenew).toBe(true);
    expect(t26Lines()).toEqual([T26('dummy_1', 'autoRenew was false, now true')]);
    expect(r.m.state.pg.sent.some(s => s.sql === CHECK_READ && s.params?.[0] === PREMIUM_KEY)).toBe(true);
    expect(d.writes(PREMIUM_KEY)).toBe(premiumWrites);
    await d.tick();
    expect(t26Lines()).toHaveLength(1);
  });

  it('318: a changed updatedAt or a changed answer is recorded again, not written', async () => {
    await autoRenewDiffers();
    await d.tick();
    await d.otherDummy(state => { state.subscriptions.dummy_1.updatedAt = new Date(Date.now() + 1000).toISOString(); });
    await d.tick();
    expect(d.record('dummy_1').autoRenew).toBe(false);
    await d.otherPremium(config => { config.subscriptions.g1.active.endDate = new Date(Date.now() + 40 * DAY_MS).toISOString(); });
    await d.tick();
    expect(d.record('dummy_1').autoRenew).toBe(false);
    await d.tick();
    expect(d.record('dummy_1')).toMatchObject({ autoRenew: true, endDate: premiumSub().endDate });
  });

  it('343: a record with a difference seen once whose endDate passed is skipped by the walk at that run', async () => {
    await autoRenewDiffers();
    const end = d.record('dummy_1').endDate;
    d.later(31);
    await d.tick();
    expect(d.record('dummy_1')).toMatchObject({ endDate: end, status: 'active', autoRenew: false });
    expect(r.logged('[DummyProvider] The ')).toEqual([]);
  });

  it('322: a difference that stays after a write whose save was refused is written two runs later, not at the next', async () => {
    await autoRenewDiffers();
    await d.tick();
    inject.dummy.push({ cause: 'unstorable', thrown: false });
    await d.tick();
    expect(d.record('dummy_1').autoRenew).toBe(false);
    await d.tick();
    expect(d.record('dummy_1').autoRenew).toBe(false);
    await d.tick();
    expect(d.record('dummy_1').autoRenew).toBe(true);
    expect(t26Lines()).toHaveLength(1);
  });

  const gates: Array<[string, () => Promise<() => Promise<void>>]> = [
    ['no reader', async () => {
      const reader = (r.pm() as any).subscriptionReader;
      getPaymentRegistry().setSubscriptionReader(null);
      return async () => { getPaymentRegistry().setSubscriptionReader(reader); };
    }],
    ['premium unreadable', async () => {
      const good = r.m.state.rows.docs.get(PREMIUM_KEY)!.body.toString('utf8');
      r.m.state.rows.put(PREMIUM_KEY, '{ not json');
      await runSharedPass();
      loads();
      expect(r.pm().cacheState()).toBe('unreadable');
      return async () => {
        r.m.state.rows.put(PREMIUM_KEY, good);
        await runSharedPass();
        d.later(0.0001);
        loads();
      };
    }],
    ['premium replaying', async () => {
      r.m.state.rows.putLine(JOURNAL_KEY, 'j1', JSON.stringify({
        writer: 'p-dead', node: 'node-alfa', nodeName: 'ALFA', n: 1,
        event: { type: 'subscription.updated', providerId: 'nb6x', providerSubId: 'zz', guildId: 'g9', state: { status: 'active', startDate: '2026-01-01T00:00:00.000Z', endDate: null, autoRenew: false } },
      }));
      await runSharedPass();
      loads();
      expect(r.pm().cacheState()).toBe('replaying');
      return async () => {
        startPremiumTickers();
        await vi.waitFor(async () => {
          await r.settle();
          expect(r.pm().cacheState()).toBe('normal');
        }, { timeout: 5000 });
      };
    }],
    ['a Dummy op open', async () => {
      const release = hold();
      d.dummy.adminSetVariant({ variantId: 'v_x', label: 'X', amount: 1, currency: 'USD', durationDays: 30, recurring: true, active: true });
      return async () => { release(); await d.settle(); };
    }],
    ['a premium op open', async () => {
      const release = hold();
      r.pm().setMessages({});
      return async () => { release(); await d.settle(); };
    }],
    ['a premium save held', async () => {
      inject.premium.push({ cause: 'database-backlog', thrown: true });
      r.pm().setMessages({});
      return async () => { (r.pm() as any).retryPass(); await d.settle(); };
    }],
    ['a Dummy save held', async () => {
      inject.dummy.push({ cause: 'database-backlog', thrown: true });
      d.dummy.adminSetVariant({ variantId: 'v_x', label: 'X', amount: 1, currency: 'USD', durationDays: 30, recurring: true, active: true });
      return async () => {
        await vi.waitFor(async () => {
          await r.settle();
          expect(d.stored().variants.v_x).toBeDefined();
        }, { timeout: 5000 });
        await d.settle();
      };
    }],
  ];

  it.each(gates)('317: %s: the whole tick is skipped and seen cleared', async (_name, shut) => {
    await autoRenewDiffers();
    await d.tick();
    const open = await shut();
    vi.advanceTimersByTime(60_000);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(d.record('dummy_1').autoRenew).toBe(false);
    await open();
    await d.tick();
    expect(d.record('dummy_1').autoRenew).toBe(false);
    await d.tick();
    expect(d.record('dummy_1').autoRenew).toBe(true);
  }, 20_000);

  it('317: premium stopped: no tick writes', async () => {
    await autoRenewDiffers();
    await d.tick();
    r.pm().markStopped('stopping');
    await d.tick();
    await d.tick();
    expect(d.record('dummy_1').autoRenew).toBe(false);
    expect(t26Lines()).toEqual([]);
  });

  it('304: premium holds the sub active, the record paused: written active with premium\'s fields at two runs; no event', async () => {
    await d.buy();
    await d.buy('g1', 'silver');
    expect(d.record('dummy_2')).toMatchObject({ status: 'paused', paused: true });
    inject.dummy.push(null, { cause: 'unstorable', thrown: false });
    expect(await r.pm().cancelPaidSubscriptionImmediately('g1')).toBe(true);
    await d.settle();
    expect(r.logged(`[PremiumManager] provider resumeSubscription failed for 'dummy': ${T20('unstorable')}`)).toHaveLength(1);
    const active = premiumSub();
    expect(active).toMatchObject({ providerSubId: 'dummy_2', status: 'active' });
    expect(d.record('dummy_2').status).toBe('paused');
    const premiumWrites = d.writes(PREMIUM_KEY);
    await d.tick();
    await d.tick();
    expect(d.record('dummy_2')).toMatchObject({ status: 'active', paused: false, endDate: active.endDate, autoRenew: active.autoRenew, variantId: active.variantId });
    expect(d.record('dummy_2').pausedAt).toBeUndefined();
    expect(d.record('dummy_2').resumesAt).toBeUndefined();
    expect(t26Lines()).toHaveLength(1);
    expect(t26Lines()[0]).toContain('status was paused, now active');
    expect(d.writes(PREMIUM_KEY)).toBe(premiumWrites);
  });

  it('319: the record expired, premium\'s sub active: written active at two runs; it stays active while its end is ahead', async () => {
    await d.buy();
    premiumRefusedElsewhere();
    expect(await r.pm().cancelPaidSubscriptionImmediately('g1')).toBe(true);
    await d.settle();
    r.m.state.rows.fault = undefined;
    await runSharedPass();
    expect(d.record('dummy_1').status).toBe('expired');
    await d.tick();
    await d.tick();
    expect(d.record('dummy_1')).toMatchObject({ status: 'active', autoRenew: true });
    expect(t26Lines()).toEqual([T26('dummy_1', 'status was expired, now active; autoRenew was false, now true')]);
    expect(premiumSub().status).toBe('active');
  });

  it("319: written active with autoRenew false and its end passed: the walk expires it again; premium expires the sub and resumes the queue", async () => {
    await d.buy();
    await d.buy('g1', 'silver');
    expect(await r.pm().cancelPaidSubscription('g1')).toBe(true);
    await d.settle();
    premiumRefusedElsewhere();
    expect(await r.pm().cancelPaidSubscriptionImmediately('g1')).toBe(true);
    await d.settle();
    r.m.state.rows.fault = undefined;
    await runSharedPass();
    d.later(31);
    notices.sent.length = 0;
    await d.tick();
    await d.tick();
    expect(d.record('dummy_1').status).toBe('expired');
    expect(premiumSub()).toMatchObject({ providerSubId: 'dummy_2', status: 'active' });
    expect(notices.sent).toEqual(['paid.sub.expired:g1', 'paid.sub.resumed-from-queue:g1']);
    expect(t26Lines()).toHaveLength(2);
  });

  it("320, 282: a walk event whose premium save was refused: written back at two runs, renewed again in that tick, and premium's save lands", async () => {
    await d.buy();
    const end = premiumSub().endDate;
    d.later(31);
    inject.premium.push({ cause: 'unstorable', thrown: false });
    await d.tick();
    expect(Date.parse(d.record('dummy_1').endDate)).toBeGreaterThan(Date.parse(end));
    expect(premiumSub().endDate).toBe(end);
    await d.tick();
    expect(premiumSub().endDate).toBe(end);
    await d.tick();
    expect(premiumSub().endDate).toBe(d.record('dummy_1').endDate);
    expect(Date.parse(premiumSub().endDate)).toBeGreaterThan(Date.parse(end));
    expect(t26Lines()).toHaveLength(1);
    expect(t26Lines()[0]).toContain(`endDate was ${new Date(Date.parse(end) + 30 * DAY_MS).toISOString()}, now ${end}`);
    await d.tick();
    expect(t26Lines()).toHaveLength(1);
  });

  it('283: a walk batch that reached premium after its stop: the next process writes the record back at its second run and the walk sends it again', async () => {
    await d.buy();
    const end = premiumSub().endDate;
    d.later(31);
    const release = hold();
    vi.advanceTimersByTime(60_000);
    r.pm().markStopped('stopping');
    release();
    await d.settle();
    expect(r.logged('subscription.renewed').length).toBeGreaterThan(0);
    expect(premiumSub().endDate).toBe(end);
    resetPremiumManager();
    r.pm();
    d.dummy.dispose();
    const next = d.make();
    getPaymentRegistry().register(next);
    next.start();
    await d.tick();
    expect(premiumSub().endDate).toBe(end);
    await d.tick();
    expect(Date.parse(premiumSub().endDate)).toBeGreaterThan(Date.parse(end));
    expect(t26Lines()).toHaveLength(1);
  });

  it('316: the reader answers null: nothing written or recorded; the walk renews the record and its event finds no sub', async () => {
    await d.dummy.initiatePurchase({ guildId: 'g2', tierId: 'gold', offeringId: 'o1', variantId: MONTHLY });
    await d.settle();
    const end = d.record('dummy_1').endDate;
    const premiumWrites = d.writes(PREMIUM_KEY);
    d.later(31);
    await d.tick();
    expect(Date.parse(d.record('dummy_1').endDate)).toBe(Date.parse(end) + 30 * DAY_MS);
    expect(d.writes(PREMIUM_KEY)).toBe(premiumWrites);
    expect(t26Lines()).toEqual([]);
  });

  it("323: another machine's landed Dummy op while its premium save is in flight: recorded; once that save lands the next run finds no difference", async () => {
    await d.buy();
    await d.otherDummy(state => {
      state.subscriptions.dummy_1.autoRenew = false;
      state.subscriptions.dummy_1.updatedAt = new Date().toISOString();
    });
    await d.tick();
    await d.otherPremium(config => { config.subscriptions.g1.active.autoRenew = false; });
    await d.tick();
    await d.tick();
    expect(d.record('dummy_1').autoRenew).toBe(false);
    expect(t26Lines()).toEqual([]);
  });

  it('342: premium queued the sub paused, the record active (its pause refused): written paused at two runs; the walk skips it', async () => {
    await d.buy('g1', 'silver');
    inject.dummy.push(null, { cause: 'unstorable', thrown: false });
    await d.buy('g1', 'gold');
    expect(r.row().subscriptions.g1.paused[0]).toMatchObject({ providerSubId: 'dummy_1', status: 'paused' });
    expect(d.record('dummy_1').status).toBe('active');
    d.later(31);
    await d.tick();
    expect(d.record('dummy_1').status).toBe('active');
    await d.tick();
    expect(d.record('dummy_1')).toMatchObject({ status: 'paused', paused: true, resumesAt: null });
    expect(t26Lines()).toHaveLength(1);
    expect(r.logged('[PremiumManager] The subscription.')).toEqual([]);
  });

  it("344: a machine holding a premium save runs no tick; another writes the record, then both follow premium's stored copy", async () => {
    await d.buy();
    await d.buy('g1', 'silver');
    inject.dummy.push(null, { cause: 'unstorable', thrown: false });
    await r.pm().cancelPaidSubscriptionImmediately('g1');
    await d.settle();
    inject.premium.push({ cause: 'database-backlog', thrown: true });
    r.pm().setMessages({});
    await d.tick();
    await d.tick();
    expect(d.record('dummy_2').status).toBe('paused');
    (r.pm() as any).retryPass();
    await d.settle();
    await d.tick();
    await d.tick();
    expect(d.record('dummy_2').status).toBe('active');
    await d.otherPremium(config => {
      const sub = config.subscriptions.g1.active;
      delete config.subscriptions.g1.active;
      config.subscriptions.g1.paused = [{ ...sub, status: 'paused', resumesAtHint: '2027-01-01T00:00:00.000Z' }];
    });
    await d.tick();
    await d.tick();
    expect(d.record('dummy_2')).toMatchObject({ status: 'paused', paused: true, resumesAt: '2027-01-01T00:00:00.000Z' });
    expect(t26Lines()).toHaveLength(2);
  });

  it('346: premium puts a paused Dummy sub into the active slot with no provider call; the tick writes the record active at two runs', async () => {
    await d.dummy.initiatePurchase({ guildId: 'g1', tierId: 'gold', offeringId: 'o1', variantId: MONTHLY, startPausedUntil: null });
    await d.settle();
    const writes = d.writes(DUMMY_KEY);
    const plan = (await r.pm().findOrphansForGuild('g1')).find(o => o.ref.providerSubId === 'dummy_1')?.plan;
    expect(await r.pm().adoptOrphan('g1', 'dummy', 'dummy_1', plan)).toBe(true);
    await d.settle();
    expect(premiumSub()).toMatchObject({ providerSubId: 'dummy_1', status: 'active' });
    expect(premiumSub().pausedAt).toBeUndefined();
    expect(d.writes(DUMMY_KEY)).toBe(writes);
    await d.tick();
    await d.tick();
    expect(d.record('dummy_1')).toMatchObject({ status: 'active', paused: false, endDate: premiumSub().endDate });
  });

  it("349: the tick's save refused at the flush by premium's check: no T26; T32; the cache dropped; the next runs compare again", async () => {
    await autoRenewDiffers();
    await d.tick();
    let done = false;
    r.m.state.rows.fault = (sql, params) => {
      if (!done && sql === CHECK_READ && params?.[0] === PREMIUM_KEY) {
        done = true;
        const config = r.row();
        config.messages = { ...(config.messages ?? {}), moduleBlocked: 'from BRAVO' };
        r.m.state.rows.put(PREMIUM_KEY, JSON.stringify(config, null, 2));
      }
      return undefined;
    };
    await d.tick();
    r.m.state.rows.fault = undefined;
    expect(d.record('dummy_1').autoRenew).toBe(false);
    expect(t26Lines()).toEqual([]);
    expect(r.logged(`[Shared] Not saved: ${DUMMY_KEY}: it was built on ${PREMIUM_KEY}, which `)).toHaveLength(1);
    await d.tick();
    expect(d.record('dummy_1').autoRenew).toBe(false);
    await d.tick();
    expect(d.record('dummy_1').autoRenew).toBe(true);
    expect(t26Lines()).toHaveLength(1);
  });

  it("349: the tick's save ends 'unconfirmed': no T26; the cache dropped", async () => {
    await autoRenewDiffers();
    await d.tick();
    loseNextCommit();
    vi.advanceTimersByTime(60_000);
    await vi.waitFor(() => expect(d.record('dummy_1').autoRenew).toBe(true));
    unconfirmUnansweredRows('the test ended it');
    await d.settle();
    r.m.state.rows.fault = undefined;
    expect(t26Lines()).toEqual([]);
    await d.tick();
    expect(t26Lines()).toEqual([]);
  });

  it('350: a tick save that lands with two written records logs T26 once for each', async () => {
    await autoRenewDiffers('g1');
    await autoRenewDiffers('g2');
    await d.tick();
    await d.tick();
    expect(t26Lines().sort()).toEqual([T26('dummy_1', 'autoRenew was false, now true'), T26('dummy_2', 'autoRenew was false, now true')]);
  });

  it("378: this machine's premium cache is behind another machine's landed cancel: the tick's op is refused by the check; the renew dropped; the next runs find no difference", async () => {
    await d.buy();
    d.later(31);
    const config = r.row();
    config.subscriptions.g1.active.autoRenew = false;
    r.m.state.rows.put(PREMIUM_KEY, JSON.stringify(config, null, 2));
    const state = d.stored();
    state.subscriptions.dummy_1.autoRenew = false;
    state.subscriptions.dummy_1.updatedAt = new Date().toISOString();
    r.m.state.rows.put(DUMMY_KEY, JSON.stringify(state, null, 2));
    expect(await refreshShared([DUMMY_KEY])).toEqual({ ok: true });
    const premiumBody = r.row();
    await d.tick();
    await d.tick();
    expect(r.logged(`[Shared] Not saved: ${DUMMY_KEY}: it was built on ${PREMIUM_KEY}, which `)).toHaveLength(1);
    expect(r.logged(T16a('subscription.renewed', 'dummy_1', ELSEWHERE))).toHaveLength(1);
    expect(d.record('dummy_1').autoRenew).toBe(false);
    expect(r.row()).toEqual(premiumBody);
    expect(t26Lines()).toEqual([]);
    await d.tick();
    await d.tick();
    expect(d.record('dummy_1').status).toBe('expired');
    expect(t26Lines()).toEqual([]);
  });

  it("381: the tick's save refused at the accept, retried cause or not: no save held, the cache dropped, its events dropped with T16 (a)", async () => {
    await d.buy();
    const end = premiumSub().endDate;
    d.later(31);
    inject.dummy.push({ cause: 'database-backlog', thrown: true });
    await d.tick();
    expect(r.logged(T16a('subscription.renewed', 'dummy_1', 'database-backlog'))).toHaveLength(1);
    expect(d.record('dummy_1').endDate).toBe(end);
    inject.dummy.push({ cause: 'unstorable', thrown: false });
    await d.tick();
    expect(r.logged(T16a('subscription.renewed', 'dummy_1', 'unstorable'))).toHaveLength(1);
    await d.tick();
    expect(Date.parse(d.record('dummy_1').endDate)).toBe(Date.parse(end) + 30 * DAY_MS);
    expect(premiumSub().endDate).toBe(d.record('dummy_1').endDate);
  });

  it('345: a price change answered T23 that landed: the record is written back to the source variant at two runs', async () => {
    await d.buy();
    const pm = r.pm();
    const migration = await pm.scheduleMigration({
      providerId: 'dummy', sourceTierId: 'gold', sourceOfferingId: 'o1', sourceVariantId: MONTHLY,
      targetTierId: 'gold', targetOfferingId: 'o1', targetVariantId: YEARLY,
      effectiveDate: new Date(Date.now() + DAY_MS).toISOString(), message: '',
    });
    await d.settle();
    expect(pm.recordMigrationDecision(migration.id, 'g1', 'accepted')).toBe(true);
    await d.settle();
    d.later(2);
    loseNextCommit();
    const running = pm.processDueMigrations();
    await vi.waitFor(() => expect(d.record('dummy_1').variantId).toBe(YEARLY));
    unconfirmUnansweredRows('the test ended it');
    await running;
    await d.settle();
    r.m.state.rows.fault = undefined;
    await runSharedPass();
    expect(r.row().migrations[0].decisions[0].outcome).toBe('failed');
    expect(premiumSub().variantId).toBe(MONTHLY);
    await d.tick();
    await d.tick();
    expect(d.record('dummy_1')).toMatchObject({ variantId: MONTHLY, durationDays: 30, endDate: premiumSub().endDate });
    expect(t26Lines()[0]).toContain(`variantId was ${YEARLY}, now ${MONTHLY}`);
  }, 20_000);

  it('351: a migration rerun meets the record already on the target variant: the no-change path; migrated; endDate moved once', async () => {
    await d.buy();
    const pm = r.pm();
    const migration = await pm.scheduleMigration({
      providerId: 'dummy', sourceTierId: 'gold', sourceOfferingId: 'o1', sourceVariantId: MONTHLY,
      targetTierId: 'gold', targetOfferingId: 'o1', targetVariantId: YEARLY,
      effectiveDate: new Date(Date.now() + DAY_MS).toISOString(), message: '',
    });
    await d.settle();
    pm.recordMigrationDecision(migration.id, 'g1', 'accepted');
    await d.settle();
    d.later(2);
    atLockRead(PREMIUM_KEY, () => {
      const config = r.row();
      config.messages = { ...(config.messages ?? {}), moduleBlocked: 'from BRAVO' };
      r.m.state.rows.put(PREMIUM_KEY, JSON.stringify(config, null, 2));
    });
    await pm.processDueMigrations();
    await d.settle();
    r.m.state.rows.fault = undefined;
    const moved = d.record('dummy_1').endDate;
    expect(d.record('dummy_1').variantId).toBe(YEARLY);
    expect(r.row().migrations[0].status).toBe('pending');
    await runSharedPass();
    await pm.processDueMigrations();
    await d.settle();
    expect(r.row().migrations[0].decisions[0].outcome).toBe('migrated');
    expect(d.record('dummy_1').endDate).toBe(moved);
    expect(premiumSub()).toMatchObject({ variantId: YEARLY, endDate: moved });
    expect(notices.sent).toContain('migration.applied:g1');
  }, 20_000);
});

describe('the walk batch reaches premium as one (110, 113)', () => {
  /** Guild g2: gold with autoRenew off at both, and silver queued behind it. */
  async function g2Expires(): Promise<void> {
    await d.buy('g2');
    await d.buy('g2', 'silver');
    expect(await r.pm().cancelPaidSubscription('g2')).toBe(true);
    await d.settle();
  }

  it('399, 396: two records due in one minute: one guard, both applied in walk order, one save; the notices once it landed', async () => {
    await d.buy('g1');
    await g2Expires();
    const end = premiumSub('g1').endDate;
    d.later(31);
    notices.sent.length = 0;
    const premiumWrites = d.writes(PREMIUM_KEY);
    await d.tick();
    expect(Date.parse(premiumSub('g1').endDate)).toBe(Date.parse(end) + 30 * DAY_MS);
    expect(premiumSub('g2')).toMatchObject({ providerSubId: 'dummy_3', status: 'active' });
    expect(d.writes(PREMIUM_KEY)).toBe(premiumWrites + 1);
    expect(auditActions().slice(-2)).toEqual(['subscription.expire.paid', 'subscription.resume']);
    expect(notices.sent).toEqual(['paid.sub.expired:g2', 'paid.sub.resumed-from-queue:g2']);
    expect(r.logged('was not applied')).toEqual([]);
  });

  it("400, 392: premium's sha differs from the batch's at the handler: nothing changed; T34 (a) for each event in walk order", async () => {
    await d.buy('g1');
    await g2Expires();
    d.later(31);
    const end = premiumSub('g1').endDate;
    const premiumWrites = d.writes(PREMIUM_KEY);
    let done = false;
    r.m.state.rows.fault = async sql => {
      if (!done && sql === 'COMMIT') {
        done = true;
        const config = r.row();
        config.messages = { ...(config.messages ?? {}), moduleBlocked: 'from ALFA' };
        r.m.state.rows.put(PREMIUM_KEY, JSON.stringify(config, null, 2));
        await runSharedPass();
      }
      return undefined;
    };
    await d.tick();
    r.m.state.rows.fault = undefined;
    expect(d.record('dummy_2').status).toBe('expired');
    expect(r.logged('was not applied')).toEqual([T34a('subscription.renewed', 'dummy_1'), T34a('subscription.expired', 'dummy_2')]);
    expect(d.writes(PREMIUM_KEY)).toBe(premiumWrites);
    expect(premiumSub('g1').endDate).toBe(end);
    expect(premiumSub('g2').providerSubId).toBe('dummy_2');
  });

  it('401, 402: a record premium does not hold is skipped with no T34; a batch with no record found saves nothing', async () => {
    await d.buy('g1');
    await d.dummy.initiatePurchase({ guildId: 'g3', tierId: 'gold', offeringId: 'o1', variantId: MONTHLY });
    await d.settle();
    d.later(31);
    const premiumWrites = d.writes(PREMIUM_KEY);
    await d.tick();
    expect(d.writes(PREMIUM_KEY)).toBe(premiumWrites + 1);
    expect(r.logged('was not applied')).toEqual([]);
    expect(Date.parse(d.record('dummy_2').endDate)).toBeGreaterThan(Date.now());
    const after = d.writes(PREMIUM_KEY);
    d.later(31);
    expect(await r.pm().cancelPaidSubscriptionImmediately('g1')).toBe(true);
    await d.settle();
    const cancelled = d.writes(PREMIUM_KEY);
    expect(cancelled).toBe(after + 1);
    await d.tick();
    expect(d.writes(PREMIUM_KEY)).toBe(cancelled);
  });

  it("393: the batch's save refused at the flush: its audit lines stored marked, its notices dropped with T16 (a), premium's cache dropped", async () => {
    await g2Expires();
    d.later(31);
    notices.sent.length = 0;
    atLockRead(PREMIUM_KEY, () => {
      const config = r.row();
      config.messages = { ...(config.messages ?? {}), moduleBlocked: 'from ALFA' };
      r.m.state.rows.put(PREMIUM_KEY, JSON.stringify(config, null, 2));
    });
    await d.tick();
    r.m.state.rows.fault = undefined;
    const marked = r.lines(AUDIT_KEY).filter(l => l.action === 'subscription.expire.paid');
    expect(marked).toHaveLength(1);
    expect(marked[0].metadata.notSaved.cause).toBe('changed-elsewhere');
    expect(notices.sent).toEqual([]);
    expect(r.logged(`[PremiumManager] The paid.sub.expired notice for guild g2 was not sent: the change it announces was not saved (${ELSEWHERE})`)).toHaveLength(1);
    expect(r.row().subscriptions.g2.active.providerSubId).toBe('dummy_1');
  });

  it('394: a premium save held when the batch arrives: nothing changed; T34 (b)', async () => {
    await d.buy('g1');
    d.later(31);
    const end = premiumSub('g1').endDate;
    const release = hold();
    vi.advanceTimersByTime(60_000);
    inject.premium.push({ cause: 'database-backlog', thrown: true });
    r.pm().setMessages({});
    release();
    await d.settle();
    expect(r.logged("[PremiumManager] The subscription.renewed event for subscription dummy_1 was not applied: premium-tiers.json holds a change that is not saved yet; the Dummy provider compares the subscription with the bot's copy again at its next checks after that change is saved")).toHaveLength(1);
    expect(premiumSub('g1').endDate).toBe(end);
    (r.pm() as any).retryPass();
    await d.settle();
  });

  it("395: the batch's save refused at the accept with a retried cause: not held; lines marked with the accept's cause; notices dropped", async () => {
    await g2Expires();
    d.later(31);
    notices.sent.length = 0;
    inject.premium.push({ cause: 'database-backlog', thrown: true });
    await d.tick();
    const marked = r.lines(AUDIT_KEY).filter(l => l.action === 'subscription.expire.paid');
    expect(marked).toHaveLength(1);
    expect(marked[0].metadata.notSaved.cause).toBe('database-backlog');
    expect(notices.sent).toEqual([]);
    expect(r.pm().cacheState()).toBe('normal');
    expect(r.row().subscriptions.g2.active.providerSubId).toBe('dummy_1');
  });

  it("398: another provider's event on a Postgres bot: no guard; the save on premium's own sha", async () => {
    await d.buy('g1');
    const config = r.row();
    config.subscriptions.g4 = { active: { ...config.subscriptions.g1.active, id: 'sub-g4', providerId: 'nb6p', providerSubId: 'ps1' }, paused: [] };
    r.m.state.rows.put(PREMIUM_KEY, JSON.stringify(config, null, 2));
    await runSharedPass();
    const later = new Date(Date.now() + 60 * DAY_MS).toISOString();
    getPaymentRegistry().emitEvent({ type: 'subscription.renewed', providerId: 'nb6p', providerSubId: 'ps1', guildId: 'g4', state: { status: 'active', startDate: config.subscriptions.g1.active.startDate, endDate: later, autoRenew: true } } as any);
    await d.settle();
    expect(premiumSub('g4').endDate).toBe(later);
  });

  it("411: a batch meeting premium 'replaying' (a dead writer's pending journal line) is dropped: nothing journaled, changed or saved; T34 (d)", async () => {
    await d.buy('g1');
    d.later(31);
    const end = premiumSub('g1').endDate;
    const release = hold();
    vi.advanceTimersByTime(60_000);
    r.m.state.rows.putLine(JOURNAL_KEY, 'j1', JSON.stringify({
      writer: 'p-dead', node: 'node-alfa', nodeName: 'ALFA', n: 1,
      event: { type: 'subscription.updated', providerId: 'nb6x', providerSubId: 'zz', guildId: 'g9', state: { status: 'active', startDate: '2026-01-01T00:00:00.000Z', endDate: null, autoRenew: false } },
    }));
    await runSharedPass();
    expect(r.pm().cacheState()).toBe('replaying');
    const premiumBody = r.row();
    release();
    await d.settle();
    expect(r.logged('[PremiumManager] The subscription.renewed event for subscription dummy_1 was not applied: the bot is still applying the provider events kept in premium-tiers.events.jsonl')).toHaveLength(1);
    expect(r.lines(JOURNAL_KEY)).toHaveLength(1);
    expect(r.row()).toEqual(premiumBody);
    expect(premiumSub('g1').endDate).toBe(end);
  });

  it("412: a batch of two meeting premium unreadable: dropped with T34 (c) twice in walk order; once readable the walk sends both again", async () => {
    await d.buy('g1');
    await d.buy('g2');
    d.later(31);
    const mirror = dataPath('global', 'premium-tiers.json');
    const good = fs.readFileSync(mirror, 'utf8');
    const release = hold();
    vi.advanceTimersByTime(60_000);
    fs.writeFileSync(mirror, '{ not json');
    r.pm().invalidate();
    loads();
    expect(r.pm().cacheState()).toBe('unreadable');
    release();
    await d.settle();
    const lines = r.logged('cannot be read; the Dummy provider compares the subscription');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('subscription dummy_1 was not applied: premium-tiers.json cannot be read');
    expect(lines[1]).toContain('subscription dummy_2 was not applied: premium-tiers.json cannot be read');
    fs.writeFileSync(mirror, good);
    d.later(0.0001);
    loads();
    const end = JSON.parse(good).subscriptions.g1.active.endDate;
    await d.tick();
    await d.tick();
    expect(Date.parse(premiumSub('g1').endDate)).toBeGreaterThan(Date.parse(end));
    expect(Date.parse(premiumSub('g2').endDate)).toBeGreaterThan(Date.parse(end));
  });

  it("414: premium's cache dropped and step 2's load failing: dropped at step 2 with T34 (c) for each event", async () => {
    await d.buy('g1');
    d.later(31);
    const release = hold();
    vi.advanceTimersByTime(60_000);
    fs.writeFileSync(dataPath('global', 'premium-tiers.json'), '{ not json');
    r.pm().invalidate();
    release();
    await d.settle();
    expect(r.logged('[PremiumManager] The subscription.renewed event for subscription dummy_1 was not applied: premium-tiers.json cannot be read')).toHaveLength(1);
  });

  it("413: premium's cache dropped while a journal line is pending: step 2's load enters 'replaying'; T34 (d)", async () => {
    await d.buy('g1');
    d.later(31);
    const release = hold();
    vi.advanceTimersByTime(60_000);
    r.pm().invalidate();
    r.m.state.rows.putLine(JOURNAL_KEY, 'j1', JSON.stringify({
      writer: 'p-dead', node: 'node-alfa', nodeName: 'ALFA', n: 1,
      event: { type: 'subscription.updated', providerId: 'nb6x', providerSubId: 'zz', guildId: 'g9', state: { status: 'active', startDate: '2026-01-01T00:00:00.000Z', endDate: null, autoRenew: false } },
    }));
    await runSharedPass();
    release();
    await d.settle();
    expect(r.logged('[PremiumManager] The subscription.renewed event for subscription dummy_1 was not applied: the bot is still applying the provider events kept in premium-tiers.events.jsonl')).toHaveLength(1);
    expect(r.lines(JOURNAL_KEY)).toHaveLength(1);
  });
});

describe('a JSON bot (397, 415)', () => {
  beforeEach(() => {
    setBackendKind('file');
  });

  it('397: the walk batch applies with no guard and one save', async () => {
    await d.buy('g1');
    const end = r.pm().getSubscriptions('g1').active!.endDate;
    d.later(31);
    await d.tick();
    expect(Date.parse(r.pm().getSubscriptions('g1').active!.endDate!)).toBe(Date.parse(end!) + 30 * DAY_MS);
  });

  it("415: a batch meeting premium 'replaying' is dropped at step 1 with T34 (d); no journal append", async () => {
    await d.buy('g1');
    const journal = dataPath('global', 'premium-tiers.events.jsonl');
    fs.writeFileSync(journal, `${JSON.stringify({ writer: 'p-dead', n: 1, event: { type: 'subscription.updated', providerId: 'nb6x', providerSubId: 'zz', guildId: 'g9', state: { status: 'active', startDate: '2026-01-01T00:00:00.000Z', endDate: null, autoRenew: false } } })}\n`);
    r.pm().invalidate();
    loads();
    expect(r.pm().cacheState()).toBe('replaying');
    const before = fs.readFileSync(journal, 'utf8');
    getPaymentRegistry().emitWalkBatch({ premiumSha: null, events: [{ type: 'subscription.renewed', providerId: 'dummy', providerSubId: 'dummy_1', guildId: 'g1', state: { status: 'active', startDate: '2026-01-01T00:00:00.000Z', endDate: null, autoRenew: true } }] });
    expect(r.logged('[PremiumManager] The subscription.renewed event for subscription dummy_1 was not applied: the bot is still applying the provider events kept in premium-tiers.events.jsonl')).toHaveLength(1);
    expect(fs.readFileSync(journal, 'utf8')).toBe(before);
  });
});
