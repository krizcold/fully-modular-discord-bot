import { afterAll, describe, expect, it, vi } from 'vitest';

// NB5 unit test 18 (C2), rows (a) and (b): bot/index.ts takes `data:addresses` while the writer lock is still held
// open; row (c), a maintenance boot's IPC and the login probe watchLogin runs. Row (d) (botManager) is in
// nb5AddressesRoute.test.ts.

const take = vi.hoisted(() => ({ release: null as null | (() => void) }));
vi.mock('dotenv/config', () => ({}));
vi.mock('tsconfig-paths', () => ({ register: () => undefined }));
vi.mock('../../src/bot/internalSetup/clientInitializer', () => ({ main: async () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => ({
  ...(await orig<any>()),
  configureWriterLock: () => undefined,
  takeWriterLockForBoot: () => new Promise<void>(resolve => { take.release = resolve; }),
  onDeposed: () => undefined,
}));
const sessions = vi.hoisted(() => ({ hosts: [] as string[] }));
vi.mock('../../src/bot/internalSetup/utils/pgClient', async orig => ({
  ...(await orig<any>()),
  shortLivedClient: (config: { host?: string }) => {
    sessions.hosts.push(String(config.host));
    return {
      connect: async () => { throw Object.assign(new Error('role is not permitted to log in'), { code: '28000', severity: 'FATAL' }); },
      query: async () => ({ rows: [] }),
      end: async () => undefined,
      on: () => undefined,
    };
  },
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  installStopHandler: () => undefined,
  beginStop: () => undefined,
}));

import { addressListInUse } from '../../src/utils/databaseAddress';
import { handleMaintenanceIpc, probeLoginAtBoot } from '../../src/bot/internalSetup/utils/maintenance';
import { setBackendKind } from '../helpers/backendKind';

const A = 'postgresql://bot:pw@db1:5432/bot';
const B = 'postgresql://bot:pw@10.0.0.5:5432/bot';
const realSend = process.send;
afterAll(() => { process.send = realSend; take.release?.(); });

describe('data:addresses before the writer lock', () => {
  it('(a) acks a two-entry list and keeps it as the list in use', async () => {
    const sent: any[] = [];
    process.send = ((m: any) => { sent.push(m); return true; }) as any;
    await import('../../src/bot/index');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(take.release).not.toBeNull();
    process.emit('message' as any, { type: 'data:addresses', data: { id: 'a1', url: `${A},${B}` } } as any);
    expect(sent).toEqual([{ type: 'data:addresses-ack', data: { id: 'a1', accepted: true } }]);
    expect(addressListInUse()).toBe(`${A},${B}`);
  });

  it('(b) refuses a list whose entry 2 is mysql:// and keeps the list in use', () => {
    const sent: any[] = [];
    process.send = ((m: any) => { sent.push(m); return true; }) as any;
    process.emit('message' as any, { type: 'data:addresses', data: { id: 'a2', url: `${A},mysql://b` } } as any);
    expect(sent).toEqual([{ type: 'data:addresses-ack', data: { id: 'a2', accepted: false, error: 'entry 2 of DATA_BACKEND_URL must start with postgresql:// or postgres://' } }]);
    expect(addressListInUse()).toBe(`${A},${B}`);
  });

  it("(c) in a maintenance boot the maintenance IPC answers null for it, the ack is sent, and watchLogin's next probe covers both new entries", async () => {
    const sent: any[] = [];
    process.send = ((m: any) => { sent.push(m); return true; }) as any;
    const C = 'postgresql://bot:pw@db3:5432/bot';
    const D = 'postgresql://bot:pw@db4:5432/bot';
    const message = { type: 'data:addresses', data: { id: 'a3', url: `${C},${D}` } };
    expect(await handleMaintenanceIpc(message)).toBeNull();
    process.emit('message' as any, message as any);
    expect(sent).toEqual([{ type: 'data:addresses-ack', data: { id: 'a3', accepted: true } }]);
    setBackendKind('postgres');
    try {
      sessions.hosts.length = 0;
      expect(await probeLoginAtBoot()).toBe('refused');
      expect(sessions.hosts.sort()).toEqual(['db3', 'db4']);
    } finally {
      setBackendKind(null);
    }
  });
});
