import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/configDiscovery', async orig => {
  const real = await orig<any>();
  const { dataPath } = await import('../../src/utils/dataRoot');
  return {
    ...real,
    findDataFileMetadata: (fileId: string, guildId?: string) => {
      if (fileId !== 'mod/foo.json' || guildId) return real.findDataFileMetadata(fileId, guildId);
      return {
        id: 'foo.json', path: dataPath('global', 'mod', 'foo.json'), name: 'Foo', description: 'A global data file of module mod',
        category: 'data', exists: true, required: false, template: undefined, scope: 'global', moduleName: 'mod',
      };
    },
    getConfigFileMetadata: (id: string) => {
      if (id !== 'nb12cfg.json') return real.getConfigFileMetadata(id);
      return {
        id, path: dataPath('global', 'm', id), name: 'Nb12', description: 'A global module config', category: 'config', exists: true,
        schema: { id, name: 'Nb12', description: 'A global module config', properties: {} }, moduleName: 'm',
      };
    },
  };
});

import { setBackendKind } from '../helpers/backendKind';
import { flushAll, readRawStrict } from '../../src/bot/internalSetup/utils/dataManager';
import { filesPending } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { applyOperatorDataRead, applyOperatorGlobalRead } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { dataPath } from '../../src/utils/dataRoot';
import { FakeChild, backupNames, call, resetData, startConfigApp } from '../helpers/configRig';

// NB12 code review round 3, NB12-DL-R3-1 (wip-redesign/sheets/NB12.md decision 10): a folder in a file's place reads
// as absent only under a guild folder, where the write's placement check runs; on a global data file, a module
// config and the root config it stays an error, and nothing is written over it.

const G = '444444444444444444';
const child = new FakeChild();
let base = '';
let close: () => Promise<void>;

beforeAll(async () => {
  ({ url: base, close } = await startConfigApp(child));
});
afterAll(async () => { await close(); });
beforeEach(async () => {
  child.reset();
  setBackendKind('file');
  await resetData();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

const globalData = () => dataPath('global', 'mod', 'foo.json');
const moduleConfig = () => dataPath('global', 'm', 'nb12cfg.json');

describe('readRawStrict over a folder in a file\'s place, by path kind', () => {
  it('a guild data path answers absent', () => {
    fs.mkdirSync(dataPath(G, 'm', 'foo.json'), { recursive: true });
    expect(readRawStrict(dataPath(G, 'm', 'foo.json'))).toBeNull();
  });

  it.each([
    ['a global data file', globalData],
    ['a global module config', moduleConfig],
    ['the root config', () => ROOT_CONFIG_PATH],
    ['a numeric name at the data root', () => dataPath('555555555555555555')],
    ['a graveyard entry', () => dataPath('_graveyard', `${G}-1`, 'm', 'foo.json')],
  ])('%s throws, never answers absent', (_label, target) => {
    fs.mkdirSync(target(), { recursive: true });
    expect(() => readRawStrict(target())).toThrow();
  });

  it('the bot\'s global read of a folder answers unreadable, and of a guild key answers ok with no content', async () => {
    fs.mkdirSync(globalData(), { recursive: true });
    fs.mkdirSync(ROOT_CONFIG_PATH, { recursive: true });
    fs.mkdirSync(dataPath(G, 'm', 'foo.json'), { recursive: true });
    expect(applyOperatorGlobalRead({ rel: 'mod/foo.json' })).toMatchObject({ ok: false, code: 'unreadable' });
    expect(applyOperatorGlobalRead({ root: 'config' })).toMatchObject({ ok: false, code: 'unreadable' });
    const guild = await applyOperatorDataRead({ guildId: G, module: 'm', filename: 'foo.json' });
    expect(guild.ok).toBe(true);
  });
});

describe('a save over a folder in a global file\'s place', () => {
  const cases: Array<[string, () => Promise<{ status: number; body: any }>, () => string]> = [
    ['/data/update of a global data file', () => call(base, 'POST', '/api/config/data/update', { file: 'mod/foo.json', data: { b: 2 } }), globalData],
    ['/update of a global module config', () => call(base, 'POST', '/api/config/update', { file: 'nb12cfg.json', config: { b: 2 } }), moduleConfig],
    ['/update of the root config', () => call(base, 'POST', '/api/config/update', { file: 'config.json', config: { b: 2 } }), () => ROOT_CONFIG_PATH],
  ];

  for (const running of [true, false]) {
    it.each(cases)(`%s answers 500 unreadable and queues nothing (bot ${running ? 'running' : 'down'})`, async (_label, act, target) => {
      fs.mkdirSync(target(), { recursive: true });
      child.running = running;
      const answer = await act();
      expect(answer.status).toBe(500);
      expect(answer.body.success).toBe(false);
      expect(answer.body.error).toMatch(/could not be read/);
      expect(filesPending([target()])).toBe(false);
      await flushAll();
      expect(fs.statSync(target()).isDirectory()).toBe(true);
      expect(backupNames()).toEqual([]);
    });
  }
});
