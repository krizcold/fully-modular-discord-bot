import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unconfirmUnansweredRows } from '../../src/bot/internalSetup/utils/sharedStore';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { AUDIT_KEY, PREMIUM_KEY, premiumRig } from '../helpers/nb6PremiumRig';
import { DAY_MS, DUMMY_KEY, MONTHLY, YEARLY, dummyRig } from '../helpers/nb6DummyRig';

// NB6 test 59 (wip-redesign/sheets/NB6.md decision 63's site table as 72, 73, 94 and 110 amend it, 29 rows; rows 240,
// 242, 243, 245, 268, 272, 275 to 281, 287 to 289, 315 and 325): each audit line, member notice and provider event of
// premium and the Dummy provider rides the op of the save that stores its change, or, standalone, a lines-only op of
// its own and a notice sent at once. A provider that returns its state (the Dummy) carries premium's cancel and
// reactivate items; one that returns nothing makes them standalone. The real PremiumManager and DummyProvider in the
// bot process role, the real row flush over the scripted shared tables.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  let registry: InstanceType<typeof real.PaymentProviderRegistry> | null = null;
  return { ...real, getPaymentRegistry: () => (registry ??= new real.PaymentProviderRegistry()) };
});
const notices = vi.hoisted(() => ({ sent: [] as Array<{ kind: string; guild: string; premiumCommits: number }>, commits: (() => 0) as () => number }));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async (guildId: string, kind: string) => {
    notices.sent.push({ kind, guild: guildId, premiumCommits: notices.commits() });
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

/** A provider that stores its changes and returns no state (decision 72's void path). */
const voidCalls: string[] = [];
const voidProvider = {
  id: 'nb6v',
  displayName: 'NB6 Void',
  capabilities: {
    canInitiatePurchase: true, supportsCancel: true, supportsReactivate: true, supportsCoupons: false, supportsPause: true,
    supportsMultipleVariants: true, supportsProductMode: false, supportsHostedPicker: false, supportsCustomerPortal: false,
    supportsAnnualBilling: false, supportsPriceMigration: true, mechanism: 'immediate',
  },
  isConfigured: () => true,
  initiatePurchase: async (o: any) => ({
    providerSubId: `v_${o.guildId}`,
    state: { status: 'active', startDate: new Date().toISOString(), endDate: new Date(Date.now() + 30 * DAY_MS).toISOString(), autoRenew: true },
  }),
  listSubscriptionsForGuild: async () => [],
  cancelSubscription: async (id: string) => { voidCalls.push(`cancel:${id}`); },
  reactivateSubscription: async (id: string) => { voidCalls.push(`reactivate:${id}`); },
  pauseSubscription: async (id: string) => { voidCalls.push(`pause:${id}`); },
  resumeSubscription: async (id: string) => { voidCalls.push(`resume:${id}`); },
  migrateSubscriptionPrice: async () => undefined,
};
const VOID_VARIANT = { variantId: 'v_m', label: 'Monthly', amount: 500, currency: 'USD', durationDays: 30, recurring: true, active: true };
const bronze = {
  displayName: 'Bronze', priority: 3, overrides: {},
  offerings: [{ id: 'o3', label: 'Bronze', providerLinks: [{ providerId: 'nb6v', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'v_m' }] }, cache: { syncedAt: '2026-01-01T00:00:00.000Z', variants: [VOID_VARIANT] } }] }],
};

const premiumCommits = () => r.m.state.rows.history.filter(h => h.key === PREMIUM_KEY).length;
const premiumSub = (guild = 'g1') => r.row()?.subscriptions?.[guild]?.active;
const auditActions = () => r.lines(AUDIT_KEY).map(l => l.action);

/** The SQL of the last transaction that inserted the audit line `action`, from its BEGIN to its COMMIT. */
function txOfLine(action: string): string[] {
  const sent = r.m.state.pg.sent;
  let at = -1;
  for (let i = sent.length - 1; i >= 0; i--) {
    const s = sent[i];
    if (s.sql.startsWith('INSERT INTO smdb_data.shared_lines') && String(s.params?.[0]) === AUDIT_KEY
      && JSON.parse(Buffer.from(s.params![2] as Buffer).toString('utf8')).action === action) {
      at = i;
      break;
    }
  }
  expect(at, `no line ${action}`).toBeGreaterThanOrEqual(0);
  const client = sent[at].client;
  let begin = at;
  while (begin > 0 && !(sent[begin].client === client && sent[begin].sql.startsWith('BEGIN'))) begin--;
  let end = at;
  while (end < sent.length - 1 && !(sent[end].client === client && sent[end].sql === 'COMMIT')) end++;
  return sent.slice(begin, end + 1).filter(s => s.client === client).map(s => s.sql + (s.sql.startsWith('INSERT INTO smdb_data.shared_docs') ? ` ${String(s.params?.[0])}` : ''));
}

