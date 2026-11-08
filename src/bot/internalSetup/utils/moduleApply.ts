// Every module change on a machine of a Postgres bot (NB6 decisions 43, 45, 49, 58 to 61, 66, 67, 70, 80, 83, 89, 91
// to 93, 99 to 101, 109; C16, D10): the apply, its one way back (restoreModule), the boot's recovery of an apply a stop
// cut off, the status rows, the pass's module step and the answers a publishing caller gives. It runs in the bot
// process only, under the store mutex for its whole run; each synchronous part takes the store lock.

import * as fs from 'fs';
import * as path from 'path';
import type { Client } from 'discord.js';
import type { LoadedModule, ModuleManifest } from '../../types/moduleTypes';
import { dataPath } from '../../../utils/dataRoot';
import { getNodeId } from '../fleet/nodeIdentity';
import { getNodeName } from '../fleet/nodeName';
import { processId } from '../fleet/processId';
import { stagedHeld, storeMutex, withStoreLock, type StoreMutexHold } from './appStoreManager';
import { isStopping } from './dataManager';
import { databaseView, mainTagOf } from './dataBackends/mainDatabase';
import { beginReload, endReload, getLoadFailures, recordHeldBack, recordLoadFailure } from './loadFailures';
import { isMaintenanceGateClosed } from './maintenanceGate';
import {
  applyBootRule, applyOfStart, bootStartOf, closeWindow, crashLineOf, endStart, handToBootTurn, leaveOutAtBoot, onStartEnded, openStarts,
  openWindow, pruneCrashLines, startEndFailed, startFailureOf, startModule, startShaOf, startStateOf, type ModuleStart, type StartResult,
  type StartState,
} from './moduleCrashes';
import { ModuleLoader } from './moduleLoader';
import { getModuleRegistry } from './moduleRegistry';
import {
  heldBackText, isReloading, loadModuleUnmarked, markReloading, recompileTypeScript, unloadModuleUnmarked, unmarkReloading, type CompileResult,
} from './moduleReloader';
import { findModuleManifests, getBuildModulesDir, getModulesDir, getSourceModulesDir } from './pathHelpers';
import { stoppedServing } from './servingGate';
import { setSharedModulePassStep } from './sharedMirror';
import { fetchModule, moduleShaOf, readModuleFolder } from './sharedModules';
import { readStoreRecord, writeStoreRecord, type ApplyingIntent, type ModuleEntry, type PendingStatus, type StoreRecord } from './sharedRecords';
import { nodeOf, rowBackend, shaOf } from './sharedStore';

// ============================================================================
// THE CHANGE, ITS RESULT AND THE ANSWERS (decisions 43, 61, 65, 77, 91, 104, 109; C16, D10)
// ============================================================================

export interface ModuleChange {
  module: string;
  /** The row's module sha, or 'absent' for a removal. */
  to: string;
  /** 35's staged folder, used when its sha is `to`; else the rows are fetched. */
  source: string | 'rows';
  /** Where the live source folder goes. */
  displaced: 'backups' | 'superseded' | 'orphan';
  reason: 'install' | 'update' | 'uninstall' | 'remote' | 'boot' | 'pass';
  /** The main tag the change was read from (58): a publish's, or the pass's tag0. */
  tag: string | null;
  /** The row's version and updated_by for `to`. */
  version?: string | null;
  updatedBy?: string | null;
  /** The pass's move aside of a version this machine does not take now (49 step 4): its folder only goes aside. */
  keep?: 'failed' | 'retry';
}

export type ApplyReason = 'stopped-serving' | 'maintenance' | 'main-changed' | 'starting' | 'reload' | 'changed' | 'fetch' | 'busy';

export interface ApplyResult {
  outcome: 'applied' | 'failed' | 'deferred' | 'busy' | 'loaded';
  reason: ApplyReason | null;
  error: string | null;
  loaded: boolean;
  /** 'starting': the start's state, for T18. */
  state?: StartState;
  /** A failed apply: whether the previous version is back and loaded ('previous'), there was none ('none'), or it failed too. */
  kept?: 'previous' | 'none' | 'failed-too';
  /** 'failed-too': why the previous version did not load either. */
  previousError?: string;
  /** An uninstall whose unload failed: the module keeps running until the bot restarts. */
  unloadFailed?: string;
}

const deferred = (reason: ApplyReason, error: string | null = null, state?: StartState): ApplyResult =>
  ({ outcome: reason === 'busy' ? 'busy' : 'deferred', reason, error, loaded: false, ...(state ? { state } : {}) });

type Operation = 'install' | 'update' | 'uninstall';

/** T37 (C16 as D10 words it): the publishing caller's answer when this process stopped serving its shards. */
export function stoppedServingText(operation: Operation, module: string, version: string): string {
  if (operation === 'uninstall') {
    return `${module} was uninstalled. This machine's bot process stopped serving its shards and restarts; it tries to remove the module's files after that restart.`;
  }
  return `${module} ${version} was ${operation === 'install' ? 'installed' : 'updated'}. This machine's bot process stopped serving its shards and restarts; it tries to load the module after that restart.`;
}

const STARTING_REASONS: Record<'a' | 'c' | 'd', (module: string) => string> = {
  a: () => 'its start-up code is still running, and the bot waits for it for at most 10 minutes after it began',
  c: () => 'its start-up code runs once the bot has connected to Discord, loaded its data and started the modules before it, and the bot waits for it for at most 10 minutes',
  d: module => `it is loading ${module} right now`,
};

/** When this machine next tries a module whose apply threw: after the bot's next start (state (e)), after `retryAt`, or at the next pass. */
export type ApplyLater = { kind: 'start' } | { kind: 'after'; at: number } | { kind: 'pass' };

export function applyLaterOf(module: string): ApplyLater {
  if (startStateOf(module) === 'e') return { kind: 'start' };
  const read = readStoreRecord();
  const retryAt = read.ok ? read.record.modules[module]?.retryAt ?? null : null;
  return retryAt !== null && retryAt > Date.now() ? { kind: 'after', at: retryAt } : { kind: 'pass' };
}

/**
 * T18 (61, 65, 77, 104, 109): the publishing caller's answer for an apply that ended 'deferred' or 'busy'. Null for
 * the reasons other texts answer: 'stopped-serving' (T37) and 'maintenance' (T7's in-maintenance form).
 */
export function deferredText(operation: Operation, module: string, version: string, result: ApplyResult): string | null {
  if (result.outcome !== 'deferred' && result.outcome !== 'busy') return null;
  if (result.reason === 'stopped-serving' || result.reason === 'maintenance') return null;
  const done = `${module} ${version} was ${operation === 'install' ? 'installed' : 'updated'}.`;
  const at = (reason: string): string =>
    operation === 'uninstall' ? `${module} was uninstalled. This machine removes its files at its next pass (${reason}).` : `${done} This machine applies it at its next pass (${reason}).`;
  const current = (reason: string): string =>
    operation === 'uninstall'
      ? `${module} was uninstalled. This machine removes its files at its next pass (${reason}).`
      : `${done} This machine applies the database's current version of ${module} at its next pass (${reason}).`;
  switch (result.reason) {
    case 'busy':
      return at('another App Store change was still running on this machine');
    case 'reload':
      return at(`a reload of ${module} was still running`);
    case 'changed':
      return current("the database's version changed while it was being applied");
    case 'main-changed':
      return current('the main database changed');
    case 'fetch':
      return at(result.error ?? 'the database did not answer');
    case 'starting': {
      const state = result.state ?? 'd';
      if (operation === 'uninstall') {
        return at(state === 'e' || state === 'f' ? `this machine was still starting ${module}` : STARTING_REASONS[state](module));
      }
      if (state === 'e') {
        return `${done} Finishing the last change of ${module} failed on this machine (see the bot's log), so it applies the database's current version of ${module} after the bot's next start.`;
      }
      if (state === 'f') {
        return `${done} This machine is still finishing its last change of ${module}; it applies the database's current version of ${module} at the first pass after that finishes, or after the bot's next start if finishing fails.`;
      }
      return `${done} This machine applies the database's current version of ${module} at the first pass after it finishes starting ${module} (${STARTING_REASONS[state](module)}).`;
    }
    default:
      return null;
  }
}

