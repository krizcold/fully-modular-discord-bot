import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

// P2 claims 8 and 11 (parts 0 and 2): the Dummy provider's records and premium's store agree, per holder. Two servers
// and two users whose ids are pairwise the same numbers, three tiers per kind sold through the Dummy. Random sequences of
// purchases, grants, revokes, cancels at period end, renewals again, cancels now, cancels of a queued entry, jumps of
// the clock by 1 to 40 days and ticks (the Dummy's, then premium's expiry tick), on the real DummyProvider and the real
// PremiumManager in the bot role, on the JSON files and on the mirror rig (fewer runs). A second generator, on the rig,
// adds another machine's change of premium-tiers.json just before a step (that step's premium save is refused) and a
// new process. After every step the two stored documents are read:
// A1, every subscription premium holds from the Dummy has a record with the same id, owner and buyer;
// A2, after two ticks with no step between, each such record's view equals premium's answer; when it does not yet, the
// driver ticks on until it does, at most SETTLE_BOUND more, and a run that does not settle inside that fails;
// A3, no provider subscription id is held by two holders in premium, and each id is one record;
// A4, every live record is held by premium under its own holder or listed for that holder, and no other holder's list
// has it;
// A5 (claim 8), a step on one holder leaves every other holder's record in both documents as it was;
// P1's K1 to K4 and N1 to N3 hold on premium's document. In the second generator A2 holds after two ticks and A5 is
// not checked: a refused premium save leaves the two documents apart until the ticks repair them. A record's owner is
// read through ownerOf only. Left out, as in P1: a setTier that changes a priority (E2). A failure prints its seed;
// SMDB_TEST_SEED replays it.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { PREMIUM_KEY } from '../helpers/nb6PremiumRig';
import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { gh, uh } from '../helpers/p1Holder';
import { p1World, SERVERS, type OpReply } from '../helpers/p1World';
import { brokenAgreement, dummyDriver, heldByPremium, ownerOf, viewDiffers } from '../helpers/p2DummyDriver';

/** The holders the steps act on: two servers, then the two users with the same numbers. */
const HOLDERS = [...SERVERS.map(id => gh(id)), ...SERVERS.map(id => uh(id))];
const LISTERS = HOLDERS;
/** The three tiers of each kind, by the holder's kind. */
const TIERS = { guild: ['low', 'mid', 'high'], user: ['vlow', 'vmid', 'vhigh'] };
const tierOf = (who: string, index: number): string => TIERS[who.startsWith('user:') ? 'user' : 'guild'][index];
const LOCK_READ = 'SELECT body, sha, updated_by, updated_at FROM smdb_data.shared_docs';
/** The most ticks added after a run of ticks until every held record's view equals premium's answer. */
const SETTLE_BOUND = 6;
/** How many settled runs of ticks needed each number of added ticks. */
const settleTally: Record<number, number> = {};
/** The seed fast-check runs with: SMDB_TEST_SEED's (set in helpers/setup.ts), or one drawn here so it can be named. */
function runSeed(): number {
  return fc.readConfigureGlobal().seed ?? ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) | 0);
}

type Step =
  | { t: 'purchase'; h: number; tier: number }
  | { t: 'grant'; h: number; tier: number; days: number | null }
  | { t: 'revoke' | 'cancel' | 'renew' | 'cancelNow'; h: number }
  | { t: 'cancelQueued'; h: number; pick: number }
  | { t: 'advance'; days: number }
  | { t: 'tick' }
  | { t: 'ticks' }
  | { t: 'elsewhere'; step: Step; paid?: true }
  | { t: 'restart' };

const holder = fc.constantFrom(...HOLDERS.keys());
const tier = fc.constantFrom(0, 1, 2);
const steps: fc.Arbitrary<Step>[] = [
  fc.record({ t: fc.constant('purchase' as const), h: holder, tier }),
  fc.record({ t: fc.constant('purchase' as const), h: holder, tier }),
  fc.record({ t: fc.constant('grant' as const), h: holder, tier, days: fc.option(fc.integer({ min: 1, max: 60 }), { nil: null }) }),
  fc.record({ t: fc.constantFrom('revoke' as const, 'cancel' as const, 'renew' as const, 'cancelNow' as const), h: holder }),
  fc.record({ t: fc.constant('cancelQueued' as const), h: holder, pick: fc.nat({ max: 5 }) }),
  fc.record({ t: fc.constant('advance' as const), days: fc.integer({ min: 1, max: 40 }) }),
  fc.record({ t: fc.constant('tick' as const) }),
  fc.record({ t: fc.constant('tick' as const) }),
];
/**
 * The second generator's steps: the first's, a step whose premium save another machine's write refuses, a new process,
 * and two ticks with no step between. The refused step is also drawn, three times as often, from the steps that leave
 * both documents holding a record with different fields (S2) on a holder with a Dummy subscription, and the two ticks
 * three times as often as a new process, so that the two ticks meet that state in most runs.
 */
