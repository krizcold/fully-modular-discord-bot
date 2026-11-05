import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ take: null as null | Record<string, unknown> }));

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => ({
  ...(await orig<any>()),
  getPaymentRegistry: () => ({ on: () => undefined, off: () => undefined, get: () => undefined, list: () => [], startTickers: () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => {
  const real = await orig<any>();
  return { ...real, takeWriterLock: () => h.take ?? real.takeWriterLock() };
});

import { importBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';

// The import's refusal when it cannot take the data files' writer lock names why and what to do.

afterEach(() => {
  h.take = null;
});

async function refusal(take: Record<string, unknown>): Promise<string> {
  h.take = take;
  try {
    await importBundle('no-such-bundle.ndjson');
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('the import was not refused');
}

describe('an import that cannot take the writer lock', () => {
  it('says another process is taking the data files when the holder is not named yet', async () => {
    expect(await refusal({ kind: 'held', holder: null }))
      .toBe('[DataInterchange] another process is taking the data files at this moment; run the import once it has stopped');
  });

  it('says another process is taking over the data files when the take is contended', async () => {
    expect(await refusal({ kind: 'contended' }))
      .toBe('[DataInterchange] another process is taking over the data files at this moment; run the import again in a moment');
  });

  it('names the lock file and the errno when the disk does not take writes', async () => {
    expect(await refusal({ kind: 'unwritable', errno: 'EROFS', error: new Error('EROFS') }))
      .toBe(`[DataInterchange] the data disk does not take writes (${writerLockPath()}: EROFS); nothing was imported`);
  });
});
