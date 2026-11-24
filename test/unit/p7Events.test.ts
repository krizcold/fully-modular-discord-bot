import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P7 claim 3 as part 2 builds it (sheet P7, section 10; 4.4, 4.5): the tier comes from the member's paid Patreon tiers
// through the operator's wiring, never from anything a member sends. E1 a linked member paid on A gets one record of
// the 4.1 shape; E2 an unwired tier gives PD3 and a tier wired twice PD4, both in the neutral words; E3 a server pick
// installs the server tier; E4 several paid tiers stack (R12); E5 a tier change ends the old record before the new
// one installs; E6 a read keeps the record's start and its full meta. The real PatreonProvider and PremiumManager
// (helpers/p7World.ts) against the fake of helpers/p7Patreon.ts.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { SubscriptionNotifier } from '../../src/bot/internalSetup/utils/subscriptionNotifier';
import { allowDropLines } from '../helpers/p1Guard';
import { noticePayloads } from '../helpers/p1Mocks';
import { CAMPAIGN_ID, PATREON_USERS, PTIER } from '../helpers/p7Patreon';
import { p7World, tierDefOf, USERS, providerLink, type P7World } from '../helpers/p7World';
import { eventsSince, held, holderOf, link, LOG, MIN, pastLag, PT12, SEC, tiersAt, W } from '../helpers/p7Rows';

