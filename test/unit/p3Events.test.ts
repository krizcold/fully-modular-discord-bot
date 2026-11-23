import fs from 'fs';
import http from 'http';
import path from 'path';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P3 claims 4, 5, 6, 15, 16 and the end-to-end row of 17 (sheet P3, part 4): the Stripe webhook reads every object
// again from Stripe's API and uses only the event's id, type and object id; read failures are sorted into transient
// (400, SW2, Stripe sends the event again) and permanent (200, SL9); the event table for a server and a user; repeats
// are safe; objects whose metadata names no holder are not acted on (SL1); a price changed at Stripe keeps the tier
// (SL3); deliveries about one subscription are applied one at a time. The real StripeProvider and PremiumManager over
// the JSON files with the fake of helpers/p3Stripe.ts as Stripe; deliveries run as payment.webhook, or through the web
// UI's route where a row needs the deliveries record.

vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }) }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  const store = { getCachedModules: () => [], getRepositories: () => [], getInstalledModules: () => [], getAvailableModules: async () => [] };
  return { ...real, getAppStoreManager: () => store };
});

import { dataPath } from '../../src/utils/dataRoot';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { mappedState, postWebhook, STRIPE_BASE, type StripeEvent } from '../helpers/p3Stripe';
import { heldStripe, IDS, p3World, UNLINKED_PRICE, type PriceKind } from '../helpers/p3World';

const w = p3World('json');
let logs: string[] = [];
let server: http.Server | null = null;
let base = '';

interface Kind { name: string; holder: string; buyer: string; other: string }
const SERVER: Kind = { name: 'a server', holder: `guild:${IDS[0]}`, buyer: IDS[1], other: `guild:${IDS[1]}` };
const USER: Kind = { name: 'a user', holder: `user:${IDS[0]}`, buyer: IDS[0], other: `user:${IDS[1]}` };
const words = (holder: string): string => holder.replace(':', ' ');

beforeEach(async () => {
  logs = [];
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  }
  await w.setup();
  (await import('../../src/webui/webhookDeliveries'))._resetWebhookDeliveries();
});

afterEach(async () => {
  const unexpected = [...w.fake.unexpected];
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
  await w.teardown();
  vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
});

