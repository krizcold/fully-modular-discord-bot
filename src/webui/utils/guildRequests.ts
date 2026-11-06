// A guild change on a Postgres bot whose server another machine runs (NB7): the plan picks the local route (this
// machine's bot process applies it) or the request route (a row of smdb_data.guild_requests that the bot process
// holding the guild's shard claims, applies and answers). The sender follows its row and answers by its deadline:
// "nothing was saved" only when no process started the change and none can, "can't confirm" when that is unknown.

import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import type { QueryConfig } from 'pg';
import { resolveDataBackend } from '../../utils/envLoader';
import { keyRefusal, pathKeyOf, sizeRefusal, textRefusal } from '../../bot/internalSetup/utils/storableData';
import {
  CLAIM_SPAN_S,
  MAX_GUILD_ID,
  REQUEST_INSERT_SQL,
  REQUEST_POLL_SQL,
  SETTLE_INSERT_SQL,
  SETTLE_UPDATE_SQL,
  answerSpanS,
  changeDeadlineMs,
  failureOf,
  type GuildRequestOp,
} from '../../bot/internalSetup/utils/dataBackends/guildRequestSql';
import { holderStateOf, type HolderCheck } from '../../bot/internalSetup/fleet/claimStore';
import { getNodeName } from '../../bot/internalSetup/fleet/nodeName';
import type { GuildDataWriteRequest } from '../../bot/internalSetup/utils/ipcDataHandler';
import { guardPoolClients } from '../../bot/internalSetup/utils/pgClient';
import { connectWithin, getWebuiDataReader, resolveWebuiDatabase } from './webuiDataReader';
import { pgConfig } from '../../utils/databaseAddress';
import { readThisNodeId } from './nodeIdRead';
import { ROUTE_TEXT, type BotManager } from '../botManager';

export const REQUESTS_APPLICATION_NAME = 'smdb-webui-requests';
const REQUEST_POOL_MAX = 2;
const STEP_BOUND_MS = 5000;
const POLL_BOUND_MS = 2000;
const POLL_EVERY_MS = 250;
const SETTLE_RETRY_MS = 1000;
const FOLLOW_MARGIN_MS = 5000;
const SEND_MARGIN_MS = 15_000;
const CHECK_BOUND_MS = 10_000;
const EXIT_SETTLE_MS = 2000;

export const OP_WORDS: Record<GuildRequestOp, string> = {
  write: 'saved',
  delete: 'deleted',
  'delete-namespace': 'removed',
  'restore-graveyard': 'restored',
};

const shardWords = (shardId: number, shardCount: number) => `shard ${shardId} of ${shardCount}`;

export const NB7_TEXTS = {
  noCount: (saved: string) => `No machine has taken this bot's shards on this database yet; nothing was ${saved}. Start the bot, then try again.`,
  noRow: (shardId: number, shardCount: number, saved: string) => `No machine runs this server's shard (${shardWords(shardId, shardCount)}) right now; nothing was ${saved}. Try again once a machine has taken it; the Usage tab's Claims table on a machine whose bot runs shows who holds each shard.`,
  deferred: (shardId: number, shardCount: number, name: string, saved: string) => `This server's shard (${shardWords(shardId, shardCount)}) waits for ${name} to restart; nothing was ${saved}. Try again once ${name} runs it.`,
  kept: (shardId: number, shardCount: number, name: string, saved: string) => `This server's shard (${shardWords(shardId, shardCount)}) is kept for ${name} while its bot restarts; nothing was ${saved}. Try again once ${name} runs it.`,
  reserved: (shardId: number, shardCount: number, name: string, saved: string) => `${name} is restarting to take this server's shard (${shardWords(shardId, shardCount)}); nothing was ${saved}. Try again in a moment.`,
  lookupRefused: (code: string, message: string, saved: string) => `The database refused the lookup of the machine that runs this server (SQLSTATE ${code}: ${message}); nothing was ${saved}.`,
  lookupUnreachable: (cause: string, saved: string) => `Can't get an answer from the database to find the machine that runs this server (${cause}); nothing was ${saved}. Try again in a moment.`,
  tooSlow: (name: string, saved: string) => `The database answered too slowly to send this change to ${name} in time; nothing was ${saved}. Try again in a moment.`,
  noTable: (saved: string) => `This database has no table for changes sent between machines: it was created by an older version of the bot. Nothing was ${saved}.`,
  insertRefused: (code: string, message: string, saved: string) => `The database refused the change (SQLSTATE ${code}: ${message}); nothing was ${saved}.`,
  unreachable: (name: string, cause: string, saved: string) => `Can't reach the database to send this change to ${name} (${cause}); nothing was ${saved}. Try again in a moment.`,
  notTaken: (name: string, saved: string) => `${name} did not take the change within 5 s; nothing was ${saved}. Try again in a moment; if it keeps happening, check the bot on ${name}.`,
  withdrawnAtExit: (name: string, saved: string) => `This web panel is shutting down, so the change sent to ${name} was withdrawn before ${name} took it; nothing was ${saved}. Try again once the panel is back.`,
  withdrawn: (name: string, saved: string) => `The database did not confirm that the change was sent to ${name}, so it was withdrawn; nothing was ${saved}. Try again in a moment.`,
  stoppedServing: (name: string, saved: string) => `On ${name}: the bot stopped serving this server before it applied the change; nothing was ${saved}. Try again in a moment.`,
  unapplied: (name: string, saved: string) => `${name} did not apply the change; nothing was ${saved}. Try again in a moment.`,
  twin: (name: string) => `The module's global config on ${name} differs from this machine's, so this server's overrides cannot be worked out here; nothing was saved. Save it from the web panel on ${name}, or make the module's global config the same on both machines.`,
  heldNotice: (name: string) => `This server runs on ${name}: this was read from the database, and a change ${name} has not saved yet is not in it.`,
  noHolderNotice: "No machine runs this server's shard right now: this was read from the database.",
  readLookupFailed: (cause: string) => `This machine's bot does not run this server, and the database could not be read to find the one that does (${cause}); nothing was changed. Try again in a moment.`,
};

