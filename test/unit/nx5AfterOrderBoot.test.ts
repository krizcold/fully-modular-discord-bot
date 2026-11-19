import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NX5 test 5 (sheets/NX5.md decision 10, ruling G7-2), the maintenance boot's rows: a maintenance boot of cause order,
// and one whose poll last read a current maintenance order, refuse provider.saveCredentials and payment.webhook with
// one reply and no write, and serve them again once the poll reads running. A maintenance boot marks this process for
// good, so these rows have their own file. Fails today (sharedOps.ts:394-398 apply the op in a maintenance boot).

const ctl = vi.hoisted(() => ({ lockChecks: 0 }));
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => ({
  ...(await orig<any>()),
  checkWriterLock: () => {
    ctl.lockChecks += 1;
    return { kind: 'not-held' };
  },
}));
vi.mock('../../src/bot/internalSetup/utils/pgClient', async orig => ({
  ...(await orig<any>()),
  shortLivedClient: (config: any) => (globalThis as any).__nx5Session(config),
}));

import * as maintenance from '../../src/bot/internalSetup/utils/maintenance';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { setBackendKind } from '../helpers/backendKind';
import { MESSAGE, entry, fakeSession, orderRow, settle, world } from '../helpers/nx5Rig';

(globalThis as any).__nx5Session = fakeSession;
type Listener = (message: unknown) => Promise<void>;
const listeners: Listener[] = [];
let replies: Array<{ requestId: string; data: any }> = [];
const MAIN = 'db-main';

beforeEach(() => {
  world.clear();
  replies = [];
  ctl.lockChecks = 0;
  setBackendKind('postgres');
  vi.stubEnv('DATA_BACKEND_URL', entry(MAIN));
  const realOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, fn: any) => {
    if (event === 'message') {
      listeners.push(fn);
      return process;
    }
    return realOn(event as any, fn);
  }) as any);
  maintenance._setMaintenanceSender(message => {
    if ((message as any).requestId) replies.push(message as any);
  });
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

async function deliver(message: { type: string; requestId: string; data: unknown }): Promise<void> {
  const original = process.send;
  (process as any).send = (msg: any, ...rest: any[]) => {
    if (msg && typeof msg === 'object' && typeof msg.requestId === 'string' && msg.requestId.startsWith('x5-')) {
      replies.push(msg);
      return true;
    }
    return (original as any).apply(process, [msg, ...rest]);
  };
  try {
    // Not awaited: an op that is applied waits on its own store write; a refusal answers within this step.
    for (const listener of listeners) void listener(message);
    await settle();
    await vi.advanceTimersByTimeAsync(50);
    await settle();
  } finally {
    (process as any).send = original;
  }
}

const repliesFor = (id: string) => replies.filter(r => r.requestId === id);
const poll = async (times = 1) => {
  for (let i = 0; i < times; i++) await vi.advanceTimersByTimeAsync(5_000);
  await settle();
};

async function boot(cause: 'order' | 'hook'): Promise<void> {
  await maintenance.runMaintenanceBoot({ cause, message: MESSAGE } as any, { shardRecord: () => null, login: async () => undefined });
  await settle();
}

const ops = [
  ['provider.saveCredentials', { providerId: 'patreon', changes: { clientId: 'x' } }],
  ['payment.webhook', { providerId: 'patreon', body: '' }],
] as const;

describe('test 5: a maintenance boot during the order', () => {
  it.each(ops)('cause order refuses %s with one reply and no write', async (op, args) => {
    writeMaintenanceFile('running', MESSAGE);
    world.set(MAIN, { generation: 2, order: orderRow() });
    await boot('order');
    await deliver({ type: 'shared:op', requestId: `x5-${op}`, data: { op, args } });
    expect(repliesFor(`x5-${op}`)).toHaveLength(1);
    expect(repliesFor(`x5-${op}`)[0].data).toMatchObject({ ok: false, code: 'maintenance', error: MESSAGE });
    expect(ctl.lockChecks).toBe(0);
  });

  it.each(ops)('a boot of cause hook whose poll last read a current maintenance order refuses %s', async (op, args) => {
    writeMaintenanceFile('maintenance', MESSAGE);
    world.set(MAIN, { generation: 2, order: orderRow() });
    await boot('hook');
    await poll();
    await deliver({ type: 'shared:op', requestId: `x5-h-${op}`, data: { op, args } });
    expect(repliesFor(`x5-h-${op}`)).toHaveLength(1);
    expect(repliesFor(`x5-h-${op}`)[0].data).toMatchObject({ ok: false, code: 'maintenance', error: MESSAGE });
    expect(ctl.lockChecks).toBe(0);
  });

  it('serves them again once its poll reads running', async () => {
    writeMaintenanceFile('maintenance', MESSAGE);
    world.set(MAIN, { generation: 2, order: orderRow() });
    await boot('hook');
    await poll();
    world.set(MAIN, { generation: 2, order: orderRow({ state: 'running' }) });
    await poll();
    await deliver({ type: 'shared:op', requestId: 'x5-again', data: { op: 'nope.op' } });
    expect(repliesFor('x5-again')).toHaveLength(1);
    expect(repliesFor('x5-again')[0].data).toMatchObject({ ok: false, code: 'invalid' });
    expect(ctl.lockChecks).toBe(1);
  });
});
