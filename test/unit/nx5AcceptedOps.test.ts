import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NX5 rulings G8-12 and G8-11 (sheets/NX5.md, NB37 review round 4). Saved true means that nothing the process accepted
// still runs toward a write: a shared op in flight, a premium mutator awaiting its provider, a global config upload
// still downloading are counted while they run, the answer is not true while one runs, and the process answers again
// once it settled. A premium migration applies no new decision while the order holds.

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig =>
  (await import('../helpers/longConfirm')).longConfirm(await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>()));
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
import { hasHeldWrites, openWorkElsewhere } from '../../src/bot/internalSetup/utils/dataManager';
import { acceptedOpsRunning, MaintenanceRefusal } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { setupSharedOpsIPC } from '../../src/bot/internalSetup/utils/sharedOps';
import configEditorGlobalPanel from '../../src/bot/internalSetup/panels/configEditorGlobalPanel';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { ME, OrderStore, order, settle } from '../helpers/nx5Rig';
import { clearGlobal, gate, jsonOf, paidSub, PREMIUM, quiet, settleQueue, writePremium } from './nb10PremiumRig';
import { gh } from '../helpers/p1Holder';

const m = maintenance as any;
const role = process.env.BOT_PROCESS_ROLE;
const waitMs = maintenance.ENTER_BOUNDS.handlerWaitMs;
const END = new Date(Date.now() + 30 * 86_400_000).toISOString();
const providerState = (autoRenew: boolean) => ({ status: 'active' as const, startDate: new Date().toISOString(), endDate: END, autoRenew });

type Listener = (message: unknown) => Promise<void>;
let listener: Listener;
let n = 0;

beforeAll(() => {
  clearGlobal();
  const realOn = process.on.bind(process);
  let captured: Listener | null = null;
  const spy = vi.spyOn(process, 'on').mockImplementation(((event: string, fn: any) => {
    if (event === 'message') {
      captured = fn;
      return process;
    }
    return realOn(event as any, fn);
  }) as any);
  const original = process.send;
  if (!original) (process as any).send = () => true;
  setupSharedOpsIPC();
  (process as any).send = original;
  spy.mockRestore();
  listener = captured!;
});

/** One shared:op through the bot process's listener, as the web UI sends it; resolves with its reply. */
async function ask(data: unknown): Promise<any> {
  const requestId = `nx5ops-${++n}`;
  let reply: any;
  const original = process.send;
  (process as any).send = (msg: any) => {
    if (msg?.requestId === requestId) reply = msg.data;
    return true;
  };
  try {
    await listener({ type: 'shared:op', requestId, data });
  } finally {
    (process as any).send = original;
  }
  return reply;
}

beforeEach(async () => {
  quiet();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  process.env.BOT_PROCESS_ROLE = 'bot';
  maintenance.ENTER_BOUNDS.handlerWaitMs = 100;
  maintenance._setMaintenanceSender(() => undefined);
  maintenance.markDiscordStarted();
  writeMaintenanceFile('running', 'The last message.');
});
afterEach(async () => {
  maintenance.ENTER_BOUNDS.handlerWaitMs = waitMs;
  m.attachSaveOrderSource(null);
  maintenance._resetMaintenance();
  maintenance._setMaintenanceSender(null);
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  vi.unstubAllGlobals();
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

/** A provider whose cancel answers when the test opens it. */
function slowCancel() {
  const call = gate<ReturnType<typeof providerState>>();
  const seen: string[] = [];
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { sells: ['guild'], supportsCancel: true }, isConfigured: () => true,
    cancelSubscription: async (subId: string) => { seen.push(subId); return call.promise; },
  } as any);
  return { call, seen };
}

/** What runs counted: the operations the process accepted and the subsystems' open work (ruling G8-14). */
const counted = (): number => acceptedOpsRunning() + openWorkElsewhere().length;

/** The order is read, the answer waits out its bound with the operation still running: not saved true. */
async function answerWhileRunning(): Promise<OrderStore> {
  expect(counted()).toBeGreaterThan(0);
  const store = await inOrder();
  await vi.waitFor(() => expect(store.acks).toHaveLength(1), { timeout: 3000, interval: 20 });
  expect(store.acks[0].saved).not.toBe(true);
  expect(hasHeldWrites()).toBe(true);
  return store;
}