/**
 * The can't confirm text of a change another machine applies, by what it changed (sendHopReply's what). 'unsettled':
 * the change was withdrawn on a database server other than the one it was sent to, which proves nothing.
 */
export function remoteNoAnswerText(cause: unknown, name: string, what: 'write' | 'delete' | 'guild-delete'): string {
  const lead = cause === 'lost'
    ? `The answer from ${name} could not be read from the database`
    : cause === 'unsettled'
      ? `The database could not show that the change sent to ${name} was withdrawn before ${name} took it`
      : cause === 'stopped'
        ? `This web panel shut down before it read the answer from ${name}`
        : `${name} did not answer in time`;
  if (what === 'guild-delete') {
    return `${lead}; can't confirm whether this server's data was deleted. Within a minute, \`smdb graveyard list\` lists a new entry for this server with the reason webui-operator-delete if it was deleted; if no such entry is listed by then, it was not. The list reads the data of the bot behind the web panel it asks; if the main database was replaced meanwhile, check once that bot runs on the new main.`;
  }
  const check = cause === 'stopped' ? 'Reload once the panel is back to check.' : 'Reload to check.';
  return `${lead}; can't confirm whether ${what === 'delete' ? 'the file was deleted' : 'the change was saved'}. ${check}`;
}

/** The restore's can't confirm cause, in place of NB11's "the bot did not answer within 50 s". */
export function remoteRestoreNoAnswerCause(cause: unknown, name: string): string {
  if (cause === 'unsettled') return `the database could not show that the restore sent to ${name} was withdrawn before ${name} took it`;
  if (cause === 'stopped') return `this web panel shut down before it read the answer from ${name}`;
  return cause === 'lost' ? `the answer from ${name} could not be read from the database` : `${name} did not answer in time`;
}

type NoAnswerCause = 'timeout' | 'lost' | 'unsettled' | 'stopped';

export interface RequestConn {
  /** The database server instance the connection reached: its system identifier and start time. */
  server?: string;
  query(text: string, values: unknown[], boundMs: number): Promise<{ rows: any[]; rowCount?: number | null }>;
  release(destroy?: boolean): void;
}

export interface RequestDb {
  connect(boundMs: number): Promise<RequestConn>;
  end(): Promise<void>;
}

export interface GuildRequestDeps {
  /** url: the database the rows were read from, when the reader knows it. */
  holderOf(guildId: string, boundMs: number): Promise<{ rows: any[]; url?: string }>;
  readDoc(guildId: string, module: string, filename: string, boundMs?: number): Promise<string | null>;
  currentUrl(): string | null;
  /** Why the web UI uses no database now (NB5 decision 17); null while it has one. */
  currentRefusal(): string | null;
  requestDb(url: string): RequestDb;
  nodeId(): string | null;
  nodeName(): string;
}

/** A restart or a promoted standby behind the same URL answers with another value. */
export const SERVER_IDENTITY_SQL = `SELECT (SELECT system_identifier::text FROM pg_control_system())
       || ' started ' || extract(epoch FROM pg_postmaster_start_time())::text AS server`;

