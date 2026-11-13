import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const applier = vi.hoisted(() => ({ changes: [] as any[] }));
vi.mock('../../src/bot/internalSetup/utils/moduleApply', () => ({
  applyModuleChange: async (change: any) => { applier.changes.push(change); return { success: true, applied: change.module }; },
}));
vi.mock('../../src/bot/internalSetup/utils/moduleReloader', () => ({
  reloadModule: async () => ({ success: true }),
  reloadModules: async () => ({ success: true }),
  unloadModuleFromMemory: async () => ({ success: true }),
}));

import { setupReloadIPCHandlers } from '../../src/bot/internalSetup/utils/ipcReloadHandler';
import { _resetMaintenance } from '../../src/bot/internalSetup/utils/maintenance';

// NB6 decisions 44, 58 and 61: module:apply from the web UI becomes the change this machine applies; the staged folder,
// the reason, the version and updated_by reach the applier as sent, and anything else falls back to the rows and 'remote'.

let sent: any[] = [];
let hadSend: typeof process.send;
let listenersBefore: Function[] = [];

beforeEach(() => {
  _resetMaintenance();
  applier.changes = [];
  sent = [];
  hadSend = process.send;
  (process as any).send = (message: unknown) => { sent.push(message); return true; };
  listenersBefore = process.listeners('message');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  setupReloadIPCHandlers({} as any);
});
afterEach(() => {
  for (const listener of process.listeners('message')) {
    if (!listenersBefore.includes(listener)) process.off('message', listener as any);
  }
  (process as any).send = hadSend;
  _resetMaintenance();
  vi.restoreAllMocks();
});

let seq = 0;
async function apply(data: object): Promise<any> {
  const requestId = `rk8r-${seq++}`;
  const before = applier.changes.length;
  process.emit('message' as any, { type: 'module:apply', requestId, data } as any);
  await vi.waitFor(() => expect(sent.some(m => m.requestId === requestId)).toBe(true), { timeout: 2000, interval: 2 });
  const reply = sent.find(m => m.requestId === requestId).data;
  expect(reply).toEqual({ success: true, applied: 'm1' });
  expect(applier.changes.length).toBe(before + 1);
  return applier.changes[before];
}

describe('module:apply: the staged folder', () => {
  it('a staged folder named in the message is the source', async () => {
    const change = await apply({ module: 'm1', to: 'sha1', staged: 'D:/stage/m1-sha1', reason: 'install' });
    expect(change.source).toBe('D:/stage/m1-sha1');
  });

  it('without a staged folder the rows are the source', async () => {
    const change = await apply({ module: 'm1', to: 'sha1', reason: 'install' });
    expect(change.source).toBe('rows');
    const numeric = await apply({ module: 'm1', to: 'sha1', staged: 7, reason: 'install' });
    expect(numeric.source).toBe('rows');
  });
});

describe('module:apply: the reason', () => {
  it.each(['install', 'update', 'uninstall'])('%s reaches the applier as sent', async reason => {
    const change = await apply({ module: 'm1', to: 'sha1', reason });
    expect(change.reason).toBe(reason);
  });

  it('any other reason, or none, is remote', async () => {
    expect((await apply({ module: 'm1', to: 'sha1', reason: 'bogus' })).reason).toBe('remote');
    expect((await apply({ module: 'm1', to: 'sha1' })).reason).toBe('remote');
    expect((await apply({ module: 'm1', to: 'sha1', reason: '' })).reason).toBe('remote');
  });
});

describe('module:apply: the version and updated_by', () => {
  it('are passed as sent and are null when absent', async () => {
    const full = await apply({ module: 'm1', to: 'sha1', reason: 'update', version: '1.2.0', updatedBy: 'node-b' });
    expect(full).toEqual({
      module: 'm1', to: 'sha1', source: 'rows', displaced: 'backups', reason: 'update', tag: null, version: '1.2.0', updatedBy: 'node-b',
    });
    const bare = await apply({ module: 'm1', to: 'sha1', reason: 'update' });
    expect(bare.version).toBeNull();
    expect(bare.updatedBy).toBeNull();
  });
});
