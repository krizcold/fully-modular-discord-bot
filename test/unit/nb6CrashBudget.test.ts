import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 58 (wip-redesign/sheets/NB6.md decisions 66 and 68, row 209's limits, C18, E7; part 18): guard rows. NB6
// does not change BotManager's exit handler (`botProcessExit`, webui/botManager.ts); these rows hold the limits the
// crash count's hold relies on: a version held at the third start after two crashes stays under updateSafety's 3
// crashes in 5 minutes and under BotManager's 5 automatic starts. BotManager over a fake child, the real updateSafety
// on the test's temp data folder, fake timers and clock.

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

let logs: string[] = [];

/** A fresh BotManager over the safety manager, its crash history and safe mode cleared. */
async function manager(): Promise<{ bot: BotManager; safety: ReturnType<typeof getSafetyManager> }> {
  const safety = getSafetyManager();
  safety.clearCrashHistory();
  safety.disableSafeMode();
  return { bot: new BotManager(), safety };
}

async function started(bot: BotManager): Promise<void> {
  const pending = bot.start();
  await vi.advanceTimersByTimeAsync(600);
  expect((await pending).success).toBe(true);
}

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dataPath('update-safety.json'), { force: true });
  fs.rmSync(dataPath('crash-logs'), { recursive: true, force: true });
});

describe("row 209's limits (guard rows)", () => {
  it('two crash exits 5 s apart leave safe mode off and schedule a third start', async () => {
    const { bot, safety } = await manager();
    await started(bot);
    crash(forks.children[0], 1);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(forks.children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(600);
    crash(forks.children[1], 1);
    expect(safety.isInSafeMode()).toBe(false);
    expect(logs).toContain('[BotManager] Starting the bot again in 5s (automatic start 2 of 5)');
    await vi.advanceTimersByTimeAsync(5_100);
    expect(forks.children).toHaveLength(3);
  });

  it('a third crash within 5 minutes turns safe mode on, and the bot stays down', async () => {
    const { bot, safety } = await manager();
    await started(bot);
    for (let i = 0; i < 2; i += 1) {
      crash(forks.children[i], 1);
      await vi.advanceTimersByTimeAsync(5_700);
    }
    expect(forks.children).toHaveLength(3);
    crash(forks.children[2], 1);
    expect(safety.isInSafeMode()).toBe(true);
    expect(logs).toContain('[BotManager] Safe mode: the bot stays down after this crash');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(forks.children).toHaveLength(3);
  });

  it('C18: a kill by a signal with no stop asked counts as a crash and is started again', async () => {
    const { bot, safety } = await manager();
    await started(bot);
    const child = forks.children[0];
    child.signalCode = 'SIGKILL';
    child.emit('exit', null, 'SIGKILL');
    expect(logs).toContain('[BotManager] Starting the bot again in 5s (automatic start 1 of 5)');
    expect(safety.isInSafeMode()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(forks.children).toHaveLength(2);
  });
});
