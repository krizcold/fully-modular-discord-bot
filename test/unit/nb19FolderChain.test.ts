import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelQueued,
  confirmFile,
  enqueueAppend,
  enqueueWrite,
  failReplacedTriesAtExit,
  fileTicket,
  fileTicketFailure,
  fileTicketState,
  flushAll,
  forgetDurableFiles,
  fsyncDataDirs,
  queuedFilePaths,
  unconfirmedFiles,
  type FileTicket,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import {
  folderSyncFailed,
  forgetDurableFolders,
  resetFolderSyncFailureForTests,
  syncFolderChain,
  syncFolderChainSync,
  syncFoldersUnder,
  syncWords,
  FolderSyncError,
} from '../../src/bot/internalSetup/utils/folderChain';
import { atomicWriteFileSync } from '../../src/bot/internalSetup/utils/atomicWrite';
import { heldClauses } from '../../src/bot/internalSetup/utils/heldWords';
import { confirmSaved, saveData, saveMark } from '../../src/bot/internalSetup/utils/dataManager';
import { unconfirmedWords } from '../../src/bot/internalSetup/utils/writerLock';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import { stubAppendHandles, type AppendStub } from '../helpers/fileHandleStub';

// NB19 decisions 1 and 2: every queued whole write runs the folder chain up to DATA_ROOT, with a skip of folders whose
// entry this process synced, and a folder sync error sets a flag for the process's life.

const POSIX = process.platform !== 'win32';
const ROOT = path.resolve(DATA_ROOT);
let n = 0;
let stub: AppendStub;
let errors: string[];

const guild = () => `9${Date.now() % 1_000_000}${++n}`;
const fwd = (p: string) => p.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]]/g, '\\$&');
/** Every folder under DATA_ROOT reports a birth time above 0, so the skip can hold on any file system. */
const withBirth = () => stub.statAs(new RegExp(`^${fwd(ROOT)}`), real => ({ birthtimeNs: real.birthtimeNs > 0n ? real.birthtimeNs : 7n }), 1_000_000);
const synced = () => [...stub.dirSyncs];
const since = (mark: number) => stub.dirSyncs.slice(mark);
const T2 = (p: string, kind: 'sync' | 'open' | 'earlier', dir: string, errno: string) => {
  const { why, next } = syncWords(kind, dir, errno);
  return `[Data] ${p}: the file is written whole, but ${why}; it is not written again; can't confirm it is stored. ${next}`;
};

async function save(p: string, text = '{"v":1}'): Promise<{ t: FileTicket; answer: string }> {
  enqueueWrite(p, text);
  const t = fileTicket(p);
  const answer = await confirmFile(t, 3000);
  return { t, answer };
}

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  stub = stubAppendHandles();
});
afterEach(async () => {
  stub.restore();
  await flushAll();
  vi.restoreAllMocks();
});

describe('row 24 and the texts that need no folder', () => {
  it.skipIf(POSIX)('24: on Windows no helper opens a folder and every save lands', async () => {
    const g = guild();
    const { answer } = await save(dataPath(g, 'm', 'a.json'));
    expect(answer).toBe('ok');
    atomicWriteFileSync(dataPath(g, 'n', 'b.json'), '{}');
    expect((await syncFolderChain(dataPath(g))).failed).toBe(false);
    expect(syncFolderChainSync(dataPath(g)).failed).toBe(false);
    expect((await syncFoldersUnder(dataPath(g))).failed).toBe(false);
    expect(stub.dirOpens).toEqual([]);
  });

  it('14: heldClauses words the unconfirmed files as changes, lines or whole files', () => {
    expect(heldClauses({ unconfirmedFiles: 1 })).toBe("1 file(s) hold changes the disk did not confirm; can't confirm whether they are stored");
  });

  it('the sync clause and the advice follow the kind', () => {
    expect(syncWords('sync', '/data', 'EIO')).toEqual({ why: 'the disk did not confirm the sync of /data (EIO)', next: 'Check the disk, then restart the machine.' });
    expect(syncWords('earlier', '/data/x', 'EIO').why).toBe('no folder sync is trusted since the disk did not confirm the sync of /data/x (EIO) earlier in this process');
    expect(syncWords('open', '/data/G', 'EMFILE')).toEqual({
      why: '/data/G could not be opened for its sync (EMFILE)',
      next: 'The next save of this file syncs its folder again; check the current state before you repeat the action.',
    });
  });
});

