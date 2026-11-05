import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 20: a shared op answers by the verdict over its own ledger, taken inside runSealed before the seal. In the
// web UI's local chain a refused change is dropped, so `storage-failing` answers not saved; a write that does not land
// within CONFIRM_MS answers pending and the premium route shows it as an error; one landing at 6.5 s answers ok.

const inject = vi.hoisted(() => ({ refuse: new Map<string, string>() }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  const ledger = await import('../../src/bot/internalSetup/utils/dataBackends/writeLedger');
  const guard = (filename: string, options: any) => {
    const cause = inject.refuse.get(filename);
    if (!cause) return;
    ledger.recordRefusal(cause as any, `global:${options.category ?? ''}/${filename}`);
    throw new real.DataBackendUnavailableError(cause as any);
  };
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => { guard(f, o); return real.saveDataTracked(f, o, d); },
    appendDataTracked: (f: string, o: any, l: string) => { guard(f, o); return real.appendDataTracked(f, o, l); },
  };
});
const order = vi.hoisted(() => [] as string[]);
vi.mock('../../src/bot/internalSetup/utils/dataBackends/replyGate', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/replyGate')>();
  return {
    ...real,
    verdictOf: async (ledgers: any) => {
      const verdict = await real.verdictOf(ledgers);
      order.push('verdict');
      return verdict;
    },
  };
});
const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));
const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp, PROVIDER_SENTENCE } from '../../src/bot/internalSetup/utils/sharedOps';
import { setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { WriteLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { CONFIRM_MS, truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { sharedOpRunner, webhookAnswer } from '../../src/webui/routes/hopFailure';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { freshWriterLock } from '../helpers/nb10Rig';
import { AUDIT, clearGlobal, DUMMY_STATE, gate, jsonOf, PREMIUM, quiet, rawOf, settleQueue, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const STORAGE = 'storage-failing';
const refuse = (...files: string[]) => { for (const f of files) inject.refuse.set(f, STORAGE); };

/** The premium route's answer for this reply, as sharedOpRunner sends it. */
async function routeAnswer(reply: any): Promise<{ status: number; body: any } | 'ok'> {
  let sent: { status: number; body: any } | null = null;
  const res = { status: (status: number) => ({ json: (body: unknown) => { sent = { status, body }; } }) };
  try {
    await sharedOpRunner({ runSharedOp: async () => reply })(res, 'premium.grantManual', []);
    return 'ok';
  } catch {
    return sent!;
  }
}

/** The rename onto this path waits for the gate. */
let openHeld: (() => void) | null = null;

function heldRename(absPath: string, until: Promise<unknown>): void {
  const real = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === absPath) await until;
    return real(from, to);
  }) as typeof fs.promises.rename);
}

