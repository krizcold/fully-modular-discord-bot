import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P3 claim 3: the web UI answers a Stripe delivery once per process. Through the route with a counting op: an event
// answered 200 and then sent again, signed afresh, answers 200 and runs no second op; after a 503 and after a 400 the
// next delivery runs the op; a recorded id with a bad signature runs the op and answers 400; the same id of two
// providers is two entries; an id is forgotten after 4 days; the 10,001st id drops the oldest.

vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }) }));
const providers = vi.hoisted(() => ({} as Record<string, unknown>));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const actual = await orig<any>();
  return { ...actual, getPaymentRegistry: () => ({ on: () => undefined, off: () => undefined, list: () => Object.values(providers), emitEvent: () => undefined, get: (id: string) => providers[id] }) };
});

import { postWebhook, signWithPackage, WEBHOOK_SECRET } from '../helpers/p3Stripe';

const DAY_MS = 24 * 60 * 60 * 1000;
type Answer = { ok: true } | { ok: false; code: string; error: string };

let ops: Array<{ providerId: string; eventId: string }> = [];
let answer: Answer = { ok: true };
let server: http.Server | null = null;
let base = '';

const body = (id: string): string => JSON.stringify({ id, object: 'event', type: 'p3.counted', data: { object: { id: 'x_1' } } });
const send = (id: string, providerId = 'stripe', signature?: string) => {
  const text = body(id);
  return postWebhook(base, providerId, text, signature ?? signWithPackage(text));
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_790_000_000_000);
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET);
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_p3');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { StripeProvider } = await import('../../src/bot/internalSetup/utils/payment/stripeProvider');
  providers.stripe = new StripeProvider();
  providers.stripe2 = new StripeProvider();
  const deliveries = await import('../../src/webui/webhookDeliveries');
  deliveries._resetWebhookDeliveries();
  ops = [];
  answer = { ok: true };
  const manager: any = {
    postAccessLog: () => undefined,
    getStatus: () => ({}),
    runSharedOp: async (op: string, args: any) => {
      ops.push({ providerId: args.providerId, eventId: JSON.parse(Buffer.from(args.body, 'base64').toString('utf8')).id });
      return answer;
    },
  };
  const { createServer } = await import('../../src/webui/server');
  server = http.createServer(await createServer(manager));
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the route', () => {
  it('answers a delivery already answered 200 with 200 and runs no op', async () => {
    const first = await send('evt_a');
    vi.setSystemTime(Date.now() + 5_000);
    const again = await send('evt_a');
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(again.body).toEqual({ received: true });
    expect(ops).toHaveLength(1);
  });

  it('runs the op again after an answer of 503 and after one of 400', async () => {
    answer = { ok: false, code: 'unconfirmed', error: 'not saved' };
    const refused = await send('evt_b');
    answer = { ok: false, code: 'invalid', error: 'Stripe webhook not applied' };
    const rejected = await send('evt_b');
    answer = { ok: true };
    const applied = await send('evt_b');
    const after = await send('evt_b');
    expect([refused.status, rejected.status, applied.status, after.status]).toEqual([503, 400, 200, 200]);
    expect(ops).toHaveLength(3);
  });

  it('never answers a delivery whose signature fails from the record', async () => {
    expect((await send('evt_c')).status).toBe(200);
    answer = { ok: false, code: 'invalid', error: 'Stripe webhook refused: bad' };
    const forged = await send('evt_c', 'stripe', signWithPackage(body('evt_c'), undefined, 'whsec_other'));
    expect(forged.status).toBe(400);
    expect(ops).toHaveLength(2);
  });

  it('keeps the same event id of two providers as two entries', async () => {
    await send('evt_d', 'stripe');
    await send('evt_d', 'stripe2');
    await send('evt_d', 'stripe2');
    expect(ops.map(o => o.providerId)).toEqual(['stripe', 'stripe2']);
  });

  it('forgets an id after 4 days', async () => {
    await send('evt_e');
    vi.setSystemTime(Date.now() + 4 * DAY_MS - 1_000);
    await send('evt_e');
    vi.setSystemTime(Date.now() + 2_000);
    await send('evt_e');
    expect(ops).toHaveLength(2);
  });
});

describe('the record', () => {
  it('drops the oldest id at the 10,001st', async () => {
    const { recordWebhookDelivery, webhookDeliveryAnswered } = await import('../../src/webui/webhookDeliveries');
    for (let i = 0; i <= 10_000; i++) recordWebhookDelivery('stripe', `evt_${i}`);
    expect([webhookDeliveryAnswered('stripe', 'evt_0'), webhookDeliveryAnswered('stripe', 'evt_1'), webhookDeliveryAnswered('stripe', 'evt_10000')]).toEqual([false, true, true]);
  });
});
