// Maintenance in the bot process: the manager's hook (maintenance:enter over IPC), booting in maintenance mode, a
// database login refused with SQLSTATE 28000, and the leave after the shard claims lapsed.

import { ActivityType, Client, GatewayIntentBits, MessageFlags, type PresenceData } from 'discord.js';
import {
  acceptedOpsRunning,
  DEFAULT_MAINTENANCE_MESSAGE,
  handlersInFlight,
  isMaintenanceBoot,
  isMaintenanceGateClosed,
  maintenanceCause,
  maintenanceText,
  markMaintenanceBoot,
  orderRefusesSharedOps,
  setMaintenanceGate,
  setOrderRefusal,
  type MaintenanceCause,
} from './maintenanceGate';
import { readMaintenanceFile } from '../../../utils/maintenanceFile';
import { loadCredentials, resolveDataBackend } from '../../../utils/envLoader';
import { addStopStep, exitProcess, hasHeldWrites, heldElsewhere, isExitDraining, openWorkElsewhere, resaveTarget, saveHeldWrites, stopProcess, unansweredRowOps, unsavedRowPaths } from './dataManager';
import { PASS_BOUND_MS, probePass, setStepLayers, stepLayers, writableAnswer, connectCause, type ProbeAnswer, type SaveOrderRow } from './dataBackends/mainDatabase';
import type { SaveAck } from '../fleet/claimStore';
import { addressListInUse, parseAddressList, showEntry } from '../../../utils/databaseAddress';
import { heldClauses, type HeldCounts } from './heldWords';
import { STOPPED_SERVING_TEXT, stoppedServing } from './servingGate';
import { setupSharedOpsIPC } from './sharedOps';
import { setupBackupIPC } from './ipcBackupHandler';
import { reportWriterStage } from './writerLock';
import { countCrash } from './moduleCrashes';
import { getWorkingSet } from './dataBackends/workingSet';
import { unsavedFilePaths } from './dataBackends/fileBackend';
import { isLoginRefused } from './dataBackends/postgresBackend';
import { shortLivedClient } from './pgClient';
import { attachEntitlementBridge } from './entitlementBridge';
import { getPremiumManager } from './premiumManager';
import { getSubscriptionNotifier } from './subscriptionNotifier';
import { getMetricsCollector } from './metrics/metricsCollector';
import { readShardRecord, type ShardRecord } from '../fleet/shardRecord';

/** The web UI waits 20 seconds for the answer to maintenance:enter; both bounds together stay inside it. */
export const ENTER_BOUNDS = { handlerWaitMs: 5_000, saveBoundMs: 13_000 };
const LOGIN_RETRY_MS = 5_000;
const BOOT_PROBE_TIMEOUT_MS = 5_000;
const DISCORD_RETRY_FIRST_MS = 5_000;
const DISCORD_RETRY_MAX_MS = 60_000;
const WATCH_PROBE_BOUND_MS = 5_000;

const DEFAULT_TIMING = { leaveRetryMs: 5_000, filePollMs: 5_000, restartResendMs: 60_000, heldAfterPasses: 3, leaveSaveBoundMs: ENTER_BOUNDS.saveBoundMs };
let timing = { ...DEFAULT_TIMING };

/** Tests shorten the leave step's retry and save bound, the maintenance.json poll and the restart re-send. */
export function _setMaintenanceTiming(next: Partial<typeof DEFAULT_TIMING>): void {
  timing = { ...timing, ...next };
}

export const MAINTENANCE_PRESENCE: PresenceData = {
  status: 'dnd',
  activities: [{ name: 'Custom Status', type: ActivityType.Custom, state: 'Maintenance' }],
};

/** What the web UI process is told: serving, in maintenance (hook or boot), refused by the database, off Discord for an outage, or held by changes the leave step cannot save. */
export type MaintenanceMode = 'running' | 'maintenance' | 'login-refused' | 'outage' | 'held';
export type LoginProbe = () => Promise<'accepted' | 'refused' | 'unreachable' | 'none'>;
export type SaveAnswer =
  | { saved: true }
  // running: the work that still runs and may save changes, in words; its answer could not count (ruling G8-14).
  | { saved: null; unansweredGuilds: number; unconfirmedFiles: number; unansweredFiles?: number; running?: string }
  | ({ saved: false; running?: string } & HeldCounts);
export type DatabaseAnswer = 'answers' | 'refused' | 'unreachable';
type Held = { unsavedGuilds: number; unsavedFiles: number; unansweredGuilds: number; resaveGuilds?: number; unansweredFiles?: number };

let clientRef: Client | null = null;
let mode: MaintenanceMode = 'running';
let discordStarted = false;
let outageDisconnected = false;
let lapsedSeconds = 0;
let restartRequested = false;
let restartResend: NodeJS.Timeout | null = null;
let shardRestart = false;
let restartAskedEarlier = false;
let leaving = false;
let heldReport: Held | null = null;
// The watcher's last answer; null on a JSON bot or in maintenance mode, where no watcher runs, and before its first probe.
let databaseAnswer: DatabaseAnswer | null = null;
let watchedBackend: WatchedBackend | null = null;
let watching = false;
// Bumped by _resetMaintenance, so a leave step a test started stops with it.
let generation = 0;
const timers = new Set<NodeJS.Timeout>();

/** NX5 decision 8: where a serving process with a claims store reads the save order and writes its answer. */
export interface SaveOrderSource {
  me: { processId: string; nodeId: string; nodeName: string };
  read(): Promise<SaveOrderRow | null>;
  writeAck(ack: SaveAck): Promise<boolean>;
}
type HeldBy = 'order' | 'login' | 'file';
let orderSource: SaveOrderSource | null = null;
// The kept order read; 'unknown' after a failed renewal or a 28000, which keeps heldWhileUnknown, the predicate's answer before it.
let orderRead: SaveOrderRow | null | 'unknown' = null;
let heldWhileUnknown: HeldBy | null = null;
// The login as the last read that reached the database found it; null before any.
let loginState: 'accepted' | 'refused' | null = null;
// The order this process last answered saved true for.
let answeredOrder: string | null = null;
let orderSaving = false;
// The hook's leave could not read: no path leaves until a later read answers (decision 11).
let leaveReadOwed = false;

type Sender = (message: object) => void;
const processSender: Sender = message => {
  if (!process.send) return;
  try {
    process.send(message, () => { /* a closed channel is the parent gone */ });
  } catch { /* the parent is gone */ }
};
let send: Sender = processSender;

/** Tests capture what the bot process sends its parent. */
export function _setMaintenanceSender(sender: Sender | null): void {
  send = sender ?? processSender;
}

/** Tests start each case from a serving process. */
export function _resetMaintenance(): void {
  setMaintenanceGate(null);
  clientRef = null;
  mode = 'running';
  discordStarted = false;
  outageDisconnected = false;
  lapsedSeconds = 0;
  restartRequested = false;
  restartResend = null;
  shardRestart = false;
  restartAskedEarlier = false;
  leaving = false;
  heldReport = null;
  databaseAnswer = null;
  watchedBackend = null;
  watching = false;
  orderSource = null;
  orderRead = null;
  heldWhileUnknown = null;
  loginState = null;
  answeredOrder = null;
  orderSaving = false;
  leaveReadOwed = false;
  setOrderRefusal(false);
  generation += 1;
  for (const timer of timers) clearInterval(timer);
  timers.clear();
  filePoll = null;
  timing = { ...DEFAULT_TIMING };
  process.off('uncaughtException', guardUncaught);
  process.off('unhandledRejection', guardRejection);
  guardInstalled = false;
}

