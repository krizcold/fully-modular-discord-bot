import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

// P3 claim 7, part 4's form: Stripe and premium agree per holder. The real StripeProvider and the real PremiumManager
// in the bot role, over the JSON files and over the mirror rig (fewer runs), with the fake of helpers/p3Stripe.ts as
// Stripe. Holders guild:<a>, user:<a>, user:<b> and guild:<b>: a server bought by user a or user b on the member route,
// signed in as that buyer; a user bought by itself on the dev user route. Random sequences of:
// a purchase of a monthly subscription or a one-time purchase (only for a holder with no live Stripe purchase and no
// open session, so no stacking), the buyer completing an open checkout paid or with a delayed payment, the delayed
// payment succeeding or failing, Stripe-side renewals, portal cancels and renewals, ends, failed payments and plan
// switches, refunds in full or in part of any charge, premium's cancel at period end, renew again and end now through
// ops (end now only for a subscription, as the sheet's generator has none for a one-time purchase), the delivery of
// any queued event (again right after, when drawn), the delivery again of any event delivered before, and a new
// premium process on the stored files. After every step A3 and A6 hold; after the queue is drained in a random order,
// A1 to A6 hold:
// A1, every subscription at the fake that is not canceled, whose checkout was paid and whose latest charge is not
// refunded in full is held by premium under its metadata's holder, once, with status, end and auto-renew equal to the
// mapping of its current object;
// A2, no subscription canceled at the fake is held;
// A3, no Stripe id is held under two holders, and every held one names that holder and that buyer in the fake's
// metadata;
// A4, one subscription.install.paid audit line per Stripe id premium ever held;
// A5, over the member-route purchases: the fake holds one Customer per member buyer, the one the doc maps the buyer to,
// and every member-route purchase's Customer is its buyer's; a dev-route purchase's Customer is in no doc entry;
// A6, no one-time purchase whose charge is refunded in full is held by premium.
// No call reaches an address the fake does not serve. A failure prints its seed; SMDB_TEST_SEED replays it.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  const store = { getCachedModules: () => [], getRepositories: () => [], getInstalledModules: () => [], getAvailableModules: async () => [] };
  return { ...real, getAppStoreManager: () => store };
});

import { mappedState, ownerOfMetadata, type StripeEvent } from '../helpers/p3Stripe';
import { heldStripe, IDS, p3World, UNLINKED_PRICE, type P3World } from '../helpers/p3World';

const HOLDERS = [`guild:${IDS[0]}`, `user:${IDS[0]}`, `user:${IDS[1]}`, `guild:${IDS[1]}`];
const BUYERS = IDS;

type StripeAction = 'renew' | 'portalCancel' | 'portalRenew' | 'end' | 'failPayment' | 'switchPrice';
type Step =
  | { t: 'buy'; h: number; buyer: number; once: boolean }
  | { t: 'complete'; pick: number; paid: boolean }
  | { t: 'async'; pick: number; ok: boolean }
  | { t: 'stripe'; action: StripeAction; pick: number }
  | { t: 'refund'; pick: number; full: boolean }
  | { t: 'premium'; action: 'cancel' | 'renew' | 'endNow'; h: number }
  | { t: 'deliver'; pick: number; repeat: boolean }
  | { t: 'again'; pick: number }
  | { t: 'restart' };

