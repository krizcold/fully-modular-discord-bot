import { afterEach, describe, expect, it, vi } from 'vitest';

// P7 claim 5 (sheet P7, section 10; 4.5, THE FIELD RULE, decision 7 and owner question 1): the tier follows what
// Patreon shows the member paying for, read through THE FIELD RULE. L1 to L11 run Patreon's pledge life (cancel,
// period end, decline, refunds, trials, gifts, free and paused members, pick changes) with each unconfirmed behaviour
// both ways; F1 to F4 run the field table (null and absent fields, each listed charge status, a missing tier object, a
// list without campaigns). Each step is applied the way the bot applies it: deliveries, the re-reads W later and a round.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { CHARGE_STATUSES, PATREON_USERS, PTIER, type FakeMember, type FieldName, type PatreonSettings } from '../helpers/p7Patreon';
import { p7World, type P7World } from '../helpers/p7World';
import { held, holderOf, link, LOG, memberReads, MIN, pick, ptiersAt, W } from '../helpers/p7Rows';

const PU = PATREON_USERS[0];
const H = holderOf(0);
const G = holderOf(0, true);

const discordOf = (n: number) => `8670000000${String(200000 + n).padStart(7, '0')}`;
const patreonOf = (n: number) => String(74_000_000 + n);
function linkExtra(n: number): void {
  if (!(getPremiumManager() as any).linkAccount('patreon', patreonOf(n), `user:${discordOf(n)}`, discordOf(n))) throw new Error(`link ${n} was not saved`);
}

/** Every queued delivery, the re-reads W later, then a round past the lag: Patreon's state as the bot applies it. */
async function apply(w: P7World): Promise<void> {
  await w.deliverAll();
  await w.advance(W + MIN);
  await w.round();
}

/** Whether a read of the bot's since call `from` answered with the member in it: its member read, or a page of the list. */
function seenByBot(w: P7World, m: FakeMember, from = 0): boolean {
  return w.fake.calls.slice(from).some(c => c.status === 200 && (
    (c.route === 'member' && c.path.split('?')[0] === `/members/${m.id}`)
    || (c.route === 'members' && ((c.body as any)?.data ?? []).some((d: any) => d?.id === m.id))));
}

async function world(w: P7World, settings: Partial<PatreonSettings> = {}): Promise<void> {
  await w.setup({ settings: { maskUser: 'none', staleReads: 0, multiTier: false, ...settings } });
  await w.advance(31_000);
  await link(w, 0);
}

