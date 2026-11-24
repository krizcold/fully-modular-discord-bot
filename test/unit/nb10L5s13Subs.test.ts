import { afterEach, describe, expect, it, vi } from 'vitest';

// The guild subscription routes run premium changes through the process that writes premium. A refusal is answered
// once, with the refusal's status and text; any other error answers 500 with its message; the Patreon callback
// answers its error page as HTML.

const LINK = vi.hoisted(() => ({ user: 'u1', state: 'S', link: { nonce: 'n0nce', holder: 'guild:123456789012345678', expires: Date.parse('2099-01-01T00:00:00.000Z') } }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const patreon = {
    id: 'patreon',
    displayName: 'Patreon',
    handleOAuthCallback: async () => ({}),
    readLinkState: (state: unknown) => (state === LINK.state ? { u: LINK.user, h: LINK.link.holder, n: LINK.link.nonce, x: LINK.link.expires } : null),
  };
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
async function invoke(reply: () => Promise<unknown>, method: string, route: string, params: Record<string, string>, body: unknown = {}, extra: Record<string, unknown> = {}): Promise<Sent[]> {
  const router: any = createGuildSubscriptionRoutes({ runSharedOp: async () => reply() } as any);
  const layer = router.stack.find((l: any) => l.route && l.route.path === route && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${route}`);
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  const { res, sent } = fakeRes();
  const req = { params, body, query: {}, user: { id: LINK.user }, protocol: 'http', get: () => 'host', ...extra };
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
  ['delete', '/:guildId/provider-links/:providerId', { guildId: G, providerId: 'dummy' }, {}],
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
  /** The callback in the session that started the link (sheet P7, 4.2 step 2). */
  const started = () => ({ query: { code: 'c', state: LINK.state }, isAuthenticated: () => true, session: { patreonLink: { ...LINK.link } } });
  const callback = (reply: unknown) => invoke(async () => reply, 'get', '/patreon/callback', {}, {}, started());

  it('answers PT15 and runs no op when the session did not start this link, or was already used', async () => {
    let ran = 0;
    const op = async () => { ran += 1; return { ok: true }; };
    const PT15 = '<h2>Patreon link not completed</h2><p>This link was started from another sign-in, more than 10 minutes ago, or was already used, so nothing was linked. Sign in with Discord on this site and start the link again.</p>';
    const once = started();
    const pages = [
      ...await invoke(op, 'get', '/patreon/callback', {}, {}, { ...started(), session: {} }),
      ...await invoke(op, 'get', '/patreon/callback', {}, {}, { ...started(), user: { id: 'u2' } }),
      ...await invoke(op, 'get', '/patreon/callback', {}, {}, once),
      ...await invoke(op, 'get', '/patreon/callback', {}, {}, once),
    ];
    expect(pages.map(p => [p.status, p.body])).toEqual([[400, PT15], [400, PT15], [502, expect.any(String)], [400, PT15]]);
    expect(ran).toBe(1);
  });

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

  const NOT_CONFIRMED = "<h2>Patreon link not confirmed</h2><p>Can't confirm whether your Patreon account was linked: the bot's answer did not say what it linked. Open your subscription page to see whether the link is there before you start it again.</p>";

  it.each([
    ['carries no result', { ok: true }],
    ['names a linked text that is no holder key', { ok: true, result: { linked: '123456789012345678', where: 'your own VIP' } }],
    ['names a holder but no place in words', { ok: true, result: { linked: 'user:123456789012345678' } }],
    ['names an empty linked text', { ok: true, result: { linked: '', where: 'your own VIP' } }],
  ])("answers the can't confirm page on an ok reply that %s", async (_what, reply) => {
    const sent = await callback(reply);
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe(502);
    expect(sent[0].kind).toBe('send');
    expect(String(sent[0].body)).toContain(NOT_CONFIRMED);
  });

  it('answers the linked page for a linked holder key, with a link back to the server', async () => {
    const sent = await callback({ ok: true, result: { linked: 'guild:123456789012345678', where: 'the server <b>', pledge: 'none', recheck: true, paid: [], trial: false, held: [] } });
    expect(sent).toEqual([{
      status: 200,
      kind: 'send',
      type: 'html',
      body: '<h2>Patreon linked</h2><p>Your Patreon account now backs the server &lt;b&gt;. The bot gives the tier your pledge pays for while Patreon shows it as paid.</p>'
        + '<p>Patreon shows no paid pledge to this creator on your account now.</p><p><a href="/guild/123456789012345678/subscription">Back to the server page</a></p>',
    }]);
  });

  it('answers PT16 (409) for a Patreon account linked to another Discord account, naming no server', async () => {
    const sent = await callback({ ok: true, result: { refused: 'linked-elsewhere' } });
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe(409);
    expect(String(sent[0].body)).not.toContain('123456789012345678');
  });

  let app: { url: string; close: () => Promise<void> } | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('sends its error page as text/html', async () => {
    app = await startApp(a => {
      a.use((req: any, _res, next) => {
        req.user = { id: LINK.user };
        req.isAuthenticated = () => true;
        req.session = { patreonLink: { ...LINK.link } };
        next();
      });
      a.use('/guild/api/subscriptions', createGuildSubscriptionRoutes({ runSharedOp: async () => ({ ok: false, code: 'disk' }) } as any));
    });
    const res = await fetch(`${app.url}/guild/api/subscriptions/patreon/callback?code=c&state=${LINK.state}`, { redirect: 'manual' });
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await res.text()).toContain(DISK);
  });
});
