// FileBackend - disk storage carved out of the dataManager facade.
//
// Writes go through an async atomic queue: the facade stringifies
// synchronously, enqueues, and returns immediately; a per-path flusher writes
// to a temp file, fsyncs, and renames over the target so a crash never leaves
// a torn JSON file. Reads consult the queue first so a caller reading right
// after a write still sees its own bytes. The facade (dataManager.ts) owns
// metrics hooks and the write records; this module owns the queue, the
// filesystem, enumeration, sizing, and the graveyard.

import * as fs from 'fs';
import * as path from 'path';
import { DATA_ROOT } from '../../../../utils/dataRoot';
import { DataBackendUnavailableError } from './workingSet';
import type { RestoreStop } from './backend';
import { fold, keyRefusal, KeyTree } from '../storableData';
import { flagAnswer, forgetDurableFolders, folderSyncFailed, logSyncLine, noteFolderSyncFailure, syncFolder, syncFolderChain, syncFolderSync, syncWords, type ChainAnswer, type SyncKind } from '../folderChain';

const BASE_DATA_DIR = DATA_ROOT;

/**
 * Ensure directory exists, create if needed
 */
export function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`[DataManager] Created directory: ${dirPath}`);
  }
}

// ============================================================================
// ASYNC ATOMIC WRITE QUEUE
// ============================================================================

export type PendingOp =
  | { op: 'write'; content: string; seq: number }
  | { op: 'delete'; seq: number }
  | { op: 'append'; content: string; seq: number };

// Keyed by absolute target path. One in-flight flush per path (serialized), so
// a queued delete can never be overtaken by an earlier write and vice versa.
const pendingOps = new (class extends Map<string, PendingOp> {
  // Per guild folder, its queued paths by key (path form), so a guild write reads only its own guild's queue.
  readonly byGuild = new Map<string, Map<string, string>>();

  private guildKey(absPath: string): [string, string] | undefined {
    const rel = path.relative(BASE_DATA_DIR, path.resolve(absPath));
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const parts = rel.split(path.sep);
    if (parts.length < 2) return undefined;
    return [parts[0], parts.slice(1).join('/')];
  }

  set(absPath: string, op: PendingOp): this {
    super.set(absPath, op);
    const at = this.guildKey(absPath);
    if (at) {
      let keys = this.byGuild.get(at[0]);
      if (!keys) {
        keys = new Map();
        this.byGuild.set(at[0], keys);
      }
      keys.set(at[1], absPath);
    }
    return this;
  }

  delete(absPath: string): boolean {
    const at = this.guildKey(absPath);
    if (at) {
      const keys = this.byGuild.get(at[0]);
      if (keys?.delete(at[1]) && keys.size === 0) this.byGuild.delete(at[0]);
    }
    return super.delete(absPath);
  }

  clear(): void {
    this.byGuild.clear();
    super.clear();
  }
})();
const flushing = new Set<string>();
const scheduled = new Set<string>();
/** Paths a deposition's cancel holds: no flush of them starts. */
const frozen = new Set<string>();
let opSeq = 0;
// Per path a ticket was issued for, while an op is queued for it: the seq of
// the last op that landed, so an op at or below it landed itself or was
// followed by one that did. Its tickets hold the record, so it leaves the map
// once nothing is queued for the path, and a later record starts afresh.
export interface LandingRecord {
  landed: number;
  /** Seq ranges whose lines are in the file but whose sync the disk did not confirm, or that a cut try left (NB13). */
  failed?: FailedRange[];
  /** The snapshot seq of the try whose write call is on the wire, 0 outside it. */
  writing?: number;
  /** The highest snapshot seq of a try whose write accepted at least one byte. */
  wrote?: number;
  /** Whole writes in the file whose directory sync failed after a newer op replaced them: that op's landing answers for them, a cancel or the exit fails them. */
  replaced?: ReplacedTry[];
  /** The seq of the last whole write or delete that landed: the file it left holds no byte of a try before it. */
  wholeLanded?: number;
}

/** What a failed op left in the file, and the folder sync answer that failed it, when its chain failed. */
interface FailureSource {
  what: 'lines' | 'whole';
  kind?: SyncKind;
  dir?: string;
}

interface ReplacedTry extends FailureSource {
  from: number;
  through: number;
  errno: string;
  lines: number;
}

export interface FailedRange extends FailureSource {
  from: number;
  through: number;
  errno: string | null;
  /** A cancel added it for a try cut short: its lines may be in the file whole, in part or not at all. */
  cut: boolean;
}

const newRecord = (): LandingRecord => ({ landed: 0, failed: [], writing: 0, wrote: 0 });
const landingRecords = new Map<string, LandingRecord>();
/** Per path, the sets of records that started during a waiting cancel (NB13): its answer reads them too. */
const cancelWatches = new Map<string, Set<Set<LandingRecord>>>();
/** Per path, the record of the try on the wire. */
const tryRecords = new Map<string, LandingRecord>();

function startRecord(absPath: string): LandingRecord {
  const record = newRecord();
  landingRecords.set(absPath, record);
  for (const seen of cancelWatches.get(absPath) ?? []) seen.add(record);
  return record;
}
/** Landing records whose queued op a deposition cancelled: their tickets are known not saved. */
const droppedAtDeposition = new WeakSet<LandingRecord>();

export function droppedByDeposition(record: LandingRecord): boolean {
  return droppedAtDeposition.has(record);
}

// The landed op's tickets hold the record its path had when the flush began,
// which a drop may have retired since, or else one a ticket made meanwhile.
function noteLanded(absPath: string, atStart: LandingRecord | undefined, seq: number, whole = false): void {
  const record = atStart ?? landingRecords.get(absPath);
  if (record && seq > record.landed) record.landed = seq;
  if (record && whole) record.wholeLanded = Math.max(record.wholeLanded ?? 0, seq);
  if (record) dropReplacedTries(record, seq);
}

/** Records holding replaced tries, with their paths. */
const replacedTries = new Map<LandingRecord, string>();

/** Forgets the replaced tries an op at seq answers for. */
function dropReplacedTries(record: LandingRecord, seq: number): void {
  if (!record.replaced?.length) return;
  record.replaced = record.replaced.filter(t => t.through > seq);
  if (record.replaced.length === 0) replacedTries.delete(record);
}

/** Landing records held for ticketed paths with an op still queued. */
export function fileLandingRecords(): number {
  return landingRecords.size;
}
// A failed flush is tried again on its own, backing off to a minute, so a
// write held through a disk fault lands once the disk takes it.
const retryAttempts = new Map<string, number>();
const retryTimers = new Map<string, NodeJS.Timeout>();
/** Paths holding lines or whole files whose sync the disk did not confirm, until a delete or whole write of the path lands. */
const unconfirmedPaths = new Set<string>();

/**
 * Files holding lines or whole files the disk did not confirm (NB13 decision 8, NB19), and appends queued empty: a short write
 * left a line in the file without its newline, which the next try's guard closes, so it is not unsaved.
 */
export function unconfirmedFiles(): number {
  const paths = new Set(unconfirmedPaths);
  for (const [p, op] of pendingOps) if (op.op === 'append' && op.content === '') paths.add(p);
  return paths.size;
}

/** Files with a write, delete or append still queued, less appends queued empty (counted by unconfirmedFiles). */
export function unsavedFileWrites(): number {
  return unsavedFilePaths().length;
}

/** The paths unsavedFileWrites counts. */
export function unsavedFilePaths(): string[] {
  return [...pendingOps].filter(([, op]) => !(op.op === 'append' && op.content === '')).map(([p]) => p);
}
/** The errno of each path's last failed flush, until one lands. */
const lastFlushErrno = new Map<string, string>();
/** Per path, the identity of a file whose name this process made durable in this hold of the writer lock. */
const durableFiles = new Map<string, { dev: bigint; ino: bigint; birth: bigint }>();

/** Forgets every durable name and folder: another holder of the writer lock may have replaced any file since. */
export function forgetDurableFiles(): void {
  durableFiles.clear();
  forgetDurableFolders();
}

/** Forgets the durable names and folders under /data/{guildId}: its folder moved and the move may not be on disk. */
export function forgetGuildDurableFiles(guildId: string): void {
  const under = underGuild(guildId);
  for (const p of [...durableFiles.keys()]) if (under(p)) durableFiles.delete(p);
  forgetDurableFolders(path.join(BASE_DATA_DIR, guildId));
}

const failedRangeOf = (ticket: FileTicket): FailedRange | undefined =>
  (ticket.record.failed ?? []).find(range => ticket.seq >= range.from && ticket.seq <= range.through);

/**
 * The one reader of a file ticket (NB13 decision 8, C8): 'unconfirmed' when a failed range of its record holds it,
 * 'landed' when the record's landed reaches it, 'written' while a try that carried it has bytes in the file or a
 * write on the wire, else 'open'.
 */
export function fileTicketState(ticket: FileTicket): 'landed' | 'unconfirmed' | 'written' | 'open' {
  if (failedRangeOf(ticket)) return 'unconfirmed';
  if (ticket.record.landed >= ticket.seq) return 'landed';
  if (ticket.seq <= Math.max(ticket.record.writing ?? 0, ticket.record.wrote ?? 0)) return 'written';
  return 'open';
}

export interface FileTicketFailure extends FailureSource {
  errno: string | null;
  cut: boolean;
}

/** Why a ticket is 'unconfirmed': the errno, whether a cut try left it, and the failed folder sync; null when no failed range holds it. */
export function fileTicketFailure(ticket: FileTicket): FileTicketFailure | null {
  const range = failedRangeOf(ticket);
  return range ? { errno: range.errno, cut: range.cut, ...sourceOf(range) } : null;
}

const sourceOf = (from: FailureSource): FailureSource => ({ what: from.what, ...(from.kind ? { kind: from.kind, dir: from.dir } : {}) });

/** Adds the parts of from..through no failed range of the record covers yet; answers whether it added any. */
function addFailedRange(record: LandingRecord, from: number, through: number, errno: string | null, cut: boolean, source: FailureSource): boolean {
  const ranges = (record.failed ??= []);
  let added = false;
  let start = from;
  for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
    if (range.through < start) continue;
    if (range.from > through) break;
    if (range.from > start) { ranges.push({ from: start, through: range.from - 1, errno, cut, ...sourceOf(source) }); added = true; }
    start = Math.max(start, range.through + 1);
  }
  if (start <= through) { ranges.push({ from: start, through, errno, cut, ...sourceOf(source) }); added = true; }
  return added;
}

const errnoOf = (error: unknown): string => String((error as { code?: unknown } | null)?.code ?? 'EIO');
const closeCodeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === undefined || code === null ? 'no error code' : String(code);
};
const SKIPPED_DIR_OPEN = new Set(['EISDIR', 'EPERM', 'EACCES']);
const SKIPPED_DIR_SYNC = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);

const chainSource = (chain: Extract<ChainAnswer, { failed: true }>, what: 'lines' | 'whole'): FailureSource => ({ what, kind: chain.kind, dir: chain.dir });

/** Lines of text, counted by their newlines (a last line with none counts too). */
const lineCount = (text: string): number => text.split('\n').filter((line, i, all) => line !== '' || i < all.length - 1).length;

/** The error line of a failed op, built from its range: T2 for a whole write, T17 for lines whose chain failed. */
function logUnconfirmed(absPath: string, failure: FailureSource & { lines: number; errno: string }): void {
  if (failure.kind) {
    const { why, next } = syncWords(failure.kind, failure.dir!, failure.errno);
    logSyncLine(absPath, failure.kind, failure.what === 'whole'
      ? `[Data] ${absPath}: the file is written whole, but ${why}; it is not written again; can't confirm it is stored. ${next}`
      : `[Data] ${absPath}: ${failure.lines} appended line(s) are in the file and synced, but ${why}; they are not written again; can't confirm they are stored. ${next}`);
    return;
  }
  console.error(`[Data] ${absPath}: the disk did not confirm the sync of ${failure.lines} appended line(s) (${failure.errno}); they are in the file and are not written again; can't confirm they are stored`);
}

