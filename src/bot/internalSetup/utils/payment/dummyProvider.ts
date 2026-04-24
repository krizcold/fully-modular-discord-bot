/**
 * DummyProvider
 *
 * A fully simulated payment provider. Not a stub; it maintains its own
 * state file, runs its own tick loop, and fires events the same way a real
 * provider would. This validates the provider boundary end to end before
 * any real provider (Stripe, Lemon Squeezy, Discord App Monetization,
 * Patreon, Server Boosting, Custom) lands.
 *
 * State file: /data/global/payment-providers/dummy/state.json
 */

import fs from 'fs';
import path from 'path';
import { ensureDir } from '../pathHelpers';
import { getPaymentRegistry } from './paymentRegistry';
import type {
  PaymentProvider,
  ProviderCapabilities,
  ProviderSubscriptionState,
  InitiateOpts,
  InitiateResult,
} from './paymentTypes';

interface DummyRecord {
  providerSubId: string;
  guildId: string;
  tierId: string;
  offeringId: string;
  durationDays: number | null;
  startDate: string;
  endDate: string | null;
  autoRenew: boolean;
  status: 'active' | 'expired';
  /** When true, the tick loop skips this record (paused by the host for stacking). */
  paused?: boolean;
  pausedAt?: string;
  couponCode?: string;
  meta?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

interface DummyState {
  subscriptions: Record<string, DummyRecord>;
  nextId: number;
}

const STATE_PATH = '/data/global/payment-providers/dummy/state.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STATE: DummyState = { subscriptions: {}, nextId: 1 };

const CAPABILITIES: ProviderCapabilities = {
  canInitiatePurchase: true,
  supportsCancel: true,
  supportsReactivate: true,
  supportsCustomPricing: true,
  supportsCoupons: true,
  supportsPause: true,
  mechanism: 'immediate',
  // Common offering fields (amount, currency, durationDays, autoRenewEligible)
  // live at the offering level now. offeringSchema only declares provider-specific
  // extras; Dummy has none.
  offeringSchema: [],
};

export class DummyProvider implements PaymentProvider {
  readonly id = 'dummy';
  readonly displayName = 'Dummy (Development)';
  readonly capabilities = CAPABILITIES;

  private state: DummyState = JSON.parse(JSON.stringify(DEFAULT_STATE));
  private loaded = false;
  private tickTimer: NodeJS.Timeout | null = null;

  isConfigured(): boolean {
    return true; // Dummy is always usable
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    try {
      ensureDir(path.dirname(STATE_PATH));
      if (fs.existsSync(STATE_PATH)) {
        const raw = fs.readFileSync(STATE_PATH, 'utf-8');
        const loaded = JSON.parse(raw) as Partial<DummyState>;
        this.state = {
          subscriptions: loaded.subscriptions || {},
          nextId: loaded.nextId || 1,
        };
      } else {
        this.save();
      }
    } catch (err) {
      console.error('[DummyProvider] Failed to load state:', err);
    }
    this.loaded = true;
  }

