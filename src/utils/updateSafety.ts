/**
 * Update Safety Manager
 * Runtime safety management for bot and Web-UI
 */

import fs from 'fs';
import path from 'path';

// Configuration paths
const SAFETY_CONFIG_PATH = '/data/update-safety.json';
const CRASH_LOGS_DIR = '/data/crash-logs';
const BACKUPS_DIR = '/data/backups';
const RECOVERY_DIR = '/data/recovery';

// Safety configuration interface
export interface SafetyConfig {
  safeMode: boolean;
  maxConsecutiveCrashes: number;
  crashWindowMs: number;
  crashCount: number;
  crashHistory: CrashRecord[];
  lastSuccessfulStart: number | null;
  currentVersion: string | null;
  rollbackAvailable: boolean;
  rollbackSnapshot: RollbackSnapshot | null;
  safeModeReason?: string;
  safeModeTimestamp?: number;
  lastUpdateAttempt?: number;
  lastUpdateMode?: string;
}

export interface CrashRecord {
  timestamp: number;
  exitCode: number | null;
  signal: string | null;
  updateMode?: string;
  errorMessage?: string;
  logSnippet?: string[];
}

export interface RollbackSnapshot {
  timestamp: number;
  version: string;
  updateMode: string;
  path: string;
  size?: number;
}

export interface BackupMetadata {
  id: string;
  timestamp: number;
  version: string;
  updateMode?: string;
  size: number;
  path: string;
  success: boolean;
}

// Default configuration
const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  safeMode: false,
  maxConsecutiveCrashes: 3,
  crashWindowMs: 300000, // 5 minutes
  crashCount: 0,
  crashHistory: [],
  lastSuccessfulStart: null,
  currentVersion: null,
  rollbackAvailable: false,
  rollbackSnapshot: null
};

/**
 * Update Safety Manager class
 */
