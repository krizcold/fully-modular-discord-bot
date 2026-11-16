import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIME_SCALE, WAIT_MS } from '../helpers/time.mjs';

const trueAfter = (ms: number) => {
  const at = Date.now() + ms;
  return () => Date.now() >= at;
};

const rejectsAfter = async (wait: Promise<unknown>) => {
  const start = Date.now();
  await expect(wait).rejects.toThrow();
  return Date.now() - start;
};

describe('the default bound of vi.waitFor and vi.waitUntil (helpers/setup.ts)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('vi.waitFor with no timeout keeps waiting past 1 s', async () => {
    const ready = trueAfter(1_500);
    await expect(vi.waitFor(() => { expect(ready()).toBe(true); return 'ready'; })).resolves.toBe('ready');
  });

  it('vi.waitUntil with no timeout keeps waiting past 1 s', async () => {
    const ready = trueAfter(1_500);
    await expect(vi.waitUntil(ready, { interval: 20 })).resolves.toBe(true);
  });

  it('a timeout the call names is kept, as a number and as an option', async () => {
    const never = () => expect(false).toBe(true);
    const options = [200, { timeout: 200 }, { timeout: 200, interval: 20 }];
    const elapsed = await Promise.all(options.flatMap(o => [rejectsAfter(vi.waitFor(never, o)), rejectsAfter(vi.waitUntil(() => false, o))]));
    for (const ms of elapsed) {
      expect(ms).toBeGreaterThanOrEqual(150);
      expect(ms).toBeLessThan(Math.min(WAIT_MS, 1_000 * TIME_SCALE) - 100);
    }
  });

  it('the default bound is 5 s times TIME_SCALE', async () => {
    expect(WAIT_MS).toBe(5_000 * TIME_SCALE);
    vi.stubEnv('SMDB_TEST_TIME_SCALE', '4');
    vi.resetModules();
    const scaled = await import('../helpers/time.mjs');
    expect(scaled.TIME_SCALE).toBe(4);
    expect(scaled.WAIT_MS).toBe(20_000);
  });
});
