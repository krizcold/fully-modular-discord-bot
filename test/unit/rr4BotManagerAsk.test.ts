import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { fork } from 'child_process';
import { BotManager, b2Line } from '../../src/webui/botManager';
import { resetAddressesForTests } from '../../src/utils/databaseAddress';
import { forks, forkStage } from '../helpers/forkMock';
import { exitChild, freshWriterLock, logged, resetForks, sentTo, tick } from '../helpers/nb10Rig';

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let managers: BotManager[] = [];

beforeEach(() => {
  resetForks();
  forkStage.stages = ['shared', 'guild'];
  freshWriterLock('webui');
  resetAddressesForTests();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  managers = [];
});

afterEach(() => {
  vi.useRealTimers();
  for (const manager of managers) manager.cancelCrashRestart();
  for (const child of forks.children) if (child.exitCode === null && child.signalCode === null) exitChild(child, 0);
  vi.restoreAllMocks();
});

const ATTEMPT = 'a-1';

function fresh(): BotManager {
  const manager = new BotManager();
  managers.push(manager);
  return manager;
}

async function started(): Promise<{ manager: BotManager; child: any }> {
  const manager = fresh();
  const result = await manager.start();
  expect(result.success).toBe(true);
  await tick(5);
  return { manager, child: forks.children.at(-1) };
}

const answers = (child: any): any[] => sentTo(child, 'reshard:standby-state').map(m => m.data);

function ask(child: any, data: unknown): void {
  child.emit('message', { type: 'control:reshard-standby', data });
}

const roomy = (manager: BotManager): void => manager.noteMemoryReading({ room: true, useMb: 300, freeMb: 900, at: new Date().toISOString() });

describe("'control:start-webui' from the bot process", () => {
  it('restarts the web-UI listener once and logs why', async () => {
    const { manager, child } = await started();
    const control = { stop: vi.fn(), start: vi.fn() };
    manager.setWebUiControl(control);
    child.emit('message', { type: 'control:start-webui' });
    expect(control.start).toHaveBeenCalledTimes(1);
    expect(control.stop).not.toHaveBeenCalled();
    expect(logged(warn)).toContain('[BotManager] control:start-webui received; restarting the web-UI listener');
  });

  it('a message of an unknown type starts no listener and logs nothing', async () => {
    const { manager, child } = await started();
    const control = { stop: vi.fn(), start: vi.fn() };
    manager.setWebUiControl(control);
    child.emit('message', { type: 'something:unknown' });
    expect(control.start).not.toHaveBeenCalled();
    expect(control.stop).not.toHaveBeenCalled();
    expect(logged(warn).some(l => l.includes('web-UI listener'))).toBe(false);
  });
});

describe("the memory reason of a refused ask", () => {
  it('a reading exactly 15 min old is still fresh: the answer names no room, not its age', async () => {
    const { manager, child } = await started();
    vi.useFakeTimers({ toFake: ['Date'] });
    manager.noteMemoryReading({ room: false, useMb: 300, freeMb: 900, at: new Date(Date.now() - 15 * 60_000).toISOString() });
    ask(child, { attempt: ATTEMPT, to: 8 });
    vi.useRealTimers();
    const reason = 'the memory reading shows no room (900 MB free, 300 MB used)';
    expect(answers(child)).toEqual([{ attempt: ATTEMPT, state: 'refused', kind: 'memory', reason }]);
    expect(logged(warn)).toContain(b2Line(reason));
  });

  it("room null with no error: the reason says 'no error given'", async () => {
    const { manager, child } = await started();
    manager.noteMemoryReading({ room: null, useMb: null, freeMb: null, at: new Date().toISOString() });
    ask(child, { attempt: ATTEMPT, to: 8 });
    expect(answers(child)).toEqual([{
      attempt: ATTEMPT, state: 'refused', kind: 'memory',
      reason: "can't confirm there is room: the manager could not take the memory reading (no error given)",
    }]);
  });

  it("room false with no figures: '?' for each", async () => {
    const { manager, child } = await started();
    manager.noteMemoryReading({ room: false, useMb: null, freeMb: null, at: new Date().toISOString() });
    ask(child, { attempt: ATTEMPT, to: 8 });
    expect(answers(child)).toEqual([{
      attempt: ATTEMPT, state: 'refused', kind: 'memory', reason: 'the memory reading shows no room (? MB free, ? MB used)',
    }]);
  });
});

