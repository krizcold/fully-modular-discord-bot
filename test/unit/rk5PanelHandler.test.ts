import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pm = vi.hoisted(() => ({ manager: null as any }));

vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  return { ...real, getPanelManager: () => pm.manager };
});

import { Status } from 'discord.js';
import { setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import {
  answerPanelMessage,
  cacheIncomplete,
  CHANNEL_INVALID,
  NOT_HELD,
  runsFromRequest,
  SERVER_NOT_READY,
  _bucketCount,
  _resetPanelHandler,
} from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { setBackendKind } from '../helpers/backendKind';
import { fakeClock, NOT_LEASED, readinessRig, stopDrivers } from '../helpers/readinessRig';

const GUILD = '4194304';
const CHANNEL = '222222222222222222';
const VIEW = { success: true, data: { content: 'View' } };
const RATE_TEXT = 'Rate limit exceeded. Please wait before trying again.';

function client(over: Record<string, any> = {}) {
  return {
    guilds: { cache: new Map<string, any>([[GUILD, { id: GUILD, available: true }]]) },
    channels: { cache: new Map<string, any>(), fetch: vi.fn(async () => null) },
    ws: { shards: new Map<number, any>() },
    ...over,
  };
}

function manager(...given: any[]) {
  const c = given.length ? given[0] : client();
  return {
    getClient: () => c,
    getPanel: () => undefined,
    getWebUIPanelList: vi.fn(() => [{ id: 'p', scope: 'guild' }]),
    executePanelForWebUI: vi.fn(async () => VIEW),
    handleWebUIButton: vi.fn(async () => VIEW),
  };
}

function execute(userId: string, extra: Record<string, unknown> = {}) {
  return answerPanelMessage('panel:execute', { panelId: 'p', userId, guildId: GUILD, channelId: CHANNEL, ...extra }, 'ipc');
}

beforeEach(() => {
  pm.manager = manager();
  setBackendKind('file');
});

afterEach(() => {
  _resetPanelHandler();
  setMaintenanceGate(null);
  setStoppedServingHook(null);
  setBackendKind(null);
  stopDrivers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('dev:check skips the server checks', () => {
  it('dev:check for a guild this bot does not hold answers the dev status, not not-held', async () => {
    const guildId = readinessRig(NOT_LEASED).guild();
    expect(await answerPanelMessage('panel:list', { guildId }, 'ipc')).toEqual(NOT_HELD);
    expect(await answerPanelMessage('dev:check', { userId: 'u1', guildId }, 'ipc')).toEqual({ success: true, isDev: false });
  });
});

describe('the rate limit', () => {
  it.each(['panel:list', 'dev:check', 'bot:guilds', 'panel:live'])('%s with a user id takes no token, however often it is sent', async type => {
    for (let i = 0; i < 7; i++) {
      const answer = await answerPanelMessage(type, { userId: 'reader' }, 'ipc');
      expect(answer?.error ?? '').not.toBe(RATE_TEXT);
    }
    expect(_bucketCount()).toBe(0);
  });

  it('panel:list with no data answers its list', async () => {
    expect(await answerPanelMessage('panel:list', undefined, 'ipc')).toEqual({ success: true, panels: [{ id: 'p', scope: 'guild' }] });
    expect(_bucketCount()).toBe(0);
  });

  it('an action with no user id takes no token and answers its missing-field error each time', async () => {
    for (let i = 0; i < 7; i++) {
      expect(await answerPanelMessage('panel:execute', { panelId: 'p' }, 'ipc')).toEqual({ success: false, error: 'Missing required fields: panelId and userId' });
    }
    expect(_bucketCount()).toBe(0);
  });

  it('the sixth action within a second answers the rate limit with ran false, runs nothing and logs the user', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let i = 0; i < 5; i++) expect(await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'busy' }, 'ipc')).toEqual(VIEW);
    expect(await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'busy' }, 'ipc')).toEqual({ success: false, ran: false, error: RATE_TEXT });
    expect(pm.manager.executePanelForWebUI).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledWith('[IPCPanelHandler] Rate limit exceeded for user busy');
  });
});

