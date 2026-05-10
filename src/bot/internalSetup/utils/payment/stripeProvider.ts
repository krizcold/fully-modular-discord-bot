/**
 * StripeProvider - direct HTTP against Stripe REST API (no `stripe` SDK).
 *
 * Configuration: STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET env vars. Without
 * them `isConfigured()` returns false and offerings wired through Stripe
 * stay hidden in the guild subscribe UI.
 *
 * State ownership: Stripe is the source of truth. We keep no local state
 * file here; PremiumManager caches the active/paused subscription records
 * and the webhook handler emits events that mirror Stripe's lifecycle into
 * the cache.
 */

import * as crypto from 'crypto';
import { loadCredentials } from '@/utils/envLoader';
import { getPaymentRegistry } from './paymentRegistry';
import type {
  PaymentProvider,
  ProviderCapabilities,
  ProviderSubscriptionState,
  InitiateOpts,
  InitiateResult,
  OfferingVariant,
  ProviderSubscriptionRef,
  ProviderCouponValidation,
  CredentialFieldDef,
} from './paymentTypes';

// Pin the Stripe API version so our outgoing requests get a known response
// shape. Webhooks deliver in the account's default API version regardless,
// so consumers must tolerate multiple shapes (see current_period_*).
const STRIPE_API_VERSION = '2024-11-20.acacia';
const STRIPE_API_BASE = 'https://api.stripe.com';

function safeIso(epochSeconds: number | null | undefined): string | null {
  if (typeof epochSeconds !== 'number' || !isFinite(epochSeconds) || epochSeconds <= 0) return null;
  return new Date(epochSeconds * 1000).toISOString();
}

const CAPABILITIES: ProviderCapabilities = {
  canInitiatePurchase: true,
  supportsCancel: true,
  supportsReactivate: true,
  supportsCoupons: true,
  supportsPause: true,
  supportsMultipleVariants: true,
  supportsProductMode: true,
  supportsHostedPicker: true,
  hostedPickerVariantCap: 3, // Stripe Pricing Table caps at 3 prices per Product
  supportsCustomerPortal: true,
  supportsAnnualBilling: true,
  supportsPriceMigration: true,
  mechanism: 'redirect',
  variantIdLabel: 'Stripe Price ID',
  productIdLabel: 'Stripe Product ID',
};

interface StripeSession {
  id: string;
  url: string | null;
  subscription?: string | null;
  payment_intent?: string | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string>;
}

interface StripeSubscription {
  id: string;
  status: 'active' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'trialing' | 'paused';
  cancel_at_period_end: boolean;
  current_period_start?: number;
  current_period_end?: number;
  start_date?: number;
  trial_end?: number | null;
  pause_collection: { behavior: 'keep_as_draft' | 'mark_uncollectible' | 'void' } | null;
  metadata?: Record<string, string>;
  customer?: string | null;
  items?: {
    data: Array<{
      id: string;
      current_period_start?: number;
      current_period_end?: number;
      price?: StripePrice;
    }>;
  };
}

interface StripePromotionCode {
  id: string;
  code: string;
  active: boolean;
  coupon: {
    id: string;
    name?: string;
    percent_off?: number | null;
    amount_off?: number | null;
    currency?: string | null;
    duration: 'once' | 'forever' | 'repeating';
    duration_in_months?: number | null;
  };
}

interface StripePrice {
  id: string;
  active: boolean;
  currency: string;
  unit_amount: number | null;
  type: 'one_time' | 'recurring';
  recurring: { interval: 'day' | 'week' | 'month' | 'year'; interval_count: number; trial_period_days?: number | null } | null;
  product: string | { id: string; name: string; description?: string | null; active: boolean };
  nickname?: string | null;
}

export class StripeProvider implements PaymentProvider {
  readonly id = 'stripe';
  readonly displayName = 'Stripe';
  readonly capabilities = CAPABILITIES;

  isConfigured(): boolean {
    const c = loadCredentials();
    return !!(c.STRIPE_SECRET_KEY && c.STRIPE_WEBHOOK_SECRET);
  }

