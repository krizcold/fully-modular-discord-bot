import fs from 'fs';
import { describe } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import type { ProviderEvent } from '../../src/bot/internalSetup/utils/payment/paymentTypes';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { notices } from './p1Mocks';
import { AUDIT_KEY, PREMIUM_KEY, premiumRig } from './nb6PremiumRig';
import { gh, uh, type TestHolder } from './p1Holder';
import { DAY_MS, P1Seller, SELLER_ID, SELLER_VARIANT, sellerOffering, type SellerCall, type SellerRecord } from './p1Seller';
import { dummyDriver } from './p2DummyDriver';

// P1's world: the real PremiumManager in the bot role over the JSON files (or, as p1World('rig'), over the mirror rig
// of helpers/nb6PremiumRig.ts: the real row flush on scripted tables), with the seller in the real registry,
// every change made through applySharedOp. This file is the one place that knows how a server reaches premium (the
// argument of an op, the key of the store, the field of an event, the buyer of a purchase), so the rows written on
// it move with the interface by a change here.
//
// The clock is the real one and nothing runs on it: no ticker is started, a row lasts seconds and the shortest term
// a step gives is one day. A frozen Date is not an option: when Windows refuses a rename once, atomicWrite.ts
// waits for its retry in a loop on Date.now(), which would never end.
//
// A test file that uses it mocks the registry and the notices with helpers/p1Mocks.ts.

export const PREMIUM = dataPath('global', 'premium-tiers.json');
export const AUDIT = dataPath('global', 'premium-tiers.audit.jsonl');

/** The servers of a row, as Discord ids. */
export const SERVERS = ['70000000000000001', '70000000000000002'] as const;
/** The Discord user who pays in a row. */
export const BUYER = '80000000000000001';

/** The users who hold a subscription of their own in a row, as Discord ids. */
export const USERS = ['81000000000000001', '81000000000000002'] as const;
/** A user whose id has the digits of the first server, so a step on one runs against its twin. */
export const TWIN_USER = SERVERS[0];
/** Every holder of a row: the two servers, the two users, then the twin user. */
export const HOLDERS = [gh(SERVERS[0]), gh(SERVERS[1]), uh(USERS[0]), uh(USERS[1]), uh(TWIN_USER)] as const;
/** The indexes of the users in HOLDERS. */
export const USER_HOLDERS = [2, 3, 4] as const;

/** How a holder is named to a premium method: a holder key as it is, a bare id as that server's key. */
export const holderOf = (who: string): TestHolder => (who.includes(':') ? who as TestHolder : gh(who));
/** The key of a holder's record in the stored document. */
export const storeKeyOf = (who: string): string => holderOf(who);
/** The options of a purchase that name who pays. */
export const buyerOptions = (buyerId: string): Record<string, string> => ({ buyerId });
/** Who pays when a row names nobody: a user pays for the user's own subscription, BUYER pays for a server's. */
export const defaultBuyer = (who: string): string => (holderOf(who).startsWith('user:') ? holderOf(who).slice('user:'.length) : BUYER);
/** The options of a purchase from the seller. */
export const purchaseOptions = (who: string, buyerId: string = defaultBuyer(who)): Record<string, string> => ({ providerId: SELLER_ID, variantId: SELLER_VARIANT, ...buyerOptions(buyerId) });
/** The name of the seller call that lists a holder's subscriptions. */
export const SELLER_LIST_CALL = 'listSubscriptionsFor';
/** The seller's list call as its call list records one for this holder. */
export const sellerListCall = (who: string): { method: string; args: unknown[] } => ({ method: SELLER_LIST_CALL, args: [holderOf(who)] });
export { DAY_MS, SELLER_ID, SELLER_VARIANT, sellerOffering };

