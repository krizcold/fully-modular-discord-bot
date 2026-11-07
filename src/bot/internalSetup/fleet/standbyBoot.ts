// NB9 27 to 30, 42, 44, 45, 49, 54 and 61: the bot process forked for the new shards of a reshard (the standby). Before
// it serves it takes no lock, opens no data layer and writes no file: it takes rows of W on its own claims pool, logs
// them in, keeps them renewed with their readiness and polls the reshard row. It serves once the attempt is 'done'
// with meta W and the web UI promoted it (a JSON standby: once promoted), through runBot({ taken, client }).

import { Partials, type Client } from 'discord.js';
import { getIngestService } from '../ingest/ingestService';
import { addReleaseStep, addStopStep, beginStop, isStopping } from '../utils/dataManager';
import { canRestart } from '../utils/maintenance';
import { shardCapacity, takeoverSeconds } from '../../../utils/envLoader';
import { claimTimings, type ClaimTimings, type Pair } from './claimRules';
import { ClaimStore, type ClaimStoreApi } from './claimStore';
import { slotThrottlerBuilder, parentSlotAsker } from './identifySlots';
import { LeaseRuntime } from './leaseRuntime';
import { getNodeId, getNodeName } from './nodeIdentity';
import { fetchGatewayInfoResult, leasesFor, type GatewayInfo } from './placement';
import { processId } from './processId';
import { readyNewCount } from './reshardRules';
import { callOffReshard, readFacts } from './reshardStore';
import { getShardClaims, RESHARD_SERVE_WAIT_MS, type IdentifyReserve, type JsonTaken, type StandbyTaken } from './shardBoot';
import {
  l11Line, l12GoneLine, l12Line, l12ReplacedLine, l22Line, l22PromotedLine, retryTime, ShardClaims, type StandbyEnd,
} from './shardClaims';
import { writeShardRecord } from './shardRecord';

const HANDSHAKE_RESEND_MS = 5000;
const RESTART_RESEND_MS = 60_000;
const BUDGET_RETRY_MS = 30_000;
const GATEWAY_CLOSE_BOUND_MS = 2000;

/** Decision 42's phase of the one claims stop step. A normal process starts in 'serving'. */
export type ClaimsPhase = 'pre-serve' | 'serving' | 'released';

let phase: ClaimsPhase = 'serving';
/** The standby's pre-serve lanes, on the claims pool built from SMDB_RESHARD_DB. */
let preServe: ShardClaims | null = null;
let maintenanceAnswers = true;

export function claimsPhase(): ClaimsPhase {
  return phase;
}

/**
 * C3: the claims stop, registered once per phase with addReleaseStep. It runs the body of the current phase only when
 * the phase equals `at`, and returns at once otherwise and in 'released'.
 */
export async function claimsStop(at: 'pre-serve' | 'serving'): Promise<void> {
  if (phase !== at) return;
  if (at === 'serving') {
    await getShardClaims()?.finishStop();
    return;
  }
  await releasePreServe();
}

async function releasePreServe(): Promise<void> {
  const lanes = preServe;
  if (!lanes) return;
  lanes.beginStop();
  await lanes.finishStop();
}

/** D3: the standby listener stops answering 'maintenance:enter' and 'maintenance:leave'; its other types stay. */
export function endStandbyMaintenanceAnswers(): void {
  maintenanceAnswers = false;
}

/** Tests start each case from a fresh process. */
export function _resetStandbyBoot(): void {
  phase = 'serving';
  preServe = null;
  maintenanceAnswers = true;
}

/** What `runBot` takes on the serve path (decision 28). */
export interface RunBotOptions {
  taken?: StandbyTaken | JsonTaken;
  /** The Client the standby built and logged in; absent when it took no row (44). */
  client?: Client;
  /** 28's maintenance row: the gateway closed, the shard record written under W, the pre-serve release (42). */
  releaseInjected?: () => Promise<void>;
}

export interface StandbyChannel {
  send?: (message: unknown) => boolean;
  on(event: 'message' | 'disconnect', fn: (...args: any[]) => void): unknown;
  off(event: 'message' | 'disconnect', fn: (...args: any[]) => void): unknown;
}

