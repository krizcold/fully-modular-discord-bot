import { afterEach, describe, expect, it, vi } from 'vitest';

// P7 claims 6 and 7 (sheet P7, section 10; 4.6, THE END RULE, THE INSTALL RULE, THE LAG RULE, THE RE-READ RULE):
// the rounds. Step 0 proves the creator token reads the campaign, step 1 pages the members list, step 2 installs from
// the list unless THE LAG RULE blocks it, step 3 compares the held records with the list (3a) and reads the others one
// by one (3b) under the 404 guard. Nothing ends without evidence about that one pledge (N1 to N3, G1 to G6). The real
// PatreonProvider and PremiumManager (helpers/p7World.ts) against the fake of helpers/p7Patreon.ts.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { acceptedOpsRunning, setMaintenanceGate, setOrderRefusal } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { PatreonProvider } from '../../src/bot/internalSetup/utils/payment/patreonProvider';
import { CAMPAIGN_ID, CREATOR_ID, CREATOR_TOKEN, OTHER_CAMPAIGN_ID, OTHER_CREATOR_TOKEN, PATREON_USERS, PTIER, type FakeMember } from '../helpers/p7Patreon';
import { allowDropLines } from '../helpers/p1Guard';
import { p7World, type P7World } from '../helpers/p7World';
import { busiestMinute, callsTo, eventsSince, held, holderOf, HOUR, link, LOG, memberReads, MIN, pastLag, pick, ptiersAt, SEC, tiersAt, W } from '../helpers/p7Rows';

