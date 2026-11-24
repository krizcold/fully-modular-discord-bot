/**
 * PatreonProvider - Patreon pledges linked to a Discord user, then to the holder that user picks (sheet P7).
 *
 * The member links their Patreon account on the bot's site; the link names the holder (`user:<id>` or a server the
 * member owns). The tier comes from the member's paid Patreon tiers, read from Patreon through THE FIELD RULE: a
 * delivery is a doorbell that makes the bot read the member, every member read is read once more W later, and an
 * hourly round reads the campaign's members. A record ends only on evidence about that one pledge: a member read
 * showing its tier unpaid, two 404s an hour apart, or the link no longer naming its holder.
 *
 * Configuration: PATREON_CLIENT_ID, PATREON_CLIENT_SECRET, PATREON_CAMPAIGN_ID, PATREON_CREATOR_ACCESS_TOKEN and
 * WEBUI_BASE_URL; PATREON_WEBHOOK_SECRET turns deliveries on.
 */

import * as crypto from 'crypto';
import { PROVIDER_FETCH_MS } from './paymentTypes';
import { providerCredentials, providerCredentialsUnread } from '@/utils/envLoader';
import { getPaymentRegistry } from './paymentRegistry';
import { holderWords, parseHolder, type HolderKey } from '../premiumHolder';
import { isMaintenanceGateClosed, orderRefusesSharedOps, outsideEntitlementEvent, runAcceptedOp } from '../maintenanceGate';
import { currentLedger, outsideLedgers } from '../dataBackends/writeLedger';
import { getPremiumManager } from '../premiumManager';
import type {
  PaymentProvider,
  ProviderCapabilities,
  ProviderSubscriptionState,
  InitiateOpts,
  InitiateResult,
  OfferingVariant,
  CredentialFieldDef,
  FollowAnswer,
} from './paymentTypes';

const PT2 = 'Patreon pledges are made on Patreon. The member links their Patreon account on this site, and the tier their pledge pays for follows.';
const PT11 = 'Patreon manages this subscription, so the bot cannot end or remove it. It ends when Patreon no longer shows its tier as paid, or when the member who linked it unlinks their Patreon account or moves it to another server or to their own VIP.';
const PT12 = 'The bot cannot pause a Patreon pledge, so Patreon keeps charging it; if you no longer want it, end the pledge on patreon.com.';
const PT13 = 'Patreon webhooks are not set up on this bot (no webhook secret is saved); nothing was applied.';
const PT14 = "The Patreon delivery's signature does not match the saved webhook secret; nothing was applied.";

const CAPABILITIES: ProviderCapabilities = {
  canInitiatePurchase: false,
  supportsCancel: false,
  supportsReactivate: false,
  supportsCoupons: false,
  supportsPause: false,
  supportsMultipleVariants: true,
  supportsProductMode: false,
  supportsHostedPicker: false,
  supportsCustomerPortal: false,
  supportsAnnualBilling: true,
  supportsPriceMigration: false,
  mechanism: 'oauth_link',
  variantIdLabel: 'Patreon Tier ID (e.g. "tier:12345")',
  productIdLabel: '',
  sells: ['guild', 'user'],
  endedByProviderOnly: true,
  endedByProviderText: PT11,
  variantNotSoldText: 'The member ends the pledge on patreon.com.',
  billedWhileQueued: true,
  queuedBilledText: PT12,
};

const VARIANT_PREFIX = 'tier:';
const PATREON_API = 'https://www.patreon.com/api/oauth2/v2';
const PATREON_TOKEN = 'https://www.patreon.com/api/oauth2/token';
const PATREON_AUTHORIZE = 'https://www.patreon.com/oauth2/authorize';
const CALLBACK_PATH = '/guild/api/subscriptions/patreon/callback';
/** How long a started link may take to come back from Patreon. */
const LINK_TTL_MS = 10 * 60_000;
/** The callback reads the member only when its budget leaves at least this much. */
const LINK_READ_MIN_MS = 1_000;

/** THE LAG RULE's window, and the delay of THE RE-READ RULE. */
const LAG_MS = 10 * 60_000;
const ROUND_DELAY_MS = 30_000;
const HOURLY_MS = 60 * 60_000;
/** The next round after one that was skipped or stopped for maintenance or an order. */
const RETRY_MS = 5 * 60_000;
const ROUND_BUDGET_MS = 5 * 60_000;
const LIST_BUDGET_MS = 3 * 60_000;
const PAGE_CAP = 100;
const PAGE_COUNT = 1000;
/** The 404 guard's condition (c): the first 404 at a round at least this much earlier. */
const NOT_FOUND_GAP_MS = 60 * 60_000;
/** A delivery's op reads within this budget (D18). */
const DELIVERY_BUDGET_MS = 5_000;
/** Creator-token calls per minute in this process (Patreon allows 100 per token, C-i). */
const CALLS_PER_MINUTE = 80;
/** Re-reads due within this much of a firing timer run in its batch, behind its one step 0. */
const REREAD_GATHER_MS = 5_000;
/** How long a read waits for premium to finish the installs it handed over before it judges a holder move. */
const INSTALL_WAIT_MS = 30_000;
/** A call waiting on the limiter looks at the gate and the order this often, so an order waits for at most one call. */
const LIMIT_POLL_MS = 1_000;

const MEMBER_FIELDS = 'patron_status,is_free_trial,is_gifted,campaign_lifetime_support_cents,last_charge_status,last_charge_date';
const MEMBER_PATH = (id: string) => `/members/${encodeURIComponent(id)}?include=currently_entitled_tiers,user,campaign&fields[member]=${MEMBER_FIELDS}&fields[tier]=amount_cents,title`;
const LIST_PATH = (campaign: string) => `/campaigns/${encodeURIComponent(campaign)}/members?include=currently_entitled_tiers,user&fields[member]=${MEMBER_FIELDS}&fields[tier]=amount_cents&page[count]=${PAGE_COUNT}`;
const CAMPAIGNS_PATH = '/campaigns?fields[campaign]=created_at';

/** PledgeEvent's payment_status values (THE FIELD RULE, R18). */
const CHARGE_STATUSES = new Set(['Paid', 'Declined', 'Deleted', 'Pending', 'Refunded', 'Fraud', 'Refunded by Patreon', 'Other', 'Partially Refunded', 'Free Trial', 'Refund Pending', 'Refund Declined']);
/** A charge paid and kept, in whole or in part: the member's paid tiers may install (E15). */
const CHARGE_ALLOWS = new Set(['Paid', 'Partially Refunded', 'Refund Declined']);
/** A refund or fraud: the member has no paid tiers (E9). */
const CHARGE_ENDS = new Set(['Refunded', 'Refunded by Patreon', 'Fraud']);
const PATRON_STATUSES = new Set(['active_patron', 'declined_patron', 'former_patron']);

type Obj = Record<string, any>;

/** A member resource read through THE FIELD RULE. */
interface Reading {
  memberId: string;
  /** The member's Patreon user; null when Patreon shows none (masked or absent). */
  user: string | null;
  /** The member's campaign (the member read only). */
  campaignId: string | null;
  /** The entitled tiers that are paid (none after a refund or fraud). */
  paid: string[];
  /** Patreon's title of each entitled tier, when the request asked for it. */
  titles: Record<string, string>;
  allowance: boolean;
  trial: boolean;
  autoRenew: boolean;
  patronStatus: string | null;
  /** The entitled tiers and the trial and charge fields, for `quiet`. */
  signature: string;
}

