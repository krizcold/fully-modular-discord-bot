import fs from 'fs';
import path from 'path';
import { ComponentType, ContainerBuilder, Events, InteractionResponse, InteractionResponseType, MessagePayload, ModalBuilder, TextDisplayBuilder } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// BT1C-3: a stop begun, without the exit drain closing this file's writes for good.
const stop = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return { ...real, isStopping: () => stop.on || real.isStopping() };
});

import {
  appendData,
  confirmWrite,
  deleteDataOutcome,
  freezeGuildWrites,
  saveData,
  saveDataOutcome,
  unfreezeGuildWrites,
} from '../../src/bot/internalSetup/utils/dataManager';
import {
  INTERACTION_LEDGER_LIFE_MS,
  ledgerOf,
  openLedger,
  runInLedger,
} from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { ACK_MS, answerWrites, installReplyGate, truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { IngestService } from '../../src/bot/internalSetup/ingest/ingestService';
import { getWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { tokenFor } from '../helpers/fakeStore';

// BT-3, the interaction reply gate (notes/BT.md, "BT-3 design sheet (L0)"). A response method on a real interaction
// sends the module's payload only once every write in the union of its ledgers has landed and none was refused;
// otherwise the truth goes in its place, and the interaction is acknowledged inside ACK_MS either way.

import {
  callbackType, EPHEMERAL, fakeMessage, notReadyGuild, rawButton, rawCommand, rig, storeGuild, textOf, tick, unknownMessage, V2, type WireCall,
} from '../helpers/gateRig';

afterEach(() => {
  vi.useRealTimers();
  stop.on = false;
});

describe('the truth texts', () => {
  it('names each answer, in the "not saved" form or, when another write landed, the "in full" form', () => {
    expect(truthText('node-stopping', false)).toBe('The bot is restarting, so your change was not saved. Please try again in a moment.');
    expect(truthText('node-stopping', true)).toBe('The bot is restarting, so your change was not saved in full. Please try again in a moment.');
    expect(truthText('database-read-only', false)).toBe("The bot's database is read-only while a backup covers an outage, so your change was not saved. Please try again in a few minutes.");
    expect(truthText('guild-fenced', false)).toBe("This server's data just moved to another bot node, so your change was not saved. Please try again in a moment.");
    expect(truthText('deposed', true)).toBe("This server's data just moved to another bot node, so your change was not saved in full. Please try again in a moment.");
    expect(truthText('database-unreachable', false)).toBe("The bot's database is currently unreachable, so your change was not saved. Please try again later or contact support.");
    expect(truthText('database-unreachable', true)).toBe("The bot's database is unreachable, so your change was not saved in full. Please try again later.");
    expect(truthText('frozen', false)).toBe("This server's data is being moved, so your change was not saved. Please try again in a moment.");
    expect(truthText('not-ready', true)).toBe("This server's data is still loading, so your change was not saved in full. Please try again in a moment.");
    expect(truthText('io', false)).toBe('The bot could not write to storage, so your change was not saved. Please try again.');
    expect(truthText('unavailable', false)).toBe('The bot cannot confirm whether your change was saved. Please check before you try again.');
    expect(truthText('unavailable', true)).toBe('The bot cannot confirm whether your change was saved in full. Please check before you try again.');
    expect(truthText('held', false)).toBe('Your change is not saved yet: storage refused it for now, and the bot keeps retrying. Please check again in a few minutes.');
    expect(truthText('held', true)).toBe('Your change is not saved in full yet: storage refused it for now, and the bot keeps retrying. Please check again in a few minutes.');
    expect(truthText('pending', false)).toBe('Your change is not confirmed as saved yet. Please check again in a moment.');
    expect(truthText('pending', true)).toBe('Your change is not confirmed as saved in full yet. Please check again in a moment.');
  });
});

describe('the truth texts while the bot stops', () => {
  it('a held or pending answer says the change may be lost; the others are as before', () => {
    stop.on = true;
    const lost = 'The bot is restarting and could not confirm your change was saved; it may be lost. Please check once it is back.';
    const lostInFull = 'The bot is restarting and could not confirm your change was saved in full; it may be lost. Please check once it is back.';
    expect(truthText('held', false)).toBe(lost);
    expect(truthText('pending', false)).toBe(lost);
    expect(truthText('held', true)).toBe(lostInFull);
    expect(truthText('pending', true)).toBe(lostInFull);
    expect(truthText('node-stopping', false)).toBe('The bot is restarting, so your change was not saved. Please try again in a moment.');
    expect(truthText('unavailable', false)).toBe('The bot cannot confirm whether your change was saved. Please check before you try again.');
  });

  it('a gated reply over a held write tells the stopping text', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.mode = 'read-only';
    await emit(rawCommand('s1'), async i => {
      saveData('x.json', options, { v: 1 });
      stop.on = true;
      await i.reply({ content: 'Saved!' });
    });
    expect(wire.map(textOf)).toEqual(['The bot is restarting and could not confirm your change was saved; it may be lost. Please check once it is back.']);
  });
});

describe('the fast path', () => {
  it('sends a reply at once and unchanged when the interaction wrote nothing', async () => {
    const { wire, emit } = rig();
    const { error } = await emit(rawCommand('c1'), async i => {
      await i.reply({ content: 'Pong', flags: EPHEMERAL });
      await i.followUp({ content: 'More' });
    });
    expect(error).toBeUndefined();
    expect(wire.map(c => [c.method, callbackType(c), textOf(c)])).toEqual([
      ['post', InteractionResponseType.ChannelMessageWithSource, 'Pong'],
      ['post', undefined, 'More'],
    ]);
    expect(wire[0].body.data.flags).toBe(EPHEMERAL);
  });

  it('sends at once when every write already landed', async () => {
    const { wire, emit } = rig();
    const { options } = await storeGuild();
    await emit(rawCommand('c2'), async i => {
      saveData('x.json', options, { v: 1 });
      expect(await confirmWrite(ledgerOf(i)!.tickets()[0].ticket, 5000)).toBe('ok');
      await i.reply({ content: 'Saved!' });
    });
    expect(wire.map(textOf)).toEqual(['Saved!']);
  });
});

describe('writes that land before the ack deadline', () => {
  it('sends the payload only after the store committed it', async () => {
    const { wire, control, emit } = rig();
    const { guildId, store, options } = await storeGuild();
    let committedWhenSent: string | undefined;
    control.onSend = () => { committedWhenSent = store.doc(guildId, 'x.json'); };
    await emit(rawCommand('c3'), async i => {
      saveData('x.json', options, { v: 1 });
      await i.reply({ content: 'Saved!' });
    });
    expect(wire.map(textOf)).toEqual(['Saved!']);
    expect(JSON.parse(committedWhenSent!)).toEqual({ v: 1 });
  });
});

describe('writes not confirmed by the ack deadline', () => {
  it('a reply is deferred with its own ephemerality, then edited to the payload once the write lands', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    const done = emit(rawCommand('c4'), async i => {
      saveData('x.json', options, { v: 1 });
      vi.advanceTimersByTime(ACK_MS - 20);
      await i.reply({ content: 'Saved!', flags: EPHEMERAL });
    });
    await tick(80);
    expect(wire.map(c => [c.method, callbackType(c)])).toEqual([['post', InteractionResponseType.DeferredChannelMessageWithSource]]);
    expect(wire[0].body.data.flags).toBe(EPHEMERAL);
    store.release();
    const { error } = await done;
    expect(error).toBeUndefined();
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['patch', 'Saved!']]);
  });

  it('an update is deferred as an update, then the component message is edited', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    const done = emit(rawButton('b1'), async i => {
      saveData('x.json', options, { v: 1 });
      vi.advanceTimersByTime(ACK_MS - 20);
      await i.update({ content: 'Updated' });
    });
    await tick(80);
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredMessageUpdate]);
    store.release();
    await done;
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['patch', 'Updated']]);
  });

  it('a call made after the deadline defers at once', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    const done = emit(rawCommand('c5'), async i => {
      saveData('x.json', options, { v: 1 });
      vi.advanceTimersByTime(ACK_MS + 500);
      await i.reply({ content: 'Saved!' });
    });
    await tick(20);
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredChannelMessageWithSource]);
    store.release();
    await done;
  });

  it('the slow path edits without the reply-only options, keeps V2, and resolves a fetchReply call with the message', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let result: any;
    const done = emit(rawCommand('c29'), async i => {
      saveData('x.json', options, { v: 1 });
      vi.advanceTimersByTime(ACK_MS + 100);
      const view = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Saved!'));
      result = await i.reply({ components: [view], flags: EPHEMERAL | V2, fetchReply: true });
    });
    await tick(20);
    store.release();
    const { error } = await done;
    expect(error).toBeUndefined();
    expect(wire.map(c => c.method)).toEqual(['post', 'patch']);
    expect(wire[0].body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
    expect((wire[1].body.flags ?? 0) & EPHEMERAL).toBe(0);
    expect(wire[1].body.flags & V2).toBe(V2);
    expect(result?.id).toBe('700');
  });

  for (const [name, resource] of [['reply', true], ['update', true], ['reply', false], ['update', false]] as const) {
    it(`the slow path resolves a withResponse ${name} with the message it shows${resource ? '' : ', when Discord sent no resource'}`, async () => {
      vi.useFakeTimers({ toFake: ['performance'] });
      const { client, emit } = rig();
      const rest = client.rest as unknown as { post: (route: string, options?: any) => Promise<unknown> };
      const post = rest.post;
      // Discord's callback response: a deferral's resource carries no message.
      rest.post = async (route, options = {}) => {
        await post(route, options);
        if (!String(options.query ?? '').includes('with_response=true')) return undefined;
        return {
          interaction: { id: '1', type: 3, activity_instance_id: null, response_message_id: '700', response_message_loading: true, response_message_ephemeral: false },
          ...(resource && { resource: { type: options.body.type } }),
        };
      };
      const { store, options } = await storeGuild();
      store.holding = true;
      let result: any;
      const done = emit(rawButton(`c32-${name}-${resource}`), async i => {
        saveData('x.json', options, { v: 1 });
        vi.advanceTimersByTime(ACK_MS + 100);
        result = await i[name]({ content: 'Saved!', withResponse: true });
      });
      await tick(20);
      store.release();
      const { error } = await done;
      expect(error).toBeUndefined();
      expect(result?.resource?.message?.id).toBe('700');
      expect(result?.resource?.type).toBe(name === 'reply' ? InteractionResponseType.DeferredChannelMessageWithSource : InteractionResponseType.DeferredMessageUpdate);
    });
  }

  for (const name of ['reply', 'update'] as const) {
    it(`the slow path gives withResponse precedence over fetchReply on ${name}, as discord.js does`, async () => {
      vi.useFakeTimers({ toFake: ['performance'] });
      const { client, emit } = rig();
      const rest = client.rest as unknown as { post: (route: string, options?: any) => Promise<unknown> };
      const post = rest.post;
      rest.post = async (route, options = {}) => {
        await post(route, options);
        if (!String(options.query ?? '').includes('with_response=true')) return undefined;
        return {
          interaction: { id: '1', type: 3, activity_instance_id: null, response_message_id: '700', response_message_loading: true, response_message_ephemeral: false },
          resource: { type: options.body.type },
        };
      };
      const { store, options } = await storeGuild();
      store.holding = true;
      let result: any;
      const done = emit(rawButton(`c35-${name}`), async i => {
        saveData('x.json', options, { v: 1 });
        vi.advanceTimersByTime(ACK_MS + 100);
        result = await i[name]({ content: 'Saved!', withResponse: true, fetchReply: true });
      });
      await tick(20);
      store.release();
      const { error } = await done;
      expect(error).toBeUndefined();
      expect(result?.resource?.message?.id).toBe('700');
    });
  }

  it('the gate\'s own defer failing rejects the call with its error, and no payload goes out', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, control, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    const { error } = await emit(rawCommand('c27'), async i => {
      saveData('x.json', options, { v: 1 });
      vi.advanceTimersByTime(ACK_MS + 100);
      control.failNext = new Error('Unknown interaction');
      await i.reply({ content: 'Saved!' });
    });
    store.release();
    expect((error as Error).message).toBe('Unknown interaction');
    expect(wire).toEqual([]);
  });

  it('a write still unconfirmed at the confirm deadline gets the pending text', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    const done = emit(rawCommand('c6'), async i => {
      saveData('x.json', options, { v: 1 });
      // A flush already on the wire: confirm polls it in 20 ms steps, reading the faked clock.
      void confirmWrite(ledgerOf(i)!.tickets()[0].ticket, 60_000);
      await tick(5);
      const replied = i.reply({ content: 'Saved!' });
      await tick(30);
      vi.advanceTimersByTime(10_000);
      await replied;
    });
    const { error } = await done;
    expect(error).toBeUndefined();
    expect(wire.map(c => [callbackType(c), textOf(c)])).toEqual([[InteractionResponseType.ChannelMessageWithSource, truthText('pending', false)]]);
    store.release();
  });
});

