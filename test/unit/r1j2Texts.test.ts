import fs from 'fs';
import path from 'path';
import { Events, Guild } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// R1-J2's texts, the extractor's guards, and the module event wrapper (rows L5 asked for). Its own file: the loading
// notice's config property is scripted here.

const config = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock('../../src/bot/internalSetup/utils/configManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/configManager')>();
  return { ...real, getConfigProperty: (property: string) => (config.values.has(property) ? config.values.get(property) : real.getConfigProperty(property)) };
});

import { eventGuildId, extractGuildId, gateCauseText, gateConsoleText, gateEventDispatch } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { currentSince, ledgerOf } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { getMetricsCollector } from '../../src/bot/internalSetup/utils/metrics/metricsCollector';
import { getModuleEventManager } from '../../src/bot/internalSetup/utils/moduleEventManager';
import { rawCommand, rig, tick } from '../helpers/gateRig';
import { readinessRig, stopDrivers } from '../helpers/readinessRig';

afterEach(() => {
  config.values.clear();
  stopDrivers();
  getModuleEventManager().removeAllListeners();
  vi.restoreAllMocks();
});

describe('the texts', () => {
  it.each([
    ['stopping', 'The bot is stopping; please try again in a moment.'],
    ['refused', "This bot's data storage is currently unavailable; please contact the server operator."],
    ['moving', "This server's data is being moved; please try again in a moment."],
    ['moved', "This server's data moved to another bot node; please try again in a moment."],
    ['not-served', "This server's data is not served by this bot node right now; please try again in a moment."],
    ['loading', "This server's data is still loading, try again in a moment."],
  ] as const)('the member and panel text for %s', (cause, text) => {
    expect(gateCauseText(cause)).toBe(text);
  });

  it('the loading text is the operator\'s outageNotice.dataLoading when set, and the default when blank', () => {
    config.values.set('outageNotice.dataLoading', 'Hold on, loading.');
    expect(gateCauseText('loading')).toBe('Hold on, loading.');
    config.values.set('outageNotice.dataLoading', '  ');
    expect(gateCauseText('loading')).toBe("This server's data is still loading, try again in a moment.");
  });

  it.each([
    ['stopping', 'the bot is stopping; try again in a moment'],
    ['refused', "the bot's data storage is unavailable; contact the server operator"],
    ['moving', "guild 4242's data is being moved; try again in a moment"],
    ['moved', "guild 4242's data moved to another bot node; try again in a moment"],
    ['not-served', "guild 4242's data is not served by this bot node right now; try again in a moment"],
    ['loading', "guild 4242's data is still loading; try again in a moment"],
  ] as const)('the console text for %s', (cause, text) => {
    expect(gateConsoleText(cause, '4242')).toBe(text);
  });
});

describe('the extractor', () => {
  it('reads only string ids, and a poll with neither a message nor a channel is no guild', () => {
    const numeric = Object.assign(Object.create(Guild.prototype), { id: 42 }) as Guild;
    for (const payload of [{ guildId: 42 }, { guild: { id: 42 } }, { message: { guildId: 42 } }, { thread: { guildId: 7 } }, { poll: {} }, numeric]) {
      expect(extractGuildId([payload])).toBeNull();
    }
  });

  it('skips nullish, primitive and function arguments before the payload that names the guild', () => {
    const fn = Object.assign(() => undefined, { guildId: 'not-a-payload' });
    expect(extractGuildId([null, undefined, 'text', 5, fn, { guildId: '777' }])).toBe('777');
  });

  it('the data gate and the metrics take a Guild payload as no guild, and every other shape as its guild', () => {
    const guild = Object.assign(Object.create(Guild.prototype), { id: '42' }) as Guild;
    expect(extractGuildId([guild])).toBe('42');
    expect(eventGuildId([guild])).toBeNull();
    expect(eventGuildId([{ guild: { id: '5' } }])).toBe('5');
    expect(eventGuildId([null, { guildId: '6' }])).toBe('6');
    expect(eventGuildId([])).toBeNull();
    expect(eventGuildId([{ id: '7' }])).toBeNull();
  });

  it('a member payload ({ guild: { id } }) meets the data gate, unlike a Guild payload', async () => {
    const r = readinessRig();
    r.store.hydrateMode = 'held';
    const guildId = r.guild();
    const replay = vi.fn();
    expect(await gateEventDispatch('guildMemberUpdate', [{ guild: { id: guildId } }], replay)).toBe(false);
    r.store.releaseHydrations();
    await tick(10);
    expect(replay).toHaveBeenCalledTimes(1);
  });
});

describe('the module event wrapper', () => {
  it('runs a module\'s interaction handler with the client, from the interaction\'s admission', async () => {
    const r = readinessRig();
    const guildId = await r.ready();
    const { client } = rig();
    const manager = getModuleEventManager();
    manager.setClient(client);
    const seen: { client: unknown; interaction: unknown; fromAdmission: boolean }[] = [];
    manager.registerListener('probe', Events.InteractionCreate, async (c: unknown, interaction: object) => {
      seen.push({ client: c, interaction, fromAdmission: currentSince() !== ledgerOf(interaction)?.openedMark });
    });
    (client as any).actions.InteractionCreate.handle({ ...rawCommand('mw-1'), guild_id: guildId });
    await tick(20);
    expect(seen).toHaveLength(1);
    expect(seen[0].client).toBe(client);
    expect(seen[0].fromAdmission).toBe(true);
  });

  function recordedEvent(eventName: string, payload: object) {
    const { client } = rig();
    const manager = getModuleEventManager();
    manager.setClient(client);
    const collector = getMetricsCollector();
    vi.spyOn(collector, 'isEnabled').mockReturnValue(true);
    const record = vi.spyOn(collector, 'record').mockImplementation(() => undefined);
    manager.registerListener('probe', eventName, async () => undefined);
    client.emit(eventName, payload);
    return record;
  }

  it('counts a Guild payload\'s event under the global key, so a guildDelete does not record the departed guild again', async () => {
    const record = recordedEvent(Events.GuildDelete, Object.assign(Object.create(Guild.prototype), { id: '9001' }));
    await tick(10);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0].slice(0, 4)).toEqual(['event', null, 'probe', Events.GuildDelete]);
  });

  it('counts a member payload\'s event under its guild', async () => {
    const r = readinessRig();
    const guildId = await r.ready();
    const record = recordedEvent(Events.GuildMemberUpdate, { guild: { id: guildId } });
    await tick(10);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0].slice(0, 4)).toEqual(['event', guildId, 'probe', Events.GuildMemberUpdate]);
  });

  it('counts a reaction\'s event under its guild, as the core reaction handlers do', async () => {
    const r = readinessRig();
    const guildId = await r.ready();
    const record = recordedEvent(Events.MessageReactionAdd, { message: { guildId } });
    await tick(10);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0].slice(0, 4)).toEqual(['event', guildId, 'probe', Events.MessageReactionAdd]);
  });

  // The whole-module tier gate looks up the registry and the premium manager with require(), which finds no .ts module
  // under vitest, so in these tests it passes every event; its reader is pinned by text instead (skipped inside the
  // mutation gate's sandbox, which instruments the source).
  it.skipIf(process.env.__STRYKER_ACTIVE_MUTANT__ !== undefined)('the whole-module tier gate reads extractGuildId, so a Guild payload counts there', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/bot/internalSetup/utils/moduleEventManager.ts'), 'utf-8');
    const gate = source.slice(source.indexOf('  private shouldSkipEvent('));
    expect(gate).toContain('    const guildId = extractGuildId(args);\n');
    expect(gate).not.toContain('eventGuildId');
  });
});
