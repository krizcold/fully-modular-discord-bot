import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P3 claim 1: the Stripe webhook's signature is checked by the stripe package's constructEvent with a tolerance of
// 300 s. With Date held still, a delivery signed at t0 is handled at t0 + 300 and refused at t0 + 301 (SW1, nothing
// emitted, no call to Stripe); a changed body, another secret, no header and a header with no v1 are refused; two v1
// values of which one is right are accepted; no STRIPE_WEBHOOK_SECRET answers SW3. Through the web UI's route the
// late delivery answers 400 and premium-tiers.json is unchanged.

vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }) }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { postWebhook, signStripe, signWithPackage, type StripeEvent } from '../helpers/p3Stripe';
import { IDS, p3World, type P3World } from '../helpers/p3World';

const T0 = 1_790_000_000;
const HOLDER = `guild:${IDS[0]}`;

let w: P3World;

/** A purchase completed at the fake, its checkout.session.completed event taken out of the queue undelivered. */
async function completedEvent(): Promise<StripeEvent> {
  const bought = await w.buyMember(HOLDER, IDS[1]);
  expect(bought.status).toBe(200);
  w.fake.complete(bought.sessionId!, { paid: true });
  const index = w.fake.queue.findIndex(e => e.type === 'checkout.session.completed');
  expect(index).toBeGreaterThanOrEqual(0);
  return w.fake.dequeue(index)!;
}

const at = (seconds: number): void => { vi.setSystemTime(seconds * 1000); };

/** What a delivery left: its answer, what the provider emitted, and the calls it made to Stripe. */
async function attempt(event: StripeEvent, opts: Parameters<P3World['deliver']>[1]) {
  const calls = w.fake.calls.length;
  const emitted = w.emitted.length;
  const out = await w.deliver(event, opts);
  return { status: out.status, error: (out.reply as any).error ?? (out.reply as any).body?.error, emitted: w.emitted.length - emitted, calls: w.fake.calls.length - calls };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(T0);
  w = p3World('json');
  await w.setup();
});

afterEach(async () => {
  await w.teardown();
  vi.useRealTimers();
});

describe('the signing time', () => {
  it('a delivery signed at t0 is refused at t0 + 301 and handled at t0 + 300', async () => {
    const event = await completedEvent();
    at(T0 + 301);
    const late = await attempt(event, { at: T0 });
    at(T0 + 300);
    const inTime = await attempt(event, { at: T0 });
    expect(late).toEqual({ status: 400, error: 'Stripe webhook refused: Timestamp outside the tolerance zone.', emitted: 0, calls: 0 });
    expect(inTime.status).toBe(200);
    expect(inTime.emitted).toBe(1);
  });
});

describe('the signature', () => {
  it('refuses a changed body, another secret, no header and a header with no v1', async () => {
    const event = await completedEvent();
    const body = JSON.stringify(event);
    const changed = body.replace(event.id, `${event.id.slice(0, -1)}${event.id.endsWith('x') ? 'y' : 'x'}`);
    const outcomes = [
      await attempt(event, { signature: signWithPackage(changed, T0) }),
      await attempt(event, { signature: signWithPackage(body, T0, 'whsec_other') }),
      await attempt(event, { signature: '' }),
      await attempt(event, { signature: `t=${T0}` }),
    ];
    for (const o of outcomes) {
      expect(o.status).toBe(400);
      expect(o.error).toMatch(/^Stripe webhook refused: .+\.$/);
      expect(o).toMatchObject({ emitted: 0, calls: 0 });
    }
  });

  it('accepts two v1 values of which one is right', async () => {
    const event = await completedEvent();
    const body = JSON.stringify(event);
    const right = signWithPackage(body, T0);
    const wrong = signWithPackage(body, T0, 'whsec_other').split(',v1=')[1];
    const out = await attempt(event, { signature: `${right.split(',')[0]},v1=${wrong},v1=${right.split(',v1=')[1]}` });
    expect(out.status).toBe(200);
    expect(out.emitted).toBe(1);
  });

  it('answers SW3 with no STRIPE_WEBHOOK_SECRET, and calls nothing', async () => {
    const event = await completedEvent();
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const out = await attempt(event, {});
    expect(out).toEqual({ status: 400, error: 'Stripe webhook refused: STRIPE_WEBHOOK_SECRET is not set.', emitted: 0, calls: 0 });
  });

  it("accepts one body signed by node's crypto and by the package's helper", async () => {
    const event = await completedEvent();
    const body = JSON.stringify(event);
    expect(signStripe(body, T0)).toBe(signWithPackage(body, T0));
    const byNode = await attempt(event, { signature: signStripe(body, T0) });
    const byPackage = await attempt(event, { signature: signWithPackage(body, T0) });
    expect([byNode.status, byPackage.status]).toEqual([200, 200]);
    expect(byNode.emitted).toBe(1);
  });
});

describe('through the route', () => {
  it('a delivery signed 301 s ago answers 400 and premium-tiers.json is unchanged', async () => {
    const event = await completedEvent();
    const { createServer } = await import('../../src/webui/server');
    const manager: any = {
      postAccessLog: () => undefined,
      getStatus: () => ({}),
      runSharedOp: (op: string, args: unknown) => w.sharedOp(op, args),
    };
    const server = http.createServer(await createServer(manager));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const before = w.storedText();
      at(T0 + 301);
      const late = await attempt(event, { at: T0, via: (body, signature) => postWebhook(base, 'stripe', body, signature) });
      expect(late).toMatchObject({ status: 400, emitted: 0, calls: 0 });
      expect(w.storedText()).toBe(before);
      at(T0 + 300);
      const inTime = await attempt(event, { at: T0, via: (body, signature) => postWebhook(base, 'stripe', body, signature) });
      expect(inTime.status).toBe(200);
      expect(w.storedText()).not.toBe(before);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
