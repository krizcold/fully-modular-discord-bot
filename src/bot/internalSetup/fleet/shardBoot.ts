import { randomUUID } from 'crypto';
import { getIngestService } from '../ingest/ingestService';
import { getBackendHealth, getGuildDataBackend, isStopping, setOwnerInfoProvider } from '../utils/dataManager';
import { getDataBootStatus } from '../utils/dataBackends/boot';
import { PostgresBackend } from '../utils/dataBackends/postgresBackend';
import { getWorkingSet } from '../utils/dataBackends/workingSet';
import { cleanOrphanTmpFiles, setGuildViewCache } from '../utils/dataBackends/fileBackend';
import { isMaintenanceGateClosed } from '../utils/maintenanceGate';
import { canRestart, leaveRestartAsked, maintenanceUnfit, noteClaimsLapsed, requestRestart, restartForShards, startLeave } from '../utils/maintenance';
import { setStoppedServingHook } from '../utils/servingGate';
import { reshardOverlap, resolveDataBackend, shardCapacity, shardReturnEnabled, takeoverSeconds } from '../../../utils/envLoader';
import { showEntry } from '../../../utils/databaseAddress';
import { heartbeatMemory } from '../../../utils/memoryReading';
import { moveTargetGeneration, setStepLayers } from '../utils/dataBackends/mainDatabase';
import { IdentifyLedger } from './identifyLedger';
import { LeaseRuntime } from './leaseRuntime';
import { getAppVersion, getNodeId, getNodeName } from './nodeIdentity';
import { decideShardSource, fetchGatewayInfoResult, getShardCountOverride, leasesFor, resolveShardCount } from './placement';
import { _setFleetStateSources, loginIntents, setReshardSource } from './state';
import { claimTimings, type ClaimTimings, type Pair } from './claimRules';
import { ClaimPausedError, ClaimStore, type ClaimStoreApi } from './claimStore';
import { L33_LINE, L33_RESTART_REASON, ShardClaims } from './shardClaims';
import { readShardRecord, writeShardRecord } from './shardRecord';
import { processId as thisProcessId } from './processId';
import { parentSlotAsker, slotThrottlerBuilder } from './identifySlots';
import { JsonReshard, Reshard } from './reshard';

const VERIFY_POLL_MS = 1_000;
/** NB9 30 and C5: a promoted standby waits at most this long for the data layer's verdict. */
export const RESHARD_SERVE_WAIT_MS = 300_000;
const RECOMMENDATION_FRESH_MS = 15 * 60_000;
export const TOKEN_REFUSED_LINE = '[Shards] Discord refused the bot token (HTTP 401); no shard is taken until the token is fixed and the bot restarts';
const WAIT_LOG_MS = 30_000;
/** A JSON hand-over's gateway stop, bounded as a Postgres one with the default takeover delay (TTL / 3). */
const JSON_HAND_OVER_STOP_MS = 10_000;

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); });
// A stop began during the boot: the stop handler exits the process, so the boot never resolves.
const never = () => new Promise<never>(() => undefined);

export interface ShardBootContext {
  nodeId: string;
  nodeName: string;
  shardCount: number;
  startIngest(token: string | undefined): void;
  /** NB9 D1: true only for a promoted standby whose grant is exactly its standby's set and count (the sessions stay). */
  keptSessions?: boolean;
}

/** NB9 29, 41, C5 and E1: what a promoted Postgres standby hands its serve. */
export interface StandbyTaken {
  count: number;
  processId: string;
  /** The standby's pairs with their claims. */
  pairs: Pair[];
  /** The LeaseRuntime startStandby built; its sessions are kept for the same set and count. */
  runtime: LeaseRuntime;
  /** The pre-serve lanes stop; a renewal on the wire gets up to 2 s. */
  stopLanes(): Promise<void>;
  /** 'refused', a latch, HTTP 401 or the 300 s bound: the Client closed, then the pre-serve release (C5). */
  release(): Promise<void>;
  /**
   * In the synchronous turn after stopLanes and E1's check, before the serve lanes' store is built (42's phase switch).
   * `reserve` is the serve store's identify slot (C10), for the throttler the standby built before it served.
   */
  onServing?(reserve?: IdentifyReserve): void;
}

