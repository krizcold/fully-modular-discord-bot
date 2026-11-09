// The holder's side of smdb_data.guild_requests (NB7 decisions 7 and 16, NB15 decision 8): a sweep that claims the
// requests other machines' web panels sent to this process (data changes, panel actions, console invokes and the
// reads a panel needs), runs each through the same function that answers this machine's web UI, writes the answer
// into its row, answers the rows of a claim whose answer never reached it, and clears old rows. Postgres only.

import { Pool } from 'pg';
import type { ClientConfig } from 'pg';
import { guardPoolClients } from '../utils/pgClient';
import { randomUUID } from 'crypto';
import { resolveDataBackend } from '../../../utils/envLoader';
import { classifyPoolClients, pgConfig, transportClassOf } from '../../../utils/databaseAddress';
import { PostgresBackend } from '../utils/dataBackends/postgresBackend';
import {
  ACTION_OPS,
  ANSWER_READ_BACK_SQL,
  ANSWER_SQL,
  CLEANUP_BODIES_SQL,
  CLEANUP_SQL,
  DATA_OPS,
  READ_ANSWERS_READ_BACK_SQL,
  READ_ANSWERS_SQL,
  READ_OPS,
  REQUEST_CLAIM_SQL,
  UNANSWERED_BATCHES_SQL,
  failureOf,
  type AnyRequestOp,
} from '../utils/dataBackends/guildRequestSql';
import { answerGuildWrite, type DataWriteReply, type GuildDataWriteRequest } from '../utils/ipcDataHandler';
import { getDataBootStatus } from '../utils/dataBackends/boot';
import { getDataReadiness } from '../utils/dataBackends/dataReadiness';
import { getGuildDataBackend, isStopping } from '../utils/dataManager';
import { stoppedServing } from '../utils/servingGate';
import { maintenanceIpcRefusal } from '../utils/maintenance';
import {
  MAX_BODY_BYTES,
  PANEL_ACTION_OPS,
  bodyRefusal,
  isActionOp,
  isPanelRequestOp,
  isReadOp,
  shardOfGuild,
  validGuildId,
  type PanelRequestOp,
} from '../utils/panelRequestShape';
import { ANSWER_LIMIT_BYTES, cutString, toTransport } from '../utils/transportJson';
import { getShardClaims } from './shardBoot';
import { liveVersionOf, recordActionView, registerInterest, VIEW_CHANGE_OPS } from './panelLive';
import { getPanelManager } from '../utils/panelManager';
import getLocalCommands from '../utils/getLocalCommands';
import { answerPanelMessage, cacheIncomplete, guildWebUiEnabled } from '../utils/ipcPanelHandler';
import { answerInvokeMessage, findLocalCommand, type CommandLookup } from '../utils/ipcCommandHandler';
import type { CurrentLease } from './leaseRuntime';
import type { Pair } from './claimRules';

export const GUILD_REQUESTS_APPLICATION_NAME = 'smdb-guild-requests';
const PASS_MS = 1000;
const MAX_APPLIES = 16;
const MAX_ACTIONS = 8;
const READ_LIMIT = 64;
const CLAIM_BOUND_MS = 2000;
const ANSWER_BOUND_MS = 2000;
const ANSWER_RETRY_MS = 1000;
const ANSWER_MARGIN_MS = 5000;
const ACTION_ANSWER_FOR_MS = 10_000;
const READ_GROUP_BYTES = 256 * 1024;
const CLEANUP_EVERY_MS = 60_000;
const CLEANUP_BOUND_MS = 5000;
const UNANSWERED_KEEP_MS = 60 * 60 * 1000;
const FAIL_LOG_MS = 30_000;
const PLACES_LOG_MS = 30_000;
const UNPROTECTED_LOG_MS = 10 * 60 * 1000;
const STOP_WAIT_MS = 2000;
const SWEEP_POOL_MAX = 3;
// The sweep pool's connect bound: a statement waiting for a reserved slot gives up as not sent, as a pool connect did.
const RESERVED_WAIT_MS = 5000;
const PASS_STATEMENTS: readonly string[] = [REQUEST_CLAIM_SQL, UNANSWERED_BATCHES_SQL];

