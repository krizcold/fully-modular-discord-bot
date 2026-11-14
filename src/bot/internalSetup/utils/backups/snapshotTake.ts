import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_ROOT, dataPath } from '../../../../utils/dataRoot';
import { atomicWriteFileSync } from '../atomicWrite';
import { containerPath, diskError, syncFile, timeText, type ChainAnswer, type DiskError } from '../folderChain';
import { dataOpsInFlight, dirEpoch, flushingPaths, landClock, landedAt, landedPaths, watchLandings } from '../dataBackends/fileBackend';
import { heldText, readLockText, recreateCount } from '../writerLock';
import { realSeams, type LockSeams } from '../processLock';
import { getAppVersion } from '../../fleet/nodeIdentity';
import { classify, topItems, OWNER_CHANNEL_REL } from './snapshotSet';
import { compareSnapshotNames, parseSnapshotName, parseWorkName, takingFolderName } from './snapshotNames';
import { listSnapshots, snapshotsRoot, type Manifest, type ManifestFile } from './snapshotList';
import { fsyncDirs } from './fsyncDirs';
import { countsOf } from './snapshotVerify';

// NB8 decisions 4, 6, 17, 20, 22, 35 and 39 to 42 (as N5 maps the folder syncs): the take in the process that holds the
// writer lock. Pass 1 copies the set; catch-up rounds recopy what landed; one synchronous turn is the cut.

export const TAKE_CAP_MS = 10 * 60 * 1000;
export const CUT_CATCHUPS = 10;
export const CUT_MAX_FILES = 128;
export const CUT_MAX_BYTES = 64 * 1024 * 1024;
export const LEFTOVER_MS = 15 * 60 * 1000;
export const FREE_MARGIN_BYTES = 256 * 1024 * 1024;

/** Decision 18's bound on the web UI's final op of a take, while it holds the data files. */
export const FINAL_OP_MS = 60_000;

const timing = { capMs: TAKE_CAP_MS, pollMs: 50, maxBytes: CUT_MAX_BYTES, finalMs: FINAL_OP_MS, removeMs: 5000 };
let seams: LockSeams = realSeams;
let beforeTurn: (() => unknown) | null = null;

/** Tests only: the cap, the poll, the turn's byte limit, the staging removal's bound, the process facts, and a step run before each turn. */
export function _setTakeTimingForTests(next: { capMs?: number; pollMs?: number; maxBytes?: number; finalMs?: number; removeMs?: number; beforeTurn?: () => unknown } = {}, nextSeams: LockSeams = realSeams): void {
  timing.capMs = next.capMs ?? TAKE_CAP_MS;
  timing.removeMs = next.removeMs ?? 5000;
  timing.finalMs = next.finalMs ?? FINAL_OP_MS;
  timing.pollMs = next.pollMs ?? 50;
  timing.maxBytes = next.maxBytes ?? CUT_MAX_BYTES;
  beforeTurn = next.beforeTurn ?? null;
  seams = nextSeams;
}

export type Sig = ManifestFile['sig'];
export type TakeKind = 'hourly' | 'daily';

export type TakeAnswer =
  | { ok: true; name: string; counts: Manifest['counts']; linked: number }
  | { ok: false; error: string; cause?: 'writes' }
  | { ok: false; busy: true }
  | { ok: false; stopping: true }
  | { ok: false; exists: true }
  | { ok: false; lockLost: true; words: string }
  | { ok: false; refused: true; words: string; startedAt: number }
  | { ok: false; diskFlag: DiskError };

/** The web UI's side of its local take (decisions 18, 38, 41): BotManager answers these. */
export interface LocalTakeHost {
  /** Where a shared write would go now, read without taking the lock; a refusal carries its words. */
  routeProbe(kind: 'shared'): { route: 'child' } | { route: 'local' } | { route?: undefined; words: string };
  /** Routes the final op as a shared write and runs it in the local chain, or answers why it did not run. */
  queueFinalOp<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: true; error: unknown } | { ran: false; words: string }>;
  isExiting(): boolean;
}

class TakeStop extends Error {
  constructor(readonly answer: TakeAnswer) {
    super('take stopped');
  }
}

const errnoOf = (error: unknown): string => String((error as { code?: unknown } | null)?.code ?? 'EIO');
const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
const fail = (error: string, cause?: 'writes'): never => {
  throw new TakeStop(cause ? { ok: false, error, cause } : { ok: false, error });
};

const NOT_KEPT = 'the backup was not kept.';
const REMOVED = 'the partial copy was removed.';

function readFail(abs: string, error: unknown): never {
  return fail(`Could not read ${containerPath(abs)} (${errnoOf(error)}); ${NOT_KEPT}`);
}

