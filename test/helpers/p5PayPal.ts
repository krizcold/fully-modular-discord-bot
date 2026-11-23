import crypto from 'crypto';
import http from 'http';
import { vi } from 'vitest';

// P5's seam (sheet P5, Revision 9, Z12): a fake of PayPal's REST API behind the global fetch. It answers only the
// routes of paypalProvider.ts's calls, on the sandbox and the live base; any other address or route is recorded in
// `unexpected`, answered with a thrown error, and a row asserts `unexpected` is empty after its steps. PayPal-side
// actions build PayPal's objects and queue the events PayPal would send, each holding its resource as it was at that
// moment. Premium's calls (cancel, suspend, activate, revise) change the objects and queue events the same way.
//
// Verification: every delivery the fake makes (`sign`) is recorded by its transmission id with its exact body text,
// its five headers and the webhook id it was sent to. The verify route cuts `webhook_event` as text from the posted
// bytes (after `"webhook_event":` up to the body's last `}`) and answers SUCCESS only when that text equals the
// recorded body byte for byte, every header value matches and `webhook_id` is the delivery's; FAILURE otherwise. It
// never parses and re-serialises the event.
//
// What the fake assumes of PayPal where its documentation is silent, so a later reader can check it: a renewal and a
// failed attempt happen at the subscription's `next_billing_time` (a row passes `at` for another time); a failed
// attempt adds the cycle's price to `outstanding_balance` once per unpaid cycle; a cancel or an expiry removes
// `next_billing_time`; the transactions list holds the sales only (no failed attempts), each under its sale id;
// premium's cancel of a subscription that is not ACTIVE or SUSPENDED, a suspend of one that is not ACTIVE and an
// activate of one that is not SUSPENDED answer 422 UNPROCESSABLE_ENTITY with the issue SUBSCRIPTION_STATUS_INVALID.

export const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
export const LIVE_BASE = 'https://api-m.paypal.com';
export const APP_CLIENT_ID = 'AcP5-client-id';
export const APP_CLIENT_SECRET = 'EHp5-client-secret';
const DAY_MS = 86_400_000;

type Obj = Record<string, any>;
export type Unit = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

/** A fault a row puts on the next matching calls. */
export type PayPalFault =
  /** An HTTP error with PayPal's error body (`name` chosen by the row), or 204 with no body; nothing is changed. */
  | { status: number; name?: string; message?: string; issue?: string }
  /** No answer, thrown before the fake records or acts on the call. */
  | { drop: 'before' }
  /** The fake records and acts on the call, then the answer is lost (thrown). */
  | { drop: 'after' };

interface FaultRule { method: string; match: RegExp; fault: PayPalFault; times: number }
interface HoldRule { method: string; match: RegExp; gate: Promise<void>; reached: () => void; times: number }

/** One call the fake received, in order. `path` holds the query; `text` is the body exactly as sent. */
export interface PayPalCall { method: string; base: string; path: string; text: string | null; json: any; headers: Record<string, string>; at: number }

/** A webhook event as PayPal sends it. */
export interface PayPalEvent {
  id: string;
  event_version: string;
  create_time: string;
  resource_type: string;
  resource_version: string;
  event_type: string;
  summary: string;
  resource: Obj;
  links: Obj[];
}

/** One signed delivery: the body text and the headers PayPal posts with it. */
export interface Delivery { body: string; headers: Record<string, string>; webhookId: string; transmissionId: string }

/** One plan the fake holds. A trial is free unless it has a price. */
export interface PlanSpec {
  id: string;
  productId: string;
  name: string;
  unit: Unit;
  count?: number;
  /** The price of one regular cycle, PayPal's decimal text ('5.00'). */
  price: string;
  currency?: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'CREATED';
  trial?: { unit: Unit; count?: number; cycles: number; price?: string };
  quantitySupported?: boolean;
  /** `payment_preferences.setup_fee`, PayPal's decimal text ('5.00'). */
  setupFee?: string;
  /** The REGULAR cycle's `total_cycles` (0, infinite, by default). */
  totalCycles?: number;
}

/**
 * Per subscription, what PayPal does where its documentation is silent (sheet P5P, Y0 and Y7). Each is one way a real
 * PayPal could behave; a row sets them with `configure` and clears them with `release`.
 */
export interface FakeSettings {
  /** The last cycle paid: EXPIRED right after the sale (the default), ACTIVE until `expire`, or never expired. */
  finalCycle?: 'expire-at-payment' | 'active-to-period-end' | 'stays-active';
  /** After the last cycle is paid, `next_billing_time` is set to the last payment's time and kept (removed by default). */
  keepNextAfterFinal?: boolean;
  /** How a read shows an applied override: by `plan_overridden`, by `cycle_executions`, by both (the default), or neither. */
  showOverrideBy?: 'flag' | 'cycles' | 'both' | 'none';
  /** The override is not applied: `plan_overridden` false, the plan's own `total_cycles`, billed at each due date. */
  ignoreOverride?: boolean;
  /** The read shows the override by both fields, and `renew` still bills at each due date while ACTIVE. */
  billsDespiteOverride?: boolean;
  omitCycleExecutions?: boolean;
  /** The REGULAR `cycles_completed` a read shows stays at this number (the count when set, for `true`). */
  staleCycles?: boolean | number;
  omitLastPayment?: boolean;
  /** With `omitLastPayment`, only reads in this status leave it out. */
  omitLastPaymentOn?: string;
  /** The transactions list stays as it was when this was set: later sales and later refunds are not shown. */
  listLag?: boolean;
  /** The latest sale is listed PENDING; the read carries no `last_payment` for it unless `lpWhilePending`. */
  pendingSale?: boolean;
  lpWhilePending?: boolean;
  /** Seconds by which a listed transaction's `time` is earlier (positive) or later (negative) than its sale's `last_payment.time`. */
  lpSkew?: number;
  /** The transactions call answers 404 while no transaction falls in its range. */
  emptyListIs404?: boolean;
  /** The list names each sale by another id than the sale's own (R14). */
  listOtherIds?: boolean;
}

/** A PayPal-side action the fake refuses because PayPal would not do it (no cycle left to bill, a closed subscription). */
export class FakeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FakeRefusal';
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const cents = (value: string): number => Math.round(Number.parseFloat(value) * 100);
const money = (c: number): string => (c / 100).toFixed(2);
/** The object as PayPal answers it: keys starting with `_` are the fake's own bookkeeping. */
const out = (obj: Obj): Obj => JSON.parse(JSON.stringify(obj, (key, value) => (key.startsWith('_') ? undefined : value)));

