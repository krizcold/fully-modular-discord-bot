import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

// P5 claim 10, part 0's form: PayPal and premium agree per holder. The real PayPalProvider and the real PremiumManager
// in the bot role, over the JSON files and over the mirror rig (fewer runs), with the fake of helpers/p5PayPal.ts as
// PayPal. Holders guild:<a> and guild:<b>, each bought on the member route by user a or user b signed in, for the lower
// or the higher server tier and its cheap or dear plan. Random sequences of: a purchase, the buyer approving any
// subscription waiting for approval, a renewal of any active one, and the delivery of the oldest queued event (events
// in order). After every step A3 holds; after the queue is drained in order, A3 holds:
// A3, no PayPal id is held under two holders, and every held one's custom_id at the fake names that holder and that
// buyer.
// No call reaches an address the fake does not serve. A failure prints its seed; SMDB_TEST_SEED replays it.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  const store = { getCachedModules: () => [], getRepositories: () => [], getInstalledModules: () => [], getAvailableModules: async () => [] };
  return { ...real, getAppStoreManager: () => store };
});

import { allowDropLines } from '../helpers/p1Guard';
import { laterPayments, onceEnd, onceProof, z5End } from '../helpers/p5Model';
import { FakeRefusal, ownerOfCustomId, type FakeSettings, type PayPalEvent } from '../helpers/p5PayPal';
import { EXTRA_PLANS, heldPayPal, IDS, p5World, planId, TIERS, type P5World, type PlanKind, type TierId } from '../helpers/p5World';

const HOLDERS = [`guild:${IDS[0]}`, `guild:${IDS[1]}`];
const BUYERS = IDS;

type Step =
  | { t: 'buy'; h: number; buyer: number; high: boolean; plan: PlanKind }
  | { t: 'approve'; pick: number }
  | { t: 'renew'; pick: number }
  | { t: 'deliver' };

const pick = fc.nat({ max: 15 });
const buy = fc.record({
  t: fc.constant('buy' as const),
  h: fc.nat({ max: HOLDERS.length - 1 }),
  buyer: fc.nat({ max: BUYERS.length - 1 }),
  high: fc.boolean(),
  plan: fc.constantFrom<PlanKind>('cheap', 'dear'),
});
const steps: fc.Arbitrary<Step>[] = [
  buy, buy,
  fc.record({ t: fc.constant('approve' as const), pick }),
  fc.record({ t: fc.constant('approve' as const), pick }),
  fc.record({ t: fc.constant('renew' as const), pick }),
  fc.record({ t: fc.constant('deliver' as const) }),
  fc.record({ t: fc.constant('deliver' as const) }),
  fc.record({ t: fc.constant('deliver' as const) }),
];

/** Across a describe's runs: steps run, purchases that made a subscription, approvals, renewals, deliveries answered 200, held ones checked. */
const tally = { steps: 0, made: 0, approved: 0, renewed: 0, delivered200: 0, checked: 0 };

function runSeed(): number {
  return fc.readConfigureGlobal().seed ?? ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) | 0);
}

/** The holder and tier of each subscription a purchase made in this sequence. */
const bought = new Map<string, { holder: string; tierId: TierId }>();

/**
 * Whether the holder has a subscription of the tier at the fake that has not ended: premium refuses a second install
 * at one priority, so the sequence buys a tier for a holder only once at a time. A second one is billed at PayPal and
 * not held by design, with the operator warned (premium's 'priority' refusal); p5Events' claim 4 row covers that case,
 * and the model here would have to treat it as never held.
 */
function busy(w: P5World, who: string, tierId: TierId): boolean {
  for (const [id, made] of bought) {
    const status = w.fake.subscriptions.get(id)?.status;
    if (made.holder === who && made.tierId === tierId && status !== 'CANCELLED' && status !== 'EXPIRED') return true;
  }
  return false;
}

async function run(w: P5World, step: Step): Promise<void> {
  switch (step.t) {
    case 'buy': {
      const who = HOLDERS[step.h];
      const tierId: TierId = step.high ? TIERS.guild.high : TIERS.guild.low;
      if (busy(w, who, tierId)) return;
      const reply = await w.buyMember(who, BUYERS[step.buyer], { tierId, plan: planId(tierId, step.plan) });
      if (reply.subscriptionId) {
        tally.made += 1;
        bought.set(reply.subscriptionId, { holder: who, tierId });
      }
      return;
    }
    case 'approve': {
      const waiting = [...w.fake.subscriptions.values()].filter(s => s.status === 'APPROVAL_PENDING');
      if (waiting.length === 0) return;
      w.fake.approve(waiting[step.pick % waiting.length].id);
      tally.approved += 1;
      return;
    }
    case 'renew': {
      const active = [...w.fake.subscriptions.values()].filter(s => s.status === 'ACTIVE');
      if (active.length === 0) return;
      w.fake.renew(active[step.pick % active.length].id);
      tally.renewed += 1;
      return;
    }
    case 'deliver': {
      const out = await w.deliverNext(0);
      if (out?.status === 200) tally.delivered200 += 1;
    }
  }
}

