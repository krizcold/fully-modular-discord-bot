/**
 * Payment Provider Types
 *
 * Architecture: per-provider mode independence (Price vs Product) + provider
 * as source of truth for prices and coupons. The unified single-active-slot
 * subscription model lives in `premiumManager.ts`; this file defines the
 * provider boundary.
 *
 * Each TierOffering carries an array of ProviderLink. A ProviderLink picks
 * its own mode independently of any other link:
 *
 *   - Price mode: host enters one or more wire-level variant IDs (Stripe
 *     Price ID, LS Variant ID, PayPal Plan ID, Discord SKU). One row per
 *     billing option the host wants to expose. We render the variant picker.
 *
 *   - Product mode: host enters one Product identifier. We pull variants
 *     from the provider's API. Optional toggle hands variant selection off
 *     to the provider's hosted page when the provider supports it (Stripe
 *     Pricing Table, LS hosted checkout).
 */

// ============================================================================
// MECHANISMS + MODES
// ============================================================================

/** How a provider drives the purchase flow. */
export type ProviderMechanism =
  /** Fully server-side, sync return with state (Dummy). */
  | 'immediate'
  /** Server returns a checkout URL; webhook reconciles (Stripe, Lemon Squeezy). */
  | 'redirect'
  /** Purchase happens in a host app; gateway events reconcile (Discord App Monetization). */
  | 'client_handoff'
  /** Guild owner links an external account; we poll pledge (Patreon). */
  | 'oauth_link'
  /** We verify a non-monetary state (Server Boosting). */
  | 'verify_only';

/** Which mode a ProviderLink uses to expose variants to subscribers. */
export type ProviderMode = 'price' | 'product';

// ============================================================================
// PROVIDER LINK + VARIANTS
// ============================================================================

/** A single host-typed variant entry in Price mode. */
export interface PriceModeEntry {
  /** Wire-level identifier: Stripe Price ID, LS Variant ID, PayPal Plan ID, Discord SKU. */
  variantId: string;
  /** Optional admin override for the variant label shown to subscribers. */
  labelOverride?: string;
}

/**
 * Host-curated variant list. Length 1 for providers that only support a
 * single billing option per offering (Discord). The admin UI hides the
 * add/remove controls when `capabilities.supportsMultipleVariants` is false.
 */
export interface PriceModeConfig {
  entries: PriceModeEntry[];
}

/** Single-Product config for Product mode (variants synced from the provider). */
export interface ProductModeConfig {
  /** Wire-level Product identifier: Stripe Product ID, LS Product ID, PayPal Product ID. */
  productId: string;
  /**
   * When true, subscriber sees one "Subscribe via [Provider]" button and the
   * provider's hosted page handles variant selection. Only meaningful when
   * `capabilities.supportsHostedPicker` is true; ignored otherwise.
   */
  useProviderHostedPicker?: boolean;
  /**
   * Optional admin overrides for variant labels, keyed by wire-level
   * variantId. Mirrors `PriceModeEntry.labelOverride` for Price mode.
   * Applied at display time in the offering modal admin UI and the
   * subscribe modal subscriber UI; the cached `OfferingVariant.label`
   * stays as whatever the provider returned. Backend save-time refresh
   * prunes entries whose variantId no longer appears in the synced
   * variants list.
   */
  variantLabelOverrides?: Record<string, string>;
}

/** Variant resolved from the provider (read-only at our end, synced from API). */
export interface OfferingVariant {
  /** Wire-level identifier: Stripe Price ID, LS Variant ID, PayPal Plan ID, Discord SKU. */
  variantId: string;
  /** Provider's name for the variant; can be host-overridden via `PriceModeEntry.labelOverride`. */
  label: string;
  /** Price in minor units (cents). */
  amount: number;
  /** ISO 4217 currency code. */
  currency: string;
  /** null = lifetime / open-ended. */
  durationDays: number | null;
  /** Trial period in days, when the variant has one. */
  trialDays?: number;
  /** False for one-time / lifetime; true for recurring. */
  recurring: boolean;
  /** False when archived at the provider; we still surface it for adopt/cancel paths but hide it from purchase UIs. */
  active: boolean;
}

