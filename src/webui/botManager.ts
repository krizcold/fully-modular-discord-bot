import { ChildProcess, fork } from 'child_process';
import { AsyncLocalStorage } from 'async_hooks';
import * as path from 'path';
import { loadCredentials, validateCredentials, BotCredentials, resolveDataBackend } from '../utils/envLoader';
import { cancelQueued, droppedByDeposition, filesPending, queuedFilePaths } from '../bot/internalSetup/utils/dataBackends/fileBackend';
import { carriedWrites, landed } from '../bot/internalSetup/utils/dataBackends/writeLedger';
import { EXIT_DEPOSED, isSharedPath } from '../bot/internalSetup/utils/dataManager';
import { holderWords, onDeposed, readWriterHolder, releaseWriterLock, takeWriterLock, writerLockPath } from '../bot/internalSetup/utils/writerLock';
import type { LockHolder } from '../bot/internalSetup/utils/processLock';
import { applySharedOp, callsProvider, invalidateSharedCaches, partialEnding, partialEndingIn, PROVIDER_SENTENCE } from '../bot/internalSetup/utils/sharedOps';
import { applyOperatorDataWrite, type GuildDataWriteRequest } from '../bot/internalSetup/utils/ipcDataHandler';
import { IPC_TIMEOUT_MS, IPC_TIMEOUT_MODULE_OP_MS } from './constants';
import type { WebSocketManager, WSEvent, WSEventData } from './websocketManager';
import { getSafetyManager } from '../utils/updateSafety';
import { setWebuiDataStoreUrl } from './utils/webuiDataReader';
import type { NotifyOutcome } from '../bot/internalSetup/utils/subscriptionNotifier';
import { readMaintenanceFile } from '../utils/maintenanceFile';
import type { RunningMigration } from '../bot/internalSetup/utils/dataMigration';

const MIGRATION_RUNNING = 'A data migration is running';

// A crashed child is started again after this pause. The safety manager's
// crash threshold (safe mode) bounds fast loops; a child that dies slower than
// that window is bounded here: after this many automatic starts in a row with
// no run reaching the stable uptime, it stays down for the operator.
const CRASH_RESTART_DELAY_MS = 5000;
const CRASH_RESTARTS_MAX = 5;
const CRASH_STABLE_UPTIME_MS = 10 * 60_000;
// The child's own stop: its gateway closed (2 s), the posture relaxed (1.5 s)
// and its accepted writes drained (30 s), with a margin.
const CHILD_STOP_WAIT_MS = 40_000;
const CHILD_KILL_WAIT_MS = 5_000;
// The manager's hook call gives up after 30 s; the child bounds its own step to 18 s.
const MAINTENANCE_IPC_TIMEOUT_MS = 20_000;
// The child answers maintenance:leave at once and saves behind its closed gate.
const LEAVE_IPC_TIMEOUT_MS = 5_000;
const RESTART_QUEUE_POLL_MS = 100;
/** A shared op sent to the child: its provider calls (30 s each) and its 8 s confirm fit inside. */
const SHARED_OP_IPC_MS = 60_000;
const GUILD_WRITE_IPC_MS = 15_000;
/** A graveyard restore or a guild data delete: the bot answers by 45 s after the send (answerByMono), inside this wait. */
const GRAVEYARD_OP_IPC_MS = 50_000;
const ANSWER_BY_NS = 45_000_000_000n;
/** The op in progress gets this long to land or cancel when the web UI exits. */
const LOCAL_CHAIN_EXIT_MS = 10_000;
const ROUTE_POLL_MS = 250;

/** The stage a child must have reported before a message type can be sent to it (its handler is registered by then). */
export function ipcStageOf(type: string): 'shared' | 'guild' {
  if (type === 'shared:op' || type === 'data:global-read' || type === 'maintenance:enter' || type === 'maintenance:leave') return 'shared';
  if (type.startsWith('fleet:') || type.startsWith('metrics:')) return 'shared';
  return 'guild';
}

type ChildStage = 'none' | 'waiting' | 'shared' | 'guild' | 'deposed';

export type RouteCode = 'stopping' | 'starting' | 'held-elsewhere' | 'disk' | 'bot-down';
export interface RouteRefusal {
  route?: undefined;
  ok: false;
  status: number;
  code: RouteCode;
  error: string;
  /** The web UI's own take of the lock that refused, when one did. */
  lockTake?: { kind: 'unwritable' | 'unreadable' | 'contended' | 'unparsable'; errno?: string };
}
export type WriterRoute = { route: 'child' } | { route: 'local' } | RouteRefusal;

const refuse = (code: RouteCode, error: string, status = 503): RouteRefusal => ({ ok: false, status, code, error });
const refuseTake = (code: RouteCode, error: string, lockTake: NonNullable<RouteRefusal['lockTake']>): RouteRefusal => ({ ...refuse(code, error), lockTake });

/** Why the web UI's own take of the lock refused the populate, in the populate's skip line. */
export function populateTakeCause(take: NonNullable<RouteRefusal['lockTake']>): string {
  switch (take.kind) {
    case 'unwritable':
      return `/data does not take writes (${writerLockPath()}: ${take.errno})`;
    case 'unreadable':
      return `can't tell which process holds the data files (${writerLockPath()}: ${take.errno})`;
    case 'contended':
      return 'another process is taking over the data files at this moment';
    default:
      return 'another process is taking the data files at this moment';
  }
}

export const ROUTE_TEXT = {
  exiting: 'The web panel is shutting down; nothing was saved. Save again once it is back.',
  stopping: 'The bot is stopping; nothing was saved. Save again once it has stopped.',
  restarting: 'The bot is restarting; nothing was saved. Save again once it is back.',
  starting: 'The bot is starting and has not opened its data files yet; nothing was saved. Try again in a moment.',
  contended: 'Another process is taking over the data files at this moment; nothing was saved. Try again in a moment.',
  unparsable: 'Another process is taking the data files at this moment; nothing was saved. Try again in a moment.',
};

/** The words a refusal names a lock holder by, as this web UI knows it. */
function routeHolderWords(holder: { role?: string | null }): string {
  if (holder.role === 'bot') return 'a bot process this web UI did not start';
  if (holder.role === 'import') return 'a data bundle import';
  return holderWords({ role: holder.role ?? undefined });
}

export const deposedRouteText = (holder: { role?: string | null; pid: number }): string =>
  `Another process took the data files (${routeHolderWords(holder)}, pid ${holder.pid}); nothing was saved. Stop that process or wait until it ends, then try again.`;

/** The words naming the process that took the data files from a deposed child. */
const deposedByWords = (holder: { role?: string | null; pid: number } | null): string =>
  (holder ? `${routeHolderWords(holder)}, pid ${holder.pid}` : 'a process this web UI cannot name');

const waitingText = (holder: { role?: string | null; pid: number } | null): string => holder
  ? `The bot is waiting for ${holderWords({ role: holder.role ?? undefined })} (pid ${holder.pid}) to release the data files; nothing was saved. Try again once it has.`
  : 'The bot is waiting for another process to release the data files; nothing was saved. Try again once it has.';
const waitingDiskText = (errno: string): string =>
  `The bot is waiting for the data disk to take writes (${writerLockPath()}: ${errno}); nothing was saved. Check the disk, then try again.`;
export const waitingReadText = (errno: string): string =>
  `The bot cannot tell which process holds the data files (${writerLockPath()}: ${errno}); nothing was saved. Check that the bot can read that file.`;

/** A shared-op or guild-write reply the child never answered. */
function noAnswerOf(error: unknown): 'timeout' | 'stopped' | 'failed' {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.startsWith('IPC request timed out') ? 'timeout' : /^bot process (exited|was stopped) before replying$/.test(reason) ? 'stopped' : 'failed';
}

/** The open frame of a local chain op: the web UI's shared gate admits writes only inside it. */
const localOpFrames = new AsyncLocalStorage<{ open: boolean }>();

export function inLocalOp(): boolean {
  return localOpFrames.getStore()?.open === true;
}

interface LocalEntry {
  label: string;
  provider: boolean;
  run: () => Promise<any>;
  /** Routes the request again: the answer of an op taken out of the chain before it started. */
  again: () => Promise<any>;
  resolve: (answer: any) => void;
}

/**
 * A read hop the child never answered (a timeout, its exit). A read changes
 * nothing, so its answer never carries the write hops' 'may still complete'.
 */
function readNoAnswer(error: unknown): { ok: false; code: 'no-answer'; cause: 'timeout' | 'stopped' | 'failed'; error: string } {
  const reason = error instanceof Error ? error.message : String(error);
  const cause = reason.startsWith('IPC request timed out') ? 'timeout' : /^bot process (exited|was stopped) before replying$/.test(reason) ? 'stopped' : 'failed';
  console.warn(`[BotManager] A data read got no answer from the bot (${cause === 'timeout' ? 'timed out' : reason})`);
  return { ok: false, code: 'no-answer', cause, error: cause === 'failed' ? reason : 'the bot did not answer the read' };
}

/** What the maintenance hook answers about the changes the bot process held: saved, not saved, or unknown (null). */
export interface MaintenanceSaveResult {
  saved: boolean | null;
  unsavedGuilds?: number;
  unsavedFiles?: number;
  note?: string;
}

/** What the hook 'running' answers about the restart: asked for, not needed, or unknown (null). */
export interface MaintenanceLeaveResult {
  restarting: boolean | null;
  note: string;
}

export interface BotStartResult {
  success: boolean;
  reason?: string;
  error?: string;
  /** The child started and waits for this holder of the data files' lock. */
  waitingFor?: { role: string | null; pid: number };
  /** The child started and waits for /data to take writes. */
  cannotLock?: string;
  /** The child started and cannot read the data files' lock to tell who holds it. */
  cannotRead?: string;
  /** The child started and waits before it opens the data files (any of the three above, or a holder it cannot name). */
  waiting?: boolean;
}

