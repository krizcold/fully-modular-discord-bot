import { ClientApplication, type Client } from 'discord.js';
import { vi } from 'vitest';

// The fake of Discord for P6 (sheet P6, section 10). Installed as the global fetch, it answers only these routes of
// https://discord.com/api/v10: GET /applications/@me (the token's own application), GET /applications/<app>/entitlements
// (every query field of D-h), GET /applications/<app>/entitlements/<id> and GET /applications/<app>/skus. Each call is
// checked for a `Bot <token>` header: a token of another application gets that application's answer on @me and the
// `foreignApp` answer on this application's routes (R11). Reads lag `staleReads` seconds behind every change (R12). Any
// other route or method (a DELETE, a POST) is recorded in `unexpected` and answered with a thrown error, and a row
// asserts `unexpected` is empty.
//
// Discord-side actions change the fake's entitlements and queue the gateway event discord.js would emit; `deliver`
// hands a queued event to a real discord.js Client through the library's own action (djs/client/actions), so the
// Client builds a real Entitlement and emits entitlementUpdate as (old | null, new). The unconfirmed behaviours R1 to
// R13 are settings, and each defaults to its worst case.

export const DISCORD_API = 'https://discord.com/api/v10';
/** The bot's application and its token; the second application `rotateApp` switches to. */
export const APP_ID = '86900000000000001';
export const BOT_TOKEN = 'p6-token-of-the-first-application';
export const SECOND_APP_ID = '86900000000000002';
export const SECOND_TOKEN = 'p6-token-of-the-second-application';
/** The SKUs the fake sells: A and A2 (the lower user tier's two offerings), B (the higher one), and one no offering sells. */
export const SKU = {
  A: '86100000000000001',
  A2: '86100000000000002',
  B: '86100000000000003',
  UNWIRED: '86100000000000009',
} as const;
/** Discord's epoch for snowflakes, in ms. */
export const DISCORD_EPOCH = 1420070400000n;
const DAY_MS = 86_400_000;
/** How far ahead of the moment it is sent an ENTITLEMENT_UPDATE's `ends_at` lies under R1 `'future'`. */
export const FUTURE_END_MS = 60_000;
/** Entitlement types: a subscription purchase, and the two a test entitlement may carry (R9). */
export const ENTITLEMENT_TYPE = { APPLICATION_SUBSCRIPTION: 8, DEVELOPER_GIFT: 3, TEST_MODE_PURCHASE: 4 } as const;

type Obj = Record<string, any>;
type Order = 'asc' | 'desc';

/** The unconfirmed Discord behaviours (sheet P6, section 9). */
export interface DiscordSettings {
  /** R1: an ENTITLEMENT_UPDATE's `ends_at` at or before the moment it is sent, or later. */
  updateEndsAt: 'past' | 'future';
  /** R2: whether a read shows `ends_at` after the member cancels and before the end. */
  cancelShowsEndsAt: boolean;
  /** R3: Get Entitlement of a deleted entitlement answers a 2xx with `deleted: true`, or 404. */
  deletedRead: '200' | '404';
  /** R3: ids Discord answers 404 for while they are live. */
  notFoundLive: Set<string>;
  /** R4: whether List Entitlements includes test entitlements. */
  listsTests: boolean;
  /** R5: what `exclude_ended=true` drops: an `ends_at` already passed, or any `ends_at`. */
  excludeEnded: 'passed' | 'any';
  /** R6: the window of a page sent with no cursor; the order inside a page of each kind; one short page before the end. */
  firstWindow: 'oldest' | 'newest';
  sortFirst: Order;
  sortAfter: Order;
  sortBefore: Order;
  shortPageMidway: boolean;
  /** R7: which attached client receives an event: the first, or every one. */
  delivery: 'one' | 'every';
  /** R9: whether creating or deleting a test entitlement sends gateway events, and its `type`. */
  testEvents: boolean;
  testType: 3 | 4;
  /** R10: whether one user can hold two current entitlements of one SKU (the fake never refuses a purchase; rows read it). */
  allowTwin: boolean;
  /** R11: what this application's entitlement routes answer for a token of another application. */
  foreignApp: '401' | '403' | '404' | '200-empty';
  /** R12: how many seconds a read lags behind the changes. */
  staleReads: number;
  /** D-m: the order of an upgrade's or downgrade's two events. */
  upgradeOrder: 'create-first' | 'update-first';
}

