import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 29 (rounds 5 and 6), the child's half: the bot process's own answers to a premium op carry the provider
// sentence, from the real applySharedOp with the refusal injected on premium-tiers.json; a Dummy op's do not.
// nb10Texts.test.ts holds BotManager's rewording of these answers after a stop or a restart.

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
const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

import { resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp, PROVIDER_SENTENCE } from '../../src/bot/internalSetup/utils/sharedOps';
import { truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { clearGlobal, paidSub, quiet, settleQueue, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;

beforeEach(async () => {
  quiet();
  inject.refuse.clear();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  process.env.BOT_PROCESS_ROLE = 'bot';
});
afterEach(async () => {
  inject.refuse.clear();
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

describe("the child's own answers (NB10 test 29)", () => {
  it('a held premium.grantManual ends with the provider sentence', async () => {
    writePremium();
    inject.refuse.set('premium-tiers.json', 'storage-failing');
    inject.refuse.set('premium-tiers.audit.jsonl', 'storage-failing');
    const reply: any = await applySharedOp({ op: 'premium.grantManual', args: { args: ['g1', 'high', 30] } });
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'held' });
    expect(reply.error).toBe(`${truthText('held', false)} ${PROVIDER_SENTENCE}`);
  });

  it('a premium.cancelPaidSubscriptionImmediately refused node-stopping after its provider call ends with the provider sentence', async () => {
    writePremium({ g2: { active: paidSub('s2', 'ps2', 'low', 'quick'), paused: [] } });
    getPaymentRegistry().register({
      id: 'quick', displayName: 'Quick', capabilities: { supportsCancel: true }, isConfigured: () => true,
      cancelSubscription: async () => undefined,
    } as any);
    inject.refuse.set('premium-tiers.json', 'node-stopping');
    inject.refuse.set('premium-tiers.audit.jsonl', 'node-stopping');
    const reply: any = await applySharedOp({ op: 'premium.cancelPaidSubscriptionImmediately', args: { args: ['g2'] } });
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'node-stopping' });
    expect(reply.error.endsWith(` ${PROVIDER_SENTENCE}`)).toBe(true);
    expect(reply.error.startsWith(truthText('node-stopping', false))).toBe(true);
  });

  it('a held Dummy op has no provider sentence', async () => {
    getPaymentRegistry().register(new DummyProvider());
    await settleQueue();
    inject.refuse.set('state.json', 'storage-failing');
    const variant = { variantId: 'v9', label: 'V9', amount: 1, currency: 'USD', durationDays: 1, recurring: false, active: true };
    const reply: any = await applySharedOp({ op: 'dummy.adminSetVariant', args: { args: [variant] } });
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'held' });
    expect(reply.error).toBe(truthText('held', false));
  });
});
