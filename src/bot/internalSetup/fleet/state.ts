// Read-only fleet state accessor. The web-UI consumes this over the existing
// fork IPC (a follow-up ipcFleetHandler answers 'fleet:state' with it).

import { performance } from 'perf_hooks';
import { CONTROL_PORT_DEFAULT, PROTOCOL_VERSION } from './constants';
import { getShardSource, isPinEnabled, resolveShardCapacity } from './placement';
import type { NodeRole } from './protocol';
import type { Registry } from './registry';
import type { LeaseRuntime } from './leaseRuntime';
import type { ControlClient } from './controlClient';
import type { IngestService } from '../ingest/ingestService';

export interface FleetStateNode {
  nodeId: string;
  nodeName: string;
  isSelf: boolean;
  isMaster: boolean;
  connected: boolean;
  health: 'up' | 'late' | 'down';
  appVersion: string;
  capabilities: { shardCapacity: number; dataBackend: string };
  capacity: number;
  onHold: boolean;
  shardIds: number[];
  guildCount: number;
  load: { cpuPct: number; rssMb: number; loopLagMs: number } | null;
  lastHeartbeatAgoMs: number | null;
}

export interface FleetState {
  initialized: boolean;
  role: NodeRole;
  standalone: boolean;
  nodeId: string;
  nodeName: string;
  appVersion: string;
  protocolVersion: number;
  term: number;
  epoch: number;
  shardCount: number;
  shardSource: 'discord' | 'override';
  recommendedShards: number | null;
  capacity: number;
  onHold: boolean;
  pinTestGuildShard: boolean;
  pinnedShardId: number | null;
  masterKnown: boolean;
  masterUrl: string | null;
  /**
   * Worker-onboarding block, master-only. masterUrl is the reachable control
   * endpoint: FLEET_PUBLIC_URL when the platform advertised one, else a
   * ws://<host>:<port> template the operator fills in. secret is the master's
   * own CONTROL_SECRET, returned only over the auth-gated web UI so operators
   * can copy-paste a worker's config. Never populated on a co-worker.
   */
  connect: {
    masterUrl: string;
    urlIsTemplate: boolean;
    controlPort: number;
    secretSet: boolean;
    secret?: string;
  } | null;
  leases: { leaseId: string; shardId: number; identifyDelayMs: number }[];
  nodes: FleetStateNode[];
  shardTable: { shardId: number; nodeId: string | null; leaseId: string | null; term: number; epoch: number; status: string }[];
  guildMap: Record<string, number>;
  updatedAt: number;
}

export interface FleetStateSources {
  role: NodeRole;
  standalone: boolean;
  nodeId: string;
  nodeName: string;
  appVersion: string;
  pinnedShardId: number | null;
  capacity: number;
  recommendedShards: number | null;
  runtime: LeaseRuntime;
  ingest: IngestService;
  registry: Registry | null;
  controlClient: ControlClient | null;
}

let sources: FleetStateSources | null = null;

/** Wired once by fleet bootstrap. */
export function _setFleetStateSources(s: FleetStateSources): void {
  sources = s;
}

/**
 * Master-only worker-onboarding block. FLEET_PUBLIC_URL (injected by the
 * manager on a public platform) is the advertised wss endpoint; without it a
 * ws://<host>:<port> template is returned for the operator to fill in. The
 * secret is included only when set so the copy-paste block carries it.
 */
function buildConnect(): FleetState['connect'] {
  const controlPort = Number(process.env.CONTROL_PORT) || CONTROL_PORT_DEFAULT;
  const publicUrl = (process.env.FLEET_PUBLIC_URL || '').trim();
  const secret = (process.env.CONTROL_SECRET || '').trim();
  const urlIsTemplate = publicUrl === '';
  return {
    masterUrl: urlIsTemplate ? `ws://<host>:${controlPort}` : publicUrl,
    urlIsTemplate,
    controlPort,
    secretSet: secret !== '',
    secret: secret !== '' ? secret : undefined,
  };
}

