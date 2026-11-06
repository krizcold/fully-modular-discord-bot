// The holder's side of smdb_data.guild_requests (NB7 decisions 7, 16 and 19): a sweep that claims the changes other
// machines' web panels sent to this process, applies each through the IPC executor, writes the answer into its row,
// answers the rows of a claim whose answer never reached it, and deletes rows older than an hour. Postgres only.

import { Pool } from 'pg';
import { guardPoolClients } from '../utils/pgClient';
import { randomUUID } from 'crypto';
import { loadCredentials, resolveDataBackend } from '../../../utils/envLoader';
import {
  ANSWER_READ_BACK_SQL,
  ANSWER_SQL,
  CLEANUP_SQL,
  HOLDER_CHECK_SQL,
  REQUEST_CLAIM_SQL,
  UNANSWERED_BATCHES_SQL,
  failureOf,
} from '../utils/dataBackends/guildRequestSql';
import { answerGuildWrite, type DataWriteReply, type GuildDataWriteRequest } from '../utils/ipcDataHandler';
import { getDataBootStatus } from '../utils/dataBackends/boot';
import { isStopping } from '../utils/dataManager';
import { stoppedServing } from '../utils/servingGate';
import { holderStateOf } from './claimStore';
import type { CurrentLease } from './leaseRuntime';
import type { Pair } from './claimRules';

export const GUILD_REQUESTS_APPLICATION_NAME = 'smdb-guild-requests';
const PASS_MS = 1000;
const MAX_APPLIES = 16;
const CLAIM_BOUND_MS = 2000;
const ANSWER_BOUND_MS = 2000;
const ANSWER_RETRY_MS = 1000;
const ANSWER_MARGIN_MS = 5000;
const CLEANUP_EVERY_MS = 60_000;
const CLEANUP_BOUND_MS = 5000;
const UNANSWERED_KEEP_MS = 60 * 60 * 1000;
const FAIL_LOG_MS = 30_000;
const STOP_WAIT_MS = 2000;
const LOOKUP_BOUND_MS = 2000;

export interface SweepDb {
  /** Throws an error marked notSent when no connection was handed out, so the statement never left. */
  query(text: string, values: unknown[], boundMs: number): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface SweepDeps {
  db: SweepDb;
  processId: () => string | null;
  /** The pairs this process holds (NB4's lease): count, shard and claim. */
  pairs: () => Pair[];
  stoppedServing: () => boolean;
  isStopping: () => boolean;
  /** The executor's answer to one request, maintenance refusal first (answerGuildWrite). */
  apply: (req: GuildDataWriteRequest) => Promise<DataWriteReply>;
  /** Whether the data layer serves; the cleanup runs only then. */
  serving?: () => boolean;
  newId?: () => string;
  hrtime?: () => bigint;
}

const sleep = (ms: number) => new Promise<void>(resolve => { const t = setTimeout(resolve, ms); (t as any).unref?.(); });

/** The cause a log line or a refusal names: a SQLSTATE with its message, or the client's own error. */
export function describeFailure(error: unknown): string {
  const failure = failureOf(error);
  return failure.kind === 'refused' ? `SQLSTATE ${failure.code}: ${failure.message}` : failure.cause;
}

function outcomeOf(reply: DataWriteReply): string {
  if (reply.ok) return reply.pending ? 'accepted, not confirmed as saved yet' : 'saved';
  return reply.error ? `${reply.code ?? 'refused'}: ${reply.error}` : String(reply.code ?? 'refused');
}

interface ClaimedRow {
  id: string;
  guild_id: string;
  op: GuildDataWriteRequest['op'];
  body: string;
  requested_by: string;
  left_ms: string | number;
}

function requestOf(row: ClaimedRow, leftMs: number, hrtime: () => bigint): GuildDataWriteRequest {
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.body);
    if (parsed && typeof parsed === 'object') body = parsed;
  } catch { /* the executor refuses the missing fields */ }
  const req: GuildDataWriteRequest = {
    guildId: row.guild_id,
    op: row.op,
    module: typeof body.module === 'string' ? body.module : '',
    filename: typeof body.filename === 'string' ? body.filename : '',
  };
  if (typeof body.contentJson === 'string') req.contentJson = body.contentJson;
  if (typeof body.expectSha === 'string') req.expectSha = body.expectSha;
  if (body.twin && typeof body.twin === 'object') req.twin = body.twin as GuildDataWriteRequest['twin'];
  if (body.sinceOpen === true) req.sinceOpen = true;
  if (row.op === 'restore-graveyard' || row.op === 'delete-namespace') {
    req.answerByMono = (hrtime() + BigInt(Math.max(0, Math.floor(leftMs))) * 1_000_000n).toString();
  }
  return req;
}

