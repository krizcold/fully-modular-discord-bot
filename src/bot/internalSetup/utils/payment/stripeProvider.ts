/**
 * StripeProvider - direct HTTP against Stripe REST API; the `stripe` package only verifies webhooks.
 *
 * Configuration: STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET env vars. Without
 * them `isConfigured()` returns false and offerings wired through Stripe
 * stay hidden in the guild subscribe UI.
 *
 * State ownership: Stripe is the source of truth for subscriptions.
 * PremiumManager caches the active/paused subscription records and the
 * webhook handler emits events that mirror Stripe's lifecycle into the
 * cache. The bot's own file is payment-providers/stripe/customers.json
 * (each member's Stripe Customer), kept by stripeCustomers.ts.
 */

import { PROVIDER_FETCH_MS } from './paymentTypes';
import { providerCredentials } from '@/utils/envLoader';
import { getPaymentRegistry } from './paymentRegistry';
import { holderWords, isDiscordId, notHolderText, parseHolder, type HolderKey } from '../premiumHolder';
import { customerFor, forgetCustomer, recordedCustomer, StripeApiError, StripeNotCalled } from './stripeCustomers';
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
const SIGNATURE_TOLERANCE_S = 300;

let stripePackage: any = null;

/** The stripe package's static webhooks, loaded at the first verification so no other path loads the package. */
function stripeWebhooks(): { constructEvent(payload: Buffer, header: string, secret: string, tolerance: number): any } {
  stripePackage ??= require('stripe');
  return stripePackage.webhooks;
}

/** The verified event of a delivery; throws SW3 with no secret, SW1 when constructEvent refuses it. */
function verifiedEvent(rawBody: Buffer, header: string | undefined): any {
  const secret = providerCredentials('stripe').STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('Stripe webhook refused: STRIPE_WEBHOOK_SECRET is not set.');
  try {
    return stripeWebhooks().constructEvent(rawBody, header ?? '', secret, SIGNATURE_TOLERANCE_S);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
    throw new Error(`Stripe webhook refused: ${message}.`);
  }
}

/** The holder a Stripe object's metadata names, and its buyer; an object with no `holder` key names none. */
function ownerOf(metadata: Record<string, string> | null | undefined): { holder: HolderKey | null; buyerId: string | undefined } {
  return {
    holder: parseHolder(metadata?.holder)?.key ?? null,
    buyerId: isDiscordId(metadata?.buyerId) ? metadata!.buyerId : undefined,
  };
}

const sentence = (text: string): string => text.trim().replace(/\.+$/, '');
const ST8 = 'The Stripe billing account the bot recorded for you no longer exists at Stripe; the bot is removing its record. Try again in a moment to start a new one. Nothing was charged.';

function safeIso(epochSeconds: number | null | undefined): string | null {
  if (typeof epochSeconds !== 'number' || !isFinite(epochSeconds) || epochSeconds <= 0) return null;
  return new Date(epochSeconds * 1000).toISOString();
}

/** metadata[pausedDaysLeft] is `<days>@<unix seconds of the pause>`; any other text records nothing. */
function pausedDaysLeftOf(raw: string | undefined): { pausedDaysLeft?: number; pausedAt?: string } {
  const match = typeof raw === 'string' ? /^(\d+)@(\d+)$/.exec(raw) : null;
  const at = match ? new Date(Number(match[2]) * 1000) : null;
  if (!match || !at || !Number.isFinite(at.getTime())) return {};
  return { pausedDaysLeft: Number(match[1]), pausedAt: at.toISOString() };
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
  supportsCustomerPortal: true,
  supportsAnnualBilling: true,
  supportsPriceMigration: true,
  mechanism: 'redirect',
  variantIdLabel: 'Stripe Price ID',
  productIdLabel: 'Stripe Product ID',
  sells: ['guild', 'user'],
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
  latest_invoice?: string | { id: string } | null;
  items?: {
    data: Array<{
      id: string;
      current_period_start?: number;
      current_period_end?: number;
      price?: StripePrice;
    }>;
  };
}

interface StripeCharge {
  id: string;
  amount: number;
  amount_refunded: number;
  refunded: boolean;
  currency?: string;
  invoice?: string | StripeInvoice | null;
  payment_intent?: string | { id: string } | null;
}

interface StripeInvoice {
  id: string;
  subscription?: string | { id: string } | null;
  last_finalization_error?: { message?: string } | null;
}

