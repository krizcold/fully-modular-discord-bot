/**
 * Auto-snapshot helper. Called before bot-side mutations the user might want
 * to roll back (AppStore install/uninstall/update). Reads /app/custom and
 * /data/appstore-modules and writes them to /data/backups/backup-<ts>/.
 *
 * Auto-snapshots are marked `type: 'auto'` and rotated (keep newest 5).
 * Manual snapshots (type: 'manual') taken via the Web-UI backup button are
 * never auto-deleted - only the user's Delete button removes them.
 *
 * Errors are swallowed. The mutating operation must NEVER fail because the
 * safety-net snapshot couldn't be written.
 */

import * as fs from 'fs';
import * as path from 'path';

const CUSTOM_PATH = '/app/custom';
const APPSTORE_MODULES_PATH = '/data/appstore-modules';
const BACKUPS_PATH = '/data/backups';
const AUTO_DEBOUNCE_MS = 60_000;
const AUTO_RETENTION = 5;

interface BackupEntry {
  name: string;
  path: string;
  timestamp: number;
  type?: string;
}

function copyDirectory(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function listBackups(): BackupEntry[] {
  if (!fs.existsSync(BACKUPS_PATH)) return [];
  const entries: BackupEntry[] = [];
  for (const dirent of fs.readdirSync(BACKUPS_PATH, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    if (!dirent.name.startsWith('backup-')) continue;
    const dirPath = path.join(BACKUPS_PATH, dirent.name);
    const metaPath = path.join(dirPath, 'metadata.json');
    let timestamp = parseInt(dirent.name.replace('backup-', ''), 10) || 0;
    let type: string | undefined;
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        timestamp = typeof meta.timestamp === 'number' ? meta.timestamp : timestamp;
        type = meta.type;
      } catch {
        // use defaults
      }
    }
    entries.push({ name: dirent.name, path: dirPath, timestamp, type });
  }
  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries;
}

function rotateAutoSnapshots(): void {
  const autos = listBackups().filter(b => b.type === 'auto');
  for (const stale of autos.slice(AUTO_RETENTION)) {
    try {
      fs.rmSync(stale.path, { recursive: true, force: true });
      console.log(`[AutoSnapshot] Rotated out ${stale.name}`);
    } catch {
      // best-effort
    }
  }
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync('/app/package.json', 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Take an auto-snapshot before a mutation. Debounced (skips if a recent auto
 * snapshot exists). Returns silently on failure - the caller's operation
 * must not fail because the safety net couldn't be set up.
 */
export function takeAutoSnapshot(operation: string): void {
  try {
    const now = Date.now();
    const recent = listBackups().find(b => b.type === 'auto' && now - b.timestamp < AUTO_DEBOUNCE_MS);
    if (recent) {
      console.log(`[AutoSnapshot] Skipping for "${operation}" - recent auto snapshot at ${new Date(recent.timestamp).toISOString()}`);
      return;
    }

    const timestamp = now;
    const backupName = `backup-${timestamp}`;
    const backupPath = path.join(BACKUPS_PATH, backupName);
    fs.mkdirSync(BACKUPS_PATH, { recursive: true });
    fs.mkdirSync(backupPath, { recursive: true });

    if (fs.existsSync(CUSTOM_PATH)) {
      copyDirectory(CUSTOM_PATH, path.join(backupPath, 'custom'));
    }
    if (fs.existsSync(APPSTORE_MODULES_PATH)) {
      copyDirectory(APPSTORE_MODULES_PATH, path.join(backupPath, 'appstore-modules'));
    }

    fs.writeFileSync(
      path.join(backupPath, 'metadata.json'),
      JSON.stringify({
        timestamp,
        version: readPackageVersion(),
        description: `Auto-snapshot before ${operation}`,
        type: 'auto'
      }, null, 2)
    );

    console.log(`[AutoSnapshot] Created ${backupName} (before ${operation})`);

    rotateAutoSnapshots();
  } catch (err) {
    console.error('[AutoSnapshot] Failed to create snapshot (continuing anyway):', err);
  }
}
