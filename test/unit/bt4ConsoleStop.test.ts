import { describe, expect, it, vi } from 'vitest';

// BT-4's console row for a bot that stops mid-run (notes/BT.md, "BT-4 design sheet: final"). Its own file: the drain
// closes writes for good in this process.
const local = vi.hoisted(() => ({ commands: [] as any[] }));

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => local.commands }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  const client = { isReady: () => true, guilds: { cache: new Map() }, users: { cache: new Map() }, user: { id: '11' }, application: { id: '11' } };
  return { ...real, getPanelManager: () => ({ getClient: () => client }) };
});

import { drainForExit, saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { dataUnavailableMessage } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { handleInvoke } from '../../src/bot/internalSetup/utils/ipcCommandHandler';

describe('the bot stops mid-run', () => {
  it('the drain refuses the write as node-stopping, so the console answers the truth', async () => {
    local.commands = [{
      name: 'stopper',
      callback: async () => {
        await drainForExit(200);
        saveData('x.json', { guildId: '555', category: 'm' }, { v: 1 });
      },
    }];
    const answer = await handleInvoke({ command: 'stopper', guildId: '555', force: true });
    expect(answer).toMatchObject({ success: false, error: truthText('node-stopping', false), truth: 'node-stopping' });
    expect(String(answer.handlerError)).toMatch(/stopping/);
    expect(answer.captured).toEqual([{ method: 'reply', payload: { content: dataUnavailableMessage('node-stopping'), flags: 64 } }]);
  });
});
