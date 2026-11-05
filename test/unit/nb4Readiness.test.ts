import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initDataReadiness } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { admitGuildAction, dispatchGated, runAsAdmitted } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { setStoppedServingHook, STOPPED_SERVING_TEXT } from '../../src/bot/internalSetup/utils/servingGate';
import { _resetMaintenance, installMaintenanceGate, maintenanceIpcRefusal } from '../../src/bot/internalSetup/utils/maintenance';
import { recoverPersistentPanels } from '../../src/bot/internalSetup/utils/panel/persistentPanelRecovery';
import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { MemClaimStore } from '../helpers/fakeClaimStore';
import { FakeStore } from '../helpers/fakeStore';
import { setBackendKind } from '../helpers/backendKind';

// NB4 decisions 6, 17 and 18: per-shard fences, a freeze before any flush, and the stopped-serving answer asked at the
// moment a write is accepted or module code is called.

let stopped = false;
afterEach(() => {
  stopped = false;
  setStoppedServingHook(null);
  _resetMaintenance();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Two guilds on two shards of 2: (id >> 22) % 2.
const G0 = String(4n << 22n);
const G1 = String(5n << 22n);

function rig() {
  setBackendKind('postgres');
  const store = new FakeStore();
  const ws = initWorkingSet(store);
  const driver = initDataReadiness(store, ws, { held: false });
  store.listOwnedGuilds = async () => [];
  driver.onLeaseChanged({ nodeId: 'node-a', processId: 'p-a', claims: { 0: 11, 1: 12 }, shardCount: 2, shardIds: [0, 1] });
  return { store, ws, driver };
}

/** NB4 decision 6's deadline as shardBoot wires it: a real ShardClaims over a fake claims store, its clocks moved by the test. */
async function realDeadline() {
  const T = claimTimings(30);
  const skew = { perf: 0, wall: 0 };
  let stopSteps = 0;
  const claims = new ShardClaims({
    store: new MemClaimStore(() => Date.now()), me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' }, timings: T, capacity: 4,
    takeoverSeconds: 30, returns: true, restartable: true, startedAt: 0,
    clocks: () => ({ perf: performance.now() + skew.perf, wall: Date.now() + skew.wall }),
    fitness: () => null, gateClosed: () => false, isStopping: () => false,
    stopServingStep: () => { stopSteps += 1; },
    noteLapsed: () => undefined, noteLost: () => undefined, restartForShards: () => false,
    log: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  expect(await claims.firstRenewal()).toBe(true);
  expect(await claims.bootTake(async () => 2)).not.toBeNull();
  claims.noteGranted();
  setStoppedServingHook(() => claims.stoppedServing());
  return { skew, stopSteps: () => stopSteps, end: async () => { claims.beginStop(); await claims.finishStop(); } };
}

describe('per-shard fences', () => {
  it('two guilds on two shards hydrate under their own shard claim and the process id', async () => {
    const { store, ws, driver } = rig();
    const tokens: unknown[] = [];
    store.hydrateGuild = (async (guildId: string, token: unknown) => { tokens.push(token); return { ok: true, docs: [], appendKeys: [] }; }) as any;
    driver.causeOf(G0, 0);
    driver.causeOf(G1, 0);
    await vi.waitFor(() => expect(ws.stateOf(G1)).toBe('ready'));
    expect(tokens).toEqual(expect.arrayContaining([
      { nodeId: 'node-a', claim: 11, processId: 'p-a', shardId: 0, shardCount: 2 },
      { nodeId: 'node-a', claim: 12, processId: 'p-a', shardId: 1, shardCount: 2 },
    ]));
    driver.stop();
  });
});

describe('freeze first', () => {
  it('removing a shard freezes every one of its sets at once, while the first set\'s flush is still on the wire', async () => {
    const { store, ws, driver } = rig();
    const a = String(6n << 22n);
    for (const g of [G0, a]) driver.causeOf(g, 0);
    await vi.waitFor(() => expect(ws.stateOf(a)).toBe('ready'));
    expect(ws.save(G0, 'm', 'x.json', '1')).toBe('accepted');
    store.holding = true;
    driver.onLeaseChanged({ nodeId: 'node-a', processId: 'p-a', claims: { 1: 12 }, shardCount: 2, shardIds: [1] });
    expect(ws.save(a, 'm', 'y.json', '2')).toBe('frozen-window');
    expect(ws.save(G0, 'm', 'z.json', '3')).toBe('frozen-window');
    store.holding = false;
    store.release();
    driver.stop();
  });
});

describe('after D or a loss', () => {
  it('a write from a module answers frozen-window once the process stopped serving', async () => {
    const { ws, driver } = rig();
    driver.causeOf(G0, 0);
    await vi.waitFor(() => expect(ws.stateOf(G0)).toBe('ready'));
    setStoppedServingHook(() => stopped);
    expect(ws.save(G0, 'm', 'a.json', '1')).toBe('accepted');
    stopped = true;
    expect(ws.save(G0, 'm', 'b.json', '2')).toBe('frozen-window');
    expect(ws.append(G0, 'm', 'c.json', 'x')).toBe('frozen-window');
    driver.stop();
  });

  it('runAsAdmitted calls no handler; admitGuildAction answers not-served instead of admit', async () => {
    const { ws, driver } = rig();
    driver.causeOf(G0, 0);
    await vi.waitFor(() => expect(ws.stateOf(G0)).toBe('ready'));
    setStoppedServingHook(() => stopped);
    expect((await admitGuildAction(G0, performance.now() + 100)).cause).toBe('admit');
    stopped = true;
    expect((await admitGuildAction(G0, performance.now() + 100)).cause).toBe('not-served');
    const handler = vi.fn();
    runAsAdmitted([{}], handler);
    expect(handler).not.toHaveBeenCalled();
    driver.stop();
  });

  it('a messageCreate buffered while its guild hydrates, whose hydrate completes after D (the clocks moved, no timer run), reaches no handler through the dispatcher', async () => {
    const { store, ws, driver } = rig();
    const deadline = await realDeadline();
    store.hydrateMode = 'held';
    const dispatch = vi.fn(async () => {});
    const message = { guildId: G0 };
    const first = dispatchGated('messageCreate', [message], dispatch);
    await vi.waitFor(() => expect(ws.stateOf(G0)).toBe('hydrating'));
    deadline.skew.wall = 120_000;
    deadline.skew.perf = 1_000;
    store.releaseHydrations('ok');
    await first;
    await vi.waitFor(() => expect(ws.stateOf(G0)).toBe('ready'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(dispatch).not.toHaveBeenCalled();
    expect(deadline.stopSteps()).toBe(1);
    await deadline.end();
    driver.stop();
  });

  it('the client.emit wrapper reaches no listener (collectors included) but lets the passing events through', () => {
    setStoppedServingHook(() => stopped);
    const client = new EventEmitter() as any;
    client.on = client.on.bind(client);
    installMaintenanceGate(client);
    const seen: string[] = [];
    for (const event of ['messageCreate', 'interactionCreate', 'shardDisconnect', 'entitlementCreate']) client.on(event, () => seen.push(event));
    stopped = true;
    const reply = vi.fn();
    client.emit('messageCreate', { guildId: G0 });
    client.emit('interactionCreate', { isRepliable: () => true, reply });
    client.emit('shardDisconnect', {}, 0);
    client.emit('entitlementCreate', {});
    expect(seen).toEqual(['shardDisconnect', 'entitlementCreate']);
    expect(reply).not.toHaveBeenCalled();
  });

  it.each(['command:invoke', 'module:reload', 'module:reload-all', 'module:load', 'module:unload', 'component:toggle', 'panel:action'])(
    'the web UI request %s gets the stopped-serving text with the gate open', type => {
      setStoppedServingHook(() => stopped);
      expect(maintenanceIpcRefusal(type)).toBeNull();
      stopped = true;
      expect(maintenanceIpcRefusal(type)).toEqual({ success: false, error: STOPPED_SERVING_TEXT });
    });

  it('on a JSON bot (no hook) none of these is refused', () => {
    expect(maintenanceIpcRefusal('module:reload')).toBeNull();
  });

  it('panel recovery after the stop reads no storage and fetches no panel', async () => {
    setStoppedServingHook(() => true);
    const fetch = vi.fn();
    const client = { guilds: { cache: new Map([[G0, {}], [G1, {}]]) }, channels: { fetch } } as any;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await recoverPersistentPanels(client);
    expect(fetch).not.toHaveBeenCalled();
    expect(log.mock.calls.map(c => String(c[0]))).not.toContain('[PersistentPanelRecovery] Panel recovery complete');
  });
});