/** `start` plus `n` steps of `count` units on the UTC calendar; a month or year step keeps the start's day, clamped to the month's last day. */
export function addCycles(start: number, unit: Unit, count: number, n: number): number {
  if (unit === 'DAY') return start + n * count * DAY_MS;
  if (unit === 'WEEK') return start + n * count * 7 * DAY_MS;
  const d = new Date(start);
  const months = (unit === 'YEAR' ? 12 : 1) * count * n;
  const target = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(target / 12);
  const month = ((target % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/**
 * The custom_id of Z2 for a purchase: `<holder>|<buyerId>|<tierId>|<offeringId>|<sig>`, `sig` the first 16 bytes of
 * HMAC-SHA256 keyed with the app's secret over the lines `smdb-paypal-custom`, the bot's CLIENT_ID, holder, buyer, tier
 * and offering (joined by `\n`), in base64url. For rows that forge one or check what the checkout sent.
 */
export function customIdFor(fields: { clientId: string; secret?: string; holder: string; buyerId: string; tierId: string; offeringId: string; once?: true }): string {
  const named = [fields.holder, fields.buyerId, fields.tierId, fields.offeringId, ...(fields.once ? ['once'] : [])];
  const lines = ['smdb-paypal-custom', fields.clientId, ...named].join('\n');
  const sig = crypto.createHmac('sha256', fields.secret ?? APP_CLIENT_SECRET).update(lines).digest().subarray(0, 16).toString('base64url');
  return [...named, sig].join('|');
}

/**
 * The holder and the buyer a custom_id names: the five-field form of Z2, or the JSON form the bot wrote before P5
 * (`guildId`, `userId`). Null fields when it names none. It does not check the signature.
 */
export function ownerOfCustomId(text: unknown): { holder: string | null; buyerId: string | null; form: 'fields' | 'json' | null } {
  if (typeof text !== 'string' || text === '') return { holder: null, buyerId: null, form: null };
  const fields = text.split('|');
  const sized = fields.length === 5 || (fields.length === 6 && fields[4] === 'once');
  if (sized && /^(guild|user):\d{17,20}$/.test(fields[0])) return { holder: fields[0], buyerId: fields[1] || null, form: 'fields' };
  try {
    const json = JSON.parse(text);
    if (json && typeof json.guildId === 'string') return { holder: `guild:${json.guildId}`, buyerId: typeof json.userId === 'string' ? json.userId : null, form: 'json' };
  } catch { /* not JSON */ }
  return { holder: null, buyerId: null, form: null };
}

function headersOf(init?: RequestInit): Record<string, string> {
  const result: Record<string, string> = {};
  const raw = init?.headers;
  if (!raw) return result;
  if (raw instanceof Headers) raw.forEach((value, key) => { result[key.toLowerCase()] = value; });
  else if (Array.isArray(raw)) for (const [key, value] of raw) result[key.toLowerCase()] = value;
  else for (const [key, value] of Object.entries(raw)) result[key.toLowerCase()] = String(value);
  return result;
}

/** Posts a delivery to a mounted server with node's http (the fake owns the global fetch). */
export function postWebhook(base: string, providerId: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const url = new URL(`/webhook/${providerId}`, base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, res => {
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

class Answer {
  constructor(readonly status: number, readonly body: Obj | null) {}
}

/** PayPal's REST error body. */
function errorBody(status: number, name?: string, message?: string, issue?: string): Obj {
  const fallback: Record<number, [string, string]> = {
    400: ['INVALID_REQUEST', 'Request is not well-formed, syntactically incorrect, or violates schema.'],
    401: ['AUTHENTICATION_FAILURE', 'Authentication failed due to invalid authentication credentials or a missing Authorization header.'],
    403: ['NOT_AUTHORIZED', 'Authorization failed due to insufficient permissions.'],
    404: ['RESOURCE_NOT_FOUND', 'The specified resource does not exist.'],
    422: ['UNPROCESSABLE_ENTITY', 'The requested action could not be performed, semantically incorrect, or failed business validation.'],
    429: ['RATE_LIMIT_REACHED', 'Too many requests. Blocked due to rate limiting.'],
  };
  const [n, m] = fallback[status] ?? ['INTERNAL_SERVER_ERROR', 'An internal server error has occurred.'];
  return {
    name: name ?? n,
    message: message ?? m,
    debug_id: 'p5debug',
    ...(issue ? { details: [{ issue, description: issue }] } : {}),
  };
}
const missing = (): Answer => new Answer(404, errorBody(404, undefined, undefined, 'INVALID_RESOURCE_ID'));
const unprocessable = (issue: string): Answer => new Answer(422, errorBody(422, undefined, undefined, issue));
const invalid = (issue: string): Answer => new Answer(400, errorBody(400, undefined, undefined, issue));

export class FakePayPal {
  readonly calls: PayPalCall[] = [];
  /** Calls to an address or route the fake does not serve. */
  readonly unexpected: string[] = [];
  readonly plans = new Map<string, Obj>();
  readonly subscriptions = new Map<string, Obj>();
  readonly sales = new Map<string, Obj>();
  readonly refunds = new Map<string, Obj>();
  /** The JSON text each subscription was created with, exactly as the bot posted it (forged ones have none). */
  readonly createTexts = new Map<string, string>();
  /** The plan a revise asked for, until `approveRevision`. */
  readonly revisions = new Map<string, string>();
  /** Every delivery `sign` made, by transmission id. */
  readonly transmissions = new Map<string, Delivery>();
  /** Events not yet delivered, oldest first. */
  readonly queue: PayPalEvent[] = [];
  /** Issued access tokens. */
  readonly tokens = new Set<string>();
  private counter = 0;
  private faults: FaultRule[] = [];
  private holds: HoldRule[] = [];

  constructor(readonly app: { clientId: string; clientSecret: string } = { clientId: APP_CLIENT_ID, clientSecret: APP_CLIENT_SECRET }) {}

  /** Installs the fake as the global fetch. */
  install(): this {
    vi.stubGlobal('fetch', vi.fn((url: unknown, init?: RequestInit) => this.fetch(String(url), init)));
    return this;
  }

  private next(width = 10): string {
    this.counter += 1;
    return String(this.counter).padStart(width, '0');
  }

  // ---------------------------------------------------------------------------- catalogue

  addPlan(spec: PlanSpec): Obj {
    const cycles: Obj[] = [];
    if (spec.trial) {
      cycles.push({
        frequency: { interval_unit: spec.trial.unit, interval_count: spec.trial.count ?? 1 },
        tenure_type: 'TRIAL',
        sequence: 1,
        total_cycles: spec.trial.cycles,
        ...(spec.trial.price ? { pricing_scheme: { fixed_price: { value: spec.trial.price, currency_code: spec.currency ?? 'USD' } } } : {}),
      });
    }
    cycles.push({
      frequency: { interval_unit: spec.unit, interval_count: spec.count ?? 1 },
      tenure_type: 'REGULAR',
      sequence: cycles.length + 1,
      total_cycles: spec.totalCycles ?? 0,
      pricing_scheme: { fixed_price: { value: spec.price, currency_code: spec.currency ?? 'USD' } },
    });
    const plan = {
      id: spec.id,
      product_id: spec.productId,
      name: spec.name,
      status: spec.status ?? 'ACTIVE',
      usage_type: 'LICENSED',
      billing_cycles: cycles,
      payment_preferences: {
        auto_bill_outstanding: true,
        ...(spec.setupFee !== undefined ? { setup_fee: { value: spec.setupFee, currency_code: spec.currency ?? 'USD' } } : {}),
        setup_fee_failure_action: 'CONTINUE',
        payment_failure_threshold: 3,
      },
      quantity_supported: spec.quantitySupported ?? false,
      create_time: iso(Date.now()),
    };
    this.plans.set(spec.id, plan);
    return plan;
  }

  setPlanStatus(planId: string, status: 'ACTIVE' | 'INACTIVE' | 'CREATED'): void {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`p5PayPal.setPlanStatus: no plan ${planId}`);
    plan.status = status;
  }

  // ---------------------------------------------------------------------------- faults and holds

  /** The next `times` calls of `method` whose path (with its query) matches answer with the fault. */
  fail(method: string, match: RegExp, fault: PayPalFault, times = 1): void {
    this.faults.push({ method, match, fault, times });
  }

  /** Drops every fault not yet used. */
  clearFaults(): void {
    this.faults = [];
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
    const base = [SANDBOX_BASE, LIVE_BASE].find(b => url.startsWith(`${b}/`));
    if (!base) {
      this.unexpected.push(`${method} ${url}`);
      throw new TypeError(`p5PayPal: no route outside PayPal's API: ${method} ${url}`);
    }
    const path = url.slice(base.length);
    const fault = this.take(this.faults, method, path)?.fault ?? null;
    if (fault && 'drop' in fault && fault.drop === 'before') throw new TypeError('fetch failed');
    const headers = headersOf(init);
    const text = typeof init?.body === 'string' ? init.body : init?.body == null ? null : String(init.body);
    let json: any = null;
    if (text !== null && headers['content-type']?.includes('json')) {
      try { json = JSON.parse(text); } catch { json = undefined; }
    }
    this.calls.push({ method, base, path, text, json, headers, at: Date.now() });
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
    const isToken = path.split('?')[0] === '/v1/oauth2/token';
    if (fault && 'status' in fault) {
      if (fault.status === 204) return new Response(null, { status: 204 });
      const body = isToken
        ? { error: fault.name ?? (fault.status === 401 ? 'invalid_client' : 'server_error'), error_description: fault.message ?? `PayPal answered ${fault.status}` }
        : errorBody(fault.status, fault.name, fault.message, fault.issue);
      return new Response(JSON.stringify(body), { status: fault.status, headers: { 'content-type': 'application/json' } });
    }
    let answer: Answer;
    try {
      answer = isToken ? this.token(method, text, headers) : this.authorised(headers) ?? this.route(method, path, text, json);
    } catch (error) {
      this.unexpected.push(`${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    if (fault && 'drop' in fault && fault.drop === 'after') throw new TypeError('fetch failed');
    if (answer.body === null) return new Response(null, { status: answer.status });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  }

  private token(method: string, text: string | null, headers: Record<string, string>): Answer {
    if (method !== 'POST') throw new Error('the token route takes POST only');
    const basic = `Basic ${Buffer.from(`${this.app.clientId}:${this.app.clientSecret}`).toString('base64')}`;
    if (headers.authorization !== basic) return new Answer(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
    if (new URLSearchParams(text ?? '').get('grant_type') !== 'client_credentials') return new Answer(400, { error: 'unsupported_grant_type', error_description: 'Grant Type is NULL' });
    const token = `A21AAp5${this.next()}`;
    this.tokens.add(token);
    return new Answer(200, { scope: 'https://uri.paypal.com/services/subscriptions', access_token: token, token_type: 'Bearer', app_id: 'APP-P5', expires_in: 32400, nonce: `p5nonce${this.counter}` });
  }

  private authorised(headers: Record<string, string>): Answer | null {
    const auth = headers.authorization ?? '';
    if (auth.startsWith('Bearer ') && this.tokens.has(auth.slice('Bearer '.length))) return null;
    return new Answer(401, errorBody(401));
  }

  private route(method: string, path: string, text: string | null, json: any): Answer {
    const [pathname, search = ''] = path.split('?');
    const query = new URLSearchParams(search);
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const ok = (body: Obj | null, status = 200): Answer => new Answer(status, body);

    if (method === 'POST' && pathname === '/v1/notifications/verify-webhook-signature') return this.verify(text);
    if (parts[0] === 'v1' && parts[1] === 'billing' && parts[2] === 'plans') {
      if (method === 'GET' && parts.length === 4) {
        const plan = this.plans.get(parts[3]);
        return plan ? ok(clone(plan)) : missing();
      }
      if (method === 'GET' && parts.length === 3) {
        const product = query.get('product_id');
        const plans = [...this.plans.values()].filter(p => p.product_id === product)
          .map(p => ({ id: p.id, product_id: p.product_id, name: p.name, status: p.status, usage_type: p.usage_type, create_time: p.create_time }));
        return ok({ plans, total_items: plans.length, total_pages: 1, links: [] });
      }
    }
    if (parts[0] === 'v1' && parts[1] === 'billing' && parts[2] === 'subscriptions') {
      const id = parts[3];
      const action = parts[4];
      if (method === 'POST' && !id) return this.create(text, json);
      if (method === 'GET' && id && !action) {
        const sub = this.subscriptions.get(id);
        return sub ? ok(this.subscriptionOut(sub)) : missing();
      }
      if (method === 'GET' && id && action === 'transactions') return this.transactions(id, query);
      if (method === 'POST' && id && ['cancel', 'suspend', 'activate', 'revise'].includes(action)) return this.premiumCall(id, action, json);
    }
    if (method === 'GET' && parts[0] === 'v1' && parts[1] === 'payments' && parts[2] === 'sale' && parts[3] && parts.length === 4) {
      const sale = this.sales.get(parts[3]);
      return sale ? ok(this.saleOut(sale)) : missing();
    }
    throw new Error('no such route in the fake');
  }

  // ---------------------------------------------------------------------------- objects out

  private links(id: string): Obj[] {
    return [{ href: `${SANDBOX_BASE}/v1/billing/subscriptions/${id}`, rel: 'self', method: 'GET' }];
  }

  /** A subscription as the API answers it, under the row's settings. */
  subscriptionOut(sub: Obj): Obj {
    const body = out(sub);
    const s: FakeSettings = sub._s ?? {};
    if (sub._override) body.plan_overridden = ['flag', 'both'].includes(this.overrideShownBy(sub));
    const info = body.billing_info;
    if (info) {
      if (s.omitCycleExecutions) delete info.cycle_executions;
      else if (Array.isArray(info.cycle_executions)) {
        info.cycle_executions = info.cycle_executions.map((c: Obj) => (c.tenure_type === 'REGULAR' ? this.regularExecution(sub, c) : c));
      }
      const latest = this.latestSale(sub.id);
      if (s.pendingSale && !s.lpWhilePending && latest && info.last_payment) {
        const earlier = this.salesOf(sub.id).filter(x => x.id !== latest.id);
        const before = earlier[earlier.length - 1];
        if (before) info.last_payment = { amount: { currency_code: before.amount.currency, value: before.amount.total }, time: before.create_time };
        else delete info.last_payment;
      }
      if (s.omitLastPayment && (s.omitLastPaymentOn === undefined || s.omitLastPaymentOn === sub.status)) delete info.last_payment;
    }
    return { ...body, links: this.links(sub.id) };
  }

  /** How a read shows the subscription's override. */
  private overrideShownBy(sub: Obj): 'flag' | 'cycles' | 'both' | 'none' {
    const s: FakeSettings = sub._s ?? {};
    if (!sub._override || s.ignoreOverride) return 'none';
    if (s.billsDespiteOverride) return 'both';
    return s.showOverrideBy ?? 'both';
  }

  private regularExecution(sub: Obj, stored: Obj): Obj {
    const s: FakeSettings = sub._s ?? {};
    const shown = this.overrideShownBy(sub);
    const own = Number(this.regular(this.planOf(sub)).total_cycles) || 0;
    const overridden = sub._override?.[String(stored.sequence)];
    const total = (shown === 'cycles' || shown === 'both') && overridden !== undefined ? overridden : own;
    const completed = s.staleCycles !== undefined && s.staleCycles !== false ? sub._stale : sub._completed;
    return { ...stored, cycles_completed: completed, cycles_remaining: total > 0 ? Math.max(0, total - completed) : 0, total_cycles: total };
  }

  /** The REGULAR cycles PayPal bills for the subscription; 0 is no end. */
  private billedTotal(sub: Obj): number {
    const s: FakeSettings = sub._s ?? {};
    const regular = this.regular(this.planOf(sub));
    const own = Number(regular.total_cycles) || 0;
    if (!sub._override || s.ignoreOverride) return own;
    if (s.billsDespiteOverride) return 0;
    return sub._override[String(regular.sequence)] ?? own;
  }

  /** Every cycle PayPal bills for the subscription is paid. */
  allPaid(id: string): boolean {
    const sub = this.sub(id, 'allPaid');
    const total = this.billedTotal(sub);
    return total > 0 && sub._completed >= total;
  }

  /** Sets the row's settings for a subscription (sheet P5P, Y7); `listLag` and `staleCycles` take their snapshot now. */
  configure(id: string, settings: FakeSettings): void {
    const sub = this.sub(id, 'configure');
    if (settings.listLag && !sub._s.listLag) sub._lag = new Map(this.salesOf(id).map(x => [x.id, x.state]));
    if (settings.staleCycles !== undefined && settings.staleCycles !== false) sub._stale = typeof settings.staleCycles === 'number' ? settings.staleCycles : sub._completed;
    Object.assign(sub._s, settings);
  }

  /** Clears settings of a subscription: what they hid is shown at the next read. */
  release(id: string, ...keys: Array<keyof FakeSettings>): void {
    const sub = this.sub(id, 'release');
    for (const key of keys) delete sub._s[key];
    if (!sub._s.listLag) delete sub._lag;
  }

  /** A sale as the Payments v1 read and the sale events carry it. */
  saleOut(sale: Obj): Obj {
    const body = out(sale);
    if (!sale._withAgreement) delete body.billing_agreement_id;
    return body;
  }

  // ---------------------------------------------------------------------------- the calls that write

  private create(text: string | null, json: any): Answer {
    if (!json || typeof json !== 'object') return invalid('MALFORMED_REQUEST_JSON');
    const plan = typeof json.plan_id === 'string' ? this.plans.get(json.plan_id) : undefined;
    if (!plan) return missing();
    if (plan.status !== 'ACTIVE') return unprocessable('PLAN_STATUS_INVALID');
    if (typeof json.custom_id === 'string' && json.custom_id.length > 127) return invalid('INVALID_STRING_MAX_LENGTH');
    if (json.quantity !== undefined && !plan.quantity_supported) return unprocessable('QUANTITY_NOT_SUPPORTED');
    let override: Obj | null = null;
    if (json.plan !== undefined) {
      const items: Obj[] = Array.isArray(json.plan?.billing_cycles) ? json.plan.billing_cycles : [];
      for (const item of items) {
        if (!plan.billing_cycles.some((c: Obj) => c.sequence === item?.sequence)) return unprocessable('INVALID_BILLING_CYCLE_SEQUENCE');
        if (item.pricing_scheme !== undefined && !item.pricing_scheme?.fixed_price) return unprocessable('INVALID_PRICING_SCHEME');
      }
      override = Object.fromEntries(items.filter(i => i.total_cycles !== undefined).map(i => [String(i.sequence), Number(i.total_cycles)]));
    }
    const sub = this.newSubscription(plan.id, json.custom_id, json.quantity === undefined ? undefined : String(json.quantity));
    if (override) {
      sub._override = override;
      sub.plan_overridden = true;
    }
    this.createTexts.set(sub.id, text ?? '');
    const approve = { href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${sub.id.slice(2)}`, rel: 'approve', method: 'GET' };
    return new Answer(201, { ...this.subscriptionOut(sub), links: [approve, { href: `${SANDBOX_BASE}/v1/billing/subscriptions/${sub.id}`, rel: 'edit', method: 'PATCH' }, ...this.links(sub.id)] });
  }

  private newSubscription(planId: string, customId: unknown, quantity: string | undefined): Obj {
    const id = `I-P5${this.next()}`;
    const now = iso(Date.now());
    const sub: Obj = {
      id,
      plan_id: planId,
      status: 'APPROVAL_PENDING',
      status_update_time: now,
      quantity: quantity ?? '1',
      ...(typeof customId === 'string' ? { custom_id: customId } : {}),
      start_time: now,
      create_time: now,
      plan_overridden: false,
      _cycle: 0,
      _completed: 0,
      _unpaid: [] as number[],
      _s: {} as FakeSettings,
    };
    this.subscriptions.set(id, sub);
    this.emit('BILLING.SUBSCRIPTION.CREATED', sub);
    return sub;
  }

  private premiumCall(id: string, action: string, json: any): Answer {
    const sub = this.subscriptions.get(id);
    if (!sub) return missing();
    if (action === 'cancel') {
      if (!['ACTIVE', 'SUSPENDED'].includes(sub.status)) return unprocessable('SUBSCRIPTION_STATUS_INVALID');
      this.toStatus(sub, 'CANCELLED', json?.reason);
      delete sub.billing_info?.next_billing_time;
      this.emit('BILLING.SUBSCRIPTION.CANCELLED', sub);
      return new Answer(204, null);
    }
    if (action === 'suspend') {
      if (sub.status !== 'ACTIVE') return unprocessable('SUBSCRIPTION_STATUS_INVALID');
      this.toStatus(sub, 'SUSPENDED', json?.reason);
      this.emit('BILLING.SUBSCRIPTION.SUSPENDED', sub);
      return new Answer(204, null);
    }
    if (action === 'activate') {
      if (sub.status !== 'SUSPENDED') return unprocessable('SUBSCRIPTION_STATUS_INVALID');
      this.toStatus(sub, 'ACTIVE', json?.reason);
      this.emit('BILLING.SUBSCRIPTION.ACTIVATED', sub);
      return new Answer(204, null);
    }
    const planId = json?.plan_id;
    if (typeof planId !== 'string' || !this.plans.has(planId)) return missing();
    if (!['ACTIVE', 'SUSPENDED'].includes(sub.status)) return unprocessable('SUBSCRIPTION_STATUS_INVALID');
    this.revisions.set(id, planId);
    return new Answer(200, {
      plan_id: planId,
      effective_time: iso(Date.now()),
      plan_overridden: false,
      links: [{ href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-R${id.slice(2)}`, rel: 'approve', method: 'GET' }],
    });
  }

  private transactions(id: string, query: URLSearchParams): Answer {
    const sub = this.subscriptions.get(id);
    if (!sub) return missing();
    const start = Date.parse(query.get('start_time') ?? '');
    const end = Date.parse(query.get('end_time') ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end)) return invalid('INVALID_PARAMETER_SYNTAX');
    const settings: FakeSettings = sub._s ?? {};
    const lag: Map<string, string> | undefined = settings.listLag ? sub._lag : undefined;
    const latest = this.latestSale(id);
    const word = (state: string): string => ({ completed: 'COMPLETED', partially_refunded: 'PARTIALLY_REFUNDED', refunded: 'REFUNDED' } as Record<string, string>)[state];
    const status = (s: Obj): string => (settings.pendingSale && s.id === latest?.id ? 'PENDING' : word(lag ? lag.get(s.id)! : s.state));
    const transactions = [...this.sales.values()]
      .filter(s => s.billing_agreement_id === id && Date.parse(s.create_time) >= start && Date.parse(s.create_time) <= end)
      .filter(s => !lag || lag.has(s.id))
      .map(s => ({
        id: settings.listOtherIds ? `L${s.id}` : s.id,
        status: status(s),
        amount_with_breakdown: {
          gross_amount: { currency_code: s.amount.currency, value: s.amount.total },
          fee_amount: { currency_code: s.amount.currency, value: '0.30' },
          net_amount: { currency_code: s.amount.currency, value: money(cents(s.amount.total) - 30) },
        },
        payer_name: { given_name: 'Test', surname: 'Buyer' },
        payer_email: 'buyer@example.invalid',
        time: settings.lpSkew ? iso(Date.parse(s.create_time) - settings.lpSkew * 1000) : s.create_time,
      }));
    if (transactions.length === 0 && settings.emptyListIs404) return missing();
    return new Answer(200, { transactions, total_items: transactions.length, total_pages: 1, links: [] });
  }

  private verify(text: string | null): Answer {
    if (text === null) return invalid('MALFORMED_REQUEST_JSON');
    let posted: Obj;
    try { posted = JSON.parse(text); } catch { return invalid('MALFORMED_REQUEST_JSON'); }
    const marker = '"webhook_event":';
    const from = text.indexOf(marker);
    const to = text.lastIndexOf('}');
    const event = from < 0 || to < from ? null : text.slice(from + marker.length, to);
    const sent = this.transmissions.get(String(posted.transmission_id));
    const matches = !!sent && event === sent.body
      && posted.webhook_id === sent.webhookId
      && posted.auth_algo === sent.headers['paypal-auth-algo']
      && posted.cert_url === sent.headers['paypal-cert-url']
      && posted.transmission_sig === sent.headers['paypal-transmission-sig']
      && posted.transmission_time === sent.headers['paypal-transmission-time'];
    return new Answer(200, { verification_status: matches ? 'SUCCESS' : 'FAILURE' });
  }

  // ---------------------------------------------------------------------------- events and deliveries

  private emit(type: string, object: Obj): PayPalEvent {
    const kind = type.startsWith('BILLING.SUBSCRIPTION.') ? 'subscription' : type === 'PAYMENT.SALE.REFUNDED' ? 'refund' : 'sale';
    const resource = kind === 'subscription' ? this.subscriptionOut(object) : kind === 'sale' ? this.saleOut(object) : this.refundOut(object);
    const event: PayPalEvent = {
      id: `WH-P5${this.next()}-${this.next(16)}`,
      event_version: '1.0',
      create_time: iso(Date.now()),
      resource_type: kind,
      resource_version: kind === 'subscription' ? '2.0' : '1.0',
      event_type: type,
      summary: `${type} ${object.id}`,
      resource,
      links: [{ href: `${SANDBOX_BASE}/v1/notifications/webhooks-events/WH-P5`, rel: 'self', method: 'GET' }],
    };
    this.queue.push(event);
    return event;
  }

  /** Takes the event at `index` of the queue (the oldest by default) out of it. */
  dequeue(index = 0): PayPalEvent | null {
    if (this.queue.length === 0) return null;
    return this.queue.splice(Math.max(0, Math.min(index, this.queue.length - 1)), 1)[0];
  }

  /**
   * Signs a delivery of `event` to the webhook `webhookId`: its body is `JSON.stringify(event)`, or `text` when the row
   * gives the exact bytes (an escape, a number written `1.0`); the headers are the five PayPal sends and its
   * content-type. The fake records it for the verify route.
   */
  sign(event: PayPalEvent | null, webhookId: string, text?: string): Delivery {
    const body = text ?? JSON.stringify(event);
    const n = this.next(12);
    const transmissionId = `${n.slice(0, 8)}-p5aa-11ef-8000-${n}`;
    const headers = {
      'content-type': 'application/json',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': `${SANDBOX_BASE}/v1/notifications/certs/CERT-360caa42-fca2a594-p5`,
      'paypal-transmission-id': transmissionId,
      'paypal-transmission-sig': crypto.createHash('sha256').update(`${transmissionId}|${body}`).digest('base64'),
      'paypal-transmission-time': iso(Date.now()),
    };
    const delivery = { body, headers, webhookId, transmissionId };
    this.transmissions.set(transmissionId, clone(delivery));
    return delivery;
  }

  // ---------------------------------------------------------------------------- PayPal-side actions

  private sub(id: string, action: string): Obj {
    const sub = this.subscriptions.get(id);
    if (!sub) throw new Error(`p5PayPal.${action}: no subscription ${id}`);
    return sub;
  }

  private toStatus(sub: Obj, status: string, note?: string): void {
    sub.status = status;
    sub.status_update_time = iso(Date.now());
    if (note !== undefined) sub.status_change_note = note;
  }

  planOf(sub: Obj): Obj {
    const plan = this.plans.get(sub.plan_id);
    if (!plan) throw new Error(`p5PayPal: subscription ${sub.id} names no plan the fake holds`);
    return plan;
  }

  private regular(plan: Obj): Obj {
    return plan.billing_cycles.find((c: Obj) => c.tenure_type === 'REGULAR');
  }

  /** The price of one regular cycle for the subscription's quantity, in cents. */
  private priceOf(sub: Obj): number {
    return cents(this.regular(this.planOf(sub)).pricing_scheme.fixed_price.value) * Math.max(1, Number(sub.quantity ?? '1'));
  }

  /** The due date of the subscription's regular cycle `n` (0 is the first regular payment). */
  dueOf(sub: Obj, n: number): number {
    const cycle = this.regular(this.planOf(sub));
    return addCycles(sub._regularStart, cycle.frequency.interval_unit, cycle.frequency.interval_count, n);
  }

  private billing(sub: Obj): Obj {
    const currency = this.regular(this.planOf(sub)).pricing_scheme.fixed_price.currency_code;
    sub.billing_info ??= { outstanding_balance: { currency_code: currency, value: '0.00' }, cycle_executions: [], failed_payments_count: 0 };
    return sub.billing_info;
  }

  private setNext(sub: Obj): void {
    this.billing(sub).next_billing_time = iso(this.dueOf(sub, sub._cycle));
  }

  private sale(sub: Obj, amount: number, at: number): Obj {
    const currency = this.regular(this.planOf(sub)).pricing_scheme.fixed_price.currency_code;
    const sale = {
      id: `5P5${this.next(14)}`,
      state: 'completed',
      amount: { total: money(amount), currency, details: { subtotal: money(amount) } },
      payment_mode: 'INSTANT_TRANSFER',
      protection_eligibility: 'ELIGIBLE',
      transaction_fee: { value: '0.30', currency },
      billing_agreement_id: sub.id,
      create_time: iso(at),
      update_time: iso(at),
      links: [],
      _withAgreement: true,
      _refunded: 0,
    };
    this.sales.set(sale.id, sale);
    const info = this.billing(sub);
    info.last_payment = { amount: { currency_code: currency, value: money(amount) }, time: iso(at) };
    this.emit('PAYMENT.SALE.COMPLETED', sale);
    return sale;
  }

  /** The balance PayPal shows: the price of every regular cycle due and unpaid. */
  private setBalance(sub: Obj): void {
    const info = this.billing(sub);
    info.outstanding_balance = { currency_code: info.outstanding_balance.currency_code, value: money(this.priceOf(sub) * sub._unpaid.length) };
  }

  /**
   * The buyer approves: ACTIVE from `at` (now by default), then `BILLING.SUBSCRIPTION.ACTIVATED`. A plan whose first
   * cycles are a free trial bills nothing until the trial ends. Otherwise the first sale: completed at once (`firstSale`
   * 'now', the default, queued after ACTIVATED), left for `completeFirstSale` ('later': ACTIVE with no `last_payment`),
   * or failed ('fail': no `last_payment`, one failed attempt).
   */
  approve(id: string, opts: { at?: number; firstSale?: 'now' | 'later' | 'fail' } = {}): Obj {
    const sub = this.sub(id, 'approve');
    if (sub.status !== 'APPROVAL_PENDING' && sub.status !== 'APPROVED') throw new Error(`p5PayPal.approve: ${id} is ${sub.status}`);
    const at = opts.at ?? Date.now();
    const plan = this.planOf(sub);
    const trial = plan.billing_cycles.find((c: Obj) => c.tenure_type === 'TRIAL');
    sub.start_time = iso(at);
    sub._regularStart = trial ? addCycles(at, trial.frequency.interval_unit, trial.frequency.interval_count, trial.total_cycles) : at;
    sub._cycle = 0;
    this.toStatus(sub, 'ACTIVE');
    const info = this.billing(sub);
    info.cycle_executions = plan.billing_cycles.map((c: Obj) => ({ tenure_type: c.tenure_type, sequence: c.sequence, cycles_completed: 0, cycles_remaining: c.total_cycles, total_cycles: c.total_cycles }));
    this.setNext(sub);
    const first = opts.firstSale ?? 'now';
    if (trial) {
      this.emit('BILLING.SUBSCRIPTION.ACTIVATED', sub);
      return sub;
    }
    if (first === 'fail') {
      this.failed(sub, at, { count: 1 });
      this.emit('BILLING.SUBSCRIPTION.ACTIVATED', sub);
      this.emit('BILLING.SUBSCRIPTION.PAYMENT.FAILED', sub);
      return sub;
    }
    if (first === 'later') {
      this.emit('BILLING.SUBSCRIPTION.ACTIVATED', sub);
      return sub;
    }
    sub._cycle = 1;
    this.setNext(sub);
    this.emit('BILLING.SUBSCRIPTION.ACTIVATED', sub);
    this.paidCycles(sub, this.priceOf(sub), at, 1);
    return sub;
  }

  /** The first sale of a subscription approved with `firstSale: 'later'` completes. */
  completeFirstSale(id: string, opts: { at?: number } = {}): Obj {
    const sub = this.sub(id, 'completeFirstSale');
    if (sub.status !== 'ACTIVE' || sub._cycle !== 0) throw new Error(`p5PayPal.completeFirstSale: ${id} has no first sale waiting`);
    sub._cycle = 1;
    this.setNext(sub);
    this.paidCycles(sub, this.priceOf(sub), opts.at ?? Date.now(), 1);
    return sub;
  }

  /** A renewal is billed and paid: the sale of the cycle due at `next_billing_time` (or at `at`), then the next due date. */
  renew(id: string, opts: { at?: number } = {}): Obj {
    const sub = this.sub(id, 'renew');
    this.refuseBilling(sub, 'renew');
    if (sub.status !== 'ACTIVE') throw new Error(`p5PayPal.renew: ${id} is ${sub.status}`);
    const at = opts.at ?? this.dueOf(sub, sub._cycle);
    sub._cycle += 1;
    this.setNext(sub);
    this.paidCycles(sub, this.priceOf(sub), at, 1);
    return sub;
  }

  private failed(sub: Obj, at: number, opts: { count?: number; reason?: string; moveNext?: boolean }): void {
    const info = this.billing(sub);
    const due = this.dueOf(sub, sub._cycle);
    if (!sub._unpaid.includes(due)) sub._unpaid.push(due);
    info.failed_payments_count = opts.count ?? (info.failed_payments_count ?? 0) + 1;
    info.last_failed_payment = {
      amount: { currency_code: info.outstanding_balance.currency_code, value: money(this.priceOf(sub)) },
      time: iso(at),
      reason_code: opts.reason ?? 'PAYMENT_DENIED',
      next_payment_retry_time: iso(at + 5 * DAY_MS),
    };
    if (opts.moveNext) {
      sub._cycle += 1;
      this.setNext(sub);
    }
    this.setBalance(sub);
  }

  /**
   * A renewal attempt fails at the due date (or `at`): `last_failed_payment`, `failed_payments_count` as the row sets
   * it (one more by default), the balance, and `next_billing_time` kept or moved a cycle on (`moveNext`). Queues
   * `BILLING.SUBSCRIPTION.PAYMENT.FAILED`.
   */
  failPayment(id: string, opts: { at?: number; count?: number; reason?: string; moveNext?: boolean } = {}): Obj {
    const sub = this.sub(id, 'failPayment');
    this.refuseBilling(sub, 'failPayment');
    if (sub.status !== 'ACTIVE') throw new Error(`p5PayPal.failPayment: ${id} is ${sub.status}`);
    this.failed(sub, opts.at ?? this.dueOf(sub, sub._cycle), opts);
    this.emit('BILLING.SUBSCRIPTION.PAYMENT.FAILED', sub);
    return sub;
  }

  /**
   * A retry collects the balance at the retry time PayPal gave (or `at`): one sale of every unpaid cycle, the count back
   * to 0, the balance 0, and `next_billing_time` moved past the cycle the failure kept due.
   */
  retrySucceeds(id: string, opts: { at?: number } = {}): Obj {
    const sub = this.sub(id, 'retrySucceeds');
    this.refuseBilling(sub, 'retrySucceeds');
    const info = this.billing(sub);
    if (sub._unpaid.length === 0) throw new Error(`p5PayPal.retrySucceeds: ${id} owes nothing`);
    const at = opts.at ?? Date.parse(info.last_failed_payment.next_payment_retry_time);
    const amount = this.priceOf(sub) * sub._unpaid.length;
    const cycles = sub._unpaid.length;
    if (sub._unpaid.includes(this.dueOf(sub, sub._cycle))) sub._cycle += 1;
    sub._unpaid = [];
    info.failed_payments_count = 0;
    this.setBalance(sub);
    if (sub.status === 'SUSPENDED') this.toStatus(sub, 'ACTIVE');
    this.setNext(sub);
    this.paidCycles(sub, amount, at, cycles);
    return sub;
  }

  /** PayPal bills nothing more on a closed subscription or one whose cycles are all paid. */
  private refuseBilling(sub: Obj, action: string): void {
    if (sub.status === 'CANCELLED' || sub.status === 'EXPIRED') throw new FakeRefusal(`p5PayPal.${action}: PayPal bills nothing on ${sub.id}, which is ${sub.status}`);
    if (this.allPaid(sub.id)) throw new FakeRefusal(`p5PayPal.${action}: PayPal bills nothing more on ${sub.id}, whose cycles are all paid`);
  }

  /** A sale of regular cycles: the REGULAR count moves on, and the last cycle paid follows the subscription's finalCycle. */
  private paidCycles(sub: Obj, amount: number, at: number, cycles: number): Obj {
    const sale = this.sale(sub, amount, at);
    sub._completed += cycles;
    if (this.allPaid(sub.id)) {
      const info = this.billing(sub);
      if (sub._s.keepNextAfterFinal) info.next_billing_time = iso(at);
      else delete info.next_billing_time;
      if ((sub._s.finalCycle ?? 'expire-at-payment') === 'expire-at-payment') {
        this.toStatus(sub, 'EXPIRED');
        this.emit('BILLING.SUBSCRIPTION.EXPIRED', sub);
      }
    }
    return sale;
  }

  /** A checkout never approved expires at PayPal: its start_time kept, no cycle_executions, no last_payment. */
  expireNeverApproved(id: string): Obj {
    const sub = this.sub(id, 'expireNeverApproved');
    if (sub.status !== 'APPROVAL_PENDING') throw new Error(`p5PayPal.expireNeverApproved: ${id} is ${sub.status}`);
    this.toStatus(sub, 'EXPIRED');
    this.emit('BILLING.SUBSCRIPTION.EXPIRED', sub);
    return sub;
  }

  /** The buyer cancels at PayPal: CANCELLED, no `next_billing_time`. */
  buyerCancel(id: string, note = 'Cancelled by the buyer'): Obj {
    const sub = this.sub(id, 'buyerCancel');
    if (!['ACTIVE', 'SUSPENDED', 'APPROVAL_PENDING', 'APPROVED'].includes(sub.status)) throw new Error(`p5PayPal.buyerCancel: ${id} is ${sub.status}`);
    this.toStatus(sub, 'CANCELLED', note);
    delete sub.billing_info?.next_billing_time;
    this.emit('BILLING.SUBSCRIPTION.CANCELLED', sub);
    return sub;
  }

  /** PayPal suspends a subscription after failed payments (the count as it is, or `count`). */
  suspendForFailures(id: string, opts: { count?: number } = {}): Obj {
    const sub = this.sub(id, 'suspendForFailures');
    if (sub.status !== 'ACTIVE') throw new Error(`p5PayPal.suspendForFailures: ${id} is ${sub.status}`);
    if (opts.count !== undefined) this.billing(sub).failed_payments_count = opts.count;
    this.toStatus(sub, 'SUSPENDED', 'Suspended after failed payments');
    this.emit('BILLING.SUBSCRIPTION.SUSPENDED', sub);
    return sub;
  }

  /** The merchant suspends a subscription in PayPal's dashboard, with no failed payment. */
  suspendNoFailure(id: string): Obj {
    const sub = this.sub(id, 'suspendNoFailure');
    if (sub.status !== 'ACTIVE') throw new Error(`p5PayPal.suspendNoFailure: ${id} is ${sub.status}`);
    this.toStatus(sub, 'SUSPENDED', 'Suspended by the merchant');
    this.emit('BILLING.SUBSCRIPTION.SUSPENDED', sub);
    return sub;
  }

  /** A suspended subscription is reactivated in PayPal's dashboard. */
  reactivate(id: string): Obj {
    const sub = this.sub(id, 'reactivate');
    if (sub.status !== 'SUSPENDED') throw new Error(`p5PayPal.reactivate: ${id} is ${sub.status}`);
    this.toStatus(sub, 'ACTIVE', 'Reactivated');
    this.emit('BILLING.SUBSCRIPTION.ACTIVATED', sub);
    return sub;
  }

  /** The subscription expires at PayPal (its cycles ran out, or the payment failure threshold ended it). */
  expire(id: string): Obj {
    const sub = this.sub(id, 'expire');
    if (['CANCELLED', 'EXPIRED'].includes(sub.status)) throw new Error(`p5PayPal.expire: ${id} is ${sub.status}`);
    this.toStatus(sub, 'EXPIRED');
    delete sub.billing_info?.next_billing_time;
    this.emit('BILLING.SUBSCRIPTION.EXPIRED', sub);
    return sub;
  }

  /**
   * A refund of `amount` cents of a sale (the rest of it when omitted). The refund event names its sale (`sale_id`)
   * and carries `billing_agreement_id` only with `withAgreement`.
   */
  refund(saleId: string, amount?: number, opts: { withAgreement?: boolean } = {}): Obj {
    const sale = this.sales.get(saleId);
    if (!sale) throw new Error(`p5PayPal.refund: no sale ${saleId}`);
    const total = cents(sale.amount.total);
    const left = total - sale._refunded;
    const take = Math.min(left, amount ?? left);
    if (take <= 0) throw new Error(`p5PayPal.refund: ${saleId} is refunded in full already`);
    sale._refunded += take;
    sale.state = sale._refunded >= total ? 'refunded' : 'partially_refunded';
    sale.update_time = iso(Date.now());
    const refund = {
      id: `9R5${this.next(14)}`,
      state: 'completed',
      amount: { total: money(take), currency: sale.amount.currency },
      sale_id: sale.id,
      parent_payment: `PAYID-P5${sale.id}`,
      create_time: iso(Date.now()),
      update_time: iso(Date.now()),
      links: [],
      ...(sale.billing_agreement_id ? { billing_agreement_id: sale.billing_agreement_id } : {}),
      _withAgreement: opts.withAgreement === true,
    };
    this.refunds.set(refund.id, refund);
    this.emit('PAYMENT.SALE.REFUNDED', refund);
    return refund;
  }

  private refundOut(refund: Obj): Obj {
    const body = out(refund);
    if (!refund._withAgreement) delete body.billing_agreement_id;
    return body;
  }

  /** The subscription's plan changes at PayPal (a plan change the bot did not make). */
  changePlan(id: string, planId: string): Obj {
    const sub = this.sub(id, 'changePlan');
    if (!this.plans.has(planId)) throw new Error(`p5PayPal.changePlan: no plan ${planId}`);
    sub.plan_id = planId;
    sub.plan_overridden = false;
    this.emit('BILLING.SUBSCRIPTION.UPDATED', sub);
    return sub;
  }

  /** The buyer approves the plan a revise asked for. */
  approveRevision(id: string): Obj {
    const planId = this.revisions.get(id);
    if (!planId) throw new Error(`p5PayPal.approveRevision: ${id} has no revision waiting`);
    this.revisions.delete(id);
    return this.changePlan(id, planId);
  }

  /**
   * A subscription made with no call from the bot, its custom_id written by the row (a made-up `sig`, or fields changed
   * from a real one), approved at once unless `approved` is false.
   */
  forge(planId: string, customId: string, opts: { quantity?: string; approved?: boolean } = {}): Obj {
    if (!this.plans.has(planId)) throw new Error(`p5PayPal.forge: no plan ${planId}`);
    const sub = this.newSubscription(planId, customId, opts.quantity);
    if (opts.approved !== false) this.approve(sub.id);
    return sub;
  }

  /** The object is gone at PayPal: a later read of it answers 404 RESOURCE_NOT_FOUND. */
  deleteObject(kind: 'subscription' | 'sale' | 'plan', id: string): void {
    const maps: Record<string, Map<string, Obj>> = { subscription: this.subscriptions, sale: this.sales, plan: this.plans };
    if (!maps[kind].delete(id)) throw new Error(`p5PayPal.deleteObject: no ${kind} ${id}`);
  }

  // ---------------------------------------------------------------------------- reading the fake

  /** The sales of a subscription, oldest first. */
  salesOf(id: string): Obj[] {
    return [...this.sales.values()].filter(s => s.billing_agreement_id === id).sort((a, b) => Date.parse(a.create_time) - Date.parse(b.create_time));
  }

  /** The latest sale of a subscription (by time), or null. */
  latestSale(id: string): Obj | null {
    const all = this.salesOf(id);
    return all.length ? all[all.length - 1] : null;
  }

  /** The transactions the list call answers for the subscription now, under its settings (every time); null for a 404. */
  listed(id: string): Obj[] | null {
    const answer = this.transactions(id, new URLSearchParams({ start_time: '1970-01-01T00:00:00Z', end_time: '9999-01-01T00:00:00Z' }));
    return answer.status === 200 ? answer.body!.transactions : null;
  }

  /** The calls of one method whose path (without the query) matches. */
  callsOf(method: string, match: RegExp): PayPalCall[] {
    return this.calls.filter(c => c.method === method && match.test(c.path.split('?')[0]));
  }
}
