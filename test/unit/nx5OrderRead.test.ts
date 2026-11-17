import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NX5 test 1 (sheets/NX5.md decisions 8, 9 and 11): the serving process reads smdb_manager.save_order on its claims
// pool after each serving renewal; a current maintenance order closes the gate with cause 'order' and the order's
// message; a lower generation, 42P01 and 3F000 change nothing; a read error changes nothing and the next renewal
// reads again; a current 'running' order with cause 'order' alone starts the leave; a standby's renewal reads no
// order; the kept read is dropped when the database changes; a kept row's new message reaches a process that already
// answered true. Fails today: the claims store has no order read.

const ctl = vi.hoisted(() => ({
  save: async () => ({ unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 }) as any,
  held: false,
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  saveHeldWrites: () => ctl.save(),
  hasHeldWrites: () => ctl.held,
}));

import { ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { ShardClaims, type ShardClaimsDeps } from '../../src/bot/internalSetup/fleet/shardClaims';
import * as maintenance from '../../src/bot/internalSetup/utils/maintenance';
import { isMaintenanceGateClosed, maintenanceCause, maintenanceText } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { ME, MESSAGE, OrderStore, order, pgError, settle } from '../helpers/nx5Rig';

const m = maintenance as any;
const T = claimTimings(30);
const sent: any[] = [];

beforeEach(() => {
  sent.length = 0;
  ctl.held = false;
  ctl.save = async () => ({ unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 });
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

function attach(store: OrderStore) {
  m.attachSaveOrderSource?.({ me: ME, read: () => store.readSaveOrder(), writeAck: (ack: any) => store.writeSaveAck(ack) });
}

// ---------------------------------------------------------------------------------------------------------------
// The real claims store's order read: one statement, mapped by decision 8.
// ---------------------------------------------------------------------------------------------------------------

function poolAnswering(answer: () => { rows: any[] } | Error) {
  const sent: string[] = [];
  const pool = {
    async connect() {
      return {
        query(config: any) {
          const text = typeof config === 'string' ? config : config.text;
          sent.push(text);
          const a = answer();
          return a instanceof Error ? Promise.reject(a) : Promise.resolve({ rows: a.rows, rowCount: a.rows.length });
        },
        release() { /* kept */ },
      };
    },
    async end() { /* nothing open */ },
    on() { return pool; },
  };
  return { pool, sent };
}

function storeWith(pool: object): ClaimStore {
  const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T, () => undefined);
  void (store as any).pool.end().catch(() => undefined);
  (store as any).pool = pool;
  return store;
}

describe('test 1: the claims store reads the save order', () => {
  it('reads order_id, state, message and whether its generation is the database\'s, in one statement on smdb_manager.save_order', async () => {
    const { pool, sent: texts } = poolAnswering(() => ({ rows: [{ order_id: 'o-9', state: 'maintenance', message: MESSAGE, current: true }] }));
    const store = storeWith(pool) as any;
    expect(await store.readSaveOrder()).toEqual({ orderId: 'o-9', state: 'maintenance', message: MESSAGE, current: true });
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/FROM smdb_manager\.save_order/);
    expect(texts[0]).toMatch(/coalesce\(\(SELECT generation FROM smdb_manager\.generation\), 0\)/i);
  });

  it('a row of a lower generation reads current false', async () => {
    const { pool } = poolAnswering(() => ({ rows: [{ order_id: 'o-9', state: 'maintenance', message: MESSAGE, current: false }] }));
    expect(await (storeWith(pool) as any).readSaveOrder()).toEqual({ orderId: 'o-9', state: 'maintenance', message: MESSAGE, current: false });
  });

  it.each([
    ['no row', () => ({ rows: [] })],
    ['42P01 (no table, an older manager)', () => pgError('42P01')],
    ['3F000 (no schema)', () => pgError('3F000')],
  ])('%s answers no order', async (_what, answer) => {
    const { pool } = poolAnswering(answer as () => { rows: any[] } | Error);
    expect(await (storeWith(pool) as any).readSaveOrder()).toBeNull();
  });

  it('any other failure (42501, a lost grant) rejects, so the caller changes nothing', async () => {
    const { pool } = poolAnswering(() => pgError('42501', 'permission denied for table save_order'));
    await expect((storeWith(pool) as any).readSaveOrder()).rejects.toMatchObject({ code: '42501' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The serving renewal: one order read after each renewal that succeeded.
// ---------------------------------------------------------------------------------------------------------------

function claimsRig(store: OrderStore, over: Partial<ShardClaimsDeps> = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  const reads: unknown[] = [];
  const claims = new ShardClaims({
    store, me: ME, timings: T, capacity: 4, takeoverSeconds: 30, returns: true, restartable: true, startedAt: 0,
    clocks: () => ({ perf: performance.now(), wall: Date.now() }),
    fitness: () => null,
    gateClosed: () => isMaintenanceGateClosed(),
    isStopping: () => false,
    stopServingStep: () => undefined,
    noteLapsed: () => undefined,
    noteLost: () => undefined,
    restartForShards: () => true,
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onSaveOrder: (read: unknown) => { reads.push(read); },
    ...over,
  } as ShardClaimsDeps);
  return { claims, reads };
}

describe('test 1: the order read after each serving renewal', () => {
  it('each renewal that succeeded is followed by one order read, whose answer goes to onSaveOrder', async () => {
    const store = new OrderStore(() => Date.now());
    store.saveOrder = order();
    const { claims, reads } = claimsRig(store);
    claims.start();
    expect(await claims.firstRenewal()).toBe(true);
    await settle();
    expect(store.orderReads).toBe(1);
    expect(reads).toEqual([order()]);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    await settle();
    expect(store.orderReads).toBe(2);
    expect(reads).toEqual([order(), order()]);
    void claims.stopLanes();
  });

  it('a read error changes nothing (no answer goes on) and the next renewal reads again', async () => {
    const store = new OrderStore(() => Date.now());
    store.saveOrder = pgError('57014', 'canceling statement due to statement timeout');
    const { claims, reads } = claimsRig(store);
    claims.start();
    await claims.firstRenewal();
    await settle();
    expect(store.orderReads).toBe(1);
    expect(reads).toEqual([]);
    store.saveOrder = order();
    await vi.advanceTimersByTimeAsync(T.renewMs);
    await settle();
    expect(store.orderReads).toBe(2);
    expect(reads).toEqual([order()]);
    void claims.stopLanes();
  });

  it('a renewal that fails after a read sends no read and turns the kept read unknown', async () => {
    const store = new OrderStore(() => Date.now());
    store.saveOrder = order();
    const { claims, reads } = claimsRig(store);
    claims.start();
    await claims.firstRenewal();
    await settle();
    store.renewMode = new Error('read ECONNRESET');
    await vi.advanceTimersByTimeAsync(T.renewMs);
    await settle();
    expect(store.orderReads).toBe(1);
    expect(reads).toEqual([order(), 'unknown']);
    void claims.stopLanes();
  });

  it('a standby\'s renewal runs no order read', async () => {
    const store = new OrderStore(() => Date.now());
    store.saveOrder = order();
    const { claims, reads } = claimsRig(store, { standby: { attempt: 'r-1', count: 4, onEnd: () => undefined } });
    claims.start();
    await vi.advanceTimersByTimeAsync(T.renewMs * 3);
    await settle();
    expect((store as any).standbyRenewals.length).toBeGreaterThan(0);
    expect(store.orderReads).toBe(0);
    expect(reads).toEqual([]);
    void claims.stopLanes();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// What the bot process does with each read.
// ---------------------------------------------------------------------------------------------------------------

describe('test 1: a read of the order in the bot process', () => {
  it('a current maintenance order closes the gate with cause order and the order\'s message', async () => {
    const store = new OrderStore();
    attach(store);
    m.noteSaveOrder?.(order());
    await settle();
    expect(isMaintenanceGateClosed()).toBe(true);
    expect(maintenanceCause()).toBe('order');
    expect(maintenanceText()).toBe(MESSAGE);
  });

  it.each([
    ['an order of a lower generation', order({ current: false })],
    ['no order (no row, 42P01, 3F000)', null],
    ['a current running order', order({ state: 'running' })],
  ])('%s on a serving process changes nothing', async (_what, read) => {
    const store = new OrderStore();
    attach(store);
    m.noteSaveOrder?.(read);
    await settle();
    expect(isMaintenanceGateClosed()).toBe(false);
    expect(store.acks).toEqual([]);
    expect(restarts()).toEqual([]);
  });

  it('a current running order while the gate\'s cause is order alone starts the leave', async () => {
    const store = new OrderStore();
    attach(store);
    m.noteSaveOrder?.(order());
    await settle();
    expect(maintenanceCause()).toBe('order');
    m.noteSaveOrder?.(order({ state: 'running' }));
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
  });

  it.each([
    ['a void order (a raised generation)', order({ current: false })],
    ['a missing order', null],
  ])('%s while the gate\'s cause is order alone starts the leave', async (_what, read) => {
    const store = new OrderStore();
    attach(store);
    m.noteSaveOrder?.(order());
    await settle();
    m.noteSaveOrder?.(read);
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
  });

  it('the kept read is dropped when the database changes: the old database\'s order no longer holds the process', async () => {
    const store = new OrderStore();
    attach(store);
    m.noteSaveOrder?.(order());
    await settle();
    expect(m.maintenanceStillDue?.()).toBe(true);
    m.dropSaveOrderRead?.();
    expect(m.maintenanceStillDue?.()).toBe(false);
  });

  it('a kept row whose message changed sets the gate\'s message on a process that already answered true', async () => {
    const store = new OrderStore();
    attach(store);
    m.noteSaveOrder?.(order());
    await vi.waitFor(() => expect(store.acks.map(a => a.saved)).toEqual([true]));
    m.noteSaveOrder?.(order({ message: 'Back at noon, the move took longer.' }));
    await settle();
    expect(maintenanceText()).toBe('Back at noon, the move took longer.');
    expect(maintenanceCause()).toBe('order');
  });
});
