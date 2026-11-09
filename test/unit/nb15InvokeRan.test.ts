import { afterEach, describe, expect, it, vi } from 'vitest';

// NB15 test 1 (decision 7): an invoke that ran says so. Through answerInvokeMessage, as both listeners answer it: a
// callback's throw answers ran true, a failed verdict (writes refused because another process took the guild) answers
// ran true with ranTruthText's text, and handleInvoke's own refusals ran false.
const local = vi.hoisted(() => ({ commands: [] as any[] }));
const bot = vi.hoisted(() => ({ client: null as any }));

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => local.commands }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  return { ...real, getPanelManager: () => ({ getClient: () => bot.client }) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/premiumManager')>();
  return {
    ...real,
    getPremiumManager: () => ({
      getTierOverrides: () => ({}), getGuildSubscriptionUrl: () => null,
      getMessages: () => ({ moduleBlocked: 'MODULE BLOCKED', commandBlocked: 'COMMAND BLOCKED' }), hasFeatureAccess: () => true,
    }),
  };
});

import { saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { ranTruthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { answerInvokeMessage } from '../../src/bot/internalSetup/utils/ipcCommandHandler';
import { _resetPanelHandler } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { storeGuild } from '../helpers/gateRig';

function fakeClient(guild?: { id: string }) {
  return {
    isReady: () => true,
    guilds: { cache: new Map(guild ? [[guild.id, guild]] : []) },
    channels: { cache: new Map(), fetch: async () => null },
    users: { cache: new Map() },
    user: { id: '11' },
    application: { id: '11' },
  };
}

async function invoke(fn: (interaction: any) => Promise<unknown>, guildId?: string) {
  const name = `cmd${Math.random().toString(36).slice(2, 8)}`;
  local.commands = [{ name, callback: (_client: unknown, interaction: unknown) => fn(interaction) }];
  bot.client ??= fakeClient();
  return answerInvokeMessage({ command: name, ...(guildId ? { guildId } : {}), force: true }, 'ipc');
}

afterEach(() => {
  _resetPanelHandler();
  bot.client = null;
  vi.restoreAllMocks();
});

describe('ran (decision 7)', () => {
  it('a callback that throws answers ran true: its code ran', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const answer = await invoke(async () => { throw new Error('the module broke'); });
    expect(answer).toMatchObject({ success: false, ran: true });
  });

  it("a failed verdict answers ran true, truth 'deposed' and ranTruthText's text", async () => {
    const { guildId, store, options } = await storeGuild();
    bot.client = fakeClient();
    store.mode = 'deposed';
    const answer = await invoke(async () => { saveData('x.json', options, { v: 1 }); }, guildId);
    expect(answer).toMatchObject({ success: false, ran: true, truth: 'deposed', error: ranTruthText({ answer: 'deposed', partial: false }) });
    expect(String(answer.error)).not.toMatch(/[Tt]ry again/);
  });

  it("handleInvoke's own refusal answers ran false", async () => {
    local.commands = [];
    expect(await answerInvokeMessage({ command: 'missing' }, 'ipc')).toMatchObject({ success: false, ran: false });
  });
});