/** A3: no PayPal id held under two holders; each held one's custom_id at the fake names that holder and that buyer. */
function brokenA3(w: P5World): string[] {
  const broken: string[] = [];
  const holders = new Map<string, string>();
  for (const { holder: key, sub } of heldPayPal(w.stored())) {
    const first = holders.get(sub.providerSubId);
    if (first !== undefined && first !== key) broken.push(`A3: ${sub.providerSubId} is held by ${first} and ${key}`);
    holders.set(sub.providerSubId, key);
    const object = w.fake.subscriptions.get(sub.providerSubId);
    if (!object) {
      broken.push(`A3: ${key} holds ${sub.providerSubId}, which the fake has no subscription of`);
      continue;
    }
    tally.checked += 1;
    const owner = ownerOfCustomId(object.custom_id);
    if (owner.holder !== key) broken.push(`A3: ${key} holds ${sub.providerSubId}, whose custom_id names ${owner.holder}`);
    if (owner.buyerId !== sub.buyerId) broken.push(`A3: ${key} holds ${sub.providerSubId} paid by ${sub.buyerId}; its custom_id names ${owner.buyerId}`);
  }
  return broken;
}

/** Runs the steps on a new world, then drains the queue in order; what broke, collected for the caller to assert on. */
async function broken(w: P5World, sequence: Step[]): Promise<string[]> {
  const found: string[] = [];
  bought.clear();
  await w.setup();
  try {
    for (const [index, step] of sequence.entries()) {
      await run(w, step);
      tally.steps += 1;
      for (const line of brokenA3(w)) found.push(`${line} after step ${index} ${JSON.stringify(step)}`);
      if (found.length > 0) return found;
    }
    for (const out of await w.drain()) if (out.status === 200) tally.delivered200 += 1;
    found.push(...brokenA3(w).map(l => `${l} after the drain`));
    for (const call of w.fake.unexpected) found.push(`a call the fake does not serve: ${call}`);
  } finally {
    await w.teardown();
  }
  return found;
}

afterEach(() => { vi.restoreAllMocks(); });

describe.each([['the JSON files', 'json' as const, 20], ['the mirror rig', 'rig' as const, 6]])('P5 claim 10, part 0, on %s: two servers bought through PayPal', (_name, backend, numRuns) => {
  const w = p5World(backend);

  it('A3 after every step and after the queue is drained in order', async () => {
    Object.assign(tally, { steps: 0, made: 0, approved: 0, renewed: 0, delivered200: 0, checked: 0 });
    const seed = runSeed();
    const lifecycle: Step[] = [
      { t: 'buy', h: 0, buyer: 0, high: false, plan: 'cheap' }, { t: 'approve', pick: 0 }, { t: 'deliver' }, { t: 'deliver' },
      { t: 'deliver' }, { t: 'renew', pick: 0 }, { t: 'deliver' }, { t: 'buy', h: 1, buyer: 1, high: true, plan: 'dear' },
      { t: 'buy', h: 0, buyer: 1, high: true, plan: 'cheap' }, { t: 'approve', pick: 1 }, { t: 'approve', pick: 0 },
    ];
    await fc.assert(fc.asyncProperty(fc.array(fc.oneof(...steps), { minLength: 6, maxLength: 30 }), async sequence => {
      expect(await broken(w, sequence), `seed ${seed}`).toEqual([]);
    }), { numRuns, seed, examples: [[lifecycle]] });
    process.stdout.write(`[p5Props] ${backend} seed ${seed}: ${JSON.stringify(tally)}\n`);
    expect({ ...tally, seed, enough: tally.made > 0 && tally.approved > 0 && tally.renewed > 0 && tally.delivered200 > 0 && tally.checked > 0 }).toMatchObject({ enough: true });
  }, 600_000);
});

// The full form of claim 10 (part 4): holders guild:<a>, guild:<b>, user:<a> and user:<b>; a server bought on the
// member route by either user, a user on the dev user route by itself, for its kind's lower or higher tier (the lower
// one queued behind a higher one); every PayPal-side action of the seam, on queued subscriptions too (renewals,
// failures and retries happen at the clock's now, which moves an hour before each step so payments have distinct
// times); a forged custom_id; the second bot's purchases; premium's cancel and "Cancel & remove now"; a delivery of any
// queued event and again of any delivered one; the clock moved on by days and the checker ticked; a new premium process
// over the stored files. After every step A3; after the queue is drained in a random order and the checker ticked: A1
// to A5.
// Sheet P5P, Q15: the steps also buy with the opt-out (one payment), set and release the fake's settings of Y7 on any
// subscription, and make PayPal refuse or not answer a cancel; a renewal, failure or retry PayPal would not bill (the
// fake's FakeRefusal) is an expected outcome. A5 holds no APPROVAL_PENDING subscription and no EXPIRED renewing one.
// A6: no sale after a landed cancel of a pay-once subscription. A7, after every setting is released, a read of each
// pay-once subscription delivered, deliveries answered 400 delivered again and the checker ticked: premium holds a
// pay-once subscription (not refused by premium) exactly when its proof is paid, it is not removed here and its end is
// after now (or it waits in the queue); held active, its end is max(keptEnd, onceEnd(T)); a proven one is cancelled or
// expired at PayPal; each later payment was reported by PL17; no pay-once subscription was activated.

const HOLDERS3 = [`guild:${IDS[0]}`, `guild:${IDS[1]}`, `user:${IDS[0]}`, `user:${IDS[1]}`];
const HOUR = 3_600_000;

