import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_FS } from '../helpers/forwardingFs';
import { dataPath } from '../../src/utils/dataRoot';
import { flushAll, placeGuildWrite, readRawStrict, setGuildViewCache } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

// NB12 (wip-redesign/sheets/NB12.md) on the file route: what a read for a write answers for a folder in a key's
// place, that a failed read or listing reaches the caller as it was thrown, and the placement answer after a
// keyless case alias folder was removed beside a folder that holds keys.

const realFs = (fs as any)[REAL_FS] as typeof fs;
let guilds = 9_420_100_000;
const newGuild = (): string => String(++guilds);
const coded = (code: string): Error => Object.assign(new Error(`${code}: refused by the test`), { code });

function thrownBy(fn: () => unknown): { value: unknown } | null {
  try {
    fn();
  } catch (error) {
    return { value: error };
  }
  return null;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  setGuildViewCache(false);
  await flushAll();
});

describe('a read for a write of a guild file', () => {
  it('answers absent for a folder in the place of a key whose name ends in two dots', () => {
    const g = newGuild();
    const target = dataPath(g, 'm', 'notes..');
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw coded('EISDIR'); });
    expect(readRawStrict(target)).toBeNull();
  });

  it('answers absent for a file at a folder of a key whose name ends in two dots', () => {
    const g = newGuild();
    const target = dataPath(g, 'm..');
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw coded('ENOTDIR'); });
    expect(readRawStrict(target)).toBeNull();
  });

  it.each([['null', null], ['undefined', undefined]])('passes a failure thrown as %s to the caller unchanged', (_name, value) => {
    const g = newGuild();
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw value; });
    expect(thrownBy(() => readRawStrict(dataPath(g, 'm', 'a.json')))).toEqual({ value });
  });
});

describe('a guild folder listing for a placement', () => {
  it.each([['null', null], ['undefined', undefined]])('passes a failure thrown as %s to the caller unchanged', (_name, value) => {
    const g = newGuild();
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw value; });
    expect(thrownBy(() => placeGuildWrite(g, 'm/a.json'))).toEqual({ value });
  });
});

describe('a keyless case alias folder removed during a placement', () => {
  // The listings show what a case-sensitive disk holds: 'a' with a.json's sibling k.json, and an empty 'A' beside it.
  function aliasBeside(g: string): { removed: string[] } {
    fs.mkdirSync(dataPath(g, 'a'), { recursive: true });
    fs.writeFileSync(dataPath(g, 'a', 'k.json'), '{}');
    const root = path.resolve(dataPath(g));
    const alias = path.resolve(dataPath(g, 'A'));
    const entry = (name: string) => ({ name, isDirectory: () => true, isFile: () => false });
    vi.spyOn(fs, 'readdirSync').mockImplementation(((q: any, ...rest: any[]) => {
      const abs = path.resolve(String(q));
      if (abs === alias) return [];
      const out = (realFs.readdirSync as any)(q, ...rest);
      return abs === root ? [entry('A'), ...out] : out;
    }) as any);
    const removed: string[] = [];
    vi.spyOn(fs, 'rmdirSync').mockImplementation(((q: any, ...rest: any[]) => {
      const abs = path.resolve(String(q));
      if (abs === alias) {
        removed.push('A');
        return undefined;
      }
      return (realFs.rmdirSync as any)(q, ...rest);
    }) as any);
    return { removed };
  }

  it('still reads the folder that holds keys, so a write differing only in case from a stored key is refused', () => {
    const g = newGuild();
    const { removed } = aliasBeside(g);
    expect(placeGuildWrite(g, 'a/K.json')).toEqual({ ok: false, cause: 'unstorable', reason: 'it differs only in letter case from a/k.json' });
    expect(removed).toEqual(['A']);
    expect(realFs.readFileSync(dataPath(g, 'a', 'k.json'), 'utf8')).toBe('{}');
  });
});
