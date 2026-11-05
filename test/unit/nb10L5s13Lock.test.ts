import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProcessLock, type LockSeams } from '../../src/bot/internalSetup/utils/processLock';

// The data files' writer lock judges a holder stale only on proof: its own pid (an earlier run of this process), a
// pid that is gone, or a pid whose process start differs from the one the holder wrote. A holder it cannot judge is
// held, and a stale holder is removed only while the file still holds the stale text the taker saw.

let dir = '';
const lockPath = () => path.join(dir, 'writer.lock');

function lockWith(seams: Partial<LockSeams>): ProcessLock {
  return new ProcessLock({
    lockPath: lockPath(),
    takeoverPath: path.join(dir, 'writer.lock.takeover'),
    unparsableStaleMs: 60_000,
    takeoverStaleMs: 60_000,
    seams: { pid: () => 100, alive: () => true, startOf: () => 'S-self', now: () => Date.now(), ...seams },
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb10L5s13Lock-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the writer lock judging a holder', () => {
  it('takes over a lock that names its own pid, left by an earlier run of this process', () => {
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 100, start: 'S-self' }));
    const lock = lockWith({ startOf: () => 'S-self' });
    expect(lock.tryTake()).toEqual({ kind: 'taken' });
    expect(JSON.parse(fs.readFileSync(lockPath(), 'utf8')).pid).toBe(100);
    expect(lock.heldText).toBe(fs.readFileSync(lockPath(), 'utf8'));
  });

  it('keeps a live holder that wrote no process start as held, whatever start its pid shows now', () => {
    const raw = JSON.stringify({ pid: 200, role: 'bot' });
    fs.writeFileSync(lockPath(), raw);
    const lock = lockWith({ startOf: pid => (pid === 200 ? 'S-other-run' : 'S-self') });
    expect(lock.tryTake()).toEqual({ kind: 'held', holder: { pid: 200, start: null, role: 'bot', at: undefined } });
    expect(fs.readFileSync(lockPath(), 'utf8')).toBe(raw);
  });

  it('keeps a live holder as held when its current process start cannot be read', () => {
    const raw = JSON.stringify({ pid: 200, start: 'S-200' });
    fs.writeFileSync(lockPath(), raw);
    const lock = lockWith({ startOf: pid => (pid === 200 ? null : 'S-self') });
    expect(lock.tryTake()).toEqual({ kind: 'held', holder: { pid: 200, start: 'S-200', role: undefined, at: undefined } });
    expect(fs.readFileSync(lockPath(), 'utf8')).toBe(raw);
  });

  it('does not remove a lock another taker wrote after this one saw the stale text', () => {
    const stale = JSON.stringify({ pid: 300, start: 'S-300' });
    const replaced = JSON.stringify({ pid: 301, start: 'S-301' });
    fs.writeFileSync(lockPath(), stale);
    let checks301 = 0;
    const lock = lockWith({
      startOf: pid => (pid === 301 ? 'S-301' : pid === 300 ? 'S-300' : 'S-self'),
      alive: pid => {
        if (pid === 300) {
          fs.writeFileSync(lockPath(), replaced);
          return false;
        }
        if (pid === 301) return ++checks301 > 1;
        return true;
      },
    });
    expect(lock.tryTake()).toEqual({ kind: 'held', holder: { pid: 301, start: 'S-301', role: undefined, at: undefined } });
    expect(fs.readFileSync(lockPath(), 'utf8')).toBe(replaced);
  });
});
