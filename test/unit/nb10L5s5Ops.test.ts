import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 survivors, chunk 5 (sharedOps.ts): the answers of an unknown or missing op, the arguments a Dummy op passes on,
// the list of registered ops, which ledger is marked as a payment op's, the provider sentence on a refusal, and the
// partial-answer texts (which part of a text partialEndingIn finds, which names a partial answer lists, which
// "Please ..." request it drops).

const ctl = vi.hoisted(() => ({
  lock: { kind: 'not-held' } as any,
  pm: null as any,
  providers: {} as Record<string, any>,
}));
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => ({
  ...(await orig<any>()),
  checkWriterLock: () => ctl.lock,
}));
vi.mock('../../src/bot/internalSetup/utils/premiumManager', async orig => ({
  ...(await orig<any>()),
  getPremiumManager: () => ctl.pm,
}));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => ({
  ...(await orig<any>()),
  getPaymentRegistry: () => ({ get: (id: string) => ctl.providers[id], on: () => undefined, off: () => undefined, listAll: () => [] }),
}));

import {
  applySharedOp, DUMMY_METHODS, isRegisteredOp, partialEnding, partialEndingIn, partialText, PREMIUM_METHODS, PROVIDER_SENTENCE,
  registeredOps, setOpSettler,
} from '../../src/bot/internalSetup/utils/sharedOps';
import { currentLedger, openLedger, paymentOpOf } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';

let dummyCalls: Array<{ method: string; args: unknown[] }> = [];
let marks: Array<string | undefined> = [];

function fakeDummy(): Record<string, (...a: unknown[]) => unknown> {
  const dummy: Record<string, (...a: unknown[]) => unknown> = { cannotReadText: () => null };
  for (const method of DUMMY_METHODS) dummy[method] = (...args: unknown[]) => { dummyCalls.push({ method, args }); return true; };
  return dummy;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  dummyCalls = [];
  marks = [];
  ctl.lock = { kind: 'not-held' };
  ctl.pm = {
    unreadableText: () => null,
    heldEventsText: () => null,
    setTier: () => { marks.push(paymentOpOf(currentLedger())); return 'set'; },
  };
  ctl.providers = {
    dummy: fakeDummy(),
    fake: { id: 'fake', handleWebhook: async () => { marks.push(paymentOpOf(currentLedger())); } },
  };
  setOpSettler(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an op the bot does not know', () => {
  it('is refused as invalid and names the op', async () => {
    const reply: any = await applySharedOp({ op: 'nope.thing' });
    expect(reply).toEqual({ ok: false, code: 'invalid', error: 'unknown op nope.thing' });
  });

  it('with no op name says "(none)"', async () => {
    expect(await applySharedOp({} as any)).toEqual({ ok: false, code: 'invalid', error: 'unknown op (none)' });
    expect(await applySharedOp({ op: '' })).toEqual({ ok: false, code: 'invalid', error: 'unknown op (none)' });
  });

  it('with an op that is not a string says "(none)", not the value', async () => {
    expect(await applySharedOp({ op: 5 } as any)).toEqual({ ok: false, code: 'invalid', error: 'unknown op (none)' });
    expect(await applySharedOp({ op: { a: 1 } } as any)).toEqual({ ok: false, code: 'invalid', error: 'unknown op (none)' });
  });

  it('with no request at all is answered, not thrown', async () => {
    await expect(applySharedOp(undefined as any)).resolves.toEqual({ ok: false, code: 'invalid', error: 'unknown op (none)' });
    await expect(applySharedOp(null as any)).resolves.toEqual({ ok: false, code: 'invalid', error: 'unknown op (none)' });
  });
});

describe('a Dummy op', () => {
  it('with no args calls the provider with no arguments and answers ok', async () => {
    const reply: any = await applySharedOp({ op: 'dummy.adminDeleteCoupon' });
    expect(reply).toEqual({ ok: true, result: true });
    expect(dummyCalls).toEqual([{ method: 'adminDeleteCoupon', args: [] }]);
  });

  it('whose args are not a list calls the provider with no arguments', async () => {
    const reply: any = await applySharedOp({ op: 'dummy.adminDeleteVariant', args: { args: 'C1' } });
    expect(reply).toEqual({ ok: true, result: true });
    expect(dummyCalls).toEqual([{ method: 'adminDeleteVariant', args: [] }]);
  });

  it('passes the listed args on as they are', async () => {
    await applySharedOp({ op: 'dummy.adminDeleteCoupon', args: { args: ['C1'] } });
    expect(dummyCalls).toEqual([{ method: 'adminDeleteCoupon', args: ['C1'] }]);
  });
});

