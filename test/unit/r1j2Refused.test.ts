import { Events, Guild, InteractionResponseType } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { gateCauseNow, gateCauseText, gateEventDispatch, getDataBootStatus, initDataBackendLayer } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { runPanelAction } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { callbackType, rawCommand, rig, textOf, tick } from '../helpers/gateRig';
import { readinessRig, stopDrivers } from '../helpers/readinessRig';

// R1-J2's refused row (notes/BT.md, "R1-J2 design sheet (L0): final, after the re-read"). Its own file: a refused
// data layer stays refused in this process.

afterEach(() => {
  stopDrivers();
});

describe('a refused data layer', () => {
  it('reads refused, final, and every entry answers its text', async () => {
    const r = readinessRig();
    const guildId = await r.ready();
    const previous = process.env.DATA_BACKEND;
    process.env.DATA_BACKEND = 'not-a-backend';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      initDataBackendLayer();
    } finally {
      if (previous === undefined) delete process.env.DATA_BACKEND;
      else process.env.DATA_BACKEND = previous;
    }
    expect(getDataBootStatus().state).toBe('refused');
    expect(gateCauseNow(guildId, performance.now())).toBe('refused');

    const { client, wire } = rig();
    let ran = false;
    client.on(Events.InteractionCreate, async (...args: any[]) => {
      if (!(await gateEventDispatch('interactionCreate', args, () => undefined))) return;
      ran = true;
    });
    (client as unknown as { actions: { InteractionCreate: { handle(data: unknown): void } } }).actions.InteractionCreate.handle({ ...rawCommand('refused-1'), guild_id: guildId });
    await tick(20);
    expect(ran).toBe(false);
    expect(wire.map(c => [callbackType(c), textOf(c)])).toEqual([[InteractionResponseType.ChannelMessageWithSource, gateCauseText('refused')]]);

    const pm = { getPanel: () => undefined, executePanelForWebUI: vi.fn(async () => ({ success: true })) };
    expect(await runPanelAction('panel:execute', { panelId: 'p', userId: 'u', guildId }, pm)).toEqual({ success: false, error: gateCauseText('refused') });
    expect(pm.executePanelForWebUI).not.toHaveBeenCalled();

    const guild = Object.assign(Object.create(Guild.prototype), { id: guildId }) as Guild;
    expect(await gateEventDispatch('guildCreate', [guild], () => undefined)).toBe(true);
    expect(await gateEventDispatch('messageReactionAdd', [{ message: { guildId } }, { id: '13' }], () => undefined)).toBe(false);
  });
});
