// The data of no guild on a Postgres bot (NB6): which files are shared keys, the row queue that holds their writes
// until they are stored, its flush to the shared tables and the landing check of an attempt whose answer was lost, the
// bases those writes carry, and the tree of every global key that rule P checks on both backends. The facade
// (dataManager.ts) routes to it and hands it the data pool and the re-run of an update.

import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { ClientConfig, QueryConfig, QueryResult } from 'pg';
import { DATA_ROOT, dataPath } from '../../../utils/dataRoot';
import { resolveDataBackend } from '../../../utils/envLoader';
import { pgConfig } from '../../../utils/databaseAddress';
import { getNodeName } from '../fleet/nodeName';
import { processId } from '../fleet/processId';
import { atomicReplace, setRowCancel, type CancelOutcome } from './dataBackends/fileBackend';
import { databaseView, mainTagOf } from './dataBackends/mainDatabase';
import {
  ANSWER_BOUND_MS, CHECK_STATEMENT_MS, commitMayHaveLanded, deadlineIn, describeFailure, largestStatement, msLeft, oversizeFailure, sharedPlan,
  statementBytes, type SharedReadOutcome, type SharedStatement, type SharedTxOutcome, type SharedTxSpec,
} from './dataBackends/postgresBackend';
import { shortLivedClient } from './pgClient';
import { outsideLedgers } from './dataBackends/writeLedger';
import { readDocRecord, readStoreRecord, writeDocRecord, writeStoreRecord } from './sharedRecords';
import { atomicWriteFileSync } from './atomicWrite';
import { FLUSH_STATEMENT_BYTES, flushBoundMs, KeyTree, type Collision } from './storableData';

export const ROOT_CONFIG_KEY = 'config.json';

// configManager.ts's ROOT_CONFIG_PATH, read at each call: this file sits in the same folder.
function rootConfigPath(): string {
  return process.env.NODE_ENV !== 'development' ? dataPath('dist', 'bot', 'config.json') : path.join(__dirname, '../../config.json');
}

