import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB37 L5 survivors, group B: noteSaveOrder and enterForOrder (sheets/NX5.md decisions 8 to 11) and the leave read's
// bound, driven through the exported order read, the hook's IPC and the answer the claims store records.

type Left = { unsavedGuilds: number; unsavedFiles: number; unansweredGuilds: number; unconfirmedFiles: number; unansweredFiles?: number; resaveGuilds?: number };
const ZERO: Left = { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 };
const ctl = vi.hoisted(() => ({
  saves: 0,
  save: null as null | (() => Promise<any>),
  held: false,
  boot: false,
  flushes: 0,
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  saveHeldWrites: async () => {
    ctl.saves += 1;
    return ctl.save ? ctl.save() : { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 };
  },
  hasHeldWrites: () => ctl.held,
}));
vi.mock('../../src/bot/internalSetup/utils/maintenanceGate', async orig => ({
  ...(await orig<any>()),
  isMaintenanceBoot: () => ctl.boot,
}));
vi.mock('../../src/bot/internalSetup/utils/metrics/metricsCollector', async orig => ({
  ...(await orig<any>()),
  getMetricsCollector: () => ({ seedTotals: () => undefined, flushTotals: () => { ctl.flushes += 1; } }),
}));

import * as maintenance from '../../src/bot/internalSetup/utils/maintenance';
import { DEFAULT_MAINTENANCE_MESSAGE, maintenanceCause, maintenanceText, orderRefusesSharedOps } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { connectCause } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { ME, MESSAGE, OrderStore, order, settle } from '../helpers/nx5Rig';

let sent: any[] = [];

beforeEach(() => {
  ctl.saves = 0;
  ctl.save = null;
  ctl.held = false;
  ctl.boot = false;
  ctl.flushes = 0;
  sent = [];
  maintenance._setMaintenanceSender(message => { sent.push(message); });
  maintenance.markDiscordStarted();
  writeMaintenanceFile('running', 'The last message.');
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  maintenance.attachSaveOrderSource(null);
  maintenance._resetMaintenance();
  maintenance._setMaintenanceSender(null);
  vi.restoreAllMocks();
});

