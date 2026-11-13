import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A survivors in premiumManager.ts: the orphan adoption's audit line and skip answers, the operator and member
// audit lines of messages, migrations and the silence policy, the migration apply's provider calls and notices, the
// carry a stopped migration run leaves behind, the expiry tick that changes nothing, and the answers of the saves.

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
import { openItemsOf } from '../../src/bot/internalSetup/utils/premiumItems';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import type { PaymentProvider } from '../../src/bot/internalSetup/utils/payment/paymentTypes';
import { AUDIT, clearGlobal, jsonOf, linesOf, logged, paidSub, PREMIUM, quiet, settleQueue, TIERS, writePremium } from './nb10PremiumRig';

const G = 'g1';
const G2 = 'g2';
const PAST = new Date(Date.now() - 86_400_000).toISOString();
const FUTURE = new Date(Date.now() + 10 * 86_400_000).toISOString();

const fake = {
  refs: [] as any[],
  cancels: [] as Array<[string, boolean | undefined]>,
  migrates: [] as string[],
  onMigrate: null as ((n: number) => void) | null,
};

function fakeProvider(): PaymentProvider {
  return {
    id: 'fake',
    displayName: 'Fake Pay',
    isConfigured: () => true,
    capabilities: { canInitiatePurchase: true, supportsCancel: true, supportsReactivate: true, supportsCoupons: false, supportsPause: false, supportsPriceMigration: true },
    cancelSubscription: async (providerSubId: string, immediately?: boolean) => {
      fake.cancels.push([providerSubId, immediately]);
    },
    migrateSubscriptionPrice: async (providerSubId: string) => {
      fake.migrates.push(providerSubId);
      fake.onMigrate?.(fake.migrates.length);
    },
    listSubscriptionsForGuild: async (guildId: string) => fake.refs.filter(r => r.metadata.guildId === guildId).map(r => JSON.parse(JSON.stringify(r))),
  } as unknown as PaymentProvider;
}

const activeRef = (providerSubId: string, tierId: string, offeringId: string) => ({
  providerSubId,
  metadata: { guildId: G, tierId, offeringId },
  state: { status: 'active', startDate: new Date().toISOString(), endDate: FUTURE, autoRenew: true },
  display: { amountLabel: '', periodLabel: '', statusLabel: 'active' },
});

const VARIANT_TIERS = {
  ...TIERS,
  low: { ...TIERS.low, offerings: [{ id: 'o1', label: 'Low', providerLinks: [{ providerId: 'fake', enabled: true, mode: 'price', cache: { variants: [{ variantId: 'v1', label: 'V1', amount: 1, currency: 'USD' }] } }] }] },
  high: { ...TIERS.high, offerings: [{ id: 'o2', label: 'High', providerLinks: [{ providerId: 'fake', enabled: true, mode: 'price', cache: { variants: [{ variantId: 'v2', label: 'V2', amount: 2, currency: 'USD' }] } }] }] },
};

const subV1 = (id: string, providerSubId: string) => ({ ...paidSub(id, providerSubId, 'low'), variantId: 'v1' });

const migration = (decisions: unknown[], over: Record<string, unknown> = {}) => ({
  id: 'mig1', providerId: 'fake', sourceTierId: 'low', sourceOfferingId: 'o1', sourceVariantId: 'v1',
  targetTierId: 'high', targetOfferingId: 'o2', targetVariantId: 'v2', effectiveDate: PAST, message: '',
  scheduledAt: PAST, scheduledBy: 'admin', status: 'pending', decisions, ...over,
});
const decision = (guildId: string, subscriptionId: string, providerSubId: string, d: string) => ({
  guildId, subscriptionId, providerSubId, decision: d, decidedAt: PAST, notifiedAt: PAST,
});

const m = () => getPremiumManager();
const audit = async () => { await settleQueue(); return linesOf(AUDIT); };
const stored = async () => { await settleQueue(); return jsonOf(PREMIUM); };
const noticesOf = (kind: string) => notices.sent.filter(n => n.kind === kind);
const until = async (fn: () => boolean) => vi.waitFor(() => expect(fn()).toBe(true), { timeout: 2000, interval: 2 });

let spies: ReturnType<typeof quiet>;

