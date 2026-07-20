// Fleet boot orchestration: role resolution, control-plane wiring, shard
// placement. The master claims up to ITS capacity and grants workers only
// FREE shards; owned shards move exclusively through the (future) migration
// system, never automatically. Standalone IS the master path claiming every
// shard, byte-identical to today's single-box boot.

import { performance } from 'perf_hooks';
import type { Client } from 'discord.js';
import { getIngestService } from '../ingest/ingestService';
import {
  CONTROL_PORT_DEFAULT,
  GUILD_TOTALS_REFRESH_MS,
  HEARTBEAT_MS,
  PROTOCOL_VERSION,
} from './constants';
import { LeaseGrantPayload, MSG, NodeCapabilities, NodeRole, RegisterPayload, RegisterResult } from './protocol';
import { getAppVersion, getNodeId, getNodeName, isStandalone, resolveNodeRole } from './nodeIdentity';
import { FileControlStore } from './fileControlStore';
import { Registry, RegistryNode } from './registry';
import { ControlServer } from './controlServer';
import { ControlClient } from './controlClient';
import { LeaseRuntime } from './leaseRuntime';
import {
  assignIdentifyDelays,
  fetchAllGuilds,
  fetchGatewayInfo,
  guildIdToShardId,
  resolvePinnedShardId,
  resolveShardCapacity,
  resolveShardCount,
} from './placement';
import { _setFleetStateSources } from './state';

/** Fleet-mode masters wait this long at boot for surviving workers to redial before the first placement (Part 5 flow 1). */
const REGISTER_GRACE_MS = 10000;

export interface FleetContext {
  role: NodeRole;
  standalone: boolean;
  nodeId: string;
  nodeName: string;
  attachClient(client: Client): void;
  startIngest(token: string | undefined): void;
}

let context: FleetContext | null = null;

export function getFleetContext(): FleetContext | null {
  return context;
}

export type AssignResult = { success: boolean; error?: string };

// Master-only manual FREE-shard assignment, wired by initMaster. Co-workers
// leave it null so the IPC handler reports a clear not-master error.
let masterAssign: ((shardId: number, nodeId: string) => Promise<AssignResult>) | null = null;

/** Manual assign of a FREE shard to a node (Usage-tab action). Master-only. */
export async function fleetAssignShard(shardId: number, nodeId: string): Promise<AssignResult> {
  if (!masterAssign) return { success: false, error: 'This node is not the fleet master' };
  return masterAssign(shardId, nodeId);
}

export async function initFleet(): Promise<FleetContext> {
  if (context) return context;
  const role = resolveNodeRole();
  const standalone = isStandalone();
  const nodeId = getNodeId();
  const nodeName = getNodeName();
  const appVersion = getAppVersion();
  const ingest = getIngestService();
  const runtime = new LeaseRuntime(ingest);
  const capabilities: NodeCapabilities = { shardCapacity: resolveShardCapacity(), dataBackend: 'file' };

  context = role === 'master'
    ? await initMaster({ standalone, nodeId, nodeName, appVersion, capabilities, runtime })
    : await initCoWorker({ nodeId, nodeName, appVersion, capabilities, runtime });
  return context;
}

interface CommonInit {
  nodeId: string;
  nodeName: string;
  appVersion: string;
  capabilities: NodeCapabilities;
  runtime: LeaseRuntime;
}

