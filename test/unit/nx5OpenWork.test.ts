import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NX5 ruling G8-14 (sheets/NX5.md, NB37 review round 5). Premium and the Dummy provider each track their open
// asynchronous work in one place and report it through the held-saver interface: while any is open the answer is not
// saved true, its counts are NULL (G8-5), hasHeldWrites is true, and the leave waits and says what it waits for.

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig =>
  (await import('../helpers/longConfirm')).longConfirm(await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>()));
const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
const notices = vi.hoisted(() => ({ hold: null as Promise<void> | null, sent: [] as string[] }));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async (_holder: string, kind: string) => {
    if (notices.hold) await notices.hold;
    notices.sent.push(kind);
    return { delivered: true, via: 'dm' };
  },
}));
const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import * as maintenance from '../../src/bot/internalSetup/utils/maintenance';
import { addHeldSaver, hasHeldWrites, openWorkElsewhere, removeHeldSaver } from '../../src/bot/internalSetup/utils/dataManager';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { FakeStore, tokenFor } from '../helpers/fakeStore';
import { freshGuild } from '../helpers/gateRig';
import { acceptedOpsRunning } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { ME, OrderStore, order, settle } from '../helpers/nx5Rig';
import { clearGlobal, DUMMY_STATE, gate, jsonOf, logged, paidSub, PREMIUM, quiet, settleQueue, TIERS, writePremium } from './nb10PremiumRig';

const m = maintenance as any;
const role = process.env.BOT_PROCESS_ROLE;
const waitMs = maintenance.ENTER_BOUNDS.handlerWaitMs;
const DAY = 86_400_000;
const END = new Date(Date.now() + 30 * DAY).toISOString();
const providerState = (autoRenew: boolean, status: 'active' | 'paused' | 'expired' = 'active') =>
  ({ status, startDate: new Date().toISOString(), endDate: END, autoRenew });
const NULL_COUNTS = { unsavedGuilds: null, unsavedFiles: null, unansweredGuilds: null, unconfirmedFiles: null, unansweredFiles: null, resaveGuilds: 0 };

let spies: ReturnType<typeof quiet>;
beforeEach(async () => {
  spies = quiet();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  notices.hold = null;
  notices.sent = [];
  clearGlobal();
  process.env.BOT_PROCESS_ROLE = 'bot';
  maintenance.ENTER_BOUNDS.handlerWaitMs = 100;
  maintenance._setMaintenanceSender(() => undefined);
  maintenance.markDiscordStarted();
  writeMaintenanceFile('running', 'The last message.');
});
afterEach(async () => {
  notices.hold = null;
  maintenance.ENTER_BOUNDS.handlerWaitMs = waitMs;
  m.attachSaveOrderSource(null);
  maintenance._resetMaintenance();
  maintenance._setMaintenanceSender(null);
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

/** Only the subsystems' tracker counts the work: no operation of the process is counted beside it. */
async function answerWhileOpen(kind: RegExp): Promise<OrderStore> {
  expect(acceptedOpsRunning()).toBe(0);
  expect(openWorkElsewhere().join('; ')).toMatch(kind);
  const store = await inOrder();
  await vi.waitFor(() => expect(store.acks).toHaveLength(1), { timeout: 3000, interval: 20 });
  expect(store.acks[0]).toMatchObject({ saved: null, ...NULL_COUNTS });
  expect(hasHeldWrites()).toBe(true);
  return store;
}

async function answerOnceEnded(store: OrderStore): Promise<void> {
  await vi.waitFor(() => expect(openWorkElsewhere()).toEqual([]), { timeout: 3000, interval: 20 });
  m.noteSaveOrder(order());
  await vi.waitFor(() => expect(store.acks).toHaveLength(2), { timeout: 3000, interval: 20 });
  expect(store.acks[1].saved).toBe(true);
}

function migrationTiers() {
  const tiers = JSON.parse(JSON.stringify(TIERS));
  const link = (variantId: string) => ({ providerId: 'fake', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId }] }, cache: { syncedAt: '', variants: [{ variantId, label: variantId }] } });
  tiers.low.offerings[0].providerLinks = [link('v1')];
  tiers.high.offerings[0].providerLinks = [link('v2')];
  return tiers;
}

