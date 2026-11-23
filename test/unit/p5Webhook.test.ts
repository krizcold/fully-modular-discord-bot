import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P5 claims 1 and 2 (sheet P5, Revision 9, Z3 and Z13): PayPal's postback verifies the raw body as it arrived, every
// refusal leaves premium's bytes unchanged and answers 400, and the route answers a repeat from its record only for a
// delivery that carries PayPal's transmission headers and was answered 200 before.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { PayPalProvider } from '../../src/bot/internalSetup/utils/payment/paypalProvider';
import { _resetWebhookDeliveries } from '../../src/webui/webhookDeliveries';
import { postWebhook, type Delivery, type PayPalEvent } from '../helpers/p5PayPal';
import { heldPayPal, IDS, p5World, SECOND_WEBHOOK_ID, WEBHOOK_ID, type Poster } from '../helpers/p5World';

const HOLDER = `guild:${IDS[0]}`;
const HEADERS = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
const NOT_VERIFIED = 'PayPal webhook refused: PayPal did not verify its signature (FAILURE).';
const NOT_CHECKED = (reason: string) => `PayPal webhook not applied: the bot could not verify the delivery at PayPal (${reason}); PayPal sends the event again.`;

const w = p5World('json');

/** A server bought on the member route and approved at the fake; its ACTIVATED event, taken out of the queue. */
async function activated(): Promise<PayPalEvent> {
  const bought = await w.buyMember(HOLDER, IDS[0]);
  expect(bought.subscriptionId).not.toBeNull();
  w.fake.approve(bought.subscriptionId!);
  const index = w.fake.queue.findIndex(e => e.event_type === 'BILLING.SUBSCRIPTION.ACTIVATED' && e.resource.id === bought.subscriptionId);
  expect(index).toBeGreaterThanOrEqual(0);
  return w.fake.dequeue(index)!;
}

const held = (): number => heldPayPal(w.stored()).length;
const errorOf = (out: { reply: any }): string => String(out.reply?.error ?? out.reply?.body?.error ?? '');

let server: { url: string; close: () => Promise<void> } | null = null;
/** Each payment.webhook op the route ran, and the answers a row puts ahead of the real op. */
const route = { ops: 0, answers: [] as any[] };

/** The web UI's server over the world's executor, its payment.webhook op counted. */
async function mount(): Promise<Poster> {
  const { createServer } = await import('../../src/webui/server');
  const manager: any = new Proxy(w.botManager, {
    get(target, key) {
      if (key === 'runSharedOp') {
        return async (name: string, args: unknown) => {
          if (name === 'payment.webhook') {
            route.ops += 1;
            if (route.answers.length > 0) return route.answers.shift();
          }
          return target.runSharedOp(name, args);
        };
      }
      if (key in target) return target[key];
      return () => undefined;
    },
  });
  const app = http.createServer(await createServer(manager));
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  server = { url, close: () => new Promise<void>(resolve => app.close(() => resolve())) };
  return (body, headers) => postWebhook(url, 'paypal', body, headers);
}

beforeEach(async () => {
  _resetWebhookDeliveries();
  route.ops = 0;
  route.answers.length = 0;
  await w.setup();
});

afterEach(async () => {
  await server?.close();
  server = null;
  await w.teardown();
  vi.restoreAllMocks();
});

