// LeaseRuntime - holds this node's shard leases and enforces the one
// invariant that keeps a shared token safe: NO IDENTIFY WITHOUT A
// CURRENT-TERM LEASE. The master's self-granted leases run through the same
// runtime as a co-worker's remote grants.

import { monitorEventLoopDelay, IntervalHistogram } from 'perf_hooks';
import { Status } from 'discord.js';
import type { Client } from 'discord.js';
import { getMetricsCollector } from '../utils/metrics/metricsCollector';
import type { IngestService } from '../ingest/ingestService';
import type {
  HeartbeatPayload,
  LeaseAckPayload,
  LeaseGrantPayload,
  LeaseInfo,
  LoadSample,
  ShardStatusEntry,
} from './protocol';

export interface CurrentLease {
  term: number;
  epoch: number;
  shardCount: number;
  leases: LeaseInfo[];
  receivedAt: number;
}

export class LeaseRuntime {
  private current: CurrentLease | null = null;
  private token: string | undefined;
  private startTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  private lastHeartbeat: HeartbeatPayload | null = null;
  private histogram: IntervalHistogram | null = null;
  private lastCpu: NodeJS.CpuUsage | null = null;
  private lastHr: bigint | null = null;

  constructor(private readonly ingest: IngestService) {}

  hasCurrentLease(): boolean {
    return this.current !== null;
  }

  getCurrent(): CurrentLease | null {
    return this.current;
  }

  getLastHeartbeat(): HeartbeatPayload | null {
    return this.lastHeartbeat;
  }

  /** Called once with the login token; starts (or arms) the gated login. */
  setToken(token: string | undefined): void {
    this.token = token;
    this.maybeStart();
  }

  async applyGrant(grant: LeaseGrantPayload): Promise<LeaseAckPayload> {
    // Term fencing: a lower-term grant is a deposed master talking.
    if (this.current && grant.term < this.current.term) {
      return { ok: false, term: this.current.term, reason: 'stale-term' };
    }
    const shardIds = grant.leases.map(l => l.shardId).sort((a, b) => a - b);
    const sameShape =
      this.current !== null &&
      this.current.shardCount === grant.shardCount &&
      sameNumberSet(this.current.leases.map(l => l.shardId), shardIds);

    if (sameShape) {
      // Same shard set under an equal-or-higher term: a re-grant is a
      // permission refresh (master restart, epoch bump), not an order to
      // re-identify. Adopt without bouncing live sessions.
      this.current = { term: grant.term, epoch: grant.epoch, shardCount: grant.shardCount, leases: grant.leases, receivedAt: Date.now() };
      this.ingest.setShardPlan(shardIds, grant.shardCount);
      this.maybeStart();
      return { ok: true, term: grant.term };
    }

    // Shard set changed: destroy old sessions BEFORE adopting so a lease move
    // can never leave two holders identified for the same shard.
    await this.stopSessions('lease changed');
    this.current = { term: grant.term, epoch: grant.epoch, shardCount: grant.shardCount, leases: grant.leases, receivedAt: Date.now() };
    this.ingest.setShardPlan(shardIds, grant.shardCount);
    this.maybeStart();
    return { ok: true, term: grant.term };
  }

  /** Sessions are destroyed FIRST: an acked revoke means the token is free to re-grant. */
  async revoke(term: number, leaseIds: string[], reason: string): Promise<LeaseAckPayload> {
    if (!this.current) return { ok: true, term };
    if (term < this.current.term) {
      return { ok: false, term: this.current.term, reason: 'stale-term' };
    }
    const held = new Set(this.current.leases.map(l => l.leaseId));
    const revoked = leaseIds.filter(id => held.has(id));
    if (revoked.length === 0) return { ok: true, term: this.current.term };

    const remaining = this.current.leases.filter(l => !leaseIds.includes(l.leaseId));
    await this.stopSessions(`revoked: ${reason}`);
    if (remaining.length === 0) {
      this.current = null;
    } else {
      this.current = { ...this.current, term, leases: remaining, receivedAt: Date.now() };
      this.ingest.setShardPlan(remaining.map(l => l.shardId), this.current.shardCount);
      this.maybeStart();
    }
    return { ok: true, term };
  }

