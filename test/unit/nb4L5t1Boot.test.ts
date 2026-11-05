import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB4 decision 22 and ruling 6 in a maintenance boot: its boot line, its IPC listener and answers, the refusal guard,
// the maintenance.json poll under the hook only, and the Client it builds. This file marks its process as booted in
// maintenance, so it holds only these cases.

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<object>()),
  stopProcess: () => undefined,
}));

import fs from 'fs';
import { GatewayIntentBits, IntentsBitField, type Client } from 'discord.js';
import { setBackendKind } from '../helpers/backendKind';
import { maintenanceFilePath, writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import {
  _resetMaintenance,
  _setMaintenanceSender,
  _setMaintenanceTiming,
  guardRejection,
  guardUncaught,
  handleMaintenanceIpc,
  runMaintenanceBoot,
} from '../../src/bot/internalSetup/utils/maintenance';

const sent: any[] = [];
let logs: string[] = [];
const realSend = process.send;
const envKeys = ['SHARDS', 'SHARD_COUNT'] as const;
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const clients: Client[] = [];
const HOOK_LINE = '[Maintenance] Booting in maintenance mode: the saved state says maintenance';
const REFUSED_LINE = '[Maintenance] Booting in maintenance mode: the database refused the login';
const POLL_LEAVE_LINE = 'maintenance.json says running; saving what this process holds';

beforeEach(() => {
  (process as { send?: unknown }).send = undefined;
  sent.length = 0;
  logs = [];
  const capture = (...args: unknown[]) => { logs.push(String(args[0])); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  _setMaintenanceSender(message => { sent.push(message); });
});
afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) await client.destroy();
  (process as { send?: unknown }).send = realSend;
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  _resetMaintenance();
  _setMaintenanceSender(null);
  setBackendKind(null);
  fs.rmSync(maintenanceFilePath(), { force: true });
  vi.restoreAllMocks();
});

const noShard = { shardRecord: () => ({ shardCount: 4, shardIds: [], processId: 'p', at: '' }), loginProbe: async () => 'refused' as const, retryMs: 600_000 };

async function bootNoShard(cause: 'hook' | 'login-refused') {
  setBackendKind('postgres');
  _setMaintenanceTiming({ filePollMs: 600_000 });
  expect(await runMaintenanceBoot({ cause, message: 'm' }, noShard)).toBeNull();
}

describe('the boot line', () => {
  it('names the saved state for a boot the hook caused', async () => {
    await bootNoShard('hook');
    expect(logs).toContain(HOOK_LINE);
    expect(logs).not.toContain(REFUSED_LINE);
  });

  it('names the refused login for a boot the database caused', async () => {
    await bootNoShard('login-refused');
    expect(logs).toContain(REFUSED_LINE);
    expect(logs).not.toContain(HOOK_LINE);
  });
});

describe('what the boot installs', () => {
  it('the refusal guard, so an uncaught maintenance refusal does not end the process', async () => {
    await bootNoShard('hook');
    expect(process.listeners('uncaughtException')).toContain(guardUncaught);
    expect(process.listeners('unhandledRejection')).toContain(guardRejection);
  });

  it('an IPC listener that answers a data read with the maintenance refusal (beside the shared-op listener)', async () => {
    (process as { send?: unknown }).send = () => true;
    const before = process.listeners('message');
    try {
      await bootNoShard('hook');
      const added = process.listeners('message').filter(listener => !before.includes(listener));
      expect(added).toHaveLength(2);
      for (const listener of added) (listener as (message: unknown) => void)({ type: 'data:guild-read', requestId: 'r1' });
      await vi.waitFor(() => expect(sent.some(m => m.requestId === 'r1')).toBe(true));
      expect(sent.filter(m => m.requestId === 'r1')).toHaveLength(1);
      expect(sent.find(m => m.requestId === 'r1')).toStrictEqual({
        requestId: 'r1',
        data: { ok: false, code: 'maintenance', error: 'the bot is in maintenance' },
      });
    } finally {
      for (const listener of process.listeners('message')) {
        if (!before.includes(listener)) process.off('message', listener);
      }
    }
  });
});

describe('IPC answers in a maintenance boot', () => {
  it('data:guild-read is refused as a data read, with no success field', async () => {
    await bootNoShard('hook');
    const reply = await handleMaintenanceIpc({ type: 'data:guild-read', requestId: 'q' });
    expect(reply).toStrictEqual({ requestId: 'q', data: { ok: false, code: 'maintenance', error: 'the bot is in maintenance' } });
  });

  it('data:global-read is left to the shared handler, which answers it with the same refusal (NB10)', async () => {
    await bootNoShard('hook');
    expect(await handleMaintenanceIpc({ type: 'data:global-read', requestId: 'q' })).toBeNull();
  });
});

describe('the maintenance.json poll of a boot for a refused login', () => {
  it('starts only when the hook closes the gate, counted from that entry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    setBackendKind('postgres');
    _setMaintenanceTiming({ filePollMs: 1000 });
    expect(await runMaintenanceBoot({ cause: 'login-refused', message: 'm' }, noShard)).toBeNull();
    await vi.advanceTimersByTimeAsync(600);
    expect(await handleMaintenanceIpc({ type: 'maintenance:enter', requestId: 'e', data: { message: 'm' } })).toStrictEqual({ requestId: 'e', data: { saved: true } });
    writeMaintenanceFile('running', 'm');
    await vi.advanceTimersByTimeAsync(500);
    expect(logs.some(line => line.includes(POLL_LEAVE_LINE))).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(logs.some(line => line.includes(POLL_LEAVE_LINE))).toBe(true);
  });
});

describe('the Client of a maintenance boot', () => {
  it('asks for the Guilds intent', async () => {
    setBackendKind('file');
    _setMaintenanceTiming({ filePollMs: 600_000 });
    const client = await runMaintenanceBoot({ cause: 'hook', message: 'm' }, { shards: async () => 2, login: async () => undefined });
    clients.push(client!);
    expect(new IntentsBitField(client!.options.intents).has(GatewayIntentBits.Guilds)).toBe(true);
  });

  it('a sharding env left in the process environment never stops the record\'s shards from building it', async () => {
    process.env.SHARDS = '{not json';
    process.env.SHARD_COUNT = 'many';
    setBackendKind('postgres');
    _setMaintenanceTiming({ filePollMs: 600_000 });
    const client = await runMaintenanceBoot({ cause: 'hook', message: 'm' }, {
      shardRecord: () => ({ shardCount: 4, shardIds: [3, 1], processId: 'p', at: '' }),
      login: async () => undefined,
    });
    clients.push(client!);
    expect(client!.options.shards).toEqual([1, 3]);
    expect(client!.options.shardCount).toBe(4);
  });
});
