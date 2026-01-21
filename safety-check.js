#!/usr/bin/env node

/**
 * Safety Check Script
 * Runs before TypeScript compilation to prevent crash loops
 * Manages safe mode, crash detection, and auto-rollback
 */

const fs = require('fs');
const path = require('path');

// Configuration paths
const SAFETY_CONFIG_PATH = '/data/update-safety.json';
const UPDATE_CONFIG_PATH = '/data/update-config.json';
const CRASH_LOGS_DIR = '/data/crash-logs';
const BACKUPS_DIR = '/data/backups';

// Default safety configuration
const DEFAULT_SAFETY_CONFIG = {
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

// Console colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m'
};

/**
 * Load safety configuration
 */
function loadSafetyConfig() {
  try {
    if (fs.existsSync(SAFETY_CONFIG_PATH)) {
      const content = fs.readFileSync(SAFETY_CONFIG_PATH, 'utf8');
      return { ...DEFAULT_SAFETY_CONFIG, ...JSON.parse(content) };
    }
  } catch (error) {
    console.error(`${colors.red}Error loading safety config:${colors.reset}`, error.message);
  }
  return { ...DEFAULT_SAFETY_CONFIG };
}

/**
 * Save safety configuration
 */
function saveSafetyConfig(config) {
  try {
    fs.writeFileSync(SAFETY_CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error(`${colors.red}Error saving safety config:${colors.reset}`, error.message);
  }
}

/**
 * Check if crashes are within the time window
 */
function getRecentCrashes(config) {
  const now = Date.now();
  const windowStart = now - config.crashWindowMs;

  return config.crashHistory.filter(crash =>
    crash.timestamp >= windowStart
  );
}

/**
 * Clean old crash history
 */
function cleanCrashHistory(config) {
  const now = Date.now();
  const retentionMs = 24 * 60 * 60 * 1000; // Keep 24 hours of history

  config.crashHistory = config.crashHistory.filter(crash =>
    crash.timestamp >= (now - retentionMs)
  );

  return config;
}

/**
 * Check if rollback is available
 */
function checkRollbackAvailable(config) {
  if (!config.rollbackSnapshot) {
    return false;
  }

  const backupPath = config.rollbackSnapshot.path;
  return fs.existsSync(backupPath);
}

/**
 * Main safety check logic
 */
function performSafetyCheck() {
  console.log(`\n${colors.blue}${colors.bright}=== Bot Update Safety Check ===${colors.reset}\n`);

  // Load configuration
  let config = loadSafetyConfig();
  config = cleanCrashHistory(config);

  // Get recent crashes
  const recentCrashes = getRecentCrashes(config);
  const recentCrashCount = recentCrashes.length;

  console.log(`${colors.yellow}Recent crashes:${colors.reset} ${recentCrashCount} in last ${config.crashWindowMs / 60000} minutes`);
  console.log(`${colors.yellow}Crash threshold:${colors.reset} ${config.maxConsecutiveCrashes}`);
  console.log(`${colors.yellow}Safe mode:${colors.reset} ${config.safeMode ? 'ENABLED' : 'disabled'}`);

  // Check if we're already in safe mode
  if (config.safeMode) {
    console.log(`\n${colors.yellow}${colors.bright}⚠️  SAFE MODE ACTIVE${colors.reset}`);
    console.log('Bot auto-start is disabled to prevent crash loops.');
    console.log('Access the Web-UI to:');
    console.log('  • Manually start the bot');
    console.log('  • Trigger a rollback');
    console.log('  • Clear safe mode after fixing issues\n');

    // Exit with code 2 to signal safe mode to start.sh
    process.exit(2);
  }

  // Check if crash threshold exceeded
  if (recentCrashCount >= config.maxConsecutiveCrashes) {
    console.log(`\n${colors.red}${colors.bright}🚨 CRASH THRESHOLD EXCEEDED${colors.reset}`);
    console.log(`Bot has crashed ${recentCrashCount} times in the last ${config.crashWindowMs / 60000} minutes.`);

    // Check for rollback availability
    const rollbackAvailable = checkRollbackAvailable(config);

    if (rollbackAvailable) {
      console.log(`${colors.green}Rollback available:${colors.reset} ${config.rollbackSnapshot.version || 'previous version'}`);
      console.log('Auto-rollback will be triggered...');

      // Trigger rollback (will be implemented in rollback.js)
      try {
        const rollbackScript = path.join(__dirname, 'rollback.js');
        if (fs.existsSync(rollbackScript)) {
          require(rollbackScript).performRollback(config.rollbackSnapshot);
          console.log(`${colors.green}✓ Rollback completed successfully${colors.reset}`);

          // Clear crash history after successful rollback
          config.crashHistory = [];
          config.crashCount = 0;
        }
      } catch (error) {
        console.error(`${colors.red}Rollback failed:${colors.reset}`, error.message);
      }
    } else {
      console.log(`${colors.red}No rollback available${colors.reset}`);
    }

    // Enable safe mode
    config.safeMode = true;
    config.safeModeReason = `Exceeded crash threshold (${recentCrashCount}/${config.maxConsecutiveCrashes})`;
    config.safeModeTimestamp = Date.now();

    saveSafetyConfig(config);

    console.log(`\n${colors.yellow}Entering SAFE MODE to prevent further crashes.${colors.reset}`);
    process.exit(2);
  }

  // Check if we're recovering from a previous update
  const updateConfig = loadUpdateConfig();
  if (updateConfig.updateInProgress) {
    console.log(`${colors.yellow}Update in progress:${colors.reset} ${updateConfig.updateMode || 'unknown'}`);

    // Record that we're attempting to start after an update
    config.lastUpdateAttempt = Date.now();
    config.lastUpdateMode = updateConfig.updateMode;
  }

  // Save updated config
  saveSafetyConfig(config);

  console.log(`${colors.green}✓ Safety check passed${colors.reset}`);
  console.log('Proceeding with normal startup...\n');

  // Exit with 0 to continue normal startup
  process.exit(0);
}

/**
 * Load update configuration
 */
function loadUpdateConfig() {
  try {
    if (fs.existsSync(UPDATE_CONFIG_PATH)) {
      const content = fs.readFileSync(UPDATE_CONFIG_PATH, 'utf8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error(`${colors.red}Error loading update config:${colors.reset}`, error.message);
  }
  return { updateInProgress: false };
}

/**
 * Create necessary directories
 */
function ensureDirectories() {
  const dirs = [CRASH_LOGS_DIR, BACKUPS_DIR, '/data/recovery'];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`${colors.green}Created directory:${colors.reset} ${dir}`);

        // If we're root and created the directory, fix ownership
        if (process.getuid && process.getuid() === 0) {
          try {
            require('child_process').execSync(`chown -R node:node ${dir}`);
            console.log(`${colors.green}Fixed ownership:${colors.reset} ${dir}`);
          } catch (chownError) {
            console.warn(`${colors.yellow}Warning: Could not change ownership of ${dir}${colors.reset}`);
          }
        }
      } catch (error) {
        if (error.code === 'EACCES' || error.code === 'EPERM') {
          console.warn(`${colors.yellow}Permission denied creating ${dir}${colors.reset}`);
          console.warn(`${colors.yellow}The bot will continue but some features may be limited${colors.reset}`);
          // Don't exit - allow bot to start even if directories can't be created
        } else {
          console.error(`${colors.red}Failed to create directory ${dir}:${colors.reset}`, error.message);
        }
      }
    }
  }
}

// Entry point
if (require.main === module) {
  // Ensure directories exist
  ensureDirectories();

  // Perform safety check
  performSafetyCheck();
}

module.exports = {
  loadSafetyConfig,
  saveSafetyConfig,
  getRecentCrashes,
  cleanCrashHistory
};