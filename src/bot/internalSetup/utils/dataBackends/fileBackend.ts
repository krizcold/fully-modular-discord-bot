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
const pendingOps = new Map<string, PendingOp>();
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

interface ReplacedTry {
  from: number;
  through: number;
  errno: string;
  lines: number;
}

export interface FailedRange {
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
/** Paths with appended lines whose sync the disk did not confirm, until a delete or whole write of the path lands. */
const unconfirmedPaths = new Set<string>();

/**
 * Files holding appended lines the disk did not confirm (NB13 decision 8), and appends queued empty: a short write
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

/** Forgets every durable name: another holder of the writer lock may have replaced any file since. */
export function forgetDurableFiles(): void {
  durableFiles.clear();
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

/** Why a ticket is 'unconfirmed': the errno and whether a cut try left it; null when no failed range holds it. */
export function fileTicketFailure(ticket: FileTicket): { errno: string | null; cut: boolean } | null {
  const range = failedRangeOf(ticket);
  return range ? { errno: range.errno, cut: range.cut } : null;
}

/** Adds the parts of from..through no failed range of the record covers yet; answers whether it added any. */
function addFailedRange(record: LandingRecord, from: number, through: number, errno: string | null, cut: boolean): boolean {
  const ranges = (record.failed ??= []);
  let added = false;
  let start = from;
  for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
    if (range.through < start) continue;
    if (range.from > through) break;
    if (range.from > start) { ranges.push({ from: start, through: range.from - 1, errno, cut }); added = true; }
    start = Math.max(start, range.through + 1);
  }
  if (start <= through) { ranges.push({ from: start, through, errno, cut }); added = true; }
  return added;
}

const errnoOf = (error: unknown): string => String((error as { code?: unknown } | null)?.code ?? 'EIO');
const closeCodeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === undefined || code === null ? 'no error code' : String(code);
};
const SKIPPED_DIR_OPEN = new Set(['EISDIR', 'EPERM', 'EACCES']);
const SKIPPED_DIR_SYNC = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);

/**
 * fsyncs each directory from the file's own up to DATA_ROOT (POSIX; Windows skips directories, as atomicReplace
 * does), so the file's name and every directory made for it are durable. Only an unsupported operation is skipped;
 * the first other error is answered. Each handle is closed in its own finally, and a close error changes no answer.
 */
async function syncDirectoryChain(absPath: string): Promise<{ failed: false } | { failed: true; error: unknown }> {
  if (IS_WINDOWS) return { failed: false };
  const root = path.resolve(BASE_DATA_DIR);
  for (let dir = path.dirname(path.resolve(absPath)); ; dir = path.dirname(dir)) {
    let failure: { failed: true; error: unknown } | null = null;
    let dh: fs.promises.FileHandle | null = null;
    try {
      dh = await fs.promises.open(dir, 'r');
    } catch (error) {
      if (!SKIPPED_DIR_OPEN.has(errnoOf(error))) return { failed: true, error };
    }
    if (dh) {
      try {
        await dh.sync();
      } catch (error) {
        if (!SKIPPED_DIR_SYNC.has(errnoOf(error))) failure = { failed: true, error };
      } finally {
        try { await dh.close(); } catch (error) { console.error(`[Data] ${dir}: the directory could not be closed after its sync (${closeCodeOf(error)}); this changes nothing about the lines already reported for the files in it`); }
      }
    }
    if (failure) return failure;
    const rel = path.relative(root, dir);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || dir === path.dirname(dir)) return { failed: false };
  }
}

/** Lines of text, counted by their newlines (a last line with none counts too). */
const lineCount = (text: string): number => text.split('\n').filter((line, i, all) => line !== '' || i < all.length - 1).length;

function logUnconfirmed(absPath: string, lines: number, errno: string): void {
  console.error(`[Data] ${absPath}: the disk did not confirm the sync of ${lines} appended line(s) (${errno}); they are in the file and are not written again; can't confirm they are stored`);
}

