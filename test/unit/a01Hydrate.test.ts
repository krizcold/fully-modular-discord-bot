import { afterEach, describe, expect, it, vi } from 'vitest';

import { setBackendKind } from '../helpers/backendKind';
import { tokenFor } from '../helpers/fakeStore';
import { fakeClock, LEASED, NOT_LEASED, readinessRig, stopDrivers, watch } from '../helpers/readinessRig';

// R29-J1: one hydrate per guild in flight, and a flush trims only the buffer it sent (A01 design sheet).

afterEach(() => {
  stopDrivers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Rig = ReturnType<typeof readinessRig>;
const tick = () => new Promise<void>(resolve => { setImmediate(resolve); });
const row = (g: string) => `${g}|m/a.json`;
const value = (r: Rig, g: string) => {
  const read = r.ws.read(g, 'm', 'a.json');
  return read.status === 'ready' ? read.value : 'not-ready';
};

/** What lands on the set between the first hydration's end and the second's. */
const between = {
  'a save': {
    act: (r: Rig, g: string) => expect(r.ws.save(g, 'm', 'a.json', '{"v":2}')).toBe('accepted'),
    read: { v: 2 },
    stored: '{"v":2}',
  },
  'a delete': {
    act: (r: Rig, g: string) => expect(r.ws.delete(g, 'm', 'a.json')).toBe('accepted'),
    read: undefined,
    stored: undefined,
  },
};

async function overlapped(grant: 'the same grant' | 'a newer grant') {
  const r = readinessRig();
  const g = r.guild();
  r.store.docs.set(row(g), '{"v":1}');
  r.store.hydrateMode = 'held';
  const token = tokenFor();
  const first = r.ws.hydrate(g, token);
  const second = r.ws.hydrate(g, grant === 'the same grant' ? token : tokenFor());
  await tick();
  r.store.releaseFirstHydration();
  expect(await first).toBe('ready');
  return { r, g, second };
}

describe('a second hydrate of a guild while the first is in flight', () => {
  it.each(['the same grant', 'a newer grant'] as const)('under %s sends one hydration and both answer ready', async grant => {
    const { r, second } = await overlapped(grant);
    r.store.releaseHydrations();
    expect(await second).toBe('ready');
    expect(r.store.hydrationsSent).toBe(1);
  });

  it.each(Object.keys(between).flatMap(made => (['the same grant', 'a newer grant'] as const).map(grant => [made, grant])) as [keyof typeof between, 'the same grant' | 'a newer grant'][])(
    'never reverts %s made after the first ended, under %s, and the store gets it',
    async (made, grant) => {
      const { r, g, second } = await overlapped(grant);
      between[made].act(r, g);
      const ticket = r.ws.ticketFor(g);
      r.store.releaseHydrations();
      expect(await second).toBe('ready');
      expect(value(r, g)).toEqual(between[made].read);
      expect(await r.ws.confirm(ticket, 2000)).toBe('ok');
      expect(r.store.docs.get(row(g))).toBe(between[made].stored);
    });

  it('joins a reclaim of a kept set on the wire instead of answering unavailable', async () => {
    const r = readinessRig();
    const g = await r.ready();
    await r.ws.unloadToFrozenRetained(g);
    expect(r.ws.stateOf(g)).toBe('frozen-retained');
    let answer: (kept: 'kept') => void = () => undefined;
    r.store.reclaimGuild = () => new Promise(resolve => { answer = resolve; });
    const token = tokenFor();
    const first = r.ws.hydrate(g, token);
    const second = r.ws.hydrate(g, token);
    await tick();
    answer('kept');
    expect(await first).toBe('ready');
    expect(await second).toBe('ready');
    expect(r.ws.stateOf(g)).toBe('ready');
  });
});

describe('a hydration whose set was evicted while it waited', () => {
  it('answers deposed without deleting the set hydrating in its place', async () => {
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'held';
    const token = tokenFor();
    const first = r.ws.hydrate(g, token);
    r.ws.evict(g);
    const second = r.ws.hydrate(g, token);
    await tick();
    expect(r.store.hydrationsSent).toBe(2);
    r.store.releaseFirstHydration('deposed');
    expect(await first).toBe('deposed');
    expect(r.ws.stateOf(g)).toBe('hydrating');
    r.store.releaseHydrations();
    expect(await second).toBe('ready');
    expect(r.ws.stateOf(g)).toBe('ready');
  });

  it('answers unavailable, applies its rows to nothing, and the set in its place still hydrates', async () => {
    const r = readinessRig();
    const g = r.guild();
    r.store.docs.set(row(g), '{"v":1}');
    r.store.hydrateMode = 'held';
    const token = tokenFor();
    const first = r.ws.hydrate(g, token);
    r.ws.evict(g);
    const second = r.ws.hydrate(g, token);
    await tick();
    r.store.releaseFirstHydration();
    expect(await first).toBe('unavailable');
    expect(r.ws.stateOf(g)).toBe('hydrating');
    r.store.releaseHydrations();
    expect(await second).toBe('ready');
    expect(value(r, g)).toEqual({ v: 1 });
  });

  it('answers evicted when no set took its place, and applies its rows to nothing', async () => {
    const r = readinessRig();
    const g = r.guild();
    r.store.docs.set(row(g), '{"v":1}');
    r.store.hydrateMode = 'held';
    const first = r.ws.hydrate(g, tokenFor());
    r.ws.evict(g);
    await tick();
    r.store.releaseHydrations();
    expect(await first).toBe('evicted');
    expect(r.ws.stateOf(g)).toBeNull();
  });
});

describe('a kept set evicted while its reclaim is on the wire', () => {
  it('the reclaim answers unavailable and leaves the set hydrating in its place to its own hydration', async () => {
    const r = readinessRig();
    const g = await r.ready();
    await r.ws.unloadToFrozenRetained(g);
    let answer: (kept: 'kept') => void = () => undefined;
    r.store.reclaimGuild = () => new Promise(resolve => { answer = resolve; });
    const token = tokenFor();
    const first = r.ws.hydrate(g, token);
    r.ws.evict(g);
    r.store.hydrateMode = 'held';
    const sent = r.store.hydrationsSent;
    const second = r.ws.hydrate(g, token);
    await tick();
    answer('kept');
    await tick();
    expect(r.store.hydrationsSent - sent).toBe(1);
    expect(await first).toBe('unavailable');
    r.store.releaseFirstHydration();
    expect(await second).toBe('ready');
    expect(r.ws.save(g, 'm', 'a.json', '{"v":2}')).toBe('accepted');
    r.store.releaseHydrations('deposed');
    await tick();
    expect(r.ws.stateOf(g)).toBe('ready');
  });

  it('with none in its place, the reclaim answers evicted and claims nothing more', async () => {
    const r = readinessRig();
    const g = await r.ready();
    await r.ws.unloadToFrozenRetained(g);
    let answer: (kept: 'kept') => void = () => undefined;
    r.store.reclaimGuild = () => new Promise(resolve => { answer = resolve; });
    const sent = r.store.hydrationsSent;
    const first = r.ws.hydrate(g, tokenFor());
    r.ws.evict(g);
    answer('kept');
    expect(await first).toBe('evicted');
    expect(r.store.hydrationsSent - sent).toBe(0);
    expect(r.ws.stateOf(g)).toBeNull();
  });

  it('with none in its place, a reclaim the store did not answer answers evicted too', async () => {
    const r = readinessRig();
    const g = await r.ready();
    await r.ws.unloadToFrozenRetained(g);
    let answer: (kept: null) => void = () => undefined;
    r.store.reclaimGuild = () => new Promise(resolve => { answer = resolve; });
    const sent = r.store.hydrationsSent;
    const first = r.ws.hydrate(g, tokenFor());
    r.ws.evict(g);
    answer(null);
    expect(await first).toBe('evicted');
    expect(r.store.hydrationsSent - sent).toBe(0);
    expect(r.ws.stateOf(g)).toBeNull();
  });
});

describe('the readiness driver runs one retry loop per guild', () => {
  it('a fresh grant joins the on-demand loop, wakes it, and adds no second loop', async () => {
    fakeClock();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'unavailable';
    expect(r.driver.causeOf(g, 0)).toBe('loading');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.hydrationsSent).toBe(1);
    r.store.listOwnedGuilds = async () => [g];
    r.driver.onLeaseChanged(NOT_LEASED);
    r.driver.onLeaseChanged(LEASED);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.hydrationsSent).toBe(2);
    // Woken, it waits the first backoff again (500 ms at this random), as a fresh loop would; one loop sends one claim.
    await vi.advanceTimersByTimeAsync(600);
    expect(r.store.hydrationsSent).toBe(3);
    r.store.hydrateMode = 'ok';
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.ws.stateOf(g)).toBe('ready');
    expect(r.store.hydrationsSent).toBe(4);
  });

  it.each(['unavailable', 'deposed', 'ok'] as const)(
    'a fresh grant joining while an attempt is on the wire: one answering %s is followed at once by a claim under it',
    async answer => {
      fakeClock();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const r = readinessRig();
      const g = r.guild();
      r.store.hydrateMode = 'unavailable';
      expect(r.driver.causeOf(g, 0)).toBe('loading');
      // Six attempts, 0 to 5; the sixth waits the capped backoff (15 s at this random).
      await vi.advanceTimersByTimeAsync(15_500);
      expect(r.store.hydrationsSent).toBe(6);
      r.store.hydrateMode = 'held';
      await vi.advanceTimersByTimeAsync(15_000);
      expect(r.store.hydrationsSent).toBe(7);
      r.store.listOwnedGuilds = async () => [g];
      r.driver.onLeaseChanged(NOT_LEASED);
      r.driver.onLeaseChanged({ ...LEASED, claim: 2 });
      await vi.advanceTimersByTimeAsync(0);
      r.store.releaseHydrations(answer);
      r.store.hydrateMode = 'ok';
      await vi.advanceTimersByTimeAsync(0);
      expect(r.ws.stateOf(g)).toBe('ready');
      expect(r.store.hydrationsSent).toBe(answer === 'ok' ? 7 : 8);
    });

  it('a hydration whose set was evicted with none in its place ends the loop, and no claim follows', async () => {
    fakeClock();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'held';
    expect(r.driver.causeOf(g, 0)).toBe('loading');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.hydrationsSent).toBe(1);
    r.ws.evict(g);
    r.store.releaseHydrations();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r.store.hydrationsSent).toBe(1);
    expect(r.ws.stateOf(g)).toBeNull();
  });

  it.each(['ok', 'unavailable'] as const)(
    'an event and an interaction waiting on a set evicted while its read answering %s was on the wire, with none in its place, go back through the gate and are served the stored data',
    async answer => {
      fakeClock();
      const r = readinessRig();
      const g = r.guild();
      r.store.docs.set(row(g), '{"v":1}');
      r.store.hydrateMode = 'held';
      const seen: unknown[] = [];
      expect(r.driver.admitEvent(g, () => { seen.push(value(r, g)); })).toBe(false);
      const admitted = watch(r.driver.admitInteraction(g));
      await vi.advanceTimersByTimeAsync(0);
      r.ws.evict(g);
      r.store.releaseFirstHydration(answer);
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual([]);
      expect(admitted.settled()).toBe(false);
      expect(r.ws.stateOf(g)).toBe('hydrating');
      expect(r.store.hydrationsSent).toBe(2);
      r.store.releaseFirstHydration();
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual([{ v: 1 }]);
      expect(admitted.value()).toBe(true);
      expect(r.ws.readDocRaw(g, 'm', 'a.json')).toBe('{"v":1}');
    });

  it('with the guild no longer leased here, the held event is dropped with the warning and the interaction is refused', async () => {
    fakeClock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'held';
    const seen: unknown[] = [];
    expect(r.driver.admitEvent(g, () => { seen.push(value(r, g)); })).toBe(false);
    const admitted = r.driver.admitInteraction(g);
    await vi.advanceTimersByTimeAsync(0);
    r.driver.onLeaseChanged(NOT_LEASED);
    r.ws.evict(g);
    r.store.releaseHydrations();
    await vi.advanceTimersByTimeAsync(0);
    expect(await admitted).toBe(false);
    expect(seen).toEqual([]);
    expect(r.store.hydrationsSent).toBe(1);
    expect(warn).toHaveBeenCalledWith(`[Data] Dropping 1 buffered event(s) for guild ${g} (working set never became ready)`);
  });

  it('with the guild moved to the file route, the held event dispatches and the interaction is admitted', async () => {
    fakeClock();
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'held';
    const seen: number[] = [];
    expect(r.driver.admitEvent(g, () => { seen.push(1); })).toBe(false);
    const admitted = r.driver.admitInteraction(g);
    await vi.advanceTimersByTimeAsync(0);
    setBackendKind('file');
    r.ws.evict(g);
    r.store.releaseHydrations();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([1]);
    expect(await admitted).toBe(true);
    expect(r.store.hydrationsSent).toBe(1);
    expect(r.ws.stateOf(g)).toBeNull();
  });

  it('an event for a set evicted during the backoff after an unavailable answer is held for the set read again, not dropped', async () => {
    fakeClock();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = readinessRig();
    const g = r.guild();
    r.store.docs.set(row(g), '{"v":1}');
    r.store.hydrateMode = 'unavailable';
    expect(r.driver.causeOf(g, 0)).toBe('loading');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.hydrationsSent).toBe(1);
    r.ws.evict(g);
    r.store.hydrateMode = 'held';
    const seen: unknown[] = [];
    expect(r.driver.admitEvent(g, () => { seen.push(value(r, g)); })).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.hydrationsSent).toBe(2);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('buffered event'));
    r.store.releaseHydrations();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen).toEqual([{ v: 1 }]);
    expect(r.store.hydrationsSent).toBe(2);
  });

  it('a store-failed read of a set evicted while it was on the wire ends the loop, and nothing claims the guild again', async () => {
    fakeClock();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'held';
    expect(r.driver.causeOf(g, 0)).toBe('loading');
    await vi.advanceTimersByTimeAsync(0);
    r.ws.evict(g);
    r.store.releaseHydrations('unavailable');
    r.store.hydrateMode = 'ok';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r.store.hydrationsSent).toBe(1);
    expect(r.ws.stateOf(g)).toBeNull();
  });

  it('events buffered on a set evicted while it read wait for the set in its place, and replay in order when it is ready', async () => {
    fakeClock();
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'held';
    const replayed: number[] = [];
    expect(r.driver.admitEvent(g, () => { replayed.push(1); })).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    r.ws.evict(g);
    const second = r.ws.hydrate(g, tokenFor());
    await vi.advanceTimersByTimeAsync(0);
    r.store.releaseFirstHydration();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ws.stateOf(g)).toBe('hydrating');
    expect(r.driver.admitEvent(g, () => { replayed.push(2); })).toBe(false);
    expect(replayed).toEqual([]);
    r.store.releaseHydrations();
    expect(await second).toBe('ready');
    await vi.advanceTimersByTimeAsync(0);
    expect(replayed).toEqual([1, 2]);
  });

  it('events buffered on a set evicted during the backoff wait on the set read again, with a new event, and replay in order', async () => {
    fakeClock();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'unavailable';
    const seen: number[] = [];
    expect(r.driver.admitEvent(g, () => { seen.push(1); })).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    r.ws.evict(g);
    r.store.hydrateMode = 'held';
    expect(r.driver.admitEvent(g, () => { seen.push(2); })).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ws.stateOf(g)).toBe('hydrating');
    r.store.releaseHydrations('ok');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ws.stateOf(g)).toBe('ready');
    expect(seen).toEqual([1, 2]);
  });

  it('those waiting on a set evicted while it read are let through when the set in its place goes ready first, in order', async () => {
    fakeClock();
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'held';
    const seen: number[] = [];
    expect(r.driver.admitEvent(g, () => { seen.push(1); })).toBe(false);
    const admitted = watch(r.driver.admitInteraction(g));
    await vi.advanceTimersByTimeAsync(0);
    r.ws.evict(g);
    r.store.hydrateMode = 'ok';
    expect(r.driver.admitEvent(g, () => { seen.push(2); })).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ws.stateOf(g)).toBe('ready');
    expect(admitted.value()).toBe(true);
    if (r.driver.admitEvent(g, () => { seen.push(3); })) seen.push(3);
    r.store.releaseFirstHydration('ok');
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('with a deposed read declined, the held event is dropped with the warning and the interaction refused at once, and a later event is held for the set read again', async () => {
    fakeClock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = readinessRig();
    const g = r.guild();
    r.store.docs.set(row(g), '{"v":1}');
    r.store.hydrateMode = 'held';
    const seen: number[] = [];
    expect(r.driver.admitEvent(g, () => { seen.push(1); })).toBe(false);
    const admitted = watch(r.driver.admitInteraction(g));
    await vi.advanceTimersByTimeAsync(0);
    r.store.releaseHydrations('deposed');
    r.store.hydrateMode = 'held';
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ws.stateOf(g)).toBeNull();
    expect(admitted.value()).toBe(false);
    expect(warn).toHaveBeenCalledWith(`[Data] Dropping 1 buffered event(s) for guild ${g} (working set never became ready)`);
    // The lease is unchanged, which stands in for a re-grant.
    expect(r.driver.admitEvent(g, () => { seen.push(2); })).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ws.stateOf(g)).toBe('hydrating');
    r.store.releaseHydrations('ok');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ws.stateOf(g)).toBe('ready');
    expect(seen).toEqual([2]);
  });

  it('with a fresh grant joined while a read answering deposed was on the wire, the held event waits on the set read again and replays', async () => {
    fakeClock();
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'held';
    const seen: number[] = [];
    expect(r.driver.admitEvent(g, () => { seen.push(1); })).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    r.store.listOwnedGuilds = async () => [g];
    r.driver.onLeaseChanged(NOT_LEASED);
    r.driver.onLeaseChanged({ ...LEASED, claim: 2 });
    await vi.advanceTimersByTimeAsync(0);
    r.store.releaseHydrations('deposed');
    r.store.hydrateMode = 'ok';
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ws.stateOf(g)).toBe('ready');
    expect(r.store.hydrationsSent).toBe(2);
    expect(seen).toEqual([1]);
  });

  it('those re-gated onto the set read again after a deposed read with none in its place are dropped or refused when that claim is declined', async () => {
    fakeClock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = readinessRig();
    const g = r.guild();
    r.store.hydrateMode = 'held';
    const seen: number[] = [];
    expect(r.driver.admitEvent(g, () => { seen.push(1); })).toBe(false);
    const admitted = watch(r.driver.admitInteraction(g));
    await vi.advanceTimersByTimeAsync(0);
    r.ws.evict(g);
    r.store.releaseHydrations('deposed');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.hydrationsSent).toBe(2);
    expect(r.ws.stateOf(g)).toBeNull();
    expect(admitted.value()).toBe(false);
    expect(seen).toEqual([]);
    expect(warn).toHaveBeenCalledWith(`[Data] Dropping 1 buffered event(s) for guild ${g} (working set never became ready)`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r.store.hydrationsSent).toBe(2);
  });
});