  private save(): void {
    try {
      ensureDir(path.dirname(STATE_PATH));
      fs.writeFileSync(STATE_PATH, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error('[DummyProvider] Failed to save state:', err);
    }
  }

  private stateFrom(r: DummyRecord): ProviderSubscriptionState {
    return {
      status: r.status,
      startDate: r.startDate,
      endDate: r.endDate,
      autoRenew: r.autoRenew,
      meta: r.meta,
    };
  }

  async initiatePurchase(opts: InitiateOpts): Promise<InitiateResult> {
    this.ensureLoaded();
    const nowIso = new Date().toISOString();

    // Apply coupon mechanically: percentOff is cosmetic for Dummy (we don't
    // actually charge anything), but extraDays does extend the subscription.
    // We look up the validated effect via PremiumManager to avoid duplicating
    // rules here; lazy-required to avoid a static circular import.
    let extraDays = 0;
    if (opts.couponCode) {
      try {
        const { getPremiumManager } = require('../premiumManager') as typeof import('../premiumManager');
        const check = getPremiumManager().validateCoupon(opts.couponCode, opts.tierId);
        if (check.valid && typeof check.effect?.extraDays === 'number') {
          extraDays = check.effect.extraDays;
        }
      } catch { /* if PM isn't ready, ignore the bonus */ }
    }

    const totalDays = opts.durationDays === null ? null : opts.durationDays + extraDays;
    const endDate = totalDays === null
      ? null
      : new Date(Date.now() + totalDays * DAY_MS).toISOString();

    const providerSubId = `dummy_${this.state.nextId++}`;
    const record: DummyRecord = {
      providerSubId,
      guildId: opts.guildId,
      tierId: opts.tierId,
      offeringId: opts.offeringId,
      durationDays: totalDays,
      startDate: nowIso,
      endDate,
      autoRenew: endDate !== null,
      status: 'active',
      couponCode: opts.couponCode,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.state.subscriptions[providerSubId] = record;
    this.save();

    return {
      providerSubId,
      state: this.stateFrom(record),
    };
  }

  async cancelSubscription(providerSubId: string): Promise<void> {
    this.ensureLoaded();
    const r = this.state.subscriptions[providerSubId];
    if (!r) return;
    r.autoRenew = false;
    r.updatedAt = new Date().toISOString();
    this.save();
    getPaymentRegistry().emitEvent({
      type: 'subscription.cancelled',
      providerId: this.id,
      providerSubId,
      guildId: r.guildId,
      state: this.stateFrom(r),
    });
  }

  async reactivateSubscription(providerSubId: string): Promise<void> {
    this.ensureLoaded();
    const r = this.state.subscriptions[providerSubId];
    if (!r) return;
    if (r.status !== 'active') return;
    if (r.endDate !== null && Date.parse(r.endDate) <= Date.now()) return;
    r.autoRenew = true;
    r.updatedAt = new Date().toISOString();
    this.save();
    getPaymentRegistry().emitEvent({
      type: 'subscription.updated',
      providerId: this.id,
      providerSubId,
      guildId: r.guildId,
      state: this.stateFrom(r),
    });
  }

  async pauseSubscription(providerSubId: string): Promise<void> {
    this.ensureLoaded();
    const r = this.state.subscriptions[providerSubId];
    if (!r) return;
    if (r.status !== 'active' || r.paused) return;
    r.paused = true;
    r.pausedAt = new Date().toISOString();
    r.updatedAt = r.pausedAt;
    this.save();
    // No event emitted: pausing is a host-orchestrated bookkeeping move; the
    // guild's effective tier changes because the HIGHER-priority sub takes
    // the active slot, not because this one changed state.
  }

  async resumeSubscription(providerSubId: string, newEndDate: string | null): Promise<void> {
    this.ensureLoaded();
    const r = this.state.subscriptions[providerSubId];
    if (!r) return;
    if (!r.paused) return;
    const nowIso = new Date().toISOString();
    r.paused = false;
    r.pausedAt = undefined;
    r.startDate = nowIso;
    r.endDate = newEndDate;
    r.status = 'active';
    r.updatedAt = nowIso;
    this.save();
    getPaymentRegistry().emitEvent({
      type: 'subscription.updated',
      providerId: this.id,
      providerSubId,
      guildId: r.guildId,
      state: this.stateFrom(r),
    });
  }

  async getSubscriptionState(providerSubId: string): Promise<ProviderSubscriptionState | null> {
    this.ensureLoaded();
    const r = this.state.subscriptions[providerSubId];
    return r ? this.stateFrom(r) : null;
  }

  start(): void {
    this.ensureLoaded();
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), 60_000);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * Periodic simulation: walk every active subscription whose endDate has
   * passed and either roll it forward (autoRenew=true) or expire it.
   * Emits the same events a real provider's webhook would.
   */
  private tick(): void {
    this.ensureLoaded();
    const now = Date.now();
    const nowIso = new Date().toISOString();
    let changed = false;
    const registry = getPaymentRegistry();

    for (const r of Object.values(this.state.subscriptions)) {
      if (r.status !== 'active') continue;
      if (r.paused) continue; // Paused by the host for stacking; do not count down.
      if (r.endDate === null) continue; // Lifetime never ticks
      if (Date.parse(r.endDate) > now) continue;

      if (r.autoRenew && r.durationDays !== null) {
        const base = Date.parse(r.endDate);
        r.endDate = new Date(base + r.durationDays * DAY_MS).toISOString();
        r.updatedAt = nowIso;
        changed = true;
        registry.emitEvent({
          type: 'subscription.renewed',
          providerId: this.id,
          providerSubId: r.providerSubId,
          guildId: r.guildId,
          state: this.stateFrom(r),
        });
      } else {
        r.status = 'expired';
        r.updatedAt = nowIso;
        changed = true;
        registry.emitEvent({
          type: 'subscription.expired',
          providerId: this.id,
          providerSubId: r.providerSubId,
          guildId: r.guildId,
          state: this.stateFrom(r),
        });
      }
    }

    if (changed) this.save();
  }
}
