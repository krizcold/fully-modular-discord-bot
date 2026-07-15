/**
 * Premium Manager - unified single-active-slot subscription model.
 *
 * Each guild has at most one ACTIVE subscription. Everything else lives in a
 * single priority-sorted PAUSED queue. Subscriptions of either source (manual
 * or paid) coexist in the same data structure.
 *
 *     guildSubscriptions[guildId] = {
 *       active?: Subscription,
 *       paused: Subscription[],   // priority desc; manual wins ties
 *     }
 *
 * Insertion rules (new sub arriving):
 *   higher priority    -> active pauses, incoming becomes active
 *   same priority + manual incoming -> active pauses, manual replaces (manual wins ties)
 *   same priority + paid incoming   -> reject
 *   lower priority     -> incoming inserts into paused queue at correct position
 *
 * On active expiry / cancel: pop highest-priority paused, resume (provider
 * resumeSubscription for paid, fresh dates for manual), install as active.
 * Repeat if popped is itself past its endDate.
 *
 * Provider as source of truth: PremiumManager caches paid subscription state;
 * provider events drive cache updates. Coupon validation is delegated to the
 * provider (no global coupon registry; Dummy owns its own coupons).
 *
 * Files:
 *   /data/global/premium-tiers.json        - PremiumConfig
 *   /data/global/premium-tiers.audit.jsonl - append-only audit log
 */

import fs from 'fs';
import path from 'path';
import * as crypto from 'crypto';
import { ensureDir } from './pathHelpers';
import { dataPath } from '../../../utils/dataRoot';
import type { HardLimitOverride } from '../../types/settingsTypes';
import {
  loadGlobalModuleConfig,
  saveGlobalModuleConfig,
  type GlobalModuleConfig,
} from './settings/settingsStorage';
import { getPaymentRegistry } from './payment/paymentRegistry';
import { dispatchPremiumNotification } from './premiumNotifications';
import type {
  ProviderEvent,
  InitiateResult,
  ProviderSubscriptionRef,
  ProviderLink,
  OfferingVariant,
  ProviderCouponValidation,
} from './payment/paymentTypes';

// ============================================================================
// TYPES
// ============================================================================

/** A buyable / acquirable option on a tier. Provider-agnostic. */
export interface TierOffering {
  /** Unique id within the tier. */
  id: string;
  /** Display label e.g. "Standard", "Pro Bundle". */
  label: string;
  /** Optional marketing copy shown on the subscribe card. */
  description?: string;
  /** Optional display icon. */
  icon?: string;
  /**
   * Provider routings for this offering. Each link picks its own mode (Price
   * vs Product) and config independently.
   */
  providerLinks: ProviderLink[];
  /**
   * When true, every purchase on this offering auto-renews (Subscribe UI
   * hides the one-time opt-out and the backend ignores autoRenewOptOut).
   * No effect on lifetime variants.
   */
  forceAutoRenew?: boolean;
  /**
   * Which provider's data is treated as canonical for cross-provider price
   * validation. Set when the admin wires their first real provider; other
   * real providers must match its prices or get auto-disabled.
   */
  primaryProviderId?: string;
}

/** Host-activated payment provider; missing entry = unavailable system-wide. */
export interface ActivatedProvider {
  /** When true, newly created offerings toggle this provider on by default. */
  defaultEnabled: boolean;
}

/** Individual tier definition. */
export interface PremiumTier {
  displayName: string;
  /** Higher = more premium; Free is always 0. */
  priority: number;
  /** Module-specific setting overrides: overrides[moduleName][settingKey] = value. */
  overrides: Record<string, Record<string, any>>;
  /** Offerings that acquire this tier. Free tier must be empty. */
  offerings: TierOffering[];
}

export type SubscriptionSource = 'manual' | 'paid';
export type SubscriptionStatus = 'active' | 'paused' | 'expired';

/**
 * Snapshot of variant + tier + offering metadata at sign-up time. Frozen on
 * the Subscription so we keep clean display continuity even if the offering
 * is renamed, the tier is renamed, or either is deleted later.
 */
export interface PurchasedSnapshot {
  offeringLabel: string;
  variantLabel: string;
  amount: number;
  currency: string;
  durationDays: number | null;
  trialDays?: number;
  tierDisplayName: string;
  tierPriority: number;
  purchasedAt: string;
}

/** A subscription instance tying a guild to a tier. */
export interface Subscription {
  /** Unique local id for queue management; survives across saves. */
  id: string;
  tierId: string;
  source: SubscriptionSource;

  // Paid only:
  offeringId?: string;
  /** Wire-level identifier picked at sign-up (Stripe Price ID, LS Variant ID, ...). */
  variantId?: string;
  providerId?: string;
  providerSubId?: string;
  providerMeta?: Record<string, any>;
  purchasedSnapshot?: PurchasedSnapshot;

  // Lifecycle:
  startDate: string;
  endDate: string | null;
  autoRenew: boolean;
  status: SubscriptionStatus;

  // Pause bookkeeping (status === 'paused'):
  pausedAt?: string;
  /** Frozen remaining time in days; null = lifetime (still null on resume). */
  remainingDaysAtPause?: number | null;
  /** Best-guess ISO when this paused entry will resume (when the higher-priority sub above ends). */
  resumesAtHint?: string;

  /** Provider-side coupon code used at sign-up. */
  couponCode?: string;

  // Manual only:
  notes?: string;
  /** Admin user id who granted (audit metadata). */
  grantedBy?: string;

  createdAt: string;
  updatedAt: string;
}

/** Per-guild subscription record. */
export interface GuildSubscriptions {
  /** Currently-effective subscription. At most one. */
  active?: Subscription;
  /** Priority desc; manual wins ties at equal priority. */
  paused: Subscription[];
  /**
   * Optional fallback Discord channel id for subscription notifications when
   * the bot can't DM the guild owner (DMs disabled, owner left guild, etc.).
   * Default is the guild's system channel; admins override here. Empty / unset
   * means "use system channel; if that's missing, log silently."
   */
  notificationsChannelId?: string;
}

/** Editable restriction messages shown when tier-gating blocks something. */
export interface PremiumMessages {
  moduleBlocked: string;
  commandBlocked: string;
  panelBlocked: string;
  /**
   * Label on the "go upgrade" button appended to a blocked response when
   * `WEBUI_BASE_URL` is set. The button links to the guild's subscription
   * page. When `WEBUI_BASE_URL` is missing the button is omitted entirely
   * (the rest of the message still shows).
   */
  upgradeButtonLabel: string;
}

/**
 * A scheduled price/variant migration. Host announces "subscribers on
 * variant X move to variant Y on DATE"; each affected guild owner gets a
 * DM to accept or decline. On `effectiveDate` the scheduler walks
 * decisions:
 *   - accepted -> provider.migrateSubscriptionPrice(target)
 *   - declined -> provider.cancelSubscription(soft) so the user rides
 *                 out their period and leaves
 *   - pending  -> apply host silence policy (cancel | continue)
 */
export type MigrationDecisionStatus = 'pending' | 'accepted' | 'declined' | 'silent-applied';
export type MigrationOutcome = 'migrated' | 'cancelled' | 'continued' | 'failed' | 'skipped';

export interface MigrationGuildDecision {
  guildId: string;
  /** Local Subscription.id at scheduling time. The actual sub may change
   * before effectiveDate (cancel, swap), in which case apply skips. */
  subscriptionId: string;
  /** providerSubId snapshot at scheduling time, for the provider call. */
  providerSubId: string;
  decision: MigrationDecisionStatus;
  decidedAt?: string;
  notifiedAt?: string;
  appliedAt?: string;
  outcome?: MigrationOutcome;
  /** Free-form note: "user already cancelled", "provider returned 422", etc. */
  outcomeNote?: string;
}

export interface Migration {
  id: string;
  providerId: string;
  sourceTierId: string;
  sourceOfferingId: string;
  sourceVariantId: string;
  targetTierId: string;
  targetOfferingId: string;
  targetVariantId: string;
  /** ISO timestamp when the scheduler will apply decisions. Spec says
   * >=30 days from scheduling for compliance; we soft-validate (warn but
   * allow) to keep the dev loop sane. */
  effectiveDate: string;
  /** Free-form announcement copy admins write, shown in subscriber DMs. */
  message: string;
  scheduledAt: string;
  scheduledBy: string;
  status: 'pending' | 'applied' | 'cancelled';
  decisions: MigrationGuildDecision[];
  appliedAt?: string;
}

/** Premium tiers configuration (no global coupons in the new model). */
export interface PremiumConfig {
  tiers: Record<string, PremiumTier>;
  subscriptions: Record<string, GuildSubscriptions>;
  messages: PremiumMessages;
  /**
   * Anti-duplicate registry for providers that link an external account.
   * providerAccountLinks[providerId][externalAccountId] = guildId.
   */
  providerAccountLinks: Record<string, Record<string, string>>;
  activatedProviders: Record<string, ActivatedProvider>;
  /** Scheduled price/variant migrations (Stage 5). Pending entries get
   * applied by the scheduler when their effectiveDate passes. */
  migrations: Migration[];
  /**
   * What to do for subscribers who never accept or decline a migration by
   * its effective date. 'cancel' (default, pro-consumer) sets
   * cancel_at_period_end so they ride out and leave. 'continue' applies
   * the migration anyway - host accepts the "silence as consent"
   * compliance burden. Toggleable in the admin UI with a confirmation.
   */
  migrationSilencePolicy: 'cancel' | 'continue';
}

// ============================================================================
// AUDIT LOG
// ============================================================================

/** A single append-only audit event. */
export interface AuditEntry {
  timestamp: string;
  /** Always 'admin' for now (single-user admin auth); per-user when admin accounts land. */
  actor: string;
  action:
    | 'tier.create' | 'tier.update' | 'tier.delete'
    | 'offering.create' | 'offering.update' | 'offering.delete'
    | 'provider.activation.set'
    | 'subscription.grant.manual' | 'subscription.revoke.manual' | 'subscription.extend.manual'
    | 'subscription.install.paid' | 'subscription.cancel.paid' | 'subscription.reactivate.paid'
    | 'subscription.expire.paid' | 'subscription.pause' | 'subscription.resume'
    | 'subscription.adopt.orphan' | 'subscription.cancel.orphan'
    | 'message.update'
    | 'migration.scheduled' | 'migration.cancelled' | 'migration.decision'
    | 'migration.applied' | 'migration.silence-policy.set';
  tierId?: string;
  offeringId?: string;
  providerId?: string;
  subscriptionId?: string;
  guildId?: string;
  migrationId?: string;
  before?: any;
  after?: any;
  metadata?: Record<string, any>;
}

// ============================================================================
// DEFAULTS
// ============================================================================

export const DEFAULT_MESSAGES: PremiumMessages = {
  moduleBlocked: ':no_entry_sign: This module is not available for your server\'s current tier.',
  commandBlocked: ':no_entry_sign: This command is not available for your server\'s current tier.',
  panelBlocked: ':no_entry_sign: This module is not available for your server\'s current tier.',
  upgradeButtonLabel: 'Upgrade your tier',
};

const DEFAULT_CONFIG: PremiumConfig = {
  tiers: {
    free: {
      displayName: 'Free',
      priority: 0,
      overrides: {},
      offerings: [],
    },
  },
  subscriptions: {},
  messages: { ...DEFAULT_MESSAGES },
  providerAccountLinks: {},
  activatedProviders: {},
  migrations: [],
  migrationSilencePolicy: 'cancel',
};

const CONFIG_PATH = dataPath('global', 'premium-tiers.json');
const AUDIT_PATH = dataPath('global', 'premium-tiers.audit.jsonl');
const DAY_MS = 24 * 60 * 60 * 1000;

let instance: PremiumManager | null = null;

// ============================================================================
// HELPERS
// ============================================================================

/** Generate a stable local id for a Subscription record. */
function newSubscriptionId(): string {
  return crypto.randomUUID();
}

/**
 * Permissive read-time normalization of a ProviderLink. Drops obviously
 * malformed entries and clamps mode/config to the discriminator. Disk format
 * may carry partial data after admin saves; this keeps the in-memory shape
 * sane.
 */
