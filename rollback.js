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
const DATA_ROOT = process.env.DATA_DIR || '/data';
const APPSTORE_MODULES_PATH = path.join(DATA_ROOT, 'appstore-modules');
const BUILD_PATH = '/app/build';
const DIST_PATH = '/app/dist';
const APPLIED_VERSION_PATH = path.join(DATA_ROOT, 'applied-version.json');
const BACKUPS_PATH = path.join(DATA_ROOT, 'backups');

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

  for (const subdir of [backupCustom, backupAppstore]) {
    let stat = null;
    try {
      stat = fs.lstatSync(subdir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Backup is corrupted (${path.basename(subdir)} is not a plain folder): ${backupPath}`);
    }
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
      ...metadata,
      name: entry.name,
      path: backupPath
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

function describeBackup(backup) {
  return `${backup.name} - v${backup.version} (${new Date(backup.timestamp).toISOString()})`;
}

function main(args) {
  const command = args[0];

  switch (command) {
    case 'list': {
      const backups = listBackups();
      if (backups.length === 0) {
        console.log('No backups available');
      } else {
        console.log('Available backups:');
        for (const backup of backups) {
          console.log(`  ${describeBackup(backup)}`);
        }
      }
      return 0;
    }

    case 'create': {
      const description = args.slice(1).join(' ') || 'Manual snapshot';
      createSnapshot(description);
      return 0;
    }

    case 'rollback': {
      const backupName = args[1];
      let chosen;
      if (backupName === undefined) {
        chosen = getLatestBackup();
        if (!chosen) {
          console.error('No backups available for rollback');
          return 1;
        }
      } else {
        if (backupName.trim() === '') {
          console.error(`Refused: '${backupName}' is not a backup name (see: node rollback.js list)`);
          return 2;
        }
        chosen = listBackups().find(backup => backup.name === backupName);
        if (!chosen) {
          console.error(`Backup not found: ${backupName} (see: node rollback.js list)`);
          return 1;
        }
      }
      console.log(`[Rollback] Chosen backup: ${describeBackup(chosen)}`);
      try {
        performRollback(chosen);
      } catch (error) {
        console.error(`[Rollback] Refused: ${error.message}`);
        return 1;
      }
      return 0;
    }

    case 'cleanup': {
      const confirmed = args.includes('--yes');
      const keepText = args.slice(1).find(arg => arg !== '--yes');
      let keepCount = 5;
      if (keepText !== undefined) {
        if (!/^\d+$/.test(keepText) || Number(keepText) < 1) {
          console.error(`Refused: '${keepText}' is not a whole number of at least 1`);
          return 2;
        }
        keepCount = Number(keepText);
      }
      const toDelete = listBackups().slice(keepCount);
      if (toDelete.length === 0) {
        console.log(`Nothing to remove: ${keepCount} or fewer backups exist`);
        return 0;
      }
      console.log(`Keeping the newest ${keepCount}; these backups ${confirmed ? 'will be' : 'would be'} removed:`);
      for (const backup of toDelete) {
        console.log(`  ${describeBackup(backup)}`);
      }
      if (!confirmed) {
        console.log('Nothing removed. Run again with --yes to remove them.');
        return 0;
      }
      cleanupOldBackups(keepCount);
      return 0;
    }

    default:
      console.log('Usage: node rollback.js <command> [args]');
      console.log('Commands:');
      console.log('  list                   - List available backups');
      console.log('  create [desc]          - Create a new snapshot');
      console.log('  rollback [name]        - Rollback to backup (latest if no name)');
      console.log('  cleanup [keep] [--yes] - List old backups beyond the newest keep (default 5); --yes removes them');
      return 0;
  }
}

module.exports = {
  performRollback,
  listBackups,
  getLatestBackup,
  createSnapshot,
  cleanupOldBackups,
  main
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
