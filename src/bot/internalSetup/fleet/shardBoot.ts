import type { Client } from 'discord.js';
import { getIngestService } from '../ingest/ingestService';
import { getGuildDataBackend, setOwnerInfoProvider } from '../utils/dataManager';
import { getDataBootStatus, setRuntimeRecycledHandler } from '../utils/dataBackends/boot';
import { PostgresBackend, readMaxOwnershipTerm } from '../utils/dataBackends/postgresBackend';
import { cleanOrphanTmpFiles } from '../utils/dataBackends/fileBackend';
import { LeaseRuntime } from './leaseRuntime';
import { getAppVersion, getNodeId, getNodeName } from './nodeIdentity';
import { assignIdentifyDelays, decideShardSource, fetchGatewayInfoResult, resolveShardCapacity, resolveShardCount } from './placement';
import { _setFleetStateSources } from './state';

// The lowest fence term a boot takes; it sits above any term the old control
// plane could have minted. On Postgres each boot claims above every stored row.
export const SHARD_BOOT_TERM = 1_000_000_000;
export const SHARD_BOOT_EPOCH = 1;
const TERM_READ_RETRY_MS = 5_000;
const VERIFY_POLL_MS = 1_000;
const WAIT_LOG_MS = 30_000;

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); });

export async function resolveBootTerm(): Promise<number> {
  let lastWaitLog = -Infinity;
  for (;;) {
    const backend = getGuildDataBackend();
    if (!(backend instanceof PostgresBackend)) return SHARD_BOOT_TERM;
    const state = getDataBootStatus().state;
    // The readiness driver stays held after a refusal, so nothing writes under this term.
    if (state === 'refused') return SHARD_BOOT_TERM;
    if (state !== 'serving') {
      if (Date.now() - lastWaitLog >= WAIT_LOG_MS) {
        console.log(`[Shards] Waiting for the database to verify before taking shards (state: ${state})`);
        lastWaitLog = Date.now();
      }
      await sleep(VERIFY_POLL_MS);
      continue;
    }
    try {
      return Math.max(SHARD_BOOT_TERM, (await readMaxOwnershipTerm(backend)) + 1);
    } catch (error) {
      console.error('[Shards] Could not read the stored ownership term; retrying:', error instanceof Error ? error.message : error);
      await sleep(TERM_READ_RETRY_MS);
    }
  }
}

export interface ShardBootContext {
  nodeId: string;
  nodeName: string;
  shardCount: number;
  attachClient(client: Client): void;
  startIngest(token: string | undefined): void;
}

let context: ShardBootContext | null = null;
let booting: Promise<ShardBootContext> | null = null;

export function getFleetContext(): ShardBootContext | null {
  return context;
}

export function bootShards(): Promise<ShardBootContext> {
  if (context) return Promise.resolve(context);
  if (!booting) booting = runBoot().finally(() => { booting = null; });
  return booting;
}

async function runBoot(): Promise<ShardBootContext> {
  const nodeId = getNodeId();
  const nodeName = getNodeName();
  const ingest = getIngestService();
  const runtime = new LeaseRuntime(ingest);
  setRuntimeRecycledHandler(outcome => {
    if (outcome.recycled) runtime.renotifyDataLayer();
  });

  try {
    await cleanOrphanTmpFiles();
  } catch (error) {
    console.error('[Shards] Orphaned temp file cleanup failed:', error instanceof Error ? error.message : error);
  }

  const { info: gateway, error: gatewayError } = await fetchGatewayInfoResult(process.env.DISCORD_TOKEN);
  if (!gateway && process.env.DISCORD_TOKEN) {
    console.warn(`[Shards] /gateway/bot failed (${gatewayError}); assuming 1 recommended shard`);
  }
  const shardCount = resolveShardCount(gateway?.recommendedShards ?? 1);
  const shardIds = Array.from({ length: shardCount }, (_, i) => i);
  const leases = assignIdentifyDelays(new Map([[nodeId, shardIds]]), gateway?.maxConcurrency ?? 1).get(nodeId) ?? [];
  const term = await resolveBootTerm();
  const ack = await runtime.applyGrant({ term, epoch: SHARD_BOOT_EPOCH, shardCount, leases });
  if (!ack.ok) throw new Error(`[Shards] Could not take shards 0..${shardCount - 1}: ${ack.reason ?? 'refused'}`);
  console.log(`[Shards] Running all ${shardCount} shard(s) in this process`);

  _setFleetStateSources({
    role: 'master',
    standalone: true,
    nodeId,
    nodeName,
    appVersion: getAppVersion(),
    pinnedShardId: null,
    capacity: resolveShardCapacity(),
    recommendedShards: gateway?.recommendedShards ?? null,
    recommendedAt: gateway ? Date.now() : null,
    shardSource: decideShardSource({ adoptedPlan: false, overrideApplied: false, gatewayAnswered: gateway !== null }),
    runtime,
    ingest,
    registry: null,
    controlClient: null,
    recovery: null,
    ledger: null,
    healthMonitor: null,
    refusedRegistrations: null,
    sync: null,
    migration: null,
    transformation: null,
    pinViolation: null,
    unassigned: null,
    termStamp: null,
    fleetConfig: null,
    witness: null,
    migrationActive: null,
  });

  setOwnerInfoProvider(() => ({ nodeId, term, epoch: SHARD_BOOT_EPOCH, shardCount }));

  context = {
    nodeId,
    nodeName,
    shardCount,
    attachClient(client: Client): void {
      runtime.attachClient(client);
    },
    startIngest(token: string | undefined): void {
      runtime.setToken(token);
    },
  };
  return context;
}