/** What an in-bot publishing caller answers after its apply (61, 91): the result, and the text for any outcome but 'applied'. */
export interface PublisherAnswer {
  outcome: ApplyResult['outcome'];
  reason: ApplyReason | null;
  error: string | null;
  loaded: boolean;
  starting?: true;
  text: string | null;
}

/**
 * Decision 61's answers for the publishing caller in the bot: 'applied' today's success (no text); 'failed' T9; 'loaded'
 * T30; 'stopped-serving' T37; 'maintenance' T7's in-maintenance form; any other 'deferred' or 'busy' T18.
 */
export function publisherAnswer(operation: Operation, module: string, version: string, result: ApplyResult): PublisherAnswer {
  const answer = (text: string | null): PublisherAnswer => ({
    outcome: result.outcome, reason: result.reason, error: result.error, loaded: result.loaded, ...(result.outcome === 'loaded' ? { starting: true as const } : {}), text,
  });
  const done = operation === 'install' ? 'installed' : 'updated';
  switch (result.outcome) {
    case 'applied':
      return answer(null);
    case 'failed': {
      const tail = 'The other machines try it when they apply it, and the App Store tab lists each machine where it fails.';
      if (result.kept === 'failed-too') {
        return answer(`${module} ${version} was ${done}, but it failed to load on this machine (${result.error}), and the previous version did not load either (${result.previousError ?? "see the bot's log"}), so this machine runs without ${module} until a version loads. ${tail}`);
      }
      return answer(`${module} ${version} was ${done}, but it failed to load on this machine (${result.error}), so this machine keeps ${result.kept === 'previous' ? 'the previous version' : 'no copy of it'}. ${tail}`);
    }
    case 'loaded': {
      const read = readStoreRecord();
      const from = read.ok ? read.record.modules[module]?.applying?.from : undefined;
      const keeps = from && from !== 'absent' ? 'the previous version' : `no copy of ${module}`;
      return answer(`${module} ${version} was ${done} and loaded on this machine, and its start-up code is still running. The App Store tab lists this machine if that code fails within 10 minutes; this machine then keeps ${keeps}.`);
    }
    default:
      break;
  }
  if (result.reason === 'stopped-serving') return answer(stoppedServingText(operation, module, version));
  if (result.reason === 'maintenance') {
    if (operation === 'uninstall') return answer(`${module} was uninstalled. This machine's bot is in maintenance, so it removes the module's files when maintenance ends.`);
    const head = operation === 'install' ? `${module} ${version} was installed.` : `${module} was updated to ${version}.`;
    return answer(`${head} This machine's bot is in maintenance, so it applies the module when maintenance ends.`);
  }
  return answer(deferredText(operation, module, version, result));
}

// ============================================================================
// FOLDERS
// ============================================================================

interface ModuleDirs {
  source: string;
  build: string;
  dist: string;
  /** The backups folder under the store's cache. */
  backups: string;
  /** `.build-complete` in the dist root (59). */
  buildFile: string;
}

let dirsGiven: ModuleDirs | null = null;

function dirs(): ModuleDirs {
  if (dirsGiven) return dirsGiven;
  const dist = getModulesDir();
  return {
    source: getSourceModulesDir(),
    build: getBuildModulesDir(),
    dist,
    backups: dataPath('global', 'appstore', 'cache', 'backups'),
    buildFile: path.resolve(dist, '..', '..', '.build-complete'),
  };
}

/** Tests name temp folders for the source, build and dist trees, as production keeps them apart. */
export function _setModuleDirs(given: ModuleDirs | null): void {
  dirsGiven = given;
}

const exists = (p: string): boolean => fs.existsSync(p);

/** The module sha of a folder's content (C1), or 'absent'. */
export function folderSha(dir: string): string {
  if (!exists(dir)) return 'absent';
  return moduleShaOf(readModuleFolder(dir).map(f => ({ rel: f.rel, sha: shaOf(f.bytes) })));
}

function freePath(base: string): string {
  if (!exists(base)) return base;
  for (let n = 1; ; n += 1) {
    if (!exists(`${base}-${n}`)) return `${base}-${n}`;
  }
}

