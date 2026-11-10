import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => ({
  ...(await orig<any>()),
  getPaymentRegistry: () => ({ on: () => undefined, off: () => undefined, get: () => undefined, list: () => [], startTickers: () => undefined }),
}));

import {
  cancelQueued,
  confirmFile,
  dropPendingForGuild,
  enqueueAppend,
  enqueueDelete,
  enqueueWrite,
  fileTicket,
  fileTicketFailure,
  fileTicketState,
  flushAll,
  forgetDurableFiles,
  graveyardGuildDir,
  queuedFilePaths,
  unconfirmedFiles,
  type FileTicket,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { appendData, appendDataTracked, confirmSaved, deleteData, drainForExit, saveMark } from '../../src/bot/internalSetup/utils/dataManager';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import { resetFolderSyncFailureForTests, syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { setBackendKind } from '../helpers/backendKind';
import { stubAppendHandles, type AppendStub } from '../helpers/fileHandleStub';

// NB13 decision 8 and C8, C9, D3: the JSON append is O_APPEND with a newline guard, never writes accepted bytes
// again, fsyncs the file and the directory chain, and judges every file ticket through fileTicketState.

const POSIX = process.platform !== 'win32';
let n = 0;
let dir = '';
let stub: AppendStub;
const fresh = (name = 'a.jsonl') => path.join(dir, `${++n}-${name}`);
const read = (p: string) => fs.readFileSync(p, 'utf8');
const L = (i: number) => `{"line":${i}}\n`;

const ticketOf = (tracked: ReturnType<typeof appendDataTracked>): FileTicket => {
  if (tracked.outcome !== 'appended' || tracked.ticket.kind !== 'file') throw new Error(`not appended: ${tracked.outcome}`);
  return tracked.ticket;
};

/** Queues one append and answers its ticket, taken in the enqueue's own turn. */
function append(p: string, text: string): FileTicket {
  enqueueAppend(p, text);
  return fileTicket(p);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Lets the flush scheduled by an enqueue run, and the ones it schedules. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};

/** Waits until the path's tries closed count handles (a try closes its handle last), without driving a retry. */
async function tried(p: string, count = 1) {
  for (let i = 0; i < 400 && stub.appendCloses.filter(c => c === p).length < count; i++) await sleep(5);
  await sleep(10);
}

/** 4.16's state: the whole write of L1 is renamed into place and its directory sync is held; L2 then replaced the entry. */
async function replacedTry() {
  setBackendKind('file');
  const opts = { scope: 'global' as const, category: `nb13fa${++n}` };
  const p = dataPath('global', opts.category, 'x.jsonl');
  appendData('x.jsonl', opts, 'old');
  await flushAll();
  const before = unconfirmedFiles();
  const hold = stub.holdDirSync(path.dirname(p), 'EIO');
  deleteData('x.jsonl', opts);
  appendData('x.jsonl', opts, 'L1');
  const t1 = fileTicket(p);
  await hold.reached;
  appendData('x.jsonl', opts, 'L2');
  const t2 = fileTicket(p);
  return { p, t1, t2, hold, before };
}

/** Rejects every mkdir of dir with ENOSPC, so a whole write of a file in it fails before its temp file. */
function failMkdir(dir: string) {
  const real = fs.promises.mkdir.bind(fs.promises);
  return vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (d: fs.PathLike, o?: fs.MakeDirectoryOptions) => {
    if (path.resolve(String(d)) === path.resolve(dir)) throw Object.assign(new Error('ENOSPC: stubbed mkdir'), { code: 'ENOSPC' });
    return real(d, o);
  }) as typeof fs.promises.mkdir);
}

