import fs from 'fs';
import { Client } from 'discord.js';
import { vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { attachEntitlementBridge } from '../../src/bot/internalSetup/utils/entitlementBridge';
import { getPremiumManager, resetPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { DiscordProvider } from '../../src/bot/internalSetup/utils/payment/discordProvider';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { acceptedOpsRunning } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { notices } from './p1Mocks';
import { AUDIT_KEY, PREMIUM_KEY, premiumRig } from './nb6PremiumRig';
import { APP_ID, BOT_TOKEN, FakeDiscord, SKU, type DiscordSettings } from './p6Discord';

// P6's world (sheet P6, section 10): the real PremiumManager in the bot role over the JSON files, or as
// p6World('rig') over the mirror rig of helpers/nb6PremiumRig.ts; the registry with the real DiscordProvider and the
// Dummy; Discord's credentials (DISCORD_APPLICATION_ID and DISCORD_TOKEN); premium with two user tiers of different
// priority and one server tier, the lower user tier's two offerings selling SKUs A and A2 through Discord and the higher
// one's offering SKU B; a real discord.js Client with the entitlement bridge attached (as both boots attach it); the
// fake of helpers/p6Discord.ts behind the global fetch; the clock (Date and the timers, faked); and `restart()`, a new
// bot process on the stored files.
//
// A test file that uses it mocks the registry and the notices with helpers/p1Mocks.ts, as p5World's files do. The user
// tiers' Discord links are enabled only when Discord sells users (setTier refuses an enabled link of a provider that does
// not), so the world sets up on every build. Every process of the world starts premium's tickers as the bot does
// (startPremiumTickers: the expiry checker every minute, and each provider's start()); the faked timers run them only
// while the world's clock moves.

/** The users of a row, and a server. */
export const USERS = ['86500000000000001', '86500000000000002'] as const;
export const GUILD = '86600000000000001';
/** The tiers: the lower user tier (priority 1) sells A and A2, the higher one (priority 2) B; the server tier sells nothing through Discord. */
export const TIERS = { userLow: 'vip', userHigh: 'star', guild: 'gold' } as const;
export type P6TierId = 'vip' | 'star' | 'gold';
/** The tier and offering each wired SKU gives. */
export const WIRING: Record<string, { tierId: P6TierId; offeringId: string }> = {
  [SKU.A]: { tierId: 'vip', offeringId: 'o-a' },
  [SKU.A2]: { tierId: 'vip', offeringId: 'o-a2' },
  [SKU.B]: { tierId: 'star', offeringId: 'o-b' },
};
export const PRIORITY: Record<P6TierId, number> = { vip: 1, star: 2, gold: 1 };
/** The instant every world's clock starts at. */
export const START = Date.parse('2026-11-23T12:00:00.000Z');

/** The variant a Discord link caches for a SKU, as discordProvider.ts's fetchVariant maps it. */
export const variantOf = (skuId: string) => ({ variantId: skuId, label: `SKU ${skuId}`, amount: 0, currency: '', durationDays: 30, recurring: true, active: true });

/** A Discord link that sells the SKUs. */
export const discordLink = (skus: string[], enabled = true) => ({
  providerId: 'discord',
  enabled,
  mode: 'price',
  priceConfig: { entries: skus.map(variantId => ({ variantId })) },
  cache: { syncedAt: '2026-11-22T00:00:00.000Z', variants: skus.map(variantOf) },
});

/** A tier as setTier takes it; `enabled` sets the user tiers' Discord links. */
export function tierDefOf(tierId: P6TierId, enabled: boolean) {
  if (tierId === 'gold') return { displayName: 'Gold', priority: PRIORITY.gold, overrides: {}, offerings: [] };
  const offerings = tierId === 'vip'
    ? [{ id: 'o-a', label: 'VIP', providerLinks: [discordLink([SKU.A], enabled)] }, { id: 'o-a2', label: 'VIP plus', providerLinks: [discordLink([SKU.A2], enabled)] }]
    : [{ id: 'o-b', label: 'Star', providerLinks: [discordLink([SKU.B], enabled)] }];
  return { displayName: tierId === 'vip' ? 'VIP' : 'Star', priority: PRIORITY[tierId], overrides: {}, kind: 'user', offerings };
}

export interface OpReply { ok: boolean; result?: any; error?: string; code?: string }
/** One Discord record premium holds, with its holder and where it sits. */
export interface HeldDiscord { holder: string; sub: any; location: 'active' | 'paused' }

const realSetTimeout = globalThis.setTimeout;
/** A wait in real time, whatever the faked timers do. */
const realSleep = (ms: number): Promise<void> => new Promise<void>(resolve => { realSetTimeout(resolve, ms); });

const ENV_KEYS =['DISCORD_APPLICATION_ID', 'DISCORD_TOKEN', 'BOT_PROCESS_ROLE'] as const;
const FAKED: Array<'Date' | 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'> = ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];

export function p6World(backend: 'json' | 'rig' = 'json') {
  const rig = backend === 'rig' ? premiumRig() : null;
  const saved: Record<string, string | undefined> = {};
  let fake = new FakeDiscord();
  let client: Client | null = null;
  let provider: DiscordProvider | null = null;
  /** Every event a provider emitted to premium, in order. */
  const emitted: any[] = [];
  /** Every console line while the world is set up, as written (the args joined by spaces). */
  const logs: string[] = [];
  let spies: Array<{ mockRestore: () => void }> = [];
  let clockOn = false;
  /** The clock of each run of premium's expiry check since setup, in every process (the minute checker's or `tick()`'s). */
  const expiryChecks: number[] = [];

  /**
   * Waits for the work while the faked clock follows real time (1 ms of real wait, then 1 ms of clock, per pass): the
   * data layer waits for real disk writes against deadlines on the faked timers, so the clock never runs ahead of them.
   */
  const pump = async <T>(work: Promise<T>): Promise<T> => {
    let done = false;
    const out = work.finally(() => { done = true; });
    for (let i = 0; !done; i++) {
      if (i > 30_000) throw new Error('p6World: an op or a flush did not finish within 30 s');
      if (i < 3) {
        await new Promise<void>(resolve => { setImmediate(resolve); });
        continue;
      }
      await realSleep(1);
      if (!done && clockOn) await vi.advanceTimersByTimeAsync(1);
    }
    return out;
  };
  /**
   * Lets premium's saves, the data layer's flush and every op it started finish, and a Discord round that is not waiting
   * on the clock (an accepted op, NX5 G8-12) end.
   */
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
  const sellsUsers = (): boolean => getPaymentRegistry().get('discord')?.capabilities.sells?.includes('user') === true;
  const botManager: any = {
    storeDocsFirst: async () => null,
    migrationRunning: () => null,
    isRunning: () => false,
    listLoadedModules: async () => null,
    runSharedOp: (name: string, args: unknown) => sharedOp(name, args),
  };
  /** A route of the dev routes (routes/appstore.ts), called as p5World calls one: the last handler, a request and a recording response. */
  const appRoute = async (method: string, routePath: string, req: Record<string, unknown>): Promise<{ status: number; body: any }> => {
    const { createAppStoreRoutes } = await import('../../src/webui/routes/appstore');
    const router: any = createAppStoreRoutes(botManager);
    const layer = router.stack.find((l: any) => l.route && l.route.path === routePath && l.route.methods[method]);
    if (!layer) throw new Error(`p6World: no route ${method} ${routePath}`);
    const sent: Array<{ status: number; body: any }> = [];
    let code = 200;
    const res: any = {
      status(c: number) { code = c; return res; },
      json(payload: unknown) { sent.push({ status: code, body: payload }); return res; },
    };
    const handlers = layer.route.stack;
    await pump(Promise.resolve(handlers[handlers.length - 1].handle({ query: {}, params: {}, protocol: 'https', get: () => 'bot.example', ...req }, res, () => undefined)));
    await settle();
    if (sent.length !== 1) throw new Error(`p6World: ${method} ${routePath} answered ${sent.length} times`);
    return sent[0];
  };

  /** A bot process's registry, premium, tickers and Discord client, on what is stored now. */
  const boot = async (): Promise<void> => {
    (await import('../../src/bot/internalSetup/utils/payment/paymentRegistry') as any)._dropRegistry?.();
    const registry: any = getPaymentRegistry();
    provider = new DiscordProvider();
    registry.register(provider);
    registry.register(new DummyProvider());
    const emit = registry.emitEvent.bind(registry);
    registry.emitEvent = (event: any) => {
      emitted.push(event);
      return emit(event);
    };
    const manager: any = getPremiumManager();
    const check = manager.checkExpiry.bind(manager);
    manager.checkExpiry = () => {
      expiryChecks.push(Date.now());
      return check();
    };
    startPremiumTickers();
    client = new Client({ intents: [] });
    attachEntitlementBridge(client);
    fake.attach(client);
  };
  /** Stops the current process's tickers, its Discord client and premium. */
  const halt = async (): Promise<void> => {
    await settle();
    if (client) {
      fake.detach(client);
      void client.destroy();
      client = null;
    }
    getPaymentRegistry().unregister('discord');
    getPaymentRegistry().unregister('dummy');
    provider = null;
    resetPremiumManager();
  };

  const world = {
    rig,
    /** The fake of Discord; a new one at each setup. */
    get fake(): FakeDiscord { return fake; },
    /** The current process's Discord provider. */
    get provider(): DiscordProvider {
      if (!provider) throw new Error('p6World: no bot process is running');
      return provider;
    },
    get client(): Client {
      if (!client) throw new Error('p6World: no bot process is running');
      return client;
    },
    emitted,
    logs,
    expiryChecks,
    settle,
    op,
    sharedOp,
    appRoute,
    /** The dev lookup of a user (GET /premium/users/:userId), as the dev card reads it. */
    lookup: async (userId: string): Promise<{ status: number; body: any }> => appRoute('get', '/premium/users/:userId', { params: { userId } }),
    storedText,
    stored: (): any => {
      const text = storedText();
      return text === null ? null : JSON.parse(text);
    },
    auditLines: (): any[] => auditText().split('\n').filter(l => l.trim()).map(l => JSON.parse(l)),
    notices: () => notices.sent,
    /** The log lines written so far that contain the text. */
    logged: (text: string): string[] => logs.filter(l => l.includes(text)),

    /**
     * A new bot process on an empty data folder: the fake with `settings`, Discord's credentials, the registry, premium
     * with the tiers and Discord activated, the tickers and a Client. The clock starts at `clock` (START by default).
     */
    async setup(opts: { settings?: Partial<DiscordSettings>; clock?: number; env?: Record<string, string | undefined> } = {}): Promise<void> {
      for (const key of ENV_KEYS) saved[key] = process.env[key];
      logs.length = 0;
      spies = (['log', 'warn', 'error', 'info'] as const).map(level => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      }));
      vi.useFakeTimers({ toFake: FAKED, now: opts.clock ?? START });
      clockOn = true;
      // AbortSignal.timeout runs on Node's own clock; here it runs on the world's, so a call Discord never answers ends
      // when the world's clock reaches the timeout, with the reason Node gives.
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
      process.env.DISCORD_APPLICATION_ID = APP_ID;
      process.env.DISCORD_TOKEN = BOT_TOKEN;
      for (const [key, value] of Object.entries(opts.env ?? {})) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fake = new FakeDiscord(opts.settings);
      fake.install();
      notices.sent.length = 0;
      emitted.length = 0;
      expiryChecks.length = 0;
      await boot();
      for (const tierId of ['gold', 'vip', 'star'] as const) {
        const set = await op('setTier', tierId, tierDefOf(tierId, sellsUsers()));
        if (!set.ok) throw new Error(`p6World: setTier ${tierId} was not saved: ${set.error}`);
      }
      const activated = await op('setProviderActivation', 'discord', true);
      if (!activated.ok) throw new Error(`p6World: Discord was not activated: ${activated.error}`);
    },
    async teardown(): Promise<void> {
      await halt();
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
    /** A new bot process on the stored files: premium, the registry, the providers and the Client rebuilt; the fake stays. */
    async restart(): Promise<void> {
      await halt();
      await boot();
      await settle();
    },

    /** The clock and the timers move on by `ms` (the minute checker and every armed timer run as they come due), then everything settles. */
    async advance(ms: number): Promise<void> {
      for (let left = ms; left > 0; left -= 60_000) {
        await vi.advanceTimersByTimeAsync(Math.min(left, 60_000));
        await pump(flushAll());
      }
      await settle();
    },
    /** Premium's expiry check runs once, and every op it started settles. */
    async tick(): Promise<void> {
      (getPremiumManager() as any).checkExpiry();
      await settle();
    },
    /** The queued gateway event at `index` delivered to the Client, then everything settles. */
    async deliver(index = 0): Promise<void> {
      fake.deliver(index);
      await settle();
    },
    /** Every queued gateway event delivered in order, each settled before the next. */
    async deliverAll(): Promise<number> {
      let count = 0;
      while (fake.queue.length > 0) {
        await world.deliver(0);
        count += 1;
      }
      return count;
    },
    /** A round of the Discord provider, when this build has one (`checkNow`); false when it has none. */
    async round(): Promise<boolean> {
      const check = (provider as unknown as { checkNow?: () => Promise<unknown> } | null)?.checkNow;
      if (typeof check !== 'function') return false;
      await pump(Promise.resolve(check.call(provider)));
      await settle();
      return true;
    },
    /**
     * A round started now while the clock moves on in steps of `stepMs` (each call Discord holds or slows ends as its
     * timers come due), until it ends or `maxMs` has passed; whether it ended.
     */
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
    /** The bot's Discord credentials set (undefined removes a key); the fake stays. */
    setCredentials(creds: { applicationId?: string; token?: string }): void {
      if ('applicationId' in creds) {
        if (creds.applicationId === undefined) delete process.env.DISCORD_APPLICATION_ID;
        else process.env.DISCORD_APPLICATION_ID = creds.applicationId;
      }
      if ('token' in creds) {
        if (creds.token === undefined) delete process.env.DISCORD_TOKEN;
        else process.env.DISCORD_TOKEN = creds.token;
      }
    },
  };
  return world;
}

export type P6World = ReturnType<typeof p6World>;

/** Premium's Discord records in a stored document, each with its holder and where it sits. */
export function heldDiscord(doc: any): HeldDiscord[] {
  const found: HeldDiscord[] = [];
  for (const [holder, record] of Object.entries<any>(doc?.subscriptions ?? {})) {
    if (record.active?.providerId === 'discord') found.push({ holder, sub: record.active, location: 'active' });
    for (const sub of record.paused ?? []) if (sub.providerId === 'discord') found.push({ holder, sub, location: 'paused' });
  }
  return found;
}
