// Identify-budget ledger for this process: tracks Discord's
// session_start_limit with local debits since the last fetch, so the gauge
// counts identifies this process spent before Discord reports them.

import { BUDGET_CHARGE_REFRESH_MS, BUDGET_REFRESH_MS, IDENTIFY_SPACING_MS } from './constants';
import { fetchGatewayInfoResult, SessionStartLimit } from './placement';

export interface BudgetInfo {
  total: number;
  remaining: number;
  resetAfterMs: number;
  fetchedAgoMs: number;
  stale: boolean;
  /** /gateway/bot has never answered, so the numbers above are placeholders. */
  unavailable?: boolean;
}

export class IdentifyLedger {
  private lastFetch: (SessionStartLimit & { fetchedAt: number }) | null;
  private stale: boolean;
  /** One charge timestamp (epoch ms) per debited identify; length is the debit total. */
  private localDebits: number[] = [];
  private refreshQueued = false;
  private refreshInFlight: Promise<void> | null = null;
  private recommendation: { shards: number; readAt: number } | null;

  constructor(
    private readonly token: string | undefined,
    private readonly shardCount: number,
    seed: SessionStartLimit | null,
    seedRecommendation: number | null = null,
  ) {
    this.recommendation = seedRecommendation !== null ? { shards: seedRecommendation, readAt: Date.now() } : null;
    this.lastFetch = seed ? { ...seed, fetchedAt: Date.now() } : null;
    this.stale = seed === null;
    setInterval(() => void this.refresh(), BUDGET_REFRESH_MS).unref();
  }

  /** Debit identifies this process is about to spend. */
  charge(nIdentifies: number): void {
    if (nIdentifies <= 0) return;
    const now = Date.now();
    for (let i = 0; i < nIdentifies; i++) this.localDebits.push(now);
    this.scheduleRefresh();
  }

  getBudgetInfo(): BudgetInfo {
    const now = Date.now();
    if (!this.lastFetch) {
      return { total: 0, remaining: 0, resetAfterMs: 0, fetchedAgoMs: 0, stale: true, unavailable: true };
    }
    return {
      total: this.lastFetch.total,
      remaining: Math.max(0, this.lastFetch.remaining - this.localDebits.length),
      resetAfterMs: Math.max(0, this.lastFetch.fetchedAt + this.lastFetch.resetAfterMs - now),
      fetchedAgoMs: now - this.lastFetch.fetchedAt,
      stale: this.stale,
    };
  }

  /** Discord's shard recommendation from the last successful /gateway/bot read, and when it was read; null before any. */
  getRecommendation(): { shards: number; readAt: number } | null {
    return this.recommendation;
  }

  private scheduleRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    setTimeout(() => {
      this.refreshQueued = false;
      void this.refresh();
    }, BUDGET_CHARGE_REFRESH_MS).unref();
  }

  /** Coalesce concurrent callers into the running fetch: overlapping refreshes would forgive the same consumption twice. */
  private refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh().finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<void> {
    const prev = this.lastFetch;
    const { info, error } = await fetchGatewayInfoResult(this.token);
    if (info) this.recommendation = { shards: info.recommendedShards, readAt: Date.now() };
    if (info?.sessionStartLimit) {
      const live = info.sessionStartLimit;
      const now = Date.now();
      if (prev) {
        const resetAt = prev.fetchedAt + prev.resetAfterMs;
        if (live.remaining > prev.remaining || now >= resetAt) {
          // Daily window rolled over: only post-reset charges stay debited.
          const resetInstant = Math.min(resetAt, now);
          this.localDebits = this.localDebits.filter(t => t > resetInstant);
        } else {
          // Charged identifies may not have hit Discord yet, so only forgive
          // (oldest-first) the debits the live value shows as consumed.
          const consumed = Math.max(0, prev.remaining - live.remaining);
          if (consumed > 0) this.localDebits.splice(0, consumed);
        }
      }
      // A debit older than the worst-case identify window never ran: age it out.
      const maxAgeMs = BUDGET_REFRESH_MS + this.shardCount * IDENTIFY_SPACING_MS + 60000;
      const cutoff = Date.now() - maxAgeMs;
      this.localDebits = this.localDebits.filter(t => t > cutoff);
      this.lastFetch = { ...live, fetchedAt: Date.now() };
      this.stale = false;
    } else {
      this.stale = true;
      console.warn(`[Shards] Identify-budget refresh failed (/gateway/bot: ${error}); budget gauge is stale`);
    }
  }
}
