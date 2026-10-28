import { afterEach, describe, expect, it, vi } from 'vitest';

import { admitGuildAction, gateCauseNow, gateCauseText } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { setBackendKind } from '../helpers/backendKind';
import { saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { freezeGuildWrites, unfreezeGuildWrites } from '../helpers/freezeGuild';
import { tick } from '../helpers/gateRig';
import { fakeClock, LEASED, NOT_LEASED, readinessRig, stopDrivers, watch } from '../helpers/readinessRig';

// R1-J2's readings and hold (notes/BT.md, "R1-J2 design sheet (L0): final, after the re-read"): each row of its state
// table read through the gate, then the hold's bound, its last reading at the deadline, and what changes mid-wait.

afterEach(() => {
  stopDrivers();
  vi.useRealTimers();
});

const now = () => performance.now();

describe('a reading', () => {
  it('with no readiness driver (file mode), every guild admits', () => {
    expect(gateCauseNow('424242', now())).toBe('admit');
  });

  it('a ready set admits', async () => {
    const r = readinessRig();
    expect(gateCauseNow(await r.ready(), now())).toBe('admit');
  });

  it('a file-routed guild with no set admits under a driver: the driver reads postgres routes only', () => {
    const r = readinessRig();
    const guildId = r.guild();
    setBackendKind('file');
    expect(gateCauseNow(guildId, now())).toBe('admit');
    expect(r.store.hydrationsSent).toBe(0);
  });

  it('a fenced set reads moved', async () => {
    const r = readinessRig();
    const guildId = await r.ready();
    r.store.mode = 'deposed';
    saveData('x.json', { guildId, category: 'm' }, { v: 1 });
    await r.ws.flushGuildNow(guildId, 1000);
    expect(r.ws.stateOf(guildId)).toBe('fenced');
    expect(gateCauseNow(guildId, now())).toBe('moved');
  });

  it('frozen-retained reads loading under a lease, and not-served once its shard leaves', async () => {
    const r = readinessRig();
    const drained = await r.ready();
    freezeGuildWrites(drained);
    expect(gateCauseNow(drained, now())).toBe('loading');
    const lost = await r.ready();
    r.driver.onLeaseChanged(NOT_LEASED);
    await tick(10);
    expect(r.ws.stateOf(lost)).toBe('frozen-retained');
    expect(gateCauseNow(lost, now())).toBe('not-served');
  });

  it('frozen-retained reads not-served under a lease without its shard', async () => {
    const removed = readinessRig();
    const guildId = await removed.ready();
    removed.driver.onLeaseChanged(NOT_LEASED);
    await tick(10);
    expect(removed.ws.stateOf(guildId)).toBe('frozen-retained');
    expect(gateCauseNow(guildId, now())).toBe('not-served');
  });

  it('a hydrating set reads loading, and not-served once its lease leaves', () => {
    const r = readinessRig();
    const loading = r.hydrating();
    expect(gateCauseNow(loading, now())).toBe('loading');
    r.driver.onLeaseChanged(NOT_LEASED);
    expect(gateCauseNow(loading, now())).toBe('not-served');
  });

  it('a hydration that comes back unavailable after its lease left still reads not-served', async () => {
    const r = readinessRig();
    const guildId = r.hydrating();
    r.driver.onLeaseChanged(NOT_LEASED);
    r.store.releaseHydrations('unavailable');
    await tick(10);
    expect(r.ws.stateOf(guildId)).toBe('hydrating');
    expect(gateCauseNow(guildId, now())).toBe('not-served');
  });

  it('no set reads not-served with no lease known, and with the shard leased elsewhere', () => {
    const fresh = readinessRig(null);
    expect(gateCauseNow(fresh.guild(), now())).toBe('not-served');
    const elsewhere = readinessRig(NOT_LEASED);
    expect(gateCauseNow(elsewhere.guild(), now())).toBe('not-served');
  });

  it('no set under a lease reads loading and kicks one claim, not one per reading', () => {
    const r = readinessRig();
    r.store.hydrateMode = 'held';
    const guildId = r.guild();
    const since = now();
    expect(gateCauseNow(guildId, since)).toBe('loading');
    expect(gateCauseNow(guildId, since)).toBe('loading');
    expect(r.store.hydrationsSent).toBe(1);
  });

  it('a claim deposed since the hold began reads moved; a later hold claims again, and a claim that succeeds admits', async () => {
    const r = readinessRig();
    r.store.hydrateMode = 'deposed';
    const guildId = r.guild();
    const first = now();
    expect(gateCauseNow(guildId, first)).toBe('loading');
    await tick(10);
    expect(gateCauseNow(guildId, first)).toBe('moved');
    await tick(5);
    const second = now();
    expect(gateCauseNow(guildId, second)).toBe('loading');
    expect(r.store.hydrationsSent).toBe(2);
    await tick(10);
    expect(gateCauseNow(guildId, second)).toBe('moved');
    r.store.hydrateMode = 'ok';
    await tick(5);
    const third = now();
    expect(gateCauseNow(guildId, third)).toBe('loading');
    await tick(10);
    expect(gateCauseNow(guildId, third)).toBe('admit');
  });

  it('each reading follows the driver and manager installed now', async () => {
    const old = readinessRig();
    const guildId = await old.ready();
    expect(gateCauseNow(guildId, now())).toBe('admit');
    const oldClaims = old.store.hydrationsSent;
    const next = readinessRig();
    next.store.hydrateMode = 'held';
    expect(gateCauseNow(guildId, now())).toBe('loading');
    expect(next.store.hydrationsSent).toBe(1);
    expect(old.store.hydrationsSent).toBe(oldClaims);
  });
});

describe('the texts', () => {
  it.each([
    ['refused', "This bot's data storage is currently unavailable; please contact the server operator."],
    ['stopping', 'The bot is stopping; please try again in a moment.'],
    ['moved', "Another bot process took over this server's data; please try again in a moment."],
    ['not-served', "This server's data is not served by this bot process right now; please try again in a moment."],
    ['loading', "This server's data is still loading, try again in a moment."],
  ] as const)('%s', (cause, text) => {
    expect(gateCauseText(cause)).toBe(text);
  });
});

describe('the hold', () => {
  it('a freeze lifted inside the bound admits there, with a mark taken at admission', async () => {
    fakeClock();
    const r = readinessRig();
    const guildId = await r.ready();
    freezeGuildWrites(guildId);
    const start = now();
    const hold = watch(admitGuildAction(guildId, start + 2000));
    await vi.advanceTimersByTimeAsync(1000);
    expect(hold.settled()).toBe(false);
    unfreezeGuildWrites(guildId);
    await vi.advanceTimersByTimeAsync(100);
    expect(hold.settled()).toBe(true);
    expect(hold.value()!.cause).toBe('admit');
    expect(hold.value()!.mark).not.toBeNull();
  });

  it('a freeze lifted after the bound answers loading at the deadline, with no mark', async () => {
    fakeClock();
    const r = readinessRig();
    const guildId = await r.ready();
    freezeGuildWrites(guildId);
    try {
      const hold = watch(admitGuildAction(guildId, now() + 2000));
      await vi.advanceTimersByTimeAsync(1990);
      expect(hold.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      expect(hold.value()).toEqual({ cause: 'loading', mark: null });
    } finally {
      unfreezeGuildWrites(guildId);
    }
  });

  it('a set ready exactly at the deadline is admitted: the deadline takes one more reading', async () => {
    fakeClock();
    const r = readinessRig();
    const guildId = r.hydrating();
    // Off the 50 ms poll grid, so only the reading at the deadline itself can see it.
    setTimeout(() => r.store.releaseHydrations(), 2010);
    const hold = watch(admitGuildAction(guildId, now() + 2010));
    await vi.advanceTimersByTimeAsync(2020);
    expect(hold.value()!.cause).toBe('admit');
  });

  it('a freeze lifted one tick after the deadline is refused', async () => {
    fakeClock();
    const r = readinessRig();
    const guildId = await r.ready();
    freezeGuildWrites(guildId);
    setTimeout(() => unfreezeGuildWrites(guildId), 2011);
    const hold = watch(admitGuildAction(guildId, now() + 2010));
    await vi.advanceTimersByTimeAsync(2020);
    expect(hold.value()!.cause).toBe('loading');
  });

  it('a final cause ends the hold at once', async () => {
    fakeClock();
    const r = readinessRig();
    const guildId = await r.ready();
    r.store.mode = 'deposed';
    saveData('x.json', { guildId, category: 'm' }, { v: 1 });
    await r.ws.flushGuildNow(guildId, 1000);
    const hold = watch(admitGuildAction(guildId, now() + 2000));
    await vi.advanceTimersByTimeAsync(0);
    expect(hold.value()).toEqual({ cause: 'moved', mark: null });
  });

  it('a claim the hold kicked and that comes back deposed ends the hold with moved, at its next reading', async () => {
    fakeClock();
    const r = readinessRig();
    r.store.hydrateMode = 'deposed';
    const guildId = r.guild();
    const hold = watch(admitGuildAction(guildId, now() + 2000));
    await vi.advanceTimersByTimeAsync(60);
    expect(hold.value()).toEqual({ cause: 'moved', mark: null });
    expect(r.store.hydrationsSent).toBe(1);
  });

  it('not-served waits, and a grant inside the bound is taken', async () => {
    fakeClock();
    const r = readinessRig(NOT_LEASED);
    const guildId = r.guild();
    const hold = watch(admitGuildAction(guildId, now() + 2000));
    await vi.advanceTimersByTimeAsync(500);
    expect(hold.settled()).toBe(false);
    r.driver.onLeaseChanged({ ...LEASED, claim: 3 });
    await vi.advanceTimersByTimeAsync(200);
    expect(hold.value()!.cause).toBe('admit');
  });

  it('a lease removed mid-hydration answers not-served at the deadline, not loading', async () => {
    fakeClock();
    const r = readinessRig();
    const guildId = r.hydrating();
    const hold = watch(admitGuildAction(guildId, now() + 2000));
    await vi.advanceTimersByTimeAsync(300);
    r.driver.onLeaseChanged(NOT_LEASED);
    r.store.releaseHydrations('unavailable');
    await vi.advanceTimersByTimeAsync(1800);
    expect(hold.value()!.cause).toBe('not-served');
  });

  it('a set evicted mid-wait is read again as having no set', async () => {
    fakeClock();
    const r = readinessRig();
    const guildId = await r.ready();
    freezeGuildWrites(guildId);
    const hold = watch(admitGuildAction(guildId, now() + 2000));
    await vi.advanceTimersByTimeAsync(500);
    expect(hold.settled()).toBe(false);
    r.ws.evict(guildId);
    await vi.advanceTimersByTimeAsync(200);
    expect(hold.value()!.cause).toBe('admit');
  });
});
