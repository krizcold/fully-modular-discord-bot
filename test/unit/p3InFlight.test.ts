import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P3 claim 17's premium row (E4, F1, G2): a state event that arrives while the install of its subscription is in flight
// waits for that install. The real PremiumManager in the bot role over the JSON files and P1's seller in the registry
// (helpers/p1World.ts); both events are raised inside one payment.webhook op through applySharedOp, the seller's
// webhook raising each event of the body in order. The install is held at the start of installAsyncSubscription (a
// spy that awaits a gate, then runs the real install): the point where an install that has not landed is open, and
// the one await a test can hold that lies before premium's copy changes.
// Rows: an update and an expiry for the held subscription are applied after the install and the op answers only
// after both saves; a state event with nothing in flight is applied at once; a save that throws while the event
// waits (a DataBackendUnavailableError, and a plain Error from applyStateEvent before any save) answers the op not
// ok with no unhandled rejection, logs the event and leaves no in-flight entry; the plain Error is a refusal of
// premium-tiers.json in the op's ledger, and through the web UI's webhook route it answers 503 and its event id is not
// recorded.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => ({ recordCrash: () => undefined, isInSafeMode: () => false, getStatus: () => ({}) }) }));

import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import type { ProviderEvent } from '../../src/bot/internalSetup/utils/payment/paymentTypes';
import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { DataBackendUnavailableError } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { currentLedger, type WriteLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { gh } from '../helpers/p1Holder';
import { BUYER, SELLER_ID, SERVERS, p1World } from '../helpers/p1World';
import { postWebhook } from '../helpers/p3Stripe';

const w = p1World('json');
const S = SERVERS[0];
const PREMIUM_DOC = 'global:/premium-tiers.json';

const pm = (): any => getPremiumManager();
const body = (id: string, events: ProviderEvent[]): string => JSON.stringify({ id, events });
/** One payment.webhook op whose body raises the events in order, as one delivery of the seller. */
const deliverAll = (id: string, events: ProviderEvent[]) =>
  applySharedOp({ op: 'payment.webhook', args: { providerId: SELLER_ID, body: Buffer.from(body(id, events)).toString('base64'), signature: '' } } as any) as Promise<{ ok: boolean; code?: string; error?: string }>;

/** The next install is held before it starts; `landed` runs once the real install answered. */
function holdInstall(landed: () => void = () => undefined) {
  const real = pm().installAsyncSubscription.bind(pm());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void;
  const atGate = new Promise<void>(resolve => { reached = resolve; });
  vi.spyOn(pm(), 'installAsyncSubscription').mockImplementationOnce(async (...args: unknown[]) => {
    reached();
    await gate;
    const out = await real(...args);
    landed();
    return out;
  });
  return { atGate, release };
}

const updatedOf = (event: ProviderEvent): ProviderEvent => ({ ...(event as any), type: 'subscription.updated' });

let rejections: unknown[] = [];
const onRejection = (reason: unknown) => { rejections.push(reason); };
let errors: string[] = [];
/** Runs at each console.error, after the line is collected. */
let atLog: (() => void) | null = null;

beforeEach(async () => {
  await w.setup();
  vi.spyOn(w.seller, 'handleWebhook').mockImplementation(async (raw: Buffer) => {
    for (const event of JSON.parse(raw.toString('utf8')).events) getPaymentRegistry().emitEvent(event);
  });
  rejections = [];
  process.on('unhandledRejection', onRejection);
  errors = [];
  atLog = null;
  const realError = console.error.bind(console);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' '));
    realError(...args);
    atLog?.();
  });
});

afterEach(async () => {
  process.off('unhandledRejection', onRejection);
  vi.restoreAllMocks();
  await w.teardown();
});

