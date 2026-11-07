import { describe, expect, it, vi } from 'vitest';

// NB10 test 8 (the entry's part): bot/index.ts loads clientInitializer only after the writer lock is held and the stop
// handler is installed. clientInitializer, the take and the stop handler are stand-ins that record the order.

const order = vi.hoisted(() => [] as string[]);
const take = vi.hoisted(() => ({ release: null as null | (() => void) }));
const deposed = vi.hoisted(() => ({ listeners: [] as Array<(holder: any) => void>, stops: [] as unknown[][] }));
vi.mock('dotenv/config', () => ({}));
vi.mock('tsconfig-paths', () => ({ register: () => undefined }));
vi.mock('../../src/bot/internalSetup/clientInitializer', () => {
  order.push('clientInitializer loaded');
  return { main: async () => undefined };
});
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => ({
  ...(await orig<any>()),
  configureWriterLock: (role: string) => { order.push(`configure ${role}`); },
  takeWriterLockForBoot: () => {
    order.push('take started');
    return new Promise<void>(resolve => { take.release = () => { order.push('lock held'); resolve(); }; });
  },
  onDeposed: (fn: (holder: any) => void) => { order.push('onDeposed'); deposed.listeners.push(fn); },
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  installStopHandler: () => { order.push('stop handler'); },
  beginStop: (...args: unknown[]) => { deposed.stops.push(args); },
}));

describe('the bot process entry', () => {
  it('loads clientInitializer only after the lock is held and the stop handler is installed', async () => {
    const exits = vi.spyOn(process, 'on');
    await import('../../src/bot/index');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(order).toEqual(['configure bot', 'take started']);
    take.release!();
    for (let i = 0; i < 100 && !order.includes('clientInitializer loaded'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(order).toEqual(['configure bot', 'take started', 'lock held', 'stop handler', 'onDeposed', 'clientInitializer loaded']);
    expect(exits.mock.calls.some(c => c[0] === 'exit')).toBe(true);
    exits.mockRestore();
  });

  it('a deposition reports deposed with the holder, then calls beginStop(true), the deposed stop, after the listeners of that run', async () => {
    expect(deposed.listeners).toHaveLength(1);
    const sent: any[] = [];
    const realSend = process.send;
    process.send = ((message: any) => { sent.push(message); return true; }) as any;
    try {
      deposed.listeners[0]({ pid: 31, role: 'import', start: null, at: 0 });
      expect(sent).toEqual([{ type: 'data:writer', data: { stage: 'deposed', holder: { role: 'import', pid: 31 } } }]);
      expect(deposed.stops).toEqual([]);
      await Promise.resolve();
      await Promise.resolve();
      expect(deposed.stops).toEqual([[true]]);
    } finally {
      process.send = realSend;
    }
  });
});
