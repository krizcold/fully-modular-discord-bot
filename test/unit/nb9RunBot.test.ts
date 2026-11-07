import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeChannel, standbyEnv } from '../helpers/standbyRig';

// NB9 test 19 (28, 43, 44, C3, C11, D1, D3) and test 27's rows of a serving process's release steps: clientInitializer's
// real runBot() with every module it starts a stand-in that records. The promoted-standby rows run the real
// standbyMain() of a JSON standby on one recording channel, which the stand-in maintenance listeners share, so each
// message's answers can be counted.

const h = vi.hoisted(() => ({
  order: [] as string[],
  decide: { mode: 'normal' } as any,
  boots: [] as unknown[],
  context: { shardCount: 1 } as Record<string, unknown>,
  stopped: false,
  stopSteps: [] as Array<() => Promise<void>>,
  releaseSteps: [] as Array<() => Promise<void>>,
  channel: null as any,
  client: null as any,
  built: 0,
  adopted: [] as unknown[],
  shardPlan: null as null | { shards: number[]; shardCount: number },
}));
const rec = (name: string) => () => { h.order.push(name); };

/** The maintenance listener the real setupMaintenanceIPC installs, as a stand-in on the shared channel: one answer each. */
const maintenanceListener = (from: string) => () => {
  h.order.push(from);
  h.channel?.on('message', (m: any) => {
    if (typeof m?.requestId === 'string' && String(m.type).startsWith('maintenance:')) h.channel.send({ requestId: m.requestId, data: { from } });
  });
};

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
vi.mock('../../src/bot/internalSetup/utils/ipcMetricsHandler', () => ({ markMetricsReady: () => undefined, setupMetricsIPCHandlers: rec('setupMetricsIPCHandlers') }));
vi.mock('../../src/bot/internalSetup/utils/ipcFleetHandler', () => ({ setupFleetIPCHandlers: rec('setupFleetIPCHandlers') }));
vi.mock('../../src/bot/internalSetup/utils/metrics/metricsCollector', () => ({
  getMetricsCollector: () => ({ seedTotals: () => undefined, flushTotals: () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/metrics/samplers', () => ({ startSamplers: () => undefined, stopSamplers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcReloadHandler', () => ({ setupReloadIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcToggleHandler', () => ({ setupToggleIPCHandlers: () => undefined, applyAllDisabledStatesOnBoot: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcNotificationHandler', () => ({ setupIPCNotificationHandler: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/subscriptionNotifier', () => ({ getSubscriptionNotifier: () => ({ setClient: () => undefined }) }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({ listAll: () => [], get: () => undefined, on: () => undefined, off: () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/premiumManager', async orig => ({ ...(await orig<any>()), startPremiumTickers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/moduleAutoUpdater', () => ({ startModuleAutoUpdater: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/moduleLoader', () => ({ ModuleLoader: class { async loadAllModules() { return []; } } }));
vi.mock('../../src/bot/internalSetup/utils/moduleRegistry', () => ({
  getModuleRegistry: () => ({ setClient: () => undefined, getStats: () => ({ total: 0, byCategory: {} }) }),
}));
vi.mock('../../src/bot/internalSetup/utils/configManager', async orig => ({ ...(await orig<any>()), ensureConfigPopulated: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => ({
  ...(await orig<any>()),
  initDataBackendLayer: rec('initDataBackendLayer'),
  awaitDataStartupBarrier: async () => 'ready',
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  addStopStep: (fn: () => Promise<void>) => { h.order.push('addStopStep'); h.stopSteps.push(fn); },
  addReleaseStep: (fn: () => Promise<void>) => { h.order.push('addReleaseStep'); h.releaseSteps.push(fn); },
  getGuildDataBackend: () => null,
  sweepGraveyard: async () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/sharedOps', async orig => ({ ...(await orig<any>()), setupSharedOpsIPC: rec('setupSharedOpsIPC') }));
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => ({
  ...(await orig<any>()),
  reportWriterStage: (stage: string) => { h.order.push(`report ${stage}`); },
}));
vi.mock('../../src/bot/internalSetup/utils/maintenance', async orig => ({
  ...(await orig<any>()),
  decideBoot: async () => { h.order.push('decideBoot'); return h.decide; },
  runMaintenanceBoot: async () => { maintenanceListener('runMaintenanceBoot')(); return new Promise(() => undefined); },
  setupMaintenanceIPCAtBoot: () => { maintenanceListener('setupMaintenanceIPCAtBoot')(); },
  watchDataBackend: rec('watchDataBackend'),
  installMaintenanceGate: () => undefined,
  markDiscordStarted: rec('markDiscordStarted'),
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/mainDatabase', () => ({
  stopMainWatch: rec('stopMainWatch'),
  noteShardReconnect: () => undefined,
  setStepLayers: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/fleet/guildRequests', () => ({
  guildRequestsStopStep: async () => { h.order.push('guildRequestsStopStep'); },
  startGuildRequestSweep: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/servingGate', async orig => ({ ...(await orig<any>()), stoppedServing: () => h.stopped }));
vi.mock('../../src/bot/internalSetup/fleet/shardBoot', async orig => ({
  ...(await orig<any>()),
  bootShards: async (...args: unknown[]) => {
    h.order.push('bootShards');
    h.boots.push(args);
    return { ...h.context, startIngest: rec('startIngest') };
  },
  getShardClaims: () => ({ beginStop: () => undefined, finishStop: async () => { h.order.push('finishStop'); } }),
  getLeaseRuntime: () => null,
}));

/** A discord.js Client as runBot uses it: listeners, emit, its intents and isReady() answering true (resetGateway's state). */
function fakeClient(intents: number) {
  const events = new EventEmitter();
  const emitted: string[] = [];
  const client: any = {
    options: { intents },
    user: { tag: 'bot#0001' },
    isReady: () => true,
    on: (event: string, fn: (...a: any[]) => void) => { events.on(event, fn); return client; },
    once: (event: string, fn: (...a: any[]) => void) => { events.once(event, fn); return client; },
    emit: (event: string, ...args: unknown[]) => { emitted.push(event); return events.emit(event, ...args); },
    listenerCount: (event: string) => events.listenerCount(event),
    emitted,
  };
  return client;
}

vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => {
  const service = {
    buildClient: (options: { intents: number | number[] }) => {
      h.built += 1;
      h.order.push('buildClient');
      const bits = Array.isArray(options.intents) ? options.intents.reduce((a, b) => a | b, 0) : options.intents;
      h.client = fakeClient(bits);
      return h.client;
    },
    adoptClient: (client: unknown) => { h.order.push('adoptClient'); h.adopted.push(client); return client; },
    getClient: () => h.client,
    close: async () => { h.order.push('close'); },
    setIdentifyThrottler: () => undefined,
    setShardPlan: (shards: number[], shardCount: number) => { h.shardPlan = { shards, shardCount }; },
    isStarted: () => false,
    start: async () => { h.order.push('login'); return ''; },
  };
  return { getIngestService: () => service, IngestService: class {} };
});

const DEFAULT_BITS = 1 | 2 | 512 | 32768 | 1024;

let logs: string[];
let warns: string[];
beforeEach(() => {
  vi.resetModules();
  h.order.length = 0;
  h.decide = { mode: 'normal' };
  h.boots.length = 0;
  h.context = { shardCount: 1 };
  h.stopped = false;
  h.stopSteps.length = 0;
  h.releaseSteps.length = 0;
  h.channel = null;
  h.client = null;
  h.built = 0;
  h.adopted.length = 0;
  logs = [];
  warns = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 1)); };
const at = (name: string) => h.order.indexOf(name);

/** A promoted JSON standby on the shared channel; runBot is the real one, with releaseInjected wrapped by `hold`. */
async function promotedStandby(opts: { hold?: Promise<void> } = {}) {
  const channel = new FakeChannel();
  h.channel = channel;
  const sb = await import('../../src/bot/internalSetup/fleet/standbyBoot');
  const ci = await import('../../src/bot/internalSetup/clientInitializer');
  const state = await import('../../src/bot/internalSetup/fleet/state');
  sb._resetStandbyBoot();
  let ran: Promise<void> | null = null;
  await sb.standbyMain({
    env: standbyEnv({ SMDB_RESHARD_DB: undefined, SMDB_RESHARD_COUNT: '2', SMDB_RESHARD_INTENTS: String(1 | 512) }),
    channel,
    takeLock: async () => { h.order.push('lock'); },
    runBot: runOpts => {
      ran = ci.runBot({
        ...runOpts,
        releaseInjected: async () => {
          h.order.push('releaseInjected started');
          await opts.hold;
          await runOpts.releaseInjected!();
          h.order.push('releaseInjected resolved');
        },
      });
      return ran;
    },
    stop: rec('stop'),
  });
  const client = h.client;
  // From here on, what the serve does.
  h.order.length = 0;
  h.built = 0;
  channel.deliver({ type: 'reshard:promoted' });
  await settle();
  return { channel, client, sb, state, ran: () => ran };
}

describe('test 19: runBot (C11, 28)', () => {
  it("runBot({}) runs the normal boot's steps in their order and logs in through the context", async () => {
    const ci = await import('../../src/bot/internalSetup/clientInitializer');
    const state = await import('../../src/bot/internalSetup/fleet/state');
    await ci.runBot({});
    expect(h.order.filter(n => !n.startsWith('report ') || n === 'report shared')).toEqual([
      'decideBoot', 'addStopStep', 'addReleaseStep', 'addReleaseStep', 'addReleaseStep', 'setupMaintenanceIPCAtBoot',
      'initDataBackendLayer', 'watchDataBackend', 'setupFleetIPCHandlers', 'setupMetricsIPCHandlers', 'setupSharedOpsIPC',
      'report shared', 'bootShards', 'buildClient', 'markDiscordStarted', 'startIngest',
    ]);
    expect(h.boots).toEqual([[]]);
    expect(h.client.emitted).toEqual([]);
    expect(state.loginIntents()).toBe(DEFAULT_BITS);
  });

  it("D1: with taken and the Client, keptSessions unset and isReady() true: adoptClient once, no buildClient, no 'clientReady', startIngest", async () => {
    h.context = { shardCount: 2 };
    const r = await promotedStandby();
    await r.ran();
    expect(h.adopted).toEqual([r.client]);
    expect(h.built).toBe(0);
    expect(h.boots).toEqual([[{ taken: expect.objectContaining({ json: true, count: 2 }) }]]);
    expect(r.client.emitted).toEqual([]);
    expect(logs.some(l => l.startsWith('Logged in as'))).toBe(false);
    expect(at('startIngest')).toBeGreaterThan(at('markDiscordStarted'));
    expect(h.order).not.toContain('login');
  });

  it("keptSessions true: 'clientReady' once after the handlers, each 'clientReady' handler once, L20 for the intents it did not log in with", async () => {
    h.context = { shardCount: 2, keptSessions: true };
    const r = await promotedStandby();
    await r.ran();
    expect(r.client.emitted).toEqual(['clientReady']);
    expect(logs.filter(l => l === 'Logged in as bot#0001!')).toHaveLength(1);
    expect(warns).toContain('[Shards] The modules ask for gateway intents GuildMembers, GuildMessageReactions, MessageContent that this process did not log in with; they apply at its next restart');
    expect(r.state.loginIntents()).toBe(1 | 512);
    expect(h.order).not.toContain('login');
  });

  it("keptSessions true but the process stopped serving: no 'clientReady' (D1, 44)", async () => {
    h.context = { shardCount: 2, keptSessions: true };
    h.stopped = true;
    const r = await promotedStandby();
    await r.ran();
    expect(r.client.emitted).toEqual([]);
  });
});

describe("test 19: the standby's maintenance answers end where the bot's listener starts (D3)", () => {
  it("'maintenance' with taken: an enter while releaseInjected() is held gets the standby's one answer; a leave after runMaintenanceBoot gets one, the maintenance listener's, and no restart ask", async () => {
    h.decide = { mode: 'maintenance', cause: 'hook', message: 'Back soon.' };
    let open: () => void = () => undefined;
    const hold = new Promise<void>(resolve => { open = resolve; });
    const r = await promotedStandby({ hold });
    expect(h.order).toContain('releaseInjected started');
    r.channel.deliver({ type: 'maintenance:enter', requestId: 'e1' });
    expect(r.channel.answers('e1')).toEqual([{ requestId: 'e1', data: { saved: true } }]);
    open();
    await settle();
    expect(at('releaseInjected resolved')).toBeLessThan(at('runMaintenanceBoot'));
    r.channel.deliver({ type: 'maintenance:leave', requestId: 'l1' });
    expect(r.channel.answers('l1')).toEqual([{ requestId: 'l1', data: { from: 'runMaintenanceBoot' } }]);
    expect(r.channel.of('control:restart-bot')).toEqual([]);
  });

  it("'normal': a leave after setupMaintenanceIPCAtBoot gets one answer, the bot's listener's", async () => {
    const r = await promotedStandby();
    await r.ran();
    r.channel.deliver({ type: 'maintenance:leave', requestId: 'l2' });
    expect(r.channel.answers('l2')).toEqual([{ requestId: 'l2', data: { from: 'setupMaintenanceIPCAtBoot' } }]);
    expect(r.channel.of('control:restart-bot')).toEqual([]);
  });
});

describe('test 27: the release steps of a serving process (C3)', () => {
  it("a promoted standby after the switch: stopMainWatch, NB7's step, then the 'serving' release; the 'pre-serve' step does nothing", async () => {
    const r = await promotedStandby();
    await r.ran();
    expect(r.sb.claimsPhase()).toBe('serving');
    h.order.length = 0;
    for (const step of h.releaseSteps) await step();
    await r.sb.claimsStop('pre-serve');
    expect(h.order).toEqual(['stopMainWatch', 'guildRequestsStopStep', 'finishStop']);
  });

  it('a normal process: the same order and one release', async () => {
    const ci = await import('../../src/bot/internalSetup/clientInitializer');
    await ci.runBot({});
    h.order.length = 0;
    for (const step of h.releaseSteps) await step();
    expect(h.order).toEqual(['stopMainWatch', 'guildRequestsStopStep', 'finishStop']);
  });
});

describe('test 19: a promoted standby after the switch (41, NB4)', () => {
  it("a taken naming another process: bootShards rejects before it takes anything", async () => {
    const real = await vi.importActual<typeof import('../../src/bot/internalSetup/fleet/shardBoot')>('../../src/bot/internalSetup/fleet/shardBoot');
    const events: string[] = [];
    const taken: any = {
      count: 2, processId: 'another-process', pairs: [], runtime: { applyGrant: async () => { events.push('grant'); } },
      stopLanes: async () => { events.push('stopLanes'); }, release: async () => { events.push('release'); }, onServing: () => { events.push('serving'); },
    };
    let error: unknown = null;
    try { await real.bootShards({ taken }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('another-process');
    expect(events).toEqual([]);
  });
});
