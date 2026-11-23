import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Sheet P5P, Q6's PW6 rows and Q7, on the JSON files and on the mirror rig (A6): when the second rule's cancel fails
// after premium applied the install, the delivery answers 400 PW6 and premium keeps what it applied; the next delivery
// tries the cancel again. A cancel that landed while premium refused its save is followed by an install from the
// CANCELLED read at the resend (premium stopped between the view read and the emit, both backends).

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  const store = { getCachedModules: () => [], getRepositories: () => [], getInstalledModules: () => [], getAvailableModules: async () => [] };
  return { ...real, getAppStoreManager: () => store };
});

import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { allowDropLines } from '../helpers/p1Guard';
import { onceEnd } from '../helpers/p5Model';
import type { PayPalEvent } from '../helpers/p5PayPal';
import { p5World } from '../helpers/p5World';
import { holderOf, KINDS, onceKit, PL16, PW6, type Kind } from '../helpers/p5pOnce';

const T0 = Date.UTC(2027, 0, 31, 12);
const BACKENDS = [['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]] as const;
const cancelPath = (id: string): RegExp => new RegExp(`^/v1/billing/subscriptions/${id}/cancel$`);
const readPath = (id: string): RegExp => new RegExp(`^/v1/billing/subscriptions/${id}$`);
let reads = 0;
const readOf = (id: string): PayPalEvent => ({ id: `WH-P5P-BK-${id}-${reads++}`, event_version: '1.0', create_time: new Date().toISOString(), resource_type: 'subscription', resource_version: '2.0', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', summary: 'read', resource: { id }, links: [] });

describe.each(BACKENDS)('P5P Q6 and Q7 on %s', (_name, backend) => {
  const w = p5World(backend);
  const o = onceKit(w);
  beforeEach(async () => { await w.setup({ clock: T0 }); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  async function approved(k: Kind): Promise<string> {
    const id = await o.buy(k);
    w.fake.configure(id, { finalCycle: 'stays-active' });
    w.fake.approve(id);
    w.fake.queue.length = 0;
    return id;
  }

  describe.each(KINDS)('Q6, for %s', (_kind, k) => {
    it.each([
      ['422 with the fake still ACTIVE', { status: 422, message: 'Refused by the p5p row.' }, (id: string) => PW6.refused(id, 'Refused by the p5p row', 'ACTIVE')],
      ['503', { status: 503 }, (id: string) => PW6.noAnswer(id, 'PayPal answered 503: An internal server error has occurred.')],
      ['no answer', { drop: 'before' as const }, (id: string) => PW6.noAnswer(id, 'PayPal did not answer: fetch failed')],
    ] as const)('the cancel answering %s: 400 PW6, premium keeps the install, and the next delivery cancels it', async (_label, fault, text) => {
      const id = await approved(k);
      w.fake.fail('POST', cancelPath(id), fault as any);
      const out = await w.deliver(readOf(id));
      expect([out.status, o.errorOf(out)]).toEqual([400, text(id)]);
      expect(o.heldOf(id)).toMatchObject({ location: 'active', sub: { status: 'active', autoRenew: false } });
      expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
      const again = await w.deliver(readOf(id));
      expect([again.status, w.fake.subscriptions.get(id)!.status, o.logged(PL16(id, k)).length]).toEqual([200, 'CANCELLED', 1]);
      expect(o.heldOf(id)?.location).toBe('active');
    });

    it('a refused sign-in at the cancel: 400 PW6 not-sent, premium keeps the install, the next delivery cancels it', async () => {
      const id = await approved(k);
      const hold = w.fake.hold('GET', /\/transactions\?/);
      const first = w.deliver(readOf(id));
      await hold.reached;
      (getPaymentRegistry().get('paypal') as any).tokenCache = null;
      w.fake.fail('POST', /^\/v1\/oauth2\/token$/, { status: 401 });
      hold.release();
      const out = await first;
      expect([out.status, o.errorOf(out)]).toEqual([400, PW6.notSent(id, 'the bot could not sign in to PayPal: PayPal answered 401')]);
      expect([o.heldOf(id)?.location, o.cancels(id)]).toEqual(['active', 0]);
      const again = await w.deliver(readOf(id));
      expect([again.status, w.fake.subscriptions.get(id)!.status]).toEqual([200, 'CANCELLED']);
    });

    it("the cancel's 4xx read answering 404: PW6's 404 form; PL9 at the resend", async () => {
      const id = await approved(k);
      w.fake.fail('POST', cancelPath(id), { status: 422 });
      const hold = w.fake.hold('POST', cancelPath(id));
      const first = w.deliver(readOf(id));
      await hold.reached;
      w.fake.fail('GET', readPath(id), { status: 404 });
      hold.release();
      const out = await first;
      expect([out.status, o.errorOf(out)]).toEqual([400, PW6.missing(id)]);
      w.fake.deleteObject('subscription', id);
      const event = readOf(id);
      const again = await w.deliver(event);
      expect(again.status).toBe(200);
      expect(o.logged(`[PayPalProvider] A BILLING.SUBSCRIPTION.ACTIVATED event was not applied: PayPal has no subscription ${id} (404).`)).toHaveLength(1);
    });
  });

  describe.each(KINDS)('Q7, for %s', (_kind, k) => {
    it('the first delivery while premium refuses at entry (stopped after the view was read): the cancel lands; refusals over and the event delivered again: installed once with onceEnd(T), no second cancel', async () => {
      const id = await approved(k);
      const event = readOf(id);
      const pm: any = o.premium();
      const registry: any = getPaymentRegistry();
      const read = registry.readSubscription.bind(registry);
      let refusing = true;
      const spy = vi.spyOn(registry, 'readSubscription').mockImplementation((...args: any[]) => {
        const view = read(...args);
        if (refusing && args[2] === id) pm.stopped = 'stopping';
        return view;
      });
      try {
        await w.deliver(event);
      } finally {
        refusing = false;
        pm.stopped = null;
        spy.mockRestore();
      }
      expect([o.heldOf(id), o.cancels(id), w.fake.subscriptions.get(id)!.status]).toEqual([null, 1, 'CANCELLED']);
      const again = await w.deliver(event);
      expect(again.status).toBe(200);
      expect(o.heldOf(id)?.location).toBe('active');
      expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
      expect([o.installLines(id).length, o.cancels(id)]).toEqual([1, 1]);
    });

    it("premium refusing the install with its 'priority' warning: the cancel lands, nothing installed; once the held tier is removed, the CANCELLED delivery installs it with onceEnd(T)", async () => {
      allowDropLines('L3');
      const held = await o.buy(k, { renewing: true });
      const id = await o.buy(k);
      w.fake.approve(held);
      await o.drain();
      w.fake.configure(id, { finalCycle: 'stays-active' });
      w.fake.approve(id);
      w.fake.queue.length = 0;
      const out = await w.deliver(readOf(id));
      expect(out.status).toBe(200);
      expect([o.heldOf(id), o.heldOf(held)?.location, w.fake.subscriptions.get(id)!.status]).toEqual([null, 'active', 'CANCELLED']);
      expect(o.logged(`subscription.created from PayPal (subscription ${id}`).some(l => l.includes('already holds') && l.includes('If PayPal keeps billing it, cancel it there; refund it at PayPal if it was paid.'))).toBe(true);
      expect((await w.op('cancelPaidSubscriptionImmediately', holderOf(k))).ok).toBe(true);
      expect(o.heldOf(held)).toBeNull();
      const cancelled = o.take('BILLING.SUBSCRIPTION.CANCELLED', id);
      w.fake.queue.length = 0;
      expect((await w.deliver(cancelled)).status).toBe(200);
      expect(o.heldOf(id)?.location).toBe('active');
      expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
    });
  });
});
