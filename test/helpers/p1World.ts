import fs from 'fs';
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
import { DAY_MS, P1Seller, SELLER_ID, SELLER_VARIANT, sellerOffering, type SellerRecord } from './p1Seller';

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

export function p1World(backend: 'json' | 'rig' = 'json') {
  const role = process.env.BOT_PROCESS_ROLE;
  const rig = backend === 'rig' ? premiumRig() : null;
  let seller!: P1Seller;
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
    const active = recordOf(serverId)?.active;
    return active?.providerId === SELLER_ID ? seller.records.get(active.providerSubId) ?? null : null;
  };
  const stateEvent = (type: 'subscription.renewed' | 'subscription.cancelled' | 'subscription.expired', record: SellerRecord): ProviderEvent =>
    ({ type, providerId: SELLER_ID, providerSubId: record.providerSubId, ...eventOwner(record), state: seller.stateOf(record) }) as ProviderEvent;
  const createdEvent = (record: SellerRecord): ProviderEvent => ({
    type: 'subscription.created', providerId: SELLER_ID, providerSubId: record.providerSubId, ...eventOwner(record), ...eventBuyer(record),
    tierId: record.tierId, offeringId: record.offeringId, variantId: record.variantId, state: seller.stateOf(record),
  }) as ProviderEvent;

  return {
    get seller(): P1Seller { return seller; },
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
      seller = new P1Seller(event => getPaymentRegistry().emitEvent(event));
      getPaymentRegistry().register(seller);
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
        const reply = await op('setTier', tierId, tierDef(tierId));
        if (!reply.ok) throw new Error(`p1World: setTier ${tierId} was not saved: ${reply.error}`);
      }
      const activated = await op('setProviderActivation', SELLER_ID, true);
      if (!activated.ok) throw new Error(`p1World: the seller was not activated: ${activated.error}`);
    },
    async teardown(): Promise<void> {
      await settle();
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
    setUserTier: (tierId: string, displayName?: string) => op('setTier', tierId, USER_SOLD_TIER_IDS.includes(tierId) ? userSoldTierDef(tierId, displayName) : userTierDef(tierId, displayName)),
    /** The user tiers of USER_SOLD_TIER_IDS, each with its offering at the seller, saved through the op. */
    async addSoldUserTiers(): Promise<void> {
      for (const tierId of USER_SOLD_TIER_IDS) {
        const reply = await op('setTier', tierId, userSoldTierDef(tierId));
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
    purchase: (serverId: string, tierId: string, buyerId: string = defaultBuyer(serverId)) =>
      op('initiatePaidSubscription', holderOf(serverId), tierId, `o-${tierId}`, purchaseOptions(serverId, buyerId)),
    cancelNow: (serverId: string) => op('cancelPaidSubscriptionImmediately', holderOf(serverId)),
    /** Cancels the queue entry at `pick` (wrapped to the queue's length); null with an empty queue. */
    async cancelQueued(serverId: string, pick: number): Promise<OpReply | null> {
      const queue: any[] = recordOf(serverId)?.paused ?? [];
      if (queue.length === 0) return null;
      return op('cancelAndRemovePausedSubscription', holderOf(serverId), queue[pick % queue.length].id);
    },
    setTier: (tierId: string, displayName?: string) => op('setTier', tierId, tierDef(tierId, displayName)),
    deleteTier: (tierId: string) => op('deleteTier', tierId),

    /** A subscription that exists at the seller and that premium was never told of. */
    orphan: (serverId: string, tierId: string, opts: { buyerId?: string | null; paused?: boolean; daysLeft?: number } = {}): SellerRecord => {
      const record = seller.checkout({ ...checkoutOwner(serverId, opts.buyerId === undefined ? defaultBuyer(serverId) : opts.buyerId), tierId, offeringId: `o-${tierId}`, paused: opts.paused });
      if (opts.daysLeft !== undefined) {
        record.pausedDaysLeft = opts.daysLeft;
        record.pausedAt = new Date().toISOString();
      }
      return record;
    },
    /** What the page lists for a holder: the seller's subscriptions premium does not hold, each with its plan. */
    orphans: (serverId: string): Promise<any[]> => (getPremiumManager() as any).findOrphansFor(holderOf(serverId)),
    adopt: (serverId: string, providerSubId: string, shown?: unknown) => op('adoptOrphan', holderOf(serverId), SELLER_ID, providerSubId, ...(shown === undefined ? [] : [shown])),
    /**
     * A checkout ends at the seller, which then tells premium; a checkout premium did not install is refunded. A null
     * buyer is a checkout that names nobody.
     */
    async created(serverId: string, tierId: string, buyerId: string | null = defaultBuyer(serverId)): Promise<OpReply> {
      const record = seller.checkout({ ...checkoutOwner(serverId, buyerId), tierId, offeringId: `o-${tierId}` });
      const reply = await deliver(createdEvent(record));
      const held = [recordOf(serverId)?.active, ...(recordOf(serverId)?.paused ?? [])].some(s => s?.providerSubId === record.providerSubId);
      if (!held) seller.forget(record.providerSubId);
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
      const renewed = record && seller.renew(record.providerSubId);
      return renewed ? deliver(stateEvent('subscription.renewed', renewed)) : null;
    },
    async cancelled(serverId: string): Promise<OpReply | null> {
      const record = activeAtSeller(serverId);
      const cancelled = record && seller.cancelAtPeriodEnd(record.providerSubId);
      return cancelled ? deliver(stateEvent('subscription.cancelled', cancelled)) : null;
    },
    async expired(serverId: string): Promise<OpReply | null> {
      const record = activeAtSeller(serverId);
      const expired = record && seller.expire(record.providerSubId);
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
