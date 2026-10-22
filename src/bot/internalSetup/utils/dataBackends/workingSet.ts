// Working Set - per-guild docs in RAM for postgres-routed guilds. The frozen
// sync facade answers from here; a coalescing write-behind flushes each guild's
// dirty docs as ONE fenced transaction per window. Reads never block on the
// database; writes are accepted into RAM with a bounded durability window and
// refuse loudly (never silently) when that window cannot be honored.

import { DataBackend, DocKey, FenceToken, GuildFlushBatch } from './backend';
import { setLeft, type CarryOutcome } from './scopeRecord';

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

export type WsWriteResult = 'accepted' | 'frozen-window' | 'refusing' | 'fenced' | 'not-ready' | 'read-only';
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
export type DataUnavailableCause = 'database-unreachable' | 'database-backlog' | 'guild-fenced' | 'database-read-only' | 'node-stopping';

export class DataBackendUnavailableError extends Error {
  constructor(readonly causeKey: DataUnavailableCause, detail?: string) {
    super(detail ?? (causeKey === 'guild-fenced'
      ? '[Data] This guild was taken over by another node; the write was not saved'
      : causeKey === 'database-read-only'
        ? '[Data] The database serving this node is a copy in recovery and accepts no writes (SQLSTATE 25006); the write was not saved'
        : causeKey === 'node-stopping'
          ? '[Data] This process is stopping and its exit drain has closed; the write was not saved'
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
  readyWaiters: Array<() => void> = [];
  // A drain froze it while it hydrated: it comes up frozen-retained.
  freezeWhenReady = false;
  // Stamped at every accepted save, append and delete. landedSeq is the stamp
  // a committed batch was built at: every write at or below it landed, or a
  // later write of its document did.
  writeSeq = 0;
  landedSeq = 0;
  // exportDirty carried its unflushed writes off: its later commits and its fence vouch for none of them.
  exported = false;
  // The seq the batch on the wire was built at, 0 while none is (a reclaim holds flushInFlight with no batch): an
  // export carries none of its documents.
  wireSeq = 0;
  // Carries a recycle applied here, each stamped as a write: one lands once a batch built after its stamp commits.
  carried: { fate: CarryFate; seq: number }[] = [];
  // What each export took off: the carry holding this set's writes from one seq to another.
  carriedOut: { fate: CarryFate; from: number; to: number }[] = [];

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

/**
 * Where one recycle's carry of a guild's unflushed writes went: carried (exported, and no successor holds it yet),
 * kept (a successor holds it and may still land it), landed (a batch built after it committed on the live set
 * holding it) or dropped (no one keeps it any more, so whether it landed is unknown). One kept for a copy that takes
 * no writes yet reads dropped while the copy takes writes; a prune in that time drops it for good. A later recycle
 * that carries it on forwards it: its outcome is then the outcome of the carry it went into.
 */
export class CarryFate implements CarryOutcome {
  private state: 'carried' | 'kept' | 'landed' | 'dropped' = 'carried';
  private next: CarryFate | null = null;
  private stale: (() => boolean) | null = null;

  outcome(): 'carried' | 'kept' | 'landed' | 'dropped' {
    let fate: CarryFate = this;
    while (fate.next) fate = fate.next;
    return fate.stale?.() ? 'dropped' : fate.state;
  }

  /**
   * Kept by a successor; stale, while it waits for the guild to hydrate there, says when its copy took writes. The
   * apply holds it again without one, before it can land.
   */
  hold(stale: (() => boolean) | null = null): void {
    if (!this.open()) return;
    this.state = 'kept';
    this.stale = stale;
  }

  settle(state: 'landed' | 'dropped'): void {
    if (this.open()) this.state = state;
  }

  forward(to: CarryFate): void {
    if (this.open()) this.next = to;
  }

  private open(): boolean {
    return this.next === null && (this.state === 'carried' || this.state === 'kept');
  }
}

/** The carry an export took the set's writes from one seq to another off in, or null when none holds them all. */
function carriedIn(ws: GuildWorkingSet, from: number, to: number): CarryFate | null {
  return ws.carriedOut.find(out => out.from <= from && to <= out.to)?.fate ?? null;
}

/** The carry a recycle took a write off in (with its set's writes from from on), or null: confirmWrite's successor check. */
export function carryOf(ticket: WsTicket, from = ticket.seq): CarryFate | null {
  return carriedIn(ticket.set, from, ticket.seq);
}

/** Unflushed writes leaving one manager for another at a recycle (exportDirty / adoptDirty). */
export interface DirtyCarry {
  guildId: string;
  docs: { key: string; content: string; tombstone: boolean; dirtySince: number }[];
  appends: { key: string; chunk: string; dirtySince: number }[];
  fate: CarryFate;
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
  private retryTimer: NodeJS.Timeout | null = null;
  private quiesced = false;
  private retryAttempt = 0;
  // A carry is bound to the read-only store it was adopted for: once that store
  // has taken writes, another node may have written newer data, so a carry not
  // yet applied is dropped rather than flushed over it.
  private readonly adoptions = new Map<string, { carry: DirtyCarry; store: DataBackend }>();
  // Counters driven to zero by the drill matrix (non-gated callers touching
  // guilds whose working set is not ready).
  private wsBypassReads = 0;
  private wsBypassWrites = 0;
  private fencedFlushRejections = 0;
  private landed = 0;

  constructor(private backend: DataBackend) {}

  /**
   * Runtime recycle on a delivered URL change: dirty guilds are re-flushed into
   * the NEW database (a transfer fences the old primary read-only, so writes
   * accepted during the switch exist only in this working set).
   */
  retargetBackend(backend: DataBackend): void {
    this.backend = backend;
  }

  /**
   * Recycle handover: this manager has been replaced and must never write
   * again. Its successor holds the SAME fence token (same node, same lease), so
   * the database physically cannot arbitrate between the two - a surviving
   * debounce or retry timer here would commit stale content over the live
   * working set's rows and no fence would report it. Every timer is cleared and
   * every later flush is a no-op.
   */
  quiesce(): void {
    this.quiesced = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    // Nothing here hydrates or flushes again, so no one keeps a carry held here any more: one applied may still land
    // with a batch on the wire, which no one can tell.
    for (const { carry } of this.adoptions.values()) carry.fate.settle('dropped');
    for (const ws of this.sets.values()) {
      ws.clearTimers();
      for (const applied of ws.carried) applied.fate.settle('dropped');
      ws.carried = [];
      setLeft(ws, (from, to) => carriedIn(ws, from, to));
    }
  }

  /**
   * Guilds holding unflushed writes right now (recycle drain accounting). A
   * flush already on the wire counts: it emptied its dirty set before awaiting,
   * so it would otherwise read as clean and be dropped on the floor.
   */
  dirtyGuildIds(): string[] {
    this.pruneAdoptions();
    const ids = new Set([...this.sets.values()].filter(ws => ws.dirtyKeys.size > 0 || ws.flushInFlight).map(ws => ws.guildId));
    for (const id of this.adoptions.keys()) ids.add(id);
    return [...ids];
  }

  private pruneAdoptions(): void {
    const stale = [...this.adoptions].filter(([, a]) => !a.store.isReadOnly()).map(([id]) => id);
    if (stale.length === 0) return;
    for (const id of stale) {
      this.adoptions.get(id)!.carry.fate.settle('dropped');
      this.adoptions.delete(id);
    }
    console.error(`[Data] Carried writes for ${stale.length} guild(s) DROPPED: the copy took writes before this node hydrated them, so they could overwrite newer data: ${stale.join(', ')}`);
  }

  /**
   * Recycle onto a store that takes no writes yet (a stand-in's copy in
   * recovery): the writes this manager could not drain leave with the caller
   * instead of being dropped, and its accounting forgets them (B7-F26).
   */
  exportDirty(guildIds: string[]): DirtyCarry[] {
    this.pruneAdoptions();
    const out: DirtyCarry[] = [];
    for (const guildId of guildIds) {
      const fate = new CarryFate();
      const pending = this.adoptions.get(guildId)?.carry;
      const docs = pending ? [...pending.docs] : [];
      const appends = pending ? [...pending.appends] : [];
      const forwarded = pending ? [pending.fate] : [];
      const ws = this.sets.get(guildId);
      if (ws) {
        for (const key of ws.dirtyKeys) {
          const doc = ws.docs.get(key);
          if (doc?.dirty) docs.push({ key, content: doc.content, tombstone: doc.tombstone, dirtySince: doc.dirtySince });
        }
        // A buffer leaves whole, the start a batch on the wire holds too: once if that batch fails, twice if it
        // commits (open_items.md, "A recycle's batch on the wire").
        for (const [key, buf] of ws.appendBuf) {
          if (buf.chunk.length > 0) appends.push({ key, chunk: buf.chunk, dirtySince: buf.dirtySince });
        }
        // The batch on the wire may land from here or not at all, so no carry answers for its writes or for a carry
        // applied here before it was built, and none holds its documents. Every write after it is dirty (an absent
        // delete answers by the delete it found), and leaves in this one.
        const wire = ws.flushInFlight ? ws.wireSeq : 0;
        for (const applied of ws.carried) {
          if (applied.seq > wire) forwarded.push(applied.fate);
          else applied.fate.settle('dropped');
        }
        ws.carried = [];
        const from = Math.max(wire, ws.carriedOut[ws.carriedOut.length - 1]?.to ?? 0) + 1;
        if (from <= ws.writeSeq) ws.carriedOut.push({ fate, from, to: ws.writeSeq });
        this.forgetDirty(ws);
        ws.exported = true;
      }
      this.adoptions.delete(guildId);
      if (docs.length > 0 || appends.length > 0) {
        for (const earlier of forwarded) earlier.forward(fate);
        out.push({ guildId, docs, appends, fate });
      } else {
        for (const earlier of forwarded) earlier.settle('dropped');
        fate.settle('dropped');
      }
    }
    return out;
  }

  /** The other side of exportDirty: applied over the store's older content once the guild hydrates here. */
  adoptDirty(carries: DirtyCarry[]): void {
    const store = this.backend;
    for (const carry of carries) {
      // A quiesced manager never hydrates or flushes again, so a carry cannot land here. One waiting for the guild
      // to hydrate reads dropped while this copy takes writes; a prune in that time drops it for good.
      if (this.quiesced) carry.fate.settle('dropped');
      else carry.fate.hold(() => !store.isReadOnly());
      const ws = this.sets.get(carry.guildId);
      if (ws && ws.state === 'ready') this.applyCarry(ws, carry);
      else this.adoptions.set(carry.guildId, { carry, store: this.backend });
    }
  }

  // The acceptance window restarts at the adoption: it measures how long writes
  // have waited on THIS runtime, and the carried age would close the window the
  // moment the copy takes writes.
  private applyCarry(ws: GuildWorkingSet, carry: DirtyCarry): void {
    const now = Date.now();
    // Applied, it lands with a batch built after its stamp, whatever the copy does from now on.
    carry.fate.hold();
    ws.writeSeq += 1;
    ws.carried.push({ fate: carry.fate, seq: ws.writeSeq });
    for (const doc of carry.docs) {
      // A write accepted here since is newer: marked dirty again, so a batch built after the stamp holds it.
      if (ws.docs.get(doc.key)?.dirty) {
        this.markDirty(ws, doc.key, now);
        continue;
      }
      ws.docs.set(doc.key, { content: doc.content, tombstone: doc.tombstone, dirty: true, dirtySince: now, sinceBatch: now, seq: ws.writeSeq });
      this.markDirty(ws, doc.key, now);
    }
    for (const append of carry.appends) {
      const buf = ws.appendBuf.get(append.key);
      // Ahead of the appends taken here since, but behind the start a batch on the wire holds, which its commit slices.
      if (buf) {
        buf.chunk = buf.chunk.slice(0, buf.sent) + append.chunk + buf.chunk.slice(buf.sent);
        buf.bytes += Buffer.byteLength(append.chunk);
        buf.dirtySince ||= now;
        buf.sinceBatch ||= now;
      } else ws.appendBuf.set(append.key, { chunk: append.chunk, dirtySince: now, sinceBatch: now, sent: 0, bytes: Buffer.byteLength(append.chunk) });
      ws.appendKeys.add(append.key);
      this.markDirty(ws, append.key, now);
    }
  }

  /** Bounded wait for in-flight flushes to come back, so their keys are visible again. */
  async settleInFlight(deadlineMs: number): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline && [...this.sets.values()].some(ws => ws.flushInFlight)) {
      await new Promise<void>(resolve => { setTimeout(resolve, 100).unref?.(); });
    }
  }

  /** Fenced-flush rejections so far; a drain that raises this DISCARDED writes. */
  fencedRejectionCount(): number {
    return this.fencedFlushRejections;
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

  /** Every guild with a working set here, in any state. */
  guildIds(): string[] {
    return [...this.sets.keys()];
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
    // A set kept since its lease left is current only while no other node
    // has claimed the guild since (an aborted move hands the shard straight
    // back): re-stamped for the new grant, or dropped and read again. No
    // flush of its old writes starts meanwhile.
    if (ws?.state === 'frozen-retained') {
      if (ws.flushInFlight) return 'unavailable';
      const retained = ws;
      retained.flushInFlight = true;
      const reclaim = await this.backend.reclaimGuild(guildId, token);
      retained.flushInFlight = false;
      if (retained.requeue || retained.dirtyKeys.size > 0) {
        retained.requeue = false;
        this.scheduleRetry();
      }
      if (reclaim === null) return 'unavailable';
      ws = this.sets.get(guildId);
      if (reclaim === 'lost' && ws === retained) {
        if (retained.dirtyKeys.size > 0) {
          console.warn(`[Data] Guild ${guildId}: ${retained.dirtyKeys.size} unflushed write(s) kept since its lease left are dropped, as another node has owned it since; it is read again from the store`);
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
    }
    // A new grant serves it, whatever froze it under the one before.
    if (ws.fence.term !== token.term || ws.fence.epoch !== token.epoch) ws.freezeWhenReady = false;
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
      ws.docs.set(docKeyOf(key.module, key.filename), { content: doc, tombstone: false, dirty: false, dirtySince: 0, sinceBatch: 0, seq: 0 });
    }
    for (const key of outcome.appendKeys) {
      ws.appendKeys.add(docKeyOf(key.module, key.filename));
    }
    ws.state = ws.freezeWhenReady ? 'frozen-retained' : 'ready';
    this.pruneAdoptions();
    const adoption = this.adoptions.get(guildId);
    if (adoption) {
      this.adoptions.delete(guildId);
      this.applyCarry(ws, adoption.carry);
    }
    for (const wake of ws.readyWaiters.splice(0)) wake();
    return 'ready';
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
   * rejection). Eviction happens at migration source-cleanup or drain end.
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
    return ws?.state === 'frozen-retained' && (ws.fence.term !== token.term || ws.fence.epoch !== token.epoch);
  }

  /** Refuse the guild's writes from now on, as its lease's unload leaves it; a re-grant serves it again. */
  freezeRetained(guildId: string): void {
    const ws = this.sets.get(guildId);
    if (ws?.state === 'ready') ws.state = 'frozen-retained';
    else if (ws?.state === 'hydrating') ws.freezeWhenReady = true;
  }

  /** A hydrating set that freezeRetained marked: it becomes frozen-retained, not ready, when its hydration ends. */
  freezesWhenReady(guildId: string): boolean {
    const ws = this.sets.get(guildId);
    return ws?.state === 'hydrating' && ws.freezeWhenReady;
  }

  evict(guildId: string): void {
    const ws = this.sets.get(guildId);
    if (!ws) return;
    ws.clearTimers();
    this.forgetDirty(ws);
    for (const applied of ws.carried) applied.fate.settle('dropped');
    ws.carried = [];
    this.sets.delete(guildId);
    setLeft(ws, (from, to) => carriedIn(ws, from, to));
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
   * unless its key was marked dirty again during that flight (a carry applied
   * over it): that ticket is then landed, and answers 'ok'.
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
    if (this.backend.isReadOnly()) return 'read-only';
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
    if (this.quiesced) return false;
    if (ws.flushInFlight) { ws.requeue = true; return false; }
    if (ws.debounceTimer) { clearTimeout(ws.debounceTimer); ws.debounceTimer = null; }
    if (ws.dirtyKeys.size === 0) { ws.windowOpenedAt = null; return false; }

    const { batch, flushedKeys, sentBufs, seq } = this.buildBatch(ws);
    ws.dirtyKeys = new Set();
    ws.flightKeys = new Set(flushedKeys);
    ws.windowOpenedAt = null;
    ws.flushInFlight = true;
    ws.wireSeq = seq;
    const outcome = await this.backend.flushGuild(ws.guildId, batch, ws.fence);
    ws.flushInFlight = false;
    ws.flightKeys = new Set();
    ws.wireSeq = 0;
    // A refused batch holds no buffer's start any more: the next one sends each whole.
    if (!outcome.ok) for (const buf of sentBufs.values()) buf.sent = 0;

    if (outcome.ok) {
      // An evicted, replaced, exported or recycled set dropped or carried off
      // its unflushed writes, so what it commits after that vouches for none.
      if (!this.leftHere(ws)) {
        ws.landedSeq = seq;
        // A carry applied before this batch was built rode in it.
        for (const applied of ws.carried) if (applied.seq <= seq) applied.fate.settle('landed');
        ws.carried = ws.carried.filter(applied => applied.seq > seq);
      }
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
    if (outcome.reason === 'read-only') {
      // Accepted before the copy showed itself read-only: kept dirty for the
      // retry without degrading acceptance (the gate refuses new writes).
      for (const key of flushedKeys) ws.dirtyKeys.add(key);
      ws.requeue = false;
      this.lastError = (this.backend as { isUnproven?: () => boolean }).isUnproven?.() === true
        ? 'flush held: the database is not yet proven to hold its master\'s term'
        : 'flush refused: the database is read-only (SQLSTATE 25006)';
      this.scheduleRetry();
      return false;
    }
    // unavailable: everything stays dirty; merge back and retry under backoff.
    for (const key of flushedKeys) ws.dirtyKeys.add(key);
    ws.requeue = false;
    this.noteFlushFailure('flush unavailable');
    this.scheduleRetry();
    return false;
  }

  private onDeposed(ws: GuildWorkingSet, owner?: { nodeId: string; term: number; epoch: number }): void {
    this.fencedFlushRejections += 1;
    this.lastError = `guild ${ws.guildId} fenced by ${owner?.nodeId ?? 'unknown'} (term ${owner?.term ?? '?'}, epoch ${owner?.epoch ?? '?'})`;
    console.error(`[Data] Deposed writer: ${this.lastError}; dropping the guild's working set without flushing`);
    // Drop dirty accounting; the flush is never retried (a deposed node's
    // leftover writes are never merged later - that would be a second writer).
    this.forgetDirty(ws);
    for (const applied of ws.carried) applied.fate.settle('dropped');
    ws.carried = [];
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

  /** The set answers for its writes here no more: its manager quiesced, it was evicted or replaced, or a recycle exported it. */
  private leftHere(ws: GuildWorkingSet): boolean {
    return this.quiesced || this.sets.get(ws.guildId) !== ws || ws.exported;
  }

  /**
   * Deadline-bounded immediate flush ('ok' = committed, 'pending' = accepted
   * and still retrying - callers report "queued, not yet durable"). A flush
   * already on the wire emptied the dirty set before awaiting, so it is
   * waited for: its writes are durable only once it settles.
   */
  async flushGuildNow(guildId: string, deadlineMs: number): Promise<FlushNowOutcome> {
    // A quiesced manager flushes nothing again; what it held may have left in a recycle's carry.
    if (this.quiesced) return 'unavailable';
    // Writes carried in from a recycle wait here for the guild to hydrate, while the copy takes no writes. Once it
    // takes writes they are dropped (pruneAdoptions), and whether they were stored is unknown.
    const adoption = this.adoptions.get(guildId);
    if (adoption) {
      if (adoption.store.isReadOnly()) return 'pending';
      this.pruneAdoptions();
      return 'unavailable';
    }
    const ws = this.sets.get(guildId);
    if (!ws) return 'ok';
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      // Fenced after an export, the set answers for none of its writes: they left in a carry or on the wire.
      if (ws.state === 'fenced' && !ws.exported) return 'deposed';
      // A recycle may have carried the writes off to its read-only copy.
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
      // Once the set left here, its flush's commit, timeout or refusal vouches for none of its writes; fenced with no
      // export, it still answers deposed, as no carry holds them.
      if (committed === 'timeout') return this.leftHere(ws) ? 'unavailable' : 'pending';
      if (committed) return this.leftHere(ws) ? 'unavailable' : 'ok';
      if ((ws.state as WsState) === 'fenced' && !ws.exported) return 'deposed';
      // Refused by the store (unreachable, read-only): kept dirty and retried.
      return this.leftHere(ws) ? 'unavailable' : 'held';
    }
  }

  /**
   * flushGuildNow for one accepted write: 'ok' once a batch its set built at
   * or after it committed (so a later write of the same document landing
   * counts), 'held' when the store refused the commit, 'pending' at the
   * deadline, 'deposed' once its set is fenced with no export. Only the set
   * that took the write answers for it: evicted, replaced, exported or
   * recycled away before it landed, it is 'unavailable' (exported, whatever
   * its batch on the wire answers later; not exported, 'deposed' once that
   * batch comes back deposed, since no carry holds its writes).
   */
  async confirm(ticket: WsTicket, deadlineMs: number): Promise<FlushNowOutcome> {
    const ws = ticket.set;
    const deadline = performance.now() + deadlineMs;
    for (;;) {
      if (ws.landedSeq >= ticket.seq) return 'ok';
      // Fenced after an export, the set answers for no write: a carry may hold it (an append's whole buffer, a
      // document's later version), so confirmFrom asks the carry.
      if (ws.state === 'fenced' && !ws.exported) return 'deposed';
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
      // Once the set left here, its flush's commit, timeout or refusal vouches for none of its writes; fenced with no
      // export, it still answers deposed, as no carry holds them.
      if (committed === 'timeout') return this.leftHere(ws) ? 'unavailable' : 'pending';
      // Its batch was built after the write, so it carried it, unless the set left meanwhile.
      if (committed) return ws.landedSeq >= ticket.seq ? 'ok' : 'unavailable';
      if ((ws.state as WsState) === 'fenced' && !ws.exported) return 'deposed';
      // Refused by the store (unreachable, read-only): kept dirty and retried.
      return this.leftHere(ws) ? 'unavailable' : 'held';
    }
  }

  /** The guild's set here, or null: the set flushGuildNow answers for, which it reads before its first await. */
  setOf(guildId: string): GuildWorkingSet | null {
    return this.sets.get(guildId) ?? null;
  }

  /**
   * The carries holding every write a set has not landed, or null when one is in none (in the batch on the wire at an
   * export, or made after the last): flushGuildOutcome's successor check, asked of the set its flush answered for, as
   * a set that replaced it holds none of its writes.
   */
  setCarries(ws: GuildWorkingSet): CarryFate[] | null {
    let next = ws.landedSeq + 1;
    const fates: CarryFate[] = [];
    for (const out of ws.carriedOut) {
      if (out.to < next) continue;
      if (out.from > next) return null;
      fates.push(out.fate);
      next = out.to + 1;
    }
    return fates.length > 0 && next > ws.writeSeq ? fates : null;
  }

  /** Flush every dirty guild (shutdown drain; the caller bounds it). */
  async flushAllDirty(): Promise<string[]> {
    const dirty = [...this.sets.values()].filter(ws => ws.dirtyKeys.size > 0);
    await Promise.all(dirty.map(ws => this.flush(ws)));
    const left = [...this.sets.values()].filter(ws => ws.dirtyKeys.size > 0).map(ws => ws.guildId);
    this.pruneAdoptions();
    for (const id of this.adoptions.keys()) if (!left.includes(id)) left.push(id);
    return left;
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
    if (this.quiesced || this.retryTimer) return;
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