/** Turns the record's replaced tries into failed ranges; answers the last one's errno, or null when it held none. */
function failReplacedTries(record: LandingRecord, absPath: string): string | null {
  const tries = record.replaced ?? [];
  record.replaced = [];
  replacedTries.delete(record);
  if (tries.length === 0) return null;
  for (const t of tries) {
    addFailedRange(record, t.from, t.through, t.errno, false, t);
    logUnconfirmed(absPath, t);
  }
  unconfirmedPaths.add(absPath);
  return tries[tries.length - 1].errno;
}

/** The exit: a replaced whole write whose newer op never landed is in the file, unconfirmed. */
export function failReplacedTriesAtExit(): void {
  for (const [record, absPath] of [...replacedTries]) failReplacedTries(record, absPath);
}

// Writes held only in memory are bounded: past either bound new writes are
// refused until the disk takes writes again and the held bytes fall below half.
const STORAGE_FAILING_AGE_MS = 30_000;
const STORAGE_HELD_BYTES = 32 * 1024 * 1024;
const failingSince = new Map<string, number>();
// The last error code of each path in failingSince.
const failingCode = new Map<string, string>();
let storageRefusing = false;
let lastLandedAt = -Infinity;

let flushFailures = 0;
let flushesLanded = 0;

// Monotonic tmp-name suffix so two saves to the same path in the same ms never
// collide on the temp file. Pattern mirrors utils/atomicWrite.ts.
let tmpCounter = 0;
function tmpNameFor(target: string): string {
  return `${target}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`;
}

function scheduleFlush(absPath: string): void {
  if (scheduled.has(absPath)) return;
  scheduled.add(absPath);
  setImmediate(() => {
    scheduled.delete(absPath);
    void flushPath(absPath);
  });
}

function scheduleRetry(absPath: string): void {
  if (retryTimers.has(absPath)) return;
  const attempt = (retryAttempts.get(absPath) ?? 0) + 1;
  retryAttempts.set(absPath, attempt);
  const timer = setTimeout(() => {
    retryTimers.delete(absPath);
    void flushPath(absPath);
  }, Math.min(1000 * 2 ** (attempt - 1), 60_000));
  timer.unref();
  retryTimers.set(absPath, timer);
}

function clearRetry(absPath: string): void {
  const timer = retryTimers.get(absPath);
  if (timer) clearTimeout(timer);
  retryTimers.delete(absPath);
  retryAttempts.delete(absPath);
  failingSince.delete(absPath);
  failingCode.delete(absPath);
}

const IS_WINDOWS = process.platform === 'win32';

// The temp files this process has open, from the open to the rename or the unlink.
const openTemps = new Set<string>();

/** Temp file, fsync, rename: text is written as UTF-8, a Buffer as its bytes. */
export async function atomicReplace(target: string, content: string | Buffer, options: { parentSync?: boolean } = {}): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = tmpNameFor(target);
  const fh = await fs.promises.open(tmp, 'w');
  openTemps.add(tmp);
  try {
    try {
      await fh.writeFile(content, 'utf-8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    // Windows can throw EPERM on rename-over-existing while a reader (e.g. the
    // webui parent) holds the target open; retry with a short backoff. NEVER
    // fall back to a direct overwrite - that reintroduces the torn-file window
    // the temp+fsync+rename exists to eliminate. On exhaustion the caller keeps
    // the pending entry to retry later.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(tmp, target);
        break;
      } catch (error) {
        if (attempt >= 9) throw error;
        await delay(25 * (attempt + 1));
      }
    }
  } catch (error) {
    await fs.promises.unlink(tmp).catch(() => undefined);
    throw error;
  } finally {
    openTemps.delete(tmp);
  }
  if (options.parentSync !== false) await syncFolder(path.dirname(target));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** True once this call's op landed. */
async function flushPath(absPath: string): Promise<boolean> {
  if (flushing.has(absPath) || frozen.has(absPath)) return false;
  const entry = pendingOps.get(absPath);
  if (!entry) {
    failingSince.delete(absPath);
    failingCode.delete(absPath);
    return false;
  }
  flushing.add(absPath);
  let record = landingRecords.get(absPath);
  // Every write and every try of a stream has a record, so a ticket or a cancel can read what it left in the file.
  if (!record && (entry.op !== 'delete' || absPath.endsWith('.jsonl'))) record = startRecord(absPath);
  if (record) tryRecords.set(absPath, record);
  try {
    const seqAtStart = entry.seq;
    if (entry.op === 'append') return await flushAppend(absPath, entry, record!);
    let chain: ChainAnswer = { failed: false };
    try {
      if (entry.op === 'write') {
        await atomicReplace(absPath, entry.content, { parentSync: false });
        durableFiles.delete(absPath);
        chain = await syncFolderChain(path.dirname(absPath));
      } else {
        try {
          await fs.promises.unlink(absPath);
        } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error;
        }
        await removeEmptiedFolders(absPath);
      }
    } catch (error) {
      lastFlushErrno.set(absPath, errnoOf(error));
      flushFailures += 1;
      if (!failingSince.has(absPath)) failingSince.set(absPath, performance.now());
      failingCode.set(absPath, String((error as { code?: unknown } | null)?.code ?? 'EIO'));
      console.error(`[DataManager] Flush failed for ${absPath} (will retry):`, error);
      scheduleRetry(absPath);
      return false; // keep the pending entry + tmp file; the retry, the next write or flushAll tries again
    }
    retryAttempts.delete(absPath);
    failingSince.delete(absPath);
    failingCode.delete(absPath);
    // A newer op replaced the entry during the try: it holds every line of this write, or deletes them, and answers for them.
    const current = pendingOps.get(absPath);
    const replaced = current !== undefined && current.seq !== seqAtStart;
    if (chain.failed) {
      // The whole write is in the file, but its folder chain failed: never written again, can't confirm.
      const errno = chain.errno;
      lastFlushErrno.set(absPath, errno);
      const lines = entry.op === 'write' ? lineCount(entry.content) : 0;
      const source = chainSource(chain, 'whole');
      if (!replaced) {
        if (record) {
          addFailedRange(record, record.landed + 1, seqAtStart, errno, false, source);
          dropReplacedTries(record, seqAtStart);
        }
        unconfirmedPaths.add(absPath);
        logUnconfirmed(absPath, { ...source, lines, errno });
      } else if (record) {
        (record.replaced ??= []).push({ from: record.landed + 1, through: seqAtStart, errno, lines, ...source });
        replacedTries.set(record, absPath);
      }
    } else {
      flushesLanded += 1;
      lastLandedAt = performance.now();
      lastFlushErrno.delete(absPath);
      noteLanded(absPath, record, seqAtStart, true);
      unconfirmedPaths.delete(absPath);
    }
    // Drop the entry only if no newer op arrived while we were flushing.
    if (current && current.seq === seqAtStart) {
      pendingOps.delete(absPath);
      landingRecords.delete(absPath);
    } else if (current) {
      scheduleFlush(absPath);
    }
    return !chain.failed;
  } finally {
    flushing.delete(absPath);
    tryRecords.delete(absPath);
  }
}

/**
 * NB13 decision 8: the standard append. O_APPEND puts each write at the file's end; a newline goes first when the
 * file's last byte is not one, so a cut or old tail stays a line of its own; bytes the kernel accepted are never
 * written again; the lines land only once the file's fsync, and the directory chain unless its skip holds, succeeded.
 * A failed fsync leaves its lines in the file, never written again, and 'unconfirmed' for good.
 */
