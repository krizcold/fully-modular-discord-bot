// Read-only shard state of this process, answered over the fork IPC
// ('fleet:state') to the web UI.

import { resolveDataBackend } from '../../../utils/envLoader';
import { getDataBootStatus, DataBootStatus } from '../utils/dataBackends/boot';
import { getShardCountOverride } from './placement';
import type { ShardSource } from './placement';
import type { BudgetInfo, IdentifyLedger } from './identifyLedger';
import type { LeaseInfo, LeaseRuntime } from './leaseRuntime';
import type { IngestService } from '../ingest/ingestService';

export interface FleetState {
  initialized: boolean;
  nodeId: string;
  nodeName: string;
  appVersion: string;
  shardCount: number;
  shardSource: ShardSource;
  /** Discord's latest recommended shard count; null before any /gateway/bot answer. */
  recommendedShards: number | null;
  recommendedAt: number | null;
  dataBackend: 'file' | 'postgres';
  dataBoot: DataBootStatus;
  /** The claim number this process saves under; null on a JSON bot, before the boot took one, or when it holds none. */
  claim: number | null;
  leases: LeaseInfo[];
  shardTable: { shardId: number; nodeId: string; leaseId: string; status: string; guildCount: number }[];
  guildMap: Record<string, number>;
  budget: BudgetInfo | null;
  updatedAt: number;
}

export interface FleetStateSources {
  nodeId: string;
  nodeName: string;
  appVersion: string;
  shardSource: ShardSource;
  recommendedShards: number | null;
  recommendedAt: number | null;
  runtime: LeaseRuntime;
  ingest: IngestService;
  ledger: IdentifyLedger;
}

let sources: FleetStateSources | null = null;

/** Wired once by the shard boot. */
export function _setFleetStateSources(s: FleetStateSources): void {
  sources = s;
}

export function getFleetState(): FleetState {
  if (!sources) {
    return {
      initialized: false,
      nodeId: '',
      nodeName: '',
      appVersion: '',
      shardCount: 0,
      shardSource: getShardCountOverride() !== null ? 'override' : 'discord',
      recommendedShards: null,
      recommendedAt: null,
      dataBackend: resolveDataBackend(),
      dataBoot: getDataBootStatus(),
      claim: null,
      leases: [],
      shardTable: [],
      guildMap: {},
      budget: null,
      updatedAt: Date.now(),
    };
  }

  const { nodeId, nodeName, appVersion, runtime, ingest, ledger } = sources;
  const lease = runtime.getCurrent();
  const leases = lease ? lease.leases.map(l => ({ ...l })) : [];
  const shardCount = lease?.shardCount ?? 0;
  const client = ingest.getClient();
  const guildMap: Record<string, number> = {};
  if (client && lease) {
    for (const guild of client.guilds.cache.values()) guildMap[guild.id] = guild.shardId;
  }
  const statusByShard = new Map(runtime.shardStatuses().map(s => [s.shardId, s]));
  const shardTable: FleetState['shardTable'] = [...leases]
    .sort((a, b) => a.shardId - b.shardId)
    .map(held => {
      const entry = statusByShard.get(held.shardId);
      return { shardId: held.shardId, nodeId, leaseId: held.leaseId, status: entry?.status ?? 'Unknown', guildCount: entry?.guildCount ?? 0 };
    });
  const recommendation = ledger.getRecommendation();
  return {
    initialized: true,
    nodeId,
    nodeName,
    appVersion,
    shardCount,
    shardSource: sources.shardSource,
    recommendedShards: recommendation?.shards ?? sources.recommendedShards,
    recommendedAt: recommendation?.readAt ?? sources.recommendedAt,
    dataBackend: resolveDataBackend(),
    dataBoot: getDataBootStatus(),
    claim: lease?.claim ?? null,
    leases,
    shardTable,
    guildMap,
    budget: ledger.getBudgetInfo(),
    updatedAt: Date.now(),
  };
}