/** One request pool per database URL: the insert, the follow's polls and the settle; NB3's session count counts it. */
function pgRequestDb(url: string): RequestDb {
  const pool = new Pool({
    max: REQUEST_POOL_MAX,
    connectionTimeoutMillis: STEP_BOUND_MS,
    idleTimeoutMillis: 1000,
    keepAlive: true,
    application_name: REQUESTS_APPLICATION_NAME,
    statement_timeout: 4000,
    idle_in_transaction_session_timeout: 10_000,
    ...pgConfig(url),
  } as ConstructorParameters<typeof Pool>[0]);
  pool.on('error', () => { /* an idle client's error; the next statement answers for itself */ });
  guardPoolClients(pool, "the web UI's request pool");
  const servers = new WeakMap<object, string>();
  return {
    async connect(boundMs) {
      const started = performance.now();
      const client = await connectWithin(pool, boundMs, "the web UI's request pool", REQUEST_POOL_MAX);
      let server = servers.get(client);
      if (server === undefined) {
        try {
          const res = await client.query({ text: SERVER_IDENTITY_SQL, query_timeout: Math.max(1, boundMs - (performance.now() - started)) } as QueryConfig);
          server = String(res.rows[0]?.server);
        } catch (error) {
          client.release(true);
          throw error;
        }
        servers.set(client, server);
      }
      return {
        server,
        query: async (text, values, bound) => client.query({ text, values, query_timeout: Math.max(1, bound) } as QueryConfig),
        release: destroy => client.release(destroy ? true : undefined),
      };
    },
    end: () => pool.end().catch(() => undefined),
  };
}

const realDeps: GuildRequestDeps = {
  holderOf: (guildId, boundMs) => getWebuiDataReader().holderOf(guildId, boundMs),
  readDoc: (guildId, module, filename, boundMs) => getWebuiDataReader().readDoc(guildId, module, filename, boundMs),
  currentUrl: () => {
    const resolved = resolveWebuiDatabase();
    return 'entry' in resolved ? resolved.entry : null;
  },
  currentRefusal: () => {
    const resolved = resolveWebuiDatabase();
    return 'refusal' in resolved ? resolved.refusal : null;
  },
  requestDb: pgRequestDb,
  nodeId: readThisNodeId,
  nodeName: getNodeName,
};
let deps: GuildRequestDeps = realDeps;

/** Tests build the request pool of an entry to read its config. */
export function _pgRequestDbForTests(url: string): RequestDb {
  return pgRequestDb(url);
}

/** Tests script the database, the reader and this machine's identity. */
export function _setGuildRequestDeps(over: Partial<GuildRequestDeps> | null): void {
  deps = over ? { ...realDeps, ...over } : realDeps;
}

export interface RemoteHolder {
  shardCount: number;
  shardId: number;
  processId: string;
  name: string;
  /** The database the check ran on: the request's insert, follow and settle go there. */
  url: string;
}

/** A change's route, decided once before its read; a local plan becomes a request or a refusal on a not-held reply. */
export interface Plan {
  kind: 'json' | 'refuse' | 'local' | 'request';
  op: GuildRequestOp;
  /** T on performance.now(): 60 s for a write or a delete, 90 s for a restore or a namespace delete. */
  deadline: number;
  reply?: any;
  holder?: RemoteHolder;
}

export type CheckAnswer =
  | { kind: 'held'; holder: RemoteHolder; thisNode: boolean }
  | { kind: 'no-holder'; check: HolderCheck }
  | { kind: 'failed'; error: unknown };

/** Decision 4's holder check on the reader pool, bounded by the deadline. */
export async function runHolderCheck(guildId: string, deadline = performance.now() + CHECK_BOUND_MS): Promise<CheckAnswer> {
  try {
    const current = deps.currentUrl();
    if (!current) throw new Error(deps.currentRefusal() ?? 'no database');
    const res = await deps.holderOf(guildId, Math.max(0, Math.min(CHECK_BOUND_MS, deadline - performance.now())));
    const url = res.url ?? current;
    const check = holderStateOf(res.rows);
    if (check.kind === 'row' && check.state === 'held') {
      const here = deps.nodeId();
      return {
        kind: 'held',
        holder: { shardCount: check.shardCount, shardId: check.shardId, processId: check.holderProcess!, name: check.holderName!, url },
        thisNode: here !== null && check.holderNode === here,
      };
    }
    return { kind: 'no-holder', check };
  } catch (error) {
    return { kind: 'failed', error };
  }
}

