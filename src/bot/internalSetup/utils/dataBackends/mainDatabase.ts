import * as fs from 'fs';
import type { ClientConfig, QueryConfig } from 'pg';
import { parseAddressList, type ListEntry } from '../../../../utils/databaseAddress';
import type { DatabaseChooser, LatchCause, PostgresBackend, Standing } from './postgresBackend';
import type { RetireOutcome } from './backend';

/**
 * Choosing the main database among the addresses of DATA_BACKEND_URL (NB5 decisions 4 to 6 and 9).
 * `decideMain` is pure: it decides from one probe pass and, at generation 1 or above, the newest switch notice.
 */

export interface AnsweredProbe {
  kind: 'answered';
  /** The display form `<host>:<port>/<database>`. */
  address: string;
  /** The raw entry of the list, used to build a pool. */
  entry: string;
  inRecovery: boolean;
  readOnly: boolean;
  generation: number;
  machine: string | null;
  since: string | null;
  sysid: string | null;
  started: string;
  storeId: string | null;
}

export interface RefusedProbe {
  kind: 'refused';
  address: string;
  entry: string;
}

export interface FailedProbe {
  kind: 'failed';
  address: string;
  entry: string;
  cause: string;
  loggedIn?: true;
}

export type Probe = AnsweredProbe | RefusedProbe | FailedProbe;

export type NoticeRead =
  | { kind: 'none' }
  | { kind: 'notice'; generation: number; machine: string; date: string }
  | { kind: 'failed'; cause: string; status?: number; retryAfterMs?: number };

export type WaitOutcome =
  | 'unreachable' | 'login-refused' | 'mixed-stores' | 'tie' | 'replaced' | 'no-main' | 'behind-notice' | 'cant-check'
  | 'unknown-store';

export type Decision =
  | { outcome: 'chosen'; chosen: AnsweredProbe; generation: number; machine: string | null; logs: string[] }
  | { outcome: 'needs-notice'; chosen: AnsweredProbe; generation: number; logs: string[] }
  | { outcome: WaitOutcome; reason: string; logs: string[]; failed: FailedProbe[] };

export interface DecideOptions {
  markerStoreId: string | null;
  noticeCheckOff: boolean;
}

const writable = (p: AnsweredProbe) => !p.inRecovery && !p.readOnly;

/** Decision 4: an address whose generation or store id could not be read may hold the main, so it blocks a choice. */
const UNREADABLE_CAUSE = /^an unreadable (generation|store id)\b/;

function sameServer(a: AnsweredProbe, b: AnsweredProbe): boolean {
  return a.started === b.started && (a.sysid === null || b.sysid === null || a.sysid === b.sysid);
}

/** Answered addresses grouped by server identity (decision 5), each group in list order. */
function servers(probes: AnsweredProbe[]): AnsweredProbe[][] {
  const groups: AnsweredProbe[][] = [];
  for (const p of probes) {
    const group = groups.find(g => sameServer(g[0], p));
    if (group) group.push(p);
    else groups.push([p]);
  }
  return groups;
}

const withMachine = (address: string, machine: string | null) => (machine ? `${address} (${machine})` : address);

function failedClause(failed: FailedProbe[], refused: RefusedProbe[]): string {
  const parts = [
    ...refused.map(p => `${p.address}: refused the login (SQLSTATE 28000)`),
    ...failed.map(p => `${p.address}: ${p.cause}`),
  ];
  return parts.join(', ');
}

/** The DM text names the notices; a 4xx other than 429 also names the override (decision 9). */
export function cantCheckText(address: string, generation: number, notice: { cause: string; status?: number }): string {
  const tail = notice.status !== undefined && notice.status >= 400 && notice.status < 500 && notice.status !== 429
    ? "; fix the bot's DMs with its owner, or set DATA_NOTICE_CHECK=off to rely on the databases alone"
    : '';
  return `can't confirm that ${address} (generation ${generation}) is still the main: the switch notices could not be read (${notice.cause})${tail}`;
}

export function usingLine(address: string, generation: number, machine: string | null): string {
  return generation === 0
    ? `[Database] Using ${address}: it accepts writes and no main generation is recorded`
    : `[Database] Using ${address} (generation ${generation}, ${machine ?? 'no machine named'}): the database that accepts writes with the highest main generation`;
}

