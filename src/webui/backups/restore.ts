import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_ROOT, dataPath } from '../../utils/dataRoot';
import { resolveDataBackend } from '../../utils/envLoader';
import { readMaintenanceFile } from '../../utils/maintenanceFile';
import { atomicWriteFileSync } from '../../bot/internalSetup/utils/atomicWrite';
import { bootId, containerPath, diskError, diskRecord, timeText, type ChainAnswer, type DiskError } from '../../bot/internalSetup/utils/folderChain';
import { fsyncDirs } from '../../bot/internalSetup/utils/backups/fsyncDirs';
import { readSnapshot, snapshotsRoot, type Manifest, type ManifestFile } from '../../bot/internalSetup/utils/backups/snapshotList';
import { copySnapshot, countsDifferText, countsOf, verifyTree, type VerifyAnswer } from '../../bot/internalSetup/utils/backups/snapshotVerify';
import { formatTime, parseWorkName } from '../../bot/internalSetup/utils/backups/snapshotNames';
import { topItems } from '../../bot/internalSetup/utils/backups/snapshotSet';
import { isOpenStage, readRestoreJournal, restoreJournalPath, type RestoreJournal, type RestoreStage } from '../../bot/internalSetup/utils/backups/restoreJournal';
import { readDataFacts } from '../../bot/internalSetup/utils/dataBackends/recognitionGuard';
import { migrationState } from '../../bot/internalSetup/utils/dataMigration';
import { forgetSharedFileKnowledge } from '../../bot/internalSetup/utils/dataManager';
import { holderWords, readWriterHolder } from '../../bot/internalSetup/utils/writerLock';
import { getAppVersion } from '../../bot/internalSetup/fleet/nodeIdentity';
import { writeRestoreJournal } from './state';
import {
  backupWorkRunning, journalUnreadableText, restoreGate, restoreLatch, setRestoreLatch, setRestoreOp, restoreOp,
  type RestoreGateAnswer, type RestoreLatch, type RestoreOp, type RestoreWaiting,
} from './restoreState';
import type { BotManager, RestoreOpAnswer } from '../botManager';

// NB8 decision 11 as decisions 24 to 29, 33 to 36, 46 to 56, 58 to 62, 64 to 73, C13, C14, C19, C20 and N1 to N6
// amend it: the POST's restore, main()'s recovery and step 8 at the tick. restore.json is the record; restoreOp and the
// latch are restoreState.ts's.

export type RestoreHost = Pick<BotManager,
  'isRunning' | 'shutdown' | 'awaitNoChildren' | 'runRestoreOp' | 'start' | 'migrationRunning' | 'isExiting' | 'getStatus' | 'hasUnexitedChildren'>;

export type PostAnswer = { status: number; body: { success: boolean; [field: string]: unknown } };

const FREE_MARGIN_BYTES = 256 * 1024 * 1024;
const timing = { stageMs: 30 * 60_000, stopMs: 60_000, heldRetryMs: 100, slowRetryMs: 1000, journalReadMs: 1000, logEveryMs: 30_000 };

/** Tests only: the bounds and the waits. */
export function _setRestoreTimingForTests(next: Partial<typeof timing> = {}): void {
  Object.assign(timing, { stageMs: 30 * 60_000, stopMs: 60_000, heldRetryMs: 100, slowRetryMs: 1000, journalReadMs: 1000, logEveryMs: 30_000 }, next);
}

let running: Promise<void> | null = null;
/** A POST's op and the `startedAt` its `staging` record carries. */
const opStarts = new WeakMap<RestoreOp, number>();
/** A POST's op refused before its `staging` record, while it starts a bot it stopped. */
const opsEnding = new WeakSet<RestoreOp>();

/** The POST's op in flight, settled once it cleared `restoreOp`; null when none runs. */
export function restoreSettled(): Promise<void> | null {
  return running;
}