function every(ms: number, fn: () => void): NodeJS.Timeout {
  const timer = setInterval(fn, ms);
  timer.unref();
  timers.add(timer);
  return timer;
}

function stopTimer(timer: NodeJS.Timeout | null): void {
  if (!timer) return;
  clearInterval(timer);
  timers.delete(timer);
}

export function maintenanceMode(): MaintenanceMode {
  return mode;
}

function reportMode(next: MaintenanceMode, held?: Held, boot = false): void {
  mode = next;
  send({ type: 'maintenance:mode', data: { mode: next, ...(held ? { held } : {}), ...(boot ? { boot: true } : {}) } });
}

function applyPresence(): void {
  const client = clientRef;
  if (!client) return;
  client.options.presence = MAINTENANCE_PRESENCE;
  try {
    // A new identify (a shard spawned later, a new gateway manager) carries it from these options.
    const packet = (client as unknown as { presence: { _parse(data: PresenceData): object } }).presence._parse(MAINTENANCE_PRESENCE);
    (client.options as { ws?: { presence?: object } }).ws!.presence = packet;
    const live = (client.ws as unknown as { _ws?: { options: { initialPresence: object | null } } })._ws;
    if (live) live.options.initialPresence = packet;
    client.user?.setPresence(MAINTENANCE_PRESENCE);
  } catch (error) {
    console.warn('[Maintenance] Could not set the Discord status:', error instanceof Error ? error.message : error);
  }
}

/** A shard that identified or resumed again lost the status Discord held for its old session: it is sent again. */
function resendPresence(client: Client, shardId: number): void {
  if (!isMaintenanceGateClosed()) return;
  try {
    (client as unknown as { presence: { set(data: PresenceData): unknown } }).presence.set({ ...MAINTENANCE_PRESENCE, shardId });
  } catch (error) {
    console.warn(`[Maintenance] Could not set the Discord status on shard ${shardId}:`, error instanceof Error ? error.message : error);
  }
}

function watchShards(client: Client): void {
  client.on('shardReady', shardId => resendPresence(client, shardId));
  client.on('shardResume', shardId => resendPresence(client, shardId));
}

const isMaintenanceRefusal = (error: unknown): boolean =>
  !!error && typeof error === 'object' && (error as { causeKey?: unknown }).causeKey === 'maintenance';

let guardInstalled = false;

/** While the gate is closed, module code that does not catch the maintenance refusal does not end the process. */
export function guardUncaught(error: unknown): void {
  if (isMaintenanceRefusal(error) && isMaintenanceGateClosed()) {
    console.error('[Maintenance] Module code did not catch a write refused for maintenance; the bot process goes on:', error instanceof Error ? error.message : error);
    return;
  }
  // The exit drain's own handler logs it and lets the drain finish.
  if (isExitDraining()) return;
  console.error('[Error] Uncaught exception; the bot process exits:', error);
  countCrash(error);
  exitProcess(1);
}

export function guardRejection(reason: unknown): void {
  if (isMaintenanceRefusal(reason) && isMaintenanceGateClosed()) {
    console.error('[Maintenance] Module code did not catch a write refused for maintenance; the bot process goes on:', reason instanceof Error ? reason.message : reason);
    return;
  }
  throw reason;
}

function installRefusalGuard(): void {
  if (guardInstalled) return;
  guardInstalled = true;
  process.on('uncaughtException', guardUncaught);
  process.on('unhandledRejection', guardRejection);
}

let filePoll: NodeJS.Timeout | null = null;

/**
 * The backstop for a lost maintenance:leave: while the hook (or an order that followed it) holds the gate,
 * maintenance.json saying running starts the leave step once nothing else holds the process.
 */
function startFilePoll(): void {
  // A maintenance boot's own poll reads the file (startBootPoll).
  if (filePoll || leaving || isMaintenanceBoot()) return;
  filePoll = every(timing.filePollMs, () => {
    const cause = maintenanceCause();
    if (cause !== 'hook' && cause !== 'order') return;
    // A missing file also reads as running; only a record the hook wrote ends maintenance.
    if (readMaintenanceFile().since !== null && !maintenanceStillDue()) startLeave('maintenance.json says running');
  });
}

const modeOf = (cause: MaintenanceCause): MaintenanceMode => (cause === 'login-refused' ? 'login-refused' : 'maintenance');

/** The mode the leave step reports once nothing is held: the outage's while it lasts, else the gate's cause's. */
function ownMode(): MaintenanceMode {
  if (outageDisconnected) return 'outage';
  const cause = maintenanceCause();
  return cause === null ? 'running' : modeOf(cause);
}

/** Closes the gate: interactions get the message, module code stops, guild writes are refused, the status shows it. */
export function closeMaintenanceGate(cause: MaintenanceCause, message: string): void {
  withdrawRestart();
  setMaintenanceGate({ cause, message });
  installRefusalGuard();
  applyPresence();
  // A leave step held by changes it cannot save stays reported as held.
  if (leaving && heldReport) reportMode('held', heldReport);
  else reportMode(modeOf(cause));
  if (cause === 'hook') startFilePoll();
}

// ============================================================================
// NX5: THE SAVE ORDER AND THE ONE LEAVE RULE (decisions 8 to 11)
// ============================================================================

const orderHolds = (read: SaveOrderRow | null | 'unknown'): read is SaveOrderRow =>
  read !== null && read !== 'unknown' && read.current && read.state === 'maintenance';

/** The first source that holds the process in maintenance, in the order order, login, file; null when none does. */
function heldByNow(): HeldBy | null {
  const unknown = orderRead === 'unknown';
  if (orderHolds(orderRead) || (unknown && heldWhileUnknown === 'order')) return 'order';
  if (loginState === 'refused') return 'login';
  if (readMaintenanceFile().state === 'maintenance') return 'file';
  return unknown ? heldWhileUnknown : null;
}

/** Decision 11: the maintenance file says maintenance, the database refuses the login, or the kept order read is a current maintenance order. */
export function maintenanceStillDue(): boolean {
  return heldByNow() !== null || leaveReadOwed;
}

/** Only a process that reads the order keeps a read: a serving process with an order source, or a maintenance boot. */
const readsOrder = (): boolean => orderSource !== null || isMaintenanceBoot();

function turnOrderUnknown(): void {
  if (!readsOrder()) return;
  heldWhileUnknown = heldByNow();
  orderRead = 'unknown';
}

/** A process with no claims store never attaches one (decision 8): it is never expected and never answers. */
export function attachSaveOrderSource(source: SaveOrderSource | null): void {
  orderSource = source;
  if (source) return;
  orderRead = null;
  heldWhileUnknown = null;
  answeredOrder = null;
  setOrderRefusal(false);
}

/** onDatabaseChanged: the old database's read no longer holds the process, nor refuses its writes, until the next read. */
export function dropSaveOrderRead(): void {
  orderRead = null;
  heldWhileUnknown = null;
  setOrderRefusal(false);
}

const shownMessage = (message: string) => message || DEFAULT_MAINTENANCE_MESSAGE;

/**
 * Every order read: the serving read after a renewal, and the maintenance boot's poll. A current maintenance order
 * refuses shared ops, sets the gate's message and starts enterForOrder when this process has no true answer for it or
 * holds something again; with the gate's cause 'order', an order that ended starts the leave once nothing holds.
 */
