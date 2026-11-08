import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 mutation survivors of dummyProvider.ts (decision 12): what the Dummy state's cache answers, logs and writes
// when state.json is absent, cannot be parsed, changes under it, or the provider stops between an op's check and its save.

import { DummyProvider, invalidateDummyCaches } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { forgetSharedFileKnowledge } from '../../src/bot/internalSetup/utils/dataManager';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { clearGlobal, DUMMY_STATE, rawOf, settleQueue } from './nb10PremiumRig';

const FILE = 'payment-providers/dummy/state.json';
const DOC = 'global:payment-providers/dummy/state.json';
const SEED_VARIANTS = ['dummy_monthly_999', 'dummy_yearly_9999', 'dummy_lifetime_19999', 'dummy_weekly_249'];
const SEED_PRODUCTS = ['dummy_product_standard'];
const SEED_COUPONS = ['TEST20', 'FREEWEEK', 'EXPIRED'];
const CAUSE = 'invalid JSON: not a JSON object';
const UNREADABLE_LOG = `[DummyProvider] ${FILE} cannot be read (${CAUSE}); the Dummy provider answers from its seed and its changes are refused until it can be read`;
const AGAIN_LOG = `[DummyProvider] ${FILE} can be read again`;

const role = process.env.BOT_PROCESS_ROLE;
const made: DummyProvider[] = [];
let spies: { log: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> };

const lines = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map(c => c.map(String).join(' '));
const variant = (id: string) => ({ variantId: id, label: id, amount: 1, currency: 'USD', durationDays: 1, recurring: false, active: true });

function provider(): DummyProvider {
  const p = new DummyProvider();
  made.push(p);
  return p;
}

function writeState(text: string): void {
  fs.mkdirSync(path.dirname(DUMMY_STATE), { recursive: true });
  fs.writeFileSync(DUMMY_STATE, text);
}

const variantIds = (p: DummyProvider) => p.adminListVariants().map(v => v.variantId).sort();

beforeEach(async () => {
  spies = {
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  };
  delete process.env.BOT_PROCESS_ROLE;
  await settleQueue();
  clearGlobal();
});

afterEach(async () => {
  for (const p of made.splice(0)) p.dispose();
  await settleQueue();
  delete process.env.BOT_PROCESS_ROLE;
  vi.restoreAllMocks();
});

afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('a state.json that parses to no JSON object is unreadable', () => {
  it('a number: the seed answers, the refusal text names the cause, and the cause is logged once', () => {
    writeState('5');
    const dummy = provider();
    expect(dummy.cannotReadText()).toBe(`${FILE} cannot be read (${CAUSE}); nothing was saved. Fix or restore the file, then try again.`);
    expect(variantIds(dummy)).toEqual([...SEED_VARIANTS].sort());
    dummy.invalidate();
    expect(dummy.cannotReadText()).not.toBeNull();
    expect(lines(spies.error).filter(l => l.includes('cannot be read'))).toEqual([UNREADABLE_LOG]);
  });

  it('null is unreadable as well', () => {
    writeState('null');
    expect(provider().cannotReadText()).toBe(`${FILE} cannot be read (${CAUSE}); nothing was saved. Fix or restore the file, then try again.`);
  });

  it('an array is unreadable as well', () => {
    writeState('[]');
    expect(provider().cannotReadText()).toBe(`${FILE} cannot be read (${CAUSE}); nothing was saved. Fix or restore the file, then try again.`);
  });

  it('a change is refused: the delete answers false, the ledger records io for state.json, and the file keeps its bytes', async () => {
    writeState('5');
    const dummy = provider();
    expect(dummy.adminDeleteVariant('dummy_monthly_999')).toBe(false);
    const ledger = openLedger('panel');
    runInLedger(ledger, 'mod', () => dummy.adminSetVariant(variant('z')));
    expect(ledger.refusedDocs().map(r => [r.cause, r.doc])).toEqual([['io', DOC]]);
    expect(variantIds(dummy)).toEqual([...SEED_VARIANTS].sort());
    await settleQueue();
    expect(rawOf(DUMMY_STATE)).toBe('5');
  });

  it('a provider call is refused with the cause in its text', async () => {
    writeState('5');
    await expect(provider().cancelSubscription('dummy_1')).rejects.toThrow(
      `The Dummy provider changed nothing: ${FILE} cannot be read (${CAUSE}).`);
  });
});

describe('a stopped provider refuses provider calls', () => {
  it('deposed and stopping each name their cause', async () => {
    const deposed = provider();
    deposed.markStopped('deposed');
    await expect(deposed.cancelSubscription('dummy_1')).rejects.toThrow('The Dummy provider changed nothing: another process took the data files.');
    const stopping = provider();
    stopping.markStopped('stopping');
    await expect(stopping.pauseSubscription('dummy_1', null)).rejects.toThrow('The Dummy provider changed nothing: the bot is stopping.');
  });
});

describe('the sections of a readable state.json', () => {
  it('a section that is no object answers the seed section', () => {
    writeState(JSON.stringify({ variants: 5, products: 5, coupons: 5 }));
    const dummy = provider();
    expect(dummy.cannotReadText()).toBeNull();
    expect(variantIds(dummy)).toEqual([...SEED_VARIANTS].sort());
    expect(dummy.adminListProducts().map(p => p.productId)).toEqual(SEED_PRODUCTS);
    expect(dummy.adminListCoupons().map(c => c.code).sort()).toEqual([...SEED_COUPONS].sort());
  });

  it('an object section answers what the file holds', () => {
    writeState(JSON.stringify({
      variants: { z: variant('z') },
      products: { p: { productId: 'p', label: 'P', variantIds: ['z'] } },
      coupons: { C1: { code: 'C1', percentOff: 5, usedCount: 0, createdAt: '2026-01-01T00:00:00.000Z' } },
    }));
    const dummy = provider();
    expect(variantIds(dummy)).toEqual(['z']);
    expect(dummy.adminListProducts().map(p => p.productId)).toEqual(['p']);
    expect(dummy.adminListCoupons().map(c => c.code)).toEqual(['C1']);
  });
});

