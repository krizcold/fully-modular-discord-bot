import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { dropPendingForGuild } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { getWorkingSet, initWorkingSet, DataBackendUnavailableError } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import {
  _resetMaintenance,
  _setMaintenanceSender,
  _setMaintenanceTiming,
  closeMaintenanceGate,
  enterMaintenance,
  ENTER_BOUNDS,
  guardRejection,
  guardUncaught,
  handleMaintenanceIpc,
  maintenanceMode,
  markDiscordStarted,
  setupMaintenanceIPCAtBoot,
  watchDataBackend,
} from '../../src/bot/internalSetup/utils/maintenance';
import { isMaintenanceGateClosed, maintenanceCause, maintenanceText } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { getMetricsCollector } from '../../src/bot/internalSetup/utils/metrics/metricsCollector';
import { maintenanceFilePath, writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore, tokenFor } from '../helpers/fakeStore';
import { freshGuild, storeGuild, tick } from '../helpers/gateRig';

// NB2 round 1 rulings A, B, C, G and I and the rulings L and M of rounds 2 to 4, in the bot process: the answer bound,
// the leave step (save, then ask for the restart; it waits while the database does not answer, and gives up a guild
// the database refuses for its content), the held report, the re-sent restart request, the maintenance.json backstop,
// the metric totals flushed before the gate closes, the re-read of the file at boot, and the refusal guard.

const sent: any[] = [];
const restarts = () => sent.filter(m => m.type === 'control:restart-bot');

beforeEach(() => {
  _resetMaintenance();
  sent.length = 0;
  _setMaintenanceSender(message => { sent.push(message); });
  _setMaintenanceTiming({ leaveRetryMs: 30, filePollMs: 20, restartResendMs: 60, leaveSaveBoundMs: 100 });
  fs.rmSync(maintenanceFilePath(), { force: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  _resetMaintenance();
  _setMaintenanceSender(null);
  vi.restoreAllMocks();
});

describe('ruling A: the bot process answers inside the web UI wait', () => {
  it('the handler wait and the save bound together stay under 20 seconds', () => {
    expect(ENTER_BOUNDS.handlerWaitMs + ENTER_BOUNDS.saveBoundMs).toBeLessThan(20_000);
  });
});

describe('ruling B: the leave step', () => {
  it('maintenance:leave answers at once, then the held changes are saved, then the restart is asked', async () => {
    const { store, options, guildId } = await storeGuild();
    saveData('held.json', options, { v: 1 });
    closeMaintenanceGate('hook', 'm');
    let dirtyAtRestart: string[] | null = null;
    _setMaintenanceSender(message => {
      sent.push(message);
      if ((message as { type?: string }).type === 'control:restart-bot') dirtyAtRestart = getWorkingSet()!.dirtyGuildIds();
    });
    const reply = await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'l1', data: {} });
    expect(reply).toEqual({ requestId: 'l1', data: { leaving: true } });
    expect(isMaintenanceGateClosed()).toBe(true);
    await vi.waitFor(() => expect(restarts()).toHaveLength(1), { timeout: 5000 });
    expect(dirtyAtRestart).toEqual([]);
    expect(store.commits.length).toBeGreaterThan(0);
    expect(getWorkingSet()!.dirtyGuildIds()).not.toContain(guildId);
  }, 15_000);

  it('while a change cannot be saved the process keeps it and asks for no restart; once saved, it asks', async () => {
    const { store, options, guildId } = await storeGuild();
    store.mode = 'unavailable';
    saveData('held.json', options, { v: 1 });
    closeMaintenanceGate('hook', 'm');
    await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'l2', data: {} });
    await tick(4000);
    expect(restarts()).toHaveLength(0);
    expect(getWorkingSet()!.dirtyGuildIds()).toContain(guildId);
    store.mode = 'commit';
    await vi.waitFor(() => expect(restarts()).toHaveLength(1), { timeout: 8000 });
    expect(getWorkingSet()!.dirtyGuildIds()).not.toContain(guildId);
  }, 20_000);

  it('a second leave request joins the first: one restart request', async () => {
    closeMaintenanceGate('hook', 'm');
    await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'a', data: {} });
    await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'b', data: {} });
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
    expect(restarts()[0]).toEqual({ type: 'control:restart-bot', data: { reason: 'The hook says running' } });
  });

  it('the restart request is sent again while the process still runs after the resend interval', async () => {
    closeMaintenanceGate('hook', 'm');
    await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'a', data: {} });
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
    await vi.waitFor(() => expect(restarts().length).toBeGreaterThanOrEqual(3), { timeout: 2000 });
  });

  it('backstop: with the gate closed by the hook, maintenance.json saying running starts the leave step', async () => {
    writeMaintenanceFile('maintenance', 'm');
    closeMaintenanceGate('hook', 'm');
    await tick(100);
    expect(restarts()).toHaveLength(0);
    writeMaintenanceFile('running', 'm');
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
  });

  it('the backstop does not leave when maintenance.json is missing', async () => {
    writeMaintenanceFile('maintenance', 'm');
    closeMaintenanceGate('hook', 'm');
    fs.rmSync(maintenanceFilePath(), { force: true });
    await tick(150);
    expect(restarts()).toHaveLength(0);
    expect(isMaintenanceGateClosed()).toBe(true);
  });

  it('the backstop does not run for a gate closed by a refused login', async () => {
    writeMaintenanceFile('running', 'm');
    closeMaintenanceGate('login-refused', 'm');
    await tick(150);
    expect(restarts()).toHaveLength(0);
  });

});

