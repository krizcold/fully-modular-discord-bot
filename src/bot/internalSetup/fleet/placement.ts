// Placement helpers: shard-count resolution, this-node capacity, the guild ->
// shard formula and identify pacing. The master claims up to ITS capacity and
// only ever grants FREE shards to workers; owned shards move exclusively via
// migration (bootstrap owns the distribution loop).

import * as https from 'https';
import { randomUUID } from 'crypto';
import { GATEWAY_INFO_TIMEOUT_MS, IDENTIFY_SPACING_MS } from './constants';
import type { LeaseInfo } from './protocol';
import type { Registry, RegistryNode } from './registry';

export interface SessionStartLimit {
  total: number;
  remaining: number;
  resetAfterMs: number;
}

export interface GatewayInfo {
  recommendedShards: number;
  maxConcurrency: number;
  sessionStartLimit: SessionStartLimit | null;
}

/** GET /gateway/bot for the recommended shard count, identify concurrency and identify budget. Null on any failure. */
export function fetchGatewayInfo(token: string | undefined): Promise<GatewayInfo | null> {
  if (!token || token.trim() === '') return Promise.resolve(null);
  return new Promise(resolve => {
    const req = https.get(
      'https://discord.com/api/v10/gateway/bot',
      { headers: { authorization: `Bot ${token}` }, timeout: GATEWAY_INFO_TIMEOUT_MS },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) return resolve(null);
            const parsed = JSON.parse(body);
            const ssl = parsed?.session_start_limit;
            resolve({
              recommendedShards: Number(parsed.shards) || 1,
              maxConcurrency: Number(ssl?.max_concurrency) || 1,
              sessionStartLimit: ssl && Number.isFinite(Number(ssl.total))
                ? {
                    total: Number(ssl.total),
                    remaining: Number(ssl.remaining) || 0,
                    resetAfterMs: Number(ssl.reset_after) || 0,
                  }
                : null,
            });
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function httpsGetJson(path: string, token: string): Promise<any | null> {
  return new Promise(resolve => {
    const req = https.get(
      `https://discord.com/api/v10${path}`,
      { headers: { authorization: `Bot ${token}` }, timeout: GATEWAY_INFO_TIMEOUT_MS },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.warn(`[Fleet] REST ${path} -> HTTP ${res.statusCode}: ${body.slice(0, 200)}`);
            resolve(null);
            return;
          }
          try { resolve(JSON.parse(body)); } catch { console.warn(`[Fleet] REST ${path} returned malformed JSON`); resolve(null); }
        });
      },
    );
    req.on('timeout', () => { console.warn(`[Fleet] REST ${path} timed out after ${GATEWAY_INFO_TIMEOUT_MS}ms`); req.destroy(); resolve(null); });
    req.on('error', e => { console.warn(`[Fleet] REST ${path} error: ${e instanceof Error ? e.message : String(e)}`); resolve(null); });
  });
}

export interface RestGuild {
  id: string;
  name: string;
}

/**
 * Every guild the bot is in, via REST (GET /users/@me/guilds, paginated),
 * with its name. REST is NOT shard-bound, so this reports guilds on shards no
 * instance is currently connected to - the only way to see the guilds on an
 * unassigned shard. Null on any failure; caller keeps its last known list.
 */
export async function fetchAllGuilds(token: string | undefined): Promise<RestGuild[] | null> {
  if (!token || token.trim() === '') return null;
  const guilds: RestGuild[] = [];
  let after = '';
  // Hard page cap so a huge account cannot spin forever; 200/page => 40k guilds.
  for (let page = 0; page < 200; page++) {
    const batch = await httpsGetJson(`/users/@me/guilds?limit=200${after ? `&after=${after}` : ''}`, token);
    if (!Array.isArray(batch)) return page === 0 ? null : guilds;
    for (const g of batch) {
      if (g && typeof g.id === 'string') guilds.push({ id: g.id, name: typeof g.name === 'string' ? g.name : g.id });
    }
    if (batch.length < 200) return guilds;
    after = batch[batch.length - 1].id;
  }
  return guilds;
}

/** Discord's fixed guild -> shard formula. */
export function guildIdToShardId(guildId: string, shardCount: number): number {
  try {
    return Number((BigInt(guildId) >> 22n) % BigInt(Math.max(1, shardCount)));
  } catch {
    return 0;
  }
}

