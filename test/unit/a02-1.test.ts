import { MessageFlags, MessageFlagsBitField } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { freezeGuildWrites, unfreezeGuildWrites } from '../helpers/freezeGuild';
import { truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import getLocalCommands from '../../src/bot/internalSetup/utils/getLocalCommands';
import { notReadyGuild, rawCommand, rig, storeGuild, textOf } from '../helpers/gateRig';

// A02-1 (R1-J1): a module's "saved" reply over a refused write is replaced by the truth, and no success text is sent.
describe('a02-1: the reply follows the write outcome', () => {
  it('a write in a frozen window: the frozen text, never the module success text', async () => {
    const { wire, emit } = rig();
    const { guildId, options } = await storeGuild();
    await emit(rawCommand('a1'), async i => {
      freezeGuildWrites(guildId);
      expect(saveData('x.json', options, { v: 1 })).toBe(false);
      unfreezeGuildWrites(guildId);
      await i.reply({ content: 'Saved!' });
    });
    expect(wire.map(textOf)).toEqual([truthText('frozen', false)]);
  });

  it('a write to a not-ready working set: the not-ready text', async () => {
    const { wire, emit } = rig();
    const options = notReadyGuild();
    await emit(rawCommand('a2'), async i => {
      saveData('x.json', options, { v: 1 });
      await i.reply({ content: 'Saved!' });
    });
    expect(wire.map(textOf)).toEqual([truthText('not-ready', false)]);
  });
});

// A02-1 (R2-J8): a command called outside any gated entry (a message-triggered proxy) replies through the same truth.
const registry = vi.hoisted(() => ({ modules: [] as any[] }));
vi.mock('../../src/bot/internalSetup/utils/moduleRegistry', () => ({
  getModuleRegistry: () => ({ getAllModules: () => registry.modules }),
}));

function proxyCommand(callback: (client: unknown, proxy: any) => Promise<void>) {
  const command = { name: `proxied${registry.modules.length}`, callback };
  registry.modules.push({ manifest: { name: 'proxymod' }, commands: [command] });
  const handed = getLocalCommands().find(c => c.name === command.name);
  const sent: unknown[] = [];
  const proxy = {
    reply: async (p: unknown) => { sent.push(p); return p; },
    editReply: async (p: unknown) => { sent.push(p); return p; },
    followUp: async (p: unknown) => { sent.push(p); return p; },
  };
  return { handed, proxy, sent };
}

describe('a02-1: a proxied command call is gated by its own ledger', () => {
  it('a frozen write then reply Saved!: the frozen truth text is sent instead', async () => {
    const { guildId, options } = await storeGuild();
    const { handed, proxy, sent } = proxyCommand(async (_c, p) => {
      freezeGuildWrites(guildId);
      expect(saveData('x.json', options, { v: 1 })).toBe(false);
      unfreezeGuildWrites(guildId);
      await p.reply({ content: 'Saved!' });
    });
    await handed.callback({}, proxy);
    expect(sent).toEqual([{ content: truthText('frozen', false) }]);
  });

  it('a not-ready write then reply and followUps: the not-ready text is told once, later followUps dropped', async () => {
    const options = notReadyGuild();
    const { handed, proxy, sent } = proxyCommand(async (_c, p) => {
      saveData('x.json', options, { v: 1 });
      await p.reply({ content: 'Page 1' });
      expect(await p.followUp({ content: 'Page 2' })).toBeUndefined();
      await p.followUp({ content: 'Page 3' });
      await p.editReply({ content: 'Saved' });
    });
    await handed.callback({}, proxy);
    expect(sent).toEqual([{ content: truthText('not-ready', false) }]);
  });

  it('a V2 reply, then a refused write, then editReply: the truth replaces it as V2 with nothing stale kept', async () => {
    const { guildId, options } = await storeGuild();
    const { handed, proxy, sent } = proxyCommand(async (_c, p) => {
      await p.reply({ components: [{ type: 17 }], flags: MessageFlags.IsComponentsV2 });
      freezeGuildWrites(guildId);
      saveData('x.json', options, { v: 1 });
      unfreezeGuildWrites(guildId);
      await p.editReply({ content: 'Saved', embeds: [], components: [] });
    });
    (proxy as any).fetchReply = async () => ({ flags: new MessageFlagsBitField(MessageFlags.IsComponentsV2) });
    await handed.callback({}, proxy);
    const edit = sent[1] as any;
    expect(edit.flags).toBe(MessageFlags.IsComponentsV2);
    expect(edit.content).toBeUndefined();
    expect(edit.attachments).toEqual([]);
    expect(edit.components).toHaveLength(1);
    expect(JSON.stringify(edit.components[0].toJSON())).toContain(truthText('frozen', false));
  });

  it('an embed with buttons, then a refused write, then editReply: embeds and buttons are cleared', async () => {
    const options = notReadyGuild();
    const { handed, proxy, sent } = proxyCommand(async (_c, p) => {
      saveData('x.json', options, { v: 1 });
      await p.editReply({ content: 'Saved', embeds: [], components: [] });
    });
    (proxy as any).fetchReply = async () => ({ flags: new MessageFlagsBitField(0) });
    await handed.callback({}, proxy);
    expect(sent).toEqual([{ content: truthText('not-ready', false), embeds: [], components: [], attachments: [], allowedMentions: { parse: [] } }]);
  });

  it('no write: the module payload goes out unchanged, and the callback is wrapped once', async () => {
    const { handed, proxy, sent } = proxyCommand(async (_c, p) => { await p.reply('Pong'); });
    expect(getLocalCommands().find(c => c.name === handed.name).callback).toBe(handed.callback);
    const reply = proxy.reply;
    await handed.callback({}, proxy);
    expect(sent).toEqual(['Pong']);
    expect(proxy.reply).toBe(reply);
  });
});
