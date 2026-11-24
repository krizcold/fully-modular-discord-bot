import crypto from 'crypto';
import { vi } from 'vitest';

// The fake of Patreon for P7 (sheet P7, section 10). Installed as the global fetch, it answers only Patreon's token
// exchange (POST /api/oauth2/token, codes it issued at `approve`, each used once) and these GET routes of
// https://www.patreon.com/api/oauth2/v2: /identity (the patron's token; the memberships of the OAuth client's own
// creator only, C-a), /campaigns (the creator token's campaigns), /campaigns/<id>/members (page[count], page[cursor],
// meta.pagination.cursors.next, only the includes and fields asked for) and /members/<id>. Any other address, route or
// method is recorded in `unexpected` and answered with a thrown error; a row asserts `unexpected` is empty. Each call
// is checked for `Authorization: Bearer <token>` against the token's owner, recorded with its time, and answered 429
// with `retry_after_seconds` past `perMinute` calls in a minute for one token. Abort signals are honoured.
//
// Patreon-side actions change a member and queue the deliveries Patreon would send to each webhook whose triggers name
// them (the member resource as it is after the action, signed with the webhook's secret: the hex HMAC-MD5 of the body).
// `deliver` posts a queued delivery through the poster the world sets (the app's route). Reads lag `staleReads` seconds
// behind every change (R7). The unconfirmed behaviours R1 to R22 are settings, each defaulting to its worst case.

export const PATREON_WWW = 'https://www.patreon.com';
export const PATREON_API = `${PATREON_WWW}/api/oauth2/v2`;
export const PATREON_TOKEN_URL = `${PATREON_WWW}/api/oauth2/token`;
export const PATREON_AUTHORIZE_URL = `${PATREON_WWW}/oauth2/authorize`;

/** The OAuth client the bot is configured with; it belongs to the creator of CAMPAIGN_ID. */
export const CLIENT_ID = 'p7-client-id-0000000000000000000000000001';
export const CLIENT_SECRET = 'p7-client-secret-000000000000000000000001';
export const CAMPAIGN_ID = '8100001';
export const CREATOR_ID = '7100001';
export const CREATOR_TOKEN = 'p7-creator-access-token-of-the-first-creator';
/** Another creator, its campaign and its token (`rotateCreator`, R8). */
export const OTHER_CAMPAIGN_ID = '8100002';
export const OTHER_CREATOR_ID = '7100002';
export const OTHER_CREATOR_TOKEN = 'p7-creator-access-token-of-the-second-creator';
export const WEBHOOK_SECRET = 'p7-webhook-secret-0000000000000000000000000000000000000000000001';

/** The campaign's tiers: A and A2 at one price, B higher, S for servers, one no offering sells, and a free one (R16). */
export const PTIER = {
  A: '9100001',
  A2: '9100002',
  B: '9100003',
  S: '9100004',
  UNWIRED: '9100009',
  FREE: '9100000',
} as const;
export type PTierName = keyof typeof PTIER;
export const TIER_AMOUNT: Record<string, number> = {
  [PTIER.A]: 500,
  [PTIER.A2]: 500,
  [PTIER.B]: 1000,
  [PTIER.S]: 1500,
  [PTIER.UNWIRED]: 300,
  [PTIER.FREE]: 0,
};
export const TIER_TITLE: Record<string, string> = {
  [PTIER.A]: 'Patreon A',
  [PTIER.A2]: 'Patreon A2',
  [PTIER.B]: 'Patreon B',
  [PTIER.S]: 'Patreon S',
  [PTIER.UNWIRED]: 'Patreon unwired',
  [PTIER.FREE]: 'Free members',
};

/** Patreon users of the rows (each is the Patreon account of the Discord user at the same index in p7World's USERS). */
export const PATREON_USERS = ['72000001', '72000002', '72000003'] as const;

/** Every trigger of the members resource (C-f). */
export const MEMBER_TRIGGERS = ['members:create', 'members:update', 'members:delete', 'members:pledge:create', 'members:pledge:update', 'members:pledge:delete'] as const;
export type Trigger = typeof MEMBER_TRIGGERS[number] | 'posts:publish';

/** The values PledgeEvent's `payment_status` takes (C-e, R18). */
export const CHARGE_STATUSES = ['Paid', 'Declined', 'Deleted', 'Pending', 'Refunded', 'Fraud', 'Refunded by Patreon', 'Other', 'Partially Refunded', 'Free Trial', 'Refund Pending', 'Refund Declined'] as const;

/** The fields of THE FIELD RULE's table a setting can show null or leave out (R18); `user.id` and `memberships` are /identity's. */
export type FieldName =
  | 'currently_entitled_tiers' | 'amount_cents' | 'is_free_trial' | 'campaign_lifetime_support_cents' | 'last_charge_status'
  | 'is_gifted' | 'last_charge_date' | 'patron_status' | 'user' | 'campaign' | 'user.id' | 'memberships';

type Obj = Record<string, any>;

/** The unconfirmed Patreon behaviours (sheet P7, section 9). */
export interface PatreonSettings {
  /** R1: whether a delivery answered with a non-2xx status is sent again. */
  retryNon2xx: boolean;
  /** R2: how deliveries sent again arrive: one request each, or several members in one body (`data` an array). */
  batch: 'separate' | 'array';
  /** R3: `deliverAll` sends the newest delivery first. */
  reorder: boolean;
  /** R4: a cancel drops the entitlement at once, or at the period's end. */
  cancelEnds: 'now' | 'periodEnd';
  /** R4: a declined charge keeps the entitlement. */
  declinedKeeps: boolean;
  /** R4: a refund (or one by Patreon, or fraud) drops the entitlement too. */
  refundDrops: boolean;
  /** R4: a gift's tier shows in `currently_entitled_tiers`. */
  giftedEntitled: boolean;
  /** R5: an entitlement lapsing at the period's end sends members:update. */
  lapseEvent: boolean;
  /** R6: the list's order, and whether a member is skipped or shown twice when the list changes between pages. */
  pageOrder: 'created' | 'reverse' | 'shuffled';
  skipOnChange: boolean;
  dupOnChange: boolean;
  /** R7: how many seconds a read (a list page or a member read) lags behind the changes. */
  staleReads: number;
  /** R8: what this campaign's routes answer a token of another creator; members Patreon answers 404 for while live. */
  foreignToken: '401' | '403' | '404' | '200-empty';
  notFoundLive: Set<string>;
  /** R9: seconds after the fake starts when the creator token stops being accepted; null for never. */
  creatorTtl: number | null;
  /** R11: whose member shows `user` as null: nobody, the first member made, or every member. */
  maskUser: 'none' | 'one' | 'all';
  /** R12: a second pledge of one member adds a tier to `currently_entitled_tiers` (else it replaces the tier). */
  multiTier: boolean;
  /** R13: whether `is_free_trial` turns false at the first charge or stays true. */
  trialFlag: 'clears' | 'stays';
  /** R14: a never-paid member who pledges again gets a new member id (the old one is deleted). */
  newMemberOnRenew: boolean;
  /** R15: seconds Patreon waits for an answer to a delivery; a later answer counts as failed. */
  deliveryTimeout: number;
  /** R16: a free membership's tier (amount_cents 0) shows in `currently_entitled_tiers`. */
  freeTierListed: boolean;
  /** R17: a paused pledge keeps its entitlement. */
  pauseKeeps: boolean;
  /** R18: `last_charge_status` as every read shows it (a listed value, an unlisted one, or null); undefined: as the actions set it. */
  chargeStatus: string | null | undefined;
  /** R18: fields every read shows as null, or leaves out; `fieldFaultMembers` limits them to those members (null: every member). */
  nullField: Set<FieldName>;
  absentField: Set<FieldName>;
  fieldFaultMembers: Set<string> | null;
  /** R19: a refund lowers `campaign_lifetime_support_cents` by the refunded charge. */
  refundLowersLifetime: boolean;
  /** R20: a partial refund shows as the latest charge `Refunded`. */
  partialAsRefunded: boolean;
  /** R21: Patreon offers a free trial to a member who paid before (its lifetime and latest charge stay as they were). */
  returningTrial: boolean;
  /** R22: a gift recipient's charge fields: never charged (null), or the giver's charge copied (`Paid`, now). */
  giftCharge: 'never' | 'giver';
  /** The OAuth client belongs to the other creator (C-a: /identity then shows only that creator's memberships). */
  clientOfOtherCreator: boolean;
  /** Calls one token may make in a minute before Patreon answers 429 (C-i). */
  perMinute: number;
  /** Consecutive failed deliveries after which Patreon pauses the webhook (C-h; PD gives no number). */
  pauseAfterFailures: number;
}