function noHolderReply(check: HolderCheck, op: GuildRequestOp): any {
  const saved = OP_WORDS[op];
  let error: string;
  if (check.kind === 'no-count') error = NB7_TEXTS.noCount(saved);
  else if (check.state === 'expired-deferred') error = NB7_TEXTS.deferred(check.shardId, check.shardCount, check.holderName!, saved);
  else if (check.state === 'kept') error = NB7_TEXTS.kept(check.shardId, check.shardCount, check.holderName!, saved);
  else if (check.state === 'reserved') error = NB7_TEXTS.reserved(check.shardId, check.shardCount, check.holderName!, saved);
  else error = NB7_TEXTS.noRow(check.shardId, check.shardCount, saved);
  return { ok: false, code: 'no-holder', error, sender: true };
}

function checkFailedReply(error: unknown, op: GuildRequestOp): any {
  const saved = OP_WORDS[op];
  const failure = failureOf(error);
  if (failure.kind === 'refused' && failure.code === '28000') return { ok: false, code: 'maintenance', sender: true };
  if (failure.kind === 'refused') return { ok: false, code: 'backend-unavailable', error: NB7_TEXTS.lookupRefused(failure.code, failure.message, saved), sender: true };
  return { ok: false, code: 'backend-unavailable', error: NB7_TEXTS.lookupUnreachable(failure.cause, saved), sender: true };
}

/** Whether a guild id is a snowflake the holder check can cast to bigint. */
export function inGuildIdRange(guildId: string): boolean {
  return /^\d+$/.test(guildId) && BigInt(guildId) <= MAX_GUILD_ID;
}

/** Decision 3: the route of a guild change, before its read. A JSON bot keeps NB10's route ('json'). */
export async function planGuildChange(botManager: BotManager, guildId: string, op: GuildRequestOp): Promise<Plan> {
  const deadline = performance.now() + changeDeadlineMs(op);
  if (resolveDataBackend() !== 'postgres') return { kind: 'json', op, deadline };
  const refuse = (reply: any): Plan => ({ kind: 'refuse', op, deadline, reply });
  if (!inGuildIdRange(guildId)) return refuse({ ok: false, code: 'invalid', error: 'Invalid guild ID format' });
  const route = botManager.writerRoute('guild', { postgresGuild: true });
  if (route.route === 'child') return { kind: 'local', op, deadline };
  if (route.route === undefined && route.code === 'stopping' && route.error === ROUTE_TEXT.exiting) return refuse(route);
  const nb10 = route.route === undefined ? route : { ok: false, status: 503, code: 'bot-down', error: 'the bot process is not running' };
  const check = await runHolderCheck(guildId, deadline);
  if (check.kind === 'held' && !check.thisNode) return { kind: 'request', op, deadline, holder: check.holder };
  if (check.kind === 'no-holder') return refuse(noHolderReply(check.check, op));
  return refuse(nb10);
}

/** A not-held reply on the local route: the holder check's answer is the plan from then on. */
export async function switchOnNotHeld(plan: Plan, guildId: string): Promise<void> {
  const check = await runHolderCheck(guildId, plan.deadline);
  if (check.kind === 'held') {
    plan.kind = 'request';
    plan.holder = check.holder;
    return;
  }
  plan.kind = 'refuse';
  plan.reply = check.kind === 'no-holder' ? noHolderReply(check.check, plan.op) : checkFailedReply(check.error, plan.op);
}

/** Sends a planned change: NB10's route for a JSON bot or a local plan, the request route otherwise. */
export async function sendGuildChange(botManager: BotManager, plan: Plan, payload: GuildDataWriteRequest): Promise<any> {
  if (plan.kind === 'refuse') return plan.reply;
  if (plan.kind === 'json') return botManager.writeGuildData(payload);
  if (plan.kind === 'local') {
    const reply = await botManager.writeGuildData(payload);
    if (reply?.code !== 'not-held') return reply;
    await switchOnNotHeld(plan, payload.guildId);
    if ((plan.kind as Plan['kind']) !== 'request') return plan.reply;
  }
  return sendRequest(plan, payload);
}

