import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkWriterLock,
  configureWriterLock,
  releaseWriterLock,
  takeWriterLock,
  unconfirmedWords,
  writerLockDepth,
  writerLockPath,
} from '../../src/bot/internalSetup/utils/writerLock';
import { rowsDeposed } from '../../src/bot/internalSetup/utils/sharedStore';
import { crashFilePath, pruneCrashLines, _resetModuleCrashes } from '../../src/bot/internalSetup/utils/moduleCrashes';

const OTHER = 5370;
const live = new Set<number>([process.pid, OTHER]);

function fresh(role: 'webui' | 'bot'): void {
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  fs.rmSync(`${writerLockPath()}.takeover`, { recursive: true, force: true });
  configureWriterLock(role, { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() });
}

function deposeNow(): void {
  fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
  expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
}

let errors: string[] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  _resetModuleCrashes();
});

afterEach(() => {
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  vi.restoreAllMocks();
});

describe('the unconfirmed words', () => {
  it('names a missing error code', () => {
    expect(unconfirmedWords({ path: 'p.json', errno: null, cut: false }))
      .toBe("[Data] Can't confirm whether p.json is saved (no error code): some of its lines are in the file, but the disk did not confirm them");
  });
});

describe('a web UI deposed and taking the lock again', () => {
  it('sends shared rows again after the next take', () => {
    fresh('webui');
    expect(takeWriterLock().kind).toBe('taken');
    deposeNow();
    expect(rowsDeposed()).toBe(true);
    fs.rmSync(writerLockPath(), { force: true });
    expect(takeWriterLock().kind).toBe('taken');
    expect(rowsDeposed()).toBe(false);
    releaseWriterLock();
  });

  it('still writes the module crash file after a deposition', () => {
    fresh('webui');
    expect(takeWriterLock().kind).toBe('taken');
    deposeNow();
    fs.mkdirSync(path.dirname(crashFilePath()), { recursive: true });
    fs.writeFileSync(crashFilePath(), JSON.stringify({ gone: { sha: 'a', count: 1 } }));
    pruneCrashLines(() => []);
    expect(errors.some(e => e.includes('(another process took the data files)'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(crashFilePath(), 'utf8'))).toEqual({});
  });
});
