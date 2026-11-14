// Every folder sync of a save (NB19 decision 1): one folder, the chain from a folder up to DATA_ROOT with a skip of
// folders whose entry this process synced, every folder under a root, and the flag a folder sync error sets for the
// process's life, with this boot's disk error record (NB8). Imports fs, path and dataRoot.ts only, so the web UI, the CLI
// and atomicWrite.ts load it.

import * as fs from 'fs';
import * as path from 'path';
import { CONTAINER_DATA_ROOT, DATA_ROOT, dataPath } from '../../../utils/dataRoot';

export type SyncKind = 'sync' | 'open' | 'earlier';
export type ChainAnswer = { failed: false } | { failed: true; kind: SyncKind; dir: string; errno: string; error: unknown };
type Failure = Extract<ChainAnswer, { failed: true }>;

export type DiskRole = 'web panel' | 'bot' | 'a data bundle import';
export type FolderSyncFlag = {
  dir: string;
  errno: string;
  at: number | null;
  by: DiskRole | null;
  source: 'own' | 'report' | 'record';
  file: string | null;
};
export type DiskRecordFile = { format: 1; bootId: string | null; folder: string; errno: string; at: number; by: DiskRole };
export type FlagWrite = { flag: FolderSyncFlag; recorded: boolean; tried: string; writeErrno?: string };
export type DiskError = { dir: string; errno: string; at: number | null; by: DiskRole | null; files: string[]; unreadable: boolean };

const ROLES: readonly DiskRole[] = ['web panel', 'bot', 'a data bundle import'];
const UNREADABLE = 'record unreadable';
const RECORD_NAME = /^disk-error-.+\.json$/;

const IS_WINDOWS = process.platform === 'win32';
const SKIPPED_OPEN = new Set(['EISDIR', 'EPERM', 'EACCES']);
const SKIPPED_SYNC = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);

const errnoOf = (error: unknown): string => String((error as { code?: unknown } | null)?.code ?? 'EIO');
const closeCodeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === undefined || code === null ? 'no error code' : String(code);
};
const logCloseError = (dir: string, error: unknown) => {
  console.error(`[Data] ${dir}: the directory could not be closed after its sync (${closeCodeOf(error)}); this changes nothing about the lines already reported for the files in it`);
};

let folderSyncFailure: FolderSyncFlag | null = null;
let diskRole: DiskRole | null = null;
let bootIdValue: string | null | undefined;
let ownWrite: FlagWrite | null = null;
let failedWrite: { tried: string; errno: string } | null = null;
let listeners: Array<(write: FlagWrite) => void> = [];

/** A path under DATA_ROOT as the container names it (/data/...); any other path as given. */
export function containerPath(p: string): string {
  const rel = path.relative(path.resolve(DATA_ROOT), path.resolve(p));
  if (rel === '') return CONTAINER_DATA_ROOT;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return p;
  return path.posix.join(CONTAINER_DATA_ROOT, ...rel.split(path.sep));
}

export const timeText = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** The machine's boot id, read once per process; null when it cannot be read. */
export function bootId(): string | null {
  if (bootIdValue === undefined) {
    try {
      const text = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
      bootIdValue = /^[0-9a-f-]{36}$/.test(text) ? text : null;
    } catch {
      bootIdValue = null;
    }
  }
  return bootIdValue;
}

export function _setBootIdForTests(id: string | null): void {
  bootIdValue = id;
}

const recordPath = (id: string | null) => dataPath('_snapshots', `disk-error-${id ?? 'unknown'}.json`);

/** Creates this boot's record with raw fs calls; the create's EEXIST, or any error after the create, counts as recorded. */
function writeRecord(fields: Omit<DiskRecordFile, 'format' | 'bootId'>): Omit<FlagWrite, 'flag'> {
  const id = bootId();
  const tried = recordPath(id);
  let fd: number;
  try {
    fs.mkdirSync(path.dirname(tried), { recursive: true });
  } catch (error) {
    return { recorded: false, tried, writeErrno: errnoOf(error) };
  }
  try {
    fd = fs.openSync(tried, 'wx');
  } catch (error) {
    if (errnoOf(error) === 'EEXIST') return { recorded: true, tried };
    return { recorded: false, tried, writeErrno: errnoOf(error) };
  }
  try {
    const record: DiskRecordFile = { format: 1, bootId: id, ...fields };
    fs.writeSync(fd, JSON.stringify(record));
    try { fs.fsyncSync(fd); } catch {}
  } catch {} finally {
    try { fs.closeSync(fd); } catch {}
  }
  return { recorded: true, tried };
}