beforeEach(async () => {
  spies = quiet();
  vi.stubEnv('BOT_PROCESS_ROLE', 'webui');
  inject.refuse.clear();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  notices.sent = [];
  fake.refs = [];
  fake.cancels = [];
  fake.migrates = [];
  fake.onMigrate = null;
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

describe('adopting an orphan', () => {
  it('writes the adoption line by the admin with the provider subscription, tier and offering', async () => {
    writePremium({});
    fake.refs = [activeRef('os1', 'low', 'o1')];
    expect(await m().adoptOrphan(G, 'fake', 'os1', { kind: 'install' })).toBe(true);
    const line = (await audit()).find(l => l.action === 'subscription.adopt.orphan');
    expect(line).toMatchObject({ actor: 'admin', guildId: G, providerId: 'fake' });
    expect(line.metadata).toEqual({ providerSubId: 'os1', tierId: 'low', offeringId: 'o1' });
    expect((await stored()).subscriptions[G].active).toMatchObject({ providerSubId: 'os1', tierId: 'low' });
  });

  it('names a missing offering, and leaves no adoption line pending', async () => {
    writePremium({});
    fake.refs = [activeRef('os1', 'low', 'o9')];
    await expect(m().adoptOrphan(G, 'fake', 'os1', { kind: 'install' })).rejects.toThrow("Subscription 'os1' was not adopted: tier 'low' has no offering 'o9'.");
    expect(openItemsOf(m())).toEqual([]);
    expect((await audit()).filter(l => l.action === 'subscription.adopt.orphan')).toEqual([]);
  });

  it("says the subscription is already held when another provider's subscription has its id, and leaves no line pending", async () => {
    writePremium({ [G]: { active: paidSub('s1', 'os1', 'low', 'other'), paused: [] } });
    fake.refs = [activeRef('os1', 'high', 'o2')];
    await expect(m().adoptOrphan(G, 'fake', 'os1', { kind: 'install' })).rejects.toThrow("Subscription 'os1' was not adopted: it is already in this bot's subscriptions.");
    expect(openItemsOf(m())).toEqual([]);
    expect((await audit()).filter(l => l.action === 'subscription.adopt.orphan')).toEqual([]);
  });
});

describe('the notifications channel', () => {
  it('answers true when the channel is saved', async () => {
    writePremium({ [G]: { active: paidSub('s1', 'ps1', 'low'), paused: [] } });
    expect(m().setNotificationsChannelId(G, '123')).toBe(true);
    expect((await stored()).subscriptions[G].notificationsChannelId).toBe('123');
  });
});

describe('member messages', () => {
  it('a change writes the message line by the admin', async () => {
    writePremium({});
    expect(m().setMessages({ moduleBlocked: 'blocked text' })).toBe(true);
    const line = (await audit()).find(l => l.action === 'message.update');
    expect(line).toMatchObject({ actor: 'admin' });
    expect(line.after).toMatchObject({ moduleBlocked: 'blocked text' });
  });

  it('a reset answers true and writes the message line by the admin marked as a reset', async () => {
    writePremium({}, { messages: { moduleBlocked: 'old text' } });
    expect(m().resetMessages()).toBe(true);
    const lines = (await audit()).filter(l => l.action === 'message.update');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ actor: 'admin', before: { moduleBlocked: 'old text' } });
    expect(lines[0].metadata).toEqual({ reset: true });
    expect(openItemsOf(m())).toEqual([]);
    expect((await stored()).messages.moduleBlocked).not.toBe('old text');
  });
});

describe('the migration silence policy', () => {
  it('a change answers true and writes the policy line by the admin', async () => {
    writePremium({});
    expect(m().setMigrationSilencePolicy('continue')).toBe(true);
    const line = (await audit()).find(l => l.action === 'migration.silence-policy.set');
    expect(line).toMatchObject({ actor: 'admin', before: 'cancel', after: 'continue' });
    expect((await stored()).migrationSilencePolicy).toBe('continue');
  });
});

describe('scheduling a migration', () => {
  const opts = { providerId: 'fake', sourceTierId: 'low', sourceOfferingId: 'o1', sourceVariantId: 'v1', targetTierId: 'high', targetOfferingId: 'o2', targetVariantId: 'v2', effectiveDate: FUTURE, message: '' };

  it('a refused save answers that the migration was not saved', async () => {
    writePremium({ [G]: { active: subV1('s1', 'ps1'), paused: [] } }, { tiers: VARIANT_TIERS });
    m().getMessages();
    inject.refuse.add('premium-tiers.json');
    await expect(m().scheduleMigration(opts)).rejects.toThrow('Failed to persist migration.');
  });

  it('a delivered request stamps the decision with no warning', async () => {
    writePremium({ [G]: { active: subV1('s1', 'ps1'), paused: [] } }, { tiers: VARIANT_TIERS });
    await m().scheduleMigration(opts);
    await until(() => noticesOf('migration.scheduled').length === 1);
    await until(() => !!m().listMigrations()[0]?.decisions[0]?.notifiedAt);
    expect(logged(spies.warn).filter(l => l.includes('not recorded'))).toEqual([]);
  });

  it('a delivered request whose stamp is refused warns that the delivery was not recorded', async () => {
    writePremium({ [G]: { active: subV1('s1', 'ps1'), paused: [] } }, { tiers: VARIANT_TIERS });
    const run = m().scheduleMigration(opts);
    inject.refuse.add('premium-tiers.json');
    const scheduled = await run;
    await until(() => logged(spies.warn).some(l => l.includes('not recorded')));
    expect(logged(spies.warn).filter(l => l.includes('not recorded'))).toEqual([
      `[PremiumManager] Migration ${scheduled.id}: delivery to guild ${G} not recorded (save failed)`,
    ]);
  });
});