describe('answers that are not ok', () => {
  it('a refused write: the reply carries the truth at once, ephemeral', async () => {
    const { wire, emit } = rig();
    await emit(rawCommand('c7'), async i => {
      expect(saveDataOutcome('x.json', notReadyGuild(), { v: 1 })).toBe('refused');
      await i.reply({ content: 'Saved!' });
    });
    expect(wire.map(c => [callbackType(c), textOf(c)])).toEqual([[InteractionResponseType.ChannelMessageWithSource, truthText('not-ready', false)]]);
    expect(wire[0].body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
  });

  it('a commit the store refuses: held', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.mode = 'read-only';
    await emit(rawCommand('c8'), async i => {
      saveData('x.json', options, { v: 1 });
      await i.reply({ content: 'Saved!' });
    });
    expect(wire.map(textOf)).toEqual([truthText('held', false)]);
  });

  it('an acknowledged interaction: editReply waits, and a deposed write gets the moved text', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.mode = 'deposed';
    await emit(rawCommand('c9'), async i => {
      await i.deferReply();
      saveData('x.json', options, { v: 1 });
      await i.editReply({ content: 'Saved!', embeds: [] });
    });
    // The public deferral reads back still empty: it is deleted and the truth goes to the member alone.
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['get', undefined], ['delete', undefined], ['post', truthText('deposed', false)]]);
    expect(wire[3].body.flags & EPHEMERAL).toBe(EPHEMERAL);
  });

  it('one write refused and one landed: the "in full" form', async () => {
    const { wire, emit } = rig();
    const { options } = await storeGuild();
    await emit(rawCommand('c10'), async i => {
      saveData('x.json', options, { v: 1 });
      saveDataOutcome('y.json', notReadyGuild(), { v: 1 });
      await i.reply({ content: 'Saved!' });
    });
    expect(wire.map(textOf)).toEqual([truthText('not-ready', true)]);
  });

  it('a V2 component message gets the truth as a V2 text display, with no content', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.mode = 'read-only';
    await emit(rawButton('b2', V2 | EPHEMERAL), async i => {
      saveData('x.json', options, { v: 1 });
      await i.update({ components: [], flags: V2 });
    });
    const data = wire[0].body.data;
    expect(callbackType(wire[0])).toBe(InteractionResponseType.UpdateMessage);
    expect(data.flags & V2).toBe(V2);
    expect(data.content ?? '').toBe('');
    expect(data.components[0].type).toBe(ComponentType.Container);
    expect(textOf(wire[0])).toBe(truthText('held', false));
  });

  it('a plain message edited to the truth has its earlier embeds, components and attachments cleared', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.mode = 'read-only';
    await emit(rawCommand('c11'), async i => {
      await i.deferReply({ flags: EPHEMERAL });
      saveData('x.json', options, { v: 1 });
      await i.editReply({ content: 'Saved!' });
    });
    expect(wire[1].body).toMatchObject({ content: truthText('held', false), embeds: [], components: [], attachments: [] });
  });

  it('a reply that makes a new plain message ends the V2 shape for later truth edits', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.mode = 'read-only';
    await emit(rawButton('b6', V2), async i => {
      await i.reply({ content: 'Working...', flags: EPHEMERAL });
      saveData('x.json', options, { v: 1 });
      await i.editReply({ content: 'Saved!' });
    });
    expect(wire[1].method).toBe('patch');
    expect((wire[1].body.flags ?? 0) & V2).toBe(0);
    expect(wire[1].body.content).toBe(truthText('held', false));
  });

  it('the truth keeps the caller\'s fetchReply: the reply resolves with the message', async () => {
    const { emit } = rig();
    let result: any;
    await emit(rawCommand('c26'), async i => {
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      result = await i.reply({ content: 'Saved!', fetchReply: true });
    });
    expect(result?.id).toBe('700');
  });

  it('a landed entry dropped when the guild\'s set was replaced still gives the "in full" form', async () => {
    const { wire, emit } = rig();
    const { guildId, store, options } = await storeGuild();
    await emit(rawCommand('c31'), async i => {
      saveData('x.json', options, { v: 1 });
      expect(await confirmWrite(ledgerOf(i)!.tickets()[0].ticket, 5000)).toBe('ok');
      const ws = getWorkingSet()!;
      ws.evict(guildId);
      expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
      store.mode = 'read-only';
      saveData('y.json', options, { v: 2 });
      expect(ledgerOf(i)!.tickets()).toHaveLength(1);
      await i.reply({ content: 'Saved!' });
    });
    expect(wire.map(textOf)).toEqual([truthText('held', true)]);
  });

  it('the truth for an update keeps fetchReply too, plain or V2', async () => {
    const { emit } = rig();
    const results: any[] = [];
    for (const [id, flags] of [['b7', 0], ['b8', V2]] as const) {
      await emit(rawButton(id, flags), async i => {
        saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
        results.push(await i.update({ content: flags ? undefined : 'Saved!', components: [], flags: flags || undefined, fetchReply: true }));
      });
    }
    expect(results.map(r => r?.id)).toEqual(['700', '700']);
  });

  it('a write that landed and was then compacted away still gives the "in full" form', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    await emit(rawCommand('c25'), async i => {
      saveData('x.json', options, { v: 1 });
      expect(await confirmWrite(ledgerOf(i)!.tickets()[0].ticket, 5000)).toBe('ok');
      store.mode = 'read-only';
      saveData('y.json', options, { v: 2 });
      await i.reply({ content: 'Saved!' });
    });
    expect(wire.map(textOf)).toEqual([truthText('held', true)]);
  });
});