const PU = PATREON_USERS[0];
const H = holderOf(0);
const G = holderOf(0, true);
const BACKENDS = [['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]] as const;

const discordOf = (n: number) => `8670000000${String(300000 + n).padStart(7, '0')}`;
const patreonOf = (n: number) => String(75_000_000 + n);
function linkExtra(n: number): void {
  if (!(getPremiumManager() as any).linkAccount('patreon', patreonOf(n), `user:${discordOf(n)}`, discordOf(n))) throw new Error(`link ${n} was not saved`);
}

async function world(w: P7World, settings: Record<string, unknown> = {}, webhook = true): Promise<void> {
  await w.setup({ settings: { maskUser: 'none', staleReads: 0, multiTier: false, ...settings }, webhook });
  await w.advance(31 * SEC);
  await link(w, 0);
}

/** Pledge, deliver, the re-reads W later and a round: the member's record installed the way the bot installs it. */
async function installed(w: P7World, p: number, ptier: string): Promise<FakeMember> {
  const m = w.fake.pledge(PATREON_USERS[p], ptier);
  await w.deliverAll();
  await w.advance(W + MIN);
  await w.round();
  return m;
}

const lines = (w: P7World, text: string) => w.logs.filter(l => l.includes(text));

describe('P7 claim 6: rounds and the install rule', () => {
  const w = p7World('json');
  afterEach(async () => {
    await w.teardown();
    setOrderRefusal(false);
    setMaintenanceGate(null);
    vi.restoreAllMocks();
  });

  it('K1: a pledge made while the bot was down is installed 30 s after the restart', async () => {
    await world(w, {}, false);
    w.fake.pledge(PU, PTIER.A);
    await w.restart();
    await w.advance(29 * SEC);
    expect(held(w)).toEqual([]);
    await w.advance(2 * SEC);
    expect(tiersAt(w, H)).toEqual([`${PTIER.A}:active`]);
  });

  it('K3: no round while Patreon is not configured (no call, no log), with the gate closed, under an order, or with premium unreadable; no operation is left counted', async () => {
    await world(w);
    const quiet = async (setUp: () => (() => void)): Promise<unknown[]> => {
      const undo = setUp();
      const calls = w.fake.calls.length;
      const logs = w.logs.length;
      await w.advance(2 * HOUR);
      const out = [w.fake.calls.length - calls, w.logs.slice(logs).filter(l => l.startsWith('[PatreonProvider]')), acceptedOpsRunning()];
      undo();
      return out;
    };
    const results = [
      await quiet(() => { w.setCredentials({ PATREON_CREATOR_ACCESS_TOKEN: undefined }); return () => w.setCredentials({ PATREON_CREATOR_ACCESS_TOKEN: CREATOR_TOKEN }); }),
      await quiet(() => { setMaintenanceGate({ cause: 'hook', message: 'down' }); return () => setMaintenanceGate(null); }),
      await quiet(() => { setOrderRefusal(true); return () => setOrderRefusal(false); }),
      await quiet(() => { const spy = vi.spyOn(getPremiumManager(), 'cacheState').mockReturnValue('unreadable'); return () => spy.mockRestore(); }),
    ];
    expect(results).toEqual(results.map(() => [0, [], 0]));
    await w.advance(6 * MIN);
    expect(callsTo(w, 'campaigns').length).toBeGreaterThan(0);
  });

  it.each([
    ['created', true, false], ['reverse', true, false], ['shuffled', true, false],
    ['created', false, true], ['shuffled', false, true],
  ] as const)('K4 (R6, D15; pageOrder %s, skipOnChange %s, dupOnChange %s): 2500 members, 300 linked: every linked paid pledge is installed from the list in the first round that sees it with no member read; a repeated id gives PT3; 50 linked on an unwired tier are not read every round; no round passes the call limit', async (pageOrder, skipOnChange, dupOnChange) => {
    await world(w, { pageOrder, skipOnChange, dupOnChange }, false);
    allowDropLines('L3');
    const paid: FakeMember[] = [];
    const unwired: FakeMember[] = [];
    for (let n = 0; n < 2500; n++) {
      if (n < 300) linkExtra(n);
      const m = w.fake.pledge(patreonOf(n), n >= 250 && n < 300 ? PTIER.UNWIRED : PTIER.A);
      if (n < 250) paid.push(m);
      else if (n < 300) unwired.push(m);
    }
    await w.settle();
    await w.advance(2 * SEC);
    let pages = 0;
    w.fake.editListPages(page => {
      pages += 1;
      if (pages === 2) w.fake.pledge('76000001', PTIER.B);
      return page;
    });
    const from = w.fake.calls.length;
    const logs = w.logs.length;
    await w.roundAdvancing(6 * MIN);
    const seenIds = new Set(w.fake.calls.slice(from).filter(c => c.route === 'members' && c.status === 200).flatMap(c => ((c.body as any)?.data ?? []).map((d: any) => d.id)));
    const installedIds = new Set(held(w).map(h => h.memberId));
    expect(paid.filter(m => seenIds.has(m.id) && !installedIds.has(m.id)).map(m => m.id)).toEqual([]);
    expect(w.logs.slice(logs).some(l => l.startsWith(LOG.PT3))).toBe(dupOnChange);
    for (let r = 0; r < 3; r++) {
      await w.advance(61 * MIN);
    }
    expect(held(w).length).toBe(250);
    expect(w.fake.calls.slice(from).filter(c => c.route === 'member').length).toBeLessThanOrEqual(unwired.length);
    expect(busiestMinute(w, CREATOR_TOKEN)).toBeLessThanOrEqual(80);
    expect(w.fake.unexpected).toEqual([]);
  }, 300_000);

  it('K5: the gate closing between two calls stops the round with PT6; a list slower than 3 minutes leaves time for 3b', async () => {
    await world(w, {}, false);
    const m = await installed(w, 0, PTIER.A);
    const hold = w.fake.hold('campaigns');
    let done = false;
    const running = (w.provider as any).checkNow().finally(() => { done = true; });
    await w.pump(hold.reached);
    setMaintenanceGate({ cause: 'hook', message: 'down' });
    hold.release();
    await w.pump(running);
    expect(done).toBe(true);
    expect(lines(w, `${LOG.PT6}: the bot entered maintenance. The next check runs in 5 minutes.`)).toHaveLength(1);
    expect(callsTo(w, 'member')).toEqual([]);
    setMaintenanceGate(null);
    await w.settle();

    await w.advance(W + MIN);
    for (let n = 0; n < 7001; n++) w.fake.pledge(patreonOf(n), PTIER.A);
    w.fake.cancel(m);
    await w.advance(2 * SEC);
    w.fake.slow('members', 25 * SEC, 20);
    expect(await w.roundAdvancing(6 * MIN)).toBe(true);
    expect(lines(w, 'it took 3 minutes').length + lines(w, '3 minutes').length).toBeGreaterThan(0);
    expect(ptiersAt(w, H)).toEqual([]);
  }, 300_000);

  it('K6 (THE LAG RULE): a cancel applied by a delivery, then stale reads: nothing installed again, no second paid.sub.started, and the re-read W later ends nothing more', async () => {
    await world(w);
    const m = await installed(w, 0, PTIER.A);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    const started = () => w.notices().filter(n => n.to === H && n.kind === 'paid.sub.started').length;
    const startedBefore = started();
    w.fake.cancel(m);
    await w.deliverAll();
    expect(held(w)).toEqual([]);
    await w.advance(5 * SEC);
    w.fake.settings.staleReads = 40;
    await w.round();
    expect(held(w)).toEqual([]);
    await w.advance(W + MIN);
    expect([held(w), started()]).toEqual([[], startedBefore]);
  });

  it('K7: an upgrade A to B applied by a delivery, then a stale 3b read showing A: B is kept and A not installed, and the re-read keeps B (fails on a build where a later single read always wins)', async () => {
    await world(w);
    const m = await installed(w, 0, PTIER.A);
    w.fake.changeTier(m, PTIER.B);
    await w.deliverAll();
    expect(tiersAt(w, H)).toEqual([`${PTIER.B}:active`]);
    await w.advance(5 * SEC);
    w.fake.settings.staleReads = 40;
    await w.round();
    expect(tiersAt(w, H)).toEqual([`${PTIER.B}:active`]);
    w.fake.settings.staleReads = 0;
    await w.advance(W + MIN);
    expect(tiersAt(w, H)).toEqual([`${PTIER.B}:active`]);
  });

  it("K7b (THE LAG RULE): a change A to B 4 minutes after A's install, read by its delivery: the read is deferred and changes nothing; the re-read ends A, then installs B (fails on a build whose deferred read installs the tiers it does not reverse with no holder move)", async () => {
    await world(w);
    const m = w.fake.pledge(PU, PTIER.A);
    await w.deliverAll();
    expect(tiersAt(w, H)).toEqual([`${PTIER.A}:active`]);
    await w.advance(4 * MIN);
    const at = w.emitted.length;
    const started = w.notices().filter(n => n.kind === 'paid.sub.started').length;
    w.fake.changeTier(m, PTIER.B);
    await w.deliverAll();
    expect([tiersAt(w, H), w.notices().filter(n => n.kind === 'paid.sub.started').length]).toEqual([[`${PTIER.A}:active`], started]);
    await w.advance(W);
    expect(tiersAt(w, H)).toEqual([`${PTIER.B}:active`]);
    expect(eventsSince(w, at).filter(e => !e.startsWith('updated'))).toEqual([`expired ${H} ${PTIER.A}`, `created ${H} ${PTIER.B}`]);
  });

  it.each([[true, 0], [true, 40], [false, 0], [false, 40]])('K12 (webhook %s, staleReads %s s): a pledge made again within W of the read that applied its cancel installs at the re-read', async (webhook, stale) => {
    await world(w, { staleReads: stale }, webhook);
    /** The change just made, applied the way the bot applies it: a delivery (its re-read when that read was stale), or a round past the lag. */
    const applied = async (): Promise<void> => {
      if (webhook) {
        await w.deliverAll();
        if (stale > 0) await w.advance(W + 30 * SEC);
      } else {
        await pastLag(w);
        await w.round();
      }
    };
    const m = w.fake.pledge(PU, PTIER.A);
    await applied();
    await w.advance(W + MIN);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    w.fake.cancel(m);
    await applied();
    expect(held(w)).toEqual([]);
    await w.advance(2 * MIN);
    w.fake.pledge(PU, PTIER.A);
    if (webhook) await w.deliverAll();
    else {
      await pastLag(w);
      await w.round();
    }
    const t = Date.now();
    expect(held(w)).toEqual([]);
    await w.advance(t + W + 30 * SEC - Date.now());
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
  });

  it("K13 (E16, PD4): a pick to a server where the Patreon tier is sold by two offerings keeps the user record, since the operator's wiring can change, and once the wiring is fixed the next round moves it with a Declined latest charge", async () => {
    await world(w, { declinedKeeps: true }, false);
    allowDropLines('L3');
    const m = w.fake.pledge(PU, PTIER.A);
    await w.advance(2 * SEC);
    await w.round();
    w.fake.decline(m);
    await w.advance(2 * SEC);
    await w.round();
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    const platinum = structuredClone((getPremiumManager() as any).getAllTiers().platinum);
    const wired = structuredClone(platinum);
    wired.offerings.push({ id: 'o-sa-twice', label: 'Platinum from A', providerLinks: [{ providerId: 'patreon', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: `tier:${PTIER.A}` }] } }] });
    expect((await w.op('setTier', 'platinum', wired)).ok).toBe(true);
    expect(await pick(w, 0, G)).toBe(true);
    await w.round();
    expect([ptiersAt(w, H), ptiersAt(w, G)]).toEqual([[PTIER.A], []]);
    expect(w.logs.some(l => l.includes(`'tier:${PTIER.A}' is sold by more than one offering`))).toBe(true);
    expect((await w.op('setTier', 'platinum', platinum)).ok).toBe(true);
    await w.round();
    expect([ptiersAt(w, H), ptiersAt(w, G)]).toEqual([[], [PTIER.A]]);
  });

  it('K15 (D14, E5, E19): a VIP record installed by a delivery, then a server pick 3 minutes later, moves the tier at once, and a pick back to the VIP 2 minutes after that moves it back at once; with a reversal of tier B pending, the pick still moves A at once, and B stays at the VIP until the re-read moves it (fails on a build that tests reversals per holder)', async () => {
    await world(w, { multiTier: true }, true);
    const m = w.fake.pledge(PU, PTIER.A);
    await w.deliverAll();
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    await w.advance(3 * MIN);
    expect(await pick(w, 0, G)).toBe(true);
    await w.round();
    expect([ptiersAt(w, H), ptiersAt(w, G)]).toEqual([[], [PTIER.A]]);
    await w.advance(2 * MIN);
    expect(await pick(w, 0, H)).toBe(true);
    await w.round();
    expect([ptiersAt(w, H), ptiersAt(w, G)]).toEqual([[PTIER.A], []]);
    await w.advance(W + MIN);
    expect([ptiersAt(w, H), ptiersAt(w, G)]).toEqual([[PTIER.A], []]);

    w.fake.pledge(PU, PTIER.B);
    await w.deliverAll();
    expect(ptiersAt(w, H)).toEqual([PTIER.A, PTIER.B]);
    await w.advance(MIN);
    expect(await pick(w, 0, G)).toBe(true);
    w.fake.settings.staleReads = 90;
    await w.round();
    expect([ptiersAt(w, H), ptiersAt(w, G)]).toEqual([[PTIER.B], [PTIER.A]]);
    w.fake.settings.staleReads = 0;
    await w.advance(W + MIN);
    expect([ptiersAt(w, H), ptiersAt(w, G)]).toEqual([[], [PTIER.A, PTIER.B]]);
    expect(m.state.entitled).toEqual([PTIER.A, PTIER.B]);
  });

  it('K16: a pledge ended 5 minutes after it was made keeps the tier until W after the read that showed the end', async () => {
    await world(w);
    const m = w.fake.pledge(PU, PTIER.A);
    w.fake.queue.length = 0;
    await w.advance(2 * SEC);
    await w.round();
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    await w.advance(5 * MIN);
    w.fake.cancel(m);
    const t = Date.now();
    await w.deliverAll();
    await w.advance(t + W - 5 * SEC - Date.now());
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    await w.advance(30 * SEC);
    expect(held(w)).toEqual([]);
  });

  it('K16, installed by a delivery: the cancel delivered 5 minutes later does not end the tier at once, and it is gone by W after that delivery (the pledge delivery\'s own re-read, due 5 minutes after the cancel, may end it first)', async () => {
    await world(w);
    const m = w.fake.pledge(PU, PTIER.A);
    await w.deliverAll();
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    await w.advance(5 * MIN);
    w.fake.cancel(m);
    const t = Date.now();
    await w.deliverAll();
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    await w.advance(t + W + 30 * SEC - Date.now());
    expect(held(w)).toEqual([]);
  });

  it('K17 (D20, E8): a delivery at t0 and a second change delivered at t0+9.5 minutes, both reads stale: the re-read at t0+10 changes nothing, and the one at t0+19.5 applies (fails on a build that keeps only the earliest due time)', async () => {
    await world(w, { staleReads: 40 });
    const t0 = Date.now();
    const m = w.fake.pledge(PU, PTIER.A);
    w.fake.fail('member', { status: 500 }, 1);
    await w.deliverAll();
    expect(held(w)).toEqual([]);
    await w.advance(t0 + 9.5 * MIN - Date.now());
    w.fake.changeTier(m, PTIER.B);
    await w.deliverAll();
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    const reads = memberReads(w, m).length;
    await w.advance(t0 + 10 * MIN + 5 * SEC - Date.now());
    expect(memberReads(w, m).length).toBe(reads + 1);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    await w.advance(t0 + 19.5 * MIN + 5 * SEC - Date.now());
    expect(ptiersAt(w, H)).toEqual([PTIER.B]);
  });

  it("K18 (E7): with two ticker owners on one store, a refund machine 1 ends from a delivery and machine 2's stale list installs again is ended again by machine 1's re-read within about W", async () => {
    await world(w);
    const m = await installed(w, 0, PTIER.A);
    w.fake.refund(m);
    await w.deliverAll();
    expect(held(w)).toEqual([]);
    await w.advance(5 * SEC);
    w.fake.settings.staleReads = 60;
    const machine2 = new PatreonProvider();
    await w.pump(machine2.checkNow());
    await w.settle();
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    w.fake.settings.staleReads = 0;
    await w.advance(W);
    expect(held(w)).toEqual([]);
    machine2.stop();
  });

  it('K19 (E12, E17): a delivered refund whose op read and re-reads meet a 500, no answer, a failed step 0 and a closed gate in turn: each re-read is armed again W later and the first readable answer ends the tier (fails on a build that re-arms only after a 429)', async () => {
    await world(w);
    const m = await installed(w, 0, PTIER.A);
    w.fake.refund(m);
    w.fake.fail('member', { status: 500 }, 1);
    await w.deliverAll();
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    w.fake.fail('member', { noAnswer: true }, 1);
    await w.advance(W + MIN);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    w.fake.fail('campaigns', { status: 500 }, 1);
    await w.advance(W);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    setMaintenanceGate({ cause: 'hook', message: 'down' });
    await w.advance(W);
    setMaintenanceGate(null);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    await w.advance(W);
    expect(held(w)).toEqual([]);
  });

  it('K19 (E17): after a 401 no re-read runs until a round\'s step 0 passes; a malformed 2xx or a 403 arms nothing more', async () => {
    await world(w);
    const m = await installed(w, 0, PTIER.A);
    await w.advance(2 * HOUR);
    for (const fault of [{ body: 'malformed' as const }, { status: 403 }]) {
      w.fake.setMember(m, { patronStatus: 'active_patron' });
      w.fake.fail('member', fault, 2);
      const t = Date.now();
      await w.deliverAll();
      await w.advance(W - 5 * SEC);
      const inOp = memberReads(w, m).filter(c => c.at >= t).length;
      await w.advance(40 * MIN);
      const after = memberReads(w, m).filter(c => c.at >= t).length;
      expect([fault, inOp > 0, after - inOp]).toEqual([fault, true, 1]);
      expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    }
    w.fake.expireCreatorToken();
    w.fake.setMember(m, { patronStatus: 'active_patron' });
    const t = Date.now();
    await w.deliverAll();
    const inOp = memberReads(w, m).filter(c => c.at >= t).length;
    await w.advance(2 * HOUR);
    expect([inOp > 0, memberReads(w, m).filter(c => c.at >= t).length - inOp]).toEqual([true, 0]);
    w.fake.expiredTokens.delete(CREATOR_TOKEN);
    await w.round();
    const passed = Date.now();
    await w.advance(W - 5 * SEC);
    expect(memberReads(w, m).filter(c => c.at > passed)).toEqual([]);
    await w.advance(MIN);
    expect(memberReads(w, m).filter(c => c.at > passed).length).toBe(1);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
  });

  it('K14 (R7 past W): with reads lagging 15 minutes the re-read can apply the stale state, and the next read after the lag corrects it', async () => {
    await world(w);
    const m = await installed(w, 0, PTIER.A);
    w.fake.settings.staleReads = 15 * 60;
    w.fake.cancel(m);
    await w.deliverAll();
    await w.advance(W + MIN);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    await w.advance(75 * MIN);
    expect(held(w)).toEqual([]);
  });

  it('K8 (R11): a masked member\'s record keeps following by member id; its new pledge waits for a relink, with PT1 once', async () => {
    await world(w, { multiTier: true });
    const m = await installed(w, 0, PTIER.A);
    m.masked = true;
    w.fake.cancel(m);
    await w.deliverAll();
    expect(held(w)).toEqual([]);
    await link(w, 1);
    const other = w.fake.pledge(PATREON_USERS[1], PTIER.B);
    other.masked = true;
    await w.deliverAll();
    await w.advance(W + MIN);
    await w.round();
    await w.round();
    expect(ptiersAt(w, holderOf(1))).toEqual([]);
    expect(w.logs.filter(l => l.startsWith(`${LOG.PT1}${other.id} ${LOG.PT1_TAIL}`))).toHaveLength(1);
  });

  it('K9 (R14): a renew with a new member id ends the old record and installs the new one', async () => {
    await world(w, { newMemberOnRenew: true, giftedEntitled: true }, false);
    allowDropLines('L3');
    const gift = w.fake.gift(PU, PTIER.A);
    await w.advance(2 * SEC);
    await w.round();
    expect(held(w).map(h => h.memberId)).toEqual([gift.id]);
    w.fake.setMember(gift, { entitled: [], patronStatus: 'former_patron' });
    const renewed = w.fake.pledge(PU, PTIER.A);
    expect(renewed.id).not.toBe(gift.id);
    for (let r = 0; r < 4; r++) await w.advance(61 * MIN);
    expect(held(w).map(h => h.memberId)).toEqual([renewed.id]);
  });

  it('K10: a member whose read always answers 403, first in stored order, does not keep a later refunded one from ending within two rounds', async () => {
    await world(w, { declinedKeeps: true }, false);
    await link(w, 1);
    const m0 = w.fake.pledge(PU, PTIER.A);
    await w.advance(2 * SEC);
    await w.round();
    const m1 = w.fake.pledge(PATREON_USERS[1], PTIER.A);
    await w.advance(2 * SEC);
    await w.round();
    expect(held(w).map(h => h.memberId)).toEqual([m0.id, m1.id]);
    await w.advance(W + MIN);
    w.fake.decline(m0);
    w.fake.refund(m1);
    w.fake.fail(new RegExp(`^/members/${m0.id}`), { status: 403 }, 1000);
    await w.advance(2 * SEC);
    await w.round();
    expect([ptiersAt(w, H), ptiersAt(w, holderOf(1))]).toEqual([[PTIER.A], [PTIER.A]]);
    await w.round();
    expect([ptiersAt(w, H), ptiersAt(w, holderOf(1))]).toEqual([[PTIER.A], []]);
  });

  it('K11: after a 429 no creator-token call before retry_after_seconds; no minute has more than 80 creator-token calls', async () => {
    await world(w, {}, false);
    await installed(w, 0, PTIER.A);
    w.fake.fail('members', { status: 429, retryAfter: 20 }, 1);
    await w.advance(2 * SEC);
    const from = w.fake.calls.length;
    await w.roundAdvancing(2 * MIN);
    const calls = w.fake.calls.slice(from).filter(c => c.token === CREATOR_TOKEN);
    const limited = calls.find(c => c.status === 429)!;
    expect(limited).toBeDefined();
    expect(calls.filter(c => c.at > limited.at && c.at < limited.at + 20 * SEC)).toEqual([]);
    expect(busiestMinute(w, CREATOR_TOKEN)).toBeLessThanOrEqual(80);
  });
});

