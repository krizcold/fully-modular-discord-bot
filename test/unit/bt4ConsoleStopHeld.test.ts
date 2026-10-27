import { describe, expect, it, vi } from 'vitest';

// BT1C-3's console row for a write held when the exit drain runs. Its own file: the drain closes writes for good in
// this process.
const local = vi.hoisted(() => ({ commands: [] as any[] }));

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => local.commands }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  const client = { isReady: () => true, guilds: { cache: new Map() }, users: { cache: new Map() }, user: { id: '11' }, application: { id: '11' } };
  return { ...real, getPanelManager: () => ({ getClient: () => client }) };
});

import { drainForExit, saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { handleInvoke } from '../../src/bot/internalSetup/utils/ipcCommandHandler';
import { storeGuild } from '../helpers/gateRig';

describe('the bot stops with a write held', () => {
  it('the console answers that the change may be lost, not that the bot keeps retrying', async () => {
    const { guildId, store, options } = await storeGuild();
    store.mode = 'unavailable';
    local.commands = [{
      name: 'holder',
      callback: async () => {
        saveData('x.json', options, { v: 1 });
        await drainForExit(200);
      },
    }];
    const answer = await handleInvoke({ command: 'holder', guildId, force: true });
    expect(answer).toMatchObject({
      success: false,
      error: 'The bot is restarting and could not confirm your change was saved; it may be lost. Please check once it is back.',
      truth: 'held',
      pending: true,
    });
  });
});
