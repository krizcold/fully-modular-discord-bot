import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The panel handler's answers and rate buckets as the web UI and the operator see them: the refusal texts, the read
// types that take no token, the bucket's refill and prune, the 'control:guild-webui' message and a message with no data.
const pm = vi.hoisted(() => ({ manager: null as any }));
const cfg = vi.hoisted(() => ({ values: new Map<string, unknown>() }));

vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  return { ...real, getPanelManager: () => pm.manager };
});
vi.mock('../../src/bot/internalSetup/utils/configManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/configManager')>();
  return { ...real, getConfigProperty: (p: string) => (cfg.values.has(p) ? cfg.values.get(p) : real.getConfigProperty(p)) };
});

import { setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import {
  answerPanelMessage,
  consumeToken,
  guildWebUiEnabled,
  setupPanelIPCHandlers,
  _bucketCount,
  _resetPanelHandler,
} from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { setBackendKind } from '../helpers/backendKind';
import { NOT_LEASED, readinessRig, stopDrivers } from '../helpers/readinessRig';

const T0 = 1_700_000_000_000;

function guildMap(entries: [string, any][] = []) {
  const m: Map<string, any> & { map?: unknown } = new Map(entries);
  m.map = (fn: any) => [...m.values()].map(fn);
  return m;
}

function client(over: Record<string, any> = {}) {
  return {
    isReady: () => true,
    guilds: { cache: guildMap() },
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

function clockAt(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ms);
}

const takes = (user: string, n: number) => Array.from({ length: n }, () => consumeToken(user));

beforeEach(() => {
  pm.manager = manager();
  cfg.values.clear();
  _resetPanelHandler();
});

afterEach(() => {
  _resetPanelHandler();
  cfg.values.clear();
  setMaintenanceGate(null);
  setStoppedServingHook(null);
  setBackendKind(null);
  stopDrivers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the refusal texts the web UI shows', () => {
  it('a guild this machine does not lease answers not-held in these words', async () => {
    const guildId = readinessRig(NOT_LEASED).guild();
    const answer = await answerPanelMessage('panel:list', { guildId }, 'ipc');
    expect(answer).toEqual({ success: false, code: 'not-held', error: "This machine's bot does not run this server." });
    expect(pm.manager.getWebUIPanelList).not.toHaveBeenCalled();
  });

  it('a guild missing from the cache answers not-ready with ran false and these words, and runs nothing', async () => {
    setBackendKind('file');
    const answer = await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u1', guildId: '4194304', channelId: '222222222222222222' }, 'ipc');
    expect(answer).toEqual({
      success: false, ran: false, code: 'not-ready',
      error: 'This server is not ready on the bot that runs it yet; nothing was run. Try again in a moment.',
    });
    expect(pm.manager.executePanelForWebUI).not.toHaveBeenCalled();
  });

  it("a channel of another guild answers invalid with ran false and these words, and runs nothing", async () => {
    setBackendKind('file');
    const guildId = '4194304';
    pm.manager = manager(client({
      guilds: { cache: guildMap([[guildId, { id: guildId, available: true }]]) },
      channels: { cache: new Map([['111111111111111111', { guildId: '999' }]]), fetch: vi.fn(async () => null) },
    }));
    const answer = await answerPanelMessage('panel:button', { panelId: 'p', buttonId: 'b', userId: 'u1', guildId, channelId: '111111111111111111' }, 'ipc');
    expect(answer).toEqual({
      success: false, ran: false, code: 'invalid',
      error: "The request for this server was malformed (the channel is not one of this server's channels); nothing was run.",
    });
    expect(pm.manager.handleWebUIButton).not.toHaveBeenCalled();
  });
});

describe('the read types take no rate token', () => {
  it.each([
    ['panel:list', { userId: 'reader' }],
    ['dev:check', { userId: 'reader' }],
    ['bot:guilds', { userId: 'reader' }],
    ['panel:live', { userId: 'reader' }],
  ] as const)('%s six times in one millisecond from one user is never refused by the rate limit', async (type, data) => {
    setBackendKind('file');
    clockAt(T0);
    for (let i = 0; i < 6; i++) {
      const answer = await answerPanelMessage(type, { ...data }, 'ipc');
      expect(answer.error ?? '').not.toContain('Rate limit');
    }
    expect(_bucketCount()).toBe(0);
  });

  it('an action from the same user does take one, and the sixth in a millisecond is refused', async () => {
    clockAt(T0);
    const answers = [];
    for (let i = 0; i < 6; i++) answers.push(await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'actor' }, 'ipc'));
    expect(answers.slice(0, 5).every(a => a.success === true)).toBe(true);
    expect(answers[5]).toEqual({ success: false, ran: false, error: 'Rate limit exceeded. Please wait before trying again.' });
    expect(pm.manager.executePanelForWebUI).toHaveBeenCalledTimes(5);
  });
});

