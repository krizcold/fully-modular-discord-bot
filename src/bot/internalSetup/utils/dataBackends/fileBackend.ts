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
let opSeq = 0;
// Per path a ticket was issued for, while an op is queued for it: the seq of
// the last op that landed, so an op at or below it landed itself or was
// followed by one that did. Its tickets hold the record, so it leaves the map
// once nothing is queued for the path, and a later record starts afresh.
export interface LandingRecord {
  landed: number;
}
const landingRecords = new Map<string, LandingRecord>();

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

async function atomicReplace(target: string, content: string): Promise<void> {
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
  if (flushing.has(absPath)) return false;
  const entry = pendingOps.get(absPath);
  if (!entry) {
    failingSince.delete(absPath);
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
      } else {
        // append: a torn tail line on crash is tolerated (readers skip bad lines).
        // appendFile is cumulative (unlike an idempotent write overwrite), so we
        // must trim ONLY the bytes we persisted, never re-append them.
        await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
        const flushed = entry.content; // snapshot before the await
        const flushedSeq = entry.seq;
        await fs.promises.appendFile(absPath, flushed, 'utf-8');
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
        return true; // bypass the generic seq-drop below (only correct for write/delete)
      }
    } catch (error) {
      flushFailures += 1;
      if (!failingSince.has(absPath)) failingSince.set(absPath, performance.now());
      console.error(`[DataManager] Flush failed for ${absPath} (will retry):`, error);
      scheduleRetry(absPath);
      return false; // keep the pending entry + tmp file; the retry, the next write or flushAll tries again
    }
    flushesLanded += 1;
    lastLandedAt = performance.now();
    retryAttempts.delete(absPath);
    failingSince.delete(absPath);
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

/** Files with a write, delete or append still queued; an entry stays until its flush lands. */
export function queuedFileWrites(): number {
  return pendingOps.size;
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
export async function graveyardGuildDir(guildId: string, reason: string): Promise<boolean> {
  const src = path.join(BASE_DATA_DIR, guildId);
  // A retry on the wire when the guild's writes were dropped would re-create
  // the dir beside its graveyard copy: it settles first (bounded).
  const deadline = Date.now() + 5000;
  while ([...flushing].some(p => p === src || p.startsWith(src + path.sep)) && Date.now() < deadline) await delay(5);
  const graveyardRoot = path.join(BASE_DATA_DIR, GRAVEYARD_DIR);
  await fs.promises.mkdir(graveyardRoot, { recursive: true });
  const dest = path.join(graveyardRoot, `${guildId}-${Date.now()}`);

  for (let attempt = 0; ; attempt++) {
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
export async function restoreGuildDirFromGraveyard(guildId: string, retiredAt?: number): Promise<{ ok: boolean; error?: string }> {
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
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
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