describe('a handler that throws', () => {
  it('an Error answers its message and is logged with the message type', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = new Error('boom');
    pm.manager.getWebUIPanelList = () => { throw boom; };
    expect(await answerPanelMessage('panel:list', {}, 'ipc')).toEqual({ success: false, error: 'boom' });
    expect(error).toHaveBeenCalledWith('[IPCPanelHandler] Error handling IPC message panel:list:', boom);
  });

  it('a thrown non-Error answers Unknown error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pm.manager.getWebUIPanelList = () => { throw 'text'; };
    expect(await answerPanelMessage('panel:list', {}, 'ipc')).toEqual({ success: false, error: 'Unknown error' });
  });
});

describe('the channel check with a partial client', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('a panel manager with no getClient answers not-ready and runs nothing', async () => {
    const m: any = manager();
    delete m.getClient;
    pm.manager = m;
    expect(await execute('u1')).toEqual(SERVER_NOT_READY);
    expect(m.executePanelForWebUI).not.toHaveBeenCalled();
  });

  it.each([
    ['no client', undefined],
    ['a client with no guilds', {}],
    ['guilds with no cache', { guilds: {} }],
  ])('%s answers not-ready and runs nothing', async (_what, c) => {
    pm.manager = manager(c);
    expect(await execute('u1')).toEqual(SERVER_NOT_READY);
    expect(pm.manager.executePanelForWebUI).not.toHaveBeenCalled();
  });

  it('a guild marked unavailable answers not-ready even when the channel is cached as its own', async () => {
    const c = client({
      guilds: { cache: new Map([[GUILD, { id: GUILD, available: false }]]) },
      channels: { cache: new Map([[CHANNEL, { guildId: GUILD }]]), fetch: vi.fn(async () => ({ guildId: GUILD })) },
    });
    pm.manager = manager(c);
    expect(await execute('u1')).toEqual(SERVER_NOT_READY);
    expect(pm.manager.executePanelForWebUI).not.toHaveBeenCalled();
  });

  it('channels with no cache are fetched: a channel of this guild runs', async () => {
    const fetch = vi.fn(async () => ({ guildId: GUILD }));
    pm.manager = manager(client({ channels: { fetch } }));
    expect(await execute('u1')).toEqual(VIEW);
    expect(fetch).toHaveBeenCalledWith(CHANNEL);
  });

  it('a client with no channels answers not-ready and runs nothing', async () => {
    const c: any = client();
    delete c.channels;
    pm.manager = manager(c);
    expect(await execute('u1')).toEqual(SERVER_NOT_READY);
    expect(pm.manager.executePanelForWebUI).not.toHaveBeenCalled();
  });

  it.each([[false], [0], ['']])('a fetch that yields %j answers not-ready and runs nothing', async value => {
    pm.manager = manager(client({ channels: { cache: new Map(), fetch: vi.fn(async () => value) } }));
    expect(await execute('u1')).toEqual(SERVER_NOT_READY);
    expect(pm.manager.executePanelForWebUI).not.toHaveBeenCalled();
  });

  it.each([[null], [undefined]])('a fetch rejected with %j answers not-ready and runs nothing', async value => {
    pm.manager = manager(client({ channels: { cache: new Map(), fetch: vi.fn(() => Promise.reject(value)) } }));
    expect(await execute('u1')).toEqual(SERVER_NOT_READY);
    expect(pm.manager.executePanelForWebUI).not.toHaveBeenCalled();
  });

  it('a fetch rejected with code 10003 still answers invalid', async () => {
    pm.manager = manager(client({ channels: { cache: new Map(), fetch: vi.fn(() => Promise.reject(Object.assign(new Error('Unknown Channel'), { code: 10003 }))) } }));
    expect(await execute('u1')).toEqual(CHANNEL_INVALID);
  });
});