  getCredentialFields(): CredentialFieldDef[] {
    return [
      {
        key: 'STRIPE_SECRET_KEY',
        label: 'Secret Key',
        type: 'secret',
        placeholder: 'sk_test_... or sk_live_...',
        helpText: 'Stripe Dashboard - Developers - API keys. Use test keys for sandbox, live keys for production.',
      },
      {
        key: 'STRIPE_WEBHOOK_SECRET',
        label: 'Webhook Signing Secret',
        type: 'secret',
        placeholder: 'whsec_...',
        helpText: 'Local dev: `stripe listen --forward-to localhost:8080/webhook/stripe` prints this. Production: created when you register the endpoint in Stripe Dashboard.',
      },
    ];
  }

  // ============================================================================
  // PURCHASE FLOW
  // ============================================================================

  async initiatePurchase(opts: InitiateOpts): Promise<InitiateResult> {
    if (!opts.variantId) throw new Error('Stripe initiatePurchase requires variantId.');

    // Look up the price upfront so we can return a variantSnapshot AND
    // detect mode (recurring vs one-time) without trusting the caller.
    const variant = await this.fetchVariant(opts.variantId);
    if (!variant) {
      throw new Error(`Stripe price '${opts.variantId}' is missing, archived, or has no fixed unit amount.`);
    }
    const isSubscription = variant.recurring && variant.durationDays !== null;
    const wantAutoRenew = opts.autoRenew !== false;

    let promotionCodeId: string | undefined;
    if (opts.couponCode) {
      const v = await this.validateCoupon(opts.couponCode, opts.variantId);
      if (!v.valid) throw new Error(`Coupon invalid: ${v.reason || 'not accepted'}`);
      promotionCodeId = v.providerCouponId;
    }

    const successBase = this.publicHostUrl();
    const params: Record<string, string> = {
      mode: isSubscription ? 'subscription' : 'payment',
      'line_items[0][price]': opts.variantId,
      'line_items[0][quantity]': '1',
      success_url: `${successBase}/guild/${encodeURIComponent(opts.guildId)}/subscription?subscribe=success&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${successBase}/guild/${encodeURIComponent(opts.guildId)}/subscription?subscribe=cancel`,
      client_reference_id: `${opts.guildId}:${opts.tierId}:${opts.offeringId}`,
      'metadata[guildId]': opts.guildId,
      'metadata[tierId]': opts.tierId,
      'metadata[offeringId]': opts.offeringId,
      'metadata[variantId]': opts.variantId,
      'metadata[couponCode]': opts.couponCode || '',
      'metadata[userId]': opts.userId || '',
    };

    if (isSubscription) {
      params['subscription_data[metadata][guildId]'] = opts.guildId;
      params['subscription_data[metadata][tierId]'] = opts.tierId;
      params['subscription_data[metadata][offeringId]'] = opts.offeringId;
      params['subscription_data[metadata][variantId]'] = opts.variantId;
      params['subscription_data[metadata][couponCode]'] = opts.couponCode || '';
      if (!wantAutoRenew) {
        params['subscription_data[cancel_at_period_end]'] = 'true';
      }
      // Stacking: when this sub is being created BEHIND a higher-priority
      // sub, defer the first bill to the resume date by setting trial_end
      // at Checkout time. Without this Stripe charges immediately for the
      // first period and we'd be doing the pause AFTER the user got billed.
      // Post-webhook PremiumManager.installSubscription still calls
      // pauseSubscription as a safety net (which is idempotent here).
      if (opts.startPausedUntil) {
        const resumeEpoch = Math.floor(Date.parse(opts.startPausedUntil) / 1000);
        if (Number.isFinite(resumeEpoch) && resumeEpoch > Math.floor(Date.now() / 1000)) {
          params['subscription_data[trial_end]'] = String(resumeEpoch);
          params['subscription_data[proration_behavior]'] = 'none';
        }
      }
    }

    if (promotionCodeId) {
      params['discounts[0][promotion_code]'] = promotionCodeId;
    }

    const session = await this.api<StripeSession>('POST', '/v1/checkout/sessions', params);
    if (!session.url) {
      throw new Error('Stripe returned a checkout session without a url.');
    }

    return {
      redirectUrl: session.url,
      pendingAckToken: session.id,
      variantSnapshot: variant,
    };
  }

  // ============================================================================
  // VARIANT QUERIES
  // ============================================================================

  async listVariants(productId: string): Promise<OfferingVariant[]> {
    if (!productId) return [];
    const result = await this.api<{ data: StripePrice[]; has_more: boolean }>(
      'GET',
      `/v1/prices?product=${encodeURIComponent(productId)}&active=true&limit=100&expand[]=data.product`,
    );
    const out: OfferingVariant[] = [];
    for (const price of result.data || []) {
      const v = this.normalizePrice(price);
      if (v) out.push(v);
    }
    return out;
  }