function writeFail(abs: string, error: unknown): never {
  const errno = errnoOf(error);
  if (errno === 'ENOSPC' || errno === 'EDQUOT') return fail(`The disk filled up while the backup was copied (${containerPath(abs)}); ${REMOVED}`);
  return fail(`The backup's copy of ${containerPath(abs)} could not be written (${errno}); ${NOT_KEPT}`);
}

/**
 * N5's take text for a disk error that stands (`diskError()`), by the error's folder and time; a record that cannot be
 * read and a `_snapshots` that cannot be listed (`files` empty, no time) take N19's and code-review1's forms.
 */
export function takeDiskText(d: { dir: string; errno: string; at: number | null; files?: string[]; unreadable?: boolean }): string {
  const unsure = "so can't confirm the backup is on disk";
  if (d.unreadable) {
    return `No folder sync is trusted since ${containerPath(d.files?.[0] ?? d.dir)} records a disk error on this machine, and that record cannot be read, ${unsure}; ${NOT_KEPT}`;
  }
  if (d.files?.length === 0 && d.at === null) {
    return `No folder sync is trusted since ${containerPath(d.dir)} could not be read (${d.errno}) to look for a disk error record, ${unsure}; ${NOT_KEPT}`;
  }
  const at = d.at === null ? '' : ` at ${timeText(d.at)}`;
  return `The disk reported an error when ${containerPath(d.dir)} was synced${at} (${d.errno}), so can't confirm the backup is on disk; ${NOT_KEPT}`;
}

/** The take's text for a failed `fsyncDirs` answer (decision 70, N5). */
export function takeSyncText(answer: Extract<ChainAnswer, { failed: true }>): string {
  if (answer.kind === 'earlier') return takeDiskText(diskError() ?? { dir: answer.dir, errno: answer.errno, at: null });
  if (answer.kind === 'open') {
    return `${containerPath(answer.dir)} could not be opened for its sync while the backup's folders were synced (${answer.errno}), so can't confirm the backup is on disk; ${NOT_KEPT}`;
  }
  return `The disk reported an error while the backup's folders were synced (${containerPath(answer.dir)}: ${answer.errno}), so can't confirm the backup is on disk; ${NOT_KEPT}`;
}

const CAP_TEXT = `The backup took longer than 10 minutes and was stopped; ${REMOVED}`;
const FINAL_TEXT = "The backup's final pass took longer than 60 seconds while it held the data files, so it was stopped; the backup was not kept.";
const EXITING_WORDS = 'the web panel was shutting down.';
const MOVES_TEXT = "Folders under /data kept being moved during the backup (servers the bot left, or deleted servers' data restored or swept), so no moment without a move came in 10 catch-up passes; the backup was not kept.";
const LOCK_CHANGED = "the data files' lock (/data/.writer.lock) was removed or changed during the backup.";

function capText(over: { files: number; bytes: number; largest: string; largestBytes: number }): string {
  return `The data kept changing faster than one backup step can copy (${over.files} files, ${mib(over.bytes)} in the last of ${CUT_CATCHUPS} catch-up passes, the largest ${containerPath(over.largest)} at ${mib(over.largestBytes)}; the limit is ${CUT_MAX_FILES} files and ${mib(CUT_MAX_BYTES)}); ${NOT_KEPT}`;
}

