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
  private generation = 0;
  private stopping: Promise<void> | null = null;
  private starting: Promise<string> | null = null;
  private unwinding: Promise<unknown> | null = null;
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
  async start(token: string | undefined): Promise<string> {
    if (!this.client) throw new Error('[Ingest] start() before buildClient()');
    // One login at a time: a second grant while a live start is parked below
    // joins it instead of identifying the same shards twice. A start whose
    // login a stop cancelled is superseded, never joined: its promise may
    // never settle (see destroySessions).
    if (this.starting && this.started) return this.starting;
    this.started = true;
    const generation = ++this.generation;
    const run = (async (): Promise<string> => {
      // A stop still tearing the previous sessions down resets the ws
      // manager when it finishes; a login begun under it would resume into
      // that reset. A stop that lands while parked here cancels this login.
      while (this.stopping) await this.stopping;
      const unwinding = this.unwinding;
      if (unwinding) {
        await unwinding.catch(() => undefined);
        if (this.unwinding === unwinding) this.unwinding = null;
      }
      if (!this.started || generation !== this.generation) {
        console.warn('[Ingest] Login abandoned by a stop before it connected');
        return '';
      }
      try {
        return await this.client!.login(token);
      } catch (error) {
        // A stop() while this connect was in flight nulled the ws manager
        // the connect resumed into (WebSocketManager.connect reads this._ws
        // after its awaits): that rejection is this node's own destroy, not
        // a login failure. Client.login destroys the client again on the way
        // out, so the reset is repeated here. A failure on a login nobody
        // stopped still surfaces unhandled, exactly like today's boot.
        if (!this.started || generation !== this.generation) {
          if ((this.client!.ws as any)._ws) {
            console.error('[Ingest] A stopped login failed after a newer login had begun; discord.js destroyed the shared client under it');
            throw error;
          }
          this.resetGateway();
          console.warn(`[Ingest] Login abandoned by a stop mid-connect: ${error instanceof Error ? error.message : String(error)}`);
          return '';
        }
        throw error;
      }
    })();
    this.starting = run;
    try {
      return await run;
    } finally {
      if (this.starting === run) this.starting = null;
    }
  }

  /** Destroys all gateway sessions and leaves the Client re-loginable for a future grant. */
  async stop(reason: string): Promise<void> {
    // An earlier stop still tearing down is this stop's work too: a revoke
    // acknowledged before it finishes would free shards still connected.
    while (this.stopping) await this.stopping;
    if (!this.client || !this.started) {
      this.started = false;
      return;
    }
    this.started = false;
    const run = this.destroySessions(reason);
    this.stopping = run;
    try {
      await run;
    } finally {
      if (this.stopping === run) this.stopping = null;
    }
  }

  private async destroySessions(reason: string): Promise<void> {
    console.log(`[Ingest] Destroying gateway sessions (${reason})`);
    // A login still fetching the gateway information (no shard wrappers yet)
    // reads the ws manager when the fetch returns and would connect through
    // the manager the next login creates: that login waits for it to fail on
    // the reset below. A login caught mid-identify never settles (the shard's
    // connect awaits a ready that its destroy never emits), so it is not
    // waited on; it stays parked on the old manager.
    const ws = this.client!.ws as any;
    if (this.starting && ws._ws && ws.shards.size === 0) this.unwinding = this.starting;
    try {
      await this.client!.destroy();
    } catch (error) {
      console.error('[Ingest] Error destroying client:', error);
    }
    this.resetGateway();
  }

  // client.destroy() latches ws.destroyed and keeps the internal
  // @discordjs/ws manager that was built with the old shard set; a shard
  // set frozen at first login would defeat lease moves, and a latched
  // destroyed flag would no-op the NEXT destroy (breaking revoke fencing).
  // Reset both so a future grant re-logins this same Client instance with
  // fresh shard options.
  private resetGateway(): void {
    const ws = this.client!.ws as any;
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
