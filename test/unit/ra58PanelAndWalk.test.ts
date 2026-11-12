import { afterEach, describe, expect, it } from 'vitest';
import { checkPanelPermissions } from '../../src/bot/internalSetup/utils/panel/panelPermissions';
import { PaymentProviderRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import type { WalkBatch } from '../../src/bot/internalSetup/utils/payment/paymentTypes';
import { setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';

afterEach(() => {
  setSharedWriteGate(null);
});

describe('web UI panel access', () => {
  it('a guild web UI user outside the allowed list is refused', () => {
    const panel = { id: 'p1', allowedUsers: ['111111111111111111'] } as any;
    expect(checkPanelPermissions(panel, { accessMethod: 'web_ui', userId: '222222222222222222' } as any)).toBe(false);
  });

  it('the main web UI owner passes the same panel', () => {
    const panel = { id: 'p1', allowedUsers: ['111111111111111111'] } as any;
    expect(checkPanelPermissions(panel, { accessMethod: 'web_ui', userId: 'web-ui-owner' } as any)).toBe(true);
  });
});

const BATCH: WalkBatch = {
  premiumSha: null,
  events: [{
    type: 'subscription.renewed', providerId: 'dummy', providerSubId: 'dummy_1', guildId: 'g1',
    state: { status: 'active', startDate: '2026-01-01T00:00:00.000Z', endDate: null, autoRenew: true },
  }],
};

describe("the Dummy tick's walk batch in the web UI process", () => {
  it('outside a change the web UI applies, the batch is refused with the cause and reaches no listener', () => {
    const registry = new PaymentProviderRegistry();
    const seen: WalkBatch[] = [];
    registry.on('provider.walk-batch', (b: WalkBatch) => seen.push(b));
    setSharedWriteGate(() => false);
    expect(() => registry.emitWalkBatch(BATCH)).toThrow(
      '[Data] A payment event (provider.walk-batch) was raised in the web UI process outside a change it applies; the bot process handles payment events while it runs',
    );
    expect(seen).toEqual([]);
  });

  it('inside a change the web UI applies, the batch reaches its listener', () => {
    const registry = new PaymentProviderRegistry();
    const seen: WalkBatch[] = [];
    registry.on('provider.walk-batch', (b: WalkBatch) => seen.push(b));
    setSharedWriteGate(() => true);
    registry.emitWalkBatch(BATCH);
    expect(seen).toEqual([BATCH]);
  });
});
