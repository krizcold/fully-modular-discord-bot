/**
 * DiscordProvider - Discord App Monetization (Premium Apps), user subscriptions only.
 *
 * Members buy in Discord; the bot never starts, cancels or refunds a purchase. Each entitlement event of the gateway
 * (ENTITLEMENT_CREATE, _UPDATE, _DELETE) is applied from its payload: a user entitlement becomes the premium holder
 * `user:<user_id>`, its tier is the one whose offering sells its SKU (premium finds it), and a server entitlement gives
 * nothing.
 *
 * Configuration: DISCORD_APPLICATION_ID and DISCORD_TOKEN (the bot's own token).
 */

import { PROVIDER_FETCH_MS } from './paymentTypes';
import { providerCredentials, providerCredentialsUnread } from '@/utils/envLoader';
import { getPaymentRegistry } from './paymentRegistry';
import { isDiscordId, parseHolder, userHolder } from '../premiumHolder';
import { isMaintenanceGateClosed, orderRefusesSharedOps, outsideEntitlementEvent, runAcceptedOp } from '../maintenanceGate';
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
import type { HolderKey } from '../premiumHolder';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

const CAPABILITIES: ProviderCapabilities = {
  canInitiatePurchase: false,
  supportsCancel: false,
  supportsReactivate: false,
  supportsCoupons: false,
  supportsPause: false,
  supportsMultipleVariants: false,
  supportsProductMode: false,
  supportsHostedPicker: false,
  supportsCustomerPortal: false,
  supportsAnnualBilling: false,
  supportsPriceMigration: false,
  mechanism: 'client_handoff',
  variantIdLabel: 'Discord SKU ID',
  productIdLabel: '',
  sells: ['user'],
  endsAtPaidEnd: true,
  endedByProviderOnly: true,
  endedByProviderText: "Discord manages this subscription, so the bot cannot end or remove it. It ends when the member's subscription ends in Discord or Discord refunds it.",
  settingsUnreadText: "payment-providers/credentials.json cannot be read now, so the bot can't confirm whether Discord bills this subscription, and it does not end or remove it. Try again once it can be read.",
  billedWhileQueued: true,
  queuedBilledText: 'The bot cannot pause it in Discord; if you no longer want it, cancel it in Discord.',
};

/** How long an event's time and the end evidence this process gained are kept (sheet P6, 4.3). */
const EVIDENCE_MS = 2 * 60 * 60 * 1000;
/** A round after start, after an update or delete event, after a held ends_at, and after a round that ended a record. */
const ROUND_DELAY_MS = 30_000;
const HOURLY_MS = 60 * 60_000;
/** The next round after one that was skipped or stopped for maintenance or an order. */
const RETRY_MS = 5 * 60_000;
const ROUND_BUDGET_MS = 5 * 60_000;
const LIST_BUDGET_MS = 3 * 60_000;
const PAGE_CAP = 50;
const PAGE_LIMIT = 100;
/** The 404 guard's condition (c): the first 404 at a round at least this much earlier. */
const NOT_FOUND_GAP_MS = 60 * 60_000;
const DISCORD_EPOCH_MS = 1420070400000n;

const DISCORD_CANNOT_START ='Members buy Discord subscriptions in Discord; the bot cannot start one.';

/** An entitlement as an event or a read gives it; a date is ms, null when there is none, NaN when it does not parse. */
interface DiscordEntitlement {
  id: string;
  sku_id: string;
  application_id: string;
  user_id: string | null;
  guild_id: string | null;
  type: number;
  deleted: boolean;
  startsMs: number | null;
  endsMs: number | null;
}

interface DiscordSku {
  id: string;
  type: number;
  application_id: string;
  name: string;
  slug: string;
  flags: number;
}

type EventKind = 'created' | 'updated' | 'deleted';

/** What one GET of a round gave: Discord's status and body, or why there was none. */
type Answer = { status: number; body: unknown } | { failed: string };

/** A Discord record premium holds for a user, as a round reads it. */
interface HeldRecord { holder: HolderKey; uid: string; id: string; sub: any; location: 'active' | 'paused' }

/** An entitlement step 1 saw, and when the page that showed it was asked for. */
interface Seen { ent: DiscordEntitlement; pageAt: number }

/** One round: the credentials it read at its start, and what its first calls proved. */
interface Round {
  appId: string;
  token: string;
  startedAt: number;
  /** /applications/@me answered 2xx with the configured application id (the 404 guard's (a)). */
  meOk: boolean;
  /** The list's first page answered 2xx (the 404 guard's (a)). */
  firstPageOk: boolean;
  /** Step 3b ended a record: one more round 30 seconds after this one (E5). */
  endedByRead: boolean;
}