/** A watcher whose next answer the test sets; each probe is driven by probeNow on a clock the test moves. */
function watchedDatabase(first: 'answers' | 'refused' | 'unreachable') {
  const state = { answer: first, now: 0 };
  const disconnect = vi.fn(async () => undefined);
  const watcher = watchDataBackend({
    onLoginRefused: () => undefined,
    askDatabase: async () => state.answer,
  }, { retryMs: 3_600_000, now: () => state.now, disconnect })!;
  markDiscordStarted();
  const at = async (ms: number, answer?: 'answers' | 'refused' | 'unreachable') => {
    state.now = ms;
    if (answer) state.answer = answer;
    await watcher.probeNow();
  };
  return { at, disconnect };
}

const retryWarnings = () => (console.warn as any).mock.calls.filter((c: unknown[]) => String(c[0]).includes('tries again')).length;
const errorsWith = (text: string) => (console.error as any).mock.calls.filter((c: unknown[]) => String(c[0]).includes(text));

/** A JSON guild whose file write cannot land: a directory stands where the file goes. */
function stuckFile() {
  setBackendKind('file');
  initWorkingSet(new FakeStore());
  const guildId = freshGuild();
  const file = dataPath(guildId, 'm', 'stuck.json');
  fs.mkdirSync(file, { recursive: true });
  saveData('stuck.json', { guildId, category: 'm' }, { v: 1 });
  return {
    file,
    cleanup: () => { dropPendingForGuild(guildId); fs.rmSync(dataPath(guildId), { recursive: true, force: true }); },
  };
}

/** Two postgres-routed guilds on one scripted store, hydrated and ready. */
async function twoStoreGuilds() {
  setBackendKind('postgres');
  const store = new FakeStore();
  const ws = initWorkingSet(store);
  const a = freshGuild();
  const b = freshGuild();
  expect(await ws.hydrate(a, tokenFor())).toBe('ready');
  expect(await ws.hydrate(b, tokenFor())).toBe('ready');
  return { store, a, b };
}

const contentRefusal = { ok: false as const, reason: 'unavailable' as const, detail: 'SQLSTATE 22P05: unsupported Unicode escape sequence', code: '22P05' };