export function decideMain(probes: Probe[], notice: NoticeRead | undefined, opts: DecideOptions): Decision {
  const logs: string[] = [];
  const failed: FailedProbe[] = probes.filter((p): p is FailedProbe => p.kind === 'failed');
  const refused = probes.filter((p): p is RefusedProbe => p.kind === 'refused');
  const answered: AnsweredProbe[] = [];
  for (const p of probes) {
    if (p.kind !== 'answered') continue;
    if (p.storeId !== null && opts.markerStoreId !== null && p.storeId !== opts.markerStoreId) {
      failed.push({ kind: 'failed', address: p.address, entry: p.entry, cause: `another bot's store (${p.storeId})`, loggedIn: true });
      logs.push(`[Database] Ignoring ${p.address}: it holds another bot's store (${p.storeId}), not this machine's (${opts.markerStoreId})`);
      continue;
    }
    answered.push(p);
  }
  const wait = (outcome: WaitOutcome, reason: string): Decision => ({ outcome, reason, logs, failed });
  const unreadable = failed.filter(p => UNREADABLE_CAUSE.test(p.cause));
  const unreadableWait = (): Decision | null => (unreadable.length > 0
    ? wait('no-main', `can't confirm which database is the main: ${failedClause(unreadable, [])}; the bot waits until those rows can be read or the owner switches in the Bot Manager`)
    : null);

  if (answered.length === 0) {
    const blocked = unreadableWait();
    if (blocked) return blocked;
    if (failed.some(p => p.loggedIn)) {
      return wait('unreachable', `No database in DATA_BACKEND_URL can be used (${failedClause(failed, refused)})`);
    }
    if (refused.length > 0) {
      return wait('login-refused', "Every database in DATA_BACKEND_URL that answers refuses the bot's login (SQLSTATE 28000); the Bot Manager blocks the login during maintenance");
    }
    return wait('unreachable', `No database in DATA_BACKEND_URL answers (${failedClause(failed, refused)})`);
  }

  if (opts.markerStoreId === null) {
    const stores = new Map<string, string>();
    for (const p of answered) if (p.storeId !== null && !stores.has(p.storeId)) stores.set(p.storeId, p.address);
    if (stores.size >= 2) {
      const list = [...stores].map(([id, address]) => `store ${id} at ${address}`).join(', ');
      return wait('mixed-stores', `DATA_BACKEND_URL reaches databases of different bots (${list}) and this machine records no store id yet; remove the wrong address`);
    }
  }

  const top = Math.max(...answered.map(p => p.generation));
  const atTop = answered.filter(p => p.generation === top);
  const topRow = atTop[0];
  const writableTop = servers(atTop.filter(writable));

  if (writableTop.length >= 2) {
    const [a, b] = writableTop;
    return wait('tie', tieText(top, withMachine(a[0].address, a[0].machine), withMachine(b[0].address, b[0].machine)));
  }

  if (writableTop.length === 0) {
    const lower = answered.filter(p => writable(p) && p.generation < top).sort((x, y) => y.generation - x.generation);
    if (lower.length > 0) {
      const old = lower[0];
      return wait('replaced', replacedText(old.address, old.generation, old.machine, topRow.machine, topRow.since, top));
    }
    const kinds = atTop.map(p => `${p.address} is ${p.inRecovery ? 'a live copy' : 'read-only'}`).join(', ');
    const g = topRow.machine ? `${top} (${topRow.machine})` : `${top}`;
    return unreadableWait() ?? wait('no-main', `No address in DATA_BACKEND_URL reaches a database that accepts writes at main generation ${g}: ${kinds}; the bot waits until the main answers or the owner switches in the Bot Manager`);
  }

  const blocked = unreadableWait();
  if (blocked) return blocked;

  const chosen = writableTop[0][0];
  for (const p of answered) {
    if (writable(p) && p.generation < top) {
      logs.push(`[Database] Ignoring ${p.address}: it accepts writes at generation ${p.generation}, below generation ${top} of ${chosen.machine ?? 'the main'}, so it is a replaced main`);
    }
  }
  const pick = (): Decision => ({ outcome: 'chosen', chosen, generation: top, machine: chosen.machine, logs });
  if (top === 0) return pick();
  if (notice === undefined) return { outcome: 'needs-notice', chosen, generation: top, logs };
  if (notice.kind === 'failed') {
    if (opts.noticeCheckOff) {
      logs.push(`[Database] The switch notices could not be read (${notice.cause}); DATA_NOTICE_CHECK is off, so the choice rests on the databases alone`);
      return pick();
    }
    return wait('cant-check', cantCheckText(chosen.address, top, notice));
  }
  if (notice.kind === 'notice') {
    if (notice.generation > top) {
      return wait('behind-notice', behindNoticeText(chosen.address, top, chosen.machine, notice));
    }
    if (notice.generation === top && notice.machine !== chosen.machine) {
      return wait('tie', tieText(top, withMachine(chosen.address, chosen.machine), withMachine(notice.machine, notice.machine)));
    }
  }
  return pick();
}

export function tieText(generation: number, first: string, second: string): string {
  return `Two databases accept writes at main generation ${generation}: ${first} and ${second}; can't confirm which is the main, so the bot stays stopped until the owner chooses one in the Bot Manager`;
}

export function replacedText(address: string, generation: number, machine: string | null, newMachine: string | null, date: string | null, newGeneration: number): string {
  return `The database at ${address} (generation ${generation}, ${machine ?? 'no machine named'}) was replaced by ${newMachine ?? 'another machine'} on ${date ?? 'an unknown date'} (generation ${newGeneration}); the bot stays stopped. If that database is on this machine, rejoin it as a live copy in the Bot Manager; otherwise join the new main's code, or add its address to DATA_BACKEND_URL`;
}

export function behindNoticeText(address: string, generation: number, rowMachine: string | null, notice: { generation: number; machine: string; date: string }): string {
  if (notice.machine === rowMachine) {
    return `can't confirm that ${address} is the main: it holds generation ${generation}, but generation ${notice.generation} was announced for this machine (${notice.machine}) on ${notice.date}; a restore may have lowered it. The bot stays stopped until the Bot Manager raises this database's generation to ${notice.generation} or above`;
  }
  return `can't confirm that ${address} is the main: it holds generation ${generation} (${rowMachine ?? 'no machine named'}), but generation ${notice.generation} was announced for ${notice.machine} on ${notice.date}, and no database in DATA_BACKEND_URL holds it. The bot stays stopped. If ${notice.machine} holds the main now and ${address} is on this machine, rejoin it as a live copy in the Bot Manager; otherwise join the new main's code or add its address to DATA_BACKEND_URL. If a restore lowered this database's generation, the Bot Manager must raise it to ${notice.generation} or above`;
}

// ============================================================================
// THE PROBE (decision 4)
// ============================================================================

export const PROBE_CONNECT_MS = 5_000;
export const PROBE_STATEMENT_MS = 5_000;
export const PASS_BOUND_MS = 10_000;

export type OwnerChannelValue = { kind: 'none' } | { kind: 'id'; id: string } | { kind: 'unreadable'; cause: string };

export interface ProbeSession {
  connect(): Promise<unknown>;
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<unknown>;
}

export interface ProbeDeps {
  /** Opens one short-lived session; the config already holds the entry's own fields, which win over the probe's. */
  session(config: ClientConfig): ProbeSession;
}

const IDENTITY_SQL = "SELECT pg_is_in_recovery() AS rec, current_setting('transaction_read_only') AS ro, pg_postmaster_start_time()::text AS started, (SELECT system_identifier FROM pg_control_system())::text AS sysid";
const IDENTITY_NO_SYSID_SQL = "SELECT pg_is_in_recovery() AS rec, current_setting('transaction_read_only') AS ro, pg_postmaster_start_time()::text AS started, NULL::text AS sysid";
const GENERATION_SQL = 'SELECT machine, generation, since FROM smdb_manager.generation';
const META_SQL = "SELECT key, value FROM smdb_data.meta WHERE key IN ('store_id', 'owner_channel')";
const CERTIFICATE_CODES = /^(CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_|ERR_TLS_CERT_ALTNAME_INVALID|HOSTNAME_MISMATCH)/;

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const missingTable = (error: unknown) => codeOf(error) === '42P01' || codeOf(error) === '3F000';

