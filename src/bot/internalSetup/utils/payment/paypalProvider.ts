/**
 * PayPalProvider - direct HTTP against PayPal Subscriptions API.
 *
 * Configuration:
 *   - PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET (OAuth2 client credentials)
 *   - PAYPAL_WEBHOOK_ID (registered webhook id; used to verify-webhook-signature)
 *   - PAYPAL_ENV ('sandbox' | 'live'; defaults to 'sandbox')
 *
 * Mechanism: redirect. We POST a Subscription with plan_id (= our variantId
 * in Price mode), follow PayPal's `approve` link to send the user to PayPal,
 * then BILLING.SUBSCRIPTION.* webhooks reconcile.
 *
 * Webhook signature: PayPal recommends posting back the webhook payload to
 * /v1/notifications/verify-webhook-signature; that's what we do (RSA-SHA256
 * cert verification client-side is brittle). The verify endpoint requires
 * an OAuth bearer token from /v1/oauth2/token (cached).
 *
 * Plan price MUTABILITY: PayPal lets the merchant change a plan's price
 * via /v1/billing/plans/{id}/update-pricing-schemes. We DO NOT expose that
 * affordance in our admin UI - prices changing under a subscriber's feet
 * is a chargeback magnet. Drift detection: every sync we compare cached
 * variant.amount with the latest plan price; mismatch surfaces a warning.
 *
 * Migration: PayPal "revise" returns a new approve URL the user must visit.
 * We DM the URL via subscription notifier. There's no decline/timeout
 * webhook - if the user doesn't approve within the window, we poll on the
 * effective date and treat un-approved as "declined".
 */

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
  CredentialFieldDef,
} from './paymentTypes';

const CAPABILITIES: ProviderCapabilities = {
  canInitiatePurchase: true,
  supportsCancel: true,
  supportsReactivate: false,        // PayPal subs are not reactivatable once cancelled
  supportsCoupons: false,           // PayPal coupon support is plan-attached, not user-input
  supportsPause: true,              // suspend/activate
  supportsMultipleVariants: true,
  supportsProductMode: true,        // PayPal Products group Plans
  supportsHostedPicker: false,      // no hosted multi-plan picker
  supportsCustomerPortal: false,    // PayPal manages billing in account.paypal.com directly
  supportsAnnualBilling: true,
  supportsPriceMigration: true,     // via revise
  mechanism: 'redirect',
  variantIdLabel: 'PayPal Plan ID',
  productIdLabel: 'PayPal Product ID',
};

