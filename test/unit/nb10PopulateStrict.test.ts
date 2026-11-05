import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const inject = vi.hoisted(() => ({ readError: null as string | null, path: '' }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    readRawStrict: (p: string) => {
      if (inject.readError && p === inject.path) throw Object.assign(new Error(`${inject.readError}: permission denied, open '${p}'`), { code: inject.readError });
      return real.readRawStrict(p);
    },
  };
});

import { ensureConfigPopulated, ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';

// NB10 test 24: a root config.json that cannot be read or parsed is left as it is; an absent one is written.

afterEach(async () => {
  inject.readError = null;
  vi.restoreAllMocks();
  await flushAll();
  fs.rmSync(ROOT_CONFIG_PATH, { recursive: true, force: true });
});

describe('the populate of the root config', () => {
  it('leaves a config.json holding invalid JSON byte for byte, with the log line', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.mkdirSync(path.dirname(ROOT_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(ROOT_CONFIG_PATH, '{"DEVS": ["1"],');
    ensureConfigPopulated();
    await flushAll();
    expect(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8')).toBe('{"DEVS": ["1"],');
    expect(errors.mock.calls.some(c => /^\[ConfigManager\] config\.json cannot be read \(.+\); left it as it is$/.test(String(c[0])))).toBe(true);
  });

  it('leaves a config.json that cannot be read (EACCES) byte for byte and queues nothing for it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.mkdirSync(path.dirname(ROOT_CONFIG_PATH), { recursive: true });
    const bytes = '{"DEVS":["1"],"custom":true}';
    fs.writeFileSync(ROOT_CONFIG_PATH, bytes);
    inject.path = ROOT_CONFIG_PATH;
    inject.readError = 'EACCES';
    expect(ensureConfigPopulated()).toBe('left');
    expect(queuedFilePaths()).not.toContain(ROOT_CONFIG_PATH);
    await flushAll();
    expect(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8')).toBe(bytes);
    expect(errors.mock.calls.some(c => String(c[0]) === '[ConfigManager] config.json cannot be read (EACCES); left it as it is')).toBe(true);
  });

  it('writes an absent config.json from the schema', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    ensureConfigPopulated();
    await flushAll();
    expect(JSON.parse(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8'))).toHaveProperty('DEVS');
  });
});