// The seller is a driver (sheet P2, section 5): the P1 seller by default, or the real Dummy provider
// (helpers/p2DummyDriver.ts). A row reaches its seller only through the world: `calls()`, `view()`, `ids()`, `bytes()`,
// `unheld()` and `expire()`. A step a driver cannot make is absent from its run: the deliveries (`created`,
// `redelivered`, `renewed`, `cancelled`, `expired`, `orphan`) exist only when the driver `delivers`.

/** What a seller holds of one subscription; `daysLeft` only from a seller that keeps the days left of a pause. */
export type SellerView = { status: 'active' | 'paused' | 'expired'; endDate: string | null; autoRenew: boolean; daysLeft?: number | null };

/** What a driver uses of the world it serves. */
export interface DriverWorld {
  purchase(who: string, tierId: string): Promise<OpReply>;
  op(name: string, ...args: unknown[]): Promise<OpReply>;
  recordOf(who: string): any;
  stored(): any;
  deleteTier(tierId: string): Promise<OpReply>;
  /** The tier made again as the world first made it. */
  remakeTier(tierId: string): Promise<OpReply>;
  settle(): Promise<void>;
  deliver(event: ProviderEvent): Promise<OpReply>;
  stateEvent(type: 'subscription.renewed' | 'subscription.cancelled' | 'subscription.expired', record: SellerRecord): ProviderEvent;
}

export interface SellerDriver {
  readonly name: 'p1seller' | 'dummy';
  /** The provider id. */
  readonly id: string;
  /** A recurring 30-day variant. */
  readonly variant: string;
  /** A tier's offering sold through this seller, as setTier takes it. */
  offering(offeringId: string, label: string): object;
  /** Makes the provider and registers it in the row's registry; `rig` is the mirror rig the world runs on, if any. */
  attach(rig?: ReturnType<typeof premiumRig> | null): Promise<void>;
  detach(): Promise<void>;
  /** Premium's calls to it, in order. */
  calls(): SellerCall[];
  /** Its record of a subscription; null when it has none. */
  view(providerSubId: string): SellerView | null;
  /** The ids of every record it holds. */
  ids(): string[];
  /** What it has stored, compared before and after a refused call. */
  bytes(): string;
  /** Leaves one live record premium does not hold, paused when asked; answers its id. */
  unheld(world: DriverWorld, holder: string, tierId: string, opts?: { paused?: boolean }): Promise<string>;
  /** The subscription ends at the seller and premium hears of it. */
  expire(world: DriverWorld, providerSubId: string): Promise<void>;
  /** It takes a delivery and can raise created and state events. */
  readonly delivers: boolean;
  /** Its record of a paused subscription holds the days left. */
  readonly keepsDaysLeft: boolean;
  /** The Dummy only: the clock jumps. */
  advance?(days: number): void;
  /** The Dummy only: one run of its tick, settled. */
  tick?(): Promise<void>;
  /** The P1 seller only: the seller itself, for the deliveries. */
  readonly seller?: P1Seller;
}

/** The P1 seller as a driver: the real clock and no tick; an unheld record is a checkout, an expiry is delivered. */
export function p1SellerDriver(): SellerDriver {
  let seller: P1Seller | null = null;
  const live = (): P1Seller => {
    if (!seller) throw new Error('p1SellerDriver: not attached');
    return seller;
  };
  return {
    name: 'p1seller',
    id: SELLER_ID,
    variant: SELLER_VARIANT,
    offering: sellerOffering,
    async attach(): Promise<void> {
      seller = new P1Seller(event => getPaymentRegistry().emitEvent(event));
      getPaymentRegistry().register(seller);
    },
    async detach(): Promise<void> {},
    calls: () => live().calls,
    view(providerSubId: string): SellerView | null {
      const record = live().records.get(providerSubId);
      return record ? { status: record.status, endDate: record.endDate, autoRenew: record.autoRenew, daysLeft: record.pausedDaysLeft ?? null } : null;
    },
    ids: () => [...live().records.keys()],
    bytes: () => JSON.stringify([...live().records.values()]),
    async unheld(_world, holder, tierId, opts = {}): Promise<string> {
      return live().checkout({ holder: holderOf(holder), buyerId: defaultBuyer(holder), tierId, offeringId: `o-${tierId}`, paused: opts.paused }).providerSubId;
    },
    async expire(world, providerSubId): Promise<void> {
      const expired = live().expire(providerSubId);
      if (!expired) throw new Error(`p1SellerDriver.expire: ${providerSubId} is not live at the seller`);
      const reply = await world.deliver(world.stateEvent('subscription.expired', expired));
      if (!reply.ok) throw new Error(`p1SellerDriver.expire: the expired event of ${providerSubId} was not applied: ${reply.error}`);
    },
    delivers: true,
    keepsDaysLeft: true,
    get seller(): P1Seller | undefined { return seller ?? undefined; },
  };
}