export interface StandbyDeps {
  env?: Record<string, string | undefined>;
  storeFactory?: (entry: string, timings: ClaimTimings, onRefused: () => void) => ClaimStoreApi;
  /** The IPC channel to the web UI process; the process itself when it has one. */
  channel?: StandbyChannel | null;
  gateway?: (token: string | undefined) => Promise<{ info: GatewayInfo | null; error: string | null }>;
  /** NB10's lock take with its 'waiting' report and lines, run at serve. */
  takeLock?: () => Promise<void>;
  runBot?: (opts: RunBotOptions) => Promise<void>;
  /** The stop handler (NB10's one stop). */
  stop?: () => void;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/** NB9 L20: the merged intents hold bits the adopted Client did not log in with (28, D1). */
export function l20Line(names: string[]): string {
  return `[Shards] The modules ask for gateway intents ${names.join(', ')} that this process did not log in with; they apply at its next restart`;
}

/** NB9 L29 (54), logged after the answer `promoted: false`. */
export function l29Line(w: number, minutes: number): string {
  return `[Shards] The reshard to ${w} shards was done ${minutes} min ago, but this machine's old bot process has not stopped; this standby process stops`;
}

/** NB9 L31. */
export function l31Line(cause: string): string {
  return `[Shards] Standby: cannot read Discord's gateway login limit (${cause}); not connecting the new shards until it is read, trying again every 30 s`;
}

/** NB9 L11's budget reason (61, 64). */
export function budgetReason(remaining: number, resetAt: number, unconnected: number, w: number): string {
  return `Discord allows ${remaining} more gateway logins until ${retryTime(resetAt)}, and the new shards not connected yet (${unconnected}) plus one more full start (${w}) need ${unconnected + w}`;
}

const RESTART_RESEND_LINE = `[Maintenance] The bot process still runs ${RESTART_RESEND_MS / 1000} s after asking for its restart; asking again`;

/** A self-stop: the handshake's kind and reason, the line on `promoted: false`, the cause of L22's promoted form. */
interface SelfStop {
  kind: 'called-off' | 'failed';
  reason: string;
  line: string;
  cause: string;
  serveWait?: boolean;
}

export function standbyMain(deps: StandbyDeps = {}): Promise<void> {
  return new Standby(deps).run();
}

class Standby {
  private readonly env: Record<string, string | undefined>;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly channel: StandbyChannel | null;
  private readonly attempt: string;
  private readonly count: number;
  private readonly intents: number;
  private readonly entry: string | null;
  private readonly token: string | undefined;
  private readonly ingest = getIngestService();
  private claims: ShardClaims | null = null;
  private store: ClaimStoreApi | null = null;
  private pairs: Pair[] = [];
  /** C10: the pre-serve store's identify slot, then the serve store's from onServing. */
  private identifyReserve: IdentifyReserve | null = null;
  private client: Client | null = null;
  private runtime: LeaseRuntime | null = null;
  private done = false;
  private doneAt = 0;
  private promoted = false;
  private serving = false;
  private stopping: SelfStop | null = null;
  private answer: ((promoted: boolean) => void) | null = null;
  private serveWaitTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private readyShards = new Set<number>();
  private readySent = false;

  constructor(private readonly deps: StandbyDeps) {
    this.env = deps.env ?? process.env;
    this.log = deps.log ?? console;
    this.channel = deps.channel !== undefined ? deps.channel : (process.send ? process as unknown as StandbyChannel : null);
    this.attempt = this.env.SMDB_RESHARD_STANDBY ?? '';
    this.count = Number(this.env.SMDB_RESHARD_COUNT);
    this.intents = Number(this.env.SMDB_RESHARD_INTENTS) || 0;
    this.entry = (this.env.SMDB_RESHARD_DB ?? '').trim() || null;
    this.token = this.env.DISCORD_TOKEN;
  }

  private get json(): boolean {
    return this.entry === null;
  }

  private send(message: object): void {
    try { this.channel?.send?.(message); } catch { /* the parent is gone */ }
  }

  async run(): Promise<void> {
    phase = 'pre-serve';
    // 42: the gateway's stop step comes before the Client; it acts on a Client that exists by then.
    addStopStep(async () => {
      if (!this.ingest.getClient()) return;
      await Promise.race([
        this.ingest.close('shutting down').catch(error => this.log.warn('[Shards] Could not close the gateway on shutdown:', error)),
        sleep(GATEWAY_CLOSE_BOUND_MS),
      ]);
    });
    this.channel?.on('message', this.onMessage);
    this.channel?.on('disconnect', this.onDisconnect);
    if (this.json) {
      this.loginJson();
      return;
    }
    await this.runPostgres();
  }