describe.each(BACKENDS)('P7 claim 6 on %s: the rows that name a save', (_name, backend) => {
  const w = p7World(backend);
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  /** Premium refuses the first install at the server with a save it could not make; the count of refusals. */
  function refuseFirstServerInstall(): { refused: () => number; restore: () => void } {
    const pm = getPremiumManager() as any;
    const real = pm.installAsyncSubscription.bind(pm);
    let refused = 0;
    const spy = vi.spyOn(pm, 'installAsyncSubscription').mockImplementation(async (event: any, opts?: any) => {
      if (event.holder === G && refused === 0) {
        refused += 1;
        return { refused: 'io' };
      }
      return real(event, opts);
    });
    return { refused: () => refused, restore: () => spy.mockRestore() };
  }

  it('K2: a quiet round with one active and one queued record saves nothing and hands premium nothing', async () => {
    await world(w, { multiTier: true }, false);
    w.fake.pledge(PU, PTIER.A);
    w.fake.pledge(PU, PTIER.B);
    await w.advance(2 * SEC);
    await w.round();
    expect(tiersAt(w, H)).toEqual([`${PTIER.A}:paused`, `${PTIER.B}:active`]);
    await w.round();
    const before = [w.storedText(), w.auditLines().length, w.emitted.length];
    await w.round();
    await w.round();
    expect([w.storedText(), w.auditLines().length, w.emitted.length]).toEqual(before);
  });

  it('K13 (E16): with a Declined latest charge, a pick change whose server install save is refused keeps the user record, and the next round moves it; a pick to a server whose tier is not wired gives PD3 and ends the user record, and after the operator wires it nothing installs until a Paid charge', async () => {
    await world(w, { declinedKeeps: true }, false);
    allowDropLines('L3');
    const m = w.fake.pledge(PU, PTIER.A);
    await w.advance(2 * SEC);
    await w.round();
    w.fake.decline(m);
    await w.advance(2 * SEC);
    await w.round();
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    const refusal = refuseFirstServerInstall();
    expect(await pick(w, 0, G)).toBe(true);
    await w.round();
    expect([refusal.refused(), ptiersAt(w, H), ptiersAt(w, G)]).toEqual([1, [PTIER.A], []]);
    await w.round();
    expect([ptiersAt(w, H), ptiersAt(w, G)]).toEqual([[], [PTIER.A]]);
    refusal.restore();

    expect(await pick(w, 0, H)).toBe(true);
    w.fake.setMember(m, { entitled: [PTIER.A2], lastChargeStatus: 'Paid', lastChargeDate: Date.now() });
    await w.advance(W + MIN);
    await w.round();
    expect([ptiersAt(w, H), ptiersAt(w, G)]).toEqual([[PTIER.A2], []]);
    w.fake.decline(m);
    await w.advance(2 * SEC);
    await w.round();
    expect(ptiersAt(w, H)).toEqual([PTIER.A2]);
    expect(await pick(w, 0, G)).toBe(true);
    await w.round();
    expect([ptiersAt(w, H), ptiersAt(w, G)]).toEqual([[], []]);
    if (backend === 'json') expect(w.logs.some(l => l.includes(`no server tier has an offering that sells 'tier:${PTIER.A2}' through Patreon`))).toBe(true);
    const gold = structuredClone((getPremiumManager() as any).getAllTiers().gold);
    gold.offerings.push({ id: 'o-sa2', label: 'Gold from A2', providerLinks: [{ providerId: 'patreon', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: `tier:${PTIER.A2}` }] } }] });
    expect((await w.op('setTier', 'gold', gold)).ok).toBe(true);
    await w.round();
    expect(ptiersAt(w, G)).toEqual([]);
    w.fake.pledge(PU, PTIER.A2);
    await w.advance(W + MIN);
    await w.round();
    expect(ptiersAt(w, G)).toEqual([PTIER.A2]);
  });

  it("K13 (E16) by a member read: with a Declined latest charge, a pick change and then a delivery whose server install save is refused keep the user record, and the delivery's re-read moves it (fails on a build whose read-driven move ends the old record before the new one is held)", async () => {
    await world(w, { declinedKeeps: true }, true);
    allowDropLines('L3');
    const m = w.fake.pledge(PU, PTIER.A);
    await w.deliverAll();
    w.fake.decline(m);
    await w.deliverAll();
    await w.advance(W + MIN);
    expect([ptiersAt(w, H), m.state.lastChargeStatus]).toEqual([[PTIER.A], 'Declined']);
    const refusal = refuseFirstServerInstall();
    expect(await pick(w, 0, G)).toBe(true);
    const reads = memberReads(w, m).length;
    w.fake.setMember(m, { patronStatus: 'declined_patron' });
    await w.deliverAll();
    expect([memberReads(w, m).length - reads, refusal.refused(), ptiersAt(w, H), ptiersAt(w, G)]).toEqual([1, 1, [PTIER.A], []]);
    await w.advance(W + MIN);
    expect([ptiersAt(w, H), ptiersAt(w, G)]).toEqual([[], [PTIER.A]]);
    refusal.restore();
  });
});