/** A path's key below /data/global/, '/'-separated; null for a path outside it or the folder itself. */
export function globalRelOf(absPath: string): string | null {
  const rel = path.relative(path.join(DATA_ROOT, 'global'), path.resolve(absPath));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// Decision 2's files of one machine, as decision 40 amends it (the events journal is shared).
function isLocalGlobal(rel: string): boolean {
  return rel === 'fleet' || rel.startsWith('fleet/')
    || rel === 'appstore/cache' || rel.startsWith('appstore/cache/')
    || rel === 'metrics/totals.json';
}

/** The shared key of a file whatever the bot's backend (decision 39): the root config, or a file under /data/global that no machine keeps alone. */
export function sharedKeyFor(absPath: string): string | null {
  const abs = path.resolve(absPath);
  if (abs === path.resolve(rootConfigPath())) return ROOT_CONFIG_KEY;
  const rel = globalRelOf(abs);
  if (rel === null || isLocalGlobal(rel)) return null;
  return `global/${rel}`;
}

/** The shared key of a file on a Postgres bot; null on a JSON bot, which keeps every file as a file. */
export function sharedKeyOf(absPath: string): string | null {
  return resolveDataBackend() === 'postgres' ? sharedKeyFor(absPath) : null;
}

/** The mirror file of a shared key. */
export function mirrorPathOf(key: string): string {
  if (key === ROOT_CONFIG_KEY) return rootConfigPath();
  return path.join(DATA_ROOT, ...key.split('/'));
}

/** A key written by appends, kept as lines (decision 8). */
export function isLinesKey(key: string): boolean {
  return key.endsWith('.jsonl');
}

export function shaOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The mirror file's bytes; null when there is none. Any other read error throws. */
export function mirrorBytes(absPath: string): Buffer | null {
  try {
    return fs.readFileSync(absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

// ============================================================================
// THE ROW QUEUE (decisions 7, 23, 26 and 51; C13's names)
// ============================================================================

/** An update's fn as the accept took it, with the value it starts from when no row is stored. */
export interface UpdateStep {
  fn: (current: any) => any;
  defaultValue: unknown;
}

/** Why the flush refused an op (C9): never retried. */
export type RowCause = 'changed-elsewhere' | 'io' | 'unstorable' | 'writer-lost';

/**
 * queued: waiting for its first or next attempt; wire: an attempt is running; store: an App Store key's op stored, its
 * landing block not yet run (decision 53); mirror: stored, its mirror write pending (decision 25); landed, refused,
 * unconfirmed: settled, out of the queue.
 */
export type RowState = 'queued' | 'wire' | 'store' | 'mirror' | 'landed' | 'refused' | 'unconfirmed';

/** One pending change of a key: every write the accept joined into it, as this process's result. */
export interface RowOp {
  readonly key: string;
  /** The mirror file. */
  readonly path: string;
  /** This process's result, the bytes to store (null for a delete); once stored, the stored bytes. */
  body: Buffer | null;
  /** The sha of the bytes the first write was built on, 'absent' for none, 'unreadable' when the mirror could not be read. */
  readonly base: string;
  /** The base came from the caller (decision 51): the op never takes a later write. */
  readonly callerBase: boolean;
  /** Each write's fn in order while every write in the op is an update; null once a plain write joined (decision 23). */
  updates: UpdateStep[] | null;
  /** Decision 102: the sha each other key must hold for the op to be stored (null: no row). */
  readonly check: Readonly<Record<string, string | null>> | null;
  state: RowState;
  /** Date.now() at the accept of its first write. */
  readonly acceptedAt: number;
  /** Attempts started; an op with one takes no later write (decision 51). */
  attempts: number;
  /** Decisions 24 and 52: each attempt whose COMMIT answer was lost, with the database's now() it read. */
  unknown: Array<{ id: string; at: Date | null }>;
  /** D1: an attempt has sent COMMIT and its answer has not come. */
  commitOnWire: boolean;
  /** D1: tries that ended without an outcome (no answer, a connect error, an own-state refusal, a 57014, a lost answer). */
  triesFailed: number;
  /** The cause of a refusal, with its reason when it has one. */
  refusal: RowRefusal | null;
  /** Once stored: the stored sha ('absent' for no row) and the main tag of the attempt that settled it (decision 53). */
  stored: { sha: string; main: string | null } | null;
  /** Date.now() before which the flush leaves the op alone (its backoff). */
  retryAt: number;
  /** The writes the accept joined into the op; each write's ticket carries the count at its accept. */
  writes: number;
  /** An op of a lines key (sharedLines.ts): its own transaction, no body, base or mirror; null for a doc op. */
  readonly work: RowWork | null;
  /** Why the last try ended without an outcome (T39's words for a web UI check that refused); null before one did. */
  cause: string | null;
  /** Why the answer to the last COMMIT of unknown fate was lost. */
  lostCause: string | null;
  /** The web UI's land-or-cancel holds it: no attempt starts but the one landing check the cancel runs. */
  frozen: boolean;
  /** The web UI accepted it outside a local chain op (its App Store doc writes): the chain's land-or-cancel leaves it alone. */
  readonly outsideChain: boolean;
  /** Decision 47: lines of a lines key the op inserts in its own transaction (premium's audit lines); null for none. */
  readonly carried: CarriedLines | null;
}

/** Lines a doc op carries: inserted after its doc statement, or in its place for a no-change write (decision 47). */
export interface CarriedLines {
  key: string;
  lines: Array<{ id: string; line: Buffer }>;
}

/** What a lines key's op sends: its transaction for one attempt, and the bytes decision 7's bound counts. */
export interface RowWork {
  readonly bytes: number;
  /** noteNow takes the database's now() its lock read, for the 6-day bound of an attempt of unknown fate. */
  spec(op: RowOp, attemptId: string, noteNow: (now: Date | null) => void): SharedTxSpec<RowStop>;
}

/**
 * A refusal of the flush. For 'changed-elsewhere' (T22, cell 248): the stored row's writer machine (its node name) and
 * time, absent when the stored row is gone.
 */
export interface RowRefusal {
  cause: RowCause;
  reason?: string;
  by?: string;
  at?: Date;
}

export interface RowTicket {
  kind: 'row';
  key: string;
  op: RowOp;
  /** The op's write count at this write's accept: a later write joined into the op has a higher seq. */
  seq: number;
}

/** A write the accept takes: a body (null deletes), and for an update its fn. */
export interface RowWrite {
  body: Buffer | null;
  update?: UpdateStep;
  /** Lines the op carries; a write with lines is an op of its own, as a write with a caller base is. */
  lines?: CarriedLines;
}

export const ROW_ACCEPT_BYTES = 64 * 1024 * 1024;
export const ROW_ACCEPT_WINDOW_MS = 300_000;

const opsByKey = new Map<string, RowOp[]>();

let outsideChain: () => boolean = () => false;

/** The web UI names the context whose accepts are outside its local chain (inStoreWrite's frame). */
export function useOutsideChain(given: (() => boolean) | null): void {
  outsideChain = given ?? (() => false);
}

const isOpen = (op: RowOp): boolean => op.state === 'queued' || op.state === 'wire';
const carriedBytes = (op: RowOp): number => op.carried?.lines.reduce((total, l) => total + l.line.length, 0) ?? 0;
const bytesOf = (op: RowOp): number => (isOpen(op) ? op.work?.bytes ?? (op.body?.length ?? 0) + carriedBytes(op) : 0);

export const rowQueue = {
  /**
   * Takes a write of key: joins the last op of the key when that op is queued, was never sent, has no caller base and
   * the write has none (the later body, the first base); otherwise a new op behind the key's ops with the base given.
   */
  accept(key: string, file: string, write: RowWrite, base: { sha: string; caller: boolean; check?: Record<string, string | null> }): RowTicket {
    const ops = opsByKey.get(key) ?? [];
    const last = ops[ops.length - 1];
    const caller = base.caller || base.check !== undefined || write.lines !== undefined;
    if (last && last.state === 'queued' && last.attempts === 0 && !last.callerBase && !caller && last.outsideChain === outsideChain()) {
      last.body = write.body;
      last.updates = write.update && last.updates ? [...last.updates, write.update] : null;
      last.writes += 1;
      kickRows();
      return { kind: 'row', key, op: last, seq: last.writes };
    }
    const op: RowOp = {
      key,
      path: file,
      body: write.body,
      base: base.sha,
      callerBase: caller,
      updates: write.update ? [write.update] : null,
      check: base.check ? { ...base.check } : null,
      state: 'queued',
      acceptedAt: Date.now(),
      attempts: 0,
      unknown: [],
      commitOnWire: false,
      triesFailed: 0,
      refusal: null,
      stored: null,
      retryAt: 0,
      writes: 1,
      work: null,
      cause: null,
      lostCause: null,
      frozen: false,
      outsideChain: outsideChain(),
      carried: write.lines && write.lines.lines.length > 0 ? { key: write.lines.key, lines: [...write.lines.lines] } : null,
    };
    ops.push(op);
    opsByKey.set(key, ops);
    kickRows();
    return { kind: 'row', key, op, seq: 1 };
  },

  /** Decision 54: an op of a lines key, behind every op of the key; it never takes a later write. */
  acceptWork(key: string, file: string, work: RowWork): RowTicket {
    const op: RowOp = {
      key,
      path: file,
      body: null,
      base: 'absent',
      callerBase: true,
      updates: null,
      check: null,
      state: 'queued',
      acceptedAt: Date.now(),
      attempts: 0,
      unknown: [],
      commitOnWire: false,
      triesFailed: 0,
      refusal: null,
      stored: null,
      retryAt: 0,
      writes: 1,
      work,
      cause: null,
      lostCause: null,
      frozen: false,
      outsideChain: outsideChain(),
      carried: null,
    };
    const ops = opsByKey.get(key) ?? [];
    ops.push(op);
    opsByKey.set(key, ops);
    kickRows();
    return { kind: 'row', key, op, seq: 1 };
  },

  /**
   * The key's latest doc op: what this process holds for the key ahead of its mirror (a stored body while its mirror
   * write is pending). A lines key's ops hold no body to read.
   */
  entryOf(key: string): RowOp | undefined {
    const ops = (opsByKey.get(key) ?? []).filter(op => op.work === null);
    return ops[ops.length - 1];
  },

  ops(key: string): readonly RowOp[] {
    return opsByKey.get(key) ?? [];
  },

  keys(): string[] {
    return [...opsByKey.keys()];
  },

  /** The bytes of the ops not yet stored. */
  bytes(): number {
    let total = 0;
    for (const ops of opsByKey.values()) for (const op of ops) total += bytesOf(op);
    return total;
  },

  /** Decision 7's bounds: acceptance is closed while the unstored ops hold 64 MiB or one has waited 300 s. */
  closed(now = Date.now()): boolean {
    if (rowQueue.bytes() >= ROW_ACCEPT_BYTES) return true;
    for (const ops of opsByKey.values()) for (const op of ops) if (isOpen(op) && now - op.acceptedAt >= ROW_ACCEPT_WINDOW_MS) return true;
    return false;
  },
};

/**
 * The ticket of a key's latest doc op: right after an accept with a caller base, the op that write started (a write
 * with a caller base never joins an op).
 */
export function latestRowTicket(key: string): RowTicket | undefined {
  const op = rowQueue.entryOf(key);
  return op ? { kind: 'row', key, op, seq: op.writes } : undefined;
}

/**
 * C9 and D1: 'landed' once stored (its mirror write may still be pending; for an App Store key, once its landing block
 * ran), 'refused', 'unconfirmed', else 'open'.
 */
export function rowTicketState(ticket: RowTicket): 'landed' | 'refused' | 'unconfirmed' | 'open' {
  const { state } = ticket.op;
  if (state === 'mirror' || state === 'landed') return 'landed';
  if (state === 'refused' || state === 'unconfirmed') return state;
  return 'open';
}

/**
 * D1: the row form of commitAnswerOwed: the op holds an attempt of unknown fate, or one whose COMMIT is on the wire, or
 * it is stored and waits for its landing block.
 */
export function rowCommitOwed(ticket: RowTicket): boolean {
  if (ticket.op.state === 'store') return true;
  return rowTicketState(ticket) === 'open' && (ticket.op.unknown.length > 0 || ticket.op.commitOnWire);
}

/** Resolves when the op's next try ends, with or without an outcome. */
export function rowChange(ticket: RowTicket): Promise<void> {
  return new Promise(resolve => {
    const list = changeWaiters.get(ticket.op) ?? [];
    list.push(resolve);
    changeWaiters.set(ticket.op, list);
  });
}

const changeWaiters = new Map<RowOp, Array<() => void>>();

/** How an op settled: stored, refused with its refusal, or 'unconfirmed'. */
export type RowOutcome = 'landed' | { refused: RowRefusal } | 'unconfirmed';

/** Resolves once the op settles (decision 63's outcome of a save's op). */
export async function rowOutcome(ticket: RowTicket): Promise<RowOutcome> {
  for (;;) {
    const state = rowTicketState(ticket);
    if (state === 'landed' || state === 'unconfirmed') return state;
    if (state === 'refused') return { refused: ticket.op.refusal ?? { cause: 'io' } };
    await rowChange(ticket);
  }
}

function changed(op: RowOp): void {
  const list = changeWaiters.get(op);
  if (!list) return;
  changeWaiters.delete(op);
  for (const resolve of list) resolve();
}

// ============================================================================
// THE FLUSH (decisions 4 to 7, 23 to 26, 51 to 53, 102 and 109; C4, C6, C9, C11; D5, D6; E1)
// ============================================================================

/** What the flush needs from the shared transaction: PostgresBackend.sharedTx on the data pool. */
export interface RowBackend {
  sharedTx<S>(spec: SharedTxSpec<S>): Promise<SharedTxOutcome<S>>;
  /** A read with a client bound and no place (C5): the journal read. */
  sharedSelect?(text: string, values: unknown[], boundMs: number): Promise<{ rows: any[] }>;
  /** C4's module fetch read in its own read-only transaction, holding a shared place and a flush place (D5). */
  sharedRead?(text: string, values: unknown[]): Promise<SharedReadOutcome>;
  /** The main tag of the database it reads, for a pass that has no MainChooser (the web UI's). */
  mainTag?(): string | null;
}

export type RowRerun = { ok: true; text: string; value: unknown } | { ok: false; reason: string };

interface RowFlushDeps {
  backend: () => RowBackend | null;
  /** dataManager's rerunUpdate: the accept's checks and NB12's value rules on fn's result over the stored value. */
  rerun: (what: string, fn: (current: any) => unknown, stored: unknown) => RowRerun;
}

let deps: RowFlushDeps = { backend: () => null, rerun: () => ({ ok: false, reason: 'no update runner' }) };

/** Set by the facade: the data pool the flush sends on (none in the web UI process) and the update re-run. */
export function configureRowFlush(given: Partial<RowFlushDeps>): void {
  deps = { ...deps, ...given };
}

/** The data pool the flush sends on; in the web UI process on a Postgres bot, its own sessions; else null. */
export function rowBackend(): RowBackend | null {
  return deps.backend() ?? (webui && resolveDataBackend() === 'postgres' ? webuiBackend : null);
}

const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 30_000;
const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

export const LOCK_SQL = "SELECT now() AS now, pg_advisory_xact_lock(hashtext('smdb_shared'), hashtext($1))";
export const OPS_SQL = 'SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)';
export const CHECKED_SQL = 'SELECT sha, updated_by, updated_at FROM smdb_data.shared_docs WHERE key = $1';
const DOC_SQL = 'SELECT body, sha, updated_by, updated_at FROM smdb_data.shared_docs WHERE key = $1';
export const UPSERT_SQL = `INSERT INTO smdb_data.shared_docs (key, body, sha, rev, updated_by)
  VALUES ($1, $2, $3, nextval('smdb_data.shared_rev_seq'), $4)
  ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, sha = EXCLUDED.sha, rev = EXCLUDED.rev,
    updated_at = now(), updated_by = EXCLUDED.updated_by
  RETURNING rev`;
export const APPEND_SQL = 'UPDATE smdb_data.shared_docs SET body = body || $2 WHERE key = $1';
export const DELETE_SQL = 'DELETE FROM smdb_data.shared_docs WHERE key = $1 RETURNING rev';
export const OP_SQL = 'INSERT INTO smdb_data.shared_ops (id) VALUES ($1)';
export const NOTIFY_SQL = "SELECT pg_notify('smdb_shared', $1)";

interface StoredRow {
  body: Buffer;
  sha: string;
  by: string;
  at: Date;
}

/** How an attempt ended inside its transaction, before COMMIT. */
export type RowStop =
  | { kind: 'same' }
  /** checked: the checked key whose stored sha differed (decision 102's refusal). */
  | { kind: 'refused'; refusal: RowRefusal; log?: string; checked?: string }
  | { kind: 'unconfirmed'; cause: string }
  /** The land-or-cancel's landing check found no earlier attempt stored: the op goes back to the cancel unsent. */
  | { kind: 'checked' };

/** One attempt of an op: its id, the database's now() at its lock, and what it read and wrote. */
interface Attempt {
  id: string;
  now: Date | null;
  /** The row the attempt read under the lock; null for none. */
  read: StoredRow | null;
  /** The body and sha it sent. */
  body: Buffer | null;
  sha: string;
  main: string | null;
}

const running = new Map<string, Promise<void>>();
const mirrorRuns = new Map<string, Promise<void>>();
const mirrorAgain = new Set<string>();
const mirrorTries = new Map<string, number>();
const mirrorLogged = new Map<string, string>();
/** Keys whose mirror this machine moved aside and has not written since (R2-A1). */
const movedUnwritten = new Set<string>();
const timers = new Set<NodeJS.Timeout>();
let kickQueued = false;

function later(ms: number, fn: () => void): void {
  const timer = setTimeout(() => {
    timers.delete(timer);
    fn();
  }, Math.max(0, ms));
  timer.unref?.();
  timers.add(timer);
}

const backoffMs = (tries: number): number => Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, tries - 1)) * (0.5 + Math.random() * 0.5);

/** Each key's one pending flush wake for its head op, and when it fires (Date.now() time). */
const wakes = new Map<string, { at: number; timer: NodeJS.Timeout }>();

/** Kicks the flush after ms for the key's head op; a wake already pending at or before then is kept. */
function wakeFor(key: string, ms: number): void {
  const at = Date.now() + ms;
  const pending = wakes.get(key);
  if (pending && pending.at <= at) return;
  if (pending) {
    clearTimeout(pending.timer);
    timers.delete(pending.timer);
  }
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (wakes.get(key)?.timer === timer) wakes.delete(key);
    kickRows();
  }, Math.max(0, ms));
  timer.unref?.();
  timers.add(timer);
  wakes.set(key, { at, timer });
}