  private async runPostgres(): Promise<void> {
    const timings = claimTimings(takeoverSeconds());
    const make = this.deps.storeFactory ?? ((entry, t, onRefused) => new ClaimStore(entry, t, onRefused));
    const store = make(this.entry!, timings, () => undefined);
    this.store = store;
    const claims = new ShardClaims({
      store,
      me: { processId: processId(), nodeId: getNodeId(), nodeName: getNodeName() },
      timings,
      capacity: shardCapacity(),
      takeoverSeconds: takeoverSeconds(),
      returns: false,
      restartable: canRestart(),
      startedAt: Date.now(),
      fitness: () => null,
      gateClosed: () => false,
      isStopping,
      stopServingStep: () => undefined,
      noteLapsed: () => undefined,
      noteLost: () => undefined,
      restartForShards: () => false,
      log: this.log,
      standby: {
        attempt: this.attempt,
        count: this.count,
        onEnd: end => this.onEnd(end),
        onDone: () => this.onDone(),
        onProgress: (held, ready) => this.send({ type: 'reshard:standby-progress', data: { attempt: this.attempt, held, ready } }),
      },
    });
    this.claims = claims;
    preServe = claims;
    addReleaseStep(() => claimsStop('pre-serve'));
    claims.start();
    if (!(await claims.firstRenewal())) return;
    const took = await claims.standbyTake();
    if (!took) return;
    this.pairs = took.pairs;
    // 44: with no row, no Client, no login and no budget check; the serve runs NB4's none-held boot.
    if (this.pairs.length === 0) return;
    if (!(await this.budgetAllows(store, timings))) return;
    const slots = store as ClaimStoreApi & { reserveIdentifySlot?: IdentifyReserve };
    if (slots.reserveIdentifySlot) this.identifyReserve = (bucket, holder, signal) => slots.reserveIdentifySlot!(bucket, holder, signal);
    this.ingest.setIdentifyThrottler(slotThrottlerBuilder(this.identifyReserve
      ? { mode: 'database', reserve: (bucket, signal) => this.identifyReserve!(bucket, processId(), signal), renewMs: timings.renewMs }
      : { mode: 'local', renewMs: timings.renewMs }));
    this.login(this.pairs.map(p => ({ shardId: p.shardId, claim: p.claim })), processId());
    const client = this.client!;
    client.on('shardReady', (shardId: number) => claims.setReady(shardId, true));
    client.on('shardResume', (shardId: number) => claims.setReady(shardId, true));
    client.on('shardDisconnect', (_event: unknown, shardId: number) => claims.setReady(shardId, false));
    client.on('shardReconnecting', (shardId: number) => claims.setReady(shardId, false));
  }

  private login(shards: Array<{ shardId: number; claim: number | null }>, holder: string | null): void {
    if (isStopping() || this.stopping) return;
    this.client = this.ingest.buildClient({ intents: this.intents, partials: [Partials.Message, Partials.Reaction, Partials.User] });
    this.runtime = new LeaseRuntime(this.ingest);
    this.runtime.startStandby({ processId: holder, shardCount: this.count, leases: leasesFor(shards) }, this.token);
  }

  /** Decision 15: a JSON standby logs in every shard of W with the web UI's slots and says when all are ready. */
  private loginJson(): void {
    this.ingest.setIdentifyThrottler(slotThrottlerBuilder(this.channel?.send
      ? { mode: 'parent', askParent: parentSlotAsker(this.channel as Parameters<typeof parentSlotAsker>[0]), renewMs: claimTimings(takeoverSeconds()).renewMs }
      : { mode: 'local', renewMs: claimTimings(takeoverSeconds()).renewMs }));
    this.login(Array.from({ length: this.count }, (_, shardId) => ({ shardId, claim: null })), null);
    const client = this.client;
    if (!client) return;
    const ready = (shardId: number, on: boolean) => {
      if (on) this.readyShards.add(shardId); else this.readyShards.delete(shardId);
      if (!this.readySent && this.readyShards.size === this.count) {
        this.readySent = true;
        this.send({ type: 'reshard:standby-ready', data: { attempt: this.attempt } });
      }
    };
    client.on('shardReady', (shardId: number) => ready(shardId, true));
    client.on('shardResume', (shardId: number) => ready(shardId, true));
    client.on('shardDisconnect', (_event: unknown, shardId: number) => ready(shardId, false));
    client.on('shardReconnecting', (shardId: number) => ready(shardId, false));
  }

