import { Events, Guild, InteractionResponseType, InteractionType, type Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractGuildId, gateCauseText, gateEventDispatch, runAsAdmitted } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { setManifestReader } from '../../src/bot/internalSetup/utils/dataBackends/dataContract';
import { truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { withModule } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { confirmSaved, saveData, saveDataOutcome } from '../../src/bot/internalSetup/utils/dataManager';
import { freezeGuildWrites, unfreezeGuildWrites } from '../helpers/freezeGuild';
import { callbackType, EPHEMERAL, rawButton, rawCommand, rig, textOf, tick } from '../helpers/gateRig';
import { fakeClock, NOT_LEASED, readinessRig, stopDrivers } from '../helpers/readinessRig';

// R1-J2 on the Discord path (notes/BT.md, "R1-J2 design sheet (L0): final, after the re-read"): one hold per
// interaction for every gated listener, its refusal sent once, its bound counted from the emit, confirmSaved across a
// hold, and the event gate for the payloads extractGuildId now reads.

beforeEach(() => {
  setManifestReader(name => (name.startsWith('flag') ? { dataContract: 2 } : undefined));
});
afterEach(() => {
  setManifestReader(null);
  stopDrivers();
  vi.useRealTimers();
});

/** A listener as the internal dispatcher and the module wrapper register one: the gate, then the module admitted. */
function gated(client: Client, module: string, run: (interaction: any) => Promise<void>): void {
  client.on(Events.InteractionCreate, async (...args: any[]) => {
    if (!(await gateEventDispatch('interactionCreate', args, () => undefined))) return;
    await runAsAdmitted(args, () => withModule(module, () => run(args[0])));
  });
}
const emitRaw = (client: Client, raw: object) =>
  (client as unknown as { actions: { InteractionCreate: { handle(data: unknown): void } } }).actions.InteractionCreate.handle(raw);
let ids = 0;
const command = (guildId: string) => ({ ...rawCommand(`j2-${++ids}`), guild_id: guildId });

describe('one hold per interaction', () => {
  it('two gated listeners meet one hold: one refusal, sent once, and no module runs', async () => {
    fakeClock();
    const r = readinessRig();
    const guildId = await r.ready();
    const { client, wire } = rig();
    const ran: string[] = [];
    gated(client, 'core', async () => { ran.push('core'); });
    gated(client, 'moda', async () => { ran.push('moda'); });
    freezeGuildWrites(guildId);
    try {
      emitRaw(client, command(guildId));
      await vi.advanceTimersByTimeAsync(2100);
    } finally {
      unfreezeGuildWrites(guildId);
    }
    expect(ran).toEqual([]);
    expect(wire.map(c => [callbackType(c), textOf(c)])).toEqual([[InteractionResponseType.ChannelMessageWithSource, gateCauseText('loading')]]);
    expect(wire[0].body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
  });

  it('admitted, every gated listener runs', async () => {
    fakeClock();
    const r = readinessRig();
    const guildId = await r.ready();
    const { client, wire } = rig();
    const ran: string[] = [];
    gated(client, 'core', async () => { ran.push('core'); });
    gated(client, 'moda', async () => { ran.push('moda'); });
    freezeGuildWrites(guildId);
    emitRaw(client, command(guildId));
    await vi.advanceTimersByTimeAsync(500);
    unfreezeGuildWrites(guildId);
    await vi.advanceTimersByTimeAsync(100);
    expect([...ran].sort()).toEqual(['core', 'moda']);
    expect(wire).toEqual([]);
  });

  it('the hold ends at the interaction\'s emit plus ACK_MS, not 2.5 s after the gate', async () => {
    fakeClock();
    const r = readinessRig();
    const guildId = r.hydrating();
    const { client, wire } = rig();
    gated(client, 'core', async () => undefined);
    emitRaw(client, command(guildId));
    await vi.advanceTimersByTimeAsync(1990);
    expect(wire).toEqual([]);
    await vi.advanceTimersByTimeAsync(30);
    expect(wire.map(textOf)).toEqual([gateCauseText('loading')]);
  });

  it('a listener that reaches the gate after the hold refused never runs, though the freeze has lifted since', async () => {
    fakeClock();
    const r = readinessRig();
    const guildId = await r.ready();
    const { client, wire } = rig();
    const ran: string[] = [];
    gated(client, 'core', async () => { ran.push('core'); });
    client.on(Events.InteractionCreate, async (...args: any[]) => {
      await new Promise(resolve => setTimeout(resolve, 2100));
      if (!(await gateEventDispatch('interactionCreate', args, () => undefined))) return;
      ran.push('late');
    });
    freezeGuildWrites(guildId);
    setTimeout(() => unfreezeGuildWrites(guildId), 2050);
    emitRaw(client, command(guildId));
    await vi.advanceTimersByTimeAsync(2300);
    expect(ran).toEqual([]);
    expect(wire.map(textOf)).toEqual([gateCauseText('loading')]);
  });

  it('a gate entered after the emit still ends at the emit plus ACK_MS', async () => {
    fakeClock();
    const r = readinessRig();
    const guildId = r.hydrating();
    const { client, wire } = rig();
    client.on(Events.InteractionCreate, async (...args: any[]) => {
      await new Promise(resolve => setTimeout(resolve, 500));
      await gateEventDispatch('interactionCreate', args, () => undefined);
    });
    emitRaw(client, command(guildId));
    await vi.advanceTimersByTimeAsync(1990);
    expect(wire).toEqual([]);
    await vi.advanceTimersByTimeAsync(30);
    expect(wire.map(textOf)).toEqual([gateCauseText('loading')]);
  });

  it('an autocomplete gets an empty answer for every cause', async () => {
    fakeClock();
    const r = readinessRig();
    const guildId = await r.ready();
    const { client, wire } = rig();
    gated(client, 'core', async () => undefined);
    freezeGuildWrites(guildId);
    try {
      emitRaw(client, {
        ...rawCommand(`j2-${++ids}`),
        guild_id: guildId,
        type: InteractionType.ApplicationCommandAutocomplete,
        data: { id: '12', name: 'ping', type: 1, options: [{ name: 'q', type: 3, value: '', focused: true }] },
      });
      await vi.advanceTimersByTimeAsync(2100);
    } finally {
      unfreezeGuildWrites(guildId);
    }
    expect(wire.map(c => [callbackType(c), c.body?.data?.choices])).toEqual([[InteractionResponseType.ApplicationCommandAutocompleteResult, []]]);
  });
});

describe('confirmSaved across a hold', () => {
  it('a flagged module admitted after a freeze answers ok for its own landed save, though another writer was refused during it', async () => {
    fakeClock();
    const r = readinessRig();
    const guildId = await r.ready();
    const { client } = rig();
    let answer: string | undefined;
    gated(client, 'flagmod', async () => {
      saveData('x.json', { guildId, category: 'm' }, { v: 1 });
      answer = await confirmSaved(guildId);
    });
    freezeGuildWrites(guildId);
    emitRaw(client, command(guildId));
    await vi.advanceTimersByTimeAsync(200);
    expect(saveDataOutcome('timer.json', { guildId, category: 'm' }, { v: 2 })).toBe('frozen');
    await vi.advanceTimersByTimeAsync(300);
    unfreezeGuildWrites(guildId);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(answer).toBe('ok');
  });

  it('the same after a held load, during which another writer was refused as not ready', async () => {
    fakeClock();
    const r = readinessRig();
    r.store.hydrateMode = 'held';
    const guildId = r.guild();
    const { client } = rig();
    let answer: string | undefined;
    gated(client, 'flagmod', async () => {
      saveData('x.json', { guildId, category: 'm' }, { v: 1 });
      answer = await confirmSaved(guildId);
    });
    emitRaw(client, command(guildId));
    await vi.advanceTimersByTimeAsync(200);
    expect(r.ws.stateOf(guildId)).toBe('hydrating');
    expect(saveDataOutcome('timer.json', { guildId, category: 'm' }, { v: 2 })).toBe('refused');
    r.store.releaseHydrations();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(answer).toBe('ok');
  });

  it('a listener the gate does not hold keeps its own refusal in its answer', async () => {
    fakeClock();
    const r = readinessRig();
    const guildId = await r.ready();
    const { client } = rig();
    let admitted!: () => void;
    const admission = new Promise<void>(resolve => { admitted = resolve; });
    let collector: string | undefined;
    client.on(Events.InteractionCreate, async () => {
      expect(saveDataOutcome('c.json', { guildId, category: 'm' }, { v: 1 })).toBe('frozen');
      await admission;
      collector = await confirmSaved(guildId);
    });
    gated(client, 'flagmod', async () => { admitted(); });
    freezeGuildWrites(guildId);
    emitRaw(client, command(guildId));
    await vi.advanceTimersByTimeAsync(300);
    unfreezeGuildWrites(guildId);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(collector).toBe('refused');
  });
});

describe('after admission', () => {
  it('a freeze landing after admission is told to the member by the reply gate', async () => {
    fakeClock();
    const r = readinessRig();
    const guildId = await r.ready();
    const { client, wire } = rig();
    gated(client, 'core', async interaction => {
      freezeGuildWrites(guildId);
      saveData('x.json', { guildId, category: 'm' }, { v: 1 });
      await interaction.reply({ content: 'Saved!' });
    });
    try {
      emitRaw(client, command(guildId));
      await vi.advanceTimersByTimeAsync(3000);
    } finally {
      unfreezeGuildWrites(guildId);
    }
    expect(wire.map(textOf)).toEqual([truthText('frozen', false)]);
  });
});

describe('the event gate for the payloads extractGuildId now reads', () => {
  const guildOf = (id: string) => Object.assign(Object.create(Guild.prototype), { id }) as Guild;

  it('a reaction for a hydrating guild kicks a claim, buffers, and replays once ready', async () => {
    const r = readinessRig();
    r.store.hydrateMode = 'held';
    const guildId = r.guild();
    const replay = vi.fn();
    expect(await gateEventDispatch('messageReactionAdd', [{ message: { guildId } }, { id: '13' }], replay)).toBe(false);
    expect(r.store.hydrationsSent).toBe(1);
    r.store.releaseHydrations();
    await tick(10);
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('a reaction, a thread member and a poll answer for a guild not leased here are dropped', async () => {
    const r = readinessRig(NOT_LEASED);
    const guildId = r.guild();
    const replay = vi.fn();
    expect(await gateEventDispatch('messageReactionAdd', [{ message: { guildId } }, { id: '13' }], replay)).toBe(false);
    expect(await gateEventDispatch('threadMembersUpdate', [{ thread: { guildId } }], replay)).toBe(false);
    expect(await gateEventDispatch('messagePollVoteAdd', [{ poll: { message: { guildId } } }, '13'], replay)).toBe(false);
    await tick(10);
    expect(replay).not.toHaveBeenCalled();
    expect(r.store.hydrationsSent).toBe(0);
  });

  it('an event on a frozen-retained set dispatches, as today', async () => {
    const r = readinessRig();
    const guildId = await r.ready();
    freezeGuildWrites(guildId);
    expect(await gateEventDispatch('messageReactionAdd', [{ message: { guildId } }, { id: '13' }], () => undefined)).toBe(true);
  });

  it('a Guild payload passes the data gate with no claim: guildCreate, guildDelete, a members chunk', async () => {
    const r = readinessRig();
    r.store.hydrateMode = 'held';
    const guildId = r.guild();
    const replay = vi.fn();
    expect(await gateEventDispatch('guildCreate', [guildOf(guildId)], replay)).toBe(true);
    expect(await gateEventDispatch('guildDelete', [guildOf(guildId)], replay)).toBe(true);
    expect(await gateEventDispatch('guildMembersChunk', [new Map(), guildOf(guildId), {}], replay)).toBe(true);
    await tick(10);
    expect(r.store.hydrationsSent).toBe(0);
    expect(replay).not.toHaveBeenCalled();
    expect(extractGuildId([guildOf(guildId)])).toBe(guildId);
  });

  it('a Guild payload for a guild not leased here passes the data gate', async () => {
    const r = readinessRig(NOT_LEASED);
    const guildId = r.guild();
    expect(await gateEventDispatch('guildCreate', [guildOf(guildId)], () => undefined)).toBe(true);
    expect(await gateEventDispatch('guildDelete', [guildOf(guildId)], () => undefined)).toBe(true);
  });

  it('a component on a ready guild dispatches with no wait', async () => {
    const r = readinessRig();
    const guildId = await r.ready();
    const { client, wire } = rig();
    let ran = false;
    gated(client, 'core', async () => { ran = true; });
    emitRaw(client, { ...rawButton(`j2-${++ids}`), guild_id: guildId });
    await tick(10);
    expect(ran).toBe(true);
    expect(wire).toEqual([]);
  });
});