/** Decision 26: the flush runs at every accept and every settle; each key sends its first op, at most one at a time. */
export function kickRows(): void {
  if (kickQueued) return;
  kickQueued = true;
  queueMicrotask(() => {
    kickQueued = false;
    outsideLedgers(() => startDue(false));
  });
}

function startDue(force: boolean): Promise<void>[] {
  const backend = rowBackend();
  if (!backend) return [];
  const started: Promise<void>[] = [];
  const now = Date.now();
  for (const [key, ops] of opsByKey) {
    const run = running.get(key);
    if (run) {
      if (force) started.push(run);
      continue;
    }
    // After a deposition only the attempts already on the wire run to their end.
    if (deposedWords !== null) continue;
    const head = ops.find(isOpen);
    if (!head || head.frozen) continue;
    // A timer can fire before a Date.now() due time: the head waits for what is left of its backoff.
    if (!force && head.retryAt > now) {
      wakeFor(key, head.retryAt - now);
      continue;
    }
    const attempt = runAttempt(backend, head).finally(() => {
      running.delete(key);
      kickRows();
    });
    running.set(key, attempt);
    started.push(attempt);
  }
  return started;
}

/**
 * One pass: each key's first op unstored is tried now (its backoff aside), then each stored op's mirror write is
 * waited for once. Nothing is sent while the facade has no data pool.
 */
export async function flushRows(): Promise<void> {
  await Promise.all(outsideLedgers(() => startDue(true)));
  await Promise.all([...mirrorRuns.values()]);
}

const tagNow = (): string | null => {
  const view = databaseView();
  return view && view.generation !== null ? mainTagOf(view.generation, view.machine) : null;
};

export const updatedBy = (): string => `${getNodeName()}/${processId()}`;

function storedOf(row: any): StoredRow | null {
  if (!row) return null;
  const body = Buffer.isBuffer(row.body) ? row.body : Buffer.from(String(row.body ?? ''), 'utf8');
  return { body, sha: String(row.sha), by: String(row.updated_by ?? ''), at: new Date(row.updated_at) };
}

export const nodeOf = (by: string): string => {
  const cut = by.lastIndexOf('/');
  return cut < 0 ? by : by.slice(0, cut);
};

/** T22's facts of a changed-elsewhere refusal: the stored row's writer machine and time, none when the row is gone. */
const changedBy = (row: { by: string; at: Date } | null): { by?: string; at?: Date } => (row ? { by: nodeOf(row.by), at: row.at } : {});

/** Decision 6's log of a plain write that met another machine's change. */
const changedLog = (key: string, row: StoredRow): string =>
  `[Shared] Not saved: ${key}: ${nodeOf(row.by)} changed it at ${row.at.toISOString()} after this machine read it; this machine now holds that version`;

/** T32, decision 109's two forms. */
const checkLog = (key: string, checked: string, row: { by: string; at: Date } | null): string => (row
  ? `[Shared] Not saved: ${key}: it was built on ${checked}, which ${nodeOf(row.by)} changed at ${row.at.toISOString()} after this machine read it; this machine now holds that version`
  : `[Shared] Not saved: ${key}: it was built on ${checked}, which is no longer in the database`);

/** T35's key forms. */
export function rowTimeoutText(key: string, t: { bytes: number; elapsedMs: number; boundMs: number; atBound: boolean }): string {
  const kib = Math.ceil(t.bytes / 1024);
  const bound = Math.round(t.boundMs / 1000);
  return t.atBound
    ? `[Shared] Saving ${key}: a statement of ${kib} KiB did not finish within the ${bound} s bound (SQLSTATE 57014); a slow link to the database, a slow database or a lock held by another transaction can cause this (this machine tries again)`
    : `[Shared] Saving ${key}: a statement of ${kib} KiB was cancelled after ${(t.elapsedMs / 1000).toFixed(1)} s, before the ${bound} s bound (SQLSTATE 57014); a cancel request from outside the bot, such as pg_cancel_backend, ends a statement this way (this machine tries again)`;
}

const unconfirmedLog = (key: string, cause: string): string =>
  `[Shared] Can't confirm whether ${key} was saved: the database's answer to the save was lost and could not be checked (${cause})`;

/** The keys an attempt locks, in the sorted order of the key strings (decision 102, as 15 orders module locks). */
const lockKeys = (op: RowOp): string[] => [...new Set([op.key, ...Object.keys(op.check ?? {})])].sort();

/** The check's compare of each other key (102): the T32 refusal, or null when every one holds what the op was built on. */
function checkRefusal(op: RowOp, rows: Array<{ key: string; row: any }>): RowStop | null {
  for (const { key, row } of rows) {
    const want = op.check![key];
    const have = row ? String(row.sha) : null;
    if (have === want) continue;
    const at = row ? { by: String(row.updated_by ?? ''), at: new Date(row.updated_at) } : null;
    return { kind: 'refused', refusal: { cause: 'changed-elsewhere', ...changedBy(at) }, log: checkLog(op.key, key, at), checked: key };
  }
  return null;
}

/** Decision 5 and C11: every fn of the op again, in order, on the stored value (or each fn's default with no row). */
function rerunAll(op: RowOp, stored: StoredRow | null): { ok: true; body: Buffer } | { ok: false; reason: string } {
  let current: unknown;
  if (stored) {
    try {
      current = JSON.parse(stored.body.toString('utf8'));
    } catch (error) {
      // The stored body is no JSON: the re-run fails as a throwing fn does, with the parse error.
      const failed = deps.rerun(op.key, () => { throw error; }, null);
      return failed.ok ? { ok: false, reason: String(error) } : failed;
    }
  }
  let text = '';
  for (const [i, step] of op.updates!.entries()) {
    const re = deps.rerun(op.key, step.fn, i === 0 && !stored ? structuredClone(step.defaultValue) : current);
    if (!re.ok) return re;
    text = re.text;
    current = re.value;
  }
  return { ok: true, body: Buffer.from(text, 'utf8') };
}