  /**
   * 61: the ready rows of W on the claims pool, then /gateway/bot; a login only when Discord's remaining logins cover
   * every unconnected new shard plus one more full start. Short: the call-off (failures kept), L11 and the stop.
   */
  private async budgetAllows(store: ClaimStoreApi, timings: ClaimTimings): Promise<boolean> {
    const gateway = this.deps.gateway ?? fetchGatewayInfoResult;
    for (;;) {
      if (isStopping() || this.stopping) return false;
      let ready: number;
      try {
        ready = readyNewCount(await store.withWorkClient!('the login budget', client => readFacts(client)), this.count);
      } catch {
        await sleep(timings.renewMs);
        continue;
      }
      const { info, error } = await gateway(this.token);
      const limit = info?.sessionStartLimit ?? null;
      if (!limit) {
        this.log.warn(l31Line(error ?? 'the answer has no session_start_limit'));
        await sleep(BUDGET_RETRY_MS);
        continue;
      }
      const unconnected = this.count - ready;
      if (limit.remaining >= unconnected + this.count) return true;
      const reason = budgetReason(limit.remaining, Date.now() + limit.resetAfterMs, unconnected, this.count);
      try {
        const off = await store.withWorkClient!('the call-off', client => callOffReshard(client, this.attempt, { reason, countsFailure: false }));
        if (off.kind === 'called-off') this.log.warn(l11Line(off.toCount, off.reason, off.fromCount, off.retryNow ? null : off.retryAfterMs));
      } catch (error) {
        this.log.error('[Shards] Could not call the reshard off:', error instanceof Error ? error.message : error);
      }
      this.onEnd({ kind: 'called-off', reason });
      return false;
    }
  }

  private onDone(): void {
    if (this.done) return;
    this.done = true;
    this.doneAt = Date.now();
    if (this.promoted) {
      void this.serve();
      return;
    }
    this.serveWaitTimer = setTimeout(() => {
      this.serveWaitTimer = null;
      void this.selfStop({
        kind: 'failed', reason: 'the old bot process has not stopped', serveWait: true,
        line: l29Line(this.count, Math.round((Date.now() - this.doneAt) / 60_000)), cause: '',
      });
    }, RESHARD_SERVE_WAIT_MS);
    this.serveWaitTimer.unref?.();
  }

  /** L12 (E7, E8) and L22: the lanes reported the end; the web UI is asked before the stop. */
  private onEnd(end: StandbyEnd): void {
    const w = this.count;
    if (end.kind === 'failed') {
      void this.selfStop({ kind: 'failed', reason: end.cause, line: l22Line(end.cause), cause: end.cause });
      return;
    }
    if (end.reason !== null) {
      void this.selfStop({ kind: 'called-off', reason: end.reason, line: l12Line(w, end.reason), cause: `the reshard to ${w} shards was called off (${end.reason})` });
      return;
    }
    const line = end.replacedBy !== undefined ? l12ReplacedLine(w, end.replacedBy) : l12GoneLine(w);
    const reason = end.replacedBy !== undefined ? `a reshard to ${end.replacedBy} shards has started in its place` : 'the database no longer records it';
    void this.selfStop({ kind: 'called-off', reason, line, cause: `the reshard to ${w} shards has ended` });
  }

  /** Decision 30 with 49 and 54: the handshake, then the stop (false), or L22's promoted form and the restart ask (true). */
  private async selfStop(stop: SelfStop): Promise<void> {
    if (this.stopping || this.serving) return;
    this.stopping = stop;
    if (this.serveWaitTimer) { clearTimeout(this.serveWaitTimer); this.serveWaitTimer = null; }
    const promoted = await this.handshake(stop);
    if (!promoted) {
      this.log.warn(stop.line);
      this.stop();
      return;
    }
    // 54: promote() sent 'reshard:promoted' before this answer, so the process serves.
    if (stop.serveWait) return;
    this.askRestart(stop.cause);
  }

  private handshake(stop: SelfStop): Promise<boolean> {
    if (!this.channel?.send) return Promise.resolve(false);
    return new Promise(resolve => {
      const message = { type: 'reshard:standby-stopping', data: { attempt: this.attempt, reason: stop.reason, kind: stop.kind } };
      const resend = setInterval(() => this.send(message), HANDSHAKE_RESEND_MS);
      resend.unref?.();
      this.answer = promoted => {
        clearInterval(resend);
        this.answer = null;
        resolve(promoted);
      };
      this.send(message);
    });
  }

