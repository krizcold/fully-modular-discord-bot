import { addCycles, type FakePayPal, type Unit } from './p5PayPal';

// The end rule of sheet P5, Revision 9, Z5, computed from the fake's own fields, for the rows of p5Events and p5Props;
// and sheet P5P's rules for a pay-once subscription (Y2: the payment proof, the later payments, the end), computed
// from what the fake answers a read and a transactions list.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const LONGEST_DAYS: Record<Unit, number> = { DAY: 1, WEEK: 7, MONTH: 31, YEAR: 366 };

export interface ModelEnd {
  /** Status ACTIVE and a `paid` exists. */
  live: boolean;
  /** `sideEnd + window` (PayPal's part of the end), null with no `paid`. */
  side: number | null;
  failing: boolean;
  windowApplies: boolean;
  /** `max(heldEnd, side)`; null with no `paid`. */
  end: number | null;
}

/**
 * Z5's end of a subscription the fake holds. `held` is premium's copy when premium holds it active: its end enters
 * only when it differs from its `providerMeta.computedEnd`.
 */
export function z5End(fake: FakePayPal, id: string, held?: { endDate: string | null; providerMeta?: any } | null): ModelEnd {
  const sub = fake.subscriptions.get(id);
  if (!sub) throw new Error(`p5Model: no subscription ${id}`);
  const plan = fake.plans.get(sub.plan_id);
  if (!plan) throw new Error(`p5Model: no plan ${sub.plan_id}`);
  const cycles = [...plan.billing_cycles].sort((a: any, b: any) => a.sequence - b.sequence);
  const regular = cycles.find((c: any) => c.tenure_type === 'REGULAR');
  const info = sub.billing_info ?? {};
  const lastPayment = Date.parse(info.last_payment?.time ?? '');
  let paid: number | null = null;
  let longest: number | null = null;
  if (Number.isFinite(lastPayment)) {
    paid = addCycles(lastPayment, regular.frequency.interval_unit, regular.frequency.interval_count, 1);
    longest = lastPayment + LONGEST_DAYS[regular.frequency.interval_unit as Unit] * regular.frequency.interval_count * DAY_MS;
  } else if (cycles[0]?.tenure_type === 'TRIAL') {
    const start = Date.parse(sub.start_time);
    paid = start;
    longest = start;
    for (const c of cycles.filter((x: any) => x.tenure_type === 'TRIAL')) {
      paid = addCycles(paid, c.frequency.interval_unit, c.frequency.interval_count, c.total_cycles);
      longest += LONGEST_DAYS[c.frequency.interval_unit as Unit] * c.frequency.interval_count * c.total_cycles * DAY_MS;
    }
  }
  const lastFailed = Date.parse(info.last_failed_payment?.time ?? '');
  const failing = (Number.isFinite(lastFailed) && (!Number.isFinite(lastPayment) || lastFailed > lastPayment)) || (info.failed_payments_count ?? 0) > 0;
  const windowApplies = sub.status === 'ACTIVE' && failing;
  if (paid === null || longest === null) return { live: false, side: null, failing, windowApplies, end: null };
  const next = Date.parse(info.next_billing_time ?? '');
  const side = Math.min(Number.isFinite(next) ? next : paid, longest) + DAY_MS + (windowApplies ? 10 * DAY_MS : 0);
  let end = side;
  if (held?.endDate && Date.parse(held.endDate) !== Date.parse(held.providerMeta?.computedEnd)) {
    end = Math.max(end, Date.parse(held.endDate));
  }
  return { live: sub.status === 'ACTIVE', side, failing, windowApplies, end };
}

export interface OnceProof {
  proof: 'paid' | 'refunded' | 'none' | 'unknown';
  /** The earliest kept payment's time, with proof `paid`. */
  T: number | null;
}

const PAYMENT = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const KEPT = ['COMPLETED', 'PARTIALLY_REFUNDED'];

/** Y2's payment proof of a pay-once subscription for an event of `eventType`, from the fake's read and list as it answers them now. */
export function onceProof(fake: FakePayPal, id: string, eventType: string): OnceProof {
  const object = fake.subscriptions.get(id);
  if (!object) throw new Error(`p5Model: no subscription ${id}`);
  const sub = fake.subscriptionOut(object);
  const listed = fake.listed(id) ?? [];
  const payments = listed.filter(t => PAYMENT.includes(t.status)).map(t => ({ status: t.status as string, time: Date.parse(t.time) }));
  const lp = Date.parse(sub.billing_info?.last_payment?.time ?? '');
  let match: { status: string; time: number } | null = null;
  if (Number.isFinite(lp)) {
    for (const p of payments) {
      if (Math.abs(p.time - lp) <= HOUR_MS && (!match || Math.abs(p.time - lp) < Math.abs(match.time - lp))) match = p;
    }
  }
  const lpAlone = Number.isFinite(lp) && !match;
  const kept = [...payments.filter(p => KEPT.includes(p.status)).map(p => p.time), ...(lpAlone ? [lp] : [])];
  if (kept.length > 0) return { proof: 'paid', T: Math.min(...kept) };
  const executions = sub.billing_info?.cycle_executions;
  if (payments.length > 0) {
    const regular = Array.isArray(executions) ? executions.find((c: any) => c.tenure_type === 'REGULAR') : undefined;
    const completed = Number(regular?.cycles_completed);
    const counted = regular !== undefined && Number.isFinite(completed);
    const positive = match?.status === 'REFUNDED' || (counted && completed <= payments.length);
    const contrary = lpAlone || (counted && completed > payments.length);
    return { proof: positive && !contrary ? 'refunded' : 'unknown', T: null };
  }
  const beforeApproval = sub.status === 'APPROVAL_PENDING' || sub.status === 'APPROVED';
  const noneCompleted = Array.isArray(executions) && executions.length > 0 && executions.every((c: any) => Number(c.cycles_completed) === 0);
  if (listed.length === 0 && eventType !== 'PAYMENT.SALE.COMPLETED' && (beforeApproval || noneCompleted)) return { proof: 'none', T: null };
  return { proof: 'unknown', T: null };
}

/** The third rule's later payments: each kept listed payment more than an hour after `T`, by its listed id. */
export function laterPayments(fake: FakePayPal, id: string): string[] {
  const { proof, T } = onceProof(fake, id, 'BILLING.SUBSCRIPTION.UPDATED');
  if (proof !== 'paid' || T === null) return [];
  return (fake.listed(id) ?? []).filter(t => KEPT.includes(t.status) && Date.parse(t.time) > T + HOUR_MS).map(t => t.id);
}

/** `onceEnd(T)`, or the state's end `max(keptEnd, onceEnd(T))` with `keptEnd`; null unless the proof is `paid`. */
export function onceEnd(fake: FakePayPal, id: string, keptEnd?: string | number | null): number | null {
  const { proof, T } = onceProof(fake, id, 'BILLING.SUBSCRIPTION.UPDATED');
  if (proof !== 'paid' || T === null) return null;
  const sub = fake.subscriptions.get(id)!;
  const regular = fake.plans.get(sub.plan_id)!.billing_cycles.find((c: any) => c.tenure_type === 'REGULAR');
  const unit = regular.frequency.interval_unit as Unit;
  const count = regular.frequency.interval_count;
  const end = Math.min(addCycles(T, unit, count, 1), T + LONGEST_DAYS[unit] * count * DAY_MS) + DAY_MS;
  const kept = keptEnd === undefined || keptEnd === null ? Number.NaN : typeof keptEnd === 'number' ? keptEnd : Date.parse(keptEnd);
  return Number.isFinite(kept) ? Math.max(kept, end) : end;
}