/** The upsert of a body, its pieces past the first when the values would pass 4 MiB a statement (C4), the op id and the notification. */
function writeStatements(op: RowOp, attempt: Attempt, body: Buffer | null, sha: string): SharedStatement<RowStop>[] {
  const tail = (rev: unknown): SharedStatement<RowStop>[] => [
    ...carriedInserts(op),
    { text: OP_SQL, values: [attempt.id] },
    { text: NOTIFY_SQL, values: [JSON.stringify({ k: 'doc', key: op.key, sha, rev: Number(rev), by: processId() })] },
  ];
  if (body === null) {
    return [{ text: DELETE_SQL, values: [op.key], next: res => tail(res.rows[0]?.rev ?? 0) }];
  }
  const by = updatedBy();
  const first = FLUSH_STATEMENT_BYTES - Buffer.byteLength(op.key) - Buffer.byteLength(sha) - Buffer.byteLength(by);
  const piece = FLUSH_STATEMENT_BYTES - Buffer.byteLength(op.key);
  const pieces: Buffer[] = [];
  for (let at = Math.min(first, body.length); at < body.length; at += piece) pieces.push(body.subarray(at, Math.min(body.length, at + piece)));
  return [{
    text: UPSERT_SQL,
    values: [op.key, body.subarray(0, Math.min(first, body.length)), sha, by],
    next: res => [...pieces.map(p => ({ text: APPEND_SQL, values: [op.key, p] })), ...tail(res.rows[0]?.rev)],
  }];
}

const LINE_INSERT_SQL = 'INSERT INTO smdb_data.shared_lines (key, id, line) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING';

const carriedInserts = (op: RowOp): SharedStatement<RowStop>[] =>
  (op.carried?.lines ?? []).map(l => ({ text: LINE_INSERT_SQL, values: [op.carried!.key, l.id, l.line] }));

/** Decisions 4 to 6 on the row read under the lock: the write's statements, or how the attempt ends. */
function decide(op: RowOp, attempt: Attempt, row: any): SharedStatement<RowStop>[] | { stop: RowStop } {
  const stored = storedOf(row);
  attempt.read = stored;
  const storedSha = stored?.sha ?? 'absent';
  let body = op.body;
  if (storedSha !== op.base) {
    if (!op.updates) return { stop: { kind: 'refused', refusal: { cause: 'changed-elsewhere', ...changedBy(stored) }, ...(stored ? { log: changedLog(op.key, stored) } : {}) } };
    const re = rerunAll(op, stored);
    if (!re.ok) return { stop: { kind: 'refused', refusal: { cause: 'changed-elsewhere', reason: re.reason, ...changedBy(stored) } } };
    body = re.body;
  }
  const sha = body === null ? 'absent' : shaOf(body);
  if (sha === storedSha) {
    if (!op.carried) return { stop: { kind: 'same' } };
    // Decision 47: a no-change write writes no doc row and sends no notification, and still stores its lines and op id.
    attempt.body = stored?.body ?? null;
    attempt.sha = storedSha;
    return [...carriedInserts(op), { text: OP_SQL, values: [attempt.id] }];
  }
  attempt.body = body;
  attempt.sha = sha;
  return writeStatements(op, attempt, body, sha);
}

/** An op holding no unknown id: its statements built before BEGIN, the compare inside the transaction (C4). */
function plainSpec(op: RowOp, attempt: Attempt): SharedTxSpec<RowStop> {
  return {
    check: null,
    statements: () => {
      const locks: SharedStatement<RowStop>[] = lockKeys(op).map((key, i) => ({
        text: LOCK_SQL,
        values: [key],
        ...(i === 0 ? { next: res => { attempt.now = res.rows[0]?.now ?? null; } } : {}),
      }));
      const checked: SharedStatement<RowStop>[] = Object.keys(op.check ?? {}).sort().map(key => ({
        text: CHECKED_SQL,
        values: [key],
        next: res => {
          const refused = checkRefusal(op, [{ key, row: res.rows[0] }]);
          return refused ? { stop: refused } : undefined;
        },
      }));
      return [...locks, ...checked, { text: DOC_SQL, values: [op.key], next: res => decide(op, attempt, res.rows[0]) }];
    },
  };
}

export const UNKNOWN_TOO_OLD = 'its oldest attempt was made 6 or more days ago';

/** Decision 24: the op's oldest attempt of unknown fate is 6 days old by the database's now(). */
export function unknownTooOld(op: RowOp, now: Date | null): boolean {
  const oldest = op.unknown.reduce<number | null>((min, u) => (u.at === null ? min : Math.min(min ?? Infinity, new Date(u.at).getTime())), null);
  return now !== null && oldest !== null && new Date(now).getTime() - oldest >= SIX_DAYS_MS;
}

/** D6 and decision 52: an op holding unknown ids checks them under its locks first, in one 40 s deadline. */
function checkSpec(op: RowOp, attempt: Attempt): SharedTxSpec<RowStop> {
  const locks = lockKeys(op);
  const checkedKeys = Object.keys(op.check ?? {}).sort();
  return {
    check: [
      ...locks.map(key => ({ text: LOCK_SQL, values: [key] })),
      { text: OPS_SQL, values: [op.unknown.map(u => u.id)] },
      ...checkedKeys.map(key => ({ text: CHECKED_SQL, values: [key] })),
      { text: DOC_SQL, values: [op.key] },
    ],
    statements: rows => {
      const answers = rows!;
      attempt.now = answers[0].rows[0]?.now ?? null;
      const docRow = answers[answers.length - 1].rows[0];
      if (answers[locks.length].rows.length > 0) {
        attempt.read = storedOf(docRow);
        return 'landed';
      }
      if (unknownTooOld(op, attempt.now)) return { stop: { kind: 'unconfirmed', cause: UNKNOWN_TOO_OLD } };
      // Under the locks no earlier attempt can still be running, and none landed.
      op.unknown = [];
      if (op.frozen) return { stop: { kind: 'checked' } };
      const refused = checkRefusal(op, checkedKeys.map((key, i) => ({ key, row: answers[locks.length + 1 + i].rows[0] })));
      if (refused) return { stop: refused };
      return decide(op, attempt, docRow);
    },
  };
}

async function runAttempt(backend: RowBackend, op: RowOp): Promise<void> {
  op.state = 'wire';
  op.attempts += 1;
  const attempt: Attempt = { id: randomUUID(), now: null, read: null, body: null, sha: 'absent', main: tagNow() };
  const spec = op.work
    ? op.work.spec(op, attempt.id, now => { attempt.now = now; })
    : op.unknown.length > 0 ? checkSpec(op, attempt) : plainSpec(op, attempt);
  spec.onCommitSent = () => { op.commitOnWire = true; };
  (spec as WebuiTxSpec<RowStop>).onTarget = tag => { attempt.main = tag; };
  let outcome: SharedTxOutcome<RowStop>;
  try {
    outcome = await backend.sharedTx(spec);
  } catch (error) {
    outcome = { kind: 'failed', step: 'statements', detail: error instanceof Error ? error.message : String(error) };
  } finally {
    op.commitOnWire = false;
  }
  settle(op, attempt, outcome);
}

function settle(op: RowOp, attempt: Attempt, outcome: SharedTxOutcome<RowStop>): void {
  switch (outcome.kind) {
    case 'committed':
      if (op.work) return landWork(op);
      return land(op, attempt.body, attempt.sha, attempt.main);
    case 'landed':
      if (op.work) return landWork(op);
      // Decision 52: the stored version, another machine's later one when there is one, never the op's body.
      return land(op, attempt.read?.body ?? null, attempt.read?.sha ?? 'absent', attempt.main);
    case 'stopped': {
      const stop = outcome.value;
      if (stop.kind === 'checked') {
        op.state = 'queued';
        changed(op);
        return;
      }
      if (stop.kind === 'same') return op.work ? landWork(op) : land(op, attempt.read?.body ?? null, attempt.read?.sha ?? 'absent', attempt.main);
      if (stop.kind === 'unconfirmed') {
        console.error(unconfirmedLog(op.key, stop.cause));
        return end(op, 'unconfirmed');
      }
      if (stop.log) console.warn(stop.log);
      refuse(op, stop.refusal);
      if (stop.checked !== undefined) checkedApplier?.(stop.checked);
      return;
    }
    case 'refused':
      op.cause = outcome.detail;
      return tryEnded(op);
    case 'failed':
      op.cause = outcome.detail;
      if (outcome.step === 'build' || (outcome.step === 'statements' && /^(22|23|54)/.test(outcome.code ?? ''))) {
        return refuse(op, outcome.detail === undefined ? { cause: 'io' } : { cause: 'io', reason: outcome.detail });
      }
      if (outcome.timeout) console.warn(rowTimeoutText(op.key, outcome.timeout));
      return tryEnded(op);
    case 'unknown':
      op.unknown.push({ id: attempt.id, at: attempt.now });
      op.cause = outcome.detail ?? 'no answer';
      op.lostCause = op.cause;
      return tryEnded(op);
  }
}

/** A try that ended without an outcome: the op stays queued on the flush's backoff, 1 s doubling to 30 s with jitter. */
function tryEnded(op: RowOp): void {
  if (deposedWords !== null) return endDeposed(op);
  op.state = 'queued';
  op.triesFailed += 1;
  const wait = backoffMs(op.triesFailed);
  op.retryAt = Date.now() + wait;
  wakeFor(op.key, wait);
  changed(op);
}