describe.skipIf(!POSIX)('rows 1 to 11: the chain and its skip', () => {
  it('1: the first save of a new guild file syncs /data/G/m, /data/G and /data before it answers ok', async () => {
    expect(DATA_ROOT).toBe(process.env.DATA_DIR);
    withBirth();
    const g = guild();
    const p = dataPath(g, 'm', 'a.json');
    const { answer } = await save(p);
    expect(answer).toBe('ok');
    expect(synced()).toEqual([dataPath(g, 'm'), dataPath(g), ROOT]);
  });

  it('2: the next save in the same folder syncs /data/G/m only', async () => {
    withBirth();
    const g = guild();
    await save(dataPath(g, 'm', 'a.json'));
    const mark = stub.dirSyncs.length;
    expect((await save(dataPath(g, 'm', 'b.json'))).answer).toBe('ok');
    expect(since(mark)).toEqual([dataPath(g, 'm')]);
  });

  it('3: a save in a new sibling folder syncs /data/G/n and /data/G', async () => {
    withBirth();
    const g = guild();
    await save(dataPath(g, 'm', 'a.json'));
    const mark = stub.dirSyncs.length;
    expect((await save(dataPath(g, 'n', 'b.json'))).answer).toBe('ok');
    expect(since(mark)).toEqual([dataPath(g, 'n'), dataPath(g)]);
  });

  for (const [row, at] of [['4', 'the data root'], ['5', "the file's own folder"]] as const) {
    it(`${row}: EIO on ${at} at a first save: unconfirmed, T2 once, counted, not written again`, async () => {
      const g = guild();
      const p = dataPath(g, 'm', 'a.json');
      const dir = row === '4' ? ROOT : dataPath(g, 'm');
      const before = unconfirmedFiles();
      stub.failDirSync(dir, 'EIO');
      const { t, answer } = await save(p, '{"v":2}');
      expect(answer).toBe('unavailable');
      expect(fileTicketState(t)).toBe('unconfirmed');
      expect(fileTicketFailure(t)).toMatchObject({ errno: 'EIO', what: 'whole', kind: 'sync', dir });
      expect(errors.filter(e => e === T2(p, 'sync', dir, 'EIO'))).toHaveLength(1);
      expect(unconfirmedFiles()).toBe(before + 1);
      expect(queuedFilePaths()).not.toContain(p);
      expect(fs.readFileSync(p, 'utf8')).toBe('{"v":2}');
      expect(folderSyncFailed()).toBe(true);
    });
  }

  for (const [row, at] of [['4', 'the data root'], ['5', "the file's own folder"]] as const) {
    it(`${row}: a module save with EIO on ${at}: confirmSaved answers unavailable, T2 once, not written again`, async () => {
      const g = guild();
      const p = dataPath(g, 'm', 'a.json');
      const dir = row === '4' ? ROOT : dataPath(g, 'm');
      const before = unconfirmedFiles();
      stub.failDirSync(dir, 'EIO');
      const mark = saveMark();
      expect(saveData('a.json', { guildId: g, category: 'm' }, { v: 2 })).toBe(true);
      const t = fileTicket(p);
      expect(await confirmSaved(g, { since: mark, deadlineMs: 3000 })).toBe('unavailable');
      expect(await confirmSaved(g, { since: mark, deadlineMs: 0 })).toBe('unavailable');
      expect(fileTicketFailure(t)).toMatchObject({ errno: 'EIO', what: 'whole', kind: 'sync', dir });
      expect(errors.filter(e => e === T2(p, 'sync', dir, 'EIO'))).toHaveLength(1);
      expect(unconfirmedFiles()).toBe(before + 1);
      expect(queuedFilePaths()).not.toContain(p);
      expect(fs.readFileSync(p, 'utf8')).toBe(JSON.stringify({ v: 2 }, null, 2));
    });
  }

  it('6: after row 4, a second module save answers unavailable in confirmSaved with the earlier clause', async () => {
    const g = guild();
    const p = dataPath(g, 'm', 'a.json');
    stub.failDirSync(ROOT, 'EIO');
    const first = saveMark();
    expect(saveData('a.json', { guildId: g, category: 'm' }, { v: 1 })).toBe(true);
    expect(await confirmSaved(g, { since: first, deadlineMs: 3000 })).toBe('unavailable');
    const opens = stub.dirOpens.length;
    const second = saveMark();
    expect(saveData('a.json', { guildId: g, category: 'm' }, { v: 3 })).toBe(true);
    const t = fileTicket(p);
    expect(await confirmSaved(g, { since: second, deadlineMs: 3000 })).toBe('unavailable');
    expect(stub.dirOpens.length).toBe(opens);
    expect(fileTicketFailure(t)).toMatchObject({ kind: 'earlier', dir: ROOT, errno: 'EIO' });
    expect(errors).toContain(T2(p, 'earlier', ROOT, 'EIO'));
    expect(fs.readFileSync(p, 'utf8')).toBe(JSON.stringify({ v: 3 }, null, 2));
  });

  it('6: after row 4, a new write of the same path opens no folder and is unconfirmed with the earlier clause', async () => {
    const g = guild();
    const p = dataPath(g, 'm', 'a.json');
    const before = unconfirmedFiles();
    stub.failDirSync(ROOT, 'EIO');
    await save(p);
    const opens = stub.dirOpens.length;
    const { t, answer } = await save(p, '{"v":3}');
    expect(answer).toBe('unavailable');
    expect(stub.dirOpens.length).toBe(opens);
    expect(fileTicketFailure(t)).toMatchObject({ kind: 'earlier', dir: ROOT, errno: 'EIO' });
    expect(errors).toContain(T2(p, 'earlier', ROOT, 'EIO'));
    expect(unconfirmedFiles()).toBe(before + 1);
  });

  it('7: EINVAL on a folder counts as synced and sets no flag', async () => {
    withBirth();
    const g = guild();
    stub.failDirSync(dataPath(g), 'EINVAL');
    expect((await save(dataPath(g, 'm', 'a.json'))).answer).toBe('ok');
    expect(folderSyncFailed()).toBe(false);
    expect(synced()).toEqual([dataPath(g, 'm'), dataPath(g), ROOT]);
    const mark = stub.dirSyncs.length;
    expect((await save(dataPath(g, 'n', 'b.json'))).answer).toBe('ok');
    // Case 3: the walk stops at /data/G, so the folder that answered EINVAL was recorded as synced.
    expect(since(mark)).toEqual([dataPath(g, 'n'), dataPath(g)]);
  });

  it('8: a folder emptied by a delete and made again is not matched by its old record', async () => {
    const g = guild();
    // Each creation of /data/G/m has its own birth, as on a disk that reports one, though the inode may be reused.
    const born = (fake: bigint) => (real: fs.BigIntStats) => ({ birthtimeNs: real.birthtimeNs > 0n ? real.birthtimeNs : fake });
    stub.statAs(dataPath(g, 'm'), born(21n), 1);
    stub.statAs(dataPath(g), born(13n), 1_000);
    await save(dataPath(g, 'm', 'a.json'));
    fs.rmSync(dataPath(g, 'm'), { recursive: true });
    stub.statAs(dataPath(g, 'm'), born(22n), 1_000);
    const mark = stub.dirSyncs.length;
    expect((await save(dataPath(g, 'm', 'b.json'))).answer).toBe('ok');
    expect(since(mark)).toEqual([dataPath(g, 'm'), dataPath(g)]);
  });

  it('8: a changed birth time of /data/G/m alone makes the walk go on to /data/G', async () => {
    const g = guild();
    stub.statAs(dataPath(g, 'm'), () => ({ birthtimeNs: 11n }), 1);
    stub.statAs(dataPath(g), () => ({ birthtimeNs: 13n }), 1_000);
    await save(dataPath(g, 'm', 'a.json'));
    stub.statAs(dataPath(g, 'm'), () => ({ birthtimeNs: 12n }), 1_000);
    const mark = stub.dirSyncs.length;
    await save(dataPath(g, 'm', 'b.json'));
    expect(since(mark)).toEqual([dataPath(g, 'm'), dataPath(g)]);
  });

  it('9: a birth time of 0 gives the full chain every time', async () => {
    stub.statAs(new RegExp(`^${fwd(ROOT)}`), () => ({ birthtimeNs: 0n }), 1_000_000);
    const g = guild();
    await save(dataPath(g, 'm', 'a.json'));
    const mark = stub.dirSyncs.length;
    await save(dataPath(g, 'm', 'b.json'));
    expect(since(mark)).toEqual([dataPath(g, 'm'), dataPath(g), ROOT]);
  });

  it('10: forgetDurableFiles clears the folder records, so the next save runs the full chain', async () => {
    withBirth();
    const g = guild();
    await save(dataPath(g, 'm', 'a.json'));
    forgetDurableFiles();
    const mark = stub.dirSyncs.length;
    await save(dataPath(g, 'm', 'b.json'));
    expect(since(mark)).toEqual([dataPath(g, 'm'), dataPath(g), ROOT]);
  });
});

