import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSourceText } from '../helpers/sourceText';

// NB4 decision 6 for module code the framework starts (sheet unit 4, R2-T12): the clientReady once-handler, a module
// reload or load whose compile or onLoad crosses D, a console invoke and a panel action whose hold crosses D, the
// update panel's auto-check, and a dataContract 2 reply. The deadline is a real ShardClaims over a fake claims store,
// its clocks moved past D with no timer run; each case also runs after a loss (a renewal answer without a pair).

const h = vi.hoisted(() => ({
  compiles: [] as Array<(error: Error | null, out?: { stdout: string; stderr: string }) => void>,
  module: null as any,
  manifestPath: '',
  updateCheck: null as null | ((value: unknown) => void),
  panelEdits: 0,
  handleCommands: 0,
  client: null as any,
  panelManager: null as any,
}));

vi.mock('child_process', async orig => ({
  ...(await orig<any>()),
  exec: (_cmd: string, _opts: unknown, cb: (error: Error | null, out?: { stdout: string; stderr: string }) => void) => { h.compiles.push(cb); },
}));
vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => ({
  ...(await orig<any>()),
  findModuleManifests: () => [h.manifestPath],
  getBuildRoot: () => path.join(os.tmpdir(), 'smdb-nb4-no-build-root'),
}));
vi.mock('../../src/bot/internalSetup/utils/moduleLoader', async orig => ({
  ...(await orig<any>()),
  hotLoadRefusal: () => null,
  ModuleLoader: class { async loadModule() { return h.module; } },
}));
vi.mock('../../src/bot/internalSetup/utils/commandUtils', async orig => ({
  ...(await orig<any>()),
  reRegisterSlashCommands: async () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/botManagerAPI', async orig => ({
  ...(await orig<any>()),
  checkForAllBotUpdates: () => new Promise(resolve => { h.updateCheck = resolve; }),
}));
vi.mock('../../src/bot/internalSetup/utils/panel/persistentPanelResponse', async orig => ({
  ...(await orig<any>()),
  updatePanelDynamic: async () => { h.panelEdits += 1; return true; },
}));
vi.mock('../../src/bot/internalSetup/panels/updateManager', async orig => ({
  ...(await orig<any>()),
  buildPanelView: () => ({ content: 'view' }),
}));
vi.mock('../../src/bot/internalSetup/utils/panel/persistentPanelStorage', async orig => ({
  ...(await orig<any>()),
  loadPersistentPanels: async (guildId?: string) => (guildId === undefined ? { update_manager: { messageId: 'm', channelId: 'c', guildId: '1' } } : {}),
  updatePersistentPanelState: async () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/panelManager', async orig => ({
  ...(await orig<any>()),
  getPanelManager: () => h.panelManager ?? { getClient: () => h.client },
}));
vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => [{ name: 'ping' }] }));
vi.mock('../../src/bot/internalSetup/utils/commandGate', async orig => ({
  ...(await orig<any>()),
  isCommandRunnable: () => ({ runnable: true }),
}));
vi.mock('../../src/bot/internalSetup/events/interactionCreate/handleCommands', () => ({
  default: async () => { h.handleCommands += 1; },
}));

import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { STOPPED_SERVING_TEXT, setStoppedServingHook, stoppedServing } from '../../src/bot/internalSetup/utils/servingGate';
import { reloadModule } from '../../src/bot/internalSetup/utils/moduleReloader';
import { getModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';
import { recoverPersistentPanels } from '../../src/bot/internalSetup/utils/panel/persistentPanelRecovery';
import { handleInvoke, setupCommandIPCHandlers } from '../../src/bot/internalSetup/utils/ipcCommandHandler';
import { runPanelAction, setupPanelIPCHandlers } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { setupReloadIPCHandlers } from '../../src/bot/internalSetup/utils/ipcReloadHandler';
import { setupToggleIPCHandlers } from '../../src/bot/internalSetup/utils/ipcToggleHandler';
import { gateCauseText } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { initDataReadiness } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { setManifestReader } from '../../src/bot/internalSetup/utils/dataBackends/dataContract';
import { withModule } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { isMaintenanceGateClosed } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { _resetMaintenance } from '../../src/bot/internalSetup/utils/maintenance';
import { MemClaimStore } from '../helpers/fakeClaimStore';
import { FakeStore } from '../helpers/fakeStore';
import { setBackendKind } from '../helpers/backendKind';
import { rawCommand, rig, storeGuild, textOf, tick } from '../helpers/gateRig';

const T = claimTimings(30);
const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };
const G0 = String(4n << 22n);

