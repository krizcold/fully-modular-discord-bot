import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The web UI server: a payment webhook is sent to the process that writes premium with its raw body (empty when the
// body was not JSON), a webhook that was not applied is logged with why, an applied one is not; the guild subscription
// routes sit under /guild/api/subscriptions behind the guild gate, which does not cover the owner API.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const provider = { id: 'hookp', handleWebhook: async () => undefined };
  return {
    ...(await orig<any>()),
    getPaymentRegistry: () => ({ on: () => undefined, off: () => undefined, list: () => [provider], listAll: () => [provider], startTickers: () => undefined, emitEvent: () => undefined, get: (id: string) => (id === 'hookp' ? provider : undefined) }),
  };
});

import { BotManager } from '../../src/webui/botManager';
import { createServer } from '../../src/webui/server';
import { isGuildWebUIEnabled } from '../../src/webui/auth/oauthConfig';

const DISK = 'The disk did not take the write, so your change was not saved. Check the disk, then try again.';

let app: { url: string; close: () => Promise<void> } | null = null;
let errors: string[] = [];

async function serve(reply: unknown): Promise<{ url: string; ops: Array<{ op: string; args: any }> }> {
  const manager = new BotManager();
  const ops: Array<{ op: string; args: any }> = [];
  (manager as any).runSharedOp = async (op: string, args: any) => { ops.push({ op, args }); return reply; };
  const server = http.createServer(await createServer(manager));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  app = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
  return { url: app.url, ops };
}

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});

afterEach(async () => {
  await app?.close();
  app = null;
  vi.restoreAllMocks();
});

const webhookLines = () => errors.filter(line => line.startsWith('[Webhook]'));

describe('a payment webhook', () => {
  it('sends an empty body for a body that is not JSON, answers 200 when applied, and logs nothing', async () => {
    const { url, ops } = await serve({ ok: true });
    const res = await fetch(`${url}/webhook/hookp`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'not json' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('payment.webhook');
    expect(ops[0].args.body).toBe('');
    expect(webhookLines()).toEqual([]);
  });

  it('answers 503 when not applied and logs the provider and why', async () => {
    const { url } = await serve({ ok: false, code: 'disk' });
    const res = await fetch(`${url}/webhook/hookp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: DISK });
    expect(webhookLines()).toEqual([`[Webhook] hookp not applied: ${DISK}`]);
  });
});

describe('the guild subscription routes', () => {
  it('are gated under their own path, and the owner API is not behind the guild gate', async () => {
    expect(isGuildWebUIEnabled()).toBe(false);
    const { url } = await serve({ ok: true });
    const gated = await fetch(`${url}/guild/api/subscriptions/123456789012345678`);
    expect(gated.status).toBe(503);
    expect((await gated.json()).error).toMatch(/^Guild Web-UI is currently disabled/);
    const health = await fetch(`${url}/api/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).status).toBe('ok');
  });
});
