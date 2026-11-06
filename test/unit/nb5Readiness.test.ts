import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeClock, LEASED, readinessRig, stopDrivers } from '../helpers/readinessRig';

// NB5 J2 row (6) and K2 row (7): the catalog timer starts no read while a catalog read is on the wire.

afterEach(() => {
  stopDrivers();
  vi.useRealTimers();
});

describe('the catalog timer and the reads on the wire', () => {
  it('(6) sends no tick read while the lease change\'s read never settles', async () => {
    fakeClock();
    const { store, driver } = readinessRig(null);
    const spy = vi.fn(() => new Promise<string[]>(() => undefined));
    store.listOwnedGuilds = spy as unknown as typeof store.listOwnedGuilds;
    driver.onLeaseChanged(LEASED);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('(7) counts every catalog read, so the first one ending does not let the timer start another', async () => {
    fakeClock();
    const { store, driver } = readinessRig(null);
    const held: Array<{ resolve: (v: string[]) => void; reject: (e: Error) => void }> = [];
    const spy = vi.fn(() => {
      if (spy.mock.calls.length <= 2) return Promise.resolve<string[]>([]);
      return new Promise<string[]>((resolve, reject) => { held.push({ resolve, reject }); });
    });
    store.listOwnedGuilds = spy as unknown as typeof store.listOwnedGuilds;
    driver.onLeaseChanged(LEASED);
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).toHaveBeenCalledTimes(3);
    driver.onLeaseChanged(LEASED);
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(4);
    held[0].resolve([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).toHaveBeenCalledTimes(4);
    held[1].reject(new Error('read ETIMEDOUT'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).toHaveBeenCalledTimes(5);
  });
});
