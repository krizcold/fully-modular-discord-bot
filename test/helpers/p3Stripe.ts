import crypto from 'crypto';
import http from 'http';
import { vi } from 'vitest';

// P3's seam (sheet P3, section 7): a fake of Stripe's API behind the global fetch, as p1ProvidersA.test.ts stubs it.
// It answers only the routes of stripeProvider.ts's calls; any other address is recorded in `unexpected`, answered
// with a thrown error, and a row asserts `unexpected` is empty after its steps. Stripe-side actions build Stripe's
// objects and queue the events Stripe would send, each event holding its object as it was at that moment. Premium's
// own calls (cancel, pause, resume, DELETE, the price change) change the objects and queue events the same way.
//
// What the fake assumes of Stripe where its documentation is silent, so a later reader can check it: a POST to a
// canceled subscription and a DELETE of one answer 400 with no code; a subscription bought with a delayed payment
// method is 'incomplete' with an open invoice until `asyncPaid`.

export const STRIPE_BASE = 'https://api.stripe.com';
export const WEBHOOK_SECRET = 'whsec_p3';
export const SECRET_KEY = 'sk_test_p3';
const DAY_S = 86_400;

type Obj = Record<string, any>;

/** A fault a row puts on the next matching calls. */
export type StripeFault =
  /** An HTTP error with Stripe's error body; nothing is changed (a 5xx to a create is stored under its key). */
  | { status: number; code?: string; param?: string; message?: string }
  /** No answer, thrown before the fake records or acts on the call. */
  | { drop: 'before' }
  /** The fake records and acts on the call, then the answer is lost (thrown). */
  | { drop: 'after' };

interface FaultRule { method: string; match: RegExp; fault: StripeFault; times: number }
interface HoldRule { method: string; match: RegExp; gate: Promise<void>; reached: () => void; times: number }

/** One call the fake received, in order. */
export interface StripeCall { method: string; path: string; params: Record<string, string>; headers: Record<string, string>; at: number }

/** An event as Stripe sends it. */
export interface StripeEvent { id: string; object: 'event'; type: string; created: number; api_version: string; data: { object: Obj } }

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const nowS = (): number => Math.floor(Date.now() / 1000);

/** Stripe's error body. */
const errorBody = (status: number, message: string, code?: string, param?: string): Obj => ({
  error: { type: status >= 500 ? 'api_error' : 'invalid_request_error', message, ...(code ? { code } : {}), ...(param ? { param } : {}) },
});

class Answer {
  constructor(readonly status: number, readonly body: Obj) {}
}
const missing = (kind: string, id: string, param?: string): Answer => new Answer(404, errorBody(404, `No such ${kind}: '${id}'`, 'resource_missing', param));
const bad = (message: string, code?: string, param?: string): Answer => new Answer(400, errorBody(400, message, code, param));

/** The params of a urlencoded body, last value wins. */
function formOf(body: unknown): Record<string, string> {
  if (typeof body !== 'string' || body === '') return {};
  return Object.fromEntries(new URLSearchParams(body).entries());
}

/** The `prefix[key]` entries of params as an object. */
function bracketed(params: Record<string, string>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith(`${prefix}[`) && key.endsWith(']')) out[key.slice(prefix.length + 1, -1)] = value;
  }
  return out;
}

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = init?.headers;
  if (!raw) return out;
  if (raw instanceof Headers) raw.forEach((value, key) => { out[key.toLowerCase()] = value; });
  else if (Array.isArray(raw)) for (const [key, value] of raw) out[key.toLowerCase()] = value;
  else for (const [key, value] of Object.entries(raw)) out[key.toLowerCase()] = String(value);
  return out;
}

/** The days of a price's interval, as stripeProvider.ts counts them. */
function intervalSeconds(price: Obj): number {
  const n = Math.max(1, price.recurring?.interval_count ?? 1);
  const days = { day: 1, week: 7, month: 30, year: 365 }[price.recurring?.interval as 'day'] ?? 30;
  return n * days * DAY_S;
}

/**
 * Premium's view of a Stripe subscription: the mapping of stripeProvider.ts:753-785 at bot-int 139b993 (status,
 * end and auto-renew), written out here so the invariants do not call a private method of src.
 */
