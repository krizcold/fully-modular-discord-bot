// Working Set - per-guild docs in RAM for postgres-routed guilds. The frozen
// sync facade answers from here; a coalescing write-behind flushes each guild's
// dirty docs as ONE fenced transaction per window. Reads never block on the
// database; writes are accepted into RAM with a bounded durability window and
// refuse loudly (never silently) when that window cannot be honored.

import { DataBackend, DocKey, FenceToken, GuildFlushBatch, GuildOwner } from './backend';
import { setLeft } from './scopeRecord';

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
export type FlushNowOutcome = 'ok' | 'pending' | 'held' | 'deposed' | 'unavailable';

/** One accepted write, as confirm answers for it; opaque to its holder. */
export interface WsTicket {
  readonly kind: 'ws';
  readonly manager: WorkingSetManager;
  readonly set: GuildWorkingSet;
  readonly guildId: string;
  readonly seq: number;
}

/**
 * Thrown by the facade for a write the backend cannot honor (acceptance window
 * closed, the guild fenced by a newer owner, or the process past its exit
 * drain). Module code never catches it by contract; the dispatch wrappers do
 * and surface the cause.
 */
export type DataUnavailableCause = 'database-unreachable' | 'database-backlog' | 'guild-fenced' | 'node-stopping' | 'storage-failing';

export class DataBackendUnavailableError extends Error {
  constructor(readonly causeKey: DataUnavailableCause, detail?: string) {
    super(detail ?? (causeKey === 'guild-fenced'
      ? '[Data] Another bot process took over this guild; the write was not saved'
      : causeKey === 'node-stopping'
        ? '[Data] This process is stopping and its exit drain has closed; the write was not saved'
        : causeKey === 'storage-failing'
          ? '[Data] Disk writes have been failing too long or too much is held in memory; the write was not saved'
          : causeKey === 'database-backlog'
            ? '[Data] The data backend is behind on storing writes; the write was not saved'
            : '[Data] The data backend is unreachable; the write was not saved'));
    this.name = 'DataBackendUnavailableError';
  }
}

interface WorkingDoc {
  content: string;
  parsed?: unknown;
  tombstone: boolean;
  dirty: boolean;
  /** Accepted-at of its oldest write no landed flush holds, 0 when none (window accounting). */
  dirtySince: number;
  /** Accepted-at of its oldest write since its last batch was built, 0 when none. */
  sinceBatch: number;
  /** The seq of its latest write here, 0 when hydrated: a tombstone's is its delete's. */
  seq: number;
  /** Its content's UTF-8 size, measured once: a doc's content never changes in place. */
  bytes?: number;
}

type WsState = 'hydrating' | 'ready' | 'frozen-retained' | 'fenced' | 'failed';

interface AppendBuffer {
  chunk: string;
  /** As a doc's: its oldest line no landed flush holds, 0 when none. */
  dirtySince: number;
  /** Its oldest line since its chunk was last sent, 0 when none. */
  sinceBatch: number;
  /** The length of its start in the batch on the wire, 0 while none is: that batch's commit slices it off. */
  sent: number;
  /** The chunk's UTF-8 size. */
  bytes: number;
}