export class GuildRequestSweep {
  private applies = 0;
  private readonly unansweredBatches = new Map<string, number>();
  /** Each apply with its answer write, from the claim's rows until the answer is written or given up. */
  private readonly inFlight = new Set<Promise<void>>();
  /**
   * Gatekeeper ruling 6: every request this process started, with its apply's outcome and the batch of its latest
   * claim. A claim lost in a failover behind the same URL can come back; that claim is answered with the outcome.
   */
  private readonly started = new Map<string, { reply: Promise<DataWriteReply>; batch: string }>();
  private lastCleanup = -Infinity;
  private claimFailing = false;
  private lastFailLog = -Infinity;
  private passRun: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SweepDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pass(); }, PASS_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  running(): number {
    return this.applies;
  }

  unanswered(): string[] {
    this.prune();
    return [...this.unansweredBatches.keys()];
  }

  /** One pass, never two at once: the claim, then the unanswered batches' statement once the claim settled, then the cleanup. */
  async pass(): Promise<void> {
    if (this.passRun) return;
    const run = (async () => {
      await this.claim();
      await this.answerUnanswered();
      await this.cleanup();
    })();
    this.passRun = run;
    try {
      await run;
    } finally {
      this.passRun = null;
    }
  }

  /**
   * The stop step, up to 2 s: the pass in flight ends (a claim on the wire records its batch), then the unanswered
   * batches' statement answers each row nobody applies, beside each apply in flight and its answer write.
   */
  async stopStep(boundMs = STOP_WAIT_MS): Promise<void> {
    const work = (async () => {
      if (this.passRun) await this.passRun.catch(() => undefined);
      const unanswered = this.answerUnanswered();
      while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
      await unanswered;
    })();
    await Promise.race([work, sleep(boundMs)]);
  }

  private prune(): void {
    const now = performance.now();
    for (const [id, at] of this.unansweredBatches) if (now - at > UNANSWERED_KEEP_MS) this.unansweredBatches.delete(id);
  }

  private async claim(): Promise<void> {
    const { deps } = this;
    const processId = deps.processId();
    const pairs = deps.pairs();
    if (!processId || pairs.length === 0 || deps.stoppedServing() || deps.isStopping() || this.applies >= MAX_APPLIES) return;
    const batch = (deps.newId ?? randomUUID)();
    let rows: ClaimedRow[];
    try {
      const res = await deps.db.query(REQUEST_CLAIM_SQL, [
        processId, batch, pairs.map(p => p.shardCount), pairs.map(p => p.shardId), pairs.map(p => p.claim), MAX_APPLIES - this.applies,
      ], CLAIM_BOUND_MS);
      rows = res.rows as ClaimedRow[];
    } catch (error) {
      // A statement that left without an answer may commit, now or later: its batch is answered unapplied for an hour.
      if (!(error as { notSent?: boolean })?.notSent && failureOf(error).kind === 'unknown') this.unansweredBatches.set(batch, performance.now());
      this.noteClaimFailed(describeFailure(error));
      return;
    }
    this.noteClaimWorks();
    if (rows.length === 0) return;
    if (deps.isStopping()) {
      for (const row of rows) if (this.started.has(row.id)) this.startApply(row, batch);
      if (rows.some(row => !this.started.has(row.id))) this.unansweredBatches.set(batch, performance.now());
      return;
    }
    for (const row of rows) this.startApply(row, batch);
  }

  private startApply(row: ClaimedRow, batch: string): void {
    const leftMs = Number(row.left_ms);
    const claimedAt = performance.now();
    const req = requestOf(row, leftMs, this.deps.hrtime ?? (() => process.hrtime.bigint()));
    const until = claimedAt + leftMs + ANSWER_MARGIN_MS;
    const known = this.started.get(row.id);
    if (known) {
      known.batch = batch;
      console.warn(`[GuildRequests] The ${row.op} of server ${row.guild_id} sent from ${row.requested_by} was claimed again after this process started it; it is answered with the first apply's outcome, not applied again`);
      this.track(this.answerLatest(known, row, batch, req, until));
      return;
    }
    this.applies += 1;
    const reply = (async (): Promise<DataWriteReply> => {
      try {
        return await this.deps.apply(req);
      } catch (error) {
        return { ok: false, code: 'io-error', error: error instanceof Error ? error.message : String(error) };
      } finally {
        this.applies -= 1;
      }
    })();
    const entry = { reply, batch };
    this.started.set(row.id, entry);
    this.track(this.answerLatest(entry, row, batch, req, until));
  }

  /** Only the latest claim of a request writes its answer, under that claim's batch. */
  private async answerLatest(entry: { reply: Promise<DataWriteReply>; batch: string }, row: ClaimedRow, batch: string, req: GuildDataWriteRequest, until: number): Promise<void> {
    const reply = await entry.reply;
    if (entry.batch === batch) await this.writeAnswer(row, batch, req, reply, until, () => entry.batch !== batch);
  }

  private track(run: Promise<void>): void {
    this.inFlight.add(run);
    void run.finally(() => this.inFlight.delete(run));
  }

  private async writeAnswer(row: ClaimedRow, batch: string, req: GuildDataWriteRequest, reply: DataWriteReply, until: number, superseded: () => boolean = () => false): Promise<void> {
    const text = JSON.stringify(reply);
    const outcome = outcomeOf(reply);
    const file = req.filename ? ` of ${req.module ? `${req.module}/` : ''}${req.filename}` : '';
    const from = `server ${row.guild_id} sent from ${row.requested_by}`;
    let cause = 'no attempt answered';
    for (;;) {
      try {
        const res = await this.deps.db.query(ANSWER_SQL, [row.id, batch, text], ANSWER_BOUND_MS);
        if ((res.rowCount ?? 0) > 0) {
          console.log(`[GuildRequests] ${row.op}${file} for server ${row.guild_id}, sent from ${row.requested_by}: ${outcome}`);
          return;
        }
        if (superseded()) return;
        const back = (await this.deps.db.query(ANSWER_READ_BACK_SQL, [row.id], ANSWER_BOUND_MS)).rows[0];
        if (back && back.reply === text) {
          console.log(`[GuildRequests] ${row.op}${file} for server ${row.guild_id}, sent from ${row.requested_by}: ${outcome}`);
          return;
        }
        console.warn(`[GuildRequests] The ${row.op} of ${from} was applied (${outcome}), but its row holds another answer (${back?.reply ?? 'none'}) or none; its sender may have read that answer or can't confirm`);
        return;
      } catch (error) {
        cause = describeFailure(error);
      }
      if (superseded()) return;
      if (performance.now() + ANSWER_RETRY_MS > until) break;
      await sleep(ANSWER_RETRY_MS);
    }
    console.error(`[GuildRequests] Could not record the answer to the ${row.op} of ${from} (${cause}); its sender reads can't confirm. The answer was: ${outcome}`);
  }

  /** Gatekeeper ruling 6: the ids this process started stay out of the statement for as long as it runs. */
  private startedIds(): string[] {
    return [...this.started.keys()];
  }

  private async answerUnanswered(): Promise<void> {
    const ids = this.unanswered();
    if (ids.length === 0) return;
    try {
      await this.deps.db.query(UNANSWERED_BATCHES_SQL, [ids, this.startedIds()], CLAIM_BOUND_MS);
    } catch { /* the next pass sends it again */ }
  }

  private async cleanup(): Promise<void> {
    if (this.deps.serving && !this.deps.serving()) return;
    const now = performance.now();
    if (now - this.lastCleanup < CLEANUP_EVERY_MS) return;
    this.lastCleanup = now;
    try {
      await this.deps.db.query(CLEANUP_SQL, [], CLEANUP_BOUND_MS);
    } catch { /* the next cleanup deletes them */ }
  }

  private noteClaimFailed(cause: string): void {
    const now = performance.now();
    if (!this.claimFailing || now - this.lastFailLog >= FAIL_LOG_MS) {
      console.error(`[GuildRequests] Cannot read the changes sent from other machines' panels (${cause}); they are refused until this works`);
      this.lastFailLog = now;
    }
    this.claimFailing = true;
  }

  private noteClaimWorks(): void {
    if (!this.claimFailing) return;
    this.claimFailing = false;
    console.log("[GuildRequests] Reading the changes sent from other machines' panels works again");
  }
}