function remove(op: RowOp): void {
  const ops = opsByKey.get(op.key);
  if (!ops) return;
  const at = ops.indexOf(op);
  if (at >= 0) ops.splice(at, 1);
  if (ops.length > 0) return;
  opsByKey.delete(op.key);
  for (const listener of [...settledListeners]) queueMicrotask(() => listener(op.key, op));
}

const settledListeners = new Set<(key: string, last: RowOp) => void>();

let checkedApplier: ((key: string) => void) | null = null;

/** Decision 102: the applier the flush runs for a checked key whose sha differed (sharedMirror.ts sets it). */
export function setCheckedKeyApplier(fn: ((key: string) => void) | null): void {
  checkedApplier = fn;
}

/** Called once a key has no op left in this process, with the op that left last (21 step 1: the applier runs it then). */
export function onRowKeySettled(listener: (key: string, last: RowOp) => void): () => void {
  settledListeners.add(listener);
  return () => { settledListeners.delete(listener); };
}

function end(op: RowOp, state: 'landed' | 'refused' | 'unconfirmed'): void {
  op.state = state;
  op.unknown = [];
  remove(op);
  changed(op);
}

/** Decision 51: a refused op takes with it each plain op behind whose base is the sha of its body, with the same cause. */
function refuse(op: RowOp, refusal: RowRefusal): void {
  const behind = (opsByKey.get(op.key) ?? []).slice((opsByKey.get(op.key) ?? []).indexOf(op) + 1);
  op.refusal = refusal;
  let builtOn = op.body === null ? 'absent' : shaOf(op.body);
  end(op, 'refused');
  // A lines key's ops are built on no body: a refused one takes none with it.
  if (op.work) return;
  for (const next of behind) {
    if (next.state !== 'queued' || next.work || next.updates || next.base !== builtOn) continue;
    builtOn = next.body === null ? 'absent' : shaOf(next.body);
    next.refusal = op.refusal;
    end(next, 'refused');
  }
}

let landedOps = 0;

/** The row ops stored so far by this process: the exit drain's progress counts them (C6). */
export function rowOpsLanded(): number {
  return landedOps;
}

/**
 * Decision 24 and row 83: at the exit drain's end, an op holding an attempt of unknown fate that no check is on the
 * wire for ends 'unconfirmed'.
 */
export function unconfirmUnansweredRows(cause: string): void {
  for (const ops of [...opsByKey.values()]) {
    for (const op of [...ops]) {
      if (op.state !== 'queued' || op.unknown.length === 0) continue;
      console.error(unconfirmedLog(op.key, cause));
      end(op, 'unconfirmed');
    }
  }
}

/** A lines key's op has no mirror: it is out of the queue once stored. */
function landWork(op: RowOp): void {
  landedOps += 1;
  end(op, 'landed');
}

/**
 * Decision 25: the ticket lands; the entry keeps answering reads with the stored body until the mirror holds it. An App
 * Store key's ticket lands only after its landing block (decision 53): in the hold of the section that awaits it, or,
 * with none, once the flush takes the store mutex itself.
 */
function land(op: RowOp, body: Buffer | null, sha: string, main: string | null): void {
  landedOps += 1;
  op.body = body;
  op.stored = { sha, main };
  op.unknown = [];
  if (isStoreKey(op.key) && deposedWords === null) {
    op.state = 'store';
    changed(op);
    if (storeWaits.has(op)) runStoreBlock(op.key);
    else startMirror(op.key);
    return;
  }
  if (deposedWords !== null) {
    end(op, 'landed');
    return;
  }
  op.state = 'mirror';
  changed(op);
  startMirror(op.key);
}

// ============================================================================
// THE DEPOSITION (NB10 decision 20, C9)
// ============================================================================

/** The deposing holder in the writer lock's words, once another process took the data files. */
let deposedWords: string | null = null;

/**
 * Another process took the data files: every op not sent now is refused 'writer-lost', and an op holding an attempt of
 * unknown fate ends 'unconfirmed'. An attempt on the wire ends as it ends. A stored op ends 'landed' with no mirror
 * written after it: the deposer's pass writes the mirror.
 */
export function deposeRows(words: string): void {
  if (deposedWords !== null) return;
  deposedWords = words;
  for (const ops of [...opsByKey.values()]) {
    for (const op of [...ops]) {
      if (op.state === 'queued') endDeposed(op);
      else if (op.state === 'store' || op.state === 'mirror') end(op, 'landed');
    }
  }
}

/** Another process took the data files: no shared transaction of this process starts after it (C13). */
export function rowsDeposed(): boolean {
  return deposedWords !== null;
}

/** This process holds the data files again (the web UI's next take): the flush sends again. */
export function reopenRows(): void {
  if (deposedWords === null) return;
  deposedWords = null;
  kickRows();
}

function endDeposed(op: RowOp): void {
  if (op.unknown.length > 0) {
    console.error(unconfirmedLog(op.key, "another process took the data files' lock"));
    end(op, 'unconfirmed');
    return;
  }
  console.error(`[Data] Not saved: ${op.path}; another process (${deposedWords}) took the data files' lock`);
  op.refusal = { cause: 'writer-lost' };
  end(op, 'refused');
}

// ============================================================================
// THE WEB UI'S SESSIONS (decision 7 as C4 amends it, decision 36, C5, C22, D7)
// ============================================================================

/** A spec the web UI's session also tells the main tag of the entry its checks answered (C23's record entry). */
export type WebuiTxSpec<S> = SharedTxSpec<S> & { onTarget?: (tag: string | null) => void };

/** A web UI check's refusal: NB5's reason, and held for the bot process's held report. */
export interface WebuiRefusal {
  refusal: string;
  held: boolean;
}

/** One short-lived session's client, as node-postgres's; destroy ends its socket at once. */
export interface WebuiSessionClient {
  connect(): Promise<unknown>;
  query(q: { text: string; values?: unknown[]; query_timeout?: number }): Promise<{ rows: any[] }>;
  end(): Promise<unknown>;
  destroy?(): void;
}

export interface WebuiSessionDeps {
  /** D7: the first check, chooseNow() and the second check (webuiWriteTarget). */
  target(): Promise<{ entry: string; tag: string | null; countAtStart: number } | WebuiRefusal>;
  /** D7: the synchronous check before COMMIT (webuiCommitCheck). */
  commitCheck(entry: string, countAtStart: number): WebuiRefusal | null;
  /** A read on the web UI's reader pool under its client bound: the reconcile's, the journal's and C21's. */
  select(text: string, values: unknown[], boundMs: number): Promise<{ rows: any[] }>;
  /** The main tag of the entry the reader resolves now. */
  tag(): string | null;
  session?(config: ClientConfig): WebuiSessionClient;
}

const WEBUI_APP = 'smdb-webui-shared';
const WEBUI_CONNECT_MS = 5000;
const WEBUI_IDLE_MS = 5000;
const WEBUI_IDLE_IN_TX_MS = 10_000;
/** C4: a web UI statement's client bound is its server bound plus this, since no pool keepalive guards the session. */
const WEBUI_CLIENT_MARGIN_MS = 10_000;

let webui: WebuiSessionDeps | null = null;

/** The web UI process sends its row ops on sessions of its own (BotManager sets it); null turns them off. */
export function useWebuiSessions(given: WebuiSessionDeps | null): void {
  webui = given;
  if (given) kickRows();
}

/** T39: the <cause> of a web UI row op the checks refuse. */
export function t39Cause(refusal: WebuiRefusal): string {
  return refusal.held
    ? `the bot process is still confirming the bot's main database: ${refusal.refusal}`
    : `the web panel cannot use the bot's main database now: ${refusal.refusal}`;
}

function realSession(config: ClientConfig): WebuiSessionClient {
  const client = shortLivedClient(config);
  return {
    connect: () => client.connect(),
    query: q => client.query(q as QueryConfig),
    end: () => client.end(),
    destroy: () => { (client as unknown as { connection?: { stream?: { destroy?: () => void } } }).connection?.stream?.destroy?.(); },
  };
}

/**
 * Decision 39's marks: one per session, from its open until its end answered, or for a destroyed client until its last
 * statement's client bound plus 10 s after that statement was sent.
 */
const sessionMarks = new Set<object>();

export function webuiSessionsOpen(): number {
  return sessionMarks.size;
}

function endSession(client: WebuiSessionClient, mark: object, destroy: boolean, last: { at: number; bound: number }): void {
  const clear = () => { sessionMarks.delete(mark); };
  if (destroy) {
    try {
      client.destroy?.();
    } catch {
      // The end below still runs.
    }
    later(last.at + last.bound + WEBUI_CLIENT_MARGIN_MS - Date.now(), clear);
  }
  void client.end().then(clear, clear);
}

/**
 * One shared transaction of the web UI on a session of its own: D7's checks before BEGIN, C4's bounds with each
 * statement's client bound its server bound plus 10 s, D6's landing check under one 40 s deadline, and the synchronous
 * check right before COMMIT. A refusal before COMMIT was sent commits nothing; a report while COMMIT is on the wire
 * leaves the attempt of unknown fate (C22).
 */