type Step3 =
  | { t: 'buy'; h: number; buyer: number; high: boolean; plan: PlanKind }
  | { t: 'approve'; pick: number; first: 'now' | 'later' | 'fail' }
  | { t: 'firstSale' | 'renew' | 'retry' | 'buyerCancel' | 'suspendFailures' | 'suspendMerchant' | 'reactivate' | 'expire'; pick: number }
  | { t: 'fail'; pick: number; count: 0 | 1; moveNext: boolean }
  | { t: 'refund'; pick: number; full: boolean }
  | { t: 'changePlan'; pick: number; unsold: boolean }
  | { t: 'forge' | 'second'; h: number; buyer: number }
  | { t: 'cancel' | 'removeNow'; h: number }
  | { t: 'deliver' | 'redeliver'; pick: number }
  | { t: 'clock'; days: number }
  | { t: 'reload' }
  | { t: 'buyOnce'; h: number; buyer: number; high: boolean; plan: PlanKind }
  | { t: 'setting' | 'release'; pick: number; which: number }
  | { t: 'failCancel'; how: number };

const SETTINGS: FakeSettings[] = [
  { finalCycle: 'stays-active' }, { finalCycle: 'active-to-period-end' }, { ignoreOverride: true }, { billsDespiteOverride: true },
  { omitLastPayment: true }, { listLag: true }, { pendingSale: true }, { omitCycleExecutions: true }, { staleCycles: true },
  { lpSkew: -30 }, { emptyListIs404: true }, { listOtherIds: true }, { keepNextAfterFinal: true }, { showOverrideBy: 'none' },
  { pendingSale: true, lpWhilePending: true }, { omitLastPayment: true, omitLastPaymentOn: 'EXPIRED' }, { showOverrideBy: 'flag' }, { showOverrideBy: 'cycles' },
];
const SETTING_KEYS = [...new Set(SETTINGS.flatMap(s => Object.keys(s)))] as Array<keyof FakeSettings>;
const CANCEL_FAULTS = [{ status: 422 }, { status: 503 }, { drop: 'before' as const }];

const h3 = fc.nat({ max: HOLDERS3.length - 1 });
const who3 = fc.nat({ max: 1 });
const deliver3 = fc.record({ t: fc.constant('deliver' as const), pick });
const buy3 = fc.record({ t: fc.constant('buy' as const), h: h3, buyer: who3, high: fc.boolean(), plan: fc.constantFrom<PlanKind>('cheap', 'dear') });
const approveNow3 = fc.record({ t: fc.constant('approve' as const), pick, first: fc.constant<'now'>('now') });
const steps3: fc.Arbitrary<Step3>[] = [
  buy3, buy3, buy3,
  fc.record({ t: fc.constant('approve' as const), pick, first: fc.constantFrom<'now' | 'later' | 'fail'>('now', 'later', 'fail') }),
  approveNow3, approveNow3, approveNow3,
  fc.record({ t: fc.constantFrom<'firstSale' | 'renew' | 'retry' | 'buyerCancel' | 'suspendFailures' | 'suspendMerchant' | 'reactivate' | 'expire'>('firstSale', 'renew', 'retry', 'buyerCancel', 'suspendFailures', 'suspendMerchant', 'reactivate', 'expire'), pick }),
  fc.record({ t: fc.constant('renew' as const), pick }),
  fc.record({ t: fc.constant('fail' as const), pick, count: fc.constantFrom<0 | 1>(0, 1), moveNext: fc.boolean() }),
  fc.record({ t: fc.constant('refund' as const), pick, full: fc.boolean() }),
  fc.record({ t: fc.constant('changePlan' as const), pick, unsold: fc.boolean() }),
  fc.record({ t: fc.constantFrom<'forge' | 'second'>('forge', 'second'), h: h3, buyer: who3 }),
  fc.record({ t: fc.constantFrom<'cancel' | 'removeNow'>('cancel', 'removeNow'), h: h3 }),
  deliver3, deliver3, deliver3, deliver3,
  fc.record({ t: fc.constant('redeliver' as const), pick }),
  fc.record({ t: fc.constant('reload' as const) }),
  fc.record({ t: fc.constant('clock' as const), days: fc.constantFrom(1, 10, 32) }),
  fc.record({ t: fc.constant('buyOnce' as const), h: h3, buyer: who3, high: fc.boolean(), plan: fc.constantFrom<PlanKind>('cheap', 'dear') }),
  fc.record({ t: fc.constant('buyOnce' as const), h: h3, buyer: who3, high: fc.boolean(), plan: fc.constantFrom<PlanKind>('cheap', 'dear') }),
  fc.record({ t: fc.constantFrom<'setting' | 'release'>('setting', 'release'), pick, which: fc.nat({ max: SETTINGS.length - 1 }) }),
  fc.record({ t: fc.constant('setting' as const), pick, which: fc.nat({ max: SETTINGS.length - 1 }) }),
  fc.record({ t: fc.constant('failCancel' as const), how: fc.nat({ max: 2 }) }),
];