async function flushAppend(absPath: string, entry: PendingOp & { op: 'append' }, record: LandingRecord): Promise<boolean> {
  const flushed = entry.content; // snapshot before the await
  const flushedSeq = entry.seq;
  const landedAtStart = record.landed;
  let fh: fs.promises.FileHandle | null = null;
  // A rejection may carry no error at all: whether a step failed is kept apart from what it threw.
  let failed = false;
  let failure: unknown = null;
  let syncFailed = false;
  let syncFailure: unknown = null;
  let chainFailure: Extract<ChainAnswer, { failed: true }> | null = null;
  let accepted = -1;
  let guardBytes = 0;
  try {
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    fh = await fs.promises.open(absPath, 'a+');
    const stat = await fh.stat({ bigint: true });
    const identity = { dev: stat.dev, ino: stat.ino, birth: stat.birthtimeNs };
    const known = durableFiles.get(absPath);
    const skipChain = !!known && known.dev === identity.dev && known.ino === identity.ino && known.birth === identity.birth
      && identity.birth > 0n && stat.size > 0n;
    if (!skipChain) durableFiles.delete(absPath);
    if (stat.size > 0n) {
      const last = Buffer.alloc(1);
      await fh.read(last, 0, 1, Number(stat.size - 1n));
      if (last[0] !== 0x0a) guardBytes = 1;
    }
    const bytes = Buffer.from((guardBytes ? '\n' : '') + flushed, 'utf8');
    record.writing = flushedSeq;
    try {
      accepted = (await fh.write(bytes, 0, bytes.length)).bytesWritten;
    } catch (error) {
      accepted = 0;
      failed = true;
      failure = error;
    } finally {
      record.writing = 0;
    }
    if (accepted > 0) record.wrote = Math.max(record.wrote ?? 0, flushedSeq);
    if (!failed && accepted < bytes.length) {
      failed = true;
      failure = Object.assign(new Error(`short write: ${accepted} of ${bytes.length} bytes`), { code: 'short write' });
    }
    if (!failed) {
      try {
        await fh.sync();
        if (!skipChain || folderSyncFailed()) {
          const chain = await syncFolderChain(path.dirname(absPath));
          if (chain.failed) {
            syncFailed = true;
            syncFailure = chain.error;
            chainFailure = chain;
          } else durableFiles.set(absPath, identity);
        }
      } catch (error) {
        syncFailed = true;
        syncFailure = error;
      }
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (fh) {
      try { await fh.close(); } catch (error) { console.error(`[Data] ${absPath}: the file could not be closed after an append (${closeCodeOf(error)}); this changes nothing about the lines already reported for it`); }
    }
  }

  if (failed) {
    // Each line the kernel accepted up to its newline is in the file whole: it leaves the entry, which stays queued
    // even when empty, so the next try's guard closes a line accepted without its newline.
    if (accepted > guardBytes && pendingOps.get(absPath) === entry) {
      entry.content = entry.content.slice(acceptedLineChars(flushed, accepted - guardBytes));
    }
    if (accepted > 0) durableFiles.delete(absPath);
    lastFlushErrno.set(absPath, errnoOf(failure));
    flushFailures += 1;
    if (!failingSince.has(absPath)) failingSince.set(absPath, performance.now());
    failingCode.set(absPath, errnoOf(failure));
    console.error(`[DataManager] Flush failed for ${absPath} (will retry):`, failure);
    scheduleRetry(absPath);
    return false;
  }

  retryAttempts.delete(absPath);
  failingSince.delete(absPath);
  failingCode.delete(absPath);
  if (!syncFailed) {
    const flagged = flagAnswer();
    if (flagged.failed) {
      syncFailed = true;
      syncFailure = flagged.error;
      chainFailure = flagged;
    }
  }
  if (syncFailed) {
    const errno = chainFailure ? chainFailure.errno : errnoOf(syncFailure);
    const source: FailureSource = chainFailure ? chainSource(chainFailure, 'lines') : { what: 'lines' };
    durableFiles.delete(absPath);
    lastFlushErrno.set(absPath, errno);
    addFailedRange(record, landedAtStart + 1, flushedSeq, errno, false, source);
    dropReplacedTries(record, flushedSeq);
    unconfirmedPaths.add(absPath);
    logUnconfirmed(absPath, { ...source, lines: lineCount(flushed), errno });
  } else {
    lastFlushErrno.delete(absPath);
    noteLanded(absPath, record, flushedSeq);
    flushesLanded += 1;
    lastLandedAt = performance.now();
  }
  // A concurrent append may have grown the entry mid-flush; keep the tail.
  // An op that replaced the entry meanwhile is flushed next, untrimmed.
  const cur = pendingOps.get(absPath);
  if (cur === entry) {
    entry.content = entry.content.slice(flushed.length);
    if (entry.content.length === 0) {
      pendingOps.delete(absPath);
      landingRecords.delete(absPath);
    } else {
      scheduleFlush(absPath); // flush only the remaining tail
    }
  } else if (cur) {
    scheduleFlush(absPath);
  }
  return !syncFailed;
}

/** The characters of text whose lines lie whole in its first acceptedBytes UTF-8 bytes, each up to its newline. */
function acceptedLineChars(text: string, acceptedBytes: number): number {
  let chars = 0;
  let bytes = 0;
  for (;;) {
    const newline = text.indexOf('\n', chars);
    if (newline < 0) return chars;
    const lineBytes = Buffer.byteLength(text.slice(chars, newline));
    if (bytes + lineBytes > acceptedBytes) return chars;
    bytes += lineBytes + 1;
    chars = newline + 1;
  }
}

async function flushPaths(paths: string[]): Promise<void> {
  // Drain each path to empty (a re-flush may enqueue the same path again if a
  // newer op landed mid-flush). A persistently-failing flush (ENOSPC, a
  // read-only dir, EPERM exhaustion) leaves the pending entry in place with the
  // same seq and no re-schedule: detect that no-progress case and give up in
  // line after a bounded backoff rather than spinning forever. The entry stays
  // queued, so the next write / flushAll retries it (surfaced via flushFailures).
  await Promise.all(paths.map(async absPath => {
    let stuckAttempts = 0;
    while (pendingOps.has(absPath)) {
      const before = pendingOps.get(absPath)?.seq;
      await flushPath(absPath);
      const after = pendingOps.get(absPath);
      if (!after) break; // drained
      if (flushing.has(absPath)) {
        await delay(5); // another flush is in flight for this path
        continue;
      }
      if (after.seq === before) {
        // Flush failed and no newer op arrived: stop the in-line loop.
        if (++stuckAttempts >= 3) break;
        await delay(25 * stuckAttempts);
      } else {
        stuckAttempts = 0; // a newer op drained/re-queued: real progress
      }
    }
  }));
}

/**
 * Flush every queued write/delete/append to disk. Awaited on shutdown.
 */
export async function flushAll(): Promise<void> {
  await flushPaths([...pendingOps.keys()]);
}

/** row: a path of the row queue (NB6 decision 16), whose errno is the cause of its last try in words. */
export type CancelOutcome =
  | { path: string; outcome: 'landed'; row?: true }
  | { path: string; outcome: 'cancelled'; errno: string | null; row?: true }
  | { path: string; outcome: 'unconfirmed'; errno: string | null; cut: boolean; row?: true; what?: 'lines' | 'whole'; kind?: SyncKind; dir?: string };

/** The row queue's part of cancelQueued (sharedStore.ts sets it): the paths it holds and their cancel. */
export interface RowCancel {
  holds(path: string): boolean;
  cancel(paths: string[]): Promise<CancelOutcome[]>;
}

let rowCancel: RowCancel | null = null;

export function setRowCancel(given: RowCancel | null): void {
  rowCancel = given;
}

/**
 * cancelQueued's one answer for a path, read from the records its cancel reads, the one it started with first:
 * 'unconfirmed' when a failed range holds a seq up to seq in the first, or any seq in another, and no whole write or
 * delete landed after the range's end (the range nearest seq gives the errno and cut); 'landed' when the first
 * record's landing reaches seq and no entry was dropped, or when nothing was queued at the cancel; else 'cancelled'
 * with errno.
 */
function cancelAnswer(p: string, records: LandingRecord[], seq: number, dropped: boolean, errno: string | null, wholeLanded = 0): CancelOutcome {
  const [first, ...others] = records;
  if (!first) return { path: p, outcome: 'landed' };
  const inFile = (record: LandingRecord) => (record.failed ?? []).filter(range => range.through > wholeLanded);
  const held = [...inFile(first).filter(range => range.from <= seq), ...others.flatMap(inFile)];
  if (held.length > 0) {
    const range = held.reduce((a, b) => (b.through > a.through ? b : a));
    return { path: p, outcome: 'unconfirmed', errno: range.errno, cut: range.cut, ...sourceOf(range) };
  }
  if (!dropped && first.landed >= seq) return { path: p, outcome: 'landed' };
  return { path: p, outcome: 'cancelled', errno };
}

/**
 * Drops these paths' queued ops: waits until no flush of them is on the wire, then answers per path 'landed' when its
 * last op landed meanwhile, 'unconfirmed' when lines of it are in the file but the disk did not confirm them (cut
 * when a try ended inside a line), or 'cancelled' once it deleted the pending entry and cleared its retry, with the
 * errno of the path's last failed flush. With freeze (a deposition), no new flush of these paths starts from the call on: a
 * path not on the wire is cancelled at once, and one on the wire is awaited and then cancelled or answered landed.
 */
export async function cancelQueued(paths: string[], sleep: (ms: number) => Promise<void> = delay, options: { freeze?: boolean } = {}): Promise<CancelOutcome[]> {
  // NB6 decision 16: a path of the row queue lands or is cancelled there.
  const rowPaths = rowCancel ? paths.filter(p => !pendingOps.has(p) && rowCancel!.holds(p)) : [];
  if (rowPaths.length > 0) {
    const filePaths = paths.filter(p => !rowPaths.includes(p));
    const [rows, files] = await Promise.all([rowCancel!.cancel(rowPaths), filePaths.length > 0 ? cancelQueued(filePaths, sleep, options) : []]);
    return paths.map(p => (rowPaths.includes(p) ? rows[rowPaths.indexOf(p)] : files[filePaths.indexOf(p)]));
  }
  const targets = new Map(paths.map(p => [p, pendingOps.get(p)?.seq]));
  // Each target's landing record from the start: an entry gone at the cancel landed only if the record reached its seq.
  const records = new Map<string, LandingRecord>();
  // A try on the wire at the start under a record a guild drop retired, and the records that start during the wait.
  const earlier = new Map<string, LandingRecord>();
  const later = new Map<string, Set<LandingRecord>>();
  for (const p of paths) {
    if (!pendingOps.has(p) || records.has(p)) continue;
    const record = landingRecords.get(p) ?? startRecord(p);
    records.set(p, record);
    const onWire = tryRecords.get(p);
    if (onWire && onWire !== record) earlier.set(p, onWire);
    const seen = new Set<LandingRecord>();
    later.set(p, seen);
    const watches = cancelWatches.get(p) ?? new Set<Set<LandingRecord>>();
    watches.add(seen);
    cancelWatches.set(p, watches);
  }
  const cancel = (p: string): CancelOutcome => {
    const seq = targets.get(p);
    const started = records.get(p);
    if (seq === undefined || !started) return cancelAnswer(p, [], 0, false, null);
    const entry = pendingOps.get(p);
    const flushErrno = lastFlushErrno.get(p) ?? null;
    const before = earlier.has(p) ? [earlier.get(p)!] : [];
    const after = [...later.get(p)!];
    // A record that started during the wait holds only seqs above the target's: it counts once an entry is dropped.
    const read = [started, ...before, ...(entry ? after : [])];
    for (const record of read) {
      // NB13 C9: a replaced whole write is in the file, and a try that wrote bytes and never landed left them there.
      failReplacedTries(record, p);
      if ((record.wrote ?? 0) > record.landed) addFailedRange(record, record.landed + 1, record.wrote ?? 0, flushErrno, true, { what: 'lines' });
    }
    const wholeLanded = Math.max(0, ...[started, ...before, ...after].map(record => record.wholeLanded ?? 0));
    const answer = cancelAnswer(p, read, entry ? Math.max(seq, entry.seq) : seq, !!entry, entry ? flushErrno : null, wholeLanded);
    const current = landingRecords.get(p);
    if (answer.outcome === 'unconfirmed') unconfirmedPaths.add(p);
    if (options.freeze && answer.outcome === 'unconfirmed') droppedAtDeposition.add(started);
    if (options.freeze && entry && current) droppedAtDeposition.add(current);
    if (entry) pendingOps.delete(p);
    if (entry || current === started) landingRecords.delete(p);
    clearRetry(p);
    lastFlushErrno.delete(p);
    return answer;
  };
  const early = new Map<string, CancelOutcome>();
  const held = options.freeze ? paths.filter(p => !frozen.has(p)) : [];
  try {
    if (options.freeze) {
      for (const p of held) frozen.add(p);
      for (const p of paths) if (!flushing.has(p)) early.set(p, cancel(p));
    }
    while (paths.some(p => flushing.has(p))) await sleep(5);
    return paths.map(p => early.get(p) ?? cancel(p));
  } finally {
    for (const p of held) frozen.delete(p);
    for (const [p, seen] of later) {
      const watches = cancelWatches.get(p);
      watches?.delete(seen);
      if (watches?.size === 0) cancelWatches.delete(p);
    }
  }
}

/** Files with a write, delete or append still queued; an entry stays until its flush lands. */
export function queuedFileWrites(): number {
  return pendingOps.size;
}

/** The paths of queuedFileWrites. */
export function queuedFilePaths(): string[] {
  return [...pendingOps.keys()];
}

export function fileFlushOnTheWire(): boolean {
  return flushing.size > 0;
}

/** File flushes landed so far (the exit drain's progress test). */
export function fileFlushesLanded(): number {
  return flushesLanded;
}

/**
 * Flush every queued op under /data/{guildId}/.
 */
export async function flushGuild(guildId: string): Promise<void> {
  const prefix = path.join(BASE_DATA_DIR, guildId) + path.sep;
  const guildDir = path.join(BASE_DATA_DIR, guildId);
  const paths = [...pendingOps.keys()].filter(p => p === guildDir || p.startsWith(prefix));
  await flushPaths(paths);
}

const underGuild = (guildId: string) => {
  const dir = path.join(BASE_DATA_DIR, guildId);
  return (p: string) => p === dir || p.startsWith(dir + path.sep);
};

/** An op under /data/{guildId} is queued or on the wire (a flush on the wire may be in flushing only). */
export function guildHasQueuedOps(guildId: string): boolean {
  const under = underGuild(guildId);
  return [...pendingOps.keys()].some(under) || [...flushing].some(under);
}

/** The first file of the guild whose flush keeps failing, relative to /data/{guildId}, with its last error code. */
export function guildFailingWrite(guildId: string): { file: string; code: string } | null {
  const under = underGuild(guildId);
  for (const [p, code] of failingCode) {
    if (!under(p) || !pendingOps.has(p)) continue;
    return { file: path.relative(path.join(BASE_DATA_DIR, guildId), p).split(path.sep).join('/'), code };
  }
  return null;
}

export type DataDirsSync = { failed: false } | { failed: true; dir: string; code: string; kind: 'sync' | 'open' };

/**
 * fsyncs /data and /data/_graveyard on POSIX, so a rename between them survives a power cut. Only an unsupported
 * operation is passed over, as in syncDirectoryChain; any other error, a missing folder included, is a failure. Both
 * folders are tried; the first failure is answered.
 */
export async function fsyncDataDirs(): Promise<DataDirsSync> {
  if (IS_WINDOWS) return { failed: false };
  let first: DataDirsSync = { failed: false };
  for (const dir of [BASE_DATA_DIR, path.join(BASE_DATA_DIR, GRAVEYARD_DIR)]) {
    let code: string | null = null;
    let kind: 'sync' | 'open' = 'open';
    let dh: fs.promises.FileHandle | null = null;
    try {
      dh = await fs.promises.open(dir, 'r');
    } catch (error) {
      if (!SKIPPED_DIR_OPEN.has(errnoOf(error))) code = errnoOf(error);
      if (code === 'EIO') {
        kind = 'sync';
        noteFolderSyncFailure(dir, code);
      }
    }
    if (dh) {
      try {
        await dh.sync();
      } catch (error) {
        if (!SKIPPED_DIR_SYNC.has(errnoOf(error))) {
          code = errnoOf(error);
          kind = 'sync';
          noteFolderSyncFailure(dir, code);
        }
      } finally {
        try { await dh.close(); } catch (error) { console.error(`[Data] ${dir}: the directory could not be closed after its sync (${closeCodeOf(error)}); this does not change whether the sync succeeded`); }
      }
    }
    if (code !== null && !first.failed) first = { failed: true, dir, code, kind };
  }
  return first;
}

/** Whether any of these files still has a write queued. */
export function filesPending(paths: string[]): boolean {
  return paths.some(p => pendingOps.has(p));
}

/** Some path's last flush failed and it waits for a retry. */
export function flushFailing(paths: string[]): boolean {
  return paths.some(p => retryAttempts.has(p));
}

/** Count of paths whose flush is currently failing (surfaced in diagnostics). */
export function getFlushFailures(): number {
  return flushFailures;
}

// ============================================================================
// QUEUE PRIMITIVES (facade CRUD builds on these)
// ============================================================================

/** The queued op for a path, if any (read-your-writes). */
export function getPending(absPath: string): PendingOp | undefined {
  return pendingOps.get(absPath);
}

function heldBytes(): number {
  let total = 0;
  for (const op of pendingOps.values()) if (op.op !== 'delete') total += op.content.length;
  return total;
}

// One failing path refuses writes only to its own directory; the whole queue
// stalls when paths in two or more folders fail and nothing landed since the first.
function diskStalled(now: number): boolean {
  let oldest = Infinity;
  for (const since of failingSince.values()) if (since >= lastLandedAt) oldest = Math.min(oldest, since);
  return new Set([...failingSince.keys()].map(p => path.dirname(p))).size >= 2 && oldest !== Infinity && now - oldest >= STORAGE_FAILING_AGE_MS;
}

function sameDirFailing(absPath: string, now: number): boolean {
  const dir = path.dirname(absPath);
  for (const [p, since] of failingSince) {
    if (path.dirname(p) === dir && now - since >= STORAGE_FAILING_AGE_MS) return true;
  }
  return false;
}

function refuseWhileStorageFails(absPath: string): void {
  const bytes = heldBytes();
  const now = performance.now();
  if (storageRefusing) {
    if (!diskStalled(now) && bytes <= STORAGE_HELD_BYTES / 2) {
      storageRefusing = false;
      console.log('[DataManager] Disk writes are landing again; file writes are accepted');
    }
  } else if (diskStalled(now) || bytes >= STORAGE_HELD_BYTES) {
    storageRefusing = true;
    console.error(`[DataManager] Refusing file writes: ${failingSince.size} file(s) failing to flush, ${bytes} bytes held in memory`);
  }
  if (storageRefusing || sameDirFailing(absPath, now)) throw new DataBackendUnavailableError('storage-failing');
}

export function enqueueWrite(absPath: string, content: string): void {
  refuseWhileStorageFails(absPath);
  pendingOps.set(absPath, { op: 'write', content, seq: ++opSeq });
  scheduleFlush(absPath);
}

export function enqueueAppend(absPath: string, line: string): void {
  refuseWhileStorageFails(absPath);
  const existing = pendingOps.get(absPath);
  // Coalesce consecutive appends waiting on the same flush into one op. Behind
  // a queued write or delete, the append joins it as one whole-file write, so
  // that op is not dropped.
  if (existing && existing.op === 'append') {
    existing.content += line;
    existing.seq = ++opSeq;
  } else if (existing) {
    pendingOps.set(absPath, { op: 'write', content: (existing.op === 'write' ? existing.content : '') + line, seq: ++opSeq });
  } else {
    pendingOps.set(absPath, { op: 'append', content: line, seq: ++opSeq });
  }
  scheduleFlush(absPath);
}

export function enqueueDelete(absPath: string): void {
  refuseWhileStorageFails(absPath);
  pendingOps.set(absPath, { op: 'delete', seq: ++opSeq });
  scheduleFlush(absPath);
}

/** One queued op, as confirmFile answers for it. */
export interface FileTicket {
  readonly kind: 'file';
  readonly path: string;
  readonly seq: number;
  readonly record: LandingRecord;
}

/** The ticket for the op queued on this path now: taken in the enqueue's own synchronous run, or for a delete still queued that an absent delete finds. */
export function fileTicket(absPath: string): FileTicket {
  const record = landingRecords.get(absPath) ?? startRecord(absPath);
  return { kind: 'file', path: absPath, seq: pendingOps.get(absPath)!.seq, record };
}

/**
 * Whether the disk holds one queued op, flushing it now: 'ok' once it, or a
 * later op to the same path, landed; 'pending' at the deadline. As flushPaths
 * gives up in line, three failed attempts, 25 and then 50 ms apart, with no
 * newer op arriving while one is under way, answer 'held' for an entry still
 * queued, and its retry owns the rest. Its waits are referenced: the flush they
 * wait on can end first and leave nothing else holding the process open.
 */
export async function confirmFile(ticket: FileTicket, deadlineMs: number): Promise<'ok' | 'pending' | 'held' | 'unavailable'> {
  const deadline = performance.now() + deadlineMs;
  // A whole write renamed into place before its chain failed is in the file: 'unavailable' with its kinded range.
  const covered = (): boolean => ticket.record.replaced?.some(t => t.from <= ticket.seq && ticket.seq <= t.through) ?? false;
  const unavailable = (): 'unavailable' => {
    if (covered()) failReplacedTries(ticket.record, ticket.path);
    return 'unavailable';
  };
  const unsettled = (answer: 'pending' | 'held'): 'pending' | 'held' | 'unavailable' => (covered() ? unavailable() : answer);
  let stuckAttempts = 0;
  for (;;) {
    const state = fileTicketState(ticket);
    if (state === 'unconfirmed') return unavailable();
    if (state === 'landed') return 'ok';
    // Its record retired without reaching it, or nothing queued: it was dropped.
    if (landingRecords.get(ticket.path) !== ticket.record || !pendingOps.has(ticket.path)) return unavailable();
    const left = deadline - performance.now();
    if (left <= 0) return unsettled('pending');
    if (flushing.has(ticket.path)) {
      await new Promise<void>(resolve => { setTimeout(resolve, Math.min(20, left)); });
      continue;
    }
    const before = pendingOps.get(ticket.path)!.seq;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), left);
      timer.unref();
    });
    const landed = await Promise.race([flushPath(ticket.path), timeout]);
    clearTimeout(timer);
    if (landed === 'timeout') return unsettled('pending');
    if (landed) continue;
    const after = pendingOps.get(ticket.path);
    if (!after) continue;
    if (after.seq !== before) {
      stuckAttempts = 0; // a newer op arrived: progress
      continue;
    }
    if (++stuckAttempts >= 3) return unsettled('held');
    const wait = Math.min(25 * stuckAttempts, deadline - performance.now());
    if (wait > 0) await new Promise<void>(resolve => { setTimeout(resolve, wait); });
  }
}

