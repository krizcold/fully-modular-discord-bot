import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 31, for P7's link (sheet P7, 4.2): the Patreon callback runs in the process that writes premium, and only
// in the session that started the link. With a child at shared it sends one payment.oauthCallback naming the session's
// Discord user and the web UI's registry raises no event; with no child the op runs in the local chain and
// premium-tiers.json holds the link before the page answers.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
const reg = vi.hoisted(() => ({ emitted: [] as any[], listeners: [] as Array<(e: any) => void> }));
const LINK = vi.hoisted(() => ({ user: '80000000000000001', nonce: 'n0nce', expires: Date.parse('2099-01-01T00:00:00.000Z') }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const patreon = {
    id: 'patreon',
    displayName: 'Patreon',
    capabilities: { sells: ['guild', 'user'] },
    isConfigured: () => true,
    readLinkState: (state: unknown) => (typeof state === 'string' && state.startsWith('guild:')
      ? { u: LINK.user, h: state, n: LINK.nonce, x: LINK.expires }
      : null),
    handleOAuthCallback: async (query: Record<string, string>) => ({
      patreonUserId: query.code === 'other' ? 'acct-2' : 'acct-1', memberId: null, holder: query.state, membership: 'none',
    }),
    checkOwner: async () => ({ kind: 'owner', name: 'Server' }),
    readAfterLink: async () => ({ kind: 'failed', reason: 'not read', recheck: false }),
  };
  return {
    ...(await orig<any>()),
    getPaymentRegistry: () => ({
      on: (type: string, fn: (e: any) => void) => { if (type === 'provider.event') reg.listeners.push(fn); },
      off: () => undefined,
      list: () => [patreon],
      startTickers: () => undefined,
      get: (id: string) => (id === 'patreon' ? patreon : undefined),
      emitEvent: (event: any) => { reg.emitted.push(event); for (const fn of reg.listeners) fn(event); },
    }),
  };
});

import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { createGuildSubscriptionRoutes } from '../../src/webui/routes/guildSubscriptions';
import { flushAll, setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { dataPath } from '../../src/utils/dataRoot';
import { forks } from '../helpers/forkMock';
import { put, readJson, startApp } from '../helpers/configRig';
import { answering, exitChild, freshWriterLock, quiet, resetForks, sentTo, startedWith } from '../helpers/nb10Rig';
import { gh } from '../helpers/p1Holder';

const G = '123456789012345678';
const TIERS = () => dataPath('global', 'premium-tiers.json');
const SEED = { tiers: { gold: { id: 'gold', displayName: 'Gold', priority: 10, overrides: {}, offerings: [{ id: 'o1', label: 'Monthly', providers: { patreon: { variantId: 'v1' } } }] } }, subscriptions: {}, messages: {} };

let app: { url: string; close: () => Promise<void> } | null = null;
/** The callback in the session that started the link for the server: the signed-in user and the kept nonce. */
async function callback(manager: BotManager, code = 'abc'): Promise<{ status: number; location: string | null; text: string }> {
  app = await startApp(a => {
    a.use((req: any, _res, next) => {
      req.user = { id: LINK.user };
      req.isAuthenticated = () => true;
      req.session = { patreonLink: { nonce: LINK.nonce, holder: gh(G), expires: LINK.expires } };
      next();
    });
    a.use('/guild/api/subscriptions', createGuildSubscriptionRoutes(manager));
  });
  const res = await fetch(`${app.url}/guild/api/subscriptions/patreon/callback?code=${code}&state=${gh(G)}`, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}

beforeEach(async () => {
  quiet();
  resetForks();
  freshWriterLock('webui');
  reg.emitted.length = 0;
  setSharedWriteGate(() => inLocalOp());
  await flushAll();
  put(TIERS(), SEED);
});

afterEach(async () => {
  await app?.close();
  app = null;
  setSharedWriteGate(null);
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  vi.restoreAllMocks();
});

describe('the Patreon callback with a child at shared', () => {
  it("sends one payment.oauthCallback with the session's user, raises no event here, and answers the linked page on an ok answer", async () => {
    const before = fs.readFileSync(TIERS(), 'utf8');
    const { manager, child } = await startedWith([{ stage: 'shared' }]);
    answering(child, m => (m.type === 'shared:op'
      ? { ok: true, result: { linked: gh(G), where: 'the server Server', pledge: 'none', recheck: false, paid: [], trial: false, held: [] } }
      : undefined));
    const reply = await callback(manager);
    expect(reply.status).toBe(200);
    expect(reply.location).toBe(null);
    expect(reply.text).toContain('<h2>Patreon linked</h2><p>Your Patreon account now backs the server Server.');
    const ops = sentTo(child, 'shared:op');
    expect(ops.map(m => m.data.op)).toEqual(['payment.oauthCallback']);
    expect(ops[0].data.args).toMatchObject({ providerId: 'patreon', query: { code: 'abc', state: gh(G) }, userId: LINK.user });
    expect(reg.emitted).toEqual([]);
    await flushAll();
    expect(fs.readFileSync(TIERS(), 'utf8')).toBe(before);
  });

  it('a Patreon account linked to another Discord account renders PT16, naming no server', async () => {
    const { manager, child } = await startedWith([{ stage: 'shared' }]);
    answering(child, () => ({ ok: true, result: { refused: 'linked-elsewhere' } }));
    const reply = await callback(manager);
    expect(reply.status).toBe(409);
    expect(reply.text).toBe('<h2>Patreon account already linked</h2><p>This Patreon account is linked to another Discord account, so nothing was linked. That account unlinks it first.</p>');
    expect(reply.location).toBe(null);
  });

  it('a not-ok answer renders its text and no redirect', async () => {
    const { manager, child } = await startedWith([{ stage: 'shared' }]);
    answering(child, () => ({ ok: false, code: 'unconfirmed', answer: 'storage-failing', error: 'The disk is refusing writes; nothing was saved.' }));
    const reply = await callback(manager);
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.text).toContain('The disk is refusing writes; nothing was saved.');
    expect(reply.location).toBe(null);
  });
});

describe('the Patreon callback with no child', () => {
  it('runs in the local chain; premium-tiers.json holds the link, made by the session user, before the page answers', async () => {
    const reply = await callback(new BotManager());
    const stored = readJson(TIERS());
    expect(reply.status).toBe(200);
    expect(stored.providerAccountLinks?.patreon).toEqual({ 'acct-1': { holder: gh(G), buyerId: LINK.user } });
    expect(fs.existsSync(dataPath('.writer.lock'))).toBe(false);
  });
});
