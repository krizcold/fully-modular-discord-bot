import { describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { DataBackendUnavailableError, drainForExit, updateRawTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';

// Its own file: the drain closes writes for good in this process.
describe('a raw update once the exit drain has closed', () => {
  it('throws node-stopping, records the refusal under its file and queues nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await drainForExit(200);
    setBackendKind('postgres');
    const abs = dataPath('global', 'rk1-exit.json');
    const ledger = openLedger('panel');
    let thrown: unknown;
    try { runInLedger(ledger, 'mod', () => updateRawTracked(abs, {}, () => ({ a: 1 }))); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(DataBackendUnavailableError);
    expect((thrown as DataBackendUnavailableError).causeKey).toBe('node-stopping');
    expect(ledger.refusedDocs()).toEqual([expect.objectContaining({ cause: 'node-stopping', doc: `file:${abs}` })]);
    expect(rowQueue.ops('global/rk1-exit.json')).toHaveLength(0);
  });
});
