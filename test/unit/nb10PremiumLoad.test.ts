import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 25 (decision 12): a premium-tiers.json or Dummy state.json that cannot be read or parsed answers the
// defaults, refuses changes and is never overwritten; an absent one is written by the first save; the bot's cache is
// current and never reloaded by its own save; the web UI reloads a file another writer changed.

const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

import { getPremiumManager, resetPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { clearGlobal, DUMMY_STATE, JOURNAL, jsonOf, logged, PREMIUM, quiet, rawOf, settleQueue, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const asBot = (bot: boolean) => {
  if (bot) process.env.BOT_PROCESS_ROLE = 'bot';
  else delete process.env.BOT_PROCESS_ROLE;
};
const gold = { displayName: 'Gold', priority: 5, overrides: {}, offerings: [] };

let spies: ReturnType<typeof quiet>;
beforeAll(() => clearGlobal());
beforeEach(async () => {
  spies = quiet();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  asBot(false);
});
afterEach(async () => {
  resetPremiumManager();
  for (const p of reg.current?.listAll() ?? []) (p as any).dispose?.();
  reg.current = null;
  vi.useRealTimers();
  await settleQueue();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe.each([['the web UI', false], ['the bot', true]])('premium-tiers.json that cannot be read, in %s', (_name, bot) => {
  it('invalid JSON: Free in every guild, the cause logged once, ops refused, the file left byte for byte', async () => {
    asBot(bot);
    fs.writeFileSync(PREMIUM, '{"tiers": {');
    const pm = getPremiumManager();
    for (let i = 0; i < 3; i++) expect(pm.resolveActiveTier('g1').tierId).toBe('free');
    expect(logged(spies.error).filter(l => l.includes('premium-tiers.json cannot be read (invalid JSON'))).toHaveLength(1);
    const reply = await applySharedOp({ op: 'premium.setTier', args: { args: ['gold', gold] } });
    expect(reply).toMatchObject({ ok: false, code: 'failed' });
    expect((reply as any).error).toMatch(/^premium-tiers\.json cannot be read \(invalid JSON.*nothing was saved\. Fix or restore the file, then try again\.$/);
    const command = await runSealed('interaction', null, 'mod', async ledger => {
      const saved = await pm.grantManual('g1', 'free', 3);
      return { saved, verdict: await verdictOf([ledger]) };
    });
    expect(command.saved).toBe(false);
    expect(command.verdict).toMatchObject({ ok: false, answer: 'io' });
    await settleQueue();
    expect(rawOf(PREMIUM)).toBe('{"tiers": {');
  });

  it('a file that cannot be read (a directory in its place) answers Free and names the errno', async () => {
    asBot(bot);
    fs.mkdirSync(PREMIUM);
    const pm = getPremiumManager();
    expect(pm.resolveActiveTier('g1').tierId).toBe('free');
    const reply = await applySharedOp({ op: 'premium.setMessages', args: { args: [{ moduleBlocked: 'x' }] } });
    expect((reply as any).error).toMatch(/^premium-tiers\.json cannot be read \(E[A-Z]+\)/);
    expect(fs.statSync(PREMIUM).isDirectory()).toBe(true);
  });
});

describe('an absent premium-tiers.json', () => {
  it('a load writes nothing; the first save writes it', async () => {
    const pm = getPremiumManager();
    expect(pm.getAllTiers().free).toBeTruthy();
    await settleQueue();
    expect(rawOf(PREMIUM)).toBeNull();
    expect(await applySharedOp({ op: 'premium.setTier', args: { args: ['gold', gold] } })).toMatchObject({ ok: true });
    expect(jsonOf(PREMIUM).tiers.gold.displayName).toBe('Gold');
  });
});

describe('the journal that cannot be read, beside a premium-tiers.json that parses', () => {
  it('the bot names the journal and its errno, never premium-tiers.json, and does not say to restore a file', async () => {
    writePremium({ g1: { active: { id: 's1', tierId: 'high', source: 'manual', startDate: new Date().toISOString(), endDate: null, autoRenew: false, status: 'active', createdAt: '', updatedAt: '' }, paused: [] } });
    fs.mkdirSync(JOURNAL);
    asBot(true);
    const pm = getPremiumManager();
    expect(pm.resolveActiveTier('g1').tierId).toBe('free');
    const lines = logged(spies.error).filter(l => l.includes('cannot be read'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[PremiumManager\] premium-tiers\.events\.jsonl cannot be read \(E[A-Z]+\)/);
    const reply: any = await applySharedOp({ op: 'premium.setTier', args: { args: ['gold', gold] } });
    expect(reply.error).toMatch(/^premium-tiers\.events\.jsonl cannot be read \(E[A-Z]+\); nothing was saved\. Make that file readable \(premium-tiers\.json itself is fine\), then try again\.$/);
    expect(reply.error).not.toMatch(/restore/);
  });

  it('the web UI reads the same files into a working cache', async () => {
    writePremium({ g1: { active: { id: 's1', tierId: 'high', source: 'manual', startDate: new Date().toISOString(), endDate: null, autoRenew: false, status: 'active', createdAt: '', updatedAt: '' }, paused: [] } });
    fs.mkdirSync(JOURNAL);
    expect(getPremiumManager().resolveActiveTier('g1').tierId).toBe('high');
  });
});

describe('the cache of the lock holder and of the web UI', () => {
  it('the bot never reloads, so a file changed under it does not replace the cache its own save wrote', async () => {
    asBot(true);
    const pm = getPremiumManager();
    expect(pm.setTier('gold', gold)).toBe(true);
    await settleQueue();
    writePremium();
    expect(pm.getTier('gold')?.displayName).toBe('Gold');
  });

  it('the web UI keeps its own queued save and reloads a file another writer changed', async () => {
    const pm = getPremiumManager();
    expect(pm.setTier('gold', gold)).toBe(true);
    expect(pm.getTier('gold')?.displayName).toBe('Gold');
    await settleQueue();
    expect(pm.getTier('gold')?.displayName).toBe('Gold');
    writePremium();
    expect(pm.getTier('gold')).toBeNull();
    expect(pm.getTier('high')?.displayName).toBe('High');
  });
});

describe('the ticks start although the first load failed, and run once the file is fixed', () => {
  it('startPremiumTickers arms the expiry timer and the Dummy interval; the next tick loads the fixed file', async () => {
    asBot(true);
    fs.writeFileSync(PREMIUM, 'not json');
    fs.mkdirSync(DUMMY_STATE, { recursive: true });
    const dummy = new DummyProvider();
    reg.current = null;
    const { getPaymentRegistry } = await import('../../src/bot/internalSetup/utils/payment/paymentRegistry');
    getPaymentRegistry().register(dummy);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const pm = getPremiumManager();
    expect(pm.cacheState()).toBe('unreadable');
    startPremiumTickers();
    expect((pm as any).expiryTimer).not.toBeNull();
    expect((dummy as any).tickTimer).not.toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(logged(spies.warn).some(l => l.startsWith('[PremiumManager] Skipped the expiry check: premium-tiers.json cannot be read'))).toBe(true);
    expect(logged(spies.warn).some(l => l.startsWith('[DummyProvider] Skipped the tick: payment-providers/dummy/state.json cannot be read'))).toBe(true);
    writePremium();
    fs.rmSync(DUMMY_STATE, { recursive: true, force: true });
    vi.advanceTimersByTime(60_000);
    expect(pm.cacheState()).toBe('normal');
    expect(pm.getTier('high')?.displayName).toBe('High');
    expect(dummy.cannotReadText()).toBeNull();
  });
});

describe('the Dummy state', () => {
  it('invalid JSON: the seed answers, a dummy op is refused and the file is left as it was', async () => {
    fs.mkdirSync(DUMMY_STATE.replace(/state\.json$/, ''), { recursive: true });
    fs.writeFileSync(DUMMY_STATE, '[[[');
    const { getPaymentRegistry } = await import('../../src/bot/internalSetup/utils/payment/paymentRegistry');
    const dummy = new DummyProvider();
    getPaymentRegistry().register(dummy);
    expect(dummy.adminListVariants().length).toBeGreaterThan(0);
    const reply: any = await applySharedOp({ op: 'dummy.adminSetVariant', args: { args: [{ variantId: 'v', label: 'V', amount: 1, currency: 'USD', durationDays: 1, recurring: false, active: true }] } });
    expect(reply).toMatchObject({ ok: false, code: 'failed' });
    expect(reply.error).toMatch(/^payment-providers\/dummy\/state\.json cannot be read \(invalid JSON/);
    await settleQueue();
    expect(rawOf(DUMMY_STATE)).toBe('[[[');
  });

  it('absent: a read writes nothing; the first change writes it, and a change queued behind it survives the next load', async () => {
    const { getPaymentRegistry } = await import('../../src/bot/internalSetup/utils/payment/paymentRegistry');
    const dummy = new DummyProvider();
    getPaymentRegistry().register(dummy);
    expect(dummy.adminListVariants().length).toBeGreaterThan(0);
    await settleQueue();
    expect(rawOf(DUMMY_STATE)).toBeNull();
    const variant = (id: string) => ({ variantId: id, label: id, amount: 1, currency: 'USD', durationDays: 1, recurring: false, active: true });
    dummy.adminSetVariant(variant('a'));
    dummy.adminSetVariant(variant('b'));
    expect(dummy.adminListVariants().map(v => v.variantId)).toEqual(expect.arrayContaining(['a', 'b']));
    dummy.adminSetVariant(variant('c'));
    await settleQueue();
    expect(Object.keys(jsonOf(DUMMY_STATE).variants)).toEqual(expect.arrayContaining(['a', 'b', 'c']));
  });
});