/** Every setting at its worst case (sheet P7, section 10; the sheet names no default for the others, chosen here). */
export function worstSettings(): PatreonSettings {
  return {
    retryNon2xx: false,
    batch: 'array',
    reorder: true,
    cancelEnds: 'now',
    declinedKeeps: true,
    refundDrops: false,
    giftedEntitled: true,
    lapseEvent: false,
    pageOrder: 'shuffled',
    skipOnChange: true,
    dupOnChange: false,
    staleReads: 40,
    foreignToken: '200-empty',
    notFoundLive: new Set(),
    creatorTtl: null,
    maskUser: 'one',
    multiTier: true,
    trialFlag: 'stays',
    newMemberOnRenew: true,
    deliveryTimeout: 10,
    freeTierListed: true,
    pauseKeeps: true,
    chargeStatus: undefined,
    nullField: new Set(),
    absentField: new Set(),
    fieldFaultMembers: null,
    refundLowersLifetime: true,
    partialAsRefunded: true,
    returningTrial: true,
    giftCharge: 'never',
    clientOfOtherCreator: false,
    perMinute: 100,
    pauseAfterFailures: 10,
  };
}

/** A member's state at one moment. Times are ms. */
export interface MemberState {
  patronStatus: 'active_patron' | 'declined_patron' | 'former_patron' | null;
  isFreeTrial: boolean | null;
  isGifted: boolean | null;
  lifetime: number | null;
  lastChargeStatus: string | null;
  lastChargeDate: number | null;
  entitled: string[];
  /** Not a Patreon field: the member cancelled and the entitlement has not lapsed yet. */
  cancelled: boolean;
  /** Not a Patreon field: the pledge is paused (R17). */
  paused: boolean;
}

export interface FakeMember {
  id: string;
  userId: string;
  campaignId: string;
  /** The order the member was made in (the list's 'created' order). */
  seq: number;
  state: MemberState;
  deleted: boolean;
  /** R11: the member shows `user` as null. */
  masked: boolean;
  /** The amount of the member's latest charge, in cents (what a refund takes back). */
  lastAmount: number;
  /** Each change: its time and what Patreon shows from then on (null: deleted). */
  history: Array<{ at: number; state: MemberState | null }>;
}

export type RouteKind = 'token' | 'identity' | 'campaigns' | 'members' | 'member';

/** One call the fake received, in order. `path` holds the query; `body` is a 2xx answer's body. */
export interface PatreonCall {
  method: string;
  path: string;
  route: RouteKind | null;
  token: string | null;
  at: number;
  status: number | 'no-answer' | 'aborted' | 'thrown';
  body?: unknown;
}

/** A failure a route answers with: a status (429 carries retry_after_seconds), no answer until the caller aborts, or a 2xx body that is not what the route sends. */
export type PatreonFault =
  | { status: number; retryAfter?: number }
  | { noAnswer: true }
  | { body: 'malformed' | 'text' };

/** One delivery Patreon sends: the body as sent, its headers (lower-case, as the route reads them), the members it names. */
export interface Delivery {
  seq: number;
  trigger: Trigger;
  body: string;
  headers: Record<string, string>;
  memberIds: string[];
  queuedAt: number;
}

/** A delivery posted, with the app's answer and how long it took on the clock. */
export interface Posted { delivery: Delivery; status: number; ms: number; failed: boolean; at: number }

/** The app's route as the world posts to it: the status it answered. */
export type Poster = (body: string, headers: Record<string, string>) => Promise<number>;

export interface Webhook { id: string; uri: string; secret: string; triggers: Trigger[]; paused: boolean; failures: number }

/** What a patron approved at the authorize page: the code and state Patreon sends back to the redirect URI. */
export interface Approved { code: string; state: string; redirectUri: string; scope: string; query: Record<string, string> }

interface Rule { route: RouteKind | RegExp; times: number }
interface FaultRule extends Rule { fault: PatreonFault }
interface SlowRule extends Rule { ms: number }
interface HoldRule extends Rule { gate: Promise<void>; reached: () => void }

class Answer {
  constructor(readonly status: number, readonly body: unknown, readonly headers: Record<string, string> = {}) {}
}

const ROUTE_OF: Record<Exclude<RouteKind, 'token'>, RegExp> = {
  identity: /^\/identity$/,
  campaigns: /^\/campaigns$/,
  members: /^\/campaigns\/[^/]+\/members$/,
  member: /^\/members\/[^/]+$/,
};
const INCLUDES: Record<'members' | 'member' | 'identity' | 'campaigns', Set<string>> = {
  members: new Set(['address', 'campaign', 'currently_entitled_tiers', 'user', 'pledge_history']),
  member: new Set(['address', 'campaign', 'currently_entitled_tiers', 'user', 'pledge_history']),
  identity: new Set(['memberships', 'campaign', 'memberships.campaign', 'memberships.currently_entitled_tiers', 'memberships.user']),
  campaigns: new Set(['tiers', 'creator', 'benefits', 'goals']),
};
const MEMBER_FIELDS = new Set(['campaign_lifetime_support_cents', 'currently_entitled_amount_cents', 'email', 'full_name', 'is_follower', 'is_free_trial', 'is_gifted', 'last_charge_date', 'last_charge_status', 'lifetime_support_cents', 'next_charge_date', 'note', 'patron_status', 'pledge_cadence', 'pledge_relationship_start', 'will_pay_amount_cents']);
const TIER_FIELDS = new Set(['amount_cents', 'created_at', 'description', 'discord_role_ids', 'edited_at', 'image_url', 'patron_count', 'post_count', 'published', 'published_at', 'remote_id', 'requires_shipping', 'title', 'unpublished_at', 'url', 'user_limit']);
const DAY_MS = 86_400_000;

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) return headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
  const found = Object.entries(headers as Record<string, string>).find(([k]) => k.toLowerCase() === name);
  return found ? found[1] : null;
}

/** Patreon's time format: 2026-11-23T12:00:00.000+00:00. */
export function patreonTime(ms: number): string {
  return new Date(ms).toISOString().replace(/Z$/, '+00:00');
}

/** The hex HMAC-MD5 of the body under the secret, as X-Patreon-Signature carries it (C-g). */
export function signBody(body: string, secret = WEBHOOK_SECRET): string {
  return crypto.createHmac('md5', secret).update(body).digest('hex');
}

const patreonError = (status: number, codeName: string, detail: string, extra: Obj = {}): Answer => new Answer(status, {
  errors: [{ code: null, code_name: codeName, detail, id: crypto.randomUUID(), status: String(status), title: codeName, ...extra }],
});

function fieldsOf(query: URLSearchParams, type: string): Set<string> {
  const raw = query.get(`fields[${type}]`);
  return new Set(raw ? raw.split(',').map(f => f.trim()).filter(Boolean) : []);
}

/** A stable pseudo-random order key of an id within one listing. */
function shuffleKey(seed: number, id: string): string {
  return crypto.createHash('sha1').update(`${seed}:${id}`).digest('hex');
}