/** FLEET_SHARD_COUNT override when it is a valid positive integer; null otherwise. */
export function getShardCountOverride(): number | null {
  const override = Number(process.env.FLEET_SHARD_COUNT);
  return Number.isInteger(override) && override > 0 ? override : null;
}

/** True when FLEET_CONFIRM_RESHARD is 1/true; an override-driven shardCount change only applies when confirmed. */
export function isReshardConfirmed(): boolean {
  const value = (process.env.FLEET_CONFIRM_RESHARD || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

/** Total shards: FLEET_SHARD_COUNT override, else Discord's /gateway/bot recommendation. */
export function resolveShardCount(recommended: number): number {
  return getShardCountOverride() ?? Math.max(1, recommended);
}

/** Where shardCount came from, for display. */
export function getShardSource(): 'discord' | 'override' {
  return getShardCountOverride() !== null ? 'override' : 'discord';
}

/**
 * Max shards THIS instance holds (FLEET_SHARD_CAPACITY, default 1). Applies in
 * FLEET mode; a STANDALONE master claims every shard regardless (bootstrap).
 */
export function resolveShardCapacity(): number {
  const raw = Number(process.env.FLEET_SHARD_CAPACITY);
  // 0 is a real declaration: a pure standby that serves nothing
  // (PLAN_STANDBY ruling 1). Absent/invalid still defaults to 1.
  return Number.isInteger(raw) && raw >= 0 ? raw : 1;
}

/** True when PIN_TEST_GUILD_SHARD=true; env missing = false. */
export function isPinEnabled(): boolean {
  return process.env.PIN_TEST_GUILD_SHARD === 'true';
}

/** Shard of the test guild (GUILD_ID) when pinning is on; null otherwise. */
export function resolvePinnedShardId(shardCount: number): number | null {
  if (!isPinEnabled()) return null;
  const guildId = (process.env.GUILD_ID || '').trim();
  if (!/^\d+$/.test(guildId)) return null;
  return guildIdToShardId(guildId, shardCount);
}

/**
 * Placement v1.5: place FREE shards on the least-loaded eligible nodes,
 * biggest-impact shards (most fleet guilds) first. Eligible = connected, not
 * draining, under target; the caller pre-filters ledger-backoff nodes. The
 * pinned-shard-to-master rule runs in the caller before this.
 */
export function pickFreePlacements(
  freePool: number[],
  nodes: RegistryNode[],
  registry: Registry,
  targetFor: (node: RegistryNode) => number,
): Map<string, number[]> {
  const placements = new Map<string, number[]>();
  const eligible = nodes
    .filter(n => n.connected && !n.draining)
    .sort((a, b) => (a.isSelf === b.isSelf ? a.nodeId.localeCompare(b.nodeId) : a.isSelf ? -1 : 1));
  if (eligible.length === 0) return placements;

  const held = new Map<string, number>();
  for (const node of eligible) held.set(node.nodeId, registry.shardIdsOf(node.nodeId).length);

  const pool = [...freePool].sort(
    (a, b) => (registry.shardGuildTotals.get(b) ?? 0) - (registry.shardGuildTotals.get(a) ?? 0),
  );
  for (const shardId of pool) {
    let best: RegistryNode | null = null;
    let bestScore = Infinity;
    for (const node of eligible) {
      const target = targetFor(node);
      const has = held.get(node.nodeId) ?? 0;
      if (has >= target) continue;
      const loadScore = node.load ? node.load.cpuPct + node.load.loopLagMs / 10 : 50;
      const score = (has / Math.max(1, target)) * 100 + loadScore + node.guildCount / 100;
      if (score < bestScore) {
        bestScore = score;
        best = node;
      }
    }
    if (!best) break;
    const arr = placements.get(best.nodeId) ?? [];
    arr.push(shardId);
    placements.set(best.nodeId, arr);
    held.set(best.nodeId, (held.get(best.nodeId) ?? 0) + 1);
  }
  return placements;
}

export interface PinRestoreLeg {
  shardId: number;
  fromNodeId: string;
  toNodeId: string;
}

export interface PinRestorePlan {
  proposedLegs: PinRestoreLeg[] | null;
  reason?: string;
}

/**
 * Swap proposal (P5): when PIN_TEST_GUILD_SHARD is on and the pinned shard is
 * held by a live non-master node, propose the lease moves that bring it back to
 * the master. Leg 1 = pinned shard -> master. If the master is at capacity, the
 * displaced leg moves the master's lowest-guild-count shard to the pinned
 * shard's current holder (if it has capacity), else any connected node with
 * free capacity, else null + reason 'no-capacity'. The general mechanism is N
 * lease moves under one barrier; a strict 1:1 swap is the equal-capacity case.
 * NEVER auto-executed - the Swap button submits the returned legs.
 */
export function planPinRestoreLegs(
  registry: Registry,
  pinnedShardId: number,
  masterNodeId: string,
): PinRestorePlan | null {
  const held = registry.shardTable.get(pinnedShardId);
  if (!held || held.nodeId === masterNodeId) return null;
  const holder = registry.nodes.get(held.nodeId);
  if (!holder || !holder.connected) return null; // frozen holder: Wait/Declare Lost, not Swap
  const master = registry.nodes.get(masterNodeId);
  if (!master) return null;

  const legs: PinRestoreLeg[] = [{ shardId: pinnedShardId, fromNodeId: held.nodeId, toNodeId: masterNodeId }];

  const masterCapacity = Math.max(1, master.capabilities?.shardCapacity ?? 1);
  const masterHeld = registry.shardIdsOf(masterNodeId).length;
  // After receiving the pinned shard the master would hold masterHeld + 1.
  if (masterHeld + 1 <= masterCapacity) {
    return { proposedLegs: legs };
  }

  // Master is at capacity: displace its lowest-guild-count shard.
  const guildsOnShard = (shardId: number): number =>
    registry.shardGuildTotals.get(shardId) ?? 0;
  const masterShards = registry.shardIdsOf(masterNodeId)
    .filter(s => s !== pinnedShardId)
    .sort((a, b) => guildsOnShard(a) - guildsOnShard(b));
  const displaced = masterShards[0];
  if (displaced === undefined) return { proposedLegs: null, reason: 'no-capacity' };

  // Prefer the pinned shard's current holder if it will have capacity after
  // giving up the pinned shard; else any connected node with free capacity.
  const holderCapacity = Math.max(1, holder.capabilities?.shardCapacity ?? 1);
  const holderHeldAfter = registry.shardIdsOf(held.nodeId).length - 1; // it releases the pinned shard
  let target: string | null = holderHeldAfter < holderCapacity ? held.nodeId : null;
  if (!target) {
    for (const node of registry.nodes.values()) {
      if (node.nodeId === masterNodeId || node.nodeId === held.nodeId) continue;
      if (!node.connected || node.draining) continue;
      const cap = Math.max(1, node.capabilities?.shardCapacity ?? 1);
      if (registry.shardIdsOf(node.nodeId).length < cap) { target = node.nodeId; break; }
    }
  }
  if (!target) return { proposedLegs: null, reason: 'no-capacity' };
  legs.push({ shardId: displaced, fromNodeId: masterNodeId, toNodeId: target });
  return { proposedLegs: legs };
}

/**
 * Serialize identifies across the nodes being granted in one plan round:
 * every shard in the same rate-limit bucket gets a slot IDENTIFY_SPACING_MS
 * after the previous one. Delays are honored by receivers relative to grant
 * receipt, never as absolute timestamps.
 */
export function assignIdentifyDelays(
  assignments: Map<string, number[]>,
  maxConcurrency: number,
  reuseLeaseIds?: Map<number, string>,
): Map<string, LeaseInfo[]> {
  const perBucketSlot = new Map<number, number>();
  const result = new Map<string, LeaseInfo[]>();
  for (const [nodeId, shardIds] of assignments) {
    const leases: LeaseInfo[] = [];
    for (const shardId of shardIds) {
      const bucket = shardId % Math.max(1, maxConcurrency);
      const slot = perBucketSlot.get(bucket) ?? 0;
      perBucketSlot.set(bucket, slot + 1);
      leases.push({
        leaseId: reuseLeaseIds?.get(shardId) ?? randomUUID(),
        shardId,
        identifyDelayMs: slot * IDENTIFY_SPACING_MS,
      });
    }
    result.set(nodeId, leases);
  }
  return result;
}