const errnoOf = (error: unknown): string => String((error as { code?: unknown } | null)?.code ?? 'EIO');
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
const cp = containerPath;
const journalWords = (): string => cp(restoreJournalPath());
const snapshotsWords = (): string => cp(snapshotsRoot());
const asideFolder = (j: RestoreJournal): string => `.${j.preRestore}`;
const asideWords = (j: RestoreJournal): string => `${snapshotsWords()}/${asideFolder(j)}`;
const stagingRoot = (j: RestoreJournal): string => dataPath('_snapshots', j.staging);
const asideRoot = (j: RestoreJournal): string => dataPath('_snapshots', asideFolder(j));
const relPath = (rel: string): string[] => rel.split('/');

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch (error) {
    if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR') return false;
    throw error;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------------------------------------------

const NOT_ENOUGH = "a restart of the bot's container is not enough after a disk error";
const NO_BOOT_ID = "the web panel cannot read the machine's boot id";

/**
 * B6 as H5, I8 and L1 read it: while this boot's disk error record stands, a line that names a restart of the bot's
 * container names the machine's restart; with the boot id unknown, the record files are deleted first.
 */
export function restartSwitch(text: string): string {
  const found = diskRecord();
  if (!found || found.files.length === 0) return text;
  const files = found.files.map(cp).join(' and ');
  const deleted = `${files} ${found.files.length === 1 ? 'is' : 'are'} deleted and`;
  const unknown = bootId() === null;
  return text.replace(/(Until|until) the bot's container is restarted|(Restart|restart) the bot's container|until the container restarts/g, (match, until?: string, restart?: string) => {
    if (unknown) {
      if (until) return `${until} ${deleted} the bot's container is restarted (${NO_BOOT_ID})`;
      if (restart) return `${restart === 'Restart' ? 'Delete' : 'delete'} ${files}, then restart the bot's container (${NO_BOOT_ID})`;
      return `until ${deleted} the container restarts (${NO_BOOT_ID})`;
    }
    if (until) return `${until} the machine the bot runs on is restarted (${NOT_ENOUGH})`;
    if (restart) return `${restart} the machine the bot runs on (${NOT_ENOUGH})`;
    return `until the machine the bot runs on is restarted (${NOT_ENOUGH})`;
  });
}

const isFolderCase = (d: DiskError): boolean => d.files.length === 0 && d.at === null && !d.unreadable;
const atText = (d: { at: number | null }): string => (d.at === null ? '' : ` at ${timeText(d.at)}`);

/** The start of a sentence that names a standing disk error (N5, N19, code review 1's folder case). */
function diskWhy(d: DiskError): string {
  if (d.unreadable) return `No folder sync is trusted since ${cp(d.files[0] ?? d.dir)} records a disk error on this machine, and that record cannot be read`;
  if (isFolderCase(d)) return `No folder sync is trusted since ${cp(d.dir)} could not be read (${d.errno}) to look for a disk error record`;
  return `The disk reported an error when ${cp(d.dir)} was synced${atText(d)} (${d.errno})`;
}

/** The same, inside a latch line: "the disk reported an error (<errno>) when <folder> was synced at <at>". */
function diskClause(d: DiskError): string {
  if (d.unreadable) return `${cp(d.files[0] ?? d.dir)} records a disk error on this machine, and that record cannot be read`;
  if (isFolderCase(d)) return `${cp(d.dir)} could not be read (${d.errno}) to look for a disk error record`;
  return `the disk reported an error (${d.errno}) when ${cp(d.dir)} was synced${atText(d)}`;
}

function diskLogClause(d: DiskError): string {
  if (d.unreadable) return `${cp(d.files[0] ?? d.dir)} records a disk error on this machine, and that record cannot be read`;
  if (isFolderCase(d)) return `${cp(d.dir)} could not be read (${d.errno}) to look for a disk error record`;
  return `the disk reported an error when ${cp(d.dir)} was synced${atText(d)} (${d.errno})`;
}

/** C20's restore refusal while a disk error stands (409). */
export function diskRefusalText(d: DiskError): string {
  const why = d.unreadable || isFolderCase(d) ? diskWhy(d) : `The data disk reported an error when ${cp(d.dir)} was synced${atText(d)} (${d.errno})`;
  return restartSwitch(`${why}, so can't confirm earlier changes are on disk. No restore can start until the bot's container is restarted; check the disk first.`);
}

const RUNNING_NOTE = (name: string) => `A restore of ${name} is already running.`;
const POSTGRES_TEXT = 'This bot keeps its data in Postgres; restore its database in the Bot Manager.';
const MIGRATION_TEXT = 'A data migration is running or unfinished; restore once it has finished.';
const migrationUnknownText = (cause: string) => `can't confirm whether a data migration is running or unfinished (${cause}); restore once that can be read.`;
const RUNNING_BOT_TEXT = 'Stop the bot, or put it in maintenance, before a restore: a running bot would keep writing the data the restore replaces.';
const DEVICE_TEXT = 'The backups folder is on another file system than /data, so a restore cannot move the data into place.';
const TAKE_RUNNING_TEXT = 'A backup is being taken now; start the restore once it has finished.';
const TEST_RUNNING_TEXT = 'The daily test restore of a backup is running; start the restore once it has finished.';
const INTERRUPTED = 'The restore was interrupted before any data was changed.';
const NOT_STOPPED = 'The bot did not stop within 60 seconds.';
const CHANNEL_OPEN = "The bot process exited, but can't confirm it sent all its messages (its channel stayed open for 60 seconds).";
const KILLED = 'The bot did not stop within 40 seconds and was killed, so can\'t confirm it saved every change; check its log, then try again.';
const LEFT_LOCK = "The bot stopped while changes were still being written to disk, so can't confirm they were saved; check the bot's log and the disk, then try again.";

/** Decision 54's unfinished line and decisions 62 and 73's forms by stage; the POST's 409 is the same. */
export function unfinishedText(j: RestoreJournal): string {
  const head = `The restore of ${j.name} did not finish (${journalWords()} says ${j.stage}), and no restore runs now`;
  if (j.stage === 'staging' || j.stage === 'staged') {
    return restartSwitch(`${head}; no data was moved. The bot does not start until it ends. Restart the bot's container: the web panel then ends this restore as failed, with the data unchanged, before it starts the bot; start the restore again after that.`);
  }
  if (j.stage === 'swapping') {
    return restartSwitch(`${head}. The bot does not start until it ends. Restart the bot's container: the web panel finishes the restore when it starts, or ends it failed with the data unchanged if no data had been moved yet, or finishes it, when /data held no data, before it starts the bot.`);
  }
  return restartSwitch(`${head}. The bot does not start until it finishes. Restart the bot's container: the web panel finishes the restore when it starts, before it starts the bot.`);
}

/** Decisions 54 and 73's stuck texts by cause and stage. */
export function stuckText(j: RestoreJournal): string {
  const at = typeof j.path === 'string' ? cp(dataPath(...relPath(j.path))) : '';
  const replaced = `The data the restore replaced is in ${asideWords(j)}.`;
  if (j.cause === 'in-the-way') {
    const asideGone = Array.isArray(j.aside) && (j.aside as string[]).includes(j.path as string) && !exists(path.join(asideRoot(j), 'data', ...relPath(j.path as string)));
    const last = asideGone ? `${at} may be the data this restore was replacing: it is not in ${asideWords(j)}, so keep it.` : replaced;
    return restartSwitch(`The restore of ${j.name} stopped part way: ${at} exists where the backup's copy must go. The bot does not start until the restore finishes. Move ${at} out of /data (keep it if you need it), then restart the bot's container: the web panel finishes the restore when it starts, before it starts the bot. ${last}`);
  }
  if (j.stuckAt === 'swapping') {
    return restartSwitch(`The restore of ${j.name} stopped part way: ${at} could not be moved (${j.errno}). The bot does not start until the restore ends. Fix the cause, then restart the bot's container: the web panel finishes the restore when it starts, or ends it failed with the data unchanged if no data had been moved yet, before it starts the bot. Any data the restore had moved is in ${asideWords(j)}.`);
  }
  return restartSwitch(`The restore of ${j.name} stopped part way: ${at} could not be moved (${j.errno}). The bot does not start until the restore finishes. Fix the cause, then restart the bot's container: the web panel finishes the restore when it starts, before it starts the bot. ${replaced}`);
}

/** Decision 44's POST answer at `placed`, by step 8's note. */
export function placedPostText(j: RestoreJournal): string {
  const note = j.note as { cause?: string; path?: string; errno?: string } | undefined;
  if (!note) return 'The last restore is still recording the data it replaced; try again in a minute.';
  if (note.cause === 'read') return `The last restore cannot record the data it replaced: ${cp(note.path ?? '')} cannot be read (${note.errno}). No other restore can start until it can; the Dashboard tab says what to do.`;
  return `The last restore is still recording the data it replaced (${note.errno}); it is tried again every minute, and a restore can start once it is recorded.`;
}

/** Decision 54's can't-confirm line while restore.json cannot be read (GET and the panel). */
export const unreadableLine = (cause: string): string =>
  `can't confirm the state of the last backup restore: ${journalWords()} cannot be read (${cause}). Until it can be read, the bot cannot be started, no change to the data is saved and no backup is taken; if no restore ran, remove that file.`;

function waitingReason(w: RestoreWaiting): string {
  if (w.cause === 'held' && w.holder) return `another process holds the data files (${w.holder.role === 'previous' ? 'a bot process this web panel started' : holderWords({ role: w.holder.role ?? undefined })}, pid ${w.holder.pid})`;
  if (w.cause === 'held' || w.cause === 'contended') return 'another process is taking the data files at this moment';
  if (w.cause === 'unreadable') return `can't confirm which process holds the data files (/data/.writer.lock: ${w.errno})`;
  return `the data disk does not take writes (/data/.writer.lock: ${w.errno})`;
}

/** Decisions 54, 62 and 73's waiting line, by the journal's stage; null while no lock wait stands. */
export function waitingLine(op: RestoreOp, stage: RestoreStage | null): string | null {
  const w = op.waiting;
  if (!w) return null;
  if (w.cause === 'journal') return unreadableLine(w.errno ?? '');
  const head = `Restoring ${op.name}: waiting, because ${waitingReason(w)}.`;
  if (stage === 'staging' || stage === 'staged') return `${head} The web panel goes on as soon as that ends: it ends this restore as failed, with the data unchanged, and then starts the bot.`;
  if (stage === 'swapping') return `${head} The web panel goes on as soon as that ends: it finishes the restore, or ends it failed with the data unchanged if no data had been moved yet, or finishes it, when /data held no data, and then starts the bot.`;
  return `${head} The web panel goes on as soon as that ends, and finishes the restore before it starts the bot.`;
}

const opened = (l: RestoreLatch): boolean => l.open === true;
const latchDisk = (l: RestoreLatch): DiskError => (l.disk as DiskError | undefined) ?? { dir: l.folder ?? '', errno: l.errno, at: null, by: null, files: [], unreadable: false };

/** The latch's line (decisions 54, 62, 70, 73, N5's rows), by its kind, its stage and the journal's stage on disk. */
export function latchLine(l: RestoreLatch): string {
  const read = readRestoreJournal();
  const onDisk = read.state === 'read' ? read.journal.stage : null;
  const j = read.state === 'read' ? read.journal : null;
  const aside = `${snapshotsWords()}/.${(l.preRestore as string | undefined) ?? j?.preRestore ?? 'pre-restore'}`;
  const folder = cp(l.folder ?? '');
  const until = "Until the bot's container is restarted, nothing more is moved, no change to the data is saved and the bot cannot be started.";
  const restoredAt = typeof l.placedAt === 'number' ? timeText(l.placedAt) : '';
  const finalName = `${snapshotsWords()}/${(l.preRestore as string | undefined) ?? j?.preRestore ?? 'pre-restore'}`;
  if (l.kind === 'journal' && l.step8) {
    const note = l.note as { cause?: string; path?: string; errno?: string } | undefined;
    const where = l.complete ? finalName : aside;
    const last = note?.cause === 'read'
      ? `After the restart the record still cannot be written while ${cp(note.path ?? '')} cannot be read (${note.errno}): make that file readable by the bot, or move it out of /data/_snapshots and keep it (the pre-restore backup then does not have it).`
      : 'After the restart the web panel tries again to write the record within a minute.';
    return restartSwitch(`Restored ${l.name} at ${restoredAt}. The data it replaced is in ${where}, but the restore's record (${journalWords()}) could not be written (${l.errno}). No other restore can start until the bot's container is restarted; check the disk first. ${last}`);
  }
  if (l.kind === 'journal') {
    if (l.stage === 'staging' && (onDisk === null || !isOpenStage(onDisk))) {
      return restartSwitch(`The restore of ${l.name} did not start: its record (${journalWords()}) could not be written (${l.errno}). Nothing was changed. No restore can start until the bot's container is restarted; check the disk first.`);
    }
    if (onDisk === 'staging' || onDisk === 'staged') {
      return restartSwitch(`The restore of ${l.name} stopped before any data was moved: its record (${journalWords()}) could not be written (${l.errno}). The data is unchanged. Until the bot's container is restarted, no change made in the web panel is saved and a stopped bot cannot be started. Check the disk, then restart the bot's container: the web panel then ends this restore as failed, with the data unchanged, before it starts the bot; start the restore again after that.`);
    }
    return restartSwitch(`The restore of ${l.name} stopped part way: its record (${journalWords()}) could not be written (${l.errno}), so can't confirm the disk took the restore's last step. ${until} Check the disk, then restart the bot's container: the web panel takes the restore up again from its record when it starts, before it starts the bot; when the record says swapping, it finishes the restore, or ends it failed with the data unchanged if no data had been moved yet.`);
  }
  if (l.kind === 'journal-sync') {
    if (opened(l)) {
      return restartSwitch(`The restore of ${l.name} stopped before any data was moved: ${snapshotsWords()} could not be opened for its sync (${l.errno}) after the restore's record was written, so can't confirm the record is on disk. The data is unchanged. Until the bot's container is restarted, nothing is moved, no change to the data is saved and the bot cannot be started. Restart the bot's container: the web panel then ends this restore as failed, with the data unchanged, before it starts the bot; start the restore again after that.`);
    }
    return restartSwitch(`The restore of ${l.name} stopped before any data was moved: the disk reported an error (${l.errno}) when ${snapshotsWords()} was synced after the restore's record was written, so can't confirm the record is on disk. The data is unchanged. Until the bot's container is restarted, nothing is moved, no change to the data is saved and the bot cannot be started. Check the disk, then restart the bot's container: the web panel then ends this restore as failed, with the data unchanged, or finishes it, when /data held no data, before it starts the bot; start the restore again if it ended failed.`);
  }
  if (l.kind === 'disk') {
    const d = latchDisk(l);
    if (l.stage === 'placed') {
      return restartSwitch(`Restored ${l.name} at ${restoredAt}. The data it replaced is in ${finalName}, but ${diskClause(d)}, so can't confirm that folder's new name is on disk, and the restore's record was not finished. No other restore can start until the bot's container is restarted; check the disk first. After the restart the web panel syncs the folder again and finishes the record within a minute.`);
    }
    if (l.stage === 'swapping' && l.record) {
      return restartSwitch(`The restore of ${l.name} stopped before any data was moved: ${diskClause(d)}, so can't confirm the restore's record is on disk. The data is unchanged. ${until.replace('nothing more is moved', 'nothing is moved')} Check the disk, then restart the bot's container: the web panel then ends this restore as failed, with the data unchanged, or finishes it, when /data held no data, before it starts the bot; start the restore again if it ended failed.`);
    }
    return restartSwitch(`The restore of ${l.name} stopped part way: ${diskClause(d)}, so can't confirm the restore's moves are on disk. ${until} Check the disk, then restart the bot's container: the web panel syncs the folders again and finishes the restore when it starts, before it starts the bot. The data the restore replaced is in ${aside}.`);
  }
  // kind 'fsync'
  if (l.stage === 'placed') {
    if (opened(l)) {
      return restartSwitch(`Restored ${l.name} at ${restoredAt}. The data it replaced is in ${finalName}, but ${folder} could not be opened for its sync (${l.errno}) after that folder was renamed, so can't confirm its new name is on disk, and the restore's record was not finished. No other restore can start until the bot's container is restarted. After the restart the web panel syncs the folder again and finishes the record within a minute.`);
    }
    return restartSwitch(`Restored ${l.name} at ${restoredAt}. The data it replaced is in ${finalName}, but the disk reported an error (${l.errno}) when ${folder} was synced after that folder was renamed, so can't confirm its new name is on disk, and the restore's record was not finished. No other restore can start until the bot's container is restarted; check the disk first. After the restart the web panel syncs the folder again and finishes the record within a minute.`);
  }
  const restart = 'Restart the bot\'s container: the web panel syncs the folders again and finishes the restore when it starts, before it starts the bot.';
  if (l.stage === 'swapping') {
    if (opened(l)) {
      return restartSwitch(`The restore of ${l.name} stopped part way: ${folder} could not be opened for its sync (${l.errno}) after the current data was moved aside, so can't confirm that move is on disk. ${until} ${restart} The data the restore replaced is in ${aside}.`);
    }
    return restartSwitch(`The restore of ${l.name} stopped part way: the disk reported an error (${l.errno}) when ${folder} was synced after the current data was moved aside, so can't confirm that move is on disk. ${until} Check the disk, then r${restart.slice(1)} The data the restore replaced is in ${aside}.`);
  }
  if (opened(l)) {
    return restartSwitch(`The restore of ${l.name} stopped after moving the data: ${folder} could not be opened for its sync (${l.errno}), so can't confirm the moved data is on disk. ${until} ${restart} The data the restore replaced is in ${aside}.`);
  }
  return restartSwitch(`The restore of ${l.name} stopped after moving the data: the disk reported an error (${l.errno}) when ${folder} was synced, so can't confirm the moved data is on disk. ${until} Check the disk, then r${restart.slice(1)} The data the restore replaced is in ${aside}.`);
}

/** The latch's log line, written once when it is set. */
export function latchLog(l: RestoreLatch): string {
  const folder = cp(l.folder ?? '');
  if (l.kind === 'journal' && l.step8) return restartSwitch(`[Backup] Restore of ${l.name}: the record of the replaced data could not be written (${l.errno}); no restore can start until the container restarts`);
  if (l.kind === 'journal') {
    const read = readRestoreJournal();
    const onDisk = read.state === 'read' ? read.journal.stage : null;
    if (l.stage === 'staging' && (onDisk === null || !isOpenStage(onDisk))) {
      return restartSwitch(`[Backup] Restore of ${l.name} did not start: ${journalWords()} could not be written (${l.errno}); no restore can start until the container restarts`);
    }
    if (onDisk === 'staging' || onDisk === 'staged') {
      return restartSwitch(`[Backup] Restore of ${l.name} paused before moving any data: ${journalWords()} could not be written (${l.errno}); nothing is moved until the container restarts`);
    }
    return restartSwitch(`[Backup] Restore of ${l.name} paused: ${journalWords()} could not be written (${l.errno}); nothing more is moved until the container restarts`);
  }
  if (l.kind === 'journal-sync') return restartSwitch(`[Backup] Restore of ${l.name} paused before moving any data: syncing ${snapshotsWords()} failed (${l.errno}); nothing is moved until the container restarts`);
  if (l.kind === 'disk') return restartSwitch(`[Backup] Restore of ${l.name} paused: ${diskLogClause(latchDisk(l))}; nothing more is moved until the container restarts`);
  if (l.stage === 'placed') return restartSwitch(`[Backup] Restore of ${l.name}: syncing ${folder} failed (${l.errno}) after the replaced data's folder was renamed; no restore can start until the container restarts`);
  return restartSwitch(`[Backup] Restore of ${l.name} paused: syncing ${folder} failed (${l.errno}); nothing more is moved until the container restarts`);
}

/** C20's line in GET's notes while a disk error stands (with I2's process and B6's switch). */
export function diskNoteText(d: DiskError): string {
  const by = d.by === 'bot' ? 'the bot' : d.by === 'web panel' ? 'the web panel' : d.by;
  const why = d.unreadable || isFolderCase(d) ? diskWhy(d) : `The data disk reported an error when ${cp(d.dir)} was synced${atText(d)} (${d.errno}${by ? `, in ${by}` : ''})`;
  return restartSwitch(`${why}. Until the bot's container is restarted, no backup is taken and no restore can start; check the disk first.`);
}

const withPeriod = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);
const RUNNING_WORDS: Partial<Record<RestoreStage, string>> = {
  staging: 'copying and checking the backup',
  staged: 'stopping the bot',
  swapping: 'moving the data into place',
  placing: 'moving the data into place',
  stuck: 'moving the data into place',
  placed: 'starting the bot again',
  done: 'starting the bot again',
  failed: 'starting the bot again',
};