describe('a state event waits for the install in flight for its id', () => {
  it('applies an update after the held install, and the op answers only after both saves', async () => {
    const record = w.seller.checkout({ holder: gh(S), buyerId: BUYER, tierId: 'high', offeringId: 'o-high' });
    const created = w.createdEvent(record);
    w.seller.cancelAtPeriodEnd(record.providerSubId);
    const updated = updatedOf(w.stateEvent('subscription.renewed', record));
    const held = holdInstall();
    let answered = false;
    const reply = deliverAll('evt_1', [created, updated]).then(r => { answered = true; return r; });
    await held.atGate;
    await new Promise(resolve => setTimeout(resolve, 50));
    const whileHeld = answered;
    held.release();
    const answer = await reply;
    const storedAtAnswer = w.stored()?.subscriptions?.[gh(S)]?.active;
    expect(whileHeld).toBe(false);
    expect(answer.ok).toBe(true);
    expect(storedAtAnswer).toMatchObject({ providerSubId: record.providerSubId, autoRenew: false, status: 'active' });
    await w.settle();
    expect(pm().inFlight.size).toBe(0);
  });

  it('applies an expiry after the held install: the subscription leaves the slot and the queue resumes', async () => {
    const low = await w.purchase(S, 'low');
    expect(low.ok).toBe(true);
    const lowId = w.recordOf(S).active.providerSubId;
    const record = w.seller.checkout({ holder: gh(S), buyerId: BUYER, tierId: 'high', offeringId: 'o-high' });
    const created = w.createdEvent(record);
    w.seller.expire(record.providerSubId);
    const expired = w.stateEvent('subscription.expired', record);
    const held = holdInstall();
    const reply = deliverAll('evt_2', [created, expired]);
    await held.atGate;
    held.release();
    const answer = await reply;
    await w.settle();
    const stored = w.recordOf(S);
    expect(answer.ok).toBe(true);
    expect(stored.active).toMatchObject({ providerSubId: lowId, status: 'active' });
    expect(stored.paused).toEqual([]);
    expect(w.auditLines().filter(l => l.action === 'subscription.expire.paid')).toHaveLength(1);
    expect(w.calls().filter(c => c.method === 'resumeSubscription').map(c => c.args[0])).toEqual([lowId]);
  });

  it('applies a state event at once when nothing is in flight for its id', async () => {
    const record = w.seller.checkout({ holder: gh(S), buyerId: BUYER, tierId: 'high', offeringId: 'o-high' });
    expect((await deliverAll('evt_0', [w.createdEvent(record)])).ok).toBe(true);
    await w.settle();
    w.seller.cancelAtPeriodEnd(record.providerSubId);
    getPaymentRegistry().emitEvent(updatedOf(w.stateEvent('subscription.renewed', record)));
    const atOnce = pm().getSubscriptions(gh(S)).active;
    expect(atOnce).toMatchObject({ providerSubId: record.providerSubId, autoRenew: false });
    expect(pm().inFlight.size).toBe(0);
  });
});

