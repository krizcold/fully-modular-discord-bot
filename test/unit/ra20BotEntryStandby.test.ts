import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The bot process entry (src/bot/index.ts) as a standby (SMDB_RESHARD_STANDBY) and as a normal boot: what each
// installs before it serves, and what the standby's takeLock does at serve.

const ctl = vi.hoisted(() => ({
  deps: undefined as undefined | { takeLock?: () => Promise<void> },
  calls: [] as string[],
  deposed: [] as Array<(holder: { role?: string | null; pid: number }) => void>,
  stages: [] as unknown[][],
  stops: [] as unknown[],
}));
vi.mock('dotenv/config', () => ({}));
vi.mock('tsconfig-paths', () => ({ register: () => undefined }));
vi.mock('../../src/bot/internalSetup/clientInitializer', () => ({ main: async () => { ctl.calls.push('main'); } }));
vi.mock('../../src/bot/internalSetup/fleet/standbyBoot', () => ({
  standbyMain: async (deps: { takeLock?: () => Promise<void> }) => { ctl.calls.push('standbyMain'); ctl.deps = deps; },
}));
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => ({
  ...(await orig<any>()),
  configureWriterLock: (role: string) => { ctl.calls.push(`configure:${role}`); },
  takeWriterLockForBoot: async () => { ctl.calls.push('take'); },
  onDeposed: (fn: (holder: { role?: string | null; pid: number }) => void) => { ctl.deposed.push(fn); },
  reportWriterStage: (...args: unknown[]) => { ctl.stages.push(args); },
  releaseWriterLockAtExit: () => { ctl.calls.push('release'); },
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  installStopHandler: () => { ctl.calls.push('stopHandler'); },
  beginStop: (force: unknown) => { ctl.stops.push(force); },
}));

const saved = { role: process.env.BOT_PROCESS_ROLE, standby: process.env.SMDB_RESHARD_STANDBY, send: process.send };
let messageListeners: Function[];
let exitHandlers: Array<(...args: any[]) => void>;

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5));
}

beforeEach(() => {
  vi.resetModules();
  ctl.deps = undefined;
  ctl.calls = [];
  ctl.deposed = [];
  ctl.stages = [];
  ctl.stops = [];
  messageListeners = process.listeners('message');
  exitHandlers = [];
  const realOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, fn: (...args: any[]) => void) => {
    if (event === 'exit') {
      exitHandlers.push(fn);
      return process;
    }
    return realOn(event as any, fn);
  }) as typeof process.on);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of process.listeners('message')) if (!messageListeners.includes(fn)) process.off('message', fn as any);
  process.send = saved.send;
  if (saved.role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = saved.role;
  if (saved.standby === undefined) delete process.env.SMDB_RESHARD_STANDBY;
  else process.env.SMDB_RESHARD_STANDBY = saved.standby;
});

const reading = { room: true, useMb: 300, freeMb: 900, ageMs: 10 };

describe('the standby entry', () => {
  it('serves without the lock, answers the manager, releases at exit, and takes the lock at serve', async () => {
    process.env.SMDB_RESHARD_STANDBY = '1';
    const sent: any[] = [];
    process.send = ((m: any) => { sent.push(m); return true; }) as any;

    await import('../../src/bot/index');
    await until(() => ctl.deps !== undefined || ctl.calls.includes('main'));

    expect(ctl.calls).toEqual(['stopHandler', 'standbyMain']);
    expect(typeof ctl.deps?.takeLock).toBe('function');

    process.emit('message' as any, { type: 'data:addresses', data: { id: 's1', url: 'postgresql://bot:pw@db1:5432/bot' } } as any);
    expect(sent).toEqual([{ type: 'data:addresses-ack', data: { id: 's1', accepted: true } }]);

    const { heartbeatMemory } = await import('../../src/utils/memoryReading');
    expect(heartbeatMemory()).toBeNull();
    process.emit('message' as any, { type: 'memory:reading', data: reading } as any);
    expect(heartbeatMemory()).toMatchObject({ room: true, useMb: 300, freeMb: 900, error: null });

    expect(exitHandlers).toHaveLength(1);
    exitHandlers[0](0);
    expect(ctl.calls.filter(c => c === 'release')).toHaveLength(1);

    ctl.calls = [];
    expect(ctl.deposed).toHaveLength(0);
    await ctl.deps!.takeLock!();
    expect(ctl.calls).toEqual(['configure:bot', 'take']);
    expect(ctl.deposed).toHaveLength(1);

    ctl.deposed[0]({ role: 'bot', pid: 4242 });
    expect(ctl.stages).toEqual([['deposed', { holder: { role: 'bot', pid: 4242 } }]]);
    await until(() => ctl.stops.length > 0);
    expect(ctl.stops).toEqual([true]);
  });
});

describe('the normal entry', () => {
  it('keeps a memory reading the manager pushes', async () => {
    delete process.env.SMDB_RESHARD_STANDBY;
    await import('../../src/bot/index');
    await until(() => ctl.calls.includes('main'));
    expect(ctl.calls).toContain('main');
    expect(ctl.calls).not.toContain('standbyMain');

    const { heartbeatMemory } = await import('../../src/utils/memoryReading');
    process.emit('message' as any, { type: 'memory:reading', data: reading } as any);
    expect(heartbeatMemory()).toMatchObject({ room: true, useMb: 300, freeMb: 900, error: null });
  });
});
