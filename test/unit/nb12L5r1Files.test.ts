import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => ({
  ...(await importOriginal<any>()),
  awaitGuildDataReady: async () => true,
}));

import { appendDataTracked, deleteDataTracked, saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import {
  deleteRawAtomic,
  flushAll,
  guildDirExists,
  guildKeyStored,
  noteGuildWrite,
  setGuildViewCache,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

// NB12 (wip-redesign/sheets/NB12.md) on the file route: a raw delete never removes the guild folder, and a guild
// write or delete whose options lose their guildId between reads touches no other guild's view or file.

let guilds = 9_741_600_000;
const freshGuild = () => String(++guilds);
const OTHER = 'Stryker was here!';

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await flushAll();
  setGuildViewCache(false);
  fs.rmSync(dataPath(OTHER), { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Options whose guildId reads as the guild everywhere except where the given accept function reads it itself: its
 * own reads from the n-th on (1-based) answer undefined.
 */
function shifting(guildId: string, category: string, fn: string, from: number) {
  let own = 0;
  return {
    category,
    get guildId(): string | undefined {
      const caller = (new Error().stack ?? '').split('\n')[2] ?? '';
      if (new RegExp(`\\b${fn}\\b`).test(caller)) {
        own += 1;
        if (own >= from) return undefined;
      }
      return guildId;
    },
    ownReads: () => own,
  };
}

describe('a raw delete', () => {
  it('a delete through a doubled separator removes the file and keeps the emptied guild folder', async () => {
    const g = freshGuild();
    fs.mkdirSync(dataPath(g), { recursive: true });
    fs.writeFileSync(dataPath(g, 'f.json'), '{}');
    expect(deleteRawAtomic(dataPath(g) + path.sep + path.sep + 'f.json')).toBe(true);
    await flushAll();
    expect(fs.existsSync(dataPath(g, 'f.json'))).toBe(false);
    expect(fs.existsSync(dataPath(g))).toBe(true);
    expect(guildDirExists(g)).toBe(true);
  });
});

describe('a guild write whose guildId is gone at its last read', () => {
  it('a save adds its key to no other guild\'s view', async () => {
    setGuildViewCache(true);
    const g = freshGuild();
    expect(guildKeyStored(OTHER, 'cat/x.json')).toBe(false);
    const options = shifting(g, 'cat', 'acceptSave', 1);
    expect(saveDataTracked('x.json', options, { a: 1 }).outcome).toBe('saved');
    expect(options.ownReads()).toBeGreaterThan(0);
    expect(guildKeyStored(OTHER, 'cat/x.json')).toBe(false);
    await flushAll();
    expect(JSON.parse(fs.readFileSync(dataPath(g, 'cat', 'x.json'), 'utf8'))).toEqual({ a: 1 });
  });

  it('an append adds its key to no other guild\'s view', async () => {
    setGuildViewCache(true);
    const g = freshGuild();
    expect(guildKeyStored(OTHER, 'cat/x.jsonl')).toBe(false);
    const options = shifting(g, 'cat', 'acceptAppend', 1);
    expect(appendDataTracked('x.jsonl', options, '{"a":1}\n').outcome).toBe('appended');
    expect(options.ownReads()).toBeGreaterThan(0);
    expect(guildKeyStored(OTHER, 'cat/x.jsonl')).toBe(false);
    await flushAll();
    expect(fs.readFileSync(dataPath(g, 'cat', 'x.jsonl'), 'utf8')).toBe('{"a":1}\n');
  });
});

describe('a guild delete whose guildId is gone at a later read', () => {
  it('a delete that finds no guildId at its stored-key check answers absent and the guild\'s file stays', async () => {
    const g = freshGuild();
    fs.mkdirSync(dataPath(g, 'cat'), { recursive: true });
    fs.writeFileSync(dataPath(g, 'cat', 'f.json'), '{"keep":1}');
    fs.mkdirSync(dataPath(OTHER, 'cat'), { recursive: true });
    fs.writeFileSync(dataPath(OTHER, 'cat', 'f.json'), '{}');
    const options = shifting(g, 'cat', 'acceptDelete', 1);
    expect(deleteDataTracked('f.json', options).outcome).toBe('absent');
    expect(options.ownReads()).toBeGreaterThan(0);
    await flushAll();
    expect(fs.readFileSync(dataPath(g, 'cat', 'f.json'), 'utf8')).toBe('{"keep":1}');
    expect(fs.existsSync(dataPath(OTHER, 'cat', 'f.json'))).toBe(true);
  });

  it('a delete that loses its guildId after the check leaves another guild\'s view as it was', async () => {
    setGuildViewCache(true);
    const g = freshGuild();
    fs.mkdirSync(dataPath(g, 'cat'), { recursive: true });
    fs.writeFileSync(dataPath(g, 'cat', 'f.json'), '{}');
    expect(guildKeyStored(OTHER, 'cat/f.json')).toBe(false);
    noteGuildWrite(OTHER, 'cat/f.json');
    expect(guildKeyStored(OTHER, 'cat/f.json')).toBe(true);
    const options = shifting(g, 'cat', 'acceptDelete', 2);
    expect(deleteDataTracked('f.json', options).outcome).toBe('deleted');
    expect(options.ownReads()).toBe(2);
    expect(guildKeyStored(OTHER, 'cat/f.json')).toBe(true);
    await flushAll();
    expect(fs.existsSync(dataPath(g, 'cat', 'f.json'))).toBe(false);
  });
});
