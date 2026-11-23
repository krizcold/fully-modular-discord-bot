import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { holderWords } from '../../src/bot/internalSetup/utils/premiumHolder';
import type { FakeSettings, PayPalEvent } from './p5PayPal';
import { heldPayPal, IDS, planId, TIERS, type Delivered, type P5World, type TierId } from './p5World';

// Sheet P5P's rows on a pay-once subscription: a purchase with the opt-out (a server on the member route, a user
// through premium's op, since the dev user route does not pass the opt-out), the fake's settings set before approval,
// and the texts of Y6.

export type Kind = 'guild' | 'user';
export const KINDS: Array<[string, Kind]> = [['a server', 'guild'], ['a user', 'user']];
export const FINAL_CYCLES = ['expire-at-payment', 'active-to-period-end', 'stays-active'] as const;
export const SUB_READ = /^\/v1\/billing\/subscriptions\/I-[^/?]+$/;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const holderOf = (k: Kind): string => (k === 'guild' ? `guild:${IDS[0]}` : `user:${IDS[1]}`);
export const buyerOf = (k: Kind): string => (k === 'guild' ? IDS[0] : IDS[1]);
export const tierOf = (k: Kind, level: 'low' | 'high' = 'low'): TierId => TIERS[k][level];
export const words = (k: Kind): string => holderWords(holderOf(k) as any);
export const isoOf = (at: number): string => new Date(at).toISOString();

export const PL16 = (id: string, k: Kind): string => `[PayPalProvider] Subscription ${id} (${words(k)}) was sold as one payment and its payment is recorded, so the bot cancelled it at PayPal to stop any further charge.`;
export const PL16_ALREADY = (id: string, k: Kind, word: 'cancelled' | 'expired'): string => `[PayPalProvider] Subscription ${id} (${words(k)}) was sold as one payment; it was already ${word} at PayPal, so the bot cancelled nothing.`;
export const PL17 = (sale: string, at: number, id: string, k: Kind): string => `[PayPalProvider] PayPal took another payment (sale ${sale}, ${isoOf(at)}) for subscription ${id} (${words(k)}), which was sold as one payment; the tier covers only its earliest payment not refunded, so refund this one in PayPal's dashboard. Refunding it changes nothing in the bot.`;
export const PL17_ANY = (id: string): string => `for subscription ${id} (`;
export const PL18 = (sale: string, id: string, k: Kind, T: number, end: number | 'queue'): string => `[PayPalProvider] Sale ${sale} was refunded in full; subscription ${id} (${words(k)}) keeps its tier for its payment of ${isoOf(T)}${end === 'queue' ? ' in the queue' : `, until ${isoOf(end)}`}.`;
const PW6_TAIL = ' The subscription was sold as one payment, and PayPal may charge it again until it is cancelled; PayPal sends the event again and the bot tries the cancel again.';
export const PW6 = {
  refused: (id: string, message: string, status: string): string => `PayPal webhook handled, but PayPal refused to cancel subscription ${id} (${message}) and its status there is ${status}.${PW6_TAIL}`,
  noAnswer: (id: string, reason: string): string => `PayPal webhook handled, but the bot can't confirm whether PayPal cancelled subscription ${id} (${reason}).${PW6_TAIL}`,
  notSent: (id: string, why: string): string => `PayPal webhook handled, but the bot did not ask PayPal to cancel subscription ${id} (${why}).${PW6_TAIL}`,
  missing: (id: string): string => `PayPal webhook handled, but PayPal has no subscription ${id} (404), so the bot cancelled nothing.`,
};
export const PW7 = (id: string, why: string): string => `PayPal webhook not applied: the bot can't confirm the payment of subscription ${id} at PayPal (${why}); PayPal sends the event again.`;
export const PW7_NONE = 'PayPal lists no payment for it yet';
export const PW8 = (sale: string, id: string): string => `PayPal webhook not applied: sale ${sale} was refunded, and PayPal does not list it yet among the payments of subscription ${id}, which was sold as one payment; PayPal sends the event again.`;
export const PL6 = (sale: string, id: string, k: Kind, how: 'was cancelled at PayPal' | 'was already cancelled at PayPal' | 'had already expired at PayPal'): string => `[PayPalProvider] Sale ${sale} was refunded in full; subscription ${id} (${words(k)}) ${how}, and the event that ends it in the bot was raised.`;

