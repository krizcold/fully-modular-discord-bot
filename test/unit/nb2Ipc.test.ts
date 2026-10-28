import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reloader = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../src/bot/internalSetup/utils/moduleReloader', () => ({
  reloadModule: async (_client: unknown, name: string) => { reloader.calls.push(`reload:${name}`); return { success: true }; },
  reloadModules: async (_client: unknown, names: string[]) => { reloader.calls.push(`reload-all:${names.join(',')}`); return { success: true }; },
  unloadModuleFromMemory: async (_client: unknown, name: string) => { reloader.calls.push(`unload:${name}`); return { success: true }; },
}));

import { setupCommandIPCHandlers } from '../../src/bot/internalSetup/utils/ipcCommandHandler';
import { setupPanelIPCHandlers } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { applyOperatorDataWrite, setupDataIPCHandlers } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { setupReloadIPCHandlers } from '../../src/bot/internalSetup/utils/ipcReloadHandler';
import { setupToggleIPCHandlers } from '../../src/bot/internalSetup/utils/ipcToggleHandler';
import { deleteGuildNamespace, flushAll, restoreGuildFromGraveyard, saveData, setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { getWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { _resetMaintenance, closeMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenance';
import { handlersInFlight } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { freshGuild, storeGuild, tick } from '../helpers/gateRig';

// NB2 rulings 3, F (the IPC refusals through the real handlers), H (operator data writes) and J (module and component
// requests) while the maintenance gate is closed.

const MESSAGE = 'Down for the move.';
const REFUSAL = { success: false, maintenance: true, error: MESSAGE };

let sent: any[] = [];
let hadSend: typeof process.send;
let listenersBefore: Function[] = [];

beforeEach(() => {
  _resetMaintenance();
  reloader.calls.length = 0;
  sent = [];
  hadSend = process.send;
  (process as any).send = (message: unknown) => { sent.push(message); return true; };
  listenersBefore = process.listeners('message');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const listener of process.listeners('message')) {
    if (!listenersBefore.includes(listener)) process.off('message', listener as any);
  }
  (process as any).send = hadSend;
  _resetMaintenance();
  setBackendKind(null);
  setGuildDataBackend(null);
  vi.restoreAllMocks();
});

async function ask(type: string, data: object, requestId = `${type}-${sent.length}`): Promise<any> {
  const before = sent.length;
  process.emit('message' as any, { type, requestId, data } as any);
  await vi.waitFor(() => expect(sent.slice(before).some(m => m.requestId === requestId)).toBe(true), { timeout: 5000 });
  return sent.find(m => m.requestId === requestId).data;
}

describe('ruling F: the IPC refusals through the real handlers', () => {
  it('command:invoke is refused with the message and runs no command', async () => {
    setupCommandIPCHandlers();
    const open = await ask('command:invoke', { command: 'nothing-here' }, 'open');
    expect(open).not.toEqual(REFUSAL);
    closeMaintenanceGate('hook', MESSAGE);
    expect(await ask('command:invoke', { command: 'nothing-here' }, 'closed')).toEqual(REFUSAL);
  });

  it('panel actions are refused with the message', async () => {
    setupPanelIPCHandlers();
    closeMaintenanceGate('hook', MESSAGE);
    for (const type of ['panel:execute', 'panel:button', 'panel:dropdown', 'panel:modal']) {
      expect(await ask(type, { panelId: 'p1', userId: 'u1' }, type)).toEqual(REFUSAL);
    }
  });

  it('data:guild-write is refused with the message and writes nothing; reads still run', async () => {
    setBackendKind('file');
    setupDataIPCHandlers();
    const guildId = freshGuild();
    closeMaintenanceGate('hook', MESSAGE);
    const write = await ask('data:guild-write', { guildId, module: 'm', filename: 'a.json', op: 'write', contentJson: '{"v":1}' }, 'w');
    expect(write).toEqual({ ok: false, code: 'maintenance', error: MESSAGE });
    expect(fs.existsSync(dataPath(guildId))).toBe(false);
    const read = await ask('data:guild-read', { guildId, module: 'm' }, 'r');
    expect(read.code).not.toBe('maintenance');
  });
});

describe('ruling H: operator data writes', () => {
  it('data:guild-write runs inside runTracked, so entering maintenance waits for it', async () => {
    setBackendKind('file');
    setupDataIPCHandlers();
    const guildId = freshGuild();
    process.emit('message' as any, { type: 'data:guild-write', requestId: 'tracked', data: { guildId, module: 'm', filename: 'a.json', op: 'write', contentJson: '{"v":1}' } } as any);
    expect(handlersInFlight()).toBe(1);
    await vi.waitFor(() => expect(sent.some(m => m.requestId === 'tracked')).toBe(true));
    expect(handlersInFlight()).toBe(0);
  });

  it('a namespace delete admitted before the gate closed moves nothing once it is closed', async () => {
    setBackendKind('file');
    const guildId = freshGuild();
    saveData('a.json', { guildId, category: 'm' }, { v: 1 });
    await flushAll();
    const deleting = deleteGuildNamespace(guildId, 'test');
    closeMaintenanceGate('hook', MESSAGE);
    await expect(deleting).rejects.toMatchObject({ causeKey: 'maintenance' });
    expect(fs.existsSync(dataPath(guildId))).toBe(true);
  });

  it('on Postgres, a gate closed while the guild flushes stops the delete before it evicts or retires anything', async () => {
    const { guildId } = await storeGuild();
    const retireGuild = vi.fn(async () => ({ ok: true, moved: 1 }));
    setGuildDataBackend({ retireGuild } as never);
    const ws = getWorkingSet()!;
    vi.spyOn(ws, 'flushGuildNow').mockImplementation(async () => { closeMaintenanceGate('hook', MESSAGE); return 'ok' as never; });
    const evict = vi.spyOn(ws, 'evict');
    await expect(deleteGuildNamespace(guildId, 'test')).rejects.toMatchObject({ causeKey: 'maintenance' });
    expect(evict).not.toHaveBeenCalled();
    expect(retireGuild).not.toHaveBeenCalled();
  });

  it('on Postgres, a gate closed while the newest graveyard batch is read stops the restore', async () => {
    setBackendKind('postgres');
    const restoreGuild = vi.fn(async () => ({ ok: true, moved: 1 }));
    const backend = Object.assign(Object.create(PostgresBackend.prototype), {
      latestGraveyardBatch: async () => { closeMaintenanceGate('hook', MESSAGE); return 5; },
      restoreGuild,
    });
    setGuildDataBackend(backend);
    await expect(restoreGuildFromGraveyard(freshGuild())).rejects.toMatchObject({ causeKey: 'maintenance' });
    expect(restoreGuild).not.toHaveBeenCalled();
  });

  it('a graveyard restore is refused while the gate is closed', async () => {
    setBackendKind('file');
    closeMaintenanceGate('hook', MESSAGE);
    await expect(restoreGuildFromGraveyard(freshGuild())).rejects.toMatchObject({ causeKey: 'maintenance' });
  });

  it('the operator write answers the maintenance refusal with the message', async () => {
    setBackendKind('file');
    const guildId = freshGuild();
    saveData('a.json', { guildId, category: 'm' }, { v: 1 });
    await flushAll();
    const deleting = applyOperatorDataWrite({ guildId, module: 'm', filename: 'a.json', op: 'delete-namespace' } as any);
    closeMaintenanceGate('hook', MESSAGE);
    expect(await deleting).toEqual({ ok: false, code: 'maintenance', error: MESSAGE });
    expect(await applyOperatorDataWrite({ guildId, module: 'm', filename: 'b.json', op: 'write', contentJson: '{}' } as any))
      .toEqual({ ok: false, code: 'maintenance', error: MESSAGE });
    expect(fs.existsSync(dataPath(guildId))).toBe(true);
  });
});

describe('ruling J: module and component requests', () => {
  it('module:reload, module:reload-all, module:load and module:unload are refused with the message', async () => {
    setupReloadIPCHandlers({} as any);
    expect(await ask('module:reload', { moduleName: 'x' }, 'open')).toEqual({ success: true });
    expect(reloader.calls).toEqual(['reload:x']);
    closeMaintenanceGate('hook', MESSAGE);
    for (const [type, data] of [
      ['module:reload', { moduleName: 'x' }],
      ['module:reload-all', { moduleNames: ['x'] }],
      ['module:load', { moduleName: 'x' }],
      ['module:unload', { moduleName: 'x' }],
    ] as const) {
      expect(await ask(type, data, type)).toEqual(REFUSAL);
    }
    expect(reloader.calls).toEqual(['reload:x']);
  });

  it('component:toggle is refused with the message', async () => {
    setupToggleIPCHandlers({} as any);
    const open = await ask('component:toggle', { module: 'm', componentType: 'bogus', name: 'n', enabled: false }, 'open');
    expect(open).toEqual({ success: false, error: 'Unknown component type: bogus' });
    closeMaintenanceGate('hook', MESSAGE);
    expect(await ask('component:toggle', { module: 'm', componentType: 'bogus', name: 'n', enabled: false }, 'closed')).toEqual(REFUSAL);
    await tick(10);
  });
});