function loginRefused(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    if ((current as { code?: unknown }).code === '28000') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The cause of a session that did not answer the probe; never the entry's user or password. */
export function connectCause(error: unknown): string {
  const code = codeOf(error);
  if (code === '28P01') return 'a wrong password (28P01)';
  if (code && CERTIFICATE_CODES.test(code)) return `a certificate error (${code})`;
  if (/timeout|timed out/i.test(messageOf(error))) return 'a timeout';
  if (code && /^[0-9A-Z]{5}$/.test(code)) return `SQLSTATE ${code}`;
  return code ? `unreachable (${code})` : 'unreachable';
}

/** Decision 23's value: a JSON string of 17 to 20 digits, or unreadable with its cause. */
export function ownerChannelOf(value: unknown): OwnerChannelValue {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (typeof parsed === 'string' && /^\d{17,20}$/.test(parsed)) return { kind: 'id', id: parsed };
    return { kind: 'unreadable', cause: 'the stored value is not a channel ID of 17 to 20 digits' };
  } catch {
    return { kind: 'unreadable', cause: 'the stored value is not JSON' };
  }
}

export const OWNER_CHANNEL_FILE_SHOWN = '/data/owner-channel.json';

/** A JSON bot's owner channel file, `{ "channelId": "<id>" }`; no file is none (decision 23). */
export function ownerChannelFromFile(file: string): OwnerChannelValue {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = codeOf(error);
    if (code === 'ENOENT') return { kind: 'none' };
    return { kind: 'unreadable', cause: `the file ${OWNER_CHANNEL_FILE_SHOWN} cannot be read (${code ?? messageOf(error)})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unreadable', cause: `the file ${OWNER_CHANNEL_FILE_SHOWN} is not JSON` };
  }
  const id = (parsed as { channelId?: unknown } | null)?.channelId;
  if (typeof id === 'string' && /^\d{17,20}$/.test(id)) return { kind: 'id', id };
  return { kind: 'unreadable', cause: 'the stored value is not a channel ID of 17 to 20 digits' };
}

export type ProbeAnswer = Probe & { ownerChannel?: OwnerChannelValue; error?: unknown; atLogin?: true; loggedIn?: true };

const sinceText = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? null : String(value);
};

async function askOne(session: ProbeSession, entry: string, address: string, login: { taken: boolean }): Promise<ProbeAnswer> {
  const failed = (cause: string, error?: unknown): ProbeAnswer => ({ kind: 'failed', address, entry, cause, error, ...(login.taken ? { loggedIn: true as const } : {}) });
  try {
    await session.connect();
  } catch (error) {
    if (loginRefused(error)) return { kind: 'refused', address, entry, error };
    return { ...failed(connectCause(error), error), atLogin: true };
  }
  login.taken = true;
  let identity: Record<string, unknown>;
  try {
    identity = (await session.query(IDENTITY_SQL)).rows[0];
  } catch (error) {
    if (codeOf(error) !== '42501') return failed(connectCause(error), error);
    try {
      identity = (await session.query(IDENTITY_NO_SYSID_SQL)).rows[0];
    } catch (again) {
      return failed(connectCause(again), again);
    }
  }
  let generation = 0;
  let machine: string | null = null;
  let since: string | null = null;
  try {
    const rows = (await session.query(GENERATION_SQL)).rows;
    if (rows.length > 1) return failed('an unreadable generation (more than one row)');
    if (rows.length === 1) {
      const g = Number(rows[0].generation);
      if (!Number.isSafeInteger(g) || g < 1) return failed(`an unreadable generation (${String(rows[0].generation)})`);
      generation = g;
      machine = rows[0].machine === null || rows[0].machine === undefined ? null : String(rows[0].machine);
      since = sinceText(rows[0].since);
    }
  } catch (error) {
    if (!missingTable(error)) return failed(`an unreadable generation (${connectCause(error)})`, error);
  }
  let storeId: string | null = null;
  let ownerChannel: OwnerChannelValue = { kind: 'none' };
  try {
    for (const row of (await session.query(META_SQL)).rows) {
      if (row.key === 'store_id') {
        let parsed: unknown;
        try { parsed = JSON.parse(String(row.value)); } catch { parsed = undefined; }
        if (typeof parsed !== 'string') return failed('an unreadable store id (the stored value is not a JSON string)');
        storeId = parsed;
      } else if (row.key === 'owner_channel') {
        ownerChannel = ownerChannelOf(row.value);
      }
    }
  } catch (error) {
    if (!missingTable(error)) return failed(`an unreadable store id (${connectCause(error)})`, error);
  }
  return {
    kind: 'answered', address, entry, inRecovery: identity.rec === true, readOnly: String(identity.ro ?? 'off') === 'on',
    generation, machine, since, sysid: identity.sysid == null ? null : String(identity.sysid), started: String(identity.started),
    storeId, ownerChannel,
  };
}

/** One probe pass over a list (decision 4): one session per entry in parallel, every entry settled within 10 s. */
export async function probePass(entries: ListEntry[], deps: ProbeDeps, boundMs = PASS_BOUND_MS): Promise<ProbeAnswer[]> {
  return Promise.all(entries.map(async (entry): Promise<ProbeAnswer> => {
    if (!entry.usable) return { kind: 'failed', address: entry.shown, entry: entry.raw, cause: entry.cause };
    const session = deps.session({
      application_name: 'smdb-probe',
      connectionTimeoutMillis: PROBE_CONNECT_MS,
      options: `-c statement_timeout=${PROBE_STATEMENT_MS}`,
      query_timeout: PROBE_STATEMENT_MS,
      ...entry.config,
    });
    let timer: NodeJS.Timeout | undefined;
    const login = { taken: false };
    const bound = new Promise<ProbeAnswer>(resolve => {
      timer = setTimeout(() => resolve({
        kind: 'failed', address: entry.shown, entry: entry.raw, cause: 'a timeout', error: new Error('the probe pass bound'),
        ...(login.taken ? { loggedIn: true as const } : {}),
      }), boundMs);
    });
    const asked = askOne(session, entry.raw, entry.shown, login);
    try {
      return await Promise.race([asked, bound]);
    } finally {
      clearTimeout(timer);
      void asked.finally(() => session.end().catch(() => undefined));
    }
  }));
}

// ============================================================================
// THE CHOOSER, THE BOOT WAIT, THE WATCH AND THE STEP (decisions 9 to 12)
// ============================================================================

export const BOOT_PASS_MS = 10_000;
export const WATCH_PASS_MS = 30_000;
export const WATCH_FAST_MS = 5_000;
export const WAIT_LOG_MS = 300_000;
export const NOTICE_OK_MS = 60_000;
export const NOTICE_FAIL_BOOT_MS = 10_000;
export const NOTICE_FAIL_WATCH_MS = 5_000;
export const RECONNECT_READ_AFTER_MS = 60_000;

/** What `data:store` carries to the web UI process (decisions 13 and 17). */
export type StoreReport = { url: string | null; choosing?: true; held?: true; reason?: string };

export interface ChooserDeps {
  /** The list in use (DATA_BACKEND_URL, or the one decision 22 gave), parsed at each pass. */
  entries(): ListEntry[];
  probe(entries: ListEntry[]): Promise<ProbeAnswer[]>;
  readNotice(): Promise<NoticeRead>;
  sendWaitDm(text: string): Promise<{ ok: boolean; cause?: string }>;
  markerStoreId(): string | null;
  noticeCheckOff(): boolean;
  nodeName(): string;
  /** The boot wait's reason while the data layer waits, null once it has a database. */
  onWait(reason: string | null): void;
}

/** Decision 11's step, past the latch: the layers it stops and tells. */
export interface StepHooks {
  stopServing(reason: string): void;
  report(report: StoreReport): void;
  markForResave(): void;
  startLeave(reason: string): void;
}

const ofStore = (p: ProbeAnswer, marker: string | null): p is AnsweredProbe & ProbeAnswer =>
  p.kind === 'answered' && (p.storeId === null || marker === null || p.storeId === marker);

type MarkerRead = { ok: true; id: string | null } | { ok: false; why: string };

/** MarkerUnreadable's `why`, or the message of any other error the marker read threw. */
function unreadableWhy(error: unknown): string {
  const why = (error as { why?: unknown } | null)?.why;
  return typeof why === 'string' ? why : messageOf(error);
}

const standingOf = (p: AnsweredProbe): Standing => p.inRecovery ? 'live copy' : p.readOnly ? 'read-only' : 'writable';
const standingAt = (other: string, standing: Standing, generation: number) =>
  standing === 'writable' ? `${other} accepts writes at generation ${generation}` : `${other} is ${standing === 'live copy' ? 'a live copy' : 'read-only'} at generation ${generation}`;

const cantConfirmStore = (why: string) => `${why}, so the bot can't confirm which store this machine records`;

/** NB5F: what the chooser says while this machine's marker can't be read (`why` is MarkerUnreadable's). */
export const markerTexts = {
  bootWait: (why: string) => `${cantConfirmStore(why)}; it chooses no database and reads that file again at every check`,
  notMoving: (why: string) =>
    `[Database] Not moving yet: ${cantConfirmStore(why)}; this process keeps its unsaved changes and stays stopped`,
  watchOwn: (why: string, storeId: string, address: string) =>
    `[Database] ${cantConfirmStore(why)}; until it can, the watch counts only the databases of store ${storeId}, the store at ${address}, and a hold does not end`,
  watchAll: (why: string) =>
    `[Database] ${cantConfirmStore(why)}; until it can, the watch counts every database that answers, and a hold does not end`,
  step: (address: string, generation: number, other: string, standing: Standing, otherGeneration: number, why: string) =>
    `can't confirm that this bot process's database ${address} (generation ${generation}) is still the main: ${standingAt(other, standing, otherGeneration)}, and ${why}, so the bot can't tell whether that database holds this bot's store`,
  confirming: (why: string) => `${cantConfirmStore(why)}; checking again`,
};

export class MainChooser implements DatabaseChooser {
  private choice: string | null = null;
  private readonly choiceWaiters: Array<(entry: string | null) => void> = [];
  private waitStarted = false;
  private stopped = false;
  private lastLogin: 'refused' | 'unreachable' = 'unreachable';
  private backend: PostgresBackend | null = null;
  private hooks: StepHooks | null = null;
  private generation = 0;
  private machine: string | null = null;
  private chosenAnswered = true;
  private tiedPasses = 0;
  private draining = false;
  private timer: NodeJS.Timeout | null = null;
  private nextPassAt = Infinity;
  private passRunning = false;
  private passAgain = false;
  private lastPassStart = 0;
  private lastNotice: NoticeRead | null = null;
  private noticeNextAt = 0;
  private noticeRetryAt = 0;
  private noticeFailingSince: number | null = null;
  private highestNotice: { generation: number; machine: string; date: string } | null = null;
  private noticeReading: Promise<NoticeRead> | null = null;
  private readonly logged = new Set<string>();
  private waitText: string | null = null;
  private waitLoggedAt = 0;
  /** The main generation of the move under way, for the re-take's generation rule (decision 12 (d)). */
  moveGeneration = 0;
  private lastPass: { answers: ProbeAnswer[]; at: number } | null = null;
  private lastWait: { outcome: WaitOutcome; reason: string } | null = null;

  constructor(private readonly deps: ChooserDeps) {}

  chosen(): string | null {
    return this.choice;
  }

  awaitChoice(): Promise<string | null> {
    if (this.choice !== null) return Promise.resolve(this.choice);
    if (this.stopped) return Promise.resolve(null);
    const answer = new Promise<string | null>(resolve => this.choiceWaiters.push(resolve));
    if (!this.waitStarted) {
      this.waitStarted = true;
      void this.bootWait();
    }
    return answer;
  }

  lastPassLogin(): 'refused' | 'unreachable' {
    return this.lastLogin;
  }

  holdStarted(backend: PostgresBackend): void {
    this.backend ??= backend;
    this.passSoon();
  }

  confirmNow(): void {
    this.passSoon();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const resolve of this.choiceWaiters.splice(0)) resolve(null);
  }

  /** The backend whose chosen entry the watch probes, and the step's hooks; the watch starts once a choice exists. */
  attach(backend: PostgresBackend, hooks: StepHooks): void {
    this.backend = backend;
    this.hooks = hooks;
    if (this.choice !== null) this.schedule(WATCH_PASS_MS);
  }

  /** The exit drain began: a pass that finds a main starts no move (decision 10). */
  noteExitDrain(): void {
    this.draining = true;
  }

  /** Whether the exit drain began: a move whose target check ends after it goes no further (NB5F decision 4). */
  exitDrainBegan(): boolean {
    return this.draining;
  }

  /** A shard reconnected to Discord: after notice reads failed for over 60 s, one starts at once (decision 10). */
  noteShardReconnect(): void {
    if (this.stopped || this.choice === null || this.noticeFailingSince === null) return;
    if (Date.now() - this.noticeFailingSince <= RECONNECT_READ_AFTER_MS) return;
    void this.readNotice('watch', true).then(read => {
      if (!this.stopped && read.kind === 'notice' && read.generation > this.generation) this.passSoon(true);
    });
  }

  /** Decision 19's database view, without the held counts (the fleet state adds them). */
  view(): Omit<DatabaseView, 'held'> {
    const backend = this.backend;
    const latched = backend?.latchReason() ?? null;
    const connection = backend?.connectionState().state;
    let state: DatabaseView['state'];
    let reason: string | null = null;
    if (this.choice === null) {
      state = this.lastWait?.outcome ?? 'choosing';
      reason = this.lastWait?.reason ?? null;
    } else if (latched !== null) {
      state = backend!.isMoving() ? 'moving' : 'latched';
      reason = latched;
    } else if (connection === 'confirming' || connection === 'outage') {
      state = connection === 'confirming' && this.lastNotice?.kind === 'failed' ? 'cant-check' : 'confirming';
      reason = backend!.holdWords();
    } else state = 'main';
    const chosenEntry = backend?.chosenEntry() ?? this.choice;
    const answers = this.lastPass?.answers ?? [];
    const top = Math.max(0, ...answers.map(a => (a.kind === 'answered' ? a.generation : 0)));
    return {
      chosen: chosenEntry === null ? null : showEntryOf(chosenEntry),
      generation: this.choice === null ? null : this.generation,
      machine: this.choice === null ? null : this.machine,
      state,
      reason,
      addresses: answers.map(a => addressView(a, chosenEntry, top)),
      checkedAgoMs: this.lastPass === null ? null : Math.max(0, Date.now() - this.lastPass.at),
    };
  }

  // THE BOOT WAIT (decision 9)

  /** The marker's store id, read strictly: a marker that can't be read answers why, and nothing is decided on it. */
  private readMarker(): MarkerRead {
    try {
      return { ok: true, id: this.deps.markerStoreId() };
    } catch (error) {
      return { ok: false, why: unreadableWhy(error) };
    }
  }

  private options(markerStoreId: string | null): DecideOptions {
    return { markerStoreId, noticeCheckOff: this.deps.noticeCheckOff() };
  }

  /** Decision 7: a pass in which any address took the login is never a refused login. */
  private noteLogin(answers: ProbeAnswer[]): void {
    const tookLogin = answers.some(p => p.kind === 'answered' || p.loggedIn);
    this.lastLogin = !tookLogin && answers.some(p => p.kind === 'refused') ? 'refused' : 'unreachable';
  }

  private logOnce(lines: string[]): void {
    for (const line of lines) {
      if (this.logged.has(line)) continue;
      this.logged.add(line);
      console.warn(line);
    }
  }

  private async bootWait(): Promise<void> {
    let dmSent = false;
    while (!this.stopped) {
      const started = Date.now();
      const answers = await this.deps.probe(this.deps.entries());
      this.lastPass = { answers, at: Date.now() };
      if (this.stopped) break;
      const marker = this.readMarker();
      if (!marker.ok) {
        this.noteLogin(answers);
        const reason = markerTexts.bootWait(marker.why);
        this.lastWait = { outcome: 'unknown-store', reason };
        this.wait(reason);
        await this.pause(started + BOOT_PASS_MS - Date.now());
        continue;
      }
      let decision = decideMain(answers, undefined, this.options(marker.id));
      if (decision.outcome === 'needs-notice') decision = decideMain(answers, await this.readNotice('boot'), this.options(marker.id));
      if (this.stopped) break;
      this.logOnce(decision.logs);
      if (decision.outcome === 'chosen') {
        this.choose(decision);
        return;
      }
      if (decision.outcome !== 'needs-notice') {
        this.noteLogin(answers);
        this.lastWait = { outcome: decision.outcome, reason: decision.reason };
        this.wait(decision.reason);
        if (decision.outcome === 'cant-check' && !dmSent) {
          dmSent = true;
          const text = `The bot on ${this.deps.nodeName()} cannot confirm which database is its main: ${decision.reason}. It stays stopped and checks the databases and the switch notices again every 10 seconds.`;
          void this.deps.sendWaitDm(text).then(sent => {
            if (!sent.ok) console.error(`[Database] The message to the owner could not be sent (${sent.cause ?? 'no cause given'})`);
          });
        }
      }
      await this.pause(started + BOOT_PASS_MS - Date.now());
    }
    for (const resolve of this.choiceWaiters.splice(0)) resolve(null);
  }

  /** The wait's reason: logged at the first pass, on a change, and every 5 minutes otherwise. */
  private wait(reason: string): void {
    this.deps.onWait(reason);
    const now = Date.now();
    if (reason === this.waitText && now - this.waitLoggedAt < WAIT_LOG_MS) return;
    this.waitText = reason;
    this.waitLoggedAt = now;
    console.warn(`[Database] ${reason}; waiting`);
  }

  private pause(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, Math.max(0, ms));
      timer.unref?.();
    });
  }

  private choose(decision: Extract<Decision, { outcome: 'chosen' }>): void {
    this.choice = decision.chosen.entry;
    this.generation = decision.generation;
    this.machine = decision.machine;
    this.chosenAnswered = true;
    this.deps.onWait(null);
    console.log(usingLine(decision.chosen.address, decision.generation, decision.machine));
    for (const resolve of this.choiceWaiters.splice(0)) resolve(this.choice);
    if (this.backend) this.schedule(WATCH_PASS_MS);
  }

  // THE NOTICE READ RULE (decision 9): 60 s after a read that succeeded, 10 s (boot wait) or 5 s (watch) after a failed
  // one, never before a 429's retry_after.

  private noticeDue(): boolean {
    return Date.now() >= this.noticeNextAt;
  }

  /** A read by the rule; `fresh` asks for one started now unless the last read failed and its retry is not due. */
  private readNotice(mode: 'boot' | 'watch', fresh = false): Promise<NoticeRead> {
    if (this.noticeReading) return this.noticeReading;
    const last = this.lastNotice;
    if (last !== null && !this.noticeDue() && (!fresh || last.kind === 'failed')) return Promise.resolve(last);
    if (last !== null && Date.now() < this.noticeRetryAt) return Promise.resolve(last);
    const reading = this.deps.readNotice().then(read => {
      if (this.stopped) return read;
      const at = Date.now();
      this.lastNotice = read;
      if (read.kind === 'failed') {
        this.noticeRetryAt = read.retryAfterMs !== undefined ? at + read.retryAfterMs : 0;
        this.noticeNextAt = Math.max(at + (mode === 'boot' ? NOTICE_FAIL_BOOT_MS : NOTICE_FAIL_WATCH_MS), this.noticeRetryAt);
        this.noticeFailingSince ??= at;
        if (mode === 'watch' && this.choice !== null) {
          this.logOnce([`[Database] ${cantCheckText(showEntryOf(this.choice), this.generation, read)}`]);
        }
      } else {
        this.noticeNextAt = at + NOTICE_OK_MS;
        this.noticeRetryAt = 0;
        this.noticeFailingSince = null;
        if (read.kind === 'notice' && (!this.highestNotice || read.generation > this.highestNotice.generation)) {
          this.highestNotice = { generation: read.generation, machine: read.machine, date: read.date };
        }
      }
      return read;
    }).finally(() => {
      if (this.noticeReading === reading) this.noticeReading = null;
    });
    this.noticeReading = reading;
    return reading;
  }

  // THE WATCH (decision 10)

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, delayMs);
    this.nextPassAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextPassAt = Infinity;
      void this.runPass();
    }, delay);
    this.timer.unref?.();
  }

  /** The next pass starts 5 s after the last one started, or at once; never two at once. */
  private passSoon(now = false): void {
    if (this.stopped || this.choice === null || !this.backend || !this.hooks) return;
    if (this.passRunning) {
      if (now) this.passAgain = true;
      return;
    }
    const at = now ? Date.now() : Math.max(Date.now(), this.lastPassStart + WATCH_FAST_MS);
    if (at < this.nextPassAt) this.schedule(at - Date.now());
  }

  private nextDelay(started: number): number {
    const backend = this.backend!;
    const quiet = this.chosenAnswered && backend.holdWords() === null && backend.latchReason() === null;
    return started + (quiet ? WATCH_PASS_MS : WATCH_FAST_MS) - Date.now();
  }

  private async runPass(): Promise<void> {
    if (this.stopped || this.passRunning || !this.backend) return;
    this.passRunning = true;
    const started = Date.now();
    this.lastPassStart = started;
    try {
      await this.watchPass();
    } catch (error) {
      console.error('[Database]', error);
    } finally {
      this.passRunning = false;
      const again = this.passAgain;
      this.passAgain = false;
      if (!this.stopped) this.schedule(again ? 0 : this.nextDelay(started));
    }
  }

  private async watchPass(): Promise<void> {
    const backend = this.backend!;
    const epoch = backend.databaseEpoch();
    const chosenEntry = backend.chosenEntry() ?? this.choice!;
    const entries = this.deps.entries();
    if (!entries.some(e => e.raw === chosenEntry)) entries.push({ ...parseAddressList(chosenEntry)[0], index: entries.length + 1 });
    const answers = await this.deps.probe(entries);
    this.lastPass = { answers, at: Date.now() };
    const current = () => !this.stopped && backend.databaseEpoch() === epoch;
    if (!current()) return;
    if (backend.latchReason() !== null) {
      await this.seekMain(answers);
      return;
    }
    const mine = answers.find(a => a.entry === chosenEntry)!;
    const address = mine.address;
    const wasOutage = backend.holdWords() !== null && backend.connectionState().state === 'outage';
    if (mine.kind !== 'answered' && mine.error !== undefined) backend.noteObservation(mine.error, epoch, mine.atLogin === true);
    this.chosenAnswered = mine.kind === 'answered';
    if (backend.connectionState().state === 'connecting') {
      this.deps.onWait(mine.kind === 'answered' ? null
        : `${address} was chosen but does not answer (${mine.kind === 'refused' ? 'refused the login (SQLSTATE 28000)' : mine.cause}); checking the other addresses`);
    }
    if (mine.kind === 'answered' && wasOutage) {
      backend.noteEntryAnswered(epoch);
      this.passAgain = true;
      return;
    }
    // While the marker can't be read, the store compared with is the one the chosen database answered (it is written to).
    const read = this.readMarker();
    let marker: string | null = null;
    let unknownWhy: string | null = null;
    if (read.ok) marker = read.id;
    else if (mine.kind === 'answered' && mine.storeId !== null) {
      marker = mine.storeId;
      this.logOnce([markerTexts.watchOwn(read.why, mine.storeId, address)]);
    } else {
      unknownWhy = read.why;
      this.logOnce([markerTexts.watchAll(read.why)]);
    }
    const mineOwn = ofStore(mine, marker);
    if (mineOwn) {
      this.generation = mine.generation;
      this.machine = mine.machine;
    }
    if (this.generation >= 1 && this.noticeDue()) await this.readNotice('watch');
    if (!current()) return;
    const others = answers.filter((a): a is AnsweredProbe & ProbeAnswer => ofStore(a, marker) && a.entry !== chosenEntry);
    const higher = others
      .filter(a => a.generation > this.generation)
      .sort((x, y) => y.generation - x.generation)[0];
    const notice = this.highestNotice;
    const noticeAbove = notice && notice.generation > this.generation ? notice : null;
    if (higher || noticeAbove) {
      const target = higher ? higher.generation : noticeAbove!.generation;
      const [again] = await this.deps.probe(parseAddressList(chosenEntry));
      if (!current() || backend.latchReason() !== null) return;
      if (again.kind === 'answered' && ofStore(again, marker) && again.generation >= target) {
        this.generation = again.generation;
        this.machine = again.machine;
      } else if (higher && unknownWhy !== null) {
        const standing = standingOf(higher);
        this.step({ kind: 'unknown-store', other: higher.address, generation: higher.generation, standing },
          markerTexts.step(address, this.generation, higher.address, standing, higher.generation, unknownWhy));
        return;
      } else if (higher) {
        const machine = higher.machine ?? 'another machine';
        this.step({ kind: 'replaced', machine, generation: higher.generation },
          `This bot process's database ${address} (generation ${this.generation}) was replaced by ${machine} on ${higher.since ?? 'an unknown date'} (generation ${higher.generation})`);
        return;
      } else {
        this.step({ kind: 'behind-notice', machine: noticeAbove!.machine, generation: noticeAbove!.generation },
          behindNoticeText(address, this.generation, this.machine, noticeAbove!));
        return;
      }
    }
    let rival: AnsweredProbe | null = null;
    if (mineOwn && writable(mine)) {
      const top = Math.max(this.generation, ...others.map(a => a.generation));
      rival = others.find(a => writable(a) && a.generation === this.generation && !sameServer(a, mine)) ?? null;
      if (rival && this.generation >= top) {
        this.tiedPasses += 1;
        if (this.tiedPasses >= 2 && unknownWhy !== null) {
          this.step({ kind: 'unknown-store', other: rival.address, generation: this.generation, standing: 'writable' },
            markerTexts.step(address, this.generation, rival.address, 'writable', this.generation, unknownWhy));
          return;
        }
        if (this.tiedPasses >= 2) {
          this.step({ kind: 'tie', generation: this.generation },
            `Two databases accept writes at main generation ${this.generation} (${address}, ${rival.address}); can't confirm which is the main`);
          return;
        }
      } else {
        rival = null;
        this.tiedPasses = 0;
      }
      if (this.noticeTie(mine, address)) return;
    } else {
      this.tiedPasses = 0;
    }
    if (backend.connectionState().state === 'confirming') await this.confirm(mine, address, rival, epoch);
  }

  private noticeTie(mine: AnsweredProbe, address: string): boolean {
    const notice = this.highestNotice;
    if (!notice || notice.generation !== this.generation || notice.machine === mine.machine) return false;
    this.step({ kind: 'tie', generation: this.generation },
      `Two databases accept writes at main generation ${this.generation} (${address}, ${notice.machine}); can't confirm which is the main`);
    return true;
  }

  /** Decision 13: a confirming pass that chose the entry in use, then at generation 1 or above a notice read after it. */
  private async confirm(mine: ProbeAnswer, address: string, rival: AnsweredProbe | null, epoch: number): Promise<void> {
    const backend = this.backend!;
    let cause: string | null = null;
    if (mine.kind === 'failed') {
      cause = mine.error === undefined ? `${address} could not be checked (${mine.cause}); checking again` : `${address} answered, but ${mine.cause}; checking again`;
    } else if (mine.kind === 'refused') {
      return;
    } else {
      const marker = this.readMarker();
      if (!marker.ok) {
        cause = markerTexts.confirming(marker.why);
      } else if (!ofStore(mine, marker.id)) {
        cause = `${address} answered, but another bot's store (${(mine as AnsweredProbe).storeId}); checking again`;
      } else if (!writable(mine)) {
        cause = `${address} answers but does not accept writes (${mine.inRecovery ? 'a live copy' : 'read-only'}); checking again`;
      } else if (rival) {
        cause = `two addresses answered as different servers at generation ${this.generation} in one check: ${address} and ${rival.address}; checking again`;
      }
    }
    if (cause !== null) {
      backend.noteConfirmingCause(cause, epoch);
      return;
    }
    if (this.generation === 0) {
      backend.confirmHold(epoch);
      return;
    }
    const read = await this.readNotice('watch', true);
    if (this.stopped || backend.databaseEpoch() !== epoch || backend.latchReason() !== null) return;
    if (read.kind === 'failed') {
      if (this.deps.noticeCheckOff()) {
        this.logOnce([`[Database] The switch notices could not be read (${read.cause}); DATA_NOTICE_CHECK is off, so the choice rests on the databases alone`]);
        backend.confirmHold(epoch);
      } else {
        backend.noteConfirmingCause(read.cause, epoch);
      }
      return;
    }
    if (read.kind === 'notice' && read.generation > this.generation) {
      this.passAgain = true;
      return;
    }
    if (mine.kind === 'answered' && this.noticeTie(mine, address)) return;
    backend.confirmHold(epoch);
  }

  /** Decision 11's step, in one synchronous run. A second finding runs nothing more. */
  private step(cause: LatchCause, reason: string): void {
    const backend = this.backend!;
    if (backend.latchReason() !== null) return;
    this.tiedPasses = 0;
    backend.latch(cause);
    const hooks = this.hooks!;
    const run = (fn: () => void) => {
      try { fn(); } catch (error) { console.error('[Database]', error); }
    };
    run(() => hooks.stopServing(reason));
    run(() => hooks.report({ url: null, choosing: true, reason }));
    run(() => hooks.markForResave());
    run(() => hooks.startLeave(reason));
  }

  /** While latched: a pass that finds one main moves to it (decision 11), unless the exit drain began. */
  private async seekMain(answers: ProbeAnswer[]): Promise<void> {
    const backend = this.backend!;
    if (this.generation >= 1 && this.noticeDue()) await this.readNotice('watch');
    if (this.stopped || this.draining) return;
    const marker = this.readMarker();
    if (!marker.ok) {
      this.logOnce([markerTexts.notMoving(marker.why)]);
      return;
    }
    const notice: NoticeRead = this.highestNotice ? { kind: 'notice', ...this.highestNotice } : { kind: 'none' };
    const decision = decideMain(answers, notice, this.options(marker.id));
    this.logOnce(decision.logs);
    if (decision.outcome !== 'chosen') return;
    this.moveGeneration = decision.generation;
    if (await backend.useDatabase(decision.chosen.entry)) {
      this.choice = decision.chosen.entry;
      this.generation = decision.generation;
      this.machine = decision.machine;
      this.chosenAnswered = true;
      this.tiedPasses = 0;
    }
  }
}