beforeEach(async () => {
  await d.setup();
  notices.commits = premiumCommits;
  notices.sent.length = 0;
  inject.premium.length = 0;
  inject.dummy.length = 0;
  voidCalls.length = 0;
  getPaymentRegistry().register(voidProvider as any);
  const pm = r.pm();
  pm.setTier('bronze', bronze as any);
  pm.setProviderActivation('nb6v', true);
  await d.settle();
});
afterEach(async () => {
  getPaymentRegistry().unregister('nb6v');
  await d.teardown();
});

const buyVoid = async (guild = 'g1') => {
  await r.pm().initiatePaidSubscription(guild, 'bronze', 'o3', { providerId: 'nb6v', variantId: 'v_m' });
  await d.settle();
};
const orphan = async (guild = 'g1', paused = false, tierId = 'gold') => {
  const result = await d.dummy.initiatePurchase({ guildId: guild, tierId, offeringId: tierId === 'silver' ? 'o2' : 'o1', variantId: MONTHLY, ...(paused ? { startPausedUntil: null } : {}) });
  await d.settle();
  return result.providerSubId!;
};
const planOf = async (guild: string, id: string) => (await r.pm().findOrphansForGuild(guild)).find(o => o.ref.providerSubId === id)?.plan;
const schedule = async () => {
  const migration = await r.pm().scheduleMigration({
    providerId: 'dummy', sourceTierId: 'gold', sourceOfferingId: 'o1', sourceVariantId: MONTHLY,
    targetTierId: 'gold', targetOfferingId: 'o1', targetVariantId: YEARLY,
    effectiveDate: new Date(Date.now() + DAY_MS).toISOString(), message: '',
  });
  await d.settle();
  return migration;
};
const expiryCheck = async () => {
  r.pm().startExpiryChecker(60_000);
  vi.advanceTimersByTime(60_000);
  r.pm().stopExpiryChecker();
  await d.settle();
};
const event = (type: string, extra: object = {}) => ({ type, providerId: 'nb6v', providerSubId: 'v_g1', guildId: 'g1', ...extra });

type Item = { audit?: string; notice?: string; link: 'carry' | 'standalone' };
type Site = { site: string; setup?: () => Promise<unknown>; drive: (setup: any) => Promise<unknown>; items: Item[] };

