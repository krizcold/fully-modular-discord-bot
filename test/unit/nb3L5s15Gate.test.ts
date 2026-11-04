import { afterAll, describe, expect, it, vi } from 'vitest';
import { startWebUI } from '../../src/webui/index';
import { flushAll, saveDataTracked, setGuildWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { DataBackendUnavailableError } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { setBackendKind } from '../helpers/backendKind';
import { freshJsonBot } from '../helpers/migrationRig';

// NB3 decision 4: the web UI process installs the guild write gate before it builds its server, and the gate
// refuses that process's guild writes while a data migration runs.

vi.mock('../../src/webui/server', () => ({
  createServer: async () => { throw new Error('nb3L5s15: no server in this test'); },
}));

const G = '343434343434343434';
const lock = { running: null as null | { jobId: string; to: string } };

afterAll(() => setGuildWriteGate(null));

describe('startWebUI', () => {
  it('installs a gate that refuses guild writes while a job runs, saying so', async () => {
    freshJsonBot();
    setBackendKind('file');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(startWebUI({ migrationRunning: () => lock.running } as any)).rejects.toThrow(/no server in this test/);
    lock.running = { jobId: 'job-s15-g001', to: 'postgres' };
    let thrown: unknown = null;
    try {
      saveDataTracked('a.json', { guildId: G, category: 'mod' }, { a: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DataBackendUnavailableError);
    expect((thrown as Error).message).toBe('[Data] A data migration is running; the write was not saved');
    lock.running = null;
    expect(saveDataTracked('a.json', { guildId: G, category: 'mod' }, { a: 1 }).outcome).toBe('saved');
    await flushAll();
  });
});
