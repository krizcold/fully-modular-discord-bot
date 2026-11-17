import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NX5 test 3 (sheets/NX5.md decisions 8 and 11), the serving process's rows; the maintenance boot's poll is in
// nx5LeavePredicateBoot.test.ts, since a maintenance boot marks its process for good. Every leave path asks one
// predicate first: the maintenance file says maintenance, or the database refuses the login, or the kept order read is
// a current maintenance order. The leave starts only when no source holds. The hook's leave reads first (within 3 s),
// then answers leaving true, false with heldBy, or null with the failed read. The rows where the order holds fail
// today (maintenance.ts:216-224, 676-689 and 331-333 leave on the file and the login alone).

const ctl = vi.hoisted(() => ({ held: false }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  saveHeldWrites: async () => ({ unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 }),
  hasHeldWrites: () => ctl.held,
}));

import * as maintenance from '../../src/bot/internalSetup/utils/maintenance';
import { maintenanceCause } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { ME, OrderStore, order, pgError, settle } from '../helpers/nx5Rig';

const m = maintenance as any;
type Db = 'answers' | 'refused' | 'unreachable';
const sent: any[] = [];

beforeEach(() => {
  sent.length = 0;
  ctl.held = false;
  maintenance._setMaintenanceSender(message => { sent.push(message); });
  maintenance._setMaintenanceTiming({ filePollMs: 40, leaveRetryMs: 40 });
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

/** A serving Postgres process: the watcher over a fake backend and, unless noStore, the claims pool's order source. */
function serving(opts: { noStore?: boolean; askMs?: number } = {}) {
  const db = { answer: 'answers' as Db, asks: 0 };
  const backend = {
    onLoginRefused: (_cb: () => void) => undefined,
    askDatabase: async (): Promise<Db> => {
      db.asks += 1;
      if (opts.askMs) await new Promise<void>(resolve => { setTimeout(resolve, opts.askMs); });
      return db.answer;
    },
  };
  const watcher = maintenance.watchDataBackend(backend, { retryMs: 3_600_000 })!;
  const store = new OrderStore();
  if (!opts.noStore) m.attachSaveOrderSource?.({ me: ME, read: () => store.readSaveOrder(), writeAck: (ack: any) => store.writeSaveAck(ack) });
  const probe = async (answer: Db) => {
    db.answer = answer;
    await watcher.probeNow();
    await settle();
  };
  return { db, store, probe };
}

const leave = () => maintenance.handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'l-1', data: {} });
const enterByHook = () => maintenance.handleMaintenanceIpc({ type: 'maintenance:enter', requestId: 'e-1', data: { message: 'From the hook.' } });

/** Nothing leaves in this time: the file poll and the leave's retry run every 40 ms. */
const quiet = () => new Promise<void>(resolve => { setTimeout(resolve, 300); });

type Source = 'none' | 'file' | 'login' | 'order';

describe('test 3: the file poll asks the predicate (cause hook)', () => {
  it.each<[Source, boolean]>([
    ['none', true],
    ['file', false],
    ['login', false],
    ['order', false],
  ])('with %s holding, maintenance.json saying running leaves: %s', async (source, leaves) => {
    const s = serving();
    await enterByHook();
    expect(maintenanceCause()).toBe('hook');
    if (source === 'login') await s.probe('refused');
    if (source === 'order') { m.noteSaveOrder?.(order()); await settle(); }
    writeMaintenanceFile(source === 'file' ? 'maintenance' : 'running', 'm');
    if (leaves) await vi.waitFor(() => expect(restarts()).toHaveLength(1));
    else {
      await quiet();
      expect(restarts()).toEqual([]);
    }
  });
});

describe('test 3: answered asks the predicate (cause login-refused)', () => {
  it.each<[Source, boolean]>([
    ['none', true],
    ['file', false],
  ])('with %s holding, the login accepted again while the file says running stays until a fresh order read, then leaves: %s', async (source, leaves) => {
    const s = serving();
    m.noteSaveOrder?.(null);
    await settle();
    await s.probe('refused');
    expect(maintenanceCause()).toBe('login-refused');
    writeMaintenanceFile(source === 'file' ? 'maintenance' : 'running', 'm');
    await s.probe('answers');
    await quiet();
    expect(restarts()).toEqual([]);
    m.noteSaveOrder?.(null);
    await settle();
    await s.probe('answers');
    if (leaves) await vi.waitFor(() => expect(restarts()).toHaveLength(1));
    else {
      await quiet();
      expect(restarts()).toEqual([]);
    }
  });

  it('an order read during the refused login turns the cause to order; the login accepted again does not leave while the order holds, and the order\'s end does', async () => {
    const s = serving();
    m.noteSaveOrder?.(null);
    await settle();
    await s.probe('refused');
    expect(maintenanceCause()).toBe('login-refused');
    m.noteSaveOrder?.(order());
    await settle();
    expect(maintenanceCause()).toBe('order');
    await s.probe('answers');
    await quiet();
    expect(restarts()).toEqual([]);
    m.noteSaveOrder?.(order({ state: 'running' }));
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
  });
});