type StopCause = 'maintenance' | 'order' | 'budget';

class RoundStop extends Error {
  constructor(readonly cause: StopCause) {
    super(cause);
  }
}

const STOP_WORDS: Record<StopCause, string> = {
  maintenance: 'the bot entered maintenance',
  order: 'a save order holds',
  budget: 'it ran for 5 minutes',
};

type TimerKind = 'first' | 'post' | 'retry' | 'after' | 'ends';

/** The longest delay a timer is armed for; a later ends_at is armed again when it fires. */
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

const serverEntitlementsLogged = new Set<string>();

const isoOf = (ms: number): string => new Date(ms).toISOString();

/** The smallest snowflake of an instant (ms). BigInt, as `<<` on numbers truncates to 32 bits (E17). */
const snowflakeOf = (ms: number): string => ((BigInt(ms) - DISCORD_EPOCH_MS) << 22n).toString();

const failureOf = (answer: Answer): string | null => ('failed' in answer
  ? answer.failed
  : answer.status < 200 || answer.status >= 300 ? `Discord answered ${answer.status}` : null);

const msOf = (value: unknown): number | null => (value === null || value === undefined ? null : Date.parse(String(value)));

const premium = (): { cacheState(): string; getAllSubscriptions(): Record<string, { active?: any; paused?: any[] }> } => getPremiumManager();

/** A discord.js timestamp (a number, null, or NaN) or a REST date (text or null) as ms; NaN when present and unusable. */
function dateMs(djs: boolean, value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (djs) return typeof value === 'number' && Number.isFinite(value) ? value : NaN;
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

function normalizeEntitlement(raw: any): DiscordEntitlement | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id;
  const sku = raw.skuId ?? raw.sku_id;
  if (!id || !sku) return null;
  const djs = 'startsTimestamp' in raw || 'endsTimestamp' in raw;
  return {
    id: String(id),
    sku_id: String(sku),
    application_id: String(raw.applicationId ?? raw.application_id ?? ''),
    user_id: raw.userId ?? raw.user_id ?? null,
    guild_id: raw.guildId ?? raw.guild_id ?? null,
    type: Number(raw.type ?? 8),
    deleted: raw.deleted === true,
    startsMs: dateMs(djs, djs ? raw.startsTimestamp : raw.starts_at),
    endsMs: dateMs(djs, djs ? raw.endsTimestamp : raw.ends_at),
  };
}

/** The date field of an entitlement that does not parse; null when every date is usable. */
function badDate(ent: DiscordEntitlement): 'starts_at' | 'ends_at' | null {
  if (Number.isNaN(ent.startsMs)) return 'starts_at';
  if (Number.isNaN(ent.endsMs)) return 'ends_at';
  return null;
}

/** Whom an entitlement is for: a user (a Discord user id and no server), a server, or nobody this bot can name. */
function ownerOf(ent: DiscordEntitlement): 'user' | 'guild' | null {
  if (ent.guild_id !== null && ent.guild_id !== undefined && ent.guild_id !== '') return isDiscordId(ent.guild_id) ? 'guild' : null;
  return isDiscordId(ent.user_id) ? 'user' : null;
}

/**
 * The state an entitlement gives (sheet P6, 4.3): deleted or a delete event ends it (at ends_at when usable, else now),
 * an ends_at passed ends it, an ends_at ahead keeps it to that end, none renews. Null when a date does not parse and
 * nothing ends it.
 */
function stateOf(ent: DiscordEntitlement, now: number, deleteEvent: boolean): ProviderSubscriptionState | null {
  const meta = { skuId: ent.sku_id, type: ent.type, ...(ent.application_id ? { applicationId: ent.application_id } : {}) };
  const usable = (ms: number | null): ms is number => ms !== null && Number.isFinite(ms);
  const startDate = usable(ent.startsMs) ? isoOf(ent.startsMs) : '';
  if (ent.deleted || deleteEvent) {
    return { status: 'expired', startDate, endDate: isoOf(usable(ent.endsMs) ? ent.endsMs : now), autoRenew: false, meta };
  }
  if (badDate(ent)) return null;
  if (ent.endsMs === null) return { status: 'active', startDate, endDate: null, autoRenew: true, meta };
  return { status: ent.endsMs <= now ? 'expired' : 'active', startDate, endDate: isoOf(ent.endsMs), autoRenew: false, meta };
}

