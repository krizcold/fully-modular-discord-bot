import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as loaded from '../../src/bot/internalSetup/utils/dataManager';

// NB10 mutation survivors (chunk 8): the bot process's one stop. SIGTERM and SIGINT start it, a deposed stop exits 75,
// a failing stop step or after-drain step is logged and the rest still run, and a second install adds no listener.
// The stop runs once per module instance, so each test takes a fresh one.

type Dm = typeof loaded;
const EVENTS: string[] = ['SIGTERM', 'SIGINT', 'uncaughtException'];
let before: Record<string, Function[]>;
let exits: Array<number | undefined>;

async function fresh(): Promise<Dm> {
  vi.resetModules();
  return (await import('../../src/bot/internalSetup/utils/dataManager')) as Dm;
}

beforeEach(() => {
  before = Object.fromEntries(EVENTS.map(e => [e, process.listeners(e as any)]));
  exits = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exits.push(code); return undefined as never; }) as typeof process.exit);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const e of EVENTS) for (const l of process.listeners(e as any)) if (!before[e].includes(l)) process.off(e as any, l as any);
  vi.restoreAllMocks();
});

function handlerFor(spy: { mock: { calls: unknown[][] } }, event: string): (() => void) | undefined {
  return spy.mock.calls.find(c => c[0] === event)?.[1] as (() => void) | undefined;
}

describe('the signals that start the stop', () => {
  it('SIGTERM runs the stop and the process exits 0', async () => {
    expect(typeof loaded.installStopHandler).toBe('function');
    const dm = await fresh();
    const on = vi.spyOn(process, 'on');
    dm.installStopHandler();
    const handler = handlerFor(on, 'SIGTERM');
    expect(handler).toBeTypeOf('function');
    handler!();
    await vi.waitFor(() => expect(exits).toEqual([0]), { timeout: 2000, interval: 5 });
  });

  it('SIGINT runs the stop and the process exits 0', async () => {
    const dm = await fresh();
    const on = vi.spyOn(process, 'on');
    dm.installStopHandler();
    const handler = handlerFor(on, 'SIGINT');
    expect(handler).toBeTypeOf('function');
    handler!();
    await vi.waitFor(() => expect(exits).toEqual([0]), { timeout: 2000, interval: 5 });
  });

  it('a second install adds no second listener', async () => {
    const dm = await fresh();
    const term = process.listenerCount('SIGTERM');
    const int = process.listenerCount('SIGINT');
    dm.installStopHandler();
    dm.installStopHandler();
    expect(process.listenerCount('SIGTERM')).toBe(term + 1);
    expect(process.listenerCount('SIGINT')).toBe(int + 1);
  });
});

describe('the stop of a deposed process', () => {
  it('exits with EXIT_DEPOSED (75)', async () => {
    const dm = await fresh();
    dm.installStopHandler();
    await dm.beginStop(true);
    expect(exits).toEqual([75]);
  });
});

describe('failing stop steps', () => {
  it('logs a failed stop step and still runs the next, and logs a failing final step added after the stop', async () => {
    const dm = await fresh();
    const first = new Error('step one broke');
    let secondRan = false;
    dm.addStopStep(() => { throw first; });
    dm.addStopStep(() => { secondRan = true; });
    dm.installStopHandler();
    await dm.beginStop();
    expect(exits).toEqual([0]);
    expect(secondRan).toBe(true);
    const error = console.error as unknown as { mock: { calls: unknown[][] } };
    expect(error.mock.calls).toContainEqual(['[Data] A stop step failed:', first]);

    const late = new Error('late final step broke');
    dm.addFinalStopStep(() => { throw late; });
    await vi.waitFor(() => expect(error.mock.calls).toContainEqual(['[Data] A stop step failed:', late]), { timeout: 1000, interval: 5 });
  });
});

describe('the steps after the exit drain', () => {
  it('answers false when no step queued a write, logs a failing step and still runs the next', async () => {
    const dm = await fresh();
    dm.addAfterDrainStep(() => false);
    expect(dm.runAfterDrainSteps()).toBe(false);
    const broke = new Error('after-drain step broke');
    let laterRan = false;
    dm.addAfterDrainStep(() => { throw broke; });
    dm.addAfterDrainStep(() => { laterRan = true; return false; });
    expect(dm.runAfterDrainSteps()).toBe(false);
    expect(laterRan).toBe(true);
    const error = console.error as unknown as { mock: { calls: unknown[][] } };
    expect(error.mock.calls).toContainEqual(['[Data] A step after the exit drain failed:', broke]);
  });
});