const holder = fc.nat({ max: HOLDERS.length - 1 });
const pick = fc.nat({ max: 15 });
const buy = fc.record({ t: fc.constant('buy' as const), h: holder, buyer: fc.nat({ max: BUYERS.length - 1 }), once: fc.boolean() });
const complete = fc.record({ t: fc.constant('complete' as const), pick, paid: fc.boolean() });
const stripe = fc.record({ t: fc.constant('stripe' as const), action: fc.constantFrom<StripeAction>('renew', 'portalCancel', 'portalRenew', 'end', 'failPayment', 'switchPrice'), pick });
const deliver = fc.record({ t: fc.constant('deliver' as const), pick, repeat: fc.boolean() });
const steps: fc.Arbitrary<Step>[] = [
  buy, buy, complete, complete, stripe, stripe,
  fc.record({ t: fc.constant('async' as const), pick, ok: fc.boolean() }),
  fc.record({ t: fc.constant('refund' as const), pick, full: fc.boolean() }),
  fc.record({ t: fc.constant('premium' as const), action: fc.constantFrom('cancel' as const, 'renew' as const, 'endNow' as const), h: holder }),
  deliver, deliver, deliver,
  fc.record({ t: fc.constant('again' as const), pick }),
  fc.record({ t: fc.constant('restart' as const) }),
];

/**
 * Across a describe's runs: steps run, purchases that made a session, installs seen, deliveries answered 200, A1
 * comparisons, A5's member and dev sessions, one-time purchases held, refunds made, deliveries out of queue order.
 */
const tally = { steps: 0, sessions: 0, held: 0, delivered200: 0, compared: 0, member: 0, dev: 0, onceHeld: 0, refunds: 0, outOfOrder: 0 };

/** The sessions of one sequence by route. */
const routes = { member: new Set<string>(), dev: new Set<string>() };

function runSeed(): number {
  return fc.readConfigureGlobal().seed ?? ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) | 0);
}

/** The holder a Stripe subscription's or session's metadata names. */
const holderAtStripe = (object: any): string | null => ownerOfMetadata(object?.metadata).holder;

/**
 * Whether a holder has a live Stripe purchase or an open session at the fake: a subscription that has not ended, or a
 * completed one-time checkout whose charge is not refunded in full.
 */
function busy(w: P3World, who: string): boolean {
  for (const sub of w.fake.subscriptions.values()) if (!['canceled', 'incomplete_expired'].includes(sub.status) && holderAtStripe(sub) === who) return true;
  return [...w.fake.sessions.values()].some(s => holderAtStripe(s) === who
    && (s.status === 'open' || (s.mode === 'payment' && w.fake.latestCharge(s.id)?.refunded !== true)));
}

/** Every event delivered in this sequence, for the steps that deliver one again. */
const deliveredEvents: StripeEvent[] = [];
/** The sessions whose delayed payment failed in this sequence. */
const failed = new Set<string>();

/** A6: no one-time purchase whose charge is refunded in full is held. */
function brokenA6(w: P3World): string[] {
  const broken: string[] = [];
  for (const { holder: key, sub } of heldStripe(w.stored())) {
    if (!String(sub.providerSubId).startsWith('cs_')) continue;
    const charge = w.fake.latestCharge(sub.providerSubId);
    // Between steps, a refund whose charge.refunded event is still queued has not reached the bot yet.
    if (w.fake.queue.some(e => e.type === 'charge.refunded' && e.data.object.id === charge?.id)) continue;
    if (charge?.refunded === true) broken.push(`A6: ${key} holds the one-time purchase ${sub.providerSubId}, whose charge is refunded in full`);
  }
  return broken;
}

async function deliverOne(w: P3World, event: StripeEvent): Promise<void> {
  const out = await w.deliver(event);
  if (out.status === 200) tally.delivered200 += 1;
  deliveredEvents.push(event);
}