/** The clause that says which restart clears the gate, for a record this process holds as written. */
const untilRecordedClears = (tried: string): string =>
  bootId() === null
    ? `until ${containerPath(tried)} is deleted and the bot's container is restarted (this process cannot read the machine's boot id)`
    : "until the machine the bot runs on is restarted (a restart of the bot's container is not enough after a disk error)";

const RESTART_CLEARS = "; a restart of the bot's container would clear it";

function logFirstSet(flag: FolderSyncFlag, write: Omit<FlagWrite, 'flag'>): void {
  const head = `[Data] Syncing the folder ${containerPath(flag.dir)} failed (${flag.errno})`;
  if (write.recorded) {
    console.warn(`${head}; no backup is taken and no restore starts ${untilRecordedClears(write.tried)}`);
  } else if (diskRole === 'web panel') {
    console.warn(`${head}; no backup is taken and no restore starts until the bot's container restarts`);
    console.warn(`[Backup] The disk error could not be recorded in ${containerPath(write.tried)} (${write.writeErrno})${RESTART_CLEARS}`);
  } else {
    console.warn(head);
    const tail = diskRole === 'a data bundle import' ? '; the web panel does not see this error' : '';
    console.warn(`[Data] The disk error could not be recorded in ${containerPath(write.tried)} (${write.writeErrno})${tail}`);
  }
}

/**
 * Sets the flag at a folder sync error the device answered; the first error is kept. In a process with a role it
 * also writes this boot's record, logs the first-set lines and tells the listeners, in the same call.
 */
export function noteFolderSyncFailure(dir: string, errno: string): void {
  if (folderSyncFailure) return;
  const flag: FolderSyncFlag = { dir, errno, at: Date.now(), by: diskRole, source: 'own', file: null };
  folderSyncFailure = flag;
  if (!diskRole) return;
  const write = writeRecord({ folder: containerPath(dir), errno, at: flag.at!, by: diskRole });
  if (write.recorded) flag.file = write.tried;
  else failedWrite = { tried: write.tried, errno: write.writeErrno ?? 'EIO' };
  logFirstSet(flag, write);
  ownWrite = { flag: { ...flag }, ...write };
  const called = listeners;
  listeners = [];
  for (const fn of called) {
    try { fn(ownWrite); } catch {}
  }
}

/** The web UI's note of a bot child's folder sync error: the record with `by: 'bot'`, no listener. */
export function noteReportedFolderSyncFailure(report: { dir: string; errno: string; at: number }): void {
  if (folderSyncFailure) return;
  const flag: FolderSyncFlag = { dir: report.dir, errno: report.errno, at: report.at, by: 'bot', source: 'report', file: null };
  folderSyncFailure = flag;
  const write = writeRecord({ folder: containerPath(report.dir), errno: report.errno, at: report.at, by: 'bot' });
  if (write.recorded) {
    flag.file = write.tried;
    console.warn(`[Backup] The bot reported a disk error when ${containerPath(report.dir)} was synced (${report.errno}); no backup is taken and no restore starts ${untilRecordedClears(write.tried)}`);
  } else {
    failedWrite = { tried: write.tried, errno: write.writeErrno ?? 'EIO' };
    console.warn(`[Backup] The disk error could not be recorded in ${containerPath(write.tried)} (${write.writeErrno})${RESTART_CLEARS}`);
  }
}

/** The record write that failed at this process's flag (its own error or a child's report), or null. */
export function failedRecordWrite(): { tried: string; errno: string } | null {
  return failedWrite ? { ...failedWrite } : null;
}