/** The web UI's route over this world's ops (the route rig of p3Signature.test.ts). */
async function route(): Promise<(body: string, signature: string) => Promise<{ status: number; body: any }>> {
  if (!server) {
    const { createServer } = await import('../../src/webui/server');
    const manager: any = { postAccessLog: () => undefined, getStatus: () => ({}), runSharedOp: (op: string, args: unknown) => w.sharedOp(op, args) };
    server = http.createServer(await createServer(manager));
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  return (body, signature) => postWebhook(base, 'stripe', body, signature);
}

const recorded = async (event: StripeEvent): Promise<boolean> => (await import('../../src/webui/webhookDeliveries')).webhookDeliveryAnswered('stripe', event.id);

/** A purchase on the route each kind is sold on: a server on the member route, a user on the dev user route. */
async function buy(k: Kind, kind: PriceKind = 'monthly'): Promise<string> {
  const bought = k.holder.startsWith('guild:') ? await w.buyMember(k.holder, k.buyer, kind) : await w.buyDev(k.holder, k.buyer, kind);
  expect(bought.status).toBe(200);
  return bought.sessionId!;
}

/** A purchase completed paid and every queued event delivered: the session and, for a subscription, its id. */
async function installed(k: Kind, kind: PriceKind = 'monthly'): Promise<{ sessionId: string; subId: string }> {
  const sessionId = await buy(k, kind);
  const session = w.fake.complete(sessionId, { paid: true });
  await w.drain();
  return { sessionId, subId: session.subscription ?? sessionId };
}

const held = (holder: string) => heldStripe(w.stored()).filter(h => h.holder === holder);
/** The one queued event of a type, taken out of the queue undelivered. */
function take(type: string): StripeEvent {
  const index = w.fake.queue.findIndex(e => e.type === type);
  expect(index, `a queued ${type}`).toBeGreaterThanOrEqual(0);
  return w.fake.dequeue(index)!;
}
const deletes = (): number => w.fake.callsOf('DELETE', /^\/v1\/subscriptions\//).length;
const linesOf = (prefix: string): string[] => logs.filter(l => l.startsWith(prefix));
const installLines = (): any[] => w.auditLines().filter(l => l.action === 'subscription.install.paid');
/** premium's subscriptions with every updatedAt left out. */
const subsWithoutUpdatedAt = (): any => JSON.parse(JSON.stringify(w.stored().subscriptions, (key, value) => (key === 'updatedAt' ? undefined : value)));
/** An event of a type about an object, as Stripe would post it, with a payload the row chooses. */
let made = 0;
const eventOf = (type: string, object: Record<string, any>): StripeEvent => ({
  id: `evt_row${String(++made).padStart(6, '0')}`, object: 'event', type, created: Math.floor(Date.now() / 1000), api_version: '2024-11-20.acacia', data: { object },
});

describe('claim 4: every object is read from the API', () => {
  it('a completed checkout installs the current session, not the payload, under the holder of the current metadata', async () => {
    const sessionId = await buy(SERVER);
    w.fake.complete(sessionId, { paid: false });
    const real = take('checkout.session.completed');
    const stale = eventOf('checkout.session.completed', { ...real.data.object, payment_status: 'paid', metadata: { ...real.data.object.metadata, holder: SERVER.other } });
    expect((await w.deliver(stale)).status).toBe(200);
    expect([held(SERVER.holder).length, held(SERVER.other).length]).toEqual([0, 0]);
    w.fake.asyncPaid(sessionId);
    const paid = take('checkout.session.async_payment_succeeded');
    const stalePaid = eventOf('checkout.session.async_payment_succeeded', { ...paid.data.object, payment_status: 'unpaid', metadata: { holder: SERVER.other } });
    expect((await w.deliver(stalePaid)).status).toBe(200);
    expect([held(SERVER.holder).length, held(SERVER.other).length]).toEqual([1, 0]);
  });

  it('a subscription event copies the current subscription, whatever the payload says', async () => {
    const { subId } = await installed(SERVER);
    w.fake.portalCancel(subId);
    w.fake.queue.length = 0;
    const current = w.fake.subscriptions.get(subId)!;
    const outcomes: any[] = [];
    for (const type of ['customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed']) {
      const stale = eventOf(type, { id: subId, status: 'canceled', cancel_at_period_end: false, current_period_end: 1, metadata: { holder: SERVER.other } });
      const out = await w.deliver(stale);
      const [h] = held(SERVER.holder);
      outcomes.push({ type, status: out.status, held: h ? { status: h.sub.status, endDate: h.sub.endDate, autoRenew: h.sub.autoRenew } : null, other: held(SERVER.other).length });
    }
    const want = mappedState(current);
    for (const o of outcomes) expect(o).toEqual({ type: o.type, status: 200, held: want, other: 0 });
    expect(want.autoRenew).toBe(false);
  });

  it('an invoice event reads the invoice and its subscription, not the payload', async () => {
    const { subId } = await installed(USER);
    w.fake.renew(subId);
    const realPaid = take('invoice.paid');
    w.fake.queue.length = 0;
    expect((await w.deliver(eventOf('invoice.paid', { id: realPaid.data.object.id, subscription: 'sub_other', status: 'open' }))).status).toBe(200);
    expect(held(USER.holder)[0].sub.endDate).toBe(mappedState(w.fake.subscriptions.get(subId)!).endDate);
    w.fake.failPayment(subId);
    const realFailed = take('invoice.payment_failed');
    w.fake.queue.length = 0;
    const before = w.notices().length;
    expect((await w.deliver(eventOf('invoice.payment_failed', { id: realFailed.data.object.id, subscription: null }))).status).toBe(200);
    expect(w.notices().slice(before)).toEqual([{ to: USER.holder, kind: 'paid.sub.renewal-failed' }]);
  });

  it('a refund reads the charge, not the payload', async () => {
    const { subId } = await installed(SERVER);
    const charge = w.fake.latestCharge(subId)!;
    w.fake.refund(charge.id);
    const real = take('charge.refunded');
    w.fake.queue.length = 0;
    const stale = eventOf('charge.refunded', { ...real.data.object, refunded: false, amount_refunded: 0, invoice: null });
    expect((await w.deliver(stale)).status).toBe(200);
    expect(held(SERVER.holder)).toEqual([]);
    expect(deletes()).toBe(1);
  });

  describe('read failures', () => {
    const transient: Array<[string, any]> = [
      ['a 503', { status: 503 }], ['a 500', { status: 500 }], ['a 401', { status: 401 }], ['a 429', { status: 429 }], ['no answer', { drop: 'before' }],
    ];
    for (const [name, fault] of transient) {
      it(`${name} to the session read answers 400 with SW2, changes nothing, is not recorded, and the next delivery applies it`, async () => {
        const via = await route();
        const sessionId = await buy(SERVER);
        w.fake.complete(sessionId, { paid: true });
        w.fake.queue.length = 0;
        const event = eventOf('checkout.session.completed', { id: sessionId });
        const before = w.storedText();
        w.fake.fail('GET', /^\/v1\/checkout\/sessions\/cs_/, fault);
        const first = await w.deliver(event, { via });
        const reason = 'status' in fault ? `Stripe answered ${fault.status}` : 'fetch failed';
        expect([first.status, (first.reply as any).body]).toEqual([400, { error: `Stripe webhook not applied: the bot could not read checkout session ${sessionId} from Stripe (${reason}); Stripe sends the event again.` }]);
        expect(w.storedText()).toBe(before);
        expect(await recorded(event)).toBe(false);
        const second = await w.deliver(event, { via });
        expect(second.status).toBe(200);
        expect(held(SERVER.holder)).toHaveLength(1);
        expect(await recorded(event)).toBe(true);
      });
    }

    it('a 5xx to the subscription, invoice, charge and session-list reads each answers 400 with SW2 and is applied on the next delivery', async () => {
      const via = await route();
      const { subId } = await installed(SERVER);
      const once = await installed(USER, 'once');
      w.fake.portalCancel(subId);
      w.fake.renew(subId);
      w.fake.queue.length = 0;
      const sub = w.fake.subscriptions.get(subId)!;
      const charge = w.fake.latestCharge(once.sessionId)!;
      w.fake.refund(charge.id);
      w.fake.queue.length = 0;
      const cases: Array<[StripeEvent, RegExp, string]> = [
        [eventOf('customer.subscription.updated', { id: subId }), /^\/v1\/subscriptions\/sub_/, `subscription ${subId}`],
        [eventOf('invoice.paid', { id: sub.latest_invoice }), /^\/v1\/invoices\//, `invoice ${sub.latest_invoice}`],
        [eventOf('charge.refunded', { id: charge.id }), /^\/v1\/charges\//, `charge ${charge.id}`],
        [eventOf('charge.refunded', { id: charge.id }), /^\/v1\/checkout\/sessions\?/, `checkout sessions of payment intent ${charge.payment_intent}`],
      ];
      const outcomes: any[] = [];
      for (const [event, match, object] of cases) {
        const before = w.storedText();
        w.fake.fail('GET', match, { status: 502 });
        const first = await w.deliver(event, { via });
        outcomes.push({ status: first.status, error: (first.reply as any).body.error, same: w.storedText() === before, recorded: await recorded(event) });
        const second = await w.deliver(event, { via });
        outcomes.push({ status: second.status, recorded: await recorded(event) });
        expect(outcomes.at(-2)).toEqual({ status: 400, error: `Stripe webhook not applied: the bot could not read ${object} from Stripe (Stripe answered 502); Stripe sends the event again.`, same: true, recorded: false });
        expect(outcomes.at(-1)).toEqual({ status: 200, recorded: true });
      }
      expect(held(SERVER.holder)[0].sub.autoRenew).toBe(false);
      expect(held(USER.holder)).toEqual([]);
    });

    it('a 404, a 4xx with resource_missing, and an empty session list answer 200 with SL9, change nothing and are recorded', async () => {
      const via = await route();
      const { subId } = await installed(SERVER);
      const once = await installed(USER, 'once');
      w.fake.portalCancel(subId);
      w.fake.queue.length = 0;
      const charge = w.fake.latestCharge(once.sessionId)!;
      w.fake.refund(charge.id);
      w.fake.queue.length = 0;
      const before = w.storedText();
      w.fake.deleteObject('subscription', subId);
      const gone = eventOf('customer.subscription.updated', { id: subId });
      const deletedOut = await w.deliver(gone, { via });
      const missingInvoice = eventOf('invoice.paid', { id: 'in_gone' });
      w.fake.fail('GET', /^\/v1\/invoices\//, { status: 400, code: 'resource_missing', message: 'No such invoice' });
      const missingOut = await w.deliver(missingInvoice, { via });
      w.fake.deleteObject('session', once.sessionId);
      const noSession = eventOf('charge.refunded', { id: charge.id });
      const listOut = await w.deliver(noSession, { via });
      expect([deletedOut.status, missingOut.status, listOut.status]).toEqual([200, 200, 200]);
      expect(w.storedText()).toBe(before);
      expect([await recorded(gone), await recorded(missingInvoice), await recorded(noSession)]).toEqual([true, true, true]);
      expect(linesOf('[StripeProvider] A ')).toEqual([
        `[StripeProvider] A customer.subscription.updated event was not applied: Stripe has no subscription ${subId} (resource_missing).`,
        '[StripeProvider] A invoice.paid event was not applied: Stripe has no invoice in_gone (resource_missing).',
        `[StripeProvider] A charge.refunded event was not applied: Stripe has no checkout sessions of payment intent ${charge.payment_intent} (empty list).`,
      ]);
    });

    it('a 404 with no code answers 200 with SL9 naming the status', async () => {
      const { subId } = await installed(SERVER);
      const before = w.storedText();
      w.fake.fail('GET', /^\/v1\/subscriptions\/sub_/, { status: 404, message: 'Not found' });
      const out = await w.deliver(eventOf('customer.subscription.updated', { id: subId }));
      expect(out.status).toBe(200);
      expect(w.storedText()).toBe(before);
      expect(linesOf('[StripeProvider] A ')).toEqual([`[StripeProvider] A customer.subscription.updated event was not applied: Stripe has no subscription ${subId} (404).`]);
    });
  });
});

describe.each([[SERVER.name, SERVER], [USER.name, USER]])('claim 5: the event table, for %s', (_name, k) => {
  it('a completed checkout with payment_status unpaid installs nothing; async_payment_succeeded installs it once', async () => {
    const sessionId = await buy(k);
    w.fake.complete(sessionId, { paid: false });
    await w.drain();
    expect(held(k.holder)).toEqual([]);
    w.fake.asyncPaid(sessionId);
    await w.drain();
    const subId = w.fake.sessions.get(sessionId)!.subscription;
    expect(held(k.holder).map(h => [h.sub.providerSubId, h.sub.status])).toEqual([[subId, 'active']]);
    expect(installLines()).toHaveLength(1);
  });

  it('a one-time purchase paid later installs once with the session id', async () => {
    const sessionId = await buy(k, 'once');
    w.fake.complete(sessionId, { paid: false });
    await w.drain();
    expect(held(k.holder)).toEqual([]);
    w.fake.asyncPaid(sessionId);
    await w.drain();
    expect(held(k.holder).map(h => h.sub.providerSubId)).toEqual([sessionId]);
    expect(installLines()).toHaveLength(1);
  });

  it('async_payment_failed installs nothing and logs SL5', async () => {
    const sessionId = await buy(k);
    w.fake.complete(sessionId, { paid: false });
    w.fake.asyncFailed(sessionId);
    const out = await w.drain();
    expect(out.map(d => d.status)).toEqual(out.map(() => 200));
    expect(held(k.holder)).toEqual([]);
    expect(linesOf('[StripeProvider] Checkout')).toEqual([`[StripeProvider] Checkout ${sessionId} ended without payment (checkout.session.async_payment_failed); nothing was installed.`]);
  });

  it('a completed one-time purchase installs with the session id', async () => {
    const { sessionId } = await installed(k, 'once');
    expect(held(k.holder).map(h => [h.sub.providerSubId, h.sub.status, h.sub.endDate])).toEqual([[sessionId, 'active', null]]);
  });

  it('a one-time purchase completed with no_payment_required and no payment intent installs with no read of a charge', async () => {
    const sessionId = await buy(k, 'once');
    w.fake.complete(sessionId, { noPayment: true });
    await w.drain();
    expect(held(k.holder).map(h => h.sub.providerSubId)).toEqual([sessionId]);
    expect(w.fake.callsOf('GET', /^\/v1\/(charges|payment_intents)\//)).toEqual([]);
  });

  it('invoice.payment_failed sends one renewal-failed notice to the holder', async () => {
    const { subId } = await installed(k);
    const before = w.notices().length;
    w.fake.failPayment(subId);
    await w.drain();
    expect(w.notices().slice(before)).toEqual([{ to: k.holder, kind: 'paid.sub.renewal-failed' }]);
  });

  it('invoice.paid copies the new period, a portal cancel turns auto-renew off, and an end at Stripe ends it', async () => {
    const { subId } = await installed(k);
    w.fake.renew(subId);
    await w.drain();
    expect(held(k.holder)[0].sub.endDate).toBe(mappedState(w.fake.subscriptions.get(subId)!).endDate);
    w.fake.portalCancel(subId);
    await w.drain();
    expect(held(k.holder)[0].sub.autoRenew).toBe(false);
    w.fake.end(subId);
    await w.drain();
    expect(held(k.holder)).toEqual([]);
    expect(w.auditLines().filter(l => l.action === 'subscription.expire.paid')).toHaveLength(1);
  });

  it('the latest charge refunded in full sends one DELETE, ends it in premium, and logs SL6', async () => {
    const { subId } = await installed(k);
    const charge = w.fake.latestCharge(subId)!;
    w.fake.refund(charge.id);
    await w.drain();
    expect(deletes()).toBe(1);
    expect(w.fake.subscriptions.get(subId)!.status).toBe('canceled');
    expect(held(k.holder)).toEqual([]);
    expect(w.auditLines().filter(l => l.action === 'subscription.expire.paid')).toHaveLength(1);
    expect(linesOf('[StripeProvider] Charge')).toEqual([`[StripeProvider] Charge ${charge.id} was refunded in full; subscription ${subId} (${words(k.holder)}) was cancelled at Stripe.`]);
  });

  it('two partial refunds that add up to the whole latest charge end it at the second', async () => {
    const { subId } = await installed(k);
    const charge = w.fake.latestCharge(subId)!;
    w.fake.refund(charge.id, Math.floor(charge.amount / 2));
    await w.deliverNext();
    const afterFirst = { held: held(k.holder).length, deletes: deletes() };
    w.fake.refund(charge.id);
    await w.drain();
    expect(afterFirst).toEqual({ held: 1, deletes: 0 });
    expect({ held: held(k.holder).length, deletes: deletes() }).toEqual({ held: 0, deletes: 1 });
  });

  it('one partial refund changes nothing and logs SL4', async () => {
    const { subId } = await installed(k);
    const charge = w.fake.latestCharge(subId)!;
    const before = w.storedText();
    w.fake.refund(charge.id, 100);
    await w.drain();
    expect(w.storedText()).toBe(before);
    expect(deletes()).toBe(0);
    const amount = (charge.amount / 100).toFixed(2);
    expect(linesOf('[StripeProvider] Charge')).toEqual([`[StripeProvider] Charge ${charge.id} was refunded (1.00 of ${amount} USD), and it is not a full refund of the latest payment of subscription ${subId}; the subscription stays.`]);
  });

  it("a full refund of an older invoice's charge while a newer one is paid changes nothing and logs SL4", async () => {
    const { subId } = await installed(k);
    const older = w.fake.latestCharge(subId)!;
    w.fake.renew(subId);
    await w.drain();
    const before = w.storedText();
    w.fake.refund(older.id);
    await w.drain();
    expect(w.storedText()).toBe(before);
    expect(deletes()).toBe(0);
    expect(linesOf('[StripeProvider] Charge')).toHaveLength(1);
    expect(linesOf('[StripeProvider] Charge')[0]).toMatch(/is not a full refund of the latest payment of subscription/);
  });

  for (const state of ['canceled', 'incomplete_expired'] as const) {
    it(`a full refund of a subscription that reads ${state} sends no DELETE and ends it in premium`, async () => {
      const { subId } = await installed(k);
      const charge = w.fake.latestCharge(subId)!;
      if (state === 'canceled') w.fake.end(subId);
      // The row sets the status itself: the fake has no action that makes a paid subscription incomplete_expired.
      else w.fake.subscriptions.get(subId)!.status = 'incomplete_expired';
      w.fake.queue.length = 0;
      w.fake.refund(charge.id);
      await w.drain();
      expect(deletes()).toBe(0);
      expect(held(k.holder)).toEqual([]);
    });
  }

  it('a full refund of a one-time purchase ends it with no DELETE and logs SL6', async () => {
    const { sessionId } = await installed(k, 'once');
    const charge = w.fake.latestCharge(sessionId)!;
    w.fake.refund(charge.id);
    await w.drain();
    expect(deletes()).toBe(0);
    expect(held(k.holder)).toEqual([]);
    expect(linesOf('[StripeProvider] Charge')).toEqual([`[StripeProvider] Charge ${charge.id} was refunded in full; the purchase ${sessionId} (${words(k.holder)}) is ended in the bot.`]);
  });

  it('a completed checkout read after its subscription ended installs nothing and logs SL7', async () => {
    const sessionId = await buy(k);
    const session = w.fake.complete(sessionId, { paid: true });
    w.fake.end(session.subscription);
    await w.drain();
    expect(held(k.holder)).toEqual([]);
    expect(installLines()).toEqual([]);
    expect(linesOf('[StripeProvider] Checkout')).toEqual([`[StripeProvider] Checkout ${sessionId} completed for subscription ${session.subscription}, which had already ended at Stripe; nothing was installed.`]);
  });

  it('a refunded charge of an invoice with no subscription answers 200, logs SL10, reads nothing past the invoice and sends no DELETE', async () => {
    await installed(k);
    const before = w.storedText();
    const { invoice, charge } = w.fake.dashboardInvoice();
    await w.drain();
    const callsBefore = w.fake.calls.length;
    w.fake.refund(charge.id);
    const out = await w.drain();
    expect(out.map(d => d.status)).toEqual([200]);
    expect(w.fake.calls.slice(callsBefore).map(c => `${c.method} ${c.path.split('?')[0]}`)).toEqual([`GET /v1/charges/${charge.id}`]);
    expect(w.storedText()).toBe(before);
    expect(linesOf('[StripeProvider] Charge')).toEqual([`[StripeProvider] Charge ${charge.id} was refunded; its invoice ${invoice.id} belongs to no subscription, so it was not made by the bot's checkout and the bot does not manage it.`]);
  });
});

describe('the refund DELETE (review B2)', () => {
  const lead = (charge: string, sub: string) => `[StripeProvider] Charge ${charge} was refunded in full; subscription ${sub} (${words(SERVER.holder)})`;

  for (const [name, fault, reason] of [['a 503', { status: 503 }, 'Stripe answered 503'], ['no answer after Stripe cancelled it', { drop: 'after' }, 'fetch failed']] as const) {
    it(`${name} to the DELETE answers 400 can't confirm; the next delivery sends no DELETE, ends it and logs that it was already cancelled`, async () => {
      const via = await route();
      const { subId } = await installed(SERVER);
      const charge = w.fake.latestCharge(subId)!;
      w.fake.refund(charge.id);
      const refund = take('charge.refunded');
      w.fake.fail('DELETE', /^[/]v1[/]subscriptions[/]sub_/, fault);
      const first = await w.deliver(refund, { via });
      const firstHeld = held(SERVER.holder).length;
      if (!('drop' in fault)) w.fake.end(subId);
      w.fake.queue.length = 0;
      const second = await w.deliver(refund, { via });
      expect([first.status, (first.reply as any).body]).toEqual([400, { error: `Stripe webhook not applied: can't confirm whether Stripe cancelled subscription ${subId} (${reason}); Stripe sends the event again.` }]);
      expect(firstHeld).toBe(1);
      expect(second.status).toBe(200);
      expect(deletes()).toBe(1);
      expect(held(SERVER.holder)).toEqual([]);
      expect(linesOf('[StripeProvider] Charge')).toEqual([`${lead(charge.id, subId)} was already cancelled at Stripe.`]);
    });
  }

  it('a 4xx to the DELETE answers 400 that the bot could not cancel it', async () => {
    const via = await route();
    const { subId } = await installed(SERVER);
    w.fake.refund(w.fake.latestCharge(subId)!.id);
    const refund = take('charge.refunded');
    w.fake.fail('DELETE', /^[/]v1[/]subscriptions[/]sub_/, { status: 402, message: 'Card declined.' });
    const first = await w.deliver(refund, { via });
    expect([first.status, (first.reply as any).body]).toEqual([400, { error: `Stripe webhook not applied: the bot could not cancel subscription ${subId} at Stripe (Stripe answered 402); Stripe sends the event again.` }]);
    expect(held(SERVER.holder)).toHaveLength(1);
  });

  it('a DELETE answered 2xx and a failed re-read: SL6 is logged once, at the DELETE; the retry logs it was already cancelled', async () => {
    const via = await route();
    const { subId } = await installed(SERVER);
    const charge = w.fake.latestCharge(subId)!;
    w.fake.refund(charge.id);
    const refund = take('charge.refunded');
    const gate = w.fake.hold('DELETE', /^[/]v1[/]subscriptions[/]sub_/);
    void gate.reached.then(() => { w.fake.fail('GET', /^[/]v1[/]subscriptions[/]sub_/, { status: 503 }); gate.release(); });
    const first = await w.deliver(refund, { via });
    const linesAfterFirst = linesOf('[StripeProvider] Charge');
    w.fake.queue.length = 0;
    const second = await w.deliver(refund, { via });
    expect(first.status).toBe(400);
    expect(linesAfterFirst).toEqual([`${lead(charge.id, subId)} was cancelled at Stripe.`]);
    expect(second.status).toBe(200);
    expect(deletes()).toBe(1);
    expect(held(SERVER.holder)).toEqual([]);
    expect(linesOf('[StripeProvider] Charge')).toEqual([`${lead(charge.id, subId)} was cancelled at Stripe.`, `${lead(charge.id, subId)} was already cancelled at Stripe.`]);
  });
});

describe('claim 6: repeats are safe', () => {
  it('each event type delivered twice leaves what the first left, one install line, one started notice and one DELETE', async () => {
    const sessionId = await buy(SERVER);
    const session = w.fake.complete(sessionId, { paid: true });
    const subId = session.subscription;
    const twice = async (): Promise<string[]> => {
      const out: string[] = [];
      for (let event = w.fake.dequeue(); event; event = w.fake.dequeue()) {
        await w.deliver(event);
        const first = subsWithoutUpdatedAt();
        await w.deliver(event);
        if (JSON.stringify(subsWithoutUpdatedAt()) !== JSON.stringify(first)) out.push(event.type);
      }
      return out;
    };
    const changed: string[] = [];
    changed.push(...await twice());
    w.fake.renew(subId);
    changed.push(...await twice());
    w.fake.portalCancel(subId);
    changed.push(...await twice());
    w.fake.refund(w.fake.latestCharge(subId)!.id);
    changed.push(...await twice());
    expect(changed).toEqual([]);
    expect(installLines()).toHaveLength(1);
    expect(w.notices().filter(n => n.kind === 'paid.sub.started')).toHaveLength(1);
    expect(deletes()).toBe(1);
    expect(held(SERVER.holder)).toEqual([]);
  });

  it("a refund's second delivery sends no second DELETE", async () => {
    const { subId } = await installed(SERVER);
    w.fake.refund(w.fake.latestCharge(subId)!.id);
    const refund = take('charge.refunded');
    await w.deliver(refund);
    await w.deliver(refund);
    expect(deletes()).toBe(1);
    expect(held(SERVER.holder)).toEqual([]);
  });

  it('a one-time purchase refunded in full and ended, then its completed event delivered again, installs nothing (SL8)', async () => {
    const sessionId = await buy(USER, 'once');
    w.fake.complete(sessionId, { paid: true });
    const completed = take('checkout.session.completed');
    await w.deliver(completed);
    expect(held(USER.holder)).toHaveLength(1);
    w.fake.refund(w.fake.latestCharge(sessionId)!.id);
    await w.drain();
    expect(held(USER.holder)).toEqual([]);
    await w.deliver(completed);
    expect(held(USER.holder)).toEqual([]);
    expect(installLines()).toHaveLength(1);
    expect(linesOf('[StripeProvider] Checkout')).toEqual([`[StripeProvider] Checkout ${sessionId} completed for a one-time purchase whose payment was refunded in full; nothing was installed.`]);
  });

  it('a refund delivered before the completion ends nothing, and the completion then installs nothing (SL8)', async () => {
    const sessionId = await buy(SERVER, 'once');
    w.fake.complete(sessionId, { paid: true });
    const completed = take('checkout.session.completed');
    w.fake.refund(w.fake.latestCharge(sessionId)!.id);
    await w.drain();
    expect(held(SERVER.holder)).toEqual([]);
    await w.deliver(completed);
    expect(held(SERVER.holder)).toEqual([]);
    expect(installLines()).toEqual([]);
    expect(linesOf('[StripeProvider] Checkout')).toEqual([`[StripeProvider] Checkout ${sessionId} completed for a one-time purchase whose payment was refunded in full; nothing was installed.`]);
  });
});

describe('claim 15: objects the bot does not manage', () => {
  const fixture = (name: string): any => JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'p3', name), 'utf8'));

  it('a subscription with guildId and userId, and one with no metadata: every event 200, nothing emitted, SL1 once per object, a refund sends no DELETE', async () => {
    const dump = fixture('stripe-objects.p0.json');
    w.fake.load(dump);
    const oldSubId = Object.keys(dump.subscriptions)[0];
    const oldSessionId = Object.keys(dump.sessions)[0];
    expect(w.fake.subscriptions.get(oldSubId)!.metadata).toMatchObject({ guildId: IDS[0], userId: IDS[1] });
    // Another product of the account: the same subscription copied under a new id with no metadata at all.
    const bare = JSON.parse(JSON.stringify(w.fake.subscriptions.get(oldSubId)));
    Object.assign(bare, { id: 'sub_bare000001', metadata: {}, items: { ...bare.items, data: [{ ...bare.items.data[0], id: 'si_bare000001' }] } });
    w.fake.subscriptions.set(bare.id, bare);
    w.fake.renew(oldSubId);
    w.fake.renew(bare.id);
    w.fake.failPayment(oldSubId);
    w.fake.failPayment(bare.id);
    w.fake.queue.length = 0;
    const emittedBefore = w.emitted.length;
    const statuses: number[] = [];
    for (const subId of [oldSubId, bare.id]) {
      const sub = w.fake.subscriptions.get(subId)!;
      const paidInvoice = [...w.fake.invoices.values()].filter(i => i.subscription === subId && i.status === 'paid').at(-1)!;
      for (const type of ['customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed']) {
        statuses.push((await w.deliver(eventOf(type, { id: subId }))).status);
      }
      statuses.push((await w.deliver(eventOf('invoice.paid', { id: paidInvoice.id }))).status);
      statuses.push((await w.deliver(eventOf('invoice.payment_failed', { id: sub.latest_invoice }))).status);
    }
    statuses.push((await w.deliver(eventOf('checkout.session.completed', { id: oldSessionId }))).status);
    // A full refund of each one's latest charge: its invoice is the subscription's latest_invoice.
    for (const subId of [oldSubId, bare.id]) {
      w.fake.renew(subId);
      w.fake.queue.length = 0;
      const charge = w.fake.latestCharge(subId)!;
      w.fake.refund(charge.id);
      w.fake.queue.length = 0;
      statuses.push((await w.deliver(eventOf('charge.refunded', { id: charge.id }))).status);
    }
    expect(statuses).toEqual(statuses.map(() => 200));
    expect(w.emitted.length).toBe(emittedBefore);
    expect(deletes()).toBe(0);
    expect([w.fake.subscriptions.get(oldSubId)!.status, w.fake.subscriptions.get(bare.id)!.status]).toEqual(['active', 'active']);
    const sl1 = linesOf('[StripeProvider] A ').filter(l => l.includes('its metadata names no holder'));
    expect(sl1).toEqual([
      `[StripeProvider] A customer.subscription.updated event for subscription ${oldSubId} was not applied: its metadata names no holder. It was made before this version or not by this bot; the bot does not manage it.`,
      `[StripeProvider] A customer.subscription.updated event for subscription ${bare.id} was not applied: its metadata names no holder. It was made before this version or not by this bot; the bot does not manage it.`,
      `[StripeProvider] A checkout.session.completed event for checkout session ${oldSessionId} was not applied: its metadata names no holder. It was made before this version or not by this bot; the bot does not manage it.`,
    ]);
  });

  it("premium's copy installed before part 3 is ended by End now with one DELETE", async () => {
    const dump = fixture('stripe-objects.p0.json');
    const stored = fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'p3', 'premium-tiers.p0.json'), 'utf8');
    await w.settle();
    w.fake.load(dump);
    fs.writeFileSync(dataPath('global', 'premium-tiers.json'), stored);
    await w.reload();
    const subId = Object.keys(dump.subscriptions)[0];
    expect(held(`guild:${IDS[0]}`).map(h => h.sub.providerSubId)).toEqual([subId]);
    const out = await w.op('cancelPaidSubscriptionImmediately', `guild:${IDS[0]}`);
    expect(out.ok).toBe(true);
    expect(deletes()).toBe(1);
    expect(held(`guild:${IDS[0]}`)).toEqual([]);
    expect(w.fake.subscriptions.get(subId)!.status).toBe('canceled');
  });
});

describe('claim 16: the price at Stripe', () => {
  it("the bot's own price change sends the new price in items and metadata, and its updated event logs nothing", async () => {
    const { subId } = await installed(SERVER);
    await getPaymentRegistry().get('stripe')!.migrateSubscriptionPrice!(subId, UNLINKED_PRICE, 'none');
    const post = w.fake.callsOf('POST', /^\/v1\/subscriptions\//).at(-1)!;
    expect([post.params['items[0][price]'], post.params['metadata[variantId]']]).toEqual([UNLINKED_PRICE, UNLINKED_PRICE]);
    await w.drain();
    expect(linesOf('[StripeProvider] Subscription')).toEqual([]);
  });

  it('a plan switch at Stripe copies the state, keeps the tier and logs SL3 once', async () => {
    const { subId } = await installed(SERVER);
    w.fake.switchPrice(subId, UNLINKED_PRICE);
    w.fake.portalCancel(subId);
    const events = [...w.fake.queue];
    await w.drain();
    for (const event of events) await w.deliver(event);
    const [h] = held(SERVER.holder);
    expect([h.sub.tierId, h.sub.autoRenew]).toEqual(['gold', false]);
    expect(linesOf('[StripeProvider] Subscription')).toEqual([
      `[StripeProvider] Subscription ${subId} now charges price ${UNLINKED_PRICE}, not price_gold_month that the bot sold it with; the bot keeps giving tier 'gold'. Turn off plan switching in the Stripe customer portal settings.`,
    ]);
  });
});

describe('claim 17: one subscription at a time', () => {
  /** The number of calls the fake had received at each emit to premium. */
  function emitMarks(): number[] {
    const marks: number[] = [];
    const registry: any = getPaymentRegistry();
    const emit = registry.emitEvent.bind(registry);
    registry.emitEvent = (event: any) => { marks.push(w.fake.calls.length); return emit(event); };
    return marks;
  }

  /**
   * The next GET whose path matches is answered by the fake at once, and the answer reaches the caller only when the
   * row releases it: the caller holds the state of the moment it read.
   */
  function lateAnswer(match: RegExp): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const arrived = Promise.race([
      new Promise<void>(resolve => { reached = resolve; }),
      new Promise<void>((_, reject) => { setTimeout(() => reject(new Error('lateAnswer: no matching read within 5 s')), 5000); }),
    ]);
    const inner = globalThis.fetch;
    let used = false;
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const answer = await inner(url as any, init);
      if (!used && (init?.method ?? 'GET') === 'GET' && match.test(String(url).slice(STRIPE_BASE.length))) {
        used = true;
        reached();
        await gate;
      }
      return answer;
    }));
    return { reached: arrived, release };
  }

  it('two updated deliveries for one subscription apply the newer state, the second read after the first emit', async () => {
    const { subId } = await installed(SERVER);
    const marks = emitMarks();
    const event1 = eventOf('customer.subscription.updated', { id: subId });
    const event2 = eventOf('customer.subscription.updated', { id: subId });
    const gate = lateAnswer(new RegExp(`^/v1/subscriptions/${subId}`));
    const first = w.deliver(event1);
    await gate.reached;
    const firstRead = w.fake.calls.length - 1;
    w.fake.portalCancel(subId);
    w.fake.queue.length = 0;
    const second = w.deliver(event2);
    await new Promise(resolve => setTimeout(resolve, 50));
    gate.release();
    const outs = await Promise.all([first, second]);
    expect(outs.map(o => o.status)).toEqual([200, 200]);
    expect(held(SERVER.holder)[0].sub.autoRenew).toBe(false);
    const reads = w.fake.calls.map((c, i) => ({ c, i })).filter(({ c }) => c.method === 'GET' && c.path.startsWith(`/v1/subscriptions/${subId}`)).map(({ i }) => i);
    const secondRead = reads.find(i => i > firstRead)!;
    expect(marks).toHaveLength(2);
    expect(secondRead).toBeGreaterThanOrEqual(marks[0]);
  });

  it('deliveries for two different subscriptions do not wait for each other', async () => {
    const a = await installed(SERVER);
    const b = await installed(USER);
    const gate = lateAnswer(new RegExp(`^/v1/subscriptions/${a.subId}`));
    const first = w.deliver(eventOf('customer.subscription.updated', { id: a.subId }));
    await gate.reached;
    w.fake.portalCancel(b.subId);
    w.fake.queue.length = 0;
    const other = await w.deliver(eventOf('customer.subscription.updated', { id: b.subId }));
    const otherDone = held(USER.holder)[0].sub.autoRenew;
    gate.release();
    await first;
    expect([other.status, otherDone]).toEqual([200, false]);
  });

  it('a completed checkout and a cancel at period end delivered at once leave premium with auto-renew off', async () => {
    const sessionId = await buy(SERVER);
    const session = w.fake.complete(sessionId, { paid: true });
    const subId = session.subscription;
    w.fake.queue.length = 0;
    // The completion's subscription read answers before the cancel and reaches the handler only after the cancel's
    // delivery has started, so a handling that does not wait for the chain applies the older state last.
    const gate = lateAnswer(new RegExp(`^/v1/subscriptions/${subId}`));
    const completed = w.deliver(eventOf('checkout.session.completed', { id: sessionId }));
    await gate.reached;
    w.fake.portalCancel(subId);
    w.fake.queue.length = 0;
    const updated = w.deliver(eventOf('customer.subscription.updated', { id: subId }));
    await new Promise(resolve => setTimeout(resolve, 50));
    gate.release();
    const outs = await Promise.all([completed, updated]);
    expect(outs.map(o => o.status)).toEqual([200, 200]);
    expect(held(SERVER.holder).map(h => [h.sub.providerSubId, h.sub.autoRenew])).toEqual([[subId, false]]);
  });
});