let errors: string[];
beforeEach(() => {
  dir = dataPath('nb13fa', String(Date.now()), String(++n));
  fs.mkdirSync(dir, { recursive: true });
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  stub = stubAppendHandles();
  forgetDurableFiles();
});
afterEach(async () => {
  stub.restore();
  await flushAll();
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('4.1 to 4.4 and 4.7: where the bytes land', () => {
  it('4.1 an append follows the lines a file holds, and the first bytes are unchanged', async () => {
    const p = fresh();
    fs.writeFileSync(p, L(1) + L(2));
    append(p, L(3) + L(4));
    await flushAll();
    expect(read(p)).toBe(L(1) + L(2) + L(3) + L(4));
  });

  it('4.2 a short write inside line 2 of 3: the retry writes the guard and the lines not yet whole', async () => {
    const p = fresh();
    fs.writeFileSync(p, '');
    const k = L(1).length + 3;
    stub.shortWrite(p, () => k);
    const t = append(p, L(1) + L(2) + L(3));
    await tried(p);
    expect(read(p)).toBe(L(1) + L(2).slice(0, 3));
    expect(fileTicketState(t)).toBe('written');
    expect(await confirmFile(t, 0)).not.toBe('ok');
    await flushAll();
    expect(read(p)).toBe(`${L(1)}${L(2).slice(0, 3)}\n${L(2)}${L(3)}`);
    expect(await confirmFile(t, 1000)).toBe('ok');
  });

  it('4.3 a line arriving during a flush joins the entry and is written once after the first', async () => {
    const p = fresh();
    const hold = stub.holdWrite(p, true);
    const t1 = append(p, L(1));
    await hold.reached;
    const t2 = append(p, L(2));
    hold.release();
    expect(await confirmFile(t1, 1000)).toBe('ok');
    await flushAll();
    expect(read(p)).toBe(L(1) + L(2));
    expect(await confirmFile(t2, 1000)).toBe('ok');
  });

  it('4.4 a write that rejects ENOSPC before any byte is written whole once on the retry, with no guard, and its handle closed', async () => {
    const p = fresh();
    fs.writeFileSync(p, L(0));
    stub.failWrite(p, 'ENOSPC');
    append(p, L(1) + L(2));
    await flushAll();
    expect(read(p)).toBe(L(0) + L(1) + L(2));
    expect(stub.appendCloses.filter(c => c === p).length).toBe(stub.appendOpens.filter(o => o === p).length);
  });

  it('4.7 a tail with no newline stays a line of its own; a file ending in a newline gets no guard; no try shrinks a file', async () => {
    const a = fresh();
    fs.writeFileSync(a, 'a;');
    append(a, 'x\n');
    await flushAll();
    expect(read(a)).toBe('a;\nx\n');
    const torn = fresh();
    fs.writeFileSync(torn, `${L(1)}{"a":`);
    append(torn, L(2));
    await flushAll();
    expect(read(torn)).toBe(`${L(1)}{"a":\n${L(2)}`);
    const whole = fresh();
    fs.writeFileSync(whole, L(1));
    const sizes = [fs.statSync(whole).size];
    for (const i of [2, 3]) {
      append(whole, L(i));
      await flushAll();
      sizes.push(fs.statSync(whole).size);
    }
    expect(read(whole)).toBe(L(1) + L(2) + L(3));
    expect(sizes).toEqual([...sizes].sort((x, y) => x - y));
  });
});

describe('4.5: every handle is closed once', () => {
  it.each([
    ['the last-byte read', (p: string) => stub.failRead(p, 'EIO')],
    ['the write', (p: string) => stub.failWrite(p, 'EIO')],
    ['the file fsync', (p: string) => stub.failSync(p, 'EIO')],
    ['a success', () => undefined],
  ])('%s', async (_name, arrange) => {
    const p = fresh();
    fs.writeFileSync(p, L(0));
    arrange(p);
    append(p, L(1));
    await flushAll();
    await flushAll();
    const opens = stub.appendOpens.filter(o => o === p).length;
    expect(opens).toBeGreaterThan(0);
    expect(stub.appendCloses.filter(c => c === p).length).toBe(opens);
  });

  it('a close that throws after a failed write is logged, and the try keeps the write error', async () => {
    const p = fresh();
    stub.failWrite(p, 'ENOSPC');
    stub.failClose(p, 'EBADF');
    append(p, L(1));
    await flushAll();
    expect(errors.some(e => e.includes(p) && e.includes('EBADF'))).toBe(true);
    expect(errors.some(e => e.includes(p) && e.includes('ENOSPC'))).toBe(true);
  });

  it('a close error names its code, or says it has none, and changes no answer', async () => {
    for (const [code, words] of [['EBADF', 'EBADF'], ['none', 'no error code']]) {
      const p = fresh();
      stub.failClose(p, code);
      const t = append(p, L(1));
      await flushAll();
      expect(errors).toContain(`[Data] ${p}: the file could not be closed after an append (${words}); this changes nothing about the lines already reported for it`);
      expect(fileTicketState(t)).toBe('landed');
    }
    expect(errors.some(e => e.includes('(EIO)'))).toBe(false);
  });

  it.skipIf(!POSIX)('a directory close error names its code, or says it has none', async () => {
    for (const [code, words] of [['EBADF', 'EBADF'], ['none', 'no error code']]) {
      const p = fresh();
      stub.failDirClose(path.dirname(p), code);
      const t = append(p, L(1));
      await flushAll();
      expect(errors).toContain(`[Data] ${path.dirname(p)}: the directory could not be closed after its sync (${words}); this changes nothing about the lines already reported for the files in it`);
      expect(fileTicketState(t)).toBe('landed');
    }
  });

  it.skipIf(!POSIX)('a directory fsync that rejects closes every directory handle the try opened, over ten tries too', async () => {
    const p = fresh();
    for (let i = 0; i < 10; i++) {
      stub.failDirSync(path.dirname(path.dirname(p)), 'EIO');
      append(p, L(i));
      await flushAll();
    }
    expect(stub.dirCloses.length).toBe(stub.dirOpens.length);
    stub.failDirClose(path.dirname(p), 'EBADF');
    const opens = stub.dirOpens.length;
    const t = append(p, L(99));
    await flushAll();
    expect(stub.dirOpens.length).toBe(opens);
    expect(errors.some(e => e.includes('EBADF'))).toBe(false);
    expect(fileTicketState(t)).toBe('unconfirmed');
  });
});

describe('4.6: the directory chain', () => {
  const chainOf = (p: string) => {
    const dirs: string[] = [];
    for (let d = path.dirname(p); ; d = path.dirname(d)) {
      dirs.push(d);
      if (path.resolve(d) === path.resolve(DATA_ROOT)) break;
    }
    return dirs;
  };
  const synced = () => [...stub.dirSyncs];
  const fwd = (p: string) => path.resolve(p).replace(/\\/g, '/').replace(/[.*+?^${}()|[\]]/g, '\\$&');
  const folderBirth = () => stub.statAs(new RegExp(`^${fwd(DATA_ROOT)}(?!.*\\.jsonl(\\.tmp)?$)`), real => ({ birthtimeNs: real.birthtimeNs > 0n ? real.birthtimeNs : 7n }), 1_000_000);

  it.skipIf(POSIX)('on Windows no directory is opened', async () => {
    const p = fresh();
    const t = append(p, L(1));
    await flushAll();
    expect(fileTicketState(t)).toBe('landed');
    expect(stub.dirOpens).toEqual([]);
  });

  it.skipIf(!POSIX)('the first append to a non-empty file runs the chain up to DATA_ROOT before ok; the second fsyncs the file only', async () => {
    const p = fresh();
    fs.writeFileSync(p, L(0));
    const t = append(p, L(1));
    expect(await confirmFile(t, 1000)).toBe('ok');
    expect(synced()).toEqual(chainOf(p));
    stub.dirSyncs.length = 0;
    append(p, L(2));
    await flushAll();
    expect(synced()).toEqual([]);
  });

  it.skipIf(!POSIX)('EIO on a directory leaves the lines not landed and sets the flag, so the next append opens no folder and is unconfirmed', async () => {
    const p = fresh();
    fs.writeFileSync(p, L(0));
    stub.failDirSync(path.dirname(p), 'EIO');
    const t = append(p, L(1));
    await flushAll();
    expect(fileTicketState(t)).toBe('unconfirmed');
    const opens = stub.dirOpens.length;
    stub.dirSyncs.length = 0;
    const t2 = append(p, L(2));
    await flushAll();
    expect(stub.dirOpens).toHaveLength(opens);
    expect(synced()).toEqual([]);
    expect(fileTicketState(t2)).toBe('unconfirmed');
    expect(fs.readFileSync(p, 'utf8')).toBe(L(0) + L(1) + L(2));
  });

  it.skipIf(!POSIX)('EINVAL on a directory is skipped and the chain lands', async () => {
    resetFolderSyncFailureForTests();
    const p = fresh();
    fs.writeFileSync(p, L(0));
    stub.failDirSync(path.dirname(p), 'EINVAL');
    const t2 = append(p, L(2));
    await flushAll();
    expect(synced()).toEqual(chainOf(p));
    expect(fileTicketState(t2)).toBe('landed');
  });

  const again = async (p: string, between: () => Promise<void> | void, chain = chainOf(p)) => {
    append(p, L(1));
    await flushAll();
    await between();
    stub.dirSyncs.length = 0;
    const t = append(p, L(2));
    await flushAll();
    expect(synced(), 'the chain runs again').toEqual(chain);
    expect(fileTicketState(t)).toBe('landed');
  };

  it.skipIf(!POSIX)('runs again after a delete of the stream', async () => {
    folderBirth();
    const p = fresh();
    await again(p, async () => { enqueueDelete(p); await flushAll(); }, [path.dirname(p)]);
  });

  it.skipIf(!POSIX)('runs again after a retire of the JSON guild re-creates its folder', async () => {
    const guild = `9${Date.now() % 1_000_000}${++n}`;
    const p = dataPath(guild, 'm', 's.jsonl');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    await again(p, async () => { expect(await graveyardGuildDir(guild, 'test')).toBe(true); });
  });

  it.skipIf(!POSIX)('runs again after another holder replaced the file between two takes of the writer lock', async () => {
    const p = fresh();
    await again(p, () => { fs.rmSync(p); fs.writeFileSync(p, L(0)); forgetDurableFiles(); });
  });

  it.skipIf(!POSIX)('runs again after a temp file was renamed over the path', async () => {
    folderBirth();
    const p = fresh();
    await again(p, () => { fs.writeFileSync(`${p}.tmp`, L(0)); fs.renameSync(`${p}.tmp`, p); }, [path.dirname(p)]);
  });

  it.skipIf(!POSIX)('identity cases: a lock take, a reused inode number, a size of 0, a birth time of 0, a failed first try', async () => {
    folderBirth();
    const p = fresh();
    append(p, L(1));
    await flushAll();
    const real = fs.statSync(p, { bigint: true });
    const run = async (arrange: () => void, chain: boolean) => {
      arrange();
      stub.dirSyncs.length = 0;
      append(p, L(++n));
      await flushAll();
      expect(synced().length > 0).toBe(chain);
    };
    await run(() => stub.statAs(p, () => ({ dev: real.dev, ino: real.ino, birthtimeNs: real.birthtimeNs })), false);
    await run(() => { forgetDurableFiles(); stub.statAs(p, () => ({ dev: real.dev, ino: real.ino, birthtimeNs: real.birthtimeNs })); }, true);
    await run(() => stub.statAs(p, s => ({ birthtimeNs: s.birthtimeNs + 1n })), true);
    await run(() => stub.statAs(p, () => ({ size: 0n })), true);
    await run(() => stub.statAs(p, () => ({ birthtimeNs: 0n }), 2), true);
    await run(() => stub.statAs(p, () => ({ birthtimeNs: 0n })), true);
    const q = fresh();
    stub.failWrite(q, 'EIO', 3);
    append(q, L(1));
    await flushAll();
    stub.dirSyncs.length = 0;
    await flushAll();
    expect(synced()).toEqual([path.dirname(q)]);
  });
});

describe('4.8 and 4.9: two writers, and the reader', () => {
  it('4.8 two child processes appending 200 lines each store every line once', async () => {
    const p = fresh();
    const worker = path.join(__dirname, '..', 'helpers', 'appendWorker.cjs');
    const bundle = path.join(dir, 'fileBackend.cjs');
    const { build } = await import('rolldown');
    await build({
      input: path.join(__dirname, '..', '..', 'src', 'bot', 'internalSetup', 'utils', 'dataBackends', 'fileBackend.ts'),
      platform: 'node',
      logLevel: 'silent',
      output: { file: bundle, format: 'cjs' },
    });
    const run = (tag: string) => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [worker, bundle, p, tag, '200'], { stdio: 'inherit', env: { ...process.env, DATA_DIR: DATA_ROOT } });
      child.on('error', reject);
      child.on('exit', code => resolve(code ?? 1));
    });
    expect(await Promise.all([run('A'), run('B')])).toEqual([0, 0]);
    const text = read(p);
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(400);
    expect(new Set(lines).size).toBe(400);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  }, 60_000);

  it('4.9 readAuditEntries returns the whole lines only, over a blank line and a torn line closed by the guard', async () => {
    const audit = dataPath('global', 'premium-tiers.audit.jsonl');
    fs.mkdirSync(path.dirname(audit), { recursive: true });
    const entry = (i: number) => JSON.stringify({ timestamp: `2026-11-05T00:00:0${i}.000Z`, action: 'nb13.read', i });
    fs.writeFileSync(audit, `${entry(1)}\n\n{"torn":`);
    append(audit, `${entry(2)}\n`);
    await flushAll();
    expect(read(audit)).toBe(`${entry(1)}\n\n{"torn":\n${entry(2)}\n`);
    const { getPremiumManager } = await import('../../src/bot/internalSetup/utils/premiumManager');
    expect((await getPremiumManager().readAuditEntries({ action: 'nb13.read' })).entries.map(e => (e as unknown as { i: number }).i).sort()).toEqual([1, 2]);
  });
});

