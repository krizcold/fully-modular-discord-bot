import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chain = vi.hoisted(() => ({
  calls: [] as string[],
  holds: [] as Array<{ dir: string; answer: () => Promise<unknown> }>,
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/folderChain')>();
  const nodePath = await import('path');
  return {
    ...real,
    syncFolderChain: async (dir: string) => {
      const at = nodePath.resolve(dir);
      chain.calls.push(at);
      const i = chain.holds.findIndex(h => h.dir === at);
      if (i >= 0) return chain.holds.splice(i, 1)[0].answer();
      return real.syncFolderChain(dir);
    },
  };
});

import {
  cancelQueued,
  confirmFile,
  enqueueAppend,
  enqueueDelete,
  enqueueWrite,
  failReplacedTriesAtExit,
  fileTicket,
  fileTicketFailure,
  fileTicketState,
  flushAll,
  forgetDurableFiles,
  forgetGuildDurableFiles,
  getPending,
  unconfirmedFiles,
  unsavedFilePaths,
  unsavedFileWrites,
  type FileTicket,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import { stubAppendHandles, type AppendStub } from '../helpers/fileHandleStub';

let n = 0;
let dir = '';
let stub: AppendStub;
let errors: string[];
const fresh = (name: string) => path.join(dir, `${++n}-${name}`);
const read = (p: string) => fs.readFileSync(p, 'utf8');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const L = (i: number) => `{"line":${i}}\n`;

function append(p: string, text: string): FileTicket {
  enqueueAppend(p, text);
  return fileTicket(p);
}

async function until(done: () => boolean) {
  for (let i = 0; i < 400 && !done(); i++) await sleep(5);
  expect(done()).toBe(true);
}

/** Holds the next folder chain of dir, then answers it failed with EIO. */
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

const chainsOf = (at: string) => chain.calls.filter(c => c === path.resolve(at)).length;

beforeEach(() => {
  dir = dataPath('ra34', String(Date.now()), String(++n));
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
  stub.restore();
  await flushAll();
  vi.restoreAllMocks();
});

describe('a replaced whole write that a newer write answered for', () => {
  it('is not failed at the exit once the newer write landed', async () => {
    const p = fresh('w.json');
    const before = unconfirmedFiles();
    const hold = holdChain(path.dirname(p));
    enqueueWrite(p, 'L1\n');
    const t1 = fileTicket(p);
    await hold.reached;
    enqueueWrite(p, 'L1\nL2\n');
    const t2 = fileTicket(p);
    hold.release();
    await flushAll();
    expect(read(p)).toBe('L1\nL2\n');
    expect(fileTicketState(t2)).toBe('landed');
    expect(fileTicketState(t1)).toBe('landed');
    failReplacedTriesAtExit();
    expect(fileTicketState(t1)).toBe('landed');
    expect(fileTicketFailure(t1)).toBeNull();
    expect(await confirmFile(t1, 0)).toBe('ok');
    expect(errors.filter(e => e.includes(p))).toEqual([]);
    expect(unconfirmedFiles()).toBe(before);
  });
});

describe('the counts of queued and unconfirmed files', () => {
  it('an append queued empty after a short write counts unconfirmed only; writes, deletes and other appends count unsaved', async () => {
    const p = fresh('e.jsonl');
    fs.writeFileSync(p, '');
    stub.shortWrite(p, text => Buffer.byteLength(text) - 1);
    const before = unconfirmedFiles();
    const unsavedBefore = unsavedFilePaths();
    enqueueAppend(p, 'L1\n');
    for (let i = 0; i < 400 && !stub.appendCloses.includes(p); i++) await sleep(5);
    await sleep(10);
    expect(read(p)).toBe('L1');
    expect(getPending(p)).toMatchObject({ op: 'append', content: '' });
    const w = fresh('w.json');
    const d = fresh('d.json');
    const a1 = fresh('a1.jsonl');
    const a2 = fresh('a2.jsonl');
    enqueueWrite(w, '{}');
    enqueueDelete(d);
    enqueueAppend(a1, 'x\n');
    enqueueAppend(a2, 'y\n');
    expect(unconfirmedFiles()).toBe(before + 1);
    const added = unsavedFilePaths().filter(x => !unsavedBefore.includes(x)).sort();
    expect(added).toEqual([w, d, a1, a2].sort());
    expect(unsavedFileWrites()).toBe(unsavedBefore.length + 4);
    await flushAll();
    expect(read(p)).toBe('L1\n');
  });
});

describe('durable file names', () => {
  it('forgetDurableFiles makes the next append sync the folder chain again', async () => {
    const p = fresh('x.jsonl');
    enqueueAppend(p, L(1));
    await flushAll();
    if (fs.statSync(p, { bigint: true }).birthtimeNs <= 0n) return;
    const first = chainsOf(path.dirname(p));
    expect(first).toBe(1);
    enqueueAppend(p, L(2));
    await flushAll();
    expect(chainsOf(path.dirname(p))).toBe(1);
    forgetDurableFiles();
    enqueueAppend(p, L(3));
    await flushAll();
    expect(chainsOf(path.dirname(p))).toBe(2);
    expect(read(p)).toBe(L(1) + L(2) + L(3));
  });

  it('forgetGuildDurableFiles forgets the names under that guild only', async () => {
    const g1 = `91${Date.now()}${++n}`;
    const g2 = `92${Date.now()}${++n}`;
    const p1 = path.join(DATA_ROOT, g1, 'c', 'x.jsonl');
    const p2 = path.join(DATA_ROOT, g2, 'c', 'x.jsonl');
    enqueueAppend(p1, L(1));
    enqueueAppend(p2, L(1));
    await flushAll();
    if (fs.statSync(p1, { bigint: true }).birthtimeNs <= 0n) return;
    enqueueAppend(p1, L(2));
    enqueueAppend(p2, L(2));
    await flushAll();
    expect(chainsOf(path.dirname(p1))).toBe(1);
    expect(chainsOf(path.dirname(p2))).toBe(1);
    forgetGuildDurableFiles(g1);
    enqueueAppend(p1, L(3));
    enqueueAppend(p2, L(3));
    await flushAll();
    expect(chainsOf(path.dirname(p1))).toBe(2);
    expect(chainsOf(path.dirname(p2))).toBe(1);
    expect(read(p1)).toBe(L(1) + L(2) + L(3));
    expect(read(p2)).toBe(L(1) + L(2) + L(3));
  });
});

describe('failed ranges of an append queue', () => {
  it('a line that landed before a later line failed its sync stays landed', async () => {
    const p = fresh('l.jsonl');
    const hw = stub.holdWrite(p);
    const hs = stub.holdSync(p);
    stub.failSync(p, 'EIO');
    const t1 = append(p, L(1));
    await hw.reached;
    const t2 = append(p, L(2));
    hw.release();
    await hs.reached;
    hs.release();
    await until(() => fileTicketState(t2) === 'unconfirmed');
    expect(read(p)).toBe(L(1) + L(2));
    expect(fileTicketState(t1)).toBe('landed');
    expect(fileTicketFailure(t1)).toBeNull();
    expect(await confirmFile(t1, 0)).toBe('ok');
    expect(fileTicketFailure(t2)).toMatchObject({ errno: 'EIO', cut: false });
  });

  it("three failed syncs in a row: a cancel taken during the second answers the second's errno", async () => {
    const p = fresh('f.jsonl');
    const hs1 = stub.holdSync(p, 'EIO');
    const t1 = append(p, L(1));
    await hs1.reached;
    const hs2 = stub.holdSync(p, 'ENOSPC');
    const t2 = append(p, L(2));
    hs1.release();
    await hs2.reached;
    let t3: FileTicket | null = null;
    const cancelled = cancelQueued([p], async ms => {
      for (let i = 0; i < 400 && !(t3 && fileTicketState(t3) === 'unconfirmed'); i++) await sleep(5);
      await sleep(ms);
    });
    stub.failSync(p, 'EROFS');
    t3 = append(p, L(3));
    expect([t2.seq - t1.seq, t3.seq - t2.seq]).toEqual([1, 1]);
    hs2.release();
    expect(await cancelled).toEqual([{ path: p, outcome: 'unconfirmed', errno: 'ENOSPC', cut: false, what: 'lines' }]);
    expect(read(p)).toBe(L(1) + L(2) + L(3));
    expect(fileTicketFailure(t1)).toMatchObject({ errno: 'EIO' });
    expect(fileTicketFailure(t2)).toMatchObject({ errno: 'ENOSPC' });
    expect(fileTicketFailure(t3)).toMatchObject({ errno: 'EROFS' });
  });
});
