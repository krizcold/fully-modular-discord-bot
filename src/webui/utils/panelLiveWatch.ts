// Live changes of a panel another machine runs (NB15 decision 15), the web UI's side, Postgres only. The Panels tab
// watches a panel whose answer named another machine; while a watch exists the web UI listens on the main database for
// 'smdb_panel_changed' and fetches the panel's new state with a 'panel:live' request at each watch call and each
// notification. A line under the panel says when the view may be out of date, and why.

import { Client, type ClientConfig } from 'pg';
import { pgConfig, transportOf } from '../../utils/databaseAddress';
import { resolveWebuiDatabase } from './webuiDataReader';
import { WEBUI_LISTEN_APP } from '../../bot/internalSetup/utils/dataMigration';
import { isPanelView, PANEL_CHANNEL } from '../../bot/internalSetup/fleet/panelLive';

const WATCH_MS = 90_000;
const MAX_WATCHES = 50;
const MAX_FETCHES = 4;
const CHECK_EVERY_MS = 30_000;
const CHECK_BOUND_MS = 5000;
const CONNECT_MS = 5000;
const RETRY_MS = 5000;
const CLOSE_AFTER_MS = 60_000;
const LOG_EVERY_MS = 60_000;

export const LIVE_REASONS = {
  unreachable: 'the database cannot be reached',
  insecure: "this machine's database address does not check the database's certificate",
  tooMany: 'too many panels from other machines are open',
  cannotAnnounce: (name: string) => `${name} cannot announce its changes right now`,
  notFetched: 'the latest change could not be fetched',
  tooLarge: 'the latest change is more than the 256 KiB one machine sends to another',
  connecting: 'this web panel is still connecting',
  updating: 'this panel is being updated to its latest state',
};

/** The line under a shown panel while it is not live. */
export const outOfDateLine = (name: string, reason: string) => `This panel may be out of date: changes made on ${name} are not shown here by themselves right now (${reason}). It updates when you use it.`;

/** A watched pair's state for the page; checking: whether the holder can announce its changes is not known yet. */
export interface LiveStatus {
  live: boolean;
  reason: string | null;
  checking?: true;
}

/** What a fetch answered: the route's answer to a 'panel:live' request. */
export interface FetchAnswer {
  status: number | null;
  reply: Record<string, any>;
  holderProcess?: string;
}

/** The version of the view an owner action's answer carries: its liveVersion, or 0 when it holds no view under a liveSince. */
export function actionViewVersion(reply: Record<string, any> | null | undefined): number {
  if (!reply || typeof reply.liveSince !== 'number' || !Number.isSafeInteger(reply.liveVersion) || reply.liveVersion <= 0) return 0;
  return isPanelView(reply.data) ? reply.liveVersion : 0;
}

/** An owner action's answer as it arrived: the clients it went to, whether a state applied after its send refused it, and the apply mark after it. */
export interface ActionArrival { sent: number; refused: boolean; arrivedAt: number }

export interface ListenClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  on(event: 'notification', fn: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: 'error', fn: (error: Error) => void): unknown;
  on(event: 'end', fn: () => void): unknown;
  end(): Promise<unknown>;
}

export interface WatchDeps {
  /** A 'panel:live' request for the pair, sent as the owner who watches it, with the version its page has. */
  fetch(guildId: string, panelId: string, userId: string, have: { haveVersion: number; haveSince: number | null }): Promise<FetchAnswer>;
  /** A fetched state or an owner action's view for this web UI's WebSocket clients; the number of clients it went to. */
  emitUpdate(data: { panelId: string; guildId: string; sessionId: null; response: unknown; servedBy: string }): number | void;
  emitStatus(data: { guildId: string; panelId: string } & LiveStatus): void;
  /** The database the web UI's reader uses now, or why it uses none. */
  entry(): { entry: string } | { refusal: string };
  makeClient(config: ClientConfig): ListenClient;
}