/** Every setting at its worst case (sheet P6, section 10). */
export function worstSettings(): DiscordSettings {
  return {
    updateEndsAt: 'future',
    cancelShowsEndsAt: false,
    deletedRead: '404',
    notFoundLive: new Set(),
    listsTests: false,
    excludeEnded: 'any',
    firstWindow: 'newest',
    sortFirst: 'desc',
    sortAfter: 'desc',
    sortBefore: 'asc',
    shortPageMidway: true,
    delivery: 'one',
    testEvents: false,
    testType: 4,
    allowTwin: false,
    foreignApp: '200-empty',
    staleReads: 40,
    upgradeOrder: 'create-first',
  };
}

/** One entitlement as the fake holds it. Times are ms; null is "none". */
export interface FakeEntitlement {
  id: string;
  skuId: string;
  applicationId: string;
  /** The user granted the entitlement; for a server entitlement bought by a user, that user. */
  userId: string | null;
  guildId: string | null;
  type: number;
  test: boolean;
  startsAt: number | null;
  endsAt: number | null;
  deleted: boolean;
  consumed: boolean;
  /** The end of the current billing period (a test entitlement has none). */
  periodEnd: number | null;
  /** The member cancelled (D-d) and has not resumed. */
  cancelled: boolean;
  /** Each change: its time and the entitlement object Discord shows from then on. */
  history: Array<{ at: number; json: Obj }>;
}

export type GatewayEventName = 'entitlementCreate' | 'entitlementUpdate' | 'entitlementDelete';
/** One gateway event the fake queued: the raw entitlement object Discord sends, as it was when the action ran. */
export interface QueuedEvent { name: GatewayEventName; data: Obj; entitlementId: string; queuedAt: number }

/** One call the fake received, in order. `path` holds the query. */
export interface DiscordCall { method: string; path: string; route: RouteKind | null; token: string | null; at: number; status: number | 'no-answer' | 'aborted' | 'thrown' }
export type RouteKind = 'me' | 'list' | 'single' | 'skus';

/** A failure a route answers with: a status (429 carries Discord's retry body), no answer until the caller aborts, or a body that is not what the route sends. */
export type DiscordFault =
  | { status: number }
  | { noAnswer: true }
  | { body: 'object' | 'text' };

interface Rule { route: RouteKind | RegExp; times: number }
interface FaultRule extends Rule { fault: DiscordFault }
interface SlowRule extends Rule { ms: number }
interface HoldRule extends Rule { gate: Promise<void>; reached: () => void }

/** Discord's timestamp format, with microseconds: 2026-11-23T12:00:00.734000+00:00. */
export function discordTime(ms: number): string {
  return new Date(ms).toISOString().replace(/Z$/, '000+00:00');
}

/** The smallest snowflake of an instant (ms), as a string. */
export function snowflakeAt(ms: number): string {
  return ((BigInt(ms) - DISCORD_EPOCH) << 22n).toString();
}

class Answer {
  constructor(readonly status: number, readonly body: unknown, readonly headers: Record<string, string> = {}) {}
}

const discordError = (status: number, message: string, code: number): Answer => new Answer(status, { message, code });
const ROUTE_OF: Record<RouteKind, RegExp> = {
  me: /^\/applications\/@me$/,
  list: /^\/applications\/\d+\/entitlements$/,
  single: /^\/applications\/\d+\/entitlements\/[^/]+$/,
  skus: /^\/applications\/\d+\/skus$/,
};
const LIST_QUERY = new Set(['user_id', 'sku_ids', 'before', 'after', 'limit', 'guild_id', 'exclude_ended', 'exclude_deleted']);

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) return headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
  const found = Object.entries(headers as Record<string, string>).find(([k]) => k.toLowerCase() === name);
  return found ? found[1] : null;
}