export class DiscordProvider implements PaymentProvider {
  readonly id = 'discord';
  readonly displayName = 'Discord App Monetization';
  readonly capabilities = CAPABILITIES;

  /** When this process last applied an event of each entitlement. */
  private readonly lastEventAt = new Map<string, number>();
  /** The entitlements this process saw end, and whether a delete ended them (that evidence is kept for good). */
  private readonly endedHere = new Map<string, { at: number; byDelete: boolean }>();
  /** The ends_at each ENTITLEMENT_UPDATE gave, and when. */
  private readonly eventEnd = new Map<string, { endsMs: number; at: number }>();
  /** When a single read of each held record was last tried, answered or not. */
  private readonly lastCheckedAt = new Map<string, number>();
  /** The 404 guard's (c): the round of a record's first 404 with no 2xx since, under the application it was read with. */
  private readonly first404 = new Map<string, { at: number; appId: string }>();
  /** The records PD18 was logged for. */
  private readonly otherAppLogged = new Set<string>();
  private tokenMismatchLogged = false;

  /** start() ran in this process: only then are rounds armed (E7). */
  private started = false;
  private readonly timers = new Map<TimerKind, ReturnType<typeof setTimeout>>();
  /** When each armed timer fires. */
  private readonly timerAt = new Map<TimerKind, number>();
  private hourly: ReturnType<typeof setInterval> | null = null;
  /** When the ends timer fires, and every ends_at plus 30 seconds still ahead. */
  private endsTimerAt: number | null = null;
  private readonly endsDue = new Set<number>();
  private running: Promise<void> | null = null;
  /** A round came due while one ran: one more 30 seconds after it ends (D18, E7). */
  private again = false;

  isConfigured(): boolean {
    const creds = providerCredentials('discord');
    return !!(creds.DISCORD_APPLICATION_ID && creds.DISCORD_TOKEN);
  }

  getCredentialFields(): CredentialFieldDef[] {
    return [
      {
        key: 'DISCORD_APPLICATION_ID',
        label: 'Application ID',
        type: 'text',
        placeholder: '1234567890123456789',
        helpText: 'Discord Developer Portal - General Information - Application ID. Same value as your bot Client ID.',
      },
      {
        key: 'DISCORD_TOKEN',
        label: 'Bot Token (read-only)',
        type: 'secret',
        helpText: 'Reuses the bot\'s existing token; managed by your hosting setup, not editable here.',
        optional: true,
      },
    ];
  }

  async initiatePurchase(_opts: InitiateOpts): Promise<InitiateResult> {
    throw new Error(DISCORD_CANNOT_START);
  }

  /** One SKU as an offering's variant: Discord gives its name, not its price. */
  async fetchVariant(skuId: string): Promise<OfferingVariant | null> {
    const skus = await this.listSkus();
    if (!skus) return null;
    const match = skus.find(s => s.id === skuId);
    if (!match) return null;
    return this.normalizeSku(match);
  }

  private async listSkus(): Promise<DiscordSku[] | null> {
    const creds = providerCredentials('discord');
    if (!creds.DISCORD_APPLICATION_ID) return null;
    const { body } = await this.get(`/applications/${creds.DISCORD_APPLICATION_ID}/skus`, true);
    return Array.isArray(body) ? body as DiscordSku[] : null;
  }

  private normalizeSku(sku: DiscordSku): OfferingVariant {
    return {
      variantId: sku.id,
      label: sku.name,
      amount: 0,
      currency: '',
      durationDays: 30,
      recurring: true,
      active: true,
    };
  }

  /** One read of the entitlement: null when Discord answers 404, its state on a 2xx, a thrown error otherwise. */
  async getSubscriptionState(providerSubId: string): Promise<ProviderSubscriptionState | null> {
    const creds = providerCredentials('discord');
    if (!creds.DISCORD_APPLICATION_ID) throw new Error('DISCORD_APPLICATION_ID not configured');
    const { status, body } = await this.get(`/applications/${creds.DISCORD_APPLICATION_ID}/entitlements/${encodeURIComponent(providerSubId)}`, false);
    if (status === 404) return null;
    if (status < 200 || status >= 300) throw new Error(`Discord answered ${status} for entitlement ${providerSubId}`);
    const ent = normalizeEntitlement(body);
    if (!ent || ent.id !== providerSubId) throw new Error(`Discord's answer for entitlement ${providerSubId} is not that entitlement`);
    const state = stateOf(ent, Date.now(), false);
    if (!state) throw new Error(`Entitlement ${providerSubId} has a date that does not parse (${badDate(ent)})`);
    return state;
  }