/** The operation settled: the next read answers saved true, and its change is on the store. */
async function answerOnceSettled(store: OrderStore): Promise<void> {
  // The op's member notice is open work of its own until the dispatcher answered.
  await vi.waitFor(() => expect(counted()).toBe(0), { timeout: 3000, interval: 20 });
  m.noteSaveOrder(order());
  await vi.waitFor(() => expect(store.acks).toHaveLength(2), { timeout: 3000, interval: 20 });
  expect(store.acks[1].saved).toBe(true);
}

describe('G8-12: the review\'s case, a shared op whose provider call resolves after the answer would have been written', () => {
  it('premium.cancelPaidSubscription over shared:op: the answer is not saved true while Stripe has not answered, and is saved true once the op settled with autoRenew off on the store', async () => {
    writePremium({ 'guild:70000000000000001': { active: paidSub('s1', 'sub1', 'high'), paused: [] } });
    const { call, seen } = slowCancel();
    const reply = ask({ op: 'premium.cancelPaidSubscription', args: { args: ['guild:70000000000000001'] } });
    await vi.waitFor(() => expect(seen).toEqual(['sub1']));
    const store = await answerWhileRunning();

    call.open(providerState(false));
    expect(await reply).toBeDefined();
    await answerOnceSettled(store);
    expect(jsonOf(PREMIUM).subscriptions['guild:70000000000000001'].active.autoRenew).toBe(false);
  });

  it('a payment webhook over shared:op, counted by the listener alone: not saved true while its handler runs, saved true once its event is on the store', async () => {
    writePremium({ 'guild:70000000000000001': { active: paidSub('s1', 'sub1', 'high'), paused: [] } });
    const handled = gate<void>();
    let entered = false;
    getPaymentRegistry().register({
      id: 'hooked', displayName: 'Hooked', capabilities: { sells: ['guild'] }, isConfigured: () => true,
      handleWebhook: async () => {
        entered = true;
        await handled.promise;
        getPaymentRegistry().emitEvent({ type: 'subscription.paused', providerId: 'fake', providerSubId: 'sub1', holder: 'guild:70000000000000001', resumesAt: END } as any);
      },
    } as any);
    const reply = ask({ op: 'payment.webhook', args: { providerId: 'hooked', body: '', signature: '' } });
    await vi.waitFor(() => expect(entered).toBe(true));
    const store = await answerWhileRunning();

    handled.open();
    expect(await reply).toBeDefined();
    await answerOnceSettled(store);
    expect(jsonOf(PREMIUM).subscriptions['guild:70000000000000001'].active.resumesAtHint).toBe(END);
  });
});

describe('G8-12: a premium mutator a module timer calls, awaiting its provider', () => {
  it('a direct cancelPaidSubscription that passed its entry check before the order: not saved true while it runs, saved true once its change is on the store', async () => {
    writePremium({ 'guild:70000000000000001': { active: paidSub('s1', 'sub1', 'high'), paused: [] } });
    const { call, seen } = slowCancel();
    const running = getPremiumManager().cancelPaidSubscription('guild:70000000000000001');
    await vi.waitFor(() => expect(seen).toEqual(['sub1']));
    const store = await answerWhileRunning();

    call.open(providerState(false));
    await running;
    await answerOnceSettled(store);
    expect(jsonOf(PREMIUM).subscriptions['guild:70000000000000001'].active.autoRenew).toBe(false);
  });
});

describe('G8-12: a global config upload still downloading', () => {
  it('is counted from the download until the panel answers', async () => {
    const download = gate<{ ok: boolean }>();
    let fetched = false;
    vi.stubGlobal('fetch', async () => { fetched = true; return download.promise; });
    const interaction = {
      fields: {
        getUploadedFiles: () => ({ size: 1, first: () => ({ url: 'https://cdn.example/config.json' }) }),
        getTextInputValue: () => '',
      },
    };
    const before = acceptedOpsRunning();
    const answer = configEditorGlobalPanel.handleModal!({ interaction } as any, 'upload_config');
    await vi.waitFor(() => expect(fetched).toBe(true));
    expect(acceptedOpsRunning()).toBe(before + 1);
    expect(hasHeldWrites()).toBe(true);
    download.open({ ok: false });
    await answer;
    expect(acceptedOpsRunning()).toBe(before);
  });
});

