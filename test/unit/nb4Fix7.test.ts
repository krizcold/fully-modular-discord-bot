import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Round 7 fixes of NB4: only a restart the shard claims asked for is withdrawn (the leave's own request keeps being
// sent), a refused login withdraws it too and its line names it, the lapse line names it, the fleet page says why the
// pending restart waits, and the boot names only a shard the last completed release kept for this machine.

const h = vi.hoisted(() => ({ unsaved: 1 }));

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
  markDiscordStarted,
  maintenanceUnfit,
  noteClaimsLapsed,
  restartForShards,
  startLeave,
  watchDataBackend,
} from '../../src/bot/internalSetup/utils/maintenance';
import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings, type ClaimRow } from '../../src/bot/internalSetup/fleet/claimRules';
import { readShardRecord, writeShardRecord } from '../../src/bot/internalSetup/fleet/shardRecord';
import { MemClaimStore } from '../helpers/fakeClaimStore';

const sent: any[] = [];
let logs: string[] = [];
const restarts = () => sent.filter(m => m.type === 'control:restart-bot').length;
const EARLIER = '; a restart this process asked for earlier may still stop it, which drops them';

beforeEach(() => {
  sent.length = 0;
  logs = [];
  h.unsaved = 1;
  const capture = (...args: unknown[]) => { logs.push(String(args[0])); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});
afterEach(() => {
  _resetMaintenance();
  _setMaintenanceSender(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  _setMaintenanceSender(message => { sent.push(message); });
  _setMaintenanceTiming({ leaveRetryMs: 1_000, restartResendMs: 60_000, heldAfterPasses: 3 });
}

describe("a lapse keeps the leave's own restart request (NB4-R7-RUN-1)", () => {
  it('a finished leave asked for its restart; a lapse after it does not stop the re-send', async () => {
    fakeTimers();
    h.unsaved = 0;
    startLeave('The hook says running');
    await vi.advanceTimersByTimeAsync(0);
    expect(restarts()).toBe(1);
    noteClaimsLapsed(20);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(restarts()).toBe(2);
    expect(maintenanceUnfit()).not.toBeNull();
  });

  it('a shard restart is still withdrawn at a lapse', async () => {
    fakeTimers();
    expect(restartForShards('take shard 3', () => null)).toBe(true);
    noteClaimsLapsed(20);
    await vi.advanceTimersByTimeAsync(130_000);
    expect(restarts()).toBe(1);
  });
});

describe('a refused login withdraws a shard restart (NB4-R7-DATA-2 a)', () => {
  function watcher() {
    let refused: () => void = () => undefined;
    watchDataBackend({ onLoginRefused: cb => { refused = cb; }, askDatabase: async () => 'unreachable' }, { retryMs: 3_600_000 });
    return () => refused();
  }
  const refusedLine = () => logs.find(l => l.includes('(SQLSTATE 28000); answering with the maintenance message'));

  it('after restartForShards: no re-send while the gate stays closed, and the line names the earlier request', async () => {
    fakeTimers();
    markDiscordStarted();
    const refuse = watcher();
    expect(restartForShards('take shard 3', () => null)).toBe(true);
    refuse();
    expect(refusedLine()).toBe(`[Maintenance] The database refused the login (SQLSTATE 28000); answering with the maintenance message and keeping the unsaved changes until the login returns${EARLIER}`);
    await vi.advanceTimersByTimeAsync(130_000);
    expect(restarts()).toBe(1);
    expect(maintenanceUnfit()).not.toBeNull();
  });

  it('with no earlier request the line keeps its words', () => {
    fakeTimers();
    markDiscordStarted();
    watcher()();
    expect(refusedLine()).toBe('[Maintenance] The database refused the login (SQLSTATE 28000); answering with the maintenance message and keeping the unsaved changes until the login returns');
  });
});

const T = claimTimings(30);

async function servingClaims(opts: { fitness: () => string | null; gateClosed?: () => boolean; restartSent: boolean }) {
  const store = new MemClaimStore(() => Date.now());
  store.count = 4;
  store.rows.set('4:3', {
    shardCount: 4, shardId: 3, claim: 7, holderProcess: 'p-b', holderNode: 'node-b', holderName: 'B', homeNode: 'node-b',
    released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: 10_000_000, extended: false,
  });
  const lines: string[] = [];
  const claims = new ShardClaims({
    store, me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' }, timings: T, capacity: 4, takeoverSeconds: 30,
    returns: false, restartable: true, startedAt: 0, fitness: opts.fitness, gateClosed: opts.gateClosed ?? (() => false),
    isStopping: () => false, stopServingStep: () => undefined, noteLapsed: () => undefined, noteLost: () => undefined,
    restartForShards: () => opts.restartSent,
    log: { log: l => lines.push(String(l)), warn: l => lines.push(String(l)), error: l => lines.push(String(l)) },
  });
  expect(await claims.firstRenewal()).toBe(true);
  const taken = await claims.bootTake(async () => 4);
  expect(taken!.pairs.map(p => p.shardId)).toEqual([0, 1, 2]);
  claims.noteGranted();
  // A row that turns takeable after the boot: the next work cycle reserves it and asks for the restart.
  store.rows.get('4:3')!.expiresUpMs = 0;
  await claims.renewOnce();
  await vi.advanceTimersByTimeAsync(0);
  return { claims, lines, store };
}

describe('the lapse line names a shard restart already sent (NB4-R7-DATA-2 b) and the page says why it waits (NB4-R7-RUN-3)', () => {
  it('sent: the lapse line carries the caveat, and the snapshot reports the fitness key', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    let unfit: string | null = null;
    const r = await servingClaims({ fitness: () => unfit, restartSent: true });
    expect(r.claims.snapshot().pendingRestart).toBe('take shard 3');
    expect(r.claims.snapshot().restartWaiting).toBeNull();
    unfit = 'maintenance mode outage';
    await vi.advanceTimersByTimeAsync(T.deadlineMs + 1_000);
    expect(r.claims.snapshot().stopped).toBe('lapse');
    expect(r.lines.find(l => l.startsWith('[Shards] No claim renewal for'))).toMatch(/kept until a renewal completes; a restart this process asked for earlier may still stop it, which drops them$/);
    expect(r.claims.snapshot().pendingRestart).toBe('take shard 3');
    expect(r.claims.snapshot().restartWaiting).toBe('maintenance mode outage');
  });

  it('sent, then the gate closes: the snapshot reports the fitness key', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    let closed = false;
    const r = await servingClaims({ fitness: () => (closed ? 'maintenance mode login-refused' : null), gateClosed: () => closed, restartSent: true });
    closed = true;
    expect(r.claims.snapshot().restartWaiting).toBe('maintenance mode login-refused');
  });

  it('never sent: the lapse line keeps its words', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    const r = await servingClaims({ fitness: () => null, restartSent: false });
    await vi.advanceTimersByTimeAsync(T.deadlineMs + 1_000);
    expect(r.lines.find(l => l.startsWith('[Shards] No claim renewal for'))).toMatch(/kept until a renewal completes$/);
  });
});

