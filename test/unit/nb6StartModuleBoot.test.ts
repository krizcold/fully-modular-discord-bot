import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 64's boot-turn rows (wip-redesign/sheets/NB6.md decisions 93, 99, 105, 109, C16, E6; part 18): a module's
// boot start from the real boot loop before its turn (row 375's boot halves), and after the clientReady handler
// returned early with the gate closed (row 376; its IPC half is a guard row, true before this part:
// maintenanceIpcRefusal refuses module code requests while the gate is closed), and the bot's `module:apply` IPC type
// through the real handler (decisions 44 and 61). runBot's boot steps run over the rows the real publish writes.

const h = vi.hoisted(() => ({ manifests: (() => []) as () => string[], emit: (() => undefined) as () => void }));

vi.mock('dotenv/config', () => ({}));
// reloadModule calls the module's own recompileTypeScript: tsc's exec answers as the rig's compile does, after the emit.
vi.mock('child_process', async orig => {
  const real = await orig<typeof import('child_process')>();
  const exec = (command: string, options: any, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
    if (!command.includes('tsc')) return (real.exec as any)(command, options, callback);
    h.emit();
    callback(null, '', '');
  };
  return { ...real, exec, default: { ...real, exec } };
});
vi.mock('../../src/utils/envLoader', async orig => ({ ...(await orig<any>()), loadCredentials: () => ({}) }));
vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});
vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => ({ ...(await orig<any>()), findModuleManifests: () => h.manifests() }));
vi.mock('../../src/bot/internalSetup/utils/commandUtils', async orig => ({ ...(await orig<any>()), reRegisterSlashCommands: async () => undefined }));

import { bootRig, moduleFiles } from '../helpers/nb6BootRig';
import { bootStartOf, starting } from '../../src/bot/internalSetup/utils/moduleCrashes';
import { reloadModule } from '../../src/bot/internalSetup/utils/moduleReloader';
import { setupReloadIPCHandlers } from '../../src/bot/internalSetup/utils/ipcReloadHandler';
import { _resetMaintenance, closeMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenance';
import { maintenanceText } from '../../src/bot/internalSetup/utils/maintenanceGate';

const rig = bootRig();
const T31_C = 'm was not reloaded: this machine is still starting it. Its start-up code runs once the bot has connected to Discord, loaded its data and started the modules before it, and the bot waits for it for at most 10 minutes. Try again after that.';

let sent: any[] = [];
let hadSend: typeof process.send;
let listenersBefore: Function[] = [];

beforeEach(async () => {
  await rig.setup();
  h.manifests = rig.manifests;
  h.emit = rig.emit;
  _resetMaintenance();
  sent = [];
  hadSend = process.send;
  (process as any).send = (message: unknown) => { sent.push(message); return true; };
  listenersBefore = process.listeners('message');
});
afterEach(async () => {
  for (const listener of process.listeners('message')) {
    if (!listenersBefore.includes(listener)) process.off('message', listener as any);
  }
  (process as any).send = hadSend;
  _resetMaintenance();
  await rig.teardown();
});

async function ask(type: string, data: object, requestId = `${type}-${sent.length}`): Promise<any> {
  const before = sent.length;
  process.emit('message' as any, { type, requestId, data } as any);
  await vi.waitFor(() => expect(sent.slice(before).some(m => m.requestId === requestId)).toBe(true), { timeout: 5000 });
  return sent.find(m => m.requestId === requestId).data;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
}

describe("row 375's boot halves: a boot start before its turn", () => {
  it('after loadModules and during the turns of the modules before it: the reload refused with T31 (c), the apply deferred starting (c)', async () => {
    await rig.inPlace('a', '1.0.0');
    await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    const aTurn = deferred();
    rig.code.set('a@1.0.0', { initialize: [() => aTurn.promise] });
    await rig.boot();
    expect(bootStartOf('m')?.turnAt).toBeNull();
    expect(await reloadModule(rig.client, 'm')).toMatchObject({ success: false, error: T31_C });
    const turns = rig.turns();
    await vi.waitFor(() => expect(starting.size).toBe(1));
    expect([...starting][0].module).toBe('a');
    expect(await reloadModule(rig.client, 'm')).toMatchObject({ success: false, error: T31_C });
    const u3 = await rig.publish('m', '3.0.0');
    expect(await rig.apply.apply('m', u3, { version: '3.0.0' })).toMatchObject({ outcome: 'deferred', reason: 'starting', state: 'c' });
    aTurn.resolve();
    await turns;
    expect(rig.apply.entry('m')).toMatchObject({ sha: u, applying: null });
  });
});

describe('row 376: a boot start after the clientReady handler returned early (the gate closed)', () => {
  it("guard: a reload by IPC is refused with the maintenance text before reloadModule runs; module:apply too; the in-bot apply ends deferred maintenance", async () => {
    await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    await rig.boot();
    setupReloadIPCHandlers(rig.client);
    closeMaintenanceGate('hook', 'Down for the move.');
    const loadsBefore = rig.fakeLoader.loads.length;
    expect(await ask('module:reload', { moduleName: 'm' })).toEqual({ success: false, maintenance: true, error: maintenanceText() });
    expect(await ask('module:apply', { module: 'm', to: u, staged: null, tag: '1:ALPHA' })).toEqual({ success: false, maintenance: true, error: maintenanceText() });
    expect(await rig.apply.apply('m', u, { version: '2.0.0' })).toMatchObject({ outcome: 'deferred', reason: 'maintenance' });
    expect(rig.fakeLoader.loads.length).toBe(loadsBefore);
    expect(rig.apply.entry('m')?.applying).toMatchObject({ to: u });
  });
});

describe("the module:apply IPC type (44, 58, 61)", () => {
  it("in a running bot: the handler applies the row with the publish's tag and answers the apply's result", async () => {
    await rig.inPlace('m', '1.0.0');
    await rig.boot();
    await rig.turns();
    setupReloadIPCHandlers(rig.client);
    const u = await rig.publish('m', '2.0.0');
    rig.fakeLoader.loads = [];
    expect(await ask('module:apply', { module: 'm', to: u, staged: null, tag: '1:ALPHA', version: '2.0.0' })).toEqual({ outcome: 'applied', reason: null, error: null, loaded: true });
    expect(rig.fakeLoader.loads).toEqual([{ module: 'm', sha: u }]);
    expect(rig.apply.live('m')).toEqual(moduleFiles('m', '2.0.0'));
    expect(rig.apply.entry('m')).toMatchObject({ sha: u, applying: null });
  });

  it('a tag other than the main the bot reads now: deferred main-changed, nothing touched', async () => {
    await rig.inPlace('m', '1.0.0');
    await rig.boot();
    await rig.turns();
    setupReloadIPCHandlers(rig.client);
    const u = await rig.publish('m', '2.0.0');
    expect(await ask('module:apply', { module: 'm', to: u, staged: null, tag: '2:BRAVO' })).toMatchObject({ outcome: 'deferred', reason: 'main-changed' });
    expect(rig.apply.live('m')).toEqual(moduleFiles('m', '1.0.0'));
  });
});