/** Turns the record's replaced tries into failed ranges; answers the last one's errno, or null when it held none. */
function failReplacedTries(record: LandingRecord, absPath: string): string | null {
  const tries = record.replaced ?? [];
  record.replaced = [];
  replacedTries.delete(record);
  if (tries.length === 0) return null;
  for (const t of tries) {
    addFailedRange(record, t.from, t.through, t.errno, false);
    logUnconfirmed(absPath, t.lines, t.errno);
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
}

const IS_WINDOWS = process.platform === 'win32';

async function atomicReplace(target: string, content: string, options: { parentSync?: boolean } = {}): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = tmpNameFor(target);
  const fh = await fs.promises.open(tmp, 'w');
  try {
    await fh.writeFile(content, 'utf-8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  // Windows can throw EPERM on rename-over-existing while a reader (e.g. the
  // webui parent) holds the target open; retry with a short backoff. NEVER
  // fall back to a direct overwrite - that reintroduces the torn-file window
  // the temp+fsync+rename exists to eliminate. On exhaustion the tmp file is
  // left in place and the caller keeps the pending entry to retry later.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(tmp, target);
      break;
    } catch (error) {
      if (attempt >= 9) throw error;
      await delay(25 * (attempt + 1));
    }
  }
  // POSIX best-effort parent-dir fsync so the rename itself is durable.
  if (!IS_WINDOWS && options.parentSync !== false) {
    try {
      const dh = await fs.promises.open(path.dirname(target), 'r');
      try { await dh.sync(); } finally { await dh.close(); }
    } catch { /* directory fsync is best-effort */ }
  }
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
    return false;
  }
  flushing.add(absPath);
  let record = landingRecords.get(absPath);
  // Every try of a stream has a record, so a cancel can read what it left in the file.
  if (!record && (entry.op === 'append' || absPath.endsWith('.jsonl'))) record = startRecord(absPath);
  if (record) tryRecords.set(absPath, record);
  try {
    const seqAtStart = entry.seq;
    if (entry.op === 'append') return await flushAppend(absPath, entry, record!);
    const wholeStream = entry.op === 'write' && absPath.endsWith('.jsonl');
    let chain: Awaited<ReturnType<typeof syncDirectoryChain>> = { failed: false };
    try {
      if (entry.op === 'write') {
        await atomicReplace(absPath, entry.content, wholeStream ? { parentSync: false } : {});
        if (wholeStream) {
          durableFiles.delete(absPath);
          chain = await syncDirectoryChain(absPath);
        }
      } else {
        try {
          await fs.promises.unlink(absPath);
        } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    } catch (error) {
      lastFlushErrno.set(absPath, errnoOf(error));
      flushFailures += 1;
      if (!failingSince.has(absPath)) failingSince.set(absPath, performance.now());
      console.error(`[DataManager] Flush failed for ${absPath} (will retry):`, error);
      scheduleRetry(absPath);
      return false; // keep the pending entry + tmp file; the retry, the next write or flushAll tries again
    }
    retryAttempts.delete(absPath);
    failingSince.delete(absPath);
    // A newer op replaced the entry during the try: it holds every line of this write, or deletes them, and answers for them.
    const current = pendingOps.get(absPath);
    const replaced = current !== undefined && current.seq !== seqAtStart;
    if (chain.failed) {
      // The whole write of a stream is in the file, but its name's sync failed: never written again, can't confirm.
      const errno = errnoOf(chain.error);
      lastFlushErrno.set(absPath, errno);
      const lines = entry.op === 'write' ? lineCount(entry.content) : 0;
      if (!replaced) {
        if (record) {
          addFailedRange(record, record.landed + 1, seqAtStart, errno, false);
          dropReplacedTries(record, seqAtStart);
        }
        unconfirmedPaths.add(absPath);
        logUnconfirmed(absPath, lines, errno);
      } else if (record) {
        (record.replaced ??= []).push({ from: record.landed + 1, through: seqAtStart, errno, lines });
        replacedTries.set(record, absPath);
      }
    } else {
      flushesLanded += 1;
      lastLandedAt = performance.now();
      lastFlushErrno.delete(absPath);
      noteLanded(absPath, record, seqAtStart, true);
      if (entry.op === 'delete' || wholeStream) unconfirmedPaths.delete(absPath);
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
        if (!skipChain) {
          const chain = await syncDirectoryChain(absPath);
          if (chain.failed) {
            syncFailed = true;
            syncFailure = chain.error;
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
    console.error(`[DataManager] Flush failed for ${absPath} (will retry):`, failure);
    scheduleRetry(absPath);
    return false;
  }

  retryAttempts.delete(absPath);
  failingSince.delete(absPath);
  if (syncFailed) {
    const errno = errnoOf(syncFailure);
    durableFiles.delete(absPath);
    lastFlushErrno.set(absPath, errno);
    addFailedRange(record, landedAtStart + 1, flushedSeq, errno, false);
    dropReplacedTries(record, flushedSeq);
    unconfirmedPaths.add(absPath);
    logUnconfirmed(absPath, lineCount(flushed), errno);
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

export type CancelOutcome =
  | { path: string; outcome: 'landed' }
  | { path: string; outcome: 'cancelled'; errno: string | null }
  | { path: string; outcome: 'unconfirmed'; errno: string | null; cut: boolean };

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
    return { path: p, outcome: 'unconfirmed', errno: range.errno, cut: range.cut };
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
      if ((record.wrote ?? 0) > record.landed) addFailedRange(record, record.landed + 1, record.wrote ?? 0, flushErrno, true);
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
  let stuckAttempts = 0;
  for (;;) {
    const state = fileTicketState(ticket);
    if (state === 'unconfirmed') return 'unavailable';
    if (state === 'landed') return 'ok';
    // Its record retired without reaching it, or nothing queued: it was dropped.
    if (landingRecords.get(ticket.path) !== ticket.record || !pendingOps.has(ticket.path)) return 'unavailable';
    const left = deadline - performance.now();
    if (left <= 0) return 'pending';
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
    if (landed === 'timeout') return 'pending';
    if (landed) continue;
    const after = pendingOps.get(ticket.path);
    if (!after) continue;
    if (after.seq !== before) {
      stuckAttempts = 0; // a newer op arrived: progress
      continue;
    }
    if (++stuckAttempts >= 3) return 'held';
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
 */
export function readRawStrict(absPath: string): string | null {
  const pending = pendingOps.get(absPath);
  if (pending?.op === 'delete') return null;
  if (pending?.op === 'write') return pending.content;
  try {
    return fs.readFileSync(absPath, 'utf-8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
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
 * Rename /data/{guildId} under _graveyard and write a .graveyard.json reason
 * marker inside. The facade drains and drops pending state first.
 */
export async function graveyardGuildDir(guildId: string, reason: string, writerLost: () => boolean = () => false): Promise<boolean> {
  const src = path.join(BASE_DATA_DIR, guildId);
  // A retry on the wire when the guild's writes were dropped would re-create
  // the dir beside its graveyard copy: it settles first (bounded).
  const deadline = Date.now() + 5000;
  while ([...flushing].some(p => p === src || p.startsWith(src + path.sep)) && Date.now() < deadline) await delay(5);
  const graveyardRoot = path.join(BASE_DATA_DIR, GRAVEYARD_DIR);
  await fs.promises.mkdir(graveyardRoot, { recursive: true });
  const dest = path.join(graveyardRoot, `${guildId}-${Date.now()}`);

  for (let attempt = 0; ; attempt++) {
    if (writerLost()) {
      console.error(`[DataManager] Cannot move ${guildId} to graveyard: another process took the data files; nothing was removed`);
      return false;
    }
    try {
      await fs.promises.rename(src, dest);
      break;
    } catch (error) {
      if (attempt >= 9) {
        console.error(`[DataManager] Failed to move ${guildId} to graveyard:`, error);
        return false;
      }
      await delay(25 * (attempt + 1));
    }
  }

  const marker = { guildId, reason, ts: Date.now() };
  try {
    await fs.promises.writeFile(path.join(dest, '.graveyard.json'), JSON.stringify(marker, null, 2), 'utf-8');
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

/** Enumerate _graveyard entries ({guildId}-{ms} dirs), newest first. */
export async function listGraveyardEntries(): Promise<FileGraveyardEntry[]> {
  const graveyardRoot = path.join(BASE_DATA_DIR, GRAVEYARD_DIR);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(graveyardRoot, { withFileTypes: true });
  } catch {
    return []; // no graveyard yet
  }
  const out: FileGraveyardEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dashIdx = entry.name.lastIndexOf('-');
    if (dashIdx <= 0) continue;
    const guildId = entry.name.slice(0, dashIdx);
    const retiredAt = Number(entry.name.slice(dashIdx + 1));
    if (!/^\d+$/.test(guildId) || !Number.isFinite(retiredAt)) continue;
    let reason = '';
    try {
      const raw = await fs.promises.readFile(path.join(graveyardRoot, entry.name, '.graveyard.json'), 'utf-8');
      const marker = JSON.parse(raw) as { reason?: unknown };
      if (typeof marker?.reason === 'string') reason = marker.reason;
    } catch { /* marker is best-effort */ }
    out.push({ guildId, retiredAt, reason });
  }
  out.sort((a, b) => b.retiredAt - a.retiredAt);
  return out;
}

/**
 * Rename a _graveyard entry back to /data/{guildId}. Refuses when a live guild
 * dir exists or no matching entry is found (returned as {ok:false}); an actual
 * rename failure throws so callers can tell refusal from IO error.
 */
export async function restoreGuildDirFromGraveyard(guildId: string, retiredAt?: number, writerLost: () => boolean = () => false, lostText = 'another process took the data files; nothing was restored'): Promise<{ ok: boolean; error?: string }> {
  if (guildDirExists(guildId)) {
    return { ok: false, error: 'live guild data exists; delete it before restoring' };
  }
  const graveyardRoot = path.join(BASE_DATA_DIR, GRAVEYARD_DIR);
  let entryName: string | null = null;
  if (retiredAt !== undefined) {
    const candidate = `${guildId}-${retiredAt}`;
    if (fs.existsSync(path.join(graveyardRoot, candidate))) entryName = candidate;
  } else {
    const newest = (await listGraveyardEntries()).find(e => e.guildId === guildId);
    if (newest) entryName = `${guildId}-${newest.retiredAt}`;
  }
  if (!entryName) return { ok: false, error: 'no graveyard entry for this guild' };
  const dest = path.join(BASE_DATA_DIR, guildId);
  if (writerLost()) {
    console.error(`[DataManager] Cannot restore guild ${guildId} from the graveyard: another process took the data files`);
    return { ok: false, error: lostText };
  }
  await fs.promises.rename(path.join(graveyardRoot, entryName), dest);
  await fs.promises.rm(path.join(dest, '.graveyard.json'), { force: true }).catch(() => { /* marker cleanup is best-effort */ });
  console.warn(`[DataManager] Guild ${guildId} restored from graveyard entry ${entryName}`);
  return { ok: true };
}

/**
 * Delete graveyard entries older than the TTL (default 14 days).
 */
export async function sweepGraveyard(): Promise<void> {
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
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(graveyardRoot, entry.name);
    // Timestamp is the trailing -{ms} suffix; fall back to mtime if absent.
    const dashIdx = entry.name.lastIndexOf('-');
    let ts = dashIdx >= 0 ? Number(entry.name.slice(dashIdx + 1)) : NaN;
    if (!Number.isFinite(ts)) {
      try { ts = (await fs.promises.stat(full)).mtimeMs; } catch { continue; }
    }
    if (ts < cutoff) {
      try {
        await fs.promises.rm(full, { recursive: true, force: true });
        console.log(`[DataManager] Swept expired graveyard entry: ${entry.name}`);
      } catch (error) {
        console.warn(`[DataManager] Failed to sweep graveyard entry ${entry.name}:`, error);
      }
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