describe('a component message others can see (BT1C-2)', () => {
  const ephemeralTruth = (call: { body: any }) => (call.body?.flags ?? 0) & EPHEMERAL;

  it('a refused update acknowledges with an update and tells the truth to the member alone, leaving the message', async () => {
    const { wire, emit } = rig();
    await emit(rawButton('p1'), async i => {
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.update({ content: 'Saved view', components: [] });
    });
    expect(wire.map(c => [c.method, callbackType(c), textOf(c)])).toEqual([
      ['post', InteractionResponseType.DeferredMessageUpdate, undefined],
      ['post', undefined, truthText('not-ready', false)],
    ]);
    expect(ephemeralTruth(wire[1])).toBe(EPHEMERAL);
  });

  it('a V2 public message is left as it is too', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.mode = 'read-only';
    await emit(rawButton('p2', V2), async i => {
      saveData('x.json', options, { v: 1 });
      await i.update({ components: [], flags: V2 });
    });
    expect(wire.map(c => [c.method, callbackType(c), textOf(c)])).toEqual([
      ['post', InteractionResponseType.DeferredMessageUpdate, undefined],
      ['post', undefined, truthText('held', false)],
    ]);
    expect(ephemeralTruth(wire[1])).toBe(EPHEMERAL);
  });

  it("after the gate's own deferUpdate, the truth goes as an ephemeral followUp, not an edit of the message", async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let result: any;
    const done = emit(rawButton('p3'), async i => {
      saveData('x.json', options, { v: 1 });
      void confirmWrite(ledgerOf(i)!.tickets()[0].ticket, 60_000);
      vi.advanceTimersByTime(ACK_MS + 100);
      const updated = i.update({ content: 'Saved view', fetchReply: true });
      await tick(30);
      vi.advanceTimersByTime(10_000);
      result = await updated;
    });
    const { error } = await done;
    store.release();
    expect(error).toBeUndefined();
    expect(wire.map(c => [c.method, callbackType(c), textOf(c)])).toEqual([
      ['post', InteractionResponseType.DeferredMessageUpdate, undefined],
      ['post', undefined, truthText('pending', false)],
      ['get', undefined, undefined],
    ]);
    expect(ephemeralTruth(wire[1])).toBe(EPHEMERAL);
    expect(result?.id).toBe('700');
  });

  it("after the module's own deferUpdate, an editReply's truth goes as an ephemeral followUp", async () => {
    const { wire, emit } = rig();
    await emit(rawButton('p4'), async i => {
      await i.deferUpdate();
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Saved view' });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['post', truthText('not-ready', false)], ['get', undefined]]);
    expect(ephemeralTruth(wire[1])).toBe(EPHEMERAL);
  });

  it('the truth told by followUp is told once: a later followUp is dropped and a later edit leaves the message', async () => {
    const { wire, emit } = rig();
    await emit(rawButton('p4b'), async i => {
      await i.deferUpdate();
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Saved view' });
      expect(await i.followUp({ content: 'Also saved' })).toBeUndefined();
      await i.editReply({ content: 'Again' });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([
      ['post', undefined],
      ['post', truthText('not-ready', false)],
      ['get', undefined],
      ['get', undefined],
    ]);
  });

  it("after the gate's own deferUpdate with no message asked for, the update resolves without fetching the message", async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, client, emit } = rig();
    (client.rest as unknown as { get: () => Promise<unknown> }).get = async () => {
      throw new Error('Unknown Message');
    };
    const { store, options } = await storeGuild();
    store.holding = true;
    let result: unknown = 'unset';
    const done = emit(rawButton('p8'), async i => {
      saveData('x.json', options, { v: 1 });
      void confirmWrite(ledgerOf(i)!.tickets()[0].ticket, 60_000);
      vi.advanceTimersByTime(ACK_MS + 100);
      const updated = i.update({ content: 'Saved view' });
      await tick(30);
      vi.advanceTimersByTime(10_000);
      result = await updated;
    });
    const { error } = await done;
    store.release();
    expect(error).toBeUndefined();
    expect(result).toBeInstanceOf(InteractionResponse);
    expect(wire.map(c => [c.method, callbackType(c), textOf(c)])).toEqual([
      ['post', InteractionResponseType.DeferredMessageUpdate, undefined],
      ['post', undefined, truthText('pending', false)],
    ]);
  });

  it('after a deferUpdate on an ephemeral message, the truth still edits it in place', async () => {
    const { wire, emit } = rig();
    await emit(rawButton('p7', EPHEMERAL), async i => {
      await i.deferUpdate();
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Saved view' });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['patch', truthText('not-ready', false)]]);
  });

  it("after the gate's own deferUpdate on an ephemeral message, the truth edits it in place", async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    const done = emit(rawButton('p7b', EPHEMERAL), async i => {
      saveData('x.json', options, { v: 1 });
      void confirmWrite(ledgerOf(i)!.tickets()[0].ticket, 60_000);
      vi.advanceTimersByTime(ACK_MS + 100);
      const updated = i.update({ content: 'Saved view' });
      await tick(30);
      vi.advanceTimersByTime(10_000);
      await updated;
    });
    const { error } = await done;
    store.release();
    expect(error).toBeUndefined();
    expect(wire.map(c => [c.method, callbackType(c), textOf(c)])).toEqual([
      ['post', InteractionResponseType.DeferredMessageUpdate, undefined],
      ['patch', undefined, truthText('pending', false)],
    ]);
  });

  it('a refused update with withResponse resolves with the deferral and the message it left', async () => {
    const { wire, client, emit } = rig();
    const rest = client.rest as unknown as { post: (route: string, options?: any) => Promise<unknown> };
    const post = rest.post;
    rest.post = async (route, options = {}) => {
      const sent = await post(route, options);
      if (!String(options.query ?? '').includes('with_response=true')) return sent;
      return {
        interaction: { id: '1', type: 3, activity_instance_id: null, response_message_id: '700', response_message_loading: true, response_message_ephemeral: false },
        resource: { type: options.body.type },
      };
    };
    let result: any;
    const { error } = await emit(rawButton('p6'), async i => {
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      result = await i.update({ content: 'Saved view', withResponse: true });
    });
    expect(error).toBeUndefined();
    expect(wire.map(c => [c.method, callbackType(c), textOf(c)])).toEqual([
      ['post', InteractionResponseType.DeferredMessageUpdate, undefined],
      ['post', undefined, truthText('not-ready', false)],
      ['get', undefined, undefined],
    ]);
    expect(ephemeralTruth(wire[1])).toBe(EPHEMERAL);
    expect(result?.resource?.message?.id).toBe('700');
    expect(result?.resource?.type).toBe(InteractionResponseType.DeferredMessageUpdate);
  });

  it("a module's public reply is left as it is: a refused editReply's truth goes as an ephemeral followUp", async () => {
    const { wire, emit } = rig();
    const row = { type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: 1, label: 'Vote', custom_id: 'vote' }] };
    let result: any;
    await emit(rawCommand('p9'), async i => {
      await i.reply({ content: 'Poll', components: [row] });
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      result = await i.editReply({ content: 'Poll (1 vote)', components: [row] });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', 'Poll'], ['post', truthText('not-ready', false)], ['get', undefined]]);
    expect(ephemeralTruth(wire[1])).toBe(EPHEMERAL);
    expect(result?.id).toBe('700');
  });

  it("a module's public reply on a button is left as it is too, whatever the component message's ephemerality", async () => {
    const { wire, emit } = rig();
    await emit(rawButton('p10', EPHEMERAL), async i => {
      await i.reply({ content: 'Poll' });
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Poll (1 vote)' });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', 'Poll'], ['post', truthText('not-ready', false)], ['get', undefined]]);
    expect(ephemeralTruth(wire[1])).toBe(EPHEMERAL);
  });

  it("a module's public reply sent through the gate's deferral is left as it is by a later refused edit", async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    const done = emit(rawCommand('p12'), async i => {
      saveData('x.json', options, { v: 1 });
      vi.advanceTimersByTime(ACK_MS - 20);
      await i.reply({ content: 'Poll' });
      saveDataOutcome('y.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Poll (1 vote)' });
    });
    await tick(80);
    store.release();
    const { error } = await done;
    expect(error).toBeUndefined();
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([
      ['post', undefined],
      ['patch', 'Poll'],
      ['post', truthText('not-ready', true)],
      ['get', undefined],
    ]);
    expect(ephemeralTruth(wire[2])).toBe(EPHEMERAL);
  });

  it("a module's ephemeral reply on a public component message still takes the truth in place", async () => {
    const { wire, emit } = rig();
    await emit(rawButton('p11'), async i => {
      await i.reply({ content: 'Working...', flags: EPHEMERAL });
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Saved!' });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', 'Working...'], ['patch', truthText('not-ready', false)]]);
  });

  // A followUp's message gets id 701, so a result can be told from @original (700).
  const followUpsAs701 = (client: any) => {
    const rest = client.rest as { post: (route: string, options?: any) => Promise<unknown> };
    const post = rest.post;
    rest.post = async (route, options = {}) => {
      const sent = await post(route, options);
      return route.includes('/callback') ? sent : { ...(sent as object), id: '701' };
    };
  };

  it("a module's deferral filled by an ok edit keeps its content and buttons: a refused edit's truth goes as an ephemeral followUp (BT1-R4-1)", async () => {
    const { wire, emit } = rig();
    const row = { type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: 1, label: 'Vote', custom_id: 'vote' }] };
    let result: any;
    await emit(rawCommand('p13'), async i => {
      await i.deferReply();
      await i.editReply({ content: 'Poll', components: [row] });
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      result = await i.editReply({ content: 'Poll (1 vote)', components: [row] });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['patch', 'Poll'], ['post', truthText('not-ready', false)], ['get', undefined]]);
    expect(ephemeralTruth(wire[2])).toBe(EPHEMERAL);
    expect(result?.id).toBe('700');
  });

  it("a module's ephemeral deferral filled by an ok edit still takes the truth in place", async () => {
    const { wire, emit } = rig();
    await emit(rawCommand('p13b'), async i => {
      await i.deferReply({ flags: EPHEMERAL });
      await i.editReply({ content: 'Poll' });
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Poll (1 vote)' });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['patch', 'Poll'], ['patch', truthText('not-ready', false)]]);
  });

  it("a module's reply made ephemeral by the ephemeral option takes the truth in place (BT1-R4-2)", async () => {
    const { wire, emit } = rig();
    await emit(rawButton('p11b'), async i => {
      await i.reply({ content: 'Working...', ephemeral: true });
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Saved!' });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', 'Working...'], ['patch', truthText('not-ready', false)]]);
  });

  it("the gate's own deferral of a reply made ephemeral by the ephemeral option takes the truth in place", async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    const done = emit(rawCommand('p11c'), async i => {
      saveData('x.json', options, { v: 1 });
      void confirmWrite(ledgerOf(i)!.tickets()[0].ticket, 60_000);
      vi.advanceTimersByTime(ACK_MS + 100);
      const replied = i.reply({ content: 'Saved!', ephemeral: true });
      await tick(30);
      vi.advanceTimersByTime(10_000);
      await replied;
    });
    const { error } = await done;
    store.release();
    expect(error).toBeUndefined();
    expect(wire.map(c => [c.method, callbackType(c), textOf(c)])).toEqual([
      ['post', InteractionResponseType.DeferredChannelMessageWithSource, undefined],
      ['patch', undefined, truthText('pending', false)],
    ]);
    expect(wire[0].body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
  });

  it("the gate's own public deferral with a verdict not ok is deleted and the truth goes as an ephemeral followUp (BT1-R4-3)", async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, client, emit } = rig();
    followUpsAs701(client);
    const { store, options } = await storeGuild();
    store.holding = true;
    let result: any;
    const done = emit(rawCommand('p14'), async i => {
      saveData('x.json', options, { v: 1 });
      void confirmWrite(ledgerOf(i)!.tickets()[0].ticket, 60_000);
      vi.advanceTimersByTime(ACK_MS + 100);
      const replied = i.reply({ content: 'Poll', fetchReply: true });
      await tick(30);
      vi.advanceTimersByTime(10_000);
      result = await replied;
    });
    const { error } = await done;
    store.release();
    expect(error).toBeUndefined();
    expect(wire.map(c => [c.method, callbackType(c), textOf(c)])).toEqual([
      ['post', InteractionResponseType.DeferredChannelMessageWithSource, undefined],
      ['get', undefined, undefined],
      ['delete', undefined, undefined],
      ['post', undefined, truthText('pending', false)],
    ]);
    expect((wire[0].body.data?.flags ?? 0) & EPHEMERAL).toBe(0);
    expect(wire[1].route).toContain('/messages/%40original');
    expect(wire[2].route).toContain('/messages/%40original');
    expect(ephemeralTruth(wire[3])).toBe(EPHEMERAL);
    expect(result?.id).toBe('701');
  });

  it("a module's empty public deferral refused is deleted, and the truth's followUp then stands as the reply", async () => {
    const { wire, client, emit } = rig();
    followUpsAs701(client);
    let first: any;
    await emit(rawCommand('p15'), async i => {
      await i.deferReply();
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      first = await i.editReply({ content: 'Saved!' });
      await i.editReply({ content: 'Saved again!' });
      await i.deleteReply();
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([
      ['post', undefined],
      ['get', undefined],
      ['delete', undefined],
      ['post', truthText('not-ready', false)],
      ['get', undefined],
    ]);
    expect(wire[2].route).toContain('/messages/%40original');
    expect(ephemeralTruth(wire[3])).toBe(EPHEMERAL);
    expect(wire[4].route).toContain('/messages/701');
    expect(first?.id).toBe('701');
  });

  it('a truth whose followUp failed after the deferral was deleted is told on the next call, which then stands as the reply', async () => {
    const { wire, client, control, emit } = rig();
    followUpsAs701(client);
    let failed = false;
    control.onSend = call => {
      if (call.method === 'post' && !call.route.includes('/callback') && !failed) {
        failed = true;
        throw new Error('Discord 500');
      }
    };
    let result: any;
    await emit(rawCommand('p15b'), async i => {
      await i.deferReply();
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Saved!' }).catch(() => undefined);
      result = await i.editReply({ content: 'Saved!' });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['get', undefined], ['delete', undefined], ['post', truthText('not-ready', false)]]);
    expect(result?.id).toBe('701');
  });

  it("a module's refused followUp after its own empty public deferral deletes the deferral first", async () => {
    const { wire, emit } = rig();
    await emit(rawCommand('p16'), async i => {
      await i.deferReply();
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.followUp({ content: 'Saved!' });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['get', undefined], ['delete', undefined], ['post', truthText('not-ready', false)]]);
    expect(ephemeralTruth(wire[3])).toBe(EPHEMERAL);
  });

  it("a module's followUp that filled its public deferral reads back filled: a refused edit leaves it", async () => {
    const { wire, emit } = rig();
    await emit(rawCommand('p17'), async i => {
      await i.deferReply();
      await i.followUp({ content: 'Poll' });
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Poll (1 vote)' });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([
      ['post', undefined],
      ['post', 'Poll'],
      ['get', undefined],
      ['post', truthText('not-ready', false)],
      ['get', undefined],
    ]);
    expect(ephemeralTruth(wire[3])).toBe(EPHEMERAL);
  });

  const row = { type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: 1, label: 'Vote', custom_id: 'vote' }] };
  const truthPosted = (wire: WireCall[], text: string) => wire.find(c => c.method === 'post' && !c.route.includes('/callback') && textOf(c) === text);

  it('RK-1: a deferral filled by an edit that names it by its message is filled: a refused edit deletes nothing', async () => {
    const { wire, emit } = rig();
    await emit(rawCommand('p18'), async i => {
      const r = await i.deferReply({ fetchReply: true });
      await i.editReply({ message: r, content: 'Poll', components: [row] });
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Poll (1 vote)', components: [row] });
    });
    expect(wire.some(c => c.method === 'delete')).toBe(false);
    expect(ephemeralTruth(truthPosted(wire, truthText('not-ready', false))!)).toBe(EPHEMERAL);
  });

  it('RK-1: a deferral filled around the gate is read back as filled before any delete, and left', async () => {
    const { wire, emit } = rig();
    await emit(rawCommand('p18b'), async i => {
      await i.deferReply();
      await i.webhook.editMessage('@original', { content: 'Poll', components: [row] });
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Poll (1 vote)', components: [row] });
    });
    expect(wire.some(c => c.method === 'delete')).toBe(false);
    expect(ephemeralTruth(truthPosted(wire, truthText('not-ready', false))!)).toBe(EPHEMERAL);
  });

  it('RK-1: a gated edit that landed and then threw on the client leaves the filled deferral in place', async () => {
    const { wire, client, emit } = rig();
    const rest = client.rest as unknown as { patch: (route: string, options?: any) => Promise<unknown> };
    const patch = rest.patch;
    let thrown = false;
    rest.patch = async (route, options = {}) => {
      const sent = await patch(route, options);
      if (!thrown) {
        thrown = true;
        throw new Error('socket hang up');
      }
      return sent;
    };
    await emit(rawCommand('p18c'), async i => {
      await i.deferReply();
      await i.editReply({ content: 'Poll', components: [row] }).catch(() => undefined);
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Poll (1 vote)', components: [row] });
    });
    expect(wire.some(c => c.method === 'delete')).toBe(false);
    expect(ephemeralTruth(truthPosted(wire, truthText('not-ready', false))!)).toBe(EPHEMERAL);
  });

  it('RK-1: a deferral the module deleted by its message is not deleted again, and the truth is told', async () => {
    const { wire, emit } = rig();
    const { error } = await emit(rawCommand('p18d'), async i => {
      const r = await i.deferReply({ fetchReply: true });
      await i.deleteReply(r);
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.followUp({ content: 'Saved!' });
    });
    expect(error).toBeUndefined();
    expect(wire.filter(c => c.method === 'delete')).toHaveLength(1);
    expect(ephemeralTruth(truthPosted(wire, truthText('not-ready', false))!)).toBe(EPHEMERAL);
  });

  it('RK-3: after the gate deleted the deferral, fetchReply and InteractionResponse.fetch read the stand-in', async () => {
    const { wire, client, emit } = rig();
    followUpsAs701(client);
    const { error } = await emit(rawCommand('p19'), async i => {
      const response = await i.deferReply();
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Saved!' });
      await i.fetchReply();
      await response.fetch();
    });
    expect(error).toBeUndefined();
    expect(wire.at(-2)!.route).toContain('/messages/701');
    expect(wire.at(-1)!.route).toContain('/messages/701');
  });

  it('RK-3: a call that names the deleted deferral by its message goes to the stand-in', async () => {
    const { wire, client, emit } = rig();
    followUpsAs701(client);
    const { error } = await emit(rawCommand('p19b'), async i => {
      const r = await i.deferReply({ fetchReply: true });
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Saved!' });
      await i.editReply({ message: r, content: 'Saved again!' });
    });
    expect(error).toBeUndefined();
    expect(wire.at(-1)!.route).toContain('/messages/701');
  });

  it('RK-4: a deferral already gone at Discord counts as deleted: the truth still goes to the member', async () => {
    const { wire, emit } = rig();
    const { error } = await emit(rawCommand('p20'), async i => {
      await i.deferReply();
      await i.webhook.deleteMessage('@original');
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.followUp({ content: 'Saved!' });
    });
    expect(error).toBeUndefined();
    expect(wire.filter(c => c.method === 'delete')).toHaveLength(1);
    expect(ephemeralTruth(truthPosted(wire, truthText('not-ready', false))!)).toBe(EPHEMERAL);
  });

  it('RK-4: a delete answered Unknown Message counts as done: the truth still goes to the member', async () => {
    const { wire, control, emit } = rig();
    control.onSend = call => {
      if (call.method === 'delete') throw unknownMessage('delete', call.route);
    };
    const { error } = await emit(rawCommand('p20b'), async i => {
      await i.deferReply();
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Saved!' });
    });
    expect(error).toBeUndefined();
    expect(ephemeralTruth(truthPosted(wire, truthText('not-ready', false))!)).toBe(EPHEMERAL);
  });

  it("RK-2: a truth's followUp answered Unknown Message after the deferral was deleted is logged and not retried", async () => {
    const { wire, control, emit } = rig();
    let followUps = 0;
    control.onSend = call => {
      if (call.method === 'post' && !call.route.includes('/callback')) {
        followUps += 1;
        throw unknownMessage('post', call.route);
      }
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let first: unknown;
    await emit(rawCommand('p20c'), async i => {
      await i.deferReply();
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      first = await i.editReply({ content: 'Saved!' }).then(() => 'resolved', (error: { code?: number }) => error.code);
      await i.editReply({ content: 'Saved again!' }).catch(() => undefined);
    });
    const logged = warn.mock.calls.some(([line]) => String(line).startsWith("[Truth] Discord refused the truth's followUp"));
    warn.mockRestore();
    expect(first).toBe(10008);
    expect(logged).toBe(true);
    expect(wire.filter(c => c.method === 'delete')).toHaveLength(1);
    expect(followUps).toBe(1);
  });

  it('RK-5(a): an empty ephemeral deferral is never deleted: a refused followUp goes as a followUp', async () => {
    const { wire, emit } = rig();
    await emit(rawCommand('p21'), async i => {
      await i.deferReply({ flags: EPHEMERAL });
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.followUp({ content: 'Saved!' });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['post', truthText('not-ready', false)]]);
    expect(ephemeralTruth(wire[1])).toBe(EPHEMERAL);
  });

  it("RK-5(b): answerWrites after a module's empty public deferral deletes it and tells the truth ephemeral", async () => {
    const { wire, emit } = rig();
    let answered: unknown;
    await emit(rawCommand('p22'), async i => {
      await i.deferReply();
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      answered = await answerWrites(i);
    });
    expect(answered).toBe(false);
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['get', undefined], ['delete', undefined], ['post', truthText('not-ready', false)]]);
    expect(ephemeralTruth(wire[3])).toBe(EPHEMERAL);
  });

  it("RK-5: answerWrites after the gate's own ephemeral acknowledgement tells the truth by followUp and deletes nothing", async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let answered: unknown;
    const done = emit(rawCommand('p22b'), async i => {
      saveData('x.json', options, { v: 1 });
      void confirmWrite(ledgerOf(i)!.tickets()[0].ticket, 60_000);
      vi.advanceTimersByTime(ACK_MS + 100);
      const answering = answerWrites(i);
      await tick(30);
      vi.advanceTimersByTime(10_000);
      answered = await answering;
    });
    const { error } = await done;
    store.release();
    expect(error).toBeUndefined();
    expect(answered).toBe(false);
    expect(wire.map(c => [c.method, callbackType(c), textOf(c)])).toEqual([
      ['post', InteractionResponseType.DeferredChannelMessageWithSource, undefined],
      ['post', undefined, truthText('pending', false)],
    ]);
    expect(wire[0].body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
    expect(ephemeralTruth(wire[1])).toBe(EPHEMERAL);
  });

  it('RK-5(c): a newly failed write after the stand-in took the truth edits the stand-in in place', async () => {
    const { wire, client, emit } = rig();
    followUpsAs701(client);
    await emit(rawCommand('p23'), async i => {
      await i.deferReply();
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Saved!' });
      saveDataOutcome('y.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Saved again!' });
    });
    expect(wire.at(-1)!.method).toBe('patch');
    expect(wire.at(-1)!.route).toContain('/messages/701');
    expect(textOf(wire.at(-1)!)).toBe(truthText('not-ready', false));
  });

  it("RK-5(d): a module's ok update of a public component message, then a refused edit: the message is left", async () => {
    const { wire, emit } = rig();
    await emit(rawButton('p24'), async i => {
      await i.update({ content: 'Poll', components: [row] });
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Poll (1 vote)', components: [row] });
    });
    expect(wire.filter(c => c.method === 'patch' || c.method === 'delete')).toEqual([]);
    expect(ephemeralTruth(truthPosted(wire, truthText('not-ready', false))!)).toBe(EPHEMERAL);
  });

  it('RK2-1: an empty public deferral read back without the Loading flag is still deleted before the truth', async () => {
    const { wire, control, emit } = rig();
    control.readBack.loadingFlag = false;
    await emit(rawCommand('q1'), async i => {
      await i.deferReply();
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Saved!' });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['get', undefined], ['delete', undefined], ['post', truthText('not-ready', false)]]);
    expect(wire[2].route).toContain('/messages/%40original');
    expect(ephemeralTruth(wire[3])).toBe(EPHEMERAL);
  });

  const fills: Array<[string, (i: any) => Promise<unknown>]> = [
    ['content', i => i.editReply({ content: 'Poll' })],
    ['an embed', i => i.editReply({ embeds: [{ description: 'Poll' }] })],
    ['components', i => i.editReply({ components: [row] })],
    ['an attachment', i => i.editReply({ files: [{ attachment: Buffer.from('x'), name: 'a.txt' }] })],
    ['a poll', i => i.followUp({ poll: { question: { text: 'Q' }, answers: [{ text: 'A' }, { text: 'B' }], duration: 1, allowMultiselect: false } })],
  ];
  it.each(fills)('RK2-5: a public deferral filled with %s alone is left, even while Discord still reads it back as loading', async (_fill, fill) => {
    const { wire, control, emit } = rig();
    control.readBack.loadingAfterFill = true;
    const { error } = await emit(rawCommand(`q2-${_fill.length}`), async i => {
      await i.deferReply();
      await fill(i);
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Poll (1 vote)', components: [row] });
    });
    expect(error).toBeUndefined();
    expect(wire.some(c => c.method === 'delete')).toBe(false);
    expect(ephemeralTruth(truthPosted(wire, truthText('not-ready', false))!)).toBe(EPHEMERAL);
  });

  for (const [how, by] of [['the Message the gate handed back', (m: any) => m], ['its id', (m: any) => m.id]] as const) {
    it(`RK2-2: a delete of the stand-in by ${how} does nothing more, and a later truth reaches the member`, async () => {
      const { wire, client, emit } = rig();
      followUpsAs701(client);
      const { error } = await emit(rawCommand(`q3${how.length}`), async i => {
        await i.deferReply();
        saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
        const first = await i.editReply({ content: 'Saved!' });
        expect(first?.id).toBe('701');
        await i.deleteReply(by(first));
        saveDataOutcome('y.json', notReadyGuild(), { v: 1 });
        await i.editReply({ content: 'Again' });
      });
      expect(error).toBeUndefined();
      expect(wire.filter(c => c.method === 'delete').map(c => c.route)).toEqual([expect.stringContaining('/messages/%40original')]);
      expect(wire.at(-1)!.method).toBe('patch');
      expect(wire.at(-1)!.route).toContain('/messages/701');
      expect(textOf(wire.at(-1)!)).toBe(truthText('not-ready', false));
    });
  }

  it('RK2-2: a stand-in the member dismissed answers Unknown Message: a later truth goes by a new ephemeral followUp', async () => {
    const { wire, client, control, emit } = rig();
    followUpsAs701(client);
    let result: any;
    const { error } = await emit(rawCommand('q4'), async i => {
      await i.deferReply();
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'Saved!' });
      control.onSend = call => {
        if (call.route.includes('/messages/701')) throw unknownMessage(call.method, call.route);
      };
      saveDataOutcome('y.json', notReadyGuild(), { v: 1 });
      result = await i.editReply({ content: 'Again' });
    });
    expect(error).toBeUndefined();
    const truths = wire.filter(c => c.method === 'post' && !c.route.includes('/callback') && textOf(c) === truthText('not-ready', false));
    expect(truths).toHaveLength(2);
    expect(truths.map(ephemeralTruth)).toEqual([EPHEMERAL, EPHEMERAL]);
    expect(result?.id).toBe('701');
  });

  it("RK2-2: a module's ephemeral reply the member dismissed: the truth goes by an ephemeral followUp", async () => {
    const { wire, client, control, emit } = rig();
    followUpsAs701(client);
    let result: any;
    const { error } = await emit(rawCommand('q5'), async i => {
      await i.reply({ content: 'Working...', flags: EPHEMERAL });
      control.onSend = call => {
        if (call.method === 'patch' && call.route.endsWith('/messages/%40original')) throw unknownMessage(call.method, call.route);
      };
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      result = await i.editReply({ content: 'Saved!' });
    });
    expect(error).toBeUndefined();
    expect(ephemeralTruth(truthPosted(wire, truthText('not-ready', false))!)).toBe(EPHEMERAL);
    expect(result?.id).toBe('701');
  });

  it('RK2-3: a refused edit naming a public followUp, while the original is ephemeral, leaves that followUp', async () => {
    const { wire, client, emit } = rig();
    followUpsAs701(client);
    const { error } = await emit(rawCommand('q6'), async i => {
      await i.deferReply({ flags: EPHEMERAL });
      await i.editReply({ content: 'M' });
      const pub = await i.followUp({ content: 'Poll', components: [row] });
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ message: pub, content: 'P', components: [row] });
    });
    expect(error).toBeUndefined();
    expect(wire.filter(c => c.method === 'patch' && c.route.includes('/messages/701'))).toEqual([]);
    expect(ephemeralTruth(truthPosted(wire, truthText('not-ready', false))!)).toBe(EPHEMERAL);
  });

  it('RK2-3: a refused edit naming the ephemeral original by its id takes the truth in place', async () => {
    const { wire, client, emit } = rig();
    followUpsAs701(client);
    const { error } = await emit(rawCommand('q7'), async i => {
      await i.deferReply({ flags: EPHEMERAL });
      const m = await i.editReply({ content: 'M' });
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ message: m.id, content: 'P' });
    });
    expect(error).toBeUndefined();
    expect(wire.at(-1)!.method).toBe('patch');
    expect(wire.at(-1)!.route).toContain('/messages/700');
    expect(textOf(wire.at(-1)!)).toBe(truthText('not-ready', false));
  });

  it('RK2-4: a reply whose payload asked ephemeral but went out public takes no truth in place', async () => {
    const { wire, emit } = rig();
    const { error } = await emit(rawCommand('q8'), async i => {
      await i.reply(new MessagePayload({ client: i.client } as never, { content: 'Poll', components: [row], ephemeral: true }));
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.editReply({ content: 'P', components: [row] });
    });
    expect(error).toBeUndefined();
    expect((wire[0].body.data.flags ?? 0) & EPHEMERAL).toBe(0);
    expect(wire.filter(c => c.method === 'patch')).toEqual([]);
    expect(ephemeralTruth(truthPosted(wire, truthText('not-ready', false))!)).toBe(EPHEMERAL);
  });

  it("the gate's own public deferral deleted for a withResponse reply names the stand-in as the response's message", async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { client, emit } = rig();
    const rest = client.rest as unknown as { post: (route: string, options?: any) => Promise<unknown> };
    const post = rest.post;
    rest.post = async (route, options = {}) => {
      const sent = await post(route, options);
      if (!route.includes('/callback')) return { ...(sent as object), id: '701' };
      if (!String(options.query ?? '').includes('with_response=true')) return sent;
      return {
        interaction: { id: '1', type: 2, activity_instance_id: null, response_message_id: '700', response_message_loading: true, response_message_ephemeral: false },
        resource: { type: options.body.type, message: { ...fakeMessage, flags: 1 << 7 } },
      };
    };
    const { store, options } = await storeGuild();
    store.holding = true;
    let result: any;
    const done = emit(rawCommand('p14b'), async i => {
      saveData('x.json', options, { v: 1 });
      void confirmWrite(ledgerOf(i)!.tickets()[0].ticket, 60_000);
      vi.advanceTimersByTime(ACK_MS + 100);
      const replied = i.reply({ content: 'Poll', withResponse: true });
      await tick(30);
      vi.advanceTimersByTime(10_000);
      result = await replied;
    });
    const { error } = await done;
    store.release();
    expect(error).toBeUndefined();
    expect(result?.resource?.message?.id).toBe('701');
    expect(result?.interaction?.responseMessageId).toBe('701');
    expect(result?.interaction?.responseMessageEphemeral).toBe(true);
  });

  it('an ephemeral component message still takes the truth in place', async () => {
    const { wire, emit } = rig();
    await emit(rawButton('p5', EPHEMERAL), async i => {
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.update({ content: 'Saved view' });
    });
    expect(wire.map(c => [callbackType(c), textOf(c)])).toEqual([[InteractionResponseType.UpdateMessage, truthText('not-ready', false)]]);
  });
});