function attached(store = new OrderStore()): OrderStore {
  maintenance.attachSaveOrderSource({ me: ME, read: () => store.readSaveOrder(), writeAck: ack => store.writeSaveAck(ack) });
  return store;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const logs = () => (console.log as any).mock.calls.map((c: unknown[]) => c[0]);
const warns = () => (console.warn as any).mock.calls.map((c: unknown[]) => c[0]);
const modes = () => sent.filter(s => s.type === 'maintenance:mode').map(s => s.data.mode);
const ANSWERED = '[Maintenance] Answered the maintenance order: ';
const ENTERED = '[Maintenance] The main database holds a maintenance order; entered maintenance and saving what this process holds';
const SAVING = '[Maintenance] The main database holds a maintenance order; saving what this process holds';

describe('noteSaveOrder', () => {
  it('a later read of the answered order with a new message shows the new message, with no new save', async () => {
    const store = attached();
    maintenance.noteSaveOrder(order({ message: DEFAULT_MAINTENANCE_MESSAGE }));
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(maintenanceText()).toBe(DEFAULT_MAINTENANCE_MESSAGE);
    maintenance.noteSaveOrder(order({ message: 'Moving the database at noon.' }));
    await settle();
    expect(maintenanceText()).toBe('Moving the database at noon.');
    expect(ctl.saves).toBe(1);
  });

  it('a process that reads no order ignores an order read: shared ops stay allowed and nothing holds it', async () => {
    maintenance.noteSaveOrder(order());
    await settle();
    expect(orderRefusesSharedOps()).toBe(false);
    expect(maintenance.maintenanceStillDue()).toBe(false);
    expect(maintenanceCause()).toBeNull();
  });

  it('an unknown read keeps what held the process before it: the file that said maintenance still holds after it says running', async () => {
    attached();
    maintenance.noteSaveOrder(null);
    writeMaintenanceFile('maintenance', MESSAGE);
    maintenance.noteSaveOrder('unknown');
    writeMaintenanceFile('running', 'The last message.');
    expect(maintenance.maintenanceStillDue()).toBe(true);
  });

  it('a maintenance boot that reads a current order writes no answer and saves nothing', async () => {
    ctl.boot = true;
    const store = attached();
    maintenance.noteSaveOrder(order());
    await settle();
    expect(store.acks).toEqual([]);
    expect(orderRefusesSharedOps()).toBe(true);
  });

  it('an order that ended starts the leave with its reason in the log line', async () => {
    const store = attached();
    maintenance.noteSaveOrder(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    maintenance.noteSaveOrder(null);
    await settle();
    expect(logs()).toContain('[Maintenance] The main database\'s maintenance order ended; saving what this process holds before it restarts');
  });
});

describe('enterForOrder', () => {
  it('a second read while the first save runs starts no second save', async () => {
    const gate = deferred<Left>();
    ctl.save = () => gate.promise;
    const store = attached();
    maintenance.noteSaveOrder(order());
    await settle();
    maintenance.noteSaveOrder(order());
    await settle();
    expect(ctl.saves).toBe(1);
    gate.resolve(ZERO);
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(ctl.saves).toBe(1);
  });

  it('with the gate open it flushes the totals once, closes the gate for the order, reports maintenance and logs the entry', async () => {
    const store = attached();
    maintenance.noteSaveOrder(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(ctl.flushes).toBe(1);
    expect(maintenanceCause()).toBe('order');
    expect(modes()).toEqual(['maintenance']);
    expect(logs()).toContain(ENTERED);
    expect(logs()).not.toContain(SAVING);
  });

  it('with the gate closed by the hook it takes the order without a flush, a new close or a mode report', async () => {
    const store = attached();
    await maintenance.handleMaintenanceIpc({ type: 'maintenance:enter', requestId: 'h-1', data: { message: 'From the hook.' } });
    expect(ctl.flushes).toBe(1);
    sent = [];
    (console.log as any).mockClear();
    maintenance.noteSaveOrder(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(maintenanceCause()).toBe('order');
    expect(ctl.flushes).toBe(1);
    expect(modes()).toEqual([]);
    expect(logs()).toContain(SAVING);
    expect(logs()).not.toContain(ENTERED);
  });

  it('with the gate closed for a refused login it reports maintenance', async () => {
    const store = attached();
    maintenance.closeMaintenanceGate('login-refused', MESSAGE);
    sent = [];
    maintenance.noteSaveOrder(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(modes()).toEqual(['maintenance']);
    expect(maintenance.maintenanceMode()).toBe('maintenance');
  });

  it('with the gate closed for a refused login and a leave that reports nothing held yet, it reports maintenance', async () => {
    maintenance._setMaintenanceTiming({ heldAfterPasses: 100, leaveRetryMs: 60_000 });
    ctl.save = async () => ({ ...ZERO, unsavedGuilds: 1 });
    const store = attached();
    maintenance.closeMaintenanceGate('login-refused', MESSAGE);
    maintenance.startLeave('A test leave');
    await settle();
    sent = [];
    maintenance.noteSaveOrder(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(modes()).toEqual(['maintenance']);
  });

  it('with the gate closed for a refused login and a leave held by unsaved changes, it stays reported as held', async () => {
    maintenance._setMaintenanceTiming({ heldAfterPasses: 1, leaveRetryMs: 60_000 });
    ctl.save = async () => ({ ...ZERO, unsavedGuilds: 1 });
    const store = attached();
    maintenance.closeMaintenanceGate('login-refused', MESSAGE);
    maintenance.startLeave('A test leave');
    await vi.waitFor(() => expect(modes()).toContain('held'));
    sent = [];
    maintenance.noteSaveOrder(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(modes()).toEqual([]);
    expect(maintenance.maintenanceMode()).toBe('held');
  });

  it('a save that ends after a reset writes no answer', async () => {
    const gate = deferred<Left>();
    ctl.save = () => gate.promise;
    const store = attached();
    maintenance.noteSaveOrder(order());
    await settle();
    maintenance._resetMaintenance();
    gate.resolve(ZERO);
    await settle(50);
    expect(store.acks).toEqual([]);
  });

  it('an answer write that throws is logged with its cause, is not taken as answered, and the next read saves and answers again', async () => {
    const store = attached();
    const failure = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
    let throws = true;
    const write = store.writeSaveAck.bind(store);
    store.writeSaveAck = async ack => {
      if (throws) throw failure;
      return write(ack);
    };
    maintenance.noteSaveOrder(order());
    await vi.waitFor(() => expect(warns()).toContain(`[Maintenance] Could not write the answer to the maintenance order (${connectCause(failure)}); the next read of the order saves and answers again`));
    expect(logs().some((l: string) => l.startsWith(ANSWERED))).toBe(false);
    throws = false;
    maintenance.noteSaveOrder(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(ctl.saves).toBe(2);
  });

  it('an answer write that lands after a reset logs no answer', async () => {
    const store = attached();
    const landed = deferred<boolean>();
    let writes = 0;
    store.writeSaveAck = () => { writes += 1; return landed.promise; };
    maintenance.noteSaveOrder(order());
    await vi.waitFor(() => expect(writes).toBe(1));
    maintenance._resetMaintenance();
    landed.resolve(true);
    await settle(50);
    expect(logs().some((l: string) => l.startsWith(ANSWERED))).toBe(false);
  });

  it('logs the answer it wrote: every change saved', async () => {
    const store = attached();
    maintenance.noteSaveOrder(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    await settle();
    expect(logs()).toContain(`${ANSWERED}every change this process held is saved`);
  });

  it('logs the answer it wrote: some changes not saved', async () => {
    ctl.save = async () => ({ ...ZERO, unsavedGuilds: 2 });
    const store = attached();
    maintenance.noteSaveOrder(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    await settle();
    expect(logs()).toContain(`${ANSWERED}some changes are not saved`);
  });

  it('logs the answer it wrote: can\'t confirm', async () => {
    ctl.save = async () => ({ ...ZERO, unansweredGuilds: 1 });
    const store = attached();
    maintenance.noteSaveOrder(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    await settle();
    expect(logs()).toContain(`${ANSWERED}can't confirm that every change is saved`);
  });

  it('an answer the database did not take is logged as not written, never as answered', async () => {
    const store = attached();
    store.ackLands = false;
    maintenance.noteSaveOrder(order());
    await vi.waitFor(() => expect(warns()).toContain('[Maintenance] The answer to the maintenance order was not written: the order no longer stands at this generation'));
    expect(logs().some((l: string) => l.startsWith(ANSWERED))).toBe(false);
  });

  it('a run cut by a reset does not free the newer run\'s save, so a third read starts no third save', async () => {
    const first = deferred<Left>();
    const second = deferred<Left>();
    const queue = [first.promise, second.promise];
    ctl.save = () => queue.shift() ?? Promise.resolve(ZERO);
    attached();
    maintenance.noteSaveOrder(order());
    await settle();
    maintenance._resetMaintenance();
    maintenance._setMaintenanceSender(message => { sent.push(message); });
    attached();
    maintenance.noteSaveOrder(order());
    await settle();
    expect(ctl.saves).toBe(2);
    first.resolve(ZERO);
    await settle(50);
    maintenance.noteSaveOrder(order());
    await settle();
    expect(ctl.saves).toBe(2);
    second.resolve(ZERO);
  });
});

describe('the leave read\'s 3 s bound', () => {
  it('an order read that answers leaves no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const store = attached();
    store.saveOrder = order();
    const leave = maintenance.handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'l-1', data: {} });
    await settle(100);
    expect(await leave).toEqual({ requestId: 'l-1', data: { leaving: false, heldBy: 'order' } });
    expect(store.acks).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an order read that fails leaves no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const store = attached();
    store.saveOrder = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
    const leave = maintenance.handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'l-1', data: {} });
    await settle(100);
    expect(await leave).toMatchObject({ requestId: 'l-1', data: { leaving: null } });
    expect(vi.getTimerCount()).toBe(0);
  });
});
