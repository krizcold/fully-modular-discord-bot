/**
 * Payment Provider Types
 *
 * Shared interface for all payment providers (Dummy, Stripe, Lemon Squeezy,
 * Discord App Monetization, Patreon, Server Boosting, Custom, ...). The
 * interface is designed up front to fit every mechanism identified in
 * research so real providers slot in behind DummyProvider without refactor.
 */

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

/** Describes a single field the provider expects in a TierOffering. */
export interface OfferingFieldSpec {
  /** Path inside `TierOffering` (top-level key) or `TierOffering.providerConfig`. */
  key: string;
  /** Human-readable label for the Tier Edit modal. */
  label: string;
  type: 'number' | 'string' | 'boolean' | 'select' | 'duration' | 'currency';
  required: boolean;
  /** For `select` type. */
  options?: Array<{ value: string; label: string }>;
  description?: string;
}

/** What a provider supports; drives UI affordances. */
export interface ProviderCapabilities {
  /** Server can start the purchase flow. False for Discord App Monetization. */
  canInitiatePurchase: boolean;
  supportsCancel: boolean;
  supportsReactivate: boolean;
  /** HOST can set an arbitrary amount. False for Discord (SKU pricing) / Patreon (tier-defined). */
  supportsCustomPricing: boolean;
  supportsCoupons: boolean;
  /**
   * Provider can pause a subscription (stop ticking / billing) and later
   * resume it with a fresh endDate. Used for subscription stacking: when a
   * guild buys a higher-priority paid sub, the current one pauses until the
   * higher one ends. Providers without pause support can still stack
   * logically in PremiumManager, but the provider's own state may keep
   * ticking in the background.
   */
  supportsPause?: boolean;
  mechanism: ProviderMechanism;
  /** Fields the Tier Edit modal should render when configuring an offering for this provider. */
  offeringSchema: OfferingFieldSpec[];
}

/** Provider-reported subscription state. */
export interface ProviderSubscriptionState {
  status: 'active' | 'expired' | 'cancelled';
  startDate: string;
  endDate: string | null;
  autoRenew: boolean;
  meta?: Record<string, any>;
}

/** Input to `initiatePurchase`. */
export interface InitiateOpts {
  guildId: string;
  tierId: string;
  offeringId: string;
  /** Mirrored from the offering for convenience. */
  durationDays: number | null;
  amount?: number;
  currency?: string;
  providerConfig?: Record<string, any>;
  couponCode?: string;
  /** Guild owner triggering; needed for oauth_link / client_handoff flows. */
  userId?: string;
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
  /** Short-lived correlation id for async flows. */
  pendingAckToken?: string;
}

/** Unified provider event emitted on the registry's bus. */
export type ProviderEvent =
  | { type: 'subscription.renewed'; providerId: string; providerSubId: string; guildId: string; state: ProviderSubscriptionState }
  | { type: 'subscription.expired'; providerId: string; providerSubId: string; guildId: string; state: ProviderSubscriptionState }
  | { type: 'subscription.cancelled'; providerId: string; providerSubId: string; guildId: string; state: ProviderSubscriptionState }
  | { type: 'subscription.updated'; providerId: string; providerSubId: string; guildId: string; state: ProviderSubscriptionState };

/** Contract every payment provider implements. */
export interface PaymentProvider {
  /** Stable identifier, referenced from `TierOffering.providerId`. */
  readonly id: string;
  /** Human-readable display name. */
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  /** True when the provider has whatever credentials / setup it needs to actually run. */
  isConfigured(): boolean;

  initiatePurchase(opts: InitiateOpts): Promise<InitiateResult>;

  /** Optional: flip autoRenew off, keep remaining days. Required when `capabilities.supportsCancel`. */
  cancelSubscription?(providerSubId: string): Promise<void>;
  /** Optional: flip autoRenew back on while still active. Required when `capabilities.supportsReactivate`. */
  reactivateSubscription?(providerSubId: string): Promise<void>;

  /** Optional: pause billing/ticking so remaining time stops counting down. Required when `capabilities.supportsPause`. */
  pauseSubscription?(providerSubId: string): Promise<void>;
  /**
   * Optional: resume a paused subscription with a new endDate. `newEndDate`
   * may be null for lifetime. Required when `capabilities.supportsPause`.
   */
  resumeSubscription?(providerSubId: string, newEndDate: string | null): Promise<void>;

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
    state: ProviderSubscriptionState;
  }>;

  /** Called when the provider is registered. Providers with their own scheduled work kick it off here. */
  start?(): void;
  /** Called when the provider is unregistered / process shutting down. */
  stop?(): void;
}