/** Decision 54's last sentence of the done and failed lines: the bot's state when the line is rendered. */
function botNow(host: Pick<BotManager, 'getStatus'>): string {
  if (!host.getStatus().running) return ' The bot is now stopped.';
  return readMaintenanceFile().state === 'maintenance' ? ' The bot is now running in maintenance.' : ' The bot is now running.';
}

function missingSentence(j: RestoreJournal): string {
  const missing = Array.isArray(j.missing) ? (j.missing as string[]) : [];
  if (missing.length === 0) return '';
  const paths = missing.map(rel => cp(dataPath(...relPath(rel)))).join(', ');
  return missing.length === 1
    ? ` ${paths} was in neither /data nor the pre-restore folder, so the pre-restore backup does not have it.`
    : ` ${paths} were in neither /data nor the pre-restore folder, so the pre-restore backup does not have them.`;
}

/** Decision 44's placed lines by step 8's note; decision 54's running line while step 8 has not run. */
function placedLine(j: RestoreJournal): string {
  const note = j.note as { cause?: string; path?: string; errno?: string } | undefined;
  if (!note) return `Restoring ${j.name}: recording the replaced data.`;
  const head = `Restored ${j.name} at ${typeof j.placedAt === 'number' ? timeText(j.placedAt) : ''}. The data it replaced is in ${asideWords(j)}`;
  if (note.cause === 'read') {
    return `${head}, but its record cannot be written: ${cp(note.path ?? '')} cannot be read (${note.errno}). Make that file readable by the bot, or move it out of /data/_snapshots and keep it (the pre-restore backup then does not have it); the record is written within a minute after that. No other restore can start until then.`;
  }
  const what = note.cause === 'manifest' ? 'the manifest' : "the folder's rename";
  return `${head}; its record could not be written yet (${what}: ${note.errno}) and is tried again every minute.`;
}