describe.skipIf(!POSIX)('rows 28 to 33: the flag and the records', () => {
  it('28: after EIO on /data, a save of another file and an append elsewhere open no folder and are unconfirmed', async () => {
    const g = guild();
    const before = unconfirmedFiles();
    stub.failDirSync(ROOT, 'EIO');
    await save(dataPath(g, 'm', 'a.json'));
    const opens = stub.dirOpens.length;
    const b = await save(dataPath(g, 'm', 'b.json'));
    const line = dataPath('global', `nb19-${g}`, 'log.jsonl');
    enqueueAppend(line, '{"x":1}\n');
    const t = fileTicket(line);
    expect(await confirmFile(t, 3000)).toBe('unavailable');
    expect(b.answer).toBe('unavailable');
    expect(stub.dirOpens.length).toBe(opens);
    expect(unconfirmedFiles()).toBe(before + 3);
  });

  it('30: a walk whose syncs succeed answers failed when another walk set the flag before its answering turn', async () => {
    const a = dataPath(guild(), 'm', 'a.json');
    const b = dataPath(guild(), 'm', 'b.json');
    const hold = stub.holdDirSync(ROOT);
    enqueueWrite(a, '{}');
    const ta = fileTicket(a);
    const first = confirmFile(ta, 5000);
    await hold.reached;
    stub.failDirSync(ROOT, 'EIO');
    expect((await save(b)).answer).toBe('unavailable');
    hold.release();
    expect(await first).toBe('unavailable');
    expect(fileTicketFailure(ta)).toMatchObject({ kind: 'earlier', dir: ROOT });
  });

  it('31: a failed walk records nothing', async () => {
    withBirth();
    const g = guild();
    stub.failDirSync(ROOT, 'EIO');
    await save(dataPath(g, 'm', 'a.json'));
    resetFolderSyncFailureForTests();
    const mark = stub.dirSyncs.length;
    expect((await save(dataPath(g, 'm', 'b.json'))).answer).toBe('ok');
    expect(since(mark)).toEqual([dataPath(g, 'm'), dataPath(g), ROOT]);
  });

  it('32: a walk during which forgetDurableFolders ran records nothing', async () => {
    withBirth();
    const g = guild();
    const hold = stub.holdDirSync(dataPath(g, 'm'));
    enqueueWrite(dataPath(g, 'm', 'a.json'), '{}');
    const t = fileTicket(dataPath(g, 'm', 'a.json'));
    const answer = confirmFile(t, 5000);
    await hold.reached;
    forgetDurableFolders();
    hold.release();
    expect(await answer).toBe('ok');
    const mark = stub.dirSyncs.length;
    await save(dataPath(g, 'm', 'b.json'));
    expect(since(mark)).toEqual([dataPath(g, 'm'), dataPath(g), ROOT]);
  });

  async function replacedThenCancelled(p: string) {
    enqueueWrite(p, '{"v":1}');
    const t1 = fileTicket(p);
    const flushing = flushAll();
    enqueueWrite(p, '{"v":2}');
    const cancel = cancelQueued([p], undefined, { freeze: true });
    await flushing;
    const [outcome] = await cancel;
    return { t1, outcome };
  }

  it('33: a replaced whole write whose chain failed on /data is logged with T2 naming /data and words T14', async () => {
    const p = dataPath(guild(), 'm', 'a.json');
    stub.failDirSync(ROOT, 'EIO');
    const { outcome } = await replacedThenCancelled(p);
    failReplacedTriesAtExit();
    expect(outcome).toMatchObject({ outcome: 'unconfirmed', what: 'whole', kind: 'sync', dir: ROOT, errno: 'EIO' });
    expect(errors).toContain(T2(p, 'sync', ROOT, 'EIO'));
    expect(errors.some(e => e.includes('appended line(s)'))).toBe(false);
    const words = unconfirmedWords(outcome as never);
    expect(words).toBe(`[Data] Can't confirm whether ${p} is saved (EIO): the file is in place whole, but ${syncWords('sync', ROOT, 'EIO').why}`);
  });

  it('33: under a flag set by /data/x, the replaced try and T14 carry the earlier clause', async () => {
    const x = dataPath(`x${guild()}`);
    stub.failDirSync(x, 'EIO');
    await save(path.join(x, 'f.json'));
    const p = dataPath(guild(), 'm', 'a.json');
    const { outcome } = await replacedThenCancelled(p);
    expect(outcome).toMatchObject({ outcome: 'unconfirmed', kind: 'earlier', dir: x });
    expect(errors).toContain(T2(p, 'earlier', x, 'EIO'));
    expect(unconfirmedWords(outcome as never)).toContain(syncWords('earlier', x, 'EIO').why);
  });
});