async function initMaster(init: CommonInit & { standalone: boolean }): Promise<FleetContext> {
  const { standalone, nodeId, nodeName, appVersion, capabilities, runtime } = init;
  const ingest = getIngestService();
  const store = new FileControlStore();
  const term = await store.acquireTerm(nodeId);

  const gateway = await fetchGatewayInfo(process.env.DISCORD_TOKEN);
  if (!gateway && process.env.DISCORD_TOKEN) {
    console.warn('[Fleet] /gateway/bot unreachable; assuming 1 recommended shard');
  }
  const maxConcurrency = gateway?.maxConcurrency ?? 1;
  const recommendedShards = gateway?.recommendedShards ?? null;
  const shardCount = resolveShardCount(gateway?.recommendedShards ?? 1);
  const pinnedShardId = resolvePinnedShardId(shardCount);

  const registry = new Registry();
  registry.term = term;
  registry.shardCount = shardCount;
  registry.upsertNode({ nodeId, nodeName, appVersion, capabilities, isSelf: true, send: null });

  let server: ControlServer | null = null;
  let graceOver = standalone;

  let distributeRunning = false;
  let distributeQueued = false;

  // STANDALONE master claims EVERY shard regardless of FLEET_SHARD_CAPACITY
  // (today's single-box behavior, byte-identical boot); the capacity cap
  // applies only in FLEET mode.
  const targetFor = (node: RegistryNode): number => {
    if (node.isSelf && standalone) return registry.shardCount;
    return Math.max(1, node.capabilities?.shardCapacity ?? 1);
  };

  async function grantShardsTo(node: RegistryNode, fullShardIds: number[], epoch: number): Promise<{ ok: boolean; pending: boolean }> {
    const reuseLeaseIds = new Map<number, string>();
    for (const lease of registry.shardTable.values()) reuseLeaseIds.set(lease.shardId, lease.leaseId);
    const leases = assignIdentifyDelays(new Map([[node.nodeId, fullShardIds]]), maxConcurrency, reuseLeaseIds).get(node.nodeId) ?? [];
    const grant: LeaseGrantPayload = { term: registry.term, epoch, shardCount: registry.shardCount, leases };

    if (node.isSelf) {
      const ack = await runtime.applyGrant(grant);
      if (ack.ok) {
        registry.applyAssignment(node.nodeId, leases, registry.term, epoch);
        node.needsGrant = false;
      }
      return { ok: ack.ok, pending: false };
    }

    try {
      const ack = await server!.request(node.nodeId, MSG.LEASE_GRANT, grant);
      if (ack?.ok) {
        registry.applyAssignment(node.nodeId, leases, registry.term, epoch);
        registry.clearPendingForNode(node.nodeId);
        node.needsGrant = false;
        return { ok: true, pending: false };
      }
      // Refused (stale-term etc.): the worker did NOT adopt, so the shards stay free.
      console.error(`[Fleet] Grant refused by ${node.nodeName}: ${ack?.reason ?? 'unknown'}`);
      return { ok: false, pending: false };
    } catch (error) {
      // UNACKED grant fence: the worker may have applied it despite the lost
      // ack. Mark the NEW shards pending-confirmation (NOT free) so they are
      // never granted elsewhere and dual-identified; heartbeats resolve them.
      const alreadyHeld = new Set(registry.shardIdsOf(node.nodeId));
      const pendingIds: number[] = [];
      for (const lease of leases) {
        if (alreadyHeld.has(lease.shardId)) continue;
        registry.pendingConfirmation.set(lease.shardId, {
          shardId: lease.shardId,
          nodeId: node.nodeId,
          leaseId: lease.leaseId,
          term: registry.term,
          epoch,
          grantedAt: performance.now(),
        });
        pendingIds.push(lease.shardId);
      }
      console.warn(
        `[Fleet] Grant to ${node.nodeName} unacked; shards [${pendingIds.join(', ')}] pending confirmation:`,
        error instanceof Error ? error.message : error,
      );
      return { ok: false, pending: true };
    }
  }

  // Free-shard distribution: every connected node is topped up to its capacity
  // from the FREE pool, master first (it also keeps the pinned shard). Owned
  // and frozen shards are never touched here, so a joining worker can only ever
  // take shards nobody serves.
  async function distributeOnce(): Promise<void> {
    const free = registry.freeShards();
    if (free.length === 0) return;

    const connected = [...registry.nodes.values()].filter(n => n.connected);
    const pickOrder = [...connected].sort((a, b) =>
      a.isSelf === b.isSelf ? a.nodeId.localeCompare(b.nodeId) : a.isSelf ? -1 : 1,
    );

    const pool = [...free];
    const master = registry.nodes.get(nodeId);
    const grantsByNode = new Map<string, number[]>();
    const addGrant = (id: string, shardId: number) => {
      const arr = grantsByNode.get(id) ?? [];
      arr.push(shardId);
      grantsByNode.set(id, arr);
    };

    // Iron rule: the pinned shard is the master's; never hand it to a worker.
    if (pinnedShardId !== null && master && master.connected) {
      const idx = pool.indexOf(pinnedShardId);
      if (idx !== -1) {
        pool.splice(idx, 1);
        addGrant(nodeId, pinnedShardId);
      }
    }

    for (const node of pickOrder) {
      let have = registry.shardIdsOf(node.nodeId).length + (grantsByNode.get(node.nodeId)?.length ?? 0);
      const target = targetFor(node);
      while (have < target && pool.length > 0) {
        addGrant(node.nodeId, pool.shift()!);
        have++;
      }
    }

    if (grantsByNode.size === 0) return;
    registry.epoch += 1;
    const epoch = registry.epoch;

    // Deliver remote grants (and collect their acks) BEFORE the master's own
    // identify: a rejoining worker destroys stale sessions on adopt, so the
    // master never identifies into a shard a worker still holds.
    const execOrder = [...grantsByNode.keys()].sort((a, b) => {
      const aSelf = registry.nodes.get(a)?.isSelf ? 1 : 0;
      const bSelf = registry.nodes.get(b)?.isSelf ? 1 : 0;
      return aSelf - bSelf;
    });
    for (const grantNodeId of execOrder) {
      const node = registry.nodes.get(grantNodeId);
      if (!node) continue;
      const fullSet = [...registry.shardIdsOf(grantNodeId), ...(grantsByNode.get(grantNodeId) ?? [])].sort((a, b) => a - b);
      await grantShardsTo(node, fullSet, epoch);
    }

    await persist();
    if (!standalone) {
      const summary = [...registry.nodes.values()]
        .map(n => `${n.nodeName}${n.isSelf ? ' (self)' : ''}=[${registry.shardIdsOf(n.nodeId).join(', ')}]`)
        .join(' ');
      console.log(`[Fleet] Placement (term ${registry.term}, epoch ${epoch}, ${registry.shardCount} shards): ${summary}`);
    }
  }

  async function distribute(): Promise<void> {
    if (!graceOver) return;
    if (distributeRunning) {
      distributeQueued = true;
      return;
    }
    distributeRunning = true;
    try {
      do {
        distributeQueued = false;
        await distributeOnce();
      } while (distributeQueued);
    } catch (error) {
      console.error('[Fleet] Distribute failed:', error);
    } finally {
      distributeRunning = false;
    }
  }

  masterAssign = async (shardId: number, targetNodeId: string): Promise<AssignResult> => {
    if (!Number.isInteger(shardId) || shardId < 0 || shardId >= registry.shardCount) {
      return { success: false, error: `shard ${shardId} does not exist (valid 0..${registry.shardCount - 1})` };
    }
    const target = registry.nodes.get(targetNodeId);
    if (!target || !target.connected) {
      return { success: false, error: `node ${targetNodeId || '(none)'} is not connected` };
    }
    const held = registry.shardTable.get(shardId);
    if (held) {
      const holder = registry.nodes.get(held.nodeId);
      const holderName = holder?.nodeName ?? held.nodeId;
      if (holder && holder.connected) {
        return { success: false, error: `shard ${shardId} is held by ${holderName}; moving a served shard requires migration` };
      }
      return { success: false, error: `shard ${shardId} is frozen (held by disconnected ${holderName}); requires Declare Lost` };
    }
    if (registry.pendingConfirmation.has(shardId)) {
      return { success: false, error: `shard ${shardId} is pending confirmation; try again shortly` };
    }
    registry.epoch += 1;
    const fullSet = [...registry.shardIdsOf(targetNodeId), shardId].sort((a, b) => a - b);
    const result = await grantShardsTo(target, fullSet, registry.epoch);
    await persist();
    if (result.ok || result.pending) return { success: true };
    return { success: false, error: `grant to ${target.nodeName} was refused` };
  };

  async function persist(): Promise<void> {
    const byNode = new Map<string, { leaseId: string; shardId: number; identifyDelayMs: number }[]>();
    for (const lease of registry.shardTable.values()) {
      const arr = byNode.get(lease.nodeId) ?? [];
      arr.push({ leaseId: lease.leaseId, shardId: lease.shardId, identifyDelayMs: 0 });
      byNode.set(lease.nodeId, arr);
    }
    await store.savePlan({
      term: registry.term,
      epoch: registry.epoch,
      shardCount: registry.shardCount,
      assignments: [...byNode.entries()].map(([assignedNodeId, leases]) => ({ nodeId: assignedNodeId, leases })),
      updatedAt: Date.now(),
    });
    await store.saveRegistry(
      [...registry.nodes.values()].map(n => ({
        nodeId: n.nodeId,
        nodeName: n.nodeName,
        appVersion: n.appVersion,
        capabilities: n.capabilities,
        lastSeenAt: Date.now(),
      })),
    );
  }

  if (!standalone) {
    const secret = (process.env.CONTROL_SECRET || '').trim();
    const port = Number(process.env.CONTROL_PORT) || CONTROL_PORT_DEFAULT;
    server = new ControlServer({
      getTerm: () => registry.term,
      onRegister: (payload: RegisterPayload, send): RegisterResult => {
        if (!payload || typeof payload.nodeId !== 'string' || payload.nodeId.length === 0) {
          return { accepted: false, term: registry.term, reason: 'invalid-register-payload' };
        }
        if (payload.protocolVersion !== PROTOCOL_VERSION) {
          return { accepted: false, term: registry.term, reason: `protocol-version-mismatch (master ${PROTOCOL_VERSION})` };
        }
        if (payload.appVersion !== appVersion) {
          return { accepted: false, term: registry.term, reason: `app-version-mismatch (master ${appVersion})` };
        }
        if (payload.nodeId === nodeId) {
          // A worker cloned from the master's data volume would collide in the registry.
          return { accepted: false, term: registry.term, reason: 'node-id-collision-with-master' };
        }
        registry.upsertNode({
          nodeId: payload.nodeId,
          nodeName: payload.nodeName || payload.nodeId,
          appVersion: payload.appVersion,
          capabilities: payload.capabilities ?? { shardCapacity: 1, dataBackend: 'file' },
          isSelf: false,
          send,
        });
        console.log(`[Fleet] Node registered: ${payload.nodeName} (${payload.nodeId})`);
        return { accepted: true, term: registry.term };
      },
      afterRegister: () => void distribute(),
      onHeartbeat: (heartbeatNodeId, hb) => registry.recordHeartbeat(heartbeatNodeId, hb),
      onGuildNotice: (_noticeNodeId, notice) => registry.applyGuildNotice(notice),
      onDisconnect: disconnectedNodeId => {
        registry.markDisconnected(disconnectedNodeId);
        const name = registry.nodes.get(disconnectedNodeId)?.nodeName ?? disconnectedNodeId;
        console.warn(`[Fleet] Node disconnected: ${name} (owned shards frozen in Wait mode)`);
        // Free-shard distribution only; the disconnected node's shards stay frozen.
        void distribute();
      },
    });
    await server.start(port, secret);
    console.log(`[Fleet] Role: master node=${nodeName} (${nodeId.slice(0, 8)}) term=${term} shardCount=${shardCount} capacity=${capabilities.shardCapacity} controlPort=${port}${pinnedShardId !== null ? ` pinnedShard=${pinnedShardId}` : ''}`);
    setTimeout(() => {
      graceOver = true;
      void distribute();
    }, REGISTER_GRACE_MS).unref();
  } else {
    console.log(`[Fleet] Role: master (standalone) node=${nodeName} (${nodeId.slice(0, 8)}) term=${term} shards=${shardCount} self-granted`);
    await distribute();
  }

  const selfHeartbeat = setInterval(() => {
    registry.recordHeartbeat(nodeId, runtime.buildHeartbeat(registry.term));
    // Periodic reconcile tick: adopt heartbeat truth for pending leases, then
    // re-run free-shard distribution so on-hold workers claim newly-free
    // shards and drift cannot persist.
    if (!standalone && graceOver) {
      registry.reconcilePending();
      void distribute();
    }
  }, HEARTBEAT_MS);
  selfHeartbeat.unref();

  // Full guild list via REST (not shard-bound) so per-shard counts cover shards
  // no instance is connected to. Slow refresh; failures keep the last counts.
  const refreshGuildTotals = async (): Promise<void> => {
    const guilds = await fetchAllGuilds(process.env.DISCORD_TOKEN);
    if (guilds) {
      registry.setAllGuilds(guilds);
      console.log(`[Fleet] Guild directory refreshed via REST: ${guilds.length} guild(s) (names for Guilds-by-shard, including unheld shards)`);
    } else {
      console.warn('[Fleet] Guild directory refresh FAILED (REST GET /users/@me/guilds); Guilds-by-shard will show IDs for guilds this node is not connected to');
    }
  };
  void refreshGuildTotals();
  const guildTotalsTimer = setInterval(() => void refreshGuildTotals(), GUILD_TOTALS_REFRESH_MS);
  guildTotalsTimer.unref();

  _setFleetStateSources({
    role: 'master',
    standalone,
    nodeId,
    nodeName,
    appVersion,
    pinnedShardId,
    capacity: capabilities.shardCapacity,
    recommendedShards,
    runtime,
    ingest,
    registry,
    controlClient: null,
  });

  return {
    role: 'master',
    standalone,
    nodeId,
    nodeName,
    attachClient(client: Client): void {
      runtime.attachClient(client);
      client.on('guildCreate', guild => {
        registry.applyGuildNotice({ guildId: guild.id, shardId: guildIdToShardId(guild.id, registry.shardCount), kind: 'create' });
      });
      client.on('guildDelete', guild => {
        registry.applyGuildNotice({ guildId: guild.id, shardId: guildIdToShardId(guild.id, registry.shardCount), kind: 'delete' });
      });
    },
    startIngest(token: string | undefined): void {
      runtime.setToken(token);
    },
  };
}

