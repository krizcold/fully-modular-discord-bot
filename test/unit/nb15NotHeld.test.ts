import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB15 test 1 (sheets/NB15.md, decisions 3, 6, 7 and 10, gatekeeper rulings 5 and 7): the bot process's two listeners.
// A request with a guild whose shard is not in the set lease answers not-held in one turn and runs nothing; the
// channel check; ran, truth and partial; the module-scope rate buckets; the serializer; 'control:guild-webui';
// 'bot:guilds' with incomplete.
const pm = vi.hoisted(() => ({ manager: null as any, commands: [] as any[] }));

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => pm.commands }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  return { ...real, getPanelManager: () => pm.manager };
});

import { Status } from 'discord.js';
import { gateCauseText } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { setStoppedServingHook, STOPPED_SERVING_TEXT } from '../../src/bot/internalSetup/utils/servingGate';
import {
  answerPanelMessage,
  setupPanelIPCHandlers,
  CHANNEL_INVALID,
  consumeToken,
  guildWebUiEnabled,
  noteGuildWebUi,
  NOT_HELD,
  SERVER_NOT_READY,
  _bucketCount,
  _resetPanelHandler,
} from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { answerInvokeMessage, handleInvoke } from '../../src/bot/internalSetup/utils/ipcCommandHandler';
import { toTransport } from '../../src/bot/internalSetup/utils/transportJson';
import { readSourceText } from '../helpers/sourceText';
import { setBackendKind } from '../helpers/backendKind';
import { fakeClock, NOT_LEASED, readinessRig, stopDrivers, watch } from '../helpers/readinessRig';

function client(over: Record<string, any> = {}) {
  return {
    isReady: () => true,
    guilds: { cache: new Map<string, any>() },
    channels: { cache: new Map<string, any>(), fetch: vi.fn(async () => null) },
    users: { cache: new Map() },
    user: { id: '11' },
    application: { id: '11' },
    ws: { shards: new Map<number, any>() },
    ...over,
  };
}

function manager(c = client()) {
  return {
    getClient: () => c,
    getPanel: () => undefined,
    getWebUIPanelList: vi.fn(() => [{ id: 'p', scope: 'guild' }]),
    executePanelForWebUI: vi.fn(async () => ({ success: true, data: { content: 'View' } })),
    handleWebUIButton: vi.fn(async () => ({ success: true, data: { content: 'View' } })),
    handleWebUIDropdown: vi.fn(async () => ({ success: true, data: { content: 'View' } })),
    handleWebUIModal: vi.fn(async () => ({ success: true, data: { content: 'View' } })),
  };
}

const ACTIONS = [
  ['panel:execute', { panelId: 'p', userId: 'u1' }],
  ['panel:button', { panelId: 'p', buttonId: 'b', userId: 'u2' }],
  ['panel:dropdown', { panelId: 'p', values: ['a'], userId: 'u3' }],
  ['panel:modal', { panelId: 'p', modalId: 'm', fields: {}, userId: 'u4' }],
] as const;

beforeEach(() => {
  pm.manager = manager();
  pm.commands = [];
});

afterEach(() => {
  _resetPanelHandler();
  setMaintenanceGate(null);
  setStoppedServingHook(null);
  setBackendKind(null);
  stopDrivers();
  vi.useRealTimers();
});

