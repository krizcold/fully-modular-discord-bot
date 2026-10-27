import { ComponentType, InteractionResponseType, ModalBuilder, TextInputStyle } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { confirmWrite, saveData, saveDataOutcome } from '../../src/bot/internalSetup/utils/dataManager';
import { ledgerOf, openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { ACK_MS, answerWrites, truthText, writesConfirmed } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { createPersistentPanel, handlePersistentPanelButton, handlePersistentPanelModal } from '../../src/bot/internalSetup/utils/panel/persistentPanelResponse';
import { storePersistentPanel } from '../../src/bot/internalSetup/utils/panel/persistentPanelStorage';
import { callbackType, EPHEMERAL, notReadyGuild, rawButton, rawCommand, rawModal, rig, storeGuild, textOf, tick } from '../helpers/gateRig';

// BT-3 for the core senders whose visible result is a Discord message, not a response (notes/BT.md, "BT-3 design
// sheet (L0)"): a persistent panel's shared message shows a handler's writes only once they are confirmed.

afterEach(() => {
  vi.useRealTimers();
});

describe('answerWrites', () => {
  it('answers true and sends nothing when the writes landed', async () => {
    const { wire, emit } = rig();
    const { options } = await storeGuild();
    let answered: boolean | undefined;
    await emit(rawButton('p1'), async i => {
      saveData('x.json', options, { v: 1 });
      expect(await confirmWrite(ledgerOf(i)!.tickets()[0].ticket, 5000)).toBe('ok');
      answered = await answerWrites(i);
    });
    expect(answered).toBe(true);
    expect(wire).toEqual([]);
  });

  it('answers false and tells the member when a write is held', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.mode = 'read-only';
    let answered: boolean | undefined;
    await emit(rawButton('p2'), async i => {
      saveData('x.json', options, { v: 1 });
      answered = await answerWrites(i);
    });
    expect(answered).toBe(false);
    expect(wire.map(c => [callbackType(c), textOf(c)])).toEqual([[InteractionResponseType.ChannelMessageWithSource, truthText('held', false)]]);
    expect(wire[0].body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
  });

  it('acknowledges by the deadline, as an update for a component, and then answers', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let answered: boolean | undefined;
    const done = emit(rawButton('p3'), async i => {
      saveData('x.json', options, { v: 1 });
      vi.advanceTimersByTime(ACK_MS - 20);
      answered = await answerWrites(i);
    });
    await tick(80);
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredMessageUpdate]);
    store.release();
    await done;
    expect(answered).toBe(true);
    expect(wire).toHaveLength(1);
  });

  it('on an interaction its caller already deferred, waiting past the deadline sends no second acknowledgement', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let answered: boolean | undefined;
    const done = emit(rawButton('p18'), async i => {
      await i.deferUpdate(); // persistentPanelWarning's own deferral
      saveData('x.json', options, { v: 1 });
      vi.advanceTimersByTime(ACK_MS + 100); // a slow panel callback
      answered = await answerWrites(i);
    });
    await tick(80);
    store.release();
    const { error } = await done;
    expect(error).toBeUndefined();
    expect(answered).toBe(true);
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredMessageUpdate]);
  });

  it('acknowledges before answering true when it waited on the writes', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let deferred: boolean | undefined;
    await emit(rawButton('p6'), async i => {
      saveData('x.json', options, { v: 1 });
      const answered = answerWrites(i);
      await tick(20);
      store.release();
      expect(await answered).toBe(true);
      deferred = i.deferred;
    });
    expect(deferred).toBe(true);
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredMessageUpdate]);
  });

  it('its own defer reads as an acknowledgement from the call, so a flag reader sends no second one', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { client, emit } = rig();
    const rest = client.rest as unknown as { post: (...a: unknown[]) => Promise<unknown> };
    const post = rest.post;
    rest.post = async (...a: unknown[]) => { await tick(40); return post(...a); };
    const { store, options } = await storeGuild();
    store.holding = true;
    const unanswered: boolean[] = [];
    let secondError: unknown;
    await emit(rawButton('p7'), async i => {
      saveData('x.json', options, { v: 1 });
      vi.advanceTimersByTime(ACK_MS + 450);
      const answered = answerWrites(i);
      await tick(0); // answerWrites has started; its deferral waits on a timer of at least 1 ms
      unanswered.push(!i.deferred && !i.replied);
      await tick(15);
      unanswered.push(!i.deferred && !i.replied);
      const second = unanswered.some(Boolean) ? i.deferUpdate().catch((e: unknown) => { secondError = e; }) : Promise.resolve();
      store.release();
      await Promise.all([answered, second]);
    });
    expect(unanswered).toEqual([false, false]);
    expect(secondError).toBeUndefined();
  });

  it('on a command, its deferral at the deadline reads as an acknowledgement while it is on the wire', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { client, emit } = rig();
    const rest = client.rest as unknown as { post: (...a: unknown[]) => Promise<unknown> };
    const post = rest.post;
    rest.post = async (...a: unknown[]) => { await tick(40); return post(...a); };
    const { store, options } = await storeGuild();
    store.holding = true;
    let answeredFlag: boolean | undefined;
    await emit(rawCommand('p9'), async i => {
      saveData('x.json', options, { v: 1 });
      vi.advanceTimersByTime(ACK_MS - 10);
      const answered = answerWrites(i);
      await tick(0); // answerWrites has started, 10 ms before the deadline
      vi.advanceTimersByTime(20);
      await tick(30);
      answeredFlag = i.deferred || i.replied;
      store.release();
      await answered;
    });
    expect(answeredFlag).toBe(true);
  });

  it('on a command, its own truth reply reads as a reply while it is on the wire', async () => {
    const { client, emit } = rig();
    const rest = client.rest as unknown as { post: (...a: unknown[]) => Promise<unknown> };
    const post = rest.post;
    rest.post = async (...a: unknown[]) => { await tick(40); return post(...a); };
    let repliedFlag: boolean | undefined;
    await emit(rawCommand('p10'), async i => {
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      const answered = answerWrites(i);
      await tick(15);
      repliedFlag = i.replied;
      expect(await answered).toBe(false);
    });
    expect(repliedFlag).toBe(true);
  });

  it('an acknowledgement that fails rejects, and leaves the flags unanswered', async () => {
    const { control, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let flags: boolean[] = [];
    let rejected: unknown;
    await emit(rawCommand('p17'), async i => {
      saveData('x.json', options, { v: 1 });
      const answered = answerWrites(i);
      await tick(20);
      control.failNext = new Error('Unknown interaction');
      store.release();
      await answered.catch((e: unknown) => { rejected = e; });
      flags = [i.deferred, i.replied];
    });
    expect((rejected as Error)?.message).toBe('Unknown interaction');
    expect(flags).toEqual([false, false]);
  });

  for (const [label, raw] of [['a command', () => rawCommand('p11')], ['a modal submitted from a command', () => rawModal('p12', false)]] as const) {
    it(`on ${label} it waited for, hands it back acknowledged by an ephemeral deferral before true`, async () => {
      const { wire, emit } = rig();
      const { store, options } = await storeGuild();
      store.holding = true;
      let deferred: boolean | undefined;
      await emit(raw(), async i => {
        saveData('x.json', options, { v: 1 });
        const answered = answerWrites(i);
        await tick(20);
        store.release();
        expect(await answered).toBe(true);
        deferred = i.deferred;
      });
      expect(deferred).toBe(true);
      expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredChannelMessageWithSource]);
      expect(wire[0].body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
    });
  }

  it('on a modal submitted from a command, the flags read answered while it waits', async () => {
    const { emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let midWait: boolean | undefined;
    await emit(rawModal('p16', false), async i => {
      saveData('x.json', options, { v: 1 });
      const answered = answerWrites(i);
      await tick(10);
      midWait = i.deferred || i.replied;
      store.release();
      await answered;
    });
    expect(midWait).toBe(true);
  });

  it('waited on near the deadline, a modal from a command is acknowledged by ACK_MS though its caller edits the shared message first', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { control, emit } = rig();
    const callbacksAt: number[] = [];
    control.onSend = call => { if (call.route.includes('/callback')) callbacksAt.push(performance.now()); };
    const { store, options } = await storeGuild();
    store.holding = true;
    let openedAt = 0;
    const { error } = await emit(rawModal('p15', false), async i => {
      openedAt = ledgerOf(i)!.openedAt;
      saveData('x.json', options, { v: 1 });
      vi.advanceTimersByTime(ACK_MS - 20);
      const answered = answerWrites(i);
      await tick(0);
      store.release();
      expect(await answered).toBe(true);
      vi.advanceTimersByTime(400); // updatePersistentPanel's fetches and message.edit
      // panelModalHandler's message-less branch
      if (i.replied || i.deferred) await i.editReply({ content: 'panel view' });
      else await i.reply({ content: 'panel view', flags: EPHEMERAL });
    });
    expect(error).toBeUndefined();
    expect(callbacksAt).toHaveLength(1);
    expect(callbacksAt[0] - openedAt).toBeLessThanOrEqual(ACK_MS);
  });

  it('on a modal submitted from a command, its deferral at the deadline is an ephemeral reply, not an update', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    const done = emit(rawModal('p13', false), async i => {
      saveData('x.json', options, { v: 1 });
      vi.advanceTimersByTime(ACK_MS - 20);
      expect(await answerWrites(i)).toBe(true);
    });
    await tick(80);
    store.release();
    await done;
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredChannelMessageWithSource]);
    expect(wire[0].body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
  });

  it('on a modal submitted from a component message, acknowledges as an update', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    await emit(rawModal('p14', true), async i => {
      saveData('x.json', options, { v: 1 });
      const answered = answerWrites(i);
      await tick(20);
      store.release();
      expect(await answered).toBe(true);
    });
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredMessageUpdate]);
  });

  it('its own truth reply reads as an acknowledgement while it is on the wire', async () => {
    const { client, emit } = rig();
    const rest = client.rest as unknown as { post: (...a: unknown[]) => Promise<unknown> };
    const post = rest.post;
    rest.post = async (...a: unknown[]) => { await tick(40); return post(...a); };
    let answeredFlag: boolean | undefined;
    let answer: boolean | undefined;
    await emit(rawButton('p8'), async i => {
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      const answered = answerWrites(i);
      await tick(15);
      answeredFlag = i.deferred || i.replied;
      answer = await answered;
    });
    expect(answeredFlag).toBe(true);
    expect(answer).toBe(false);
  });
});