async function webuiSharedTx<S>(spec: WebuiTxSpec<S>): Promise<SharedTxOutcome<S>> {
  const ui = webui;
  if (!ui) return { kind: 'failed', step: 'connect', detail: "this process has no connection to the bot's database" };
  let planned: SharedStatement<S>[] | null = null;
  if (spec.check === null) {
    const plan = sharedPlan(() => spec.statements(null));
    if (!Array.isArray(plan)) return plan;
    planned = plan;
  }
  const target = await ui.target();
  if ('refusal' in target) return { kind: 'refused', phase: target.held ? 'held' : 'latched', detail: t39Cause(target) };
  spec.onTarget?.(target.tag);
  const client = (ui.session ?? realSession)({
    ...pgConfig(target.entry),
    application_name: WEBUI_APP,
    connectionTimeoutMillis: WEBUI_CONNECT_MS,
    options: `-c idle_session_timeout=${WEBUI_IDLE_MS} -c idle_in_transaction_session_timeout=${WEBUI_IDLE_IN_TX_MS}`,
  });
  const mark = {};
  sessionMarks.add(mark);
  let last = { at: Date.now(), bound: WEBUI_CONNECT_MS };
  let destroy = false;
  let commitSent = false;
  let step: 'check' | 'statements' = spec.check === null ? 'statements' : 'check';
  let sent = { at: performance.now(), bytes: 0, bound: CHECK_STATEMENT_MS };
  const send = (text: string, values: unknown[], serverBound: number, clientBound: number) => {
    sent = { at: performance.now(), bytes: statementBytes(text, values), bound: serverBound };
    last = { at: Date.now(), bound: clientBound };
    return client.query({ text, values, query_timeout: clientBound });
  };
  const rollback = async (): Promise<boolean> => {
    try {
      await send('ROLLBACK', [], ANSWER_BOUND_MS, ANSWER_BOUND_MS);
      return true;
    } catch {
      return false;
    }
  };
  try {
    try {
      await client.connect();
    } catch (error) {
      destroy = true;
      return { kind: 'failed', step: 'connect', ...describeFailure(error) };
    }
    const results: QueryResult[] = [];
    let queue: SharedStatement<S>[];
    let boundMs: number;
    if (spec.check === null) {
      queue = planned!;
      boundMs = flushBoundMs(largestStatement(queue));
      await send(`BEGIN; SET LOCAL statement_timeout = ${boundMs}`, [], boundMs, boundMs + WEBUI_CLIENT_MARGIN_MS);
    } else {
      const deadline = deadlineIn(ANSWER_BOUND_MS);
      const ask = (text: string, values: unknown[] = []) => send(text, values, CHECK_STATEMENT_MS, Math.max(1, msLeft(deadline)));
      await ask(`BEGIN; SET LOCAL statement_timeout = ${CHECK_STATEMENT_MS}`);
      const checkRows: QueryResult[] = [];
      for (const st of spec.check) checkRows.push(await ask(st.text, st.values) as QueryResult);
      step = 'statements';
      const plan = sharedPlan(() => spec.statements(checkRows));
      if (!Array.isArray(plan)) {
        destroy = !(await rollback());
        return plan;
      }
      queue = plan;
      boundMs = flushBoundMs(largestStatement(queue));
      await send(`SET LOCAL statement_timeout = ${boundMs}`, [], CHECK_STATEMENT_MS, boundMs + WEBUI_CLIENT_MARGIN_MS);
    }
    let boundBytes = largestStatement(queue);
    while (queue.length > 0) {
      const st = queue.shift()!;
      const oversize = oversizeFailure(st);
      if (oversize) {
        destroy = !(await rollback());
        return oversize;
      }
      const bytes = statementBytes(st.text, st.values);
      if (bytes > boundBytes) {
        boundBytes = bytes;
        boundMs = flushBoundMs(bytes);
        await send(`SET LOCAL statement_timeout = ${boundMs}`, [], boundMs, boundMs + WEBUI_CLIENT_MARGIN_MS);
      }
      const res = await send(st.text, st.values, boundMs, boundMs + WEBUI_CLIENT_MARGIN_MS) as QueryResult;
      results.push(res);
      if (!st.next) continue;
      let after: ReturnType<NonNullable<SharedStatement<S>['next']>>;
      try {
        after = st.next(res);
      } catch (error) {
        destroy = !(await rollback());
        return { kind: 'failed', step: 'build', detail: error instanceof Error ? error.message : String(error) };
      }
      if (Array.isArray(after)) queue.unshift(...after);
      else if (after) {
        destroy = !(await rollback());
        return { kind: 'stopped', value: after.stop };
      }
    }
    // D7: no await between this check and COMMIT's send.
    const refusal = ui.commitCheck(target.entry, target.countAtStart);
    if (refusal) {
      destroy = !(await rollback());
      return { kind: 'refused', phase: refusal.held ? 'held' : 'latched', detail: t39Cause(refusal) };
    }
    sent = { at: performance.now(), bytes: statementBytes('COMMIT', []), bound: boundMs };
    last = { at: Date.now(), bound: ANSWER_BOUND_MS };
    const commit = client.query({ text: 'COMMIT', values: [], query_timeout: ANSWER_BOUND_MS });
    commitSent = true;
    spec.onCommitSent?.();
    await commit;
    const moved = ui.commitCheck(target.entry, target.countAtStart);
    if (moved) return { kind: 'unknown', detail: t39Cause(moved) };
    return { kind: 'committed', results };
  } catch (error) {
    const failedAt = performance.now();
    if (commitSent && commitMayHaveLanded(error)) {
      destroy = true;
      return { kind: 'unknown', ...describeFailure(error) };
    }
    // A statement the server answered with an error leaves the session able to roll back; one with no answer does not.
    const answered = typeof (error as { code?: unknown } | null)?.code === 'string';
    destroy = !answered || !(await rollback());
    const timeout = (error as { code?: unknown } | null)?.code === '57014'
      ? { timeout: { bytes: sent.bytes, elapsedMs: failedAt - sent.at, boundMs: sent.bound, atBound: failedAt - sent.at >= sent.bound } }
      : {};
    return { kind: 'failed', step, ...describeFailure(error), ...timeout };
  } finally {
    endSession(client, mark, destroy, last);
  }
}

const webuiBackend: RowBackend = {
  sharedTx: spec => webuiSharedTx(spec),
  sharedSelect: (text, values, boundMs) => {
    if (!webui) return Promise.reject(new Error("this process has no connection to the bot's database"));
    return webui.select(text, values, boundMs);
  },
  mainTag: () => webui?.tag() ?? null,
};

// ============================================================================
// THE WEB UI'S LAND-OR-CANCEL OVER ROW OPS (decisions 16 and 42's A11, E8)
// ============================================================================

const isFile = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

function openOpsOf(file: string): RowOp[] {
  const out: RowOp[] = [];
  for (const ops of opsByKey.values()) for (const op of ops) if (isOpen(op) && !op.outsideChain && isFile(op.path, file)) out.push(op);
  return out;
}

/** Decision 25 in the web UI: the mirror writes the chain waits for once before it releases the lock; null for none. */
export function rowMirrorsWritten(): Promise<unknown> | null {
  return mirrorRuns.size > 0 ? Promise.all([...mirrorRuns.values()]) : null;
}

/** The mirror paths of the chain's row ops not stored yet: the local chain lands or cancels them before it releases the lock. */
export function rowOpenPaths(): string[] {
  const out = new Set<string>();
  for (const ops of opsByKey.values()) for (const op of ops) if (isOpen(op) && !op.outsideChain) out.add(op.path);
  return [...out];
}

type OpCancel = { outcome: 'landed' } | { outcome: 'cancelled'; cause: string | null } | { outcome: 'unconfirmed'; cause: string };

async function whileOnWire(op: RowOp): Promise<void> {
  while (op.state === 'wire') await (running.get(op.key) ?? new Promise<void>(resolve => { setTimeout(resolve, 5); }));
}

/** One attempt of a frozen op now, outside its backoff: its landing check (E8's chain: chooseNow, a connect, one check). */
async function attemptNow(op: RowOp): Promise<void> {
  const backend = rowBackend();
  if (!backend || running.has(op.key)) return;
  const attempt = runAttempt(backend, op).finally(() => {
    running.delete(op.key);
    kickRows();
  });
  running.set(op.key, attempt);
  await attempt;
}

/**
 * Decision 42's A11 for one op: an attempt on the wire is waited for; an op holding an attempt of unknown fate gets one
 * landing check, and is dropped 'unconfirmed' when that gets no answer; an op whose COMMIT was not sent is cancelled.
 */