export class FakePatreon {
  readonly settings: PatreonSettings;
  readonly calls: PatreonCall[] = [];
  /** Calls to an address, route or method the fake does not serve. */
  readonly unexpected: string[] = [];
  readonly members = new Map<string, FakeMember>();
  /** Deliveries not yet sent, oldest first. */
  readonly queue: Delivery[] = [];
  /** Deliveries Patreon holds to send again (R1, C-h), sent after the next delivery the app answers in time with a 2xx. */
  readonly retries: Delivery[] = [];
  /** Every delivery posted, in order, with the answer. */
  readonly posted: Posted[] = [];
  readonly webhooks: Webhook[] = [];
  /** Creator token to the creator it belongs to; tokens that stopped being accepted. */
  readonly creatorTokens = new Map<string, string>([[CREATOR_TOKEN, CREATOR_ID]]);
  readonly expiredTokens = new Set<string>();
  /** Creator to the campaigns it owns. */
  readonly campaigns = new Map<string, string[]>([[CREATOR_ID, [CAMPAIGN_ID]], [OTHER_CREATOR_ID, [OTHER_CAMPAIGN_ID]]]);
  readonly campaignCreatedAt = new Map<string, number>([[CAMPAIGN_ID, Date.parse('2024-01-01T00:00:00.000Z')], [OTHER_CAMPAIGN_ID, Date.parse('2024-06-01T00:00:00.000Z')]]);
  /** Patron access tokens the token exchange gave: the Patreon user, the scope and the client. */
  readonly patronTokens = new Map<string, { userId: string; scope: string; clientId: string }>();
  /** Codes `approve` issued; a code is used once. */
  readonly codes = new Map<string, { userId: string; redirectUri: string; scope: string; used: boolean }>();
  /** Every authorize URL a patron approved, with the scope it asked for. */
  readonly approvals: Array<{ url: string; userId: string; scope: string }> = [];
  /** Redirect URIs registered for the client (C-a). */
  readonly redirectUris = new Set<string>();
  /** Tier ids whose object `included` leaves out (F3). */
  readonly dropTierObject = new Set<string>();
  private poster: Poster | null = null;
  private faults: FaultRule[] = [];
  private slows: SlowRule[] = [];
  private holds: HoldRule[] = [];
  private answerHolds: HoldRule[] = [];
  private listEdit: ((page: Obj[], query: URLSearchParams) => Obj[]) | null = null;
  private memberCounter = 0;
  private deliverySeq = 0;
  private tokenCounter = 0;
  private listingCounter = 0;
  /** Each member made, deleted or changed adds one: a list read across a change is a list that changed during paging (R6). */
  private version = 0;
  private readonly listings = new Map<string, { seed: number; lastKey: string; version: number }>();
  private readonly callTimes = new Map<string, number[]>();
  private readonly startedAt = Date.now();

  constructor(settings: Partial<PatreonSettings> = {}) {
    this.settings = { ...worstSettings(), ...settings };
  }

  /** Installs the fake as the global fetch. */
  install(): this {
    vi.stubGlobal('fetch', vi.fn((url: unknown, init?: RequestInit) => this.fetch(String(url), init)));
    return this;
  }

  /** Where deliveries are posted: the app's webhook route, as the world sets it. */
  setPoster(poster: Poster | null): void {
    this.poster = poster;
  }

  /** A webhook on the campaign (made on Patreon's site), with the six members triggers unless others are named. */
  addWebhook(uri: string, secret = WEBHOOK_SECRET, triggers: Trigger[] = [...MEMBER_TRIGGERS]): Webhook {
    const hook: Webhook = { id: String(9_300_000 + this.webhooks.length + 1), uri, secret, triggers, paused: false, failures: 0 };
    this.webhooks.push(hook);
    return hook;
  }

  // ---------------------------------------------------------------------------- OAuth

  /**
   * The patron opens the authorize URL the bot built and approves it: the URL is checked (client id, a registered
   * redirect URI, response_type code), and the code and state Patreon sends back are returned. The code is used once.
   */
  approve(url: string, userId: string): Approved {
    const parsed = new URL(url);
    if (`${parsed.origin}${parsed.pathname}` !== PATREON_AUTHORIZE_URL) throw new Error(`p7Patreon.approve: not Patreon's authorize page: ${url}`);
    const q = parsed.searchParams;
    if (q.get('client_id') !== CLIENT_ID) throw new Error(`p7Patreon.approve: unknown client ${q.get('client_id')}`);
    if (q.get('response_type') !== 'code') throw new Error(`p7Patreon.approve: response_type ${q.get('response_type')}`);
    const redirectUri = q.get('redirect_uri') ?? '';
    if (!this.redirectUris.has(redirectUri)) throw new Error(`p7Patreon.approve: redirect_uri ${redirectUri} is not registered`);
    const scope = q.get('scope') ?? '';
    const state = q.get('state') ?? '';
    this.approvals.push({ url, userId, scope });
    const code = `p7-code-${++this.tokenCounter}`;
    this.codes.set(code, { userId, redirectUri, scope, used: false });
    return { code, state, redirectUri, scope, query: { code, state } };
  }

  // ---------------------------------------------------------------------------- deliveries

  private queueDeliveries(triggers: Trigger[], member: FakeMember): void {
    for (const trigger of triggers) {
      for (const hook of this.webhooks) {
        if (!hook.triggers.includes(trigger)) continue;
        const body = JSON.stringify(this.deliveryBody([member]));
        this.queue.push({ seq: ++this.deliverySeq, trigger, body, headers: this.headersFor(trigger, body, hook.secret), memberIds: [member.id], queuedAt: Date.now() });
      }
    }
  }

  private headersFor(trigger: Trigger, body: string, secret: string): Record<string, string> {
    return { 'content-type': 'application/json', 'x-patreon-event': trigger, 'x-patreon-signature': signBody(body, secret) };
  }

  /** A delivery of the row's own body under the trigger, signed with the first webhook's secret (or `secret`). */
  signed(trigger: Trigger, body: string, secret?: string): Delivery {
    const key = secret ?? this.webhooks[0]?.secret ?? WEBHOOK_SECRET;
    return { seq: ++this.deliverySeq, trigger, body, headers: this.headersFor(trigger, body, key), memberIds: [], queuedAt: Date.now() };
  }

  /** The body of a delivery naming the members: `data` the member (an array for several), `included` its user, campaign and tiers. */
  deliveryBody(members: FakeMember[]): Obj {
    const included = new Map<string, Obj>();
    const data = members.map(m => {
      const rendered = this.renderMember(m, m.deleted ? (m.history.filter(h => h.state).pop()?.state ?? m.state) : m.state, {
        fields: new Set(['patron_status', 'is_free_trial', 'is_gifted', 'campaign_lifetime_support_cents', 'last_charge_status', 'last_charge_date', 'currently_entitled_amount_cents', 'next_charge_date', 'pledge_cadence']),
        tierFields: new Set(['amount_cents', 'title']),
        include: new Set(['currently_entitled_tiers', 'user', 'campaign']),
      });
      for (const obj of rendered.included) included.set(`${obj.type}:${obj.id}`, obj);
      return rendered.resource;
    });
    return { data: data.length === 1 ? data[0] : data, included: [...included.values()], links: { self: `${PATREON_API}/members/${members[0]?.id ?? ''}` } };
  }

  /** Posts one delivery through the poster; whether Patreon counts it as delivered (a 2xx within `deliveryTimeout`). */
  private async post(delivery: Delivery): Promise<Posted> {
    if (!this.poster) throw new Error('p7Patreon: no poster set; the world sets the app route');
    const at = Date.now();
    let status: number;
    try {
      status = await this.poster(delivery.body, delivery.headers);
    } catch {
      status = 0;
    }
    const ms = Date.now() - at;
    const timedOut = ms > this.settings.deliveryTimeout * 1000;
    const failed = timedOut || status < 200 || status >= 300;
    const out: Posted = { delivery, status, ms, failed, at };
    this.posted.push(out);
    const hook = this.webhooks.find(h => h.secret && delivery.headers['x-patreon-signature'] === signBody(delivery.body, h.secret)) ?? this.webhooks[0];
    if (failed) {
      if (timedOut || status === 0 || this.settings.retryNon2xx) this.retries.push(delivery);
      if (hook) {
        hook.failures += 1;
        if (hook.failures >= this.settings.pauseAfterFailures) hook.paused = true;
      }
    } else if (hook) {
      hook.failures = 0;
    }
    return out;
  }