export function existsOnDisk(absPath: string): boolean {
  return fs.existsSync(absPath);
}

export function readFileUtf8(absPath: string): string {
  return fs.readFileSync(absPath, 'utf-8');
}

// ============================================================================
// RAW PATH ENTRY (root config + secondary bypassers outside the namespaces)
// ============================================================================

let rawRefusal: 'storage-failing' | 'io' | null = null;

/** Why the last writeRawAtomic or deleteRawAtomic returned false; null for a delete with nothing to delete. */
export function lastRawRefusal(): 'storage-failing' | 'io' | null {
  return rawRefusal;
}

function noteRawRefusal(error: unknown): void {
  rawRefusal = error instanceof DataBackendUnavailableError && error.causeKey === 'storage-failing' ? 'storage-failing' : 'io';
}

/** Enqueue an atomic write to an arbitrary absolute path. */
export function writeRawAtomic(absPath: string, contents: string): boolean {
  rawRefusal = null;
  try {
    refuseWhileStorageFails(absPath);
    pendingOps.set(absPath, { op: 'write', content: contents, seq: ++opSeq });
    scheduleFlush(absPath);
    return true;
  } catch (error) {
    console.error(`[DataManager] Error writing raw ${absPath}:`, error);
    noteRawRefusal(error);
    return false;
  }
}

/** Read an arbitrary absolute path, consulting the queue first (read-your-writes). */
export function readRaw(absPath: string): string | null {
  const pending = pendingOps.get(absPath);
  if (pending) {
    if (pending.op === 'delete') return null;
    if (pending.op === 'write') return pending.content;
  }
  try {
    if (!fs.existsSync(absPath)) return null;
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * readRaw for a caller that writes over what it read: null only for a file that
 * is absent or whose delete is queued; one that exists but cannot be read throws.
 * A folder in its place, or a file at one of its folders, is absent only under a guild
 * folder, where the write's placement check removes or refuses it; elsewhere it throws.
 */
export function readRawStrict(absPath: string): string | null {
  const pending = pendingOps.get(absPath);
  if (pending?.op === 'delete') return null;
  if (pending?.op === 'write') return pending.content;
  try {
    return fs.readFileSync(absPath, 'utf-8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    if ((error?.code === 'EISDIR' || error?.code === 'ENOTDIR') && underGuildFolder(absPath)) return null;
    throw error;
  }
}

function underGuildFolder(absPath: string): boolean {
  const rel = path.relative(BASE_DATA_DIR, path.resolve(absPath));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  return parts.length >= 2 && /^\d+$/.test(parts[0]);
}

/** Enqueue an atomic delete of an arbitrary absolute path. */
export function deleteRawAtomic(absPath: string): boolean {
  rawRefusal = null;
  try {
    const pending = pendingOps.get(absPath);
    if (!fs.existsSync(absPath) && (!pending || pending.op === 'delete')) return false;
    refuseWhileStorageFails(absPath);
    pendingOps.set(absPath, { op: 'delete', seq: ++opSeq });
    scheduleFlush(absPath);
    return true;
  } catch (error) {
    console.error(`[DataManager] Error deleting raw ${absPath}:`, error);
    noteRawRefusal(error);
    return false;
  }
}

// ============================================================================
// GUILD NAMESPACE DELETION (graveyard)
// ============================================================================

const GRAVEYARD_DIR = '_graveyard';

export function guildDirExists(guildId: string): boolean {
  return fs.existsSync(path.join(BASE_DATA_DIR, guildId));
}

/** Drop queued entries for every path under /data/{guildId}. */
export function dropPendingForGuild(guildId: string): void {
  dropGuildView(guildId);
  const src = path.join(BASE_DATA_DIR, guildId);
  const prefix = src + path.sep;
  for (const key of [...pendingOps.keys()]) {
    if (key === src || key.startsWith(prefix)) {
      const record = landingRecords.get(key);
      // Logged now, while the path still holds the file a graveyard move may take next.
      if (record) failReplacedTries(record, key);
      pendingOps.delete(key);
      landingRecords.delete(key);
      clearRetry(key);
    }
  }
}

/**
 * Rename /data/{guildId} under _graveyard, named by nextGraveyardName, and write its .graveyard.json reason note
 * inside. The facade drains and drops pending state first.
 */
export async function graveyardGuildDir(guildId: string, reason: string, writerLost: () => boolean = () => false, stopBeforeTry: () => boolean = () => false): Promise<boolean> {
  try {
    return await moveGuildDirToGraveyard(guildId, reason, writerLost, stopBeforeTry);
  } finally {
    dropGuildView(guildId);
  }
}

async function moveGuildDirToGraveyard(guildId: string, reason: string, writerLost: () => boolean, stopBeforeTry: () => boolean): Promise<boolean> {
  const src = path.join(BASE_DATA_DIR, guildId);
  // A flush on the wire would re-create the dir beside its graveyard copy: it settles first (bounded).
  const deadline = performance.now() + 5000;
  while ([...flushing].some(p => p === src || p.startsWith(src + path.sep)) && performance.now() < deadline) await delay(5);
  const graveyardRoot = path.join(BASE_DATA_DIR, GRAVEYARD_DIR);
  await fs.promises.mkdir(graveyardRoot, { recursive: true });
  const dest = path.join(graveyardRoot, `${guildId}-${nextGraveyardName(guildId)}`);

  for (let attempt = 0; ; attempt++) {
    if (writerLost()) {
      console.error(`[DataManager] Cannot move ${guildId} to graveyard: another process took the data files; nothing was removed`);
      return false;
    }
    if (stopBeforeTry()) return false;
    try {
      await fs.promises.rename(src, dest);
      dropGuildView(guildId);
      break;
    } catch (error) {
      dropGuildView(guildId);
      if (attempt >= 9) {
        console.error(`[DataManager] Failed to move ${guildId} to graveyard:`, error);
        return false;
      }
      await delay(25 * (attempt + 1));
    }
  }

  try {
    await writeGraveyardNote(dest, { guildId, reason, ts: Date.now() });
  } catch (error) {
    console.warn(`[DataManager] Failed to write graveyard marker for ${guildId}:`, error);
  }
  console.log(`[DataManager] Guild ${guildId} moved to graveyard (${reason})`);
  return true;
}

export interface FileGraveyardEntry {
  guildId: string;
  retiredAt: number;
  reason: string;
}

const ENTRY_NAME = /^(\d+)-(\d+)$/;
const RESTORE_FOLDER = /^\.(copy|restore)-(\d+)-(\d+)-(\d+)$/;

/** Enumerate _graveyard entries ({guildId}-{ms} dirs), newest first; with a guild, only that guild's. */
export async function listGraveyardEntries(guildId?: string): Promise<FileGraveyardEntry[]> {
  const graveyardRoot = path.join(BASE_DATA_DIR, GRAVEYARD_DIR);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(graveyardRoot, { withFileTypes: true });
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return [];
    throw error;
  }
  const out: FileGraveyardEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dashIdx = entry.name.lastIndexOf('-');
    if (dashIdx <= 0) continue;
    const owner = entry.name.slice(0, dashIdx);
    const retiredAt = Number(entry.name.slice(dashIdx + 1));
    if (!/^\d+$/.test(owner) || !Number.isFinite(retiredAt)) continue;
    if (guildId !== undefined && owner !== guildId) continue;
    let reason = '';
    try {
      const raw = await fs.promises.readFile(path.join(graveyardRoot, entry.name, NOTE_FILE), 'utf-8');
      const marker = JSON.parse(raw) as { reason?: unknown };
      if (typeof marker?.reason === 'string') reason = marker.reason;
    } catch { /* marker is best-effort */ }
    out.push({ guildId: owner, retiredAt, reason });
  }
  out.sort((a, b) => b.retiredAt - a.retiredAt);
  return out;
}

const NOTE_FILE = '.graveyard.json';
const SWEEP_PREFIX = '.sweep-';

/**
 * The number the guild's next graveyard folder {guildId}-{n} takes: the later of now and one above every number the
 * guild's entries and restore folders hold (a restore folder's number stays reserved while it exists).
 */
export function nextGraveyardName(guildId: string): number {
  let newest = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(BASE_DATA_DIR, GRAVEYARD_DIR));
  } catch { /* no graveyard yet */ }
  for (const name of names) {
    const entry = ENTRY_NAME.exec(name);
    if (entry && entry[1] === guildId) newest = Math.max(newest, Number(entry[2]));
    const folder = RESTORE_FOLDER.exec(name);
    if (folder && folder[2] === guildId) newest = Math.max(newest, Number(folder[4]));
  }
  return Math.max(Date.now(), newest + 1);
}