describe('ruling L: a change the database refuses for its content', () => {
  it('the database answers and three passes leave a guild held: the guild is logged with its reason, reported as held, and the restart is asked', async () => {
    const { store, options, guildId } = await storeGuild();
    vi.spyOn(store, 'flushGuild').mockResolvedValue({ ok: false, reason: 'unavailable', detail: 'SQLSTATE 22P05: unsupported Unicode escape sequence', code: '22P05' });
    saveData('nul.json', options, { v: 1 });
    const { at } = watchedDatabase('answers');
    await at(0);
    closeMaintenanceGate('hook', 'm');
    await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'c1', data: {} });
    await vi.waitFor(() => expect(restarts()).toHaveLength(1), { timeout: 10_000 });
    const held = sent.findIndex(m => m.type === 'maintenance:mode' && m.data.mode === 'held');
    expect(sent[held]).toEqual({ type: 'maintenance:mode', data: { mode: 'held', held: { unsavedGuilds: 1, unsavedFiles: 0 } } });
    expect(held).toBeLessThan(sent.findIndex(m => m.type === 'control:restart-bot'));
    const logged = errorsWith(`guild ${guildId} (`);
    expect(logged).toHaveLength(1);
    expect(String(logged[0][0])).toContain('SQLSTATE 22P05: unsupported Unicode escape sequence');
    expect(String(logged[0][0])).toContain('3 saves in a row');
    expect(getWorkingSet()!.dirtyGuildIds()).toContain(guildId);
    expect(getWorkingSet()!.heldGuilds()).toEqual([{ guildId, reason: 'SQLSTATE 22P05: unsupported Unicode escape sequence', code: '22P05' }]);
  }, 20_000);

  it('R5-1: a failure that is not about the content (53100, disk full) keeps the leave step waiting while the database answers', async () => {
    const { store, options, guildId } = await storeGuild();
    vi.spyOn(store, 'flushGuild').mockResolvedValue({ ok: false, reason: 'unavailable', detail: 'SQLSTATE 53100: could not extend file', code: '53100' });
    saveData('full.json', options, { v: 1 });
    const { at } = watchedDatabase('answers');
    await at(0);
    closeMaintenanceGate('hook', 'm');
    await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'd1', data: {} });
    await vi.waitFor(() => expect(retryWarnings()).toBeGreaterThanOrEqual(6), { timeout: 10_000 });
    expect(restarts()).toHaveLength(0);
    expect(sent).toContainEqual({ type: 'maintenance:mode', data: { mode: 'held', held: { unsavedGuilds: 1, unsavedFiles: 0 } } });
    expect(errorsWith('drops these changes')).toHaveLength(0);
    expect(getWorkingSet()!.dirtyGuildIds()).toContain(guildId);
  }, 20_000);

  it('R5-5: an unreachable pass starts the count again: answers, answers, unreachable, answers asks no restart; two more answered passes do', async () => {
    _setMaintenanceTiming({ leaveRetryMs: 400 });
    const { store, options } = await storeGuild();
    vi.spyOn(store, 'flushGuild').mockResolvedValue({ ok: false, reason: 'unavailable', detail: 'SQLSTATE 22P05: unsupported Unicode escape sequence', code: '22P05' });
    saveData('reset.json', options, { v: 1 });
    const { at } = watchedDatabase('answers');
    await at(0);
    closeMaintenanceGate('hook', 'm');
    await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'n1', data: {} });
    const poll = { timeout: 10_000, interval: 5 };
    await vi.waitFor(() => expect(retryWarnings()).toBe(2), poll);
    await at(1_000, 'unreachable');
    await vi.waitFor(() => expect(retryWarnings()).toBe(3), poll);
    await at(2_000, 'answers');
    await vi.waitFor(() => expect(retryWarnings()).toBe(4), poll);
    expect(restarts()).toHaveLength(0);
    await vi.waitFor(() => expect(restarts()).toHaveLength(1), poll);
    expect(retryWarnings()).toBe(5);
  }, 20_000);

  it('while the watcher says unreachable or refused the leave step waits, however many passes fail; once the database answers it counts', async () => {
    const { store, options, guildId } = await storeGuild();
    store.mode = 'unavailable';
    saveData('wait.json', options, { v: 1 });
    const { at } = watchedDatabase('unreachable');
    await at(0);
    closeMaintenanceGate('hook', 'm');
    await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'w1', data: {} });
    await vi.waitFor(() => expect(retryWarnings()).toBeGreaterThanOrEqual(5), { timeout: 10_000 });
    await at(5_000, 'refused');
    const seen = retryWarnings();
    await vi.waitFor(() => expect(retryWarnings()).toBeGreaterThanOrEqual(seen + 5), { timeout: 10_000 });
    expect(restarts()).toHaveLength(0);
    expect(sent.some(m => m.type === 'maintenance:mode' && m.data.mode === 'held')).toBe(false);
    expect(getWorkingSet()!.dirtyGuildIds()).toContain(guildId);
    vi.spyOn(store, 'flushGuild').mockResolvedValue({ ok: false, reason: 'unavailable', detail: 'SQLSTATE 22P05: unsupported Unicode escape sequence', code: '22P05' });
    await at(10_000, 'answers');
    await vi.waitFor(() => expect(restarts()).toHaveLength(1), { timeout: 10_000 });
    const dropped = errorsWith('refuses for their content');
    expect(dropped).toHaveLength(1);
    expect(String(dropped[0][0])).toContain(`guild ${guildId} (SQLSTATE 22P05`);
  }, 30_000);

  it('a guild saved once the database answers needs no give-up: the restart comes with nothing held', async () => {
    const { store, options, guildId } = await storeGuild();
    store.mode = 'unavailable';
    saveData('late.json', options, { v: 1 });
    const { at } = watchedDatabase('unreachable');
    await at(0);
    closeMaintenanceGate('hook', 'm');
    await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'w2', data: {} });
    await vi.waitFor(() => expect(retryWarnings()).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    store.mode = 'commit';
    await at(5_000, 'answers');
    await vi.waitFor(() => expect(restarts()).toHaveLength(1), { timeout: 10_000 });
    expect(getWorkingSet()!.dirtyGuildIds()).not.toContain(guildId);
    expect(errorsWith(`guild ${guildId} (`)).toHaveLength(0);
  }, 20_000);

  it('R6-2: guild A refused for its content and guild B failing with 53100 keep the leave step waiting while the database answers', async () => {
    const { store, a, b } = await twoStoreGuilds();
    vi.spyOn(store, 'flushGuild').mockImplementation(async (guildId: string) => guildId === a
      ? contentRefusal
      : { ok: false, reason: 'unavailable', detail: 'SQLSTATE 53100: could not extend file', code: '53100' });
    saveData('a.json', { guildId: a, category: 'm' }, { v: 1 });
    saveData('b.json', { guildId: b, category: 'm' }, { v: 1 });
    const { at } = watchedDatabase('answers');
    await at(0);
    closeMaintenanceGate('hook', 'm');
    await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'g1', data: {} });
    await vi.waitFor(() => expect(retryWarnings()).toBeGreaterThanOrEqual(6), { timeout: 10_000 });
    expect(restarts()).toHaveLength(0);
    expect(sent).toContainEqual({ type: 'maintenance:mode', data: { mode: 'held', held: { unsavedGuilds: 2, unsavedFiles: 0 } } });
    expect(getWorkingSet()!.dirtyGuildIds()).toEqual(expect.arrayContaining([a, b]));
  }, 20_000);

  it('R6-2: a held guild whose save has not failed yet blocks the give-up', async () => {
    const { store, a, b } = await twoStoreGuilds();
    vi.spyOn(store, 'flushGuild').mockImplementation((guildId: string) => guildId === a
      ? Promise.resolve(contentRefusal)
      : new Promise(() => undefined));
    saveData('a.json', { guildId: a, category: 'm' }, { v: 1 });
    saveData('b.json', { guildId: b, category: 'm' }, { v: 1 });
    const { at } = watchedDatabase('answers');
    await at(0);
    closeMaintenanceGate('hook', 'm');
    await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'g2', data: {} });
    await vi.waitFor(() => expect(retryWarnings()).toBeGreaterThanOrEqual(6), { timeout: 10_000 });
    expect(getWorkingSet()!.heldGuilds().find(g => g.guildId === b)?.code).toBeNull();
    expect(restarts()).toHaveLength(0);
  }, 20_000);

  it('R6-2: a guild refused for its content together with a file that cannot be written asks no restart', async () => {
    const { store, options, guildId } = await storeGuild();
    vi.spyOn(store, 'flushGuild').mockResolvedValue(contentRefusal);
    saveData('nul.json', options, { v: 1 });
    const file = dataPath('global', 'm', 'r6stuck.json');
    fs.mkdirSync(file, { recursive: true });
    try {
      saveData('r6stuck.json', { scope: 'global', category: 'm' }, { v: 1 });
      const { at } = watchedDatabase('answers');
      await at(0);
      closeMaintenanceGate('hook', 'm');
      await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'g3', data: {} });
      await vi.waitFor(() => expect(retryWarnings()).toBeGreaterThanOrEqual(6), { timeout: 10_000 });
      expect(restarts()).toHaveLength(0);
      expect(sent).toContainEqual({ type: 'maintenance:mode', data: { mode: 'held', held: { unsavedGuilds: 1, unsavedFiles: 1 } } });
      expect(getWorkingSet()!.dirtyGuildIds()).toContain(guildId);
    } finally {
      dropPendingForGuild('global');
      fs.rmSync(file, { recursive: true, force: true });
    }
  }, 20_000);

  it('R6-1: once the held guilds failed for their content, the held log says the database refuses them and the restart that drops them follows', async () => {
    const { store, a, b } = await twoStoreGuilds();
    let bCalls = 0;
    vi.spyOn(store, 'flushGuild').mockImplementation(async (guildId: string) => {
      if (guildId === a) return contentRefusal;
      bCalls += 1;
      return bCalls === 1 ? { ok: false, reason: 'unavailable', detail: 'timeout exceeded when trying to connect' } : { ok: true };
    });
    saveData('a.json', { guildId: a, category: 'm' }, { v: 1 });
    saveData('b.json', { guildId: b, category: 'm' }, { v: 1 });
    const { at } = watchedDatabase('answers');
    await at(0);
    closeMaintenanceGate('hook', 'm');
    await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'g4', data: {} });
    await vi.waitFor(() => expect(restarts()).toHaveLength(1), { timeout: 10_000 });
    expect(errorsWith('does not restart until')).toHaveLength(0);
    const held = errorsWith('the database refuses these for their content');
    expect(held).toHaveLength(1);
    expect(String(held[0][0])).toContain('after 3 saves in a row that fail this way it restarts and drops them');
    expect(errorsWith('drops these changes')).toHaveLength(1);
  }, 20_000);

  it('a file that cannot be written keeps the leave step waiting: held is reported with the file named, and no restart is asked', async () => {
    const { file, cleanup } = stuckFile();
    try {
      closeMaintenanceGate('hook', 'm');
      await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'f1', data: {} });
      await vi.waitFor(() => expect(sent).toContainEqual({ type: 'maintenance:mode', data: { mode: 'held', held: { unsavedGuilds: 0, unsavedFiles: 1 } } }), { timeout: 10_000 });
      const logged = errorsWith(file);
      expect(logged).toHaveLength(1);
      expect(String(logged[0][0])).toContain('stays in maintenance');
      const seen = retryWarnings();
      await vi.waitFor(() => expect(retryWarnings()).toBeGreaterThanOrEqual(seen + 3), { timeout: 10_000 });
      expect(restarts()).toHaveLength(0);
    } finally {
      cleanup();
    }
  }, 20_000);
});

