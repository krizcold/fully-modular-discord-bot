import { afterEach, describe, expect, it, vi } from 'vitest';

import { tokenFor } from '../helpers/fakeStore';
import { fakeClock, LEASED, NOT_LEASED, readinessRig, stopDrivers, watch } from '../helpers/readinessRig';

// A01's touched-line mutation survivors: each row tells one mutant apart (A01 design sheet).

afterEach(() => {
  stopDrivers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Rig = ReturnType<typeof readinessRig>;
const tick = () => new Promise<void>(resolve => { setImmediate(resolve); });

/** A ready set whose flush was answered deposed. */
async function fenced(r: Rig): Promise<string> {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const g = await r.ready();
  expect(r.ws.save(g, 'm', 'a.json', '{"v":1}')).toBe('accepted');
  r.store.mode = 'deposed';
  await r.ws.flushGuildNow(g, 2000);
  expect(r.ws.stateOf(g)).toBe('fenced');
  return g;
}

describe('the interaction gate', () => {
  it('admits a ready guild', async () => {
    const r = readinessRig();
    const g = await r.ready();
    expect(await r.driver.admitInteraction(g)).toBe(true);
  });

  it('admits a fenced guild without waiting on it', async () => {
    const r = readinessRig();
    const g = await fenced(r);
    expect(await r.driver.admitInteraction(g)).toBe(true);
  });

  it('claims a leased guild with no set and admits it once read', async () => {
    const r = readinessRig();
    const g = r.guild();
    expect(await r.driver.admitInteraction(g)).toBe(true);
    expect(r.ws.stateOf(g)).toBe('ready');
  });

  it('refuses a guild still hydrating once its wait from now ends', async () => {
    fakeClock();
    const r = readinessRig();
    await vi.advanceTimersByTimeAsync(10_000);
    const g = r.hydrating();
    const admitted = watch(r.driver.admitInteraction(g));
    await vi.advanceTimersByTimeAsync(3000);
    expect(admitted.settled()).toBe(true);
    expect(admitted.value()).toBe(false);
  });
});

describe('the event gate', () => {
  it('holds an event for a set hydrating past a minute and replays it on ready', async () => {
    fakeClock();
    const r = readinessRig();
    const g = r.hydrating();
    const seen: number[] = [];
    expect(r.driver.admitEvent(g, () => { seen.push(1); })).toBe(false);
    await vi.advanceTimersByTimeAsync(100_000);
    r.store.releaseHydrations();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([1]);
  });

  it('replays a held event on ready with no drop warning', async () => {
    fakeClock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = readinessRig();
    const g = r.hydrating();
    expect(r.driver.admitEvent(g, () => undefined)).toBe(false);
    r.store.releaseHydrations();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Dropping'));
  });

  it('logs a held event whose replay throws', async () => {
    fakeClock();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = readinessRig();
    const g = r.hydrating();
    const boom = new Error('boom');
    expect(r.driver.admitEvent(g, () => { throw boom; })).toBe(false);
    r.store.releaseHydrations();
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledWith(`[Data] Buffered event replay failed for guild ${g}:`, boom);
  });

  it('replays an event woken ready even when an earlier waiter evicted the set first', async () => {
    fakeClock();
    const r = readinessRig();
    const g = r.hydrating();
    void r.ws.awaitReady(g, 60_000).then(() => r.ws.evict(g));
    const seen: number[] = [];
    expect(r.driver.admitEvent(g, () => { seen.push(1); })).toBe(false);
    r.store.releaseHydrations();
    r.store.hydrateMode = 'held';
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([1]);
  });
});

describe('the retry loop', () => {
  it('a grant joining an attempt on the wire claims at once and then waits the first backoff', async () => {
    fakeClock();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'held';
    expect(r.driver.causeOf(g, 0)).toBe('loading');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.hydrationsSent).toBe(1);
    r.store.listOwnedGuilds = async () => [g];
    r.driver.onLeaseLost();
    r.driver.onLeaseChanged(LEASED);
    await vi.advanceTimersByTimeAsync(0);
    r.store.releaseHydrations('unavailable');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.hydrationsSent).toBe(2);
    await vi.advanceTimersByTimeAsync(600);
    expect(r.store.hydrationsSent).toBe(3);
  });

  it('a loop replaced during its backoff claims no more', async () => {
    fakeClock();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'unavailable';
    expect(r.driver.causeOf(g, 0)).toBe('loading');
    await vi.advanceTimersByTimeAsync(200);
    expect(r.store.hydrationsSent).toBe(1);
    r.ws.evict(g);
    expect(r.driver.admitEvent(g, () => undefined)).toBe(false);
    await vi.advanceTimersByTimeAsync(1100);
    // The new loop's claims at 200 and 700 ms; its next waits till 1700.
    expect(r.store.hydrationsSent).toBe(3);
  });

  it('a grant after a replaced loop ended joins the loop in its place', async () => {
    fakeClock();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'unavailable';
    expect(r.driver.causeOf(g, 0)).toBe('loading');
    await vi.advanceTimersByTimeAsync(200);
    r.ws.evict(g);
    expect(r.driver.admitEvent(g, () => undefined)).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(r.store.hydrationsSent).toBe(2);
    r.store.listOwnedGuilds = async () => [g];
    r.driver.onLeaseLost();
    r.driver.onLeaseChanged(LEASED);
    await vi.advanceTimersByTimeAsync(450);
    // Woken at 300 ms, the one loop claims then and next at 800.
    expect(r.store.hydrationsSent).toBe(3);
  });

  it('a set kept since its lease left is read again when the lease comes back', async () => {
    fakeClock();
    const r = readinessRig();
    const g = r.guild();
    r.store.listOwnedGuilds = async () => [g];
    expect(r.driver.causeOf(g, 0)).toBe('loading');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ws.stateOf(g)).toBe('ready');
    r.driver.onLeaseChanged(NOT_LEASED);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ws.stateOf(g)).toBe('frozen-retained');
    r.driver.onLeaseChanged(LEASED);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ws.stateOf(g)).toBe('ready');
  });

  it('a stopped driver claims no more', async () => {
    fakeClock();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'unavailable';
    expect(r.driver.causeOf(g, 0)).toBe('loading');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.hydrationsSent).toBe(1);
    r.driver.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r.store.hydrationsSent).toBe(1);
  });

  it('a loop replaced while its read was on the wire does not decline on its deposed answer', async () => {
    fakeClock();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'held';
    expect(r.driver.causeOf(g, 0)).toBe('loading');
    await vi.advanceTimersByTimeAsync(0);
    r.ws.evict(g);
    expect(r.driver.causeOf(g, 0)).toBe('loading');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.hydrationsSent).toBe(2);
    r.store.releaseFirstHydration('deposed');
    await vi.advanceTimersByTimeAsync(0);
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('lost to a newer owner'));
    r.store.releaseHydrations();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ws.stateOf(g)).toBe('ready');
  });

  it('an event moved onto the set in its place is not dropped when the evicted set\'s claim is declined', async () => {
    fakeClock();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'held';
    const seen: number[] = [];
    expect(r.driver.admitEvent(g, () => { seen.push(1); })).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    r.ws.evict(g);
    const second = r.ws.hydrate(g, tokenFor());
    await vi.advanceTimersByTimeAsync(0);
    r.store.releaseFirstHydration('deposed');
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
    r.store.releaseHydrations();
    expect(await second).toBe('ready');
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([1]);
  });
});