export function noteSaveOrder(read: SaveOrderRow | null | 'unknown'): void {
  if (!readsOrder()) return;
  if (read === 'unknown') {
    turnOrderUnknown();
    return;
  }
  orderRead = read;
  heldWhileUnknown = null;
  // A read that answered is a login the database accepted.
  loginState = 'accepted';
  leaveReadOwed = false;
  const holds = orderHolds(read);
  setOrderRefusal(holds);
  if (holds) {
    const cause = maintenanceCause();
    if (cause !== null && maintenanceText() !== shownMessage(read.message)) setMaintenanceGate({ cause, message: read.message });
    if (isMaintenanceBoot()) return;
    if (answeredOrder !== read.orderId || hasHeldWrites()) void enterForOrder(read);
    return;
  }
  if (!isMaintenanceBoot() && maintenanceCause() === 'order' && !leaving && heldByNow() === null) {
    startLeave('The main database\'s maintenance order ended');
  }
}

/**
 * Decision 9: enterMaintenance's steps with the gate's cause 'order' (the gate close and the metrics flush only when it
 * is open), then the answer from this run's own save, written while the order stands.
 */
async function enterForOrder(order: SaveOrderRow): Promise<void> {
  const source = orderSource;
  if (!source || orderSaving) return;
  orderSaving = true;
  const own = generation;
  setOrderRefusal(true);
  try {
    if (!isMaintenanceGateClosed()) {
      getMetricsCollector().flushTotals();
      closeMaintenanceGate('order', order.message);
      console.log('[Maintenance] The main database holds a maintenance order; entered maintenance and saving what this process holds');
    } else {
      const was = maintenanceCause();
      if (was !== 'order') {
        setMaintenanceGate({ cause: 'order', message: order.message });
        if (was === 'login-refused' && !(leaving && heldReport)) reportMode('maintenance');
      }
      console.log('[Maintenance] The main database holds a maintenance order; saving what this process holds');
    }
    const answer = await saveForAnswer(ENTER_BOUNDS.handlerWaitMs, ENTER_BOUNDS.saveBoundMs);
    if (own !== generation) return;
    const ack: SaveAck = {
      orderId: order.orderId, processId: source.me.processId, nodeId: source.me.nodeId, nodeName: source.me.nodeName,
      saved: answer.saved, ...ackCounts(answer),
    };
    let written = false;
    try {
      written = await source.writeAck(ack);
    } catch (error) {
      console.warn(`[Maintenance] Could not write the answer to the maintenance order (${connectCause(error)}); the next read of the order saves and answers again`);
    }
    if (own !== generation) return;
    answeredOrder = written && answer.saved === true ? order.orderId : null;
    if (written) console.log(`[Maintenance] Answered the maintenance order: ${answer.saved === true ? 'every change this process held is saved' : answer.saved === false ? 'some changes are not saved' : "can't confirm that every change is saved"}`);
    else console.warn('[Maintenance] The answer to the maintenance order was not written: the order no longer stands at this generation');
  } finally {
    if (own === generation) orderSaving = false;
  }
}

type LeaveRead = { ok: true } | { ok: false; why: string };
const LEAVE_READ_MS = 3_000;
const NO_ANSWER_3S = 'no answer within 3 seconds';

function within<T>(work: Promise<T>, ms: number): Promise<{ value: T } | { error: unknown } | 'late'> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve('late'), ms);
    timer.unref?.();
    work.then(value => { clearTimeout(timer); resolve({ value }); }, error => { clearTimeout(timer); resolve({ error }); });
  });
}

/** The hook's leave reads first (ruling J3), bounded at 3 s (ruling L1), from the source this process has. */
async function readForLeave(): Promise<LeaveRead> {
  if (isMaintenanceBoot()) return applyPassRead(await readPass(LEAVE_READ_MS, true));
  if (orderSource) {
    const got = await within(orderSource.read(), LEAVE_READ_MS);
    if (got === 'late') return { ok: false, why: NO_ANSWER_3S };
    if ('value' in got) {
      noteSaveOrder(got.value);
      return { ok: true };
    }
    if (isLoginRefused(got.error)) {
      loginState = 'refused';
      turnOrderUnknown();
      return { ok: true };
    }
    return { ok: false, why: connectCause(got.error) };
  }
  if (watchedBackend) {
    const got = await within(watchedBackend.askDatabase(), LEAVE_READ_MS);
    if (got === 'late') return { ok: false, why: NO_ANSWER_3S };
    const answer: DatabaseAnswer = 'value' in got ? got.value : 'unreachable';
    databaseAnswer = answer;
    if (answer === 'unreachable') return { ok: false, why: 'the database did not answer' };
    loginState = answer === 'refused' ? 'refused' : 'accepted';
    return { ok: true };
  }
  return { ok: true };
}

/** maintenance:leave (ruling J3): read, then decide, then answer. */
async function hookLeave(): Promise<object> {
  if (leaving) return { leaving: true };
  leaveReadOwed = true;
  const read = await readForLeave();
  if (read.ok) leaveReadOwed = false;
  if (leaving) return { leaving: true };
  if (!read.ok) {
    console.warn(`[Maintenance] The hook says running, but the bot could not read the main database (${read.why}); it stays in maintenance until a read shows nothing holds it`);
    return { leaving: null, why: read.why };
  }
  const heldBy = heldByNow();
  if (heldBy) {
    console.log(`[Maintenance] The hook says running, but ${HELD_WORDS[heldBy]}; the bot stays in maintenance`);
    return { leaving: false, heldBy };
  }
  startLeave('The hook says running');
  return { leaving: true };
}

const HELD_WORDS: Record<HeldBy, string> = {
  order: 'the main database holds a maintenance order',
  login: 'the main database refuses the login',
  file: 'maintenance.json still says maintenance',
};

type PassRead =
  | { kind: 'no-database' }
  | { kind: 'entry'; order: SaveOrderRow | null | 'unknown'; why: string | null }
  | { kind: 'none'; login: 'accepted' | 'refused' | 'unreachable'; bound: boolean; why: string | null };

/** One probe pass on short-lived sessions; the order and the login come from contract 3's entry (ruling H1). */
async function readPass(boundMs: number, untilWritable: boolean): Promise<PassRead> {
  if (!postgresBot()) return { kind: 'no-database' };
  const list = addressListInUse();
  if (!list) return { kind: 'no-database' };
  const pass = await probePass(parseAddressList(list), { session: config => shortLivedClient(config) }, boundMs, { untilWritable });
  return passRead(pass);
}

function passRead(pass: ProbeAnswer[]): PassRead {
  const entry = pass.filter(writableAnswer).sort((a, b) => b.generation - a.generation)[0];
  if (entry) {
    const order = entry.saveOrder ?? null;
    return { kind: 'entry', order, why: order === 'unknown' ? (entry.atBound ? null : entry.saveOrderCause ?? null) : null };
  }
  const failed = pass.find(p => p.kind === 'failed' && !p.atBound);
  return { kind: 'none', login: loginOfPass(pass), bound: pass.some(p => p.atBound), why: failed && failed.kind === 'failed' ? failed.cause : null };
}

/**
 * Applies a pass to the kept state. Not ok when the pass keeps the state: an order read 'unknown', no entry that
 * answered while the gate's cause is not 'hook', or, for a process held by an order or a refused login (whatever the
 * gate's cause now is), a pass in which no writable entry answered (decision 8).
 */
