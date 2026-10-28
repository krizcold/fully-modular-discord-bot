import { getIngestService } from '../ingest/ingestService';
import { getGuildDataBackend, setOwnerInfoProvider } from '../utils/dataManager';
import { getDataBootStatus } from '../utils/dataBackends/boot';
import { PostgresBackend } from '../utils/dataBackends/postgresBackend';
import { cleanOrphanTmpFiles } from '../utils/dataBackends/fileBackend';
import { IdentifyLedger } from './identifyLedger';
import { LeaseRuntime } from './leaseRuntime';
import { getAppVersion, getNodeId, getNodeName } from './nodeIdentity';
import { decideShardSource, fetchGatewayInfoResult, leasesFor, resolveShardCount } from './placement';
import { _setFleetStateSources } from './state';

const CLAIM_RETRY_MS = 5_000;
const VERIFY_POLL_MS = 1_000;
const WAIT_LOG_MS = 30_000;

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); });

/**
 * The claim number every shard of this boot saves under: null on a JSON bot, on a refused data layer (its driver stays
 * held, so nothing saves), on a database of another schema version and once the backend stopped; on Postgres, one
 * taken from the database once it serves.
 */
export async function resolveBootClaim(): Promise<number | null> {
  let lastWaitLog = -Infinity;
  for (;;) {
    const backend = getGuildDataBackend();
    if (!(backend instanceof PostgresBackend)) return null;
    const state = getDataBootStatus().state;
    if (state === 'refused') return null;
    if (state !== 'serving') {
      if (Date.now() - lastWaitLog >= WAIT_LOG_MS) {
        console.log(`[Shards] Waiting for the database to verify before taking shards (state: ${state})`);
        lastWaitLog = Date.now();
      }
      await sleep(VERIFY_POLL_MS);
      continue;
    }
    try {
      const answer = await backend.takeClaim();
      if (answer.outcome === 'claimed') return answer.claim;
      console.error(answer.outcome === 'mismatch'
        ? '[Shards] No shard claim taken: the database holds another schema version, so no guild data is saved'
        : '[Shards] No shard claim taken: the data backend stopped');
      return null;
    } catch (error) {
      console.error('[Shards] Could not take a shard claim from the database; retrying in 5 s:', error instanceof Error ? error.message : error);
      await sleep(CLAIM_RETRY_MS);
    }
  }
}

export interface ShardBootContext {
  nodeId: string;
  nodeName: string;
  shardCount: number;
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
  const leases = leasesFor(shardIds);
  const claim = await resolveBootClaim();
  const ledger = new IdentifyLedger(process.env.DISCORD_TOKEN, shardCount, gateway?.sessionStartLimit ?? null, gateway?.recommendedShards ?? null);
  ledger.charge(shardCount);
  await runtime.applyGrant({ claim, shardCount, leases });
  console.log(`[Shards] Running all ${shardCount} shard(s) in this process`);

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
  });

  setOwnerInfoProvider(() => ({ nodeId, claim, shardCount }));

  context = {
    nodeId,
    nodeName,
    shardCount,
    startIngest(token: string | undefined): void {
      runtime.setToken(token);
    },
  };
  return context;
}
