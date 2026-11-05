import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB4 decisions 6, 15 and 16 in the bot process's maintenance code: the leave's restart request and its lines, a shard
// restart withdrawn once the gate closes, the claims lapse reported once, the IPC refusal of a process that stopped
// serving, and the watcher's line once a refused login is accepted again.

const h = vi.hoisted(() => ({
  stops: 0,
  ws: null as null | { takeDropLines(): string[]; heldGuilds(): unknown[] },
  save: null as null | (() => Promise<{ unsavedGuilds: number; unsavedFiles: number; unansweredGuilds: number; unconfirmedFiles: number }>),
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    stopProcess: () => { h.stops += 1; },
    saveHeldWrites: (...args: unknown[]) => (h.save ? h.save() : real.saveHeldWrites(...args)),
  };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => {
  const real = await orig<any>();
  return { ...real, getWorkingSet: () => h.ws ?? real.getWorkingSet() };
});

import fs from 'fs';
import { maintenanceFilePath, writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import {
  _resetMaintenance,
  _setMaintenanceSender,
  _setMaintenanceTiming,
  closeMaintenanceGate,
  leaveRestartAsked,
  maintenanceIpcRefusal,
  markDiscordStarted,
  noteClaimsLapsed,
  restartForShards,
  startLeave,
  watchDataBackend,
} from '../../src/bot/internalSetup/utils/maintenance';
import { maintenanceText } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { setStoppedServingHook, STOPPED_SERVING_TEXT } from '../../src/bot/internalSetup/utils/servingGate';

const sent: any[] = [];
let logs: string[] = [];
let errors: string[] = [];
const realSend = process.send;
beforeEach(() => {
  // vitest's fork has an IPC channel; a bot run with no web UI has none.
  (process as { send?: unknown }).send = undefined;
  sent.length = 0;
  h.stops = 0;
  logs = [];
  errors = [];
  const capture = (...args: unknown[]) => { logs.push(String(args[0])); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { capture(...args); errors.push(String(args[0])); });
});
afterEach(() => {
  vi.useRealTimers();
  (process as { send?: unknown }).send = realSend;
  h.ws = null;
  h.save = null;
  _resetMaintenance();
  _setMaintenanceSender(null);
  setStoppedServingHook(null);
  fs.rmSync(maintenanceFilePath(), { force: true });
  vi.restoreAllMocks();
});

const withIpc = () => _setMaintenanceSender(message => { sent.push(message); });
const restarts = () => sent.filter(m => m.type === 'control:restart-bot');

// First in the file: it reads the module's state as loaded, before any reset.
describe('a leave with no web UI process', () => {
  it("its own restart request reads as the leave's, as loaded and after a reset", async () => {
    startLeave('The hook says running');
    await vi.waitFor(() => expect(h.stops).toBe(1));
    expect(leaveRestartAsked()).toBe(true);
    _resetMaintenance();
    h.stops = 0;
    startLeave('The hook says running');
    await vi.waitFor(() => expect(h.stops).toBe(1));
    expect(leaveRestartAsked()).toBe(true);
  });
});

describe('the restart requests', () => {
  it("the leave's request logs the maintenance line, not the shards line", async () => {
    withIpc();
    startLeave('The hook says running');
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
    expect(restarts()[0]).toEqual({ type: 'control:restart-bot', data: { reason: 'The hook says running' } });
    expect(logs).toContain('[Maintenance] The hook says running; asking the web UI process to restart the bot process');
    expect(logs.some(l => l.startsWith('[Shards] Restarting'))).toBe(false);
  });

  it('a shard restart already sent answers true without asking fitness again or sending again', () => {
    withIpc();
    expect(restartForShards('take shard 3', () => null)).toBe(true);
    const fitness = vi.fn(() => 'a save is failing');
    expect(restartForShards('take shard 5', fitness)).toBe(true);
    expect(restarts()).toEqual([{ type: 'control:restart-bot', data: { reason: 'take shard 3' } }]);
  });

  it('a shard restart stops being re-sent once the gate closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    withIpc();
    _setMaintenanceTiming({ restartResendMs: 1000 });
    expect(restartForShards('take shard 3', () => null)).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(restarts()).toHaveLength(2);
    closeMaintenanceGate('login-refused', 'm');
    await vi.advanceTimersByTimeAsync(5000);
    expect(restarts()).toHaveLength(2);
    expect(logs.filter(l => l.endsWith('after asking for its restart; asking again'))).toHaveLength(1);
  });
});

describe('the claims lapse', () => {
  it('is reported once, and the leave names the first lapse', async () => {
    withIpc();
    markDiscordStarted();
    noteClaimsLapsed(20);
    noteClaimsLapsed(45);
    expect(sent.filter(m => m.type === 'maintenance:mode')).toEqual([{ type: 'maintenance:mode', data: { mode: 'outage' } }]);
    const watcher = watchDataBackend({ onLoginRefused: () => undefined, askDatabase: async () => 'answers' }, { retryMs: 600_000 });
    await watcher!.probeNow();
    expect(logs).toContain('[Maintenance] The shard claims lapsed (no renewal for 20 s) and the database answers; saving what this process holds before it restarts');
  });
});

describe('the IPC refusal of a process that stopped serving', () => {
  it('refuses module code and panel requests, and lets data requests through to their own answers', () => {
    setStoppedServingHook(() => true);
    expect(maintenanceIpcRefusal('panel:open')).toEqual({ success: false, error: STOPPED_SERVING_TEXT });
    expect(maintenanceIpcRefusal('command:invoke')).toEqual({ success: false, error: STOPPED_SERVING_TEXT });
    expect(maintenanceIpcRefusal('data:guild-read')).toBeNull();
    expect(maintenanceIpcRefusal('data:guild-write')).toBeNull();
    expect(maintenanceIpcRefusal('fleet:status')).toBeNull();
    closeMaintenanceGate('hook', 'Back soon');
    expect(maintenanceIpcRefusal('data:guild-write')).toEqual({ ok: false, code: 'maintenance', error: maintenanceText() });
  });
});

describe("the leave's dropped-change lines", () => {
  it('logs no error line when there is no working set', async () => {
    withIpc();
    startLeave('The hook says running');
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
    expect(errors).toEqual([]);
  });

  it("logs each line the working set gives before it asks for the restart", async () => {
    withIpc();
    h.ws = { takeDropLines: () => ['[Maintenance] Dropped the changes of guild 1 (22P02)'], heldGuilds: () => [] };
    h.save = async () => ({ unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 });
    startLeave('The hook says running');
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
    expect(errors).toEqual(['[Maintenance] Dropped the changes of guild 1 (22P02)']);
  });
});

describe('the watcher after a refused login', () => {
  it('says once that the login is accepted again while the file says maintenance', async () => {
    writeMaintenanceFile('maintenance', 'm');
    markDiscordStarted();
    let answer: 'refused' | 'answers' = 'refused';
    const watcher = watchDataBackend({ onLoginRefused: () => undefined, askDatabase: async () => answer }, { retryMs: 600_000 });
    await watcher!.probeNow();
    answer = 'answers';
    await watcher!.probeNow();
    await watcher!.probeNow();
    const line = '[Maintenance] The database accepted the login again; the bot stays in maintenance until the hook says running';
    expect(logs.filter(l => l === line)).toHaveLength(1);
  });
});