export class FakeDiscord {
  readonly settings: DiscordSettings;
  readonly calls: DiscordCall[] = [];
  /** Calls to an address, route or method the fake does not serve. */
  readonly unexpected: string[] = [];
  readonly entitlements = new Map<string, FakeEntitlement>();
  /** Events not yet delivered, oldest first. */
  readonly queue: QueuedEvent[] = [];
  /** Every event delivered, in order. */
  readonly delivered: QueuedEvent[] = [];
  /** Token to application id. */
  readonly apps = new Map<string, string>([[BOT_TOKEN, APP_ID]]);
  readonly skus = new Map<string, Obj>();
  private readonly clients: Client[] = [];
  /** Ids List Entitlements leaves out (a window a read does not reach, R6); single reads still answer them. */
  readonly hiddenFromList = new Set<string>();
  private faults: FaultRule[] = [];
  private slows: SlowRule[] = [];
  private holds: HoldRule[] = [];
  private answerHolds: HoldRule[] = [];
  private counter = 0n;
  private shortUsed = false;

  constructor(settings: Partial<DiscordSettings> = {}) {
    this.settings = { ...worstSettings(), ...settings };
    for (const [name, id] of Object.entries(SKU)) {
      this.skus.set(id, { id, type: 5, dependent_sku_id: null, application_id: APP_ID, access_type: 1, name: `SKU ${name}`, slug: `sku-${name.toLowerCase()}`, flags: 1 << 8 });
    }
  }

  /** Installs the fake as the global fetch. */
  install(): this {
    vi.stubGlobal('fetch', vi.fn((url: unknown, init?: RequestInit) => this.fetch(String(url), init)));
    return this;
  }

  // ---------------------------------------------------------------------------- the gateway

  /** A client the fake delivers events to (R7: the first one, or every one). It gets an application, as a ready client has. */
  attach(client: Client): void {
    const c = client as any;
    c.application ??= new (ClientApplication as any)(client, { id: APP_ID });
    this.clients.push(client);
  }

  detach(client: Client): void {
    const at = this.clients.indexOf(client);
    if (at >= 0) this.clients.splice(at, 1);
  }

  /** Delivers the queued event at `index` (the oldest by default) through discord.js's action; null with none queued. */
  deliver(index = 0): QueuedEvent | null {
    const [event] = this.queue.splice(index, 1);
    if (!event) return null;
    const targets = this.settings.delivery === 'every' ? [...this.clients] : this.clients.slice(0, 1);
    const action = { entitlementCreate: 'EntitlementCreate', entitlementUpdate: 'EntitlementUpdate', entitlementDelete: 'EntitlementDelete' }[event.name];
    this.delivered.push(event);
    for (const client of targets) (client as any).actions[action].handle(structuredClone(event.data));
    return event;
  }

  /** Delivers every queued event, the oldest first. */
  deliverAll(): QueuedEvent[] {
    const out: QueuedEvent[] = [];
    for (let guard = 0; this.queue.length > 0; guard++) {
      if (guard > 10_000) throw new Error('p6Discord.deliverAll: the queue does not empty');
      const event = this.deliver(0);
      if (event) out.push(event);
    }
    return out;
  }

  /** The queued event at `index` is lost (R8: a Resume does not replay it). */
  drop(index = 0): QueuedEvent | null {
    return this.queue.splice(index, 1)[0] ?? null;
  }

  /** The queued event at `index` is sent twice: a copy right after it. */
  duplicate(index = 0): void {
    const event = this.queue[index];
    if (event) this.queue.splice(index + 1, 0, { ...event, data: structuredClone(event.data) });
  }

  /** The queued event at `from` moves to `to`. */
  reorder(from: number, to: number): void {
    const [event] = this.queue.splice(from, 1);
    if (event) this.queue.splice(Math.min(to, this.queue.length), 0, event);
  }

  // ---------------------------------------------------------------------------- Discord-side actions

  private nextId(): string {
    this.counter += 1n;
    return (((BigInt(Date.now()) - DISCORD_EPOCH) << 22n) | (this.counter & 0x3fffffn)).toString();
  }

  /** The entitlement object Discord shows: a test entitlement has no dates (D-i), a user one no guild_id. */
  jsonOf(ent: FakeEntitlement): Obj {
    return {
      id: ent.id,
      sku_id: ent.skuId,
      application_id: ent.applicationId,
      ...(ent.userId !== null ? { user_id: ent.userId } : {}),
      ...(ent.guildId !== null ? { guild_id: ent.guildId } : {}),
      type: ent.type,
      deleted: ent.deleted,
      ...(ent.test ? {} : {
        starts_at: ent.startsAt === null ? null : discordTime(ent.startsAt),
        ends_at: ent.endsAt === null ? null : discordTime(ent.endsAt),
      }),
      consumed: ent.consumed,
    };
  }