  followsSubscription(sub: { holder: HolderKey; providerMeta?: Record<string, any> }): FollowAnswer {
    if (parseHolder(sub.holder)?.kind !== 'user') return { followed: false, whyNot: 'guild' };
    const creds = providerCredentials('discord');
    if (!creds.DISCORD_TOKEN) return { followed: false, whyNot: 'not-configured' };
    if (!creds.DISCORD_APPLICATION_ID) return { followed: false, whyNot: providerCredentialsUnread('discord') === null ? 'not-configured' : 'unread' };
    if (sub.providerMeta?.applicationId !== creds.DISCORD_APPLICATION_ID) return { followed: false, whyNot: 'other-app' };
    return { followed: true };
  }

  /**
   * Attaches the three entitlement events (clientInitializer and the maintenance boot, through attachEntitlementBridge).
   * Each handler is synchronous and applies the entitlement it is given.
   */
  attachGatewayBridge(attach: (eventName: string, handler: (payload: any) => void) => void): void {
    const handle = (kind: EventKind) => (raw: any) => {
      try {
        this.applyEvent(kind, raw);
      } catch (err: any) {
        console.warn(`[DiscordProvider] gateway ${kind} handler failed:`, err?.message || err);
      }
    };
    attach('entitlementCreate', handle('created'));
    attach('entitlementUpdate', handle('updated'));
    attach('entitlementDelete', handle('deleted'));
  }

  private applyEvent(kind: EventKind, raw: any): void {
    const ent = normalizeEntitlement(raw);
    if (!ent) return;
    const owner = ownerOf(ent);
    if (owner === 'guild') {
      this.logServer(ent);
      return;
    }
    if (owner !== 'user') return;
    const now = Date.now();
    const state = stateOf(ent, now, kind === 'deleted');
    if (!state) {
      console.warn(`[DiscordProvider] Entitlement ${ent.id} has a date that does not parse (${badDate(ent)}); the event was not applied. The next check reads it again.`);
      return;
    }
    if (kind === 'created' && state.status !== 'active') return;
    this.noteEvent(kind, ent, state, now);
    if (kind === 'created') {
      this.emitCreated(ent, state);
      return;
    }
    getPaymentRegistry().emitEvent({
      type: state.status === 'expired' ? 'subscription.expired' : 'subscription.updated',
      providerId: this.id,
      providerSubId: ent.id,
      holder: userHolder(String(ent.user_id)),
      state,
    });
    this.afterEvent();
  }

  private emitCreated(ent: DiscordEntitlement, state: ProviderSubscriptionState): void {
    getPaymentRegistry().emitEvent({
      type: 'subscription.created',
      providerId: this.id,
      providerSubId: ent.id,
      holder: userHolder(String(ent.user_id)),
      buyerId: String(ent.user_id),
      tierId: '',
      offeringId: '',
      variantId: ent.sku_id,
      soldVariantOnly: true,
      tierFromVariant: true,
      state,
    });
  }

  /** PD1, once per entitlement and process. */
  private logServer(ent: DiscordEntitlement): void {
    if (serverEntitlementsLogged.has(ent.id)) return;
    serverEntitlementsLogged.add(ent.id);
    console.warn(`[DiscordProvider] Entitlement ${ent.id} (SKU ${ent.sku_id}) is for a server; this bot sells only user subscriptions through Discord, so no tier was given for it. Discord keeps billing it until it is cancelled or refunded in Discord.`);
  }

  /** What an event tells this process about one entitlement, recorded before it is handed to premium. */
  private noteEvent(kind: EventKind, ent: DiscordEntitlement, state: ProviderSubscriptionState, now: number): void {
    this.pruneEvidence(now);
    this.lastEventAt.set(ent.id, now);
    if (kind === 'updated' && ent.endsMs !== null && Number.isFinite(ent.endsMs)) this.eventEnd.set(ent.id, { endsMs: ent.endsMs, at: now });
    if (kind !== 'created' && state.status === 'expired') {
      const byDelete = kind === 'deleted' || ent.deleted || this.endedHere.get(ent.id)?.byDelete === true;
      this.endedHere.set(ent.id, { at: now, byDelete });
    }
    this.noteEndAhead(ent, now);
  }

  /** A single read showed the entitlement ended: end evidence, as an event's is. */
  private noteReadEnd(ent: DiscordEntitlement, now: number): void {
    const byDelete = ent.deleted || this.endedHere.get(ent.id)?.byDelete === true;
    this.endedHere.set(ent.id, { at: now, byDelete });
  }