const sigOf = (st: fs.Stats): Sig => ({ ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
const sigEqual = (a: Sig | undefined, b: Sig | undefined): boolean =>
  !!a && !!b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

interface Rec { c0: number; sig: Sig; size: number; sha256: string; changed: boolean }
interface Listed { dirs: Set<string>; files: Map<string, { abs: string; c0: number; sig: Sig }>; bytes: number }
interface Previous { name: string; root: string; files: Map<string, ManifestFile> }

const absOf = (rel: string): string => dataPath(...rel.split('/'));

function relOf(abs: string): string | null {
  const rel = path.relative(DATA_ROOT, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

const parentsOf = (rel: string): string[] => {
  const parts = rel.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
};

/** The depth of the unit a path lies in: emptied staging folders are removed up to it, never it. */
function unitDepth(rel: string): number {
  const [top] = rel.split('/');
  if (/^\d+$/.test(top) || top === '_graveyard') return 1;
  if (top === 'global') return 2;
  return rel.split('/').length;
}

class Take {
  readonly records = new Map<string, Rec>();
  readonly dirs = new Set<string>();
  readonly staging: string;
  private readonly aborted: Promise<never>;
  linked = 0;
  walkEpoch = 0;
  seq = 0;
  /** Run before each entry of a walk; the local take's final op ends here when the web UI exits. */
  onEntry: (() => void) | null = null;

  constructor(readonly signal: AbortSignal, readonly folder: string) {
    this.staging = path.join(folder, 'data');
    this.aborted = new Promise<never>((_, reject) => {
      const stop = () => reject(stopOf(signal));
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    });
    this.aborted.catch(() => undefined);
  }

  /** Every await of the take: a stop or the cap ends the take here, whether or not the call returns. */
  step<T>(p: Promise<T>): Promise<T> {
    if (this.signal.aborted) {
      p.catch(() => undefined);
      return Promise.reject(stopOf(this.signal));
    }
    return Promise.race([p, this.aborted]);
  }

  sleep(ms: number): Promise<void> {
    return this.step(new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  }

  stagingOf(rel: string): string {
    return path.join(this.staging, ...rel.split('/'));
  }

  ensureDir(rel: string): void {
    for (const d of [...parentsOf(rel), rel]) {
      if (this.dirs.has(d)) continue;
      try {
        fs.mkdirSync(this.stagingOf(d));
      } catch (error) {
        if (errnoOf(error) !== 'EEXIST') writeFail(absOf(d), error);
      }
      this.dirs.add(d);
    }
  }

  ensureParents(rel: string): void {
    const parents = parentsOf(rel);
    if (parents.length) this.ensureDir(parents[parents.length - 1]);
  }

  tmpOf(rel: string): string {
    return `${this.stagingOf(rel)}.${++this.seq}.part`;
  }

  /** A path the walk or the turn found removed: its staging file goes, then the folders that emptied below its unit. */
  removeFile(rel: string): void {
    this.records.delete(rel);
    try {
      fs.unlinkSync(this.stagingOf(rel));
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') writeFail(absOf(rel), error);
    }
    const parents = parentsOf(rel).reverse();
    const keep = unitDepth(rel);
    for (const d of parents) {
      if (d.split('/').length <= keep) break;
      try {
        fs.rmdirSync(this.stagingOf(d));
        this.dirs.delete(d);
      } catch (error) {
        const errno = errnoOf(error);
        if (errno !== 'ENOTEMPTY' && errno !== 'EEXIST' && errno !== 'ENOENT') {
          console.warn(`[Backup] Could not remove the emptied folder ${d} from the backup being taken (${errno})`);
        }
        break;
      }
    }
  }
}

function stopOf(signal: AbortSignal): TakeStop {
  if (signal.reason === 'stopping') return new TakeStop({ ok: false, stopping: true });
  return new TakeStop({ ok: false, error: signal.reason === 'final' ? FINAL_TEXT : CAP_TEXT });
}

/** Decision 1's walk with decision 20's ENOENT rule; each file's c0 is read right before its first lstat (decision 39). */
async function list(take: Take): Promise<Listed> {
  const out: Listed = { dirs: new Set(), files: new Map(), bytes: 0 };
  let units: string[];
  try {
    units = topItems(DATA_ROOT);
  } catch (error) {
    return readFail(DATA_ROOT, error);
  }
  const visit = async (rel: string): Promise<void> => {
    take.onEntry?.();
    const abs = absOf(rel);
    const c0 = landClock();
    let st: fs.Stats;
    try {
      st = await take.step(fs.promises.lstat(abs));
    } catch (error) {
      if (error instanceof TakeStop) throw error;
      if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR') return;
      return readFail(abs, error);
    }
    if (st.isDirectory()) {
      if (classify(rel, 'dir') === 'out') return;
      let names: string[];
      try {
        names = await take.step(fs.promises.readdir(abs));
      } catch (error) {
        if (error instanceof TakeStop) throw error;
        if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR') return;
        return readFail(abs, error);
      }
      for (const d of [...parentsOf(rel), rel]) out.dirs.add(d);
      for (const name of names.sort()) await visit(`${rel}/${name}`);
      return;
    }
    if (classify(rel) === 'out') return;
    if (!st.isFile()) return fail(`${containerPath(abs)} is neither a file nor a folder, so the backup cannot copy it; ${NOT_KEPT}`);
    for (const d of parentsOf(rel)) out.dirs.add(d);
    out.files.set(rel, { abs, c0, sig: sigOf(st) });
    out.bytes += st.size;
  };
  for (const unit of units) await visit(unit);
  return out;
}

/** Copies a file into staging as a new file renamed over (decision 17), hashing the bytes written; 'removed' on ENOENT. */
async function copyOne(take: Take, rel: string, abs: string, c0: number, sig: Sig, previous: Previous | null): Promise<'copied' | 'removed'> {
  take.ensureParents(rel);
  const dest = take.stagingOf(rel);
  const before = previous?.files.get(rel);
  if (previous && before && sigEqual(before.sig, sig)) {
    const tmp = take.tmpOf(rel);
    try {
      await take.step(fs.promises.link(path.join(previous.root, ...rel.split('/')), tmp));
      await take.step(fs.promises.rename(tmp, dest));
      take.records.set(rel, { c0, sig, size: before.size, sha256: before.sha256, changed: false });
      take.linked += 1;
      return 'copied';
    } catch (error) {
      if (error instanceof TakeStop) throw error;
      await take.step(fs.promises.unlink(tmp)).catch(() => undefined);
    }
  }
  let src: fs.promises.FileHandle;
  try {
    src = await take.step(fs.promises.open(abs, 'r'));
  } catch (error) {
    if (error instanceof TakeStop) throw error;
    if (errnoOf(error) === 'ENOENT') {
      take.removeFile(rel);
      return 'removed';
    }
    return readFail(abs, error);
  }
  const tmp = take.tmpOf(rel);
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    let out: fs.promises.FileHandle;
    try {
      out = await take.step(fs.promises.open(tmp, 'wx'));
    } catch (error) {
      if (error instanceof TakeStop) throw error;
      return writeFail(abs, error);
    }
    try {
      const buf = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        let bytesRead: number;
        try {
          ({ bytesRead } = await take.step(src.read(buf, 0, buf.length, null)));
        } catch (error) {
          if (error instanceof TakeStop) throw error;
          return readFail(abs, error);
        }
        if (bytesRead === 0) break;
        try {
          await take.step(out.write(buf, 0, bytesRead));
        } catch (error) {
          if (error instanceof TakeStop) throw error;
          return writeFail(abs, error);
        }
        hash.update(buf.subarray(0, bytesRead));
        size += bytesRead;
      }
      try {
        await take.step(syncFile(out));
      } catch (error) {
        if (error instanceof TakeStop) throw error;
        return writeFail(abs, error);
      }
    } finally {
      await take.step(out.close()).catch(() => undefined);
    }
    try {
      await take.step(fs.promises.rename(tmp, dest));
    } catch (error) {
      if (error instanceof TakeStop) throw error;
      return writeFail(abs, error);
    }
  } finally {
    await take.step(src.close()).catch(() => undefined);
  }
  let changed: boolean;
  try {
    changed = !sigEqual(sigOf(await take.step(fs.promises.lstat(abs))), sig);
  } catch (error) {
    if (error instanceof TakeStop) throw error;
    changed = true;
  }
  take.records.set(rel, { c0, sig, size, sha256: hash.digest('hex'), changed });
  return 'copied';
}

interface Copied { files: number; bytes: number; largest: string; largestBytes: number }

/**
 * Makes staging equal to a listing: keeps a file whose signature equals its record and that landed before its c0.
 * Answers what it copied, by the listing's sizes.
 */
async function applyListing(take: Take, listed: Listed, previous: Previous | null): Promise<Copied> {
  const copied: Copied = { files: 0, bytes: 0, largest: '', largestBytes: -1 };
  for (const d of [...listed.dirs].sort()) take.ensureDir(d);
  for (const [rel, f] of listed.files) {
    const rec = take.records.get(rel);
    const landed = landedAt(f.abs);
    if (rec && !rec.changed && sigEqual(rec.sig, f.sig) && !(landed !== undefined && landed > rec.c0)) continue;
    take.onEntry?.();
    if (await copyOne(take, rel, f.abs, f.c0, f.sig, previous) === 'removed') continue;
    copied.files += 1;
    copied.bytes += f.sig.size;
    if (f.sig.size > copied.largestBytes) {
      copied.largestBytes = f.sig.size;
      copied.largest = f.abs;
    }
  }
  for (const rel of [...take.records.keys()]) if (!listed.files.has(rel)) take.removeFile(rel);
  const extra = [...take.dirs].filter(d => !listed.dirs.has(d)).sort((a, b) => b.split('/').length - a.split('/').length);
  for (const d of extra) {
    try {
      fs.rmSync(take.stagingOf(d), { recursive: true, force: true });
    } catch (error) {
      writeFail(absOf(d), error);
    }
    take.dirs.delete(d);
    for (const rel of [...take.records.keys()]) if (rel.startsWith(`${d}/`)) take.records.delete(rel);
  }
  return copied;
}

/** Decision 17's dirty paths: set paths landed past their record's c0 or with no record, on the wire, or marked changed. */
function dirtyPaths(take: Take): string[] {
  const dirty = new Set<string>();
  for (const abs of landedPaths()) {
    const rel = relOf(abs);
    if (!rel || classify(rel) === 'out') continue;
    const rec = take.records.get(rel);
    const landed = landedAt(abs);
    if (!rec || (landed !== undefined && landed > rec.c0)) dirty.add(rel);
  }
  for (const abs of flushingPaths()) {
    const rel = relOf(abs);
    if (rel && classify(rel) === 'in') dirty.add(rel);
  }
  for (const [rel, rec] of take.records) if (rec.changed) dirty.add(rel);
  return [...dirty].sort();
}

type Cut =
  | { cut: true; takenAt: number; read: Map<string, { buf: Buffer; sig: Sig }>; removed: string[] }
  | { cut: false; why: 'moves' }
  | { cut: false; why: 'caps'; files: number; bytes: number; largest: string; largestBytes: number };

/** The synchronous turn (decisions 17, 40, 41, 42, 52): no await from its first read to the lock check. */
function tryCut(take: Take, recreates0: number): Cut {
  if (dataOpsInFlight() > 0 || dirEpoch() !== take.walkEpoch) return { cut: false, why: 'moves' };
  const dirty = dirtyPaths(take);
  let bytes = 0;
  let largest = '';
  let largestBytes = -1;
  const sizes = new Map<string, fs.Stats | null>();
  for (const rel of dirty) {
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(absOf(rel));
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT' && errnoOf(error) !== 'ENOTDIR') readFail(absOf(rel), error);
    }
    sizes.set(rel, st);
    const size = st?.size ?? 0;
    bytes += size;
    if (size > largestBytes) {
      largestBytes = size;
      largest = absOf(rel);
    }
  }
  if (dirty.length > CUT_MAX_FILES || bytes > timing.maxBytes) return { cut: false, why: 'caps', files: dirty.length, bytes, largest, largestBytes };
  const read = new Map<string, { buf: Buffer; sig: Sig }>();
  const removed: string[] = [];
  const readOne = (rel: string, st: fs.Stats | null): void => {
    const abs = absOf(rel);
    if (!st) {
      if (take.records.has(rel)) removed.push(rel);
      return;
    }
    if (!st.isFile()) fail(`${containerPath(abs)} is neither a file nor a folder, so the backup cannot copy it; ${NOT_KEPT}`);
    try {
      read.set(rel, { buf: fs.readFileSync(abs), sig: sigOf(st) });
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT' && errnoOf(error) !== 'ENOTDIR') readFail(abs, error);
      if (take.records.has(rel)) removed.push(rel);
    }
  };
  for (const rel of dirty) readOne(rel, sizes.get(rel) ?? null);
  if (!dirty.includes(OWNER_CHANNEL_REL)) {
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(absOf(OWNER_CHANNEL_REL));
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') readFail(absOf(OWNER_CHANNEL_REL), error);
    }
    if (!st || !sigEqual(st && sigOf(st), take.records.get(OWNER_CHANNEL_REL)?.sig)) readOne(OWNER_CHANNEL_REL, st);
  }
  const takenAt = Date.now();
  let text: string;
  try {
    text = readLockText();
  } catch (error) {
    throw new TakeStop({ ok: false, lockLost: true, words: `can't confirm the bot still held the data files (/data/.writer.lock: ${errnoOf(error)}).` });
  }
  if (text !== heldText() || recreateCount() !== recreates0) throw new TakeStop({ ok: false, lockLost: true, words: LOCK_CHANGED });
  return { cut: true, takenAt, read, removed };
}

/** Each round copies the dirty paths, or walks in full after a directory move, then tries the cut. */
async function catchUp(take: Take, recreates0: number): Promise<Extract<Cut, { cut: true }>> {
  let last: Cut = { cut: false, why: 'moves' };
  for (let round = 0; round < CUT_CATCHUPS; round++) {
    while (dataOpsInFlight() > 0) await take.sleep(timing.pollMs);
    if (dirEpoch() !== take.walkEpoch) {
      take.walkEpoch = dirEpoch();
      await applyListing(take, await list(take), null);
    } else {
      for (const rel of dirtyPaths(take)) {
        const abs = absOf(rel);
        const c0 = landClock();
        let st: fs.Stats;
        try {
          st = await take.step(fs.promises.lstat(abs));
        } catch (error) {
          if (error instanceof TakeStop) throw error;
          if (errnoOf(error) !== 'ENOENT' && errnoOf(error) !== 'ENOTDIR') readFail(abs, error);
          take.removeFile(rel);
          continue;
        }
        if (!st.isFile()) fail(`${containerPath(abs)} is neither a file nor a folder, so the backup cannot copy it; ${NOT_KEPT}`);
        await copyOne(take, rel, abs, c0, sigOf(st), null);
      }
    }
    if (beforeTurn) await take.step(Promise.resolve(beforeTurn()));
    last = tryCut(take, recreates0);
    if (last.cut) return last;
  }
  if (last.why === 'caps') return fail(capText(last), 'writes');
  return fail(MOVES_TEXT, 'writes');
}

/** Writes what the turn read as new files renamed over, then removes what it found removed (decision 40). */
async function writeCut(take: Take, cut: Extract<Cut, { cut: true }>): Promise<void> {
  for (const [rel, { buf, sig }] of cut.read) {
    take.ensureParents(rel);
    const tmp = take.tmpOf(rel);
    try {
      const out = await take.step(fs.promises.open(tmp, 'wx'));
      try {
        await take.step(out.writeFile(buf));
        await take.step(syncFile(out));
      } finally {
        await take.step(out.close()).catch(() => undefined);
      }
      await take.step(fs.promises.rename(tmp, take.stagingOf(rel)));
    } catch (error) {
      if (error instanceof TakeStop) throw error;
      writeFail(absOf(rel), error);
    }
    take.records.set(rel, { c0: Number.POSITIVE_INFINITY, sig, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), changed: false });
  }
  for (const rel of cut.removed) take.removeFile(rel);
}