describe('the working set hydration', () => {
  it.each([
    ['a newer epoch', (t: ReturnType<typeof tokenFor>) => ({ ...t, epoch: t.epoch + 1000 })],
    ['a newer term', (t: ReturnType<typeof tokenFor>) => ({ ...t, term: t.term + 1 })],
  ])('a second hydrate under %s joining the first leaves its grant on the set', async (_name, next) => {
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'held';
    const token = tokenFor();
    const newer = next(token);
    const first = r.ws.hydrate(g, token);
    const second = r.ws.hydrate(g, newer);
    await tick();
    r.store.releaseHydrations();
    expect(await first).toBe('ready');
    expect(await second).toBe('ready');
    expect(r.ws.save(g, 'm', 'a.json', '{"v":1}')).toBe('accepted');
    expect(await r.ws.flushGuildNow(g, 2000)).toBe('ok');
    const sent = r.store.commits[r.store.commits.length - 1].token;
    expect([sent.term, sent.epoch]).toEqual([newer.term, newer.epoch]);
  });

  it('a third hydrate joins the set in place, not the evicted one\'s ended read', async () => {
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'held';
    const first = r.ws.hydrate(g, tokenFor());
    r.ws.evict(g);
    const token = tokenFor();
    const second = r.ws.hydrate(g, token);
    await tick();
    r.store.releaseFirstHydration();
    expect(await first).toBe('unavailable');
    const third = r.ws.hydrate(g, token);
    await tick();
    expect(r.store.hydrationsSent).toBe(2);
    r.store.releaseHydrations();
    expect(await second).toBe('ready');
    expect(await third).toBe('ready');
  });

  it('a reclaim the store did not answer leaves the kept set frozen', async () => {
    const r = readinessRig();
    const g = await r.ready();
    await r.ws.unloadToFrozenRetained(g);
    r.store.reclaim = null;
    expect(await r.ws.hydrate(g, tokenFor())).toBe('unavailable');
    expect(r.ws.stateOf(g)).toBe('frozen-retained');
  });

  it('a store-failed read of a set evicted with none in its place answers evicted', async () => {
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'held';
    const first = r.ws.hydrate(g, tokenFor());
    r.ws.evict(g);
    await tick();
    r.store.releaseHydrations('unavailable');
    expect(await first).toBe('evicted');
  });
});