describe('test 3: the outage leave asks the predicate (finding 2 of review round 1)', () => {
  const modes = () => sent.filter(x => x.type === 'maintenance:mode').map(x => x.data.mode);

  it('cause order: the claims lapsed, then the database answers while the order holds: the outage ends without the leave, and the order\'s end leaves', async () => {
    const s = serving();
    m.noteSaveOrder?.(order());
    await settle();
    expect(maintenanceCause()).toBe('order');
    maintenance.noteClaimsLapsed(25);
    expect(maintenance.maintenanceMode()).toBe('outage');
    await s.probe('answers');
    await quiet();
    expect(restarts()).toEqual([]);
    expect(maintenance.maintenanceMode()).toBe('maintenance');
    expect(modes().slice(-1)).toEqual(['maintenance']);
    m.noteSaveOrder?.(order({ state: 'running' }));
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
  });

  it('a refused login kept by an unknown read: the claims lapsed, then the database answers: the outage ends without the leave, and a fresh read lets the next answer leave', async () => {
    const s = serving();
    m.noteSaveOrder?.(null);
    await settle();
    await s.probe('refused');
    maintenance.noteClaimsLapsed(25);
    await s.probe('answers');
    await quiet();
    expect(restarts()).toEqual([]);
    // Review round 2, finding 2: the login was just accepted, so neither the log nor the mode says it is refused.
    expect(maintenance.maintenanceMode()).toBe('maintenance');
    const lines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => String(c[0]));
    expect(lines).toContain('[Maintenance] The database answers again after the shard claims lapsed; the bot process stays off Discord in maintenance until it reads the main database\'s maintenance order again');
    expect(lines.filter(l => l.includes('refuses the login'))).toEqual([]);
    m.noteSaveOrder?.(null);
    await settle();
    await s.probe('answers');
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
  });

  it('with nothing holding, the database answering after the lapse starts the leave (guard)', async () => {
    const s = serving();
    m.noteSaveOrder?.(null);
    await settle();
    maintenance.noteClaimsLapsed(25);
    await s.probe('answers');
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
  });
});

describe('test 3: the order\'s end asks the predicate (cause order)', () => {
  it.each<[Source, boolean]>([
    ['none', true],
    ['file', false],
  ])('with %s holding, a current running order leaves: %s', async (source, leaves) => {
    serving();
    m.noteSaveOrder?.(order());
    await settle();
    expect(maintenanceCause()).toBe('order');
    writeMaintenanceFile(source === 'file' ? 'maintenance' : 'running', 'm');
    m.noteSaveOrder?.(order({ state: 'running' }));
    if (leaves) await vi.waitFor(() => expect(restarts()).toHaveLength(1));
    else {
      await quiet();
      expect(restarts()).toEqual([]);
    }
  });
});

