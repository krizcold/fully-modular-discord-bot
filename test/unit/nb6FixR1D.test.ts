import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySharedOp, partialEnding } from '../../src/bot/internalSetup/utils/sharedOps';
import { truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { AUDIT_KEY, premiumRig } from '../helpers/nb6PremiumRig';
import { ELSEWHERE, MONTHLY, dummyRig } from '../helpers/nb6DummyRig';

// NB6 code review round 1, lane D (out/NB6/review1-D.md, findings 1, 2, 3, 5 and 8): a held save keeps the cache it
// was made from until its retry is sent; a provider call's state is copied into the subscription premium holds after
// the call; the exit words a carried audit line whose COMMIT was on the wire as can't confirm; T26 words a null; a
// purchase stopped after the Dummy's op landed answers partial. The real PremiumManager and DummyProvider in the bot
// process role, the real row flush over the scripted shared tables.

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
const inject = vi.hoisted(() => ({ premium: [] as Array<{ cause: string } | null>, dummy: [] as Array<{ cause: string } | null> }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => {
      const queue = f === 'premium-tiers.json' ? inject.premium : f === 'state.json' ? inject.dummy : null;
      const refuse = queue && queue.length > 0 ? queue.shift() : null;
      // The Postgres accept's retried refusal: the row queue closed (dataManager.ts acceptSave).
      if (refuse) throw new real.DataBackendUnavailableError(refuse.cause as any);
      return real.saveDataTracked(f, o, d);
    },
  };
});

const r = premiumRig();
const d = dummyRig(r);

const premiumSub = (guild = 'g1') => r.row()?.subscriptions?.[guild]?.active;
const T20 = (words: string) => `The Dummy provider did not save this change (${words}), so nothing was changed at the provider.`;

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

describe('D1: a held save keeps the cache it was made from until its retry is sent', () => {
  it("premium: another machine's change applied and read meanwhile; the retry is refused 'changed-elsewhere' and its carry marked", async () => {
    const pm = r.pm();
    inject.premium.push({ cause: 'database-backlog' });
    expect(await pm.grantManual('g1', 'gold', 30)).toBe(true);
    await d.otherPremium(config => { config.messages = { ...(config.messages ?? {}), moduleBlocked: 'from BRAVO' }; });
    pm.getAllTiers();
    (pm as any).retryPass();
    await d.settle();
    expect(notices.sent).toEqual([]);
    const line = r.lines(AUDIT_KEY).find(l => l.action === 'subscription.grant.manual');
    expect(line?.metadata?.notSaved?.cause).toBe('changed-elsewhere');
    expect(r.row().subscriptions?.g1).toBeUndefined();
    expect(r.row().messages.moduleBlocked).toBe('from BRAVO');
  });

  it("the Dummy: another machine's change applied and read meanwhile; the waiting method is refused, not answered landed", async () => {
    const bought = await d.buy();
    inject.dummy.push({ cause: 'database-backlog' });
    const cancelling = d.dummy.cancelSubscription(bought.providerSubId).then(() => 'resolved', (e: Error) => e.message);
    await new Promise(resolve => setTimeout(resolve, 20));
    await d.otherDummy(state => { state.variants.v_y = { variantId: 'v_y', label: 'Y', amount: 1, currency: 'USD', durationDays: 30, recurring: true, active: true }; });
    d.dummy.adminListVariants();
    expect(await cancelling).toBe(T20(ELSEWHERE));
    await d.settle();
    expect(d.record(bought.providerSubId).autoRenew).toBe(true);
    expect(d.stored().variants.v_y).toBeDefined();
  }, 20_000);
});