describe('4.10 to 4.15: a failed fsync and the ticket states', () => {
  it('4.10 the lines stay, are not written again and answer unavailable for good; a tail lands; the scope judges by stamp', async () => {
    setBackendKind('file');
    const opts = { scope: 'global' as const, category: `nb13fa${++n}` };
    const name = 's.jsonl';
    const p = dataPath('global', opts.category, name);
    const t1 = ticketOf(appendDataTracked(name, opts, 'T1\n'));
    await flushAll();
    expect(fileTicketState(t1)).toBe('landed');
    const before = saveMark();
    const hold = stub.holdSync(p, 'EIO');
    const l1 = ticketOf(appendDataTracked(name, opts, 'L1\n'));
    await hold.reached;
    const between = saveMark();
    const l2 = ticketOf(appendDataTracked(name, opts, 'L2\n'));
    expect(await confirmSaved('global', { since: before, deadlineMs: 0, category: opts.category })).not.toBe('ok');
    hold.release();
    await flushAll();
    expect(read(p)).toBe('T1\nL1\nL2\n');
    expect(await confirmFile(l1, 1000)).toBe('unavailable');
    expect(await confirmFile(l2, 1000)).toBe('ok');
    expect(await confirmFile(t1, 1000)).toBe('ok');
    expect(errors).toContain(`[Data] ${p}: the disk did not confirm the sync of 1 appended line(s) (EIO); they are in the file and are not written again; can't confirm they are stored`);
    appendData(name, opts, 'L3\n');
    await flushAll();
    expect(await confirmFile(l1, 1000)).toBe('unavailable');
    expect(fileTicketState(l1)).toBe('unconfirmed');
    expect(fileTicketState(l2)).toBe('landed');
    expect(fileTicketState(t1)).toBe('landed');
    expect(await confirmSaved('global', { since: before, deadlineMs: 1000, category: opts.category })).toBe('unavailable');
    expect(await confirmSaved('global', { since: between, deadlineMs: 1000, category: opts.category })).toBe('ok');
    expect(read(p)).toBe('T1\nL1\nL2\nL3\n');
  });

  it('4.11 a short write ending one byte before line 2\'s newline: line 2 leaves the entry, the guard closes it', async () => {
    const p = fresh();
    stub.shortWrite(p, text => text.indexOf('line2') + 'line2'.length);
    append(p, 'line1\nline2\nline3\n');
    await flushAll();
    await flushAll();
    expect(read(p)).toBe('line1\nline2\nline3\n');
    const q = fresh();
    stub.shortWrite(q, text => text.length - 1);
    const t = append(q, 'line1\nline2\n');
    await tried(q);
    expect(read(q)).toBe('line1\nline2');
    expect(fileTicketState(t)).toBe('written');
    await flushAll();
    expect(read(q)).toBe('line1\nline2\n');
    expect(fileTicketState(t)).toBe('landed');
  });

  it.skipIf(!POSIX)('4.12 a delete and an append merged into one whole write: a failed chain is unconfirmed, a good one lands', async () => {
    setBackendKind('file');
    const opts = { scope: 'global' as const, category: `nb13fa${++n}` };
    const p = dataPath('global', opts.category, 'x.jsonl');
    appendData('x.jsonl', opts, 'old');
    await flushAll();
    stub.dirSyncs.length = 0;
    const mark = saveMark();
    stub.failDirSync(path.dirname(p), 'EIO');
    deleteData('x.jsonl', opts);
    appendData('x.jsonl', opts, 'L');
    const t = fileTicket(p);
    await flushAll();
    expect(fileTicketState(t)).toBe('unconfirmed');
    expect(await confirmSaved('global', { since: mark, deadlineMs: 1000, category: opts.category })).toBe('unavailable');
    expect(unconfirmedFiles()).toBeGreaterThan(0);
    expect(stub.dirSyncs.filter(d => d === path.dirname(p))).toHaveLength(1);
    const count = unconfirmedFiles();
    stub.dirSyncs.length = 0;
    deleteData('x.jsonl', opts);
    appendData('x.jsonl', opts, 'M');
    const t2 = fileTicket(p);
    await flushAll();
    expect(fileTicketState(t2)).toBe('unconfirmed');
    expect(stub.dirSyncs).toEqual([]);
    expect(unconfirmedFiles()).toBe(count);
  });

  it.skipIf(!POSIX)('4.16 a whole write replaced during its failed chain adds no failed range and logs no line; the newer write answers for its lines', async () => {
    setBackendKind('file');
    const opts = { scope: 'global' as const, category: `nb13fa${++n}` };
    const p = dataPath('global', opts.category, 'x.jsonl');
    appendData('x.jsonl', opts, 'old');
    await flushAll();
    const before = unconfirmedFiles();
    const hold = stub.holdDirSync(path.dirname(p), 'EIO');
    deleteData('x.jsonl', opts);
    appendData('x.jsonl', opts, 'L1');
    const t1 = fileTicket(p);
    await hold.reached;
    appendData('x.jsonl', opts, 'L2');
    const t2 = fileTicket(p);
    hold.release();
    await flushAll();
    expect(read(p)).toBe('L1\nL2\n');
    expect(fileTicketState(t1)).toBe('unconfirmed');
    expect(fileTicketState(t2)).toBe('unconfirmed');
    expect(await confirmFile(t1, 1000)).toBe('unavailable');
    const { why, next } = syncWords('earlier', path.dirname(p), 'EIO');
    expect(errors.filter(e => e.startsWith(`[Data] ${p}:`))).toEqual([`[Data] ${p}: the file is written whole, but ${why}; it is not written again; can't confirm it is stored. ${next}`]);
    expect(unconfirmedFiles()).toBe(before + 1);
  });

  it.skipIf(!POSIX)('4.17 a deposition cancels the newer write before it lands: the replaced write\'s line is in the file, unconfirmed', async () => {
    const r = await replacedTry();
    const cancelled = cancelQueued([r.p], undefined, { freeze: true });
    r.hold.release();
    expect(await cancelled).toMatchObject([{ path: r.p, outcome: 'unconfirmed', errno: 'EIO', cut: false }]);
    expect(read(r.p)).toBe('L1\n');
    expect(fileTicketState(r.t1)).toBe('unconfirmed');
    expect(fileTicketFailure(r.t1)).toMatchObject({ errno: 'EIO', cut: false });
    expect(fileTicketState(r.t2)).toBe('open');
    expect(await confirmFile(r.t1, 0)).toBe('unavailable');
    expect(unconfirmedFiles()).toBe(r.before + 1);
  });

  it.skipIf(!POSIX)('4.18 a cancel with no freeze, the newer write failing: the replaced write\'s line is unconfirmed, never cancelled', async () => {
    const r = await replacedTry();
    const mkdir = failMkdir(path.dirname(r.p));
    const cancelled = cancelQueued([r.p]);
    r.hold.release();
    const results = await cancelled;
    mkdir.mockRestore();
    expect(results).toMatchObject([{ path: r.p, outcome: 'unconfirmed', errno: 'EIO', cut: false }]);
    expect(read(r.p)).toBe('L1\n');
    expect(fileTicketState(r.t1)).toBe('unconfirmed');
    expect(fileTicketState(r.t2)).toBe('open');
    expect(unconfirmedFiles()).toBe(r.before + 1);
  });

  it.skipIf(!POSIX)('4.19 the newer write landing after a failed try of its own answers for the replaced write\'s line', async () => {
    const r = await replacedTry();
    const mkdir = failMkdir(path.dirname(r.p));
    r.hold.release();
    for (let i = 0; i < 200 && mkdir.mock.calls.length === 0; i++) await sleep(5);
    mkdir.mockRestore();
    await flushAll();
    expect(read(r.p)).toBe('L1\nL2\n');
    expect(fileTicketState(r.t1)).toBe('unconfirmed');
    expect(fileTicketState(r.t2)).toBe('unconfirmed');
    expect(errors.filter(e => e.startsWith(`[Data] ${r.p}:`) && e.includes('earlier in this process'))).toHaveLength(1);
    expect(unconfirmedFiles()).toBe(r.before + 1);
  });

  it('4.13 cancelQueued while a try is on the wire', async () => {
    // freeze: no try of the tail starts between the held try's end and the cancel.
    const run = async (arrange: (p: string) => { release?: () => void; reached: Promise<void> }, tail: boolean) => {
      const p = fresh();
      const ctl = arrange(p);
      const t = append(p, L(1) + L(2) + L(3));
      await ctl.reached;
      const tailTicket = tail ? append(p, L(4)) : null;
      const cancelled = cancelQueued([p], undefined, { freeze: true });
      ctl.release?.();
      const [result] = await cancelled;
      return { p, t, tailTicket, result };
    };
    const syncHold = (p: string) => { const h = stub.holdSync(p, 'EIO'); return { release: () => h.release(), reached: h.reached }; };
    const a = await run(syncHold, false);
    expect(a.result).toMatchObject({ path: a.p, outcome: 'unconfirmed', errno: 'EIO', cut: false });
    const b = await run(syncHold, true);
    expect(b.result).toMatchObject({ path: b.p, outcome: 'unconfirmed', errno: 'EIO', cut: false });
    expect(fileTicketState(b.tailTicket!)).toBe('open');
    expect(fileTicketState(b.t)).toBe('unconfirmed');
    const before = unconfirmedFiles();
    const c = fresh();
    stub.shortWrite(c, () => L(1).length + 3);
    const tc = append(c, L(1) + L(2) + L(3));
    await tried(c);
    const [cr] = await cancelQueued([c]);
    expect(cr).toMatchObject({ path: c, outcome: 'unconfirmed', errno: 'short write', cut: true });
    expect(cr).not.toHaveProperty('kind');
    expect(cr).not.toHaveProperty('dir');
    expect(fileTicketState(tc)).toBe('unconfirmed');
    expect(fileTicketFailure(tc)?.kind).toBeUndefined();
    expect(fileTicketFailure(tc)?.dir).toBeUndefined();
    expect(unconfirmedFiles()).toBe(before + 1);
    expect(read(c)).toBe(L(1) + L(2).slice(0, 3));
    const d = fresh();
    stub.failWrite(d, 'ENOSPC', 10);
    append(d, L(1));
    await flushAll();
    expect(await cancelQueued([d])).toEqual([{ path: d, outcome: 'cancelled', errno: 'ENOSPC' }]);
  });

  it("4.14 fileTicketState: open while the open is held, written during the write and after a short one, landed, unconfirmed", async () => {
    const p = fresh();
    const openHold = stub.holdOpen(p);
    const t = append(p, L(1));
    await openHold.reached;
    expect(fileTicketState(t)).toBe('open');
    const writeHold = stub.holdWrite(p);
    openHold.release();
    await writeHold.reached;
    expect(fileTicketState(t)).toBe('written');
    writeHold.release();
    await flushAll();
    expect(fileTicketState(t)).toBe('landed');
    const q = fresh();
    stub.shortWrite(q, () => 2);
    const tq = append(q, L(1));
    await tried(q);
    expect(fileTicketState(tq)).toBe('written');
    await flushAll();
    expect(fileTicketState(tq)).toBe('landed');
    const r = fresh();
    stub.failSync(r, 'EIO');
    const tr = append(r, L(1));
    await flushAll();
    expect(fileTicketState(tr)).toBe('unconfirmed');
  });

  it('4.15 fileTicketFailure names the errno and whether the range was cut', async () => {
    const p = fresh();
    stub.failSync(p, 'EIO');
    const t = append(p, L(1));
    await flushAll();
    expect(fileTicketState(t)).toBe('unconfirmed');
    expect(fileTicketFailure(t)).toMatchObject({ errno: 'EIO', cut: false });
    expect(fileTicketFailure(t)?.kind).toBeUndefined();
    expect(fileTicketFailure(t)?.dir).toBeUndefined();
    const q = fresh();
    stub.shortWrite(q, () => 3);
    const t1 = append(q, L(1));
    const t2 = append(q, L(2));
    await tried(q);
    const cancelled = await cancelQueued([q]);
    expect(cancelled).toMatchObject([{ path: q, outcome: 'unconfirmed', errno: 'short write', cut: true }]);
    expect(cancelled[0]).not.toHaveProperty('kind');
    expect(cancelled[0]).not.toHaveProperty('dir');
    for (const t of [t1, t2]) {
      expect(fileTicketState(t)).toBe('unconfirmed');
      expect(fileTicketFailure(t)).toMatchObject({ errno: 'short write', cut: true });
      expect(fileTicketFailure(t)?.kind).toBeUndefined();
      expect(fileTicketFailure(t)?.dir).toBeUndefined();
    }
  });
});