describe('not-held (decision 6)', () => {
  it.each([
    ...ACTIONS,
    ['guild:channels', {}],
    ['guild:roles', {}],
    ['panel:list', {}],
  ] as const)('%s for a guild not in the set lease answers not-held in one turn, running and holding nothing', async (type, data) => {
    fakeClock();
    const r = readinessRig(NOT_LEASED);
    const guildId = r.guild();
    const seen = watch(answerPanelMessage(type, { ...data, guildId }, 'ipc'));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.value()).toEqual(NOT_HELD);
    expect(pm.manager.executePanelForWebUI).not.toHaveBeenCalled();
    expect(pm.manager.handleWebUIButton).not.toHaveBeenCalled();
    expect(pm.manager.getWebUIPanelList).not.toHaveBeenCalled();
    expect(_bucketCount()).toBe(0);
  });

  it.each([[false], [true]])("'command:invoke' with force %s answers not-held before the cache check", async force => {
    fakeClock();
    const ran = vi.fn();
    pm.commands = [{ name: 'probe', callback: ran }];
    const r = readinessRig(NOT_LEASED);
    const guildId = r.guild();
    const seen = watch(answerInvokeMessage({ command: 'probe', guildId, force }, 'ipc'));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.value()).toEqual(NOT_HELD);
    expect(ran).not.toHaveBeenCalled();
  });

  it('the maintenance gate closed answers the maintenance text first', async () => {
    const r = readinessRig(NOT_LEASED);
    const guildId = r.guild();
    setMaintenanceGate({ cause: 'hook', message: 'Back soon' });
    expect(await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u', guildId }, 'ipc')).toMatchObject({ success: false, maintenance: true });
  });

  it.each(['panel:execute', 'guild:channels', 'guild:roles', 'panel:list'])('%s: a process that stopped serving answers NB4 text first (ruling 7)', async type => {
    const r = readinessRig(NOT_LEASED);
    const guildId = r.guild();
    setStoppedServingHook(() => true);
    expect(await answerPanelMessage(type, { panelId: 'p', userId: 'u', guildId }, 'ipc')).toEqual({ success: false, error: STOPPED_SERVING_TEXT });
  });

  it('before the lease is set the hold runs as today', async () => {
    fakeClock();
    const r = readinessRig(null);
    const guildId = r.guild();
    const seen = watch(answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u', guildId }, 'ipc'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen.value()).toEqual({ success: false, ran: false, error: gateCauseText('not-served') });
  });

  it('a leased guild runs as today; a JSON bot never answers not-held; a system panel with no guild is unchanged', async () => {
    const r = readinessRig();
    const guildId = await r.ready();
    pm.manager = manager(client({ guilds: { cache: new Map([[guildId, { id: guildId, available: true }]]) } }));
    expect(await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u', guildId }, 'ipc')).toEqual({ success: true, data: { content: 'View' } });
    const other = readinessRig(NOT_LEASED).guild();
    setBackendKind('file');
    expect(await answerPanelMessage('panel:list', { guildId: other }, 'ipc')).toMatchObject({ success: true });
    expect(await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u' }, 'ipc')).toEqual({ success: true, data: { content: 'View' } });
  });
});

describe('the channel check (decision 7)', () => {
  async function leased(guild: Record<string, any> | null, channels: { cache?: Map<string, any>; fetch?: any } = {}) {
    const r = readinessRig();
    const guildId = await r.ready();
    const c = client({
      guilds: { cache: new Map(guild ? [[guildId, { id: guildId, available: true, ...guild }]] : []) },
      channels: { cache: channels.cache ?? new Map(), fetch: channels.fetch ?? vi.fn(async () => null) },
    });
    pm.manager = manager(c);
    return { guildId, c };
  }

  it.each([['absent', null], ['not available', { available: false }]] as const)('a guild %s from the cache answers not-ready, ran false, nothing run', async (_what, guild) => {
    const { guildId } = await leased(guild);
    const answer = await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u', guildId, channelId: '123456789012345678' }, 'ipc');
    expect(answer).toEqual(SERVER_NOT_READY);
    expect(pm.manager.executePanelForWebUI).not.toHaveBeenCalled();
  });

  it("a cached channel of another guild answers invalid; one of this guild runs", async () => {
    const { guildId } = await leased({}, { cache: new Map([['111111111111111111', { guildId: '999' }], ['222222222222222222', { guildId: 'x' }]]) });
    expect(await answerPanelMessage('panel:button', { panelId: 'p', buttonId: 'b', userId: 'u', guildId, channelId: '111111111111111111' }, 'ipc')).toEqual(CHANNEL_INVALID);
    expect(pm.manager.handleWebUIButton).not.toHaveBeenCalled();
  });

  it('T1: a cached channel of this guild runs, once; one of another guild runs nothing', async () => {
    const { guildId, c } = await leased({}, { cache: new Map([['111111111111111111', { guildId: '999' }]]) });
    c.channels.cache.set('222222222222222222', { guildId });
    expect(await answerPanelMessage('panel:button', { panelId: 'p', buttonId: 'b', userId: 'u1', guildId, channelId: '111111111111111111' }, 'ipc')).toEqual(CHANNEL_INVALID);
    expect(await answerPanelMessage('panel:button', { panelId: 'p', buttonId: 'b', userId: 'u2', guildId, channelId: '222222222222222222' }, 'ipc')).toEqual({ success: true, data: { content: 'View' } });
    expect(pm.manager.handleWebUIButton).toHaveBeenCalledTimes(1);
    expect(c.channels.fetch).not.toHaveBeenCalled();
  });

  it('T1: the channel check on a JSON bot: an absent guild not-ready, another guild\'s channel invalid, this guild\'s runs', async () => {
    setBackendKind('file');
    const guildId = '4194304';
    const c = client({
      guilds: { cache: new Map([[guildId, { id: guildId, available: true }]]) },
      channels: { cache: new Map([['111111111111111111', { guildId: '999' }], ['222222222222222222', { guildId }]]), fetch: vi.fn(async () => null) },
    });
    pm.manager = manager(c);
    expect(await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u1', guildId: '8388608', channelId: '222222222222222222' }, 'ipc')).toEqual(SERVER_NOT_READY);
    expect(await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u2', guildId, channelId: '111111111111111111' }, 'ipc')).toEqual(CHANNEL_INVALID);
    expect(await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u3', guildId, channelId: '222222222222222222' }, 'ipc')).toEqual({ success: true, data: { content: 'View' } });
    expect(pm.manager.executePanelForWebUI).toHaveBeenCalledTimes(1);
  });

  it('an uncached channel is fetched: one of the guild runs, 10003 or another guild answers invalid, a failure or a slow fetch not-ready', async () => {
    fakeClock();
    let answerWith: () => Promise<any> = async () => null;
    const fetch = vi.fn(() => answerWith());
    const { guildId } = await leased({}, { fetch });
    answerWith = async () => ({ guildId });
    expect(await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u1', guildId, channelId: '333333333333333333' }, 'ipc')).toEqual({ success: true, data: { content: 'View' } });
    answerWith = async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); };
    expect(await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u2', guildId, channelId: '333333333333333333' }, 'ipc')).toEqual(CHANNEL_INVALID);
    answerWith = async () => ({ guildId: '42' });
    expect(await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u3', guildId, channelId: '333333333333333333' }, 'ipc')).toEqual(CHANNEL_INVALID);
    answerWith = async () => { throw new Error('socket hang up'); };
    expect(await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u4', guildId, channelId: '333333333333333333' }, 'ipc')).toEqual(SERVER_NOT_READY);
    answerWith = () => new Promise(() => undefined);
    const slow = watch(answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u5', guildId, channelId: '333333333333333333' }, 'ipc'));
    await vi.advanceTimersByTimeAsync(4900);
    expect(slow.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(slow.value()).toEqual(SERVER_NOT_READY);
    expect(pm.manager.executePanelForWebUI).toHaveBeenCalledTimes(1);
  });

  it('an action with a channel and no guild is not checked', async () => {
    const answer = await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u', channelId: '444444444444444444' }, 'ipc');
    expect(answer).toEqual({ success: true, data: { content: 'View' } });
  });
});

describe('rates, ran and the serializer', () => {
  it('six invokes from one user within a second all run: no rate limit on invokes', async () => {
    const ran = vi.fn();
    pm.commands = [{ name: 'probe', callback: ran }];
    for (let i = 0; i < 6; i++) {
      const answer = await answerInvokeMessage({ command: 'probe', userId: '123456789012345678' }, 'ipc');
      expect(answer).not.toMatchObject({ error: expect.stringContaining('Rate limit') });
      expect(answer).toMatchObject({ success: true, ran: true, command: 'probe' });
      expect(answer).not.toHaveProperty('error');
    }
    expect(ran).toHaveBeenCalledTimes(6);
    expect(_bucketCount()).toBe(0);
  });

  it("handleInvoke's own refusals carry ran false", async () => {
    expect(await handleInvoke({ command: '' })).toMatchObject({ success: false, ran: false });
    expect(await handleInvoke({ command: 'missing' })).toMatchObject({ success: false, ran: false, error: 'no such command: missing' });
  });

  it('importing the handler starts no timer, and a bucket idle past the cleanup age is gone at the next consumeToken a minute later', () => {
    const src = readSourceText(__dirname, '../../src/bot/internalSetup/utils/ipcPanelHandler.ts');
    expect(src).not.toMatch(/setInterval\(/);
    fakeClock();
    consumeToken('idle');
    expect(_bucketCount()).toBe(1);
    vi.advanceTimersByTime(300_001);
    consumeToken('fresh');
    expect(_bucketCount()).toBe(1);
  });

  it('a reply holding a BigInt and a self-reference serializes; one whose toJSON throws keeps success and records why', () => {
    const reply: any = { a: 1n };
    reply.self = reply;
    const good = toTransport({ success: true, captured: [reply] });
    expect(good.answer).toEqual({ success: true, captured: [{ a: '1', self: '[Circular]' }] });
    const bad = toTransport({ success: true, ran: true, captured: [{ toJSON() { throw new Error('no'); } }] });
    expect(bad.answer).toMatchObject({ success: true, ran: true, capturedOmitted: { count: 1, reason: 'not-serializable' } });
  });
});

describe('T1: what the IPC listener sends', () => {
  const emitIpc = (message: object) => (process.emit as (event: string, message: object) => boolean)('message', message);

  async function listen(run: (replies: any[]) => Promise<void>) {
    const replies: any[] = [];
    const original = process.send;
    process.send = ((message: any, ...rest: unknown[]) => {
      if (String(message?.requestId).startsWith('nb15-')) { replies.push(message); return true; }
      return original ? (original as (...a: unknown[]) => boolean).call(process, message, ...rest) : true;
    }) as typeof process.send;
    const before = process.listeners('message');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setupPanelIPCHandlers();
    const listener = process.listeners('message').find(l => !before.includes(l))!;
    try {
      await run(replies);
    } finally {
      process.removeListener('message', listener);
      process.send = original;
    }
  }

  it('a panel answer holding a BigInt and a self-reference arrives with success true, the BigInt a string and "[Circular]"', async () => {
    const data: any = { n: 12345678901234567890n };
    data.self = data;
    pm.manager.executePanelForWebUI = vi.fn(async () => ({ success: true, data }));
    await listen(async replies => {
      emitIpc({ type: 'panel:execute', requestId: 'nb15-1', data: { panelId: 'p', userId: 'web-ui-owner' } });
      for (let i = 0; i < 50 && replies.length < 1; i++) await new Promise(r => setTimeout(r, 5));
      expect(replies).toEqual([{ requestId: 'nb15-1', data: { success: true, data: { n: '12345678901234567890', self: '[Circular]' } } }]);
    });
  });

  it('one whose toJSON throws arrives with success true and the reason not-serializable', async () => {
    pm.manager.executePanelForWebUI = vi.fn(async () => ({ success: true, data: { toJSON() { throw new Error('no'); } } }));
    await listen(async replies => {
      emitIpc({ type: 'panel:execute', requestId: 'nb15-2', data: { panelId: 'p', userId: 'web-ui-owner' } });
      for (let i = 0; i < 50 && replies.length < 1; i++) await new Promise(r => setTimeout(r, 5));
      expect(replies).toHaveLength(1);
      expect(replies[0].data).toMatchObject({ success: true, oversize: { reason: 'not-serializable' } });
      expect(() => JSON.stringify(replies[0])).not.toThrow();
    });
  });

  it("NB15-TEXT-A: with no web UI parent the process learns the member panel is off", () => {
    const original = process.send;
    (process as any).send = undefined;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      setupPanelIPCHandlers();
      expect(guildWebUiEnabled()).toBe(false);
    } finally {
      process.send = original;
    }
  });
});

describe("'control:guild-webui' and 'bot:guilds' (decisions 3 and 8)", () => {
  it('the kept value is the last one sent', () => {
    expect(guildWebUiEnabled()).toBeNull();
    noteGuildWebUi(true);
    noteGuildWebUi(false);
    expect(guildWebUiEnabled()).toBe(false);
    noteGuildWebUi('yes');
    expect(guildWebUiEnabled()).toBe(false);
  });

  it("answers incomplete while a shard of the lease is not ready or holds an unavailable guild, and none once all are ready", async () => {
    readinessRig();
    const shards = new Map<number, any>([[0, { status: Status.Connecting }]]);
    const guilds: Map<string, any> & { map?: unknown } = new Map<string, any>([['4194304', { id: '4194304', available: true, shardId: 0, name: 'G' }]]);
    guilds.map = (fn: any) => [...guilds.values()].map(fn);
    setBackendKind('postgres');
    pm.manager = manager(client({ ws: { shards }, guilds: { cache: guilds } }));
    expect(await answerPanelMessage('bot:guilds', {}, 'ipc')).toMatchObject({ success: true, incomplete: true });
    shards.set(0, { status: Status.Ready });
    guilds.set('8388608', { id: '8388608', available: false, shardId: 0 });
    expect(await answerPanelMessage('bot:guilds', {}, 'ipc')).toMatchObject({ success: true, incomplete: true });
    guilds.delete('8388608');
    const whole = await answerPanelMessage('bot:guilds', {}, 'ipc');
    expect(whole.success).toBe(true);
    expect(whole).not.toHaveProperty('incomplete');
  });
});
