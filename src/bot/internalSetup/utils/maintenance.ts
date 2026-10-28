// Maintenance in the bot process: the manager's hook (maintenance:enter over IPC), booting in maintenance mode, a
// database login refused with SQLSTATE 28000, and a database that does not answer for 300 seconds.

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
import { drainForExit, isExitDraining, saveHeldWrites, stopHandler } from './dataManager';
import { getWorkingSet } from './dataBackends/workingSet';
import { queuedFilePaths } from './dataBackends/fileBackend';
import { isLoginRefused } from './dataBackends/postgresBackend';
import { shortLivedClient } from './pgClient';
import { getPaymentRegistry } from './payment/paymentRegistry';
import { getPremiumManager } from './premiumManager';
import { getSubscriptionNotifier } from './subscriptionNotifier';
import { getMetricsCollector } from './metrics/metricsCollector';

/** The web UI waits 20 seconds for the answer to maintenance:enter; both bounds together stay inside it. */
export const ENTER_BOUNDS = { handlerWaitMs: 5_000, saveBoundMs: 13_000 };
const LOGIN_RETRY_MS = 5_000;
const BOOT_PROBE_TIMEOUT_MS = 5_000;
const DISCORD_RETRY_FIRST_MS = 5_000;
const DISCORD_RETRY_MAX_MS = 60_000;
const WATCH_PROBE_BOUND_MS = 5_000;
const OUTAGE_DISCONNECT_MS = 300_000;

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
let restartRequested = false;
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
  restartRequested = false;
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

