/**
 * Premium Manager
 *
 * Manages guild premium tiers, subscriptions (manual + paid), and setting overrides.
 *
 * Two independent subscription layers per guild:
 *   - manual: granted by HOST via Main Web-UI
 *   - paid:   acquired via Guild Web-UI through a payment provider
 *              (cached mirror; the provider is the source of truth)
 *
 * Resolver picks the higher-priority non-expired active subscription;
 * falls back to Free when neither is active.
 *
 * Config file: /data/global/premium-tiers.json
 */

import fs from 'fs';
import path from 'path';
import { ensureDir } from './pathHelpers';
import type { HardLimitOverride } from '../../types/settingsTypes';
import { getPaymentRegistry } from './payment/paymentRegistry';
import type { ProviderEvent, InitiateResult } from './payment/paymentTypes';

// ============================================================================
// TYPES
// ============================================================================

/** Per-provider routing on an offering. The host activates provider IDs system-wide; each offering then toggles which of those are actually usable to buy it. */
export interface TierProviderLink {
  /** Whether this offering is purchasable via this provider right now */
  enabled: boolean;
  /** Opaque provider-specific config (e.g. Stripe Price id, Patreon tier id, server-boost count) */
  config?: Record<string, any>;
}

/** A buyable / acquirable option on a tier. Provider-agnostic. One offering can be routed through many providers (multi-select). */
export interface TierOffering {
  /** Unique id within the tier */
  id: string;
  /** Display label e.g. "Monthly", "6 Months", "Lifetime" */
  label: string;
  /** Optional marketing copy shown on the subscribe card */
  description?: string;
  /** Duration in days; null = open-ended (Lifetime / "as long as active") */
  durationDays: number | null;
  /** Whether this offering supports auto-renewal at endDate */
  autoRenewEligible: boolean;
  /** Price amount in minor units (cents). Omitted for non-monetary mechanisms. */
  amount?: number;
  /** ISO 4217 currency. Omitted with amount. */
  currency?: string;
  /** Map of providerId → per-provider link (enabled flag + opaque config). */
  providerLinks: Record<string, TierProviderLink>;
  /** Optional display icon */
  icon?: string;
}

/** Host-activated payment provider. Providers not present in `PremiumConfig.activatedProviders` are unavailable system-wide. */
export interface ActivatedProvider {
  /** When true, newly created offerings toggle this provider on by default */
  defaultEnabled: boolean;
}

/** Individual tier definition */
export interface PremiumTier {
  /** Human-readable tier name */
  displayName: string;
  /** Priority for tier ordering (higher = more premium) */
  priority: number;
  /** Module-specific setting overrides: overrides[moduleName][settingKey] = value */
  overrides: Record<string, Record<string, any>>;
  /** Offerings that acquire this tier. Free tier must be empty. */
  offerings: TierOffering[];
}

export type SubscriptionSource = 'manual' | 'paid';
export type SubscriptionStatus = 'active' | 'expired';

/** A subscription instance tying a guild to a tier */
export interface Subscription {
  tierId: string;
  source: SubscriptionSource;
  /** Which TierOffering was acquired (paid only) */
  offeringId?: string;
  /** Provider id (paid only) */
  providerId?: string;
  /** Provider's id for this subscription record (paid only) */
  providerSubId?: string;
  /** ISO start */
  startDate: string;
  /** ISO end, or null = open-ended (Lifetime) */
  endDate: string | null;
  /** Whether this subscription will auto-renew at endDate. Manual subs: always false. */
  autoRenew: boolean;
  status: SubscriptionStatus;
  /** UI slot; enforcement deferred until a provider with coupon support lands */
  couponCode?: string;
  /** Human-readable coupon effect description (deferred) */
  couponEffect?: string;
  /** Admin notes (manual only) */
  notes?: string;
  /** Opaque provider metadata */
  providerMeta?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  /**
   * When set, this subscription is PAUSED: the guild isn't consuming its time
   * because a higher-priority paid subscription took the active slot. The
   * remaining days are frozen in `remainingDaysAtPause`; they're unpacked
   * into a fresh endDate when the higher-priority sub ends and this one
   * resumes. Lifetime subs carry `remainingDaysAtPause: null` to denote
   * "unlimited remaining".
   */
  pausedAt?: string;
  remainingDaysAtPause?: number | null;
}

/** Per-guild dual subscription record */
export interface GuildSubscriptions {
  manual?: Subscription;
  /** Currently-active paid subscription. At most one. */
  paid?: Subscription;
  /**
   * Paid subscriptions paused by a higher-priority paid purchase. Ordered
   * by tier priority descending so the highest-priority paused one resumes
   * first when the active slot frees up.
   */
  pausedPaid?: Subscription[];
}

/** Editable restriction messages shown when tier-gating blocks something */
export interface PremiumMessages {
  moduleBlocked: string;
  commandBlocked: string;
  panelBlocked: string;
}

/**
 * A coupon code an admin can define to grant a discount or bonus on a paid
 * subscription. Only one effect kind per coupon; providers apply it according
 * to their own mechanics (e.g. percentOff reduces the charged amount, extraDays
 * appends free time to the subscription period).
 */
export interface Coupon {
  /** Opaque admin-facing label; not shown to end users unless the admin decides. */
  description?: string;
  /** Percent off the charged amount (0..100). Mutually exclusive with `extraDays`. */
  percentOff?: number;
  /** Extra subscription days appended to the initial period. Mutually exclusive with `percentOff`. */
  extraDays?: number;
  /** Maximum times this coupon can be redeemed across all guilds. Unlimited when absent. */
  maxUses?: number;
  /** How many times this coupon has been consumed so far. */
  usedCount: number;
  /** When the coupon was created. */
  createdAt: string;
  /** Optional expiry (ISO). Coupons past this date never validate. */
  expiresAt?: string;
  /**
   * If set (non-empty), the coupon only applies when subscribing to one of
   * these tier IDs. Omit / empty = global (applies to any tier). Free tier
   * IDs are rejected at save time since you can't subscribe to Free.
   */
  allowedTiers?: string[];
}

/** Outcome of validating a coupon at subscribe time. */
export interface CouponValidation {
  valid: boolean;
  /** Human-readable reason when invalid ("expired", "used up", "not found"). */
  reason?: string;
  /** The coupon record on success. */
  coupon?: Coupon;
  /** Short description the UI can surface (e.g. "20% off" or "+7 days"). */
  effectText?: string;
  /** Normalized effect the provider can apply mechanically. */
  effect?: { percentOff?: number; extraDays?: number };
}