function applyPassRead(read: PassRead): LeaveRead {
  if (read.kind === 'no-database') return { ok: true };
  if (read.kind === 'entry') {
    if (read.order === 'unknown') {
      loginState = 'accepted';
      noteSaveOrder('unknown');
      return { ok: false, why: read.why ?? NO_ANSWER_3S };
    }
    noteSaveOrder(read.order);
    return { ok: true };
  }
  if (read.login === 'refused') {
    loginState = 'refused';
    return { ok: true };
  }
  const held = heldByNow();
  const unreachable = read.login === 'unreachable';
  if (held === 'order' || held === 'login' || orderRefusesSharedOps() || (unreachable && maintenanceCause() !== 'hook')) {
    return { ok: false, why: read.bound ? NO_ANSWER_3S : read.why ?? 'no database that accepts writes answered' };
  }
  if (unreachable) {
    // Ruling G8-13: for cause 'hook' such a pass counts as the file poll's would, so the file decides.
    orderRead = null;
    heldWhileUnknown = null;
    return { ok: true };
  }
  loginState = 'accepted';
  noteSaveOrder(null);
  return { ok: true };
}

/** The one answer an interaction gets while the gate is closed: the message, ephemeral; an autocomplete an empty list. */
export async function answerInMaintenance(interaction: any): Promise<void> {
  try {
    if (typeof interaction?.isAutocomplete === 'function' && interaction.isAutocomplete()) {
      if (typeof interaction.respond === 'function') await interaction.respond([]).catch(() => { /* expired */ });
      return;
    }
    if (typeof interaction?.isRepliable === 'function' && interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: maintenanceText(), flags: MessageFlags.Ephemeral }).catch(() => { /* expired or already answered */ });
    }
  } catch { /* the gate never throws into the gateway */ }
}

// Events that keep the gateway itself running, and the payment bridge, whose write goes to a global file (ruling 10).
const PASSING_EVENTS = new Set([
  'clientReady', 'shardReady', 'shardResume', 'shardDisconnect', 'shardReconnecting', 'shardError',
  'error', 'warn', 'debug', 'invalidated', 'cacheSweep',
  'entitlementCreate', 'entitlementUpdate', 'entitlementDelete',
]);

/**
 * Wraps client.emit, outermost: while the gate is closed an interaction gets the message and reaches no listener (the
 * dispatcher, module listeners, collectors), and every other event but those above is dropped.
 */
export function installMaintenanceGate(client: Client): void {
  clientRef = client;
  const emit = client.emit;
  client.emit = function emitGated(this: Client, event: string | symbol, ...args: unknown[]): boolean {
    // NB4 decision 6: after the claims lapsed or a shard was lost, no listener runs; an interaction gets no reply.
    if (typeof event === 'string' && !PASSING_EVENTS.has(event) && stoppedServing()) return false;
    if (!isMaintenanceGateClosed() || typeof event !== 'string' || PASSING_EVENTS.has(event)) {
      return (emit as (event: string | symbol, ...args: unknown[]) => boolean).call(this, event, ...args);
    }
    if (event === 'interactionCreate') void answerInMaintenance(args[0]);
    return false;
  } as Client['emit'];
  watchShards(client);
  if (isMaintenanceGateClosed()) applyPresence();
}

/**
 * The hook's step in the bot process, in order: the metric totals are flushed, the gate closes (and with it guild
 * writes), the status is set, then what the process holds is saved: in-flight handlers settle, the working set and
 * the file queue flush. A save that outlasts the bounds goes on behind the closed gate.
 */
export async function enterMaintenance(message: string, opts: { handlerWaitMs?: number; saveBoundMs?: number } = {}): Promise<SaveAnswer> {
  const updating = isMaintenanceGateClosed();
  if (!updating && !isMaintenanceBoot()) getMetricsCollector().flushTotals();
  closeMaintenanceGate('hook', message || DEFAULT_MAINTENANCE_MESSAGE);
  console.log(updating ? '[Maintenance] The maintenance message was updated; saving what this process holds' : '[Maintenance] Entered maintenance through the hook; saving what this process holds');
  return saveForAnswer(opts.handlerWaitMs ?? ENTER_BOUNDS.handlerWaitMs, opts.saveBoundMs ?? ENTER_BOUNDS.saveBoundMs);
}

/** In-flight handlers settle, then what the process holds is saved; the answer is that save's. */
type AckCounts = Pick<SaveAck, 'unsavedGuilds' | 'unsavedFiles' | 'unansweredGuilds' | 'unconfirmedFiles' | 'unansweredFiles' | 'resaveGuilds'>;

// saveHeldWrites counts every field; saveForAnswer and saveHeldWrites leave a count out only when it is 0.
function ackCounts(answer: SaveAnswer): AckCounts {
  if (answer.saved === true) return { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0, unansweredFiles: 0, resaveGuilds: 0 };
  if (answer.saved === null) {
    // Ruling G8-5: an answer that could not count, because work still runs, says so with NULL.
    if (answer.running) {
      return { unsavedGuilds: null, unsavedFiles: null, unansweredGuilds: null, unconfirmedFiles: null, unansweredFiles: null, resaveGuilds: 0 };
    }
    return {
      unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: answer.unansweredGuilds, unconfirmedFiles: answer.unconfirmedFiles,
      unansweredFiles: answer.unansweredFiles ?? 0, resaveGuilds: 0,
    };
  }
  return {
    unsavedGuilds: answer.unsavedGuilds, unsavedFiles: answer.unsavedFiles, unansweredGuilds: answer.unansweredGuilds,
    unconfirmedFiles: answer.unconfirmedFiles, unansweredFiles: answer.unansweredFiles ?? 0, resaveGuilds: answer.resaveGuilds ?? 0,
  };
}

/**
 * Rulings G8-12 and G8-14: the operations this process accepted and the subsystems' open work that still run and can
 * write, in words ("1 operation(s) this process accepted; premium: 2 member notice(s) ..."); null when none runs.
 */
function runningWork(): string | null {
  const ops = acceptedOpsRunning();
  const parts = [...(ops > 0 ? [`${ops} operation(s) this process accepted`] : []), ...openWorkElsewhere()];
  return parts.length > 0 ? parts.join('; ') : null;
}

async function saveForAnswer(handlerWaitMs: number, saveBoundMs: number): Promise<SaveAnswer> {
  const waitUntil = Date.now() + handlerWaitMs;
  while ((handlersInFlight() > 0 || runningWork() !== null) && Date.now() < waitUntil) await new Promise<void>(resolve => { setTimeout(resolve, 20); });
  if (handlersInFlight() > 0) console.warn(`[Maintenance] ${handlersInFlight()} handler(s) still run; any write they make from now on is refused`);
  // A maintenance boot holds no writes to save, but it runs accepted work (shared:op, premium's held saver).
  const left: HeldCounts = isMaintenanceBoot()
    ? { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 }
    : await saveHeldWrites(saveBoundMs);
  const resave = left.resaveGuilds ?? 0;
  const unansweredFiles = left.unansweredFiles ?? 0;
  // Work accepted before the refusal that still runs can write after this answer.
  const running = runningWork();
  const clauses = [heldClauses(left), running !== null ? `still running and may save changes: ${running}` : '']
    .filter(Boolean).join('; ');
  if (left.unsavedGuilds === 0 && left.unsavedFiles === 0 && left.unansweredGuilds === 0 && unansweredFiles === 0 && left.unconfirmedFiles === 0 && resave === 0 && running === null) {
    console.log('[Maintenance] Every change this process held is saved');
    return { saved: true };
  }
  if (left.unsavedGuilds === 0 && left.unsavedFiles === 0 && resave === 0) {
    console.warn(`[Maintenance] ${clauses}; can't confirm whether every change this process held is saved`);
    return {
      saved: null, unansweredGuilds: left.unansweredGuilds, unconfirmedFiles: left.unconfirmedFiles,
      ...(unansweredFiles > 0 ? { unansweredFiles } : {}), ...(running !== null ? { running } : {}),
    };
  }
  console.warn(`[Maintenance] ${clauses}`);
  return { saved: false, ...left, ...(running !== null ? { running } : {}) };
}

