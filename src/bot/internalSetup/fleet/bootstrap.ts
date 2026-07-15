// Fleet boot orchestration: role resolution, control-plane wiring, lease
// acquisition. Standalone IS the master path with self-granted leases over
// the whole shard set; with zero fleet env this adds exactly one role log
// line to today's boot.

import type { Client } from 'discord.js';
import { getIngestService } from '../ingest/ingestService';
import {
  CONTROL_PORT_DEFAULT,
  DEFAULT_SHARD_CAPACITY,
  HEARTBEAT_MS,
  PROTOCOL_VERSION,
} from './constants';
import { LeaseGrantPayload, MSG, NodeCapabilities, NodeRole, RegisterPayload, RegisterResult } from './protocol';
import { getAppVersion, getNodeId, getNodeName, isStandalone, resolveNodeRole } from './nodeIdentity';
import { FileControlStore } from './fileControlStore';
import { Registry } from './registry';
import { ControlServer } from './controlServer';
import { ControlClient } from './controlClient';
import { LeaseRuntime } from './leaseRuntime';
import {
  assignIdentifyDelays,
  fetchGatewayInfo,
  guildIdToShardId,
  planAssignments,
  resolvePinnedShardId,
  resolveShardCount,
} from './placement';
import { _setFleetStateSources } from './state';

/** Fleet-mode masters wait this long at boot for surviving workers to redial before the first plan (Part 5 flow 1). */
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

