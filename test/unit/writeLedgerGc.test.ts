import v8 from 'v8';
import vm from 'vm';
import { describe, expect, it, vi } from 'vitest';

import { saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { INTERACTION_LEDGER_LIFE_MS, openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';

// Its own file: one fake clock from the process's first interaction ledger on, so the sweep's queue order holds.
describe('the sweep keeps no interaction ledger alive itself', () => {
  it('lets a ledger nothing else references be collected before its life ends, and drops it from the queue', async () => {
    // Outside every ledger and before the fake clock: the first facade call's own setup (config, metrics).
    saveData('warmup.json', { scope: 'global', category: 'bt2' }, {});
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      v8.setFlagsFromString('--expose-gc');
      const gc = vm.runInNewContext('gc') as () => void;
      const make = () => {
        const ledger = openLedger('interaction', {});
        runInLedger(ledger, 'modA', () => saveData('c.json', { scope: 'global', category: 'bt2' }, { v: 1 }));
        return new WeakRef(ledger);
      };
      const ref = make();
      // The save's own flush runs in the ledger's frame and holds it until its I/O ends.
      for (let i = 0; i < 50 && ref.deref(); i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        gc();
      }
      expect(ref.deref()).toBeUndefined();
      // The collected ledger, the queue's head, gives way: the next ledger is sealed at its own life.
      vi.advanceTimersByTime(INTERACTION_LEDGER_LIFE_MS);
      const next = openLedger('interaction');
      vi.advanceTimersByTime(INTERACTION_LEDGER_LIFE_MS);
      openLedger('interaction');
      expect((next as unknown as { closed: boolean }).closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
