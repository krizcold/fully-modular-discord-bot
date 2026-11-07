import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 tests 8 and 23: the bot process reports `shared` only once its boot mode is known and the shared-op handler is
// registered, and `guild` only once the guild data handlers and the premium tickers run. clientInitializer runs its
// real main(); every module it starts is a stand-in that records the order, and the reports are the real
// reportWriterStage sends, read from process.send. A maintenance boot runs the real runMaintenanceBoot.

const ctl = vi.hoisted(() => ({
  order: [] as string[],
  decide: null as null | (() => Promise<any>),
  shards: null as null | (() => Promise<number>),
}));
const rec = (name: string) => () => { ctl.order.push(name); };

vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/utils/envLoader', async orig => ({ ...(await orig<any>()), loadCredentials: () => ({}) }));
vi.mock('../../src/bot/internalSetup/utils/getAllFiles', () => ({ default: () => [] }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', () => ({
  getPanelManager: () => ({ loadPanels: async () => undefined, registerPanel: () => undefined, recoverPanels: async () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/ipcPanelHandler', () => ({ setupPanelIPCHandlers: rec('setupPanelIPCHandlers') }));
vi.mock('../../src/bot/internalSetup/utils/ipcCommandHandler', () => ({ setupCommandIPCHandlers: rec('setupCommandIPCHandlers') }));
vi.mock('../../src/bot/internalSetup/utils/ipcDataHandler', () => ({ setupDataIPCHandlers: rec('setupDataIPCHandlers') }));
vi.mock('../../src/bot/internalSetup/utils/accessLogChannel', () => ({ setupAccessLogChannel: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcMetricsHandler', () => ({ markMetricsReady: () => undefined, setupMetricsIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcFleetHandler', () => ({ setupFleetIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/metrics/metricsCollector', () => ({
  getMetricsCollector: () => ({ seedTotals: () => undefined, flushTotals: () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/metrics/samplers', () => ({ startSamplers: () => undefined, stopSamplers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcReloadHandler', () => ({ setupReloadIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcToggleHandler', () => ({ setupToggleIPCHandlers: () => undefined, applyAllDisabledStatesOnBoot: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcNotificationHandler', () => ({ setupIPCNotificationHandler: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/subscriptionNotifier', () => ({
  getSubscriptionNotifier: () => ({ setClient: rec('notifier setClient') }),
}));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({ listAll: () => [], get: () => undefined, on: () => undefined, off: () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/premiumManager', async orig => ({
  ...(await orig<any>()),
  startPremiumTickers: rec('startPremiumTickers'),
  getPremiumManager: rec('getPremiumManager'),
}));
vi.mock('../../src/bot/internalSetup/utils/moduleAutoUpdater', () => ({ startModuleAutoUpdater: () => undefined }));
vi.mock('../../src/bot/internalSetup/fleet/shardBoot', () => ({
  bootShards: async () => { ctl.order.push('bootShards'); return { startIngest: rec('startIngest') }; },
}));
vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => ({
  getIngestService: () => ({
    buildClient: () => ({ once: () => undefined, on: () => undefined, user: null }),
    close: async () => undefined,
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/moduleLoader', () => ({
  ModuleLoader: class { async loadAllModules() { return []; } },
}));
vi.mock('../../src/bot/internalSetup/utils/moduleRegistry', () => ({
  getModuleRegistry: () => ({ setClient: () => undefined, getStats: () => ({ total: 0, byCategory: {} }) }),
}));
vi.mock('../../src/bot/internalSetup/utils/configManager', async orig => ({ ...(await orig<any>()), ensureConfigPopulated: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => ({
  ...(await orig<any>()),
  initDataBackendLayer: rec('initDataBackendLayer'),
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  addStopStep: () => undefined,
  getGuildDataBackend: () => null,
  sweepGraveyard: async () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/sharedOps', async orig => ({
  ...(await orig<any>()),
  setupSharedOpsIPC: rec('setupSharedOpsIPC'),
}));
vi.mock('../../src/bot/internalSetup/utils/maintenanceGate', async orig => {
  const real = await orig<any>();
  return { ...real, markMaintenanceBoot: () => { ctl.order.push('markMaintenanceBoot'); real.markMaintenanceBoot(); } };
});
vi.mock('../../src/bot/internalSetup/utils/maintenance', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    decideBoot: async () => {
      ctl.order.push('decideBoot started');
      const decision = await ctl.decide!();
      ctl.order.push('decideBoot resolved');
      return decision;
    },
    setupMaintenanceIPCAtBoot: rec('setupMaintenanceIPCAtBoot'),
    watchDataBackend: () => undefined,
    installMaintenanceGate: () => undefined,
    markDiscordStarted: () => undefined,
    runMaintenanceBoot: (decision: any) => {
      ctl.order.push('runMaintenanceBoot');
      return real.runMaintenanceBoot(decision, { shards: ctl.shards!, login: async () => undefined, sleep: () => new Promise(resolve => setTimeout(resolve, 1)) });
    },
  };
});

import { gate } from './nb10PremiumRig';

const reports = (): string[] => ctl.order.filter(o => o.startsWith('report '));
const at = (name: string): number => {
  const i = ctl.order.indexOf(name);
  expect(i, `${name} in ${ctl.order.join(', ')}`).toBeGreaterThanOrEqual(0);
  return i;
};
const realSend = process.send;
const role = process.env.BOT_PROCESS_ROLE;

beforeEach(() => {
  vi.resetModules();
  ctl.order.length = 0;
  process.env.BOT_PROCESS_ROLE = 'bot';
  (process as any).send = vi.fn((message: any) => {
    if (message?.type === 'data:writer') ctl.order.push(`report ${message.data.stage}`);
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  (process as any).send = realSend;
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  vi.restoreAllMocks();
});

describe('the report order of a bot process (NB10 tests 8 and 23)', () => {
  it('a normal boot reports nothing while decideBoot runs, shared after the shared-op handler, guild after the data handlers and tickers', async () => {
    const decision = gate<any>();
    ctl.decide = () => decision.promise;
    void (await import('../../src/bot/internalSetup/clientInitializer')).main().catch(console.error);
    await vi.waitFor(() => expect(ctl.order).toContain('decideBoot started'), { timeout: 5000, interval: 5 });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(reports()).toEqual([]);
    expect(ctl.order).not.toContain('setupSharedOpsIPC');
    decision.open({ mode: 'normal' });
    await vi.waitFor(() => expect(reports()).toEqual(['report shared', 'report guild']), { timeout: 5000, interval: 5 });
    expect(at('decideBoot resolved')).toBeLessThan(at('report shared'));
    expect(at('setupSharedOpsIPC')).toBeLessThan(at('report shared'));
    expect(at('report shared')).toBeLessThan(at('bootShards'));
    expect(at('setupDataIPCHandlers')).toBeLessThan(at('report guild'));
    expect(at('notifier setClient')).toBeLessThan(at('startPremiumTickers'));
    expect(at('startPremiumTickers')).toBeLessThan(at('report guild'));
    expect(ctl.order).not.toContain('markMaintenanceBoot');
  });

  it('a maintenance boot whose shard count keeps failing reports shared and guild after markMaintenanceBoot and starts no ticker', async () => {
    const decision = gate<any>();
    ctl.decide = () => decision.promise;
    let tries = 0;
    ctl.shards = async () => {
      tries += 1;
      if (tries > 3) return new Promise<number>(() => undefined);
      throw new Error('Discord unreachable');
    };
    void (await import('../../src/bot/internalSetup/clientInitializer')).main().catch(console.error);
    await vi.waitFor(() => expect(ctl.order).toContain('decideBoot started'), { timeout: 5000, interval: 5 });
    expect(reports()).toEqual([]);
    decision.open({ mode: 'maintenance', cause: 'hook', message: 'Back soon.' });
    await vi.waitFor(() => expect(tries).toBeGreaterThan(2), { timeout: 5000, interval: 5 });
    expect(reports()).toEqual(['report shared', 'report guild']);
    expect(at('runMaintenanceBoot')).toBeLessThan(at('markMaintenanceBoot'));
    expect(at('markMaintenanceBoot')).toBeLessThan(at('report shared'));
    expect(ctl.order).not.toContain('startPremiumTickers');
    expect(ctl.order).not.toContain('initDataBackendLayer');
    expect(ctl.order).not.toContain('bootShards');
    expect(ctl.order).not.toContain('setupMaintenanceIPCAtBoot');
  });
});
