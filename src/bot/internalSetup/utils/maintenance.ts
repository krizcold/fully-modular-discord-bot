// Maintenance in the bot process: the manager's hook (maintenance:enter over IPC), booting in maintenance mode, a
// database login refused with SQLSTATE 28000, and the leave after the shard claims lapsed.

import { ActivityType, Client, GatewayIntentBits, MessageFlags, type PresenceData } from 'discord.js';
import {
  DEFAULT_MAINTENANCE_MESSAGE,
  handlersInFlight,
  isMaintenanceBoot,
  isMaintenanceGateClosed,
  maintenanceCause,
  maintenanceText,
  markMaintenanceBoot,
  setMaintenanceGate,
  type MaintenanceCause,
} from './maintenanceGate';
import { readMaintenanceFile } from '../../../utils/maintenanceFile';
import { loadCredentials, resolveDataBackend } from '../../../utils/envLoader';
import { drainForExit, isExitDraining, saveHeldWrites, stopHandler, stopProcess } from './dataManager';
import { STOPPED_SERVING_TEXT, stoppedServing } from './servingGate';
import { getWorkingSet } from './dataBackends/workingSet';
import { queuedFilePaths } from './dataBackends/fileBackend';
import { isLoginRefused } from './dataBackends/postgresBackend';
import { shortLivedClient } from './pgClient';
import { getPaymentRegistry } from './payment/paymentRegistry';
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
export type SaveAnswer = { saved: true } | { saved: false; unsavedGuilds: number; unsavedFiles: number };
export type DatabaseAnswer = 'answers' | 'refused' | 'unreachable';
type Held = { unsavedGuilds: number; unsavedFiles: number };

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
let watching = false;
// Bumped by _resetMaintenance, so a leave step a test started stops with it.
let generation = 0;
const timers = new Set<NodeJS.Timeout>();

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
  watching = false;
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
  process.exit(1);
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

/** The backstop for a lost maintenance:leave: while the hook holds the gate, maintenance.json saying running starts the leave step. */
function startFilePoll(): void {
  if (filePoll || leaving) return;
  filePoll = every(timing.filePollMs, () => {
    if (maintenanceCause() !== 'hook') return;
    const saved = readMaintenanceFile();
    // A missing file also reads as running; only a record the hook wrote ends maintenance.
    if (saved.state === 'running' && saved.since !== null) startLeave('maintenance.json says running');
  });
}

/** Closes the gate: interactions get the message, module code stops, guild writes are refused, the status shows it. */
export function closeMaintenanceGate(cause: MaintenanceCause, message: string): void {
  withdrawRestart();
  setMaintenanceGate({ cause, message });
  installRefusalGuard();
  applyPresence();
  // A leave step held by changes it cannot save stays reported as held.
  if (leaving && heldReport) reportMode('held', heldReport);
  else reportMode(cause === 'hook' ? 'maintenance' : 'login-refused');
  if (cause === 'hook') startFilePoll();
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
  if (isMaintenanceBoot()) return { saved: true };
  const waitUntil = Date.now() + (opts.handlerWaitMs ?? ENTER_BOUNDS.handlerWaitMs);
  while (handlersInFlight() > 0 && Date.now() < waitUntil) await new Promise<void>(resolve => { setTimeout(resolve, 20); });
  if (handlersInFlight() > 0) console.warn(`[Maintenance] ${handlersInFlight()} handler(s) still run; any write they make from now on is refused`);
  const left = await saveHeldWrites(opts.saveBoundMs ?? ENTER_BOUNDS.saveBoundMs);
  if (left.unsavedGuilds === 0 && left.unsavedFiles === 0) {
    console.log('[Maintenance] Every change this process held is saved');
    return { saved: true };
  }
  console.warn(`[Maintenance] ${left.unsavedGuilds} guild(s) and ${left.unsavedFiles} file(s) hold changes that could not be saved`);
  return { saved: false, ...left };
}

/**
 * The answer for an IPC request while the gate is closed, or null to let its handler run. Requests that run module
 * code or write data are refused with the message; in maintenance mode every request is refused.
 */
