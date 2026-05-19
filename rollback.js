#!/usr/bin/env node

/**
 * Rollback Script
 * Restores /app/custom and /data/appstore-modules from a backup snapshot
 * when the crash threshold is exceeded. Called by safety-check.js during
 * auto-recovery; also runnable from the CLI for manual snapshots / rollbacks.
 *
 * Backup layout (matches the Web-UI /api/update/backup route):
 *   /data/backups/backup-<timestamp>/
 *     custom/             (mirror of /app/custom)
 *     appstore-modules/   (mirror of /data/appstore-modules)
 *     metadata.json
 *
 * /app/src is image-baked (immutable) - image revert is its mechanism.
 * /app/build and /app/dist are ephemeral - rebuilt from src+custom by start.sh
 * on every buildId mismatch.
 */

const fs = require('fs');
const path = require('path');

const CUSTOM_PATH = '/app/custom';
const APPSTORE_MODULES_PATH = '/data/appstore-modules';
const BUILD_PATH = '/app/build';
const DIST_PATH = '/app/dist';
const APPLIED_VERSION_PATH = '/data/applied-version.json';
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
 * Restore a single subdir from backup into its target location.
 * Returns true if the subdir existed in the backup and was restored.
 */
function restoreSubdir(backupSubdir, targetDir, label) {
  if (!fs.existsSync(backupSubdir)) {
    console.log(`[Rollback] Backup has no ${label}/, skipping ${targetDir} restore`);
    return false;
  }

  console.log(`[Rollback] Restoring ${targetDir} from backup...`);
  fs.mkdirSync(targetDir, { recursive: true });
  emptyDirectory(targetDir);
  copyDirectory(backupSubdir, targetDir);
  return true;
}

/**
 * Perform rollback from a backup snapshot
 * @param {Object} snapshot - Snapshot info with path and version
 * @param {string} snapshot.path - Path to backup directory (/data/backups/backup-<ts>)
 * @param {string} [snapshot.version] - Version string for logging
 */
function performRollback(snapshot) {
  if (!snapshot || !snapshot.path) {
    throw new Error('Invalid snapshot: missing path');
  }

  const backupPath = snapshot.path;
  const backupCustom = path.join(backupPath, 'custom');
  const backupAppstore = path.join(backupPath, 'appstore-modules');

  console.log(`[Rollback] Starting rollback to: ${snapshot.version || 'previous version'}`);
  console.log(`[Rollback] Backup path: ${backupPath}`);

  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup not found: ${backupPath}`);
  }

  if (!fs.existsSync(backupCustom) && !fs.existsSync(backupAppstore)) {
    throw new Error(`Backup is corrupted (missing custom and appstore-modules): ${backupPath}`);
  }

  restoreSubdir(backupCustom, CUSTOM_PATH, 'custom');
  restoreSubdir(backupAppstore, APPSTORE_MODULES_PATH, 'appstore-modules');

  // Clear ephemeral build outputs and the applied-version marker so the next
  // boot's buildId compare in start.sh rebuilds /app/build and /app/dist from
  // the restored /app/custom + /app/src + /data/appstore-modules.
  console.log('[Rollback] Clearing /app/build, /app/dist, /data/applied-version.json (next boot rebuilds)');
  fs.rmSync(BUILD_PATH, { recursive: true, force: true });
  fs.rmSync(DIST_PATH, { recursive: true, force: true });
  if (fs.existsSync(APPLIED_VERSION_PATH)) {
    fs.unlinkSync(APPLIED_VERSION_PATH);
  }

  // Update backup metadata
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
    const customPath = path.join(backupPath, 'custom');
    const appstorePath = path.join(backupPath, 'appstore-modules');

    // Accept a backup as long as at least one of the two subdirs is present.
    if (!fs.existsSync(customPath) && !fs.existsSync(appstorePath)) continue;

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
 * Create a rollback snapshot of the two mutable user-state dirs
 * (/app/custom + /data/appstore-modules).
 * @param {string} [description] - Optional description
 * @returns {Object} Snapshot info
 */
function createSnapshot(description = 'Manual snapshot') {
  const timestamp = Date.now();
  const backupName = `backup-${timestamp}`;
  const backupPath = path.join(BACKUPS_PATH, backupName);

  console.log(`[Rollback] Creating snapshot: ${backupName}`);

  fs.mkdirSync(BACKUPS_PATH, { recursive: true });
  fs.mkdirSync(backupPath, { recursive: true });

  if (fs.existsSync(CUSTOM_PATH)) {
    copyDirectory(CUSTOM_PATH, path.join(backupPath, 'custom'));
  }
  if (fs.existsSync(APPSTORE_MODULES_PATH)) {
    copyDirectory(APPSTORE_MODULES_PATH, path.join(backupPath, 'appstore-modules'));
  }

  // Read version from package.json
  let version = 'unknown';
  try {
    const packageJson = JSON.parse(fs.readFileSync('/app/package.json', 'utf-8'));
    version = packageJson.version || 'unknown';
  } catch (error) {
    // Ignore
  }

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