const tally3 = { steps: 0, made: 0, delivered200: 0, a1: 0, a2: 0, refundedEnded: 0, queued: 0, freed: 0, once: 0, onceChecked: 0, onceHeld: 0, later: 0, a6Armed: 0 };
/** The subscriptions this bot's checkout made, with their holder and tier. */
const own = new Map<string, { holder: string; tierId: TierId; once?: boolean }>();
/** The clock of each new premium process started in this sequence. */
let reloadTimes: number[] = [];
/** The model's keptEnd of each pay-once entry: the end premium set when the step that ended the higher tier resumed it. */
const keptEnds = new Map<string, string>();
/** Pay-once ids this process removed (removeNow on its entry, a full refund delivered that ended it); reset at each reload. */
const removedModel = new Set<string>();
/** A pay-once id and the clock of a fault-free delivery that read it ACTIVE with its payment proven: no sale may follow. */
const mustStop = new Map<string, number>();
/** The forged ones and the second bot's. */
const foreign = new Set<string>();

const kindOf = (holder: string): 'guild' | 'user' => (holder.startsWith('user:') ? 'user' : 'guild');
const idOf = (holder: string): string => holder.slice(holder.indexOf(':') + 1);
const tierOf3 = (holder: string, high: boolean): TierId => TIERS[kindOf(holder)][high ? 'high' : 'low'];
const buyerOf3 = (holder: string, buyer: number): string => (kindOf(holder) === 'user' ? idOf(holder) : IDS[buyer]);

/** Premium installs one subscription per tier and holder: a tier is bought again only once the earlier one is gone at both ends. */
function busy3(w: P5World, who: string, tierId: TierId): boolean {
  if (heldPayPal(w.stored()).some(h => h.holder === who && h.sub.tierId === tierId)) return true;
  for (const [id, made] of own) {
    const status = w.fake.subscriptions.get(id)?.status;
    if (made.holder === who && made.tierId === tierId && status !== 'CANCELLED' && status !== 'EXPIRED') return true;
  }
  return false;
}

function pickSub(w: P5World, n: number, ok: (s: any) => boolean): any | null {
  const all = [...w.fake.subscriptions.values()].filter(ok);
  return all.length === 0 ? null : all[n % all.length];
}

/** The pay-once ids premium held in its queue when `track` last looked. */
let lastPaused = new Set<string>();

/** Records the end premium set for each pay-once entry that left the queue since the last look (its keptEnd). */
function track(w: P5World): void {
  const held = heldPayPal(w.stored());
  for (const h of held) {
    if (h.location === 'active' && lastPaused.has(h.sub.providerSubId) && own.get(h.sub.providerSubId)?.once) keptEnds.set(h.sub.providerSubId, h.sub.endDate);
  }
  lastPaused = new Set(held.filter(h => h.location === 'paused').map(h => h.sub.providerSubId));
}

async function run3(w: P5World, step: Step3): Promise<void> {
  try {
    await runStep3(w, step);
  } catch (error) {
    if (!(error instanceof FakeRefusal)) throw error;
  }
  track(w);
}

/** The checker's tick, then the bookkeeping. */
async function tick3(w: P5World): Promise<void> {
  await w.tick();
  track(w);
}

/** Every queued event delivered through `delivered`, in the order `pick` chooses. */
async function drain3(w: P5World, pick: (length: number) => number = () => 0): Promise<Array<{ status: number }>> {
  const outs: Array<{ status: number }> = [];
  for (let guard = 0; w.fake.queue.length > 0; guard++) {
    if (guard > 1000) throw new Error('drain3: the queue does not empty');
    const index = pick(w.fake.queue.length);
    const out = await delivered(w, () => w.deliverNext(index), w.fake.queue[index]);
    if (out) outs.push(out);
  }
  return outs;
}

/** The subscription an event names; a refund event through its sale. */
function subOf(w: P5World, event: PayPalEvent | null | undefined): string | null {
  if (!event) return null;
  const resource = event.resource as any;
  if (resource?.billing_agreement_id) return String(resource.billing_agreement_id);
  if (resource?.sale_id) return String(w.fake.sales.get(String(resource.sale_id))?.billing_agreement_id ?? '') || null;
  return String(resource?.id ?? '') || null;
}
const cancelArmed = (fake: any, id: string): boolean => fake.faults.some((r: any) => r.method === 'POST' && r.times > 0 && r.match.test(`/v1/billing/subscriptions/${id}/cancel`));

/** A delivery with what A6 and the removed-ids model need around it. */
async function delivered(w: P5World, send: () => Promise<{ status: number } | null>, event: PayPalEvent | null | undefined): Promise<{ status: number } | null> {
  const id = subOf(w, event);
  const once = !!id && own.get(id)?.once === true;
  const watched = once && w.fake.subscriptions.get(id!)?.status === 'ACTIVE' && !cancelArmed(w.fake, id!);
  const out = await send();
  if (once && out?.status === 200) {
    const { proof } = onceProof(w.fake, id!, event!.event_type);
    if (watched && proof === 'paid' && !mustStop.has(id!)) mustStop.set(id!, Date.now());
    if (event!.event_type === 'PAYMENT.SALE.REFUNDED' && proof === 'refunded') removedModel.add(id!);
  }
  track(w);
  return out;
}