const actingSteps = steps.slice(0, 5);
const twoTicks = fc.record({ t: fc.constant('ticks' as const) });
const refusedOnPaid = fc.record({ t: fc.constant('elsewhere' as const), step: fc.record({ t: fc.constantFrom('cancel' as const, 'renew' as const, 'cancelNow' as const), h: holder }), paid: fc.constant(true as const) });
const secondSteps: fc.Arbitrary<Step>[] = [
  ...steps,
  twoTicks, twoTicks, twoTicks,
  fc.record({ t: fc.constant('elsewhere' as const), step: fc.oneof(...actingSteps) }),
  refusedOnPaid, refusedOnPaid, refusedOnPaid,
  fc.record({ t: fc.constant('restart' as const) }),
];

/**
 * Steps premium answered ok and steps after which a Dummy record changed, so a world that refuses everything fails; and
 * the A2 checks made after two ticks that began while a record premium holds differed from premium's answer.
 */
const tally = { steps: 0, ok: 0, records: 0, a2OnDifference: 0 };

type World = ReturnType<typeof p1World>;

/** Each held record whose view differs from premium's answer, with the fields that differ. */
function a2Differences(w: World, driver: ReturnType<typeof dummyDriver>): string[] {
  const records = driver.document()?.subscriptions ?? {};
  return heldByPremium(w.stored()).flatMap(({ holder: key, sub }) => {
    const record = records[sub.providerSubId];
    return record ? viewDiffers(key, sub.providerSubId, record).map(d => `${sub.providerSubId} has ${d}`) : [];
  });
}

/** Another machine's write of premium-tiers.json at the first lock read of it (the next premium save is then refused). */
function premiumElsewhere(w: World): void {
  const rows = w.rig!.m.state.rows;
  let done = false;
  rows.fault = async (sql, params) => {
    if (!done && sql.startsWith(LOCK_READ) && params?.[0] === PREMIUM_KEY) {
      done = true;
      const config = JSON.parse(rows.docs.get(PREMIUM_KEY)!.body.toString('utf8'));
      config.messages = { ...(config.messages ?? {}), moduleBlocked: `from another machine ${Date.now()}` };
      rows.put(PREMIUM_KEY, JSON.stringify(config, null, 2));
    }
    return undefined;
  };
}

/** The step on the h-th holder (wrapped) of those whose active subscription is from the Dummy; as given when none is. */
function onPaidHolder(w: World, step: Step): Step {
  if (!('h' in step)) return step;
  const paid = HOLDERS.flatMap((key, index) => (w.recordOf(key)?.active?.providerId === 'dummy' ? [index] : []));
  return paid.length === 0 ? step : { ...step, h: paid[step.h % paid.length] };
}

async function run(w: World, driver: ReturnType<typeof dummyDriver>, step: Step): Promise<OpReply | null> {
  if (step.t === 'elsewhere') {
    premiumElsewhere(w);
    try {
      return await run(w, driver, step.paid ? onPaidHolder(w, step.step) : step.step);
    } finally {
      w.rig!.m.state.rows.fault = undefined;
      await runSharedPass();
      await w.settle();
    }
  }
  if (step.t === 'restart') {
    // A new process keeps the wall clock; the driver starts its fake clock from the real time again.
    const now = Date.now();
    await w.settle();
    await driver.detach();
    await driver.attach(w.rig);
    vi.setSystemTime(now);
    await w.reload();
    getPremiumManager().startExpiryChecker();
    return null;
  }
  if (step.t === 'advance') {
    w.advance(step.days);
    return null;
  }
  if (step.t === 'tick' || step.t === 'ticks') {
    await w.tick();
    if (step.t === 'ticks') await w.tick();
    await w.settle();
    return null;
  }
  const who = HOLDERS[step.h];
  switch (step.t) {
    case 'purchase': return w.purchase(who, tierOf(who, step.tier));
    case 'grant': return w.grant(who, tierOf(who, step.tier), step.days);
    case 'revoke': return w.revoke(who);
    case 'cancel': return w.op('cancelPaidSubscription', who);
    case 'renew': return w.op('reactivatePaidSubscription', who);
    case 'cancelNow': return w.cancelNow(who);
    case 'cancelQueued': return w.cancelQueued(who, step.pick);
  }
}