describe('writesConfirmed', () => {
  it('answers without sending anything, and false once the ack deadline passes unconfirmed', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let answered: boolean | undefined;
    let tookMs = 0;
    const done = emit(rawButton('p4'), async i => {
      saveData('x.json', options, { v: 1 });
      vi.advanceTimersByTime(ACK_MS - 20);
      const started = Date.now();
      answered = await writesConfirmed(i);
      tookMs = Date.now() - started;
    });
    await done;
    expect(answered).toBe(false);
    expect(tookMs).toBeLessThan(1000);
    expect(wire).toEqual([]);
    store.release();
  });

  it('answers false for a refusal, and true for landed writes', async () => {
    const { wire, emit } = rig();
    const { options } = await storeGuild();
    const answers: boolean[] = [];
    await emit(rawButton('p5'), async i => {
      saveData('x.json', options, { v: 1 });
      answers.push(await writesConfirmed(i));
      saveDataOutcome('y.json', notReadyGuild(), { v: 1 });
      answers.push(await writesConfirmed(i));
    });
    expect(answers).toEqual([true, false]);
    expect(wire).toEqual([]);
  });
});

describe('an interaction no gate holds', () => {
  it('answerWrites and writesConfirmed judge the frame\'s ledger, and send nothing', async () => {
    const { options } = await storeGuild();
    await runInLedger(openLedger('panel'), null, async () => {
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      expect(await answerWrites({})).toBe(false);
      expect(await writesConfirmed({})).toBe(false);
    });
    await runInLedger(openLedger('panel'), null, async () => {
      saveData('x.json', options, { v: 1 });
      expect(await answerWrites({})).toBe(true);
      expect(await writesConfirmed({})).toBe(true);
    });
  });
});

