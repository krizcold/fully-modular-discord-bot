// Sync scope definitions shared by master (serve + hash) and co-worker
// (diff + apply). Scopes byte-mirror master-authoritative files; guild data,
// /data/.env, modulesDev and /data/global/fleet/** are never synced (the
// fleet dir holds node identity - syncing it would collide nodeIds at
// register).

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { DATA_ROOT, dataPath } from '../../../utils/dataRoot';
import { getSourceModulesDir } from '../utils/pathHelpers';
import { FLEET_DIR, SYNC_MAX_FILE_BYTES } from './constants';
import { getAppVersion } from './nodeIdentity';
import type { SyncFileEntry, SyncFileScope, SyncManifest, SyncModuleEntry } from './protocol';

const SETTINGS_FILENAME = 'settings.json';
const METRICS_DIRNAME = 'metrics';

/**
 * A module name must be a single, non-traversing path segment. The worker
 * reuses this before a master-supplied name ever touches an fs path (a
 * malicious master could otherwise push '..' to escape the module root).
 */
export function isValidModuleName(name: unknown): name is string {
  return typeof name === 'string'
    && name.length > 0
    && name === path.basename(name)
    && name !== '.'
    && name !== '..'
    && !path.isAbsolute(name);
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** File-set hash: sha256 over sorted (relPath, sha256(bytes)) pairs. */
export function hashFileSet(files: SyncFileEntry[]): string {
  const hash = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${f.path}\0${f.sha256}\n`);
  }
  return hash.digest('hex');
}

function toRelPosix(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function walkFiles(dir: string, out: string[], skipDir?: (rel: string) => boolean, root?: string): void {
  const base = root ?? dir;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const rel = toRelPosix(base, full);
      if (skipDir && skipDir(rel)) continue;
      walkFiles(full, out, skipDir, base);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

export function scopeRoot(scope: SyncFileScope): string {
  switch (scope) {
    case 'appstore': return dataPath('global', 'appstore');
    case 'config': return DATA_ROOT;
    case 'settings': return dataPath('global');
    case 'globaldata': return dataPath('global');
  }
}

function scopeRelFiles(scope: SyncFileScope): string[] {
  const root = scopeRoot(scope);
  switch (scope) {
    case 'config': {
      return fs.existsSync(dataPath('config.json')) ? ['config.json'] : [];
    }
    case 'appstore': {
      const files: string[] = [];
      walkFiles(root, files, rel => rel === 'cache' || rel.startsWith('cache/'));
      return files.map(f => toRelPosix(root, f));
    }
    case 'settings': {
      const rels: string[] = [];
      let dirs: fs.Dirent[] = [];
      try {
        dirs = fs.readdirSync(root, { withFileTypes: true });
      } catch { /* no global dir yet */ }
      for (const dir of dirs) {
        if (!dir.isDirectory() || dir.name === FLEET_DIR || dir.name === 'appstore') continue;
        if (fs.existsSync(path.join(root, dir.name, SETTINGS_FILENAME))) {
          rels.push(`${dir.name}/${SETTINGS_FILENAME}`);
        }
      }
      return rels;
    }
    case 'globaldata': {
      const files: string[] = [];
      walkFiles(root, files, rel =>
        rel === FLEET_DIR || rel.startsWith(`${FLEET_DIR}/`)
        || rel === 'appstore' || rel.startsWith('appstore/')
        || rel === METRICS_DIRNAME || rel.startsWith(`${METRICS_DIRNAME}/`));
      return files
        .map(f => toRelPosix(root, f))
        .filter(rel => !/^[^/]+\/settings\.json$/.test(rel))
        .filter(rel => !rel.endsWith('.audit.jsonl'));
    }
  }
}

/**
 * Whether a scope-relative path belongs to the scope (exclusions applied).
 * The worker checks master listings against this so an excluded namespace
 * (fleet/** node identity above all) can never be written by sync.
 */
export function isPathInScope(scope: SyncFileScope, rel: string): boolean {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('..') || rel.startsWith('/')) return false;
  // A backslash is a path separator on Windows co-workers, where the FS is
  // also case-insensitive: comparing raw would let 'fleet\x' or 'FLEET/x'
  // slip past the fleet/appstore/metrics/settings exclusions and resolve into
  // the NEVER-synced tree. Reject backslashes outright and fold case so the
  // namespace guards hold identically on both roles.
  if (rel.includes('\\')) return false;
  const low = rel.toLowerCase();
  switch (scope) {
    case 'config':
      return low === 'config.json';
    case 'appstore':
      return low !== 'cache' && !low.startsWith('cache/');
    case 'settings':
      return /^[^/]+\/settings\.json$/.test(low)
        && !low.startsWith(`${FLEET_DIR}/`) && !low.startsWith('appstore/');
    case 'globaldata':
      if (low === FLEET_DIR || low.startsWith(`${FLEET_DIR}/`)) return false;
      if (low === 'appstore' || low.startsWith('appstore/')) return false;
      if (low === METRICS_DIRNAME || low.startsWith(`${METRICS_DIRNAME}/`)) return false;
      if (/^[^/]+\/settings\.json$/.test(low)) return false;
      if (low.endsWith('.audit.jsonl')) return false;
      return true;
  }
}

/** Scope-relative listing with sizes and per-file sha256. */
export function listScopeFiles(scope: SyncFileScope): SyncFileEntry[] {
  const root = scopeRoot(scope);
  const entries: SyncFileEntry[] = [];
  for (const rel of scopeRelFiles(scope)) {
    // Single source of truth: hash, listing (SYNC_FILES) and the worker's fetch
    // filter/verify must agree, or a name the case-folded isPathInScope rejects
    // (a case variant of a reserved namespace) is hashed-in yet never fetched,
    // deadlocking the boot gate. Filtering here keeps every site symmetric.
    if (!isPathInScope(scope, rel)) continue;
    const full = path.join(root, ...rel.split('/'));
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      entries.push({ path: rel, size: stat.size, sha256: sha256File(full) });
    } catch { /* raced deletion; the next reconcile pass converges */ }
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Traversal-guarded absolute path for a scope-relative file. Throws when the
 * resolved path escapes the scope root (or the module dir for scope 'module').
 */
export function resolveScopeFile(scope: 'module' | SyncFileScope, relPath: string, moduleName?: string): string {
  let root: string;
  if (scope === 'module') {
    if (!isValidModuleName(moduleName)) {
      throw new Error(`invalid module name: ${moduleName}`);
    }
    root = path.join(getSourceModulesDir(), moduleName);
  } else {
    root = scopeRoot(scope);
  }
  if (typeof relPath !== 'string' || relPath.length === 0 || path.isAbsolute(relPath)) {
    throw new Error(`invalid sync path: ${relPath}`);
  }
  const resolved = path.resolve(root, relPath);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`sync path escapes scope root: ${relPath}`);
  }
  return resolved;
}

export function listModuleDirs(): string[] {
  const dir = getSourceModulesDir();
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.endsWith('.sync-old'))
      .map(d => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** File-set (relPath + size + sha256) of an arbitrary dir; empty when absent. */
export function listDirFileSet(rootDir: string): SyncFileEntry[] {
  const files: string[] = [];
  walkFiles(rootDir, files);
  return files
    .map(f => ({ path: toRelPosix(rootDir, f), size: fs.statSync(f).size, sha256: sha256File(f) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function listModuleFiles(moduleName: string): SyncFileEntry[] {
  return listDirFileSet(path.join(getSourceModulesDir(), moduleName));
}

export function moduleContentHash(moduleName: string): string {
  return hashFileSet(listModuleFiles(moduleName));
}

function readJsonSafe(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export function buildModuleEntries(): SyncModuleEntry[] {
  const installed = readJsonSafe(dataPath('global', 'appstore', 'installed.json'));
  return listModuleDirs().map(name => {
    const manifest = readJsonSafe(path.join(getSourceModulesDir(), name, 'module.json'));
    const record = installed?.modules?.[name];
    return {
      name,
      version: String(manifest?.version ?? record?.version ?? '0.0.0'),
      commit: typeof record?.commitHash === 'string' ? record.commitHash : undefined,
      contentHash: moduleContentHash(name),
      enabled: manifest?.enabled !== false,
    };
  });
}

export interface SyncScopeHashes {
  appstoreHash: string;
  configHash: string;
  settingsHash: string;
  globalDataHash: string;
}

export function computeScopeHashes(): SyncScopeHashes {
  return {
    appstoreHash: hashFileSet(listScopeFiles('appstore')),
    configHash: hashFileSet(listScopeFiles('config')),
    settingsHash: hashFileSet(listScopeFiles('settings')),
    globalDataHash: hashFileSet(listScopeFiles('globaldata')),
  };
}

export function buildSyncManifest(revision: number): SyncManifest {
  const hashes = computeScopeHashes();
  return {
    revision,
    appVersion: getAppVersion(),
    modules: buildModuleEntries(),
    ...hashes,
  };
}

export function manifestHashesEqual(a: SyncManifest, b: SyncManifest): boolean {
  if (a.appstoreHash !== b.appstoreHash) return false;
  if (a.configHash !== b.configHash) return false;
  if (a.settingsHash !== b.settingsHash) return false;
  if (a.globalDataHash !== b.globalDataHash) return false;
  if (a.modules.length !== b.modules.length) return false;
  const byName = new Map(b.modules.map(m => [m.name, m]));
  return a.modules.every(m => byName.get(m.name)?.contentHash === m.contentHash);
}

export function assertSyncableSize(file: string, size: number): void {
  if (size > SYNC_MAX_FILE_BYTES) {
    throw new Error(`file exceeds sync size cap (${size} > ${SYNC_MAX_FILE_BYTES} bytes): ${file}`);
  }
}