const showEntryOf = (entry: string) => parseAddressList(entry)[0]?.shown ?? entry;

/** Decision 19: what the fleet state shows of the database. */
export interface DatabaseView {
  chosen: string | null;
  generation: number | null;
  machine: string | null;
  state: 'choosing' | 'main' | 'replaced' | 'tie' | 'no-main' | 'unreachable' | 'login-refused' | 'behind-notice'
    | 'cant-check' | 'mixed-stores' | 'unknown-store' | 'confirming' | 'latched' | 'moving';
  reason: string | null;
  held: { guilds: number; resave: number } | null;
  addresses: Array<{
    address: string;
    state: 'main' | 'copy' | 'read-only' | 'replaced' | 'refused' | 'failed';
    generation: number | null;
    machine: string | null;
    cause: string | null;
  }>;
  checkedAgoMs: number | null;
}

function addressView(a: ProbeAnswer, chosen: string | null, top: number): DatabaseView['addresses'][number] {
  if (a.kind === 'refused') return { address: a.address, state: 'refused', generation: null, machine: null, cause: 'refused the login (SQLSTATE 28000)' };
  if (a.kind === 'failed') return { address: a.address, state: 'failed', generation: null, machine: null, cause: a.cause };
  const base = { address: a.address, generation: a.generation, machine: a.machine, cause: null };
  if (a.inRecovery) return { ...base, state: 'copy' };
  if (a.readOnly) return { ...base, state: 'read-only' };
  if (a.entry === chosen || a.generation >= top) return { ...base, state: 'main' };
  return { ...base, state: 'replaced' };
}

