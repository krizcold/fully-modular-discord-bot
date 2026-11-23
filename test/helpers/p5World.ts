import fs from 'fs';
import { vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { PayPalProvider } from '../../src/bot/internalSetup/utils/payment/paypalProvider';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { createGuildSubscriptionRoutes } from '../../src/webui/routes/guildSubscriptions';
import { notices } from './p1Mocks';
import { AUDIT_KEY, PREMIUM_KEY, premiumRig } from './nb6PremiumRig';
import { APP_CLIENT_ID, APP_CLIENT_SECRET, FakePayPal, type Delivery, type PayPalEvent, type PlanSpec } from './p5PayPal';

// P5's world (sheet P5, Revision 9, Z12): the real PremiumManager in the bot role over the JSON files, or as
// p5World('rig') over the mirror rig of helpers/nb6PremiumRig.ts; the registry with the real PayPalProvider, its keys,
// the bot's CLIENT_ID and OAUTH_CALLBACK_URL; per kind two tiers of different priority, each with one offering that
// links a cheap (monthly) and a dear (yearly) plan; the fake of helpers/p5PayPal.ts behind the global fetch; a second
// bot (its own CLIENT_ID and webhook id) on the same PayPal app; purchases on the member route (gsub's handler, the
// buyer signed in) and on the dev routes; deliveries of the fake's events through payment.webhook or a poster the row
// gives; and the clock.
//
// A test file that uses it mocks the registry and the notices with helpers/p1Mocks.ts, as p3World's files do. The dev
// routes are loaded only when a row buys on one; a file that does mocks appStoreManager as p3Props.test.ts does. The
// user tiers are saved only when PayPal sells users (setTier refuses an enabled link of a provider that does not).

/** The Discord ids of a row: each is a server and a user. */
export const IDS = ['85000000000000001', '85000000000000002'] as const;
export const OAUTH_CALLBACK = 'https://bot.example/oauth/callback';
export const HOST = 'https://bot.example';
/** The bot's Discord application id, and the second bot's. */
export const BOT_CLIENT_ID = '85900000000000001';
export const SECOND_CLIENT_ID = '85900000000000002';
/** The webhook each bot registered at the PayPal app. */
export const WEBHOOK_ID = 'WH-HOOK-P5-FIRST';
export const SECOND_WEBHOOK_ID = 'WH-HOOK-P5-SECOND';

/** The tiers: per kind a lower (priority 1) and a higher (priority 2) one, each with the offering `o-<tier>`. */
export const TIERS = {
  guild: { low: 'gold', high: 'platinum' },
  user: { low: 'vip', high: 'star' },
} as const;
export type TierId = 'gold' | 'platinum' | 'vip' | 'star';
export type PlanKind = 'cheap' | 'dear';
const PRICES: Record<TierId, { cheap: string; dear: string }> = {
  gold: { cheap: '5.00', dear: '50.00' },
  platinum: { cheap: '9.00', dear: '90.00' },
  vip: { cheap: '3.00', dear: '30.00' },
  star: { cheap: '7.00', dear: '70.00' },
};
/** The plan each tier's offering links: cheap is monthly, dear is yearly. */
export const planId = (tierId: TierId, kind: PlanKind): string => `P-${tierId.toUpperCase()}-${kind === 'cheap' ? 'MONTH' : 'YEAR'}`;
/** Plans the fake holds that no offering links unless a row links them at setup. */
export const EXTRA_PLANS = {
  day: 'P-EXTRA-DAY',
  trial: 'P-EXTRA-TRIAL',
  inactive: 'P-EXTRA-INACTIVE',
  unlinked: 'P-EXTRA-UNLINKED',
  quantity: 'P-EXTRA-QUANTITY',
} as const;

const NAMES: Record<TierId, string> = { gold: 'Gold', platinum: 'Platinum', vip: 'VIP', star: 'Star' };
const PRIORITY: Record<TierId, number> = { gold: 1, platinum: 2, vip: 1, star: 2 };
const KIND: Record<TierId, 'guild' | 'user'> = { gold: 'guild', platinum: 'guild', vip: 'user', star: 'user' };

function planSpecs(): PlanSpec[] {
  const specs: PlanSpec[] = [];
  for (const tierId of Object.keys(PRICES) as TierId[]) {
    specs.push({ id: planId(tierId, 'cheap'), productId: `PROD-${tierId.toUpperCase()}`, name: `${NAMES[tierId]} monthly`, unit: 'MONTH', price: PRICES[tierId].cheap });
    specs.push({ id: planId(tierId, 'dear'), productId: `PROD-${tierId.toUpperCase()}`, name: `${NAMES[tierId]} yearly`, unit: 'YEAR', price: PRICES[tierId].dear });
  }
  specs.push({ id: EXTRA_PLANS.day, productId: 'PROD-EXTRA', name: 'Daily', unit: 'DAY', price: '1.00' });
  specs.push({ id: EXTRA_PLANS.trial, productId: 'PROD-EXTRA', name: 'Monthly with a three-week trial', unit: 'MONTH', price: '6.00', trial: { unit: 'WEEK', cycles: 3 } });
  specs.push({ id: EXTRA_PLANS.inactive, productId: 'PROD-EXTRA', name: 'Retired', unit: 'MONTH', price: '4.00', status: 'INACTIVE' });
  specs.push({ id: EXTRA_PLANS.unlinked, productId: 'PROD-EXTRA', name: 'Not sold', unit: 'MONTH', price: '8.00' });
  specs.push({ id: EXTRA_PLANS.quantity, productId: 'PROD-EXTRA', name: 'Per seat', unit: 'MONTH', price: '2.00', quantitySupported: true });
  return specs;
}

/** The variant a plan's link caches, as paypalProvider.ts's fetchVariant maps the plan (MONTH 30 days, YEAR 365). */
function variantOf(spec: PlanSpec) {
  const days = { DAY: 1, WEEK: 7, MONTH: 30, YEAR: 365 }[spec.unit] * (spec.count ?? 1);
  return { variantId: spec.id, label: spec.name, amount: Math.round(Number.parseFloat(spec.price) * 100), currency: spec.currency ?? 'USD', durationDays: days, recurring: true, active: (spec.status ?? 'ACTIVE') === 'ACTIVE' };
}

/** A tier as setTier takes it, its offering linking `plans` (the tier's cheap and dear plan by default). */
export function tierDefOf(tierId: TierId, plans: string[] = [planId(tierId, 'cheap'), planId(tierId, 'dear')]) {
  const specs = planSpecs();
  const variants = plans.map(id => {
    const spec = specs.find(s => s.id === id);
    if (!spec) throw new Error(`p5World.tierDefOf: no plan ${id}`);
    return variantOf(spec);
  });
  return {
    displayName: NAMES[tierId],
    priority: PRIORITY[tierId],
    overrides: {},
    ...(KIND[tierId] === 'user' ? { kind: 'user' } : {}),
    offerings: [{
      id: `o-${tierId}`,
      label: NAMES[tierId],
      providerLinks: [{
        providerId: 'paypal',
        enabled: true,
        mode: 'price',
        priceConfig: { entries: variants.map(v => ({ variantId: v.variantId })) },
        cache: { syncedAt: '2026-11-22T00:00:00.000Z', variants },
      }],
    }],
  };
}

export interface OpReply { ok: boolean; result?: any; error?: string; code?: string }
export interface RouteReply { status: number; body: any }
/** What a purchase answered, and the subscription it made at the fake (null when it made none). */
export interface Bought extends RouteReply { subscriptionId: string | null }
/** How a delivery is posted: through the op (the default), or a poster the row gives (the route rig of nb10Webhook). */
export type Poster = (body: string, headers: Record<string, string>) => Promise<RouteReply>;
export interface Delivered { event: PayPalEvent | null; delivery: Delivery; status: number; reply: OpReply | RouteReply }
export interface DeliverOpts {
  via?: Poster;
  /** The webhook it is sent to (the first bot's by default). */
  webhookId?: string;
  /** The exact body text to sign, in place of `JSON.stringify(event)`. */
  text?: string;
  /** Changes the signed delivery before it is posted (a byte of the body, a header). */
  tamper?: (delivery: Delivery) => Delivery;
}

const ENV_KEYS = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID', 'PAYPAL_ENV', 'WEBUI_BASE_URL', 'CLIENT_ID', 'OAUTH_CALLBACK_URL', 'BOT_PROCESS_ROLE'] as const;
const idOf = (holder: string): string => holder.slice(holder.indexOf(':') + 1);

export function p5World(backend: 'json' | 'rig' = 'json') {
  const rig = backend === 'rig' ? premiumRig() : null;
  const saved: Record<string, string | undefined> = {};
  let fake = new FakePayPal();
  const delivered: Delivered[] = [];
  /** Every event the provider emitted to premium, in order. */
  const emitted: any[] = [];
  /** Every console line while the world is set up, as written (the args joined by spaces). */
  const logs: string[] = [];
  let spies: Array<{ mockRestore: () => void }> = [];
  let clockOn = false;

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
  const sellsUsers = (): boolean => getPaymentRegistry().get('paypal')?.capabilities.sells?.includes('user') === true;
  /** A route of a router, called as p1Routes.test.ts calls one: the last handler, a request and a recording response. */
  const callRoute = async (router: any, method: string, routePath: string, req: Record<string, unknown>): Promise<RouteReply> => {
    const layer = router.stack.find((l: any) => l.route && l.route.path === routePath && l.route.methods[method]);
    if (!layer) throw new Error(`p5World: no route ${method} ${routePath}`);
    const sent: RouteReply[] = [];
    let code = 200;
    const res: any = {
      status(c: number) { code = c; return res; },
      json(payload: unknown) { sent.push({ status: code, body: payload }); return res; },
    };
    const handlers = layer.route.stack;
    await handlers[handlers.length - 1].handle({ query: {}, protocol: 'https', get: () => 'bot.example', ...req }, res, () => undefined);
    await settle();
    if (sent.length !== 1) throw new Error(`p5World: ${method} ${routePath} answered ${sent.length} times`);
    return sent[0];
  };
  /** The subscription a purchase made: the one new subscription the bot created at the fake. */
  const bought = (before: Set<string>, reply: RouteReply): Bought => {
    const made = [...fake.createTexts.keys()].filter(id => !before.has(id));
    if (made.length > 1) throw new Error(`p5World: one purchase made ${made.length} subscriptions`);
    return { ...reply, subscriptionId: made[0] ?? null };
  };
  const purchaseBody = (tierId: TierId, plan: string, more: Record<string, unknown>) => ({ tierId, offeringId: `o-${tierId}`, providerId: 'paypal', variantId: plan, ...more });
  const register = (): void => {
    getPaymentRegistry().register(new PayPalProvider());
  };
  const tierFor = (holder: string, tierId?: TierId): TierId => tierId ?? (holder.startsWith('user:') ? TIERS.user.low : TIERS.guild.low);

  const world = {
    rig,
    botManager,
    callRoute,
    /** The fake of PayPal's API; a new one at each setup. */
    get fake(): FakePayPal { return fake; },
    /** Every delivery made, in order. */
    delivered,
    emitted,
    logs,
    settle,
    op,
    sharedOp,
    storedText,
    stored: (): any => {
      const text = storedText();
      return text === null ? null : JSON.parse(text);
    },
    auditLines: (): any[] => auditText().split('\n').filter(l => l.trim()).map(l => JSON.parse(l)),
    notices: () => notices.sent,
    tiers: (kind?: 'guild' | 'user'): Record<string, any> => (getPremiumManager() as any).getAllTiers(kind),
    /** The log lines written so far that contain the text. */
    logged: (text: string): string[] => logs.filter(l => l.includes(text)),

    /**
     * A new bot process on an empty data folder: the fake with its plans, PayPal registered and activated, the tiers.
     * `link` replaces the plans a tier's offering links; `env` sets or (undefined) removes keys after the defaults;
     * `clock` starts the clock (Date only) at that instant, moving on with real time.
     */
    async setup(opts: { link?: Partial<Record<TierId, string[]>>; env?: Record<string, string | undefined>; clock?: number } = {}): Promise<void> {
      for (const key of ENV_KEYS) saved[key] = process.env[key];
      logs.length = 0;
      spies = (['log', 'warn', 'error', 'info'] as const).map(level => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      }));
      if (opts.clock !== undefined) world.useClock(opts.clock);
      if (rig) {
        await rig.setup(true);
      } else {
        process.env.BOT_PROCESS_ROLE = 'bot';
        await settle();
        resetPremiumManager();
        fs.rmSync(dataPath('global'), { recursive: true, force: true });
        fs.mkdirSync(dataPath('global'), { recursive: true });
      }
      process.env.PAYPAL_CLIENT_ID = APP_CLIENT_ID;
      process.env.PAYPAL_CLIENT_SECRET = APP_CLIENT_SECRET;
      process.env.PAYPAL_WEBHOOK_ID = WEBHOOK_ID;
      delete process.env.PAYPAL_ENV;
      delete process.env.WEBUI_BASE_URL;
      process.env.CLIENT_ID = BOT_CLIENT_ID;
      process.env.OAUTH_CALLBACK_URL = OAUTH_CALLBACK;
      for (const [key, value] of Object.entries(opts.env ?? {})) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fake = new FakePayPal();
      for (const spec of planSpecs()) fake.addPlan(spec);
      fake.install();
      delivered.length = 0;
      (await import('../../src/bot/internalSetup/utils/payment/paymentRegistry') as any)._dropRegistry?.();
      notices.sent.length = 0;
      register();
      const registry: any = getPaymentRegistry();
      const emit = registry.emitEvent.bind(registry);
      emitted.length = 0;
      registry.emitEvent = (event: any) => {
        emitted.push(event);
        return emit(event);
      };
      getPremiumManager();
      for (const tierId of ['gold', 'platinum', 'vip', 'star'] as const) {
        if (KIND[tierId] === 'user' && !sellsUsers()) continue;
        const set = await op('setTier', tierId, tierDefOf(tierId, opts.link?.[tierId]));
        if (!set.ok) throw new Error(`p5World: setTier ${tierId} was not saved: ${set.error}`);
      }
      const activated = await op('setProviderActivation', 'paypal', true);
      if (!activated.ok) throw new Error(`p5World: PayPal was not activated: ${activated.error}`);
    },
    async teardown(): Promise<void> {
      await settle();
      getPaymentRegistry().unregister('paypal');
      vi.unstubAllGlobals();
      if (rig) await rig.teardown();
      else resetPremiumManager();
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
    /** A new bot process on the stored files: a new premium manager and a new PayPal provider; the fake stays. */
    async reload(): Promise<void> {
      await settle();
      resetPremiumManager();
      register();
      getPremiumManager();
    },

    /** The clock (Date only, moving on with real time) set to `at`. */
    useClock(at: number): void {
      vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
      vi.setSystemTime(at);
      clockOn = true;
    },
    /** The clock jumps by `ms`. */
    later(ms: number): void {
      if (!clockOn) throw new Error('p5World.later: the clock is not on (setup with `clock`, or useClock)');
      vi.setSystemTime(Date.now() + ms);
    },
    /** Premium's expiry checker runs once, and every op it started settles. */
    async tick(): Promise<void> {
      (getPremiumManager() as any).checkExpiry();
      await settle();
    },

    /** A purchase on the member route (gsub's POST /:guildId/paid) by the signed-in buyer; a server only. */
    async buyMember(holder: string, buyerId: string, opts: { tierId?: TierId; plan?: string; more?: Record<string, unknown> } = {}): Promise<Bought> {
      if (!holder.startsWith('guild:')) throw new Error(`p5World.buyMember: ${holder} has no member route`);
      const tierId = tierFor(holder, opts.tierId);
      const before = new Set(fake.createTexts.keys());
      const reply = await callRoute(createGuildSubscriptionRoutes(botManager), 'post', '/:guildId/paid', {
        params: { guildId: idOf(holder) }, body: purchaseBody(tierId, opts.plan ?? planId(tierId, 'cheap'), opts.more ?? {}), user: { id: buyerId },
      });
      return bought(before, reply);
    },
    /** A purchase on a dev route: the server route with `buyerId` in the body, or the user route. */
    async buyDev(holder: string, buyerId: string, opts: { tierId?: TierId; plan?: string; more?: Record<string, unknown> } = {}): Promise<Bought> {
      const { createAppStoreRoutes } = await import('../../src/webui/routes/appstore');
      const router = createAppStoreRoutes(botManager);
      const tierId = tierFor(holder, opts.tierId);
      const body = purchaseBody(tierId, opts.plan ?? planId(tierId, 'cheap'), { buyerId, ...(opts.more ?? {}) });
      const before = new Set(fake.createTexts.keys());
      const reply = holder.startsWith('user:')
        ? await callRoute(router, 'post', '/premium/users/:userId/paid', { params: { userId: idOf(holder) }, body })
        : await callRoute(router, 'post', '/premium/subscriptions/:guildId/paid', { params: { guildId: idOf(holder) }, body });
      return bought(before, reply);
    },
    /**
     * A purchase by the second bot (its own CLIENT_ID and webhook id, the same PayPal app): its own PayPalProvider's
     * checkout under its keys, with no premium of its own. The subscription id it made, or the error it threw.
     */
    async buySecondBot(holder: string, buyerId: string, opts: { tierId?: TierId; plan?: string } = {}): Promise<{ subscriptionId: string | null; error: string | null }> {
      const tierId = tierFor(holder, opts.tierId);
      const keep = { CLIENT_ID: process.env.CLIENT_ID, PAYPAL_WEBHOOK_ID: process.env.PAYPAL_WEBHOOK_ID };
      process.env.CLIENT_ID = SECOND_CLIENT_ID;
      process.env.PAYPAL_WEBHOOK_ID = SECOND_WEBHOOK_ID;
      try {
        const result = await new PayPalProvider().initiatePurchase({
          holder: holder as any, buyerId, tierId, offeringId: `o-${tierId}`, variantId: opts.plan ?? planId(tierId, 'cheap'), autoRenew: true,
        });
        return { subscriptionId: result.providerSubId ?? null, error: null };
      } catch (error) {
        return { subscriptionId: null, error: error instanceof Error ? error.message : String(error) };
      } finally {
        for (const [key, value] of Object.entries(keep)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },

    /**
     * One event delivered as PayPal posts it: signed by the fake for the webhook, then run as payment.webhook through
     * applySharedOp, or posted by `via`. The answer's status is the route's (hop's webhookAnswer for the op). With a
     * null event, `text` is the body.
     */
    async deliver(event: PayPalEvent | null, opts: DeliverOpts = {}): Promise<Delivered> {
      let delivery = fake.sign(event, opts.webhookId ?? WEBHOOK_ID, opts.text);
      if (opts.tamper) delivery = opts.tamper(delivery);
      let out: Delivered;
      if (opts.via) {
        const reply = await opts.via(delivery.body, delivery.headers);
        await settle();
        out = { event, delivery, status: reply.status, reply };
      } else {
        const reply = await sharedOp('payment.webhook', {
          providerId: 'paypal', body: Buffer.from(delivery.body).toString('base64'), signature: delivery.headers['paypal-transmission-sig'] ?? '', headers: delivery.headers,
        });
        const { webhookAnswer } = await import('../../src/webui/routes/hopFailure');
        out = { event, delivery, status: webhookAnswer(reply).status, reply };
      }
      delivered.push(out);
      return out;
    },
    /** The queued event at `index` (the oldest by default) taken out of the queue and delivered; null with none. */
    async deliverNext(index = 0, opts: DeliverOpts = {}): Promise<Delivered | null> {
      const event = fake.dequeue(index);
      return event ? world.deliver(event, opts) : null;
    },
    /** Delivers every queued event, the oldest first, or in the order `pick` chooses (an index into the queue). */
    async drain(pick: (length: number) => number = () => 0): Promise<Delivered[]> {
      const outs: Delivered[] = [];
      for (let guard = 0; fake.queue.length > 0; guard++) {
        if (guard > 1000) throw new Error('p5World.drain: the queue does not empty');
        const next = await world.deliverNext(pick(fake.queue.length));
        if (next) outs.push(next);
      }
      return outs;
    },
  };
  return world;
}

export type P5World = ReturnType<typeof p5World>;

/** Premium's PayPal subscriptions in a stored document, each with its holder and where it sits. */
export function heldPayPal(doc: any): Array<{ holder: string; sub: any; location: 'active' | 'paused' }> {
  const found: Array<{ holder: string; sub: any; location: 'active' | 'paused' }> = [];
  for (const [holder, record] of Object.entries<any>(doc?.subscriptions ?? {})) {
    if (record.active?.providerId === 'paypal') found.push({ holder, sub: record.active, location: 'active' });
    for (const sub of record.paused ?? []) if (sub.providerId === 'paypal') found.push({ holder, sub, location: 'paused' });
  }
  return found;
}
