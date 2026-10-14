import { describe, expect, it, vi } from 'vitest';

// BT-4's verdict over a scripted confirm, so it runs in its own file: a write the confirm answered ok for is not judged
// again when the ledger still lists it as unlanded, so the re-read ends.
const script = vi.hoisted(() => ({ okWithoutLanding: false, calls: 0 }));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    confirmFrom: async (...args: Parameters<typeof real.confirmFrom>) => {
      script.calls += 1;
      // A timer turn, so a verdict that kept judging could not starve the test's own timers.
      await new Promise(resolve => setTimeout(resolve, 1));
      return script.okWithoutLanding ? 'ok' : real.confirmFrom(...args);
    },
  };
});

import { saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { storeGuild, tick } from '../helpers/gateRig';

describe('verdictOf over a confirm that answers ok', () => {
  it('judges each write once, and is ok', async () => {
    const { store, options } = await storeGuild();
    store.holding = true;
    const ledger = openLedger('panel');
    runInLedger(ledger, 'mod', () => saveData('x.json', options, { v: 1 }));
    script.okWithoutLanding = true;
    try {
      const settled = await Promise.race([verdictOf([ledger]), tick(500).then(() => 'still judging' as const)]);
      expect(settled).toEqual({ ok: true });
      expect(script.calls).toBe(1);
    } finally {
      script.okWithoutLanding = false;
      store.holding = false;
      store.release();
    }
  });
});
