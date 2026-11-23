import fs from 'fs';
import { vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { StripeProvider } from '../../src/bot/internalSetup/utils/payment/stripeProvider';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { createGuildSubscriptionRoutes } from '../../src/webui/routes/guildSubscriptions';
import { notices } from './p1Mocks';
import { AUDIT_KEY, PREMIUM_KEY, premiumRig } from './nb6PremiumRig';
import { FakeStripe, SECRET_KEY, WEBHOOK_SECRET, signWithPackage, type StripeEvent } from './p3Stripe';

// P3's world (sheet P3, section 7): the real PremiumManager in the bot role over the JSON files, or as p3World('rig')
// over the mirror rig of helpers/nb6PremiumRig.ts; the registry with the real StripeProvider, its keys and
// OAUTH_CALLBACK_URL; one server tier and one user tier, each with one offering that links one monthly and one
// one-time price; the fake of helpers/p3Stripe.ts behind the global fetch; purchases on the member route (gsub's
// handler, the buyer signed in) and on the dev routes; deliveries of the fake's events through payment.webhook.
//
// A test file that uses it mocks the registry and the notices with helpers/p1Mocks.ts, as p1World's files do. The dev
// routes are loaded only when a row buys on one; a file that does mocks appStoreManager as p1Routes.test.ts does.
// The user tier is saved only when Stripe sells users (setTier refuses an enabled link of a provider that does not).

/** The Discord ids of a row: each is a server and a user (sheet P3, claim 7's holders). */
export const IDS = ['81000000000000001', '81000000000000002'] as const;
export const OAUTH_CALLBACK = 'https://bot.example/oauth/callback';
export const HOST = 'https://bot.example';
/** The doc of section 3: a buyer's Discord id to that buyer's Stripe Customer. */
export const CUSTOMERS_KEY = 'global/payment-providers/stripe/customers.json';
export const customersPath = (): string => dataPath('global', 'payment-providers', 'stripe', 'customers.json');

/** The tiers: one per kind, each with one offering, `o-<tier>`. */
export const SERVER_TIER = 'gold';
export const USER_TIER = 'vip';
export const PRICES = {
  gold: { monthly: 'price_gold_month', once: 'price_gold_once' },
  vip: { monthly: 'price_vip_month', once: 'price_vip_once' },
} as const;
/** A recurring price of the account that no offering links, for a plan switch at Stripe. */
export const UNLINKED_PRICE = 'price_gold_other';
export type PriceKind = 'monthly' | 'once';

const tierOfHolder = (holder: string): 'gold' | 'vip' => (holder.startsWith('user:') ? 'vip' : 'gold');
const idOf = (holder: string): string => holder.slice(holder.indexOf(':') + 1);

/** The variants of a tier's prices, as the offering's link caches them. */
function variantsOf(tierId: 'gold' | 'vip') {
  const name = tierId === 'gold' ? 'Gold' : 'VIP';
  return [
    { variantId: PRICES[tierId].monthly, label: `${name} monthly`, amount: tierId === 'gold' ? 500 : 300, currency: 'USD', durationDays: 30, recurring: true, active: true },
    { variantId: PRICES[tierId].once, label: `${name} lifetime`, amount: tierId === 'gold' ? 5000 : 3000, currency: 'USD', durationDays: null, recurring: false, active: true },
  ];
}

export const tierDefOf = (tierId: 'gold' | 'vip') => ({
  displayName: tierId === 'gold' ? 'Gold' : 'VIP',
  priority: 1,
  overrides: {},
  ...(tierId === 'vip' ? { kind: 'user' } : {}),
  offerings: [{
    id: `o-${tierId}`,
    label: tierId === 'gold' ? 'Gold' : 'VIP',
    providerLinks: [{
      providerId: 'stripe',
      enabled: true,
      mode: 'price',
      priceConfig: { entries: variantsOf(tierId).map(v => ({ variantId: v.variantId })) },
      cache: { syncedAt: '2026-11-22T00:00:00.000Z', variants: variantsOf(tierId) },
    }],
  }],
});

export interface OpReply { ok: boolean; result?: any; error?: string; code?: string }
export interface RouteReply { status: number; body: any }
/** What a purchase answered, and the Checkout Session it made at the fake (null when it made none). */
export interface Bought extends RouteReply { sessionId: string | null }
/** How a delivery is posted: through the op (the default), or a poster the row gives (the route rig of nb10Webhook). */
export type Poster = (body: string, signature: string) => Promise<RouteReply>;
export interface Delivered { event: StripeEvent; status: number; reply: OpReply | RouteReply }

const ENV_KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'OAUTH_CALLBACK_URL', 'BOT_PROCESS_ROLE'] as const;