describe('ruling M: the held report', () => {
  it('R4-4: a repeated hook while the leave step is held keeps the held report', async () => {
    const { cleanup } = stuckFile();
    try {
      closeMaintenanceGate('hook', 'm');
      await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'r1', data: {} });
      await vi.waitFor(() => expect(maintenanceMode()).toBe('held'), { timeout: 10_000 });
      await handleMaintenanceIpc({ type: 'maintenance:enter', requestId: 'r2', data: { message: 'again' } });
      expect(maintenanceMode()).toBe('held');
      expect(sent.filter(m => m.type === 'maintenance:mode').at(-1)).toEqual({ type: 'maintenance:mode', data: { mode: 'held', held: { unsavedGuilds: 0, unsavedFiles: 1 } } });
      expect(maintenanceText()).toBe('again');
    } finally {
      cleanup();
    }
  }, 20_000);

  it('R4-6: off Discord after an outage, the held log says the bot stays off Discord, not in maintenance', async () => {
    const { file, cleanup } = stuckFile();
    try {
      const { at, disconnect } = watchedDatabase('unreachable');
      await at(0);
      await at(300_000);
      expect(disconnect).toHaveBeenCalledTimes(1);
      await at(305_000, 'answers');
      await vi.waitFor(() => expect(errorsWith(file)).toHaveLength(1), { timeout: 10_000 });
      const line = String(errorsWith(file)[0][0]);
      expect(line).toContain('stays off Discord');
      expect(line).not.toContain('maintenance');
      expect(restarts()).toHaveLength(0);
    } finally {
      cleanup();
    }
  }, 20_000);
  it('R6-4: off Discord after an outage and then in maintenance, the held log says the bot stays off Discord (in maintenance)', async () => {
    const { file, cleanup } = stuckFile();
    try {
      const { at, disconnect } = watchedDatabase('unreachable');
      await at(0);
      await at(300_000);
      expect(disconnect).toHaveBeenCalledTimes(1);
      closeMaintenanceGate('hook', 'm');
      await at(305_000, 'answers');
      await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'o1', data: {} });
      await vi.waitFor(() => expect(errorsWith(file)).toHaveLength(1), { timeout: 10_000 });
      expect(String(errorsWith(file)[0][0])).toContain('the bot process stays off Discord (in maintenance)');
    } finally {
      cleanup();
    }
  }, 20_000);
});

