import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { writeRawAtomic } from '../../src/bot/internalSetup/utils/dataManager';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';

// Its own file: fileBackend's raw write is replaced by one that refuses.
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>()),
  writeRawAtomic: () => false,
}));

describe('a raw write that fileBackend refuses', () => {
  it('answers false as before, and is recorded as io', () => {
    const ledger = openLedger('panel');
    const target = path.join(process.env.DATA_DIR!, '_bt2_raw_false', 'r.json');
    expect(runInLedger(ledger, 'modA', () => writeRawAtomic(target, '{}'))).toBe(false);
    expect(ledger.refusals()).toEqual([{ cause: 'io', modules: ['modA'] }]);
    expect(ledger.tickets()).toEqual([]);
  });
});