async function runStep3(w: P5World, step: Step3): Promise<void> {
  w.later(HOUR);
  const now = Date.now();
  const fake = w.fake;
  switch (step.t) {
    case 'buyOnce': {
      const holder = HOLDERS3[step.h];
      const tierId = tierOf3(holder, step.high);
      if (busy3(w, holder, tierId)) return;
      const buyer = buyerOf3(holder, step.buyer);
      const opts = { tierId, plan: planId(tierId, step.plan), more: { autoRenewOptOut: true } };
      const reply = kindOf(holder) === 'user' ? await w.buyOp(holder, buyer, opts) : await w.buyMember(holder, buyer, opts);
      if (reply.subscriptionId) {
        tally3.made += 1;
        tally3.once += 1;
        own.set(reply.subscriptionId, { holder, tierId, once: true });
      }
      return;
    }
    case 'setting':
    case 'release': {
      const s = pickSub(w, step.pick, x => own.get(x.id)?.once === true);
      if (!s) return;
      if (step.t === 'setting') fake.configure(s.id, SETTINGS[step.which % SETTINGS.length]);
      else fake.release(s.id, ...(Object.keys(SETTINGS[step.which % SETTINGS.length]) as Array<keyof FakeSettings>));
      return;
    }
    case 'failCancel':
      fake.fail('POST', /\/cancel$/, CANCEL_FAULTS[step.how % CANCEL_FAULTS.length]);
      return;
    case 'buy': {
      const holder = HOLDERS3[step.h];
      const tierId = tierOf3(holder, step.high);
      if (busy3(w, holder, tierId)) return;
      const buyer = buyerOf3(holder, step.buyer);
      const reply = kindOf(holder) === 'user'
        ? await w.buyDev(holder, buyer, { tierId, plan: planId(tierId, step.plan) })
        : await w.buyMember(holder, buyer, { tierId, plan: planId(tierId, step.plan) });
      if (reply.subscriptionId) {
        tally3.made += 1;
        own.set(reply.subscriptionId, { holder, tierId });
      }
      return;
    }
    case 'approve': {
      const s = pickSub(w, step.pick, x => x.status === 'APPROVAL_PENDING');
      if (s) fake.approve(s.id, { firstSale: step.first });
      return;
    }
    case 'firstSale': {
      const s = pickSub(w, step.pick, x => x.status === 'ACTIVE' && x._cycle === 0 && !x.billing_info?.last_payment && x._unpaid.length === 0);
      if (s) fake.completeFirstSale(s.id, { at: now });
      return;
    }
    case 'renew': {
      const s = pickSub(w, step.pick, x => x.status === 'ACTIVE' && x._cycle > 0);
      if (s) fake.renew(s.id, { at: now });
      return;
    }
    case 'fail': {
      const s = pickSub(w, step.pick, x => x.status === 'ACTIVE' && x._cycle > 0);
      if (s) fake.failPayment(s.id, { at: now, count: step.count, moveNext: step.moveNext });
      return;
    }
    case 'retry': {
      const s = pickSub(w, step.pick, x => (x.status === 'ACTIVE' || x.status === 'SUSPENDED') && x._unpaid.length > 0);
      if (s) fake.retrySucceeds(s.id, { at: now });
      return;
    }
    case 'buyerCancel': {
      const s = pickSub(w, step.pick, x => ['ACTIVE', 'SUSPENDED', 'APPROVAL_PENDING'].includes(x.status));
      if (s) fake.buyerCancel(s.id);
      return;
    }
    case 'suspendFailures':
    case 'suspendMerchant': {
      const s = pickSub(w, step.pick, x => x.status === 'ACTIVE');
      if (s && step.t === 'suspendFailures') fake.suspendForFailures(s.id);
      else if (s) fake.suspendNoFailure(s.id);
      return;
    }
    case 'reactivate': {
      const s = pickSub(w, step.pick, x => x.status === 'SUSPENDED');
      if (s) fake.reactivate(s.id);
      return;
    }
    case 'expire': {
      const s = pickSub(w, step.pick, x => !['CANCELLED', 'EXPIRED'].includes(x.status));
      if (s) fake.expire(s.id);
      return;
    }
    case 'refund': {
      const sales = [...fake.sales.values()].filter(x => x.state !== 'refunded');
      if (sales.length === 0) return;
      fake.refund(sales[step.pick % sales.length].id, step.full ? undefined : 100);
      return;
    }
    case 'changePlan': {
      const s = pickSub(w, step.pick, x => x.status === 'ACTIVE' && own.has(x.id));
      if (!s) return;
      const tierId = own.get(s.id)!.tierId;
      fake.changePlan(s.id, step.unsold ? EXTRA_PLANS.unlinked : s.plan_id === planId(tierId, 'cheap') ? planId(tierId, 'dear') : planId(tierId, 'cheap'));
      return;
    }
    case 'forge': {
      const holder = HOLDERS3[step.h];
      const tierId = tierOf3(holder, false);
      foreign.add(fake.forge(planId(tierId, 'cheap'), `${holder}|${buyerOf3(holder, step.buyer)}|${tierId}|o-${tierId}|AAAAAAAAAAAAAAAAAAAAAA`).id);
      return;
    }
    case 'second': {
      const holder = HOLDERS3[step.h];
      const made = await w.buySecondBot(holder, buyerOf3(holder, step.buyer), { tierId: tierOf3(holder, false) });
      if (made.subscriptionId) foreign.add(made.subscriptionId);
      return;
    }
    case 'cancel':
    case 'removeNow': {
      const active = step.t === 'removeNow'
        ? heldPayPal(w.stored()).find(h => h.holder === HOLDERS3[step.h] && h.location === 'active' && own.get(h.sub.providerSubId)?.once)
        : undefined;
      const reply = await w.op(step.t === 'cancel' ? 'cancelPaidSubscription' : 'cancelPaidSubscriptionImmediately', HOLDERS3[step.h]);
      if (active && reply.ok) removedModel.add(active.sub.providerSubId);
      return;
    }
    case 'deliver': {
      if (!fake.queue.length) return;
      const index = step.pick % fake.queue.length;
      const out = await delivered(w, () => w.deliverNext(index), fake.queue[index]);
      if (out?.status === 200) tally3.delivered200 += 1;
      return;
    }
    case 'redeliver': {
      const done = w.delivered.filter(d => d.event);
      if (done.length) {
        const event = done[step.pick % done.length].event;
        await delivered(w, () => w.deliver(event), event);
      }
      return;
    }
    case 'clock': {
      const before = heldPayPal(w.stored()).filter(h => h.location === 'active').length;
      w.later(step.days * 86_400_000);
      await w.tick();
      tally3.freed += Math.max(0, before - heldPayPal(w.stored()).filter(h => h.location === 'active').length);
      return;
    }
    case 'reload':
      reloadTimes.push(Date.now());
      removedModel.clear();
      await w.reload();
  }
}

