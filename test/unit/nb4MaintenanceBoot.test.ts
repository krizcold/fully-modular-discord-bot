import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB4 decision 22: a Postgres maintenance boot connects the shards of its record. This file marks its process as
// booted in maintenance, so it holds only these cases.

const stops = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<object>()),
  stopProcess: () => { stops.calls += 1; },
}));

import fs from 'fs';
import path from 'path';
import { setBackendKind } from '../helpers/backendKind';
import { shardRecordPath } from '../../src/bot/internalSetup/fleet/shardRecord';
import { maintenanceFilePath, writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import {
  _resetMaintenance,
  _setMaintenanceSender,
  _setMaintenanceTiming,
  runMaintenanceBoot,
} from '../../src/bot/internalSetup/utils/maintenance';

const sent: any[] = [];
let logs: string[] = [];
const realSend = process.send;
beforeEach(() => {
  // vitest's fork has an IPC channel; a bot run with no web UI has none.
  (process as { send?: unknown }).send = undefined;
  sent.length = 0;
  stops.calls = 0;
  logs = [];
  const capture = (...args: unknown[]) => { logs.push(String(args[0])); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});
afterEach(() => {
  (process as { send?: unknown }).send = realSend;
  _resetMaintenance();
  _setMaintenanceSender(null);
  vi.restoreAllMocks();
});

const withIpc = () => _setMaintenanceSender(message => { sent.push(message); });

describe('the Postgres maintenance boot', () => {
  it.each(['hook', 'login-refused'] as const)('cause %s connects exactly the shard record\'s shards under its count', async cause => {
    setBackendKind('postgres');
    withIpc();
    _setMaintenanceTiming({ filePollMs: 600_000 });
    let loggedIn: any = null;
    const client = await runMaintenanceBoot({ cause, message: 'm' }, {
      shardRecord: () => ({ shardCount: 4, shardIds: [3, 1], processId: 'p', at: '' }),
      login: async c => { loggedIn = c; },
      loginProbe: async () => 'refused',
      retryMs: 600_000,
    });
    expect(loggedIn).toBe(client);
    expect(client!.options.shards).toEqual([1, 3]);
    expect(client!.options.shardCount).toBe(4);
    expect(logs).toContain('[Maintenance] Booting in maintenance mode on shard(s) 1, 3 of 4, the shards this machine served at its last start');
    void client!.destroy();
  });

  it.each([
    ['an empty record', { shardCount: 4, shardIds: [], processId: 'p', at: '' }, '[Maintenance] Booting in maintenance mode with no shard: this machine served none at its last start'],
    ['no record', null, '[Maintenance] Booting in maintenance mode with no shard: this machine has no record of the shards it served'],
  ])('%s builds no Client and logs in nothing', async (_name, record, line) => {
    setBackendKind('postgres');
    withIpc();
    _setMaintenanceTiming({ filePollMs: 600_000 });
    const login = vi.fn(async () => undefined);
    expect(await runMaintenanceBoot({ cause: 'hook', message: 'm' }, { shardRecord: () => record, login })).toBeNull();
    expect(login).not.toHaveBeenCalled();
    expect(logs).toContain(line);
  });

  it.each([
    ['unreadable (not JSON)', () => fs.writeFileSync(shardRecordPath(), '{not json')],
    ['a read that throws (the path is a folder)', () => fs.mkdirSync(shardRecordPath(), { recursive: true })],
  ])('a record %s builds no Client, logs in nothing, and watchLogin and the file poll still run', async (_name, plant) => {
    fs.rmSync(shardRecordPath(), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(shardRecordPath()), { recursive: true });
    plant();
    setBackendKind('postgres');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      _setMaintenanceTiming({ filePollMs: 1000 });
      const login = vi.fn(async () => undefined);
      const probe = vi.fn(async () => 'refused' as const);
      expect(await runMaintenanceBoot({ cause: 'login-refused', message: 'm' }, { login, loginProbe: probe, retryMs: 1000 })).toBeNull();
      expect(login).not.toHaveBeenCalled();
      expect(logs).toContain('[Maintenance] Booting in maintenance mode with no shard: this machine has no record of the shards it served');
      await vi.advanceTimersByTimeAsync(3000);
      expect(probe.mock.calls.length).toBeGreaterThanOrEqual(2);
      _resetMaintenance();
      _setMaintenanceTiming({ filePollMs: 1000 });
      writeMaintenanceFile('maintenance', 'm');
      expect(await runMaintenanceBoot({ cause: 'hook', message: 'm' }, { login })).toBeNull();
      expect(login).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3000);
      expect(stops.calls).toBe(0);
      writeMaintenanceFile('running', 'm');
      await vi.advanceTimersByTimeAsync(2000);
      expect(logs).toContain('[Maintenance] maintenance.json says running; saving what this process holds before it stops (no web UI process runs to restart it)');
      expect(stops.calls).toBe(1);
    } finally {
      vi.useRealTimers();
      fs.rmSync(shardRecordPath(), { recursive: true, force: true });
      fs.rmSync(maintenanceFilePath(), { force: true });
    }
  });

  it('a JSON maintenance boot logs in every shard', async () => {
    setBackendKind('file');
    withIpc();
    _setMaintenanceTiming({ filePollMs: 600_000 });
    const client = await runMaintenanceBoot({ cause: 'hook', message: 'm' }, { shards: async () => 3, login: async () => undefined });
    expect(client!.options.shards).toEqual([0, 1, 2]);
    void client!.destroy();
  });
});

