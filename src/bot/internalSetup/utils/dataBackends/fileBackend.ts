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
}
const landingRecords = new Map<string, LandingRecord>();
/** Landing records whose queued op a deposition cancelled: their tickets are known not saved. */
const droppedAtDeposition = new WeakSet<LandingRecord>();

export function droppedByDeposition(record: LandingRecord): boolean {
  return droppedAtDeposition.has(record);
}

// The landed op's tickets hold the record its path had when the flush began,
// which a drop may have retired since, or else one a ticket made meanwhile.
function noteLanded(absPath: string, atStart: LandingRecord | undefined, seq: number): void {
  const record = atStart ?? landingRecords.get(absPath);
  if (record && seq > record.landed) record.landed = seq;
}

/** Landing records held for ticketed paths with an op still queued. */
export function fileLandingRecords(): number {
  return landingRecords.size;
}
// A failed flush is tried again on its own, backing off to a minute, so a
// write held through a disk fault lands once the disk takes it.
const retryAttempts = new Map<string, number>();
const retryTimers = new Map<string, NodeJS.Timeout>();
/** The errno of each path's last failed flush, until one lands. */
const lastFlushErrno = new Map<string, string>();
/** Paths this process knows end with a newline: an append of its own landed there since its last writer lock take. */
const newlineTails = new Set<string>();
const NEWLINE = String.fromCharCode(10);

/** Forgets every path's known tail (another writer may have cut a line since). */
export function forgetAppendTails(): void {
  newlineTails.clear();
}

async function lastByteIsNewline(absPath: string): Promise<boolean> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(absPath, 'r');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    await fh.close();
  }
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

