import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/botManagerAPI', async importOriginal => ({
  ...(await importOriginal<object>()),
  checkForAllBotUpdates: async () => null,
}));

import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { deletePanelMessage, convertPanelToError, handlePersistentPanelButton, handlePersistentPanelModal, retireReplacedPanel, updatePanelDynamic, updatePersistentPanel } from '../../src/bot/internalSetup/utils/panel/persistentPanelResponse';
import { recoverPersistentPanels } from '../../src/bot/internalSetup/utils/panel/persistentPanelRecovery';
import { getPersistentPanel, storePersistentPanel } from '../../src/bot/internalSetup/utils/panel/persistentPanelStorage';
import { storeGuild, tick } from '../helpers/gateRig';

// C04-2 (R45-J11, R46-J10): the stored panel message is edited or deleted by id with no read first, a refused edit
// keeps the record and names the permission, a replaced panel is retired, and a result lands only on the message
// that started it.

afterEach(() => { vi.restoreAllMocks(); });

const err = (code: number) => Object.assign(new Error(`code ${code}`), { code });

/** A channel whose read of a message succeeds unless readFails; edit and delete, by id or on the read message, both record. */
function fakeClient(opts: { readFails?: number; changeFails?: number; channelFails?: number; guildId?: string } = {}) {
  const edits: string[] = [];
  const deletes: string[] = [];
  const change = (id: string, into: string[]) => { if (opts.changeFails) throw err(opts.changeFails); into.push(id); return { id }; };
  const channel = {
    isTextBased: () => true,
    messages: {
      fetch: async (id: string) => {
        if (opts.readFails) throw err(opts.readFails);
        return { id, edit: async () => change(id, edits), delete: async () => change(id, deletes) };
      },
      edit: async (id: string) => change(id, edits),
      delete: async (id: string) => { change(id, deletes); },
    },
  };
  const client = {
    channels: { fetch: async () => { if (opts.channelFails) throw err(opts.channelFails); return channel; } },
    guilds: { cache: new Map(opts.guildId ? [[opts.guildId, {}]] : []) },
  };
  return { client: client as never, edits, deletes };
}

async function stored(messageId = '900', panelId?: string) {
  const { guildId } = await storeGuild();
  const id = panelId ?? `c042-${guildId}`;
  await storePersistentPanel(id, { messageId, channelId: '901', userId: '13', guildId, createdAt: 0, lastUpdated: 0 }, guildId);
  return { guildId, panelId: id };
}

describe('the stored panel message is changed by id', () => {
  it('an update edits the stored message when reading it is refused', async () => {
    const { guildId, panelId } = await stored();
    const { client, edits } = fakeClient({ readFails: 50001 });
    expect(await updatePersistentPanel(client, panelId, { content: 'v' } as never, guildId)).toBe(true);
    expect(edits).toEqual(['900']);
  });

  it('a refused edit keeps the record and names the missing permission', async () => {
    const { guildId, panelId } = await stored();
    const warn = vi.spyOn(console, 'warn');
    const { client } = fakeClient({ changeFails: 50013 });
    expect(await updatePersistentPanel(client, panelId, { content: 'v' } as never, guildId)).toBe(false);
    expect((await getPersistentPanel(panelId, guildId))?.messageId).toBe('900');
    expect(warn.mock.calls.some(c => String(c[0]).includes('lacks'))).toBe(true);
  });

  it('an unknown message drops the record', async () => {
    const { guildId, panelId } = await stored();
    const { client } = fakeClient({ changeFails: 10008 });
    expect(await updatePersistentPanel(client, panelId, { content: 'v' } as never, guildId)).toBe(false);
    expect(await getPersistentPanel(panelId, guildId)).toBeNull();
  });

  it('a late unknown-message answer for a replaced panel leaves the newer record', async () => {
    const { guildId, panelId } = await stored('old');
    const replaceThenFail = async () => {
      await storePersistentPanel(panelId, { messageId: 'new', channelId: '901', userId: '13', guildId, createdAt: 0, lastUpdated: 0 }, guildId);
      throw err(10008);
    };
    const channel = { isTextBased: () => true, messages: { fetch: async () => ({ edit: replaceThenFail }), edit: replaceThenFail } };
    const client = { channels: { fetch: async () => channel } } as never;
    expect(await updatePersistentPanel(client, panelId, { content: 'v' } as never, guildId)).toBe(false);
    expect((await getPersistentPanel(panelId, guildId))?.messageId).toBe('new');
  });

  it('a replaced unique panel is deleted by id, and a non-unique one edited into the inactive view', async () => {
    const a = fakeClient({ readFails: 50001 });
    await retireReplacedPanel(a.client, { id: 'p', unique: true } as never, { messageId: '700', channelId: '901' } as never);
    expect(a.deletes).toEqual(['700']);
    const b = fakeClient({ readFails: 50001 });
    await retireReplacedPanel(b.client, { id: 'p' } as never, { messageId: '701', channelId: '901' } as never);
    expect(b.edits).toEqual(['701']);
  });

  it('delete and the inactive view need no read of the message', async () => {
    const a = fakeClient({ readFails: 50001 });
    expect(await deletePanelMessage(a.client, { messageId: '702', channelId: '901' } as never)).toBe(true);
    expect(a.deletes).toEqual(['702']);
    const b = fakeClient({ readFails: 50001 });
    await convertPanelToError(b.client, { messageId: '703', channelId: '901' } as never, 'gone');
    expect(b.edits).toEqual(['703']);
  });
});

