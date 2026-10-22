import type { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// BT-4's panel rows (notes/BT.md, "BT-4 design sheet: final"): a web UI or CLI panel action answers success only when
// every write its run recorded landed and none was refused; otherwise the truth, and its live update is not broadcast.
const loading = vi.hoisted(() => new Set<string>());
const manager = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataBackends/boot')>();
  return { ...real, admitGuildAction: async (guildId: string) => ({ cause: loading.has(guildId) ? 'loading' : 'admit', mark: null }) };
});
vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  return { ...real, getPanelManager: () => manager.current };
});

import { confirmWrite, freezeGuildWrites, saveData, saveDataOutcome, unfreezeGuildWrites } from '../../src/bot/internalSetup/utils/dataManager';
import { currentLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { CONFIRM_MS, truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { runPanelAction, setupPanelIPCHandlers } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { registerPanelButtonHandler } from '../../src/bot/internalSetup/utils/panel/panelButtonHandler';
import { PanelWebUIAdapter } from '../../src/bot/internalSetup/utils/panel/panelWebUIAdapter';
import { notReadyGuild, storeGuild, tick } from '../helpers/gateRig';

type Handler = (...args: any[]) => Promise<unknown>;
const OWNER = 'web-ui-owner';
const VIEW = { content: 'View' };

let broadcasts: Array<{ data: any; committed: string | undefined }>;
let replies: any[];
let watched: { store: { doc(g: string, f: string): string | undefined }; guildId: string; file: string } | null;
let originalSend: typeof process.send;

beforeEach(() => {
  broadcasts = [];
  replies = [];
  watched = null;
  originalSend = process.send;
  // Only the panel's live updates and its IPC answers are taken; the test runner's own messages pass through.
  process.send = ((message: any, ...rest: unknown[]) => {
    if (message?.type === 'panel:live_update') {
      broadcasts.push({ data: message.data, committed: watched ? watched.store.doc(watched.guildId, watched.file) : undefined });
      return true;
    }
    if (String(message?.requestId).startsWith('bt4-')) {
      replies.push(message);
      return true;
    }
    return originalSend ? (originalSend as (...a: unknown[]) => boolean).call(process, message, ...rest) : true;
  }) as typeof process.send;
});

afterEach(() => {
  process.send = originalSend;
  vi.useRealTimers();
  loading.clear();
});

/** A panel behind a panelManager stub over the real PanelWebUIAdapter, as panelManager.ts:441-484 delegates. */
function panels(panel: Record<string, unknown>, buttonHandlers?: Map<string, unknown>) {
  const client = {
    guilds: { cache: new Map(), fetch: async () => undefined },
    users: { fetch: async () => undefined },
    buttonHandlers,
  } as unknown as Client;
  const map = new Map([[panel.id as string, panel]]);
  const adapter = new PanelWebUIAdapter(client, map as never, {} as never);
  return {
    getPanel: (id: string) => map.get(id),
    executePanelForWebUI: (...a: unknown[]) => (adapter.executePanelForWebUI as Handler)(...a),
    handleWebUIButton: (...a: unknown[]) => (adapter.handleWebUIButton as Handler)(...a),
    handleWebUIDropdown: (...a: unknown[]) => (adapter.handleWebUIDropdown as Handler)(...a),
    handleWebUIModal: (...a: unknown[]) => (adapter.handleWebUIModal as Handler)(...a),
  };
}

const panel = (id: string, handlers: Record<string, Handler>) => ({ id, name: id, _moduleName: 'panelMod', callback: async () => VIEW, ...handlers });

type Action = 'panel:execute' | 'panel:button' | 'panel:dropdown' | 'panel:modal';
const ACTIONS: Array<[Action, string]> = [['panel:execute', 'callback'], ['panel:button', 'handleButton'], ['panel:dropdown', 'handleDropdown'], ['panel:modal', 'handleModal']];
const request = (type: Action, panelId: string, guildId?: string) => ({
  panelId, userId: OWNER, guildId,
  ...(type === 'panel:button' && { buttonId: 'save' }),
  ...(type === 'panel:dropdown' && { values: ['a'] }),
  ...(type === 'panel:modal' && { modalId: 'm', fields: {} }),
});
const run = (type: Action, handler: Handler, guildId?: string) => {
  const id = `p-${type}-${Math.random()}`;
  const name = ACTIONS.find(([t]) => t === type)![1];
  return runPanelAction(type, request(type, id, guildId), panels(panel(id, { [name]: handler })));
};

describe('a panel run with no write', () => {
  it.each(ACTIONS)('%s answers the view unchanged', async type => {
    const answer = await run(type, async () => VIEW);
    expect(answer).toEqual({ success: true, data: { content: 'View' } });
  });

  it('a dropdown or modal still broadcasts its live update, after the verdict, never in the answer', async () => {
    for (const type of ['panel:dropdown', 'panel:modal', 'panel:button'] as const) {
      broadcasts = [];
      const answer = await run(type, async () => VIEW);
      expect(answer).not.toHaveProperty('liveUpdate');
      expect(broadcasts.map(b => b.data.response)).toEqual([{ content: 'View' }]);
    }
  });

  it('an execute never broadcasts', async () => {
    await run('panel:execute', async () => VIEW);
    expect(broadcasts).toEqual([]);
  });

  it('the live update names its panel and guild', async () => {
    for (const type of ['panel:dropdown', 'panel:button'] as const) {
      broadcasts = [];
      const id = `named-${type}`;
      const name = ACTIONS.find(([t]) => t === type)![1];
      await runPanelAction(type, request(type, id, '555'), panels(panel(id, { [name]: async () => VIEW })));
      expect(broadcasts.map(b => b.data)).toEqual([{ panelId: id, guildId: '555', sessionId: null, response: { content: 'View' } }]);
    }
  });
});

describe('a panel run whose writes land within the bound', () => {
  it.each(ACTIONS)('%s answers the view only once the store committed the write', async type => {
    const { guildId, store, options } = await storeGuild();
    const answer = await run(type, async () => {
      saveData('x.json', options, { v: 1 });
      return VIEW;
    }, guildId);
    expect(answer).toEqual({ success: true, data: { content: 'View' } });
    expect(JSON.parse(store.doc(guildId, 'x.json')!)).toEqual({ v: 1 });
  });

  it('the live update goes out only after the write landed', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    watched = { store, guildId, file: 'x.json' };
    const done = run('panel:dropdown', async () => {
      saveData('x.json', options, { v: 1 });
      return VIEW;
    }, guildId);
    await tick(40);
    expect(broadcasts).toEqual([]);
    store.release();
    expect(await done).toEqual({ success: true, data: { content: 'View' } });
    expect(broadcasts).toHaveLength(1);
    expect(JSON.parse(broadcasts[0].committed!)).toEqual({ v: 1 });
  });
});

describe('a panel run whose writes are not confirmed', () => {
  it.each(ACTIONS)('%s: a refusal answers the truth at once, and nothing is broadcast', async type => {
    const answer = await run(type, async () => {
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      return VIEW;
    });
    expect(answer).toEqual({ success: false, error: truthText('not-ready', false) });
    expect(broadcasts).toEqual([]);
  });

  it('a commit the store refuses answers held', async () => {
    const { guildId, store, options } = await storeGuild();
    store.mode = 'read-only';
    const answer = await run('panel:modal', async () => {
      saveData('x.json', options, { v: 1 });
      return VIEW;
    }, guildId);
    expect(answer).toEqual({ success: false, error: truthText('held', false) });
    expect(broadcasts).toEqual([]);
  });

  it('a guild taken over answers deposed', async () => {
    const { guildId, store, options } = await storeGuild();
    store.mode = 'deposed';
    const answer = await run('panel:button', async () => {
      saveData('x.json', options, { v: 1 });
      return VIEW;
    }, guildId);
    expect(answer).toEqual({ success: false, error: truthText('deposed', false) });
  });

  it('a refusal and then a whole rewrite of the same document answers unavailable', async () => {
    const { guildId, options } = await storeGuild();
    const answer = await run('panel:modal', async () => {
      freezeGuildWrites(guildId);
      expect(saveDataOutcome('x.json', options, { v: 1 })).toBe('frozen');
      unfreezeGuildWrites(guildId);
      expect(saveDataOutcome('x.json', options, { v: 2 })).toBe('saved');
      return VIEW;
    }, guildId);
    expect(answer).toEqual({ success: false, error: truthText('unavailable', true) });
  });

  it('a write still unconfirmed at the confirm bound answers pending, and nothing is broadcast', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    const done = run('panel:dropdown', async () => {
      saveData('x.json', options, { v: 1 });
      // A flush already on the wire: confirm polls it in 20 ms steps, reading the faked clock.
      void confirmWrite(currentLedger()!.tickets()[0].ticket, 60_000);
      return VIEW;
    }, guildId);
    await tick(40);
    vi.advanceTimersByTime(CONFIRM_MS + 2000);
    expect(await done).toEqual({ success: false, error: truthText('pending', false) });
    expect(broadcasts).toEqual([]);
    store.release();
  });
});