/** Runs the body once per named seller, inside a describe named after the seller. */
export function eachSeller(names: Array<'p1seller' | 'dummy'>, body: (make: () => SellerDriver) => void): void {
  describe.each(names.map(name => [name]))('%s', name => {
    body(() => (name === 'dummy' ? dummyDriver() : p1SellerDriver()));
  });
}

export const LINKER = 'p1link';
/**
 * A provider that links an account, as Patreon does: its callback answers what the query names (`account`, `guild`
 * and `buyer`; `holder`, when given, is answered as the holder in place of the server).
 */
export function linkProvider() {
  const calls: string[] = [];
  const provider: any = {
    id: LINKER,
    displayName: 'P1 Linker',
    capabilities: { sells: ['guild'], canInitiatePurchase: true, supportsCancel: true, supportsReactivate: false, supportsCoupons: false, supportsPause: false, mechanism: 'oauth_link' },
    isConfigured: () => true,
    initiatePurchase: async () => ({ oauthUrl: 'https://link.example/' }),
    handleOAuthCallback: async (query: Record<string, string>) => ({
      externalAccountId: query.account,
      holder: query.holder ?? `guild:${query.guild}`,
      ...(query.buyer === undefined ? {} : { buyerId: query.buyer }),
      tierId: 'low',
      offeringId: 'o-low',
      variantId: SELLER_VARIANT,
      state: { status: 'active', startDate: new Date().toISOString(), endDate: null, autoRenew: true },
    }),
    cancelSubscription: async (providerSubId: string, immediately?: boolean) => { calls.push(`cancel ${providerSubId} ${immediately}`); },
  };
  return { provider, calls };
}
/** What an event carries to name its holder. */
const eventOwner = (record: SellerRecord): { holder: TestHolder } => ({ holder: record.holder });
/** What a created event carries to name who paid: nothing when the seller's record names nobody. */
const eventBuyer = (record: SellerRecord): { buyerId?: string } => (record.buyerId === undefined ? {} : { buyerId: record.buyerId });
/** What the seller is given to name the holder and the buyer of a checkout; a null buyer is a checkout that names nobody. */
const checkoutOwner = (who: string, buyerId: string | null): { holder: TestHolder; buyerId?: string } => ({ holder: holderOf(who), ...(buyerId === null ? {} : { buyerId }) });

/** The user tiers a row adds with addUserTiers: `ualt` ties with `umid`. */
export const USER_TIER_PRIORITY: Record<string, number> = { ulow: 1, umid: 2, ualt: 2, uhigh: 3 };
export const USER_TIER_IDS = Object.keys(USER_TIER_PRIORITY);
export const userTierDef = (tierId: string, displayName = tierId.toUpperCase()) => ({
  displayName, priority: USER_TIER_PRIORITY[tierId], overrides: {}, offerings: [], kind: 'user',
});
/** The user tiers the seller sells, added with addSoldUserTiers: `vmid` ties with `valt`. Their offering is `o-<tier>`. */
export const USER_SOLD_TIER_PRIORITY: Record<string, number> = { vlow: 1, vmid: 2, valt: 2, vhigh: 3 };
export const USER_SOLD_TIER_IDS = Object.keys(USER_SOLD_TIER_PRIORITY);
export const userSoldTierDef = (tierId: string, displayName = tierId.toUpperCase()) => ({
  displayName, priority: USER_SOLD_TIER_PRIORITY[tierId], overrides: {}, offerings: [sellerOffering(`o-${tierId}`, displayName)], kind: 'user',
});