interface Followed {
  id: string;
  op: GuildRequestOp;
  guildId: string;
  name: string;
  db: RequestDb;
  /** The insert's first eight values, which the insert-form settle carries. */
  values: unknown[];
  /** Which settle form to send: 'acked' once the row is known to be there. */
  insert: 'sending' | 'acked' | 'unknown';
  /** The insert had no answer; never reset. */
  insertUnknown: boolean;
  /** The server instance the insert went to: a withdrawal proves nothing on another. */
  server?: string;
  stopped: boolean;
  /** The one settle in flight, shared by the route and the exit. */
  settling: Promise<Settled> | null;
  exitSettle: Promise<Settled> | null;
  /** The exit's settle and, when it did not withdraw, the row the exit read after it. */
  exitRead: Promise<ExitRead> | null;
  lastSettle: Settled | null;
  /** A settle was sent before the web UI's exit: an 'expired' row may be that settle's withdrawal. */
  settledBeforeStop: boolean;
  /** The exit's own settle withdrew the change. */
  withdrawnAtExit: boolean;
}

interface ExitRead {
  outcome: Settled;
  row?: any;
  server?: string;
}

let exiting = false;
let ending: Promise<void> | null = null;
const followed = new Set<Followed>();
const pools = new Map<string, { db: RequestDb; users: number }>();

function acquirePool(url: string): RequestDb {
  let entry = pools.get(url);
  if (!entry) {
    entry = { db: deps.requestDb(url), users: 0 };
    pools.set(url, entry);
  }
  entry.users += 1;
  return entry.db;
}

function releasePool(url: string): void {
  const entry = pools.get(url);
  if (!entry) return;
  entry.users -= 1;
  if (entry.users <= 0 && deps.currentUrl() !== url) {
    pools.delete(url);
    void entry.db.end().catch(() => undefined);
  }
}

/** Tests start each case with no exit and no pools. */
export function _resetGuildRequests(): void {
  exiting = false;
  ending = null;
  followed.clear();
  pools.clear();
}

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, Math.max(0, ms)); });
const left = (deadline: number) => deadline - performance.now();

function bodyOf(payload: GuildDataWriteRequest): string {
  return JSON.stringify({
    module: payload.module ?? '',
    filename: payload.filename ?? '',
    contentJson: payload.contentJson,
    expectSha: payload.expectSha,
    twin: payload.twin,
    sinceOpen: payload.sinceOpen,
  });
}

/** One statement on a connection of the request's pool, bounded by its own bound cut to the deadline. */
async function statement(db: RequestDb, sql: string, values: unknown[], boundMs: number): Promise<{ rows: any[]; server?: string }> {
  const started = performance.now();
  const conn = await db.connect(boundMs);
  try {
    const res = await conn.query(sql, values, Math.max(1, boundMs - (performance.now() - started)));
    conn.release();
    return { rows: res.rows, server: conn.server };
  } catch (error) {
    conn.release(true);
    throw error;
  }
}

/**
 * 'withdrawn': this settle made the row 'expired' on the server instance the insert went to, so no process started it
 * and none can. 'unproven': it did so on another instance, where the row's absence or pending state proves nothing.
 */
type Settled = 'withdrawn' | 'unproven' | 'not-pending' | 'failed';

async function settleOnce(req: Followed, boundMs: number): Promise<Settled> {
  const atExit = req.stopped;
  if (!atExit) req.settledBeforeStop = true;
  let outcome: Settled;
  try {
    const res = req.insert === 'acked'
      ? await statement(req.db, SETTLE_UPDATE_SQL, [req.id], boundMs)
      : await statement(req.db, SETTLE_INSERT_SQL, req.values, boundMs);
    if (res.rows.length > 0) {
      outcome = res.server === req.server ? 'withdrawn' : 'unproven';
    } else {
      // The row is there and not pending (applying, done or expired): no late insert can follow it.
      if (req.insert !== 'acked') req.insert = 'acked';
      outcome = 'not-pending';
    }
  } catch {
    outcome = 'failed';
  }
  req.lastSettle = outcome;
  if (outcome === 'withdrawn' && atExit) req.withdrawnAtExit = true;
  return outcome;
}

/** The request's one settle: one already in flight is joined, never sent twice. */
function settleShared(req: Followed, boundMs: number): Promise<Settled> {
  if (!req.settling) {
    const run = settleOnce(req, boundMs);
    req.settling = run;
    void run.finally(() => { if (req.settling === run) req.settling = null; });
  }
  return req.settling;
}

/** The settle, retried every 1 s until the deadline; once the web UI exits, the exit's settle is the answer. */
async function settleUntil(req: Followed, deadline: number): Promise<Settled> {
  for (;;) {
    if (req.stopped && req.exitSettle) return req.exitSettle;
    const outcome = await settleShared(req, Math.max(1, Math.min(STEP_BOUND_MS, left(deadline))));
    if (outcome !== 'failed' || req.stopped || left(deadline) <= SETTLE_RETRY_MS) return outcome;
    await sleep(SETTLE_RETRY_MS);
  }
}