/** The sweep's pool: its own, so flushes and hydrates that hold the data pool never push a pickup past 5 s. */
function pgSweepDb(url: string): SweepDb {
  const pool = new Pool({
    connectionString: url,
    max: 2,
    min: 0,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    application_name: GUILD_REQUESTS_APPLICATION_NAME,
    statement_timeout: 5000,
  } as ConstructorParameters<typeof Pool>[0]);
  pool.on('error', error => console.error('[GuildRequests] Idle connection error:', error.message));
  guardPoolClients(pool, 'the guild-requests sweep pool');
  return {
    async query(text, values, boundMs) {
      let client;
      try {
        client = await pool.connect();
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { notSent: true });
      }
      let destroy = false;
      try {
        return await client.query({ text, values, query_timeout: boundMs } as any);
      } catch (error) {
        destroy = typeof (error as { code?: unknown })?.code !== 'string';
        throw error;
      } finally {
        client.release(destroy ? true : undefined);
      }
    },
  };
}

let sharedDb: SweepDb | null = null;
let lookupOverride: SweepDb | null = null;
let sweep: GuildRequestSweep | null = null;

function poolDb(): SweepDb {
  if (!sharedDb) {
    const url = (loadCredentials().DATA_BACKEND_URL || '').trim();
    if (!url) throw new Error('DATA_BACKEND_URL is not set');
    sharedDb = pgSweepDb(url);
  }
  return sharedDb;
}