describe('P7 claim 5: the pledge\'s life', () => {
  const w = p7World('json');
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it.each([['now'], ['periodEnd']] as const)('L1 (R4, cancelEnds %s): a cancel ends the tier when, and only when, a read shows it no longer paid', async cancelEnds => {
    await world(w, { cancelEnds });
    const m = w.fake.pledge(PU, PTIER.A);
    await apply(w);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    w.fake.cancel(m);
    await apply(w);
    expect(ptiersAt(w, H)).toEqual(cancelEnds === 'now' ? [] : [PTIER.A]);
    w.fake.periodEnd(m);
    await apply(w);
    expect(ptiersAt(w, H)).toEqual([]);
  });

  it.each([[true], [false]])('L2 (R4, declinedKeeps %s): a declined charge ends the tier only when the entitlement drops it', async declinedKeeps => {
    await world(w, { declinedKeeps });
    const m = w.fake.pledge(PU, PTIER.A);
    await apply(w);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    w.fake.decline(m);
    await apply(w);
    expect(ptiersAt(w, H)).toEqual(declinedKeeps ? [PTIER.A] : []);
  });

  const refunds = [['refund'], ['refundedByPatreon'], ['fraud']] as const;
  for (const refundDrops of [false, true]) {
    for (const refundLowersLifetime of [false, true]) {
      it.each(refunds)(`L3 (E9, E10; refundDrops ${refundDrops}, refundLowersLifetime ${refundLowersLifetime}): %s ends the tier at the read that shows it, and nothing installs until a later Paid charge, also with a decline between (fails on a build that withholds only while the latest charge is a refund)`, async action => {
        await world(w, { refundDrops, refundLowersLifetime, declinedKeeps: true });
        const m = w.fake.pledge(PU, PTIER.A);
        await apply(w);
        w.fake[action](m);
        await apply(w);
        expect(ptiersAt(w, H)).toEqual([]);
        w.fake.setMember(m, { entitled: [PTIER.A], patronStatus: 'active_patron' });
        w.fake.decline(m);
        await apply(w);
        expect(ptiersAt(w, H)).toEqual([]);
        w.fake.pledge(PU, PTIER.A);
        await apply(w);
        expect(ptiersAt(w, H)).toEqual([PTIER.A]);
      });
    }
  }

  it.each([[true], [false]])('L3 (R20, partialAsRefunded %s): a partial refund ends the tier only when Patreon shows it as Refunded; Refund Pending changes nothing', async partialAsRefunded => {
    await world(w, { partialAsRefunded });
    const m = w.fake.pledge(PU, PTIER.A);
    await apply(w);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    w.fake.partialRefund(m);
    await apply(w);
    expect(ptiersAt(w, H)).toEqual(partialAsRefunded ? [] : [PTIER.A]);
    w.fake.pledge(PU, PTIER.A);
    await apply(w);
    const before = w.storedText();
    w.fake.setMember(m, { lastChargeStatus: 'Refund Pending' });
    await apply(w);
    expect(w.storedText()).toBe(before);
  });

  it('L3 (E15): a downgrade B to A refunded in part installs A at once (fails on a build that allows installs on Paid only)', async () => {
    await world(w, { partialAsRefunded: false });
    const m = w.fake.pledge(PU, PTIER.B);
    await apply(w);
    w.fake.changeTier(m, PTIER.A);
    w.fake.partialRefund(m);
    expect(m.state.lastChargeStatus).toBe('Partially Refunded');
    await apply(w);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
  });

  it.each([['clears'], ['stays']] as const)('L4 (owner question 1, R13, trialFlag %s): a trial gives no tier, and its paid first charge installs it', async trialFlag => {
    await world(w, { trialFlag });
    const m = w.fake.startTrial(PU, PTIER.A)!;
    await apply(w);
    expect(ptiersAt(w, H)).toEqual([]);
    w.fake.chargeTrial(m, true);
    await apply(w);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
  });

  it.each([['clears'], ['stays']] as const)('L9 (D16, trialFlag %s): a trial and then a declined first charge give no tier (fails on a build that ends a trial at a charge attempt)', async trialFlag => {
    await world(w, { trialFlag, declinedKeeps: true });
    const m = w.fake.startTrial(PU, PTIER.A)!;
    await apply(w);
    w.fake.chargeTrial(m, false);
    const from = w.fake.calls.length;
    await apply(w);
    expect([ptiersAt(w, H), seenByBot(w, m, from)]).toEqual([[], true]);
  });

  for (const giftedEntitled of [true, false]) {
    for (const giftCharge of ['never', 'giver'] as const) {
      it.each([[false], [true], [null]])(`L5 (E20, R4, R22; giftedEntitled ${giftedEntitled}, giftCharge ${giftCharge}, is_free_trial %s): a gift installs while Patreon shows it entitled; the recipient's own declined charge installs nothing new; a refunded gift ends as Patreon shows it`, async isFreeTrial => {
        await world(w, { giftedEntitled, giftCharge, declinedKeeps: true });
        const m = w.fake.gift(PU, PTIER.A, { isFreeTrial });
        await apply(w);
        expect([ptiersAt(w, H), seenByBot(w, m)]).toEqual([giftedEntitled ? [PTIER.A] : [], true]);
        if (!giftedEntitled) return;
        w.fake.decline(m);
        w.fake.setMember(m, { entitled: [PTIER.A, PTIER.B] });
        await apply(w);
        expect(ptiersAt(w, H)).toEqual([PTIER.A]);
        w.fake.setMember(m, { entitled: [PTIER.A], lastChargeStatus: giftCharge === 'giver' ? 'Paid' : null, lastChargeDate: giftCharge === 'giver' ? Date.now() : null });
        await apply(w);
        for (const refundDrops of [false, true]) {
          if (giftCharge === 'giver') {
            if (refundDrops) continue;
            w.fake.refund(m);
            await apply(w);
            expect(ptiersAt(w, H)).toEqual([]);
          } else {
            if (refundDrops) w.fake.setMember(m, { entitled: [] });
            await apply(w);
            expect(ptiersAt(w, H)).toEqual(refundDrops ? [] : [PTIER.A]);
          }
        }
      });
    }
  }

  it.each([[false], [true]])('L6 (R5, lapseEvent %s): a cancelled pledge lapsing at the period\'s end ends the tier by the next round', async lapseEvent => {
    await world(w, { cancelEnds: 'periodEnd', lapseEvent });
    const m = w.fake.pledge(PU, PTIER.A);
    await apply(w);
    w.fake.cancel(m);
    await apply(w);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    w.fake.periodEnd(m);
    await w.round();
    expect(ptiersAt(w, H)).toEqual([]);
  });

  it.each([[true], [false]])('L7 (R16, freeTierListed %s): a free member gets no tier and no PD3', async freeTierListed => {
    await world(w, { freeTierListed });
    const m = w.fake.joinFree(PU);
    await apply(w);
    expect([held(w), seenByBot(w, m)]).toEqual([[], true]);
    expect(w.logs.filter(l => l.includes(LOG.PD3_TAIL))).toEqual([]);
  });

  it.each([[true], [false]])('L8 (R17, pauseKeeps %s): a paused pledge keeps the tier exactly while Patreon keeps it entitled', async pauseKeeps => {
    await world(w, { pauseKeeps });
    const m = w.fake.pledge(PU, PTIER.A);
    await apply(w);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    w.fake.pause(m);
    await apply(w);
    expect(ptiersAt(w, H)).toEqual(pauseKeeps ? [PTIER.A] : []);
  });

  it.each([[true], [null]])('L10 (E4, E10; is_free_trial %s): a member who has paid, holding a record, whose latest charge is Declined, changes pick: the server gets it at once and the VIP record ends; after an unlink and a relink, or an upgrade, nothing installs until a Paid charge (fails on a build reading a trial from last_charge_status)', async isFreeTrial => {
    await world(w, { trialFlag: 'stays', declinedKeeps: true });
    const m = w.fake.pledge(PU, PTIER.A);
    await apply(w);
    w.fake.decline(m);
    w.fake.setMember(m, { isFreeTrial });
    await apply(w);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    expect(await pick(w, 0, G)).toBe(true);
    await w.round();
    expect([ptiersAt(w, H), ptiersAt(w, G)]).toEqual([[], [PTIER.A]]);

    w.fake.setMember(m, { entitled: [PTIER.B] });
    await apply(w);
    expect(ptiersAt(w, G)).toEqual([]);
    w.fake.setMember(m, { entitled: [PTIER.A] });
    await apply(w);
    expect(ptiersAt(w, G)).toEqual([]);
    w.fake.pledge(PU, PTIER.A);
    await apply(w);
    expect(ptiersAt(w, G)).toEqual([PTIER.A]);

    w.fake.decline(m);
    await apply(w);
    expect((await w.op('unlinkProviderAccount', G, 'patreon', '86700000000000001')).ok).toBe(true);
    await w.settle();
    expect(ptiersAt(w, G)).toEqual([]);
    expect(await link(w, 0, G)).toBe(true);
    await apply(w);
    expect(ptiersAt(w, G)).toEqual([]);
  });

  it.each([[true], [false]])('L11 (R21, returningTrial %s): a returning patron on a new trial with a Paid latest charge gets the tier', async returningTrial => {
    await world(w, { returningTrial, cancelEnds: 'now' });
    const m = w.fake.pledge(PU, PTIER.A);
    await apply(w);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    w.fake.cancel(m);
    await apply(w);
    expect(ptiersAt(w, H)).toEqual([]);
    const trial = w.fake.startTrial(PU, PTIER.A);
    expect(trial === null).toBe(!returningTrial);
    await apply(w);
    expect(ptiersAt(w, H)).toEqual(returningTrial ? [PTIER.A] : []);
  });
});

