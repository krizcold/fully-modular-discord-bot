import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB9 test 3, the cells that drive BotManager (O6 C1, O8 C1's address list, O8 C5, J4 C1, J4 C2, J4 C5, J4 C9): a real
// start() with the forkMock children, the bot process's and the standby's IPC messages as the bot side sends them.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, B4_LINE, B7_LINE, b3Line, b5Line, b6Line, b9Line } from '../../src/webui/botManager';
import { acceptAddressList, resetAddressesForTests } from '../../src/utils/databaseAddress';
import { forks, forkStage } from '../helpers/forkMock';
import { exitChild, freshWriterLock, logged, resetForks, sentTo, tick } from '../helpers/nb10Rig';

let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
let managers: BotManager[] = [];
const lines = (): string[] => [...logged(log), ...logged(warn)];

beforeEach(() => {
  resetForks();
  forkStage.stages = ['shared', 'guild'];
  freshWriterLock('webui');
  resetAddressesForTests();
  safety.recordCrash.mockClear();
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  managers = [];
});

afterEach(() => {
  vi.useRealTimers();
  for (const manager of managers) manager.cancelCrashRestart();
  for (const child of forks.children) if (child.exitCode === null && child.signalCode === null) exitChild(child, 0);
  vi.restoreAllMocks();
});

async function overlap(json = false): Promise<{ manager: BotManager; old: any; standby: any }> {
  const manager = new BotManager();
  managers.push(manager);
  await manager.start();
  await tick(5);
  const old = forks.children.at(-1);
  manager.noteMemoryReading({ room: true, useMb: 100, freeMb: 900, at: new Date().toISOString() });
  old.emit('message', { type: 'control:reshard-standby', data: { attempt: 'a', to: 4, intents: 1, maxConcurrency: 1, ...(json ? { json: true } : { entry: 'postgres://db/x' }) } });
  const standby = forks.children.at(-1);
  await tick(5);
  return { manager, old, standby };
}

const retire = (old: any, attempt: string | null = 'a'): void => { old.emit('message', { type: 'control:reshard-retire', data: { attempt } }); };

describe('test 3: the cells that drive BotManager', () => {
  it('O6 C1: the retire, B3, the stop of kind restart, promote() through adoptAsCurrent at the exit', async () => {
    const { manager, old, standby } = await overlap();
    forks.holdExit = true;
    retire(old);
    await tick(5);
    expect(lines()).toContain(b3Line(4));
    expect((manager as any).stopKind).toBe('restart');
    expect((manager as any).retiring?.child).toBe(old);
    exitChild(old, 0);
    forks.holdExit = false;
    await tick(5);
    expect((manager as any).botProcess).toBe(standby);
    expect((manager as any).stopKind).toBe(null);
    expect(lines()).toContain(B4_LINE);
  });

  it("O8 C1: the promotion gives the process the address list in use before 'reshard:promoted' (C7)", async () => {
    const { old, standby } = await overlap();
    acceptAddressList('postgres://db/x,postgres://copy/x');
    retire(old);
    await tick(40);
    const order = sentTo(standby).filter(m => m.type === 'data:addresses' || m.type === 'reshard:promoted');
    expect(order.map(m => m.type)).toEqual(['data:addresses', 'reshard:promoted']);
    expect(order[0].data.url).toBe('postgres://db/x,postgres://copy/x');
  });

  it('O8 C5: a crash of the promoted process is a crash restart (stopRequested false since the promotion)', async () => {
    const { manager, old, standby } = await overlap();
    retire(old);
    await tick(40);
    expect((manager as any).stopRequested).toBe(false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    exitChild(standby, 1);
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();
    expect(safety.recordCrash).toHaveBeenCalledTimes(1);
    expect(forks.children).toHaveLength(3);
  });

  it("J4 C1: the JSON retire, the old exits, promote() and 'reshard:promoted'", async () => {
    const { manager, old, standby } = await overlap(true);
    retire(old);
    await tick(40);
    expect((manager as any).botProcess).toBe(standby);
    expect(sentTo(standby, 'reshard:promoted').map(m => m.data)).toEqual([{ attempt: 'a' }]);
  });

  it('J4 C2: the retiring child alive 5 s after its SIGKILL: B6, B9 and a new child', async () => {
    const { manager, old, standby } = await overlap(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    forks.holdExit = true;
    retire(old);
    await vi.advanceTimersByTimeAsync(46_000);
    forks.holdExit = false;
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();
    expect(lines()).toContain(b6Line('the old bot process did not exit 5 s after it was killed'));
    expect(lines()).toContain(b9Line(5));
    expect(standby.signals).toContain('SIGTERM');
    expect((manager as any).botProcess).toBe(forks.children.at(-1));
    expect(forks.children).toHaveLength(3);
  });

  it('J4 C5: an old crash before any retire: B6 and the crash restart', async () => {
    const { old, standby } = await overlap(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    exitChild(old, 1);
    expect(lines()).toContain(b6Line('the bot process exited'));
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(forks.children).toHaveLength(3);
  });

  it('J4 C5: after the retire was acted on, any exit runs promote()', async () => {
    const { manager, old, standby } = await overlap(true);
    forks.holdExit = true;
    retire(old);
    await tick(5);
    exitChild(old, 1);
    forks.holdExit = false;
    await tick(5);
    expect((manager as any).botProcess).toBe(standby);
    expect(safety.recordCrash).not.toHaveBeenCalled();
  });

  it('J4 C5: a standby crash: B5, then B7 at the retire exit', async () => {
    const { old, standby } = await overlap(true);
    exitChild(standby, 1);
    expect(lines()).toContain(b5Line(1, null, null));
    retire(old);
    await tick(40);
    expect(lines()).toContain(B7_LINE);
    expect(forks.children).toHaveLength(3);
  });

  it("J4 C9: a Restart during the leave: B6; during B3's 40 s: promote()'s stopsRequested row, B6", async () => {
    const first = await overlap(true);
    await first.manager.restart();
    expect(lines()).toContain(b6Line('the bot is restarting'));
    const { manager, old, standby } = await overlap(true);
    forks.holdExit = true;
    retire(old);
    await tick(5);
    const restarting = manager.restart();
    await tick(5);
    exitChild(old, 0);
    forks.holdExit = false;
    await restarting;
    expect(lines()).toContain(b6Line('a stop or restart was asked during the hand-over'));
    expect(standby.signals).toEqual(['SIGTERM']);
  });
});