async function initCoWorker(init: CommonInit): Promise<FleetContext> {
  const { nodeId, nodeName, appVersion, capabilities, runtime } = init;
  const ingest = getIngestService();
  const masterUrl = (process.env.MASTER_URL || '').trim();
  const secret = (process.env.CONTROL_SECRET || '').trim();

  console.log(`[Fleet] Role: co-worker node=${nodeName} (${nodeId.slice(0, 8)}) master=${masterUrl || 'none'} capacity=${capabilities.shardCapacity}`);

  let controlClient: ControlClient | null = null;
  if (masterUrl && secret) {
    controlClient = new ControlClient({
      masterUrl,
      secret,
      runtime,
      buildRegister: (): RegisterPayload => ({
        nodeId,
        nodeName,
        protocolVersion: PROTOCOL_VERSION,
        appVersion,
        capabilities,
      }),
    });
  } else {
    console.error('[Fleet] Co-worker requires MASTER_URL and CONTROL_SECRET; idling without a master');
  }

  _setFleetStateSources({
    role: 'co-worker',
    standalone: false,
    nodeId,
    nodeName,
    appVersion,
    pinnedShardId: null,
    capacity: capabilities.shardCapacity,
    recommendedShards: null,
    runtime,
    ingest,
    registry: null,
    controlClient,
  });

  const attachGuildNotices = (client: Client) => {
    client.on('guildCreate', guild => {
      const shardCount = runtime.getCurrent()?.shardCount ?? 1;
      controlClient?.sendGuildNotice({ guildId: guild.id, shardId: guildIdToShardId(guild.id, shardCount), kind: 'create' });
    });
    client.on('guildDelete', guild => {
      const shardCount = runtime.getCurrent()?.shardCount ?? 1;
      controlClient?.sendGuildNotice({ guildId: guild.id, shardId: guildIdToShardId(guild.id, shardCount), kind: 'delete' });
    });
  };

  const ctx: FleetContext = {
    role: 'co-worker',
    standalone: false,
    nodeId,
    nodeName,
    attachClient(client: Client): void {
      runtime.attachClient(client);
      attachGuildNotices(client);
    },
    startIngest(token: string | undefined): void {
      runtime.setToken(token);
    },
  };

  if (!controlClient) {
    // No master configured: keep the process informative and alive, but do NOT
    // block boot - the web UI, IPC and fleet state must still come up.
    setInterval(() => {
      console.warn('[Fleet] Co-worker idle: MASTER_URL/CONTROL_SECRET not configured');
    }, 3600000);
    return ctx;
  }

  // Boot must NOT block on the first lease: the co-worker starts dialing and
  // returns immediately. It stays on-hold (registered, no lease, no identify)
  // until the master grants a shard, at which point applyGrant -> maybeStart
  // begins ingest. The no-lease login gate keeps Discord untouched meanwhile.
  controlClient.start();
  return ctx;
}
