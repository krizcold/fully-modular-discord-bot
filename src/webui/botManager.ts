import { ChildProcess, fork } from 'child_process';
import * as path from 'path';
import { loadCredentials, validateCredentials, BotCredentials } from '../utils/envLoader';
import { IPC_TIMEOUT_MS, IPC_TIMEOUT_MODULE_OP_MS } from './constants';
import type { WebSocketManager, WSEvent, WSEventData } from './websocketManager';
import { getSafetyManager } from '../utils/updateSafety';
import { resetAppStoreManager } from '../bot/internalSetup/utils/appStoreManager';
import { applyRouteOverrides } from '../bot/internalSetup/utils/dataBackends/routeResolver';

export interface BotStartResult {
  success: boolean;
  reason?: string;
  error?: string;
}

export interface BotStatus {
  running: boolean;
  uptime: number;
  processId?: number;
  crashed: boolean;
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
  private wsManager: WebSocketManager | null = null;
  private operationInProgress: boolean = false; // Prevents race conditions
  private safeMode: boolean = false;
  private safetyManager = getSafetyManager();
  private cleanupRun: { running: boolean; startedAt: number; finishedAt?: number; success?: boolean; error?: string } | null = null;
  // Reject callbacks of in-flight IPC requests, so a child exit settles them
  // immediately instead of leaving callers hanging until their timeout.
  private pendingIpcRejects = new Set<(err: Error) => void>();
  // Web-UI listener control, wired by startWebUI; lets the access-log channel's
  // Discord buttons / the /webui command stop and restart the HTTP listener.
  private webuiControl: { stop: () => void; start: () => void } | null = null;

  /** Wire the web-UI listener stop/start hooks (owned by startWebUI). */
  setWebUiControl(control: { stop: () => void; start: () => void }): void {
    this.webuiControl = control;
  }

