import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NX5 ruling G8-10 (sheets/NX5.md, NB37 review round 3) and G8-9 (b). Module code's calls into premium and the Dummy
// provider are refused at their entry check while the order holds, so no change is made that the exempt retry would
// save. A subsystem's held file at the leave keeps the leave waiting, named in its log. The save run behind an answer
// saves premium's held change itself, before any retry timer fires.

const inject = vi.hoisted(() => ({ refuse: new Map<string, string>() }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = (await import('../helpers/longConfirm')).longConfirm(await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>());
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
const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import * as maintenance from '../../src/bot/internalSetup/utils/maintenance';
import { hasHeldWrites } from '../../src/bot/internalSetup/utils/dataManager';
import { isMaintenanceGateClosed, orderRefusesSharedOps } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { ME, OrderStore, order, settle } from '../helpers/nx5Rig';
import { clearGlobal, DUMMY_STATE, jsonOf, logged, PREMIUM, quiet, settleQueue, writePremium } from './nb10PremiumRig';

const m = maintenance as any;
const role = process.env.BOT_PROCESS_ROLE;
const refuse = (...files: string[]) => { for (const f of files) inject.refuse.set(f, 'storage-failing'); };
const recover = () => inject.refuse.clear();
const grant = (guildId = 'g1', tierId = 'high') => applySharedOp({ op: 'premium.grantManual', args: { args: [guildId, tierId, 30] } });
const variant = { variantId: 'v9', label: 'V9', amount: 1, currency: 'USD', durationDays: 1, recurring: false, active: true };
const sent: Array<{ type: string }> = [];
const restarts = () => sent.filter(s => s.type === 'control:restart-bot');

let spies: ReturnType<typeof quiet>;
beforeAll(() => clearGlobal());
beforeEach(async () => {
  spies = quiet();
  recover();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  writePremium();
  sent.length = 0;
  process.env.BOT_PROCESS_ROLE = 'bot';
  maintenance._setMaintenanceSender(message => { sent.push(message as any); });
  maintenance.markDiscordStarted();
  writeMaintenanceFile('running', 'The last message.');
});
afterEach(async () => {
  m.attachSaveOrderSource(null);
  maintenance._resetMaintenance();
  maintenance._setMaintenanceSender(null);
  recover();
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

async function inOrder(): Promise<OrderStore> {
  const store = new OrderStore();
  m.attachSaveOrderSource({ me: ME, read: () => store.readSaveOrder(), writeAck: (ack: any) => store.writeSaveAck(ack) });
  m.noteSaveOrder(order());
  await settle();
  return store;
}

/** Premium's retry timer, and the Dummy's, at their longest delay, so no retry fires while a row runs. */
function retriesOutOfReach(...caches: any[]): void {
  for (const cache of caches) {
    cache.clearRetry();
    cache.retryDelay = 60_000;
    cache.armRetry();
  }
}

describe('G8-10: module code\'s calls into premium and the Dummy provider during the order', () => {
  it('a module-context grantManual and a Dummy call are refused: the cache does not change and nothing is held; after the order both are accepted', async () => {
    const dummy = new DummyProvider();
    getPaymentRegistry().register(dummy);
    const store = await inOrder();
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(store.acks[0].saved).toBe(true);
    expect(isMaintenanceGateClosed() && orderRefusesSharedOps()).toBe(true);
    const pm = getPremiumManager() as any;

    expect(await pm.grantManual('g1', 'high', 30)).toBe(false);
    dummy.adminSetVariant(variant as any);
    expect(pm.resolveActiveTier('g1').tierId).toBe('free');
    expect(dummy.adminListVariants().map(v => v.variantId)).not.toContain('v9');
    expect(pm.saveHeld).toBe(false);
    expect((dummy as any).saveHeld).toBe(false);
    await settleQueue();
    expect(hasHeldWrites()).toBe(false);
    expect(jsonOf(PREMIUM).subscriptions.g1).toBeUndefined();

    m.noteSaveOrder(null);
    expect(orderRefusesSharedOps()).toBe(false);
    expect(await pm.grantManual('g1', 'high', 30)).toBe(true);
    dummy.adminSetVariant(variant as any);
    expect(pm.resolveActiveTier('g1').tierId).toBe('high');
    expect(dummy.adminListVariants().map(v => v.variantId)).toContain('v9');
  });
});

describe('G8-10: a subsystem\'s held file at the leave', () => {
  it('keeps the leave from restarting while premium-tiers.json and the Dummy\'s state.json stay held, names both, and restarts once they are saved', async () => {
    maintenance._setMaintenanceTiming({ leaveRetryMs: 30, filePollMs: 20, restartResendMs: 60, leaveSaveBoundMs: 100, heldAfterPasses: 3 });
    const dummy = new DummyProvider();
    getPaymentRegistry().register(dummy);
    refuse('premium-tiers.json', 'state.json');
    expect(await grant('g1')).toMatchObject({ answer: 'held' });
    dummy.adminSetVariant(variant as any);
    expect((dummy as any).saveHeld).toBe(true);
    retriesOutOfReach(getPremiumManager(), dummy);
    const store = await inOrder();
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(store.acks[0]).toMatchObject({ saved: false, unsavedFiles: 2 });

    m.noteSaveOrder(null);
    const line = () => logged(spies.error).find(l => l.includes('saves in a row left changes unsaved'));
    await vi.waitFor(() => expect(line()).toBeDefined(), { timeout: 5000, interval: 20 });
    expect(line()).toContain(`file ${PREMIUM}`);
    expect(line()).toContain(`file ${DUMMY_STATE}`);
    expect(line()).toContain('does not restart until they are saved or the operator restarts it, which drops them');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(restarts()).toHaveLength(0);

    recover();
    await vi.waitFor(() => expect(restarts()).toHaveLength(1), { timeout: 5000, interval: 20 });
    expect(jsonOf(PREMIUM).subscriptions.g1?.active?.tierId).toBe('high');
    expect(Object.keys(jsonOf(DUMMY_STATE)?.variants ?? {})).toContain('v9');
  });
});

describe('G8-9 (b): the answer\'s own save run lands premium\'s held change', () => {
  it('with the retry out of reach, clearing the cause and reading the order again answers saved true with premium-tiers.json written', async () => {
    refuse('premium-tiers.json');
    expect(await grant('g1')).toMatchObject({ answer: 'held' });
    const pm = getPremiumManager() as any;
    retriesOutOfReach(pm);
    const store = await inOrder();
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(store.acks[0]).toMatchObject({ saved: false, unsavedFiles: 1 });
    expect(jsonOf(PREMIUM).subscriptions.g1).toBeUndefined();

    recover();
    m.noteSaveOrder(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(2), { timeout: 3000, interval: 20 });
    expect(store.acks[1]).toMatchObject({ saved: true, unsavedFiles: 0 });
    expect(jsonOf(PREMIUM).subscriptions.g1?.active?.tierId).toBe('high');
    expect(pm.retryTimer).not.toBeNull();
  });
});
