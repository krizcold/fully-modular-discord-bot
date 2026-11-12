import fs from 'fs';
import path from 'path';
import v8 from 'v8';
import vm from 'vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chain = vi.hoisted(() => ({
  holds: [] as Array<{ dir: string; answer: () => Promise<unknown> }>,
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/folderChain')>();
  const nodePath = await import('path');
  return {
    ...real,
    syncFolderChain: async (dir: string) => {
      const at = nodePath.resolve(dir);
      const i = chain.holds.findIndex(h => h.dir === at);
      if (i >= 0) return chain.holds.splice(i, 1)[0].answer();
      return real.syncFolderChain(dir);
    },
  };
});

import {
  cancelQueued,
  confirmFile,
  dropPendingForGuild,
  droppedByDeposition,
  enqueueAppend,
  enqueueWrite,
  fileFlushOnTheWire,
  fileLandingRecords,
  fileTicket,
  fileTicketFailure,
  fileTicketState,
  flushAll,
  forgetDurableFiles,
  getPending,
  setRowCancel,
  unconfirmedFiles,
  type CancelOutcome,
  type FileTicket,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';
import { stubAppendHandles, type AppendStub } from '../helpers/fileHandleStub';

let n = 0;
let dir = '';
let stub: AppendStub;
let errors: string[];
const fresh = (name: string) => path.join(dir, `${++n}-${name}`);
const read = (p: string) => fs.readFileSync(p, 'utf8');
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitUntil(done: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await pause(2);
}

async function until(done: () => boolean) {
  await waitUntil(done);
  expect(done()).toBe(true);
}

function append(p: string, text: string): FileTicket {
  enqueueAppend(p, text);
  return fileTicket(p);
}

/** Holds the next folder chain of a folder, then answers it failed with EIO. */
function holdChain(at: string) {
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const d = path.resolve(at);
  chain.holds.push({
    dir: d,
    answer: async () => {
      reached();
      await released;
      return { failed: true, kind: 'sync', dir: d, errno: 'EIO', error: Object.assign(new Error('EIO: stubbed fsync'), { code: 'EIO' }) };
    },
  });
  return { reached: reachedP, release };
}

/** Rejects every later mkdir of this folder with EIO, so a whole write of a file in it fails before its temp file. */
function failMkdir(at: string) {
  const real = fs.promises.mkdir.bind(fs.promises);
  const target = path.resolve(at);
  let calls = 0;
  const spy = vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (p: fs.PathLike, opts?: unknown) => {
    if (path.resolve(String(p)) === target) {
      calls += 1;
      throw Object.assign(new Error('EIO: stubbed mkdir'), { code: 'EIO' });
    }
    return real(p, opts as fs.MakeDirectoryOptions);
  }) as typeof fs.promises.mkdir);
  return { calls: () => calls, restore: () => spy.mockRestore() };
}

beforeEach(() => {
  dir = dataPath('ra39', String(Date.now()), String(++n));
  fs.mkdirSync(dir, { recursive: true });
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  stub = stubAppendHandles();
  forgetDurableFiles();
  chain.holds.length = 0;
});

afterEach(async () => {
  setRowCancel(null);
  stub.restore();
  vi.restoreAllMocks();
  await flushAll();
});

