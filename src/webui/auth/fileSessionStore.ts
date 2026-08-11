// File-backed express-session store: one {sid}.json under /data/_sessions,
// written through the dataManager atomic queue so session files get the same
// temp+fsync+rename durability (and flushBeforeExit coverage) as guild data.

import * as fs from 'fs';
import * as path from 'path';
import { Store, SessionData } from 'express-session';
import { dataPath } from '../../utils/dataRoot';
import { writeRawAtomic, readRaw, deleteRawAtomic } from '../../bot/internalSetup/utils/dataManager';

// Path-traversal guard: a sid that fails this never touches the filesystem.
const SID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TOUCH_WRITE_THRESHOLD_MS = 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
// The queued delete flushes on setImmediate; this grace covers its retry
// window so a concurrent request's save cannot replace the pending tombstone
// (pendingOps is last-op-wins by path).
const DESTROYED_GRACE_MS = 30 * 1000;

interface SessionFileRecord {
  v: 1;
  sid: string;
  expiresAt: number;
  updatedAt: number;
  session: SessionData;
}

export interface FileSessionStoreOptions {
  dir?: string;
  touchWriteThresholdMs?: number;
  sweepIntervalMs?: number;
  defaultTtlMs?: number;
}

export class FileSessionStore extends Store {
  /** False when the session directory is not writable; caller should fall back. */
  readonly probeOk: boolean;

  private readonly dir: string;
  private readonly touchWriteThresholdMs: number;
  private readonly defaultTtlMs: number;
  private readonly destroyed = new Set<string>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(options: FileSessionStoreOptions = {}) {
    super();
    this.dir = options.dir ?? dataPath('_sessions');
    this.touchWriteThresholdMs = options.touchWriteThresholdMs ?? DEFAULT_TOUCH_WRITE_THRESHOLD_MS;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.probeOk = this.probe();
    if (this.probeOk) {
      this.sweepTimer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
      this.sweepTimer.unref();
    }
  }

  private probe(): boolean {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const probeFile = path.join(this.dir, `.probe.${process.pid}.tmp`);
      fs.writeFileSync(probeFile, 'ok');
      fs.unlinkSync(probeFile);
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  get(sid: string, callback: (err: any, session?: SessionData | null) => void): void {
    const file = this.fileFor(sid);
    if (!file) return void callback(null, null);
    const raw = readRaw(file);
    if (raw === null) return void callback(null, null);
    const record = this.parseRecord(raw);
    if (!record || record.expiresAt <= Date.now()) {
      this.destroy(sid, () => callback(null, null));
      return;
    }
    callback(null, record.session);
  }

  set(sid: string, session: SessionData, callback?: (err?: any) => void): void {
    const file = this.fileFor(sid);
    if (!file) return void callback?.(new Error('[FileSessionStore] Invalid session id'));
    if (this.destroyed.has(sid)) return void callback?.();
    const record: SessionFileRecord = {
      v: 1,
      sid,
      expiresAt: this.expiryFor(session),
      updatedAt: Date.now(),
      session,
    };
    writeRawAtomic(file, JSON.stringify(record));
    callback?.();
  }

  destroy(sid: string, callback?: (err?: any) => void): void {
    const file = this.fileFor(sid);
    if (!file) return void callback?.();
    this.destroyed.add(sid);
    deleteRawAtomic(file);
    const timer = setTimeout(() => this.destroyed.delete(sid), DESTROYED_GRACE_MS);
    timer.unref();
    callback?.();
  }

  touch(sid: string, session: SessionData, callback?: () => void): void {
    const file = this.fileFor(sid);
    if (!file || this.destroyed.has(sid)) return void callback?.();
    const raw = readRaw(file);
    if (raw === null) return void callback?.();
    const record = this.parseRecord(raw);
    if (!record) return void callback?.();
    const nextExpiresAt = this.expiryFor(session);
    if (nextExpiresAt - record.expiresAt <= this.touchWriteThresholdMs) return void callback?.();
    record.expiresAt = nextExpiresAt;
    record.updatedAt = Date.now();
    if (session.cookie) record.session.cookie = session.cookie;
    writeRawAtomic(file, JSON.stringify(record));
    callback?.();
  }

  length(callback: (err: any, length?: number) => void): void {
    callback(null, this.listSids().length);
  }

  clear(callback?: (err?: any) => void): void {
    for (const sid of this.listSids()) this.destroy(sid);
    callback?.();
  }

  private fileFor(sid: string): string | null {
    if (!SID_PATTERN.test(sid)) return null;
    return path.join(this.dir, `${sid}.json`);
  }

  private parseRecord(raw: string): SessionFileRecord | null {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.expiresAt === 'number' && parsed.session) return parsed as SessionFileRecord;
    } catch { /* corrupt: caller treats as miss */ }
    return null;
  }

  private expiryFor(session: SessionData): number {
    const expires = session.cookie?.expires;
    if (expires) {
      const t = new Date(expires).getTime();
      if (Number.isFinite(t)) return t;
    }
    const maxAge = session.cookie?.maxAge;
    if (typeof maxAge === 'number') return Date.now() + maxAge;
    return Date.now() + this.defaultTtlMs;
  }

  private listSids(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const sids: string[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const sid = name.slice(0, -'.json'.length);
      if (SID_PATTERN.test(sid)) sids.push(sid);
    }
    return sids;
  }

  private sweep(): void {
    const now = Date.now();
    for (const sid of this.listSids()) {
      const file = this.fileFor(sid)!;
      const raw = readRaw(file);
      if (raw === null) continue;
      const record = this.parseRecord(raw);
      if (record) {
        if (record.expiresAt < now) deleteRawAtomic(file);
        continue;
      }
      // Corrupt file: delete only once stale, so a file another process is
      // mid-writing is not swept from under it.
      try {
        if (now - fs.statSync(file).mtimeMs > this.defaultTtlMs) deleteRawAtomic(file);
      } catch { /* already gone */ }
    }
  }
}
