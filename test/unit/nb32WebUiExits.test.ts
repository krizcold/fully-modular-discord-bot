import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Each exit of the web UI process names the writes a deposition lost right before it exits: the two control.ts
// routes, and src/webui/index.ts's signal handler on its server-closed exit and on its forced exit. The writes are a
// stand-in whose naming records itself.

const ctl = vi.hoisted(() => ({ order: [] as string[], sigterm: [] as Array<(...a: any[]) => unknown>, forced: null as null | (() => void) }));
const safety = vi.hoisted(() => ({ recordCrash: () => undefined, isInSafeMode: () => false, getStatus: () => ({}), validateHealth: async () => undefined }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const fork = () => { throw new Error('this test forks no bot process'); };
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/utils/envLoader', async orig => ({ ...(await orig<any>()), ensureDurableSessionSecret: () => undefined }));
vi.mock('../../src/webui/server', () => ({ createServer: async () => (_req: any, res: any) => { res.statusCode = 404; res.end(); } }));
vi.mock('../../src/webui/auth/sessionManager', async orig => ({ ...(await orig<any>()), stopSessionStore: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  drainForExit: async () => { ctl.order.push('flushBeforeExit'); return { left: [] }; },
}));

import { BotManager } from '../../src/webui/botManager';
import { createControlRoutes } from '../../src/webui/routes/control';
import { startWebUI } from '../../src/webui';
import { useDeposedWrites } from '../../src/bot/internalSetup/utils/dataManager';
import { call, startApp } from '../helpers/configRig';
import { freshWriterLock } from '../helpers/nb10Rig';

const port = process.env.WEBUI_PORT;
const exitOf = (code: number) => ctl.order.slice(0, ctl.order.indexOf(`exit ${code}`) + 1).slice(-2);

beforeAll(() => {
  process.env.WEBUI_PORT = '0';
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  ctl.order.length = 0;
  ctl.sigterm = [];
  ctl.forced = null;
  freshWriterLock('webui');
  useDeposedWrites({ answered: async () => undefined, nameLeft: () => { ctl.order.push('named'); } });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { ctl.order.push(`exit ${code ?? 0}`); }) as typeof process.exit);
  const realOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...a: any[]) => unknown) => {
    if (event === 'SIGTERM') ctl.sigterm.push(handler);
    if (event === 'SIGTERM' || event === 'SIGINT') return process;
    return realOn(event as any, handler);
  }) as typeof process.on);
  const realTimeout = global.setTimeout;
  vi.spyOn(global, 'setTimeout').mockImplementation(((fn: (...a: any[]) => void, ms?: number, ...rest: any[]) => {
    if (ms === 10000 && String(fn).includes('Forced shutdown')) {
      ctl.forced = () => fn(...rest);
      return realTimeout(() => undefined, 0);
    }
    return realTimeout(fn, ms, ...rest);
  }) as typeof setTimeout);
});

afterEach(() => {
  useDeposedWrites(null);
  vi.restoreAllMocks();
});

afterAll(() => {
  if (port === undefined) delete process.env.WEBUI_PORT;
  else process.env.WEBUI_PORT = port;
});

describe.each([
  ['the container restart', '/api/bot/shutdown', { emergency: true }],
  ['the full restart', '/api/bot/restart-server', {}],
])('%s route', (_name, route, body) => {
  it('names the lost writes after flushBeforeExit and right before the exit', async () => {
    const app = await startApp(a => a.use('/api/bot', createControlRoutes(new BotManager())));
    try {
      expect((await call(app.url, 'POST', route, body)).status).toBe(200);
      await vi.waitFor(() => expect(ctl.order).toContain('exit 0'), { timeout: 5_000, interval: 10 });
      expect(ctl.order).toEqual(['flushBeforeExit', 'named', 'exit 0']);
    } finally {
      await app.close();
    }
  });
});

describe("src/webui/index.ts's signal handler", () => {
  it('names the lost writes right before the exit once the server closed, and again before the forced exit', async () => {
    await startWebUI(new BotManager());
    expect(ctl.sigterm).toHaveLength(1);
    await ctl.sigterm[0]();
    await vi.waitFor(() => expect(ctl.order).toContain('exit 0'), { timeout: 5_000, interval: 10 });
    expect(exitOf(0)).toEqual(['named', 'exit 0']);
    expect(ctl.forced).not.toBeNull();
    ctl.forced!();
    expect(exitOf(1)).toEqual(['named', 'exit 1']);
  });
});