export interface GraveyardNote {
  guildId: string;
  reason: string;
  ts: number;
  usedAt?: number;
  [field: string]: unknown;
}

/**
 * Writes a graveyard note whole into an existing entry folder: a 'wx' temp file inside it (no folder is made, so a
 * missing folder rejects with ENOENT), fsynced, renamed over .graveyard.json with atomicReplace's retry.
 */
export async function writeGraveyardNote(entryDir: string, note: GraveyardNote): Promise<void> {
  const target = path.join(entryDir, NOTE_FILE);
  const tmp = tmpNameFor(target);
  const fh = await fs.promises.open(tmp, 'wx');
  try {
    try {
      await fh.writeFile(JSON.stringify(note, null, 2), 'utf-8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(tmp, target);
        break;
      } catch (error) {
        if (attempt >= 9 || errnoOf(error) === 'ENOENT') throw error;
        await delay(25 * (attempt + 1));
      }
    }
  } catch (error) {
    await fs.promises.unlink(tmp).catch(() => undefined);
    throw error;
  }
  await syncFolder(entryDir);
}

/** writeGraveyardNote with sync calls only, for the boot: one rename try. */
export function writeGraveyardNoteSync(entryDir: string, note: GraveyardNote): void {
  const target = path.join(entryDir, NOTE_FILE);
  const tmp = tmpNameFor(target);
  const fd = fs.openSync(tmp, 'wx');
  try {
    try {
      fs.writeSync(fd, JSON.stringify(note, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* the temp file is swept as an orphan */ }
    throw error;
  }
  syncFolderSync(entryDir);
}

/** fsyncDataDirs with sync calls only, best effort, for the boot. */
export function fsyncDataDirsSync(): void {
  for (const dir of [BASE_DATA_DIR, path.join(BASE_DATA_DIR, GRAVEYARD_DIR)]) syncFolderSync(dir);
}

/**
 * Decision 10's rule for a restore's own folder: a .copy- folder is dropped; a .restore-<g>-<x>-<n> folder is finished
 * when _graveyard/<g>-<n> exists and /data/<g> does not, and dropped otherwise. null: not a restore folder.
 */
function restoreFolderRule(name: string): { guildId: string; x: number; n: number; action: 'drop' | 'finish' } | null {
  const m = RESTORE_FOLDER.exec(name);
  if (!m) return null;
  const [, kind, guildId, x, n] = m;
  const finish = kind === 'restore'
    && fs.existsSync(path.join(BASE_DATA_DIR, GRAVEYARD_DIR, `${guildId}-${n}`))
    && !fs.existsSync(path.join(BASE_DATA_DIR, guildId));
  return { guildId, x: Number(x), n: Number(n), action: finish ? 'finish' : 'drop' };
}

const droppedName = (guildId: string, x: number, n: number) => `${SWEEP_PREFIX}restore-${guildId}-${x}-${n}`;

/**
 * The boot: ends every restore folder a stopped process left, with sync calls only. A replace whose live folder had
 * moved to its entry is finished (the copy renamed into place, the entry's note written); every other copy is renamed
 * to a .sweep- name, which the boot's sweep removes.
 */
export function recoverGraveyardRestores(): void {
  const graveyardRoot = path.join(BASE_DATA_DIR, GRAVEYARD_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(graveyardRoot);
  } catch {
    return; // no graveyard yet
  }
  for (const name of names) {
    let rule: ReturnType<typeof restoreFolderRule>;
    try {
      rule = restoreFolderRule(name);
    } catch (error) {
      console.error(`[DataManager] Cannot check graveyard folder ${name} at boot (tried again at the next sweep or boot):`, error);
      continue;
    }
    if (!rule) continue;
    const { guildId, x, n } = rule;
    if (rule.action === 'drop') {
      try {
        fs.renameSync(path.join(graveyardRoot, name), path.join(graveyardRoot, droppedName(guildId, x, n)));
      } catch (error) {
        console.error(`[DataManager] Cannot drop graveyard folder ${name} at boot (tried again at the next sweep or boot):`, error);
      }
      continue;
    }
    try {
      fs.renameSync(path.join(graveyardRoot, name), path.join(BASE_DATA_DIR, guildId));
    } catch (error) {
      console.error(`[DataManager] Cannot finish the replace of guild ${guildId}'s data with entry ${x} at boot (tried again at the next boot):`, error);
      continue;
    } finally {
      dropGuildView(guildId);
    }
    const entryDir = path.join(graveyardRoot, `${guildId}-${n}`);
    if (!fs.existsSync(path.join(entryDir, NOTE_FILE))) {
      try {
        writeGraveyardNoteSync(entryDir, { guildId, reason: `replaced-by-restore-${x}`, ts: Date.now() });
      } catch (error) {
        console.error(`[DataManager] Graveyard entry ${guildId}-${n} holds guild ${guildId}'s data from before the replace; its note could not be written (${errnoOf(error)}), so it is listed with an empty reason`);
      }
    }
    fsyncDataDirsSync();
    console.log(`[DataManager] Finished the replace of guild ${guildId}'s data with entry ${x}; its data from before is entry ${n}`);
  }
}

export type FileRestoreOutcome =
  | { ok: true; retiredAt: number; reason: string; usedAt: number; replaced?: { retiredAt: number; reason?: string } | null; moveUnconfirmed?: string }
  | { ok: false; why: 'no-entry' }
  | { ok: false; why: 'live'; retiredAt: number }
  | { ok: false; why: 'stopped'; stop: RestoreStop }
  | { ok: false; why: 'writer-lost' }
  | { ok: false; why: 'failing'; file: string; code: string }
  | { ok: false; why: 'unflushed' }
  | { ok: false; why: 'stamp' | 'copy' | 'move' | 'put'; x: number; code: string }
  | { ok: false; why: 'copy-sync'; x: number; code: string; kind: SyncKind; dir: string }
  | { ok: false; why: 'copy-deadline'; x: number; copied: number }
  | { ok: false; why: 'undone'; x: number; r: number; code: string; syncCode?: string }
  | { ok: false; why: 'undone-taken'; x: number; r: number; code: string; syncCode?: string }
  | { ok: false; why: 'half'; x: number; r: number; code: string; undoCode: string }
  | { ok: false; why: 'half-taken'; x: number; r: number; code: string };

export interface FileRestoreHooks {
  /** The maintenance gate, the exit drain, or the deadline less floorMs (0 when absent). */
  stop: (floorMs?: number) => RestoreStop | null;
  /** The cached flag: another process took the data files (read up to the copy). */
  writerLost: () => boolean;
  /** The lock file itself read again (the check before the renames, each try, the undo, K6). */
  writerTaken: () => boolean;
  replace: boolean;
  /** Opens a rename section: from K4's start to its end; the drain waits for every open one. Answers its end. */
  enterSection: () => () => void;
  /** renamed: the copy's rename into place returned; moved: K4's rename of the live folder returned. */
  progress: { renamed: boolean; moved: { r: number; x: number } | null };
}

/** The copy's floor: K4 and K5 need the last 5 s of the restore's time. */
const COPY_FLOOR_MS = 5000;

class CopySyncError extends Error {
  constructor(readonly dir: string, readonly errno: string, readonly kind: SyncKind) {
    super(`folder sync of the copy failed: ${dir} (${errno})`);
  }
}

class CopyRefusal extends Error {
  constructor(readonly outcome: FileRestoreOutcome) {
    super('restore copy refused');
  }
}

/**
 * Puts a copy of a _graveyard entry in place as /data/{guildId} (the given retiredAt, else the newest) and keeps the
 * entry, stamping its note with usedAt. A plain restore is refused while the guild folder exists or an op under it
 * is queued or on the wire; a replace first moves the live folder to a new entry. Decision 9's K steps.
 */
export async function restoreGuildDirFromGraveyard(guildId: string, retiredAt: number | undefined, hooks: FileRestoreHooks): Promise<FileRestoreOutcome> {
  try {
    return await restoreGuildDir(guildId, retiredAt, hooks);
  } finally {
    dropGuildView(guildId);
  }
}

function writerLostAnswer(guildId: string): FileRestoreOutcome {
  console.error(`[DataManager] Cannot restore guild ${guildId} from the graveyard: another process took the data files`);
  return { ok: false, why: 'writer-lost' };
}

/** Renames from to to with the retire's retry; before each try, refuse may answer a refusal. */
async function renameWithRetry(from: string, to: string, refuse: () => FileRestoreOutcome | null, after: () => void, final: (code: string) => boolean = () => false): Promise<{ ok: true } | { ok: false; refused: FileRestoreOutcome } | { ok: false; code: string; error: unknown }> {
  for (let attempt = 0; ; attempt++) {
    const refused = refuse();
    if (refused) return { ok: false, refused };
    try {
      await fs.promises.rename(from, to);
      after();
      return { ok: true };
    } catch (error) {
      after();
      if (attempt >= 9 || final(errnoOf(error))) return { ok: false, code: errnoOf(error), error };
      await delay(25 * (attempt + 1));
    }
  }
}

/** A drop: the copy renamed to its .sweep- name inside the step; its removal runs after the answer. */
async function dropCopy(folder: string, guildId: string, x: number, n: number): Promise<void> {
  const graveyardRoot = path.join(BASE_DATA_DIR, GRAVEYARD_DIR);
  const aside = path.join(graveyardRoot, droppedName(guildId, x, n));
  const moved = await renameWithRetry(folder, aside, () => null, () => undefined, code => code === 'ENOENT');
  if (!moved.ok) {
    if ('code' in moved && moved.code === 'ENOENT') console.warn(`[DataManager] The restore's copy ${path.basename(folder)} was already removed; nothing to drop`);
    else if ('error' in moved) console.error(`[DataManager] Cannot drop the restore's copy ${path.basename(folder)} (dropped at the next sweep or boot):`, moved.error);
    return;
  }
  setImmediate(() => {
    fs.promises.rm(aside, { recursive: true, force: true }).catch(error => {
      console.warn(`[DataManager] Failed to remove dropped restore copy ${path.basename(aside)} (removed at the next sweep):`, error);
    });
  });
}

async function restoreGuildDir(guildId: string, retiredAt: number | undefined, hooks: FileRestoreHooks): Promise<FileRestoreOutcome> {
  const graveyardRoot = path.join(BASE_DATA_DIR, GRAVEYARD_DIR);
  const early = (floor = 0): FileRestoreOutcome | null => {
    const stop = hooks.stop(floor);
    if (stop) return { ok: false, why: 'stopped', stop };
    return hooks.writerLost() ? writerLostAnswer(guildId) : null;
  };

  // K1: what was accepted before the gate closed is on disk and moves with the folder; an op still queued refuses.
  if (hooks.replace) {
    await flushGuild(guildId);
    if (guildHasQueuedOps(guildId)) {
      const failing = guildFailingWrite(guildId);
      console.error(`[DataManager] Cannot replace guild ${guildId}'s data: ${failing ? `${failing.file} keeps failing to save (${failing.code})` : 'a write of it is not saved yet'}; nothing was restored`);
      return failing ? { ok: false, why: 'failing', file: failing.file, code: failing.code } : { ok: false, why: 'unflushed' };
    }
    const k1 = early();
    if (k1) return k1;
  }

  // K2: the lookup, the live check, the number, then the stamp of X's note.
  let x: number | null = null;
  if (retiredAt !== undefined) {
    if (fs.existsSync(path.join(graveyardRoot, `${guildId}-${retiredAt}`))) x = retiredAt;
  } else {
    const newest = (await listGraveyardEntries(guildId))[0];
    if (newest) x = newest.retiredAt;
  }
  if (x === null) return { ok: false, why: 'no-entry' };
  const liveNow = guildDirExists(guildId);
  if (!hooks.replace && (liveNow || guildHasQueuedOps(guildId))) return { ok: false, why: 'live', retiredAt: x };
  const moving = hooks.replace && liveNow;
  const n = nextGraveyardName(guildId);
  const k2 = early();
  if (k2) return k2;

  const entryPath = path.join(graveyardRoot, `${guildId}-${x}`);
  const notePath = path.join(entryPath, NOTE_FILE);
  let fields: GraveyardNote = { guildId, reason: '', ts: x };
  try {
    const raw = await fs.promises.readFile(notePath, 'utf-8');
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed as GraveyardNote;
    } catch { /* a note that does not parse gives a fresh one */ }
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') {
      console.error(`[DataManager] Cannot restore guild ${guildId}: the note of graveyard entry ${guildId}-${x} could not be read:`, error);
      return { ok: false, why: 'stamp', x, code: errnoOf(error) };
    }
  }
  const reason = typeof fields.reason === 'string' ? fields.reason : '';
  const usedAt = Date.now();
  try {
    await writeGraveyardNote(entryPath, { ...fields, usedAt });
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return { ok: false, why: 'no-entry' };
    console.error(`[DataManager] Cannot restore guild ${guildId}: graveyard entry ${guildId}-${x} could not be marked as restored:`, error);
    return { ok: false, why: 'stamp', x, code: errnoOf(error) };
  }

  // K3: the copy, every file fsynced, renamed to its .restore- name; the gates are read before each entry.
  const copyPath = path.join(graveyardRoot, `.copy-${guildId}-${x}-${n}`);
  const restorePath = path.join(graveyardRoot, `.restore-${guildId}-${x}-${n}`);
  let copied = 0;
  const copyCheck = () => {
    const refused = early(COPY_FLOOR_MS);
    if (!refused) return;
    if (!refused.ok && refused.why === 'stopped' && refused.stop === 'out-of-time') throw new CopyRefusal({ ok: false, why: 'copy-deadline', x: x!, copied });
    throw new CopyRefusal(refused);
  };
  let copyAt = copyPath;
  const failCopy = async (outcome: FileRestoreOutcome): Promise<FileRestoreOutcome> => {
    await dropCopy(copyAt, guildId, x!, n);
    return outcome;
  };
  try {
    await fs.promises.cp(entryPath, copyPath, {
      recursive: true,
      filter: async (src: string) => {
        copyCheck();
        if (path.resolve(src) === path.resolve(entryPath)) return true;
        const name = path.basename(src);
        if (name.endsWith('.tmp') || (name === NOTE_FILE && path.resolve(path.dirname(src)) === path.resolve(entryPath))) return false;
        if ((await fs.promises.lstat(src)).isFile()) copied++;
        return true;
      },
    });
    await syncCopy(copyPath, copyCheck);
    copyCheck();
    await fs.promises.rename(copyPath, restorePath);
    copyAt = restorePath;
  } catch (error) {
    if (error instanceof CopyRefusal) return fs.existsSync(copyPath) || fs.existsSync(restorePath) ? failCopy(error.outcome) : error.outcome;
    if (error instanceof CopySyncError) return failCopy(copySyncAnswer(guildId, x, error));
    const code = errnoOf(error);
    if (code !== 'ENOENT') console.error(`[DataManager] Cannot restore guild ${guildId}: graveyard entry ${guildId}-${x} could not be copied:`, error);
    if (!fs.existsSync(copyPath) && !fs.existsSync(restorePath)) return code === 'ENOENT' ? { ok: false, why: 'no-entry' } : { ok: false, why: 'copy', x, code };
    return failCopy(code === 'ENOENT' ? { ok: false, why: 'no-entry' } : { ok: false, why: 'copy', x, code });
  }
  const copySync = await fsyncDataDirs();
  if (copySync.failed) return failCopy(copySyncAnswer(guildId, x, { dir: copySync.dir, errno: copySync.code, kind: copySync.kind }));

  // The check before the renames, one synchronous run: the gates, the copy's deadline, the lock file and X.
  const stop = hooks.stop(COPY_FLOOR_MS);
  if (stop) return failCopy(stop === 'out-of-time' ? { ok: false, why: 'copy-deadline', x, copied } : { ok: false, why: 'stopped', stop });
  if (hooks.writerTaken()) return failCopy(writerLostAnswer(guildId));
  if (!fs.existsSync(entryPath)) return failCopy({ ok: false, why: 'no-entry' });
  if (!moving) return putPlainCopy(guildId, x, n, reason, usedAt, restorePath, hooks, failCopy);

  const endSection = hooks.enterSection();
  try {
    return await replaceInSection(guildId, x, n, reason, usedAt, restorePath, hooks);
  } finally {
    endSection();
  }
}