async function cancelOp(op: RowOp): Promise<OpCancel> {
  await whileOnWire(op);
  if (op.state === 'queued' && op.unknown.length > 0) {
    const lost = op.lostCause ?? op.cause ?? 'no answer';
    await attemptNow(op);
    await whileOnWire(op);
    if (op.state === 'queued' && op.unknown.length > 0) {
      console.error(unconfirmedLog(op.key, lost));
      end(op, 'unconfirmed');
      return { outcome: 'unconfirmed', cause: lost };
    }
  }
  if (op.state === 'store' || op.state === 'mirror' || op.state === 'landed') return { outcome: 'landed' };
  if (op.state === 'unconfirmed') return { outcome: 'unconfirmed', cause: op.lostCause ?? op.cause ?? 'no answer' };
  if (op.state === 'refused') return { outcome: 'cancelled', cause: op.refusal?.reason ?? op.refusal?.cause ?? null };
  // Never sent whole: no COMMIT of it reached the database, so nothing of it is stored.
  const cause = op.cause;
  op.refusal = cause === null ? { cause: 'io' } : { cause: 'io', reason: cause };
  end(op, 'refused');
  return { outcome: 'cancelled', cause };
}

/** cancelQueued's answer for the paths the row queue holds; no attempt of them starts but the cancel's own. */
async function cancelRowPaths(paths: string[]): Promise<CancelOutcome[]> {
  const held = new Map(paths.map(p => [p, openOpsOf(p)]));
  for (const ops of held.values()) for (const op of ops) op.frozen = true;
  const answers: CancelOutcome[] = [];
  for (const p of paths) {
    let unconfirmed: string | null = null;
    let cancelled: { cause: string | null } | null = null;
    for (const op of held.get(p)!) {
      const r = await cancelOp(op);
      if (r.outcome === 'unconfirmed') unconfirmed ??= r.cause;
      else if (r.outcome === 'cancelled') cancelled ??= { cause: r.cause };
    }
    if (unconfirmed !== null) answers.push({ path: p, outcome: 'unconfirmed', errno: unconfirmed, cut: false, row: true });
    else if (cancelled) answers.push({ path: p, outcome: 'cancelled', errno: cancelled.cause, row: true });
    else answers.push({ path: p, outcome: 'landed', row: true });
  }
  return answers;
}

setRowCancel({ holds: file => openOpsOf(file).length > 0, cancel: cancelRowPaths });

// ============================================================================
// THE FLUSH'S MIRROR STEP (decisions 25 and 53)
// ============================================================================

/** App Store keys: their record is the store's, and their ticket lands after the landing block (decision 53). */
const isStoreKey = (key: string): boolean => key.startsWith('global/appstore/');

/** The store mutex and the store lock (appStoreManager.ts), for the landing block of an App Store key. */
export interface StoreLanding {
  /** The store mutex, FIFO: a hold, or null when the wait passed boundMs. */
  acquire(boundMs: number): Promise<{ release(): void } | null>;
  /** Runs a synchronous section under the store lock. */
  locked<T>(fn: () => T): T;
}

let storeLanding: StoreLanding | null = null;

/** Set by appStoreManager.ts when it loads; without it the block runs with neither the mutex nor the lock. */
export function useStoreLanding(given: StoreLanding | null): void {
  storeLanding = given;
}

/** The store mutex and lock appStoreManager.ts set, for the bot's pass of the App Store keys (decision 31). */
export function storeLandingOf(): StoreLanding | null {
  return storeLanding;
}

/** Decision 36's bound on a wait for the store mutex. */
export const STORE_MUTEX_MS = 60_000;

/** App Store ops whose writing section awaits the ticket inside its store mutex hold, with how many waits. */
const storeWaits = new Map<RowOp, number>();

/**
 * Decision 53 for a section that holds the store mutex: waits up to boundMs for the op of ticket to settle. The op's
 * landing block runs in the caller's hold when the COMMIT is answered (or a check finds the op) during the wait.
 * 'open' when it has not settled by then; the op goes on.
 */
export async function awaitStoreTicket(ticket: RowTicket, boundMs: number): Promise<RowOutcome | 'open'> {
  const op = ticket.op;
  storeWaits.set(op, (storeWaits.get(op) ?? 0) + 1);
  let timer: NodeJS.Timeout | undefined;
  let late = false;
  const deadline = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      late = true;
      resolve();
    }, boundMs);
  });
  try {
    if (op.state === 'store') runStoreBlock(op.key);
    for (;;) {
      const state = rowTicketState(ticket);
      if (state === 'landed' || state === 'unconfirmed') return state;
      if (state === 'refused') return { refused: op.refusal ?? { cause: 'io' } };
      if (late) return 'open';
      await Promise.race([rowChange(ticket), deadline]);
    }
  } finally {
    clearTimeout(timer);
    const left = (storeWaits.get(op) ?? 1) - 1;
    if (left > 0) storeWaits.set(op, left);
    else storeWaits.delete(op);
  }
}

function startMirror(key: string): void {
  if (deposedWords !== null) return;
  if (mirrorRuns.has(key)) {
    mirrorAgain.add(key);
    return;
  }
  const run = (isStoreKey(key) ? storeBlockStep(key) : mirrorStep(key)).finally(() => {
    mirrorRuns.delete(key);
    if (mirrorAgain.delete(key)) startMirror(key);
  });
  mirrorRuns.set(key, run);
}

/** 25's line once per errno; an App Store key's line says the App Store here shows the previous version (E4). */
function noteMirrorFailed(key: string, file: string, error: unknown): void {
  const errno = (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error));
  if (mirrorLogged.get(key) === errno) return;
  mirrorLogged.set(key, errno);
  console.error(isStoreKey(key)
    ? movedUnwritten.has(key)
      ? `[Shared] ${file} is stored in the database, but this machine could not write its copy (${errno}); its previous copy was moved aside, and it tries again`
      : `[Shared] ${file} is stored in the database, but this machine could not write its copy (${errno}); the App Store on this machine shows the previous version until it is written, and it tries again`
    : `[Shared] Saved ${key} in the database, but could not write ${file} (${errno}); this machine keeps using the saved version and tries again`);
}

/** A failed mirror write: 25's line once per errno, and the next try on the backoff, 1 s doubling to 30 s. */
function mirrorFailed(key: string, file: string, error: unknown): void {
  noteMirrorFailed(key, file, error);
  const tries = (mirrorTries.get(key) ?? 0) + 1;
  mirrorTries.set(key, tries);
  later(Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (tries - 1)), () => startMirror(key));
}

async function mirrorStep(key: string): Promise<void> {
  const ops = opsByKey.get(key) ?? [];
  const pending = ops.filter(op => op.state === 'mirror');
  const op = pending[pending.length - 1];
  if (!op) return;
  try {
    await withMirrorLock(key, () => writeMirror(op));
  } catch (error) {
    mirrorFailed(key, op.path, error);
    return;
  }
  mirrorTries.delete(key);
  mirrorLogged.delete(key);
  for (const done of pending) {
    if (done.state !== 'mirror') continue;
    done.state = 'landed';
    remove(done);
  }
}

/** Decision 53 with no section awaiting: the flush takes the store mutex itself, retried on its backoff. */
async function storeBlockStep(key: string): Promise<void> {
  if (!(opsByKey.get(key) ?? []).some(op => op.state === 'store' || op.state === 'mirror')) return;
  if (!storeLanding) {
    runStoreBlock(key);
    return;
  }
  const hold = await storeLanding.acquire(STORE_MUTEX_MS);
  if (!hold) {
    const tries = (mirrorTries.get(key) ?? 0) + 1;
    mirrorTries.set(key, tries);
    later(backoffMs(tries), () => startMirror(key));
    return;
  }
  try {
    runStoreBlock(key);
  } finally {
    hold.release();
  }
}

/**
 * Decision 53's landing block of an App Store key, synchronous, under the store lock: the latest stored version written
 * to the mirror (moved aside first as decision 25 says), the store record's entry, then each stored op of the key lands
 * and its waiters resume. When the write fails the ops land as stored with the mirror pending (25), and the flush runs
 * the block again.
 */
function runStoreBlock(key: string): void {
  if (deposedWords !== null) return;
  const pending = (opsByKey.get(key) ?? []).filter(op => op.state === 'store' || op.state === 'mirror');
  const op = pending[pending.length - 1];
  if (!op) return;
  try {
    if (storeLanding) storeLanding.locked(() => writeStoreMirror(op));
    else writeStoreMirror(op);
  } catch (error) {
    for (const held of pending) {
      if (held.state !== 'store') continue;
      held.state = 'mirror';
      changed(held);
    }
    mirrorFailed(key, op.path, error);
    return;
  }
  mirrorTries.delete(key);
  mirrorLogged.delete(key);
  for (const done of pending) {
    done.state = 'landed';
    remove(done);
    changed(done);
  }
}

/** 42 (a)'s line for a mirror moved aside before the stored version was written. */
const movedAsideLog = (file: string, moved: string, deleted: boolean): string => (deleted
  ? `[Shared] Moved ${file} to ${moved}: it differed from the version this machine last took from the database (changed outside the bot, or left by a crash); the database holds no such file, so nothing was put back`
  : `[Shared] Moved ${file} to ${moved}: it differed from the version this machine last took from the database (changed outside the bot, or left by a crash); the database's version is back in its place`);

