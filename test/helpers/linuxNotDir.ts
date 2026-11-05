import fs from 'fs';
import path from 'path';
import { vi } from 'vitest';
import { REAL_FS } from './forwardingFs';

// Linux answers a path through a regular file with ENOTDIR where Windows answers ENOENT. Under root, each fs call
// below that fails ENOENT while a folder of its path is a file fails ENOTDIR instead, as on Linux.
// A test file using it mocks 'fs' with helpers/forwardingFs.ts; vi.restoreAllMocks lifts it.

const SYNC = ['readFileSync', 'statSync', 'lstatSync', 'openSync', 'readdirSync', 'writeFileSync', 'appendFileSync', 'unlinkSync', 'rmdirSync', 'mkdirSync'] as const;
const ASYNC = ['readFile', 'stat', 'lstat', 'open', 'readdir', 'writeFile', 'appendFile', 'unlink', 'rmdir', 'mkdir', 'rename'] as const;

export function linuxNotDir(root: string): void {
  const realFs = ((fs as any)[REAL_FS] ?? fs) as typeof fs;
  const top = path.resolve(root);
  const throughFile = (p: unknown): boolean => {
    if (typeof p !== 'string') return false;
    let dir = path.dirname(path.resolve(p));
    while (dir === top || dir.startsWith(top + path.sep)) {
      try {
        if (realFs.statSync(dir).isFile()) return true;
      } catch { /* absent: look further up */ }
      if (dir === top) break;
      dir = path.dirname(dir);
    }
    return false;
  };
  const asNotDir = (error: any, p: unknown) => {
    if (error?.code !== 'ENOENT' || !throughFile(p)) return error;
    return Object.assign(new Error(`ENOTDIR: not a directory, '${String(p)}'`), { code: 'ENOTDIR', errno: -20, path: p });
  };
  for (const fn of SYNC) {
    const spy = vi.isMockFunction((fs as any)[fn]) ? vi.mocked((fs as any)[fn]) : null;
    const prev = spy?.getMockImplementation() ?? (realFs as any)[fn].bind(realFs);
    vi.spyOn(fs as any, fn).mockImplementation(((p: unknown, ...rest: unknown[]) => {
      try {
        return prev(p, ...rest);
      } catch (error) {
        throw asNotDir(error, p);
      }
    }) as never);
  }
  for (const fn of ASYNC) {
    const holder = fs.promises as any;
    const spy = vi.isMockFunction(holder[fn]) ? vi.mocked(holder[fn]) : null;
    const prev = spy?.getMockImplementation() ?? holder[fn].bind(holder);
    vi.spyOn(holder, fn).mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      try {
        return await prev(p, ...rest);
      } catch (error) {
        throw asNotDir(error, p);
      }
    }) as never);
  }
}