export type IdentifyReserve = (bucket: number, holder: string, signal?: AbortSignal) => Promise<{ granted: true } | { granted: false; waitMs: number }>;

/** NB9 15 and C5: a promoted JSON standby: every shard of its count on its runtime. */
export interface JsonTaken {
  json: true;
  count: number;
  /** The count the finished reshard left, for its 'done' in the Usage fields; absent when the web UI sent none. */
  from?: number;
  runtime: LeaseRuntime;
}

export interface BootOptions {
  taken?: StandbyTaken | JsonTaken;
}

let context: ShardBootContext | null = null;
let booting: Promise<ShardBootContext> | null = null;
let claims: ShardClaims | null = null;
let leaseRuntime: LeaseRuntime | null = null;
let reshard: Reshard | null = null;
let jsonReshard: JsonReshard | null = null;
/** This process's reshard driver; null on a JSON bot, before the Postgres boot built it, and in a promoted standby's boot before its grant. */
export function getReshard(): Reshard | null {
  return reshard;
}

/** A JSON bot's reshard timer (15); null on Postgres and in a promoted JSON standby. */
export function getJsonReshard(): JsonReshard | null {
  return jsonReshard;
}

export function getFleetContext(): ShardBootContext | null {
  return context;
}

/** This process's lease runtime; null before the shard boot built it. */
export function getLeaseRuntime(): LeaseRuntime | null {
  return leaseRuntime;
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

export function bootShards(opts: BootOptions = {}): Promise<ShardBootContext> {
  if (context) return Promise.resolve(context);
  if (!booting) booting = runBoot(opts.taken ?? null).finally(() => { booting = null; });
  return booting;
}

/** NB9 15: a JSON bot's 30 s check, its answers and its hand-over (the gateway stopped, then NB2's leave with L8). */
function startJsonReshard(nodeName: string, shardCount: number, ledger: IdentifyLedger, runtime: LeaseRuntime, finishedFrom: number | null = null): void {
  const startedAt = Date.now();
  let handedOver = false;
  setStoppedServingHook(() => handedOver);
  const json = new JsonReshard({
    nodeName,
    countSetting: getShardCountOverride,
    recommendation: () => {
      const rec = ledger.getRecommendation();
      return rec && Date.now() - rec.readAt <= RECOMMENDATION_FRESH_MS ? rec.shards : null;
    },
    runningCount: () => shardCount,
    fitness: () => {
      const maintenance = maintenanceUnfit();
      if (maintenance) return maintenance;
      if (isStopping()) return 'stopping';
      const health = getBackendHealth().state;
      return health !== 'healthy' ? `the data backend is ${health}` : null;
    },
    overlap: reshardOverlap,
    memory: heartbeatMemory,
    startedAgoMs: () => Date.now() - startedAt,
    budget: () => {
      const info = ledger.getBudgetInfo();
      return info && !info.unavailable ? { stale: info.stale, remaining: info.remaining, resetAt: Date.now() + info.resetAfterMs } : null;
    },
    send: process.send ? (message: object) => { try { process.send!(message); } catch { /* the parent is gone */ } } : null,
    intents: loginIntents,
    maxConcurrency: () => ledger.getMaxConcurrency(),
    handOver: (reason, attempt) => {
      handedOver = true;
      runtime.stopServing(JSON_HAND_OVER_STOP_MS);
      startLeave(reason, { attempt });
    },
    ...(finishedFrom !== null ? { finished: { from: finishedFrom, to: shardCount } } : {}),
  });
  jsonReshard = json;
  json.start();
  setReshardSource(() => ({ ...json.fields(), reshardWait: json.wait() }));
}

function configuredPostgres(): boolean {
  try {
    return resolveDataBackend() === 'postgres';
  } catch {
    return false;
  }
}

/**
 * Waits for the data layer's verdict on Postgres: 'serving', or 'refused'. A promoted standby (C5, D2) checks a stop
 * first at each poll, then the state, then the 300 s bound on the monotonic clock.
 */
async function awaitDataVerdict(standby = false): Promise<'serving' | 'refused' | 'stopping' | 'timeout'> {
  let lastWaitLog = -Infinity;
  const start = performance.now();
  for (;;) {
    if (standby && isStopping()) return 'stopping';
    const state = getDataBootStatus().state;
    if (state === 'serving' || state === 'refused') return state;
    if (standby && performance.now() - start >= RESHARD_SERVE_WAIT_MS) return 'timeout';
    if (Date.now() - lastWaitLog >= WAIT_LOG_MS) {
      console.log(`[Shards] Waiting for the database to verify before taking shards (state: ${state})`);
      lastWaitLog = Date.now();
    }
    await sleep(VERIFY_POLL_MS);
  }
}

async function runBoot(given: StandbyTaken | JsonTaken | null): Promise<ShardBootContext> {
  const nodeId = getNodeId();
  const nodeName = getNodeName();
  const ingest = getIngestService();
  const runtime = given ? given.runtime : new LeaseRuntime(ingest);
  leaseRuntime = runtime;
  const standby = given && !('json' in given) ? given : null;
  if (standby && standby.processId !== thisProcessId()) throw new Error(`the promoted standby's taken names process ${standby.processId}, not this process's ${thisProcessId()}`);
  setGuildViewCache(true);

  try {
    await cleanOrphanTmpFiles();
  } catch (error) {
    console.error('[Shards] Orphaned temp file cleanup failed:', error instanceof Error ? error.message : error);
  }

  const { info: gateway, error: gatewayError } = await fetchGatewayInfoResult(process.env.DISCORD_TOKEN);
  const postgres = getGuildDataBackend() instanceof PostgresBackend || configuredPostgres();

  const finish = (shardCount: number, granted: number, ledger: IdentifyLedger, keptSessions = false): ShardBootContext => {
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
      ...(keptSessions ? { keptSessions: true } : {}),
    };
    return context;
  };

  if (!postgres) {
    if (!gateway && process.env.DISCORD_TOKEN) {
      console.warn(`[Shards] /gateway/bot failed (${gatewayError}); assuming 1 recommended shard`);
    }
    const shardCount = given ? given.count : resolveShardCount(gateway?.recommendedShards ?? 1);
    const shardIds = Array.from({ length: shardCount }, (_, i) => i);
    const leases = leasesFor(shardIds.map(shardId => ({ shardId, claim: null })));
    const ledger = new IdentifyLedger(process.env.DISCORD_TOKEN, shardCount, gateway?.sessionStartLimit ?? null, gateway?.recommendedShards ?? null);
    if (!given) {
      const asker = process.send ? parentSlotAsker() : undefined;
      ingest.setIdentifyThrottler?.(slotThrottlerBuilder({ mode: asker ? 'parent' : 'local', askParent: asker, renewMs: claimTimings(takeoverSeconds()).renewMs }));
    }
    await runtime.applyGrant({ processId: null, shardCount, leases });
    console.log(`[Shards] Running all ${shardCount} shard(s) in this process`);
    setOwnerInfoProvider(() => ({ nodeId, processId: null, shardCount, claimOf: () => null }));
    startJsonReshard(nodeName, shardCount, ledger, runtime, given && 'json' in given && typeof given.from === 'number' ? given.from : null);
    return finish(shardCount, shardCount, ledger, given !== null);
  }

  const noShards = async (): Promise<ShardBootContext> => {
    const ledger = new IdentifyLedger(process.env.DISCORD_TOKEN, 0, gateway?.sessionStartLimit ?? null, gateway?.recommendedShards ?? null);
    await runtime.applyGrant({ processId: null, shardCount: 0, leases: [] });
    setOwnerInfoProvider(() => ({ nodeId, processId: null, shardCount: 0, claimOf: () => null }));
    return finish(0, 0, ledger);
  };

  const verdict = await awaitDataVerdict(standby !== null);
  if (verdict === 'stopping') return never();
  if (verdict === 'timeout') {
    // D4: L33 first, the release's own lines next, then the restart ask; this boot never resolves.
    console.error(L33_LINE);
    await standby!.release();
    requestRestart(L33_RESTART_REASON);
    return never();
  }
  if (verdict === 'refused') {
    await standby?.release();
    console.error('[Shards] The data layer refused this database, so this bot process connects no shard to Discord');
    return noShards();
  }
  if (gatewayError === 'HTTP 401') {
    await standby?.release();
    console.error(TOKEN_REFUSED_LINE);
    return noShards();
  }

  const settings = { capacity: shardCapacity(), takeoverSeconds: takeoverSeconds(), returns: shardReturnEnabled() };
  const timings = claimTimings(settings.takeoverSeconds);
  const processId = thisProcessId();
  const backend = getGuildDataBackend();
  const pg = backend instanceof PostgresBackend ? backend : null;
  // NB5 C5 (a): in the run after the verdict, the claims follow the chosen entry, or no store is built while latched.
  if (pg && pg.connectionState().state === 'latched') {
    await standby?.release();
    console.error(`[Shards] This bot process stopped writing to its database before it took shards (${pg.latchReason() ?? 'no cause recorded'}), so it connects no shard to Discord`);
    return noShards();
  }
  let serveReserve: IdentifyReserve | null = null;
  if (standby) {
    await standby.stopLanes();
    // E1: a stop that began while the pre-serve lanes stopped builds no serve lanes; the 'pre-serve' step releases.
    if (isStopping()) return never();
    standby.onServing?.((bucket, holder, signal) => serveReserve ? serveReserve(bucket, holder, signal) : Promise.reject(new ClaimPausedError()));
  }
  const entry = pg?.chosenEntry() ?? '';
  const onRefused = () => { if (pg) pg.notifyLoginRefused(); };
  const store = storeFactory ? storeFactory(entry, timings, onRefused) : new ClaimStore(entry, timings, onRefused);
  pg?.onDatabaseChanged(next => store.retarget?.(next));
  const slots = store as ClaimStoreApi & { reserveIdentifySlot?: IdentifyReserve };
  if (slots.reserveIdentifySlot) serveReserve = (bucket, holder, signal) => slots.reserveIdentifySlot!(bucket, holder, signal);
  if (!standby && slots.reserveIdentifySlot) {
    ingest.setIdentifyThrottler?.(slotThrottlerBuilder({ mode: 'database', reserve: (bucket, signal) => slots.reserveIdentifySlot!(bucket, processId, signal), renewMs: timings.renewMs }));
  }
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
    noteLapsed: seconds => {
      pg?.noteLapse();
      noteClaimsLapsed(seconds);
    },
    noteLost: (lost: Pair[]) => {
      recordLoss(lost);
      startLeave(`Shard ${lost.map(p => p.shardId).join(', ')} ${lost.length > 1 ? 'are' : 'is'} no longer held by this process`);
    },
    noteLostAtStop: (lost: Pair[]) => recordLoss(lost),
    memoryReading: heartbeatMemory,
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
    releaseRefusal: () => pg?.latchReason() ?? null,
    replaceShardClaim: (shardId, claim) => getWorkingSet()?.replaceShardClaim(shardId, claim),
    guildsOfShard: shardId => getWorkingSet()?.guildsOfShard(shardId) ?? [],
    ...(standby ? { fromStandby: true, standbyPairs: standby.pairs } : {}),
    onPage: page => reshard?.onPage(page),
  });
  claims = shardClaims;
  let ledgerRef: IdentifyLedger | null = null;
  if (store.withWorkClient) {
    const work = store.withWorkClient.bind(store);
    reshard = new Reshard({
      claims: shardClaims,
      withWorkClient: work,
      me: { nodeId, nodeName },
      fitness,
      restartable: canRestart(),
      startLeave,
      send: process.send ? (message: object) => { try { process.send!(message); } catch { /* the parent is gone */ } } : null,
      intents: loginIntents,
      maxConcurrency: () => ledgerRef?.getMaxConcurrency() ?? 1,
      entry: () => pg?.chosenEntry() ?? entry,
      budget: () => {
        const info = ledgerRef?.getBudgetInfo();
        return info && !info.unavailable ? { stale: info.stale, remaining: info.remaining, resetAt: Date.now() + info.resetAfterMs } : null;
      },
      recommendation: () => {
        const rec = ledgerRef?.getRecommendation();
        return rec && Date.now() - rec.readAt <= RECOMMENDATION_FRESH_MS ? rec.shards : null;
      },
    });
    setReshardSource(() => ({ reshardWait: reshard?.wait() ?? null }));
  }
  setStoppedServingHook(() => shardClaims.stoppedServing());
  if (pg) {
    setStepLayers({
      stopServing: reason => shardClaims.stopServingForDatabase(pg.latchReason() ?? reason),
      claims: async next => shardClaims.moveClaims({ address: showEntry(next), generation: moveTargetGeneration() }),
      attemptEnded: () => shardClaims.moveAttemptEnded(),
      holdsShard: (shardId, count) => shardClaims.heldPairs().some(p => p.shardId === shardId && p.shardCount === count),
      databaseStopWhy: () => shardClaims.databaseStopWhy(),
    });
  }
  shardClaims.start();
  // NB5 E2: a latch while the boot takes shards ends it with nothing granted.
  const stoppedByDatabase = (): boolean => {
    const why = shardClaims.databaseStopWhy();
    if (why === null) return false;
    console.error(`[Shards] This bot process stopped writing to its database while it was taking shards (${why}), so it connects no shard to Discord`);
    return true;
  };
  if (!(await shardClaims.firstRenewal())) {
    if (isStopping()) return never();
    if (stoppedByDatabase()) return noShards();
    return never();
  }

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
  if (standby) {
    // 29 and D1: the redraw in place of the take; the grant on the standby's runtime keeps its sessions for the same set.
    const drawn = await shardClaims.redraw({ count: standby.count, processId, pairs: standby.pairs });
    if (isStopping()) return never();
    if (stoppedByDatabase()) return noShards();
    if (!drawn) return never();
    shardCount = drawn.shardCount;
    const pairs = shardClaims.stoppedServing() ? [] : drawn.pairs;
    const ledger = new IdentifyLedger(process.env.DISCORD_TOKEN, shardCount, gateway?.sessionStartLimit ?? null, gateway?.recommendedShards ?? null);
    ledgerRef = ledger;
    await runtime.applyGrant({ processId, shardCount, leases: leasesFor(pairs) });
    shardClaims.noteGranted();
    shardClaims.lossAfterGrant(drawn.lost);
    setOwnerInfoProvider(() => ({ nodeId, processId, shardCount, claimOf: shardId => shardClaims.claimOf(shardId) }));
    servedIds = pairs.map(p => p.shardId);
    try {
      writeShardRecord({ shardCount, shardIds: servedIds, processId, at: new Date().toISOString() });
    } catch (error) {
      console.error('[Shards] Could not write the shard record:', error instanceof Error ? error.message : error);
    }
    console.log(`[Shards] Running ${pairs.length} of ${shardCount} shard(s) in this process: ${pairs.map(p => p.shardId).sort((a, b) => a - b).join(', ')} (after the reshard)`);
    const kept = standby.pairs.length > 0 && shardCount === standby.count && drawn.lost.length === 0 && pairs.length === standby.pairs.length;
    return finish(shardCount, pairs.length, ledger, kept);
  }
  const taken = await shardClaims.bootTake(localCount, () => tokenRefused);
  if (isStopping()) return never();
  if (stoppedByDatabase()) return noShards();
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
  ledgerRef = ledger;
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
