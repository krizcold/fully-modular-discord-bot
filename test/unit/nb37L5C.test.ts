import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB37 L5 survivors, group C (maintenance.ts 420 to 519): the hook's leave (read, decide, answer) in a serving process
// and in a maintenance boot, and the boot pass's choice of contract 3's entry.

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  saveHeldWrites: async () => ({ unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 }),
  hasHeldWrites: () => false,
}));
vi.mock('../../src/bot/internalSetup/utils/pgClient', async orig => ({
  ...(await orig<any>()),
  shortLivedClient: (config: any) => (globalThis as any).__nb37cSession(config),
}));

import * as maintenance from '../../src/bot/internalSetup/utils/maintenance';
import { connectCause } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { setBackendKind } from '../helpers/backendKind';
import { ME, MESSAGE, OrderStore, entry, fakeSession, order, orderRow, pgError, settle, world } from '../helpers/nx5Rig';

const failing = new Map<string, Error>();
(globalThis as any).__nb37cSession = (config: any) => {
  const error = failing.get(String(config.host));
  if (!error) return fakeSession(config);
  return {
    on() { return this; },
    async connect() { throw error; },
    async query() { return { rows: [] }; },
    async end() { return undefined; },
  };
};

const m = maintenance as any;
type Db = 'answers' | 'refused' | 'unreachable';
const sent: any[] = [];
const restarts = () => sent.filter(s => s.type === 'control:restart-bot');
const lines = (level: 'log' | 'warn') => (console[level] as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => String(c[0]));