/** Decision 19: the chooser's view; null with no chooser (a JSON bot). */
export function databaseView(): Omit<DatabaseView, 'held'> | null {
  return active?.view() ?? null;
}

/**
 * The step's and the move's sides that other layers own: NB4's stop-serving step and (c) and (d) (the shard layer),
 * and NB2's leave. Each layer sets its own; until then the step stops nothing there and (c) and (d) pass.
 */
export const stepLayers = {
  stopServing: (_reason: string): void => undefined,
  startLeave: (_reason: string): void => undefined,
  claims: async (_entry: string): Promise<boolean> => true,
  /** An attempt of the move ended after (d). */
  attemptEnded: (): void => undefined,
  /** Whether this process still holds the shard's pair: NB4's loss drops one, a lapse keeps it. */
  holdsShard: (_shardId: number, _shardCount: number): boolean => true,
  /** The `<why>` of the latest latch whose stop-serving step ran, kept after the move; null before any. */
  databaseStopWhy: (): string | null => null,
};

export function setStepLayers(layers: Partial<typeof stepLayers>): void {
  Object.assign(stepLayers, layers);
}

let active: MainChooser | null = null;

/** The chooser this process runs (boot.ts sets it). */
export function setMainChooser(chooser: MainChooser | null): void {
  active = chooser;
}