// RK-5: the rule over every original a module can make and every refused call. The truth goes into a message in place
// only when the member alone is known to see it; otherwise it carries the Ephemeral flag, no message others see is
// edited, and exactly one delete happens, for an empty public deferral. The gate's own deferrals are the slow-path
// rows above (p3, p7b, p11c, p14, p14b, RK-5's answerWrites row).
describe('where the truth goes, over every original and refused call', () => {
  const row = { type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: 1, label: 'Vote', custom_id: 'vote' }] };
  interface Maker {
    on: 'command' | 'public button' | 'ephemeral button';
    ephemeral: boolean;
    empty: boolean;
    make: (i: any) => Promise<unknown>;
  }
  const makers: Record<string, Maker> = {
    'nothing yet': { on: 'command', ephemeral: false, empty: false, make: async () => undefined },
    'nothing yet on a public message': { on: 'public button', ephemeral: false, empty: false, make: async () => undefined },
    'nothing yet on an ephemeral message': { on: 'ephemeral button', ephemeral: true, empty: false, make: async () => undefined },
    'a public reply': { on: 'command', ephemeral: false, empty: false, make: i => i.reply({ content: 'M', components: [row] }) },
    'an ephemeral reply': { on: 'command', ephemeral: true, empty: false, make: i => i.reply({ content: 'M', flags: EPHEMERAL }) },
    'a reply made ephemeral by the option': { on: 'command', ephemeral: true, empty: false, make: i => i.reply({ content: 'M', ephemeral: true }) },
    'a public reply on an ephemeral message': { on: 'ephemeral button', ephemeral: false, empty: false, make: i => i.reply({ content: 'M' }) },
    'an empty public deferral': { on: 'command', ephemeral: false, empty: true, make: i => i.deferReply() },
    'an empty ephemeral deferral': { on: 'command', ephemeral: true, empty: false, make: i => i.deferReply({ flags: EPHEMERAL }) },
    'a public deferral filled by an edit': {
      on: 'command', ephemeral: false, empty: false, make: async i => {
        await i.deferReply();
        await i.editReply({ content: 'M', components: [row] });
      },
    },
    'a public deferral filled by a followUp': {
      on: 'command', ephemeral: false, empty: false, make: async i => {
        await i.deferReply();
        await i.followUp({ content: 'M' });
      },
    },
    'an ephemeral deferral filled by an edit': {
      on: 'command', ephemeral: true, empty: false, make: async i => {
        await i.deferReply({ flags: EPHEMERAL });
        await i.editReply({ content: 'M' });
      },
    },
    'an update of a public message': { on: 'public button', ephemeral: false, empty: false, make: i => i.update({ content: 'M', components: [row] }) },
    'an update of an ephemeral message': { on: 'ephemeral button', ephemeral: true, empty: false, make: i => i.update({ content: 'M' }) },
    'a deferUpdate of a public message': { on: 'public button', ephemeral: false, empty: false, make: i => i.deferUpdate() },
    'a deferUpdate of an ephemeral message': { on: 'ephemeral button', ephemeral: true, empty: false, make: i => i.deferUpdate() },
  };
  const first = ['nothing yet', 'nothing yet on a public message', 'nothing yet on an ephemeral message'];
  const cells = Object.keys(makers).flatMap(maker => (first.includes(maker)
    ? (makers[maker].on === 'command' ? ['reply', 'answerWrites'] : ['reply', 'update', 'answerWrites'])
    : ['editReply', 'followUp', 'answerWrites']).map(call => [maker, call] as const));
  const refused: Record<string, (i: any) => Promise<unknown>> = {
    reply: (i: any) => i.reply({ content: 'P', components: [row] }),
    update: (i: any) => i.update({ content: 'P', components: [row] }),
    editReply: (i: any) => i.editReply({ content: 'P', components: [row] }),
    followUp: (i: any) => i.followUp({ content: 'P' }),
    answerWrites: (i: any) => answerWrites(i),
  };
  const flagsOfCall = (c: WireCall) => (c.route.includes('/callback') ? c.body?.data?.flags : c.body?.flags) ?? 0;
  let cell = 0;

  it.each(cells)('%s, then a refused %s', async (maker, call) => {
    const { wire, emit } = rig();
    const { on, ephemeral, empty, make } = makers[maker];
    const id = `t${++cell}`;
    const raw = on === 'command' ? rawCommand(id) : rawButton(id, on === 'ephemeral button' ? EPHEMERAL : 0);
    let before = 0;
    const { error } = await emit(raw, async i => {
      await make(i);
      before = wire.length;
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await refused[call](i);
    });
    expect(error).toBeUndefined();
    const after = wire.slice(before);
    const truth = after.filter(c => textOf(c) === truthText('not-ready', false));
    expect(truth).toHaveLength(1);
    const inPlace = truth[0].method === 'patch' || callbackType(truth[0]) === InteractionResponseType.UpdateMessage;
    if (inPlace) expect(ephemeral).toBe(true);
    else expect(flagsOfCall(truth[0]) & EPHEMERAL).toBe(EPHEMERAL);
    if (!ephemeral) expect(after.filter(c => c.method === 'patch' || callbackType(c) === InteractionResponseType.UpdateMessage)).toEqual([]);
    expect(after.filter(c => c.method === 'delete')).toHaveLength(empty ? 1 : 0);
    expect(after.some(c => textOf(c) === 'P')).toBe(false);
  });
});

