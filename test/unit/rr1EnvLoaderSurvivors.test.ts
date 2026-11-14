import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tamper = vi.hoisted(() => ({ file: null as string | null, text: null as string | null }));
vi.mock('../../src/bot/internalSetup/utils/atomicWrite', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/atomicWrite')>();
  return {
    ...real,
    atomicWriteFileSync: (file: string, contents: string | Buffer, ...rest: unknown[]) => {
      const landed = tamper.file === file && tamper.text !== null ? tamper.text : contents;
      (real.atomicWriteFileSync as (...args: unknown[]) => void)(file, landed, ...rest);
    },
  };
});

import { envKeysText, envSwitchRefusal, writeEnvDataBackend, writeEnvKeys } from '../../src/utils/envLoader';
import { dataPath } from '../../src/utils/dataRoot';

const ENV = dataPath('.env');
const Q = "'";

function thrown(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

let saved: Buffer | null;
beforeEach(() => {
  tamper.file = null;
  tamper.text = null;
  saved = fs.existsSync(ENV) && fs.statSync(ENV).isFile() ? fs.readFileSync(ENV) : null;
  fs.rmSync(ENV, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  tamper.file = null;
  tamper.text = null;
  fs.rmSync(ENV, { recursive: true, force: true });
  if (saved) fs.writeFileSync(ENV, saved);
});

describe('envKeysText refuses a removal that changes two other keys', () => {
  it('names both keys in the plural sentence and returns no text', () => {
    const text = ['A=', 'K=1', `${Q}x${Q}`, 'B=', 'L=1', `${Q}y${Q}`, ''].join('\n');
    expect(thrown(() => envKeysText(text, { K: null, L: null }))).toBe(
      `Writing K, L would change the values of A, B in ${ENV}; edit those lines of ${ENV}, then run the migration again`);
  });
});

describe('envSwitchRefusal', () => {
  const refusing = ['A=', 'DATA_BACKEND=file', `${Q}x${Q}`, 'DATA_BACKEND=file', ''].join('\n');

  it('judges the text given, not the file on disk', () => {
    expect(fs.existsSync(ENV)).toBe(false);
    expect(envSwitchRefusal('postgres', refusing)).toBe(
      `Writing DATA_BACKEND would change the value of A in ${ENV}; edit that line of ${ENV}, then run the migration again`);
  });

  it('a .env that cannot be read (a folder) is refused with its cause', () => {
    fs.mkdirSync(ENV, { recursive: true });
    const cause = thrown(() => fs.readFileSync(ENV));
    expect(cause).not.toBeNull();
    expect(envSwitchRefusal('postgres')).toBe(`${ENV} cannot be read: ${cause}`);
  });

  it('a read that throws a bare undefined is still refused, not thrown', () => {
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(p) === ENV) throw undefined;
      return (real as (...args: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync);
    syncBuiltinESMExports();
    let answer: string | null = null;
    let threw = false;
    try {
      answer = envSwitchRefusal('postgres');
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(answer).toBe(`${ENV} cannot be read: undefined`);
  });
});

describe('writeEnvDataBackend reads the file back', () => {
  it('a file that lands with another value is refused, naming /data/.env', () => {
    tamper.file = ENV;
    tamper.text = 'DATA_BACKEND=file\n';
    expect(thrown(() => writeEnvDataBackend('postgres'))).toBe(`${ENV} does not read back DATA_BACKEND=postgres`);
  });
});

describe('writeEnvKeys reads each key back', () => {
  it('a set key missing and a removed key present are both named, with where the old file is kept', () => {
    fs.writeFileSync(ENV, 'A=1\n');
    tamper.file = ENV;
    tamper.text = 'A=1\nL=1\n';
    const kept = dataPath('env-kept-rr1');
    expect(thrown(() => writeEnvKeys({ K: 'new', L: null }, {}, kept))).toBe(
      `${ENV} was written but does not read back K, L as written; the file as it was is kept at ${kept}; run the migration again`);
  });

  it('a set key that lands with another value is refused', () => {
    tamper.file = ENV;
    tamper.text = 'K=other\n';
    expect(thrown(() => writeEnvKeys({ K: 'new' }, {}, null))).toBe(
      `${ENV} was written but does not read back K as written; there was no ${ENV} before; run the migration again`);
  });

  it('a file that lands as written passes', () => {
    expect(thrown(() => writeEnvKeys({ K: 'new' }, {}, null))).toBeNull();
    expect(fs.readFileSync(ENV, 'utf8')).toBe('K=new\n');
  });
});