export class UpdateSafetyManager {
  private config: SafetyConfig;
  private saveDebounceTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.config = this.loadConfig();
    this.ensureDirectories();
  }

  /**
   * Ensure required directories exist
   */
  private ensureDirectories(): void {
    const dirs = [CRASH_LOGS_DIR, BACKUPS_DIR, RECOVERY_DIR];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch (error) {
          console.error(`Failed to create directory ${dir}:`, error);
        }
      }
    }
  }

  /**
   * Load safety configuration
   */
  private loadConfig(): SafetyConfig {
    try {
      if (fs.existsSync(SAFETY_CONFIG_PATH)) {
        const content = fs.readFileSync(SAFETY_CONFIG_PATH, 'utf8');
        return { ...DEFAULT_SAFETY_CONFIG, ...JSON.parse(content) };
      }
    } catch (error) {
      console.error('Error loading safety config:', error);
    }
    return { ...DEFAULT_SAFETY_CONFIG };
  }

  /**
   * Save safety configuration (with debouncing)
   */
  private saveConfig(immediate: boolean = false): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }

    const save = () => {
      try {
        fs.writeFileSync(SAFETY_CONFIG_PATH, JSON.stringify(this.config, null, 2));
      } catch (error) {
        console.error('Error saving safety config:', error);
      }
    };

    if (immediate) {
      save();
    } else {
      this.saveDebounceTimer = setTimeout(save, 1000);
    }
  }

  /**
   * Record a bot crash
   */
  public recordCrash(exitCode: number | null, signal: string | null, logs?: string[]): void {
    const crashRecord: CrashRecord = {
      timestamp: Date.now(),
      exitCode,
      signal,
      logSnippet: logs?.slice(-50) // Last 50 lines
    };

    // Add to crash history
    this.config.crashHistory.push(crashRecord);
    this.config.crashCount++;

    // Clean old history (keep 24 hours)
    this.cleanCrashHistory();

    // Save crash log to file
    this.saveCrashLog(crashRecord);

    // Check if we should enable safe mode
    const recentCrashes = this.getRecentCrashes();
    if (recentCrashes.length >= this.config.maxConsecutiveCrashes) {
      this.enableSafeMode(`Exceeded crash threshold (${recentCrashes.length}/${this.config.maxConsecutiveCrashes})`);
    }

    this.saveConfig(true);

    console.log(`[UpdateSafety] Recorded crash: exitCode=${exitCode}, signal=${signal}`);
    console.log(`[UpdateSafety] Recent crashes: ${recentCrashes.length}/${this.config.maxConsecutiveCrashes}`);
  }

  /**
   * Save crash log to persistent storage
   */
  private saveCrashLog(crash: CrashRecord): void {
    try {
      const timestamp = new Date(crash.timestamp).toISOString().replace(/:/g, '-');
      const filename = `crash-${timestamp}.json`;
      const filepath = path.join(CRASH_LOGS_DIR, filename);

      fs.writeFileSync(filepath, JSON.stringify(crash, null, 2));

      // Clean old crash logs (keep last 30 days)
      this.cleanOldCrashLogs();
    } catch (error) {
      console.error('Error saving crash log:', error);
    }
  }

  /**
   * Clean old crash logs from disk
   */
  private cleanOldCrashLogs(): void {
    try {
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const files = fs.readdirSync(CRASH_LOGS_DIR);

      for (const file of files) {
        if (file.startsWith('crash-') && file.endsWith('.json')) {
          const filepath = path.join(CRASH_LOGS_DIR, file);
          const stats = fs.statSync(filepath);

          if (stats.mtimeMs < thirtyDaysAgo) {
            fs.unlinkSync(filepath);
          }
        }
      }
    } catch (error) {
      console.error('Error cleaning old crash logs:', error);
    }
  }

  /**
   * Record successful startup
   */
  public recordSuccessfulStart(): void {
    this.config.lastSuccessfulStart = Date.now();
    this.config.crashCount = 0; // Reset consecutive crash counter

    // Clear safe mode if it was enabled due to crashes
    if (this.config.safeMode && this.config.safeModeReason?.includes('crash threshold')) {
      this.disableSafeMode();
    }

    this.saveConfig();
    console.log('[UpdateSafety] Recorded successful startup');
  }

  /**
   * Get recent crashes within time window
   */
  public getRecentCrashes(): CrashRecord[] {
    const now = Date.now();
    const windowStart = now - this.config.crashWindowMs;

    return this.config.crashHistory.filter(crash =>
      crash.timestamp >= windowStart
    );
  }

  /**
   * Clean old crash history
   */
  private cleanCrashHistory(): void {
    const now = Date.now();
    const retentionMs = 24 * 60 * 60 * 1000; // 24 hours

    this.config.crashHistory = this.config.crashHistory.filter(crash =>
      crash.timestamp >= (now - retentionMs)
    );
  }

  /**
   * Enable safe mode
   */
  public enableSafeMode(reason: string): void {
    this.config.safeMode = true;
    this.config.safeModeReason = reason;
    this.config.safeModeTimestamp = Date.now();

    this.saveConfig(true);
    console.log(`[UpdateSafety] Safe mode ENABLED: ${reason}`);
  }

  /**
   * Disable safe mode
   */
  public disableSafeMode(): void {
    this.config.safeMode = false;
    this.config.safeModeReason = undefined;
    this.config.safeModeTimestamp = undefined;

    this.saveConfig(true);
    console.log('[UpdateSafety] Safe mode DISABLED');
  }

  /**
   * Get current safety status
   */
  public getStatus(): SafetyConfig {
    return { ...this.config };
  }

  /**
   * Clear crash history
   */
  public clearCrashHistory(): void {
    this.config.crashHistory = [];
    this.config.crashCount = 0;

    this.saveConfig(true);
    console.log('[UpdateSafety] Crash history cleared');
  }

  /**
   * Check if in safe mode
   */
  public isInSafeMode(): boolean {
    return this.config.safeMode;
  }

  /**
   * Get crash logs from disk
   */
  public getCrashLogs(limit: number = 10): CrashRecord[] {
    try {
      const files = fs.readdirSync(CRASH_LOGS_DIR)
        .filter(f => f.startsWith('crash-') && f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, limit);

      const logs: CrashRecord[] = [];

      for (const file of files) {
        const filepath = path.join(CRASH_LOGS_DIR, file);
        const content = fs.readFileSync(filepath, 'utf8');
        logs.push(JSON.parse(content));
      }

      return logs;
    } catch (error) {
      console.error('Error reading crash logs:', error);
      return [];
    }
  }

  /**
   * Create a rollback snapshot
   */
  public createRollbackSnapshot(version: string, updateMode: string, backupPath: string): void {
    const snapshot: RollbackSnapshot = {
      timestamp: Date.now(),
      version,
      updateMode,
      path: backupPath
    };

    // Check if backup file exists and get size
    if (fs.existsSync(backupPath)) {
      const stats = fs.statSync(backupPath);
      snapshot.size = stats.size;
    }

    this.config.rollbackSnapshot = snapshot;
    this.config.rollbackAvailable = true;

    this.saveConfig(true);
    console.log(`[UpdateSafety] Created rollback snapshot: ${version}`);
  }

  /**
   * Clear rollback snapshot
   */
  public clearRollbackSnapshot(): void {
    this.config.rollbackSnapshot = null;
    this.config.rollbackAvailable = false;

    this.saveConfig(true);
    console.log('[UpdateSafety] Rollback snapshot cleared');
  }

  /**
   * Get list of available backups
   */
  public getBackups(): BackupMetadata[] {
    try {
      const backups: BackupMetadata[] = [];
      const dirs = fs.readdirSync(BACKUPS_DIR);

      for (const dir of dirs) {
        if (dir.startsWith('backup-')) {
          const metadataPath = path.join(BACKUPS_DIR, dir, 'metadata.json');

          if (fs.existsSync(metadataPath)) {
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            backups.push(metadata);
          }
        }
      }

      return backups.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      console.error('Error getting backups:', error);
      return [];
    }
  }

  /**
   * Validate bot health after startup
   */
  public async validateHealth(timeoutMs: number = 60000): Promise<boolean> {
    return new Promise((resolve) => {
      console.log(`[UpdateSafety] Starting health validation (${timeoutMs}ms grace period)`);

      setTimeout(() => {
        // If we reach this point, bot hasn't crashed during grace period
        this.recordSuccessfulStart();
        resolve(true);
      }, timeoutMs);
    });
  }
}

// Singleton instance
let instance: UpdateSafetyManager | null = null;

/**
 * Get or create safety manager instance
 */
export function getSafetyManager(): UpdateSafetyManager {
  if (!instance) {
    instance = new UpdateSafetyManager();
  }
  return instance;
}

export default UpdateSafetyManager;