function moveFolder(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EXDEV') throw error;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

function copyFolder(from: string, to: string): void {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

const sameDir = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

/** The build and dist folders of a module deleted where they are not its source folder (43 step 3, 58 a). */
function clearCompiled(module: string): void {
  const d = dirs();
  const source = path.join(d.source, module);
  for (const root of [d.build, d.dist]) {
    const dir = path.join(root, module);
    if (!sameDir(dir, source)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Production: the source folder copied whole into the emptied build folder (43 step 3, 58 d). */
function copyToBuild(module: string): void {
  const d = dirs();
  const source = path.join(d.source, module);
  const build = path.join(d.build, module);
  if (sameDir(source, build) || !exists(source)) return;
  copyFolder(source, build);
}

function placeOf(displaced: ApplyingIntent['displaced'], module: string, at: number): string {
  const d = dirs();
  if (displaced === 'superseded') return freePath(dataPath('_superseded', `shared-${at}`, 'appstore-modules', module));
  if (displaced === 'orphan') return freePath(path.join(d.backups, `${module}-${at}-orphan`));
  return freePath(path.join(d.backups, `${module}-${at}`));
}

function buildIdNow(): string | null {
  try {
    return fs.readFileSync(dirs().buildFile, 'utf8');
  } catch {
    return null;
  }
}

function mainTag(): string | null {
  const view = databaseView();
  return view && view.generation !== null ? mainTagOf(view.generation, view.machine) : null;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ============================================================================
// THE RECORD
// ============================================================================

function readRecord(): StoreRecord {
  const read = readStoreRecord();
  if (!read.ok) throw new Error(read.reason);
  return read.record;
}

function emptyEntry(): ModuleEntry {
  return { sha: 'absent', stamp: null, files: {}, main: null, built: null, failedSha: null, retryAt: null, heldSha: null, status: null, applying: null };
}

function nextStatus(record: StoreRecord, state: PendingStatus['state'], sha: string, error: string | null): PendingStatus {
  const seq = (record.statusSeq ?? 0) + 1;
  record.statusSeq = seq;
  return { state, sha, error, at: new Date().toISOString(), seq };
}

// ============================================================================
// THE STATUS ROWS (decisions 58, 70 and 83)
// ============================================================================

export const MODULE_STATUS_SQL = `INSERT INTO smdb_data.shared_module_status (module, node_id, node_name, sha, state, error, at, process_id, seq)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (module, node_id) DO UPDATE SET node_name = EXCLUDED.node_name, sha = EXCLUDED.sha, state = EXCLUDED.state,
    error = EXCLUDED.error, at = EXCLUDED.at, process_id = EXCLUDED.process_id, seq = EXCLUDED.seq
  WHERE smdb_data.shared_module_status.process_id <> EXCLUDED.process_id OR smdb_data.shared_module_status.seq < EXCLUDED.seq`;

/** One upsert of this machine's row; an answer clears the entry's status when it still holds the one sent. */
async function sendStatus(module: string, status: PendingStatus): Promise<boolean> {
  const backend = rowBackend();
  if (!backend) return false;
  let answered = false;
  try {
    const out = await backend.sharedTx({
      check: null,
      statements: () => [{
        text: MODULE_STATUS_SQL,
        values: [module, getNodeId(), getNodeName(), status.sha, status.state, status.error, status.at, processId(), status.seq],
      }],
    });
    answered = out.kind === 'committed';
  } catch {
    answered = false;
  }
  if (!answered) return false;
  try {
    withStoreLock(() => {
      const read = readStoreRecord();
      if (!read.ok) return;
      const entry = read.record.modules[module];
      if (!entry?.status || entry.status.seq !== status.seq) return;
      read.record.modules[module] = { ...entry, status: null };
      writeStoreRecord(read.record);
    });
  } catch {
    // The status stays in the entry, and the pass sends it again (70).
  }
  return true;
}

/** The upsert after an entry write, when the main is still the entry's (70); otherwise the pass's step 0 drops it. */
async function statusAfterWrite(module: string): Promise<void> {
  const read = readStoreRecord();
  const entry = read.ok ? read.record.modules[module] : undefined;
  if (!entry?.status || entry.main !== mainTag()) return;
  await sendStatus(module, entry.status);
}

// ============================================================================
// THE LOGS (T1 to T6, T11's module tails, decision 33's)
// ============================================================================

const machineOf = (intent: ApplyingIntent): string => nodeOf(intent.updatedBy ?? '');
const versionOf = (intent: ApplyingIntent): string => intent.version ?? intent.to;

function logFailed(module: string, intent: ApplyingIntent, error: string, kept: 'previous' | 'none'): void {
  const keeps = kept === 'previous' ? 'the previous version' : 'no copy of it';
  console.error(`[Shared] ${module} ${versionOf(intent)} from ${machineOf(intent)} failed to load on this machine (${error}); this machine keeps ${keeps} and does not try ${versionOf(intent)} again until ${module} is updated, or uninstalled and installed again`);
}

function logFailedHeld(module: string, intent: ApplyingIntent, error: string): void {
  console.error(`[Shared] ${module} ${versionOf(intent)} from ${machineOf(intent)} failed to load on this machine (${error}); this machine does not try ${versionOf(intent)} again until ${module} is updated, or uninstalled and installed again. It keeps the previous version on disk but does not load it: that version is held back after the bot stopped twice while it was starting it`);
}

function logBothFailed(module: string, intent: ApplyingIntent, error: string, second: string): void {
  console.error(`[Shared] ${module} ${versionOf(intent)} from ${machineOf(intent)} failed to load on this machine (${error}), and the previous version did not load either (${second}); this machine runs without ${module} until a version loads`);
}

function logRetry(module: string, intent: ApplyingIntent, error: string, kept: 'previous' | 'none', retryAt: number): void {
  const keeps = kept === 'previous' ? 'the previous version' : 'no copy of it';
  console.error(`[Shared] ${module} ${versionOf(intent)} could not be compiled on this machine (${error}); this machine keeps ${keeps} and tries again after ${new Date(retryAt).toISOString()}`);
}

const T11_WRITTEN = "the database's version is back in its place";
const T11_NO_ROW = 'the database holds no such file, so nothing was put back';
const T11_APPLY_FAILED = 'the database\'s version failed to load on this machine (see the line above)';

function t11Head(file: string, dest: string, head: 'a' | 'b'): string {
  if (head === 'a') {
    return `[Shared] Moved ${file} to ${dest}: it differed from the version this machine last took from the database (changed outside the bot, or left by a crash); `;
  }
  const view = databaseView();
  return `[Shared] Moved ${file} to ${dest}: it held the version this machine took from the database before the switch to ${view?.machine ?? ''} (generation ${view?.generation ?? 0}); `;
}

function t11KeepTail(module: string, keep: 'failed' | 'retry', version: string, entry: ModuleEntry | undefined): string {
  if (keep === 'failed') {
    return `the database's version ${version} failed to load on this machine before, so this machine has no copy of ${module} until it is updated, or uninstalled and installed again`;
  }
  return `the database's version ${version} could not be compiled on this machine, so this machine has no copy of ${module} until it tries again after ${new Date(entry?.retryAt ?? Date.now()).toISOString()}`;
}

// ============================================================================
// restoreModule, THE ONE WAY BACK (decisions 58, 66, 80)
// ============================================================================

/** 'swap': the apply's own swap threw; a change to a version waits 10 minutes (`retryAt`), no status or hold is written and nothing is logged (its caller answers). */
export type RestoreWhy = 'failed' | 'retry' | 'interrupted' | 'swap';

export interface Restored {
  intent: ApplyingIntent;
  /** The version put back: `from`, or 'absent'. */
  version: string;
  /** How: kept in place (b), renamed back or copied from a backup (c (i), (ii)), or nothing. */
  how: 'kept' | 'renamed' | 'copied' | 'none';
  from: string | null;
  retryAt: number | null;
}

const RETRY_MS = 10 * 60_000;

/**
 * Steps a to e of 58 under the store lock in one synchronous block: the compiled folders emptied, the live folder kept
 * or set aside, the previous version put back, the build folder filled, the entry written without `applying`. For
 * 'interrupted' it logs T4 or T5 (66's table), and T1's crash form at a second count.
 */
export function restoreModule(module: string, why: RestoreWhy, error: string | null): Restored {
  return withStoreLock(() => {
    const d = dirs();
    const record = readRecord();
    const entry = record.modules[module];
    const A = entry?.applying;
    if (!entry || !A) throw new Error(`${module} has no apply to put back`);
    const at = Date.now();
    clearCompiled(module);
    const live = path.join(d.source, module);
    let how: Restored['how'] = 'none';
    let from: string | null = null;
    if (exists(live)) {
      if (A.from !== 'absent' && folderSha(live) === A.from) how = 'kept';
      else moveFolder(live, freePath(path.join(d.backups, `${module}-${at}-${why === 'interrupted' ? 'interrupted' : 'failed'}`)));
    }
    if (A.from !== 'absent' && how === 'none') {
      if (A.displaced === 'backups' && A.backup && exists(A.backup) && folderSha(A.backup) === A.from) {
        moveFolder(A.backup, live);
        how = 'renamed';
        from = A.backup;
      } else {
        const copy = newestCopy(module, A.from);
        if (copy) {
          copyFolder(copy, live);
          how = 'copied';
          from = copy;
        }
      }
    }
    if (how === 'kept') from = live;
    const version = how === 'none' ? 'absent' : A.from;
    if (version !== 'absent') copyToBuild(module);

    let failedSha = entry.failedSha;
    let retryAt = entry.retryAt;
    let status: PendingStatus | null = entry.status ?? null;
    let line: ReturnType<typeof crashLineOf> = null;
    if (why === 'failed') {
      failedSha = A.to;
      status = nextStatus(record, 'failed', A.to, error);
    } else if (why === 'retry') {
      retryAt = at + RETRY_MS;
      status = nextStatus(record, 'failed', A.to, error);
    } else if (why === 'swap') {
      if (A.to !== 'absent') retryAt = at + RETRY_MS;
    } else if (why === 'interrupted') {
      line = crashLineOf(module);
      if (line && line.sha !== A.to) line = null;
      if (line && line.n >= 2) {
        failedSha = A.to;
        status = nextStatus(record, 'failed', A.to, `the bot stopped twice while it was starting it (${line.error})`);
      }
    }
    const next: ModuleEntry = {
      sha: version,
      stamp: null,
      files: {},
      main: A.tag,
      built: null,
      failedSha,
      retryAt,
      heldSha: entry.heldSha ?? null,
      status,
      applying: null,
    };
    if (next.sha === 'absent' && next.failedSha === null && next.retryAt === null && next.status === null) delete record.modules[module];
    else record.modules[module] = next;
    writeStoreRecord(record);
    if (why === 'interrupted') logInterrupted(module, A, how, from, line);
    return { intent: A, version, how, from, retryAt };
  });
}

/** The newest backup of the module, not an orphan, whose content hashes to sha (58 c (ii)). */
function newestCopy(module: string, sha: string): string | null {
  const root = dirs().backups;
  if (!exists(root)) return null;
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith(`${module}-`) && !e.name.endsWith('-orphan'))
    .map(e => path.join(root, e.name))
    .map(p => ({ p, at: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { p } of candidates) {
    try {
      if (folderSha(p) === sha) return p;
    } catch {
      continue;
    }
  }
  return null;
}

function logInterrupted(module: string, A: ApplyingIntent, how: Restored['how'], from: string | null, line: ReturnType<typeof crashLineOf>): void {
  const version = versionOf(A);
  const cause = line ? `when the bot stopped while it was starting ${version}` : 'when the bot process ended';
  const noCopy = A.from !== 'absent' && how === 'none';
  const keeps = noCopy || A.from === 'absent' ? 'no copy of it' : 'the previous version';
  const again = ` This machine applies the database's current version of ${module} again at this start`;
  const tail = !line ? `${again}.` : line.n === 1 ? `${again}; if the bot stops again while starting ${version}, this machine keeps ${keeps}.` : '';
  if (noCopy) {
    console.error(`[Shared] ${module}: applying ${version} was cut off ${cause}, and no copy of the previous version was found, so this machine has no copy of ${module}.${tail}`);
  } else {
    const put = how === 'kept' ? 'kept the previous version in place' : how === 'none' ? 'nothing was put back: there was no previous version' : `put back the previous version from ${from}`;
    console.error(`[Shared] ${module}: applying ${version} was cut off ${cause}; ${put}.${tail}`);
  }
  if (line && line.n >= 2) {
    const kept = noCopy || A.from === 'absent' ? `no copy of ${module}` : 'the previous version';
    console.error(`[Shared] The bot stopped twice while it was starting ${module} ${version} on this machine (the error at the second stop: ${line.error}); this machine keeps ${kept} and does not try ${version} again until ${module} is updated, or uninstalled and installed again`);
  }
}

/**
 * Decision 45 step (1) with 66's boot rule, in one block under the store lock: every entry an apply left with
 * `applying` is put back ('interrupted'), then a version in place whose crash line reached 2 is held.
 */
export function recoverModuleApplies(): void {
  try {
    withStoreLock(() => {
      const read = readStoreRecord();
      if (!read.ok) {
        console.error(`[Shared] Did not recover the module applies: ${read.reason}`);
        return;
      }
      for (const [module, entry] of Object.entries(read.record.modules)) {
        if (!entry?.applying) continue;
        try {
          restoreModule(module, 'interrupted', null);
        } catch (error) {
          startEndFailed({ module }, error);
        }
      }
      applyBootRule();
    });
  } catch (error) {
    const read = readStoreRecord();
    const unfinished = read.ok ? Object.keys(read.record.modules).filter(module => read.record.modules[module]?.applying).sort() : [];
    for (const module of unfinished) leaveOutAtBoot(module);
    const tail = unfinished.length > 0 ? `; the modules with an unfinished update (${unfinished.join(', ')}) are not loaded at this start` : '';
    console.error(`[Shared] Did not recover the module applies: ${messageOf(error)}${tail}`);
  }
}

// ============================================================================
// THE APPLY (decision 43 as 58 to 61, 66, 67, 80, 91 and 93 amend it; C16)
// ============================================================================

const RELOAD_WAIT_MS = 60_000;
const RELOAD_POLL_MS = 200;

let applyClient: Client | null = null;
/** Modules whose apply runs now in this process. */
const applyRuns = new Set<string>();
/** The boot's applies stop after their swap until the boot compile (45 step (3)). */
let bootSwaps = false;
/** The modules this boot swapped, with their swap for T11's tail. */
const bootApplied = new Map<string, Swapped>();

/** The bot's Discord client, for the apply's loads; set once the bot has one. */
export function setModuleApplyClient(client: Client | null): void {
  applyClient = client;
}

/** 43 step 1's gates in C16's order: stopped serving, maintenance, the main tag, then the module's start. */
function gateOf(change: ModuleChange): ApplyResult | null {
  if (stoppedServing()) return deferred('stopped-serving');
  if (isMaintenanceGateClosed()) return deferred('maintenance');
  if (mainTag() !== change.tag) return deferred('main-changed');
  if (!applyRuns.has(change.module)) {
    const state = startStateOf(change.module);
    if (state) return deferred('starting', null, state);
  }
  return null;
}

async function reloadEnded(module: string): Promise<boolean> {
  const until = Date.now() + RELOAD_WAIT_MS;
  while (isReloading(module)) {
    if (Date.now() >= until) return false;
    await new Promise(resolve => setTimeout(resolve, RELOAD_POLL_MS));
  }
  return true;
}

/**
 * Applies one module change. Given a hold of the store mutex it runs inside it; given none it takes the mutex, and a
 * wait over 60 s ends 'busy' with nothing touched (61). It never throws for a refusal: each ends in its result.
 */
export async function applyModuleChange(change: ModuleChange, hold?: StoreMutexHold): Promise<ApplyResult> {
  const gate = gateOf(change);
  if (gate) return gate;
  let mine: StoreMutexHold | null = null;
  if (!hold) {
    mine = await storeMutex.acquire();
    if (!mine) return deferred('busy');
  }
  try {
    const again = gateOf(change);
    if (again) return again;
    if (!(await reloadEnded(change.module))) return deferred('reload');
    markReloading(change.module);
    applyRuns.add(change.module);
    beginReload();
    try {
      return await run(change);
    } finally {
      endReload();
      applyRuns.delete(change.module);
      unmarkReloading(change.module);
    }
  } finally {
    mine?.release();
  }
}

interface Swapped {
  intent: ApplyingIntent;
  /** T11's head when the live folder went to `_superseded`. */
  aside: 'a' | 'b' | null;
  live: string;
}

async function run(change: ModuleChange): Promise<ApplyResult> {
  const d = dirs();
  const { module } = change;
  let incoming: string | null = null;
  if (change.to !== 'absent') {
    if (change.source !== 'rows' && exists(change.source) && folderSha(change.source) === change.to) {
      incoming = change.source;
    } else {
      const into = path.join(d.source, `.incoming-${module}-${Date.now()}`);
      const fetched = await fetchModule(module, into);
      if (!fetched.ok || fetched.sha !== change.to) {
        fs.rmSync(into, { recursive: true, force: true });
        return fetched.ok ? deferred('changed') : deferred('fetch', fetched.cause);
      }
      incoming = into;
    }
  }

  const swapped = withStoreLock((): Swapped => {
    const record = readRecord();
    const entry = record.modules[module];
    const live = path.join(d.source, module);
    const c = folderSha(live);
    let from: string;
    let displaced = change.displaced;
    let aside: Swapped['aside'] = null;
    if (c === 'absent') {
      from = 'absent';
    } else if (entry ? c === entry.sha : false) {
      from = c;
      if (displaced === 'superseded') aside = 'b';
    } else {
      from = 'absent';
      if (displaced !== 'orphan') {
        displaced = 'superseded';
        aside = 'a';
      }
    }
    const at = Date.now();
    const backup = c === 'absent' ? null : placeOf(displaced, module, at);
    const intent: ApplyingIntent = {
      from,
      to: change.to,
      backup,
      displaced,
      tag: change.tag,
      version: change.to === 'absent' ? null : change.version ?? null,
      updatedBy: change.to === 'absent' ? null : change.updatedBy ?? null,
    };
    record.modules[module] = { ...(entry ?? emptyEntry()), built: null, applying: intent };
    writeStoreRecord(record);
    let movedIn = false;
    try {
      if (backup) moveFolder(live, backup);
      clearCompiled(module);
      if (incoming) {
        moveFolder(incoming, live);
        movedIn = true;
        copyToBuild(module);
      }
    } catch (error) {
      // The folder moved in holds only the row's bytes, which the database keeps (R3-F1); one left behind is set aside.
      try {
        if (movedIn) fs.rmSync(live, { recursive: true, force: true });
        else if (incoming && incoming !== change.source) fs.rmSync(incoming, { recursive: true, force: true });
      } catch { /* restoreModule sets a folder left in place aside */ }
      try {
        restoreModule(module, 'swap', null);
      } catch (again) {
        startEndFailed({ module }, again);
      }
      throw error;
    }
    return { intent, aside, live };
  });

  if (change.to === 'absent') return removal(change, swapped);
  if (bootSwaps) {
    // 45 step (3): swapped only; the boot compile and the load check take it from here.
    bootApplied.set(module, swapped);
    return { outcome: 'loaded', reason: null, error: null, loaded: false };
  }
  return load(change, swapped);
}

/** 43's removal: the module unloaded (T6 when that fails), the entry dropped last; the backup stays. */
async function removal(change: ModuleChange, swapped: Swapped): Promise<ApplyResult> {
  const { module } = change;
  const { intent } = swapped;
  let unloadError: string | null = null;
  if (applyClient) {
    const out = await unloadModuleUnmarked(applyClient, module);
    if (!out.success) unloadError = out.error ?? 'the unload failed';
  }
  withStoreLock(() => {
    const record = readRecord();
    const entry = record.modules[module];
    if (change.keep && entry) record.modules[module] = { ...entry, sha: 'absent', stamp: null, files: {}, built: null, applying: null };
    else delete record.modules[module];
    writeStoreRecord(record);
  });
  if (unloadError !== null) {
    console.error(`[Shared] ${module} was removed from this machine's files, but unloading it failed (${unloadError}); it keeps running until the bot restarts`);
  }
  if (intent.backup && intent.displaced === 'orphan') {
    console.log(`[Shared] Moved the module folder ${module} to ${intent.backup}: the database does not list it as installed`);
  } else if (intent.backup && swapped.aside) {
    const entry = readStoreRecord();
    const kept = entry.ok ? entry.record.modules[module] : undefined;
    const tail = change.keep ? t11KeepTail(module, change.keep, change.version ?? '', kept) : T11_NO_ROW;
    console.error(`${t11Head(swapped.live, intent.backup, swapped.aside)}${tail}`);
  }
  return { outcome: 'applied', reason: null, error: null, loaded: false, ...(unloadError === null ? {} : { unloadFailed: unloadError }) };
}

const ownFile = (file: string, module: string): boolean => `/${file}`.includes(`/bot/modules/${module}/`);

/** Steps 4 to 6, or the failure path. */
async function load(change: ModuleChange, swapped: Swapped): Promise<ApplyResult> {
  const { module } = change;
  const compile = await recompileTypeScript();
  const own = compile.diagnostics.filter(diag => ownFile(diag.file, module));
  if (!compile.success && compile.diagnostics.length === 0) {
    return failurePath(module, swapped, 'retry', compile.error ?? 'the compile failed');
  }
  if (own.length > 0) {
    return failurePath(module, swapped, 'failed', `${own[0].file}:${own[0].line} ${own[0].text}`);
  }
  if (!applyClient) return failurePath(module, swapped, 'failed', 'this process has no Discord client to load the module with');
  if (stoppedServing()) return deferred('stopped-serving');
  const before = new Set(getLoadFailures());
  const loaded = await loadModuleUnmarked(applyClient, module);
  if (!loaded.success && stoppedServing()) return deferred('stopped-serving');
  const distDir = path.resolve(dirs().dist, module);
  const fresh = getLoadFailures().filter(f => !before.has(f) && (f === module || path.resolve(f).startsWith(distDir + path.sep)));
  const turnFailure = loaded.success && loaded.start && !loaded.late ? startFailureOf(loaded.start) : undefined;
  if (!loaded.success || fresh.length > 0 || turnFailure !== undefined) {
    const error = loaded.error ?? turnFailure ?? `${module} recorded a load failure`;
    // Decisions 91 and 99: a late start whose success test failed is ended here; its late task then returns at once.
    if (loaded.start && loaded.late) await endStart(loaded.start, { failed: new Error(error) });
    return failurePath(module, swapped, 'failed', error);
  }
  if (loaded.late) {
    logAside(swapped, T11_WRITTEN);
    return { outcome: 'loaded', reason: null, error: null, loaded: true };
  }
  await finishApply(module);
  logAside(swapped, T11_WRITTEN);
  return { outcome: 'applied', reason: null, error: null, loaded: true };
}

function logAside(swapped: Swapped, tail: string): void {
  if (swapped.aside && swapped.intent.backup) console.error(`${t11Head(swapped.live, swapped.intent.backup, swapped.aside)}${tail}`);
}

/**
 * 43 step 6 under the store lock: the entry of `to` without `applying`, written last; then the status upsert; then the
 * backup deleted only when it holds `from`, a version the database held.
 */
export async function finishApply(module: string): Promise<void> {
  const intent = withStoreLock((): ApplyingIntent | null => {
    const record = readRecord();
    const entry = record.modules[module];
    const A = entry?.applying;
    if (!entry || !A) return null;
    record.modules[module] = {
      sha: A.to,
      stamp: null,
      files: {},
      main: A.tag,
      built: { sha: A.to, buildId: buildIdNow() },
      failedSha: null,
      retryAt: null,
      heldSha: null,
      status: nextStatus(record, 'applied', A.to, null),
      applying: null,
    };
    writeStoreRecord(record);
    return A;
  });
  if (!intent) return;
  await statusAfterWrite(module);
  withStoreLock(() => {
    if (intent.backup && intent.from !== 'absent' && exists(intent.backup) && folderSha(intent.backup) === intent.from) {
      fs.rmSync(intent.backup, { recursive: true, force: true });
    }
  });
}

/**
 * 43's failure path: `restoreModule(entry, why)`, then 58 f: the restored version compiled and loaded (or, held, only
 * compiled); T1, T2 or T3; then the status upsert.
 */
async function failurePath(module: string, swapped: Swapped, why: 'failed' | 'retry', error: string): Promise<ApplyResult> {
  const restored = restoreModule(module, why, error);
  const { kept, second } = await afterRestore(module, restored, why, error);
  if (kept === 'stopped') return deferred('stopped-serving');
  logAside(swapped, T11_APPLY_FAILED);
  await statusAfterWrite(module);
  return { outcome: 'failed', reason: null, error, loaded: false, kept, ...(second === undefined ? {} : { previousError: second }) };
}

/** 58 f in a running bot. */
async function afterRestore(module: string, restored: Restored, why: 'failed' | 'retry', error: string): Promise<{ kept: 'previous' | 'none' | 'failed-too' | 'stopped'; second?: string }> {
  const A = restored.intent;
  if (restored.version === 'absent') {
    if (why === 'failed') logFailed(module, A, error, 'none');
    else logRetry(module, A, error, 'none', restored.retryAt ?? Date.now());
    return { kept: 'none' };
  }
  const compile: CompileResult = await recompileTypeScript();
  const own = compile.diagnostics.filter(diag => ownFile(diag.file, module));
  const compiled = compile.success || (compile.diagnostics.length > 0 && own.length === 0);
  const heldNow = (() => {
    const read = readStoreRecord();
    return read.ok && read.record.modules[module]?.heldSha === restored.version;
  })();
  let second: string | null = compiled ? null : own.length > 0 ? `${own[0].file}:${own[0].line} ${own[0].text}` : compile.error ?? 'the compile failed';
  if (heldNow) {
    if (compiled) setBuilt(module, restored.version);
    recordHeldBack(module);
    console.error(heldBackText(module, manifestVersion(module) ?? restored.version).log);
    if (why === 'failed') logFailedHeld(module, A, error);
    else logRetry(module, A, error, 'previous', restored.retryAt ?? Date.now());
    return { kept: 'previous' };
  }
  if (second === null) {
    if (!applyClient) second = 'this process has no Discord client to load the module with';
    else {
      const loaded = await loadModuleUnmarked(applyClient, module);
      // C16: a load that fails while this process stopped serving is no load failure of the previous version.
      if (!loaded.success && stoppedServing()) return { kept: 'stopped' };
      if (!loaded.success) second = loaded.error ?? 'the load failed';
    }
  }
  if (second === null) {
    setBuilt(module, restored.version);
    if (why === 'failed') logFailed(module, A, error, 'previous');
    else logRetry(module, A, error, 'previous', restored.retryAt ?? Date.now());
    return { kept: 'previous' };
  }
  if (applyClient) await unloadModuleUnmarked(applyClient, module);
  const both = `${error}; the previous version did not load either (${second})`;
  withStoreLock(() => {
    const record = readRecord();
    const entry = record.modules[module];
    if (!entry) return;
    record.modules[module] = { ...entry, built: null, status: nextStatus(record, 'failed', A.to, both) };
    writeStoreRecord(record);
  });
  if (why === 'failed') logBothFailed(module, A, error, second);
  else logRetry(module, A, error, 'previous', restored.retryAt ?? Date.now());
  return { kept: 'failed-too', second };
}

/** The version the live source folder's manifest names; null when it cannot be read. */
function manifestVersion(module: string): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dirs().source, module, 'module.json'), 'utf8'));
    return typeof manifest?.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

function setBuilt(module: string, sha: string): void {
  withStoreLock(() => {
    const record = readRecord();
    const entry = record.modules[module];
    if (!entry || entry.sha !== sha) return;
    record.modules[module] = { ...entry, built: { sha, buildId: buildIdNow() } };
    writeStoreRecord(record);
  });
}

// ============================================================================
// A START'S END (decisions 89, 91, 99 and 101)
// ============================================================================

/**
 * An apply's start that ended at boot, or after its turn passed: 'ok' or 'bound' finish the apply; a rejection takes
 * 67's failure path holding the store mutex and the reload mark, both released in a `finally` (101). A start ended
 * inside its turn in a running bot is the apply's own run's, and `{ failed }` is the caller's own failure path.
 */
async function onApplyStartEnded(start: ModuleStart, result: StartResult): Promise<void> {
  if (result === 'replaced' || (typeof result === 'object' && 'failed' in result)) return;
  if (!applyOfStart(start)) return;
  if (!start.boot && !start.late) return;
  if (result === 'ok' || result === 'bound') {
    await finishApply(start.module);
    return;
  }
  const error = messageOf((result as { rejected: unknown }).rejected);
  if (getModuleRegistry().getModule(start.module)) await getModuleRegistry().unloadModule(start.module);
  const hold = await storeMutex.acquire();
  if (!hold) throw new Error('the store mutex was not free within 60 s');
  markReloading(start.module);
  try {
    const restored = restoreModule(start.module, 'failed', error);
    await afterRestore(start.module, restored, 'failed', error);
    await statusAfterWrite(start.module);
  } finally {
    unmarkReloading(start.module);
    hold.release();
  }
}

onStartEnded(onApplyStartEnded);

// ============================================================================
// THE PASS'S MODULE STEP (decision 49 for modules, with 58's step 0 and 80's step 7)
// ============================================================================

const LIST_SQL = 'SELECT module, sha, version, updated_by FROM smdb_data.shared_modules';
const READ_BOUND_MS = 10_000;

interface ModuleRowSeen {
  sha: string;
  version: string | null;
  updatedBy: string | null;
}

const listedOnce = new Set<string>();

function installedModules(): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataPath('global', 'appstore', 'installed.json'), 'utf8'));
    return new Set(Object.keys(parsed?.modules ?? {}));
  } catch {
    return new Set();
  }
}

