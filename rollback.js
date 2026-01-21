#!/usr/bin/env node

/**
 * Rollback Script
 * Restores smdb-source from a backup snapshot when crash threshold is exceeded.
 * Called by safety-check.js during auto-recovery.
 */

const fs = require('fs');
const path = require('path');

const SMDB_SOURCE_PATH = '/app/smdb-source';
const BACKUPS_PATH = '/data/backups';

/**
 * Copy directory recursively
 */
function copyDirectory(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`Source directory does not exist: ${src}`);
  }

  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Empty directory contents without removing the directory itself
 */
function emptyDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    fs.rmSync(fullPath, { recursive: true, force: true });
  }
}

/**
 * Perform rollback from a backup snapshot
 * @param {Object} snapshot - Snapshot info with path and version
 * @param {string} snapshot.path - Path to backup directory
 * @param {string} [snapshot.version] - Version string for logging
 */
function performRollback(snapshot) {
  if (!snapshot || !snapshot.path) {
    throw new Error('Invalid snapshot: missing path');
  }

  const backupPath = snapshot.path;
  const sourcePath = path.join(backupPath, 'smdb-source');

  console.log(`[Rollback] Starting rollback to: ${snapshot.version || 'previous version'}`);
  console.log(`[Rollback] Backup path: ${backupPath}`);

  // Verify backup exists
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup not found: ${backupPath}`);
  }

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Backup source not found: ${sourcePath}`);
  }

  // Verify smdb-source is writable
  const testFile = path.join(SMDB_SOURCE_PATH, '.rollback-test');
  try {
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
  } catch (error) {
    throw new Error(`Cannot write to smdb-source: ${error.message}`);
  }

  // Empty current smdb-source
  console.log('[Rollback] Clearing current smdb-source...');
  emptyDirectory(SMDB_SOURCE_PATH);

  // Copy backup to smdb-source
  console.log('[Rollback] Restoring from backup...');
  copyDirectory(sourcePath, SMDB_SOURCE_PATH);

  // Update rollback metadata
  const metadataPath = path.join(backupPath, 'metadata.json');
  if (fs.existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      metadata.usedForRollback = true;
      metadata.rollbackTime = Date.now();
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    } catch (error) {
      console.warn('[Rollback] Failed to update backup metadata:', error.message);
    }
  }

  console.log('[Rollback] Rollback completed successfully');
  return true;
}

/**
 * List available backups
 * @returns {Array} Array of backup info objects
 */
function listBackups() {
  const backups = [];

  if (!fs.existsSync(BACKUPS_PATH)) {
    return backups;
  }

  const entries = fs.readdirSync(BACKUPS_PATH, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('backup-')) continue;

    const backupPath = path.join(BACKUPS_PATH, entry.name);
    const metadataPath = path.join(backupPath, 'metadata.json');
    const sourcePath = path.join(backupPath, 'smdb-source');

    // Skip if source doesn't exist
    if (!fs.existsSync(sourcePath)) continue;

    let metadata = {
      timestamp: parseInt(entry.name.replace('backup-', '')) || 0,
      version: 'unknown',
      description: 'Backup'
    };

    if (fs.existsSync(metadataPath)) {
      try {
        metadata = { ...metadata, ...JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) };
      } catch (error) {
        // Use defaults
      }
    }

    backups.push({
      name: entry.name,
      path: backupPath,
      ...metadata
    });
  }

  // Sort by timestamp descending (newest first)
  backups.sort((a, b) => b.timestamp - a.timestamp);

  return backups;
}

/**
 * Get the most recent backup suitable for rollback
 * @returns {Object|null} Backup info or null if none available
 */
function getLatestBackup() {
  const backups = listBackups();
  return backups.length > 0 ? backups[0] : null;
}

/**
 * Create a rollback snapshot from current smdb-source
 * @param {string} [description] - Optional description
 * @returns {Object} Snapshot info
 */
function createSnapshot(description = 'Manual snapshot') {
  const timestamp = Date.now();
  const backupName = `backup-${timestamp}`;
  const backupPath = path.join(BACKUPS_PATH, backupName);

  console.log(`[Rollback] Creating snapshot: ${backupName}`);

  // Ensure backups directory exists
  fs.mkdirSync(BACKUPS_PATH, { recursive: true });

  // Create backup directory
  fs.mkdirSync(backupPath, { recursive: true });

  // Copy smdb-source to backup
  const destDir = path.join(backupPath, 'smdb-source');
  copyDirectory(SMDB_SOURCE_PATH, destDir);

  // Get version from package.json
  let version = 'unknown';
  try {
    const packageJson = JSON.parse(fs.readFileSync('/app/package.json', 'utf-8'));
    version = packageJson.version || 'unknown';
  } catch (error) {
    // Ignore
  }

  // Create metadata
  const metadata = {
    timestamp,
    version,
    description,
    type: 'manual'
  };

  fs.writeFileSync(
    path.join(backupPath, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  console.log(`[Rollback] Snapshot created: ${backupName}`);

  return {
    name: backupName,
    path: backupPath,
    ...metadata
  };
}

/**
 * Clean up old backups, keeping only the specified number
 * @param {number} keepCount - Number of backups to keep
 */
function cleanupOldBackups(keepCount = 5) {
  const backups = listBackups();

  if (backups.length <= keepCount) {
    return;
  }

  const toDelete = backups.slice(keepCount);

  for (const backup of toDelete) {
    console.log(`[Rollback] Removing old backup: ${backup.name}`);
    try {
      fs.rmSync(backup.path, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[Rollback] Failed to remove backup ${backup.name}:`, error.message);
    }
  }
}

// Export functions
module.exports = {
  performRollback,
  listBackups,
  getLatestBackup,
  createSnapshot,
  cleanupOldBackups
};

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'list':
      const backups = listBackups();
      if (backups.length === 0) {
        console.log('No backups available');
      } else {
        console.log('Available backups:');
        for (const backup of backups) {
          const date = new Date(backup.timestamp).toISOString();
          console.log(`  ${backup.name} - v${backup.version} (${date})`);
        }
      }
      break;

    case 'create':
      const description = args.slice(1).join(' ') || 'Manual snapshot';
      createSnapshot(description);
      break;

    case 'rollback':
      const backupName = args[1];
      if (!backupName) {
        const latest = getLatestBackup();
        if (!latest) {
          console.error('No backups available for rollback');
          process.exit(1);
        }
        performRollback(latest);
      } else {
        const backupPath = path.join(BACKUPS_PATH, backupName);
        if (!fs.existsSync(backupPath)) {
          console.error(`Backup not found: ${backupName}`);
          process.exit(1);
        }
        performRollback({ path: backupPath });
      }
      break;

    case 'cleanup':
      const keepCount = parseInt(args[1]) || 5;
      cleanupOldBackups(keepCount);
      break;

    default:
      console.log('Usage: node rollback.js <command> [args]');
      console.log('Commands:');
      console.log('  list              - List available backups');
      console.log('  create [desc]     - Create a new snapshot');
      console.log('  rollback [name]   - Rollback to backup (latest if no name)');
      console.log('  cleanup [keep]    - Remove old backups (default: keep 5)');
      break;
  }
}
