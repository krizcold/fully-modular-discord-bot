// Working Set - per-guild docs in RAM for postgres-routed guilds. The frozen
// sync facade answers from here; a coalescing write-behind flushes each guild's
// dirty docs as ONE fenced transaction per window. Reads never block on the
// database; writes are accepted into RAM with a bounded durability window and
// refuse loudly (never silently) when that window cannot be honored.

import { DataBackend, DocKey, FenceToken, GuildFlushBatch } from './backend';

const DEBOUNCE_MS = 500;
const MAX_DELAY_MS = 5000;
// C1 bounded acceptance window: time since the oldest unflushed accepted
// write, and total dirty backlog bytes, whichever trips first.
const ACCEPT_WINDOW_MS = 300_000;
const ACCEPT_BYTES = 64 * 1024 * 1024;
// A fenced guild keeps answering in-flight reads briefly, then is evicted.
const FENCED_DRAIN_MS = 30_000;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 30_000;

export type WsWriteResult = 'accepted' | 'frozen-window' | 'refusing' | 'fenced' | 'not-ready';
export type WsReadResult =
  | { status: 'ready'; value: unknown | undefined }   // undefined = absent or tombstoned
  | { status: 'not-ready' };
export type FlushNowOutcome = 'ok' | 'pending' | 'deposed' | 'unavailable';

/**
 * Thrown by the facade for a guild write the backend cannot honor (acceptance
 * window closed, or the guild was fenced by a newer owner). Module code never
 * catches it by contract; the dispatch wrappers do and surface the cause.
 */
export class DataBackendUnavailableError extends Error {
  constructor(readonly causeKey: 'database-unreachable' | 'guild-fenced') {
    super(causeKey === 'guild-fenced'
      ? '[Data] This guild was taken over by another node; the write was not saved'
      : '[Data] The data backend is unreachable and the write buffer is full; the write was not saved');
    this.name = 'DataBackendUnavailableError';
  }
}

interface WorkingDoc {
  content: string;
  parsed?: unknown;
  tombstone: boolean;
  dirty: boolean;
  /** Accepted-at of the oldest unflushed change to this doc (window accounting). */
  dirtySince: number;
}

type WsState = 'hydrating' | 'ready' | 'frozen-retained' | 'fenced' | 'failed';

class GuildWorkingSet {
  state: WsState = 'hydrating';
  readonly docs = new Map<string, WorkingDoc>();
  readonly appendKeys = new Set<string>();
  readonly appendBuf = new Map<string, { chunk: string; dirtySince: number }>();
  dirtyKeys = new Set<string>();
  windowOpenedAt: number | null = null;
  debounceTimer: NodeJS.Timeout | null = null;
  flushInFlight = false;
  requeue = false;
  fencedDrainTimer: NodeJS.Timeout | null = null;
  readyWaiters: Array<() => void> = [];

  constructor(readonly guildId: string, public fence: FenceToken) {}

  clearTimers(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.fencedDrainTimer) { clearTimeout(this.fencedDrainTimer); this.fencedDrainTimer = null; }
  }
}

function docKeyOf(module: string, filename: string): string {
  return `${module}/${filename}`;
}

function splitDocKey(key: string): DocKey {
  const idx = key.indexOf('/');
  return { module: key.slice(0, idx), filename: key.slice(idx + 1) };
}

export interface BackendHealth {
  state: 'healthy' | 'degraded' | 'refusing';
  oldestDirtyMs: number;
  dirtyBytes: number;
  lastError: string | null;
}

export class WorkingSetManager {
  private readonly sets = new Map<string, GuildWorkingSet>();
  private health: BackendHealth['state'] = 'healthy';
  private lastError: string | null = null;
  private dirtyBytes = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  // Counters driven to zero by the drill matrix (non-gated callers touching
  // guilds whose working set is not ready).
  private wsBypassReads = 0;
  private wsBypassWrites = 0;
  private fencedFlushRejections = 0;

  constructor(private readonly backend: DataBackend) {}

  // --------------------------------------------------------------------------
  // Lifecycle (driven by the DataReadiness hook on lease grants/revokes)
  // --------------------------------------------------------------------------

  has(guildId: string): boolean {
    return this.sets.has(guildId);
  }

  stateOf(guildId: string): WsState | null {
    return this.sets.get(guildId)?.state ?? null;
  }

  readyGuilds(): string[] {
    return [...this.sets.values()]
      .filter(ws => ws.state === 'ready' || ws.state === 'frozen-retained')
      .map(ws => ws.guildId);
  }