describe("4.21 to 4.29: cancelQueued answers from the state of the seqs it drops, and a dropped guild logs its replaced tries", () => {
  it.skipIf(!POSIX)('4.21 a whole write whose chain fails during the cancel\'s wait, nothing newer queued: unconfirmed', async () => {
    setBackendKind('file');
    const opts = { scope: 'global' as const, category: `nb13fa${++n}` };
    const p = dataPath('global', opts.category, 'x.jsonl');
    appendData('x.jsonl', opts, 'old');
    await flushAll();
    const hold = stub.holdDirSync(path.dirname(p), 'EIO');
    deleteData('x.jsonl', opts);
    appendData('x.jsonl', opts, 'L1');
    const t1 = fileTicket(p);
    await hold.reached;
    const cancelled = cancelQueued([p], undefined, { freeze: true });
    hold.release();
    expect(await cancelled).toMatchObject([{ path: p, outcome: 'unconfirmed', errno: 'EIO', cut: false }]);
    expect(read(p)).toBe('L1\n');
    expect(fileTicketState(t1)).toBe('unconfirmed');
  });

  it.skipIf(!POSIX)('4.22 after a replaced try, the newer write reaches the file and its own chain fails during the wait: unconfirmed', async () => {
    const r = await replacedTry();
    const d = path.dirname(r.p);
    stub.failDirSync(d, 'EIO');
    // The cancel answers only once the newer write's chain has run and failed.
    const cancelled = cancelQueued([r.p], async ms => {
      while (fileTicketState(r.t2) !== 'unconfirmed') await sleep(5);
      await sleep(ms);
    });
    r.hold.release();
    expect(await cancelled).toMatchObject([{ path: r.p, outcome: 'unconfirmed', errno: 'EIO', cut: false }]);
    expect(read(r.p)).toBe('L1\nL2\n');
    expect(fileTicketState(r.t1)).toBe('unconfirmed');
    expect(fileTicketState(r.t2)).toBe('unconfirmed');
  });

  it.skipIf(!POSIX)('4.23 a whole write queued with no ticket, its chain failing during a deposition\'s wait: unconfirmed', async () => {
    const p = fresh();
    const hold = stub.holdDirSync(path.dirname(p), 'EIO');
    enqueueWrite(p, L(1));
    await hold.reached;
    const cancelled = cancelQueued([p], undefined, { freeze: true });
    hold.release();
    expect(await cancelled).toMatchObject([{ path: p, outcome: 'unconfirmed', errno: 'EIO', cut: false }]);
    expect(read(p)).toBe(L(1));
  });

  it('4.24 a line whose sync failed with a tail queued that no try wrote: unconfirmed with the failed range\'s errno', async () => {
    const p = fresh();
    const hold = stub.holdSync(p, 'EIO');
    const t1 = append(p, L(1));
    await hold.reached;
    const t2 = append(p, L(2));
    stub.failWrite(p, 'ENOSPC', 10);
    hold.release();
    await flushAll();
    expect(await cancelQueued([p])).toMatchObject([{ path: p, outcome: 'unconfirmed', errno: 'EIO', cut: false }]);
    expect(fileTicketState(t1)).toBe('unconfirmed');
    expect(fileTicketState(t2)).toBe('open');
    expect(read(p)).toBe(L(1));
    // Once the failed line's queue emptied, a later append starts a record of its own: dropping it is 'cancelled'.
    const q = fresh();
    stub.failSync(q, 'EIO');
    append(q, L(1));
    await flushAll();
    stub.failWrite(q, 'ENOSPC', 10);
    const tq = append(q, L(2));
    await flushAll();
    expect(await cancelQueued([q])).toEqual([{ path: q, outcome: 'cancelled', errno: 'ENOSPC' }]);
    expect(fileTicketState(tq)).toBe('open');
  });

  it('4.25 a path with nothing queued at the cancel: landed', async () => {
    const p = fresh();
    append(p, L(1));
    await flushAll();
    expect(await cancelQueued([p])).toEqual([{ path: p, outcome: 'landed' }]);
  });

  it('4.26 an append that lands during the cancel\'s wait: landed', async () => {
    const p = fresh();
    const hold = stub.holdWrite(p);
    const t = append(p, L(1));
    await hold.reached;
    const cancelled = cancelQueued([p], undefined, { freeze: true });
    hold.release();
    expect(await cancelled).toEqual([{ path: p, outcome: 'landed' }]);
    expect(fileTicketState(t)).toBe('landed');
    expect(read(p)).toBe(L(1));
  });

  it('4.27 an entry an earlier cancel dropped during the wait, no byte written: cancelled with no errno', async () => {
    const p = fresh();
    const hold = stub.holdOpen(p);
    stub.failWrite(p, 'ENOSPC', 10);
    const t = append(p, L(1));
    await hold.reached;
    const first = cancelQueued([p]);
    const second = cancelQueued([p], async () => { await sleep(60); });
    hold.release();
    expect(await first).toEqual([{ path: p, outcome: 'cancelled', errno: 'ENOSPC' }]);
    expect(await second).toEqual([{ path: p, outcome: 'cancelled', errno: null }]);
    expect(fileTicketState(t)).toBe('open');
  });

  it('4.28 an append still queued whose tries wrote no byte: cancelled with the last errno', async () => {
    const p = fresh();
    stub.failWrite(p, 'ENOSPC', 10);
    const t = append(p, L(1));
    await flushAll();
    expect(await cancelQueued([p], undefined, { freeze: true })).toEqual([{ path: p, outcome: 'cancelled', errno: 'ENOSPC' }]);
    expect(fileTicketState(t)).toBe('open');
  });

  it.skipIf(!POSIX)('4.29 dropping a guild\'s queued writes logs a replaced try\'s line while the path still holds the file', async () => {
    const guild = `nb13g${Date.now()}${++n}`;
    const g = path.join(DATA_ROOT, guild);
    const p = path.join(g, 'x.jsonl');
    const hold = stub.holdDirSync(g, 'EIO');
    enqueueDelete(p);
    enqueueAppend(p, 'L1\n');
    const t1 = fileTicket(p);
    await hold.reached;
    enqueueAppend(p, 'L2\n');
    const t2 = fileTicket(p);
    const mkdir = failMkdir(g);
    hold.release();
    for (let i = 0; i < 200 && mkdir.mock.calls.length === 0; i++) await sleep(5);
    await sleep(10);
    const line = (e: string) => e === `[Data] ${p}: the file is written whole, but ${syncWords('sync', g, 'EIO').why}; it is not written again; can't confirm it is stored. ${syncWords('sync', g, 'EIO').next}`;
    expect(errors.filter(line)).toHaveLength(0);
    dropPendingForGuild(guild);
    mkdir.mockRestore();
    expect(errors.filter(line)).toHaveLength(1);
    expect(fileTicketState(t1)).toBe('unconfirmed');
    expect(fileTicketState(t2)).toBe('open');
    expect(read(p)).toBe('L1\n');
  });
});