const UNPROTECTED_LINE = "[GuildRequests] This bot's database address does not check the database's certificate, so requests from other machines (panel actions, commands and data changes) are not taken. Set sslmode=verify-full with sslrootcert in DATA_BACKEND_URL.";

export interface SweepDb {
  /**
   * Throws an error marked notSent when no connection was handed out, so the statement never left. at: the database
   * epoch of the claim the statement answers (NB5 G9); a statement of an earlier epoch is refused. carries: the
   * statement carries a request's body or answer, so it is refused, unsent, on a client classed 'unprotected'.
   */
  query(text: string, values: unknown[], boundMs: number, at?: number | null, carries?: boolean): Promise<{ rows: any[]; rowCount?: number | null }>;
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

/** NB15 decision 21: a statement that carries a body or an answer, refused on an 'unprotected' client before it left. */
export class UnprotectedTransportError extends Error {
  readonly notSent = true;
  constructor() {
    super("this bot's database address does not check the database's certificate");
    this.name = 'UnprotectedTransportError';
  }
}

/** What the start of an NB15 row calls; tests script it. */
export interface PanelHooks {
  answerPanel(op: PanelRequestOp, body: Record<string, unknown>): Promise<any>;
  /** lookup: the start check's own lookup of the command, so the invoke does not look it up again. */
  answerInvoke(body: Record<string, unknown>, lookup?: CommandLookup): Promise<any>;
  maintenanceRefusal(op: string): object | null;
  getPanel(panelId: string): { panelScope?: string; devOnly?: boolean } | undefined;
  getCommand(name: string): { devOnly?: boolean } | undefined;
  guildWebUi(): boolean | null;
  membership(ids: string[], shardCount: number): any;
  registerInterest(guildId: string, panelId: string): number | null;
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
  /** NB15's rows; the real handlers when absent. */
  panel?: PanelHooks;
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

/** NB15's log outcome: "ran", "ran, writes not confirmed as saved yet", or the refusal's text. */
function panelOutcomeOf(answer: any): string {
  if (answer?.success === true) return answer.pending ? 'ran, writes not confirmed as saved yet' : 'ran';
  const text = typeof answer?.error === 'string' ? answer.error : 'refused';
  return answer?.code ? `${answer.code}: ${text}` : text;
}

interface ClaimedRow {
  id: string;
  guild_id: string;
  shard_count?: number | string;
  shard_id?: number | string;
  op: AnyRequestOp;
  body: string;
  requested_by: string;
  left_ms: string | number;
}

interface Started {
  reply: Promise<any>;
  batch: string;
  epoch: number | null;
  /** When the latest claim ran, on performance.now(). */
  at: number;
}

function requestOf(row: ClaimedRow, leftMs: number, hrtime: () => bigint): GuildDataWriteRequest {
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.body);
    if (parsed && typeof parsed === 'object') body = parsed;
  } catch { /* the executor refuses the missing fields */ }
  const req: GuildDataWriteRequest = {
    guildId: row.guild_id,
    op: row.op as GuildDataWriteRequest['op'],
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

const invalid = (reason: string) => ({
  success: false, ran: false, code: 'invalid', error: `The request for this server was malformed (${reason}); nothing was run.`,
});

/** The shrunk answer an action's started entry keeps once its answer is written (gatekeeper ruling 1). */
export function keptAnswer(answer: any): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  let captured: unknown;
  try {
    captured = answer?.captured;
  } catch {
    captured = undefined;
  }
  if (captured !== undefined) kept.capturedOmitted = { count: Array.isArray(captured) ? captured.length : 0, bytes: 0, reason: 'not-kept' };
  else kept.oversize = { bytes: 0, reason: 'not-kept' };
  for (const key of ['success', 'code', 'ran', 'truth', 'partial', 'pending', 'error']) {
    let value: unknown;
    try {
      value = answer?.[key];
    } catch {
      continue;
    }
    if (typeof value === 'string') kept[key] = cutString(value);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) kept[key] = value;
  }
  let since: unknown;
  let version: unknown;
  try {
    since = answer?.liveSince;
    version = answer?.liveVersion;
  } catch {
    since = undefined;
  }
  if (since === null || (typeof since === 'number' && Number.isFinite(since))) {
    kept.liveSince = since;
    kept.liveVersion = Number.isSafeInteger(version) ? version : 0;
  }
  if (typeof kept.success !== 'boolean') kept.success = false;
  return kept;
}

