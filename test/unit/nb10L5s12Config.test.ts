import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const inject = vi.hoisted(() => ({ active: false, thrown: undefined as unknown }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    readRawStrict: (p: string) => {
      if (inject.active) throw inject.thrown;
      return real.readRawStrict(p);
    },
  };
});

import { ensureConfigPopulated, ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';

// NB10 test 24 (the edges): the root config.json is written over only when it holds a JSON object; any other text, or a
// read that fails however it fails, leaves it as it is with the log line, and a queued write answers 'written'.

const leftLine = (why: string) => `[ConfigManager] config.json cannot be read (${why}); left it as it is`;

function seed(text: string): void {
  fs.mkdirSync(path.dirname(ROOT_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(ROOT_CONFIG_PATH, text);
}

beforeEach(async () => {
  await flushAll();
  fs.rmSync(ROOT_CONFIG_PATH, { recursive: true, force: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  inject.active = false;
  inject.thrown = undefined;
  vi.restoreAllMocks();
  await flushAll();
});

describe('the populate of a root config.json', () => {
  it('a JSON object keeps its schema values, loses the others, and answers written', async () => {
    seed('{"DEVS":["9"],"custom":1}');
    expect(ensureConfigPopulated()).toBe('written');
    await flushAll();
    const stored = JSON.parse(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8'));
    expect(stored.DEVS).toEqual(['9']);
    expect(stored).not.toHaveProperty('custom');
    expect(Object.keys(stored)).toContain('outageNotice.dataLoading');
  });

  for (const text of ['5', 'null', '"text"', 'true', '[1]']) {
    it(`a file holding ${text} is left byte for byte, saying it is not a JSON object`, async () => {
      seed(text);
      expect(ensureConfigPopulated()).toBe('left');
      await flushAll();
      expect(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8')).toBe(text);
      expect(console.error).toHaveBeenCalledWith(leftLine('not a JSON object'));
    });
  }

  it('a read failure with no code is left, naming the error', async () => {
    seed('{"DEVS":["8"]}');
    inject.active = true;
    inject.thrown = new Error('boom');
    expect(ensureConfigPopulated()).toBe('left');
    await flushAll();
    expect(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8')).toBe('{"DEVS":["8"]}');
    expect(console.error).toHaveBeenCalledWith(leftLine('Error: boom'));
  });

  it('a read that throws null is left, naming it', async () => {
    seed('{"DEVS":["7"]}');
    inject.active = true;
    inject.thrown = null;
    expect(ensureConfigPopulated()).toBe('left');
    await flushAll();
    expect(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8')).toBe('{"DEVS":["7"]}');
    expect(console.error).toHaveBeenCalledWith(leftLine('null'));
  });
});