const SOURCE = 'v-old';
const TARGET = 'v-new';
const subOn = (id: string, providerSubId: string) => ({ ...paidSub(id, providerSubId, 'low'), variantId: SOURCE });
const migration = (decisions: Array<Record<string, unknown>>) => ({
  id: 'mig-1', providerId: 'fake', sourceTierId: 'low', sourceOfferingId: 'o1', sourceVariantId: SOURCE,
  targetTierId: 'high', targetOfferingId: 'o2', targetVariantId: TARGET,
  effectiveDate: new Date(Date.now() - 60_000).toISOString(), message: 'New price.', status: 'pending',
  createdAt: new Date().toISOString(), decisions,
});
const decision = (guildId: string, subscriptionId: string, providerSubId: string, over: Record<string, unknown> = {}) => ({
  holder: gh(guildId), subscriptionId, providerSubId, decision: 'accepted', ...over,
});

describe('G8-11: a premium migration while the order holds', () => {
  it('two due decisions, the order arriving during the first: the second stays pending and is applied after the order ends', async () => {
    writePremium(
      { 'guild:70000000000000001': { active: subOn('s1', 'sub1'), paused: [] }, 'guild:70000000000000002': { active: subOn('s2', 'sub2'), paused: [] } },
      { migrations: [migration([decision('70000000000000001', 's1', 'sub1'), decision('70000000000000002', 's2', 'sub2')])] },
    );
    const first = gate<void>();
    const calls: string[] = [];
    getPaymentRegistry().register({
      id: 'fake', displayName: 'Fake', capabilities: { sells: ['guild'], supportsCancel: true }, isConfigured: () => true,
      migrateSubscriptionPrice: async (subId: string) => {
        calls.push(subId);
        if (subId === 'sub1') await first.promise;
        return providerState(true);
      },
    } as any);
    const pm = getPremiumManager();
    const run = pm.processDueMigrations();
    await vi.waitFor(() => expect(calls).toEqual(['sub1']));
    const store = await answerWhileRunning();

    first.open();
    await run;
    expect(calls).toEqual(['sub1']);
    await answerOnceSettled(store);
    const stored = jsonOf(PREMIUM).migrations[0];
    expect(stored.status).toBe('pending');
    expect(stored.decisions[0]).toMatchObject({ outcome: 'migrated' });
    expect(stored.decisions[0].appliedAt).toBeDefined();
    expect(stored.decisions[1].appliedAt).toBeUndefined();
    expect(stored.decisions[1].outcome).toBeUndefined();

    m.noteSaveOrder(null);
    await pm.processDueMigrations();
    expect(calls).toEqual(['sub1', 'sub2']);
    expect(pm.getFullConfig().migrations[0].status).toBe('applied');
    expect(pm.getFullConfig().migrations[0].decisions[1]).toMatchObject({ outcome: 'migrated' });
  });

  it('a decision whose provider call is refused with cause maintenance stays pending, its silent decision kept, not failed', async () => {
    writePremium(
      { 'guild:70000000000000001': { active: subOn('s1', 'sub1'), paused: [] } },
      { migrations: [migration([decision('70000000000000001', 's1', 'sub1', { decision: 'pending', notifiedAt: new Date().toISOString() })])], migrationSilencePolicy: 'continue' },
    );
    getPaymentRegistry().register({
      id: 'fake', displayName: 'Fake', capabilities: { sells: ['guild'], supportsCancel: true }, isConfigured: () => true,
      migrateSubscriptionPrice: async () => { throw new MaintenanceRefusal('The Dummy provider changed nothing: the bot is in maintenance.'); },
    } as any);
    const pm = getPremiumManager();
    await pm.processDueMigrations();
    const kept = pm.getFullConfig().migrations[0];
    expect(kept.status).toBe('pending');
    expect(kept.decisions[0].decision).toBe('pending');
    expect(kept.decisions[0].outcome).toBeUndefined();
    expect(kept.decisions[0].appliedAt).toBeUndefined();
  });
});
