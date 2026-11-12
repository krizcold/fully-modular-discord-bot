import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A, chunk 36: the whole write's folder chain answer, the replaced write the exit fails, the lines a failed
// append names, the folder sync of atomicReplace, and the record a stream's delete starts. The folder chain is
// stubbed, so its failures reach the same code on Windows as on Linux.

const h = vi.hoisted(() => ({
  chainFail: new Map<string, string[]>(),
  chainHold: new Map<string, { reached: () => void; released: Promise<void> }>(),
  chainCalls: [] as string[],
  folderCalls: [] as string[],
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolderChain: async (dir: string) => {
      const at = path.resolve(dir);
      h.chainCalls.push(at);
      const hold = h.chainHold.get(at);
      if (hold) {
        h.chainHold.delete(at);
        hold.reached();
        await hold.released;
      }
      const errno = h.chainFail.get(at)?.shift();
      if (errno) return { failed: true, kind: 'sync', dir: at, errno, error: Object.assign(new Error(`${errno}: stubbed`), { code: errno }) };
      return { failed: false };
    },
    syncFolder: async (dir: string) => {
      h.folderCalls.push(path.resolve(dir));
      return { failed: false };
    },
  };
});

import {
  atomicReplace,
  cancelQueued,
  enqueueAppend,
  enqueueDelete,
  enqueueWrite,
  failReplacedTriesAtExit,
  fileFlushOnTheWire,
  fileTicket,
  fileTicketFailure,
  fileTicketState,
  flushAll,
  forgetDurableFiles,
  queuedFilePaths,
  unconfirmedFiles,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { dataPath } from '../../src/utils/dataRoot';
import { stubAppendHandles, type AppendStub } from '../helpers/fileHandleStub';

let n = 0;
let dir = '';
let errors: string[];
let stub: AppendStub | null = null;

const read = (p: string) => fs.readFileSync(p, 'utf8');

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

function failChain(d: string, errno = 'EIO') {
  const at = path.resolve(d);
  h.chainFail.set(at, [...(h.chainFail.get(at) ?? []), errno]);
}

function holdChain(d: string): { reached: Promise<void>; release: () => void } {
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  h.chainHold.set(path.resolve(d), { reached, released });
  return { reached: reachedP, release };
}

function failMkdir(d: string) {
  const real = fs.promises.mkdir.bind(fs.promises);
  return vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (x: fs.PathLike, o?: fs.MakeDirectoryOptions) => {
    if (path.resolve(String(x)) === path.resolve(d)) throw Object.assign(new Error('ENOSPC: stubbed mkdir'), { code: 'ENOSPC' });
    return real(x, o);
  }) as typeof fs.promises.mkdir);
}

const wholeLine = (p: string, d: string) => {
  const { why, next } = syncWords('sync', d, 'EIO');
  return `[Data] ${p}: the file is written whole, but ${why}; it is not written again; can't confirm it is stored. ${next}`;
};

beforeEach(() => {
  dir = dataPath('ra36', String(Date.now()), String(++n));
  fs.mkdirSync(dir, { recursive: true });
  h.chainFail.clear();
  h.chainHold.clear();
  h.chainCalls.length = 0;
  h.folderCalls.length = 0;
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  forgetDurableFiles();
});

afterEach(async () => {
  stub?.restore();
  stub = null;
  vi.restoreAllMocks();
  h.chainFail.clear();
  h.chainHold.clear();
  await flushAll();
});

describe('a whole write whose folder chain failed', () => {
  it('is in the file, its ticket is unconfirmed with the failed sync, and the error line names it', async () => {
    const p = path.join(dir, 'w.json');
    const before = unconfirmedFiles();
    failChain(dir);
    enqueueWrite(p, '{"a":1}\n');
    const t = fileTicket(p);
    await flushAll();
    expect(read(p)).toBe('{"a":1}\n');
    expect(queuedFilePaths()).not.toContain(p);
    expect(fileTicketState(t)).toBe('unconfirmed');
    expect(fileTicketFailure(t)).toEqual({ errno: 'EIO', cut: false, what: 'whole', kind: 'sync', dir: path.resolve(dir) });
    expect(errors.filter(e => e === wholeLine(p, path.resolve(dir)))).toHaveLength(1);
    expect(unconfirmedFiles()).toBe(before + 1);

    enqueueWrite(p, '{"a":2}\n');
    await flushAll();
    expect(unconfirmedFiles()).toBe(before);
  });

  it('syncs its folder only through the chain, once', async () => {
    const p = path.join(dir, 'w.json');
    enqueueWrite(p, 'x');
    await flushAll();
    expect(read(p)).toBe('x');
    expect(h.chainCalls.filter(c => c === path.resolve(dir))).toHaveLength(1);
    expect(h.folderCalls.filter(c => c === path.resolve(dir))).toHaveLength(0);
  });
});