/** T18 logged, and the copy-sync outcome of a folder sync of the copy or of the check after it. */
function copySyncAnswer(guildId: string, x: number, failure: { dir: string; errno: string; kind: SyncKind }): FileRestoreOutcome {
  const { why } = syncWords(failure.kind, failure.dir, failure.errno);
  console.error(`[DataManager] Cannot restore guild ${guildId}: the copy of entry ${guildId}-${x} is written, but ${why}`);
  return { ok: false, why: 'copy-sync', x, code: failure.errno, kind: failure.kind, dir: failure.dir };
}

/** fsyncs every copied file (opened 'r+': Windows needs write access) and, on POSIX, every folder; a failed folder sync throws. */
async function syncCopy(dir: string, check: () => void): Promise<void> {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await syncCopy(full, check);
      continue;
    }
    check();
    const fh = await fs.promises.open(full, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  }
  if (IS_WINDOWS) return;
  check();
  const synced = await syncFolder(dir);
  if (synced.failed) throw new CopySyncError(synced.dir, synced.errno, synced.kind);
}

/** K5 of a plain restore: the gates and the lock file read before each try; a refusal or a failure drops the copy. */
async function putPlainCopy(guildId: string, x: number, n: number, reason: string, usedAt: number, restorePath: string, hooks: FileRestoreHooks, fail: (outcome: FileRestoreOutcome) => Promise<FileRestoreOutcome>): Promise<FileRestoreOutcome> {
  const live = path.join(BASE_DATA_DIR, guildId);
  const put = await renameWithRetry(restorePath, live, () => {
    const stop = hooks.stop();
    if (stop) return { ok: false, why: 'stopped', stop };
    return hooks.writerTaken() ? writerLostAnswer(guildId) : null;
  }, () => dropGuildView(guildId));
  if (!put.ok) {
    if ('refused' in put) return fail(put.refused);
    console.error(`[DataManager] Cannot restore guild ${guildId}: the copy of graveyard entry ${guildId}-${x} could not be put in place:`, put.error);
    return fail({ ok: false, why: 'put', x, code: put.code });
  }
  hooks.progress.renamed = true;
  forgetGuildDurableFiles(guildId);
  const synced = await fsyncDataDirs();
  if (synced.failed) {
    console.error(`[DataManager] Guild ${guildId} restored from graveyard entry ${guildId}-${x}, but the disk did not confirm the sync of ${synced.dir} (${synced.code}), so a power cut can put the folder back in the graveyard`);
  } else {
    console.warn(`[DataManager] Guild ${guildId} restored from graveyard entry ${guildId}-${x}`);
  }
  return { ok: true, retiredAt: x, reason, usedAt, ...(hooks.replace ? { replaced: null } : {}), ...(synced.failed ? { moveUnconfirmed: synced.code } : {}) };
}

/** K4 to K6 of a replace, inside its rename section. After K4's rename nothing reads the gates or the deadline. */
async function replaceInSection(guildId: string, x: number, n: number, reason: string, usedAt: number, restorePath: string, hooks: FileRestoreHooks): Promise<FileRestoreOutcome> {
  const graveyardRoot = path.join(BASE_DATA_DIR, GRAVEYARD_DIR);
  const live = path.join(BASE_DATA_DIR, guildId);
  const rPath = path.join(graveyardRoot, `${guildId}-${n}`);

  // K4: the live folder becomes entry R.
  const moved = await renameWithRetry(live, rPath, () => {
    const stop = hooks.stop();
    if (stop) return { ok: false, why: 'stopped', stop };
    return hooks.writerTaken() ? writerLostAnswer(guildId) : null;
  }, () => dropGuildView(guildId));
  if (!moved.ok) {
    await dropCopy(restorePath, guildId, x, n);
    if ('refused' in moved) return moved.refused;
    console.error(`[DataManager] Cannot replace guild ${guildId}'s data: its folder could not be moved to the graveyard:`, moved.error);
    return { ok: false, why: 'move', x, code: moved.code };
  }
  hooks.progress.moved = { r: n, x };
  forgetGuildDurableFiles(guildId);
  let unconfirmed: string | null = null;
  const k4Sync = await fsyncDataDirs();
  if (k4Sync.failed) unconfirmed = k4Sync.code;

  // K5: the copy into place, with no read; on failure the undo.
  let putCode: string | null = null;
  try {
    const put = await renameWithRetry(restorePath, live, () => null, () => dropGuildView(guildId));
    if (!put.ok) {
      putCode = 'code' in put ? put.code : 'EIO';
      console.error(`[DataManager] The copy of graveyard entry ${guildId}-${x} could not be put in place for guild ${guildId}:`, 'error' in put ? put.error : put);
    }
  } catch (error) {
    putCode = errnoOf(error);
    console.error(`[DataManager] The copy of graveyard entry ${guildId}-${x} could not be put in place for guild ${guildId}:`, error);
  }
  if (putCode !== null) return undoReplace(guildId, x, n, putCode, restorePath, hooks);
  hooks.progress.renamed = true;
  forgetGuildDurableFiles(guildId);

  // K6: R's note, unless another process took the data files.
  let noteWritten = false;
  if (hooks.writerTaken()) {
    console.error(`[DataManager] Graveyard entry ${guildId}-${n} holds guild ${guildId}'s data from before the replace; its note was not written: another process took the data files`);
  } else {
    try {
      await writeGraveyardNote(rPath, { guildId, reason: `replaced-by-restore-${x}`, ts: Date.now() });
      noteWritten = true;
    } catch (error) {
      console.error(`[DataManager] Graveyard entry ${guildId}-${n} holds guild ${guildId}'s data from before the replace; its note could not be written, so it is listed with an empty reason:`, error);
    }
  }
  const k6Sync = await fsyncDataDirs();
  if (k6Sync.failed && unconfirmed === null) unconfirmed = k6Sync.code;
  if (unconfirmed !== null) {
    console.error(`[DataManager] Guild ${guildId}'s data was replaced with a copy of graveyard entry ${guildId}-${x}, but the disk did not confirm a folder sync (${unconfirmed}), so a power cut can undo the replace`);
  } else {
    console.warn(`[DataManager] Guild ${guildId}'s data was replaced with a copy of graveyard entry ${guildId}-${x}; its data from before is entry ${guildId}-${n}`);
  }
  return {
    ok: true, retiredAt: x, reason, usedAt,
    replaced: noteWritten ? { retiredAt: n, reason: `replaced-by-restore-${x}` } : { retiredAt: n },
    ...(unconfirmed === null ? {} : { moveUnconfirmed: unconfirmed }),
  };
}

