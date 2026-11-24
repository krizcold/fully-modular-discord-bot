import { Client } from 'discord.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NX5 decision 10 and ruling G8-8 (NB37 review round 2, finding 3): while a save order holds, an entitlement event's
// write passes the refusal of global writes because both boots attach the Discord payment bridge through
// attachEntitlementBridge, which runs each handler in runEntitlementEvent. Each row emits a gateway entitlement event
// through the attached bridge during an order and finds premium-tiers.json saved; without the wrap the save is refused
// and held in premium's memory. The maintenance boot marks its process for good, so its row runs last. The payload
// and the stored record are a user's: Discord's store sells user subscriptions only (sheet P6).

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
import { attachEntitlementBridge } from '../../src/bot/internalSetup/utils/entitlementBridge';
import { isMaintenanceBoot, isMaintenanceGateClosed, orderRefusesSharedOps } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { DiscordProvider } from '../../src/bot/internalSetup/utils/payment/discordProvider';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { ME, OrderStore, order, settle } from '../helpers/nx5Rig';
import { clearGlobal, jsonOf, paidSub, PREMIUM, quiet, settleQueue, TIERS, writePremium } from './nb10PremiumRig';

const m = maintenance as any;
const role = process.env.BOT_PROCESS_ROLE;
const USER = '80000000000000001';
const HOLDER = `user:${USER}`;
const ended = { id: 'd1', sku_id: 'sku-1', user_id: USER, starts_at: new Date(Date.now() - 86_400_000).toISOString(), ends_at: new Date(Date.now() - 1000).toISOString() };
const USER_TIERS = { ...TIERS, ulow: { displayName: 'User low', priority: 1, overrides: {}, kind: 'user', offerings: [{ id: 'o1', label: 'User low', providerLinks: [] }] } };

beforeEach(async () => {
  quiet();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  writePremium({ [HOLDER]: { active: { ...paidSub('s1', 'd1', 'low', 'discord'), tierId: 'ulow', buyerId: USER }, paused: [] } }, { tiers: USER_TIERS });
  process.env.BOT_PROCESS_ROLE = 'bot';
  getPaymentRegistry().register(new DiscordProvider());
  expect(getPremiumManager().resolveActiveUserTier(USER)?.tierId).toBe('ulow');
  maintenance._setMaintenanceSender(() => undefined);
  maintenance._setMaintenanceTiming({ filePollMs: 600_000 });
  writeMaintenanceFile('running', 'The last message.');
});
afterAll(() => {
  m.attachSaveOrderSource(null);
  maintenance._resetMaintenance();
  maintenance._setMaintenanceSender(null);
  resetPremiumManager();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('decision 10: an entitlement event through the attached bridge during a save order', () => {
  it('the normal boot\'s bridge (clientInitializer): the gate closed for the order, entitlementDelete saves premium-tiers.json', async () => {
    const client = new Client({ intents: [] });
    maintenance.installMaintenanceGate(client);
    attachEntitlementBridge(client);
    maintenance.markDiscordStarted();
    const store = new OrderStore();
    m.attachSaveOrderSource({ me: ME, read: () => store.readSaveOrder(), writeAck: (ack: any) => store.writeSaveAck(ack) });
    m.noteSaveOrder(order());
    await settle();
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(isMaintenanceGateClosed() && orderRefusesSharedOps()).toBe(true);
    client.emit('entitlementDelete', ended as any);
    await settleQueue();
    expect(jsonOf(PREMIUM).subscriptions[HOLDER]?.active).toBeUndefined();
    expect((getPremiumManager() as any).saveHeld).toBe(false);
    m.attachSaveOrderSource(null);
    maintenance._resetMaintenance();
    void client.destroy();
  });

  it('the normal boot\'s bridge: entitlementUpdate, emitted by discord.js as (old | null, new), saves its end through the order', async () => {
    const client = new Client({ intents: [] });
    maintenance.installMaintenanceGate(client);
    attachEntitlementBridge(client);
    maintenance.markDiscordStarted();
    const store = new OrderStore();
    m.attachSaveOrderSource({ me: ME, read: () => store.readSaveOrder(), writeAck: (ack: any) => store.writeSaveAck(ack) });
    m.noteSaveOrder(order());
    await settle();
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(isMaintenanceGateClosed() && orderRefusesSharedOps()).toBe(true);
    client.emit('entitlementUpdate', null as any, ended as any);
    await settleQueue();
    expect(jsonOf(PREMIUM).subscriptions[HOLDER]?.active).toBeUndefined();
    expect((getPremiumManager() as any).saveHeld).toBe(false);
    m.attachSaveOrderSource(null);
    maintenance._resetMaintenance();
    void client.destroy();
  });

  it('the maintenance boot\'s bridge (cause order): entitlementDelete saves premium-tiers.json', async () => {
    const client = await maintenance.runMaintenanceBoot({ cause: 'order', message: 'Moving the main database tonight.' }, {
      shards: async () => 1,
      login: async () => undefined,
    });
    expect(isMaintenanceGateClosed() && orderRefusesSharedOps()).toBe(true);
    client!.emit('entitlementDelete', ended as any);
    await settleQueue();
    expect(jsonOf(PREMIUM).subscriptions[HOLDER]?.active).toBeUndefined();
    expect((getPremiumManager() as any).saveHeld).toBe(false);
  });

  it("E7 (sheet P6): in the maintenance boot no provider started, so an update event (ends_at ahead) applies and arms no round", async () => {
    expect(isMaintenanceBoot()).toBe(true);
    vi.stubEnv('DISCORD_APPLICATION_ID', '86900000000000001');
    vi.stubEnv('DISCORD_TOKEN', 'nx5-made-up-token');
    getPaymentRegistry().startTickers();
    const client = new Client({ intents: [] });
    attachEntitlementBridge(client);
    const ahead = { ...ended, ends_at: new Date(Date.now() + 3_600_000).toISOString() };
    const timer = vi.spyOn(globalThis, 'setTimeout');
    client.emit('entitlementUpdate', null as any, ahead as any);
    const delays = timer.mock.calls.map(call => call[1]);
    timer.mockRestore();
    await settleQueue();
    expect(delays.filter(ms => typeof ms === 'number' && ms >= 30_000)).toEqual([]);
    expect(jsonOf(PREMIUM).subscriptions[HOLDER]?.active).toMatchObject({ endDate: new Date(Date.parse(ahead.ends_at)).toISOString(), autoRenew: false });
    vi.unstubAllEnvs();
    void client.destroy();
  });
});