interface Pair {
  guildId: string;
  panelId: string;
  userId: string;
  name: string;
  lastCall: number;
  holderProcess: string | null;
  since: number | null;
  /** The version of the holder's kept state, under since, this web UI last delivered to its page; 0 for none. */
  haveVersion: number;
  /** The holder process, since and version of the state the tabs were last sent, by a fetch or an action's view. */
  shown: Shown | null;
  /** The watcher's apply mark when a state was last applied to the pair; an answer to a request sent before it applies nothing. */
  applySeq: number;
  /** A refused answer's refetch has not been applied yet. */
  updating: boolean;
  /** The refetch asks for the holder's whole state and sends it to every tab, the one that got the refused answer included. */
  resend: boolean;
  /** Counts the refetches asked for; a fetch sent before the latest clears neither updating nor resend. */
  refetchSeq: number;
  /** The holder's last answer: true, false, or null while it does not know yet. */
  notifying: boolean | null;
  fetched: boolean;
  /** The listening connection's number when the last answered fetch was sent; -1 for none. */
  fetchedOn: number;
  fetchFailed: boolean;
  missed: boolean;
  /** The holder's kept state is too large to send; cleared only by a fetch that delivers a state, or the panel's use. */
  oversize: boolean;
  fetching: boolean;
  again: boolean;
  live: boolean | null;
  reason: string | null;
  checking: boolean;
  lastLog: number;
  /** Ends the watch 90 s after its last call. */
  expiry: NodeJS.Timeout | null;
}

interface Shown { holderProcess: string | null; since: number | null; version: number }

const keyOf = (guildId: string, panelId: string) => `${guildId}\u0000${panelId}`;

/** Whether the tabs were sent a state of this holder process and since at this version or above. */
const shownAtLeast = (pair: Pair, holderProcess: string | null, since: number | null, version: number) =>
  pair.shown !== null && pair.shown.holderProcess === holderProcess && pair.shown.since === since && pair.shown.version >= version;

export class PanelLiveWatch {
  private readonly pairs = new Map<string, Pair>();
  /** The last owner panel answer of a pair not watched yet: its holder process, since and version. */
  private readonly answers = new Map<string, { holderProcess: string | null; since: number | null; version: number }>();
  private client: ListenClient | null = null;
  private clientEntry: string | null = null;
  private generation = 0;
  private listening = false;
  /** Counts the times the connection started listening; a fetch counts only if it answered after the latest. */
  private listenCount = 0;
  /** A connect or a check failed since the connection last listened; until then the listener is still connecting. */
  private failed = false;
  private listenReason: string = LIVE_REASONS.unreachable;
  private retry: NodeJS.Timeout | null = null;
  private check: NodeJS.Timeout | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private fetchesRunning = 0;
  private readonly fetchQueue: Pair[] = [];
  /** Raised at each state applied to any pair; a request records it when sent. */
  private applyClock = 0;

  constructor(private readonly deps: WatchDeps) {}

  /** POST /api/panels/watch: registers or renews the watch; each call fetches the pair. */
  watch(guildId: string, panelId: string, userId: string, name: string): LiveStatus {
    const key = keyOf(guildId, panelId);
    let pair = this.pairs.get(key);
    if (!pair) {
      if (this.pairs.size >= MAX_WATCHES) return { live: false, reason: LIVE_REASONS.tooMany };
      const answered = this.answers.get(key);
      this.answers.delete(key);
      pair = {
        guildId, panelId, userId, name, lastCall: performance.now(), holderProcess: answered?.holderProcess ?? null,
        since: answered?.since ?? null, haveVersion: answered?.version ?? 0, shown: answered && answered.version > 0 ? { ...answered } : null, applySeq: 0, updating: false, resend: false, refetchSeq: 0, notifying: true, fetched: false, fetchedOn: -1,
        fetchFailed: false, missed: false, oversize: false, fetching: false, again: false, live: null, reason: null, checking: false, lastLog: -Infinity, expiry: null,
      };
      this.pairs.set(key, pair);
    }
    pair.lastCall = performance.now();
    this.renewExpiry(key, pair);
    pair.userId = userId;
    pair.name = name;
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.ensureListening();
    this.fetchPair(pair);
    return this.statusOf(pair);
  }

  /**
   * An owner action's answer from another machine (decision 15) with its liveSince, sent to every tab watching the
   * pair through the path a fetched state takes, unless they show a newer one. The number of clients it went to.
   */
  shareActionView(guildId: string, panelId: string, holderProcess: string | undefined, reply: Record<string, any>): number {
    return this.actionArrived(guildId, panelId, holderProcess, reply).sent;
  }

  /** The apply mark an owner action records before it is sent. */
  applyMark(): number {
    return this.applyClock;
  }

