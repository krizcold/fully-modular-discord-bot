/**
 * App Store Manager
 *
 * Manages App Store repositories, module discovery, installation, and credentials.
 * Repositories are GitHub repos containing modules in a Modules/ folder.
 * No index file needed - modules are discovered by scanning for module.json files.
 *
 * Config files:
 * - /data/global/appstore/repos.json - Repository configuration
 * - /data/global/appstore/installed.json - Installed modules tracking
 * - /data/global/appstore/credentials/{moduleName}.json - Module API credentials
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { ModuleManifest } from '../../types/moduleTypes';
import { ensureDir, getModulesDir, getSourceModulesDir, getBuildModulesDir, getModulesDevDir } from './pathHelpers';
import { dataPath } from '../../../utils/dataRoot';
import { takeAutoSnapshot } from '@/utils/autoSnapshot';
import { ProcessLock, processStart } from './processLock';
import { deleteRawAtomicTracked, writeRawAtomicTracked } from './dataManager';
import { truthText, type TruthAnswer } from './dataBackends/replyGate';
import { getNodeName } from '../fleet/nodeName';
import {
  awaitStoreTicket, landStoreDoc, latestRowTicket, rowMainTag, rowOutcome, rowsOnDataPool, sharedKeyOf, shaOf, STORE_MUTEX_MS, updatedBy,
  rowBackend, useStoreLanding, type RowRefusal, type RowTicket,
} from './sharedStore';
import { readStoreRecord } from './sharedRecords';
import { credentialsKeyOf, INSTALLED_KEY, moduleRelRefusal, publishModule, unpublishModule, type ModuleSaveAnswer } from './sharedModules';
import type { ApplyLater, PublisherAnswer } from './moduleApply';
import { FolderSyncError, logFolderSyncError, logSyncLine, syncFolderChainSync, syncFolderSync, syncStepError, writeErrorText } from './folderChain';

/**
 * Find a Dev module whose manifest name matches. Installing a store module
 * over a same-name Dev module would silently shadow the Dev copy (the loader
 * resolves names against modules/ first), so installs must reject the clash.
 */
function findDevModuleWithName(moduleName: string): boolean {
  const modulesDevDir = getModulesDevDir();
  if (!fs.existsSync(modulesDevDir)) return false;
  try {
    const repos = fs.readdirSync(modulesDevDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('.'))
      .map(dirent => dirent.name);
    for (const repoName of repos) {
      const repoModulesDir = path.join(modulesDevDir, repoName, 'Modules');
      if (!fs.existsSync(repoModulesDir)) continue;
      const devModules = fs.readdirSync(repoModulesDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory() && !dirent.name.endsWith('.disabled'))
        .map(dirent => dirent.name);
      for (const devModule of devModules) {
        const manifestPath = path.join(repoModulesDir, devModule, 'module.json');
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          if (manifest?.name === moduleName) return true;
        } catch { /* unreadable manifest; skip */ }
      }
    }
  } catch (error) {
    console.error('[AppStoreManager] Error scanning modulesDev for name conflicts:', error);
  }
  return false;
}

// ============================================================================
// TYPES
// ============================================================================

/** App Store repository configuration */
export interface AppStoreRepository {
  /** Unique repository ID */
  id: string;

  /** Human-readable repository name */
  name: string;

  /** GitHub repository URL */
  url: string;

  /** Branch to use (default: main) */
  branch: string;

  /** GitHub personal access token for private repos (optional) */
  githubToken?: string | null;

  /** Whether this repository is enabled */
  enabled: boolean;

  /** Last time modules were refreshed from this repo */
  lastRefreshed: string | null;
}

/** Repository configuration file */
export interface ReposConfig {
  repositories: AppStoreRepository[];
}

/** Information about a module available in the store */
export interface StoreModuleInfo {
  /** Module manifest */
  manifest: ModuleManifest;

  /** Repository ID this module is from */
  repoId: string;

  /** Repository name */
  repoName: string;

  /** Path within repository */
  repoPath: string;

  /** Whether this module is already installed */
  installed: boolean;

  /** Installed version (if installed) */
  installedVersion?: string;
}

/** Installed module tracking */
export interface InstalledModule {
  /** Module name */
  name: string;

  /** Installed version */
  version: string;

  /** Repository ID it was installed from */
  installedFrom: string;

  /** Installation timestamp */
  installedAt: string;

  /** Repo HEAD commit hash at time of install/update */
  commitHash?: string;
}

/** Installed modules tracking file */
export interface InstalledConfig {
  modules: Record<string, InstalledModule>;
}

/** Result of checking a single module for updates */
export interface ModuleUpdateCheck {
  moduleName: string;
  installedVersion: string;
  availableVersion: string;
  installedCommit?: string;
  availableCommit?: string;
  hasUpdate: boolean;
  repoId: string;
  repoName: string;
}

/** Result of checking all modules for updates */
export interface ModuleUpdatesResult {
  /** Whether the check operation completed (true even with partial errors) */
  success: boolean;
  /** Number of modules successfully checked */
  checked: number;
  /** Number of modules with available updates */
  updatesAvailable: number;
  /** Update info for each checked module */
  updates: ModuleUpdateCheck[];
  /** Errors encountered during checking */
  errors: Array<{ moduleName: string; error: string }>;
  /** Whether any errors occurred (for easy checking) */
  hasErrors: boolean;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const APPSTORE_DIR = dataPath('global', 'appstore');
const REPOS_CONFIG_PATH = path.join(APPSTORE_DIR, 'repos.json');
const INSTALLED_CONFIG_PATH = path.join(APPSTORE_DIR, 'installed.json');
const CREDENTIALS_DIR = path.join(APPSTORE_DIR, 'credentials');
const CACHE_DIR = path.join(APPSTORE_DIR, 'cache');

const DEFAULT_REPOS_CONFIG: ReposConfig = {
  repositories: [
    {
      id: 'official-modules',
      name: 'Official Module Store',
      url: 'https://github.com/krizcold/discord-bot-modules',
      branch: 'main',
      githubToken: null,
      enabled: true,
      lastRefreshed: null
    }
  ]
};

const DEFAULT_INSTALLED_CONFIG: InstalledConfig = {
  modules: {}
};

// The web UI process and the bot child each hold an AppStoreManager over the same
// files. Every write re-reads the file under this lock and changes only its own
// record.
const LOCK_PATH = path.join(CACHE_DIR, '.store.lock');
const TAKEOVER_PATH = `${LOCK_PATH}.takeover`;
const UNREADABLE_DIR = path.join(CACHE_DIR, 'unreadable');
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 50;
const LOCK_UNREADABLE_STALE_MS = 10_000;
const TAKEOVER_STALE_MS = 5_000;
const GIT_TIMEOUT_MS = 45_000;

type FileState = 'read' | 'missing' | 'unreadable';

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Identifies one run of a process, so a pid reused after a restart is not taken for the old holder. */
export const storeLockHolder = processStart;

const storeLock = new ProcessLock({
  lockPath: LOCK_PATH,
  takeoverPath: TAKEOVER_PATH,
  unparsableStaleMs: LOCK_UNREADABLE_STALE_MS,
  takeoverStaleMs: TAKEOVER_STALE_MS,
});

function lockBusyError(): Error {
  return new Error('Another App Store change is still running, so nothing was changed. Try again in a minute.');
}

function tryAcquireStoreLock(): boolean {
  if (storeLock.depth === 0) ensureDir(CACHE_DIR);
  const taken = storeLock.tryTake();
  if (taken.kind === 'unwritable') throw taken.error;
  return taken.kind === 'taken';
}

/** For synchronous callers only; it blocks the event loop while it waits. */
function acquireStoreLock(): void {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!tryAcquireStoreLock()) {
    if (Date.now() >= deadline) throw lockBusyError();
    sleepSync(LOCK_POLL_MS);
  }
}

/** Waits without blocking the event loop; the caller tries the lock again right after it resolves. */
async function waitBeforeLockRetry(deadline: number): Promise<void> {
  if (Date.now() >= deadline) throw lockBusyError();
  await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS));
}

function releaseStoreLock(): void {
  storeLock.release();
}

/** Runs a synchronous section under the store lock: decision 53's landing block, a config file's read and queue. */
export function withStoreLock<T>(fn: () => T): T {
  acquireStoreLock();
  try {
    return fn();
  } finally {
    releaseStoreLock();
  }
}

// ============================================================================
// THE STORE MUTEX (NB6 decisions 36 and 61)
// ============================================================================

/** A hold of the store mutex; release hands it to the next waiter. */
export interface StoreMutexHold {
  release(): void;
}

/**
 * In-process, first in first out. Every App Store section that awaits on a Postgres bot holds it; inside it each
 * synchronous part takes the store lock and releases it before the next await.
 */
class StoreMutex {
  private held = false;
  private readonly waiters: Array<(hold: StoreMutexHold) => void> = [];

  /** A hold, or null when the wait passed boundMs (the caller is out of the line then). */
  acquire(boundMs: number = STORE_MUTEX_MS): Promise<StoreMutexHold | null> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve(this.hold());
    }
    return new Promise(resolve => {
      const grant = (hold: StoreMutexHold) => {
        clearTimeout(timer);
        resolve(hold);
      };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(grant);
        if (at >= 0) this.waiters.splice(at, 1);
        resolve(null);
      }, boundMs);
      timer.unref?.();
      this.waiters.push(grant);
    });
  }

  private hold(): StoreMutexHold {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const next = this.waiters.shift();
        if (next) next(this.hold());
        else this.held = false;
      },
    };
  }
}

export const storeMutex = new StoreMutex();

/** The store mutex for an App Store section: a wait over 60 s answers lockBusyError's text. */
export async function takeStoreMutex(): Promise<StoreMutexHold> {
  const hold = await storeMutex.acquire();
  if (!hold) throw lockBusyError();
  return hold;
}

useStoreLanding({ acquire: boundMs => storeMutex.acquire(boundMs), locked: withStoreLock });

// ============================================================================
// THE APP STORE DOCS ON A POSTGRES BOT (NB6 decisions 28, 51 and 53)
// ============================================================================

/** Decision 28: how long a section waits for its write's ticket, past the web UI session's 35 s query_timeout. */
export const STORE_TICKET_MS = 40_000;

/** An App Store doc's answer other than today's success: 409, 500, or 202 when the database has not answered yet. */
export class StoreWriteError extends Error {
  /** by: for a 409, the machine that stored the version this change met. */
  constructor(readonly status: 202 | 409 | 500, message: string, readonly by?: string) {
    super(message);
    this.name = 'StoreWriteError';
  }
}

/** The file's path below /data/global/appstore/, as the answers and logs name it. */
export function storeFileName(file: string): string {
  return path.relative(APPSTORE_DIR, file).split(path.sep).join('/');
}

/** On a Postgres bot the App Store docs are shared keys (decision 28); a JSON bot writes them as files. */
export function isSharedStoreDoc(file: string): boolean {
  return sharedKeyOf(file) !== null;
}

/** The sha of a file's bytes, 'absent' for none; a file that cannot be read refuses the write (StoreWriteError 500). */
export function storeFileSha(file: string): string {
  try {
    return shaOf(fs.readFileSync(file));
  } catch (error: any) {
    if (error?.code === 'ENOENT') return 'absent';
    throw new StoreWriteError(500, `${storeFileName(file)} could not be read (${error instanceof Error ? error.message : String(error)}), so nothing was saved.`);
  }
}

/** A write queued with its ticket, or refused at the accept with the cause. */
export type StoreQueued = { file: string; ticket: RowTicket } | { file: string; refused: string };