/** Cached variant data on a ProviderLink, refreshed on demand from the provider. */
export interface ProviderLinkCache {
  /** ISO timestamp of the last successful sync. */
  syncedAt: string;
  variants: OfferingVariant[];
  /** Product mode only: the product's display name from the provider. */
  productLabel?: string;
  /** Product mode only: the product's description from the provider. */
  productDescription?: string;
}

/**
 * A wired provider on an offering. Each link picks its own mode + config.
 * The discriminator is `mode`: when 'price', `priceConfig` is populated;
 * when 'product', `productConfig` is populated.
 */
export interface ProviderLink {
  providerId: string;
  enabled: boolean;
  mode: ProviderMode;
  priceConfig?: PriceModeConfig;
  productConfig?: ProductModeConfig;
  cache?: ProviderLinkCache;
}

// ============================================================================
// CAPABILITIES
// ============================================================================

/** What a provider supports; drives admin UI affordances and runtime gating. */
export interface ProviderCapabilities {
  /** Server can start the purchase flow. False for Discord App Monetization. */
  canInitiatePurchase: boolean;
  supportsCancel: boolean;
  supportsReactivate: boolean;
  supportsCoupons: boolean;
  /** Provider can pause + resume a subscription (defer billing). */
  supportsPause: boolean;
  /** Price mode: can the host enter >1 wire-level ID per offering? false for Discord. */
  supportsMultipleVariants: boolean;
  /** Does this provider have a Product/grouping concept we can sync from? false for Discord. */
  supportsProductMode: boolean;
  /**
   * (Product mode only) Does the provider host a multi-variant picker we
   * can redirect subscribers to? Stripe + LS yes; PayPal no.
   */
  supportsHostedPicker: boolean;
  /** (When `supportsHostedPicker`) Provider-imposed cap on variants visible on the hosted page; e.g. 3 for Stripe Pricing Table. */
  hostedPickerVariantCap?: number;
  /** Hosted "manage subscription" portal available. */
  supportsCustomerPortal: boolean;
  /** Annual billing supported. False for Discord (monthly only at present). */
  supportsAnnualBilling: boolean;
  /** Can migrate existing subs to a new variant (revise / change price). */
  supportsPriceMigration: boolean;
  mechanism: ProviderMechanism;
  /** Admin UI label for the wire-level ID input in Price mode (e.g. 'Stripe Price ID'). */
  variantIdLabel: string;
  /** Admin UI label for the Product ID input in Product mode (e.g. 'Stripe Product ID'). Empty when `!supportsProductMode`. */
  productIdLabel: string;
}

// ============================================================================
// PROVIDER STATE
// ============================================================================

/** Provider-reported subscription state. */
export interface ProviderSubscriptionState {
  status: 'active' | 'paused' | 'expired' | 'cancelled';
  startDate: string;
  endDate: string | null;
  autoRenew: boolean;
  meta?: Record<string, any>;
}

/**
 * Canonical normalized variant snapshot for cross-provider price comparison.
 * Same shape as `OfferingVariant` but with display affordances; used by
 * provider price-lookup endpoints to validate that a wired ID still points
 * at a real, active product/price.
 */
export interface NormalizedOfferingPrice {
  amount: number;
  currency: string;
  durationDays: number | null;
  autoRenewEligible: boolean;
  display: { amountLabel: string; periodLabel: string };
  externalRef: { id: string; type: string };
}

/**
 * Tolerance-aware equality for two prices on the same offering. Currency and
 * recurring-vs-one-time must match exactly. Amount must match to the cent.
 * Duration uses a +/- 5% window on non-cliff durations (calendar months/years
 * map to 30/365 days respectively).
 */
export function normalizedPricesEquivalent(a: NormalizedOfferingPrice, b: NormalizedOfferingPrice): boolean {
  if (a.currency !== b.currency) return false;
  if (a.amount !== b.amount) return false;
  if (a.autoRenewEligible !== b.autoRenewEligible) return false;
  if (a.durationDays === null || b.durationDays === null) return a.durationDays === b.durationDays;
  const tolerance = Math.max(1, Math.round(Math.max(a.durationDays, b.durationDays) * 0.05));
  return Math.abs(a.durationDays - b.durationDays) <= tolerance;
}

