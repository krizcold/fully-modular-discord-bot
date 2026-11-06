// The holder's side of smdb_data.guild_requests (NB7 decisions 7, 16 and 19): a sweep that claims the changes other
// machines' web panels sent to this process, applies each through the IPC executor, writes the answer into its row,
// answers the rows of a claim whose answer never reached it, and deletes rows older than an hour. Postgres only.

import { Pool } from 'pg';
import type { ClientConfig } from 'pg';
import { guardPoolClients } from '../utils/pgClient';
import { randomUUID } from 'crypto';
import { resolveDataBackend } from '../../../utils/envLoader';
import { pgConfig } from '../../../utils/databaseAddress';
import { PostgresBackend } from '../utils/dataBackends/postgresBackend';
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
import { getGuildDataBackend, isStopping } from '../utils/dataManager';
import { stoppedServing } from '../utils/servingGate';
import { holderStateOf } from './claimStore';
import { getShardClaims } from './shardBoot';
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
  /**
   * Throws an error marked notSent when no connection was handed out, so the statement never left. at: the database
   * epoch of the claim the statement answers (NB5 G9); a statement of an earlier epoch is refused.
   */
  query(text: string, values: unknown[], boundMs: number, at?: number | null): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** NB5 G9: what the sweep's statements check against the data backend; with no Postgres backend every answer is null. */
export interface SweepGate {
  /** The backend's database epoch. */
  epoch(): number | null;
  /** Why the backend refuses every statement now (latched, or held), else null. */
  refusal(): string | null;
  /** The latest latch's `<why>`. */
  stopWhy(): string | null;
}

