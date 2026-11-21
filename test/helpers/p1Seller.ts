import type { HolderKey } from '../../src/bot/internalSetup/utils/premiumHolder';
import type {
  InitiateOpts, InitiateResult, OfferingVariant, PaymentProvider, ProviderCapabilities, ProviderEvent,
  ProviderSubscriptionRef, ProviderSubscriptionState,
} from '../../src/bot/internalSetup/utils/payment/paymentTypes';

// P1's seller: a payment provider for the real registry that installs at once, as the Dummy provider does (its
// purchase answers `state` and `providerSubId`), and can also raise events as a webhook provider does. Its records
// live in memory and show only the states the Dummy shows: active, paused, expired. It speaks the new members only
// (holder, buyerId, listSubscriptionsFor) and sells both kinds. P2 points the rows that use it at the real Dummy.

export const SELLER_ID = 'p1seller';
export const SELLER_NAME = 'P1 Seller';
export const SELLER_VARIANT = 'p1_monthly';
export const DAY_MS = 86_400_000;

export const SELLER_VARIANT_SNAPSHOT: OfferingVariant = {
  variantId: SELLER_VARIANT, label: 'Monthly', amount: 500, currency: 'USD', durationDays: 30, recurring: true, active: true,
} as OfferingVariant;

export interface SellerRecord {
  providerSubId: string;
  /** The holder the purchase or the checkout named. */
  holder: HolderKey;
  /** The Discord user who paid; a record without one is a checkout that named nobody. */
  buyerId?: string;
  tierId: string;
  offeringId: string;
  variantId: string;
  status: 'active' | 'paused' | 'expired';
  startDate: string;
  endDate: string | null;
  autoRenew: boolean;
  pausedDaysLeft?: number | null;
  /** When the bot recorded pausedDaysLeft, as Stripe lists it beside the days. */
  pausedAt?: string;
}

export interface SellerCall { method: string; args: unknown[] }

const CAPABILITIES: ProviderCapabilities = {
  canInitiatePurchase: true,
  supportsCancel: true,
  supportsReactivate: true,
  supportsCoupons: false,
  supportsPause: true,
  supportsMultipleVariants: true,
  supportsProductMode: false,
  supportsHostedPicker: false,
  supportsCustomerPortal: false,
  supportsAnnualBilling: false,
  supportsPriceMigration: true,
  mechanism: 'immediate',
  variantIdLabel: 'Seller variant',
  productIdLabel: '',
  sells: ['guild', 'user'],
};

export class P1Seller implements PaymentProvider {
  readonly id = SELLER_ID;
  readonly displayName = SELLER_NAME;
  readonly capabilities = CAPABILITIES;
  readonly records = new Map<string, SellerRecord>();
  /** Every call premium made, in order. */
  readonly calls: SellerCall[] = [];
  /** While set, a resume call waits on it after it was recorded: the row acts while the call is open. */
  holdResume: Promise<void> | null = null;
  private nextId = 1;

  constructor(private readonly emit: (event: ProviderEvent) => void) {}

  isConfigured(): boolean { return true; }

  stateOf(record: SellerRecord): ProviderSubscriptionState {
    return { status: record.status, startDate: record.startDate, endDate: record.endDate, autoRenew: record.autoRenew };
  }

  private make(opts: { holder: HolderKey; buyerId?: string; tierId: string; offeringId: string; variantId: string; autoRenew?: boolean; paused: boolean }): SellerRecord {
    const now = Date.now();
    const record: SellerRecord = {
      providerSubId: `p1s_${this.nextId++}`,
      holder: opts.holder,
      ...(opts.buyerId === undefined ? {} : { buyerId: opts.buyerId }),
      tierId: opts.tierId,
      offeringId: opts.offeringId,
      variantId: opts.variantId,
      status: opts.paused ? 'paused' : 'active',
      startDate: new Date(now).toISOString(),
      endDate: new Date(now + 30 * DAY_MS).toISOString(),
      autoRenew: opts.autoRenew ?? true,
    };
    this.records.set(record.providerSubId, record);
    return record;
  }

  async initiatePurchase(opts: InitiateOpts): Promise<InitiateResult> {
    this.calls.push({ method: 'initiatePurchase', args: [opts] });
    if (opts.holder === undefined) throw new Error('P1 Seller: the purchase names no holder');
    const record = this.make({ holder: opts.holder, buyerId: opts.buyerId, tierId: opts.tierId, offeringId: opts.offeringId, variantId: opts.variantId, autoRenew: opts.autoRenew, paused: opts.startPausedUntil !== undefined });
    return { providerSubId: record.providerSubId, state: this.stateOf(record), variantSnapshot: SELLER_VARIANT_SNAPSHOT };
  }

  async fetchVariant(variantId: string): Promise<OfferingVariant | null> {
    return variantId === SELLER_VARIANT ? SELLER_VARIANT_SNAPSHOT : null;
  }

