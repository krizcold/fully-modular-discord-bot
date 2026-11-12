import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Answer = { failed: false } | { failed: true; kind: 'sync'; dir: string; errno: string; error: unknown };
type Step = () => Answer | Promise<Answer>;

const h = vi.hoisted(() => ({ calls: [] as string[], plan: new Map<string, Array<() => unknown>>() }));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  const nodePath = await import('path');
  return {
    ...real,
    syncFolderChain: async (dir: string) => {
      const at = nodePath.resolve(dir);
      h.calls.push(at);
      const step = h.plan.get(at)?.shift();
      return step ? step() : { failed: false };
    },
  };
});

import {
  cancelQueued,
  confirmFile,
  enqueueAppend,
  enqueueWrite,
  failReplacedTriesAtExit,
  fileFlushesLanded,
  fileTicket,
  fileTicketFailure,
  fileTicketState,
  flushAll,
  forgetDurableFiles,
  queuedFilePaths,
  unconfirmedFiles,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';
import { stubAppendHandles, type AppendStub } from '../helpers/fileHandleStub';

let n = 0;
let dir = '';
let errors: string[] = [];
let stub: AppendStub;
let releaseHeld: () => void = () => undefined;

const fresh = (name: string) => path.join(dir, `${++n}-${name}`);
const fail = (at: string): Answer => ({ failed: true, kind: 'sync', dir: at, errno: 'EIO', error: Object.assign(new Error('EIO: stubbed'), { code: 'EIO' }) });
const plan = (...steps: Step[]) => h.plan.set(path.resolve(dir), steps);
const chainCalls = () => h.calls.filter(c => c === path.resolve(dir)).length;
const wholeLine = (p: string) =>
  `[Data] ${p}: the file is written whole, but the disk did not confirm the sync of ${path.resolve(dir)} (EIO); it is not written again; can't confirm it is stored. Check the disk, then restart the machine.`;
const linesOf = (p: string) => errors.filter(e => e.includes(p) && e.includes('written whole')).length;

async function until(what: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 3000;
  while (!what()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

beforeEach(() => {
  dir = dataPath('ra37', String(process.pid), String(++n));
  fs.mkdirSync(dir, { recursive: true });
  errors = [];
  h.calls.length = 0;
  h.plan.clear();
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  stub = stubAppendHandles();
  forgetDurableFiles();
});

afterEach(async () => {
  h.plan.clear();
  releaseHeld();
  releaseHeld = () => undefined;
  stub.restore();
  vi.restoreAllMocks();
  await flushAll();
});

describe('a whole write whose folder chain fails', () => {
  it('is in the file whole, its ticket unconfirmed with the chain\'s errno, counted and logged once, and not written again', async () => {
    const p = fresh('a.json');
    const before = unconfirmedFiles();
    plan(() => fail(path.resolve(dir)));
    enqueueWrite(p, '{"a":1}\n');
    const t = fileTicket(p);
    await flushAll();
    expect(fs.readFileSync(p, 'utf8')).toBe('{"a":1}\n');
    expect(fileTicketState(t)).toBe('unconfirmed');
    expect(fileTicketFailure(t)).toEqual({ errno: 'EIO', cut: false, what: 'whole', kind: 'sync', dir: path.resolve(dir) });
    expect(unconfirmedFiles()).toBe(before + 1);
    expect(errors.filter(e => e === wholeLine(p))).toHaveLength(1);
    expect(queuedFilePaths()).not.toContain(p);
  });

  it('a newer write cancelled before its flush answers cancelled with the failed chain\'s errno', async () => {
    const p = fresh('b.json');
    plan(() => fail(path.resolve(dir)));
    enqueueWrite(p, '{"b":1}\n');
    fileTicket(p);
    await flushAll();
    enqueueWrite(p, '{"b":2}\n');
    const answers = await cancelQueued([p]);
    expect(answers).toEqual([{ path: p, outcome: 'cancelled', errno: 'EIO' }]);
    await flushAll();
    expect(fs.readFileSync(p, 'utf8')).toBe('{"b":1}\n');
  });

  it('after an earlier write of the same record landed, only the failed write\'s ticket is unconfirmed', async () => {
    const p = fresh('c.json');
    let t2 = null as ReturnType<typeof fileTicket> | null;
    plan(
      () => { enqueueWrite(p, '{"c":2}\n'); t2 = fileTicket(p); return { failed: false }; },
      () => fail(path.resolve(dir)),
    );
    enqueueWrite(p, '{"c":1}\n');
    const t1 = fileTicket(p);
    await flushAll();
    expect(fs.readFileSync(p, 'utf8')).toBe('{"c":2}\n');
    expect(t2!.record).toBe(t1.record);
    expect(fileTicketState(t1)).toBe('landed');
    expect(fileTicketState(t2!)).toBe('unconfirmed');
  });

  it('a write replaced during its failed chain is answered for by the newer failed write: the exit logs no second line', async () => {
    const p = fresh('d.json');
    let t2 = null as ReturnType<typeof fileTicket> | null;
    plan(
      () => { enqueueWrite(p, '{"d":2}\n'); t2 = fileTicket(p); return fail(path.resolve(dir)); },
      () => fail(path.resolve(dir)),
    );
    enqueueWrite(p, '{"d":1}\n');
    const t1 = fileTicket(p);
    await flushAll();
    expect(fileTicketState(t1)).toBe('unconfirmed');
    expect(fileTicketState(t2!)).toBe('unconfirmed');
    expect(linesOf(p)).toBe(1);
    failReplacedTriesAtExit();
    expect(linesOf(p)).toBe(1);
  });

  it('a write replaced during its failed chain, the newer one still on the wire at the exit: the exit fails only the replaced write', async () => {
    const p = fresh('e.json');
    let t1 = null as ReturnType<typeof fileTicket> | null;
    let reached = false;
    let release: (a: Answer) => void = () => undefined;
    plan(
      () => { enqueueWrite(p, '{"e":1}\n'); t1 = fileTicket(p); return { failed: false }; },
      () => { enqueueWrite(p, '{"e":2}\n'); return fail(path.resolve(dir)); },
      () => new Promise<Answer>(resolve => { reached = true; release = resolve; releaseHeld = () => resolve({ failed: false }); }),
    );
    enqueueWrite(p, '{"e":0}\n');
    const t0 = fileTicket(p);
    await until(() => reached, 'the third chain');
    expect(fileTicketState(t1!)).toBe('open');
    failReplacedTriesAtExit();
    expect(fileTicketState(t0)).toBe('landed');
    expect(fileTicketState(t1!)).toBe('unconfirmed');
    expect(fileTicketFailure(t1!)).toEqual({ errno: 'EIO', cut: false, what: 'whole', kind: 'sync', dir: path.resolve(dir) });
    expect(errors.filter(e => e === wholeLine(p))).toHaveLength(1);
    release({ failed: false });
    await flushAll();
    expect(fs.readFileSync(p, 'utf8')).toBe('{"e":2}\n');
  });

  it('confirmFile keeps trying after a replaced try whose chain failed, and answers ok once the newer write lands', async () => {
    const p = fresh('f.json');
    const realMkdir = fs.promises.mkdir.bind(fs.promises);
    const script = ['fail', 'fail', 'fail', 'ok', 'fail'];
    vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (d: fs.PathLike, o?: fs.MakeDirectoryOptions) => {
      if (path.resolve(String(d)) === path.resolve(dir) && script.shift() === 'fail') throw Object.assign(new Error('ENOSPC: stubbed mkdir'), { code: 'ENOSPC' });
      return realMkdir(d, o);
    }) as typeof fs.promises.mkdir);
    plan(() => { enqueueWrite(p, '{"f":2}\n'); return fail(path.resolve(dir)); });
    enqueueWrite(p, '{"f":1}\n');
    const t1 = fileTicket(p);
    await until(() => script.length === 4 && errors.some(e => e.includes(`Flush failed for ${p}`)), 'the scheduled try');
    expect(await confirmFile(t1, 5000)).toBe('ok');
    expect(fs.readFileSync(p, 'utf8')).toBe('{"f":2}\n');
  });

  it('a write that lands counts one landed flush', async () => {
    const p = fresh('g.json');
    const before = fileFlushesLanded();
    enqueueWrite(p, '{"g":1}\n');
    await flushAll();
    expect(fs.readFileSync(p, 'utf8')).toBe('{"g":1}\n');
    expect(fileFlushesLanded()).toBe(before + 1);
  });
});

describe('an append and the folder chain skip', () => {
  const over: { ino?: bigint; birth?: bigint } = {};
  const identity = (p: string) =>
    stub.statAs(p, real => ({ ino: over.ino ?? real.ino, birthtimeNs: over.birth ?? (real.birthtimeNs > 0n ? real.birthtimeNs : 1n) }), 1_000);
  const appendLanded = async (p: string, line: string) => {
    enqueueAppend(p, line);
    await flushAll();
  };
  beforeEach(() => {
    delete over.ino;
    delete over.birth;
  });

  it('the first append to a file with lines runs the chain; later appends to the same file fsync it only', async () => {
    const p = fresh('a.jsonl');
    fs.writeFileSync(p, '{"x":0}\n');
    identity(p);
    await appendLanded(p, '{"x":1}\n');
    expect(chainCalls()).toBe(1);
    await appendLanded(p, '{"x":2}\n');
    expect(chainCalls()).toBe(1);
    await appendLanded(p, '{"x":3}\n');
    expect(chainCalls()).toBe(1);
    expect(fs.readFileSync(p, 'utf8')).toBe('{"x":0}\n{"x":1}\n{"x":2}\n{"x":3}\n');
  });

  it('a file whose inode number changed runs the chain again', async () => {
    const p = fresh('b.jsonl');
    identity(p);
    await appendLanded(p, '{"x":1}\n');
    expect(chainCalls()).toBe(1);
    over.ino = 987_654_321n;
    await appendLanded(p, '{"x":2}\n');
    expect(chainCalls()).toBe(2);
  });

  it('a file whose birth time changed runs the chain again', async () => {
    const p = fresh('c.jsonl');
    identity(p);
    await appendLanded(p, '{"x":1}\n');
    expect(chainCalls()).toBe(1);
    over.birth = 123_456_789n;
    await appendLanded(p, '{"x":2}\n');
    expect(chainCalls()).toBe(2);
  });

  it('a file with a birth time of 0 runs the chain at every append', async () => {
    const p = fresh('d.jsonl');
    over.birth = 0n;
    identity(p);
    await appendLanded(p, '{"x":1}\n');
    await appendLanded(p, '{"x":2}\n');
    expect(chainCalls()).toBe(2);
  });

  it('a file emptied since its last append runs the chain again', async () => {
    const p = fresh('e.jsonl');
    identity(p);
    await appendLanded(p, '{"x":1}\n');
    expect(chainCalls()).toBe(1);
    fs.truncateSync(p, 0);
    await appendLanded(p, '{"x":2}\n');
    expect(chainCalls()).toBe(2);
    expect(fs.readFileSync(p, 'utf8')).toBe('{"x":2}\n');
  });

  it('a try that saw another file and failed before any byte leaves the next try to run the chain', async () => {
    const p = fresh('f.jsonl');
    identity(p);
    await appendLanded(p, '{"x":1}\n');
    expect(chainCalls()).toBe(1);
    over.ino = 987_654_321n;
    stub.failWrite(p, 'EIO');
    enqueueAppend(p, '{"x":2}\n');
    await until(() => stub.appendCloses.filter(c => c === p).length >= 2, 'the failed try');
    delete over.ino;
    await flushAll();
    expect(chainCalls()).toBe(2);
    expect(fs.readFileSync(p, 'utf8')).toBe('{"x":1}\n{"x":2}\n');
  });

  it('a short write logs how many bytes the disk took of how many', async () => {
    const p = fresh('g.jsonl');
    fs.writeFileSync(p, '');
    stub.shortWrite(p, () => 3);
    enqueueAppend(p, '{"x":1}\n');
    await until(() => errors.some(e => e.includes(`Flush failed for ${p}`)), 'the short try');
    expect(errors.filter(e => e.includes(`Flush failed for ${p}`))).toEqual([expect.stringContaining('short write: 3 of 8 bytes')]);
    await flushAll();
  });

  it('a write that fails before any byte runs no fsync or chain in its try', async () => {
    const p = fresh('h.jsonl');
    stub.failWrite(p, 'EIO');
    enqueueAppend(p, '{"x":1}\n');
    await until(() => stub.appendCloses.includes(p), 'the failed try');
    expect(chainCalls()).toBe(0);
    await flushAll();
    expect(chainCalls()).toBe(1);
    expect(fs.readFileSync(p, 'utf8')).toBe('{"x":1}\n');
  });
});
