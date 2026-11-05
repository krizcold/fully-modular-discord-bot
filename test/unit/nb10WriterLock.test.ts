import fs from 'fs';
import os from 'os';
import path from 'path';
import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProcessLock, type LockSeams } from '../../src/bot/internalSetup/utils/processLock';

// NB10 test 1: the writer lock's primitives (processLock.ts) driven by simulated processes against one real file.

let dir: string;
let lockPath: string;
const live = new Set<number>();
const starts = new Map<number, string>();
let clock = 1_000_000;

function seamsOf(pid: number): LockSeams {
  return { pid: () => pid, alive: p => live.has(p), startOf: p => starts.get(p) ?? null, now: () => clock };
}

function processLock(pid: number, start = `s${pid}`): ProcessLock {
  live.add(pid);
  starts.set(pid, start);
  return new ProcessLock({ lockPath, takeoverPath: `${lockPath}.takeover`, unparsableStaleMs: 10_000, takeoverStaleMs: 5_000, extra: () => ({ role: 'webui' }), seams: seamsOf(pid) });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb10lock-'));
  lockPath = path.join(dir, '.writer.lock');
  live.clear();
  starts.clear();
  clock = Date.now();
});

describe('the writer lock primitives', () => {
  it('a free path is taken with pid, start, role and at', () => {
    const a = processLock(101);
    expect(a.tryTake()).toEqual({ kind: 'taken' });
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    expect(holder).toMatchObject({ pid: 101, start: 's101', role: 'webui' });
    expect(typeof holder.at).toBe('number');
  });

  it('a second process is refused while the holder lives, and takes over a dead holder or one with another start', () => {
    const a = processLock(101);
    const b = processLock(102);
    a.tryTake();
    expect(b.tryTake()).toMatchObject({ kind: 'held', holder: { pid: 101 } });
    live.delete(101);
    expect(b.tryTake()).toEqual({ kind: 'taken' });
    const c = processLock(103);
    starts.set(102, 's102-again');
    expect(c.tryTake()).toEqual({ kind: 'taken' });
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(103);
  });

  it('a text that does not parse is held by nobody known under 10 s and taken over after', () => {
    fs.writeFileSync(lockPath, '{"pid":');
    const a = processLock(101);
    clock = fs.statSync(lockPath).mtimeMs + 1000;
    expect(a.tryTake()).toEqual({ kind: 'held', holder: null });
    clock = fs.statSync(lockPath).mtimeMs + 11_000;
    expect(a.tryTake()).toEqual({ kind: 'taken' });
  });

  it('of two takers of one stale lock, the one that finds the takeover guard answers contended', () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999, start: 'x', at: 1 }));
    fs.writeFileSync(`${lockPath}.takeover`, '');
    clock = fs.statSync(`${lockPath}.takeover`).mtimeMs + 1000;
    const b = processLock(102);
    expect(b.tryTake()).toEqual({ kind: 'contended' });
    fs.unlinkSync(`${lockPath}.takeover`);
    expect(b.tryTake()).toEqual({ kind: 'taken' });
  });

  it('two takers interleaved: the second runs while the first holds the takeover guard, and answers contended', () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999, start: 's999', at: clock }));
    const second = processLock(202);
    let secondAnswer: unknown = null;
    let checks = 0;
    live.add(201);
    starts.set(201, 's201');
    const first = new ProcessLock({
      lockPath, takeoverPath: `${lockPath}.takeover`, unparsableStaleMs: 10_000, takeoverStaleMs: 5_000, extra: () => ({ role: 'webui' }),
      seams: {
        ...seamsOf(201),
        alive: p => {
          // The second check of the stale holder runs inside the first taker's takeover guard.
          if (p === 999 && ++checks === 2) {
            expect(fs.existsSync(`${lockPath}.takeover`)).toBe(true);
            secondAnswer = second.tryTake();
          }
          return live.has(p);
        },
      },
    });
    expect(first.tryTake()).toEqual({ kind: 'taken' });
    expect(secondAnswer).toEqual({ kind: 'contended' });
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(201);
    expect(second.tryTake()).toMatchObject({ kind: 'held', holder: { pid: 201 } });
  });

  it('re-entry counts depth, and release never unlinks a file naming another pid', () => {
    const a = processLock(101);
    a.tryTake();
    a.tryTake();
    expect(a.depth).toBe(2);
    a.release();
    expect(fs.existsSync(lockPath)).toBe(true);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 202, start: 's202', at: 1 }));
    a.release();
    expect(a.depth).toBe(0);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(202);
  });

  it('property: at no step do two live processes hold the lock', () => {
    const pids = [11, 12, 13];
    const step = fc.record({ who: fc.integer({ min: 0, max: 2 }), what: fc.constantFrom('take', 'release', 'die', 'restart') });
    fc.assert(fc.property(fc.array(step, { maxLength: 60 }), steps => {
      try { fs.rmSync(lockPath, { force: true }); fs.rmSync(`${lockPath}.takeover`, { force: true }); } catch { /* fresh */ }
      live.clear();
      starts.clear();
      const gen = new Map<number, number>();
      const locks = new Map<number, ProcessLock>();
      for (const pid of pids) {
        gen.set(pid, 0);
        locks.set(pid, processLock(pid, `${pid}:0`));
      }
      for (const { who, what } of steps) {
        const pid = pids[who];
        const lock = locks.get(pid)!;
        if (what === 'take' && live.has(pid)) lock.tryTake();
        else if (what === 'release' && live.has(pid)) lock.release();
        else if (what === 'die') live.delete(pid);
        else if (what === 'restart') {
          const g = gen.get(pid)! + 1;
          gen.set(pid, g);
          locks.set(pid, processLock(pid, `${pid}:${g}`));
        }
        const holders = pids.filter(p => live.has(p) && locks.get(p)!.depth > 0);
        if (holders.length > 1) return false;
      }
      return true;
    }), { numRuns: 200 });
  });
});