  constructor(safeMode: boolean = false) {
    this.safeMode = safeMode;
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

      this.botStartTime = Date.now();
      this.crashed = false;

      // Capture stdout
      if (this.botProcess.stdout) {
        this.botProcess.stdout.on('data', (data: Buffer) => {
          const logLine = data.toString();
          this.addLog(logLine);
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
        console.log(`[BotManager] Bot exited with code: ${code}, signal: ${signal}`);

        if (code !== 0 && code !== null) {
          // Bot crashed!
          this.crashed = true;
          this.crashLogs = [...this.logs];
          this.addLog(`\n[BotManager] BOT CRASHED - Exit code: ${code}\n`);

          // Record crash to safety manager
          this.safetyManager.recordCrash(code, signal, this.crashLogs);

          this.emitEvent('bot:crash', { code, signal, logs: this.crashLogs });
        } else {
          // Clean exit
          this.crashed = false;
          this.crashLogs = [];
        }

        this.botProcess = null;
        this.botStartTime = 0;
        const pending = [...this.pendingIpcRejects];
        this.pendingIpcRejects.clear();
        for (const fail of pending) fail(new Error('bot process exited before replying'));
        this.emitEvent('bot:status', this.getStatus());
      });

      // Handle process errors
      this.botProcess.on('error', (error) => {
        console.error('[BotManager] Bot process error:', error);
        this.addLog(`[BotManager] Process error: ${error.message}`);
      });

      // Handle IPC messages from bot (for real-time panel updates)
      this.botProcess.on('message', (message: any) => {
        if (message.type === 'panel:live_update') {
          this.emitPanelUpdate(message.data);
        } else if (message.type === 'metrics:snapshot') {
          if (this.wsManager) {
            this.wsManager.broadcast('bot:metrics:snapshot', message.data);
          }
        } else if (message.type === 'fleet:status') {
          // The parent's route resolver follows the bot's routing map so
          // /list and /data/get branch per guild during a transformation
          // window (absent or empty clears any overrides).
          try {
            applyRouteOverrides(Array.isArray(message.data?.dataRouting) ? message.data.dataRouting : null);
          } catch { /* status push must never fail */ }
          if (this.wsManager) {
            this.wsManager.broadcast('bot:fleet:status', message.data);
          }
        } else if (message.type === 'sync:applied') {
          // Co-worker applied a master sync: this process's AppStore caches
          // are stale (installed.json/repos.json were overwritten on disk).
          try {
            resetAppStoreManager();
          } catch (error) {
            console.warn('[BotManager] AppStore reset after sync failed:', error instanceof Error ? error.message : error);
          }
          if (this.wsManager) {
            this.wsManager.broadcast('bot:sync:status', message.data);
          }
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

  /**
   * Restart the bot process
   */
  async restart(): Promise<BotStartResult> {
    // Check if another operation is in progress
    if (this.operationInProgress) {
      return {
        success: false,
        reason: 'operation_in_progress',
        error: 'Another operation is in progress'
      };
    }

    console.log('[BotManager] Restarting bot...');

    if (this.isRunning()) {
      await this.shutdown(false); // Graceful shutdown
      // Wait for process to exit
      await this.sleep(2000);
    }

    return await this.start();
  }

  /**
   * Shutdown the bot process
   * @param emergency If true, use SIGKILL, otherwise SIGTERM
   */
  async shutdown(emergency: boolean = false): Promise<void> {
    // Check if another operation is in progress (unless emergency)
    if (!emergency && this.operationInProgress) {
      console.warn('[BotManager] Another operation is in progress, shutdown blocked');
      return;
    }

    if (!this.botProcess) {
      console.log('[BotManager] Bot is not running');
      return;
    }

    // Lock operations for emergency shutdowns
    if (emergency) {
      this.operationInProgress = true;
    }

    try {
      const signal = emergency ? 'SIGKILL' : 'SIGTERM';
      console.log(`[BotManager] Shutting down bot with ${signal}...`);

      this.botProcess.kill(signal);
      this.addLog(`[BotManager] Bot shutdown initiated (${signal})`);
      this.emitEvent('bot:shutdown', { signal, emergency });

      // Wait for process to exit
      await this.sleep(1000);

      // Force kill if still running
      if (this.isRunning() && !emergency) {
        console.log('[BotManager] Bot did not exit gracefully, forcing shutdown');
        this.botProcess?.kill('SIGKILL');
      }

      this.botProcess = null;
      this.botStartTime = 0;
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
    return this.botProcess !== null && !this.botProcess.killed;
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
      crashed: this.crashed
    };
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

      // Check if bot logged "Logged in as" message (indicates success)
      const hasLoggedIn = this.logs.some(log => log.includes('Logged in as'));
      if (hasLoggedIn) {
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
   * Guild data write hop (6.3): the bot child applies the write on the owning
   * node; the parent never writes a postgres-routed guild itself. 15s outer
   * timeout so the inner 10s control hop surfaces its own error first.
   */
  async writeGuildData(payload: { guildId: string; module: string; filename: string; op: 'write' | 'delete' | 'delete-namespace' | 'restore-graveyard'; contentJson?: string }): Promise<any> {
    if (!this.isRunning() || !this.botProcess) {
      return { ok: false, code: 'bot-down', error: 'bot process is not running' };
    }
    try {
      return await this.sendIPCMessage('data:guild-write', payload, 15000);
    } catch (error) {
      return { ok: false, code: 'io-error', error: error instanceof Error ? error.message : 'IPC failure' };
    }
  }

  /** Symmetric read hop; no filename = list the module's files. */
  async readGuildData(payload: { guildId: string; module: string; filename?: string }): Promise<any> {
    if (!this.isRunning() || !this.botProcess) {
      return { ok: false, code: 'bot-down', error: 'bot process is not running' };
    }
    try {
      return await this.sendIPCMessage('data:guild-read', payload, 15000);
    } catch (error) {
      return { ok: false, code: 'io-error', error: error instanceof Error ? error.message : 'IPC failure' };
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
   * Manually assign a FREE shard to a node (master-only; validated in the bot child).
   */
  async assignFleetShard(shardId: number, nodeId: string): Promise<any> {
    try {
      return await this.sendIPCMessage('fleet:assign', { shardId, nodeId });
    } catch (error) {
      console.error('[BotManager] Error assigning fleet shard:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * End the reshard pause and let shard distribution proceed (master-only; validated in the bot child).
   */
  async resumeFleetAssignments(): Promise<any> {
    try {
      return await this.sendIPCMessage('fleet:resumeAssignments', {});
    } catch (error) {
      console.error('[BotManager] Error resuming fleet assignments:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Declare a down node lost: free its shards for redistribution (master-only; validated in the bot child).
   */
  async declareFleetNodeLost(nodeId: string): Promise<any> {
    try {
      return await this.sendIPCMessage('fleet:declareLost', { nodeId });
    } catch (error) {
      console.error('[BotManager] Error declaring fleet node lost:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Fire-and-forget sync bump after a webui write (master bot child bumps
   * the sync revision; no-op on co-workers/standalone or with the bot down).
   */
  notifySyncMutation(scope: string): void {
    if (!this.isRunning() || !this.botProcess) return;
    try {
      this.botProcess.send({ type: 'fleet:sync:bump', data: { scope } });
    } catch { /* backstop rehash covers a lost nudge */ }
  }

  /**
   * Drain a live worker's leases (master-only; validated in the bot child).
   */
  async drainFleetNode(nodeId: string): Promise<any> {
    try {
      return await this.sendIPCMessage('fleet:drain', { nodeId });
    } catch (error) {
      console.error('[BotManager] Error draining fleet node:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /** Start a migration (move/swap/retire/redistribute; master-only, validated in the bot child). */
  async startFleetMigration(payload: any): Promise<any> {
    try {
      return await this.sendIPCMessage('fleet:migrate:start', payload);
    } catch (error) {
      console.error('[BotManager] Error starting migration:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /** Dry-run precheck for a migration (master-only). */
  async precheckFleetMigration(payload: any): Promise<any> {
    try {
      return await this.sendIPCMessage('fleet:migrate:precheck', payload);
    } catch (error) {
      console.error('[BotManager] Error prechecking migration:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /** Abort the active migration (master-only). */
  async abortFleetMigration(migrationId: string): Promise<any> {
    try {
      return await this.sendIPCMessage('fleet:migrate:abort', { migrationId });
    } catch (error) {
      console.error('[BotManager] Error aborting migration:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /** Resume a paused retire (master-only). */
  async resumeFleetMigration(migrationId: string): Promise<any> {
    try {
      return await this.sendIPCMessage('fleet:migrate:resume', { migrationId });
    } catch (error) {
      console.error('[BotManager] Error resuming migration:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /** Dev fault hook: corrupt a held lease id on this node (drill P2.8). */
  async corruptFleetLease(shardId: number): Promise<any> {
    return await this.sendIPCMessage('fleet:dev:corruptLease', { shardId });
  }

  /** List the active + recent migrations (master-only). */
  async listFleetMigrations(): Promise<any> {
    try {
      return await this.sendIPCMessage('fleet:migrations', {});
    } catch (error) {
      console.error('[BotManager] Error listing migrations:', error);
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
      return { success: false, moduleName, error: error instanceof Error ? error.message : 'Unknown error' };
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
  async dispatchNotification(guildId: string, kind: string, payload: Record<string, any>): Promise<void> {
    if (!this.isRunning()) return;
    try {
      await this.sendIPCMessage('notification:dispatch', { guildId, kind, payload });
    } catch (error) {
      console.warn('[BotManager] Notification dispatch failed:', error instanceof Error ? error.message : error);
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

  getCommandCleanupStatus(): { running: boolean; startedAt?: number; finishedAt?: number; success?: boolean; error?: string } {
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