/** The tiers of a row: `alt` ties with `mid`. */
export const TIER_PRIORITY: Record<string, number> = { low: 1, mid: 2, alt: 2, high: 3 };
export const TIER_IDS = Object.keys(TIER_PRIORITY);
export const tierDef = (tierId: string, displayName = tierId.toUpperCase()) => ({
  displayName, priority: TIER_PRIORITY[tierId], overrides: {}, offerings: [sellerOffering(`o-${tierId}`, displayName)],
});

export interface OpReply { ok: boolean; result?: any; error?: string; code?: string }

export function p1World(backend: 'json' | 'rig' = 'json', driver: SellerDriver = p1SellerDriver()) {
  const role = process.env.BOT_PROCESS_ROLE;
  const rig = backend === 'rig' ? premiumRig() : null;
  /** The P1 seller, for the deliveries only it can make. */
  const deliveries = (): P1Seller => {
    if (!driver.seller) throw new Error(`p1World: the ${driver.name} driver takes no delivery; a row runs this step only when the driver delivers`);
    return driver.seller;
  };
  const offeringOf = (tierId: string, displayName: string) => driver.offering(`o-${tierId}`, displayName);
  /** A tier of TIER_IDS sold through the driver's seller. */
  const serverTierDef = (tierId: string, displayName = tierId.toUpperCase()) => ({ ...tierDef(tierId, displayName), offerings: [offeringOf(tierId, displayName)] });
  /** A tier of USER_SOLD_TIER_IDS sold through the driver's seller. */
  const soldUserTierDef = (tierId: string, displayName = tierId.toUpperCase()) => ({ ...userSoldTierDef(tierId, displayName), offerings: [offeringOf(tierId, displayName)] });
  /** Whether the driver's provider sells user tiers (an enabled link of one that does not is refused by setTier). */
  const sellsUsers = (): boolean => getPaymentRegistry().get(driver.id)?.capabilities.sells?.includes('user') === true;
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
  const op = async (name: string, ...args: unknown[]): Promise<OpReply> => {
    const reply = await applySharedOp({ op: `premium.${name}`, args: { args } }) as OpReply;
    await settle();
    return reply;
  };
  const deliver = async (event: ProviderEvent): Promise<OpReply> => {
    const reply = await applySharedOp({ op: 'payment.webhook', args: { providerId: SELLER_ID, body: Buffer.from(JSON.stringify(event)).toString('base64'), signature: '' } }) as OpReply;
    await settle();
    return reply;
  };
  /** The stored document's bytes: the file, or on the rig the row's body; null with none. */
  const storedText = (): string | null => {
    if (rig) return rig.m.state.rows.docs.get(PREMIUM_KEY)?.body.toString('utf8') ?? null;
    return fs.existsSync(PREMIUM) ? fs.readFileSync(PREMIUM, 'utf8') : null;
  };
  const stored = (): any => {
    const text = storedText();
    return text === null ? null : JSON.parse(text);
  };
  /** The audit log's bytes, line by line as stored. */
  const auditText = (): string => {
    if (rig) return [...rig.m.state.rows.lines.values()].filter(l => l.key === AUDIT_KEY).sort((a, b) => a.seq - b.seq).map(l => l.line.toString('utf8')).join('\n');
    return fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8') : '';
  };
  const recordOf = (serverId: string): any => stored()?.subscriptions?.[storeKeyOf(serverId)] ?? null;
  /** The seller's record of the server's active subscription, when the seller sold it. */
  const activeAtSeller = (serverId: string): SellerRecord | null => {
    const seller = deliveries();
    const active = recordOf(serverId)?.active;
    return active?.providerId === SELLER_ID ? seller.records.get(active.providerSubId) ?? null : null;
  };
  const stateEvent = (type: 'subscription.renewed' | 'subscription.cancelled' | 'subscription.expired', record: SellerRecord): ProviderEvent =>
    ({ type, providerId: SELLER_ID, providerSubId: record.providerSubId, ...eventOwner(record), state: deliveries().stateOf(record) }) as ProviderEvent;
  const createdEvent = (record: SellerRecord): ProviderEvent => ({
    type: 'subscription.created', providerId: SELLER_ID, providerSubId: record.providerSubId, ...eventOwner(record), ...eventBuyer(record),
    tierId: record.tierId, offeringId: record.offeringId, variantId: record.variantId, state: deliveries().stateOf(record),
  }) as ProviderEvent;
  const purchase = (serverId: string, tierId: string, buyerId: string = defaultBuyer(serverId)) =>
    op('initiatePaidSubscription', holderOf(serverId), tierId, `o-${tierId}`, { providerId: driver.id, variantId: driver.variant, ...buyerOptions(buyerId) });
  const deleteTier = (tierId: string) => op('deleteTier', tierId);
  const remakeTier = (tierId: string) => op('setTier', tierId, USER_SOLD_TIER_IDS.includes(tierId) ? soldUserTierDef(tierId) : USER_TIER_IDS.includes(tierId) ? userTierDef(tierId) : serverTierDef(tierId));
  const driverWorld: DriverWorld = { purchase, op, recordOf, stored, deleteTier, remakeTier, settle, deliver, stateEvent };
  /** The provider subscription id of the holder's active subscription; throws when it has none from the seller. */
  const activeSub = (who: string): string => {
    const active = recordOf(who)?.active;
    if (active?.providerId !== driver.id) throw new Error(`p1World: ${holderOf(who)} has no active subscription from ${driver.id}`);
    return active.providerSubId;
  };

  return {
    /** The P1 seller; a row reads it only for a step the P1 seller alone can make. */
    get seller(): P1Seller { return deliveries(); },
    /** The seller's driver. */
    driver,
    /** The seller takes deliveries (created and state events). */
    delivers: driver.delivers,
    /** Premium's calls to the seller, in order. */
    calls: (): SellerCall[] => driver.calls(),
    /** The seller's record of a subscription. */
    view: (providerSubId: string): SellerView | null => driver.view(providerSubId),
    /** The ids of every record the seller holds. */
    ids: (): string[] => driver.ids(),
    /** What the seller has stored. */
    bytes: (): string => driver.bytes(),
    /** One live record at the seller that premium does not hold; answers its id. */
    unheld: (who: string, tierId: string, opts: { paused?: boolean } = {}): Promise<string> => driver.unheld(driverWorld, who, tierId, opts),
    /** The holder's active subscription ends at the seller and premium hears of it. */
    expire: (who: string): Promise<void> => driver.expire(driverWorld, activeSub(who)),
    /** The options of a purchase from the seller. */
    options: (who: string, buyerId: string = defaultBuyer(who)): Record<string, string> => ({ providerId: driver.id, variantId: driver.variant, ...buyerOptions(buyerId) }),
    /** The tier made again as setup or addSoldUserTiers made it. */
    remakeTier,
    /** The clock jumps by `days` (a driver with a clock of its own only). */
    advance(days: number): void {
      if (!driver.advance) throw new Error(`p1World: the ${driver.name} driver has no clock to move`);
      driver.advance(days);
    },
    /** One run of the seller's tick, settled (a driver with a tick only). */
    async tick(): Promise<void> {
      if (!driver.tick) throw new Error(`p1World: the ${driver.name} driver has no tick`);
      await driver.tick();
    },
    /** The rig's log lines so far that contain the text (the rig spies on console); on the files, none. */
    logged: (text: string): string[] => (rig ? rig.logged(text) : []),
    /**
     * A new bot process on an empty data folder: the four tiers, the seller registered and activated. With `seed`
     * the stored document is that text before the first load (a state no writer of this tree can make), and nothing
     * else is saved.
     */
    async setup(opts: { seed?: string } = {}): Promise<void> {
      if (rig) {
        await rig.setup(true);
      } else {
        process.env.BOT_PROCESS_ROLE = 'bot';
        await settle();
        resetPremiumManager();
        fs.rmSync(dataPath('global'), { recursive: true, force: true });
        fs.mkdirSync(dataPath('global'), { recursive: true });
      }
      (await import('../../src/bot/internalSetup/utils/payment/paymentRegistry') as any)._dropRegistry?.();
      notices.sent.length = 0;
      await driver.attach(rig);
      if (opts.seed !== undefined) {
        if (rig) {
          rig.m.state.rows.put(PREMIUM_KEY, opts.seed);
          await runSharedPass();
          resetPremiumManager();
        } else {
          fs.writeFileSync(PREMIUM, opts.seed);
        }
        getPremiumManager();
        return;
      }
      getPremiumManager();
      for (const tierId of TIER_IDS) {
        const reply = await op('setTier', tierId, serverTierDef(tierId));
        if (!reply.ok) throw new Error(`p1World: setTier ${tierId} was not saved: ${reply.error}`);
      }
      const activated = await op('setProviderActivation', driver.id, true);
      if (!activated.ok) throw new Error(`p1World: the seller was not activated: ${activated.error}`);
    },
    async teardown(): Promise<void> {
      await settle();
      await driver.detach();
      if (rig) {
        await rig.teardown();
        return;
      }
      resetPremiumManager();
      if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
      else process.env.BOT_PROCESS_ROLE = role;
    },
    /** The mirror rig under a p1World('rig'); null on the files. */
    rig,
    settle,
    stored,
    storedText,
    auditText,
    recordOf,
    /** One premium op with its arguments as given; the reply is the op's answer. */
    op,
    /** Any shared op by its full name, as the web UI's routes send one. */
    async sharedOp(name: string, args: unknown): Promise<OpReply> {
      const reply = await applySharedOp({ op: name, args } as any) as OpReply;
      await settle();
      return reply;
    },
    /** The tiers the manager holds, every one or those of one kind. */
    tiers: (kind?: 'guild' | 'user'): Record<string, any> => (getPremiumManager() as any).getAllTiers(kind),
    /** The process starts again on the files as they are. */
    async reload(): Promise<void> {
      await settle();
      resetPremiumManager();
      getPremiumManager();
    },
    /** The Free baseline of one module, saved as the System Panel saves it. */
    async setGlobal(moduleName: string, partial: Record<string, unknown>): Promise<boolean> {
      const ok = getPremiumManager().setGlobalModuleConfig(moduleName, partial as any);
      await settle();
      return ok;
    },
    auditLines: (): any[] => auditText().split('\n').filter(l => l.trim()).map(l => JSON.parse(l)),
    /** The user tiers of USER_TIER_IDS, saved through the op. */
    async addUserTiers(): Promise<void> {
      for (const tierId of USER_TIER_IDS) {
        const reply = await op('setTier', tierId, userTierDef(tierId));
        if (!reply.ok) throw new Error(`p1World: setTier ${tierId} was not saved: ${reply.error}`);
      }
    },
    setUserTier: (tierId: string, displayName?: string) => op('setTier', tierId, USER_SOLD_TIER_IDS.includes(tierId) ? soldUserTierDef(tierId, displayName) : userTierDef(tierId, displayName)),
    /**
     * The user tiers of USER_SOLD_TIER_IDS, each with its offering at the seller, saved through the op. A seller that
     * sells no user tier gets none: setTier refuses its link on a user tier (X8), and no row runs a user's paid step
     * with it.
     */
    async addSoldUserTiers(): Promise<void> {
      if (!sellsUsers()) return;
      for (const tierId of USER_SOLD_TIER_IDS) {
        const reply = await op('setTier', tierId, soldUserTierDef(tierId));
        if (!reply.ok) throw new Error(`p1World: setTier ${tierId} was not saved: ${reply.error}`);
      }
    },
    /** One event delivered to the seller's webhook as it is given. */
    deliver,
    /** The seller's created event for one of its records. */
    createdEvent,
    /** A state event of the seller for one of its records. */
    stateEvent,

    grant: (serverId: string, tierId: string, days: number | null) => op('grantManual', holderOf(serverId), tierId, days),
    extend: (serverId: string, days: number) => op('extendManual', holderOf(serverId), days),
    revoke: (serverId: string) => op('revokeManual', holderOf(serverId)),
    /** The channel a server's notices fall back to when its owner's direct messages fail. */
    setNoticesChannel: (serverId: string, channelId: string | null) => op('setNotificationsChannelId', holderOf(serverId), channelId),
    purchase,
    cancelNow: (serverId: string) => op('cancelPaidSubscriptionImmediately', holderOf(serverId)),
    /** Cancels the queue entry at `pick` (wrapped to the queue's length); null with an empty queue. */
    async cancelQueued(serverId: string, pick: number): Promise<OpReply | null> {
      const queue: any[] = recordOf(serverId)?.paused ?? [];
      if (queue.length === 0) return null;
      return op('cancelAndRemovePausedSubscription', holderOf(serverId), queue[pick % queue.length].id);
    },
    setTier: (tierId: string, displayName?: string) => op('setTier', tierId, serverTierDef(tierId, displayName)),
    deleteTier,

    /** A subscription that exists at the seller and that premium was never told of (the P1 seller only). */
    orphan: (serverId: string, tierId: string, opts: { buyerId?: string | null; paused?: boolean; daysLeft?: number } = {}): SellerRecord => {
      const record = deliveries().checkout({ ...checkoutOwner(serverId, opts.buyerId === undefined ? defaultBuyer(serverId) : opts.buyerId), tierId, offeringId: `o-${tierId}`, paused: opts.paused });
      if (opts.daysLeft !== undefined) {
        record.pausedDaysLeft = opts.daysLeft;
        record.pausedAt = new Date().toISOString();
      }
      return record;
    },
    /** What the page lists for a holder: the seller's subscriptions premium does not hold, each with its plan. */
    orphans: (serverId: string): Promise<any[]> => (getPremiumManager() as any).findOrphansFor(holderOf(serverId)),
    adopt: (serverId: string, providerSubId: string, shown?: unknown) => op('adoptOrphan', holderOf(serverId), driver.id, providerSubId, ...(shown === undefined ? [] : [shown])),
    /**
     * A checkout ends at the seller, which then tells premium; a checkout premium did not install is refunded. A null
     * buyer is a checkout that names nobody.
     */
    async created(serverId: string, tierId: string, buyerId: string | null = defaultBuyer(serverId)): Promise<OpReply> {
      const record = deliveries().checkout({ ...checkoutOwner(serverId, buyerId), tierId, offeringId: `o-${tierId}` });
      const reply = await deliver(createdEvent(record));
      const held = [recordOf(serverId)?.active, ...(recordOf(serverId)?.paused ?? [])].some(s => s?.providerSubId === record.providerSubId);
      if (!held) deliveries().forget(record.providerSubId);
      return reply;
    },
    /** The seller delivers the created event of the server's active subscription again; null when it sold none. */
    async redelivered(serverId: string): Promise<OpReply | null> {
      const record = activeAtSeller(serverId);
      return record ? deliver(createdEvent(record)) : null;
    },
    /** The seller renews the server's active subscription and tells premium; null when it sold none. */
    async renewed(serverId: string): Promise<OpReply | null> {
      const record = activeAtSeller(serverId);
      const renewed = record && deliveries().renew(record.providerSubId);
      return renewed ? deliver(stateEvent('subscription.renewed', renewed)) : null;
    },
    async cancelled(serverId: string): Promise<OpReply | null> {
      const record = activeAtSeller(serverId);
      const cancelled = record && deliveries().cancelAtPeriodEnd(record.providerSubId);
      return cancelled ? deliver(stateEvent('subscription.cancelled', cancelled)) : null;
    },
    async expired(serverId: string): Promise<OpReply | null> {
      const record = activeAtSeller(serverId);
      const expired = record && deliveries().expire(record.providerSubId);
      return expired ? deliver(stateEvent('subscription.expired', expired)) : null;
    },
  };
}

