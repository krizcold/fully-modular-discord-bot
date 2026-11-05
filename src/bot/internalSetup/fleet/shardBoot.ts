import { randomUUID } from 'crypto';
import { getIngestService } from '../ingest/ingestService';
import { getBackendHealth, getGuildDataBackend, isStopping, setOwnerInfoProvider } from '../utils/dataManager';
import { getDataBootStatus } from '../utils/dataBackends/boot';
import { PostgresBackend } from '../utils/dataBackends/postgresBackend';
import { getWorkingSet } from '../utils/dataBackends/workingSet';
import { cleanOrphanTmpFiles, setGuildViewCache } from '../utils/dataBackends/fileBackend';
import { isMaintenanceGateClosed } from '../utils/maintenanceGate';
import { canRestart, leaveRestartAsked, maintenanceUnfit, noteClaimsLapsed, restartForShards, startLeave } from '../utils/maintenance';
import { setStoppedServingHook } from '../utils/servingGate';
import { loadCredentials, resolveDataBackend, shardCapacity, shardReturnEnabled, takeoverSeconds } from '../../../utils/envLoader';
import { IdentifyLedger } from './identifyLedger';
import { LeaseRuntime } from './leaseRuntime';
import { getAppVersion, getNodeId, getNodeName } from './nodeIdentity';
import { decideShardSource, fetchGatewayInfoResult, getShardCountOverride, leasesFor, resolveShardCount } from './placement';
import { _setFleetStateSources } from './state';
import { claimTimings, type ClaimTimings, type Pair } from './claimRules';
import { ClaimStore, type ClaimStoreApi } from './claimStore';
import { ShardClaims } from './shardClaims';
import { readShardRecord, writeShardRecord } from './shardRecord';

const VERIFY_POLL_MS = 1_000;
export const TOKEN_REFUSED_LINE = '[Shards] Discord refused the bot token (HTTP 401); no shard is taken until the token is fixed and the bot restarts';
const WAIT_LOG_MS = 30_000;

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); });
// A stop began during the boot: the stop handler exits the process, so the boot never resolves.
const never = () => new Promise<never>(() => undefined);

export interface ShardBootContext {
  nodeId: string;
  nodeName: string;
  shardCount: number;
  startIngest(token: string | undefined): void;
}

let context: ShardBootContext | null = null;
let booting: Promise<ShardBootContext> | null = null;
let claims: ShardClaims | null = null;

export function getFleetContext(): ShardBootContext | null {
  return context;
}

/** This process's shard claims; null on a JSON bot and before the Postgres boot built them. */
export function getShardClaims(): ShardClaims | null {
  return claims;
}

type StoreFactory = (url: string, timings: ClaimTimings, onRefused: () => void) => ClaimStoreApi;
let storeFactory: StoreFactory | null = null;

/** Tests build the claims over a fake store. */
export function _setClaimStoreFactory(factory: StoreFactory | null): void {
  storeFactory = factory;
}

export function bootShards(): Promise<ShardBootContext> {
  if (context) return Promise.resolve(context);
  if (!booting) booting = runBoot().finally(() => { booting = null; });
  return booting;
}

function configuredPostgres(): boolean {
  try {
    return resolveDataBackend() === 'postgres';
  } catch {
    return false;
  }
}

/** Waits for the data layer's verdict on Postgres: 'serving', or 'refused'. */
async function awaitDataVerdict(): Promise<'serving' | 'refused'> {
  let lastWaitLog = -Infinity;
  for (;;) {
    const state = getDataBootStatus().state;
    if (state === 'serving' || state === 'refused') return state;
    if (Date.now() - lastWaitLog >= WAIT_LOG_MS) {
      console.log(`[Shards] Waiting for the database to verify before taking shards (state: ${state})`);
      lastWaitLog = Date.now();
    }
    await sleep(VERIFY_POLL_MS);
  }
}