/** THE FIELD RULE: the reading of a member resource, or why it is malformed. */
function readMember(resource: unknown, included: unknown, withCampaign: boolean): Reading | { malformed: string } {
  const bad = (why: string) => ({ malformed: why });
  if (!resource || typeof resource !== 'object') return bad('no member');
  const r = resource as Obj;
  if (r.type !== 'member' || (typeof r.id !== 'string' && typeof r.id !== 'number')) return bad('no member');
  const a: Obj = r.attributes && typeof r.attributes === 'object' ? r.attributes : {};
  const rel: Obj = r.relationships && typeof r.relationships === 'object' ? r.relationships : {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(a, key);
  const objects: Obj[] = Array.isArray(included) ? included.filter(o => o && typeof o === 'object') : [];

  const entitled = rel.currently_entitled_tiers?.data;
  if (!Array.isArray(entitled)) return bad('currently_entitled_tiers');
  const tiers: string[] = [];
  const entitledIds: string[] = [];
  const titles: Record<string, string> = {};
  for (const t of entitled) {
    if (!t || (typeof t.id !== 'string' && typeof t.id !== 'number')) return bad('currently_entitled_tiers');
    const id = String(t.id);
    entitledIds.push(id);
    const tier = objects.find(o => o.type === 'tier' && String(o.id) === id);
    if (!tier) return bad(`tier ${id} has no tier object`);
    const cents = tier.attributes?.amount_cents;
    if (!Number.isInteger(cents) || cents < 0) return bad('amount_cents');
    if (cents > 0) tiers.push(id);
    titles[id] = typeof tier.attributes?.title === 'string' && tier.attributes.title ? tier.attributes.title : id;
  }
  for (const key of ['is_free_trial', 'campaign_lifetime_support_cents', 'last_charge_status', 'is_gifted', 'last_charge_date', 'patron_status']) {
    if (!has(key)) return bad(key);
  }
  const freeTrial = a.is_free_trial;
  if (freeTrial !== null && typeof freeTrial !== 'boolean') return bad('is_free_trial');
  const lifetime = a.campaign_lifetime_support_cents;
  if (lifetime !== null && (!Number.isInteger(lifetime) || lifetime < 0)) return bad('campaign_lifetime_support_cents');
  const charge = a.last_charge_status;
  if (charge !== null && !CHARGE_STATUSES.has(charge)) return bad('last_charge_status');
  const gifted = a.is_gifted;
  if (gifted !== null && typeof gifted !== 'boolean') return bad('is_gifted');
  const chargedAt = a.last_charge_date;
  if (chargedAt !== null && (typeof chargedAt !== 'string' || Number.isNaN(Date.parse(chargedAt)))) return bad('last_charge_date');
  const status = a.patron_status;
  if (status !== null && !PATRON_STATUSES.has(status)) return bad('patron_status');

  let user: string | null = null;
  if (rel.user !== undefined) {
    const data = rel.user?.data;
    if (data !== null && data !== undefined) {
      if (typeof data !== 'object' || (typeof data.id !== 'string' && typeof data.id !== 'number')) return bad('user');
      user = String(data.id);
    }
  }
  let campaignId: string | null = null;
  if (withCampaign) {
    const data = rel.campaign?.data;
    if (!data || (typeof data.id !== 'string' && typeof data.id !== 'number')) return bad('campaign');
    campaignId = String(data.id);
  }

  const refunded = charge !== null && CHARGE_ENDS.has(charge);
  const allowance = (charge !== null && CHARGE_ALLOWS.has(charge)) || (gifted === true && chargedAt === null);
  const trial = (freeTrial === true || freeTrial === null) && (lifetime ?? 0) === 0 && !allowance;
  return {
    memberId: String(r.id),
    user,
    campaignId,
    paid: refunded ? [] : tiers,
    titles,
    allowance,
    trial,
    autoRenew: status === 'active_patron',
    patronStatus: status,
    signature: JSON.stringify([[...entitledIds].sort(), freeTrial, lifetime, charge, gifted, chargedAt]),
  };
}

/** One GET's outcome: Patreon's status and body, or why there was none. */
type Answer = { status: number; body: unknown } | { failed: string };

/** A Patreon record premium holds, as the rounds read it. */
interface HeldRecord { holder: HolderKey; sub: Obj; location: 'active' | 'paused'; memberId: string; tier: string; user: string }

/** How one read of a member ended. */
type ReadOutcome =
  | { kind: 'applied'; deferred: boolean; ended: boolean; installed: number; paid: Array<{ ptier: string; title: string }>; trial: boolean; uncharged: string[] }
  | { kind: 'dropped' }
  | { kind: 'mismatch' }
  | { kind: 'not-found' }
  | { kind: 'failed'; reason: string; rearm: 'lag' | 'after401' | 'none' };

type StopCause = 'maintenance' | 'order' | 'budget';

/** The state the start route signs: the session's Discord user, the holder picked, the nonce, the expiry (ms). */
export interface LinkState { u: string; h: HolderKey; n: string; x: number }

/** What the callback's `/identity` read proved: the Patreon user, its member of the configured campaign, and the holder. */
export interface LinkIdentity {
  patreonUserId: string;
  memberId: string | null;
  holder: HolderKey;
  /** found: a member of the campaign; none: no membership at all; other-campaign: only other campaigns'; unreadable. */
  membership: 'found' | 'none' | 'other-campaign' | 'unreadable';
}

/**
 * The callback's member read: what it showed, or why there is none; recheck: a re-read is armed W later; uncharged: the
 * paid tiers set up for the holder that no install was handed for because no charge gives the install allowance yet
 * (E10).
 */
export type LinkRead =
  | { kind: 'applied'; deferred: boolean; paid: Array<{ ptier: string; title: string }>; trial: boolean; recheck: boolean; uncharged: string[] }
  | { kind: 'failed'; reason: string; recheck: boolean };

/** Discord's answer about a server's owner (4.3). */
export type OwnerAnswer =
  | { kind: 'owner'; name: string }
  | { kind: 'not-owner' }
  | { kind: 'not-visible' }
  | { kind: 'cant-confirm'; reason: string };

/** The part of a discord.js client the owner check uses. */
interface GuildClient { guilds: { fetch(opts: { guild: string; force: boolean }): Promise<unknown> } }

/** Work stopped by the gate, an order or the budget; the callback's op answers the first two with the maintenance text. */
export class WorkStop extends Error {
  constructor(readonly cause: StopCause) {
    super(cause);
  }
}

const STOP_WORDS: Record<StopCause, string> = {
  maintenance: 'the bot entered maintenance',
  order: 'a save order holds',
  budget: 'it ran for 5 minutes',
};

/** Where a read runs: its budget, the token it calls with, and what it is for. */
interface Ctx {
  source: 'delivery' | 'link' | 'round' | 'reread';
  /** When its budget ends; null for none. */
  deadline: number | null;
  token: string;
  campaignId: string;
}

/** One round: the credentials it read at its start, and what its calls proved and did. */
interface Round extends Ctx {
  startedAt: number;
  /** Step 0 listed the configured campaign with this token (the 404 guard's (a)). */
  step0Ok: boolean;
  /** 3a or 3b ended a record: one more round 30 seconds after this one. */
  endedByRead: boolean;
}

/** A list entry step 1 saw, and when its page was asked for. */
interface Seen { reading: Reading; pageAt: number }

/** How a holder move's install came out: held at the new holder, refused for a reason no read changes, or kept. */
type MoveOutcome = 'held' | 'final' | 'keep';

type TimerKind = 'first' | 'post' | 'retry' | 'after';

const isoOf = (ms: number): string => new Date(ms).toISOString();

const failureOf = (answer: Answer): string | null => ('failed' in answer
  ? answer.failed
  : answer.status < 200 || answer.status >= 300 ? `Patreon answered ${answer.status}` : null);

/** A Patreon record's providerSubId, `patreon:<memberId>:<patreonTierId>`, as its parts; null for another shape. */
function idParts(providerSubId: unknown): { memberId: string; tier: string } | null {
  const parts = String(providerSubId ?? '').split(':');
  if (parts.length !== 3 || parts[0] !== 'patreon' || !parts[1] || !parts[2]) return null;
  return { memberId: parts[1], tier: parts[2] };
}

const premium = (): any => getPremiumManager();

/** Waits for the promise until the deadline; false when the deadline came first. */
async function within<T>(work: Promise<T>, deadline: number | null): Promise<{ done: true; value: T } | { done: false }> {
  if (deadline === null) return { done: true, value: await work };
  const left = deadline - Date.now();
  if (left <= 0) return { done: false };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<{ done: false }>(resolve => {
    timer = setTimeout(() => resolve({ done: false }), left);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([work.then(value => ({ done: true as const, value })), late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const sleep = (ms: number): Promise<void> => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, Math.max(0, ms));
  (timer as { unref?: () => void }).unref?.();
});

export class PatreonProvider implements PaymentProvider {
  readonly id = 'patreon';
  readonly displayName = 'Patreon';
  readonly capabilities = CAPABILITIES;

  /** THE LAG RULE: per member and tier, whether a read last applied it paid or unpaid, and when. */
  private readonly recent = new Map<string, { paid: boolean; at: number }>();
  /** When the latest applied read of each member started. */
  private readonly appliedStart = new Map<string, number>();
  /** Per member, the handling in progress (reads, emits and moves of one member never interleave). */
  private readonly chains = new Map<string, Promise<void>>();
  /** The members a step 2 block queued whose last read installed nothing, with their list entry then. */
  private readonly quiet = new Map<string, string>();
  /** When a single read of each member was last tried in a round. */
  private readonly lastCheckedAt = new Map<string, number>();
  /** The 404 guard's (c): the round of a member's first 404 with no 2xx since, under the token it was read with. */
  private readonly first404 = new Map<string, { at: number; token: string }>();
  private readonly noUserLogged = new Set<string>();
  private readonly unfollowedLogged = new Set<string>();
  private otherCampaignLogged = false;
  private otherClientLogged = false;
  private tokenRefusedLogged = false;
  private client: GuildClient | null = null;

  /** The creator token's calls in the last minute, and until when a 429 holds every call. */
  private readonly callTimes: number[] = [];
  private heldUntil = 0;

  /** start() ran in this process: only then are rounds and re-reads armed. */
  private started = false;
  private readonly timers = new Map<TimerKind, ReturnType<typeof setTimeout>>();
  private hourly: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  /** A round came due while one ran: one more 30 seconds after it ends. */
  private again = false;
  /** THE RE-READ RULE: per member, the earliest due time, the latest one needed, and its timer. */
  private readonly rereads = new Map<string, { due: number; latest: number; timer: ReturnType<typeof setTimeout> }>();
  /** Members whose re-read met a 401: armed again W after a round's step 0 next passes. */
  private readonly rereadAfter401 = new Set<string>();
  private rereadRunning: Promise<void> | null = null;
  private rereadAgain = false;

  isConfigured(): boolean {
    const c = providerCredentials('patreon');
    return !!(c.PATREON_CLIENT_ID && c.PATREON_CLIENT_SECRET && c.PATREON_CAMPAIGN_ID && c.PATREON_CREATOR_ACCESS_TOKEN && c.WEBUI_BASE_URL);
  }

  getCredentialFields(): CredentialFieldDef[] {
    const base = providerCredentials('patreon').WEBUI_BASE_URL;
    return [
      {
        key: 'PATREON_CLIENT_ID',
        label: 'OAuth Client ID',
        type: 'text',
        placeholder: 'long alphanumeric string',
        helpText: 'patreon.com/portal - My Apps & Tools - your client. Required for the OAuth-link flow.',
      },
      {
        key: 'PATREON_CLIENT_SECRET',
        label: 'OAuth Client Secret',
        type: 'secret',
        helpText: 'Same Patreon page as Client ID. Used server-side to exchange the auth code for an access token.',
      },
      {
        key: 'PATREON_CAMPAIGN_ID',
        label: 'Campaign ID',
        type: 'text',
        placeholder: '12345',
        helpText: 'Numeric campaign id. Pinned to one campaign per bot.',
      },
      {
        key: 'PATREON_CREATOR_ACCESS_TOKEN',
        label: 'Creator Access Token',
        type: 'secret',
        helpText: "From Patreon's clients page (patreon.com/portal): the Creator's Access Token. The bot reads your campaign's members with it. When Patreon stops accepting it, the log says so; create a new one there and save it here.",
      },
      {
        key: 'PATREON_WEBHOOK_SECRET',
        label: 'Webhook Secret',
        type: 'secret',
        helpText: `Optional. The secret of a webhook you create on Patreon for ${base || "this Web UI's base URL"}/webhook/patreon with the members triggers. Without it the bot checks pledges hourly.`,
        optional: true,
      },
      {
        key: 'WEBUI_BASE_URL',
        label: 'Web UI Base URL',
        type: 'url',
        placeholder: 'https://your-bot.example.com',
        helpText: 'Public base URL of this Web UI. Used to build the OAuth redirect URI you must register in Patreon.',
        optional: true,
      },
    ];
  }

  async initiatePurchase(_opts: InitiateOpts): Promise<InitiateResult> {
    throw new Error(PT2);
  }

  // ---------------------------------------------------------------------------- the link (4.2, 4.3)

  /** The web UI's public base URL (WEBUI_BASE_URL), where the start and the callback routes live; null when unset. */
  linkBaseUrl(): string | null {
    const base = providerCredentials('patreon').WEBUI_BASE_URL;
    return typeof base === 'string' && base ? base.replace(/\/+$/, '') : null;
  }

  /**
   * The authorize URL for the signed-in Discord user and the holder they picked, with scope `identity` only, and the
   * nonce and expiry its state carries, which the start route keeps in that user's session.
   */
  linkStart(userId: string, holder: HolderKey, now = Date.now()): { url: string; nonce: string; expires: number } {
    const c = providerCredentials('patreon');
    const base = this.linkBaseUrl();
    if (!this.isConfigured() || !base) throw new Error('Patreon is not configured on this bot.');
    const nonce = crypto.randomBytes(16).toString('base64url');
    const expires = now + LINK_TTL_MS;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: c.PATREON_CLIENT_ID || '',
      redirect_uri: `${base}${CALLBACK_PATH}`,
      scope: 'identity',
      state: this.signState({ u: userId, h: holder, n: nonce, x: expires }),
    });
    return { url: `${PATREON_AUTHORIZE}?${params.toString()}`, nonce, expires };
  }

  /** The state's fields when the client secret signed it and its shape is the start route's; null otherwise. */
  readLinkState(state: unknown): LinkState | null {
    if (typeof state !== 'string') return null;
    let payload: Obj;
    try {
      payload = this.verifyState(state);
    } catch {
      return null;
    }
    const { u, h, n, x } = payload ?? {};
    if (typeof u !== 'string' || typeof h !== 'string' || typeof n !== 'string' || typeof x !== 'number' || !parseHolder(h)) return null;
    return { u, h: h as HolderKey, n, x };
  }

  /** Signed with the client secret: `<base64url(json)>.<base64url(hmac-sha256)>`, so changing any field breaks it. */
  private signState(payload: Record<string, unknown>): string {
    const secret = providerCredentials('patreon').PATREON_CLIENT_SECRET || '';
    const json = Buffer.from(JSON.stringify(payload), 'utf-8');
    const sig = crypto.createHmac('sha256', secret).update(json).digest();
    return `${json.toString('base64url')}.${sig.toString('base64url')}`;
  }

  private verifyState(state: string): Record<string, any> {
    const dot = state.indexOf('.');
    if (dot < 0) throw new Error('State is unsigned');
    const secret = providerCredentials('patreon').PATREON_CLIENT_SECRET || '';
    const json = Buffer.from(state.slice(0, dot), 'base64url');
    const expectedSig = crypto.createHmac('sha256', secret).update(json).digest();
    const providedSig = Buffer.from(state.slice(dot + 1), 'base64url');
    if (providedSig.length !== expectedSig.length || !crypto.timingSafeEqual(providedSig, expectedSig)) {
      throw new Error('State signature mismatch');
    }
    return JSON.parse(json.toString('utf-8'));
  }

  /** The bot's Discord client, which the owner check asks (4.3); null in a process without one. */
  setClient(client: unknown): void {
    this.client = client && typeof (client as { guilds?: { fetch?: unknown } }).guilds?.fetch === 'function' ? client as GuildClient : null;
  }

  /**
   * Whether Discord names `userId` as the server's owner now, asked through the bot's own client (a REST read that
   * works from any shard), within the deadline; the gate and the order are checked first.
   */
  async checkOwner(userId: string, guildId: string, deadline: number): Promise<OwnerAnswer> {
    this.checkGate();
    const client = this.client;
    if (!client) return { kind: 'cant-confirm', reason: 'this process has no Discord connection' };
    const bound = Math.min(deadline, Date.now() + PROVIDER_FETCH_MS);
    let answer;
    try {
      answer = await within(Promise.resolve(client.guilds.fetch({ guild: guildId, force: true })), bound);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 10004 || code === 50001) return { kind: 'not-visible' };
      return { kind: 'cant-confirm', reason: error instanceof Error ? error.message : String(error) };
    }
    if (!answer.done) return { kind: 'cant-confirm', reason: 'Discord did not answer in time' };
    const guild = answer.value as { ownerId?: unknown; name?: unknown } | null;
    if (!guild || typeof guild.ownerId !== 'string') return { kind: 'cant-confirm', reason: 'Discord named no owner' };
    if (guild.ownerId !== userId) return { kind: 'not-owner' };
    return { kind: 'owner', name: typeof guild.name === 'string' && guild.name ? guild.name : guildId };
  }

  async fetchVariant(variantId: string): Promise<OfferingVariant | null> {
    if (!variantId.startsWith(VARIANT_PREFIX)) return null;
    const tierId = variantId.slice(VARIANT_PREFIX.length);
    const c = providerCredentials('patreon');
    if (!c.PATREON_CAMPAIGN_ID || !c.PATREON_CREATOR_ACCESS_TOKEN) return null;
    if (!await this.acquire(null)) return null;
    const res = await fetch(`${PATREON_API}/campaigns/${encodeURIComponent(c.PATREON_CAMPAIGN_ID)}?include=tiers&fields[tier]=title,amount_cents,published`, {
      signal: AbortSignal.timeout(PROVIDER_FETCH_MS),
      method: 'GET',
      headers: { 'Authorization': `Bearer ${c.PATREON_CREATOR_ACCESS_TOKEN}` },
    });
    if (!res.ok) return null;
    const campaign: any = await res.json();
    const tier = (campaign?.included || [])
      .find((x: any) => x.type === 'tier' && x.id === tierId);
    if (!tier) return null;
    return {
      variantId,
      label: tier.attributes?.title || tierId,
      amount: tier.attributes?.amount_cents || 0,
      currency: 'USD',
      durationDays: 30,
      recurring: true,
      active: !!tier.attributes?.published,
    };
  }

  /** Patreon records follow the member's reads; premium's own reads of one subscription get nothing here. */
  async getSubscriptionState(_providerSubId: string): Promise<ProviderSubscriptionState | null> {
    return null;
  }

  /** A record is followed while Patreon is configured and the record names a member of the configured campaign (4.1). */
  followsSubscription(sub: { holder: HolderKey; providerMeta?: Record<string, any>; providerSubId?: string }): FollowAnswer {
    if (!this.isConfigured()) return { followed: false, whyNot: providerCredentialsUnread('patreon') === null ? 'not-configured' : 'unread' };
    const meta = sub.providerMeta;
    const campaign = String(providerCredentials('patreon').PATREON_CAMPAIGN_ID);
    const shaped = sub.providerSubId === undefined || idParts(sub.providerSubId) !== null;
    if (!shaped || typeof meta?.memberId !== 'string' || typeof meta?.patreonTierId !== 'string' || String(meta?.campaignId) !== campaign) {
      return { followed: false, whyNot: 'old-record' };
    }
    return { followed: true };
  }

  /**
   * The callback's Patreon half: the state checked again (signed, made for `userId`, not expired), the code exchanged
   * and `/identity` read with the patron's token, which is then dropped. It answers the Patreon user `/identity` proves,
   * the member of the configured campaign (null with none), and the holder the state names. Each call ends within
   * PROVIDER_FETCH_MS and the deadline; the gate and the order are checked before each.
   */
  async handleOAuthCallback(query: Record<string, string>, userId: string, opts: { deadline?: number } = {}): Promise<LinkIdentity> {
    const c = providerCredentials('patreon');
    const deadline = opts.deadline ?? null;
    if (!query?.code || !query?.state) throw new Error('Missing code or state in Patreon callback');
    const state = this.readLinkState(query.state);
    if (!state) throw new Error('Invalid state parameter: it was not signed by this bot');
    if (state.u !== userId) throw new Error('Invalid state parameter: it was started by another Discord account, so nothing was linked.');
    if (state.x <= Date.now()) throw new Error('Invalid state parameter: it expired, so nothing was linked. Start the link again.');

    const timeout = (): number => {
      const left = deadline === null ? PROVIDER_FETCH_MS : Math.min(PROVIDER_FETCH_MS, deadline - Date.now());
      if (left <= 0) throw new Error('Patreon did not answer within the time this link has, so nothing was linked. Start the link again.');
      return left;
    };
    this.checkGate();
    const tokenRes = await fetch(PATREON_TOKEN, {
      signal: AbortSignal.timeout(timeout()),
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: query.code,
        grant_type: 'authorization_code',
        client_id: c.PATREON_CLIENT_ID || '',
        client_secret: c.PATREON_CLIENT_SECRET || '',
        redirect_uri: `${this.linkBaseUrl() ?? ''}${CALLBACK_PATH}`,
      }),
    });
    if (!tokenRes.ok) throw new Error(`Patreon token exchange failed: ${tokenRes.status}`);
    const tokenJson: any = await tokenRes.json();

    this.checkGate();
    const identityRes = await fetch(`${PATREON_API}/identity?include=memberships,memberships.campaign&fields[member]=patron_status`, {
      signal: AbortSignal.timeout(timeout()),
      headers: { 'Authorization': `Bearer ${tokenJson?.access_token}` },
    });
    if (!identityRes.ok) throw new Error(`Patreon identity fetch failed: ${identityRes.status}`);
    const identity: any = await identityRes.json();

    const id = identity?.data?.id;
    if ((typeof id !== 'string' && typeof id !== 'number') || id === '') throw new Error('Patreon identity returned no user id');
    const patreonUserId = String(id);
    const base = { patreonUserId, holder: state.h };

    const listed = identity?.data?.relationships?.memberships?.data;
    if (!Array.isArray(listed)) return { ...base, memberId: null, membership: 'unreadable' };
    const objects: Obj[] = Array.isArray(identity?.included) ? identity.included : [];
    const campaign = String(c.PATREON_CAMPAIGN_ID ?? '');
    let found: string | null = null;
    const others = new Set<string>();
    for (const entry of listed) {
      const member = objects.find(o => o && o.type === 'member' && entry && String(o.id) === String(entry.id));
      const data = member?.relationships?.campaign?.data;
      if (!member || !data || (typeof data.id !== 'string' && typeof data.id !== 'number')) return { ...base, memberId: null, membership: 'unreadable' };
      if (String(data.id) === campaign) found ??= String(member.id);
      else others.add(String(data.id));
    }
    if (found !== null) return { ...base, memberId: found, membership: 'found' };
    if (others.size === 0) return { ...base, memberId: null, membership: 'none' };
    if (!this.otherClientLogged) {
      this.otherClientLogged = true;
      console.warn(`[PatreonProvider] A Patreon link showed memberships of campaign ${[...others].join(', ')} but none of campaign ${campaign}. Patreon shows a link only memberships of the OAuth client's own creator, so the client id and PATREON_CAMPAIGN_ID belong to different Patreon accounts. The bot cannot read a member's pledge when they link; rounds still install it within the hour.`);
    }
    return { ...base, memberId: null, membership: 'other-campaign' };
  }

  /**
   * The callback's member read once the link is saved (4.2 step 3): the member's re-read armed W later (THE RE-READ
   * RULE), then one read with the Patreon user `/identity` proved when the deadline leaves time for it.
   */
  async readAfterLink(memberId: string, patreonUserId: string, deadline: number): Promise<LinkRead> {
    const recheck = this.started;
    this.armReread(memberId, Date.now() + LAG_MS);
    const failed = (reason: string): LinkRead => {
      const next = recheck ? 'the bot reads it again within 10 minutes' : "the bot's next hourly check reads it";
      console.warn(`[PatreonProvider] Could not read member ${memberId} from Patreon after the link (${reason}); ${next}.`);
      return { kind: 'failed', reason, recheck };
    };
    if (deadline - Date.now() < LINK_READ_MIN_MS) return failed('the bot ran out of time to read your pledge');
    let outcome: ReadOutcome;
    try {
      outcome = await this.reconcileMember(memberId, patreonUserId, { deadline, source: 'link' });
    } catch (error) {
      if (!(error instanceof WorkStop)) return failed(error instanceof Error ? error.message : String(error));
      return failed(error.cause === 'budget' ? 'the bot ran out of time to read your pledge' : 'the bot stopped for maintenance');
    }
    if (outcome.kind === 'applied') return { kind: 'applied', deferred: outcome.deferred, paid: outcome.paid, trial: outcome.trial, recheck, uncharged: outcome.uncharged };
    if (outcome.kind === 'not-found') {
      this.armRound('post');
      return failed('Patreon did not find your membership');
    }
    if (outcome.kind === 'dropped') return failed('a newer read of your pledge was applied meanwhile');
    if (outcome.kind === 'mismatch') return failed("Patreon's answer did not match this account");
    return failed(outcome.reason);
  }

  // ---------------------------------------------------------------------------- deliveries (4.6)

  /** Patreon sends no event id (C-g), so the route keeps no delivery record; a repeat only causes a read. */
  webhookEventId(_rawBody: Buffer, _headers: Record<string, string>): string | null {
    return null;
  }

  /**
   * A delivery: the signature checked, then each member it names read from Patreon within the op's 5 s budget, a
   * round 30 seconds later for the members that did not fit, and every member read once more W later. The body itself
   * is never applied.
   */
  async handleWebhook(rawBody: Buffer, signature: string, headers: Record<string, string>): Promise<void> {
    const creds = providerCredentials('patreon');
    const secret = creds.PATREON_WEBHOOK_SECRET;
    if (!secret) throw new Error(PT13);
    const given = String(headers['x-patreon-signature'] || signature || '').toLowerCase();
    const expected = crypto.createHmac('md5', secret).update(rawBody).digest('hex').toLowerCase();
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error(PT14);
    const deadline = Date.now() + DELIVERY_BUDGET_MS;

    let body: any;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      this.armRound('post');
      return;
    }
    const resources: any[] = Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
    const named: Array<{ id: string; hint: string | null | undefined }> = [];
    for (const res of resources) {
      if (!res || res.type !== 'member' || (typeof res.id !== 'string' && typeof res.id !== 'number')) continue;
      const rel = res.relationships?.user;
      const hint = rel === undefined || rel === null ? undefined : rel.data === null || rel.data === undefined ? null : rel.data.id === undefined ? null : String(rel.data.id);
      if (!named.some(n => n.id === String(res.id))) named.push({ id: String(res.id), hint });
    }
    if (named.length === 0 || !this.isConfigured()) return;

    const heldMembers = new Set(this.followedRecords().map(r => r.memberId));
    const toRead = named.filter(n => !(typeof n.hint === 'string' && !premium().getAccountLink(this.id, n.hint) && !heldMembers.has(n.id)));
    for (const n of toRead) this.armReread(n.id, Date.now() + LAG_MS);
    const ctx: Ctx = { source: 'delivery', deadline, token: String(creds.PATREON_CREATOR_ACCESS_TOKEN), campaignId: String(creds.PATREON_CAMPAIGN_ID) };
    let notRead = false;
    for (const [index, n] of toRead.entries()) {
      if (Date.now() >= deadline || isMaintenanceGateClosed() || orderRefusesSharedOps()) {
        notRead = index < toRead.length;
        break;
      }
      let outcome: ReadOutcome;
      try {
        outcome = await this.reconcile(n.id, undefined, ctx);
      } catch (error) {
        if (!(error instanceof WorkStop)) throw error;
        notRead = true;
        break;
      }
      if (outcome.kind === 'not-found') this.armRound('post');
      if (outcome.kind === 'failed') {
        const next = this.started ? 'the bot reads it again within 10 minutes' : "the bot's next hourly check reads it";
        console.warn(`[PatreonProvider] Could not read member ${n.id} from Patreon after a delivery (${outcome.reason}); ${next}.`);
      }
    }
    if (notRead) this.armRound('post');
  }

  // ---------------------------------------------------------------------------- one member (4.5)

  /**
   * One read of the member, applied: the part 3 callback passes the Patreon user `/identity` proved (provenUser) and
   * its budget's end.
   */
  reconcileMember(memberId: string, provenUser?: string, opts: { deadline?: number; source?: 'delivery' | 'link' } = {}): Promise<ReadOutcome> {
    const creds = providerCredentials('patreon');
    return this.reconcile(memberId, provenUser, {
      source: opts.source ?? 'link',
      deadline: opts.deadline ?? null,
      token: String(creds.PATREON_CREATOR_ACCESS_TOKEN ?? ''),
      campaignId: String(creds.PATREON_CAMPAIGN_ID ?? ''),
    });
  }

  /** Runs fn in the member's chain, its wait for the chain raced against the deadline. */
  private async inChain<T>(memberId: string, deadline: number | null, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    const before = this.chains.get(memberId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>(resolve => { release = resolve; });
    const tail = before.then(() => mine);
    this.chains.set(memberId, tail);
    try {
      const waited = await within(before, deadline);
      if (!waited.done) return { ran: false };
      return { ran: true, value: await fn() };
    } finally {
      release();
      void tail.then(() => {
        if (this.chains.get(memberId) === tail) this.chains.delete(memberId);
      });
    }
  }

  private async reconcile(memberId: string, provenUser: string | undefined, ctx: Ctx): Promise<ReadOutcome> {
    const run = await this.inChain(memberId, ctx.deadline, async (): Promise<ReadOutcome> => {
      this.check(ctx);
      const readStart = Date.now();
      const answer = await this.call(ctx, MEMBER_PATH(memberId));
      if ('failed' in answer) return { kind: 'failed', reason: answer.failed, rearm: 'lag' };
      if (answer.status >= 200 && answer.status < 300) this.first404.delete(memberId);
      if (answer.status === 404) return { kind: 'not-found' };
      if (answer.status === 401) {
        this.logTokenRefused();
        return { kind: 'failed', reason: 'Patreon answered 401', rearm: 'after401' };
      }
      if (answer.status === 429 || answer.status >= 500) return { kind: 'failed', reason: `Patreon answered ${answer.status}`, rearm: 'lag' };
      if (answer.status < 200 || answer.status >= 300) return { kind: 'failed', reason: `Patreon answered ${answer.status}`, rearm: 'none' };
      const body = answer.body as Obj | null;
      const reading = readMember(body?.data, body?.included, true);
      if ('malformed' in reading) return { kind: 'failed', reason: `the answer was malformed (${reading.malformed})`, rearm: 'none' };
      if (reading.memberId !== memberId) return { kind: 'failed', reason: 'the answer was another member', rearm: 'none' };
      if ((this.appliedStart.get(memberId) ?? -Infinity) > readStart) return { kind: 'dropped' };
      return this.apply(reading, readStart, provenUser, ctx);
    });
    if (!run.ran) return { kind: 'failed', reason: 'the bot was still handling this member when its time ran out', rearm: 'lag' };
    return run.value;
  }

  /** The read's changes in 4.5's order, in the member's chain; the link is read after the read answered. */
  private async apply(reading: Reading, readStart: number, provenUser: string | undefined, ctx: Ctx): Promise<ReadOutcome> {
    const m = reading.memberId;
    if (reading.campaignId !== ctx.campaignId) {
      console.warn(`[PatreonProvider] Patreon member ${m} belongs to campaign ${reading.campaignId}, not to what the bot holds for it; no change was made. Check the stored record.`);
      return { kind: 'mismatch' };
    }
    const held = this.followedRecords().filter(r => r.memberId === m);
    const heldUsers = new Set(held.map(r => r.user));
    if (reading.user !== null && ((heldUsers.size > 0 && !heldUsers.has(reading.user)) || (provenUser !== undefined && provenUser !== reading.user))) {
      console.warn(`[PatreonProvider] Patreon member ${m} belongs to Patreon user ${reading.user}, not to what the bot holds for it; no change was made. Check the stored record.`);
      return { kind: 'mismatch' };
    }
    const user = reading.user ?? provenUser ?? held[0]?.user ?? null;
    if (user === null) {
      if (!this.noUserLogged.has(m)) {
        this.noUserLogged.add(m);
        console.warn(`[PatreonProvider] Patreon member ${m} shows no Patreon user and no stored record names one, so the bot cannot match it to a link. Its pledge gives nothing until the member links again.`);
      }
      return { kind: 'mismatch' };
    }
    const now = Date.now();
    this.pruneLag(now);
    this.appliedStart.set(m, readStart);
    const heldTiers = new Set(held.map(r => r.tier));
    const link = this.linkOf(user);
    const targets = link ? reading.paid : [];
    const reversed = new Set<string>();
    for (const t of new Set([...reading.paid, ...heldTiers])) {
      const last = this.recent.get(`${m}:${t}`);
      if (last && now - last.at < LAG_MS && last.paid !== reading.paid.includes(t)) reversed.add(t);
    }
    const deferred = reversed.size > 0;
    const moves = link !== null && held.some(r => r.holder !== link.holder);
    const meta = (t: string) => ({ patreonUserId: user, memberId: m, campaignId: ctx.campaignId, patreonTierId: t, patronStatus: reading.patronStatus });
    let ended = false;

    if (!deferred) {
      for (const rec of held) {
        if (targets.includes(rec.tier)) continue;
        this.check(ctx);
        this.emitState('subscription.expired', rec.holder, m, rec.tier, { status: 'expired', startDate: '', endDate: isoOf(Date.now()), autoRenew: reading.autoRenew, meta: meta(rec.tier) });
        if (!reading.paid.includes(rec.tier)) this.recent.set(`${m}:${rec.tier}`, { paid: false, at: now });
        ended = true;
      }
    }
    const installed = new Set<string>();
    const uncharged: string[] = [];
    if (link) {
      for (const t of targets) {
        if (held.some(r => r.holder === link.holder && r.tier === t)) continue;
        if ((deferred && !moves) || reversed.has(t) || reading.trial) continue;
        if (!(reading.allowance || heldTiers.has(t))) {
          if (this.installRule(link.holder, t) === 'open') uncharged.push(t);
          continue;
        }
        this.check(ctx);
        this.emitCreated(link.holder, link.buyerId, m, t, { status: 'active', startDate: '', endDate: null, autoRenew: reading.autoRenew, meta: meta(t) });
        this.recent.set(`${m}:${t}`, { paid: true, at: now });
        installed.add(t);
      }
      const moving = held.filter(r => r.holder !== link.holder && targets.includes(r.tier) && !reversed.has(r.tier));
      if (moving.length > 0) ended = await this.endMoved(moving, link.holder, user, installed, ctx, rec => meta(rec.tier), reading.autoRenew) || ended;
      if (!deferred) {
        for (const rec of held) {
          if (rec.holder !== link.holder || !targets.includes(rec.tier)) continue;
          if (rec.sub.autoRenew === reading.autoRenew && rec.sub.providerMeta?.patronStatus === reading.patronStatus && rec.sub.providerMeta?.patreonUserId === user) continue;
          this.check(ctx);
          this.emitState('subscription.updated', rec.holder, m, rec.tier, { status: 'active', startDate: '', endDate: null, autoRenew: reading.autoRenew, meta: meta(rec.tier) });
        }
      }
    }
    if (deferred && this.started) this.armReread(m, Date.now() + LAG_MS);
    const paid = reading.paid.map(ptier => ({ ptier, title: reading.titles[ptier] ?? ptier }));
    return { kind: 'applied', deferred, ended, installed: installed.size, paid, trial: reading.trial, uncharged };
  }

  /**
   * A holder move (E16): each record at another holder ends once its tier is held at the link's holder, or premium
   * refused that install for a reason no read changes, or no install was handed over; a refused save keeps it.
   */
  private async endMoved(moving: HeldRecord[], to: HolderKey, user: string, installed: Set<string>, ctx: Ctx, metaOf: (rec: HeldRecord) => Obj, autoRenew: boolean): Promise<boolean> {
    const outcomes = await this.moveOutcomes(to, moving[0].memberId, [...new Set(moving.map(r => r.tier))], installed, ctx);
    if (this.linkOf(user)?.holder !== to) return false;
    let ended = false;
    for (const rec of moving) {
      if (outcomes.get(rec.tier) === 'keep') continue;
      this.check(ctx);
      this.emitState('subscription.expired', rec.holder, rec.memberId, rec.tier, { status: 'expired', startDate: '', endDate: isoOf(Date.now()), autoRenew, meta: metaOf(rec) });
      console.warn(`[PatreonProvider] ${holderWords(rec.holder)} held a Patreon record of Patreon user ${user}, whose link no longer points there; it was handed to premium as ended.`);
      ended = true;
    }
    return ended;
  }

  /** How the installs at `to` came out for each tier, after premium finished the ones handed over. */
  private async moveOutcomes(to: HolderKey, memberId: string, tiers: string[], installed: Set<string>, ctx: Ctx): Promise<Map<string, MoveOutcome>> {
    if (tiers.some(t => installed.has(t))) {
      const bound = Math.min(ctx.deadline ?? Infinity, Date.now() + INSTALL_WAIT_MS);
      const waited = await within(Promise.resolve(premium().settled(currentLedger())), bound);
      if (!waited.done) return new Map(tiers.map(t => [t, installed.has(t) ? 'keep' : 'final']));
    }
    const out = new Map<string, MoveOutcome>();
    for (const t of tiers) {
      if (this.heldAt(to, memberId, t)) out.set(t, 'held');
      else if (!installed.has(t) || this.refusedForGood(to, t)) out.set(t, 'final');
      else out.set(t, 'keep');
    }
    return out;
  }

  /** Whether premium refuses an install of the tier at the holder whatever a read shows: PD3 or PD14 (E16). */
  private refusedForGood(holder: HolderKey, ptier: string): boolean {
    return this.installRule(holder, ptier) === 'refused';
  }

  /** How premium meets an install of the tier at the holder: refused (PD3, PD14), sold by several offerings (PD4), or open. */
  private installRule(holder: HolderKey, ptier: string): 'refused' | 'several' | 'open' {
    const kind = parseHolder(holder)?.kind;
    if (!kind) return 'refused';
    const variant = `${VARIANT_PREFIX}${ptier}`;
    const tiers = premium().getAllTiers(kind) as Record<string, Obj>;
    const selling: Array<{ priority: number }> = [];
    for (const tier of Object.values(tiers)) {
      for (const offering of tier.offerings ?? []) {
        const sells = (offering.providerLinks ?? []).some((l: Obj) => l.providerId === this.id && l.enabled && (l.mode === 'product'
          ? (l.cache?.variants ?? []).some((v: Obj) => v.variantId === variant && v.active)
          : (l.priceConfig?.entries ?? []).some((e: Obj) => e.variantId === variant)));
        if (sells) selling.push({ priority: tier.priority ?? 0 });
      }
    }
    if (selling.length === 0) return 'refused';
    if (selling.length > 1) return 'several';
    const record = premium().getAllSubscriptions()[holder] as { active?: Obj; paused?: Obj[] } | undefined;
    const atPriority = (s: Obj | undefined, status: string): boolean => !!s && s.status === status
      && (s.endDate === null || Date.parse(s.endDate) > Date.now())
      && (tiers[s.tierId]?.priority ?? 0) === selling[0].priority;
    return atPriority(record?.active, 'active') || (record?.paused ?? []).some(p => atPriority(p, 'paused')) ? 'refused' : 'open';
  }

  private heldAt(holder: HolderKey, memberId: string, ptier: string): boolean {
    const record = premium().getAllSubscriptions()[holder] as { active?: Obj; paused?: Obj[] } | undefined;
    const id = `patreon:${memberId}:${ptier}`;
    return record?.active?.providerSubId === id || (record?.paused ?? []).some(p => p.providerSubId === id);
  }

  private linkOf(user: string): { holder: HolderKey; buyerId: string } | null {
    const link = premium().getAccountLink(this.id, user) as { holder: HolderKey; buyerId: string } | undefined;
    return link && parseHolder(link.holder) ? link : null;
  }

  /** The followed Patreon records premium holds, active and queued, in premium's stored order. */
  private followedRecords(): HeldRecord[] {
    const campaign = String(providerCredentials('patreon').PATREON_CAMPAIGN_ID ?? '');
    const found: HeldRecord[] = [];
    for (const [holder, record] of Object.entries(premium().getAllSubscriptions() as Record<string, { active?: Obj; paused?: Obj[] }>)) {
      const parsed = parseHolder(holder);
      if (!parsed) continue;
      const subs: Array<[Obj | undefined, 'active' | 'paused']> = [[record.active, 'active'], ...(record.paused ?? []).map(p => [p, 'paused'] as [Obj, 'paused'])];
      for (const [sub, location] of subs) {
        if (!sub || sub.providerId !== this.id || sub.source !== 'paid') continue;
        const parts = idParts(sub.providerSubId);
        const meta = sub.providerMeta;
        if (!parts || typeof meta?.memberId !== 'string' || String(meta?.campaignId) !== campaign || meta.memberId !== parts.memberId) continue;
        found.push({ holder: parsed.key, sub, location, memberId: parts.memberId, tier: parts.tier, user: String(meta.patreonUserId ?? '') });
      }
    }
    return found;
  }

  /** The Patreon records premium holds that no round follows. */
  private unfollowedRecords(): Array<{ holder: HolderKey; id: string }> {
    const followed = new Set(this.followedRecords().map(r => `${r.holder} ${r.sub.id}`));
    const found: Array<{ holder: HolderKey; id: string }> = [];
    for (const [holder, record] of Object.entries(premium().getAllSubscriptions() as Record<string, { active?: Obj; paused?: Obj[] }>)) {
      const parsed = parseHolder(holder);
      if (!parsed) continue;
      for (const sub of [record.active, ...(record.paused ?? [])]) {
        if (!sub || sub.providerId !== this.id || sub.source !== 'paid' || followed.has(`${parsed.key} ${sub.id}`)) continue;
        found.push({ holder: parsed.key, id: String(sub.providerSubId ?? sub.id) });
      }
    }
    return found;
  }

  private emitCreated(holder: HolderKey, buyerId: string, memberId: string, ptier: string, state: ProviderSubscriptionState): void {
    getPaymentRegistry().emitEvent({
      type: 'subscription.created',
      providerId: this.id,
      providerSubId: `patreon:${memberId}:${ptier}`,
      holder,
      buyerId,
      tierId: '',
      offeringId: '',
      variantId: `${VARIANT_PREFIX}${ptier}`,
      soldVariantOnly: true,
      tierFromVariant: true,
      state,
    });
  }

  private emitState(type: 'subscription.expired' | 'subscription.updated', holder: HolderKey, memberId: string, ptier: string, state: ProviderSubscriptionState): void {
    getPaymentRegistry().emitEvent({ type, providerId: this.id, providerSubId: `patreon:${memberId}:${ptier}`, holder, state });
  }

  private pruneLag(now: number): void {
    for (const [key, entry] of this.recent) if (now - entry.at >= LAG_MS) this.recent.delete(key);
    for (const [key, at] of this.appliedStart) if (now - at >= LAG_MS) this.appliedStart.delete(key);
  }

  /** Gate, order and budget, before each call to Patreon and each emit. */
  private check(ctx: Ctx): void {
    this.checkGate();
    if (ctx.deadline !== null && Date.now() >= ctx.deadline) throw new WorkStop('budget');
  }

  private checkGate(): void {
    if (isMaintenanceGateClosed()) throw new WorkStop('maintenance');
    if (orderRefusesSharedOps()) throw new WorkStop('order');
  }

  // ---------------------------------------------------------------------------- calls

  /**
   * The creator-token limiter: at most 80 calls a minute in the process, none while a 429 holds; false past the
   * deadline. With a context, the gate and the order are checked while it waits.
   */
  private async acquire(ctx: Ctx | null): Promise<boolean> {
    const deadline = ctx?.deadline ?? null;
    for (;;) {
      if (ctx) this.checkGate();
      const now = Date.now();
      while (this.callTimes.length > 0 && this.callTimes[0] <= now - 60_000) this.callTimes.shift();
      let until = 0;
      if (now < this.heldUntil) until = this.heldUntil;
      else if (this.callTimes.length >= CALLS_PER_MINUTE) until = this.callTimes[0] + 60_000;
      else {
        this.callTimes.push(now);
        return true;
      }
      if (deadline !== null && until >= deadline) return false;
      await sleep(ctx ? Math.min(until - now, LIMIT_POLL_MS) : until - now);
    }
  }

  /** One GET with the context's creator token, within PROVIDER_FETCH_MS and the context's budget. */
  private async call(ctx: Ctx, path: string): Promise<Answer> {
    if (!await this.acquire(ctx)) return { failed: 'the calls allowed in a minute were used up within its time' };
    const left = ctx.deadline === null ? PROVIDER_FETCH_MS : Math.min(PROVIDER_FETCH_MS, ctx.deadline - Date.now());
    if (left <= 0) return { failed: 'its time ran out' };
    try {
      const res = await fetch(`${PATREON_API}${path}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${ctx.token}` },
        signal: AbortSignal.timeout(left),
      });
      const text = res.status === 204 ? '' : await res.text();
      let body: unknown = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = null; }
      }
      if (res.status === 429) {
        const raw = (body as Obj | null)?.errors?.[0]?.retry_after_seconds ?? (body as Obj | null)?.retry_after_seconds ?? res.headers.get('retry-after');
        const seconds = Number(raw);
        this.heldUntil = Math.max(this.heldUntil, Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000);
      }
      return { status: res.status, body };
    } catch (error) {
      const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
      return { failed: timedOut ? `no answer within ${Math.round(left / 1000)} seconds` : `the request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private logTokenRefused(): void {
    if (this.tokenRefusedLogged) return;
    this.tokenRefusedLogged = true;
    console.warn("[PatreonProvider] Patreon refused the creator access token (401), so the bot read nothing and changed nothing. Create a new token on Patreon's clients page and save it in the bot's Patreon settings.");
  }

  /** Step 0: the creator token lists the configured campaign. 'ok', or why the work stops. */
  private async step0(ctx: Ctx, logOther: boolean): Promise<'ok' | '401' | 'other-campaign' | string> {
    const answer = await this.call(ctx, CAMPAIGNS_PATH);
    if (!('failed' in answer) && answer.status === 401) {
      this.logTokenRefused();
      return '401';
    }
    const failed = failureOf(answer);
    if (failed) return failed;
    const data = ((answer as { body: unknown }).body as Obj | null)?.data;
    if (!Array.isArray(data)) return 'the campaigns answer was not a list';
    if (!data.some(c => c && String(c.id) === ctx.campaignId)) {
      if (logOther && !this.otherCampaignLogged) {
        this.otherCampaignLogged = true;
        console.warn(`[PatreonProvider] Patreon lists the campaigns of the creator access token's owner, and campaign ${ctx.campaignId} is not among them: the campaign id and the token come from different Patreon accounts. The check reads nothing until they match.`);
      }
      return 'other-campaign';
    }
    this.tokenRefusedLogged = false;
    return 'ok';
  }

  // ---------------------------------------------------------------------------- when rounds and re-reads run

  /** A round 30 seconds after start, then every hour, while this process owns the tickers. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.arm('first', ROUND_DELAY_MS, () => {
      this.hourly = outsideLedgers(() => outsideEntitlementEvent(() => setInterval(() => this.due(), HOURLY_MS)));
      (this.hourly as { unref?: () => void }).unref?.();
      this.due();
    });
  }

  stop(): void {
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.hourly) clearInterval(this.hourly);
    this.hourly = null;
    for (const entry of this.rereads.values()) clearTimeout(entry.timer);
    this.rereads.clear();
    this.rereadAfter401.clear();
  }

  /** One round now (tests and the timers); a round already running gets one more after it. */
  checkNow(): Promise<void> {
    return this.round();
  }

  /** One timer of a kind at a time, created outside every ledger and event, only where start() ran. */
  private arm(kind: TimerKind, ms: number, fire: () => void): void {
    if (!this.started || this.timers.has(kind)) return;
    const timer = outsideLedgers(() => outsideEntitlementEvent(() => setTimeout(() => {
      this.timers.delete(kind);
      fire();
    }, ms)));
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(kind, timer);
  }

  /** A round 30 seconds later (after a delivery's unread members, a 404 in an op, a body that is not JSON). */
  private armRound(kind: 'post' | 'after'): void {
    if (!this.started) return;
    if (this.running && kind === 'post') {
      this.again = true;
      return;
    }
    this.arm(kind, ROUND_DELAY_MS, () => this.due());
  }

  private due(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    void this.round();
  }

  /** THE RE-READ RULE: the member's timer keeps the earliest due time and the latest one needed. */
  private armReread(memberId: string, at: number): void {
    if (!this.started) return;
    const entry = this.rereads.get(memberId);
    if (entry && entry.due <= at) {
      entry.latest = Math.max(entry.latest, at);
      return;
    }
    if (entry) clearTimeout(entry.timer);
    const timer = outsideLedgers(() => outsideEntitlementEvent(() => setTimeout(() => this.rereadDue(), Math.max(0, at - Date.now()))));
    (timer as { unref?: () => void }).unref?.();
    this.rereads.set(memberId, { due: at, latest: Math.max(entry?.latest ?? at, at), timer });
  }

  private rereadDue(): void {
    if (this.rereadRunning) {
      this.rereadAgain = true;
      return;
    }
    const now = Date.now();
    const batch: Array<{ memberId: string; latest: number; due: number }> = [];
    for (const [memberId, entry] of this.rereads) {
      if (entry.due > now + REREAD_GATHER_MS) continue;
      clearTimeout(entry.timer);
      this.rereads.delete(memberId);
      batch.push({ memberId, latest: entry.latest, due: entry.due });
    }
    if (batch.length === 0) return;
    const run = runAcceptedOp(() => this.rereadRun(batch))
      .catch(error => console.warn(`[PatreonProvider] The re-read failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        this.rereadRunning = null;
        if (this.rereadAgain) {
          this.rereadAgain = false;
          this.rereadDue();
        }
      });
    this.rereadRunning = run;
  }

  /** One batch of due re-reads, with the round's skips and checks, behind one step 0. */
  private async rereadRun(batch: Array<{ memberId: string; latest: number; due: number }>): Promise<void> {
    const later = (memberId: string) => this.armReread(memberId, Date.now() + LAG_MS);
    const finish = (item: { memberId: string; latest: number; due: number }) => {
      if (item.latest > item.due + REREAD_GATHER_MS) this.armReread(item.memberId, item.latest);
    };
    if (!this.isConfigured() || isMaintenanceGateClosed() || orderRefusesSharedOps() || premium().cacheState() !== 'normal') {
      for (const item of batch) later(item.memberId);
      return;
    }
    const creds = providerCredentials('patreon');
    const ctx: Ctx = { source: 'reread', deadline: Date.now() + ROUND_BUDGET_MS, token: String(creds.PATREON_CREATOR_ACCESS_TOKEN), campaignId: String(creds.PATREON_CAMPAIGN_ID) };
    let passed: string;
    try {
      passed = await this.step0(ctx, true);
    } catch (error) {
      if (!(error instanceof WorkStop)) throw error;
      passed = error.cause;
    }
    if (passed !== 'ok') {
      for (const item of batch) {
        if (passed === '401') this.rereadAfter401.add(item.memberId);
        else later(item.memberId);
        finish(item);
      }
      return;
    }
    let firstFailure: { memberId: string; reason: string } | null = null;
    let notRead = 0;
    for (const [index, item] of batch.entries()) {
      let outcome: ReadOutcome;
      try {
        outcome = await this.reconcile(item.memberId, undefined, ctx);
      } catch (error) {
        if (!(error instanceof WorkStop)) throw error;
        for (const rest of batch.slice(index)) {
          later(rest.memberId);
          finish(rest);
        }
        notRead = batch.length - index;
        break;
      }
      if (outcome.kind === 'failed') {
        firstFailure ??= { memberId: item.memberId, reason: outcome.reason };
        if (outcome.rearm === 'lag') later(item.memberId);
        if (outcome.rearm === 'after401') this.rereadAfter401.add(item.memberId);
      }
      if (outcome.kind === 'not-found') this.armRound('post');
      finish(item);
    }
    if (firstFailure) {
      console.warn(`[PatreonProvider] Could not read member ${firstFailure.memberId} from Patreon (${firstFailure.reason}); no change was made, and ${notRead} other held pledges were not read this round.`);
    }
  }

  private round(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.again = false;
    const run = runAcceptedOp(() => this.roundRun())
      .then(end => {
        if (end.retry) this.arm('retry', RETRY_MS, () => this.due());
        if (end.endedByRead) this.again = true;
        return end.stopped;
      }, error => {
        console.warn(`[PatreonProvider] The check failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      })
      .then(stopped => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.armRound('after');
        }
        if (stopped) console.warn(`[PatreonProvider] The check stopped before it finished: ${STOP_WORDS[stopped]}. The next check runs ${stopped === 'budget' ? 'in an hour' : 'in 5 minutes'}.`);
      });
    this.running = run;
    return run;
  }

  // ---------------------------------------------------------------------------- one round (4.6)

  private async roundRun(): Promise<{ retry: boolean; endedByRead: boolean; stopped: StopCause | null }> {
    if (!this.isConfigured() || isMaintenanceGateClosed() || orderRefusesSharedOps() || premium().cacheState() !== 'normal') {
      return { retry: true, endedByRead: false, stopped: null };
    }
    const creds = providerCredentials('patreon');
    const startedAt = Date.now();
    const r: Round = {
      source: 'round', deadline: startedAt + ROUND_BUDGET_MS, token: String(creds.PATREON_CREATOR_ACCESS_TOKEN), campaignId: String(creds.PATREON_CAMPAIGN_ID),
      startedAt, step0Ok: false, endedByRead: false,
    };
    this.pruneLag(startedAt);
    try {
      this.logUnfollowed();
      this.check(r);
      const passed = await this.step0(r, true);
      if (passed === '401' || passed === 'other-campaign') return { retry: false, endedByRead: false, stopped: null };
      if (passed !== 'ok') {
        console.warn(`[PatreonProvider] Could not read the members of campaign ${r.campaignId} from Patreon (${passed}); pledges not seen yet wait for a later check.`);
        return { retry: false, endedByRead: false, stopped: null };
      }
      r.step0Ok = true;
      for (const memberId of this.rereadAfter401) this.armReread(memberId, Date.now() + LAG_MS);
      this.rereadAfter401.clear();
      const { seen, incomplete } = await this.readList(r);
      if (incomplete) console.warn(`[PatreonProvider] Could not read the members of campaign ${r.campaignId} from Patreon (${incomplete}); pledges not seen yet wait for a later check.`);
      const { blocked, moves } = await this.installSeen(r, seen);
      await this.checkHeld(r, seen, blocked, moves);
      return { retry: false, endedByRead: r.endedByRead, stopped: null };
    } catch (error) {
      if (!(error instanceof WorkStop)) throw error;
      return { retry: error.cause !== 'budget', endedByRead: r.endedByRead, stopped: error.cause };
    }
  }

  /** PT18, once per record and process. */
  private logUnfollowed(): void {
    for (const rec of this.unfollowedRecords()) {
      const key = `${rec.holder} ${rec.id}`;
      if (this.unfollowedLogged.has(key)) continue;
      this.unfollowedLogged.add(key);
      console.warn(`[PatreonProvider] ${holderWords(rec.holder)} holds a Patreon record (${rec.id}) that the bot does not follow (made by an earlier version or under another campaign); the bot never ends it. Remove it on the panel once its pledge no longer pays for it.`);
    }
  }

  /** Step 1: every page of the campaign's members, following Patreon's cursor; what was seen is kept when incomplete. */
  private async readList(r: Round): Promise<{ seen: Map<string, Seen>; incomplete: string | null }> {
    const seen = new Map<string, Seen>();
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let path = LIST_PATH(r.campaignId);
    const listDeadline = r.startedAt + LIST_BUDGET_MS;
    const listCtx: Ctx = { ...r, deadline: Math.min(listDeadline, r.deadline ?? Infinity) };
    for (let pages = 0; ; pages++) {
      if (pages >= PAGE_CAP) return { seen, incomplete: `${PAGE_CAP} pages were read` };
      if (Date.now() >= listDeadline) return { seen, incomplete: 'it took 3 minutes' };
      this.check(r);
      const pageAt = Date.now();
      const answer = await this.call(listCtx, path);
      if (Date.now() >= listDeadline && 'failed' in answer) return { seen, incomplete: 'it took 3 minutes' };
      const failed = failureOf(answer);
      if (failed) return { seen, incomplete: failed };
      const body = (answer as { body: unknown }).body as Obj | null;
      if (!Array.isArray(body?.data)) return { seen, incomplete: 'the answer held no list of members' };
      let repeated = false;
      for (const resource of body!.data) {
        const id = resource && (typeof resource.id === 'string' || typeof resource.id === 'number') ? String(resource.id) : null;
        if (id === null) continue;
        if (ids.has(id)) {
          repeated = true;
          continue;
        }
        ids.add(id);
        const reading = readMember(resource, body!.included, false);
        if (!('malformed' in reading)) seen.set(id, { reading, pageAt });
      }
      if (repeated) return { seen, incomplete: 'a page repeated a member' };
      const next = body!.meta?.pagination?.cursors?.next;
      if (next === null || next === undefined || next === '') return { seen, incomplete: null };
      const cursor = String(next);
      if (cursors.has(cursor)) return { seen, incomplete: 'Patreon sent a cursor already followed' };
      cursors.add(cursor);
      path = `${LIST_PATH(r.campaignId)}&page[cursor]=${encodeURIComponent(cursor)}`;
    }
  }

  /**
   * Step 2: each linked listed member's tiers 4.5 would install, not held at the link's holder, unless THE LAG RULE
   * blocks them (the member is then read in 3b); in the member's chain, the link read in the turn of the emit.
   */
  private async installSeen(r: Round, seen: Map<string, Seen>): Promise<{ blocked: Set<string>; moves: Map<string, MoveOutcome> }> {
    const blocked = new Set<string>();
    const moves = new Map<string, MoveOutcome>();
    const start = this.followedRecords();
    const heldAny = new Map<string, HeldRecord[]>();
    for (const rec of start) heldAny.set(rec.memberId, [...(heldAny.get(rec.memberId) ?? []), rec]);
    for (const [memberId, { reading, pageAt }] of seen) {
      if (reading.user === null || reading.paid.length === 0 || reading.trial) continue;
      if ((this.appliedStart.get(memberId) ?? -Infinity) > pageAt) continue;
      const mine = heldAny.get(memberId) ?? [];
      if (mine.some(rec => rec.user !== reading.user)) continue;
      const link = this.linkOf(reading.user);
      if (!link) continue;
      const wanted = reading.paid.filter(t => (reading.allowance || mine.some(rec => rec.tier === t)) && !mine.some(rec => rec.holder === link.holder && rec.tier === t));
      if (wanted.length === 0) continue;
      const user = reading.user;
      await this.inChain(memberId, r.deadline, async () => {
        const now = Date.now();
        const current = this.linkOf(user);
        if (!current) return;
        const installed = new Set<string>();
        for (const t of wanted) {
          if (this.heldAt(current.holder, memberId, t)) continue;
          const last = this.recent.get(`${memberId}:${t}`);
          if (last && now - last.at < LAG_MS && !last.paid) {
            if (this.quiet.get(memberId) !== reading.signature) blocked.add(memberId);
            continue;
          }
          this.check(r);
          this.emitCreated(current.holder, current.buyerId, memberId, t, {
            status: 'active', startDate: '', endDate: null, autoRenew: reading.autoRenew,
            meta: { patreonUserId: user, memberId, campaignId: r.campaignId, patreonTierId: t, patronStatus: reading.patronStatus },
          });
          this.recent.set(`${memberId}:${t}`, { paid: true, at: now });
          installed.add(t);
        }
        const moving = [...new Set(mine.filter(rec => rec.holder !== current.holder && installed.has(rec.tier)).map(rec => rec.tier))];
        if (moving.length === 0) return;
        const outcomes = await this.moveOutcomes(current.holder, memberId, moving, installed, r);
        for (const [t, outcome] of outcomes) moves.set(`${memberId}:${t}:${current.holder}`, outcome);
      });
    }
    return { blocked, moves };
  }

  /** Step 3: the held records against the list (3a), then the others read one by one (3b) under the 404 guard. */
  private async checkHeld(r: Round, seen: Map<string, Seen>, blocked: Set<string>, moves: Map<string, MoveOutcome>): Promise<void> {
    const held = this.followedRecords();
    const members = new Set(held.map(rec => rec.memberId));
    for (const id of [...this.lastCheckedAt.keys()]) if (!members.has(id) && !blocked.has(id)) this.lastCheckedAt.delete(id);
    for (const id of [...this.first404.keys()]) if (!members.has(id)) this.first404.delete(id);
    const toRead = new Set<string>(blocked);
    for (const rec of held) {
      const link = this.linkOf(rec.user);
      if (!link || link.holder !== rec.holder) {
        const judged = !link ? 'final' : this.heldAt(link.holder, rec.memberId, rec.tier) ? 'held' : moves.get(`${rec.memberId}:${rec.tier}:${link.holder}`);
        if (judged === undefined) {
          toRead.add(rec.memberId);
          continue;
        }
        if (judged === 'keep') continue;
        await this.inChain(rec.memberId, r.deadline, async () => {
          const now = this.linkOf(rec.user);
          if (now && now.holder === rec.holder) return;
          this.check(r);
          this.emitState('subscription.expired', rec.holder, rec.memberId, rec.tier, { status: 'expired', startDate: '', endDate: isoOf(Date.now()), autoRenew: rec.sub.autoRenew === true, meta: { ...rec.sub.providerMeta } });
          console.warn(`[PatreonProvider] ${holderWords(rec.holder)} held a Patreon record of Patreon user ${rec.user}, whose link no longer points there; it was handed to premium as ended.`);
          r.endedByRead = true;
        });
        continue;
      }
      const shown = seen.get(rec.memberId);
      const fresh = shown && (this.appliedStart.get(rec.memberId) ?? -Infinity) <= shown.pageAt;
      if (fresh && shown!.reading.paid.includes(rec.tier)
        && rec.sub.autoRenew === shown!.reading.autoRenew && rec.sub.providerMeta?.patronStatus === shown!.reading.patronStatus) continue;
      toRead.add(rec.memberId);
    }
    const checked = (id: string): number => this.lastCheckedAt.get(id) ?? -1;
    const order = [...toRead].sort((a, b) => checked(a) - checked(b));
    for (const [index, memberId] of order.entries()) {
      this.check(r);
      const outcome = await this.reconcile(memberId, undefined, r);
      this.lastCheckedAt.set(memberId, Date.now());
      if (outcome.kind === 'not-found') {
        this.notFound(r, memberId);
        continue;
      }
      if (outcome.kind === 'failed') {
        console.warn(`[PatreonProvider] Could not read member ${memberId} from Patreon (${outcome.reason}); no change was made, and ${order.length - index - 1} other held pledges were not read this round.`);
        return;
      }
      if (outcome.kind === 'applied') {
        if (outcome.ended) r.endedByRead = true;
        const entry = seen.get(memberId);
        if (blocked.has(memberId) && outcome.installed === 0 && entry) this.quiet.set(memberId, entry.reading.signature);
        else this.quiet.delete(memberId);
      }
    }
  }

  /** The 404 guard: (a) this round's step 0, (b) the records' campaign, (c) a 404 an hour earlier with no 2xx since. */
  private notFound(r: Round, memberId: string): void {
    const records = this.followedRecords().filter(rec => rec.memberId === memberId);
    const prior = this.first404.get(memberId);
    const user = records[0]?.user ?? 'unknown';
    if (r.step0Ok && records.length > 0 && records.every(rec => String(rec.sub.providerMeta?.campaignId) === r.campaignId)
      && prior && prior.token === r.token && r.startedAt - prior.at >= NOT_FOUND_GAP_MS) {
      this.first404.delete(memberId);
      for (const rec of records) {
        this.check(r);
        this.emitState('subscription.expired', rec.holder, memberId, rec.tier, { status: 'expired', startDate: '', endDate: isoOf(Date.now()), autoRenew: false, meta: { ...rec.sub.providerMeta } });
      }
      r.endedByRead = true;
      console.warn(`[PatreonProvider] Patreon answered 404 for member ${memberId} (Patreon user ${user}) at two checks at least an hour apart, while campaign ${r.campaignId} could be read; its records were handed to premium as ended.`);
      return;
    }
    if (!prior || prior.token !== r.token) this.first404.set(memberId, { at: r.startedAt, token: r.token });
    console.warn(`[PatreonProvider] Patreon answered 404 for member ${memberId} (Patreon user ${user}); its tier is kept. The bot ends it only if Patreon answers 404 again at a check at least an hour later.`);
  }
}
