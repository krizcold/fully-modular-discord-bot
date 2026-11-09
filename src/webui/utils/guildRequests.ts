// A guild change on a Postgres bot whose server another machine runs (NB7), and a panel action, a console invoke or a
// read a panel needs (NB15): the plan picks the local route (this machine's bot process answers it) or the request
// route (a row of smdb_data.guild_requests that the bot process holding the guild's shard claims, runs and answers).
// The sender follows its row and answers by its deadline: "nothing was saved" or "nothing was run" only when no
// process started it and none can, "can't confirm" when that is unknown.

import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import type { QueryConfig } from 'pg';
import { resolveDataBackend } from '../../utils/envLoader';
import { keyRefusal, pathKeyOf, sizeRefusal, textRefusal } from '../../bot/internalSetup/utils/storableData';
import {
  CLAIM_SPAN_S,
  MAX_GUILD_ID,
  POLL_SET_SQL,
  REPLY_READ_SQL,
  REQUEST_INSERT_SQL,
  REQUEST_POLL_SQL,
  SETTLE_INSERT_SQL,
  SETTLE_UPDATE_SQL,
  answerSpanS,
  changeDeadlineMs,
  failureOf,
  type AnyRequestOp,
  type GuildRequestOp,
} from '../../bot/internalSetup/utils/dataBackends/guildRequestSql';
import { MAX_BODY_BYTES, isActionOp, isReadOp, validGuildId, type PanelRequestOp } from '../../bot/internalSetup/utils/panelRequestShape';
import { holderStateOf, type HolderCheck } from '../../bot/internalSetup/fleet/claimStore';
import { getNodeName } from '../../bot/internalSetup/fleet/nodeName';
import type { GuildDataWriteRequest } from '../../bot/internalSetup/utils/ipcDataHandler';
import { guardPoolClients } from '../../bot/internalSetup/utils/pgClient';
import { connectWithin, getWebuiDataReader, resolveWebuiDatabase } from './webuiDataReader';
import { classifyPoolClients, pgConfig, transportClassOf, type TransportClass } from '../../utils/databaseAddress';
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
const REPLY_READ_MS = 5000;

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
  insecure: (saved: string) => `This machine's database address does not check the database's certificate, so changes to servers other machines run are off; nothing was ${saved}. Set sslmode=verify-full with sslrootcert in DATA_BACKEND_URL.`,
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

export type NoAnswerCause = 'timeout' | 'lost' | 'unsettled' | 'stopped';

export interface RequestConn {
  /** The database server instance the connection reached: its system identifier and start time. */
  server?: string;
  /** NB15 decision 21: how the connection is protected, classed at its connect. */
  transport?: TransportClass;
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
  /** NB15 decision 14: every shard of the stored count with its claim row. */
  holderMap(boundMs: number): Promise<{ rows: any[]; url?: string }>;
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
  const config = pgConfig(url);
  const pool = new Pool({
    max: REQUEST_POOL_MAX,
    connectionTimeoutMillis: STEP_BOUND_MS,
    idleTimeoutMillis: 1000,
    keepAlive: true,
    application_name: REQUESTS_APPLICATION_NAME,
    statement_timeout: 4000,
    idle_in_transaction_session_timeout: 10_000,
    ...config,
  } as ConstructorParameters<typeof Pool>[0]);
  pool.on('error', () => { /* an idle client's error; the next statement answers for itself */ });
  guardPoolClients(pool, "the web UI's request pool");
  classifyPoolClients(pool, config);
  const servers = new WeakMap<object, string>();
  return {
    async connect(boundMs) {
      const started = performance.now();
      const client = await connectWithin(pool, boundMs, "the web UI's request pool", REQUEST_POOL_MAX);
      const transport = transportClassOf(client) ?? 'unprotected';
      let server = servers.get(client);
      const identify = async (bound: number) => {
        const res = await client.query({ text: SERVER_IDENTITY_SQL, query_timeout: Math.max(1, bound) } as QueryConfig);
        server = String(res.rows[0]?.server);
        servers.set(client, server);
      };
      // An 'unprotected' client sends nothing until a statement that carries no request runs on it.
      if (server === undefined && transport !== 'unprotected') {
        try {
          await identify(boundMs - (performance.now() - started));
        } catch (error) {
          client.release(true);
          throw error;
        }
      }
      return {
        get server() { return server; },
        transport,
        query: async (text, values, bound) => {
          const begun = performance.now();
          if (server === undefined) await identify(bound);
          return client.query({ text, values, query_timeout: Math.max(1, bound - (performance.now() - begun)) } as QueryConfig);
        },
        release: destroy => client.release(destroy ? true : undefined),
      };
    },
    end: () => pool.end().catch(() => undefined),
  };
}