/** Tests answer the panel refusal's lookup from a scripted database. */
export function _setLookupDb(db: SweepDb | null): void {
  lookupOverride = db;
}

const pairsOf = (lease: CurrentLease | null): Pair[] => (lease?.leases ?? [])
  .filter(l => l.claim !== null)
  .map(l => ({ shardCount: lease!.shardCount, shardId: l.shardId, claim: l.claim as number }));

/** Starts the sweep at the bot's guild report, on Postgres only. lease reads NB4's runtime. */
export function startGuildRequestSweep(lease: () => CurrentLease | null): void {
  if (sweep || resolveDataBackend() !== 'postgres') return;
  let db: SweepDb;
  try {
    db = poolDb();
  } catch (error) {
    console.error(`[GuildRequests] Changes sent from other machines' panels are not read: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  sweep = new GuildRequestSweep({
    db,
    processId: () => lease()?.processId ?? null,
    pairs: () => pairsOf(lease()),
    stoppedServing,
    isStopping,
    apply: answerGuildWrite,
    serving: () => getDataBootStatus().state === 'serving',
  });
  sweep.start();
}

/** The stop step after the exit drain, before the claims' release: finished applies' answers get 2 s to be written. */
export async function guildRequestsStopStep(): Promise<void> {
  await sweep?.stopStep();
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
    (timer as any).unref?.();
    work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/**
 * NB7 decision 19: the refusal of a panel action or a console invoke of a server this process does not run, naming
 * the machine that runs it, from the holder check's statement on the sweep's pool.
 */
export async function notServedHereText(guildId: string, kind: 'panel' | 'console'): Promise<string> {
  try {
    const db = lookupOverride ?? poolDb();
    const res = await within(db.query(HOLDER_CHECK_SQL, [guildId], LOOKUP_BOUND_MS), LOOKUP_BOUND_MS);
    const check = holderStateOf(res.rows);
    if (check.kind === 'row' && check.state === 'held') {
      const name = check.holderName;
      return kind === 'panel'
        ? `This server runs on ${name}; open its panels from the web panel on ${name}.`
        : `guild ${guildId} runs on ${name}; run the command from the web panel on ${name}`;
    }
    return kind === 'panel'
      ? 'No machine runs this server right now; please try again in a moment.'
      : `no machine runs guild ${guildId} right now; try again in a moment`;
  } catch (error) {
    const cause = describeFailure(error);
    return kind === 'panel'
      ? `This machine's bot does not run this server, and the machine that runs it could not be looked up (${cause}); open its panels from the web panel of the machine that runs it.`
      : `this machine's bot does not run guild ${guildId}, and the machine that runs it could not be looked up (${cause})`;
  }
}
