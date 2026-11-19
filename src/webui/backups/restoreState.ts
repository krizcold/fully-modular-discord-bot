import { readRestoreJournal, restoreJournalPath, type RestoreJournal, type RestoreStage } from '../../bot/internalSetup/utils/backups/restoreJournal';
import { bootId, containerPath, diskRecord } from '../../bot/internalSetup/utils/folderChain';

// NB8 decisions 37, 46 to 48, 54 to 56, 62 and 65: the restore state is the journal on disk, `restoreOp` and the latch;
// each gate reads all three through restoreGate() in its own turn. The take and the daily test mark themselves in
// backupWorkRunning(). Files under src/webui/backups import botManager.ts only as a type; this module imports no web UI
// module.

export interface RestoreWaiting {
  cause: 'journal' | 'held' | 'contended' | 'unreadable' | 'unwritable';
  holder?: { role: string | null; pid: number } | null;
  errno?: string;
}

/** The one restore or recovery in flight in this process; `stopped` is a POST's op only (decision 56). */
export interface RestoreOp {
  kind: 'restore' | 'recovery';
  name: string | null;
  waiting?: RestoreWaiting;
  stopped?: boolean;
}

export type LatchKind = 'journal' | 'fsync' | 'journal-sync' | 'disk';

export interface RestoreLatch {
  at: number;
  name: string;
  kind: LatchKind;
  stage: RestoreStage;
  folder?: string;
  errno: string;
  [field: string]: unknown;
}

export type RestoreGateAnswer =
  | { state: 'clear'; stage: 'placed' | 'done' | 'failed' | null; journal: RestoreJournal | null; latch: RestoreLatch | null }
  | { state: 'running'; name: string | null; latch: RestoreLatch | null }
  | { state: 'stuck' | 'unfinished'; journal: RestoreJournal; latch: RestoreLatch | null }
  | { state: 'unknown'; cause: string; latch: RestoreLatch | null };

export type BackupWork = 'take' | 'test';

let op: RestoreOp | null = null;
let latch: RestoreLatch | null = null;
let work: BackupWork | null = null;

export function restoreOp(): RestoreOp | null {
  return op;
}

export function setRestoreOp(next: RestoreOp | null): void {
  op = next;
}

export function restoreLatch(): RestoreLatch | null {
  return latch;
}

/** Sets the latch; only the end of the process clears it, so a second set keeps the first. */
export function setRestoreLatch(next: RestoreLatch): void {
  if (!latch) latch = next;
}

export function backupWorkRunning(): BackupWork | null {
  return work;
}

export function setBackupWorkRunning(next: BackupWork | null): void {
  work = next;
}

/** Tests only. */
export function _resetRestoreStateForTests(): void {
  op = null;
  latch = null;
  work = null;
}

/**
 * Decision 46: reads restore.json in the caller's turn, then `restoreOp` and the latch, and answers the first that
 * holds. A caller passing the current op as `own` is not refused by it (the op's own start, `main()`'s start).
 */
export function restoreGate(own?: RestoreOp | null): RestoreGateAnswer {
  const read = readRestoreJournal();
  if (read.state === 'unreadable') return { state: 'unknown', cause: read.cause, latch };
  if (op && op !== own) return { state: 'running', name: op.name, latch };
  if (read.state === 'none') return { state: 'clear', stage: null, journal: null, latch };
  const { journal } = read;
  if (journal.stage === 'stuck') return { state: 'stuck', journal, latch };
  if (journal.stage === 'staging' || journal.stage === 'staged' || journal.stage === 'swapping' || journal.stage === 'placing') {
    return { state: 'unfinished', journal, latch };
  }
  return { state: 'clear', stage: journal.stage, journal, latch };
}

export const RESTORE_RUNNING_START = 'A backup restore is running';
export const RESTORE_RUNNING_WRITE = 'A backup restore is running; nothing was saved. Save again once it has finished.';
const STUCK_WRITE = 'The last backup restore stopped part way; nothing was saved. The Dashboard tab says what to do.';
const STUCK_START = 'The last backup restore stopped part way, so the bot does not start; the Dashboard tab says what to do.';
const journalWords = (): string => containerPath(restoreJournalPath());

/** Decision 15's can't-confirm text: the restore POST's refusal and start()'s. */
export const journalUnreadableText = (cause: string): string =>
  `can't confirm the state of the last backup restore: ${journalWords()} cannot be read (${cause}). The bot does not start until it can be read; if no restore ran, remove that file.`;

