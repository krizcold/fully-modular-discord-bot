import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  metadata: null as null | Record<string, unknown>,
  outcome: null as null | Record<string, unknown>,
}));

vi.mock('../../src/bot/internalSetup/utils/configDiscovery', async orig => ({
  ...(await orig<any>()),
  getConfigFileMetadata: (fileId: string) => (h.metadata && h.metadata.id === fileId ? h.metadata : null),
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<any>();
  return { ...real, saveDataTracked: (...args: unknown[]) => h.outcome ?? real.saveDataTracked(...args) };
});

import { ConfigWriteRefused, saveGlobalConfig } from '../../src/bot/internalSetup/utils/configManager';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

// NB12 (wip-redesign/sheets/NB12.md): a global config write says "Saved" only when the data layer saved it, and a
// discovered config file outside the data namespaces is written to its own path.

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  h.metadata = null;
  h.outcome = null;
});

const saidSaved = () => vi.mocked(console.log).mock.calls.some(c => String(c[0]).startsWith('[ConfigManager] Saved config'));

describe('saveGlobalConfig', () => {
  it('a module config write the data layer answers frozen throws with that cause and is not logged as saved', () => {
    h.metadata = { id: 'nb12l5s4.json', path: dataPath('global', 'nb12l5s4mod', 'nb12l5s4.json'), name: 'n', description: 'd', category: 'data', exists: false, moduleName: 'nb12l5s4mod' };
    h.outcome = { outcome: 'frozen' };
    let thrown: unknown;
    try {
      saveGlobalConfig('nb12l5s4.json', { a: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigWriteRefused);
    expect((thrown as ConfigWriteRefused).refusal).toEqual({ cause: 'frozen' });
    expect((thrown as Error).message).toBe('the config was not saved');
    expect(saidSaved()).toBe(false);
  });

  it('a discovered config file with a path and no module is written there', async () => {
    const file = dataPath('nb12l5s4-config', 'own.json');
    h.metadata = { id: 'own.json', path: file, name: 'n', description: 'd', category: 'config', exists: false };
    saveGlobalConfig('own.json', { kept: true });
    await flushAll();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ kept: true });
    expect(saidSaved()).toBe(true);
  });
});
