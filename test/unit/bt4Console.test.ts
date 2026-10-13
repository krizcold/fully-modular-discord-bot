import { afterEach, describe, expect, it, vi } from 'vitest';

// BT-4's console rows (notes/BT.md, "BT-4 design sheet: final"), with R1-J22's handleInvoke half: the console invoke
// answers success only when every write its run recorded landed, none was refused, and the dispatcher neither refused
// the command nor caught an error from it.
const local = vi.hoisted(() => ({ commands: [] as any[], calls: 0, vanishAfter: Infinity }));
const premium = vi.hoisted(() => ({ overrides: {} as Record<string, unknown>, access: true }));
const bot = vi.hoisted(() => ({ client: null as any }));

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({
  default: () => (++local.calls > local.vanishAfter ? [] : local.commands),
}));
vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  return { ...real, getPanelManager: () => ({ getClient: () => bot.client }) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/premiumManager')>();
  return {
    ...real,
    getPremiumManager: () => ({
      getTierOverrides: () => premium.overrides,
      getGuildSubscriptionUrl: () => null,
      getMessages: () => ({ moduleBlocked: 'MODULE BLOCKED', commandBlocked: 'COMMAND BLOCKED' }),
      hasFeatureAccess: () => premium.access,
    }),
  };
});

import { confirmWrite, freezeGuildWrites, saveData, saveDataOutcome, unfreezeGuildWrites } from '../../src/bot/internalSetup/utils/dataManager';
import { ledgerOf } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { CONFIRM_MS, truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { handleInvoke } from '../../src/bot/internalSetup/utils/ipcCommandHandler';
import { createPersistentPanel } from '../../src/bot/internalSetup/utils/panel/persistentPanelResponse';
import { notReadyGuild, storeGuild, tick } from '../helpers/gateRig';

afterEach(() => {
  vi.useRealTimers();
  local.vanishAfter = Infinity;
  premium.overrides = {};
  premium.access = true;
});

function fakeClient(guild?: unknown) {
  return {
    isReady: () => true,
    guilds: { cache: new Map(guild ? [[(guild as { id: string }).id, guild]] : []) },
    users: { cache: new Map() },
    user: { id: '11' },
    application: { id: '11' },
  };
}

/** Invokes one command whose callback is fn, as `smdb cmd invoke` does. */
async function invoke(fn: (interaction: any) => Promise<unknown>, extra: Record<string, unknown> = {}, guildId = '555') {
  const name = `cmd${Math.random().toString(36).slice(2, 8)}`;
  local.commands = [{ name, callback: (_client: unknown, interaction: unknown) => fn(interaction), ...extra }];
  bot.client ??= fakeClient();
  const answer = await handleInvoke({ command: name, guildId, force: true });
  return { name, answer };
}

const reply = (content: string) => ({ method: 'reply', payload: { content } });

describe('a console run with no write, or with every write landed', () => {
  it('answers success with its transcript, unchanged', async () => {
    const { name, answer } = await invoke(async i => i.reply({ content: 'Pong' }));
    expect(answer).toMatchObject({ success: true, command: name, captured: [reply('Pong')], replied: true, deferred: false });
    expect(answer).not.toHaveProperty('error');
    expect(answer).not.toHaveProperty('truth');
  });

  it('answers success only once the store committed the write', async () => {
    const { guildId, store, options } = await storeGuild();
    const { answer } = await invoke(async i => {
      saveData('x.json', options, { v: 1 });
      await i.reply({ content: 'Saved!' });
    }, {}, guildId);
    expect(answer).toMatchObject({ success: true, captured: [reply('Saved!')] });
    expect(JSON.parse(store.doc(guildId, 'x.json')!)).toEqual({ v: 1 });
  });
});

describe('a console run whose writes are not confirmed', () => {
  it('a refusal answers the truth, and keeps the transcript', async () => {
    const { answer } = await invoke(async i => {
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.reply({ content: 'Saved!' });
    });
    expect(answer).toMatchObject({ success: false, error: truthText('not-ready', false), truth: 'not-ready', captured: [reply('Saved!')] });
    expect(answer).not.toHaveProperty('pending');
  });

  it('a held write answers held, marked pending', async () => {
    const { guildId, store, options } = await storeGuild();
    store.mode = 'read-only';
    const { answer } = await invoke(async () => {
      saveData('x.json', options, { v: 1 });
    }, {}, guildId);
    expect(answer).toMatchObject({ success: false, error: truthText('held', false), truth: 'held', pending: true });
  });

  it('a guild taken over answers deposed, not pending', async () => {
    const { guildId, store, options } = await storeGuild();
    store.mode = 'deposed';
    const { answer } = await invoke(async () => {
      saveData('x.json', options, { v: 1 });
    }, {}, guildId);
    expect(answer).toMatchObject({ success: false, error: truthText('deposed', false), truth: 'deposed' });
    expect(answer).not.toHaveProperty('pending');
  });

  it('a refusal and then a whole rewrite of the same document answers unavailable', async () => {
    const { guildId, options } = await storeGuild();
    const { answer } = await invoke(async () => {
      freezeGuildWrites(guildId);
      saveDataOutcome('x.json', options, { v: 1 });
      unfreezeGuildWrites(guildId);
      saveDataOutcome('x.json', options, { v: 2 });
    }, {}, guildId);
    expect(answer).toMatchObject({ success: false, error: truthText('unavailable', true), truth: 'unavailable' });
  });

  it('a write still unconfirmed at the confirm bound answers pending', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    const done = invoke(async i => {
      saveData('x.json', options, { v: 1 });
      void confirmWrite(ledgerOf(i)!.tickets()[0].ticket, 60_000);
    }, {}, guildId);
    await tick(40);
    vi.advanceTimersByTime(CONFIRM_MS + 2000);
    const { answer } = await done;
    expect(answer).toMatchObject({ success: false, error: truthText('pending', false), truth: 'pending', pending: true });
    store.release();
  });
});

