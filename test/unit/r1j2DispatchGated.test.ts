import { Events } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The internal dispatcher's listener (boot.ts dispatchGated, clientInitializer.ts's one call): the gate, the dispatch
// from the interaction's admission, then the reply gate's sweep, which the listener does not wait on. Its own file:
// the sweep is replaced by a recorder that never ends on its own.

const spy = vi.hoisted(() => ({ swept: [] as unknown[] }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/replyGate', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataBackends/replyGate')>();
  return { ...real, sweepLateWrites: (interaction: unknown) => { spy.swept.push(interaction); return new Promise<void>(() => undefined); } };
});

import { dispatchGated } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { currentSince, ledgerOf } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { rawCommand, rig, tick } from '../helpers/gateRig';
import { readinessRig, stopDrivers } from '../helpers/readinessRig';

afterEach(() => {
  stopDrivers();
  spy.swept.length = 0;
});

let ids = 0;
function listen(client: any, dispatch: (...args: any[]) => Promise<void>) {
  const ended: unknown[] = [];
  client.on(Events.InteractionCreate, async (...args: any[]) => {
    await dispatchGated('interactionCreate', args, dispatch);
    ended.push(args[0]);
  });
  return ended;
}
const handle = (client: any, guildId: string) =>
  client.actions.InteractionCreate.handle({ ...rawCommand(`dg-${++ids}`), guild_id: guildId });

describe('the internal dispatcher', () => {
  it('dispatches an admitted interaction from its admission, then sweeps it, and does not wait on the sweep', async () => {
    const r = readinessRig();
    const guildId = await r.ready();
    const { client } = rig();
    const seen: { interaction: unknown; fromAdmission: boolean; sweptBeforeEnd: number }[] = [];
    const ended = listen(client, async interaction => {
      const fromAdmission = currentSince() !== ledgerOf(interaction)?.openedMark;
      await tick(5);
      seen.push({ interaction, fromAdmission, sweptBeforeEnd: spy.swept.length });
    });
    handle(client, guildId);
    await tick(20);
    expect(seen).toHaveLength(1);
    expect(seen[0].fromAdmission).toBe(true);
    expect(seen[0].sweptBeforeEnd).toBe(0);
    expect(spy.swept).toEqual([seen[0].interaction]);
    expect(ended).toEqual([seen[0].interaction]);
  });

  it('a refused interaction is neither dispatched nor swept', async () => {
    const r = readinessRig();
    const guildId = await r.ready();
    r.store.mode = 'deposed';
    saveData('x.json', { guildId, category: 'm' }, { v: 1 });
    await r.ws.flushGuildNow(guildId, 1000);
    expect(r.ws.stateOf(guildId)).toBe('fenced');
    const { client } = rig();
    const dispatch = vi.fn(async () => undefined);
    const ended = listen(client, dispatch);
    handle(client, guildId);
    await tick(20);
    expect(dispatch).not.toHaveBeenCalled();
    expect(spy.swept).toEqual([]);
    expect(ended).toHaveLength(1);
  });

  it('an event for a hydrating guild is replayed through the dispatch once ready, and never swept', async () => {
    const r = readinessRig();
    r.store.hydrateMode = 'held';
    const guildId = r.guild();
    const dispatch = vi.fn(async () => undefined);
    const reaction = { message: { guildId } };
    await dispatchGated('messageReactionAdd', [reaction, { id: '13' }], dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    r.store.releaseHydrations();
    await tick(10);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(reaction, { id: '13' });
    await dispatchGated('messageReactionAdd', [reaction, { id: '14' }], dispatch);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(spy.swept).toEqual([]);
  });
});