function paypalApiBase(): string {
  const env = loadCredentials().PAYPAL_ENV || 'sandbox';
  return env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

interface PayPalToken { access_token: string; expires_at: number; }

export class PayPalProvider implements PaymentProvider {
  readonly id = 'paypal';
  readonly displayName = 'PayPal';
  readonly capabilities = CAPABILITIES;

  private tokenCache: PayPalToken | null = null;

  isConfigured(): boolean {
    const c = loadCredentials();
    return !!(c.PAYPAL_CLIENT_ID && c.PAYPAL_CLIENT_SECRET && c.PAYPAL_WEBHOOK_ID);
  }

  getCredentialFields(): CredentialFieldDef[] {
    return [
      {
        key: 'PAYPAL_ENV',
        label: 'Environment',
        type: 'select',
        options: [
          { value: 'sandbox', label: 'Sandbox (testing)' },
          { value: 'live', label: 'Live (production)' },
        ],
        helpText: 'Sandbox uses api-m.sandbox.paypal.com; live uses api-m.paypal.com.',
      },
      {
        key: 'PAYPAL_CLIENT_ID',
        label: 'Client ID',
        type: 'text',
        placeholder: 'AYx... or AcZ...',
        helpText: 'PayPal Developer Dashboard - Apps & Credentials - your app - Client ID.',
      },
      {
        key: 'PAYPAL_CLIENT_SECRET',
        label: 'Client Secret',
        type: 'secret',
        placeholder: 'EH... long string',
        helpText: 'Same app page as Client ID. Click "Show" next to Secret to reveal.',
      },
      {
        key: 'PAYPAL_WEBHOOK_ID',
        label: 'Webhook ID',
        type: 'text',
        placeholder: '8PT... 17 chars',
        helpText: 'Created in PayPal dashboard when you register your webhook URL. Required to verify incoming webhook signatures.',
      },
      {
        key: 'WEBUI_BASE_URL',
        label: 'Web UI Base URL',
        type: 'url',
        placeholder: 'https://your-bot.example.com',
        helpText: 'Public base URL of this Web UI. Used to build PayPal return/cancel URLs and OAuth callbacks.',
        optional: true,
      },
    ];
  }

  async initiatePurchase(opts: InitiateOpts): Promise<InitiateResult> {
    const c = loadCredentials();
    if (!this.isConfigured()) throw new Error('PayPal not configured');
    const returnUrl = c.WEBUI_BASE_URL
      ? `${c.WEBUI_BASE_URL}/guild/${encodeURIComponent(opts.guildId)}/subscription?subscribe=success`
      : `https://example.invalid/subscribe-success`;
    const cancelUrl = c.WEBUI_BASE_URL
      ? `${c.WEBUI_BASE_URL}/guild/${encodeURIComponent(opts.guildId)}/subscription?subscribe=cancel`
      : `https://example.invalid/subscribe-cancel`;

    const body = {
      plan_id: opts.variantId,
      custom_id: JSON.stringify({
        guildId: opts.guildId,
        tierId: opts.tierId,
        offeringId: opts.offeringId,
        ...(opts.userId ? { userId: opts.userId } : {}),
      }),
      application_context: {
        brand_name: 'Discord Bot Premium',
        user_action: 'SUBSCRIBE_NOW',
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    };
    const sub = await this.api<any>('POST', '/v1/billing/subscriptions', body);
    const approveLink = (sub?.links || []).find((l: any) => l.rel === 'approve');
    if (!approveLink?.href) throw new Error('PayPal did not return an approve URL.');
    return { redirectUrl: approveLink.href, providerSubId: sub.id };
  }

  async listVariants(productId: string): Promise<OfferingVariant[]> {
    const data = await this.api<{ plans?: any[] }>('GET',
      `/v1/billing/plans?product_id=${encodeURIComponent(productId)}&page_size=20&total_required=true`);
    const plans = data?.plans || [];
    const out: OfferingVariant[] = [];
    for (const p of plans) {
      const detail = await this.fetchVariant(p.id);
      if (detail) out.push(detail);
    }
    return out;
  }

  async fetchVariant(planId: string): Promise<OfferingVariant | null> {
    const plan = await this.api<any>('GET', `/v1/billing/plans/${encodeURIComponent(planId)}`);
    if (!plan) return null;
    const cycle = (plan.billing_cycles || [])
      .find((c: any) => c.tenure_type === 'REGULAR') || plan.billing_cycles?.[0];
    const price = cycle?.pricing_scheme?.fixed_price;
    const interval = cycle?.frequency?.interval_unit;
    const intervalCount = cycle?.frequency?.interval_count || 1;
    const days = (() => {
      switch (interval) {
        case 'DAY': return intervalCount;
        case 'WEEK': return 7 * intervalCount;
        case 'MONTH': return 30 * intervalCount;
        case 'YEAR': return 365 * intervalCount;
        default: return null;
      }
    })();
    return {
      variantId: plan.id,
      label: plan.name || plan.id,
      amount: price ? Math.round(parseFloat(price.value) * 100) : 0,
      currency: price?.currency_code || 'USD',
      durationDays: days,
      recurring: true,
      active: plan.status === 'ACTIVE',
    };
  }

  async cancelSubscription(providerSubId: string, _immediately?: boolean): Promise<void> {
    await this.api<unknown>('POST', `/v1/billing/subscriptions/${encodeURIComponent(providerSubId)}/cancel`,
      { reason: 'cancelled by user' });
  }

  async pauseSubscription(providerSubId: string, _resumesAt: string | null): Promise<void> {
    await this.api<unknown>('POST', `/v1/billing/subscriptions/${encodeURIComponent(providerSubId)}/suspend`,
      { reason: 'paused by stacking' });
  }

  async resumeSubscription(providerSubId: string, _newEndDate: string | null): Promise<void> {
    await this.api<unknown>('POST', `/v1/billing/subscriptions/${encodeURIComponent(providerSubId)}/activate`,
      { reason: 'resumed from queue' });
  }

  /**
   * Migration: PayPal "revise" issues a new approve URL the user must visit.
   * This violates our usual silent-apply expectation; PremiumManager treats
   * the migration as conditional on the user re-approving. For now we
   * surface the approve URL via the subscription notifier and rely on a
   * subsequent BILLING.SUBSCRIPTION.UPDATED webhook to confirm.
   */
  async migrateSubscriptionPrice(providerSubId: string, newVariantId: string, _proration: 'none' | 'create_prorations'): Promise<void> {
    const result = await this.api<any>('POST', `/v1/billing/subscriptions/${encodeURIComponent(providerSubId)}/revise`,
      { plan_id: newVariantId });
    const approveLink = (result?.links || []).find((l: any) => l.rel === 'approve');
    if (!approveLink?.href) {
      // Some flows complete server-side; if no approve link, treat as immediate.
      return;
    }
    // TODO: surface approve URL to subscriber via notifier + record on the
    // Migration record so the UI can show it. For now, log so the operator
    // can hand-deliver during testing.
    console.warn(`[PayPalProvider] revise needs approval: ${approveLink.href}`);
  }

  async getSubscriptionState(providerSubId: string): Promise<ProviderSubscriptionState | null> {
    const sub = await this.api<any>('GET', `/v1/billing/subscriptions/${encodeURIComponent(providerSubId)}`);
    return sub ? this.stateFromSubscription(sub) : null;
  }

  async listSubscriptionsForGuild(_guildId: string): Promise<ProviderSubscriptionRef[]> {
    // PayPal doesn't index by our custom_id. Orphan adoption requires
    // walking ALL subs which is impractical at scale; rely on webhooks.
    return [];
  }

  async handleWebhook(rawBody: Buffer, _signature: string, headers: Record<string, string>): Promise<void> {
    const c = loadCredentials();
    if (!c.PAYPAL_WEBHOOK_ID) throw new Error('PAYPAL_WEBHOOK_ID not configured');
    const event = JSON.parse(rawBody.toString('utf-8'));

    // Signature verification via PayPal's verify-webhook-signature endpoint.
    const verifyBody = {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: c.PAYPAL_WEBHOOK_ID,
      webhook_event: event,
    };
    const verify = await this.api<{ verification_status: string }>('POST',
      '/v1/notifications/verify-webhook-signature', verifyBody);
    if (verify?.verification_status !== 'SUCCESS') {
      throw new Error('PayPal webhook signature verification failed');
    }

    const resource = event?.resource || {};
    const subId = String(resource.id || '');
    const customId = (() => {
      try { return JSON.parse(resource.custom_id || '{}'); } catch { return {}; }
    })();
    const guildId = String(customId.guildId || '');
    if (!guildId || !subId) return;

    const registry = getPaymentRegistry();
    const state = this.stateFromSubscription(resource);
    switch (event.event_type) {
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
      case 'BILLING.SUBSCRIPTION.CREATED':
        registry.emitEvent({
          type: 'subscription.created',
          providerId: this.id,
          providerSubId: subId,
          guildId,
          tierId: String(customId.tierId || ''),
          offeringId: String(customId.offeringId || ''),
          variantId: String(resource.plan_id || ''),
          state,
        });
        return;
      case 'BILLING.SUBSCRIPTION.UPDATED':
        registry.emitEvent({ type: 'subscription.updated', providerId: this.id, providerSubId: subId, guildId, state });
        return;
      case 'BILLING.SUBSCRIPTION.CANCELLED':
      case 'BILLING.SUBSCRIPTION.EXPIRED':
        registry.emitEvent({ type: 'subscription.expired', providerId: this.id, providerSubId: subId, guildId, state });
        return;
      case 'BILLING.SUBSCRIPTION.SUSPENDED':
        registry.emitEvent({
          type: 'subscription.paused', providerId: this.id, providerSubId: subId, guildId, resumesAt: null,
        });
        return;
      case 'PAYMENT.SALE.COMPLETED':
        registry.emitEvent({ type: 'subscription.renewed', providerId: this.id, providerSubId: subId, guildId, state });
        return;
      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
        registry.emitEvent({
          type: 'subscription.renewal-failed', providerId: this.id, providerSubId: subId, guildId,
        });
        return;
      default:
        return;
    }
  }

  // ============================================================================
  // INTERNALS
  // ============================================================================

  private stateFromSubscription(sub: any): ProviderSubscriptionState {
    const status = sub.status as string;
    let mapped: ProviderSubscriptionState['status'] = 'active';
    if (status === 'CANCELLED' || status === 'EXPIRED') mapped = 'expired';
    else if (status === 'SUSPENDED') mapped = 'paused';
    return {
      status: mapped,
      startDate: sub.start_time || sub.create_time || new Date().toISOString(),
      endDate: sub.billing_info?.next_billing_time || null,
      autoRenew: status === 'ACTIVE',
      meta: { paypalStatus: status, planId: sub.plan_id },
    };
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expires_at > Date.now() + 60_000) {
      return this.tokenCache.access_token;
    }
    const c = loadCredentials();
    if (!c.PAYPAL_CLIENT_ID || !c.PAYPAL_CLIENT_SECRET) throw new Error('PayPal not configured');
    const auth = Buffer.from(`${c.PAYPAL_CLIENT_ID}:${c.PAYPAL_CLIENT_SECRET}`).toString('base64');
    const res = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`PayPal OAuth failed: ${res.status}`);
    const data: any = await res.json();
    this.tokenCache = {
      access_token: data.access_token,
      expires_at: Date.now() + (data.expires_in * 1000),
    };
    return data.access_token;
  }

  private async api<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: any): Promise<T | null> {
    const token = await this.getAccessToken();
    const init: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${paypalApiBase()}${path}`, init);
    if (res.status === 204) return null;
    const text = await res.text();
    let parsed: any = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { /* leave null */ }
    }
    if (res.status >= 400) {
      const msg = parsed?.message || parsed?.error_description || `PayPal API ${method} ${path} -> ${res.status}`;
      throw new Error(msg);
    }
    return parsed as T;
  }
}