/**
 * Decision 28: queues the shared write of an App Store doc (null deletes it) with the sha of the bytes its section read
 * as base, so it is its own op (decision 51). Null when a delete has nothing to delete.
 */
export function queueStoreDoc(file: string, text: string | null, base: string): StoreQueued | null {
  if (text === null) {
    const deleted = deleteRawAtomicTracked(file, { baseSha: base });
    if (!deleted.accepted) return deleted.cause === 'absent' ? null : { file, refused: deleted.cause ?? 'io' };
  } else {
    const written = writeRawAtomicTracked(file, text, { baseSha: base });
    if (!written.accepted) return { file, refused: written.cause };
  }
  return { file, ticket: latestRowTicket(sharedKeyOf(file)!)! };
}

/** T15 and decision 28's line: a store write no reply waits for logs its refusal. */
export function watchStoreDoc(queued: StoreQueued): void {
  const name = storeFileName(queued.file);
  if ('refused' in queued) {
    console.error(`[AppStoreManager] ${name} was not saved: ${queued.refused}`);
    return;
  }
  void rowOutcome(queued.ticket).then(outcome => {
    if (typeof outcome !== 'object') return;
    console.error(`[AppStoreManager] ${name} was not saved: ${refusalWords(outcome.refused)}`);
  });
}

function refusalWords(refusal: RowRefusal): string {
  if (refusal.cause !== 'changed-elsewhere') return refusal.reason ?? refusal.cause;
  if (refusal.by === undefined || refusal.at === undefined) return 'it changed after this write read it';
  const by = refusal.by === getNodeName() ? 'this machine' : refusal.by;
  return `it changed after this write read it (saved by ${by} at ${refusal.at.toISOString()})`;
}

/**
 * Decision 28's answers for a section that holds the store mutex: waits up to 40 s for the ticket (decision 53's block
 * runs in this hold) and resolves when it landed; otherwise throws StoreWriteError with the 409, 500 or 202 text.
 * what names the change in the 202 text, name the file in the 409 text.
 */
export async function awaitStoreDoc(queued: StoreQueued, what: string, boundMs: number = STORE_TICKET_MS, name: string = storeFileName(queued.file)): Promise<void> {
  if ('refused' in queued) throw new StoreWriteError(500, truthText(queued.refused as TruthAnswer, false));
  const outcome = await awaitStoreTicket(queued.ticket, boundMs);
  if (outcome === 'landed') return;
  if (outcome === 'open' || outcome === 'unconfirmed') {
    const op = queued.ticket.op;
    const cause = op.lostCause ?? op.cause ?? `no answer within ${Math.round(boundMs / 1000)} s`;
    throw new StoreWriteError(202, `Can't confirm that the ${what} change was saved: the database has not answered yet (${cause}). Reload the App Store tab in a minute to see whether it was.`);
  }
  const refusal = outcome.refused;
  if (refusal.cause !== 'changed-elsewhere') throw new StoreWriteError(500, truthText(refusal.cause, false));
  if (refusal.by === undefined || refusal.at === undefined) throw new StoreWriteError(409, truthText('changed-elsewhere', false, 'deleted'));
  throw new StoreWriteError(409, `${name} was changed on ${refusal.by} at ${refusal.at.toISOString()} while this change was being made; nothing was saved. Reload the App Store tab to see the current values.`, refusal.by);
}

// ============================================================================
// MODULES ON A POSTGRES BOT (NB6 decisions 15, 35, 42, 44 and 61)
// ============================================================================

/**
 * updateModule's answer. On a Postgres bot a stored update carries `published`, and in the bot `applied` (44, 91);
 * `unconfirmed` marks 35's can't confirm text, and `changedElsewhere` a refusal because installed.json changed on another
 * machine (409).
 */
export interface ModuleUpdateResult {
  success: boolean;
  newVersion?: string;
  error?: string;
  unconfirmed?: true;
  changedElsewhere?: true;
  /** With changedElsewhere: whether the module's own entry changed, was removed or only other modules' did, or the read's error. */
  elsewhere?: ElsewhereChange;
  published?: PublishedChange;
  applied?: PublisherAnswer;
  /** The new version is in place, but the list of installed modules can't be confirmed as saved (T9). */
  listUnconfirmed?: string;
}

/** T9: the module's change is in place, but installed.json's folder chain failed. */
function listUnconfirmedText(moduleName: string, done: 'installed' | 'uninstalled' | 'updated', error: FolderSyncError, backupDir?: string): string {
  return `Module ${moduleName} is ${done}, but the list of installed modules can't be confirmed as saved: ${error.message}${backupDir ? ` Its backup is kept at ${backupDir}.` : ''}`;
}

/** T11 as the message of the same FolderSyncError, so every catch still sees a FolderSyncError. */
function repoListUnconfirmed(error: FolderSyncError, name: string, done: 'added' | 'updated' | 'removed'): FolderSyncError {
  error.message = `Repository ${name} is ${done}, but the repository list can't be confirmed as saved: ${error.message}`;
  return error;
}

/** by: the machine that stored the version the refused update met, null when the refusal does not name one. */
export type ElsewhereChange = ({ kind: 'module' | 'other' | 'removed' } | { kind: 'unread'; error: string }) & { by: string | null };

const STORED_DOC_SQL = 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1';
const STORED_MODULES_SQL = 'SELECT module, sha, version, updated_by FROM smdb_data.shared_modules';

/** After a changed-elsewhere refusal: whether the stored installed.json entry or module row of moduleName differs from the update's start. */
async function elsewhereChange(moduleName: string, started: { version: string; sha: string | null }, by: string | null): Promise<ElsewhereChange> {
  try {
    const backend = rowBackend();
    if (!backend?.sharedSelect) return { kind: 'unread', error: 'no database', by };
    const doc = (await backend.sharedSelect(STORED_DOC_SQL, [INSTALLED_KEY], 10_000)).rows[0];
    const body = doc ? (Buffer.isBuffer(doc.body) ? doc.body.toString('utf8') : String(doc.body ?? '')) : '{"modules":{}}';
    const entry = JSON.parse(body)?.modules?.[moduleName];
    if (!entry) return { kind: 'removed', by };
    if (entry.version !== started.version) return { kind: 'module', by };
    if (started.sha !== null) {
      const row = (await backend.sharedSelect(STORED_MODULES_SQL, [], 10_000)).rows.find((r: any) => r.module === moduleName);
      if (!row || String(row.sha) !== started.sha) return { kind: 'module', by };
    }
    return { kind: 'other', by };
  } catch (error) {
    return { kind: 'unread', error: error instanceof Error ? error.message : String(error), by };
  }
}

const MIB = 1024 * 1024;
/** Decision 15's limits on a bot whose data is in a database. */
export const MODULE_MAX_BYTES = 64 * MIB;
export const MODULE_FILE_MAX_BYTES = 16 * MIB;

type ModuleOperation = 'install' | 'update' | 'uninstall';

const pastOf = (operation: ModuleOperation): string => (operation === 'install' ? 'installed' : operation === 'update' ? 'updated' : 'uninstalled');

/** Staged folders a publish of this process holds; the pass never deletes one of them (decision 35). */
const stagedFolders = new Set<string>();

export function stagedHeld(): ReadonlySet<string> {
  return stagedFolders;
}

/** A change whose publish or uninstall the database stored. */
export interface PublishedChange {
  module: string;
  operation: ModuleOperation;
  version: string | null;
  /** The module sha the rows hold now; 'absent' after an uninstall. */
  to: string;
  /** The main tag the change was stored under, the apply's `tag`. */
  tag: string | null;
  updatedBy: string;
  /** In the web UI, the staged folder its caller hands to the bot's `module:apply` (44); null in the bot. */
  staged: string | null;
  /** In the bot, the apply's outcome and the answer for it (61); null in the web UI, which applies through the bot. */
  applied: PublisherAnswer | null;
}

interface Staged {
  dir: string;
  version: string;
  body: string;
  base: string;
  moduleInfo: StoreModuleInfo;
}

const mib = (bytes: number): string => `${(Math.ceil((bytes / MIB) * 10) / 10).toFixed(1)} MiB`;

/** Decision 15's limits as 42 words them, over the files copyDirectory would copy. */
function sizeRefusal(module: string, dir: string, operation: ModuleOperation): string | null {
  let total = 0;
  let largest = { rel: '', size: -1 };
  const walk = (at: string, rel: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const abs = path.join(at, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, r);
        continue;
      }
      const size = fs.statSync(abs).size;
      total += size;
      if (size > largest.size) largest = { rel: r, size };
    }
  };
  walk(dir, '');
  const done = pastOf(operation);
  if (total > MODULE_MAX_BYTES) return `${module} is ${mib(total)}, over the 64 MiB a module can have on a bot whose data is in a database; it was not ${done}`;
  if (largest.size > MODULE_FILE_MAX_BYTES) {
    return `${module} has a file over 16 MiB (${largest.rel}, ${mib(largest.size)}), which a bot whose data is in a database cannot keep; it was not ${done}`;
  }
  return null;
}

/** The first file of the folder whose path the migration's rule refuses, so a stored module can always be moved. */
function filePathRefusal(module: string, dir: string, operation: ModuleOperation): string | null {
  const walk = (at: string, rel: string): string | null => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const inner = walk(path.join(at, entry.name), r);
        if (inner) return inner;
        continue;
      }
      const cause = moduleRelRefusal(r);
      if (cause) return `${module} was not ${pastOf(operation)}: its file ${r} cannot be stored for every machine (${cause}), so nothing was changed.`;
    }
    return null;
  };
  return walk(dir, '');
}

/** Decision 35 step 2: the staged files on disk before their sha is taken. */
function fsyncTree(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      fsyncTree(abs);
      continue;
    }
    const fd = fs.openSync(abs, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  const synced = syncFolderSync(dir);
  if (synced.failed) throw syncStepError(synced);
}