describe('ruling C: metrics', () => {
  it('entering maintenance flushes the metric totals before guild writes are refused', async () => {
    let gateWhenFlushed: boolean | null = null;
    const flush = vi.spyOn(getMetricsCollector(), 'flushTotals').mockImplementation(() => { gateWhenFlushed = isMaintenanceGateClosed(); });
    await enterMaintenance('m');
    expect(flush).toHaveBeenCalledTimes(1);
    expect(gateWhenFlushed).toBe(false);
    await enterMaintenance('again');
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('a hook before the totals are seeded leaves the persisted totals as they are', async () => {
    const { saveGlobalModuleData, loadGlobalModuleData } = await import('../../src/bot/internalSetup/utils/dataManager');
    expect(getMetricsCollector().isEnabled()).toBe(true);
    saveGlobalModuleData('totals.json', 'metrics', { v: 1, updatedAt: 1, globalDataBytes: 123, modules: { m: {} } });
    await enterMaintenance('m');
    await tick(50);
    const totals = loadGlobalModuleData<any>('totals.json', 'metrics', null);
    expect(totals.globalDataBytes).toBe(123);
    expect(totals.modules).toEqual({ m: {} });
  });
});

describe('ruling G: a hook during boot', () => {
  it('after the listener is installed, a file that now says maintenance closes the gate with cause hook', () => {
    setupMaintenanceIPCAtBoot();
    expect(isMaintenanceGateClosed()).toBe(false);
    writeMaintenanceFile('maintenance', 'Written during the boot.');
    setupMaintenanceIPCAtBoot();
    expect(isMaintenanceGateClosed()).toBe(true);
    expect(maintenanceCause()).toBe('hook');
    expect(maintenanceText()).toBe('Written during the boot.');
  });

  it('main reads the file before the data layer, installs the listener and reads it again before the data layer opens, and the clientReady handler checks the gate after the startup barrier', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/bot/internalSetup/clientInitializer.ts'), 'utf-8');
    const main = source.slice(source.indexOf('async function main()'));
    const decide = main.indexOf('await decideBoot()');
    const listen = main.indexOf('setupMaintenanceIPCAtBoot()');
    const open = main.indexOf('initDataBackendLayer()');
    expect(decide).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(decide);
    expect(open).toBeGreaterThan(listen);
    const ready = main.slice(main.indexOf("client.once('clientReady'"));
    const barrier = ready.indexOf('await awaitDataStartupBarrier()');
    expect(barrier).toBeGreaterThan(-1);
    expect(ready.indexOf('isMaintenanceGateClosed()', barrier)).toBeGreaterThan(barrier);
    expect(ready.indexOf('isMaintenanceGateClosed()', barrier)).toBeLessThan(ready.indexOf('runInitializers(client)'));
  });

  it('the shutdown skips the metric totals while the gate is closed', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/bot/internalSetup/clientInitializer.ts'), 'utf-8');
    expect(source).toContain('if (!isMaintenanceGateClosed()) metrics.flushTotals();');
  });
});