export function onceKit(w: P5World) {
  const kit = {
    /** A pay-once purchase; the subscription it made at the fake. */
    async buy(k: Kind, opts: { level?: 'low' | 'high'; plan?: string; renewing?: boolean } = {}): Promise<string> {
      const tierId = tierOf(k, opts.level);
      const more = opts.renewing ? {} : { autoRenewOptOut: true };
      const plan = opts.plan ?? planId(tierId, 'cheap');
      const reply = k === 'guild'
        ? await w.buyMember(holderOf(k), buyerOf(k), { tierId, plan, more })
        : await w.buyOp(holderOf(k), buyerOf(k), { tierId, plan, more });
      if (!reply.subscriptionId) throw new Error(`the purchase made no subscription: ${JSON.stringify(reply.body)}`);
      return reply.subscriptionId;
    },
    /** Bought, the settings set, approved and every queued event delivered. */
    async owned(k: Kind, opts: { level?: 'low' | 'high'; plan?: string; renewing?: boolean; settings?: FakeSettings; firstSale?: 'now' | 'later' } = {}): Promise<string> {
      const id = await kit.buy(k, opts);
      if (opts.settings) w.fake.configure(id, opts.settings);
      w.fake.approve(id, { firstSale: opts.firstSale });
      await kit.drain();
      return id;
    },
    /** Every queued event delivered, the oldest first, including the ones premium's calls queue meanwhile. */
    async drain(): Promise<Delivered[]> {
      const outs = await w.drain();
      await w.settle();
      outs.push(...await w.drain());
      return outs;
    },
    /** The log lines written so far that contain the text, on either backend (the mirror rig keeps its own lines). */
    logged: (text: string): string[] => [...w.logs, ...(w.rig?.m.state.lines ?? [])].filter(l => l.includes(text)),
    heldOf: (id: string) => heldPayPal(w.stored()).find(h => h.sub.providerSubId === id) ?? null,
    endOf: (id: string): number => Date.parse(kit.heldOf(id)!.sub.endDate),
    /** The queued event of this type for the subscription (or a sale of it), taken out of the queue. */
    take(type: string, id: string): PayPalEvent {
      const index = w.fake.queue.findIndex(e => e.event_type === type && kit.names(e, id));
      if (index < 0) throw new Error(`no queued ${type} for ${id}`);
      return w.fake.dequeue(index)!;
    },
    /** The event names the subscription: as its resource, the sale's subscription, or a refund's sale's. */
    names: (e: PayPalEvent, id: string): boolean => e.resource.id === id || e.resource.billing_agreement_id === id || w.fake.sales.get(e.resource.sale_id)?.billing_agreement_id === id,
    lastDelivered(type: string, id: string): PayPalEvent {
      const found = [...w.delivered].reverse().find(d => d.event?.event_type === type && kit.names(d.event, id));
      if (!found?.event) throw new Error(`no delivered ${type} for ${id}`);
      return found.event;
    },
    cancels: (id: string): number => w.fake.callsOf('POST', new RegExp(`^/v1/billing/subscriptions/${id}/cancel$`)).length,
    activates: (id: string): number => w.fake.callsOf('POST', new RegExp(`^/v1/billing/subscriptions/${id}/activate$`)).length,
    suspends: (id: string): number => w.fake.callsOf('POST', new RegExp(`^/v1/billing/subscriptions/${id}/suspend$`)).length,
    reads: (id: string): number => w.fake.callsOf('GET', new RegExp(`^/v1/billing/subscriptions/${id}$`)).length,
    /** Premium's install lines for PayPal subscription id: the holder, tier and buyer its custom_id names (an audit line names premium's own id). */
    installLines(id: string) {
      const [holder, buyerId, tierId] = String(w.fake.subscriptions.get(id)?.custom_id ?? '').split('|');
      return w.auditLines().filter(l => l.action === 'subscription.install.paid' && l.providerId === 'paypal' && l.holder === holder && l.tierId === tierId && l.metadata?.buyerId === buyerId);
    },
    errorOf: (out: Delivered): string => String((out.reply as any)?.error ?? (out.reply as any)?.body?.error ?? ''),
    /** Premium's copy with no `updatedAt`, to compare two moments. */
    plain: (): any => JSON.parse(JSON.stringify(w.stored()?.subscriptions ?? {}, (key, value) => (key === 'updatedAt' ? undefined : value))),
    emittedFor: (id: string) => w.emitted.filter(e => e.providerSubId === id),
    premium: (): any => getPremiumManager(),
    /** Each held one's sale ids at the fake, oldest first. */
    sales: (id: string): string[] => w.fake.salesOf(id).map(s => s.id),
    saleTime: (sale: string): number => Date.parse(w.fake.sales.get(sale)!.create_time),
  };
  return kit;
}

