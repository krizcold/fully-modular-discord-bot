import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemClaimStore } from '../helpers/fakeClaimStore';
import { fixedChooser } from '../helpers/fixedDatabase';

// NB35's L5 survivors: the fallback reason of a refusal recorded without one (shard context and shared-op answer), the
// web UI's own refused text, the no-store refusal's log lines and its restore text, and runBot's populate log line.

const ctl = vi.hoisted(() => ({
  boot: null as null | { mode?: string; state: string; refusalReason: string | null; waitReason?: null },
  gateway: { info: { recommendedShards: 4, sessionStartLimit: null } as any, error: null as string | null },
  ingest: null as any,
  order: [] as string[],
  lines: [] as string[],
  pg: true,
  dataRefusal: undefined as string | undefined,
  client: null as EventEmitter | null,
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => {
  const real = await orig<any>();
  return { ...real, getDataBootStatus: () => ctl.boot ?? real.getDataBootStatus() };
});
vi.mock('../../src/bot/internalSetup/utils/maintenanceGate', async orig => ({ ...(await orig<any>()), isMaintenanceBoot: () => false }));
vi.mock('../../src/bot/internalSetup/fleet/placement', async orig => ({ ...(await orig<any>()), fetchGatewayInfoResult: vi.fn(async () => ctl.gateway) }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async orig => ({ ...(await orig<any>()), getDataReadiness: () => ({ onLeaseChanged: () => undefined }) }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => ({ ...(await orig<any>()), cleanOrphanTmpFiles: vi.fn(async () => {}) }));
vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', async orig => ({
  ...(await orig<any>()),
  getNodeId: () => 'node-a', getNodeName: () => 'A', getAppVersion: () => '1.0.0',
}));
vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => ({ getIngestService: () => ctl.ingest }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => ({ ...(await orig<any>()), getWorkingSet: () => null }));
vi.mock('../../src/bot/internalSetup/utils/maintenance', async orig => ({
  ...(await orig<any>()),
  maintenanceUnfit: () => null, canRestart: () => true, restartForShards: () => false, startLeave: () => undefined, noteClaimsLapsed: () => undefined,
  maintenanceIpcRefusal: () => null,
}));
vi.mock('../../src/bot/internalSetup/fleet/shardRecord', async orig => ({ ...(await orig<any>()), readShardRecord: () => null, writeShardRecord: () => undefined }));
vi.mock('../../src/utils/envLoader', async orig => ({ ...(await orig<any>()), resolveDataBackend: () => 'postgres' }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/mainDatabase', async orig => ({ ...(await orig<any>()), setStepLayers: () => undefined }));

let lines: string[] = [];
function capture() {
  lines = [];
  const push = (...args: unknown[]) => { lines.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(push);
  vi.spyOn(console, 'warn').mockImplementation(push);
  vi.spyOn(console, 'error').mockImplementation(push);
}

beforeEach(() => { ctl.boot = null; });
afterEach(() => { vi.restoreAllMocks(); });

describe('hopFailure: code refused without a detail', () => {
  it('answers 503 with the web UI\'s own refused text', async () => {
    const { hopFailure, sharedOpFailure } = await import('../../src/webui/routes/hopFailure');
    const text = "The data layer refused the database; nothing was saved. The bot's log says how to fix it.";
    expect(hopFailure('refused')).toEqual({ status: 503, error: text });
    expect(sharedOpFailure({ ok: false, code: 'refused' })).toEqual({ status: 503, error: text });
  });
});

describe('the no-store refusal', () => {
  const NO_SCHEMA = { role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: false, schema_usage: null, schema_create: null, relations: [], meta: null };
  const backends: any[] = [];
  afterEach(async () => { for (const b of backends.splice(0)) await b.stop(); });

  it('noStoreRefusal lists no schema difference', async () => {
    const { noStoreRefusal } = await import('../../src/bot/internalSetup/utils/dataBackends/storeShape');
    const refusal = noStoreRefusal('store-a', { db: 'smdb', schemaExists: false } as any);
    expect(refusal.lines).toEqual([]);
  });

  it('a refused provision logs only the header, and a later restore names the missing store', async () => {
    capture();
    const { PostgresBackend } = await import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend');
    const backend = new PostgresBackend({ chooser: fixedChooser('postgres://nobody@127.0.0.1:9/none'), markerStoreId: () => 'store-a' });
    backends.push(backend);
    const client = {
      query: async (statement: string | { text: string }) => {
        const sql = (typeof statement === 'string' ? statement : statement.text).trim();
        if (/^SELECT pg_try_advisory_xact_lock/.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
        if (sql === 'SHOW server_version_num') return { rows: [{ server_version_num: '160004' }], rowCount: 1 };
        if (sql === 'SHOW server_encoding') return { rows: [{ server_encoding: 'UTF8' }], rowCount: 1 };
        if (/has_database_privilege/.test(sql)) return { rows: [NO_SCHEMA], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    (backend.getPool() as unknown as { connect: unknown }).connect = vi.fn(async () => client);
    await (backend as unknown as { provision(): Promise<void> }).provision();
    const reason = "this machine's /data/.backend.json records store store-a, but the configured database smdb holds no store (it has no smdb_data schema), so this bot made no store there";
    expect(lines.filter(l => l.startsWith('[PostgresBackend] schema'))).toEqual([`[PostgresBackend] schema-mismatch: ${reason}; refusing to serve`]);
    lines = [];
    const outcome = await backend.restoreGuild('g1', null, { claim: null, processId: 'p' } as any, () => null, 0n);
    expect(outcome).toEqual({ ok: false, reason: 'schema-mismatch' });
    expect(lines).toEqual(['[PostgresBackend] Refused restore for guild g1: the database holds no store']);
  });
});

describe('the shared-op handler: a refusal recorded without a reason', () => {
  it('answers shared:op and data:global-read with "no reason recorded"', async () => {
    let captured: ((message: unknown) => Promise<void>) | null = null;
    const realOn = process.on.bind(process);
    const spy = vi.spyOn(process, 'on').mockImplementation(((event: string, fn: any) => {
      if (event === 'message') { captured = fn; return process; }
      return realOn(event as any, fn);
    }) as any);
    const original = process.send;
    if (!original) (process as any).send = () => true;
    const { setupSharedOpsIPC } = await import('../../src/bot/internalSetup/utils/sharedOps');
    setupSharedOpsIPC();
    (process as any).send = original;
    spy.mockRestore();
    expect(captured).not.toBeNull();

    ctl.boot = { mode: 'postgres', state: 'refused', refusalReason: null, waitReason: null };
    const sent: any[] = [];
    (process as any).send = (msg: any) => { sent.push(msg); return true; };
    try {
      await captured!({ type: 'shared:op', requestId: 'l5-1', data: { op: 'premium.setGlobalModuleConfig', args: { args: ['x', {}] } } });
      await captured!({ type: 'data:global-read', requestId: 'l5-2', data: { rel: 'x/a.json' } });
    } finally {
      (process as any).send = original;
    }
    const tail = "The bot's log says how to fix it; restart the bot once it is fixed.";
    expect(sent.map(m => m.data)).toEqual([
      { ok: false, code: 'refused', status: 503, error: `The data layer refused this database (no reason recorded), so the bot does not read or change the shared files; nothing was saved. ${tail}` },
      { ok: false, code: 'refused', status: 503, error: `The data layer refused this database (no reason recorded), so the bot does not read or change the shared files. ${tail}` },
    ]);
  });
});

describe('bootShards: a refusal recorded without a reason', () => {
  const savedToken = process.env.DISCORD_TOKEN;
  afterEach(async () => {
    const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
    mod.getJsonReshard()?.stop();
    mod.getShardClaims()?.beginStop();
    const claims = mod.getShardClaims() as any;
    if (claims?.renewTimer) clearInterval(claims.renewTimer);
    if (savedToken === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = savedToken;
    vi.useRealTimers();
  });

  it('the context carries "no reason recorded"', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    capture();
    delete process.env.FLEET_SHARD_CAPACITY;
    delete process.env.FLEET_SHARD_COUNT;
    delete process.env.FLEET_TAKEOVER_SECONDS;
    process.env.DISCORD_TOKEN = 'test-token';
    ctl.ingest = {
      setShardPlan: () => undefined, isStarted: () => false, start: vi.fn(async () => 'ok'), stop: vi.fn(async () => undefined),
      getClient: () => null, setIdentifyThrottler: vi.fn(),
    };
    ctl.boot = { state: 'refused', refusalReason: null };
    vi.resetModules();
    const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
    mod._setClaimStoreFactory(() => new MemClaimStore(() => Date.now()));
    const ctx = await mod.bootShards();
    expect(ctx.shardCount).toBe(0);
    expect(ctx.dataRefusal).toBe('no reason recorded');
  }, 120_000);
});

describe('runBot: a boot whose data layer serves', () => {
  const R = '../../src/bot/internalSetup/';
  const mocks: Array<[string, () => Record<string, unknown>]> = [
    ['dotenv/config', () => ({})],
    ['../../src/utils/envLoader', () => ({ loadCredentials: () => ({}), resolveDataBackend: () => 'postgres' })],
    [`${R}utils/getAllFiles`, () => ({ default: () => [] })],
    [`${R}utils/panelManager`, () => ({ getPanelManager: () => ({ loadPanels: async () => undefined, registerPanel: () => undefined, recoverPanels: async () => undefined }) })],
    [`${R}utils/ipcPanelHandler`, () => ({ setupPanelIPCHandlers: () => undefined })],
    [`${R}utils/ipcCommandHandler`, () => ({ setupCommandIPCHandlers: () => undefined })],
    [`${R}utils/ipcDataHandler`, () => ({ setupDataIPCHandlers: () => undefined })],
    [`${R}utils/accessLogChannel`, () => ({ setupAccessLogChannel: () => undefined })],
    [`${R}utils/ipcMetricsHandler`, () => ({ markMetricsReady: () => undefined, setupMetricsIPCHandlers: () => undefined })],
    [`${R}utils/ipcFleetHandler`, () => ({ setupFleetIPCHandlers: () => undefined })],
    [`${R}utils/metrics/metricsCollector`, () => ({ getMetricsCollector: () => ({ seedTotals: () => undefined, flushTotals: () => undefined }) })],
    [`${R}utils/metrics/samplers`, () => ({ startSamplers: () => undefined, stopSamplers: () => undefined })],
    [`${R}utils/dataBackends/postgresBackend`, () => ({ PostgresBackend: PgStub })],
    [`${R}utils/dataManager`, () => ({
      addStopStep: () => undefined,
      addReleaseStep: () => undefined,
      getGuildDataBackend: () => (ctl.pg ? pgBackend : null),
      sweepGraveyard: async () => undefined,
      DataBackendUnavailableError: class extends Error {},
    })],
    [`${R}utils/sharedMirror`, () => ({
      stopSharedPass: () => undefined,
      bootShared: async () => { ctl.order.push('bootShared'); return 'done'; },
      startSharedPass: () => { ctl.order.push('startSharedPass'); },
    })],
    [`${R}utils/sharedOps`, () => ({ setupSharedOpsIPC: () => undefined })],
    [`${R}utils/moduleApply`, () => ({
      recoverModuleApplies: () => { ctl.order.push('recovery'); },
      beginBootApplies: () => { ctl.order.push('bootApplies'); },
      bootCompileModules: async () => { ctl.order.push('compile'); },
      bootLoadCheck: async (_client: unknown, loaded: unknown[]) => { ctl.order.push('loadCheck'); return loaded; },
      setModuleApplyClient: () => undefined,
    })],
    [`${R}utils/writerLock`, () => ({ reportWriterStage: () => undefined })],
    [`${R}utils/premiumManager`, () => ({ startPremiumTickers: () => undefined })],
    [`${R}utils/dataBackends/boot`, () => ({
      initDataBackendLayer: () => undefined,
      awaitDataStartupBarrier: () => Promise.resolve('ready'),
      dispatchGated: () => undefined,
      dataUnavailableMessage: () => '',
    })],
    [`${R}utils/dataBackends/workingSet`, () => ({ getWorkingSet: () => null })],
    [`${R}utils/ipcReloadHandler`, () => ({ setupReloadIPCHandlers: () => undefined })],
    [`${R}utils/ipcToggleHandler`, () => ({ setupToggleIPCHandlers: () => undefined, applyAllDisabledStatesOnBoot: () => undefined })],
    [`${R}utils/ipcNotificationHandler`, () => ({ setupIPCNotificationHandler: () => undefined })],
    [`${R}utils/subscriptionNotifier`, () => ({ getSubscriptionNotifier: () => ({ setClient: () => undefined }) })],
    [`${R}utils/payment/paymentRegistry`, () => ({ getPaymentRegistry: () => ({ listAll: () => [], get: () => undefined }) })],
    [`${R}utils/moduleAutoUpdater`, () => ({ startModuleAutoUpdater: () => { ctl.order.push('autoUpdater'); } })],
    [`${R}fleet/shardBoot`, () => ({
      bootShards: async () => {
        ctl.order.push('bootShards');
        return {
          nodeId: 'node-a', nodeName: 'A', shardCount: 0,
          startIngest: () => { ctl.order.push('startIngest'); },
          ...(ctl.dataRefusal !== undefined ? { dataRefusal: ctl.dataRefusal } : {}),
        };
      },
      getShardClaims: () => ({ beginStop: () => undefined, finishStop: async () => undefined }),
    })],
    [`${R}fleet/guildRequests`, () => ({ guildRequestsStopStep: async () => undefined, startGuildRequestSweep: () => undefined, requestGuildRequestPass: () => undefined })],
    [`${R}utils/servingGate`, () => ({ stoppedServing: () => false })],
    [`${R}ingest/ingestService`, () => ({
      getIngestService: () => ({
        close: async () => undefined,
        buildClient: () => {
          ctl.client = Object.assign(new EventEmitter(), { user: { tag: 'bot#0001' } });
          return ctl.client;
        },
      }),
    })],
    [`${R}utils/dataBackends/replyGate`, () => ({ installReplyGate: () => undefined })],
    [`${R}utils/moduleLoader`, () => ({ ModuleLoader: class { async loadAllModules() { ctl.order.push('loadModules'); return []; } } })],
    [`${R}utils/moduleRegistry`, () => ({
      getModuleRegistry: () => ({ setClient: () => undefined, getStats: () => ({ total: 0, byCategory: {} }), getAllModules: () => [] }),
    })],
    [`${R}utils/moduleEventManager`, () => ({
      getModuleEventManager: () => ({ setClient: () => undefined, registerListener: () => undefined, getListenerCount: () => 0 }),
    })],
    [`${R}utils/configManager`, () => ({ ensureConfigPopulated: () => { ctl.order.push('populate'); } })],
    [`${R}utils/maintenance`, () => ({
      decideBoot: async () => ({ mode: 'normal' }),
      installMaintenanceGate: () => undefined,
      markDiscordStarted: () => undefined,
      runMaintenanceBoot: async () => undefined,
      setupMaintenanceIPCAtBoot: () => undefined,
      watchDataBackend: () => undefined,
    })],
    [`${R}utils/maintenanceGate`, () => ({ isMaintenanceGateClosed: () => false })],
    [`${R}utils/dataBackends/mainDatabase`, () => ({ stopMainWatch: () => undefined, noteShardReconnect: () => undefined })],
    [`${R}fleet/standbyBoot`, () => ({ claimsStop: async () => undefined, endStandbyMaintenanceAnswers: () => undefined, l20Line: () => '' })],
  ];
  class PgStub {}
  const pgBackend = new PgStub();

  it('logs the populate line before it populates config.json', async () => {
    capture();
    ctl.order = [];
    ctl.pg = true;
    ctl.dataRefusal = undefined;
    vi.resetModules();
    for (const [p, factory] of mocks) vi.doMock(p, factory);
    try {
      const ci = await import('../../src/bot/internalSetup/clientInitializer');
      void ci.runBot({}).catch(error => lines.push(String(error)));
      await vi.waitFor(() => expect(ctl.order).toContain('loadCheck'));
      expect(ctl.order.filter(s => s === 'populate')).toHaveLength(1);
      expect(lines.filter(l => l.includes('config.json'))).toEqual(['[Bot] Synchronizing config.json with schema...']);
    } finally {
      for (const [p] of mocks) vi.doUnmock(p);
    }
  });
});
