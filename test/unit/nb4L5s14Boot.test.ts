import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Ruling 6 and NB4 decisions 16 and 22: the maintenance boot. This file marks its process as booted in maintenance,
// so it holds only these cases. Its step of the one stop (dataManager.ts, which drains and exits) is captured so it
// runs here without ending the process.

const h = vi.hoisted(() => ({
  steps: null as null | (() => void | Promise<void>),
  added: 0,
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<object>()),
  stopProcess: () => undefined,
  addStopStep: (step: () => void | Promise<void>) => {
    h.steps = step;
    h.added += 1;
  },
}));

import type { Client } from 'discord.js';
import { setBackendKind } from '../helpers/backendKind';
import { resetDataBackendCache, resolveDataBackend } from '../../src/utils/envLoader';
import {
  _resetMaintenance,
  _setMaintenanceSender,
  _setMaintenanceTiming,
  MAINTENANCE_PRESENCE,
  runMaintenanceBoot,
} from '../../src/bot/internalSetup/utils/maintenance';

let logs: string[] = [];
let signalsBefore: { SIGTERM: Function[]; SIGINT: Function[] } = { SIGTERM: [], SIGINT: [] };
const built: Client[] = [];
const realSend = process.send;
beforeEach(() => {
  (process as { send?: unknown }).send = undefined;
  _setMaintenanceSender(() => undefined);
  _setMaintenanceTiming({ filePollMs: 600_000 });
  h.steps = null;
  h.added = 0;
  logs = [];
  const capture = (...args: unknown[]) => { logs.push(String(args[0])); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  signalsBefore = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') };
});
afterEach(() => {
  vi.useRealTimers();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    for (const l of process.listeners(signal)) if (!signalsBefore[signal].includes(l)) process.off(signal, l as never);
  }
  for (const c of built.splice(0)) void c.destroy().catch(() => undefined);
  (process as { send?: unknown }).send = realSend;
  _resetMaintenance();
  _setMaintenanceSender(null);
  setBackendKind(null);
  vi.restoreAllMocks();
});

const noSleep = async () => undefined;

async function jsonBoot(over: Parameters<typeof runMaintenanceBoot>[1] = {}, cause: 'hook' | 'login-refused' = 'hook') {
  setBackendKind('file');
  const client = await runMaintenanceBoot({ cause, message: 'm' }, { shards: async () => 2, login: async () => undefined, sleep: noSleep, ...over });
  if (client) built.push(client);
  return client;
}

describe('the stop step of a maintenance boot', () => {
  it('destroys the Client', async () => {
    const client = (await jsonBoot())!;
    const destroy = vi.spyOn(client, 'destroy').mockResolvedValue(undefined);
    await h.steps!();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('a destroy that never settles is left after 2 s, so the drain and the exit of the one stop run', async () => {
    const client = (await jsonBoot())!;
    vi.spyOn(client, 'destroy').mockReturnValue(new Promise<void>(() => undefined));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let ended = false;
    const done = Promise.resolve(h.steps!()).then(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(1999);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ended).toBe(true);
    await done;
  });

  it('is added once, and the boot adds no signal listener of its own (the one stop handler is on both signals)', async () => {
    await jsonBoot();
    const added = (signal: 'SIGTERM' | 'SIGINT') => process.listeners(signal).filter(l => !signalsBefore[signal].includes(l));
    expect(h.added).toBe(1);
    expect(added('SIGINT')).toHaveLength(0);
    expect(added('SIGTERM')).toHaveLength(0);
  });
});

describe('the login watcher of a maintenance boot', () => {
  it('runs only for a refused login, not for the hook', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const probe = vi.fn(async () => 'refused' as const);
    await jsonBoot({ loginProbe: probe, retryMs: 1000 }, 'hook');
    await vi.advanceTimersByTimeAsync(3500);
    expect(probe).not.toHaveBeenCalled();
    _resetMaintenance();
    _setMaintenanceTiming({ filePollMs: 600_000 });
    await jsonBoot({ loginProbe: probe, retryMs: 1000 }, 'login-refused');
    await vi.advanceTimersByTimeAsync(3500);
    expect(probe).toHaveBeenCalledTimes(3);
  });
});

describe('the Discord steps of a maintenance boot', () => {
  it('a shard count fetch that fails is logged by name and tried again', async () => {
    let calls = 0;
    const client = await jsonBoot({ shards: async () => { calls += 1; if (calls === 1) throw new Error('gateway down'); return 2; } });
    expect(logs).toContain('[Maintenance] Could not fetch the shard count from Discord (gateway down); trying again in 5 s');
    expect(client!.options.shards).toEqual([0, 1]);
  });

  it('a login that fails is logged by name and tried again', async () => {
    let calls = 0;
    const client = await jsonBoot({ login: async () => { calls += 1; if (calls === 1) throw new Error('An invalid token was provided.'); } });
    expect(logs).toContain('[Maintenance] The Discord login failed (An invalid token was provided.); trying again in 5 s');
    expect(calls).toBe(2);
    expect(client).not.toBeNull();
  });

  it('a shard that becomes ready again is given the maintenance status', async () => {
    const client = (await jsonBoot())!;
    const set = vi.spyOn((client as unknown as { presence: { set(d: unknown): unknown } }).presence, 'set').mockReturnValue(undefined);
    client.emit('shardReady', 1, undefined);
    expect(set).toHaveBeenCalledWith({ ...MAINTENANCE_PRESENCE, shardId: 1 });
  });

  it('logs the login line once the Client is ready', async () => {
    const client = (await jsonBoot())!;
    (client as unknown as { user: unknown }).user = { tag: 'Bot#0001' };
    client.emit('clientReady', client as never);
    expect(logs).toContain('Logged in as Bot#0001! (maintenance mode, 2 of 2 shard(s))');
  });
});

describe('the shards a Postgres maintenance boot connects', () => {
  it('shard 0 of a count above 1 keeps its count', async () => {
    setBackendKind('postgres');
    const client = await runMaintenanceBoot({ cause: 'hook', message: 'm' }, {
      shardRecord: () => ({ shardCount: 4, shardIds: [0], processId: 'p', at: '' }),
      login: async () => undefined,
    });
    built.push(client!);
    expect(client!.options.shards).toEqual([0]);
    expect(client!.options.shardCount).toBe(4);
  });
});

describe('a DATA_BACKEND the bot cannot read', () => {
  it('boots as a JSON bot: every shard of the fetched count, no shard record read', async () => {
    setBackendKind(null);
    resetDataBackendCache();
    process.env.DATA_BACKEND = 'mongo';
    expect(() => resolveDataBackend()).toThrow('Invalid DATA_BACKEND');
    try {
      const record = vi.fn(() => null);
      const client = await runMaintenanceBoot({ cause: 'hook', message: 'm' }, { shards: async () => 2, shardRecord: record, login: async () => undefined, sleep: noSleep });
      if (client) built.push(client);
      expect(record).not.toHaveBeenCalled();
      expect(client!.options.shards).toEqual([0, 1]);
    } finally {
      delete process.env.DATA_BACKEND;
      resetDataBackendCache();
    }
  });
});