describe('awaitReady', () => {
  it('answers ready at once for a ready set', async () => {
    const r = readinessRig();
    const g = await r.ready();
    expect(await r.ws.awaitReady(g, 60_000)).toBe('ready');
  });

  it('answers ready at once for a kept set', async () => {
    const r = readinessRig();
    const g = await r.ready();
    await r.ws.unloadToFrozenRetained(g);
    expect(await r.ws.awaitReady(g, 60_000)).toBe('ready');
  });

  it('answers not ready at once for a fenced set', async () => {
    const r = readinessRig();
    const g = await fenced(r);
    const waited = watch(r.ws.awaitReady(g, 60_000));
    await tick();
    expect(waited.value()).toBe('not-ready');
  });

  it('answers not ready when its wait ends with the set hydrating', async () => {
    fakeClock();
    const r = readinessRig();
    const g = r.hydrating();
    const waited = watch(r.ws.awaitReady(g, 100));
    await vi.advanceTimersByTimeAsync(150);
    expect(waited.value()).toBe('not-ready');
  });

  it('leaves no timer behind once woken', async () => {
    fakeClock();
    const r = readinessRig();
    const g = r.hydrating();
    await vi.advanceTimersByTimeAsync(0);
    const before = vi.getTimerCount();
    const waited = r.ws.awaitReady(g, 60_000);
    expect(vi.getTimerCount()).toBe(before + 1);
    r.store.releaseHydrations();
    expect(await waited).toBe('ready');
    expect(vi.getTimerCount()).toBe(before);
  });

  it('a waiter whose wait ends while parked leaves the others parked for the next set', async () => {
    fakeClock();
    const r = readinessRig();
    const g = r.hydrating();
    const seen: number[] = [];
    expect(r.driver.admitEvent(g, () => { seen.push(1); })).toBe(false);
    const short = watch(r.ws.awaitReady(g, 100));
    r.ws.evict(g);
    await vi.advanceTimersByTimeAsync(150);
    expect(short.value()).toBe('not-ready');
    const second = r.ws.hydrate(g, tokenFor());
    r.store.releaseHydrations();
    expect(await second).toBe('ready');
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([1]);
  });
});