  /** Sends the deliveries held to send again (C-h: with the next successful call), one each or in one body (R2). */
  private async sendRetries(): Promise<Posted[]> {
    if (this.retries.length === 0) return [];
    const held = this.retries.splice(0, this.retries.length);
    if (this.settings.batch === 'separate' || held.length === 1) {
      const out: Posted[] = [];
      for (const d of held) out.push(await this.post(d));
      return out;
    }
    const members = held.flatMap(d => d.memberIds).map(id => this.members.get(id)).filter((m): m is FakeMember => !!m);
    if (members.length === 0) return [];
    const body = JSON.stringify(this.deliveryBody(members));
    const secret = this.webhooks[0]?.secret ?? WEBHOOK_SECRET;
    return [await this.post({ seq: ++this.deliverySeq, trigger: held[held.length - 1].trigger, body, headers: this.headersFor(held[held.length - 1].trigger, body, secret), memberIds: members.map(m => m.id), queuedAt: Date.now() })];
  }

  /**
   * Posts the queued delivery at `index` (the oldest by default): nothing while its webhook is paused (it waits with
   * the ones to send again). After a delivery the app answered in time, the held ones follow (C-h).
   */
  async deliver(index = 0): Promise<Posted[]> {
    const [delivery] = this.queue.splice(index, 1);
    if (!delivery) return [];
    if (this.webhooks.length > 0 && this.webhooks.every(h => h.paused)) {
      this.retries.push(delivery);
      return [];
    }
    const first = await this.post(delivery);
    const out = [first];
    if (!first.failed) out.push(...await this.sendRetries());
    return out;
  }

  /** Posts every queued delivery: the oldest first, or the newest first under R3 `reorder`. */
  async deliverAll(): Promise<Posted[]> {
    const out: Posted[] = [];
    for (let guard = 0; this.queue.length > 0; guard++) {
      if (guard > 10_000) throw new Error('p7Patreon.deliverAll: the queue does not empty');
      out.push(...await this.deliver(this.settings.reorder ? this.queue.length - 1 : 0));
    }
    return out;
  }

  /** Posts a delivery again, as it was (F6: a replay of a captured delivery). */
  async replay(old: Delivery): Promise<Posted> {
    return this.post({ ...old, headers: { ...old.headers } });
  }

  /** Posts a row's own delivery (`signed`). */
  async postOwn(delivery: Delivery): Promise<Posted> {
    return this.post(delivery);
  }

  drop(index = 0): Delivery | null {
    return this.queue.splice(index, 1)[0] ?? null;
  }

  duplicate(index = 0): void {
    const d = this.queue[index];
    if (d) this.queue.splice(index + 1, 0, { ...d, headers: { ...d.headers } });
  }

  reorderQueue(from: number, to: number): void {
    const [d] = this.queue.splice(from, 1);
    if (d) this.queue.splice(Math.min(to, this.queue.length), 0, d);
  }

  /** Patreon's webhook set back after a pause, as someone does on Patreon's site (C-h). */
  unpause(): void {
    for (const hook of this.webhooks) {
      hook.paused = false;
      hook.failures = 0;
    }
  }

  // ---------------------------------------------------------------------------- members and Patreon-side actions

  private blankState(): MemberState {
    return { patronStatus: null, isFreeTrial: false, isGifted: false, lifetime: 0, lastChargeStatus: null, lastChargeDate: null, entitled: [], cancelled: false, paused: false };
  }

  private newMember(userId: string, campaignId = CAMPAIGN_ID): FakeMember {
    this.memberCounter += 1;
    const n = this.memberCounter;
    const id = `${n.toString(16).padStart(8, '0')}-7a00-4000-8000-${n.toString(16).padStart(12, '0')}`;
    const masked = this.settings.maskUser === 'all' || (this.settings.maskUser === 'one' && n === 1);
    const member: FakeMember = { id, userId, campaignId, seq: n, state: this.blankState(), deleted: false, masked, lastAmount: 0, history: [] };
    this.members.set(id, member);
    return member;
  }

  private change(member: FakeMember, edit: (s: MemberState) => void, triggers: Trigger[]): FakeMember {
    const next = structuredClone(member.state);
    edit(next);
    member.state = next;
    member.history.push({ at: Date.now(), state: structuredClone(next) });
    this.version += 1;
    this.queueDeliveries(triggers, member);
    return member;
  }

  private member(id: string | FakeMember): FakeMember {
    const m = typeof id === 'string' ? this.members.get(id) : id;
    if (!m) throw new Error(`p7Patreon: no member ${String(id)}`);
    return m;
  }

  /** The user's live member of the campaign (not deleted), or null. */
  memberOf(userId: string, campaignId = CAMPAIGN_ID): FakeMember | null {
    let found: FakeMember | null = null;
    for (const m of this.members.values()) if (m.userId === userId && m.campaignId === campaignId && !m.deleted) found = m;
    return found;
  }

  private sumAmount(tiers: string[]): number {
    return tiers.reduce((sum, t) => sum + (TIER_AMOUNT[t] ?? 0), 0);
  }

  /** The member for a new pledge: the live one, or a new one (R14: a never-paid former member is deleted first). */
  private memberForPledge(userId: string): { member: FakeMember; created: boolean } {
    let m = this.memberOf(userId);
    if (m && this.settings.newMemberOnRenew && (m.state.lifetime ?? 0) === 0 && m.state.patronStatus !== 'active_patron' && m.state.entitled.length === 0) {
      this.deleteMember(m);
      m = null;
    }
    if (m) return { member: m, created: false };
    return { member: this.newMember(userId), created: true };
  }

  /** The user pledges to the tier and the charge is paid (with R12 `multiTier`, a tier added to a live pledge). */
  pledge(userId: string, tierId: string): FakeMember {
    const { member, created } = this.memberForPledge(userId);
    const live = member.state.patronStatus === 'active_patron' && !member.state.cancelled;
    const entitled = this.settings.multiTier && live ? [...new Set([...member.state.entitled, tierId])] : [tierId];
    member.lastAmount = TIER_AMOUNT[tierId] ?? 0;
    return this.change(member, s => {
      s.patronStatus = 'active_patron';
      s.isFreeTrial = false;
      s.entitled = entitled;
      s.lastChargeStatus = 'Paid';
      s.lastChargeDate = Date.now();
      s.lifetime = (s.lifetime ?? 0) + member.lastAmount;
      s.cancelled = false;
      s.paused = false;
    }, created ? ['members:create', 'members:pledge:create'] : ['members:pledge:create', 'members:update']);
  }

  /** The member cancels: entitlement dropped at once or at the period's end (R4 `cancelEnds`). */
  cancel(id: string | FakeMember): FakeMember {
    return this.change(this.member(id), s => {
      s.patronStatus = 'former_patron';
      s.cancelled = true;
      if (this.settings.cancelEnds === 'now') s.entitled = [];
    }, ['members:pledge:delete', 'members:update']);
  }

  /**
   * The billing period ends: a cancelled or declined pledge lapses (members:update only under R5 `lapseEvent`); a live
   * one is charged again and paid; a trial is charged (chargeTrial).
   */
  periodEnd(id: string | FakeMember): FakeMember {
    const m = this.member(id);
    if (m.state.isFreeTrial === true && m.state.patronStatus === 'active_patron' && !m.state.cancelled) return this.chargeTrial(m, true);
    if (m.state.cancelled || m.state.patronStatus !== 'active_patron') {
      return this.change(m, s => {
        s.entitled = [];
        s.cancelled = false;
        if (s.patronStatus === 'active_patron') s.patronStatus = 'former_patron';
      }, this.settings.lapseEvent ? ['members:update'] : []);
    }
    m.lastAmount = this.sumAmount(m.state.entitled);
    return this.change(m, s => {
      s.lastChargeStatus = 'Paid';
      s.lastChargeDate = Date.now();
      s.lifetime = (s.lifetime ?? 0) + m.lastAmount;
    }, ['members:update']);
  }

  /** The member's charge is declined (R4 `declinedKeeps`; R13 for a trial). */
  decline(id: string | FakeMember): FakeMember {
    return this.change(this.member(id), s => {
      s.lastChargeStatus = 'Declined';
      s.lastChargeDate = Date.now();
      s.patronStatus = 'declined_patron';
      if (!this.settings.declinedKeeps) s.entitled = [];
      if (s.isFreeTrial === true && this.settings.trialFlag === 'clears') s.isFreeTrial = false;
    }, ['members:update']);
  }