/** Decision 6: the request route's send, then decision 8's follow and settle. */
async function sendRequest(plan: Plan, payload: GuildDataWriteRequest): Promise<any> {
  const holder = plan.holder!;
  const op = plan.op;
  const saved = OP_WORDS[op];
  const name = holder.name;
  const sender = (reply: Record<string, unknown>) => ({ ok: false, servedBy: name, sender: true, ...reply });
  if (op === 'write') {
    const reason = keyRefusal(pathKeyOf(payload.module ?? '', payload.filename ?? ''), 'save')
      ?? textRefusal(payload.contentJson, 'text') ?? sizeRefusal(payload.contentJson ?? '');
    if (reason) return { ok: false, code: 'invalid', error: `The data was not saved: ${reason}`, sender: true };
  }
  const db = acquirePool(holder.url);
  try {
    let conn: RequestConn;
    try {
      conn = await db.connect(Math.max(0, Math.min(STEP_BOUND_MS, left(plan.deadline))));
    } catch (error) {
      const failure = failureOf(error);
      if (failure.kind === 'refused' && failure.code === '28000') return { ok: false, code: 'maintenance', sender: true };
      return sender({ code: 'backend-unavailable', error: NB7_TEXTS.unreachable(name, describe(error), saved) });
    }
    // One synchronous run from here to the send: the exit flag, the time left, the followed set.
    if (exiting) {
      conn.release();
      return { ok: false, code: 'stopping', error: ROUTE_TEXT.exiting, sender: true };
    }
    if (left(plan.deadline) < (answerSpanS(op) * 1000) + SEND_MARGIN_MS) {
      conn.release();
      return sender({ code: 'backend-unavailable', error: NB7_TEXTS.tooSlow(name, saved) });
    }
    const values = [randomUUID(), payload.guildId, holder.shardCount, holder.shardId, holder.processId, op, bodyOf(payload), deps.nodeName()];
    const req: Followed = {
      id: values[0] as string, op, guildId: payload.guildId, name, db, values, insert: 'sending', insertUnknown: false,
      server: conn.server, stopped: false, settling: null, exitSettle: null, exitRead: null, lastSettle: null,
      settledBeforeStop: false, withdrawnAtExit: false,
    };
    followed.add(req);
    try {
      return await afterSend(req, conn, plan.deadline, sender);
    } finally {
      followed.delete(req);
    }
  } finally {
    releasePool(holder.url);
  }
}

function describe(error: unknown): string {
  const failure = failureOf(error);
  return failure.kind === 'refused' ? `SQLSTATE ${failure.code}: ${failure.message}` : failure.cause;
}

async function afterSend(req: Followed, conn: RequestConn, deadline: number, sender: (r: Record<string, unknown>) => any): Promise<any> {
  const saved = OP_WORDS[req.op];
  const noAnswer = (cause: NoAnswerCause) => sender({ code: 'no-answer', noAnswer: cause });
  const nothingSaved = () => (req.insertUnknown
    ? sender({ code: 'backend-unavailable', error: NB7_TEXTS.withdrawn(req.name, saved) })
    : req.withdrawnAtExit || (req.stopped && !req.settledBeforeStop)
      ? sender({ code: 'not-taken', error: NB7_TEXTS.withdrawnAtExit(req.name, saved) })
      : sender({ code: 'not-taken', error: NB7_TEXTS.notTaken(req.name, saved) }));
  const stoppedAnswer = () => stopAnswer(req, sender, noAnswer, nothingSaved);
  try {
    await conn.query(REQUEST_INSERT_SQL, [...req.values, CLAIM_SPAN_S, answerSpanS(req.op)], Math.max(1, Math.min(STEP_BOUND_MS, left(deadline))));
    conn.release();
    req.insert = 'acked';
  } catch (error) {
    conn.release(true);
    const failure = failureOf(error);
    if (failure.kind === 'refused') {
      if (failure.code === '28000') return { ok: false, code: 'maintenance', sender: true };
      if (failure.code === '42P01') return sender({ code: 'backend-unavailable', error: NB7_TEXTS.noTable(saved) });
      if (failure.code === '23505' && await exitHeldId(req, error)) {
        return sender({ code: 'not-taken', error: NB7_TEXTS.withdrawnAtExit(req.name, saved) });
      }
      return sender({ code: 'backend-unavailable', error: NB7_TEXTS.insertRefused(failure.code, failure.message, saved) });
    }
    if (req.insert === 'sending') req.insert = 'unknown';
    req.insertUnknown = true;
    if (req.stopped) return stoppedAnswer();
    const settled = await settleUntil(req, deadline);
    if (settled === 'withdrawn') return nothingSaved();
    if (settled === 'unproven') return noAnswer('unsettled');
    if (settled === 'failed') return req.stopped ? stoppedAnswer() : noAnswer('lost');
  }
  return follow(req, deadline, sender, noAnswer, nothingSaved);
}