/** T11 (a) at once when the write after the move aside fails (R2-A1). */
function movedWriteFailed(key: string, file: string, moved: string, error: unknown): void {
  movedUnwritten.add(key);
  const errno = (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error));
  console.warn(`[Shared] Moved ${file} to ${moved}: it differed from the version this machine last took from the database (changed outside the bot, or left by a crash); the database's version could not be written (${errno}); this machine tries again`);
}

const supersededPath = (key: string): string => dataPath('_superseded', `shared-${Date.now()}`, ...key.split('/'));

/** The sha of a mirror's bytes: 'absent' for none, 'unreadable' on any other read error (decision 21 step 2). */
function heldSha(file: string): string {
  try {
    return shaOf(fs.readFileSync(file));
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'unreadable';
  }
}

/** A mirror that is neither the version this machine last took nor the stored one is moved aside first. */
async function writeMirror(op: RowOp): Promise<void> {
  const stored = op.body;
  const sha = op.stored!.sha;
  const record = readDocRecord();
  if (!record.ok) throw new Error(record.reason);
  const entry = record.record.docs[op.key];
  const held = heldSha(op.path);
  let moved: string | null = null;
  if (held !== 'absent' && held !== sha && held !== entry?.sha) {
    moved = supersededPath(op.key);
    await fs.promises.mkdir(path.dirname(moved), { recursive: true });
    await fs.promises.rename(op.path, moved);
  }
  if (held !== sha || moved !== null) {
    try {
      if (stored === null) await fs.promises.unlink(op.path).catch(error => { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; });
      else await atomicReplace(op.path, stored);
    } catch (error) {
      if (moved !== null) movedWriteFailed(op.key, op.path, moved, error);
      throw error;
    }
  }
  movedUnwritten.delete(op.key);
  if (moved !== null) console.warn(movedAsideLog(op.path, moved, stored === null));
  const now = readDocRecord();
  if (!now.ok) throw new Error(now.reason);
  const docs = { ...now.record.docs };
  if (stored === null) delete docs[op.key];
  else docs[op.key] = { sha, stamp: null, main: op.stored!.main };
  writeDocRecord({ ...now.record, docs });
}

/** writeMirror for an App Store key, synchronous, against the store record (decision 53, C10). */
function writeStoreMirror(op: RowOp): void {
  writeStoreKey(op.key, op.path, op.body, op.stored!.sha, op.stored!.main);
}

function writeStoreKey(key: string, file: string, stored: Buffer | null, sha: string, main: string | null): void {
  const record = readStoreRecord();
  if (!record.ok) throw new Error(record.reason);
  const entry = record.record.docs[key];
  const held = heldSha(file);
  let moved: string | null = null;
  if (held !== 'absent' && held !== sha && held !== entry?.sha) {
    moved = supersededPath(key);
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(file, moved);
  }
  if (held !== sha || moved !== null) {
    try {
      if (stored === null) {
        try {
          fs.unlinkSync(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        }
      } else {
        atomicWriteFileSync(file, stored, undefined, { chain: false });
      }
    } catch (error) {
      if (moved !== null) movedWriteFailed(key, file, moved, error);
      throw error;
    }
  }
  movedUnwritten.delete(key);
  if (moved !== null) console.warn(movedAsideLog(file, moved, stored === null));
  const docs = { ...record.record.docs };
  if (stored === null) delete docs[key];
  else docs[key] = { sha, stamp: null, main };
  writeStoreRecord({ ...record.record, docs });
}

/**
 * Store keys a publish or an uninstall stored whose mirror write failed: the latest stored version, retried while the
 * store record's entry is still the one it was owed against (E3).
 */
const storeDocsOwed = new Map<string, { body: Buffer | null; sha: string; main: string | null; against: string }>();

/** The store record's entry sha of key: 'absent' for none, 'unreadable' when the record cannot be read. */
function storeEntrySha(key: string): string {
  const record = readStoreRecord();
  return record.ok ? record.record.docs[key]?.sha ?? 'absent' : 'unreadable';
}

/**
 * A store key that publishModule or unpublishModule stored in its own transaction (decisions 15 and 53): the mirror and
 * the store record's entry, synchronous; the caller holds the store lock. A write that fails logs 25's line once per
 * errno and is tried again on the flush's backoff, under the store mutex and the store lock.
 */
export function landStoreDoc(key: string, body: Buffer | null, sha: string, main: string | null): void {
  if (deposedWords !== null) return;
  storeDocsOwed.set(key, { body, sha, main, against: storeEntrySha(key) });
  tryStoreDoc(key);
}

function tryStoreDoc(key: string): void {
  const owed = storeDocsOwed.get(key);
  if (!owed || deposedWords !== null) return;
  const file = mirrorPathOf(key);
  const now = storeEntrySha(key);
  if (now !== 'unreadable' && now !== owed.against) {
    // A pass wrote the key since: its version is at least as new as the owed one.
    dropOwedStoreDoc(key);
    return;
  }
  try {
    writeStoreKey(key, file, owed.body, owed.sha, owed.main);
  } catch (error) {
    noteMirrorFailed(key, file, error);
    const tries = (mirrorTries.get(key) ?? 0) + 1;
    mirrorTries.set(key, tries);
    later(backoffMs(tries), () => { void retryStoreDoc(key); });
    return;
  }
  if (storeDocsOwed.get(key) === owed) storeDocsOwed.delete(key);
  mirrorTries.delete(key);
  mirrorLogged.delete(key);
}

/** A pass visited the store key and wrote it or found its mirror equal to the row: the pass's version wins (R2-E2). */
export function dropOwedStoreDoc(key: string): void {
  movedUnwritten.delete(key);
  if (!storeDocsOwed.delete(key)) return;
  mirrorTries.delete(key);
  mirrorLogged.delete(key);
}

async function retryStoreDoc(key: string): Promise<void> {
  if (!storeDocsOwed.has(key)) return;
  if (!storeLanding) {
    tryStoreDoc(key);
    return;
  }
  const hold = await storeLanding.acquire(STORE_MUTEX_MS);
  if (!hold) {
    const tries = (mirrorTries.get(key) ?? 0) + 1;
    mirrorTries.set(key, tries);
    later(backoffMs(tries), () => { void retryStoreDoc(key); });
    return;
  }
  try {
    storeLanding.locked(() => tryStoreDoc(key));
  } finally {
    hold.release();
  }
}

/** True in the bot process, whose shared transactions run on its data pool; false in the web UI's sessions. */
export function rowsOnDataPool(): boolean {
  return deps.backend() !== null;
}

/** The main tag of the database the shared transactions write to now: the bot's chooser, or the web UI's reader. */
export function rowMainTag(): string | null {
  if (deps.backend()) return tagNow();
  return webui ? webui.tag() : null;
}

const mirrorLocks = new Map<string, Promise<void>>();

/**
 * Decision 49's mirror mutex: one per key, first in, first out, taken by every mirror write, unlink and move aside of
 * a doc (the pass and the flush's mirror step).
 */
export async function withMirrorLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = mirrorLocks.get(key) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>(resolve => { done = resolve; });
  const tail = before.then(() => mine);
  mirrorLocks.set(key, tail);
  await before;
  try {
    return await fn();
  } finally {
    done();
    if (mirrorLocks.get(key) === tail) mirrorLocks.delete(key);
  }
}

/** Empties the row queue and stops its timers (tests). */
export function _resetRowQueue(): void {
  opsByKey.clear();
  running.clear();
  mirrorRuns.clear();
  mirrorAgain.clear();
  mirrorTries.clear();
  mirrorLogged.clear();
  movedUnwritten.clear();
  changeWaiters.clear();
  storeWaits.clear();
  storeDocsOwed.clear();
  mirrorLocks.clear();
  deposedWords = null;
  sessionMarks.clear();
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  wakes.clear();
}

// ============================================================================
// RULE P OVER THE GLOBAL KEYS (decision 18, NB12's F9)
// ============================================================================

// Built from the files under /data/global at the first global write after a start or a writer take; each accepted
// write and delete keeps it. The App Store's cache holds whole repository clones that no facade write reaches.
let globalTree: KeyTree | null = null;

function walk(dir: string, rel: string, tree: KeyTree): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const key = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (key !== 'appstore/cache') walk(path.join(dir, entry.name), key, tree);
    } else if (!entry.name.endsWith('.tmp')) {
      tree.add(key);
    }
  }
}

function tree(): KeyTree {
  if (!globalTree) {
    globalTree = new KeyTree();
    walk(path.join(DATA_ROOT, 'global'), '', globalTree);
  }
  return globalTree;
}

/** Rule P for a write of a key below /data/global: the collision, or null when it fits. */
export function globalPlacement(rel: string): Collision | null {
  return tree().check(rel);
}

export function noteGlobalKey(rel: string): void {
  tree().add(rel);
}

export function dropGlobalKey(rel: string): void {
  globalTree?.remove(rel);
}

/** What this process knew of the global keys may be stale (a writer take, a test): the next write lists them again. */
export function forgetGlobalTree(): void {
  globalTree = null;
}