  /** An ends_at ahead arms a round at that time plus 30 seconds (D19). */
  private noteEndAhead(ent: DiscordEntitlement, now: number): void {
    if (ent.endsMs !== null && Number.isFinite(ent.endsMs) && ent.endsMs > now) this.armEnds(ent.endsMs + ROUND_DELAY_MS);
  }

  // ---------------------------------------------------------------------------- when rounds run (sheet P6, 4.4)

  /** A round 30 seconds after start, then every hour, while this process owns the tickers (reg.startTickers). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.arm('first', ROUND_DELAY_MS, () => {
      this.hourly = outsideEntitlementEvent(() => setInterval(() => this.due(), HOURLY_MS));
      this.hourly.unref?.();
      this.due();
    });
  }

  stop(): void {
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.timerAt.clear();
    if (this.hourly) clearInterval(this.hourly);
    this.hourly = null;
    this.endsTimerAt = null;
    this.endsDue.clear();
  }

  /** One round now (tests and the timers); a round already running gets one more after it. */
  checkNow(): Promise<void> {
    return this.round();
  }

  /** One timer of a kind at a time, created outside any entitlement event's store (D16), only where start() ran (E7). */
  private arm(kind: TimerKind, ms: number, fire: () => void): void {
    if (!this.started || this.timers.has(kind)) return;
    const timer = outsideEntitlementEvent(() => setTimeout(() => {
      this.timers.delete(kind);
      this.timerAt.delete(kind);
      fire();
    }, ms));
    timer.unref?.();
    this.timers.set(kind, timer);
    this.timerAt.set(kind, Date.now() + ms);
  }

  /** PD15's words for when the next round runs, from the timers armed now. */
  private nextCheckWords(): string {
    const now = Date.now();
    const soonest = Math.min(...[...this.timerAt.values()].map(at => at - now), this.hourly ? HOURLY_MS : Infinity);
    if (soonest <= 60_000) return 'within a minute';
    if (soonest <= RETRY_MS) return 'within 5 minutes';
    if (soonest <= HOURLY_MS) return 'within an hour';
    return 'when the bot next starts its checks';
  }

  /** The ends timer: one, for the earliest ends_at plus 30 seconds still ahead. */
  private armEnds(at: number): void {
    if (!this.started) return;
    this.endsDue.add(at);
    if (this.endsTimerAt !== null && this.endsTimerAt <= at) return;
    const armed = this.timers.get('ends');
    if (armed) clearTimeout(armed);
    this.timers.delete('ends');
    this.timerAt.delete('ends');
    this.endsTimerAt = at;
    this.arm('ends', Math.min(Math.max(at - Date.now(), 0), MAX_TIMER_MS), () => {
      this.endsTimerAt = null;
      const now = Date.now();
      let reached = false;
      for (const due of [...this.endsDue]) {
        if (due > now) continue;
        this.endsDue.delete(due);
        reached = true;
      }
      if (this.endsDue.size > 0) this.armEnds(Math.min(...this.endsDue));
      if (reached) this.due();
    });
  }

  /** After an update or delete event: one round 30 seconds later, or one after the running round. */
  private afterEvent(): void {
    if (!this.started) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.arm('post', ROUND_DELAY_MS, () => this.due());
  }

  private due(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    void this.round();
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
        console.warn(`[DiscordProvider] The check failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      })
      .then(stopped => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.arm('after', ROUND_DELAY_MS, () => this.due());
        }
        if (stopped) console.warn(`[DiscordProvider] The check stopped before it finished: ${STOP_WORDS[stopped]}. The next check runs ${this.nextCheckWords()}.`);
      });
    this.running = run;
    return run;
  }

  // ---------------------------------------------------------------------------- one round

  /** Gate, order and budget, before each call to Discord and each emit (G8-11). */
  private stopCheck(r: Round): void {
    if (isMaintenanceGateClosed()) throw new RoundStop('maintenance');
    if (orderRefusesSharedOps()) throw new RoundStop('order');
    if (Date.now() - r.startedAt >= ROUND_BUDGET_MS) throw new RoundStop('budget');
  }

  private async roundRun(): Promise<{ retry: boolean; endedByRead: boolean; stopped: StopCause | null }> {
    if (!this.isConfigured() || isMaintenanceGateClosed() || orderRefusesSharedOps() || premium().cacheState() !== 'normal') {
      return { retry: true, endedByRead: false, stopped: null };
    }
    const creds = providerCredentials('discord');
    const r: Round = { appId: String(creds.DISCORD_APPLICATION_ID), token: String(creds.DISCORD_TOKEN), startedAt: Date.now(), meOk: false, firstPageOk: false, endedByRead: false };
    this.pruneEvidence(r.startedAt);
    try {
      this.stopCheck(r);
      const me = await this.call(r, '/applications/@me');
      if (!failureOf(me) && !('failed' in me)) {
        const id = (me.body as { id?: unknown } | null)?.id;
        if (id !== undefined && id !== null && String(id) !== r.appId) {
          if (!this.tokenMismatchLogged) {
            this.tokenMismatchLogged = true;
            console.warn(`[DiscordProvider] The bot token belongs to application ${String(id)}, but the configured application id is ${r.appId}; this is likely a configuration error. The check reads nothing until they match.`);
          }
          return { retry: false, endedByRead: false, stopped: null };
        }
        r.meOk = id !== undefined && id !== null;
      }
      const { seen, incomplete } = await this.readList(r);
      if (incomplete) console.warn(`[DiscordProvider] Could not read the whole list of the app's entitlements from Discord (${incomplete}); purchases not seen as events wait for a later check.`);
      this.installSeen(r, seen);
      await this.checkHeld(r, seen);
      return { retry: false, endedByRead: r.endedByRead, stopped: null };
    } catch (error) {
      if (!(error instanceof RoundStop)) throw error;
      return { retry: error.cause !== 'budget', endedByRead: r.endedByRead, stopped: error.cause };
    }
  }