describe('a flush trims only the buffer it sent', () => {
  it('lines appended while a flush is on the wire are stored by the next one, and the backlog empties', async () => {
    const r = readinessRig();
    const g = await r.ready();
    r.store.holding = true;
    expect(r.ws.append(g, 'm', 's.log', 'l1\n')).toBe('accepted');
    const flushing = r.ws.flushGuildNow(g, 2000);
    await tick();
    expect(r.ws.append(g, 'm', 's.log', 'l2\n')).toBe('accepted');
    r.store.holding = false;
    r.store.release();
    expect(await flushing).toBe('ok');
    expect(await r.ws.flushGuildNow(g, 2000)).toBe('ok');
    expect(r.store.streams.get(`${g}|m/s.log`)).toBe('l1\nl2\n');
    expect(r.ws.getBackendHealth().dirtyBytes).toBe(0);
  });

  it('a buffer replaced by a delete and new lines during the flight keeps the new lines', async () => {
    const r = readinessRig();
    const g = await r.ready();
    r.store.holding = true;
    expect(r.ws.append(g, 'm', 's.log', 'l1\n')).toBe('accepted');
    const flushing = r.ws.flushGuildNow(g, 2000);
    await tick();
    expect(r.ws.delete(g, 'm', 's.log')).toBe('accepted');
    expect(r.ws.append(g, 'm', 's.log', 'l3\n')).toBe('accepted');
    r.store.holding = false;
    r.store.release();
    expect(await flushing).toBe('ok');
    expect(await r.ws.flushGuildNow(g, 2000)).toBe('ok');
    expect(r.store.streams.get(`${g}|m/s.log`)).toBe('l3\n');
    expect(r.ws.getBackendHealth().dirtyBytes).toBe(0);
  });
});