const SITES: Site[] = [
  { site: 'premiumManager.ts:565 renewal-failed', setup: () => buyVoid(), drive: async () => { getPaymentRegistry().emitEvent(event('subscription.renewal-failed', { reason: 'declined' }) as any); }, items: [{ notice: 'paid.sub.renewal-failed', link: 'standalone' }] },
  { site: 'premiumManager.ts:598, 606 expired', setup: () => buyVoid(), drive: async () => { getPaymentRegistry().emitEvent(event('subscription.expired', { state: { status: 'expired', startDate: premiumSub().startDate, endDate: premiumSub().endDate, autoRenew: false } }) as any); }, items: [{ audit: 'subscription.expire.paid', link: 'carry' }, { notice: 'paid.sub.expired', link: 'carry' }] },
  { site: 'premiumManager.ts:672, 683 a webhook install', drive: async () => { getPaymentRegistry().emitEvent(event('subscription.created', { tierId: 'bronze', offeringId: 'o3', variantId: 'v_m', state: { status: 'active', startDate: new Date().toISOString(), endDate: null, autoRenew: false } }) as any); }, items: [{ audit: 'subscription.install.paid', link: 'carry' }, { notice: 'paid.sub.started', link: 'carry' }] },
  { site: 'premiumManager.ts:951, 967 setTier', drive: async () => r.pm().setTier('bronze', { ...bronze, displayName: 'Bronze 2' } as any), items: [{ audit: 'tier.update', link: 'carry' }] },
  { site: 'premiumManager.ts:1083 deleteTier', setup: async () => r.pm().setTier('temp', { displayName: 'Temp', priority: 7, overrides: {}, offerings: [] }), drive: async () => r.pm().deleteTier('temp'), items: [{ audit: 'tier.delete', link: 'carry' }] },
  { site: 'premiumManager.ts:1192 setProviderActivation', drive: async () => r.pm().setProviderActivation('nb6v', false), items: [{ audit: 'provider.activation.set', link: 'carry' }] },
  { site: 'premiumManager.ts:1432, 1441 pauseActiveIntoQueue', setup: () => d.buy('g1', 'silver'), drive: () => d.buy('g1', 'gold'), items: [{ audit: 'subscription.pause', link: 'carry' }, { notice: 'paid.sub.paused-by-stacking', link: 'carry' }] },
  { site: 'premiumManager.ts:1497 to 1543 resumeNext', setup: async () => { await d.buy('g1', 'gold'); await d.buy('g1', 'silver'); }, drive: () => r.pm().cancelPaidSubscriptionImmediately('g1'), items: [{ audit: 'subscription.resume', link: 'carry' }, { notice: 'paid.sub.resumed-from-queue', link: 'carry' }] },
  { site: 'premiumManager.ts:1601, 1610 grantManual', drive: () => r.pm().grantManual('g1', 'gold', 30), items: [{ audit: 'subscription.grant.manual', link: 'carry' }, { notice: 'manual.grant.added', link: 'carry' }] },
  { site: 'premiumManager.ts:1638 extendManual', setup: () => r.pm().grantManual('g1', 'gold', 30), drive: async () => r.pm().extendManual('g1', 5), items: [{ audit: 'subscription.extend.manual', link: 'carry' }] },
  { site: 'premiumManager.ts:1675, 1683 revokeManual', setup: () => r.pm().grantManual('g1', 'gold', 30), drive: async () => r.pm().revokeManual('g1'), items: [{ audit: 'subscription.revoke.manual', link: 'carry' }, { notice: 'manual.grant.revoked', link: 'carry' }] },
  { site: 'premiumManager.ts:1845, 1856 initiatePaidSubscription', drive: () => d.buy(), items: [{ audit: 'subscription.install.paid', link: 'carry' }, { notice: 'paid.sub.started', link: 'carry' }] },
  { site: 'premiumManager.ts:1880, 1889 cancelPaidSubscription, the Dummy', setup: () => d.buy(), drive: () => r.pm().cancelPaidSubscription('g1'), items: [{ audit: 'subscription.cancel.paid', link: 'carry' }, { notice: 'paid.sub.cancelled-by-user', link: 'carry' }] },
  { site: 'premiumManager.ts:1880, 1889 cancelPaidSubscription, a void provider', setup: () => buyVoid(), drive: () => r.pm().cancelPaidSubscription('g1'), items: [{ audit: 'subscription.cancel.paid', link: 'standalone' }, { notice: 'paid.sub.cancelled-by-user', link: 'standalone' }] },
  { site: 'premiumManager.ts:1908 reactivatePaidSubscription, the Dummy', setup: async () => { await d.buy(); await r.pm().cancelPaidSubscription('g1'); }, drive: () => r.pm().reactivatePaidSubscription('g1'), items: [{ audit: 'subscription.reactivate.paid', link: 'carry' }] },
  { site: 'premiumManager.ts:1908 reactivatePaidSubscription, a void provider', setup: () => buyVoid(), drive: () => r.pm().reactivatePaidSubscription('g1'), items: [{ audit: 'subscription.reactivate.paid', link: 'standalone' }] },
  { site: 'premiumManager.ts:1936, 1945 cancelPaidSubscriptionImmediately', setup: () => d.buy(), drive: () => r.pm().cancelPaidSubscriptionImmediately('g1'), items: [{ audit: 'subscription.cancel.paid', link: 'carry' }, { notice: 'paid.sub.cancelled-by-user', link: 'carry' }] },
  { site: 'premiumManager.ts:1976 cancelAndRemovePausedSubscription', setup: async () => { await d.buy('g1', 'gold'); await d.buy('g1', 'silver'); return r.row().subscriptions.g1.paused[0].id; }, drive: id => r.pm().cancelAndRemovePausedSubscription('g1', id), items: [{ audit: 'subscription.cancel.paid', link: 'carry' }] },
  { site: 'premiumManager.ts:2059 adoptOrphan', setup: () => orphan(), drive: async id => r.pm().adoptOrphan('g1', 'dummy', id, await planOf('g1', id)), items: [{ audit: 'subscription.adopt.orphan', link: 'carry' }] },
  { site: 'premiumManager.ts:2077 cancelOrphan', setup: () => orphan(), drive: id => r.pm().cancelOrphan('dummy', id), items: [{ audit: 'subscription.cancel.orphan', link: 'standalone' }] },
  { site: 'premiumManager.ts:2310, 2318 checkExpiry', setup: async () => { await r.pm().grantManual('g1', 'gold', 1); await d.settle(); d.later(2); }, drive: expiryCheck, items: [{ audit: 'subscription.revoke.manual', link: 'carry' }, { notice: 'manual.grant.ended', link: 'carry' }] },
  { site: 'premiumManager.ts:2337 ending-soon', setup: async () => { await r.pm().grantManual('g1', 'gold', 1); await d.settle(); d.later(0.5); }, drive: expiryCheck, items: [{ notice: 'manual.grant.ending-soon', link: 'standalone' }] },
  { site: 'premiumManager.ts:2365 setMessages', drive: async () => r.pm().setMessages({ moduleBlocked: 'Blocked here' }), items: [{ audit: 'message.update', link: 'carry' }] },
  { site: 'premiumManager.ts:2382 resetMessages', setup: async () => r.pm().setMessages({ moduleBlocked: 'Blocked here' }), drive: async () => r.pm().resetMessages(), items: [{ audit: 'message.update', link: 'carry' }] },
  { site: 'premiumManager.ts:2448 setMigrationSilencePolicy', drive: async () => r.pm().setMigrationSilencePolicy(r.pm().getMigrationSilencePolicy() === 'cancel' ? 'continue' : 'cancel'), items: [{ audit: 'migration.silence-policy.set', link: 'carry' }] },
  { site: 'premiumManager.ts:2552, 2576 scheduleMigration', setup: () => d.buy(), drive: schedule, items: [{ audit: 'migration.scheduled', link: 'carry' }, { notice: 'migration.scheduled', link: 'carry' }] },
  { site: 'premiumManager.ts:2612, 2621 recordMigrationDecision', setup: async () => { await d.buy(); return schedule(); }, drive: async m => r.pm().recordMigrationDecision(m.id, 'g1', 'accepted'), items: [{ audit: 'migration.decision', link: 'carry' }, { notice: 'migration.accepted', link: 'carry' }] },
  { site: 'premiumManager.ts:2640 cancelMigration', setup: async () => { await d.buy(); return schedule(); }, drive: async m => r.pm().cancelMigration(m.id), items: [{ audit: 'migration.cancelled', link: 'carry' }] },
  { site: 'premiumManager.ts:2679 applyMigration with no provider', setup: async () => { await d.buy(); await schedule(); getPaymentRegistry().unregister('dummy'); d.later(2); }, drive: () => r.pm().processDueMigrations(), items: [{ audit: 'migration.cancelled', link: 'carry' }] },
  { site: 'premiumManager.ts:2766, 2771, 2781 applyMigration', setup: async () => { await d.buy(); const m = await schedule(); r.pm().recordMigrationDecision(m.id, 'g1', 'accepted'); await d.settle(); d.later(2); }, drive: () => r.pm().processDueMigrations(), items: [{ audit: 'migration.applied', link: 'carry' }, { notice: 'migration.applied', link: 'carry' }] },
];

