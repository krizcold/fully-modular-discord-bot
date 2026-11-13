import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({
  get: vi.fn(),
  stamp: vi.fn(),
  record: vi.fn(),
  serializeError: null as Error | null,
}));

vi.mock('../../src/bot/internalSetup/utils/panel/persistentPanelStorage', async importOriginal => ({
  ...(await importOriginal<object>()),
  getPersistentPanel: fx.get,
  updatePersistentPanelState: fx.stamp,
  recordPersistentPanelResponse: fx.record,
}));
vi.mock('../../src/bot/internalSetup/utils/panelSerializer', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelSerializer')>();
  return {
    ...real,
    serializePanelResponse: (...args: Parameters<typeof real.serializePanelResponse>) => {
      if (fx.serializeError) throw fx.serializeError;
      return real.serializePanelResponse(...args);
    },
  };
});

import { _resetPanelLive, liveAnswer, liveVersionOf, registerInterest } from '../../src/bot/internalSetup/fleet/panelLive';
import { PanelWebUIAdapter, sendLiveUpdate } from '../../src/bot/internalSetup/utils/panel/panelWebUIAdapter';
import { updatePersistentPanel } from '../../src/bot/internalSetup/utils/panel/persistentPanelResponse';
import { serializePanelResponse } from '../../src/bot/internalSetup/utils/panelSerializer';

const G = '4194304';
const instance = { messageId: 'm1', channelId: 'c1', userId: 'u1', createdAt: 0, lastUpdated: 0, state: 'a' };
const client = { channels: { fetch: async () => ({ isTextBased: () => true, messages: { edit: async () => ({}) } }) } } as never;

let errors: unknown[][];
let sent: unknown[];
let sendError: Error | null;
let realSend: typeof process.send;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  _resetPanelLive();
  errors = [];
  sent = [];
  sendError = null;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  fx.get.mockResolvedValue(instance);
  fx.stamp.mockResolvedValue(true);
  fx.record.mockResolvedValue(true);
  fx.serializeError = null;
  realSend = process.send;
  // The worker's own IPC goes through process.send in the forks pool: pass every other message on.
  (process as any).send = (message: any, ...rest: any[]) => {
    if (message && message.type === 'panel:live_update') {
      if (sendError) throw sendError;
      sent.push(message);
      return true;
    }
    return realSend ? (realSend as any).call(process, message, ...rest) : false;
  };
});

afterEach(() => {
  (process as any).send = realSend;
  _resetPanelLive();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('rm6 sendLiveUpdate', () => {
  it('rm6 a failing IPC send is logged with its error, and the change is still kept for a watching machine', () => {
    const since = registerInterest(G, 'p');
    sendError = new Error('channel closed');

    sendLiveUpdate({ panelId: 'p', guildId: G, sessionId: null, response: { v: 7 } });

    expect(errors).toEqual([['[PanelWebUIAdapter] Error broadcasting panel update:', sendError]]);
    expect(liveVersionOf(G, 'p', since!)).toBe(1);
    expect(liveAnswer(G, 'p', since)).toMatchObject({ success: true, data: { v: 7 }, version: 1 });
  });

  it('rm6 a sent update is kept for a watching machine', () => {
    const since = registerInterest(G, 'p');

    sendLiveUpdate({ panelId: 'p', guildId: G, sessionId: null, response: { v: 1 } });

    expect(sent).toEqual([{ type: 'panel:live_update', data: { panelId: 'p', guildId: G, sessionId: null, response: { v: 1 } } }]);
    expect(liveAnswer(G, 'p', since)).toMatchObject({ success: true, data: { v: 1 }, version: 1 });
    expect(errors).toEqual([]);
  });
});

describe('rm6 the web UI context hands the panel its navigation stack', () => {
  const adapterWith = (seen: unknown[]) => new PanelWebUIAdapter(
    { guilds: { cache: new Map() } } as never,
    new Map([['nav', { id: 'nav', callback: async (ctx: any) => { seen.push(ctx.navigationStack); return { closePanel: true }; } } as never]]),
    {} as never,
  );

  it('rm6 no stack reaches the panel as an empty stack', async () => {
    const seen: unknown[] = [];
    expect((await adapterWith(seen).executePanelForWebUI('nav', 'web-ui-owner', null)).success).toBe(true);
    expect(seen).toEqual([[]]);
  });

  it('rm6 a given stack reaches the panel unchanged', async () => {
    const seen: unknown[] = [];
    expect((await adapterWith(seen).executePanelForWebUI('nav', 'web-ui-owner', null, ['home', 'settings'])).success).toBe(true);
    expect(seen).toEqual([['home', 'settings']]);
  });
});

describe('rm6 updatePersistentPanel sends the live update after the edit', () => {
  it('rm6 the edited view goes to the web UI and is kept for a watching machine', async () => {
    const since = registerInterest(G, 'p1');
    const response = { content: 'v' } as never;

    expect(await updatePersistentPanel(client, 'p1', response, G, 's1')).toBe(true);

    const serialized = serializePanelResponse(response);
    expect(sent).toEqual([{ type: 'panel:live_update', data: { panelId: 'p1', guildId: G, sessionId: 's1', response: serialized } }]);
    expect(liveAnswer(G, 'p1', since)).toMatchObject({ success: true, data: serialized, version: 1 });
  });

  it('rm6 a live update that cannot be built is logged, and the panel update still reports the saved record', async () => {
    fx.serializeError = new Error('cannot serialize');

    expect(await updatePersistentPanel(client, 'p1', { content: 'v' } as never, G, 's1')).toBe(true);

    expect(errors).toEqual([['[PersistentPanel] Error sending IPC live update:', fx.serializeError]]);
    expect(sent).toEqual([]);
    expect(fx.record).toHaveBeenCalledTimes(1);
  });
});