/** Runs the steps on a new world; what each step broke, collected and returned for the caller to assert on. */
async function broken(w: World, driver: ReturnType<typeof dummyDriver>, sequence: Step[], second = false): Promise<string[]> {
  const found: string[] = [];
  await w.setup();
  await w.addSoldUserTiers();
  try {
    if (Object.keys(w.tiers('user')).length !== 4) throw new Error('the user tiers sold through the Dummy were not saved');
    getPremiumManager().startExpiryChecker();
    const differed: boolean[] = [];
    for (const [index, step] of sequence.entries()) {
      const stateBefore = driver.document();
      differed.push(heldByPremium(w.stored()).some(({ holder: key, sub }) => {
        const record = stateBefore?.subscriptions?.[sub.providerSubId];
        return !!record && viewDiffers(key, sub.providerSubId, record).length > 0;
      }));
      const premiumBefore = w.stored()?.subscriptions ?? {};
      const reply = await run(w, driver, step);
      tally.steps += 1;
      if (reply?.ok) tally.ok += 1;
      const where = `step ${index} ${JSON.stringify(step)}`;
      const pairAfterTick = step.t === 'tick' && index > 0 && sequence[index - 1].t === 'tick';
      let settledTwice = step.t === 'ticks' || pairAfterTick;
      if (settledTwice) {
        let added = 0;
        let differences = a2Differences(w, driver);
        while (differences.length > 0 && added < SETTLE_BOUND) {
          await w.tick();
          await w.settle();
          added += 1;
          differences = a2Differences(w, driver);
        }
        settleTally[added] = (settleTally[added] ?? 0) + 1;
        if (differences.length > 0) {
          found.push(`A2: ${differences.join('; ')} ${SETTLE_BOUND} ticks after the two after ${where}`);
          settledTwice = false;
        }
      }
      const state = driver.document();
      if (JSON.stringify(state?.subscriptions ?? {}) !== JSON.stringify(stateBefore?.subscriptions ?? {})) tally.records += 1;
      if (!second && 'h' in step) {
        const acted = HOLDERS[step.h];
        const before: Record<string, any> = stateBefore?.subscriptions ?? {};
        const after: Record<string, any> = state?.subscriptions ?? {};
        for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
          const record = before[id] ?? after[id];
          if (ownerOf(record) === acted) continue;
          if (JSON.stringify(after[id]) !== JSON.stringify(before[id])) found.push(`A5: ${where} changed the Dummy record ${id} of ${ownerOf(record)}`);
        }
        const premiumAfter = w.stored()?.subscriptions ?? {};
        for (const key of new Set([...Object.keys(premiumBefore), ...Object.keys(premiumAfter)])) {
          if (key === acted) continue;
          if (JSON.stringify(premiumAfter[key]) !== JSON.stringify(premiumBefore[key])) found.push(`A5: ${where} changed premium's record of ${key}`);
        }
      }
      if (settledTwice && differed[pairAfterTick ? index - 1 : index]) tally.a2OnDifference += 1;
      for (const line of await brokenAgreement(w.stored(), driver, state, settledTwice, LISTERS)) found.push(`${line} after ${where}`);
      if (found.length > 0) break;
    }
  } finally {
    await w.teardown();
  }
  return found;
}

afterEach(() => { vi.restoreAllMocks(); });

describe.each([['the JSON files', 'json' as const, 25], ['the mirror rig', 'rig' as const, 8]])('P2 claim 11 on %s: two servers and two users through the Dummy', (_name, backend, numRuns) => {
  const driver = dummyDriver();
  const w = p1World(backend, driver);

  it('A1 to A5, K1 to K4 and N1 to N3 hold after every step', async () => {
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
    Object.assign(tally, { steps: 0, ok: 0, records: 0, a2OnDifference: 0 });
    await fc.assert(fc.asyncProperty(fc.array(fc.oneof(...steps), { minLength: 4, maxLength: 20 }), async sequence => {
      expect(await broken(w, driver, sequence)).toEqual([]);
    }), { numRuns });
    expect({ ...tally, enough: tally.ok * 10 >= tally.steps && tally.records * 10 >= tally.steps }).toMatchObject({ enough: true });
  }, 600_000);
});

describe('P2 claim 11 on the mirror rig, the second generator: refused premium saves and new processes', () => {
  const driver = dummyDriver();
  const w = p1World('rig', driver);

  it('A1 to A4, K1 to K4 and N1 to N3 hold after every step, A2 after two ticks', async () => {
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
    Object.assign(tally, { steps: 0, ok: 0, records: 0, a2OnDifference: 0 });
    const seed = runSeed();
    for (const key of Object.keys(settleTally)) delete settleTally[Number(key)];
    const makesS2: Step[] = [{ t: 'grant', h: 0, tier: 0, days: 1 }, { t: 'purchase', h: 3, tier: 0 }, { t: 'advance', days: 30 }, { t: 'tick' }, { t: 'ticks' }];
    await fc.assert(fc.asyncProperty(fc.array(fc.oneof(...secondSteps), { minLength: 4, maxLength: 20 }), async sequence => {
      expect(await broken(w, driver, sequence, true), `seed ${seed}`).toEqual([]);
    }), { numRuns: 24, seed, examples: [[makesS2]] });
    process.stdout.write(`[p2Props] seed ${seed}, added ticks per settled run of ticks: ${JSON.stringify(settleTally)}\n`);
    expect({ ...tally, seed, enough: tally.ok * 10 >= tally.steps && tally.records * 10 >= tally.steps }).toMatchObject({ enough: true });
    expect(tally.a2OnDifference, `no A2 check on a real difference with seed ${seed}`).toBeGreaterThan(0);
  }, 600_000);
});