describe('the boot names only a shard the last release kept for this machine (NB4-R7-DATA-1, RUN-2, T1)', () => {
  function claimsOver(store: MemClaimStore, processId: string, extra: Partial<ConstructorParameters<typeof ShardClaims>[0]>, lines: string[] = []) {
    return new ShardClaims({
      store, me: { processId, nodeId: 'node-a', nodeName: 'A' }, timings: T, capacity: 2, takeoverSeconds: 30, returns: true,
      restartable: true, startedAt: 0, fitness: () => null, gateClosed: () => false, isStopping: () => false,
      stopServingStep: () => undefined, noteLapsed: () => undefined, noteLost: () => undefined, restartForShards: () => true,
      log: { log: l => lines.push(String(l)), warn: l => lines.push(String(l)), error: l => lines.push(String(l)) },
      ...extra,
    });
  }

  async function stopAfterReturn() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    const store = new MemClaimStore(() => Date.now());
    const kept: Array<[number, number[]]> = [];
    const a = claimsOver(store, 'p-a', { noteKeptAtStop: (count, ids) => { kept.push([count, ids]); } });
    a.start();
    await a.firstRenewal();
    expect((await a.bootTake(async () => 2))!.pairs.map(p => p.shardId)).toEqual([0, 1]);
    a.noteGranted();
    store.rows.get('2:1')!.homeNode = 'node-b';
    store.nodes.set('node-b', {
      nodeId: 'node-b', nodeName: 'B', processId: 'p-b', capacity: 1, takeoverSeconds: 30, fit: true, restartable: true, returns: true,
      seenAgoMs: 0, healthyForMs: null, seenAt: Date.now(), healthySince: Date.now() - 301_000,
    });
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(a.snapshot().returning).toEqual([1]);
    a.beginStop();
    await a.finishStop();
    expect(store.rows.get('2:1')).toMatchObject({ holderNode: 'node-b', released: true });
    return { store, kept };
  }

  async function bootAgain(store: MemClaimStore, record: { shardCount: number; keptAtStop?: number[] } | null) {
    const lines: string[] = [];
    const a2 = claimsOver(store, 'p-a2', { lastRecord: () => record }, lines);
    await a2.firstRenewal();
    const taken = await a2.bootTake(async () => 2);
    return { taken, restarted: lines.filter(l => l.includes('while it restarted')) };
  }

  it('the release records only the kept shard; a hand-over logs no line before or after B takes it', async () => {
    const { store, kept } = await stopAfterReturn();
    expect(kept).toEqual([[2, [0]]]);
    const record = { shardCount: 2, keptAtStop: kept[0][1] };
    const before = await bootAgain(store, record);
    expect(before.restarted).toEqual([]);
    expect(before.taken!.pairs.map(p => p.shardId)).toEqual([0]);
  });

  it('a hand-over B already took logs no line', async () => {
    const { store, kept } = await stopAfterReturn();
    Object.assign(store.rows.get('2:1')!, { holderProcess: 'p-b', released: false });
    const after = await bootAgain(store, { shardCount: 2, keptAtStop: kept[0][1] });
    expect(after.restarted).toEqual([]);
  });

  it('a kept shard B took after its expiry is named; a record with no keptAtStop names nothing', async () => {
    const { store, kept } = await stopAfterReturn();
    const takenByB: Partial<ClaimRow> = { holderProcess: 'p-b', holderNode: 'node-b', holderName: 'B', released: false, expiresUpMs: 10_000_000 };
    Object.assign(store.rows.get('2:0')!, takenByB);
    const named = await bootAgain(store, { shardCount: 2, keptAtStop: kept[0][1] });
    expect(named.restarted).toEqual(['[Shards] Shard 0 kept for this machine was taken by B while it restarted']);
    vi.useRealTimers();
    const { store: store2 } = await stopAfterReturn();
    Object.assign(store2.rows.get('2:0')!, takenByB);
    expect((await bootAgain(store2, { shardCount: 2 })).restarted).toEqual([]);
  });

  it('a failed release records nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    const store = new MemClaimStore(() => Date.now());
    const kept: number[][] = [];
    const a = claimsOver(store, 'p-a', { noteKeptAtStop: (_count, ids) => { kept.push(ids); } });
    await a.firstRenewal();
    await a.bootTake(async () => 2);
    a.noteGranted();
    store.releaseMode = new Error('connection refused');
    a.beginStop();
    await a.finishStop();
    expect(kept).toEqual([]);
  });
});

describe('the shard record carries keptAtStop', () => {
  it('reads back valid ids and drops ids outside the count', () => {
    writeShardRecord({ shardCount: 4, shardIds: [0, 1], processId: 'p', at: 'now', keptAtStop: [1] });
    expect(readShardRecord()).toMatchObject({ shardCount: 4, shardIds: [0, 1], keptAtStop: [1] });
    writeShardRecord({ shardCount: 4, shardIds: [0, 1], processId: 'p', at: 'now', keptAtStop: [9] });
    expect(readShardRecord()!.keptAtStop).toBeUndefined();
    writeShardRecord({ shardCount: 4, shardIds: [0, 1], processId: 'p', at: 'now' });
    expect(readShardRecord()!.keptAtStop).toBeUndefined();
  });
});