/**
 * Coupon validation result returned from a provider's `validateCoupon`. The
 * provider owns the coupon registry; the bot forwards the user-typed code
 * for pre-checkout preview and again at purchase time.
 */
export interface ProviderCouponValidation {
  valid: boolean;
  /** Short text the UI surfaces (e.g. '20% off', '+7 days', '$5 off'). */
  effectText?: string;
  /** Reason when invalid ('expired', 'used up', 'not found', 'not valid for this variant'). */
  reason?: string;
  /**
   * Provider-internal handle for the coupon (e.g. Stripe `promotion_code` id),
   * passed through to `initiatePurchase` so we don't re-resolve it.
   */
  providerCouponId?: string;
}

// ============================================================================
// PURCHASE I/O
// ============================================================================

/** Input to `initiatePurchase`. */
export interface InitiateOpts {
  guildId: string;
  tierId: string;
  offeringId: string;
  /** Wire-level identifier picked at subscribe time. Provider knows how to interpret. */
  variantId: string;
  /**
   * Caller-decided auto-renew intent. PremiumManager computes this from the
   * variant (`recurring`) and the user's per-purchase opt-out, so providers
   * don't have to know about the opt-out rules. Provider may still refuse
   * (e.g. recurring-only Stripe Price) and return whatever `autoRenew` it
   * actually set on the subscription state.
   */
  autoRenew?: boolean;
  couponCode?: string;
  /** Guild owner triggering; needed for oauth_link / client_handoff flows. */
  userId?: string;
  /**
   * When set, the new subscription starts paused. Used when stacking onto a
   * higher-priority sub: the provider freezes the new sub immediately so it
   * doesn't tick down while waiting for its turn. ISO timestamp; null means
   * indefinite (lifts on explicit resume).
   */
  startPausedUntil?: string | null;
}

/** Result of `initiatePurchase`. Which fields are filled depends on the mechanism. */
export interface InitiateResult {
  /** Filled immediately by `immediate` providers; `null` for async. */
  providerSubId?: string;
  /** `redirect`: user is sent here to complete checkout. */
  redirectUrl?: string;
  /** `client_handoff`: opaque payload (e.g. Discord premium button data). */
  clientHandoff?: Record<string, any>;
  /** `oauth_link`: user is sent here to link their external account. */
  oauthUrl?: string;
  /** Filled by `immediate` providers; PremiumManager caches this directly. */
  state?: ProviderSubscriptionState;
  /** Snapshot of the picked variant at purchase time; PremiumManager freezes this onto the Subscription record. */
  variantSnapshot?: OfferingVariant;
  /** Short-lived correlation id for async flows. */
  pendingAckToken?: string;
}

/**
 * A normalized "this is what the provider thinks is active" record for a
 * subscription. Used for orphan detection: PremiumManager queries each
 * provider for what it has on file for a guild, compares against local
 * cache, and surfaces mismatches as orphans the user can adopt or cancel.
 *
 * Provider-agnostic by design - Stripe, PayPal, Lemon Squeezy, Patreon all
 * map their own subscription objects into this shape. The UI and route
 * layer never see provider-specific fields.
 */
export interface ProviderSubscriptionRef {
  providerSubId: string;
  /** Provider's lifecycle view: status / dates / autoRenew. */
  state: ProviderSubscriptionState;
  /**
   * Metadata captured at subscribe time. Adoption needs `tierId`,
   * `offeringId`, and `variantId` to route the install through PremiumManager's
   * existing stacking logic; orphans missing these can only be cancelled.
   */
  metadata: {
    guildId?: string;
    tierId?: string;
    offeringId?: string;
    variantId?: string;
    couponCode?: string;
    userId?: string;
  };
  /** Short labels for UI display. */
  display: { amountLabel: string; periodLabel: string; statusLabel: string };
}

// ============================================================================
// EVENT BUS
// ============================================================================

