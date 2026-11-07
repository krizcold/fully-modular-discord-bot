import { afterAll, describe, expect, it, vi } from 'vitest';

// NB10 test 8 (the entry's ends): the bot process releases the writer lock at exit, and a boot that fails logs why and
// exits with 1.

const ctl = vi.hoisted(() => ({ take: null as null | (() => Promise<void>), released: 0 }));
vi.mock('dotenv/config', () => ({}));
vi.mock('tsconfig-paths', () => ({ register: () => undefined }));
vi.mock('../../src/bot/internalSetup/clientInitializer', () => ({ main: async () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => ({
  ...(await orig<any>()),
  configureWriterLock: () => undefined,
  takeWriterLockForBoot: () => ctl.take!(),
  onDeposed: () => undefined,
  releaseWriterLockAtExit: () => { ctl.released++; },
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  installStopHandler: () => undefined,
  beginStop: () => undefined,
}));

const role = process.env.BOT_PROCESS_ROLE;
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('the bot process entry', () => {
  it('its exit handler releases the writer lock', async () => {
    vi.resetModules();
    ctl.take = async () => undefined;
    const exitHandlers: Array<(...args: any[]) => void> = [];
    const realOn = process.on.bind(process);
    const on = vi.spyOn(process, 'on').mockImplementation(((event: string, fn: (...args: any[]) => void) => {
      if (event === 'exit') {
        exitHandlers.push(fn);
        return process;
      }
      return realOn(event as any, fn);
    }) as typeof process.on);
    try {
      await import('../../src/bot/index');
      for (let i = 0; i < 100 && exitHandlers.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(exitHandlers).toHaveLength(1);
      expect(ctl.released).toBe(0);
      exitHandlers[0](0);
      expect(ctl.released).toBe(1);
    } finally {
      on.mockRestore();
    }
  });

  it('a boot that fails logs why and exits with 1', async () => {
    vi.resetModules();
    const failure = new Error('lock disk gone');
    ctl.take = async () => { throw failure; };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await import('../../src/bot/index');
      for (let i = 0; i < 100 && exit.mock.calls.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(errors).toHaveBeenCalledWith('[Main] The bot process could not start:', failure);
      expect(exit.mock.calls).toEqual([[1]]);
    } finally {
      errors.mockRestore();
      exit.mockRestore();
    }
  });
});