  /**
   * Hydrate a guild (claim-then-read). Returns 'ready' | 'deposed' |
   * 'unavailable'. On 'unavailable' the working set stays in 'hydrating' and
   * the caller retries; a partially hydrated guild is never served.
   */
  async hydrate(guildId: string, token: FenceToken): Promise<'ready' | 'deposed' | 'unavailable'> {
    let ws = this.sets.get(guildId);
    if (ws && (ws.state === 'ready' || ws.state === 'frozen-retained')) {
      ws.fence = token;
      if (ws.state === 'frozen-retained') ws.state = 'ready';
      return 'ready';
    }
    if (!ws) {
      ws = new GuildWorkingSet(guildId, token);
      this.sets.set(guildId, ws);
    }
    ws.fence = token;
    const outcome = await this.backend.hydrateGuild(guildId, token);
    if (!outcome.ok) {
      if (outcome.reason === 'deposed') {
        this.sets.delete(guildId);
        return 'deposed';
      }
      return 'unavailable';
    }
    // A no-rows guild becomes ready empty; docs land as raw text, parsed lazily.
    for (const { key, doc } of outcome.docs) {
      ws.docs.set(docKeyOf(key.module, key.filename), { content: doc, tombstone: false, dirty: false, dirtySince: 0 });
    }
    for (const key of outcome.appendKeys) {
      ws.appendKeys.add(docKeyOf(key.module, key.filename));
    }
    ws.state = 'ready';
    for (const wake of ws.readyWaiters.splice(0)) wake();
    return 'ready';
  }

  /** Same-shape re-grant: refresh the fence only, never re-hydrate. */
  refreshFence(guildId: string, token: FenceToken): void {
    const ws = this.sets.get(guildId);
    if (ws) ws.fence = token;
  }

  /**
   * Lease removed: one final immediate flush under the OLD fence, then the set
   * enters frozen-retained (reads keep serving, writes get the frozen
   * rejection). Eviction happens at migration source-cleanup or drain end.
   */
  async unloadToFrozenRetained(guildId: string): Promise<void> {
    const ws = this.sets.get(guildId);
    if (!ws || ws.state === 'fenced') return;
    await this.flushGuildNow(guildId, MAX_DELAY_MS);
    if (ws.state === 'ready') ws.state = 'frozen-retained';
  }

  evict(guildId: string): void {
    const ws = this.sets.get(guildId);
    if (!ws) return;
    ws.clearTimers();
    this.forgetDirty(ws);
    this.sets.delete(guildId);
  }

