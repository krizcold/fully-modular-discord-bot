import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB8 test 15, the child side (decision 32, C20, H1, I3, J4, N1): `backup:take` is answered once in a normal boot and in
// a maintenance boot, `busy` while a take runs, `stopping` once the stop step ran; a disk error the bot could not record
// is reported to the web UI, one it recorded is not.

const h = vi.hoisted(() => ({ stopSteps: [] as Array<() => unknown> }));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  addStopStep: (step: () => unknown) => { h.stopSteps.push(step); },
}));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => ({
  ...(await orig<any>()),
  getPaymentRegistry: () => ({ on: () => undefined, off: () => undefined, get: () => undefined, list: () => [], listAll: () => [], startTickers: () => undefined, emitEvent: () => undefined }),
}));

import { dataPath } from '../../src/utils/dataRoot';

const seams = { pid: () => process.pid, alive: () => true, startOf: (pid: number) => `start-${pid}`, now: () => Date.now() };
const sent: any[] = [];
let listeners: Function[] = [];
let n = 0;
const nextName = () => `hourly-2026-11-13T${String(++n).padStart(2, '0')}-00-00-000Z`;
const locks: Array<{ writerLockDepth(): number; releaseWriterLock(): void }> = [];

async function load() {
  vi.resetModules();
  const lock = await import('../../src/bot/internalSetup/utils/writerLock');
  fs.rmSync(lock.writerLockPath(), { force: true });
  lock.configureWriterLock('bot', seams);
  lock.takeWriterLock();
  locks.push(lock);
  const take = await import('../../src/bot/internalSetup/utils/backups/snapshotTake');
  take._setTakeTimingForTests({ pollMs: 5 }, seams);
  return {
    take,
    ipc: await import('../../src/bot/internalSetup/utils/ipcBackupHandler'),
    maintenance: await import('../../src/bot/internalSetup/utils/maintenance'),
    gate: await import('../../src/bot/internalSetup/utils/maintenanceGate'),
    shared: await import('../../src/bot/internalSetup/utils/sharedOps'),
    chain: await import('../../src/bot/internalSetup/utils/folderChain'),
  };
}

/** Sends one request as the web UI would and collects the answers until none comes for a moment. */
async function ask(type: string, data: object): Promise<any[]> {
  const requestId = `${type}_${++n}`;
  process.emit('message' as any, { type, requestId, data } as any);
  let seen = -1;
  while (seen !== sent.length) {
    seen = sent.length;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return sent.filter(m => m.requestId === requestId).map(m => m.data);
}

/** The disk refuses the record's create (EROFS). */
function refuseRecord(): void {
  const real = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation(((p: any, ...rest: any[]) => {
    if (path.basename(String(p)).startsWith('disk-error-')) throw Object.assign(new Error('EROFS: stubbed'), { code: 'EROFS' });
    return (real as any)(p, ...rest);
  }) as any);
  syncBuiltinESMExports();
}

function hangOn(rel: string): void {
  const real = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation(async (p: any, ...rest: any[]) => {
    if (path.resolve(String(p)) === path.resolve(dataPath(...rel.split('/')))) return new Promise<never>(() => undefined);
    return real(p, ...rest);
  });
}

beforeEach(() => {
  for (const e of fs.readdirSync(dataPath())) fs.rmSync(dataPath(e), { recursive: true, force: true });
  fs.mkdirSync(dataPath('123'), { recursive: true });
  fs.writeFileSync(dataPath('123', 'a.json'), '{"a":1}');
  sent.length = 0;
  h.stopSteps.length = 0;
  listeners = process.listeners('message');
  (process as any).send = (message: any) => { sent.push(message); return true; };
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const l of process.listeners('message')) if (!listeners.includes(l)) process.removeListener('message', l as any);
  delete (process as any).send;
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const lock of locks.splice(0)) while (lock.writerLockDepth() > 0) lock.releaseWriterLock();
});

