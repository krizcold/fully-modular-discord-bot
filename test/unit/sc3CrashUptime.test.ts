import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});

import { dataPath } from '../../src/utils/dataRoot';
import { crash, forkLogin, forks } from '../helpers/forkMock';
import { BotManager } from '../../src/webui/botManager';
import { getSafetyManager } from '../../src/utils/updateSafety';

const STABLE_MS = 10 * 60_000;
let logs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  forks.children.length = 0;
  forks.exitCode = 0;
  forks.holdExit = false;
  forks.onFork = null;
  forkLogin.on = true;
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  fs.rmSync(dataPath('update-safety.json'), { force: true });
  fs.rmSync(dataPath('crash-logs'), { recursive: true, force: true });
  logs = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  }
});

afterEach(() => {
  forks.onFork = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dataPath('update-safety.json'), { force: true });
  fs.rmSync(dataPath('crash-logs'), { recursive: true, force: true });
});

/** A bot whose first child crashed at once and was started again; answers the moment the second child was forked. */
async function restartedOnce(): Promise<{ bot: BotManager; forkedAt: number }> {
  const safety = getSafetyManager();
  safety.clearCrashHistory();
  safety.disableSafeMode();
  const bot = new BotManager();
  const pending = bot.start();
  await vi.advanceTimersByTimeAsync(600);
  expect((await pending).success).toBe(true);
  let forkedAt = -1;
  forks.onFork = () => { forkedAt = Date.now(); };
  crash(forks.children[0], 1);
  expect(logs).toContain('[BotManager] Starting the bot again in 5s (automatic start 1 of 5)');
  await vi.advanceTimersByTimeAsync(5_700);
  expect(forks.children).toHaveLength(2);
  expect(forkedAt).toBeGreaterThan(0);
  return { bot, forkedAt };
}

async function crashAt(at: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(at - Date.now());
  expect(Date.now()).toBe(at);
  logs.length = 0;
  crash(forks.children[1], 1);
}

describe('the automatic start count after a run of the stable uptime', () => {
  it('sc3 uptime boundary: a crash exactly 10 minutes after the start begins the count again', async () => {
    const { forkedAt } = await restartedOnce();
    await crashAt(forkedAt + STABLE_MS);
    expect(logs).toContain('[BotManager] Starting the bot again in 5s (automatic start 1 of 5)');
    expect(logs.filter(l => l.includes('automatic start 2 of 5'))).toEqual([]);
  });

  it('sc3 uptime boundary: a crash a millisecond short of 10 minutes counts on', async () => {
    const { forkedAt } = await restartedOnce();
    await crashAt(forkedAt + STABLE_MS - 1);
    expect(logs).toContain('[BotManager] Starting the bot again in 5s (automatic start 2 of 5)');
  });
});
