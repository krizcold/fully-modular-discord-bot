import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB37's mutation gate, writer A: maintenance.ts lines 1 to 329 and 520 to 799 (sheets/NX5.md section 7, tests 3, 4
// and 9). The serving rows come first; the maintenance boot marks this process for good, so its rows are last.

const ctl = vi.hoisted(() => ({
  left: [] as any[],
  work: [] as string[],
  workUntil: null as number | null,
}));
const ZERO = { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 };
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  saveHeldWrites: async () => ctl.left.shift() ?? { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 },
  hasHeldWrites: () => false,
  openWorkElsewhere: () => (ctl.workUntil !== null ? (Date.now() < ctl.workUntil ? ctl.work : []) : ctl.work),
}));
vi.mock('../../src/bot/internalSetup/utils/pgClient', async orig => ({
  ...(await orig<any>()),
  shortLivedClient: (config: any) => (globalThis as any).__nb37aSession(config),
}));

import * as maintenance from '../../src/bot/internalSetup/utils/maintenance';
import { maintenanceCause, orderRefusesSharedOps, runAcceptedOp, runTracked } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { setBackendKind } from '../helpers/backendKind';
import { ME, MESSAGE, OrderStore, entry, fakeSession, order, pgError, settle, world } from '../helpers/nx5Rig';

(globalThis as any).__nb37aSession = fakeSession;
const sent: any[] = [];
const POLL_MS = 4321;