/**
 * The answer for an IPC request while the gate is closed, or null to let its handler run. Requests that run module
 * code or write data are refused with the message; in maintenance mode every request is refused.
 */
const MODULE_CODE_REQUESTS = new Set(['command:invoke', 'module:reload', 'module:reload-all', 'module:load', 'module:unload', 'module:apply', 'component:toggle']);

export function maintenanceIpcRefusal(type: string): object | null {
  if ((MODULE_CODE_REQUESTS.has(type) || type.startsWith('panel:')) && stoppedServing()) return { success: false, error: STOPPED_SERVING_TEXT };
  if (!isMaintenanceGateClosed()) return null;
  if (MODULE_CODE_REQUESTS.has(type) || type.startsWith('panel:')) return { success: false, maintenance: true, error: maintenanceText() };
  if (type === 'data:guild-write') return { ok: false, code: 'maintenance', error: maintenanceText() };
  if (!isMaintenanceBoot()) return null;
  if (type === 'data:guild-read' || type === 'data:global-read') return { ok: false, code: 'maintenance', error: 'the bot is in maintenance' };
  return { success: false, ok: false, code: 'maintenance', error: 'the bot is in maintenance' };
}

/** The reply to one IPC message, or null when this handler does not answer it. */
export async function handleMaintenanceIpc(message: unknown): Promise<{ requestId: string; data: object } | null> {
  if (!message || typeof message !== 'object') return null;
  const { type, requestId, data } = message as { type?: unknown; requestId?: unknown; data?: any };
  if (typeof type !== 'string' || typeof requestId !== 'string' || !requestId) return null;
  if (type === 'maintenance:enter') {
    return { requestId, data: await enterMaintenance(typeof data?.message === 'string' ? data.message : DEFAULT_MAINTENANCE_MESSAGE) };
  }
  if (type === 'maintenance:leave') return { requestId, data: await hookLeave() };
  if (!isMaintenanceBoot()) return null;
  // Their own handlers answer these, in maintenance too.
  if (type === 'shared:op' || type === 'data:global-read' || type === 'backup:take') return null;
  return { requestId, data: maintenanceIpcRefusal(type) ?? { success: false, error: 'the bot is in maintenance' } };
}

export function setupMaintenanceIPC(): void {
  if (!process.send) return;
  process.on('message', (message: unknown) => {
    void handleMaintenanceIpc(message).then(reply => {
      if (reply) send(reply);
    }, error => console.error('[Maintenance] An IPC request failed:', error));
  });
}

/**
 * The normal boot's listener: installed before the data layer opens, then maintenance.json is read again, so a hook
 * that landed while the boot decided (its maintenance:enter had no listener) closes the gate.
 */
export function setupMaintenanceIPCAtBoot(): void {
  setupMaintenanceIPC();
  if (isMaintenanceGateClosed()) return;
  const saved = readMaintenanceFile();
  if (saved.state !== 'maintenance') return;
  console.log('[Maintenance] maintenance.json says maintenance after the boot decided; closing the gate');
  closeMaintenanceGate('hook', saved.message);
}

/** A web UI process runs that can restart this bot process: an IPC channel to it exists. */
export function canRestart(): boolean {
  return !!process.send || send !== processSender;
}

export function requestRestart(reason: string, forShards = false): void {
  if (restartRequested) return;
  restartRequested = true;
  if (!canRestart()) {
    // NB4 decision 16: a process that nothing can restart ends through its stop handler, which releases its shards.
    console.error(`[Maintenance] ${reason}, but no web UI process runs to restart this bot process, so it stops; start it again by hand`);
    stopProcess();
    return;
  }
  if (forShards) console.log(`[Shards] Restarting this bot process to ${reason}`);
  else console.log(`[Maintenance] ${reason}; asking the web UI process to restart the bot process`);
  send({ type: 'control:restart-bot', data: { reason } });
  shardRestart = forShards;
  restartResend = every(timing.restartResendMs, () => {
    console.warn(`[Maintenance] The bot process still runs ${Math.round(timing.restartResendMs / 1000)} s after asking for its restart; asking again`);
    send({ type: 'control:restart-bot', data: { reason } });
  });
}

/**
 * NB9 9 and 25: the hand-over's end. The web UI process stops this bot process and runs the one for the new shards;
 * the ask is re-sent every 60 s until the stop comes. `attempt` is the reshard row's attempt as read, null after a
 * direct change.
 */
export function retireForReshard(attempt: string | null, reason: string): void {
  if (restartRequested) return;
  restartRequested = true;
  shardRestart = false;
  console.log(`[Maintenance] ${reason}; asking the web UI process to stop this bot process and run the one for the new shards`);
  send({ type: 'control:reshard-retire', data: { attempt } });
  restartResend = every(timing.restartResendMs, () => {
    console.warn(`[Maintenance] The bot process still runs ${Math.round(timing.restartResendMs / 1000)} s after asking to hand over; asking again`);
    send({ type: 'control:reshard-retire', data: { attempt } });
  });
}

/**
 * NB4 decision 15: a restart for a gain, a return or a move, asked only while the process is fit (checked right before
 * the request) and only with a web UI process to ask. True once the request is sent.
 */
export function restartForShards(reason: string, fitness: () => string | null): boolean {
  if (restartRequested) return true;
  if (!canRestart() || fitness() !== null) return false;
  requestRestart(reason, true);
  return true;
}

/**
 * Once the process stops serving or the gate closes, only the leave asks for a restart, when nothing is held: a shard
 * restart stops being re-sent, though a request already sent may still be queued. The leave's own request stays.
 */
function withdrawRestart(): void {
  if (restartResend === null || !shardRestart) return;
  stopTimer(restartResend);
  restartResend = null;
  shardRestart = false;
  restartRequested = false;
  restartAskedEarlier = true;
}

/** The leave asked for its own restart: the process waits on the web UI, not on maintenance. */
export function leaveRestartAsked(): boolean {
  return restartRequested && !shardRestart;
}

/** NB4 decision 16: the claims lapsed; every shard left Discord and the watcher's next answer starts the leave. */
export function noteClaimsLapsed(seconds: number): void {
  if (outageDisconnected) return;
  withdrawRestart();
  outageDisconnected = true;
  lapsedSeconds = seconds;
  reportMode('outage');
}

/** Decision 14's maintenance keys of fitness: null when they allow a take, else the key that failed. */
export function maintenanceUnfit(): string | null {
  if (mode !== 'running') return `maintenance mode ${mode}`;
  if (isMaintenanceGateClosed()) return 'the maintenance gate is closed';
  if (leaving) return 'leaving';
  if (restartRequested) return 'restarting';
  return null;
}

/** What is held, by name: each guild with why its last save failed, less those holding only an unanswered save, and each unsaved file path. */
function heldNames(unansweredOnly: string[]): string {
  const guilds = (getWorkingSet()?.heldGuilds() ?? []).filter(g => !unansweredOnly.includes(g.guildId))
    .map(g => `guild ${g.guildId} (${g.reason ?? 'no save tried yet'})`);
  const files = [...unsavedFilePaths(), ...unsavedRowPaths(), ...heldElsewhere()].map(file => `file ${file}`);
  return [...guilds, ...files].join('; ');
}

/**
 * Every held guild's last save failed with a data exception (22), an integrity violation (23) or a program limit (54),
 * and none holds a save the database did not answer, which may have landed.
 */
export function heldForContent(): boolean {
  if ((getWorkingSet()?.unansweredGuilds().all.length ?? 0) > 0 || unansweredRowOps() > 0) return false;
  const guilds = getWorkingSet()?.heldGuilds() ?? [];
  return guilds.length > 0 && guilds.every(g => g.code !== null && /^(22|23|54)/.test(g.code));
}

