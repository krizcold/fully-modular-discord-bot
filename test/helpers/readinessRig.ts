import { expect, vi } from 'vitest';

import { initDataReadiness, type DataReadinessDriver, type LeaseSnapshot } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { setRouteOverride } from '../../src/bot/internalSetup/utils/dataBackends/routeResolver';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { FakeStore, tokenFor } from './fakeStore';
import { freshGuild } from './gateRig';

// R1-J2's rig: a real readiness driver over a scripted store and its working set, the lease set by the test. One
// shard, so every guild is on shard 0.

export const LEASED: LeaseSnapshot = { nodeId: 'node-a', term: 1, epoch: 1, shardCount: 1, shardIds: [0] };
export const NOT_LEASED: LeaseSnapshot = { nodeId: 'node-a', term: 1, epoch: 2, shardCount: 1, shardIds: [] };

const drivers: DataReadinessDriver[] = [];

/** Installs a fresh store, working set and driver as the process's own (a recycle installs the same way). */
export function readinessRig(lease: LeaseSnapshot | null = LEASED) {
  const store = new FakeStore();
  const ws = initWorkingSet(store);
  const driver = initDataReadiness(store, ws, { held: false });
  drivers.push(driver);
  if (lease) driver.onLeaseChanged(lease);
  /** A postgres-routed guild with no working set. */
  const guild = () => {
    const guildId = freshGuild();
    setRouteOverride(guildId, 'postgres');
    return guildId;
  };
  /** A postgres-routed guild whose set is ready. */
  const ready = async () => {
    const guildId = guild();
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    return guildId;
  };
  /** A postgres-routed guild whose set hydrates until the store releases it. */
  const hydrating = () => {
    const guildId = guild();
    store.hydrateMode = 'held';
    void ws.hydrate(guildId, tokenFor());
    expect(ws.stateOf(guildId)).toBe('hydrating');
    return guildId;
  };
  return { store, ws, driver, guild, ready, hydrating };
}

/** Stops every driver a test installed: its catalog interval runs from its constructor. */
export function stopDrivers(): void {
  for (const driver of drivers.splice(0)) driver.stop();
}

/** setTimeout, setInterval and performance under the test's clock; promises run between timers. */
export function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
}

/** Whether a promise has settled, without waiting on it. */
export function watch<T>(promise: Promise<T>): { settled: () => boolean; value: () => T | undefined } {
  let done = false;
  let result: T | undefined;
  void promise.then(value => { done = true; result = value; });
  return { settled: () => done, value: () => result };
}