function reportMode(next: MaintenanceMode, held?: Held): void {
  mode = next;
  send({ type: 'maintenance:mode', data: held ? { mode: next, held } : { mode: next } });
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

function requestRestart(reason: string): void {
  if (restartRequested) return;
  restartRequested = true;
  if (!process.send && send === processSender) {
    console.error(`[Maintenance] ${reason}, but no web UI process runs to restart this bot process; restart it by hand`);
    return;
  }
  console.log(`[Maintenance] ${reason}; asking the web UI process to restart the bot process`);
  send({ type: 'control:restart-bot', data: { reason } });
  every(timing.restartResendMs, () => {
    console.warn(`[Maintenance] The bot process still runs ${Math.round(timing.restartResendMs / 1000)} s after asking for its restart; asking again`);
    send({ type: 'control:restart-bot', data: { reason } });
  });
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
  console.log(`[Maintenance] ${reason}; saving what this process holds before it restarts`);
  void (async () => {
    let answeredPasses = 0;
    let refusedPasses = 0;
    let heldKey = '';
    for (;;) {
      const left = isMaintenanceBoot() ? { unsavedGuilds: 0, unsavedFiles: 0 } : await saveHeldWrites(timing.leaveSaveBoundMs);
      if (own !== generation) return;
      if (left.unsavedGuilds === 0 && left.unsavedFiles === 0) {
        requestRestart(reason);
        return;
      }
      const answers = !watching || databaseAnswer === 'answers';
      answeredPasses = answers ? answeredPasses + 1 : 0;
      refusedPasses = answers && watching && left.unsavedFiles === 0 && heldForContent() ? refusedPasses + 1 : 0;
      if (answeredPasses >= timing.heldAfterPasses) {
        const names = heldNames();
        const held = { unsavedGuilds: left.unsavedGuilds, unsavedFiles: left.unsavedFiles };
        if (refusedPasses >= timing.heldAfterPasses) {
          console.error(`[Maintenance] ${refusedPasses} saves in a row left changes the database refuses for their content: ${names}; the bot process asks for its restart, which drops these changes`);
          heldReport = held;
          reportMode('held', held);
          requestRestart(reason);
          return;
        }
        const forContent = refusedPasses > 0;
        const key = `${left.unsavedGuilds}/${left.unsavedFiles}/${names}/${forContent}`;
        if (key !== heldKey) {
          heldKey = key;
          console.error(`[Maintenance] ${answeredPasses} saves in a row left changes unsaved: ${names}; ${forContent
            ? `the database refuses these for their content; ${standing()}, and after ${timing.heldAfterPasses} saves in a row that fail this way it restarts and drops them`
            : `${standing()} and does not restart until they are saved or the operator restarts it, which drops them`}`);
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
 * Every probe unreachable for 300 seconds in a row takes every shard off Discord and keeps what the process holds.
 * The first answer after that, or after a refused login while the file says running, starts the leave step.
 */
export function watchDataBackend(
  backend: WatchedBackend | null,
  deps: { retryMs?: number; probeTimeoutMs?: number; now?: () => number; disconnect?: () => Promise<void> } = {},
): { probeNow(): Promise<void> } | null {
  if (!backend) return null;
  watching = true;
  const now = deps.now ?? Date.now;
  const bound = deps.probeTimeoutMs ?? WATCH_PROBE_BOUND_MS;
  let unreachableSince: number | null = null;
  let toldAnswers = false;

  const loginRefused = (): void => {
    if (isMaintenanceBoot() || leaving || isMaintenanceGateClosed() || outageDisconnected) return;
    if (!discordStarted) {
      startLeave('The database refused the login (SQLSTATE 28000) while the bot process booted');
      return;
    }
    console.warn('[Maintenance] The database refused the login (SQLSTATE 28000); answering with the maintenance message and keeping the unsaved changes until the login returns');
    closeMaintenanceGate('login-refused', readMaintenanceFile().message);
    toldAnswers = false;
  };
  backend.onLoginRefused(loginRefused);

  const disconnectForOutage = (): void => {
    if (isMaintenanceGateClosed() || outageDisconnected || !discordStarted) return;
    outageDisconnected = true;
    console.error(`[Maintenance] The database has not answered for ${Math.round(OUTAGE_DISCONNECT_MS / 1000)} s; disconnecting every shard from Discord and keeping the unsaved changes until it answers`);
    reportMode('outage');
    void (deps.disconnect ?? defaultDisconnect)().catch(error => console.error('[Maintenance] Could not disconnect from Discord:', error));
  };

  const answered = (): void => {
    if (leaving) return;
    if (outageDisconnected) {
      startLeave('The database answers again');
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
      if (answer === 'unreachable') {
        unreachableSince ??= now();
        if (now() - unreachableSince >= OUTAGE_DISCONNECT_MS) disconnectForOutage();
        return;
      }
      unreachableSince = null;
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

async function defaultDisconnect(): Promise<void> {
  const { getIngestService } = await import('../ingest/ingestService');
  await getIngestService().stop('the database does not answer');
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
  } = {},
): Promise<Client> {
  markMaintenanceBoot();
  setMaintenanceGate({ cause: decision.cause, message: decision.message });
  installRefusalGuard();
  console.log(decision.cause === 'hook'
    ? '[Maintenance] Booting in maintenance mode: the saved state says maintenance'
    : '[Maintenance] Booting in maintenance mode: the database refused the login');
  setupMaintenanceIPC();
  reportMode(decision.cause === 'hook' ? 'maintenance' : 'login-refused');
  if (decision.cause === 'hook') startFilePoll();
  const retry = discordRetry(deps.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms); })));

  const shardCount = await retry('Could not fetch the shard count from Discord', deps.shards ?? defaultShardCount);
  const options: ConstructorParameters<typeof Client>[0] = { intents: [GatewayIntentBits.Guilds], presence: MAINTENANCE_PRESENCE };
  if (shardCount > 1) Object.assign(options, { shards: Array.from({ length: shardCount }, (_, i) => i), shardCount });
  const client = new Client(options);
  clientRef = client;
  watchShards(client);
  client.on('interactionCreate', interaction => void answerInMaintenance(interaction));
  client.once('clientReady', () => console.log(`Logged in as ${client.user?.tag}! (maintenance mode, ${shardCount} shard(s))`));
  attachPaymentBridge(client);

  if (decision.cause === 'login-refused') watchLogin(deps.loginProbe ?? probeLoginAtBoot, deps.retryMs ?? LOGIN_RETRY_MS);

  const shutdown = stopHandler(async () => {
    await Promise.race([client.destroy().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 2000))]);
    await drainForExit(5000);
    process.exit(0);
  });
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  const login = deps.login ?? (c => c.login(process.env.DISCORD_TOKEN));
  await retry('The Discord login failed', () => login(client));
  return client;
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
