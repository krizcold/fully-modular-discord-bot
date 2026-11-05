import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Round 8 fix of NB4: once the leave has asked for its own restart, the fleet page no longer says a pending shard
// restart waits on maintenance.

const h = vi.hoisted(() => ({ unsaved: 0 }));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<object>()),
  saveHeldWrites: async () => ({ unsavedGuilds: h.unsaved, unsavedFiles: 0 }),
  stopProcess: () => undefined,
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => ({
  ...(await orig<object>()),
  getWorkingSet: () => ({
    heldGuilds: () => (h.unsaved > 0 ? [{ guildId: '111', reason: 'connection refused', code: null }] : []),
    takeDropLines: () => [],
  }),
}));

vi.mock('../../src/utils/maintenanceFile', async orig => ({
  ...(await orig<object>()),
  readMaintenanceFile: () => ({ state: 'running', message: 'Down for maintenance', since: null }),
}));

import {
  _resetMaintenance,
  _setMaintenanceSender,
  _setMaintenanceTiming,
  leaveRestartAsked,
  maintenanceUnfit,
  noteClaimsLapsed,
  restartForShards,
  startLeave,
} from '../../src/bot/internalSetup/utils/maintenance';
import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { MemClaimStore } from '../helpers/fakeClaimStore';

const T = claimTimings(30);
const sent: any[] = [];
const restarts = () => sent.filter(m => m.type === 'control:restart-bot').length;

beforeEach(() => {
  sent.length = 0;
  h.unsaved = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  _setMaintenanceSender(message => { sent.push(message); });
  _setMaintenanceTiming({ leaveRetryMs: 1_000, restartResendMs: 60_000, heldAfterPasses: 3 });
});
afterEach(() => {
  _resetMaintenance();
  _setMaintenanceSender(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function lapsedClaims() {
  const store = new MemClaimStore(() => Date.now());
  store.count = 4;
  store.rows.set('4:3', {
    shardCount: 4, shardId: 3, claim: 7, holderProcess: 'p-b', holderNode: 'node-b', holderName: 'B', homeNode: 'node-b',
    released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: 10_000_000, extended: false,
  });
  let unfit = false;
  const fitness = () => (unfit ? maintenanceUnfit() : null);
  const claims = new ShardClaims({
    store, me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' }, timings: T, capacity: 4, takeoverSeconds: 30,
    returns: false, restartable: true, startedAt: 0, fitness, gateClosed: () => false, isStopping: () => false,
    stopServingStep: () => undefined, noteLapsed: noteClaimsLapsed, noteLost: () => undefined,
    restartForShards: reason => restartForShards(reason, fitness), leaveRestartAsked,
    log: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  expect(await claims.firstRenewal()).toBe(true);
  expect((await claims.bootTake(async () => 4))!.pairs.map(p => p.shardId)).toEqual([0, 1, 2]);
  claims.noteGranted();
  store.rows.get('4:3')!.expiresUpMs = 0;
  await claims.renewOnce();
  await vi.advanceTimersByTimeAsync(0);
  expect(restarts()).toBe(1);
  expect(claims.snapshot().pendingRestart).toBe('take shard 3');
  unfit = true;
  await vi.advanceTimersByTimeAsync(T.deadlineMs + 1_000);
  expect(claims.snapshot().stopped).toBe('lapse');
  return claims;
}

describe("the page drops the waiting note once the leave asked for its own restart (NB4-R8-RUN-1)", () => {
  it('before the leave asks: the waiting note names the outage', async () => {
    const claims = await lapsedClaims();
    expect(leaveRestartAsked()).toBe(false);
    expect(claims.snapshot().restartWaiting).toBe('maintenance mode outage');
  });

  it("after the leave's request: a second restart request is sent and no waiting note is shown", async () => {
    const claims = await lapsedClaims();
    startLeave('The data backend answers again');
    await vi.advanceTimersByTimeAsync(0);
    expect(restarts()).toBe(2);
    expect(leaveRestartAsked()).toBe(true);
    expect(claims.snapshot().pendingRestart).toBe('take shard 3');
    expect(claims.snapshot().restartWaiting).toBeNull();
  });

  it('a shard restart alone is not the leave asking', () => {
    expect(restartForShards('take shard 3', () => null)).toBe(true);
    expect(leaveRestartAsked()).toBe(false);
  });
});
