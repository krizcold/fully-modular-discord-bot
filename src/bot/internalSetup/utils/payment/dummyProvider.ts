/**
 * DummyProvider - fully simulated payment provider.
 *
 * Self-contained simulator that maintains its own state file: variants,
 * products, coupons, subscriptions. Implements the full PaymentProvider
 * interface (Price mode + Product mode + coupon validation + pause/resume +
 * listVariants + migrateSubscriptionPrice) so the boundary can be exercised
 * end-to-end before any real provider lands.
 *
 * State file: /data/global/payment-providers/dummy/state.json
 *
 * The cache follows premium-tiers.json's rule (decision 12 of NB10): the bot
 * process holds the writer lock and never reloads; the web UI reloads when the
 * file, read through the queue, differs from the text it last loaded or saved.
 */

import { dataPath } from '../../../../utils/dataRoot';
import { DataBackendUnavailableError, onWriterTake, readRawStrict, saveDataTracked } from '../dataManager';
import { markRetried, outsideLedgers, recordRefusal, type LedgerCause } from '../dataBackends/writeLedger';
import { errnoOf, isBotProcess, isPremiumReplaying, registerCacheStop, stopCause, stopWords, unregisterCacheStop, type StopKind } from '../premiumManager';
import { getPaymentRegistry } from './paymentRegistry';
import { isMaintenanceGateClosed } from '../maintenanceGate';
import { writerLockDepth } from '../writerLock';
import type {
  PaymentProvider,
  ProviderCapabilities,
  ProviderSubscriptionState,
  ProviderSubscriptionRef,
  InitiateOpts,
  InitiateResult,
  OfferingVariant,
  ProviderCouponValidation,
} from './paymentTypes';

// ============================================================================
// STATE SHAPE
// ============================================================================

/** A simulated variant the admin has registered. */
interface DummyVariant {
  variantId: string;
  label: string;
  amount: number;        // minor units
  currency: string;      // ISO 4217
  durationDays: number | null;
  trialDays?: number;
  recurring: boolean;
  active: boolean;
}

/** A simulated product (group of variants) for Product-mode testing. */
interface DummyProduct {
  productId: string;
  label: string;
  description?: string;
  variantIds: string[];
}

/** A simulated coupon. percentOff XOR extraDays. */
interface DummyCoupon {
  code: string;
  description?: string;
  percentOff?: number;
  extraDays?: number;
  maxUses?: number;
  usedCount: number;
  createdAt: string;
  expiresAt?: string;
}

