// A lock file shared by several processes: created with O_EXCL, its holder named by pid and process start, a stale
// holder taken over only under a takeover guard and only for the stale text seen. The App Store lock and the data
// files' writer lock run on it.

import * as fs from 'fs';

let bootId: string | null | undefined;

/** Identifies one run of a process, so a pid reused after a restart is not taken for the old holder. */
export const processStart = {
  startOf(pid: number): string | null {
    try {
      if (bootId === undefined) {
        try { bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim(); } catch { bootId = null; }
      }
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const starttime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      return starttime ? `${bootId ?? ''}:${starttime}` : null;
    } catch {
      return null;
    }
  },
};

export interface LockHolder {
  pid: number;
  start: string | null;
  role?: string;
  at?: number;
}

export type TakeResult =
  | { kind: 'taken' }
  | { kind: 'held'; holder: LockHolder | null }
  | { kind: 'contended' }
  | { kind: 'unreadable'; errno: string }
  | { kind: 'unwritable'; errno: string; error: unknown };

/** The process facts a lock reads; a test drives several simulated processes through them. */
export interface LockSeams {
  pid(): number;
  /** False only when the pid is provably gone (ESRCH). */
  alive(pid: number): boolean;
  startOf(pid: number): string | null;
  now(): number;
}

export const realSeams: LockSeams = {
  pid: () => process.pid,
  alive: (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      return error?.code !== 'ESRCH';
    }
  },
  startOf: (pid: number) => processStart.startOf(pid),
  now: () => Date.now(),
};

export interface ProcessLockOptions {
  lockPath: string;
  takeoverPath: string;
  /** A holder text that does not parse is stale once the file is older than this. */
  unparsableStaleMs: number;
  /** A takeover guard older than this is removed. */
  takeoverStaleMs: number;
  /** The holder fields written beside pid and start. */
  extra?: () => Record<string, unknown>;
  seams?: LockSeams;
}

const errnoOf = (error: unknown): string => String((error as { code?: unknown } | null)?.code ?? 'EIO');

export function parseHolder(raw: string): LockHolder | null {
  let holder: any;
  try {
    holder = JSON.parse(raw);
  } catch {
    return null;
  }
  const pid = holder?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  return { pid, start: typeof holder.start === 'string' ? holder.start : null, role: typeof holder.role === 'string' ? holder.role : undefined, at: typeof holder.at === 'number' ? holder.at : undefined };
}

type Staleness =
  | { state: 'missing' }
  | { state: 'stale'; raw: string }
  | { state: 'held'; holder: LockHolder | null }
  | { state: 'unreadable'; errno: string };

export class ProcessLock {
  private depthCount = 0;
  private written: string | null = null;
  readonly seams: LockSeams;

  constructor(private readonly options: ProcessLockOptions) {
    this.seams = options.seams ?? realSeams;
  }

  get depth(): number {
    return this.depthCount;
  }

  /** The exact text this process wrote at its take, while it holds the lock. */
  get heldText(): string | null {
    return this.depthCount > 0 ? this.written : null;
  }

  get lockPath(): string {
    return this.options.lockPath;
  }

  /** Forgets the hold without touching the file (a holder that another process deposed). */
  drop(): void {
    this.depthCount = 0;
    this.written = null;
  }

  /** The holder text this process writes. */
  holderText(): string {
    const pid = this.seams.pid();
    return JSON.stringify({ pid, start: this.seams.startOf(pid), ...(this.options.extra?.() ?? {}), at: this.seams.now() });
  }

  /** The lock file's state for a taker. */
  staleness(): Staleness {
    let raw: string;
    let mtimeMs: number;
    try {
      raw = fs.readFileSync(this.options.lockPath, 'utf-8');
      mtimeMs = fs.statSync(this.options.lockPath).mtimeMs;
    } catch (error: any) {
      return error?.code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable', errno: errnoOf(error) };
    }
    const holder = parseHolder(raw);
    if (!holder) {
      return this.seams.now() - mtimeMs > this.options.unparsableStaleMs ? { state: 'stale', raw } : { state: 'held', holder: null };
    }
    if (holder.pid === this.seams.pid()) return { state: 'stale', raw };
    if (!this.seams.alive(holder.pid)) return { state: 'stale', raw };
    if (holder.start !== null) {
      const start = this.seams.startOf(holder.pid);
      if (start !== null && start !== holder.start) return { state: 'stale', raw };
    }
    return { state: 'held', holder };
  }