export function mappedState(sub: Obj): { status: 'active' | 'paused' | 'expired'; endDate: string | null; autoRenew: boolean } {
  let status: 'active' | 'paused' | 'expired';
  if (sub.status === 'canceled' || sub.status === 'incomplete_expired') status = 'expired';
  else if (sub.pause_collection) status = 'paused';
  else if (['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status)) status = 'active';
  else if (sub.status === 'paused') status = 'paused';
  else status = 'expired';
  const end = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  const endDate = typeof end === 'number' && end > 0 ? new Date(end * 1000).toISOString() : null;
  return { status, endDate, autoRenew: !sub.cancel_at_period_end };
}

/**
 * The holder and the buyer a Stripe object's metadata names, by the keys the bot writes: `holder` and `buyerId`. An
 * object with only the old `guildId` and `userId` names no holder. The one reader of an object's owner for every P3 row.
 */
export function ownerOfMetadata(metadata: Obj | undefined | null): { holder: string | null; buyerId: string | null } {
  const meta = metadata ?? {};
  const holder = typeof meta.holder === 'string' && meta.holder !== '' ? meta.holder : null;
  const buyer = typeof meta.buyerId === 'string' && meta.buyerId !== '' ? meta.buyerId : null;
  return { holder, buyerId: buyer };
}

/** Signs a body by Stripe's documented scheme: `t=<s>,v1=<hex HMAC-SHA256 of "<s>.<body>">`. */
export function signStripe(body: string, at: number = nowS(), secret: string = WEBHOOK_SECRET): string {
  return `t=${at},v1=${crypto.createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`;
}

/** Signs a body with the stripe package's own test helper; the package is required at the first call. */
export function signWithPackage(body: string, at: number = nowS(), secret: string = WEBHOOK_SECRET): string {
  const { createRequire } = require('module') as typeof import('module');
  const stripe = createRequire(__filename)('stripe');
  return stripe.webhooks.generateTestHeaderString({ payload: body, secret, timestamp: at });
}

/** Posts a webhook to a mounted server with node's http (the fake owns the global fetch). */
export function postWebhook(base: string, providerId: string, body: string, signature: string): Promise<{ status: number; body: any }> {
  const url = new URL(`/webhook/${providerId}`, base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature, 'content-length': Buffer.byteLength(body) } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** One price the fake holds. */
export interface PriceSpec { id: string; product: string; productName: string; amount: number; currency?: string; interval?: 'day' | 'week' | 'month' | 'year' | null; active?: boolean }

export class FakeStripe {
  readonly calls: StripeCall[] = [];
  /** Calls to an address or route the fake does not serve. */
  readonly unexpected: string[] = [];
  readonly products = new Map<string, Obj>();
  readonly prices = new Map<string, Obj>();
  readonly promotionCodes = new Map<string, Obj>();
  readonly customers = new Map<string, Obj>();
  readonly sessions = new Map<string, Obj>();
  /** The params each Checkout Session was created with, as sent. */
  readonly sessionParams = new Map<string, Record<string, string>>();
  readonly subscriptions = new Map<string, Obj>();
  readonly invoices = new Map<string, Obj>();
  readonly paymentIntents = new Map<string, Obj>();
  readonly charges = new Map<string, Obj>();
  readonly portalSessions: Obj[] = [];
  /** Idempotency-Key to the stored answer of a customer create. */
  readonly idempotent = new Map<string, { params: string; status: number; body: Obj }>();
  /** Events not yet delivered, oldest first. */
  readonly queue: StripeEvent[] = [];
  private counter = 0;
  private faults: FaultRule[] = [];
  private holds: HoldRule[] = [];

  /** Installs the fake as the global fetch. */
  install(): this {
    vi.stubGlobal('fetch', vi.fn((url: unknown, init?: RequestInit) => this.fetch(String(url), init)));
    return this;
  }

  private next(prefix: string): string {
    this.counter += 1;
    return `${prefix}_p3${String(this.counter).padStart(6, '0')}`;
  }

  // ---------------------------------------------------------------------------- catalogue

  addPrice(spec: PriceSpec): Obj {
    if (!this.products.has(spec.product)) this.products.set(spec.product, { id: spec.product, object: 'product', name: spec.productName, active: true });
    const price = {
      id: spec.id,
      object: 'price',
      active: spec.active ?? true,
      currency: spec.currency ?? 'usd',
      unit_amount: spec.amount,
      type: spec.interval ? 'recurring' : 'one_time',
      recurring: spec.interval ? { interval: spec.interval, interval_count: 1, trial_period_days: null } : null,
      product: spec.product,
      nickname: null,
    };
    this.prices.set(spec.id, price);
    return price;
  }

  addPromotionCode(code: string, coupon: { percent_off?: number; amount_off?: number; currency?: string }, active = true): Obj {
    const promo = { id: this.next('promo'), object: 'promotion_code', code, active, coupon: { id: this.next('coupon'), duration: 'once', ...coupon } };
    this.promotionCodes.set(code, promo);
    return promo;
  }

  // ---------------------------------------------------------------------------- faults and holds

  /** The next `times` calls of `method` whose path matches answer with the fault. */
  fail(method: string, match: RegExp, fault: StripeFault, times = 1): void {
    this.faults.push({ method, match, fault, times });
  }

  /**
   * The next call of `method` whose path matches waits, before the fake acts on it, until the row calls `release`;
   * `reached` resolves when the call arrives. An abort of the caller's signal ends the wait with the abort's reason.
   */
  hold(method: string, match: RegExp): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const arrived = new Promise<void>(resolve => { reached = resolve; });
    this.holds.push({ method, match, gate, reached, times: 1 });
    return { reached: arrived, release };
  }

  private take<T extends { method: string; match: RegExp; times: number }>(list: T[], method: string, path: string): T | null {
    const rule = list.find(r => r.method === method && r.match.test(path) && r.times > 0);
    if (!rule) return null;
    rule.times -= 1;
    return rule;
  }

  // ---------------------------------------------------------------------------- the transport

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!url.startsWith(`${STRIPE_BASE}/`)) {
      this.unexpected.push(`${method} ${url}`);
      throw new TypeError(`p3Stripe: no route outside Stripe's API: ${method} ${url}`);
    }
    const path = url.slice(STRIPE_BASE.length);
    const fault = this.take(this.faults, method, path)?.fault ?? null;
    if (fault && 'drop' in fault && fault.drop === 'before') throw new TypeError('fetch failed');
    const headers = headersOf(init);
    const params = formOf(init?.body);
    this.calls.push({ method, path, params, headers, at: Date.now() });
    const held = this.take(this.holds, method, path);
    if (held) {
      held.reached();
      const signal = init?.signal ?? null;
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        void held.gate.then(resolve);
      });
    }
    if (fault && 'status' in fault) {
      const body = errorBody(fault.status, fault.message ?? `Stripe answered ${fault.status}`, fault.code, fault.param);
      if (method === 'POST' && path === '/v1/customers' && fault.status >= 500) {
        const key = headers['idempotency-key'];
        if (key && !this.idempotent.has(key)) this.idempotent.set(key, { params: JSON.stringify(params), status: fault.status, body });
      }
      return new Response(JSON.stringify(body), { status: fault.status });
    }
    if (!headers.authorization?.startsWith('Bearer ')) return this.respond(new Answer(401, errorBody(401, 'You did not provide an API key.')));
    let answer: Answer;
    try {
      answer = this.route(method, path, params, headers);
    } catch (error) {
      this.unexpected.push(`${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    if (fault && 'drop' in fault && fault.drop === 'after') throw new TypeError('fetch failed');
    return this.respond(answer);
  }

  private respond(answer: Answer): Response {
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }

  private route(method: string, path: string, params: Record<string, string>, headers: Record<string, string>): Answer {
    const [pathname, search = ''] = path.split('?');
    const query = new URLSearchParams(search);
    const expand = query.getAll('expand[]');
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'v1') throw new Error('not a v1 route');
    const [, kind, id, sub] = parts;
    const ok = (body: Obj): Answer => new Answer(200, body);

    if (kind === 'prices' && method === 'GET' && id) {
      const price = this.prices.get(id);
      return price ? ok(this.priceOut(price, expand.includes('product'))) : missing('price', id);
    }
    if (kind === 'prices' && method === 'GET' && !id) {
      const product = query.get('product');
      const data = [...this.prices.values()].filter(p => p.product === product && (query.get('active') !== 'true' || p.active))
        .map(p => this.priceOut(p, expand.includes('data.product')));
      return ok({ object: 'list', data, has_more: false });
    }
    if (kind === 'promotion_codes' && method === 'GET' && !id) {
      const promo = this.promotionCodes.get(query.get('code') ?? '');
      const data = promo && (query.get('active') !== 'true' || promo.active) ? [clone(promo)] : [];
      return ok({ object: 'list', data, has_more: false });
    }
    if (kind === 'customers' && method === 'POST' && !id) return this.createCustomer(params, headers['idempotency-key']);
    if (kind === 'checkout' && id === 'sessions' && method === 'POST' && !sub) return this.createSession(params);
    if (kind === 'checkout' && id === 'sessions' && method === 'GET' && sub) {
      const session = this.sessions.get(sub);
      return session ? ok(this.sessionOut(session, expand)) : missing('checkout.session', sub);
    }
    if (kind === 'checkout' && id === 'sessions' && method === 'GET' && !sub) {
      const pi = query.get('payment_intent');
      const data = [...this.sessions.values()].filter(s => pi !== null && s.payment_intent === pi).map(s => this.sessionOut(s, []));
      return ok({ object: 'list', data, has_more: false });
    }
    if (kind === 'subscriptions' && id === 'search' && method === 'GET') {
      const data = [...this.subscriptions.values()].filter(s => this.searchMatches(s, query.get('query') ?? '')).map(s => this.subscriptionOut(s));
      return ok({ object: 'search_result', data, has_more: false, next_page: null });
    }
    if (kind === 'subscriptions' && !id && method === 'GET') {
      const status = query.get('status');
      const data = [...this.subscriptions.values()]
        .filter(s => (status === 'all' ? true : status ? s.status === status : s.status !== 'canceled'))
        .map(s => this.subscriptionOut(s));
      return ok({ object: 'list', data, has_more: false });
    }
    if (kind === 'subscriptions' && id && method === 'GET') {
      const found = this.subscriptions.get(id);
      return found ? ok(this.subscriptionOut(found)) : missing('subscription', id);
    }
    if (kind === 'subscriptions' && id && method === 'POST') return this.updateSubscription(id, params);
    if (kind === 'subscriptions' && id && method === 'DELETE') return this.deleteSubscription(id);
    if (kind === 'invoices' && id && method === 'GET') {
      const invoice = this.invoices.get(id);
      return invoice ? ok(clone(invoice)) : missing('invoice', id);
    }
    if (kind === 'charges' && id && method === 'GET') {
      const charge = this.charges.get(id);
      if (!charge) return missing('charge', id);
      const out = clone(charge);
      if (expand.includes('invoice') && out.invoice) out.invoice = clone(this.invoices.get(out.invoice) ?? out.invoice);
      return ok(out);
    }
    if (kind === 'payment_intents' && id && method === 'GET') {
      const pi = this.paymentIntents.get(id);
      if (!pi) return missing('payment_intent', id);
      const out = clone(pi);
      if (expand.includes('latest_charge') && out.latest_charge) out.latest_charge = clone(this.charges.get(out.latest_charge) ?? out.latest_charge);
      return ok(out);
    }
    if (kind === 'billing_portal' && id === 'sessions' && method === 'POST') {
      const customer = params.customer;
      if (!customer || !this.customers.has(customer)) return missing('customer', customer ?? '', 'customer');
      const portal = { id: this.next('bps'), object: 'billing_portal.session', customer, return_url: params.return_url ?? null, url: `https://billing.stripe.example/p/${customer}` };
      this.portalSessions.push(portal);
      return ok(clone(portal));
    }
    throw new Error('no such route in the fake');
  }

  // ---------------------------------------------------------------------------- objects out

  private priceOut(price: Obj, expandProduct: boolean): Obj {
    const out = clone(price);
    if (expandProduct) out.product = clone(this.products.get(price.product) ?? price.product);
    return out;
  }

  private sessionOut(session: Obj, expand: string[]): Obj {
    const out = clone(session);
    if (out.payment_intent && (expand.includes('payment_intent') || expand.includes('payment_intent.latest_charge'))) {
      const pi = clone(this.paymentIntents.get(out.payment_intent) ?? null);
      if (pi && expand.includes('payment_intent.latest_charge') && pi.latest_charge) pi.latest_charge = clone(this.charges.get(pi.latest_charge) ?? pi.latest_charge);
      out.payment_intent = pi ?? out.payment_intent;
    }
    return out;
  }

  /** A subscription as the API answers it: its items carry their price objects (`expand[]=items.data.price` or not). */
  private subscriptionOut(sub: Obj): Obj {
    const out = clone(sub);
    for (const item of out.items.data) item.price = clone(this.prices.get(item.price) ?? item.price);
    return out;
  }

  private searchMatches(sub: Obj, query: string): boolean {
    const terms = [...query.matchAll(/metadata\['((?:[^'\\]|\\.)*)'\]:'((?:[^'\\]|\\.)*)'/g)];
    if (terms.length === 0) return false;
    const unescape = (text: string): string => text.replace(/\\(.)/g, '$1');
    return terms.every(([, key, value]) => sub.metadata?.[unescape(key)] === unescape(value));
  }

  // ---------------------------------------------------------------------------- the calls that write

  private createCustomer(params: Record<string, string>, key: string | undefined): Answer {
    const sent = JSON.stringify(params);
    if (key) {
      const stored = this.idempotent.get(key);
      if (stored) {
        if (stored.params !== sent) return bad('Keys for idempotent requests can only be used with the same parameters they were first used with.', 'idempotency_key_in_use');
        return new Answer(stored.status, clone(stored.body));
      }
    }
    const customer = { id: this.next('cus'), object: 'customer', created: nowS(), metadata: bracketed(params, 'metadata') };
    this.customers.set(customer.id, customer);
    if (key) this.idempotent.set(key, { params: sent, status: 200, body: clone(customer) });
    return new Answer(200, clone(customer));
  }

  private createSession(params: Record<string, string>): Answer {
    const priceId = params['line_items[0][price]'];
    const price = priceId ? this.prices.get(priceId) : undefined;
    if (!price) return missing('price', priceId ?? '', 'line_items[0][price]');
    if (!price.active) return bad(`The price specified is inactive. This field only accepts active prices.`, undefined, 'line_items[0][price]');
    const mode = params.mode;
    if (mode !== 'subscription' && mode !== 'payment') return bad('Invalid mode', undefined, 'mode');
    if ((mode === 'subscription') !== (price.type === 'recurring')) {
      return bad(mode === 'subscription' ? 'You must provide at least one recurring price in `subscription` mode when using prices.' : 'You specified `payment` mode but passed a recurring price.', undefined, 'line_items[0][price]');
    }
    if (params.customer !== undefined && !this.customers.has(params.customer)) return missing('customer', params.customer, 'customer');
    const promo = params['discounts[0][promotion_code]'];
    if (promo !== undefined && ![...this.promotionCodes.values()].some(p => p.id === promo)) return missing('promotion_code', promo, 'discounts[0][promotion_code]');
    const id = this.next('cs_test');
    const session = {
      id,
      object: 'checkout.session',
      url: `https://checkout.stripe.example/c/pay/${id}`,
      mode,
      status: 'open',
      payment_status: 'unpaid',
      customer: params.customer ?? null,
      subscription: null,
      payment_intent: null,
      client_reference_id: params.client_reference_id ?? null,
      metadata: bracketed(params, 'metadata'),
      success_url: params.success_url ?? null,
      cancel_url: params.cancel_url ?? null,
      amount_total: price.unit_amount,
      currency: price.currency,
    };
    this.sessions.set(id, session);
    this.sessionParams.set(id, { ...params });
    return new Answer(200, clone(session));
  }

  private updateSubscription(id: string, params: Record<string, string>): Answer {
    const sub = this.subscriptions.get(id);
    if (!sub) return missing('subscription', id);
    if (sub.status === 'canceled') return bad('A canceled subscription can only update its cancellation_details and metadata.');
    if (params.cancel_at_period_end !== undefined) sub.cancel_at_period_end = params.cancel_at_period_end === 'true';
    if ('pause_collection' in params && params.pause_collection === '') sub.pause_collection = null;
    if (params['pause_collection[behavior]']) sub.pause_collection = { behavior: params['pause_collection[behavior]'] };
    if (params.trial_end !== undefined) {
      sub.trial_end = Number(params.trial_end);
      sub.current_period_end = sub.trial_end;
      sub.items.data[0].current_period_end = sub.trial_end;
    }
    if (params['items[0][price]'] !== undefined) {
      const price = this.prices.get(params['items[0][price]']);
      if (!price) return missing('price', params['items[0][price]'], 'items[0][price]');
      if (params['items[0][id]'] !== sub.items.data[0].id) return bad(`Invalid subscription item: '${params['items[0][id]']}'`, undefined, 'items[0][id]');
      sub.items.data[0].price = price.id;
    }
    for (const [key, value] of Object.entries(bracketed(params, 'metadata'))) {
      if (value === '') delete sub.metadata[key];
      else sub.metadata[key] = value;
    }
    this.emit('customer.subscription.updated', this.subscriptionOut(sub));
    return new Answer(200, this.subscriptionOut(sub));
  }

  private deleteSubscription(id: string): Answer {
    const sub = this.subscriptions.get(id);
    if (!sub) return missing('subscription', id);
    if (sub.status === 'canceled') return bad('This subscription has already been canceled.');
    this.cancelNow(sub);
    return new Answer(200, this.subscriptionOut(sub));
  }

  // ---------------------------------------------------------------------------- events

  private emit(type: string, object: Obj): StripeEvent {
    const event: StripeEvent = { id: this.next('evt'), object: 'event', type, created: nowS(), api_version: '2024-11-20.acacia', data: { object: clone(object) } };
    this.queue.push(event);
    return event;
  }

  /** Takes the event at `index` of the queue (the oldest by default) out of it. */
  dequeue(index = 0): StripeEvent | null {
    if (this.queue.length === 0) return null;
    return this.queue.splice(Math.max(0, Math.min(index, this.queue.length - 1)), 1)[0];
  }

  // ---------------------------------------------------------------------------- Stripe-side actions

  private payment(amount: number, currency: string, invoice: string | null): { pi: Obj; charge: Obj } {
    const pi = { id: this.next('pi'), object: 'payment_intent', status: 'succeeded', amount, currency, latest_charge: null as string | null, invoice };
    const charge = { id: this.next('ch'), object: 'charge', amount, amount_refunded: 0, refunded: false, currency, paid: true, status: 'succeeded', invoice, payment_intent: pi.id };
    pi.latest_charge = charge.id;
    this.paymentIntents.set(pi.id, pi);
    this.charges.set(charge.id, charge);
    return { pi, charge };
  }

  private invoiceFor(sub: Obj, paid: boolean): Obj {
    const price = this.prices.get(sub.items.data[0].price)!;
    const invoice: Obj = {
      id: this.next('in'), object: 'invoice', subscription: sub.id, customer: sub.customer, status: paid ? 'paid' : 'open',
      amount_due: price.unit_amount, amount_paid: paid ? price.unit_amount : 0, currency: price.currency,
      period_start: sub.current_period_start, period_end: sub.current_period_end, charge: null, payment_intent: null,
      last_finalization_error: null,
    };
    if (paid) {
      const { pi, charge } = this.payment(price.unit_amount, price.currency, invoice.id);
      invoice.charge = charge.id;
      invoice.payment_intent = pi.id;
    }
    this.invoices.set(invoice.id, invoice);
    sub.latest_invoice = invoice.id;
    return invoice;
  }

  /**
   * The buyer finishes the checkout: paid at once, or (paid false) with a delayed payment method still unpaid. With
   * `noPayment` a payment-mode session completes as a 100% coupon does: `payment_status` 'no_payment_required' and no
   * payment intent.
   */
  complete(sessionId: string, opts: { paid?: boolean; noPayment?: boolean } = {}): Obj {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'open') throw new Error(`p3Stripe.complete: ${sessionId} is not an open session`);
    if (opts.noPayment) {
      if (session.mode !== 'payment') throw new Error(`p3Stripe.complete: ${sessionId} is not a payment-mode session, so it cannot need no payment`);
      if (!session.customer) {
        const customer = { id: this.next('cus'), object: 'customer', created: nowS(), metadata: {} };
        this.customers.set(customer.id, customer);
        session.customer = customer.id;
      }
      Object.assign(session, { status: 'complete', payment_status: 'no_payment_required', payment_intent: null, amount_total: 0 });
      this.emit('checkout.session.completed', session);
      return session;
    }
    const paid = opts.paid ?? true;
    const params = this.sessionParams.get(sessionId)!;
    const price = this.prices.get(params['line_items[0][price]'])!;
    if (!session.customer) {
      const customer = { id: this.next('cus'), object: 'customer', created: nowS(), metadata: {} };
      this.customers.set(customer.id, customer);
      session.customer = customer.id;
    }
    session.status = 'complete';
    session.payment_status = paid ? 'paid' : 'unpaid';
    if (session.mode === 'subscription') {
      const start = nowS();
      const trialEnd = params['subscription_data[trial_end]'] ? Number(params['subscription_data[trial_end]']) : null;
      const end = trialEnd ?? start + intervalSeconds(price);
      const sub: Obj = {
        id: this.next('sub'), object: 'subscription', customer: session.customer,
        status: !paid ? 'incomplete' : trialEnd ? 'trialing' : 'active',
        cancel_at_period_end: params['subscription_data[cancel_at_period_end]'] === 'true',
        current_period_start: start, current_period_end: end, start_date: start, trial_end: trialEnd, pause_collection: null,
        canceled_at: null, latest_invoice: null,
        items: { object: 'list', data: [{ id: this.next('si'), object: 'subscription_item', price: price.id, current_period_start: start, current_period_end: end }] },
        metadata: bracketed(params, 'subscription_data[metadata]'),
      };
      this.subscriptions.set(sub.id, sub);
      session.subscription = sub.id;
      const invoice = this.invoiceFor(sub, paid);
      this.emit('customer.subscription.created', this.subscriptionOut(sub));
      if (paid) this.emit('invoice.paid', invoice);
    } else if (paid) {
      const { pi } = this.payment(price.unit_amount, price.currency, null);
      session.payment_intent = pi.id;
    } else {
      const pi = { id: this.next('pi'), object: 'payment_intent', status: 'processing', amount: price.unit_amount, currency: price.currency, latest_charge: null, invoice: null };
      this.paymentIntents.set(pi.id, pi);
      session.payment_intent = pi.id;
    }
    this.emit('checkout.session.completed', session);
    return session;
  }

  /**
   * An invoice made in Stripe's dashboard: no `subscription`, paid, with a charge a row can refund. Queues
   * `invoice.paid`, as Stripe does.
   */
  dashboardInvoice(opts: { customer?: string; amount?: number; currency?: string } = {}): { invoice: Obj; charge: Obj } {
    let customer = opts.customer;
    if (!customer) {
      const made = { id: this.next('cus'), object: 'customer', created: nowS(), metadata: {} };
      this.customers.set(made.id, made);
      customer = made.id;
    }
    const amount = opts.amount ?? 1500;
    const currency = opts.currency ?? 'usd';
    const invoice: Obj = {
      id: this.next('in'), object: 'invoice', subscription: null, customer, status: 'paid', amount_due: amount, amount_paid: amount, currency,
      period_start: nowS(), period_end: nowS(), charge: null, payment_intent: null, last_finalization_error: null,
    };
    const { pi, charge } = this.payment(amount, currency, invoice.id);
    invoice.charge = charge.id;
    invoice.payment_intent = pi.id;
    this.invoices.set(invoice.id, invoice);
    this.emit('invoice.paid', invoice);
    return { invoice, charge };
  }

  /** A delayed payment of a completed session succeeds. */
  asyncPaid(sessionId: string): Obj {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'complete' || session.payment_status !== 'unpaid') throw new Error(`p3Stripe.asyncPaid: ${sessionId} is not a completed unpaid session`);
    session.payment_status = 'paid';
    if (session.subscription) {
      const sub = this.subscriptions.get(session.subscription)!;
      const invoice = this.invoices.get(sub.latest_invoice)!;
      const { pi, charge } = this.payment(invoice.amount_due, invoice.currency, invoice.id);
      Object.assign(invoice, { status: 'paid', amount_paid: invoice.amount_due, charge: charge.id, payment_intent: pi.id });
      sub.status = 'active';
      this.emit('invoice.paid', invoice);
      this.emit('customer.subscription.updated', this.subscriptionOut(sub));
    } else {
      const pi = this.paymentIntents.get(session.payment_intent)!;
      const charge = { id: this.next('ch'), object: 'charge', amount: pi.amount, amount_refunded: 0, refunded: false, currency: pi.currency, paid: true, status: 'succeeded', invoice: null, payment_intent: pi.id };
      this.charges.set(charge.id, charge);
      Object.assign(pi, { status: 'succeeded', latest_charge: charge.id });
    }
    this.emit('checkout.session.async_payment_succeeded', session);
    return session;
  }

  /** A delayed payment of a completed session fails. */
  asyncFailed(sessionId: string): Obj {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'complete' || session.payment_status !== 'unpaid') throw new Error(`p3Stripe.asyncFailed: ${sessionId} is not a completed unpaid session`);
    if (session.subscription) {
      const sub = this.subscriptions.get(session.subscription)!;
      sub.status = 'incomplete_expired';
      this.emit('customer.subscription.updated', this.subscriptionOut(sub));
    }
    this.emit('checkout.session.async_payment_failed', session);
    return session;
  }

  private live(id: string, action: string): Obj {
    const sub = this.subscriptions.get(id);
    if (!sub || sub.status === 'canceled') throw new Error(`p3Stripe.${action}: ${id} is not a live subscription`);
    return sub;
  }

  /** A new period is billed and paid. */
  renew(id: string): Obj {
    const sub = this.live(id, 'renew');
    const price = this.prices.get(sub.items.data[0].price)!;
    sub.current_period_start = sub.current_period_end;
    sub.current_period_end = sub.current_period_start + intervalSeconds(price);
    Object.assign(sub.items.data[0], { current_period_start: sub.current_period_start, current_period_end: sub.current_period_end });
    sub.status = 'active';
    const invoice = this.invoiceFor(sub, true);
    this.emit('invoice.paid', invoice);
    this.emit('customer.subscription.updated', this.subscriptionOut(sub));
    return sub;
  }

  /** The buyer sets cancel at period end in Stripe's portal. */
  portalCancel(id: string): Obj {
    const sub = this.live(id, 'portalCancel');
    sub.cancel_at_period_end = true;
    this.emit('customer.subscription.updated', this.subscriptionOut(sub));
    return sub;
  }

  /** The buyer turns renewal back on in Stripe's portal. */
  portalRenew(id: string): Obj {
    const sub = this.live(id, 'portalRenew');
    sub.cancel_at_period_end = false;
    this.emit('customer.subscription.updated', this.subscriptionOut(sub));
    return sub;
  }

  private cancelNow(sub: Obj): void {
    sub.status = 'canceled';
    sub.canceled_at = nowS();
    this.emit('customer.subscription.deleted', this.subscriptionOut(sub));
  }

  /** The subscription ends at Stripe (canceled in the dashboard, or its period ran out after a cancel). */
  end(id: string): Obj {
    const sub = this.live(id, 'end');
    this.cancelNow(sub);
    return sub;
  }

  /** A renewal payment fails: an open invoice, the subscription past due. */
  failPayment(id: string, message = 'Your card was declined.'): Obj {
    const sub = this.live(id, 'failPayment');
    const invoice = this.invoiceFor(sub, false);
    invoice.last_finalization_error = { message };
    sub.status = 'past_due';
    this.emit('invoice.payment_failed', invoice);
    this.emit('customer.subscription.updated', this.subscriptionOut(sub));
    return sub;
  }

  /** The price of the subscription changes at Stripe (a plan switch in the portal). */
  switchPrice(id: string, priceId: string): Obj {
    const sub = this.live(id, 'switchPrice');
    if (!this.prices.has(priceId)) throw new Error(`p3Stripe.switchPrice: no price ${priceId}`);
    sub.items.data[0].price = priceId;
    this.emit('customer.subscription.updated', this.subscriptionOut(sub));
    return sub;
  }

  /** A refund of `amount` of a charge (the rest of it when omitted). */
  refund(chargeId: string, amount?: number): Obj {
    const charge = this.charges.get(chargeId);
    if (!charge) throw new Error(`p3Stripe.refund: no charge ${chargeId}`);
    const left = charge.amount - charge.amount_refunded;
    const take = Math.min(left, amount ?? left);
    if (take <= 0) throw new Error(`p3Stripe.refund: ${chargeId} is refunded in full already`);
    charge.amount_refunded += take;
    charge.refunded = charge.amount_refunded >= charge.amount;
    this.emit('charge.refunded', charge);
    return charge;
  }

  /** The object is deleted at Stripe: a later read of it answers 404 resource_missing. */
  deleteObject(kind: 'subscription' | 'session' | 'invoice' | 'charge' | 'customer' | 'payment_intent', id: string): void {
    const maps: Record<string, Map<string, Obj>> = {
      subscription: this.subscriptions, session: this.sessions, invoice: this.invoices, charge: this.charges, customer: this.customers, payment_intent: this.paymentIntents,
    };
    if (!maps[kind].delete(id)) throw new Error(`p3Stripe.deleteObject: no ${kind} ${id}`);
  }

  // ---------------------------------------------------------------------------- reading the fake

  /** The latest charge of a subscription (its latest invoice's) or of a one-time session; null with none. */
  latestCharge(id: string): Obj | null {
    const sub = this.subscriptions.get(id);
    if (sub) return this.charges.get(this.invoices.get(sub.latest_invoice)?.charge ?? '') ?? null;
    const session = this.sessions.get(id);
    if (session?.payment_intent) return this.charges.get(this.paymentIntents.get(session.payment_intent)?.latest_charge ?? '') ?? null;
    return null;
  }

  /** Sessions still open (made and not completed). */
  openSessions(): Obj[] {
    return [...this.sessions.values()].filter(s => s.status === 'open');
  }

  /** The calls of one method and path pattern. */
  callsOf(method: string, match: RegExp): StripeCall[] {
    return this.calls.filter(c => c.method === method && match.test(c.path.split('?')[0]));
  }

  /** Everything the fake holds, for a fixture; `load` takes it back. */
  dump(): Obj {
    const of = (map: Map<string, Obj>) => Object.fromEntries([...map].map(([k, v]) => [k, clone(v)]));
    return {
      counter: this.counter,
      products: of(this.products), prices: of(this.prices), promotionCodes: of(this.promotionCodes), customers: of(this.customers),
      sessions: of(this.sessions), sessionParams: Object.fromEntries([...this.sessionParams].map(([k, v]) => [k, { ...v }])),
      subscriptions: of(this.subscriptions), invoices: of(this.invoices), paymentIntents: of(this.paymentIntents), charges: of(this.charges),
    };
  }

  load(dump: Obj): void {
    this.counter = Math.max(this.counter, dump.counter ?? 0);
    const into = (map: Map<string, Obj>, from: Obj | undefined) => { for (const [k, v] of Object.entries(from ?? {})) map.set(k, clone(v)); };
    into(this.products, dump.products);
    into(this.prices, dump.prices);
    into(this.promotionCodes, dump.promotionCodes);
    into(this.customers, dump.customers);
    into(this.sessions, dump.sessions);
    for (const [k, v] of Object.entries<Record<string, string>>(dump.sessionParams ?? {})) this.sessionParams.set(k, { ...v });
    into(this.subscriptions, dump.subscriptions);
    into(this.invoices, dump.invoices);
    into(this.paymentIntents, dump.paymentIntents);
    into(this.charges, dump.charges);
  }
}