describe('P7 claim 6: the order and the limiter', () => {
  const w = p7World('json');
  afterEach(async () => {
    await w.teardown();
    setOrderRefusal(false);
    vi.restoreAllMocks();
  });

  it('K11b (section 2 item 2): a round waiting on the limiter after a 429 stops within about a second of an order starting, and calls Patreon nothing more (fails on a build that checks the order only before the wait)', async () => {
    await world(w, {}, false);
    await installed(w, 0, PTIER.A);
    w.fake.fail('members', { status: 429, retryAfter: 50 }, 1);
    await w.advance(2 * SEC);
    const from = w.fake.calls.length;
    let done = false;
    const running = Promise.resolve((w.provider as any).checkNow()).finally(() => { done = true; });
    for (let i = 0; i < 50 && !w.fake.calls.slice(from).some(c => c.status === 429); i++) await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(2 * SEC);
    const waiting = !done && acceptedOpsRunning() > 0;
    setOrderRefusal(true);
    const at = Date.now();
    await vi.advanceTimersByTimeAsync(2 * SEC);
    const stopped = done && acceptedOpsRunning() === 0;
    await vi.advanceTimersByTimeAsync(60 * SEC);
    await w.pump(running);
    const after = w.fake.calls.filter(c => c.at >= at && c.token === CREATOR_TOKEN).length;
    setOrderRefusal(false);
    expect([waiting, stopped, after]).toEqual([true, true, 0]);
    expect(lines(w, `${LOG.PT6}: a save order holds. The next check runs in 5 minutes.`)).toHaveLength(1);
  });
});