describe('P5 claim 1: the postback verifies the raw body', () => {
  it('a delivery the fake signed is applied', async () => {
    const event = await activated();
    const out = await w.deliver(event);
    expect({ status: out.status, error: errorOf(out) }).toEqual({ status: 200, error: '' });
    expect(held()).toBe(1);
    expect(w.fake.unexpected).toEqual([]);
  });

  it('a body changed by one byte, a signature the fake did not issue, and one body with another delivery\'s headers are refused with PW1, premium unchanged', async () => {
    const event = await activated();
    const before = w.storedText();
    const outs = [
      await w.deliver(event, { tamper: d => ({ ...d, body: d.body.replace('"summary":"', '"summary":"x') }) }),
      await w.deliver(event, { tamper: d => ({ ...d, headers: { ...d.headers, 'paypal-transmission-sig': 'bm90IGlzc3VlZCBieSB0aGUgZmFrZQ==' } }) }),
    ];
    const other = w.fake.sign({ ...event, id: 'WH-P5-OTHER' }, WEBHOOK_ID);
    outs.push(await w.deliver(event, { tamper: (d: Delivery) => ({ ...d, headers: other.headers }) }));
    expect(outs.map(o => [o.status, errorOf(o)])).toEqual([[400, NOT_VERIFIED], [400, NOT_VERIFIED], [400, NOT_VERIFIED]]);
    expect(w.storedText()).toBe(before);
    expect(held()).toBe(0);
  });

  it('a delivery the fake signed for the second bot\'s webhook id is refused with PW1, premium unchanged', async () => {
    const event = await activated();
    const before = w.storedText();
    const out = await w.deliver(event, { webhookId: SECOND_WEBHOOK_ID });
    expect([out.status, errorOf(out)]).toEqual([400, NOT_VERIFIED]);
    expect(w.storedText()).toBe(before);
    expect(held()).toBe(0);
  });

  it('a body holding an escaped accented letter and a number written 1.0 is verified as it arrived', async () => {
    const event = await activated();
    const text = JSON.stringify(event).replace('"summary":"', '"summary":"caf\\u00e9 ').replace(/}$/, ',"p5_number":1.0}');
    const out = await w.deliver(event, { text });
    expect({ status: out.status, error: errorOf(out) }).toEqual({ status: 200, error: '' });
    expect(held()).toBe(1);
  });

  it.each(HEADERS)('a delivery without %s is refused with PW1 and no call', async header => {
    const event = await activated();
    const before = w.storedText();
    const calls = w.fake.calls.length;
    const out = await w.deliver(event, { tamper: d => {
      const headers = { ...d.headers };
      delete headers[header];
      return { ...d, headers };
    } });
    expect([out.status, errorOf(out)]).toEqual([400, `PayPal webhook refused: the ${header} header is missing.`]);
    expect(w.fake.calls.length).toBe(calls);
    expect(w.storedText()).toBe(before);
  });

  it('a body that is not a PayPal event is refused with PW1 and no call', async () => {
    await activated();
    const calls = w.fake.calls.length;
    const outs = [await w.deliver(null, { text: 'not json' }), await w.deliver(null, { text: '{"event_type":"BILLING.SUBSCRIPTION.ACTIVATED"}' })];
    expect(outs.map(o => [o.status, errorOf(o)])).toEqual([
      [400, 'PayPal webhook refused: the body is not a PayPal event.'], [400, 'PayPal webhook refused: the body is not a PayPal event.'],
    ]);
    expect(w.fake.calls.length).toBe(calls);
  });

  it('PAYPAL_WEBHOOK_ID unset: PW2 and no call', async () => {
    const event = await activated();
    delete process.env.PAYPAL_WEBHOOK_ID;
    const before = w.storedText();
    const calls = w.fake.calls.length;
    const out = await w.deliver(event);
    expect([out.status, errorOf(out)]).toEqual([400, 'PayPal webhook refused: PAYPAL_WEBHOOK_ID is not set.']);
    expect(w.fake.calls.length).toBe(calls);
    expect(w.storedText()).toBe(before);
  });

  it.each([
    ['the postback with no answer', 'verify', { drop: 'before' as const }],
    ['the postback answering 503', 'verify', { status: 503 }],
    ['the token with no answer', 'token', { drop: 'before' as const }],
  ])('%s: 400 PW3, premium unchanged, then the next delivery applies it', async (_name, which, fault) => {
    const event = await activated();
    if (which === 'token') {
      getPaymentRegistry().unregister('paypal');
      getPaymentRegistry().register(new PayPalProvider());
    }
    w.fake.fail('POST', which === 'token' ? /^\/v1\/oauth2\/token/ : /^\/v1\/notifications\/verify-webhook-signature/, fault);
    const before = w.storedText();
    const first = await w.deliver(event);
    expect(first.status).toBe(400);
    expect(errorOf(first)).toMatch(/^PayPal webhook not applied: the bot could not verify the delivery at PayPal \(.+\); PayPal sends the event again\.$/);
    expect(w.storedText()).toBe(before);
    const again = await w.deliver(event);
    expect([again.status, errorOf(again)]).toEqual([200, '']);
    expect(held()).toBe(1);
  });

  it('each refusal answers 400 through the route', async () => {
    const via = await mount();
    const event = await activated();
    const before = w.storedText();
    const outs = [
      await w.deliver(event, { via, tamper: d => ({ ...d, body: d.body.replace('"summary":"', '"summary":"x') }) }),
      await w.deliver(event, { via, tamper: d => ({ ...d, headers: { ...d.headers, 'paypal-transmission-sig': 'Zm9yZ2Vk' } }) }),
      await w.deliver(event, { via, tamper: d => {
        const headers = { ...d.headers };
        delete headers['paypal-cert-url'];
        return { ...d, headers };
      } }),
    ];
    w.fake.fail('POST', /^\/v1\/notifications\/verify-webhook-signature/, { status: 503 });
    outs.push(await w.deliver(event, { via }));
    delete process.env.PAYPAL_WEBHOOK_ID;
    outs.push(await w.deliver(event, { via }));
    expect(outs.map(o => o.status)).toEqual([400, 400, 400, 400, 400]);
    const errors = outs.map(o => errorOf(o));
    expect(errors[3]).toMatch(/^PayPal webhook not applied: the bot could not verify the delivery at PayPal \(.+\); PayPal sends the event again\.$/);
    errors[3] = NOT_CHECKED('...');
    expect(errors).toEqual([
      NOT_VERIFIED, NOT_VERIFIED, 'PayPal webhook refused: the paypal-cert-url header is missing.', NOT_CHECKED('...'),
      'PayPal webhook refused: PAYPAL_WEBHOOK_ID is not set.',
    ]);
    expect(w.storedText()).toBe(before);
  });
});