  async fetchVariant(variantId: string): Promise<OfferingVariant | null> {
    if (!variantId) return null;
    let price: StripePrice;
    try {
      price = await this.api<StripePrice>('GET', `/v1/prices/${encodeURIComponent(variantId)}?expand[]=product`);
    } catch (err: any) {
      if (err?.message?.toLowerCase().includes('no such price')) return null;
      throw err;
    }
    return this.normalizePrice(price);
  }

  async validateCoupon(code: string, _variantId?: string): Promise<ProviderCouponValidation> {
    const trimmed = (code || '').trim();
    if (!trimmed) return { valid: false, reason: 'empty code' };
    let result: { data: StripePromotionCode[] };
    try {
      result = await this.api<{ data: StripePromotionCode[] }>(
        'GET',
        `/v1/promotion_codes?code=${encodeURIComponent(trimmed)}&active=true&limit=1`,
      );
    } catch (err: any) {
      return { valid: false, reason: err?.message || 'lookup failed' };
    }
    const promo = result.data[0];
    if (!promo) return { valid: false, reason: 'not found' };
    const c = promo.coupon;
    let effectText = '';
    if (typeof c.percent_off === 'number') effectText = `${c.percent_off}% off`;
    else if (typeof c.amount_off === 'number' && c.currency) {
      effectText = `${(c.amount_off / 100).toFixed(2)} ${c.currency.toUpperCase()} off`;
    }
    return {
      valid: true,
      effectText,
      providerCouponId: promo.id,
    };
  }

  // ============================================================================
  // WEBHOOK
  // ============================================================================

  async handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
    if (!this.verifySignature(rawBody, signature)) {
      throw new Error('Invalid Stripe webhook signature.');
    }
    const event = JSON.parse(rawBody.toString('utf-8')) as { type: string; data: { object: any } };
    const obj = event.data?.object;
    if (!obj) return;

    const registry = getPaymentRegistry();

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = obj as StripeSession;
        const meta = session.metadata || {};
        const guildId = meta.guildId;
        const tierId = meta.tierId;
        const offeringId = meta.offeringId;
        const variantId = meta.variantId || undefined;
        const couponCode = meta.couponCode || undefined;
        if (!guildId || !tierId || !offeringId) {
          console.warn('[StripeProvider] checkout.session.completed missing required metadata; ignoring.');
          return;
        }