function dropStaged(dir: string): void {
  stagedFolders.delete(path.resolve(dir));
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Decision 42's texts for a publish or an uninstall that stored nothing, and 35's and T10's when that is unknown. */
function notStored(operation: ModuleOperation, module: string, answer: Exclude<ModuleSaveAnswer, { kind: 'committed' }>): StoreWriteError {
  const done = pastOf(operation);
  switch (answer.kind) {
    case 'refused':
      if (answer.cause === 'writer-lost') return new StoreWriteError(500, `${module} was not ${done}: another process took over the bot's data files`);
      if (answer.by === undefined || answer.at === undefined) return new StoreWriteError(409, truthText('changed-elsewhere', false, 'deleted'));
      return new StoreWriteError(409, `${module} was not ${done}: the list of installed modules was changed on ${answer.by} at ${answer.at.toISOString()} while this ran. Try again.`, answer.by);
    case 'failed':
      return new StoreWriteError(500, `${module} was not ${done}: ${answer.cause}`);
    case 'unknown':
      return new StoreWriteError(202, `Can't confirm whether ${module} was ${done}: the database did not answer the save (${answer.cause}). The App Store tab shows the result once it does.`);
  }
}

/** A stored change whose landing or apply threw here: the database holds it, and a later pass applies it (E1). */
function notAppliedYet(operation: ModuleOperation, module: string, version: string, error: unknown, later: ApplyLater): PublisherAnswer {
  const cause = error instanceof Error ? error.message : String(error);
  let text: string;
  if (operation === 'uninstall') {
    const when = later.kind === 'start' ? "it removes it after the bot's next start" : 'it tries again at the next pass';
    text = `${module} is uninstalled for every machine, but this machine could not remove it yet (${cause}); ${when}.`;
  } else {
    const when = later.kind === 'start'
      ? `it applies the database's current version of ${module} after the bot's next start`
      : later.kind === 'after' ? `it tries again after ${new Date(later.at).toISOString()}` : 'it tries again at the next pass';
    text = `${module} ${version} is saved for every machine, but this machine could not apply it yet (${cause}); ${when}.`;
  }
  return { outcome: 'deferred', reason: null, error: cause, loaded: false, text };
}

async function applyLaterHere(module: string): Promise<ApplyLater> {
  try {
    return (await import('./moduleApply')).applyLaterOf(module);
  } catch {
    return { kind: 'pass' };
  }
}

function fileStamp(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch (error: any) {
    return error?.code === 'ENOENT' ? 'missing' : 'error';
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeSync(fd, JSON.stringify(value, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (error) {
        if (attempt >= 3) throw error;
        sleepSync(25 * (attempt + 1));
      }
    }
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw error;
  }
  const chain = syncFolderChainSync(path.dirname(file));
  if (chain.failed) throw new FolderSyncError(file, chain);
}

function isReposConfig(value: any): value is ReposConfig {
  return !!value && typeof value === 'object' && Array.isArray(value.repositories)
    && value.repositories.every((r: any) => !!r && typeof r === 'object' && typeof r.id === 'string');
}

function isInstalledConfig(value: any): value is InstalledConfig {
  return !!value && typeof value === 'object' && !!value.modules
    && typeof value.modules === 'object' && !Array.isArray(value.modules);
}

/** sha: the sha of the bytes read (decision 28's base), 'absent' for a missing file, 'unreadable' when none were read. */
function readJsonStrict<T>(file: string, valid: (value: any) => value is T): { state: FileState; sha: string; value?: T; error?: string } {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { state: 'missing', sha: 'absent' };
    return { state: 'unreadable', sha: 'unreadable', error: error?.message ?? String(error) };
  }
  const sha = shaOf(bytes);
  try {
    const parsed = JSON.parse(bytes.toString('utf-8'));
    if (!valid(parsed)) return { state: 'unreadable', sha, error: 'unexpected shape' };
    return { state: 'read', sha, value: parsed };
  } catch (error: any) {
    return { state: 'unreadable', sha, error: error?.message ?? String(error) };
  }
}

function hashDirectory(dir: string): string | null {
  const hash = crypto.createHash('sha256');
  const walk = (current: string, rel: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, relPath);
      } else {
        hash.update(`${relPath}\0`);
        hash.update(fs.readFileSync(full));
        hash.update('\0');
      }
    }
  };
  try {
    walk(dir, '');
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function readManifestVersion(moduleDir: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(moduleDir, 'module.json'), 'utf-8'));
  if (typeof manifest?.version !== 'string' || !manifest.version) {
    throw new Error(`module.json in ${path.basename(moduleDir)} has no version`);
  }
  return manifest.version;
}

// ============================================================================
// VALIDATION HELPERS (prevent command injection)
// ============================================================================

/**
 * Validate a repository URL to prevent command injection.
 * Only allows HTTPS URLs from known git hosting providers.
 */
function validateRepoUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);

    // Must be HTTPS
    if (parsed.protocol !== 'https:') {
      return { valid: false, error: 'Repository URL must use HTTPS protocol' };
    }

    // Allowlist of known git hosting providers
    const allowedHosts = [
      'github.com',
      'gitlab.com',
      'bitbucket.org',
      'codeberg.org',
      'gitea.com',
      'sr.ht'
    ];

    const hostname = parsed.hostname.toLowerCase();
    const isAllowedHost = allowedHosts.some(host =>
      hostname === host || hostname.endsWith('.' + host)
    );

    if (!isAllowedHost) {
      return { valid: false, error: `Repository host '${hostname}' is not in the allowed list` };
    }

    // Path should not contain suspicious characters
    const suspiciousChars = /[;&|`$(){}[\]<>!]/;
    if (suspiciousChars.test(parsed.pathname)) {
      return { valid: false, error: 'Repository URL contains invalid characters' };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid repository URL format' };
  }
}

/**
 * Validate a branch name to prevent command injection.
 * Only allows safe characters in branch names.
 */
function validateBranchName(branch: string): { valid: boolean; error?: string } {
  // Branch names should only contain alphanumeric, hyphen, underscore, slash, dot
  // Must not start with - or contain ..
  const validBranchPattern = /^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$/;

  if (!branch || branch.length === 0) {
    return { valid: false, error: 'Branch name cannot be empty' };
  }

  if (branch.length > 255) {
    return { valid: false, error: 'Branch name too long' };
  }

  if (branch.includes('..')) {
    return { valid: false, error: 'Branch name cannot contain ".."' };
  }

  if (!validBranchPattern.test(branch)) {
    return { valid: false, error: 'Branch name contains invalid characters' };
  }

  return { valid: true };
}

/**
 * Validate repository configuration before git operations
 */
function validateRepoConfig(repo: AppStoreRepository): { valid: boolean; error?: string } {
  const urlValidation = validateRepoUrl(repo.url);
  if (!urlValidation.valid) {
    return urlValidation;
  }

  const branchValidation = validateBranchName(repo.branch);
  if (!branchValidation.valid) {
    return branchValidation;
  }

  return { valid: true };
}

// ============================================================================
// SINGLETON
// ============================================================================

let instance: AppStoreManager | null = null;

/**
 * App Store Manager - Manages repositories, modules, and credentials
 */
export class AppStoreManager {
  private reposConfig: ReposConfig;
  private installedConfig: InstalledConfig;
  private moduleCache: Map<string, StoreModuleInfo[]> = new Map();

  /** Tracks modules currently being updated to prevent concurrent updates */
  private updatesInProgress: Set<string> = new Set();

  private reposState: FileState = 'missing';
  private installedState: FileState = 'missing';
  private reposStamp = '';
  private installedStamp = '';
  /** The sha of the installed.json bytes last read: the base of a publish or an uninstall (decisions 15 and 35). */
  private installedSha = 'absent';
  /** True while this instance holds the store lock and read the file under it. */
  private reposFresh = false;
  private installedFresh = false;
  private asideStamps: Set<string> = new Set();
  /** The sha of the repos.json bytes last read: the base of its next shared write (decision 28). */
  private reposSha = 'absent';
  /** The shared write the last section queued, taken by the section that awaits or watches it. */
  private queued: StoreQueued | null = null;

  constructor() {
    this.reposConfig = structuredClone(DEFAULT_REPOS_CONFIG);
    this.installedConfig = structuredClone(DEFAULT_INSTALLED_CONFIG);
    this.load();
  }

  /**
   * Load configuration from disk. Only a missing file counts as empty; an
   * unreadable one is copied aside and blocks every write until it reads again.
   * On a Postgres bot the pass owns the module folders, so the reconcile does not run (decision 33).
   */
  load(): void {
    try {
      ensureDir(APPSTORE_DIR);
      ensureDir(CREDENTIALS_DIR);
      ensureDir(CACHE_DIR);
      this.readRepos();
      this.readInstalled();
      this.unawaited(() => this.locked(() => {
        this.readRepos();
        this.readInstalled();
        if (this.reposState === 'missing') {
          try {
            this.saveRepos();
          } catch (error) {
            if (!(error instanceof FolderSyncError)) throw error;
            logFolderSyncError('[AppStoreManager] The repos config', error);
          }
        }
        if (!isSharedStoreDoc(INSTALLED_CONFIG_PATH)) this.reconcileInstalledModules();
      }));
    } catch (error) {
      console.error('[AppStoreManager] Failed to load config:', error);
    }
  }

  /** Runs a section whose shared write no reply waits for: a refusal is logged (decision 28, T15). */
  private unawaited<T>(fn: () => T): T {
    try {
      return fn();
    } finally {
      const queued = this.takeQueued();
      if (queued) watchStoreDoc(queued);
    }
  }

  /**
   * Decision 28 on a Postgres bot: the section runs inside the store mutex, its synchronous part under the store lock,
   * and its shared write's ticket is awaited (StoreWriteError for an answer other than success).
   */
  private async awaited<T>(what: string, fn: () => T): Promise<T> {
    const hold = await takeStoreMutex();
    try {
      let result: T;
      try {
        result = fn();
      } catch (error) {
        const queued = this.takeQueued();
        if (queued) watchStoreDoc(queued);
        throw error;
      }
      const queued = this.takeQueued();
      if (queued) await awaitStoreDoc(queued, what);
      return result;
    } finally {
      hold.release();
    }
  }

  private takeQueued(): StoreQueued | null {
    const queued = this.queued;
    this.queued = null;
    return queued;
  }

  /** Queues a shared write of an App Store doc with its base; the caller's section awaits or watches it. */
  private queueShared(file: string, text: string | null, base: string): boolean {
    const queued = queueStoreDoc(file, text, base);
    if (!queued) return true;
    if (this.queued) watchStoreDoc(this.queued);
    this.queued = queued;
    return !('refused' in queued);
  }

  /** Run a synchronous section under the cross-process store lock. */
  private locked<T>(fn: () => T): T {
    const outer = storeLock.depth === 0;
    acquireStoreLock();
    return this.runHeld(outer, fn);
  }

  /** Like locked, but waits for the lock without blocking the event loop. */
  private async lockedAsync<T>(fn: () => T): Promise<T> {
    const outer = storeLock.depth === 0;
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (!tryAcquireStoreLock()) await waitBeforeLockRetry(deadline);
    return this.runHeld(outer, fn);
  }

  private runHeld<T>(outer: boolean, fn: () => T): T {
    try {
      return fn();
    } finally {
      releaseStoreLock();
      if (outer) {
        this.reposFresh = false;
        this.installedFresh = false;
      }
    }
  }

  private setAside(file: string, stamp: string, error: string | undefined): void {
    const key = `${file}|${stamp}`;
    if (this.asideStamps.has(key)) return;
    this.asideStamps.add(key);
    console.error(`[AppStoreManager] ${path.basename(file)} could not be read (${error}); App Store changes are blocked until it reads again`);
    try {
      ensureDir(UNREADABLE_DIR);
      const copy = path.join(UNREADABLE_DIR, `${path.basename(file)}.${Date.now()}`);
      fs.copyFileSync(file, copy);
      console.error(`[AppStoreManager] Kept a copy of the unreadable file at ${copy}`);
    } catch (copyError) {
      console.error(`[AppStoreManager] Could not copy the unreadable ${path.basename(file)} aside:`, copyError);
    }
  }

  private readRepos(): void {
    const stamp = fileStamp(REPOS_CONFIG_PATH);
    const result = readJsonStrict(REPOS_CONFIG_PATH, isReposConfig);
    this.reposState = result.state;
    this.reposStamp = stamp;
    this.reposSha = result.sha;
    if (result.state === 'read') {
      this.reposConfig = result.value!;
    } else if (result.state === 'missing') {
      this.reposConfig = structuredClone(DEFAULT_REPOS_CONFIG);
    } else {
      this.reposConfig = { repositories: [] };
      this.setAside(REPOS_CONFIG_PATH, stamp, result.error);
    }
    this.reposFresh = storeLock.depth > 0 && result.state !== 'unreadable';
  }

  private readInstalled(): void {
    const stamp = fileStamp(INSTALLED_CONFIG_PATH);
    const result = readJsonStrict(INSTALLED_CONFIG_PATH, isInstalledConfig);
    this.installedState = result.state;
    this.installedStamp = stamp;
    this.installedSha = result.sha;
    if (result.state === 'read') {
      this.installedConfig = result.value!;
    } else if (result.state === 'missing') {
      this.installedConfig = structuredClone(DEFAULT_INSTALLED_CONFIG);
    } else {
      this.installedConfig = { modules: {} };
      this.setAside(INSTALLED_CONFIG_PATH, stamp, result.error);
    }
    this.installedFresh = storeLock.depth > 0 && result.state !== 'unreadable';
  }

  /** Pick up a write the other process made since this one last read. */
  private refreshFromDisk(): void {
    if (storeLock.depth > 0) return;
    if (fileStamp(REPOS_CONFIG_PATH) !== this.reposStamp) this.readRepos();
    if (fileStamp(INSTALLED_CONFIG_PATH) !== this.installedStamp) this.readInstalled();
  }

  private requireInstalledReadable(): void {
    if (this.installedState === 'unreadable') {
      throw new Error('The installed modules list (installed.json) could not be read, so nothing was changed.');
    }
  }

  private requireReposReadable(): void {
    if (this.reposState === 'unreadable') {
      throw new Error('The repository list (repos.json) could not be read, so nothing was changed.');
    }
  }

  private reconcileInstalledModules(): void {
    // Deleting folders needs a list this process read from an existing file
    // under the lock; a missing or unreadable list would delete every module.
    if (this.installedState !== 'read' || !this.installedFresh) return;

    const sourceDir = getSourceModulesDir();
    if (!fs.existsSync(sourceDir)) return;

    // Skip when dirs collide (dev mode), otherwise we'd wipe built-in module source trees.
    if (sourceDir === getModulesDir()) {
      console.log('[AppStoreManager] Dev mode: skipping orphan reconciliation');
      return;
    }

    let changed = false;

    const buildDir = getBuildModulesDir();
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name.startsWith('.') || name.endsWith('.disabled')) continue;
      if (!this.installedConfig.modules[name]) {
        const orphanPath = path.join(sourceDir, name);
        try {
          fs.rmSync(orphanPath, { recursive: true, force: true });
          console.log(`[AppStoreManager] Reconciled orphan module dir: ${name}`);
        } catch (err) {
          console.error(`[AppStoreManager] Failed to remove orphan dir ${name}:`, err);
        }
        if (sourceDir !== buildDir) {
          const orphanBuildPath = path.join(buildDir, name);
          if (fs.existsSync(orphanBuildPath)) {
            try {
              fs.rmSync(orphanBuildPath, { recursive: true, force: true });
            } catch (err) {
              console.error(`[AppStoreManager] Failed to remove orphan build dir ${name}:`, err);
            }
          }
        }
      }
    }

    for (const moduleName of Object.keys(this.installedConfig.modules)) {
      const modDir = path.join(sourceDir, moduleName);
      if (!fs.existsSync(modDir)) {
        delete this.installedConfig.modules[moduleName];
        changed = true;
        console.log(`[AppStoreManager] Reconciled stale config entry: ${moduleName}`);
      }
    }

    if (!changed) return;
    try {
      this.saveInstalled();
    } catch (error) {
      if (!(error instanceof FolderSyncError)) throw error;
      logFolderSyncError('[AppStoreManager] The installed config', error);
    }
  }

  /**
   * Save repos configuration. Refused unless this instance holds the store
   * lock and read repos.json under it, so a stale copy never overwrites the file.
   */
  private saveRepos(): boolean {
    if (storeLock.depth === 0 || !this.reposFresh) {
      console.error('[AppStoreManager] Refused to save repos config: it was not read under the store lock');
      return false;
    }
    try {
      if (isSharedStoreDoc(REPOS_CONFIG_PATH)) {
        // Decision 53: only the in-memory body changes; the landing block writes the file, and the next read takes it.
        const queued = this.queueShared(REPOS_CONFIG_PATH, JSON.stringify(this.reposConfig, null, 2), this.reposSha);
        if (!queued) {
          this.readRepos();
          return false;
        }
        this.reposStamp = 'queued';
        return true;
      }
      writeJsonAtomic(REPOS_CONFIG_PATH, this.reposConfig);
      this.reposState = 'read';
      this.reposStamp = fileStamp(REPOS_CONFIG_PATH);
      return true;
    } catch (error) {
      if (error instanceof FolderSyncError) {
        this.reposState = 'read';
        this.reposStamp = fileStamp(REPOS_CONFIG_PATH);
        throw error;
      }
      console.error('[AppStoreManager] Failed to save repos config:', error);
      this.readRepos();
      return false;
    }
  }

  /**
   * Save installed configuration, under the same rule as saveRepos.
   */
  private saveInstalled(): boolean {
    if (storeLock.depth === 0 || !this.installedFresh) {
      console.error('[AppStoreManager] Refused to save installed config: it was not read under the store lock');
      return false;
    }
    try {
      writeJsonAtomic(INSTALLED_CONFIG_PATH, this.installedConfig);
      this.installedState = 'read';
      this.installedStamp = fileStamp(INSTALLED_CONFIG_PATH);
      return true;
    } catch (error) {
      if (error instanceof FolderSyncError) {
        this.installedState = 'read';
        this.installedStamp = fileStamp(INSTALLED_CONFIG_PATH);
        throw error;
      }
      console.error('[AppStoreManager] Failed to save installed config:', error);
      this.readInstalled();
      return false;
    }
  }

  // ============================================================================
  // REPOSITORY MANAGEMENT
  // ============================================================================

  /**
   * Get all repositories
   */
  getRepositories(): AppStoreRepository[] {
    this.refreshFromDisk();
    return [...this.reposConfig.repositories];
  }

  /**
   * Get a repository by ID
   */
  getRepository(id: string): AppStoreRepository | null {
    this.refreshFromDisk();
    return this.reposConfig.repositories.find(r => r.id === id) || null;
  }

  /**
   * Add a new repository. On a Postgres bot the change is queued and not awaited; addRepositoryAwaited awaits it.
   */
  addRepository(
    name: string,
    url: string,
    branch?: string,
    githubToken?: string
  ): AppStoreRepository {
    const repo = this.newRepository(name, url, branch, githubToken);
    return this.unawaited(() => this.addRepositoryLocked(repo));
  }

  /** addRepository with decision 28's answers: it resolves once the change is stored and the file holds it. */
  async addRepositoryAwaited(name: string, url: string, branch?: string, githubToken?: string): Promise<AppStoreRepository> {
    if (!isSharedStoreDoc(REPOS_CONFIG_PATH)) return this.addRepository(name, url, branch, githubToken);
    const repo = this.newRepository(name, url, branch, githubToken);
    return this.awaited('repository list', () => this.addRepositoryLocked(repo));
  }

  private newRepository(name: string, url: string, branch: string | undefined, githubToken?: string): AppStoreRepository {
    const normalized = this.normalizeGitUrl(url);

    // Use branch extracted from URL if user didn't specify one explicitly
    const finalBranch = branch || normalized.branch || 'main';

    // Validate URL before storing
    const urlValidation = validateRepoUrl(normalized.url);
    if (!urlValidation.valid) {
      throw new Error(`Invalid repository URL: ${urlValidation.error}`);
    }

    // Validate branch name
    const branchValidation = validateBranchName(finalBranch);
    if (!branchValidation.valid) {
      throw new Error(`Invalid branch name: ${branchValidation.error}`);
    }

    return {
      id: crypto.randomUUID(),
      name,
      url: normalized.url,
      branch: finalBranch,
      githubToken: githubToken || null,
      enabled: true,
      lastRefreshed: null
    };
  }

  private addRepositoryLocked(repo: AppStoreRepository): AppStoreRepository {
    return this.locked(() => {
      this.readRepos();
      this.requireReposReadable();
      this.reposConfig.repositories.push(repo);
      let saved: boolean;
      try {
        saved = this.saveRepos();
      } catch (error) {
        if (error instanceof FolderSyncError) throw repoListUnconfirmed(error, repo.name, 'added');
        throw error;
      }
      if (!saved) {
        throw new Error('The repository list could not be saved, so the repository was not added.');
      }
      return repo;
    });
  }

  /**
   * Update a repository. Returns false when the repository is not in repos.json
   * or the file could not be read or written.
   */
  updateRepository(id: string, updates: Partial<AppStoreRepository>): boolean {
    this.validateUpdates(updates);
    return this.unawaited(() => this.updateRepositoryLocked(id, updates));
  }

  /** updateRepository with decision 28's answers. */
  async updateRepositoryAwaited(id: string, updates: Partial<AppStoreRepository>): Promise<boolean> {
    if (!isSharedStoreDoc(REPOS_CONFIG_PATH)) return this.updateRepository(id, updates);
    this.validateUpdates(updates);
    return this.awaited('repository list', () => this.updateRepositoryLocked(id, updates));
  }

  private validateUpdates(updates: Partial<AppStoreRepository>): void {
    // Validate URL if being updated
    if (updates.url) {
      const urlValidation = validateRepoUrl(updates.url);
      if (!urlValidation.valid) {
        throw new Error(`Invalid repository URL: ${urlValidation.error}`);
      }
    }

    // Validate branch if being updated
    if (updates.branch) {
      const branchValidation = validateBranchName(updates.branch);
      if (!branchValidation.valid) {
        throw new Error(`Invalid branch name: ${branchValidation.error}`);
      }
    }
  }

  private updateRepositoryLocked(id: string, updates: Partial<AppStoreRepository>): boolean {
    return this.locked(() => {
      this.readRepos();
      if (this.reposState === 'unreadable') return false;
      const index = this.reposConfig.repositories.findIndex(r => r.id === id);
      if (index === -1) return false;

      this.reposConfig.repositories[index] = {
        ...this.reposConfig.repositories[index],
        ...updates,
        id // Ensure ID cannot be changed
      };

      try {
        return this.saveRepos();
      } catch (error) {
        if (error instanceof FolderSyncError) throw repoListUnconfirmed(error, this.reposConfig.repositories[index].name, 'updated');
        throw error;
      }
    });
  }

  /**
   * Remove a repository
   */
  removeRepository(id: string): boolean {
    return this.unawaited(() => this.removeRepositoryLocked(id));
  }

  /** removeRepository with decision 28's answers. */
  async removeRepositoryAwaited(id: string): Promise<boolean> {
    if (!isSharedStoreDoc(REPOS_CONFIG_PATH)) return this.removeRepository(id);
    return this.awaited('repository list', () => this.removeRepositoryLocked(id));
  }

  private removeRepositoryLocked(id: string): boolean {
    return this.locked(() => {
      this.readRepos();
      if (this.reposState === 'unreadable') return false;
      const index = this.reposConfig.repositories.findIndex(r => r.id === id);
      if (index === -1) return false;

      const [removed] = this.reposConfig.repositories.splice(index, 1);
      let unconfirmed: FolderSyncError | null = null;
      try {
        if (!this.saveRepos()) return false;
      } catch (error) {
        if (!(error instanceof FolderSyncError)) throw error;
        unconfirmed = repoListUnconfirmed(error, removed.name, 'removed');
      }

      // Clear cache for this repo
      this.moduleCache.delete(id);

      // Clean up cached repo files
      const cacheDir = path.join(CACHE_DIR, id);
      try {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      } catch (error) {
        console.error(`[AppStoreManager] Removed repository ${id} but could not delete its cached clone:`, error);
      }
      if (unconfirmed) throw unconfirmed;
      return true;
    });
  }

  /**
   * Normalize GitHub URL to HTTPS format
   */
  normalizeGitUrl(url: string): { url: string; branch?: string } {
    let extractedBranch: string | undefined;

    // Convert SSH to HTTPS
    if (url.startsWith('git@github.com:')) {
      url = url.replace('git@github.com:', 'https://github.com/');
    }

    // Remove .git suffix if present
    if (url.endsWith('.git')) {
      url = url.slice(0, -4);
    }

    // Strip /tree/{branch} suffix from GitHub URLs and extract branch
    const treeMatch = url.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/(.+)$/);
    if (treeMatch) {
      url = treeMatch[1];
      extractedBranch = treeMatch[2].replace(/\/$/, ''); // trim trailing slash
    }

    // Strip /blob/{branch}/... suffix too (user copied a file URL)
    const blobMatch = url.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/blob\/.+$/);
    if (blobMatch) {
      url = blobMatch[1];
    }

    return { url, branch: extractedBranch };
  }

  // ============================================================================
  // MODULE DISCOVERY
  // ============================================================================

  /**
   * Refresh modules from a repository
   * Clones/pulls the repo and scans for module.json files
   */
  async refreshRepository(repoId: string): Promise<StoreModuleInfo[]> {
    return this.lockedAsync(() => this.refreshRepositoryLocked(repoId));
  }

  /** The clone is only pulled, reset or copied from while the store lock is held. */
  private refreshRepositoryLocked(repoId: string): StoreModuleInfo[] {
    this.readRepos();
    this.readInstalled();
    const repo = this.getRepository(repoId);
    if (!repo) {
      throw new Error(`Repository ${repoId} not found`);
    }

    const cacheDir = path.join(CACHE_DIR, repoId);
    ensureDir(cacheDir);

    try {
      // Clone or pull the repository
      if (fs.existsSync(path.join(cacheDir, '.git'))) {
        // Pull latest
        this.gitPull(cacheDir, repo);
      } else {
        // Clone
        this.gitClone(repo, cacheDir);
      }

      // Scan for modules
      const modules = this.scanForModules(cacheDir, repo);

      // Update cache
      this.moduleCache.set(repoId, modules);

      // Update last refreshed timestamp
      try {
        this.updateRepository(repoId, {
          lastRefreshed: new Date().toISOString()
        });
      } catch (error) {
        if (!(error instanceof FolderSyncError)) throw error;
        logSyncLine(error.file, error.kind, `[AppStoreManager] ${error.message}`);
      }

      return modules;
    } catch (error) {
      console.error(`[AppStoreManager] Failed to refresh repository ${repoId}:`, error);
      throw error;
    }
  }

  /**
   * Build an authenticated URL for git operations.
   * Supports both formats:
   *   - GitHub PAT (ghp_/github_pat_): https://x-access-token:TOKEN@github.com/...
   *   - Classic token / other providers: https://TOKEN@github.com/...
   */
  private buildAuthUrl(repo: AppStoreRepository): string {
    if (!repo.githubToken) return repo.url;
    const urlObj = new URL(repo.url);
    const token = repo.githubToken;
    if (token.startsWith('ghp_') || token.startsWith('github_pat_')) {
      urlObj.username = 'x-access-token';
      urlObj.password = token;
    } else {
      urlObj.username = token;
    }
    return urlObj.toString();
  }

  /**
   * Test if a repo URL + token combination is reachable.
   * Uses git ls-remote (fast, no data transfer).
   */
  testRepoAccess(repo: AppStoreRepository): { ok: boolean; error?: string } {
    try {
      const testUrl = this.buildAuthUrl(repo);
      console.log(`[AppStoreManager] Testing repo access: ${repo.url} (token: ${repo.githubToken ? 'yes' : 'no'})`);
      execSync(`git ls-remote --exit-code "${testUrl}" HEAD`, {
        stdio: 'pipe',
        timeout: 15000
      });
      return { ok: true };
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.message || '';
      console.error(`[AppStoreManager] Repo access test failed: ${stderr}`);
      if (stderr.includes('Authentication failed') || stderr.includes('could not read Username') || stderr.includes('403')) {
        return { ok: false, error: 'Authentication failed: check your GitHub token' };
      }
      if (stderr.includes('not found') || stderr.includes('Repository not found') || stderr.includes('404')) {
        return { ok: false, error: 'Repository not found: check the URL and token' };
      }
      return { ok: false, error: stderr.split('\n')[0] || 'Could not reach repository' };
    }
  }

  /**
   * Clone a repository
   */
  private gitClone(repo: AppStoreRepository, targetDir: string): void {
    const validation = validateRepoConfig(repo);
    if (!validation.valid) {
      throw new Error(`Invalid repository configuration: ${validation.error}`);
    }

    const cloneUrl = this.buildAuthUrl(repo);
    execSync(`git clone --depth 1 --branch "${repo.branch}" "${cloneUrl}" "${targetDir}"`, {
      stdio: 'pipe',
      timeout: GIT_TIMEOUT_MS
    });
  }

  /**
   * Pull latest from a repository
   */
  private gitPull(repoDir: string, repo: AppStoreRepository): void {
    const validation = validateRepoConfig(repo);
    if (!validation.valid) {
      throw new Error(`Invalid repository configuration: ${validation.error}`);
    }

    const authUrl = this.buildAuthUrl(repo);
    execSync(`git remote set-url origin "${authUrl}"`, {
      cwd: repoDir,
      stdio: 'pipe',
      timeout: GIT_TIMEOUT_MS
    });

    execSync(`git fetch origin "${repo.branch}" && git reset --hard "origin/${repo.branch}"`, {
      cwd: repoDir,
      stdio: 'pipe',
      timeout: GIT_TIMEOUT_MS
    });
  }

  /**
   * Read the HEAD commit hash from a cached repo directory.
   */
  private getRepoCacheCommit(repoId: string): string | null {
    const cacheDir = path.join(CACHE_DIR, repoId);
    try {
      if (!fs.existsSync(path.join(cacheDir, '.git'))) return null;
      const hash = execSync('git rev-parse HEAD', { cwd: cacheDir, stdio: 'pipe', timeout: GIT_TIMEOUT_MS }).toString().trim();
      return hash || null;
    } catch {
      return null;
    }
  }

  /**
   * Scan a repository for modules
   */
  private scanForModules(repoDir: string, repo: AppStoreRepository): StoreModuleInfo[] {
    const modules: StoreModuleInfo[] = [];

    // Look for Modules/ directory (case-insensitive)
    let modulesDir: string | null = null;
    const entries = fs.readdirSync(repoDir);

    for (const entry of entries) {
      if (entry.toLowerCase() === 'modules') {
        modulesDir = path.join(repoDir, entry);
        break;
      }
    }

    if (!modulesDir || !fs.existsSync(modulesDir)) {
      console.warn(`[AppStoreManager] No Modules/ directory found in ${repo.name}`);
      return modules;
    }

    // Scan for module directories
    const moduleFolders = fs.readdirSync(modulesDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name);

    for (const folderName of moduleFolders) {
      const manifestPath = path.join(modulesDir, folderName, 'module.json');

      if (!fs.existsSync(manifestPath)) {
        continue;
      }

      try {
        const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent) as ModuleManifest;

        // Check if installed
        const installed = this.installedConfig.modules[manifest.name];

        modules.push({
          manifest,
          repoId: repo.id,
          repoName: repo.name,
          repoPath: path.join(modulesDir, folderName),
          installed: !!installed,
          installedVersion: installed?.version
        });
      } catch (error) {
        console.error(`[AppStoreManager] Failed to parse module.json for ${folderName}:`, error);
      }
    }

    return modules;
  }

  /**
   * Get all available modules from all enabled repositories.
   * If not cached, triggers a git clone/pull (slow on first call).
   */
  async getAvailableModules(): Promise<StoreModuleInfo[]> {
    this.refreshFromDisk();
    const allModules: StoreModuleInfo[] = [];

    for (const repo of this.reposConfig.repositories) {
      if (!repo.enabled) continue;

      // Use cache if available
      let modules = this.moduleCache.get(repo.id);

      if (!modules) {
        // Refresh if not cached
        try {
          modules = await this.refreshRepository(repo.id);
        } catch (error) {
          console.error(`[AppStoreManager] Failed to get modules from ${repo.name}:`, error);
          continue;
        }
      }

      allModules.push(...modules);
    }

    return this.withInstalledFlags(allModules);
  }

  /**
   * Get modules from cache only (no git operations).
   * For repos not yet cached, scans the local cache directory if it exists.
   * Returns instantly; never triggers network requests.
   */
  getCachedModules(): StoreModuleInfo[] {
    this.refreshFromDisk();
    const allModules: StoreModuleInfo[] = [];

    for (const repo of this.reposConfig.repositories) {
      if (!repo.enabled) continue;

      let modules = this.moduleCache.get(repo.id);

      if (!modules) {
        // Try scanning local cache dir without cloning
        const cacheDir = path.join(CACHE_DIR, repo.id);
        if (fs.existsSync(path.join(cacheDir, '.git'))) {
          modules = this.scanForModules(cacheDir, repo);
          this.moduleCache.set(repo.id, modules);
        }
      }

      if (modules) {
        allModules.push(...modules);
      }
    }

    return this.withInstalledFlags(allModules);
  }

  private withInstalledFlags(modules: StoreModuleInfo[]): StoreModuleInfo[] {
    for (const info of modules) {
      const installed = this.installedConfig.modules[info.manifest.name];
      info.installed = !!installed;
      info.installedVersion = installed?.version;
    }
    return modules;
  }

  /**
   * Get module info by name from cache
   */
  getModuleInfo(moduleName: string): StoreModuleInfo | null {
    for (const [_, modules] of this.moduleCache) {
      const module = modules.find(m => m.manifest.name === moduleName);
      if (module) return module;
    }
    return null;
  }

  // ============================================================================
  // MODULE INSTALLATION
  // ============================================================================

  /**
   * Install a module from the store. The clone is rescanned, copied and its
   * HEAD read under the store lock, and the record keeps the copied version.
   */
  async installModule(moduleName: string, repoId: string): Promise<boolean | PublishedChange> {
    if (isSharedStoreDoc(INSTALLED_CONFIG_PATH)) return this.installModuleShared(moduleName, repoId);
    return this.lockedAsync(() => {
      const moduleInfo = this.installChecks(moduleName, repoId);
      const sourceTargetDir = path.join(getSourceModulesDir(), moduleName);
      const buildTargetDir = path.join(getBuildModulesDir(), moduleName);

      takeAutoSnapshot(`install ${moduleName}`);

      const commitHash = this.getRepoCacheCommit(repoId) || undefined;
      let unconfirmed: FolderSyncError | null = null;
      try {
        this.copyDirectory(moduleInfo.repoPath, sourceTargetDir);

        if (sourceTargetDir !== buildTargetDir) {
          ensureDir(path.dirname(buildTargetDir));
          this.copyDirectory(moduleInfo.repoPath, buildTargetDir);
        }

        const copiedVersion = readManifestVersion(sourceTargetDir);
        this.installedConfig.modules[moduleName] = {
          name: moduleName,
          version: copiedVersion,
          installedFrom: repoId,
          installedAt: new Date().toISOString(),
          commitHash
        };

        let saved: boolean;
        try {
          saved = this.saveInstalled();
        } catch (error) {
          if (!(error instanceof FolderSyncError)) throw error;
          unconfirmed = error;
          saved = true;
        }
        if (!saved) {
          throw new Error(`Module ${moduleName} was not installed: the installed modules list could not be saved.`);
        }

        moduleInfo.installed = true;
        moduleInfo.installedVersion = copiedVersion;

        console.log(`[AppStoreManager] Installed module: ${moduleName} v${copiedVersion}`);
      } catch (error) {
        delete this.installedConfig.modules[moduleName];
        if (fs.existsSync(sourceTargetDir)) {
          fs.rmSync(sourceTargetDir, { recursive: true, force: true });
        }
        if (sourceTargetDir !== buildTargetDir && fs.existsSync(buildTargetDir)) {
          fs.rmSync(buildTargetDir, { recursive: true, force: true });
        }
        throw error;
      }
      if (unconfirmed) {
        unconfirmed.message = listUnconfirmedText(moduleName, 'installed', unconfirmed);
        throw unconfirmed;
      }
      return true;
    });
  }

  /** Today's checks of an install, under the store lock; answers the clone's module. */
  private installChecks(moduleName: string, repoId: string): StoreModuleInfo {
    this.readRepos();
    this.readInstalled();
    this.requireInstalledReadable();

    const repo = this.getRepository(repoId);
    if (!repo) {
      throw new Error(`Repository ${repoId} not found`);
    }

    const cacheDir = path.join(CACHE_DIR, repoId);
    let moduleInfo: StoreModuleInfo | undefined;
    if (fs.existsSync(path.join(cacheDir, '.git'))) {
      const scanned = this.scanForModules(cacheDir, repo);
      this.moduleCache.set(repoId, scanned);
      moduleInfo = scanned.find(m => m.manifest.name === moduleName);
    }

    if (!moduleInfo) {
      console.log(`[AppStoreManager] Module ${moduleName} not in cache, refreshing repository...`);
      try {
        moduleInfo = this.refreshRepositoryLocked(repoId).find(m => m.manifest.name === moduleName);
      } catch (refreshError) {
        console.error(`[AppStoreManager] Failed to refresh repository:`, refreshError);
      }
    }

    if (!moduleInfo) {
      throw new Error(`Module ${moduleName} not found in repository ${repo.name}`);
    }

    const sourceTargetDir = path.join(getSourceModulesDir(), moduleName);
    const runtimeTargetDir = path.join(getModulesDir(), moduleName);

    if (this.installedConfig.modules[moduleName] || fs.existsSync(sourceTargetDir) || fs.existsSync(runtimeTargetDir)) {
      throw new Error(`Module ${moduleName} is already installed`);
    }

    if (findDevModuleWithName(moduleName)) {
      throw new Error(`Module ${moduleName} conflicts with a Dev module of the same name. Remove or rename the Dev module first.`);
    }
    return moduleInfo;
  }

  /**
   * Decision 35 step 1 under the store lock: the size limits, the clone's module folder copied to a staged folder, and
   * installed.json's new body with the sha of the bytes read under the lock as its base.
   */
  private stage(operation: 'install' | 'update', moduleName: string, moduleInfo: StoreModuleInfo, entryOf: (version: string) => InstalledModule): Staged {
    const refusal = sizeRefusal(moduleName, moduleInfo.repoPath, operation) ?? filePathRefusal(moduleName, moduleInfo.repoPath, operation);
    if (refusal) throw new Error(refusal);
    const dir = path.join(getSourceModulesDir(), `.incoming-${moduleName}-${Date.now()}`);
    stagedFolders.add(path.resolve(dir));
    try {
      this.copyDirectory(moduleInfo.repoPath, dir);
      const version = readManifestVersion(dir);
      const next: InstalledConfig = structuredClone(this.installedConfig);
      next.modules[moduleName] = entryOf(version);
      return { dir, version, body: JSON.stringify(next, null, 2), base: this.installedSha, moduleInfo };
    } catch (error) {
      dropStaged(dir);
      throw error;
    }
  }

  /** Decision 35 step 2, outside the lock: the staged files synced, then one publish of them with installed.json. */
  private async publishStaged(operation: 'install' | 'update', moduleName: string, s: Staged): Promise<ModuleSaveAnswer> {
    try {
      fsyncTree(s.dir);
      return await publishModule(moduleName, s.dir, s.body, s.base, { operation, version: s.version });
    } catch (error) {
      dropStaged(s.dir);
      throw error;
    }
  }

  /**
   * After the publish or the uninstall answered (35, 44, 61): stored nothing, the staged folder is deleted and the answer
   * is 42's, 35's or T10's text. Stored: installed.json's mirror and its store record entry (with the credentials doc's
   * removal for an uninstall) under the store lock; then in the bot the apply inside the caller's hold, whose outcome
   * the answer carries. The web UI applies through the bot (`module:apply`), so it hands the staged folder on. Once
   * stored, a throw of the landing or the apply answers the stored change; landStoreDoc's retry or the pass writes it.
   */
  private async landPublished(operation: ModuleOperation, moduleName: string, s: Staged | null, body: string, answer: ModuleSaveAnswer, hold: StoreMutexHold): Promise<PublishedChange> {
    if (answer.kind !== 'committed') {
      if (s) dropStaged(s.dir);
      throw notStored(operation, moduleName, answer);
    }
    const tag = rowMainTag();
    const version = s?.version ?? null;
    let landError: unknown = null;
    try {
      this.locked(() => {
        landStoreDoc(INSTALLED_KEY, Buffer.from(body, 'utf8'), answer.installedSha, tag);
        if (operation === 'uninstall') landStoreDoc(credentialsKeyOf(moduleName), null, 'absent', tag);
        this.readInstalled();
      });
    } catch (error) {
      landError = error;
    }
    for (const [, modules] of this.moduleCache) {
      for (const info of modules) {
        if (info.manifest.name !== moduleName) continue;
        info.installed = operation !== 'uninstall';
        info.installedVersion = version ?? undefined;
      }
    }
    const change: PublishedChange = { module: moduleName, operation, version, to: answer.sha, tag, updatedBy: updatedBy(), staged: s?.dir ?? null, applied: null };
    if (!rowsOnDataPool()) {
      if (s) stagedFolders.delete(path.resolve(s.dir));
      return change;
    }
    try {
      if (landError !== null) throw landError;
      const { applyModuleChange, publisherAnswer } = await import('./moduleApply');
      const result = await applyModuleChange({
        module: moduleName, to: answer.sha, source: s?.dir ?? 'rows', displaced: 'backups', reason: operation, tag, version, updatedBy: change.updatedBy,
      }, hold);
      change.applied = publisherAnswer(operation, moduleName, version ?? '', result);
    } catch (error) {
      change.applied = notAppliedYet(operation, moduleName, version ?? '', error, await applyLaterHere(moduleName));
    } finally {
      if (s) dropStaged(s.dir);
      change.staged = null;
    }
    return change;
  }

  /** Decision 35 on a Postgres bot: stage under the store lock, publish outside it, then land and apply, all in one hold. */
  private async installModuleShared(moduleName: string, repoId: string): Promise<PublishedChange> {
    const hold = await takeStoreMutex();
    try {
      const s = this.locked(() => {
        const moduleInfo = this.installChecks(moduleName, repoId);
        takeAutoSnapshot(`install ${moduleName}`);
        const commitHash = this.getRepoCacheCommit(repoId) || undefined;
        return this.stage('install', moduleName, moduleInfo, version => ({
          name: moduleName, version, installedFrom: repoId, installedAt: new Date().toISOString(), commitHash,
        }));
      });
      const answer = await this.publishStaged('install', moduleName, s);
      return await this.landPublished('install', moduleName, s, s.body, answer, hold);
    } finally {
      hold.release();
    }
  }

  /** Decision 35's uninstall on a Postgres bot: the checks under the lock, the unpublish outside it, then the removal. */
  private async uninstallModuleShared(moduleName: string): Promise<PublishedChange> {
    const hold = await takeStoreMutex();
    try {
      const prepared = this.locked(() => {
        this.readInstalled();
        this.requireInstalledReadable();
        if (!this.installedConfig.modules[moduleName]) {
          throw new Error(`Module ${moduleName} is not installed`);
        }
        const dirs = [getSourceModulesDir(), getBuildModulesDir(), getModulesDir()].map(dir => path.join(dir, moduleName));
        if (dirs.some(dir => fs.existsSync(dir))) takeAutoSnapshot(`uninstall ${moduleName}`);
        const next: InstalledConfig = structuredClone(this.installedConfig);
        delete next.modules[moduleName];
        return { body: JSON.stringify(next, null, 2), base: this.installedSha };
      });
      const answer = await unpublishModule(moduleName, prepared.body, prepared.base);
      return await this.landPublished('uninstall', moduleName, null, prepared.body, answer, hold);
    } finally {
      hold.release();
    }
  }

  /**
   * Uninstall a module. The record goes first, so a failed save changes
   * nothing and a failed delete leaves folders the next reconcile removes.
   */
  async uninstallModule(moduleName: string): Promise<boolean | PublishedChange> {
    if (isSharedStoreDoc(INSTALLED_CONFIG_PATH)) return this.uninstallModuleShared(moduleName);
    return this.lockedAsync(() => {
      this.readInstalled();
      this.requireInstalledReadable();

      const installed = this.installedConfig.modules[moduleName];
      if (!installed) {
        throw new Error(`Module ${moduleName} is not installed`);
      }

      const sourceDir = path.join(getSourceModulesDir(), moduleName);
      const buildDir = path.join(getBuildModulesDir(), moduleName);
      const runtimeDir = path.join(getModulesDir(), moduleName);
      const hasFiles = fs.existsSync(sourceDir) || fs.existsSync(buildDir) || fs.existsSync(runtimeDir);

      if (hasFiles) takeAutoSnapshot(`uninstall ${moduleName}`);

      delete this.installedConfig.modules[moduleName];
      let unconfirmed: FolderSyncError | null = null;
      let saved: boolean;
      try {
        saved = this.saveInstalled();
      } catch (error) {
        if (!(error instanceof FolderSyncError)) throw error;
        unconfirmed = error;
        unconfirmed.message = listUnconfirmedText(moduleName, 'uninstalled', error);
        saved = true;
      }
      if (!saved) {
        throw new Error(`Module ${moduleName} was not uninstalled: the installed modules list could not be saved.`);
      }

      for (const [_, modules] of this.moduleCache) {
        const moduleInfo = modules.find(m => m.manifest.name === moduleName);
        if (moduleInfo) {
          moduleInfo.installed = false;
          moduleInfo.installedVersion = undefined;
        }
      }

      if (!hasFiles) {
        this.deleteCredentials(moduleName);
        if (unconfirmed) throw unconfirmed;
        return true;
      }

      if (fs.existsSync(sourceDir)) {
        fs.rmSync(sourceDir, { recursive: true, force: true });
      }
      if (sourceDir !== buildDir && fs.existsSync(buildDir)) {
        fs.rmSync(buildDir, { recursive: true, force: true });
      }
      if (fs.existsSync(runtimeDir)) {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
      }

      // Remove credentials if any
      this.deleteCredentials(moduleName);

      console.log(`[AppStoreManager] Uninstalled module: ${moduleName}`);
      if (unconfirmed) throw unconfirmed;
      return true;
    });
  }

  /**
   * Scan a module's directory for components (commands, events, panels).
   * Works for both cached (repo) and installed (source) modules.
   */
  getModuleComponents(moduleName: string, repoId?: string): { commands: string[]; events: string[]; panels: string[] } {
    const result = { commands: [] as string[], events: [] as string[], panels: [] as string[] };

    // Try repo cache first: scan for Modules/ directory (case-insensitive, same as scanForModules)
    let moduleDir: string | null = null;
    if (repoId) {
      const cacheDir = path.join(CACHE_DIR, repoId);
      if (fs.existsSync(cacheDir)) {
        // Find the Modules/ directory (case-insensitive)
        const entries = fs.readdirSync(cacheDir);
        for (const entry of entries) {
          if (entry.toLowerCase() === 'modules') {
            const candidate = path.join(cacheDir, entry, moduleName);
            if (fs.existsSync(candidate)) {
              moduleDir = candidate;
              break;
            }
          }
        }
        // Also try direct path (moduleName at root of cache)
        if (!moduleDir) {
          const direct = path.join(cacheDir, moduleName);
          if (fs.existsSync(direct)) moduleDir = direct;
        }
      }
    }

    // Fallback to installed source
    if (!moduleDir) {
      const sourceDir = path.join(getSourceModulesDir(), moduleName);
      if (fs.existsSync(sourceDir)) moduleDir = sourceDir;
    }

    if (!moduleDir) return result;

    for (const [type, dir] of [['commands', 'commands'], ['events', 'events'], ['panels', 'panels']] as const) {
      const fullPath = path.join(moduleDir, dir);
      if (!fs.existsSync(fullPath)) continue;
      try {
        const files = fs.readdirSync(fullPath).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
        (result as any)[type] = files.map(f => f.replace(/\.(ts|js)$/, ''));
      } catch { /* ignore */ }
    }

    return result;
  }

  /**
   * Get all installed modules
   */
  getInstalledModules(): InstalledModule[] {
    this.refreshFromDisk();
    return Object.values(this.installedConfig.modules);
  }

  /**
   * Check if a module is installed
   */
  isModuleInstalled(moduleName: string): boolean {
    this.refreshFromDisk();
    return !!this.installedConfig.modules[moduleName];
  }

  /**
   * Copy directory recursively
   */
  private copyDirectory(src: string, dest: string): void {
    ensureDir(dest);

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyDirectory(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  // ============================================================================
  // CREDENTIALS MANAGEMENT
  // ============================================================================

  /**
   * Save credentials for a module. On a Postgres bot the change is queued and not awaited; saveCredentialsAwaited
   * awaits it.
   */
  saveCredentials(moduleName: string, credentials: Record<string, string>): boolean {
    return this.unawaited(() => this.saveCredentialsNow(moduleName, credentials));
  }

  /** saveCredentials with decision 28's answers, under the store lock. */
  async saveCredentialsAwaited(moduleName: string, credentials: Record<string, string>): Promise<boolean> {
    const credPath = path.join(CREDENTIALS_DIR, `${moduleName}.json`);
    if (!isSharedStoreDoc(credPath)) return this.saveCredentials(moduleName, credentials);
    return this.awaited(`credentials of ${moduleName}`, () => this.saveCredentialsNow(moduleName, credentials));
  }

  private saveCredentialsNow(moduleName: string, credentials: Record<string, string>): boolean {
    try {
      ensureDir(CREDENTIALS_DIR);
      const credPath = path.join(CREDENTIALS_DIR, `${moduleName}.json`);
      if (isSharedStoreDoc(credPath)) {
        return this.locked(() => this.queueShared(credPath, JSON.stringify(credentials, null, 2), storeFileSha(credPath)));
      }
      fs.writeFileSync(credPath, JSON.stringify(credentials, null, 2));
      return true;
    } catch (error) {
      if (error instanceof StoreWriteError) throw error;
      console.error(`[AppStoreManager] Failed to save credentials for ${moduleName}:`, error);
      return false;
    }
  }

  /**
   * Get credentials for a module
   */
  getCredentials(moduleName: string): Record<string, string> | null {
    try {
      const credPath = path.join(CREDENTIALS_DIR, `${moduleName}.json`);
      if (!fs.existsSync(credPath)) {
        return null;
      }
      const content = fs.readFileSync(credPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      const cause = error instanceof SyntaxError ? 'it is not valid JSON' : error instanceof Error ? error.message : String(error);
      console.error(`[AppStoreManager] The credentials of ${moduleName} cannot be read (${cause})`);
      return null;
    }
  }

  /**
   * Delete credentials for a module. On a Postgres bot the delete is queued and not awaited; deleteCredentialsAwaited
   * awaits it.
   */
  deleteCredentials(moduleName: string): boolean {
    return this.unawaited(() => this.deleteCredentialsNow(moduleName));
  }

  /** deleteCredentials with decision 28's answers, under the store lock. */
  async deleteCredentialsAwaited(moduleName: string): Promise<boolean> {
    const credPath = path.join(CREDENTIALS_DIR, `${moduleName}.json`);
    if (!isSharedStoreDoc(credPath)) return this.deleteCredentials(moduleName);
    return this.awaited(`credentials of ${moduleName}`, () => this.deleteCredentialsNow(moduleName));
  }

  private deleteCredentialsNow(moduleName: string): boolean {
    try {
      const credPath = path.join(CREDENTIALS_DIR, `${moduleName}.json`);
      if (isSharedStoreDoc(credPath)) {
        return this.locked(() => this.queueShared(credPath, null, storeFileSha(credPath)));
      }
      if (fs.existsSync(credPath)) {
        fs.unlinkSync(credPath);
      }
      return true;
    } catch (error) {
      if (error instanceof StoreWriteError) throw error;
      console.error(`[AppStoreManager] Failed to delete credentials for ${moduleName}:`, error);
      return false;
    }
  }

  /**
   * Check if a module has credentials saved
   */
  hasCredentials(moduleName: string): boolean {
    const credPath = path.join(CREDENTIALS_DIR, `${moduleName}.json`);
    return fs.existsSync(credPath);
  }

  // ============================================================================
  // MODULE UPDATE CHECKING
  // ============================================================================

  /**
   * Compare two semver version strings
   * Returns: -1 (v1 < v2), 0 (equal), 1 (v1 > v2)
   */
  private compareVersions(v1: string, v2: string): number {
    const parts1 = v1.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    const parts2 = v2.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 < p2) return -1;
      if (p1 > p2) return 1;
    }
    return 0;
  }

  /**
   * Check a single installed module for available updates
   */
  async checkModuleForUpdate(moduleName: string): Promise<ModuleUpdateCheck | null> {
    this.refreshFromDisk();
    const installed = this.installedConfig.modules[moduleName];
    if (!installed) {
      return null;
    }

    const repo = this.getRepository(installed.installedFrom);
    if (!repo) {
      console.warn(`[AppStoreManager] Repository ${installed.installedFrom} not found for module ${moduleName}`);
      return null;
    }

    try {
      // Refresh the source repository
      await this.refreshRepository(repo.id);

      // Get module info from cache
      const modules = this.moduleCache.get(repo.id);
      const moduleInfo = modules?.find(m => m.manifest.name === moduleName);

      if (!moduleInfo) {
        console.warn(`[AppStoreManager] Module ${moduleName} no longer exists in repository ${repo.name}`);
        return null;
      }

      const currentRepoCommit = this.getRepoCacheCommit(repo.id);
      const versionChanged = this.compareVersions(installed.version, moduleInfo.manifest.version) < 0;
      const commitChanged = !!(currentRepoCommit && installed.commitHash && currentRepoCommit !== installed.commitHash);
      const hasUpdate = versionChanged || (commitChanged && !this.installedMatchesRepo(moduleName, moduleInfo.repoPath));

      return {
        moduleName,
        installedVersion: installed.version,
        availableVersion: moduleInfo.manifest.version,
        installedCommit: installed.commitHash ? installed.commitHash.substring(0, 7) : undefined,
        availableCommit: currentRepoCommit ? currentRepoCommit.substring(0, 7) : undefined,
        hasUpdate,
        repoId: repo.id,
        repoName: repo.name
      };
    } catch (error) {
      console.error(`[AppStoreManager] Failed to check update for ${moduleName}:`, error);
      return null;
    }
  }

  /**
   * Check all installed modules for available updates
   * Groups modules by repository and refreshes each repo only once
   */
  async checkAllModulesForUpdates(): Promise<ModuleUpdatesResult> {
    const result: ModuleUpdatesResult = {
      success: true,
      checked: 0,
      updatesAvailable: 0,
      updates: [],
      errors: [],
      hasErrors: false
    };

    const installedModules = this.getInstalledModules();
    if (installedModules.length === 0) {
      return result;
    }

    // Group modules by repository
    const modulesByRepo = new Map<string, InstalledModule[]>();
    for (const module of installedModules) {
      const repoModules = modulesByRepo.get(module.installedFrom) || [];
      repoModules.push(module);
      modulesByRepo.set(module.installedFrom, repoModules);
    }

    // Process each repository
    for (const [repoId, modules] of modulesByRepo) {
      const repo = this.getRepository(repoId);
      if (!repo) {
        for (const module of modules) {
          result.errors.push({
            moduleName: module.name,
            error: `Repository ${repoId} not found`
          });
        }
        continue;
      }

      // Refresh repository once for all its modules
      try {
        await this.refreshRepository(repoId);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        for (const module of modules) {
          result.errors.push({
            moduleName: module.name,
            error: `Failed to refresh repository: ${errorMsg}`
          });
        }
        continue;
      }

      // Check each module in this repo
      const repoModulesCache = this.moduleCache.get(repoId);
      const currentRepoCommit = this.getRepoCacheCommit(repoId);

      for (const installed of modules) {
        result.checked++;

        const moduleInfo = repoModulesCache?.find(m => m.manifest.name === installed.name);
        if (!moduleInfo) {
          result.errors.push({
            moduleName: installed.name,
            error: 'Module no longer exists in repository'
          });
          continue;
        }

        // Detect update: commit mismatch (primary) OR version bump (secondary)
        const versionChanged = this.compareVersions(installed.version, moduleInfo.manifest.version) < 0;
        const commitChanged = !!(currentRepoCommit && installed.commitHash && currentRepoCommit !== installed.commitHash);
        const hasUpdate = versionChanged || (commitChanged && !this.installedMatchesRepo(installed.name, moduleInfo.repoPath));

        const updateCheck: ModuleUpdateCheck = {
          moduleName: installed.name,
          installedVersion: installed.version,
          availableVersion: moduleInfo.manifest.version,
          installedCommit: installed.commitHash ? installed.commitHash.substring(0, 7) : undefined,
          availableCommit: currentRepoCommit ? currentRepoCommit.substring(0, 7) : undefined,
          hasUpdate,
          repoId: repo.id,
          repoName: repo.name
        };

        result.updates.push(updateCheck);
        if (hasUpdate) {
          result.updatesAvailable++;
        }
      }
    }

    // Operation completed - success is true even with partial errors
    // hasErrors indicates whether any modules failed to check
    result.hasErrors = result.errors.length > 0;
    result.success = true;
    return result;
  }

  /** True when the installed source has the same files as the repository's module folder. */
  private installedMatchesRepo(moduleName: string, repoPath: string): boolean {
    const installedHash = hashDirectory(path.join(getSourceModulesDir(), moduleName));
    return installedHash !== null && installedHash === hashDirectory(repoPath);
  }

  /**
   * Check if a module update is currently in progress
   */
  isUpdateInProgress(moduleName: string): boolean {
    return this.updatesInProgress.has(moduleName);
  }

  /**
   * Check if any module update is currently in progress
   */
  hasAnyUpdateInProgress(): boolean {
    return this.updatesInProgress.size > 0;
  }

  /**
   * Update an installed module to the latest version
   * Backs up current module, uninstalls, reinstalls, and rolls back on failure.
   * Runs under the store lock against the record on disk, so a module the
   * other process uninstalled is never copied back.
   */
  async updateModule(moduleName: string): Promise<ModuleUpdateResult> {
    // Prevent concurrent updates to the same module
    if (this.updatesInProgress.has(moduleName)) {
      return { success: false, error: `Update already in progress for ${moduleName}` };
    }

    // Mark update as in progress
    this.updatesInProgress.add(moduleName);
    if (isSharedStoreDoc(INSTALLED_CONFIG_PATH)) {
      try {
        return await this.updateModuleShared(moduleName);
      } finally {
        this.updatesInProgress.delete(moduleName);
      }
    }

    const sourceDir = path.join(getSourceModulesDir(), moduleName);
    const buildDir = path.join(getBuildModulesDir(), moduleName);
    const runtimeDir = path.join(getModulesDir(), moduleName);
    const backupDir = path.join(CACHE_DIR, 'backups', `${moduleName}-${Date.now()}`);

    let lockHeld = false;
    try {
      const deadline = Date.now() + LOCK_WAIT_MS;
      while (!tryAcquireStoreLock()) await waitBeforeLockRetry(deadline);
      lockHeld = true;
      this.readRepos();
      this.readInstalled();
      this.requireInstalledReadable();

      const installed = this.installedConfig.modules[moduleName];
      if (!installed) {
        return { success: false, error: `Module ${moduleName} is not installed` };
      }

      const repo = this.getRepository(installed.installedFrom);
      if (!repo) {
        return { success: false, error: `Repository ${installed.installedFrom} not found` };
      }

      if (!fs.existsSync(sourceDir)) {
        return { success: false, error: `Module ${moduleName} has no files where it was installed, so it was not updated. Reinstall it from the App Store.` };
      }

      const modules = this.refreshRepositoryLocked(repo.id);
      const moduleInfo = modules.find(m => m.manifest.name === moduleName);

      if (!moduleInfo) {
        return { success: false, error: `Module ${moduleName} no longer exists in repository` };
      }

      if (this.compareVersions(installed.version, moduleInfo.manifest.version) >= 0) {
        return { success: true, newVersion: installed.version };
      }

      takeAutoSnapshot(`update ${moduleName}`);

      console.log(`[AppStoreManager] Backing up ${moduleName} to ${backupDir}`);
      ensureDir(path.dirname(backupDir));
      this.copyDirectory(sourceDir, backupDir);

      const previousInstalled = { ...installed };
      const commitHash = this.getRepoCacheCommit(repo.id) || undefined;
      try {
        if (fs.existsSync(sourceDir)) fs.rmSync(sourceDir, { recursive: true, force: true });
        if (sourceDir !== buildDir && fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
        if (fs.existsSync(runtimeDir)) fs.rmSync(runtimeDir, { recursive: true, force: true });
      } catch (error) {
        console.error(`[AppStoreManager] Failed to remove old module:`, error);
        return { success: false, error: `Failed to remove the current version of ${moduleName}; its backup is at ${backupDir}` };
      }

      try {
        this.copyDirectory(moduleInfo.repoPath, sourceDir);
        if (sourceDir !== buildDir) {
          ensureDir(path.dirname(buildDir));
          this.copyDirectory(moduleInfo.repoPath, buildDir);
        }

        const copiedVersion = readManifestVersion(sourceDir);
        this.installedConfig.modules[moduleName] = {
          name: moduleName,
          version: copiedVersion,
          installedFrom: repo.id,
          installedAt: new Date().toISOString(),
          commitHash
        };
        let unconfirmed: FolderSyncError | null = null;
        let saved: boolean;
        try {
          saved = this.saveInstalled();
        } catch (error) {
          if (!(error instanceof FolderSyncError)) throw error;
          unconfirmed = error;
          saved = true;
        }
        if (!saved) {
          throw new Error('the installed modules list could not be saved');
        }

        moduleInfo.installed = true;
        moduleInfo.installedVersion = copiedVersion;

        if (unconfirmed) {
          return { success: true, newVersion: copiedVersion, listUnconfirmed: listUnconfirmedText(moduleName, 'updated', unconfirmed, backupDir) };
        }

        try {
          fs.rmSync(backupDir, { recursive: true, force: true });
        } catch (cleanupError) {
          console.error(`[AppStoreManager] Updated ${moduleName} but could not delete its backup at ${backupDir}:`, cleanupError);
        }

        console.log(`[AppStoreManager] Updated ${moduleName} from ${previousInstalled.version} to ${copiedVersion}`);
        return { success: true, newVersion: copiedVersion };
      } catch (installError) {
        console.error(`[AppStoreManager] Install failed, rolling back:`, installError);

        let restored = false;
        let rollbackUnconfirmed: FolderSyncError | null = null;
        try {
          if (fs.existsSync(sourceDir)) fs.rmSync(sourceDir, { recursive: true, force: true });
          this.copyDirectory(backupDir, sourceDir);
          if (sourceDir !== buildDir) {
            if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
            ensureDir(path.dirname(buildDir));
            this.copyDirectory(backupDir, buildDir);
          }
          this.readInstalled();
          if (this.installedConfig.modules[moduleName]?.version !== previousInstalled.version) {
            this.installedConfig.modules[moduleName] = previousInstalled;
            let saved: boolean;
            try {
              saved = this.saveInstalled();
            } catch (error) {
              if (!(error instanceof FolderSyncError)) throw error;
              rollbackUnconfirmed = error;
              saved = true;
            }
            if (!saved) throw new Error('the installed modules list could not be saved');
          }
          restored = true;
        } catch (rollbackError) {
          console.error(`[AppStoreManager] Rollback failed:`, rollbackError);
        }

        const reason = installError instanceof Error ? installError.message : String(installError);
        if (!restored) {
          return { success: false, error: `Install failed: ${reason}. The previous version could not be restored; its backup is at ${backupDir}` };
        }
        if (rollbackUnconfirmed) {
          return { success: false, error: `Install failed: ${reason}. The previous version is back in place, but the list of installed modules can't be confirmed as saved: ${rollbackUnconfirmed.message} Its backup is kept at ${backupDir}.` };
        }

        // The backup is only removed once the previous version is back in place
        try {
          fs.rmSync(backupDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }

        return { success: false, error: `Install failed: ${reason}` };
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (lockHeld) {
        releaseStoreLock();
        if (storeLock.depth === 0) {
          this.reposFresh = false;
          this.installedFresh = false;
        }
      }
      // Always release the update lock
      this.updatesInProgress.delete(moduleName);
    }
  }

  /**
   * Decision 35's update on a Postgres bot: today's checks and the clone refresh under the store lock, the staged copy,
   * the publish outside the lock, then the apply in the bot; none of updateModule's own backup, remove, copy or
   * rollback runs (44).
   */
  private async updateModuleShared(moduleName: string): Promise<ModuleUpdateResult> {
    let hold: StoreMutexHold;
    let started: { version: string; sha: string | null } | null = null;
    try {
      hold = await takeStoreMutex();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      const prepared = this.locked((): Staged | ModuleUpdateResult => {
        this.readRepos();
        this.readInstalled();
        this.requireInstalledReadable();
        const installed = this.installedConfig.modules[moduleName];
        if (!installed) return { success: false, error: `Module ${moduleName} is not installed` };
        const record = readStoreRecord();
        started = { version: installed.version, sha: record.ok ? record.record.modules[moduleName]?.sha ?? null : null };
        const repo = this.getRepository(installed.installedFrom);
        if (!repo) return { success: false, error: `Repository ${installed.installedFrom} not found` };
        if (!fs.existsSync(path.join(getSourceModulesDir(), moduleName))) {
          return { success: false, error: `Module ${moduleName} has no files where it was installed, so it was not updated. Reinstall it from the App Store.` };
        }
        const moduleInfo = this.refreshRepositoryLocked(repo.id).find(m => m.manifest.name === moduleName);
        if (!moduleInfo) return { success: false, error: `Module ${moduleName} no longer exists in repository` };
        if (this.compareVersions(installed.version, moduleInfo.manifest.version) >= 0) return { success: true, newVersion: installed.version };
        takeAutoSnapshot(`update ${moduleName}`);
        const commitHash = this.getRepoCacheCommit(repo.id) || undefined;
        return this.stage('update', moduleName, moduleInfo, version => ({
          name: moduleName, version, installedFrom: repo.id, installedAt: new Date().toISOString(), commitHash,
        }));
      });
      if ('success' in prepared) return prepared;
      const answer = await this.publishStaged('update', moduleName, prepared);
      const change = await this.landPublished('update', moduleName, prepared, prepared.body, answer, hold);
      return { success: true, newVersion: prepared.version, published: change, ...(change.applied ? { applied: change.applied } : {}) };
    } catch (error) {
      if (error instanceof StoreWriteError && error.status === 202) return { success: false, error: error.message, unconfirmed: true };
      if (error instanceof StoreWriteError && error.status === 409) {
        const by = error.by ?? null;
        const elsewhere: ElsewhereChange = started ? await elsewhereChange(moduleName, started, by) : { kind: 'module', by };
        return { success: false, error: error.message, changedElsewhere: true, elsewhere };
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      hold.release();
    }
  }

  /**
   * Update all modules that have available updates
   */
  async updateAllModules(): Promise<{
    success: boolean;
    updated: Array<{ moduleName: string; oldVersion: string; newVersion: string; applied?: PublisherAnswer; published?: PublishedChange; listUnconfirmed?: string }>;
    failed: Array<{ moduleName: string; error: string; unconfirmed?: true; changedElsewhere?: true; elsewhere?: ElsewhereChange }>;
    checkErrors: Array<{ moduleName: string; error: string }>;
    skipped: Array<{ moduleName: string; reason: string }>;
  }> {
    const result = {
      success: true,
      updated: [] as Array<{ moduleName: string; oldVersion: string; newVersion: string; applied?: PublisherAnswer; published?: PublishedChange; listUnconfirmed?: string }>,
      failed: [] as Array<{ moduleName: string; error: string; unconfirmed?: true; changedElsewhere?: true; elsewhere?: ElsewhereChange }>,
      checkErrors: [] as Array<{ moduleName: string; error: string }>,
      skipped: [] as Array<{ moduleName: string; reason: string }>
    };

    // First, check for all updates
    const updateCheck = await this.checkAllModulesForUpdates();
    result.checkErrors = [...(updateCheck.errors || [])];
    const modulesWithUpdates = updateCheck.updates.filter(u => u.hasUpdate);

    if (modulesWithUpdates.length === 0) {
      return result;
    }

    // Update each module
    for (const moduleUpdate of modulesWithUpdates) {
      const oldVersion = moduleUpdate.installedVersion;
      const updateResult = await this.updateModule(moduleUpdate.moduleName);

      if (updateResult.success && updateResult.newVersion && updateResult.newVersion !== oldVersion) {
        result.updated.push({
          moduleName: moduleUpdate.moduleName,
          oldVersion,
          newVersion: updateResult.newVersion,
          ...(updateResult.applied ? { applied: updateResult.applied } : {}),
          ...(updateResult.published ? { published: updateResult.published } : {}),
          ...(updateResult.listUnconfirmed ? { listUnconfirmed: updateResult.listUnconfirmed } : {})
        });
        if (updateResult.listUnconfirmed) result.success = false;
      } else if (!updateResult.success) {
        result.failed.push({
          moduleName: moduleUpdate.moduleName,
          error: updateResult.error || 'Unknown error',
          ...(updateResult.unconfirmed ? { unconfirmed: true as const } : {}),
          ...(updateResult.changedElsewhere ? { changedElsewhere: true as const, ...(updateResult.elsewhere ? { elsewhere: updateResult.elsewhere } : {}) } : {})
        });
        result.success = false;
      } else {
        result.skipped.push({
          moduleName: moduleUpdate.moduleName,
          reason: `The repository changed but the version stayed ${oldVersion}, so the files were not replaced`
        });
      }
    }

    return result;
  }
}

/**
 * Get the singleton AppStoreManager instance
 */
export function getAppStoreManager(): AppStoreManager {
  if (!instance) {
    instance = new AppStoreManager();
  }
  return instance;
}
