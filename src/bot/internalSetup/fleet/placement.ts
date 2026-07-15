// PlacementEngine v1: decides the shard count and which node holds which
// shard lease. Standalone is the same code path with a single node that
// receives every lease.

import * as https from 'https';
import { randomUUID } from 'crypto';
import { GATEWAY_INFO_TIMEOUT_MS, IDENTIFY_SPACING_MS } from './constants';
import type { LeaseInfo } from './protocol';

export interface GatewayInfo {
  recommendedShards: number;
  maxConcurrency: number;
}

/** GET /gateway/bot for the recommended shard count and identify concurrency. Null on any failure. */
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
            resolve({
              recommendedShards: Number(parsed.shards) || 1,
              maxConcurrency: Number(parsed?.session_start_limit?.max_concurrency) || 1,
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

/** Discord's fixed guild -> shard formula. */
export function guildIdToShardId(guildId: string, shardCount: number): number {
  try {
    return Number((BigInt(guildId) >> 22n) % BigInt(Math.max(1, shardCount)));
  } catch {
    return 0;
  }
}

export function resolveShardCount(opts: { standalone: boolean; recommended: number; selfCapacity: number }): number {
  const override = Number(process.env.FLEET_SHARD_COUNT);
  if (Number.isInteger(override) && override > 0) return override;
  if (opts.standalone) return Math.max(1, opts.recommended);
  // Over-shard early: more, smaller bundles keep later rebalancing fine-grained.
  return Math.max(1, opts.recommended, opts.selfCapacity * 2);
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

export interface PlacementNode {
  nodeId: string;
  capacity: number;
  isMaster: boolean;
}

/**
 * Spread shards across nodes proportional to declared capacity, master first,
 * contiguous-ish ranges, deterministic for a given node set. The pinned shard
 * always lands on the master. shardPool restricts which shards are plannable
 * (shards leased to disconnected nodes stay frozen in Wait mode).
 */
export function planAssignments(opts: {
  shardCount: number;
  shardPool?: number[];
  nodes: PlacementNode[];
  pinnedShardId: number | null;
}): Map<string, number[]> {
  const { shardCount, pinnedShardId } = opts;
  const pool = (opts.shardPool ?? Array.from({ length: shardCount }, (_, i) => i))
    .filter(id => id >= 0 && id < shardCount)
    .sort((a, b) => a - b);
  const ordered = [...opts.nodes].sort((a, b) =>
    a.isMaster === b.isMaster ? a.nodeId.localeCompare(b.nodeId) : a.isMaster ? -1 : 1,
  );
  const result = new Map<string, number[]>(ordered.map(n => [n.nodeId, []]));
  if (ordered.length === 0 || pool.length === 0) return result;

  const totalCapacity = ordered.reduce((sum, n) => sum + Math.max(1, n.capacity), 0);
  const targets = new Map<string, number>();
  let assigned = 0;
  for (const node of ordered) {
    const share = Math.floor((pool.length * Math.max(1, node.capacity)) / totalCapacity);
    targets.set(node.nodeId, share);
    assigned += share;
  }
  for (let i = 0; assigned < pool.length; i = (i + 1) % ordered.length) {
    targets.set(ordered[i].nodeId, (targets.get(ordered[i].nodeId) ?? 0) + 1);
    assigned++;
  }

  const master = ordered.find(n => n.isMaster) ?? ordered[0];
  const pinned = pinnedShardId !== null && pool.includes(pinnedShardId) ? pinnedShardId : null;
  if (pinned !== null) {
    result.get(master.nodeId)!.push(pinned);
    if ((targets.get(master.nodeId) ?? 0) < 1) targets.set(master.nodeId, 1);
  }

  const remaining: number[] = pool.filter(shardId => shardId !== pinned);
  for (const node of ordered) {
    const bucket = result.get(node.nodeId)!;
    while (bucket.length < (targets.get(node.nodeId) ?? 0) && remaining.length > 0) {
      bucket.push(remaining.shift()!);
    }
  }
  // Rounding leftovers (pin can consume a slot): master absorbs them.
  while (remaining.length > 0) result.get(master.nodeId)!.push(remaining.shift()!);
  for (const bucket of result.values()) bucket.sort((a, b) => a - b);
  return result;
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