beforeEach(() => {
  sent.length = 0;
  ctl.left = [];
  ctl.work = [];
  ctl.workUntil = null;
  maintenance._setMaintenanceSender(message => { sent.push(message); });
  maintenance._setMaintenanceTiming({ filePollMs: 40, leaveRetryMs: 40 });
  maintenance.markDiscordStarted();
  writeMaintenanceFile('running', 'The last message.');
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  maintenance.attachSaveOrderSource(null);
  maintenance._resetMaintenance();
  maintenance._setMaintenanceSender(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const restarts = () => sent.filter(s => s.type === 'control:restart-bot');
const modes = () => sent.filter(s => s.type === 'maintenance:mode').map(s => s.data.mode);
const leave = () => maintenance.handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'l-1', data: {} });
const enterByHook = () => maintenance.handleMaintenanceIpc({ type: 'maintenance:enter', requestId: 'e-1', data: { message: 'From the hook.' } });
const quiet = () => new Promise<void>(resolve => { setTimeout(resolve, 300); });

function withStore() {
  const store = new OrderStore();
  maintenance.attachSaveOrderSource({ me: ME, read: () => store.readSaveOrder(), writeAck: ack => store.writeSaveAck(ack) });
  return store;
}

describe('the file poll (maintenance.ts:251-260)', () => {
  const pollsStarted = (spy: { mock: { calls: any[][] } }) => spy.mock.calls.filter(call => call[1] === POLL_MS).length;

  it('a second hook enter while the gate is closed starts no second poll', async () => {
    maintenance._setMaintenanceTiming({ filePollMs: POLL_MS });
    writeMaintenanceFile('maintenance', 'm');
    const spy = vi.spyOn(globalThis, 'setInterval');
    await enterByHook();
    await enterByHook();
    expect(pollsStarted(spy)).toBe(1);
  });

  it('a hook enter during the leave step starts no poll', async () => {
    maintenance._setMaintenanceTiming({ filePollMs: POLL_MS });
    writeMaintenanceFile('maintenance', 'm');
    const spy = vi.spyOn(globalThis, 'setInterval');
    maintenance.startLeave('The hook says running');
    await enterByHook();
    expect(pollsStarted(spy)).toBe(0);
  });

  it('with the gate\'s cause turned to order and the order read dropped, maintenance.json saying running leaves', async () => {
    withStore();
    writeMaintenanceFile('maintenance', 'm');
    await enterByHook();
    maintenance.noteSaveOrder(order());
    await vi.waitFor(() => expect(maintenanceCause()).toBe('order'));
    await settle();
    maintenance.dropSaveOrderRead();
    await quiet();
    expect(restarts()).toEqual([]);
    writeMaintenanceFile('running', 'm');
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
  });
});

describe('the mode the leave step reports once nothing is held (maintenance.ts:265-269)', () => {
  it('after the claims lapsed, a leave held by changes then left only with running work reports outage again', async () => {
    maintenance._setMaintenanceTiming({ heldAfterPasses: 1 });
    ctl.left = [{ ...ZERO, unsavedGuilds: 1 }];
    ctl.work = ['premium: 1 member notice(s)'];
    maintenance.noteClaimsLapsed(30);
    maintenance.startLeave('The shard claims lapsed (no renewal for 30 s) and the database answers');
    await vi.waitFor(() => expect(modes()).toEqual(['outage', 'held', 'outage']));
    ctl.work = [];
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
    expect(modes()).toEqual(['outage', 'held', 'outage']);
  });
});

describe('heldByNow with the order read unknown (maintenance.ts:291-297)', () => {
  it('the hook\'s leave whose order read is refused (28000) after a current order was read is held by the order', async () => {
    const store = withStore();
    maintenance.noteSaveOrder(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    store.saveOrder = pgError('28000');
    expect(await leave()).toEqual({ requestId: 'l-1', data: { leaving: false, heldBy: 'order' } });
    expect(console.log).toHaveBeenCalledWith('[Maintenance] The hook says running, but the main database holds a maintenance order; the bot stays in maintenance');
  });
});

describe('attachSaveOrderSource (maintenance.ts:314-321)', () => {
  it('detaching the source drops the kept order read and the order\'s refusal of shared ops', async () => {
    withStore();
    maintenance.noteSaveOrder(order());
    await settle();
    expect(orderRefusesSharedOps()).toBe(true);
    expect(maintenance.maintenanceStillDue()).toBe(true);
    maintenance.attachSaveOrderSource(null);
    expect(orderRefusesSharedOps()).toBe(false);
    expect(maintenance.maintenanceStillDue()).toBe(false);
  });

  it('attaching another source keeps the kept order read and the refusal', async () => {
    withStore();
    maintenance.noteSaveOrder(order());
    await settle();
    withStore();
    expect(orderRefusesSharedOps()).toBe(true);
    expect(maintenance.maintenanceStillDue()).toBe(true);
  });
});

describe('saveForAnswer: the wait and the running work in words (maintenance.ts:612-645)', () => {
  async function withOp<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const op = runAcceptedOp(() => new Promise<void>(resolve => { release = resolve; }));
    try {
      return await work();
    } finally {
      release();
      await op;
    }
  }

  it('one accepted op still running is named in the answer', async () => {
    const answer = await withOp(() => maintenance.enterMaintenance('m', { handlerWaitMs: 0 }));
    expect(answer).toEqual({ saved: null, unansweredGuilds: 0, unconfirmedFiles: 0, running: '1 operation(s) this process accepted' });
  });

  it('an accepted op and a subsystem\'s open work are joined by "; "', async () => {
    ctl.work = ['premium: 2 member notice(s)'];
    const answer = await withOp(() => maintenance.enterMaintenance('m', { handlerWaitMs: 0 }));
    expect(answer).toEqual({ saved: null, unansweredGuilds: 0, unconfirmedFiles: 0, running: '1 operation(s) this process accepted; premium: 2 member notice(s)' });
  });

  it('the held clauses and the running work are joined by "; " in the log line', async () => {
    ctl.work = ['premium: 2 member notice(s)'];
    ctl.left = [{ ...ZERO, unansweredGuilds: 1 }];
    const answer = await maintenance.enterMaintenance('m', { handlerWaitMs: 0 });
    expect(answer).toEqual({ saved: null, unansweredGuilds: 1, unconfirmedFiles: 0, running: 'premium: 2 member notice(s)' });
    expect(console.warn).toHaveBeenCalledWith('[Maintenance] 1 guild(s) hold a save the database did not answer, which may have landed; still running and may save changes: premium: 2 member notice(s); can\'t confirm whether every change this process held is saved');
  });

  it('a handler in flight with no other work is waited for, so no handler is reported still running', async () => {
    const handler = runTracked(() => new Promise<void>(resolve => { setTimeout(resolve, 60); }));
    const answer = await maintenance.enterMaintenance('m', { handlerWaitMs: 5_000 });
    await handler;
    expect(answer).toEqual({ saved: true });
    expect(console.warn).not.toHaveBeenCalledWith('[Maintenance] 1 handler(s) still run; any write they make from now on is refused');
  });

  it('a handler that outlasts the wait is reported', async () => {
    let release!: () => void;
    const handler = runTracked(() => new Promise<void>(resolve => { release = resolve; }));
    await maintenance.enterMaintenance('m', { handlerWaitMs: 40 });
    release();
    await handler;
    expect(console.warn).toHaveBeenCalledWith('[Maintenance] 1 handler(s) still run; any write they make from now on is refused');
  });

  it('with nothing in flight the answer comes without waiting on any timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let answer: unknown = 'none';
    void maintenance.enterMaintenance('m').then(a => { answer = a; });
    await settle(50);
    expect(answer).toEqual({ saved: true });
  });

  it('the wait ends when its bound is reached exactly, with the work still running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    ctl.work = ['premium: 1 member notice(s)'];
    ctl.workUntil = Date.now() + 50;
    let answer: unknown = 'none';
    void maintenance.enterMaintenance('m', { handlerWaitMs: 40 }).then(a => { answer = a; });
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(answer).toEqual({ saved: null, unansweredGuilds: 0, unconfirmedFiles: 0, running: 'premium: 1 member notice(s)' });
  });
});