export class GuildRequestSweep {
  private applies = 0;
  private actions = 0;
  /** The actions running now, for the places-full line. */
  private readonly runningActions = new Map<string, { op: string; guildId: string; at: number }>();
  /** Each batch with when it was kept and the epoch of its claim (NB5 G9). */
  private readonly unansweredBatches = new Map<string, { at: number; epoch: number | null }>();
  /** Each apply with its answer write, from the claim's rows until the answer is written or given up. */
  private readonly inFlight = new Set<Promise<void>>();
  /**
   * NB7 ruling 6 and NB15 ruling 1: every data change and action this process started, with its outcome and the
   * batch of its latest claim, for an hour after that claim. A claim lost in a failover behind the same URL can come
   * back; that claim is answered with the outcome. The reads never enter it.
   */
  private readonly started = new Map<string, Started>();
  private lastCleanup = -Infinity;
  private claimFailing = false;
  private lastFailLog = -Infinity;
  private lastPlacesLog = -Infinity;
  private unprotected = false;
  private lastUnprotectedLog = -Infinity;
  private passRun: Promise<void> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private cleanupRun: Promise<void> | null = null;

  constructor(private readonly deps: SweepDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pass(); }, PASS_MS);
    this.timer.unref?.();
    this.cleanupTimer = setInterval(() => { void this.cleanupTick(); }, PASS_MS);
    this.cleanupTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.timer = null;
    this.cleanupTimer = null;
  }

  /** The cleanup, due every 60 s, on its own timer and never two at once, so it never holds up a pass's claim. */
  cleanupTick(): Promise<void> {
    if (this.cleanupRun) return this.cleanupRun;
    const run = this.cleanup().finally(() => { this.cleanupRun = null; });
    this.cleanupRun = run;
    return run;
  }

  running(): number {
    return this.applies;
  }

  runningActionCount(): number {
    return this.actions;
  }

  startedCount(): number {
    this.prune();
    return this.started.size;
  }

  unanswered(): string[] {
    this.prune();
    return [...this.unansweredBatches.keys()];
  }

  /** One pass, never two at once: the claim, then the unanswered batches' statement once the claim settled. */
  async pass(): Promise<void> {
    if (this.passRun) return;
    const run = (async () => {
      await this.claim();
      await this.answerUnanswered();
    })();
    this.passRun = run;
    try {
      await run;
    } finally {
      this.passRun = null;
      if (this.again) {
        this.again = false;
        void this.pass();
      }
    }
  }

  /** A notify for this process (NB6 decision 17): a pass now, or one more after the pass running. */
  requestPass(): void {
    if (this.passRun) {
      this.again = true;
      return;
    }
    void this.pass();
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
    for (const [id, entry] of this.started) if (now - entry.at > UNANSWERED_KEEP_MS) this.started.delete(id);
  }

  private async claim(): Promise<void> {
    const { deps } = this;
    const processId = deps.processId();
    const pairs = deps.pairs();
    if (!processId || pairs.length === 0 || deps.stoppedServing() || deps.isStopping()) return;
    if (this.actions >= MAX_ACTIONS) this.notePlacesFull();
    const batch = (deps.newId ?? randomUUID)();
    const epoch = this.epoch();
    let rows: ClaimedRow[];
    try {
      const res = await deps.db.query(REQUEST_CLAIM_SQL, [
        processId, batch, pairs.map(p => p.shardCount), pairs.map(p => p.shardId), pairs.map(p => p.claim),
        DATA_OPS, Math.max(0, MAX_APPLIES - this.applies),
        ACTION_OPS, Math.max(0, MAX_ACTIONS - this.actions),
        READ_OPS, READ_LIMIT,
      ], CLAIM_BOUND_MS, undefined, true);
      rows = res.rows as ClaimedRow[];
    } catch (error) {
      if (error instanceof UnprotectedTransportError) {
        this.noteUnprotected();
        return;
      }
      // A statement that left without an answer may commit, now or later: its batch is answered unapplied for an hour.
      if (!(error as { notSent?: boolean })?.notSent && failureOf(error).kind === 'unknown') this.unansweredBatches.set(batch, { at: performance.now(), epoch });
      this.noteClaimFailed(describeFailure(error));
      return;
    }
    this.noteProtected();
    this.noteClaimWorks();
    if (rows.length === 0) return;
    if (deps.isStopping()) {
      for (const row of rows) if (this.started.has(row.id)) this.startRow(row, batch, epoch, []);
      if (rows.some(row => !this.started.has(row.id))) this.unansweredBatches.set(batch, { at: performance.now(), epoch });
      return;
    }
    const reads: Array<{ row: ClaimedRow; answer: Promise<any> }> = [];
    for (const row of rows) this.startRow(row, batch, epoch, reads);
    if (reads.length > 0) this.track(this.answerReads(reads, batch, epoch));
  }

  private epoch(): number | null {
    return this.deps.gate?.epoch() ?? null;
  }

  private startRow(row: ClaimedRow, batch: string, epoch: number | null, reads: Array<{ row: ClaimedRow; answer: Promise<any> }>): void {
    if (isPanelRequestOp(row.op)) this.startPanelRow(row, batch, epoch, reads);
    else if ((DATA_OPS as readonly string[]).includes(row.op)) this.startApply(row, batch, epoch);
    else reads.push({ row, answer: Promise.resolve(invalid('the request names no operation this bot knows')) });
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
      known.at = claimedAt;
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
    const entry: Started = { reply, batch, epoch, at: claimedAt };
    this.started.set(row.id, entry);
    this.track(this.answerLatest(entry, row, batch, req, until));
  }

  private hooks(): PanelHooks {
    return this.deps.panel ?? realPanelHooks;
  }

  /**
   * NB15 decision 8's start checks, in the synchronous run that starts the row: the op, the body and the guild's
   * shard; the body's shape; decision 3's rule. A refusal is the row's answer and runs no module code.
   */
  private startChecks(row: ClaimedRow): { refusal: any } | { body: Record<string, unknown>; lookup?: CommandLookup } {
    const op = row.op as PanelRequestOp;
    const text = typeof row.body === 'string' ? row.body : '';
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return { refusal: invalid('the request is over 16 KiB') };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { refusal: invalid('the request is not JSON') };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { refusal: invalid('the request is not an object') };
    const count = Number(row.shard_count);
    const shard = Number(row.shard_id);
    if (!validGuildId(row.guild_id) || !Number.isInteger(count) || count <= 0 || shardOfGuild(row.guild_id, count) !== shard) {
      return { refusal: invalid("the server is not on the request's shard") };
    }
    const shaped: Record<string, unknown> = { ...(body as Record<string, unknown>), guildId: row.guild_id };
    const reason = bodyRefusal(op, shaped);
    if (reason) return { refusal: invalid(reason) };
    const hooks = this.hooks();
    if ((PANEL_ACTION_OPS as readonly string[]).includes(op) || op === 'panel:live') {
      const panel = hooks.getPanel(String(shaped.panelId));
      if (panel && ((panel.panelScope ?? 'guild') !== 'guild' || panel.devOnly)) {
        return { refusal: { success: false, ran: false, code: 'not-allowed', error: 'This panel runs only from the web panel of its own machine; nothing was run.' } };
      }
    }
    let lookup: CommandLookup | undefined;
    if (op === 'command:invoke') {
      lookup = { command: hooks.getCommand(String(shaped.command)) };
      if (lookup.command?.devOnly) {
        return { refusal: { success: false, ran: false, code: 'not-allowed', command: shaped.command, error: `/${shaped.command} is a developer command and runs only from the console of its own machine; nothing was run.` } };
      }
    }
    const actor = shaped.actor as { via: string; userId: string };
    if (actor.via === 'member') {
      const on = hooks.guildWebUi();
      if (on === null) {
        return { refusal: { success: false, ran: false, code: 'not-ready', error: 'The bot that runs this server has not yet learned whether its member web panel is on; nothing was run. Try again in a moment.' } };
      }
      if (!on) {
        return { refusal: { success: false, ran: false, code: 'member-panel-off', error: 'The member web panel is turned off for the machine that runs this server; nothing was run.' } };
      }
    }
    if ((PANEL_ACTION_OPS as readonly string[]).includes(op)) shaped.userId = actor.userId;
    return lookup ? { body: shaped, lookup } : { body: shaped };
  }

  private startPanelRow(row: ClaimedRow, batch: string, epoch: number | null, reads: Array<{ row: ClaimedRow; answer: Promise<any> }>): void {
    const claimedAt = performance.now();
    const read = isReadOp(row.op);
    if (!read) {
      const known = this.started.get(row.id);
      if (known) {
        known.batch = batch;
        known.epoch = epoch;
        known.at = claimedAt;
        console.warn(`[GuildRequests] The ${row.op} of server ${row.guild_id} sent from ${row.requested_by} was claimed again after this process started it; it is answered with the first run's outcome, not run again`);
        this.track(this.answerPanelLatest(known, row, batch, null));
        return;
      }
    }
    const checked = this.startChecks(row);
    const hooks = this.hooks();
    const op = row.op as PanelRequestOp;
    if (read) {
      let answer: Promise<any>;
      if ('refusal' in checked) answer = Promise.resolve(checked.refusal);
      else if (op === 'guild:membership') {
        const refusal = hooks.maintenanceRefusal(op);
        answer = Promise.resolve(refusal ?? hooks.membership(checked.body.ids as string[], Number(row.shard_count)));
      } else {
        const body = checked.body;
        const owner = (body.actor as { via: string }).via === 'owner';
        if (op === 'panel:live' && !owner) answer = Promise.resolve(invalid('a member cannot watch a panel'));
        else answer = hooks.answerPanel(op, body).catch(error => ({ success: false, error: error instanceof Error ? error.message : String(error) }));
      }
      reads.push({ row, answer });
      return;
    }
    let reply: Promise<any>;
    const leftMs = Number(row.left_ms);
    if ('refusal' in checked) {
      reply = Promise.resolve(checked.refusal);
    } else {
      const { body, lookup } = checked;
      const owner = (body.actor as { via: string }).via === 'owner';
      const since = owner && op !== 'command:invoke' ? hooks.registerInterest(row.guild_id, String(body.panelId)) : undefined;
      this.actions += 1;
      this.runningActions.set(row.id, { op, guildId: row.guild_id, at: claimedAt });
      const stillRuns = setTimeout(() => {
        console.warn(`[GuildRequests] The ${op} of server ${row.guild_id} sent from ${row.requested_by} still runs after ${Math.round((leftMs + ANSWER_MARGIN_MS) / 1000)} s; its sender read can't confirm`);
      }, leftMs + ANSWER_MARGIN_MS);
      (stillRuns as any).unref?.();
      // Opening a panel keeps no view: its page holds at least the kept state from before the panel was drawn.
      const opened = op === 'panel:execute' && typeof since === 'number' ? liveVersionOf(row.guild_id, String(body.panelId), since) : 0;
      reply = (async () => {
        try {
          const answer = op === 'command:invoke' ? await hooks.answerInvoke(body, lookup) : await hooks.answerPanel(op, body);
          if (since === undefined || !answer || typeof answer !== 'object') return answer;
          let liveVersion = opened;
          if (since !== null && VIEW_CHANGE_OPS.includes(op)) liveVersion = recordActionView(row.guild_id, String(body.panelId), since, answer) ?? 0;
          return { ...answer, liveSince: since, liveVersion };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        } finally {
          clearTimeout(stillRuns);
          this.actions -= 1;
          this.runningActions.delete(row.id);
        }
      })();
    }
    const entry: Started = { reply, batch, epoch, at: claimedAt };
    this.started.set(row.id, entry);
    this.track(this.answerPanelLatest(entry, row, batch, claimedAt + leftMs + ANSWER_MARGIN_MS));
  }

  /** Only the latest claim of an action writes its answer, under that claim's batch; the entry then keeps the shrunk answer. */
  private async answerPanelLatest(entry: Started, row: ClaimedRow, batch: string, senderGone: number | null): Promise<void> {
    const answer = await entry.reply;
    if (entry.batch !== batch) return;
    const late = senderGone !== null && performance.now() > senderGone;
    await this.writePanelAnswer(row, batch, answer, () => entry.batch !== batch, entry.epoch, late);
    entry.reply = Promise.resolve(keptAnswer(answer));
  }

  /** Writes the answer to the row and logs whether its statement's count or its read-back confirmed it. */
  private async writePanelAnswer(row: ClaimedRow, batch: string, answer: any, superseded: () => boolean, at: number | null, late: boolean): Promise<void> {
    const { text } = toTransport(answer, ANSWER_LIMIT_BYTES);
    const outcome = panelOutcomeOf(answer);
    const from = `server ${row.guild_id} sent from ${row.requested_by}`;
    const done = () => {
      if (late) console.warn(`[GuildRequests] The ${row.op} of ${from} ended after its sender stopped waiting: ${outcome}`);
      else console.log(`[GuildRequests] ${row.op} for server ${row.guild_id}, sent from ${row.requested_by}: ${outcome}`);
    };
    const until = performance.now() + ACTION_ANSWER_FOR_MS;
    let cause = 'no attempt answered';
    let mayHaveLanded = false;
    for (;;) {
      let answering = true;
      try {
        const res = await this.deps.db.query(ANSWER_SQL, [row.id, batch, text], ANSWER_BOUND_MS, at, true);
        answering = false;
        if ((res.rowCount ?? 0) > 0) {
          done();
          return;
        }
        if (superseded()) return;
        const back = (await this.deps.db.query(ANSWER_READ_BACK_SQL, [row.id], ANSWER_BOUND_MS, at, true)).rows[0];
        if (back && back.reply === text) {
          done();
          return;
        }
        console.warn(`[GuildRequests] The ${row.op} of ${from} ended (${outcome}), but its row holds another answer or none; its sender may have read that answer or can't confirm`);
        return;
      } catch (error) {
        cause = describeFailure(error);
        const notSent = (error as { notSent?: boolean })?.notSent === true;
        if (answering && !notSent && failureOf(error).kind === 'unknown') mayHaveLanded = true;
        if (error instanceof RequestsStoppedError && !error.notSent) {
          console.error(`[GuildRequests] Can't confirm whether the answer to the ${row.op} of ${from} was recorded: this process stopped writing to its database while it waited${error.why === null ? '' : ` (${error.why})`}; its sender reads that answer or can't confirm. The answer was: ${outcome}`);
          return;
        }
        if (error instanceof RequestsStoppedError) break;
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

  /** NB15 decision 8: the reads of a pass, written in groups of at most 256 KiB, each retried for 10 s while it fails. */
  private async answerReads(reads: Array<{ row: ClaimedRow; answer: Promise<any> }>, batch: string, epoch: number | null): Promise<void> {
    const answered = await Promise.all(reads.map(async r => {
      const answer = await r.answer;
      return { row: r.row, text: toTransport(answer, ANSWER_LIMIT_BYTES).text };
    }));
    const groups: Array<typeof answered> = [];
    let current: typeof answered = [];
    let bytes = 0;
    for (const item of answered) {
      const size = Buffer.byteLength(item.text, 'utf8');
      if (current.length > 0 && bytes + size > READ_GROUP_BYTES) {
        groups.push(current);
        current = [];
        bytes = 0;
      }
      current.push(item);
      bytes += size;
    }
    if (current.length > 0) groups.push(current);
    for (const group of groups) await this.writeReadGroup(group, batch, epoch);
  }

  private async writeReadGroup(group: Array<{ row: ClaimedRow; text: string }>, batch: string, at: number | null): Promise<void> {
    const ids = group.map(g => g.row.id);
    const until = performance.now() + ACTION_ANSWER_FOR_MS;
    let cause = 'no attempt answered';
    let mayHaveLanded = false;
    for (;;) {
      try {
        const res = await this.deps.db.query(READ_ANSWERS_SQL, [ids, group.map(g => g.text), batch], ANSWER_BOUND_MS, at, true);
        if ((res.rowCount ?? 0) >= group.length) return;
        break;
      } catch (error) {
        cause = describeFailure(error);
        const notSent = (error as { notSent?: boolean })?.notSent === true;
        if (!notSent && (error instanceof RequestsStoppedError || failureOf(error).kind === 'unknown')) mayHaveLanded = true;
        if (error instanceof RequestsStoppedError) break;
      }
      if (performance.now() + ANSWER_RETRY_MS > until) break;
      await sleep(ANSWER_RETRY_MS);
    }
    try {
      const back = (await this.deps.db.query(READ_ANSWERS_READ_BACK_SQL, [ids], ANSWER_BOUND_MS, at, true)).rows;
      for (const g of group) {
        const row = back.find((b: any) => b.id === g.row.id);
        if (row && row.reply === g.text) continue;
        console.warn(`[GuildRequests] The ${g.row.op} of server ${g.row.guild_id} sent from ${g.row.requested_by} was answered, but its row holds another answer or none (${cause}); its sender may have read that answer or can't confirm`);
      }
    } catch (error) {
      if (mayHaveLanded) {
        console.error(`[GuildRequests] Can't confirm whether the answers to ${group.length} reads sent from other machines were recorded: an attempt that got no answer may have landed, and the read-back failed (${describeFailure(error)}); their senders read those answers or can't confirm`);
        return;
      }
      console.error(`[GuildRequests] Could not record the answers to ${group.length} reads sent from other machines (${describeFailure(error)}); their senders read can't confirm`);
    }
  }

  /** Only the latest claim of a request writes its answer, under that claim's batch. */
  private async answerLatest(entry: Started, row: ClaimedRow, batch: string, req: GuildDataWriteRequest, until: number): Promise<void> {
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
        const res = await this.deps.db.query(ANSWER_SQL, [row.id, batch, text], ANSWER_BOUND_MS, at, true);
        answering = false;
        if ((res.rowCount ?? 0) > 0) {
          console.log(`[GuildRequests] ${row.op}${file} for server ${row.guild_id}, sent from ${row.requested_by}: ${outcome}`);
          return;
        }
        if (superseded()) return;
        const back = (await this.deps.db.query(ANSWER_READ_BACK_SQL, [row.id], ANSWER_BOUND_MS, at, true)).rows[0];
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

  /** NB7 ruling 6: the ids this process started stay out of the statement for an hour after their claim. */
  private startedIds(): string[] {
    this.prune();
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
      await this.deps.db.query(CLEANUP_BODIES_SQL, [], CLEANUP_BOUND_MS);
    } catch { /* the next cleanup empties them */ }
    try {
      await this.deps.db.query(CLEANUP_SQL, [], CLEANUP_BOUND_MS);
    } catch { /* the next cleanup deletes them */ }
  }

  private notePlacesFull(): void {
    const now = performance.now();
    if (now - this.lastPlacesLog < PLACES_LOG_MS) return;
    this.lastPlacesLog = now;
    const list = [...this.runningActions.values()].map(a => `${a.op} of server ${a.guildId} for ${Math.round((now - a.at) / 1000)} s`).join(', ');
    console.warn(`[GuildRequests] ${MAX_ACTIONS} panel actions or commands sent from other machines still run (${list}); new ones are not taken until one ends or this bot restarts`);
  }

  private noteUnprotected(): void {
    const now = performance.now();
    if (!this.unprotected || now - this.lastUnprotectedLog >= UNPROTECTED_LOG_MS) {
      console.error(UNPROTECTED_LINE);
      this.lastUnprotectedLog = now;
    }
    this.unprotected = true;
  }

  private noteProtected(): void {
    this.unprotected = false;
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

/** NB15 decision 8: of the asked ids, those whose shard is in this process's lease and that the client holds available. */
export function membershipOf(ids: string[], shardCount: number): Record<string, unknown> {
  const lease = getDataReadiness()?.leasedShards() ?? null;
  const client = getPanelManager().getClient() as any;
  const leased = new Set(lease && lease.shardCount === shardCount ? lease.shardIds : []);
  const guilds: Array<Record<string, unknown>> = [];
  const touched = new Set<number>();
  for (const id of ids) {
    const shard = shardOfGuild(id, shardCount);
    if (!leased.has(shard)) continue;
    touched.add(shard);
    const guild = client?.guilds?.cache?.get(id);
    if (guild && guild.available !== false) guilds.push({ id: guild.id, name: guild.name, icon: guild.icon, memberCount: guild.memberCount });
  }
  const answer: Record<string, unknown> = { success: true, guilds };
  if (touched.size > 0 && cacheIncomplete(client, [...touched])) answer.incomplete = true;
  return answer;
}

const realPanelHooks: PanelHooks = {
  answerPanel: (op, body) => answerPanelMessage(op, body, 'request'),
  answerInvoke: (body, lookup) => answerInvokeMessage(body, 'request', lookup),
  maintenanceRefusal: op => maintenanceIpcRefusal(op),
  getPanel: panelId => getPanelManager().getPanel(panelId),
  getCommand: name => findLocalCommand(name),
  guildWebUi: () => guildWebUiEnabled(),
  membership: membershipOf,
  registerInterest: (guildId, panelId) => registerInterest(guildId, panelId),
};

/** The sweep's pool: its own, so flushes and hydrates that hold the data pool never push a pickup past 5 s. */
function pgSweepDb(config: ClientConfig, gate: SweepGate): { db: SweepDb; pool: Pool } {
  const pool = new Pool({
    max: SWEEP_POOL_MAX,
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
  classifyPoolClients(pool, config);
  return { db: reservedSweepDb(gatedSweepDb(pool, gate), SWEEP_POOL_MAX - 1), pool };
}

/**
 * The answers, read-backs and cleanup share `others` connections of the pool, one statement on each, so the pass's
 * claim and unanswered statement always find a free one and never queue behind them.
 */
export function reservedSweepDb(db: SweepDb, others: number, waitMs = RESERVED_WAIT_MS): SweepDb {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async query(text, values, boundMs, at, carries) {
      if (PASS_STATEMENTS.includes(text)) return db.query(text, values, boundMs, at, carries);
      if (active >= others) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            const index = waiting.indexOf(handOver);
            if (index >= 0) waiting.splice(index, 1);
            reject(Object.assign(new Error('timeout exceeded when trying to connect'), { notSent: true }));
          }, waitMs);
          const handOver = () => {
            clearTimeout(timer);
            resolve();
          };
          waiting.push(handOver);
        });
      } else active += 1;
      try {
        return await db.query(text, values, boundMs, at, carries);
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active -= 1;
      }
    },
  };
}