function endedLine(j: RestoreJournal, host: Pick<BotManager, 'getStatus'>): string {
  if (j.stage === 'done') {
    const taken = typeof j.takenAt === 'number' ? ` (taken ${timeText(j.takenAt)})` : '';
    const at = typeof j.finishedAt === 'number' ? ` at ${timeText(j.finishedAt)}` : '';
    return `Restored ${j.name}${taken}${at}: ${String(j.files ?? 0)} files. The data it replaced is kept as backup ${j.preRestore}.${missingSentence(j)}${botNow(host)}`;
  }
  const leftover = j.leftover as { path?: string; errno?: string } | undefined;
  const kept = leftover ? ` The copy in ${leftover.path} could not be removed (${leftover.errno}); delete that folder.` : '';
  return `The restore of ${j.name} failed before any data was changed: ${withPeriod(String(j.error ?? INTERRUPTED))}${kept}${botNow(host)}`;
}

/** The journal's fields GET shows (decision 13); the lists the restore works from stay in the file. */
const SHOWN = ['name', 'stage', 'startedAt', 'finishedAt', 'result', 'error', 'preRestore', 'note', 'takenAt', 'files', 'placedAt', 'leftover', 'missing', 'stuckAt', 'path', 'cause', 'errno'];

export type RestoreView = {
  name: string | null;
  stage: RestoreStage | null;
  state: RestoreGateAnswer['state'];
  running: boolean;
  waiting: string | null;
  latch: string | null;
  line: string | null;
  [field: string]: unknown;
};

/**
 * GET /api/backups' `restore`: the journal's fields, the gate's state, whether an op runs, the waiting and latch lines,
 * and the one line the panel and the console show; null with no journal, no op and no latch.
 */
export function restoreView(host: Pick<BotManager, 'getStatus'>): RestoreView | null {
  const gate = restoreGate();
  const op = restoreOp();
  const l = restoreLatch();
  const latchText = l ? latchLine(l) : null;
  const base = { running: op !== null, waiting: null as string | null, latch: latchText };
  if (gate.state === 'unknown') {
    return { name: op?.name ?? l?.name ?? null, stage: null, state: 'unknown', cause: gate.cause, ...base, line: latchText ?? unreadableLine(gate.cause) };
  }
  const read = readRestoreJournal();
  const last = read.state === 'read' ? read.journal : null;
  // C5: while an op runs, only its own journal is shown; an earlier restore's record is not this one's.
  const j = last && (!op || op.kind === 'recovery' || opStarts.get(op) === last.startedAt) ? last : null;
  if (!j && !op && !l) return null;
  const shown: Record<string, unknown> = {};
  if (j) for (const key of SHOWN) if (j[key] !== undefined) shown[key] = j[key];
  const view: RestoreView = { ...shown, name: j?.name ?? op?.name ?? l?.name ?? null, stage: j?.stage ?? null, state: gate.state, ...base, line: null };
  if (op) {
    view.waiting = waitingLine(op, j?.stage ?? null);
    if (op.name) view.name = op.name;
  }
  if (latchText) view.line = latchText;
  else if (op) view.line = view.waiting ?? `Restoring ${view.name}: ${(j && RUNNING_WORDS[j.stage]) || (opsEnding.has(op) ? RUNNING_WORDS.done : RUNNING_WORDS.staging)}.`;
  else if (gate.state === 'stuck') view.line = stuckText(gate.journal);
  else if (gate.state === 'unfinished') view.line = unfinishedText(gate.journal);
  else if (j?.stage === 'placed') view.line = placedLine(j);
  else if (j?.stage === 'done' || j?.stage === 'failed') view.line = endedLine(j, host);
  return view;
}

function latch(l: Omit<RestoreLatch, 'at'>): void {
  if (restoreLatch()) return;
  const set: RestoreLatch = { at: Date.now(), ...l } as RestoreLatch;
  setRestoreLatch(set);
  console.error(latchLog(set));
}

// ---------------------------------------------------------------------------------------------------------------
// Journal writes
// ---------------------------------------------------------------------------------------------------------------

/** Writes the journal; a throw sets the latch (decision 48 (a)) and answers false. */
function write(j: RestoreJournal, extra: Partial<RestoreLatch> = {}): boolean {
  try {
    writeRestoreJournal(j);
  } catch (error) {
    latch({ name: j.name, kind: 'journal', stage: j.stage, errno: errnoOf(error), preRestore: j.preRestore, ...extra });
    return false;
  }
  console.log(`[Backup] Restore of ${j.name}: ${j.stage}`);
  return true;
}

