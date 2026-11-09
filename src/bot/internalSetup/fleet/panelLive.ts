// Live panel changes for other machines' web panels (NB15 decision 15), the holder's side, Postgres only. A web panel
// that shows a guild panel this process runs registers an interest through its request rows; a change to a watched
// panel is kept as the pair's latest state and announced on 'smdb_panel_changed' (a signal only, no state), and the
// web panel fetches the state with a 'panel:live' request.

import { Pool } from 'pg';
import type { ClientConfig } from 'pg';
import { resolveDataBackend } from '../../../utils/envLoader';
import { classifyPoolClients, pgConfig, transportClassOf } from '../../../utils/databaseAddress';
import { guardPoolClients } from '../utils/pgClient';
import { ANSWER_LIMIT_BYTES, toTransport } from '../utils/transportJson';

export const PANEL_NOTIFY_APPLICATION_NAME = 'smdb-panel-notify';
export const PANEL_CHANNEL = 'smdb_panel_changed';
export const NOTIFY_SQL = `SELECT pg_notify('${PANEL_CHANNEL}', p) FROM unnest($1::text[]) AS p`;

const INTEREST_MS = 90_000;
const MAX_INTERESTS = 128;
const NOTIFY_EVERY_MS = 1000;
const NOTIFY_MAX = 100;
const NOTIFY_QUERY_MS = 3000;
const LOG_EVERY_MS = 60_000;
const UNPROTECTED_RETRY_MS = 60_000;
const MAX_PANEL_ID = 200;

export interface NotifyDb {
  /** Throws when the statement failed or was not sent (notSent), with the cause a log line names. */
  notify(payloads: string[]): Promise<void>;
}

interface Interest {
  since: number;
  renewedAt: number;
  kept: { data: unknown } | { oversize: { bytes: number; reason: string } } | null;
  /** Counts the kept states; a fetch is answered the kept state while its version is above the asker's. */
  version: number;
  marked: boolean;
}

const interests = new Map<string, Interest>();
let lastSince = 0;
/** Whether the last notify of this process worked; null until one has since the process started or the notifier last stopped. */
let notifying: boolean | null = null;
let failingSince: number | null = null;
let lastFailLog = -Infinity;
let timer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;
let dbOverride: NotifyDb | null = null;
let realDb: NotifyDb | null = null;
let enabled: () => boolean = () => resolveDataBackend() === 'postgres';

const keyOf = (guildId: string, panelId: string) => `${guildId}\u0000${panelId}`;

function live(key: string, now = performance.now()): Interest | null {
  const interest = interests.get(key);
  if (!interest) return null;
  if (now - interest.renewedAt > INTEREST_MS) {
    interests.delete(key);
    return null;
  }
  return interest;
}

function prune(now = performance.now()): void {
  for (const [key, interest] of interests) if (now - interest.renewedAt > INTEREST_MS) interests.delete(key);
}

/** The version of the pair's kept state, 0 without one or when `since` names another interest. */
export function liveVersionOf(guildId: string, panelId: string, since?: number): number {
  const interest = live(keyOf(guildId, panelId));
  if (!interest || (since !== undefined && interest.since !== since)) return 0;
  return interest.version;
}

/** The owner panel ops whose answer is kept as the pair's state: a button, a select menu and a modal submit. */
export const VIEW_CHANGE_OPS: readonly string[] = ['panel:button', 'panel:dropdown', 'panel:modal'];

/** Registers or renews the interest in a pair; its since, or null when 128 interests are held already. */
export function registerInterest(guildId: string, panelId: string): number | null {
  const now = performance.now();
  const key = keyOf(guildId, panelId);
  let interest = live(key, now);
  if (interest) {
    interest.renewedAt = now;
  } else {
    prune(now);
    if (interests.size >= MAX_INTERESTS) return null;
    const since = Math.max(Date.now(), lastSince + 1);
    lastSince = since;
    interest = { since, renewedAt: now, kept: null, version: 0, marked: false };
    interests.set(key, interest);
  }
  if (notifying !== true) ensureNotifier();
  return interest.since;
}