/** Where the bot stands while the leave step waits, in the held log's words. */
function standing(): string {
  const why = stepLayers.databaseStopWhy() ?? watchedBackend?.latchReason?.() ?? null;
  if (why !== null) return `the bot process stays off Discord (${why})`;
  const confirming = watchedBackend?.confirmingWords?.() ?? null;
  const entry = watchedBackend?.chosenEntry?.() ?? null;
  if (confirming !== null && entry !== null) {
    return `the bot process keeps its changes unsaved until it can confirm that ${showEntry(entry)} is still the main (${confirming})`;
  }
  if (outageDisconnected) return isMaintenanceGateClosed() ? 'the bot process stays off Discord (in maintenance)' : 'the bot process stays off Discord';
  if (isMaintenanceGateClosed()) return 'the bot process stays in maintenance';
  return 'the bot process keeps running';
}

/**
 * Leaving a state in which the process could not serve: it saves what it holds and asks for its restart once nothing
 * is held. While the watcher says the database does not answer or refuses the login, it keeps the changes and tries
 * again. Once the database answers and heldAfterPasses saves in a row leave only guilds whose last save failed for
 * their content (SQLSTATE class 22, 23 or 54), it logs them and asks for the restart, which drops them. Any other
 * failure, and files that cannot be written, keep it waiting.
 */
export function startLeave(reason: string, handOver?: { attempt: string | null }): void {
  if (leaving) return;
  leaving = true;
  stopTimer(filePoll);
  filePoll = null;
  const own = generation;
  // NB9 C8: the end is chosen once; a hand-over with no IPC channel ends in NB4's stop.
  const end: 'hand-over' | 'restart' | 'stop' = !canRestart() ? 'stop' : handOver ? 'hand-over' : 'restart';
  const restarts = end === 'restart';
  withdrawRestart();
  const askedEarlier = restartAskedEarlier;
  console.log(`[Maintenance] ${reason}; saving what this process holds before it ${end === 'hand-over'
    ? 'stops and the bot process for the new shards takes over'
    : restarts ? 'restarts' : 'stops (no web UI process runs to restart it)'}`);
  const restart = (): void => {
    for (const line of getWorkingSet()?.takeDropLines() ?? []) console.error(line);
    if (end === 'hand-over') retireForReshard(handOver!.attempt, reason);
    else requestRestart(reason);
  };
  const untilEnds = `does not ${end === 'hand-over' ? 'stop for the hand-over' : restarts ? 'restart' : 'stop'} until it ends, or the operator ${restarts ? 'restarts' : 'stops'} it, which cuts that work and drops any change it has not saved`;
  // Ruling G8-14: work that still runs can still write; each piece ends within its own provider's bound.
  const waitWhileRunning = async (): Promise<void> => {
    const until = Date.now() + timing.leaveRetryMs;
    while (runningWork() !== null && Date.now() < until) await new Promise<void>(resolve => { setTimeout(resolve, 20).unref(); });
  };
  void (async () => {
    let answeredPasses = 0;
    let refusedPasses = 0;
    let heldKey = '';
    let runningLogged: string | null = null;
    let refusedRunningLogged: string | null = null;
    let refusedReported: string | null = null;
    for (;;) {
      const left = isMaintenanceBoot() ? { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 } : await saveHeldWrites(timing.leaveSaveBoundMs);
      if (own !== generation) return;
      // Appended lines the disk did not confirm are in their files: waiting cannot confirm them, so they never hold the leave.
      const resave = left.resaveGuilds ?? 0;
      const unansweredFiles = left.unansweredFiles ?? 0;
      if (left.unsavedGuilds === 0 && left.unsavedFiles === 0 && left.unansweredGuilds === 0 && unansweredFiles === 0 && resave === 0) {
        refusedRunningLogged = null;
        refusedReported = null;
        const running = runningWork();
        if (running === null) {
          restart();
          return;
        }
        if (heldReport !== null) {
          heldReport = null;
          heldKey = '';
          reportMode(ownMode());
        }
        if (running !== runningLogged) {
          runningLogged = running;
          console.warn(`[Maintenance] Nothing is held, but work this process accepted still runs and may save changes (${running}); ${standing()} and ${untilEnds}`);
        }
        await waitWhileRunning();
        if (own !== generation) return;
        continue;
      }
      runningLogged = null;
      // Decision 11: a backend that holds the saves back by its own state counts as answering.
      const answers = !watching || databaseAnswer === 'answers' || watchedBackend?.refusesByOwnState?.() === true;
      answeredPasses = answers ? answeredPasses + 1 : 0;
      refusedPasses = answers && watching && left.unsavedFiles === 0 && heldForContent() ? refusedPasses + 1 : 0;
      if (answeredPasses >= timing.heldAfterPasses) {
        const only = getWorkingSet()?.unansweredGuilds().only ?? [];
        const names = heldNames(only);
        const held: Held = {
          unsavedGuilds: left.unsavedGuilds, unsavedFiles: left.unsavedFiles, unansweredGuilds: left.unansweredGuilds,
          ...(resave > 0 ? { resaveGuilds: resave } : {}), ...(unansweredFiles > 0 ? { unansweredFiles } : {}),
        };
        if (refusedPasses >= timing.heldAfterPasses && resave === 0) {
          const dropsRefused = end === 'hand-over'
            ? 'the bot process stops for the hand-over, which drops these changes'
            : restarts
              ? 'the bot process asks for its restart, which drops these changes'
              : 'the bot process stops, which drops these changes';
          const running = runningWork();
          if (running !== null) {
            const reportKey = `${names}/${JSON.stringify(held)}`;
            if (reportKey !== refusedReported || running !== refusedRunningLogged) {
              refusedReported = reportKey;
              heldReport = held;
              reportMode('held', held);
              refusedRunningLogged = running;
              console.warn(`[Maintenance] ${refusedPasses} saves in a row left changes the database refuses for their content: ${names}; work this process accepted still runs and may save changes (${running}); ${standing()} and ${untilEnds}; once it ends, ${dropsRefused}`);
            }
            await waitWhileRunning();
            if (own !== generation) return;
            continue;
          }
          console.error(`[Maintenance] ${refusedPasses} saves in a row left changes the database refuses for their content: ${names}; ${dropsRefused}`);
          heldReport = held;
          reportMode('held', held);
          restart();
          return;
        }
        const forContent = refusedPasses > 0;
        const resaveIds = getWorkingSet()?.resaveGuilds() ?? [];
        const key = `${left.unsavedGuilds}/${left.unsavedFiles}/${left.unansweredGuilds}/${unansweredFiles}/${names}/${only.join(',')}/${forContent}/${resaveIds.join(',')}`;
        if (key !== heldKey) {
          heldKey = key;
          const onlyWords = `guild(s) ${only.join(', ')}`;
          const resaveWords = `${resaveIds.length} guild(s) ${names || only.length > 0 || unansweredFiles > 0 ? 'wait' : 'waiting'} to be re-saved on ${resaveTarget()}: ${resaveIds.join(', ')}; this process holds their newest state`;
          const guildHead = names
            ? `${answeredPasses} saves in a row left changes unsaved: ${names}${only.length > 0 ? `; ${onlyWords} hold only a save the database did not answer, which may have landed` : ''}`
            : only.length > 0 ? `${answeredPasses} saves in a row left ${onlyWords} holding only a save the database did not answer, which may have landed` : '';
          const saveHead = unansweredFiles === 0 ? guildHead
            : guildHead ? `${guildHead}; ${heldClauses({ unansweredFiles })}`
              : `${answeredPasses} saves in a row left ${unansweredFiles} file(s) holding a save the database did not answer, which may have landed`;
          const head = resaveIds.length === 0 ? saveHead
            : saveHead ? `${saveHead}; ${resaveWords}` : `${answeredPasses} saves in a row left ${resaveWords}`;
          const unanswered = left.unansweredGuilds > 0 || unansweredFiles > 0;
          const drops = unanswered ? 'which drops every change not stored' : 'which drops them';
          const saved = unanswered ? 'they are saved or found stored' : 'they are saved';
          const earlier = askedEarlier ? `; a restart this process asked for earlier may still stop it, ${drops}` : '';
          console.error(`[Maintenance] ${head}; ${forContent
            ? `the database refuses these for their content; ${standing()}, and after ${timing.heldAfterPasses} saves in a row that fail this way it ${end === 'hand-over' ? 'stops for the hand-over' : restarts ? 'restarts' : 'stops'} and drops them`
            : end === 'hand-over'
              ? `${standing()} and does not stop for the hand-over until ${saved} or the operator stops it, ${drops}${earlier}`
              : restarts
                ? `${standing()} and does not restart until ${saved} or the operator restarts it, ${drops}${earlier}`
                : `${standing()} and does not stop until ${saved} or the operator stops it, ${drops}`}`);
          heldReport = held;
          reportMode('held', held);
        }
      }
      refusedRunningLogged = null;
      refusedReported = null;
      console.warn(`[Maintenance] ${heldClauses({ ...left, unconfirmedFiles: 0 })}; the bot process keeps them and tries again in ${Math.round(timing.leaveRetryMs / 1000)} s`);
      await new Promise<void>(resolve => { setTimeout(resolve, timing.leaveRetryMs).unref(); });
      if (own !== generation) return;
    }
  })().catch(error => console.error('[Maintenance] The leave step failed:', error));
}

