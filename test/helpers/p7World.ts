import fs from 'fs';
import { DiscordAPIError } from 'discord.js';
import { vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { getPremiumManager, resetPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { PatreonProvider } from '../../src/bot/internalSetup/utils/payment/patreonProvider';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { acceptedOpsRunning, maintenanceText, orderRefusesSharedOps } from '../../src/bot/internalSetup/utils/maintenanceGate';
import type { FollowAnswer, PaymentProvider, ProviderCapabilities } from '../../src/bot/internalSetup/utils/payment/paymentTypes';
import { notices } from './p1Mocks';
import { AUDIT_KEY, PREMIUM_KEY, premiumRig } from './nb6PremiumRig';
import {
  CAMPAIGN_ID, CLIENT_ID, CLIENT_SECRET, CREATOR_TOKEN, FakePatreon, PTIER, TIER_AMOUNT, TIER_TITLE, WEBHOOK_SECRET,
  type PatreonSettings, type Posted,
} from './p7Patreon';

// P7's world (sheet P7, section 10): the real PremiumManager in the bot role over the JSON files, or as p7World('rig')
// over the mirror rig of helpers/nb6PremiumRig.ts; the registry with the real PatreonProvider and the Dummy (and, with
// `faked`, the faked provider part 1's rows use, D8); Patreon's credentials in the environment (the five keys of
// section 6, and the webhook secret unless `webhook` is false); premium with two user tiers of different priority and
// two server tiers, their offerings wired to Patreon tiers A and A2 (the lower user tier), B (the higher user tier), S
// and A (the lower server tier) and B (the higher server tier); the fake of helpers/p7Patreon.ts behind the global
// fetch, its deliveries posted the way the web UI's webhook route posts them (srv:99-142: no handler answers 404, the
// payment.webhook op, hop's webhookAnswer); a signed-in session per Discord user on the member routes; a faked
// discord.js client whose `guilds.fetch` answers an owner per server, Unknown Guild, Missing Access, a failure or no
// answer; the clock (Date and the timers, faked); and `restart()`, a new bot process on the stored files.
//
// A test file that uses it mocks the registry and the notices with helpers/p1Mocks.ts, as p6World's files do. The user
// tiers' Patreon links are enabled only when Patreon sells users (setTier refuses an enabled link of a provider that
// does not), so the world sets up on every build. Every process of the world starts premium's tickers as the bot does
// (startPremiumTickers: the minute checker and each provider's start()); the faked timers run them only while the
// world's clock moves.

/** The Discord users of a row; the Patreon user at the same index of PATREON_USERS is each one's Patreon account. */
export const USERS = ['86700000000000001', '86700000000000002', '86700000000000003'] as const;
/** One server owned by each user, at the same index. */
export const GUILDS = ['86800000000000001', '86800000000000002', '86800000000000003'] as const;
export const BASE_URL = 'https://bot.example';
export const CALLBACK_PATH = '/guild/api/subscriptions/patreon/callback';
export const OAUTH_CALLBACK = `${BASE_URL}/auth/discord/callback`;
export const START = Date.parse('2026-11-23T12:00:00.000Z');
/** THE LAG RULE's window. */
export const W_MS = 10 * 60_000;

export type P7TierId = 'vip' | 'star' | 'gold' | 'platinum';
export const KIND: Record<P7TierId, 'user' | 'guild'> = { vip: 'user', star: 'user', gold: 'guild', platinum: 'guild' };
export const PRIORITY: Record<P7TierId, number> = { vip: 1, star: 2, gold: 1, platinum: 2 };
/** Each tier's offerings and the Patreon tiers each sells. */
export const OFFERINGS: Record<P7TierId, Array<{ id: string; label: string; ptiers: string[] }>> = {
  vip: [{ id: 'o-a', label: 'VIP', ptiers: [PTIER.A] }, { id: 'o-a2', label: 'VIP plus', ptiers: [PTIER.A2] }],
  star: [{ id: 'o-b', label: 'Star', ptiers: [PTIER.B] }],
  gold: [{ id: 'o-s', label: 'Gold', ptiers: [PTIER.S] }, { id: 'o-sa', label: 'Gold from A', ptiers: [PTIER.A] }],
  platinum: [{ id: 'o-sb', label: 'Platinum', ptiers: [PTIER.B] }],
};
/** The premium tier a Patreon tier gives a holder of each kind; absent where none is wired. */
export const WIRING: Record<'user' | 'guild', Record<string, P7TierId>> = {
  user: { [PTIER.A]: 'vip', [PTIER.A2]: 'vip', [PTIER.B]: 'star' },
  guild: { [PTIER.S]: 'gold', [PTIER.A]: 'gold', [PTIER.B]: 'platinum' },
};
/** The faked provider's id (part 1's rows, D8). */
export const FOLLOWER_ID = 'follower';
export const FOLLOWER_ENDED_TEXT = 'The faked provider manages this subscription, so the bot cannot end or remove it.';
export const FOLLOWER_QUEUED_TEXT = 'The faked provider keeps charging it while it waits.';

export const variantOf = (ptier: string) => ({ variantId: `tier:${ptier}`, label: TIER_TITLE[ptier] ?? ptier, amount: TIER_AMOUNT[ptier] ?? 0, currency: 'USD', durationDays: 30, recurring: true, active: true });

/** A provider link that sells the Patreon tiers (variant `tier:<id>`), as the panel saves one. */
export const providerLink = (providerId: string, ptiers: string[], enabled = true) => ({
  providerId,
  enabled,
  mode: 'price',
  priceConfig: { entries: ptiers.map(t => ({ variantId: `tier:${t}` })) },
  cache: { syncedAt: '2026-11-22T00:00:00.000Z', variants: ptiers.map(variantOf) },
});

/** A tier as setTier takes it; `patreonEnabled` sets its Patreon links, `follower` adds the faked provider's. */
export function tierDefOf(tierId: P7TierId, patreonEnabled: boolean, follower: boolean) {
  const names: Record<P7TierId, string> = { vip: 'VIP', star: 'Star', gold: 'Gold', platinum: 'Platinum' };
  return {
    displayName: names[tierId],
    priority: PRIORITY[tierId],
    overrides: {},
    kind: KIND[tierId],
    offerings: OFFERINGS[tierId].map(o => ({
      id: o.id,
      label: o.label,
      providerLinks: [providerLink('patreon', o.ptiers, patreonEnabled), ...(follower ? [providerLink(FOLLOWER_ID, o.ptiers, true)] : [])],
    })),
  };
}

export interface OpReply { ok: boolean; result?: any; error?: string; code?: string }
/** A member route's answer: its status, its JSON or HTML body, and where it redirected. */
export interface RouteAnswer { status: number; body: any; html: string | null; redirect: string | null }
/** One Patreon record premium holds, with its holder, where it sits and its providerSubId's parts. */
export interface HeldPatreon { holder: string; sub: any; location: 'active' | 'paused'; memberId: string | null; ptier: string | null }

/** The name Discord shows for a server of the row: `Server <n>` for GUILDS[n - 1]. */
export const guildName = (guild: string): string => `Server ${GUILDS.indexOf(guild as typeof GUILDS[number]) + 1}`;

/** What the faked Discord client answers for a server: its owner, Unknown Guild, Missing Access, a failure, or nothing. */
export type GuildAnswer = { ownerId: string } | 'unknown' | 'missing' | 'fail' | 'hang';

/** The faked discord.js client the owner check asks (4.3): `guilds.fetch({ guild, force })` per server. */
export class FakeGuildClient {
  readonly answers = new Map<string, GuildAnswer>();
  readonly fetches: Array<{ guild: string; force: boolean; at: number }> = [];
  readonly guilds = {
    fetch: (opts: { guild: string; force?: boolean } | string): Promise<{ id: string; ownerId: string }> => {
      const guild = typeof opts === 'string' ? opts : String(opts.guild);
      this.fetches.push({ guild, force: typeof opts === 'string' ? false : opts.force === true, at: Date.now() });
      const answer = this.answers.get(guild) ?? 'unknown';
      const route = `/guilds/${guild}`;
      if (answer === 'hang') return new Promise(() => undefined);
      if (answer === 'fail') return Promise.reject(new Error('connect ECONNRESET'));
      if (answer === 'unknown') return Promise.reject(new DiscordAPIError({ message: 'Unknown Guild', code: 10004 }, 10004, 404, 'GET', route, {}));
      if (answer === 'missing') return Promise.reject(new DiscordAPIError({ message: 'Missing Access', code: 50001 }, 50001, 403, 'GET', route, {}));
      return Promise.resolve({ id: guild, ownerId: answer.ownerId, name: guildName(guild) });
    },
  };

  constructor() {
    GUILDS.forEach((g, i) => this.answers.set(g, { ownerId: USERS[i] }));
  }
}

const FOLLOWER_CAPABILITIES: ProviderCapabilities = {
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
  variantIdLabel: 'Faked tier id',
  productIdLabel: '',
  sells: ['guild', 'user'],
  endedByProviderOnly: true,
  billedWhileQueued: true,
};

/**
 * The faked provider of part 1's rows (D8): sells both kinds, declares `endedByProviderOnly`, `billedWhileQueued` and
 * the two capability strings part 1 adds (`endedByProviderText`, `queuedBilledText`), and follows a record unless its
 * `providerMeta.followed` is false. `install` emits a `subscription.created` the way P7's pp will (the tier from the
 * variant through premium's walk).
 */
export class FollowerProvider implements PaymentProvider {
  readonly id = FOLLOWER_ID;
  readonly displayName = 'Follower';
  readonly capabilities = { ...FOLLOWER_CAPABILITIES, endedByProviderText: FOLLOWER_ENDED_TEXT, queuedBilledText: FOLLOWER_QUEUED_TEXT } as ProviderCapabilities;
  private counter = 0;

  isConfigured(): boolean { return true; }
  getCredentialFields() { return []; }
  async initiatePurchase(): Promise<never> { throw new Error('The faked provider sells on its own site.'); }
  async fetchVariant(): Promise<null> { return null; }
  async getSubscriptionState(): Promise<null> { return null; }
  followsSubscription(sub: { providerMeta?: Record<string, any> }): FollowAnswer {
    return sub.providerMeta?.followed === false ? { followed: false, whyNot: 'not-configured' } : { followed: true };
  }

  /** Emits the install of `ptier` for the holder, bought by `buyerId`; the providerSubId it used. */
  install(holder: string, buyerId: string, ptier: string, meta: Record<string, any> = {}): string {
    const providerSubId = `follower:${++this.counter}:${ptier}`;
    getPaymentRegistry().emitEvent({
      type: 'subscription.created', providerId: FOLLOWER_ID, providerSubId, holder: holder as any, buyerId, tierId: '', offeringId: '',
      variantId: `tier:${ptier}`, soldVariantOnly: true, tierFromVariant: true,
      state: { status: 'active', startDate: '', endDate: null, autoRenew: true, meta },
    });
    return providerSubId;
  }

  /** Emits the end of a record it installed. */
  end(holder: string, providerSubId: string): void {
    getPaymentRegistry().emitEvent({
      type: 'subscription.expired', providerId: FOLLOWER_ID, providerSubId, holder: holder as any,
      state: { status: 'expired', startDate: '', endDate: new Date().toISOString(), autoRenew: false },
    });
  }
}

const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number): Promise<void> => new Promise<void>(resolve => { realSetTimeout(resolve, ms); });

const ENV_KEYS = [
  'PATREON_CLIENT_ID', 'PATREON_CLIENT_SECRET', 'PATREON_CAMPAIGN_ID', 'PATREON_CREATOR_ACCESS_TOKEN', 'PATREON_WEBHOOK_SECRET',
  'WEBUI_BASE_URL', 'OAUTH_CALLBACK_URL', 'BOT_PROCESS_ROLE',
] as const;
const FAKED: Array<'Date' | 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'> = ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];

export interface P7Setup {
  settings?: Partial<PatreonSettings>;
  clock?: number;
  /** A webhook on Patreon and its secret saved (the default); false for neither. */
  webhook?: boolean;
  /** The faked provider registered, and its links on every offering. */
  faked?: boolean;
  /** Keys set, or removed (undefined), after the defaults. */
  env?: Record<string, string | undefined>;
}

export function p7World(backend: 'json' | 'rig' = 'json') {
  const rig = backend === 'rig' ? premiumRig() : null;
  const saved: Record<string, string | undefined> = {};
  let fake = new FakePatreon();
  let provider: PatreonProvider | null = null;
  let follower: FollowerProvider | null = null;
  let guildClient = new FakeGuildClient();
  let withFollower = false;
  const emitted: any[] = [];
  const logs: string[] = [];
  let spies: Array<{ mockRestore: () => void }> = [];
  let clockOn = false;
  /** How far the faked clock moves per pass of `pump` (1 ms; a row whose op waits tens of seconds raises it). */
  let pumpStep = 1;
  /** Each signed-in Discord user's session (kept across requests, as the session store keeps it). */
  const sessions = new Map<string, Record<string, any>>();

  /** Waits for the work while the faked clock follows real time (1 ms of real wait, then 1 ms of clock, per pass). */
  const pump = async <T>(work: Promise<T>): Promise<T> => {
    let done = false;
    const out = work.finally(() => { done = true; });
    for (let i = 0; !done; i++) {
      if (i > 30_000) throw new Error('p7World: an op or a flush did not finish within 30 s');
      if (i < 3) {
        await new Promise<void>(resolve => { setImmediate(resolve); });
        continue;
      }
      await realSleep(1);
      if (!done && clockOn) await vi.advanceTimersByTimeAsync(pumpStep);
    }
    return out;
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 50; i++) {
      await pump(flushAll());
      await new Promise<void>(resolve => { setImmediate(resolve); });
      if (clockOn) await vi.advanceTimersByTimeAsync(0);
      if (i >= 3 && (!rig || rowQueue.keys().length === 0)) break;
    }
    for (let i = 0; i < 200 && acceptedOpsRunning() > 0; i++) await new Promise<void>(resolve => { setImmediate(resolve); });
    await pump(flushAll());
  };
  const sharedOp = async (name: string, args: unknown): Promise<OpReply> => {
    // The bot's IPC handler (setupSharedOpsIPC) refuses every shared op while a save order holds, before the op runs.
    if (orderRefusesSharedOps()) return { ok: false, code: 'maintenance', error: maintenanceText() };
    const reply = await pump(applySharedOp({ op: name, args } as any)) as OpReply;
    await settle();
    return reply;
  };
  const op = (name: string, ...args: unknown[]): Promise<OpReply> => sharedOp(`premium.${name}`, { args });
  const storedText = (): string | null => {
    if (rig) return rig.m.state.rows.docs.get(PREMIUM_KEY)?.body.toString('utf8') ?? null;
    const file = dataPath('global', 'premium-tiers.json');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  };
  const auditText = (): string => {
    if (rig) return [...rig.m.state.rows.lines.values()].filter(l => l.key === AUDIT_KEY).sort((a, b) => a.seq - b.seq).map(l => l.line.toString('utf8')).join('\n');
    const file = dataPath('global', 'premium-tiers.audit.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  };
  const sellsUsers = (): boolean => getPaymentRegistry().get('patreon')?.capabilities.sells?.includes('user') === true;
  const botManager: any = {
    storeDocsFirst: async () => null,
    migrationRunning: () => null,
    isRunning: () => false,
    listLoadedModules: async () => null,
    runSharedOp: (name: string, args: unknown) => sharedOp(name, args),
  };

  /** The web UI's webhook route for Patreon (srv:99-142), as it handles one POST. */
  const postWebhook = async (body: string, headers: Record<string, string>): Promise<number> => {
    const target = getPaymentRegistry().get('patreon');
    if (!target || !target.handleWebhook) return 404;
    const raw = Buffer.from(body, 'utf8');
    const signature = headers['stripe-signature'] || headers['x-signature'] || headers['paypal-transmission-sig'] || '';
    const { recordWebhookDelivery, webhookDeliveryAnswered } = await import('../../src/webui/webhookDeliveries');
    let eventId: string | null = null;
    try { eventId = target.webhookEventId?.(raw, headers) ?? null; } catch { eventId = null; }
    if (eventId !== null && webhookDeliveryAnswered('patreon', eventId)) return 200;
    const reply = await sharedOp('payment.webhook', { providerId: 'patreon', body: raw.toString('base64'), signature, headers });
    const { webhookAnswer } = await import('../../src/webui/routes/hopFailure');
    const answer = webhookAnswer(reply);
    if (answer.status === 200 && eventId !== null) recordWebhookDelivery('patreon', eventId);
    return answer.status;
  };

  /**
   * A route of the member routes (routes/guildSubscriptions.ts), called as p5World calls one: the last handler, a
   * request with the signed-in user's session (null: signed out), and a response that records JSON, HTML and redirects.
   */
  const memberRoute = async (userId: string | null, method: string, routePath: string, req: Record<string, unknown> = {}): Promise<RouteAnswer> => {
    const { createGuildSubscriptionRoutes } = await import('../../src/webui/routes/guildSubscriptions');
    const router: any = createGuildSubscriptionRoutes(botManager);
    const layer = router.stack.find((l: any) => l.route && l.route.path === routePath && l.route.methods[method]);
    if (!layer) throw new Error(`p7World: no member route ${method} ${routePath}`);
    let session: Record<string, any> | undefined;
    if (userId !== null) {
      session = sessions.get(userId) ?? { passport: { user: { id: userId } } };
      session.save ??= (cb: (err?: unknown) => void) => cb();
      sessions.set(userId, session);
    }
    const sent: RouteAnswer[] = [];
    let code = 200;
    const res: any = {
      status(c: number) { code = c; return res; },
      type() { return res; },
      set() { return res; },
      setHeader() { return res; },
      json(payload: unknown) { sent.push({ status: code, body: payload, html: null, redirect: null }); return res; },
      send(payload: unknown) { sent.push({ status: code, body: payload, html: typeof payload === 'string' ? payload : null, redirect: null }); return res; },
      redirect(a: number | string, b?: string) {
        const to = typeof a === 'string' ? a : String(b);
        sent.push({ status: typeof a === 'number' ? a : 302, body: null, html: null, redirect: to });
        return res;
      },
    };
    const request = {
      query: {}, params: {}, body: {}, headers: { host: 'bot.example' }, protocol: 'https', hostname: 'bot.example', originalUrl: routePath,
      get: (name: string) => (name.toLowerCase() === 'host' ? 'bot.example' : undefined),
      user: userId === null ? undefined : { id: userId, username: `user-${userId}`, guilds: [] },
      isAuthenticated: () => userId !== null,
      session: session ?? { save: (cb: (err?: unknown) => void) => cb() },
      ...req,
    };
    const handlers = layer.route.stack;
    await pump(Promise.resolve(handlers[handlers.length - 1].handle(request, res, () => undefined)));
    await settle();
    if (sent.length !== 1) throw new Error(`p7World: ${method} ${routePath} answered ${sent.length} times`);
    return sent[0];
  };

  const boot = async (): Promise<void> => {
    (await import('../../src/bot/internalSetup/utils/payment/paymentRegistry') as any)._dropRegistry?.();
    const registry: any = getPaymentRegistry();
    provider = new PatreonProvider();
    (provider as unknown as { setClient?: (c: unknown) => void }).setClient?.(guildClient);
    registry.register(provider);
    registry.register(new DummyProvider());
    follower = withFollower ? new FollowerProvider() : null;
    if (follower) registry.register(follower);
    const emit = registry.emitEvent.bind(registry);
    registry.emitEvent = (event: any) => {
      emitted.push(event);
      return emit(event);
    };
    getPremiumManager();
    startPremiumTickers();
  };
  const halt = async (): Promise<void> => {
    await settle();
    getPaymentRegistry().unregister('patreon');
    getPaymentRegistry().unregister('dummy');
    if (follower) getPaymentRegistry().unregister(FOLLOWER_ID);
    provider = null;
    follower = null;
    resetPremiumManager();
  };

  const world = {
    rig,
    botManager,
    get fake(): FakePatreon { return fake; },
    get provider(): PatreonProvider {
      if (!provider) throw new Error('p7World: no bot process is running');
      return provider;
    },
    get follower(): FollowerProvider {
      if (!follower) throw new Error('p7World: the faked provider is not registered (setup with faked: true)');
      return follower;
    },
    get guildClient(): FakeGuildClient { return guildClient; },
    emitted,
    logs,
    sessions,
    settle,
    pump,
    op,
    sharedOp,
    memberRoute,
    postWebhook,
    storedText,
    stored: (): any => {
      const text = storedText();
      return text === null ? null : JSON.parse(text);
    },
    auditLines: (): any[] => auditText().split('\n').filter(l => l.trim()).map(l => JSON.parse(l)),
    notices: () => notices.sent,
    logged: (text: string): string[] => logs.filter(l => l.includes(text)),
    /** The faked clock moves `ms` per pass of `pump` until the next setup (1 by default). */
    setPumpStep(ms: number): void {
      pumpStep = ms;
    },

    /**
     * A new bot process on an empty data folder: the fake with `settings` (its redirect URI registered, a webhook
     * unless `webhook` is false), the credentials, the registry, premium with the tiers and Patreon activated, the
     * tickers. The clock starts at `clock` (START by default).
     */
    async setup(opts: P7Setup = {}): Promise<void> {
      for (const key of ENV_KEYS) saved[key] = process.env[key];
      logs.length = 0;
      pumpStep = 1;
      spies = (['log', 'warn', 'error', 'info'] as const).map(level => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      }));
      vi.useFakeTimers({ toFake: FAKED, now: opts.clock ?? START });
      clockOn = true;
      spies.push(vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
        return controller.signal;
      }));
      if (rig) {
        await rig.setup(true);
      } else {
        process.env.BOT_PROCESS_ROLE = 'bot';
        await settle();
        resetPremiumManager();
        fs.rmSync(dataPath('global'), { recursive: true, force: true });
        fs.mkdirSync(dataPath('global'), { recursive: true });
      }
      process.env.PATREON_CLIENT_ID = CLIENT_ID;
      process.env.PATREON_CLIENT_SECRET = CLIENT_SECRET;
      process.env.PATREON_CAMPAIGN_ID = CAMPAIGN_ID;
      process.env.PATREON_CREATOR_ACCESS_TOKEN = CREATOR_TOKEN;
      if (opts.webhook === false) delete process.env.PATREON_WEBHOOK_SECRET;
      else process.env.PATREON_WEBHOOK_SECRET = WEBHOOK_SECRET;
      process.env.WEBUI_BASE_URL = BASE_URL;
      process.env.OAUTH_CALLBACK_URL = OAUTH_CALLBACK;
      for (const [key, value] of Object.entries(opts.env ?? {})) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fake = new FakePatreon(opts.settings);
      fake.redirectUris.add(`${BASE_URL}${CALLBACK_PATH}`);
      if (opts.webhook !== false) fake.addWebhook(`${BASE_URL}/webhook/patreon`);
      fake.setPoster(postWebhook);
      fake.install();
      guildClient = new FakeGuildClient();
      withFollower = opts.faked === true;
      sessions.clear();
      notices.sent.length = 0;
      emitted.length = 0;
      await boot();
      for (const tierId of ['gold', 'platinum', 'vip', 'star'] as const) {
        const enabled = KIND[tierId] === 'guild' || sellsUsers();
        const set = await op('setTier', tierId, tierDefOf(tierId, enabled, withFollower));
        if (!set.ok) throw new Error(`p7World: setTier ${tierId} was not saved: ${set.error}`);
      }
      for (const id of ['patreon', ...(withFollower ? [FOLLOWER_ID] : [])]) {
        const activated = await op('setProviderActivation', id, true);
        if (!activated.ok) throw new Error(`p7World: ${id} was not activated: ${activated.error}`);
      }
    },
    async teardown(): Promise<void> {
      await halt();
      fake.setPoster(null);
      vi.unstubAllGlobals();
      if (rig) await rig.teardown();
      if (clockOn) {
        vi.useRealTimers();
        clockOn = false;
      }
      for (const spy of spies) spy.mockRestore();
      spies = [];
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    },
    /** A new bot process on the stored files: premium, the registry and the providers rebuilt; the fake stays. */
    async restart(): Promise<void> {
      await halt();
      await boot();
      await settle();
    },

    /** The clock and the timers move on by `ms` (rounds, re-reads and the minute checker run as they come due), then everything settles. */
    async advance(ms: number): Promise<void> {
      for (let left = ms; left > 0; left -= 60_000) {
        await vi.advanceTimersByTimeAsync(Math.min(left, 60_000));
        await pump(flushAll());
      }
      await settle();
    },
    async tick(): Promise<void> {
      (getPremiumManager() as any).checkExpiry();
      await settle();
    },
    /** The queued delivery at `index` posted to the app's route, then everything settles. */
    async deliver(index = 0): Promise<Posted[]> {
      const out = await pump(fake.deliver(index));
      await settle();
      return out;
    },
    /** Every queued delivery posted (R3 decides the order), each settled before the next. */
    async deliverAll(): Promise<Posted[]> {
      const out: Posted[] = [];
      for (let guard = 0; fake.queue.length > 0; guard++) {
        if (guard > 10_000) throw new Error('p7World.deliverAll: the queue does not empty');
        out.push(...await world.deliver(fake.settings.reorder ? fake.queue.length - 1 : 0));
      }
      return out;
    },
    /** A round of the Patreon provider, when this build has one (`checkNow`); false when it has none. */
    async round(): Promise<boolean> {
      const check = (provider as unknown as { checkNow?: () => Promise<unknown> } | null)?.checkNow;
      if (typeof check !== 'function') return false;
      await pump(Promise.resolve(check.call(provider)));
      await settle();
      return true;
    },
    /** A round started now while the clock moves on in steps of `stepMs`, until it ends or `maxMs` has passed; whether it ended. */
    async roundAdvancing(maxMs: number, stepMs = 1000): Promise<boolean> {
      const check = (provider as unknown as { checkNow?: () => Promise<unknown> } | null)?.checkNow;
      if (typeof check !== 'function') return false;
      let done = false;
      const running = Promise.resolve(check.call(provider)).finally(() => { done = true; });
      for (let moved = 0; !done && moved < maxMs; moved += stepMs) {
        await vi.advanceTimersByTimeAsync(stepMs);
        await pump(flushAll());
      }
      if (!done) return false;
      await running;
      await settle();
      return true;
    },
    /** The bot's Patreon keys set (undefined removes one); the fake stays. */
    setCredentials(creds: Record<string, string | undefined>): void {
      for (const [key, value] of Object.entries(creds)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
  return world;
}

export type P7World = ReturnType<typeof p7World>;

/** Premium's Patreon records in a stored document, each with its holder, where it sits and its providerSubId's parts. */
export function heldPatreon(doc: any): HeldPatreon[] {
  const found: HeldPatreon[] = [];
  const of = (holder: string, sub: any, location: 'active' | 'paused'): HeldPatreon => {
    const parts = String(sub.providerSubId ?? '').split(':');
    const three = parts.length === 3 && parts[0] === 'patreon';
    return { holder, sub, location, memberId: three ? parts[1] : null, ptier: three ? parts[2] : null };
  };
  for (const [holder, record] of Object.entries<any>(doc?.subscriptions ?? {})) {
    if (record.active?.providerId === 'patreon') found.push(of(holder, record.active, 'active'));
    for (const sub of record.paused ?? []) if (sub.providerId === 'patreon') found.push(of(holder, sub, 'paused'));
  }
  return found;
}

/** The stored Patreon links: Patreon user to `{ holder, buyerId }`. */
export function patreonLinks(doc: any): Record<string, { holder: string; buyerId: string }> {
  return { ...(doc?.providerAccountLinks?.patreon ?? {}) };
}