export function getFleetState(): FleetState {
  if (!sources) {
    return {
      initialized: false,
      role: 'master',
      standalone: true,
      nodeId: '',
      nodeName: '',
      appVersion: '',
      protocolVersion: PROTOCOL_VERSION,
      term: 0,
      epoch: 0,
      shardCount: 0,
      shardSource: getShardSource(),
      recommendedShards: null,
      capacity: resolveShardCapacity(),
      onHold: false,
      pinTestGuildShard: isPinEnabled(),
      pinnedShardId: null,
      masterKnown: false,
      masterUrl: null,
      connect: null,
      leases: [],
      nodes: [],
      shardTable: [],
      guildMap: {},
      updatedAt: Date.now(),
    };
  }

  const { role, standalone, nodeId, nodeName, appVersion, pinnedShardId, capacity, recommendedShards, runtime, ingest, registry, controlClient } = sources;
  const lease = runtime.getCurrent();
  const leases = lease ? lease.leases.map(l => ({ ...l })) : [];

  if (role === 'master' && registry) {
    const statusByShard = new Map<number, string>();
    for (const node of registry.nodes.values()) {
      for (const entry of node.shards) statusByShard.set(entry.shardId, entry.status);
    }
    const nodes: FleetStateNode[] = [...registry.nodes.values()].map(node => ({
      nodeId: node.nodeId,
      nodeName: node.nodeName,
      isSelf: node.isSelf,
      isMaster: node.isSelf,
      connected: node.connected,
      health: registry.healthOf(node),
      appVersion: node.appVersion,
      capabilities: node.capabilities,
      capacity: node.capabilities?.shardCapacity ?? 1,
      onHold: !node.isSelf && node.connected && registry.shardIdsOf(node.nodeId).length === 0,
      shardIds: registry.shardIdsOf(node.nodeId),
      guildCount: node.guildCount,
      load: node.load,
      lastHeartbeatAgoMs: node.lastHeartbeatAt === null ? null : Math.round(performance.now() - node.lastHeartbeatAt),
    }));
    // Complete shard table: one entry per shardId. Held shards as leased, free
    // shards as unassigned, unacked grants as pending-confirmation (target node).
    const shardTable: FleetState['shardTable'] = [];
    for (let shardId = 0; shardId < registry.shardCount; shardId++) {
      const held = registry.shardTable.get(shardId);
      if (held) {
        shardTable.push({ shardId, nodeId: held.nodeId, leaseId: held.leaseId, term: held.term, epoch: held.epoch, status: statusByShard.get(shardId) ?? 'Unknown' });
        continue;
      }
      const pending = registry.pendingConfirmation.get(shardId);
      if (pending) {
        shardTable.push({ shardId, nodeId: pending.nodeId, leaseId: pending.leaseId, term: pending.term, epoch: pending.epoch, status: 'pending' });
        continue;
      }
      shardTable.push({ shardId, nodeId: null, leaseId: null, term: 0, epoch: 0, status: 'unassigned' });
    }
    return {
      initialized: true,
      role,
      standalone,
      nodeId,
      nodeName,
      appVersion,
      protocolVersion: PROTOCOL_VERSION,
      term: registry.term,
      epoch: registry.epoch,
      shardCount: registry.shardCount,
      shardSource: getShardSource(),
      recommendedShards,
      capacity,
      onHold: false,
      pinTestGuildShard: isPinEnabled(),
      pinnedShardId,
      masterKnown: true,
      masterUrl: null,
      connect: buildConnect(),
      leases,
      nodes,
      shardTable,
      guildMap: Object.fromEntries(registry.guildMap),
      updatedAt: Date.now(),
    };
  }

  // Co-worker view: this node only; the master owns the fleet-wide picture.
  const hb = runtime.getLastHeartbeat();
  const client = ingest.getClient();
  const guildMap: Record<string, number> = {};
  if (client && lease) {
    for (const guild of client.guilds.cache.values()) {
      guildMap[guild.id] = guild.shardId;
    }
  }
  const statusByShard = new Map<number, string>((hb?.shards ?? []).map(s => [s.shardId, s.status]));
  const term = controlClient?.getTerm() ?? lease?.term ?? 0;
  const registered = controlClient?.masterKnown() ?? false;
  const onHold = registered && leases.length === 0;
  const shardCount = lease?.shardCount ?? 0;
  // Complete shard table from this node's own leases; the master owns the
  // fleet-wide picture, so shards this node does not hold read as unassigned.
  const leaseByShard = new Map<number, { leaseId: string; shardId: number; identifyDelayMs: number }>(leases.map(l => [l.shardId, l]));
  const shardTable: FleetState['shardTable'] = [];
  for (let shardId = 0; shardId < shardCount; shardId++) {
    const l = leaseByShard.get(shardId);
    if (l) {
      shardTable.push({ shardId, nodeId, leaseId: l.leaseId, term: lease?.term ?? term, epoch: lease?.epoch ?? 0, status: statusByShard.get(shardId) ?? 'Unknown' });
    } else {
      shardTable.push({ shardId, nodeId: null, leaseId: null, term: 0, epoch: 0, status: 'unassigned' });
    }
  }
  return {
    initialized: true,
    role,
    standalone: false,
    nodeId,
    nodeName,
    appVersion,
    protocolVersion: PROTOCOL_VERSION,
    term,
    epoch: lease?.epoch ?? 0,
    shardCount,
    shardSource: getShardSource(),
    recommendedShards,
    capacity,
    onHold,
    pinTestGuildShard: isPinEnabled(),
    pinnedShardId: null,
    masterKnown: registered,
    masterUrl: (process.env.MASTER_URL || '').trim() || null,
    connect: null,
    leases,
    nodes: [
      {
        nodeId,
        nodeName,
        isSelf: true,
        isMaster: false,
        connected: true,
        health: 'up',
        appVersion,
        capabilities: { shardCapacity: capacity, dataBackend: 'file' },
        capacity,
        onHold,
        shardIds: leases.map(l => l.shardId).sort((a, b) => a - b),
        guildCount: Object.keys(guildMap).length,
        load: hb?.load ?? null,
        lastHeartbeatAgoMs: null,
      },
    ],
    shardTable,
    guildMap,
    updatedAt: Date.now(),
  };
}