  /** Await a guild's working set becoming ready (the data-ready gate). */
  awaitReady(guildId: string, timeoutMs: number): Promise<boolean> {
    const ws = this.sets.get(guildId);
    if (!ws) return Promise.resolve(false);
    if (ws.state === 'ready' || ws.state === 'frozen-retained') return Promise.resolve(true);
    if (ws.state !== 'hydrating') return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(this.stateOf(guildId) === 'ready'), timeoutMs);
      timer.unref();
      ws.readyWaiters.push(() => { clearTimeout(timer); resolve(true); });
    });
  }

  // --------------------------------------------------------------------------
  // Sync API surface (facade delegates here for postgres-routed guild docs)
  // --------------------------------------------------------------------------

  read(guildId: string, module: string, filename: string): WsReadResult {
    const ws = this.sets.get(guildId);
    if (!ws || ws.state === 'hydrating' || ws.state === 'failed') {
      this.wsBypassReads += 1;
      console.warn(`[Data] Read for guild ${guildId} before its working set is ready; serving default`);
      return { status: 'not-ready' };
    }
    const doc = ws.docs.get(docKeyOf(module, filename));
    if (!doc || doc.tombstone) return { status: 'ready', value: undefined };
    if (doc.parsed === undefined) doc.parsed = JSON.parse(doc.content);
    // Clone preserves today's read isolation (a fresh parse per disk read).
    return { status: 'ready', value: structuredClone(doc.parsed) };
  }

  exists(guildId: string, module: string, filename: string): boolean | null {
    const ws = this.sets.get(guildId);
    if (!ws || ws.state === 'hydrating' || ws.state === 'failed') return null;
    const key = docKeyOf(module, filename);
    const doc = ws.docs.get(key);
    if (doc) return !doc.tombstone;
    return ws.appendKeys.has(key);
  }

  save(guildId: string, module: string, filename: string, content: string): WsWriteResult {
    const gate = this.writeGate(guildId);
    if (gate !== 'ok') return gate;
    const ws = this.sets.get(guildId)!;
    const key = docKeyOf(module, filename);
    const now = Date.now();
    const prev = ws.docs.get(key);
    if (prev) this.dirtyBytes -= prev.dirty ? prev.content.length : 0;
    ws.docs.set(key, { content, tombstone: false, dirty: true, dirtySince: prev?.dirty ? prev.dirtySince : now });
    this.dirtyBytes += content.length;
    this.markDirty(ws, key, now);
    return 'accepted';
  }

  append(guildId: string, module: string, filename: string, line: string): WsWriteResult {
    const gate = this.writeGate(guildId);
    if (gate !== 'ok') return gate;
    const ws = this.sets.get(guildId)!;
    const key = docKeyOf(module, filename);
    const now = Date.now();
    const buf = ws.appendBuf.get(key);
    if (buf) buf.chunk += line;
    else ws.appendBuf.set(key, { chunk: line, dirtySince: now });
    ws.appendKeys.add(key);
    this.dirtyBytes += line.length;
    this.markDirty(ws, key, now);
    return 'accepted';
  }

  delete(guildId: string, module: string, filename: string): WsWriteResult | 'absent' {
    const gate = this.writeGate(guildId);
    if (gate !== 'ok') return gate;
    const ws = this.sets.get(guildId)!;
    const key = docKeyOf(module, filename);
    const doc = ws.docs.get(key);
    const hasStream = ws.appendKeys.has(key);
    if ((!doc || doc.tombstone) && !hasStream) return 'absent';
    const now = Date.now();
    if (doc) {
      if (doc.dirty) this.dirtyBytes -= doc.content.length;
      doc.tombstone = true;
      doc.parsed = undefined;
      doc.dirty = true;
      doc.dirtySince = doc.dirtySince || now;
    } else {
      ws.docs.set(key, { content: '', tombstone: true, dirty: true, dirtySince: now });
    }
    const buf = ws.appendBuf.get(key);
    if (buf) { this.dirtyBytes -= buf.chunk.length; ws.appendBuf.delete(key); }
    ws.appendKeys.delete(key);
    this.markDirty(ws, key, now);
    return 'accepted';
  }

  /** Non-recursive top-level .json listing parity for a module dir. */
  listFiles(guildId: string, module: string): string[] | null {
    const ws = this.sets.get(guildId);
    if (!ws || ws.state === 'hydrating' || ws.state === 'failed') return null;
    const names = new Set<string>();
    const collect = (key: string, tombstoned: boolean) => {
      const { module: m, filename } = splitDocKey(key);
      if (m !== module || tombstoned) return;
      if (!filename.includes('/') && filename.endsWith('.json')) names.add(filename);
    };
    for (const [key, doc] of ws.docs) collect(key, doc.tombstone);
    for (const key of ws.appendKeys) collect(key, false);
    return [...names];
  }

  // --------------------------------------------------------------------------
  // Coalescing + flush
  // --------------------------------------------------------------------------

  private writeGate(guildId: string): 'ok' | Exclude<WsWriteResult, 'accepted'> {
    const ws = this.sets.get(guildId);
    if (!ws || ws.state === 'hydrating' || ws.state === 'failed') {
      this.wsBypassWrites += 1;
      return 'not-ready';
    }
    if (ws.state === 'frozen-retained') return 'frozen-window';
    if (ws.state === 'fenced') return 'fenced';
    if (this.health === 'refusing') return 'refusing';
    return 'ok';
  }

  private markDirty(ws: GuildWorkingSet, key: string, now: number): void {
    ws.dirtyKeys.add(key);
    if (ws.flushInFlight) {
      ws.requeue = true;
      return;
    }
    if (ws.windowOpenedAt === null) ws.windowOpenedAt = now;
    if (ws.debounceTimer) clearTimeout(ws.debounceTimer);
    const sinceOpen = now - ws.windowOpenedAt;
    const wait = Math.min(DEBOUNCE_MS, Math.max(0, MAX_DELAY_MS - sinceOpen));
    ws.debounceTimer = setTimeout(() => { void this.flush(ws); }, wait);
    this.checkBounds(now);
  }

  private buildBatch(ws: GuildWorkingSet): { batch: GuildFlushBatch; flushedKeys: string[]; appendLens: Map<string, number>; bytes: number } {
    const batch: GuildFlushBatch = { upserts: [], deletes: [], appends: [] };
    const appendLens = new Map<string, number>();
    let bytes = 0;
    const flushedKeys = [...ws.dirtyKeys];
    for (const key of flushedKeys) {
      const dk = splitDocKey(key);
      const doc = ws.docs.get(key);
      const buf = ws.appendBuf.get(key);
      if (doc?.tombstone) {
        batch.deletes.push(dk);
      } else if (doc?.dirty) {
        batch.upserts.push({ key: dk, doc: doc.content });
        bytes += doc.content.length;
      }
      if (buf && buf.chunk.length > 0) {
        batch.appends.push({ key: dk, chunk: buf.chunk });
        appendLens.set(key, buf.chunk.length);
        bytes += buf.chunk.length;
      }
    }
    return { batch, flushedKeys, appendLens, bytes };
  }

  private async flush(ws: GuildWorkingSet): Promise<void> {
    if (ws.flushInFlight) { ws.requeue = true; return; }
    if (ws.debounceTimer) { clearTimeout(ws.debounceTimer); ws.debounceTimer = null; }
    if (ws.dirtyKeys.size === 0) { ws.windowOpenedAt = null; return; }

    const { batch, flushedKeys, appendLens, bytes } = this.buildBatch(ws);
    ws.dirtyKeys = new Set();
    ws.windowOpenedAt = null;
    ws.flushInFlight = true;
    const outcome = await this.backend.flushGuild(ws.guildId, batch, ws.fence);
    ws.flushInFlight = false;

    if (outcome.ok) {
      for (const key of flushedKeys) {
        if (ws.dirtyKeys.has(key)) continue; // re-dirtied mid-flight; next window owns it
        const doc = ws.docs.get(key);
        if (doc?.tombstone) ws.docs.delete(key);
        else if (doc) doc.dirty = false;
      }
      for (const [key, len] of appendLens) {
        const buf = ws.appendBuf.get(key);
        if (!buf) continue;
        buf.chunk = buf.chunk.slice(len);
        if (buf.chunk.length === 0 && !ws.dirtyKeys.has(key)) ws.appendBuf.delete(key);
      }
      this.dirtyBytes = Math.max(0, this.dirtyBytes - bytes);
      this.noteFlushSuccess();
      if (ws.requeue || ws.dirtyKeys.size > 0) {
        ws.requeue = false;
        this.markDirty(ws, [...ws.dirtyKeys][0] ?? '', Date.now());
        if (ws.dirtyKeys.size === 0) { ws.windowOpenedAt = null; if (ws.debounceTimer) { clearTimeout(ws.debounceTimer); ws.debounceTimer = null; } }
      }
      return;
    }

    if (outcome.reason === 'deposed') {
      this.onDeposed(ws, outcome.currentOwner);
      return;
    }
    // unavailable: everything stays dirty; merge back and retry under backoff.
    for (const key of flushedKeys) ws.dirtyKeys.add(key);
    ws.requeue = false;
    this.noteFlushFailure('flush unavailable');
    this.scheduleRetry();
  }

  private onDeposed(ws: GuildWorkingSet, owner?: { nodeId: string; term: number; epoch: number }): void {
    this.fencedFlushRejections += 1;
    this.lastError = `guild ${ws.guildId} fenced by ${owner?.nodeId ?? 'unknown'} (term ${owner?.term ?? '?'}, epoch ${owner?.epoch ?? '?'})`;
    console.error(`[Data] Deposed writer: ${this.lastError}; dropping the guild's working set without flushing`);
    // Drop dirty accounting; the flush is never retried (a deposed node's
    // leftover writes are never merged later - that would be a second writer).
    this.forgetDirty(ws);
    ws.state = 'fenced';
    ws.clearTimers();
    ws.fencedDrainTimer = setTimeout(() => this.evict(ws.guildId), FENCED_DRAIN_MS);
    ws.fencedDrainTimer.unref();
  }

  private forgetDirty(ws: GuildWorkingSet): void {
    for (const key of ws.dirtyKeys) {
      const doc = ws.docs.get(key);
      if (doc?.dirty) this.dirtyBytes -= doc.content.length;
    }
    for (const buf of ws.appendBuf.values()) this.dirtyBytes -= buf.chunk.length;
    if (this.dirtyBytes < 0) this.dirtyBytes = 0;
    ws.dirtyKeys.clear();
    ws.appendBuf.clear();
    ws.windowOpenedAt = null;
  }

  /**
   * Deadline-bounded immediate flush ('ok' = committed, 'pending' = accepted
   * and still retrying - callers report "queued, not yet durable").
   */
  async flushGuildNow(guildId: string, deadlineMs: number): Promise<FlushNowOutcome> {
    const ws = this.sets.get(guildId);
    if (!ws || ws.dirtyKeys.size === 0) return 'ok';
    if (ws.state === 'fenced') return 'deposed';
    const done = this.flush(ws);
    const timeout = new Promise<'timeout'>(resolve => {
      const t = setTimeout(() => resolve('timeout'), deadlineMs);
      t.unref();
    });
    const raced = await Promise.race([done.then(() => 'done' as const), timeout]);
    if (raced === 'timeout') return 'pending';
    if ((this.sets.get(guildId)?.state ?? 'ready') === 'fenced') return 'deposed';
    return this.sets.get(guildId)?.dirtyKeys.size === 0 ? 'ok' : 'unavailable';
  }

  /** Flush every dirty guild (shutdown drain; the caller bounds it). */
  async flushAllDirty(): Promise<string[]> {
    const dirty = [...this.sets.values()].filter(ws => ws.dirtyKeys.size > 0);
    await Promise.all(dirty.map(ws => this.flush(ws)));
    return [...this.sets.values()].filter(ws => ws.dirtyKeys.size > 0).map(ws => ws.guildId);
  }

  // --------------------------------------------------------------------------
  // C1 acceptance window + retry machinery
  // --------------------------------------------------------------------------

  private noteFlushSuccess(): void {
    this.retryAttempt = 0;
    this.lastError = null;
    if (this.health === 'healthy') return;
    // Hysteresis: reopen only when the backlog has genuinely drained.
    const oldest = this.oldestDirtyMs();
    if (this.dirtyBytes < ACCEPT_BYTES / 2 && oldest < ACCEPT_WINDOW_MS) {
      if (this.health === 'refusing') console.warn('[Data] Write acceptance reopened (backlog drained)');
      this.health = 'healthy';
    }
  }

  private noteFlushFailure(error: string): void {
    this.lastError = error;
    if (this.health === 'healthy') this.health = 'degraded';
    this.checkBounds(Date.now());
  }

  private checkBounds(_now: number): void {
    if (this.health === 'refusing') return;
    if (this.dirtyBytes > ACCEPT_BYTES || this.oldestDirtyMs() > ACCEPT_WINDOW_MS) {
      this.health = 'refusing';
      console.error(`[Data] Write acceptance CLOSED (backlog ${Math.round(this.dirtyBytes / 1024)} KiB, oldest ${Math.round(this.oldestDirtyMs() / 1000)}s); guild writes now fail loudly until the backend recovers`);
    }
  }

  private oldestDirtyMs(): number {
    let oldest = 0;
    const now = Date.now();
    for (const ws of this.sets.values()) {
      for (const key of ws.dirtyKeys) {
        const doc = ws.docs.get(key);
        if (doc?.dirty && doc.dirtySince > 0) oldest = Math.max(oldest, now - doc.dirtySince);
      }
      for (const buf of ws.appendBuf.values()) {
        if (buf.chunk.length > 0) oldest = Math.max(oldest, now - buf.dirtySince);
      }
    }
    return oldest;
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    const wait = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** this.retryAttempt) * (0.5 + Math.random() * 0.5);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const dirty = [...this.sets.values()].filter(ws => ws.dirtyKeys.size > 0 && !ws.flushInFlight && ws.state !== 'fenced');
      // Paced recovery: a few guild transactions at a time.
      void (async () => {
        for (let i = 0; i < dirty.length; i += 4) {
          await Promise.all(dirty.slice(i, i + 4).map(ws => this.flush(ws)));
        }
      })();
    }, wait);
    this.retryTimer.unref();
  }

  getBackendHealth(): BackendHealth {
    return {
      state: this.health,
      oldestDirtyMs: this.oldestDirtyMs(),
      dirtyBytes: this.dirtyBytes,
      lastError: this.lastError,
    };
  }

  getCounters(): { wsBypassReads: number; wsBypassWrites: number; fencedFlushRejections: number } {
    return {
      wsBypassReads: this.wsBypassReads,
      wsBypassWrites: this.wsBypassWrites,
      fencedFlushRejections: this.fencedFlushRejections,
    };
  }
}

// Singleton wiring: constructed at boot only when the deployment default (or
// any route) is postgres; null in pure file mode so the facade's file path
// stays a compiled-in passthrough.
let manager: WorkingSetManager | null = null;

export function initWorkingSet(backend: DataBackend): WorkingSetManager {
  manager = new WorkingSetManager(backend);
  return manager;
}

export function getWorkingSet(): WorkingSetManager | null {
  return manager;
}
