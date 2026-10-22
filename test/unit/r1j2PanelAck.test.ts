import { ActionRowBuilder, ComponentType, DiscordAPIError, InteractionResponseType, ModalBuilder, TextInputBuilder, TextInputStyle, type Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { answerWrites } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { saveData } from '../../src/bot/internalSetup/utils/dataManager';
import buttonEvent from '../../src/bot/internalSetup/events/interactionCreate/buttonHandler';
import dropdownEvent from '../../src/bot/internalSetup/events/interactionCreate/dropdownHandler';
import modalEvent from '../../src/bot/internalSetup/events/interactionCreate/modalSubmitHandler';
import { registerPanelButtonHandler } from '../../src/bot/internalSetup/utils/panel/panelButtonHandler';
import { registerPanelDropdownHandler } from '../../src/bot/internalSetup/utils/panel/panelDropdownHandler';
import { registerPanelModalHandler } from '../../src/bot/internalSetup/utils/panel/panelModalHandler';
import { callbackType, EPHEMERAL, rawButton, rawModal, rig, storeGuild, textOf } from '../helpers/gateRig';
import { fakeClock } from '../helpers/readinessRig';

// R13-J9 (notes/BT.md, "R1-J2 design sheet (L0): final, after the re-read", and review round 1's D8): the panel
// button, dropdown and modal handlers acknowledge at the interaction's emit plus 2.5 s, the window they had before the
// hold, with the reply gate's rule for the kind, so a slow handler never meets "This interaction failed" and never
// sends a second acknowledgement.

const LATE_MODAL = 'This took too long to open its form; please try again.';

let warn: MockInstance;
let error: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let ids = 0;
const nextId = () => `ack-${++ids}`;

function panelClient() {
  const r = rig();
  const client = r.client as Client & Record<string, unknown>;
  client.buttonHandlers = new Map();
  client.dropdownHandlers = new Map();
  client.modalHandlers = new Map();
  return r;
}
const button = () => ({ ...rawButton(nextId()), data: { custom_id: 'panel_p_btn_go', component_type: ComponentType.Button } });
const select = () => ({ ...rawButton(nextId()), data: { custom_id: 'panel_p_dropdown_d', component_type: ComponentType.StringSelect, values: ['a'] } });
const modal = (fromMessage: boolean) => ({ ...rawModal(nextId(), fromMessage), data: { custom_id: 'panel_p_modal_m', components: [] } });
const form = () => new ModalBuilder().setCustomId('panel_p_modal_f').setTitle('Form').addComponents(
  new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('t').setLabel('T').setStyle(TextInputStyle.Short)),
);