/** The pay-once refund's own cancel failing after the tier was ended (review 1, A1); `held` when premium held the entry. */
const refundLead = (id: string, held: boolean): string => (held
  ? `PayPal webhook handled: the tier of subscription ${id} was ended, but`
  : `PayPal webhook handled: the bot holds no tier for subscription ${id}, but`);
const AGAIN = '; PayPal sends the event again and the bot tries the cancel again.';
export const RF = {
  refused: (id: string, held: boolean, message: string, status: string): string => `${refundLead(id, held)} PayPal refused to cancel it (${message}) and its status there is ${status}${AGAIN}`,
  unsure: (id: string, held: boolean, why: string): string => `${refundLead(id, held)} the bot can't confirm whether PayPal cancelled it (${why})${AGAIN}`,
  notSent: (id: string, held: boolean, why: string): string => `${refundLead(id, held)} the bot did not ask PayPal to cancel it (${why})${AGAIN}`,
  missing: (id: string, held: boolean): string => `${refundLead(id, held)} PayPal has no subscription ${id} (404), so the bot cancelled nothing.`,
};
/** PL18's forms when premium holds no tier for it, and when the end cannot be counted (review 1, A2 and A3). */
export const PL18_NONE = (sale: string, id: string, k: Kind): string => `[PayPalProvider] Sale ${sale} was refunded in full; the bot holds no tier for subscription ${id} (${words(k)}), so nothing changed.`;
export const PL18_UNCOUNTED = (sale: string, id: string, k: Kind, T: number): string => `[PayPalProvider] Sale ${sale} was refunded in full; subscription ${id} (${words(k)}) keeps its tier for its payment of ${isoOf(T)}.`;
/** PL18 when the refund's delivery ended the tier: the end computed from the kept payment had passed (review 2, A4). */
export const PL18_ENDED = (sale: string, id: string, k: Kind, T: number, end: number): string => `[PayPalProvider] Sale ${sale} was refunded in full; subscription ${id} (${words(k)}) was paid by its payment of ${isoOf(T)}, and its paid period ended at ${isoOf(end)}.`;
/** A paid pay-once subscription premium does not hold whose plan's billing cycle the bot cannot count (review 1, A3). */
export const PL19 = (id: string, k: Kind, T: number, plan: string): string => `[PayPalProvider] PayPal took the payment of subscription ${id} (${words(k)}) at ${isoOf(T)}, which was sold as one payment, but its plan ${plan} has a billing cycle the bot cannot count, so the bot installed no tier. Refund the payment in PayPal's dashboard.`;