describe('the fetch bound leaves no timer behind', () => {
  async function timersLeft(fetch: () => Promise<any>, cached: boolean, userId: string): Promise<{ answer: any; left: number }> {
    pm.manager = manager(client({ channels: { cache: new Map(cached ? [[CHANNEL, { guildId: GUILD }]] : []), fetch: vi.fn(fetch) } }));
    const before = vi.getTimerCount();
    const answer = await execute(userId);
    return { answer, left: vi.getTimerCount() - before };
  }

  it('a fetch that answers clears its 5 s timer', async () => {
    fakeClock();
    const base = await timersLeft(async () => ({ guildId: GUILD }), true, 'a1');
    const fetched = await timersLeft(async () => ({ guildId: GUILD }), false, 'a2');
    expect(base.answer).toEqual(VIEW);
    expect(fetched.answer).toEqual(VIEW);
    expect(fetched.left).toBe(base.left);
  });

  it('a fetch that fails clears its 5 s timer', async () => {
    fakeClock();
    const base = await timersLeft(async () => ({ guildId: GUILD }), true, 'b1');
    const failed = await timersLeft(() => Promise.reject(new Error('socket hang up')), false, 'b2');
    expect(failed.answer).toEqual(SERVER_NOT_READY);
    expect(failed.left).toBe(base.left);
  });
});

describe('runsFromRequest', () => {
  it('a panel with no scope or guild scope runs from a request; others do not', () => {
    expect(runsFromRequest({})).toBe(true);
    expect(runsFromRequest({ panelScope: 'guild' })).toBe(true);
    expect(runsFromRequest({ panelScope: 'system' })).toBe(false);
    expect(runsFromRequest({ devOnly: true })).toBe(false);
    expect(runsFromRequest(undefined)).toBe(false);
  });
});

describe('cacheIncomplete', () => {
  const ready = { status: Status.Ready };
  const connecting = { status: Status.Connecting };
  const guilds = (...list: any[]) => ({ cache: new Map(list.map(g => [g.id, g])) });

  it('with no client or no ws, named shards are incomplete', () => {
    expect(cacheIncomplete(undefined, [0])).toBe(true);
    expect(cacheIncomplete({ guilds: guilds() }, [0])).toBe(true);
  });

  it('named shard ids are the only ones checked', () => {
    const c = { ws: { shards: new Map([[0, ready], [1, connecting]]) }, guilds: guilds() };
    expect(cacheIncomplete(c, [0])).toBe(false);
    expect(cacheIncomplete(c, [1])).toBe(true);
  });

  it('a JSON bot checks every shard of the client, not the lease', () => {
    readinessRig({ nodeId: 'node-a', processId: 'process-a', claims: { 0: 1 }, shardCount: 2, shardIds: [0] });
    setBackendKind('file');
    const c = { ws: { shards: new Map([[0, ready], [1, connecting]]) }, guilds: guilds(), options: { shardCount: 2 } };
    expect(cacheIncomplete(c)).toBe(true);
  });

  it('a Postgres bot checks the shards of its lease only', () => {
    readinessRig({ nodeId: 'node-a', processId: 'process-a', claims: { 0: 1 }, shardCount: 2, shardIds: [0] });
    setBackendKind('postgres');
    const c = { ws: { shards: new Map([[0, ready], [1, connecting]]) }, guilds: guilds(), options: { shardCount: 2 } };
    expect(cacheIncomplete(c)).toBe(false);
  });

  it('a JSON bot whose shards are all ready is complete', () => {
    const c = { ws: { shards: new Map([[0, ready]]) }, guilds: guilds({ id: GUILD, available: true }), options: { shardCount: 1 } };
    expect(cacheIncomplete(c)).toBe(false);
  });

  it('an unavailable guild with no shard id on another shard leaves the list complete, using the client shard count', () => {
    const c = { ws: { shards: new Map([[0, ready]]) }, guilds: guilds({ id: GUILD, available: false }), options: { shardCount: 2 } };
    expect(cacheIncomplete(c)).toBe(false);
  });

  it('a client with no options counts no shards: an unavailable guild with no shard id makes it incomplete', () => {
    const c = { ws: { shards: new Map([[0, ready]]) }, guilds: guilds({ id: GUILD, available: false }) };
    expect(cacheIncomplete(c)).toBe(true);
    const whole = { ws: { shards: new Map([[0, ready]]) }, guilds: guilds({ id: GUILD, available: true }) };
    expect(cacheIncomplete(whole)).toBe(false);
  });
});
