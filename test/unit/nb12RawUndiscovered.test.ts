import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ lost: false }));
vi.mock('../../src/bot/internalSetup/utils/configDiscovery', async orig => {
  const real = await orig<any>();
  const { dataPath } = await import('../../src/utils/dataRoot');
  return {
    ...real,
    getConfigFileMetadata: (id: string) => {
      if (id !== 'orphan.json') return real.getConfigFileMetadata(id);
      return {
        id, path: dataPath('global', 'm', id), name: 'Orphan', description: 'A config file whose module discovery loses', category: 'config', exists: true,
        schema: { id, name: 'Orphan', description: 'A config file whose module discovery loses', properties: {} },
        moduleName: h.lost ? undefined : 'm',
      };
    },
  };
});

import { setBackendKind } from '../helpers/backendKind';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { saveGuildConfig, saveGuildConfigTracked } from '../../src/bot/internalSetup/utils/configManager';
import { dataPath } from '../../src/utils/dataRoot';
import { put, resetData } from '../helpers/configRig';

// NB12 item 4 (wip-redesign/sheets/NB12.md): a guild config name discovery does not place in a module is not written.
// Since NB10 the config routes send their writes by path to the bot process, so this is checked on configManager.

const G = '444444444444444444';
const stored = () => dataPath(G, 'm', 'orphan.json');

beforeEach(async () => {
  setBackendKind('file');
  h.lost = false;
  await resetData();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  h.lost = false;
  vi.restoreAllMocks();
});

describe('an undiscovered guild config name', () => {
  it("saveGuildConfigTracked answers 'undiscovered', saveGuildConfig 'refused', and the stored file keeps its bytes", async () => {
    put(stored(), { v: 1 });
    h.lost = true;
    expect(saveGuildConfigTracked('orphan.json', G, { v: 2 })).toEqual({ outcome: 'undiscovered' });
    expect(saveGuildConfig('orphan.json', G, { v: 3 })).toBe('refused');
    await flushAll();
    expect(fs.readFileSync(stored(), 'utf8')).toBe(JSON.stringify({ v: 1 }, null, 2));
  });

  it('the same name is written once discovery places it', async () => {
    put(stored(), { v: 1 });
    expect(saveGuildConfigTracked('orphan.json', G, { v: 2 })).toMatchObject({ outcome: 'saved' });
    await flushAll();
    expect(JSON.parse(fs.readFileSync(stored(), 'utf8'))).toEqual({ v: 2 });
  });
});
