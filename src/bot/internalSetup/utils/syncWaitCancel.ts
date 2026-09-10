/**
 * The acknowledged-write hole (PLAN_REPLICATION 20.5, B6 map F24).
 *
 * A backend waiting for synchronous replication that is CANCELLED does not
 * fail: postgres returns SUCCESS with only a WARNING, and the row is there
 * afterwards. So a write can be acknowledged to its caller while it still
 * lives on one machine only, which is exactly the case the RPO=0 claim must
 * not cover. The warning arrives as a pg 'notice', which nothing listened for.
 *
 * What actually produces it, measured rather than assumed: an explicit
 * pg_cancel_backend or pg_terminate_backend, which the promote's own fence
 * sweep issues against every other client backend on the old primary. Neither
 * statement_timeout nor node-pg's query_timeout can: postgres disables the
 * statement timeout before the commit's wait begins, and query_timeout only
 * rejects the client's promise without cancelling anything. That is worth
 * knowing in both directions, because it also means no fleet write is bounded
 * while the posture is armed.
 *
 * The latch is raised wherever the notice lands and read by the master's
 * posture engine, which disarms on it. This module is a LEAF on purpose: the
 * data layer may not import fleet (fleet already imports dataManager), and
 * both sides have to be able to raise it.
 */

/** Both wordings postgres uses: the query-cancel one and the terminate-connection one. */
const CANCEL_FRAGMENT = 'wait for synchronous replication';

export interface SyncWaitCancel {
  at: number;
  /** Which connection saw it, for the log line only. */
  source: string;
  message: string;
}

let latched: SyncWaitCancel | undefined;

/** Anything with pg's notice event; kept structural so the leaf pulls in no pg types. */
interface NoticeEmitter {
  on(event: 'notice', listener: (notice: { message?: string }) => void): unknown;
}

interface ClientSource {
  on(event: 'connect', listener: (client: NoticeEmitter) => void): unknown;
}

export function noteSyncWaitNotice(source: string, message: string): void {
  if (!message.toLowerCase().includes(CANCEL_FRAGMENT)) return;
  latched = { at: Date.now(), source, message };
  console.error(`[Fleet] A write's synchronous replication wait was CANCELLED on ${source}; that commit is outside the zero-loss guarantee: ${message}`);
}

/** Watch one connection. Safe to call on a client that never writes; the notice simply never arrives. */
export function watchForSyncWaitCancel(client: NoticeEmitter, source: string): void {
  client.on('notice', notice => noteSyncWaitNotice(source, String(notice?.message ?? '')));
}

/** Watch every connection a pool opens from now on; pooled clients are created lazily, so attach before first use. */
export function watchPoolForSyncWaitCancel(pool: ClientSource, source: string): void {
  pool.on('connect', client => watchForSyncWaitCancel(client, source));
}

/** The latch, if raised. Only the posture engine consumes it. */
export function getSyncWaitCancel(): SyncWaitCancel | undefined {
  return latched;
}

export function clearSyncWaitCancel(): void {
  latched = undefined;
}