/** A change of a panel on this process (sendLiveUpdate): kept and marked only when some web panel watches the pair. */
export function noteLiveChange(guildId: string | null, panelId: string, response: unknown): void {
  if (!guildId || typeof panelId !== 'string') return;
  const interest = live(keyOf(guildId, panelId));
  if (!interest) return;
  keep(interest, response);
}

function keep(interest: Interest, view: unknown): void {
  const { answer } = toTransport({ success: true, data: view }, ANSWER_LIMIT_BYTES);
  interest.kept = 'oversize' in answer
    ? { oversize: answer.oversize as { bytes: number; reason: string } }
    : { data: answer.data };
  interest.version += 1;
  interest.marked = true;
  ensureNotifier();
}

/** A panel's view in an action's answer: not a modal shown over the panel and not the return to the panel list. */
export function isPanelView(data: unknown): boolean {
  return data !== null && typeof data === 'object' && !Array.isArray(data) && !('modal' in data) && !('returnToPanelList' in data);
}

/**
 * An owner action's answer, as it is built: its view becomes the pair's kept state under a new version, so the kept
 * state is never older than a view a web panel shows. The new version, or null when the answer holds no view or the
 * interest of `since` is gone.
 */
export function recordActionView(guildId: string, panelId: string, since: number, answer: unknown): number | null {
  const interest = live(keyOf(guildId, panelId));
  if (!interest || interest.since !== since) return null;
  const reply = answer as { success?: unknown; data?: unknown } | null;
  if (!reply || reply.success !== true || !isPanelView(reply.data)) return null;
  keep(interest, reply.data);
  return interest.version;
}

/**
 * 'panel:live': the kept state of a pair, after the start checks registered the interest, with its version. The state is
 * sent while its version is above haveVersion, the version the asking web UI last delivered to its page under the same
 * since; otherwise data is null.
 */
export function liveAnswer(guildId: string, panelId: string, since: number | null, haveVersion = 0, haveSince: number | null = null): Record<string, unknown> {
  const interest = since === null ? null : live(keyOf(guildId, panelId));
  const version = interest ? interest.version : 0;
  const answer: Record<string, unknown> = { success: true, data: null, since: interest ? interest.since : null, version, notifying };
  const kept = interest?.kept ?? null;
  const have = interest && haveSince === interest.since ? haveVersion : 0;
  if (!interest || !kept || version <= have) return answer;
  if ('data' in kept) answer.data = kept.data;
  else answer.oversize = kept.oversize;
  return answer;
}

export function isNotifying(): boolean | null {
  return notifying;
}

function ensureNotifier(): void {
  if (timer || !enabled()) return;
  timer = setInterval(() => { void notifyTick(); }, NOTIFY_EVERY_MS);
  timer.unref?.();
}

/** One notify statement for the marked pairs, at most 100; single-flight. */
export function notifyTick(): Promise<void> {
  if (running) return running;
  const run = (async () => {
    prune();
    const marked: Array<[string, Interest]> = [];
    for (const entry of interests) if (entry[1].marked) marked.push(entry);
    if (marked.length === 0) {
      if (interests.size === 0) {
        stopNotifier();
        return;
      }
      // With no change to announce, a statement with no payload shows whether announcing works again.
      if (notifying !== true) {
        try {
          await notifyDb().notify([]);
        } catch (error) {
          noteFailed(error instanceof Error ? error.message : String(error));
          return;
        }
        noteWorks();
      }
      return;
    }
    const batch = marked.slice(0, NOTIFY_MAX);
    const payloads: string[] = [];
    for (const [key, interest] of batch) {
      const [g, p] = key.split('\u0000');
      if (p.length > MAX_PANEL_ID) {
        interest.marked = false;
        continue;
      }
      payloads.push(JSON.stringify({ g, p }));
    }
    if (payloads.length === 0) return;
    try {
      await notifyDb().notify(payloads);
    } catch (error) {
      noteFailed(error instanceof Error ? error.message : String(error));
      return;
    }
    for (const [, interest] of batch) interest.marked = false;
    noteWorks();
  })();
  running = run;
  return run.finally(() => { running = null; });
}

