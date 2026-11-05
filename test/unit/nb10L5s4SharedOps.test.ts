import fs from 'fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 mutation gate, chunk 4 of sharedOps.ts: the refusals each shared op answers on missing or bad arguments
// (with their texts, and nothing written), the payment ops' defaults, the OAuth link to the same or another guild,
// the settler an op waits on, and the Dummy cache the local chain drops after an op that was not ok.

const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

import { dataPath } from '../../src/utils/dataRoot';
import { shaOfRaw, CHANGED_TEXT } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { getPremiumManager, resetPremiumManager, settlePremiumInstalls } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { applySharedOp, globalTarget, invalidateSharedCaches, setOpSettler } from '../../src/bot/internalSetup/utils/sharedOps';
import { clearGlobal, jsonOf, PREMIUM, quiet, rawOf, settleQueue, state, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const STATE = dataPath('global', 'payment-providers', 'dummy', 'state.json');
const made: DummyProvider[] = [];

beforeEach(async () => {
  quiet();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  process.env.BOT_PROCESS_ROLE = 'bot';
});
afterEach(async () => {
  setOpSettler(settlePremiumInstalls);
  for (const p of made.splice(0)) p.dispose();
  resetPremiumManager();
  for (const p of reg.current?.listAll() ?? []) (p as any).dispose?.();
  reg.current = null;
  await settleQueue();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('global.write refuses a bad request with its own text and writes nothing', () => {
  it('a rel that starts with a slash names no file', async () => {
    expect(globalTarget({ rel: '/nb10mod/x.json' })).toBeNull();
    const reply = await applySharedOp({ op: 'global.write', args: { rel: '/nb10mod/x.json', contentJson: '{"a":1}', expectSha: 'absent' } });
    expect(reply).toEqual({ ok: false, code: 'invalid', error: 'invalid global file' });
    await settleQueue();
    expect(fs.existsSync(dataPath('global', 'nb10mod', 'x.json'))).toBe(false);
  });

  it('a rel that is not a .json names no file', async () => {
    expect(globalTarget({ rel: 'nb10mod/x.txt' })).toBeNull();
    const reply = await applySharedOp({ op: 'global.write', args: { rel: 'nb10mod/x.txt', contentJson: '{"a":1}', expectSha: 'absent' } });
    expect(reply).toEqual({ ok: false, code: 'invalid', error: 'invalid global file' });
    await settleQueue();
    expect(fs.existsSync(dataPath('global', 'nb10mod', 'x.txt'))).toBe(false);
  });

  it('a request with no arguments answers invalid global file', async () => {
    expect(await applySharedOp({ op: 'global.write' })).toEqual({ ok: false, code: 'invalid', error: 'invalid global file' });
  });

  it('a request with no contentJson answers contentJson is required', async () => {
    const reply = await applySharedOp({ op: 'global.write', args: { rel: 'nb10mod/x.json', expectSha: 'absent' } });
    expect(reply).toEqual({ ok: false, code: 'invalid', error: 'contentJson is required' });
  });

  it('a request with no expectSha answers expectSha is required and leaves the file as it was', async () => {
    const file = dataPath('global', 'nb10mod', 'x.json');
    fs.mkdirSync(dataPath('global', 'nb10mod'), { recursive: true });
    fs.writeFileSync(file, '{"a":1}');
    const reply = await applySharedOp({ op: 'global.write', args: { rel: 'nb10mod/x.json', contentJson: '{"a":2}' } });
    expect(reply).toEqual({ ok: false, code: 'invalid', error: 'expectSha is required' });
    await settleQueue();
    expect(rawOf(file)).toBe('{"a":1}');
  });
});

describe('the settler an op waits on', () => {
  it('setOpSettler replaces it: the op calls the new one with its ledger, and null calls none', async () => {
    const settler = vi.fn(async () => undefined);
    setOpSettler(settler);
    const ok = await applySharedOp({ op: 'global.write', args: { rel: 'nb10mod/s.json', contentJson: '{"s":1}', expectSha: 'absent' } });
    expect(ok).toMatchObject({ ok: true });
    expect(settler).toHaveBeenCalledTimes(1);
    setOpSettler(null);
    await settleQueue();
    const again = await applySharedOp({ op: 'global.write', args: { rel: 'nb10mod/s.json', contentJson: '{"s":2}', expectSha: shaOfRaw('{"s":1}') } });
    expect(again).toMatchObject({ ok: true });
    expect(settler).toHaveBeenCalledTimes(1);
  });
});

describe('invalidateSharedCaches drops the Dummy cache', () => {
  it('a state.json fixed after it could not be read is read again at once', () => {
    fs.mkdirSync(dataPath('global', 'payment-providers', 'dummy'), { recursive: true });
    fs.writeFileSync(STATE, '{ broken');
    const dummy = new DummyProvider();
    made.push(dummy);
    expect(dummy.cannotReadText()).toMatch(/cannot be read/);
    fs.writeFileSync(STATE, JSON.stringify({ variants: {}, products: {}, coupons: {}, subscriptions: {}, nextId: 1 }));
    expect(dummy.cannotReadText()).toMatch(/cannot be read/);
    invalidateSharedCaches();
    expect(dummy.cannotReadText()).toBeNull();
  });
});

describe('dummy ops while the Dummy provider is not registered', () => {
  it('no dummy provider answers The Dummy provider is not registered', async () => {
    writePremium();
    const reply = await applySharedOp({ op: 'dummy.adminDeleteVariant', args: { args: ['v1'] } });
    expect(reply).toEqual({ ok: false, code: 'invalid', error: 'The Dummy provider is not registered' });
  });

  it('a provider named dummy that has no admin methods is refused the same way, and its methods are not called', async () => {
    writePremium();
    const del = vi.fn(() => true);
    getPaymentRegistry().register({ id: 'dummy', displayName: 'Not the Dummy', capabilities: {}, isConfigured: () => true, adminDeleteVariant: del } as any);
    const reply = await applySharedOp({ op: 'dummy.adminDeleteVariant', args: { args: ['v1'] } });
    expect(reply).toEqual({ ok: false, code: 'invalid', error: 'The Dummy provider is not registered' });
    expect(del).not.toHaveBeenCalled();
  });
});

describe('payment.webhook', () => {
  it('a request with no arguments names the provider it could not find', async () => {
    writePremium();
    expect(await applySharedOp({ op: 'payment.webhook' })).toEqual({ ok: false, code: 'invalid', error: 'Unknown provider or no webhook handler: undefined' });
  });

  it('no body and no signature reach the provider as an empty body and an empty signature', async () => {
    writePremium();
    const seen: Array<{ body: Buffer; signature: string }> = [];
    getPaymentRegistry().register({
      id: 'hook', displayName: 'Hook', capabilities: {}, isConfigured: () => true,
      handleWebhook: async (body: Buffer, signature: string) => { seen.push({ body, signature }); },
    } as any);
    const reply = await applySharedOp({ op: 'payment.webhook', args: { providerId: 'hook', body: 42, signature: 7 } });
    expect(reply).toEqual({ ok: true, result: { received: true } });
    expect(seen).toHaveLength(1);
    expect(seen[0].body.length).toBe(0);
    expect(seen[0].signature).toBe('');
  });
});

describe('payment.oauthCallback', () => {
  it('a request with no arguments answers that patreon is not configured', async () => {
    writePremium();
    expect(await applySharedOp({ op: 'payment.oauthCallback' })).toEqual({ ok: false, code: 'invalid', error: 'patreon is not configured on this bot.' });
  });

  const registerOAuth = (guildId: string) => getPaymentRegistry().register({
    id: 'oauthy', displayName: 'OAuthy', capabilities: {}, isConfigured: () => true,
    handleOAuthCallback: async () => ({ externalAccountId: 'ext1', guildId, tierId: 'low', offeringId: 'o1', variantId: 'v1', state: state() }),
  } as any);

  it('an account already linked to the same guild is linked again and announced', async () => {
    writePremium({}, { providerAccountLinks: { oauthy: { ext1: 'g1' } } });
    registerOAuth('g1');
    const events: any[] = [];
    getPaymentRegistry().on('provider.event', (e: any) => events.push(e));
    const reply = await applySharedOp({ op: 'payment.oauthCallback', args: { providerId: 'oauthy', query: {} } });
    expect(reply).toEqual({ ok: true, result: { linked: 'g1' } });
    expect(events.map(e => [e.type, e.guildId, e.providerSubId])).toEqual([['subscription.created', 'g1', 'oauthy:ext1:g1']]);
  });

  it('an account linked to another guild answers linkedElsewhere and keeps the stored link', async () => {
    writePremium({}, { providerAccountLinks: { oauthy: { ext1: 'g2' } } });
    registerOAuth('g1');
    const events: any[] = [];
    getPaymentRegistry().on('provider.event', (e: any) => events.push(e));
    const reply = await applySharedOp({ op: 'payment.oauthCallback', args: { providerId: 'oauthy', query: {} } });
    expect(reply).toEqual({ ok: true, result: { linkedElsewhere: 'g2' } });
    expect(events).toEqual([]);
    await settleQueue();
    expect(jsonOf(PREMIUM).providerAccountLinks).toEqual({ oauthy: { ext1: 'g2' } });
  });
});

describe('premium.setGlobalModuleConfig refuses a bad request and saves nothing', () => {
  const rel = 'nb10mod/config.json';
  const file = () => dataPath('global', 'nb10mod', 'config.json');
  const put = (raw: string) => {
    fs.mkdirSync(dataPath('global', 'nb10mod'), { recursive: true });
    fs.writeFileSync(file(), raw);
  };

  it('a request with no arguments answers moduleName is required', async () => {
    writePremium();
    expect(await applySharedOp({ op: 'premium.setGlobalModuleConfig' })).toEqual({ ok: false, code: 'invalid', error: 'moduleName is required' });
  });

  it('a request with a rel but no expectSha answers expectSha is required', async () => {
    writePremium();
    put('{"a":1}');
    const reply = await applySharedOp({ op: 'premium.setGlobalModuleConfig', args: { moduleName: 'nb10mod', rel, partial: { values: { a: 2 } } } });
    expect(reply).toEqual({ ok: false, code: 'invalid', error: 'expectSha is required' });
    await settleQueue();
    expect(rawOf(file())).toBe('{"a":1}');
  });

  it('a rel that names no global file answers invalid global file', async () => {
    writePremium();
    const reply = await applySharedOp({ op: 'premium.setGlobalModuleConfig', args: { moduleName: 'nb10mod', rel: '/nb10mod/config.json', expectSha: 'absent', partial: {} } });
    expect(reply).toEqual({ ok: false, code: 'invalid', error: 'invalid global file' });
  });

  it('a file that changed since the read answers changed and keeps its bytes', async () => {
    writePremium();
    put('{"a":1}');
    const reply = await applySharedOp({ op: 'premium.setGlobalModuleConfig', args: { moduleName: 'nb10mod', rel, expectSha: 'absent', partial: { values: { a: 2 } } } });
    expect(reply).toEqual({ ok: false, code: 'changed', error: CHANGED_TEXT });
    await settleQueue();
    expect(rawOf(file())).toBe('{"a":1}');
  });

  it('a file that is not valid JSON answers so by module name and keeps its bytes', async () => {
    writePremium();
    put('{ broken');
    const reply = await applySharedOp({ op: 'premium.setGlobalModuleConfig', args: { moduleName: 'nb10mod', rel, expectSha: shaOfRaw('{ broken'), partial: { values: { a: 2 } } } });
    expect(reply).toEqual({ ok: false, code: 'invalid', error: 'the global settings of nb10mod are not valid JSON' });
    await settleQueue();
    expect(rawOf(file())).toBe('{ broken');
  });
});

describe('the other premium ops', () => {
  it('a method the premium manager does not have answers unknown premium op', async () => {
    writePremium();
    (getPremiumManager() as any).setMessages = undefined;
    expect(await applySharedOp({ op: 'premium.setMessages', args: { args: [{}] } })).toEqual({ ok: false, code: 'invalid', error: 'unknown premium op setMessages' });
  });

  it('no arguments, or arguments that are not a list, call the method with none', async () => {
    writePremium();
    const fn = vi.fn((..._a: unknown[]) => true);
    (getPremiumManager() as any).setMessages = fn;
    expect(await applySharedOp({ op: 'premium.setMessages' })).toEqual({ ok: true, result: true });
    expect(await applySharedOp({ op: 'premium.setMessages', args: { args: 'not a list' } })).toEqual({ ok: true, result: true });
    expect(fn.mock.calls).toEqual([[], []]);
  });
});