  /**
   * shareActionView for an action sent at the apply mark `sentAt`: when a state was applied to the pair after it, the
   * answer's view goes to no tab and changes nothing, and the pair is fetched again for every tab.
   */
  actionArrived(guildId: string, panelId: string, holderProcess: string | undefined, reply: Record<string, any>, sentAt?: number): ActionArrival {
    const version = actionViewVersion(reply);
    const pair = this.pairs.get(keyOf(guildId, panelId));
    if (!pair || version === 0) return { sent: 0, refused: false, arrivedAt: this.applyClock };
    if (sentAt !== undefined && pair.applySeq > sentAt) {
      this.refetch(pair, true);
      return { sent: 0, refused: true, arrivedAt: this.applyClock };
    }
    const process = holderProcess ?? null;
    const same = pair.holderProcess === process && pair.since === reply.liveSince;
    if ((same && version <= pair.haveVersion) || shownAtLeast(pair, process, reply.liveSince, version)) {
      return { sent: 0, refused: false, arrivedAt: this.applyClock };
    }
    const name = typeof reply.servedBy === 'string' ? reply.servedBy : pair.name;
    const sent = this.deps.emitUpdate({ panelId, guildId, sessionId: null, response: reply.data, servedBy: name });
    this.applied(pair);
    const count = typeof sent === 'number' ? sent : 0;
    if (count > 0) pair.shown = { holderProcess: process, since: reply.liveSince, version };
    return { sent: count, refused: false, arrivedAt: this.applyClock };
  }

  /**
   * An owner action's answer from another machine (decision 15), once it reached a page or not: the holder process
   * and liveSince it carried, and the version of the view a page now shows from it (0 for none). An answer without a
   * liveSince changes nothing, nor does one that brought no page a view. With its arrival: a refused answer changes
   * nothing, nor does one after which a state of another holder or since was applied; that pair is fetched again.
   */
  noteAnswer(guildId: string, panelId: string, holderProcess: string | undefined, since: unknown, version: unknown = 0, arrival?: ActionArrival): void {
    const kept = this.keepUnwatched(guildId, panelId, holderProcess, since, version);
    if (!kept) return;
    const pair = this.pairs.get(keyOf(guildId, panelId))!;
    const shown = kept.version;
    if (shown === 0) return;
    if (arrival) {
      const later = pair.applySeq > arrival.arrivedAt;
      const moved = pair.holderProcess !== kept.holderProcess || pair.since !== kept.since;
      if (arrival.refused || (later && moved)) {
        // The page that got this answer may show it over the newer state the other tabs were sent.
        if (later) this.refetch(pair, true);
        return;
      }
    }
    const behind = (pair.holderProcess === kept.holderProcess && pair.since === kept.since && pair.haveVersion > shown)
      || shownAtLeast(pair, kept.holderProcess, kept.since, shown + 1);
    pair.haveVersion = shown;
    // Lowered so the fetch below sends the newer state again, to the page that is behind.
    if (behind) pair.shown = kept;
    pair.holderProcess = kept.holderProcess;
    pair.since = kept.since;
    pair.missed = false;
    pair.oversize = false;
    this.report(pair);
    // A newer state reached the other tabs before this answer reached its page: fetched again for that page.
    if (behind) this.fetchPair(pair);
  }

  /**
   * The answer of opening a panel another machine runs, once it reached its page: kept for the watch that page starts.
   * A pair watched already is left as it is, since the other tabs were sent nothing, unless a state was applied to it
   * after the open was sent at the apply mark `sentAt`: then it is fetched again for every tab.
   */
  noteOpened(guildId: string, panelId: string, holderProcess: string | undefined, since: unknown, version: unknown = 0, sentAt?: number): void {
    if (!this.keepUnwatched(guildId, panelId, holderProcess, since, version)) return;
    const pair = this.pairs.get(keyOf(guildId, panelId))!;
    if (sentAt !== undefined && pair.applySeq > sentAt) this.refetch(pair, true);
  }

  /** Keeps an answer of a pair not watched yet; the answer for a watched pair, null for one without a liveSince. */
  private keepUnwatched(guildId: string, panelId: string, holderProcess: string | undefined, since: unknown, version: unknown): Shown | null {
    if (since !== null && (typeof since !== 'number' || !Number.isFinite(since))) return null;
    const key = keyOf(guildId, panelId);
    const kept: Shown = { holderProcess: holderProcess ?? null, since, version: Number.isSafeInteger(version) && (version as number) > 0 ? version as number : 0 };
    if (this.pairs.has(key)) return kept;
    this.answers.set(key, kept);
    if (this.answers.size > MAX_WATCHES) this.answers.delete(this.answers.keys().next().value as string);
    return null;
  }