describe('a whole write replaced by a newer write while its chain was held', () => {
  async function replacedTry() {
    const p = path.join(dir, 'x.jsonl');
    const hold = holdChain(dir);
    failChain(dir);
    enqueueWrite(p, 'W1\n');
    const t1 = fileTicket(p);
    await hold.reached;
    enqueueWrite(p, 'W2\n');
    const t2 = fileTicket(p);
    return { p, t1, t2, hold };
  }

  it('the newer write lands: both tickets landed, no error line', async () => {
    const r = await replacedTry();
    r.hold.release();
    await flushAll();
    expect(read(r.p)).toBe('W2\n');
    expect(fileTicketState(r.t1)).toBe('landed');
    expect(fileTicketState(r.t2)).toBe('landed');
    expect(errors.some(e => e.includes('written whole'))).toBe(false);
  });

  it('the newer write never lands: the exit fails the replaced one, unconfirmed, logged once', async () => {
    const r = await replacedTry();
    const mkdir = failMkdir(dir);
    const before = unconfirmedFiles();
    r.hold.release();
    await until(() => mkdir.mock.calls.some(c => path.resolve(String(c[0])) === path.resolve(dir)) && !fileFlushOnTheWire());
    expect(read(r.p)).toBe('W1\n');
    expect(fileTicketState(r.t1)).toBe('open');
    expect(errors.some(e => e.includes('written whole'))).toBe(false);
    expect(unconfirmedFiles()).toBe(before);

    failReplacedTriesAtExit();
    expect(fileTicketState(r.t1)).toBe('unconfirmed');
    expect(fileTicketFailure(r.t1)).toEqual({ errno: 'EIO', cut: false, what: 'whole', kind: 'sync', dir: path.resolve(dir) });
    expect(fileTicketState(r.t2)).toBe('open');
    expect(errors.filter(e => e === wholeLine(r.p, path.resolve(dir)))).toHaveLength(1);
    expect(unconfirmedFiles()).toBe(before + 1);

    failReplacedTriesAtExit();
    expect(errors.filter(e => e === wholeLine(r.p, path.resolve(dir)))).toHaveLength(1);

    mkdir.mockRestore();
    await flushAll();
    expect(read(r.p)).toBe('W2\n');
    expect(fileTicketState(r.t2)).toBe('landed');
  });
});

describe('an append whose folder chain failed', () => {
  it('names every line it put in the file, a blank one and a last one without a newline too', async () => {
    const p = path.join(dir, 'a.jsonl');
    failChain(dir);
    enqueueAppend(p, 'a\n\nb');
    await flushAll();
    expect(read(p)).toBe('a\n\nb');
    const { why, next } = syncWords('sync', path.resolve(dir), 'EIO');
    expect(errors).toContain(`[Data] ${p}: 3 appended line(s) are in the file and synced, but ${why}; they are not written again; can't confirm they are stored. ${next}`);
  });

  it('a single line with its newline counts one', async () => {
    const p = path.join(dir, 'b.jsonl');
    failChain(dir);
    enqueueAppend(p, 'a\n');
    await flushAll();
    const { why, next } = syncWords('sync', path.resolve(dir), 'EIO');
    expect(errors).toContain(`[Data] ${p}: 1 appended line(s) are in the file and synced, but ${why}; they are not written again; can't confirm they are stored. ${next}`);
  });
});

describe('an append after a whole write of the same file', () => {
  it('syncs the folder chain again even when the file reports the identity the earlier append recorded', async () => {
    const p = path.join(dir, 'd.jsonl');
    stub = stubAppendHandles();
    stub.statAs(p, () => ({ dev: 7n, ino: 99n, birthtimeNs: 11n }), 2);
    const chained = () => h.chainCalls.filter(c => c === path.resolve(dir)).length;
    enqueueAppend(p, 'L1\n');
    await flushAll();
    expect(chained()).toBe(1);
    enqueueWrite(p, 'W\n');
    await flushAll();
    expect(chained()).toBe(2);
    enqueueAppend(p, 'L2\n');
    await flushAll();
    expect(read(p)).toBe('W\nL2\n');
    expect(chained()).toBe(3);
  });
});

describe('atomicReplace', () => {
  it('syncs the target folder by default and not with parentSync false', async () => {
    const a = path.join(dir, 'one', 'a.json');
    const b = path.join(dir, 'two', 'b.json');
    await atomicReplace(a, 'A');
    await atomicReplace(b, 'B', { parentSync: false });
    expect(read(a)).toBe('A');
    expect(read(b)).toBe('B');
    expect(h.folderCalls.filter(c => c === path.dirname(a))).toHaveLength(1);
    expect(h.folderCalls.filter(c => c === path.dirname(b))).toHaveLength(0);
  });
});

describe('a cancel waiting on a failed append, then a delete that lands', () => {
  async function run(name: string) {
    const p = path.join(dir, name);
    stub = stubAppendHandles();
    const hold = stub.holdSync(p, 'EIO');
    enqueueAppend(p, 'L1\n');
    await hold.reached;
    let step: (() => Promise<void>) | null = async () => {
      hold.release();
      await until(() => !queuedFilePaths().includes(p) && !fileFlushOnTheWire());
      enqueueDelete(p);
      await until(() => !queuedFilePaths().includes(p) && !fileFlushOnTheWire());
    };
    const sleep = async () => {
      const s = step;
      step = null;
      if (s) await s();
      else await new Promise(resolve => setTimeout(resolve, 1));
    };
    const answer = await cancelQueued([p], sleep);
    expect(fs.existsSync(p)).toBe(false);
    return { p, answer };
  }

  it('a stream: the delete took the lines out of the file, so the append is cancelled', async () => {
    const { p, answer } = await run('s.jsonl');
    expect(answer).toEqual([{ path: p, outcome: 'cancelled', errno: null }]);
  });

  it('a file that is not a stream: the delete starts no record, so the append stays unconfirmed', async () => {
    const { p, answer } = await run('s.json');
    expect(answer).toEqual([{ path: p, outcome: 'unconfirmed', errno: 'EIO', cut: false, what: 'lines' }]);
  });
});