class GuildWorkingSet {
  state: WsState = 'hydrating';
  readonly docs = new Map<string, WorkingDoc>();
  readonly appendKeys = new Set<string>();
  readonly appendBuf = new Map<string, AppendBuffer>();
  dirtyKeys = new Set<string>();
  // The keys of the batch on the wire: the window's age reads them until it lands or fails.
  flightKeys = new Set<string>();
  windowOpenedAt: number | null = null;
  debounceTimer: NodeJS.Timeout | null = null;
  flushInFlight = false;
  requeue = false;
  fencedDrainTimer: NodeJS.Timeout | null = null;
  readyWaiters: ReadyWaiter[] = [];
  // Stamped at every accepted save, append and delete. landedSeq is the stamp
  // a committed batch was built at: every write at or below it landed, or a
  // later write of its document did.
  writeSeq = 0;
  landedSeq = 0;

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

type HydrateOutcome = 'ready' | 'deposed' | 'unavailable' | 'evicted';
type ReadyWaiter = (result: 'ready' | 'gone' | 'not-ready') => void;

/** A hydrate on the wire: the set it reads the store for, once it has one. */
interface HydrationInFlight {
  token: FenceToken;
  set: GuildWorkingSet | undefined;
  outcome: Promise<HydrateOutcome>;
}

function sameGrant(a: FenceToken, b: FenceToken): boolean {
  return a.claim === b.claim;
}

export class WorkingSetManager {
  private readonly sets = new Map<string, GuildWorkingSet>();
  private health: BackendHealth['state'] = 'healthy';
  private lastError: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private readonly hydrations = new Map<string, HydrationInFlight>();
  // Those waiting on a set evicted before it went ready, until the next set read for the guild takes them on.
  private readonly parkedWaiters = new Map<string, ReadyWaiter[]>();
  // Counters driven to zero by the drill matrix (non-gated callers touching
  // guilds whose working set is not ready).
  private wsBypassReads = 0;
  private wsBypassWrites = 0;
  private fencedFlushRejections = 0;
  private landed = 0;

  constructor(private readonly backend: DataBackend) {}

  /**
   * Guilds holding unflushed writes right now (exit drain accounting). A flush
   * already on the wire counts: it emptied its dirty set before awaiting, so it
   * would otherwise read as clean.
   */
  dirtyGuildIds(): string[] {
    return [...this.sets.values()].filter(ws => ws.dirtyKeys.size > 0 || ws.flushInFlight).map(ws => ws.guildId);
  }

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
   * Hydrate a guild (claim-then-read); a partially hydrated guild is never served. 'unavailable': the store did not
   * answer and the set keeps waiting, or the set was replaced while it read; the caller retries against whatever
   * serves the guild now. 'evicted': the set was evicted while it read or reclaimed and none took its place, whatever
   * the store answered (a deposed read still answers 'deposed'), so nothing is retried; the guild's next access reads
   * it again. Those waiting on a set evicted before it went ready wait on the next set read for the guild, or, with
   * none hydrating in its place when its read answers, are told it is gone (awaitReady answers 'gone') and go back
   * through their gate.
   */
  hydrate(guildId: string, token: FenceToken): Promise<HydrateOutcome> {
    // One store hydration per set: a second call joins it, or under another grant runs once it ends, so no read of
    // the store lands over the writes and freezes made since the first one ended. A set that replaced the
    // one on the wire is hydrated by its own call; the call on the wire leaves it alone.
    const running = this.hydrations.get(guildId);
    if (running && running.set === this.sets.get(guildId)) {
      return running.outcome.then(outcome => sameGrant(running.token, token) ? outcome : this.hydrate(guildId, token));
    }
    const entry: HydrationInFlight = { token, set: undefined, outcome: Promise.resolve<HydrateOutcome>('unavailable') };
    this.hydrations.set(guildId, entry);
    entry.outcome = this.hydrateSet(guildId, token, ws => { entry.set = ws; });
    const clear = () => { if (this.hydrations.get(guildId) === entry) this.hydrations.delete(guildId); };
    entry.outcome.then(clear, clear);
    return entry.outcome;
  }

