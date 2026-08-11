// Master-only identify-budget ledger (fleet mode; never instantiated
// standalone): tracks Discord's session_start_limit with local debits since
// the last fetch, and per-node crash-loop backoff so a flapping worker cannot
// burn the shared token's daily identify budget.

import {
  BUDGET_REFRESH_MS,
  BUDGET_RESERVE_PCT,
  CRASH_LOOP_THRESHOLD,
  CRASH_LOOP_WINDOW_MS,
  HEARTBEAT_MS,
  IDENTIFY_BACKOFF_BASE_MS,
  IDENTIFY_BACKOFF_MAX_MS,
  IDENTIFY_SPACING_MS,
} from './constants';
import type { BudgetInfo } from './protocol';
import { fetchGatewayInfo, SessionStartLimit } from './placement';
import type { Registry } from './registry';

export type PermitResult = { ok: true } | { ok: false; retryInMs: number; reason: string };

interface NodeIdentifyHistory {
  registeredAt: number[];
  grantsCharged: number;
  backoffUntil: number;
}

export class IdentifyLedger {
  private lastFetch: (SessionStartLimit & { fetchedAt: number }) | null;
  private stale: boolean;
  /** One charge timestamp (epoch ms) per debited identify; length is the debit total. */
  private localDebits: number[] = [];
  private readonly history = new Map<string, NodeIdentifyHistory>();
  private refreshQueued = false;
  private refreshInFlight: Promise<void> | null = null;

  constructor(
    private readonly token: string | undefined,
    private readonly registry: Registry,
    seed: SessionStartLimit | null,
  ) {
    this.lastFetch = seed ? { ...seed, fetchedAt: Date.now() } : null;
    this.stale = seed === null;
    setInterval(() => void this.refresh(), BUDGET_REFRESH_MS).unref();
  }

  onRegister(nodeId: string): void {
    const now = Date.now();
    const history = this.history.get(nodeId) ?? { registeredAt: [], grantsCharged: 0, backoffUntil: 0 };
    history.registeredAt = [...history.registeredAt.filter(t => now - t < CRASH_LOOP_WINDOW_MS), now];
    if (history.registeredAt.length >= CRASH_LOOP_THRESHOLD) {
      const backoffMs = Math.min(
        IDENTIFY_BACKOFF_BASE_MS * 2 ** (history.registeredAt.length - CRASH_LOOP_THRESHOLD),
        IDENTIFY_BACKOFF_MAX_MS,
      );
      history.backoffUntil = now + backoffMs;
      const name = this.registry.nodes.get(nodeId)?.nodeName ?? nodeId;
      console.warn(`[Fleet] Crash loop suspected for ${name} (${history.registeredAt.length} registrations in ${Math.round(CRASH_LOOP_WINDOW_MS / 60000)}m); identify permits held for ${Math.round(backoffMs / 1000)}s`);
    }
    this.history.set(nodeId, history);
  }

  inBackoff(nodeId: string): boolean {
    return (this.history.get(nodeId)?.backoffUntil ?? 0) > Date.now();
  }

  /** Direct cooldown (lease declines): the candidate filter skips the node until it expires. */
  penalize(nodeId: string, cooldownMs: number): void {
    const history = this.history.get(nodeId) ?? { registeredAt: [], grantsCharged: 0, backoffUntil: 0 };
    history.backoffUntil = Math.max(history.backoffUntil, Date.now() + cooldownMs);
    this.history.set(nodeId, history);
  }

  getNodeBackoff(nodeId: string): { crashCount: number; nextPermitInMs: number } | null {
    const history = this.history.get(nodeId);
    const now = Date.now();
    if (!history || history.backoffUntil <= now) return null;
    return {
      crashCount: history.registeredAt.filter(t => now - t < CRASH_LOOP_WINDOW_MS).length,
      nextPermitInMs: history.backoffUntil - now,
    };
  }

  permit(nodeId: string, nIdentifies: number): PermitResult {
    const now = Date.now();
    const backoffUntil = this.history.get(nodeId)?.backoffUntil ?? 0;
    if (backoffUntil > now) {
      return { ok: false, retryInMs: backoffUntil - now, reason: 'crash-loop backoff' };
    }
    if (this.lastFetch) {
      const floor = Math.max(this.registry.shardCount, Math.ceil(this.lastFetch.total * BUDGET_RESERVE_PCT));
      const estimatedRemaining = this.lastFetch.remaining - this.localDebits.length;
      if (estimatedRemaining - nIdentifies < floor) {
        const resetInMs = Math.max(HEARTBEAT_MS, this.lastFetch.fetchedAt + this.lastFetch.resetAfterMs - now);
        return { ok: false, retryInMs: resetInMs, reason: `budget floor (${estimatedRemaining} remaining, floor ${floor})` };
      }
    }
    return { ok: true };
  }

