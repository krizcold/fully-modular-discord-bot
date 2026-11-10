import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { premiumRig } from '../helpers/nb6PremiumRig';
import { DAY_MS, dummyRig } from '../helpers/nb6DummyRig';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';

// NB25 decision 7 (wip-redesign/sheets/NB25.md, section 8 item 2): a paused paid sub of a provider other than the Dummy
// that enters the active slot through a provider event, with no live active sub, is saved as today (status 'paused')
// and makes no provider call. The adoption is the only path NB25 changes.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  let registry: InstanceType<typeof real.PaymentProviderRegistry> | null = null;
  return { ...real, getPaymentRegistry: () => (registry ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

const r = premiumRig();
const d = dummyRig(r);
const calls: string[] = [];

beforeEach(async () => {
  await d.setup();
  calls.length = 0;
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { supportsPause: true }, isConfigured: () => true,
    resumeSubscription: async (id: string) => { calls.push(`resume:${id}`); },
    pauseSubscription: async (id: string) => { calls.push(`pause:${id}`); },
  } as any);
});
afterEach(async () => {
  getPaymentRegistry().unregister('fake');
  await d.teardown();
});

describe('decision 7: intoActiveSlot stays as it is', () => {
  it("a paused non-Dummy sub created by an event goes into the active slot paused, with no provider call", async () => {
    getPaymentRegistry().emitEvent({
      type: 'subscription.created', providerId: 'fake', providerSubId: 'ev1', guildId: 'g1', tierId: 'silver', offeringId: 'o2',
      state: { status: 'paused', startDate: new Date().toISOString(), endDate: new Date(Date.now() + 10 * DAY_MS).toISOString(), autoRenew: true },
    } as any);
    await vi.waitFor(() => expect(r.row()?.subscriptions?.g1?.active?.providerSubId).toBe('ev1'), { timeout: 5000, interval: 10 });
    await d.settle();
    expect(r.row().subscriptions.g1.active.status).toBe('paused');
    expect(calls).toEqual([]);
  });
});