/** Unified provider event emitted on the registry's bus. */
export type ProviderEvent =
  /**
   * Async install: emitted by webhook-driven providers (Stripe, Lemon Squeezy,
   * PayPal) when a checkout completes and we need to install a brand-new
   * paid subscription into the cache. Synchronous providers (Dummy) install
   * inline from `initiatePaidSubscription` and never emit this. The extra
   * `tierId` / `offeringId` / `variantId` / `couponCode` / `variantSnapshot`
   * are needed because the cache has no record yet and PremiumManager can't
   * infer them.
   */
  | { type: 'subscription.created'; providerId: string; providerSubId: string; guildId: string; tierId: string; offeringId: string; variantId?: string; couponCode?: string; state: ProviderSubscriptionState; variantSnapshot?: OfferingVariant }
  | { type: 'subscription.renewed'; providerId: string; providerSubId: string; guildId: string; state: ProviderSubscriptionState }
  | { type: 'subscription.expired'; providerId: string; providerSubId: string; guildId: string; state: ProviderSubscriptionState }
  | { type: 'subscription.cancelled'; providerId: string; providerSubId: string; guildId: string; state: ProviderSubscriptionState }
  | { type: 'subscription.updated'; providerId: string; providerSubId: string; guildId: string; state: ProviderSubscriptionState }
  | { type: 'subscription.paused'; providerId: string; providerSubId: string; guildId: string; resumesAt: string | null }
  | { type: 'subscription.resumed'; providerId: string; providerSubId: string; guildId: string; state: ProviderSubscriptionState }
  /**
   * Renewal payment was attempted and failed. Provider's own dunning takes
   * over (Stripe sends receipts, etc.); we surface a one-shot notification
   * so the guild owner sees the issue inside our UI/DM channel too. No
   * cache state change - the sub stays active until the provider gives up
   * (which fires `subscription.expired`).
   */
  | { type: 'subscription.renewal-failed'; providerId: string; providerSubId: string; guildId: string; reason?: string };

// ============================================================================
// PROVIDER INTERFACE
// ============================================================================

/**
 * One credential field a provider needs (env var). The Web-UI's per-provider
 * credentials modal renders a form from this list, so admins configure
 * each provider in isolation instead of editing a global Credentials tab.
 */
export interface CredentialFieldDef {
  /** Env var key (e.g. STRIPE_SECRET_KEY). */
  key: string;
  /** Human label for the form field. */
  label: string;
  /** Input type. 'secret' renders as password + masked status display. */
  type: 'secret' | 'text' | 'url' | 'select';
  /** Placeholder shown when the field is empty. */
  placeholder?: string;
  /** Short helper text under the field. */
  helpText?: string;
  /** When true, the provider can still run without this field. */
  optional?: boolean;
  /** For type='select': options to choose from. */
  options?: Array<{ value: string; label: string }>;
}

