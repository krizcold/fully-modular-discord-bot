// LeaseRuntime - holds this process's shard leases and enforces the one
// invariant that keeps a shared token safe: NO IDENTIFY WITHOUT A CURRENT
// LEASE. A process grants its set once at boot (NB4 decision 7) and once more
// with no lease when it stops serving.

import { Status } from 'discord.js';
import { getDataReadiness } from '../utils/dataBackends/dataReadiness';
import { stoppedServing } from '../utils/servingGate';
import { isStopping } from '../utils/dataManager';
import { getNodeId } from './nodeIdentity';
import type { IngestService } from '../ingest/ingestService';

export interface LeaseInfo {
  leaseId: string;
  shardId: number;
  /** The claim this process holds on the shard; null on a JSON bot. */
  claim: number | null;
}

export interface LeaseGrant {
  /** This boot's process id; null on a JSON bot. */
  processId: string | null;
  shardCount: number;
  leases: LeaseInfo[];
}

export interface ShardStatusEntry {
  shardId: number;
  status: string;
  guildCount: number;
}

export interface CurrentLease {
  processId: string | null;
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
  private stillConnected: number[] = [];

  constructor(private readonly ingest: IngestService) {}

  getCurrent(): CurrentLease | null {
    return this.current;
  }

  /** Shards whose gateway stop did not settle within its bound after the process stopped serving. */
  getStillConnected(): number[] {
    return [...this.stillConnected];
  }

  /** Called once with the login token; starts (or arms) the gated login. */
  setToken(token: string | undefined): void {
    this.token = token;
    this.maybeStart();
  }

  /**
   * NB9 7 and 27: a standby logs its shards in before it serves, with no data grant (the data layer is not told). The
   * serve's applyGrant with the same shard set and count then keeps these sessions (29).
   */
  startStandby(grant: LeaseGrant, token: string | undefined): void {
    this.current = { processId: grant.processId, shardCount: grant.shardCount, leases: grant.leases };
    this.token = token;
    this.ingest.setShardPlan(grant.leases.map(l => l.shardId).sort((a, b) => a - b), grant.shardCount);
    if (grant.leases.length === 0 || this.ingest.isStarted() || isStopping()) return;
    void this.ingest.start(token);
  }

  async applyGrant(grant: LeaseGrant): Promise<void> {
    const shardIds = grant.leases.map(l => l.shardId).sort((a, b) => a - b);
    const sameShape =
      this.current !== null &&
      this.current.shardCount === grant.shardCount &&
      sameNumberSet(this.current.leases.map(l => l.shardId), shardIds);

    this.current = { processId: grant.processId, shardCount: grant.shardCount, leases: grant.leases };
    this.ingest.setShardPlan(shardIds, grant.shardCount);
    this.notifyDataLayer(this.current);
    if (!sameShape && this.ingest.isStarted()) {
      // A gateway is already running the old set: coalesce into one rebuild.
      this.scheduleGatewaySync();
    } else {
      this.maybeStart();
    }
  }

  /**
   * NB4 decision 16: the lease empties and the gateway stops at once, with no debounce; a stop that does not settle
   * within boundMs leaves its shards reported as maybe still connected.
   */
  stopServing(boundMs: number): void {
    const held = this.current?.leases.map(l => l.shardId) ?? [];
    const shardCount = this.current?.shardCount ?? 0;
    if (this.syncTimer) { clearTimeout(this.syncTimer); this.syncTimer = null; }
    this.current = { processId: this.current?.processId ?? null, shardCount, leases: [] };
    this.ingest.setShardPlan([], shardCount);
    this.notifyDataLayer(this.current);
    if (!this.ingest.isStarted()) return;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      this.stillConnected = held;
      for (const shardId of held) console.error(`[Shards] Shard ${shardId} may still be connected to Discord`);
    }, boundMs);
    timer.unref?.();
    void this.ingest.stop('this process stopped serving its shards').catch(error => console.error('[Shards] Could not stop the gateway:', error)).finally(() => {
      settled = true;
      clearTimeout(timer);
      this.stillConnected = [];
    });
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
    const claims: Record<number, number | null> = {};
    for (const lease of current.leases) claims[lease.shardId] = lease.claim;
    getDataReadiness()?.onLeaseChanged({
      nodeId: getNodeId(),
      processId: current.processId,
      claims,
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

  /** Gated login; @discordjs/ws spaces the identifies of this process's shards per bucket. No lease, no login. */
  private maybeStart(): void {
    if (!this.current || this.current.leases.length === 0 || this.token === undefined || this.ingest.isStarted()) return;
    if (stoppedServing() || isStopping()) return;
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