  /** Creates the file naming this process; an error other than EEXIST answers unwritable. */
  private create(): 'created' | 'exists' | { errno: string; error: unknown } {
    let fd: number;
    try {
      fd = fs.openSync(this.options.lockPath, 'wx');
    } catch (error: any) {
      if (error?.code === 'EEXIST') return 'exists';
      return { errno: errnoOf(error), error };
    }
    const text = this.holderText();
    try {
      try {
        fs.writeSync(fd, text);
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      try { fs.unlinkSync(this.options.lockPath); } catch { /* takers treat the empty file as unparsable */ }
      return { errno: errnoOf(error), error };
    }
    this.written = text;
    return 'created';
  }

  /** Removes a stale lock under the takeover guard, only if it still holds the stale text seen. */
  private takeOver(seen: string): 'done' | 'contended' | { errno: string; error: unknown } {
    try {
      fs.closeSync(fs.openSync(this.options.takeoverPath, 'wx'));
    } catch (error: any) {
      if (error?.code !== 'EEXIST') return { errno: errnoOf(error), error };
      try {
        if (this.seams.now() - fs.statSync(this.options.takeoverPath).mtimeMs > this.options.takeoverStaleMs) fs.unlinkSync(this.options.takeoverPath);
      } catch { /* its holder removed it */ }
      return 'contended';
    }
    try {
      const now = this.staleness();
      if (now.state === 'stale' && now.raw === seen) {
        try {
          fs.unlinkSync(this.options.lockPath);
        } catch (error: any) {
          if (error?.code !== 'ENOENT') return { errno: errnoOf(error), error };
        }
      }
      return 'done';
    } finally {
      try { fs.unlinkSync(this.options.takeoverPath); } catch { /* already gone */ }
    }
  }

  tryTake(): TakeResult {
    if (this.depthCount > 0) {
      this.depthCount++;
      return { kind: 'taken' };
    }
    let contended = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const created = this.create();
      if (created === 'created') {
        this.depthCount = 1;
        return { kind: 'taken' };
      }
      if (created !== 'exists') return { kind: 'unwritable', ...created };
      const stale = this.staleness();
      if (stale.state === 'held') return { kind: 'held', holder: stale.holder };
      if (stale.state === 'unreadable') return { kind: 'unreadable', errno: stale.errno };
      if (stale.state === 'stale') {
        const taken = this.takeOver(stale.raw);
        contended = taken === 'contended';
        if (taken !== 'done' && taken !== 'contended') return { kind: 'unwritable', ...taken };
      }
    }
    return contended ? { kind: 'contended' } : { kind: 'held', holder: null };
  }

  /**
   * Releases one level; at depth 0 it unlinks the file only when the file names this process. Answers the errno of a
   * read or unlink that failed (the file may still name this process), null otherwise.
   */
  release(): string | null {
    if (this.depthCount === 0) return null;
    this.depthCount--;
    if (this.depthCount > 0) return null;
    this.written = null;
    try {
      const holder = parseHolder(fs.readFileSync(this.options.lockPath, 'utf-8'));
      if (holder?.pid === this.seams.pid()) fs.unlinkSync(this.options.lockPath);
      return null;
    } catch (error: any) {
      return error?.code === 'ENOENT' ? null : errnoOf(error);
    }
  }

  /** A release that failed, tried again: unlinks the file only while it holds exactly this text. Answers as release(). */
  unlinkIfText(text: string): string | null {
    try {
      if (fs.readFileSync(this.options.lockPath, 'utf-8') === text) fs.unlinkSync(this.options.lockPath);
      return null;
    } catch (error: any) {
      return error?.code === 'ENOENT' ? null : errnoOf(error);
    }
  }
}
