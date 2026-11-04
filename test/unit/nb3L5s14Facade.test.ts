import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dataExists, deleteRawAtomic, flushAll, isGuildDataPath, setGuildWriteGate, writeRawAtomic,
} from '../../src/bot/internalSetup/utils/dataManager';
import { DataBackendUnavailableError } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

// NB3 decision 4 and the key form: which raw paths the web UI gate covers, what a gated write says, and what
// dataExists answers for keys it refuses and for a postgres bot with no working set.

const G = '444444444444444444';
const GATE = 'A data migration is running';

function put(rel: string[], text: string): string {
  const file = dataPath(...rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

beforeEach(() => {
  for (const name of fs.readdirSync(DATA_ROOT)) fs.rmSync(path.join(DATA_ROOT, name), { recursive: true, force: true });
  setGuildWriteGate(null);
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => setGuildWriteGate(null));

describe('isGuildDataPath', () => {
  it('takes guild folders and the graveyard, and nothing else', () => {
    expect(isGuildDataPath(dataPath(G, 'x.json'))).toBe(true);
    expect(isGuildDataPath(dataPath('_graveyard', 'x'))).toBe(true);
    expect(isGuildDataPath(DATA_ROOT)).toBe(false);
    expect(isGuildDataPath(dataPath('global', 'x.json'))).toBe(false);
    expect(isGuildDataPath(path.dirname(DATA_ROOT))).toBe(false);
  });

  it('wants the whole first segment to be digits', () => {
    expect(isGuildDataPath(dataPath('abc123', 'x.json'))).toBe(false);
    expect(isGuildDataPath(dataPath('123abc', 'x.json'))).toBe(false);
  });

  it('takes a guild file whose name ends in two dots', () => {
    expect(isGuildDataPath(dataPath(G, 'a..'))).toBe(true);
  });
});

describe('the web UI gate on raw writes', () => {
  it('refuses a guild write with the gate reason and writes nothing', async () => {
    setGuildWriteGate(() => GATE);
    let thrown: unknown;
    try {
      writeRawAtomic(dataPath(G, 'x.json'), '{}');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DataBackendUnavailableError);
    expect((thrown as Error).message).toBe(`[Data] ${GATE}; the write was not saved`);
    await flushAll();
    expect(fs.existsSync(dataPath(G, 'x.json'))).toBe(false);
  });

  it('lets a delete outside the guild folders through while gated', async () => {
    const file = put(['global', 'x.json'], '{}');
    setGuildWriteGate(() => GATE);
    expect(() => deleteRawAtomic(file)).not.toThrow();
    await flushAll();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('dataExists', () => {
  it('answers false, without throwing, for a guild key it refuses', () => {
    put([G, 'x.json'], '{}');
    expect(dataExists('x.json', { guildId: G })).toBe(true);
    expect(dataExists('a/', { guildId: G })).toBe(false);
    expect(dataExists('../x.json', { guildId: G })).toBe(false);
  });

  it('passes on an error that is not a key refusal', () => {
    expect(() => dataExists(123 as unknown as string, { guildId: G })).toThrow(TypeError);
  });

  it('does not apply the guild key rules to a global file', () => {
    put(['global', 'x.json'], '{}');
    expect(dataExists('/x.json', { scope: 'global' })).toBe(true);
  });

  it('answers false for a postgres bot with no working set, whatever the files hold', () => {
    put([G, 'x.json'], '{}');
    setBackendKind('postgres');
    expect(dataExists('x.json', { guildId: G })).toBe(false);
  });
});