function sourceFolders(): string[] {
  const root = dirs().source;
  if (!exists(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
}

const passStopped = (): boolean => isStopping();

/** One module of the pass: steps 1 to 5 of 49; the apply logs step 6's T11. */
async function passModule(module: string, row: ModuleRowSeen | undefined, tag0: string | null, listedInstalled: Set<string>): Promise<void> {
  const read = readStoreRecord();
  if (!read.ok) return;
  const entry = read.record.modules[module];
  if (applyRuns.has(module) || entry?.applying) return;
  if (startStateOf(module)) return;
  const live = path.join(dirs().source, module);
  let c: string;
  try {
    c = folderSha(live);
  } catch (error) {
    console.error(`[Shared] Could not read the module folder ${module} (${messageOf(error)}); the next pass tries again`);
    return;
  }
  const rowSha = row?.sha ?? 'absent';
  let E: string;
  let aside = false;
  if (entry && c === entry.sha) {
    E = entry.sha;
  } else if (row && c === row.sha) {
    withStoreLock(() => {
      const record = readRecord();
      record.modules[module] = { ...(record.modules[module] ?? emptyEntry()), sha: row.sha, stamp: null, main: tag0, built: null, applying: null };
      writeStoreRecord(record);
    });
    return;
  } else {
    // A folder with no entry is not moved aside here: with a row the apply sets it aside, with none it is an orphan (33).
    aside = c !== 'absent' && !!entry;
    E = 'absent';
  }
  const stray = !entry && c !== 'absent';
  if (entry && entry.main !== tag0 && rowSha !== E) {
    aside = c !== 'absent';
    E = 'absent';
  } else if (entry && entry.main !== tag0 && rowSha === E) {
    withStoreLock(() => {
      const record = readRecord();
      const now = record.modules[module];
      if (now) {
        record.modules[module] = { ...now, main: tag0 };
        writeStoreRecord(record);
      }
    });
  }
  const keep: 'failed' | 'retry' | null = row && entry
    ? row.sha === entry.failedSha ? 'failed' : entry.retryAt !== null && entry.retryAt > Date.now() ? 'retry' : null
    : null;
  if (keep) {
    if (aside) {
      await applyModuleChange({ module, to: 'absent', source: 'rows', displaced: 'superseded', reason: 'pass', tag: tag0, version: row?.version ?? null, keep });
    }
    return;
  }
  if (E === rowSha && !aside && !stray) {
    if (rowSha === 'absent' && entry) {
      withStoreLock(() => {
        const record = readRecord();
        if (record.modules[module] && !record.modules[module].applying) {
          delete record.modules[module];
          writeStoreRecord(record);
        }
      });
    }
    return;
  }
  if (row) {
    await applyModuleChange({
      module, to: row.sha, source: 'rows', displaced: aside ? 'superseded' : 'backups', reason: 'pass', tag: tag0,
      version: row.version, updatedBy: row.updatedBy,
    });
    return;
  }
  if (listedInstalled.has(module)) {
    if (!listedOnce.has(module)) {
      listedOnce.add(module);
      console.error(`[Shared] ${module} is listed as installed, but the database holds none of its files; uninstall it from the App Store tab, then install it again`);
    }
    return;
  }
  if (c === 'absent' && !entry) return;
  await applyModuleChange({ module, to: 'absent', source: 'rows', displaced: aside ? 'superseded' : entry ? 'backups' : 'orphan', reason: 'pass', tag: tag0 });
}

const STAGED_STALE_MS = 10 * 60_000;
const STAGED_NAME = /^\.incoming-(.+)-(\d+)$/;

/**
 * Decision 35's last paragraph: an `.incoming-<module>-<ms>` folder more than 10 minutes old that no publish or apply of
 * this process holds is deleted; it holds only copies of a clone or of rows (a crash before the COMMIT, row 112).
 */
function dropStaleStaged(): void {
  const root = dirs().source;
  if (!exists(root)) return;
  const held = stagedHeld();
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const match = STAGED_NAME.exec(e.name);
    if (!e.isDirectory() || !match) continue;
    const folder = path.join(root, e.name);
    if (held.has(path.resolve(folder)) || applyRuns.has(match[1]) || Date.now() - Number(match[2]) <= STAGED_STALE_MS) continue;
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      // The next pass tries again.
    }
  }
}