/** A new login, on its own connection, to the database the deployment names; 'none' on a JSON bot. */
export async function probeLoginAtBoot(): Promise<'accepted' | 'refused' | 'unreachable' | 'none'> {
  let kind: string;
  try {
    kind = resolveDataBackend();
  } catch {
    return 'none';
  }
  const list = addressListInUse();
  if (kind !== 'postgres' || !list) return 'none';
  return loginOfPass(await probePass(parseAddressList(list), { session: config => shortLivedClient(config) }));
}

/** NB5 decision 7: one pass, mapped from the pass alone. */
export function loginOfPass(pass: Array<{ kind: 'answered' | 'refused' | 'failed'; loggedIn?: true }>): 'accepted' | 'refused' | 'unreachable' {
  // A statement that failed after the connect still had its login accepted.
  if (pass.some(p => p.kind === 'answered' || p.loggedIn)) return 'accepted';
  return pass.some(p => p.kind === 'refused') ? 'refused' : 'unreachable';
}

export type BootDecision = { mode: 'normal' } | { mode: 'maintenance'; cause: MaintenanceCause; message: string };

/**
 * Read before the data backend opens: the saved state, then on Postgres one probe pass. Contract 3's entry (answered,
 * writable, of the highest generation) holding a current maintenance order boots in maintenance with cause 'order'
 * (NX5 decision 8); with no writable entry the login is loginOfPass's and there is no order. A given probe reads the
 * login alone.
 */
export async function decideBoot(probe?: LoginProbe): Promise<BootDecision> {
  const saved = readMaintenanceFile();
  if (saved.state === 'maintenance') return { mode: 'maintenance', cause: 'hook', message: saved.message };
  let login: 'accepted' | 'refused' | 'unreachable' | 'none';
  if (probe) {
    login = await probe();
  } else {
    const read = await readPass(PASS_BOUND_MS, false);
    if (read.kind === 'entry' && orderHolds(read.order)) {
      console.warn('[Maintenance] The main database holds a maintenance order; booting in maintenance mode');
      return { mode: 'maintenance', cause: 'order', message: read.order.message };
    }
    login = read.kind === 'none' ? read.login : 'accepted';
  }
  if (login === 'refused') {
    console.warn('[Maintenance] The database refused the login (SQLSTATE 28000); booting in maintenance mode');
    return { mode: 'maintenance', cause: 'login-refused', message: saved.message };
  }
  return { mode: 'normal' };
}

/**
 * The maintenance boot's one poll for every cause (ruling G4): every retryMs, one probe pass reads the login and the
 * order from contract 3's entry, and with the file the predicate decides. A JSON bot reads the file alone.
 */
function startBootPoll(cause: MaintenanceCause, retryMs: number): void {
  let busy = false;
  every(retryMs, () => {
    if (busy || leaving) return;
    busy = true;
    void pollOnce(cause).catch(error => console.error('[Maintenance] The maintenance poll failed:', error)).finally(() => { busy = false; });
  });
}

async function pollOnce(cause: MaintenanceCause): Promise<void> {
  if (!applyPassRead(await readPass(PASS_BOUND_MS, false)).ok) return;
  leaveReadOwed = false;
  if (leaving) return;
  // A missing file also reads as running; for the hook only a record the hook wrote ends maintenance.
  if (cause === 'hook' && readMaintenanceFile().since === null) return;
  if (!maintenanceStillDue()) startLeave(cause === 'hook' ? 'maintenance.json says running' : cause === 'order' ? 'The main database\'s maintenance order ended' : 'The database accepted the login again');
}

/** Marks that this boot reached its Discord login: a refused login from now on is handled at run time. */
export function markDiscordStarted(): void {
  discordStarted = true;
}

export interface WatchedBackend {
  onLoginRefused(cb: () => void): void;
  askDatabase(): Promise<DatabaseAnswer>;
  refusesByOwnState?(): boolean;
  latchReason?(): string | null;
  confirmingWords?(): string | null;
  chosenEntry?(): string | null;
}

/**
 * The run-time watcher of a Postgres bot (ruling K): SELECT 1 through the backend's pool every retryMs, bounded at 5
 * seconds. Refused (SQLSTATE 28000) is ruling 7: the gate closes with the saved message and the bot stays on Discord.
 * The first answer after the shard claims lapsed (NB4), or after a refused login while the file says running, starts
 * the leave step.
 */
