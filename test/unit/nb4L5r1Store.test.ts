import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaimStore, ClaimFailure, ClaimTimeoutError } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';

// NB4 decision 5: a renewal that gets no answer in time fails once with the bound's error; the destroyed connection
// rejecting its query afterwards settles nothing a second time.

const T = claimTimings(30);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function hangingPool() {
  const released: Array<boolean | undefined> = [];
  const pool = {
    async connect() {
      const pending: Array<(e: Error) => void> = [];
      return {
        query: () => new Promise((_, reject) => { pending.push(reject); }),
        release(destroy?: boolean) {
          released.push(destroy);
          if (destroy === true) for (const reject of pending.splice(0)) reject(new Error('Connection terminated'));
        },
      };
    },
    async end() { /* nothing to close */ },
    on() { return pool; },
  };
  return { pool, released };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};

describe('a renewal that times out', () => {
  it('fails once with the bound error and the late connection error settles nothing again', async () => {
    const { pool, released } = hangingPool();
    const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T);
    void (store as any).pool.end().catch(() => undefined);
    (store as any).pool = pool;
    const seen: string[] = [];
    const listener = (type: string) => { seen.push(type); };
    process.on('multipleResolves', listener);
    vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const renewal = store.renew({
        me: { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' }, pairs: [], ttlMs: 30_000,
        heartbeat: { capacity: 1, takeoverSeconds: 30, fit: true, restartable: true, returns: true, startedAt: 0 },
      }).catch(e => e);
      await vi.advanceTimersByTimeAsync(T.renewMs + 1);
      const error = await renewal;
      await flush();
      expect(error).toBeInstanceOf(ClaimFailure);
      expect(error.cause).toBeInstanceOf(ClaimTimeoutError);
      expect(released[0]).toBe(true);
      expect(seen).toEqual([]);
    } finally {
      process.off('multipleResolves', listener);
    }
  });
});
