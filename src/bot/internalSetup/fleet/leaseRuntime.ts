// LeaseRuntime - holds this process's shard leases and enforces the one
// invariant that keeps a shared token safe: NO IDENTIFY WITHOUT A CURRENT
// LEASE.

import { Status } from 'discord.js';
import { getDataReadiness } from '../utils/dataBackends/dataReadiness';
import { getNodeId } from './nodeIdentity';
import type { IngestService } from '../ingest/ingestService';

export interface LeaseInfo {
  leaseId: string;
  shardId: number;
}

export interface LeaseGrant {
  claim: number | null;
  shardCount: number;
  leases: LeaseInfo[];
}

export interface ShardStatusEntry {
  shardId: number;
  status: string;
  guildCount: number;
}

export interface CurrentLease {
  claim: number | null;
  shardCount: number;
  leases: LeaseInfo[];
}

// discord.js cannot hot-change a Client's shard set, so a plan change means a
// destroy + re-login. Coalesce rapid changes into ONE rebuild, and never
// rebuild in the caller's await path (client.destroy() stalls while a shard is
// mid-connect, which would leave the gateway thrashing).
const GATEWAY_SYNC_DEBOUNCE_MS = 1500;

export class LeaseRuntime {
  private current: CurrentLease | null = null;
  private token: string | undefined;
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(private readonly ingest: IngestService) {}

  getCurrent(): CurrentLease | null {
    return this.current;
  }

  /** Called once with the login token; starts (or arms) the gated login. */
  setToken(token: string | undefined): void {
    this.token = token;
    this.maybeStart();
  }

  async applyGrant(grant: LeaseGrant): Promise<void> {
    const shardIds = grant.leases.map(l => l.shardId).sort((a, b) => a - b);
    const sameShape =
      this.current !== null &&
      this.current.shardCount === grant.shardCount &&
      sameNumberSet(this.current.leases.map(l => l.shardId), shardIds);

    this.current = { claim: grant.claim, shardCount: grant.shardCount, leases: grant.leases };
    this.ingest.setShardPlan(shardIds, grant.shardCount);
    this.notifyDataLayer(this.current);
    if (!sameShape && this.ingest.isStarted()) {
      // A gateway is already running the old set: coalesce into one rebuild.
      this.scheduleGatewaySync();
    } else {
      this.maybeStart();
    }
  }

  /** Debounced destroy + re-login so rapid plan changes rebuild the gateway once. */
  private scheduleGatewaySync(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.syncGateway();
    }, GATEWAY_SYNC_DEBOUNCE_MS);
  }

  private async syncGateway(): Promise<void> {
    await this.ingest.stop('lease changed');
    this.maybeStart();
  }

  /** Mirror the held lease into the data layer (constructed only in postgres mode). */
  private notifyDataLayer(current: CurrentLease): void {
    getDataReadiness()?.onLeaseChanged({
      nodeId: getNodeId(),
      claim: current.claim,
      shardCount: current.shardCount,
      shardIds: current.leases.map(l => l.shardId),
    });
  }

  /** Gateway status and guild count of every held shard. */
  shardStatuses(): ShardStatusEntry[] {
    const client = this.ingest.getClient();
    const shards: ShardStatusEntry[] = [];
    if (this.current) {
      const counts = new Map<number, number>();
      if (client) {
        for (const guild of client.guilds.cache.values()) {
          counts.set(guild.shardId, (counts.get(guild.shardId) ?? 0) + 1);
        }
      }
      for (const lease of this.current.leases) {
        const shard = client?.ws.shards.get(lease.shardId);
        shards.push({
          shardId: lease.shardId,
          status: shard ? Status[shard.status] ?? String(shard.status) : 'NotStarted',
          guildCount: counts.get(lease.shardId) ?? 0,
        });
      }
    }
    return shards;
  }

  /** Gated login; @discordjs/ws spaces the identifies of this process's shards per bucket. */
  private maybeStart(): void {
    if (!this.current || this.token === undefined || this.ingest.isStarted()) return;
    // Login failures are deliberately NOT swallowed: an invalid token must
    // surface exactly like today's boot (unhandled rejection -> crash).
    void this.ingest.start(this.token);
  }
}

function sameNumberSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedB = [...b].sort((x, y) => x - y);
  return sortedA.every((value, index) => value === sortedB[index]);
}