/** The newest complete hourly or daily snapshot's files, the link source of pass 1. */
async function previousSnapshot(root: string): Promise<Previous | null> {
  const list = (await listSnapshots(root)).filter(e => e.state === 'complete' && (e.kind === 'hourly' || e.kind === 'daily'));
  const newest = list.sort((a, b) => compareSnapshotNames(a.name, b.name)).pop();
  if (!newest || newest.state !== 'complete') return null;
  return { name: newest.name, root: path.join(root, newest.name, 'data'), files: new Map(newest.manifest.files.map(f => [f.path, f])) };
}

/** Decision 22: a leftover `.taking-*` goes once its process ended, or with no taker.json past 15 minutes. */
async function removeLeftovers(take: Take, root: string): Promise<void> {
  let names: string[];
  try {
    names = await take.step(fs.promises.readdir(root));
  } catch (error) {
    if (error instanceof TakeStop) throw error;
    if (errnoOf(error) === 'ENOENT') return;
    return readFail(root, error);
  }
  for (const name of names.sort()) {
    const work = parseWorkName(name);
    if (!work || work.work !== 'taking') continue;
    const dir = path.join(root, name);
    let taker: { pid?: unknown; start?: unknown } | null = null;
    try {
      taker = JSON.parse(fs.readFileSync(path.join(dir, 'taker.json'), 'utf-8'));
    } catch { /* no readable taker.json */ }
    const pid = typeof taker?.pid === 'number' && Number.isSafeInteger(taker.pid) && taker.pid > 0 ? taker.pid : null;
    let line: string | null = null;
    if (pid !== null) {
      const start = typeof taker?.start === 'string' ? taker.start : null;
      const ended = !seams.alive(pid) || (start !== null && seams.startOf(pid) !== start);
      if (ended) line = `[Backup] Removed an unfinished backup folder ${name} (the process that made it, pid ${pid}, has ended)`;
    } else if (seams.now() - work.time > LEFTOVER_MS) {
      line = `[Backup] Removed an unfinished backup folder ${name} (it names no process and is older than 15 minutes)`;
    }
    if (!line) continue;
    try {
      await take.step(fs.promises.rm(dir, { recursive: true, force: true }));
      console.log(line);
    } catch (error) {
      if (error instanceof TakeStop) throw error;
      console.warn(`[Backup] Could not remove the unfinished backup folder ${name} (${errnoOf(error)})`);
    }
  }
}