function stopNotifier(): void {
  if (timer) clearInterval(timer);
  timer = null;
  notifying = null;
}

function noteFailed(cause: string): void {
  const now = performance.now();
  notifying = false;
  prune(now);
  if (interests.size > 0 && (failingSince === null || now - lastFailLog >= LOG_EVERY_MS)) {
    console.error(`[PanelLive] Could not tell other machines' web panels that panels changed (${cause}); panels shown there may be out of date until this works`);
    lastFailLog = now;
  }
  if (failingSince === null) failingSince = now;
}

function noteWorks(): void {
  // Web panels told false or null learn true only by fetching again, so each watched pair is announced.
  if (notifying !== true) for (const interest of interests.values()) interest.marked = true;
  notifying = true;
  if (failingSince === null) return;
  const logged = lastFailLog !== -Infinity;
  failingSince = null;
  lastFailLog = -Infinity;
  if (logged) console.log("[PanelLive] Telling other machines' web panels about panel changes works again");
}

function notifyDb(): NotifyDb {
  if (dbOverride) return dbOverride;
  if (!realDb) realDb = pgNotifyDb();
  return realDb;
}

/** The notify pool, built as the sweep's pool is built: from the chosen entry, again at every move; NB5 G9's gate. */
function pgNotifyDb(): NotifyDb {
  let pool: Pool | null = null;
  let unprotectedAt = -Infinity;
  const build = (entry: string): Pool => {
    const config: ClientConfig = pgConfig(entry);
    const next = new Pool({
      max: 1,
      min: 0,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
      application_name: PANEL_NOTIFY_APPLICATION_NAME,
      statement_timeout: 2000,
      ...config,
    } as ConstructorParameters<typeof Pool>[0]);
    next.on('error', () => { /* an idle client's error; the next statement answers for itself */ });
    guardPoolClients(next, 'the panel notify pool');
    classifyPoolClients(next, config);
    return next;
  };
  let watching = false;
  return {
    async notify(payloads) {
      // Loaded at the first notify: guildRequests.ts loads the data backend, which the panel adapter must not load early.
      const { pgBackendOf, backendGate } = await import('./guildRequests');
      const refusal = backendGate.refusal();
      if (refusal !== null) throw new Error(refusal);
      const backend = pgBackendOf();
      const entry = backend?.chosenEntry() ?? null;
      if (!backend || entry === null) throw new Error('the bot process has not chosen its database yet');
      if (!watching) {
        watching = true;
        backend.onDatabaseChanged(() => {
          const old = pool;
          pool = null;
          void old?.end().catch(() => undefined);
        });
      }
      if (performance.now() - unprotectedAt < UNPROTECTED_RETRY_MS) {
        throw new Error("this machine's database address does not check the database's certificate");
      }
      if (!pool) pool = build(entry);
      const client = await pool.connect();
      if (transportClassOf(client) === 'unprotected') {
        unprotectedAt = performance.now();
        client.release(true);
        throw new Error("this machine's database address does not check the database's certificate");
      }
      let destroy = false;
      try {
        await client.query({ text: NOTIFY_SQL, values: [payloads], query_timeout: NOTIFY_QUERY_MS } as any);
      } catch (error) {
        destroy = typeof (error as { code?: unknown })?.code !== 'string';
        throw error;
      } finally {
        client.release(destroy ? true : undefined);
      }
    },
  };
}

/** Tests script the notify statement and whether the notifier runs. */
export function _setNotifyDb(db: NotifyDb | null, on?: () => boolean): void {
  dbOverride = db;
  if (on) enabled = on;
}

export function _resetPanelLive(): void {
  interests.clear();
  lastSince = 0;
  notifying = null;
  failingSince = null;
  lastFailLog = -Infinity;
  if (timer) clearInterval(timer);
  timer = null;
  running = null;
  dbOverride = null;
  realDb = null;
  enabled = () => resolveDataBackend() === 'postgres';
}

export function _interestCount(): number {
  prune();
  return interests.size;
}