  private async hydrateSet(guildId: string, token: FenceToken, sending: (ws: GuildWorkingSet) => void): Promise<HydrateOutcome> {
    let ws = this.sets.get(guildId);
    // A set kept since its lease left is current only while no other bot
    // process has claimed the guild since: re-stamped for the new grant, or dropped
    // and read again. No flush of its old writes starts meanwhile.
    if (ws?.state === 'frozen-retained') {
      if (ws.flushInFlight) return 'unavailable';
      const retained = ws;
      retained.flushInFlight = true;
      sending(retained);
      const reclaim = await this.backend.reclaimGuild(guildId, token);
      retained.flushInFlight = false;
      if (retained.requeue || retained.dirtyKeys.size > 0) {
        retained.requeue = false;
        this.scheduleRetry();
      }
      ws = this.sets.get(guildId);
      // Evicted while it reclaimed: another set in its place is served by its own call, and with none the guild's
      // next access reads it again, whatever the store answered.
      if (!ws) return 'evicted';
      if (reclaim === null || ws !== retained) return 'unavailable';
      if (reclaim === 'lost' && ws === retained) {
        if (retained.dirtyKeys.size > 0) {
          console.warn(`[Data] Guild ${guildId}: ${retained.dirtyKeys.size} unflushed write(s) kept since its lease left are dropped: another bot process took over the guild since; it is read again from the store`);
        }
        this.evict(guildId);
        ws = undefined;
      }
    }
    if (ws && (ws.state === 'ready' || ws.state === 'frozen-retained')) {
      ws.fence = token;
      if (ws.state === 'frozen-retained') ws.state = 'ready';
      return 'ready';
    }
    // A deposed set is never revived: a new one is read.
    if (ws?.state === 'fenced') {
      this.evict(guildId);
      ws = undefined;
    }
    if (!ws) {
      ws = new GuildWorkingSet(guildId, token);
      this.sets.set(guildId, ws);
      ws.readyWaiters.push(...this.takeParked(guildId));
    }
    ws.fence = token;
    sending(ws);
    const outcome = await this.backend.hydrateGuild(guildId, token);
    // Evicted or replaced while it read: what it read is applied to nothing. With none in its place, a deposed
    // answer still says a newer owner holds the guild; any other answer is 'evicted'.
    if (this.sets.get(guildId) !== ws) {
      this.handOnWaiters(guildId);
      if (!outcome.ok && outcome.reason === 'deposed') return 'deposed';
      return this.sets.has(guildId) ? 'unavailable' : 'evicted';
    }
    if (!outcome.ok) {
      if (outcome.reason === 'deposed') {
        if (ws.state === 'hydrating') this.evict(guildId);
        return 'deposed';
      }
      return 'unavailable';
    }
    if (ws.state !== 'hydrating') return 'unavailable';
    // A no-rows guild becomes ready empty; docs land as raw text, parsed lazily.
    for (const { key, doc } of outcome.docs) {
      const docKey = docKeyOf(key.module, key.filename);
      if (ws.docs.get(docKey)?.dirty) continue;
      ws.docs.set(docKey, { content: doc, tombstone: false, dirty: false, dirtySince: 0, sinceBatch: 0, seq: 0 });
    }
    for (const key of outcome.appendKeys) {
      ws.appendKeys.add(docKeyOf(key.module, key.filename));
    }
    ws.state = 'ready';
    for (const wake of ws.readyWaiters.splice(0)) wake('ready');
    return 'ready';
  }

  /**
   * A set evicted before it went ready, as its read answers: those waiting on it wait on the set hydrating in its
   * place, or are told it is gone, so their gate decides again from the guild's route, lease and set now.
   */
  private handOnWaiters(guildId: string): void {
    const next = this.sets.get(guildId);
    const parked = this.takeParked(guildId);
    if (next?.state === 'hydrating') next.readyWaiters.push(...parked);
    else for (const wake of parked) wake('gone');
  }

  /**
   * Its claim declined: those waiting on the guild's evicted set are answered not ready (an event is dropped with the
   * warning, an interaction refused) rather than told it is gone, which would claim the guild again.
   */
  dropWaiters(guildId: string): void {
    for (const wake of this.takeParked(guildId)) wake('not-ready');
  }

  private takeParked(guildId: string): ReadyWaiter[] {
    const parked = this.parkedWaiters.get(guildId) ?? [];
    this.parkedWaiters.delete(guildId);
    return parked;
  }

  /**
   * Same-shape re-grant: refresh a served set's fence only, never
   * re-hydrate. A kept set takes a new fence only through hydrate's
   * re-stamp, so its late flush stays deposed by any newer claim.
   */
  refreshFence(guildId: string, token: FenceToken): void {
    const ws = this.sets.get(guildId);
    if (ws?.state === 'ready') ws.fence = token;
  }

  /**
   * Lease removed: one final immediate flush under the OLD fence, then the set
   * enters frozen-retained (reads keep serving, writes get the frozen
   * rejection).
   */
  async unloadToFrozenRetained(guildId: string, stillGone: () => boolean = () => true): Promise<void> {
    const ws = this.sets.get(guildId);
    if (!ws || ws.state === 'fenced') return;
    await this.flushGuildNow(guildId, MAX_DELAY_MS);
    // A lease back while the flush ran keeps the set served.
    if (ws.state === 'ready' && stillGone()) ws.state = 'frozen-retained';
  }

