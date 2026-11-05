import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 11: a payment webhook is handled in the process that writes premium. With a child at shared it is sent
// as payment.webhook and the raw body reaches handleWebhook unchanged (a Stripe-style HMAC verifies in the executor);
// a child unreported for 5 s answers 503; with no child the local chain handles it; a handler error answers 400 and a
// not-ok answer 503.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
const hook = vi.hoisted(() => ({ secret: 'whsec_nb10', bodies: [] as string[], inLocalOp: null as null | (() => boolean) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const { createHmac } = await import('crypto');
  const provider = {
    id: 'hmachook',
    async handleWebhook(body: Buffer, signature: string): Promise<void> {
      const expected = createHmac('sha256', hook.secret).update(body).digest('hex');
      if (signature !== expected) throw new Error('signature does not match the body');
      hook.bodies.push(body.toString('utf8'));
      if (hook.inLocalOp && !hook.inLocalOp()) throw new Error('handled outside a local op');
    },
  };
  return {
    ...(await orig<any>()),
    getPaymentRegistry: () => ({ on: () => undefined, off: () => undefined, list: () => [provider], startTickers: () => undefined, emitEvent: () => undefined, get: (id: string) => (id === 'hmachook' ? provider : undefined) }),
  };
});

import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { forks } from '../helpers/forkMock';
import { answering, exitChild, freshWriterLock, quiet, resetForks, sentTo, startedWith } from '../helpers/nb10Rig';

const BODY = '{"type":"customer.subscription.created","data":{"object":{"id":"sub_1","note":"  spaced  \\u00e9"}}}';
const sign = (body: string) => crypto.createHmac('sha256', hook.secret).update(Buffer.from(body, 'utf8')).digest('hex');

/** The web UI's own server, whose webhook route is the one under test. */
async function mountServer(manager: BotManager) {
  const { createServer } = await import('../../src/webui/server');
  const server = http.createServer(await createServer(manager));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function post(base: string, body: string, signature: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/webhook/hmachook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body });
  return { status: res.status, body: await res.json() };
}

let app: { url: string; close: () => Promise<void> } | null = null;

beforeEach(() => {
  quiet();
  resetForks();
  freshWriterLock('webui');
  hook.bodies.length = 0;
  hook.inLocalOp = null;
  setSharedWriteGate(() => inLocalOp());
});

afterEach(async () => {
  await app?.close();
  app = null;
  setSharedWriteGate(null);
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  vi.restoreAllMocks();
});

async function serve(manager: BotManager): Promise<string> {
  app = await mountServer(manager);
  return app.url;
}

describe('a webhook with a child at shared', () => {
  it('is sent as one payment.webhook whose raw body verifies by HMAC in the executor, and answers 200', async () => {
    const { manager, child } = await startedWith([{ stage: 'shared' }]);
    setSharedWriteGate(null);
    answering(child, m => (m.type === 'shared:op' ? applySharedOp(m.data) : undefined));
    const base = await serve(manager);
    const reply = await post(base, BODY, sign(BODY));
    expect(reply).toEqual({ status: 200, body: { received: true } });
    const ops = sentTo(child, 'shared:op');
    expect(ops).toHaveLength(1);
    expect(ops[0].data.op).toBe('payment.webhook');
    expect(Buffer.from(ops[0].data.args.body, 'base64').toString('utf8')).toBe(BODY);
    expect(hook.bodies).toEqual([BODY]);
  });

  it('a handler error answers 400, and a not-ok answer 503', async () => {
    const { manager, child } = await startedWith([{ stage: 'shared' }]);
    setSharedWriteGate(null);
    answering(child, m => (m.type === 'shared:op' ? applySharedOp(m.data) : undefined));
    const base = await serve(manager);
    expect((await post(base, BODY, 'forged')).status).toBe(400);
    answering(child, () => ({ ok: false, code: 'unconfirmed', answer: 'held', error: 'not saved' }));
    expect((await post(base, BODY, sign(BODY))).status).toBe(503);
  });
});

describe('a webhook with a child that has not reported', () => {
  it('answers 503 after waiting 5 s for a route, and sends nothing', async () => {
    const { manager, child } = await startedWith([]);
    answering(child, () => ({ ok: true }));
    const base = await serve(manager);
    const started = Date.now();
    const reply = await post(base, BODY, sign(BODY));
    expect(reply.status).toBe(503);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
    expect(sentTo(child)).toEqual([]);
    expect(hook.bodies).toEqual([]);
  }, 15_000);
});

describe('a webhook with no child', () => {
  it('is handled in the local chain, inside its op, and the lock is released after', async () => {
    hook.inLocalOp = inLocalOp;
    const base = await serve(new BotManager());
    const reply = await post(base, BODY, sign(BODY));
    expect(reply).toEqual({ status: 200, body: { received: true } });
    expect(hook.bodies).toEqual([BODY]);
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });
});
