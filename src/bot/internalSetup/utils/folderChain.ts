// Every folder sync of a save (NB19 decision 1): one folder, the chain from a folder up to DATA_ROOT with a skip of
// folders whose entry this process synced, every folder under a root, and the flag a folder sync error sets for the
// process's life. Imports fs, path and DATA_ROOT only, so the web UI, the CLI and atomicWrite.ts load it.

import * as fs from 'fs';
import * as path from 'path';
import { DATA_ROOT } from '../../../utils/dataRoot';

export type SyncKind = 'sync' | 'open' | 'earlier';
export type ChainAnswer = { failed: false } | { failed: true; kind: SyncKind; dir: string; errno: string; error: unknown };
type Failure = Extract<ChainAnswer, { failed: true }>;

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

let folderSyncFailure: { dir: string; errno: string } | null = null;

/** Sets the flag at a folder sync error the device answered; the first error is kept. */
export function noteFolderSyncFailure(dir: string, errno: string): void {
  if (!folderSyncFailure) folderSyncFailure = { dir, errno };
}

/** A folder sync of this process reported an error: no later folder sync is trusted until the process ends. */
export function folderSyncFailed(): boolean {
  return folderSyncFailure !== null;
}

const loggedEarlier = new Set<string>();

export function resetFolderSyncFailureForTests(): void {
  folderSyncFailure = null;
  loggedEarlier.clear();
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

/** The sync clause (<why>) and the advice (<next>) of a failed answer, by its kind. */
export function syncWords(kind: SyncKind, dir: string, errno: string): { why: string; next: string } {
  if (kind === 'sync') return { why: `the disk did not confirm the sync of ${dir} (${errno})`, next: 'Check the disk, then restart the machine.' };
  if (kind === 'earlier') {
    return {
      why: `no folder sync is trusted since the disk did not confirm the sync of ${dir} (${errno}) earlier in this process`,
      next: 'Check the disk, then restart the machine.',
    };
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