/**
 * The insert's duplicate key on its own id, once the web UI exits: the exit's insert-form settle reached the server
 * first and withdrew the id there, so no process took the request.
 */
async function exitHeldId(req: Followed, error: unknown): Promise<boolean> {
  if ((error as { constraint?: unknown })?.constraint !== 'guild_requests_pkey') return false;
  if (!req.stopped || !req.exitSettle) return false;
  return (await req.exitSettle) === 'withdrawn';
}

async function follow(
  req: Followed,
  deadline: number,
  sender: (r: Record<string, unknown>) => any,
  noAnswer: (cause: NoAnswerCause) => any,
  nothingSaved: () => any,
): Promise<any> {
  const settledAnswer = (settled: Settled) => (settled === 'withdrawn' ? nothingSaved() : settled === 'unproven' ? noAnswer('unsettled') : null);
  const followEnd = deadline - FOLLOW_MARGIN_MS;
  let last: 'pending' | 'applying' | 'failing' | null = null;
  while (!req.stopped && performance.now() < followEnd) {
    let row: any;
    let server: string | undefined;
    let read = false;
    try {
      const res = await statement(req.db, REQUEST_POLL_SQL, [req.id], Math.max(1, Math.min(POLL_BOUND_MS, left(deadline))));
      row = res.rows[0];
      server = res.server;
      read = true;
    } catch {
      last = 'failing';
    }
    if (req.stopped) {
      // A row the poll read before the exit still answers: the holder's reply, or this request's own withdrawal.
      if (read && row?.state === 'done') return holderAnswer(req, row.reply, sender, noAnswer);
      if (read && row?.state === 'expired' && server === req.server) return nothingSaved();
      break;
    }
    if (read) {
      if (!row) {
        // The row was there: its absence means another database, which proves nothing.
        if (req.insert === 'acked') return noAnswer('lost');
        const settled = await settleUntil(req, deadline);
        const answer = settledAnswer(settled);
        if (answer) return answer;
        if (settled === 'failed') return req.stopped ? stopAnswer(req, sender, noAnswer, nothingSaved) : noAnswer('lost');
      } else if (row.state === 'done') {
        return holderAnswer(req, row.reply, sender, noAnswer);
      } else if (row.state === 'expired') {
        // Only a settle of this request writes 'expired'; on another server instance it proves nothing.
        return server === req.server ? nothingSaved() : noAnswer('unsettled');
      } else if (row.state === 'applying') {
        last = 'applying';
        if (row.answer_over === true) return noAnswer('timeout');
      } else {
        last = 'pending';
        if (row.pickup_over === true) {
          const settled = await settleUntil(req, deadline);
          const answer = settledAnswer(settled);
          if (answer) return answer;
          if (settled === 'failed') return req.stopped ? stopAnswer(req, sender, noAnswer, nothingSaved) : noAnswer('lost');
        }
      }
    }
    await sleep(Math.min(POLL_EVERY_MS, followEnd - performance.now()));
  }
  if (req.stopped) return stopAnswer(req, sender, noAnswer, nothingSaved);
  if (last === 'applying') return noAnswer('timeout');
  const settled = await settleUntil(req, deadline);
  const answer = settledAnswer(settled);
  if (answer) return answer;
  return noAnswer(last === 'failing' || settled === 'failed' ? 'lost' : 'timeout');
}

/**
 * The route's answer once the web UI exits: a withdrawal, or the row the exit read (the holder's answer, or this
 * request's withdrawal on its own server); otherwise can't confirm.
 */
async function stopAnswer(
  req: Followed,
  sender: (r: Record<string, unknown>) => any,
  noAnswer: (cause: NoAnswerCause) => any,
  nothingSaved: () => any,
): Promise<any> {
  if (req.lastSettle === 'withdrawn') return nothingSaved();
  const exit: ExitRead | null = req.exitRead ? await req.exitRead : req.exitSettle ? { outcome: await req.exitSettle } : null;
  if (!exit) return noAnswer('stopped');
  if (exit.outcome === 'withdrawn') return nothingSaved();
  if (exit.row?.state === 'done') return holderAnswer(req, exit.row.reply, sender, noAnswer);
  if (exit.row?.state === 'expired' && exit.server === req.server) return nothingSaved();
  return noAnswer('stopped');
}