export async function initFleet(): Promise<FleetContext> {
  if (context) return context;
  const role = resolveNodeRole();
  const standalone = isStandalone();
  const nodeId = getNodeId();
  const nodeName = getNodeName();
  const appVersion = getAppVersion();
  const ingest = getIngestService();
  const runtime = new LeaseRuntime(ingest);
  const capabilities: NodeCapabilities = { shardCapacity: DEFAULT_SHARD_CAPACITY, dataBackend: 'file' };

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
  const shardCount = resolveShardCount({
    standalone,
    recommended: gateway?.recommendedShards ?? 1,
    selfCapacity: capabilities.shardCapacity,
  });
  const pinnedShardId = resolvePinnedShardId(shardCount);

  const registry = new Registry();
  registry.term = term;
  registry.shardCount = shardCount;
  registry.upsertNode({ nodeId, nodeName, appVersion, capabilities, isSelf: true, send: null });

  let server: ControlServer | null = null;
  let graceOver = standalone;

  let replanRunning = false;
  let replanQueued = false;

  async function replanOnce(): Promise<void> {
    const connected = [...registry.nodes.values()].filter(n => n.connected);
    // Wait-mode: shards leased to disconnected nodes are never redistributed
    // here (auto-reassignment is Phase 2); they may still be served under a
    // live lease and re-granting them would risk a dual identify.
    const frozenShards = new Set<number>();
    for (const lease of registry.shardTable.values()) {
      const holder = registry.nodes.get(lease.nodeId);
      if (!holder || !holder.connected) frozenShards.add(lease.shardId);
    }
    const shardPool: number[] = [];
    for (let shardId = 0; shardId < registry.shardCount; shardId++) {
      if (!frozenShards.has(shardId)) shardPool.push(shardId);
    }

    const assignments = planAssignments({
      shardCount: registry.shardCount,
      shardPool,
      nodes: connected.map(n => ({
        nodeId: n.nodeId,
        capacity: Math.max(1, n.capabilities?.shardCapacity || DEFAULT_SHARD_CAPACITY),
        isMaster: n.isSelf,
      })),
      pinnedShardId,
    });

    const changed = new Set<string>();
    const grantTargets: string[] = [];
    for (const node of connected) {
      const target = assignments.get(node.nodeId) ?? [];
      const current = registry.shardIdsOf(node.nodeId);
      const setChanged = target.length !== current.length || target.some((v, i) => v !== current[i]);
      if (setChanged) changed.add(node.nodeId);
      if (setChanged || node.needsGrant) grantTargets.push(node.nodeId);
    }
    if (grantTargets.length === 0) return;
    if (changed.size > 0) registry.epoch += 1;
    const epoch = registry.epoch;

    // Revoke-before-grant: every node whose set changes releases everything
    // it holds before any shard is granted elsewhere.
    for (const revokeNodeId of changed) {
      const node = registry.nodes.get(revokeNodeId)!;
      const leaseIds = [...registry.shardTable.values()]
        .filter(l => l.nodeId === revokeNodeId)
        .map(l => l.leaseId);
      if (leaseIds.length === 0) continue;
      if (node.isSelf) {
        await runtime.revoke(registry.term, leaseIds, 'replan');
        registry.clearNodeAssignment(revokeNodeId);
        continue;
      }
      try {
        const ack = await server!.request(revokeNodeId, MSG.LEASE_REVOKE, { term: registry.term, leaseIds, reason: 'replan' });
        if (!ack?.ok) throw new Error(ack?.reason ?? 'revoke refused');
        registry.clearNodeAssignment(revokeNodeId);
      } catch (error) {
        // Cannot prove the holder released its sessions: abort instead of
        // risking a dual identify. The next register/disconnect re-plans.
        console.error(`[Fleet] Revoke failed for ${revokeNodeId}; aborting replan:`, error instanceof Error ? error.message : error);
        return;
      }
    }

    // Identify slots master-first, but remote grants are DELIVERED and acked
    // before the master's own: a rejoining worker destroys its stale-term
    // sessions when it adopts, so the master never identifies into a shard a
    // worker still holds.
    const grantAssignments = new Map<string, number[]>();
    for (const [assignNodeId, shardIds] of assignments) {
      if (grantTargets.includes(assignNodeId)) grantAssignments.set(assignNodeId, shardIds);
    }
    const reuseLeaseIds = new Map<number, string>();
    for (const lease of registry.shardTable.values()) reuseLeaseIds.set(lease.shardId, lease.leaseId);
    const delayed = assignIdentifyDelays(grantAssignments, maxConcurrency, reuseLeaseIds);

    const grantOrder = [...delayed.keys()].sort((a, b) => {
      const aSelf = registry.nodes.get(a)?.isSelf ? 1 : 0;
      const bSelf = registry.nodes.get(b)?.isSelf ? 1 : 0;
      return aSelf - bSelf;
    });
    for (const grantNodeId of grantOrder) {
      const node = registry.nodes.get(grantNodeId);
      const leases = delayed.get(grantNodeId)!;
      if (!node) continue;
      const grant: LeaseGrantPayload = { term: registry.term, epoch, shardCount: registry.shardCount, leases };
      if (node.isSelf) {
        const ack = await runtime.applyGrant(grant);
        if (ack.ok) {
          registry.applyAssignment(grantNodeId, leases, registry.term, epoch);
          node.needsGrant = false;
        }
        continue;
      }
      try {
        const ack = await server!.request(grantNodeId, MSG.LEASE_GRANT, grant);
        if (ack?.ok) {
          registry.applyAssignment(grantNodeId, leases, registry.term, epoch);
          node.needsGrant = false;
        } else {
          console.error(`[Fleet] Grant refused by ${grantNodeId}: ${ack?.reason ?? 'unknown'}`);
        }
      } catch (error) {
        console.error(
          `[Fleet] Grant to ${grantNodeId} failed; shards [${leases.map(l => l.shardId).join(', ')}] left unassigned:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    await persist();
    if (!standalone) {
      const summary = [...registry.nodes.values()]
        .map(n => `${n.nodeName}${n.isSelf ? ' (self)' : ''}=[${registry.shardIdsOf(n.nodeId).join(', ')}]`)
        .join(' ');
      console.log(`[Fleet] Plan (term ${registry.term}, epoch ${epoch}, ${registry.shardCount} shards): ${summary}`);
    }
  }

  async function replan(): Promise<void> {
    if (!graceOver) return;
    if (replanRunning) {
      replanQueued = true;
      return;
    }
    replanRunning = true;
    try {
      do {
        replanQueued = false;
        await replanOnce();
      } while (replanQueued);
    } catch (error) {
      console.error('[Fleet] Replan failed:', error);
    } finally {
      replanRunning = false;
    }
  }

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
          capabilities: payload.capabilities ?? { shardCapacity: DEFAULT_SHARD_CAPACITY, dataBackend: 'file' },
          isSelf: false,
          send,
        });
        console.log(`[Fleet] Node registered: ${payload.nodeName} (${payload.nodeId})`);
        return { accepted: true, term: registry.term };
      },
      afterRegister: () => void replan(),
      onHeartbeat: (heartbeatNodeId, hb) => registry.recordHeartbeat(heartbeatNodeId, hb),
      onGuildNotice: (_noticeNodeId, notice) => registry.applyGuildNotice(notice),
      onDisconnect: disconnectedNodeId => {
        registry.markDisconnected(disconnectedNodeId);
        const name = registry.nodes.get(disconnectedNodeId)?.nodeName ?? disconnectedNodeId;
        console.warn(`[Fleet] Node disconnected: ${name} (leases held in Wait mode)`);
      },
    });
    await server.start(port, secret);
    console.log(`[Fleet] Role: master node=${nodeName} (${nodeId.slice(0, 8)}) term=${term} shardCount=${shardCount} controlPort=${port}${pinnedShardId !== null ? ` pinnedShard=${pinnedShardId}` : ''}`);
    setTimeout(() => {
      graceOver = true;
      void replan();
    }, REGISTER_GRACE_MS).unref();
  } else {
    console.log(`[Fleet] Role: master (standalone) node=${nodeName} (${nodeId.slice(0, 8)}) term=${term} shards=${shardCount} self-granted`);
    await replan();
  }

  const selfHeartbeat = setInterval(() => {
    registry.recordHeartbeat(nodeId, runtime.buildHeartbeat(registry.term));
  }, HEARTBEAT_MS);
  selfHeartbeat.unref();

  _setFleetStateSources({
    role: 'master',
    standalone,
    nodeId,
    nodeName,
    appVersion,
    pinnedShardId,
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

  console.log(`[Fleet] Role: co-worker node=${nodeName} (${nodeId.slice(0, 8)}) master=${masterUrl || 'none'}`);

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
    // Idle forever: no master means no lease and no identify, but the
    // process stays alive so an operator can fix the env and restart.
    setInterval(() => {
      console.warn('[Fleet] Co-worker idle: MASTER_URL/CONTROL_SECRET not configured');
    }, 3600000);
    await new Promise<void>(() => { /* never resolves by design */ });
    return ctx;
  }

  controlClient.start();
  // Boot holds here until the master grants a lease; an unreachable master
  // means the co-worker idles and keeps redialing with backoff.
  await controlClient.waitForFirstLease();
  return ctx;
}
