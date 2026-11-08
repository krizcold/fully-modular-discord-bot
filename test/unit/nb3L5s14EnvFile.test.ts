import fs from 'fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { readEnvFileDataBackend, writeEnvDataBackend } from '../../src/utils/envLoader';
import { dataPath } from '../../src/utils/dataRoot';

// NB3: the marker switch rewrites only the DATA_BACKEND line of /data/.env, reads it back, and fails when the file
// does not then say what was written.

const ENV = dataPath('.env');

beforeEach(() => {
  fs.rmSync(ENV, { recursive: true, force: true });
});

describe('readEnvFileDataBackend', () => {
  it('trims and lowercases a quoted value', () => {
    fs.writeFileSync(ENV, 'DATA_BACKEND=" Postgres "\n');
    expect(readEnvFileDataBackend()).toBe('postgres');
  });
});

describe('writeEnvDataBackend', () => {
  it('leaves a line whose key only ends in DATA_BACKEND', () => {
    fs.writeFileSync(ENV, 'MY_DATA_BACKEND=keep\nDATA_BACKEND=postgres\n');
    writeEnvDataBackend('file');
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('MY_DATA_BACKEND=keep\nDATA_BACKEND=file\n');
  });

  it('rewrites an export line in place', () => {
    fs.writeFileSync(ENV, 'A=1\nexport DATA_BACKEND=postgres\nB=2\n');
    writeEnvDataBackend('file');
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('A=1\nDATA_BACKEND=file\nB=2\n');
  });

  it('rewrites an export line with two spaces in place', () => {
    fs.writeFileSync(ENV, 'export  DATA_BACKEND=postgres\n');
    writeEnvDataBackend('file');
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('DATA_BACKEND=file\n');
  });

  it('rewrites a `DATA_BACKEND:` line dotenv reads, and drops the earlier line (NB6F V1)', () => {
    fs.writeFileSync(ENV, 'DATA_BACKEND=postgres\nDATA_BACKEND: postgres\n');
    writeEnvDataBackend('file');
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('DATA_BACKEND=file\n');
  });

  it('fails on the read when the file cannot be read, and writes nothing', () => {
    fs.mkdirSync(ENV);
    let thrown: NodeJS.ErrnoException | null = null;
    try {
      writeEnvDataBackend('file');
    } catch (error) {
      thrown = error as NodeJS.ErrnoException;
    }
    expect(thrown?.code).toBe('EISDIR');
    expect(thrown?.syscall).toBe('read');
    expect(fs.statSync(ENV).isDirectory()).toBe(true);
  });
});