/** The undo: entry R renamed back with fs.renameSync, the lock file read before each try and right after the rename. */
async function undoReplace(guildId: string, x: number, n: number, code: string, restorePath: string, hooks: FileRestoreHooks): Promise<FileRestoreOutcome> {
  const live = path.join(BASE_DATA_DIR, guildId);
  const rPath = path.join(BASE_DATA_DIR, GRAVEYARD_DIR, `${guildId}-${n}`);
  for (let attempt = 0; ; attempt++) {
    if (hooks.writerTaken()) {
      console.error(`[DataManager] Guild ${guildId}: another process took the data files after the server's data moved to graveyard entry ${guildId}-${n}; the copy of entry ${x} stays under _graveyard/.restore-${guildId}-${x}-${n} for the next bot start to finish or drop`);
      return { ok: false, why: 'half-taken', x, r: n, code };
    }
    let takenAfter: boolean;
    try {
      fs.renameSync(rPath, live);
      takenAfter = hooks.writerTaken();
    } catch (error) {
      dropGuildView(guildId);
      if (attempt >= 9) {
        console.error(`[DataManager] Guild ${guildId}: its data could not be moved back from graveyard entry ${guildId}-${n}; entries ${n} and ${x} are both listed:`, error);
        await dropCopy(restorePath, guildId, x, n);
        return { ok: false, why: 'half', x, r: n, code, undoCode: errnoOf(error) };
      }
      await delay(25 * (attempt + 1));
      continue;
    }
    dropGuildView(guildId);
    forgetGuildDurableFiles(guildId);
    const synced = await fsyncDataDirs();
    const syncCode = synced.failed ? { syncCode: synced.code } : {};
    if (takenAfter) {
      console.error(`[DataManager] Guild ${guildId}: the server's data moved back from graveyard entry ${guildId}-${n} while another process took the data files; a save of that process may have replaced one of its files`);
      return { ok: false, why: 'undone-taken', x, r: n, code, ...syncCode };
    }
    await dropCopy(restorePath, guildId, x, n);
    return { ok: false, why: 'undone', x, r: n, code, ...syncCode };
  }
}

/** A note's numeric usedAt, or null when it has none; throws a code when the note cannot be read or parsed. */
function noteUsedAt(entryDir: string): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(entryDir, NOTE_FILE), 'utf-8');
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return null;
    throw new Error(errnoOf(error));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('parse');
  }
  const usedAt = (parsed as { usedAt?: unknown } | null)?.usedAt;
  return typeof usedAt === 'number' && Number.isFinite(usedAt) ? usedAt : null;
}

/**
 * Removes graveyard entries whose delete and newest restore are both older than the TTL (default 14 days). Each name
 * is decided and renamed in one synchronous run: an expired entry to .sweep-<name>, a restore folder that decision
 * 10's rule drops to its .sweep- name; then every .sweep- folder is removed. skip: a guild whose restore runs keeps
 * its entries and folders.
 */
export async function sweepGraveyard(skip: (guildId: string) => boolean = () => false): Promise<void> {
  const graveyardRoot = path.join(BASE_DATA_DIR, GRAVEYARD_DIR);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(graveyardRoot, { withFileTypes: true });
  } catch {
    return; // no graveyard yet
  }
  const ttlDays = Number(process.env.GRAVEYARD_TTL_DAYS);
  const ttlMs = (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 14) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - ttlMs;
  const toRemove: Array<{ aside: string; entry: string | null }> = [];
  const renameAside = (name: string, aside: string, what: string): boolean => {
    try {
      fs.renameSync(path.join(graveyardRoot, name), path.join(graveyardRoot, aside));
      return true;
    } catch (error) {
      console.warn(`[DataManager] Failed to sweep graveyard ${what} ${name} (tried again at the next sweep):`, error);
      return false;
    }
  };
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name.startsWith(SWEEP_PREFIX)) {
      toRemove.push({ aside: name, entry: null });
      continue;
    }
    if (name.startsWith('.')) {
      const m = RESTORE_FOLDER.exec(name);
      if (!m || skip(m[2])) continue;
      let rule: ReturnType<typeof restoreFolderRule>;
      try {
        rule = restoreFolderRule(name);
      } catch {
        continue;
      }
      if (!rule || rule.action !== 'drop') continue;
      const aside = droppedName(rule.guildId, rule.x, rule.n);
      if (renameAside(name, aside, 'folder')) toRemove.push({ aside, entry: null });
      continue;
    }
    const dashIdx = name.lastIndexOf('-');
    let ts = dashIdx >= 0 ? Number(name.slice(dashIdx + 1)) : NaN;
    if (!Number.isFinite(ts)) {
      try { ts = fs.statSync(path.join(graveyardRoot, name)).mtimeMs; } catch { continue; }
    }
    if (ts >= cutoff) continue;
    if (dashIdx > 0 && skip(name.slice(0, dashIdx))) continue;
    let usedAt: number | null;
    try {
      usedAt = noteUsedAt(path.join(graveyardRoot, name));
    } catch (error) {
      console.warn(`[DataManager] Graveyard entry ${name} kept: its note could not be read (${(error as Error).message})`);
      continue;
    }
    if (usedAt !== null && usedAt >= cutoff) continue;
    const aside = `${SWEEP_PREFIX}${name}`;
    if (renameAside(name, aside, 'entry')) toRemove.push({ aside, entry: name });
  }
  for (const { aside, entry } of toRemove) {
    try {
      await fs.promises.rm(path.join(graveyardRoot, aside), { recursive: true, force: true });
      if (entry) console.log(`[DataManager] Swept expired graveyard entry: ${entry}`);
    } catch (error) {
      console.warn(`[DataManager] Failed to remove swept graveyard folder ${aside} (removed at the next sweep):`, error);
    }
  }
}

// ============================================================================
// ENUMERATION + SIZING
// ============================================================================

/**
 * List all guild directories
 */
export function listGuilds(): string[] {
  try {
    const items = fs.readdirSync(BASE_DATA_DIR);
    // The numeric-only filter also excludes _graveyard, global, dist.
    return items.filter(item => {
      const fullPath = path.join(BASE_DATA_DIR, item);
      return fs.statSync(fullPath).isDirectory() &&
             item !== 'global' && // Global data directory (not guild-specific)
             item !== 'dist' && // Build output (not guild data)
             /^\d+$/.test(item); // Guild IDs are numeric only
    });
  } catch (error) {
    console.error('[DataManager] Error listing guilds:', error);
    return [];
  }
}

/**
 * List all data files in a guild directory
 */
export function listGuildDataFiles(guildId: string, category?: string): string[] {
  try {
    const dir = category
      ? path.join(BASE_DATA_DIR, guildId, category)
      : path.join(BASE_DATA_DIR, guildId);

    if (!fs.existsSync(dir)) {
      return [];
    }

    const items = fs.readdirSync(dir);
    return items.filter(item => {
      const fullPath = path.join(dir, item);
      return fs.statSync(fullPath).isFile() && item.endsWith('.json');
    });
  } catch (error) {
    console.error(`[DataManager] Error listing guild data files for ${guildId}:`, error);
    return [];
  }
}

/**
 * List all data files in global directory
 */
export function listGlobalDataFiles(category?: string): string[] {
  try {
    const dir = category
      ? path.join(BASE_DATA_DIR, 'global', category)
      : path.join(BASE_DATA_DIR, 'global');

    if (!fs.existsSync(dir)) {
      return [];
    }

    const items = fs.readdirSync(dir);
    return items.filter(item => {
      const fullPath = path.join(dir, item);
      return fs.statSync(fullPath).isFile() && item.endsWith('.json');
    });
  } catch (error) {
    console.error('[DataManager] Error listing global data files:', error);
    return [];
  }
}

async function sizeDirectoryRecursive(dir: string, exclude?: string[]): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (exclude && entry.isDirectory() && exclude.includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await sizeDirectoryRecursive(fullPath);
    } else if (entry.isFile()) {
      try {
        total += (await fs.promises.stat(fullPath)).size;
      } catch { /* file vanished mid-walk */ }
    }
  }
  return total;
}

/**
 * Total size in bytes of the global data directory. Excludes the fleet subdir
 * (the node identity, not user data).
 */
export function sizeOfGlobalData(): Promise<number> {
  return sizeDirectoryRecursive(path.join(BASE_DATA_DIR, 'global'), ['fleet']);
}

const ORPHAN_TMP_MAX_AGE_MS = 60 * 60 * 1000;

// Delete *.tmp files (from an interrupted atomic write) older than 1h. Recurses
// the whole data tree; a young tmp may be an in-flight write and is left alone.
export async function cleanOrphanTmpFiles(dir: string = BASE_DATA_DIR): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - ORPHAN_TMP_MAX_AGE_MS;
  const atRoot = path.resolve(dir) === path.resolve(BASE_DATA_DIR);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // A data migration's staging and superseded folders keep every file as it was.
      if (atRoot && (entry.name === '_superseded' || entry.name.startsWith('.migrate-'))) continue;
      await cleanOrphanTmpFiles(full);
    } else if (entry.isFile() && entry.name.endsWith('.tmp')) {
      try {
        const stat = await fs.promises.stat(full);
        if (stat.mtimeMs < cutoff) {
          await fs.promises.unlink(full);
          console.log(`[DataManager] Removed orphaned temp file: ${full}`);
        }
      } catch { /* vanished mid-sweep */ }
    }
  }
}

// ============================================================================
// PLACEMENT (NB12 rule P on the file route)
// ============================================================================

/** A folder a listing showed: its exact name, and whether every folder below it has been listed. */
interface SubFolder {
  walked: boolean;
}

/** What one process knows of a guild folder: its keys, and per listed folder the sub-folders its listing showed. */
interface GuildView {
  tree: KeyTree;
  listed: Map<string, Map<string, Map<string, SubFolder>>>;
}

// On in the bot process (its shard boot): the one process that deletes, retires and restores guild files keeps a view
// per guild across calls. Off elsewhere: every guild write reads its key's path afresh.
let viewCache = false;
const views = new Map<string, GuildView>();

export function setGuildViewCache(on: boolean): void {
  viewCache = on;
  views.clear();
}

export function dropGuildView(guildId: string): void {
  views.delete(guildId);
}

export type Placement = { ok: true } | { ok: false; cause: 'unstorable' | 'io'; reason: string };

const guildRoot = (guildId: string): string => path.join(BASE_DATA_DIR, guildId);
const relJoin = (a: string, b: string): string => (a ? `${a}/${b}` : b);
const absOf = (guildId: string, rel: string): string => (rel ? path.join(guildRoot(guildId), ...rel.split('/')) : guildRoot(guildId));
const parentOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const nameOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);

function foldersOfKey(key: string): string[] {
  const segs = key.split('/');
  return segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join('/'));
}

/** The guild's paths with an op queued in this process, as keys, by the op. */
function queuedOf(guildId: string): Map<string, PendingOp['op']> {
  const out = new Map<string, PendingOp['op']>();
  for (const [key, p] of pendingOps.byGuild.get(guildId) ?? []) out.set(key, pendingOps.get(p)!.op);
  return out;
}