/** A live or historical simulated subscription. */
interface DummyRecord {
  providerSubId: string;
  guildId: string;
  tierId: string;
  offeringId: string;
  variantId: string;
  durationDays: number | null;
  startDate: string;
  endDate: string | null;
  autoRenew: boolean;
  status: 'active' | 'paused' | 'expired';
  /** When set, the provider is treating this sub as paused. */
  paused?: boolean;
  pausedAt?: string;
  /** ISO when the pause is expected to lift; null = indefinite. */
  resumesAt?: string | null;
  couponCode?: string;
  meta?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

interface DummyState {
  variants: Record<string, DummyVariant>;
  products: Record<string, DummyProduct>;
  coupons: Record<string, DummyCoupon>;
  subscriptions: Record<string, DummyRecord>;
  nextId: number;
}

const STATE_PATH = dataPath('global', 'payment-providers', 'dummy', 'state.json');
const STATE_FILE = 'payment-providers/dummy/state.json';
/** The document the facade names state.json by in a ledger's refusals. */
const STATE_DOC = 'global:payment-providers/dummy/state.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const LOAD_RETRY_MS = 5_000;
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 60_000;

const liveProviders = new Set<DummyProvider>();

/** Drops every Dummy cache of this process (at a take of the writer lock, and after a local op that was not ok). */
export function invalidateDummyCaches(): void {
  for (const provider of liveProviders) provider.invalidate();
}

// What this process knew of state.json may be stale after another holder of the writer lock.
onWriterTake(invalidateDummyCaches);

/**
 * Seed state on first run so testing has something to click on out of the box.
 * Host can edit / add via the admin UI (stage 2 work).
 */
function buildSeedState(): DummyState {
  const nowIso = new Date().toISOString();
  const variants: Record<string, DummyVariant> = {
    dummy_monthly_999: { variantId: 'dummy_monthly_999', label: 'Monthly', amount: 999, currency: 'USD', durationDays: 30, recurring: true, active: true },
    dummy_yearly_9999: { variantId: 'dummy_yearly_9999', label: 'Yearly (save 16%)', amount: 9999, currency: 'USD', durationDays: 365, recurring: true, active: true },
    dummy_lifetime_19999: { variantId: 'dummy_lifetime_19999', label: 'Lifetime', amount: 19999, currency: 'USD', durationDays: null, recurring: false, active: true },
    dummy_weekly_249: { variantId: 'dummy_weekly_249', label: 'Weekly', amount: 249, currency: 'USD', durationDays: 7, recurring: true, active: true },
  };
  const products: Record<string, DummyProduct> = {
    dummy_product_standard: {
      productId: 'dummy_product_standard',
      label: 'Standard plan',
      description: 'Pick a billing cadence; all give the same access.',
      variantIds: ['dummy_weekly_249', 'dummy_monthly_999', 'dummy_yearly_9999', 'dummy_lifetime_19999'],
    },
  };
  const coupons: Record<string, DummyCoupon> = {
    TEST20: { code: 'TEST20', description: '20% off (built-in test coupon)', percentOff: 20, usedCount: 0, createdAt: nowIso },
    FREEWEEK: { code: 'FREEWEEK', description: '+7 free days (built-in test coupon)', extraDays: 7, usedCount: 0, createdAt: nowIso },
    EXPIRED: { code: 'EXPIRED', description: 'Always-expired test coupon', percentOff: 50, usedCount: 0, createdAt: nowIso, expiresAt: '2000-01-01T00:00:00.000Z' },
  };
  return { variants, products, coupons, subscriptions: {}, nextId: 1 };
}

// ============================================================================
// CAPABILITIES
// ============================================================================

const CAPABILITIES: ProviderCapabilities = {
  canInitiatePurchase: true,
  supportsCancel: true,
  supportsReactivate: true,
  supportsCoupons: true,
  supportsPause: true,
  supportsMultipleVariants: true,
  supportsProductMode: true,
  supportsHostedPicker: false, // Dummy renders no hosted page
  supportsCustomerPortal: false,
  supportsAnnualBilling: true,
  supportsPriceMigration: true,
  mechanism: 'immediate',
  variantIdLabel: 'Dummy Variant ID',
  productIdLabel: 'Dummy Product ID',
};

// ============================================================================
// PROVIDER
// ============================================================================

export class DummyProvider implements PaymentProvider {
  readonly id = 'dummy';
  readonly displayName = 'Dummy (Development)';
  readonly capabilities = CAPABILITIES;

  private state: DummyState = buildSeedState();
  /** The cache holds a loaded state; lastRaw is the text it was loaded from or last saved as (undefined: not known). */
  private loaded = false;
  private lastRaw: string | null | undefined = undefined;
  private unreadable: string | null = null;
  private loggedCause: string | null = null;
  private loggedRecheck: string | null = null;
  private lastLoadTry = -Infinity;
  private tickTimer: NodeJS.Timeout | null = null;
  /** Set by the final stop step or a deposition: from then on nothing is written. */
  private stopped: StopKind | null = null;
  private saveHeld = false;
  private unstorableSave = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay = RETRY_FIRST_MS;
  private disposed = false;

  constructor() {
    liveProviders.add(this);
    if (isBotProcess()) registerCacheStop(this);
  }

  isConfigured(): boolean {
    return true; // Dummy is always usable
  }

  // ============================================================================
  // STATE I/O
  // ============================================================================