describe('a migration decision', () => {
  it('writes the decision line by the guild owner with the decision', async () => {
    writePremium({ [G]: { active: subV1('s1', 'ps1'), paused: [] } }, { tiers: VARIANT_TIERS, migrations: [migration([{ guildId: G, subscriptionId: 's1', providerSubId: 'ps1', decision: 'pending' }], { effectiveDate: FUTURE })] });
    expect(m().recordMigrationDecision('mig1', G, 'declined')).toBe(true);
    const line = (await audit()).find(l => l.action === 'migration.decision');
    expect(line).toMatchObject({ actor: 'guild-owner', guildId: G, migrationId: 'mig1' });
    expect(line.metadata).toEqual({ decision: 'declined' });
  });

  it('names a target tier that no longer exists by its id', async () => {
    writePremium({ [G]: { active: subV1('s1', 'ps1'), paused: [] } }, { tiers: VARIANT_TIERS, migrations: [migration([{ guildId: G, subscriptionId: 's1', providerSubId: 'ps1', decision: 'pending' }], { effectiveDate: FUTURE, targetTierId: 'ghost' })] });
    expect(m().recordMigrationDecision('mig1', G, 'accepted')).toBe(true);
    await until(() => noticesOf('migration.accepted').length === 1);
    expect(noticesOf('migration.accepted')[0].payload).toMatchObject({ tierName: 'ghost' });
  });

  it('cancelling a migration writes the cancel line by the admin', async () => {
    writePremium({}, { migrations: [migration([], { effectiveDate: FUTURE })] });
    expect(m().cancelMigration('mig1')).toBe(true);
    const line = (await audit()).find(l => l.action === 'migration.cancelled');
    expect(line).toMatchObject({ actor: 'admin', migrationId: 'mig1', providerId: 'fake' });
  });
});

describe('applying a due migration', () => {
  it('a declined decision is set to cancel at period end and gets no applied notice; an accepted one does', async () => {
    writePremium({
      [G]: { active: subV1('s1', 'ps1'), paused: [] },
      [G2]: { active: subV1('s2', 'ps2'), paused: [] },
    }, { tiers: VARIANT_TIERS, migrations: [migration([decision(G, 's1', 'ps1', 'declined'), decision(G2, 's2', 'ps2', 'accepted')])] });
    await m().processDueMigrations();
    expect(fake.cancels).toEqual([['ps1', false]]);
    await until(() => noticesOf('migration.applied').length >= 1);
    await settleQueue();
    expect(noticesOf('migration.applied').map(n => n.guildId)).toEqual([G2]);
    const decisions = (await stored()).migrations[0].decisions;
    expect(decisions.map((d: any) => d.outcome)).toEqual(['cancelled', 'migrated']);
  });

  const unreadableOnMigrate = (call: number) => {
    fake.onMigrate = n => {
      if (n !== call) return;
      fs.writeFileSync(PREMIUM, '{not json');
      m().invalidate();
      m().getMessages();
    };
  };

  it('premium-tiers.json turning unreadable during the last decision leaves no notice pending', async () => {
    writePremium({ [G]: { active: subV1('s1', 'ps1'), paused: [] } }, { tiers: VARIANT_TIERS, migrations: [migration([decision(G, 's1', 'ps1', 'accepted')])] });
    unreadableOnMigrate(1);
    await m().processDueMigrations();
    expect(fake.migrates).toEqual(['ps1']);
    expect(m().cacheState()).toBe('unreadable');
    expect(openItemsOf(m())).toEqual([]);
    await settleQueue();
    expect(noticesOf('migration.applied')).toEqual([]);
  });

  it('premium-tiers.json turning unreadable before a later decision stops the run and leaves no notice pending', async () => {
    writePremium({
      [G]: { active: subV1('s1', 'ps1'), paused: [] },
      [G2]: { active: subV1('s2', 'ps2'), paused: [] },
    }, { tiers: VARIANT_TIERS, migrations: [migration([decision(G, 's1', 'ps1', 'accepted'), decision(G2, 's2', 'ps2', 'accepted')])] });
    unreadableOnMigrate(1);
    await m().processDueMigrations();
    expect(fake.migrates).toEqual(['ps1']);
    expect(openItemsOf(m())).toEqual([]);
    await settleQueue();
    expect(noticesOf('migration.applied')).toEqual([]);
  });
});

describe('the expiry tick', () => {
  it('leaves premium-tiers.json untouched when no subscription ended', async () => {
    const compact = JSON.stringify({ tiers: TIERS, subscriptions: { [G]: { active: paidSub('s1', 'ps1', 'low'), paused: [] } }, messages: {}, providerAccountLinks: {}, activatedProviders: {}, migrations: [], migrationSilencePolicy: 'cancel' });
    fs.writeFileSync(PREMIUM, compact);
    m().getMessages();
    await settleQueue();
    (m() as any).checkExpiry();
    await settleQueue();
    expect(fs.readFileSync(PREMIUM, 'utf8')).toBe(compact);
  });
});