afterEach(() => {
  setStoppedServingHook(null);
  setManifestReader(null);
  _resetMaintenance();
  h.compiles = [];
  h.module = null;
  h.updateCheck = null;
  h.panelEdits = 0;
  h.handleCommands = 0;
  h.client = null;
  h.panelManager = null;
  vi.restoreAllMocks();
});

/** A booted ShardClaims holding shards 0 and 1, wired as shardBoot wires it; stop() ends serving by a lapse or a loss. */
async function deadline(how: 'lapse' | 'loss', onStopStep: () => void = () => undefined) {
  const store = new MemClaimStore(() => Date.now());
  const skew = { perf: 0, wall: 0 };
  const claims = new ShardClaims({
    store, me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' }, timings: T, capacity: 4, takeoverSeconds: 30,
    returns: true, restartable: true, startedAt: 0,
    clocks: () => ({ perf: performance.now() + skew.perf, wall: Date.now() + skew.wall }),
    fitness: () => null, gateClosed: () => false, isStopping: () => false, stopServingStep: onStopStep,
    noteLapsed: () => undefined, noteLost: () => undefined, restartForShards: () => false, log: silent,
  });
  expect(await claims.firstRenewal()).toBe(true);
  const taken = await claims.bootTake(async () => 2);
  claims.noteGranted();
  setStoppedServingHook(() => claims.stoppedServing());
  const stop = async () => {
    if (how === 'lapse') {
      skew.wall = 120_000;
      skew.perf = 1_000;
    } else {
      Object.assign(store.rows.get('2:0')!, { claim: 999, holderProcess: 'p-x', holderNode: 'node-x' });
      await claims.renewOnce();
      expect(claims.snapshot().stopped).toBe('loss');
    }
  };
  const end = async () => { claims.beginStop(); await claims.finishStop(); };
  return { claims, store, taken: taken!, stop, end };
}

/** clientInitializer.ts runs main() at import, so its clientReady once-handler is run from its own source text. */
function onceHandlerFromSource(deps: Record<string, unknown>) {
  const source = readSourceText(__dirname, '../../src/bot/internalSetup/clientInitializer.ts');
  const start = source.indexOf("  const NOT_STARTED = '[Shards]");
  const end = source.indexOf('    startModuleAutoUpdater(client);\n  });\n', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end + '    startModuleAutoUpdater(client);\n  });\n'.length);
  const names = Object.keys(deps);
  return new Function(...names, body).bind(null, ...names.map(n => deps[n])) as () => void;
}