describe('P7 claim 7: the end rule', () => {
  const w = p7World('json');
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it.each([
    ['a 500', { status: 500 }], ['a 429', { status: 429, retryAfter: 5 }], ['no answer', { noAnswer: true }], ['a malformed body', { body: 'malformed' }],
  ] as const)('N1: a record absent from a complete list whose read fails with %s stays round after round (fails on a build that ends on absence)', async (_name, fault) => {
    await world(w, {}, false);
    const m = await installed(w, 0, PTIER.A);
    w.fake.editListPages(page => page.filter(d => d.id !== m.id));
    w.fake.fail('member', fault as any, 1000);
    for (let r = 0; r < 3; r++) await w.advance(61 * MIN);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
  });

  it('N2: an incomplete list ends nothing', async () => {
    await world(w, {}, false);
    await installed(w, 0, PTIER.A);
    w.fake.fail('members', { status: 500 }, 1000);
    for (let r = 0; r < 3; r++) await w.advance(61 * MIN);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    expect(lines(w, LOG.PT3).length).toBeGreaterThan(0);
  });

  it.each([['Patreon user'], ['campaign']] as const)('N3: a read naming another %s gives PT10 and changes nothing', async which => {
    await world(w, {}, false);
    const m = await installed(w, 0, PTIER.A);
    if (which === 'campaign') {
      w.fake.campaigns.get(CREATOR_ID)!.push(OTHER_CAMPAIGN_ID);
      m.campaignId = OTHER_CAMPAIGN_ID;
    } else {
      m.userId = PATREON_USERS[2];
    }
    w.fake.cancel(m);
    await w.advance(61 * MIN);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    const named = which === 'campaign' ? `campaign ${OTHER_CAMPAIGN_ID}` : `Patreon user ${PATREON_USERS[2]}`;
    expect(lines(w, `Patreon member ${m.id} belongs to ${named}, ${LOG.PT10_TAIL}`).length).toBeGreaterThan(0);
  });

  it('G1 (R9): an expired creator token: PT4 once, no list or member read, nothing ends over any number of rounds', async () => {
    await world(w, {}, false);
    const m = await installed(w, 0, PTIER.A);
    w.fake.expireCreatorToken();
    w.fake.cancel(m);
    const from = w.fake.calls.length;
    for (let r = 0; r < 4; r++) await w.advance(61 * MIN);
    expect(w.fake.calls.slice(from).filter(c => c.route === 'members' || c.route === 'member')).toEqual([]);
    expect(lines(w, LOG.PT4)).toHaveLength(1);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
  });

  it.each([['401'], ['403'], ['404'], ['200-empty']] as const)('G2 (R8, foreignToken %s): another creator\'s token: step 0 does not list the campaign, PT20, nothing ends (fails on a build without step 0)', async foreignToken => {
    await world(w, { foreignToken }, false);
    const m = await installed(w, 0, PTIER.A);
    w.fake.rotateCreator();
    w.setCredentials({ PATREON_CREATOR_ACCESS_TOKEN: OTHER_CREATOR_TOKEN });
    w.fake.cancel(m);
    for (let r = 0; r < 3; r++) await w.advance(61 * MIN);
    expect(lines(w, LOG.PT20)).toHaveLength(1);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
  });

  it('G3: a member Patreon deleted: the first round logs PT7, and the one 60 minutes later ends it with PT5 (fails on a build that ends at the first 404)', async () => {
    await world(w, { giftedEntitled: true }, false);
    const gift = w.fake.gift(PU, PTIER.A);
    await w.advance(2 * SEC);
    await w.round();
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    w.fake.deleteMember(gift);
    await w.round();
    expect(lines(w, LOG.PT7_TAIL)).toHaveLength(1);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    await w.advance(59 * MIN);
    await w.round();
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    await w.advance(61 * MIN);
    expect(held(w)).toEqual([]);
    expect(lines(w, LOG.PT5_TAIL)).toHaveLength(1);
  });

  it('G4: a 2xx between two 404s, and a restart between them: no end until two 404s an hour apart in one process', async () => {
    await world(w, {}, false);
    const m = await installed(w, 0, PTIER.A);
    w.fake.editListPages(page => page.filter(d => d.id !== m.id));
    w.fake.settings.notFoundLive.add(m.id);
    await w.round();
    w.fake.settings.notFoundLive.delete(m.id);
    await w.advance(61 * MIN);
    w.fake.settings.notFoundLive.add(m.id);
    await w.advance(61 * MIN);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    await w.restart();
    await w.advance(31 * SEC);
    await w.advance(50 * MIN);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
    await w.advance(15 * MIN);
    expect(held(w)).toEqual([]);
  });

  it('G5: a live member Patreon answers 404 for ends after two 404s, and the next list that shows it installs it again', async () => {
    await world(w, {}, false);
    const m = await installed(w, 0, PTIER.A);
    w.fake.editListPages(page => page.filter(d => d.id !== m.id));
    w.fake.settings.notFoundLive.add(m.id);
    await w.advance(61 * MIN);
    await w.advance(61 * MIN);
    expect(held(w)).toEqual([]);
    w.fake.editListPages(null);
    await w.advance(61 * MIN);
    expect(ptiersAt(w, H)).toEqual([PTIER.A]);
  });

  it('G6: after the campaign id changes, the old records are not followed, never read or ended, with PT18 once each', async () => {
    await world(w, { multiTier: true }, false);
    const m = w.fake.pledge(PU, PTIER.A);
    w.fake.pledge(PU, PTIER.B);
    await w.advance(2 * SEC);
    await w.round();
    expect(held(w)).toHaveLength(2);
    const { token, campaignId } = w.fake.rotateCreator();
    w.setCredentials({ PATREON_CREATOR_ACCESS_TOKEN: token, PATREON_CAMPAIGN_ID: campaignId });
    w.fake.cancel(m);
    const from = w.fake.calls.length;
    for (let r = 0; r < 3; r++) await w.advance(61 * MIN);
    expect(held(w)).toHaveLength(2);
    expect(memberReads(w, m, from)).toEqual([]);
    expect(lines(w, LOG.PT18_TAIL)).toHaveLength(2);
    expect(held(w).every(h => h.sub.providerMeta.campaignId === CAMPAIGN_ID)).toBe(true);
  });
});