  /** Reads state.json and records nothing in the caller's ledger: absent gives the seed in memory, written by the first save. */
  private load(): void {
    this.lastLoadTry = Date.now();
    let raw: string | null;
    let loaded: Partial<DummyState> | null = null;
    try {
      raw = readRawStrict(STATE_PATH);
      if (raw !== null) {
        try {
          loaded = JSON.parse(raw) as Partial<DummyState>;
          if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error('not a JSON object');
        } catch (error) {
          throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      this.becomeUnreadable(errnoOf(error));
      return;
    }
    this.state = loaded
      ? {
          variants: loaded.variants && typeof loaded.variants === 'object' ? loaded.variants : buildSeedState().variants,
          products: loaded.products && typeof loaded.products === 'object' ? loaded.products : buildSeedState().products,
          coupons: loaded.coupons && typeof loaded.coupons === 'object' ? loaded.coupons : buildSeedState().coupons,
          subscriptions: loaded.subscriptions || {},
          nextId: loaded.nextId || 1,
        }
      : buildSeedState();
    this.lastRaw = raw;
    this.loaded = true;
    if (this.unreadable) console.log(`[DummyProvider] ${STATE_FILE} can be read again`);
    this.unreadable = null;
    this.loggedCause = null;
  }

  private becomeUnreadable(cause: string): void {
    this.unreadable = cause;
    this.loaded = false;
    this.lastRaw = undefined;
    this.state = buildSeedState();
    if (this.loggedCause === cause) return;
    this.loggedCause = cause;
    console.error(`[DummyProvider] ${STATE_FILE} cannot be read (${cause}); the Dummy provider answers from its seed and its changes are refused until it can be read`);
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      if (isBotProcess() || this.lastRaw === undefined || writerLockDepth() > 0) return;
      let raw: string | null;
      try {
        raw = readRawStrict(STATE_PATH);
      } catch (error) {
        const cause = errnoOf(error);
        if (this.loggedRecheck !== cause) {
          this.loggedRecheck = cause;
          console.error(`[DummyProvider] ${STATE_FILE} could not be read to check for changes (${cause}); kept the loaded copy`);
        }
        return;
      }
      this.loggedRecheck = null;
      if (raw === this.lastRaw) return;
    } else if (this.unreadable !== null && Date.now() - this.lastLoadTry < LOAD_RETRY_MS) {
      return;
    }
    this.load();
  }

  /** Drops the cache (the web UI, at each take of the writer lock and after a local op that was not ok). */
  invalidate(): void {
    this.loaded = false;
    this.lastRaw = undefined;
    this.lastLoadTry = -Infinity;
  }

  /** The refusal text of a dummy.* op while state.json cannot be read; null when it can. */
  cannotReadText(): string | null {
    this.ensureLoaded();
    return this.unreadable === null ? null : `${STATE_FILE} cannot be read (${this.unreadable}); nothing was saved. Fix or restore the file, then try again.`;
  }

  /** A mutating method's entry check: true when it must refuse, recorded in the current ledger, before it changes the state. */
  private refusedAtEntry(): boolean {
    this.ensureLoaded();
    const cause: LedgerCause | null = this.stopped ? stopCause(this.stopped) : this.unreadable !== null ? 'io' : null;
    if (!cause) return false;
    recordRefusal(cause, STATE_DOC);
    return true;
  }

  /** A provider call the PremiumManager makes: it fails, with nothing changed, while the state cannot be written. */
  private refuseCall(): void {
    if (!this.refusedAtEntry()) return;
    throw new Error(this.stopped
      ? `The Dummy provider changed nothing: ${stopWords(this.stopped)}.`
      : `The Dummy provider changed nothing: ${STATE_FILE} cannot be read (${this.unreadable}).`);
  }

  /**
   * Saves the whole state. In the bot a save the disk refuses stays in the cache and is retried (it answers held); a
   * refusal of the stop or a deposition, and every save while the state cannot be read, is not.
   */
  private save(): boolean {
    if (this.stopped) {
      recordRefusal(stopCause(this.stopped), STATE_DOC);
      return false;
    }
    if (this.unreadable !== null) {
      recordRefusal('io', STATE_DOC);
      return false;
    }
    return this.writeState();
  }

  private writeState(): boolean {
    const content = JSON.stringify(this.state, null, 2);
    let cause: LedgerCause;
    try {
      const tracked = saveDataTracked('state.json', { scope: 'global', category: 'payment-providers/dummy' }, this.state);
      if (tracked.outcome === 'saved') {
        this.lastRaw = content;
        this.saveHeld = false;
        this.unstorableSave = false;
        return true;
      }
      cause = tracked.outcome === 'frozen' ? 'frozen' : tracked.cause;
    } catch (error) {
      if (error instanceof DataBackendUnavailableError) {
        cause = error.causeKey;
      } else {
        console.error('[DummyProvider] Failed to save state:', error);
        recordRefusal('io', STATE_DOC);
        cause = 'io';
      }
    }
    if (cause === 'unstorable') {
      this.saveHeld = false;
      this.unstorableSave = true;
      return false;
    }
    if (cause === 'node-stopping' || cause === 'writer-lost' || !isBotProcess()) return false;
    this.saveHeld = true;
    markRetried(STATE_DOC);
    this.armRetry();
    return true;
  }

  private armRetry(): void {
    if (this.retryTimer || this.stopped || this.disposed) return;
    this.retryTimer = outsideLedgers(() => setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped || !this.saveHeld) return;
      outsideLedgers(() => this.writeState());
      if (this.saveHeld) {
        this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
        this.armRetry();
      } else {
        this.retryDelay = RETRY_FIRST_MS;
      }
    }, this.retryDelay));
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** A deposition: nothing more is written. */
  markStopped(kind: StopKind): void {
    if (this.stopped) return;
    this.stopped = kind;
    this.clearRetry();
  }