function normalizeProviderLink(raw: any): ProviderLink | null {
  if (!raw || typeof raw !== 'object' || typeof raw.providerId !== 'string') return null;
  const providerId = raw.providerId;
  const enabled = !!raw.enabled;
  const mode: 'price' | 'product' = raw.mode === 'product' ? 'product' : 'price';
  const link: ProviderLink = { providerId, enabled, mode };

  if (mode === 'price') {
    const entries = Array.isArray(raw.priceConfig?.entries)
      ? raw.priceConfig.entries
          .filter((e: any) => e && typeof e.variantId === 'string')
          .map((e: any) => ({
            variantId: e.variantId,
            ...(typeof e.labelOverride === 'string' && e.labelOverride !== '' ? { labelOverride: e.labelOverride } : {}),
          }))
      : [];
    link.priceConfig = { entries };
  } else {
    link.productConfig = {
      productId: typeof raw.productConfig?.productId === 'string' ? raw.productConfig.productId : '',
      ...(raw.productConfig?.useProviderHostedPicker ? { useProviderHostedPicker: true } : {}),
    };
  }

  if (raw.cache && typeof raw.cache === 'object') {
    const variants = Array.isArray(raw.cache.variants)
      ? raw.cache.variants.filter((v: any) => v && typeof v.variantId === 'string')
      : [];
    link.cache = {
      syncedAt: typeof raw.cache.syncedAt === 'string' ? raw.cache.syncedAt : '',
      variants,
      ...(typeof raw.cache.productLabel === 'string' ? { productLabel: raw.cache.productLabel } : {}),
      ...(typeof raw.cache.productDescription === 'string' ? { productDescription: raw.cache.productDescription } : {}),
    };
  }
  return link;
}

/**
 * Normalize a TierOffering coming off disk. Drops malformed providerLinks
 * entries; keeps the minimal valid shape so tsc + the resolver don't crash.
 */
function normalizeOffering(raw: any): TierOffering {
  const providerLinks: ProviderLink[] = [];
  if (Array.isArray(raw.providerLinks)) {
    for (const r of raw.providerLinks) {
      const link = normalizeProviderLink(r);
      if (link) providerLinks.push(link);
    }
  }
  // primaryProviderId only stays if it points to an enabled link.
  let primaryProviderId: string | undefined;
  if (typeof raw.primaryProviderId === 'string' && raw.primaryProviderId !== '') {
    if (providerLinks.some(l => l.providerId === raw.primaryProviderId && l.enabled)) {
      primaryProviderId = raw.primaryProviderId;
    }
  }
  return {
    id: raw.id,
    label: raw.label,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    icon: typeof raw.icon === 'string' ? raw.icon : undefined,
    providerLinks,
    forceAutoRenew: !!raw.forceAutoRenew,
    primaryProviderId,
  };
}

/**
 * Normalize a Subscription coming off disk. Backfills `id` for old records,
 * coerces status to the new three-value enum, and ensures the GuildSubscriptions
 * shape (active + paused: []).
 */
function normalizeSubscription(raw: any): Subscription | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.tierId !== 'string') return null;
  const source: SubscriptionSource = raw.source === 'paid' ? 'paid' : 'manual';
  let status: SubscriptionStatus;
  if (raw.status === 'paused') status = 'paused';
  else if (raw.status === 'expired') status = 'expired';
  else status = 'active';
  const sub: Subscription = {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newSubscriptionId(),
    tierId: raw.tierId,
    source,
    offeringId: typeof raw.offeringId === 'string' ? raw.offeringId : undefined,
    variantId: typeof raw.variantId === 'string' ? raw.variantId : undefined,
    providerId: typeof raw.providerId === 'string' ? raw.providerId : undefined,
    providerSubId: typeof raw.providerSubId === 'string' ? raw.providerSubId : undefined,
    providerMeta: raw.providerMeta && typeof raw.providerMeta === 'object' ? raw.providerMeta : undefined,
    purchasedSnapshot: raw.purchasedSnapshot && typeof raw.purchasedSnapshot === 'object' ? raw.purchasedSnapshot : undefined,
    startDate: typeof raw.startDate === 'string' ? raw.startDate : new Date().toISOString(),
    endDate: typeof raw.endDate === 'string' ? raw.endDate : null,
    autoRenew: !!raw.autoRenew,
    status,
    pausedAt: typeof raw.pausedAt === 'string' ? raw.pausedAt : undefined,
    remainingDaysAtPause: typeof raw.remainingDaysAtPause === 'number' || raw.remainingDaysAtPause === null
      ? raw.remainingDaysAtPause
      : undefined,
    resumesAtHint: typeof raw.resumesAtHint === 'string' ? raw.resumesAtHint : undefined,
    couponCode: typeof raw.couponCode === 'string' ? raw.couponCode : undefined,
    notes: typeof raw.notes === 'string' ? raw.notes : undefined,
    grantedBy: typeof raw.grantedBy === 'string' ? raw.grantedBy : undefined,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
  return sub;
}

/** Structural value equality used for redundant-vs-Free checks. */
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
 * disables a module entirely, the only meaningful baseline is "module off";
 * its per-command / per-setting state is moot on a disabled module.
 */
function effectiveFreeModuleOverride(freeMod: Record<string, any> | undefined): Record<string, any> {
  if (!freeMod) return {};
  if (freeMod._moduleEnabled === false) return { _moduleEnabled: false };
  return freeMod;
}

/**
 * Convert a module's `GlobalModuleConfig` (the deployment baseline) into the
 * legacy "Free-tier overrides for this module" shape that the rest of the
 * tier-merge code expects (`{ _moduleEnabled?, _disabledCommands?, _hardLimits?, <key>: value }`).
 *
 * Storage layout changed in the unification rework: the deployment baseline
 * lives in `/data/global/{module}/settings.json` instead of
 * `tiers.free.overrides[module]`. This adapter keeps the existing override
 * merge / prune / sanitize logic working without each caller having to know
 * the storage move.
 */
function freeBaselineFromGlobal(g: GlobalModuleConfig): Record<string, any> {
  const result: Record<string, any> = { ...g.values };
  if (g.moduleEnabled === false) result._moduleEnabled = false;
  if (g.disabledCommands.length > 0) result._disabledCommands = [...g.disabledCommands];
  if (Object.keys(g.hardLimits).length > 0) {
    result._hardLimits = JSON.parse(JSON.stringify(g.hardLimits));
  }
  return result;
}

function moduleOverrideRedundantVsFree(
  tierMod: Record<string, any>,
  freeMod: Record<string, any>,
): boolean {
  const effectiveFree = effectiveFreeModuleOverride(freeMod);
  const keys = Object.keys(tierMod || {});
  if (keys.length === 0) return true;
  for (const key of keys) {
    if (!deepEqual(tierMod[key], effectiveFree[key])) return false;
  }
  return true;
}

// ============================================================================
// MANAGER
// ============================================================================

export class PremiumManager {
  private config: PremiumConfig;
  /**
   * Manual-grant ids that have already received the "ending in 24h"
   * heads-up notification, so the ticker doesn't re-DM the same warning
   * every minute. Cleared when the sub is no longer active (expired,
   * revoked, or removed) so a re-grant of the same id (impossible today,
   * but cheap insurance) gets a fresh notification window.
   */
  private endingSoonNotified: Set<string> = new Set();
  private configLoaded = false;
  private configMtimeMs = 0;
  private expiryTimer: NodeJS.Timeout | null = null;

  /** Listener: mirror provider events into the cache. */
  private paidEventHandler = (event: ProviderEvent): void => {
    this.ensureLoaded();

    if (event.type === 'subscription.created') {
      void this.installAsyncSubscription(event).catch(err => {
        console.error('[PremiumManager] installAsyncSubscription failed:', err);
      });
      return;
    }

    // For lifecycle events on existing subs, find the record (active or paused)
    // by providerSubId and update in place.
    const subs = this.config.subscriptions[event.guildId];
    if (!subs) return;

    const matching = this.findSubscriptionByProviderSubId(subs, event.providerSubId);
    if (!matching) return;
    const { sub } = matching;

    // Renewal failure is a notification-only event - no cache state change.
    // Provider owns the dunning timeline; if it gives up, a separate
    // subscription.expired event fires and triggers the standard expiry path.
    if (event.type === 'subscription.renewal-failed') {
      void dispatchPremiumNotification(event.guildId, 'paid.sub.renewal-failed', {
        tierName: this.config.tiers[sub.tierId]?.displayName || sub.tierId,
        providerName: this.providerDisplayName(event.providerId),
        details: event.reason,
      });
      return;
    }

    // subscription.paused is informational from the provider side: the cache
    // already flipped status to 'paused' when WE moved the sub into the queue.
    // Update resumesAtHint to whatever the provider reported.
    if (event.type === 'subscription.paused') {
      if (event.resumesAt) sub.resumesAtHint = event.resumesAt;
      sub.updatedAt = new Date().toISOString();
      this.save();
      return;
    }

    // Remaining events all carry `state`.
    const s = event.state;
    sub.startDate = s.startDate;
    sub.endDate = s.endDate;
    sub.autoRenew = s.autoRenew;
    sub.providerMeta = s.meta;
    sub.updatedAt = new Date().toISOString();

    // Map provider status back to our three-value enum.
    if (s.status === 'expired') sub.status = 'expired';
    else if (s.status === 'paused') sub.status = 'paused';
    else sub.status = 'active';

    // If the active sub just expired, drop it from the slot and resume queue.
    if (matching.location === 'active' && sub.status === 'expired') {
      this.writeAudit({
        timestamp: new Date().toISOString(),
        actor: 'admin',
        action: 'subscription.expire.paid',
        guildId: event.guildId,
        subscriptionId: sub.id,
        providerId: event.providerId,
      });
      void dispatchPremiumNotification(event.guildId, 'paid.sub.expired', {
        tierName: this.config.tiers[sub.tierId]?.displayName || sub.tierId,
        providerName: this.providerDisplayName(event.providerId),
      });
      delete subs.active;
      this.resumeNext(event.guildId);
    }

    this.save();
  };

