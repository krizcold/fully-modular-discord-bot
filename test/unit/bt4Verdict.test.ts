import { afterEach, describe, expect, it, vi } from 'vitest';

import { confirmWrite, saveData, saveDataOutcome } from '../../src/bot/internalSetup/utils/dataManager';
import { freezeGuildWrites, unfreezeGuildWrites } from '../helpers/freezeGuild';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { CONFIRM_MS, verdictOf, writesConfirmed } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { notReadyGuild, storeGuild, tick } from '../helpers/gateRig';

// BT-4's verdict (notes/BT.md, "BT-4 design sheet: final", Decision 1): judge over the ledgers, read again after each
// ok judgement, so writes recorded while it waits are judged in the same CONFIRM_MS budget.

afterEach(() => {
  vi.useRealTimers();
});

const inLedger = <T>(ledger: ReturnType<typeof openLedger>, fn: () => T) => runInLedger(ledger, 'mod', fn);

describe('verdictOf', () => {
  it('is ok over no write, and over writes that land', async () => {
    const { guildId, store, options } = await storeGuild();
    const ledger = openLedger('panel');
    expect(await verdictOf([ledger])).toEqual({ ok: true });
    inLedger(ledger, () => saveData('x.json', options, { v: 1 }));
    expect(await verdictOf([ledger])).toEqual({ ok: true });
    expect(store.doc(guildId, 'x.json')).toBeDefined();
  });

  it('a refused document later rewritten whole answers unavailable', async () => {
    const { guildId, options } = await storeGuild();
    const ledger = openLedger('panel');
    inLedger(ledger, () => {
      freezeGuildWrites(guildId);
      saveDataOutcome('x.json', options, { v: 1 });
      unfreezeGuildWrites(guildId);
      saveDataOutcome('x.json', options, { v: 2 });
    });
    expect(await verdictOf([ledger])).toEqual({ ok: false, answer: 'unavailable', partial: true });
  });

  it('a refusal recorded while it waits makes it not ok', async () => {
    const { store, options } = await storeGuild();
    store.holding = true;
    const ledger = openLedger('panel');
    inLedger(ledger, () => saveData('x.json', options, { v: 1 }));
    const verdict = verdictOf([ledger]);
    await tick(20);
    inLedger(ledger, () => saveDataOutcome('y.json', notReadyGuild(), { v: 1 }));
    store.release();
    expect(await verdict).toEqual({ ok: false, answer: 'not-ready', partial: true });
  });

  it('an accepted write recorded while it waits is confirmed before it is ok', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    const ledger = openLedger('panel');
    inLedger(ledger, () => saveData('x.json', options, { v: 1 }));
    const verdict = verdictOf([ledger]);
    await tick(20);
    inLedger(ledger, () => saveData('y.json', options, { v: 2 }));
    store.holding = false;
    store.release();
    expect(await verdict).toEqual({ ok: true });
    expect(store.doc(guildId, 'y.json')).toBeDefined();
  });

  it('an interaction no gate holds is judged by it, so writesConfirmed sees a refusal recorded while it waits', async () => {
    const { store, options } = await storeGuild();
    store.holding = true;
    const ledger = openLedger('console');
    const answered = inLedger(ledger, () => {
      saveData('x.json', options, { v: 1 });
      return writesConfirmed({});
    });
    await tick(20);
    inLedger(ledger, () => saveDataOutcome('y.json', notReadyGuild(), { v: 1 }));
    store.release();
    expect(await answered).toBe(false);
  });

  it('a write recorded while it waits gets only the time left in the same budget', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { store, options } = await storeGuild();
    store.holding = true;
    const ledger = openLedger('panel');
    inLedger(ledger, () => saveData('x.json', options, { v: 1 }));
    // A flush already on the wire: confirm polls it in 20 ms steps, reading the faked clock.
    void confirmWrite(ledger.tickets()[0].ticket, 60_000);
    await tick(5);
    const verdict = verdictOf([ledger]);
    await tick(30);
    vi.advanceTimersByTime(CONFIRM_MS - 100);
    inLedger(ledger, () => saveData('y.json', options, { v: 2 }));
    store.release();
    await tick(50);
    vi.advanceTimersByTime(200);
    // The second write's confirm had 100 ms left, not a fresh 8 s: it answers pending well inside a second.
    const settled = await Promise.race([verdict, tick(1500).then(() => 'still waiting' as const)]);
    expect(settled).toEqual({ ok: false, answer: 'pending', partial: true });
    store.holding = false;
    store.release();
  });
});
