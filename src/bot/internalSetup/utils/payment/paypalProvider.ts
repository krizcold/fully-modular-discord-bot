/**
 * PayPalProvider: direct HTTP against PayPal's Subscriptions API.
 *
 * Configuration: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (OAuth2 client credentials), PAYPAL_WEBHOOK_ID (the
 * registered webhook, for verify-webhook-signature), PAYPAL_ENV ('sandbox' or 'live'; sandbox by default), and the
 * bot's CLIENT_ID, which the custom_id's signature covers.
 *
 * Checkout: a subscription on one plan, quantity 1, whose custom_id is `<holder>|<buyer>|<tier>|<offering>|<sig>`,
 * signed with an HMAC keyed by PAYPAL_CLIENT_SECRET over CLIENT_ID and the four fields; the buyer approves at PayPal's
 * `approve` link. Auto-renew off sells one payment: the custom_id gains a signed `once` field before the sig, the
 * request overrides the plan's REGULAR cycle to one payment, and once the payment is recorded the bot cancels the
 * subscription at PayPal; the tier then runs one period from that payment, whatever PayPal's status.
 *
 * Webhooks: the raw body goes back to /v1/notifications/verify-webhook-signature unchanged, with the five transmission
 * headers. Every event's subscription (and its plan) is then read fresh from the API, one handling at a time per
 * subscription, and only a custom_id this bot signed installs anything. The end premium holds is what was paid plus a
 * day, kept through PayPal's payment retries; a cancel keeps the paid period.
 *
 * No customer portal: the buyer manages billing at PayPal, and the bot's page cancels. A price migration uses
 * PayPal's revise, whose approval URL is only logged.
 */

import crypto from 'crypto';
import { PROVIDER_FETCH_MS } from './paymentTypes';
import { loadCredentials, providerCredentials } from '@/utils/envLoader';
import { getPaymentRegistry } from './paymentRegistry';
import { holderWords, isDiscordId, notHolderText, parseHolder, type HolderKey } from '../premiumHolder';
import type {
  PaymentProvider,
  ProviderCapabilities,
  ProviderSubscriptionState,
  InitiateOpts,
  InitiateResult,
  OfferingVariant,
  ProviderSubscriptionRef,
  CredentialFieldDef,
  SubscriptionView,
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
  sells: ['guild', 'user'],
  endsAtPaidEnd: true,
};