  /**
   * Step 1, the install rule's paging: the newest window first (before the snowflake of now plus a minute), then both
   * directions from it, each cursor the page's largest or smallest id whatever its order, each direction to an empty
   * page. What was seen is kept when the read is incomplete; the reason is answered.
   */
  private async readList(r: Round): Promise<{ seen: Map<string, Seen>; incomplete: string | null }> {
    const seen = new Map<string, Seen>();
    const base = `/applications/${r.appId}/entitlements?exclude_ended=false&limit=${PAGE_LIMIT}`;
    let pages = 0;
    const page = async (cursor: 'before' | 'after', at: string): Promise<bigint[] | string> => {
      if (pages >= PAGE_CAP) return `${PAGE_CAP} pages were read`;
      if (Date.now() - r.startedAt >= LIST_BUDGET_MS) return 'it took 3 minutes';
      this.stopCheck(r);
      pages += 1;
      const pageAt = Date.now();
      const answer = await this.call(r, `${base}&${cursor}=${at}`);
      const failed = failureOf(answer);
      if (failed) return failed;
      const body = (answer as { body: unknown }).body;
      if (!Array.isArray(body)) return 'the answer was not a list';
      const bound = BigInt(at);
      const found = new Map<string, DiscordEntitlement>();
      for (const raw of body) {
        const ent = normalizeEntitlement(raw);
        if (!ent || !/^\d+$/.test(ent.id)) return 'a page held an entry that is not an entitlement';
        const id = BigInt(ent.id);
        if (cursor === 'before' ? id >= bound : id <= bound) return 'a page held an id on the wrong side of its cursor';
        if (seen.has(ent.id) || found.has(ent.id)) return 'a page repeated an id';
        found.set(ent.id, ent);
      }
      for (const ent of found.values()) seen.set(ent.id, { ent, pageAt });
      return [...found.keys()].map(id => BigInt(id));
    };
    const first = await page('before', snowflakeOf(Date.now() + 60_000));
    if (typeof first === 'string') return { seen, incomplete: first };
    r.firstPageOk = true;
    if (first.length === 0) return { seen, incomplete: null };
    const largest = (ids: bigint[]) => ids.reduce((a, b) => (b > a ? b : a));
    const smallest = (ids: bigint[]) => ids.reduce((a, b) => (b < a ? b : a));
    let incomplete: string | null = null;
    for (const cursor of ['after', 'before'] as const) {
      let at = cursor === 'after' ? largest(first) : smallest(first);
      for (;;) {
        const next = await page(cursor, at.toString());
        if (typeof next === 'string') {
          incomplete ??= next;
          break;
        }
        if (next.length === 0) break;
        at = cursor === 'after' ? largest(next) : smallest(next);
      }
    }
    return { seen, incomplete };
  }

  /** The Discord records premium holds for users, active and queued, in premium's stored order. */
  private heldRecords(): HeldRecord[] {
    const found: HeldRecord[] = [];
    for (const [holder, record] of Object.entries(premium().getAllSubscriptions())) {
      const parsed = parseHolder(holder);
      if (parsed?.kind !== 'user') continue;
      const subs: Array<[any, 'active' | 'paused']> = [[record.active, 'active'], ...(record.paused ?? []).map(p => [p, 'paused'] as [any, 'paused'])];
      for (const [sub, location] of subs) {
        if (sub?.providerId !== this.id || !sub.providerSubId) continue;
        found.push({ holder: parsed.key, uid: parsed.id, id: String(sub.providerSubId), sub, location });
      }
    }
    return found;
  }