/** C1 and D10: the release step after the exit drain; ends the watch and its notice reads. No watch, no effect. */
export function stopMainWatch(): void {
  active?.stop();
}

/** The main generation the move under way targets; 0 with no watch. */
export function moveTargetGeneration(): number {
  return active?.moveGeneration ?? 0;
}

/** Decision 10's shard reconnect hook (discord.js `shardReady` and `shardResume`). */
export function noteShardReconnect(): void {
  active?.noteShardReconnect();
}

/** Decision 10: the exit drain began, so no pass starts a move. */
export function noteExitDrain(): void {
  active?.noteExitDrain();
}

// STEP (e) (decision 12, G4, K1)

export interface RetireOnWire {
  guildId: string;
  answer: Promise<RetireOutcome>;
}

export interface SettleDeps {
  /** The retires whose epoch differs from the move's (dataManager.ts `retiresToSettle`). */
  retiresToSettle(epoch: number): RetireOnWire[];
  /** One settled: its entry deleted. */
  settled(guildId: string): void;
  /** The retire reached the target: the flag dropped and the set evicted. */
  reached(guildId: string): void;
  /** Every flag of a set the process still holds gets the move's epoch. */
  flagEpoch(epoch: number): void;
}

const RETIRE_ANSWER_MS = 40_000;