  private changed(ent: FakeEntitlement): void {
    ent.history.push({ at: Date.now(), json: this.jsonOf(ent) });
  }

  private queueEvent(name: GatewayEventName, ent: FakeEntitlement): void {
    this.queue.push({ name, data: this.jsonOf(ent), entitlementId: ent.id, queuedAt: Date.now() });
  }

  private add(fields: Pick<FakeEntitlement, 'skuId' | 'userId' | 'guildId' | 'type' | 'test'>): FakeEntitlement {
    const now = Date.now();
    const ent: FakeEntitlement = {
      id: this.nextId(),
      applicationId: APP_ID,
      startsAt: fields.test ? null : now,
      endsAt: null,
      deleted: false,
      consumed: false,
      periodEnd: fields.test ? null : now + 30 * DAY_MS,
      cancelled: false,
      history: [],
      ...fields,
    };
    this.entitlements.set(ent.id, ent);
    this.changed(ent);
    return ent;
  }

  private ent(id: string | FakeEntitlement): FakeEntitlement {
    const ent = typeof id === 'string' ? this.entitlements.get(id) : id;
    if (!ent) throw new Error(`p6Discord: no entitlement ${String(id)}`);
    return ent;
  }

  /** A member buys a user subscription (with `guildId`, a server subscription bought by that user). */
  purchase(userId: string, skuId: string, opts: { guildId?: string } = {}): FakeEntitlement {
    const ent = this.add({ skuId, userId, guildId: opts.guildId ?? null, type: ENTITLEMENT_TYPE.APPLICATION_SUBSCRIPTION, test: false });
    this.queueEvent('entitlementCreate', ent);
    return ent;
  }

  /** A test entitlement for a user or a server (D-i): no dates; events only under R9 `testEvents`. */
  testGrant(owner: { userId: string } | { guildId: string }, skuId: string): FakeEntitlement {
    const ent = this.add({
      skuId,
      userId: 'userId' in owner ? owner.userId : null,
      guildId: 'guildId' in owner ? owner.guildId : null,
      type: this.settings.testType,
      test: true,
    });
    if (this.settings.testEvents) this.queueEvent('entitlementCreate', ent);
    return ent;
  }

  /** The subscription ends at `time` (D-e): `ends_at` set and an ENTITLEMENT_UPDATE. */
  endAt(id: string | FakeEntitlement, time: number): void {
    const ent = this.ent(id);
    ent.endsAt = time;
    this.changed(ent);
    this.queueEvent('entitlementUpdate', ent);
  }

  private remove(id: string | FakeEntitlement, event: boolean): void {
    const ent = this.ent(id);
    ent.deleted = true;
    this.changed(ent);
    if (event) this.queueEvent('entitlementDelete', ent);
  }

  /** Discord refunds the subscription (D-f). */
  refund(id: string | FakeEntitlement): void {
    this.remove(id, true);
  }

  /** Discord removes the entitlement with its internal tooling (D-f). */
  removeByTooling(id: string | FakeEntitlement): void {
    this.remove(id, true);
  }

  /** The app's test entitlement is deleted through the API (D-i); its event only under R9 `testEvents`. */
  deleteTest(id: string | FakeEntitlement): void {
    const ent = this.ent(id);
    if (!ent.test) throw new Error(`p6Discord.deleteTest: ${ent.id} is not a test entitlement`);
    this.remove(ent, this.settings.testEvents);
  }

  /** The member cancels (D-d): no event; under R2 `cancelShowsEndsAt` reads show the period's end as `ends_at`. */
  memberCancel(id: string | FakeEntitlement): void {
    const ent = this.ent(id);
    ent.cancelled = true;
    if (this.settings.cancelShowsEndsAt && ent.periodEnd !== null) {
      while (ent.periodEnd <= Date.now()) ent.periodEnd += 30 * DAY_MS;
      ent.endsAt = ent.periodEnd;
      this.changed(ent);
    }
  }