/** Premium tiers configuration */
export interface PremiumConfig {
  tiers: Record<string, PremiumTier>;
  /** Dual-layer subscriptions keyed by guildId */
  subscriptions: Record<string, GuildSubscriptions>;
  /** Editable restriction messages */
  messages: PremiumMessages;
  /**
   * Anti-duplicate registry for providers that link an external account (e.g. Patreon).
   * providerAccountLinks[providerId][externalAccountId] = guildId
   * Ensures a single external account cannot entitle multiple guilds simultaneously.
   */
  providerAccountLinks: Record<string, Record<string, string>>;
  /**
   * Host-activated payment providers. A provider MUST appear here with an entry
   * to be usable for subscriptions. Default empty; host must explicitly activate.
   */
  activatedProviders: Record<string, ActivatedProvider>;
  /**
   * Admin-managed coupon registry keyed by coupon code (case-sensitive). Only
   * providers with `capabilities.supportsCoupons` actually apply the effect;
   * others ignore the coupon field at subscribe time.
   */
  coupons: Record<string, Coupon>;
}

// ============================================================================
// DEFAULTS
// ============================================================================

/** Default restriction messages */
export const DEFAULT_MESSAGES: PremiumMessages = {
  moduleBlocked: ':no_entry_sign: This module is not available for your server\'s current tier.',
  commandBlocked: ':no_entry_sign: This command is not available for your server\'s current tier.',
  panelBlocked: ':no_entry_sign: This module is not available for your server\'s current tier.',
};

/** Default configuration with free tier */
const DEFAULT_CONFIG: PremiumConfig = {
  tiers: {
    free: {
      displayName: 'Free',
      priority: 0,
      overrides: {},
      offerings: [],
    }
  },
  subscriptions: {},
  messages: { ...DEFAULT_MESSAGES },
  providerAccountLinks: {},
  activatedProviders: {},
  coupons: {},
};

/**
 * Normalize an offering that may have come from an older shape
 * (single `providerId` string + `providerConfig`) into the new multi-provider
 * `providerLinks` map. This is permissive read-time parsing, not a migration.
 */
function normalizeOffering(raw: any): TierOffering {
  const providerLinks: Record<string, TierProviderLink> =
    (raw.providerLinks && typeof raw.providerLinks === 'object')
      ? { ...raw.providerLinks }
      : {};
  // Legacy: single providerId + providerConfig -> one enabled link
  if (!Object.keys(providerLinks).length && typeof raw.providerId === 'string') {
    providerLinks[raw.providerId] = {
      enabled: true,
      config: raw.providerConfig || undefined,
    };
  }
  return {
    id: raw.id,
    label: raw.label,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    durationDays: raw.durationDays ?? null,
    autoRenewEligible: !!raw.autoRenewEligible,
    amount: typeof raw.amount === 'number' ? raw.amount : undefined,
    currency: typeof raw.currency === 'string' ? raw.currency : undefined,
    providerLinks,
    icon: raw.icon,
  };
}

/**
 * Structural value equality. Used for comparing override values (primitives,
 * arrays like `_disabledCommands`, or nested objects like `_hardLimits`).
 * Array order is ignored: a tier's disabled-commands list that matches Free's
 * is considered equal regardless of insertion order.
 */
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const norm = (arr: any[]) => arr.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).sort();
    const na = norm(a);
    const nb = norm(b);
    return na.every((v, i) => v === nb[i]);
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Free's "effective" module-override as seen by non-Free tiers. When Free
 * disables a module entirely (_moduleEnabled === false), the only meaningful
 * baseline it contributes is "module off"; its per-command / per-setting
 * values are moot on a disabled module and must not ghost-lock non-Free
 * tiers. So we collapse Free's contribution down to `{ _moduleEnabled: false }`
 * in that case.
 */
function effectiveFreeModuleOverride(
  freeMod: Record<string, any> | undefined
): Record<string, any> {
  if (!freeMod) return {};
  if (freeMod._moduleEnabled === false) return { _moduleEnabled: false };
  return freeMod;
}

/**
 * True when every key a tier's module-override sets matches Free's effective
 * value for that key. Such a module entry contributes no delta: dropping it
 * leaves the effective merge identical, since keys Free has but tier doesn't
 * are already inherited.
 */
function moduleOverrideRedundantVsFree(
  tierMod: Record<string, any>,
  freeMod: Record<string, any>
): boolean {
  const effectiveFree = effectiveFreeModuleOverride(freeMod);
  const keys = Object.keys(tierMod || {});
  if (keys.length === 0) return true;
  for (const key of keys) {
    if (!deepEqual(tierMod[key], effectiveFree[key])) return false;
  }
  return true;
}

const CONFIG_PATH = '/data/global/premium-tiers.json';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Singleton instance */
let instance: PremiumManager | null = null;

// ============================================================================
// MANAGER
// ============================================================================

export class PremiumManager {
  private config: PremiumConfig;
  private configLoaded: boolean = false;
  // Track mtime so readers in one process pick up writes made by another
  // process (bot vs. forked web-UI share this file).
  private configMtimeMs: number = 0;
  private expiryTimer: NodeJS.Timeout | null = null;

  /** Listener for paid-provider events; mirrors state into the cache. */
  private paidEventHandler = (event: ProviderEvent): void => {
    this.ensureLoaded();
    const subs = this.config.subscriptions[event.guildId];
    if (!subs?.paid) return;
    if (subs.paid.providerSubId !== event.providerSubId) return;

    const paid = subs.paid;
    const s = event.state;
    paid.startDate = s.startDate;
    paid.endDate = s.endDate;
    paid.autoRenew = s.autoRenew;
    // Provider 'cancelled' means autoRenew off but still active until
    // endDate. Only 'expired' ends the subscription in our cache.
    if (s.status === 'expired') paid.status = 'expired';
    else paid.status = 'active';
    paid.providerMeta = s.meta;
    paid.updatedAt = new Date().toISOString();

    // On expiry, free the active paid slot so any paused stack entry can
    // resume into it. We keep the expired record out of the slot rather
    // than leaving it there blocking resumption; the provider still holds
    // the historical record for auditing.
    if (paid.status === 'expired') {
      delete subs.paid;
      this.resumeHighestPausedPaid(event.guildId);
    }

    this.save();
  };

  constructor() {
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    // Listen for paid-provider events and mirror them into the cache.
    getPaymentRegistry().on('provider.event', this.paidEventHandler);
  }

  /** Release the registry listener and scheduled tasks. */
  dispose(): void {
    this.stopExpiryChecker();
    getPaymentRegistry().off('provider.event', this.paidEventHandler);
  }