/** Contract every payment provider implements. */
export interface PaymentProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  /** True when the provider has whatever credentials / setup it needs to actually run. */
  isConfigured(): boolean;

  /**
   * Declare the env-var-backed credentials this provider needs. The web-UI
   * credentials modal renders a form from this list and persists each key
   * via `saveCredentials`. Returns [] for providers with no credentials
   * (e.g. Dummy, Server Boosting).
   */
  getCredentialFields?(): CredentialFieldDef[];

  /**
   * Discord gateway intents this provider needs at runtime. Strings match
   * the `GatewayIntentBits` enum names (e.g. 'GuildMembers'). Bot init
   * merges these with module-declared intents at boot so the bot logs in
   * with the right bits. Returns [] for providers that don't depend on
   * any gateway events (most do; only Boost / future Discord-side
   * providers need this today).
   *
   * Why declared at the provider boundary instead of via a file scan:
   * each provider's needs travel with its capability declarations
   * (`getCapabilities`, `getCredentialFields`), so they're co-located
   * and can't drift out of sync with the runtime code.
   */
  getRequiredIntents?(): string[];

  initiatePurchase(opts: InitiateOpts): Promise<InitiateResult>;

  /**
   * Optional: list active variants under a Product. Required for Product
   * mode. Only called when `capabilities.supportsProductMode`.
   */
  listVariants?(productId: string): Promise<OfferingVariant[]>;

  /**
   * Optional: resolve a single variantId to its current OfferingVariant.
   * Used for Price mode validation, cache refresh, and orphan adoption.
   */
  fetchVariant?(variantId: string): Promise<OfferingVariant | null>;

  /**
   * Optional: pre-validate a coupon code without consuming it. Provider-side
   * lookup (e.g. Stripe Promotion Codes, LS checkout preview). Called from
   * the subscribe modal's coupon preview field. variantId is optional; some
   * providers tie coupons to specific variants (e.g. LS).
   */
  validateCoupon?(code: string, variantId?: string): Promise<ProviderCouponValidation>;

  /**
   * Optional: list active-or-pending subscriptions the provider has on
   * file for this guild. Used to detect orphans (subs the provider has
   * that local cache doesn't know about).
   */
  listSubscriptionsForGuild?(guildId: string): Promise<ProviderSubscriptionRef[]>;

  /**
   * Optional: create a hosted "manage subscription" portal session for
   * this provider sub. Required when `capabilities.supportsCustomerPortal`.
   */
  createBillingPortalSession?(providerSubId: string, returnUrl: string): Promise<{ portalUrl: string }>;

  /**
   * Optional: cancel. Required when `capabilities.supportsCancel`.
   *
   * - `immediately = false` (default): soft cancel - flip autoRenew off but
   *   keep remaining days. Maps to Stripe `cancel_at_period_end=true`.
   * - `immediately = true`: hard cancel - end the subscription right now at
   *   the provider. Maps to Stripe `DELETE /v1/subscriptions/:id`.
   */
  cancelSubscription?(providerSubId: string, immediately?: boolean): Promise<void>;
  reactivateSubscription?(providerSubId: string): Promise<void>;

  /**
   * Optional: pause billing so remaining time stops counting down. Required
   * when `capabilities.supportsPause`. `resumesAt` is when the pause should
   * auto-lift (ISO timestamp); null means indefinite (lifts on explicit
   * resume call).
   *
   * For Stripe, the provider should set `trial_end = current_period_end + N`
   * alongside `pause_collection: { behavior: 'void' }` so the next bill is
   * deferred correctly.
   */
  pauseSubscription?(providerSubId: string, resumesAt: string | null): Promise<void>;
  /**
   * Optional: resume a paused subscription with a fresh endDate. `newEndDate`
   * may be null for lifetime. Required when `capabilities.supportsPause`.
   */
  resumeSubscription?(providerSubId: string, newEndDate: string | null): Promise<void>;

  /**
   * Optional: migrate an existing subscription to a new variant. Used by
   * the price-migration flow. Required when
   * `capabilities.supportsPriceMigration`.
   *
   * `prorationBehavior`:
   *   - 'none': switch at the next billing cycle, no immediate charges.
   *   - 'create_prorations': charge/credit the difference now.
   */
  migrateSubscriptionPrice?(providerSubId: string, newVariantId: string, prorationBehavior: 'none' | 'create_prorations'): Promise<void>;

  getSubscriptionState(providerSubId: string): Promise<ProviderSubscriptionState | null>;

  /** Webhook-driven providers (Stripe, Lemon Squeezy) implement this. */
  handleWebhook?(rawBody: Buffer, signature: string, headers: Record<string, string>): Promise<void>;
  /** Polling-driven providers (Patreon, Server Boosting) implement this. */
  scheduledReconcile?(providerSubId: string): Promise<ProviderSubscriptionState | null>;
  /** OAuth-linked providers (Patreon) implement this. */
  handleOAuthCallback?(query: Record<string, string>): Promise<{
    externalAccountId: string;
    guildId: string;
    tierId: string;
    offeringId: string;
    variantId: string;
    state: ProviderSubscriptionState;
  }>;

  /** Called when the provider is registered. Providers with their own scheduled work kick it off here. */
  start?(): void;
  /** Called when the provider is unregistered / process shutting down. */
  stop?(): void;
}
