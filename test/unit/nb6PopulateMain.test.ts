import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NB6 part 22, through the real src/index.ts main(): on a Postgres bot whose config.json already holds every schema
// key, ensureConfigPopulated answers 'unchanged' and writes nothing, and the web UI's populate log says so instead of
// "saved". BotManager's web UI sessions are replaced by scripted ones over the shared tables. Its guard, a populate
// that adds keys, is nb6PopulateMainAdded.test.ts (main() runs once per file).

const ctl = vi.hoisted(() => ({ onConstruct: null as null | (() => void) }));
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
    constructor(...args: any[]) {
      super(...(args as [boolean?]));
      ctl.onConstruct?.();
    }
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
import { _resetRowQueue, useWebuiSessions, type WebuiSessionDeps } from '../../src/bot/internalSetup/utils/sharedStore';
import { webuiSessions } from '../helpers/nb6WebuiSession';

const UNCHANGED = '[Main] config.json populate: every key is present; nothing written';
const logs: string[] = [];
const s = webuiSessions();

/** The web UI's sessions over the shared tables, its main database chosen (as helpers/nb6WebuiSession.ts's rows use them). */
function deps(): WebuiSessionDeps {
  return {
    target: async () => ({ entry: 'postgres://bot:pw@a.example:5432/bot', tag: '1:M', countAtStart: 0 }),
    commitCheck: () => null,
    select: async (text, values) => {
      const res = await s.rows.answer(text, values, 0, 999);
      if (res instanceof Error) throw res;
      return (res ?? { rows: [] }) as { rows: any[] };
    },
    tag: () => '1:M',
    session: config => s.session(config as Record<string, unknown>),
  };
}

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
  useWebuiSessions(null);
  _resetRowQueue();
  setBackendKind(null);
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

/** Every key of this image's root schema, as a full JSON populate writes it. */
async function fullConfigText(): Promise<string> {
  setBackendKind('file');
  fs.rmSync(ROOT_CONFIG_PATH, { force: true });
  expect(ensureConfigPopulated()).toBe('written');
  await dm.flushAll();
  const full = fs.readFileSync(ROOT_CONFIG_PATH, 'utf8');
  logs.length = 0;
  return full;
}

describe('the boot populate log in src/index.ts', () => {
  it('a Postgres bot whose config.json holds every key logs that nothing was written, not saved', async () => {
    const full = await fullConfigText();

    s.rows.put('config.json', full);
    ctl.onConstruct = () => useWebuiSessions(deps());
    await runMain('postgres', full);

    expect(logs.filter(l => l.startsWith('[Main] config.json populate') || l.startsWith('[Main] Skipped populating'))).toEqual([UNCHANGED]);
    expect(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8')).toBe(full);
    expect(s.rows.docs.get('config.json')?.body.toString('utf8')).toBe(full);
    expect(s.sent.some(q => /^s*(INSERT|UPDATE|DELETE)/i.test(q.sql))).toBe(false);
  }, 30_000);
});