  /** Step 2: each current user entitlement step 1 saw that premium does not hold and no end evidence blocks. */
  private installSeen(r: Round, seen: Map<string, Seen>): void {
    const heldIds = new Set<string>();
    for (const record of Object.values(premium().getAllSubscriptions())) {
      for (const sub of [record.active, ...(record.paused ?? [])]) if (sub?.providerId === this.id && sub.providerSubId) heldIds.add(String(sub.providerSubId));
    }
    const now = Date.now();
    for (const [id, { ent, pageAt }] of seen) {
      const owner = ownerOf(ent);
      if (owner === 'guild') {
        this.logServer(ent);
        continue;
      }
      if (owner !== 'user') continue;
      const state = stateOf(ent, now, false);
      if (!state || state.status !== 'active') continue;
      this.noteEndAhead(ent, now);
      if (heldIds.has(id) || this.endedHere.has(id)) continue;
      const ended = this.eventEnd.get(id);
      if (ended && ended.endsMs <= now) continue;
      const last = this.lastEventAt.get(id);
      if (last !== undefined && last >= pageAt) continue;
      this.stopCheck(r);
      this.emitCreated(ent, state);
    }
  }

  /** Whether a read's state changes a held record (ms, never text); a null end never replaces an update's (R12). */
  private differs(rec: HeldRecord, state: ProviderSubscriptionState): boolean {
    if (state.endDate === null && this.eventEnd.has(rec.id)) return false;
    if (msOf(rec.sub.endDate) !== msOf(state.endDate) || rec.sub.autoRenew !== state.autoRenew) return true;
    return rec.location === 'active' && rec.sub.status !== state.status;
  }

  private emitState(rec: HeldRecord, state: ProviderSubscriptionState): void {
    getPaymentRegistry().emitEvent({
      type: state.status === 'expired' ? 'subscription.expired' : 'subscription.updated',
      providerId: this.id,
      providerSubId: rec.id,
      holder: rec.holder,
      state,
    });
  }

  /** Step 3: the held records, compared with what step 1 saw (3a), then the others read one by one (3b). */
  private async checkHeld(r: Round, seen: Map<string, Seen>): Promise<void> {
    const held = this.heldRecords();
    const ids = new Set(held.map(h => h.id));
    for (const id of [...this.lastCheckedAt.keys()]) if (!ids.has(id)) this.lastCheckedAt.delete(id);
    for (const id of [...this.first404.keys()]) if (!ids.has(id)) this.first404.delete(id);
    const toRead: HeldRecord[] = [];
    for (const rec of held) {
      const app = rec.sub.providerMeta?.applicationId;
      if (app !== r.appId) {
        if (!this.otherAppLogged.has(rec.id)) {
          this.otherAppLogged.add(rec.id);
          console.warn(`[DiscordProvider] Entitlement ${rec.id} (user ${rec.uid}) carries application ${app ?? 'none'}, not the configured ${r.appId}; the check does not read it, so only an end date the record already holds ends it. If ${r.appId} is a typo, fix the configured application id; otherwise remove it on the dev page once that application no longer bills it.`);
        }
        continue;
      }
      const shown = seen.get(rec.id);
      if (shown) {
        const last = this.lastEventAt.get(rec.id);
        if (last !== undefined && last > shown.pageAt) continue;
        if (ownerOf(shown.ent) === 'user' && shown.ent.user_id === rec.uid) {
          const now = Date.now();
          const state = stateOf(shown.ent, now, false);
          if (!state) continue;
          if (state.status === 'active') {
            this.noteEndAhead(shown.ent, now);
            if (this.differs(rec, state)) {
              this.stopCheck(r);
              this.emitState(rec, state);
            }
            continue;
          }
        }
      }
      toRead.push(rec);
    }
    const checked = (rec: HeldRecord): number => this.lastCheckedAt.get(rec.id) ?? -1;
    toRead.sort((a, b) => checked(a) - checked(b));
    for (const [index, rec] of toRead.entries()) {
      this.stopCheck(r);
      const readAt = Date.now();
      const answer = await this.call(r, `/applications/${r.appId}/entitlements/${encodeURIComponent(rec.id)}`);
      this.lastCheckedAt.set(rec.id, Date.now());
      const last = this.lastEventAt.get(rec.id);
      if (last !== undefined && last > readAt) continue;
      if (!('failed' in answer) && answer.status === 404) {
        this.notFound(r, rec);
        continue;
      }
      let reason = failureOf(answer);
      const ent = reason ? null : normalizeEntitlement((answer as { body: unknown }).body);
      if (!reason && (!ent || ent.id !== rec.id)) reason = 'the answer was not an entitlement';
      if (reason || !ent) {
        console.warn(`[DiscordProvider] Could not read entitlement ${rec.id} (user ${rec.uid}) from Discord (${reason}); no change was made, and ${toRead.length - index - 1} other held subscriptions were not read this round.`);
        return;
      }
      this.first404.delete(rec.id);
      if (ownerOf(ent) !== 'user' || ent.user_id !== rec.uid) {
        const who = ent.guild_id ? 'a server' : `user ${ent.user_id ?? 'none'}`;
        console.warn(`[DiscordProvider] Entitlement ${rec.id} belongs to ${who} in Discord, but the bot holds it for user ${rec.uid}; no change was made. Check the stored record.`);
        continue;
      }
      const now = Date.now();
      const state = stateOf(ent, now, false);
      if (!state) continue;
      if (state.status === 'expired') {
        this.stopCheck(r);
        this.noteReadEnd(ent, now);
        r.endedByRead = true;
        this.emitState(rec, state);
        continue;
      }
      this.noteEndAhead(ent, now);
      if (this.differs(rec, state)) {
        this.stopCheck(r);
        this.emitState(rec, state);
      }
    }
  }

