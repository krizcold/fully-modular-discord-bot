import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 claim 18: price changes name holders. A schedule stores one decision per server holder, a decision is recorded
// by holder, the due run calls the provider per decision, and a user tier or a user holder is refused. The seller is
// the provider; every change goes through its shared op, and the due run is the ticker's own entry.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { notices } from '../helpers/p1Mocks';
import { gh, uh } from '../helpers/p1Holder';
import { p1World, SELLER_ID, SELLER_VARIANT, SERVERS, USERS } from '../helpers/p1World';

const w = p1World();
const [A, B] = SERVERS;
const X11 = 'Price changes cannot be scheduled for a user tier: a user has no page to accept or decline one until the "My account" page exists.';
const schedule = (over: Record<string, unknown> = {}, inMs = 3_600_000) => w.op('scheduleMigration', {
  providerId: SELLER_ID, sourceTierId: 'low', sourceOfferingId: 'o-low', sourceVariantId: SELLER_VARIANT,
  targetTierId: 'mid', targetOfferingId: 'o-mid', targetVariantId: SELLER_VARIANT,
  effectiveDate: new Date(Date.now() + inMs).toISOString(), message: 'the price changes', ...over,
});
const storedMigration = (id: string): any => w.stored().migrations.find((m: any) => m.id === id);

beforeEach(async () => {
  await w.setup();
  await w.addUserTiers();
  expect(await w.purchase(A, 'low')).toMatchObject({ ok: true });
  expect(await w.purchase(B, 'low')).toMatchObject({ ok: true });
  expect(await w.grant(uh(USERS[0]), 'ulow', 30)).toMatchObject({ ok: true });
});
afterEach(async () => { await w.teardown(); });

describe('P1 claim 18: price changes by holder', () => {
  it('a schedule over two servers on the source variant stores one decision per holder and notifies each', async () => {
    notices.sent.length = 0;
    const scheduled = await schedule();
    await w.settle();

    expect(scheduled).toMatchObject({ ok: true });
    const stored = storedMigration(scheduled.result.id);
    expect(stored.decisions.map((d: any) => [d.holder, d.decision, d.subscriptionId, 'guildId' in d])).toEqual([
      [gh(A), 'pending', w.recordOf(A).active.id, false],
      [gh(B), 'pending', w.recordOf(B).active.id, false],
    ]);
    expect(notices.sent.filter(n => n.kind === 'migration.scheduled').map(n => n.to)).toEqual([gh(A), gh(B)]);
    const mgr: any = getPremiumManager();
    expect(mgr.getPendingMigrationsFor(gh(A)).map((m: any) => m.id)).toEqual([scheduled.result.id]);
    expect(mgr.getPendingMigrationsFor(uh(USERS[0]))).toEqual([]);
    expect(mgr.getPendingMigrationsFor(gh('70000000000000009'))).toEqual([]);
  });

  it("recordMigrationDecision(id, holder, ...) changes only that holder's decision and writes the actor 'guild-owner'", async () => {
    const id = (await schedule()).result.id;
    await w.settle();
    const linesBefore = w.auditLines().length;

    const reply = await w.op('recordMigrationDecision', id, gh(B), 'declined');

    expect(reply).toMatchObject({ ok: true, result: true });
    expect(storedMigration(id).decisions.map((d: any) => [d.holder, d.decision])).toEqual([[gh(A), 'pending'], [gh(B), 'declined']]);
    expect(w.auditLines().slice(linesBefore).map(l => [l.action, l.actor, l.holder, l.migrationId, l.metadata])).toEqual([
      ['migration.decision', 'guild-owner', gh(B), id, { decision: 'declined' }],
    ]);
  });

  it('the due run calls the provider per decision and saves each outcome', async () => {
    const id = (await schedule({}, 400)).result.id;
    expect(await w.op('recordMigrationDecision', id, gh(A), 'accepted')).toMatchObject({ ok: true, result: true });
    expect(await w.op('recordMigrationDecision', id, gh(B), 'declined')).toMatchObject({ ok: true, result: true });
    const subA = w.recordOf(A).active.providerSubId;
    const subB = w.recordOf(B).active.providerSubId;
    const callsBefore = w.seller.calls.length;
    await new Promise(resolve => setTimeout(resolve, 450));

    await getPremiumManager().processDueMigrations();
    await w.settle();

    expect(w.seller.calls.slice(callsBefore)).toEqual([
      { method: 'migrateSubscriptionPrice', args: [subA, SELLER_VARIANT, 'none'] },
      { method: 'cancelSubscription', args: [subB, false] },
    ]);
    const stored = storedMigration(id);
    expect(stored.status).toBe('applied');
    expect(stored.decisions.map((d: any) => [d.holder, d.decision, d.outcome, typeof d.appliedAt])).toEqual([
      [gh(A), 'accepted', 'migrated', 'string'],
      [gh(B), 'declined', 'cancelled', 'string'],
    ]);
    expect(w.recordOf(A).active).toMatchObject({ tierId: 'mid', offeringId: 'o-mid' });
    expect(w.recordOf(B).active).toMatchObject({ tierId: 'low', autoRenew: false });
  });

  it.each([
    ['source', { sourceTierId: 'ulow' }],
    ['target', { targetTierId: 'uhigh' }],
  ])('a schedule whose %s is a user tier throws X11 and stores nothing', async (_which, over) => {
    const before = { premium: w.storedText(), audit: w.auditText() };
    notices.sent.length = 0;

    const reply = await schedule(over);

    expect(reply.ok).toBe(false);
    expect(reply.error).toContain(X11);
    expect({ premium: w.storedText(), audit: w.auditText() }).toEqual(before);
    expect(notices.sent).toEqual([]);
  });

  it('recordMigrationDecision for a user holder answers false and stores nothing', async () => {
    const id = (await schedule()).result.id;
    await w.settle();
    const before = { premium: w.storedText(), audit: w.auditText() };
    notices.sent.length = 0;

    const reply = await w.op('recordMigrationDecision', id, uh(USERS[0]), 'accepted');

    expect(reply).toMatchObject({ ok: true, result: false });
    expect({ premium: w.storedText(), audit: w.auditText() }).toEqual(before);
    expect(notices.sent).toEqual([]);
  });
});