export interface BotStatus {
  running: boolean;
  uptime: number;
  processId?: number;
  crashed: boolean;
  // What the bot process reported: running, maintenance, login-refused, outage, or held (changes it cannot save keep it from restarting).
  mode?: string;
  held?: { unsavedGuilds: number; unsavedFiles: number };
  // The data migration running in the web UI process, or null.
  migration: RunningMigration | null;
  // What the bot process waits for before it opens the data files, or null.
  dataFiles?: { waitingFor: { role: string | null; pid: number } } | { cannotLock: string } | { cannotRead: string } | null;
}

export interface LogsResponse {
  current: string[];
  crash?: string[];
  crashed: boolean;
}

/**
 * Manages the Discord bot as a child process
 * Handles lifecycle (start, restart, shutdown) and log collection
 */
export class BotManager {
  private botProcess: ChildProcess | null = null;
  private logs: string[] = []; // Circular buffer (10k lines)
  private crashLogs: string[] = []; // Saved on crash
  private readonly MAX_LOGS = 10000;
  private botStartTime: number = 0;
  private crashed: boolean = false;
  private crashRestarts = 0;
  private startingAfterCrash = false;
  private stopRequested = false;
  private crashRestartTimer: NodeJS.Timeout | null = null;
  private stoppingRestart: { result: Promise<BotStartResult>; stopping: () => boolean } | null = null;
  private stopsRequested = 0;
  private exiting = false;
  private wsManager: WebSocketManager | null = null;
  private operationInProgress: boolean = false; // Prevents race conditions
  private safeMode: boolean = false;
  private safetyManager = getSafetyManager();
  private cleanupRun: { running: boolean; startedAt: number; finishedAt?: number; success?: boolean; error?: string; note?: string } | null = null;
  // Reject callbacks of in-flight IPC requests, so a child exit settles them
  // immediately instead of leaving callers hanging until their timeout.
  private pendingIpcRejects = new Set<(err: Error) => void>();
  // Web-UI listener control, wired by startWebUI; lets the access-log channel's
  // Discord buttons / the /webui command stop and restart the HTTP listener.
  private webuiControl: { stop: () => void; start: () => void } | null = null;
  // What the current child reported: serving, in maintenance, refused by its database, or off Discord for an outage.
  private childMode: string = 'running';
  // The data migration in this process (NB3): while it runs, a start that would serve data is refused.
  private migrationLock: RunningMigration | null = null;
  // A crash restart refused under the migration lock, run once when the lock is released.
  private crashRestartDeferred = false;
  private restartStartDeferred: { stops: number } | null = null;
  // The current child booted in maintenance mode (its boot flag), kept for that child's life.
  private childMaintenanceBoot = false;
  // The current child has said what it booted as: a maintenance:mode message, its first data:store, or its own login line.
  private childModeReported = false;
  private childLoggedIn = false;
  // The current child's answer to the last maintenance:enter, or null when none was asked of it.
  private childEnterAnswer: MaintenanceSaveResult | null = null;
  // The last child forked and whether its exit was seen; shutdown drops the handle of a child that outlives SIGKILL.
  private lastChild: ChildProcess | null = null;
  private lastChildExited = true;
  // A restart the child or the maintenance hook asked for while another operation held the lock.
  private queuedRestart: Promise<BotStartResult> | null = null;
  private queuedRestartChild: ChildProcess | null = null;
  private childHeld: { unsavedGuilds: number; unsavedFiles: number } | null = null;
  // Where the current child stands with the data files (its data:writer reports).
  private childStage: ChildStage = 'none';
  private childWaitHolder: { role: string | null; pid: number } | null = null;
  private childWaitCause: string | null = null;
  private childWaitReadCause: string | null = null;
  private childDeposedHolder: { role: string | null; pid: number } | null = null;
  private stageWaiters: Array<{ stage: 'shared' | 'guild'; child: ChildProcess; resolve: () => void; reject: (error: Error) => void }> = [];
  // The stop BotManager sent the current child: a stop, or the stop of a restart.
  private stopKind: 'stop' | 'restart' | null = null;
  // Every child this web UI forked whose exit it has not seen.
  private unexitedChildren = new Map<number, ChildProcess>();
  // The local chain: the web UI's own changes while no child runs, one at a time under the writer lock.
  private chainQueue: LocalEntry[] = [];
  private chainCurrent: { entry: LocalEntry; done: Promise<void> } | null = null;
  private chainHolds = false;
  private chainDeposed: LockHolder | null = null;

  /** Wire the web-UI listener stop/start hooks (owned by startWebUI). */
  setWebUiControl(control: { stop: () => void; start: () => void }): void {
    this.webuiControl = control;
  }

  constructor(safeMode: boolean = false) {
    this.safeMode = safeMode;
    onDeposed(holder => this.chainWasDeposed(holder));
    if (safeMode) {
      console.log('[BotManager] Initialized in SAFE MODE - bot auto-start disabled');
    }
  }

  /**
   * Set WebSocket manager for real-time updates
   */
  public setWebSocketManager(wsManager: WebSocketManager): void {
    this.wsManager = wsManager;
    console.log('[BotManager] WebSocket manager attached');
  }

  /**
   * Emit event to WebSocket clients with data sanitization
   */
  private emitEvent(type: WSEvent, data: unknown): void {
    if (!this.wsManager) return;

    // Sanitize data before broadcasting
    const sanitizedData = this.sanitizeEventData(data);
    this.wsManager.broadcast(type, sanitizedData);
  }

  /**
   * Sanitize event data to prevent injection and remove sensitive information
   * @param data - Event data to sanitize
   * @returns Sanitized event data safe for broadcasting
   */
  private sanitizeEventData(data: unknown): WSEventData {
    if (data === null || data === undefined) {
      return {} as WSEventData;
    }

    if (typeof data !== 'object') {
      return data as WSEventData;
    }

    // Create shallow copy and remove sensitive fields
    const sanitized = { ...data } as Record<string, unknown>;

    // Remove sensitive fields that should never be broadcast
    const sensitiveFields = [
      'token',
      'password',
      'secret',
      'apiKey',
      'api_key',
      'privateKey',
      'private_key',
      'credential',
      'auth',
      'authorization'
    ];

    sensitiveFields.forEach(field => {
      delete sanitized[field];
    });

    // Type assertion through unknown for flexibility with runtime data
    return sanitized as unknown as WSEventData;
  }