export function p3World(backend: 'json' | 'rig' = 'json') {
  const rig = backend === 'rig' ? premiumRig() : null;
  const saved: Record<string, string | undefined> = {};
  let fake = new FakeStripe();
  const delivered: Delivered[] = [];
  /** Every event the provider emitted to premium, in order. */
  const emitted: any[] = [];
  /** Premium's subscription id of each install line a delivery wrote, to the Stripe id of the created event it emitted. */
  const installs = new Map<string, string>();

  const settle = async (): Promise<void> => {
    if (rig) {
      await rig.settle();
      return;
    }
    for (let i = 0; i < 4; i++) {
      await flushAll();
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  };
  const sharedOp = async (name: string, args: unknown): Promise<OpReply> => {
    const reply = await applySharedOp({ op: name, args } as any) as OpReply;
    await settle();
    return reply;
  };
  const op = (name: string, ...args: unknown[]): Promise<OpReply> => sharedOp(`premium.${name}`, { args });
  const botManager: any = {
    storeDocsFirst: async () => null,
    migrationRunning: () => null,
    isRunning: () => false,
    listLoadedModules: async () => null,
    runSharedOp: (name: string, args: unknown) => sharedOp(name, args),
  };
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
  const sellsUsers = (): boolean => getPaymentRegistry().get('stripe')?.capabilities.sells?.includes('user') === true;
  /** A route of a router, called as p1Routes.test.ts calls one: the last handler, a request and a recording response. */
  const callRoute = async (router: any, method: string, routePath: string, req: Record<string, unknown>): Promise<RouteReply> => {
    const layer = router.stack.find((l: any) => l.route && l.route.path === routePath && l.route.methods[method]);
    if (!layer) throw new Error(`p3World: no route ${method} ${routePath}`);
    const sent: RouteReply[] = [];
    let code = 200;
    const res: any = {
      status(c: number) { code = c; return res; },
      json(payload: unknown) { sent.push({ status: code, body: payload }); return res; },
    };
    const handlers = layer.route.stack;
    await handlers[handlers.length - 1].handle({ query: {}, protocol: 'https', get: () => 'bot.example', ...req }, res, () => undefined);
    await settle();
    if (sent.length !== 1) throw new Error(`p3World: ${method} ${routePath} answered ${sent.length} times`);
    return sent[0];
  };
  /** The session a purchase made: the one new open session at the fake. */
  const bought = (before: Set<string>, reply: RouteReply): Bought => {
    const made = [...fake.sessions.keys()].filter(id => !before.has(id));
    if (made.length > 1) throw new Error(`p3World: one purchase made ${made.length} sessions`);
    return { ...reply, sessionId: made[0] ?? null };
  };
  const purchaseBody = (holder: string, kind: PriceKind, more: Record<string, unknown>) => {
    const tierId = tierOfHolder(holder);
    return { tierId, offeringId: `o-${tierId}`, providerId: 'stripe', variantId: PRICES[tierId][kind], ...more };
  };
  const register = (): void => {
    getPaymentRegistry().register(new StripeProvider());
  };

  const world = {
    rig,
    botManager,
    callRoute,
    /** The fake of Stripe's API; a new one at each setup. */
    get fake(): FakeStripe { return fake; },
    /** Every delivery made, in order. */
    delivered,
    emitted,
    /**
     * The install lines deliveries wrote: premium's subscription id to the Stripe id of the one created event the
     * delivery emitted (a delivery emits at most one).
     */
    installs,
    settle,
    op,
    sharedOp,
    storedText,
    stored: (): any => {
      const text = storedText();
      return text === null ? null : JSON.parse(text);
    },
    /** The doc as stored: the row on the rig, the file on disk on JSON; null when there is none. */
    customersText: (): string | null => {
      if (rig) return rig.m.state.rows.docs.get(CUSTOMERS_KEY)?.body.toString('utf8') ?? null;
      return fs.existsSync(customersPath()) ? fs.readFileSync(customersPath(), 'utf8') : null;
    },
    auditLines: (): any[] => auditText().split('\n').filter(l => l.trim()).map(l => JSON.parse(l)),
    notices: () => notices.sent,
    tiers: (kind?: 'guild' | 'user'): Record<string, any> => (getPremiumManager() as any).getAllTiers(kind),

    /** A new bot process on an empty data folder: the fake with its prices, Stripe registered and activated, the tiers. */
    async setup(): Promise<void> {
      for (const key of ENV_KEYS) saved[key] = process.env[key];
      if (rig) {
        await rig.setup(true);
      } else {
        process.env.BOT_PROCESS_ROLE = 'bot';
        await settle();
        resetPremiumManager();
        fs.rmSync(dataPath('global'), { recursive: true, force: true });
        fs.mkdirSync(dataPath('global'), { recursive: true });
      }
      process.env.STRIPE_SECRET_KEY = SECRET_KEY;
      process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
      process.env.OAUTH_CALLBACK_URL = OAUTH_CALLBACK;
      fake = new FakeStripe();
      for (const tierId of ['gold', 'vip'] as const) {
        const name = tierId === 'gold' ? 'Gold' : 'VIP';
        fake.addPrice({ id: PRICES[tierId].monthly, product: `prod_${tierId}`, productName: name, amount: tierId === 'gold' ? 500 : 300, interval: 'month' });
        fake.addPrice({ id: PRICES[tierId].once, product: `prod_${tierId}`, productName: name, amount: tierId === 'gold' ? 5000 : 3000, interval: null });
      }
      fake.addPrice({ id: UNLINKED_PRICE, product: 'prod_gold', productName: 'Gold', amount: 900, interval: 'month' });
      fake.install();
      delivered.length = 0;
      (await import('../../src/bot/internalSetup/utils/payment/paymentRegistry') as any)._dropRegistry?.();
      notices.sent.length = 0;
      register();
      const registry: any = getPaymentRegistry();
      const emit = registry.emitEvent.bind(registry);
      emitted.length = 0;
      installs.clear();
      registry.emitEvent = (event: any) => {
        emitted.push(event);
        return emit(event);
      };
      getPremiumManager();
      const gold = await op('setTier', SERVER_TIER, tierDefOf('gold'));
      if (!gold.ok) throw new Error(`p3World: setTier ${SERVER_TIER} was not saved: ${gold.error}`);
      if (sellsUsers()) {
        const vip = await op('setTier', USER_TIER, tierDefOf('vip'));
        if (!vip.ok) throw new Error(`p3World: setTier ${USER_TIER} was not saved: ${vip.error}`);
      }
      const activated = await op('setProviderActivation', 'stripe', true);
      if (!activated.ok) throw new Error(`p3World: Stripe was not activated: ${activated.error}`);
    },
    async teardown(): Promise<void> {
      await settle();
      getPaymentRegistry().unregister('stripe');
      vi.unstubAllGlobals();
      if (rig) await rig.teardown();
      else resetPremiumManager();
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    },
    /** A new bot process on the stored files: a new premium manager and a new Stripe provider; the fake stays. */
    async reload(): Promise<void> {
      await settle();
      resetPremiumManager();
      register();
      getPremiumManager();
    },

    /** A purchase on the member route (gsub's POST /:guildId/paid) by the signed-in buyer; a server only at this tree. */
    async buyMember(holder: string, buyerId: string, kind: PriceKind = 'monthly', more: Record<string, unknown> = {}): Promise<Bought> {
      if (!holder.startsWith('guild:')) throw new Error(`p3World.buyMember: the member route sells servers only at this tree; ${holder} has no member route`);
      const before = new Set(fake.sessions.keys());
      const reply = await callRoute(createGuildSubscriptionRoutes(botManager), 'post', '/:guildId/paid', {
        params: { guildId: idOf(holder) }, body: purchaseBody(holder, kind, more), user: { id: buyerId },
      });
      return bought(before, reply);
    },
    /** A purchase on a dev route: the server route with `buyerId` in the body, or the user route. */
    async buyDev(holder: string, buyerId: string, kind: PriceKind = 'monthly', more: Record<string, unknown> = {}): Promise<Bought> {
      const { createAppStoreRoutes } = await import('../../src/webui/routes/appstore');
      const router = createAppStoreRoutes(botManager);
      const before = new Set(fake.sessions.keys());
      const reply = holder.startsWith('user:')
        ? await callRoute(router, 'post', '/premium/users/:userId/paid', { params: { userId: idOf(holder) }, body: purchaseBody(holder, kind, { buyerId, ...more }) })
        : await callRoute(router, 'post', '/premium/subscriptions/:guildId/paid', { params: { guildId: idOf(holder) }, body: purchaseBody(holder, kind, { buyerId, ...more }) });
      return bought(before, reply);
    },

    /**
     * One event delivered as Stripe posts it: the body signed at `at` (unix seconds, now by default), then run as
     * payment.webhook through applySharedOp, or posted by `via`. The answer's status is the route's (hop's
     * webhookAnswer for the op).
     */
    async deliver(event: StripeEvent, opts: { at?: number; via?: Poster; signature?: string } = {}): Promise<Delivered> {
      const body = JSON.stringify(event);
      const linesBefore = world.auditLines().length;
      const emittedBefore = emitted.length;
      const signature = opts.signature ?? signWithPackage(body, opts.at);
      let out: Delivered;
      if (opts.via) {
        const reply = await opts.via(body, signature);
        await settle();
        out = { event, status: reply.status, reply };
      } else {
        const reply = await sharedOp('payment.webhook', {
          providerId: 'stripe', body: Buffer.from(body).toString('base64'), signature, headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
        });
        const { webhookAnswer } = await import('../../src/webui/routes/hopFailure');
        out = { event, status: webhookAnswer(reply).status, reply };
      }
      delivered.push(out);
      const created = emitted.slice(emittedBefore).filter(e => e.type === 'subscription.created');
      for (const line of world.auditLines().slice(linesBefore)) {
        if (line.action !== 'subscription.install.paid') continue;
        if (created.length !== 1) throw new Error(`p3World.deliver: an install line came from a delivery that emitted ${created.length} created events`);
        installs.set(line.subscriptionId, created[0].providerSubId);
      }
      return out;
    },
    /** The queued event at `index` (the oldest by default) taken out of the queue and delivered; null with none. */
    async deliverNext(index = 0, opts: { at?: number; via?: Poster } = {}): Promise<Delivered | null> {
      const event = fake.dequeue(index);
      return event ? world.deliver(event, opts) : null;
    },
    /** Delivers every queued event, the oldest first, or in the order `pick` chooses (an index into the queue). */
    async drain(pick: (length: number) => number = () => 0): Promise<Delivered[]> {
      const out: Delivered[] = [];
      for (let guard = 0; fake.queue.length > 0; guard++) {
        if (guard > 1000) throw new Error('p3World.drain: the queue does not empty');
        const next = await world.deliverNext(pick(fake.queue.length));
        if (next) out.push(next);
      }
      return out;
    },
  };
  return world;
}

export type P3World = ReturnType<typeof p3World>;

/** Premium's Stripe subscriptions in a stored document, each with its holder and where it sits. */
export function heldStripe(doc: any): Array<{ holder: string; sub: any; location: 'active' | 'paused' }> {
  const out: Array<{ holder: string; sub: any; location: 'active' | 'paused' }> = [];
  for (const [holder, record] of Object.entries<any>(doc?.subscriptions ?? {})) {
    if (record.active?.providerId === 'stripe') out.push({ holder, sub: record.active, location: 'active' });
    for (const sub of record.paused ?? []) if (sub.providerId === 'stripe') out.push({ holder, sub, location: 'paused' });
  }
  return out;
}
