import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 47, the SIGTERM handler of src/webui/index.ts: installed by the real startWebUI on port 0, alone and beside
// src/index.ts's handler as main() installs both. A local op held on a slow rename is in progress and a second op is
// queued when SIGTERM arrives: the queued op answers the shutting-down text, the op in progress lands before
// flushBeforeExit, and the first exit is code 0, with no forced exit armed before the drain.

const ctl = vi.hoisted(() => ({ order: [] as string[], exits: [] as number[], manager: null as any, sigterm: [] as Array<(...a: any[]) => unknown> }));
const safety = vi.hoisted(() => ({ recordCrash: () => undefined, isInSafeMode: () => false, getStatus: () => ({}), validateHealth: async () => undefined }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const fork = () => { throw new Error('this test forks no bot process'); };
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('tsconfig-paths', () => ({ register: () => undefined }));
vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/webui/utils/logCapture', () => ({ initLogCapture: () => undefined }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/utils/envLoader', async orig => ({ ...(await orig<any>()), ensureDurableSessionSecret: () => undefined }));
vi.mock('../../src/webui/server', () => ({ createServer: async () => (_req: any, res: any) => { res.statusCode = 404; res.end(); } }));
vi.mock('../../src/webui/auth/sessionManager', async orig => ({ ...(await orig<any>()), stopSessionStore: () => { ctl.order.push('stopSessionStore'); } }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  drainForExit: async () => { ctl.order.push('flushBeforeExit'); return { left: [] }; },
}));
vi.mock('../../src/webui/botManager', async orig => {
  const real = await orig<typeof import('../../src/webui/botManager')>();
  class KeptBotManager extends real.BotManager {
    constructor(...args: any[]) {
      super(...(args as [boolean?]));
      ctl.manager = this;
    }
    async start(): Promise<any> {
      return { success: false, reason: 'credentials_missing' };
    }
  }
  return { ...real, BotManager: KeptBotManager };
});

import { BotManager, inLocalOp, ROUTE_TEXT } from '../../src/webui/botManager';
import { startWebUI } from '../../src/webui';
import { setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { dataPath } from '../../src/utils/dataRoot';
import { freshWriterLock } from '../helpers/nb10Rig';
import { gate } from './nb10PremiumRig';

const target = dataPath('global', 'nb10signal', 'x.json');
const second = dataPath('global', 'nb10signal', 'y.json');
const port = process.env.WEBUI_PORT;

function heldRename(until: Promise<unknown>): void {
  const real = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) !== target) return real(from, to);
    await until;
    await real(from, to);
    ctl.order.push('x.json landed');
  }) as typeof fs.promises.rename);
}

beforeAll(() => {
  process.env.WEBUI_PORT = '0';
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  ctl.order.length = 0;
  ctl.exits = [];
  ctl.sigterm = [];
  freshWriterLock('webui');
  setSharedWriteGate(() => inLocalOp());
  fs.rmSync(dataPath('global', 'nb10signal'), { recursive: true, force: true });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { ctl.exits.push(code ?? 0); ctl.order.push(`exit ${code ?? 0}`); }) as typeof process.exit);
  const realOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...a: any[]) => unknown) => {
    if (event === 'SIGTERM') ctl.sigterm.push(handler);
    if (event === 'SIGTERM' || event === 'SIGINT') return process;
    return realOn(event as any, handler);
  }) as typeof process.on);
  // The 10 s forced exit is recorded, not armed: process.exit is a spy here, so a real timer would outlive the test.
  const realTimeout = global.setTimeout;
  vi.spyOn(global, 'setTimeout').mockImplementation(((fn: (...a: any[]) => void, ms?: number, ...rest: any[]) => {
    if (ms === 10000 && String(fn).includes('Forced shutdown')) {
      ctl.order.push('forced exit armed');
      return realTimeout(() => undefined, 0);
    }
    return realTimeout(fn, ms, ...rest);
  }) as typeof setTimeout);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (port === undefined) delete process.env.WEBUI_PORT;
  else process.env.WEBUI_PORT = port;
  setSharedWriteGate(null);
  vi.restoreAllMocks();
  fs.rmSync(writerLockPath(), { force: true });
});

/** A held op in progress and a second one queued; SIGTERM runs every handler given, as Node calls them in order. */
async function sigtermDuring(manager: BotManager, handlers: Array<(...a: any[]) => unknown>): Promise<void> {
  const held = gate();
  heldRename(held.promise);
  const first = manager.runSharedOp('global.write', { rel: 'nb10signal/x.json', contentJson: '{"v":1}', expectSha: 'absent' });
  await vi.waitFor(() => expect(fs.existsSync(writerLockPath())).toBe(true), { timeout: 2000, interval: 5 });
  const queued = manager.runSharedOp('global.write', { rel: 'nb10signal/y.json', contentJson: '{"v":2}', expectSha: 'absent' });
  const stopping = handlers.map(handler => Promise.resolve(handler()));
  expect(await queued).toMatchObject({ ok: false, code: 'stopping', error: ROUTE_TEXT.exiting });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(ctl.order).not.toContain('flushBeforeExit');
  expect(ctl.exits).toEqual([]);
  held.open();
  expect(await first).toMatchObject({ ok: true });
  await Promise.all(stopping);
  await vi.waitFor(() => expect(ctl.exits.length).toBeGreaterThan(0), { timeout: 5000, interval: 10 });
  expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ v: 1 });
  expect(fs.existsSync(second)).toBe(false);
  expect(fs.existsSync(writerLockPath())).toBe(false);
}

describe("src/webui/index.ts's SIGTERM handler", () => {
  it('alone: the op in progress lands, then the session store stops, flushBeforeExit runs and the exit is 0', async () => {
    const manager = new BotManager();
    await startWebUI(manager);
    expect(ctl.sigterm).toHaveLength(1);
    await sigtermDuring(manager, ctl.sigterm);
    await vi.waitFor(() => expect(ctl.order).toContain('exit 0'), { timeout: 5000, interval: 10 });
    expect(ctl.order).toEqual(['x.json landed', 'stopSessionStore', 'flushBeforeExit', 'forced exit armed', 'exit 0']);
    expect(ctl.exits).toEqual([0]);
  }, 30_000);

  it("beside src/index.ts's handler, as main() installs both: nothing exits before the op landed, and the first exit is 0", async () => {
    await import('../../src/index');
    await vi.waitFor(() => expect(ctl.sigterm).toHaveLength(2), { timeout: 10_000, interval: 10 });
    await vi.waitFor(() => expect(fs.existsSync(writerLockPath())).toBe(false), { timeout: 10_000, interval: 10 });
    await sigtermDuring(ctl.manager, ctl.sigterm);
    const landed = ctl.order.indexOf('x.json landed');
    expect(landed).toBe(0);
    expect(ctl.order.indexOf('flushBeforeExit')).toBeGreaterThan(landed);
    // process.exit is a spy, so the second handler runs on to its own exit; in production the first exit ends the process.
    await vi.waitFor(() => expect(ctl.exits).toHaveLength(2), { timeout: 5000, interval: 10 });
    expect(ctl.exits).toEqual([0, 0]);
    expect(ctl.order.indexOf('exit 0')).toBeGreaterThan(ctl.order.indexOf('flushBeforeExit'));
  }, 30_000);
});