  /** Frozen under an older grant than the token's: a hydrate under the token serves it again. */
  frozenBefore(guildId: string, token: FenceToken): boolean {
    const ws = this.sets.get(guildId);
    return ws?.state === 'frozen-retained' && ws.fence.claim !== token.claim;
  }

  evict(guildId: string): void {
    const ws = this.sets.get(guildId);
    if (!ws) return;
    ws.clearTimers();
    this.forgetDirty(ws);
    this.sets.delete(guildId);
    // Its waiters wait on the next set read for the guild; until then its read's answer, a declined claim or their
    // timer answers them.
    if (ws.readyWaiters.length > 0) this.parkedWaiters.set(guildId, [...this.takeParked(guildId), ...ws.readyWaiters.splice(0)]);
    setLeft(ws);
  }

  /**
   * Await a guild's working set becoming ready (the data-ready gate). 'gone': the set was evicted before it went
   * ready, with none hydrating in its place, so the caller's gate decides again. 'not-ready': the wait ended with the
   * guild not ready, or the guild's claim was declined (dropWaiters).
   */
  awaitReady(guildId: string, timeoutMs: number): Promise<'ready' | 'gone' | 'not-ready'> {
    const ws = this.sets.get(guildId);
    if (!ws) return Promise.resolve('not-ready');
    if (ws.state === 'ready' || ws.state === 'frozen-retained') return Promise.resolve('ready');
    if (ws.state !== 'hydrating') return Promise.resolve('not-ready');
    return new Promise(resolve => {
      const waiter: ReadyWaiter = result => { clearTimeout(timer); resolve(result); };
      const timer = setTimeout(() => {
        const parked = this.parkedWaiters.get(guildId) ?? [];
        if (parked.includes(waiter)) parked.splice(parked.indexOf(waiter), 1);
        if (parked.length === 0) this.parkedWaiters.delete(guildId);
        resolve(this.stateOf(guildId) === 'ready' ? 'ready' : 'not-ready');
      }, timeoutMs);
      timer.unref();
      ws.readyWaiters.push(waiter);
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

  /**
   * update(fn)'s read: not-ready with no bypass counted, 'stream' for a document written by appends (a whole write
   * would replace its lines). Throws for a stored document that does not parse.
   */
  readForUpdate(guildId: string, module: string, filename: string): WsReadResult | { status: 'stream' } {
    const ws = this.sets.get(guildId);
    if (!ws || ws.state === 'hydrating' || ws.state === 'failed') return { status: 'not-ready' };
    if (ws.appendKeys.has(docKeyOf(module, filename))) return { status: 'stream' };
    return this.read(guildId, module, filename);
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
    ws.writeSeq += 1;
    ws.docs.set(key, { content, tombstone: false, dirty: true, dirtySince: prev?.dirtySince || now, sinceBatch: prev?.sinceBatch || now, seq: ws.writeSeq });
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
    if (buf) {
      buf.chunk += line;
      buf.bytes += Buffer.byteLength(line);
      buf.dirtySince ||= now;
      buf.sinceBatch ||= now;
    } else ws.appendBuf.set(key, { chunk: line, dirtySince: now, sinceBatch: now, sent: 0, bytes: Buffer.byteLength(line) });
    ws.appendKeys.add(key);
    ws.writeSeq += 1;
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
    ws.writeSeq += 1;
    // The lines it drops wait on it: it takes their age, and lands for them.
    const buf = ws.appendBuf.get(key);
    const earliest = (...at: number[]) => Math.min(...at.filter(t => t > 0));
    const dirtySince = earliest(doc?.dirtySince ?? 0, buf?.dirtySince ?? 0, now);
    const sinceBatch = earliest(doc?.sinceBatch ?? 0, buf?.sinceBatch ?? 0, now);
    if (doc) {
      doc.tombstone = true;
      doc.parsed = undefined;
      doc.dirty = true;
      doc.dirtySince = dirtySince;
      doc.sinceBatch = sinceBatch;
      doc.seq = ws.writeSeq;
    } else {
      ws.docs.set(key, { content: '', tombstone: true, dirty: true, dirtySince, sinceBatch, seq: ws.writeSeq });
    }
    ws.appendBuf.delete(key);
    ws.appendKeys.delete(key);
    this.markDirty(ws, key, now);
    return 'accepted';
  }

  /** A ticket at this guild's set's latest write, taken in that write's own synchronous run. */
  ticketFor(guildId: string): WsTicket {
    const ws = this.sets.get(guildId)!;
    return { kind: 'ws', manager: this, set: ws, guildId, seq: ws.writeSeq };
  }

  /**
   * For a delete that found the document already deleted: a ticket at that
   * earlier delete, else null. A served set drops a tombstone once it commits,
   * unless the document was written and deleted again during that flight: the
   * ticket then names that later delete.
   */
  unlandedDeleteTicket(guildId: string, module: string, filename: string): WsTicket | null {
    const doc = this.sets.get(guildId)?.docs.get(docKeyOf(module, filename));
    return doc?.tombstone ? { ...this.ticketFor(guildId), seq: doc.seq } : null;
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

  /** Raw JSON text of a live doc; null when absent or the set is not ready. */
  readDocRaw(guildId: string, module: string, filename: string): string | null {
    const ws = this.sets.get(guildId);
    if (!ws || ws.state === 'hydrating' || ws.state === 'failed') return null;
    const doc = ws.docs.get(docKeyOf(module, filename));
    if (!doc || doc.tombstone) return null;
    return doc.content;
  }

  /** Every live doc key across all modules (guild-dir scan parity). */
  listAllKeys(guildId: string): DocKey[] | null {
    const ws = this.sets.get(guildId);
    if (!ws || ws.state === 'hydrating' || ws.state === 'failed') return null;
    const keys = new Set<string>();
    for (const [key, doc] of ws.docs) {
      if (!doc.tombstone) keys.add(key);
    }
    for (const key of ws.appendKeys) keys.add(key);
    return [...keys].map(splitDocKey);
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
    // What held it closed may have left with no flush landing (a deposed or evicted set).
    this.reopenIfDrained();
    if (this.health === 'refusing') return 'refusing';
    return 'ok';
  }

  private markDirty(ws: GuildWorkingSet, key: string, now: number): void {
    ws.dirtyKeys.add(key);
    if (ws.flushInFlight) {
      ws.requeue = true;
      this.checkBounds(now);
      return;
    }
    if (ws.windowOpenedAt === null) ws.windowOpenedAt = now;
    if (ws.debounceTimer) clearTimeout(ws.debounceTimer);
    const sinceOpen = now - ws.windowOpenedAt;
    const wait = Math.min(DEBOUNCE_MS, Math.max(0, MAX_DELAY_MS - sinceOpen));
    ws.debounceTimer = setTimeout(() => { void this.flush(ws); }, wait);
    this.checkBounds(now);
  }

  private buildBatch(ws: GuildWorkingSet): { batch: GuildFlushBatch; flushedKeys: string[]; sentBufs: Map<string, AppendBuffer>; seq: number } {
    const batch: GuildFlushBatch = { upserts: [], deletes: [], appends: [] };
    const sentBufs = new Map<string, AppendBuffer>();
    const flushedKeys = [...ws.dirtyKeys];
    for (const key of flushedKeys) {
      const dk = splitDocKey(key);
      const doc = ws.docs.get(key);
      const buf = ws.appendBuf.get(key);
      if (doc?.tombstone) {
        batch.deletes.push(dk);
        doc.sinceBatch = 0;
      } else if (doc?.dirty) {
        batch.upserts.push({ key: dk, doc: doc.content });
        doc.sinceBatch = 0;
      }
      if (buf && buf.chunk.length > 0) {
        batch.appends.push({ key: dk, chunk: buf.chunk });
        buf.sent = buf.chunk.length;
        buf.sinceBatch = 0;
        sentBufs.set(key, buf);
      }
    }
    return { batch, flushedKeys, sentBufs, seq: ws.writeSeq };
  }

  /** True once this call's batch committed. */
  private async flush(ws: GuildWorkingSet): Promise<boolean> {
    if (ws.flushInFlight) { ws.requeue = true; return false; }
    if (ws.debounceTimer) { clearTimeout(ws.debounceTimer); ws.debounceTimer = null; }
    if (ws.dirtyKeys.size === 0) { ws.windowOpenedAt = null; return false; }

    const { batch, flushedKeys, sentBufs, seq } = this.buildBatch(ws);
    ws.dirtyKeys = new Set();
    ws.flightKeys = new Set(flushedKeys);
    ws.windowOpenedAt = null;
    ws.flushInFlight = true;
    const outcome = await this.backend.flushGuild(ws.guildId, batch, ws.fence);
    ws.flushInFlight = false;
    ws.flightKeys = new Set();
    // A refused batch holds no buffer's start any more: the next one sends each whole.
    if (!outcome.ok) for (const buf of sentBufs.values()) buf.sent = 0;

    if (outcome.ok) {
      // An evicted or replaced set dropped its unflushed writes, so what it
      // commits after that vouches for none.
      if (!this.leftHere(ws)) ws.landedSeq = seq;
      for (const key of flushedKeys) {
        const doc = ws.docs.get(key);
        // What it holds unstored now is what was written since the build.
        if (doc) doc.dirtySince = doc.sinceBatch;
        if (ws.dirtyKeys.has(key)) continue; // re-dirtied mid-flight; next window owns it
        if (doc?.tombstone) ws.docs.delete(key);
        else if (doc) doc.dirty = false;
      }
      for (const [key, buf] of sentBufs) {
        // A delete dropped the flushed buffer meanwhile: one there now holds only newer appends.
        if (ws.appendBuf.get(key) !== buf) continue;
        buf.chunk = buf.chunk.slice(buf.sent);
        buf.bytes = Buffer.byteLength(buf.chunk);
        buf.sent = 0;
        buf.dirtySince = buf.sinceBatch;
        if (buf.chunk.length === 0 && !ws.dirtyKeys.has(key)) ws.appendBuf.delete(key);
      }
      this.landed += 1;
      this.noteFlushSuccess();
      if (ws.requeue || ws.dirtyKeys.size > 0) {
        ws.requeue = false;
        this.markDirty(ws, [...ws.dirtyKeys][0] ?? '', Date.now());
        if (ws.dirtyKeys.size === 0) { ws.windowOpenedAt = null; if (ws.debounceTimer) { clearTimeout(ws.debounceTimer); ws.debounceTimer = null; } }
      }
      return true;
    }

    if (outcome.reason === 'deposed') {
      this.onDeposed(ws, outcome.currentOwner);
      return false;
    }
    // unavailable: everything stays dirty; merge back and retry under backoff.
    for (const key of flushedKeys) ws.dirtyKeys.add(key);
    ws.requeue = false;
    this.noteFlushFailure('flush unavailable');
    this.scheduleRetry();
    return false;
  }

  private onDeposed(ws: GuildWorkingSet, owner?: GuildOwner): void {
    this.fencedFlushRejections += 1;
    this.lastError = `guild ${ws.guildId} fenced by ${owner?.nodeId ?? 'unknown'} (claim ${owner?.claim ?? '?'})`;
    console.error(`[Data] Deposed writer: ${this.lastError}; dropping the guild's working set without flushing`);
    // Drop dirty accounting; the flush is never retried (a deposed node's
    // leftover writes are never merged later - that would be a second writer).
    this.forgetDirty(ws);
    ws.state = 'fenced';
    ws.clearTimers();
    ws.fencedDrainTimer = setTimeout(() => {
      if (this.sets.get(ws.guildId) === ws) this.evict(ws.guildId);
    }, FENCED_DRAIN_MS);
    ws.fencedDrainTimer.unref();
  }

  private forgetDirty(ws: GuildWorkingSet): void {
    ws.dirtyKeys.clear();
    ws.appendBuf.clear();
    ws.windowOpenedAt = null;
  }

  /** The set answers for its writes here no more: it was evicted or replaced. */
  private leftHere(ws: GuildWorkingSet): boolean {
    return this.sets.get(ws.guildId) !== ws;
  }

  /**
   * Deadline-bounded immediate flush ('ok' = committed, 'pending' = accepted
   * and still retrying - callers report "queued, not yet durable"). A flush
   * already on the wire emptied the dirty set before awaiting, so it is
   * waited for: its writes are durable only once it settles.
   */
  async flushGuildNow(guildId: string, deadlineMs: number): Promise<FlushNowOutcome> {
    const ws = this.sets.get(guildId);
    if (!ws) return 'ok';
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      if (ws.state === 'fenced') return 'deposed';
      if (this.leftHere(ws)) return 'unavailable';
      const left = deadline - Date.now();
      if (ws.flushInFlight) {
        if (left <= 0) return 'pending';
        await new Promise<void>(resolve => { setTimeout(resolve, Math.min(20, left)); });
        continue;
      }
      if (ws.dirtyKeys.size === 0) return 'ok';
      if (left <= 0) return 'pending';
      const timeout = new Promise<'timeout'>(resolve => {
        const t = setTimeout(() => resolve('timeout'), left);
        t.unref();
      });
      const committed = await Promise.race([this.flush(ws), timeout]);
      // Once the set left here, its flush's commit, timeout or refusal vouches for none of its writes; fenced, it
      // still answers deposed.
      if (committed === 'timeout') return this.leftHere(ws) ? 'unavailable' : 'pending';
      if (committed) return this.leftHere(ws) ? 'unavailable' : 'ok';
      if ((ws.state as WsState) === 'fenced') return 'deposed';
      // Refused by the store (unreachable): kept dirty and retried.
      return this.leftHere(ws) ? 'unavailable' : 'held';
    }
  }

  /**
   * flushGuildNow for one accepted write: 'ok' once a batch its set built at
   * or after it committed (so a later write of the same document landing
   * counts), 'held' when the store refused the commit, 'pending' at the
   * deadline, 'deposed' once its set is fenced. Only the set that took the
   * write answers for it: evicted or replaced before it landed, it is
   * 'unavailable' ('deposed' once its batch on the wire comes back deposed).
   */
  async confirm(ticket: WsTicket, deadlineMs: number): Promise<FlushNowOutcome> {
    const ws = ticket.set;
    const deadline = performance.now() + deadlineMs;
    for (;;) {
      if (ws.landedSeq >= ticket.seq) return 'ok';
      if (ws.state === 'fenced') return 'deposed';
      if (this.leftHere(ws)) return 'unavailable';
      // Neither dirty nor on the wire: it left the set without landing.
      if (!ws.flushInFlight && ws.dirtyKeys.size === 0) return 'unavailable';
      const left = deadline - performance.now();
      if (left <= 0) return 'pending';
      if (ws.flushInFlight) {
        // Referenced: the flush can end first and leave nothing else holding the process open.
        await new Promise<void>(resolve => { setTimeout(resolve, Math.min(20, left)); });
        continue;
      }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), left);
        timer.unref();
      });
      const committed = await Promise.race([this.flush(ws), timeout]);
      clearTimeout(timer);
      // Once the set left here, its flush's commit, timeout or refusal vouches for none of its writes; fenced, it
      // still answers deposed.
      if (committed === 'timeout') return this.leftHere(ws) ? 'unavailable' : 'pending';
      // Its batch was built after the write, so it carried it, unless the set left meanwhile.
      if (committed) return ws.landedSeq >= ticket.seq ? 'ok' : 'unavailable';
      if ((ws.state as WsState) === 'fenced') return 'deposed';
      // Refused by the store (unreachable): kept dirty and retried.
      return this.leftHere(ws) ? 'unavailable' : 'held';
    }
  }