/** Removes the staging folder; null when gone, else its leftover. */
async function removeStaging(j: RestoreJournal): Promise<{ path: string; errno: string } | null> {
  try {
    await fs.promises.rm(stagingRoot(j), { recursive: true, force: true });
    return null;
  } catch (error) {
    const leftover = { path: cp(stagingRoot(j)), errno: errnoOf(error) };
    console.error(`[Backup] Restore of ${j.name}: could not remove ${leftover.path} (${leftover.errno})`);
    return leftover;
  }
}

/** Decision 51: staging removed first, then `failed`; answers false when that write latched. */
async function endFailed(j: RestoreJournal, cause: string): Promise<boolean> {
  const leftover = await removeStaging(j);
  const failed: RestoreJournal = { ...j, stage: 'failed', result: 'failed', error: cause, finishedAt: Date.now(), ...(leftover ? { leftover } : {}) };
  delete failed.aside;
  return write(failed);
}

// ---------------------------------------------------------------------------------------------------------------
// Folder syncs (N5)
// ---------------------------------------------------------------------------------------------------------------

type SyncOutcome = { ok: true } | { ok: false; kind: 'sync' | 'open'; dir: string; errno: string } | { ok: false; kind: 'disk'; disk: DiskError };

async function syncStep(paths: readonly string[]): Promise<SyncOutcome> {
  const answer: ChainAnswer = await fsyncDirs(paths);
  if (answer.failed && answer.kind !== 'earlier') return { ok: false, kind: answer.kind, dir: answer.dir, errno: answer.errno };
  const disk = diskError();
  if (answer.failed) return { ok: false, kind: 'disk', disk: disk ?? { dir: cp(answer.dir), errno: answer.errno, at: null, by: null, files: [], unreadable: false } };
  return disk ? { ok: false, kind: 'disk', disk } : { ok: true };
}

/** Sets the latch for a sync step from phase A on; `record` marks the `swapping` record's own sync. */
function latchSync(j: RestoreJournal, stage: RestoreStage, outcome: Exclude<SyncOutcome, { ok: true }>, opts: { record?: boolean; placedAt?: number } = {}): void {
  const base = { name: j.name, stage, preRestore: j.preRestore, ...(opts.placedAt !== undefined ? { placedAt: opts.placedAt } : {}) };
  if (outcome.kind === 'disk') {
    latch({ ...base, kind: 'disk', folder: outcome.disk.dir, errno: outcome.disk.errno, disk: outcome.disk, ...(opts.record ? { record: true } : {}) });
    return;
  }
  const kind = opts.record ? 'journal-sync' : 'fsync';
  latch({ ...base, kind, folder: cp(outcome.dir), errno: outcome.errno, ...(outcome.kind === 'open' ? { open: true } : {}) });
}

function existing(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter(p => {
    if (seen.has(p) || !isDir(p)) return false;
    seen.add(p);
    return true;
  });
}

/** Every folder under root, deepest first. */
async function foldersUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      found.push(full);
      await walk(full);
    }
  };
  await walk(root);
  return found.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
}

/** The folders that hold `rels` under root, and their parents up to root, deepest first. */
function holders(root: string, rels: readonly string[]): string[] {
  const out = new Set<string>();
  for (const rel of rels) {
    const parts = relPath(rel);
    for (let i = parts.length - 1; i >= 1; i--) out.add(path.join(root, ...parts.slice(0, i)));
  }
  return [...out].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
}

/** Decision 35's folders before `placing`. */
function beforePlacingFolders(j: RestoreJournal, aside: readonly string[]): string[] {
  const asideData = path.join(asideRoot(j), 'data');
  return existing([
    ...holders(DATA_ROOT, aside), DATA_ROOT, dataPath('global'), dataPath('dist', 'bot'),
    ...holders(asideData, aside), asideData, asideRoot(j), snapshotsRoot(),
  ]);
}