describe("an ask's attempt and count", () => {
  it.each([
    ['an empty attempt', { attempt: '', to: 8 }],
    ['a number for the attempt', { attempt: 5, to: 8 }],
    ['no attempt', { to: 8 }],
    ['a count of 0', { attempt: ATTEMPT, to: 0 }],
    ['a negative count', { attempt: ATTEMPT, to: -3 }],
    ['a count that is no number', { attempt: ATTEMPT, to: 'x' }],
    ['a fractional count', { attempt: ATTEMPT, to: 2.5 }],
  ])('%s: no answer, no fork, no log', async (_name, data) => {
    const { child } = await started();
    ask(child, data);
    expect(answers(child)).toEqual([]);
    expect(forks.children).toHaveLength(1);
    expect(logged(warn).some(l => l.includes('second bot process'))).toBe(false);
  });

  it('an ask with no data at all is ignored without throwing', async () => {
    const { child } = await started();
    expect(() => child.emit('message', { type: 'control:reshard-standby' })).not.toThrow();
    expect(answers(child)).toEqual([]);
    expect(forks.children).toHaveLength(1);
  });

  it('a count of 1 is answered (refused for no reading)', async () => {
    const { child } = await started();
    ask(child, { attempt: ATTEMPT, to: 1 });
    expect(answers(child)).toEqual([{ attempt: ATTEMPT, state: 'refused', kind: 'memory', reason: 'the manager has sent no memory reading' }]);
  });
});

describe('an ask during a restart', () => {
  it("the new child of a restart from stopped asks before the restart settles: 'the bot is being stopped or restarted'", async () => {
    const manager = fresh();
    roomy(manager);
    const restarting = manager.restart();
    const child = forks.children.at(-1);
    expect(child.killed).not.toBe(true);
    ask(child, { attempt: ATTEMPT, to: 8 });
    expect(answers(child)).toEqual([{ attempt: ATTEMPT, state: 'refused', kind: 'passing', reason: 'the bot is being stopped or restarted' }]);
    expect((await restarting).success).toBe(true);
  });

  it("a restart the bot process asked for, queued behind an operation: 'the bot is being stopped or restarted'", async () => {
    const { manager, child } = await started();
    roomy(manager);
    (manager as any).operationInProgress = true;
    child.emit('message', { type: 'control:restart-bot', data: { reason: 'test' } });
    const queued = (manager as any).queuedRestart as Promise<unknown>;
    expect(queued).not.toBe(null);
    ask(child, { attempt: ATTEMPT, to: 8 });
    expect(answers(child)).toEqual([{ attempt: ATTEMPT, state: 'refused', kind: 'passing', reason: 'the bot is being stopped or restarted' }]);
    (manager as any).operationInProgress = false;
    await queued;
  });
});

describe("the standby's fork", () => {
  it.each([
    [undefined, '1'],
    [4, '4'],
    [0, '1'],
    [-2, '1'],
    ['x', '1'],
  ])('maxConcurrency %s forks with SMDB_RESHARD_MC %s', async (maxConcurrency, mc) => {
    const { manager, child } = await started();
    roomy(manager);
    ask(child, { attempt: ATTEMPT, to: 8, json: true, ...(maxConcurrency !== undefined ? { maxConcurrency } : {}) });
    expect(answers(child)).toEqual([{ attempt: ATTEMPT, state: 'started' }]);
    expect(forks.children).toHaveLength(2);
    expect((fork as any).mock.calls.at(-1)[2].env.SMDB_RESHARD_MC).toBe(mc);
  });

  it("a JSON ask whose fork throws a non-Error: 'ended' with 'Unknown error', and the error logged", async () => {
    const { manager, child } = await started();
    roomy(manager);
    (fork as any).mockImplementationOnce(() => { throw 'spawn refused'; });
    ask(child, { attempt: ATTEMPT, to: 8, json: true });
    expect(answers(child)).toEqual([{ attempt: ATTEMPT, state: 'ended', reason: 'the second bot process could not be started (Unknown error)' }]);
    expect(logged(error)).toContain('[BotManager] Error starting bot: Unknown error');
  });

  it("a JSON ask whose fork throws an Error: 'ended' with its message", async () => {
    const { manager, child } = await started();
    roomy(manager);
    (fork as any).mockImplementationOnce(() => { throw new Error('EAGAIN'); });
    ask(child, { attempt: ATTEMPT, to: 8, json: true });
    expect(answers(child)).toEqual([{ attempt: ATTEMPT, state: 'ended', reason: 'the second bot process could not be started (EAGAIN)' }]);
  });

  it('a Postgres ask whose fork throws: no answer at all', async () => {
    const { manager, child } = await started();
    roomy(manager);
    (fork as any).mockImplementationOnce(() => { throw new Error('EAGAIN'); });
    ask(child, { attempt: ATTEMPT, to: 8, entry: 'postgres://db-a/x' });
    expect(answers(child)).toEqual([]);
    expect(logged(error)).toContain('[BotManager] Error starting bot: EAGAIN');
  });
});
