import { describe, expect, it, vi } from 'vitest';

// NB10 stop order (the bot's stop step): it stops the samplers, closes the gateway (bounded, and a failed close is
// logged), and only then flushes the metric totals while the maintenance gate is open. clientInitializer runs its real
// main(); every module it starts is a stand-in, and the stop step it adds is captured and run.

const ctl = vi.hoisted(() => ({
  order: [] as string[],
  steps: [] as Array<() => Promise<void>>,
  close: (async () => undefined) as (reason: string) => Promise<void>,
  reported: [] as string[],
}));

vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/utils/envLoader', async orig => ({ ...(await orig<any>()), loadCredentials: () => ({}) }));
vi.mock('../../src/bot/internalSetup/utils/getAllFiles', () => ({ default: () => [] }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', () => ({
  getPanelManager: () => ({ loadPanels: async () => undefined, registerPanel: () => undefined, recoverPanels: async () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/ipcPanelHandler', () => ({ setupPanelIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcCommandHandler', () => ({ setupCommandIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcDataHandler', () => ({ setupDataIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/accessLogChannel', () => ({ setupAccessLogChannel: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcMetricsHandler', () => ({ markMetricsReady: () => undefined, setupMetricsIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcFleetHandler', () => ({ setupFleetIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/metrics/metricsCollector', () => ({
  getMetricsCollector: () => ({ seedTotals: () => undefined, flushTotals: () => { ctl.order.push('flushTotals'); } }),
}));
vi.mock('../../src/bot/internalSetup/utils/metrics/samplers', () => ({
  startSamplers: () => undefined,
  stopSamplers: () => { ctl.order.push('stopSamplers'); },
}));
vi.mock('../../src/bot/internalSetup/utils/ipcReloadHandler', () => ({ setupReloadIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcToggleHandler', () => ({ setupToggleIPCHandlers: () => undefined, applyAllDisabledStatesOnBoot: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcNotificationHandler', () => ({ setupIPCNotificationHandler: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/subscriptionNotifier', () => ({ getSubscriptionNotifier: () => ({ setClient: () => undefined }) }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({ listAll: () => [], get: () => undefined, on: () => undefined, off: () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/premiumManager', async orig => ({
  ...(await orig<any>()),
  startPremiumTickers: () => undefined,
  getPremiumManager: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/moduleAutoUpdater', () => ({ startModuleAutoUpdater: () => undefined }));
vi.mock('../../src/bot/internalSetup/fleet/shardBoot', () => ({ bootShards: async () => ({ startIngest: () => undefined }), getShardClaims: () => null }));
vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => ({
  getIngestService: () => ({
    buildClient: () => ({ once: () => undefined, on: () => undefined, user: null }),
    close: (reason: string) => { ctl.order.push(`close ${reason}`); return ctl.close(reason); },
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/moduleLoader', () => ({ ModuleLoader: class { async loadAllModules() { return []; } } }));
vi.mock('../../src/bot/internalSetup/utils/moduleRegistry', () => ({
  getModuleRegistry: () => ({ setClient: () => undefined, getStats: () => ({ total: 0, byCategory: {} }) }),
}));
vi.mock('../../src/bot/internalSetup/utils/configManager', async orig => ({ ...(await orig<any>()), ensureConfigPopulated: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => ({ ...(await orig<any>()), initDataBackendLayer: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  addStopStep: (fn: () => Promise<void>) => { ctl.steps.push(fn); },
  getGuildDataBackend: () => null,
  sweepGraveyard: async () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/sharedOps', async orig => ({ ...(await orig<any>()), setupSharedOpsIPC: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/maintenance', async orig => ({
  ...(await orig<any>()),
  decideBoot: async () => ({ mode: 'normal' }),
  setupMaintenanceIPCAtBoot: () => undefined,
  watchDataBackend: () => undefined,
  installMaintenanceGate: () => undefined,
  markDiscordStarted: () => undefined,
}));

let booted: Promise<() => Promise<void>> | null = null;
/** Boots clientInitializer once and answers the stop step it added (the last one, the drain's). */
function stopStep(): Promise<() => Promise<void>> {
  booted ??= (async () => {
    const realSend = process.send;
    const role = process.env.BOT_PROCESS_ROLE;
    process.env.BOT_PROCESS_ROLE = 'bot';
    (process as any).send = (message: any) => {
      if (message?.type === 'data:writer') ctl.reported.push(message.data.stage);
      return true;
    };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await import('../../src/bot/internalSetup/clientInitializer');
      await vi.waitFor(() => expect(ctl.reported).toContain('guild'), { timeout: 5000, interval: 5 });
      await vi.waitFor(() => expect(ctl.steps.length).toBeGreaterThan(0), { timeout: 5000, interval: 5 });
    } finally {
      (process as any).send = realSend;
      if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
      else process.env.BOT_PROCESS_ROLE = role;
    }
    return ctl.steps[ctl.steps.length - 1];
  })();
  return booted;
}

/** Runs the step, failing when it has not settled within the bound. */
async function runWithin(step: () => Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), ms); });
  const outcome = await Promise.race([step().then(() => 'done' as const), late]);
  clearTimeout(timer);
  expect(outcome).toBe('done');
}

describe('the bot stop step', () => {
  it('stops the samplers, closes the gateway shutting down, then flushes the metric totals', async () => {
    const step = await stopStep();
    ctl.order.length = 0;
    ctl.close = async () => undefined;
    await runWithin(step, 1000);
    expect(ctl.order).toEqual(['stopSamplers', 'close shutting down', 'flushTotals']);
  });

  it('a gateway close that fails is logged and the step goes on to the flush', async () => {
    const step = await stopStep();
    ctl.order.length = 0;
    const failure = new Error('gateway refused');
    ctl.close = async () => { throw failure; };
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await runWithin(step, 1000);
      expect(warns).toHaveBeenCalledWith('[clientInitializer] Could not close the gateway on shutdown:', failure);
      expect(ctl.order).toEqual(['stopSamplers', 'close shutting down', 'flushTotals']);
    } finally {
      warns.mockRestore();
    }
  });
});