const realDeps: GuildRequestDeps = {
  holderOf: (guildId, boundMs) => getWebuiDataReader().holderOf(guildId, boundMs),
  holderMap: boundMs => getWebuiDataReader().holderMap(boundMs),
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

export function guildRequestDeps(): GuildRequestDeps {
  return deps;
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

function noHolderText(check: HolderCheck, saved: string): string {
  if (check.kind === 'no-count') return NB7_TEXTS.noCount(saved);
  if (check.state === 'expired-deferred') return NB7_TEXTS.deferred(check.shardId, check.shardCount, check.holderName!, saved);
  if (check.state === 'kept') return NB7_TEXTS.kept(check.shardId, check.shardCount, check.holderName!, saved);
  if (check.state === 'reserved') return NB7_TEXTS.reserved(check.shardId, check.shardCount, check.holderName!, saved);
  return NB7_TEXTS.noRow(check.shardId, check.shardCount, saved);
}

function noHolderReply(check: HolderCheck, op: GuildRequestOp): any {
  return { ok: false, code: 'no-holder', error: noHolderText(check, OP_WORDS[op]), sender: true };
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
  op: AnyRequestOp;
  guildId: string;
  name: string;
  db: RequestDb;
  /** The insert's first eight values; the insert-form settle carries them with an empty body. */
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

/** What the request route found; NB7's and NB15's senders each word it. */
export type Outcome =
  | { k: 'maintenance' }
  | { k: 'exiting' }
  | { k: 'unreachable'; cause: string }
  | { k: 'too-slow' }
  | { k: 'no-table' }
  | { k: 'insert-refused'; code: string; message: string }
  | { k: 'insecure' }
  | { k: 'not-taken' }
  | { k: 'withdrawn' }
  | { k: 'withdrawn-at-exit' }
  | { k: 'no-answer'; cause: NoAnswerCause }
  | { k: 'reply'; reply: any };

let exiting = false;
let ending: Promise<void> | null = null;
const followed = new Set<Followed>();
const pools = new Map<string, { db: RequestDb; users: number }>();
const pollSets = new WeakMap<RequestDb, PollSet>();

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

/** Whether the web UI is exiting (NB10's stopping for the exit). */
export function guildRequestsExiting(): boolean {
  return exiting;
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

/**
 * One statement on a connection of the request's pool, bounded by its own bound cut to the deadline. carries: the
 * statement carries a request's answer, so it is not sent on a connection classed 'unprotected'.
 */
async function statement(db: RequestDb, sql: string, values: unknown[], boundMs: number, carries = false): Promise<{ rows: any[]; server?: string }> {
  const started = performance.now();
  const conn = await db.connect(boundMs);
  if (carries && conn.transport === 'unprotected') {
    conn.release();
    throw Object.assign(new Error("this machine's database address does not check the database's certificate"), { notSent: true });
  }
  try {
    const res = await conn.query(sql, values, Math.max(1, boundMs - (performance.now() - started)));
    conn.release();
    return { rows: res.rows, server: conn.server };
  } catch (error) {
    conn.release(true);
    throw error;
  }
}

interface PollTick {
  read: boolean;
  row?: any;
  server?: string;
}

/**
 * NB15 decision 22: one states-only poll per request pool, every 250 ms after the previous ended, for the ids that
 * joined it (each after its insert was acknowledged). A request waits for the next poll that carried its id.
 */
class PollSet {
  private readonly joined = new Set<string>();
  private readonly waiters = new Map<string, Array<(tick: PollTick) => void>>();
  private loop: Promise<void> | null = null;
  constructor(private readonly db: RequestDb) {}

  join(id: string): void {
    this.joined.add(id);
  }

  leave(id: string): void {
    this.joined.delete(id);
    const waiting = this.waiters.get(id);
    this.waiters.delete(id);
    for (const resolve of waiting ?? []) resolve({ read: false });
  }

  /** The next poll's reading of the id, or null when until passes first. */
  next(id: string, until: number): Promise<PollTick | null> {
    return new Promise(resolve => {
      const done = (tick: PollTick | null) => {
        clearTimeout(timer);
        resolve(tick);
      };
      const timer = setTimeout(() => {
        const list = this.waiters.get(id);
        if (list) {
          const i = list.indexOf(done);
          if (i >= 0) list.splice(i, 1);
        }
        resolve(null);
      }, Math.max(0, until - performance.now()));
      const list = this.waiters.get(id) ?? [];
      list.push(done);
      this.waiters.set(id, list);
      this.ensure();
    });
  }

  private ensure(): void {
    if (this.loop) return;
    this.loop = this.run().finally(() => {
      this.loop = null;
      if ([...this.waiters.values()].some(list => list.length > 0) && this.joined.size > 0) this.ensure();
    });
  }

  private async run(): Promise<void> {
    while (this.joined.size > 0 && [...this.waiters.values()].some(list => list.length > 0)) {
      const ids = [...this.joined];
      let tickOf: (id: string) => PollTick;
      try {
        const res = await statement(this.db, POLL_SET_SQL, [ids], POLL_BOUND_MS);
        const byId = new Map(res.rows.map((r: any) => [String(r.id), r]));
        tickOf = id => ({ read: true, row: byId.get(id), server: res.server });
      } catch {
        tickOf = () => ({ read: false });
      }
      for (const id of ids) {
        const waiting = this.waiters.get(id);
        if (!waiting || waiting.length === 0) continue;
        this.waiters.set(id, []);
        const tick = tickOf(id);
        for (const resolve of waiting) resolve(tick);
      }
      await sleep(POLL_EVERY_MS);
    }
  }
}

function pollSetOf(db: RequestDb): PollSet {
  let set = pollSets.get(db);
  if (!set) {
    set = new PollSet(db);
    pollSets.set(db, set);
  }
  return set;
}

/**
 * 'withdrawn': this settle made the row 'expired' on the server instance the insert went to once its claim_by had
 * passed, so no process started it and none can, a failover included. 'withdrawn-early': the same before claim_by,
 * which a failover can undo, so the follow goes on. 'unproven': it did so on another instance, where the row's absence
 * or pending state proves nothing.
 */
type Settled = 'withdrawn' | 'withdrawn-early' | 'unproven' | 'not-pending' | 'failed';

async function settleOnce(req: Followed, boundMs: number): Promise<Settled> {
  const atExit = req.stopped;
  if (!atExit) req.settledBeforeStop = true;
  let outcome: Settled;
  try {
    const res = req.insert === 'acked'
      ? await statement(req.db, SETTLE_UPDATE_SQL, [req.id], boundMs)
      : await statement(req.db, SETTLE_INSERT_SQL, req.values, boundMs);
    if (res.rows.length > 0) {
      if (req.insert !== 'acked') req.insert = 'acked';
      outcome = res.server !== req.server ? 'unproven' : res.rows[0]?.pickup_over === false ? 'withdrawn-early' : 'withdrawn';
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

/** An expired row read on the insert's server proves the withdrawal once its claim_by had passed. */
const expiredProves = (row: any, server: string | undefined, req: Followed) => row?.state === 'expired' && server === req.server && row.pickup_over !== false;

/**
 * A holder's reply that says nothing ran: the unanswered claim's 'unapplied', a refusal before the run, not-held. A
 * read's reply never counts: a read runs no module code, so its refusal is answered at once.
 */
function saysNothingRan(out: Outcome, op: AnyRequestOp): boolean {
  if (out.k !== 'reply' || isReadOp(op)) return false;
  const reply = out.reply;
  return reply?.unapplied === true || reply?.ran === false || reply?.code === 'not-held';
}

/**
 * Such a reply proves nothing ran only once the row's claim_by had passed on the insert's server: before that, a
 * failover behind the same URL can bring back the pending row, and its holder can take it (the rule of a withdrawal).
 */
const doneProves = (row: any, server: string | undefined, req: Followed) => server === req.server && row?.pickup_over === true;

/** NB7 decision 6: the request route's send, then the follow and settle; worded for a data change. */
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
  const outcome = await sendRow(holder, plan.deadline, op, payload.guildId, bodyOf(payload));
  switch (outcome.k) {
    case 'maintenance': return { ok: false, code: 'maintenance', sender: true };
    case 'exiting': return { ok: false, code: 'stopping', error: ROUTE_TEXT.exiting, sender: true };
    case 'unreachable': return sender({ code: 'backend-unavailable', error: NB7_TEXTS.unreachable(name, outcome.cause, saved) });
    case 'too-slow': return sender({ code: 'backend-unavailable', error: NB7_TEXTS.tooSlow(name, saved) });
    case 'no-table': return sender({ code: 'backend-unavailable', error: NB7_TEXTS.noTable(saved) });
    case 'insert-refused': return sender({ code: 'backend-unavailable', error: NB7_TEXTS.insertRefused(outcome.code, outcome.message, saved) });
    case 'insecure': return sender({ code: 'insecure-transport', status: 503, error: NB7_TEXTS.insecure(saved) });
    case 'withdrawn': return sender({ code: 'backend-unavailable', error: NB7_TEXTS.withdrawn(name, saved) });
    case 'withdrawn-at-exit': return sender({ code: 'not-taken', error: NB7_TEXTS.withdrawnAtExit(name, saved) });
    case 'not-taken': return sender({ code: 'not-taken', error: NB7_TEXTS.notTaken(name, saved) });
    case 'no-answer': return sender({ code: 'no-answer', noAnswer: outcome.cause });
    case 'reply': {
      const reply = outcome.reply;
      if (reply.code === 'not-held') return sender({ code: 'not-taken', error: NB7_TEXTS.stoppedServing(name, saved) });
      if (reply.code === 'not-taken' && reply.unapplied === true) return sender({ code: 'not-taken', error: NB7_TEXTS.unapplied(name, saved) });
      return { ...reply, servedBy: name };
    }
  }
}

/** The request route's core for every op: the insert on a checked connection, the follow, the settle. */
async function sendRow(holder: RemoteHolder, deadline: number, op: AnyRequestOp, guildId: string, body: string): Promise<Outcome> {
  const db = acquirePool(holder.url);
  try {
    let conn: RequestConn;
    try {
      conn = await db.connect(Math.max(0, Math.min(STEP_BOUND_MS, left(deadline))));
    } catch (error) {
      const failure = failureOf(error);
      if (failure.kind === 'refused' && failure.code === '28000') return { k: 'maintenance' };
      return { k: 'unreachable', cause: describe(error) };
    }
    // One synchronous run from here to the send: the exit flag, the transport, the time left, the followed set.
    if (exiting) {
      conn.release();
      return { k: 'exiting' };
    }
    if (conn.transport === 'unprotected') {
      conn.release();
      return { k: 'insecure' };
    }
    if (left(deadline) < (answerSpanS(op) * 1000) + SEND_MARGIN_MS) {
      conn.release();
      return { k: 'too-slow' };
    }
    const values = [randomUUID(), guildId, holder.shardCount, holder.shardId, holder.processId, op, body, deps.nodeName()];
    const req: Followed = {
      id: values[0] as string, op, guildId, name: holder.name, db, values: [...values.slice(0, 6), '', values[7]],
      insert: 'sending', insertUnknown: false, server: conn.server, stopped: false, settling: null, exitSettle: null,
      exitRead: null, lastSettle: null, settledBeforeStop: false, withdrawnAtExit: false,
    };
    followed.add(req);
    try {
      return await afterSend(req, conn, values, deadline);
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

/** Which "nothing was run" a withdrawal is. */
function nothing(req: Followed): Outcome {
  if (req.insertUnknown) return { k: 'withdrawn' };
  if (req.withdrawnAtExit || (req.stopped && !req.settledBeforeStop)) return { k: 'withdrawn-at-exit' };
  return { k: 'not-taken' };
}

async function afterSend(req: Followed, conn: RequestConn, values: unknown[], deadline: number): Promise<Outcome> {
  try {
    await conn.query(REQUEST_INSERT_SQL, [...values, CLAIM_SPAN_S, answerSpanS(req.op)], Math.max(1, Math.min(STEP_BOUND_MS, left(deadline))));
    conn.release();
    req.insert = 'acked';
  } catch (error) {
    conn.release(true);
    const failure = failureOf(error);
    if (failure.kind === 'refused') {
      if (failure.code === '28000') return { k: 'maintenance' };
      if (failure.code === '42P01') return { k: 'no-table' };
      if (failure.code === '23505' && await exitHeldId(req, error)) return { k: 'withdrawn-at-exit' };
      return { k: 'insert-refused', code: failure.code, message: failure.message };
    }
    if (req.insert === 'sending') req.insert = 'unknown';
    req.insertUnknown = true;
    if (req.stopped) return stopAnswer(req);
    const settled = await settleUntil(req, deadline);
    if (settled === 'withdrawn') return nothing(req);
    if (settled === 'unproven') return { k: 'no-answer', cause: 'unsettled' };
    if (settled === 'failed') return req.stopped ? stopAnswer(req) : { k: 'no-answer', cause: 'lost' };
  }
  return follow(req, deadline);
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

/** The reply of a row read 'done', by its own statement; null when the read failed (the next tick tries again). */
async function readReply(req: Followed, deadline: number): Promise<Outcome | null> {
  try {
    const res = await statement(req.db, REPLY_READ_SQL, [req.id], Math.max(1, Math.min(REPLY_READ_MS, left(deadline))), true);
    const row = res.rows[0];
    if (!row) return null;
    return replyOutcome(row.reply);
  } catch {
    return null;
  }
}

function replyOutcome(text: unknown): Outcome {
  let reply: any;
  try {
    reply = JSON.parse(String(text));
  } catch {
    return { k: 'no-answer', cause: 'lost' };
  }
  if (!reply || typeof reply !== 'object') return { k: 'no-answer', cause: 'lost' };
  return { k: 'reply', reply };
}

async function follow(req: Followed, deadline: number): Promise<Outcome> {
  const settledAnswer = (settled: Settled): Outcome | null => (settled === 'withdrawn' ? nothing(req) : settled === 'unproven' ? { k: 'no-answer', cause: 'unsettled' } : null);
  const followEnd = deadline - FOLLOW_MARGIN_MS;
  const polls = pollSetOf(req.db);
  polls.join(req.id);
  let last: 'pending' | 'applying' | 'failing' | null = null;
  // A reply that says nothing ran, read before claim_by passed: answered once a later poll proves it.
  let early = false;
  try {
    while (!req.stopped && performance.now() < followEnd) {
      const tick = await polls.next(req.id, followEnd);
      if (tick === null) break;
      if (req.stopped) {
        // A row the poll read before the exit still answers: the holder's reply, or this request's own withdrawal.
        if (tick.read && tick.row?.state === 'done') {
          const out = await readReply(req, deadline);
          if (out && (!saysNothingRan(out, req.op) || doneProves(tick.row, tick.server, req))) return out;
        }
        if (tick.read && expiredProves(tick.row, tick.server, req)) return nothing(req);
        break;
      }
      if (!tick.read) {
        last = 'failing';
        continue;
      }
      const row = tick.row;
      if (row?.state !== 'done') early = false;
      if (!row) {
        // The row was there: its absence means another database, which proves nothing.
        if (req.insert === 'acked') return { k: 'no-answer', cause: 'lost' };
        const settled = await settleUntil(req, deadline);
        const answer = settledAnswer(settled);
        if (answer) return answer;
        if (settled === 'failed') return req.stopped ? stopAnswer(req) : { k: 'no-answer', cause: 'lost' };
      } else if (row.state === 'done') {
        const out = await readReply(req, deadline);
        if (out) {
          if (!saysNothingRan(out, req.op) || doneProves(row, tick.server, req)) return out;
          if (tick.server !== req.server) return { k: 'no-answer', cause: 'unsettled' };
          early = true;
          continue;
        }
        last = 'failing';
      } else if (row.state === 'expired') {
        // Only a settle of this request writes 'expired'; on another server instance it proves nothing.
        if (tick.server !== req.server) return { k: 'no-answer', cause: 'unsettled' };
        if (row.pickup_over !== false) return nothing(req);
      } else if (row.state === 'applying') {
        last = 'applying';
        if (row.answer_over === true) return { k: 'no-answer', cause: 'timeout' };
      } else {
        last = 'pending';
        if (row.pickup_over === true) {
          const settled = await settleUntil(req, deadline);
          const answer = settledAnswer(settled);
          if (answer) return answer;
          if (settled === 'failed') return req.stopped ? stopAnswer(req) : { k: 'no-answer', cause: 'lost' };
        }
      }
    }
  } finally {
    polls.leave(req.id);
  }
  if (req.stopped) return stopAnswer(req);
  if (early) return { k: 'no-answer', cause: 'unsettled' };
  if (last === 'applying') return { k: 'no-answer', cause: 'timeout' };
  const settled = await settleUntil(req, deadline);
  const answer = settledAnswer(settled);
  if (answer) return answer;
  if (settled === 'withdrawn-early') return { k: 'no-answer', cause: 'unsettled' };
  return { k: 'no-answer', cause: last === 'failing' || settled === 'failed' ? 'lost' : 'timeout' };
}

/**
 * The route's answer once the web UI exits: a withdrawal after the row's claim_by, or the row the exit read (the
 * holder's answer, or this request's withdrawal on its own server); otherwise can't confirm. A withdrawal before
 * claim_by is no proof: a failover behind the same URL can bring back the pending row, and its holder can take it.
 */
async function stopAnswer(req: Followed): Promise<Outcome> {
  if (req.lastSettle === 'withdrawn') return nothing(req);
  const exit: ExitRead | null = req.exitRead ? await req.exitRead : req.exitSettle ? { outcome: await req.exitSettle } : null;
  if (!exit) return { k: 'no-answer', cause: 'stopped' };
  if (exit.outcome === 'withdrawn') return nothing(req);
  if (exit.row?.state === 'done') {
    const out = replyOutcome(exit.row.reply);
    if (!saysNothingRan(out, req.op) || doneProves(exit.row, exit.server, req)) return out;
    return { k: 'no-answer', cause: 'stopped' };
  }
  if (expiredProves(exit.row, exit.server, req)) return nothing(req);
  return { k: 'no-answer', cause: 'stopped' };
}

/**
 * Decision 14, at the web UI's exit after NB10's local chain: no request sends its insert from now on, each followed
 * request's own follow stops, and each is settled once, all at once, within 2 s, with one log line each.
 */
export function endGuildRequests(): Promise<void> {
  if (!ending) ending = runEnd();
  return ending;
}

const isPanelOp = (op: AnyRequestOp): op is PanelRequestOp => isActionOp(op) || isReadOp(op);

/** The words of the exit's log lines: NB7's "was saved", NB15's "ran" or "was read". */
function exitWords(op: AnyRequestOp): { done: string; nothing: string } {
  if (!isPanelOp(op)) return { done: `was ${OP_WORDS[op as GuildRequestOp]}`, nothing: `nothing was ${OP_WORDS[op as GuildRequestOp]}` };
  return isReadOp(op) ? { done: 'was read', nothing: 'nothing was read' } : { done: 'ran', nothing: 'nothing was run' };
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
  const unknown = (req: Followed) => `[Main] Exiting; can't confirm whether the ${req.op} of server ${req.guildId} sent to ${req.name} ${exitWords(req.op).done}`;
  const exitRead = async (req: Followed, settle: Promise<Settled>): Promise<ExitRead> => {
    const outcome = await settle;
    if (outcome === 'withdrawn' || outcome === 'unproven') return { outcome };
    // The row was not pending, the settle came before claim_by, or it had no answer: its state says which is true.
    try {
      const res = await statement(req.db, REQUEST_POLL_SQL, [req.id], Math.max(1, end - performance.now()), true);
      return { outcome, row: res.rows[0], server: res.server };
    } catch {
      return { outcome };
    }
  };
  await Promise.race([
    Promise.all(requests.map(async req => {
      const withdrew = `[Main] Exiting: withdrew the ${req.op} of server ${req.guildId} sent to ${req.name}; ${exitWords(req.op).nothing}`;
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
      if (row?.state === 'done' && (!saysNothingRan(replyOutcome(row.reply), req.op) || doneProves(row, server, req))) log(req, `[Main] Exiting: ${req.name} answered the ${req.op} of server ${req.guildId}: ${exitReplyWords(row.reply, req.op)}`);
      else if (row?.state === 'done') log(req, unknown(req), true);
      else if (expiredProves(row, server, req)) log(req, withdrew);
      else if (row?.state === 'applying') log(req, `[Main] Exiting while ${req.name} ${isPanelOp(req.op) ? 'runs' : 'applies'} the ${req.op} of server ${req.guildId}; can't confirm whether it ${exitWords(req.op).done}`, true);
      else log(req, unknown(req), true);
    })),
    sleep(EXIT_SETTLE_MS),
  ]);
  for (const req of requests) log(req, unknown(req), true);
}

/** A holder's stored reply in the exit's log line: NB7's replies carry ok, NB15's carry success and ran. */
function exitReplyWords(text: unknown, op: AnyRequestOp): string {
  let reply: any;
  try {
    reply = JSON.parse(String(text));
  } catch {
    return 'an answer that could not be read';
  }
  if (isPanelOp(op)) return panelExitWords(reply, op);
  const saved = OP_WORDS[op as GuildRequestOp];
  if (reply?.ok === true) return reply.pending ? `accepted, not confirmed as ${saved} yet` : saved;
  return `a refusal with code ${typeof reply?.code === 'string' ? reply.code : 'none'}`;
}

/** NB15's stored reply in the exit's log line, worded by success, ran, truth and code. */
export function panelExitWords(reply: any, op: PanelRequestOp): string {
  const error = typeof reply?.error === 'string' && reply.error !== '' ? reply.error : null;
  if (reply?.success === true) return reply.pending ? 'ran, writes not confirmed as saved yet' : isReadOp(op) ? 'read' : 'ran';
  if (isReadOp(op)) return typeof reply?.code === 'string' ? `a refusal with code ${reply.code}` : `failed${error ? `: ${error}` : ''}`;
  if (reply?.ran === true) {
    if (reply.truth === 'pending' || reply.truth === 'held') return 'ran, writes not confirmed as saved yet';
    if (reply.truth === 'unavailable') return "ran; can't confirm whether its writes were saved";
    if (typeof reply.truth === 'string') return 'ran, and its writes were not saved';
    return `ran and failed${error ? `: ${error}` : ''}`;
  }
  if (reply?.ran === false || typeof reply?.code === 'string') return `a refusal with code ${typeof reply?.code === 'string' ? reply.code : 'none'}`;
  return `failed${error ? ` (${error})` : ''}; can't confirm whether it ran`;
}

/** Decision 10: a guild document read from the database, as the holder's own read gives it. */
export function remoteReadDoc(guildId: string, module: string, filename: string, boundMs: number): Promise<string | null> {
  return deps.readDoc(guildId, module, filename, Math.max(1, Math.min(STEP_BOUND_MS, boundMs)));
}

// NB15: panel actions, console invokes and the reads a panel needs, for a server another machine runs.

export type Audience = 'owner' | 'member';

/** The answer a route sends: the HTTP status (null: the route's own status for the reply) and the reply. */
export interface PanelAnswer {
  status: number | null;
  reply: Record<string, any>;
  /** The holder process and its live since, from an owner's panel answer (decision 15). */
  holderProcess?: string;
}

export interface PanelPlan {
  kind: 'json' | 'refuse' | 'local' | 'request';
  op: PanelRequestOp;
  guildId: string;
  audience: Audience;
  deadline: number;
  holder?: RemoteHolder;
  answer?: PanelAnswer;
}

const OP_PHRASES: Record<PanelRequestOp, string> = {
  'panel:execute': 'the panel action',
  'panel:button': 'the panel action',
  'panel:dropdown': 'the panel action',
  'panel:modal': 'the panel action',
  'command:invoke': 'the command',
  'guild:channels': 'the channel list',
  'guild:roles': 'the role list',
  'panel:list': 'the panel list',
  'panel:live': "the panel's new state",
  'guild:membership': 'the server list',
};

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const kib = (bytes: number) => Math.max(1, Math.ceil(bytes / 1024));

export function opPhrase(op: PanelRequestOp): string {
  return OP_PHRASES[op];
}

/** "nothing was run", or for a read "nothing was read". */
export function nothingWords(op: PanelRequestOp): string {
  return isReadOp(op) ? 'nothing was read' : 'nothing was run';
}

const CHECK_SERVER = 'Check the server before you run it again.';

/** NB15 decision 12's texts, by outcome, op and audience (name: the holder machine's name, for the owner). */
export const PANEL_TEXTS = {
  shuttingDown: (op: PanelRequestOp) => `The web panel is shutting down; ${nothingWords(op)}. Run it again once it is back.`,
  tooLarge: (bytes: number) => `This request is ${kib(bytes)} KiB, more than the 16 KiB one machine sends to another; nothing was run.`,
  notAllowedMember: 'This panel cannot be used from here; nothing was run.',
  stoppedServing: (op: PanelRequestOp, name: string | null) => `${name ? `On ${name}: the` : 'The'} bot stopped serving this server before it ran ${opPhrase(op)}; ${nothingWords(op)}. Try again in a moment.`,
  insecure: (audience: Audience) => (audience === 'owner'
    ? "This machine's database address does not check the database's certificate, so requests to other machines are off; nothing was run. Set sslmode=verify-full with sslrootcert in DATA_BACKEND_URL."
    : 'This server runs on another machine, and this web panel cannot send requests there safely; nothing was run.'),
  noHolderMember: "This server's bot is restarting or not running right now; nothing was run. Try again in a moment.",
  unreachableMember: 'The bot cannot be reached right now; nothing was run. Try again in a moment.',
  notTaken: (op: PanelRequestOp, name: string | null) => (name
    ? `${name} did not take ${opPhrase(op)} within 5 s; ${nothingWords(op)}. Try again in a moment; if it keeps happening, look for [GuildRequests] lines in the bot log on ${name}.`
    : `The bot did not take ${opPhrase(op)} in time; ${nothingWords(op)}. Try again in a moment.`),
  unapplied: (op: PanelRequestOp, name: string | null) => (name
    ? `${name} took ${opPhrase(op)} but could not start it; ${nothingWords(op)}. Try again in a moment.`
    : `The bot could not start ${opPhrase(op)}; ${nothingWords(op)}. Try again in a moment.`),
  tooSlow: (op: PanelRequestOp, name: string) => `The database answered too slowly to send ${opPhrase(op)} to ${name} in time; ${nothingWords(op)}. Try again in a moment.`,
  noTable: (op: PanelRequestOp) => `This database has no table for requests sent between machines: it was created by an older version of the bot. ${capital(nothingWords(op))}.`,
  insertRefused: (op: PanelRequestOp, code: string, message: string) => `The database refused ${opPhrase(op)} (SQLSTATE ${code}: ${message}); ${nothingWords(op)}.`,
  unreachable: (op: PanelRequestOp, name: string, cause: string) => `Can't reach the database to send ${opPhrase(op)} to ${name} (${cause}); ${nothingWords(op)}. Try again in a moment.`,
  withdrawn: (op: PanelRequestOp, name: string) => `The database did not confirm that ${opPhrase(op)} was sent to ${name}, so it was withdrawn; ${nothingWords(op)}. Try again in a moment.`,
  withdrawnAtExit: (op: PanelRequestOp, name: string) => `This web panel is shutting down, so ${opPhrase(op)} sent to ${name} was withdrawn before ${name} took it; ${nothingWords(op)}. Run it again once the panel is back.`,
  noAnswer: (op: PanelRequestOp, cause: NoAnswerCause, name: string | null) => {
    const lead = name
      ? cause === 'lost' ? `The answer from ${name} could not be read from the database`
        : cause === 'unsettled' ? `The database could not show that ${opPhrase(op)} sent to ${name} was withdrawn before ${name} took it`
          : cause === 'stopped' ? `This web panel shut down before it read the answer from ${name}`
            : isReadOp(op) ? `${name} did not send ${opPhrase(op)} in time` : `${name} did not answer in time`
      : cause === 'lost' ? "The bot's answer could not be read from the database"
        : cause === 'unsettled' ? `The database could not show that ${opPhrase(op)} was withdrawn before the bot took it`
          : cause === 'stopped' ? "This web panel shut down before it read the bot's answer"
            : isReadOp(op) ? `The bot did not send ${opPhrase(op)} in time` : 'The bot did not answer in time';
    return isReadOp(op) ? `${lead}; nothing was changed. Try again in a moment.` : `${lead}; can't confirm whether ${opPhrase(op)} ran. ${CHECK_SERVER}`;
  },
  localNoAnswer: (op: PanelRequestOp, cause: 'timeout' | 'stopped') => {
    const lead = cause === 'timeout' ? 'The bot did not answer in time' : 'The bot stopped before it answered';
    return isReadOp(op) ? `${lead}; nothing was changed. Try again in a moment.` : `${lead}; can't confirm whether ${opPhrase(op)} ran. ${CHECK_SERVER}`;
  },
  panelOversize: (name: string | null, oversize: { bytes?: number; reason?: string }, pending = false) => {
    const ran = pending ? 'the panel action ran, and its changes are not confirmed as saved yet' : 'the panel action ran and its changes were saved';
    if (!name) return `${capital(ran)}, but its result cannot be shown here. Do not run it again; check the result in Discord.`;
    const shown = oversize.reason === 'too-large' ? `the panel it returned is ${kib(oversize.bytes ?? 0)} KiB, too large to show here`
      : oversize.reason === 'not-kept' ? `${name} took the request again after a database failover and did not run it twice, so the panel the first run returned is not kept to show here`
        : 'the panel it returned cannot be passed between machines to show here';
    return `On ${name}: ${ran}; ${shown}. Open the panel from the web panel on ${name}.`;
  },
  localPanelOversize: (pending = false) => `The panel action ran${pending ? ', and its changes are not confirmed as saved yet' : ' and its changes were saved'}, but the panel it returned cannot be shown here. Do not run it again; check the result in Discord.`,
  capturedOmitted: (name: string | null, omitted: { count?: number; bytes?: number; reason?: string }) => {
    if (omitted.reason === 'not-kept') {
      const replies = `the command's ${omitted.count ?? 0} captured replies`;
      if (!name) return `${capital(replies)} were not kept after the request was taken again, and are left out.`;
      return `On ${name}: ${name} took the command again after a database failover and did not run it twice; ${replies} from the first run are not kept and are left out.`;
    }
    const what = `the command's ${omitted.count ?? 0} captured replies (${kib(omitted.bytes ?? 0)} KiB)`;
    if (!name) return `${capital(what)} cannot be shown here and are left out.`;
    return `On ${name}: ${what} ${omitted.reason === 'too-large' ? 'are more than the 256 KiB one machine sends to another' : 'cannot be passed between machines'} and are left out.`;
  },
  listTooLarge: (op: PanelRequestOp, name: string | null, bytes: number) => (name
    ? `On ${name}: ${opPhrase(op)} is ${kib(bytes)} KiB, more than the 256 KiB one machine sends to another; open this panel from the web panel on ${name}.`
    : `${capital(opPhrase(op))} of this server is too large to show here; nothing was changed.`),
};

const isPanelAction = (op: PanelRequestOp) => isActionOp(op) && op !== 'command:invoke';
const LIST_FIELD: Partial<Record<PanelRequestOp, string>> = { 'guild:channels': 'channels', 'guild:roles': 'roles', 'panel:list': 'panels', 'panel:live': 'data', 'guild:membership': 'guilds' };

/** An answer's oversize notes and statuses, shared by the local and the request route (name null: local or member). */
function sizeAnswer(op: PanelRequestOp, reply: Record<string, any>, name: string | null, local: boolean): PanelAnswer | null {
  if (reply.oversize && typeof reply.oversize === 'object') {
    if (isPanelAction(op)) {
      if (reply.success !== true) return null;
      const pending = reply.pending === true;
      return { status: 200, reply: { ...reply, success: true, data: null, note: local ? PANEL_TEXTS.localPanelOversize(pending) : PANEL_TEXTS.panelOversize(name, reply.oversize, pending) } };
    }
    if (LIST_FIELD[op]) {
      return { status: 502, reply: { success: false, code: 'answer-too-large', error: PANEL_TEXTS.listTooLarge(op, name, Number(reply.oversize.bytes ?? 0)) } };
    }
  }
  if (op === 'command:invoke' && reply.capturedOmitted && typeof reply.capturedOmitted === 'object') {
    return { status: null, reply: { ...reply, note: PANEL_TEXTS.capturedOmitted(name, reply.capturedOmitted) } };
  }
  return null;
}

/** NB15 decision 12, local route: the child's answer, its no-answer as can't confirm, not-ready as 503. */
export function localPanelAnswer(op: PanelRequestOp, reply: any): PanelAnswer {
  if (!reply || typeof reply !== 'object') return { status: 503, reply: { success: false, code: 'no-answer', noAnswer: 'timeout', error: PANEL_TEXTS.localNoAnswer(op, 'timeout') } };
  if (reply.noAnswer === 'timeout' || reply.noAnswer === 'stopped') {
    return { status: 503, reply: { success: false, code: 'no-answer', noAnswer: reply.noAnswer, error: PANEL_TEXTS.localNoAnswer(op, reply.noAnswer) } };
  }
  if (reply.code === 'not-ready') return { status: 503, reply };
  const sized = sizeAnswer(op, reply, null, true);
  if (sized) return sized;
  return { status: null, reply };
}

/**
 * The owner's prefix on a holder's text. Only a text the sheet words (the holder's refusals and ranTruthText) starts
 * lower case after it; a module's or the rate limit's own text keeps its case.
 */
const onName = (name: string, text: string, sheetWorded: boolean) => `On ${name}: ${sheetWorded ? lower(text) : text}`;

/** A failed answer that carries no text, worded by what its fields prove. */
function failureWithoutText(op: PanelRequestOp, reply: Record<string, any>): string {
  if (isReadOp(op)) return 'The bot could not answer the request; nothing was changed. Try again in a moment.';
  if (reply.ran === false) return `The bot refused the request; ${nothingWords(op)}.`;
  if (reply.ran === true) return `The action ran, but the bot gave no reason for its failure. ${CHECK_SERVER}`;
  return `The bot answered that ${opPhrase(op)} failed and gave no reason; can't confirm whether it ran. ${CHECK_SERVER}`;
}

/** NB15 decision 12, request route: what the sender found, worded for the audience. */
export function remotePanelAnswer(op: PanelRequestOp, outcome: Outcome, audience: Audience, name: string): PanelAnswer {
  const owner = audience === 'owner';
  const who = owner ? name : null;
  const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): PanelAnswer => ({
    status, reply: { success: false, code, error, ...(owner ? { servedBy: name } : {}), ...extra },
  });
  switch (outcome.k) {
    case 'maintenance': return refuse(503, 'maintenance', owner ? `The database is in maintenance; ${nothingWords(op)}. Try again later.` : `The bot is in maintenance; ${nothingWords(op)}. Try again later.`);
    case 'exiting': return refuse(503, 'stopping', PANEL_TEXTS.shuttingDown(op));
    case 'unreachable': return owner ? refuse(503, 'backend-unavailable', PANEL_TEXTS.unreachable(op, name, outcome.cause)) : refuse(503, 'backend-unavailable', PANEL_TEXTS.unreachableMember);
    case 'too-slow': return owner ? refuse(503, 'backend-unavailable', PANEL_TEXTS.tooSlow(op, name)) : refuse(503, 'backend-unavailable', PANEL_TEXTS.unreachableMember);
    case 'no-table': return owner ? refuse(503, 'backend-unavailable', PANEL_TEXTS.noTable(op)) : refuse(503, 'backend-unavailable', PANEL_TEXTS.unreachableMember);
    case 'insert-refused': return owner ? refuse(503, 'backend-unavailable', PANEL_TEXTS.insertRefused(op, outcome.code, outcome.message)) : refuse(503, 'backend-unavailable', PANEL_TEXTS.unreachableMember);
    case 'insecure': return refuse(503, 'insecure-transport', PANEL_TEXTS.insecure(audience));
    case 'withdrawn': return owner ? refuse(503, 'backend-unavailable', PANEL_TEXTS.withdrawn(op, name)) : refuse(503, 'backend-unavailable', PANEL_TEXTS.unreachableMember);
    case 'withdrawn-at-exit': return owner ? refuse(503, 'not-taken', PANEL_TEXTS.withdrawnAtExit(op, name)) : refuse(503, 'not-taken', PANEL_TEXTS.shuttingDown(op));
    case 'not-taken': return refuse(503, 'not-taken', PANEL_TEXTS.notTaken(op, who));
    case 'no-answer': return refuse(503, 'no-answer', PANEL_TEXTS.noAnswer(op, outcome.cause, who), { noAnswer: outcome.cause });
    case 'reply': break;
  }
  const reply: Record<string, any> = outcome.reply;
  const served = (r: Record<string, any>): Record<string, any> => (owner ? { ...r, servedBy: name } : r);
  if (reply.code === 'not-taken' && reply.unapplied === true) return refuse(503, 'not-taken', PANEL_TEXTS.unapplied(op, who));
  if (reply.code === 'not-held') return refuse(503, 'not-taken', PANEL_TEXTS.stoppedServing(op, who));
  const own = typeof reply.error === 'string' && reply.error !== '';
  const text = own ? reply.error : failureWithoutText(op, reply);
  const sheetWorded = !own || (reply.ran === true && typeof reply.truth === 'string');
  if (reply.code === 'invalid') return { status: 400, reply: served({ ...reply, error: owner ? onName(name, text, true) : text }) };
  if (reply.code === 'not-allowed') return { status: 403, reply: served({ ...reply, error: owner ? onName(name, text, true) : PANEL_TEXTS.notAllowedMember }) };
  if (reply.code === 'member-panel-off') return { status: 403, reply: served(reply) };
  if (reply.code === 'not-ready') return { status: 503, reply: served({ ...reply, error: owner ? onName(name, text, true) : text }) };
  const sized = sizeAnswer(op, reply, who, false);
  if (sized) {
    const note = sized.reply.note;
    const failed = op === 'command:invoke' && sized.reply.success !== true ? { error: owner ? onName(name, text, sheetWorded) : text } : {};
    return { status: sized.status, reply: served({ ...sized.reply, ...failed, ...(note !== undefined ? { note } : {}) }) };
  }
  if (reply.success === true) return { status: null, reply: served(reply) };
  return { status: null, reply: served({ ...reply, error: owner ? onName(name, text, sheetWorded) : text }) };
}

/**
 * NB15 decision 9: the route of a panel request, before anything is sent. The guild id, the exit, the local child at
 * its guild report; else the holder check, from which T counts.
 */
export async function planGuildRequest(botManager: BotManager, guildId: string, op: PanelRequestOp, audience: Audience): Promise<PanelPlan> {
  const plan: PanelPlan = { kind: 'json', op, guildId, audience, deadline: performance.now() + changeDeadlineMs(op) };
  if (resolveDataBackend() !== 'postgres') return plan;
  const refuse = (answer: PanelAnswer): PanelPlan => ({ ...plan, kind: 'refuse', answer });
  if (!validGuildId(guildId)) return refuse({ status: 400, reply: { success: false, code: 'invalid', error: 'Invalid guild ID format' } });
  const route = botManager.writerRoute('guild', { postgresGuild: true });
  if (exiting || (route.route === undefined && route.code === 'stopping' && route.error === ROUTE_TEXT.exiting)) {
    return refuse({ status: 503, reply: { success: false, code: 'stopping', error: PANEL_TEXTS.shuttingDown(op) } });
  }
  if (route.route === 'child') return { ...plan, kind: 'local' };
  const local: PanelAnswer = route.route === undefined && route.code !== 'bot-down'
    ? { status: 503, reply: { success: false, code: route.code, error: route.error } }
    : { status: 503, reply: { success: false, error: 'Bot is not running' } };
  return toRequestRoute(plan, local);
}

/** Step 6: T starts at the turn to the request route; the holder check decides the rest. */
async function toRequestRoute(plan: PanelPlan, localAnswer: PanelAnswer | null): Promise<PanelPlan> {
  const deadline = performance.now() + changeDeadlineMs(plan.op);
  const next: PanelPlan = { ...plan, deadline };
  const check = await runHolderCheck(plan.guildId, deadline);
  const owner = plan.audience === 'owner';
  const nothingSaid = nothingWords(plan.op).replace(/^nothing was /, '');
  if (check.kind === 'held') {
    if (check.thisNode && localAnswer) return { ...next, kind: 'refuse', answer: localAnswer };
    return { ...next, kind: 'request', holder: check.holder };
  }
  if (check.kind === 'no-holder') {
    return { ...next, kind: 'refuse', answer: { status: 503, reply: { success: false, code: 'no-holder', error: owner ? noHolderText(check.check, nothingSaid) : PANEL_TEXTS.noHolderMember } } };
  }
  const failure = failureOf(check.error);
  if (failure.kind === 'refused' && failure.code === '28000') {
    return { ...next, kind: 'refuse', answer: { status: 503, reply: { success: false, code: 'maintenance', error: `The database is in maintenance; ${nothingWords(plan.op)}. Try again later.` } } };
  }
  const error = !owner ? PANEL_TEXTS.unreachableMember
    : failure.kind === 'refused' ? NB7_TEXTS.lookupRefused(failure.code, failure.message, nothingSaid) : NB7_TEXTS.lookupUnreachable(failure.cause, nothingSaid);
  return { ...next, kind: 'refuse', answer: { status: 503, reply: { success: false, code: 'backend-unavailable', error } } };
}

/** The actor a request row carries (decision 3): who the sending web UI checked. */
export function actorFor(audience: Audience, userId: string | null | undefined): { via: Audience; userId: string } {
  return { via: audience, userId: userId || 'web-ui-owner' };
}

/**
 * Runs a planned panel request: the local send (a not-held reply turns to the request route), or the request route
 * with the payload and its actor. localSend: the local IPC send of the op.
 */
export async function runGuildRequest(plan: PanelPlan, payload: Record<string, unknown>, localSend: () => Promise<any>): Promise<PanelAnswer> {
  if (plan.kind === 'refuse') return plan.answer!;
  if (plan.kind === 'json') return localPanelAnswer(plan.op, await localSend());
  let current = plan;
  if (current.kind === 'local') {
    const reply = await localSend();
    if (reply?.code !== 'not-held') return localPanelAnswer(plan.op, reply);
    current = await toRequestRoute(plan, null);
    if (current.kind !== 'request') return current.answer!;
  }
  const holder = current.holder!;
  const body = JSON.stringify({ ...payload, guildId: plan.guildId });
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_BODY_BYTES) return { status: 400, reply: { success: false, code: 'invalid', error: PANEL_TEXTS.tooLarge(bytes) } };
  const outcome = await sendRow(holder, current.deadline, plan.op, plan.guildId, body);
  const answer = remotePanelAnswer(plan.op, outcome, plan.audience, holder.name);
  answer.holderProcess = holder.processId;
  return answer;
}

/** NB15 decision 14: one membership row for a holder process of another machine, for at most 100 ids, the first naming the row. */
export async function sendMembership(holder: RemoteHolder, ids: string[], memberId: string, deadline: number): Promise<Outcome> {
  const body = JSON.stringify({ ids, guildId: ids[0], actor: { via: 'member', userId: memberId } });
  return sendRow(holder, deadline, 'guild:membership', ids[0], body);
}