/** A1, A2, A4 and A5, after the queue is drained and the checker ticked. */
function brokenAtRest(w: P5World): string[] {
  const broken: string[] = [];
  const held = heldPayPal(w.stored());
  const now = Date.now();
  for (const { holder, sub, location } of held) {
    if (foreign.has(sub.providerSubId)) broken.push(`A4: ${holder} holds ${sub.providerSubId}, which this bot's checkout did not make`);
    if (location === 'paused') {
      tally3.queued += 1;
      if (sub.status !== 'paused') broken.push(`A5: ${holder} holds ${sub.providerSubId} in its queue with status ${sub.status}`);
    } else if (Date.parse(sub.endDate) <= now) {
      broken.push(`A5: ${holder} holds ${sub.providerSubId} active past its end ${sub.endDate} after the checker ticked`);
    }
    const object = w.fake.subscriptions.get(sub.providerSubId);
    if (!object) continue;
    const once = own.get(object.id)?.once === true;
    if (object.status === 'APPROVAL_PENDING' || (object.status === 'EXPIRED' && !once)) broken.push(`A5: ${holder} holds ${sub.providerSubId} (${location}), which PayPal reports ${object.status}`);
    if (once) continue;
    const latest = w.fake.latestSale(object.id);
    if (latest?.state === 'refunded') broken.push(`A5: ${holder} holds ${sub.providerSubId} (${location}), whose latest sale ${latest.id} was refunded in full`);
    if (location === 'active' && object.status === 'CANCELLED') {
      tally3.a2 += 1;
      const model = z5End(w.fake, object.id, sub);
      if (model.end === null || now >= model.end) broken.push(`A2: ${holder} holds cancelled ${sub.providerSubId} active at ${new Date(now).toISOString()}, past the model's end`);
      if (sub.autoRenew !== false) broken.push(`A2: ${holder} holds cancelled ${sub.providerSubId} with auto-renew on`);
    }
  }
  for (const object of w.fake.subscriptions.values()) {
    const made = own.get(object.id);
    if (!made || made.once) continue;
    const latest = w.fake.latestSale(object.id);
    if (latest?.state === 'refunded') {
      tally3.refundedEnded += 1;
      if (!['CANCELLED', 'EXPIRED'].includes(object.status)) broken.push(`A5: ${object.id}'s latest sale was refunded in full and PayPal reports it ${object.status}`);
      continue;
    }
    const entry = held.find(h => h.sub.providerSubId === object.id && h.location === 'active');
    if (!entry || !z5End(w.fake, object.id).live || ![planId(made.tierId, 'cheap'), planId(made.tierId, 'dear')].includes(object.plan_id)) continue;
    tally3.a1 += 1;
    const expected = z5End(w.fake, object.id, entry.sub);
    if (Date.parse(entry.sub.endDate) !== expected.end) broken.push(`A1: ${object.id} ends ${entry.sub.endDate}; the model says ${new Date(expected.end!).toISOString()}`);
    if ((entry.sub.providerMeta?.paymentFailing === true) !== expected.windowApplies) broken.push(`A1: ${object.id} has paymentFailing ${String(entry.sub.providerMeta?.paymentFailing)}; the window ${expected.windowApplies ? 'applies' : 'does not apply'}`);
  }
  return broken;
}