describe('a throw while the event waits', () => {
  it('a DataBackendUnavailableError from the save answers the op not ok, logs the event and leaves no entry', async () => {
    const record = w.seller.checkout({ holder: gh(S), buyerId: BUYER, tierId: 'high', offeringId: 'o-high' });
    const created = w.createdEvent(record);
    w.seller.cancelAtPeriodEnd(record.providerSubId);
    const updated = updatedOf(w.stateEvent('subscription.renewed', record));
    let failing = false;
    const realSave = pm().save.bind(pm());
    vi.spyOn(pm(), 'save').mockImplementation((...args: unknown[]) => {
      if (failing) throw new DataBackendUnavailableError('node-stopping');
      return realSave(...args);
    });
    const held = holdInstall(() => { failing = true; });
    const reply = deliverAll('evt_3', [created, updated]);
    await held.atGate;
    held.release();
    const answer = await reply;
    await w.settle();
    expect(answer.ok).toBe(false);
    expect(rejections).toEqual([]);
    expect(errors.some(e => e.includes(`subscription.updated event from ${SELLER_ID} (subscription ${record.providerSubId}`))).toBe(true);
    expect(pm().inFlight.has(record.providerSubId)).toBe(false);
  });

  it('a plain Error from applyStateEvent before any save is a refusal of premium-tiers.json in the op\'s ledger', async () => {
    const record = w.seller.checkout({ holder: gh(S), buyerId: BUYER, tierId: 'high', offeringId: 'o-high' });
    const created = w.createdEvent(record);
    w.seller.cancelAtPeriodEnd(record.providerSubId);
    const updated = updatedOf(w.stateEvent('subscription.renewed', record));
    let ledger: WriteLedger | undefined;
    vi.spyOn(pm(), 'applyStateEvent').mockImplementation(() => {
      ledger = currentLedger();
      throw new Error('p3 applyStateEvent failed');
    });
    // The ledger seals when the op ends; its refusals and verdict are read when the waiting event logs its failure.
    let refused: Array<[string, string]> = [];
    let verdict: Promise<{ ok: boolean }> | null = null;
    atLog = () => {
      if (!ledger || verdict) return;
      refused = ledger.refusedDocs().map(r => [r.cause, r.doc]);
      verdict = verdictOf([ledger]);
    };
    const held = holdInstall();
    const reply = deliverAll('evt_4', [created, updated]);
    await held.atGate;
    held.release();
    const answer = await reply;
    await w.settle();
    expect(answer.ok).toBe(false);
    expect(rejections).toEqual([]);
    expect(ledger).toBeDefined();
    expect(refused).toContainEqual(['io', PREMIUM_DOC]);
    expect(verdict).not.toBeNull();
    expect((await verdict!).ok).toBe(false);
    expect(errors.some(e => e.includes(`subscription.updated event from ${SELLER_ID} (subscription ${record.providerSubId}`))).toBe(true);
    expect(pm().inFlight.has(record.providerSubId)).toBe(false);
  });

  it('through the webhook route the plain Error answers 503 and its event id is not recorded; the next delivery applies it', async () => {
    const deliveries = await import('../../src/webui/webhookDeliveries');
    deliveries._resetWebhookDeliveries();
    (w.seller as any).webhookEventId = (raw: Buffer) => JSON.parse(raw.toString('utf8')).id;
    const manager: any = {
      postAccessLog: () => undefined,
      getStatus: () => ({}),
      runSharedOp: (op: string, args: unknown) => applySharedOp({ op, args } as any),
    };
    const { createServer } = await import('../../src/webui/server');
    const server = http.createServer(await createServer(manager));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const record = w.seller.checkout({ holder: gh(S), buyerId: BUYER, tierId: 'high', offeringId: 'o-high' });
      const created = w.createdEvent(record);
      w.seller.cancelAtPeriodEnd(record.providerSubId);
      const updated = updatedOf(w.stateEvent('subscription.renewed', record));
      let throwing = true;
      const realApply = pm().applyStateEvent.bind(pm());
      vi.spyOn(pm(), 'applyStateEvent').mockImplementation((...args: unknown[]) => {
        if (throwing) throw new Error('p3 applyStateEvent failed');
        return realApply(...args);
      });
      const held = holdInstall();
      const first = postWebhook(base, SELLER_ID, body('evt_5', [created, updated]), '');
      await held.atGate;
      held.release();
      const refused = await first;
      await w.settle();
      const recordedAfterRefusal = deliveries.webhookDeliveryAnswered(SELLER_ID, 'evt_5');
      throwing = false;
      const again = await postWebhook(base, SELLER_ID, body('evt_5', [created, updated]), '');
      await w.settle();
      expect(refused.status).toBe(503);
      expect(recordedAfterRefusal).toBe(false);
      expect(again.status).toBe(200);
      expect(deliveries.webhookDeliveryAnswered(SELLER_ID, 'evt_5')).toBe(true);
      expect(w.recordOf(S).active).toMatchObject({ providerSubId: record.providerSubId, autoRenew: false });
      expect(rejections).toEqual([]);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
