import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 survivors, chunk 5 (premiumManager.ts): the cancel, revoke and start paths' audit lines and member notices, the
// entry refusals of the orphan, channel and account-link changes while premium-tiers.json cannot be read, the stop-time
// judgment of the last saved text, and which subscriptions an account unlink cancels.

const inject = vi.hoisted(() => ({ refuse: new Set<string>() }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => {
      if (inject.refuse.has(f)) throw new real.DataBackendUnavailableError('storage-failing' as any);
      return real.saveDataTracked(f, o, d);
    },
  };
});
const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
const notices = vi.hoisted(() => ({ sent: [] as Array<{ guildId: string; kind: string; payload: any }> }));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async (guildId: string, kind: string, payload: any) => {
    notices.sent.push({ guildId, kind, payload });
    return { delivered: true, via: 'dm' };
  },
}));

import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import type { PaymentProvider } from '../../src/bot/internalSetup/utils/payment/paymentTypes';
import { AUDIT, clearGlobal, jsonOf, linesOf, paidSub, PREMIUM, quiet, settleQueue, TIERS, writePremium } from './nb10PremiumRig';

const G = 'g1';
let cancels: string[] = [];
let onCancel: ((providerSubId: string) => void | Promise<void>) | null = null;

function fakeProvider(id = 'fake'): PaymentProvider {
  return {
    id,
    displayName: 'Fake Pay',
    isConfigured: () => true,
    capabilities: { canInitiatePurchase: true, supportsCancel: true, supportsReactivate: true, supportsCoupons: false, supportsPause: false },
    cancelSubscription: async (providerSubId: string) => {
      cancels.push(providerSubId);
      if (onCancel) await onCancel(providerSubId);
    },
    reactivateSubscription: async () => undefined,
    initiatePurchase: async () => ({
      providerSubId: 'ps-new',
      state: { status: 'active', startDate: new Date().toISOString(), endDate: new Date(Date.now() + 30 * 86_400_000).toISOString(), autoRenew: false },
    }),
  } as unknown as PaymentProvider;
}

const manualSub = (id: string, tierId = 'high', extra: Record<string, unknown> = {}) => {
  const sub: any = { ...paidSub(id, 'unused', tierId), source: 'manual', ...extra };
  delete sub.providerSubId;
  if (!('providerId' in extra)) delete sub.providerId;
  return sub;
};

const m = () => getPremiumManager();
const audit = async () => { await settleQueue(); return linesOf(AUDIT); };
const stored = async () => { await settleQueue(); return jsonOf(PREMIUM); };
const noticesOf = (kind: string) => notices.sent.filter(n => n.kind === kind);

function unreadable(): void {
  fs.writeFileSync(PREMIUM, '{not json');
  m();
}

beforeEach(async () => {
  quiet();
  vi.stubEnv('BOT_PROCESS_ROLE', 'webui');
  inject.refuse.clear();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  notices.sent = [];
  cancels = [];
  onCancel = null;
  clearGlobal();
  getPaymentRegistry().register(fakeProvider());
});
afterEach(async () => {
  inject.refuse.clear();
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('revoking a manual subscription', () => {
  it("tells the member the tier's display name", async () => {
    writePremium({ [G]: { active: manualSub('m1', 'high'), paused: [] } });
    expect(m().revokeManual(G)).toBe(true);
    expect(noticesOf('manual.grant.revoked').map(n => n.payload)).toEqual([{ tierName: 'High' }]);
  });

  it('names a tier that no longer exists by its id, and the revoke is still saved', async () => {
    writePremium({ [G]: { active: manualSub('m1', 'ghost'), paused: [] } });
    expect(m().revokeManual(G)).toBe(true);
    expect(noticesOf('manual.grant.revoked').map(n => n.payload)).toEqual([{ tierName: 'ghost' }]);
    expect((await stored()).subscriptions[G]).toBeUndefined();
  });
});

describe('starting a paid subscription through a sync provider', () => {
  it("writes the install line by the admin with the variant, and tells the member the tier's name", async () => {
    const tiers = {
      ...TIERS,
      low: { ...TIERS.low, offerings: [{ id: 'o1', label: 'Low', providerLinks: [{ providerId: 'fake', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'v1' }] } }] }] },
    };
    writePremium({}, { tiers, activatedProviders: { fake: { activatedAt: new Date().toISOString() } } });
    await m().initiatePaidSubscription(G, 'low', 'o1', { providerId: 'fake', variantId: 'v1' });
    const line = (await audit()).find(l => l.action === 'subscription.install.paid');
    expect(line).toMatchObject({ actor: 'admin', guildId: G, tierId: 'low', providerId: 'fake' });
    expect(line.metadata).toEqual({ variantId: 'v1' });
    const started = noticesOf('paid.sub.started');
    expect(started).toHaveLength(1);
    expect(started[0].payload).toMatchObject({ tierName: 'Low', providerName: 'Fake Pay' });
    expect(typeof started[0].payload.endDate).toBe('string');
  });
});

