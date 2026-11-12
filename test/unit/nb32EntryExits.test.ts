import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each exit of the two entry files names the writes a deposition lost right before it exits: src/index.ts when the
// web UI fails to start, when main() throws, and on SIGTERM and SIGINT; src/bot/index.ts when the boot throws. The
// writes are a stand-in whose naming records itself. Each case loads the entry afresh.

const h = vi.hoisted(() => ({
  order: [] as string[],
  handlers: new Map<string, (...a: any[]) => unknown>(),
  webFails: false,
  startFails: false,
}));
const safety = vi.hoisted(() => ({ recordCrash: () => undefined, isInSafeMode: () => false, getStatus: () => ({}), validateHealth: async () => undefined }));
vi.mock('tsconfig-paths', () => ({ register: () => undefined }));
vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/webui/utils/logCapture', () => ({ initLogCapture: () => undefined }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/webui', () => ({
  startWebUI: async () => { if (h.webFails) throw new Error('nb32: the web UI did not start'); },
  flushBeforeExit: async () => { h.order.push('flushBeforeExit'); },
}));
vi.mock('../../src/webui/botManager', async orig => {
  const real = await orig<typeof import('../../src/webui/botManager')>();
  class StandInBotManager extends real.BotManager {
    runLocalOp(): any {
      return new Promise(() => undefined);
    }
    async start(): Promise<any> {
      if (h.startFails) throw new Error('nb32: the bot start threw');
      return { success: false, reason: 'credentials_missing' };
    }
  }
  return { ...real, BotManager: StandInBotManager };
});
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => ({
  ...(await orig<any>()),
  configureWriterLock: () => undefined,
  takeWriterLockForBoot: async () => { throw new Error('nb32: the lock take threw'); },
}));

const role = process.env.BOT_PROCESS_ROLE;

async function freshDeposedWrites(): Promise<void> {
  vi.resetModules();
  const dm = await import('../../src/bot/internalSetup/utils/dataManager');
  dm.useDeposedWrites({ answered: async () => undefined, nameLeft: () => { h.order.push('named'); } });
}

const beforeExit = (code: number) => {
  const at = h.order.indexOf(`exit ${code}`);
  return h.order.slice(Math.max(0, at - 1), at + 1);
};

beforeEach(() => {
  h.order.length = 0;
  h.handlers.clear();
  h.webFails = false;
  h.startFails = false;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { h.order.push(`exit ${code ?? 0}`); }) as typeof process.exit);
  const realOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...a: any[]) => unknown) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      h.handlers.set(event, handler);
      return process;
    }
    if (event === 'exit') return process;
    return realOn(event as any, handler);
  }) as typeof process.on);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('src/index.ts', () => {
  it('names the lost writes right before the exit when the web UI fails to start', async () => {
    h.webFails = true;
    await freshDeposedWrites();
    await import('../../src/index');
    await vi.waitFor(() => expect(h.order).toContain('exit 1'), { timeout: 10_000, interval: 10 });
    expect(beforeExit(1)).toEqual(['named', 'exit 1']);
  });

  it('names the lost writes right before the exit when main() throws', async () => {
    h.startFails = true;
    await freshDeposedWrites();
    await import('../../src/index');
    await vi.waitFor(() => expect(h.order).toContain('exit 1'), { timeout: 10_000, interval: 10 });
    expect(beforeExit(1)).toEqual(['named', 'exit 1']);
  });

  it.each(['SIGTERM', 'SIGINT'])('names the lost writes after flushBeforeExit and right before the exit on %s', async signal => {
    await freshDeposedWrites();
    await import('../../src/index');
    await vi.waitFor(() => expect(h.handlers.has(signal)).toBe(true), { timeout: 10_000, interval: 10 });
    await h.handlers.get(signal)!();
    expect(h.order).toEqual(['flushBeforeExit', 'named', 'exit 0']);
  });
});

describe('src/bot/index.ts', () => {
  it('names the lost writes right before the exit when the boot throws', async () => {
    await freshDeposedWrites();
    await import('../../src/bot/index');
    await vi.waitFor(() => expect(h.order).toContain('exit 1'), { timeout: 10_000, interval: 10 });
    expect(beforeExit(1)).toEqual(['named', 'exit 1']);
  });
});
