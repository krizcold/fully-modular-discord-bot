import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NX5 test 4 (sheets/NX5.md decisions 8 and 11, ruling H1), with section 5's P4 cells. decideBoot and the maintenance
// boot's poll read the order and the login only from contract 3's entry: answered, not in recovery, not read-only, of
// the highest generation. A copy's replayed row or its accepted login counts for nothing; a failed order read never
// makes an entry 'failed'; a pass bound that fires during the order read leaves the entry answered with order
// 'unknown'. The real probePass runs over fake sessions (shortLivedClient is the rig's). A maintenance boot marks this
// process for good, so the decideBoot rows come first. Fails today (maintenance.ts:605-613 read only the file and the
// login; 750-752 and 757 name every other cause a refused login).

vi.mock('../../src/bot/internalSetup/utils/pgClient', async orig => ({
  ...(await orig<any>()),
  shortLivedClient: (config: any) => (globalThis as any).__nx5Session(config),
}));

import * as maintenance from '../../src/bot/internalSetup/utils/maintenance';
import { probePass } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { maintenanceCause } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { parseAddressList } from '../../src/utils/databaseAddress';
import { setBackendKind } from '../helpers/backendKind';
import { MESSAGE, entry, fakeSession, orderRow, pgError, settle, world } from '../helpers/nx5Rig';

(globalThis as any).__nx5Session = fakeSession;
const m = maintenance as any;
const MAIN = 'db-main';
const COPY = 'db-copy';
const sent: any[] = [];
let logs: string[] = [];