  /**
   * Async install: webhook-driven providers fire `subscription.created` after
   * a successful checkout. Construct the cache record, snapshot, and route
   * through `installSubscription` so stacking rules apply uniformly.
   */
  private async installAsyncSubscription(
    event: Extract<ProviderEvent, { type: 'subscription.created' }>,
  ): Promise<void> {
    // Idempotency: webhook deliveries are at-least-once.
    if (this.findGuildSubscriptionByProviderSubId(event.guildId, event.providerSubId)) return;

    const tier = this.config.tiers[event.tierId];
    if (!tier) {
      console.warn(`[PremiumManager] subscription.created for unknown tier '${event.tierId}' (provider=${event.providerId}, sub=${event.providerSubId})`);
      return;
    }
    const offering = tier.offerings.find(o => o.id === event.offeringId);
    if (!offering) {
      console.warn(`[PremiumManager] subscription.created for unknown offering '${event.offeringId}' on tier '${event.tierId}'`);
      return;
    }

    const variant = event.variantSnapshot
      ?? this.findCachedVariant(offering, event.providerId, event.variantId);

    const purchasedSnapshot = this.buildPurchasedSnapshot(
      tier,
      offering,
      variant,
      event.providerId,
    );

    const nowIso = new Date().toISOString();
    const sub: Subscription = {
      id: newSubscriptionId(),
      tierId: event.tierId,
      source: 'paid',
      offeringId: event.offeringId,
      variantId: event.variantId,
      providerId: event.providerId,
      providerSubId: event.providerSubId,
      providerMeta: event.state.meta,
      purchasedSnapshot,
      startDate: event.state.startDate,
      endDate: event.state.endDate,
      autoRenew: event.state.autoRenew,
      status: event.state.status === 'expired' ? 'expired'
        : event.state.status === 'paused' ? 'paused'
        : 'active',
      couponCode: event.couponCode,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await this.installSubscription(event.guildId, sub);
    this.writeAudit({
      timestamp: nowIso,
      actor: 'admin',
      action: 'subscription.install.paid',
      guildId: event.guildId,
      tierId: event.tierId,
      offeringId: event.offeringId,
      providerId: event.providerId,
      subscriptionId: sub.id,
      metadata: { variantId: event.variantId },
    });
    void dispatchPremiumNotification(event.guildId, 'paid.sub.started', {
      tierName: tier.displayName,
      providerName: this.providerDisplayName(event.providerId),
      endDate: sub.endDate,
    });
  }

  constructor() {
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    getPaymentRegistry().on('provider.event', this.paidEventHandler);
  }

  dispose(): void {
    this.stopExpiryChecker();
    getPaymentRegistry().off('provider.event', this.paidEventHandler);
  }

  // ============================================================================
  // CONFIG I/O
  // ============================================================================

  load(): void {
    try {
      ensureDir(path.dirname(CONFIG_PATH));
      if (fs.existsSync(CONFIG_PATH)) {
        const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const loaded = JSON.parse(content) as Partial<PremiumConfig>;

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

        // Normalize each guild's subscription record into the new shape.
        const subscriptions: Record<string, GuildSubscriptions> = {};
        for (const [guildId, raw] of Object.entries(loaded.subscriptions || {})) {
          const r = raw as any;
          const active = r?.active ? normalizeSubscription(r.active) : null;
          const pausedRaw = Array.isArray(r?.paused) ? r.paused : [];
          const paused = pausedRaw
            .map(normalizeSubscription)
            .filter((s: Subscription | null): s is Subscription => !!s);
          const notificationsChannelId = typeof r?.notificationsChannelId === 'string' && r.notificationsChannelId.length > 0
            ? r.notificationsChannelId
            : undefined;
          if (active || paused.length > 0 || notificationsChannelId) {
            subscriptions[guildId] = {
              ...(active ? { active } : {}),
              paused,
              ...(notificationsChannelId ? { notificationsChannelId } : {}),
            };
          }
        }

        this.config = {
          tiers: mergedTiers,
          subscriptions,
          messages: { ...DEFAULT_MESSAGES, ...(loaded.messages || {}) },
          providerAccountLinks: loaded.providerAccountLinks || {},
          activatedProviders: loaded.activatedProviders || {},
          migrations: Array.isArray(loaded.migrations) ? loaded.migrations : [],
          migrationSilencePolicy: (loaded.migrationSilencePolicy === 'continue' ? 'continue' : 'cancel'),
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
   * Ensure config is loaded and up-to-date with disk. Bot and forked web-UI
   * processes share the file; mtime check picks up cross-process writes.
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
  // AUDIT LOG
  // ============================================================================

  /**
   * Append a single audit entry. Best-effort: failures log but don't throw,
   * so a failing audit write doesn't block the operation that produced it.
   */
  private writeAudit(entry: AuditEntry): void {
    try {
      ensureDir(path.dirname(AUDIT_PATH));
      fs.appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      console.error('[PremiumManager] writeAudit failed:', err);
    }
  }

  /**
   * Read the audit log with optional filters. Returns newest-first up to
   * `limit` entries (default 500, hard cap 5000 to keep responses bounded).
   * Reads the entire file synchronously - acceptable while the log is
   * append-only and the volume stays in admin-action territory; revisit
   * with a tail-reverse-stream if it ever grows past tens of MB.
   *
   * Bad lines are skipped silently (a partial-write or hand-edit shouldn't
   * tear down the whole viewer). Filter values are exact-match except for
   * `from` / `to` which are timestamp boundaries (inclusive).
   */
  readAuditEntries(filters: {
    from?: string;
    to?: string;
    action?: string;
    tierId?: string;
    providerId?: string;
    guildId?: string;
    subscriptionId?: string;
    limit?: number;
  } = {}): { entries: AuditEntry[]; total: number; truncated: boolean } {
    const limit = Math.max(1, Math.min(filters.limit ?? 500, 5000));
    if (!fs.existsSync(AUDIT_PATH)) {
      return { entries: [], total: 0, truncated: false };
    }
    const raw = fs.readFileSync(AUDIT_PATH, 'utf-8');
    const lines = raw.split('\n');
    const matched: AuditEntry[] = [];
    let totalParsed = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: AuditEntry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      totalParsed++;
      if (filters.from && entry.timestamp < filters.from) continue;
      if (filters.to && entry.timestamp > filters.to) continue;
      if (filters.action && entry.action !== filters.action) continue;
      if (filters.tierId && entry.tierId !== filters.tierId) continue;
      if (filters.providerId && entry.providerId !== filters.providerId) continue;
      if (filters.guildId && entry.guildId !== filters.guildId) continue;
      if (filters.subscriptionId && entry.subscriptionId !== filters.subscriptionId) continue;
      matched.push(entry);
    }
    matched.reverse();
    const truncated = matched.length > limit;
    return { entries: matched.slice(0, limit), total: totalParsed, truncated };
  }

  // ============================================================================
  // TIER MANAGEMENT
  // ============================================================================

  getAllTiers(): Record<string, PremiumTier> {
    this.ensureLoaded();
    return { ...this.config.tiers };
  }

  /**
   * Like `getAllTiers`, but `tiers.free.overrides` is reconstructed from
   * the Global module configs (`/data/global/{module}/settings.json`)
   * instead of returned as the empty placeholder that lives on disk in
   * the new model. Used by the Premium Tiers Web UI so the Free tier
   * editor sees the host's baseline values + caps + flags.
   */
  getAllTiersWithEffectiveFree(): Record<string, PremiumTier> {
    this.ensureLoaded();
    const tiers: Record<string, PremiumTier> = {};
    for (const [id, t] of Object.entries(this.config.tiers)) {
      tiers[id] = { ...t, overrides: { ...t.overrides } };
    }
    if (tiers.free) {
      tiers.free = { ...tiers.free, overrides: this.getEffectiveFreeOverrides() };
    }
    return tiers;
  }

  /**
   * Build the legacy "Free-tier overrides" record by walking every module
   * with a settings schema and adapting each Global config into the
   * override shape (`{ _moduleEnabled?, _disabledCommands?, _hardLimits?, <key>: value }`).
   * Modules without any baseline state contribute no entry. The shape
   * matches what `tiers.free.overrides` looked like in the pre-unification
   * model, so the Web Tier UI can keep treating it uniformly.
   */
  getEffectiveFreeOverrides(): Record<string, Record<string, any>> {
    let modules: Array<{ name: string }> = [];
    try {
      const { getModulesWithSettings } = require('./settings/settingsDiscovery') as typeof import('./settings/settingsDiscovery');
      modules = getModulesWithSettings();
    } catch {
      return {};
    }
    const result: Record<string, Record<string, any>> = {};
    for (const { name } of modules) {
      const cfg = loadGlobalModuleConfig(name);
      const overrides = freeBaselineFromGlobal(cfg);
      if (Object.keys(overrides).length > 0) {
        result[name] = overrides;
      }
    }
    return result;
  }

  getTier(tierId: string): PremiumTier | null {
    this.ensureLoaded();
    return this.config.tiers[tierId] || null;
  }

  setTier(tierId: string, tier: PremiumTier): boolean {
    this.ensureLoaded();
    // Free is the deployment baseline; its data lives in
    // `/data/global/{module}/settings.json` and is edited via
    // `setGlobalModuleConfig` (Web global-config route) or the Discord
    // System Panel. Tier-shaped updates to Free are not supported.
    if (tierId === 'free') {
      throw new Error("Cannot edit the 'free' tier via setTier - edit Global module config via the System Panel or the global-config route instead");
    }
    const before = this.config.tiers[tierId] ? JSON.parse(JSON.stringify(this.config.tiers[tierId])) : null;
    this.config.tiers[tierId] = {
      displayName: tier.displayName,
      priority: tier.priority,
      overrides: this.pruneOverridesAgainstFree(
        this.sanitizeTierAgainstFree(tier.overrides || {}),
      ),
      offerings: (tier.offerings || []).map(normalizeOffering),
    };
    const ok = this.save();
    if (ok) {
      this.writeAudit({
        timestamp: new Date().toISOString(),
        actor: 'admin',
        action: before ? 'tier.update' : 'tier.create',
        tierId,
        before,
        after: this.config.tiers[tierId],
      });
      // Notify subscribers only when the change made the tier stricter -
      // beneficial changes (more features, higher limits) don't need a DM.
      if (before && this.tierChangeIsStricter(before, this.config.tiers[tierId])) {
        const after = this.config.tiers[tierId];
        for (const [guildId, subs] of Object.entries(this.config.subscriptions)) {
          const onThisTier = subs.active?.tierId === tierId
            || subs.paused.some(p => p.tierId === tierId);
          if (!onThisTier) continue;
          void dispatchPremiumNotification(guildId, 'tier.config-change-affecting-subscriber', {
            tierName: after.displayName,
            details: 'Some perks or limits were reduced. Open the subscription panel to see the latest tier contents.',
          });
        }
      }
    }
    return ok;
  }

  /**
   * Update a module's Global / Free baseline config (values + caps + module
   * flags + disabled commands). Source of truth is
   * `/data/global/{module}/settings.json`. Edits flow through here from
   * both the Discord System Panel and the Web Premium Tiers > Free tier
   * view.
   *
   * After writing, every paid tier's `overrides[module]` is re-sanitized
   * and re-pruned against the new baseline (mirrors what the old
   * Free-tier path of setTier did, but scoped to the touched module).
   */
  setGlobalModuleConfig(moduleName: string, partial: Partial<GlobalModuleConfig>): boolean {
    this.ensureLoaded();
    const ok = saveGlobalModuleConfig(moduleName, partial);
    if (!ok) return false;

    // Re-sanitize + re-prune every paid tier's entry for this module against
    // the new baseline. Free has no `overrides` payload of its own so it
    // doesn't need touching.
    for (const [tierId, tier] of Object.entries(this.config.tiers)) {
      if (tierId === 'free') continue;
      if (!tier.overrides[moduleName]) continue;
      const singleModuleSet = { [moduleName]: tier.overrides[moduleName] };
      const sanitized = this.pruneOverridesAgainstFree(
        this.sanitizeTierAgainstFree(singleModuleSet),
      );
      if (sanitized[moduleName]) {
        tier.overrides[moduleName] = sanitized[moduleName];
      } else {
        delete tier.overrides[moduleName];
      }
    }
    this.save();
    return true;
  }

  /**
   * "Stricter" heuristic for tier-config-change notifications. Returns true
   * when any of these hold for `after` vs `before`:
   *   - A module override key disappears entirely
   *   - A boolean override flips true -> false
   *   - A numeric override decreases
   *   - A `_hardLimits` numeric value decreases or key disappears
   *
   * Pure additions / increases / new modules are NOT stricter and don't
   * warrant a DM. False positives are tolerable; false negatives just mean
   * the user finds out via the UI on next load.
   */
  private tierChangeIsStricter(before: PremiumTier, after: PremiumTier): boolean {
    const beforeOv = before.overrides || {};
    const afterOv = after.overrides || {};
    for (const moduleName of Object.keys(beforeOv)) {
      const beforeMod = beforeOv[moduleName];
      const afterMod = afterOv[moduleName];
      if (!afterMod) return true;
      if (!beforeMod || typeof beforeMod !== 'object') continue;
      for (const key of Object.keys(beforeMod)) {
        const b = (beforeMod as any)[key];
        const a = (afterMod as any)[key];
        if (a === undefined) return true;
        if (typeof b === 'boolean' && typeof a === 'boolean' && b === true && a === false) return true;
        if (typeof b === 'number' && typeof a === 'number' && a < b) return true;
        if (key === '_hardLimits' && b && typeof b === 'object' && a && typeof a === 'object') {
          for (const limitKey of Object.keys(b)) {
            const bl = (b as any)[limitKey];
            const al = (a as any)[limitKey];
            if (al === undefined) return true;
            if (typeof bl === 'number' && typeof al === 'number' && al < bl) return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Delete a tier (cannot delete 'free'). Revokes any active or paused
   * subscriptions on that tier; resumes the next paused entry into the
   * active slot if active was on the deleted tier.
   */
  deleteTier(tierId: string): boolean {
    this.ensureLoaded();

    if (tierId === 'free') {
      console.error('[PremiumManager] Cannot delete the free tier');
      return false;
    }
    const before = this.config.tiers[tierId];
    if (!before) return false;

    for (const guildId of Object.keys(this.config.subscriptions)) {
      const subs = this.config.subscriptions[guildId];
      const activeWasOnDeleted = subs.active?.tierId === tierId;
      if (activeWasOnDeleted) delete subs.active;
      if (subs.paused.length > 0) {
        subs.paused = subs.paused.filter(p => p.tierId !== tierId);
      }
      // Pop the next paused entry if active is now empty.
      if (!subs.active && subs.paused.length > 0) {
        this.resumeNext(guildId);
      }
      if (this.guildSubsEmpty(subs)) delete this.config.subscriptions[guildId];
    }

    delete this.config.tiers[tierId];
    const ok = this.save();
    if (ok) {
      this.writeAudit({
        timestamp: new Date().toISOString(),
        actor: 'admin',
        action: 'tier.delete',
        tierId,
        before,
      });
    }
    return ok;
  }

  private guildSubsEmpty(subs: GuildSubscriptions): boolean {
    if (subs.active) return false;
    if (subs.paused.length > 0) return false;
    if (subs.notificationsChannelId) return false;
    return true;
  }

  /**
   * Look up a friendly provider display name. Falls back to the providerId
   * if the registry doesn't have it (provider unregistered after a sub was
   * installed). Returns undefined when no providerId given so callers can
   * skip the "(provider)" suffix in messages.
   */
  private providerDisplayName(providerId?: string): string | undefined {
    if (!providerId) return undefined;
    return getPaymentRegistry().get(providerId)?.displayName || providerId;
  }

  getTiersSortedByPriority(): Array<{ id: string; tier: PremiumTier }> {
    this.ensureLoaded();
    return Object.entries(this.config.tiers)
      .map(([id, tier]) => ({ id, tier }))
      .sort((a, b) => a.tier.priority - b.tier.priority);
  }

  /**
   * Strip tier-override state worse-than-Free. Direction-aware keys only:
   *   - `_moduleEnabled: false` removed when Free enables the module
   *   - `_disabledCommands` filtered to subset of Free's, unless Free disables the module entirely
   * Setting values are left alone (no general worse-than schema).
   */
  private sanitizeTierAgainstFree(
    tierOverrides: Record<string, Record<string, any>>,
  ): Record<string, Record<string, any>> {
    const result: Record<string, Record<string, any>> = {};
    for (const [moduleName, tierMod] of Object.entries(tierOverrides || {})) {
      const freeMod = freeBaselineFromGlobal(loadGlobalModuleConfig(moduleName));
      const sanitized: Record<string, any> = { ...tierMod };
      const freeModuleOff = freeMod._moduleEnabled === false;

      if (sanitized._moduleEnabled === false && !freeModuleOff) {
        delete sanitized._moduleEnabled;
      }
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

  /** Drop module entries fully redundant vs Free's effective baseline. */
  private pruneOverridesAgainstFree(
    tierOverrides: Record<string, Record<string, any>>,
  ): Record<string, Record<string, any>> {
    const result: Record<string, Record<string, any>> = {};
    for (const [moduleName, tierMod] of Object.entries(tierOverrides || {})) {
      const freeMod = freeBaselineFromGlobal(loadGlobalModuleConfig(moduleName));
      if (moduleOverrideRedundantVsFree(tierMod, freeMod)) continue;
      result[moduleName] = tierMod;
    }
    return result;
  }

  // ============================================================================
  // ACTIVATED PROVIDERS
  // ============================================================================

  getActivatedProviders(): Record<string, ActivatedProvider> {
    this.ensureLoaded();
    return { ...this.config.activatedProviders };
  }

  isProviderActivated(providerId: string): boolean {
    this.ensureLoaded();
    return !!this.config.activatedProviders[providerId];
  }

  setProviderActivation(providerId: string, activated: boolean, defaultEnabled = false): boolean {
    this.ensureLoaded();
    const before = this.config.activatedProviders[providerId];
    if (!activated) {
      delete this.config.activatedProviders[providerId];
    } else {
      this.config.activatedProviders[providerId] = { defaultEnabled: !!defaultEnabled };
    }
    const ok = this.save();
    if (ok) {
      this.writeAudit({
        timestamp: new Date().toISOString(),
        actor: 'admin',
        action: 'provider.activation.set',
        providerId,
        before,
        after: this.config.activatedProviders[providerId],
      });
    }
    return ok;
  }

  // ============================================================================
  // RESOLVER
  // ============================================================================

  /**
   * Resolve the effective tier for a guild. Reads the active slot directly:
   * if it's still active and not past its endDate, return its tier. Else Free.
   */
  resolveActiveTier(guildId: string): { tierId: string; tier: PremiumTier; source: SubscriptionSource | null } {
    this.ensureLoaded();
    const subs = this.config.subscriptions[guildId];
    const now = Date.now();
    const active = subs?.active;

    if (active
      && active.status === 'active'
      && (active.endDate === null || Date.parse(active.endDate) > now)
    ) {
      const tier = this.config.tiers[active.tierId];
      if (tier) return { tierId: active.tierId, tier, source: active.source };
    }

    return { tierId: 'free', tier: this.config.tiers.free, source: null };
  }

  // ============================================================================
  // SUBSCRIPTION INSTALL / STACKING
  // ============================================================================

  /**
   * Build a PurchasedSnapshot for a Subscription record being installed now.
   * Mixes the variant returned by the provider (or cached) with the tier +
   * offering display data PM has at install time.
   */
  private buildPurchasedSnapshot(
    tier: PremiumTier,
    offering: TierOffering,
    variant: OfferingVariant | null | undefined,
    providerId?: string,
  ): PurchasedSnapshot {
    // Honor admin label overrides at snapshot time so the user's record
    // freezes the label they actually saw at sign-up. Product mode keeps
    // overrides in `productConfig.variantLabelOverrides`; Price mode bakes
    // overrides directly into the cached `OfferingVariant.label`, so the
    // raw `variant.label` is already correct in that path.
    let variantLabel = variant?.label ?? '';
    if (variant && providerId && offering?.providerLinks) {
      const link = offering.providerLinks.find(l => l.providerId === providerId);
      if (link?.mode === 'product') {
        const override = link.productConfig?.variantLabelOverrides?.[variant.variantId];
        if (override) variantLabel = override;
      }
    }
    return {
      offeringLabel: offering.label,
      variantLabel,
      amount: variant?.amount ?? 0,
      currency: variant?.currency ?? '',
      durationDays: variant?.durationDays ?? null,
      ...(variant?.trialDays !== undefined ? { trialDays: variant.trialDays } : {}),
      tierDisplayName: tier.displayName,
      tierPriority: tier.priority,
      purchasedAt: new Date().toISOString(),
    };
  }

  /**
   * Find a cached variant on an offering's provider link by variantId. Used
   * during async install when the event didn't carry a snapshot.
   */
  private findCachedVariant(
    offering: TierOffering,
    providerId: string,
    variantId: string | undefined,
  ): OfferingVariant | null {
    if (!variantId) return null;
    const link = offering.providerLinks.find(l => l.providerId === providerId);
    if (!link?.cache?.variants) return null;
    return link.cache.variants.find(v => v.variantId === variantId) || null;
  }

  /**
   * Look up a Subscription on a guild by providerSubId. Returns where it lives
   * (active vs paused index) so the caller can mutate in place.
   */
  private findSubscriptionByProviderSubId(
    subs: GuildSubscriptions,
    providerSubId: string,
  ): { sub: Subscription; location: 'active' | 'paused'; pausedIndex?: number } | null {
    if (subs.active?.providerSubId === providerSubId) {
      return { sub: subs.active, location: 'active' };
    }
    const idx = subs.paused.findIndex(p => p.providerSubId === providerSubId);
    if (idx >= 0) return { sub: subs.paused[idx], location: 'paused', pausedIndex: idx };
    return null;
  }

  /** Cross-guild lookup helper for orphan dedup. */
  private findGuildSubscriptionByProviderSubId(guildId: string, providerSubId: string): Subscription | null {
    const subs = this.config.subscriptions[guildId];
    if (!subs) return null;
    return this.findSubscriptionByProviderSubId(subs, providerSubId)?.sub || null;
  }

  /**
   * Insertion point for both manual grants and paid installs. Routes the new
   * sub into the active slot or paused queue per the unified rules:
   *   higher priority -> active pauses, new becomes active
   *   same priority + manual -> active pauses, manual replaces (manual wins ties)
   *   same priority + paid   -> caller already rejected; defensive throw here
   *   lower priority -> insert into paused queue at correct position
   */
  private async installSubscription(guildId: string, incoming: Subscription): Promise<void> {
    const subs = (this.config.subscriptions[guildId] ??= { paused: [] });
    const incomingPriority = this.config.tiers[incoming.tierId]?.priority ?? 0;

    const active = subs.active;
    const activeAlive = active
      && active.status === 'active'
      && (active.endDate === null || Date.parse(active.endDate) > Date.now());

    if (!activeAlive) {
      // No active sub (or it's expired): incoming becomes active.
      if (active) delete subs.active;
      subs.active = incoming;
      this.save();
      return;
    }

    const activePriority = this.config.tiers[active!.tierId]?.priority ?? 0;

    if (incomingPriority > activePriority) {
      await this.pauseActiveIntoQueue(guildId);
      subs.active = incoming;
      this.save();
      return;
    }

    if (incomingPriority === activePriority) {
      if (incoming.source === 'manual') {
        // Manual replaces (manual wins ties at equal priority).
        await this.pauseActiveIntoQueue(guildId);
        subs.active = incoming;
        this.save();
        return;
      }
      // Same-priority paid: caller is expected to reject upstream.
      throw new Error(
        `You already have a '${this.config.tiers[active!.tierId]?.displayName || active!.tierId}' subscription. ` +
        `Stacking requires distinct priorities; cancel or let the existing one expire first.`,
      );
    }

    // Lower priority: insert into paused queue at correct position.
    const nowIso = new Date().toISOString();
    const paused: Subscription = {
      ...incoming,
      status: 'paused',
      pausedAt: nowIso,
      remainingDaysAtPause: incoming.endDate === null
        ? null
        : Math.max(0, Math.ceil((Date.parse(incoming.endDate) - Date.now()) / DAY_MS)),
      resumesAtHint: active!.endDate || undefined,
      updatedAt: nowIso,
    };
    subs.paused.push(paused);
    this.sortPausedQueue(subs);

    // Best-effort provider pause for paid: the sub was just created as
    // active at the provider; we want it frozen until our resume gives
    // it new dates.
    if (paused.source === 'paid' && paused.providerId && paused.providerSubId) {
      const provider = getPaymentRegistry().get(paused.providerId);
      if (provider?.pauseSubscription && provider.capabilities.supportsPause) {
        try { await provider.pauseSubscription(paused.providerSubId, active!.endDate); }
        catch (err: any) {
          console.warn(`[PremiumManager] provider pauseSubscription failed for '${paused.providerId}': ${err?.message || err}`);
        }
      }
    }
    this.save();
  }

  /**
   * Move the currently-active subscription to the paused queue. Snapshots
   * remaining days, calls provider.pauseSubscription for paid subs, sorts the
   * queue priority-desc.
   */
  private async pauseActiveIntoQueue(guildId: string): Promise<void> {
    const subs = this.config.subscriptions[guildId];
    if (!subs?.active) return;
    const cur = subs.active;
    const nowIso = new Date().toISOString();
    const now = Date.now();

    let remaining: number | null;
    if (cur.endDate === null) {
      remaining = null; // lifetime
    } else {
      remaining = Math.max(0, Math.ceil((Date.parse(cur.endDate) - now) / DAY_MS));
    }
    if (remaining === 0) {
      // Nothing left: drop outright instead of queueing.
      delete subs.active;
      return;
    }

    const paused: Subscription = {
      ...cur,
      status: 'paused',
      pausedAt: nowIso,
      remainingDaysAtPause: remaining,
      updatedAt: nowIso,
    };
    subs.paused.push(paused);
    this.sortPausedQueue(subs);
    delete subs.active;

    // Best-effort provider pause for paid subs.
    if (paused.source === 'paid' && paused.providerId && paused.providerSubId) {
      const provider = getPaymentRegistry().get(paused.providerId);
      if (provider?.pauseSubscription && provider.capabilities.supportsPause) {
        try { await provider.pauseSubscription(paused.providerSubId, null); }
        catch (err: any) {
          console.warn(`[PremiumManager] provider pauseSubscription failed for '${paused.providerId}': ${err?.message || err}`);
        }
      }
    }
    this.writeAudit({
      timestamp: nowIso,
      actor: 'admin',
      action: 'subscription.pause',
      guildId,
      subscriptionId: paused.id,
      providerId: paused.providerId,
    });
    if (paused.source === 'paid') {
      void dispatchPremiumNotification(guildId, 'paid.sub.paused-by-stacking', {
        tierName: this.config.tiers[paused.tierId]?.displayName || paused.tierId,
        providerName: this.providerDisplayName(paused.providerId),
        remainingDays: paused.remainingDaysAtPause ?? null,
      });
    }
  }

  /**
   * Sort the paused queue priority-desc, with manual winning over paid at
   * equal priority (so manual resumes first when the active slot frees up).
   */
  private sortPausedQueue(subs: GuildSubscriptions): void {
    subs.paused.sort((a, b) => {
      const pa = this.config.tiers[a.tierId]?.priority ?? 0;
      const pb = this.config.tiers[b.tierId]?.priority ?? 0;
      if (pa !== pb) return pb - pa;
      if (a.source === 'manual' && b.source !== 'manual') return -1;
      if (b.source === 'manual' && a.source !== 'manual') return 1;
      return 0;
    });
  }

  /**
   * If the active slot is empty and the paused queue is non-empty, pop the
   * highest-priority entry, stamp fresh dates from its remaining-days
   * snapshot, and install as active. For paid subs, call provider.resumeSub
   * fire-and-forget (cache is authoritative; provider state catches up).
   *
   * Repeats if the popped entry is itself already past its endDate (lossy
   * pauses can race expiry).
   */
  private resumeNext(guildId: string): void {
    const subs = this.config.subscriptions[guildId];
    if (!subs) return;
    while (!subs.active && subs.paused.length > 0) {
      const next = subs.paused.shift()!;
      const nowIso = new Date().toISOString();
      const newEndDate: string | null = next.remainingDaysAtPause == null
        ? null
        : new Date(Date.now() + next.remainingDaysAtPause * DAY_MS).toISOString();

      const resumed: Subscription = {
        ...next,
        startDate: nowIso,
        endDate: newEndDate,
        status: 'active',
        updatedAt: nowIso,
        pausedAt: undefined,
        remainingDaysAtPause: undefined,
        resumesAtHint: undefined,
      };
      // Past-endDate after restoration would mean 0 remaining-days at pause:
      // skip and try the next one. Use the right action verb per source so
      // the audit trail doesn't mislabel a manual expiry as paid.
      if (resumed.endDate !== null && Date.parse(resumed.endDate) <= Date.now()) {
        this.writeAudit({
          timestamp: nowIso,
          actor: 'admin',
          action: resumed.source === 'manual'
            ? 'subscription.revoke.manual'
            : 'subscription.expire.paid',
          guildId,
          subscriptionId: resumed.id,
          providerId: resumed.providerId,
          metadata: { reason: 'expired-while-queued' },
        });
        // The user already got a "paused-by-stacking" notification when this
        // entry went into the queue; it never resumes, so close the loop with
        // an "ended" notification matching its source.
        if (resumed.source === 'manual') {
          void dispatchPremiumNotification(guildId, 'manual.grant.ended', {
            tierName: this.config.tiers[resumed.tierId]?.displayName || resumed.tierId,
          });
        } else {
          void dispatchPremiumNotification(guildId, 'paid.sub.expired', {
            tierName: this.config.tiers[resumed.tierId]?.displayName || resumed.tierId,
            providerName: this.providerDisplayName(resumed.providerId),
          });
        }
        continue;
      }
      subs.active = resumed;

      // Best-effort provider resume for paid subs.
      if (resumed.source === 'paid' && resumed.providerId && resumed.providerSubId) {
        const provider = getPaymentRegistry().get(resumed.providerId);
        if (provider?.resumeSubscription && provider.capabilities.supportsPause) {
          provider.resumeSubscription(resumed.providerSubId, newEndDate).catch((err: any) => {
            console.warn(`[PremiumManager] provider resumeSubscription failed for '${resumed.providerId}': ${err?.message || err}`);
          });
        }
      }
      this.writeAudit({
        timestamp: nowIso,
        actor: 'admin',
        action: 'subscription.resume',
        guildId,
        subscriptionId: resumed.id,
        providerId: resumed.providerId,
      });
      if (resumed.source === 'paid') {
        void dispatchPremiumNotification(guildId, 'paid.sub.resumed-from-queue', {
          tierName: this.config.tiers[resumed.tierId]?.displayName || resumed.tierId,
          providerName: this.providerDisplayName(resumed.providerId),
          endDate: resumed.endDate,
        });
      }
      break;
    }
  }

  // ============================================================================
  // MANUAL SUBSCRIPTIONS
  // ============================================================================

  /**
   * Grant a manual subscription. Routes through stacking insertion: if active
   * is higher priority, manual goes to paused queue; if active is lower,
   * manual takes the active slot; same priority manual replaces (manual wins ties).
   */
  async grantManual(
    guildId: string,
    tierId: string,
    durationDays: number | null,
    notes?: string,
    grantedBy?: string,
  ): Promise<boolean> {
    this.ensureLoaded();
    if (tierId === 'free' || !this.config.tiers[tierId]) return false;
    const tier = this.config.tiers[tierId];

    const nowIso = new Date().toISOString();
    const endDate = durationDays === null ? null : new Date(Date.now() + durationDays * DAY_MS).toISOString();

    const sub: Subscription = {
      id: newSubscriptionId(),
      tierId,
      source: 'manual',
      startDate: nowIso,
      endDate,
      autoRenew: false,
      status: 'active',
      notes,
      grantedBy,
      purchasedSnapshot: {
        offeringLabel: '',
        variantLabel: '',
        amount: 0,
        currency: '',
        durationDays,
        tierDisplayName: tier.displayName,
        tierPriority: tier.priority,
        purchasedAt: nowIso,
      },
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await this.installSubscription(guildId, sub);
    this.writeAudit({
      timestamp: nowIso,
      actor: 'admin',
      action: 'subscription.grant.manual',
      guildId,
      tierId,
      subscriptionId: sub.id,
      metadata: { durationDays, notes, grantedBy },
    });
    void dispatchPremiumNotification(guildId, 'manual.grant.added', {
      tierName: tier.displayName,
      endDate,
      notes,
    });
    return true;
  }

  /**
   * Add days to the active manual sub's endDate. No-op for lifetime manual.
   * Doesn't touch paused-queue manuals (those don't tick yet).
   */
  extendManual(guildId: string, addDays: number): boolean {
    this.ensureLoaded();
    const subs = this.config.subscriptions[guildId];
    const active = subs?.active;
    if (!active || active.source !== 'manual') return false;
    if (active.endDate === null) return true;

    const before = active.endDate;
    const base = Math.max(Date.parse(active.endDate), Date.now());
    active.endDate = new Date(base + addDays * DAY_MS).toISOString();
    active.updatedAt = new Date().toISOString();
    if (active.status === 'expired' && Date.parse(active.endDate) > Date.now()) {
      active.status = 'active';
    }
    const ok = this.save();
    if (ok) {
      this.writeAudit({
        timestamp: new Date().toISOString(),
        actor: 'admin',
        action: 'subscription.extend.manual',
        guildId,
        subscriptionId: active.id,
        metadata: { addDays, before, after: active.endDate },
      });
    }
    return ok;
  }

  /**
   * Revoke the manual subscription entirely (active OR paused). Resumes the
   * next paused entry into the active slot if active was the manual.
   */
  revokeManual(guildId: string): boolean {
    this.ensureLoaded();
    const subs = this.config.subscriptions[guildId];
    if (!subs) return true;

    let removed: Subscription | null = null;
    if (subs.active?.source === 'manual') {
      removed = subs.active;
      delete subs.active;
      this.resumeNext(guildId);
    } else {
      const idx = subs.paused.findIndex(p => p.source === 'manual');
      if (idx >= 0) {
        removed = subs.paused[idx];
        subs.paused.splice(idx, 1);
      }
    }
    if (this.guildSubsEmpty(subs)) delete this.config.subscriptions[guildId];

    const ok = this.save();
    if (ok && removed) {
      this.writeAudit({
        timestamp: new Date().toISOString(),
        actor: 'admin',
        action: 'subscription.revoke.manual',
        guildId,
        tierId: removed.tierId,
        subscriptionId: removed.id,
      });
      void dispatchPremiumNotification(guildId, 'manual.grant.revoked', {
        tierName: this.config.tiers[removed.tierId]?.displayName || removed.tierId,
      });
    }
    return ok;
  }

  // ============================================================================
  // PAID SUBSCRIPTIONS
  // ============================================================================

  /**
   * Initiate a paid subscription. Sync providers (Dummy) install inline;
   * async providers (Stripe / LS / PayPal) return a redirect/handoff URL and
   * install via `subscription.created` after the webhook arrives.
   */
  async initiatePaidSubscription(
    guildId: string,
    tierId: string,
    offeringId: string,
    opts: { providerId: string; variantId: string; couponCode?: string; userId?: string; autoRenewOptOut?: boolean },
  ): Promise<InitiateResult> {
    this.ensureLoaded();
    const tier = this.config.tiers[tierId];
    if (!tier) throw new Error(`Tier '${tierId}' does not exist`);
    if (tierId === 'free') throw new Error('Cannot subscribe to the free tier');

    const offering = tier.offerings.find(o => o.id === offeringId);
    if (!offering) throw new Error(`Offering '${offeringId}' not found on tier '${tierId}'`);

    const providerId = opts.providerId;
    if (!providerId) throw new Error('providerId is required');
    if (!opts.variantId) throw new Error('variantId is required');

    const link = offering.providerLinks.find(l => l.providerId === providerId);
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

    // Pre-flight orphan check: refuse if the provider already has an
    // unknown sub for this guild.
    if (provider.listSubscriptionsForGuild) {
      try {
        const orphans = await provider.listSubscriptionsForGuild(guildId);
        const known = this.knownProviderSubIds(guildId);
        const truly = orphans.filter(r => !known.has(`${providerId}:${r.providerSubId}`));
        if (truly.length > 0) {
          const ids = truly.map(r => r.providerSubId).join(', ');
          throw new Error(
            `Provider '${providerId}' already has ${truly.length} subscription(s) for this guild that aren't tracked locally (${ids}). ` +
            `Adopt or cancel them in the Subscriptions panel before starting a new one.`,
          );
        }
      } catch (err: any) {
        if (err?.message?.startsWith(`Provider '${providerId}' already has`)) throw err;
        console.warn(`[PremiumManager] orphan pre-flight failed for '${providerId}' guild ${guildId}: ${err?.message || err}`);
      }
    }

    // Coupon pre-validation via the provider (provider is source of truth).
    let couponValidation: ProviderCouponValidation | undefined;
    if (opts.couponCode) {
      if (!provider.capabilities.supportsCoupons) {
        throw new Error(`Provider '${providerId}' does not accept coupons`);
      }
      if (!provider.validateCoupon) {
        throw new Error(`Provider '${providerId}' declared coupon support but does not implement validateCoupon`);
      }
      couponValidation = await provider.validateCoupon(opts.couponCode, opts.variantId);
      if (!couponValidation.valid) {
        throw new Error(`Coupon invalid: ${couponValidation.reason || 'not accepted'}`);
      }
    }

    // Stacking conflict check: same-priority paid is rejected.
    const newPriority = tier.priority;
    const guildSubs = this.config.subscriptions[guildId];
    const conflictingExisting = [
      guildSubs?.active,
      ...(guildSubs?.paused || []),
    ].find((s): s is Subscription => {
      if (!s) return false;
      if (s.source !== 'paid') return false;
      const exPriority = this.config.tiers[s.tierId]?.priority ?? 0;
      return exPriority === newPriority;
    });
    if (conflictingExisting) {
      const existingName = this.config.tiers[conflictingExisting.tierId]?.displayName || conflictingExisting.tierId;
      const newName = tier.displayName;
      const sameTier = conflictingExisting.tierId === tierId;
      throw new Error(
        sameTier
          ? `You already have a '${existingName}' subscription. ` +
            `Cancel or let the existing one expire first.`
          : `You already have a '${existingName}' subscription at the same priority as '${newName}'. ` +
            `Stacking requires distinct priorities: cancel or let the existing one expire first.`,
      );
    }

    // Auto-renew intent: respect variant.recurring, force-flag, opt-out.
    const variant = link.cache?.variants.find(v => v.variantId === opts.variantId)
      || (provider.fetchVariant ? await provider.fetchVariant(opts.variantId).catch(() => null) : null);
    const recurring = !!variant?.recurring;
    const autoRenewIntent = recurring
      ? (offering.forceAutoRenew ? true : !opts.autoRenewOptOut)
      : false;

    // Compute startPausedUntil if going into paused queue (lower priority than active).
    const active = guildSubs?.active;
    const activeAlive = active
      && active.status === 'active'
      && (active.endDate === null || Date.parse(active.endDate) > Date.now());
    const willGoToQueue = activeAlive && (this.config.tiers[active!.tierId]?.priority ?? 0) > newPriority;
    const startPausedUntil = willGoToQueue ? active!.endDate : undefined;

    const result = await provider.initiatePurchase({
      guildId,
      tierId,
      offeringId,
      variantId: opts.variantId,
      autoRenew: autoRenewIntent,
      couponCode: opts.couponCode,
      userId: opts.userId,
      startPausedUntil,
    });

    // Sync providers (Dummy) fill state and providerSubId; install inline.
    if (result.state && result.providerSubId) {
      const nowIso = new Date().toISOString();
      const variantSnapshot = result.variantSnapshot || variant || null;
      const sub: Subscription = {
        id: newSubscriptionId(),
        tierId,
        source: 'paid',
        offeringId,
        variantId: opts.variantId,
        providerId,
        providerSubId: result.providerSubId,
        providerMeta: result.state.meta,
        purchasedSnapshot: this.buildPurchasedSnapshot(tier, offering, variantSnapshot, providerId),
        startDate: result.state.startDate,
        endDate: result.state.endDate,
        autoRenew: result.state.autoRenew,
        status: result.state.status === 'expired' ? 'expired'
          : result.state.status === 'paused' ? 'paused'
          : 'active',
        couponCode: opts.couponCode,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await this.installSubscription(guildId, sub);
      this.writeAudit({
        timestamp: nowIso,
        actor: 'admin',
        action: 'subscription.install.paid',
        guildId,
        tierId,
        offeringId,
        providerId,
        subscriptionId: sub.id,
        metadata: { variantId: opts.variantId, couponCode: opts.couponCode },
      });
      void dispatchPremiumNotification(guildId, 'paid.sub.started', {
        tierName: tier.displayName,
        providerName: this.providerDisplayName(providerId),
        endDate: sub.endDate,
      });
    }

    return result;
  }

  /**
   * Soft-cancel the active paid sub (autoRenew off, keeps remaining days).
   * Provider's own state is the source of truth; webhook will eventually
   * reflect the change. We propagate provider errors so the UI shows the
   * actual cause instead of a false-positive success.
   */
  async cancelPaidSubscription(guildId: string): Promise<boolean> {
    this.ensureLoaded();
    const active = this.config.subscriptions[guildId]?.active;
    if (!active || active.source !== 'paid') return false;
    if (!active.providerId || !active.providerSubId) return false;
    const provider = getPaymentRegistry().get(active.providerId);
    if (!provider?.cancelSubscription || !provider.capabilities.supportsCancel) return false;
    await provider.cancelSubscription(active.providerSubId);
    this.writeAudit({
      timestamp: new Date().toISOString(),
      actor: 'admin',
      action: 'subscription.cancel.paid',
      guildId,
      subscriptionId: active.id,
      providerId: active.providerId,
      metadata: { immediately: false },
    });
    void dispatchPremiumNotification(guildId, 'paid.sub.cancelled-by-user', {
      tierName: this.config.tiers[active.tierId]?.displayName || active.tierId,
      providerName: this.providerDisplayName(active.providerId),
      endDate: active.endDate,
    });
    return true;
  }

  /** Reactivate a cancelled paid sub while still inside its active window. */
  async reactivatePaidSubscription(guildId: string): Promise<boolean> {
    this.ensureLoaded();
    const active = this.config.subscriptions[guildId]?.active;
    if (!active || active.source !== 'paid') return false;
    if (!active.providerId || !active.providerSubId) return false;
    if (active.status !== 'active') return false;
    if (active.endDate !== null && Date.parse(active.endDate) <= Date.now()) return false;
    const provider = getPaymentRegistry().get(active.providerId);
    if (!provider?.reactivateSubscription || !provider.capabilities.supportsReactivate) return false;
    await provider.reactivateSubscription(active.providerSubId);
    this.writeAudit({
      timestamp: new Date().toISOString(),
      actor: 'admin',
      action: 'subscription.reactivate.paid',
      guildId,
      subscriptionId: active.id,
      providerId: active.providerId,
    });
    return true;
  }

  /**
   * Hard-cancel the active paid sub now. Loses remaining days, frees the
   * slot, resumes the next paused entry. Provider call must succeed before
   * we wipe local state.
   */
  async cancelPaidSubscriptionImmediately(guildId: string): Promise<boolean> {
    this.ensureLoaded();
    const subs = this.config.subscriptions[guildId];
    const active = subs?.active;
    if (!active || active.source !== 'paid') return false;

    if (active.providerId && active.providerSubId) {
      const provider = getPaymentRegistry().get(active.providerId);
      if (provider?.cancelSubscription && provider.capabilities.supportsCancel) {
        await provider.cancelSubscription(active.providerSubId, true);
      }
    }
    this.writeAudit({
      timestamp: new Date().toISOString(),
      actor: 'admin',
      action: 'subscription.cancel.paid',
      guildId,
      subscriptionId: active.id,
      providerId: active.providerId,
      metadata: { immediately: true },
    });
    void dispatchPremiumNotification(guildId, 'paid.sub.cancelled-by-user', {
      tierName: this.config.tiers[active.tierId]?.displayName || active.tierId,
      providerName: this.providerDisplayName(active.providerId),
    });
    delete subs!.active;
    if (subs!.paused.length > 0) this.resumeNext(guildId);
    if (this.guildSubsEmpty(subs!)) delete this.config.subscriptions[guildId];
    return this.save();
  }

  /**
   * Cancel a paused subscription (paid or manual) and remove it from the
   * queue. Provider call must succeed before we drop the queue entry.
   */
  async cancelAndRemovePausedSubscription(guildId: string, subscriptionId: string): Promise<boolean> {
    this.ensureLoaded();
    const subs = this.config.subscriptions[guildId];
    if (!subs?.paused || subs.paused.length === 0) return false;
    const idx = subs.paused.findIndex(p => p.id === subscriptionId);
    if (idx < 0) return false;
    const removed = subs.paused[idx];

    if (removed.source === 'paid' && removed.providerId && removed.providerSubId) {
      const provider = getPaymentRegistry().get(removed.providerId);
      if (provider?.cancelSubscription && provider.capabilities.supportsCancel) {
        await provider.cancelSubscription(removed.providerSubId, true);
      }
    }

    subs.paused.splice(idx, 1);
    if (this.guildSubsEmpty(subs)) delete this.config.subscriptions[guildId];
    this.writeAudit({
      timestamp: new Date().toISOString(),
      actor: 'admin',
      action: removed.source === 'manual' ? 'subscription.revoke.manual' : 'subscription.cancel.paid',
      guildId,
      subscriptionId: removed.id,
      providerId: removed.providerId,
      metadata: { fromPausedQueue: true },
    });
    return this.save();
  }

  // ============================================================================
  // ORPHANS
  // ============================================================================

  private knownProviderSubIds(guildId: string): Set<string> {
    const subs = this.config.subscriptions[guildId];
    const ids = new Set<string>();
    if (subs?.active?.providerSubId && subs.active.providerId) {
      ids.add(`${subs.active.providerId}:${subs.active.providerSubId}`);
    }
    for (const p of subs?.paused || []) {
      if (p.providerSubId && p.providerId) {
        ids.add(`${p.providerId}:${p.providerSubId}`);
      }
    }
    return ids;
  }

  async findOrphansForGuild(guildId: string): Promise<Array<{ providerId: string; ref: ProviderSubscriptionRef }>> {
    this.ensureLoaded();
    const known = this.knownProviderSubIds(guildId);
    const out: Array<{ providerId: string; ref: ProviderSubscriptionRef }> = [];
    for (const provider of getPaymentRegistry().listAll()) {
      if (!provider.listSubscriptionsForGuild) continue;
      if (!provider.isConfigured()) continue;
      try {
        const refs = await provider.listSubscriptionsForGuild(guildId);
        for (const ref of refs) {
          if (!known.has(`${provider.id}:${ref.providerSubId}`)) {
            out.push({ providerId: provider.id, ref });
          }
        }
      } catch (err: any) {
        console.warn(`[PremiumManager] '${provider.id}' listSubscriptionsForGuild failed for guild ${guildId}: ${err?.message || err}`);
      }
    }
    return out;
  }

  async adoptOrphan(guildId: string, providerId: string, providerSubId: string): Promise<boolean> {
    this.ensureLoaded();
    const provider = getPaymentRegistry().get(providerId);
    if (!provider?.listSubscriptionsForGuild) {
      throw new Error(`Provider '${providerId}' does not support orphan listing.`);
    }
    const refs = await provider.listSubscriptionsForGuild(guildId);
    const ref = refs.find(r => r.providerSubId === providerSubId);
    if (!ref) {
      throw new Error(`Subscription '${providerSubId}' not found at '${providerId}' for guild ${guildId}.`);
    }
    if (this.knownProviderSubIds(guildId).has(`${providerId}:${providerSubId}`)) {
      throw new Error(`Subscription '${providerSubId}' is already in the local cache.`);
    }
    if (!ref.metadata.tierId || !ref.metadata.offeringId) {
      throw new Error(
        `Subscription '${providerSubId}' is missing tierId/offeringId metadata so the bot can't tell what to install. ` +
        `Cancel it at the provider instead.`,
      );
    }

    getPaymentRegistry().emitEvent({
      type: 'subscription.created',
      providerId,
      providerSubId,
      guildId,
      tierId: ref.metadata.tierId,
      offeringId: ref.metadata.offeringId,
      variantId: ref.metadata.variantId,
      couponCode: ref.metadata.couponCode,
      state: ref.state,
    });
    this.writeAudit({
      timestamp: new Date().toISOString(),
      actor: 'admin',
      action: 'subscription.adopt.orphan',
      guildId,
      providerId,
      metadata: { providerSubId, tierId: ref.metadata.tierId, offeringId: ref.metadata.offeringId },
    });
    return true;
  }

  async cancelOrphan(providerId: string, providerSubId: string): Promise<boolean> {
    const provider = getPaymentRegistry().get(providerId);
    if (!provider) throw new Error(`Provider '${providerId}' is not registered.`);
    if (!provider.cancelSubscription || !provider.capabilities.supportsCancel) {
      throw new Error(`Provider '${providerId}' does not support cancellation.`);
    }
    await provider.cancelSubscription(providerSubId, true);
    this.writeAudit({
      timestamp: new Date().toISOString(),
      actor: 'admin',
      action: 'subscription.cancel.orphan',
      providerId,
      metadata: { providerSubId },
    });
    return true;
  }

  // ============================================================================
  // QUERY
  // ============================================================================

  getSubscriptions(guildId: string): GuildSubscriptions {
    this.ensureLoaded();
    const subs = this.config.subscriptions[guildId];
    return subs ? { ...subs } : { paused: [] };
  }

  getAllSubscriptions(): Record<string, GuildSubscriptions> {
    this.ensureLoaded();
    return JSON.parse(JSON.stringify(this.config.subscriptions));
  }

  /** Read-only snapshot of one guild's subscription record (or null if none). */
  getGuildSubscriptions(guildId: string): GuildSubscriptions | null {
    this.ensureLoaded();
    const subs = this.config.subscriptions[guildId];
    return subs ? JSON.parse(JSON.stringify(subs)) : null;
  }

  /**
   * Set the per-guild notifications channel id (the fallback when DM to the
   * owner fails). Pass empty string / null to clear and fall back to the
   * guild's system channel. Persists immediately. Returns true on write,
   * false if the guild has no subscription record yet AND the new value
   * is empty (no point creating an empty record).
   */
  setNotificationsChannelId(guildId: string, channelId: string | null): boolean {
    this.ensureLoaded();
    const next = (channelId && channelId.trim()) ? channelId.trim() : undefined;
    const subs = this.config.subscriptions[guildId];
    if (!subs && !next) return false;
    if (!subs) {
      this.config.subscriptions[guildId] = { paused: [], notificationsChannelId: next };
    } else if (next) {
      subs.notificationsChannelId = next;
    } else {
      delete subs.notificationsChannelId;
      if (this.guildSubsEmpty(subs)) delete this.config.subscriptions[guildId];
    }
    return this.save();
  }

  // ============================================================================
  // OVERRIDES & FEATURE GATES (unchanged from prior model)
  // ============================================================================

  /**
   * Effective overrides for a guild + module: Global / Free baseline merged
   * with the guild's active paid tier delta (if any). Storage source for
   * the baseline is `/data/global/{module}/settings.json` (the System
   * Panel's data); paid tier deltas live in `premium-tiers.json` under
   * `tiers.{paidId}.overrides[module]`. Free guilds get baseline only.
   *
   * `_hardLimits` is merged key-by-key (paid wins on overlap). Other keys
   * (`_moduleEnabled`, `_disabledCommands`, setting values) follow the same
   * "paid wins" rule via object spread.
   */
  getTierOverrides(guildId: string, moduleName: string): Record<string, any> {
    const { tierId } = this.resolveActiveTier(guildId);
    const baseline = freeBaselineFromGlobal(loadGlobalModuleConfig(moduleName));
    if (tierId === 'free') return baseline;
    const effectiveFree = effectiveFreeModuleOverride(baseline);
    const tier = this.config.tiers[tierId];
    const tierMod = tier?.overrides?.[moduleName] || {};
    const merged: Record<string, any> = { ...effectiveFree, ...tierMod };
    if (effectiveFree._hardLimits || tierMod._hardLimits) {
      merged._hardLimits = {
        ...(effectiveFree._hardLimits || {}),
        ...(tierMod._hardLimits || {}),
      };
    }
    return merged;
  }

  getTierHardLimits(guildId: string, moduleName: string): Record<string, HardLimitOverride> {
    const overrides = this.getTierOverrides(guildId, moduleName);
    const hl = overrides._hardLimits;
    if (hl && typeof hl === 'object' && !Array.isArray(hl)) {
      return hl as Record<string, HardLimitOverride>;
    }
    return {};
  }

  /**
   * Raw paid-tier delta for a guild + module. Returns ONLY the paid tier's
   * own `overrides[moduleName]` payload (without merging the Global / Free
   * baseline). Free guilds (or guilds with no active sub) return `{}`.
   *
   * Use this when you need to distinguish "value came from the host's
   * deployment baseline" from "value came from the paid tier's delta" -
   * for example, the settings panel source-labeling in
   * `loadModuleSettings`. Most consumers want the merged result; use
   * `getTierOverrides` for that.
   */
  getPaidTierDelta(guildId: string, moduleName: string): Record<string, any> {
    const { tierId } = this.resolveActiveTier(guildId);
    if (tierId === 'free') return {};
    const tier = this.config.tiers[tierId];
    const delta = tier?.overrides?.[moduleName];
    return delta ? { ...delta } : {};
  }

  hasFeatureAccess(guildId: string, requiredPriority: number): boolean {
    const { tier } = this.resolveActiveTier(guildId);
    return tier.priority >= requiredPriority;
  }

  hasFeature(guildId: string, moduleName: string, featureName: string): boolean {
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
  // PROVIDER ACCOUNT LINKS (anti-duplicate registry)
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
  // EXPIRY CHECKER (manual layer + active-slot endDate watch)
  // ============================================================================

  startExpiryChecker(intervalMs = 60_000): void {
    if (this.expiryTimer) return;
    this.expiryTimer = setInterval(() => {
      this.checkExpiry();
      void this.processDueMigrations().catch(err => {
        console.error('[PremiumManager] processDueMigrations failed:', err);
      });
    }, intervalMs);
  }

  stopExpiryChecker(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  /**
   * Walk every guild's active slot. Two passes:
   *
   * 1. **Expiry**: if active is past endDate AND it's a manual sub (paid
   *    expiries flow through provider events), expire it, pop the next
   *    paused entry into active, fire a `manual.grant.ended` notification.
   *
   * 2. **Ending-soon**: if active is a manual sub whose endDate is within
   *    the next 24 hours and we haven't already warned about this sub,
   *    fire a `manual.grant.ending-soon` notification and remember the
   *    sub id so the ticker doesn't re-warn every minute.
   *
   * The dedupe set is also pruned to drop entries whose subs are no
   * longer active anywhere; the natural cleanup point is the expiry
   * branch above and a final sweep at the end.
   */
  private checkExpiry(): void {
    this.ensureLoaded();
    let changed = false;
    const now = Date.now();
    const nowIso = new Date().toISOString();
    const ENDING_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;
    const stillActiveIds = new Set<string>();
    for (const guildId of Object.keys(this.config.subscriptions)) {
      const subs = this.config.subscriptions[guildId];
      const active = subs.active;
      if (!active) continue;
      if (active.endDate === null) continue;
      const endMs = Date.parse(active.endDate);

      if (endMs <= now) {
        if (active.source !== 'manual') continue; // paid expiries via webhook

        const tierName = this.config.tiers[active.tierId]?.displayName || active.tierId;
        const expiredId = active.id;
        const expiredNotes = active.notes;
        active.status = 'expired';
        active.updatedAt = nowIso;
        changed = true;
        this.writeAudit({
          timestamp: nowIso,
          actor: 'admin',
          action: 'subscription.revoke.manual',
          guildId,
          subscriptionId: active.id,
          metadata: { reason: 'expired' },
        });
        void dispatchPremiumNotification(guildId, 'manual.grant.ended', {
          tierName,
          notes: expiredNotes,
        });
        this.endingSoonNotified.delete(expiredId);
        delete subs.active;
        if (subs.paused.length > 0) this.resumeNext(guildId);
        if (this.guildSubsEmpty(subs)) delete this.config.subscriptions[guildId];
        continue;
      }

      // Future expiry: ending-soon window check (manual only - paid renews
      // automatically, and cancel-before-expiry already triggers its own
      // notification at cancel time).
      if (active.source !== 'manual') continue;
      stillActiveIds.add(active.id);
      if (endMs - now > ENDING_SOON_WINDOW_MS) continue;
      if (this.endingSoonNotified.has(active.id)) continue;
      this.endingSoonNotified.add(active.id);
      void dispatchPremiumNotification(guildId, 'manual.grant.ending-soon', {
        tierName: this.config.tiers[active.tierId]?.displayName || active.tierId,
        endDate: active.endDate,
      });
    }
    // Sweep dedupe set: drop ids that no longer correspond to an active
    // manual sub anywhere (revoked, queue-pop replaced active, etc.).
    for (const id of this.endingSoonNotified) {
      if (!stillActiveIds.has(id)) this.endingSoonNotified.delete(id);
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
    const before = { ...this.config.messages };
    this.config.messages = { ...this.config.messages, ...partial };
    const ok = this.save();
    if (ok) {
      this.writeAudit({
        timestamp: new Date().toISOString(),
        actor: 'admin',
        action: 'message.update',
        before,
        after: this.config.messages,
      });
    }
    return ok;
  }

  resetMessages(): boolean {
    this.ensureLoaded();
    const before = { ...this.config.messages };
    this.config.messages = { ...DEFAULT_MESSAGES };
    const ok = this.save();
    if (ok) {
      this.writeAudit({
        timestamp: new Date().toISOString(),
        actor: 'admin',
        action: 'message.update',
        before,
        after: this.config.messages,
        metadata: { reset: true },
      });
    }
    return ok;
  }

  /**
   * Resolve the URL to a guild's subscription page on the bot's web-UI.
   * Returns null when WEBUI_BASE_URL is not configured - callers should
   * gracefully omit the upgrade button in that case rather than show a
   * broken link.
   */
  getGuildSubscriptionUrl(guildId: string): string | null {
    const baseUrl = (process.env.WEBUI_BASE_URL || '').trim();
    if (!baseUrl) return null;
    return `${baseUrl.replace(/\/$/, '')}/guild/${encodeURIComponent(guildId)}/subscription`;
  }

  // ============================================================================
  // FULL CONFIG (admin)
  // ============================================================================

  // ============================================================================
  // MIGRATIONS (Stage 5)
  // ============================================================================

  listMigrations(): Migration[] {
    this.ensureLoaded();
    return JSON.parse(JSON.stringify(this.config.migrations));
  }

  getMigration(migrationId: string): Migration | null {
    this.ensureLoaded();
    const m = this.config.migrations.find(x => x.id === migrationId);
    return m ? JSON.parse(JSON.stringify(m)) : null;
  }

  /** Pending migrations that affect this guild (source variant matches a
   * sub the guild owns and migration is still pending). */
  getPendingMigrationsForGuild(guildId: string): Migration[] {
    this.ensureLoaded();
    return this.config.migrations
      .filter(m => m.status === 'pending')
      .filter(m => m.decisions.some(d => d.guildId === guildId))
      .map(m => JSON.parse(JSON.stringify(m)));
  }

  getMigrationSilencePolicy(): 'cancel' | 'continue' {
    this.ensureLoaded();
    return this.config.migrationSilencePolicy;
  }

  setMigrationSilencePolicy(policy: 'cancel' | 'continue'): boolean {
    this.ensureLoaded();
    if (policy !== 'cancel' && policy !== 'continue') return false;
    const before = this.config.migrationSilencePolicy;
    if (before === policy) return true;
    this.config.migrationSilencePolicy = policy;
    const ok = this.save();
    if (ok) {
      this.writeAudit({
        timestamp: new Date().toISOString(),
        actor: 'admin',
        action: 'migration.silence-policy.set',
        before,
        after: policy,
      });
    }
    return ok;
  }

  /**
   * Schedule a price/variant migration. Snapshots current paid subs whose
   * (providerId, sourceVariantId) matches into per-guild decision records;
   * each guild owner gets a `migration.scheduled` DM with accept/decline
   * tokens.
   *
   * Validation:
   *   - target must differ from source on at least variant
   *   - effectiveDate must parse as a future date
   *   - source variant + target variant + provider must all exist on registered offerings
   *
   * Returns the new Migration on success. Throws Error on validation failure.
   */
  async scheduleMigration(opts: {
    providerId: string;
    sourceTierId: string;
    sourceOfferingId: string;
    sourceVariantId: string;
    targetTierId: string;
    targetOfferingId: string;
    targetVariantId: string;
    effectiveDate: string;
    message: string;
    scheduledBy?: string;
  }): Promise<Migration> {
    this.ensureLoaded();
    if (opts.sourceVariantId === opts.targetVariantId
      && opts.sourceOfferingId === opts.targetOfferingId
      && opts.sourceTierId === opts.targetTierId) {
      throw new Error('Source and target are identical; nothing to migrate.');
    }
    const eff = Date.parse(opts.effectiveDate);
    if (!Number.isFinite(eff)) throw new Error('effectiveDate is not a valid timestamp.');
    if (eff <= Date.now()) throw new Error('effectiveDate must be in the future.');

    const provider = getPaymentRegistry().get(opts.providerId);
    if (!provider) throw new Error(`Provider '${opts.providerId}' is not registered.`);
    if (!provider.capabilities.supportsPriceMigration || !provider.migrateSubscriptionPrice) {
      throw new Error(`Provider '${opts.providerId}' does not support price migration.`);
    }

    const sourceTier = this.config.tiers[opts.sourceTierId];
    const targetTier = this.config.tiers[opts.targetTierId];
    if (!sourceTier || !targetTier) throw new Error('Unknown source or target tier.');
    const sourceOffering = sourceTier.offerings.find(o => o.id === opts.sourceOfferingId);
    const targetOffering = targetTier.offerings.find(o => o.id === opts.targetOfferingId);
    if (!sourceOffering || !targetOffering) throw new Error('Unknown source or target offering.');

    const decisions: MigrationGuildDecision[] = [];
    for (const [guildId, subs] of Object.entries(this.config.subscriptions)) {
      const candidates: Subscription[] = [];
      if (subs.active) candidates.push(subs.active);
      candidates.push(...subs.paused);
      for (const sub of candidates) {
        if (sub.source !== 'paid') continue;
        if (sub.providerId !== opts.providerId) continue;
        if (sub.variantId !== opts.sourceVariantId) continue;
        if (!sub.providerSubId) continue;
        decisions.push({
          guildId,
          subscriptionId: sub.id,
          providerSubId: sub.providerSubId,
          decision: 'pending',
        });
      }
    }

    const migration: Migration = {
      id: crypto.randomUUID(),
      providerId: opts.providerId,
      sourceTierId: opts.sourceTierId,
      sourceOfferingId: opts.sourceOfferingId,
      sourceVariantId: opts.sourceVariantId,
      targetTierId: opts.targetTierId,
      targetOfferingId: opts.targetOfferingId,
      targetVariantId: opts.targetVariantId,
      effectiveDate: opts.effectiveDate,
      message: opts.message || '',
      scheduledAt: new Date().toISOString(),
      scheduledBy: opts.scheduledBy || 'admin',
      status: 'pending',
      decisions,
    };
    this.config.migrations.push(migration);
    const ok = this.save();
    if (!ok) throw new Error('Failed to persist migration.');

    this.writeAudit({
      timestamp: migration.scheduledAt,
      actor: migration.scheduledBy,
      action: 'migration.scheduled',
      providerId: opts.providerId,
      tierId: opts.sourceTierId,
      offeringId: opts.sourceOfferingId,
      migrationId: migration.id,
      metadata: {
        targetTierId: opts.targetTierId,
        targetOfferingId: opts.targetOfferingId,
        sourceVariantId: opts.sourceVariantId,
        targetVariantId: opts.targetVariantId,
        effectiveDate: opts.effectiveDate,
        affectedCount: decisions.length,
      },
    });

    // DM each affected guild owner. notifiedAt isn't tracked at delivery
    // time (DM is best-effort and async); we record "we attempted at X".
    const stamped = new Date().toISOString();
    for (const d of migration.decisions) {
      d.notifiedAt = stamped;
      void dispatchPremiumNotification(d.guildId, 'migration.scheduled', {
        tierName: targetTier.displayName,
        endDate: opts.effectiveDate,
        details: opts.message || `Your subscription will move from "${sourceTier.displayName}" to "${targetTier.displayName}". Open the subscription panel to accept or decline.`,
      });
    }
    this.save();

    return JSON.parse(JSON.stringify(migration));
  }

  /**
   * Subscriber records their accept/decline. Idempotent: re-recording the
   * same decision is a no-op; flipping is allowed up until the migration
   * is applied.
   */
  recordMigrationDecision(migrationId: string, guildId: string, decision: 'accepted' | 'declined'): boolean {
    this.ensureLoaded();
    if (decision !== 'accepted' && decision !== 'declined') return false;
    const migration = this.config.migrations.find(m => m.id === migrationId);
    if (!migration) return false;
    if (migration.status !== 'pending') return false;
    const entry = migration.decisions.find(d => d.guildId === guildId);
    if (!entry) return false;
    if (entry.decision === decision) return true;
    entry.decision = decision;
    entry.decidedAt = new Date().toISOString();
    const ok = this.save();
    if (ok) {
      this.writeAudit({
        timestamp: entry.decidedAt,
        actor: 'guild-owner',
        action: 'migration.decision',
        guildId,
        migrationId,
        metadata: { decision },
      });
      const targetTier = this.config.tiers[migration.targetTierId];
      void dispatchPremiumNotification(guildId, decision === 'accepted' ? 'migration.accepted' : 'migration.declined', {
        tierName: targetTier?.displayName || migration.targetTierId,
        endDate: migration.effectiveDate,
      });
    }
    return ok;
  }

  /** Cancel a scheduled migration before it applies. Decisions and the
   * migration record itself are kept (status -> 'cancelled') so the audit
   * trail and any in-flight subscriber UI can still resolve the id. */
  cancelMigration(migrationId: string): boolean {
    this.ensureLoaded();
    const migration = this.config.migrations.find(m => m.id === migrationId);
    if (!migration) return false;
    if (migration.status !== 'pending') return false;
    migration.status = 'cancelled';
    const ok = this.save();
    if (ok) {
      this.writeAudit({
        timestamp: new Date().toISOString(),
        actor: 'admin',
        action: 'migration.cancelled',
        migrationId,
        providerId: migration.providerId,
      });
    }
    return ok;
  }

  /**
   * Scheduler entry point. Walks pending migrations, applies any whose
   * effectiveDate has passed. Per-guild decision drives the action:
   *   accepted        -> provider.migrateSubscriptionPrice(target)
   *   declined        -> provider.cancelSubscription(soft) -> rides out
   *   pending + 'cancel'   -> same as declined
   *   pending + 'continue' -> same as accepted (host accepts compliance burden)
   *
   * Outcomes are recorded per-decision so the audit trail and viewer can
   * surface partial failures. Migration.status flips to 'applied' once
   * all decisions resolve (success or failure).
   */
  async processDueMigrations(): Promise<void> {
    this.ensureLoaded();
    const now = Date.now();
    const due = this.config.migrations.filter(m => m.status === 'pending' && Date.parse(m.effectiveDate) <= now);
    if (due.length === 0) return;
    for (const migration of due) {
      await this.applyMigration(migration);
    }
  }

  private async applyMigration(migration: Migration): Promise<void> {
    const provider = getPaymentRegistry().get(migration.providerId);
    if (!provider || !provider.migrateSubscriptionPrice) {
      // Provider gone since scheduling; mark cancelled rather than apply.
      migration.status = 'cancelled';
      this.save();
      this.writeAudit({
        timestamp: new Date().toISOString(),
        actor: 'system',
        action: 'migration.cancelled',
        migrationId: migration.id,
        providerId: migration.providerId,
        metadata: { reason: 'provider-unavailable' },
      });
      return;
    }
    const targetTier = this.config.tiers[migration.targetTierId];
    const targetOffering = targetTier?.offerings.find(o => o.id === migration.targetOfferingId);
    const policy = this.config.migrationSilencePolicy;
    const stamp = new Date().toISOString();

    for (const decision of migration.decisions) {
      // Skip if guild lost their sub (cancelled before effective date).
      const subs = this.config.subscriptions[decision.guildId];
      if (!subs) {
        decision.outcome = 'skipped';
        decision.outcomeNote = 'guild has no subscriptions';
        decision.appliedAt = stamp;
        continue;
      }
      const allSubs: Subscription[] = [];
      if (subs.active) allSubs.push(subs.active);
      allSubs.push(...subs.paused);
      const sub = allSubs.find(s => s.id === decision.subscriptionId);
      if (!sub) {
        decision.outcome = 'skipped';
        decision.outcomeNote = 'subscription no longer present';
        decision.appliedAt = stamp;
        continue;
      }
      if (sub.providerSubId !== decision.providerSubId) {
        decision.outcome = 'skipped';
        decision.outcomeNote = 'providerSubId changed since scheduling';
        decision.appliedAt = stamp;
        continue;
      }
      if (sub.variantId !== migration.sourceVariantId) {
        decision.outcome = 'skipped';
        decision.outcomeNote = 'variant changed since scheduling';
        decision.appliedAt = stamp;
        continue;
      }

      const effective = decision.decision === 'pending'
        ? (policy === 'continue' ? 'accepted' : 'declined')
        : decision.decision;
      const wasSilent = decision.decision === 'pending';
      if (wasSilent) decision.decision = 'silent-applied';

      try {
        if (effective === 'accepted') {
          await provider.migrateSubscriptionPrice(sub.providerSubId, migration.targetVariantId, 'none');
          // Update local cache to match the new variant. Provider webhooks
          // may also fire and we'll reconcile on top.
          sub.tierId = migration.targetTierId;
          sub.offeringId = migration.targetOfferingId;
          sub.variantId = migration.targetVariantId;
          sub.updatedAt = stamp;
          decision.outcome = 'migrated';
        } else {
          // declined OR silent + 'cancel' policy
          if (provider.cancelSubscription && provider.capabilities.supportsCancel) {
            await provider.cancelSubscription(sub.providerSubId, false);
          }
          sub.autoRenew = false;
          sub.updatedAt = stamp;
          decision.outcome = 'cancelled';
        }
      } catch (err: any) {
        decision.outcome = 'failed';
        decision.outcomeNote = err?.message || String(err);
      }
      decision.appliedAt = stamp;

      // Per-decision notification.
      if (wasSilent) {
        void dispatchPremiumNotification(decision.guildId, 'migration.silence-applied', {
          tierName: targetTier?.displayName || migration.targetTierId,
          details: policy === 'continue' ? 'Migrated to the new plan automatically.' : 'Set to cancel at period end.',
        });
      } else if (decision.outcome === 'migrated') {
        void dispatchPremiumNotification(decision.guildId, 'migration.applied', {
          tierName: targetTier?.displayName || migration.targetTierId,
          providerName: this.providerDisplayName(migration.providerId),
        });
      }
    }

    migration.status = 'applied';
    migration.appliedAt = stamp;
    this.save();
    this.writeAudit({
      timestamp: stamp,
      actor: 'system',
      action: 'migration.applied',
      providerId: migration.providerId,
      migrationId: migration.id,
      tierId: migration.targetTierId,
      offeringId: migration.targetOfferingId,
      metadata: {
        outcomes: migration.decisions.reduce((acc: Record<string, number>, d) => {
          const key = d.outcome || 'unknown';
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {}),
      },
    });
    // Reference targetOffering only to prove it parsed at scheduling - the
    // scheduler doesn't actually need the offering object once the variant
    // change is applied. Touched here so future code can hook in.
    void targetOffering;
  }

  // ============================================================================
  // FULL CONFIG (admin)
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
      migrations: Array.isArray(config.migrations) ? config.migrations : [],
      migrationSilencePolicy: config.migrationSilencePolicy === 'continue' ? 'continue' : 'cancel',
    };
    return this.save();
  }
}

/** Get the singleton PremiumManager instance. */
export function getPremiumManager(): PremiumManager {
  if (!instance) {
    instance = new PremiumManager();
    instance.load();
    // Both bot and forked web-UI process import this singleton, but only
    // the bot should own the expiry ticker. Without this gate, both
    // processes would write the same expiry to disk every minute and DM
    // the user twice for the same `manual.grant.ended` event. Web-UI
    // picks up the bot's writes via mtime reload on each operation.
    if (process.env.BOT_PROCESS_ROLE === 'bot') {
      instance.startExpiryChecker();
    }
  }
  return instance;
}

/** Reset the singleton (for tests). */
export function resetPremiumManager(): void {
  if (instance) instance.dispose();
  instance = null;
}