describe('the panel button', () => {
  it('a slow handler is acknowledged at the emit plus 2.5 s, then edits its view', async () => {
    fakeClock();
    const { client, wire, emit } = panelClient();
    registerPanelButtonHandler(client, async () => { await sleep(2800); return { content: 'View' } as never; }, new Map());
    const done = emit(button(), i => buttonEvent(client, i));
    await vi.advanceTimersByTimeAsync(2490);
    expect(wire).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredMessageUpdate]);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await done).error).toBeUndefined();
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['patch', 'View']]);
    expect(error).not.toHaveBeenCalled();
  });

  it('a handler that replied itself and runs past the deadline gets no acknowledgement on top', async () => {
    fakeClock();
    const { client, wire, emit } = panelClient();
    registerPanelButtonHandler(client, async context => {
      await (context.interaction as any).reply({ content: 'Working', flags: EPHEMERAL });
      await sleep(2500);
      return null;
    }, new Map());
    const done = emit(button(), i => buttonEvent(client, i));
    await vi.advanceTimersByTimeAsync(3000);
    expect((await done).error).toBeUndefined();
    expect(wire.map(c => [callbackType(c), textOf(c)])).toEqual([[InteractionResponseType.ChannelMessageWithSource, 'Working']]);
    expect(error).not.toHaveBeenCalled();
  });

  it('a modal returned before the deadline is shown', async () => {
    fakeClock();
    const { client, wire, emit } = panelClient();
    registerPanelButtonHandler(client, async () => { await sleep(1000); return { modal: form() } as never; }, new Map());
    const done = emit(button(), i => buttonEvent(client, i));
    await vi.advanceTimersByTimeAsync(1500);
    await done;
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.Modal]);
  });

  it('a modal returned past the reply gate\'s ACK_MS but before the deadline is shown, as before the hold', async () => {
    fakeClock();
    const { client, wire, emit } = panelClient();
    registerPanelButtonHandler(client, async () => { await sleep(2200); return { modal: form() } as never; }, new Map());
    const done = emit(button(), i => buttonEvent(client, i));
    await vi.advanceTimersByTimeAsync(2400);
    await done;
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.Modal]);
  });

  it('a modal returned after the deadline gets the follow-up, not silence', async () => {
    fakeClock();
    const { client, wire, emit } = panelClient();
    registerPanelButtonHandler(client, async () => { await sleep(2700); return { modal: form() } as never; }, new Map());
    const done = emit(button(), i => buttonEvent(client, i));
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(wire.map(callbackType)[0]).toBe(InteractionResponseType.DeferredMessageUpdate);
    expect(wire.slice(1).map(textOf)).toEqual([LATE_MODAL]);
    expect(wire[1].body.flags & EPHEMERAL).toBe(EPHEMERAL);
    expect(warn.mock.calls.map(c => String(c[0]))).toContain('[PanelButtonHandler] Cannot show modal after deferring for: panel_p_btn_go');
  });

  it('a late modal whose follow-up fails logs that the member could not be told, not an error', async () => {
    fakeClock();
    const { client, wire, control, emit } = panelClient();
    registerPanelButtonHandler(client, async () => { await sleep(2700); return { modal: form() } as never; }, new Map());
    const done = emit(button(), i => buttonEvent(client, i));
    setTimeout(() => {
      control.failNext = new DiscordAPIError({ code: 50035, message: 'Invalid Form Body' }, 50035, 400, 'POST', '/webhooks', {});
    }, 2600);
    await vi.advanceTimersByTimeAsync(3500);
    expect((await done).error).toBeUndefined();
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredMessageUpdate]);
    expect(warn.mock.calls.map(c => String(c[0]))).toContain('[PanelButtonHandler] Could not tell the member the form came too late:');
    expect(error).not.toHaveBeenCalled();
  });

  it('a press held before its handler is acknowledged at the emit plus 2.5 s, not 2.5 s after the handler starts', async () => {
    fakeClock();
    const { client, wire, emit } = panelClient();
    registerPanelButtonHandler(client, async () => { await sleep(2000); return { content: 'View' } as never; }, new Map());
    const done = emit(button(), async i => { await sleep(1000); return buttonEvent(client, i); });
    await vi.advanceTimersByTimeAsync(2490);
    expect(wire).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredMessageUpdate]);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await done).error).toBeUndefined();
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['patch', 'View']]);
  });

  it('an acknowledgement refused for another reason is the handler\'s error, not "acknowledged too late"', async () => {
    fakeClock();
    const { client, control, emit } = panelClient();
    registerPanelButtonHandler(client, async () => { await sleep(2800); return { content: 'View' } as never; }, new Map());
    const done = emit(button(), i => buttonEvent(client, i));
    setTimeout(() => {
      control.failNext = new DiscordAPIError({ code: 50035, message: 'Invalid Form Body' }, 50035, 400, 'POST', '/callback', {});
    }, 2490);
    await vi.advanceTimersByTimeAsync(4000);
    await done;
    expect(error.mock.calls.map(c => String(c[0])).some(line => line.startsWith('[PanelButtonHandler] Error handling button'))).toBe(true);
    expect(warn.mock.calls.map(c => String(c[0])).some(line => line.includes('acknowledged too late'))).toBe(false);
  });

  it('an acknowledgement Discord answers as too late logs that the action ran, not an error', async () => {
    fakeClock();
    const { client, wire, control, emit } = panelClient();
    let acted = false;
    registerPanelButtonHandler(client, async () => { await sleep(2800); acted = true; return { content: 'View' } as never; }, new Map());
    const done = emit(button(), i => buttonEvent(client, i));
    setTimeout(() => {
      control.failNext = new DiscordAPIError({ code: 10062, message: 'Unknown interaction' }, 10062, 404, 'POST', '/callback', {});
    }, 2490);
    await vi.advanceTimersByTimeAsync(4000);
    await done;
    expect(acted).toBe(true);
    expect(wire).toEqual([]);
    expect(warn.mock.calls.map(c => String(c[0])).some(line => line.includes('acknowledged too late; the action ran'))).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  for (const at of [2490, 2500, 2510]) {
    it(`the reply gate's own acknowledgement called at ${at} ms, beside the auto-defer at 2500, sends one acknowledgement`, async () => {
      fakeClock();
      const { client, wire, control, emit } = panelClient();
      const { store, options } = await storeGuild();
      store.holding = true;
      control.delayMs = 50;
      let answered: boolean | undefined;
      registerPanelButtonHandler(client, async context => {
        saveData('x.json', options, { v: 1 });
        await sleep(at);
        answered = await answerWrites(context.interaction);
        return { content: 'View' } as never;
      }, new Map());
      const done = emit(button(), i => buttonEvent(client, i));
      await vi.advanceTimersByTimeAsync(2600);
      expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredMessageUpdate]);
      store.release();
      await vi.advanceTimersByTimeAsync(1000);
      expect((await done).error).toBeUndefined();
      expect(answered).toBe(true);
      expect(wire.filter(c => c.route.includes('/callback'))).toHaveLength(1);
      expect(error).not.toHaveBeenCalled();
    });
  }

  it('the auto-defer coming due while the reply gate\'s own acknowledgement is on the wire sends no second one', async () => {
    fakeClock();
    const { client, wire, control, emit } = panelClient();
    const { options } = await storeGuild();
    control.delayMs = 2600;
    let answered: boolean | undefined;
    registerPanelButtonHandler(client, async context => {
      saveData('x.json', options, { v: 1 });
      answered = await answerWrites(context.interaction);
      return { content: 'View' } as never;
    }, new Map());
    // The write lands at the flush debounce, so the gate acknowledges long before the deadline, and its call is still
    // out at 2500, when the auto-defer comes due.
    const done = emit(button(), i => buttonEvent(client, i));
    await vi.advanceTimersByTimeAsync(1500);
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredMessageUpdate]);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await done).error).toBeUndefined();
    expect(answered).toBe(true);
    expect(wire.filter(c => c.route.includes('/callback')).map(callbackType)).toEqual([InteractionResponseType.DeferredMessageUpdate]);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('the panel dropdown', () => {
  it('a slow handler is acknowledged as an update at the deadline, then edits its view', async () => {
    fakeClock();
    const { client, wire, emit } = panelClient();
    registerPanelDropdownHandler(client, async () => { await sleep(2800); return { content: 'View' } as never; }, new Map());
    const done = emit(select(), i => dropdownEvent(client, i));
    await vi.advanceTimersByTimeAsync(2490);
    expect(wire).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredMessageUpdate]);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['patch', 'View']]);
  });

  it('a modal returned before the deadline is shown', async () => {
    fakeClock();
    const { client, wire, emit } = panelClient();
    registerPanelDropdownHandler(client, async () => { await sleep(500); return { modal: form() } as never; }, new Map());
    const done = emit(select(), i => dropdownEvent(client, i));
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.Modal]);
    expect((console.log as unknown as MockInstance).mock.calls.map(c => String(c[0]))).toContain('[PanelDropdownHandler] Modal shown for dropdown: panel_p_dropdown_d');
  });

  it('a modal returned after the deadline gets the follow-up, not a second response', async () => {
    fakeClock();
    const { client, wire, emit } = panelClient();
    registerPanelDropdownHandler(client, async () => { await sleep(2700); return { modal: form() } as never; }, new Map());
    const done = emit(select(), i => dropdownEvent(client, i));
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(wire.map(callbackType)[0]).toBe(InteractionResponseType.DeferredMessageUpdate);
    expect(wire.slice(1).map(textOf)).toEqual([LATE_MODAL]);
    expect(warn.mock.calls.map(c => String(c[0]))).toContain('[PanelDropdownHandler] Cannot show modal after deferring for: panel_p_dropdown_d');
    expect(error).not.toHaveBeenCalled();
  });

  it('an acknowledgement Discord answers as too late logs that the action ran', async () => {
    fakeClock();
    const { client, wire, control, emit } = panelClient();
    let acted = false;
    registerPanelDropdownHandler(client, async () => { await sleep(2800); acted = true; return { content: 'View' } as never; }, new Map());
    const done = emit(select(), i => dropdownEvent(client, i));
    setTimeout(() => {
      control.failNext = new DiscordAPIError({ code: 10062, message: 'Unknown interaction' }, 10062, 404, 'POST', '/callback', {});
    }, 2490);
    await vi.advanceTimersByTimeAsync(4000);
    await done;
    expect(acted).toBe(true);
    expect(wire).toEqual([]);
    expect(warn.mock.calls.map(c => String(c[0]))).toContain('[PanelDropdownHandler] panel_p_dropdown_d acknowledged too late; the action ran');
    expect(error).not.toHaveBeenCalled();
  });
});