export type ClosedRestoreGate = Exclude<RestoreGateAnswer, { state: 'clear' }>;
type Closed = ClosedRestoreGate;

/** Decision 54: the refusal of `writerRoute`, `routeProbe`, `hopFailure` and the maintenance hook. */
export function gateWriteText(answer: Closed): string {
  if (answer.state === 'running') return RESTORE_RUNNING_WRITE;
  if (answer.state === 'unknown') return `can't confirm whether a backup restore is running (${journalWords()}: ${answer.cause}); nothing was saved. Save again once that file can be read.`;
  return STUCK_WRITE;
}

/** Decision 54: start()'s refusal. */
export function gateStartText(answer: Closed): string {
  if (answer.state === 'running') return RESTORE_RUNNING_START;
  if (answer.state === 'unknown') return journalUnreadableText(answer.cause);
  return STUCK_START;
}

/** Decision 44's NB5 forms (C16): the owner channel PUT's refusal; `unfinished` takes the stuck form. */
export function gateOwnerChannelText(answer: Closed): string {
  if (answer.state === 'running') return 'A backup restore is running; change the setting once it has finished; nothing was changed';
  if (answer.state === 'unknown') return `can't confirm whether a backup restore is running (${journalWords()}: ${answer.cause}); change the setting once that file can be read; nothing was changed`;
  return 'The last backup restore stopped part way (the Dashboard tab says what to do); change the setting once it has finished; nothing was changed';
}

/** Decision 62: restart()'s and requestRestart()'s refusal while a child runs; nothing was stopped. */
export function gateRestartText(answer: Closed): string {
  if (answer.state === 'running') return 'A backup restore is running, so the bot was not restarted; it was not stopped. Restart it once the restore has finished.';
  if (answer.state === 'unknown') return `can't confirm whether a backup restore is running (${journalWords()}: ${answer.cause}), so the bot was not restarted; it was not stopped.`;
  return 'The last backup restore stopped part way, so the bot was not restarted; it was not stopped. The Dashboard tab says what to do.';
}

/** Decisions 54 and 62: a take's refusal words (`lastRefusal.words`) for a closed gate. */
export function gateTakeWords(answer: Closed): string {
  if (answer.state === 'running') return 'a backup restore was starting or running.';
  if (answer.state === 'unknown') return `can't confirm whether a backup restore was running (${journalWords()}: ${answer.cause}).`;
  return 'the last backup restore did not finish.';
}

/** Decision 70: restart()'s answer when its own start after its stop was refused during a POST's op. */
export const RESTART_DURING_RESTORE_TEXT = 'A backup restore began while the bot restarted: the bot was stopped, and the restore starts it again when it finishes.';

/** C15 and decision 31: a data migration's refusal (NB3's S0 and post()), null when nothing refuses it. */
export function migrationRefusal(answer: RestoreGateAnswer, running: BackupWork | null): string | null {
  if (answer.state === 'unknown') return journalUnreadableText(answer.cause);
  if (answer.state !== 'clear') return 'A backup restore is running or did not finish; start the migration once it has finished.';
  if (running === 'take') return 'A backup is being taken now; start the migration once it has finished.';
  return null;
}

/**
 * B6 as H5, I8 and L1 read it: the restart that brings the bot back after a part-way restore, for a line naming "a
 * restart of the bot's container". While this boot's disk error record stands it is the machine's restart; with the
 * boot id unknown, the record files are deleted first.
 */
function restartNoun(): { first: string; noun: string; tail: string } {
  const found = diskRecord();
  if (!found || found.files.length === 0) return { first: '', noun: "a restart of the bot's container", tail: '' };
  if (bootId() === null) {
    const files = found.files.map(containerPath);
    return {
      first: `${files.join(' and ')} ${files.length === 1 ? 'is' : 'are'} deleted and `,
      noun: "a restart of the bot's container",
      tail: " (the web panel cannot read the machine's boot id)",
    };
  }
  return { first: '', noun: "a restart of the machine the bot runs on (a restart of the bot's container is not enough after a disk error)", tail: '' };
}

/** Decision 70's log line for a crash or restart start refused during a POST's op. */
export function stoppedDuringRestoreLine(name: string): string {
  const { first, noun, tail } = restartNoun();
  return `[Backup] Restore of ${name}: the bot stopped during the restore and was not started again; the restore starts it when it finishes; if the restore stops part way, the bot starts once ${first}${noun} has finished the restore${tail}`;
}