describe("the framework's clientReady once-handler", () => {
  async function onceRig(how: 'lapse' | 'loss') {
    const d = await deadline(how);
    let barrier: (value: string) => void = () => undefined;
    let recovered: () => void = () => undefined;
    const lines: string[] = [];
    const calls = { runInitializers: 0, recoverPanels: 0, startModuleAutoUpdater: 0 };
    const client = Object.assign(new EventEmitter(), { user: { tag: 'bot#0001' } });
    const install = onceHandlerFromSource({
      client,
      stoppedServing,
      isMaintenanceGateClosed,
      awaitDataStartupBarrier: () => new Promise<string>(resolve => { barrier = resolve; }),
      runInitializers: () => { calls.runInitializers += 1; },
      getModuleRegistry: () => ({ getStats: () => ({ total: 0, byCategory: {} }) }),
      getPanelManager: () => ({ recoverPanels: () => { calls.recoverPanels += 1; return new Promise<void>(resolve => { recovered = resolve; }); } }),
      startModuleAutoUpdater: () => { calls.startModuleAutoUpdater += 1; },
      console: { log: (...a: unknown[]) => lines.push(a.map(String).join(' ')), error: (...a: unknown[]) => lines.push(a.map(String).join(' ')) },
    });
    install();
    return { ...d, client, calls, lines, barrier: (v: string) => barrier(v), recovered: () => recovered() };
  }

  const NOT_STARTED = '[Shards] Module initializers, panel recovery and the module auto-updater do not start: this process stopped serving its shards';
  const STOPPED_AFTER = '[Shards] Panel recovery and the module auto-updater stopped: this process stopped serving its shards';

  it.each([
    ['lapse', 'ready'], ['lapse', 'timeout'], ['loss', 'ready'], ['loss', 'timeout'],
  ] as const)('clientReady before D, the barrier pending across the %s and then answering %s: no initializer, no panel recovery, no auto-updater, and its line', async (how, answer) => {
    const r = await onceRig(how);
    r.client.emit('clientReady');
    await tick(0);
    expect(r.lines).toEqual(['Logged in as bot#0001!']);
    await r.stop();
    r.barrier(answer);
    await tick(0);
    expect(r.calls).toEqual({ runInitializers: 0, recoverPanels: 0, startModuleAutoUpdater: 0 });
    expect(r.lines).toContain(NOT_STARTED);
    await r.end();
  });

  it.each(['lapse', 'loss'] as const)('the %s while panel recovery runs: the auto-updater does not start and the later line is logged', async how => {
    const r = await onceRig(how);
    r.client.emit('clientReady');
    await tick(0);
    r.barrier('ready');
    await tick(0);
    expect(r.calls).toEqual({ runInitializers: 1, recoverPanels: 1, startModuleAutoUpdater: 0 });
    await r.stop();
    r.recovered();
    await tick(0);
    expect(r.calls.startModuleAutoUpdater).toBe(0);
    expect(r.lines).toContain(STOPPED_AFTER);
    expect(r.lines).not.toContain(NOT_STARTED);
    await r.end();
  });

  it('serving throughout: the initializers, panel recovery and the auto-updater all run (control)', async () => {
    const r = await onceRig('lapse');
    r.client.emit('clientReady');
    await tick(0);
    r.barrier('ready');
    await tick(0);
    r.recovered();
    await tick(0);
    expect(r.calls).toEqual({ runInitializers: 1, recoverPanels: 1, startModuleAutoUpdater: 1 });
    await r.end();
  });
});

describe("a module reload or load (both run reloadModule)", () => {
  function fakeModule(name: string, onLoad?: () => Promise<void>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-nb4-mod-'));
    h.manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(h.manifestPath, JSON.stringify({ name, displayName: name, version: '1.0.0' }));
    const calls = { initialize: 0, onLoad: 0, onReady: 0 };
    h.module = {
      manifest: { name, displayName: name, version: '1.0.0' }, path: dir, events: new Map(), panels: [], exports: new Map(), initialized: false,
      commands: [{ name: `${name}-cmd`, initialize: () => { calls.initialize += 1; } }],
      hooks: {
        onLoad: async () => { calls.onLoad += 1; await onLoad?.(); },
        onReady: async () => { calls.onReady += 1; },
      },
    };
    return calls;
  }
  const compileDone = () => { for (const cb of h.compiles.splice(0)) cb(null, { stdout: '', stderr: '' }); };

  it.each(['lapse', 'loss'] as const)('a compile that ends after the %s registers nothing, calls no initialize or onLoad and answers the text', async how => {
    const d = await deadline(how);
    const name = `nb4mod-compile-${how}`;
    const calls = fakeModule(name);
    const reload = reloadModule({} as any, name);
    await vi.waitFor(() => expect(h.compiles).toHaveLength(1));
    await d.stop();
    compileDone();
    const result = await reload;
    expect(result).toMatchObject({ success: false, error: 'This bot process stopped serving its shards (its claims lapsed or a shard was lost) and restarts once its unsaved changes are saved or reported in its log; try again after the restart' });
    expect(calls).toEqual({ initialize: 0, onLoad: 0, onReady: 0 });
    expect(getModuleRegistry().getModule(name)).toBeUndefined();
    await d.end();
  });

  it.each(['lapse', 'loss'] as const)('an onLoad whose await crosses the %s calls no onReady and answers the text', async how => {
    const d = await deadline(how);
    let loaded: () => void = () => undefined;
    const name = `nb4mod-onload-${how}`;
    const calls = fakeModule(name, () => new Promise<void>(resolve => { loaded = resolve; }));
    const reload = reloadModule({} as any, name);
    await vi.waitFor(() => expect(h.compiles).toHaveLength(1));
    compileDone();
    await vi.waitFor(() => expect(calls.onLoad).toBe(1));
    await d.stop();
    loaded();
    const result = await reload;
    expect(result).toMatchObject({ success: false, error: STOPPED_SERVING_TEXT });
    expect(calls.onReady).toBe(0);
    await d.end();
  });

  it('serving throughout: the module loads and its hooks run (control)', async () => {
    const d = await deadline('lapse');
    const name = 'nb4mod-control';
    const calls = fakeModule(name);
    const reload = reloadModule({} as any, name);
    await vi.waitFor(() => expect(h.compiles).toHaveLength(1));
    compileDone();
    const loadedResult = await reload;
    expect(loadedResult.error).toBeUndefined();
    expect(loadedResult).toMatchObject({ success: true });
    expect(calls).toEqual({ initialize: 1, onLoad: 1, onReady: 1 });
    await d.end();
  });
});