describe('a result lands only on the message that started it', () => {
  async function press(via: 'button' | 'modal', pressedOn: string) {
    const { guildId, panelId } = await stored('new');
    const { client, edits } = fakeClient();
    const panel = { id: panelId, name: 'p', persistent: true, handleButton: async () => ({ content: 'v' }), handleModal: async () => ({ content: 'v' }) };
    const context = { client, interaction: { message: { id: pressedOn } }, panelId, userId: '13', guildId, accessMethod: 'direct_command', navigationStack: [] };
    await runInLedger(openLedger('panel'), null, async () => {
      if (via === 'button') await handlePersistentPanelButton(context as never, panel as never, 'go');
      else await handlePersistentPanelModal(context as never, panel as never, 'go');
    });
    return edits;
  }

  it('a button pressed on an older message does not edit the newer one', async () => {
    expect(await press('button', 'old')).toEqual([]);
  });

  it('a modal sent from an older message does not edit the newer one', async () => {
    expect(await press('modal', 'old')).toEqual([]);
  });

  it('a button pressed on the current message edits it', async () => {
    expect(await press('button', 'new')).toEqual(['new']);
  });

  it('an async result started on an older message is dropped once the record has moved', async () => {
    const { guildId, panelId } = await stored('new');
    const { client, edits } = fakeClient();
    const context = { client, interaction: null, panelId, userId: '', guildId, accessMethod: 'direct_command', navigationStack: [] };
    expect(await updatePanelDynamic(context as never, panelId, { content: 'v' } as never, undefined, 'old')).toBe(false);
    expect(edits).toEqual([]);
  });
});

describe('the Update panel after a restart', () => {
  it('keeps the record when the channel is not visible to the bot', async () => {
    const { guildId } = await stored('900', 'update_manager');
    const { client } = fakeClient({ channelFails: 50001, guildId });
    await recoverPersistentPanels(client);
    await tick(20);
    expect((await getPersistentPanel('update_manager', guildId))?.messageId).toBe('900');
  });

  it('marks the panel recovered only when the refreshed view was shown', async () => {
    const refused = await stored('900', 'update_manager');
    await recoverPersistentPanels(fakeClient({ changeFails: 50013, guildId: refused.guildId }).client);
    await tick(50);
    expect((await getPersistentPanel('update_manager', refused.guildId))?.state).not.toBe('recovered');

    const shown = await stored('901', 'update_manager');
    const ok = fakeClient({ readFails: 50001, guildId: shown.guildId });
    await recoverPersistentPanels(ok.client);
    await tick(50);
    expect(ok.edits).toEqual(['901']);
    expect((await getPersistentPanel('update_manager', shown.guildId))?.state).toBe('recovered');
  });
});