/** The pass's module step: the listing, step 0 for each pending status, each module, then step 7. */
export async function modulePassStep(pass: { tag0: string | null; modules?: string[] }): Promise<boolean | { cause: string }> {
  const backend = rowBackend();
  if (!backend?.sharedSelect) return false;
  const rows = new Map<string, ModuleRowSeen>();
  try {
    const res = await backend.sharedSelect(LIST_SQL, [], READ_BOUND_MS);
    for (const r of res.rows) rows.set(String(r.module), { sha: String(r.sha), version: r.version ?? null, updatedBy: r.updated_by ?? null });
  } catch (error) {
    return { cause: messageOf(error) };
  }
  dropStaleStaged();
  const read = readStoreRecord();
  if (!read.ok) return true;
  for (const [module, entry] of Object.entries(read.record.modules)) {
    if (!entry?.status) continue;
    if (entry.main === pass.tag0) {
      await sendStatus(module, entry.status);
      continue;
    }
    withStoreLock(() => {
      const record = readRecord();
      const now = record.modules[module];
      if (now?.status) {
        record.modules[module] = { ...now, status: null };
        writeStoreRecord(record);
      }
    });
  }
  const d = dirs();
  const development = sameDir(d.source, d.dist);
  const names = new Set<string>([...rows.keys(), ...Object.keys(read.record.modules)]);
  for (const folder of sourceFolders()) {
    if (!development || rows.has(folder) || read.record.modules[folder]) names.add(folder);
  }
  const installed = installedModules();
  for (const module of [...names].filter(name => !pass.modules || pass.modules.includes(name)).sort()) {
    if (passStopped()) return true;
    try {
      await passModule(module, rows.get(module), pass.tag0, installed);
    } catch (error) {
      const later = applyLaterOf(module);
      const tail = later.kind === 'start'
        ? `this machine applies the database's current version of ${module} after the bot's next start`
        : later.kind === 'after' && rows.has(module) ? `this machine tries again after ${new Date(later.at).toISOString()}` : 'the next pass tries again';
      console.error(`[Shared] Could not bring the module ${module} up to date (${messageOf(error)}); ${tail}`);
    }
  }
  if (mainTag() === pass.tag0) {
    const after = readStoreRecord();
    pruneCrashLines(module => {
      const entry = after.ok ? after.record.modules[module] : undefined;
      return [rows.get(module)?.sha, entry?.sha, entry?.applying?.to];
    });
  }
  return true;
}