const MODULE_CODE_REQUESTS = new Set(['command:invoke', 'module:reload', 'module:reload-all', 'module:load', 'module:unload', 'component:toggle']);

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
  if (type === 'maintenance:leave') {
    startLeave('The hook says running');
    return { requestId, data: { leaving: true } };
  }
  if (!isMaintenanceBoot()) return null;
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

function requestRestart(reason: string, forShards = false): void {
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

/** What is held, by name: each guild with why its last save failed, and each file path. */
function heldNames(): string {
  const guilds = (getWorkingSet()?.heldGuilds() ?? []).map(g => `guild ${g.guildId} (${g.reason ?? 'no save tried yet'})`);
  const files = queuedFilePaths().map(file => `file ${file}`);
  return [...guilds, ...files].join('; ');
}

/** Every held guild's last save failed with a data exception (22), an integrity violation (23) or a program limit (54). */
function heldForContent(): boolean {
  const guilds = getWorkingSet()?.heldGuilds() ?? [];
  return guilds.length > 0 && guilds.every(g => g.code !== null && /^(22|23|54)/.test(g.code));
}

/** Where the bot stands while the leave step waits, in the held log's words. */
function standing(): string {
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
export function startLeave(reason: string): void {
  if (leaving) return;
  leaving = true;
  stopTimer(filePoll);
  filePoll = null;
  const own = generation;
  const restarts = canRestart();
  withdrawRestart();
  const earlier = restartAskedEarlier ? '; a restart this process asked for earlier may still stop it, which drops them' : '';
  console.log(`[Maintenance] ${reason}; saving what this process holds before it ${restarts ? 'restarts' : 'stops (no web UI process runs to restart it)'}`);
  const restart = (): void => {
    for (const line of getWorkingSet()?.takeDropLines() ?? []) console.error(line);
    requestRestart(reason);
  };
  void (async () => {
    let answeredPasses = 0;
    let refusedPasses = 0;
    let heldKey = '';
    for (;;) {
      const left = isMaintenanceBoot() ? { unsavedGuilds: 0, unsavedFiles: 0 } : await saveHeldWrites(timing.leaveSaveBoundMs);
      if (own !== generation) return;
      if (left.unsavedGuilds === 0 && left.unsavedFiles === 0) {
        restart();
        return;
      }
      const answers = !watching || databaseAnswer === 'answers';
      answeredPasses = answers ? answeredPasses + 1 : 0;
      refusedPasses = answers && watching && left.unsavedFiles === 0 && heldForContent() ? refusedPasses + 1 : 0;
      if (answeredPasses >= timing.heldAfterPasses) {
        const names = heldNames();
        const held = { unsavedGuilds: left.unsavedGuilds, unsavedFiles: left.unsavedFiles };
        if (refusedPasses >= timing.heldAfterPasses) {
          console.error(`[Maintenance] ${refusedPasses} saves in a row left changes the database refuses for their content: ${names}; ${restarts
            ? 'the bot process asks for its restart, which drops these changes'
            : 'the bot process stops, which drops these changes'}`);
          heldReport = held;
          reportMode('held', held);
          restart();
          return;
        }
        const forContent = refusedPasses > 0;
        const key = `${left.unsavedGuilds}/${left.unsavedFiles}/${names}/${forContent}`;
        if (key !== heldKey) {
          heldKey = key;
          console.error(`[Maintenance] ${answeredPasses} saves in a row left changes unsaved: ${names}; ${forContent
            ? `the database refuses these for their content; ${standing()}, and after ${timing.heldAfterPasses} saves in a row that fail this way it ${restarts ? 'restarts' : 'stops'} and drops them`
            : restarts
              ? `${standing()} and does not restart until they are saved or the operator restarts it, which drops them${earlier}`
              : `${standing()} and does not stop until they are saved or the operator stops it, which drops them`}`);
          heldReport = held;
          reportMode('held', held);
        }
      }
      console.warn(`[Maintenance] ${left.unsavedGuilds} guild(s) and ${left.unsavedFiles} file(s) hold changes that could not be saved; the bot process keeps them and tries again in ${Math.round(timing.leaveRetryMs / 1000)} s`);
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
  const url = (loadCredentials().DATA_BACKEND_URL || '').trim();
  if (kind !== 'postgres' || !url) return 'none';
  const client = shortLivedClient({ connectionString: url, connectionTimeoutMillis: BOOT_PROBE_TIMEOUT_MS });
  try {
    await client.connect();
    return 'accepted';
  } catch (error) {
    return isLoginRefused(error) ? 'refused' : 'unreachable';
  } finally {
    await client.end().catch(() => { /* never connected */ });
  }
}

export type BootDecision = { mode: 'normal' } | { mode: 'maintenance'; cause: MaintenanceCause; message: string };

/** Read before the data backend opens: the saved state, then on Postgres whether the database refuses the login. */
export async function decideBoot(probe: LoginProbe = probeLoginAtBoot): Promise<BootDecision> {
  const saved = readMaintenanceFile();
  if (saved.state === 'maintenance') return { mode: 'maintenance', cause: 'hook', message: saved.message };
  if ((await probe()) === 'refused') {
    console.warn('[Maintenance] The database refused the login (SQLSTATE 28000); booting in maintenance mode');
    return { mode: 'maintenance', cause: 'login-refused', message: saved.message };
  }
  return { mode: 'normal' };
}

/** Tries the login every retryMs; once accepted while the file says running, starts the leave step. */
function watchLogin(probe: LoginProbe, retryMs: number): void {
  let busy = false;
  const timer = every(retryMs, () => {
    if (busy) return;
    busy = true;
    void probe().then(answer => {
      if (answer !== 'accepted') return;
      stopTimer(timer);
      if (readMaintenanceFile().state === 'running') startLeave('The database accepted the login again');
      else console.log('[Maintenance] The database accepted the login again; the bot stays in maintenance until the hook says running');
    }, () => undefined).finally(() => { busy = false; });
  });
}

/** Marks that this boot reached its Discord login: a refused login from now on is handled at run time. */
export function markDiscordStarted(): void {
  discordStarted = true;
}

export interface WatchedBackend {
  onLoginRefused(cb: () => void): void;
  askDatabase(): Promise<DatabaseAnswer>;
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
  const bound = deps.probeTimeoutMs ?? WATCH_PROBE_BOUND_MS;
  let toldAnswers = false;

  // NB4 decision 22: any 28000 closes an open gate, whatever leaving and discordStarted are; before the login it also
  // starts the leave.
  const loginRefused = (): void => {
    if (isMaintenanceBoot()) return;
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
      startLeave(`The shard claims lapsed (no renewal for ${lapsedSeconds} s) and the database answers`);
      return;
    }
    if (maintenanceCause() !== 'login-refused') return;
    if (readMaintenanceFile().state === 'running') {
      startLeave('The database accepted the login again');
    } else if (!toldAnswers) {
      toldAnswers = true;
      console.log('[Maintenance] The database accepted the login again; the bot stays in maintenance until the hook says running');
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
      if (answer === 'refused') loginRefused();
      else answered();
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
    const discord = getPaymentRegistry().get('discord') as { attachGatewayBridge?: (attach: (event: string, handler: (payload: any) => void) => void) => void } | undefined;
    discord?.attachGatewayBridge?.((eventName, handler) => { client.on(eventName as any, handler); });
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
    loginProbe?: LoginProbe;
    retryMs?: number;
    sleep?: (ms: number) => Promise<void>;
    shardRecord?: () => ShardRecord | null;
  } = {},
): Promise<Client | null> {
  markMaintenanceBoot();
  setMaintenanceGate({ cause: decision.cause, message: decision.message });
  installRefusalGuard();
  // NB4 decision 16: the stop handler exists before anything that can start a leave; its destroy step acts only on a
  // Client that exists by then.
  let client: Client | null = null;
  const shutdown = stopHandler(async () => {
    try {
      if (client) await Promise.race([client.destroy().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 2000))]);
      await drainForExit(5000);
    } finally {
      process.exit(0);
    }
  });
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  console.log(decision.cause === 'hook'
    ? '[Maintenance] Booting in maintenance mode: the saved state says maintenance'
    : '[Maintenance] Booting in maintenance mode: the database refused the login');
  setupMaintenanceIPC();
  reportMode(decision.cause === 'hook' ? 'maintenance' : 'login-refused', undefined, true);
  if (decision.cause === 'hook') startFilePoll();
  if (decision.cause === 'login-refused') watchLogin(deps.loginProbe ?? probeLoginAtBoot, deps.retryMs ?? LOGIN_RETRY_MS);
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