const U = USERS[0];
const PU = PATREON_USERS[0];
const H = holderOf(0);
const G = holderOf(0, true);
const BACKENDS = [['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]] as const;

/** Pledge, then a round once the read lag has passed. */
async function pledgeAndRound(w: P7World, p: number, ptier: string): Promise<void> {
  w.fake.pledge(PATREON_USERS[p], ptier);
  await pastLag(w);
  await w.round();
}

describe.each(BACKENDS)('P7 claim 3 on %s: E1, the record a read installs', (_name, backend) => {
  const w = p7World(backend);
  beforeEach(async () => { await w.setup({ settings: { maskUser: 'none' } }); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it("E1: a linked member paid on A gets patreon:<memberId>:A, variant tier:A, buyer U, string ids in meta and no end date (fails on P6's tree: no round installs)", async () => {
    await link(w, 0);
    await pledgeAndRound(w, 0, PTIER.A);
    const m = w.fake.memberOf(PU)!;
    const records = held(w);
    expect(records).toHaveLength(1);
    expect(records[0].holder).toBe(H);
    expect(records[0].sub).toMatchObject({
      providerId: 'patreon', providerSubId: `patreon:${m.id}:${PTIER.A}`, variantId: `tier:${PTIER.A}`, tierId: 'vip', buyerId: U,
      status: 'active', endDate: null, autoRenew: true,
      providerMeta: { patreonUserId: PU, memberId: m.id, campaignId: CAMPAIGN_ID, patreonTierId: PTIER.A, patronStatus: 'active_patron' },
    });
    expect(Object.values(records[0].sub.providerMeta).filter(v => v !== null).every(v => typeof v === 'string')).toBe(true);
    expect(w.fake.unexpected).toEqual([]);
  });
});

describe('P7 claim 3: E2 to E6', () => {
  const w = p7World('json');
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it('E2: an unwired tier gives PD3 and a tier wired twice gives PD4, both naming Patreon in the neutral words; nothing is installed', async () => {
    await w.setup({ settings: { maskUser: 'none', multiTier: false } });
    allowDropLines('L3');
    const star = tierDefOf('star', true, false);
    star.offerings.push({ id: 'o-ba', label: 'Star from A', providerLinks: [providerLink('patreon', [PTIER.A])] });
    expect((await w.op('setTier', 'star', star)).ok).toBe(true);
    await link(w, 0);
    await link(w, 1);
    await pledgeAndRound(w, 0, PTIER.UNWIRED);
    await pledgeAndRound(w, 1, PTIER.A);
    const m0 = w.fake.memberOf(PU)!;
    const m1 = w.fake.memberOf(PATREON_USERS[1])!;
    expect(w.logged(`[PremiumManager] subscription.created from Patreon (subscription patreon:${m0.id}:${PTIER.UNWIRED}, user ${U}) was not installed: no user tier has an offering that sells 'tier:${PTIER.UNWIRED}' through Patreon. ${LOG.PD3_TAIL}`).length).toBeGreaterThan(0);
    expect(w.logged(`[PremiumManager] subscription.created from Patreon (subscription patreon:${m1.id}:${PTIER.A}, user ${USERS[1]}) was not installed: 'tier:${PTIER.A}' is sold by more than one offering (VIP/VIP, Star/Star from A). ${LOG.PD3_TAIL}`).length).toBeGreaterThan(0);
    expect(held(w)).toEqual([]);
  });

  it('E3: a server pick installs the server tier wired to the Patreon tier, never the user tier wired to the same one', async () => {
    await w.setup({ settings: { maskUser: 'none' } });
    await link(w, 0, G);
    await pledgeAndRound(w, 0, PTIER.A);
    expect(held(w).map(h => [h.holder, h.sub.tierId, h.ptier])).toEqual([[G, 'gold', PTIER.A]]);
    expect(held(w)[0].sub.buyerId).toBe(U);
  });

  it('E4 (R12): paid A and B give B active and A queued with PT12; paid A and A2 give one of them, and PD14 for the other', async () => {
    await w.setup({ settings: { maskUser: 'none', multiTier: true } });
    allowDropLines('L3');
    await link(w, 0);
    await link(w, 1);
    w.fake.pledge(PU, PTIER.A);
    w.fake.pledge(PU, PTIER.B);
    w.fake.pledge(PATREON_USERS[1], PTIER.A);
    w.fake.pledge(PATREON_USERS[1], PTIER.A2);
    expect(w.fake.memberOf(PU)!.state.entitled).toEqual([PTIER.A, PTIER.B]);
    const from = w.notices().length;
    await pastLag(w);
    await w.round();
    expect(tiersAt(w, H)).toEqual([`${PTIER.A}:paused`, `${PTIER.B}:active`]);
    const queued = w.notices().map((n, i) => ({ ...n, payload: noticePayloads[i] as any })).slice(from).filter(n => n.to === H && n.kind === 'paid.sub.paused-by-stacking');
    for (const n of queued) expect((new SubscriptionNotifier() as any).formatMessage(n.kind, n.payload, 'user')).toBe(`**Subscription paused:** Your **VIP** (Patreon) subscription is queued behind a higher-tier plan. ${PT12}`);
    const both = held(w).filter(h => h.holder === holderOf(1));
    expect(both).toHaveLength(1);
    expect([PTIER.A, PTIER.A2]).toContain(both[0].ptier);
    expect(w.logs.some(l => l.includes(`(subscription patreon:${w.fake.memberOf(PATREON_USERS[1])!.id}:`) && l.includes("already holds 'VIP' at that priority"))).toBe(true);
  });

  it.each([
    ['A to B', PTIER.A, PTIER.B],
    ['B to A', PTIER.B, PTIER.A],
    ['A to A2', PTIER.A, PTIER.A2],
  ])('E5 with deliveries (%s): the old record ends before the new one installs, in the same handling, so the member is never without a tier (fails on a build that installs first)', async (_name, from, to) => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0, multiTier: false } });
    await link(w, 0);
    w.fake.pledge(PU, from);
    await w.deliverAll();
    expect(held(w).map(h => h.ptier)).toEqual([from]);
    await w.advance(W + MIN);
    const at = w.emitted.length;
    w.fake.changeTier(w.fake.memberOf(PU)!, to);
    await w.deliverAll();
    const events = eventsSince(w, at).filter(e => !e.startsWith('updated'));
    expect(events.slice(0, 2)).toEqual([`expired ${H} ${from}`, `created ${H} ${to}`]);
    expect(tiersAt(w, H)).toEqual([`${to}:active`]);
  });

  it.each([
    ['A to B', PTIER.A, PTIER.B],
    ['B to A', PTIER.B, PTIER.A],
    ['A to A2', PTIER.A, PTIER.A2],
  ])('E5 with rounds only (%s): the old record ends at a round, and the new one is held at most 31 s after that round', async (_name, from, to) => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0, multiTier: false }, webhook: false });
    await link(w, 0);
    allowDropLines('L3');
    await pledgeAndRound(w, 0, from);
    expect(held(w).map(h => h.ptier)).toEqual([from]);
    await w.advance(W + MIN);
    w.fake.changeTier(w.fake.memberOf(PU)!, to);
    await pastLag(w);
    await w.round();
    expect(held(w).map(h => h.ptier)).not.toContain(from);
    await w.advance(31 * SEC);
    expect(tiersAt(w, H)).toEqual([`${to}:active`]);
  });

  it("E6 (D5): a patron_status change keeps the record's start and sends the full meta; a masked read keeps meta.patreonUserId, and the round ends nothing (fails on a build that sends startDate now or takes meta from the read)", async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0, declinedKeeps: true } });
    await link(w, 0);
    await pledgeAndRound(w, 0, PTIER.A);
    const before = held(w)[0].sub;
    await w.advance(5 * 60_000);
    const m = w.fake.memberOf(PU)!;
    m.masked = true;
    w.fake.decline(m);
    await w.deliverAll();
    await w.round();
    const after = held(w);
    expect(after).toHaveLength(1);
    expect(after[0].sub).toMatchObject({ id: before.id, startDate: before.startDate, autoRenew: false, status: 'active', endDate: null });
    expect(after[0].sub.providerMeta).toEqual({ patreonUserId: PU, memberId: m.id, campaignId: CAMPAIGN_ID, patreonTierId: PTIER.A, patronStatus: 'declined_patron' });
    await w.advance(2 * 3_600_000);
    expect(held(w).map(h => h.sub.id)).toEqual([before.id]);
  });
});