setSharedModulePassStep(modulePassStep);

// ============================================================================
// THE BOOT APPLY (decision 45 as 59, 67, 69, 78, 81, 89, 92, 99 and 105 amend it)
// ============================================================================

/** Every compile the boot runs (81): the bound of the web UI's module operations, 600 s. */
export const BOOT_COMPILE_MS = 600_000;
const BOOT_BOUND_TEXT = 'it did not finish within 10 minutes';

/** 45 step (3): from here until the boot compile, an apply of the pass stops after its swap (43 steps 1 to 3). */
export function beginBootApplies(): void {
  bootSwaps = true;
  bootApplied.clear();
}

const safeModeMarker = (): string => dataPath('build-safe-mode.json');

/** Decision 59: `built` names this sha in this image's build, and no safe-mode build is in place. */
export function builtCurrent(entry: ModuleEntry): boolean {
  return !!entry.built && entry.built.sha === entry.sha && entry.built.buildId === buildIdNow() && !exists(safeModeMarker());
}

/** A compile the boot runs: 600 s for tsc (81), and a compile still running at 600 s answers 69's error. */
async function bootCompile(): Promise<CompileResult> {
  const begun = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<CompileResult>(resolve => {
    timer = setTimeout(() => resolve({ success: false, error: BOOT_BOUND_TEXT, duration: BOOT_COMPILE_MS, diagnostics: [] }), BOOT_COMPILE_MS);
    timer.unref?.();
  });
  const result = await Promise.race([recompileTypeScript({ timeoutMs: BOOT_COMPILE_MS }), bound]);
  clearTimeout(timer);
  if (!result.success && result.diagnostics.length === 0 && Date.now() - begun >= BOOT_COMPILE_MS) return { ...result, error: BOOT_BOUND_TEXT };
  return result;
}

