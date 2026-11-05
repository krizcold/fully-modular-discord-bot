import { afterEach, describe, expect, it, vi } from 'vitest';

// The guild subscription routes run premium changes through the process that writes premium. A refusal is answered
// once, with the refusal's status and text; any other error answers 500 with its message; the Patreon callback
// answers its error page as HTML.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const patreon = { id: 'patreon', displayName: 'Patreon', handleOAuthCallback: async () => ({}) };
  return {
    ...(await orig<any>()),
    getPaymentRegistry: () => ({ get: (id: string) => (id === 'patreon' ? patreon : undefined), listAll: () => [], list: () => [] }),
  };
});
vi.mock('../../src/bot/internalSetup/utils/premiumManager', async orig => ({
  ...(await orig<any>()),
  getPremiumManager: () => ({ getSubscriptions: () => ({ active: null, paused: [] }) }),
}));

import { createGuildSubscriptionRoutes } from '../../src/webui/routes/guildSubscriptions';
import { startApp } from '../helpers/configRig';

const G = '123456789012345678';
const DISK = 'The disk did not take the write, so your change was not saved. Check the disk, then try again.';

interface Sent { status: number; kind: string; body: unknown; type?: string }

function fakeRes() {
  const sent: Sent[] = [];
  let status = 200;
  let type: string | undefined;
  const res: any = {
    status(code: number) { status = code; return res; },
    type(t: string) { type = t; return res; },
    json(body: unknown) { sent.push({ status, kind: 'json', body }); return res; },
    send(body: unknown) { sent.push({ status, kind: 'send', body, type }); return res; },
    redirect(url: string) { sent.push({ status: 302, kind: 'redirect', body: url }); return res; },
  };
  return { res, sent };
}

/** Calls a route's own handler (past its auth middleware) and answers what it sent. */
async function invoke(reply: () => Promise<unknown>, method: string, route: string, params: Record<string, string>, body: unknown = {}): Promise<Sent[]> {
  const router: any = createGuildSubscriptionRoutes({ runSharedOp: async () => reply() } as any);
  const layer = router.stack.find((l: any) => l.route && l.route.path === route && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${route}`);
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  const { res, sent } = fakeRes();
  const req = { params, body, query: {}, user: { id: 'u1' }, protocol: 'http', get: () => 'host' };
  await handle(req, res, () => undefined);
  return sent;
}

const SHARED_ROUTES: Array<[string, string, Record<string, string>, unknown]> = [
  ['post', '/:guildId/paid', { guildId: G }, { tierId: 'gold', offeringId: 'o1', providerId: 'dummy', variantId: 'v1' }],
  ['delete', '/:guildId/paid', { guildId: G }, {}],
  ['post', '/:guildId/paid/reactivate', { guildId: G }, {}],
  ['post', '/:guildId/paid/expire-now', { guildId: G }, {}],
  ['post', '/:guildId/orphans/:providerId/:providerSubId/adopt', { guildId: G, providerId: 'dummy', providerSubId: 's1' }, {}],
  ['delete', '/:guildId/orphans/:providerId/:providerSubId', { guildId: G, providerId: 'dummy', providerSubId: 's1' }, {}],
  ['delete', '/:guildId/paused/:subscriptionId', { guildId: G, subscriptionId: 'p1' }, {}],
  ['delete', '/:guildId/provider-links/:providerId', { guildId: G, providerId: 'patreon' }, {}],
  ['put', '/:guildId/migrations/:migrationId', { guildId: G, migrationId: 'm1' }, { decision: 'accepted' }],
  ['put', '/:guildId/notifications-channel', { guildId: G }, { channelId: null }],
];

describe('a premium change the writing process refused', () => {
  it.each(SHARED_ROUTES)('%s %s answers the refusal once, with its status and text', async (method, route, params, body) => {
    const sent = await invoke(async () => ({ ok: false, code: 'disk' }), method, route, params, body);
    expect(sent).toEqual([{ status: 503, kind: 'json', body: { success: false, error: DISK } }]);
  });
});

describe('a premium change whose send failed', () => {
  it.each([
    ['put', '/:guildId/migrations/:migrationId', { guildId: G, migrationId: 'm1' }, { decision: 'declined' }],
    ['put', '/:guildId/notifications-channel', { guildId: G }, { channelId: null }],
  ] as Array<[string, string, Record<string, string>, unknown]>)('%s %s answers 500 with the error', async (method, route, params, body) => {
    const sent = await invoke(async () => { throw new Error('the IPC channel closed'); }, method, route, params, body);
    expect(sent).toEqual([{ status: 500, kind: 'json', body: { success: false, error: 'the IPC channel closed' } }]);
  });
});

describe('the Patreon callback', () => {
  const callback = (reply: unknown) => invoke(async () => reply, 'get', '/patreon/callback', {});

  it('answers an error page with the generic failure when the op gave no reply', async () => {
    const sent = await callback(undefined);
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe(500);
    expect(sent[0].kind).toBe('send');
    expect(String(sent[0].body)).toContain('<h2>Patreon link failed</h2><p>The change failed</p>');
  });

  it('answers a refusal with its own status, not 400', async () => {
    const sent = await callback({ ok: false, code: 'disk' });
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe(503);
    expect(String(sent[0].body)).toContain(DISK);
  });

  it('answers an invalid callback 400 with its text', async () => {
    const sent = await callback({ ok: false, code: 'invalid', error: 'The state <x> did not match' });
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe(400);
    expect(String(sent[0].body)).toContain('The state &lt;x&gt; did not match');
  });

  it('redirects on an ok reply that carries no result', async () => {
    const sent = await callback({ ok: true });
    expect(sent).toEqual([{ status: 302, kind: 'redirect', body: '/guild/undefined/subscription?subscribe=success' }]);
  });

  let app: { url: string; close: () => Promise<void> } | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('sends its error page as text/html', async () => {
    app = await startApp(a => a.use('/guild/api/subscriptions', createGuildSubscriptionRoutes({ runSharedOp: async () => ({ ok: false, code: 'disk' }) } as any)));
    const res = await fetch(`${app.url}/guild/api/subscriptions/patreon/callback?code=c&state=${G}`, { redirect: 'manual' });
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await res.text()).toContain(DISK);
  });
});