describe("D2: a provider call's state is copied into the subscription premium holds after the call", () => {
  it.each([
    ['cancel', false],
    ['reactivate', true],
  ] as const)("%s: another machine's premium change applied and read during the Dummy's op", async (what, autoRenew) => {
    const pm = r.pm();
    await d.buy();
    if (what === 'reactivate') {
      expect(await pm.cancelPaidSubscription('g1')).toBe(true);
      await d.settle();
      expect(premiumSub().autoRenew).toBe(false);
    }
    const release = hold();
    const calling = what === 'cancel' ? pm.cancelPaidSubscription('g1') : pm.reactivatePaidSubscription('g1');
    await new Promise(resolve => setTimeout(resolve, 20));
    await d.otherPremium(config => { config.messages = { ...(config.messages ?? {}), moduleBlocked: 'from BRAVO' }; });
    pm.getAllTiers();
    release();
    expect(await calling).toBe(true);
    await d.settle();
    expect(premiumSub().autoRenew).toBe(autoRenew);
    expect(r.row().messages.moduleBlocked).toBe('from BRAVO');
  }, 20_000);
});

describe('D3: the exit words a carried audit line by its op', () => {
  it("the op's COMMIT is on the wire: can't confirm whether the line is stored", async () => {
    const pm = r.pm();
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    let sent = false;
    r.m.state.rows.fault = sql => {
      if (sql !== 'COMMIT') return undefined;
      sent = true;
      return gate.then(() => undefined);
    };
    await pm.grantManual('g1', 'gold', 30);
    void r.settle();
    await vi.waitFor(() => expect(sent).toBe(true));
    pm.logLossesAtExit();
    expect(r.logged("(guild g1, ")).toEqual(expect.arrayContaining([expect.stringContaining("was being written before this stop; can't confirm whether it is stored: ")]));
    expect(r.logged('was not written: the bot is stopping; it is lost')).toEqual([]);
    r.m.state.rows.fault = undefined;
    open();
    await d.settle();
  });

  it('the op not sent yet: the line is lost with the stop', async () => {
    const pm = r.pm();
    const release = hold();
    await pm.grantManual('g1', 'gold', 30);
    pm.logLossesAtExit();
    expect(r.logged('The audit line subscription.grant.manual (guild g1, ')).toHaveLength(1);
    expect(r.logged('was not written: the bot is stopping; it is lost')).toHaveLength(1);
    release();
    await d.settle();
  });
});

describe('D5: T26 words a null', () => {
  it("a record with no end date reads 'no end date'; premium's unpaused copy reads 'none'", async () => {
    const bought = await d.buy();
    await d.otherDummy(state => {
      const rec = state.subscriptions[bought.providerSubId];
      rec.status = 'paused';
      rec.paused = true;
      rec.pausedAt = new Date().toISOString();
      rec.resumesAt = '2027-01-01T00:00:00.000Z';
      rec.endDate = null;
      rec.updatedAt = new Date().toISOString();
    });
    await d.tick();
    await d.tick();
    const lines = r.logged('[DummyProvider] Subscription ');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('endDate was no end date, now ');
    expect(lines[0]).toContain('resumesAt was 2027-01-01T00:00:00.000Z, now none');
    expect(lines[0]).not.toContain('null');
  });
});

describe('D8: a purchase stopped after the Dummy op landed answers partial', () => {
  it("state.json lands, the install's save is refused 'node-stopping'", async () => {
    const release = hold();
    const answer: Promise<any> = applySharedOp({ op: 'premium.initiatePaidSubscription', args: { args: ['g1', 'gold', 'o1', { providerId: 'dummy', variantId: MONTHLY }] } });
    await new Promise(resolve => setTimeout(resolve, 30));
    r.pm().markStopped('stopping');
    release();
    const reply = await answer;
    await d.settle();
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'node-stopping', partial: true });
    expect(reply.error).toContain(truthText('node-stopping', true).replace(/ Please [^.]*\.$/, ''));
    expect(d.stored().subscriptions.dummy_1).toBeDefined();
    expect(premiumSub()).toBeUndefined();
    expect(reply.error).toContain(partialEnding(['payment-providers/dummy/state.json']));
  }, 20_000);
});