let readCount = 0;
const readEvent = (id: string): PayPalEvent => ({ id: `WH-P5P-PROPS-${readCount++}`, event_version: '1.0', create_time: new Date().toISOString(), resource_type: 'subscription', resource_version: '2.0', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', summary: 'read', resource: { id }, links: [] });

/** Every setting released, a read of each pay-once subscription delivered, and deliveries answered 400 delivered again (five rounds at most); the events of paid pay-once subscriptions still answered 400. */
async function settleOnce(w: P5World): Promise<string[]> {
  for (const id of w.fake.subscriptions.keys()) w.fake.release(id, ...SETTING_KEYS);
  w.fake.clearFaults();
  for (const [id, made] of own) if (made.once) await delivered(w, () => w.deliver(readEvent(id)), readEvent(id));
  for (let round = 0; round < 5; round++) {
    await drain3(w);
    await w.settle();
    track(w);
    const failing = new Map<string, PayPalEvent>();
    for (const d of w.delivered) {
      if (!d.event) continue;
      if (d.status === 400) failing.set(d.event.id, d.event);
      else failing.delete(d.event.id);
    }
    if (failing.size === 0) return [];
    for (const event of failing.values()) await delivered(w, () => w.deliver(event), event);
  }
  const left = new Map<string, PayPalEvent>();
  for (const d of w.delivered) {
    if (!d.event) continue;
    if (d.status === 400) left.set(d.event.id, d.event);
    else left.delete(d.event.id);
  }
  // Y8.8: a pay-once subscription with no sale at all is answered 400 (can't confirm its payment) until PayPal stops resending.
  const accepted = (id: string | null): boolean => !!id && own.get(id)?.once === true && w.fake.salesOf(id).length === 0;
  return [...left.values()].filter(e => !accepted(subOf(w, e))).map(e => `${e.event_type} ${subOf(w, e) ?? e.id}`);
}

/** A6 and A7 for the pay-once subscriptions, after settleOnce and the checker. */
function brokenOnce(w: P5World): string[] {
  const broken: string[] = [];
  const held = heldPayPal(w.stored());
  const removed = removedModel;
  const now = Date.now();
  // The mirror rig keeps the log lines it captures itself.
  const lines = [...w.logs, ...(w.rig?.m.state.lines ?? [])];
  for (const [id, made] of own) {
    if (!made.once) continue;
    const object = w.fake.subscriptions.get(id);
    if (!object) continue;
    tally3.onceChecked += 1;
    const stopAt = mustStop.get(id);
    if (stopAt !== undefined) {
      tally3.a6Armed += 1;
      for (const sale of w.fake.salesOf(id)) if (Date.parse(sale.create_time) > stopAt) broken.push(`A6: ${id} took sale ${sale.id} after a fault-free delivery at ${new Date(stopAt).toISOString()} read it ACTIVE and paid`);
    }
    if (w.fake.callsOf('POST', new RegExp(`^/v1/billing/subscriptions/${id}/activate$`)).length > 0) broken.push(`A7: pay-once ${id} was activated`);
    if (object.status === 'APPROVAL_PENDING') continue;
    const { proof } = onceProof(w.fake, id, 'BILLING.SUBSCRIPTION.UPDATED');
    const entry = held.find(h => h.sub.providerSubId === id) ?? null;
    const refused = lines.some(l => l.includes(`subscription.created from PayPal (subscription ${id},`) && l.includes('was not installed'));
    if (!refused) {
      const end = proof === 'paid' ? onceEnd(w.fake, id, keptEnds.get(id)) : null;
      const expected = proof === 'paid' && !removed.has(id) && end !== null && (entry?.location === 'paused' || end > now);
      if (!!entry !== expected) broken.push(`A7: ${id} is ${entry ? `held (${entry.location})` : 'not held'}; proof ${proof}, end ${end === null ? 'none' : new Date(end).toISOString()}, removed here ${removed.has(id)}`);
      if (entry?.location === 'active' && end !== null && Date.parse(entry.sub.endDate) !== end) broken.push(`A7: ${id} ends ${entry.sub.endDate}; the model says ${new Date(end).toISOString()}`);
      if (entry) tally3.onceHeld += 1;
    }
    if ((proof === 'paid' || proof === 'refunded') && !['CANCELLED', 'EXPIRED'].includes(object.status)) broken.push(`A7: ${id}'s payment is ${proof} and PayPal still reports it ${object.status}`);
    if (proof === 'paid') {
      for (const sale of laterPayments(w.fake, id)) {
        const reported = lines.filter(l => l.includes(`PayPal took another payment (sale ${sale},`)).length;
        tally3.later += 1;
        const at = Date.parse(w.fake.salesOf(id).find(x => x.id === sale)?.create_time ?? '');
        const processes = 1 + reloadTimes.filter(r => r >= at).length;
        if (reported < 1 || reported > processes) broken.push(`A7: ${id}'s later payment ${sale} was reported ${reported} times over ${processes} processes`);
      }
    }
  }
  return broken;
}

async function broken3(w: P5World, sequence: Step3[], order: number[]): Promise<string[]> {
  const found: string[] = [];
  own.clear();
  foreign.clear();
  reloadTimes = [];
  lastPaused = new Set();
  keptEnds.clear();
  removedModel.clear();
  mustStop.clear();
  await w.setup({ clock: Date.UTC(2027, 0, 31, 12) });
  // A plan change to a plan the offering does not sell makes premium log its 'variant' line (L3) by design.
  allowDropLines('L3');
  try {
    for (const [index, step] of sequence.entries()) {
      await run3(w, step);
      tally3.steps += 1;
      for (const line of brokenA3(w)) found.push(`${line} after step ${index} ${JSON.stringify(step)}`);
      if (found.length > 0) return found;
    }
    let turn = 0;
    for (const out of await drain3(w, length => order[turn++ % order.length] % length)) if (out.status === 200) tally3.delivered200 += 1;
    await w.settle();
    track(w);
    await drain3(w);
    await tick3(w);
    const left = await settleOnce(w);
    await tick3(w);
    for (const e of left) found.push(`settleOnce: ${e} still answered 400 after five rounds`);
    found.push(...brokenA3(w).map(l => `${l} after the drain`));
    found.push(...brokenAtRest(w).map(l => `${l} after the drain`));
    found.push(...brokenOnce(w).map(l => `${l} after the settings were released`));
    for (const call of w.fake.unexpected) found.push(`a call the fake does not serve: ${call}`);
  } finally {
    await w.teardown();
  }
  return found;
}

describe.each([['the JSON files', 'json' as const, 19], ['the mirror rig', 'rig' as const, 8]])('P5 claim 10, the full form, on %s: servers and users through PayPal', (_name, backend, numRuns) => {
  const w = p5World(backend);

  it('A3 after every step; A1 to A5 after the queue is drained in a random order and the checker ticked', async () => {
    Object.assign(tally3, { steps: 0, made: 0, delivered200: 0, a1: 0, a2: 0, refundedEnded: 0, queued: 0, freed: 0, once: 0, onceChecked: 0, onceHeld: 0, later: 0, a6Armed: 0 });
    const seed = runSeed();
    const lifecycle: Step3[] = [
      { t: 'buy', h: 0, buyer: 0, high: true, plan: 'cheap' }, { t: 'buy', h: 2, buyer: 0, high: false, plan: 'dear' },
      { t: 'approve', pick: 0, first: 'now' }, { t: 'approve', pick: 0, first: 'now' }, { t: 'deliver', pick: 0 }, { t: 'deliver', pick: 0 },
      { t: 'deliver', pick: 0 }, { t: 'deliver', pick: 0 }, { t: 'deliver', pick: 0 }, { t: 'deliver', pick: 0 },
      { t: 'buy', h: 0, buyer: 1, high: false, plan: 'cheap' }, { t: 'approve', pick: 0, first: 'now' },
      { t: 'fail', pick: 0, count: 0, moveNext: false }, { t: 'renew', pick: 1 }, { t: 'refund', pick: 0, full: true },
      { t: 'forge', h: 1, buyer: 0 }, { t: 'second', h: 3, buyer: 1 }, { t: 'cancel', h: 2 }, { t: 'reload' },
      { t: 'refund', pick: 2, full: true }, { t: 'expire', pick: 1 }, { t: 'clock', days: 32 }, { t: 'deliver', pick: 0 },
    ];
    const cancelled: Step3[] = [...lifecycle.slice(0, 12), { t: 'buyerCancel', pick: 0 }, { t: 'clock', days: 1 }, { t: 'deliver', pick: 0 }];
    const paidOnce: Step3[] = [
      { t: 'buyOnce', h: 0, buyer: 0, high: true, plan: 'cheap' }, { t: 'setting', pick: 0, which: 2 }, { t: 'approve', pick: 0, first: 'now' },
      { t: 'clock', days: 10 }, { t: 'renew', pick: 0 }, { t: 'failCancel', how: 1 }, { t: 'deliver', pick: 0 }, { t: 'deliver', pick: 0 },
      { t: 'deliver', pick: 0 }, { t: 'deliver', pick: 0 }, { t: 'deliver', pick: 0 }, { t: 'buyOnce', h: 2, buyer: 0, high: false, plan: 'cheap' },
      { t: 'approve', pick: 0, first: 'now' }, { t: 'deliver', pick: 0 }, { t: 'removeNow', h: 2 }, { t: 'reload' }, { t: 'deliver', pick: 0 },
    ];
    // A6: a pay-once subscription PayPal keeps billing (ignoreOverride), read ACTIVE and paid by a fault-free delivery, then renewed.
    const a6Once: Step3[] = [
      { t: 'buyOnce', h: 0, buyer: 0, high: true, plan: 'cheap' }, { t: 'setting', pick: 0, which: 2 }, { t: 'approve', pick: 0, first: 'now' },
      { t: 'deliver', pick: 0 }, { t: 'deliver', pick: 0 }, { t: 'deliver', pick: 0 }, { t: 'clock', days: 32 }, { t: 'renew', pick: 0 }, { t: 'deliver', pick: 0 },
    ];
    // A pay-once subscription whose only sale is refunded in full: its refund event resolves through sale_id in settleOnce.
    const refundOnce: Step3[] = [
      { t: 'buyOnce', h: 0, buyer: 0, high: true, plan: 'cheap' }, { t: 'approve', pick: 0, first: 'now' }, { t: 'deliver', pick: 0 },
      { t: 'deliver', pick: 0 }, { t: 'deliver', pick: 0 }, { t: 'refund', pick: 0, full: true }, { t: 'deliver', pick: 0 },
    ];
    await fc.assert(fc.asyncProperty(
      fc.array(fc.oneof(...steps3), { minLength: 12, maxLength: 40, size: 'max' }),
      fc.array(fc.nat({ max: 50 }), { minLength: 1, maxLength: 8 }),
      async (sequence, order) => {
        expect(await broken3(w, sequence, order), `seed ${seed}`).toEqual([]);
      },
    ), { numRuns, seed, examples: [[lifecycle, [0]], [lifecycle, [3, 1, 4]], [cancelled, [0]], [paidOnce, [0]], [paidOnce, [2, 7]], [a6Once, [0]], [refundOnce, [0]]] });
    process.stdout.write(`[p5Props] full ${backend} seed ${seed}: ${JSON.stringify(tally3)}\n`);
    expect({ ...tally3, seed, enough: tally3.made > 0 && tally3.delivered200 > 0 && tally3.a1 > 0 && tally3.a2 > 0 && tally3.freed > 0 && tally3.onceHeld > 0 && tally3.later > 0 && tally3.a6Armed > 0 }).toMatchObject({ enough: true });
  }, 900_000);
});