/**
 * What the stored document breaks of K1 to K4 (sheet P1, section 4): every queue entry is paused; no subscription id
 * and no provider subscription id twice in a record; no empty slot beside a queue; the queue in priority order, manual
 * before paid at a tie.
 */
export function brokenStacking(doc: any): string[] {
  const broken: string[] = [];
  const priority = (sub: any): number => doc?.tiers?.[sub.tierId]?.priority ?? 0;
  for (const [key, record] of Object.entries<any>(doc?.subscriptions ?? {})) {
    const queue: any[] = record.paused ?? [];
    const all: any[] = [...(record.active ? [record.active] : []), ...queue];
    for (const entry of queue) if (entry.status !== 'paused') broken.push(`K1: ${key} holds queue entry ${entry.id} with status ${entry.status}`);
    const ids = all.map(s => s.id);
    if (new Set(ids).size !== ids.length) broken.push(`K2: ${key} holds a subscription id twice (${ids.join(', ')})`);
    const providerIds = all.filter(s => s.providerSubId).map(s => `${s.providerId}:${s.providerSubId}`);
    if (new Set(providerIds).size !== providerIds.length) broken.push(`K2: ${key} holds a provider subscription twice (${providerIds.join(', ')})`);
    if (!record.active && queue.length > 0) broken.push(`K3: ${key} has an empty slot and ${queue.length} queued`);
    for (let i = 1; i < queue.length; i++) {
      const a = queue[i - 1];
      const b = queue[i];
      if (priority(a) < priority(b) || (priority(a) === priority(b) && a.source !== 'manual' && b.source === 'manual')) {
        broken.push(`K4: ${key}'s queue is out of order at ${i} (${a.tierId}/${a.source} before ${b.tierId}/${b.source})`);
      }
    }
  }
  return broken;
}