describe('the soft cancel of a paid subscription', () => {
  it("tells the member the tier's display name", async () => {
    writePremium({ [G]: { active: paidSub('s1', 'ps1', 'low'), paused: [] } });
    expect(await m().cancelPaidSubscription(G)).toBe(true);
    expect(noticesOf('paid.sub.cancelled-by-user').map(n => n.payload.tierName)).toEqual(['Low']);
  });

  it('names a tier that no longer exists by its id', async () => {
    writePremium({ [G]: { active: paidSub('s1', 'ps1', 'ghost'), paused: [] } });
    expect(await m().cancelPaidSubscription(G)).toBe(true);
    expect(noticesOf('paid.sub.cancelled-by-user').map(n => n.payload.tierName)).toEqual(['ghost']);
  });
});

describe('the immediate cancel of the active paid subscription', () => {
  it('writes one cancel line by the admin marked immediate, and tells the member the tier and provider', async () => {
    writePremium({ [G]: { active: paidSub('s1', 'ps1', 'low'), paused: [] } });
    expect(await m().cancelPaidSubscriptionImmediately(G)).toBe(true);
    expect(cancels).toEqual(['ps1']);
    const lines = (await audit()).filter(l => l.action === 'subscription.cancel.paid');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ actor: 'admin', guildId: G, subscriptionId: 's1', providerId: 'fake' });
    expect(lines[0].metadata).toEqual({ immediately: true });
    expect(noticesOf('paid.sub.cancelled-by-user').map(n => n.payload)).toEqual([{ tierName: 'Low', providerName: 'Fake Pay' }]);
    expect((await stored()).subscriptions[G]).toBeUndefined();
  });

  it('names a tier that no longer exists by its id, and the cancel is still saved', async () => {
    writePremium({ [G]: { active: paidSub('s1', 'ps1', 'ghost'), paused: [] } });
    expect(await m().cancelPaidSubscriptionImmediately(G)).toBe(true);
    expect(noticesOf('paid.sub.cancelled-by-user').map(n => n.payload.tierName)).toEqual(['ghost']);
    expect((await stored()).subscriptions[G]).toBeUndefined();
  });

  it('answers false for a guild with no subscriptions', async () => {
    writePremium({});
    await expect(m().cancelPaidSubscriptionImmediately('nobody')).resolves.toBe(false);
  });

  it('answers false and keeps an active manual subscription', async () => {
    writePremium({ [G]: { active: manualSub('m1', 'high'), paused: [] } });
    await expect(m().cancelPaidSubscriptionImmediately(G)).resolves.toBe(false);
    expect(m().getGuildSubscriptions(G)?.active?.id).toBe('m1');
    expect(await audit()).toEqual([]);
  });

  it('a subscription removed during the provider call is not cancelled again, and the rest of the queue is kept', async () => {
    writePremium({ [G]: { active: paidSub('s1', 'ps1', 'high'), paused: [paidSub('y1', 'psy', 'low', 'other')] } });
    onCancel = () => {
      const cfg = m().getFullConfig();
      delete cfg.subscriptions[G].active;
      expect(m().setFullConfig(cfg)).toBe(true);
    };
    expect(await m().cancelPaidSubscriptionImmediately(G)).toBe(true);
    expect((await stored()).subscriptions[G].paused.map((p: any) => p.id)).toEqual(['y1']);
    expect((await audit()).filter(l => l.action === 'subscription.cancel.paid')).toEqual([]);
  });
});