describe('P7 claim 5: THE FIELD RULE', () => {
  const w = p7World('json');
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  /** Whether a new pledge installs with the field null or absent (the table's reading); a held record never ends. */
  const NEW_INSTALLS: Record<string, { null: boolean; absent: boolean }> = {
    currently_entitled_tiers: { null: false, absent: false },
    amount_cents: { null: false, absent: false },
    is_free_trial: { null: true, absent: false },
    campaign_lifetime_support_cents: { null: true, absent: false },
    last_charge_status: { null: false, absent: false },
    is_gifted: { null: true, absent: false },
    last_charge_date: { null: true, absent: false },
    patron_status: { null: true, absent: false },
    user: { null: false, absent: false },
    campaign: { null: true, absent: true },
  };
  /** Whether the table reads a member read with the field null or absent as malformed (PT25 after a delivery). */
  const MALFORMED: Record<string, { null: boolean; absent: boolean }> = {
    currently_entitled_tiers: { null: true, absent: true },
    amount_cents: { null: true, absent: true },
    is_free_trial: { null: false, absent: true },
    campaign_lifetime_support_cents: { null: false, absent: true },
    last_charge_status: { null: false, absent: true },
    is_gifted: { null: false, absent: true },
    last_charge_date: { null: false, absent: true },
    patron_status: { null: false, absent: true },
    user: { null: false, absent: false },
    campaign: { null: true, absent: true },
  };
  const pt25Malformed = (w: P7World, m: FakeMember): boolean => w.logs.some(l => l.startsWith(`${LOG.PT8} ${m.id} ${LOG.PT25_DELIVERY} (the answer was malformed`));
  for (const [field, expected] of Object.entries(NEW_INSTALLS)) {
    it.each([['null'], ['absent']] as const)(`F1 (R18, D17): ${field} %s, on a member with a held record and on a new pledge: the table's reading, else no change; never an end (fails on a build that reads a missing amount_cents as 0 and ends the record)`, async how => {
      await world(w);
      await link(w, 1);
      const held0 = w.fake.pledge(PU, PTIER.A);
      await apply(w);
      expect(ptiersAt(w, H)).toEqual([PTIER.A]);
      const faulted = new Set<FieldName>([field as FieldName]);
      if (how === 'null') w.fake.settings.nullField = faulted;
      else w.fake.settings.absentField = faulted;
      const fresh = w.fake.pledge(PATREON_USERS[1], PTIER.B);
      w.fake.settings.fieldFaultMembers = new Set([held0.id, fresh.id]);
      w.fake.setMember(held0, { lifetime: 500 });
      await apply(w);
      expect(ptiersAt(w, H)).toEqual([PTIER.A]);
      expect(ptiersAt(w, holderOf(1))).toEqual(expected[how] ? [PTIER.B] : []);
      expect([pt25Malformed(w, held0), pt25Malformed(w, fresh)]).toEqual([MALFORMED[field][how], MALFORMED[field][how]]);
      if (held(w).some(h => h.holder === H) && field === 'patron_status' && how === 'null') expect(held(w).find(h => h.holder === H)!.sub.autoRenew).toBe(false);
    });
  }

  it('F1 (E11): is_free_trial and the lifetime both null with a Paid latest charge install', async () => {
    await world(w);
    w.fake.settings.nullField = new Set<FieldName>(['is_free_trial', 'campaign_lifetime_support_cents']);
    w.fake.pledge(PU, PTIER.A);
    await apply(w);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
  });

  it.each([[0], [500]])('F2 (R18, E9, E10, E15): each listed last_charge_status with is_free_trial true at a lifetime of %s, on a held record and on a new pledge; an unlisted value is malformed', async lifetime => {
    await world(w);
    const statuses = [...CHARGE_STATUSES, 'Charged Twice'];
    const heldMembers: FakeMember[] = [];
    const freshMembers: FakeMember[] = [];
    for (const [i] of statuses.entries()) {
      linkExtra(2 * i);
      linkExtra(2 * i + 1);
      heldMembers.push(w.fake.pledge(patreonOf(2 * i), PTIER.A));
    }
    await w.settle();
    await apply(w);
    expect(held(w)).toHaveLength(statuses.length);
    for (const [i, status] of statuses.entries()) {
      w.fake.setMember(heldMembers[i], { lastChargeStatus: status, isFreeTrial: true, lifetime });
      const fresh = w.fake.startTrial(patreonOf(2 * i + 1), PTIER.A)!;
      w.fake.setMember(fresh, { lastChargeStatus: status, lifetime, lastChargeDate: Date.now() });
      freshMembers.push(fresh);
    }
    await apply(w);
    const installs = new Set(['Paid', 'Partially Refunded', 'Refund Declined']);
    const ends = new Set(['Refunded', 'Refunded by Patreon', 'Fraud']);
    const got = statuses.map((status, i) => [status, ptiersAt(w, `user:${discordOf(2 * i)}`).length === 1, ptiersAt(w, `user:${discordOf(2 * i + 1)}`).length === 1]);
    const want = statuses.map(status => [status, !ends.has(status), installs.has(status)]);
    expect(got).toEqual(want);
    expect(freshMembers.every(m => memberReads(w, m).length > 0)).toBe(true);
    const malformed = statuses.map((status, i) => [status, pt25Malformed(w, heldMembers[i]), pt25Malformed(w, freshMembers[i])]);
    expect(malformed).toEqual(statuses.map(status => [status, status === 'Charged Twice', status === 'Charged Twice']));
  });

  it("F3: an entitled tier with no tier object in included is malformed: the record held of that tier stays, and a new pledge of it and another tier gets nothing (fails on a build that skips the tier with no object)", async () => {
    await world(w, { multiTier: true });
    await link(w, 1);
    const m0 = w.fake.pledge(PU, PTIER.A);
    await apply(w);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    w.fake.dropTierObject.add(PTIER.A);
    w.fake.pledge(PU, PTIER.B);
    const m1 = w.fake.pledge(PATREON_USERS[1], PTIER.A);
    w.fake.pledge(PATREON_USERS[1], PTIER.B);
    expect([m0.state.entitled, m1.state.entitled]).toEqual([[PTIER.A, PTIER.B], [PTIER.A, PTIER.B]]);
    await apply(w);
    expect([ptiersAt(w, H), ptiersAt(w, holderOf(1))]).toEqual([[PTIER.A], []]);
    expect([pt25Malformed(w, m0), pt25Malformed(w, m1)]).toEqual([true, true]);
  });

  it('F4 (E1): a list whose entries carry no campaign installs, with no member read (fails on a build that applies the member read\'s campaign entry to the list)', async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0 }, webhook: false });
    await link(w, 0);
    const m = w.fake.pledge(PU, PTIER.A);
    await w.advance(2000);
    await w.round();
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    expect(memberReads(w, m)).toEqual([]);
    expect(w.fake.calls.filter(c => c.route === 'members').every(c => !c.path.includes('campaign,') && !/include=[^&]*campaign/.test(c.path))).toBe(true);
  });
});
