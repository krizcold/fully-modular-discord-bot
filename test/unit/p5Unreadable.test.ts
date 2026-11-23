import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P5 code review 1, findings A2 and B1: a PayPal delivery whose handling finds premium unable to read premium-tiers.json
// (it became unreadable after the op's entry check) is not decided against premium's empty copy. It answers 400 and
// PayPal sends it again; once premium reads the file again, the same deliveries give premium the renewed end. Both
// backends.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { dataPath } from '../../src/utils/dataRoot';
import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { PREMIUM_KEY } from '../helpers/nb6PremiumRig';
import { z5End } from '../helpers/p5Model';
import type { PayPalEvent } from '../helpers/p5PayPal';
import { heldPayPal, IDS, p5World, type Delivered } from '../helpers/p5World';

const DAY = 86_400_000;
const T0 = Date.UTC(2027, 0, 31, 12);
const BACKENDS = [['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]] as const;
const PLAN_READ = /^\/v1\/billing\/plans\/[^/?]+$/;
const NOT_READ = 'PayPal webhook not applied: premium cannot read its subscriptions now; PayPal sends the event again.';

describe.each(BACKENDS)('P5 review 1 (A2, B1) on %s: deliveries while premium cannot read its copy', (_name, backend) => {
  const w = p5World(backend);
  const HOLDER = `guild:${IDS[0]}`;
  beforeEach(async () => { await w.setup({ clock: T0 }); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  const heldOf = (id: string) => heldPayPal(w.stored()).find(h => h.sub.providerSubId === id) ?? null;
  const errorOf = (out: Delivered): string => String((out.reply as any)?.error ?? (out.reply as any)?.body?.error ?? '');
  const file = (): string => dataPath('global', 'premium-tiers.json');
  /** Premium's stored copy replaced by `text` (the file, and on the rig its row too). */
  const store = (text: string): void => {
    fs.writeFileSync(file(), text);
    const row = w.rig?.m.state.rows.docs.get(PREMIUM_KEY);
    if (row) row.body = Buffer.from(text);
  };

  /**
   * The event delivered while premium's copy becomes unreadable after the op's entry check: its plan read is held, the
   * stored copy is replaced and premium drops its cache (as a change applied by another machine makes it), then the read
   * goes on. The copy is readable again afterwards.
   */
  async function duringOutage(event: PayPalEvent, good: string): Promise<{ out: Delivered; emitted: any[] }> {
    const held = w.fake.hold('GET', PLAN_READ);
    const delivery = w.deliver(event);
    await held.reached;
    store('{ not json');
    getPremiumManager().invalidate();
    const from = w.emitted.length;
    held.release();
    const out = await delivery;
    const emitted = w.emitted.slice(from);
    expect(getPaymentRegistry().subscriptionViewReady()).toBe(false);
    expect(w.storedText()).toBe('{ not json');
    store(good);
    getPremiumManager().invalidate();
    expect(getPaymentRegistry().subscriptionViewReady()).toBe(true);
    return { out, emitted };
  }

  it('a renewal read ACTIVE, then a CANCELLED, while premium-tiers.json turns unreadable answer 400 and emit nothing; readable again, each delivery gives premium the end of Z5', async () => {
    const bought = await w.buyMember(HOLDER, IDS[0]);
    const id = bought.subscriptionId!;
    w.fake.approve(id);
    await w.drain();
    await w.settle();
    const first = heldOf(id)!.sub;
    expect([first.status, first.autoRenew]).toEqual(['active', true]);
    const good = w.storedText()!;

    w.later(29 * DAY);
    w.fake.renew(id);
    const renewal = w.fake.dequeue(0)!;
    expect([renewal.event_type, w.fake.subscriptions.get(id)!.status]).toEqual(['PAYMENT.SALE.COMPLETED', 'ACTIVE']);
    const renewed = await duringOutage(renewal, good);
    expect([renewed.out.status, errorOf(renewed.out), renewed.emitted]).toEqual([400, NOT_READ, []]);
    expect(w.storedText()).toBe(good);
    expect((await w.deliver(renewal)).status).toBe(200);
    await w.settle();
    const afterRenewal = heldOf(id)!.sub;
    expect([afterRenewal.status, afterRenewal.autoRenew, Date.parse(afterRenewal.endDate)]).toEqual(['active', true, z5End(w.fake, id).end]);
    expect(Date.parse(afterRenewal.endDate)).toBeGreaterThan(Date.parse(first.endDate));

    w.fake.buyerCancel(id);
    const cancelled = w.fake.dequeue(0)!;
    expect(cancelled.event_type).toBe('BILLING.SUBSCRIPTION.CANCELLED');
    const outage = await duringOutage(cancelled, w.storedText()!);
    expect([outage.out.status, errorOf(outage.out), outage.emitted]).toEqual([400, NOT_READ, []]);
    expect(heldOf(id)!.sub.autoRenew).toBe(true);
    expect((await w.deliver(cancelled)).status).toBe(200);
    await w.settle();
    const held = heldOf(id)!.sub;
    expect([held.status, held.autoRenew, held.providerMeta.paypalStatus, Date.parse(held.endDate)]).toEqual(['active', false, 'CANCELLED', z5End(w.fake, id).end]);
  });
});