/** Decision 28's folders at step 6. */
function stepSixFolders(j: RestoreJournal, aside: readonly string[], placed: readonly string[]): string[] {
  const asideData = path.join(asideRoot(j), 'data');
  const stagingData = path.join(stagingRoot(j), 'data');
  return existing([
    ...holders(DATA_ROOT, placed), DATA_ROOT, dataPath('global'), dataPath('dist', 'bot'),
    path.join(stagingData, 'global'), path.join(stagingData, 'dist', 'bot'), stagingData,
    ...holders(asideData, aside), path.join(asideData, 'global'), path.join(asideData, 'dist', 'bot'), asideData, asideRoot(j),
    snapshotsRoot(),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------
// The moves (phase A, phase B), shared by the op and recovery
// ---------------------------------------------------------------------------------------------------------------

type MoveEnd = 'next' | 'stopped';

function stuck(j: RestoreJournal, stuckAt: 'swapping' | 'placing', rel: string, cause: 'in-the-way' | 'rename', errno?: string): void {
  const next: RestoreJournal = { ...j, stage: 'stuck', stuckAt, path: rel, cause, ...(errno ? { errno } : {}) };
  if (!errno) delete next.errno;
  if (write(next)) console.error(`[Backup] ${stuckText(next)}`);
}

/** Phase A: each `aside` item still live whose aside path is absent is renamed aside; one in neither place is missing. */
function phaseA(j: RestoreJournal): { end: MoveEnd; missing: string[] } {
  const asideData = path.join(asideRoot(j), 'data');
  const missing: string[] = [];
  for (const rel of (j.aside as string[] | undefined) ?? []) {
    const live = dataPath(...relPath(rel));
    const aside = path.join(asideData, ...relPath(rel));
    if (exists(aside)) continue;
    if (!exists(live)) {
      missing.push(rel);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(aside), { recursive: true });
      fs.renameSync(live, aside);
    } catch (error) {
      stuck(j, 'swapping', rel, 'rename', errnoOf(error));
      return { end: 'stopped', missing };
    }
  }
  return { end: 'next', missing };
}

/** Phase B: each item still in staging is renamed into place; a live path where it must go stops it. */
function phaseB(j: RestoreJournal): { end: MoveEnd; placed: string[] } {
  const stagingData = path.join(stagingRoot(j), 'data');
  const items = exists(stagingData) ? topItems(stagingData) : [];
  const placed: string[] = [];
  for (const rel of items) {
    const live = dataPath(...relPath(rel));
    if (exists(live)) {
      stuck(j, 'placing', rel, 'in-the-way');
      return { end: 'stopped', placed };
    }
    try {
      fs.mkdirSync(path.dirname(live), { recursive: true });
      fs.renameSync(path.join(stagingData, ...relPath(rel)), live);
      placed.push(rel);
    } catch (error) {
      stuck(j, 'placing', rel, 'rename', errnoOf(error));
      return { end: 'stopped', placed };
    }
  }
  return { end: 'next', placed };
}

/** From `swapping` with phase A done or going on: the sync before `placing`, `placing`, phase B, step 6, `placed`. */
async function finishFromSwapping(j: RestoreJournal): Promise<RestoreJournal | null> {
  const a = phaseA(j);
  if (a.end === 'stopped') return null;
  const aside = (j.aside as string[] | undefined) ?? [];
  const synced = await syncStep(beforePlacingFolders(j, aside));
  if (!synced.ok) {
    latchSync(j, 'swapping', synced);
    return null;
  }
  const placing: RestoreJournal = { ...j, stage: 'placing', ...(a.missing.length ? { missing: [...new Set([...((j.missing as string[] | undefined) ?? []), ...a.missing])] } : {}) };
  if (!write(placing)) return null;
  return finishFromPlacing(placing);
}

/** From `placing`: phase B, step 6's sync, the knowledge dropped, `placed`. */
async function finishFromPlacing(j: RestoreJournal): Promise<RestoreJournal | null> {
  const b = phaseB(j);
  if (b.end === 'stopped') return null;
  const synced = await syncStep(stepSixFolders(j, (j.aside as string[] | undefined) ?? [], b.placed));
  if (!synced.ok) {
    latchSync(j, 'placing', synced);
    return null;
  }
  forgetSharedFileKnowledge();
  const placed: RestoreJournal = { ...j, stage: 'placed', placedAt: Date.now() };
  if (!write(placed)) return null;
  await removeStaging(placed);
  return placed;
}

// ---------------------------------------------------------------------------------------------------------------
// The POST
// ---------------------------------------------------------------------------------------------------------------

/** Decision 8's store rule: the marker names `file`, or no marker and no migration files, and the backend is `file`. */
export function isJsonBot(): boolean {
  if (resolveDataBackend() !== 'file') return false;
  const facts = readDataFacts();
  if (!facts.ok) return true;
  if (facts.marker) return facts.marker.live === 'file';
  return !facts.journal && !facts.storesExist;
}

const refuse = (status: number, error: string): PostAnswer => ({ status, body: { success: false, error } });

/**
 * POST /api/backups/restore's body after its 400 checks (decision 51). The first turn answers the first refusal that
 * holds or sets `restoreOp`; then the device and free space checks, the `staging` record and the answer, with the op
 * running on after it.
 */
export async function postRestore(host: RestoreHost, name: string): Promise<PostAnswer> {
  const held = restoreLatch();
  if (held) return refuse(409, latchLine(held));
  const disk = diskError();
  if (disk) return refuse(409, diskRefusalText(disk));
  const gate = restoreGate();
  if (gate.state === 'running') {
    const opName = restoreOp()?.name ?? gate.name ?? name;
    return { status: 202, body: { success: true, state: 'running', name: opName, note: RUNNING_NOTE(opName) } };
  }
  if (gate.state === 'unknown') return refuse(409, journalUnreadableText(gate.cause));
  if (gate.state === 'stuck') return refuse(409, stuckText(gate.journal));
  if (gate.state === 'unfinished') return refuse(409, unfinishedText(gate.journal));
  if (gate.state === 'clear' && gate.stage === 'placed' && gate.journal) return refuse(409, placedPostText(gate.journal));
  const work = backupWorkRunning();
  if (work === 'take') return refuse(409, TAKE_RUNNING_TEXT);
  if (work === 'test') return refuse(409, TEST_RUNNING_TEXT);
  if (!isJsonBot()) return refuse(409, POSTGRES_TEXT);
  const migration = migrationState(host.migrationRunning());
  if (migration.kind === 'unknown') return refuse(409, migrationUnknownText(migration.cause));
  if (migration.kind !== 'none') return refuse(409, MIGRATION_TEXT);
  const snapshot = readSnapshot(name);
  if (snapshot.state !== 'complete' || snapshot.kind === null) {
    const format = snapshot.state === 'damaged' ? /^format (.+), which this version cannot read$/.exec(snapshot.cause)?.[1] : undefined;
    if (format !== undefined) return refuse(409, `The backup ${name} was written in a format this version cannot read (${format}).`);
    return refuse(404, `No complete backup is named ${name}.`);
  }
  if ((host.isRunning() || host.hasUnexitedChildren()) && readMaintenanceFile().state !== 'maintenance') return refuse(409, RUNNING_BOT_TEXT);
  const op: RestoreOp = { kind: 'restore', name };
  setRestoreOp(op);

  const early = await checksAfterTurn(snapshot.manifest);
  if (early) {
    await endWithoutJournal(host, op);
    return refuse(409, early);
  }

  const startedAt = Date.now();
  opStarts.set(op, startedAt);
  const t = formatTime(startedAt);
  const journal: RestoreJournal = {
    format: 1, name, startedAt, stage: 'staging', staging: `.restore-${t}`, preRestore: `pre-restore-${t}`,
    takenAt: snapshot.manifest.takenAt, files: snapshot.manifest.counts?.files ?? snapshot.manifest.files.length,
  };
  if (!write(journal)) {
    const line = latchLine(restoreLatch()!);
    await endWithoutJournal(host, op);
    return refuse(500, line);
  }
  running = runOp(host, op, journal, snapshot.manifest).finally(() => { running = null; });
  return { status: 202, body: { success: true, state: 'started', name } };
}

async function checksAfterTurn(manifest: Manifest): Promise<string | null> {
  try {
    const [live, snaps] = await Promise.all([fs.promises.stat(DATA_ROOT), fs.promises.stat(snapshotsRoot())]);
    if (live.dev !== snaps.dev) return DEVICE_TEXT;
  } catch { /* a stat that fails compares nothing; a rename across devices then stops phase A before any move */ }
  try {
    const st = await fs.promises.statfs(DATA_ROOT);
    const free = Number(st.bavail) * Number(st.bsize);
    const need = (manifest.counts?.bytes ?? 0) + FREE_MARGIN_BYTES;
    if (free < need) return `Not enough free disk space under /data: ${mib(free)} free, ${mib(need)} needed (the backup's size plus 256 MiB).`;
  } catch { /* no free-space figure: a full disk fails the copy at step 3, before anything live moves */ }
  return null;
}

/** Decisions 56 and 65: with no journal for this op, a bot whose automatic start was refused is started, then the op ends. */
async function endWithoutJournal(host: RestoreHost, op: RestoreOp): Promise<void> {
  opsEnding.add(op);
  if (op.stopped) await startAgain(host, op);
  if (restoreOp() === op) setRestoreOp(null);
}

async function startAgain(host: RestoreHost, op: RestoreOp): Promise<void> {
  try {
    const started = await host.start({ restoreOp: op });
    console.log(started.success
      ? `[Backup] Restore of ${op.name}: started the bot again`
      : `[Backup] Restore of ${op.name}: could not start the bot again (${started.error ?? started.reason ?? 'no cause given'})`);
  } catch (error) {
    console.error(`[Backup] Restore of ${op.name}: could not start the bot again (${error instanceof Error ? error.message : String(error)})`);
  }
}

class StepTimeout extends Error {}

/** One call with its own timer (code review 1): the signal is read only between files, so the timer fails the step. */
async function bounded<T>(deadline: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new StepTimeout());
    }, Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([work(controller.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

function mismatchCause(answer: Exclude<VerifyAnswer, { ok: true }>): string {
  const first = answer.differences[0];
  if (first) return `The copy differs from what was recorded when the backup was taken: ${answer.count} difference${answer.count === 1 ? '' : 's'}, first ${first.path} (${first.reason}).`;
  return countsDifferText(answer.counts);
}

function copyCause(j: RestoreJournal, error: unknown): string {
  if (error instanceof StepTimeout) return 'The copy and check of the backup took longer than 30 minutes and were stopped.';
  const code = (error as { code?: unknown } | null)?.code;
  if (code === undefined) return error instanceof Error ? error.message : String(error);
  const where = typeof (error as { path?: unknown }).path === 'string' ? cp((error as { path: string }).path) : cp(stagingRoot(j));
  return `Could not copy the backup into ${cp(stagingRoot(j))}: ${where} (${String(code)}).`;
}

/** Step 3's sync answer as a failed cause (decision 70, N5); null when the copy is on disk. */
function stepThreeSyncCause(outcome: SyncOutcome): string | null {
  if (outcome.ok) return null;
  if (outcome.kind === 'disk') return `${diskWhy(outcome.disk)}, so can't confirm the copy is on disk.`;
  if (outcome.kind === 'open') return `${cp(outcome.dir)} could not be opened for its sync while the copied backup was synced (${outcome.errno}), so can't confirm the copy is on disk.`;
  return `The disk reported an error while the copied backup was synced (${cp(outcome.dir)}: ${outcome.errno}), so can't confirm the copy is on disk.`;
}

/** Step 3: the copy, its check and its syncs, inside 30 minutes; a cause when it failed. */
async function stepThree(j: RestoreJournal, manifest: Manifest): Promise<string | null> {
  const deadline = Date.now() + timing.stageMs;
  const stagingData = path.join(stagingRoot(j), 'data');
  try {
    await bounded(deadline, signal => copySnapshot(j.name, stagingData, { signal }));
    const verdict = await bounded(deadline, signal => verifyTree(stagingData, manifest, { signal }));
    if (!verdict.ok) return mismatchCause(verdict);
    const folders = await bounded(deadline, () => foldersUnder(stagingData));
    return stepThreeSyncCause(await bounded(deadline, () => syncStep([...folders, stagingData, stagingRoot(j), snapshotsRoot()])));
  } catch (error) {
    return copyCause(j, error);
  }
}

function lockTakeCause(take: Extract<RestoreOpAnswer<unknown>, { taken: false; take: unknown }>['take']): string {
  if (take.kind === 'held' && take.holder) return `Another process holds the data files (${holderWords(take.holder)}, pid ${take.holder.pid}).`;
  if (take.kind === 'previous') return `Another process holds the data files (a bot process this web panel started, pid ${take.pid}).`;
  if (take.kind === 'held' || take.kind === 'contended') return 'Another process was taking over the data files.';
  if (take.kind === 'unreadable') return `Can't confirm which process holds the data files (/data/.writer.lock: ${take.errno}).`;
  return `The data disk does not take writes (/data/.writer.lock: ${take.errno}).`;
}

/** C20's step 4 cause: a disk error stands once every child exited. */
function stepFourDiskCause(d: DiskError): string {
  if (d.unreadable || isFolderCase(d)) return restartSwitch(`${diskWhy(d)}, so can't confirm the bot's last changes are on disk; check the disk, then restart the bot's container before you try again.`);
  return restartSwitch(`The disk reported an error when ${cp(d.dir)} was synced (${d.errno}) before the restore moved any data, so can't confirm the bot's last changes are on disk; check the disk, then restart the bot's container before you try again.`);
}

/** Step 4: stops a running child and waits for every child; a cause when the restore must end failed. */
async function stepFour(host: RestoreHost, op: RestoreOp): Promise<string | null> {
  const deadline = Date.now() + timing.stopMs;
  let killed = false;
  let pid: number | undefined;
  if (host.isRunning()) {
    pid = host.getStatus().processId;
    op.stopped = true;
    killed = (await host.shutdown(false)).killed;
  }
  const children = await host.awaitNoChildren(deadline);
  if (children === 'running') return NOT_STOPPED;
  if (children === 'channel') return CHANNEL_OPEN;
  if (pid !== undefined) {
    const lock = readWriterHolder();
    if (lock.kind === 'held' && lock.holder.pid === pid) return killed ? KILLED : LEFT_LOCK;
  }
  const disk = diskError();
  return disk ? stepFourDiskCause(disk) : null;
}

/** The POST's op from step 3 to its start (decisions 11, 27, 29, 35, 51, 55, 56, C19, C20, N5). */
async function runOp(host: RestoreHost, op: RestoreOp, staging: RestoreJournal, manifest: Manifest): Promise<void> {
  let startAfter = false;
  try {
    const copied = await stepThree(staging, manifest);
    if (copied) {
      startAfter = await endFailed(staging, copied);
      return;
    }
    const staged: RestoreJournal = { ...staging, stage: 'staged' };
    if (!write(staged)) return;

    const stopCause = await stepFour(host, op);
    if (stopCause) {
      startAfter = await endFailed(staged, stopCause);
      return;
    }

    const answer = await host.runRestoreOp(() => swapAndPlace(staged));
    if (!answer.taken) {
      if ('exiting' in answer) return;
      startAfter = await endFailed(staged, lockTakeCause(answer.take));
      return;
    }
    startAfter = answer.value !== null;
  } catch (error) {
    console.error(`[Backup] Restore of ${op.name} stopped: ${error instanceof Error ? error.message : String(error)}; the next start of the bot's container takes it up from its record`);
  } finally {
    if (startAfter && op.stopped && !restoreLatch()) await startAgain(host, op);
    if (restoreOp() === op) setRestoreOp(null);
  }
}

/** Steps 5 and 6 inside the op's chain entry, with the lock held; the `placed` journal, or null when it stopped. */
async function swapAndPlace(staged: RestoreJournal): Promise<RestoreJournal | null> {
  const swapping: RestoreJournal = { ...staged, stage: 'swapping', aside: topItems(DATA_ROOT) };
  if (!write(swapping)) return null;
  const recordSync = await syncStep([snapshotsRoot()]);
  if (!recordSync.ok) {
    latchSync(swapping, 'swapping', recordSync, { record: true });
    return null;
  }
  return finishFromSwapping(swapping);
}

// ---------------------------------------------------------------------------------------------------------------
// Recovery in main() (decisions 24, 49, 58, 59, 72)
// ---------------------------------------------------------------------------------------------------------------

export type RecoveryEnd = 'ended' | 'exiting';

/**
 * main()'s read in the turn it queues recovery: an open or unreadable journal sets `restoreOp` in this turn and answers
 * recovery's promise; a journal that is readable and not open answers null.
 */
export function beginRecovery(host: RestoreHost): Promise<RecoveryEnd> | null {
  const read = readRestoreJournal();
  if (read.state === 'none' || (read.state === 'read' && !isOpenStage(read.journal.stage))) return null;
  const op: RestoreOp = { kind: 'recovery', name: read.state === 'read' ? read.journal.name : null };
  setRestoreOp(op);
  return recover(host, op);
}

function waitingOf(take: Extract<RestoreOpAnswer<unknown>, { taken: false; take: unknown }>['take']): RestoreWaiting {
  if (take.kind === 'held') return { cause: 'held', holder: take.holder ? { role: take.holder.role ?? null, pid: take.holder.pid } : null };
  if (take.kind === 'previous') return { cause: 'held', holder: { role: 'previous', pid: take.pid } };
  if (take.kind === 'contended') return { cause: 'contended' };
  return { cause: take.kind, errno: take.errno };
}

async function recover(host: RestoreHost, op: RestoreOp): Promise<RecoveryEnd> {
  let lastLog = -Infinity;
  for (;;) {
    if (host.isExiting()) return 'exiting';
    const read = readRestoreJournal();
    if (read.state === 'read' && isOpenStage(read.journal.stage)) {
      op.name = read.journal.name;
      delete op.waiting;
      break;
    }
    if (read.state === 'none' || read.state === 'read') {
      delete op.waiting;
      return 'ended';
    }
    op.waiting = { cause: 'journal', errno: read.cause };
    if (Date.now() - lastLog >= timing.logEveryMs) {
      lastLog = Date.now();
      console.warn(`[Backup] ${journalWords()} cannot be read (${read.cause}); the web panel waits before it starts the bot`);
    }
    await sleep(timing.journalReadMs);
  }

  let lastKey: string | null = null;
  lastLog = -Infinity;
  for (;;) {
    if (host.isExiting()) return 'exiting';
    let answer: RestoreOpAnswer<void>;
    try {
      answer = await host.runRestoreOp(() => recoveryStep(op));
    } catch (error) {
      console.error(`[Backup] Restore of ${op.name} stopped: ${error instanceof Error ? error.message : String(error)}; the next start of the bot's container takes it up from its record`);
      return 'ended';
    }
    if (answer.taken) return 'ended';
    if ('exiting' in answer) return 'exiting';
    const waiting = waitingOf(answer.take);
    op.waiting = waiting;
    const key = JSON.stringify(waiting);
    if (key !== lastKey || Date.now() - lastLog >= timing.logEveryMs) {
      lastKey = key;
      lastLog = Date.now();
      console.warn(`[Backup] Restore of ${op.name} waits: ${waitingReason(waiting)}; it goes on as soon as that ends`);
    }
    await sleep(waiting.cause === 'held' || waiting.cause === 'contended' ? timing.heldRetryMs : timing.slowRetryMs);
  }
}

/** Decision 72: `aside` not empty, every item live and none aside, so nothing has moved. */
function nothingMoved(j: RestoreJournal): boolean {
  const aside = (j.aside as string[] | undefined) ?? [];
  if (aside.length === 0) return false;
  const asideData = path.join(asideRoot(j), 'data');
  return aside.every(rel => exists(dataPath(...relPath(rel))) && !exists(path.join(asideData, ...relPath(rel))));
}

/** The recovery's stage rules inside its chain entry, with the lock held. */
async function recoveryStep(op: RestoreOp): Promise<void> {
  delete op.waiting;
  const read = readRestoreJournal();
  if (read.state !== 'read' || !isOpenStage(read.journal.stage)) return;
  let j = read.journal;
  if (j.stage === 'stuck') {
    const back: RestoreJournal = { ...j, stage: j.stuckAt as RestoreStage };
    for (const field of ['stuckAt', 'path', 'cause', 'errno']) delete back[field];
    if (!write(back)) return;
    j = back;
  }
  if (j.stage === 'staging' || j.stage === 'staged' || (j.stage === 'swapping' && nothingMoved(j))) {
    await endFailed(j, INTERRUPTED);
    return;
  }
  // C20 and K3: a disk error that stands is read before any move in this process.
  const disk = diskError();
  if (disk) {
    latch({ name: j.name, kind: 'disk', stage: j.stage, folder: disk.dir, errno: disk.errno, disk, preRestore: j.preRestore });
    return;
  }
  if (j.stage === 'swapping') await finishFromSwapping(j);
  else await finishFromPlacing(j);
}

/** The safe-mode line after recovery (decision 62), by the journal's stage then. */
export function safeModeLine(): string {
  const read = readRestoreJournal();
  const stage = read.state === 'read' ? read.journal.stage : null;
  const what = stage === 'placed' ? 'the data is in place'
    : stage === 'failed' ? 'the restore ended failed with the data unchanged'
      : stage !== null && isOpenStage(stage) ? 'the restore stopped part way, and the Dashboard tab says what to do'
        : 'no restore was left to finish';
  return `[Main] [Warning] Safe mode: the backup restore's recovery ended (${what}); the bot was not started and waits for a manual start`;
}

export const MAIN_SKIP_LINE = '[Main] Bot not started: the backup restore could not finish; the Dashboard tab says what to do';

// ---------------------------------------------------------------------------------------------------------------
// Step 8 at the tick (decisions 34, 50, 68, 71)
// ---------------------------------------------------------------------------------------------------------------

async function hashOf(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const handle = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

class ReadStop extends Error {
  constructor(readonly at: string, readonly errno: string) {
    super(errno);
  }
}

/** The aside tree read strictly: an entry that cannot be read stops it; one the operator moved out is left out. */
async function readAside(root: string): Promise<{ files: ManifestFile[]; dirs: string[] }> {
  const files: ManifestFile[] = [];
  const dirs: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const dir = rel ? path.join(root, ...relPath(rel)) : root;
    let entries: string[];
    try {
      entries = (await fs.promises.readdir(dir)).sort();
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return;
      throw new ReadStop(dir, errnoOf(error));
    }
    for (const name of entries) {
      const childRel = rel ? `${rel}/${name}` : name;
      const full = path.join(root, ...relPath(childRel));
      let st: fs.Stats;
      try {
        st = await fs.promises.lstat(full);
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') continue;
        throw new ReadStop(full, errnoOf(error));
      }
      if (st.isDirectory()) {
        dirs.push(childRel);
        await walk(childRel);
      } else if (st.isFile()) {
        let sha256: string;
        try {
          sha256 = await hashOf(full);
        } catch (error) {
          if (errnoOf(error) === 'ENOENT') continue;
          throw new ReadStop(full, errnoOf(error));
        }
        files.push({ path: childRel, size: st.size, sha256, sig: { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs } });
      } else {
        throw new ReadStop(full, 'not a file or folder');
      }
    }
  };
  await walk('');
  return { files, dirs };
}

let stepEightRunning = false;

/**
 * Step 8: the replaced data recorded as a pre-restore backup, then `done`. Runs only while the gate answers `clear` at
 * `placed` with the latch null; a note is left on the journal when it cannot finish, and each tick tries again.
 */
export async function recordReplacedData(): Promise<'done' | 'note' | 'latched' | 'not-run'> {
  if (stepEightRunning || restoreLatch()) return 'not-run';
  const gate = restoreGate();
  if (gate.state !== 'clear' || gate.stage !== 'placed' || !gate.journal) return 'not-run';
  stepEightRunning = true;
  try {
    return await stepEight(gate.journal);
  } finally {
    stepEightRunning = false;
  }
}

async function stepEight(j: RestoreJournal): Promise<'done' | 'note' | 'latched'> {
  const finalPath = dataPath('_snapshots', j.preRestore);
  const asidePath = asideRoot(j);
  const placedAt = typeof j.placedAt === 'number' ? j.placedAt : j.startedAt;
  const step8 = { step8: true, placedAt, preRestore: j.preRestore };
  const leaveNote = (note: { cause: string; path?: string; errno: string }): 'note' | 'latched' => {
    const noted: RestoreJournal = { ...j, note };
    try {
      writeRestoreJournal(noted);
    } catch (error) {
      latch({ name: j.name, kind: 'journal', stage: 'placed', errno: errnoOf(error), note, ...step8 });
      return 'latched';
    }
    console.error(`[Backup] Restore of ${j.name}: the record of the replaced data could not be written yet (${note.errno}); it is tried again every minute`);
    return 'note';
  };

  let complete = readSnapshot(j.preRestore).state === 'complete';
  if (!complete) {
    let tree: { files: ManifestFile[]; dirs: string[] };
    try {
      tree = await readAside(path.join(asidePath, 'data'));
    } catch (error) {
      if (error instanceof ReadStop) return leaveNote({ cause: 'read', path: error.at, errno: error.errno });
      return leaveNote({ cause: 'read', path: asidePath, errno: errnoOf(error) });
    }
    const work = parseWorkName(asideFolder(j));
    const takenAt = work && 'time' in work ? work.time : j.startedAt;
    const manifest: Manifest = {
      format: 1, name: j.preRestore, kind: 'pre-restore', takenAt, botVersion: getAppVersion(),
      counts: countsOf(tree), files: tree.files, dirs: tree.dirs,
    };
    try {
      atomicWriteFileSync(path.join(asidePath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, undefined, { chain: false });
    } catch (error) {
      return leaveNote({ cause: 'manifest', errno: errnoOf(error) });
    }
    try {
      fs.renameSync(asidePath, finalPath);
    } catch (error) {
      return leaveNote({ cause: 'rename', errno: errnoOf(error) });
    }
    complete = true;
  }
  const synced = await syncStep([snapshotsRoot()]);
  if (!synced.ok) {
    latchSync(j, 'placed', synced, { placedAt });
    return 'latched';
  }
  const done: RestoreJournal = { ...j, stage: 'done', result: 'done', finishedAt: Date.now() };
  delete done.note;
  try {
    writeRestoreJournal(done);
  } catch (error) {
    latch({ name: j.name, kind: 'journal', stage: 'done', errno: errnoOf(error), complete, ...step8 });
    return 'latched';
  }
  console.log(`[Backup] Restore of ${j.name}: done`);
  return 'done';
}