  /** The final stop step: stops the retry and the tick, makes one last save of a held change, sets stopped and logs what is held. */
  finalStop(): void {
    if (this.disposed) return;
    this.clearRetry();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (!this.stopped) {
      if (this.saveHeld) outsideLedgers(() => this.writeState());
      this.clearRetry();
      this.stopped = 'stopping';
    }
    const lost = this.stopped === 'deposed' ? 'lost: another process took the data files' : 'lost with this stop';
    if (this.saveHeld) {
      console.error(`[DummyProvider] ${STATE_FILE} holds changes the disk refused; they are ${lost}`);
    } else if (this.unstorableSave) {
      console.error(`[DummyProvider] ${STATE_FILE} holds changes too large to store (one write holds at most 4 MiB); they are ${lost}`);
    }
  }

  private toOfferingVariant(v: DummyVariant): OfferingVariant {
    return {
      variantId: v.variantId,
      label: v.label,
      amount: v.amount,
      currency: v.currency,
      durationDays: v.durationDays,
      ...(v.trialDays !== undefined ? { trialDays: v.trialDays } : {}),
      recurring: v.recurring,
      active: v.active,
    };
  }

  private stateFrom(r: DummyRecord): ProviderSubscriptionState {
    return {
      status: r.paused ? 'paused' : r.status,
      startDate: r.startDate,
      endDate: r.endDate,
      autoRenew: r.autoRenew,
      meta: r.meta,
    };
  }

  // ============================================================================
  // VARIANT / PRODUCT QUERIES (used by the boundary)
  // ============================================================================

  async listVariants(productId: string): Promise<OfferingVariant[]> {
    this.ensureLoaded();
    const product = this.state.products[productId];
    if (!product) return [];
    const out: OfferingVariant[] = [];
    for (const variantId of product.variantIds) {
      const v = this.state.variants[variantId];
      if (v) out.push(this.toOfferingVariant(v));
    }
    return out;
  }

  async fetchVariant(variantId: string): Promise<OfferingVariant | null> {
    this.ensureLoaded();
    const v = this.state.variants[variantId];
    return v ? this.toOfferingVariant(v) : null;
  }

