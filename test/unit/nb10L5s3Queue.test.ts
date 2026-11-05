import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import {
  cancelQueued,
  confirmFile,
  enqueueAppend,
  enqueueWrite,
  fileFlushOnTheWire,
  fileLandingRecords,
  fileTicket,
  flushAll,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';

// The file queue: an append's line start after a failed or partial flush, the errno a cancel reports, a frozen path's
// confirm, and what a cancel leaves in its records.

const DIR = dataPath('global', 'nb10l5s3q');
let n = 0;
const fresh = (ext = 'jsonl') => path.join(DIR, `f${++n}.${ext}`);
const read = (file: string) => fs.readFileSync(file, 'utf8');
const realMkdir = fs.promises.mkdir.bind(fs.promises);
const realOpen = fs.promises.open.bind(fs.promises);
const realRename = fs.promises.rename.bind(fs.promises);
let errors: unknown[][];

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 2));
  }
}

function failMkdir(dir: string, code: string, times: number, before?: () => void): { calls: number } {
  const seen = { calls: 0 };
  vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (p: fs.PathLike, opts?: any) => {
    if (String(p) === dir && seen.calls < times) {
      seen.calls++;
      before?.();
      throw Object.assign(new Error(`${code}: injected, mkdir '${dir}'`), { code });
    }
    return realMkdir(p, opts);
  }) as typeof fs.promises.mkdir);
  return seen;
}

beforeEach(() => {
  fs.mkdirSync(DIR, { recursive: true });
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an append starts on its own line', () => {
  it('after an append that ended without a newline', async () => {
    const f = fresh();
    enqueueAppend(f, 'a\n');
    await flushAll();
    enqueueAppend(f, 'b');
    await flushAll();
    enqueueAppend(f, 'c\n');
    await flushAll();
    expect(read(f)).toBe('a\nb\nc\n');
  });

  it('after a failed flush, during which the file lost its trailing newline', async () => {
    const f = fresh();
    enqueueAppend(f, 'a\n');
    await flushAll();
    failMkdir(DIR, 'EIO', 1, () => fs.writeFileSync(f, 'a\ncut'));
    enqueueAppend(f, 'b\n');
    await flushAll();
    expect(read(f)).toBe('a\ncut\nb\n');
  });
});

describe('a cancel reports the errno of the last failed flush only while it is the latest outcome', () => {
  it('reports no errno for a path whose failed append later landed', async () => {
    const f = fresh();
    const mk = failMkdir(DIR, 'ENOSPC', 1);
    enqueueAppend(f, 'a\n');
    await flushAll();
    expect(mk.calls).toBe(1);
    expect(read(f)).toBe('a\n');
    enqueueAppend(f, 'b\n');
    const [answer] = await cancelQueued([f]);
    expect(answer).toEqual({ path: f, outcome: 'cancelled', errno: null });
    expect(read(f)).toBe('a\n');
  });
});

describe('a failed append open', () => {
  it('logs the error the disk gave', async () => {
    const f = fresh();
    fs.writeFileSync(f, 'a\n');
    let rejected = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(((p: fs.PathLike, flags?: any, ...rest: any[]) => {
      if (String(p) === f && flags === 'a+' && !rejected) {
        rejected = true;
        return Promise.reject(undefined);
      }
      return (realOpen as any)(p, flags, ...rest);
    }) as typeof fs.promises.open);
    enqueueAppend(f, 'b\n');
    await flushAll();
    const failure = errors.find(a => String(a[0]).startsWith(`[DataManager] Flush failed for ${f}`));
    expect(failure).toBeDefined();
    expect(failure![1]).toBeUndefined();
    expect(read(f)).toBe('a\nb\n');
  });
});

describe('a cancel of paths', () => {
  it('keeps no landing record for a path with nothing queued', async () => {
    const before = fileLandingRecords();
    const answer = await cancelQueued([fresh('json'), fresh('json')]);
    expect(answer.map(a => a.outcome)).toEqual(['landed', 'landed']);
    expect(fileLandingRecords()).toBe(before);
  });
});

describe('a write frozen by a deposition', () => {
  function gateRename(target: string): { entered: () => boolean; release: () => void } {
    let entered = false;
    let open!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === target && !entered) {
        entered = true;
        await gate;
      }
      return realRename(from, to);
    }) as typeof fs.promises.rename);
    return { entered: () => entered, release: () => open() };
  }

  it('confirms as held, not pending, while the cancel waits for the flush on the wire', async () => {
    const f = fresh('json');
    const rename = gateRename(f);
    enqueueWrite(f, '"v1"');
    const flushing = flushAll();
    await until(rename.entered);
    enqueueWrite(f, '"v2"');
    const ticket = fileTicket(f);
    let wake: () => void = () => {};
    const cancel = cancelQueued([f], () => new Promise<void>(r => { wake = r; }), { freeze: true });
    rename.release();
    await until(() => !fileFlushOnTheWire());
    const answer = await confirmFile(ticket, 400);
    expect(answer).toBe('held');
    wake();
    const [cancelled] = await cancel;
    expect(cancelled.outcome).toBe('cancelled');
    await flushing;
    expect(read(f)).toBe('"v1"');
  });

  it('stays frozen while another cancel without freeze runs', async () => {
    const f = fresh('json');
    const named = 'Stryker was here';
    const rename = gateRename(f);
    const mk = failMkdir(path.dirname(named), 'EIO', 100);
    enqueueWrite(f, '"v1"');
    const flushing = flushAll();
    await until(rename.entered);
    let wake: () => void = () => {};
    const cancel = cancelQueued([f, named], () => new Promise<void>(r => { wake = r; }), { freeze: true });
    await cancelQueued([fresh('json')]);
    enqueueWrite(named, '"x"');
    await new Promise(r => setTimeout(r, 30));
    expect(mk.calls).toBe(0);
    rename.release();
    await until(() => !fileFlushOnTheWire());
    wake();
    await cancel;
    await flushing;
    const [dropped] = await cancelQueued([named]);
    expect(dropped.outcome).toBe('cancelled');
    expect(mk.calls).toBe(0);
  });
});
