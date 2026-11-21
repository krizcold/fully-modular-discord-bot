import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NX5 ruling G8-9 (sheets/NX5.md, NB37 review round 2, finding 1). (a) The order's refusal is for module code: a core
// subsystem's re-save of a change it accepted before the order (premium's and the Dummy provider's retry and final
// stop pass) is not refused. (b) The save run behind an answer saves those holds too and counts what stays held, so
// saved true is written only when nothing stays held, and a hold that appears later makes the process answer again.
// (c) dropSaveOrderRead turns the refusal off with the kept read. Every row but the guard fails on the code before this
// ruling: the refusal took the core's re-saves, and saveHeldWrites and hasHeldWrites saw only the facade's queues.

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
import { hasHeldWrites, saveGlobalModuleData } from '../../src/bot/internalSetup/utils/dataManager';
import { isMaintenanceGateClosed, orderRefusesSharedOps, runEntitlementEvent } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { ME, OrderStore, order, settle } from '../helpers/nx5Rig';
import { clearGlobal, DUMMY_STATE, jsonOf, logged, paidSub, PREMIUM, quiet, settleQueue, writePremium } from './nb10PremiumRig';
import { gh } from '../helpers/p1Holder';

const m = maintenance as any;
const role = process.env.BOT_PROCESS_ROLE;
const refuse = (...files: string[]) => { for (const f of files) inject.refuse.set(f, 'storage-failing'); };
const recover = () => inject.refuse.clear();
const grant = (guildId = '70000000000000001', tierId = 'high') => applySharedOp({ op: 'premium.grantManual', args: { args: [gh(guildId), tierId, 30] } });
const refusal = { name: 'DataBackendUnavailableError', causeKey: 'maintenance' };

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
  process.env.BOT_PROCESS_ROLE = 'bot';
  maintenance._setMaintenanceSender(() => undefined);
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

/** A serving process with an order source reads a current maintenance order. */
async function inOrder(): Promise<OrderStore> {
  const store = new OrderStore();
  m.attachSaveOrderSource({ me: ME, read: () => store.readSaveOrder(), writeAck: (ack: any) => store.writeSaveAck(ack) });
  m.noteSaveOrder(order());
  await settle();
  return store;
}

describe('G8-9 (a) and (b): a change premium held before the order', () => {
  it('the review\'s case: held before the order, the answer is not saved true while it is held, and a stop during the order saves it', async () => {
    refuse('premium-tiers.json');
    expect(await grant('70000000000000001')).toMatchObject({ answer: 'held' });
    const store = await inOrder();
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(store.acks[0]).toMatchObject({ saved: false, unsavedFiles: 1 });
    expect(hasHeldWrites()).toBe(true);
    recover();
    getPremiumManager().finalStop();
    await settleQueue();
    expect(isMaintenanceGateClosed()).toBe(true);
    expect(jsonOf(PREMIUM).subscriptions['guild:70000000000000001']?.active?.tierId).toBe('high');
    expect(logged(spies.error).filter(l => l.includes('holds changes the disk refused'))).toEqual([]);
  });

  it('a hold that appears after a true answer (an entitlement event whose save is refused) makes the next order read answer again, not saved', async () => {
    writePremium({ 'guild:70000000000000001': { active: paidSub('s1', 'd1', 'low', 'discord'), paused: [] } });
    expect(getPremiumManager().resolveActiveTier('70000000000000001').tierId).toBe('low');
    const store = await inOrder();
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(store.acks[0].saved).toBe(true);
    refuse('premium-tiers.json');
    const expired = { type: 'subscription.expired', providerId: 'discord', providerSubId: 'd1', holder: 'guild:70000000000000001', state: { status: 'expired', startDate: new Date().toISOString(), endDate: new Date(Date.now() - 1000).toISOString(), autoRenew: false } };
    runEntitlementEvent(() => getPaymentRegistry().emitEvent(expired as any));
    await vi.waitFor(() => expect((getPremiumManager() as any).saveHeld).toBe(true), { timeout: 2000, interval: 20 });
    // The event's audit line lands; what stays held is premium's in-memory save alone.
    await settleQueue();
    expect(hasHeldWrites()).toBe(true);
    m.noteSaveOrder(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(2));
    expect(store.acks[1]).toMatchObject({ saved: false, unsavedFiles: 1 });
  });

  it('a core re-save during the order is not refused: premium\'s and the Dummy\'s retries land while the order holds, and a module\'s global write is still refused', async () => {
    const dummy = new DummyProvider();
    getPaymentRegistry().register(dummy);
    refuse('premium-tiers.json', 'state.json');
    expect(await grant('70000000000000001')).toMatchObject({ answer: 'held' });
    const variant = { variantId: 'v9', label: 'V9', amount: 1, currency: 'USD', durationDays: 1, recurring: false, active: true };
    expect(await applySharedOp({ op: 'dummy.adminSetVariant', args: { args: [variant] } })).toMatchObject({ answer: 'held' });
    const store = await inOrder();
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    recover();
    await vi.waitFor(() => expect(jsonOf(PREMIUM).subscriptions['guild:70000000000000001']?.active?.tierId).toBe('high'), { timeout: 5000, interval: 50 });
    await vi.waitFor(() => expect(Object.keys(jsonOf(DUMMY_STATE)?.variants ?? {})).toContain('v9'), { timeout: 5000, interval: 50 });
    expect(isMaintenanceGateClosed() && orderRefusesSharedOps()).toBe(true);
    expect(() => saveGlobalModuleData('state.json', 'nx5-timer-module', { v: 1 })).toThrow(expect.objectContaining(refusal));
    expect(hasHeldWrites()).toBe(false);
  });

  it('an entitlement event\'s write during the order still passes (decision 10, guard)', async () => {
    await inOrder();
    expect(runEntitlementEvent(() => saveGlobalModuleData('state.json', 'nx5-timer-module', { v: 2 }))).toBe(true);
  });
});

describe('G8-9 (c): dropSaveOrderRead', () => {
  it('turns the global-write refusal off with the kept read', async () => {
    await inOrder();
    expect(() => saveGlobalModuleData('state.json', 'nx5-timer-module', { v: 1 })).toThrow(expect.objectContaining(refusal));
    m.dropSaveOrderRead();
    expect(orderRefusesSharedOps()).toBe(false);
    expect(saveGlobalModuleData('state.json', 'nx5-timer-module', { v: 3 })).toBe(true);
  });
});