  /** The member resumes before the period's end (D-d): no entitlement event; what memberCancel showed is cleared. */
  memberResume(id: string | FakeEntitlement): void {
    const ent = this.ent(id);
    if (!ent.cancelled) return;
    ent.cancelled = false;
    if (this.settings.cancelShowsEndsAt) {
      ent.endsAt = null;
      this.changed(ent);
    }
  }

  /** The end time an ENTITLEMENT_UPDATE sent now carries under R1. */
  updateEnd(): number {
    return this.settings.updateEndsAt === 'future' ? Date.now() + FUTURE_END_MS : Date.now();
  }

  private planChange(id: string | FakeEntitlement, skuId: string): FakeEntitlement {
    const old = this.ent(id);
    old.endsAt = this.updateEnd();
    this.changed(old);
    const made = this.add({ skuId, userId: old.userId, guildId: old.guildId, type: ENTITLEMENT_TYPE.APPLICATION_SUBSCRIPTION, test: false });
    if (this.settings.upgradeOrder === 'create-first') {
      this.queueEvent('entitlementCreate', made);
      this.queueEvent('entitlementUpdate', old);
    } else {
      this.queueEvent('entitlementUpdate', old);
      this.queueEvent('entitlementCreate', made);
    }
    return made;
  }

  /** An upgrade (D-m): the old entitlement ends now (R1) and a new one is made for `skuId`; events in `upgradeOrder`. */
  upgrade(id: string | FakeEntitlement, skuId: string): FakeEntitlement {
    return this.planChange(id, skuId);
  }

  /** A downgrade (D-m), run at the period's end: the same pair of changes and events as an upgrade. */
  downgrade(id: string | FakeEntitlement, skuId: string): FakeEntitlement {
    return this.planChange(id, skuId);
  }

  /** R13: an ended entitlement becomes current again (`ends_at` cleared, not deleted), with no event. */
  revive(id: string | FakeEntitlement): void {
    const ent = this.ent(id);
    ent.endsAt = null;
    ent.deleted = false;
    this.changed(ent);
  }

  /** A second application with its own token; the caller switches the bot's token to it. */
  rotateApp(): { applicationId: string; token: string } {
    this.apps.set(SECOND_TOKEN, SECOND_APP_ID);
    return { applicationId: SECOND_APP_ID, token: SECOND_TOKEN };
  }

  /** Whether Discord holds the entitlement as current now: not deleted, `ends_at` none or ahead. */
  isCurrent(id: string | FakeEntitlement, now = Date.now()): boolean {
    const ent = this.ent(id);
    return !ent.deleted && (ent.endsAt === null || ent.endsAt > now);
  }

  // ---------------------------------------------------------------------------- faults, slow answers and holds

  /** The next `times` calls of the route answer with the fault. */
  fail(route: RouteKind | RegExp, fault: DiscordFault, times = 1): void {
    this.faults.push({ route, fault, times });
  }

  /** The next `times` calls of the route answer `ms` later (an abort of the caller's signal ends the wait). */
  slow(route: RouteKind | RegExp, ms: number, times = 1): void {
    this.slows.push({ route, ms, times });
  }

  /** Drops every fault and slow answer not yet used. */
  clearFaults(): void {
    this.faults = [];
    this.slows = [];
  }

  /** The entitlement now names another user (or, with null, no user): a stored record that no longer matches Discord. */
  reassign(id: string | FakeEntitlement, userId: string | null, guildId: string | null = null): void {
    const ent = this.ent(id);
    ent.userId = userId;
    ent.guildId = guildId;
    this.changed(ent);
  }

  /** A page of the list, made as the fake makes it, then changed by `edit` before it is sent (a page Discord got wrong). */
  editListPages(edit: (page: Obj[], query: URLSearchParams) => Obj[]): void {
    const list = this.list.bind(this);
    (this as any).list = (appId: string, query: URLSearchParams): Answer => {
      const answer = list(appId, query);
      return Array.isArray(answer.body) ? new Answer(answer.status, edit(answer.body as Obj[], query), answer.headers) : answer;
    };
  }