beforeAll(() => clearGlobal());
beforeEach(async () => {
  quiet();
  inject.refuse.clear();
  order.length = 0;
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  writePremium();
});
afterEach(async () => {
  openHeld?.();
  openHeld = null;
  inject.refuse.clear();
  vi.restoreAllMocks();
  setSharedWriteGate(null);
  resetPremiumManager();
  for (const p of reg.current?.listAll() ?? []) (p as any).dispose?.();
  reg.current = null;
  await settleQueue();
  fs.rmSync(writerLockPath(), { force: true });
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('the local chain with storage-failing injected (NB10 test 20)', () => {
  beforeEach(() => {
    delete process.env.BOT_PROCESS_ROLE;
    setSharedWriteGate(() => inLocalOp());
    freshWriterLock('webui');
  });

  it('premium.grantManual answers not saved with the provider sentence, and the route says nothing was saved', async () => {
    const before = rawOf(PREMIUM);
    refuse('premium-tiers.json', 'premium-tiers.audit.jsonl');
    const reply = await new BotManager().runSharedOp('premium.grantManual', { args: ['g1', 'high', 30] });
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: STORAGE, partial: false });
    expect(reply.error).toBe(`${truthText(STORAGE, false)} ${PROVIDER_SENTENCE}`);
    const route = await routeAnswer(reply);
    expect(route).not.toBe('ok');
    expect((route as any).body).toEqual({ success: false, error: reply.error });
    expect((route as any).body.error).toContain('your change was not saved');
    await settleQueue();
    expect(rawOf(PREMIUM)).toBe(before);
    expect(rawOf(AUDIT)).toBeNull();
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });

  it('dummy.adminSetVariant answers not saved with no provider sentence, and the state file is not written', async () => {
    getPaymentRegistry().register(new DummyProvider());
    await settleQueue();
    const before = rawOf(DUMMY_STATE);
    refuse('state.json');
    const variant = { variantId: 'v9', label: 'V9', amount: 1, currency: 'USD', durationDays: 1, recurring: false, active: true };
    const reply = await new BotManager().runSharedOp('dummy.adminSetVariant', { args: [variant] });
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: STORAGE });
    expect(reply.error).toBe(truthText(STORAGE, false));
    expect((await routeAnswer(reply) as any).body.error).toBe(truthText(STORAGE, false));
    await settleQueue();
    expect(rawOf(DUMMY_STATE)).toBe(before);
  });

  it('payment.webhook answers not ok and the webhook route answers 503 with nothing claimed saved', async () => {
    getPaymentRegistry().register({
      id: 'hook', displayName: 'Hook', capabilities: {}, isConfigured: () => true,
      handleWebhook: async (body: Buffer) => { getPaymentRegistry().emitEvent(JSON.parse(body.toString())); },
    } as any);
    const event = { type: 'subscription.created', providerId: 'hook', providerSubId: 'h1', guildId: 'g5', tierId: 'low', offeringId: 'o1', state: { status: 'active', startDate: new Date().toISOString(), endDate: null, autoRenew: true } };
    refuse('premium-tiers.json', 'premium-tiers.audit.jsonl');
    const reply = await new BotManager().runSharedOp('payment.webhook', { providerId: 'hook', body: Buffer.from(JSON.stringify(event)).toString('base64') });
    expect(reply).toMatchObject({ ok: false, answer: STORAGE });
    const answer = webhookAnswer(reply);
    expect(answer.status).toBe(503);
    expect(answer.body.error).toBe(`${truthText(STORAGE, false)} ${PROVIDER_SENTENCE}`);
    await settleQueue();
    expect(jsonOf(PREMIUM).subscriptions.g5).toBeUndefined();
  });
});

describe('the verdict bound and its place (NB10 test 20)', () => {
  beforeEach(() => { process.env.BOT_PROCESS_ROLE = 'bot'; });

  it(`a premium save not landed within CONFIRM_MS (${CONFIRM_MS} ms) answers pending, and the premium route shows it as an error`, async () => {
    expect(CONFIRM_MS).toBe(8000);
    const held = gate();
    openHeld = () => held.open();
    heldRename(PREMIUM, held.promise);
    const started = Date.now();
    const reply: any = await applySharedOp({ op: 'premium.setMessages', args: { args: [{ moduleBlocked: 'later' }] } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(CONFIRM_MS - 100);
    // The change's audit line landed, so the answer says "in full".
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'pending', partial: true });
    expect(reply.error).toBe(`Your change is not confirmed as saved in full yet. What was saved: premium-tiers.audit.jsonl. Reload to see it before you try again: trying again could apply the saved part twice. ${PROVIDER_SENTENCE}`);
    const route = await routeAnswer(reply);
    expect(route).not.toBe('ok');
    expect((route as any).status).toBe(503);
    expect((route as any).body).toEqual({ success: false, error: reply.error });
    held.open();
    await settleQueue();
    expect(jsonOf(PREMIUM).messages.moduleBlocked).toBe('later');
  }, 20_000);

  it('a premium save landing at 6.5 s answers ok', async () => {
    const held = gate();
    heldRename(PREMIUM, held.promise);
    setTimeout(() => held.open(), 6500);
    const reply: any = await applySharedOp({ op: 'premium.setMessages', args: { args: [{ moduleBlocked: 'soon' }] } });
    expect(reply).toMatchObject({ ok: true });
    expect(jsonOf(PREMIUM).messages.moduleBlocked).toBe('soon');
  }, 20_000);

  it('the verdict is taken before the op ledger is sealed', async () => {
    const realSeal = WriteLedger.prototype.seal;
    vi.spyOn(WriteLedger.prototype, 'seal').mockImplementation(function (this: WriteLedger) {
      order.push('seal');
      return realSeal.call(this);
    });
    const reply: any = await applySharedOp({ op: 'premium.setMessages', args: { args: [{ moduleBlocked: 'x' }] } });
    expect(reply).toMatchObject({ ok: true });
    expect(order.indexOf('verdict')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('verdict')).toBeLessThan(order.indexOf('seal'));
  });
});