export function watchDataBackend(
  backend: WatchedBackend | null,
  deps: { retryMs?: number; probeTimeoutMs?: number } = {},
): { probeNow(): Promise<void> } | null {
  if (!backend) return null;
  watching = true;
  watchedBackend = backend;
  setStepLayers({ startLeave });
  const bound = deps.probeTimeoutMs ?? WATCH_PROBE_BOUND_MS;
  let toldAnswers = false;

  // NB4 decision 22: any 28000 closes an open gate, whatever leaving and discordStarted are; before the login it also
  // starts the leave.
  const loginRefused = (): void => {
    if (isMaintenanceBoot()) return;
    loginState = 'refused';
    leaveReadOwed = false;
    // NX5 decision 8: the kept order read is from before the refusal; only a fresh read lets the process leave.
    turnOrderUnknown();
    if (!isMaintenanceGateClosed()) {
      withdrawRestart();
      const earlier = restartAskedEarlier ? '; a restart this process asked for earlier may still stop it, which drops them' : '';
      console.warn(`[Maintenance] The database refused the login (SQLSTATE 28000); answering with the maintenance message and keeping the unsaved changes until the login returns${earlier}`);
      closeMaintenanceGate('login-refused', readMaintenanceFile().message);
      toldAnswers = false;
    }
    if (!discordStarted) startLeave('The database refused the login (SQLSTATE 28000) while the bot process booted');
  };
  backend.onLoginRefused(loginRefused);

  const answered = (): void => {
    if (leaving) return;
    if (outageDisconnected) {
      const heldBy = orderRefusesSharedOps() ? 'order' : heldByNow();
      const cause = maintenanceCause();
      if (cause === null || (heldBy !== 'order' && heldBy !== 'login')) {
        startLeave(`The shard claims lapsed (no renewal for ${lapsedSeconds} s) and the database answers`);
        return;
      }
      // Decision 11: the order or the refused login still holds; the leave path of the gate's cause ends maintenance.
      // The login was just accepted: a 'login' hold is a refusal kept until a fresh order read, so the mode is maintenance.
      outageDisconnected = false;
      if (heldBy === 'login') toldAnswers = true;
      console.log(`[Maintenance] The database answers again after the shard claims lapsed${heldBy === 'login'
        ? '; the bot process stays off Discord in maintenance until it reads the main database\'s maintenance order again'
        : `, but ${HELD_WORDS[heldBy]}; the bot process stays off Discord in maintenance`}`);
      reportMode('maintenance');
      return;
    }
    if (maintenanceCause() !== 'login-refused') return;
    const heldBy = heldByNow();
    if (heldBy === null) {
      startLeave('The database accepted the login again');
    } else if (!toldAnswers) {
      toldAnswers = true;
      console.log(`[Maintenance] The database accepted the login again; the bot stays in maintenance ${heldBy === 'file'
        ? 'until the hook says running'
        : heldBy === 'order' ? 'while the main database holds a maintenance order' : 'until it reads the main database\'s maintenance order again'}`);
    }
  };

  let busy = false;
  const probeNow = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = await Promise.race([
        backend.askDatabase().catch((): DatabaseAnswer => 'unreachable'),
        new Promise<DatabaseAnswer>(resolve => { timer = setTimeout(() => resolve('unreachable'), bound); timer.unref(); }),
      ]);
      databaseAnswer = answer;
      if (answer === 'unreachable') return;
      if (answer === 'refused') {
        loginRefused();
      } else {
        loginState = 'accepted';
        leaveReadOwed = false;
        answered();
      }
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  };
  every(deps.retryMs ?? LOGIN_RETRY_MS, () => { void probeNow(); });
  return { probeNow };
}

/** Wires the Discord payment bridge without starting any provider ticker (ruling 10, maintenance mode). */
function attachPaymentBridge(client: Client): void {
  try {
    getPremiumManager();
    getSubscriptionNotifier().setClient(client);
    attachEntitlementBridge(client);
  } catch (error) {
    console.error('[Maintenance] Could not attach the payment gateway bridge:', error);
  }
}

/**
 * Ruling 6: no data backend, no claim, no module, no ticker. Every shard logs in with the maintenance status; every
 * interaction and every IPC request is answered with the message.
 */
export async function runMaintenanceBoot(
  decision: { cause: MaintenanceCause; message: string },
  deps: {
    login?: (client: Client) => Promise<unknown>;
    shards?: () => Promise<number>;
    retryMs?: number;
    sleep?: (ms: number) => Promise<void>;
    shardRecord?: () => ShardRecord | null;
  } = {},
): Promise<Client | null> {
  markMaintenanceBoot();
  setMaintenanceGate({ cause: decision.cause, message: decision.message });
  // The boot pass read a current maintenance order or a refused login; each holds until a poll reads otherwise.
  if (decision.cause === 'order') {
    orderRead = 'unknown';
    heldWhileUnknown = 'order';
    setOrderRefusal(true);
  }
  if (decision.cause === 'login-refused') loginState = 'refused';
  installRefusalGuard();
  // NB4 decision 16: this boot's step of the one stop (dataManager.ts, which drains and exits) is added before anything
  // that can start a leave; it destroys only a Client that exists by then.
  let client: Client | null = null;
  addStopStep(async () => {
    if (client) await Promise.race([client.destroy().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 2000))]);
  });
  console.log(decision.cause === 'hook'
    ? '[Maintenance] Booting in maintenance mode: the saved state says maintenance'
    : decision.cause === 'order'
      ? '[Maintenance] Booting in maintenance mode: the main database holds a maintenance order'
      : '[Maintenance] Booting in maintenance mode: the database refused the login');
  setupMaintenanceIPC();
  setupBackupIPC();
  setupSharedOpsIPC();
  reportWriterStage('shared');
  reportWriterStage('guild');
  reportMode(modeOf(decision.cause), undefined, true);
  startBootPoll(decision.cause, deps.retryMs ?? timing.filePollMs);
  const retry = discordRetry(deps.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms); })));

  let shardCount: number;
  let shardIds: number[];
  if (postgresBot()) {
    // NB4 decision 22: the shards this machine served at its last start, under that start's count.
    const record = (deps.shardRecord ?? readShardRecord)();
    if (!record || record.shardIds.length === 0) {
      console.log(record
        ? '[Maintenance] Booting in maintenance mode with no shard: this machine served none at its last start'
        : '[Maintenance] Booting in maintenance mode with no shard: this machine has no record of the shards it served');
      return null;
    }
    shardCount = record.shardCount;
    shardIds = [...new Set(record.shardIds)].sort((a, b) => a - b);
    console.log(`[Maintenance] Booting in maintenance mode on shard(s) ${shardIds.join(', ')} of ${shardCount}, the shards this machine served at its last start`);
  } else {
    shardCount = await retry('Could not fetch the shard count from Discord', deps.shards ?? defaultShardCount);
    shardIds = Array.from({ length: shardCount }, (_, i) => i);
  }
  const options: ConstructorParameters<typeof Client>[0] = { intents: [GatewayIntentBits.Guilds], presence: MAINTENANCE_PRESENCE };
  Object.assign(options, { shards: shardIds, shardCount });
  const built = new Client(options);
  // The constructor copies SHARD_COUNT: a valid one is overwritten here, an invalid one throws before this.
  Object.assign(built.options, { shards: shardIds, shardCount });
  client = built;
  clientRef = built;
  watchShards(built);
  built.on('interactionCreate', interaction => void answerInMaintenance(interaction));
  built.once('clientReady', () => console.log(`Logged in as ${built.user?.tag}! (maintenance mode, ${shardIds.length} of ${shardCount} shard(s))`));
  attachPaymentBridge(built);

  const login = deps.login ?? (c => c.login(process.env.DISCORD_TOKEN));
  await retry('The Discord login failed', () => login(built));
  return built;
}

function postgresBot(): boolean {
  try {
    return resolveDataBackend() === 'postgres';
  } catch {
    return false;
  }
}

/** Runs a Discord step until it succeeds, waiting 5 seconds after the first failure and doubling up to 60. */
function discordRetry(sleep: (ms: number) => Promise<void>) {
  return async <T>(what: string, step: () => Promise<T>): Promise<T> => {
    let delay = DISCORD_RETRY_FIRST_MS;
    for (;;) {
      try {
        return await step();
      } catch (error) {
        console.warn(`[Maintenance] ${what} (${error instanceof Error ? error.message : String(error)}); trying again in ${delay / 1000} s`);
        await sleep(delay);
        delay = Math.min(delay * 2, DISCORD_RETRY_MAX_MS);
      }
    }
  };
}

async function defaultShardCount(): Promise<number> {
  const { fetchGatewayInfoResult, resolveShardCount } = await import('../fleet/placement');
  const { info } = await fetchGatewayInfoResult(process.env.DISCORD_TOKEN);
  return resolveShardCount(info?.recommendedShards ?? 1);
}
