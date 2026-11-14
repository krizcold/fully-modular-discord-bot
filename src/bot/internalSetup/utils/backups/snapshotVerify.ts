import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { syncFile } from '../folderChain';
import { readSnapshot, snapshotsRoot, type Manifest } from './snapshotList';

export const VERIFY_LIST_MAX = 20;

export type DifferenceReason = 'missing' | 'extra' | 'size' | 'content';
export type Difference = { path: string; reason: DifferenceReason };
export type CountKey = keyof Manifest['counts'];
export type CountDifference = { key: CountKey; recorded: number; found: number };
export type VerifyAnswer =
  | { ok: true }
  | { ok: false; count: number; differences: Difference[]; counts: CountDifference[] };

const CHUNK = 1024 * 1024;

const errnoOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;
const badPath = (p: unknown): boolean =>
  typeof p !== 'string' || p === '' || path.posix.isAbsolute(p) || path.win32.isAbsolute(p) || p.split(/[\\/]/).some(s => s === '' || s === '.' || s === '..');

/** A complete snapshot's manifest; anything else throws with decision 15's can't-read text. */
function manifestFor(name: string, root: string): Manifest {
  const entry = readSnapshot(name, root);
  if (entry.state !== 'complete') throw new Error(`The backup's record (manifest.json) cannot be read: ${entry.cause}.`);
  const m = entry.manifest;
  if (!Array.isArray(m.files) || !Array.isArray(m.dirs)) throw new Error(`The backup's record (manifest.json) cannot be read: no file list.`);
  const bad = [...m.dirs, ...m.files.map(f => f?.path)].find(badPath);
  if (bad !== undefined) throw new Error(`The backup's record (manifest.json) cannot be read: path ${JSON.stringify(bad)}.`);
  return m;
}

/**
 * Copies the snapshot's data/ tree as its manifest lists it into dest, the folder that becomes the copy's root: every
 * folder, then every file one at a time, each a new file (never a link) synced before the next.
 */
export async function copySnapshot(name: string, dest: string, opts: { signal?: AbortSignal; root?: string } = {}): Promise<void> {
  const root = opts.root ?? snapshotsRoot();
  const manifest = manifestFor(name, root);
  const from = path.join(root, name, 'data');
  opts.signal?.throwIfAborted();
  await fs.promises.mkdir(dest, { recursive: true });
  for (const dir of [...manifest.dirs].sort()) await fs.promises.mkdir(path.join(dest, dir), { recursive: true });
  for (const file of manifest.files) {
    opts.signal?.throwIfAborted();
    const target = path.join(dest, file.path);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(path.join(from, file.path), target, fs.constants.COPYFILE_EXCL);
    const handle = await fs.promises.open(target, 'r+');
    try {
      await syncFile(handle);
    } finally {
      await handle.close();
    }
  }
}

async function hashOf(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const handle = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, CHUNK, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(p);
  } catch (e) {
    if (errnoOf(e) === 'ENOENT' || errnoOf(e) === 'ENOTDIR') return null;
    throw e;
  }
}

/** The counts decision 6 records, as the manifest's own lists give them. */
export function countsOf(manifest: Pick<Manifest, 'files' | 'dirs'>): Manifest['counts'] {
  const entries = new Set([...manifest.dirs, ...manifest.files.map(f => f.path)]);
  return {
    files: manifest.files.length,
    bytes: manifest.files.reduce((sum, f) => sum + f.size, 0),
    dirs: manifest.dirs.length,
    guilds: manifest.dirs.filter(d => /^\d+$/.test(d)).length,
    graveyardEntries: [...entries].filter(p => {
      const parts = p.split('/');
      return parts.length === 2 && parts[0] === '_graveyard' && !parts[1].startsWith('.');
    }).length,
  };
}

const COUNT_ORDER: readonly CountKey[] = ['files', 'bytes', 'dirs', 'guilds', 'graveyardEntries'];
const COUNT_WORDS: Record<CountKey, string> = { files: 'files', bytes: 'bytes', dirs: 'folders', guilds: 'guild folders', graveyardEntries: 'graveyard entries' };

/** The text for a copy whose counts alone differ from the manifest's record; the first is named in COUNT_ORDER. */
export function countsDifferText(counts: readonly CountDifference[]): string {
  const first = [...counts].sort((a, b) => COUNT_ORDER.indexOf(a.key) - COUNT_ORDER.indexOf(b.key))[0];
  const n = counts.length;
  return `The copy differs from what was recorded when the backup was taken: ${n} ${n === 1 ? 'count differs' : 'counts differ'}, first the number of ${COUNT_WORDS[first.key]} (${first.found} found, ${first.recorded} recorded).`;
}

/**
 * Checks the tree at root against a manifest: the same files and folders, each file's size and sha256, and every
 * count. A folder the manifest does not list is one difference, whatever it holds. Lists at most VERIFY_LIST_MAX
 * differences, sorted by path, and counts them all. A read error other than a missing entry throws.
 */
export async function verifyTree(root: string, manifest: Manifest, opts: { signal?: AbortSignal } = {}): Promise<VerifyAnswer> {
  const files = new Map(manifest.files.map(f => [f.path, f]));
  const dirs = new Set(manifest.dirs);
  const found: Difference[] = [];

  for (const dir of dirs) {
    opts.signal?.throwIfAborted();
    const st = await lstatOrNull(path.join(root, dir));
    if (!st?.isDirectory()) found.push({ path: dir, reason: 'missing' });
  }
  for (const file of manifest.files) {
    opts.signal?.throwIfAborted();
    const full = path.join(root, file.path);
    const st = await lstatOrNull(full);
    if (!st?.isFile()) found.push({ path: file.path, reason: 'missing' });
    else if (st.size !== file.size) found.push({ path: file.path, reason: 'size' });
    else if ((await hashOf(full)) !== file.sha256) found.push({ path: file.path, reason: 'content' });
  }

  const walk = async (rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(rel ? path.join(root, rel) : root, { withFileTypes: true });
    } catch (e) {
      if (errnoOf(e) === 'ENOENT' || errnoOf(e) === 'ENOTDIR') return;
      throw e;
    }
    for (const entry of entries) {
      opts.signal?.throwIfAborted();
      const p = rel ? `${rel}/${entry.name}` : entry.name;
      if (dirs.has(p)) {
        if (entry.isDirectory()) await walk(p);
      } else if (!files.has(p)) {
        found.push({ path: p, reason: 'extra' });
      }
    }
  };
  await walk('');

  const recorded = manifest.counts ?? ({} as Manifest['counts']);
  const own = countsOf(manifest);
  const counts: CountDifference[] = (Object.keys(own) as CountKey[])
    .filter(key => recorded[key] !== own[key])
    .map(key => ({ key, recorded: recorded[key], found: own[key] }));

  if (!found.length && !counts.length) return { ok: true };
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.reason < b.reason ? -1 : 1));
  return { ok: false, count: found.length, differences: found.slice(0, VERIFY_LIST_MAX), counts };
}