  count(): number {
    return this.pairs.size;
  }

  listenerUp(): boolean {
    return this.listening;
  }

  stop(): void {
    for (const pair of this.pairs.values()) if (pair.expiry) clearTimeout(pair.expiry);
    this.pairs.clear();
    this.fetchQueue.length = 0;
    this.drop();
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }

  /**
   * Live only while the watch is registered, no kept state too large to send waits, the listener passed its last check,
   * a fetch answered since it began listening, and the last answer had notifying and a since.
   */
  private statusOf(pair: Pair): LiveStatus {
    if (pair.oversize) return { live: false, reason: LIVE_REASONS.tooLarge };
    if (!this.listening) return { live: false, reason: this.failed ? this.listenReason : LIVE_REASONS.connecting };
    if (pair.fetchFailed) return { live: false, reason: LIVE_REASONS.notFetched };
    if (pair.updating) return { live: false, reason: LIVE_REASONS.updating };
    if (pair.fetchedOn !== this.listenCount) return { live: false, reason: LIVE_REASONS.connecting };
    if (pair.since === null) return { live: false, reason: LIVE_REASONS.tooMany };
    if (pair.missed) return { live: false, reason: LIVE_REASONS.notFetched };
    if (pair.notifying === null) return { live: false, reason: null, checking: true };
    if (!pair.notifying) return { live: false, reason: LIVE_REASONS.cannotAnnounce(pair.name) };
    return { live: true, reason: null };
  }

  private report(pair: Pair): void {
    const status = this.statusOf(pair);
    const checking = status.checking === true;
    if (pair.live === status.live && pair.reason === status.reason && pair.checking === checking) return;
    pair.live = status.live;
    pair.reason = status.reason;
    pair.checking = checking;
    this.deps.emitStatus({ guildId: pair.guildId, panelId: pair.panelId, ...status });
  }

  private reportAll(): void {
    for (const pair of this.pairs.values()) this.report(pair);
  }

  private renewExpiry(key: string, pair: Pair): void {
    if (pair.expiry) clearTimeout(pair.expiry);
    pair.expiry = setTimeout(() => this.endWatch(key, pair), WATCH_MS);
    pair.expiry.unref?.();
  }

  private endWatch(key: string, pair: Pair): void {
    pair.expiry = null;
    if (this.pairs.get(key) !== pair) return;
    this.pairs.delete(key);
    const queued = this.fetchQueue.indexOf(pair);
    if (queued >= 0) this.fetchQueue.splice(queued, 1);
    if (this.pairs.size === 0 && (this.client || this.retry) && !this.closeTimer) {
      this.closeTimer = setTimeout(() => {
        this.closeTimer = null;
        if (this.pairs.size === 0) this.drop();
      }, CLOSE_AFTER_MS);
      this.closeTimer.unref?.();
    }
  }

  private applied(pair: Pair): void {
    this.applyClock += 1;
    pair.applySeq = this.applyClock;
  }

  /** An answer was refused: the pair is not live until a fetch sent from now on is applied. */
  private refetch(pair: Pair, resend: boolean): void {
    pair.updating = true;
    if (resend) pair.resend = true;
    pair.refetchSeq += 1;
    this.report(pair);
    this.fetchPair(pair);
  }

  private fetchPair(pair: Pair): void {
    if (pair.fetching) {
      pair.again = true;
      return;
    }
    if (this.fetchesRunning >= MAX_FETCHES) {
      if (!this.fetchQueue.includes(pair)) this.fetchQueue.push(pair);
      return;
    }
    pair.fetching = true;
    this.fetchesRunning += 1;
    void this.runFetch(pair).finally(() => {
      pair.fetching = false;
      this.fetchesRunning -= 1;
      if (pair.again && this.pairs.get(keyOf(pair.guildId, pair.panelId)) === pair) {
        pair.again = false;
        this.fetchPair(pair);
      }
      while (this.fetchesRunning < MAX_FETCHES && this.fetchQueue.length > 0) {
        const next = this.fetchQueue.shift()!;
        if (this.pairs.get(keyOf(next.guildId, next.panelId)) === next) this.fetchPair(next);
      }
    });
  }