describe('a persistent panel button', () => {
  async function pressed(refuse: boolean, via: 'button' | 'modal' = 'button') {
    const { wire, emit } = rig();
    const { guildId, options } = await storeGuild();
    const panelId = `panel-${guildId}`;
    await storePersistentPanel(panelId, { messageId: '500', channelId: '901', userId: '13', guildId, createdAt: 0, lastUpdated: 0 }, guildId);
    const edits: unknown[] = [];
    const message = { id: '500', edit: async (payload: unknown) => { edits.push(payload); return message; } };
    const channel = { isTextBased: () => true, messages: { fetch: async () => message, edit: async (_id: string, payload: unknown) => message.edit(payload) } };
    const client = { channels: { fetch: async () => channel } };
    const write = () => {
      if (refuse) saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      else saveData('x.json', options, { v: 1 });
      return { content: 'Saved view' };
    };
    const panel = { id: panelId, name: 'p', persistent: true, handleButton: async () => write(), handleModal: async () => write() };
    await emit(rawButton(`pp-${refuse}-${via}`), async i => {
      const context = { client, interaction: i, panelId, userId: '13', guildId, accessMethod: 'direct_command', navigationStack: [] };
      if (via === 'button') await handlePersistentPanelButton(context as never, panel as never, 'go');
      else await handlePersistentPanelModal(context as never, panel as never, 'go');
    });
    return { wire, edits };
  }

  it('edits the shared message once the handler\'s writes landed', async () => {
    const { wire, edits } = await pressed(false);
    expect(edits).toHaveLength(1);
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredMessageUpdate]);
  });

  it('leaves the shared message as it was when a write was refused, and tells the member', async () => {
    const { wire, edits } = await pressed(true);
    expect(edits).toEqual([]);
    expect(wire.map(textOf)).toEqual([truthText('not-ready', false)]);
  });

  it('a persistent modal does the same', async () => {
    const { wire, edits } = await pressed(true, 'modal');
    expect(edits).toEqual([]);
    expect(wire.map(textOf)).toEqual([truthText('not-ready', false)]);
  });

  it('a handler that saves and returns a modal can still show it, and the shared message is left as it was', async () => {
    const { wire, emit } = rig();
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    const panelId = `panel-${guildId}`;
    await storePersistentPanel(panelId, { messageId: '500', channelId: '901', userId: '13', guildId, createdAt: 0, lastUpdated: 0 }, guildId);
    const edits: unknown[] = [];
    const message = { id: '500', edit: async (payload: unknown) => { edits.push(payload); return message; } };
    const client = { channels: { fetch: async () => ({ isTextBased: () => true, messages: { fetch: async () => message, edit: async (_id: string, payload: unknown) => message.edit(payload) } }) } };
    const modal = new ModalBuilder({
      custom_id: 'panel_m',
      title: 'Edit',
      components: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.TextInput, custom_id: 'v', label: 'Value', style: TextInputStyle.Short }] }],
    });
    const panel = { id: panelId, name: 'p', persistent: true, handleButton: async () => { saveData('x.json', options, { v: 1 }); return { modal }; } };
    let modalError: unknown;
    await emit(rawButton('pp-modal'), async i => {
      const context = { client, interaction: i, panelId, userId: '13', guildId, accessMethod: 'direct_command', navigationStack: [] };
      setTimeout(() => store.release(), 20);
      const response: any = await handlePersistentPanelButton(context as never, panel as never, 'edit');
      // panelButtonHandler shows a returned modal only while the interaction reads unanswered.
      if (response?.modal && !i.deferred && !i.replied) await i.showModal(response.modal).catch((e: unknown) => { modalError = e; });
      else modalError = 'not shown: the interaction reads acknowledged';
    });
    expect(modalError).toBeUndefined();
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.Modal]);
    expect(edits).toEqual([]);
  });
});

