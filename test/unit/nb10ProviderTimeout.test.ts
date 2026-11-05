import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 28: every fetch of the built-in payment providers carries a 30 s abort signal, so a provider that never
// answers fails the op, and the local chain then releases the writer lock.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => ({
  ...(await orig<any>()),
  getPaymentRegistry: () => ({ on: () => undefined, off: () => undefined, get: () => undefined, list: () => [], startTickers: () => undefined, emitEvent: () => undefined }),
}));

import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { PROVIDER_FETCH_MS } from '../../src/bot/internalSetup/utils/payment/paymentTypes';
import { StripeProvider } from '../../src/bot/internalSetup/utils/payment/stripeProvider';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { freshWriterLock, quiet } from '../helpers/nb10Rig';
import { readSourceText } from '../helpers/sourceText';

const PAYMENT_DIR = path.resolve(__dirname, '../../src/bot/internalSetup/utils/payment');

/** Every global fetch call in the provider sources, with its argument text up to the matching parenthesis. */
function fetchCalls(): Array<{ file: string; call: string }> {
  const calls: Array<{ file: string; call: string }> = [];
  for (const file of fs.readdirSync(PAYMENT_DIR).filter(f => f.endsWith('Provider.ts'))) {
    const text = readSourceText(PAYMENT_DIR, file);
    const re = /(?<![.\w])fetch\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      let depth = 0;
      let end = m.index + 'fetch'.length;
      for (; end < text.length; end++) {
        if (text[end] === '(') depth++;
        else if (text[end] === ')' && --depth === 0) break;
      }
      calls.push({ file, call: text.slice(m.index, end + 1) });
    }
  }
  return calls;
}

beforeEach(() => {
  quiet();
  freshWriterLock('webui');
  setSharedWriteGate(() => inLocalOp());
});

afterEach(() => {
  setSharedWriteGate(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the provider fetch sites', () => {
  it('are 8, and each carries AbortSignal.timeout(PROVIDER_FETCH_MS), which is 30 s', () => {
    const calls = fetchCalls();
    expect(calls).toHaveLength(8);
    for (const { file, call } of calls) expect(call, file).toContain('signal: AbortSignal.timeout(PROVIDER_FETCH_MS)');
    expect(PROVIDER_FETCH_MS).toBe(30_000);
  });
});

describe('a provider that never answers', () => {
  it('fails after its 30 s signal; the local op answers failed and the chain releases the lock', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_nb10');
    const timeouts: number[] = [];
    const controllers: AbortController[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeouts.push(ms);
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    });
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })));
    })));
    const manager = new BotManager();
    const reply = manager.runLocalOp('premium.cancelPaidSubscriptionImmediately', async () => {
      await new StripeProvider().cancelSubscription('sub_nb10', true);
      return { ok: true };
    });
    for (let i = 0; i < 100 && controllers.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(timeouts).toEqual([30_000]);
    expect(fs.existsSync(writerLockPath())).toBe(true);
    // The 30 s elapse.
    controllers[0].abort();
    expect(await reply).toMatchObject({ ok: false, code: 'failed', error: expect.stringContaining('aborted') });
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });
});