describe("decision 63's site table (as 72, 73, 94 and 110 amend it)", () => {
  it.each(SITES.map(s => [s.site, s] as const))('%s', async (_name, site) => {
    const made = site.setup ? await site.setup() : undefined;
    await d.settle();
    notices.sent.length = 0;
    const before = premiumCommits();
    await site.drive(made);
    await d.settle();
    for (const item of site.items) {
      if (item.audit) {
        const tx = txOfLine(item.audit);
        const carried = tx.some(sql => sql.startsWith('INSERT INTO smdb_data.shared_docs') && sql.endsWith(PREMIUM_KEY));
        expect(carried, `${item.audit} carried`).toBe(item.link === 'carry');
        if (item.link === 'standalone') expect(tx.some(sql => sql.startsWith('INSERT INTO smdb_data.shared_docs'))).toBe(false);
        const stored = r.lines(AUDIT_KEY).filter(l => l.action === item.audit);
        expect(stored[stored.length - 1].metadata?.notSaved).toBeUndefined();
      }
      if (item.notice) {
        const sent = notices.sent.filter(n => n.kind === item.notice && n.guild === 'g1');
        expect(sent, `${item.notice} sent`).toHaveLength(1);
        if (item.link === 'carry') expect(sent[0].premiumCommits).toBeGreaterThan(before);
        else expect(sent[0].premiumCommits).toBe(before);
      }
    }
  }, 20_000);

  it("dummyProvider.ts:546-575: the walk's batch rides the tick's op; premium applies it once that op landed", async () => {
    await d.buy();
    d.later(31);
    const order: string[] = [];
    r.m.state.rows.fault = (sql, params) => {
      if (sql.startsWith(LOCK_READ)) order.push(String(params?.[0]));
      return undefined;
    };
    await d.tick();
    r.m.state.rows.fault = undefined;
    const dummyAt = order.indexOf(DUMMY_KEY);
    const premiumAt = order.lastIndexOf(PREMIUM_KEY);
    expect(dummyAt).toBeGreaterThanOrEqual(0);
    expect(premiumAt).toBeGreaterThan(dummyAt);
    const history = r.m.state.rows.history.map(h => h.key);
    expect(history.lastIndexOf(PREMIUM_KEY)).toBeGreaterThan(history.lastIndexOf(DUMMY_KEY));
    expect(premiumSub().endDate).toBe(r.m.state.rows.docs.get(DUMMY_KEY) && JSON.parse(r.m.state.rows.docs.get(DUMMY_KEY)!.body.toString('utf8')).subscriptions.dummy_1.endDate);
  });
});