  /**
   * Permit check + debit in one synchronous step, so concurrent grant paths
   * (distribute round, manual assign) can never both pass the floor on the
   * same headroom. The caller releases only when the worker provably did not
   * adopt the grant; unacked/drain-raced grants keep the debit (conservative,
   * reconciled by refresh against live consumption).
   */
  reserve(nodeId: string, nIdentifies: number): PermitResult {
    const verdict = this.permit(nodeId, nIdentifies);
    if (!verdict.ok || nIdentifies === 0) return verdict;
    const now = Date.now();
    for (let i = 0; i < nIdentifies; i++) this.localDebits.push(now);
    const history = this.history.get(nodeId) ?? { registeredAt: [], grantsCharged: 0, backoffUntil: 0 };
    history.grantsCharged += 1;
    this.history.set(nodeId, history);
    this.scheduleRefresh();
    return verdict;
  }

  /** Undo a reservation whose grant the worker provably did not adopt. */
  release(_nodeId: string, nIdentifies: number): void {
    if (nIdentifies <= 0) return;
    this.localDebits.splice(-nIdentifies, nIdentifies);
  }

  getBudgetInfo(): BudgetInfo | null {
    const now = Date.now();
    const backoffs: BudgetInfo['backoffs'] = [];
    for (const [nodeId, history] of this.history) {
      if (history.backoffUntil <= now) continue;
      const node = this.registry.nodes.get(nodeId);
      if (!node) continue;
      backoffs.push({
        nodeId,
        nodeName: node.nodeName,
        crashCount: history.registeredAt.filter(t => now - t < CRASH_LOOP_WINDOW_MS).length,
        nextPermitInMs: history.backoffUntil - now,
      });
    }
    if (!this.lastFetch) {
      // /gateway/bot has never succeeded: surface an explicit unavailable
      // state (fleet mode must show the gap, not hide the card like standalone).
      return { total: 0, remaining: 0, resetAfterMs: 0, fetchedAgoMs: 0, stale: true, unavailable: true, backoffs };
    }
    return {
      total: this.lastFetch.total,
      remaining: Math.max(0, this.lastFetch.remaining - this.localDebits.length),
      resetAfterMs: Math.max(0, this.lastFetch.fetchedAt + this.lastFetch.resetAfterMs - now),
      fetchedAgoMs: now - this.lastFetch.fetchedAt,
      stale: this.stale,
      backoffs,
    };
  }

  /** Coalesce the post-grant-round refresh; charged rounds arrive one grant at a time. */
  private scheduleRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    setTimeout(() => {
      this.refreshQueued = false;
      void this.refresh();
    }, HEARTBEAT_MS).unref();
  }

  /** Coalesce concurrent callers into the running fetch: overlapping refreshes would forgive the same consumption twice. */
  private refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh().finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<void> {
    const prev = this.lastFetch;
    const info = await fetchGatewayInfo(this.token);
    if (info?.sessionStartLimit) {
      const live = info.sessionStartLimit;
      const now = Date.now();
      if (prev) {
        const resetAt = prev.fetchedAt + prev.resetAfterMs;
        if (live.remaining > prev.remaining || now >= resetAt) {
          // Daily window rolled over: pre-reset charges were absorbed by the
          // rollover or run against the fresh window; only post-reset charges
          // stay debited (they are invisible to the consumed delta forever).
          const resetInstant = Math.min(resetAt, now);
          this.localDebits = this.localDebits.filter(t => t > resetInstant);
        } else {
          // Charged identifies are queued worker-side (debounce + spacing) and
          // may not have hit Discord yet, so only forgive (oldest-first) debits
          // the live value shows as consumed; zeroing here would let grants
          // pierce the reserve floor.
          const consumed = Math.max(0, prev.remaining - live.remaining);
          if (consumed > 0) this.localDebits.splice(0, consumed);
        }
      }
      // A debit older than the worst-case execute window is provably phantom
      // (its identify never ran, e.g. an unacked grant the worker dropped):
      // age it out so it cannot deflate the gauge forever.
      const maxAgeMs = BUDGET_REFRESH_MS + this.registry.shardCount * IDENTIFY_SPACING_MS + 60000;
      const cutoff = Date.now() - maxAgeMs;
      this.localDebits = this.localDebits.filter(t => t > cutoff);
      this.lastFetch = { ...live, fetchedAt: Date.now() };
      this.stale = false;
    } else {
      this.stale = true;
      console.warn('[Fleet] Identify-budget refresh FAILED (/gateway/bot); budget gauge is stale');
    }
  }
}
