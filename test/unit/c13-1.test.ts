import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  local: [{ name: 'alpha', description: 'a', callback: () => undefined }] as any[],
  calls: [] as string[],
  module: null as any,
  client: null as any,
}));

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => h.local }));
vi.mock('../../src/bot/internalSetup/utils/moduleRegistry', () => ({
  getModuleRegistry: () => ({ getModule: () => h.module, getAllModules: () => [] }),
}));
vi.mock('../../src/bot/internalSetup/utils/panelManager', () => ({
  getPanelManager: () => ({ getClient: () => h.client, getPanel: () => null, unregisterPanel: () => undefined }),
}));

import { dataPath } from '../../src/utils/dataRoot';
import { getModuleEventManager } from '../../src/bot/internalSetup/utils/moduleEventManager';
import { setupToggleIPCHandlers } from '../../src/bot/internalSetup/utils/ipcToggleHandler';
import { setupCommandIPCHandlers } from '../../src/bot/internalSetup/utils/ipcCommandHandler';
import handleCommands from '../../src/bot/internalSetup/events/interactionCreate/handleCommands';
import { ComponentToggleDebouncer } from '../../src/webui/utils/componentToggleDebouncer';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';

const componentFile = dataPath('global', 'appstore', 'component-config.json');

function writeConfig(config: Record<string, any>): void {
  fs.mkdirSync(path.dirname(componentFile), { recursive: true });
  fs.writeFileSync(componentFile, JSON.stringify(config));
}

async function ipc(setup: () => void, type: string, data: any): Promise<any> {
  const sent: any[] = [];
  const hadSend = process.send;
  (process as any).send = (m: any) => { sent.push(m); return true; };
  const before = process.listeners('message').length;
  try {
    setup();
    process.emit('message' as any, { type, requestId: 'r1', data } as any);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    return sent[0].data;
  } finally {
    for (const l of process.listeners('message').slice(before)) process.off('message', l as any);
    (process as any).send = hadSend;
  }
}

function fakeInteraction(): any {
  const replies: any[] = [];
  return {
    replies,
    commandName: 'alpha',
    guildId: null,
    user: { id: 'u1' },
    isChatInputCommand: () => true,
    isContextMenuCommand: () => false,
    reply: (r: any) => { replies.push(r); return Promise.resolve(); },
  };
}

beforeEach(() => {
  h.calls.length = 0;
  h.local[0].callback = () => { h.calls.push('alpha'); };
  writeConfig({});
});

describe('C13-1 a switched-off command is refused on every dispatch path', () => {
  it('handleCommands refuses a command switched off in component-config', async () => {
    writeConfig({ '_internal:command:alpha': false });
    const interaction = fakeInteraction();
    await handleCommands({} as any, interaction);
    expect(h.calls).toEqual([]);
    expect(interaction.replies[0]?.content).toMatch(/switched off/);
  });

  it('handleCommands refuses when the setting cannot be read and none was applied', async () => {
    fs.writeFileSync(componentFile, '{"_internal:command:alpha": fa');
    const interaction = fakeInteraction();
    await handleCommands({} as any, interaction);
    expect(h.calls).toEqual([]);
    expect(interaction.replies[0]?.content).toMatch(/cannot be read/);
  });

  it('handleCommands runs a command that is on', async () => {
    writeConfig({ 'mod:command:other': false });
    await handleCommands({} as any, fakeInteraction());
    expect(h.calls).toEqual(['alpha']);
  });

  it('the console invoke answers disabled in Components and does not run it', async () => {
    writeConfig({ 'mod:command:alpha': false });
    h.client = { isReady: () => true, guilds: { cache: new Map() }, users: { cache: new Map() }, user: { id: 'bot' } };
    const answer = await ipc(() => setupCommandIPCHandlers(), 'command:invoke', { command: 'alpha' });
    expect(answer.success).toBe(false);
    expect(answer.error).toMatch(/disabled in Components/);
    expect(h.calls).toEqual([]);
  });
});

describe('C13-1 enabling an attached event is a no-op', () => {
  it('a second enable does not attach the handler again', async () => {
    const client = new EventEmitter();
    const em = getModuleEventManager();
    em.setClient(client as any);
    const handler = () => undefined;
    h.module = { manifest: { name: 'mod' }, events: new Map([['ping', [handler]]]) };
    em.registerListener('mod', 'ping', handler);
    const answer = await ipc(() => setupToggleIPCHandlers({} as any), 'component:toggle',
      { module: 'mod', componentType: 'event', name: 'ping', enabled: true });
    expect(answer.success).toBe(true);
    expect(client.listenerCount('ping')).toBe(1);
    em.removeEventListeners('mod', 'ping');
  });
});

describe('C13-1 one key\'s toggles run in order', () => {
  afterEach(() => vi.useRealTimers());

  it('the next action starts only after the running one settles', async () => {
    vi.useFakeTimers();
    const d = new ComponentToggleDebouncer(10);
    const log: string[] = [];
    let release!: () => void;
    d.debounce('k', false, async () => {
      log.push('off:start');
      await new Promise<void>(r => { release = r; });
      log.push('off:end');
    });
    await vi.advanceTimersByTimeAsync(10);
    d.debounce('k', true, async () => { log.push('on'); });
    await vi.advanceTimersByTimeAsync(10);
    expect(log).toEqual(['off:start']);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['off:start', 'off:end', 'on']);
  });

  it('the components PUT answers already enabled when the stored state did not change', async () => {
    writeConfig({});
    const router = createAppStoreRoutes({ isRunning: () => false } as any);
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/components/:module/:type/:name' && l.route.methods.put);
    const res: any = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    await layer.route.stack[0].handle({ params: { module: 'mod', type: 'event', name: 'ping' }, body: { enabled: true } }, res);
    expect(res.body.changed).toBe(false);
    expect(res.body.message).toBe('already enabled');
  });
});

describe('C13-1 the bot applies one key\'s toggles in arrival order', () => {
  it('an on toggle waits for a slow off toggle of the same command', async () => {
    const order: string[] = [];
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((r) => { releaseFetch = r; });
    const client: any = { application: { commands: {
      fetch: async () => { order.push('fetch'); await fetchGate; return [{ id: 'c1', name: 'alpha', type: 1 }]; },
      delete: async () => { order.push('delete'); },
      create: async () => { order.push('create'); },
    } } };
    const sent: any[] = [];
    const hadSend = process.send;
    (process as any).send = (m: any) => { sent.push(m); return true; };
    const before = process.listeners('message').length;
    try {
      setupToggleIPCHandlers(client);
      const data = { module: 'mod', componentType: 'command', name: 'alpha' };
      process.emit('message' as any, { type: 'component:toggle', requestId: 'off', data: { ...data, enabled: false } } as any);
      process.emit('message' as any, { type: 'component:toggle', requestId: 'on', data: { ...data, enabled: true } } as any);
      await new Promise((r) => setTimeout(r, 20));
      expect(order).toEqual(['fetch']);
      releaseFetch();
      await vi.waitFor(() => expect(sent.length).toBe(2));
      expect(order).toEqual(['fetch', 'delete', 'create']);
      expect(sent.map((m) => m.requestId)).toEqual(['off', 'on']);
    } finally {
      for (const l of process.listeners('message').slice(before)) process.off('message', l as any);
      (process as any).send = hadSend;
    }
  });
});