beforeEach(() => {
  world.clear();
  sent.length = 0;
  logs = [];
  setBackendKind('postgres');
  vi.stubEnv('DATA_BACKEND_URL', `${entry(MAIN)}, ${entry(COPY)}`);
  writeMaintenanceFile('running', 'The last message.');
  maintenance._setMaintenanceSender(message => { sent.push(message); });
  const capture = (...args: unknown[]) => { logs.push(String(args[0])); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
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
const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

describe('test 4: decideBoot reads the order from contract 3\'s entry', () => {
  it('a pass whose highest-generation writable entry holds a current maintenance order boots in maintenance with cause order and the order\'s message', async () => {
    world.set(MAIN, { generation: 3, order: orderRow() });
    world.set(COPY, { generation: 3, rec: true, order: orderRow() });
    expect(await maintenance.decideBoot()).toEqual({ mode: 'maintenance', cause: 'order', message: MESSAGE });
  });

  it('the same order only on a lower-generation entry boots normal', async () => {
    world.set(MAIN, { generation: 3, order: null });
    world.set(COPY, { generation: 2, order: orderRow() });
    expect(await maintenance.decideBoot()).toEqual({ mode: 'normal' });
  });

  it('an order of a lower generation than its database (current false) boots normal', async () => {
    world.set(MAIN, { generation: 3, order: orderRow({ current: false }) });
    world.set(COPY, { generation: 3, rec: true, order: null });
    expect(await maintenance.decideBoot()).toEqual({ mode: 'normal' });
  });

  it('a copy (in recovery) at the main\'s generation showing a current maintenance row while the main shows running boots normal', async () => {
    world.set(MAIN, { generation: 3, order: orderRow({ state: 'running' }) });
    world.set(COPY, { generation: 3, rec: true, order: orderRow() });
    expect(await maintenance.decideBoot()).toEqual({ mode: 'normal' });
  });

  it('with no writable entry answering, the login is loginOfPass\'s and there is no order (guard)', async () => {
    world.set(MAIN, { refuse: true });
    world.set(COPY, { generation: 3, rec: true, order: orderRow() });
    expect(await maintenance.decideBoot()).toEqual({ mode: 'normal' });
    world.set(COPY, { refuse: true });
    expect(await maintenance.decideBoot()).toMatchObject({ mode: 'maintenance', cause: 'login-refused' });
  });

  it.each([
    ['42501 (a lost grant)', pgError('42501', 'permission denied for table save_order')],
    ['a statement timeout', pgError('57014', 'canceling statement due to statement timeout')],
  ])('an entry whose save_order read fails with %s still answers, carries order unknown, and the boot is normal', async (_what, error) => {
    world.set(MAIN, { generation: 3, order: error });
    world.set(COPY, { generation: 3, rec: true, order: null });
    const pass = await probePass(parseAddressList(entry(MAIN)), { session: fakeSession as any });
    expect(pass[0]).toMatchObject({ kind: 'answered', generation: 3, saveOrder: 'unknown' });
    expect(await maintenance.decideBoot()).toEqual({ mode: 'normal' });
  });

  it('42P01 on the order read is no order: the entry answers with saveOrder null', async () => {
    world.set(MAIN, { generation: 3, order: pgError('42P01') });
    const pass = await probePass(parseAddressList(entry(MAIN)), { session: fakeSession as any });
    expect(pass[0]).toMatchObject({ kind: 'answered', saveOrder: null });
  });

  it('an entry whose order read is still running when the 10 s pass bound fires, after its meta read answered, settles as answered with order unknown', async () => {
    fake();
    world.set(MAIN, { generation: 3, order: 'hang' });
    let pass: any = null;
    void probePass(parseAddressList(entry(MAIN)), { session: fakeSession as any }).then(p => { pass = p; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pass).not.toBeNull();
    expect(pass[0]).toMatchObject({ kind: 'answered', generation: 3, saveOrder: 'unknown' });
  });

  it('a current row reads as the order: the answered entry carries it', async () => {
    world.set(MAIN, { generation: 3, order: orderRow() });
    const pass = await probePass(parseAddressList(entry(MAIN)), { session: fakeSession as any });
    expect(pass[0]).toMatchObject({ kind: 'answered', saveOrder: { orderId: 'o-1', state: 'maintenance', message: MESSAGE, current: true } });
  });
});

/** A Postgres maintenance boot with no shard record, so it builds no Client; its poll runs every 5 s. */
async function maintenanceBoot(cause: 'order' | 'login-refused' | 'hook'): Promise<void> {
  expect(await maintenance.runMaintenanceBoot({ cause, message: MESSAGE } as any, { shardRecord: () => null, login: async () => undefined })).toBeNull();
  await settle();
}
const poll = async (times = 1) => {
  for (let i = 0; i < times; i++) await vi.advanceTimersByTimeAsync(5_000);
  await settle();
};

describe('test 4 and P4: the maintenance boot\'s one poll', () => {
  it('cause order logs that the database holds a maintenance order and reports maintenance', async () => {
    fake();
    world.set(MAIN, { generation: 3, order: orderRow() });
    await maintenanceBoot('order');
    expect(maintenanceCause()).toBe('order');
    expect(logs.some(l => l.startsWith('[Maintenance] Booting in maintenance mode') && /maintenance order/.test(l))).toBe(true);
    expect(logs).not.toContain('[Maintenance] Booting in maintenance mode: the database refused the login');
    expect(sent).toContainEqual({ type: 'maintenance:mode', data: { mode: 'maintenance', boot: true } });
  });

  it('cause order stays while the order stands, then leaves after its poll reads running and the login accepted', async () => {
    fake();
    world.set(MAIN, { generation: 3, order: orderRow() });
    world.set(COPY, { generation: 3, rec: true, order: orderRow() });
    await maintenanceBoot('order');
    await poll(2);
    expect(restarts()).toEqual([]);
    world.set(MAIN, { generation: 3, order: orderRow({ state: 'running' }) });
    await poll();
    expect(restarts()).toHaveLength(1);
  });

  it('cause order leaves after Running although a copy\'s replayed row still reads maintenance', async () => {
    fake();
    world.set(MAIN, { generation: 3, order: orderRow({ state: 'running' }) });
    world.set(COPY, { generation: 3, rec: true, order: orderRow() });
    await maintenanceBoot('order');
    await poll();
    expect(restarts()).toHaveLength(1);
  });

  it('cause order whose poll reads unknown (the order read fails) stays', async () => {
    fake();
    world.set(MAIN, { generation: 3, order: pgError('42501') });
    world.set(COPY, { generation: 3, rec: true, order: null });
    await maintenanceBoot('order');
    await poll(3);
    expect(restarts()).toEqual([]);
  });

  it('cause order whose poll finds the main timing out on one pass stays (no restart), and leaves once the main answers running', async () => {
    fake();
    world.set(MAIN, { hang: true });
    world.set(COPY, { generation: 3, rec: true, order: null });
    await maintenanceBoot('order');
    await poll(3);
    expect(restarts()).toEqual([]);
    world.set(MAIN, { generation: 3, order: orderRow({ state: 'running' }) });
    await poll(3);
    expect(restarts()).toHaveLength(1);
  });

  it('cause login-refused that sees the login accepted while the order says maintenance stays, then leaves after running', async () => {
    fake();
    world.set(MAIN, { generation: 3, order: orderRow() });
    world.set(COPY, { generation: 3, rec: true, order: null });
    await maintenanceBoot('login-refused');
    await poll(2);
    expect(restarts()).toEqual([]);
    world.set(MAIN, { generation: 3, order: orderRow({ state: 'running' }) });
    await poll();
    expect(restarts()).toHaveLength(1);
  });

  it('cause login-refused whose pass has the main refusing and a copy (not yet at NOLOGIN) answering stays, and leaves once the main answers with no current order', async () => {
    fake();
    world.set(MAIN, { refuse: true });
    world.set(COPY, { generation: 3, rec: true, order: null });
    await maintenanceBoot('login-refused');
    await poll(2);
    expect(restarts()).toEqual([]);
    world.set(MAIN, { generation: 3, order: null });
    await poll();
    expect(restarts()).toHaveLength(1);
  });

  it('a copy that refuses the login while the writable main answers with no order does not hold a login-refused maintenance boot (guard)', async () => {
    fake();
    world.set(MAIN, { generation: 3, order: null });
    world.set(COPY, { refuse: true });
    await maintenanceBoot('login-refused');
    await poll(2);
    expect(restarts()).toHaveLength(1);
  });
});
