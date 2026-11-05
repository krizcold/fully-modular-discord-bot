import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB4 decisions 15, 16 and 22 in a serving bot process: the maintenance.json poll runs only under the hook and stops
// once the leave starts, the restart is asked once and re-sent with its reason, and the watcher's bound and lines.

const h = vi.hoisted(() => ({
  reads: 0,
  save: null as null | (() => Promise<{ unsavedGuilds: number; unsavedFiles: number }>),
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    stopProcess: () => undefined,
    saveHeldWrites: (...args: unknown[]) => (h.save ? h.save() : real.saveHeldWrites(...args)),
  };
});
vi.mock('../../src/utils/maintenanceFile', async orig => {
  const real = await orig<any>();
  return { ...real, readMaintenanceFile: () => { h.reads += 1; return real.readMaintenanceFile(); } };
});

import fs from 'fs';
import { maintenanceFilePath, writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import {
  _resetMaintenance,
  _setMaintenanceSender,
  _setMaintenanceTiming,
  closeMaintenanceGate,
  leaveRestartAsked,
  restartForShards,
  startLeave,
  watchDataBackend,
  type DatabaseAnswer,
} from '../../src/bot/internalSetup/utils/maintenance';
import { isMaintenanceGateClosed, maintenanceCause } from '../../src/bot/internalSetup/utils/maintenanceGate';

const sent: any[] = [];
let logs: string[] = [];
const realSend = process.send;
const NEVER = 600_000;
const ACCEPTED_LINE = '[Maintenance] The database accepted the login again; the bot stays in maintenance until the hook says running';
const POLL_LEAVE_LINE = 'maintenance.json says running; saving what this process holds';

beforeEach(() => {
  (process as { send?: unknown }).send = undefined;
  sent.length = 0;
  h.reads = 0;
  h.save = null;
  logs = [];
  const capture = (...args: unknown[]) => { logs.push(String(args[0])); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  _setMaintenanceSender(message => { sent.push(message); });
});
afterEach(() => {
  vi.useRealTimers();
  (process as { send?: unknown }).send = realSend;
  h.save = null;
  _resetMaintenance();
  _setMaintenanceSender(null);
  fs.rmSync(maintenanceFilePath(), { force: true });
  vi.restoreAllMocks();
});

const restarts = () => sent.filter(m => m.type === 'control:restart-bot');
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
const pending = () => new Promise<{ unsavedGuilds: number; unsavedFiles: number }>(() => undefined);
const settle = () => new Promise<void>(resolve => { setTimeout(resolve, 20); });

describe('the maintenance.json poll', () => {
  it('a gate closed for a refused login starts no poll; the hook that follows starts it from its own entry', async () => {
    fakeTimers();
    _setMaintenanceTiming({ filePollMs: 1000 });
    h.save = pending;
    closeMaintenanceGate('login-refused', 'm');
    await vi.advanceTimersByTimeAsync(600);
    closeMaintenanceGate('hook', 'm');
    writeMaintenanceFile('running', 'm');
    await vi.advanceTimersByTimeAsync(500);
    expect(logs.some(line => line.includes(POLL_LEAVE_LINE))).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(logs.some(line => line.includes(POLL_LEAVE_LINE))).toBe(true);
  });

  it('stops reading maintenance.json once the leave starts', async () => {
    fakeTimers();
    _setMaintenanceTiming({ filePollMs: 1000 });
    h.save = pending;
    closeMaintenanceGate('hook', 'm');
    writeMaintenanceFile('running', 'm');
    await vi.advanceTimersByTimeAsync(1000);
    expect(logs.some(line => line.includes(POLL_LEAVE_LINE))).toBe(true);
    expect(maintenanceCause()).toBe('hook');
    const readsAtLeave = h.reads;
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.reads).toBe(readsAtLeave);
  });
});

describe('the restart request', () => {
  it('a shard restart asked during a leave is the one request; the leave asks no second time', async () => {
    let finish!: (left: { unsavedGuilds: number; unsavedFiles: number }) => void;
    h.save = () => new Promise(resolve => { finish = resolve; });
    startLeave('The hook says running');
    expect(restartForShards('take shard 2', () => null)).toBe(true);
    expect(restarts()).toEqual([{ type: 'control:restart-bot', data: { reason: 'take shard 2' } }]);
    finish({ unsavedGuilds: 0, unsavedFiles: 0 });
    await settle();
    expect(restarts()).toHaveLength(1);
    expect(leaveRestartAsked()).toBe(false);
    expect(logs.filter(line => line.includes('asking the web UI process to restart the bot process'))).toEqual([]);
  });

  it('is sent again with its reason, and the line names the wait in seconds', async () => {
    fakeTimers();
    _setMaintenanceTiming({ restartResendMs: 2000 });
    expect(restartForShards('take shard 2', () => null)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(restarts()).toEqual([
      { type: 'control:restart-bot', data: { reason: 'take shard 2' } },
      { type: 'control:restart-bot', data: { reason: 'take shard 2' } },
    ]);
    expect(logs).toContain('[Maintenance] The bot process still runs 2 s after asking for its restart; asking again');
  });
});

function backend(ask: () => Promise<DatabaseAnswer>) {
  const fired: Array<() => void> = [];
  return { fired, onLoginRefused: (cb: () => void) => { fired.push(cb); }, askDatabase: ask };
}

describe('the database watcher', () => {
  it('a probe that hangs answers unreachable at the given bound', async () => {
    fakeTimers();
    const watcher = watchDataBackend(backend(() => new Promise<DatabaseAnswer>(() => undefined)), { retryMs: NEVER, probeTimeoutMs: 50 })!;
    let done = false;
    void watcher.probeNow().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(60);
    expect(done).toBe(true);
    expect(isMaintenanceGateClosed()).toBe(false);
  });

  it('with no bound given, a refusal that takes 100 ms still closes the gate', async () => {
    fakeTimers();
    h.save = pending;
    writeMaintenanceFile('maintenance', 'kept message');
    const slowRefusal = () => new Promise<DatabaseAnswer>(resolve => { setTimeout(() => resolve('refused'), 100); });
    const watcher = watchDataBackend(backend(slowRefusal), { retryMs: NEVER })!;
    const probe = watcher.probeNow();
    await vi.advanceTimersByTimeAsync(150);
    await probe;
    expect(maintenanceCause()).toBe('login-refused');
  });

  it('logs the accepted login once when the gate was already closed for a refused login', async () => {
    closeMaintenanceGate('login-refused', 'm');
    writeMaintenanceFile('maintenance', 'm');
    const watcher = watchDataBackend(backend(async () => 'answers'), { retryMs: NEVER })!;
    await watcher.probeNow();
    await watcher.probeNow();
    expect(logs.filter(line => line === ACCEPTED_LINE)).toHaveLength(1);
  });

  it('a leave already under way takes no answer: no accepted line', async () => {
    h.save = async () => ({ unsavedGuilds: 0, unsavedFiles: 0 });
    writeMaintenanceFile('maintenance', 'm');
    const b = backend(async () => 'answers');
    const watcher = watchDataBackend(b, { retryMs: NEVER })!;
    b.fired[0]();
    await settle();
    expect(restarts()).toHaveLength(1);
    expect(maintenanceCause()).toBe('login-refused');
    await watcher.probeNow();
    expect(logs).not.toContain(ACCEPTED_LINE);
  });
});