  private refundAs(id: string | FakeMember, status: string, share: number, drops: boolean): FakeMember {
    const m = this.member(id);
    return this.change(m, s => {
      s.lastChargeStatus = status;
      if (drops) s.entitled = [];
      if (this.settings.refundLowersLifetime) s.lifetime = Math.max(0, (s.lifetime ?? 0) - Math.round(m.lastAmount * share));
    }, ['members:update']);
  }

  /** The creator refunds the latest charge (R4 `refundDrops`, R19 `refundLowersLifetime`). */
  refund(id: string | FakeMember): FakeMember {
    return this.refundAs(id, 'Refunded', 1, this.settings.refundDrops);
  }

  refundedByPatreon(id: string | FakeMember): FakeMember {
    return this.refundAs(id, 'Refunded by Patreon', 1, this.settings.refundDrops);
  }

  fraud(id: string | FakeMember): FakeMember {
    return this.refundAs(id, 'Fraud', 1, this.settings.refundDrops);
  }

  /** Part of the latest charge is refunded: `Partially Refunded`, or `Refunded` under R20; the entitlement stays. */
  partialRefund(id: string | FakeMember): FakeMember {
    return this.refundAs(id, this.settings.partialAsRefunded ? 'Refunded' : 'Partially Refunded', 0.5, false);
  }

  /** The member changes tier `from` (the first entitled one by default) to `to`; an upgrade is charged and paid. */
  changeTier(id: string | FakeMember, to: string, from?: string): FakeMember {
    const m = this.member(id);
    const old = from ?? m.state.entitled[0];
    const entitled = old === undefined ? [to] : [...new Set(m.state.entitled.map(t => (t === old ? to : t)))];
    const diff = (TIER_AMOUNT[to] ?? 0) - (old === undefined ? 0 : TIER_AMOUNT[old] ?? 0);
    if (diff > 0) m.lastAmount = diff;
    return this.change(m, s => {
      s.entitled = entitled;
      if (diff > 0) {
        s.lastChargeStatus = 'Paid';
        s.lastChargeDate = Date.now();
        s.lifetime = (s.lifetime ?? 0) + diff;
      }
    }, ['members:pledge:update', 'members:update']);
  }

  /**
   * The user starts a free trial of the tier: entitled at once, nothing charged. A member who paid before gets one only
   * under R21 `returningTrial` (its lifetime and latest charge stay); null when Patreon offers none.
   */
  startTrial(userId: string, tierId: string): FakeMember | null {
    const live = this.memberOf(userId);
    if (live && live.state.patronStatus === 'active_patron' && !live.state.cancelled && live.state.entitled.length > 0) return null;
    if (live && (live.state.lifetime ?? 0) > 0 && !this.settings.returningTrial) return null;
    const { member, created } = this.memberForPledge(userId);
    member.lastAmount = 0;
    return this.change(member, s => {
      s.patronStatus = 'active_patron';
      s.isFreeTrial = true;
      s.entitled = [tierId];
      s.cancelled = false;
      s.paused = false;
    }, created ? ['members:create', 'members:pledge:create'] : ['members:pledge:create', 'members:update']);
  }

  /** The trial's first charge: paid (R13 `trialFlag` decides whether `is_free_trial` clears), or declined. */
  chargeTrial(id: string | FakeMember, paid = true): FakeMember {
    const m = this.member(id);
    if (!paid) return this.decline(m);
    m.lastAmount = this.sumAmount(m.state.entitled);
    return this.change(m, s => {
      s.lastChargeStatus = 'Paid';
      s.lastChargeDate = Date.now();
      s.lifetime = (s.lifetime ?? 0) + m.lastAmount;
      if (this.settings.trialFlag === 'clears') s.isFreeTrial = false;
    }, ['members:update']);
  }

  /**
   * Someone gives the user a membership of the tier (`is_gifted` true): entitled under R4 `giftedEntitled`; its charge
   * fields under R22 `giftCharge`. `isFreeTrial` is what Patreon shows on it (L5 draws false, true and null).
   */
  gift(userId: string, tierId: string, opts: { isFreeTrial?: boolean | null } = {}): FakeMember {
    let member = this.memberOf(userId);
    const created = !member;
    member ??= this.newMember(userId);
    member.lastAmount = 0;
    return this.change(member, s => {
      s.patronStatus = 'active_patron';
      s.isGifted = true;
      s.isFreeTrial = opts.isFreeTrial === undefined ? false : opts.isFreeTrial;
      s.entitled = this.settings.giftedEntitled ? [tierId] : [];
      if (this.settings.giftCharge === 'giver') {
        s.lastChargeStatus = 'Paid';
        s.lastChargeDate = Date.now();
      } else {
        s.lastChargeStatus = null;
        s.lastChargeDate = null;
      }
      s.cancelled = false;
    }, created ? ['members:create'] : ['members:update']);
  }

  /** The user becomes a free member (R16 `freeTierListed` decides whether the free tier is entitled). */
  joinFree(userId: string): FakeMember {
    let member = this.memberOf(userId);
    const created = !member;
    member ??= this.newMember(userId);
    return this.change(member, s => {
      s.patronStatus = null;
      s.entitled = this.settings.freeTierListed ? [PTIER.FREE] : [];
    }, created ? ['members:create'] : ['members:update']);
  }

  /** The member pauses the pledge (R17 `pauseKeeps`). */
  pause(id: string | FakeMember): FakeMember {
    return this.change(this.member(id), s => {
      s.paused = true;
      if (!this.settings.pauseKeeps) s.entitled = [];
    }, ['members:update']);
  }

  /** Patreon deletes the member (C-f: only one that never paid); reads answer 404 from then on. */
  deleteMember(id: string | FakeMember): FakeMember {
    const m = this.member(id);
    m.deleted = true;
    m.history.push({ at: Date.now(), state: null });
    this.version += 1;
    this.queueDeliveries(['members:delete'], m);
    return m;
  }

  /** A row sets fields of a member as Patreon would show them (a charge status of F2, say), with the triggers it names. */
  setMember(id: string | FakeMember, patch: Partial<MemberState>, triggers: Trigger[] = ['members:update']): FakeMember {
    return this.change(this.member(id), s => { Object.assign(s, structuredClone(patch)); }, triggers);
  }

  /** A membership of the user in the other creator's campaign (F4). */
  otherMembership(userId: string, tierId: string = PTIER.A): FakeMember {
    const m = this.newMember(userId, OTHER_CAMPAIGN_ID);
    return this.change(m, s => {
      s.patronStatus = 'active_patron';
      s.entitled = [tierId];
      s.lastChargeStatus = 'Paid';
      s.lastChargeDate = Date.now();
      s.lifetime = TIER_AMOUNT[tierId] ?? 0;
    }, []);
  }

  /** The creator token stops being accepted (R9): 401 from now on. */
  expireCreatorToken(token = CREATOR_TOKEN): void {
    this.expiredTokens.add(token);
  }

  /** A token of another creator, for the bot to be given (R8). */
  rotateCreator(): { token: string; campaignId: string } {
    this.creatorTokens.set(OTHER_CREATOR_TOKEN, OTHER_CREATOR_ID);
    return { token: OTHER_CREATOR_TOKEN, campaignId: OTHER_CAMPAIGN_ID };
  }

  /** The member's last change, in ms (0 with none). */
  lastChange(): number {
    let last = 0;
    for (const m of this.members.values()) for (const h of m.history) last = Math.max(last, h.at);
    return last;
  }

  // ---------------------------------------------------------------------------- faults, slow answers and holds

  /** The next `times` calls of the route answer with the fault. */
  fail(route: RouteKind | RegExp, fault: PatreonFault, times = 1): void {
    this.faults.push({ route, fault, times });
  }

  /** The next `times` calls of the route answer `ms` later (an abort of the caller's signal ends the wait). */
  slow(route: RouteKind | RegExp, ms: number, times = 1): void {
    this.slows.push({ route, ms, times });
  }

  clearFaults(): void {
    this.faults = [];
    this.slows = [];
  }