/**
 * What the stored document breaks of N1 to N3 (sheet P1, section 4): every key of `subscriptions` is a holder key;
 * every subscription's tier, where the tier exists, is of the holder's kind; every paid subscription has a buyer, and
 * a user's is the user.
 */
export function brokenHolders(doc: any): string[] {
  const broken: string[] = [];
  for (const [key, record] of Object.entries<any>(doc?.subscriptions ?? {})) {
    const match = /^(guild|user):[1-9][0-9]{0,19}$/.exec(key);
    if (!match) {
      broken.push(`N1: '${key}' is not a holder key`);
      continue;
    }
    for (const sub of [...(record.active ? [record.active] : []), ...(record.paused ?? [])]) {
      if (sub.source === 'paid') {
        if (typeof sub.buyerId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(sub.buyerId)) broken.push(`N3: ${key} holds the paid subscription ${sub.id} with no buyer`);
        else if (match[1] === 'user' && `user:${sub.buyerId}` !== key) broken.push(`N3: ${key} holds the paid subscription ${sub.id} paid by ${sub.buyerId}`);
      }
      const tier = doc.tiers?.[sub.tierId];
      if (!tier) continue;
      const kind = tier.kind === 'user' ? 'user' : 'guild';
      if (kind !== match[1]) broken.push(`N2: ${key} holds subscription ${sub.id} of the ${kind} tier ${sub.tierId}`);
    }
  }
  return broken;
}