  async listSubscriptionsFor(holder: HolderKey): Promise<ProviderSubscriptionRef[]> {
    this.calls.push({ method: 'listSubscriptionsFor', args: [holder] });
    return [...this.records.values()].filter(r => r.holder === holder && r.status !== 'expired').map(r => ({
      providerSubId: r.providerSubId,
      state: this.stateOf(r),
      metadata: {
        holder: r.holder, tierId: r.tierId, offeringId: r.offeringId, variantId: r.variantId,
        ...(r.buyerId === undefined ? {} : { buyerId: r.buyerId }),
        ...(r.status === 'paused' && r.pausedDaysLeft != null ? { pausedDaysLeft: r.pausedDaysLeft, ...(r.pausedAt === undefined ? {} : { pausedAt: r.pausedAt }) } : {}),
      },
      display: { amountLabel: '5.00 USD', periodLabel: 'monthly', statusLabel: r.status },
    }));
  }

  async getSubscriptionState(providerSubId: string): Promise<ProviderSubscriptionState | null> {
    const record = this.records.get(providerSubId);
    return record ? this.stateOf(record) : null;
  }

  async pauseSubscription(providerSubId: string, resumesAt: string | null, daysLeft?: number | null): Promise<void> {
    this.calls.push({ method: 'pauseSubscription', args: [providerSubId, resumesAt, daysLeft] });
    const record = this.records.get(providerSubId);
    if (!record || record.status === 'expired') return;
    record.status = 'paused';
    record.pausedDaysLeft = daysLeft ?? null;
    record.pausedAt = new Date().toISOString();
  }

  async resumeSubscription(providerSubId: string, newEndDate: string | null): Promise<void> {
    this.calls.push({ method: 'resumeSubscription', args: [providerSubId, newEndDate] });
    if (this.holdResume) await this.holdResume;
    const record = this.records.get(providerSubId);
    if (!record || record.status === 'expired') return;
    record.status = 'active';
    record.startDate = new Date().toISOString();
    record.endDate = newEndDate;
    delete record.pausedDaysLeft;
    delete record.pausedAt;
  }

  /** Answers the subscription's state after the change, as Stripe and the Dummy do. */
  async cancelSubscription(providerSubId: string, immediately?: boolean): Promise<ProviderSubscriptionState | void> {
    this.calls.push({ method: 'cancelSubscription', args: [providerSubId, immediately] });
    const record = this.records.get(providerSubId);
    if (!record) return;
    if (immediately) record.status = 'expired';
    else record.autoRenew = false;
    return this.stateOf(record);
  }

  async reactivateSubscription(providerSubId: string): Promise<ProviderSubscriptionState | void> {
    this.calls.push({ method: 'reactivateSubscription', args: [providerSubId] });
    const record = this.records.get(providerSubId);
    if (!record) return;
    if (record.status !== 'expired') record.autoRenew = true;
    return this.stateOf(record);
  }

  async migrateSubscriptionPrice(providerSubId: string, targetVariantId: string, proration: string): Promise<void> {
    this.calls.push({ method: 'migrateSubscriptionPrice', args: [providerSubId, targetVariantId, proration] });
    const record = this.records.get(providerSubId);
    if (record) record.variantId = targetVariantId;
  }

  /** A delivery, as a webhook provider gets one: the body is the event, and the provider raises it. */
  async handleWebhook(rawBody: Buffer): Promise<void> {
    this.emit(JSON.parse(rawBody.toString('utf8')) as ProviderEvent);
  }

  /** A checkout that ended at the seller: the record exists there before premium hears of it. */
  checkout(opts: { holder: HolderKey; buyerId?: string; tierId: string; offeringId: string; paused?: boolean }): SellerRecord {
    return this.make({ ...opts, variantId: SELLER_VARIANT, paused: opts.paused === true });
  }

  /** The seller's side of a renewal: thirty more days. */
  renew(providerSubId: string): SellerRecord | null {
    const record = this.records.get(providerSubId);
    if (!record || record.status !== 'active') return null;
    record.endDate = new Date((record.endDate ? Date.parse(record.endDate) : Date.now()) + 30 * DAY_MS).toISOString();
    return record;
  }

  /** The seller's side of a cancel at period end: the subscription stays active and does not renew. */
  cancelAtPeriodEnd(providerSubId: string): SellerRecord | null {
    const record = this.records.get(providerSubId);
    if (!record || record.status !== 'active') return null;
    record.autoRenew = false;
    return record;
  }

  /** The seller's side of an expiry. */
  expire(providerSubId: string): SellerRecord | null {
    const record = this.records.get(providerSubId);
    if (!record || record.status === 'expired') return null;
    record.status = 'expired';
    record.endDate = new Date(Date.now() - 1000).toISOString();
    return record;
  }

  /** A checkout premium did not install is refunded and gone at the seller. */
  forget(providerSubId: string): void {
    this.records.delete(providerSubId);
  }
}

/** A tier's offering sold through the seller, as setTier takes it. */
export const sellerOffering = (offeringId: string, label: string) => ({
  id: offeringId,
  label,
  providerLinks: [{
    providerId: SELLER_ID,
    enabled: true,
    mode: 'price',
    priceConfig: { entries: [{ variantId: SELLER_VARIANT }] },
    cache: { syncedAt: '2026-01-01T00:00:00.000Z', variants: [SELLER_VARIANT_SNAPSHOT] },
  }],
});
