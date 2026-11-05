import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import { getPending, setGuildViewCache } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';

// NB12 code review round 9 (wip-redesign/sheets/NB12.md decision 8, NB12-D-R9-1 and NB12-O-R9-1): the per-guild
// queue index finds a guild's queued paths when DATA_DIR is spelled with forward slashes and a doubled trailing
// separator.
const spelled = vi.hoisted(() => {
  process.env.DATA_DIR = process.env.DATA_DIR!.replace(/\\/g, '/') + '//';
  return process.env.DATA_DIR;
});

let guilds = 9_900_000_000;
const fresh = () => String(++guilds);

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dm.flushAll();
  setGuildViewCache(false);
});

it('runs on a data root that path.join would spell differently', () => {
  expect(DATA_ROOT).toBe(spelled);
  expect(DATA_ROOT).not.toBe(path.join(DATA_ROOT));
  expect(dataPath('1', 'm').startsWith(DATA_ROOT)).toBe(false);
});

describe.each([true, false])('an unnormalized DATA_DIR (cache %s)', cache => {
  it("answers io naming a queued delete in the write's way, then saves once it lands", async () => {
    setGuildViewCache(cache);
    const guildId = fresh();
    fs.mkdirSync(dataPath(guildId, 'm'), { recursive: true });
    fs.writeFileSync(dataPath(guildId, 'm', 'a'), '1');
    expect(dm.deleteDataTracked('m/a', { guildId }).outcome).toBe('deleted');
    const answer = dm.saveDataTracked('m/a/x.json', { guildId }, 2);
    expect(answer).toEqual({ outcome: 'refused', cause: 'io', reason: 'a delete of m/a is still being written' });
    await dm.flushAll();
    expect(getPending(dataPath(guildId, 'm', 'a'))).toBeUndefined();
    expect(dm.saveDataTracked('m/a/x.json', { guildId }, 2).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readFileSync(dataPath(guildId, 'm', 'a', 'x.json'), 'utf8')).toBe('2');
  });

  it('sees a queued write after the view is rebuilt: its delete answers deleted and nothing lands', async () => {
    setGuildViewCache(cache);
    const guildId = fresh();
    expect(dm.saveDataTracked('m/a.json', { guildId }, 1).outcome).toBe('saved');
    expect(getPending(dataPath(guildId, 'm', 'a.json'))?.op).toBe('write');
    setGuildViewCache(false);
    setGuildViewCache(cache);
    expect(dm.deleteDataTracked('m/a.json', { guildId }).outcome).toBe('deleted');
    await dm.flushAll();
    expect(fs.existsSync(dataPath(guildId, 'm', 'a.json'))).toBe(false);
  });

  it('refuses a write whose folder is a queued, unlanded file key', async () => {
    setGuildViewCache(cache);
    const guildId = fresh();
    expect(dm.saveDataTracked('m/a', { guildId }, 1).outcome).toBe('saved');
    setGuildViewCache(false);
    setGuildViewCache(cache);
    expect(dm.saveDataTracked('m/a/x.json', { guildId }, 2)).toEqual({ outcome: 'refused', cause: 'unstorable', reason: 'the folder m/a of it is a file' });
    expect(getPending(dataPath(guildId, 'm', 'a', 'x.json'))).toBeUndefined();
    await dm.flushAll();
    expect(fs.statSync(dataPath(guildId, 'm', 'a')).isFile()).toBe(true);
    expect(fs.readFileSync(dataPath(guildId, 'm', 'a'), 'utf8')).toBe('1');
  });
});
