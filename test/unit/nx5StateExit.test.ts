import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NX5 test 6 (sheets/NX5.md section 5): the bot cells P1 to P3 and P5 that a unit rig drives. P4 (the maintenance
// boot) is in nx5Boot.test.ts, since a maintenance boot marks its process for good; P5's standby reading no order is
// also test 1's row. Fails today: the bot has no order read.

type Left = { unsavedGuilds: number; unsavedFiles: number; unansweredGuilds: number; unconfirmedFiles: number };
const ZERO: Left = { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 };
const ctl = vi.hoisted(() => ({ next: null as Left | null, calls: 0, held: false }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  saveHeldWrites: async () => {
    ctl.calls += 1;
    return ctl.next ?? { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 };
  },
  hasHeldWrites: () => ctl.held,
}));

import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { ShardClaims, type ShardClaimsDeps } from '../../src/bot/internalSetup/fleet/shardClaims';
import * as maintenance from '../../src/bot/internalSetup/utils/maintenance';
import { isMaintenanceGateClosed, maintenanceCause, maintenanceText } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { ME, MESSAGE, OrderStore, order, settle } from '../helpers/nx5Rig';

const m = maintenance as any;
const T = claimTimings(30);
const sent: any[] = [];

beforeEach(() => {
  sent.length = 0;
  ctl.next = null;
  ctl.calls = 0;
  ctl.held = false;
  maintenance._setMaintenanceSender(message => { sent.push(message); });
  maintenance.markDiscordStarted();
  writeMaintenanceFile('running', 'The last message.');
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  m.attachSaveOrderSource?.(null);
  maintenance._resetMaintenance();
  maintenance._setMaintenanceSender(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const restarts = () => sent.filter(s => s.type === 'control:restart-bot');

/** A serving process whose claims lane feeds every order read to the bot process, as shardBoot wires it. */
function wired() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  const store = new OrderStore(() => Date.now());
  m.attachSaveOrderSource?.({ me: ME, read: () => store.readSaveOrder(), writeAck: (ack: any) => store.writeSaveAck(ack) });
  const claims = new ShardClaims({
    store, me: ME, timings: T, capacity: 4, takeoverSeconds: 30, returns: true, restartable: true, startedAt: 0,
    clocks: () => ({ perf: performance.now(), wall: Date.now() }),
    fitness: () => maintenance.maintenanceUnfit(),
    gateClosed: () => isMaintenanceGateClosed(),
    isStopping: () => false,
    stopServingStep: () => undefined,
    noteLapsed: () => undefined,
    noteLost: () => undefined,
    restartForShards: () => true,
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onSaveOrder: (read: unknown) => m.noteSaveOrder?.(read),
  } as ShardClaimsDeps);
  const renewal = async (times = 1) => {
    for (let i = 0; i < times; i++) await vi.advanceTimersByTimeAsync(T.renewMs);
    await settle();
  };
  return { store, claims, renewal };
}

describe('test 6: P1, the bot saw the order and saves', () => {
  it('continue: the gate closes with cause order, the process saves and answers at the next renewal', async () => {
    const w = wired();
    w.claims.start();
    await w.claims.firstRenewal();
    w.store.saveOrder = order();
    await w.renewal();
    expect(maintenanceCause()).toBe('order');
    expect(w.store.acks.map(a => a.saved)).toEqual([true]);
    void w.claims.stopLanes();
  });

  it('fail: a save that fails answers false and saves again at each renewal until true', async () => {
    const w = wired();
    w.claims.start();
    await w.claims.firstRenewal();
    ctl.next = { ...ZERO, unsavedGuilds: 1 };
    w.store.saveOrder = order();
    await w.renewal(2);
    expect(w.store.acks.map(a => a.saved)).toEqual([false, false]);
    ctl.next = ZERO;
    await w.renewal();
    expect(w.store.acks.map(a => a.saved)).toEqual([false, false, true]);
    void w.claims.stopLanes();
  });

  it('link cut: renewals fail, the kept read turns unknown and the process stays; when the link returns it reads, saves and answers', async () => {
    const w = wired();
    w.claims.start();
    await w.claims.firstRenewal();
    w.store.saveOrder = order();
    await w.renewal();
    expect(w.store.acks).toHaveLength(1);
    ctl.next = { ...ZERO, unsavedGuilds: 2 };
    ctl.held = true;
    w.store.renewMode = new Error('connect ETIMEDOUT');
    await w.renewal(2);
    expect(w.store.acks).toHaveLength(1);
    expect(maintenanceCause()).toBe('order');
    expect(restarts()).toEqual([]);
    w.store.renewMode = 'ok';
    ctl.next = ZERO;
    await w.renewal();
    expect(w.store.acks.at(-1)).toMatchObject({ saved: true });
    void w.claims.stopLanes();
  });
});

describe('test 6: P2, the bot answered true', () => {
  it('holds nothing, answers interactions with the order\'s message, and writes no new answer while nothing is held', async () => {
    const w = wired();
    w.claims.start();
    await w.claims.firstRenewal();
    w.store.saveOrder = order();
    await w.renewal(3);
    expect(maintenanceText()).toBe(MESSAGE);
    expect(w.store.acks.map(a => a.saved)).toEqual([true]);
    expect(ctl.calls).toBe(1);
    void w.claims.stopLanes();
  });
});

describe('test 6: P3, the order ended', () => {
  it('the renewal read of a current running order starts the leave', async () => {
    const w = wired();
    w.claims.start();
    await w.claims.firstRenewal();
    w.store.saveOrder = order();
    await w.renewal();
    expect(maintenanceCause()).toBe('order');
    w.store.saveOrder = order({ state: 'running' });
    await w.renewal();
    await vi.advanceTimersByTimeAsync(100);
    expect(restarts()).toHaveLength(1);
    void w.claims.stopLanes();
  });
});