describe('the logs of a load', () => {
  it('a first load of a good file logs nothing about reading again', () => {
    writeState('{}');
    expect(provider().cannotReadText()).toBeNull();
    expect(lines(spies.log).filter(l => l.includes('can be read again'))).toEqual([]);
  });

  it('a fixed file loads at once after invalidate, and logs that it can be read again', () => {
    writeState('5');
    const dummy = provider();
    expect(dummy.cannotReadText()).not.toBeNull();
    writeState(JSON.stringify({ variants: { z: variant('z') } }));
    dummy.invalidate();
    expect(dummy.cannotReadText()).toBeNull();
    expect(variantIds(dummy)).toEqual(['z']);
    expect(lines(spies.log).filter(l => l.includes('can be read again'))).toEqual([AGAIN_LOG]);
  });
});

describe('an unreadable state.json is tried again after 5 s', () => {
  it('a fix is not seen 4999 ms after the failed load and is seen at 5000 ms', () => {
    const now = vi.spyOn(Date, 'now');
    const T = 1_900_000_000_000;
    now.mockReturnValue(T);
    writeState('5');
    const dummy = provider();
    expect(dummy.cannotReadText()).not.toBeNull();
    writeState('{}');
    now.mockReturnValue(T + 4999);
    expect(dummy.cannotReadText()).not.toBeNull();
    now.mockReturnValue(T + 5000);
    expect(dummy.cannotReadText()).toBeNull();
  });
});

describe('the web UI reloads only a changed file', () => {
  it('an unchanged file answers the same cached objects; a changed one is loaded', () => {
    writeState(JSON.stringify({ products: { p: { productId: 'p', label: 'P', variantIds: [] } } }));
    const dummy = provider();
    const first = dummy.adminListProducts()[0];
    expect(dummy.adminListProducts()[0]).toBe(first);
    writeState(JSON.stringify({ products: { q: { productId: 'q', label: 'Q', variantIds: [] } } }));
    expect(dummy.adminListProducts().map(p => p.productId)).toEqual(['q']);
  });
});

describe('the bot keeps its cache until the writer lock is taken', () => {
  beforeEach(() => {
    process.env.BOT_PROCESS_ROLE = 'bot';
  });

  it('a file changed by another writer is not loaded; invalidateDummyCaches loads it', () => {
    const dummy = provider();
    expect(variantIds(dummy)).toEqual([...SEED_VARIANTS].sort());
    writeState(JSON.stringify({ variants: { z: variant('z') } }));
    expect(variantIds(dummy)).toEqual([...SEED_VARIANTS].sort());
    invalidateDummyCaches();
    expect(variantIds(dummy)).toEqual(['z']);
  });

  it('a take of the writer lock (forgetSharedFileKnowledge) loads it', () => {
    const dummy = provider();
    expect(variantIds(dummy)).toEqual([...SEED_VARIANTS].sort());
    writeState(JSON.stringify({ variants: { z: variant('z') } }));
    forgetSharedFileKnowledge();
    expect(variantIds(dummy)).toEqual(['z']);
  });
});

describe('a save that meets a stop or an unreadable file between the check and the save writes nothing', () => {
  const purchase = (dummy: DummyProvider) => dummy.initiatePurchase({
    guildId: '900000000000000001', tierId: 'low', offeringId: 'o1', variantId: 'dummy_monthly_999', couponCode: 'TEST20',
  });

  it('stopped while the coupon is checked: state.json stays absent', async () => {
    const dummy = provider();
    const answer = purchase(dummy);
    dummy.markStopped('stopping');
    // NB6 decision 71 (sheet 3145): the save refused at the accept throws T20 with the accept's cause words.
    await expect(answer).rejects.toThrow('The Dummy provider did not save this change (node-stopping), so nothing was changed at the provider.');
    await settleQueue();
    expect(rawOf(DUMMY_STATE)).toBeNull();
  });

  it('unreadable while the coupon is checked: state.json keeps its bytes', async () => {
    const dummy = provider();
    const answer = purchase(dummy);
    writeState('5');
    dummy.invalidate();
    expect(dummy.cannotReadText()).not.toBeNull();
    // NB6 decision 71 (sheet 3145): the save refused at the accept throws T20 with the accept's cause words.
    await expect(answer).rejects.toThrow('The Dummy provider did not save this change (io), so nothing was changed at the provider.');
    await settleQueue();
    expect(rawOf(DUMMY_STATE)).toBe('5');
  });
});

describe('the final stop step', () => {
  it('with nothing changed it writes nothing and logs no held change', async () => {
    const dummy = provider();
    expect(variantIds(dummy)).toEqual([...SEED_VARIANTS].sort());
    dummy.finalStop();
    await settleQueue();
    expect(rawOf(DUMMY_STATE)).toBeNull();
    expect(lines(spies.error).filter(l => l.includes('holds changes'))).toEqual([]);
  });

  it('after a change that saved it logs no held change', async () => {
    const dummy = provider();
    dummy.adminSetVariant(variant('z'));
    await settleQueue();
    expect(Object.keys(JSON.parse(rawOf(DUMMY_STATE)!).variants)).toContain('z');
    dummy.finalStop();
    expect(lines(spies.error).filter(l => l.includes('holds changes'))).toEqual([]);
  });
});
