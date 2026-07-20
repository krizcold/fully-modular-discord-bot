// IngestService wraps Client construction and gateway login. {shards,
// shardCount} arrive as a LEASE from the control plane; login only ever
// happens through LeaseRuntime, which owns the no-identify-without-a-
// current-term-lease invariant. The Client instance is created exactly once
// per process (modules, panels and handlers hold references to it); lease
// changes bounce its gateway sessions, never the object.

import { Client, ClientOptions } from 'discord.js';

export class IngestService {
  private client: Client | null = null;
  private started = false;
  private shardPlan: { shards: number[]; shardCount: number } | null = null;

  buildClient(options: ClientOptions): Client {
    if (this.client) throw new Error('[Ingest] buildClient() called twice');
    const opts: ClientOptions = { ...options };
    const plan = this.shardPlan;
    // {shards:[0], shardCount:1} is exactly discord.js's default (verified in
    // @discordjs/ws getShardIds); omitting the options keeps the standalone
    // Client byte-identical to the pre-fleet construction.
    if (plan && !(plan.shardCount === 1 && plan.shards.length === 1 && plan.shards[0] === 0)) {
      (opts as any).shards = plan.shards;
      (opts as any).shardCount = plan.shardCount;
    }
    this.client = new Client(opts);
    return this.client;
  }

  setShardPlan(shards: number[], shardCount: number): void {
    this.shardPlan = { shards: [...shards].sort((a, b) => a - b), shardCount };
    if (this.client) {
      (this.client.options as any).shards = this.shardPlan.shards;
      (this.client.options as any).shardCount = shardCount;
    }
  }

  getShardPlan(): { shards: number[]; shardCount: number } | null {
    return this.shardPlan;
  }

  getClient(): Client | null {
    return this.client;
  }

  isStarted(): boolean {
    return this.started;
  }

  /** Only LeaseRuntime may call this; the lease gate and identify pacing live there. */
  start(token: string | undefined): Promise<string> {
    if (!this.client) return Promise.reject(new Error('[Ingest] start() before buildClient()'));
    this.started = true;
    return this.client.login(token);
  }

  /** Destroys all gateway sessions and leaves the Client re-loginable for a future grant. */
  async stop(reason: string): Promise<void> {
    if (!this.client || !this.started) {
      this.started = false;
      return;
    }
    this.started = false;
    console.log(`[Ingest] Destroying gateway sessions (${reason})`);
    try {
      await this.client.destroy();
    } catch (error) {
      console.error('[Ingest] Error destroying client:', error);
    }
    // client.destroy() latches ws.destroyed and keeps the internal
    // @discordjs/ws manager that was built with the old shard set; a shard
    // set frozen at first login would defeat lease moves, and a latched
    // destroyed flag would no-op the NEXT destroy (breaking revoke fencing).
    // Reset both so a future grant re-logins this same Client instance with
    // fresh shard options.
    const ws = this.client.ws as any;
    ws.destroyed = false;
    ws._ws = null;
    ws.status = 0;
    try { ws.shards.clear(); } catch { /* collection always present in v14 */ }
  }
}

let instance: IngestService | null = null;

export function getIngestService(): IngestService {
  if (!instance) instance = new IngestService();
  return instance;
}
