import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NX5 test 3 (sheets/NX5.md decision 11, rulings G4 and L1), the maintenance boot's rows: one poll for every cause asks
// the predicate (file, login and order on contract 3's entry), and the hook's leave runs one probe pass bounded at 3 s
// that ends at the first writable entry's answer. A maintenance boot marks this process for good, so these rows have
// their own file beside nx5LeavePredicate.test.ts. The login and order rows fail today (runMaintenanceBoot's file poll
// leaves on the file alone, maintenance.ts:216-224, 758; the hook's leave reads nothing, 331-333).

vi.mock('../../src/bot/internalSetup/utils/pgClient', async orig => ({
  ...(await orig<any>()),
  shortLivedClient: (config: any) => (globalThis as any).__nx5Session(config),
}));

import * as maintenance from '../../src/bot/internalSetup/utils/maintenance';
import { maintenanceCause, orderRefusesSharedOps } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { setBackendKind } from '../helpers/backendKind';
import { MESSAGE, entry, fakeSession, orderRow, sessionLog, settle, world } from '../helpers/nx5Rig';

(globalThis as any).__nx5Session = fakeSession;
const MAIN = 'db-main';
const COPY = 'db-copy';
const sent: any[] = [];

beforeEach(() => {
  world.clear();
  sessionLog.length = 0;
  sent.length = 0;
  setBackendKind('postgres');
  vi.stubEnv('DATA_BACKEND_URL', `${entry(MAIN)}, ${entry(COPY)}`);
  maintenance._setMaintenanceSender(message => { sent.push(message); });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  maintenance._resetMaintenance();
  maintenance._setMaintenanceSender(null);
  setBackendKind(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const restarts = () => sent.filter(s => s.type === 'control:restart-bot');

async function boot(cause: 'hook' | 'login-refused' | 'order'): Promise<void> {
  await maintenance.runMaintenanceBoot({ cause, message: MESSAGE } as any, { shardRecord: () => null, login: async () => undefined });
  await settle();
}
const poll = async (times = 1) => {
  for (let i = 0; i < times; i++) await vi.advanceTimersByTimeAsync(5_000);
  await settle();
};

describe('test 3: the maintenance boot\'s poll asks the predicate', () => {
  it.each<['none' | 'file' | 'login' | 'order', boolean]>([
    ['none', true],
    ['file', false],
    ['login', false],
    ['order', false],
  ])('a boot of cause hook with %s holding leaves: %s', async (source, leaves) => {
    writeMaintenanceFile('maintenance', MESSAGE);
    world.set(MAIN, source === 'login' ? { refuse: true } : { generation: 2, order: source === 'order' ? orderRow() : null });
    world.set(COPY, source === 'login' ? { refuse: true } : { generation: 2, rec: true, order: null });
    await boot('hook');
    writeMaintenanceFile(source === 'file' ? 'maintenance' : 'running', MESSAGE);
    await poll(3);
    expect(restarts()).toHaveLength(leaves ? 1 : 0);
  });

  it('watchLogin\'s case: the login accepted while the order says maintenance keeps polling, and the boot leaves after the row says running', async () => {
    writeMaintenanceFile('running', MESSAGE);
    world.set(MAIN, { generation: 2, order: orderRow() });
    world.set(COPY, { generation: 2, rec: true, order: null });
    await boot('login-refused');
    await poll(3);
    expect(restarts()).toEqual([]);
    world.set(MAIN, { generation: 2, order: orderRow({ state: 'running' }) });
    await poll();
    expect(restarts()).toHaveLength(1);
  });
});

describe('test 3: the kept order is decided by the held state, not the gate\'s cause (finding 1 of review round 1)', () => {
  it('a boot of cause order, then a hook enter (cause hook), then a pass whose main refuses the login and whose copy still accepts it: the order holds, shared ops stay refused and the boot does not leave', async () => {
    writeMaintenanceFile('running', MESSAGE);
    world.set(MAIN, { generation: 2, order: orderRow() });
    world.set(COPY, { generation: 2, rec: true, order: null });
    await boot('order');
    expect(await maintenance.handleMaintenanceIpc({ type: 'maintenance:enter', requestId: 'e-1', data: { message: MESSAGE } })).toEqual({ requestId: 'e-1', data: { saved: true } });
    expect(maintenanceCause()).toBe('hook');
    world.set(MAIN, { refuse: true });
    await poll(3);
    expect(orderRefusesSharedOps()).toBe(true);
    expect(restarts()).toEqual([]);
  });
});

describe('ruling G8-13: a pass in which no database answers, by the boot\'s cause', () => {
  it.each<['hook' | 'order', number]>([
    ['hook', 1],
    ['order', 0],
  ])('a boot of cause %s whose hosts never answer, with the file saying running: %i restart(s)', async (cause, restartCount) => {
    writeMaintenanceFile(cause === 'hook' ? 'maintenance' : 'running', MESSAGE);
    world.set(MAIN, { hang: true });
    world.set(COPY, { hang: true });
    await boot(cause);
    writeMaintenanceFile('running', MESSAGE);
    await poll(6);
    expect(restarts()).toHaveLength(restartCount);
  });

  it('the hook\'s leave in a boot of cause hook whose hosts never answer leaves on the file', async () => {
    writeMaintenanceFile('maintenance', MESSAGE);
    world.set(MAIN, { hang: true });
    world.set(COPY, { hang: true });
    await boot('hook');
    writeMaintenanceFile('running', MESSAGE);
    let answer: unknown = 'pending';
    void maintenance.handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'l-h', data: {} }).then(a => { answer = a; });
    await vi.advanceTimersByTimeAsync(3_100);
    await settle();
    expect(answer).toEqual({ requestId: 'l-h', data: { leaving: true } });
  });
});

describe('test 3 (L1): the hook\'s leave in a maintenance boot reads one pass bounded at 3 s', () => {
  it('with the main and a copy whose host does not answer (its connect would wait 5 s), the pass ends at the main\'s answer and the boot leaves at once', async () => {
    writeMaintenanceFile('running', MESSAGE);
    world.set(MAIN, { generation: 2, order: orderRow({ state: 'running' }) });
    world.set(COPY, { connectMs: 5_000, generation: 2, rec: true, order: null });
    await boot('order');
    let answer: unknown = 'pending';
    void maintenance.handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'l-1', data: {} }).then(a => { answer = a; });
    await vi.advanceTimersByTimeAsync(100);
    expect(sessionLog.some(s => s.host === MAIN && /smdb_manager\.save_order/.test(s.text))).toBe(true);
    expect(answer).toEqual({ requestId: 'l-1', data: { leaving: true } });
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(restarts()).toHaveLength(1);
  });

  it('one whose only writable entry is slower than 3 s answers leaving null at 3 s', async () => {
    writeMaintenanceFile('running', MESSAGE);
    world.set(MAIN, { connectMs: 4_000, generation: 2, order: null });
    world.set(COPY, { generation: 2, rec: true, order: null });
    await boot('order');
    let answer: unknown = 'pending';
    void maintenance.handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'l-2', data: {} }).then(a => { answer = a; });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(answer).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toEqual({ requestId: 'l-2', data: { leaving: null, why: 'no answer within 3 seconds' } });
    expect(restarts()).toEqual([]);
  });
});
