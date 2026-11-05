import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 31: the Patreon callback runs in the process that writes premium. With a child at shared it sends one
// payment.oauthCallback and the web UI's registry raises no event; with no child the op runs in the local chain and
// premium-tiers.json holds the link and the subscription before the redirect.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
const reg = vi.hoisted(() => ({ emitted: [] as any[], listeners: [] as Array<(e: any) => void> }));
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
    handleOAuthCallback: async (query: Record<string, string>) => ({
      externalAccountId: query.code === 'other' ? 'acct-2' : 'acct-1', guildId: query.state, tierId: 'gold', offeringId: 'o1', variantId: 'v1', state: 'active',
    }),
  };
  return {
    ...(await orig<any>()),
    getPaymentRegistry: () => ({
      on: (_type: string, fn: (e: any) => void) => { reg.listeners.push(fn); },
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

const G = '123456789012345678';
const TIERS = () => dataPath('global', 'premium-tiers.json');
const SEED = { tiers: { gold: { id: 'gold', displayName: 'Gold', priority: 10, overrides: {}, offerings: [{ id: 'o1', label: 'Monthly', providers: { patreon: { variantId: 'v1' } } }] } }, subscriptions: {}, messages: {} };

let app: { url: string; close: () => Promise<void> } | null = null;
async function callback(manager: BotManager, code = 'abc'): Promise<{ status: number; location: string | null; text: string }> {
  app = await startApp(a => a.use('/guild/api/subscriptions', createGuildSubscriptionRoutes(manager)));
  const res = await fetch(`${app.url}/guild/api/subscriptions/patreon/callback?code=${code}&state=${G}`, { redirect: 'manual' });
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
  it('sends one payment.oauthCallback, raises no event here, and redirects on an ok answer', async () => {
    const before = fs.readFileSync(TIERS(), 'utf8');
    const { manager, child } = await startedWith([{ stage: 'shared' }]);
    answering(child, m => (m.type === 'shared:op' ? { ok: true, result: { linked: G } } : undefined));
    const reply = await callback(manager);
    expect(reply.status).toBe(302);
    expect(reply.location).toBe(`/guild/${G}/subscription?subscribe=success`);
    const ops = sentTo(child, 'shared:op');
    expect(ops.map(m => m.data.op)).toEqual(['payment.oauthCallback']);
    expect(ops[0].data.args).toMatchObject({ providerId: 'patreon', query: { code: 'abc', state: G } });
    expect(reg.emitted).toEqual([]);
    await flushAll();
    expect(fs.readFileSync(TIERS(), 'utf8')).toBe(before);
  });

  it('linkedElsewhere renders the 409 page', async () => {
    const { manager, child } = await startedWith([{ stage: 'shared' }]);
    answering(child, () => ({ ok: true, result: { linkedElsewhere: '999999999999999999' } }));
    const reply = await callback(manager);
    expect(reply.status).toBe(409);
    expect(reply.text).toContain('999999999999999999');
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
  it('runs in the local chain; premium-tiers.json holds the link and the subscription before the redirect', async () => {
    const reply = await callback(new BotManager());
    const stored = readJson(TIERS());
    expect(reply.status).toBe(302);
    expect(stored.providerAccountLinks?.patreon).toEqual({ 'acct-1': G });
    expect(JSON.stringify(stored.subscriptions?.[G] ?? stored.subscriptions)).toContain(`patreon:acct-1:${G}`);
    expect(fs.existsSync(dataPath('.writer.lock'))).toBe(false);
  });
});