/** Runs `fn` once, at this process's first own folder sync error under a role, or at once if that has happened. */
export function onFolderSyncFlag(fn: (write: FlagWrite) => void): void {
  if (ownWrite) fn(ownWrite);
  else listeners.push(fn);
}

/** The flag, a copy, or null. */
export function folderSyncFlag(): FolderSyncFlag | null {
  return folderSyncFailure ? { ...folderSyncFailure } : null;
}

const parseRecord = (text: string): DiskRecordFile | null => {
  try {
    const r = JSON.parse(text);
    if (!r || typeof r !== 'object' || r.format !== 1) return null;
    if (typeof r.folder !== 'string' || typeof r.errno !== 'string' || typeof r.at !== 'number' || !ROLES.includes(r.by)) return null;
    if (r.bootId !== null && typeof r.bootId !== 'string') return null;
    return r as DiskRecordFile;
  } catch {
    return null;
  }
};

export type DiskRecordFound = { files: string[]; record: DiskRecordFile | null; folder?: { dir: string; errno: string } };

/**
 * This boot's record and disk-error-unknown.json, or every record while the boot id is unknown. A file counts as set
 * whatever it holds, and so does any read error but ENOENT; `record` is the first file's, null when it cannot be read.
 * When _snapshots itself cannot be read, `folder` names it and its errno and `files` is empty.
 */
export function diskRecord(): DiskRecordFound | null {
  const id = bootId();
  let candidates: string[];
  if (id === null) {
    const dir = dataPath('_snapshots');
    try {
      candidates = fs.readdirSync(dir).filter(n => RECORD_NAME.test(n)).sort().map(n => path.join(dir, n));
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return null;
      return { files: [], record: null, folder: { dir: containerPath(dir), errno: errnoOf(error) } };
    }
  } else {
    candidates = [recordPath(id), recordPath(null)];
  }
  const files: string[] = [];
  let record: DiskRecordFile | null = null;
  for (const file of candidates) {
    let text: string | null = null;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') continue;
      if (errnoOf(error) === 'ENOTDIR') return { files: [], record: null, folder: { dir: containerPath(dataPath('_snapshots')), errno: 'ENOTDIR' } };
    }
    if (files.length === 0 && text !== null) record = parseRecord(text);
    files.push(file);
  }
  return files.length ? { files, record } : null;
}

/** The process's flag of any source, else this boot's record; null when neither stands. */
export function diskError(): DiskError | null {
  const flag = folderSyncFailure;
  if (flag) {
    const files = diskRecord()?.files ?? (flag.file ? [flag.file] : []);
    return { dir: flag.dir, errno: flag.errno, at: flag.at, by: flag.by, files, unreadable: flag.source === 'record' && flag.errno === UNREADABLE };
  }
  const found = diskRecord();
  if (!found) return null;
  if (found.folder) return { dir: found.folder.dir, errno: found.folder.errno, at: null, by: null, files: [], unreadable: false };
  if (found.record) {
    const { folder, errno, at, by } = found.record;
    return { dir: folder, errno, at, by, files: found.files, unreadable: false };
  }
  return { dir: containerPath(found.files[0]), errno: UNREADABLE, at: null, by: null, files: found.files, unreadable: true };
}

/** Sets this process's role, then its flag from this boot's record when one stands; writes and logs nothing. */
export function setDiskRole(role: DiskRole): void {
  diskRole = role;
  const found = diskRecord();
  if (!found || folderSyncFailure) return;
  if (found.folder) {
    folderSyncFailure = { dir: found.folder.dir, errno: found.folder.errno, at: null, by: null, source: 'record', file: null };
    return;
  }
  const file = found.files[0];
  folderSyncFailure = found.record
    ? { dir: found.record.folder, errno: found.record.errno, at: found.record.at, by: found.record.by, source: 'record', file }
    : { dir: containerPath(file), errno: UNREADABLE, at: null, by: null, source: 'record', file };
}