  /** TTL expiry (no master contact): drop the lease and destroy sessions. */
  async expire(reason: string): Promise<void> {
    if (!this.current) return;
    console.warn(`[Fleet] Lease expired (${reason}); destroying gateway sessions`);
    this.current = null;
    await this.stopSessions('lease expired');
  }

  /**
   * Watchdog: discord.js auto re-identifies after session invalidation (op 9
   * with d=false destroys with recover=Reconnect in @discordjs/ws). While a
   * current-term lease is held that is fine; without one it must be killed
   * actively rather than trusted not to reconnect.
   */
  attachClient(client: Client): void {
    const guard = (what: string) => {
      if (this.hasCurrentLease()) return;
      console.warn(`[Fleet] ${what} without a current-term lease; destroying sessions (fencing)`);
      void this.ingest.stop('no current-term lease');
    };
    client.on('shardReconnecting', () => guard('Shard reconnect attempt'));
    client.on('shardReady', () => guard('Shard became ready'));
  }

  buildHeartbeat(term: number): HeartbeatPayload {
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
    let metrics: { totals: any; topKGuilds: any[] } = { totals: null, topKGuilds: [] };
    try {
      metrics = getMetricsCollector().getHeartbeatSnapshot();
    } catch { /* metrics must never take the control channel down */ }
    const hb: HeartbeatPayload = {
      term,
      seq: ++this.seq,
      shards,
      guilds: client ? [...client.guilds.cache.keys()] : [],
      metrics,
      load: this.sampleLoad(),
    };
    this.lastHeartbeat = hb;
    return hb;
  }

  private async stopSessions(reason: string): Promise<void> {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    await this.ingest.stop(reason);
  }

  /**
   * Gated login. Identify pacing: the master serialized this node's slot via
   * identifyDelayMs; the wait is relative to grant receipt (clock-skew rule).
   * Within one Client, @discordjs/ws spaces the node's own shards per bucket.
   */
  private maybeStart(): void {
    if (!this.current || this.token === undefined || this.ingest.isStarted() || this.startTimer) return;
    const minDelay = Math.min(...this.current.leases.map(l => l.identifyDelayMs), 0x7fffffff);
    const remaining = this.current.receivedAt + (Number.isFinite(minDelay) ? minDelay : 0) - Date.now();
    if (remaining <= 0) {
      // Login failures are deliberately NOT swallowed: an invalid token must
      // surface exactly like today's boot (unhandled rejection -> crash).
      void this.ingest.start(this.token);
      return;
    }
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (!this.current || this.token === undefined || this.ingest.isStarted()) return;
      void this.ingest.start(this.token);
    }, remaining);
  }

  private sampleLoad(): LoadSample {
    const rssMb = Math.round((process.memoryUsage().rss / 1048576) * 10) / 10;
    if (!this.histogram) {
      this.histogram = monitorEventLoopDelay({ resolution: 20 });
      this.histogram.enable();
      this.lastCpu = process.cpuUsage();
      this.lastHr = process.hrtime.bigint();
      return { cpuPct: 0, rssMb, loopLagMs: 0 };
    }
    const cpu = process.cpuUsage(this.lastCpu!);
    this.lastCpu = process.cpuUsage();
    const now = process.hrtime.bigint();
    const elapsedMicros = Number((now - this.lastHr!) / 1000n);
    this.lastHr = now;
    const cpuPct = elapsedMicros > 0 ? Math.round(((cpu.user + cpu.system) / elapsedMicros) * 10000) / 100 : 0;
    const p95 = this.histogram.percentile(95);
    this.histogram.reset();
    return {
      cpuPct,
      rssMb,
      loopLagMs: Number.isFinite(p95) ? Math.round((p95 / 1e6) * 100) / 100 : 0,
    };
  }
}

function sameNumberSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedB = [...b].sort((x, y) => x - y);
  return sortedA.every((value, index) => value === sortedB[index]);
}