  /** Flush every dirty guild (shutdown drain; the caller bounds it). */
  async flushAllDirty(): Promise<string[]> {
    const dirty = [...this.sets.values()].filter(ws => ws.dirtyKeys.size > 0);
    await Promise.all(dirty.map(ws => this.flush(ws)));
    return [...this.sets.values()].filter(ws => ws.dirtyKeys.size > 0).map(ws => ws.guildId);
  }

  /** No guild holds a dirty write or a flush on the wire (the exit drain's test). */
  writesSettled(): boolean {
    return ![...this.sets.values()].some(ws => ws.dirtyKeys.size > 0 || ws.flushInFlight);
  }

  flushOnTheWire(): boolean {
    return [...this.sets.values()].some(ws => ws.flushInFlight);
  }

  /** Guild flushes committed so far (the exit drain's progress test). */
  landedFlushes(): number {
    return this.landed;
  }

  // --------------------------------------------------------------------------
  // C1 acceptance window + retry machinery
  // --------------------------------------------------------------------------

  private noteFlushSuccess(): void {
    this.retryAttempt = 0;
    this.lastError = null;
    this.reopenIfDrained();
  }

  // Hysteresis: acceptance reopens only once the backlog is under half its bound and no write has waited the window.
  private reopenIfDrained(): void {
    if (this.health === 'healthy') return;
    const { bytes, oldest } = this.backlog();
    if (bytes >= ACCEPT_BYTES / 2 || oldest >= ACCEPT_WINDOW_MS) return;
    if (this.health === 'refusing') console.warn(`[Data] Write acceptance reopened: unsaved writes hold ${Math.round(bytes / 1024)} KiB, the oldest waiting ${Math.round(oldest / 1000)} s`);
    this.health = this.lastError === null ? 'healthy' : 'degraded';
  }