/** NB5 G9: a statement of a database this process stopped writing to; notSent when it never left. */
export class RequestsStoppedError extends Error {
  constructor(readonly why: string | null, readonly notSent: boolean) {
    super(`this process stopped writing to its database${why === null ? '' : ` (${why})`}`);
    this.name = 'RequestsStoppedError';
  }
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
  /** NB5 G9: the epoch a claim's rows belong to; with none, every claim has the same. */
  gate?: SweepGate;
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
  /** Each batch with when it was kept and the epoch of its claim (NB5 G9). */
  private readonly unansweredBatches = new Map<string, { at: number; epoch: number | null }>();
  /** Each apply with its answer write, from the claim's rows until the answer is written or given up. */
  private readonly inFlight = new Set<Promise<void>>();
  /**
   * Gatekeeper ruling 6: every request this process started, with its apply's outcome and the batch of its latest
   * claim. A claim lost in a failover behind the same URL can come back; that claim is answered with the outcome.
   */
  private readonly started = new Map<string, { reply: Promise<DataWriteReply>; batch: string; epoch: number | null }>();
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
    for (const [id, kept] of this.unansweredBatches) if (now - kept.at > UNANSWERED_KEEP_MS) this.unansweredBatches.delete(id);
  }

  private async claim(): Promise<void> {
    const { deps } = this;
    const processId = deps.processId();
    const pairs = deps.pairs();
    if (!processId || pairs.length === 0 || deps.stoppedServing() || deps.isStopping() || this.applies >= MAX_APPLIES) return;
    const batch = (deps.newId ?? randomUUID)();
    const epoch = this.epoch();
    let rows: ClaimedRow[];
    try {
      const res = await deps.db.query(REQUEST_CLAIM_SQL, [
        processId, batch, pairs.map(p => p.shardCount), pairs.map(p => p.shardId), pairs.map(p => p.claim), MAX_APPLIES - this.applies,
      ], CLAIM_BOUND_MS);
      rows = res.rows as ClaimedRow[];
    } catch (error) {
      // A statement that left without an answer may commit, now or later: its batch is answered unapplied for an hour.
      if (!(error as { notSent?: boolean })?.notSent && failureOf(error).kind === 'unknown') this.unansweredBatches.set(batch, { at: performance.now(), epoch });
      this.noteClaimFailed(describeFailure(error));
      return;
    }
    this.noteClaimWorks();
    if (rows.length === 0) return;
    if (deps.isStopping()) {
      for (const row of rows) if (this.started.has(row.id)) this.startApply(row, batch, epoch);
      if (rows.some(row => !this.started.has(row.id))) this.unansweredBatches.set(batch, { at: performance.now(), epoch });
      return;
    }
    for (const row of rows) this.startApply(row, batch, epoch);
  }

  private epoch(): number | null {
    return this.deps.gate?.epoch() ?? null;
  }

  private startApply(row: ClaimedRow, batch: string, epoch: number | null): void {
    const leftMs = Number(row.left_ms);
    const claimedAt = performance.now();
    const req = requestOf(row, leftMs, this.deps.hrtime ?? (() => process.hrtime.bigint()));
    const until = claimedAt + leftMs + ANSWER_MARGIN_MS;
    const known = this.started.get(row.id);
    if (known) {
      known.batch = batch;
      known.epoch = epoch;
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
    const entry = { reply, batch, epoch };
    this.started.set(row.id, entry);
    this.track(this.answerLatest(entry, row, batch, req, until));
  }

  /** Only the latest claim of a request writes its answer, under that claim's batch. */
  private async answerLatest(entry: { reply: Promise<DataWriteReply>; batch: string; epoch: number | null }, row: ClaimedRow, batch: string, req: GuildDataWriteRequest, until: number): Promise<void> {
    const reply = await entry.reply;
    if (entry.batch === batch) await this.writeAnswer(row, batch, req, reply, until, () => entry.batch !== batch, entry.epoch);
  }

  private track(run: Promise<void>): void {
    this.inFlight.add(run);
    void run.finally(() => this.inFlight.delete(run));
  }

  private async writeAnswer(row: ClaimedRow, batch: string, req: GuildDataWriteRequest, reply: DataWriteReply, until: number, superseded: () => boolean = () => false, at: number | null = null): Promise<void> {
    const text = JSON.stringify(reply);
    const outcome = outcomeOf(reply);
    const file = req.filename ? ` of ${req.module ? `${req.module}/` : ''}${req.filename}` : '';
    const from = `server ${row.guild_id} sent from ${row.requested_by}`;
    let cause = 'no attempt answered';
    // NB5 H5: an ANSWER_SQL that got no answer may have committed.
    let mayHaveLanded = false;
    for (;;) {
      let answering = true;
      try {
        const res = await this.deps.db.query(ANSWER_SQL, [row.id, batch, text], ANSWER_BOUND_MS, at);
        answering = false;
        if ((res.rowCount ?? 0) > 0) {
          console.log(`[GuildRequests] ${row.op}${file} for server ${row.guild_id}, sent from ${row.requested_by}: ${outcome}`);
          return;
        }
        if (superseded()) return;
        const back = (await this.deps.db.query(ANSWER_READ_BACK_SQL, [row.id], ANSWER_BOUND_MS, at)).rows[0];
        if (back && back.reply === text) {
          console.log(`[GuildRequests] ${row.op}${file} for server ${row.guild_id}, sent from ${row.requested_by}: ${outcome}`);
          return;
        }
        console.warn(`[GuildRequests] The ${row.op} of ${from} was applied (${outcome}), but its row holds another answer (${back?.reply ?? 'none'}) or none; its sender may have read that answer or can't confirm`);
        return;
      } catch (error) {
        cause = describeFailure(error);
        const notSent = (error as { notSent?: boolean })?.notSent === true;
        if (answering && !notSent && failureOf(error).kind === 'unknown') mayHaveLanded = true;
        if (error instanceof RequestsStoppedError) {
          if (!error.notSent) {
            console.error(`[GuildRequests] Can't confirm whether the answer to the ${row.op} of ${from} was recorded: this process stopped writing to its database while it waited${error.why === null ? '' : ` (${error.why})`}; its sender reads that answer or can't confirm. The answer was: ${outcome}`);
            return;
          }
          break;
        }
      }
      if (superseded()) return;
      if (performance.now() + ANSWER_RETRY_MS > until) break;
      await sleep(ANSWER_RETRY_MS);
    }
    if (mayHaveLanded) {
      console.error(`[GuildRequests] Can't confirm whether the answer to the ${row.op} of ${from} was recorded: an attempt that got no answer may have landed, and no later attempt confirmed it (${cause}); its sender reads that answer or can't confirm. The answer was: ${outcome}`);
      return;
    }
    console.error(`[GuildRequests] Could not record the answer to the ${row.op} of ${from} (${cause}); its sender reads can't confirm. The answer was: ${outcome}`);
  }

  /** Gatekeeper ruling 6: the ids this process started stay out of the statement for as long as it runs. */
  private startedIds(): string[] {
    return [...this.started.keys()];
  }

  private async answerUnanswered(): Promise<void> {
    this.prune();
    const epoch = this.epoch();
    const ids = [...this.unansweredBatches].filter(([, kept]) => kept.epoch === epoch).map(([id]) => id);
    if (ids.length === 0) return;
    try {
      await this.deps.db.query(UNANSWERED_BATCHES_SQL, [ids, this.startedIds()], CLAIM_BOUND_MS, epoch);
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
function pgSweepDb(config: ClientConfig, gate: SweepGate): { db: SweepDb; pool: Pool } {
  const pool = new Pool({
    max: 2,
    min: 0,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    application_name: GUILD_REQUESTS_APPLICATION_NAME,
    statement_timeout: 5000,
    ...config,
  } as ConstructorParameters<typeof Pool>[0]);
  pool.on('error', error => console.error('[GuildRequests] Idle connection error:', error.message));
  guardPoolClients(pool, 'the guild-requests sweep pool');
  return { db: gatedSweepDb(pool, gate), pool };
}

/** A pool as gatedSweepDb uses it: node-pg's, or a test's fake. */
export interface SweepPool {
  connect(): Promise<{ query(config: unknown): Promise<any>; release(destroy?: boolean): void }>;
}

/**
 * One statement on one client of the pool, through NB5 G9's three checks: at the entry (an earlier epoch, then the
 * backend's refusal; nothing connects), after the connect (the epoch moved: the client is destroyed, nothing is sent),
 * and at the answer (the epoch moved: the answer is dropped, since the statement may have applied).
 */
export function gatedSweepDb(pool: SweepPool, gate: SweepGate): SweepDb {
  return {
    async query(text, values, boundMs, at) {
      const epoch = gate.epoch();
      if (at !== undefined && at !== epoch) throw new RequestsStoppedError(gate.stopWhy(), true);
      const refusal = gate.refusal();
      if (refusal !== null) throw Object.assign(new Error(refusal), { notSent: true });
      let client;
      try {
        client = await pool.connect();
      } catch (error) {
        if (gate.epoch() !== epoch) throw new RequestsStoppedError(gate.stopWhy(), true);
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { notSent: true });
      }
      if (gate.epoch() !== epoch) {
        client.release(true);
        throw new RequestsStoppedError(gate.stopWhy(), true);
      }
      let destroy = false;
      try {
        const res = await client.query({ text, values, query_timeout: boundMs });
        if (gate.epoch() !== epoch) throw new RequestsStoppedError(gate.stopWhy(), false);
        return res;
      } catch (error) {
        if (error instanceof RequestsStoppedError) throw error;
        destroy = typeof (error as { code?: unknown })?.code !== 'string';
        if (gate.epoch() !== epoch) throw new RequestsStoppedError(gate.stopWhy(), false);
        throw error;
      } finally {
        client.release(destroy ? true : undefined);
      }
    },
  };
}

function pgBackend(): PostgresBackend | null {
  const backend = getGuildDataBackend();
  return backend instanceof PostgresBackend ? backend : null;
}

/** NB5 G9: the gate of this process's data backend; it passes everything on a JSON bot. */
export const backendGate: SweepGate = {
  epoch: () => pgBackend()?.databaseEpoch() ?? null,
  refusal: () => pgBackend()?.refusalDetail() ?? null,
  stopWhy: () => getShardClaims()?.databaseStopWhy() ?? null,
};

let sharedDb: SweepDb | null = null;
let lookupOverride: SweepDb | null = null;
let sweep: GuildRequestSweep | null = null;

/** NB5 G9: the pool of the chosen entry, built again when a move changes it; the old pool ends in the background. */
function poolDb(): SweepDb {
  if (!sharedDb) {
    const backend = pgBackend();
    const entry = backend?.chosenEntry() ?? null;
    if (!backend || entry === null) throw new Error('the bot process has not chosen its database yet');
    let built = pgSweepDb(pgConfig(entry), backendGate);
    sharedDb = built.db;
    backend.onDatabaseChanged(next => {
      const old = built.pool;
      built = pgSweepDb(pgConfig(next), backendGate);
      sharedDb = built.db;
      void old.end().catch(error => console.error('[GuildRequests] The pool of the database this process left did not end cleanly:', error instanceof Error ? error.message : error));
    });
  }
  return sharedDb;
}

/** NB5 H4: every statement of the sweep reads the pool in use when it starts. */
const currentDb: SweepDb = {
  async query(text, values, boundMs, at) {
    let db: SweepDb;
    try {
      db = poolDb();
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { notSent: true });
    }
    return db.query(text, values, boundMs, at);
  },
};

/** Tests drop the pool built for an earlier test's backend. */
export function _resetGuildRequestPool(): void {
  sharedDb = null;
  sweep?.stop();
  sweep = null;
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
  try {
    poolDb();
  } catch (error) {
    console.error(`[GuildRequests] Changes sent from other machines' panels are not read: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  sweep = new GuildRequestSweep({
    db: currentDb,
    gate: backendGate,
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
