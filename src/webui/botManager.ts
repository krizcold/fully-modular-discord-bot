import { ChildProcess, fork } from 'child_process';
import * as path from 'path';
import { loadCredentials, validateCredentials, BotCredentials } from '../utils/envLoader';
import { IPC_TIMEOUT_MS } from './constants';
import type { WebSocketManager, WSEvent, WSEventData } from './websocketManager';
import { getSafetyManager } from '../utils/updateSafety';

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
      // Fork bot process with credentials
      this.botProcess = fork(botEntryPoint, [], {
        env: { ...process.env, ...credentials },
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
  private async sendIPCMessage(type: string, data: any): Promise<any> {
    if (!this.isRunning() || !this.botProcess) {
      throw new Error('Bot is not running');
    }

    return new Promise((resolve, reject) => {
      const requestId = `${type}_${Date.now()}_${Math.random()}`;
      const timeout = setTimeout(() => {
        this.botProcess?.removeListener('message', messageHandler);
        reject(new Error('IPC request timeout'));
      }, IPC_TIMEOUT_MS);

      const messageHandler = (message: any) => {
        if (message.requestId === requestId) {
          clearTimeout(timeout);
          this.botProcess?.removeListener('message', messageHandler);
          resolve(message.data);
        }
      };

      try {
        this.botProcess!.on('message', messageHandler);
        this.botProcess!.send({ type, requestId, data });
      } catch (error) {
        // Clean up on error
        clearTimeout(timeout);
        this.botProcess?.removeListener('message', messageHandler);
        reject(error);
      }
    });
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
}