describe('the command throws (R1-J22)', () => {
  it('with no write unconfirmed, the answer is its error', async () => {
    const { answer } = await invoke(async () => {
      throw new Error('boom');
    });
    expect(answer).toMatchObject({ success: false, error: 'boom' });
    expect(answer).not.toHaveProperty('truth');
  });

  it('a command reaching for an interaction method the console lacks fails', async () => {
    const { answer } = await invoke(async i => i.update({ content: 'x' }));
    expect(answer).toMatchObject({ success: false });
    expect(String(answer.error)).toMatch(/update/);
  });

  it('with a write refused, the truth leads and the error is kept beside it', async () => {
    const { answer } = await invoke(async () => {
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      throw new Error('boom');
    });
    expect(answer).toMatchObject({ success: false, error: truthText('not-ready', false), truth: 'not-ready', handlerError: 'boom' });
  });
});

describe('the dispatcher refuses the command (R1-J22)', () => {
  const refusals: Array<[string, Record<string, unknown>, string, () => void]> = [
    ['developer only', { devOnly: true }, 'Only developers are allowed to run this command.', () => {}],
    ['test server only', { testOnly: true }, 'This command cannot be run here.', () => {}],
    ['bot permissions', { botPermissions: ['Administrator'] }, "I don't have enough permissions.", () => {}],
    ['module blocked', { _moduleName: 'mod' }, 'MODULE BLOCKED', () => { premium.overrides = { _moduleEnabled: false }; }],
    ['command blocked', { _moduleName: 'mod' }, 'COMMAND BLOCKED', () => { premium.overrides = { _disabledCommands: ['*'] }; }],
    ['tier gate', { _moduleName: 'mod', _tierRequirement: { minPriority: 2 } }, 'MODULE BLOCKED', () => { premium.access = false; }],
  ];

  it.each(refusals)('%s: success:false with the reply\'s text', async (_row, extra, text, arrange) => {
    arrange();
    const guild = { id: '555', members: { me: { permissions: { has: () => false } }, cache: new Map() }, channels: { cache: new Map() }, roles: { cache: new Map() } };
    bot.client = fakeClient(guild);
    try {
      const name = `cmd${Math.random().toString(36).slice(2, 8)}`;
      if (Array.isArray(premium.overrides._disabledCommands)) premium.overrides._disabledCommands = [name];
      local.commands = [{ name, callback: async () => { throw new Error('dispatched'); }, ...extra }];
      const answer = await handleInvoke({ command: name, guildId: '555', force: true });
      expect(answer).toMatchObject({ success: false, error: text });
      expect((answer.captured as Array<{ payload: { content: string; flags: number } }>).map(c => [c.payload.content, c.payload.flags])).toEqual([[text, 64]]);
    } finally {
      bot.client = null;
    }
  });

  it('a command gone by the time the dispatcher looks it up', async () => {
    bot.client ??= fakeClient();
    const name = `cmd${Math.random().toString(36).slice(2, 8)}`;
    local.commands = [{ name, callback: async () => undefined }];
    local.vanishAfter = local.calls + 1;
    const answer = await handleInvoke({ command: name, guildId: '555', force: true });
    expect(answer).toMatchObject({ success: false, error: `no such command: ${name}` });
  });
});

describe('a persistent panel the console run did not post', () => {
  it('answers that it was not posted, even when its writes land afterwards', async () => {
    const { guildId, store, options } = await storeGuild();
    store.mode = 'read-only';
    const sent: unknown[] = [];
    const { answer } = await invoke(async i => {
      saveData('x.json', options, { v: 1 });
      i.channel = { send: async (payload: unknown) => { sent.push(payload); return {}; } };
      const context = { client: i.client, interaction: i, panelId: 'pp', userId: 'u', guildId, channelId: null, accessMethod: 'discord', navigationStack: [] };
      await createPersistentPanel(context as never, { id: 'pp', name: 'pp', persistent: true, callback: async () => ({}) } as never, { components: [] } as never);
      store.mode = 'commit';
      await i.reply({ content: 'Posted' });
    }, {}, guildId);
    expect(sent).toEqual([]);
    expect(JSON.parse(store.doc(guildId, 'x.json')!)).toEqual({ v: 1 });
    expect(answer).toMatchObject({ success: false, error: 'the panel was not posted: its writes were not confirmed in time' });
  });

  it('the first outcome is the one answered', async () => {
    const { guildId, store, options } = await storeGuild();
    store.mode = 'read-only';
    const { answer } = await invoke(async i => {
      saveData('x.json', options, { v: 1 });
      i.channel = { send: async () => ({}) };
      const context = { client: i.client, interaction: i, panelId: 'pp', userId: 'u', guildId, channelId: null, accessMethod: 'discord', navigationStack: [] };
      await createPersistentPanel(context as never, { id: 'pp', name: 'pp', persistent: true, callback: async () => ({}) } as never, { components: [] } as never);
      store.mode = 'commit';
      throw new Error('after the panel');
    }, {}, guildId);
    expect(answer).toMatchObject({ success: false, error: 'the panel was not posted: its writes were not confirmed in time' });
  });
});