/** A pool as gatedSweepDb uses it: node-pg's, or a test's fake. */
export interface SweepPool {
  connect(): Promise<{ query(config: unknown): Promise<any>; release(destroy?: boolean): void }>;
}

/**
 * One statement on one client of the pool, through NB5 G9's three checks: at the entry (an earlier epoch, then the
 * backend's refusal; nothing connects), after the connect (the epoch moved: the client is destroyed, nothing is sent),
 * and at the answer (the epoch moved: the answer is dropped, since the statement may have applied). A statement that
 * carries a body or an answer is not sent on a client classed 'unprotected' (NB15 decision 21).
 */
export function gatedSweepDb(pool: SweepPool, gate: SweepGate): SweepDb {
  return {
    async query(text, values, boundMs, at, carries) {
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
      if (carries && transportClassOf(client) === 'unprotected') {
        client.release();
        throw new UnprotectedTransportError();
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

/** The bot's Postgres backend, or null on a JSON bot. */
export function pgBackendOf(): PostgresBackend | null {
  const backend = getGuildDataBackend();
  return backend instanceof PostgresBackend ? backend : null;
}

/** NB5 G9: the gate of this process's data backend; it passes everything on a JSON bot. */
export const backendGate: SweepGate = {
  epoch: () => pgBackendOf()?.databaseEpoch() ?? null,
  refusal: () => pgBackendOf()?.refusalDetail() ?? null,
  stopWhy: () => getShardClaims()?.databaseStopWhy() ?? null,
};

let sharedDb: SweepDb | null = null;
let sweep: GuildRequestSweep | null = null;

/** NB5 G9: the pool of the chosen entry, built again when a move changes it; the old pool ends in the background. */
function poolDb(): SweepDb {
  if (!sharedDb) {
    const backend = pgBackendOf();
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
  async query(text, values, boundMs, at, carries) {
    let db: SweepDb;
    try {
      db = poolDb();
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { notSent: true });
    }
    return db.query(text, values, boundMs, at, carries);
  },
};

/** Tests send a statement through the sweep's pool. */
export function _sweepDbForTests(): SweepDb {
  return currentDb;
}

/** Tests drop the pool built for an earlier test's backend. */
export function _resetGuildRequestPool(): void {
  sharedDb = null;
  sweep?.stop();
  sweep = null;
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

/** NB6 decision 17: a notify for this process asks the sweep for a pass; nothing while no sweep runs. */
export function requestGuildRequestPass(): void {
  sweep?.requestPass();
}

/** The stop step after the exit drain, before the claims' release: finished applies' answers get 2 s to be written. */
export async function guildRequestsStopStep(): Promise<void> {
  await sweep?.stopStep();
}

export { isActionOp };
