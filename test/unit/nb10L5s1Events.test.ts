import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 decisions 12 and 13: provider events reach the members as notices that name the tier and the provider; the web
// UI rereads a premium-tiers.json another writer changed before it applies an event; an install that fails is logged;
// an install of a subscription still in flight keeps the payment op waiting until it ends; the install's audit line
// names who installed it and the variant.

const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
const notices = vi.hoisted(() => ({ sent: [] as Array<{ guildId: string; kind: string; payload: unknown }> }));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async (guildId: string, kind: string, payload: unknown) => {
    notices.sent.push({ guildId, kind, payload });
    return { delivered: true, via: 'dm' };
  },
}));

import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { AUDIT, clearGlobal, gate, linesOf, logged, paidSub, quiet, settleQueue, state, tick, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const asBot = (bot: boolean) => {
  if (bot) process.env.BOT_PROCESS_ROLE = 'bot';
  else delete process.env.BOT_PROCESS_ROLE;
};

let pause = gate();
function registerFake(): void {
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { supportsPause: true }, isConfigured: () => true,
    pauseSubscription: () => pause.promise,
  } as any);
}
function newProcess(): ReturnType<typeof getPremiumManager> {
  resetPremiumManager();
  reg.current = null;
  registerFake();
  return getPremiumManager();
}
const emit = (event: object) => getPaymentRegistry().emitEvent(event as any);
const expiredState = () => ({ ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() });

let spies: ReturnType<typeof quiet>;
beforeAll(() => clearGlobal());
beforeEach(async () => {
  spies = quiet();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  notices.sent = [];
  clearGlobal();
  pause = gate();
  asBot(true);
});
afterEach(async () => {
  pause.open();
  await tick(5);
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('notices of provider events', () => {
  it('a failed renewal names the tier and the provider and passes the reason', async () => {
    writePremium({ g1: { active: paidSub('s1', 'f1', 'low', 'fake'), paused: [] } });
    newProcess();
    emit({ type: 'subscription.renewal-failed', providerId: 'fake', providerSubId: 'f1', guildId: 'g1', reason: 'card declined' });
    await tick(5);
    expect(notices.sent).toEqual([{ guildId: 'g1', kind: 'paid.sub.renewal-failed', payload: { tierName: 'Low', providerName: 'Fake', details: 'card declined' } }]);
  });

  it('a failed renewal of a tier no longer defined names the tier by its id', async () => {
    writePremium({ g1: { active: paidSub('s1', 'f1', 'gone', 'fake'), paused: [] } });
    newProcess();
    emit({ type: 'subscription.renewal-failed', providerId: 'fake', providerSubId: 'f1', guildId: 'g1', reason: 'card declined' });
    await tick(5);
    expect(notices.sent).toEqual([{ guildId: 'g1', kind: 'paid.sub.renewal-failed', payload: { tierName: 'gone', providerName: 'Fake', details: 'card declined' } }]);
  });

  it('an expiry names the tier and the provider', async () => {
    writePremium({ g1: { active: paidSub('s1', 'f1', 'low', 'fake'), paused: [] } });
    newProcess();
    emit({ type: 'subscription.expired', providerId: 'fake', providerSubId: 'f1', guildId: 'g1', state: expiredState() });
    await tick(5);
    expect(notices.sent).toEqual([{ guildId: 'g1', kind: 'paid.sub.expired', payload: { tierName: 'Low', providerName: 'Fake' } }]);
  });

  it('an expiry of a tier no longer defined names the tier by its id', async () => {
    writePremium({ g1: { active: paidSub('s1', 'f1', 'gone', 'fake'), paused: [] } });
    newProcess();
    emit({ type: 'subscription.expired', providerId: 'fake', providerSubId: 'f1', guildId: 'g1', state: expiredState() });
    await tick(5);
    expect(notices.sent).toEqual([{ guildId: 'g1', kind: 'paid.sub.expired', payload: { tierName: 'gone', providerName: 'Fake' } }]);
  });

  it('the web UI rereads a file another writer changed before it applies an event', async () => {
    asBot(false);
    writePremium({});
    newProcess();
    writePremium({ g2: { active: paidSub('s2', 'f2', 'low', 'fake'), paused: [] } });
    emit({ type: 'subscription.renewal-failed', providerId: 'fake', providerSubId: 'f2', guildId: 'g2', reason: 'card declined' });
    await tick(5);
    expect(notices.sent.map(n => `${n.kind}:${n.guildId}`)).toEqual(['paid.sub.renewal-failed:g2']);
  });
});

describe('installs from subscription.created', () => {
  it('the install line names the admin actor and the variant; the started notice names tier, provider and end date', async () => {
    writePremium({});
    const pm = newProcess();
    const s = state();
    emit({ type: 'subscription.created', providerId: 'fake', providerSubId: 'c1', guildId: 'g9', tierId: 'low', offeringId: 'o1', variantId: 'v1', state: s });
    await pm.settled(undefined);
    await settleQueue();
    const lines = linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ actor: 'admin', guildId: 'g9', tierId: 'low', providerId: 'fake', metadata: { variantId: 'v1' } });
    expect(notices.sent).toEqual([{ guildId: 'g9', kind: 'paid.sub.started', payload: { tierName: 'Low', providerName: 'Fake', endDate: s.endDate } }]);
  });

  it('a failed install is logged; a second delivery behind it keeps its payment op waiting until its own install ends', async () => {
    writePremium({ g1: { active: paidSub('s1', 'h1', 'high', 'fake'), paused: [] } });
    const pm = newProcess();
    emit({ type: 'subscription.created', providerId: 'fake', providerSubId: 'x1', guildId: 'g1', tierId: 'low', offeringId: 'o1' });
    emit({ type: 'subscription.created', providerId: 'fake', providerSubId: 'x1', guildId: 'g1', tierId: 'low', offeringId: 'o1', state: state() });
    await tick(20);
    const failed = spies.error.mock.calls.filter((c: unknown[]) => c[0] === '[PremiumManager] installAsyncSubscription failed:');
    expect(failed).toHaveLength(1);
    expect(failed[0][1]).toBeInstanceOf(TypeError);
    let done = false;
    const waiting = pm.settled(undefined).then(() => { done = true; });
    await tick(20);
    expect(done).toBe(false);
    pause.open();
    await waiting;
    expect(done).toBe(true);
    expect(logged(spies.error).filter(l => l.includes('installAsyncSubscription failed'))).toHaveLength(1);
  });
});