const diagnosticText = (diag: CompileResult['diagnostics'][number]): string => `${diag.file}:${diag.line} ${diag.text}`;

function entryOf(module: string): ModuleEntry | undefined {
  const read = readStoreRecord();
  return read.ok ? read.record.modules[module] : undefined;
}

/** 69: a module this boot did not apply, left uncompiled by a compile that names no file. */
function notCompiledAtBoot(module: string, error: string): void {
  const d = dirs();
  withStoreLock(() => {
    const record = readRecord();
    const entry = record.modules[module];
    if (!entry) return;
    const dist = path.join(d.dist, module);
    if (!sameDir(dist, path.join(d.source, module))) fs.rmSync(dist, { recursive: true, force: true });
    record.modules[module] = { ...entry, built: null, status: nextStatus(record, 'failed', entry.sha, error) };
    writeStoreRecord(record);
  });
  console.error(`[Shared] ${module} ${manifestVersion(module) ?? entryOf(module)?.sha ?? ''} could not be compiled on this machine at this start (${error}); this machine does not load it, and compiles it again at the next start`);
}

/** 59: a module this boot did not apply whose own files no longer compile with this bot's version (T19). */
function doesNotCompile(module: string, own: CompileResult['diagnostics']): void {
  const error = `${diagnosticText(own[0])}; ${own.length} errors in its files`;
  const version = manifestVersion(module);
  withStoreLock(() => {
    const record = readRecord();
    const entry = record.modules[module];
    if (!entry) return;
    clearCompiled(module);
    record.modules[module] = { ...entry, built: null, status: nextStatus(record, 'failed', entry.sha, error) };
    writeStoreRecord(record);
  });
  console.error(`[Shared] ${module} ${version ?? entryOf(module)?.sha ?? ''} does not compile with this bot's version (${error}); this machine does not load it until it is updated or the bot's version changes`);
}

interface BootRestore {
  module: string;
  why: 'failed' | 'retry';
  error: string;
  restored: Restored;
  swapped: Swapped | undefined;
}

/** A put-back at boot. One that throws logs T33 and writes nothing more for the module; the boot goes on without it (102). */
function restoreAtBoot(module: string, why: 'failed' | 'retry', error: string, swapped: Swapped | undefined): BootRestore | null {
  try {
    return { module, why, error, restored: restoreModule(module, why, error), swapped };
  } catch (thrown) {
    startEndFailed({ module }, thrown);
    return null;
  }
}

/** The modules this boot swapped whose entry still holds the intent, with their swaps (taken once). */
function takeBootApplied(): Array<[string, Swapped]> {
  const read = readStoreRecord();
  const out = [...bootApplied.entries()].filter(([module]) => read.ok && !!read.record.modules[module]?.applying);
  return out;
}

/**
 * 45 step (4) with 59 and 69: when any module of the store with a source folder in place fails `builtCurrent`, or the
 * boot swapped one, the source folders are copied whole into the build folders and one compile runs. A module this boot
 * applied whose own files fail takes the failure path at once (one more compile for all of them); a compile that names
 * no file takes the T2 path for each of them. A module not applied: `built` written, or T19, or 69's boot form of T2.
 */
export async function bootCompileModules(): Promise<void> {
  bootSwaps = false;
  const read = readStoreRecord();
  if (!read.ok) return;
  const d = dirs();
  const applied = new Map(takeBootApplied());
  const inPlace = Object.keys(read.record.modules).filter(module => exists(path.join(d.source, module)));
  const stale = inPlace.filter(module => !applied.has(module) && !read.record.modules[module].applying && !builtCurrent(read.record.modules[module]));
  if (applied.size === 0 && stale.length === 0) return;
  const copyFailed = new Map<string, string>();
  for (const module of inPlace) {
    try {
      withStoreLock(() => copyToBuild(module));
    } catch (thrown) {
      copyFailed.set(module, messageOf(thrown));
    }
  }
  const compile = await bootCompile();
  const noFile = !compile.success && compile.diagnostics.length === 0;
  const error = compile.error ?? 'the compile failed';
  if (noFile) console.error(`[Shared] The boot compile of App Store modules failed (${error})`);
  const restores: BootRestore[] = [];
  for (const [module, swapped] of applied) {
    const own = compile.diagnostics.filter(diag => ownFile(diag.file, module));
    const copyError = copyFailed.get(module);
    if (copyError === undefined && !noFile && own.length === 0) continue;
    const r = copyError !== undefined || noFile
      ? restoreAtBoot(module, 'retry', copyError ?? error, swapped)
      : restoreAtBoot(module, 'failed', diagnosticText(own[0]), swapped);
    if (r) restores.push(r);
    else bootApplied.delete(module);
  }
  // The restored versions' compile compiles the others again too, so they are judged by the last compile.
  const second = restores.some(r => r.restored.version !== 'absent') ? await bootCompile() : null;
  const last = second ?? compile;
  const lastNoFile = !last.success && last.diagnostics.length === 0;
  for (const module of stale) {
    const own = last.diagnostics.filter(diag => ownFile(diag.file, module));
    const copyError = copyFailed.get(module);
    try {
      if (copyError !== undefined) {
        leaveOutAtBoot(module);
        notCompiledAtBoot(module, copyError);
      } else if (lastNoFile) notCompiledAtBoot(module, last.error ?? 'the compile failed');
      else if (own.length > 0) doesNotCompile(module, own);
      else setBuilt(module, read.record.modules[module].sha);
    } catch (thrown) {
      bootStepFailed(module, thrown);
    }
  }
  await restoredAtBoot(restores, null, second);
  for (const module of new Set([...stale, ...restores.map(r => r.module)])) await statusAfterWrite(module);
}