  /** Load configuration from disk */
  load(): void {
    try {
      ensureDir(path.dirname(CONFIG_PATH));

      if (fs.existsSync(CONFIG_PATH)) {
        const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const loaded = JSON.parse(content) as Partial<PremiumConfig>;

        // Default-merge each field. Missing fields fall back to defaults.
        const mergedTiers: Record<string, PremiumTier> = {};
        for (const [id, t] of Object.entries(loaded.tiers || {})) {
          const tier = t as any;
          mergedTiers[id] = {
            displayName: tier.displayName,
            priority: tier.priority,
            overrides: tier.overrides || {},
            offerings: (Array.isArray(tier.offerings) ? tier.offerings : []).map(normalizeOffering),
          };
        }
        // Force the free tier to exist with correct invariants.
        mergedTiers.free = {
          displayName: mergedTiers.free?.displayName || 'Free',
          priority: 0,
          overrides: mergedTiers.free?.overrides || {},
          offerings: [],
        };

        this.config = {
          tiers: mergedTiers,
          subscriptions: loaded.subscriptions || {},
          messages: { ...DEFAULT_MESSAGES, ...(loaded.messages || {}) },
          providerAccountLinks: loaded.providerAccountLinks || {},
          activatedProviders: loaded.activatedProviders || {},
          coupons: loaded.coupons || {},
        };
        try { this.configMtimeMs = fs.statSync(CONFIG_PATH).mtimeMs; } catch { /* ignore */ }
      } else {
        this.save();
      }

      this.configLoaded = true;
    } catch (error) {
      console.error('[PremiumManager] Failed to load config:', error);
      this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  }

  /** Save configuration to disk */
  save(): boolean {
    try {
      ensureDir(path.dirname(CONFIG_PATH));
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2));
      try { this.configMtimeMs = fs.statSync(CONFIG_PATH).mtimeMs; } catch { /* ignore */ }
      return true;
    } catch (error) {
      console.error('[PremiumManager] Failed to save config:', error);
      return false;
    }
  }

  /**
   * Ensure config is loaded and up-to-date with the on-disk copy.
   * Bot and web-UI run as separate processes; a write from one must be
   * visible to the other, so we re-read when the file's mtime advances.
   */
  private ensureLoaded(): void {
    if (!this.configLoaded) {
      this.load();
      return;
    }
    try {
      const mtime = fs.statSync(CONFIG_PATH).mtimeMs;
      if (mtime > this.configMtimeMs) this.load();
    } catch { /* file missing; next read will recreate via load() */ }
  }

  // ============================================================================
  // TIER MANAGEMENT
  // ============================================================================

  getAllTiers(): Record<string, PremiumTier> {
    this.ensureLoaded();
    return { ...this.config.tiers };
  }

  getTier(tierId: string): PremiumTier | null {
    this.ensureLoaded();
    return this.config.tiers[tierId] || null;
  }

  setTier(tierId: string, tier: PremiumTier): boolean {
    this.ensureLoaded();
    if (tierId === 'free') {
      // Free tier invariants: priority=0, no offerings.
      this.config.tiers.free = {
        displayName: tier.displayName || 'Free',
        priority: 0,
        overrides: tier.overrides || {},
        offerings: [],
      };
      // Free just changed: retroactively sanitize + prune every non-Free tier.
      // Sanitize strips any worse-than-Free violations that the new baseline
      // exposed (e.g. tier had a command disabled that Free now enables);
      // prune drops entries that are now redundant with Free.
      for (const [otherId, other] of Object.entries(this.config.tiers)) {
        if (otherId === 'free') continue;
        other.overrides = this.pruneOverridesAgainstFree(
          this.sanitizeTierAgainstFree(other.overrides)
        );
      }
    } else {
      this.config.tiers[tierId] = {
        displayName: tier.displayName,
        priority: tier.priority,
        // Sanitize first (never store worse-than-Free state) then strip module
        // entries that duplicate Free's baseline. The two together keep tier
        // storage honest: no ghost restrictions, no redundant matches.
        overrides: this.pruneOverridesAgainstFree(
          this.sanitizeTierAgainstFree(tier.overrides || {})
        ),
        offerings: (tier.offerings || []).map(normalizeOffering),
      };
    }
    return this.save();
  }

  /**
   * Strip any tier-override state that would make the tier WORSE than Free
   * (more restrictive than the baseline Free offers). This runs before
   * `pruneOverridesAgainstFree` so the two together leave the tier with:
   *   - no redundant overrides (match Free exactly => dropped)
   *   - no worse-than-Free violations (stale state after Free's state moved)
   *
   * Current rules (direction-aware keys only):
   *   - `_moduleEnabled: false` is stripped when Free enables the module.
   *   - `_disabledCommands` is filtered to the subset Free also disables,
   *     unless Free disables the whole module (then tier is free to disable
   *     anything it wants inside its enabled-by-override module).
   *
   * Setting values are left alone: their "worse" direction isn't declared in
   * the schema yet, so we don't have a reliable rule for them.
   */
  private sanitizeTierAgainstFree(
    tierOverrides: Record<string, Record<string, any>>
  ): Record<string, Record<string, any>> {
    const freeOverrides = this.config.tiers.free?.overrides || {};
    const result: Record<string, Record<string, any>> = {};
    for (const [moduleName, tierMod] of Object.entries(tierOverrides || {})) {
      const freeMod = freeOverrides[moduleName] || {};
      const sanitized: Record<string, any> = { ...tierMod };
      const freeModuleOff = freeMod._moduleEnabled === false;

      // Rule 1: tier can't disable a module Free enables.
      if (sanitized._moduleEnabled === false && !freeModuleOff) {
        delete sanitized._moduleEnabled;
      }

      // Rule 2: tier's disabled-command list must be a subset of Free's own.
      // Skip when Free's module is off (Free doesn't offer any commands there,
      // so tier's command-level state inside its own enabled override is free).
      if (!freeModuleOff && Array.isArray(sanitized._disabledCommands)) {
        const freeDisabled = Array.isArray(freeMod._disabledCommands) ? freeMod._disabledCommands : [];
        const allowedSet = new Set(freeDisabled);
        const filtered = sanitized._disabledCommands.filter((c: string) => allowedSet.has(c));
        if (filtered.length === 0) delete sanitized._disabledCommands;
        else sanitized._disabledCommands = filtered;
      }

      if (Object.keys(sanitized).length > 0) result[moduleName] = sanitized;
    }
    return result;
  }

  /**
   * Remove module-level override entries that duplicate what the Free tier
   * already implies. A module entry is "redundant" when every key it sets
   * equals Free's value for that key: dropping the entry lets the tier keep
   * inheriting Free's baseline with no observable difference.
   */
  private pruneOverridesAgainstFree(
    tierOverrides: Record<string, Record<string, any>>
  ): Record<string, Record<string, any>> {
    const freeOverrides = this.config.tiers.free?.overrides || {};
    const result: Record<string, Record<string, any>> = {};
    for (const [moduleName, tierMod] of Object.entries(tierOverrides || {})) {
      const freeMod = freeOverrides[moduleName] || {};
      if (moduleOverrideRedundantVsFree(tierMod, freeMod)) continue;
      result[moduleName] = tierMod;
    }
    return result;
  }

  // ============================================================================
  // ACTIVATED PROVIDERS: host-wide enable/disable of payment methods
  // ============================================================================

  /** Return the current activation map. Empty by default. */
  getActivatedProviders(): Record<string, ActivatedProvider> {
    this.ensureLoaded();
    return { ...this.config.activatedProviders };
  }

  /** True when the given provider id is activated system-wide. */
  isProviderActivated(providerId: string): boolean {
    this.ensureLoaded();
    return !!this.config.activatedProviders[providerId];
  }

  /**
   * Toggle a provider's activation.
   * `activated=false` removes the entry (and any `defaultEnabled` setting).
   * `activated=true` creates / updates the entry with the given `defaultEnabled`.
   */
  setProviderActivation(providerId: string, activated: boolean, defaultEnabled: boolean = false): boolean {
    this.ensureLoaded();
    if (!activated) {
      delete this.config.activatedProviders[providerId];
    } else {
      this.config.activatedProviders[providerId] = { defaultEnabled: !!defaultEnabled };
    }
    return this.save();
  }

  /** Delete a tier (cannot delete 'free'). Revokes any subscriptions on that tier. */
  deleteTier(tierId: string): boolean {
    this.ensureLoaded();

    if (tierId === 'free') {
      console.error('[PremiumManager] Cannot delete the free tier');
      return false;
    }

    if (!this.config.tiers[tierId]) return false;

    for (const guildId of Object.keys(this.config.subscriptions)) {
      const subs = this.config.subscriptions[guildId];
      if (subs.manual?.tierId === tierId) delete subs.manual;
      if (subs.paid?.tierId === tierId) delete subs.paid;
      if (!subs.manual && !subs.paid) delete this.config.subscriptions[guildId];
    }

    delete this.config.tiers[tierId];
    return this.save();
  }

  getTiersSortedByPriority(): Array<{ id: string; tier: PremiumTier }> {
    this.ensureLoaded();
    return Object.entries(this.config.tiers)
      .map(([id, tier]) => ({ id, tier }))
      .sort((a, b) => a.tier.priority - b.tier.priority);
  }

  // ============================================================================
  // RESOLVER
  // ============================================================================

  /**
   * Resolve the effective tier for a guild across both subscription layers.
   * Picks the highest-priority non-expired active subscription; ties go to manual.
   * Falls back to Free when no active subscription exists.
   */
  resolveActiveTier(guildId: string): { tierId: string; tier: PremiumTier; source: SubscriptionSource | null } {
    this.ensureLoaded();
    const subs = this.config.subscriptions[guildId];
    const now = Date.now();

    const candidates: Array<{ sub: Subscription; tier: PremiumTier; tierId: string }> = [];

    if (subs) {
      for (const source of ['manual', 'paid'] as SubscriptionSource[]) {
        const sub = subs[source];
        if (!sub) continue;
        if (sub.status !== 'active') continue;
        if (sub.endDate !== null && Date.parse(sub.endDate) <= now) continue;
        const tier = this.config.tiers[sub.tierId];
        if (!tier) continue;
        candidates.push({ sub, tier, tierId: sub.tierId });
      }
    }

    if (candidates.length === 0) {
      return { tierId: 'free', tier: this.config.tiers.free, source: null };
    }

    candidates.sort((a, b) => {
      if (b.tier.priority !== a.tier.priority) return b.tier.priority - a.tier.priority;
      if (a.sub.source === 'manual' && b.sub.source !== 'manual') return -1;
      if (b.sub.source === 'manual' && a.sub.source !== 'manual') return 1;
      return 0;
    });

    const winner = candidates[0];
    return { tierId: winner.tierId, tier: winner.tier, source: winner.sub.source };
  }

  // ============================================================================
  // MANUAL SUBSCRIPTIONS
  // ============================================================================

  /**
   * Grant (or replace) a manual subscription for a guild.
   * durationDays: null = open-ended (Lifetime manual grant).
   */
  grantManual(guildId: string, tierId: string, durationDays: number | null, notes?: string): boolean {
    this.ensureLoaded();
    if (tierId === 'free' || !this.config.tiers[tierId]) return false;

    const nowIso = new Date().toISOString();
    const endDate = durationDays === null
      ? null
      : new Date(Date.now() + durationDays * DAY_MS).toISOString();

    const sub: Subscription = {
      tierId,
      source: 'manual',
      startDate: nowIso,
      endDate,
      autoRenew: false,
      status: 'active',
      notes,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    if (!this.config.subscriptions[guildId]) this.config.subscriptions[guildId] = {};
    this.config.subscriptions[guildId].manual = sub;
    return this.save();
  }

  /** Add addDays to the manual subscription's endDate. No-op for Lifetime manual. */
  extendManual(guildId: string, addDays: number): boolean {
    this.ensureLoaded();
    const existing = this.config.subscriptions[guildId]?.manual;
    if (!existing) return false;
    if (existing.endDate === null) return true;

    const base = Math.max(Date.parse(existing.endDate), Date.now());
    existing.endDate = new Date(base + addDays * DAY_MS).toISOString();
    existing.updatedAt = new Date().toISOString();
    if (existing.status === 'expired' && Date.parse(existing.endDate) > Date.now()) {
      existing.status = 'active';
    }
    return this.save();
  }

  /** Revoke the manual subscription entirely. */
  revokeManual(guildId: string): boolean {
    this.ensureLoaded();
    const subs = this.config.subscriptions[guildId];
    if (!subs?.manual) return true;
    delete subs.manual;
    if (!subs.manual && !subs.paid) delete this.config.subscriptions[guildId];
    return this.save();
  }

  // ============================================================================
  // PAID SUBSCRIPTIONS: provider-owned cache
  //
  // The provider is the source of truth. PremiumManager caches the current
  // state; providers push updates via their event bus.
  // ============================================================================

  /** Write / overwrite the paid subscription cache for a guild. */
  setPaidSubscription(guildId: string, sub: Subscription): boolean {
    this.ensureLoaded();
    if (sub.source !== 'paid') return false;
    if (!this.config.subscriptions[guildId]) this.config.subscriptions[guildId] = {};
    this.config.subscriptions[guildId].paid = sub;
    return this.save();
  }

  /** Remove the paid subscription cache entry for a guild. */
  clearPaidSubscription(guildId: string): boolean {
    this.ensureLoaded();
    const subs = this.config.subscriptions[guildId];
    if (!subs?.paid) return true;
    delete subs.paid;
    if (!subs.manual && !subs.paid) delete this.config.subscriptions[guildId];
    return this.save();
  }

  /**
   * Initiate a paid subscription through the offering's provider.
   * Synchronous providers (Dummy) return `state` immediately and the cache
   * record is written here. Asynchronous providers (Stripe / Discord /
   * Patreon) return a redirect / handoff / oauthUrl; their cache record
   * lands later via the provider.event listener once the purchase completes.
   */
  async initiatePaidSubscription(
    guildId: string,
    tierId: string,
    offeringId: string,
    opts: { providerId: string; couponCode?: string; userId?: string }
  ): Promise<InitiateResult> {
    this.ensureLoaded();
    const tier = this.config.tiers[tierId];
    if (!tier) throw new Error(`Tier '${tierId}' does not exist`);
    if (tierId === 'free') throw new Error('Cannot subscribe to the free tier');

    const offering = tier.offerings.find(o => o.id === offeringId);
    if (!offering) throw new Error(`Offering '${offeringId}' not found on tier '${tierId}'`);

    const providerId = opts.providerId;
    if (!providerId) throw new Error('providerId is required');

    const link = offering.providerLinks[providerId];
    if (!link || !link.enabled) {
      throw new Error(`Offering '${offeringId}' is not available through provider '${providerId}'`);
    }
    if (!this.isProviderActivated(providerId)) {
      throw new Error(`Provider '${providerId}' is not activated system-wide`);
    }

    const registry = getPaymentRegistry();
    const provider = registry.get(providerId);
    if (!provider) throw new Error(`Provider '${providerId}' is not registered`);
    if (!provider.isConfigured()) throw new Error(`Provider '${providerId}' is not configured`);
    if (!provider.capabilities.canInitiatePurchase) {
      throw new Error(`Provider '${providerId}' cannot initiate purchase server-side`);
    }

    // Validate coupon BEFORE the provider call: we reject here so the provider
    // never sees a bad code, and we don't want to leak "provider supports
    // coupons" semantics to the caller. Only providers whose capabilities
    // advertise coupon support see the normalized effect passed in. The
    // target tier is passed so tier-restricted coupons validate correctly.
    let couponValidation: CouponValidation | undefined;
    if (opts.couponCode) {
      couponValidation = this.validateCoupon(opts.couponCode, tierId);
      if (!couponValidation.valid) {
        throw new Error(`Coupon invalid: ${couponValidation.reason || 'not accepted'}`);
      }
      if (!provider.capabilities.supportsCoupons) {
        throw new Error(`Provider '${providerId}' does not accept coupons`);
      }
    }

    // Stacking rules:
    //   - HIGHER priority than the active paid sub: new one takes the active
    //     slot, the existing paid pauses into the queue with its remaining
    //     days snapshotted.
    //   - LOWER priority than the active paid sub: new one installs directly
    //     into the paused queue (never active until every higher-priority sub
    //     above it ends). The offering's duration becomes its remaining-days-
    //     at-pause; lifetime stays lifetime.
    //   - SAME priority as any existing paid (active or paused): reject. You
    //     can't own two plans at the same tier level; at most one wins the
    //     active slot and the other is redundant.
    const guildSubs = this.config.subscriptions[guildId];
    const newPriority = tier.priority;
    const conflictingExisting = [
      guildSubs?.paid,
      ...(guildSubs?.pausedPaid || []),
    ].find((s): s is Subscription => {
      if (!s) return false;
      const exPriority = this.config.tiers[s.tierId]?.priority ?? 0;
      return exPriority === newPriority;
    });
    if (conflictingExisting) {
      const name = this.config.tiers[conflictingExisting.tierId]?.displayName || conflictingExisting.tierId;
      throw new Error(
        `You already have a '${name}' subscription at this tier level. ` +
        `Stacking requires distinct priorities: cancel or let the existing one expire first.`
      );
    }

    const result = await provider.initiatePurchase({
      guildId,
      tierId,
      offeringId,
      durationDays: offering.durationDays,
      amount: offering.amount,
      currency: offering.currency,
      providerConfig: link.config,
      couponCode: opts.couponCode,
      userId: opts.userId,
    });

    if (result.state && result.providerSubId) {
      const nowIso = new Date().toISOString();
      const sub: Subscription = {
        tierId,
        source: 'paid',
        offeringId,
        providerId,
        providerSubId: result.providerSubId,
        startDate: result.state.startDate,
        endDate: result.state.endDate,
        autoRenew: result.state.autoRenew,
        status: result.state.status === 'expired' ? 'expired' : 'active',
        couponCode: opts.couponCode,
        couponEffect: couponValidation?.effectText,
        providerMeta: result.state.meta,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      // Route to active or paused slot based on priority vs the currently
      // active paid sub.
      await this.installPaidSubscription(guildId, sub, offering.durationDays);
      // Only consume on synchronous success. Async providers consume via
      // provider.event once the purchase completes on their end.
      if (opts.couponCode) this.consumeCoupon(opts.couponCode);
    }

    return result;
  }

  /**
   * Route a newly-purchased paid subscription into the correct slot based on
   * priority vs the current active paid sub:
   *
   *   - No active paid (or same priority: already rejected upstream): install as active.
   *   - New priority > active priority: pause the active one, new takes the active slot.
   *   - New priority < active priority: install directly into the paused queue
   *     with remaining-days = the offering's full duration (lifetime stays null).
   *     Best-effort provider pause so it doesn't tick while waiting.
   */
  private async installPaidSubscription(
    guildId: string,
    sub: Subscription,
    offeringDurationDays: number | null
  ): Promise<void> {
    const subs = (this.config.subscriptions[guildId] = this.config.subscriptions[guildId] || {});
    const newPriority = this.config.tiers[sub.tierId]?.priority ?? 0;
    const activePriority = subs.paid && subs.paid.status === 'active'
      ? (this.config.tiers[subs.paid.tierId]?.priority ?? 0)
      : -Infinity;

    if (newPriority > activePriority) {
      // Higher: pause existing into the queue, take the active slot.
      await this.pauseCurrentPaidIfAny(guildId);
      subs.paid = sub;
      this.save();
      return;
    }

    // Lower than active (same was rejected upstream): install as paused.
    const nowIso = new Date().toISOString();
    const paused: Subscription = {
      ...sub,
      pausedAt: nowIso,
      remainingDaysAtPause: offeringDurationDays,
      updatedAt: nowIso,
    };
    if (!subs.pausedPaid) subs.pausedPaid = [];
    subs.pausedPaid.push(paused);
    subs.pausedPaid.sort((a, b) => {
      const pA = this.config.tiers[a.tierId]?.priority ?? 0;
      const pB = this.config.tiers[b.tierId]?.priority ?? 0;
      return pB - pA;
    });

    // Best-effort provider pause: the sub was just created as active at the
    // provider; we want it frozen until our resume later gives it new dates.
    if (paused.providerId && paused.providerSubId) {
      const provider = getPaymentRegistry().get(paused.providerId);
      if (provider?.pauseSubscription && provider.capabilities.supportsPause) {
        try { await provider.pauseSubscription(paused.providerSubId); }
        catch (err: any) {
          console.warn(`[PremiumManager] provider pauseSubscription failed for '${paused.providerId}': ${err?.message || err}`);
        }
      }
    }
    this.save();
  }

  /**
   * Pause the currently-active paid subscription (if any) and push it into
   * the paused-paid stack. Remaining days at pause time are frozen so the
   * sub can resume with the right amount of time when the higher-priority
   * purchase ends. Lifetime subs carry `remainingDaysAtPause: null`.
   *
   * Calls the provider's optional `pauseSubscription` so its own ticking /
   * billing stops. Providers without pause support still work, but their
   * internal state may drift while paused; resume overwrites it.
   */
  private async pauseCurrentPaidIfAny(guildId: string): Promise<void> {
    const subs = this.config.subscriptions[guildId];
    if (!subs?.paid || subs.paid.status !== 'active') return;
    const cur = subs.paid;
    const now = Date.now();
    const nowIso = new Date().toISOString();

    let remaining: number | null;
    if (cur.endDate === null) {
      remaining = null; // lifetime
    } else {
      const msLeft = Date.parse(cur.endDate) - now;
      const days = Math.ceil(msLeft / DAY_MS);
      remaining = Math.max(0, days);
    }

    // No time left and not lifetime: drop outright instead of queueing.
    if (remaining === 0) {
      delete subs.paid;
      return;
    }

    const paused: Subscription = {
      ...cur,
      pausedAt: nowIso,
      remainingDaysAtPause: remaining,
      updatedAt: nowIso,
    };

    if (!subs.pausedPaid) subs.pausedPaid = [];
    subs.pausedPaid.push(paused);
    // Keep the stack sorted highest-priority-first so `resumeHighestPausedPaid`
    // can always take index 0.
    subs.pausedPaid.sort((a, b) => {
      const pA = this.config.tiers[a.tierId]?.priority ?? 0;
      const pB = this.config.tiers[b.tierId]?.priority ?? 0;
      return pB - pA;
    });

    delete subs.paid;

    // Best-effort provider pause.
    if (paused.providerId && paused.providerSubId) {
      const provider = getPaymentRegistry().get(paused.providerId);
      if (provider?.pauseSubscription && provider.capabilities.supportsPause) {
        try { await provider.pauseSubscription(paused.providerSubId); }
        catch (err: any) {
          console.warn(`[PremiumManager] provider pauseSubscription failed for '${paused.providerId}': ${err?.message || err}`);
        }
      }
    }
  }

  /**
   * If the active paid slot is empty and there's a paused queue, resume the
   * highest-priority paused entry: give it a fresh startDate and an endDate
   * computed from its remaining-days-at-pause snapshot. Lifetime paused subs
   * resume with endDate=null.
   */
  private resumeHighestPausedPaid(guildId: string): void {
    const subs = this.config.subscriptions[guildId];
    if (!subs) return;
    if (subs.paid && subs.paid.status === 'active') return;
    if (!subs.pausedPaid || subs.pausedPaid.length === 0) return;

    const paused = subs.pausedPaid.shift()!;
    if (subs.pausedPaid.length === 0) delete subs.pausedPaid;

    const now = Date.now();
    const nowIso = new Date().toISOString();
    const newEndDate: string | null = paused.remainingDaysAtPause == null
      ? null
      : new Date(now + paused.remainingDaysAtPause * DAY_MS).toISOString();

    const resumed: Subscription = {
      ...paused,
      startDate: nowIso,
      endDate: newEndDate,
      status: 'active',
      updatedAt: nowIso,
      pausedAt: undefined,
      remainingDaysAtPause: undefined,
    };

    subs.paid = resumed;

    // Best-effort provider resume (fire-and-forget: the cache is authoritative
    // from here; provider state just needs to match).
    if (resumed.providerId && resumed.providerSubId) {
      const provider = getPaymentRegistry().get(resumed.providerId);
      if (provider?.resumeSubscription && provider.capabilities.supportsPause) {
        provider.resumeSubscription(resumed.providerSubId, newEndDate).catch((err: any) => {
          console.warn(`[PremiumManager] provider resumeSubscription failed for '${resumed.providerId}': ${err?.message || err}`);
        });
      }
    }
  }

  /** Cancel a paid subscription (flips autoRenew off, keeps remaining days). */
  async cancelPaidSubscription(guildId: string): Promise<boolean> {
    this.ensureLoaded();
    const paid = this.config.subscriptions[guildId]?.paid;
    if (!paid || !paid.providerId || !paid.providerSubId) return false;
    const provider = getPaymentRegistry().get(paid.providerId);
    if (!provider || !provider.capabilities.supportsCancel || !provider.cancelSubscription) return false;
    await provider.cancelSubscription(paid.providerSubId);
    return true;
  }

  /** Reactivate a cancelled paid subscription (flips autoRenew back on while still active). */
  async reactivatePaidSubscription(guildId: string): Promise<boolean> {
    this.ensureLoaded();
    const paid = this.config.subscriptions[guildId]?.paid;
    if (!paid || !paid.providerId || !paid.providerSubId) return false;
    const provider = getPaymentRegistry().get(paid.providerId);
    if (!provider || !provider.capabilities.supportsReactivate || !provider.reactivateSubscription) return false;
    await provider.reactivateSubscription(paid.providerSubId);
    return true;
  }

  // ============================================================================
  // SUBSCRIPTIONS: QUERY
  // ============================================================================

  getSubscriptions(guildId: string): GuildSubscriptions {
    this.ensureLoaded();
    const subs = this.config.subscriptions[guildId];
    return subs ? { ...subs } : {};
  }

  getAllSubscriptions(): Record<string, GuildSubscriptions> {
    this.ensureLoaded();
    return JSON.parse(JSON.stringify(this.config.subscriptions));
  }

  // ============================================================================
  // OVERRIDES & FEATURE GATES
  // ============================================================================

  /**
   * Get tier overrides (raw map including `_`-prefixed internal keys like
   * `_moduleEnabled`, `_disabledCommands`, `_hardLimits`) for the guild's
   * effective tier on a specific module.
   *
   * Free acts as a shared baseline: its overrides are merged in per-key, and
   * the active tier's explicit values win when set. This keeps the Free tier
   * as the floor that all tiers inherit from without requiring data to be
   * physically duplicated across tiers.
   */
  getTierOverrides(guildId: string, moduleName: string): Record<string, any> {
    const { tier, tierId } = this.resolveActiveTier(guildId);
    const tierMod = tier.overrides[moduleName] || {};
    if (tierId === 'free') return { ...tierMod };
    const freeMod = this.config.tiers.free?.overrides?.[moduleName] || {};
    // Free's effective contribution: when Free disables the module entirely,
    // its per-command / per-setting state is moot and must not propagate.
    const effectiveFree = effectiveFreeModuleOverride(freeMod);
    // Per-key: tier wins, undefined keys fall through to Free.
    const merged: Record<string, any> = { ...effectiveFree, ...tierMod };
    // _hardLimits is a nested map; merge per-key (tier wins) instead of
    // letting the tier's object replace Free's entirely.
    if (effectiveFree._hardLimits || tierMod._hardLimits) {
      merged._hardLimits = {
        ...(effectiveFree._hardLimits || {}),
        ...(tierMod._hardLimits || {}),
      };
    }
    return merged;
  }

  /**
   * Get tier-supplied hard limits for a module's settings. The caller
   * (settingsPanelFactory / settingsValidation) merges these on top of the
   * global _hardLimits; tier wins on overlap.
   */
  getTierHardLimits(guildId: string, moduleName: string): Record<string, HardLimitOverride> {
    const overrides = this.getTierOverrides(guildId, moduleName);
    const hl = overrides._hardLimits;
    if (hl && typeof hl === 'object' && !Array.isArray(hl)) {
      return hl as Record<string, HardLimitOverride>;
    }
    return {};
  }

  /** True if the guild's effective tier priority >= required. */
  hasFeatureAccess(guildId: string, requiredPriority: number): boolean {
    const { tier } = this.resolveActiveTier(guildId);
    return tier.priority >= requiredPriority;
  }

  /**
   * Per-feature gate check, for modules that want to gate specific internal
   * features (not commands, not the whole module). Looks up the module's
   * manifest `tierRequirement` and decides whether THIS feature falls under
   * the gate using the following rules:
   *
   *   - no `tierRequirement`: ungated (returns true)
   *   - `gatedFeatures` is an array: the feature is gated iff named in it
   *   - `gatedFeatures` absent but `gatedCommands` present: the gate is
   *     command-scoped, so features are not gated
   *   - both absent: whole-module gate, features are implicitly gated
   *
   * If the registry can't find the module (e.g. called before load), this
   * fails open to avoid blocking features due to lookup races.
   */
  hasFeature(guildId: string, moduleName: string, featureName: string): boolean {
    // Lazy-require the registry to avoid a static circular import
    // (moduleRegistry imports panelManager which imports this file).
    let registry: { getModule: (name: string) => { manifest?: any } | undefined };
    try {
      registry = (require('./moduleRegistry') as typeof import('./moduleRegistry')).getModuleRegistry();
    } catch {
      return true;
    }

    const mod = registry.getModule(moduleName);
    const tr = mod?.manifest?.tierRequirement;
    if (!tr || typeof tr.minPriority !== 'number') return true;

    let featureIsGated: boolean;
    if (Array.isArray(tr.gatedFeatures)) {
      featureIsGated = tr.gatedFeatures.includes(featureName);
    } else if (Array.isArray(tr.gatedCommands)) {
      featureIsGated = false;
    } else {
      featureIsGated = true;
    }

    if (!featureIsGated) return true;
    return this.hasFeatureAccess(guildId, tr.minPriority);
  }

  // ============================================================================
  // PROVIDER ACCOUNT LINKS: anti-duplicate registry
  //
  // One external account (e.g. a specific Patreon user) can only entitle one
  // guild at a time. Unused by DummyProvider; present so OAuth-linked providers
  // slot in without a data-model change later.
  // ============================================================================

  getAccountLink(providerId: string, externalAccountId: string): string | undefined {
    this.ensureLoaded();
    return this.config.providerAccountLinks[providerId]?.[externalAccountId];
  }

  linkAccount(providerId: string, externalAccountId: string, guildId: string): boolean {
    this.ensureLoaded();
    if (!this.config.providerAccountLinks[providerId]) {
      this.config.providerAccountLinks[providerId] = {};
    }
    const existing = this.config.providerAccountLinks[providerId][externalAccountId];
    if (existing && existing !== guildId) return false;
    this.config.providerAccountLinks[providerId][externalAccountId] = guildId;
    return this.save();
  }

  unlinkAccount(providerId: string, externalAccountId: string): boolean {
    this.ensureLoaded();
    const links = this.config.providerAccountLinks[providerId];
    if (!links) return true;
    delete links[externalAccountId];
    if (Object.keys(links).length === 0) delete this.config.providerAccountLinks[providerId];
    return this.save();
  }

  // ============================================================================
  // COUPONS: admin-managed discount codes
  //
  // Stored as a flat registry keyed by code. Effect is percentOff XOR extraDays;
  // `validateCoupon` checks existence, expiry, and usage cap but does NOT
  // consume. Providers that support coupons call `consumeCoupon` after a
  // successful subscribe to increment usedCount.
  // ============================================================================

  getAllCoupons(): Record<string, Coupon> {
    this.ensureLoaded();
    return { ...this.config.coupons };
  }

  getCoupon(code: string): Coupon | null {
    this.ensureLoaded();
    return this.config.coupons[code] || null;
  }

  /**
   * Create or replace a coupon. Exactly one of `percentOff` or `extraDays`
   * must be provided and be > 0. `allowedTiers` (when non-empty) must name
   * existing non-Free tiers. Returns false on validation failure.
   */
  setCoupon(
    code: string,
    input: Partial<Pick<Coupon, 'description' | 'percentOff' | 'extraDays' | 'maxUses' | 'expiresAt' | 'allowedTiers'>>
  ): boolean {
    this.ensureLoaded();
    const trimmed = (code || '').trim();
    if (!trimmed) return false;
    const percentOff = input.percentOff;
    const extraDays = input.extraDays;
    const hasPercent = typeof percentOff === 'number' && percentOff > 0;
    const hasDays = typeof extraDays === 'number' && extraDays > 0;
    if (hasPercent === hasDays) {
      // XOR: must have exactly one.
      return false;
    }
    if (hasPercent && (percentOff! < 1 || percentOff! > 100)) return false;
    if (hasDays && extraDays! < 1) return false;
    if (input.maxUses !== undefined && (typeof input.maxUses !== 'number' || input.maxUses < 1)) return false;
    if (input.expiresAt !== undefined && isNaN(Date.parse(input.expiresAt))) return false;

    let allowedTiers: string[] | undefined;
    if (input.allowedTiers !== undefined) {
      if (!Array.isArray(input.allowedTiers)) return false;
      // Empty array => global (store as undefined for clarity).
      if (input.allowedTiers.length > 0) {
        for (const t of input.allowedTiers) {
          if (typeof t !== 'string' || !t) return false;
          if (t === 'free') return false;
          if (!this.config.tiers[t]) return false;
        }
        allowedTiers = [...new Set(input.allowedTiers)];
      }
    }

    const existing = this.config.coupons[trimmed];
    this.config.coupons[trimmed] = {
      description: input.description,
      percentOff: hasPercent ? percentOff : undefined,
      extraDays: hasDays ? extraDays : undefined,
      maxUses: input.maxUses,
      expiresAt: input.expiresAt,
      allowedTiers,
      usedCount: existing?.usedCount ?? 0,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    return this.save();
  }

  deleteCoupon(code: string): boolean {
    this.ensureLoaded();
    if (!this.config.coupons[code]) return false;
    delete this.config.coupons[code];
    return this.save();
  }

  /**
   * Validate a coupon code WITHOUT consuming it. Caller is expected to call
   * `consumeCoupon` after the subscribe fully commits.
   *
   * When `tierId` is provided, the coupon's `allowedTiers` restriction is
   * enforced (a tier-restricted coupon only validates for listed tiers).
   * When `tierId` is omitted and the coupon is tier-restricted, we reject
   * conservatively: there's no safe way to say "maybe valid" here.
   */
  validateCoupon(code: string, tierId?: string): CouponValidation {
    this.ensureLoaded();
    const trimmed = (code || '').trim();
    if (!trimmed) return { valid: false, reason: 'empty code' };
    const coupon = this.config.coupons[trimmed];
    if (!coupon) return { valid: false, reason: 'not found' };
    if (coupon.expiresAt && Date.parse(coupon.expiresAt) < Date.now()) {
      return { valid: false, reason: 'expired' };
    }
    if (typeof coupon.maxUses === 'number' && coupon.usedCount >= coupon.maxUses) {
      return { valid: false, reason: 'usage limit reached' };
    }
    if (coupon.allowedTiers && coupon.allowedTiers.length > 0) {
      if (!tierId) return { valid: false, reason: 'tier-restricted coupon; target tier required' };
      if (!coupon.allowedTiers.includes(tierId)) {
        return { valid: false, reason: 'not valid for this tier' };
      }
    }
    const effectText = typeof coupon.percentOff === 'number'
      ? `${coupon.percentOff}% off`
      : typeof coupon.extraDays === 'number'
        ? `+${coupon.extraDays} days`
        : '';
    return {
      valid: true,
      coupon,
      effectText,
      effect: {
        percentOff: coupon.percentOff,
        extraDays: coupon.extraDays,
      },
    };
  }

  /** Increment usedCount for a coupon; no-op when the code doesn't exist. */
  consumeCoupon(code: string): boolean {
    this.ensureLoaded();
    const coupon = this.config.coupons[code];
    if (!coupon) return false;
    coupon.usedCount = (coupon.usedCount || 0) + 1;
    return this.save();
  }

  // ============================================================================
  // EXPIRY CHECKER: manual layer only
  //
  // Paid subscriptions are owned by their provider; provider events (or
  // scheduledReconcile for polling-driven providers) drive paid state
  // transitions. Manual subscriptions are our responsibility.
  // ============================================================================

  startExpiryChecker(intervalMs = 60_000): void {
    if (this.expiryTimer) return;
    this.expiryTimer = setInterval(() => this.checkExpiry(), intervalMs);
  }

  stopExpiryChecker(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  private checkExpiry(): void {
    this.ensureLoaded();
    let changed = false;
    const now = Date.now();
    const nowIso = new Date().toISOString();
    for (const guildId of Object.keys(this.config.subscriptions)) {
      const manual = this.config.subscriptions[guildId].manual;
      if (!manual) continue;
      if (manual.status === 'active' && manual.endDate !== null && Date.parse(manual.endDate) <= now) {
        manual.status = 'expired';
        manual.updatedAt = nowIso;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  // ============================================================================
  // MESSAGES
  // ============================================================================

  getMessages(): PremiumMessages {
    this.ensureLoaded();
    return { ...DEFAULT_MESSAGES, ...this.config.messages };
  }

  setMessages(partial: Partial<PremiumMessages>): boolean {
    this.ensureLoaded();
    this.config.messages = { ...this.config.messages, ...partial };
    return this.save();
  }

  resetMessages(): boolean {
    this.ensureLoaded();
    this.config.messages = { ...DEFAULT_MESSAGES };
    return this.save();
  }

  // ============================================================================
  // FULL CONFIG
  // ============================================================================

  getFullConfig(): PremiumConfig {
    this.ensureLoaded();
    return JSON.parse(JSON.stringify(this.config));
  }

  setFullConfig(config: PremiumConfig): boolean {
    if (!config.tiers || typeof config.tiers !== 'object') return false;

    for (const [id, t] of Object.entries(config.tiers)) {
      if (!t.overrides) t.overrides = {};
      if (!t.offerings) t.offerings = [];
      if (id === 'free') {
        t.priority = 0;
        t.offerings = [];
      }
    }
    if (!config.tiers.free) {
      config.tiers.free = { displayName: 'Free', priority: 0, overrides: {}, offerings: [] };
    }

    this.config = {
      tiers: config.tiers,
      subscriptions: config.subscriptions || {},
      messages: { ...DEFAULT_MESSAGES, ...(config.messages || {}) },
      providerAccountLinks: config.providerAccountLinks || {},
      activatedProviders: config.activatedProviders || {},
      coupons: config.coupons || {},
    };
    return this.save();
  }
}

/** Get the singleton PremiumManager instance */
export function getPremiumManager(): PremiumManager {
  if (!instance) {
    instance = new PremiumManager();
    instance.load();
    instance.startExpiryChecker();
  }
  return instance;
}

/** Reset the singleton (for testing) */
export function resetPremiumManager(): void {
  if (instance) instance.dispose();
  instance = null;
}