/** Removes the records of other boots; with the boot id unknown it removes none. */
export function removeOtherBootRecords(): void {
  const id = bootId();
  if (id === null) return;
  const dir = dataPath('_snapshots');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const keep = new Set([path.basename(recordPath(id)), path.basename(recordPath(null))]);
  for (const name of names) {
    if (!RECORD_NAME.test(name) || keep.has(name)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') continue;
      console.warn(`[Backup] ${containerPath(path.join(dir, name))}, a disk error record of an earlier boot, could not be removed (${errnoOf(error)}); delete it by hand`);
    }
  }
}

/** An open file's sync, throwing as the handle does; it sets nothing. */
export async function syncFile(handle: fs.promises.FileHandle): Promise<void> {
  await handle.sync();
}

/** A folder sync of this process reported an error: no later folder sync is trusted until the process ends. */
export function folderSyncFailed(): boolean {
  return folderSyncFailure !== null;
}

const loggedEarlier = new Set<string>();

export function resetFolderSyncFailureForTests(): void {
  folderSyncFailure = null;
  loggedEarlier.clear();
  diskRole = null;
  bootIdValue = undefined;
  ownWrite = null;
  failedWrite = null;
  listeners = [];
}

/** Logs a line built from a failed answer; a line from an 'earlier' answer once per path. */
export function logSyncLine(p: string, kind: SyncKind | undefined, line: string): void {
  if (kind === 'earlier') {
    if (loggedEarlier.has(p)) return;
    loggedEarlier.add(p);
  }
  console.error(line);
}

const earlier = (): Failure => ({ failed: true, kind: 'earlier', dir: folderSyncFailure!.dir, errno: folderSyncFailure!.errno, error: null });

type Identity = { dev: bigint; ino: bigint; birth: bigint };
const durableFolders = new Map<string, Identity>();
let folderGeneration = 0;

/** Forgets every folder record, or the records of a folder and every folder below it. */
export function forgetDurableFolders(under?: string): void {
  folderGeneration += 1;
  if (under === undefined) {
    durableFolders.clear();
    return;
  }
  const dir = path.resolve(under);
  for (const p of [...durableFolders.keys()]) if (p === dir || p.startsWith(dir + path.sep)) durableFolders.delete(p);
}

/** A failure of the open or the handle's stat: EIO is the device's answer and sets the flag. */
function openFailure(dir: string, error: unknown): Failure {
  const errno = errnoOf(error);
  if (errno === 'EIO') {
    noteFolderSyncFailure(dir, errno);
    return { failed: true, kind: 'sync', dir, errno, error };
  }
  return { failed: true, kind: 'open', dir, errno, error };
}

function syncFailure(dir: string, error: unknown): Failure | null {
  const errno = errnoOf(error);
  if (SKIPPED_SYNC.has(errno)) return null;
  noteFolderSyncFailure(dir, errno);
  return { failed: true, kind: 'sync', dir, errno, error };
}

type One = { failed: false; identity: Identity | null } | Failure;

async function syncOne(dir: string): Promise<One> {
  let dh: fs.promises.FileHandle;
  try {
    dh = await fs.promises.open(dir, 'r');
  } catch (error) {
    if (SKIPPED_OPEN.has(errnoOf(error))) return { failed: false, identity: null };
    return openFailure(dir, error);
  }
  let failure: Failure | null = null;
  let identity: Identity | null = null;
  try {
    try {
      const st = await dh.stat({ bigint: true });
      identity = { dev: st.dev, ino: st.ino, birth: st.birthtimeNs };
    } catch (error) {
      failure = openFailure(dir, error);
    }
    if (!failure) {
      try {
        await dh.sync();
      } catch (error) {
        failure = syncFailure(dir, error);
      }
    }
  } finally {
    try { await dh.close(); } catch (error) { logCloseError(dir, error); }
  }
  return failure ?? { failed: false, identity };
}