/** 102's rule for a throw in a boot step of one module: T33, its dist folder deleted, the module left out of this boot. */
function bootStepFailed(module: string, error: unknown): void {
  leaveOutAtBoot(module);
  const d = dirs();
  const dist = path.join(d.dist, module);
  try {
    if (!sameDir(dist, path.join(d.source, module))) fs.rmSync(dist, { recursive: true, force: true });
  } catch {
    // Left out of the load all the same.
  }
  startEndFailed({ module }, error);
}

/** T24's boot form (87), as the boot loop logs it. */
function logHeldAtBoot(module: string, version: string): void {
  console.error(`[ModuleLoader] ${module} ${version} was not loaded: this machine holds it back after the bot stopped twice while it was starting it (see the App Store tab)`);
}

/**
 * 58 f at boot for the restored versions: one compile for all of them (81's bound; `given` when the caller ran it),
 * then each is written `built`, held, or loaded by `load` when given (45 (6)'s f); T1, T2 or T3. Answers the modules
 * loaded in their place.
 */
async function restoredAtBoot(
  restores: BootRestore[],
  load: ((module: string) => Promise<LoadedModule | { error: string }>) | null,
  given?: CompileResult | null,
): Promise<Map<string, LoadedModule>> {
  const loaded = new Map<string, LoadedModule>();
  const kept = restores.filter(r => r.restored.version !== 'absent');
  const compile = given !== undefined ? given : kept.length > 0 ? await bootCompile() : null;
  for (const r of restores) {
    try {
      await restoredOne(r, compile, load, loaded);
    } catch (thrown) {
      startEndFailed({ module: r.module }, thrown);
    }
  }
  return loaded;
}

async function restoredOne(
  r: BootRestore,
  compile: CompileResult | null,
  load: ((module: string) => Promise<LoadedModule | { error: string }>) | null,
  loaded: Map<string, LoadedModule>,
): Promise<void> {
  const A = r.restored.intent;
  const { module, why, error } = r;
  const keepLog = (keeps: 'previous' | 'none') => (why === 'failed' ? logFailed(module, A, error, keeps) : logRetry(module, A, error, keeps, r.restored.retryAt ?? Date.now()));
  if (r.restored.version === 'absent' || !compile) {
    keepLog('none');
    if (r.swapped) logAside(r.swapped, T11_APPLY_FAILED);
    return;
  }
  const own = compile.diagnostics.filter(diag => ownFile(diag.file, module));
  const compiled = compile.success || (compile.diagnostics.length > 0 && own.length === 0);
  if (entryOf(module)?.heldSha === r.restored.version) {
    if (compiled) setBuilt(module, r.restored.version);
    if (load) {
      recordHeldBack(module);
      logHeldAtBoot(module, manifestVersion(module) ?? r.restored.version);
    }
    if (why === 'failed') logFailedHeld(module, A, error);
    else keepLog('previous');
    if (r.swapped) logAside(r.swapped, T11_APPLY_FAILED);
    return;
  }
  let second: string | null = compiled ? null : own.length > 0 ? diagnosticText(own[0]) : compile.error ?? 'the compile failed';
  if (second === null && load) {
    const out = await load(module);
    if ('error' in out) second = out.error;
    else loaded.set(module, out);
  }
  if (second === null) {
    setBuilt(module, r.restored.version);
    keepLog('previous');
  } else {
    const both = `${error}; the previous version did not load either (${second})`;
    withStoreLock(() => {
      const record = readRecord();
      const entry = record.modules[module];
      if (!entry) return;
      clearCompiled(module);
      record.modules[module] = { ...entry, built: null, status: nextStatus(record, 'failed', A.to, both) };
      writeStoreRecord(record);
    });
    if (why === 'failed') logBothFailed(module, A, error, second);
    else keepLog('previous');
  }
  if (r.swapped) logAside(r.swapped, T11_APPLY_FAILED);
}

/** 45 (6)'s f: the restored version loaded, registered and its hooks run in its boot start's window. */
async function loadRestoredAtBoot(client: Client, module: string): Promise<{ module: LoadedModule; start: ModuleStart } | { error: string }> {
  let found: { manifest: ModuleManifest; dir: string } | null = null;
  for (const manifestPath of findModuleManifests()) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest?.name === module) {
        found = { manifest, dir: path.dirname(manifestPath) };
        break;
      }
    } catch {
      continue;
    }
  }
  if (!found) {
    recordLoadFailure(module);
    return { error: 'Module manifest not found' };
  }
  const opened = startModule(module, startShaOf(module), found.manifest.version, found.dir, { boot: true });
  if (typeof opened === 'string') return { error: `${module} was not loaded` };
  const loader = new ModuleLoader(client);
  let done = false;
  let failure: unknown;
  openWindow(opened);
  try {
    const loadedModule = await loader.loadModule(found.manifest, found.dir);
    getModuleRegistry().register(loadedModule);
    for (const hook of ['onLoad', 'onReady'] as const) {
      const fn = loadedModule.hooks?.[hook];
      if (!fn) continue;
      try {
        await fn(loader.createModuleContext(loadedModule));
      } catch (hookError) {
        console.error(`[ModuleLoader] ${hook} hook failed for ${module}:`, hookError);
      }
    }
    done = true;
    return { module: loadedModule, start: opened };
  } catch (error) {
    failure = error;
    console.error(`[ModuleLoader] Failed to load module ${module}:`, error);
    recordLoadFailure(module);
    return { error: messageOf(error) };
  } finally {
    closeWindow(opened);
    if (!done) await endStart(opened, { failed: failure ?? new Error('the load did not finish') });
  }
}

/**
 * 45 step (6), right after `loadAllModules`: each module this boot applied is registered and no load failure names it
 * or a path under its dist folder. A success writes nothing here (its start's end does, 78). A failure: unregistered,
 * its start ended `{ failed }`, put back, one compile for all of them, and the restored version loaded in its place
 * (f), its start handed to its turn. Answers the loaded modules with each failed one replaced.
 */
export async function bootLoadCheck(client: Client, loaded: LoadedModule[]): Promise<LoadedModule[]> {
  const applied = takeBootApplied();
  bootApplied.clear();
  if (applied.length === 0) return loaded;
  const registry = getModuleRegistry();
  const failures = getLoadFailures();
  const failed: Array<{ module: string; swapped: Swapped }> = [];
  for (const [module, swapped] of applied) {
    const distDir = path.resolve(dirs().dist, module);
    const fresh = failures.filter(f => f === module || path.resolve(f).startsWith(distDir + path.sep));
    if (registry.getModule(module) && fresh.length === 0) logAside(swapped, T11_WRITTEN);
    else failed.push({ module, swapped });
  }
  if (failed.length === 0) return loaded;
  const out = [...loaded];
  const restores: BootRestore[] = [];
  for (const { module, swapped } of failed) {
    if (registry.getModule(module)) await registry.unloadModule(module);
    const handed = bootStartOf(module);
    const error = startFailureOf(module) ?? `${module} recorded a load failure`;
    if (handed && openStarts.get(module) === handed) await endStart(handed, { failed: new Error(error) });
    const r = restoreAtBoot(module, 'failed', error, swapped);
    if (r) restores.push(r);
  }
  const starts = new Map<string, ModuleStart>();
  const replaced = await restoredAtBoot(restores, async module => {
    const result = await loadRestoredAtBoot(client, module);
    if ('error' in result) return result;
    starts.set(module, result.start);
    return result.module;
  });
  for (const { module } of failed) {
    const at = out.findIndex(m => m.manifest.name === module);
    const restored = replaced.get(module);
    if (restored && at >= 0) out[at] = restored;
    else if (restored) out.push(restored);
    else if (at >= 0) out.splice(at, 1);
    const start = starts.get(module);
    if (restored && start) handToBootTurn(start);
    if (restores.some(r => r.module === module)) await statusAfterWrite(module);
  }
  return out;
}

export function _resetModuleApply(): void {
  applyRuns.clear();
  listedOnce.clear();
  applyClient = null;
  bootSwaps = false;
  bootApplied.clear();
}
