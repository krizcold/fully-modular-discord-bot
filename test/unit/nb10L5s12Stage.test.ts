import { describe, expect, it, vi } from 'vitest';

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => ({
  ...(await orig<any>()),
  getPaymentRegistry: () => ({ on: () => undefined, off: () => undefined, get: () => undefined, list: () => [], startTickers: () => undefined, emitEvent: () => undefined }),
}));

import { ipcStageOf } from '../../src/webui/botManager';

// NB10 tests 8 and 23 (the web UI's side): a message whose handler the bot registers before it reports shared waits
// only for shared; every other one waits for guild.

describe('the stage a message to the bot waits for', () => {
  it('shared for the shared op, the global read, maintenance enter and leave, and every fleet: and metrics: message', () => {
    for (const type of ['shared:op', 'data:global-read', 'maintenance:enter', 'maintenance:leave', 'fleet:status', 'fleet:', 'metrics:snapshot', 'metrics:']) {
      expect(ipcStageOf(type), type).toBe('shared');
    }
  });

  it('guild for the rest, a type that only ends with fleet: or metrics: included', () => {
    for (const type of ['data:write', 'guild:read', 'panel:update', 'x-fleet:', 'x-metrics:', 'maintenance:other', '']) {
      expect(ipcStageOf(type), type).toBe('guild');
    }
  });
});