describe.skipIf(!POSIX)('rows 50 to 58: appends and open errors', () => {
  it('50: an append whose file is known durable runs the chain again once the flag is set', async () => {
    const g = guild();
    const p = dataPath(g, 'm', 'log.jsonl');
    enqueueAppend(p, '{"a":1}\n');
    expect(await confirmFile(fileTicket(p), 3000)).toBe('ok');
    stub.failDirSync(ROOT, 'EIO');
    await save(dataPath(guild(), 'm', 'other.json'));
    const before = unconfirmedFiles();
    const opens = stub.dirOpens.length;
    enqueueAppend(p, '{"a":2}\n');
    const t = fileTicket(p);
    expect(await confirmFile(t, 3000)).toBe('unavailable');
    expect(fileTicketState(t)).toBe('unconfirmed');
    expect(unconfirmedFiles()).toBe(before + 1);
    expect(stub.dirOpens.length).toBe(opens);
  });

  for (const [code, at] of [['EMFILE', 'G'], ['ENOENT', 'root']] as const) {
    it(`52: ${code} on the open of ${at}: T2 with the open clause, unconfirmed, no flag; the next save lands and clears it`, async () => {
      const g = guild();
      const p = dataPath(g, 'm', 'a.json');
      const dir = at === 'G' ? dataPath(g) : ROOT;
      const before = unconfirmedFiles();
      stub.rejectDirOpen(dir, code, 1);
      const { t, answer } = await save(p);
      expect(answer).toBe('unavailable');
      expect(errors).toContain(T2(p, 'open', dir, code));
      expect(errors.some(e => e.includes('Try again.') || e.includes('Flush failed'))).toBe(false);
      expect(fileTicketFailure(t)).toMatchObject({ kind: 'open', dir });
      expect(queuedFilePaths()).not.toContain(p);
      expect(unconfirmedFiles()).toBe(before + 1);
      expect(folderSyncFailed()).toBe(false);
      const mark = stub.dirSyncs.length;
      expect((await save(p, '{"v":9}')).answer).toBe('ok');
      expect(since(mark).at(-1)).toBe(ROOT);
      expect(unconfirmedFiles()).toBe(before);
    });
  }

  it('53: under the flag, three whole writes of one path log one earlier T2; the sync helper throws an earlier FolderSyncError', async () => {
    const x = dataPath(`x${guild()}`);
    stub.failDirSync(x, 'EIO');
    await save(path.join(x, 'f.json'));
    const p = dataPath(guild(), 'm', 'a.json');
    for (let i = 0; i < 3; i++) await save(p, `{"i":${i}}`);
    expect(errors.filter(e => e === T2(p, 'earlier', x, 'EIO'))).toHaveLength(1);
    let thrown: unknown;
    try { atomicWriteFileSync(dataPath(guild(), 'z.json'), '{}'); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(FolderSyncError);
    expect((thrown as FolderSyncError).kind).toBe('earlier');
    expect((thrown as FolderSyncError).message).toContain(syncWords('earlier', x, 'EIO').why);
  });

  it('56: under the flag, 1000 appends to a known durable file log one T17 of kind earlier', async () => {
    const p = dataPath(guild(), 'm', 'log.jsonl');
    enqueueAppend(p, '{"a":0}\n');
    await flushAll();
    const x = dataPath(`x${guild()}`);
    stub.failDirSync(x, 'EIO');
    await save(path.join(x, 'f.json'));
    for (let i = 1; i <= 1000; i++) {
      enqueueAppend(p, `{"a":${i}}\n`);
      await flushAll();
    }
    const lines = errors.filter(e => e.startsWith(`[Data] ${p}:`));
    expect(lines).toHaveLength(1);
    const { why, next } = syncWords('earlier', x, 'EIO');
    expect(lines[0]).toBe(`[Data] ${p}: 1 appended line(s) are in the file and synced, but ${why}; they are not written again; can't confirm they are stored. ${next}`);
    expect(errors.some(e => e.includes('did not confirm the sync of') && e.includes('appended line(s) ('))).toBe(false);
  });

  it('56: EMFILE on the open of the folder at an append: T17 with the open clause, not written again', async () => {
    const g = guild();
    const p = dataPath(g, 'm', 'log.jsonl');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    stub.rejectDirOpen(dataPath(g, 'm'), 'EMFILE', 1);
    enqueueAppend(p, '{"a":1}\n');
    const t = fileTicket(p);
    expect(await confirmFile(t, 3000)).toBe('unavailable');
    const { why, next } = syncWords('open', dataPath(g, 'm'), 'EMFILE');
    expect(errors).toContain(`[Data] ${p}: 1 appended line(s) are in the file and synced, but ${why}; they are not written again; can't confirm they are stored. ${next}`);
    await flushAll();
    expect(fs.readFileSync(p, 'utf8')).toBe('{"a":1}\n');
  });

  it('58: an open of /data that answers EIO sets the flag; EMFILE does not and is not retried; EACCES counts as synced', async () => {
    const run = async (code: string) => {
      resetFolderSyncFailureForTests();
      stub.rejectDirOpen(ROOT, code, 1);
      return save(dataPath(guild(), 'm', 'a.json'));
    };
    expect((await run('EIO')).answer).toBe('unavailable');
    expect(folderSyncFailed()).toBe(true);
    expect(fileTicketFailure((await save(dataPath(guild(), 'm', 'b.json'))).t)?.kind).toBe('earlier');
    const emfile = await run('EMFILE');
    expect(emfile.answer).toBe('unavailable');
    expect(folderSyncFailed()).toBe(false);
    expect(queuedFilePaths()).toHaveLength(0);
    expect((await run('EACCES')).answer).toBe('ok');
  });
});

describe.skipIf(!POSIX)('rows 66 to 81: moves, cancels and the flag at the failing catch', () => {
  it('66: a move sync with EIO on /data answers as today and sets the flag; EMFILE does not', async () => {
    stub.failDirSync(ROOT, 'EIO');
    expect(await fsyncDataDirs()).toEqual({ failed: true, dir: DATA_ROOT, code: 'EIO', kind: 'sync' });
    expect(folderSyncFailed()).toBe(true);
    expect(fileTicketFailure((await save(dataPath(guild(), 'm', 'a.json'))).t)?.kind).toBe('earlier');
    resetFolderSyncFailureForTests();
    stub.rejectDirOpen(ROOT, 'EMFILE', 1);
    expect(await fsyncDataDirs()).toEqual({ failed: true, dir: DATA_ROOT, code: 'EMFILE', kind: 'open' });
    expect(folderSyncFailed()).toBe(false);
  });

  it.each(['guild', 'shared'] as const)('67: a lasting EMFILE on a %s file: unavailable, never held, not queued, no cancelled outcome, T3', async which => {
    const g = guild();
    const p = which === 'guild' ? dataPath(g, 'm', 'x.json') : dataPath('global', `nb19s${g}`, 'x.json');
    stub.rejectDirOpen(path.dirname(p), 'EMFILE', 1_000);
    const before = unconfirmedFiles();
    const { t, answer } = await save(p, '{"new":true}');
    expect(answer).toBe('unavailable');
    expect(fs.readFileSync(p, 'utf8')).toBe('{"new":true}');
    expect(queuedFilePaths()).not.toContain(p);
    for (const freeze of [false, true]) {
      const [outcome] = await cancelQueued([p], undefined, { freeze });
      expect(outcome.outcome).not.toBe('cancelled');
      expect(queuedFilePaths()).not.toContain(p);
    }
    expect(fileTicketState(t)).toBe('unconfirmed');
    expect(fs.readFileSync(p, 'utf8')).toBe('{"new":true}');
    expect(errors.some(e => /not saved|nothing was saved|\[Data\] Not saved/i.test(e))).toBe(false);
    const held = heldClauses({ unconfirmedFiles: unconfirmedFiles() - before });
    expect(held).toBe("1 file(s) hold changes the disk did not confirm; can't confirm whether they are stored");
    expect(held).not.toContain('could not be saved');
  });

  it('76: an open error of a replaced try is answered by the newer write that lands with a full chain', async () => {
    withBirth();
    const g = guild();
    const p = dataPath(g, 'm', 'a.json');
    stub.rejectDirOpen(dataPath(g), 'EMFILE', 1);
    enqueueWrite(p, '{"v":1}');
    const t1 = fileTicket(p);
    const mark = stub.dirSyncs.length;
    const flushing = flushAll();
    enqueueWrite(p, '{"v":2}');
    const t2 = fileTicket(p);
    // flushAll drains the path, so both tries flush inside it: the older syncs /data/G/m and fails at the open of /data/G.
    await flushing;
    expect(queuedFilePaths()).not.toContain(p);
    expect(stub.dirOpens.filter(d => d === dataPath(g))).toHaveLength(2);
    expect(since(mark)).toEqual([dataPath(g, 'm'), dataPath(g, 'm'), dataPath(g), ROOT]);
    expect(fileTicketState(t2)).toBe('landed');
    expect(fileTicketState(t1)).toBe('landed');
    expect(fs.readFileSync(p, 'utf8')).toBe('{"v":2}');
    failReplacedTriesAtExit();
    expect(errors.some(e => e.startsWith(`[Data] ${p}:`))).toBe(false);
  });

  it('78: a whole stream write whose chain fails logs T2 and words T14 whole, never appended lines', async () => {
    const p = dataPath(guild(), 'm', 'log.jsonl');
    stub.failDirSync(ROOT, 'EIO');
    const { t } = await save(p, '{"a":1}\n{"a":2}\n');
    expect(errors).toContain(T2(p, 'sync', ROOT, 'EIO'));
    const failure = fileTicketFailure(t)!;
    expect(failure.what).toBe('whole');
    expect(unconfirmedWords({ path: p, ...failure })).toContain('the file is in place whole');
    expect(errors.some(e => e.includes('appended line(s)'))).toBe(false);
  });

  it('80: a move sync sets the flag at its failing /data sync, before it opens /data/_graveyard', async () => {
    fs.mkdirSync(path.join(ROOT, '_graveyard'), { recursive: true });
    stub.failDirSync(ROOT, 'EIO');
    const hold = stub.holdOpen(path.join(ROOT, '_graveyard'));
    const move = fsyncDataDirs();
    await hold.reached;
    expect(folderSyncFailed()).toBe(true);
    const { t } = await save(dataPath(guild(), 'm', 'a.json'));
    expect(fileTicketState(t)).toBe('unconfirmed');
    expect(fileTicketFailure(t)).toMatchObject({ kind: 'earlier', dir: ROOT });
    hold.release();
    expect(await move).toMatchObject({ failed: true, dir: DATA_ROOT, code: 'EIO' });
  });

  it('81: a walk sets the flag before its held close, so a second walk that would sync fine answers earlier', async () => {
    const g = guild();
    stub.failDirSync(dataPath(g), 'EIO');
    const close = stub.holdDirClose(dataPath(g));
    enqueueWrite(dataPath(g, 'm', 'a.json'), '{}');
    const t1 = fileTicket(dataPath(g, 'm', 'a.json'));
    const first = confirmFile(t1, 5000);
    await close.reached;
    expect(folderSyncFailed()).toBe(true);
    const { t: t2 } = await save(dataPath(g, 'n', 'b.json'));
    expect(fileTicketFailure(t2)?.kind).toBe('earlier');
    close.release();
    expect(await first).toBe('unavailable');
    expect(fileTicketFailure(t1)?.kind).toBe('sync');
  });
});