describe('ruling I: a maintenance refusal that module code does not catch', () => {
  const refusal = () => new DataBackendUnavailableError('maintenance');

  it('closing the gate installs the guard on both process events', () => {
    expect(process.listeners('uncaughtException')).not.toContain(guardUncaught);
    closeMaintenanceGate('hook', 'm');
    expect(process.listeners('uncaughtException')).toContain(guardUncaught);
    expect(process.listeners('unhandledRejection')).toContain(guardRejection);
    _resetMaintenance();
    expect(process.listeners('uncaughtException')).not.toContain(guardUncaught);
    expect(process.listeners('unhandledRejection')).not.toContain(guardRejection);
  });

  it('while the gate is closed the refusal is logged and the process goes on', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    closeMaintenanceGate('hook', 'm');
    guardUncaught(refusal());
    expect(() => guardRejection(refusal())).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
    expect(error.mock.calls.some(c => String(c[0]).startsWith('[Maintenance]'))).toBe(true);
  });

  it('any other error ends the process with exit code 1, as without the guard', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    closeMaintenanceGate('hook', 'm');
    guardUncaught(new Error('a module bug'));
    expect(exit).toHaveBeenCalledWith(1);
    const other = new DataBackendUnavailableError('database-backlog');
    expect(() => guardRejection(other)).toThrow(other);
  });
});