describe('writes recorded while the verdict waits', () => {
  it('a refusal recorded during the wait makes the answer the truth', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    const done = run('panel:button', async () => {
      saveData('x.json', options, { v: 1 });
      setTimeout(() => saveDataOutcome('y.json', notReadyGuild(), { v: 1 }), 5);
      return VIEW;
    }, guildId);
    await tick(40);
    store.release();
    expect(await done).toEqual({ success: false, error: truthText('not-ready', true) });
    expect(broadcasts).toEqual([]);
  });

  it('an accepted write recorded during the wait is confirmed before the answer', async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    const done = run('panel:execute', async () => {
      saveData('x.json', options, { v: 1 });
      setTimeout(() => saveData('y.json', options, { v: 2 }), 5);
      return VIEW;
    }, guildId);
    await tick(40);
    store.holding = false;
    store.release();
    expect(await done).toEqual({ success: true, data: { content: 'View' } });
    expect(JSON.parse(store.doc(guildId, 'y.json')!)).toEqual({ v: 2 });
  });
});

describe('a handler that throws', () => {
  it('with its writes confirmed, the answer is its error, as today', async () => {
    const { guildId, options } = await storeGuild();
    const answer = await run('panel:button', async () => {
      saveData('x.json', options, { v: 1 });
      throw new Error('boom');
    }, guildId);
    expect(answer).toEqual({ success: false, error: 'boom' });
  });

  it('with a write refused, the truth leads, and the handler\'s error is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const answer = await run('panel:modal', async () => {
        saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
        throw new Error('boom');
      });
      expect(answer).toEqual({ success: false, error: truthText('not-ready', false) });
      expect(warn.mock.calls.map(c => String(c[0])).filter(l => l.includes('boom'))).toEqual(['[IPCPanelHandler] panel:modal failed with its writes not confirmed: boom']);
    } finally {
      warn.mockRestore();
    }
  });

  it('a throw that escapes the adapter after a write still gets the verdict', async () => {
    const { guildId, store, options } = await storeGuild();
    const escaping = {
      getPanel: () => undefined,
      executePanelForWebUI: async () => {
        saveData('x.json', options, { v: 1 });
        throw new Error('escaped');
      },
    };
    expect(await runPanelAction('panel:execute', { panelId: 'gone', userId: OWNER, guildId }, escaping)).toEqual({ success: false, error: 'escaped' });
    expect(JSON.parse(store.doc(guildId, 'x.json')!)).toEqual({ v: 1 });
    const refusing = {
      getPanel: () => undefined,
      executePanelForWebUI: async () => {
        saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
        throw new Error('escaped');
      },
    };
    expect(await runPanelAction('panel:execute', { panelId: 'gone', userId: OWNER }, refusing)).toEqual({ success: false, error: truthText('not-ready', false) });
  });
});