  private noteFlushFailure(error: string): void {
    this.lastError = error;
    if (this.health === 'healthy') this.health = 'degraded';
    this.checkBounds(Date.now());
  }

  private checkBounds(_now: number): void {
    if (this.health === 'refusing') return;
    const { bytes, oldest } = this.backlog();
    if (bytes > ACCEPT_BYTES || oldest > ACCEPT_WINDOW_MS) {
      this.health = 'refusing';
      console.error(`[Data] Write acceptance CLOSED (backlog ${Math.round(bytes / 1024)} KiB, oldest ${Math.round(oldest / 1000)}s); guild writes are refused until unsaved writes are under ${ACCEPT_BYTES / 2 / 1024 / 1024} MiB and none has waited ${ACCEPT_WINDOW_MS / 1000} s`);
    }
  }

  /**
   * The facade's refusal while acceptance is closed, from what holds it closed now: the backlog's bytes, the oldest
   * write's wait, or both, each with where it reopens. Its cause is the backlog's either way: a store that answers yet
   * holds every flush is not unreachable.
   */
  refusal(): DataBackendUnavailableError {
    const { bytes, oldest } = this.backlog();
    const age = oldest >= ACCEPT_WINDOW_MS;
    const held: string[] = [];
    if (bytes >= ACCEPT_BYTES / 2 || !age) held.push(`unsaved writes hold ${Math.round(bytes / 1024)} KiB (acceptance reopens below ${ACCEPT_BYTES / 2 / 1024 / 1024} MiB)`);
    if (age) held.push(`the oldest unsaved write has waited ${Math.round(oldest / 1000)} s (acceptance reopens below ${ACCEPT_WINDOW_MS / 1000} s)`);
    return new DataBackendUnavailableError('database-backlog', `[Data] Write acceptance is closed: ${held.join(' and ')}; the write was not saved`);
  }

  /** What waits unsaved on this node: the bytes and the age of its oldest write, dirty or on the wire. */
  private backlog(): { bytes: number; oldest: number } {
    let bytes = 0;
    let oldest = 0;
    const now = Date.now();
    for (const ws of this.sets.values()) {
      for (const key of new Set([...ws.dirtyKeys, ...ws.flightKeys])) {
        const doc = ws.docs.get(key);
        if (!doc?.dirty) continue;
        if (!doc.tombstone) bytes += doc.bytes ??= Buffer.byteLength(doc.content);
        if (doc.dirtySince > 0) oldest = Math.max(oldest, now - doc.dirtySince);
      }
      for (const buf of ws.appendBuf.values()) {
        if (buf.chunk.length === 0) continue;
        bytes += buf.bytes;
        oldest = Math.max(oldest, now - buf.dirtySince);
      }
    }
    return { bytes, oldest };
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
    this.reopenIfDrained();
    const { bytes, oldest } = this.backlog();
    return { state: this.health, oldestDirtyMs: oldest, dirtyBytes: bytes, lastError: this.lastError };
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
