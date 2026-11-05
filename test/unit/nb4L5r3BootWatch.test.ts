import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Ruling 6 and NB4 decision 22: a maintenance boot runs no data backend, so a refused login reported to the run-time
// watcher in that process changes nothing: no 28000 line, no gate change, no leave and no stop.

const h = vi.hoisted(() => ({ stops: 0 }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    stopProcess: () => { h.stops += 1; },
    saveHeldWrites: async () => ({ unsavedGuilds: 0, unsavedFiles: 0 }),
  };
});

import { _resetMaintenance, _setMaintenanceSender, leaveRestartAsked, watchDataBackend } from '../../src/bot/internalSetup/utils/maintenance';
import { maintenanceCause, markMaintenanceBoot, setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';

let logs: string[] = [];
const realSend = process.send;
beforeEach(() => {
  (process as { send?: unknown }).send = undefined;
  h.stops = 0;
  logs = [];
  const capture = (...args: unknown[]) => { logs.push(String(args[0])); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  markMaintenanceBoot();
});
afterEach(() => {
  (process as { send?: unknown }).send = realSend;
  _resetMaintenance();
  _setMaintenanceSender(null);
  vi.restoreAllMocks();
});

const settle = () => new Promise<void>(resolve => { setTimeout(resolve, 30); });

describe('the watcher in a maintenance boot', () => {
  it('ignores a refused login from the backend while the hook holds the gate', async () => {
    setMaintenanceGate({ cause: 'hook', message: 'Back soon' });
    let fire: (() => void) | null = null;
    watchDataBackend({ onLoginRefused: cb => { fire = cb; }, askDatabase: async () => 'answers' }, { retryMs: 600_000 });
    fire!();
    await settle();
    expect(maintenanceCause()).toBe('hook');
    expect(logs.filter(l => l.includes('SQLSTATE 28000'))).toEqual([]);
    expect(h.stops).toBe(0);
    expect(leaveRestartAsked()).toBe(false);
  });

  it('ignores a refused probe answer with the gate open', async () => {
    const watcher = watchDataBackend({ onLoginRefused: () => undefined, askDatabase: async () => 'refused' }, { retryMs: 600_000 });
    await watcher!.probeNow();
    await settle();
    expect(maintenanceCause()).toBeNull();
    expect(logs).toEqual([]);
    expect(h.stops).toBe(0);
  });
});