describe('the registered-button fallback', () => {
  function registered(handler: Handler) {
    const id = `reg-${Math.random()}`;
    const buttons = new Map([['ra_add', { handler, _moduleName: 'roleAssign', timeoutMs: null }]]);
    return { id, pm: panels(panel(id, { handleButton: async () => null }), buttons) };
  }

  it('a handler that throws answers its error, not a fresh view', async () => {
    const { id, pm } = registered(async () => {
      throw new Error('handler failed');
    });
    expect(await runPanelAction('panel:button', { panelId: id, buttonId: 'ra_add_1', userId: OWNER }, pm)).toEqual({ success: false, error: 'handler failed' });
  });

  it('its writes carry the handler\'s module', async () => {
    const { guildId, options } = await storeGuild();
    let modules: string[] = [];
    const { id, pm } = registered(async () => {
      saveData('x.json', options, { v: 1 });
      modules = currentLedger()!.tickets()[0].modules;
    });
    const answer = await runPanelAction('panel:button', { panelId: id, buttonId: 'ra_add_1', userId: OWNER, guildId }, pm);
    expect(answer).toEqual({ success: true, data: { content: 'View' } });
    expect(modules).toEqual(['roleAssign']);
  });

  it('a handler that wrote a refused document and threw answers the truth', async () => {
    const { id, pm } = registered(async () => {
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      throw new Error('handler failed');
    });
    expect(await runPanelAction('panel:button', { panelId: id, buttonId: 'ra_add_1', userId: OWNER }, pm)).toEqual({ success: false, error: truthText('not-ready', false) });
  });

  it.each([['panel', 'panel_ID_btn_nav_x'], ['persistent_warning', 'persistent_warning_ID_web_ui'], ['panel', 'panel']])('core\'s own key %s is skipped: a handleButton that returns null answers the view', async (key, customId) => {
    const id = `nul${Math.random().toString(36).slice(2)}`;
    const buttons = new Map<string, { handler: Handler }>();
    registerPanelButtonHandler({ buttonHandlers: buttons } as unknown as Client, async () => null, new Map());
    const core = buttons.get(key)!;
    const ran = vi.fn(core.handler);
    core.handler = ran;
    const pm = panels(panel(id, { handleButton: async () => null }), buttons);
    const buttonId = customId.replace('ID', id);
    expect(await runPanelAction('panel:button', { panelId: id, buttonId, userId: OWNER }, pm)).toEqual({ success: true, data: { content: 'View' } });
    expect(ran).not.toHaveBeenCalled();
  });

  it('a module key is still matched beside core\'s keys', async () => {
    const id = `mix${Math.random().toString(36).slice(2)}`;
    const buttons = new Map<string, unknown>();
    registerPanelButtonHandler({ buttonHandlers: buttons } as unknown as Client, async () => null, new Map());
    buttons.set('ra_add', { handler: async () => {
      throw new Error('handler failed');
    }, _moduleName: 'roleAssign', timeoutMs: null });
    const pm = panels(panel(id, { handleButton: async () => null }), buttons);
    expect(await runPanelAction('panel:button', { panelId: id, buttonId: 'ra_add_1', userId: OWNER }, pm)).toEqual({ success: false, error: 'handler failed' });
  });
});