  private async runFetch(pair: Pair): Promise<void> {
    // A fetch sent before the latest LISTEN may predate a notification lost in the gap: it never makes the pair live.
    const on = this.listening ? this.listenCount : -1;
    const sentAt = this.applyClock;
    const asked = pair.refetchSeq;
    const resend = pair.resend;
    const have = resend ? { haveVersion: 0, haveSince: null } : { haveVersion: pair.haveVersion, haveSince: pair.since };
    let answer: FetchAnswer;
    try {
      answer = await this.deps.fetch(pair.guildId, pair.panelId, pair.userId, have);
    } catch (error) {
      this.fetchFailed(pair, error instanceof Error ? error.message : String(error));
      return;
    }
    if (pair.applySeq > sentAt) {
      this.refetch(pair, false);
      return;
    }
    const reply = answer.reply ?? {};
    if (reply.success !== true) {
      if (reply.code === 'answer-too-large') pair.oversize = true;
      this.fetchFailed(pair, typeof reply.error === 'string' ? reply.error : 'no answer');
      return;
    }
    const name = typeof reply.servedBy === 'string' ? reply.servedBy : pair.name;
    pair.name = name;
    pair.fetched = true;
    pair.fetchedOn = on;
    pair.fetchFailed = false;
    pair.notifying = reply.notifying === null ? null : reply.notifying !== false;
    const since = typeof reply.since === 'number' ? reply.since : null;
    const process = answer.holderProcess ?? null;
    const version = Number.isSafeInteger(reply.version) && reply.version > 0 ? reply.version as number : 0;
    const same = process === pair.holderProcess && since === pair.since;
    const before = { holderProcess: pair.holderProcess, since: pair.since, haveVersion: pair.haveVersion };
    let emitted = false;
    if (reply.data !== null && reply.data !== undefined) {
      // An owner action's view noted while this fetch ran may be newer than its state: that state is not shown.
      if (resend || ((!same || version > pair.haveVersion) && !shownAtLeast(pair, process, since, version))) {
        this.deps.emitUpdate({ panelId: pair.panelId, guildId: pair.guildId, sessionId: null, response: reply.data, servedBy: name });
        pair.shown = { holderProcess: process, since, version };
        emitted = true;
      }
      pair.haveVersion = same && !resend ? Math.max(pair.haveVersion, version) : version;
      pair.missed = false;
      pair.oversize = false;
    } else {
      if (!same) {
        pair.haveVersion = 0;
        pair.missed = true;
      }
      if (reply.oversize) pair.oversize = true;
    }
    pair.holderProcess = process;
    pair.since = since;
    const changed = before.holderProcess !== process || before.since !== since || before.haveVersion !== pair.haveVersion;
    const asShown = pair.shown !== null && pair.shown.holderProcess === process && pair.shown.since === since && pair.shown.version === pair.haveVersion;
    if (emitted || (changed && !asShown)) this.applied(pair);
    if (pair.refetchSeq === asked) {
      pair.updating = false;
      pair.resend = false;
    }
    this.report(pair);
  }

  private fetchFailed(pair: Pair, cause: string): void {
    pair.fetchFailed = true;
    const now = performance.now();
    if (now - pair.lastLog >= LOG_EVERY_MS) {
      pair.lastLog = now;
      console.warn(`[PanelLive] Could not fetch the new state of panel ${pair.panelId} of server ${pair.guildId} from ${pair.name} (${cause})`);
    }
    this.report(pair);
  }

  private currentEntry(): string | null {
    const resolved = this.deps.entry();
    if ('entry' in resolved) return resolved.entry;
    this.listenReason = LIVE_REASONS.unreachable;
    this.failed = true;
    return null;
  }

  /** Ruling 11: the entry is read at each watch call and each check; another entry drops the connection. */
  private ensureListening(): void {
    const entry = this.currentEntry();
    if (this.client && entry !== this.clientEntry) this.drop();
    if (this.client || this.retry) return;
    this.connect();
  }