describe('G8-14: the review\'s case, a scheduled migration\'s notice landing after the answer', () => {
  it('no true answer until notifiedAt is on the store; the answer meanwhile carries NULL counts', async () => {
    writePremium({ 'guild:70000000000000001': { active: { ...paidSub('s1', 'sub1', 'low'), variantId: 'v1' }, paused: [] } }, { tiers: migrationTiers() });
    getPaymentRegistry().register({
      id: 'fake', displayName: 'Fake', isConfigured: () => true, capabilities: { sells: ['guild'], supportsPriceMigration: true },
      migrateSubscriptionPrice: async () => providerState(true),
    } as any);
    const held = gate();
    notices.hold = held.promise;
    const scheduled = await getPremiumManager().scheduleMigration({
      providerId: 'fake', sourceTierId: 'low', sourceOfferingId: 'o1', sourceVariantId: 'v1',
      targetTierId: 'high', targetOfferingId: 'o2', targetVariantId: 'v2',
      effectiveDate: new Date(Date.now() + DAY).toISOString(), message: 'New price.',
    });
    await settleQueue();
    const store = await answerWhileOpen(/^premium: 1 member notice\(s\)/);

    held.open();
    await vi.waitFor(() => expect(notices.sent).toEqual(['migration.scheduled']));
    await answerOnceEnded(store);
    await settleQueue();
    const stored = (jsonOf(PREMIUM).migrations as any[]).find(x => x.id === scheduled.id);
    expect(stored.decisions[0].notifiedAt).toBeDefined();
  });
});

describe('G8-14: premium\'s other asynchronous paths', () => {
  it('a subscription.created event whose install awaits the provider\'s pause: counted until the pause answered', async () => {
    writePremium({ 'guild:70000000000000001': { active: paidSub('s1', 'sub1', 'high'), paused: [] } });
    const pause = gate<ReturnType<typeof providerState>>();
    const paused: string[] = [];
    const pm = getPremiumManager();
    getPaymentRegistry().register({
      id: 'fake', displayName: 'Fake', isConfigured: () => true, capabilities: { sells: ['guild'], supportsPause: true },
      pauseSubscription: async (subId: string) => { paused.push(subId); return pause.promise; },
    } as any);
    getPaymentRegistry().emitEvent({
      type: 'subscription.created', buyerId: '80000000000000001', providerId: 'fake', providerSubId: 'sub2', holder: 'guild:70000000000000001', tierId: 'low', offeringId: 'o1',
      variantId: 'v1', state: providerState(true),
    } as any);
    await vi.waitFor(() => expect(paused).toEqual(['sub2']));
    const store = await answerWhileOpen(/provider event\(s\) being applied/);

    pause.open(providerState(true, 'paused'));
    await answerOnceEnded(store);
    expect(pm.getFullConfig().subscriptions['guild:70000000000000001'].paused.map((s: any) => s.providerSubId)).toEqual(['sub2']);
  });

  it('a queued subscription resumed after the active one expired: the provider\'s resume call is counted until it answered', async () => {
    const queued = { ...paidSub('s2', 'sub2', 'low'), status: 'paused', remainingDaysAtPause: 10, pausedAt: new Date().toISOString() };
    writePremium({ 'guild:70000000000000001': { active: paidSub('s1', 'sub1', 'high'), paused: [queued] } });
    const resume = gate<ReturnType<typeof providerState>>();
    const resumed: string[] = [];
    const pm = getPremiumManager();
    getPaymentRegistry().register({
      id: 'fake', displayName: 'Fake', isConfigured: () => true, capabilities: { sells: ['guild'], supportsPause: true },
      resumeSubscription: async (subId: string) => { resumed.push(subId); return resume.promise; },
    } as any);
    getPaymentRegistry().emitEvent({
      type: 'subscription.expired', providerId: 'fake', providerSubId: 'sub1', holder: 'guild:70000000000000001',
      state: { ...providerState(false, 'expired'), endDate: new Date(Date.now() - 1000).toISOString() },
    } as any);
    await vi.waitFor(() => expect(resumed).toEqual(['sub2']));
    await settleQueue();
    const store = await answerWhileOpen(/^premium: 1 provider resume call\(s\)$/);

    resume.open(providerState(true));
    await answerOnceEnded(store);
    expect(pm.getFullConfig().subscriptions['guild:70000000000000001'].active?.providerSubId).toBe('sub2');
  });
});

