import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Round 6 fixes of NB4: once the process stops serving, a restart request sent earlier is no longer re-sent and the
// leave asks for its own restart only when nothing is held (its held line names the earlier request); the boot names
// each shard a completed release kept for this machine (keptAtStop) that another machine took while it restarted.

const h = vi.hoisted(() => ({ unsaved: 1 }));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<object>()),
  saveHeldWrites: async () => ({ unsavedGuilds: h.unsaved, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 }),
  stopProcess: () => undefined,
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => ({
  ...(await orig<object>()),
  getWorkingSet: () => ({
    resaveGuilds: () => [],
    heldGuilds: () => (h.unsaved > 0 ? [{ guildId: '111', reason: 'connection refused', code: null }] : []),
    takeDropLines: () => [],
    unansweredGuilds: () => ({ all: [], only: [] }),
  }),
}));

import {
  _resetMaintenance,
  _setMaintenanceSender,
  _setMaintenanceTiming,
  maintenanceUnfit,
  noteClaimsLapsed,
  restartForShards,
  startLeave,
} from '../../src/bot/internalSetup/utils/maintenance';
import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings, planTake, type ClaimRow } from '../../src/bot/internalSetup/fleet/claimRules';
import { MemClaimStore } from '../helpers/fakeClaimStore';

const sent: any[] = [];
let logs: string[] = [];
const restarts = () => sent.filter(m => m.type === 'control:restart-bot').length;

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

describe('a restart request sent before a lapse or a loss (NB4-R6-RUN-1)', () => {
  const setup = () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    _setMaintenanceSender(message => { sent.push(message); });
    _setMaintenanceTiming({ leaveRetryMs: 1_000, restartResendMs: 60_000, heldAfterPasses: 3 });
    expect(restartForShards('take shard 3', () => null)).toBe(true);
    expect(restarts()).toBe(1);
  };
  const heldLine = () => logs.find(l => l.includes('saves in a row left changes unsaved'));

  it('after a lapse: no re-send while changes are held, the held line names the earlier request, one request once saved', async () => {
    setup();
    noteClaimsLapsed(20);
    expect(maintenanceUnfit()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(130_000);
    expect(restarts()).toBe(1);
    startLeave('The shard claims lapsed (no renewal for 20 s) and the database answers');
    await vi.advanceTimersByTimeAsync(130_000);
    expect(restarts()).toBe(1);
    expect(heldLine()).toBe('[Maintenance] 3 saves in a row left changes unsaved: guild 111 (connection refused); the bot process stays off Discord and does not restart until they are saved or the operator restarts it, which drops them; a restart this process asked for earlier may still stop it, which drops them');
    expect(maintenanceUnfit()).not.toBeNull();
    h.unsaved = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(restarts()).toBe(2);
  });

  it('after a loss: the leave stops the re-send at its start', async () => {
    setup();
    startLeave('Shard 1 is no longer held by this process');
    await vi.advanceTimersByTimeAsync(130_000);
    expect(restarts()).toBe(1);
    expect(heldLine()).toMatch(/; a restart this process asked for earlier may still stop it, which drops them$/);
    expect(maintenanceUnfit()).not.toBeNull();
    expect(restartForShards('take shard 2', maintenanceUnfit)).toBe(false);
    h.unsaved = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(restarts()).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(restarts()).toBe(3);
  });

  it('with no earlier request the held line keeps its words', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    _setMaintenanceSender(message => { sent.push(message); });
    _setMaintenanceTiming({ leaveRetryMs: 1_000, heldAfterPasses: 3 });
    startLeave('Shard 1 is no longer held by this process');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heldLine()).toBe('[Maintenance] 3 saves in a row left changes unsaved: guild 111 (connection refused); the bot process keeps running and does not restart until they are saved or the operator restarts it, which drops them');
    expect(restarts()).toBe(0);
  });
});

describe("the boot names a shard of its last start taken while it restarted (NB4-R6-RUN-2)", () => {
  const T = claimTimings(30);
  const otherRow = (shardId: number, over: Partial<ClaimRow> = {}): ClaimRow => ({
    shardCount: 4, shardId, claim: 7, holderProcess: 'p-b', holderNode: 'node-b', holderName: 'B', homeNode: 'node-a',
    released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: 10_000_000, extended: false, ...over,
  });

  async function boot(record: { shardCount: number; shardIds: number[]; keptAtStop?: number[] } | null, rows: ClaimRow[]) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    const store = new MemClaimStore(() => Date.now());
    store.count = 4;
    for (const r of rows) store.rows.set(`4:${r.shardId}`, r);
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const claims = new ShardClaims({
      store, me: { processId: 'p-a2', nodeId: 'node-a', nodeName: 'A' }, timings: T, capacity: 4, takeoverSeconds: 30,
      returns: true, restartable: true, startedAt: 0, fitness: () => null, gateClosed: () => false, isStopping: () => false,
      stopServingStep: () => undefined, noteLapsed: () => undefined, noteLost: () => undefined, restartForShards: () => false,
      lastRecord: () => record, log,
    });
    claims.start();
    expect(await claims.firstRenewal()).toBe(true);
    const taken = await claims.bootTake(async () => 4);
    const lines = [...log.log.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].map(c => String(c[0]));
    return { taken, lines };
  }

  it('logs the line for a kept shard another machine holds, and only for it', async () => {
    const { taken, lines } = await boot({ shardCount: 4, shardIds: [0, 2], keptAtStop: [2] }, [otherRow(2), otherRow(3)]);
    expect(taken!.pairs.map(p => p.shardId).sort()).toEqual([0, 1]);
    expect(lines.filter(l => l.includes('while it restarted'))).toEqual(['[Shards] Shard 2 kept for this machine was taken by B while it restarted']);
  });

  it('logs nothing for a record without keptAtStop (a crash, or a release that never completed)', async () => {
    const { taken, lines } = await boot({ shardCount: 4, shardIds: [0, 2] }, [otherRow(2), otherRow(3)]);
    expect(taken!.pairs.map(p => p.shardId).sort()).toEqual([0, 1]);
    expect(lines.some(l => l.includes('while it restarted'))).toBe(false);
  });

  it('logs nothing with no record, or a record of another shard count', async () => {
    for (const record of [null, { shardCount: 2, shardIds: [0, 1], keptAtStop: [0, 1] }]) {
      const { lines } = await boot(record, [otherRow(0), otherRow(1)]);
      expect(lines.some(l => l.includes('while it restarted'))).toBe(false);
      vi.useRealTimers();
    }
  });

  it("planTake lists the live rows of other machines, not this machine's", () => {
    const plan = planTake({
      me: { processId: 'p-a2', nodeId: 'node-a', nodeName: 'A' }, capacity: 4, boot: false, known: [], shardCount: 4,
      rows: [otherRow(1), otherRow(2, { holderNode: 'node-a', holderName: 'A', holderProcess: 'p-a1', released: true }), otherRow(3, { expiresUpMs: 0 })],
      nodes: [], upMs: 1_000, uPrimeMs: 1_000,
    });
    expect(plan.elsewhere).toEqual([{ shardId: 1, holderName: 'B' }]);
  });
});
