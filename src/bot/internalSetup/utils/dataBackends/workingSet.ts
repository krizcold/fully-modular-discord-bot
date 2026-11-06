// Working Set - per-guild docs in RAM for postgres-routed guilds. The frozen
// sync facade answers from here; a coalescing write-behind flushes each guild's
// dirty docs as ONE fenced transaction per window. Reads never block on the
// database; writes are accepted into RAM with a bounded durability window and
// refuse loudly (never silently) when that window cannot be honored.

import { randomUUID } from 'crypto';

import { DataBackend, DocKey, FenceToken, GuildFlushBatch, GuildOwner } from './backend';
import { setLeft } from './scopeRecord';
import { stoppedServing } from '../servingGate';
import { keyRefusal, KeyTree, pathKeyOf, STORE_MAX_BYTES } from '../storableData';

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
/** A save or append rule P refuses against the set's other keys. */
export interface WsCollision {
  collision: string;
}
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
export type DataUnavailableCause = 'database-unreachable' | 'database-backlog' | 'guild-fenced' | 'node-stopping' | 'storage-failing' | 'maintenance';

export class DataBackendUnavailableError extends Error {
  constructor(readonly causeKey: DataUnavailableCause, detail?: string) {
    super(detail ?? (causeKey === 'maintenance'
      ? '[Data] The bot is in maintenance; the write was not saved'
      : causeKey === 'guild-fenced'
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

// 'restoring': a graveyard restore holds the guild; reads serve it as ready, writes and waiters wait for its end.
type WsState = 'hydrating' | 'ready' | 'restoring' | 'frozen-retained' | 'fenced' | 'failed';

/** What flush did: its last step stored a batch, stored nothing, or had nothing it could send. */
type FlushAnswer = 'stored' | 'failed' | 'idle';

interface BuiltBatch {
  flushedKeys: string[];
  sentBufs: Map<string, AppendBuffer>;
  seq: number;
}

interface HeldBatch extends BuiltBatch {
  flushId: string;
  /** The claim the batch was sent under. */
  claim: number;
}

const UNANSWERED_TEXT = "the database did not answer this save's COMMIT; whether it landed is checked before anything is sent again";
const UNANSWERED_NOTE = "a save's COMMIT got no answer; checking whether it landed";

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
  /** The guild's live keys in path form (rule P). */
  readonly keys = new KeyTree();
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
  flushError: { text: string; code?: string } | null = null;
  // NB13 decision 5: a batch whose COMMIT got no answer, held until a check finds whether it landed.
  unanswered: HeldBatch | null = null;
  // The batch on the wire, null when none is: its commitSent says a COMMIT is awaiting its answer.
  flight: GuildFlushBatch | null = null;
  // A check found the guild taken and could not tell whether the held batch landed: tickets at or below this seq.
  unknownThrough = 0;

  constructor(readonly guildId: string, public fence: FenceToken) {}

  clearTimers(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.fencedDrainTimer) { clearTimeout(this.fencedDrainTimer); this.fencedDrainTimer = null; }
  }
}

function docKeyOf(module: string, filename: string): string {
  return `${module}/${filename}`;
}

/** The set's key tree, built from what it hydrated; one line names the stored keys a write rule refuses. */
function buildKeys(ws: GuildWorkingSet): void {
  const keys = [...ws.docs].filter(([, doc]) => !doc.tombstone).map(([key]) => key);
  for (const key of ws.appendKeys) if (!ws.docs.has(key)) keys.push(key);
  let refused = 0;
  let collided = 0;
  let oversized = 0;
  const firsts: string[] = [];
  for (const docKey of keys) {
    const { module, filename } = splitDocKey(docKey);
    const key = pathKeyOf(module, filename);
    const collision = ws.keys.add(key);
    const refusal = keyRefusal(key);
    const doc = ws.docs.get(docKey);
    if (refusal) {
      refused += 1;
      if (firsts.length < 3) firsts.push(`${key}: ${refusal}`);
    } else if (collision) {
      collided += 1;
      if (firsts.length < 3) firsts.push(`${key}: ${collision.reason}`);
    }
    if (doc && !doc.tombstone && Buffer.byteLength(doc.content) > STORE_MAX_BYTES) {
      oversized += 1;
      if (firsts.length < 3 && !refusal && !collision) firsts.push(`${key}: it is over 4 MiB`);
    }
  }
  if (refused + collided + oversized === 0) return;
  console.error(`[Data] Guild ${ws.guildId} holds ${refused} key(s) a write is refused for, ${collided} key(s) whose name collides with another stored key and ${oversized} document(s) over 4 MiB (first: ${firsts.join(', ')}). All of them read and delete as stored; a write to a refused key is refused, a colliding key takes writes under its own spelling, and an oversized document takes a new value of up to 4 MiB; tell the module's author`);
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

/** A set still owing writes to the store: dirty, on the wire, or holding an unanswered batch. */
function holds(ws: GuildWorkingSet): boolean {
  return ws.dirtyKeys.size > 0 || ws.flushInFlight || ws.unanswered !== null;
}

/** NB13 decision 6: the ticket's set holds an unanswered batch at or after it, or a flight whose COMMIT was sent. */
export function commitAnswerOwed(ticket: WsTicket): boolean {
  const ws = ticket.set;
  return (ws.unanswered !== null && ws.unanswered.seq >= ticket.seq) || ws.flight?.commitSent === true;
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
    return [...this.sets.values()].filter(holds).map(ws => ws.guildId);
  }

  /**
   * NB13 decision 5: the guilds holding a save the database did not answer (a held batch, or a flight whose COMMIT
   * was sent), and those of them holding nothing else.
   */
  unansweredGuilds(): { all: string[]; only: string[] } {
    const all = [...this.sets.values()].filter(ws => ws.unanswered !== null || ws.flight?.commitSent === true);
    return { all: all.map(ws => ws.guildId), only: all.filter(ws => ws.dirtyKeys.size === 0).map(ws => ws.guildId) };
  }

  /** The guilds of dirtyGuildIds, each with why its last flush failed (null when none failed yet). */
  heldGuilds(): Array<{ guildId: string; reason: string | null; code: string | null }> {
    return [...this.sets.values()].filter(holds)
      .map(ws => ({ guildId: ws.guildId, reason: ws.flushError?.text ?? null, code: ws.flushError?.code ?? null }));
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
    if (ws?.state === 'restoring') return 'unavailable';
    // A set kept since its lease left is current only while no other bot
    // process has claimed the guild since: re-stamped for the new grant, or dropped
    // and read again. No flush of its old writes starts meanwhile.
    if (ws?.state === 'frozen-retained') {
      if (ws.flushInFlight || ws.unanswered) return 'unavailable';
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
    buildKeys(ws);
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

  /** A served set takes no write from now on (reads keep serving); NB4 decision 17 freezes before any flush. */
  freeze(guildId: string): void {
    const ws = this.sets.get(guildId);
    if (ws?.state === 'ready') ws.state = 'frozen-retained';
  }

  /**
   * Lease removed: the set enters frozen-retained (reads keep serving, writes
   * get the frozen rejection), then one immediate flush under the OLD fence.
   */
  async unloadToFrozenRetained(guildId: string, stillGone: () => boolean = () => true): Promise<void> {
    const ws = this.sets.get(guildId);
    if (!ws || ws.state === 'fenced') return;
    this.freeze(guildId);
    await this.flushGuildNow(guildId, MAX_DELAY_MS);
    // A lease back while the flush ran keeps the set served.
    if (ws.state === 'frozen-retained' && !stillGone() && this.sets.get(guildId) === ws) ws.state = 'ready';
  }

  /** A graveyard restore takes a ready set: true once it holds it ('restoring'). */
  beginRestore(guildId: string): boolean {
    const ws = this.sets.get(guildId);
    if (ws?.state !== 'ready') return false;
    ws.state = 'restoring';
    return true;
  }

  /**
   * The restore's end: 'reopen' serves the same set again (frozen when its shard is no longer held here) and wakes its
   * waiters ready; 'evict' drops it, so the next access reads the store.
   */
  endRestore(guildId: string, how: 'reopen' | 'evict', stillHeld: () => boolean = () => true): void {
    const ws = this.sets.get(guildId);
    if (!ws || ws.state !== 'restoring') return;
    if (how === 'evict') {
      this.evict(guildId);
      return;
    }
    ws.state = stillHeld() ? 'ready' : 'frozen-retained';
    for (const wake of ws.readyWaiters.splice(0)) wake('ready');
  }

  /** Another process took the guild over: the deposed path, once, and its waiters answered not ready at once. */
  depose(guildId: string, owner?: GuildOwner): void {
    const ws = this.sets.get(guildId);
    if (!ws) return;
    if (ws.state !== 'fenced') this.onDeposed(ws, owner);
    for (const wake of ws.readyWaiters.splice(0)) wake('not-ready');
    this.dropWaiters(guildId);
  }

  fenceOf(guildId: string): FenceToken | null {
    return this.sets.get(guildId)?.fence ?? null;
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
    if (ws.state !== 'hydrating' && ws.state !== 'restoring') return Promise.resolve('not-ready');
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

  /** Rule P for a write of the key against the set's keys, writing nothing: the collision's reason, null when it fits or the set is not loaded. */
  placementOf(guildId: string, module: string, filename: string): string | null {
    const ws = this.sets.get(guildId);
    if (!ws || ws.state === 'hydrating' || ws.state === 'failed') return null;
    return ws.keys.check(pathKeyOf(module, filename))?.reason ?? null;
  }

  save(guildId: string, module: string, filename: string, content: string): WsWriteResult | WsCollision {
    const gate = this.writeGate(guildId);
    if (gate !== 'ok') return gate;
    const ws = this.sets.get(guildId)!;
    const collision = ws.keys.check(pathKeyOf(module, filename));
    if (collision) return { collision: collision.reason };
    ws.keys.add(pathKeyOf(module, filename));
    const key = docKeyOf(module, filename);
    const now = Date.now();
    const prev = ws.docs.get(key);
    ws.writeSeq += 1;
    ws.docs.set(key, { content, tombstone: false, dirty: true, dirtySince: prev?.dirtySince || now, sinceBatch: prev?.sinceBatch || now, seq: ws.writeSeq });
    this.markDirty(ws, key, now);
    return 'accepted';
  }

  append(guildId: string, module: string, filename: string, line: string): WsWriteResult | WsCollision {
    const gate = this.writeGate(guildId);
    if (gate !== 'ok') return gate;
    const ws = this.sets.get(guildId)!;
    const collision = ws.keys.check(pathKeyOf(module, filename));
    if (collision) return { collision: collision.reason };
    ws.keys.add(pathKeyOf(module, filename));
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
    ws.keys.remove(pathKeyOf(module, filename));
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
    if (ws?.state === 'restoring') return 'not-ready';
    if (!ws || ws.state === 'hydrating' || ws.state === 'failed') {
      this.wsBypassWrites += 1;
      return 'not-ready';
    }
    if (ws.state === 'frozen-retained') return 'frozen-window';
    if (ws.state === 'fenced') return 'fenced';
    // What held it closed may have left with no flush landing (a deposed or evicted set).
    this.reopenIfDrained();
    if (this.health === 'refusing') return 'refusing';
    // NB4 decision 6: asked at the moment the write is accepted, so a write queued across the deadline is refused.
    if (stoppedServing()) return 'frozen-window';
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

  private buildBatch(ws: GuildWorkingSet): BuiltBatch & { batch: GuildFlushBatch } {
    const batch: GuildFlushBatch = { upserts: [], deletes: [], appends: [], flushId: randomUUID() };
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

  /**
   * NB13 decision 5: a set holding an unanswered batch first asks the store whether it landed; with its fate known, or
   * with none held, it sends what is dirty.
   */
  private async flush(ws: GuildWorkingSet): Promise<FlushAnswer> {
    if (ws.flushInFlight) { ws.requeue = true; return 'idle'; }
    if (ws.debounceTimer) { clearTimeout(ws.debounceTimer); ws.debounceTimer = null; }
    const held = ws.unanswered;
    if (!held) return this.send(ws);
    ws.flushInFlight = true;
    const fate = await this.backend.resolveFlush(ws.guildId, held.flushId, held.claim, ws.fence);
    ws.flushInFlight = false;
    // Left meanwhile, or forgotten by a deposition: the answer applies to nothing.
    if (this.leftHere(ws) || ws.unanswered !== held) return 'idle';
    if (fate.fate === 'unknown') {
      ws.flushError = { text: `${UNANSWERED_TEXT}; the last check failed: ${fate.detail}` };
      this.noteFlushFailure(UNANSWERED_NOTE);
      this.scheduleRetry();
      return 'failed';
    }
    ws.unanswered = null;
    ws.flightKeys = new Set();
    ws.requeue = false;
    if (fate.fate === 'deposed') {
      if (fate.landed) {
        this.applyLanded(ws, held);
        this.noteDropped(ws, ws.dirtyKeys.size);
      } else {
        ws.unknownThrough = held.seq;
        this.noteDropped(ws, new Set([...held.flushedKeys, ...ws.dirtyKeys]).size);
      }
      this.onDeposed(ws, fate.currentOwner, fate.landed === null);
      return 'failed';
    }
    if (fate.fate === 'landed') {
      this.applyLanded(ws, held);
      const next = await this.send(ws);
      return next === 'idle' ? 'stored' : next;
    }
    for (const buf of held.sentBufs.values()) buf.sent = 0;
    for (const key of held.flushedKeys) ws.dirtyKeys.add(key);
    return this.send(ws);
  }

  /** Builds and sends one batch of what is dirty: 'stored' once its COMMIT was answered. */
  private async send(ws: GuildWorkingSet): Promise<FlushAnswer> {
    if (ws.dirtyKeys.size === 0) { ws.windowOpenedAt = null; return 'idle'; }

    const built = this.buildBatch(ws);
    const { batch, flushedKeys, sentBufs, seq } = built;
    const sentClaim = ws.fence.claim ?? 0;
    ws.dirtyKeys = new Set();
    ws.flightKeys = new Set(flushedKeys);
    ws.windowOpenedAt = null;
    ws.flushInFlight = true;
    ws.flight = batch;
    const outcome = await this.backend.flushGuild(ws.guildId, batch, ws.fence);
    ws.flushInFlight = false;
    ws.flight = null;

    if (!outcome.ok && outcome.reason === 'unavailable' && outcome.commitUnanswered) {
      // Its keys stay in flightKeys, so the acceptance window counts them, and each buffer keeps its sent start.
      ws.unanswered = { flushId: batch.flushId!, claim: sentClaim, flushedKeys, sentBufs, seq };
      ws.requeue = false;
      ws.flushError = { text: UNANSWERED_TEXT };
      this.noteFlushFailure(UNANSWERED_NOTE);
      this.scheduleRetry();
      return 'failed';
    }
    ws.flightKeys = new Set();
    // A refused batch holds no buffer's start any more: the next one sends each whole.
    if (!outcome.ok) for (const buf of sentBufs.values()) buf.sent = 0;

    if (outcome.ok) {
      this.applyLanded(ws, built);
      if (ws.requeue || ws.dirtyKeys.size > 0) {
        ws.requeue = false;
        this.markDirty(ws, [...ws.dirtyKeys][0] ?? '', Date.now());
        if (ws.dirtyKeys.size === 0) { ws.windowOpenedAt = null; if (ws.debounceTimer) { clearTimeout(ws.debounceTimer); ws.debounceTimer = null; } }
      }
      return 'stored';
    }

    if (outcome.reason === 'deposed') {
      this.noteDropped(ws, new Set([...flushedKeys, ...ws.dirtyKeys]).size);
      this.onDeposed(ws, outcome.currentOwner);
      return 'failed';
    }
    // unavailable: everything stays dirty; merge back and retry under backoff.
    for (const key of flushedKeys) ws.dirtyKeys.add(key);
    ws.requeue = false;
    ws.flushError = { text: outcome.detail ?? 'the store did not take the flush', code: outcome.code };
    this.noteFlushFailure('flush unavailable');
    this.scheduleRetry();
    return 'failed';
  }

  /** A batch known stored: its writes land, the documents not written since become clean, each buffer loses its sent start. */
  private applyLanded(ws: GuildWorkingSet, batch: BuiltBatch): void {
    const { flushedKeys, sentBufs, seq } = batch;
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
    ws.flushError = null;
    this.noteFlushSuccess();
  }

  private readonly dropped = new Map<number, { changes: number; guilds: Set<string>; unanswered: Set<string> }>();

  private noteDropped(ws: GuildWorkingSet, changes: number): void {
    if (changes === 0) return;
    const entry = this.dropped.get(ws.fence.shardId) ?? { changes: 0, guilds: new Set<string>(), unanswered: new Set<string>() };
    entry.changes += changes;
    entry.guilds.add(ws.guildId);
    if (ws.unanswered !== null || ws.flight?.commitSent === true || ws.unknownThrough > ws.landedSeq) entry.unanswered.add(ws.guildId);
    this.dropped.set(ws.fence.shardId, entry);
  }

  /** NB4 decision 16's drop lines, one per shard, for writes refused 'deposed' since the last report. */
  takeDropLines(): string[] {
    const lines: string[] = [];
    for (const [shardId, entry] of [...this.dropped].sort((a, b) => a[0] - b[0])) {
      const guilds = [...entry.guilds].sort();
      let line = `[Shards] ${entry.changes} unsaved change(s) of ${guilds.length} guild(s) of shard ${shardId} were dropped: ${guilds.join(', ')}`;
      if (entry.unanswered.size > 0) line += `; guild(s) ${[...entry.unanswered].sort().join(', ')} had a save whose answer never came, so some of these changes may have landed`;
      lines.push(line);
    }
    this.dropped.clear();
    return lines;
  }

  private onDeposed(ws: GuildWorkingSet, owner?: GuildOwner, mayHaveLanded = false): void {
    this.fencedFlushRejections += 1;
    this.lastError = `guild ${ws.guildId} fenced by ${owner?.nodeId ?? 'unknown'} (claim ${owner?.claim ?? '?'})`;
    console.error(`[Data] Deposed writer: ${this.lastError}; dropping the guild's working set without flushing${mayHaveLanded ? '; a save whose COMMIT got no answer may have landed' : ''}`);
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
    ws.unanswered = null;
    ws.flightKeys = new Set();
    ws.dirtyKeys.clear();
    ws.appendBuf.clear();
    ws.windowOpenedAt = null;
  }

  /** The set answers for its writes here no more: it was evicted or replaced. */
  private leftHere(ws: GuildWorkingSet): boolean {
    return this.sets.get(ws.guildId) !== ws;
  }

  /**
   * Deadline-bounded immediate flush (NB13 decision 6). 'ok' only when nothing is dirty and nothing is unanswered;
   * 'pending' at the deadline or after a failed flush while a batch's fate is unknown; 'held' when the store refused;
   * 'deposed' once fenced, or 'unavailable' when the fenced set may hold a stored batch. After each flush it reads
   * the set again; a flush or check on the wire is waited for.
   */
  async flushGuildNow(guildId: string, deadlineMs: number): Promise<FlushNowOutcome> {
    const ws = this.sets.get(guildId);
    if (!ws) return 'ok';
    const deadline = performance.now() + deadlineMs;
    let failed = false;
    for (;;) {
      if (ws.state === 'fenced') return ws.unknownThrough > ws.landedSeq ? 'unavailable' : 'deposed';
      if (this.leftHere(ws)) return 'unavailable';
      if (!ws.flushInFlight && ws.dirtyKeys.size === 0 && !ws.unanswered) return 'ok';
      if (failed) return ws.unanswered ? 'pending' : 'held';
      const left = deadline - performance.now();
      if (left <= 0) return 'pending';
      const answer = await this.flushOnce(ws, left);
      if (answer === 'timeout') return this.leftHere(ws) ? 'unavailable' : 'pending';
      if (answer === 'failed') failed = true;
    }
  }

  /**
   * flushGuildNow for one accepted write: 'ok' once a batch its set built at
   * or after it is stored (so a later write of the same document landing
   * counts), 'held' when the store refused the commit, 'pending' at the
   * deadline or while its batch's fate is unknown, 'deposed' once its set is
   * fenced, and 'unavailable' when the set left, or was fenced while its batch
   * may have landed.
   */
  async confirm(ticket: WsTicket, deadlineMs: number): Promise<FlushNowOutcome> {
    const ws = ticket.set;
    const deadline = performance.now() + deadlineMs;
    let failed = false;
    for (;;) {
      if (ws.landedSeq >= ticket.seq) return 'ok';
      if (ws.state === 'fenced') return ticket.seq <= ws.unknownThrough ? 'unavailable' : 'deposed';
      if (this.leftHere(ws)) return 'unavailable';
      // Neither dirty, on the wire nor unanswered: it left the set without landing.
      if (!ws.flushInFlight && ws.dirtyKeys.size === 0 && !ws.unanswered) return 'unavailable';
      if (failed) return ws.unanswered && ticket.seq <= ws.unanswered.seq ? 'pending' : 'held';
      const left = deadline - performance.now();
      if (left <= 0) return 'pending';
      const answer = await this.flushOnce(ws, left);
      if (answer === 'timeout') return this.leftHere(ws) ? 'unavailable' : 'pending';
      if (answer === 'failed') failed = true;
    }
  }

  /**
   * One step of a confirm loop: a 20 ms poll while a flush or check is on the wire, else a flush raced against the
   * deadline. After a flush that sent nothing, one poll, so a check a timer started never turns the loop into a spin.
   */
  private async flushOnce(ws: GuildWorkingSet, left: number): Promise<FlushAnswer | 'timeout'> {
    // Referenced: the flush can end first and leave nothing else holding the process open.
    const poll = () => new Promise<void>(resolve => { setTimeout(resolve, Math.min(20, left)); });
    if (ws.flushInFlight) {
      await poll();
      return 'idle';
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), left);
      timer.unref();
    });
    const answer = await Promise.race([this.flush(ws), timeout]);
    clearTimeout(timer);
    if (answer === 'idle') await poll();
    return answer;
  }

  /** Flush every dirty guild (shutdown drain; the caller bounds it). */
  async flushAllDirty(): Promise<string[]> {
    const owing = (ws: GuildWorkingSet) => ws.dirtyKeys.size > 0 || ws.unanswered !== null;
    await Promise.all([...this.sets.values()].filter(owing).map(ws => this.flush(ws)));
    return [...this.sets.values()].filter(owing).map(ws => ws.guildId);
  }

  /** No guild holds a dirty write or a flush on the wire (the exit drain's test). */
  writesSettled(): boolean {
    return ![...this.sets.values()].some(holds);
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
      const dirty = [...this.sets.values()].filter(ws => (ws.dirtyKeys.size > 0 || ws.unanswered !== null) && !ws.flushInFlight && ws.state !== 'fenced');
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
