import { afterEach, describe, expect, it, vi } from 'vitest';

import { saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { currentLedger, ledgerOf, type WriteLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { setupCommandIPCHandlers } from '../../src/bot/internalSetup/utils/ipcCommandHandler';
import { setupPanelIPCHandlers } from '../../src/bot/internalSetup/utils/ipcPanelHandler';

// BT-2: the panel actions and the console invoke run inside their own ledger,
// driven through their real IPC handlers.

const seen = vi.hoisted(() => ({
  panel: undefined as WriteLedger | undefined,
  panelModules: [] as string[][],
  list: 'not called' as unknown,
  console: undefined as WriteLedger | undefined,
  consoleByEntry: undefined as WriteLedger | undefined,
  consoleModules: [] as string[][],
}));

const modulesOf = (ledger: WriteLedger | undefined) => (ledger?.tickets() ?? []).map(e => [...e.modules]);

vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  const client = {
    isReady: () => true,
    user: { id: '1000' },
    users: { cache: new Map() },
    guilds: { cache: new Map() },
  };
  const act = async () => {
    seen.panel = currentLedger();
    saveData('panel.json', { scope: 'global', category: 'bt2' }, { v: 1 });
    seen.panelModules = modulesOf(seen.panel);
    return { success: true };
  };
  const panelManager = {
    getPanel: (id: string) => (id === 'unknown' ? undefined : { id, _moduleName: 'panelMod' }),
    getClient: () => client,
    getWebUIPanelList: () => {
      seen.list = currentLedger();
      return [];
    },
    executePanelForWebUI: act,
    handleWebUIButton: act,
    handleWebUIDropdown: act,
    handleWebUIModal: act,
  };
  return { ...real, getPanelManager: () => panelManager };
});

vi.mock('../../src/bot/internalSetup/events/interactionCreate/handleCommands', () => ({
  default: async (_client: unknown, interaction: object) => {
    seen.console = currentLedger();
    seen.consoleByEntry = ledgerOf(interaction);
    saveData('console.json', { scope: 'global', category: 'bt2' }, { v: 1 });
    seen.consoleModules = modulesOf(seen.console);
  },
}));

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => [{ name: 'ping' }] }));

/** Runs setup and hands back the one process 'message' listener it added, removed from the process. */
function messageHandler(setup: () => void): (message: unknown) => Promise<void> {
  const before = process.listeners('message');
  vi.useFakeTimers({ toFake: ['setInterval'] });
  try {
    setup();
  } finally {
    vi.useRealTimers();
  }
  const added = process.listeners('message').filter(listener => !before.includes(listener));
  expect(added).toHaveLength(1);
  process.removeListener('message', added[0]);
  return added[0] as (message: unknown) => Promise<void>;
}

/** Captures the answers sent for one request id; every other message goes to the real channel. */
function answersFor(requestId: string): unknown[] {
  const answers: unknown[] = [];
  const real = process.send!.bind(process) as (...args: unknown[]) => boolean;
  vi.spyOn(process, 'send').mockImplementation(((message: { requestId?: string; data?: unknown }, ...rest: unknown[]) => {
    if (message && message.requestId === requestId) {
      answers.push(message.data);
      return true;
    }
    return real(message, ...rest);
  }) as never);
  return answers;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the entries that open a ledger', () => {
  it('runs a panel action inside a panel ledger tagged with the panel\'s module, sealed once it answers', async () => {
    const handle = messageHandler(setupPanelIPCHandlers);
    const answers = answersFor('bt2-panel');
    await handle({ type: 'panel:execute', requestId: 'bt2-panel', data: { panelId: 'p1', userId: 'u1' } });
    expect(answers).toEqual([{ success: true }]);
    expect(seen.panel?.kind).toBe('panel');
    expect(seen.panelModules).toEqual([['panelMod']]);
    expect(seen.panel?.sealed).toBe(true);
  });

  it.each([
    ['panel:button', { panelId: 'p1', buttonId: 'b1', userId: 'u2' }],
    ['panel:dropdown', { panelId: 'p1', values: ['v'], userId: 'u3' }],
    ['panel:modal', { panelId: 'p1', modalId: 'm1', fields: { f: 'x' }, userId: 'u4' }],
  ])('runs %s inside a panel ledger too, sealed once it answers', async (type, data) => {
    const handle = messageHandler(setupPanelIPCHandlers);
    const requestId = `bt2-${type}`;
    const answers = answersFor(requestId);
    (seen as { panel?: WriteLedger }).panel = undefined;
    await handle({ type, requestId, data });
    expect(answers).toEqual([{ success: true }]);
    expect(seen.panel?.kind).toBe('panel');
    expect(seen.panelModules).toEqual([['panelMod']]);
    expect(seen.panel?.sealed).toBe(true);
  });

  it('tags a panel action whose panel is not found with the entry\'s kind', async () => {
    const handle = messageHandler(setupPanelIPCHandlers);
    const answers = answersFor('bt2-unknown');
    await handle({ type: 'panel:execute', requestId: 'bt2-unknown', data: { panelId: 'unknown', userId: 'u5' } });
    expect(answers).toEqual([{ success: true }]);
    expect(seen.panelModules).toEqual([['panel']]);
  });

  it('opens no ledger for a panel request that is not an action', async () => {
    const handle = messageHandler(setupPanelIPCHandlers);
    const answers = answersFor('bt2-list');
    await handle({ type: 'panel:list', requestId: 'bt2-list', data: {} });
    expect(answers).toEqual([{ success: true, panels: [] }]);
    expect(seen.list).toBeUndefined();
  });

  it('runs the console invoke inside a console ledger keyed to its interaction, sealed once it answers', async () => {
    const handle = messageHandler(setupCommandIPCHandlers);
    const answers = answersFor('bt2-console');
    await handle({ type: 'command:invoke', requestId: 'bt2-console', data: { command: 'ping' } });
    expect(answers).toHaveLength(1);
    expect((answers[0] as { success?: boolean }).success).toBe(true);
    expect(seen.console?.kind).toBe('console');
    expect(seen.consoleByEntry).toBe(seen.console);
    expect(seen.consoleModules).toEqual([['console']]);
    expect(seen.console?.sealed).toBe(true);
  });
});
