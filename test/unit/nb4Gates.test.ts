import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// NB4 decision 6: every gate asks the shard claims' own deadline at the moment of use, and module code started by the
// framework checks it again after each await. The deadline here is a real ShardClaims over a fake claims store, its
// clocks moved by the test with no timer run (a process that froze and woke up past D).

const panels = vi.hoisted(() => ({
  pending: null as null | (() => void),
  loads: [] as Array<string | undefined>,
}));
vi.mock('../../src/bot/internalSetup/utils/panel/persistentPanelStorage', async orig => ({
  ...(await orig<any>()),
  loadPersistentPanels: async (guildId?: string) => {
    panels.loads.push(guildId);
    if (guildId === undefined) return {};
    if (guildId === '1') await new Promise<void>(resolve => { panels.pending = resolve; });
    return { [`panel-${guildId}`]: { messageId: 'm', channelId: 'c', guildId } };
  },
}));
const updater = vi.hoisted(() => ({ installedReads: 0 }));
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => ({
  ...(await orig<any>()),
  getAppStoreManager: () => ({
    getInstalledModules: () => { updater.installedReads += 1; return []; },
  }),
}));

import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { LeaseRuntime } from '../../src/bot/internalSetup/fleet/leaseRuntime';
import type { IngestService } from '../../src/bot/internalSetup/ingest/ingestService';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { initDataReadiness } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { admitGuildAction, dispatchGated, gateCauseText, runAsAdmitted } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import { _resetMaintenance, installMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenance';
import { recoverPersistentPanels } from '../../src/bot/internalSetup/utils/panel/persistentPanelRecovery';
import { startModuleAutoUpdater, stopModuleAutoUpdater } from '../../src/bot/internalSetup/utils/moduleAutoUpdater';
import { getModuleEventManager } from '../../src/bot/internalSetup/utils/moduleEventManager';
import { dataPath } from '../../src/utils/dataRoot';
import { FakeStore } from '../helpers/fakeStore';
import { MemClaimStore } from '../helpers/fakeClaimStore';
import { setBackendKind } from '../helpers/backendKind';

const T = claimTimings(30);
const G0 = String(4n << 22n);

afterEach(() => {
  setStoppedServingHook(null);
  _resetMaintenance();
  stopModuleAutoUpdater();
  panels.pending = null;
  panels.loads = [];
  updater.installedReads = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function servingRig() {
  setBackendKind('postgres');
  const data = new FakeStore();
  const ws = initWorkingSet(data);
  const driver = initDataReadiness(data, ws, { held: false });
  data.listOwnedGuilds = async () => [];
  const skew = { perf: 0, wall: 0 };
  const calls = { stopStep: 0, lapsed: 0 };
  const claimStore = new MemClaimStore(() => Date.now());
  const ingest = {
    setShardPlan: () => undefined, isStarted: () => false, start: async () => 'ok', stop: async () => undefined, getClient: () => null,
  } as unknown as IngestService;
  const runtime = new LeaseRuntime(ingest);
  const claims = new ShardClaims({
    store: claimStore, me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' }, timings: T, capacity: 4,
    takeoverSeconds: 30, returns: true, restartable: true, startedAt: 0,
    clocks: () => ({ perf: performance.now() + skew.perf, wall: Date.now() + skew.wall }),
    fitness: () => null, gateClosed: () => false, isStopping: () => false,
    stopServingStep: () => {
      calls.stopStep += 1;
      runtime.stopServing(T.ttlMs / 3);
    },
    noteLapsed: () => { calls.lapsed += 1; }, noteLost: () => undefined, restartForShards: () => false,
    log: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  expect(await claims.firstRenewal()).toBe(true);
  const taken = await claims.bootTake(async () => 2);
  // As shardBoot wires it: the grant, then the deadline hook.
  await runtime.applyGrant({ processId: 'p-a', shardCount: 2, leases: taken!.pairs.map(p => ({ leaseId: `l${p.shardId}`, shardId: p.shardId, claim: p.claim })) });
  claims.noteGranted();
  setStoppedServingHook(() => claims.stoppedServing());
  const end = async () => { claims.beginStop(); await claims.finishStop(); driver.stop(); };
  return { data, ws, driver, claims, skew, calls, end };
}

describe('the gates ask the real deadline (T3)', () => {
  it('both clocks past D and no timer run: a write answers frozen-window, an event reaches no listener, and the lapse step runs once', async () => {
    const r = await servingRig();
    r.driver.causeOf(G0, 0);
    await vi.waitFor(() => expect(r.ws.stateOf(G0)).toBe('ready'));
    expect(r.ws.save(G0, 'm', 'a.json', '1')).toBe('accepted');
    const client = new EventEmitter() as any;
    installMaintenanceGate(client);
    const seen: string[] = [];
    client.on('messageCreate', () => seen.push('messageCreate'));
    client.on('interactionCreate', () => seen.push('interactionCreate'));
    r.skew.wall = 120_000;
    r.skew.perf = 1_000;
    expect(r.ws.save(G0, 'm', 'b.json', '2')).toBe('frozen-window');
    expect(r.calls.stopStep).toBe(1);
    expect(r.calls.lapsed).toBe(1);
    const reply = vi.fn();
    client.emit('messageCreate', { guildId: G0 });
    client.emit('interactionCreate', { guildId: G0, isRepliable: () => true, reply });
    expect(seen).toEqual([]);
    expect(reply).not.toHaveBeenCalled();
    expect(r.ws.save(G0, 'm', 'c.json', '3')).toBe('frozen-window');
    expect(r.calls.stopStep).toBe(1);
    expect(r.calls.lapsed).toBe(1);
    await r.end();
  });

  it('a hold that starts before D and whose set turns ready after D answers not-served', async () => {
    const r = await servingRig();
    r.data.hydrateMode = 'held';
    r.driver.causeOf(G0, 0);
    await vi.waitFor(() => expect(r.ws.stateOf(G0)).toBe('hydrating'));
    const hold = admitGuildAction(G0, performance.now() + 5_000);
    await new Promise(resolve => setTimeout(resolve, 20));
    r.skew.wall = 120_000;
    r.data.releaseHydrations('ok');
    expect((await hold).cause).toBe('not-served');
    expect(r.calls.stopStep).toBe(1);
    await r.end();
  });

  it('a hold whose set never turns ready and that polls after the lapse step answers not-served at its deadline', async () => {
    const r = await servingRig();
    r.data.hydrateMode = 'held';
    r.driver.causeOf(G0, 0);
    await vi.waitFor(() => expect(r.ws.stateOf(G0)).toBe('hydrating'));
    const hold = admitGuildAction(G0, performance.now() + 600);
    await new Promise(resolve => setTimeout(resolve, 20));
    r.skew.wall = 120_000;
    r.skew.perf = 1_000;
    expect(r.claims.stoppedServing()).toBe(true);
    expect(r.calls.stopStep).toBe(1);
    expect(await hold).toEqual({ cause: 'not-served', mark: null });
    expect(r.ws.stateOf(G0)).not.toBe('ready');
    r.data.releaseHydrations('ok');
    await r.end();
  });

  it('the same hold on the interaction path sends one reply, the not-served text, and calls no handler', async () => {
    const r = await servingRig();
    r.data.hydrateMode = 'held';
    r.driver.causeOf(G0, 0);
    await vi.waitFor(() => expect(r.ws.stateOf(G0)).toBe('hydrating'));
    const reply = vi.fn(async () => undefined);
    const interaction = { guildId: G0, isRepliable: () => true, replied: false, deferred: false, reply };
    const handler = vi.fn(async () => undefined);
    const dispatched = dispatchGated('interactionCreate', [interaction], handler);
    await new Promise(resolve => setTimeout(resolve, 20));
    r.skew.wall = 120_000;
    r.skew.perf = 1_000;
    expect(r.claims.stoppedServing()).toBe(true);
    await dispatched;
    expect(handler).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect((reply.mock.calls[0] as any[])[0].content).toBe(gateCauseText('not-served'));
    expect(gateCauseText('not-served')).toBe("This server's data is not served by this bot process right now; please try again in a moment.");
    r.data.releaseHydrations('ok');
    await r.end();
  });

  it('an interaction admitted before D whose handler call comes after D runs no handler and gets no reply', async () => {
    const r = await servingRig();
    r.driver.causeOf(G0, 0);
    await vi.waitFor(() => expect(r.ws.stateOf(G0)).toBe('ready'));
    const reply = vi.fn(async (_payload: unknown) => undefined);
    const interaction = { guildId: G0, isRepliable: () => true, replied: false, deferred: false, reply };
    const handler = vi.fn(async () => { await interaction.reply({ content: 'Saved!' }); });
    // The hold admits synchronously inside this call, before D; the handler call waits for the next microtask.
    const dispatched = dispatchGated('interactionCreate', [interaction], handler);
    r.skew.wall = 120_000;
    r.skew.perf = 1_000;
    await dispatched;
    const direct = vi.fn();
    expect(runAsAdmitted([interaction], direct)).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(handler).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(r.calls.stopStep).toBe(1);
    await r.end();
  });
});

describe('a module listener asks the real deadline (unit 4)', () => {
  afterEach(() => { getModuleEventManager().removeAllListeners(); });

  function moduleClient() {
    const client = new EventEmitter() as any;
    installMaintenanceGate(client);
    const manager = getModuleEventManager();
    manager.setClient(client);
    const ran: string[] = [];
    manager.registerListener('nb4-probe', 'messageCreate', async () => { ran.push('messageCreate'); });
    manager.registerListener('nb4-probe', 'interactionCreate', async (_c: unknown, interaction: any) => {
      ran.push('interactionCreate');
      await interaction.reply({ content: 'Saved!' });
    });
    return { client, ran };
  }

  it('a messageCreate buffered while its guild hydrates, whose hydrate completes after D: the replay reaches no module handler', async () => {
    const r = await servingRig();
    const { client, ran } = moduleClient();
    r.data.hydrateMode = 'held';
    client.emit('messageCreate', { guildId: G0, content: 'x' });
    await vi.waitFor(() => expect(r.ws.stateOf(G0)).toBe('hydrating'));
    r.skew.wall = 120_000;
    r.skew.perf = 1_000;
    r.data.releaseHydrations('ok');
    await vi.waitFor(() => expect(r.ws.stateOf(G0)).not.toBe('hydrating'));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(ran).toEqual([]);
    expect(r.calls.stopStep).toBe(1);
    expect(r.calls.lapsed).toBe(1);
    await r.end();
  });

  it('the same replay with the clocks unmoved reaches the module handler once (control)', async () => {
    const r = await servingRig();
    const { client, ran } = moduleClient();
    r.data.hydrateMode = 'held';
    client.emit('messageCreate', { guildId: G0, content: 'x' });
    await vi.waitFor(() => expect(r.ws.stateOf(G0)).toBe('hydrating'));
    r.data.releaseHydrations('ok');
    await vi.waitFor(() => expect(ran).toEqual(['messageCreate']));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(ran).toEqual(['messageCreate']);
    expect(r.calls.stopStep).toBe(0);
    await r.end();
  });

  it('an interaction whose hold starts before D and whose set turns ready after D: no module handler runs and one reply carries the not-served text', async () => {
    const r = await servingRig();
    const { client, ran } = moduleClient();
    r.data.hydrateMode = 'held';
    r.driver.causeOf(G0, 0);
    await vi.waitFor(() => expect(r.ws.stateOf(G0)).toBe('hydrating'));
    const reply = vi.fn(async (_payload: unknown) => undefined);
    client.emit('interactionCreate', { guildId: G0, isRepliable: () => true, replied: false, deferred: false, reply });
    await new Promise(resolve => setTimeout(resolve, 20));
    r.skew.wall = 120_000;
    r.skew.perf = 1_000;
    r.data.releaseHydrations('ok');
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(ran).toEqual([]);
    expect(reply).toHaveBeenCalledTimes(1);
    expect((reply.mock.calls[0] as any[])[0].content).toBe(gateCauseText('not-served'));
    expect(r.calls.stopStep).toBe(1);
    await r.end();
  });

  it('an interaction admitted before D whose module handler call comes after D runs no handler and gets no reply', async () => {
    const r = await servingRig();
    const { client, ran } = moduleClient();
    r.driver.causeOf(G0, 0);
    await vi.waitFor(() => expect(r.ws.stateOf(G0)).toBe('ready'));
    const reply = vi.fn(async (_payload: unknown) => undefined);
    client.emit('interactionCreate', { guildId: G0, isRepliable: () => true, replied: false, deferred: false, reply });
    r.skew.wall = 120_000;
    r.skew.perf = 1_000;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(ran).toEqual([]);
    expect(reply).not.toHaveBeenCalled();
    expect(r.calls.stopStep).toBe(1);
    await r.end();
  });

  it('the same interaction with the clocks unmoved runs the module handler once (control)', async () => {
    const r = await servingRig();
    const { client, ran } = moduleClient();
    r.driver.causeOf(G0, 0);
    await vi.waitFor(() => expect(r.ws.stateOf(G0)).toBe('ready'));
    const reply = vi.fn(async (_payload: unknown) => undefined);
    client.emit('interactionCreate', { guildId: G0, isRepliable: () => true, replied: false, deferred: false, reply });
    await vi.waitFor(() => expect(ran).toEqual(['interactionCreate']));
    expect(reply.mock.calls.map(c => (c as any[])[0].content)).toEqual(['Saved!']);
    expect(r.calls.stopStep).toBe(0);
    await r.end();
  });
});

describe('module code started by the framework (T12)', () => {
  it('panel recovery: the deadline passing while the first guild\'s storage read is pending fetches no panel of any guild after it', async () => {
    let stopped = false;
    setStoppedServingHook(() => stopped);
    const fetch = vi.fn(async () => null);
    const client = { guilds: { cache: new Map([['1', {}], ['2', {}], ['3', {}]]) }, channels: { fetch } } as any;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const walk = recoverPersistentPanels(client);
    await vi.waitFor(() => expect(panels.pending).not.toBeNull());
    stopped = true;
    panels.pending!();
    await walk;
    expect(panels.loads).toEqual([undefined, '1']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('panel recovery that stays serving walks every guild (control)', async () => {
    setStoppedServingHook(() => false);
    const fetch = vi.fn(async () => null);
    const client = { guilds: { cache: new Map([['1', {}], ['2', {}], ['3', {}]]) }, channels: { fetch } } as any;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const walk = recoverPersistentPanels(client);
    await vi.waitFor(() => expect(panels.pending).not.toBeNull());
    panels.pending!();
    await walk;
    expect(panels.loads).toEqual([undefined, '1', '2', '3']);
  });

  it('an auto-updater tick after the deadline runs no update check; one while serving does', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const config = dataPath('global', 'appstore', 'config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ autoUpdate: true }));
    let stopped = true;
    setStoppedServingHook(() => stopped);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    startModuleAutoUpdater({} as any);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(updater.installedReads).toBe(0);
    stopped = false;
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(updater.installedReads).toBe(1);
  });
});