async function freeBytes(): Promise<number | null> {
  try {
    const st = await fs.promises.statfs(DATA_ROOT);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

function syncsFolder(take: Take): string[] {
  const deepestFirst = [...take.dirs].sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  return [...deepestFirst.map(d => take.stagingOf(d)), take.staging, take.folder];
}

/** Fails the take when the folder syncs answered an error, or when a disk error stands in the turn of their answer. */
function checkSyncs(answer: ChainAnswer): void {
  if (answer.failed) fail(takeSyncText(answer));
  const standing = diskError();
  if (standing) fail(takeDiskText(standing));
}

/** Removes a staging folder, bounded, so a hung removal never holds the answer; null once removed, else the answer's words. */
async function removeStaging(folder: string): Promise<string | null> {
  const at = containerPath(folder);
  const removal = fs.promises.rm(folder, { recursive: true, force: true }).then(
    () => null,
    error => {
      console.warn(`[Backup] Could not remove the unfinished backup folder ${path.basename(folder)} (${errnoOf(error)})`);
      return `the partial copy at ${at} could not be removed (${errnoOf(error)}).`;
    },
  );
  const late = `this machine can't confirm the partial copy at ${at} was removed (its removal did not finish within 5 seconds).`;
  return Promise.race([removal, new Promise<string>(resolve => { setTimeout(() => resolve(late), timing.removeMs).unref?.(); })]);
}

/** The answer's text with its last clause (the removed copy, or the backup not kept) replaced by `ending`. */
function withEnding(text: string, ending: string): string {
  for (const end of [REMOVED, NOT_KEPT]) if (text.endsWith(end)) return `${text.slice(0, -end.length)}${ending}`;
  return text;
}

/** The part of a take between its staging folder and its syncs: copies the data and answers the snapshot's takenAt. */
type Middle = (take: Take, previous: Previous | null, listed: Listed, recreates0: number) => Promise<number>;

const childMiddle: Middle = async (take, previous, listed, recreates0) => {
  await applyListing(take, listed, previous);
  const cut = await catchUp(take, recreates0);
  await writeCut(take, cut);
  return cut.takenAt;
};

async function runTake(req: { name: string; kind: TakeKind }, signal: AbortSignal, middle: Middle): Promise<TakeAnswer> {
  const root = snapshotsRoot();
  const folder = path.join(root, takingFolderName(Date.now(), seams.pid()));
  const take = new Take(signal, folder);
  const final = path.join(root, req.name);
  let made = false;
  let placed = false;
  const drop = watchLandings();
  const recreates0 = recreateCount();
  try {
    await removeLeftovers(take, root);
    const previous = await take.step(previousSnapshot(root));
    take.walkEpoch = dirEpoch();
    const listed = await list(take);
    const free = await take.step(freeBytes());
    const need = listed.bytes + FREE_MARGIN_BYTES;
    if (free !== null && free < need) {
      fail(`Not enough free disk space under /data: ${mib(free)} free, ${mib(need)} needed (the data's size plus 256 MiB kept free for the bot's own writes).`);
    }
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.mkdirSync(folder);
      made = true;
      atomicWriteFileSync(path.join(folder, 'taker.json'), JSON.stringify({ pid: seams.pid(), start: seams.startOf(seams.pid()) }), undefined, { chain: false });
      fs.mkdirSync(take.staging);
    } catch (error) {
      writeFail(folder, error);
    }
    const takenAt = await middle(take, previous, listed, recreates0);
    checkSyncs(await take.step(fsyncDirs(syncsFolder(take))));
    const files: ManifestFile[] = [...take.records.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([p, r]) => ({ path: p, size: r.size, sha256: r.sha256, sig: r.sig }));
    const dirs = [...take.dirs].sort();
    const counts = countsOf({ files, dirs });
    const manifest: Manifest = { format: 1, name: req.name, kind: req.kind, takenAt, botVersion: getAppVersion(), counts, files, dirs };
    try {
      atomicWriteFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest), undefined, { chain: false });
    } catch (error) {
      fail(`The backup's record (manifest.json) could not be written (${errnoOf(error)}); ${NOT_KEPT}`);
    }
    const standing = diskError();
    if (standing) fail(takeDiskText(standing));
    try {
      fs.renameSync(folder, final);
    } catch (error) {
      fail(`The backup's folder could not be renamed to ${req.name} (${errnoOf(error)}); ${NOT_KEPT}`);
    }
    placed = true;
    checkSyncs(await take.step(fsyncDirs([root])));
    const shared = previous && take.linked > 0 ? ` (${take.linked} unchanged files shared with ${previous.name})` : '';
    console.log(`[Backup] Took ${req.name}: ${counts.files} files, ${mib(counts.bytes)}${shared}`);
    return { ok: true, name: req.name, counts, linked: take.linked };
  } catch (error) {
    let answer: TakeAnswer = error instanceof TakeStop
      ? error.answer
      : { ok: false, error: `Could not read ${containerPath(String((error as { path?: unknown })?.path ?? DATA_ROOT))} (${errnoOf(error)}); ${NOT_KEPT}` };
    let stays: string | null = null;
    if (placed) {
      try {
        fs.renameSync(final, folder);
      } catch (back) {
        const after = !signal.aborted ? 'its folder sync failed'
          : signal.reason === 'stopping' ? 'the backup was stopped'
            : signal.reason === 'final' ? "the backup's final pass took longer than 60 seconds"
              : 'the backup took longer than 10 minutes';
        console.warn(`[Backup] Could not take back ${req.name} after ${after} (${errnoOf(back)})`);
        stays = `${req.name} stays in the list (renaming it back failed: ${errnoOf(back)}).`;
      }
    }
    if (stays !== null) {
      if ('error' in answer) answer = { ...answer, error: withEnding(answer.error, stays) };
    } else if (made) {
      const left = await removeStaging(folder);
      if (left !== null && 'error' in answer && answer.error.endsWith(REMOVED)) answer = { ...answer, error: withEnding(answer.error, left) };
    } else if ('error' in answer && answer.error.endsWith(REMOVED)) {
      answer = { ...answer, error: withEnding(answer.error, NOT_KEPT) };
    }
    if ('error' in answer) console.warn(`[Backup] ${answer.error}`);
    return answer;
  } finally {
    drop();
  }
}