describe('the token bucket', () => {
  it('the configured capacity bounds the burst', () => {
    cfg.values.set('system.rateLimit.bucketCapacity', 2);
    clockAt(T0);
    expect(takes('u', 3)).toEqual([true, true, false]);
  });

  it('the configured refill rate gives a token back after that many milliseconds', () => {
    cfg.values.set('system.rateLimit.refillRateMs', 200);
    clockAt(T0);
    expect(takes('u', 6)).toEqual([true, true, true, true, true, false]);
    vi.setSystemTime(T0 + 200);
    expect(takes('u', 2)).toEqual([true, false]);
  });

  it('a refill adds one token per whole period, never fills the bucket, and keeps the part period for the next', () => {
    clockAt(T0);
    expect(takes('u', 6)).toEqual([true, true, true, true, true, false]);
    vi.setSystemTime(T0 + 1500);
    expect(takes('u', 2)).toEqual([true, false]);
    vi.setSystemTime(T0 + 2000);
    expect(takes('u', 2)).toEqual([true, false]);
  });

  it('a clock that steps back takes no tokens from the user', () => {
    clockAt(T0 + 10_000);
    expect(consumeToken('u')).toBe(true);
    vi.setSystemTime(T0 + 8000);
    expect(takes('u', 5)).toEqual([true, true, true, true, false]);
  });

  it('a capacity lowered in config leaves the tokens a user holds until a refill', () => {
    clockAt(T0);
    expect(consumeToken('u')).toBe(true);
    cfg.values.set('system.rateLimit.bucketCapacity', 2);
    expect(takes('u', 5)).toEqual([true, true, true, true, false]);
  });
});

describe('the bucket prune', () => {
  it('a bucket idle exactly the cleanup age is kept at a prune', () => {
    clockAt(T0);
    consumeToken('a');
    vi.setSystemTime(T0 + 300_000);
    consumeToken('b');
    expect(_bucketCount()).toBe(2);
  });

  it('a bucket past the cleanup age stays until a minute after the last prune', () => {
    clockAt(T0);
    consumeToken('a');
    vi.setSystemTime(T0 + 250_000);
    consumeToken('b');
    vi.setSystemTime(T0 + 300_001);
    consumeToken('c');
    expect(_bucketCount()).toBe(3);
  });

  it('a prune runs at exactly a minute after the last one', () => {
    clockAt(T0);
    consumeToken('a');
    vi.setSystemTime(T0 + 240_001);
    consumeToken('b');
    vi.setSystemTime(T0 + 300_001);
    consumeToken('c');
    expect(_bucketCount()).toBe(2);
  });

  it('the configured cleanup age decides which buckets a prune removes', () => {
    cfg.values.set('system.rateLimit.cleanupAgeMs', 1000);
    clockAt(T0);
    consumeToken('a');
    vi.setSystemTime(T0 + 60_000);
    consumeToken('b');
    expect(_bucketCount()).toBe(1);
  });
});

describe('the guild check skips the read types that need no guild', () => {
  it("'bot:guilds' with a guildId answers the list while the process has stopped serving", async () => {
    setBackendKind('file');
    pm.manager = manager(client({ guilds: { cache: guildMap([['4194304', { id: '4194304', name: 'G', icon: null, memberCount: 3 }]]) } }));
    setStoppedServingHook(() => true);
    const answer = await answerPanelMessage('bot:guilds', { guildId: '4194304' }, 'ipc');
    expect(answer).toMatchObject({ success: true, guilds: [{ id: '4194304', name: 'G', icon: null, memberCount: 3 }] });
  });

  it("a message with no data answers 'panel:list'", async () => {
    await expect(answerPanelMessage('panel:list', undefined, 'ipc')).resolves.toEqual({ success: true, panels: [{ id: 'p', scope: 'guild' }] });
  });
});

describe('the IPC listener', () => {
  async function listening(run: (listener: (m: unknown) => Promise<void>, sent: any[], warns: any[][]) => Promise<void>) {
    const sent: any[] = [];
    const original = process.send;
    process.send = ((message: any) => { sent.push(message); return true; }) as typeof process.send;
    const warns: any[][] = [];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation((...args: any[]) => { warns.push(args); });
    const before = process.listeners('message');
    try {
      setupPanelIPCHandlers();
      const listener = process.listeners('message').find(l => !before.includes(l)) as unknown as (m: unknown) => Promise<void>;
      process.removeListener('message', listener as any);
      await run(listener, sent, warns);
    } finally {
      process.send = original;
    }
  }

  it("'control:guild-webui' sets the kept value and sends no reply", async () => {
    await listening(async (listener, sent) => {
      expect(guildWebUiEnabled()).toBeNull();
      await listener({ type: 'control:guild-webui', data: { enabled: true } });
      expect(guildWebUiEnabled()).toBe(true);
      await listener({ type: 'control:guild-webui', data: { enabled: false } });
      expect(guildWebUiEnabled()).toBe(false);
      expect(sent).toEqual([]);
    });
  });

  it("'control:guild-webui' with no data is ignored without an error", async () => {
    await listening(async (listener, sent) => {
      await expect(listener({ type: 'control:guild-webui' })).resolves.toBeUndefined();
      expect(guildWebUiEnabled()).toBeNull();
      expect(sent).toEqual([]);
    });
  });

  it('a null message is refused as not an object without an error', async () => {
    await listening(async (listener, sent, warns) => {
      await expect(listener(null)).resolves.toBeUndefined();
      expect(warns).toContainEqual(['[IPCPanelHandler] Received invalid IPC message: not an object']);
      expect(sent).toEqual([]);
    });
  });

  it('a message that is not an object is refused even when it carries the control type', async () => {
    await listening(async (listener, sent, warns) => {
      const fn = Object.assign(() => undefined, { type: 'control:guild-webui', data: { enabled: true } });
      await expect(listener(fn)).resolves.toBeUndefined();
      expect(guildWebUiEnabled()).toBeNull();
      expect(warns).toContainEqual(['[IPCPanelHandler] Received invalid IPC message: not an object']);
      expect(sent).toEqual([]);
    });
  });
});