async function run(w: P3World, step: Step): Promise<void> {
  switch (step.t) {
    case 'buy': {
      const who = HOLDERS[step.h];
      if (busy(w, who)) return;
      const user = who.startsWith('user:');
      const kind = step.once ? 'once' : 'monthly';
      const reply = user ? await w.buyDev(who, who.slice('user:'.length), kind) : await w.buyMember(who, BUYERS[step.buyer], kind);
      if (reply.sessionId) {
        tally.sessions += 1;
        (user ? routes.dev : routes.member).add(reply.sessionId);
      }
      return;
    }
    case 'complete': {
      const open = w.fake.openSessions();
      if (open.length > 0) w.fake.complete(open[step.pick % open.length].id, { paid: step.paid });
      return;
    }
    case 'async': {
      const waiting = [...w.fake.sessions.values()].filter(s => s.status === 'complete' && s.payment_status === 'unpaid' && !failed.has(s.id));
      if (waiting.length === 0) return;
      const id = waiting[step.pick % waiting.length].id;
      if (step.ok) w.fake.asyncPaid(id);
      else {
        w.fake.asyncFailed(id);
        failed.add(id);
      }
      return;
    }
    case 'stripe': {
      const live = [...w.fake.subscriptions.values()].filter(s => !['canceled', 'incomplete', 'incomplete_expired'].includes(s.status));
      if (live.length === 0) return;
      const id = live[step.pick % live.length].id;
      if (step.action === 'switchPrice') w.fake.switchPrice(id, UNLINKED_PRICE);
      else w.fake[step.action](id);
      return;
    }
    case 'refund': {
      const charges = [...w.fake.charges.values()].filter(c => c.amount_refunded < c.amount);
      if (charges.length === 0) return;
      const charge = charges[step.pick % charges.length];
      w.fake.refund(charge.id, step.full ? undefined : Math.max(1, Math.floor((charge.amount - charge.amount_refunded) / 2)));
      tally.refunds += 1;
      return;
    }
    case 'premium': {
      const who = HOLDERS[step.h];
      const active = w.stored()?.subscriptions?.[who]?.active;
      if (step.action === 'endNow' && typeof active?.providerSubId === 'string' && active.providerSubId.startsWith('cs_')) return;
      const name = { cancel: 'cancelPaidSubscription', renew: 'reactivatePaidSubscription', endNow: 'cancelPaidSubscriptionImmediately' }[step.action];
      await w.op(name, who);
      return;
    }
    case 'deliver': {
      if (w.fake.queue.length === 0) return;
      const index = step.pick % w.fake.queue.length;
      if (index > 0) tally.outOfOrder += 1;
      const event = w.fake.dequeue(index)!;
      await deliverOne(w, event);
      if (step.repeat) await deliverOne(w, event);
      return;
    }
    case 'again': {
      if (deliveredEvents.length === 0) return;
      await deliverOne(w, deliveredEvents[step.pick % deliveredEvents.length]);
      return;
    }
    case 'restart':
      await w.reload();
  }
}

/** A3: no Stripe id held under two holders; each held one names that holder and that buyer at the fake. */
function brokenA3(w: P3World): string[] {
  const broken: string[] = [];
  const holders = new Map<string, string>();
  for (const { holder: key, sub } of heldStripe(w.stored())) {
    const first = holders.get(sub.providerSubId);
    if (first !== undefined && first !== key) broken.push(`A3: ${sub.providerSubId} is held by ${first} and ${key}`);
    holders.set(sub.providerSubId, key);
    const object = w.fake.subscriptions.get(sub.providerSubId) ?? w.fake.sessions.get(sub.providerSubId);
    if (!object) {
      broken.push(`A3: ${key} holds ${sub.providerSubId}, which the fake has no object of`);
      continue;
    }
    const owner = ownerOfMetadata(object.metadata);
    if (owner.holder !== key) broken.push(`A3: ${key} holds ${sub.providerSubId}, whose metadata names ${owner.holder}`);
    if (owner.buyerId !== sub.buyerId) broken.push(`A3: ${key} holds ${sub.providerSubId} paid by ${sub.buyerId}; its metadata names ${owner.buyerId}`);
  }
  return broken;
}

/**
 * A1, A2 and A4 after the drain. `ever` maps each premium subscription id seen held after a step to its Stripe id; a
 * subscription premium installed and dropped inside one delivery (a completed checkout read after its subscription
 * ended, at this tree) is named by the world's record of that delivery's created event.
 */
