import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { DataBackendUnavailableError } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';

// The bot process's stop when a step outside the stop steps throws, and the refusal a raw write records once the
// exit drain has closed the facade.

const EVENTS = ['SIGTERM', 'SIGINT', 'uncaughtException'] as const;
const emitter = process as unknown as { listeners(event: string): Function[]; off(event: string, listener: Function): void };
const before = Object.fromEntries(EVENTS.map(event => [event, emitter.listeners(event)])) as Record<string, Function[]>;

afterEach(() => {
  for (const event of EVENTS) {
    for (const listener of emitter.listeners(event)) if (!before[event].includes(listener)) emitter.off(event, listener);
  }
  dm.useDeposedWrites(null);
  vi.restoreAllMocks();
});

describe('a stop whose exit drain throws', () => {
  it('logs the error with its line and still exits', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const boom = new Error('sa9: the deposed writes could not be asked');
    dm._resetStopHandler();
    dm.useDeposedWrites({ answered: () => { throw boom; }, nameLeft: () => undefined });
    dm.installStopHandler();
    await expect(dm.beginStop()).resolves.toBeUndefined();
    expect(errors).toContainEqual(['[Data] A stop step failed; the bot process exits:', boom]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    dm._resetStopHandler();
  });
});

describe('a raw write after the exit drain closed the facade', () => {
  it("is refused as node-stopping, and the ledger names the file's document", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await dm.drainForExit(1000).catch(() => undefined);
    expect(dm.isClosedForExit()).toBe(true);
    const file = dataPath('global', 'sa9', 'raw.json');
    const ledger = openLedger('console');
    expect(() => runInLedger(ledger, 'sa9mod', () => dm.writeRawAtomicTracked(file, '{"a":1}'))).toThrow(DataBackendUnavailableError);
    expect(ledger.refusedDocs()).toEqual([{ cause: 'node-stopping', doc: `file:${file}`, seq: expect.any(Number), retried: false }]);
  });
});