/** A cancel's sleep that runs step on its first call, while the try it waits on is still on the wire. */
const once = (step: () => Promise<void>) => {
  let done = false;
  return async (ms: number) => {
    if (!done) {
      done = true;
      await step();
    }
    await sleep(ms);
  };
};
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await sleep(5);
};

describe('4.30 to 4.38: a cancel reads every record its path had from its start to the end of its wait', () => {
  it('4.30 the target lands, its record retires and a new append short-writes during the wait: unconfirmed, cut', async () => {
    const p = fresh();
    const hold = stub.holdWrite(p);
    const t1 = append(p, L(1));
    await hold.reached;
    const later: { t2?: FileTicket } = {};
    const cancelled = cancelQueued([p], once(async () => {
      hold.release();
      await until(() => fileTicketState(t1) === 'landed');
      stub.shortWrite(p, () => L(2).length + 3);
      later.t2 = append(p, L(2) + L(3));
      await tried(p, 2);
    }));
    expect(await cancelled).toMatchObject([{ path: p, outcome: 'unconfirmed', errno: 'short write', cut: true }]);
    expect(fileTicketState(t1)).toBe('landed');
    expect(fileTicketState(later.t2!)).toBe('unconfirmed');
    expect(read(p)).toBe(L(1) + L(2) + L(3).slice(0, 3));
  });

  it('4.31 the record turns over twice during the wait: the middle one\'s failed sync answers, the last one\'s dropped line wrote nothing', async () => {
    const p = fresh();
    const hold = stub.holdWrite(p);
    const t1 = append(p, L(1));
    await hold.reached;
    const cancelled = cancelQueued([p], once(async () => {
      hold.release();
      await until(() => fileTicketState(t1) === 'landed');
      stub.failSync(p, 'EIO');
      enqueueAppend(p, L(2));
      await until(() => !queuedFilePaths().includes(p));
      stub.failWrite(p, 'ENOSPC', 10);
      enqueueAppend(p, L(3));
      await tried(p, 3);
    }));
    expect(await cancelled).toMatchObject([{ path: p, outcome: 'unconfirmed', errno: 'EIO', cut: false }]);
    expect(read(p)).toBe(L(1) + L(2));
  });

  it.skipIf(!POSIX)('4.32 a whole write queued with no ticket after the record retired, its chain failing during the wait: unconfirmed', async () => {
    const p = fresh();
    const hold = stub.holdWrite(p);
    const t1 = append(p, L(1));
    await hold.reached;
    const cancelled = cancelQueued([p], once(async () => {
      hold.release();
      await until(() => fileTicketState(t1) === 'landed');
      stub.failDirSync(path.dirname(p), 'EIO');
      enqueueWrite(p, L(1) + L(2));
      await until(() => !queuedFilePaths().includes(p));
      stub.failWrite(p, 'ENOSPC', 10);
      enqueueAppend(p, L(3));
      await tried(p, 2);
    }));
    expect(await cancelled).toMatchObject([{ path: p, outcome: 'unconfirmed', errno: 'EIO', cut: false }]);
    expect(read(p)).toBe(L(1) + L(2));
  });

  it.skipIf(!POSIX)('4.33 a whole write with no ticket replaced during its failed chain, the newer write failing: unconfirmed', async () => {
    const p = fresh();
    const hold = stub.holdDirSync(path.dirname(p), 'EIO');
    enqueueWrite(p, L(1));
    await hold.reached;
    enqueueAppend(p, L(2));
    const mkdir = failMkdir(path.dirname(p));
    hold.release();
    await until(() => mkdir.mock.calls.length > 0);
    await sleep(10);
    const results = await cancelQueued([p]);
    mkdir.mockRestore();
    expect(results).toMatchObject([{ path: p, outcome: 'unconfirmed', errno: 'EIO', cut: false }]);
    expect(read(p)).toBe(L(1));
  });

  it('4.34 a try on the wire whose record a guild drop retired before the cancel: its failed sync answers', async () => {
    const guild = `nb13g${Date.now()}${++n}`;
    const p = path.join(DATA_ROOT, guild, 'x.jsonl');
    const hold = stub.holdSync(p, 'EIO');
    append(p, L(1));
    await hold.reached;
    dropPendingForGuild(guild);
    stub.failWrite(p, 'ENOSPC', 10);
    const t2 = append(p, L(2));
    const cancelled = cancelQueued([p]);
    hold.release();
    expect(await cancelled).toMatchObject([{ path: p, outcome: 'unconfirmed', errno: 'EIO', cut: false }]);
    expect(read(p)).toBe(L(1));
    expect(fileTicketState(t2)).toBe('open');
  });

  it('4.35 a failed sync, then a later line of the same queue lands: the dropped tail answers unconfirmed, not cancelled', async () => {
    const p = fresh();
    const syncHold = stub.holdSync(p, 'EIO');
    const t1 = append(p, L(1));
    await syncHold.reached;
    const writeHold = stub.holdWrite(p);
    const t2 = append(p, L(2));
    syncHold.release();
    await writeHold.reached;
    const t3 = append(p, L(3));
    stub.failWrite(p, 'ENOSPC', 10);
    writeHold.release();
    await tried(p, 3);
    expect(fileTicketState(t1)).toBe('unconfirmed');
    expect(fileTicketState(t2)).toBe('landed');
    expect(await cancelQueued([p])).toMatchObject([{ path: p, outcome: 'unconfirmed', errno: 'EIO', cut: false }]);
    expect(fileTicketState(t3)).toBe('open');
    expect(read(p)).toBe(L(1) + L(2));
  });

  it('4.36 a delete that lands after a failed sync leaves no line of it in the file: landed', async () => {
    const p = fresh();
    const hold = stub.holdSync(p, 'EIO');
    const t1 = append(p, L(1));
    await hold.reached;
    enqueueDelete(p);
    const cancelled = cancelQueued([p], async ms => {
      await until(() => !queuedFilePaths().includes(p));
      await sleep(ms);
    });
    hold.release();
    expect(await cancelled).toEqual([{ path: p, outcome: 'landed' }]);
    expect(fs.existsSync(p)).toBe(false);
    expect(fileTicketState(t1)).toBe('unconfirmed');
  });

  it('4.37 the target lands and a later line\'s sync fails during the wait, nothing dropped: landed', async () => {
    const p = fresh();
    const hold = stub.holdWrite(p);
    const t1 = append(p, L(1));
    await hold.reached;
    const cancelled = cancelQueued([p], once(async () => {
      hold.release();
      await until(() => fileTicketState(t1) === 'landed');
      stub.failSync(p, 'EIO');
      enqueueAppend(p, L(2));
      await until(() => !queuedFilePaths().includes(p));
    }));
    expect(await cancelled).toEqual([{ path: p, outcome: 'landed' }]);
    expect(read(p)).toBe(L(1) + L(2));
  });

  it('4.38 a guild drop during the wait retires a record whose try was cut: unconfirmed, cut', async () => {
    const guild = `nb13g${Date.now()}${++n}`;
    const p = path.join(DATA_ROOT, guild, 'x.jsonl');
    const openHold = stub.holdOpen(p);
    stub.shortWrite(p, () => 3);
    const t = append(p, L(1));
    await openHold.reached;
    const cancelled = cancelQueued([p], once(async () => {
      openHold.release();
      await tried(p);
      dropPendingForGuild(guild);
    }));
    expect(await cancelled).toMatchObject([{ path: p, outcome: 'unconfirmed', errno: 'short write', cut: true }]);
    expect(fileTicketState(t)).toBe('unconfirmed');
    expect(read(p)).toBe(L(1).slice(0, 3));
  });
});

describe('the exit with a replaced write whose newer write never landed', () => {
  // Last in the file: the exit drain closes this module's writes for good.
  it.skipIf(!POSIX)('4.20 the exit drain names the replaced write\'s line unconfirmed', async () => {
    const r = await replacedTry();
    const mkdir = failMkdir(path.dirname(r.p));
    r.hold.release();
    for (let i = 0; i < 200 && mkdir.mock.calls.length === 0; i++) await sleep(5);
    expect(fileTicketState(r.t1)).toBe('open');
    await drainForExit(5000);
    mkdir.mockRestore();
    expect(read(r.p)).toBe('L1\n');
    expect(fileTicketState(r.t1)).toBe('unconfirmed');
    expect(fileTicketFailure(r.t1)).toEqual({ errno: 'EIO', cut: false, what: 'whole', kind: 'sync', dir: path.dirname(r.p) });
    expect(fileTicketState(r.t2)).toBe('open');
    expect(errors.some(e => e.startsWith(`[Data] ${r.p}: the file is written whole, but the disk did not confirm the sync of ${path.dirname(r.p)} (EIO)`))).toBe(true);
    expect(errors.some(e => e.includes('appended line(s)'))).toBe(false);
  });
});