let running: { controller: AbortController; done: Promise<TakeAnswer> } | null = null;

export function takeRunning(): boolean {
  return running !== null;
}

/**
 * Takes the snapshot `name`. The start turn answers `diskFlag` while a disk error stands (C20, K4, N6) and `busy` while a
 * take runs; a take that runs past 10 minutes is stopped.
 */
export function takeSnapshot(req: { name: string; kind: TakeKind }): Promise<TakeAnswer> {
  return startTake(req, childMiddle);
}

/**
 * The web UI's take while no bot process runs (decisions 18, 38, 41): pass 1 and up to 10 catch-up walks run outside
 * the local chain, each catch-up after a probe that takes no lock; the final walk runs as one op of the chain under the
 * writer lock, bounded at 60 s, and checks the lock at its end. The syncs, the manifest and the rename run after it.
 */
export function takeSnapshotLocal(req: { name: string; kind: TakeKind }, host: LocalTakeHost): Promise<TakeAnswer> {
  const startedAt = Date.now();
  let controller: AbortController | null = null;
  const refuse = (words: string): never => {
    throw new TakeStop({ ok: false, refused: true, words, startedAt });
  };
  const middle: Middle = async (take, previous, listed) => {
    await applyListing(take, listed, previous);
    let ended: Copied | null = null;
    for (let round = 0; round < CUT_CATCHUPS && ended === null; round++) {
      const probe = host.routeProbe('shared');
      if (probe.route === 'child') refuse('the bot was started during the backup.');
      if (probe.route !== 'local' && probe.route !== 'child') refuse(probe.words);
      const copied = await applyListing(take, await list(take), null);
      if (round === CUT_CATCHUPS - 1 || (copied.files <= CUT_MAX_FILES && copied.bytes <= timing.maxBytes)) ended = copied;
    }
    if (ended && (ended.files > CUT_MAX_FILES || ended.bytes > timing.maxBytes)) fail(capText(ended), 'writes');
    if (beforeTurn) await take.step(Promise.resolve(beforeTurn()));
    const answer = await take.step(host.queueFinalOp(async () => {
      const recreates0 = recreateCount();
      const bound = setTimeout(() => controller?.abort('final'), timing.finalMs);
      take.onEntry = () => {
        if (host.isExiting()) refuse(EXITING_WORDS);
      };
      try {
        await applyListing(take, await list(take), null);
        const takenAt = Date.now();
        let text: string;
        try {
          text = readLockText();
        } catch (error) {
          return refuse(`can't confirm the web panel still held the data files (/data/.writer.lock: ${errnoOf(error)}).`);
        }
        if (text !== heldText() || recreateCount() !== recreates0) refuse(LOCK_CHANGED);
        return takenAt;
      } finally {
        take.onEntry = null;
        clearTimeout(bound);
      }
    }));
    if (!answer.ran) return refuse(answer.words);
    if ('error' in answer) throw answer.error;
    return answer.value;
  };
  return startTake(req, middle, made => { controller = made; });
}