describe('the rows of the Dummy and the orphans', () => {
  it('242: adoptOrphan whose install is skipped (unknown tier): T21; no line', async () => {
    const id = await orphan('g1', false, 'nope');
    const lines = auditActions().length;
    await expect(r.pm().adoptOrphan('g1', 'dummy', id, await planOf('g1', id))).rejects.toThrow(`Subscription '${id}' was not adopted: tier 'nope' does not exist.`);
    await d.settle();
    expect(auditActions()).toHaveLength(lines);
  });

  it("243, 288: adoptOrphan's install landed: the adoption line in installSubscription's save; true", async () => {
    const id = await orphan();
    expect(await r.pm().adoptOrphan('g1', 'dummy', id, await planOf('g1', id))).toBe(true);
    await d.settle();
    const tx = txOfLine('subscription.adopt.orphan');
    expect(tx).toEqual(txOfLine('subscription.install.paid'));
    expect(tx.some(sql => sql.startsWith('INSERT INTO smdb_data.shared_docs') && sql.endsWith(PREMIUM_KEY))).toBe(true);
  });

  it("289: adoptOrphan's install save refused: its lines and the adoption line written marked; false", async () => {
    const id = await orphan();
    const plan = await planOf('g1', id);
    inject.premium.push({ cause: 'unstorable', thrown: false });
    expect(await r.pm().adoptOrphan('g1', 'dummy', id, plan)).toBe(false);
    await d.settle();
    const marked = r.lines(AUDIT_KEY).filter(l => l.action === 'subscription.adopt.orphan' || l.action === 'subscription.install.paid');
    expect(marked.map(l => [l.action, l.metadata.notSaved.cause])).toEqual([['subscription.adopt.orphan', 'unstorable'], ['subscription.install.paid', 'unstorable']]);
    expect(premiumSub()).toBeUndefined();
  });

  it('281: cancelOrphan with the Dummy, landed: the line by a standalone op, plain', async () => {
    const id = await orphan();
    expect(await r.pm().cancelOrphan('dummy', id)).toBe(true);
    await d.settle();
    expect(d.record(id).status).toBe('expired');
    const line = r.lines(AUDIT_KEY).find(l => l.action === 'subscription.cancel.orphan');
    expect(line.metadata.notSaved).toBeUndefined();
  });

  it('268, 272: a purchase and a soft cancel landed: premium copies the state and saves with cancel.paid and the notice', async () => {
    await d.buy();
    expect(premiumSub()).toMatchObject({ providerSubId: 'dummy_1', autoRenew: true });
    notices.sent.length = 0;
    expect(await r.pm().cancelPaidSubscription('g1')).toBe(true);
    await d.settle();
    expect(premiumSub().autoRenew).toBe(false);
    expect(d.record('dummy_1').autoRenew).toBe(false);
    expect(notices.sent.map(n => n.kind)).toEqual(['paid.sub.cancelled-by-user']);
  });

  it('275: an immediate Dummy cancel with a paused queue: one resume; the resumed sub kept; one cancel line and one notice', async () => {
    await d.buy('g1', 'gold');
    await d.buy('g1', 'silver');
    const lines = auditActions().length;
    notices.sent.length = 0;
    expect(await r.pm().cancelPaidSubscriptionImmediately('g1')).toBe(true);
    await d.settle();
    expect(premiumSub()).toMatchObject({ providerSubId: 'dummy_2', status: 'active' });
    expect(auditActions().slice(lines)).toEqual(['subscription.cancel.paid', 'subscription.resume']);
    expect(notices.sent.map(n => n.kind)).toEqual(['paid.sub.cancelled-by-user', 'paid.sub.resumed-from-queue']);
    expect(d.record('dummy_2').status).toBe('active');
  });

  it("276, 245: an accepted migration with the Dummy: the state and variant copied; 'migrated'; the applied line carried by the save at 2780", async () => {
    await d.buy();
    const m = await schedule();
    r.pm().recordMigrationDecision(m.id, 'g1', 'accepted');
    await d.settle();
    d.later(2);
    notices.sent.length = 0;
    await r.pm().processDueMigrations();
    await d.settle();
    expect(r.row().migrations[0].decisions[0].outcome).toBe('migrated');
    expect(premiumSub()).toMatchObject({ variantId: YEARLY, endDate: d.record('dummy_1').endDate });
    expect(notices.sent.map(n => n.kind)).toEqual(['migration.applied']);
    expect(txOfLine('migration.applied').some(sql => sql.endsWith(PREMIUM_KEY))).toBe(true);
  });

  it("277: the Dummy throws for a silent decision: 'failed' with its text; no silence-applied notice", async () => {
    await d.buy();
    r.pm().setMigrationSilencePolicy('continue');
    await schedule();
    expect(r.row().migrations[0].decisions[0].notifiedAt).toEqual(expect.any(String));
    d.dummy.adminSetVariant({ variantId: YEARLY, label: 'Yearly', amount: 9999, currency: 'USD', durationDays: 365, recurring: true, active: false });
    await d.settle();
    d.later(2);
    notices.sent.length = 0;
    await r.pm().processDueMigrations();
    await d.settle();
    expect(r.row().migrations[0].decisions[0]).toMatchObject({ outcome: 'failed', outcomeNote: `Dummy variant '${YEARLY}' does not exist or is inactive.` });
    expect(notices.sent).toEqual([]);
  });

  it.each(['continue', 'cancel'] as const)("287: a silent decision with the policy '%s': silence-applied sent with the decision's save", async policy => {
    await d.buy();
    r.pm().setMigrationSilencePolicy(policy);
    await schedule();
    d.later(2);
    notices.sent.length = 0;
    const before = premiumCommits();
    await r.pm().processDueMigrations();
    await d.settle();
    expect(r.row().migrations[0].decisions[0].outcome).toBe(policy === 'continue' ? 'migrated' : 'cancelled');
    expect(notices.sent.map(n => n.kind)).toEqual(['migration.silence-applied']);
    expect(notices.sent[0].premiumCommits).toBeGreaterThan(before);
  });

  it('279: a purchase bought paused behind a higher sub: no provider pause call', async () => {
    await d.buy('g1', 'gold');
    const writes = d.writes(DUMMY_KEY);
    await d.buy('g1', 'silver');
    expect(d.writes(DUMMY_KEY)).toBe(writes + 1);
    expect(d.record('dummy_2')).toMatchObject({ status: 'paused', resumesAt: premiumSub().endDate });
  });

  it('315: adoptOrphan installs a paused sub behind a higher active one: the provider pause with the active endDate; a record already paused: T25 warned', async () => {
    await d.buy('g1', 'gold');
    const active = await orphan('g1', false, 'silver');
    expect(await r.pm().adoptOrphan('g1', 'dummy', active, await planOf('g1', active))).toBe(true);
    await d.settle();
    expect(d.record(active)).toMatchObject({ status: 'paused', paused: true, resumesAt: premiumSub().endDate });
    await r.pm().cancelPaidSubscriptionImmediately('g1');
    await d.settle();
    await d.buy('g2', 'gold');
    const paused = await orphan('g2', true, 'silver');
    expect(await r.pm().adoptOrphan('g2', 'dummy', paused, await planOf('g2', paused))).toBe(true);
    await d.settle();
    expect(r.logged(`[PremiumManager] provider pauseSubscription failed for 'dummy': Dummy subscription '${paused}' is already paused, so it was not paused.`)).toHaveLength(1);
    expect(r.row().subscriptions.g2.paused[0].providerSubId).toBe(paused);
  });

  /** Loses the COMMIT answer of the `nth` Dummy op from now (its commit is applied). */
  function loseDummyCommit(nth: number): void {
    let seen = 0;
    let client: number | null = null;
    r.m.state.rows.fault = (sql, params, c) => {
      if (sql.startsWith(LOCK_READ) && params?.[0] === DUMMY_KEY) {
        seen += 1;
        if (seen === nth) client = c;
      }
      if (client !== null && c === client && sql === 'COMMIT') {
        client = null;
        return 'lose';
      }
      return undefined;
    };
  }

  it("278, 325: the Dummy's pause in pauseActiveIntoQueue ends 'unconfirmed': T23's warning form; the queue change stands", async () => {
    await d.buy('g1', 'silver');
    loseDummyCommit(2);
    const buying = d.buy('g1', 'gold');
    await vi.waitFor(() => expect(d.record('dummy_1').paused).toBe(true));
    unconfirmUnansweredRows('the test ended it');
    await buying;
    r.m.state.rows.fault = undefined;
    expect(r.logged("[PremiumManager] Can't confirm that the Dummy provider saved the pause of subscription dummy_1 (the database's answer was lost); the bot's copy holds it paused in the queue. If the provider's record stays active, the Dummy provider pauses it within about 2 minutes.")).toHaveLength(1);
    expect(r.row().subscriptions.g1.paused[0]).toMatchObject({ providerSubId: 'dummy_1', status: 'paused' });
    expect(premiumSub().providerSubId).toBe('dummy_2');
  });

  it("278: the Dummy's pause refused: today's warning with T20; the queue change stands", async () => {
    await d.buy('g1', 'silver');
    inject.dummy.push(null, { cause: 'unstorable', thrown: false });
    await d.buy('g1', 'gold');
    expect(r.logged("[PremiumManager] provider pauseSubscription failed for 'dummy': The Dummy provider did not save this change (unstorable), so nothing was changed at the provider.")).toHaveLength(1);
    expect(r.row().subscriptions.g1.paused[0].providerSubId).toBe('dummy_1');
  });

  it("280, 325: resumeNext's Dummy resume ends 'unconfirmed': T23's warning form; the resumed sub stands", async () => {
    await d.buy('g1', 'gold');
    await d.buy('g1', 'silver');
    loseDummyCommit(2);
    expect(await r.pm().cancelPaidSubscriptionImmediately('g1')).toBe(true);
    await vi.waitFor(() => expect(d.record('dummy_2').status).toBe('active'));
    unconfirmUnansweredRows('the test ended it');
    await d.settle();
    r.m.state.rows.fault = undefined;
    expect(r.logged("[PremiumManager] Can't confirm that the Dummy provider saved the resume of subscription dummy_2 (the database's answer was lost); the bot's copy holds it active. If the provider's record stays paused, the Dummy provider resumes it within about 2 minutes.")).toHaveLength(1);
    expect(premiumSub()).toMatchObject({ providerSubId: 'dummy_2', status: 'active' });
  });

  it('240: the migration notice delivered: the decision marked notified', async () => {
    await d.buy();
    await schedule();
    await vi.waitFor(async () => {
      await d.settle();
      expect(r.row().migrations[0].decisions[0].notifiedAt).toEqual(expect.any(String));
    });
  });
});
