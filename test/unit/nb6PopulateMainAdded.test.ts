import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NB6 part 22, the guard of nb6PopulateMain.test.ts, through the real src/index.ts main(): a populate that adds the
// schema keys config.json lacks still logs "saved".

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}), validateHealth: vi.fn(async () => undefined) }));
vi.mock('tsconfig-paths', () => ({ register: () => undefined }));
vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/webui/utils/logCapture', () => ({ initLogCapture: () => undefined }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/webui', () => ({
  startWebUI: async () => undefined,
  flushBeforeExit: async () => undefined,
}));
vi.mock('../../src/webui/botManager', async orig => {
  const real = await orig<typeof import('../../src/webui/botManager')>();
  class StubStartBotManager extends real.BotManager {
    async start(): Promise<any> {
      return { success: false, reason: 'credentials_missing' };
    }
  }
  return { ...real, BotManager: StubStartBotManager };
});

import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { ensureConfigPopulated, ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { setBackendKind } from '../helpers/backendKind';
import { freshWriterLock } from '../helpers/nb10Rig';

const UNCHANGED = '[Main] config.json populate: every key is present; nothing written';
const SAVED = '[Main] config.json populate: saved';
const logs: string[] = [];

beforeAll(() => {
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
  dm.setSharedWriteGate(null);
  vi.restoreAllMocks();
  fs.rmSync(writerLockPath(), { force: true });
  fs.rmSync(ROOT_CONFIG_PATH, { force: true });
});

/** main() with config.json holding body, on the backend kind given; resolves when its populate logged and the lock is free. */
async function runMain(kind: 'file' | 'postgres', body: string): Promise<void> {
  freshWriterLock('webui');
  fs.mkdirSync(path.dirname(ROOT_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(ROOT_CONFIG_PATH, body);
  setBackendKind(kind);
  await import('../../src/index');
  await vi.waitFor(() => expect(logs.some(l => l.startsWith('[Main] config.json populate') || l.startsWith('[Main] Skipped populating'))).toBe(true), { timeout: 15_000, interval: 10 });
  await vi.waitFor(() => expect(fs.existsSync(writerLockPath())).toBe(false), { timeout: 2000, interval: 10 });
}

describe('the boot populate log in src/index.ts', () => {
  it('a populate that adds keys logs saved (a guard)', async () => {
    await runMain('file', JSON.stringify({ DEVS: ['1'] }));

    expect(logs.filter(l => l.startsWith('[Main] config.json populate'))).toEqual([SAVED]);
    const written = JSON.parse(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8'));
    expect(written.DEVS).toEqual(['1']);
    expect(Object.keys(written).length).toBeGreaterThan(1);
  }, 30_000);
});