describe('test 3: the hook\'s leave reads first, then decides, then answers', () => {
  it('after Running\'s open and before the next renewal (kept read maintenance, watcher refused), its own read finds running and the login accepted: it leaves with leaving true', async () => {
    const s = serving();
    m.noteSaveOrder?.(order());
    await settle();
    await s.probe('refused');
    s.store.saveOrder = order({ state: 'running' });
    expect(await leave()).toEqual({ requestId: 'l-1', data: { leaving: true } });
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
  });

  it('while a current order stands it answers leaving false with heldBy order and does not leave', async () => {
    const s = serving();
    await enterByHook();
    s.store.saveOrder = order();
    expect(await leave()).toEqual({ requestId: 'l-1', data: { leaving: false, heldBy: 'order' } });
    expect(s.store.orderReads).toBe(1);
    await quiet();
    expect(restarts()).toEqual([]);
  });

  it('with the login refused (its read gets 28000) it answers leaving false with heldBy login', async () => {
    const s = serving();
    await enterByHook();
    s.store.saveOrder = pgError('28000', 'password authentication failed for user "bot"');
    expect(await leave()).toEqual({ requestId: 'l-1', data: { leaving: false, heldBy: 'login' } });
    await quiet();
    expect(restarts()).toEqual([]);
  });

  it('with the file saying maintenance it answers leaving false with heldBy file', async () => {
    const s = serving();
    await enterByHook();
    s.store.saveOrder = null;
    writeMaintenanceFile('maintenance', 'm');
    expect(await leave()).toEqual({ requestId: 'l-1', data: { leaving: false, heldBy: 'file' } });
  });

  it('heldBy names the first source that holds, in the order order, login, file', async () => {
    const s = serving();
    await enterByHook();
    s.store.saveOrder = order();
    writeMaintenanceFile('maintenance', 'm');
    expect(await leave()).toEqual({ requestId: 'l-1', data: { leaving: false, heldBy: 'order' } });
  });

  it('a read that fails with a timeout answers leaving null with the failed read\'s cause, and does not leave', async () => {
    const s = serving();
    await enterByHook();
    s.store.saveOrder = new Error('Query read timeout');
    expect(await leave()).toEqual({ requestId: 'l-1', data: { leaving: null, why: 'a timeout' } });
    await quiet();
    expect(restarts()).toEqual([]);
  });

  it('L1: a claims pool read that would answer after 6 s answers leaving null with "no answer within 3 seconds" at 3 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const s = serving();
    await enterByHook();
    s.store.saveOrder = order({ state: 'running' });
    s.store.orderDelayMs = 6_000;
    let answer: unknown = 'pending';
    void leave().then(a => { answer = a; });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(answer).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toEqual({ requestId: 'l-1', data: { leaving: null, why: 'no answer within 3 seconds' } });
  });
});

describe('test 3: the kept read', () => {
  it('a read from before the order, then a refusal (28000), then the login accepted while the row says maintenance: the process stays, and leaves only after a fresh read shows running', async () => {
    const s = serving();
    m.noteSaveOrder?.(null);
    await settle();
    await s.probe('refused');
    await s.probe('answers');
    await quiet();
    expect(restarts()).toEqual([]);
    m.noteSaveOrder?.(order());
    await quiet();
    expect(restarts()).toEqual([]);
    m.noteSaveOrder?.(order({ state: 'running' }));
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
  });

  it('a failed renewal after a read turns it unknown, which keeps the predicate\'s previous answer: the file poll does not leave', async () => {
    serving();
    await enterByHook();
    m.noteSaveOrder?.(order());
    await settle();
    m.noteSaveOrder?.('unknown');
    writeMaintenanceFile('running', 'm');
    await quiet();
    expect(restarts()).toEqual([]);
    m.noteSaveOrder?.(order({ state: 'running' }));
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
  });
});

describe('test 3: a serving process with no claims store (noShards) has no order source', () => {
  it('28000, then the login accepted while the file says running: answered leaves (guard)', async () => {
    const s = serving({ noStore: true });
    await s.probe('refused');
    expect(maintenanceCause()).toBe('login-refused');
    await s.probe('answers');
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
  });

  it('the hook\'s leave answers leaving true after its own askDatabase', async () => {
    const s = serving({ noStore: true });
    await s.probe('refused');
    s.db.answer = 'answers';
    const asked = s.db.asks;
    expect(await leave()).toEqual({ requestId: 'l-1', data: { leaving: true } });
    expect(s.db.asks).toBe(asked + 1);
  });

  it('an askDatabase that answers unreachable gives leaving null with "the database did not answer"', async () => {
    const s = serving({ noStore: true });
    await s.probe('refused');
    s.db.answer = 'unreachable';
    expect(await leave()).toEqual({ requestId: 'l-1', data: { leaving: null, why: 'the database did not answer' } });
  });

  it('an askDatabase slower than 3 s gives leaving null with "no answer within 3 seconds" at 3 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const s = serving({ noStore: true, askMs: 6_000 });
    await enterByHook();
    let answer: unknown = 'pending';
    void leave().then(a => { answer = a; });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(answer).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toEqual({ requestId: 'l-1', data: { leaving: null, why: 'no answer within 3 seconds' } });
    expect(s.db.asks).toBeGreaterThan(0);
  });
});