  /**
   * The next call of the route waits, before the fake acts on it, until the row calls `release`; `reached` resolves
   * when the call arrives. An abort of the caller's signal ends the wait with the abort's reason.
   */
  hold(route: RouteKind | RegExp): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const arrived = new Promise<void>(resolve => { reached = resolve; });
    this.holds.push({ route, gate, reached, times: 1 });
    return { reached: arrived, release };
  }

  /**
   * The next call of the route is answered as Discord is now, and the answer waits until the row calls `release`
   * (`reached` resolves when the answer is made): what the bot reads is from before whatever the row does meanwhile.
   */
  holdAnswer(route: RouteKind | RegExp): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const arrived = new Promise<void>(resolve => { reached = resolve; });
    this.answerHolds.push({ route, gate, reached, times: 1 });
    return { reached: arrived, release };
  }

  private take<T extends Rule>(list: T[], route: RouteKind | null, path: string): T | null {
    const rule = list.find(r => r.times > 0 && (typeof r.route === 'string' ? r.route === route : r.route.test(path)));
    if (!rule) return null;
    rule.times -= 1;
    return rule;
  }

  // ---------------------------------------------------------------------------- the transport

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!url.startsWith(`${DISCORD_API}/`)) {
      this.unexpected.push(`${method} ${url}`);
      throw new TypeError(`p6Discord: no route outside Discord's API: ${method} ${url}`);
    }
    const path = url.slice(DISCORD_API.length);
    const bare = path.split('?')[0];
    const route = (Object.keys(ROUTE_OF) as RouteKind[]).find(k => ROUTE_OF[k].test(bare)) ?? null;
    const auth = headerOf(init, 'authorization');
    const token = auth?.startsWith('Bot ') ? auth.slice(4) : null;
    const call: DiscordCall = { method, path, route, token, at: Date.now(), status: 'thrown' };
    this.calls.push(call);
    if (method !== 'GET' || route === null) {
      this.unexpected.push(`${method} ${path}`);
      throw new TypeError(`p6Discord: the fake does not serve ${method} ${path}`);
    }
    const signal = init?.signal ?? null;
    const wait = (until: Promise<void>): Promise<void> => new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      void until.then(resolve);
    });
    let fault: DiscordFault | null = null;
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
      answer = fault ? this.faultAnswer(fault) : this.answerFor(route, path, token);
    } catch (error) {
      this.unexpected.push(`${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    const heldAnswer = this.take(this.answerHolds, route, path);
    if (heldAnswer) {
      const body = structuredClone(answer.body);
      answer = new Answer(answer.status, body, answer.headers);
      heldAnswer.reached();
      try {
        await wait(heldAnswer.gate);
      } catch (error) {
        call.status = 'aborted';
        throw error;
      }
    }
    call.status = answer.status;
    return this.respond(answer);
  }

  private faultAnswer(fault: DiscordFault): Answer {
    if ('body' in fault) return fault.body === 'object' ? new Answer(200, { entitlements: [] }) : new Answer(200, '<html>bad gateway</html>');
    if (!('status' in fault)) throw new Error('p6Discord: a fault without an answer');
    if (fault.status === 429) return new Answer(429, { message: 'You are being rate limited.', retry_after: 1.5, global: false }, { 'retry-after': '2' });
    if (fault.status === 401) return discordError(401, '401: Unauthorized', 0);
    if (fault.status === 403) return discordError(403, 'Missing Access', 50001);
    if (fault.status === 404) return discordError(404, '404: Not Found', 0);
    return fault.status >= 500 ? new Answer(fault.status, { message: 'Internal Server Error', code: 0 }) : discordError(fault.status, 'Bad Request', 50035);
  }

  private respond(answer: Answer): Response {
    const headers = { ...answer.headers };
    if (typeof answer.body === 'string') return new Response(answer.body, { status: answer.status, headers: { ...headers, 'content-type': 'text/html' } });
    if (answer.body === null) return new Response(null, { status: answer.status, headers });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { ...headers, 'content-type': 'application/json' } });
  }

  private answerFor(route: RouteKind, path: string, token: string | null): Answer {
    const tokenApp = token === null ? undefined : this.apps.get(token);
    if (tokenApp === undefined) return discordError(401, '401: Unauthorized', 0);
    const bare = path.split('?')[0];
    if (route === 'me') return new Answer(200, { id: tokenApp, name: tokenApp === APP_ID ? 'P6 bot' : 'P6 second bot', bot_public: true, bot_require_code_grant: false, flags: 0 });
    const routeApp = bare.split('/')[2];
    if (routeApp !== tokenApp) {
      const foreign = this.settings.foreignApp;
      if (foreign === '401') return discordError(401, '401: Unauthorized', 0);
      if (foreign === '403') return discordError(403, 'Missing Access', 50001);
      if (foreign === '404') return discordError(404, 'Unknown Application', 10002);
      return route === 'list' ? new Answer(200, []) : route === 'skus' ? new Answer(200, []) : discordError(404, 'Unknown Entitlement', 10069);
    }
    if (route === 'skus') return new Answer(200, [...this.skus.values()].filter(s => s.application_id === routeApp));
    if (route === 'single') return this.single(decodeURIComponent(bare.split('/')[4]));
    return this.list(routeApp, new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?') + 1) : ''));
  }

  /** What a read made now shows of the entitlement (R12: the state `staleReads` seconds ago); null when it did not exist then. */
  private seen(ent: FakeEntitlement): Obj | null {
    const asOf = Date.now() - this.settings.staleReads * 1000;
    let shown: Obj | null = null;
    for (const step of ent.history) if (step.at <= asOf) shown = step.json;
    return shown;
  }

  private single(id: string): Answer {
    const ent = this.entitlements.get(id);
    const shown = ent ? this.seen(ent) : null;
    if (!ent || !shown || this.settings.notFoundLive.has(id)) return discordError(404, 'Unknown Entitlement', 10069);
    if (shown.deleted && this.settings.deletedRead === '404') return discordError(404, 'Unknown Entitlement', 10069);
    return new Answer(200, structuredClone(shown));
  }

  private list(appId: string, query: URLSearchParams): Answer {
    for (const key of query.keys()) if (!LIST_QUERY.has(key)) return discordError(400, 'Invalid Form Body', 50035);
    const limit = query.has('limit') ? Number(query.get('limit')) : 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return discordError(400, 'Invalid Form Body', 50035);
    const before = query.get('before');
    const after = query.get('after');
    if (before !== null && after !== null) return discordError(400, 'Invalid Form Body', 50035);
    const now = Date.now();
    const excludeEnded = query.get('exclude_ended') === 'true';
    const excludeDeleted = query.get('exclude_deleted') !== 'false';
    const users = query.get('user_id');
    const guild = query.get('guild_id');
    const skuIds = query.get('sku_ids')?.split(',') ?? null;
    const visible: Obj[] = [];
    for (const ent of this.entitlements.values()) {
      if (ent.applicationId !== appId) continue;
      if (ent.test && !this.settings.listsTests) continue;
      if (this.hiddenFromList.has(ent.id)) continue;
      const shown = this.seen(ent);
      if (!shown) continue;
      if (excludeDeleted && shown.deleted) continue;
      if (excludeEnded && shown.ends_at) {
        const ends = Date.parse(shown.ends_at);
        if (this.settings.excludeEnded === 'any' || ends <= now) continue;
      }
      if (users !== null && shown.user_id !== users) continue;
      if (guild !== null && shown.guild_id !== guild) continue;
      if (skuIds && !skuIds.includes(shown.sku_id)) continue;
      visible.push(structuredClone(shown));
    }
    visible.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    let side: Obj[];
    let order: Order;
    let fromStart: boolean;
    let firstOfRead = false;
    if (after !== null) {
      side = visible.filter(e => BigInt(e.id) > BigInt(after));
      order = this.settings.sortAfter;
      fromStart = true;
    } else if (before !== null) {
      side = visible.filter(e => BigInt(e.id) < BigInt(before));
      order = this.settings.sortBefore;
      fromStart = false;
      firstOfRead = side.length === visible.length;
    } else {
      side = visible;
      order = this.settings.sortFirst;
      fromStart = this.settings.firstWindow === 'oldest';
      firstOfRead = true;
    }
    if (firstOfRead) this.shortUsed = false;
    let size = Math.min(limit, side.length);
    // The short page comes after a read's first page, with more left beyond it: a page short of the limit midway.
    if (this.settings.shortPageMidway && !this.shortUsed && !firstOfRead && side.length > limit && size === limit) {
      size = limit - 1;
      this.shortUsed = true;
    }
    const page = fromStart ? side.slice(0, size) : side.slice(side.length - size);
    if (order === 'desc') page.reverse();
    return new Answer(200, page);
  }
}