        if (session.subscription) {
          const sub = await this.fetchSubscription(session.subscription);
          if (!sub) {
            console.warn(`[StripeProvider] could not fetch subscription ${session.subscription} after checkout completion.`);
            return;
          }
          // Build a variant snapshot from the subscription's first item.price
          const item = sub.items?.data?.[0];
          const variantSnapshot = item?.price ? this.normalizePrice(item.price) ?? undefined : undefined;
          registry.emitEvent({
            type: 'subscription.created',
            providerId: this.id,
            providerSubId: sub.id,
            guildId,
            tierId,
            offeringId,
            variantId,
            couponCode,
            state: this.stateFromSubscription(sub),
            variantSnapshot,
          });
        } else {
          // One-time / Lifetime: synthesize using the session id.
          // Try to fetch the price for variantSnapshot.
          const variantSnapshot = variantId ? (await this.fetchVariant(variantId).catch(() => null)) ?? undefined : undefined;
          registry.emitEvent({
            type: 'subscription.created',
            providerId: this.id,
            providerSubId: session.id,
            guildId,
            tierId,
            offeringId,
            variantId,
            couponCode,
            state: {
              status: 'active',
              startDate: new Date().toISOString(),
              endDate: null,
              autoRenew: false,
              meta: { sessionId: session.id, paymentIntent: session.payment_intent || null },
            },
            variantSnapshot,
          });
        }
        return;
      }

      case 'customer.subscription.updated': {
        const sub = obj as StripeSubscription;
        registry.emitEvent({
          type: 'subscription.updated',
          providerId: this.id,
          providerSubId: sub.id,
          guildId: sub.metadata?.guildId || '',
          state: this.stateFromSubscription(sub),
        });
        return;
      }

      case 'customer.subscription.deleted': {
        const sub = obj as StripeSubscription;
        registry.emitEvent({
          type: 'subscription.expired',
          providerId: this.id,
          providerSubId: sub.id,
          guildId: sub.metadata?.guildId || '',
          state: { ...this.stateFromSubscription(sub), status: 'expired' },
        });
        return;
      }

      case 'invoice.paid': {
        const inv = obj as { subscription?: string | null };
        if (!inv.subscription) return;
        const sub = await this.fetchSubscription(inv.subscription);
        if (!sub) return;
        registry.emitEvent({
          type: 'subscription.renewed',
          providerId: this.id,
          providerSubId: sub.id,
          guildId: sub.metadata?.guildId || '',
          state: this.stateFromSubscription(sub),
        });
        return;
      }

      case 'invoice.payment_failed': {
        // Stripe owns the dunning retry schedule and emails the customer.
        // We surface a heads-up event so the bot can DM/post the same news;
        // no cache state change because the sub is still nominally active
        // until Stripe gives up (which fires customer.subscription.deleted).
        const inv = obj as { subscription?: string | null; last_finalization_error?: { message?: string } | null };
        if (!inv.subscription) return;
        const sub = await this.fetchSubscription(inv.subscription);
        if (!sub) return;
        registry.emitEvent({
          type: 'subscription.renewal-failed',
          providerId: this.id,
          providerSubId: sub.id,
          guildId: sub.metadata?.guildId || '',
          reason: inv.last_finalization_error?.message,
        });
        return;
      }

      default:
        return;
    }
  }

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  async cancelSubscription(providerSubId: string, immediately?: boolean): Promise<void> {
    if (this.isOneTimeSubId(providerSubId)) return;
    if (immediately) {
      const result = await this.api<StripeSubscription>('DELETE', `/v1/subscriptions/${encodeURIComponent(providerSubId)}`);
      if (result?.status !== 'canceled') {
        throw new Error(`Stripe DELETE for '${providerSubId}' returned status='${result?.status ?? 'unknown'}'; expected 'canceled'. Subscription may still be active.`);
      }
      return;
    }
    const result = await this.api<StripeSubscription>('POST', `/v1/subscriptions/${encodeURIComponent(providerSubId)}`, {
      cancel_at_period_end: 'true',
    });
    if (result?.cancel_at_period_end !== true) {
      throw new Error(`Stripe POST for '${providerSubId}' did not set cancel_at_period_end. Subscription may still auto-renew.`);
    }
  }

  async reactivateSubscription(providerSubId: string): Promise<void> {
    if (this.isOneTimeSubId(providerSubId)) return;
    const result = await this.api<StripeSubscription>('POST', `/v1/subscriptions/${encodeURIComponent(providerSubId)}`, {
      cancel_at_period_end: 'false',
    });
    if (result?.cancel_at_period_end !== false) {
      throw new Error(`Stripe POST for '${providerSubId}' did not clear cancel_at_period_end. Subscription may still cancel at period end.`);
    }
  }

  /**
   * Pause with deferred-bill recipe: `pause_collection: { behavior: 'void' }`
   * alone keeps the original billing cadence. To actually defer the next bill
   * by N days, set trial_end = current_period_end + N alongside the pause.
   * This is community-confirmed but not formally documented; verify on test
   * mode before relying on it in production.
   */
  async pauseSubscription(providerSubId: string, resumesAt: string | null): Promise<void> {
    if (this.isOneTimeSubId(providerSubId)) return;

    const params: Record<string, string> = {
      'pause_collection[behavior]': 'void',
      proration_behavior: 'none',
    };

    // If we have an expected resume time, use it to set trial_end so the
    // next bill is deferred to that point. Otherwise we just halt billing
    // until an explicit resume call (which may need to set trial_end then).
    if (resumesAt) {
      const epoch = Math.floor(Date.parse(resumesAt) / 1000);
      if (Number.isFinite(epoch) && epoch > 0) {
        params.trial_end = String(epoch);
      }
    }

    const result = await this.api<StripeSubscription>('POST', `/v1/subscriptions/${encodeURIComponent(providerSubId)}`, params);
    if (result?.pause_collection?.behavior !== 'void') {
      throw new Error(`Stripe POST for '${providerSubId}' did not pause collection. pause_collection=${JSON.stringify(result?.pause_collection)}.`);
    }
  }

  /**
   * Resume a paused subscription. If newEndDate is provided we set trial_end
   * to align the next bill with the desired endDate; otherwise just clear
   * pause_collection and let Stripe resume on its current period.
   */
  async resumeSubscription(providerSubId: string, newEndDate: string | null): Promise<void> {
    if (this.isOneTimeSubId(providerSubId)) return;
    const params: Record<string, string> = {
      pause_collection: '',
      proration_behavior: 'none',
    };
    if (newEndDate) {
      const epoch = Math.floor(Date.parse(newEndDate) / 1000);
      if (Number.isFinite(epoch) && epoch > 0) {
        params.trial_end = String(epoch);
      }
    }
    const result = await this.api<StripeSubscription>('POST', `/v1/subscriptions/${encodeURIComponent(providerSubId)}`, params);
    if (result?.pause_collection !== null && result?.pause_collection !== undefined) {
      throw new Error(`Stripe POST for '${providerSubId}' did not clear pause_collection. Got ${JSON.stringify(result?.pause_collection)}.`);
    }
  }

  /**
   * Migrate an existing subscription to a new price. Stripe accepts a new
   * `items[].price` plus the existing `items[].id` (so we update in place
   * instead of adding a second item).
   */
  async migrateSubscriptionPrice(
    providerSubId: string,
    newVariantId: string,
    prorationBehavior: 'none' | 'create_prorations',
  ): Promise<void> {
    if (this.isOneTimeSubId(providerSubId)) {
      throw new Error('Stripe one-time / Lifetime purchases cannot be migrated to a new price.');
    }
    const sub = await this.fetchSubscription(providerSubId);
    if (!sub) throw new Error(`Stripe subscription '${providerSubId}' not found.`);
    const itemId = sub.items?.data?.[0]?.id;
    if (!itemId) throw new Error(`Stripe subscription '${providerSubId}' has no items.`);

    const params: Record<string, string> = {
      'items[0][id]': itemId,
      'items[0][price]': newVariantId,
      proration_behavior: prorationBehavior,
    };
    const result = await this.api<StripeSubscription>('POST', `/v1/subscriptions/${encodeURIComponent(providerSubId)}`, params);
    const newPriceId = result.items?.data?.[0]?.price?.id;
    if (newPriceId !== newVariantId) {
      throw new Error(`Stripe migration for '${providerSubId}' did not switch price to '${newVariantId}'. Got '${newPriceId}'.`);
    }
  }

  async getSubscriptionState(providerSubId: string): Promise<ProviderSubscriptionState | null> {
    if (this.isOneTimeSubId(providerSubId)) return null;
    const sub = await this.fetchSubscription(providerSubId);
    return sub ? this.stateFromSubscription(sub) : null;
  }

  // ============================================================================
  // ORPHAN DETECTION + CUSTOMER PORTAL
  // ============================================================================

  async listSubscriptionsForGuild(guildId: string): Promise<ProviderSubscriptionRef[]> {
    if (!guildId) return [];
    const matching = new Map<string, StripeSubscription>();
    let searchCount = 0;
    let listTotal = 0;
    let listMatching = 0;
    const sampleNonMatch: Array<{ id: string; metaKeys: string[]; metaGuild: string | undefined }> = [];

    try {
      const safeGuildId = guildId.replace(/'/g, "\\'");
      const query = `metadata['guildId']:'${safeGuildId}'`;
      let page: string | undefined;
      for (let i = 0; i < 5; i++) {
        const url = `/v1/subscriptions/search?query=${encodeURIComponent(query)}&limit=100`
          + (page ? `&page=${encodeURIComponent(page)}` : '');
        const result = await this.api<{ data: StripeSubscription[]; has_more: boolean; next_page?: string }>('GET', url);
        searchCount += (result.data || []).length;
        for (const sub of result.data || []) matching.set(sub.id, sub);
        if (!result.has_more || !result.next_page) break;
        page = result.next_page;
      }
    } catch (err: any) {
      console.warn(`[StripeProvider] subscriptions search failed for guild ${guildId} (continuing with list fallback): ${err?.message || err}`);
    }

    try {
      const result = await this.api<{ data: StripeSubscription[] }>('GET', '/v1/subscriptions?limit=100');
      listTotal = (result.data || []).length;
      for (const sub of result.data || []) {
        if (sub.metadata?.guildId === guildId) {
          matching.set(sub.id, sub);
          listMatching++;
        } else if (sampleNonMatch.length < 3) {
          sampleNonMatch.push({
            id: sub.id,
            metaKeys: Object.keys(sub.metadata || {}),
            metaGuild: sub.metadata?.guildId,
          });
        }
      }
    } catch (err: any) {
      console.warn(`[StripeProvider] subscriptions list failed for guild ${guildId}: ${err?.message || err}`);
    }

    const liveStatuses = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);
    const live = Array.from(matching.values()).filter(sub => liveStatuses.has(sub.status));
    console.log(
      `[StripeProvider] orphan-scan guild=${guildId}: `
      + `search=${searchCount} list=${listTotal} list-matching-guildId=${listMatching} `
      + `dedup=${matching.size} live=${live.length}`
      + (sampleNonMatch.length > 0
        ? ` sample-non-matching=${JSON.stringify(sampleNonMatch)}`
        : ''),
    );
    return live.map(sub => this.refFromSubscription(sub));
  }

  async createBillingPortalSession(providerSubId: string, returnUrl: string): Promise<{ portalUrl: string }> {
    if (this.isOneTimeSubId(providerSubId)) {
      throw new Error('Stripe one-time / Lifetime purchases have no recurring portal to manage.');
    }
    const sub = await this.fetchSubscription(providerSubId);
    if (!sub) throw new Error(`Stripe subscription '${providerSubId}' not found.`);
    if (!sub.customer) throw new Error(`Stripe subscription '${providerSubId}' has no customer attached.`);
    const customerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer as any).id;
    const result = await this.api<{ url: string }>('POST', '/v1/billing_portal/sessions', {
      customer: customerId,
      return_url: returnUrl,
    });
    if (!result.url) {
      throw new Error('Stripe billing_portal/sessions returned no url.');
    }
    return { portalUrl: result.url };
  }

  // ============================================================================
  // INTERNALS
  // ============================================================================

  private normalizePrice(price: StripePrice): OfferingVariant | null {
    if (!price.active) return null;
    if (price.unit_amount === null) return null; // tiered/custom not supported
    const product = typeof price.product === 'object' ? price.product : null;
    if (product && product.active === false) return null;

    const isRecurring = price.type === 'recurring' && !!price.recurring;
    const durationDays = isRecurring ? this.recurringIntervalToDays(price.recurring!) : null;
    const trialDays = price.recurring?.trial_period_days ?? undefined;
    const label = price.nickname || product?.name || price.id;
    return {
      variantId: price.id,
      label,
      amount: price.unit_amount,
      currency: price.currency.toUpperCase(),
      durationDays,
      ...(trialDays !== undefined ? { trialDays } : {}),
      recurring: isRecurring,
      active: true,
    };
  }

  private recurringIntervalToDays(rec: { interval: 'day' | 'week' | 'month' | 'year'; interval_count: number }): number {
    const n = Math.max(1, rec.interval_count);
    switch (rec.interval) {
      case 'day':   return n;
      case 'week':  return 7 * n;
      case 'month': return 30 * n;
      case 'year':  return 365 * n;
    }
  }

  private intervalLabel(rec: { interval: 'day' | 'week' | 'month' | 'year'; interval_count: number }): string {
    const n = Math.max(1, rec.interval_count);
    return n === 1 ? `every ${rec.interval}` : `every ${n} ${rec.interval}s`;
  }

  private refFromSubscription(sub: StripeSubscription): ProviderSubscriptionRef {
    const item = sub.items?.data?.[0];
    const price = item?.price;
    const amountLabel = price?.unit_amount != null
      ? `${(price.unit_amount / 100).toFixed(2)} ${price.currency.toUpperCase()}`
      : '';
    const periodLabel = price?.recurring
      ? this.intervalLabel(price.recurring)
      : 'one-time';
    const statusLabel = sub.cancel_at_period_end
      ? `${sub.status} (cancels at period end)`
      : sub.status;
    return {
      providerSubId: sub.id,
      state: this.stateFromSubscription(sub),
      metadata: {
        guildId: sub.metadata?.guildId,
        tierId: sub.metadata?.tierId,
        offeringId: sub.metadata?.offeringId,
        variantId: sub.metadata?.variantId || price?.id,
        couponCode: sub.metadata?.couponCode || undefined,
        userId: sub.metadata?.userId || undefined,
      },
      display: { amountLabel, periodLabel, statusLabel },
    };
  }

  private verifySignature(rawBody: Buffer, header: string | undefined): boolean {
    const secret = loadCredentials().STRIPE_WEBHOOK_SECRET;
    if (!secret || !header) return false;

    let timestamp = '';
    const v1Sigs: string[] = [];
    for (const part of header.split(',')) {
      const [k, v] = part.split('=');
      if (k === 't') timestamp = v;
      else if (k === 'v1' && v) v1Sigs.push(v);
    }
    if (!timestamp || v1Sigs.length === 0) return false;

    const payload = `${timestamp}.${rawBody.toString('utf-8')}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');

    for (const candidate of v1Sigs) {
      let candidateBuf: Buffer;
      try { candidateBuf = Buffer.from(candidate, 'hex'); }
      catch { continue; }
      if (candidateBuf.length !== expectedBuf.length) continue;
      if (crypto.timingSafeEqual(candidateBuf, expectedBuf)) return true;
    }
    return false;
  }

  private async fetchSubscription(id: string): Promise<StripeSubscription | null> {
    try {
      return await this.api<StripeSubscription>('GET', `/v1/subscriptions/${encodeURIComponent(id)}?expand[]=items.data.price`);
    } catch (err: any) {
      console.warn(`[StripeProvider] fetchSubscription(${id}) failed: ${err?.message || err}`);
      return null;
    }
  }

  private stateFromSubscription(sub: StripeSubscription): ProviderSubscriptionState {
    let status: ProviderSubscriptionState['status'];
    if (sub.status === 'canceled' || sub.status === 'incomplete_expired') status = 'expired';
    else if (sub.pause_collection) status = 'paused';
    else if (sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due' || sub.status === 'unpaid') status = 'active';
    else if (sub.status === 'paused') status = 'paused';
    else status = 'expired';

    const firstItem = sub.items?.data?.[0];
    const periodStart = sub.current_period_start ?? firstItem?.current_period_start;
    const periodEnd = sub.current_period_end ?? firstItem?.current_period_end;

    const startIso = safeIso(sub.start_date)
      ?? safeIso(periodStart)
      ?? new Date().toISOString();
    const endIso = safeIso(periodEnd);
    const periodStartIso = safeIso(periodStart);

    return {
      status,
      startDate: startIso,
      endDate: endIso,
      autoRenew: !sub.cancel_at_period_end,
      meta: {
        stripeStatus: sub.status,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        pauseCollection: sub.pause_collection?.behavior || null,
        currentPeriodStart: periodStartIso,
        trialEnd: safeIso(sub.trial_end ?? null),
      },
    };
  }

  private isOneTimeSubId(id: string): boolean {
    return id.startsWith('cs_');
  }

  private publicHostUrl(): string {
    const c = loadCredentials();
    const callbackUrl = c.OAUTH_CALLBACK_URL;
    if (!callbackUrl) {
      throw new Error('STRIPE: OAUTH_CALLBACK_URL is not set; cannot derive public host for Stripe redirect URLs.');
    }
    try {
      const parsed = new URL(callbackUrl);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      throw new Error(`STRIPE: OAUTH_CALLBACK_URL is not a valid URL: ${callbackUrl}`);
    }
  }

  private async api<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, formBody?: Record<string, string>): Promise<T> {
    const secret = loadCredentials().STRIPE_SECRET_KEY;
    if (!secret) throw new Error('STRIPE_SECRET_KEY is not set.');

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${secret}`,
      'Stripe-Version': STRIPE_API_VERSION,
    };

    let body: string | undefined;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = formBody ? new URLSearchParams(formBody).toString() : '';
    }

    const res = await fetch(`${STRIPE_API_BASE}${path}`, { method, headers, body });
    const text = await res.text();
    if (!res.ok) {
      let userMessage = `Stripe API ${res.status}`;
      if (text) {
        try {
          const parsed = JSON.parse(text);
          if (parsed?.error?.message) userMessage = parsed.error.message;
        } catch { /* not JSON; keep generic status */ }
      }
      throw new Error(userMessage);
    }
    if (!text) {
      throw new Error(`Stripe API ${method} ${path} returned ${res.status} with an empty body.`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Stripe API ${method} ${path} returned non-JSON body: ${text.slice(0, 200)}`);
    }
  }
}