describe('the truth told once', () => {
  it('a later edit leaves the target unchanged and a later followUp is dropped; a newly failed write is told again', async () => {
    const { wire, emit } = rig();
    await emit(rawButton('b3'), async i => {
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.deferUpdate();
      await i.followUp({ content: 'Saved!', flags: EPHEMERAL });
      await i.editReply({ content: 'Saved view' });
      expect(await i.followUp({ content: 'Also saved' })).toBeUndefined();
      saveDataOutcome('z.json', notReadyGuild(), { v: 1 });
      await i.followUp({ content: 'Saved again!' });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([
      ['post', undefined],
      ['post', truthText('not-ready', false)],
      ['get', undefined],
      ['post', truthText('not-ready', false)],
    ]);
  });

  it('a truth whose send failed is told on the next call', async () => {
    const { wire, control, emit } = rig();
    await emit(rawCommand('c28'), async i => {
      await i.deferReply();
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      control.failNext = new Error('Discord 500');
      await i.editReply({ content: 'Saved!' }).catch(() => undefined);
      await i.editReply({ content: 'Saved!' });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['get', undefined], ['delete', undefined], ['post', truthText('not-ready', false)]]);
  });
});

describe('a refusal and a later write of the same document', () => {
  it('a later accepted save of the document makes its refusal unconfirmable', async () => {
    const { wire, emit } = rig();
    const { guildId, options } = await storeGuild();
    await emit(rawCommand('c12'), async i => {
      freezeGuildWrites(guildId);
      expect(saveDataOutcome('x.json', options, { v: 1 })).toBe('frozen');
      unfreezeGuildWrites(guildId);
      expect(saveDataOutcome('x.json', options, { v: 2 })).toBe('saved');
      await i.reply({ content: 'Saved!' });
    });
    expect(wire.map(textOf)).toEqual([truthText('unavailable', true)]);
  });

  it('a later accepted append does not', async () => {
    const { wire, emit } = rig();
    const { guildId, options } = await storeGuild();
    await emit(rawCommand('c13'), async i => {
      freezeGuildWrites(guildId);
      appendData('log.jsonl', options, 'a\n');
      unfreezeGuildWrites(guildId);
      appendData('log.jsonl', options, 'b\n');
      await i.reply({ content: 'Logged!' });
    });
    expect(wire.map(textOf)).toEqual([truthText('frozen', true)]);
  });
});

describe('a refusal made unconfirmable', () => {
  it('by a later accepted delete of the document', async () => {
    const { wire, emit } = rig();
    const { guildId, options } = await storeGuild();
    await emit(rawCommand('c22'), async i => {
      expect(saveDataOutcome('x.json', options, { v: 1 })).toBe('saved');
      freezeGuildWrites(guildId);
      expect(saveDataOutcome('x.json', options, { v: 2 })).toBe('frozen');
      unfreezeGuildWrites(guildId);
      expect(deleteDataOutcome('x.json', options)).toBe('deleted');
      await i.reply({ content: 'Deleted!' });
    });
    expect(wire.map(textOf)).toEqual([truthText('unavailable', true)]);
  });

  it('by a rewrite recorded in the other ledger of the union', async () => {
    const { wire, emit } = rig();
    const { guildId, options } = await storeGuild();
    await emit(rawCommand('c23'), async i => {
      freezeGuildWrites(guildId);
      expect(saveDataOutcome('x.json', options, { v: 1 })).toBe('frozen');
      unfreezeGuildWrites(guildId);
      await runInLedger(openLedger('interaction'), 'modB', async () => {
        expect(saveDataOutcome('x.json', options, { v: 2 })).toBe('saved');
        await i.reply({ content: 'Saved!' });
      });
    });
    expect(wire.map(textOf)).toEqual([truthText('unavailable', true)]);
  });

  it('a refusal already told is told again once a rewrite makes it unconfirmable', async () => {
    const { wire, emit } = rig();
    const { guildId, options } = await storeGuild();
    await emit(rawCommand('c24'), async i => {
      freezeGuildWrites(guildId);
      saveDataOutcome('x.json', options, { v: 1 });
      unfreezeGuildWrites(guildId);
      await i.reply({ content: 'Saved!' });
      saveDataOutcome('x.json', options, { v: 2 });
      await i.editReply({ content: 'Saved!' });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', truthText('frozen', false)], ['patch', truthText('unavailable', true)]]);
  });

  it('a refusal recorded again after the rewrite names its cause', async () => {
    const { wire, emit } = rig();
    const { guildId, options } = await storeGuild();
    await emit(rawCommand('c30'), async i => {
      freezeGuildWrites(guildId);
      saveDataOutcome('x.json', options, { v: 1 });
      unfreezeGuildWrites(guildId);
      saveDataOutcome('x.json', options, { v: 2 });
      freezeGuildWrites(guildId);
      saveDataOutcome('x.json', options, { v: 3 });
      unfreezeGuildWrites(guildId);
      await i.reply({ content: 'Saved!' });
    });
    expect(wire.map(textOf)).toEqual([truthText('frozen', true)]);
  });

  it('a refusal recorded again after a told conversion is told by its cause', async () => {
    const { wire, emit } = rig();
    const { guildId, options } = await storeGuild();
    await emit(rawCommand('c33'), async i => {
      freezeGuildWrites(guildId);
      saveDataOutcome('x.json', options, { v: 1 });
      unfreezeGuildWrites(guildId);
      await i.reply({ content: 'Saved!' });
      saveDataOutcome('x.json', options, { v: 2 });
      await i.editReply({ content: 'Saved!' });
      freezeGuildWrites(guildId);
      saveDataOutcome('x.json', options, { v: 3 });
      unfreezeGuildWrites(guildId);
      await i.editReply({ content: 'Saved!' });
    });
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([
      ['post', truthText('frozen', false)],
      ['patch', truthText('unavailable', true)],
      ['patch', truthText('frozen', true)],
    ]);
  });

  it('a further rewrite of a document told as unconfirmable tells nothing new', async () => {
    const { wire, emit } = rig();
    const { guildId, options } = await storeGuild();
    await emit(rawCommand('c34'), async i => {
      freezeGuildWrites(guildId);
      saveDataOutcome('x.json', options, { v: 1 });
      unfreezeGuildWrites(guildId);
      saveDataOutcome('x.json', options, { v: 2 });
      await i.reply({ content: 'Saved 1' });
      saveDataOutcome('x.json', options, { v: 3 });
      await i.followUp({ content: 'Saved 2' });
    });
    expect(wire.map(textOf)).toEqual([truthText('unavailable', true)]);
  });
});

describe('order and the virtual acknowledgement', () => {
  it('a followUp made while a reply is held goes out after it, and the flags read as answered meanwhile', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    const done = emit(rawCommand('c14'), async i => {
      saveData('x.json', options, { v: 1 });
      const reply = i.reply({ content: 'Saved!' });
      const follow = i.followUp({ content: 'And this' });
      expect(i.replied).toBe(true);
      await tick(20);
      expect(wire).toEqual([]);
      store.release();
      await Promise.all([reply, follow]);
    });
    const { error } = await done;
    expect(error).toBeUndefined();
    expect(wire.map(textOf)).toEqual(['Saved!', 'And this']);
  });

  it('a modal after a held reply throws as discord.js would, and sends nothing', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let modalError: unknown;
    await emit(rawButton('b5'), async i => {
      saveData('x.json', options, { v: 1 });
      const reply = i.reply({ content: 'Saved!' });
      const modal = i.showModal(new ModalBuilder().setCustomId('m').setTitle('t')).catch((e: unknown) => { modalError = e; });
      await tick(20);
      store.release();
      await Promise.all([reply, modal]);
    });
    expect((modalError as { code?: string })?.code).toBe('InteractionAlreadyReplied');
    expect(wire.map(textOf)).toEqual(['Saved!']);
  });

  it('a send that fails rejects with discord.js\'s error and leaves the flags unset', async () => {
    const { control, emit } = rig();
    control.failNext = new Error('Unknown interaction');
    const { interaction, error } = await emit(rawCommand('c15'), async i => {
      await i.reply({ content: 'Pong' });
    });
    expect((error as Error).message).toBe('Unknown interaction');
    expect(interaction.replied).toBe(false);
    expect(interaction.deferred).toBe(false);
  });
});

describe('the ledgers read', () => {
  it('a write recorded only in the frame\'s ledger at the call is waited on', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.mode = 'read-only';
    await emit(rawCommand('c16'), async i => {
      const other = openLedger('panel');
      await runInLedger(other, 'modX', async () => {
        saveData('x.json', options, { v: 1 });
        await i.reply({ content: 'Saved!' });
      });
    });
    expect(wire.map(textOf)).toEqual([truthText('held', false)]);
  });

  it('a sealed ledger answers nothing: the payload goes out', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    await emit(rawCommand('c17'), async i => {
      saveData('x.json', options, { v: 1 });
      vi.advanceTimersByTime(INTERACTION_LEDGER_LIFE_MS);
      await i.reply({ content: 'Late' });
    });
    expect(wire.map(textOf)).toEqual(['Late']);
    store.release();
  });
});

