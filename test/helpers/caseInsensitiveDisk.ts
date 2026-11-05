import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { vi } from 'vitest';
import { REAL_FS } from './forwardingFs';

// NB12 section 8 (wip-redesign/sheets/NB12.md): the disks a file-route row runs on. 'case-sensitive' is the real
// disk with the fs calls counted; 'case-insensitive' also resolves every name under root, part by part, to the first
// spelling created under ntfsFold, as NTFS does with its upcase table.
// A test file using a disk mocks 'fs' with helpers/forwardingFs.ts.

/**
 * NTFS's upcase table: each UTF-16 unit maps to its toUpperCase() when that is one unit, and stays as it is otherwise.
 * It is the helper's own, so a merge the code's fold() loses still shows as an overwrite here.
 */
export function ntfsFold(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const unit = s[i];
    const upper = unit.toUpperCase();
    out += upper.length === 1 ? upper : unit;
  }
  return out;
}

export type DiskName = 'case-sensitive' | 'case-insensitive';
export const DISKS: DiskName[] = ['case-sensitive', 'case-insensitive'];

const TWO_PATHS = new Set(['renameSync', 'copyFileSync', 'rename', 'copyFile']);
const ASYNC = ['open', 'unlink', 'mkdir', 'rmdir', 'appendFile', 'writeFile', 'readFile', 'stat', 'lstat', 'readdir', 'rm', 'rename', 'copyFile'] as const;
const PATH_SYNC = ['existsSync', 'lstatSync', 'statSync', 'readdirSync', 'rmdirSync', 'mkdirSync', 'readFileSync', 'writeFileSync', 'unlinkSync', 'openSync', 'rmSync', 'appendFileSync', 'renameSync', 'copyFileSync'] as const;

export interface Disk {
  name: DiskName;
  /** Path arguments the code passed, by fs function name (fs.promises ones prefixed 'promises.'), since set up or reset. */
  calls: Map<string, string[]>;
  count(fn: string, under?: string): number;
  reset(): void;
}

/** Whether the real disk under dir treats names differing only in letter case as one. */
export function realDiskFoldsCase(dir: string): boolean {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `CaseProbe${process.pid}`);
  fs.writeFileSync(probe, '');
  try {
    return fs.existsSync(path.join(dir, `caseprobe${process.pid}`));
  } finally {
    fs.unlinkSync(probe);
  }
}

/**
 * Asks Windows to keep letter case apart in dir and the folders made in it later (fsutil, per folder); does nothing
 * elsewhere or when Windows refuses. Then answers realDiskFoldsCase for a probe folder made in dir.
 */
export function caseSensitiveWhereAllowed(dir: string): boolean {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    try {
      execFileSync('fsutil', ['file', 'setCaseSensitiveInfo', dir, 'enable'], { stdio: 'ignore', windowsHide: true });
    } catch { /* left folding; the rows that need two spellings are skipped */ }
  }
  return realDiskFoldsCase(path.join(dir, `case-probe-${process.pid}`));
}

/**
 * Spies on the fs calls under root (restored by vi.restoreAllMocks). The resolution lists folders with the real
 * function, so its own listings are never counted. A test stubs one call once with mockImplementationOnce on the
 * same spy (vi.mocked(fs.rmdirSync)), so the disk's resolution stays in place for the other calls.
 */
export function useDisk(name: DiskName, root: string): Disk {
  const realFs = fs as any;
  const originals = new Map<string, (...a: unknown[]) => unknown>();
  const realReaddir = (p: string): string[] => (originals.get('readdirSync') ?? realFs.readdirSync)(p) as string[];
  const realRoot = path.resolve(root);
  const calls = new Map<string, string[]>();
  const note = (fn: string, p: unknown) => {
    let list = calls.get(fn);
    if (!list) {
      list = [];
      calls.set(fn, list);
    }
    list.push(typeof p === 'string' ? path.resolve(p) : String(p));
  };

  const resolve = (p: unknown): unknown => {
    if (name === 'case-sensitive' || typeof p !== 'string') return p;
    const abs = path.resolve(p);
    if (abs !== realRoot && !abs.startsWith(realRoot + path.sep)) return p;
    const parts = path.relative(realRoot, abs).split(path.sep).filter(Boolean);
    let cur = realRoot;
    let exists = true;
    for (const part of parts) {
      if (exists) {
        let names: string[];
        try {
          names = realReaddir(cur);
        } catch {
          names = [];
        }
        const found = names.find(n => n === part) ?? names.find(n => ntfsFold(n) === ntfsFold(part));
        if (found === undefined) exists = false;
        cur = path.join(cur, found ?? part);
      } else {
        cur = path.join(cur, part);
      }
    }
    return cur;
  };

  const wrap = (holder: any, fn: string, label: string) => {
    const source = holder === realFs && realFs[REAL_FS] ? realFs[REAL_FS] : holder;
    const real = source[fn].bind(source);
    if (holder === realFs) originals.set(fn, real);
    const two = TWO_PATHS.has(fn);
    vi.spyOn(holder, fn).mockImplementation(((first: unknown, ...rest: unknown[]) => {
      note(label, first);
      if (two) return real(resolve(first), resolve(rest[0]), ...rest.slice(1));
      return real(resolve(first), ...rest);
    }) as never);
  };
  for (const fn of PATH_SYNC) wrap(realFs, fn, fn);
  for (const fn of ASYNC) wrap(fs.promises, fn, `promises.${fn}`);

  return {
    name,
    calls,
    count: (fn, under) => (calls.get(fn) ?? []).filter(p => under === undefined || p === path.resolve(under) || p.startsWith(path.resolve(under) + path.sep)).length,
    reset: () => calls.clear(),
  };
}
