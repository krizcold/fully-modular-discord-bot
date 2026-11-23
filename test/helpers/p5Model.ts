import { addCycles, type FakePayPal, type Unit } from './p5PayPal';

// The end rule of sheet P5, Revision 9, Z5, computed from the fake's own fields, for the rows of p5Events and p5Props.

const DAY_MS = 86_400_000;
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