/** Decision 9: the holder's reply as the sender answers it. */
function holderAnswer(req: Followed, text: unknown, sender: (r: Record<string, unknown>) => any, noAnswer: (cause: NoAnswerCause) => any): any {
  let reply: any;
  try {
    reply = JSON.parse(String(text));
  } catch {
    return noAnswer('lost');
  }
  if (!reply || typeof reply !== 'object') return noAnswer('lost');
  const saved = OP_WORDS[req.op];
  if (reply.code === 'not-held') return sender({ code: 'not-taken', error: NB7_TEXTS.stoppedServing(req.name, saved) });
  if (reply.code === 'not-taken' && reply.unapplied === true) return sender({ code: 'not-taken', error: NB7_TEXTS.unapplied(req.name, saved) });
  if (reply.code === 'changed' && reply.which === 'twin') return sender({ code: 'changed', status: 409, error: NB7_TEXTS.twin(req.name) });
  return { ...reply, servedBy: req.name };
}

/**
 * Decision 14, at the web UI's exit after NB10's local chain: no request sends its insert from now on, each followed
 * request's own follow stops, and each is settled once, all at once, within 2 s, with one log line each.
 */
export function endGuildRequests(): Promise<void> {
  if (!ending) ending = runEnd();
  return ending;
}

async function runEnd(): Promise<void> {
  exiting = true;
  const requests = [...followed];
  for (const req of requests) req.stopped = true;
  if (requests.length === 0) return;
  const end = performance.now() + EXIT_SETTLE_MS;
  const logged = new Set<Followed>();
  const log = (req: Followed, line: string, error = false) => {
    if (logged.has(req)) return;
    logged.add(req);
    if (error) console.error(line);
    else console.log(line);
  };
  const unknown = (req: Followed) => `[Main] Exiting; can't confirm whether the ${req.op} of server ${req.guildId} sent to ${req.name} was ${OP_WORDS[req.op]}`;
  const exitRead = async (req: Followed, settle: Promise<Settled>): Promise<ExitRead> => {
    const outcome = await settle;
    if (outcome === 'withdrawn' || outcome === 'unproven') return { outcome };
    // The row was not pending, or the settle had no answer: its state says which answer is true.
    try {
      const res = await statement(req.db, REQUEST_POLL_SQL, [req.id], Math.max(1, end - performance.now()));
      return { outcome, row: res.rows[0], server: res.server };
    } catch {
      return { outcome };
    }
  };
  await Promise.race([
    Promise.all(requests.map(async req => {
      const saved = OP_WORDS[req.op];
      const withdrew = `[Main] Exiting: withdrew the ${req.op} of server ${req.guildId} sent to ${req.name}; nothing was ${saved}`;
      if (req.lastSettle === 'withdrawn') {
        log(req, withdrew);
        return;
      }
      req.exitSettle = settleShared(req, Math.max(1, end - performance.now()));
      req.exitRead = exitRead(req, req.exitSettle);
      const { outcome, row, server } = await req.exitRead;
      if (outcome === 'withdrawn') {
        log(req, withdrew);
        return;
      }
      if (row?.state === 'done') log(req, `[Main] Exiting: ${req.name} answered the ${req.op} of server ${req.guildId}: ${exitReplyWords(row.reply, saved)}`);
      else if (row?.state === 'expired' && server === req.server) log(req, withdrew);
      else if (row?.state === 'applying') log(req, `[Main] Exiting while ${req.name} applies the ${req.op} of server ${req.guildId}; can't confirm whether it was ${saved}`, true);
      else log(req, unknown(req), true);
    })),
    sleep(EXIT_SETTLE_MS),
  ]);
  for (const req of requests) log(req, unknown(req), true);
}

/** A holder's stored reply in the exit's log line. */
function exitReplyWords(text: unknown, saved: string): string {
  let reply: any;
  try {
    reply = JSON.parse(String(text));
  } catch {
    return 'an answer that could not be read';
  }
  if (reply?.ok === true) return reply.pending ? `accepted, not confirmed as ${saved} yet` : saved;
  return `a refusal with code ${typeof reply?.code === 'string' ? reply.code : 'none'}`;
}

/** Decision 10: a guild document read from the database, as the holder's own read gives it. */
export function remoteReadDoc(guildId: string, module: string, filename: string, boundMs: number): Promise<string | null> {
  return deps.readDoc(guildId, module, filename, Math.max(1, Math.min(STEP_BOUND_MS, boundMs)));
}
