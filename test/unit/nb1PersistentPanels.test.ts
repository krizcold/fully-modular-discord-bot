import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/botManagerAPI', async importOriginal => ({
  ...(await importOriginal<object>()),
  checkForAllBotUpdates: async () => null,
}));

import { updatePersistentPanel } from '../../src/bot/internalSetup/utils/panel/persistentPanelResponse';
import {
  cleanupInvalidPanels,
  getPersistentPanel,
  storePersistentPanel,
  updatePersistentPanelState,
} from '../../src/bot/internalSetup/utils/panel/persistentPanelStorage';
import { setBackendKind } from '../helpers/backendKind';
import { storeGuild } from '../helpers/gateRig';

// NB1 (wip-redesign/sheets/NB1.md, the main session's rulings): the persistent panel writers make each Discord call
// first and then change the stored panels in one update, so a panel record written meanwhile is kept.

afterEach(() => { vi.restoreAllMocks(); });

const err = (code: number) => Object.assign(new Error(`code ${code}`), { code });
const panel = (messageId: string, channelId: string, guildId?: string) =>
  ({ messageId, channelId, userId: '13', ...(guildId ? { guildId } : {}), createdAt: 0, lastUpdated: 0, state: 'a' });

/** A gate a fake Discord call waits on until open() is called; started() resolves once a call reached it. */
function gate() {
  let open: () => void = () => {};
  let reached: () => void = () => {};
  const opened = new Promise<void>(resolve => { open = resolve; });
  const started = new Promise<void>(resolve => { reached = resolve; });
  return { open, started, wait: async () => { reached(); await opened; } };
}

describe('the persistent panel writers keep a record written during their Discord calls', () => {
  it('a panel stored while cleanupInvalidPanels checks its messages survives the cleanup', async () => {
    setBackendKind('file');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const held = gate();
    await storePersistentPanel('nb1-gone', panel('m-gone', 'c-gone'));
    const channel = { isTextBased: () => true, messages: { fetch: async (id: string) => ({ id }) } };
    const client = {
      channels: {
        fetch: async (channelId: string) => {
          if (channelId === 'c-gone') {
            await held.wait();
            throw err(10003);
          }
          return channel;
        },
      },
    } as never;
    const cleanup = cleanupInvalidPanels(client);
    await held.started;
    expect((await storePersistentPanel('nb1-new', panel('m-new', 'c-new'))).success).toBe(true);
    held.open();
    expect(await cleanup).toBe(1);
    expect(await getPersistentPanel('nb1-gone')).toBeNull();
    expect((await getPersistentPanel('nb1-new'))?.messageId).toBe('m-new');
  });

  it.each(['global', 'guild'] as const)('a %s panel\'s state saved during updatePersistentPanel\'s edit survives it', async scope => {
    const guildId = scope === 'guild' ? (await storeGuild()).guildId : undefined;
    if (!guildId) setBackendKind('file');
    const id = `nb1-state-${scope}`;
    await storePersistentPanel(id, panel('m-1', 'c-1', guildId), guildId);
    const held = gate();
    const channel = { isTextBased: () => true, messages: { edit: async () => { await held.wait(); } } };
    const client = { channels: { fetch: async () => channel } } as never;
    const update = updatePersistentPanel(client, id, { content: 'v' } as never, guildId);
    await held.started;
    expect(await updatePersistentPanelState(id, 'b', 'm-1', guildId)).toBe(true);
    held.open();
    expect(await update).toBe(true);
    const stored = await getPersistentPanel(id, guildId);
    expect(stored?.state).toBe('b');
    expect(stored?.sessionData).toEqual({ content: 'v' });
  });
});
