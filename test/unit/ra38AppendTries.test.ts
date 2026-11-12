import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chain = vi.hoisted(() => ({ calls: [] as string[], fail: [] as string[] }));
vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/folderChain')>();
  return {
    ...real,
    syncFolderChain: async (dir: string) => {
      chain.calls.push(dir);
      const errno = chain.fail.shift();
      if (errno) return { failed: true, kind: 'sync', dir, errno, error: Object.assign(new Error(`${errno}: stubbed fsync`), { code: errno }) };
      return real.syncFolderChain(dir);
    },
  };
});

import {
  cancelQueued,
  dropPendingForGuild,
  enqueueAppend,
  enqueueWrite,
  fileFlushesLanded,
  fileFlushOnTheWire,
  fileTicket,
  fileTicketFailure,
  fileTicketState,
  flushAll,
  forgetDurableFiles,
  getFlushFailures,
  guildFailingWrite,
  queuedFilePaths,
  setRowCancel,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { DATA_ROOT } from '../../src/utils/dataRoot';
import { resetFolderSyncFailureForTests } from '../../src/bot/internalSetup/utils/folderChain';
import { stubAppendHandles, type AppendStub } from '../helpers/fileHandleStub';

let n = 0;
let dir = '';
let stub: AppendStub;
let shift = 0;
const fresh = (name = 'a.jsonl') => path.join(dir, `${++n}-${name}`);
const read = (p: string) => fs.readFileSync(p, 'utf8');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const chainCalls = (p: string) => chain.calls.filter(d => d === path.dirname(p)).length;

async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`condition not met in ${ms} ms`);
    await wait(2);
  }
}

