// Placement helpers: shard-count resolution, this-node capacity, the guild ->
// shard formula and identify pacing. The master claims up to ITS capacity and
// only ever grants FREE shards to workers; owned shards move exclusively via
// migration (bootstrap owns the distribution loop).

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

function httpsGetJson(path: string, token: string): Promise<any | null> {
  return new Promise(resolve => {
    const req = https.get(
      `https://discord.com/api/v10${path}`,
      { headers: { authorization: `Bot ${token}` }, timeout: GATEWAY_INFO_TIMEOUT_MS },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try { resolve(res.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve(null); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
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
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
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