async function atomicReplace(target: string, content: string): Promise<void> {
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
  // POSIX best-effort parent-dir fsync so the rename itself is durable.
  if (!IS_WINDOWS) {
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
    failingCode.delete(absPath);
    return false;
  }
  flushing.add(absPath);
  const record = landingRecords.get(absPath);
  try {
    const seqAtStart = entry.seq;
    try {
      if (entry.op === 'write') {
        await atomicReplace(absPath, entry.content);
      } else if (entry.op === 'delete') {
        try {
          await fs.promises.unlink(absPath);
        } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error;
        }
        await removeEmptiedFolders(absPath);
      } else {
        // append: a torn tail line on crash is tolerated (readers skip bad lines).
        // appendFile is cumulative (unlike an idempotent write overwrite), so we
        // must trim ONLY the bytes we persisted, never re-append them.
        await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
        const flushed = entry.content; // snapshot before the await
        const flushedSeq = entry.seq;
        const lead = newlineTails.has(absPath) || await lastByteIsNewline(absPath) ? '' : NEWLINE;
        newlineTails.delete(absPath);
        await fs.promises.appendFile(absPath, lead + flushed, 'utf-8');
        if (flushed.endsWith(NEWLINE)) newlineTails.add(absPath);
        lastFlushErrno.delete(absPath);
        noteLanded(absPath, record, flushedSeq);
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
        flushesLanded += 1;
        lastLandedAt = performance.now();
        retryAttempts.delete(absPath);
        failingSince.delete(absPath);
        failingCode.delete(absPath);
        return true; // bypass the generic seq-drop below (only correct for write/delete)
      }
    } catch (error) {
      newlineTails.delete(absPath);
      lastFlushErrno.set(absPath, String((error as { code?: unknown } | null)?.code ?? 'EIO'));
      flushFailures += 1;
      if (!failingSince.has(absPath)) failingSince.set(absPath, performance.now());
      failingCode.set(absPath, String((error as { code?: unknown } | null)?.code ?? 'EIO'));
      console.error(`[DataManager] Flush failed for ${absPath} (will retry):`, error);
      scheduleRetry(absPath);
      return false; // keep the pending entry + tmp file; the retry, the next write or flushAll tries again
    }
    flushesLanded += 1;
    lastLandedAt = performance.now();
    retryAttempts.delete(absPath);
    failingSince.delete(absPath);
    failingCode.delete(absPath);
    lastFlushErrno.delete(absPath);
    newlineTails.delete(absPath);
    noteLanded(absPath, record, seqAtStart);
    // Drop the entry only if no newer op arrived while we were flushing.
    const current = pendingOps.get(absPath);
    if (current && current.seq === seqAtStart) {
      pendingOps.delete(absPath);
      landingRecords.delete(absPath);
    } else if (current) {
      scheduleFlush(absPath);
    }
    return true;
  } finally {
    flushing.delete(absPath);
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

export type CancelOutcome = { path: string; outcome: 'landed' } | { path: string; outcome: 'cancelled'; errno: string | null };

/**
 * Drops these paths' queued ops: waits until no flush of them is on the wire, then answers per path 'landed' when its
 * last op landed meanwhile, or 'cancelled' once it deleted the pending entry and cleared its retry, with the errno of
 * the path's last failed flush. With freeze (a deposition), no new flush of these paths starts from the call on: a
 * path not on the wire is cancelled at once, and one on the wire is awaited and then cancelled or answered landed.
 */
export async function cancelQueued(paths: string[], sleep: (ms: number) => Promise<void> = delay, options: { freeze?: boolean } = {}): Promise<CancelOutcome[]> {
  const targets = new Map(paths.map(p => [p, pendingOps.get(p)?.seq]));
  // Each target's landing record from the start: an entry gone at the cancel landed only if the record reached its seq.
  const records = new Map<string, LandingRecord>();
  for (const p of paths) {
    if (!pendingOps.has(p)) continue;
    let record = landingRecords.get(p);
    if (!record) {
      record = { landed: 0 };
      landingRecords.set(p, record);
    }
    records.set(p, record);
  }
  const cancel = (p: string): CancelOutcome => {
    const entry = pendingOps.get(p);
    const seq = targets.get(p);
    if (seq === undefined) return { path: p, outcome: 'landed' };
    if (!entry) return (records.get(p)?.landed ?? 0) >= seq ? { path: p, outcome: 'landed' } : { path: p, outcome: 'cancelled', errno: null };
    const errno = lastFlushErrno.get(p) ?? null;
    pendingOps.delete(p);
    const record = landingRecords.get(p);
    if (options.freeze && record) droppedAtDeposition.add(record);
    landingRecords.delete(p);
    clearRetry(p);
    lastFlushErrno.delete(p);
    return { path: p, outcome: 'cancelled', errno };
  };
  const early = new Map<string, CancelOutcome>();
  const held = options.freeze ? paths.filter(p => !frozen.has(p)) : [];
  if (options.freeze) {
    for (const p of held) frozen.add(p);
    for (const p of paths) if (!flushing.has(p)) early.set(p, cancel(p));
  }
  try {
    while (paths.some(p => flushing.has(p))) await sleep(5);
    return paths.map(p => early.get(p) ?? cancel(p));
  } finally {
    for (const p of held) frozen.delete(p);
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

/** Best-effort fsync of /data and /data/_graveyard on POSIX, so a rename between them survives a power cut. */
export async function fsyncDataDirs(): Promise<void> {
  if (IS_WINDOWS) return;
  for (const dir of [BASE_DATA_DIR, path.join(BASE_DATA_DIR, GRAVEYARD_DIR)]) {
    try {
      const dh = await fs.promises.open(dir, 'r');
      try { await dh.sync(); } finally { await dh.close(); }
    } catch { /* directory fsync is best-effort */ }
  }
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
  newlineTails.delete(absPath);
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
  newlineTails.delete(absPath);
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
  let record = landingRecords.get(absPath);
  if (!record) {
    record = { landed: 0 };
    landingRecords.set(absPath, record);
  }
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
    if (ticket.record.landed >= ticket.seq) return 'ok';
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
  const dest = path.join(graveyardRoot, `${guildId}-${Date.now()}`);

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

const NOTE_FILE = '.graveyard.json';
const SWEEP_PREFIX = '.sweep-';

export type FileRestoreOutcome =
  | { ok: true; retiredAt: number; reason: string }
  | { ok: false; why: 'no-entry' }
  | { ok: false; why: 'live'; retiredAt: number }
  | { ok: false; why: 'stopped'; stop: RestoreStop }
  | { ok: false; why: 'writer-lost' }
  | { ok: false; why: 'note' | 'rename'; code: string; step?: 'read' };

export interface FileRestoreHooks {
  /** The maintenance gate, the exit drain or the deadline, read after the lookup and before each rename try. */
  stop: () => RestoreStop | null;
  writerLost: () => boolean;
  /** Set once the rename into place returned. */
  progress: { renamed: boolean };
}

const errnoOf = (error: unknown): string => String((error as { code?: unknown } | null)?.code ?? 'EIO');

/**
 * Renames a _graveyard entry back to /data/{guildId} (the given retiredAt, else the newest). Refused while the guild
 * folder exists or an op under it is queued or on the wire. The note leaves the entry first, so a crash never leaves
 * it in a live folder; every refusal after its removal writes it back, except when the entry is gone.
 */
export async function restoreGuildDirFromGraveyard(guildId: string, retiredAt: number | undefined, hooks: FileRestoreHooks): Promise<FileRestoreOutcome> {
  try {
    return await restoreGuildDir(guildId, retiredAt, hooks);
  } finally {
    dropGuildView(guildId);
  }
}

async function restoreGuildDir(guildId: string, retiredAt: number | undefined, hooks: FileRestoreHooks): Promise<FileRestoreOutcome> {
  const graveyardRoot = path.join(BASE_DATA_DIR, GRAVEYARD_DIR);
  let entry: { name: string; retiredAt: number } | null = null;
  if (retiredAt !== undefined) {
    const name = `${guildId}-${retiredAt}`;
    if (fs.existsSync(path.join(graveyardRoot, name))) entry = { name, retiredAt };
  } else {
    const newest = (await listGraveyardEntries()).find(e => e.guildId === guildId);
    if (newest) entry = { name: `${guildId}-${newest.retiredAt}`, retiredAt: newest.retiredAt };
  }
  if (!entry) return { ok: false, why: 'no-entry' };
  if (guildDirExists(guildId) || guildHasQueuedOps(guildId)) return { ok: false, why: 'live', retiredAt: entry.retiredAt };
  const early = hooks.stop();
  if (early) return { ok: false, why: 'stopped', stop: early };

  const entryPath = path.join(graveyardRoot, entry.name);
  const notePath = path.join(entryPath, NOTE_FILE);
  let note: string | null = null;
  try {
    note = await fs.promises.readFile(notePath, 'utf-8');
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') {
      console.error(`[DataManager] Cannot restore guild ${guildId}: the note of graveyard entry ${entry.name} could not be read:`, error);
      return { ok: false, why: 'note', code: errnoOf(error), step: 'read' };
    }
  }
  let reason = '';
  try {
    const parsed = note === null ? null : (JSON.parse(note) as { reason?: unknown } | null);
    if (typeof parsed?.reason === 'string') reason = parsed.reason;
  } catch { /* an unreadable note gives no reason */ }
  const beforeUnlink = hooks.stop();
  if (beforeUnlink) return { ok: false, why: 'stopped', stop: beforeUnlink };
  if (hooks.writerLost()) {
    console.error(`[DataManager] Cannot restore guild ${guildId} from the graveyard: another process took the data files`);
    return { ok: false, why: 'writer-lost' };
  }
  try {
    await fs.promises.unlink(notePath);
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') {
      console.error(`[DataManager] Cannot restore guild ${guildId}: the note of graveyard entry ${entry.name} could not be removed:`, error);
      return { ok: false, why: 'note', code: errnoOf(error) };
    }
  }
  const putNoteBack = async () => {
    if (note === null) return;
    try {
      await fs.promises.writeFile(notePath, note, 'utf-8');
    } catch (error) {
      console.warn(`[DataManager] Failed to write back the note of graveyard entry ${entry!.name}:`, error);
    }
  };

  const dest = path.join(BASE_DATA_DIR, guildId);
  for (let attempt = 0; ; attempt++) {
    const stop = hooks.stop();
    if (stop) {
      await putNoteBack();
      return { ok: false, why: 'stopped', stop };
    }
    if (hooks.writerLost()) {
      console.error(`[DataManager] Cannot restore guild ${guildId} from the graveyard: another process took the data files`);
      await putNoteBack();
      return { ok: false, why: 'writer-lost' };
    }
    try {
      await fs.promises.rename(entryPath, dest);
      dropGuildView(guildId);
      break;
    } catch (error) {
      dropGuildView(guildId);
      const code = errnoOf(error);
      if (code === 'ENOENT') return { ok: false, why: 'no-entry' };
      if (attempt >= 9) {
        console.error(`[DataManager] Failed to move graveyard entry ${entry.name} back:`, error);
        await putNoteBack();
        return { ok: false, why: 'rename', code };
      }
      await delay(25 * (attempt + 1));
    }
  }
  hooks.progress.renamed = true;
  await fsyncDataDirs();
  console.warn(`[DataManager] Guild ${guildId} restored from graveyard entry ${entry.name}`);
  return { ok: true, retiredAt: entry.retiredAt, reason };
}

/**
 * Delete graveyard entries older than the TTL (default 14 days). An expired entry is renamed out of the listed names
 * (.sweep-<name>) before anything in it is removed, so a failed removal never leaves a partial entry a restore finds;
 * every .sweep- folder is removed at the next run. skip: a guild whose restore runs keeps its entries.
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
  const remove = async (name: string) => {
    try {
      await fs.promises.rm(path.join(graveyardRoot, name), { recursive: true, force: true });
      return true;
    } catch (error) {
      console.warn(`[DataManager] Failed to remove swept graveyard folder ${name} (removed at the next sweep):`, error);
      return false;
    }
  };
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(SWEEP_PREFIX)) {
      await remove(entry.name);
      continue;
    }
    const full = path.join(graveyardRoot, entry.name);
    // Timestamp is the trailing -{ms} suffix; fall back to mtime if absent.
    const dashIdx = entry.name.lastIndexOf('-');
    let ts = dashIdx >= 0 ? Number(entry.name.slice(dashIdx + 1)) : NaN;
    if (!Number.isFinite(ts)) {
      try { ts = (await fs.promises.stat(full)).mtimeMs; } catch { continue; }
    }
    if (ts >= cutoff) continue;
    if (dashIdx > 0 && skip(entry.name.slice(0, dashIdx))) continue;
    const aside = `${SWEEP_PREFIX}${entry.name}`;
    try {
      await fs.promises.rename(full, path.join(graveyardRoot, aside));
    } catch (error) {
      console.warn(`[DataManager] Failed to sweep graveyard entry ${entry.name} (tried again at the next sweep):`, error);
      continue;
    }
    if (await remove(aside)) console.log(`[DataManager] Swept expired graveyard entry: ${entry.name}`);
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