describe('a console invoke and a panel action whose hold crosses D', () => {
  async function heldGuild(how: 'lapse' | 'loss') {
    setBackendKind('postgres');
    const data = new FakeStore();
    const ws = initWorkingSet(data);
    const driver = initDataReadiness(data, ws, { held: false });
    data.listOwnedGuilds = async () => [];
    const d = await deadline(how, () => driver.onLeaseChanged({ nodeId: 'node-a', processId: 'p-a', claims: {}, shardCount: 2, shardIds: [] }));
    const leaseClaims: Record<number, number> = {};
    for (const p of d.taken.pairs) leaseClaims[p.shardId] = p.claim;
    driver.onLeaseChanged({ nodeId: 'node-a', processId: 'p-a', claims: leaseClaims, shardCount: 2, shardIds: Object.keys(leaseClaims).map(Number) });
    data.hydrateMode = 'held';
    driver.causeOf(G0, 0);
    await vi.waitFor(() => expect(ws.stateOf(G0)).toBe('hydrating'));
    return { ...d, data, driver, end: async () => { await d.end(); driver.stop(); } };
  }

  it.each(['lapse', 'loss'] as const)("'command:invoke': the hold started before the %s answers not-served and runs no command", async how => {
    const r = await heldGuild(how);
    h.client = { isReady: () => true, guilds: { cache: new Map([[G0, { members: { cache: new Map(), me: null } }]]) }, users: { cache: new Map() }, user: { id: 'bot' } };
    const invoke = handleInvoke({ command: 'ping', guildId: G0 });
    await tick(20);
    await r.stop();
    r.data.releaseHydrations('ok');
    const answer = await invoke;
    expect(answer).toEqual({ success: false, ran: false, error: `guild ${G0}'s data is not served by this bot process right now; try again in a moment` });
    expect(h.handleCommands).toBe(0);
    await r.end();
  });

  it.each(['lapse', 'loss'] as const)("'panel:execute': the hold started before the %s answers not-served and runs no panel code", async how => {
    const r = await heldGuild(how);
    const panelManager = { getPanel: () => undefined, handlePanelExecute: vi.fn(), getWebUIPanelList: vi.fn() };
    const action = runPanelAction('panel:execute', { guildId: G0, panelId: 'p' }, panelManager);
    await tick(20);
    await r.stop();
    r.data.releaseHydrations('ok');
    expect(await action).toEqual({ success: false, ran: false, error: gateCauseText('not-served') });
    expect(panelManager.handlePanelExecute).not.toHaveBeenCalled();
    expect(panelManager.getWebUIPanelList).not.toHaveBeenCalled();
    await r.end();
  });
});

describe("the update panel's auto-check", () => {
  it.each(['lapse', 'loss'] as const)('an update check that answers after the %s sends no panel edit; one that answers while serving does', async how => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    for (const crosses of [true, false]) {
      const d = await deadline(how);
      const client = { guilds: { cache: new Map() }, channels: { fetch: async () => ({ isTextBased: () => true }) } } as any;
      await recoverPersistentPanels(client);
      await vi.waitFor(() => expect(h.updateCheck).not.toBeNull());
      if (crosses) await d.stop();
      h.updateCheck!({ success: true });
      await tick(10);
      expect(h.panelEdits).toBe(crosses ? 0 : 1);
      h.updateCheck = null;
      h.panelEdits = 0;
      await d.end();
      setStoppedServingHook(null);
    }
  });
});

