import { afterEach, describe, expect, it, vi } from 'vitest';

// R1-J2 on the panel IPC and console entries (notes/BT.md, "R1-J2 design sheet (L0): final, after the re-read"): the
// hold runs before the entry's ledger opens, waits up to 2.5 s from the gate, and answers the cause's text.
const local = vi.hoisted(() => ({ commands: [] as any[] }));

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => local.commands }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  const client = { isReady: () => true, guilds: { cache: new Map() }, users: { cache: new Map() }, user: { id: '11' }, application: { id: '11' } };
  return { ...real, getPanelManager: () => ({ getClient: () => client }) };
});

import { gateCauseText } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { setManifestReader } from '../../src/bot/internalSetup/utils/dataBackends/dataContract';
import { confirmSaved, saveData, saveDataOutcome } from '../../src/bot/internalSetup/utils/dataManager';
import { freezeGuildWrites, unfreezeGuildWrites } from '../helpers/freezeGuild';
import { handleInvoke } from '../../src/bot/internalSetup/utils/ipcCommandHandler';
import { runPanelAction } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { fakeClock, NOT_LEASED, readinessRig, stopDrivers, watch } from '../helpers/readinessRig';

afterEach(() => {
  setManifestReader(null);
  stopDrivers();
  vi.useRealTimers();
});

/** A panel manager whose one panel runs fn for panel:execute. */
const manager = (fn: () => Promise<unknown>) => ({
  getPanel: () => undefined,
  executePanelForWebUI: vi.fn(fn),
});

describe('a panel action', () => {
  it.each([
    ['not-served', 'a guild not leased here'],
    ['loading', 'a guild still loading'],
  ] as const)('%s for %s', async (cause, _what) => {
    fakeClock();
    const r = readinessRig(cause === 'not-served' ? NOT_LEASED : undefined);
    if (cause === 'loading') r.store.hydrateMode = 'held';
    const guildId = r.guild();
    const pm = manager(async () => ({ success: true }));
    const answer = watch(runPanelAction('panel:execute', { panelId: 'p', userId: 'u', guildId }, pm));
    await vi.advanceTimersByTimeAsync(2600);
    expect(answer.value()).toEqual({ success: false, error: gateCauseText(cause) });
    expect(pm.executePanelForWebUI).not.toHaveBeenCalled();
  });

  it('admitted after a freeze, its confirmSaved answers for the writes after admission only', async () => {
    fakeClock();
    setManifestReader(() => ({ dataContract: 2 }));
    const r = readinessRig();
    const guildId = await r.ready();
    let saved: string | undefined;
    const pm = manager(async () => {
      saveData('x.json', { guildId, category: 'm' }, { v: 1 });
      saved = await confirmSaved(guildId);
      return { success: true };
    });
    freezeGuildWrites(guildId);
    const answer = watch(runPanelAction('panel:execute', { panelId: 'p', userId: 'u', guildId }, pm));
    await vi.advanceTimersByTimeAsync(200);
    expect(saveDataOutcome('timer.json', { guildId, category: 'm' }, { v: 2 })).toBe('frozen');
    unfreezeGuildWrites(guildId);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(saved).toBe('ok');
    expect(answer.value()).toEqual({ success: true });
  });
});

describe('a console invoke', () => {
  const invoke = (guildId: string) => handleInvoke({ command: 'probe', guildId, force: true });

  it.each([
    ['not-served', (id: string) => `guild ${id}'s data is not served by this bot process right now; try again in a moment`],
    ['loading', (id: string) => `guild ${id}'s data is still loading; try again in a moment`],
  ] as const)('%s answers its own text and never runs the command', async (cause, text) => {
    fakeClock();
    const ran = vi.fn();
    local.commands = [{ name: 'probe', callback: ran }];
    const r = readinessRig(cause === 'not-served' ? NOT_LEASED : undefined);
    if (cause === 'loading') r.store.hydrateMode = 'held';
    const guildId = r.guild();
    const answer = watch(invoke(guildId));
    await vi.advanceTimersByTimeAsync(2600);
    expect(answer.value()).toEqual({ success: false, error: text(guildId) });
    expect(ran).not.toHaveBeenCalled();
  });

  it('waits for a guild that becomes ready within 2.5 s, then runs the command', async () => {
    fakeClock();
    const ran = vi.fn();
    local.commands = [{ name: 'probe', callback: ran }];
    const r = readinessRig();
    r.store.hydrateMode = 'held';
    const guildId = r.guild();
    const answer = watch(invoke(guildId));
    await vi.advanceTimersByTimeAsync(1000);
    expect(answer.settled()).toBe(false);
    r.store.releaseHydrations();
    await vi.advanceTimersByTimeAsync(300);
    expect(ran).toHaveBeenCalledTimes(1);
  });
});

describe('what a panel entry holds', () => {
  it('only a panel action that names a guild: a list on a frozen guild, a guildless action and no data run at once', async () => {
    const r = readinessRig();
    const guildId = await r.ready();
    const pm = { ...manager(async () => ({ success: true })), getWebUIPanelList: vi.fn(() => []) };
    freezeGuildWrites(guildId);
    try {
      expect(await runPanelAction('panel:list', { guildId }, pm)).toMatchObject({ success: true, panels: [] });
    } finally {
      unfreezeGuildWrites(guildId);
    }
    const started = performance.now();
    expect(await runPanelAction('panel:execute', { panelId: 'p', userId: 'u' }, pm)).toMatchObject({ success: true });
    expect(pm.executePanelForWebUI).toHaveBeenCalledTimes(1);
    expect(performance.now() - started).toBeLessThan(1000);
    await expect(runPanelAction('panel:list', undefined, pm)).resolves.toMatchObject({ success: true });
    await expect(runPanelAction('panel:execute', undefined, pm)).resolves.toMatchObject({ success: false, error: 'Missing required fields: panelId and userId' });
  });
});
