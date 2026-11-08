import * as fs from 'fs';
import * as path from 'path';

/** Writes through a temp file and a rename; `keep` gives the new file that mode, and that owner where the process may set it. */
export function atomicWriteFileSync(file: string, contents: string | Buffer, keep?: { mode: number; uid: number; gid: number }): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', keep ? keep.mode & 0o777 : 0o666);
  try {
    if (keep) {
      fs.fchmodSync(fd, keep.mode & 0o7777);
      try {
        fs.fchownSync(fd, keep.uid, keep.gid);
      } catch {
        try { fs.fchownSync(fd, -1, keep.gid); } catch { /* the process is not in that group */ }
      }
    }
    fs.writeFileSync(fd, contents, 'utf-8');
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
  fs.closeSync(fd);
  // Windows can throw EPERM on rename-over-existing while a reader holds the
  // target open; a short bounded retry keeps the write atomic instead of
  // degrading to a torn direct write.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      break;
    } catch (error) {
      if (attempt >= 3) {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        throw error;
      }
      const waitUntil = Date.now() + 25 * (attempt + 1);
      while (Date.now() < waitUntil) { /* writes through here are rare and tiny */ }
    }
  }
  try {
    const dirFd = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch { /* directories cannot be fsynced on Windows */ }
}