function brokenAfterDrain(w: P3World, ever: Map<string, string>): string[] {
  const broken: string[] = [];
  const held = heldStripe(w.stored());
  for (const sub of w.fake.subscriptions.values()) {
    const session = [...w.fake.sessions.values()].find(s => s.subscription === sub.id);
    if (sub.status === 'canceled' || session?.payment_status !== 'paid' || w.fake.latestCharge(sub.id)?.refunded === true) continue;
    const owner = holderAtStripe(sub);
    const holding = held.filter(h => h.sub.providerSubId === sub.id);
    if (holding.length !== 1 || holding[0].holder !== owner) {
      broken.push(`A1: ${sub.id} of ${owner} is held ${holding.length} time(s)${holding.length ? ` under ${holding.map(h => h.holder).join(', ')}` : ''}`);
      continue;
    }
    tally.compared += 1;
    const want = mappedState(sub);
    const got = holding[0].sub;
    const status = got.status === 'paused' ? 'paused' : got.status;
    if (status !== want.status || got.endDate !== want.endDate || got.autoRenew !== want.autoRenew) {
      broken.push(`A1: ${sub.id} is ${JSON.stringify(want)} at the fake and ${JSON.stringify({ status, endDate: got.endDate, autoRenew: got.autoRenew })} in premium`);
    }
  }
  for (const { holder: key, sub } of held) {
    if (w.fake.subscriptions.get(sub.providerSubId)?.status === 'canceled') broken.push(`A2: ${key} holds ${sub.providerSubId}, canceled at the fake`);
  }
  const installs = new Map<string, number>();
  for (const line of w.auditLines()) {
    if (line.action !== 'subscription.install.paid') continue;
    const stripeId = w.installs.get(line.subscriptionId) ?? ever.get(line.subscriptionId);
    if (stripeId === undefined) {
      broken.push(`A4: the install line of ${line.subscriptionId} came from no delivery and names no subscription premium was seen holding`);
      continue;
    }
    installs.set(stripeId, (installs.get(stripeId) ?? 0) + 1);
  }
  for (const stripeId of new Set([...ever.values(), ...w.installs.values()])) {
    const count = installs.get(stripeId) ?? 0;
    if (count !== 1) broken.push(`A4: ${stripeId} has ${count} install lines`);
  }
  return broken;
}

/** A5 over the sessions each route made, against the doc as stored. */
function brokenA5(w: P3World): string[] {
  const broken: string[] = [];
  const text = w.customersText();
  const doc: Record<string, any> = text === null ? {} : JSON.parse(text).customers;
  const mapped = new Set(Object.values(doc).map(e => e.customerId).filter(Boolean));
  const buyers = new Set<string>();
  for (const id of routes.member) {
    const session = w.fake.sessions.get(id)!;
    const buyer = session.metadata.buyerId;
    buyers.add(buyer);
    tally.member += 1;
    if (!session.customer || doc[buyer]?.customerId !== session.customer) broken.push(`A5: member session ${id} of ${buyer} names ${session.customer}; the doc maps ${buyer} to ${doc[buyer]?.customerId}`);
  }
  for (const buyer of buyers) {
    const theirs = [...w.fake.customers.values()].filter(c => c.metadata?.discordUserId === buyer);
    if (theirs.length !== 1 || theirs[0].id !== doc[buyer]?.customerId) broken.push(`A5: the fake holds ${theirs.length} Customer(s) of ${buyer}; the doc maps it to ${doc[buyer]?.customerId}`);
  }
  for (const id of routes.dev) {
    const customer = w.fake.sessions.get(id)?.customer;
    if (!customer) continue;
    tally.dev += 1;
    if (mapped.has(customer)) broken.push(`A5: dev session ${id}'s Customer ${customer} is in the doc`);
  }
  return broken;
}