describe('P5 claim 2: deliveries once', () => {
  it('a delivery answered 200, then the same event, answers 200 with no second op', async () => {
    const via = await mount();
    const event = await activated();
    const first = await w.deliver(event, { via });
    const second = await w.deliver(event, { via });
    expect([first.status, second.status, route.ops]).toEqual([200, 200, 1]);
    expect(held()).toBe(1);
  });

  it('after a 503 or a 400 the next delivery runs the op', async () => {
    const via = await mount();
    const event = await activated();
    route.answers.push({ ok: false, code: 'unconfirmed', answer: 'held', error: 'not saved' });
    const outs = [await w.deliver(event, { via })];
    w.fake.fail('POST', /^\/v1\/notifications\/verify-webhook-signature/, { status: 503 });
    outs.push(await w.deliver(event, { via }));
    outs.push(await w.deliver(event, { via }));
    expect([outs.map(o => o.status), route.ops]).toEqual([[503, 400, 200], 3]);
    expect(held()).toBe(1);
  });

  it('a forged body with a recorded id answers 200 and runs no op; one with a new id runs the op, answers 400 and is not recorded', async () => {
    const via = await mount();
    const event = await activated();
    expect((await w.deliver(event, { via })).status).toBe(200);
    const before = w.storedText();
    const forgedSig = (d: Delivery): Delivery => ({ ...d, headers: { ...d.headers, 'paypal-transmission-sig': 'Zm9yZ2VkIHNpZ25hdHVyZQ==' } });
    const recorded = await w.deliver(null, { via, text: JSON.stringify({ ...event, event_type: 'BILLING.SUBSCRIPTION.CANCELLED' }), tamper: forgedSig });
    expect([recorded.status, route.ops]).toEqual([200, 1]);
    const fresh = { ...event, id: 'WH-P5-FORGED-NEW', event_type: 'BILLING.SUBSCRIPTION.CANCELLED' };
    const outs = [await w.deliver(null, { via, text: JSON.stringify(fresh), tamper: forgedSig }), await w.deliver(null, { via, text: JSON.stringify(fresh), tamper: forgedSig })];
    expect([outs.map(o => o.status), route.ops]).toEqual([[400, 400], 3]);
    expect(w.storedText()).toBe(before);
  });

  it('a body with no transmission headers is never answered by the record', async () => {
    const via = await mount();
    const event = await activated();
    expect((await w.deliver(event, { via })).status).toBe(200);
    const bare = (d: Delivery): Delivery => {
      const headers = { ...d.headers };
      delete headers['paypal-transmission-id'];
      delete headers['paypal-transmission-sig'];
      return { ...d, headers };
    };
    const out = await w.deliver(event, { via, tamper: bare });
    expect([out.status, route.ops]).toEqual([400, 2]);
  });
});
