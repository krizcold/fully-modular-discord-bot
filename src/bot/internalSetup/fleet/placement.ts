// Placement helpers: shard-count resolution and the lease list.

import * as https from 'https';
import { randomUUID } from 'crypto';
import { GATEWAY_INFO_TIMEOUT_MS } from './constants';
import type { LeaseInfo } from './leaseRuntime';

export interface SessionStartLimit {
  total: number;
  remaining: number;
  resetAfterMs: number;
}

export interface GatewayInfo {
  recommendedShards: number;
  sessionStartLimit: SessionStartLimit | null;
}

/** GET /gateway/bot for the recommended shard count and identify budget; error is null exactly when info is set. */
export function fetchGatewayInfoResult(token: string | undefined): Promise<{ info: GatewayInfo | null; error: string | null }> {
  if (!token || token.trim() === '') return Promise.resolve({ info: null, error: 'no bot token is set' });
  return new Promise(outcome => {
    const resolve = (info: GatewayInfo | null, error?: string) => outcome({ info, error: info ? null : (error ?? 'unknown failure') });
    const req = https.get(
      'https://discord.com/api/v10/gateway/bot',
      { headers: { authorization: `Bot ${token}` }, timeout: GATEWAY_INFO_TIMEOUT_MS },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) return resolve(null, `HTTP ${res.statusCode}`);
            const parsed = JSON.parse(body);
            const ssl = parsed?.session_start_limit;
            resolve({
              recommendedShards: Number(parsed.shards) || 1,
              sessionStartLimit: ssl && Number.isFinite(Number(ssl.total))
                ? {
                    total: Number(ssl.total),
                    remaining: Number(ssl.remaining) || 0,
                    resetAfterMs: Number(ssl.reset_after) || 0,
                  }
                : null,
            });
          } catch {
            resolve(null, 'the reply was not valid JSON');
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null, `no reply within ${GATEWAY_INFO_TIMEOUT_MS}ms`); });
    req.on('error', (error: Error) => resolve(null, error.message));
  });
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

export type ShardSource = 'override' | 'discord' | 'fallback';

/** What decided the running shard count: the FLEET_SHARD_COUNT override, Discord's recommendation, or the 1-shard fallback when /gateway/bot failed. */
export function decideShardSource(gatewayAnswered: boolean): ShardSource {
  if (getShardCountOverride() !== null) return 'override';
  return gatewayAnswered ? 'discord' : 'fallback';
}

/** One lease per shard this process runs. */
export function leasesFor(shardIds: number[]): LeaseInfo[] {
  return shardIds.map(shardId => ({ leaseId: randomUUID(), shardId }));
}
