import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NB10 code review round 5 (NB10-R6-O3), the fixer's regression test, through the real src/index.ts main(): a
// config.json that cannot be parsed is left as it is, and the populate logs that it skipped it, never 'saved'.

const ctl = vi.hoisted(() => ({ order: [] as string[] }));
const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}), validateHealth: vi.fn(async () => undefined) }));
vi.mock('tsconfig-paths', () => ({ register: () => undefined }));
vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/webui/utils/logCapture', () => ({ initLogCapture: () => undefined }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/webui', () => ({
  startWebUI: async () => { ctl.order.push('startWebUI'); },
  flushBeforeExit: async () => { ctl.order.push('flushBeforeExit'); },
}));
vi.mock('../../src/webui/botManager', async orig => {
  const real = await orig<typeof import('../../src/webui/botManager')>();
  class StubStartBotManager extends real.BotManager {
    async start(): Promise<any> {
      ctl.order.push('bot start');
      return { success: false, reason: 'credentials_missing' };
    }
  }
  return { ...real, BotManager: StubStartBotManager };
});

import { ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { freshWriterLock } from '../helpers/nb10Rig';

const logs: string[] = [];
const BROKEN = '{"DEVS": ["1"],';

beforeAll(() => {
  freshWriterLock('webui');
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
  const realOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...a: any[]) => unknown) => {
    if (event === 'SIGTERM' || event === 'SIGINT') return process;
    return realOn(event as any, handler);
  }) as typeof process.on);
});

afterAll(() => {
  setSharedWriteGate(null);
  vi.restoreAllMocks();
  fs.rmSync(writerLockPath(), { force: true });
  fs.rmSync(ROOT_CONFIG_PATH, { force: true });
});

describe('the boot populate of a config.json that cannot be parsed', () => {
  it('leaves the file as it is and logs the skip with the reason, not saved', async () => {
    fs.mkdirSync(path.dirname(ROOT_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(ROOT_CONFIG_PATH, BROKEN);
    await import('../../src/index');
    const skipped = '[Main] Skipped populating config.json: config.json cannot be read or parsed; left it as it is. Fix the file, then restart.';
    await vi.waitFor(() => expect(logs).toContain(skipped), { timeout: 15_000, interval: 10 });
    expect(logs).not.toContain('[Main] config.json populate: saved');
    expect(logs.some(l => l.startsWith('[ConfigManager] config.json cannot be read (') && l.endsWith('); left it as it is'))).toBe(true);
    expect(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8')).toBe(BROKEN);
    await vi.waitFor(() => expect(fs.existsSync(writerLockPath())).toBe(false), { timeout: 2000, interval: 10 });
  }, 30_000);
});