describe('cancelling a paused subscription', () => {
  it('removes the one asked for, not the first in the queue', async () => {
    writePremium({ [G]: { active: paidSub('a1', 'psa', 'high'), paused: [paidSub('p1', 'ps1', 'low'), paidSub('p2', 'ps2', 'low')] } });
    expect(await m().cancelAndRemovePausedSubscription(G, 'p2')).toBe(true);
    expect(cancels).toEqual(['ps2']);
    expect((await stored()).subscriptions[G].paused.map((p: any) => p.id)).toEqual(['p1']);
  });

  it('a manual one writes a revoke line by the admin marked from the queue, and sends no cancel notice', async () => {
    writePremium({ [G]: { active: paidSub('a1', 'psa', 'high'), paused: [manualSub('m1', 'low')] } });
    expect(await m().cancelAndRemovePausedSubscription(G, 'm1')).toBe(true);
    const lines = await audit();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ actor: 'admin', action: 'subscription.revoke.manual', guildId: G, subscriptionId: 'm1' });
    expect(lines[0].metadata).toEqual({ fromPausedQueue: true });
    expect(notices.sent).toEqual([]);
  });

  it('a paid one sends no cancel notice either', async () => {
    writePremium({ [G]: { active: paidSub('a1', 'psa', 'high'), paused: [paidSub('p1', 'ps1', 'low')] } });
    expect(await m().cancelAndRemovePausedSubscription(G, 'p1')).toBe(true);
    expect(notices.sent).toEqual([]);
  });

  it('answers false for a guild with no subscriptions', async () => {
    writePremium({});
    await expect(m().cancelAndRemovePausedSubscription('nobody', 'x')).resolves.toBe(false);
  });
});

describe('changes refused while premium-tiers.json cannot be read', () => {
  it('cancel and reactivate of a paid subscription answer false', async () => {
    unreadable();
    expect(await m().cancelPaidSubscription(G)).toBe(false);
    expect(await m().reactivatePaidSubscription(G)).toBe(false);
  });

  it('adopting and cancelling an orphan answer false', async () => {
    unreadable();
    await expect(m().adoptOrphan(G, 'nope', 'ps')).resolves.toBe(false);
    await expect(m().cancelOrphan('nope', 'ps')).resolves.toBe(false);
  });

  it('setting the notices channel answers false and the guild shows no record', () => {
    unreadable();
    expect(m().setNotificationsChannelId(G, '123')).toBe(false);
    expect(m().getGuildSubscriptions(G)).toBeNull();
  });

  it('linking an account answers false and the link does not show', () => {
    unreadable();
    expect(m().linkAccount('fake', 'acct', G)).toBe(false);
    expect(m().getAccountLink('fake', 'acct')).toBeUndefined();
  });

  it('unlinking an account, directly or with its subscriptions, answers false', async () => {
    unreadable();
    expect(m().unlinkAccount('fake', 'acct')).toBe(false);
    await expect(m().unlinkProviderAccount(G, 'fake')).resolves.toBe(false);
  });
});

describe('after a stop, the last saved text judges whether a removal landed', () => {
  const holds = (guildId: string, id: string): boolean => (m() as any).savedStillHolds(guildId, id);
  const load = (subscriptions: unknown) => {
    fs.writeFileSync(PREMIUM, JSON.stringify({ tiers: TIERS, ...(subscriptions === undefined ? {} : { subscriptions }) }));
    resetPremiumManager();
    m();
  };

  it('a text with no subscriptions holds nothing', () => {
    load(undefined);
    expect(holds(G, 'x')).toBe(false);
  });

  it('a guild whose active id differs and whose queue is empty does not hold it', () => {
    load({ [G]: { active: paidSub('a', 'psa'), paused: [] } });
    expect(holds(G, 'zzz')).toBe(false);
  });

  it('a queue holding the id among others holds it', () => {
    load({ [G]: { paused: [paidSub('x', 'psx'), paidSub('y', 'psy')] } });
    expect(holds(G, 'x')).toBe(true);
  });

  it('a queue holding only the id holds it', () => {
    load({ [G]: { paused: [paidSub('x', 'psx')] } });
    expect(holds(G, 'x')).toBe(true);
  });

  it('a queue holding only another id does not', () => {
    load({ [G]: { paused: [paidSub('y', 'psy')] } });
    expect(holds(G, 'x')).toBe(false);
  });

  it('a text whose queue cannot be read counts as still holding it', () => {
    load({ [G]: { active: paidSub('a', 'psa'), paused: 5 } });
    expect(holds(G, 'x')).toBe(true);
  });
});

