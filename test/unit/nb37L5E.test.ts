import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB37 mutation gate, group E: premium's and the Dummy provider's held-saver answers (heldFiles, resaveHeld, openWork
// in exact words), the cache-stop registration, premium's refusal texts, a migration stopped by a maintenance refusal
// or by a deposition, the replay's marks watch, and the open-work words of more than one kind.

const h = vi.hoisted(() => ({
  refuse: new Map<string, string>(),
  saves: [] as string[],
  save: null as null | ((file: string) => unknown),
  confirm: null as null | ((ticket: unknown, ms: number, real: (t: any, ms: number) => Promise<string>) => Promise<string>),
  pg: false,
  gates: [] as Array<(value: unknown) => void>,
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = (await import('../helpers/longConfirm')).longConfirm(await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>());
  const ledger = await import('../../src/bot/internalSetup/utils/dataBackends/writeLedger');
  const { dataPath } = await import('../../src/utils/dataRoot');
  const premium = dataPath('global', 'premium-tiers.json');
  const guard = (filename: string, options: any) => {
    const cause = h.refuse.get(filename);
    if (!cause) return;
    ledger.recordRefusal(cause as any, `global:${options.category ?? ''}/${filename}`);
    throw new real.DataBackendUnavailableError(cause as any);
  };
  return {
    ...real,
    readRawStrict: (file: string) => {
      if (h.pg && file === premium) return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      return real.readRawStrict(file);
    },
    saveDataTracked: (f: string, o: any, d: unknown) => {
      h.saves.push(f);
      if (h.pg && f === 'premium-tiers.json') {
        return { outcome: 'saved', ticket: { kind: 'row', key: 'global/premium-tiers.json', op: { state: 'queued', unknown: [], commitOnWire: false, writes: 1 }, seq: 1 } };
      }
      guard(f, o);
      const faked = h.save?.(f);
      return faked ?? real.saveDataTracked(f, o, d);
    },
    appendDataTracked: (f: string, o: any, l: string) => { guard(f, o); return real.appendDataTracked(f, o, l); },
  };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return {
    ...real,
    confirmFile: (ticket: any, ms: number) => (h.confirm ? h.confirm(ticket, ms, real.confirmFile as any) : real.confirmFile(ticket, ms)),
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedStore', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedStore')>();
  return {
    ...real,
    rowBackend: (...args: any[]) => (h.pg ? { sharedSelect: async () => ({ rows: [] }) } : (real.rowBackend as any)(...args)),
    rowOutcome: (...args: any[]) => (h.pg ? new Promise(resolve => { h.gates.push(resolve); }) : (real.rowOutcome as any)(...args)),
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedMirror', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedMirror')>();
  return {
    ...real,
    setSharedLinesPassStep: (step: any) => (h.pg ? undefined : real.setSharedLinesPassStep(step)),
    refreshShared: (keys: string[]) => (h.pg ? Promise.resolve({ ok: true }) : (real.refreshShared as any)(keys)),
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedLines', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedLines')>();
  return {
    ...real,
    readLines: (...args: any[]) => (h.pg ? Promise.resolve({ ok: true, lines: [] }) : (real.readLines as any)(...args)),
    readJournal: (...args: any[]) => (h.pg ? Promise.resolve({ ok: true, lines: [] }) : (real.readJournal as any)(...args)),
  };
});
const store = vi.hoisted(() => ({ fake: null as any }));
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  return { ...real, getAppStoreManager: () => store.fake ?? real.getAppStoreManager() };
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
import { openWorkElsewhere } from '../../src/bot/internalSetup/utils/dataManager';
import { MaintenanceRefusal } from '../../src/bot/internalSetup/utils/maintenanceGate';
import {
  getPremiumManager, PremiumManager, registerCacheStop, resetPremiumManager, startPremiumTickers, unregisterCacheStop,
} from '../../src/bot/internalSetup/utils/premiumManager';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { startModuleAutoUpdater, stopModuleAutoUpdater } from '../../src/bot/internalSetup/utils/moduleAutoUpdater';
import { dataPath } from '../../src/utils/dataRoot';
import util from 'util';
import { OpenWork } from '../../src/bot/internalSetup/utils/openWork';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { setBackendKind } from '../helpers/backendKind';
import { ME, OrderStore, order, settle } from '../helpers/nx5Rig';
import { AUDIT, clearGlobal, linesOf, DUMMY_STATE, gate, JOURNAL, jsonOf, paidSub, PREMIUM, quiet, rawOf, settleQueue, state, writePremium } from './nb10PremiumRig';

const m = maintenance as any;
const role = process.env.BOT_PROCESS_ROLE;
const refuse = (...files: string[]) => { for (const f of files) h.refuse.set(f, 'storage-failing'); };
const recover = () => h.refuse.clear();
const grant = (guildId = 'g1', tierId = 'high') => applySharedOp({ op: 'premium.grantManual', args: { args: [guildId, tierId, 30] } });
const variant = { variantId: 'v9', label: 'V9', amount: 1, currency: 'USD', durationDays: 1, recurring: false, active: true };
const savesOf = (file: string) => h.saves.filter(f => f === file).length;
const END = new Date(Date.now() + 30 * 86_400_000).toISOString();
const providerState = (autoRenew: boolean) => ({ status: 'active' as const, startDate: new Date().toISOString(), endDate: END, autoRenew });
const SOURCE = 'v-old';
const TARGET = 'v-new';
const subOn = (id: string, providerSubId: string) => ({ ...paidSub(id, providerSubId, 'low'), variantId: SOURCE });
const migration = (decisions: Array<Record<string, unknown>>) => ({
  id: 'mig-1', providerId: 'fake', sourceTierId: 'low', sourceOfferingId: 'o1', sourceVariantId: SOURCE,
  targetTierId: 'high', targetOfferingId: 'o2', targetVariantId: TARGET,
  effectiveDate: new Date(Date.now() - 60_000).toISOString(), message: 'New price.', status: 'pending',
  createdAt: new Date().toISOString(), decisions,
});
const decision = (guildId: string, subscriptionId: string, providerSubId: string) => ({ guildId, subscriptionId, providerSubId, decision: 'accepted' });
const journalLine = (writer: string, n: number, event: object) => `${JSON.stringify({ writer, n, event })}\n`;
const expired = (providerSubId: string, guildId: string) => ({
  type: 'subscription.expired', providerId: 'discord', providerSubId, guildId, state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() },
});

beforeAll(() => clearGlobal());
beforeEach(async () => {
  quiet();
  recover();
  h.saves = [];
  h.save = null;
  h.confirm = null;
  h.pg = false;
  h.gates = [];
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
  for (const open of h.gates.splice(0)) open('landed');
  h.pg = false;
  setBackendKind(null);
  m.attachSaveOrderSource(null);
  maintenance._resetMaintenance();
  maintenance._setMaintenanceSender(null);
  recover();
  h.save = null;
  h.confirm = null;
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

function retriesOutOfReach(...caches: any[]): void {
  for (const cache of caches) {
    cache.clearRetry();
    cache.retryDelay = 60_000;
    cache.armRetry();
  }
}

describe('the open-work words', () => {
  it('two kinds of work are listed with a comma between them', () => {
    const work = new OpenWork('premium');
    work.begin('change(s) waiting for a payment provider');
    work.begin('change(s) waiting for a payment provider');
    work.begin('provider resume call(s)');
    expect(work.words()).toBe('premium: 2 change(s) waiting for a payment provider, 1 provider resume call(s)');
  });
});

describe('the cache-stop registration', () => {
  it('a target without resaveHeld is not taken as a held saver', () => {
    const target = { finalStop: () => undefined, markStopped: () => undefined, heldFiles: () => ['x.json'], openWork: () => 'nb37e: 1 lone piece' };
    registerCacheStop(target as any);
    try {
      expect(openWorkElsewhere()).not.toContain('nb37e: 1 lone piece');
    } finally {
      unregisterCacheStop(target as any);
    }
  });

  it('a target with both is a held saver until it is unregistered', () => {
    const target = { finalStop: () => undefined, markStopped: () => undefined, resaveHeld: () => undefined, heldFiles: () => [], openWork: () => 'nb37e: 1 piece' };
    registerCacheStop(target as any);
    expect(openWorkElsewhere()).toContain('nb37e: 1 piece');
    unregisterCacheStop(target as any);
    expect(openWorkElsewhere()).not.toContain('nb37e: 1 piece');
  });
});

describe("premium's held files and its save run", () => {
  it('an audit line held alone: heldFiles names the audit file, and resaveHeld appends it', async () => {
    refuse('premium-tiers.audit.jsonl');
    await grant('g1');
    const pm = getPremiumManager() as any;
    expect(pm.saveHeld).toBe(false);
    expect(pm.heldFiles()).toEqual([AUDIT]);
    retriesOutOfReach(pm);
    recover();
    pm.resaveHeld();
    expect(pm.heldFiles()).toEqual([]);
    await settleQueue();
    expect(linesOf(AUDIT).some(l => l.guildId === 'g1')).toBe(true);
  });

  it('a disposed manager reports no held file and saves nothing', async () => {
    refuse('premium-tiers.json');
    expect(await grant('g1')).toMatchObject({ answer: 'held' });
    const pm = getPremiumManager() as any;
    expect(pm.heldFiles()).toEqual([PREMIUM]);
    retriesOutOfReach(pm);
    resetPremiumManager();
    recover();
    expect(pm.heldFiles()).toEqual([]);
    const before = savesOf('premium-tiers.json');
    pm.resaveHeld();
    expect(savesOf('premium-tiers.json')).toBe(before);
  });

  it('a deposed manager with a held save writes nothing on resaveHeld', async () => {
    refuse('premium-tiers.json');
    expect(await grant('g1')).toMatchObject({ answer: 'held' });
    const pm = getPremiumManager() as any;
    retriesOutOfReach(pm);
    pm.markStopped('deposed');
    recover();
    const before = savesOf('premium-tiers.json');
    pm.resaveHeld();
    expect(savesOf('premium-tiers.json')).toBe(before);
    expect(jsonOf(PREMIUM).subscriptions.g1).toBeUndefined();
  });
});

describe("the Dummy provider's save run and refusals", () => {
  it('a deposed provider with a held save writes nothing on resaveHeld', () => {
    const dummy = new DummyProvider();
    getPaymentRegistry().register(dummy);
    refuse('state.json');
    dummy.adminSetVariant(variant as any);
    expect((dummy as any).saveHeld).toBe(true);
    retriesOutOfReach(dummy);
    dummy.markStopped('deposed');
    recover();
    const before = savesOf('state.json');
    dummy.resaveHeld();
    expect(savesOf('state.json')).toBe(before);
    expect(Object.keys(jsonOf(DUMMY_STATE)?.variants ?? {})).not.toContain('v9');
  });

  it('a call while the order holds is refused as maintenance', async () => {
    const dummy = new DummyProvider();
    getPaymentRegistry().register(dummy);
    const store = await inOrder();
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    let error: unknown;
    try {
      await dummy.cancelSubscription('nope', false);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MaintenanceRefusal);
    expect((error as Error).message).toBe('The Dummy provider changed nothing: the bot is in maintenance.');
  });

  it('a call while state.json cannot be read names the file and its cause', async () => {
    fs.mkdirSync(DUMMY_STATE.replace(/[\\/]state\.json$/, ''), { recursive: true });
    fs.writeFileSync(DUMMY_STATE, '5');
    const dummy = new DummyProvider();
    getPaymentRegistry().register(dummy);
    let error: unknown;
    try {
      await dummy.cancelSubscription('nope', false);
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toBe('The Dummy provider changed nothing: payment-providers/dummy/state.json cannot be read (invalid JSON: not a JSON object).');
  });
});

describe("premium's refusal texts", () => {
  const schedule = (pm: PremiumManager) => pm.scheduleMigration({
    providerId: 'fake', sourceTierId: 'low', sourceOfferingId: 'o1', sourceVariantId: 'v1',
    targetTierId: 'high', targetOfferingId: 'o2', targetVariantId: 'v2', effectiveDate: END, message: 'm',
  });

  it('an unreadable premium-tiers.json: the refusal names the file and its cause', async () => {
    fs.writeFileSync(PREMIUM, '[]');
    await expect(schedule(getPremiumManager())).rejects.toThrow(
      /^premium-tiers\.json cannot be read \(invalid JSON: not a JSON object\); nothing was saved\. Fix or restore the file, then try again\.$/);
  });

  it('while the order holds: the refusal says the bot is in maintenance', async () => {
    const pm = getPremiumManager();
    const store = await inOrder();
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    await expect(schedule(pm)).rejects.toThrow(/^Nothing was saved: the bot is in maintenance\.$/);
  });
});

describe("premium's open work in words", () => {
  it('a due migration whose provider call runs is named as a run of due price migrations', async () => {
    writePremium({ g1: { active: subOn('s1', 'sub1'), paused: [] } }, { migrations: [migration([decision('g1', 's1', 'sub1')])] });
    const call = gate<void>();
    const calls: string[] = [];
    getPaymentRegistry().register({
      id: 'fake', displayName: 'Fake', capabilities: {}, isConfigured: () => true,
      migrateSubscriptionPrice: async (subId: string) => { calls.push(subId); await call.promise; return providerState(true); },
    } as any);
    const pm = getPremiumManager();
    const run = pm.processDueMigrations();
    await vi.waitFor(() => expect(calls).toEqual(['sub1']));
    expect(pm.openWork()).toBe('premium: 1 run(s) of due price migrations');
    call.open();
    await run;
  });

  it('a save on a Postgres bot whose row op has not settled is named as a save waiting for the database', async () => {
    h.pg = true;
    setBackendKind('postgres');
    const pm = new PremiumManager();
    try {
      pm.load();
      expect(pm.setMessages({ upgradeButtonLabel: 'Open' })).toBe(true);
      expect(pm.openWork()).toBe('premium: 1 save(s) of premium-tiers.json waiting for the database');
      for (const open of h.gates.splice(0)) open('landed');
      await vi.waitFor(() => expect(pm.openWork()).toBeNull(), { timeout: 3000, interval: 10 });
    } finally {
      pm.dispose();
    }
  });
});

describe('a due migration stopped part way', () => {
  function provider(answer: (subId: string) => Promise<unknown>): string[] {
    const calls: string[] = [];
    getPaymentRegistry().register({
      id: 'fake', displayName: 'Fake', capabilities: {}, isConfigured: () => true,
      migrateSubscriptionPrice: async (subId: string) => { calls.push(subId); return answer(subId); },
    } as any);
    return calls;
  }

  it('the first decision refused as maintenance: nothing is saved', async () => {
    writePremium({ g1: { active: subOn('s1', 'sub1'), paused: [] } }, { migrations: [migration([decision('g1', 's1', 'sub1')])] });
    const calls = provider(async () => { throw new MaintenanceRefusal('The Dummy provider changed nothing: the bot is in maintenance.'); });
    const pm = getPremiumManager();
    pm.getFullConfig();
    const before = savesOf('premium-tiers.json');
    await pm.processDueMigrations();
    expect(calls).toEqual(['sub1']);
    await settleQueue();
    expect(savesOf('premium-tiers.json')).toBe(before);
    expect(pm.heldFiles()).toEqual([]);
  });

  it('the second decision refused as maintenance: the first one is saved', async () => {
    writePremium(
      { g1: { active: subOn('s1', 'sub1'), paused: [] }, g2: { active: subOn('s2', 'sub2'), paused: [] } },
      { migrations: [migration([decision('g1', 's1', 'sub1'), decision('g2', 's2', 'sub2')])] },
    );
    provider(async subId => {
      if (subId === 'sub2') throw new MaintenanceRefusal('The Dummy provider changed nothing: the bot is in maintenance.');
      return providerState(true);
    });
    const pm = getPremiumManager();
    await pm.processDueMigrations();
    await settleQueue();
    const stored = jsonOf(PREMIUM).migrations[0];
    expect(stored.status).toBe('pending');
    expect(stored.decisions[0].outcome).toBe('migrated');
    expect(stored.decisions[1].outcome).toBeUndefined();
    await vi.waitFor(() => expect(pm.openWork()).toBeNull(), { timeout: 3000, interval: 10 });
  });

  it('a deposition during the second decision: the first decision\'s notice is let go and no notice stays open', async () => {
    writePremium(
      { g1: { active: subOn('s1', 'sub1'), paused: [] }, g2: { active: subOn('s2', 'sub2'), paused: [] } },
      { migrations: [migration([decision('g1', 's1', 'sub1'), decision('g2', 's2', 'sub2')])] },
    );
    const second = gate<void>();
    const calls = provider(async subId => {
      if (subId === 'sub2') await second.promise;
      return providerState(true);
    });
    const pm = getPremiumManager();
    const run = pm.processDueMigrations();
    await vi.waitFor(() => expect(calls).toEqual(['sub1', 'sub2']));
    pm.markStopped('deposed');
    second.open();
    await run;
    await vi.waitFor(() => expect(pm.openWork()).toBeNull(), { timeout: 3000, interval: 10 });
  });
});

describe("the replay's marks watch", () => {
  const replaySubs = () => ({ g1: { active: paidSub('s1', 'd1', 'low', 'discord'), paused: [] } });

  /** Runs fn when the replay waits for the last time, after its loop handed `handed` events. */
  function atLastWait(pm: PremiumManager, handed: number, fn: () => void): void {
    const real = pm.settled.bind(pm);
    let calls = 0;
    vi.spyOn(pm, 'settled').mockImplementation((ledger: any) => {
      calls += 1;
      if (calls === handed + 1) fn();
      return real(ledger);
    });
  }

  it('a save of the marks that has not landed is named in exact words', async () => {
    writePremium(replaySubs());
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, expired('d1', 'g1')));
    resetPremiumManager();
    reg.current = null;
    const pm = getPremiumManager();
    const ticket = { kind: 'file' as const, path: PREMIUM, seq: 1, record: { landed: 0 } };
    atLastWait(pm, 1, () => {
      let used = false;
      h.save = file => {
        if (used || file !== 'premium-tiers.json') return undefined;
        used = true;
        return { outcome: 'saved', ticket };
      };
    });
    h.confirm = (t, ms, real) => (t === ticket ? Promise.resolve('pending') : real(t, ms));
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 10 });
    await vi.waitFor(() => expect(pm.openWork()).toBe("premium: 1 replay audit line(s) and journal deletes waiting for the save of the replay's marks"), { timeout: 3000, interval: 10 });
  });

  it('once the marks landed and the journal is deleted, no work stays open', async () => {
    writePremium(replaySubs());
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, expired('d1', 'g1')));
    resetPremiumManager();
    reg.current = null;
    const pm = getPremiumManager();
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 10 });
    await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 5000, interval: 10 });
    await vi.waitFor(() => expect(pm.openWork()).toBeNull(), { timeout: 3000, interval: 10 });
  });
});

describe("the module auto-updater's tick", () => {
  it('a check whose error log throws: the tick logs that error as a tick error', async () => {
    store.fake = {
      getInstalledModules: () => [{ name: 'm' }],
      checkAllModulesForUpdates: async () => { throw { [util.inspect.custom]: () => { throw new Error('x'); } }; },
    };
    fs.mkdirSync(dataPath('global', 'appstore'), { recursive: true });
    fs.writeFileSync(dataPath('global', 'appstore', 'config.json'), JSON.stringify({ autoUpdate: true }));
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(util.format(...args)); });
    let run: (() => void) | null = null;
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { run = fn; return 0; }) as never);
    try {
      startModuleAutoUpdater({} as any);
    } finally {
      spy.mockRestore();
    }
    try {
      run!();
      for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
      expect(lines.filter(l => l.startsWith('[ModuleAutoUpdater] Tick error: Error: x'))).toHaveLength(1);
    } finally {
      stopModuleAutoUpdater();
      store.fake = null;
    }
  });
});
