import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dataPath } from '../../src/utils/dataRoot';
import { enqueueWrite, getPending } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { DataBackendUnavailableError } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';

// NB1's acceptance window on a JSON bot (wip-redesign/sheets/NB1.md, D4 and item 7): a write's atomic replace starts
// on the next turn of the event loop, a write to a path on the wire waits for that flight, a failing path is retried
// at 1, 2, 4 s up to 60 s, and its directory refuses writes once it has failed for 30 s.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const turn = () => new Promise<void>(resolve => { setImmediate(resolve); });
let dirs = 0;
const freshFile = () => dataPath('global', `nb1f${++dirs}`, 'doc.json');
const realMkdir = fs.promises.mkdir.bind(fs.promises);
const realOpen = fs.promises.open.bind(fs.promises);

/** Records each start of an atomic replace (its mkdir of the target's folder). */
function replaceStarts(target: string): number[] {
  const at: number[] = [];
  vi.spyOn(fs.promises, 'mkdir').mockImplementation(((dir: fs.PathLike, opts?: any) => {
    if (String(dir) === path.dirname(target)) at.push(Date.now());
    return realMkdir(dir, opts);
  }) as typeof fs.promises.mkdir);
  return at;
}

describe('how long a JSON write waits before its atomic replace starts', () => {
  it('starts on the next turn of the event loop, with no timer', async () => {
    const file = freshFile();
    const starts = replaceStarts(file);
    enqueueWrite(file, '{"v":1}');
    expect(starts).toEqual([]);
    await turn();
    expect(starts).toHaveLength(1);
    for (let i = 0; i < 50 && getPending(file); i++) await new Promise(resolve => { setTimeout(resolve, 10); });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"v":1}');
  });

  it('a write to a path whose flush is on the wire starts when that flight ends', async () => {
    const file = freshFile();
    const starts = replaceStarts(file);
    let resume: () => void = () => {};
    const held = new Promise<void>(resolve => { resume = resolve; });
    let opens = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: fs.PathLike, flags?: any) => {
      if (String(p).startsWith(file) && ++opens === 1) await held;
      return realOpen(p, flags);
    }) as typeof fs.promises.open);
    enqueueWrite(file, '{"v":1}');
    await turn();
    for (let i = 0; i < 50 && opens === 0; i++) await turn();
    expect(opens).toBe(1);
    enqueueWrite(file, '{"v":2}');
    for (let i = 0; i < 20; i++) await turn();
    expect(starts).toHaveLength(1);
    resume();
    for (let i = 0; i < 100 && getPending(file); i++) await new Promise(resolve => { setTimeout(resolve, 10); });
    expect(starts).toHaveLength(2);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"v":2}');
  });
});

describe('a JSON path that keeps failing', () => {
  function failing(file: string): number[] {
    const at: number[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fs.promises, 'mkdir').mockImplementation(((dir: fs.PathLike, opts?: any) => {
      if (String(dir) === path.dirname(file)) return Promise.resolve(undefined);
      return realMkdir(dir, opts);
    }) as typeof fs.promises.mkdir);
    vi.spyOn(fs.promises, 'open').mockImplementation(((p: fs.PathLike, flags?: any) => {
      if (String(p).startsWith(file)) {
        at.push(Date.now());
        return Promise.reject(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }));
      }
      return realOpen(p, flags);
    }) as typeof fs.promises.open);
    return at;
  }

  it('is retried 1, 2, 4, 8, 16, 32 s after each failure, then every 60 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const file = freshFile();
    const attempts = failing(file);
    const start = Date.now();
    enqueueWrite(file, '{"v":1}');
    await turn();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(185_000);
    expect(attempts.map(t => t - start)).toEqual([0, 1000, 3000, 7000, 15000, 31000, 63000, 123000, 183000]);
  });

  it('refuses writes to its folder once it has failed for 30 s, and takes writes to another folder', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const file = freshFile();
    failing(file);
    enqueueWrite(file, '{"v":1}');
    await turn();
    await vi.advanceTimersByTimeAsync(29_000);
    const sibling = path.join(path.dirname(file), 'sibling.json');
    expect(() => enqueueWrite(sibling, '{"s":1}')).not.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    let thrown: unknown;
    try { enqueueWrite(sibling, '{"s":2}'); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(DataBackendUnavailableError);
    expect((thrown as DataBackendUnavailableError).causeKey).toBe('storage-failing');
    expect(() => enqueueWrite(freshFile(), '{"other":1}')).not.toThrow();
  });
});