/** The start turn both takes share: `busy` while a take runs, `diskFlag` while a disk error stands, then the name. */
function startTake(req: { name: string; kind: TakeKind }, middle: Middle, onController?: (controller: AbortController) => void): Promise<TakeAnswer> {
  if (running) return Promise.resolve({ ok: false, busy: true });
  const standing = diskError();
  if (standing) return Promise.resolve({ ok: false, diskFlag: standing });
  const parsed = parseSnapshotName(req.name);
  if (!parsed || parsed.kind !== req.kind || (req.kind !== 'hourly' && req.kind !== 'daily')) {
    return Promise.resolve({ ok: false, error: `${req.name} is not a backup name of kind ${req.kind}.` });
  }
  try {
    fs.lstatSync(path.join(snapshotsRoot(), req.name));
    return Promise.resolve({ ok: false, exists: true });
  } catch { /* the name is free */ }
  const controller = new AbortController();
  onController?.(controller);
  const cap = setTimeout(() => controller.abort('cap'), timing.capMs);
  cap.unref?.();
  const done = runTake(req, controller.signal, middle).finally(() => {
    clearTimeout(cap);
    running = null;
  });
  running = { controller, done };
  return done;
}

/** The stop step (decision 32): ends a running take at its next await, and waits up to boundMs for its answer. */
export async function abortRunningTake(boundMs = 2000): Promise<void> {
  const r = running;
  if (!r) return;
  r.controller.abort('stopping');
  await Promise.race([r.done.then(() => undefined), new Promise<void>(resolve => { setTimeout(resolve, boundMs).unref?.(); })]);
}