describe('the answer over several writes', () => {
  it('a write that landed beside a held one gives the "in full" form', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.mode = 'read-only';
    const fileGuild = { guildId: `${Number(options.guildId) + 500}`, category: 'm' };
    await emit(rawCommand('c18'), async i => {
      saveData('f.json', fileGuild, { v: 1 });
      saveData('x.json', options, { v: 1 });
      await i.reply({ content: 'Saved!' });
    });
    expect(wire.map(textOf)).toEqual([truthText('held', true)]);
  });

  it('the worst refusal names the text', async () => {
    const { wire, emit } = rig();
    const { guildId, options } = await storeGuild();
    await emit(rawCommand('c19'), async i => {
      saveDataOutcome('y.json', notReadyGuild(), { v: 1 });
      freezeGuildWrites(guildId);
      saveDataOutcome('x.json', options, { v: 1 });
      unfreezeGuildWrites(guildId);
      await i.reply({ content: 'Saved!' });
    });
    expect(wire.map(textOf)).toEqual([truthText('frozen', false)]);
  });

  it.each([
    ['a lower-ranked refusal (not-ready)', false, 'database-backlog'],
    ['a higher-ranked refusal (read-only)', true, 'database-read-only'],
  ] as const)('a backlog refusal beside %s names the worse of the two', async (_name, readOnlyAfter, worst) => {
    const { wire, emit } = rig();
    const { guildId, store, options } = await storeGuild();
    store.mode = 'unavailable';
    saveData('big.json', options, 'x'.repeat(65 * 1024 * 1024));
    await emit(rawCommand('c19b'), async i => {
      saveDataOutcome('y.json', notReadyGuild(), { v: 1 });
      try { saveData('x.json', options, { v: 1 }); } catch { /* refused: database-backlog */ }
      if (readOnlyAfter) {
        store.isReadOnly = () => true;
        try { saveData('z.json', options, { v: 1 }); } catch { /* refused: database-read-only */ }
      }
      await i.reply({ content: 'Saved!' });
    });
    expect(wire.map(textOf)).toEqual([truthText(worst, false)]);
    expect(getWorkingSet()?.stateOf(guildId)).toBe('ready');
  });

  it('a refusal is made unconfirmable only by a rewrite of the same document, in the same guild and folder', async () => {
    const { wire, emit } = rig();
    const { guildId, options } = await storeGuild();
    await emit(rawCommand('c20'), async i => {
      freezeGuildWrites(guildId);
      saveDataOutcome('x.json', options, { v: 1 });
      unfreezeGuildWrites(guildId);
      saveData('y.json', options, { v: 1 });
      await i.reply({ content: 'Saved!' });
    });
    await emit(rawCommand('c21'), async i => {
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      saveData('x.json', options, { v: 1 });
      await i.reply({ content: 'Saved!' });
    });
    expect(wire.map(textOf)).toEqual([truthText('frozen', true), truthText('not-ready', true)]);
  });
});

describe('where the gate is installed', () => {
  it('IngestService.buildClient hands each interaction to the hook it is given', async () => {
    const client = new IngestService().buildClient({ intents: [] }, installReplyGate);
    const seen: boolean[] = [];
    client.on(Events.InteractionCreate, interaction => {
      seen.push(Object.getOwnPropertyDescriptor(interaction, 'replied')?.get !== undefined);
    });
    (client as unknown as { actions: { InteractionCreate: { handle(data: unknown): void } } }).actions.InteractionCreate.handle(rawCommand('w1'));
    expect(seen).toEqual([true]);
    client.removeAllListeners();
  });

  it.skipIf(process.env.__STRYKER_ACTIVE_MUTANT__ !== undefined)('the bot builds its gateway client with the reply gate (clientInitializer.ts)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/bot/internalSetup/clientInitializer.ts'), 'utf8');
    expect(source).toMatch(/getIngestService\(\)\.buildClient\(\{[^}]*\}, installReplyGate\)/);
  });
});