/** A path under its own guild folder, so the guild readers see it. */
function guildPath() {
  const gid = `ra38g${Date.now()}${++n}`;
  const p = path.join(DATA_ROOT, gid, 'x.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return { gid, p };
}

/** Fixes the birth time the append reads, so a file's identity holds on every file system. */
const fixBirth = (p: string) => stub.statAs(p, () => ({ birthtimeNs: 1_000_000n }), 1000);

beforeEach(() => {
  dir = path.join(DATA_ROOT, 'ra38', `${Date.now()}-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const realNow = performance.now.bind(performance);
  shift = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => realNow() + shift);
  stub = stubAppendHandles();
  chain.calls.length = 0;
  chain.fail.length = 0;
  resetFolderSyncFailureForTests();
  forgetDurableFiles();
});
afterEach(async () => {
  stub.restore();
  setRowCancel(null);
  await cancelQueued(queuedFilePaths());
  shift = 0;
  vi.restoreAllMocks();
});

describe('the folder chain of an append', () => {
  it('a failed folder chain leaves the appended lines unconfirmed', async () => {
    const p = fresh();
    chain.fail.push('EIO');
    enqueueAppend(p, 'A\n');
    const t = fileTicket(p);
    await flushAll();
    expect(chainCalls(p)).toBe(1);
    expect(read(p)).toBe('A\n');
    expect(fileTicketState(t)).toBe('unconfirmed');
    expect(fileTicketFailure(t)).toMatchObject({ errno: 'EIO', kind: 'sync', dir: path.dirname(p) });
  });

  it('a second append to a file whose chain landed does not sync the chain again', async () => {
    const p = fresh();
    fixBirth(p);
    enqueueAppend(p, 'A\n');
    await flushAll();
    enqueueAppend(p, 'B\n');
    await flushAll();
    expect(read(p)).toBe('A\nB\n');
    expect(chainCalls(p)).toBe(1);
  });

  it('an append whose write was refused before any byte keeps the file durable', async () => {
    const p = fresh();
    fixBirth(p);
    enqueueAppend(p, 'A\n');
    await flushAll();
    stub.failWrite(p, 'EIO');
    enqueueAppend(p, 'B\n');
    await flushAll();
    expect(read(p)).toBe('A\nB\n');
    expect(chainCalls(p)).toBe(1);
  });

  it('an append cut short syncs the chain again on its next try', async () => {
    const p = fresh();
    fixBirth(p);
    enqueueAppend(p, 'A\n');
    await flushAll();
    stub.shortWrite(p, () => 1);
    enqueueAppend(p, 'B\n');
    await flushAll();
    expect(read(p)).toBe('A\nB\n');
    expect(chainCalls(p)).toBe(2);
  });

  it('an append whose file sync failed syncs the chain on the next append', async () => {
    const p = fresh();
    fixBirth(p);
    enqueueAppend(p, 'A\n');
    await flushAll();
    stub.failSync(p, 'EIO');
    enqueueAppend(p, 'B\n');
    await flushAll();
    expect(chainCalls(p)).toBe(1);
    enqueueAppend(p, 'C\n');
    await flushAll();
    expect(read(p)).toBe('A\nB\nC\n');
    expect(chainCalls(p)).toBe(2);
  });
});

describe('the bytes a cut try leaves', () => {
  it('a try that wrote only the guard newline keeps a leading empty line', async () => {
    const p = fresh();
    fs.writeFileSync(p, 'old');
    stub.shortWrite(p, () => 1);
    enqueueAppend(p, '\nX\n');
    await flushAll();
    expect(read(p)).toBe('old\n\nX\n');
  });

  it('a try that wrote the guard and one line without its newline writes the next line once', async () => {
    const p = fresh();
    fs.writeFileSync(p, 'old');
    stub.shortWrite(p, () => 2);
    enqueueAppend(p, 'A\nB\n');
    await flushAll();
    expect(read(p)).toBe('old\nA\nB\n');
  });

  it('a cut inside a last line with no newline writes that line again on a line of its own', async () => {
    const p = fresh();
    stub.shortWrite(p, () => 3);
    enqueueAppend(p, 'A\nBC');
    await flushAll();
    expect(read(p)).toBe('A\nB\nBC');
  });

  it('a cut after a leading empty line and a line without its newline closes that line only', async () => {
    const p = fresh();
    stub.shortWrite(p, () => 2);
    enqueueAppend(p, '\nX\n');
    await flushAll();
    expect(read(p)).toBe('\nX\n');
  });

  it('a cut after two whole lines writes only the third again', async () => {
    const p = fresh();
    stub.shortWrite(p, () => 4);
    enqueueAppend(p, 'A\nB\nC\n');
    await flushAll();
    expect(read(p)).toBe('A\nB\nC\n');
  });
});

describe('a failing append and the storage readers', () => {
  it('one failed append refuses writes to its folder once it has failed for 30 seconds', async () => {
    const p = fresh();
    stub.failWrite(p, 'ENOSPC', 100);
    enqueueAppend(p, 'A\n');
    await flushAll();
    shift = 31_000;
    expect(() => enqueueWrite(fresh('b.json'), '{}')).toThrow();
  });

  it('a later failure of the same append does not restart its failing age', async () => {
    const p = fresh();
    stub.failWrite(p, 'ENOSPC', 100);
    enqueueAppend(p, 'A\n');
    await flushAll();
    shift = 31_000;
    await flushAll();
    expect(() => enqueueWrite(fresh('b.json'), '{}')).toThrow();
  });

  it('an append that failed and then landed does not refuse writes to its folder later', async () => {
    const p = fresh();
    stub.failWrite(p, 'ENOSPC');
    enqueueAppend(p, 'A\n');
    await flushAll();
    expect(read(p)).toBe('A\n');
    shift = 31_000;
    const q = fresh('b.json');
    expect(() => enqueueWrite(q, '{}')).not.toThrow();
    await flushAll();
  });

  it('a failing append names its file and error code to the guild reader', async () => {
    const { gid, p } = guildPath();
    stub.failWrite(p, 'ENOSPC', 100);
    enqueueAppend(p, 'A\n');
    await flushAll();
    expect(guildFailingWrite(gid)).toEqual({ file: 'x.jsonl', code: 'ENOSPC' });
  });

  it('an append that failed and then landed is not named failing for a later append', async () => {
    const { gid, p } = guildPath();
    stub.failWrite(p, 'ENOSPC');
    enqueueAppend(p, 'A\n');
    await flushAll();
    enqueueAppend(p, 'B\n');
    expect(guildFailingWrite(gid)).toBeNull();
    await flushAll();
    expect(read(p)).toBe('A\nB\n');
  });

  it('a cancel after a failed file sync answers that sync error', async () => {
    const p = fresh();
    stub.failSync(p, 'EROFS');
    enqueueAppend(p, 'A\n');
    await flushAll();
    enqueueAppend(p, 'B\n');
    const [answer] = await cancelQueued([p]);
    expect(answer).toEqual({ path: p, outcome: 'cancelled', errno: 'EROFS' });
  });

  it('a landed append counts one landed flush', async () => {
    const p = fresh();
    const before = fileFlushesLanded();
    enqueueAppend(p, 'A\n');
    await flushAll();
    expect(fileFlushesLanded() - before).toBe(1);
  });
});

describe('tickets and cancels over several tries of one record', () => {
  it('a failed sync of a coalesced append leaves the landed one landed', async () => {
    const p = fresh();
    const hold = stub.holdSync(p);
    stub.failSync(p, 'EIO');
    enqueueAppend(p, 'A\n');
    const t0 = fileTicket(p);
    await hold.reached;
    enqueueAppend(p, 'B\n');
    const t1 = fileTicket(p);
    hold.release();
    await flushAll();
    expect(fileTicketState(t0)).toBe('landed');
    expect(fileTicketState(t1)).toBe('unconfirmed');
  });

  it('a cancel answers landed for its target when only a newer coalesced try failed', async () => {
    const p = fresh();
    const hold = stub.holdSync(p);
    stub.failSync(p, 'EIO');
    enqueueAppend(p, 'A\n');
    await hold.reached;
    let first = true;
    const sleep = async () => {
      if (!first) return void (await wait(5));
      first = false;
      enqueueAppend(p, 'B\n');
      hold.release();
      await until(() => !queuedFilePaths().includes(p) && !fileFlushOnTheWire());
    };
    const [answer] = await cancelQueued([p], sleep);
    expect(answer).toEqual({ path: p, outcome: 'landed' });
  });

  it('a cancel answers unconfirmed for a target whose failed range starts at it', async () => {
    const p = fresh();
    const hold = stub.holdSync(p);
    stub.failSync(p, 'EIO');
    enqueueAppend(p, 'A\n');
    const t0 = fileTicket(p);
    await hold.reached;
    enqueueAppend(p, 'B\n');
    const t1 = fileTicket(p);
    expect(t1.seq).toBe(t0.seq + 1);
    let first = true;
    const sleep = async () => {
      if (!first) return void (await wait(5));
      first = false;
      hold.release();
      await until(() => !queuedFilePaths().includes(p) && !fileFlushOnTheWire());
    };
    const [answer] = await cancelQueued([p], sleep);
    expect(answer).toMatchObject({ path: p, outcome: 'unconfirmed', errno: 'EIO', cut: false });
  });

  it('a cancel answers the error of the failed range nearest its target', async () => {
    const { gid, p } = guildPath();
    const h0 = stub.holdSync(p, 'EACCES');
    const h1 = stub.holdSync(p, 'EROFS');
    const h2 = stub.holdSync(p, 'ENOSPC');
    enqueueAppend(p, 'E0\n');
    await h0.reached;
    dropPendingForGuild(gid);
    enqueueAppend(p, 'F1\n');
    let first = true;
    const sleep = async () => {
      if (!first) return void (await wait(5));
      first = false;
      h0.release();
      await h1.reached;
      enqueueAppend(p, 'F2\n');
      h1.release();
      await h2.reached;
      enqueueAppend(p, 'F3\n');
      stub.rejectOpen(p, 'EIO');
      const failures = getFlushFailures();
      h2.release();
      await until(() => getFlushFailures() > failures && !fileFlushOnTheWire());
    };
    const [answer] = await cancelQueued([p], sleep);
    expect(answer).toMatchObject({ path: p, outcome: 'unconfirmed', errno: 'ENOSPC', cut: false });
  });
});

describe('a cancel over row and file paths', () => {
  it('answers a file path beside a row path', async () => {
    const rowPath = fresh('row.json');
    const filePath = fresh('file.json');
    setRowCancel({ holds: q => q === rowPath, cancel: async ps => ps.map(q => ({ path: q, outcome: 'landed' as const, row: true as const })) });
    const answers = await cancelQueued([rowPath, filePath]);
    expect(answers).toEqual([{ path: rowPath, outcome: 'landed', row: true }, { path: filePath, outcome: 'landed' }]);
  });
});