/** A Checkout Session read with `expand[]=payment_intent.latest_charge`. */
interface StripeSessionRead {
  id: string;
  created?: number;
  payment_status?: 'paid' | 'unpaid' | 'no_payment_required';
  subscription?: string | { id: string } | null;
  payment_intent?: string | { id: string; latest_charge?: string | StripeCharge | null } | null;
  metadata?: Record<string, string>;
}

/** A webhook's read found no such object at Stripe: permanent, answered 200 with SL9. */
class StripeObjectMissing extends Error {
  constructor(readonly object: string, readonly objectId: string, readonly detail: string) {
    super(`Stripe has no ${object} ${objectId} (${detail})`);
  }
}

/** The id of a Stripe reference, expanded or not. */
function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (typeof ref === 'string') return ref || null;
  return ref && typeof ref.id === 'string' ? ref.id : null;
}

const moneyWords = (minor: number): string => (Number(minor || 0) / 100).toFixed(2);

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
    const c = providerCredentials('stripe');
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
    const holder = parseHolder(opts.holder);
    if (!holder) throw new Error(notHolderText(opts.holder));
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
    let customer: string | undefined;
    if (opts.buyerSignedIn) {
      if (!isDiscordId(opts.buyerId)) throw new Error('Stripe checkout did not start: the signed-in buyer has no Discord id. Nothing was charged.');
      customer = await customerFor(opts.buyerId, this.api.bind(this));
    }
    // A user's checkout returns to the member page's server list until the "My account" page exists.
    const page = holder.kind === 'guild' ? `${successBase}/guild/${encodeURIComponent(holder.id)}/subscription` : `${successBase}/guild`;
    const metadata: Record<string, string> = {
      holder: holder.key,
      buyerId: opts.buyerId || '',
      tierId: opts.tierId,
      offeringId: opts.offeringId,
      variantId: opts.variantId,
      couponCode: opts.couponCode || '',
    };
    const params: Record<string, string> = {
      mode: isSubscription ? 'subscription' : 'payment',
      'line_items[0][price]': opts.variantId,
      'line_items[0][quantity]': '1',
      success_url: `${page}?subscribe=success&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${page}?subscribe=cancel`,
      ...(customer ? { customer } : {}),
      client_reference_id: `${holder.key}:${opts.tierId}:${opts.offeringId}`,
    };
    for (const [key, value] of Object.entries(metadata)) params[`metadata[${key}]`] = value;

    if (isSubscription) {
      for (const [key, value] of Object.entries(metadata)) params[`subscription_data[metadata][${key}]`] = value;
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

    let session: StripeSession;
    try {
      session = await this.api<StripeSession>('POST', '/v1/checkout/sessions', params);
    } catch (error) {
      if (error instanceof StripeNotCalled) throw new Error(`Stripe did not start the checkout: ${sentence(error.message)}. Nothing was charged.`);
      if (error instanceof StripeApiError && error.status !== null && error.status < 500) {
        if (customer && error.code === 'resource_missing' && error.param === 'customer') {
          await forgetCustomer(opts.buyerId!, customer);
          throw new Error(ST8);
        }
        throw new Error(`Stripe did not start the checkout: ${sentence(error.message)}. Nothing was charged.`);
      }
      const reason = error instanceof StripeApiError && error.status !== null ? `Stripe answered ${error.status}` : sentence(error instanceof Error ? error.message : String(error));
      throw new Error(`Can't confirm whether Stripe started a checkout (${reason}). Nothing is charged until a checkout is paid; try again.`);
    }
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
    const result = await this.api<{ data: StripePromotionCode[] }>(
      'GET',
      `/v1/promotion_codes?code=${encodeURIComponent(trimmed)}&active=true&limit=1`,
    );
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

  webhookEventId(rawBody: Buffer, headers: Record<string, string>): string | null {
    try {
      const id = verifiedEvent(rawBody, headers['stripe-signature'])?.id;
      return typeof id === 'string' && id !== '' ? id : null;
    } catch {
      return null;
    }
  }

  /**
   * Every handled event reads its object again from the API at the pinned version; the payload gives only the event's
   * type and the object's id. Handlings about one subscription (or one-time purchase) run one at a time.
   */
  async handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
    const event = verifiedEvent(rawBody, signature) as { type: string; data?: { object?: { id?: unknown } } };
    const objectId = event.data?.object?.id;
    if (typeof objectId !== 'string' || objectId === '') return;
    try {
      switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
          return await this.onCheckoutPaid(event.type, objectId);
        case 'checkout.session.async_payment_failed':
          console.log(`[StripeProvider] Checkout ${objectId} ended without payment (${event.type}); nothing was installed.`);
          return;
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
        case 'customer.subscription.paused':
        case 'customer.subscription.resumed':
          return await this.inChain(objectId, () => this.onSubscriptionState(event.type, objectId));
        case 'invoice.paid':
        case 'invoice.payment_failed':
          return await this.onInvoice(event.type, objectId);
        case 'charge.refunded':
          return await this.onRefund(event.type, objectId);
        default:
          return;
      }
    } catch (error) {
      if (!(error instanceof StripeObjectMissing)) throw error;
      console.warn(`[StripeProvider] A ${event.type} event was not applied: Stripe has no ${error.object} ${error.objectId} (${error.detail}).`);
    }
  }

  /** The chains of handlings by Stripe subscription id (a session id for a one-time purchase). */
  private readonly chains = new Map<string, Promise<void>>();
  /** SL1 and SL3 are logged once per object (and price) in this process. */
  private readonly logged = new Set<string>();

  /** Runs `fn` after every earlier handling chained on `key` has ended. */
  private async inChain<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = this.chains.get(key) ?? Promise.resolve();
    let done!: () => void;
    const mine = new Promise<void>(resolve => { done = resolve; });
    const tail = before.then(() => mine);
    this.chains.set(key, tail);
    try {
      await before;
      return await fn();
    } finally {
      done();
      if (this.chains.get(key) === tail) this.chains.delete(key);
    }
  }

  private logOnce(key: string, line: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    console.warn(line);
  }

  /** The holder an object's metadata names; logs SL1 once and answers null when it names none. */
  private holderOrSkip(type: string, object: string, id: string, metadata: Record<string, string> | null | undefined): ReturnType<typeof ownerOf> | null {
    const owner = ownerOf(metadata);
    if (owner.holder) return owner;
    this.logOnce(`holder\u0000${object}\u0000${id}`, `[StripeProvider] A ${type} event for ${object} ${id} was not applied: its metadata names no holder. It was made before this version or not by this bot; the bot does not manage it.`);
    return null;
  }

  /**
   * One read of Stripe for a webhook. A 404 or a `resource_missing` error is permanent (StripeObjectMissing, answered
   * 200 with SL9); any other failure throws SW2, which the op answers 400 so Stripe sends the event again.
   */
  private async readFor<T>(object: string, id: string, path: string, method: 'GET' | 'DELETE' = 'GET'): Promise<T> {
    try {
      return await this.api<T>(method, path);
    } catch (error) {
      if (error instanceof StripeApiError && (error.status === 404 || error.code === 'resource_missing')) {
        throw new StripeObjectMissing(object, id, error.code ?? String(error.status));
      }
      const reason = error instanceof StripeApiError && error.status !== null ? `Stripe answered ${error.status}` : sentence(error instanceof Error ? error.message : String(error));
      if (method === 'DELETE' && !(error instanceof StripeNotCalled) && (!(error instanceof StripeApiError) || error.status === null || error.status >= 500)) {
        throw new Error(`Stripe webhook not applied: can't confirm whether Stripe cancelled ${object} ${id} (${reason}); Stripe sends the event again.`);
      }
      const verb = method === 'DELETE' ? 'cancel' : 'read';
      throw new Error(`Stripe webhook not applied: the bot could not ${verb} ${object} ${id} ${method === 'DELETE' ? 'at' : 'from'} Stripe (${reason}); Stripe sends the event again.`);
    }
  }

  private readSubscription(id: string): Promise<StripeSubscription> {
    return this.readFor<StripeSubscription>('subscription', id, `/v1/subscriptions/${encodeURIComponent(id)}?expand[]=items.data.price`);
  }

  private readSession(id: string): Promise<StripeSessionRead> {
    return this.readFor<StripeSessionRead>('checkout session', id, `/v1/checkout/sessions/${encodeURIComponent(id)}?expand[]=payment_intent.latest_charge`);
  }

  /** `checkout.session.completed` and `.async_payment_succeeded`: installs a paid checkout. */
  private async onCheckoutPaid(type: string, sessionId: string): Promise<void> {
    await this.inChain(sessionId, async () => {
      const session = await this.readSession(sessionId);
      if (session.payment_status === 'unpaid') return;
      if (!this.holderOrSkip(type, 'checkout session', session.id, session.metadata)) return;
      const subscriptionId = idOf(session.subscription);
      if (subscriptionId) {
        await this.inChain(subscriptionId, () => this.installSubscription(type, session, subscriptionId));
        return;
      }
      const charge = typeof session.payment_intent === 'object' && session.payment_intent ? session.payment_intent.latest_charge : null;
      if (charge && typeof charge === 'object' && charge.refunded === true) {
        console.log(`[StripeProvider] Checkout ${session.id} completed for a one-time purchase whose payment was refunded in full; nothing was installed.`);
        return;
      }
      const meta = session.metadata || {};
      const owner = ownerOf(meta);
      if (!meta.tierId || !meta.offeringId) {
        console.warn(`[StripeProvider] Checkout ${session.id} names no tier or offering in its metadata; nothing was installed.`);
        return;
      }
      const variantId = meta.variantId || undefined;
      const variantSnapshot = variantId ? (await this.fetchVariant(variantId).catch(() => null)) ?? undefined : undefined;
      getPaymentRegistry().emitEvent({
        type: 'subscription.created',
        providerId: this.id,
        providerSubId: session.id,
        holder: owner.holder!,
        buyerId: owner.buyerId,
        tierId: meta.tierId,
        offeringId: meta.offeringId,
        variantId,
        couponCode: meta.couponCode || undefined,
        state: {
          status: 'active',
          startDate: safeIso(session.created) ?? new Date().toISOString(),
          endDate: null,
          autoRenew: false,
          meta: { sessionId: session.id, paymentIntent: idOf(session.payment_intent) },
        },
        variantSnapshot,
      });
    });
  }

  private async installSubscription(type: string, session: StripeSessionRead, subscriptionId: string): Promise<void> {
    const sub = await this.readSubscription(subscriptionId);
    const owner = this.holderOrSkip(type, 'subscription', sub.id, sub.metadata);
    if (!owner) return;
    const state = this.stateFromSubscription(sub);
    if (state.status === 'expired') {
      console.log(`[StripeProvider] Checkout ${session.id} completed for subscription ${sub.id}, which had already ended at Stripe; nothing was installed.`);
      return;
    }
    const meta = sub.metadata || {};
    if (!meta.tierId || !meta.offeringId) {
      console.warn(`[StripeProvider] Subscription ${sub.id} names no tier or offering in its metadata; nothing was installed.`);
      return;
    }
    const item = sub.items?.data?.[0];
    getPaymentRegistry().emitEvent({
      type: 'subscription.created',
      providerId: this.id,
      providerSubId: sub.id,
      holder: owner.holder!,
      buyerId: owner.buyerId,
      tierId: meta.tierId,
      offeringId: meta.offeringId,
      variantId: meta.variantId || undefined,
      couponCode: meta.couponCode || undefined,
      state,
      variantSnapshot: item?.price ? this.normalizePrice(item.price) ?? undefined : undefined,
    });
  }

  /** A state event: the subscription's current state, expired when it maps to expired. */
  private async onSubscriptionState(type: string, subscriptionId: string): Promise<void> {
    const sub = await this.readSubscription(subscriptionId);
    const owner = this.holderOrSkip(type, 'subscription', sub.id, sub.metadata);
    if (!owner) return;
    const price = sub.items?.data?.[0]?.price?.id;
    const sold = sub.metadata?.variantId;
    if (price && sold && price !== sold) {
      this.logOnce(`price\u0000${sub.id}\u0000${price}`, `[StripeProvider] Subscription ${sub.id} now charges price ${price}, not ${sold} that the bot sold it with; the bot keeps giving tier '${sub.metadata?.tierId ?? ''}'. Turn off plan switching in the Stripe customer portal settings.`);
    }
    const state = this.stateFromSubscription(sub);
    getPaymentRegistry().emitEvent({
      type: state.status === 'expired' ? 'subscription.expired' : 'subscription.updated',
      providerId: this.id,
      providerSubId: sub.id,
      holder: owner.holder!,
      state,
    });
  }

  /** `invoice.paid` and `invoice.payment_failed`: the invoice, then its subscription. */
  private async onInvoice(type: string, invoiceId: string): Promise<void> {
    const invoice = await this.readFor<StripeInvoice>('invoice', invoiceId, `/v1/invoices/${encodeURIComponent(invoiceId)}`);
    const subscriptionId = idOf(invoice.subscription);
    if (!subscriptionId) return;
    await this.inChain(subscriptionId, async () => {
      const sub = await this.readSubscription(subscriptionId);
      const owner = this.holderOrSkip(type, 'subscription', sub.id, sub.metadata);
      if (!owner) return;
      if (type === 'invoice.paid') {
        getPaymentRegistry().emitEvent({ type: 'subscription.renewed', providerId: this.id, providerSubId: sub.id, holder: owner.holder!, state: this.stateFromSubscription(sub) });
        return;
      }
      // Stripe owns the dunning retries; premium only sends the notice, and Stripe's end of the subscription arrives
      // as its own event.
      getPaymentRegistry().emitEvent({
        type: 'subscription.renewal-failed', providerId: this.id, providerSubId: sub.id, holder: owner.holder!, reason: invoice.last_finalization_error?.message,
      });
    });
  }

  /**
   * `charge.refunded`: a full refund of a subscription's latest invoice cancels it at Stripe (unless it already maps
   * to expired) and ends it in the bot; a full refund of a one-time purchase ends it in the bot; any other refund
   * changes nothing.
   */
  private async onRefund(type: string, chargeId: string): Promise<void> {
    const charge = await this.readFor<StripeCharge>('charge', chargeId, `/v1/charges/${encodeURIComponent(chargeId)}?expand[]=invoice`);
    const refundWords = `${moneyWords(charge.amount_refunded)} of ${moneyWords(charge.amount)} ${String(charge.currency ?? '').toUpperCase()}`;
    const invoice = charge.invoice && typeof charge.invoice === 'object' ? charge.invoice : null;
    if (charge.invoice) {
      const invoiceId = invoice ? invoice.id : String(charge.invoice);
      const subscriptionId = idOf(invoice?.subscription);
      if (!subscriptionId) {
        console.warn(`[StripeProvider] Charge ${charge.id} was refunded; its invoice ${invoiceId} belongs to no subscription, so it was not made by the bot's checkout and the bot does not manage it.`);
        return;
      }
      await this.inChain(subscriptionId, async () => {
        let sub = await this.readSubscription(subscriptionId);
        const owner = this.holderOrSkip(type, 'subscription', sub.id, sub.metadata);
        if (!owner) return;
        if (charge.refunded !== true || idOf(sub.latest_invoice) !== invoiceId) {
          console.log(`[StripeProvider] Charge ${charge.id} was refunded (${refundWords}), and it is not a full refund of the latest payment of subscription ${sub.id}; the subscription stays.`);
          return;
        }
        if (this.stateFromSubscription(sub).status !== 'expired') {
          await this.readFor('subscription', sub.id, `/v1/subscriptions/${encodeURIComponent(sub.id)}`, 'DELETE');
          console.log(`[StripeProvider] Charge ${charge.id} was refunded in full; subscription ${sub.id} (${holderWords(owner.holder!)}) was cancelled at Stripe.`);
          sub = await this.readSubscription(sub.id);
        } else {
          console.log(`[StripeProvider] Charge ${charge.id} was refunded in full; subscription ${sub.id} (${holderWords(owner.holder!)}) was already cancelled at Stripe.`);
        }
        getPaymentRegistry().emitEvent({
          type: 'subscription.expired', providerId: this.id, providerSubId: sub.id, holder: owner.holder!, state: { ...this.stateFromSubscription(sub), status: 'expired' },
        });
      });
      return;
    }
    const paymentIntent = idOf(charge.payment_intent);
    const listed = 'checkout sessions of payment intent';
    if (!paymentIntent) throw new StripeObjectMissing(listed, '(none)', 'the charge names no payment intent');
    const list = await this.readFor<{ data: StripeSessionRead[] }>(listed, paymentIntent, `/v1/checkout/sessions?payment_intent=${encodeURIComponent(paymentIntent)}&limit=1`);
    const session = list.data?.[0];
    if (!session) throw new StripeObjectMissing(listed, paymentIntent, 'empty list');
    await this.inChain(session.id, async () => {
      const owner = this.holderOrSkip(type, 'checkout session', session.id, session.metadata);
      if (!owner) return;
      if (charge.refunded !== true) {
        console.log(`[StripeProvider] Charge ${charge.id} was refunded (${refundWords}), and it is not a full refund of the latest payment of checkout ${session.id}; the subscription stays.`);
        return;
      }
      const now = new Date().toISOString();
      getPaymentRegistry().emitEvent({
        type: 'subscription.expired',
        providerId: this.id,
        providerSubId: session.id,
        holder: owner.holder!,
        state: { status: 'expired', startDate: safeIso(session.created) ?? now, endDate: now, autoRenew: false, meta: { sessionId: session.id, paymentIntent } },
      });
      console.log(`[StripeProvider] Charge ${charge.id} was refunded in full; the purchase ${session.id} (${holderWords(owner.holder!)}) is ended in the bot.`);
    });
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
  async pauseSubscription(providerSubId: string, resumesAt: string | null, daysLeft?: number | null): Promise<void> {
    if (this.isOneTimeSubId(providerSubId)) return;

    const params: Record<string, string> = {
      'pause_collection[behavior]': 'void',
      proration_behavior: 'none',
    };
    if (daysLeft !== undefined) {
      // An empty value removes the key at Stripe.
      params['metadata[pausedDaysLeft]'] = daysLeft === null ? '' : `${Math.max(0, Math.floor(daysLeft))}@${Math.floor(Date.now() / 1000)}`;
    }

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
      'metadata[pausedDaysLeft]': '',
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
    if (result?.status === 'paused') {
      throw new Error(`Stripe subscription '${providerSubId}' is still paused by Stripe itself; resume or cancel it in the Stripe dashboard.`);
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
      'metadata[variantId]': newVariantId,
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

  async listSubscriptionsFor(holder: HolderKey): Promise<ProviderSubscriptionRef[]> {
    const parsed = parseHolder(holder);
    if (!parsed) return [];
    const key = parsed.key;
    const matching = new Map<string, StripeSubscription>();
    let searchCount = 0;
    let listTotal = 0;
    let listMatching = 0;
    const sampleNonMatch: Array<{ id: string; metaKeys: string[]; metaHolder: string | undefined }> = [];

    try {
      const query = `metadata['holder']:'${key}'`;
      let page: string | undefined;
      for (let i = 0; i < 5; i++) {
        const url = `/v1/subscriptions/search?query=${encodeURIComponent(query)}&limit=100`
          + (page ? `&page=${encodeURIComponent(page)}` : '');
        const result = await this.api<{ data: StripeSubscription[]; has_more: boolean; next_page?: string }>('GET', url);
        searchCount += (result.data || []).length;
        // A search answer is kept only when its metadata names this holder.
        for (const sub of result.data || []) if (sub.metadata?.holder === key) matching.set(sub.id, sub);
        if (!result.has_more || !result.next_page) break;
        page = result.next_page;
      }
    } catch (err: any) {
      console.warn(`[StripeProvider] subscriptions search failed for ${key} (continuing with list fallback): ${err?.message || err}`);
    }

    try {
      const result = await this.api<{ data: StripeSubscription[] }>('GET', '/v1/subscriptions?limit=100');
      listTotal = (result.data || []).length;
      for (const sub of result.data || []) {
        if (sub.metadata?.holder === key) {
          matching.set(sub.id, sub);
          listMatching++;
        } else if (sampleNonMatch.length < 3) {
          sampleNonMatch.push({
            id: sub.id,
            metaKeys: Object.keys(sub.metadata || {}),
            metaHolder: sub.metadata?.holder,
          });
        }
      }
    } catch (err: any) {
      console.warn(`[StripeProvider] subscriptions list failed for ${key}: ${err?.message || err}`);
    }

    const liveStatuses = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);
    const live = Array.from(matching.values()).filter(sub => liveStatuses.has(sub.status));
    console.log(
      `[StripeProvider] orphan-scan holder=${key}: `
      + `search=${searchCount} list=${listTotal} list-matching-holder=${listMatching} `
      + `dedup=${matching.size} live=${live.length}`
      + (sampleNonMatch.length > 0
        ? ` sample-non-matching=${JSON.stringify(sampleNonMatch)}`
        : ''),
    );
    return live.map(sub => this.refFromSubscription(sub));
  }

  async createBillingPortalSession(providerSubId: string, returnUrl: string, buyerId: string): Promise<{ portalUrl: string }> {
    if (this.isOneTimeSubId(providerSubId)) {
      throw new Error('Stripe one-time / Lifetime purchases have no recurring portal to manage.');
    }
    const notAnswered = (error: unknown): Error => {
      const message = error instanceof Error ? sentence(error.message) : String(error);
      if (error instanceof StripeNotCalled) return new Error(`The bot did not ask Stripe (${message}), so no billing portal was opened.`);
      if (!(error instanceof StripeApiError)) return new Error(`The bot could not read Stripe's answer (${message}), so no billing portal was opened. Try again.`);
      if (error.status === null) return new Error(`Stripe did not answer (${message}), so no billing portal was opened. Try again.`);
      return new Error(`Stripe answered ${error.status}, so no billing portal was opened. Try again.`);
    };
    let sub: StripeSubscription;
    try {
      sub = await this.api<StripeSubscription>('GET', `/v1/subscriptions/${encodeURIComponent(providerSubId)}`);
    } catch (error) {
      if (error instanceof StripeApiError && (error.status === 404 || error.code === 'resource_missing')) {
        throw new Error(`Stripe has no record of this subscription (${sentence(error.message)}), so no billing portal was opened.`);
      }
      if (error instanceof StripeApiError && error.status !== null && error.status < 500) {
        throw new Error(`Stripe refused to read this subscription: ${sentence(error.message)}. No billing portal was opened.`);
      }
      throw notAnswered(error);
    }
    if (ownerOf(sub.metadata).buyerId !== buyerId) {
      throw new Error("Stripe's record of this subscription does not name you as its payer, so no billing portal was opened.");
    }
    let recorded: string | null;
    try {
      recorded = recordedCustomer(buyerId);
    } catch (error) {
      throw new Error(`The billing portal did not open: the bot could not read its record of your Stripe billing account (${error instanceof Error ? sentence(error.message) : String(error)}).`);
    }
    const customerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer as any)?.id;
    if (!customerId || recorded !== customerId) {
      throw new Error("This subscription is not on the Stripe billing account the bot records for you (it may have been started from the bot's dev page), so no billing portal was opened.");
    }
    let result: { url?: string };
    try {
      result = await this.api<{ url: string }>('POST', '/v1/billing_portal/sessions', { customer: customerId, return_url: returnUrl });
    } catch (error) {
      if (error instanceof StripeApiError && error.status !== null && error.status < 500) throw new Error(`Stripe did not open the billing portal: ${sentence(error.message)}.`);
      throw notAnswered(error);
    }
    if (!result.url) throw new Error('Stripe billing_portal/sessions returned no url.');
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
        holder: ownerOf(sub.metadata).holder ?? undefined,
        tierId: sub.metadata?.tierId,
        offeringId: sub.metadata?.offeringId,
        variantId: sub.metadata?.variantId || price?.id,
        couponCode: sub.metadata?.couponCode || undefined,
        buyerId: ownerOf(sub.metadata).buyerId,
        ...pausedDaysLeftOf(sub.metadata?.pausedDaysLeft),
      },
      display: { amountLabel, periodLabel, statusLabel },
    };
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
      ...(sub.status === 'paused' ? { resumable: false as const } : {}),
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
    const c = providerCredentials('stripe');
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

  private async api<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, formBody?: Record<string, string>, idempotencyKey?: string): Promise<T> {
    const secret = providerCredentials('stripe').STRIPE_SECRET_KEY;
    if (!secret) throw new StripeNotCalled('STRIPE_SECRET_KEY is not set.');

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${secret}`,
      'Stripe-Version': STRIPE_API_VERSION,
    };

    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    let body: string | undefined;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = formBody ? new URLSearchParams(formBody).toString() : '';
    }

    let res: Response;
    let text: string;
    try {
      res = await fetch(`${STRIPE_API_BASE}${path}`, { method, headers, body, signal: AbortSignal.timeout(PROVIDER_FETCH_MS) });
      text = await res.text();
    } catch (error) {
      throw new StripeApiError(error instanceof Error ? error.message : String(error), null);
    }
    if (!res.ok) {
      let userMessage = `Stripe API ${res.status}`;
      let code: string | undefined;
      let param: string | undefined;
      if (text) {
        try {
          const parsed = JSON.parse(text);
          if (parsed?.error?.message) userMessage = parsed.error.message;
          if (typeof parsed?.error?.code === 'string') code = parsed.error.code;
          if (typeof parsed?.error?.param === 'string') param = parsed.error.param;
        } catch { /* not JSON; keep generic status */ }
      }
      throw new StripeApiError(userMessage, res.status, code, param);
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