describe('the panel modal', () => {
  it('one submitted from a message is acknowledged as an update at the deadline', async () => {
    fakeClock();
    const { client, wire, emit } = panelClient();
    registerPanelModalHandler(client, async () => { await sleep(2800); return { content: 'Done' } as never; }, new Map());
    const done = emit(modal(true), i => modalEvent(client, i));
    await vi.advanceTimersByTimeAsync(2490);
    expect(wire).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredMessageUpdate]);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(wire.map(c => c.method)).toEqual(['post', 'patch']);
  });

  it('one submitted from a slash command is acknowledged as an ephemeral reply, then edited', async () => {
    fakeClock();
    const { client, wire, emit } = panelClient();
    registerPanelModalHandler(client, async () => { await sleep(2800); return { content: 'Done' } as never; }, new Map());
    const done = emit(modal(false), i => modalEvent(client, i));
    await vi.advanceTimersByTimeAsync(2490);
    expect(wire).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredChannelMessageWithSource]);
    expect(wire[0].body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['patch', 'Done']]);
  });

  it('an acknowledgement Discord answers as too late logs that the action ran', async () => {
    fakeClock();
    const { client, wire, control, emit } = panelClient();
    let acted = false;
    registerPanelModalHandler(client, async () => { await sleep(2800); acted = true; return { content: 'Done' } as never; }, new Map());
    const done = emit(modal(true), i => modalEvent(client, i));
    setTimeout(() => {
      control.failNext = new DiscordAPIError({ code: 10062, message: 'Unknown interaction' }, 10062, 404, 'POST', '/callback', {});
    }, 2490);
    await vi.advanceTimersByTimeAsync(4000);
    await done;
    expect(acted).toBe(true);
    expect(wire).toEqual([]);
    expect(warn.mock.calls.map(c => String(c[0]))).toContain('[PanelModalHandler] panel_p_modal_m acknowledged too late; the action ran');
    expect(error).not.toHaveBeenCalled();
  });
});