describe('registeredOps', () => {
  it('lists every op the executor applies', () => {
    const ops = registeredOps();
    const expected = [
      'global.write', 'payment.webhook', 'payment.oauthCallback',
      ...PREMIUM_METHODS.map(m => `premium.${m}`), ...DUMMY_METHODS.map(m => `dummy.${m}`), 'provider.saveCredentials',
    ];
    expect([...ops].sort()).toEqual([...new Set(expected)].sort());
    for (const op of ops) expect(isRegisteredOp(op)).toBe(true);
  });
});

describe('the payment-op mark on the op ledger', () => {
  it('a premium op runs in a ledger not marked as a payment op', async () => {
    const reply: any = await applySharedOp({ op: 'premium.setTier', args: { args: ['gold', {}] } });
    expect(reply).toEqual({ ok: true, result: 'set' });
    expect(marks).toEqual([undefined]);
  });

  it('a payment webhook runs in a ledger marked with its op', async () => {
    const reply: any = await applySharedOp({ op: 'payment.webhook', args: { providerId: 'fake', body: '' } });
    expect(reply).toEqual({ ok: true, result: { received: true } });
    expect(marks).toEqual(['payment.webhook']);
  });
});

describe('a refusal of a provider op', () => {
  it('that is not unconfirmed carries no provider sentence', async () => {
    const premium: any = await applySharedOp({ op: 'premium.grantManual', args: { args: ['g'] } });
    expect(premium).toEqual({ ok: false, code: 'invalid', error: 'unknown premium op grantManual' });
    const payment: any = await applySharedOp({ op: 'payment.webhook', args: { providerId: 'missing' } });
    expect(payment).toEqual({ ok: false, code: 'invalid', error: 'Unknown provider or no webhook handler: missing' });
    expect(payment.error).not.toContain(PROVIDER_SENTENCE);
  });
});

describe('partialEndingIn', () => {
  it('finds an ending that starts the text', () => {
    const saved = partialEnding(['a.json']);
    expect(partialEndingIn(saved)).toBe(saved);
    const unknown = partialEnding([]);
    expect(partialEndingIn(unknown)).toBe(unknown);
  });

  it('starts at the earlier of the two endings when the text holds both', () => {
    const text = `Head. ${partialEnding([])} What was saved: b.json. ${PROVIDER_SENTENCE}`;
    expect(partialEndingIn(text)).toBe(`${partialEnding([])} What was saved: b.json. ${PROVIDER_SENTENCE}`);
    const other = `Head. What was saved: b.json. ${partialEnding([])}`;
    expect(partialEndingIn(other)).toBe(`What was saved: b.json. ${partialEnding([])}`);
  });
});

describe('partialText', () => {
  it('names only the files that landed, never a guild working-set write', () => {
    const ledger = openLedger('console');
    ledger.noteTicket({ kind: 'ws', manager: {}, set: { landedSeq: 5 }, guildId: 'g1', seq: 3 } as any, 'm');
    expect(partialText('Head.', ledger)).toBe(`Head. ${partialEnding([])}`);
    ledger.noteTicket({ kind: 'file', record: { landed: 2 }, seq: 1, path: '/d/global/x/landed.json' } as any, 'm');
    expect(partialText('Head.', ledger)).toBe(`Head. ${partialEnding(['landed.json'])}`);
  });

  it('drops only a "Please ..." request that ends the text', () => {
    const ledger = openLedger('console');
    expect(partialText('Saved some. Please try again.', ledger)).toBe(`Saved some. ${partialEnding([])}`);
    expect(partialText('Saved some. Please wait. Then look.', ledger)).toBe(`Saved some. Please wait. Then look. ${partialEnding([])}`);
  });
});