  /**
   * Emit panel update to all WebSocket clients
   * Called when bot process sends panel:live_update IPC message
   */
  private emitPanelUpdate(data: {
    panelId: string;
    guildId: string | null;
    sessionId: string | null;
    response: any;
  }): void {
    if (!this.wsManager) {
      return;
    }

    this.wsManager.broadcast('panel:updated', {
      panelId: data.panelId,
      guildId: data.guildId,
      sessionId: data.sessionId,
      panel: data.response,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Start the bot process
   */
  async start(): Promise<BotStartResult> {
    // The process is exiting: a child started now would outlive it.
    if (this.exiting) {
      return { success: false, reason: 'exiting', error: 'The process is exiting' };
    }

    if (this.migrationBlocksStart()) {
      return { success: false, reason: 'migration_running', error: MIGRATION_RUNNING };
    }

    // Check if another operation is in progress
    if (this.operationInProgress) {
      return {
        success: false,
        reason: 'operation_in_progress',
        error: 'Another operation is in progress'
      };
    }

    // Check if bot is already running
    if (this.isRunning()) {
      return {
        success: false,
        reason: 'already_running',
        error: 'Bot is already running'
      };
    }

    // Lock operations
    this.operationInProgress = true;
    // An operator's start begins a fresh count of automatic ones.
    if (!this.startingAfterCrash) this.crashRestarts = 0;
    this.stopRequested = false;

    // Load and validate credentials
    const credentials = loadCredentials();
    const validation = validateCredentials(credentials);

    if (!validation.isValid) {
      console.log('[BotManager] Credentials not set, bot in standby');
      this.operationInProgress = false; // Release lock
      return {
        success: false,
        reason: 'credentials_missing',
        error: validation.reason
      };
    }

    // Determine bot entry point
    const isProd = process.env.NODE_ENV !== 'development';
    const botEntryPoint = isProd
      ? path.join(__dirname, '..', 'bot', 'index.js') // dist/bot/index.js
      : path.join(__dirname, '..', 'bot', 'index.ts'); // src/bot/index.ts

    console.log(`[BotManager] Starting bot from: ${botEntryPoint}`);

    try {
      // Fork bot process with credentials. BOT_PROCESS_ROLE marks the child
      // so code that must run in exactly one process (e.g. payment-provider
      // tick loops) can tell which side it's on.
      this.botProcess = fork(botEntryPoint, [], {
        env: { ...process.env, ...credentials, BOT_PROCESS_ROLE: 'bot' },
        silent: true, // Capture stdout/stderr
        execArgv: isProd ? [] : ['-r', 'ts-node/register'] // Use ts-node in development
      });

      const child = this.botProcess;
      this.childMode = 'running';
      this.childHeld = null;
      this.childMaintenanceBoot = false;
      this.childModeReported = false;
      this.childLoggedIn = false;
      this.childEnterAnswer = null;
      this.childStage = 'none';
      this.childWaitHolder = null;
      this.childWaitCause = null;
      this.childWaitReadCause = null;
      this.childDeposedHolder = null;
      this.stopKind = null;
      if (typeof child.pid === 'number') this.unexitedChildren.set(child.pid, child);
      this.lastChild = child;
      this.lastChildExited = false;
      // Ops queued in the local chain that have not started are routed again: the child waits for the one in progress.
      this.rerouteQueued();
      // A new child serves no store until it reports one.
      setWebuiDataStoreUrl(null);
      this.botStartTime = Date.now();
      this.crashed = false;

      // Capture stdout
      if (this.botProcess.stdout) {
        this.botProcess.stdout.on('data', (data: Buffer) => {
          const logLine = data.toString();
          this.addLog(logLine);
          if (this.botProcess === child && logLine.includes('Logged in as')) {
            this.childLoggedIn = true;
            this.childModeReported = true;
          }
          process.stdout.write(`[Bot] ${logLine}`); // Also write to parent stdout for Docker logs
        });
      }

      // Capture stderr
      if (this.botProcess.stderr) {
        this.botProcess.stderr.on('data', (data: Buffer) => {
          const logLine = `[ERROR] ${data.toString()}`;
          this.addLog(logLine);
          process.stderr.write(`[Bot] ${logLine}`); // Also write to parent stderr for Docker logs
        });
      }

      // Handle process exit
      this.botProcess.on('exit', (code, signal) => {
        if (this.lastChild === child) this.lastChildExited = true;
        if (typeof child.pid === 'number' && this.unexitedChildren.get(child.pid) === child) this.unexitedChildren.delete(child.pid);
        this.failStageWaiters(child);
        // A child still draining when its shutdown moved the handle on exits
        // later; that exit is not its successor's.
        if (this.botProcess !== child) {
          console.log(`[BotManager] A previous bot child exited with code: ${code}, signal: ${signal}`);
          return;
        }
        console.log(`[BotManager] Bot exited with code: ${code}, signal: ${signal}`);

        if (code === EXIT_DEPOSED) {
          // Another process took the data files' lock: not a crash; a new child waits for the lock.
          this.crashed = false;
          let holder = this.childDeposedHolder;
          if (!holder) {
            const read = readWriterHolder();
            holder = read.kind === 'held' ? { role: read.holder.role ?? null, pid: read.holder.pid } : null;
          }
          console.warn(holder
            ? `[BotManager] The bot process stopped: ${holderWords({ role: holder.role ?? undefined })} (pid ${holder.pid}) took the data files' lock`
            : "[BotManager] The bot process stopped: another process took the data files' lock");
          if (this.stopRequested) {
            console.log('[BotManager] The exit followed a requested stop; not starting the bot again');
          } else {
            this.crashRestartTimer = setTimeout(() => {
              this.crashRestartTimer = null;
              this.runCrashRestart();
            }, CRASH_RESTART_DELAY_MS).unref();
          }
        } else if (code !== 0 && code !== null) {
          // Bot crashed!
          this.crashed = true;
          this.crashLogs = [...this.logs];
          this.addLog(`\n[BotManager] BOT CRASHED - Exit code: ${code}\n`);

          // Record crash to safety manager
          this.safetyManager.recordCrash(code, signal, this.crashLogs);

          this.emitEvent('bot:crash', { code, signal, logs: this.crashLogs });
          // A child that stays down is a dead bot behind a container
          // that still reads running.
          if (this.botStartTime > 0 && Date.now() - this.botStartTime >= CRASH_STABLE_UPTIME_MS) this.crashRestarts = 0;
          if (this.stopRequested) {
            console.log('[BotManager] The exit followed a requested stop; not starting the bot again');
          } else if (this.isInSafeMode()) {
            console.error('[BotManager] Safe mode: the bot stays down after this crash');
          } else if (this.crashRestarts >= CRASH_RESTARTS_MAX) {
            console.error(`[BotManager] The bot stays down: ${this.crashRestarts} automatic starts in a row ended in a crash before ${CRASH_STABLE_UPTIME_MS / 60_000} minutes of uptime; start it by hand`);
          } else {
            this.crashRestarts += 1;
            console.warn(`[BotManager] Starting the bot again in ${CRASH_RESTART_DELAY_MS / 1000}s (automatic start ${this.crashRestarts} of ${CRASH_RESTARTS_MAX})`);
            this.crashRestartTimer = setTimeout(() => {
              this.crashRestartTimer = null;
              this.runCrashRestart();
            }, CRASH_RESTART_DELAY_MS).unref();
          }
        } else {
          // Clean exit
          this.crashed = false;
          this.crashLogs = [];
        }

        this.botProcess = null;
        setWebuiDataStoreUrl(null);
        this.botStartTime = 0;
        this.failPendingIpc('bot process exited before replying');
        this.emitEvent('bot:status', this.getStatus());
      });

      // Handle process errors
      this.botProcess.on('error', (error) => {
        console.error('[BotManager] Bot process error:', error);
        this.addLog(`[BotManager] Process error: ${error.message}`);
      });

      // Handle IPC messages from bot (for real-time panel updates)
      this.botProcess.on('message', (message: any) => {
        // A draining previous child still reports; only the current one may
        // move the manager's state.
        if (this.botProcess !== child) return;
        if (message.type === 'data:writer') {
          this.noteWriterStage(child, message.data);
        } else if (message.type === 'panel:live_update') {
          this.emitPanelUpdate(message.data);
        } else if (message.type === 'metrics:snapshot') {
          if (this.wsManager) {
            this.wsManager.broadcast('bot:metrics:snapshot', message.data);
          }
        } else if (message.type === 'fleet:status') {
          if (this.wsManager) {
            this.wsManager.broadcast('bot:fleet:status', message.data);
          }
        } else if (message.type === 'data:store') {
          // The parent's reader follows the store the child serves, never only
          // the node's own /data/.env.
          setWebuiDataStoreUrl(typeof message.data?.url === 'string' ? message.data.url : null);
          this.childModeReported = true;
        } else if (message.type === 'maintenance:mode') {
          if (typeof message.data?.mode === 'string') {
            if (message.data.boot === true) this.childMaintenanceBoot = true;
            this.childModeReported = true;
            this.childMode = message.data.mode;
            const held = message.data.held;
            this.childHeld = this.childMode === 'held' && held && typeof held.unsavedGuilds === 'number' && typeof held.unsavedFiles === 'number'
              ? { unsavedGuilds: held.unsavedGuilds, unsavedFiles: held.unsavedFiles }
              : null;
            this.emitEvent('bot:status', this.getStatus());
          }
        } else if (message.type === 'control:restart-bot') {
          console.warn(`[BotManager] The bot process asked for a restart: ${typeof message.data?.reason === 'string' ? message.data.reason : 'no reason given'}`);
          void this.requestRestart().then(result => {
            if (!result.success) console.error(`[BotManager] The restart the bot process asked for did not happen: ${result.error ?? result.reason ?? 'unknown'}`);
          });
        } else if (message.type === 'control:shutdown-bot') {
          // Access-log channel "Shut down bot" button: stop the Discord bot child.
          console.warn('[BotManager] control:shutdown-bot received from access-log action');
          void this.shutdown(false);
        } else if (message.type === 'control:stop-webui') {
          console.warn('[BotManager] control:stop-webui received; stopping the web-UI listener (bot stays connected)');
          this.webuiControl?.stop();
        } else if (message.type === 'control:start-webui') {
          console.warn('[BotManager] control:start-webui received; restarting the web-UI listener');
          this.webuiControl?.start();
        }
      });

      // Wait a bit to see if bot starts successfully
      await this.waitForBotReady(5000);

      if (!this.isRunning()) {
        return {
          success: false,
          reason: 'startup_failed',
          error: 'Bot process failed to start'
        };
      }

      const waiting = this.waitingReport(child);
      if (waiting) {
        const what = waiting.cause
          ? `waits for the data disk to take writes (${waiting.cause})`
          : waiting.readCause
            ? `cannot tell which process holds the data files (${waiting.readCause})`
            : `waits for ${waiting.holder ? `${holderWords({ role: waiting.holder.role ?? undefined })} (pid ${waiting.holder.pid})` : 'another process'} to release the data files`;
        console.log(`[BotManager] The bot process started and ${what}`);
        this.emitEvent('bot:status', this.getStatus());
        return {
          success: true,
          waiting: true,
          ...(waiting.holder ? { waitingFor: { ...waiting.holder } } : {}),
          ...(waiting.cause ? { cannotLock: waiting.cause } : {}),
          ...(waiting.readCause ? { cannotRead: waiting.readCause } : {}),
        };
      }
      console.log('[BotManager] Bot started successfully');
      this.emitEvent('bot:startup', this.getStatus());
      return { success: true };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[BotManager] Error starting bot:', errorMessage);
      return {
        success: false,
        reason: 'exception',
        error: errorMessage
      };
    } finally {
      // Release operation lock
      this.operationInProgress = false;
    }
  }

  /** What this child waits for before it opens the data files, while it reported `waiting`. */
  private waitingReport(child: ChildProcess): { holder: { role: string | null; pid: number } | null; cause: string | null; readCause: string | null } | null {
    if (this.botProcess !== child || this.childStage !== 'waiting') return null;
    return { holder: this.childWaitHolder, cause: this.childWaitCause, readCause: this.childWaitReadCause };
  }

  /** The process is about to exit: nothing starts the child again. */
  beginExit(): void {
    this.exiting = true;
  }

  /** The automatic start after a crash; under the migration lock it is recorded and run once at the release. */
  private runCrashRestart(): void {
    if (this.stopRequested || this.isInSafeMode()) {
      console.log(`[BotManager] The automatic start was called off: ${this.stopRequested ? 'a stop was requested' : 'safe mode is on'}`);
      return;
    }
    if (this.migrationBlocksStart()) {
      this.crashRestartDeferred = true;
      console.warn('[BotManager] The automatic start waits: a data migration is running; it runs once the migration ends');
      return;
    }
    this.startingAfterCrash = true;
    void this.start().then(result => {
      if (!result.success && result.reason !== 'already_running') {
        console.error(`[BotManager] The bot did not start again after its crash: ${result.error ?? result.reason ?? 'unknown'}`);
      }
    }).finally(() => { this.startingAfterCrash = false; });
  }

  /** Under the migration lock a start would serve data unless maintenance.json says maintenance (a boot that holds no store). */
  private migrationBlocksStart(): boolean {
    return this.migrationLock !== null && readMaintenanceFile().state !== 'maintenance';
  }

  /** Takes the migration lock in one synchronous turn; false when it is held. */
  takeMigrationLock(job: RunningMigration): boolean {
    if (this.migrationLock) return false;
    this.migrationLock = { jobId: job.jobId, to: job.to };
    return true;
  }

  releaseMigrationLock(): void {
    this.migrationLock = null;
    const restart = this.restartStartDeferred;
    this.restartStartDeferred = null;
    if (restart) {
      this.crashRestartDeferred = false;
      if (this.isRunning() || this.exiting) return;
      if (this.stopsRequested !== restart.stops) {
        console.log('[BotManager] The start a restart left for after the migration was called off: a stop was requested meanwhile');
        return;
      }
      void this.start().then(result => {
        if (!result.success && result.reason !== 'already_running') {
          console.error(`[BotManager] The bot did not start after the migration: ${result.error ?? result.reason ?? 'unknown'}`);
        }
      });
      return;
    }
    if (!this.crashRestartDeferred) return;
    this.crashRestartDeferred = false;
    if (this.isRunning()) return;
    this.runCrashRestart();
  }

  migrationRunning(): RunningMigration | null {
    return this.migrationLock ? { ...this.migrationLock } : null;
  }

  /**
   * Whether a data migration may run beside the bot process: stopped with its exit seen, or booted in maintenance mode.
   * Every other state answers the refusal the operator sees.
   */
  migrationBotState(): { ok: true } | { ok: false; error: string } {
    if (this.operationInProgress || this.stoppingRestart || this.queuedRestart) {
      return { ok: false, error: 'A start or restart of the bot is in progress; try again once it ends' };
    }
    if (!this.isRunning()) {
      if (this.lastChild && !this.lastChildExited && this.lastChild.exitCode === null && this.lastChild.signalCode === null) {
        return { ok: false, error: 'The last bot process has not exited yet; a migration beside it could miss its writes' };
      }
      return { ok: true };
    }
    if (this.childMaintenanceBoot) return { ok: true };
    if (!this.childModeReported) {
      return { ok: false, error: "The bot process is still starting; can't confirm whether it boots in maintenance; try again once it has started" };
    }
    const unsaved = (guilds: number, files: number) => `The bot holds unsaved changes (${guilds} guilds, ${files} files); a stop or restart drops them`;
    const cantConfirm = "can't confirm whether the bot holds unsaved changes; a stop or restart could drop them";
    const answer = this.childEnterAnswer;
    switch (this.childMode) {
      case 'running':
        return { ok: false, error: 'Stop the bot first' };
      case 'maintenance':
        if (answer?.saved === true) return { ok: false, error: 'Restart the bot into maintenance first' };
        if (answer?.saved === false) return { ok: false, error: unsaved(answer.unsavedGuilds ?? 0, answer.unsavedFiles ?? 0) };
        return { ok: false, error: cantConfirm };
      case 'held':
        if (this.childHeld) return { ok: false, error: unsaved(this.childHeld.unsavedGuilds, this.childHeld.unsavedFiles) };
        if (answer?.saved === false) return { ok: false, error: unsaved(answer.unsavedGuilds ?? 0, answer.unsavedFiles ?? 0) };
        return { ok: false, error: cantConfirm };
      case 'login-refused':
      case 'outage':
        return { ok: false, error: cantConfirm };
      default:
        return { ok: false, error: `The bot process is in state ${this.childMode}; stop it first` };
    }
  }

  /**
   * Restart the bot process
   */
  async restart(): Promise<BotStartResult> {
    // A restart still stopping its child is this one too: its start comes
    // after this call, so the child it boots reads what this caller staged.
    const inFlight = this.stoppingRestart;
    if (inFlight?.stopping()) return inFlight.result;

    if (this.migrationBlocksStart()) {
      return { success: false, reason: 'migration_running', error: MIGRATION_RUNNING };
    }

    // Check if another operation is in progress
    if (this.operationInProgress) {
      return {
        success: false,
        reason: 'operation_in_progress',
        error: 'Another operation is in progress'
      };
    }

    console.log('[BotManager] Restarting bot...');

    let stopping = true;
    const result = (async (): Promise<BotStartResult> => {
      let stoppedMeanwhile = false;
      let stopped = false;
      try {
        if (this.isRunning()) {
          const own = this.stopsRequested + 1;
          await this.shutdown(false, 'restart');
          stopped = !this.isRunning();
          // A stop asked for while this one drained (an operator's, the
          // container's) wins over the start.
          stoppedMeanwhile = this.stopsRequested !== own;
        }
      } finally {
        stopping = false;
      }
      if (stoppedMeanwhile) {
        console.log('[BotManager] The restart was called off by a stop requested while the bot drained');
        return { success: false, reason: 'stopped', error: 'A stop was requested while the restart waited for the bot to exit' };
      }
      const started = await this.start();
      if (stopped && !started.success && started.reason === 'migration_running') {
        this.restartStartDeferred = { stops: this.stopsRequested };
        if (!this.migrationLock) this.releaseMigrationLock();
        return {
          ...started,
          error: 'The bot was stopped, but a data migration started meanwhile; it is started again once the migration ends',
        };
      }
      return started;
    })();
    const flight = { result, stopping: () => stopping };
    this.stoppingRestart = flight;
    try {
      return await result;
    } finally {
      if (this.stoppingRestart === flight) this.stoppingRestart = null;
    }
  }

  /**
   * A restart asked for by the bot process: one that lands while another operation holds the lock runs once that
   * operation ends, and a request made meanwhile joins it. It is called off when the asking child was stopped or
   * replaced meanwhile.
   */
  requestRestart(): Promise<BotStartResult> {
    if (this.migrationBlocksStart()) {
      console.warn('[BotManager] The restart the bot process asked for was refused: a data migration is running');
      return Promise.resolve({ success: false, reason: 'migration_running', error: MIGRATION_RUNNING });
    }
    const child = this.botProcess;
    if (this.queuedRestart && this.queuedRestartChild === child) return this.queuedRestart;
    const before = this.queuedRestart;
    const stops = this.stopsRequested;
    let run: Promise<BotStartResult> | null = null;
    run = (async (): Promise<BotStartResult> => {
      try {
        await before?.catch(() => undefined);
        while (this.operationInProgress) await new Promise(resolve => setTimeout(resolve, RESTART_QUEUE_POLL_MS));
        if (!child || this.botProcess !== child || child.killed || this.stopsRequested !== stops) {
          console.log('[BotManager] The restart the bot process asked for was called off: that bot process was stopped or replaced meanwhile');
          return { success: false, reason: 'stopped', error: 'The bot process that asked for the restart was stopped or replaced' };
        }
        return await this.restart();
      } finally {
        if (this.queuedRestart === run) {
          this.queuedRestart = null;
          this.queuedRestartChild = null;
        }
      }
    })();
    this.queuedRestart = run;
    this.queuedRestartChild = child;
    return run;
  }

  /**
   * Shutdown the bot process
   * @param emergency If true, use SIGKILL, otherwise SIGTERM
   * @param kind A restart's stop, or a stop; a stop sent while a restart drains makes it a stop
   */
  async shutdown(emergency: boolean = false, kind: 'stop' | 'restart' = 'stop'): Promise<void> {
    // Check if another operation is in progress (unless emergency)
    if (!emergency && this.operationInProgress) {
      console.warn('[BotManager] Another operation is in progress, shutdown blocked');
      return;
    }

    this.cancelCrashRestart();
    this.stopsRequested += 1;
    if (!this.botProcess) {
      console.log('[BotManager] Bot is not running');
      return;
    }

    // Lock operations for emergency shutdowns
    if (emergency) {
      this.operationInProgress = true;
    }

    // A start that lands during the wait below owns a new child; this stop
    // only ever acts on the one it signalled.
    const child = this.botProcess;
    this.stopKind = kind;
    try {
      const signal = emergency ? 'SIGKILL' : 'SIGTERM';
      console.log(`[BotManager] Shutting down bot with ${signal}...`);
      const exited = this.exitOf(child);

      child.kill(signal);
      this.addLog(`[BotManager] Bot shutdown initiated (${signal})`);
      this.emitEvent('bot:shutdown', { signal, emergency });

      // The child drains its accepted writes before it exits; nothing may
      // start beside it until it has.
      if (!await this.within(exited, emergency ? CHILD_KILL_WAIT_MS : CHILD_STOP_WAIT_MS) && !emergency) {
        console.log('[BotManager] Bot did not exit gracefully, forcing shutdown');
        child.kill('SIGKILL');
        await this.within(exited, CHILD_KILL_WAIT_MS);
      }

      if (this.botProcess === child) {
        this.botProcess = null;
        setWebuiDataStoreUrl(null);
        this.botStartTime = 0;
        // A child that outlived even its kill exits stale and settles
        // nothing, so requests still waiting on it fail here.
        this.failPendingIpc('bot process was stopped before replying');
      }
    } finally {
      // Release lock if emergency
      if (emergency) {
        this.operationInProgress = false;
      }
    }
  }

  /**
   * Check if bot is running
   */
  isRunning(): boolean {
    // Node marks a child killed when a signal is sent; it runs until it exits.
    return this.botProcess !== null && this.botProcess.exitCode === null && this.botProcess.signalCode === null;
  }

  /** The bot process runs and serves: not in maintenance, not refused by its database, not off Discord. */
  isServingNormally(): boolean {
    return this.isRunning() && this.childMode === 'running';
  }

  /**
   * The maintenance hook's step in the bot process: it closes its gate and saves what it holds. A child that does not
   * answer (a timeout, its exit) leaves the save unknown.
   */
  async enterMaintenance(message: string): Promise<MaintenanceSaveResult> {
    if (!this.isRunning() || !this.botProcess) return { saved: true, note: 'No bot process runs, so it holds no changes.' };
    const child = this.botProcess;
    if (this.childStage === 'deposed') {
      const note = `The bot process is stopping: another process (${deposedByWords(this.childDeposedHolder)}) took the data files; can't confirm whether it holds unsaved changes`;
      console.log(`[BotManager] ${note}`);
      this.childEnterAnswer = { saved: null, note };
      return { saved: null, note };
    }
    if (!this.stageReached('shared')) {
      // The child reads maintenance.json after its take and before this report, so a child still short of it reads the file as written.
      let timer: NodeJS.Timeout | undefined;
      const reached = await Promise.race([
        this.whenStage('shared').then(() => 'reached' as const, () => 'exited' as const),
        new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), MAINTENANCE_IPC_TIMEOUT_MS); }),
      ]);
      clearTimeout(timer);
      if (reached !== 'reached') {
        const note = reached === 'exited'
          ? 'The bot process exited before it opened the data files, so it holds no changes.'
          : 'The bot process has not opened the data files yet, so it holds no changes; it reads maintenance.json when it opens them.';
        console.log(`[BotManager] ${note}`);
        return { saved: true, note };
      }
    }
    // The last answer of this child is what a data migration's first check reads.
    const answered = (answer: MaintenanceSaveResult): MaintenanceSaveResult => {
      if (this.botProcess === child) this.childEnterAnswer = answer;
      return answer;
    };
    try {
      const reply = await this.sendIPCMessage('maintenance:enter', { message }, MAINTENANCE_IPC_TIMEOUT_MS);
      if (reply?.saved === true) return answered({ saved: true });
      if (reply?.saved === false) {
        const unsavedGuilds = Number(reply.unsavedGuilds) || 0;
        const unsavedFiles = Number(reply.unsavedFiles) || 0;
        return answered({ saved: false, unsavedGuilds, unsavedFiles, note: `${unsavedGuilds} guild(s) and ${unsavedFiles} file(s) hold changes that could not be saved` });
      }
      console.warn('[BotManager] The bot process answered the maintenance request without a save result');
    } catch (error) {
      console.warn(`[BotManager] The maintenance request got no answer from the bot: ${error instanceof Error ? error.message : String(error)}`);
    }
    return answered({ saved: null, note: "can't confirm whether the held changes were saved" });
  }

  /**
   * The hook 'running' in the bot process: it answers at once, saves what it holds behind its closed gate and asks for
   * its restart once nothing is held, or once the database answers and refuses guilds for their content. With no bot
   * process nothing is started.
   */
  async leaveMaintenance(): Promise<MaintenanceLeaveResult> {
    if (!this.isRunning() || !this.botProcess) {
      return { restarting: false, note: 'No bot process runs, so nothing restarts; the bot stays stopped until it is started.' };
    }
    if (this.childStage === 'deposed') {
      const note = `The bot process is stopping: another process (${deposedByWords(this.childDeposedHolder)}) took the data files; can't confirm whether it starts again`;
      console.log(`[BotManager] ${note}`);
      return { restarting: null, note };
    }
    if (!this.stageReached('shared')) {
      const note = 'The bot process is still starting; it reads maintenance.json as it opens the data files and runs normally.';
      console.log(`[BotManager] ${note}`);
      return { restarting: false, note };
    }
    try {
      const reply = await this.sendIPCMessage('maintenance:leave', {}, LEAVE_IPC_TIMEOUT_MS);
      if (reply?.leaving === true) return { restarting: true, note: 'The bot restarts once it has saved what it holds; a change the database refuses for its content is dropped at that restart.' };
      console.warn('[BotManager] The bot process answered the request to leave maintenance without accepting it');
    } catch (error) {
      console.warn(`[BotManager] The request to leave maintenance got no answer from the bot: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { restarting: null, note: "can't confirm whether the bot restarts: it did not answer the request to leave maintenance" };
  }

  /**
   * Get bot status
   */
  getStatus(): BotStatus {
    const uptime = this.isRunning() && this.botStartTime > 0
      ? Math.floor((Date.now() - this.botStartTime) / 1000)
      : 0;

    return {
      running: this.isRunning(),
      uptime,
      processId: this.botProcess?.pid,
      crashed: this.crashed,
      mode: this.isRunning() ? (this.childStage === 'waiting' ? 'waiting-for-data-files' : this.childStage === 'deposed' ? 'deposed' : this.childMode) : undefined,
      ...(this.isRunning() && this.childHeld ? { held: this.childHeld } : {}),
      migration: this.migrationRunning(),
      dataFiles: this.isRunning() && this.childStage === 'waiting'
        ? (this.childWaitCause
          ? { cannotLock: this.childWaitCause }
          : this.childWaitReadCause
            ? { cannotRead: this.childWaitReadCause }
            : this.childWaitHolder ? { waitingFor: { ...this.childWaitHolder } } : null)
        : null,
    };
  }

  /**
   * A requested stop is never a crash, whatever exit code the platform
   * reports for the kill, and it calls off an automatic start still waiting
   * on its timer.
   */
  cancelCrashRestart(): void {
    this.stopRequested = true;
    if (!this.crashRestartTimer) return;
    clearTimeout(this.crashRestartTimer);
    this.crashRestartTimer = null;
    console.log('[BotManager] The automatic start after the crash was called off by a requested stop');
  }

  private failPendingIpc(message: string): void {
    const pending = [...this.pendingIpcRejects];
    this.pendingIpcRejects.clear();
    for (const fail of pending) fail(new Error(message));
  }

  /**
   * Check if in safe mode
   */
  isInSafeMode(): boolean {
    return this.safeMode || this.safetyManager.isInSafeMode();
  }

  /**
   * Get safety status
   */
  getSafetyStatus() {
    return this.safetyManager.getStatus();
  }

  /**
   * Get logs
   * @param includeCrash Include crash logs if available
   */
  getLogs(includeCrash: boolean = false): LogsResponse {
    if (includeCrash && this.crashLogs.length > 0) {
      return {
        current: this.logs,
        crash: this.crashLogs,
        crashed: true
      };
    }

    return {
      current: this.logs,
      crashed: false
    };
  }

  /**
   * Clear logs
   */
  clearLogs(): void {
    this.logs = [];
    this.crashLogs = [];
    this.crashed = false;
    console.log('[BotManager] Logs cleared');
  }

  /**
   * Add log line to circular buffer
   */
  private addLog(line: string): void {
    this.logs.push(line);

    // Maintain circular buffer
    if (this.logs.length > this.MAX_LOGS) {
      this.logs.shift();
    }

    // Emit real-time log event
    this.emitEvent('bot:log', { line, timestamp: new Date().toISOString() });
  }

  /**
   * Wait for bot to be ready (or timeout)
   */
  private async waitForBotReady(timeout: number = 10000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (!this.isRunning()) {
        return false;
      }

      if (this.childLoggedIn) {
        return true;
      }

      await this.sleep(500);
    }

    // Timeout reached, assume bot is running if process still exists
    return this.isRunning();
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private exitOf(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => child.once('exit', () => resolve()));
  }

  /** Whether done settled within ms. */
  private async within(done: Promise<void>, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); });
    try {
      return await Promise.race([done.then(() => true), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Panel System IPC Communication Methods
   */

  /**
   * Send IPC message to bot and wait for response
   */
  private async sendIPCMessage(type: string, data: any, timeoutMs: number = IPC_TIMEOUT_MS): Promise<any> {
    if (!this.isRunning() || !this.botProcess) {
      throw new Error('Bot is not running');
    }
    if (!this.stageReached(ipcStageOf(type))) throw new Error(this.notOpenText('nothing was sent to it'));

    return new Promise((resolve, reject) => {
      const requestId = `${type}_${Date.now()}_${Math.random()}`;
      const fail = (err: Error) => {
        clearTimeout(timeout);
        this.botProcess?.removeListener('message', messageHandler);
        this.pendingIpcRejects.delete(fail);
        reject(err);
      };
      const timeout = setTimeout(() => {
        this.botProcess?.removeListener('message', messageHandler);
        this.pendingIpcRejects.delete(fail);
        reject(new Error('IPC request timed out; the operation may still complete in the background - check bot logs before retrying'));
      }, timeoutMs);

      const messageHandler = (message: any) => {
        if (message.requestId === requestId) {
          clearTimeout(timeout);
          this.botProcess?.removeListener('message', messageHandler);
          this.pendingIpcRejects.delete(fail);
          resolve(message.data);
        }
      };

      try {
        this.botProcess!.on('message', messageHandler);
        this.botProcess!.send({ type, requestId, data });
        this.pendingIpcRejects.add(fail);
      } catch (error) {
        // Clean up on error
        clearTimeout(timeout);
        this.botProcess?.removeListener('message', messageHandler);
        reject(error);
      }
    });
  }

  /**
   * Invoke a bot command synthetically (console `cmd invoke`). Runs through the
   * real dispatcher in the bot child; replies are captured, not sent to Discord.
   */
  async invokeCommand(payload: any): Promise<any> {
    return await this.sendIPCMessage('command:invoke', payload);
  }

  /**
   * A guild data change: the bot child applies it while it runs (both backends); with no child, a JSON bot's write runs
   * in the local chain, and the rest answer bot-down.
   */
  async writeGuildData(payload: GuildDataWriteRequest): Promise<any> {
    if ((payload.op === 'delete' || payload.op === 'delete-namespace' || payload.op === 'restore-graveyard') && !this.isRunning()) {
      return { ok: false, code: 'bot-down', error: 'bot process is not running' };
    }
    const route = this.writerRoute('guild', { postgresGuild: resolveDataBackend() === 'postgres' });
    if (route.route === undefined) return route;
    if (route.route === 'local') {
      const label = `${payload.op} of ${payload.module ? `${payload.module}/` : ''}${payload.filename}`;
      return this.enqueueLocal({ label, provider: false, run: () => applyOperatorDataWrite(payload), again: () => this.writeGuildData(payload) });
    }
    const graveyardOp = payload.op === 'restore-graveyard' || payload.op === 'delete-namespace';
    try {
      // The stamp is read on the host's monotonic clock, which the bot child reads too.
      return graveyardOp
        ? await this.sendIPCMessage('data:guild-write', { ...payload, answerByMono: (process.hrtime.bigint() + ANSWER_BY_NS).toString() }, GRAVEYARD_OP_IPC_MS)
        : await this.sendIPCMessage('data:guild-write', payload, GUILD_WRITE_IPC_MS);
    } catch (error) {
      return { ok: false, code: 'io-error', noAnswer: noAnswerOf(error), error: error instanceof Error ? error.message : 'IPC failure' };
    }
  }

  /**
   * A change to a shared file (global config, premium, the Dummy provider, a webhook): sent to the child while it runs,
   * run in the local chain while none does. routeWaitMs: how long a webhook waits for a route before its 503.
   */
  async runSharedOp(op: string, args: unknown, options: { routeWaitMs?: number } = {}): Promise<any> {
    const deadline = Date.now() + (options.routeWaitMs ?? 0);
    let route = this.writerRoute('shared');
    while (route.route === undefined && !this.exiting && (route.code === 'starting' || route.code === 'stopping' || route.code === 'held-elsewhere') && Date.now() < deadline) {
      await this.sleep(ROUTE_POLL_MS);
      route = this.writerRoute('shared');
    }
    if (route.route === undefined) return route;
    if (route.route === 'local') {
      return this.enqueueLocal({ label: op, provider: callsProvider(op), run: () => applySharedOp({ op, args }), again: () => this.runSharedOp(op, args, options) });
    }
    try {
      return this.wordedByStop(op, await this.sendIPCMessage('shared:op', { op, args }, SHARED_OP_IPC_MS));
    } catch (error) {
      return { ok: false, code: 'no-answer', noAnswer: noAnswerOf(error), ...(callsProvider(op) ? { providerSentence: PROVIDER_SENTENCE } : {}), error: error instanceof Error ? error.message : 'IPC failure' };
    }
  }

  /** A child's answer to an op sent before BotManager stopped it, in the words of that stop; a restart keeps the child's. */
  private wordedByStop(op: string, reply: any): any {
    if (!reply || reply.ok !== false || this.stopKind !== 'stop') return reply;
    const sentence = callsProvider(op) ? ` ${PROVIDER_SENTENCE}` : '';
    const unconfirmed = reply.answer === 'held' || reply.answer === 'pending';
    if (reply.answer !== 'node-stopping' && !unconfirmed) return reply;
    const marks = unconfirmed ? { stopWorded: true } : {};
    // A partial answer keeps the child's partialEnding (what was saved, reload before a retry); only its lead names the stop.
    if (reply.partial === true) {
      const lead = unconfirmed
        ? 'The bot is stopping and could not confirm your change was saved in full; it may be lost.'
        : 'The bot is stopping, so your change was not saved in full.';
      return { ...reply, ...marks, error: `${lead} ${partialEndingIn(reply.error) ?? `${partialEnding([])}${sentence}`}` };
    }
    return {
      ...reply, ...marks,
      error: unconfirmed
        ? `The bot is stopping and could not confirm your change was saved; it may be lost. Check once the bot is started again.${sentence}`
        : `The bot is stopping, so your change was not saved. Save again once it is started.${sentence}`,
    };
  }

  /** A write route's refusal known before its read (the exit, a stop, a starting or waiting child), without a take. */
  writeRefusal(kind: 'shared' | 'guild'): RouteRefusal | null {
    if (this.exiting || this.chainDeposed || (this.isRunning() && this.botProcess)) {
      const route = this.writerRoute(kind);
      return route.route === undefined ? route : null;
    }
    return null;
  }

  /** Where a write of a shared file goes now: the child, the local chain, or a refusal (decision 5 of NB10). */
  writerRoute(kind: 'shared' | 'guild', options: { postgresGuild?: boolean } = {}): WriterRoute {
    if (this.exiting) return refuse('stopping', ROUTE_TEXT.exiting);
    const child = this.isRunning() ? this.botProcess : null;
    if (child && this.stopKind) return refuse('stopping', this.stopKind === 'restart' ? ROUTE_TEXT.restarting : ROUTE_TEXT.stopping);
    if (child && this.childStage === 'deposed' && this.childDeposedHolder) return refuse('held-elsewhere', deposedRouteText(this.childDeposedHolder));
    if (this.chainDeposed) return refuse('held-elsewhere', deposedRouteText({ role: this.chainDeposed.role ?? null, pid: this.chainDeposed.pid }));
    if (child) {
      if (this.childStage === 'guild' || (this.childStage === 'shared' && kind === 'shared')) return { route: 'child' };
      if (this.childStage === 'waiting') {
        if (this.childWaitCause) return refuse('disk', waitingDiskText(this.childWaitCause));
        if (this.childWaitReadCause) return refuse('held-elsewhere', waitingReadText(this.childWaitReadCause));
        return refuse('starting', waitingText(this.childWaitHolder));
      }
      return refuse('starting', ROUTE_TEXT.starting);
    }
    if (kind === 'guild' && options.postgresGuild) return refuse('bot-down', 'the bot process is not running');
    if (this.chainHolds) return { route: 'local' };
    const previousText = (pid: number) => `A previous bot process this web UI started (pid ${pid}) has not exited yet and still holds the data files; nothing was saved. Try again once it has exited.`;
    const taken = takeWriterLock();
    if (taken.kind === 'taken') {
      const previous = [...this.unexitedChildren.keys()][0];
      if (previous !== undefined) {
        releaseWriterLock();
        return refuse('held-elsewhere', `A previous bot process this web UI started (pid ${previous}) has not exited yet and may still open the data files; nothing was saved. Try again once it has exited.`);
      }
      this.chainHolds = true;
      return { route: 'local' };
    }
    switch (taken.kind) {
      case 'held':
        if (!taken.holder) return refuseTake('held-elsewhere', ROUTE_TEXT.unparsable, { kind: 'unparsable' });
        if (this.unexitedChildren.has(taken.holder.pid)) return refuse('held-elsewhere', previousText(taken.holder.pid));
        return refuse('held-elsewhere', `Another process holds the data files (${routeHolderWords(taken.holder)}, pid ${taken.holder.pid}); nothing was saved. Stop that process or wait until it ends, then try again.`);
      case 'contended':
        return refuseTake('held-elsewhere', ROUTE_TEXT.contended, { kind: 'contended' });
      case 'unreadable':
        return refuseTake('held-elsewhere', `Can't confirm which process holds the data files (${writerLockPath()}: ${taken.errno}); nothing was saved. Check that the web UI can read that file.`, { kind: 'unreadable', errno: taken.errno });
      case 'unwritable':
      default: {
        const errno = (taken as { errno: string }).errno;
        return refuseTake('disk', `The data disk does not take writes (${writerLockPath()}: ${errno}); nothing was saved. Check the disk, then try again.`, { kind: 'unwritable', errno });
      }
    }
  }

  /** Queues a local op; the chain takes it in order and answers after its land-or-cancel step. */
  private enqueueLocal(spec: Omit<LocalEntry, 'resolve'>): Promise<any> {
    return new Promise(resolve => {
      this.chainQueue.push({ ...spec, resolve });
      if (!this.chainCurrent) void this.pumpChain();
    });
  }

  private async pumpChain(): Promise<void> {
    while (this.chainQueue.length > 0 && !this.chainCurrent) {
      const entry = this.chainQueue.shift()!;
      let release!: () => void;
      const done = new Promise<void>(resolve => { release = resolve; });
      this.chainCurrent = { entry, done };
      try {
        const frame = { open: true };
        let reply: any;
        try {
          reply = await localOpFrames.run(frame, entry.run);
        } catch (error) {
          reply = { ok: false, code: 'failed', error: error instanceof Error ? error.message : String(error) };
        } finally {
          frame.open = false;
        }
        const answer = await this.landOrCancel(entry, reply);
        // A change answered as not saved stays out of the caches the next op reads.
        if (answer?.ok !== true) invalidateSharedCaches();
        entry.resolve(answer);
      } finally {
        this.chainCurrent = null;
        release();
      }
      if (this.chainDeposed) {
        // The deposed op has answered; the hold is gone (the file names the other process), and routing reads the lock again.
        this.chainDeposed = null;
        this.chainHolds = false;
        this.rerouteQueued();
        return;
      }
    }
    if (!this.chainCurrent && this.chainQueue.length === 0 && this.chainHolds) {
      this.chainHolds = false;
      releaseWriterLock();
    }
  }

  /** Every gated path still queued in this process lands or is cancelled before the chain moves on or releases the lock. */
  private async landOrCancel(entry: LocalEntry, reply: any): Promise<any> {
    const paths = queuedFilePaths().filter(isSharedPath);
    const results = paths.length > 0 ? await cancelQueued(paths) : [];
    const cancelled = results.flatMap(r => (r.outcome === 'cancelled' ? [r] : []));
    // A path of this op that landed during the wait means part of the change is on disk.
    const partial = reply?.partial === true || results.some(r => r.outcome === 'landed');
    const landedHere = results.flatMap(r => (r.outcome === 'landed' ? [path.basename(r.path)] : []));
    for (const r of cancelled) {
      console.error(`[Data] Not saved: ${r.path} (${r.errno ?? 'not on disk within 8 s'}); the web UI dropped its write before releasing the data files' lock`);
    }
    const sentence = entry.provider ? ` ${PROVIDER_SENTENCE}` : '';
    const saved = () => {
      if (reply?.ok === true) {
        const { pending: _pending, note: _note, ...rest } = reply;
        return rest;
      }
      return { ok: true, result: reply?.result };
    };
    const holder = this.chainDeposed;
    if (holder) {
      // Judged by the op's own tickets and refusals after the cancel's wait, never by the reply's pending or partial.
      const lead = `Another process took the data files (${routeHolderWords({ role: holder.role ?? null })}, pid ${holder.pid}) while your change was being saved;`;
      const writes = carriedWrites(reply);
      const landedTickets = writes?.tickets.filter(landed) ?? [];
      const names = [...new Set(landedTickets.flatMap(t => (t.kind === 'file' ? [path.basename(t.path)] : [])))];
      const someLanded = landedTickets.length > 0 || writes?.landedBefore === true;
      const open = writes?.tickets.some(t => !landed(t) && (t.kind !== 'file' || (!droppedByDeposition(t.record) && filesPending([t.path])))) ?? true;
      let error: string;
      if (!writes || open || writes.unknowable) {
        error = someLanded
          ? `${lead} can't confirm whether it was saved in full. ${partialEnding(names)}${sentence}`
          : `${lead} can't confirm whether it was saved. Reload to check before you try again.${sentence}`;
      } else if (landedTickets.length === writes.tickets.length && !writes.refused && (reply?.ok === true || reply?.code === 'unconfirmed')) {
        return saved();
      } else if (someLanded) {
        error = `${lead} it was not saved in full. ${partialEnding(names)}${sentence}`;
      } else {
        error = `${lead} nothing was saved.${sentence}`;
      }
      return { ok: false, status: 503, code: 'held-elsewhere', error };
    }
    const unconfirmed = reply?.ok === true
      ? reply.pending === true
      : reply?.code === 'unconfirmed' && (reply.answer === 'pending' || reply.answer === 'held' || reply.answer === 'unavailable');
    if (reply?.ok !== true && !unconfirmed) return reply;
    if (cancelled.length === 0) return saved();
    const files = cancelled.map(r => path.basename(r.path)).join(', ');
    const errnos = [...new Set(cancelled.map(r => r.errno).filter((e): e is string => !!e))];
    return {
      ok: false, status: 503, code: 'disk',
      error: `The disk did not take the write of ${files} (${errnos.length > 0 ? errnos.join(', ') : 'within 8 s'}), so your change was ${partial ? `not saved in full. Check the disk. ${partialEnding(landedHere)}` : 'not saved. Check the disk, then try again.'}${sentence}`,
    };
  }

  /** Ops queued and not started leave the chain and are routed again. */
  private rerouteQueued(): void {
    const queued = this.chainQueue.splice(0);
    for (const entry of queued) {
      void entry.again().then(entry.resolve, error => entry.resolve({ ok: false, code: 'failed', error: error instanceof Error ? error.message : String(error) }));
    }
    if (!this.chainCurrent && this.chainHolds && queued.length > 0) {
      this.chainHolds = false;
      releaseWriterLock();
    }
  }

  /** The web UI was deposed: the op in progress answers held-elsewhere, queued ops are routed again. */
  private chainWasDeposed(holder: LockHolder): void {
    if (this.chainCurrent) {
      this.chainDeposed = holder;
      this.rerouteQueued();
    } else {
      this.chainHolds = false;
    }
  }

  /** At the web UI's exit: queued ops are routed again, and the op in progress gets up to 10 s to land or cancel. */
  async endLocalChain(boundMs = LOCAL_CHAIN_EXIT_MS): Promise<void> {
    this.rerouteQueued();
    const current = this.chainCurrent;
    if (!current) return;
    if (!await this.within(current.done, boundMs)) {
      console.error(`[Main] Exiting while a local change is still running (${current.entry.label}); can't confirm whether it was saved`);
    }
  }

  /** A web UI change of its own (the boot populate) run as a local op; a refusal answers when no local op can run. */
  runLocalOp(label: string, run: () => Promise<any>): Promise<any> {
    const route = this.writerRoute('shared');
    if (route.route === undefined) return Promise.resolve(route);
    if (route.route === 'child') return Promise.resolve(refuse('starting', ROUTE_TEXT.starting));
    return this.enqueueLocal({ label, provider: false, run, again: () => this.runLocalOp(label, run) });
  }

  private noteWriterStage(child: ChildProcess, data: any): void {
    const stage = data?.stage;
    if (stage !== 'waiting' && stage !== 'opening' && stage !== 'shared' && stage !== 'guild' && stage !== 'deposed') return;
    const holder = data?.holder && typeof data.holder.pid === 'number'
      ? { role: typeof data.holder.role === 'string' ? data.holder.role : null, pid: data.holder.pid }
      : null;
    if (stage === 'waiting') {
      this.childWaitHolder = holder;
      this.childWaitCause = typeof data?.cause === 'string' ? data.cause : null;
      this.childWaitReadCause = typeof data?.readCause === 'string' ? data.readCause : null;
    } else if (stage === 'deposed') {
      this.childDeposedHolder = holder;
    } else {
      this.childWaitHolder = null;
      this.childWaitCause = null;
      this.childWaitReadCause = null;
    }
    this.childStage = stage === 'opening' ? 'none' : stage;
    for (const waiter of [...this.stageWaiters]) {
      if (waiter.child === child && this.stageReached(waiter.stage)) {
        this.stageWaiters.splice(this.stageWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
    this.emitEvent('bot:status', this.getStatus());
  }

  private stageReached(stage: 'shared' | 'guild'): boolean {
    return this.childStage === 'guild' || (stage === 'shared' && this.childStage === 'shared');
  }

  /** Resolves once the current child reported this stage; rejects when it exits first. */
  whenStage(stage: 'shared' | 'guild'): Promise<void> {
    const child = this.botProcess;
    if (!child || !this.isRunning()) return Promise.reject(new Error('The bot process is not running'));
    if (this.stageReached(stage)) return Promise.resolve();
    return new Promise((resolve, reject) => { this.stageWaiters.push({ stage, child, resolve, reject }); });
  }

  private failStageWaiters(child: ChildProcess): void {
    const failing = this.stageWaiters.filter(w => w.child === child);
    this.stageWaiters = this.stageWaiters.filter(w => w.child !== child);
    for (const waiter of failing) waiter.reject(new Error('The bot process exited before it opened the data files'));
  }

  /** Why a request is not sent to the current child yet. */
  private notOpenText(what: string): string {
    if (this.childStage === 'waiting') {
      if (this.childWaitCause) return `The bot is waiting for the data disk to take writes (${this.childWaitCause}); ${what}.`;
      if (this.childWaitReadCause) return `The bot cannot tell which process holds the data files (${this.childWaitReadCause}); ${what}.`;
      const h = this.childWaitHolder;
      return h
        ? `The bot is waiting for ${holderWords({ role: h.role ?? undefined })} (pid ${h.pid}) to release the data files; ${what}. Try again once it has.`
        : `The bot is waiting for another process to release the data files; ${what}. Try again once it has.`;
    }
    if (this.childStage === 'deposed') {
      return `The bot process is stopping: another process (${deposedByWords(this.childDeposedHolder)}) took the data files; ${what}.`;
    }
    return `The bot is starting and cannot take requests yet; ${what}. Try again in a moment.`;
  }

  /** A read's answer while the child has not opened the data files: the route texts. */
  private readNotOpenText(): string {
    if (this.childStage === 'waiting') {
      if (this.childWaitCause) return waitingDiskText(this.childWaitCause);
      if (this.childWaitReadCause) return waitingReadText(this.childWaitReadCause);
      return waitingText(this.childWaitHolder);
    }
    if (this.childStage === 'deposed') {
      return this.childDeposedHolder
        ? deposedRouteText(this.childDeposedHolder)
        : 'Another process took the data files; nothing was saved. Stop that process or wait until it ends, then try again.';
    }
    return ROUTE_TEXT.starting;
  }

  /** Queue-first read of one global file in the bot child (the root config, or 'module/file.json' under /data/global). */
  async readGlobalData(payload: { root?: 'config'; rel?: string }): Promise<any> {
    if (!this.isRunning() || !this.botProcess) {
      return { ok: false, code: 'bot-down', error: 'bot process is not running' };
    }
    if (!this.stageReached('shared')) return { ok: false, code: 'starting', error: this.readNotOpenText() };
    try {
      return await this.sendIPCMessage('data:global-read', payload, 15000);
    } catch (error) {
      return readNoAnswer(error);
    }
  }

  /** Symmetric read hop; no filename = list the module's files. */
  async readGuildData(payload: { guildId: string; module: string; filename?: string }): Promise<any> {
    if (!this.isRunning() || !this.botProcess) {
      return { ok: false, code: 'bot-down', error: 'bot process is not running' };
    }
    if (!this.stageReached('guild')) return { ok: false, code: 'starting', error: this.readNotOpenText() };
    try {
      return await this.sendIPCMessage('data:guild-read', payload, 15000);
    } catch (error) {
      return readNoAnswer(error);
    }
  }

  /**
   * Get list of panels from bot
   */
  async getPanelList(): Promise<any> {
    try {
      return await this.sendIPCMessage('panel:list', {});
    } catch (error) {
      console.error('[BotManager] Error getting panel list:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Get list of guilds the bot is in
   */
  async getBotGuilds(): Promise<any> {
    try {
      return await this.sendIPCMessage('bot:guilds', {});
    } catch (error) {
      console.error('[BotManager] Error getting bot guilds:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Get the global metrics snapshot from the bot
   */
  async getGlobalMetrics(): Promise<any> {
    try {
      return await this.sendIPCMessage('metrics:global', {});
    } catch (error) {
      console.error('[BotManager] Error getting global metrics:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Get one guild's metrics snapshot from the bot
   */
  async getGuildMetrics(guildId: string): Promise<any> {
    try {
      return await this.sendIPCMessage('metrics:guild', { guildId });
    } catch (error) {
      console.error('[BotManager] Error getting guild metrics:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Get the metrics leaderboard (modules / commands / guilds) from the bot
   */
  async getMetricsLeaderboard(): Promise<any> {
    try {
      return await this.sendIPCMessage('metrics:leaderboard', {});
    } catch (error) {
      console.error('[BotManager] Error getting metrics leaderboard:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Get the fleet state snapshot from the bot
   */
  async getFleetState(): Promise<any> {
    try {
      return await this.sendIPCMessage('fleet:state', {});
    } catch (error) {
      console.error('[BotManager] Error getting fleet state:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Execute a panel
   */
  async executePanel(panelId: string, userId: string, guildId: string | null = null, channelId: string | null = null): Promise<any> {
    try {
      return await this.sendIPCMessage('panel:execute', { panelId, userId, guildId, channelId });
    } catch (error) {
      console.error('[BotManager] Error executing panel:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Handle panel button interaction
   */
  async handlePanelButton(panelId: string, buttonId: string, userId: string, guildId: string | null = null, channelId: string | null = null): Promise<any> {
    try {
      return await this.sendIPCMessage('panel:button', { panelId, buttonId, userId, guildId, channelId });
    } catch (error) {
      console.error('[BotManager] Error handling panel button:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Handle panel dropdown interaction
   */
  async handlePanelDropdown(panelId: string, values: string[], userId: string, guildId: string | null = null, dropdownId?: string, channelId: string | null = null): Promise<any> {
    try {
      return await this.sendIPCMessage('panel:dropdown', { panelId, values, userId, guildId, dropdownId, channelId });
    } catch (error) {
      console.error('[BotManager] Error handling panel dropdown:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Handle panel modal submission
   */
  async handlePanelModal(panelId: string, modalId: string, fields: Record<string, string>, userId: string, guildId: string | null = null, channelId: string | null = null): Promise<any> {
    try {
      return await this.sendIPCMessage('panel:modal', { panelId, modalId, fields, userId, guildId, channelId });
    } catch (error) {
      console.error('[BotManager] Error handling panel modal:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Get text channels for a guild (for channel-required panels)
   */
  async getGuildChannels(guildId: string): Promise<{ success: boolean; channels?: any[]; error?: string }> {
    try {
      return await this.sendIPCMessage('guild:channels', { guildId });
    } catch (error) {
      console.error('[BotManager] Error getting guild channels:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async getGuildRoles(guildId: string): Promise<{ success: boolean; roles?: any[]; error?: string }> {
    try {
      return await this.sendIPCMessage('guild:roles', { guildId });
    } catch (error) {
      console.error('[BotManager] Error getting guild roles:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Check if a user is in the DEVS list
   */
  async isUserDev(userId: string): Promise<{ success: boolean; isDev: boolean; error?: string }> {
    try {
      return await this.sendIPCMessage('dev:check', { userId });
    } catch (error) {
      console.error('[BotManager] Error checking dev status:', error);
      return { success: false, isDev: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Reload a single module (hot-reload via IPC to bot process)
   */
  async reloadModule(moduleName: string): Promise<any> {
    try {
      return await this.sendIPCMessage('module:reload', { moduleName }, IPC_TIMEOUT_MODULE_OP_MS);
    } catch (error) {
      console.error('[BotManager] Error reloading module:', error);
      return { success: false, moduleName, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Reload multiple modules (hot-reload via IPC to bot process)
   */
  async reloadModules(moduleNames: string[]): Promise<any> {
    try {
      return await this.sendIPCMessage('module:reload-all', { moduleNames }, IPC_TIMEOUT_MODULE_OP_MS);
    } catch (error) {
      console.error('[BotManager] Error reloading modules:', error);
      return { success: false, reloaded: [], failed: moduleNames.map(n => ({ moduleName: n, error: error instanceof Error ? error.message : 'Unknown error' })), compileDuration: 0, totalDuration: 0 };
    }
  }

  /**
   * Get list of loaded modules from bot process
   */
  async getLoadedModules(): Promise<any> {
    try {
      return await this.sendIPCMessage('module:list-loaded', {});
    } catch (error) {
      console.error('[BotManager] Error getting loaded modules:', error);
      return { success: false, modules: [], error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Load a newly installed module into memory (hot-load via IPC)
   */
  async loadModule(moduleName: string): Promise<any> {
    try {
      return await this.sendIPCMessage('module:load', { moduleName }, IPC_TIMEOUT_MODULE_OP_MS);
    } catch (error) {
      console.error('[BotManager] Error loading module:', error);
      return { success: false, unconfirmed: true, moduleName, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Unload a module from memory (for uninstall, via IPC)
   */
  async unloadModule(moduleName: string): Promise<any> {
    try {
      return await this.sendIPCMessage('module:unload', { moduleName }, IPC_TIMEOUT_MODULE_OP_MS);
    } catch (error) {
      console.error('[BotManager] Error unloading module:', error);
      return { success: false, moduleName, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Dispatch a subscription notification through the bot process. The bot
   * owns the Discord client; web-UI-side state changes (admin grants,
   * webhook installs) reach the user this way. Best-effort - failures log
   * but never block the originating action.
   */
  async dispatchNotification(guildId: string, kind: string, payload: Record<string, any>): Promise<NotifyOutcome> {
    if (!this.isRunning()) return { delivered: false, cause: 'the bot is not running' };
    try {
      const reply = await this.sendIPCMessage('notification:dispatch', { guildId, kind, payload });
      const outcome = reply?.outcome;
      if (outcome && typeof outcome.delivered === 'boolean') return outcome as NotifyOutcome;
      return { delivered: false, cause: reply?.error || 'the bot gave no delivery outcome' };
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      console.warn('[BotManager] Notification dispatch failed:', cause);
      return { delivered: false, cause: `can't confirm delivery: ${cause}` };
    }
  }

  /**
   * Fire-and-forget access-log event to the bot child (new web-UI session / OAuth
   * login). The child posts to the configured channel when the feature is enabled.
   */
  postAccessLog(info: Record<string, any>): void {
    if (!this.isRunning() || !this.botProcess) return;
    try {
      this.botProcess.send({ type: 'security:access-log', data: info });
    } catch {
      /* access logging must never affect serving */
    }
  }

  /**
   * Toggle a component on/off at runtime via IPC to bot process.
   */
  async toggleComponent(
    moduleName: string,
    componentType: 'command' | 'event' | 'panel',
    name: string,
    enabled: boolean
  ): Promise<any> {
    try {
      return await this.sendIPCMessage('component:toggle', {
        module: moduleName,
        componentType,
        name,
        enabled
      });
    } catch (error) {
      console.error('[BotManager] Error toggling component:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Kick off slash command re-registration (includes orphan cleanup if enabled)
   * as tracked background work. Rate-limited global-command sweeps can run for
   * minutes, so callers return immediately and the UI polls the status instead
   * of blocking a request on the sweep.
   */
  startCommandCleanup(): { alreadyRunning: boolean } {
    if (this.cleanupRun?.running) return { alreadyRunning: true };
    const run: NonNullable<typeof this.cleanupRun> = { running: true, startedAt: Date.now() };
    this.cleanupRun = run;
    void (async () => {
      try {
        const result = await this.sendIPCMessage('commands:reregister', {}, IPC_TIMEOUT_MODULE_OP_MS);
        run.success = result?.success === true;
        if (!run.success) run.error = result?.error || 're-registration failed';
        if (typeof result?.note === 'string') run.note = result.note;
      } catch (error) {
        run.success = false;
        run.error = error instanceof Error ? error.message : String(error);
      } finally {
        run.running = false;
        run.finishedAt = Date.now();
        if (run.error) console.error('[BotManager] Command cleanup failed:', run.error);
      }
    })();
    return { alreadyRunning: false };
  }

  getCommandCleanupStatus(): { running: boolean; startedAt?: number; finishedAt?: number; success?: boolean; error?: string; note?: string } {
    return this.cleanupRun ? { ...this.cleanupRun } : { running: false };
  }

  async listLoadedModules(): Promise<string[] | null> {
    if (!this.isRunning()) return null;
    try {
      const res: any = await this.sendIPCMessage('module:list-loaded', {});
      if (res && res.success && Array.isArray(res.modules)) {
        return res.modules.map((m: any) => m.name).filter((n: any) => typeof n === 'string');
      }
      return null;
    } catch {
      return null;
    }
  }

  async listLoadedModuleCopies(): Promise<Array<{ name: string; path: string; version: string }> | null> {
    if (!this.isRunning()) return null;
    try {
      const res: any = await this.sendIPCMessage('module:list-loaded', {});
      if (res && res.success && Array.isArray(res.modules)) {
        return res.modules
          .filter((m: any) => typeof m.name === 'string')
          .map((m: any) => ({ name: m.name, path: typeof m.path === 'string' ? m.path : '', version: m.version || '' }));
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get detailed info about loaded modules (including command types)
   */
  async listLoadedModulesDetailed(): Promise<any | null> {
    if (!this.isRunning()) return null;
    try {
      return await this.sendIPCMessage('module:list-loaded', {});
    } catch {
      return null;
    }
  }
}
