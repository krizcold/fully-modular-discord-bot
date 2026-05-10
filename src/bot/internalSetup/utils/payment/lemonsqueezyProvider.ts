/**
 * LemonSqueezyProvider - direct HTTP against Lemon Squeezy API v1.
 *
 * Configuration:
 *   - LEMONSQUEEZY_API_KEY (Bearer token from your store dashboard)
 *   - LEMONSQUEEZY_STORE_ID (numeric store id; pinned to one store)
 *   - LEMONSQUEEZY_WEBHOOK_SECRET (HMAC-SHA256 signing secret)
 *
 * Mechanism: redirect. We POST a checkout to LS, get back a hosted URL,
 * send the user there. LS DMs receipts + dunning emails directly to the
 * customer (we don't duplicate via our notifier per spec "skip native").
 *
 * State ownership: LS is source of truth. Webhooks (HMAC-SHA256 signed)
 * mirror lifecycle into our cache. Pause is supported natively as
 * `pause: { mode: 'void', resumes_at }`.
 *
 * Migration: PATCH /subscriptions/{id} with { variant_id } changes the
 * billing immediately. We pass that through `migrateSubscriptionPrice`.
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

const LS_API_BASE = 'https://api.lemonsqueezy.com/v1';

const CAPABILITIES: ProviderCapabilities = {
  canInitiatePurchase: true,
  supportsCancel: true,
  supportsReactivate: true,
  supportsCoupons: true,
  supportsPause: true,
  supportsMultipleVariants: true,
  supportsProductMode: true,
  supportsHostedPicker: true,
  // LS hosted checkout doesn't have a hard cap on variants per product;
  // omit hostedPickerVariantCap so the cap warning never fires.
  supportsCustomerPortal: true,
  supportsAnnualBilling: true,
  supportsPriceMigration: true,
  mechanism: 'redirect',
  variantIdLabel: 'Lemon Squeezy Variant ID',
  productIdLabel: 'Lemon Squeezy Product ID',
};

interface LSResource<TAttr> {
  id: string;
  type: string;
  attributes: TAttr;
}

interface LSVariantAttrs {
  product_id: number;
  name: string;
  status: 'pending' | 'draft' | 'published';
  price: number;             // minor units
  is_subscription: boolean;
  interval?: 'day' | 'week' | 'month' | 'year' | null;
  interval_count?: number | null;
  has_free_trial: boolean;
  trial_interval?: 'day' | 'week' | 'month' | 'year' | null;
  trial_interval_count?: number | null;
}

interface LSSubscriptionAttrs {
  store_id: number;
  customer_id: number;
  product_id: number;
  variant_id: number;
  status: 'on_trial' | 'active' | 'paused' | 'past_due' | 'unpaid' | 'cancelled' | 'expired';
  cancelled: boolean;
  trial_ends_at: string | null;
  renews_at: string | null;
  ends_at: string | null;
  pause: { mode: 'void' | 'free'; resumes_at: string | null } | null;
  urls: { update_payment_method?: string; customer_portal?: string };
  user_email?: string | null;
  card_brand?: string | null;
  card_last_four?: string | null;
  test_mode?: boolean;
}

interface LSCheckout {
  id: string;
  attributes: { url: string };
}

export class LemonSqueezyProvider implements PaymentProvider {
  readonly id = 'lemonsqueezy';
  readonly displayName = 'Lemon Squeezy';
  readonly capabilities = CAPABILITIES;

  isConfigured(): boolean {
    const c = loadCredentials();
    return !!(c.LEMONSQUEEZY_API_KEY && c.LEMONSQUEEZY_STORE_ID && c.LEMONSQUEEZY_WEBHOOK_SECRET);
  }

  getCredentialFields(): CredentialFieldDef[] {
    return [
      {
        key: 'LEMONSQUEEZY_API_KEY',
        label: 'API Key',
        type: 'secret',
        placeholder: 'eyJ0eXAiOiJKV1QiLCJh...',
        helpText: 'Lemon Squeezy dashboard - Settings - API. A long JWT-formatted Bearer token.',
      },
      {
        key: 'LEMONSQUEEZY_STORE_ID',
        label: 'Store ID',
        type: 'text',
        placeholder: '12345',
        helpText: 'Numeric store id from your store URL or settings page. Pinned to one store.',
      },
      {
        key: 'LEMONSQUEEZY_WEBHOOK_SECRET',
        label: 'Webhook Signing Secret',
        type: 'secret',
        placeholder: 'a long random string you set',
        helpText: 'Set when you register the webhook in LS dashboard - Settings - Webhooks. HMAC-SHA256 signing secret.',
      },
    ];
  }

  async initiatePurchase(opts: InitiateOpts): Promise<InitiateResult> {
    const c = loadCredentials();
    if (!c.LEMONSQUEEZY_API_KEY || !c.LEMONSQUEEZY_STORE_ID) {
      throw new Error('Lemon Squeezy not configured');
    }
    const body = {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            // Map our metadata onto LS custom_data; webhooks echo it back.
            custom: {
              guildId: opts.guildId,
              tierId: opts.tierId,
              offeringId: opts.offeringId,
              variantId: opts.variantId,
              ...(opts.couponCode ? { couponCode: opts.couponCode } : {}),
              ...(opts.userId ? { userId: opts.userId } : {}),
            },
            // discount_code lives inside checkout_data per LS API docs
            // (https://docs.lemonsqueezy.com/api/checkouts/create-checkout);
            // putting it at attributes.discount_code is silently ignored.
            ...(opts.couponCode ? { discount_code: opts.couponCode } : {}),
          },
          checkout_options: {
            embed: false,
          },
        },
        relationships: {
          store: { data: { type: 'stores', id: String(c.LEMONSQUEEZY_STORE_ID) } },
          variant: { data: { type: 'variants', id: opts.variantId } },
        },
      },
    };
    const checkout = await this.api<{ data: LSCheckout }>('POST', '/checkouts', body);
    const url = checkout?.data?.attributes?.url;
    if (!url) throw new Error('Lemon Squeezy did not return a checkout URL.');
    return { redirectUrl: url };
  }

  async listVariants(productId: string): Promise<OfferingVariant[]> {
    const data = await this.api<{ data: LSResource<LSVariantAttrs>[] }>('GET',
      `/variants?filter[product_id]=${encodeURIComponent(productId)}`);
    if (!data?.data) return [];
    return data.data.map(v => this.normalizeVariant(v));
  }

  async fetchVariant(variantId: string): Promise<OfferingVariant | null> {
    const data = await this.api<{ data: LSResource<LSVariantAttrs> }>('GET',
      `/variants/${encodeURIComponent(variantId)}`);
    return data?.data ? this.normalizeVariant(data.data) : null;
  }

  async validateCoupon(code: string, _variantId?: string): Promise<ProviderCouponValidation> {
    const c = loadCredentials();
    if (!c.LEMONSQUEEZY_STORE_ID) return { valid: false, reason: 'Lemon Squeezy not configured' };
    const data = await this.api<{ data: any[] }>('GET',
      `/discounts?filter[store_id]=${encodeURIComponent(c.LEMONSQUEEZY_STORE_ID)}&filter[code]=${encodeURIComponent(code)}`);
    const match = (data?.data || [])[0];
    if (!match) return { valid: false, reason: 'Code not found' };
    const a = match.attributes || {};
    if (a.status !== 'published') return { valid: false, reason: 'Code is not active' };
    const effect = a.amount_type === 'percent'
      ? `${a.amount}% off`
      : `${(a.amount / 100).toFixed(2)} off`;
    return { valid: true, effectText: effect, providerCouponId: String(match.id) };
  }

  async cancelSubscription(providerSubId: string, _immediately?: boolean): Promise<void> {
    // LS DELETE /subscriptions/{id} = cancel at period end. There is no
    // immediate-revoke endpoint; the soft and immediate semantics collapse here.
    const res = await this.apiRaw('DELETE', `/subscriptions/${encodeURIComponent(providerSubId)}`);
    if (res.status >= 400) {
      throw new Error(`Lemon Squeezy DELETE subscription failed: HTTP ${res.status}`);
    }
  }

  async reactivateSubscription(providerSubId: string): Promise<void> {
    const body = { data: { type: 'subscriptions', id: providerSubId, attributes: { cancelled: false } } };
    await this.api<unknown>('PATCH', `/subscriptions/${encodeURIComponent(providerSubId)}`, body);
  }

  async pauseSubscription(providerSubId: string, resumesAt: string | null): Promise<void> {
    const body = {
      data: {
        type: 'subscriptions', id: providerSubId,
        attributes: { pause: { mode: 'void', ...(resumesAt ? { resumes_at: resumesAt } : {}) } },
      },
    };
    await this.api<unknown>('PATCH', `/subscriptions/${encodeURIComponent(providerSubId)}`, body);
  }

  async resumeSubscription(providerSubId: string, _newEndDate: string | null): Promise<void> {
    const body = { data: { type: 'subscriptions', id: providerSubId, attributes: { pause: null } } };
    await this.api<unknown>('PATCH', `/subscriptions/${encodeURIComponent(providerSubId)}`, body);
  }

  async migrateSubscriptionPrice(providerSubId: string, newVariantId: string, _proration: 'none' | 'create_prorations'): Promise<void> {
    const body = { data: { type: 'subscriptions', id: providerSubId, attributes: { variant_id: Number(newVariantId) } } };
    await this.api<unknown>('PATCH', `/subscriptions/${encodeURIComponent(providerSubId)}`, body);
  }

  async getSubscriptionState(providerSubId: string): Promise<ProviderSubscriptionState | null> {
    const data = await this.api<{ data: LSResource<LSSubscriptionAttrs> }>('GET',
      `/subscriptions/${encodeURIComponent(providerSubId)}`);
    return data?.data ? this.stateFromSubscription(data.data) : null;
  }

  async listSubscriptionsForGuild(guildId: string): Promise<ProviderSubscriptionRef[]> {
    // LS doesn't index by our custom guildId; we'd need to list everything
    // and filter on the metadata. For now, return empty and rely on
    // webhook delivery to install subs. A future polling sweep can add
    // this if orphan adoption becomes a real need.
    void guildId;
    return [];
  }

  async createBillingPortalSession(providerSubId: string, _returnUrl: string): Promise<{ portalUrl: string }> {
    const data = await this.api<{ data: LSResource<LSSubscriptionAttrs> }>('GET',
      `/subscriptions/${encodeURIComponent(providerSubId)}`);
    const url = data?.data?.attributes?.urls?.customer_portal;
    if (!url) throw new Error('Lemon Squeezy did not return a customer portal URL.');
    return { portalUrl: url };
  }

  /**
   * Webhook handler. LS sends X-Signature: HMAC-SHA256 hex digest of the
   * raw body using LEMONSQUEEZY_WEBHOOK_SECRET.
   */
  async handleWebhook(rawBody: Buffer, signature: string, headers: Record<string, string>): Promise<void> {
    const c = loadCredentials();
    if (!c.LEMONSQUEEZY_WEBHOOK_SECRET) throw new Error('Webhook secret not configured');
    const expected = crypto.createHmac('sha256', c.LEMONSQUEEZY_WEBHOOK_SECRET).update(rawBody).digest('hex');
    const provided = (signature || headers['x-signature'] || '').toLowerCase();
    if (provided.length !== expected.length) throw new Error('Invalid signature length');
    const match = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
    if (!match) throw new Error('Webhook signature mismatch');

    const body = JSON.parse(rawBody.toString('utf-8'));
    const eventName: string | undefined = body?.meta?.event_name;
    if (!eventName) return;
    const data = body?.data as LSResource<LSSubscriptionAttrs> | undefined;
    if (!data) return;
    const custom = body?.meta?.custom_data || {};
    const registry = getPaymentRegistry();
    const state = this.stateFromSubscription(data);
    const subId = data.id;
    const guildId = String(custom.guildId || '');
    if (!guildId) return; // unknown guild - ignore (probably not our checkout)

    switch (eventName) {
      case 'subscription_created':
        registry.emitEvent({
          type: 'subscription.created',
          providerId: this.id,
          providerSubId: subId,
          guildId,
          tierId: String(custom.tierId || ''),
          offeringId: String(custom.offeringId || ''),
          variantId: String(custom.variantId || data.attributes.variant_id),
          couponCode: custom.couponCode ? String(custom.couponCode) : undefined,
          state,
        });
        return;
      case 'subscription_updated':
      case 'subscription_resumed':
      case 'subscription_unpaused':
        registry.emitEvent({
          type: 'subscription.updated',
          providerId: this.id, providerSubId: subId, guildId, state,
        });
        return;
      case 'subscription_paused':
        registry.emitEvent({
          type: 'subscription.paused',
          providerId: this.id, providerSubId: subId, guildId,
          resumesAt: data.attributes.pause?.resumes_at ?? null,
        });
        return;
      case 'subscription_cancelled':
      case 'subscription_expired':
        registry.emitEvent({
          type: 'subscription.expired',
          providerId: this.id, providerSubId: subId, guildId, state,
        });
        return;
      case 'subscription_payment_success':
        registry.emitEvent({
          type: 'subscription.renewed',
          providerId: this.id, providerSubId: subId, guildId, state,
        });
        return;
      case 'subscription_payment_failed':
        registry.emitEvent({
          type: 'subscription.renewal-failed',
          providerId: this.id, providerSubId: subId, guildId,
        });
        return;
      default:
        return;
    }
  }

  // ============================================================================
  // INTERNALS
  // ============================================================================

  private normalizeVariant(v: LSResource<LSVariantAttrs>): OfferingVariant {
    const a = v.attributes;
    const intervalDays = (() => {
      if (!a.is_subscription || !a.interval) return null;
      const count = a.interval_count || 1;
      switch (a.interval) {
        case 'day': return count;
        case 'week': return 7 * count;
        case 'month': return 30 * count;
        case 'year': return 365 * count;
      }
    })();
    return {
      variantId: v.id,
      label: a.name,
      amount: a.price,
      currency: 'USD', // LS variants don't always carry currency on the resource; default to USD
      durationDays: intervalDays,
      ...(a.has_free_trial && a.trial_interval ? {
        trialDays: this.intervalToDays(a.trial_interval, a.trial_interval_count || 1),
      } : {}),
      recurring: !!a.is_subscription,
      active: a.status === 'published',
    };
  }

  private intervalToDays(interval: string, count: number): number {
    switch (interval) {
      case 'day': return count;
      case 'week': return 7 * count;
      case 'month': return 30 * count;
      case 'year': return 365 * count;
    }
    return count;
  }

  private stateFromSubscription(sub: LSResource<LSSubscriptionAttrs>): ProviderSubscriptionState {
    const a = sub.attributes;
    let status: ProviderSubscriptionState['status'] = 'active';
    if (a.status === 'expired' || a.status === 'cancelled' || a.status === 'unpaid') status = 'expired';
    else if (a.pause || a.status === 'paused') status = 'paused';
    return {
      status,
      startDate: new Date().toISOString(), // LS doesn't echo a clean start; use now as a fallback
      endDate: a.ends_at || a.renews_at || null,
      autoRenew: !a.cancelled,
      meta: { lemonSqueezyStatus: a.status, customer: a.customer_id, variant: a.variant_id },
    };
  }

  private async api<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: any): Promise<T | null> {
    const res = await this.apiRaw(method, path, body);
    if (res.status === 204) return null;
    const text = await res.text();
    let parsed: any = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { /* leave null */ }
    }
    if (res.status >= 400) {
      const msg = parsed?.errors?.[0]?.detail || `Lemon Squeezy API ${method} ${path} -> ${res.status}`;
      throw new Error(msg);
    }
    return parsed as T;
  }

  private async apiRaw(method: string, path: string, body?: any): Promise<Response> {
    const c = loadCredentials();
    if (!c.LEMONSQUEEZY_API_KEY) throw new Error('Lemon Squeezy not configured');
    const init: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${c.LEMONSQUEEZY_API_KEY}`,
        'Accept': 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return await fetch(`${LS_API_BASE}${path}`, init);
  }
}