describe('G8-14: the Dummy provider', () => {
  it('a purchase awaiting its coupon check before its save: counted until the record is saved, then the answer is saved true with it on the store', async () => {
    const dummy = new DummyProvider();
    getPaymentRegistry().register(dummy);
    const check = gate<{ valid: boolean }>();
    vi.spyOn(dummy, 'validateCoupon').mockReturnValue(check.promise as any);
    const bought = dummy.initiatePurchase({ holder: 'guild:70000000000000001', buyerId: '80000000000000001', tierId: 'low', offeringId: 'o1', variantId: 'dummy_monthly_999', couponCode: 'NONE' });
    await settle();
    const store = await answerWhileOpen(/^the Dummy provider: 1 purchase\(s\) not saved yet$/);

    check.open({ valid: true });
    const result = await bought;
    await answerOnceEnded(store);
    await settleQueue();
    expect(Object.keys(jsonOf(DUMMY_STATE).subscriptions)).toEqual([result.providerSubId]);
  });
});

describe('G8-14: the leave waits while counted work runs', () => {
  it('the order ends while premium\'s provider call runs: the leave logs what it waits for and asks for its restart once the call ended', async () => {
    writePremium({ 'guild:70000000000000001': { active: paidSub('s1', 'sub1', 'high'), paused: [] } });
    const call = gate<ReturnType<typeof providerState>>();
    const seen: string[] = [];
    getPaymentRegistry().register({
      id: 'fake', displayName: 'Fake', capabilities: { sells: ['guild'], supportsCancel: true }, isConfigured: () => true,
      cancelSubscription: async (subId: string) => { seen.push(subId); return call.promise; },
    } as any);
    const sent: any[] = [];
    maintenance._setMaintenanceSender(message => { sent.push(message); });
    const running = getPremiumManager().cancelPaidSubscription('guild:70000000000000001');
    await vi.waitFor(() => expect(seen).toEqual(['sub1']));
    const store = await inOrder();
    await vi.waitFor(() => expect(store.acks).toHaveLength(1), { timeout: 3000, interval: 20 });

    m.noteSaveOrder(null);
    const waits = () => logged(spies.warn).filter(l => l.includes('[Maintenance] Nothing is held, but work this process accepted still runs'));
    await vi.waitFor(() => expect(waits()).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(waits()[0]).toContain('premium: 1 change(s) waiting for a payment provider');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(sent.filter(s => s.type === 'control:restart-bot')).toEqual([]);

    call.open(providerState(false));
    await running;
    await vi.waitFor(() => expect(sent.filter(s => s.type === 'control:restart-bot')).toHaveLength(1), { timeout: 5000, interval: 20 });
    expect(waits()).toHaveLength(1);
    expect(jsonOf(PREMIUM).subscriptions['guild:70000000000000001'].active.autoRenew).toBe(false);
  });

  it('the nothing-held wait says what the operator\'s restart does', async () => {
    const saver = { resaveHeld: () => undefined, heldFiles: () => [], openWork: () => 'premium: 1 change(s) waiting for a payment provider' };
    addHeldSaver(saver);
    try {
      m.startLeave('The hook says running');
      const waits = () => logged(spies.warn).filter(l => l.includes('[Maintenance] Nothing is held, but work this process accepted still runs'));
      await vi.waitFor(() => expect(waits()).toHaveLength(1), { timeout: 3000, interval: 20 });
      expect(waits()[0]).toMatch(/does not restart until it ends, or the operator restarts it, which cuts that work and drops any change it has not saved$/);
    } finally {
      removeHeldSaver(saver);
    }
  });

  it('a pass that holds a file between two nothing-held waits with the same words: the second wait logs again', async () => {
    maintenance._setMaintenanceTiming({ leaveRetryMs: 30, leaveSaveBoundMs: 50 });
    const W = 'premium: 1 change(s) waiting for a payment provider';
    let work: string | null = W;
    let files: string[] = [];
    const saver = { resaveHeld: () => undefined, heldFiles: () => files, openWork: () => work };
    const sent: any[] = [];
    maintenance._setMaintenanceSender(message => { sent.push(message); });
    addHeldSaver(saver);
    try {
      m.startLeave('The hook says running');
      const waits = () => logged(spies.warn).filter(l => l.includes('[Maintenance] Nothing is held, but work this process accepted still runs'));
      const retries = () => logged(spies.warn).filter(l => l.includes('the bot process keeps them and tries again'));
      await vi.waitFor(() => expect(waits()).toHaveLength(1), { timeout: 3000, interval: 20 });
      files = ['premium-tiers.json'];
      await vi.waitFor(() => expect(retries().length).toBeGreaterThan(0), { timeout: 3000, interval: 20 });
      files = [];
      await vi.waitFor(() => expect(waits()).toHaveLength(2), { timeout: 3000, interval: 20 });
      expect(waits()[1]).toContain(W);
      expect(sent.filter(s => s.type === 'control:restart-bot')).toEqual([]);
      work = null;
      await vi.waitFor(() => expect(sent.filter(s => s.type === 'control:restart-bot')).toHaveLength(1), { timeout: 3000, interval: 20 });
    } finally {
      removeHeldSaver(saver);
    }
  });
});

describe('G8-14: a false answer names the work that still runs', () => {
  it('a file held unsaved while work runs: saved false with the file counted and running carried', async () => {
    const running = 'premium: 1 change(s) waiting for a payment provider';
    const saver = { resaveHeld: () => undefined, heldFiles: () => ['premium-tiers.json'], openWork: () => running };
    addHeldSaver(saver);
    try {
      const answer = await maintenance.enterMaintenance('m', { handlerWaitMs: 50, saveBoundMs: 50 });
      expect(answer).toMatchObject({ saved: false, unsavedGuilds: 0, unsavedFiles: 1, running });
    } finally {
      removeHeldSaver(saver);
    }
  });
});

// Last in the file: the working set it starts keeps its refused guild.
describe('G8-14: the content-refusal leave waits while counted work runs', () => {
  it('a guild held for its content while premium\'s provider call runs: no restart until the call answered, then the restart that drops the guild', async () => {
    maintenance._setMaintenanceTiming({ leaveRetryMs: 30, leaveSaveBoundMs: 100 });
    writePremium({ 'guild:70000000000000001': { active: paidSub('s1', 'sub1', 'high'), paused: [] } });
    const call = gate<ReturnType<typeof providerState>>();
    const seen: string[] = [];
    getPaymentRegistry().register({
      id: 'fake', displayName: 'Fake', capabilities: { sells: ['guild'], supportsCancel: true }, isConfigured: () => true,
      cancelSubscription: async (subId: string) => { seen.push(subId); return call.promise; },
    } as any);
    const sent: any[] = [];
    maintenance._setMaintenanceSender(message => { sent.push(message); });
    const restarts = () => sent.filter(s => s.type === 'control:restart-bot');

    const store = new FakeStore();
    const ws = initWorkingSet(store);
    const guildId = freshGuild();
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    vi.spyOn(store, 'flushGuild').mockResolvedValue({ ok: false, reason: 'unavailable', detail: 'SQLSTATE 23505: duplicate key value', code: '23505' } as any);
    expect(ws.save(guildId, 'm', 'refused.json', '1')).toBe('accepted');
    const watcher = m.watchDataBackend({ onLoginRefused: () => undefined, askDatabase: async () => 'answers' }, { retryMs: 3_600_000 });
    await watcher.probeNow();

    const running = getPremiumManager().cancelPaidSubscription('guild:70000000000000001');
    await vi.waitFor(() => expect(seen).toEqual(['sub1']));
    m.startLeave('The hook says running');
    const waits = () => logged(spies.warn).filter(l => l.includes('refuses for their content') && l.includes('work this process accepted still runs'));
    await vi.waitFor(() => expect(waits().length + restarts().length).toBeGreaterThan(0), { timeout: 5000, interval: 20 });
    expect(restarts()).toEqual([]);
    expect(waits()).toHaveLength(1);
    expect(waits()[0]).toContain(`guild ${guildId} (SQLSTATE 23505`);
    expect(waits()[0]).toContain('premium: 1 change(s) waiting for a payment provider');
    expect(waits()[0]).toContain('or the operator restarts it, which cuts that work and drops any change it has not saved');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(restarts()).toEqual([]);

    call.open(providerState(false));
    await running;
    await vi.waitFor(() => expect(restarts()).toHaveLength(1), { timeout: 5000, interval: 20 });
    expect(waits()).toHaveLength(1);
    expect(logged(spies.error).filter(l => l.includes('saves in a row left changes the database refuses for their content')
      && l.endsWith('the bot process asks for its restart, which drops these changes'))).toHaveLength(1);
    expect(jsonOf(PREMIUM).subscriptions['guild:70000000000000001'].active.autoRenew).toBe(false);
  });

  /** One guild whose save the database refuses for its content, under a watcher whose database answers. */
  async function refusedGuild() {
    const store = new FakeStore();
    const ws = initWorkingSet(store);
    const guildId = freshGuild();
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    const refuse = () => vi.spyOn(store, 'flushGuild').mockResolvedValue({ ok: false, reason: 'unavailable', detail: 'SQLSTATE 23505: duplicate key value', code: '23505' } as any);
    const flush = refuse();
    expect(ws.save(guildId, 'm', 'refused.json', '1')).toBe('accepted');
    const watcher = m.watchDataBackend({ onLoginRefused: () => undefined, askDatabase: async () => 'answers' }, { retryMs: 3_600_000 });
    await watcher.probeNow();
    return { guildId, ws, flush, refuse };
  }
  const nothingHeldWaits = () => logged(spies.warn).filter(l => l.includes('[Maintenance] Nothing is held, but work this process accepted still runs'));
  const contentWaits = () => logged(spies.warn).filter(l => l.includes('refuses for their content') && l.includes('work this process accepted still runs'));

  it('the content-refusal wait reports mode held with the held guild before it waits', async () => {
    maintenance._setMaintenanceTiming({ leaveRetryMs: 30, leaveSaveBoundMs: 100 });
    const sent: any[] = [];
    maintenance._setMaintenanceSender(message => { sent.push(message); });
    await refusedGuild();
    let work: string | null = 'premium: 1 change(s) waiting for a payment provider';
    const saver = { resaveHeld: () => undefined, heldFiles: () => [], openWork: () => work };
    addHeldSaver(saver);
    try {
      m.startLeave('The hook says running');
      await vi.waitFor(() => expect(contentWaits()).toHaveLength(1), { timeout: 5000, interval: 20 });
      const modes = sent.filter(s => s.type === 'maintenance:mode');
      expect(modes.at(-1)).toMatchObject({ data: { mode: 'held', held: { unsavedGuilds: 1, unsavedFiles: 0 } } });
      expect(maintenance.maintenanceMode()).toBe('held');
      expect(sent.filter(s => s.type === 'control:restart-bot')).toEqual([]);
      work = null;
      await vi.waitFor(() => expect(sent.filter(s => s.type === 'control:restart-bot')).toHaveLength(1), { timeout: 5000, interval: 20 });
    } finally {
      removeHeldSaver(saver);
    }
  });

  it('a pass that holds a file between two content-refusal waits with the same words: the second wait logs again', async () => {
    maintenance._setMaintenanceTiming({ leaveRetryMs: 30, leaveSaveBoundMs: 100 });
    const sent: any[] = [];
    maintenance._setMaintenanceSender(message => { sent.push(message); });
    await refusedGuild();
    const W = 'premium: 1 change(s) waiting for a payment provider';
    let work: string | null = W;
    let files: string[] = [];
    const saver = { resaveHeld: () => undefined, heldFiles: () => files, openWork: () => work };
    addHeldSaver(saver);
    try {
      m.startLeave('The hook says running');
      const retries = () => logged(spies.warn).filter(l => l.includes('the bot process keeps them and tries again'));
      await vi.waitFor(() => expect(contentWaits()).toHaveLength(1), { timeout: 5000, interval: 20 });
      const before = retries().length;
      files = ['premium-tiers.json'];
      await vi.waitFor(() => expect(retries().length).toBeGreaterThan(before), { timeout: 5000, interval: 20 });
      files = [];
      await vi.waitFor(() => expect(contentWaits()).toHaveLength(2), { timeout: 5000, interval: 20 });
      expect(contentWaits()[1]).toContain(W);
      expect(sent.filter(s => s.type === 'control:restart-bot')).toEqual([]);
      work = null;
      await vi.waitFor(() => expect(sent.filter(s => s.type === 'control:restart-bot')).toHaveLength(1), { timeout: 5000, interval: 20 });
    } finally {
      removeHeldSaver(saver);
    }
  });

  it('the refused guild saves while work still runs: the nothing-held wait reports the gate\'s mode, not held', async () => {
    maintenance._setMaintenanceTiming({ leaveRetryMs: 30, leaveSaveBoundMs: 100, filePollMs: 3_600_000 });
    const sent: any[] = [];
    maintenance._setMaintenanceSender(message => { sent.push(message); });
    const { flush } = await refusedGuild();
    m.closeMaintenanceGate('hook', 'm');
    let work: string | null = 'premium: 1 change(s) waiting for a payment provider';
    const saver = { resaveHeld: () => undefined, heldFiles: () => [], openWork: () => work };
    addHeldSaver(saver);
    try {
      m.startLeave('The hook says running');
      await vi.waitFor(() => expect(contentWaits()).toHaveLength(1), { timeout: 5000, interval: 20 });
      expect(maintenance.maintenanceMode()).toBe('held');
      flush.mockRestore();
      await vi.waitFor(() => expect(nothingHeldWaits()).toHaveLength(1), { timeout: 5000, interval: 20 });
      const modes = sent.filter(s => s.type === 'maintenance:mode');
      expect(modes.at(-1)).toEqual({ type: 'maintenance:mode', data: { mode: 'maintenance' } });
      expect(maintenance.maintenanceMode()).toBe('maintenance');
      expect(sent.filter(s => s.type === 'control:restart-bot')).toEqual([]);
      work = null;
      await vi.waitFor(() => expect(sent.filter(s => s.type === 'control:restart-bot')).toHaveLength(1), { timeout: 5000, interval: 20 });
    } finally {
      removeHeldSaver(saver);
    }
  });

  it('a nothing-held pass between two content-refusal waits with the same words: the second wait logs again', async () => {
    maintenance._setMaintenanceTiming({ leaveRetryMs: 30, leaveSaveBoundMs: 100 });
    const sent: any[] = [];
    maintenance._setMaintenanceSender(message => { sent.push(message); });
    const { guildId, ws, flush, refuse } = await refusedGuild();
    const W = 'premium: 1 change(s) waiting for a payment provider';
    let work: string | null = W;
    const saver = { resaveHeld: () => undefined, heldFiles: () => [], openWork: () => work };
    addHeldSaver(saver);
    try {
      m.startLeave('The hook says running');
      await vi.waitFor(() => expect(contentWaits()).toHaveLength(1), { timeout: 5000, interval: 20 });
      flush.mockRestore();
      await vi.waitFor(() => expect(nothingHeldWaits()).toHaveLength(1), { timeout: 5000, interval: 20 });
      refuse();
      expect(ws.save(guildId, 'm', 'refused.json', '2')).toBe('accepted');
      await vi.waitFor(() => expect(contentWaits()).toHaveLength(2), { timeout: 5000, interval: 20 });
      expect(contentWaits()[1]).toContain(W);
      expect(sent.filter(s => s.type === 'control:restart-bot')).toEqual([]);
      work = null;
      await vi.waitFor(() => expect(sent.filter(s => s.type === 'control:restart-bot')).toHaveLength(1), { timeout: 5000, interval: 20 });
    } finally {
      removeHeldSaver(saver);
    }
  });
});

// After every serving row: this one marks the process as booted in maintenance, which no reset undoes.
describe('G8-14: a maintenance boot\'s leave waits while counted work runs', () => {
  it('a hook boot with no order: maintenance.json goes to running while premium\'s provider call runs; no restart until the call answered, then one', async () => {
    maintenance._setMaintenanceTiming({ filePollMs: 20, leaveRetryMs: 30 });
    writeMaintenanceFile('maintenance', 'm');
    writePremium({ 'guild:70000000000000001': { active: paidSub('s1', 'sub1', 'high'), paused: [] } });
    const call = gate<ReturnType<typeof providerState>>();
    const seen: string[] = [];
    getPaymentRegistry().register({
      id: 'fake', displayName: 'Fake', capabilities: { sells: ['guild'], supportsCancel: true }, isConfigured: () => true,
      cancelSubscription: async (subId: string) => { seen.push(subId); return call.promise; },
    } as any);
    const sent: any[] = [];
    maintenance._setMaintenanceSender(message => { sent.push(message); });
    const restarts = () => sent.filter(s => s.type === 'control:restart-bot');
    await maintenance.runMaintenanceBoot({ cause: 'hook', message: 'm' }, { shards: async () => 1, login: async () => undefined });

    const running = getPremiumManager().cancelPaidSubscription('guild:70000000000000001');
    await vi.waitFor(() => expect(seen).toEqual(['sub1']));
    writeMaintenanceFile('running', 'm');
    const waits = () => logged(spies.warn).filter(l => l.includes('[Maintenance] Nothing is held, but work this process accepted still runs'));
    await vi.waitFor(() => expect(waits().length + restarts().length).toBeGreaterThan(0), { timeout: 5000, interval: 20 });
    expect(restarts()).toEqual([]);
    expect(waits()[0]).toContain('premium: 1 change(s) waiting for a payment provider');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(restarts()).toEqual([]);

    call.open(providerState(false));
    await running;
    await vi.waitFor(() => expect(restarts()).toHaveLength(1), { timeout: 5000, interval: 20 });
  });

  it('the hook in a maintenance boot while premium\'s provider call runs: saved null with the work named, then saved true once the call answered', async () => {
    maintenance._setMaintenanceTiming({ filePollMs: 20 });
    writeMaintenanceFile('maintenance', 'm');
    writePremium({ 'guild:70000000000000001': { active: paidSub('s1', 'sub1', 'high'), paused: [] } });
    const call = gate<ReturnType<typeof providerState>>();
    const seen: string[] = [];
    getPaymentRegistry().register({
      id: 'fake', displayName: 'Fake', capabilities: { sells: ['guild'], supportsCancel: true }, isConfigured: () => true,
      cancelSubscription: async (subId: string) => { seen.push(subId); return call.promise; },
    } as any);
    await maintenance.runMaintenanceBoot({ cause: 'hook', message: 'm' }, { shards: async () => 1, login: async () => undefined });

    const running = getPremiumManager().cancelPaidSubscription('guild:70000000000000001');
    await vi.waitFor(() => expect(seen).toEqual(['sub1']));
    const answer = await maintenance.enterMaintenance('m', { handlerWaitMs: 50, saveBoundMs: 50 });
    expect(answer).toMatchObject({ saved: null, running: expect.stringContaining('premium: 1 change(s) waiting for a payment provider') });
    expect(logged(spies.warn).some(l => l.includes('still running and may save changes: premium: 1 change(s) waiting for a payment provider')
      && l.endsWith('can\'t confirm whether every change this process held is saved'))).toBe(true);

    call.open(providerState(false));
    await running;
    expect(await maintenance.enterMaintenance('m', { handlerWaitMs: 50, saveBoundMs: 50 })).toEqual({ saved: true });
  });
});