  /** The 404 guard (the end rule): (a) this round's @me and first page, (b) the record's application, (c) a 404 an hour earlier. */
  private notFound(r: Round, rec: HeldRecord): void {
    const prior = this.first404.get(rec.id);
    const sameApp = rec.sub.providerMeta?.applicationId === r.appId;
    if (r.meOk && r.firstPageOk && sameApp && prior && prior.appId === r.appId && r.startedAt - prior.at >= NOT_FOUND_GAP_MS) {
      this.stopCheck(r);
      this.first404.delete(rec.id);
      r.endedByRead = true;
      this.emitState(rec, { status: 'expired', startDate: '', endDate: isoOf(Date.now()), autoRenew: false, meta: rec.sub.providerMeta });
      console.warn(`[DiscordProvider] Discord answered 404 for entitlement ${rec.id} (user ${rec.uid}) at two checks at least an hour apart, while this app's entitlements could be read; it was handed to premium as ended.`);
      return;
    }
    if (!prior || prior.appId !== r.appId) this.first404.set(rec.id, { at: r.startedAt, appId: r.appId });
    console.warn(`[DiscordProvider] Discord answered 404 for entitlement ${rec.id} (user ${rec.uid}); its tier is kept. The bot ends it only if Discord answers 404 again at a check at least an hour later.`);
  }

  /** One GET of a round, with the round's token: Discord's answer, or why there was none. */
  private async call(r: Round, path: string): Promise<Answer> {
    try {
      return await this.get(path, false, r.token);
    } catch (error) {
      const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
      return { failed: timedOut ? `no answer within ${PROVIDER_FETCH_MS / 1000} seconds` : `the request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private pruneEvidence(now: number): void {
    const before = now - EVIDENCE_MS;
    for (const [id, at] of this.lastEventAt) if (at < before) this.lastEventAt.delete(id);
    for (const [id, entry] of this.eventEnd) if (entry.at < before) this.eventEnd.delete(id);
    for (const [id, entry] of this.endedHere) if (!entry.byDelete && entry.at < before) this.endedHere.delete(id);
  }

  /**
   * One GET with the bot token (a round passes the token it read at its start), ended within PROVIDER_FETCH_MS. With
   * `strict`, a status that is not 2xx is thrown.
   */
  private async get(path: string, strict: boolean, roundToken?: string): Promise<{ status: number; body: unknown }> {
    const token = roundToken ?? providerCredentials('discord').DISCORD_TOKEN;
    if (!token) throw new Error('DISCORD_TOKEN not configured');
    const res = await fetch(`${DISCORD_API_BASE}${path}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'fully-modular-discord-bot (premium, 1.0)',
      },
      signal: AbortSignal.timeout(PROVIDER_FETCH_MS),
    });
    const text = res.status === 204 ? '' : await res.text();
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    if (strict && !res.ok) throw new Error((body as any)?.message || `Discord API GET ${path} -> ${res.status}`);
    return { status: res.status, body };
  }
}