/** Runs the steps on a new world, then drains the queue; what broke, collected for the caller to assert on. */
async function broken(w: P3World, sequence: Step[], order: number[]): Promise<string[]> {
  const found: string[] = [];
  const ever = new Map<string, string>();
  routes.member.clear();
  routes.dev.clear();
  deliveredEvents.length = 0;
  failed.clear();
  const observe = (): void => {
    for (const { sub } of heldStripe(w.stored())) {
      if (!ever.has(sub.id) && String(sub.providerSubId).startsWith('cs_')) tally.onceHeld += 1;
      ever.set(sub.id, sub.providerSubId);
    }
  };
  await w.setup();
  try {
    for (const [index, step] of sequence.entries()) {
      await run(w, step);
      tally.steps += 1;
      observe();
      for (const line of [...brokenA3(w), ...brokenA6(w)]) found.push(`${line} after step ${index} ${JSON.stringify(step)}`);
      if (found.length > 0) return found;
    }
    let turn = 0;
    await w.drain(length => order[turn++ % order.length] % length);
    observe();
    tally.held += ever.size;
    found.push(...brokenA3(w).map(l => `${l} after the drain`), ...brokenAfterDrain(w, ever).map(l => `${l} after the drain`), ...brokenA5(w).map(l => `${l} after the drain`), ...brokenA6(w).map(l => `${l} after the drain`));
    for (const call of w.fake.unexpected) found.push(`a call the fake does not serve: ${call}`);
  } finally {
    await w.teardown();
  }
  return found;
}

afterEach(() => { vi.restoreAllMocks(); });

describe.each([['the JSON files', 'json' as const, 20], ['the mirror rig', 'rig' as const, 6]])('P3 claim 7, part 4, on %s: two servers and two users bought through Stripe', (_name, backend, numRuns) => {
  const w = p3World(backend);

  it('A3 and A6 after every step, and A1 to A6 after the queue is drained in a random order', async () => {
    for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
    Object.assign(tally, { steps: 0, sessions: 0, held: 0, delivered200: 0, compared: 0, member: 0, dev: 0, onceHeld: 0, refunds: 0, outOfOrder: 0 });
    const seed = runSeed();
    const lifecycle: Step[] = [
      { t: 'buy', h: 0, buyer: 0, once: false }, { t: 'complete', pick: 0, paid: true }, { t: 'deliver', pick: 0, repeat: false },
      { t: 'deliver', pick: 0, repeat: false }, { t: 'deliver', pick: 0, repeat: true }, { t: 'stripe', action: 'renew', pick: 0 },
      { t: 'premium', action: 'cancel', h: 0 }, { t: 'restart' }, { t: 'premium', action: 'renew', h: 0 },
      { t: 'buy', h: 1, buyer: 0, once: true }, { t: 'complete', pick: 0, paid: true }, { t: 'premium', action: 'endNow', h: 0 },
      { t: 'refund', pick: 0, full: true }, { t: 'buy', h: 3, buyer: 0, once: false }, { t: 'complete', pick: 0, paid: false },
      { t: 'deliver', pick: 3, repeat: false }, { t: 'async', pick: 0, ok: true }, { t: 'again', pick: 1 },
    ];
    const order = fc.array(fc.nat({ max: 15 }), { minLength: 1, maxLength: 8 });
    await fc.assert(fc.asyncProperty(fc.array(fc.oneof(...steps), { minLength: 8, maxLength: 40 }), order, async (sequence, drainOrder) => {
      expect(await broken(w, sequence, drainOrder), `seed ${seed}`).toEqual([]);
    }), { numRuns, seed, examples: [[lifecycle, [0]], [lifecycle, [5, 2, 0, 7]]] });
    process.stdout.write(`[p3Props] ${backend} seed ${seed}: ${JSON.stringify(tally)}
`);
    expect({ ...tally, seed, enough: tally.sessions > 0 && tally.held > 0 && tally.delivered200 > 0 && tally.compared > 0 && tally.member > 0 && tally.dev > 0 && tally.onceHeld > 0 && tally.refunds > 0 && tally.outOfOrder > 0 }).toMatchObject({ enough: true });
  }, 600_000);
});
