import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => ({
  ...(await orig<any>()),
  getPaymentRegistry: () => ({ on: () => undefined, off: () => undefined, get: () => undefined, list: () => [], startTickers: () => undefined }),
}));

import { dataPath } from '../../src/utils/dataRoot';
import { saveHeldWrites } from '../../src/bot/internalSetup/utils/dataManager';
import { cancelQueued, enqueueWrite } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';

// Maintenance's save in file mode (no working set) gives up on a disk that refuses every flush once nothing has landed
// for the give-up window (3 s), and not one pass later.

afterEach(() => {
  vi.restoreAllMocks();
});

describe('saveHeldWrites on a disk that refuses every flush', () => {
  it('stops after the pass that reaches exactly the give-up window, with the write still held', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = dataPath('global', 'nb10l5s3drain');
    const file = path.join(dir, 'held.json');
    const clock = { off: 0, armed: false, calls: 0 };
    const realMkdir = fs.promises.mkdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (p: fs.PathLike, opts?: any) => {
      if (String(p) !== dir) return realMkdir(p, opts);
      if (clock.armed) {
        clock.calls++;
        if (clock.calls === 1) clock.off = 3000;
        else if (clock.calls > 3) clock.off += 100;
      }
      throw Object.assign(new Error(`EIO: injected, mkdir '${dir}'`), { code: 'EIO' });
    }) as typeof fs.promises.mkdir);
    try {
      enqueueWrite(file, '{"held":true}');
      await new Promise(r => setTimeout(r, 30));
      const t0 = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => t0 + clock.off);
      clock.armed = true;
      const left = await saveHeldWrites(3200);
      expect(left.unsavedFiles).toBe(1);
      expect(clock.calls).toBe(3);
    } finally {
      clock.armed = false;
      await cancelQueued([file]);
    }
    expect(fs.existsSync(file)).toBe(false);
  });
});