afterEach(() => {
  m.attachSaveOrderSource?.(null);
  maintenance._resetMaintenance();
  maintenance._setMaintenanceSender(null);
  setBackendKind(null);
  failing.clear();
  world.clear();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('serving process: the hook\'s leave', () => {
  beforeEach(() => {
    sent.length = 0;
    maintenance._setMaintenanceSender(message => { sent.push(message); });
    maintenance._setMaintenanceTiming({ filePollMs: 40, leaveRetryMs: 40 });
    maintenance.markDiscordStarted();
    writeMaintenanceFile('running', 'The last message.');
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  });

  function serving(opts: { noStore?: boolean } = {}) {
    const db = { answer: 'answers' as Db, asks: 0 };
    const backend = {
      onLoginRefused: (_cb: () => void) => undefined,
      askDatabase: async (): Promise<Db> => { db.asks += 1; return db.answer; },
    };
    const watcher = maintenance.watchDataBackend(backend, { retryMs: 3_600_000 })!;
    const store = new OrderStore();
    if (!opts.noStore) m.attachSaveOrderSource({ me: ME, read: () => store.readSaveOrder(), writeAck: (ack: any) => store.writeSaveAck(ack) });
    const probe = async (answer: Db) => {
      db.answer = answer;
      await watcher.probeNow();
      await settle();
    };
    return { db, store, probe };
  }
  const leave = () => maintenance.handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'l-1', data: {} });
  const enterByHook = () => maintenance.handleMaintenanceIpc({ type: 'maintenance:enter', requestId: 'e-1', data: { message: 'From the hook.' } });
  const quiet = () => new Promise<void>(resolve => { setTimeout(resolve, 300); });

  it('a 28000 on the leave\'s order read keeps the refused login as the hold: the login accepted again does not leave until a fresh order read', async () => {
    const s = serving();
    await enterByHook();
    s.store.saveOrder = pgError('28000', 'password authentication failed for user "bot"');
    expect(await leave()).toEqual({ requestId: 'l-1', data: { leaving: false, heldBy: 'login' } });
    await s.probe('answers');
    await quiet();
    expect(restarts()).toEqual([]);
    m.noteSaveOrder(null);
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
  });

  it('with no order source, askDatabase answering refused gives leaving false with heldBy login', async () => {
    const s = serving({ noStore: true });
    await enterByHook();
    s.db.answer = 'refused';
    expect(await leave()).toEqual({ requestId: 'l-1', data: { leaving: false, heldBy: 'login' } });
    await quiet();
    expect(restarts()).toEqual([]);
  });

  it('a leave asked while the leave runs answers leaving true without reading again', async () => {
    const s = serving();
    await enterByHook();
    s.store.saveOrder = order({ state: 'running' });
    expect(await leave()).toEqual({ requestId: 'l-1', data: { leaving: true } });
    const reads = s.store.orderReads;
    expect(await leave()).toEqual({ requestId: 'l-1', data: { leaving: true } });
    expect(s.store.orderReads).toBe(reads);
  });

  it('a leave that started during the read answers leaving true even when the read finds a current order', async () => {
    const s = serving();
    await enterByHook();
    s.store.saveOrder = order();
    s.store.orderDelayMs = 150;
    const answer = leave();
    await new Promise<void>(resolve => { setTimeout(resolve, 30); });
    maintenance.startLeave('A test leave');
    expect(await answer).toEqual({ requestId: 'l-1', data: { leaving: true } });
  });

  it('a read that answered clears the owed read: the file saying running afterwards leaves, and the hold was logged with the file\'s words', async () => {
    const s = serving({ noStore: true });
    await enterByHook();
    writeMaintenanceFile('maintenance', 'm');
    s.db.answer = 'answers';
    expect(await leave()).toEqual({ requestId: 'l-1', data: { leaving: false, heldBy: 'file' } });
    expect(lines('log')).toContain('[Maintenance] The hook says running, but maintenance.json still says maintenance; the bot stays in maintenance');
    writeMaintenanceFile('running', 'm');
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
  });

  it('heldBy order is logged with its words', async () => {
    const s = serving();
    await enterByHook();
    s.store.saveOrder = order();
    expect(await leave()).toEqual({ requestId: 'l-1', data: { leaving: false, heldBy: 'order' } });
    expect(lines('log')).toContain('[Maintenance] The hook says running, but the main database holds a maintenance order; the bot stays in maintenance');
  });

  it('heldBy login is logged with its words', async () => {
    const s = serving();
    await enterByHook();
    s.store.saveOrder = pgError('28000', 'password authentication failed for user "bot"');
    expect(await leave()).toEqual({ requestId: 'l-1', data: { leaving: false, heldBy: 'login' } });
    expect(lines('log')).toContain('[Maintenance] The hook says running, but the main database refuses the login; the bot stays in maintenance');
  });

  it('a read that fails is logged with its cause', async () => {
    const s = serving({ noStore: true });
    await enterByHook();
    s.db.answer = 'unreachable';
    expect(await leave()).toEqual({ requestId: 'l-1', data: { leaving: null, why: 'the database did not answer' } });
    expect(lines('warn')).toContain('[Maintenance] The hook says running, but the bot could not read the main database (the database did not answer); it stays in maintenance until a read shows nothing holds it');
  });
});