function syncOneSync(dir: string): One {
  let fd: number;
  try {
    fd = fs.openSync(dir, 'r');
  } catch (error) {
    if (SKIPPED_OPEN.has(errnoOf(error))) return { failed: false, identity: null };
    return openFailure(dir, error);
  }
  let failure: Failure | null = null;
  let identity: Identity | null = null;
  try {
    try {
      const st = fs.fstatSync(fd, { bigint: true });
      identity = { dev: st.dev, ino: st.ino, birth: st.birthtimeNs };
    } catch (error) {
      failure = openFailure(dir, error);
    }
    if (!failure) {
      try {
        fs.fsyncSync(fd);
      } catch (error) {
        failure = syncFailure(dir, error);
      }
    }
  } finally {
    try { fs.closeSync(fd); } catch (error) { logCloseError(dir, error); }
  }
  return failure ?? { failed: false, identity };
}

/** The flag as an answer: 'earlier' once a folder sync of this process reported an error. */
export function flagAnswer(): ChainAnswer {
  return !IS_WINDOWS && folderSyncFailure ? earlier() : { failed: false };
}

const answerOf = (one: One): ChainAnswer => (one.failed ? one : folderSyncFailure ? earlier() : { failed: false });

/** One folder, opened read-only, fsynced and closed. */
export async function syncFolder(dir: string): Promise<ChainAnswer> {
  if (IS_WINDOWS) return { failed: false };
  if (folderSyncFailure) return earlier();
  return answerOf(await syncOne(path.resolve(dir)));
}

export function syncFolderSync(dir: string): ChainAnswer {
  if (IS_WINDOWS) return { failed: false };
  if (folderSyncFailure) return earlier();
  return answerOf(syncOneSync(path.resolve(dir)));
}

const recorded = (dir: string, identity: Identity | null): boolean => {
  if (!identity || identity.birth <= 0n) return false;
  const known = durableFolders.get(dir);
  return !!known && known.dev === identity.dev && known.ino === identity.ino && known.birth === identity.birth;
};

const atTop = (dir: string): boolean => {
  const rel = path.relative(path.resolve(DATA_ROOT), dir);
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || dir === path.dirname(dir);
};

/** Records the synced folders whose parent was synced too, when the walk ran in one generation. */
function finishWalk(synced: Array<{ dir: string; identity: Identity | null }>, generation: number): ChainAnswer {
  if (folderSyncFailure) return earlier();
  if (generation === folderGeneration) {
    for (let i = 0; i < synced.length - 1; i++) {
      const { dir, identity } = synced[i];
      if (identity) durableFolders.set(dir, identity);
    }
  }
  return { failed: false };
}

/** dir, then each folder above it up to DATA_ROOT, stopping after a folder whose entry this process synced. */
export async function syncFolderChain(dir: string): Promise<ChainAnswer> {
  if (IS_WINDOWS) return { failed: false };
  if (folderSyncFailure) return earlier();
  const generation = folderGeneration;
  const synced: Array<{ dir: string; identity: Identity | null }> = [];
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    if (folderSyncFailure) return earlier();
    const one = await syncOne(at);
    if (one.failed) return one;
    synced.push({ dir: at, identity: one.identity });
    if (atTop(at) || recorded(at, one.identity)) return finishWalk(synced, generation);
  }
}

export function syncFolderChainSync(dir: string): ChainAnswer {
  if (IS_WINDOWS) return { failed: false };
  if (folderSyncFailure) return earlier();
  const generation = folderGeneration;
  const synced: Array<{ dir: string; identity: Identity | null }> = [];
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    if (folderSyncFailure) return earlier();
    const one = syncOneSync(at);
    if (one.failed) return one;
    synced.push({ dir: at, identity: one.identity });
    if (atTop(at) || recorded(at, one.identity)) return finishWalk(synced, generation);
  }
}

async function foldersBelow(root: string, out: string[]): Promise<void> {
  for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    await foldersBelow(full, out);
    out.push(full);
  }
}

/** Every folder under root, each after the folders below it, then root itself; it does not go above root. */
export async function syncFoldersUnder(root: string): Promise<ChainAnswer> {
  if (IS_WINDOWS) return { failed: false };
  if (folderSyncFailure) return earlier();
  const dirs: string[] = [];
  await foldersBelow(path.resolve(root), dirs);
  dirs.push(path.resolve(root));
  for (const dir of dirs) {
    if (folderSyncFailure) return earlier();
    const one = await syncOne(dir);
    if (one.failed) return one;
  }
  return folderSyncFailure ? earlier() : { failed: false };
}