  private connect(): void {
    if (this.pairs.size === 0) return;
    const entry = this.currentEntry();
    if (entry === null) {
      this.scheduleRetry();
      this.reportAll();
      return;
    }
    const generation = ++this.generation;
    let config: ClientConfig;
    let client: ListenClient;
    try {
      config = pgConfig(entry);
      client = this.deps.makeClient({
        ...config, application_name: WEBUI_LISTEN_APP, connectionTimeoutMillis: CONNECT_MS, keepAlive: true, keepAliveInitialDelayMillis: 30_000,
      } as ClientConfig);
    } catch {
      this.listenReason = LIVE_REASONS.unreachable;
      this.failed = true;
      this.scheduleRetry();
      this.reportAll();
      return;
    }
    this.client = client;
    this.clientEntry = entry;
    client.on('error', () => this.lost(generation));
    client.on('end', () => this.lost(generation));
    client.on('notification', msg => this.notified(generation, msg));
    void (async () => {
      try {
        await within(client.connect(), CONNECT_MS);
        if (generation !== this.generation) return;
        if (transportOf(config, client) === 'unprotected') {
          this.listenReason = LIVE_REASONS.insecure;
          this.failed = true;
          this.drop();
          this.scheduleRetry();
          this.reportAll();
          return;
        }
        await within(client.query(`LISTEN ${PANEL_CHANNEL}`), CHECK_BOUND_MS);
      } catch {
        this.lost(generation);
        return;
      }
      if (generation !== this.generation) return;
      this.listening = true;
      this.listenCount += 1;
      this.failed = false;
      this.scheduleCheck(generation);
      this.reportAll();
      // A notification sent while nothing listened is lost: every watched pair is fetched once.
      for (const pair of this.pairs.values()) this.fetchPair(pair);
    })();
  }

  private scheduleCheck(generation: number): void {
    this.check = setTimeout(() => {
      this.check = null;
      const client = this.client;
      if (generation !== this.generation || !client) return;
      const entry = this.currentEntry();
      if (entry !== this.clientEntry) {
        this.drop();
        this.connect();
        return;
      }
      within(client.query('SELECT 1'), CHECK_BOUND_MS).then(
        () => { if (generation === this.generation) this.scheduleCheck(generation); },
        () => this.lost(generation),
      );
    }, CHECK_EVERY_MS);
    this.check.unref?.();
  }

  private notified(generation: number, msg: { channel: string; payload?: string }): void {
    if (generation !== this.generation || msg.channel !== PANEL_CHANNEL) return;
    let notice: { g?: unknown; p?: unknown };
    try {
      notice = JSON.parse(msg.payload ?? '');
    } catch {
      return;
    }
    if (typeof notice?.g !== 'string' || typeof notice.p !== 'string') return;
    const pair = this.pairs.get(keyOf(notice.g, notice.p));
    if (pair) this.fetchPair(pair);
  }

  private lost(generation: number): void {
    if (generation !== this.generation) return;
    this.listenReason = LIVE_REASONS.unreachable;
    this.failed = true;
    this.drop();
    this.scheduleRetry();
    this.reportAll();
  }

  private scheduleRetry(): void {
    if (this.retry || this.pairs.size === 0) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.pairs.size > 0) this.connect();
    }, RETRY_MS);
    this.retry.unref?.();
  }

  private drop(): void {
    this.generation += 1;
    this.listening = false;
    if (this.check) clearTimeout(this.check);
    this.check = null;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const client = this.client;
    this.client = null;
    this.clientEntry = null;
    if (client) {
      const socket = (client as { connection?: { stream?: { destroy?: () => void } } }).connection?.stream;
      void within(client.end(), 2000).catch(() => socket?.destroy?.());
    }
  }
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
    (timer as any).unref?.();
    work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

let watcher: PanelLiveWatch | null = null;

/** The web UI's one watcher, built at the first watch call. */
export function getPanelLiveWatch(build: () => WatchDeps): PanelLiveWatch {
  if (!watcher) watcher = new PanelLiveWatch(build());
  return watcher;
}

export function peekPanelLiveWatch(): PanelLiveWatch | null {
  return watcher;
}

export function _resetPanelLiveWatch(): void {
  watcher?.stop();
  watcher = null;
}

/** The real listening client and the reader's database. */
export const realWatchClient = (config: ClientConfig): ListenClient => new Client(config) as unknown as ListenClient;
export const realWatchEntry = (): { entry: string } | { refusal: string } => {
  const resolved = resolveWebuiDatabase();
  return 'entry' in resolved ? { entry: resolved.entry } : { refusal: resolved.refusal };
};