/** Step (e): settles every retire whose COMMIT was sent before the latch, against the target. False ends the attempt. */
export async function settleRetires(backend: Pick<PostgresBackend, 'retireReached'>, epoch: number, entry: string, deps: SettleDeps): Promise<boolean> {
  const target = showEntryOf(entry);
  const didNotReach = (g: string) => console.warn(`[Data] Guild ${g}: its retire did not reach ${target}, so this process re-saves the guild's data there; repeat the retire once the bot runs on ${target}`);
  for (const retire of deps.retiresToSettle(epoch)) {
    const g = retire.guildId;
    let timer: NodeJS.Timeout | undefined;
    const answer = await Promise.race([
      retire.answer,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), RETIRE_ANSWER_MS); }),
    ]).finally(() => clearTimeout(timer));
    const landed = answer && 'retiredAt' in answer ? answer : null;
    if (!landed) {
      didNotReach(g);
      deps.settled(g);
      continue;
    }
    if (landed.moved === 0) {
      console.warn(`[Data] Guild ${g}: its retire moved no rows, so this process re-saves the guild's data on ${target}; repeat the retire once the bot runs on ${target}`);
      deps.settled(g);
      continue;
    }
    let reached: boolean;
    try {
      reached = await backend.retireReached(g, landed.retiredAt);
    } catch (error) {
      console.error(`[Database] Not moving to ${target} yet: can't confirm whether guild ${g}'s retire reached it (${connectCause(error)})`);
      return false;
    }
    if (reached) {
      deps.reached(g);
      console.log(`[Data] Guild ${g}: its retire reached ${target}`);
    } else {
      didNotReach(g);
    }
    deps.settled(g);
  }
  deps.flagEpoch(epoch);
  return true;
}
