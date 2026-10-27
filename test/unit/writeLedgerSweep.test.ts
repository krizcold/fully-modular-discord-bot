import { describe, expect, it, vi } from 'vitest';

import { saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { INTERACTION_LEDGER_LIFE_MS, openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';

// Its own file: the process-wide sweep is armed by the first interaction ledger a process opens, and this test fakes
// the clock and the interval before that happens.
describe('the process-wide sweep of interaction ledgers', () => {
  it('seals an expired interaction ledger with no further interaction and no read, and stops once none is open', () => {
    // Outside every ledger and before the fake clock: the first facade call's own setup (config, metrics).
    saveData('warmup.json', { scope: 'global', category: 'bt2' }, {});
    vi.useFakeTimers({ toFake: ['performance', 'setInterval', 'clearInterval'] });
    try {
      const ledger = openLedger('interaction');
      runInLedger(ledger, 'modA', () => saveData('a.json', { scope: 'global', category: 'bt2' }, { v: 1 }));
      const inside = ledger as unknown as { closed: boolean; entries: Map<object, unknown> };
      expect(inside.entries.size).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(INTERACTION_LEDGER_LIFE_MS + 60 * 1000);
      expect(inside.closed).toBe(true);
      expect(inside.entries.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // After the test above, no interaction ledger is open and the sweep is stopped.
  it('drains every expired ledger behind the head, each within its life plus one 60 s period', () => {
    vi.useFakeTimers({ toFake: ['performance', 'setInterval', 'clearInterval'] });
    try {
      const closed = (ledger: unknown) => (ledger as { closed: boolean }).closed;
      const first = openLedger('interaction'); // arms the sweep at t = 0
      vi.advanceTimersByTime(90 * 1000);
      const second = openLedger('interaction');
      const third = openLedger('interaction');
      // Both expire at t = 990 s; the sweep's tick at 1020 s seals them, within the life plus one period.
      vi.advanceTimersByTime(INTERACTION_LEDGER_LIFE_MS + 30 * 1000);
      expect([closed(first), closed(second), closed(third)]).toEqual([true, true, true]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // After the test above, no interaction ledger is open, so this one's ledger is the queue's head.
  it('seals an expired interaction ledger nobody reads again at the next interaction\'s open', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const ledger = openLedger('interaction');
      runInLedger(ledger, 'modA', () => saveData('b.json', { scope: 'global', category: 'bt2' }, { v: 1 }));
      const inside = ledger as unknown as { closed: boolean; entries: Map<object, unknown> };
      expect(inside.entries.size).toBe(1);
      vi.advanceTimersByTime(INTERACTION_LEDGER_LIFE_MS);
      expect(inside.closed).toBe(false);
      openLedger('interaction');
      expect(inside.closed).toBe(true);
      expect(inside.entries.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