describe("unlinking a provider account with the guild's subscriptions", () => {
  it("uses this guild's link, not the first one the provider has", async () => {
    writePremium({}, { providerAccountLinks: { fake: { acctA: 'other', acctB: G } } });
    expect(await m().unlinkProviderAccount(G, 'fake')).toBe(true);
    expect((await stored()).providerAccountLinks).toEqual({ fake: { acctA: 'other' } });
  });

  it("cancels only the paid subscriptions of that provider and keeps manual and other providers' ones", async () => {
    getPaymentRegistry().register(fakeProvider('other'));
    writePremium({
      [G]: {
        active: paidSub('a1', 'psa', 'high', 'other'),
        paused: [manualSub('m1', 'low'), manualSub('m2', 'low', { providerId: 'fake' }), paidSub('q1', 'psq', 'low', 'other'), paidSub('p1', 'psp', 'low', 'fake')],
      },
    }, { providerAccountLinks: { fake: { acct: G } } });
    expect(await m().unlinkProviderAccount(G, 'fake')).toBe(true);
    expect(cancels).toEqual(['psp']);
    const saved = await stored();
    expect(saved.subscriptions[G].active.id).toBe('a1');
    expect(saved.subscriptions[G].paused.map((p: any) => p.id)).toEqual(['m1', 'm2', 'q1']);
    expect(saved.providerAccountLinks).toEqual({});
  });

  it('tries each subscription id once: a second record under the same id is not cancelled by the same request', async () => {
    writePremium({ [G]: { paused: [paidSub('dup', 'psA'), paidSub('dup', 'psB')] } }, { providerAccountLinks: { fake: { acct: G } } });
    expect(await m().unlinkProviderAccount(G, 'fake')).toBe(true);
    expect(cancels).toEqual(['psA']);
  });

  it('stops at a step that did not save: answers true, cancels nothing more and keeps the link', async () => {
    writePremium({ [G]: { paused: [paidSub('p1', 'ps1'), paidSub('p2', 'ps2')] } }, { providerAccountLinks: { fake: { acct: G } } });
    onCancel = () => { inject.refuse.add('premium-tiers.json'); };
    expect(await m().unlinkProviderAccount(G, 'fake')).toBe(true);
    expect(cancels).toEqual(['ps1']);
    expect(m().getAccountLink('fake', 'acct')).toBe(G);
    inject.refuse.clear();
    expect((await stored()).providerAccountLinks).toEqual({ fake: { acct: G } });
  });

  it('keeps the link when the account was linked to another guild meanwhile', async () => {
    writePremium({ [G]: { paused: [paidSub('p1', 'ps1')] } }, { providerAccountLinks: { fake: { acct: G } } });
    onCancel = () => {
      expect(m().unlinkAccount('fake', 'acct')).toBe(true);
      expect(m().linkAccount('fake', 'acct', 'other')).toBe(true);
    };
    expect(await m().unlinkProviderAccount(G, 'fake')).toBe(true);
    expect((await stored()).providerAccountLinks).toEqual({ fake: { acct: 'other' } });
  });

  it("answers true when the provider's links were all removed meanwhile", async () => {
    writePremium({ [G]: { paused: [paidSub('p1', 'ps1')] } }, { providerAccountLinks: { fake: { acct: G } } });
    onCancel = () => { expect(m().unlinkAccount('fake', 'acct')).toBe(true); };
    await expect(m().unlinkProviderAccount(G, 'fake')).resolves.toBe(true);
    expect((await stored()).providerAccountLinks).toEqual({});
  });
});