/** Opens, writes, fsyncs and closes a file, making its folders first. */
export async function writeFileSynced(target: string, bytes: string | Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const handle = await fs.promises.open(target, 'w');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The 'earlier' clause by where the process's flag came from: its own sync, a child's report or this boot's record. */
function earlierWhy(dir: string, errno: string): string {
  const flag = folderSyncFailure;
  const trusted = 'no folder sync is trusted since';
  if (flag?.source === 'report' && flag.at !== null) {
    return `${trusted} the disk did not confirm the sync of ${containerPath(dir)} (${errno}) in the bot process at ${timeText(flag.at)}`;
  }
  if (flag?.source === 'record' && !flag.file) return `${trusted} ${flag.dir} could not be read (${flag.errno}) to look for a disk error record`;
  if (flag?.source === 'record' && flag.file) {
    const file = containerPath(flag.file);
    if (flag.errno === UNREADABLE || flag.at === null) return `${trusted} ${file} records a disk error on this machine, and that record cannot be read`;
    return `${trusted} the disk did not confirm the sync of ${containerPath(dir)} (${errno}) at ${timeText(flag.at)}, as ${file} records`;
  }
  return `${trusted} the disk did not confirm the sync of ${dir} (${errno}) earlier in this process`;
}

/** The sync clause (<why>) and the advice (<next>) of a failed answer, by its kind. */
export function syncWords(kind: SyncKind, dir: string, errno: string): { why: string; next: string } {
  if (kind === 'sync') return { why: `the disk did not confirm the sync of ${dir} (${errno})`, next: 'Check the disk, then restart the machine.' };
  if (kind === 'earlier') {
    return { why: earlierWhy(dir, errno), next: 'Check the disk, then restart the machine.' };
  }
  return {
    why: `${dir} could not be opened for its sync (${errno})`,
    next: 'The next save of this file syncs its folder again; check the current state before you repeat the action.',
  };
}

/** T1: the file holds the new bytes, but a folder sync failed, so can't confirm it is stored. */
export function writtenUnconfirmedText(file: string, kind: SyncKind, dir: string, errno: string): string {
  const { why, next } = syncWords(kind, dir, errno);
  return `${file} is written, but ${why}, so can't confirm it is stored. ${next}`;
}

/** A folder sync that fails a step outside a save: an error with the sync clause, the step's next step and the errno. */
export function syncStepError(answer: Failure): Error & { code: string; kind: SyncKind; dir: string } {
  const { why, next } = syncWords(answer.kind, answer.dir, answer.errno);
  const step = answer.kind === 'open' ? 'Try again.' : next;
  return Object.assign(new Error(`${why}. ${step}`), { code: answer.errno, kind: answer.kind, dir: answer.dir });
}

/** A whole file is renamed into place, but its folder chain failed: the new bytes are on disk, can't confirm stored. */
export class FolderSyncError extends Error {
  readonly name = 'FolderSyncError';
  readonly written = true as const;
  readonly code: string;
  readonly kind: SyncKind;
  readonly dir: string;
  readonly file: string;
  replaced?: string;

  constructor(file: string, answer: Failure, message?: string) {
    super(message ?? writtenUnconfirmedText(file, answer.kind, answer.dir, answer.errno));
    this.code = answer.errno;
    this.kind = answer.kind;
    this.dir = answer.dir;
    this.file = file;
  }
}

/** Logs T7 for a FolderSyncError; a line from an 'earlier' answer once per path. */
export function logFolderSyncError(what: string, error: FolderSyncError): void {
  logSyncLine(error.file, error.kind, writeErrorText(what, error));
}

/** T7 for a FolderSyncError, else "<what> could not be written<tail>: <message>". */
export function writeErrorText(what: string, error: unknown, tail = ''): string {
  if (error instanceof FolderSyncError) return `${what} can't be confirmed as saved${tail}: ${error.message}`;
  return `${what} could not be written${tail}: ${error instanceof Error ? error.message : String(error)}`;
}