function paypalApiBase(): string {
  const env = providerCredentials('paypal').PAYPAL_ENV || 'sandbox';
  return env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

interface PayPalToken { access_token: string; expires_at: number; }

/** A PayPal API call that was sent: `status` is PayPal's answer, null when none came (timeout, network). */
export class PayPalApiError extends Error {
  constructor(message: string, readonly status: number | null, readonly paypalName?: string) {
    super(message);
    this.name = 'PayPalApiError';
  }
}

/** A PayPal API call that was never sent: a key is not set (`key`), or the sign-in failed (`signIn`, its reason). */
export class PayPalNotCalled extends Error {
  readonly key?: string;
  readonly signIn?: string;
  constructor(why: { key: string } | { signIn: string }) {
    super('key' in why ? `${why.key} is not set` : `the bot could not sign in to PayPal: ${why.signIn}`);
    this.name = 'PayPalNotCalled';
    if ('key' in why) this.key = why.key;
    else this.signIn = why.signIn;
  }
}

/** A webhook's read answered 404: the event is not applied (PL9) and answered 200. */
export class PayPalObjectMissing extends Error {
  constructor(readonly object: string, readonly objectId: string) {
    super(`PayPal has no ${object} ${objectId}`);
    this.name = 'PayPalObjectMissing';
  }
}

const causeText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** "PayPal answered <status>: <message>" or "PayPal did not answer: <reason>"; a call never sent gives its own reason. */
export function paypalFailureText(error: unknown): string {
  if (error instanceof PayPalApiError) {
    return error.status === null ? `PayPal did not answer: ${error.message}` : `PayPal answered ${error.status}: ${error.message}`;
  }
  return causeText(error);
}

const CUSTOM_ID_LIMIT = 127;
const VIEW_NOT_READY = 'PayPal webhook not applied: premium cannot read its subscriptions now; PayPal sends the event again.';
const NOT_CHARGED = 'Nothing was charged.';

function customSig(secret: string, clientId: string, holder: string, buyerId: string, tierId: string, offeringId: string, once: boolean): Buffer {
  return crypto.createHmac('sha256', secret)
    .update(['smdb-paypal-custom', clientId, holder, buyerId, tierId, offeringId, ...(once ? ['once'] : [])].join('\n'))
    .digest()
    .subarray(0, 16);
}

/**
 * The holder, buyer, tier and offering a subscription's custom_id names (`<holder>|<buyerId>|<tierId>|<offeringId>|<sig>`,
 * or `...|<offeringId>|once|<sig>` for one payment), null unless it is one of those forms with a holder and a Discord
 * buyer; `signed` only when the signature is this bot's, under its PAYPAL_CLIENT_SECRET and CLIENT_ID.
 */
export function customFrom(customId: unknown): { holder: HolderKey; buyerId: string; tierId: string; offeringId: string; once: boolean; signed: boolean } | null {
  if (typeof customId !== 'string') return null;
  const fields = customId.split('|');
  const once = fields.length === 6 && fields[4] === 'once';
  if (fields.length !== 5 && !once) return null;
  const [holderText, buyerId, tierId, offeringId] = fields;
  const sig = fields[fields.length - 1];
  const holder = parseHolder(holderText);
  if (!holder || !isDiscordId(buyerId)) return null;
  const secret = providerCredentials('paypal').PAYPAL_CLIENT_SECRET;
  const clientId = loadCredentials().CLIENT_ID;
  let signed = false;
  if (secret && clientId) {
    const expected = customSig(secret, clientId, holder.key, buyerId, tierId, offeringId, once);
    const given = Buffer.from(sig, 'base64url');
    signed = given.length === expected.length && sig === given.toString('base64url') && crypto.timingSafeEqual(given, expected);
  }
  return { holder: holder.key, buyerId, tierId, offeringId, once, signed };
}

/** Where PayPal sends the buyer back: WEBUI_BASE_URL, else the scheme and host of OAUTH_CALLBACK_URL. */
function returnHost(c: Record<string, string | undefined>): string {
  if (c.WEBUI_BASE_URL) return c.WEBUI_BASE_URL.replace(/\/+$/, '');
  const callback = c.OAUTH_CALLBACK_URL;
  if (!callback) {
    throw new Error('PayPal checkout did not start: neither WEBUI_BASE_URL nor OAUTH_CALLBACK_URL is set, so the bot has no address '
      + `for PayPal to send the buyer back to. ${NOT_CHARGED}`);
  }
  try {
    const parsed = new URL(callback);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    throw new Error('PayPal checkout did not start: WEBUI_BASE_URL is not set and OAUTH_CALLBACK_URL is not a valid URL, so the bot has '
      + `no address for PayPal to send the buyer back to. ${NOT_CHARGED}`);
  }
}

function signInRefusal(error: PayPalNotCalled): string {
  return error.key
    ? `PayPal checkout did not start: ${error.key} is not set. ${NOT_CHARGED}`
    : `PayPal checkout did not start: the bot could not sign in to PayPal (${error.signIn}). ${NOT_CHARGED}`;
}

const DAY_MS = 86_400_000;
const RETRY_WINDOW_MS = 10 * DAY_MS;
const LONGEST_DAYS: Record<string, number> = { DAY: 1, WEEK: 7, MONTH: 31, YEAR: 366 };
const PAYMENT_STATUSES = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
/** The statuses whose end is computed from the plan (Z5); every other status ends a held subscription. */
const PLAN_READ_STATUSES = ['ACTIVE', 'CANCELLED', 'SUSPENDED'];

const isoOf = (at: number): string => new Date(at).toISOString();
const subscriptionPath = (id: string): string => `/v1/billing/subscriptions/${encodeURIComponent(id)}`;
const planPath = (id: unknown): string => `/v1/billing/plans/${encodeURIComponent(String(id ?? ''))}`;

/** `start` plus `n` cycles of a plan's frequency on the UTC calendar (a month step clamped to the month's last day); NaN for an unknown unit. */
function cyclesFrom(start: number, frequency: any, n: number): number {
  const unit = frequency?.interval_unit;
  const count = Number(frequency?.interval_count) || 1;
  if (unit === 'DAY') return start + n * count * DAY_MS;
  if (unit === 'WEEK') return start + n * count * 7 * DAY_MS;
  if (unit !== 'MONTH' && unit !== 'YEAR') return Number.NaN;
  const d = new Date(start);
  const target = d.getUTCMonth() + (unit === 'YEAR' ? 12 : 1) * count * n;
  const year = d.getUTCFullYear() + Math.floor(target / 12);
  const month = ((target % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** `n` cycles of a plan's frequency, each at its longest. */
function longestOf(frequency: any, n: number): number {
  const days = LONGEST_DAYS[frequency?.interval_unit];
  return days === undefined ? Number.NaN : days * (Number(frequency?.interval_count) || 1) * n * DAY_MS;
}

/** PayPal's side of Z5's end: `sideEnd + window`, null with no `paid`; `failing` and whether the window applies. */
interface PayPalEnd { side: number | null; failing: boolean; windowApplies: boolean }

function paypalEnd(sub: any, plan: any): PayPalEnd {
  const cycles = [...(plan?.billing_cycles ?? [])].sort((a: any, b: any) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const regular = cycles.find((c: any) => c.tenure_type === 'REGULAR');
  const info = sub.billing_info ?? {};
  const lastPayment = Date.parse(info.last_payment?.time ?? '');
  let paid = Number.NaN;
  let longest = Number.NaN;
  if (Number.isFinite(lastPayment)) {
    paid = cyclesFrom(lastPayment, regular?.frequency, 1);
    longest = lastPayment + longestOf(regular?.frequency, 1);
  } else if (cycles[0]?.tenure_type === 'TRIAL') {
    paid = Date.parse(sub.start_time ?? '');
    longest = paid;
    for (const trial of cycles.filter((c: any) => c.tenure_type === 'TRIAL')) {
      const n = Number(trial.total_cycles) || 0;
      paid = cyclesFrom(paid, trial.frequency, n);
      longest += longestOf(trial.frequency, n);
    }
  }
  const lastFailed = Date.parse(info.last_failed_payment?.time ?? '');
  const failing = (Number.isFinite(lastFailed) && !(lastFailed <= lastPayment)) || Number(info.failed_payments_count ?? 0) > 0;
  const windowApplies = sub.status === 'ACTIVE' && failing;
  if (!Number.isFinite(paid) || !Number.isFinite(longest)) return { side: null, failing, windowApplies };
  const next = Date.parse(info.next_billing_time ?? '');
  const side = Math.min(Number.isFinite(next) ? next : paid, longest) + DAY_MS + (windowApplies ? RETRY_WINDOW_MS : 0);
  return { side, failing, windowApplies };
}

const HOUR_MS = 3_600_000;
const KEPT_STATUSES = ['COMPLETED', 'PARTIALLY_REFUNDED'];
type Owner = NonNullable<ReturnType<typeof customFrom>>;

/** Y2's payment proof of a pay-once subscription, from its read, its transactions and the event's type. */
interface OnceProof {
  proof: 'paid' | 'refunded' | 'none' | 'unknown';
  /** The earliest kept payment's time, with proof `paid`. */
  T: number;
  /** Each kept listed payment more than an hour after `T` (the third rule's later payments). */
  later: Array<{ id: string; time: number }>;
  /** The latest listed transaction's status, for PW7. */
  latest: string | null;
}

function onceProofOf(sub: any, transactions: any[], type: string): OnceProof {
  const listed = transactions.filter(x => x && typeof x === 'object');
  const payments = listed.filter(x => PAYMENT_STATUSES.includes(x.status)).map(x => ({ id: String(x.id ?? ''), status: x.status as string, time: Date.parse(x.time ?? '') }))
    .filter(p => Number.isFinite(p.time));
  const latestListed = listed.reduce<any>((a, b) => (a === null || Date.parse(b.time ?? '') > Date.parse(a.time ?? '') ? b : a), null);
  const latest = latestListed ? String(latestListed.status ?? 'without a status') : null;
  const lp = Date.parse(sub.billing_info?.last_payment?.time ?? '');
  let match: { status: string; time: number } | null = null;
  if (Number.isFinite(lp)) {
    for (const p of payments) {
      if (Math.abs(p.time - lp) <= HOUR_MS && (!match || Math.abs(p.time - lp) < Math.abs(match.time - lp))) match = p;
    }
  }
  const lpAlone = Number.isFinite(lp) && !match;
  const kept = [...payments.filter(p => KEPT_STATUSES.includes(p.status)).map(p => p.time), ...(lpAlone ? [lp] : [])];
  if (kept.length > 0) {
    const T = Math.min(...kept);
    const later = payments.filter(p => KEPT_STATUSES.includes(p.status) && p.time > T + HOUR_MS).map(p => ({ id: p.id, time: p.time }));
    return { proof: 'paid', T, later, latest };
  }
  const executions = sub.billing_info?.cycle_executions;
  if (payments.length > 0) {
    const regular = Array.isArray(executions) ? executions.find((c: any) => c?.tenure_type === 'REGULAR') : undefined;
    const completed = Number(regular?.cycles_completed);
    const counted = regular !== undefined && regular?.cycles_completed !== undefined && regular?.cycles_completed !== null && Number.isFinite(completed);
    const positive = match?.status === 'REFUNDED' || (counted && completed <= payments.length);
    const contrary = lpAlone || (counted && completed > payments.length);
    return { proof: positive && !contrary ? 'refunded' : 'unknown', T: Number.NaN, later: [], latest };
  }
  const beforeApproval = sub.status === 'APPROVAL_PENDING' || sub.status === 'APPROVED';
  const noneCompleted = Array.isArray(executions) && executions.length > 0 && executions.every((c: any) => Number(c?.cycles_completed) === 0 && c?.cycles_completed !== null);
  if (listed.length === 0 && type !== 'PAYMENT.SALE.COMPLETED' && (beforeApproval || noneCompleted)) return { proof: 'none', T: Number.NaN, later: [], latest };
  return { proof: 'unknown', T: Number.NaN, later: [], latest };
}

/** `onceEnd(T)`: one REGULAR cycle from `T`, the shorter of the calendar and the longest form, plus a day; NaN for an unknown unit. */
function onceEndOf(T: number, plan: any): number {
  const regular = (Array.isArray(plan?.billing_cycles) ? plan.billing_cycles : []).find((c: any) => c?.tenure_type === 'REGULAR');
  return Math.min(cyclesFrom(T, regular?.frequency, 1), T + longestOf(regular?.frequency, 1)) + DAY_MS;
}

const ONCE_TAIL = ' The subscription was sold as one payment, and PayPal may charge it again until it is cancelled; PayPal sends the event again and the bot tries the cancel again.';

/** The texts of a cancel whose failure leaves premium's changes in place: the webhook was handled, the cancel is retried. */
interface CancelForms {
  refused(message: string, status: string): string;
  unsure(why: string): string;
  notSent(why: string): string;
  missing(): string;
}

/** The second rule's cancel (PW6). */
function overrideForms(id: string): CancelForms {
  return {
    refused: (message, status) => `PayPal webhook handled, but PayPal refused to cancel subscription ${id} (${message}) and its status there is ${status}.${ONCE_TAIL}`,
    unsure: why => `PayPal webhook handled, but the bot can't confirm whether PayPal cancelled subscription ${id} (${why}).${ONCE_TAIL}`,
    notSent: why => `PayPal webhook handled, but the bot did not ask PayPal to cancel subscription ${id} (${why}).${ONCE_TAIL}`,
    missing: () => `PayPal webhook handled, but PayPal has no subscription ${id} (404), so the bot cancelled nothing.`,
  };
}

/** A pay-once refund's own cancel, after the tier was ended (or with none held). */
function refundForms(id: string, held: boolean): CancelForms {
  const lead = held ? `PayPal webhook handled: the tier of subscription ${id} was ended, but` : `PayPal webhook handled: the bot holds no tier for subscription ${id}, but`;
  const again = '; PayPal sends the event again and the bot tries the cancel again.';
  return {
    refused: (message, status) => `${lead} PayPal refused to cancel it (${message}) and its status there is ${status}${again}`,
    unsure: why => `${lead} the bot can't confirm whether PayPal cancelled it (${why})${again}`,
    notSent: why => `${lead} the bot did not ask PayPal to cancel it (${why})${again}`,
    missing: () => `${lead} PayPal has no subscription ${id} (404), so the bot cancelled nothing.`,
  };
}

/** The event decideOnce emitted for a pay-once subscription, if any. */
type OnceEmit = 'created' | 'updated' | 'queued' | 'expired' | null;

/** A REGULAR cycle whose length the bot can count (PayPal's units DAY, WEEK, MONTH and YEAR). */
function countable(plan: any): boolean {
  const regular = (Array.isArray(plan?.billing_cycles) ? plan.billing_cycles : []).find((c: any) => c?.tenure_type === 'REGULAR');
  return Number.isFinite(cyclesFrom(0, regular?.frequency, 1)) && Number.isFinite(longestOf(regular?.frequency, 1));
}

const VERIFY_HEADERS = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];

export class PayPalProvider implements PaymentProvider {
  readonly id = 'paypal';
  readonly displayName = 'PayPal';
  readonly capabilities = CAPABILITIES;

  private tokenCache: PayPalToken | null = null;

  isConfigured(): boolean {
    const c = providerCredentials('paypal');
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
    const holder = parseHolder(opts.holder);
    if (!holder) throw new Error(notHolderText(opts.holder));
    const c = providerCredentials('paypal');
    for (const key of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID'] as const) {
      if (!c[key]) throw new Error(`PayPal checkout did not start: ${key} is not set. ${NOT_CHARGED}`);
    }
    const secret = c.PAYPAL_CLIENT_SECRET as string;
    const clientId = loadCredentials().CLIENT_ID;
    if (!clientId) throw new Error(`PayPal checkout did not start: CLIENT_ID (the bot's Discord application id) is not set. ${NOT_CHARGED}`);

    const host = returnHost(c);
    const page = holder.kind === 'guild' ? `${host}/guild/${encodeURIComponent(holder.id)}/subscription` : `${host}/guild`;

    const once = opts.autoRenewOptOut === true;
    const fields = [holder.key, opts.buyerId, opts.tierId, opts.offeringId, ...(once ? ['once'] : [])];
    const sig = customSig(secret, clientId, holder.key, opts.buyerId, opts.tierId, opts.offeringId, once).toString('base64url');
    const customId = [...fields, sig].join('|');
    const label = `${holder.kind === 'guild' ? 'server' : 'user'}, buyer, tier '${opts.tierId}', offering '${opts.offeringId}'`;
    const piped = [['tier', opts.tierId], ['offering', opts.offeringId]].filter(([, id]) => String(id).includes('|')).map(([name]) => name);
    if (piped.length > 0) {
      throw new Error(`PayPal checkout did not start: the subscription's label for PayPal (${label}) contains the character "|". `
        + `Remove the "|" from the ${piped.join(' and ')} id${piped.length > 1 ? 's' : ''}. ${NOT_CHARGED}`);
    }
    if (customId.length > CUSTOM_ID_LIMIT) {
      throw new Error(`PayPal checkout did not start: the subscription's label for PayPal (${label}) is ${customId.length} characters, `
        + `over PayPal's limit of ${CUSTOM_ID_LIMIT}. Use a shorter tier or offering id. ${NOT_CHARGED}`);
    }

    let plan: any;
    try {
      plan = await this.api<any>('GET', `/v1/billing/plans/${encodeURIComponent(opts.variantId)}`);
    } catch (error) {
      throw new Error(error instanceof PayPalNotCalled
        ? signInRefusal(error)
        : `PayPal checkout did not start: the bot could not read plan ${opts.variantId} (${paypalFailureText(error)}). ${NOT_CHARGED}`);
    }
    if (!plan) throw new Error(`PayPal checkout did not start: the bot could not read plan ${opts.variantId} (PayPal answered with no plan). ${NOT_CHARGED}`);
    if (plan.status !== 'ACTIVE') {
      throw new Error(`PayPal checkout did not start: plan ${opts.variantId} is ${String(plan.status)} at PayPal, not active. ${NOT_CHARGED}`);
    }
    let override: { plan: { billing_cycles: Array<{ sequence: number; total_cycles: 1 }> } } | null = null;
    if (once) {
      const cycles = [...(Array.isArray(plan.billing_cycles) ? plan.billing_cycles : [])].sort((a: any, b: any) => (a?.sequence ?? 0) - (b?.sequence ?? 0));
      const regular = cycles.find((c: any) => c?.tenure_type === 'REGULAR' && Number.isInteger(c.sequence));
      const fee = Number.parseFloat(String(plan.payment_preferences?.setup_fee?.value ?? '0'));
      const why = cycles.some((c: any) => c?.tenure_type === 'TRIAL') ? 'starts with a free or paid trial'
        : !regular ? 'has no regular billing cycle'
          : !countable(plan) ? 'has a billing cycle the bot cannot count'
            : fee > 0 ? 'has a setup fee'
              : null;
      if (why) {
        throw new Error(`PayPal checkout did not start: plan ${opts.variantId} ${why}, so it can't be bought as one payment. Buy it with auto-renew on, or pick another plan or provider. ${NOT_CHARGED}`);
      }
      override = { plan: { billing_cycles: [{ sequence: regular.sequence, total_cycles: 1 }] } };
    }

    const body = {
      plan_id: opts.variantId,
      custom_id: customId,
      application_context: {
        brand_name: 'Discord Bot Premium',
        user_action: 'SUBSCRIBE_NOW',
        return_url: `${page}?subscribe=success`,
        cancel_url: `${page}?subscribe=cancel`,
      },
      ...(override ?? {}),
    };
    let sub: any;
    try {
      sub = await this.api<any>('POST', '/v1/billing/subscriptions', body);
    } catch (error) {
      if (error instanceof PayPalNotCalled) throw new Error(signInRefusal(error));
      if (error instanceof PayPalApiError && error.status !== null && error.status < 500) {
        throw new Error(`PayPal did not start the checkout: ${error.message.replace(/\.+$/, '')}. ${NOT_CHARGED}`);
      }
      throw new Error(`Can't confirm whether PayPal started a checkout (${paypalFailureText(error)}). Nothing is charged until a checkout is approved; try again.`);
    }
    const approveLink = (sub?.links || []).find((l: any) => l.rel === 'approve');
    if (!approveLink?.href || typeof sub?.id !== 'string') {
      throw new Error(`PayPal did not start the checkout: PayPal answered with no approval link. ${NOT_CHARGED}`);
    }
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

  /**
   * Premium's cancel: PayPal stops billing at once. A soft cancel then reads the subscription and answers the state
   * premium copies (Z9); a read that fails answers nothing, and the CANCELLED event updates the record.
   */
  cancelSubscription(providerSubId: string, immediately?: boolean): Promise<void | ProviderSubscriptionState> {
    return this.inChain(providerSubId, async () => {
      await this.cancelAt(providerSubId, immediately ? 'ended by the bot' : 'cancelled by the subscriber', immediately ? 'premium-remove' : 'premium');
      if (immediately) return;
      let sub: any;
      let plan: any = null;
      try {
        sub = await this.api<any>('GET', subscriptionPath(providerSubId));
        if (sub && PLAN_READ_STATUSES.includes(sub.status)) plan = await this.api<any>('GET', planPath(sub.plan_id));
      } catch {
        return;
      }
      const who = customFrom(sub?.custom_id);
      if (!sub || !who || who.once || sub.status !== 'CANCELLED') return;
      const registry = getPaymentRegistry();
      if (!registry.subscriptionViewReady()) {
        throw new Error(`PayPal cancelled subscription ${providerSubId}, and the bot can't confirm the end it keeps for it (premium cannot read its subscriptions now). Reload in a minute; the page shows the change once PayPal reports it.`);
      }
      const view = registry.readSubscription(this.id, who.holder, providerSubId);
      if (!view) return;
      if (view.status === 'paused') return this.queuedState(sub, view);
      const end = paypalEnd(sub, plan);
      if (end.side === null) return;
      const state = this.liveState(sub, end, view, false);
      return Date.parse(state.endDate as string) > Date.now() ? state : undefined;
    });
  }

  pauseSubscription(providerSubId: string, _resumesAt: string | null): Promise<void> {
    return this.inChain(providerSubId, () => this.suspendAt(providerSubId, 'paused by stacking'));
  }

  /**
   * A pay-once subscription is never activated: it is cancelled at PayPal unless closed there (Y4). A renewing one is
   * activated; a 4xx followed by a read showing ACTIVE counts as done.
   */
  resumeSubscription(providerSubId: string, _newEndDate: string | null): Promise<void> {
    return this.inChain(providerSubId, async () => {
      const sub = await this.api<any>('GET', subscriptionPath(providerSubId));
      const who = customFrom(sub?.custom_id);
      if (who?.once) {
        if (sub.status === 'CANCELLED' || sub.status === 'EXPIRED') return;
        await this.cancelOnce(providerSubId, who, 'premium');
        return;
      }
      try {
        await this.api<unknown>('POST', `${subscriptionPath(providerSubId)}/activate`, { reason: 'resumed from queue' });
      } catch (error) {
        if (!(error instanceof PayPalApiError) || error.status === null || error.status >= 500) throw error;
        let after: any;
        try {
          after = await this.api<any>('GET', subscriptionPath(providerSubId));
        } catch {
          throw error;
        }
        if (after?.status !== 'ACTIVE') throw error;
      }
    });
  }

  /**
   * Migration: PayPal "revise" issues a new approve URL the user must visit.
   * This violates our usual silent-apply expectation; PremiumManager treats
   * the migration as conditional on the user re-approving. For now we
   * surface the approve URL via the subscription notifier and rely on a
   * subsequent BILLING.SUBSCRIPTION.UPDATED webhook to confirm.
   */
  async migrateSubscriptionPrice(providerSubId: string, newVariantId: string, _proration: 'none' | 'create_prorations'): Promise<void> {
    let sub: any;
    try {
      sub = await this.api<any>('GET', subscriptionPath(providerSubId));
    } catch (error) {
      throw new Error(`Can't confirm whether PayPal subscription ${providerSubId} was sold as one payment (${paypalFailureText(error)}); it was not migrated.`);
    }
    if (customFrom(sub?.custom_id)?.once) {
      throw new Error(`PayPal subscription ${providerSubId} was sold as one payment and has no later payment to reprice; it was not migrated.`);
    }
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

  async listSubscriptionsFor(_holder: HolderKey): Promise<ProviderSubscriptionRef[]> {
    // PayPal doesn't index by our custom_id. Orphan adoption requires
    // walking ALL subs which is impractical at scale; rely on webhooks.
    return [];
  }

  webhookEventId(rawBody: Buffer, headers: Record<string, string>): string | null {
    if (!headers['paypal-transmission-id'] || !headers['paypal-transmission-sig']) return null;
    let id: unknown;
    try { id = JSON.parse(rawBody.toString('utf-8'))?.id; } catch { return null; }
    return typeof id === 'string' && /^[\x20-\x7e]{1,100}$/.test(id) ? id : null;
  }

  async handleWebhook(rawBody: Buffer, _signature: string, headers: Record<string, string>): Promise<void> {
    const c = providerCredentials('paypal');
    if (!c.PAYPAL_WEBHOOK_ID) throw new Error('PayPal webhook refused: PAYPAL_WEBHOOK_ID is not set.');
    const text = rawBody.toString('utf-8');
    let event: any;
    try { event = JSON.parse(text); } catch { event = null; }
    if (!event || typeof event !== 'object' || typeof event.id !== 'string' || typeof event.event_type !== 'string') {
      throw new Error('PayPal webhook refused: the body is not a PayPal event.');
    }
    for (const header of VERIFY_HEADERS) {
      if (!headers[header]) throw new Error(`PayPal webhook refused: the ${header} header is missing.`);
    }
    const verifyText = '{'
      + VERIFY_HEADERS.map(h => `${JSON.stringify(h.slice('paypal-'.length).replace(/-/g, '_'))}:${JSON.stringify(headers[h])}`).join(',')
      + `,"webhook_id":${JSON.stringify(c.PAYPAL_WEBHOOK_ID)},"webhook_event":${text}}`;
    let verify: { verification_status?: string } | null;
    try {
      verify = await this.api<{ verification_status: string }>('POST', '/v1/notifications/verify-webhook-signature', verifyText);
    } catch (err) {
      throw new Error(`PayPal webhook not applied: the bot could not verify the delivery at PayPal (${paypalFailureText(err)}); PayPal sends the event again.`);
    }
    if (verify?.verification_status !== 'SUCCESS') {
      throw new Error(`PayPal webhook refused: PayPal did not verify its signature (${String(verify?.verification_status ?? 'no status')}).`);
    }

    try {
      await this.handleEvent(event.event_type, event.resource && typeof event.resource === 'object' ? event.resource : {});
    } catch (error) {
      if (!(error instanceof PayPalObjectMissing)) throw error;
      console.warn(`[PayPalProvider] A ${event.event_type} event was not applied: PayPal has no ${error.object} ${error.objectId} (404).`);
    }
  }

  // ============================================================================
  // INTERNALS
  // ============================================================================

  /** The chains of handlings and premium's calls, by PayPal subscription id. */
  private readonly chains = new Map<string, Promise<void>>();
  /** PL1, PL2, PL3 and PL12 are logged once per subscription (and plan) in this process. */
  private readonly logged = new Set<string>();
  /** The subscriptions this process ended on purpose ("Cancel & remove now", a refund): never installed again here, and their CANCELLED delivery is not A3's case. */
  private readonly removedHere = new Set<string>();

  /** Runs `fn` after every earlier handling or call chained on `key` has ended. */
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

  private async handleEvent(type: string, resource: any): Promise<void> {
    if (type.startsWith('BILLING.SUBSCRIPTION.')) {
      if (typeof resource.id !== 'string' || !resource.id) return;
      await this.inChain(resource.id, () => this.applySubscription(type, resource.id));
      return;
    }
    if (type === 'PAYMENT.SALE.COMPLETED') {
      const id = resource.billing_agreement_id;
      if (typeof id !== 'string' || !id) {
        console.warn(`[PayPalProvider] A ${type} event for sale ${String(resource.id ?? '(none)')} names no subscription; the bot does not manage it.`);
        return;
      }
      await this.inChain(id, () => this.applySubscription(type, id));
      return;
    }
    if (type === 'PAYMENT.SALE.REFUNDED') await this.applyRefund(type, resource);
  }

  /** A webhook's read: a 404 is PayPalObjectMissing, any other failure PW3. */
  private async readAt(object: string, id: string, path: string): Promise<any> {
    let found: any;
    try {
      found = await this.api<any>('GET', path);
    } catch (error) {
      if (error instanceof PayPalApiError && error.status === 404) throw new PayPalObjectMissing(object, id);
      throw new Error(`PayPal webhook not applied: the bot could not read ${object} ${id} at PayPal (${paypalFailureText(error)}); PayPal sends the event again.`);
    }
    if (!found || typeof found !== 'object') {
      throw new Error(`PayPal webhook not applied: the bot could not read ${object} ${id} at PayPal (PayPal answered with no ${object}); PayPal sends the event again.`);
    }
    return found;
  }

  /** The holder and fields a subscription's custom_id gives, or null after PL1. */
  private ownerOf(type: string, id: string, sub: any): NonNullable<ReturnType<typeof customFrom>> | null {
    const who = customFrom(sub.custom_id);
    if (!who) {
      this.logOnce(`PL1:${id}`, `[PayPalProvider] A ${type} event for subscription ${id} was not applied: its custom_id is not one this version of the bot writes. It was made before this version or not by this bot; the bot does not manage it.`);
    }
    return who;
  }

  private notSigned(type: string, id: string): void {
    this.logOnce(`PL2:${id}`, `[PayPalProvider] A ${type} event for subscription ${id} was not applied: its custom_id's signature does not match and the bot holds no such subscription. It was not made by this bot's checkout, was made by another bot on the same PayPal app, or was signed with an earlier PAYPAL_CLIENT_SECRET.`);
  }

  /** Z4 to Z6 for one subscription, inside its chain: read it and its plan, then read premium's view, decide and emit. */
  private async applySubscription(type: string, id: string): Promise<void> {
    const sub = await this.readAt('subscription', id, subscriptionPath(id));
    const who = this.ownerOf(type, id, sub);
    if (!who) return;
    if (who.once) {
      await this.applyOnce(type, id, who, sub);
      return;
    }
    const plan = PLAN_READ_STATUSES.includes(sub.status) ? await this.readAt('plan', String(sub.plan_id ?? ''), planPath(sub.plan_id)) : null;

    // Premium's view is read after the last await, and the emits follow in the same step (Z4).
    const registry = getPaymentRegistry();
    if (!registry.subscriptionViewReady()) throw new Error(VIEW_NOT_READY);
    const view = registry.readSubscription(this.id, who.holder, id);
    if (!view && !who.signed) {
      this.notSigned(type, id);
      return;
    }
    const end = paypalEnd(sub, plan);
    if (!view) {
      this.install(id, who, sub, end);
      return;
    }
    const suspend = this.emitHeld(type, id, who, sub, end, view);
    if (type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') {
      registry.emitEvent({
        type: 'subscription.renewal-failed', providerId: this.id, providerSubId: id, holder: who.holder,
        reason: sub.billing_info?.last_failed_payment?.reason_code,
      });
    }
    if (!suspend) return;
    let outcome = 'the bot suspended it again';
    try {
      await this.suspendAt(id, 'paused by stacking');
    } catch (error) {
      outcome = `the bot's suspend failed again: ${paypalFailureText(error)}, so PayPal keeps billing it`;
    }
    console.warn(`[PayPalProvider] PayPal reported queued subscription ${id} (${holderWords(who.holder)}) active; ${outcome}; payments taken while it was queued are not added to its days: refund them in PayPal's dashboard if needed.`);
  }

  /** The transactions of a subscription since its creation (Z7 step 3), each read's failure as `readAt`'s. */
  private async readTransactions(subId: string, sub: any): Promise<any[]> {
    const from = encodeURIComponent(String(sub.create_time ?? sub.start_time ?? ''));
    const to = encodeURIComponent(isoOf(Date.now() + 60_000));
    const list = await this.readAt('subscription', subId, `${subscriptionPath(subId)}/transactions?start_time=${from}&end_time=${to}`);
    return Array.isArray(list.transactions) ? list.transactions : [];
  }

  /** A pay-once subscription's plan and transactions; a 404 from the transactions is an empty list (Z2, R12). */
  private async readOnce(subId: string, sub: any): Promise<{ plan: any; transactions: any[] }> {
    const plan = await this.readAt('plan', String(sub.plan_id ?? ''), planPath(sub.plan_id));
    let transactions: any[];
    try {
      transactions = await this.readTransactions(subId, sub);
    } catch (error) {
      if (!(error instanceof PayPalObjectMissing)) throw error;
      transactions = [];
    }
    return { plan, transactions };
  }

  /**
   * Y2 for a pay-once subscription, inside its chain: the tier follows the payment proof, never PayPal's status (the
   * first rule); a proven payment is cancelled at PayPal (the second rule); a later payment never extends it (the third).
   */
  private async applyOnce(type: string, id: string, who: Owner, sub: any): Promise<void> {
    const { plan, transactions } = await this.readOnce(id, sub);
    const registry = getPaymentRegistry();
    if (!registry.subscriptionViewReady()) throw new Error(VIEW_NOT_READY);
    const view = registry.readSubscription(this.id, who.holder, id);
    if (!view && !who.signed) {
      this.notSigned(type, id);
      return;
    }
    const proof = onceProofOf(sub, transactions, type);
    this.decideOnce(id, who, sub, plan, proof, view);
    await this.cancelOnceIfDue(id, who, sub, proof, view);
    if (proof.proof === 'unknown' && !view) {
      throw new Error(`PayPal webhook not applied: the bot can't confirm the payment of subscription ${id} at PayPal (${proof.latest === null ? 'PayPal lists no payment for it yet' : `its latest transaction is ${proof.latest}`}); PayPal sends the event again.`);
    }
  }

  /** Y2's table for a pay-once subscription: the emits and PL17, in one synchronous step after premium's view was read; the event it emitted. */
  private decideOnce(id: string, who: Owner, sub: any, plan: any, proof: OnceProof, view: SubscriptionView | null): OnceEmit {
    const registry = getPaymentRegistry();
    const base = { providerId: this.id, providerSubId: id, holder: who.holder };
    if (proof.proof === 'refunded') {
      if (!view) return null;
      registry.emitEvent({ type: 'subscription.expired', ...base, state: this.endedState(sub, { payOnce: true }) });
      return 'expired';
    }
    if (proof.proof !== 'paid') return null;
    for (const later of proof.later) {
      this.logOnce(`PL17:${later.id}`, `[PayPalProvider] PayPal took another payment (sale ${later.id}, ${isoOf(later.time)}) for subscription ${id} (${holderWords(who.holder)}), which was sold as one payment; the tier covers only its earliest payment not refunded, so refund this one in PayPal's dashboard. Refunding it changes nothing in the bot.`);
    }
    const computed = onceEndOf(proof.T, plan);
    if (!Number.isFinite(computed)) {
      if (!view && who.signed && !this.removedHere.has(id)) {
        console.warn(`[PayPalProvider] PayPal took the payment of subscription ${id} (${holderWords(who.holder)}) at ${isoOf(proof.T)}, which was sold as one payment, but its plan ${String(sub.plan_id)} has a billing cycle the bot cannot count, so the bot installed no tier. Refund the payment in PayPal's dashboard.`);
      }
      return null;
    }
    const keptEnd = Date.parse(String(view?.meta?.keptEnd ?? ''));
    const end = Number.isFinite(keptEnd) ? Math.max(keptEnd, computed) : computed;
    const meta = { paypalStatus: sub.status, planId: sub.plan_id, computedEnd: isoOf(computed), payOnce: true, ...(view?.meta?.keptEnd !== undefined ? { keptEnd: view.meta.keptEnd } : {}) };
    if (!view) {
      if (!who.signed || end <= Date.now() || this.removedHere.has(id)) return null;
      if (sub.quantity !== undefined && sub.quantity !== null && String(sub.quantity) !== '1') {
        console.warn(`[PayPalProvider] Subscription ${id} (${holderWords(who.holder)}) is for quantity ${String(sub.quantity)}; the bot sells quantity 1 only, so nothing was installed. Cancel and refund it in PayPal's dashboard if it was paid.`);
        return null;
      }
      registry.emitEvent({
        type: 'subscription.created', ...base, buyerId: who.buyerId, tierId: who.tierId, offeringId: who.offeringId,
        variantId: String(sub.plan_id ?? ''),
        state: { status: 'active', startDate: sub.start_time || sub.create_time || new Date().toISOString(), endDate: isoOf(end), autoRenew: false, meta },
        soldVariantOnly: true,
      });
      return 'created';
    }
    if (view.status === 'paused') {
      registry.emitEvent({ type: 'subscription.updated', ...base, state: { ...this.queuedState(sub, view), autoRenew: false, meta: { ...meta, computedEnd: view.endDate } } });
      return 'queued';
    }
    if (end <= Date.now()) {
      registry.emitEvent({ type: 'subscription.expired', ...base, state: { ...this.endedState(sub, { payOnce: true }), endDate: isoOf(end), meta: { ...meta } } });
      return 'expired';
    }
    registry.emitEvent({
      type: 'subscription.updated', ...base,
      state: { status: 'active', startDate: view.startDate ?? (sub.start_time || sub.create_time || new Date().toISOString()), endDate: isoOf(end), autoRenew: false, meta },
    });
    return 'updated';
  }

  /** The second rule: a pay-once subscription whose payment is proven (or that premium holds) is cancelled at PayPal unless it is closed there. */
  private async cancelOnceIfDue(id: string, who: Owner, sub: any, proof: OnceProof, view: SubscriptionView | null): Promise<void> {
    const due = proof.proof === 'paid' || proof.proof === 'refunded' || (proof.proof === 'unknown' && view !== null);
    if (!due || sub.status === 'CANCELLED' || sub.status === 'EXPIRED') return;
    await this.cancelOnce(id, who, 'own');
  }

  /** The cancel of the second rule, with PL16 once per subscription and process. */
  private async cancelOnce(id: string, who: Owner, texts: 'own' | 'premium'): Promise<void> {
    const outcome = await this.cancelAt(id, 'sold as one payment', 'override', texts);
    if (outcome === 'cancelled') {
      this.logOnce(`PL16:${id}`, `[PayPalProvider] Subscription ${id} (${holderWords(who.holder)}) was sold as one payment and its payment is recorded, so the bot cancelled it at PayPal to stop any further charge.`);
    } else if (outcome === 'CANCELLED' || outcome === 'EXPIRED') {
      this.logOnce(`PL16:${id}`, `[PayPalProvider] Subscription ${id} (${holderWords(who.holder)}) was sold as one payment; it was already ${outcome === 'CANCELLED' ? 'cancelled' : 'expired'} at PayPal, so the bot cancelled nothing.`);
    }
  }

  /** Z6: a live, signed subscription of quantity 1 that premium does not hold is installed. */
  private install(id: string, who: NonNullable<ReturnType<typeof customFrom>>, sub: any, end: PayPalEnd): void {
    if (!who.signed || end.side === null) return;
    if (sub.status !== 'ACTIVE') {
      const paid = Number.isFinite(Date.parse(sub.billing_info?.last_payment?.time ?? ''));
      if (paid && (sub.status === 'CANCELLED' || sub.status === 'SUSPENDED') && end.side > Date.now() && !this.removedHere.has(id)) {
        const word = sub.status === 'CANCELLED' ? 'cancelled' : 'suspended';
        console.warn(`[PayPalProvider] PayPal took a payment for subscription ${id} (${holderWords(who.holder)}), which is ${word} at PayPal and not held by the bot, so the bot installs nothing. If it was ${word} before the bot installed it, the buyer paid and did not get the tier: refund it in PayPal's dashboard.`);
      }
      return;
    }
    if (sub.quantity !== undefined && sub.quantity !== null && String(sub.quantity) !== '1') {
      console.warn(`[PayPalProvider] Subscription ${id} (${holderWords(who.holder)}) is for quantity ${String(sub.quantity)}; the bot sells quantity 1 only, so nothing was installed. Cancel and refund it in PayPal's dashboard if it was paid.`);
      return;
    }
    getPaymentRegistry().emitEvent({
      type: 'subscription.created',
      providerId: this.id,
      providerSubId: id,
      holder: who.holder,
      buyerId: who.buyerId,
      tierId: who.tierId,
      offeringId: who.offeringId,
      variantId: String(sub.plan_id ?? ''),
      state: this.liveState(sub, end, null, true),
      soldVariantOnly: true,
    });
  }

  /** Z5's table for a subscription premium holds. True when a queued entry PayPal reports active is to be suspended again. */
  private emitHeld(type: string, id: string, who: NonNullable<ReturnType<typeof customFrom>>, sub: any, end: PayPalEnd, view: SubscriptionView): boolean {
    const registry = getPaymentRegistry();
    const base = { providerId: this.id, providerSubId: id, holder: who.holder };
    const status = sub.status;
    const live = status === 'ACTIVE' && end.side !== null;
    const ended = (): void => registry.emitEvent({ type: 'subscription.expired', ...base, state: this.endedState(sub) });

    if (view.status === 'paused') {
      if (live) {
        registry.emitEvent({ type: 'subscription.paused', ...base, resumesAt: null });
        return true;
      }
      if (status === 'CANCELLED' || status === 'SUSPENDED') {
        registry.emitEvent({ type: 'subscription.updated', ...base, state: this.queuedState(sub, view) });
        return false;
      }
      ended();
      return false;
    }

    if (live) {
      registry.emitEvent({ type: type === 'PAYMENT.SALE.COMPLETED' ? 'subscription.renewed' : 'subscription.updated', ...base, state: this.liveState(sub, end, view, true) });
      if (view.variantId !== sub.plan_id) {
        this.logOnce(`PL3:${id}:${String(sub.plan_id)}`, `[PayPalProvider] Subscription ${id} now bills plan ${String(sub.plan_id)}, not ${String(view.variantId)} that the bot recorded; the bot keeps giving tier '${who.tierId}'.`);
      }
      return false;
    }
    if (status === 'CANCELLED' && end.side !== null) {
      const state = this.liveState(sub, end, view, false);
      if (Date.parse(state.endDate as string) > Date.now()) registry.emitEvent({ type: 'subscription.updated', ...base, state });
      else ended();
      return false;
    }
    if (status === 'SUSPENDED' && end.side !== null) {
      const state = this.liveState(sub, end, view, true);
      registry.emitEvent({ type: 'subscription.updated', ...base, state });
      const note = String(sub.status_change_note ?? 'no note');
      const paidEnd = state.endDate === isoOf(end.side) ? ', a day after the end of what was paid' : '';
      if (end.failing) {
        console.warn(`[PayPalProvider] PayPal suspended subscription ${id} (${holderWords(who.holder)}) after ${Number(sub.billing_info?.failed_payments_count ?? 0)} failed payments (${note}); the bot gives its tier only until ${state.endDate}${paidEnd}.`);
      } else {
        this.logOnce(`PL12:${id}`, `[PayPalProvider] PayPal reports subscription ${id} (${holderWords(who.holder)}) suspended with no failed payment (${note}); the bot gives its tier only until ${state.endDate}${paidEnd}.`);
      }
      return false;
    }
    ended();
    return false;
  }

  /**
   * An active state with Z5's end: `max(heldEnd, PayPal's side)`, where the held end counts only when premium holds it
   * active and it differs from the `computedEnd` it was given (an end premium set itself, a resume).
   */
  private liveState(sub: any, end: PayPalEnd, view: SubscriptionView | null, autoRenew: boolean): ProviderSubscriptionState {
    const side = end.side as number;
    const held = view?.status === 'active' ? Date.parse(view.endDate ?? '') : Number.NaN;
    const kept = Number.isFinite(held) && held !== Date.parse(String(view?.meta?.computedEnd ?? '')) ? held : Number.NaN;
    return {
      status: 'active',
      startDate: sub.start_time || sub.create_time || new Date().toISOString(),
      endDate: isoOf(Number.isFinite(kept) ? Math.max(kept, side) : side),
      autoRenew,
      meta: { paypalStatus: sub.status, planId: sub.plan_id, computedEnd: isoOf(side), ...(end.windowApplies ? { paymentFailing: true } : {}) },
    };
  }

  /** A queued entry stays paused with its held end and dates; the meta carries PayPal's status (Z5's held-queued cells). */
  private queuedState(sub: any, view: SubscriptionView): ProviderSubscriptionState {
    return {
      status: 'paused',
      startDate: view.startDate ?? (sub.start_time || sub.create_time || new Date().toISOString()),
      endDate: view.endDate,
      autoRenew: sub.status === 'CANCELLED' ? false : view.autoRenew,
      meta: { paypalStatus: sub.status, planId: sub.plan_id, computedEnd: view.endDate },
    };
  }

  /** The state that ends a held subscription: expired at PayPal's last status change. */
  private endedState(sub: any, more: Record<string, unknown> = {}): ProviderSubscriptionState {
    const changed = Date.parse(sub.status_update_time ?? '');
    const endDate = Number.isFinite(changed) ? isoOf(changed) : new Date().toISOString();
    return {
      status: 'expired',
      startDate: sub.start_time || sub.create_time || new Date().toISOString(),
      endDate,
      autoRenew: false,
      meta: { paypalStatus: sub.status, planId: sub.plan_id, computedEnd: endDate, ...more },
    };
  }

  /** Z7: a full refund of a subscription's latest payment cancels it at PayPal and ends it in the bot. */
  private async applyRefund(type: string, resource: any): Promise<void> {
    const saleId = typeof resource.sale_id === 'string' ? resource.sale_id : '';
    let id: unknown = resource.billing_agreement_id;
    if ((typeof id !== 'string' || !id) && saleId) {
      let sale: any;
      try {
        sale = await this.api<any>('GET', `/v1/payments/sale/${encodeURIComponent(saleId)}`);
      } catch (error) {
        if (error instanceof PayPalApiError && error.status !== null && error.status < 500) {
          console.warn(`[PayPalProvider] A ${type} event was not applied: the bot could not find the subscription of sale ${saleId} (PayPal answered ${error.status}).`);
          return;
        }
        throw new Error(`PayPal webhook not applied: the bot could not read sale ${saleId} at PayPal (${paypalFailureText(error)}); PayPal sends the event again.`);
      }
      id = sale?.billing_agreement_id;
    }
    if (typeof id !== 'string' || !id) {
      console.warn(`[PayPalProvider] A ${type} event for sale ${saleId || '(none)'} names no subscription; the bot does not manage it.`);
      return;
    }
    const subId = id;
    await this.inChain(subId, async () => {
      let sub = await this.readAt('subscription', subId, subscriptionPath(subId));
      const who = this.ownerOf(type, subId, sub);
      if (!who) return;
      if (!who.signed) {
        const registry = getPaymentRegistry();
        if (!registry.subscriptionViewReady()) throw new Error(VIEW_NOT_READY);
        if (!registry.readSubscription(this.id, who.holder, subId)) {
          this.notSigned(type, subId);
          return;
        }
      }
      if (who.once) {
        await this.applyOnceRefund(type, subId, saleId, who, sub);
        return;
      }
      const payments: any[] = (await this.readTransactions(subId, sub)).filter((t: any) => PAYMENT_STATUSES.includes(t?.status));
      const refunded = payments.find(t => t.id === saleId);
      if (!refunded) {
        console.warn(`[PayPalProvider] Sale ${saleId} was refunded, and the bot did not find it among the payments PayPal lists for subscription ${subId}; nothing was ended. Use "Cancel & remove now" on its subscription page if the refund should end it.`);
        return;
      }
      const latest = payments.reduce((a, b) => (Date.parse(b.time) > Date.parse(a.time) ? b : a));
      if (latest.id !== saleId || refunded.status !== 'REFUNDED') {
        console.warn(`[PayPalProvider] Sale ${saleId} was refunded (${String(refunded.status)}), and it is not a full refund of the latest payment of subscription ${subId}; the subscription stays.`);
        return;
      }
      const already = sub.status === 'CANCELLED' || sub.status === 'EXPIRED';
      if (already) {
        this.removedHere.add(subId);
      } else {
        await this.cancelAt(subId, 'refunded', 'webhook');
        sub = await this.readAt('subscription', subId, subscriptionPath(subId));
      }
      getPaymentRegistry().emitEvent({ type: 'subscription.expired', providerId: this.id, providerSubId: subId, holder: who.holder, state: this.endedState(sub) });
      console.warn(`[PayPalProvider] Sale ${saleId} was refunded in full; subscription ${subId} (${holderWords(who.holder)}) ${already ? 'was already cancelled at PayPal' : 'was cancelled at PayPal'}, and the event that ends it in the bot was raised.`);
    });
  }

  /** Z7 for a pay-once subscription (B1, Z3, A4): the proof table first, then the event's sale. */
  private async applyOnceRefund(type: string, subId: string, saleId: string, who: Owner, sub: any): Promise<void> {
    const { plan, transactions } = await this.readOnce(subId, sub);
    const registry = getPaymentRegistry();
    if (!registry.subscriptionViewReady()) throw new Error(VIEW_NOT_READY);
    const view = registry.readSubscription(this.id, who.holder, subId);
    if (!view && !who.signed) {
      this.notSigned(type, subId);
      return;
    }
    const proof = onceProofOf(sub, transactions, type);
    const already = sub.status === 'CANCELLED' || sub.status === 'EXPIRED';
    if (proof.proof === 'refunded') {
      this.decideOnce(subId, who, sub, plan, proof, view);
      if (already) this.removedHere.add(subId);
      else await this.cancelAt(subId, 'refunded', 'webhook', refundForms(subId, view !== null));
      if (view) {
        const how = !already ? 'was cancelled at PayPal' : sub.status === 'EXPIRED' ? 'had already expired at PayPal' : 'was already cancelled at PayPal';
        console.warn(`[PayPalProvider] Sale ${saleId} was refunded in full; subscription ${subId} (${holderWords(who.holder)}) ${how}, and the event that ends it in the bot was raised.`);
      }
      return;
    }
    if (proof.proof !== 'paid') {
      await this.cancelOnceIfDue(subId, who, sub, proof, view);
      throw new Error(`PayPal webhook not applied: the bot can't confirm the payment of subscription ${subId} at PayPal (${proof.latest === null ? 'PayPal lists no payment for it yet' : `its latest transaction is ${proof.latest}`}); PayPal sends the event again.`);
    }
    const emitted = this.decideOnce(subId, who, sub, plan, proof, view);
    const refunded = transactions.find((x: any) => x?.id === saleId && (x.status === 'REFUNDED' || x.status === 'PARTIALLY_REFUNDED'));
    if (refunded?.status === 'REFUNDED') {
      const computed = onceEndOf(proof.T, plan);
      const keptEnd = Date.parse(String(view?.meta?.keptEnd ?? ''));
      const end = Number.isFinite(keptEnd) ? Math.max(keptEnd, computed) : computed;
      const lead = `[PayPalProvider] Sale ${saleId} was refunded in full; subscription ${subId} (${holderWords(who.holder)})`;
      const kept = `${lead} keeps its tier for its payment of ${isoOf(proof.T)}`;
      console.warn(emitted === 'queued' ? `${kept} in the queue.`
        : emitted === 'created' || emitted === 'updated' ? `${kept}, until ${isoOf(end)}.`
          : emitted === 'expired' ? `${lead} was paid by its payment of ${isoOf(proof.T)}, and its paid period ended at ${isoOf(end)}.`
            : view ? `${kept}.`
              : `[PayPalProvider] Sale ${saleId} was refunded in full; the bot holds no tier for subscription ${subId} (${holderWords(who.holder)}), so nothing changed.`);
    } else if (refunded) {
      console.warn(`[PayPalProvider] Sale ${saleId} was refunded (${String(refunded.status)}), and it is not a full refund of the latest payment of subscription ${subId}; the subscription stays.`);
    }
    await this.cancelOnceIfDue(subId, who, sub, proof, view);
    if (!refunded) {
      throw new Error(`PayPal webhook not applied: sale ${saleId} was refunded, and PayPal does not list it yet among the payments of subscription ${subId}, which was sold as one payment; PayPal sends the event again.`);
    }
  }

  /**
   * A cancel at PayPal, with no chain (the caller holds it). A 4xx is followed by a read: CANCELLED or EXPIRED counts as
   * cancelled. The texts are the webhook's (PW3 to PW5) or premium's (PC1 to PC3). For premium, a read answering 404
   * means PayPal has no such subscription under these keys: the cancel says so, and "Cancel & remove now" logs it and
   * lets premium remove the entry.
   */
  private async cancelAt(id: string, reason: string, caller: 'webhook' | 'premium' | 'premium-remove' | 'override', texts: 'own' | 'premium' | CancelForms = 'own'): Promise<'cancelled' | 'CANCELLED' | 'EXPIRED' | 'missing'> {
    const forms: CancelForms | null = typeof texts === 'object' ? texts : caller === 'override' && texts === 'own' ? overrideForms(id) : null;
    try {
      await this.api<unknown>('POST', `${subscriptionPath(id)}/cancel`, { reason });
      if (caller === 'premium-remove' || caller === 'webhook') this.removedHere.add(id);
      return 'cancelled';
    } catch (error) {
      if (error instanceof PayPalNotCalled) {
        if (forms) throw new Error(forms.notSent(error.message));
        throw new Error(caller === 'webhook'
          ? `PayPal webhook not applied: the bot could not cancel subscription ${id} at PayPal (${error.message}); PayPal sends the event again.`
          : `The bot did not ask PayPal to cancel subscription ${id} (${error.message}). Nothing changed.`);
      }
      if (error instanceof PayPalApiError && error.status !== null && error.status < 500) {
        let sub: any;
        if (caller === 'webhook' && !forms) {
          sub = await this.readAt('subscription', id, subscriptionPath(id));
        } else {
          try {
            sub = await this.api<any>('GET', subscriptionPath(id));
          } catch (readError) {
            if (forms) {
              if (readError instanceof PayPalApiError && readError.status === 404) throw new Error(forms.missing());
              throw new Error(forms.unsure(paypalFailureText(readError)));
            }
            if (readError instanceof PayPalApiError && readError.status === 404) {
              const missing = `PayPal has no subscription ${id} for this bot's PayPal keys (PAYPAL_ENV ${providerCredentials('paypal').PAYPAL_ENV || 'sandbox'}); nothing was cancelled there. If it was made with other PayPal keys, it may still bill there.`;
              if (caller !== 'premium-remove') throw new Error(missing);
              console.warn(`[PayPalProvider] ${missing}`);
              return 'missing';
            }
            throw new Error(`Can't confirm whether PayPal cancelled subscription ${id} (${paypalFailureText(readError)}). Reload in a minute; the page shows the change once PayPal reports it.`);
          }
        }
        if (sub?.status === 'CANCELLED' || sub?.status === 'EXPIRED') {
          if (caller === 'premium-remove' || caller === 'webhook') this.removedHere.add(id);
          return sub.status;
        }
        const message = error.message.replace(/\.+$/, '');
        const status = typeof sub?.status === 'string' && sub.status ? sub.status : null;
        if (status === null) {
          const why = `PayPal answered ${error.status}: ${message}; its read showed no status`;
          if (forms) throw new Error(forms.unsure(why));
          throw new Error(caller === 'webhook'
            ? `PayPal webhook not applied: can't confirm whether PayPal cancelled subscription ${id} after its refund (${why}); PayPal sends the event again.`
            : `Can't confirm whether PayPal cancelled subscription ${id} (${why}). Reload in a minute; the page shows the change once PayPal reports it.`);
        }
        if (forms) throw new Error(forms.refused(message, status));
        throw new Error(caller === 'webhook'
          ? `PayPal webhook not applied: PayPal refused to cancel subscription ${id} after its refund (${message}) and its status there is ${status}; PayPal sends the event again.`
          : `PayPal refused to cancel subscription ${id}: ${message}. Its status at PayPal is ${status}.`);
      }
      const why = paypalFailureText(error);
      if (forms) throw new Error(forms.unsure(why));
      throw new Error(caller === 'webhook'
        ? `PayPal webhook not applied: can't confirm whether PayPal cancelled subscription ${id} after its refund (${why}); PayPal sends the event again.`
        : `Can't confirm whether PayPal cancelled subscription ${id} (${why}). Reload in a minute; the page shows the change once PayPal reports it.`);
    }
  }

  /** A suspend at PayPal, with no chain; a 4xx on a subscription PayPal holds SUSPENDED (or, sold as one payment, closed) counts as done. */
  private async suspendAt(id: string, reason: string): Promise<void> {
    try {
      await this.api<unknown>('POST', `${subscriptionPath(id)}/suspend`, { reason });
    } catch (error) {
      if (!(error instanceof PayPalApiError) || error.status === null || error.status >= 500) throw error;
      let sub: any;
      try {
        sub = await this.api<any>('GET', subscriptionPath(id));
      } catch {
        throw error;
      }
      const closedOnce = (sub?.status === 'CANCELLED' || sub?.status === 'EXPIRED') && customFrom(sub?.custom_id)?.once === true;
      if (sub?.status !== 'SUSPENDED' && !closedOnce) throw error;
    }
  }

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
    const c = providerCredentials('paypal');
    if (!c.PAYPAL_CLIENT_ID) throw new PayPalNotCalled({ key: 'PAYPAL_CLIENT_ID' });
    if (!c.PAYPAL_CLIENT_SECRET) throw new PayPalNotCalled({ key: 'PAYPAL_CLIENT_SECRET' });
    const auth = Buffer.from(`${c.PAYPAL_CLIENT_ID}:${c.PAYPAL_CLIENT_SECRET}`).toString('base64');
    let res: Response;
    try {
      res = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
        signal: AbortSignal.timeout(PROVIDER_FETCH_MS),
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
    } catch (error) {
      throw new PayPalNotCalled({ signIn: `PayPal did not answer: ${causeText(error)}` });
    }
    if (!res.ok) throw new PayPalNotCalled({ signIn: `PayPal answered ${res.status}` });
    let data: any;
    try {
      data = await res.json();
    } catch (error) {
      throw new PayPalNotCalled({ signIn: `PayPal did not answer: ${causeText(error)}` });
    }
    if (typeof data?.access_token !== 'string' || !data.access_token) {
      throw new PayPalNotCalled({ signIn: `PayPal answered ${res.status} with no access token` });
    }
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
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    let res: Response;
    try {
      res = await fetch(`${paypalApiBase()}${path}`, { ...init, signal: AbortSignal.timeout(PROVIDER_FETCH_MS) });
    } catch (error) {
      throw new PayPalApiError(causeText(error), null);
    }
    if (res.status === 204) return null;
    let text: string;
    try {
      text = await res.text();
    } catch (error) {
      if (res.status >= 400) throw new PayPalApiError('no message', res.status);
      throw new PayPalApiError(causeText(error), null);
    }
    let parsed: any = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { /* leave null */ }
    }
    if (res.status >= 400) {
      const message = parsed?.message || parsed?.error_description || 'no message';
      throw new PayPalApiError(String(message), res.status, typeof parsed?.name === 'string' ? parsed.name : undefined);
    }
    return parsed as T;
  }
}