describe('a dataContract 2 module after D', () => {
  it.each(['lapse', 'loss'] as const)("its reply after the %s carries the 'frozen' text, not its payload", async how => {
    setManifestReader(name => (name === 'flagmod' ? { dataContract: 2 } : undefined));
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    const d = await deadline(how);
    const { error } = await emit(rawCommand(`nb4dc-${how}`), i => withModule('flagmod', async () => {
      await d.stop();
      try { saveData('x.json', options, { v: 1 }); } catch { /* the module does not look at the refusal */ }
      await i.reply({ content: 'Saved!' });
    }));
    expect(error).toBeUndefined();
    await tick(50);
    expect(wire.map(textOf)).toEqual([truthText('frozen', false)]);
    expect(store.doc(options.guildId, 'x.json')).toBeUndefined();
    await d.end();
  });
});

describe('IPC requests that run module code, sent through the installed handlers', () => {
  const REQUESTS = [
    ['module:reload', { moduleName: 'nb4ipc' }],
    ['module:reload-all', { moduleNames: ['nb4ipc'] }],
    ['module:load', { moduleName: 'nb4ipc' }],
    ['module:unload', { moduleName: 'nb4ipc' }],
    ['component:toggle', { module: 'nb4ipc', componentType: 'bogus', name: 'n', enabled: false }],
    ['command:invoke', { command: 'ping' }],
    ['panel:execute', { panelId: 'p', userId: 'u-1' }],
  ] as const;

  async function installed() {
    const sent: Array<{ requestId: string; data: any }> = [];
    const hadSend = process.send;
    (process as any).send = (message: { requestId: string; data: any }) => { sent.push(message); return true; };
    const before = process.listeners('message');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const panelExecute = vi.fn(async () => ({ success: true }));
    h.panelManager = { getClient: () => h.client, getPanel: () => undefined, executePanelForWebUI: panelExecute, getWebUIPanelList: vi.fn() };
    h.client = { isReady: () => true, guilds: { cache: new Map() }, users: { cache: new Map() }, user: { id: 'bot' } };
    setupReloadIPCHandlers({} as any);
    setupToggleIPCHandlers({} as any);
    setupCommandIPCHandlers();
    setupPanelIPCHandlers();
    const send = (type: string, data: object, requestId: string) => process.emit('message' as any, { type, requestId, data } as any);
    const repliesTo = (requestId: string) => sent.filter(m => m.requestId === requestId).map(m => m.data);
    const uninstall = () => {
      for (const listener of process.listeners('message')) if (!before.includes(listener)) process.off('message', listener as any);
      (process as any).send = hadSend;
    };
    return { send, repliesTo, panelExecute, uninstall };
  }

  it.each(['lapse', 'loss'] as const)('after the %s, each request gets the stopped-serving text once and no module, command or panel code runs', async how => {
    const d = await deadline(how);
    const ipc = await installed();
    try {
      await d.stop();
      expect(stoppedServing()).toBe(true);
      for (const [type, data] of REQUESTS) ipc.send(type, data, `${how}-${type}`);
      await tick(50);
      for (const [type] of REQUESTS) {
        const refusal = type === 'command:invoke' ? { success: false, error: STOPPED_SERVING_TEXT, ran: false } : { success: false, error: STOPPED_SERVING_TEXT };
        expect(ipc.repliesTo(`${how}-${type}`)).toEqual([refusal]);
      }
      expect(h.compiles).toHaveLength(0);
      expect(h.handleCommands).toBe(0);
      expect(ipc.panelExecute).not.toHaveBeenCalled();
    } finally {
      ipc.uninstall();
      await d.end();
    }
  });

  it('serving: the same requests reach their handlers (control)', async () => {
    const d = await deadline('lapse');
    const ipc = await installed();
    try {
      for (const [type, data] of REQUESTS) ipc.send(type, data, `serving-${type}`);
      await vi.waitFor(() => expect(h.compiles.length).toBeGreaterThan(0));
      for (const cb of h.compiles.splice(0)) cb(new Error('compile stopped by the test'));
      await vi.waitFor(() => expect(h.handleCommands).toBe(1));
      expect(ipc.panelExecute).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(ipc.repliesTo('serving-component:toggle')).toEqual([{ success: false, error: 'Unknown component type: bogus' }]));
      for (const [type] of REQUESTS) {
        for (const reply of ipc.repliesTo(`serving-${type}`)) expect(reply).not.toEqual({ success: false, error: STOPPED_SERVING_TEXT });
      }
    } finally {
      for (const cb of h.compiles.splice(0)) cb(new Error('compile stopped by the test'));
      ipc.uninstall();
      await d.end();
    }
  });
});