describe('a new persistent panel', () => {
  async function created(refuse: boolean) {
    const { wire, emit } = rig();
    const { guildId, options } = await storeGuild();
    const sent: unknown[] = [];
    let message: unknown = 'not called';
    await emit(rawButton(`np-${refuse}`), async i => {
      Object.defineProperty(i, 'channel', { value: { send: async (payload: unknown) => { sent.push(payload); return {}; } } });
      if (refuse) saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      else saveData('x.json', options, { v: 1 });
      const context = { client: i.client, interaction: i, panelId: 'np', userId: '13', guildId, accessMethod: 'direct_command', navigationStack: [] };
      message = await createPersistentPanel(context as never, { id: 'np', name: 'np' } as never, { content: 'Panel' } as never);
    });
    return { wire, sent, message };
  }

  it('is posted once the callback\'s writes landed', async () => {
    const { wire, sent } = await created(false);
    expect(sent).toHaveLength(1);
    expect(wire).toEqual([]);
  });

  it('is not posted while a write is refused, sends nothing itself, and logs the skip', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { wire, sent, message } = await created(true);
    expect(sent).toEqual([]);
    expect(message).toBeNull();
    expect(wire).toEqual([]);
    expect(warn.mock.calls.some(call => String(call[0]).includes('was not posted'))).toBe(true);
    warn.mockRestore();
  });

  it('is not posted when the ack deadline passes unconfirmed, and logs the skip', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { emit } = rig();
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    const sent: unknown[] = [];
    let message: unknown = 'not called';
    await emit(rawButton('np-late'), async i => {
      Object.defineProperty(i, 'channel', { value: { send: async (payload: unknown) => { sent.push(payload); return {}; } } });
      saveData('x.json', options, { v: 1 });
      vi.advanceTimersByTime(ACK_MS - 20);
      const context = { client: i.client, interaction: i, panelId: 'np', userId: '13', guildId, accessMethod: 'direct_command', navigationStack: [] };
      message = await createPersistentPanel(context as never, { id: 'np', name: 'np' } as never, { content: 'Panel' } as never);
    });
    store.release();
    expect(sent).toEqual([]);
    expect(message).toBeNull();
    expect(warn.mock.calls.some(call => String(call[0]).includes('was not posted'))).toBe(true);
    warn.mockRestore();
  });
});