  /** L22's promoted form and 'control:restart-bot', re-sent every 60 s until the web UI stops this process. */
  private askRestart(cause: string): void {
    if (this.restartTimer) return;
    this.log.warn(l22PromotedLine(cause));
    const message = { type: 'control:restart-bot', data: { reason: cause } };
    this.send(message);
    this.restartTimer = setInterval(() => {
      this.log.warn(RESTART_RESEND_LINE);
      this.send(message);
    }, RESTART_RESEND_MS);
    this.restartTimer.unref?.();
  }

  private stop(): void {
    (this.deps.stop ?? (() => { void beginStop(); }))();
  }

  private readonly onDisconnect = (): void => {
    if (this.serving) return;
    this.stop();
  };

  private readonly onMessage = (message: unknown): void => {
    if (!message || typeof message !== 'object') return;
    const { type, requestId, data } = message as { type?: unknown; requestId?: unknown; data?: any };
    if (type === 'reshard:promoted') {
      this.promoted = true;
      if (this.json || this.done) void this.serve();
      return;
    }
    if (type === 'reshard:standby-stop-answer') {
      this.answer?.(data?.promoted === true);
      return;
    }
    if (!maintenanceAnswers || typeof requestId !== 'string' || !requestId) return;
    if (type === 'maintenance:enter') {
      // It holds no change: no grant and no write (27).
      this.send({ requestId, data: { saved: true } });
      return;
    }
    if (type === 'maintenance:leave') {
      this.send({ requestId, data: { leaving: true } });
      this.askRestart('the bot left maintenance');
    }
  };

  /** Decision 28: NB10's lock take, then runBot with what the standby holds. */
  private async serve(): Promise<void> {
    if (this.serving || isStopping()) return;
    if (this.stopping && !this.stopping.serveWait) return;
    this.serving = true;
    if (this.serveWaitTimer) { clearTimeout(this.serveWaitTimer); this.serveWaitTimer = null; }
    await (this.deps.takeLock ?? (async () => undefined))();
    const runtime = this.runtime ?? new LeaseRuntime(this.ingest);
    let taken: StandbyTaken | JsonTaken;
    if (this.json) {
      phase = 'serving';
      const from = Number(this.env.SMDB_RESHARD_FROM);
      taken = { json: true, count: this.count, runtime, ...(Number.isSafeInteger(from) && from > 0 ? { from } : {}) };
    } else {
      const claims = this.claims!;
      taken = {
        count: this.count,
        processId: processId(),
        pairs: [...this.pairs],
        runtime,
        stopLanes: () => claims.stopLanes(),
        release: () => this.releaseTaken(),
        onServing: reserve => {
          phase = 'serving';
          if (reserve && this.identifyReserve) this.identifyReserve = reserve;
        },
      };
    }
    const runBot = this.deps.runBot ?? (async (opts: RunBotOptions) => (await import('../clientInitializer')).runBot(opts));
    await runBot({ taken, ...(this.client ? { client: this.client } : {}), releaseInjected: () => this.releaseInjected() });
  }

  private async closeGateway(): Promise<void> {
    if (!this.ingest.getClient()) return;
    await Promise.race([this.ingest.close('shutting down').catch(() => undefined), sleep(GATEWAY_CLOSE_BOUND_MS)]);
  }

  /** C5's release for 'refused', a latch, HTTP 401 and the 300 s bound: the Client closed, then the pre-serve release. */
  private async releaseTaken(): Promise<void> {
    await this.closeGateway();
    if (phase === 'pre-serve') {
      await releasePreServe();
      phase = 'released';
    }
  }

  /** 28 and 42: the gateway closed, the shard record under W with the pairs, the pre-serve release once. */
  private async releaseInjected(): Promise<void> {
    await this.closeGateway();
    if (!this.json) {
      try {
        writeShardRecord({ shardCount: this.count, shardIds: this.pairs.map(p => p.shardId), processId: processId(), at: new Date().toISOString() });
      } catch (error) {
        this.log.error('[Shards] Could not write the shard record:', error instanceof Error ? error.message : error);
      }
    }
    if (phase === 'pre-serve') {
      await releasePreServe();
      phase = 'released';
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); });
}