describe('answers before any write', () => {
  it('validation answers unchanged', async () => {
    const pm = panels(panel('v', {}));
    expect(await runPanelAction('panel:button', { panelId: 'v', userId: OWNER }, pm)).toEqual({ success: false, error: 'Missing required fields: panelId, buttonId, and userId' });
    expect(await runPanelAction('panel:dropdown', { panelId: 'v', values: 'a', userId: OWNER }, pm)).toEqual({ success: false, error: 'Invalid field: values must be an array' });
  });

  it('a guild still loading answers the loading notice (R5-J3: one text on Discord and panels)', async () => {
    loading.add('777');
    expect(await run('panel:execute', async () => VIEW, '777')).toEqual({ success: false, error: "This server's data is still loading, try again in a moment." });
  });
});

describe('the IPC listener', () => {
  const emitIpc = (message: object) => (process.emit as (event: string, message: object) => boolean)('message', message);

  it('answers a panel action through the verdict, and sends no live update field', async () => {
    const before = process.listeners('message');
    const interval = vi.spyOn(globalThis, 'setInterval').mockReturnValue(undefined as never);
    try {
      setupPanelIPCHandlers();
    } finally {
      interval.mockRestore();
    }
    const listener = process.listeners('message').find(l => !before.includes(l))!;
    try {
      manager.current = panels(panel('ipc-refused', { handleModal: async () => {
        saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
        return VIEW;
      } }));
      emitIpc({ type: 'panel:modal', requestId: 'bt4-1', data: request('panel:modal', 'ipc-refused') });
      manager.current = panels(panel('ipc-ok', { handleDropdown: async () => VIEW }));
      emitIpc({ type: 'panel:dropdown', requestId: 'bt4-2', data: request('panel:dropdown', 'ipc-ok') });
      for (let i = 0; i < 50 && replies.length < 2; i++) await tick(10);
      expect(replies.sort((a, b) => a.requestId.localeCompare(b.requestId))).toEqual([
        { requestId: 'bt4-1', data: { success: false, error: truthText('not-ready', false) } },
        { requestId: 'bt4-2', data: { success: true, data: { content: 'View' } } },
      ]);
      expect(broadcasts).toHaveLength(1);
    } finally {
      process.removeListener('message', listener);
      manager.current = null;
    }
  });
});