// Last: runMaintenanceBoot marks this process as a maintenance boot for the rest of the file.
describe('the maintenance boot\'s hook leave and applyPassRead (maintenance.ts:502-531)', () => {
  const MAIN = 'db-main';
  const COPY = 'db-copy';

  beforeEach(() => {
    world.clear();
    setBackendKind('postgres');
    vi.stubEnv('DATA_BACKEND_URL', `${entry(MAIN)}, ${entry(COPY)}`);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    setBackendKind(null);
    vi.unstubAllEnvs();
  });

  async function boot(cause: 'hook' | 'order'): Promise<void> {
    await maintenance.runMaintenanceBoot({ cause, message: MESSAGE }, { shardRecord: () => null, login: async () => undefined, retryMs: 5_000 });
    await settle();
  }
  async function leaveNow() {
    const reply = leave();
    await vi.advanceTimersByTimeAsync(4_000);
    return reply;
  }

  it('a boot of cause order whose leave pass finds no writable entry answers that no database that accepts writes answered', async () => {
    world.set(MAIN, { generation: 2, rec: true, order: null });
    world.set(COPY, { generation: 2, rec: true, order: null });
    await boot('order');
    expect(await leaveNow()).toEqual({ requestId: 'l-1', data: { leaving: null, why: 'no database that accepts writes answered' } });
  });

  it('an order read kept unknown while the file held is dropped by a pass that answered with no writable entry, and the hook\'s leave leaves', async () => {
    writeMaintenanceFile('maintenance', MESSAGE);
    world.set(MAIN, { generation: 2, order: new Error('the save order read failed') });
    world.set(COPY, { generation: 2, rec: true, order: null });
    await boot('hook');
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(maintenance.maintenanceStillDue()).toBe(true);
    writeMaintenanceFile('running', MESSAGE);
    world.set(MAIN, { generation: 2, rec: true, order: null });
    expect(await leaveNow()).toEqual({ requestId: 'l-1', data: { leaving: true } });
  });
});
