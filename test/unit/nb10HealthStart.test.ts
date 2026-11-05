import fs from 'fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 39 (row 39's src/index.ts half), through the real main() and the real BotManager.start() and whenStage():
// a child that reports `waiting` makes main() log the waiting line, not "Bot started successfully", and the health
// clock starts only once the child reports `shared`; a child that exits before `shared` starts no validation.

const ctl = vi.hoisted(() => ({ children: [] as any[], onFork: null as null | ((child: any) => void), handlers: new Map<string, (...a: any[]) => unknown>() }));
const safety = vi.hoisted(() => ({ recordCrash: () => undefined, isInSafeMode: () => false, getStatus: () => ({}), validateHealth: (() => undefined) as any }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const fork = () => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.pid = 4100 + ctl.children.length;
    child.send = () => true;
    child.kill = (signal: string) => { child.killed = signal; return true; };
    ctl.children.push(child);
    setTimeout(() => ctl.onFork?.(child), 1);
    return child;
  };
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('tsconfig-paths', () => ({ register: () => undefined }));
vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/webui/utils/logCapture', () => ({ initLogCapture: () => undefined }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/webui', () => ({ startWebUI: async () => undefined, flushBeforeExit: async () => undefined }));

import { setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { freshWriterLock } from '../helpers/nb10Rig';

const logs: string[] = [];
const writer = (child: any, data: object) => child.emit('message', { type: 'data:writer', data });

/** Runs a fresh copy of src/index.ts's main() until it printed "System Ready". */
async function runMain(): Promise<any> {
  vi.resetModules();
  await import('../../src/index');
  await vi.waitFor(() => expect(logs.filter(l => l.includes('System Ready')).length).toBeGreaterThan(0), { timeout: 15_000, interval: 20 });
  return ctl.children.at(-1);
}

beforeAll(() => {
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const realOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...a: any[]) => unknown) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      ctl.handlers.set(event, handler);
      return process;
    }
    return realOn(event as any, handler);
  }) as typeof process.on);
});

beforeEach(() => {
  freshWriterLock('webui');
  logs.length = 0;
  safety.validateHealth = vi.fn(async () => undefined);
});

afterAll(() => {
  setSharedWriteGate(null);
  vi.restoreAllMocks();
  fs.rmSync(writerLockPath(), { force: true });
});

describe('src/index.ts main() with a child that waits for the data files', () => {
  it('logs the waiting line, not a start, and starts the health clock only at the shared report', async () => {
    ctl.onFork = child => writer(child, { stage: 'waiting', holder: { role: 'webui', pid: 77 } });
    const child = await runMain();
    expect(logs).toContain('[Main] The bot process started and waits for the web UI (pid 77) to release the data files');
    expect(logs).not.toContain('[Main] Bot started successfully');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(safety.validateHealth).not.toHaveBeenCalled();
    writer(child, { stage: 'shared' });
    await vi.waitFor(() => expect(safety.validateHealth).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 5 });
    expect(safety.validateHealth).toHaveBeenCalledWith(60000);
    await vi.waitFor(() => expect(logs).toContain('[Main] Bot health validated - marking as stable'), { timeout: 2000, interval: 5 });
    child.exitCode = 0;
    child.emit('exit', 0, null);
  }, 30_000);

  it('a child that exits before its shared report starts no validation', async () => {
    ctl.onFork = child => writer(child, { stage: 'waiting', holder: { role: 'webui', pid: 77 } });
    const child = await runMain();
    expect(logs).not.toContain('[Main] Bot started successfully');
    child.exitCode = 1;
    child.emit('exit', 1, null);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(safety.validateHealth).not.toHaveBeenCalled();
    expect(logs).not.toContain('[Main] Bot health validated - marking as stable');
  }, 30_000);
});