function viewOf(guildId: string): GuildView {
  if (!viewCache) return freshView(guildId);
  let view = views.get(guildId);
  if (!view) {
    view = freshView(guildId);
    views.set(guildId, view);
  }
  return view;
}

function freshView(guildId: string): GuildView {
  const view: GuildView = { tree: new KeyTree(), listed: new Map() };
  for (const [key, op] of queuedOf(guildId)) if (op !== 'delete') view.tree.add(key);
  return view;
}

/** One listing of a folder: its files (no .tmp, none with a delete queued here) into the tree, its folders recorded. */
function listFolder(guildId: string, view: GuildView, rel: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absOf(guildId, rel), { withFileTypes: true });
  } catch (error: any) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    entries = [];
  }
  const subs = new Map<string, Map<string, SubFolder>>();
  const refused: string[] = [];
  let collided = 0;
  const firsts: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const f = fold(entry.name);
      let spellings = subs.get(f);
      if (!spellings) {
        spellings = new Map();
        subs.set(f, spellings);
      }
      spellings.set(entry.name, { walked: false });
      continue;
    }
    if (entry.name.endsWith('.tmp')) continue;
    const key = relJoin(rel, entry.name);
    if (pendingOps.get(absOf(guildId, key))?.op === 'delete') continue;
    if (view.tree.has(key)) continue;
    const collision = view.tree.add(key);
    const refusal = keyRefusal(key);
    if (refusal) {
      refused.push(key);
      if (firsts.length < 3) firsts.push(`${key}: ${refusal}`);
    } else if (collision) {
      collided += 1;
      if (firsts.length < 3) firsts.push(`${key}: ${collision.reason}`);
    }
  }
  view.listed.set(rel, subs);
  if (refused.length > 0 || collided > 0) {
    console.error(`[Data] Guild ${guildId} holds, in ${rel || 'its folder'}, ${refused.length} key(s) a write is refused for and ${collided} key(s) whose name collides with another stored key (first: ${firsts.join(', ')}). They read and delete as stored; a write to a refused key is refused, and a colliding key takes writes under its own spelling; tell the module's author`);
  }
}

/** Lists a folder and every folder below it; a walked folder that holds no key is removed when it can be. */
function walkFolder(guildId: string, view: GuildView, rel: string, remove = true): void {
  listFolder(guildId, view, rel);
  const subs = view.listed.get(rel)!;
  for (const spellings of [...subs.values()]) {
    for (const [name, sub] of [...spellings]) {
      walkFolder(guildId, view, relJoin(rel, name), remove);
      sub.walked = true;
    }
  }
  if (remove && rel && !view.tree.hasFolder(rel)) removeKeylessFolder(guildId, view, rel);
}

/** Reads what P's answer for key depends on: the folders along its path, and the folders that match one of its parts under the fold. */
function readPath(guildId: string, view: GuildView, key: string, remove = true): void {
  const segs = key.split('/');
  let cur = '';
  for (let i = 0; i < segs.length; i++) {
    if (!view.listed.has(cur)) listFolder(guildId, view, cur);
    const subs = view.listed.get(cur);
    if (!subs) return;
    const next = segs[i];
    const last = i === segs.length - 1;
    const matching = subs.get(fold(next));
    if (matching) {
      for (const [name, sub] of [...matching]) {
        if (sub.walked || (!last && name === next)) continue;
        walkFolder(guildId, view, relJoin(cur, name), remove);
        sub.walked = true;
      }
    }
    if (last || !view.listed.get(cur)?.get(fold(next))?.has(next)) return;
    cur = relJoin(cur, next);
  }
}

/** A key the tree lacks along key's path, as lstat shows it: something written by another process since the read. */
function lacksEntry(guildId: string, view: GuildView, key: string): boolean {
  for (const rel of [...foldersOfKey(key), key]) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absOf(guildId, rel));
    } catch {
      return false;
    }
    if (stat.isDirectory()) {
      const recorded = view.listed.get(parentOf(rel))?.has(fold(nameOf(rel))) ?? false;
      if (!recorded && !view.tree.hasFoldedFolder(rel)) return true;
    } else if (!view.tree.hasFoldedKey(rel)) {
      return true;
    }
  }
  return false;
}

/** Reads key's path again with the folders along it taken as not listed yet. */
function rereadPath(guildId: string, view: GuildView, key: string): void {
  view.listed.delete('');
  for (const folder of foldersOfKey(key)) view.listed.delete(folder);
  readPath(guildId, view, key);
}

/** Whether the colliding entry is on disk under its stored spelling (or queued as a write here). */
function onDisk(guildId: string, entry: string, kind: 'file' | 'folder'): boolean {
  const op = pendingOps.get(absOf(guildId, entry))?.op;
  if (kind === 'file' && op !== undefined && op !== 'delete') return true;
  if (kind === 'file' && op === 'delete') return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absOf(guildId, parentOf(entry)), { withFileTypes: true });
  } catch {
    return false;
  }
  const found = entries.find(e => e.name === nameOf(entry));
  if (!found) return false;
  return kind === 'folder' ? found.isDirectory() : !found.isDirectory();
}

const TMP_PID = /\.(\d+)\.\d+(?:\.\d+)?\.tmp$/;

/** A temp file no write in progress can own: this process's and not open here, or older than an hour. */
function tempFileRemovable(abs: string): boolean {
  const pid = TMP_PID.exec(path.basename(abs))?.[1];
  if (pid !== undefined && Number(pid) === process.pid && !openTemps.has(abs)) return true;
  try {
    return fs.statSync(abs).mtimeMs < Date.now() - ORPHAN_TMP_MAX_AGE_MS;
  } catch {
    return true;
  }
}

function removeFolderTree(abs: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const child = path.join(abs, entry.name);
    if (entry.isDirectory()) removeFolderTree(child);
    else if (entry.name.endsWith('.tmp') && tempFileRemovable(child)) fs.unlinkSync(child);
    else throw Object.assign(new Error(`${child} is in the way`), { code: 'ENOTEMPTY' });
  }
  fs.rmdirSync(abs);
}

function forgetFolder(view: GuildView | undefined, rel: string): void {
  if (!view) return;
  for (const listed of [...view.listed.keys()]) if (listed === rel || listed.startsWith(`${rel}/`)) view.listed.delete(listed);
  const spellings = view.listed.get(parentOf(rel))?.get(fold(nameOf(rel)));
  spellings?.delete(nameOf(rel));
  if (spellings?.size === 0) view.listed.get(parentOf(rel))?.delete(fold(nameOf(rel)));
}

/** Removes a folder that holds no key, with the temp files in it no write in progress owns; false when it stays. */
function removeKeylessFolder(guildId: string, view: GuildView, rel: string): boolean {
  try {
    removeFolderTree(absOf(guildId, rel));
  } catch {
    return false;
  }
  forgetFolder(view, rel);
  return true;
}

/** Whether a queued delete of d stands in the way of a write of key. */
function deleteInTheWay(d: string, key: string): boolean {
  if (d === key) return false;
  const fd = fold(d);
  const fk = fold(key);
  if (fd === fk || fd.startsWith(`${fk}/`)) return true;
  for (const folder of foldersOfKey(key)) {
    const ff = fold(folder);
    if (fd === ff) return true;
    if (fd.startsWith(`${ff}/`) && d.slice(0, folder.length) !== folder) return true;
  }
  return false;
}

/** The recorded folders in key's way: k itself, or a case alias of k or of one of its folders. */
function foldersInTheWay(view: GuildView, key: string): string[] {
  const segs = key.split('/');
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < segs.length; i++) {
    const last = i === segs.length - 1;
    const matching = view.listed.get(cur)?.get(fold(segs[i]));
    if (matching && (last || !matching.has(segs[i]))) {
      for (const name of matching.keys()) {
        const folder = relJoin(cur, name);
        if (!view.tree.hasFolder(folder)) out.push(folder);
      }
    }
    if (last || !matching?.has(segs[i])) break;
    cur = relJoin(cur, segs[i]);
  }
  return out;
}

/**
 * Rule P for a save or append of key (path form, relative to the guild folder) on the file route: refused
 * 'unstorable' for a collision on disk or in this process's queue, 'io' while a delete in its way is queued or a
 * folder in its way that holds no key cannot be removed.
 */
export function placeGuildWrite(guildId: string, key: string): Placement {
  let view = viewOf(guildId);
  readPath(guildId, view, key);
  if (viewCache && !view.tree.has(key) && lacksEntry(guildId, view, key)) rereadPath(guildId, view, key);
  let collision = view.tree.check(key);
  if (collision && viewCache && !onDisk(guildId, collision.entry, collision.entryKind)) {
    views.delete(guildId);
    view = viewOf(guildId);
    readPath(guildId, view, key);
    collision = view.tree.check(key);
  }
  if (collision) return { ok: false, cause: 'unstorable', reason: collision.reason };
  for (const [d, op] of queuedOf(guildId)) {
    if (op === 'delete' && deleteInTheWay(d, key)) return { ok: false, cause: 'io', reason: `a delete of ${d} is still being written` };
  }
  let blocked = foldersInTheWay(view, key).find(folder => !removeKeylessFolder(guildId, view, folder));
  if (blocked === undefined) return { ok: true };
  // Another process may have written into the folder since this view listed it.
  views.delete(guildId);
  const fresh = viewOf(guildId);
  readPath(guildId, fresh, key);
  const found = fresh.tree.check(key);
  if (found) return { ok: false, cause: 'unstorable', reason: found.reason };
  blocked = foldersInTheWay(fresh, key).find(folder => !removeKeylessFolder(guildId, fresh, folder));
  if (blocked === undefined) return { ok: true };
  return { ok: false, cause: 'io', reason: `the folder ${blocked} holds no data but could not be removed` };
}

/** Rule P without touching the disk, for a check outside the writer: a keyless folder in the way passes. */
export function guildWriteCollision(guildId: string, key: string): string | null {
  const view = freshView(guildId);
  readPath(guildId, view, key, false);
  return view.tree.check(key)?.reason ?? null;
}

/** An accepted write of key: the bot's view holds it from now on. */
export function noteGuildWrite(guildId: string, key: string): void {
  const view = viewCache ? views.get(guildId) : undefined;
  if (!view) return;
  view.tree.add(key);
  for (const folder of foldersOfKey(key)) {
    const subs = view.listed.get(parentOf(folder));
    if (!subs) continue;
    const f = fold(nameOf(folder));
    let spellings = subs.get(f);
    if (!spellings) {
      spellings = new Map();
      subs.set(f, spellings);
    }
    if (!spellings.has(nameOf(folder))) spellings.set(nameOf(folder), { walked: true });
  }
}

/** Whether key is stored under this exact spelling, every part included (a delete's test on the file route). */
export function guildKeyStored(guildId: string, key: string): boolean {
  const view = viewOf(guildId);
  readPath(guildId, view, key);
  if (view.tree.has(key)) return true;
  if (viewCache && lacksEntry(guildId, view, key)) rereadPath(guildId, view, key);
  return view.tree.has(key);
}

/** An accepted delete of key: the bot's view drops it at once. */
export function noteGuildDelete(guildId: string, key: string): void {
  views.get(guildId)?.tree.remove(key);
}

/** After a delete landed on a guild path: each folder it emptied is removed, up to the guild folder. */
async function removeEmptiedFolders(absPath: string): Promise<void> {
  const rel = path.relative(BASE_DATA_DIR, absPath);
  const parts = rel.split(path.sep);
  if (parts.length < 3 || !/^\d+$/.test(parts[0])) return;
  const guildId = parts[0];
  const root = guildRoot(guildId);
  let dir = path.dirname(absPath);
  while (dir !== root && dir.startsWith(root + path.sep)) {
    try {
      await fs.promises.rmdir(dir);
    } catch (error: any) {
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'ENOENT' && error?.code !== 'EEXIST') {
        console.error(`[DataManager] Could not remove the emptied folder ${dir}; it stays empty:`, error?.code ?? error);
      }
      return;
    }
    forgetFolder(views.get(guildId), path.relative(root, dir).split(path.sep).join('/'));
    dir = path.dirname(dir);
  }
}
