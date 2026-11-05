import fs from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NB10 tests 21 (round 4) and 47, through the real src/index.ts main(): main() reaches startWebUI while the boot
// populate is still in its land-or-cancel step and logs the op's outcome when it ends; its SIGTERM handler answers a
// queued op the shutting-down text and calls flushBeforeExit only after the op in progress landed. startWebUI and
// flushBeforeExit are stand-ins that record the order; BotManager is the real one (a subclass that keeps the instance).

const ctl = vi.hoisted(() => ({ order: [] as string[], manager: null as any, handlers: new Map<string, (...a: any[]) => unknown>() }));
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
  class KeptBotManager extends real.BotManager {
    constructor(...args: any[]) {
      super(...(args as [boolean?]));
      ctl.manager = this;
    }
    async start(): Promise<any> {
      ctl.order.push('bot start');
      return { success: false, reason: 'credentials_missing' };
    }
  }
  return { ...real, BotManager: KeptBotManager };
});

import { ROUTE_TEXT } from '../../src/webui/botManager';
import { ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { dataPath } from '../../src/utils/dataRoot';
import { freshWriterLock } from '../helpers/nb10Rig';
import { gate } from './nb10PremiumRig';

const logs: string[] = [];
let exitCodes: number[] = [];

/** The rename onto this path waits for the gate, then records that it landed. */
function heldRename(absPath: string, until: Promise<unknown>, name: string): void {
  const real = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) !== absPath) return real(from, to);
    await until;
    await real(from, to);
    ctl.order.push(`${name} landed`);
  }) as typeof fs.promises.rename);
}

beforeAll(() => {
  freshWriterLock('webui');
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exitCodes.push(code ?? 0); ctl.order.push('exit'); }) as typeof process.exit);
  const realOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...a: any[]) => unknown) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      ctl.handlers.set(event, handler);
      return process;
    }
    return realOn(event as any, handler);
  }) as typeof process.on);
});

afterAll(() => {
  setSharedWriteGate(null);
  vi.restoreAllMocks();
  fs.rmSync(writerLockPath(), { force: true });
});

describe('src/index.ts main()', () => {
  it('reaches startWebUI while the populate is still on the wire, and logs its outcome when it ends (test 21, round 4)', async () => {
    fs.rmSync(ROOT_CONFIG_PATH, { force: true });
    const held = gate();
    heldRename(ROOT_CONFIG_PATH, held.promise, 'config.json');
    await import('../../src/index');
    await vi.waitFor(() => expect(ctl.order).toContain('bot start'), { timeout: 5000, interval: 5 });
    expect(ctl.order.indexOf('startWebUI')).toBeGreaterThanOrEqual(0);
    expect(fs.existsSync(writerLockPath())).toBe(true);
    expect(logs.some(l => l.startsWith('[Main] config.json populate'))).toBe(false);
    held.open();
    await vi.waitFor(() => expect(logs).toContain('[Main] config.json populate: saved'), { timeout: 15_000, interval: 10 });
    expect(ctl.order.indexOf('startWebUI')).toBeLessThan(ctl.order.indexOf('config.json landed'));
    expect(fs.existsSync(ROOT_CONFIG_PATH)).toBe(true);
    await vi.waitFor(() => expect(fs.existsSync(writerLockPath())).toBe(false), { timeout: 2000, interval: 10 });
    vi.mocked(fs.promises.rename).mockRestore();
  }, 30_000);

  it("its SIGTERM handler answers a queued op the shutting-down text and flushes only after the op in progress landed (test 47)", async () => {
    expect(ctl.handlers.has('SIGTERM')).toBe(true);
    expect(ctl.handlers.has('SIGINT')).toBe(true);
    const manager = ctl.manager;
    ctl.order.length = 0;
    exitCodes = [];
    const target = dataPath('global', 'nb10main', 'x.json');
    fs.rmSync(dataPath('global', 'nb10main'), { recursive: true, force: true });
    const held = gate();
    heldRename(target, held.promise, 'x.json');
    const first = manager.runSharedOp('global.write', { rel: 'nb10main/x.json', contentJson: '{"v":1}', expectSha: 'absent' });
    await vi.waitFor(() => expect(fs.existsSync(writerLockPath())).toBe(true), { timeout: 2000, interval: 5 });
    const queued = manager.runSharedOp('global.write', { rel: 'nb10main/y.json', contentJson: '{"v":2}', expectSha: 'absent' });
    const stopping = Promise.resolve(ctl.handlers.get('SIGTERM')!());
    expect(await queued).toMatchObject({ ok: false, code: 'stopping', error: ROUTE_TEXT.exiting });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(ctl.order).not.toContain('flushBeforeExit');
    held.open();
    await stopping;
    expect(await first).toMatchObject({ ok: true });
    expect(ctl.order).toEqual(['x.json landed', 'flushBeforeExit', 'exit']);
    expect(exitCodes).toEqual([0]);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ v: 1 });
    expect(fs.existsSync(dataPath('global', 'nb10main', 'y.json'))).toBe(false);
  }, 30_000);
});