describe('a cancel that holds row paths and file paths at once', () => {
  it('answers the file path from the file queue and drops its queued write', async () => {
    const rowPath = fresh('row.json');
    const filePath = fresh('file.json');
    const rowAnswer: CancelOutcome = { path: rowPath, outcome: 'landed', row: true };
    const asked: string[][] = [];
    setRowCancel({
      holds: p => p === rowPath,
      cancel: async paths => { asked.push(paths); return [rowAnswer]; },
    });
    enqueueWrite(filePath, '{"a":1}');
    const answers = await cancelQueued([rowPath, filePath]);
    expect(asked).toEqual([[rowPath]]);
    expect(answers).toEqual([rowAnswer, { path: filePath, outcome: 'cancelled', errno: null }]);
    expect(getPending(filePath)).toBeUndefined();
    await flushAll();
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe('a cancel of a write still queued', () => {
  it('answers cancelled, counts no file unconfirmed and marks no ticket dropped by a deposition', async () => {
    const p = fresh('w.json');
    enqueueWrite(p, '{"a":1}');
    const t = fileTicket(p);
    const before = unconfirmedFiles();
    const [answer] = await cancelQueued([p]);
    expect(answer).toEqual({ path: p, outcome: 'cancelled', errno: null });
    expect(unconfirmedFiles()).toBe(before);
    expect(droppedByDeposition(t.record)).toBe(false);
    await flushAll();
    expect(fs.existsSync(p)).toBe(false);
  });
});

describe('a deposition cancel of an append whose flush lands during its wait', () => {
  it('answers landed and does not mark the ticket dropped by the deposition', async () => {
    const p = fresh('d.jsonl');
    const sync = stub.holdSync(p);
    const t = append(p, 'L1\n');
    await sync.reached;
    const cancelled = cancelQueued([p], undefined, { freeze: true });
    sync.release();
    const [answer] = await cancelled;
    expect(answer).toEqual({ path: p, outcome: 'landed' });
    expect(read(p)).toBe('L1\n');
    expect(fileTicketState(t)).toBe('landed');
    expect(droppedByDeposition(t.record)).toBe(false);
  });
});

describe('a cancel whose path had a flush on the wire at its start', () => {
  it('answers landed for the lines queued at the start when only a later try left lines unconfirmed', async () => {
    const p = fresh('a.jsonl');
    const sync = stub.holdSync(p);
    const t1 = append(p, 'L1\n');
    await sync.reached;
    const cancelled = cancelQueued([p], () => waitUntil(() => getPending(p) === undefined && !fileFlushOnTheWire()));
    stub.failSync(p, 'EIO');
    const t2 = append(p, 'L2\n');
    sync.release();
    const [answer] = await cancelled;
    expect(answer).toEqual({ path: p, outcome: 'landed' });
    expect(read(p)).toBe('L1\nL2\n');
    expect(fileTicketState(t1)).toBe('landed');
    expect(fileTicketState(t2)).toBe('unconfirmed');
  });

  it('answers unconfirmed and cut for a later try cut short, and leaves the landed lines landed', async () => {
    const p = fresh('c.jsonl');
    const sync = stub.holdSync(p);
    const t1 = append(p, 'L1\n');
    await sync.reached;
    const cut = () => stub.writes.some(w => w.path === p && w.accepted === 1);
    const cancelled = cancelQueued([p], () => waitUntil(() => cut() && !fileFlushOnTheWire()));
    stub.shortWrite(p, () => 1);
    const t2 = append(p, 'L2\n');
    sync.release();
    const [answer] = await cancelled;
    expect(answer).toMatchObject({ path: p, outcome: 'unconfirmed', errno: 'short write', cut: true, what: 'lines' });
    expect(read(p)).toBe('L1\nL');
    expect(getPending(p)).toBeUndefined();
    expect(fileTicketState(t1)).toBe('landed');
    expect(fileTicketFailure(t1)).toBeNull();
    expect(fileTicketState(t2)).toBe('unconfirmed');
    expect(fileTicketFailure(t2)).toMatchObject({ errno: 'short write', cut: true });
    expect(droppedByDeposition(t1.record)).toBe(false);
  });
});

describe('a cancel of a write queued behind a replaced whole write whose folder chain failed', () => {
  it('answers unconfirmed with the replaced write, which is in the file whole', async () => {
    const p = fresh('r.json');
    const hold = holdChain(path.dirname(p));
    enqueueWrite(p, 'W1\n');
    const t1 = fileTicket(p);
    await hold.reached;
    const mkdir = failMkdir(path.dirname(p));
    enqueueWrite(p, 'W2\n');
    const t2 = fileTicket(p);
    hold.release();
    await until(() => mkdir.calls() > 0 && !fileFlushOnTheWire());
    expect(read(p)).toBe('W1\n');
    const [answer] = await cancelQueued([p]);
    mkdir.restore();
    expect(answer).toMatchObject({ path: p, outcome: 'unconfirmed', errno: 'EIO', cut: false, what: 'whole', kind: 'sync' });
    expect(fileTicketState(t1)).toBe('unconfirmed');
    expect(fileTicketState(t2)).toBe('open');
    expect(errors.some(e => e.includes(p) && e.includes('the file is written whole'))).toBe(true);
    await flushAll();
    expect(read(p)).toBe('W1\n');
  });
});

describe('a held ticket whose lines a failed fsync left in the file', () => {
  it('confirms unavailable at once while a later op of the path is still queued', async () => {
    const p = fresh('h.jsonl');
    const sync = stub.holdSync(p, 'EIO');
    const t1 = append(p, 'L1\n');
    await sync.reached;
    const write = stub.holdWrite(p);
    append(p, 'L2\n');
    sync.release();
    await write.reached;
    const state = fileTicketState(t1);
    const answer = await confirmFile(t1, 0);
    write.release();
    await flushAll();
    expect(state).toBe('unconfirmed');
    expect(answer).toBe('unavailable');
    expect(read(p)).toBe('L1\nL2\n');
  });
});

describe('a cancel whose path a guild drop emptied during its wait', () => {
  it('drops the landing record of the op queued after the drop along with that op', async () => {
    const G = `9390${Date.now()}`;
    const p = dataPath(G, 'r18', `${++n}.jsonl`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const base = fileLandingRecords();
    const write = stub.holdWrite(p);
    enqueueAppend(p, 'L1\n');
    await write.reached;
    let mkdir: ReturnType<typeof failMkdir> | null = null;
    const cancelled = cancelQueued([p], () => waitUntil(() => mkdir !== null && mkdir.calls() > 0 && !fileFlushOnTheWire()));
    dropPendingForGuild(G);
    mkdir = failMkdir(path.dirname(p));
    enqueueWrite(p, 'W\n');
    fileTicket(p);
    write.release();
    const [answer] = await cancelled;
    mkdir!.restore();
    expect(answer).toEqual({ path: p, outcome: 'cancelled', errno: 'EIO' });
    expect(getPending(p)).toBeUndefined();
    expect(fileLandingRecords()).toBe(base);
    expect(read(p)).toBe('L1\n');
  });
});

describe('two cancels of one path, one ending first', () => {
  it('the cancel still waiting reads a record the path started after the other one ended', async () => {
    const p = fresh('p.jsonl');
    const q = fresh('q.jsonl');
    const syncP = stub.holdSync(p);
    append(p, 'P1\n');
    await syncP.reached;
    const syncQ = stub.holdSync(q);
    append(q, 'Q1\n');
    await syncQ.reached;
    const both = cancelQueued([p, q]);
    const onlyP = cancelQueued([p]);
    syncP.release();
    expect(await onlyP).toEqual([{ path: p, outcome: 'landed' }]);
    stub.shortWrite(p, () => 1);
    const t2 = append(p, 'P2\n');
    await until(() => stub.writes.some(w => w.path === p && w.accepted === 1) && fileTicketState(t2) === 'written');
    expect(getPending(p)).toBeDefined();
    syncQ.release();
    const [forP, forQ] = await both;
    expect(forQ).toEqual({ path: q, outcome: 'landed' });
    expect(forP).toMatchObject({ path: p, outcome: 'unconfirmed', errno: 'short write', cut: true, what: 'lines' });
    expect(read(p)).toBe('P1\nP');
    expect(getPending(p)).toBeUndefined();
  });
});

describe('a finished cancel', () => {
  it('holds no landing record that its path starts afterwards', async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const p = fresh('g.jsonl');
    enqueueWrite(p, 'W\n');
    expect(await cancelQueued([p])).toEqual([{ path: p, outcome: 'cancelled', errno: null }]);
    const ref = (() => new WeakRef(append(p, 'L1\n').record))();
    await flushAll();
    expect(read(p)).toBe('L1\n');
    expect(getPending(p)).toBeUndefined();
    for (let i = 0; i < 20 && ref.deref() !== undefined; i++) {
      await new Promise(resolve => setImmediate(resolve));
      gc();
    }
    expect(ref.deref()).toBeUndefined();
  });
});