  async validateCoupon(code: string, _variantId?: string): Promise<ProviderCouponValidation> {
    this.ensureLoaded();
    const trimmed = (code || '').trim();
    if (!trimmed) return { valid: false, reason: 'empty code' };
    const coupon = this.state.coupons[trimmed];
    if (!coupon) return { valid: false, reason: 'not found' };
    if (coupon.expiresAt && Date.parse(coupon.expiresAt) < Date.now()) {
      return { valid: false, reason: 'expired' };
    }
    if (typeof coupon.maxUses === 'number' && coupon.usedCount >= coupon.maxUses) {
      return { valid: false, reason: 'usage limit reached' };
    }
    const effectText = typeof coupon.percentOff === 'number'
      ? `${coupon.percentOff}% off`
      : typeof coupon.extraDays === 'number'
        ? `+${coupon.extraDays} days`
        : '';
    return {
      valid: true,
      effectText,
      providerCouponId: coupon.code,
    };
  }

  // ============================================================================
  // PURCHASE FLOW
  // ============================================================================

  async initiatePurchase(opts: InitiateOpts): Promise<InitiateResult> {
    this.refuseCall();
    const variant = this.state.variants[opts.variantId];
    if (!variant || !variant.active) {
      throw new Error(`Dummy variant '${opts.variantId}' does not exist or is inactive.`);
    }
    const nowIso = new Date().toISOString();

    // Apply coupon mechanically. percentOff is cosmetic for Dummy; extraDays
    // extends the subscription. `consume` runs only for valid coupons.
    let extraDays = 0;
    if (opts.couponCode) {
      const v = await this.validateCoupon(opts.couponCode, opts.variantId);
      if (!v.valid) throw new Error(`Coupon invalid: ${v.reason || 'not accepted'}`);
      const coupon = this.state.coupons[opts.couponCode.trim()];
      if (coupon?.extraDays) extraDays = coupon.extraDays;
      if (coupon) coupon.usedCount = (coupon.usedCount || 0) + 1;
    }

    const totalDays = variant.durationDays === null ? null : variant.durationDays + extraDays;
    const endDate = totalDays === null
      ? null
      : new Date(Date.now() + totalDays * DAY_MS).toISOString();

    // Auto-renew: lifetime never renews. Otherwise honor caller intent.
    const autoRenew = endDate === null
      ? false
      : (typeof opts.autoRenew === 'boolean' ? opts.autoRenew : true);

    // Caller may request the new sub starts paused (stacking onto a higher-
    // priority sub). The provider freezes ticking; PremiumManager treats it
    // as paused and queues it.
    const startsPaused = opts.startPausedUntil !== undefined;

    const providerSubId = `dummy_${this.state.nextId++}`;
    const record: DummyRecord = {
      providerSubId,
      guildId: opts.guildId,
      tierId: opts.tierId,
      offeringId: opts.offeringId,
      variantId: opts.variantId,
      durationDays: totalDays,
      startDate: nowIso,
      endDate,
      autoRenew,
      status: startsPaused ? 'paused' : 'active',
      paused: startsPaused ? true : undefined,
      pausedAt: startsPaused ? nowIso : undefined,
      resumesAt: startsPaused ? (opts.startPausedUntil ?? null) : undefined,
      couponCode: opts.couponCode,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.state.subscriptions[providerSubId] = record;
    this.save();

    return {
      providerSubId,
      state: this.stateFrom(record),
      variantSnapshot: this.toOfferingVariant(variant),
    };
  }

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  async cancelSubscription(providerSubId: string, immediately?: boolean): Promise<void> {
    this.refuseCall();
    const r = this.state.subscriptions[providerSubId];
    if (!r) return;
    const registry = getPaymentRegistry();
    if (immediately) {
      r.status = 'expired';
      r.autoRenew = false;
      r.paused = false;
      r.updatedAt = new Date().toISOString();
      this.save();
      registry.emitEvent({
        type: 'subscription.expired',
        providerId: this.id,
        providerSubId,
        guildId: r.guildId,
        state: this.stateFrom(r),
      });
      return;
    }
    r.autoRenew = false;
    r.updatedAt = new Date().toISOString();
    this.save();
    registry.emitEvent({
      type: 'subscription.cancelled',
      providerId: this.id,
      providerSubId,
      guildId: r.guildId,
      state: this.stateFrom(r),
    });
  }

  async reactivateSubscription(providerSubId: string): Promise<void> {
    this.refuseCall();
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

  async pauseSubscription(providerSubId: string, resumesAt: string | null): Promise<void> {
    this.refuseCall();
    const r = this.state.subscriptions[providerSubId];
    if (!r) return;
    if (r.status !== 'active' || r.paused) return;
    r.paused = true;
    r.pausedAt = new Date().toISOString();
    r.resumesAt = resumesAt;
    r.status = 'paused';
    r.updatedAt = r.pausedAt;
    this.save();
    getPaymentRegistry().emitEvent({
      type: 'subscription.paused',
      providerId: this.id,
      providerSubId,
      guildId: r.guildId,
      resumesAt,
    });
  }

  async resumeSubscription(providerSubId: string, newEndDate: string | null): Promise<void> {
    this.refuseCall();
    const r = this.state.subscriptions[providerSubId];
    if (!r) return;
    if (!r.paused) return;
    const nowIso = new Date().toISOString();
    r.paused = false;
    r.pausedAt = undefined;
    r.resumesAt = undefined;
    r.startDate = nowIso;
    r.endDate = newEndDate;
    r.status = 'active';
    r.updatedAt = nowIso;
    this.save();
    getPaymentRegistry().emitEvent({
      type: 'subscription.resumed',
      providerId: this.id,
      providerSubId,
      guildId: r.guildId,
      state: this.stateFrom(r),
    });
  }

  async migrateSubscriptionPrice(
    providerSubId: string,
    newVariantId: string,
    _prorationBehavior: 'none' | 'create_prorations',
  ): Promise<void> {
    this.refuseCall();
    const r = this.state.subscriptions[providerSubId];
    if (!r) throw new Error(`Dummy subscription '${providerSubId}' not found.`);
    const variant = this.state.variants[newVariantId];
    if (!variant || !variant.active) {
      throw new Error(`Dummy variant '${newVariantId}' does not exist or is inactive.`);
    }
    r.variantId = newVariantId;
    r.durationDays = variant.durationDays;
    // Reset endDate based on new duration (start of "next cycle" semantics).
    r.endDate = variant.durationDays === null
      ? null
      : new Date(Date.now() + variant.durationDays * DAY_MS).toISOString();
    r.startDate = new Date().toISOString();
    r.updatedAt = r.startDate;
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

  async listSubscriptionsForGuild(guildId: string): Promise<ProviderSubscriptionRef[]> {
    this.ensureLoaded();
    const liveStatuses = new Set(['active', 'paused']);
    const out: ProviderSubscriptionRef[] = [];
    for (const r of Object.values(this.state.subscriptions)) {
      if (r.guildId !== guildId) continue;
      if (!liveStatuses.has(r.status)) continue;
      const variant = this.state.variants[r.variantId];
      const amountLabel = variant ? `${(variant.amount / 100).toFixed(2)} ${variant.currency}` : '';
      const periodLabel = variant?.durationDays == null
        ? 'one-time'
        : `every ${variant.durationDays} days`;
      out.push({
        providerSubId: r.providerSubId,
        state: this.stateFrom(r),
        metadata: {
          guildId: r.guildId,
          tierId: r.tierId,
          offeringId: r.offeringId,
          variantId: r.variantId,
          couponCode: r.couponCode,
        },
        display: {
          amountLabel,
          periodLabel,
          statusLabel: r.paused ? 'paused' : r.status,
        },
      });
    }
    return out;
  }

  // ============================================================================
  // TICK
  // ============================================================================

  /** Arms the tick before any load: each tick loads first, so a state that cannot be read now still ticks once it can. */
  start(): void {
    if (this.tickTimer || this.stopped) return;
    this.tickTimer = setInterval(() => {
      if (!isMaintenanceGateClosed()) this.tick();
    }, 60_000);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** The registry replaced or dropped this provider: it takes no more writer-lock takes, stop steps or retries. */
  dispose(): void {
    this.disposed = true;
    this.stop();
    this.clearRetry();
    liveProviders.delete(this);
    unregisterCacheStop(this);
  }

  /**
   * Periodic simulation: walk every active subscription whose endDate has
   * passed and either roll it forward (autoRenew=true) or expire it. Paused
   * subs don't tick.
   */
  private tick(): void {
    this.ensureLoaded();
    if (this.unreadable !== null) {
      console.warn(`[DummyProvider] Skipped the tick: ${STATE_FILE} cannot be read (${this.unreadable})`);
      return;
    }
    if (this.stopped || isPremiumReplaying()) return;
    const now = Date.now();
    const nowIso = new Date().toISOString();
    let changed = false;
    const registry = getPaymentRegistry();

    for (const r of Object.values(this.state.subscriptions)) {
      if (r.status !== 'active') continue;
      if (r.paused) continue;
      if (r.endDate === null) continue;
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

  // ============================================================================
  // ADMIN BACKDOORS (used by the Dummy admin UI in Stage 2)
  // ============================================================================

  /** All variants the host has registered. */
  adminListVariants(): OfferingVariant[] {
    this.ensureLoaded();
    return Object.values(this.state.variants).map(v => this.toOfferingVariant(v));
  }

  /** Create or replace a variant. */
  adminSetVariant(variant: DummyVariant): void {
    if (this.refusedAtEntry()) return;
    this.state.variants[variant.variantId] = variant;
    this.save();
  }

  adminDeleteVariant(variantId: string): boolean {
    if (this.refusedAtEntry()) return false;
    if (!this.state.variants[variantId]) return false;
    delete this.state.variants[variantId];
    // Also strip from any product membership.
    for (const product of Object.values(this.state.products)) {
      product.variantIds = product.variantIds.filter(id => id !== variantId);
    }
    this.save();
    return true;
  }

  adminListProducts(): DummyProduct[] {
    this.ensureLoaded();
    return Object.values(this.state.products);
  }

  adminSetProduct(product: DummyProduct): void {
    if (this.refusedAtEntry()) return;
    this.state.products[product.productId] = product;
    this.save();
  }

  adminDeleteProduct(productId: string): boolean {
    if (this.refusedAtEntry()) return false;
    if (!this.state.products[productId]) return false;
    delete this.state.products[productId];
    this.save();
    return true;
  }

  adminListCoupons(): DummyCoupon[] {
    this.ensureLoaded();
    return Object.values(this.state.coupons);
  }

  adminSetCoupon(coupon: DummyCoupon): boolean {
    if (this.refusedAtEntry()) return false;
    if (!coupon.code || coupon.code.trim() === '') return false;
    const hasPercent = typeof coupon.percentOff === 'number' && coupon.percentOff > 0;
    const hasDays = typeof coupon.extraDays === 'number' && coupon.extraDays > 0;
    if (hasPercent === hasDays) return false; // XOR
    if (hasPercent && (coupon.percentOff! < 1 || coupon.percentOff! > 100)) return false;
    if (hasDays && coupon.extraDays! < 1) return false;
    if (coupon.maxUses !== undefined && (typeof coupon.maxUses !== 'number' || coupon.maxUses < 1)) return false;
    if (coupon.expiresAt !== undefined && isNaN(Date.parse(coupon.expiresAt))) return false;

    const existing = this.state.coupons[coupon.code];
    this.state.coupons[coupon.code] = {
      ...coupon,
      usedCount: existing?.usedCount ?? 0,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.save();
    return true;
  }

  adminDeleteCoupon(code: string): boolean {
    if (this.refusedAtEntry()) return false;
    if (!this.state.coupons[code]) return false;
    delete this.state.coupons[code];
    this.save();
    return true;
  }
}
