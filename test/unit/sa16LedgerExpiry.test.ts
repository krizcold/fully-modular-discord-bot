import { afterEach, describe, expect, it, vi } from 'vitest';

import { WriteLedger, writesOf } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';

afterEach(() => vi.restoreAllMocks());

describe('sa16 a ledger whose life ran out before anything read it', () => {
  it('sa16 reports no refused write once its life passed, though it recorded one while open', () => {
    let now = 1_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const ledger = new WriteLedger('interaction', 1000);
    ledger.noteRefusal('io', 'mod', 'guild:g1/mod/a.json');
    now += 500;
    expect(writesOf(ledger)).toEqual({ tickets: [], refused: true, unknowable: false, landedBefore: false });
    const later = new WriteLedger('interaction', 1000);
    later.noteRefusal('io', 'mod', 'guild:g1/mod/a.json');
    now += 1000;
    expect(later.refusedDocs()).toEqual([]);
    expect(writesOf(later)).toEqual({ tickets: [], refused: false, unknowable: false, landedBefore: false });
  });
});