describe('maintenance boot: the hook\'s leave reads one pass', () => {
  const MAIN = 'db-main';
  const COPY = 'db-copy';
  const refusedConnect = () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:5432'), { code: 'ECONNREFUSED' });

  beforeEach(() => {
    sent.length = 0;
    setBackendKind('postgres');
    vi.stubEnv('DATA_BACKEND_URL', `${entry(MAIN)}, ${entry(COPY)}`);
    maintenance._setMaintenanceSender(message => { sent.push(message); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  });

  async function boot(cause: 'hook' | 'order'): Promise<void> {
    await maintenance.runMaintenanceBoot({ cause, message: MESSAGE } as any, { shardRecord: () => null, login: async () => undefined, retryMs: 5_000 });
    await settle();
  }
  async function leave(): Promise<unknown> {
    let answer: unknown = 'pending';
    void maintenance.handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'l-b', data: {} }).then(a => { answer = a; });
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    return answer;
  }
  /** Clears the boot's held order with one poll that reads no order, the file holding the boot meanwhile. */
  async function clearedOrderBoot(): Promise<void> {
    writeMaintenanceFile('maintenance', MESSAGE);
    world.set(MAIN, { generation: 2, order: null });
    world.set(COPY, { generation: 2, rec: true, order: null });
    await boot('order');
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(restarts()).toEqual([]);
    writeMaintenanceFile('running', MESSAGE);
  }

  it('an order read that fails on the writable entry answers leaving null with that read\'s cause', async () => {
    const failed = pgError('57014', 'canceling statement due to statement timeout');
    writeMaintenanceFile('running', MESSAGE);
    world.set(MAIN, { generation: 2, order: failed });
    world.set(COPY, { generation: 2, rec: true, order: null });
    await boot('order');
    const why = connectCause(failed);
    expect(why).not.toBe('no answer within 3 seconds');
    expect(await leave()).toEqual({ requestId: 'l-b', data: { leaving: null, why } });
  });

  it('a file-backend bot reads no database: the boot\'s held order answers heldBy order', async () => {
    writeMaintenanceFile('running', MESSAGE);
    world.set(MAIN, { generation: 2, order: orderRow({ state: 'running' }) });
    world.set(COPY, { generation: 2, rec: true, order: null });
    await boot('order');
    setBackendKind('file');
    expect(await leave()).toEqual({ requestId: 'l-b', data: { leaving: false, heldBy: 'order' } });
  });

  it('a Postgres bot with no address list reads no database: the boot\'s held order answers heldBy order', async () => {
    vi.stubEnv('DATA_BACKEND_URL', '');
    writeMaintenanceFile('running', MESSAGE);
    await boot('order');
    expect(await leave()).toEqual({ requestId: 'l-b', data: { leaving: false, heldBy: 'order' } });
  });

  it('cause order, nothing held, no database answers: leaving null with the first failed entry\'s cause', async () => {
    await clearedOrderBoot();
    failing.set(MAIN, refusedConnect());
    failing.set(COPY, refusedConnect());
    expect(await leave()).toEqual({ requestId: 'l-b', data: { leaving: null, why: connectCause(refusedConnect()) } });
    expect(connectCause(refusedConnect())).not.toBe('no database that accepts writes answered');
  });

  it('cause order, the held order kept, an entry in recovery answers before the failed one: why is the failed entry\'s cause', async () => {
    writeMaintenanceFile('running', MESSAGE);
    world.set(MAIN, { generation: 2, rec: true, order: null });
    failing.set(COPY, refusedConnect());
    await boot('order');
    expect(await leave()).toEqual({ requestId: 'l-b', data: { leaving: null, why: connectCause(refusedConnect()) } });
  });

  it('cause order, nothing held, only entries in recovery answer: the login is accepted and the boot leaves', async () => {
    await clearedOrderBoot();
    world.set(MAIN, { generation: 2, rec: true, order: null });
    world.set(COPY, { generation: 2, rec: true, order: null });
    expect(await leave()).toEqual({ requestId: 'l-b', data: { leaving: true } });
  });
});

describe('the boot pass takes the writable entry of the highest generation', () => {
  beforeEach(() => {
    setBackendKind('postgres');
    vi.stubEnv('DATA_BACKEND_URL', `${entry('db-a')}, ${entry('db-b')}`);
    writeMaintenanceFile('running', MESSAGE);
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  });

  it.each<[string, number, number]>([
    ['the later entry is newer', 1, 2],
    ['the first entry is newer', 2, 1],
  ])('%s: the newer one\'s current order boots in maintenance with cause order', async (_name, genA, genB) => {
    world.set('db-a', { generation: genA, order: genA > genB ? orderRow() : null });
    world.set('db-b', { generation: genB, order: genB > genA ? orderRow() : null });
    expect(await maintenance.decideBoot()).toEqual({ mode: 'maintenance', cause: 'order', message: MESSAGE });
  });
});
