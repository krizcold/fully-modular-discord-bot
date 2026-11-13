import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const safety = vi.hoisted(() => ({
  safe: false,
  recordCrash: () => undefined,
  isInSafeMode(): boolean { return this.safe; },
  getStatus: () => ({}),
}));

vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager } from '../../src/webui/botManager';
import { forkLogin, forks } from '../helpers/forkMock';

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  forks.children.length = 0;
  forks.exitCode = 0;
  forks.holdExit = false;
  forks.onFork = null;
  forkLogin.on = true;
  safety.safe = false;
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function running() {
  const manager = new BotManager();
  const started = manager.start();
  await advance(600);
  expect((await started).success).toBe(true);
  const broadcast = vi.fn(() => 1);
  manager.setWebSocketManager({ broadcast } as any);
  const child = forks.children[forks.children.length - 1];
  const sent = (type: string) => broadcast.mock.calls.filter((call: unknown[]) => call[0] === type).map((call: unknown[]) => call[1]);
  return { manager, child, sent };
}

describe('rm9 the bot process reports reach the web UI clients', () => {
  it('rm9 a metrics snapshot from the bot process is sent to the clients as bot:metrics:snapshot', async () => {
    const { child, sent } = await running();
    const data = { guilds: 3, at: 1234 };
    child.emit('message', { type: 'metrics:snapshot', data });
    expect(sent('bot:metrics:snapshot')).toEqual([data]);
    expect(sent('bot:fleet:status')).toEqual([]);
  });

  it('rm9 a fleet status from the bot process is sent to the clients as bot:fleet:status', async () => {
    const { child, sent } = await running();
    const data = { shards: [0, 1], role: 'master' };
    child.emit('message', { type: 'fleet:status', data });
    expect(sent('bot:fleet:status')).toEqual([data]);
    expect(sent('bot:metrics:snapshot')).toEqual([]);
  });
});