describe('backup:take in the bot process', () => {
  it('a normal boot answers it once, from the backup handler', async () => {
    const m = await load();
    m.maintenance.setupMaintenanceIPC();
    m.shared.setupSharedOpsIPC();
    m.ipc.setupBackupIPC();
    const name = nextName();
    const answers = await ask('backup:take', { name, kind: 'hourly' });
    expect(answers).toEqual([{ ok: true, name, counts: expect.objectContaining({ files: 1, guilds: 1 }), linked: 0 }]);
    expect(h.stopSteps).toHaveLength(1);
  });

  it('a maintenance boot answers it once, with the take and not the maintenance refusal', async () => {
    const m = await load();
    m.gate.markMaintenanceBoot();
    m.gate.setMaintenanceGate({ cause: 'hook', message: 'Down for an upgrade' });
    m.maintenance.setupMaintenanceIPC();
    m.ipc.setupBackupIPC();
    m.shared.setupSharedOpsIPC();
    const name = nextName();
    const answers = await ask('backup:take', { name, kind: 'hourly' });
    const direct = await m.maintenance.handleMaintenanceIpc({ type: 'backup:take', requestId: 'x', data: {} });
    expect(answers).toEqual([expect.objectContaining({ ok: true, name })]);
    expect(direct).toBeNull();
  });

  it('answers busy while a take runs, and stopping once the stop step ran', async () => {
    const m = await load();
    m.ipc.setupBackupIPC();
    hangOn('123/a.json');
    process.emit('message' as any, { type: 'backup:take', requestId: 'first', data: { name: nextName(), kind: 'hourly' } } as any);
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = await ask('backup:take', { name: nextName(), kind: 'hourly' });
    await h.stopSteps[0]();
    await new Promise(resolve => setTimeout(resolve, 50));
    const first = sent.filter(x => x.requestId === 'first').map(x => x.data);
    expect(second).toEqual([{ ok: false, busy: true }]);
    expect(first).toEqual([{ ok: false, stopping: true }]);
    expect(fs.readdirSync(dataPath('_snapshots')).filter(x => x.startsWith('.taking-'))).toEqual([]);
  });
});

describe("the bot's disk error report", () => {
  it('sends nothing when the bot recorded the error itself', async () => {
    const m = await load();
    m.chain._setBootIdForTests('b1');
    m.chain.setDiskRole('bot');
    m.ipc.setupBackupIPC();
    m.chain.noteFolderSyncFailure(dataPath('123'), 'EIO');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fs.existsSync(dataPath('_snapshots', 'disk-error-b1.json'))).toBe(true);
    expect(sent.filter(s => s.type === 'disk:folder-sync-failed')).toEqual([]);
  });

  it('sends the error when its record could not be written', async () => {
    const m = await load();
    m.chain._setBootIdForTests('b1');
    m.chain.setDiskRole('bot');
    m.ipc.setupBackupIPC();
    refuseRecord();
    m.chain.noteFolderSyncFailure(dataPath('123'), 'EIO');
    const flag = m.chain.folderSyncFlag()!;
    expect(sent.filter(s => s.type === 'disk:folder-sync-failed')).toEqual([{ type: 'disk:folder-sync-failed', data: { dir: '/data/123', errno: 'EIO', at: flag.at } }]);
  });

  it('a registration after an error it could not record sends the error at once', async () => {
    const m = await load();
    m.chain._setBootIdForTests('b1');
    m.chain.setDiskRole('bot');
    refuseRecord();
    m.chain.noteFolderSyncFailure(dataPath('123'), 'EIO');
    const before = sent.length;
    m.ipc.setupBackupIPC();
    const flag = m.chain.folderSyncFlag()!;
    expect(before).toBe(0);
    expect(sent).toEqual([{ type: 'disk:folder-sync-failed', data: { dir: '/data/123', errno: 'EIO', at: flag.at } }]);
  });
});