  /** The next call of the route waits, before the fake acts on it, until `release`; `reached` resolves when it arrives. */
  hold(route: RouteKind | RegExp): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const arrived = new Promise<void>(resolve => { reached = resolve; });
    this.holds.push({ route, gate, reached, times: 1 });
    return { reached: arrived, release };
  }

  /** The next call of the route is answered as Patreon is now, and the answer waits until `release`. */
  holdAnswer(route: RouteKind | RegExp): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const arrived = new Promise<void>(resolve => { reached = resolve; });
    this.answerHolds.push({ route, gate, reached, times: 1 });
    return { reached: arrived, release };
  }

  /** A list page, made as the fake makes it, changed by `edit` before it is sent (a page Patreon got wrong). */
  editListPages(edit: ((page: Obj[], query: URLSearchParams) => Obj[]) | null): void {
    this.listEdit = edit;
  }

  private take<T extends Rule>(list: T[], route: RouteKind | null, path: string): T | null {
    const rule = list.find(r => r.times > 0 && (typeof r.route === 'string' ? r.route === route : r.route.test(path)));
    if (!rule) return null;
    rule.times -= 1;
    return rule;
  }

  // ---------------------------------------------------------------------------- the transport

  /** Calls the token made in the last minute (the 429 limit counts answered calls). */
  callsInMinute(token: string, now = Date.now()): number {
    return (this.callTimes.get(token) ?? []).filter(t => t > now - 60_000).length;
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const isToken = url === PATREON_TOKEN_URL;
    if (!isToken && !url.startsWith(`${PATREON_API}/`)) {
      this.unexpected.push(`${method} ${url}`);
      throw new TypeError(`p7Patreon: no route outside Patreon's API: ${method} ${url}`);
    }
    const path = isToken ? '/token' : url.slice(PATREON_API.length);
    const bare = path.split('?')[0];
    const route: RouteKind | null = isToken ? 'token' : (Object.keys(ROUTE_OF) as Array<Exclude<RouteKind, 'token'>>).find(k => ROUTE_OF[k].test(bare)) ?? null;
    const auth = headerOf(init, 'authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const call: PatreonCall = { method, path, route, token, at: Date.now(), status: 'thrown' };
    this.calls.push(call);
    if (route === null || (route === 'token' ? method !== 'POST' : method !== 'GET')) {
      this.unexpected.push(`${method} ${path}`);
      throw new TypeError(`p7Patreon: the fake does not serve ${method} ${path}`);
    }
    const signal = init?.signal ?? null;
    const wait = (until: Promise<void>): Promise<void> => new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      void until.then(resolve);
    });
    let fault: PatreonFault | null = null;
    try {
      const held = this.take(this.holds, route, path);
      if (held) {
        held.reached();
        await wait(held.gate);
      }
      const slow = this.take(this.slows, route, path);
      if (slow) await wait(new Promise<void>(resolve => { setTimeout(resolve, slow.ms); }));
      fault = this.take(this.faults, route, path)?.fault ?? null;
      if (fault && 'noAnswer' in fault) {
        call.status = 'no-answer';
        await wait(new Promise<void>(() => undefined));
      }
      if (signal?.aborted) throw signal.reason;
    } catch (error) {
      if (call.status !== 'no-answer') call.status = 'aborted';
      throw error;
    }
    let answer: Answer;
    try {
      const limited = token !== null && route !== 'token' ? this.limit(token) : null;
      answer = limited ?? (fault ? this.faultAnswer(fault, route) : route === 'token' ? this.exchange(init) : this.answerFor(route, path, token));
    } catch (error) {
      this.unexpected.push(`${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    const heldAnswer = this.take(this.answerHolds, route, path);
    if (heldAnswer) {
      answer = new Answer(answer.status, structuredClone(answer.body), answer.headers);
      heldAnswer.reached();
      try {
        await wait(heldAnswer.gate);
      } catch (error) {
        call.status = 'aborted';
        throw error;
      }
    }
    call.status = answer.status;
    if (answer.status >= 200 && answer.status < 300) call.body = answer.body;
    return this.respond(answer);
  }

  /** C-i: past `perMinute` answered calls in a minute, a 429 with the seconds until a call leaves the window. */
  private limit(token: string): Answer | null {
    const now = Date.now();
    const times = (this.callTimes.get(token) ?? []).filter(t => t > now - 60_000);
    if (times.length >= this.settings.perMinute) {
      this.callTimes.set(token, times);
      const retry = Math.max(1, Math.ceil((times[0] + 60_000 - now) / 1000));
      return patreonError(429, 'RequestThrottled', 'You have made too many attempts. Please try again later.', { retry_after_seconds: retry });
    }
    times.push(now);
    this.callTimes.set(token, times);
    return null;
  }

  private faultAnswer(fault: PatreonFault, route: RouteKind): Answer {
    if ('body' in fault) {
      if (fault.body === 'text') return new Answer(200, '<html>bad gateway</html>');
      return new Answer(200, route === 'members' ? { data: {}, meta: {} } : route === 'member' ? { data: [] } : route === 'campaigns' ? { data: 'campaigns' } : { data: null });
    }
    if (!('status' in fault)) throw new Error('p7Patreon: a fault without an answer');
    if (fault.status === 429) return patreonError(429, 'RequestThrottled', 'You have made too many attempts. Please try again later.', { retry_after_seconds: fault.retryAfter ?? 5 });
    if (fault.status === 401) return patreonError(401, 'Unauthorized', 'The server could not verify that you are authorized to access the URL requested.');
    if (fault.status === 403) return patreonError(403, 'Forbidden', 'You do not have permission to access this resource.');
    if (fault.status === 404) return patreonError(404, 'ResourceMissing', 'The requested resource was not found.');
    if (fault.status === 410) return patreonError(410, 'Gone', 'The requested resource is gone.');
    return fault.status >= 500 ? patreonError(fault.status, 'InternalServerError', 'Something went wrong.') : patreonError(fault.status, 'ParameterInvalid', 'Bad request.');
  }

  private respond(answer: Answer): Response {
    const headers = { ...answer.headers };
    if (typeof answer.body === 'string') return new Response(answer.body, { status: answer.status, headers: { ...headers, 'content-type': 'text/html' } });
    if (answer.body === null) return new Response(null, { status: answer.status, headers });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { ...headers, 'content-type': 'application/vnd.api+json' } });
  }

  private exchange(init: RequestInit | undefined): Answer {
    const raw = init?.body;
    const form = raw instanceof URLSearchParams ? raw : new URLSearchParams(typeof raw === 'string' ? raw : '');
    const grant = form.get('grant_type');
    if (grant !== 'authorization_code') {
      this.unexpected.push(`POST /token grant_type=${grant}`);
      return new Answer(400, { error: 'unsupported_grant_type' });
    }
    if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) return new Answer(401, { error: 'invalid_client' });
    const code = this.codes.get(form.get('code') ?? '');
    if (!code || code.used || code.redirectUri !== form.get('redirect_uri')) return new Answer(400, { error: 'invalid_grant' });
    code.used = true;
    const token = `p7-patron-token-${++this.tokenCounter}`;
    this.patronTokens.set(token, { userId: code.userId, scope: code.scope, clientId: CLIENT_ID });
    return new Answer(200, { access_token: token, refresh_token: `${token}-refresh`, expires_in: 2_678_400, scope: code.scope, token_type: 'Bearer', version: '0.0.1' });
  }

  /** The creator a creator token belongs to; null for a token Patreon does not accept now. */
  private creatorOf(token: string | null): string | null {
    if (token === null || this.expiredTokens.has(token)) return null;
    if (this.settings.creatorTtl !== null && token === CREATOR_TOKEN && Date.now() >= this.startedAt + this.settings.creatorTtl * 1000) return null;
    return this.creatorTokens.get(token) ?? null;
  }

  private answerFor(route: Exclude<RouteKind, 'token'>, path: string, token: string | null): Answer {
    const bare = path.split('?')[0];
    const query = new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?') + 1) : '');
    for (const key of query.keys()) {
      if (key === 'include' || /^fields\[[a-z_]+\]$/.test(key)) continue;
      if (route === 'members' && (key === 'page[count]' || key === 'page[cursor]')) continue;
      return patreonError(400, 'ParameterInvalid', `Invalid parameter ${key}`);
    }
    const include = new Set((query.get('include') ?? '').split(',').map(s => s.trim()).filter(Boolean));
    for (const inc of include) if (!INCLUDES[route].has(inc)) return patreonError(400, 'ParameterInvalid', `Invalid include ${inc}`);
    for (const f of fieldsOf(query, 'member')) if (!MEMBER_FIELDS.has(f)) return patreonError(400, 'ParameterInvalid', `Invalid field ${f}`);
    for (const f of fieldsOf(query, 'tier')) if (!TIER_FIELDS.has(f)) return patreonError(400, 'ParameterInvalid', `Invalid field ${f}`);
    if (route === 'identity') return this.identity(token, query, include);
    const creator = this.creatorOf(token);
    if (creator === null) {
      return token !== null && this.patronTokens.has(token)
        ? patreonError(403, 'Forbidden', 'This token does not have the required scope.')
        : patreonError(401, 'Unauthorized', 'The server could not verify that you are authorized to access the URL requested.');
    }
    const owned = this.campaigns.get(creator) ?? [];
    if (route === 'campaigns') {
      const fields = fieldsOf(query, 'campaign');
      return new Answer(200, {
        data: owned.map(id => ({ type: 'campaign', id, attributes: fields.has('created_at') ? { created_at: patreonTime(this.campaignCreatedAt.get(id) ?? 0) } : {} })),
        meta: { pagination: { total: owned.length } },
      });
    }
    const spec = { fields: fieldsOf(query, 'member'), tierFields: fieldsOf(query, 'tier'), include };
    if (route === 'member') {
      const id = decodeURIComponent(bare.split('/')[2]);
      const m = this.members.get(id);
      if (m && !owned.includes(m.campaignId)) return this.foreign(route);
      const shown = m ? this.seen(m) : null;
      if (!m || !shown || this.settings.notFoundLive.has(id)) return patreonError(404, 'ResourceMissing', 'The requested resource was not found.');
      const rendered = this.renderMember(m, shown, spec);
      return new Answer(200, { data: rendered.resource, included: rendered.included, links: { self: `${PATREON_API}/members/${id}` } });
    }
    const campaignId = decodeURIComponent(bare.split('/')[2]);
    if (!owned.includes(campaignId)) return this.foreign(route);
    return this.list(campaignId, query, spec);
  }

  private foreign(route: 'members' | 'member'): Answer {
    const f = this.settings.foreignToken;
    if (f === '401') return patreonError(401, 'Unauthorized', 'The server could not verify that you are authorized to access the URL requested.');
    if (f === '403') return patreonError(403, 'Forbidden', 'You do not have permission to access this resource.');
    if (f === '404' || route === 'member') return patreonError(404, 'ResourceMissing', 'The requested resource was not found.');
    return new Answer(200, { data: [], included: [], meta: { pagination: { cursors: { next: null }, total: 0 } } });
  }

  /** What a read made now shows of the member (R7: the state `staleReads` seconds ago); null when it did not exist then or was deleted. */
  private seen(m: FakeMember, now = Date.now()): MemberState | null {
    const asOf = now - this.settings.staleReads * 1000;
    let shown: MemberState | null = null;
    for (const step of m.history) if (step.at <= asOf) shown = step.state;
    return shown;
  }

  private faulted(m: FakeMember, field: FieldName): 'null' | 'absent' | null {
    if (this.settings.fieldFaultMembers && !this.settings.fieldFaultMembers.has(m.id)) return null;
    if (this.settings.absentField.has(field)) return 'absent';
    if (this.settings.nullField.has(field)) return 'null';
    return null;
  }

  /** The member resource Patreon shows for a state, with the fields and includes asked for, and its included objects. */
  renderMember(m: FakeMember, s: MemberState, spec: { fields: Set<string>; tierFields: Set<string>; include: Set<string> }): { resource: Obj; included: Obj[] } {
    const values: Obj = {
      patron_status: s.patronStatus,
      is_free_trial: s.isFreeTrial,
      is_gifted: s.isGifted,
      campaign_lifetime_support_cents: s.lifetime,
      lifetime_support_cents: s.lifetime,
      last_charge_status: this.settings.chargeStatus !== undefined ? this.settings.chargeStatus : s.lastChargeStatus,
      last_charge_date: s.lastChargeDate === null ? null : patreonTime(s.lastChargeDate),
      currently_entitled_amount_cents: this.sumAmount(s.entitled),
      next_charge_date: s.patronStatus === 'active_patron' && s.lastChargeDate !== null ? patreonTime(s.lastChargeDate + 30 * DAY_MS) : null,
      pledge_cadence: s.entitled.length > 0 ? 1 : null,
      will_pay_amount_cents: s.patronStatus === 'active_patron' ? this.sumAmount(s.entitled) : 0,
      is_follower: false,
      full_name: m.masked ? null : `Patron ${m.userId}`,
      email: m.masked ? null : `${m.userId}@patrons.example`,
      note: '',
      pledge_relationship_start: m.history[0] ? patreonTime(m.history[0].at) : null,
    };
    const attributes: Obj = {};
    for (const f of spec.fields) {
      const fault = this.faulted(m, f as FieldName);
      if (fault === 'absent') continue;
      attributes[f] = fault === 'null' ? null : values[f];
    }
    const relationships: Obj = {};
    const included: Obj[] = [];
    if (spec.include.has('currently_entitled_tiers')) {
      const fault = this.faulted(m, 'currently_entitled_tiers');
      if (fault !== 'absent') relationships.currently_entitled_tiers = { data: fault === 'null' ? null : s.entitled.map(id => ({ type: 'tier', id })) };
      if (fault === null) {
        for (const id of s.entitled) {
          if (this.dropTierObject.has(id)) continue;
          included.push(this.renderTier(m, id, spec.tierFields));
        }
      }
    }
    if (spec.include.has('user')) {
      const fault = this.faulted(m, 'user');
      if (fault !== 'absent') relationships.user = { data: fault === 'null' || m.masked ? null : { type: 'user', id: m.userId } };
      if (fault === null && !m.masked) included.push({ type: 'user', id: m.userId, attributes: {} });
    }
    if (spec.include.has('campaign')) {
      const fault = this.faulted(m, 'campaign');
      if (fault !== 'absent') relationships.campaign = { data: fault === 'null' ? null : { type: 'campaign', id: m.campaignId } };
      if (fault === null) included.push({ type: 'campaign', id: m.campaignId, attributes: {} });
    }
    const resource: Obj = { type: 'member', id: m.id, attributes };
    if (Object.keys(relationships).length > 0) resource.relationships = relationships;
    return { resource, included };
  }

  private renderTier(m: FakeMember, id: string, fields: Set<string>): Obj {
    const attributes: Obj = {};
    const values: Obj = { amount_cents: TIER_AMOUNT[id] ?? 0, title: TIER_TITLE[id] ?? id, published: true };
    for (const f of fields) {
      if (f === 'amount_cents') {
        const fault = this.faulted(m, 'amount_cents');
        if (fault === 'absent') continue;
        attributes[f] = fault === 'null' ? null : values[f];
      } else if (f in values) {
        attributes[f] = values[f];
      }
    }
    return { type: 'tier', id, attributes };
  }

  /** The member read as Patreon shows it now with no lag, with every field a decision reads (the oracle's view). */
  currentRead(id: string | FakeMember): { data: Obj; included: Obj[] } | null {
    const m = this.member(id);
    if (m.deleted) return null;
    const rendered = this.renderMember(m, m.state, {
      fields: new Set(['patron_status', 'is_free_trial', 'is_gifted', 'campaign_lifetime_support_cents', 'last_charge_status', 'last_charge_date']),
      tierFields: new Set(['amount_cents', 'title']),
      include: new Set(['currently_entitled_tiers', 'user', 'campaign']),
    });
    return { data: rendered.resource, included: rendered.included };
  }

  private orderKey(m: FakeMember, seed: number): string {
    if (this.settings.pageOrder === 'created') return m.seq.toString().padStart(10, '0');
    if (this.settings.pageOrder === 'reverse') return (1e9 - m.seq).toString().padStart(10, '0');
    return shuffleKey(seed, m.id);
  }

  private list(campaignId: string, query: URLSearchParams, spec: { fields: Set<string>; tierFields: Set<string>; include: Set<string> }): Answer {
    const countRaw = query.get('page[count]');
    const max = spec.include.has('pledge_history') ? 500 : 1000;
    const count = countRaw === null ? 20 : Number(countRaw);
    if (!Number.isInteger(count) || count < 1 || count > max) return patreonError(400, 'ParameterInvalid', 'Invalid page[count]');
    const cursor = query.get('page[cursor]');
    let listing: { seed: number; lastKey: string; version: number } | null = null;
    if (cursor !== null) {
      listing = this.listings.get(cursor) ?? null;
      if (!listing) return patreonError(400, 'ParameterInvalid', 'Invalid page[cursor]');
    }
    const seed = listing?.seed ?? ++this.listingCounter;
    const now = Date.now();
    const version = this.version;
    const visible: Array<{ m: FakeMember; s: MemberState; key: string }> = [];
    for (const m of this.members.values()) {
      if (m.campaignId !== campaignId) continue;
      const s = this.seen(m, now);
      if (!s) continue;
      visible.push({ m, s, key: this.orderKey(m, seed) });
    }
    visible.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let start = 0;
    if (listing) {
      const after = visible.findIndex(v => v.key > listing!.lastKey);
      start = after < 0 ? visible.length : after;
      if (listing.version !== this.version) {
        if (this.settings.dupOnChange) start = Math.max(0, start - 1);
        else if (this.settings.skipOnChange) start = Math.min(visible.length, start + 1);
      }
    }
    const pageItems = visible.slice(start, start + count);
    const included = new Map<string, Obj>();
    let data = pageItems.map(v => {
      const rendered = this.renderMember(v.m, v.s, spec);
      for (const obj of rendered.included) included.set(`${obj.type}:${obj.id}`, obj);
      return rendered.resource;
    });
    if (this.listEdit) data = this.listEdit(data, query);
    let next: string | null = null;
    if (start + count < visible.length && pageItems.length > 0) {
      next = `p7-cursor-${seed}-${start + count}-${crypto.randomBytes(4).toString('hex')}`;
      this.listings.set(next, { seed, lastKey: pageItems[pageItems.length - 1].key, version });
    }
    return new Answer(200, {
      data,
      included: [...included.values()],
      meta: { pagination: { cursors: { next }, total: visible.length } },
      ...(next ? { links: { next: `${PATREON_API}/campaigns/${campaignId}/members?page%5Bcursor%5D=${encodeURIComponent(next)}` } } : {}),
    });
  }

  private identity(token: string | null, query: URLSearchParams, include: Set<string>): Answer {
    const patron = token === null ? undefined : this.patronTokens.get(token);
    if (!patron) return patreonError(401, 'Unauthorized', 'The server could not verify that you are authorized to access the URL requested.');
    const userId = patron.userId;
    const clientCampaign = this.settings.clientOfOtherCreator ? OTHER_CAMPAIGN_ID : CAMPAIGN_ID;
    const allMemberships = patron.scope.split(/\s+/).includes('identity.memberships');
    const mine = [...this.members.values()].filter(m => m.userId === userId && !m.deleted && (allMemberships || m.campaignId === clientCampaign));
    const data: Obj = { type: 'user', attributes: {} };
    const idFault = this.settings.absentField.has('user.id') ? 'absent' : this.settings.nullField.has('user.id') ? 'null' : null;
    if (idFault !== 'absent') data.id = idFault === 'null' ? null : userId;
    const included: Obj[] = [];
    if (include.has('memberships')) {
      const mFault = this.settings.absentField.has('memberships') ? 'absent' : this.settings.nullField.has('memberships') ? 'null' : null;
      if (mFault !== 'absent') data.relationships = { memberships: { data: mFault === 'null' ? null : mine.map(m => ({ type: 'member', id: m.id })) } };
      if (mFault === null) {
        const sub = new Set<string>();
        for (const inc of include) if (inc.startsWith('memberships.')) sub.add(inc.slice('memberships.'.length));
        const seenObjs = new Set<string>();
        for (const m of mine) {
          const rendered = this.renderMember(m, m.state, { fields: fieldsOf(query, 'member'), tierFields: fieldsOf(query, 'tier'), include: sub });
          included.push(rendered.resource);
          for (const obj of rendered.included) {
            const key = `${obj.type}:${obj.id}`;
            if (seenObjs.has(key)) continue;
            seenObjs.add(key);
            included.push(obj);
          }
        }
      }
    }
    return new Answer(200, { data, included, links: { self: `${PATREON_API}/user/${userId}` } });
  }
}

/** What THE FIELD RULE reads from one member resource and its included objects (sheet P7, field table): the oracle's reading. */
export interface FieldReading {
  /** Why the read is malformed; null when the table reads it. */
  malformed: string | null;
  /** The entitled tiers the table reads as paid, none while the latest charge is a refund or fraud. */
  paid: string[];
  /** The latest charge is `Refunded`, `Refunded by Patreon` or `Fraud`. */
  refunded: boolean;
  /** A `Paid`, `Partially Refunded` or `Refund Declined` latest charge, or a gift never charged. */
  allowance: boolean;
  /** `is_free_trial` true or null, a lifetime of 0, and no install allowance. */
  trial: boolean;
  autoRenew: boolean;
  /** The member's Patreon user, null when masked or absent. */
  userId: string | null;
}

const INSTALLS = new Set(['Paid', 'Partially Refunded', 'Refund Declined']);
const ENDS = new Set(['Refunded', 'Refunded by Patreon', 'Fraud']);

export function readFields(resource: Obj, included: Obj[]): FieldReading {
  const bad = (why: string): FieldReading => ({ malformed: why, paid: [], refunded: false, allowance: false, trial: false, autoRenew: false, userId: null });
  const a = resource?.attributes ?? {};
  const r = resource?.relationships ?? {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(a, k);
  const entitled = r.currently_entitled_tiers?.data;
  if (!r.currently_entitled_tiers || !Array.isArray(entitled)) return bad('currently_entitled_tiers');
  const tiers: string[] = [];
  for (const t of entitled) {
    const obj = included.find(o => o.type === 'tier' && String(o.id) === String(t.id));
    if (!obj) return bad('tier object');
    const cents = obj.attributes?.amount_cents;
    if (!Number.isInteger(cents) || cents < 0) return bad('amount_cents');
    if (cents > 0) tiers.push(String(t.id));
  }
  for (const k of ['is_free_trial', 'campaign_lifetime_support_cents', 'last_charge_status', 'is_gifted', 'last_charge_date', 'patron_status']) if (!has(k)) return bad(k);
  const status = a.last_charge_status;
  if (status !== null && !(CHARGE_STATUSES as readonly string[]).includes(status)) return bad('last_charge_status');
  const lifetime = a.campaign_lifetime_support_cents;
  if (lifetime !== null && (!Number.isInteger(lifetime) || lifetime < 0)) return bad('campaign_lifetime_support_cents');
  if (a.is_free_trial !== null && typeof a.is_free_trial !== 'boolean') return bad('is_free_trial');
  if (a.is_gifted !== null && typeof a.is_gifted !== 'boolean') return bad('is_gifted');
  if (a.last_charge_date !== null && (typeof a.last_charge_date !== 'string' || Number.isNaN(Date.parse(a.last_charge_date)))) return bad('last_charge_date');
  if (a.patron_status !== null && !['active_patron', 'declined_patron', 'former_patron'].includes(a.patron_status)) return bad('patron_status');
  const refunded = status !== null && ENDS.has(status);
  const gift = a.is_gifted === true && a.last_charge_date === null;
  const allowance = (status !== null && INSTALLS.has(status)) || gift;
  const trial = (a.is_free_trial === true || a.is_free_trial === null) && (lifetime ?? 0) === 0 && !allowance;
  const userData = r.user?.data;
  return {
    malformed: null,
    paid: refunded ? [] : tiers,
    refunded,
    allowance,
    trial,
    autoRenew: a.patron_status === 'active_patron',
    userId: userData && typeof userData.id === 'string' ? userData.id : null,
  };
}
