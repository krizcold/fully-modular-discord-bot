import fs from 'fs';
import path from 'path';
import { ComponentType, ContainerBuilder, Events, InteractionResponseType, ModalBuilder, TextDisplayBuilder } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { ACK_MS, installReplyGate, truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { IngestService } from '../../src/bot/internalSetup/ingest/ingestService';
import { getWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { tokenFor } from '../helpers/fakeStore';

// BT-3, the interaction reply gate (notes/BT.md, "BT-3 design sheet (L0)"). A response method on a real interaction
// sends the module's payload only once every write in the union of its ledgers has landed and none was refused;
// otherwise the truth goes in its place, and the interaction is acknowledged inside ACK_MS either way.

import { callbackType, EPHEMERAL, notReadyGuild, rawButton, rawCommand, rig, storeGuild, textOf, tick, V2 } from '../helpers/gateRig';

afterEach(() => {
  vi.useRealTimers();
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
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['patch', truthText('deposed', false)]]);
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
      await i.deferReply();
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
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['patch', truthText('not-ready', false)]]);
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

  it('the bot builds its gateway client with the reply gate (clientInitializer.ts)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/bot/internalSetup/clientInitializer.ts'), 'utf8');
    expect(source).toMatch(/getIngestService\(\)\.buildClient\(\{[^}]*\}, installReplyGate\)/);
  });
});