async function runBoot(): Promise<ShardBootContext> {
  const nodeId = getNodeId();
  const nodeName = getNodeName();
  const ingest = getIngestService();
  const runtime = new LeaseRuntime(ingest);
  setGuildViewCache(true);

  try {
    await cleanOrphanTmpFiles();
  } catch (error) {
    console.error('[Shards] Orphaned temp file cleanup failed:', error instanceof Error ? error.message : error);
  }

  const { info: gateway, error: gatewayError } = await fetchGatewayInfoResult(process.env.DISCORD_TOKEN);
  const postgres = getGuildDataBackend() instanceof PostgresBackend || configuredPostgres();

  const finish = (shardCount: number, granted: number, ledger: IdentifyLedger): ShardBootContext => {
    _setFleetStateSources({
      nodeId,
      nodeName,
      appVersion: getAppVersion(),
      shardSource: decideShardSource(gateway !== null),
      recommendedShards: gateway?.recommendedShards ?? null,
      recommendedAt: gateway ? Date.now() : null,
      runtime,
      ingest,
      ledger,
      claims,
    });
    ledger.charge(granted);
    context = {
      nodeId,
      nodeName,
      shardCount,
      startIngest(token: string | undefined): void {
        runtime.setToken(token);
      },
    };
    return context;
  };

  if (!postgres) {
    if (!gateway && process.env.DISCORD_TOKEN) {
      console.warn(`[Shards] /gateway/bot failed (${gatewayError}); assuming 1 recommended shard`);
    }
    const shardCount = resolveShardCount(gateway?.recommendedShards ?? 1);
    const shardIds = Array.from({ length: shardCount }, (_, i) => i);
    const leases = leasesFor(shardIds.map(shardId => ({ shardId, claim: null })));
    const ledger = new IdentifyLedger(process.env.DISCORD_TOKEN, shardCount, gateway?.sessionStartLimit ?? null, gateway?.recommendedShards ?? null);
    await runtime.applyGrant({ processId: null, shardCount, leases });
    console.log(`[Shards] Running all ${shardCount} shard(s) in this process`);
    setOwnerInfoProvider(() => ({ nodeId, processId: null, shardCount, claimOf: () => null }));
    return finish(shardCount, shardCount, ledger);
  }

  const noShards = async (): Promise<ShardBootContext> => {
    const ledger = new IdentifyLedger(process.env.DISCORD_TOKEN, 0, gateway?.sessionStartLimit ?? null, gateway?.recommendedShards ?? null);
    await runtime.applyGrant({ processId: null, shardCount: 0, leases: [] });
    setOwnerInfoProvider(() => ({ nodeId, processId: null, shardCount: 0, claimOf: () => null }));
    return finish(0, 0, ledger);
  };

  if ((await awaitDataVerdict()) === 'refused') {
    console.error('[Shards] The data layer refused this database, so this bot process connects no shard to Discord');
    return noShards();
  }
  if (gatewayError === 'HTTP 401') {
    console.error(TOKEN_REFUSED_LINE);
    return noShards();
  }

  const settings = { capacity: shardCapacity(), takeoverSeconds: takeoverSeconds(), returns: shardReturnEnabled() };
  const timings = claimTimings(settings.takeoverSeconds);
  const processId = randomUUID();
  const backend = getGuildDataBackend();
  const url = (loadCredentials().DATA_BACKEND_URL || '').trim();
  const onRefused = () => { if (backend instanceof PostgresBackend) backend.notifyLoginRefused(); };
  const store = storeFactory ? storeFactory(url, timings, onRefused) : new ClaimStore(url, timings, onRefused);
  const fitness = (): string | null => {
    if (getDataBootStatus().state !== 'serving') return 'the data layer does not serve';
    const maintenance = maintenanceUnfit();
    if (maintenance) return maintenance;
    if (isStopping()) return 'stopping';
    const health = getBackendHealth().state;
    if (health !== 'healthy') return `the data backend is ${health}`;
    if ((getWorkingSet()?.heldGuilds() ?? []).some(g => g.reason !== null)) return 'a save is failing';
    return null;
  };
  let shardCount = 0;
  let servedIds: number[] | null = null;
  const recordLoss = (lost: Pair[]): void => {
    try {
      const count = lost[0]?.shardCount ?? 0;
      if (count <= 0) return;
      let base = servedIds;
      if (base === null) {
        const record = readShardRecord();
        base = record?.shardCount === count ? record.shardIds : [];
      }
      const gone = new Set(lost.map(p => p.shardId));
      servedIds = base.filter(id => !gone.has(id));
      writeShardRecord({ shardCount: count, shardIds: servedIds, processId, at: new Date().toISOString() });
    } catch (error) {
      console.error('[Shards] Could not rewrite the shard record:', error instanceof Error ? error.message : error);
    }
  };
  const shardClaims = new ShardClaims({
    store,
    me: { processId, nodeId, nodeName },
    timings,
    ...settings,
    restartable: canRestart(),
    startedAt: Date.now(),
    fitness,
    gateClosed: isMaintenanceGateClosed,
    isStopping,
    stopServingStep: () => runtime.stopServing(timings.ttlMs / 3),
    noteLapsed: noteClaimsLapsed,
    noteLost: (lost: Pair[]) => {
      recordLoss(lost);
      startLeave(`Shard ${lost.map(p => p.shardId).join(', ')} ${lost.length > 1 ? 'are' : 'is'} no longer held by this process`);
    },
    noteLostAtStop: (lost: Pair[]) => recordLoss(lost),
    restartForShards: reason => restartForShards(reason, fitness),
    leaveRestartAsked,
    lastRecord: () => {
      const record = readShardRecord();
      if (record?.keptAtStop) {
        try {
          writeShardRecord({ ...record, keptAtStop: undefined });
        } catch (error) {
          console.error('[Shards] Could not rewrite the shard record:', error instanceof Error ? error.message : error);
        }
      }
      return record;
    },
    noteKeptAtStop: (count: number, keptIds: number[], dropped: number[]) => {
      const record = readShardRecord();
      const gone = new Set(dropped);
      const shardIds = (servedIds ?? (record?.shardCount === count ? record.shardIds : [])).filter(id => !gone.has(id));
      writeShardRecord({ shardCount: count, shardIds, processId, at: new Date().toISOString(), keptAtStop: keptIds });
    },
  });
  claims = shardClaims;
  setStoppedServingHook(() => shardClaims.stoppedServing());
  shardClaims.start();
  if (!(await shardClaims.firstRenewal())) return never();

  let lastCountLog = -Infinity;
  let tokenRefused = false;
  const localCount = async (): Promise<number | null> => {
    const override = getShardCountOverride();
    if (override !== null) return override;
    if (gateway) return resolveShardCount(gateway.recommendedShards);
    if (tokenRefused) return null;
    const again = await fetchGatewayInfoResult(process.env.DISCORD_TOKEN);
    if (again.info) return resolveShardCount(again.info.recommendedShards);
    if (again.error === 'HTTP 401') {
      tokenRefused = true;
      console.error(TOKEN_REFUSED_LINE);
      return null;
    }
    if (Date.now() - lastCountLog >= WAIT_LOG_MS) {
      lastCountLog = Date.now();
      console.warn(`[Shards] Cannot resolve the shard count yet: /gateway/bot failed (${again.error}); retrying every ${timings.renewMs / 1000} s unless the database holds a count`);
    }
    return null;
  };
  const taken = await shardClaims.bootTake(localCount, () => tokenRefused);
  if (isStopping()) return never();
  if (!taken) {
    if (!tokenRefused) return never();
    await shardClaims.retire();
    claims = null;
    setStoppedServingHook(null);
    if (isStopping()) return never();
    return noShards();
  }
  shardCount = taken.shardCount;
  // A lapse or a loss before the grant leaves nothing to serve.
  const pairs = shardClaims.stoppedServing() ? [] : taken.pairs;
  const ledger = new IdentifyLedger(process.env.DISCORD_TOKEN, shardCount, gateway?.sessionStartLimit ?? null, gateway?.recommendedShards ?? null);
  await runtime.applyGrant({ processId, shardCount, leases: leasesFor(pairs) });
  shardClaims.noteGranted();
  setOwnerInfoProvider(() => ({ nodeId, processId, shardCount, claimOf: shardId => shardClaims.claimOf(shardId) }));
  servedIds = pairs.map(p => p.shardId);
  try {
    writeShardRecord({ shardCount, shardIds: servedIds, processId, at: new Date().toISOString() });
  } catch (error) {
    console.error('[Shards] Could not write the shard record:', error instanceof Error ? error.message : error);
  }
  if (pairs.length > 0) {
    console.log(`[Shards] Running ${pairs.length} of ${shardCount} shard(s) in this process: ${pairs.map(p => p.shardId).sort((a, b) => a - b).join(', ')}`);
  } else {
    const plan = taken.answer.plan;
    console.log(`[Shards] Running none of ${shardCount} shard(s) (FLEET_SHARD_CAPACITY ${settings.capacity}): ${plan.heldElsewhere} held by other machines, ${plan.waitingForOwner} waiting for their own machine to restart, ${plan.leftToOthers} left to machines with room`);
  }
  return finish(shardCount, pairs.length, ledger);
}
