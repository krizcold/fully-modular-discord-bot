import { ActivityType, Events, InteractionResponseType, InteractionType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushAll, saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { DataBackendUnavailableError } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { admitGuildAction, dataUnavailableMessage, gateCauseText, gateEventDispatch } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import {
  _resetMaintenance,
  _setMaintenanceSender,
  enterMaintenance,
  handleMaintenanceIpc,
  installMaintenanceGate,
  maintenanceIpcRefusal,
  MAINTENANCE_PRESENCE,
} from '../../src/bot/internalSetup/utils/maintenance';
import { DEFAULT_MAINTENANCE_MESSAGE, isMaintenanceGateClosed, maintenanceText, runTracked } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { base, callbackType, EPHEMERAL, rawCommand, rig, storeGuild, textOf, tick } from '../helpers/gateRig';

// NB2 rulings 3 and 9 in the bot process: the gate, the refusal of guild writes, the save before the answer, the
// status. The hook's web side is nb2Hook.test.ts.

const sent: any[] = [];
let ids = 0;
const nextId = () => `nb2g-${++ids}`;

beforeEach(() => {
  _resetMaintenance();
  sent.length = 0;
  _setMaintenanceSender(message => { sent.push(message); });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  _resetMaintenance();
  _setMaintenanceSender(null);
  vi.restoreAllMocks();
});

function gatedRig() {
  const r = rig();
  installMaintenanceGate(r.client);
  return r;
}

/** Hands one raw interaction to discord.js as the gateway would, so it goes through client.emit. */
function deliver(client: any, raw: object): void {
  client.actions.InteractionCreate.handle(raw);
}

const rawAutocomplete = (id: string) => ({ ...base(id), type: InteractionType.ApplicationCommandAutocomplete, data: { id: '12', name: 'ping', type: 1, options: [] } });

describe('ruling 3: the gate', () => {
  it('an interaction after the gate closes gets the message, ephemeral, and no listener runs', async () => {
    const { client, wire } = gatedRig();
    const listener = vi.fn();
    client.on(Events.InteractionCreate, listener);
    await enterMaintenance('Back at 18:00.');
    deliver(client, rawCommand(nextId()));
    await tick(50);
    expect(listener).not.toHaveBeenCalled();
    expect(wire).toHaveLength(1);
    expect(callbackType(wire[0])).toBe(InteractionResponseType.ChannelMessageWithSource);
    expect(textOf(wire[0])).toBe('Back at 18:00.');
    expect(wire[0].body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
  });

  it('an autocomplete gets an empty list', async () => {
    const { client, wire } = gatedRig();
    await enterMaintenance('m');
    deliver(client, rawAutocomplete(nextId()));
    await tick(50);
    expect(wire).toHaveLength(1);
    expect(callbackType(wire[0])).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult);
    expect(wire[0].body.data.choices).toEqual([]);
  });

  it('module listeners of other events do not run; the payment bridge and the gateway lifecycle pass', async () => {
    const { client } = gatedRig();
    const message = vi.fn();
    const entitlement = vi.fn();
    const shard = vi.fn();
    client.on('messageCreate', message);
    client.on('entitlementCreate', entitlement);
    client.on('shardReady', shard);
    await enterMaintenance('m');
    client.emit('messageCreate', {} as any);
    client.emit('entitlementCreate', {} as any);
    client.emit('shardReady', 0, undefined);
    expect(message).not.toHaveBeenCalled();
    expect(entitlement).toHaveBeenCalledTimes(1);
    expect(shard).toHaveBeenCalledTimes(1);
  });

  it('the dispatch gate refuses what still reaches it (clientReady, an interaction held before the gate closed)', async () => {
    await enterMaintenance('m');
    expect(await gateEventDispatch('clientReady', [], () => undefined)).toBe(false);
    expect((await admitGuildAction('1', performance.now() + 100)).cause).toBe('maintenance');
    expect(gateCauseText('maintenance')).toBe('m');
  });

  it('every guild write after the gate closes is refused as maintenance, with its own text; a held write is saved before the answer', async () => {
    const { store, options } = await storeGuild();
    saveData('held.json', options, { v: 1 });
    expect(store.commits).toHaveLength(0);
    const answer = await enterMaintenance('m');
    expect(answer).toEqual({ saved: true });
    expect(store.commits).toHaveLength(1);
    let refusal: unknown;
    try { saveData('after.json', options, { v: 2 }); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(DataBackendUnavailableError);
    expect((refusal as DataBackendUnavailableError).causeKey).toBe('maintenance');
    expect(dataUnavailableMessage('maintenance')).toBe('The bot is in maintenance, so your change was not saved. Please try again later.');
    expect(truthText('maintenance', false)).toBe('The bot is in maintenance, so your change was not saved. Please try again later.');
    await tick(600);
    expect(store.commits).toHaveLength(1);
  });

  it('a global write still goes through (premium data is a global file)', async () => {
    await enterMaintenance('m');
    expect(saveData('g.json', { scope: 'global' }, { v: 1 })).toBe(true);
  });

  it('waits for an in-flight handler before it saves; the handler\'s late write is refused', async () => {
    const { store, options } = await storeGuild();
    let lateWrite: unknown = null;
    let handlerDone = 0;
    const handler = runTracked(async () => {
      await tick(150);
      try { saveData('late.json', options, { v: 1 }); } catch (error) { lateWrite = error; }
      handlerDone = Date.now();
    });
    const answer = await enterMaintenance('m');
    const answeredAt = Date.now();
    await handler;
    expect(answer).toEqual({ saved: true });
    expect(handlerDone).toBeGreaterThan(0);
    expect(answeredAt).toBeGreaterThanOrEqual(handlerDone);
    expect((lateWrite as DataBackendUnavailableError)?.causeKey).toBe('maintenance');
    expect(store.commits).toHaveLength(0);
  });

  it('answers saved false with the counts when the held changes cannot be saved', async () => {
    const { store, options } = await storeGuild();
    store.mode = 'unavailable';
    saveData('held.json', options, { v: 1 });
    const answer = await enterMaintenance('m', { saveBoundMs: 8000 });
    expect(answer).toEqual({ saved: false, unsavedGuilds: 1, unsavedFiles: 0 });
    store.mode = 'commit';
    await flushAll();
  }, 20_000);

  it('a second hook updates the message and the status without a restart', async () => {
    const { client, wire } = gatedRig();
    await enterMaintenance('first');
    expect(await enterMaintenance('second')).toEqual({ saved: true });
    expect(maintenanceText()).toBe('second');
    deliver(client, rawCommand(nextId()));
    await tick(50);
    expect(textOf(wire[0])).toBe('second');
    expect(sent.filter(m => m.type === 'control:restart-bot')).toHaveLength(0);
  });

  it('the IPC requests that run module code or write data are refused with the message; reads still run', async () => {
    expect(maintenanceIpcRefusal('command:invoke')).toBeNull();
    await enterMaintenance('Down for the move.');
    expect(maintenanceIpcRefusal('command:invoke')).toEqual({ success: false, maintenance: true, error: 'Down for the move.' });
    expect(maintenanceIpcRefusal('panel:action')).toEqual({ success: false, maintenance: true, error: 'Down for the move.' });
    expect(maintenanceIpcRefusal('data:guild-write')).toEqual({ ok: false, code: 'maintenance', error: 'Down for the move.' });
    expect(maintenanceIpcRefusal('data:guild-read')).toBeNull();
    expect(maintenanceIpcRefusal('metrics:global')).toBeNull();
  });

  it('maintenance:enter over IPC answers the save; a missing message is the default text', async () => {
    const reply = await handleMaintenanceIpc({ type: 'maintenance:enter', requestId: 'r1', data: {} });
    expect(reply).toEqual({ requestId: 'r1', data: { saved: true } });
    expect(isMaintenanceGateClosed()).toBe(true);
    expect(maintenanceText()).toBe(DEFAULT_MAINTENANCE_MESSAGE);
    expect(await handleMaintenanceIpc({ type: 'panel:list', requestId: 'r2', data: {} })).toBeNull();
  });
});

describe('ruling F (F4d): the metric totals timer', () => {
  it('does not flush while the gate is closed, and flushes once it is open', async () => {
    const { getMetricsCollector } = await import('../../src/bot/internalSetup/utils/metrics/metricsCollector');
    const { startSamplers, stopSamplers } = await import('../../src/bot/internalSetup/utils/metrics/samplers');
    const { FLUSH_MS } = await import('../../src/bot/internalSetup/utils/metrics/constants');
    const flush = vi.spyOn(getMetricsCollector(), 'flushTotals').mockImplementation(() => undefined);
    vi.spyOn(getMetricsCollector(), 'pushSample').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      startSamplers({ guilds: { cache: new Map() } } as any);
      await enterMaintenance('m');
      flush.mockClear();
      vi.advanceTimersByTime(FLUSH_MS);
      expect(flush).not.toHaveBeenCalled();
      _resetMaintenance();
      vi.advanceTimersByTime(FLUSH_MS);
      expect(flush).toHaveBeenCalledTimes(1);
    } finally {
      stopSamplers();
      vi.useRealTimers();
    }
  });
});

describe('ruling 9: the Discord status', () => {
  it('maintenance sets dnd with the custom status "Maintenance", now and for every later identify', async () => {
    const { client } = gatedRig();
    const setPresence = vi.fn();
    Object.defineProperty(client, 'user', { value: { setPresence }, configurable: true });
    expect(client.options.presence?.activities).toBeUndefined();
    await enterMaintenance('m');
    expect(MAINTENANCE_PRESENCE).toEqual({ status: 'dnd', activities: [{ name: 'Custom Status', type: ActivityType.Custom, state: 'Maintenance' }] });
    expect(setPresence).toHaveBeenCalledWith(MAINTENANCE_PRESENCE);
    expect(client.options.presence).toEqual(MAINTENANCE_PRESENCE);
    expect(sent).toContainEqual({ type: 'maintenance:mode', data: { mode: 'maintenance' } });
  });

  it('ruling E: a shard that identifies or resumes again while the gate is closed gets the maintenance status re-sent', async () => {
    const { client } = gatedRig();
    const shardSend = vi.fn();
    (client.ws as any).shards.set(0, { send: shardSend });
    client.emit('shardReady', 0, undefined);
    expect(shardSend).not.toHaveBeenCalled();
    await enterMaintenance('m');
    client.emit('shardReady', 0, undefined);
    client.emit('shardResume', 0, 0);
    const presence = { op: 3, d: { activities: [{ type: ActivityType.Custom, name: 'Custom Status', state: 'Maintenance', url: undefined }], afk: false, since: null, status: 'dnd' } };
    expect(shardSend.mock.calls).toEqual([[presence], [presence]]);
  });

  it('ruling E: a new identify carries the maintenance status', async () => {
    const { client } = gatedRig();
    await enterMaintenance('m');
    expect((client.options as any).ws.presence).toEqual({ activities: [{ type: ActivityType.Custom, name: 'Custom Status', state: 'Maintenance', url: undefined }], afk: false, since: null, status: 'dnd' });
  });

  it('running sets no presence', () => {
    const { client } = gatedRig();
    expect(client.options.presence).toEqual({ status: 'online', user: { id: null } });
  });
});
