import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The modules read the platform once at load: they load here as on Linux, where production runs, whatever runs the test.
const platform = vi.hoisted(() => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  return real;
});

import {
  answerEndedTries,
  cancelQueued,
  confirmFile,
  enqueueAppend,
  enqueueWrite,
  fileTicket,
  fileTicketFailure,
  fileTicketState,
  flushAll,
  forgetDurableFiles,
  forgetGuildDurableFiles,
  fsyncDataDirs,
  getPending,
  pathOnTheWire,
  type CancelOutcome,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { folderSyncFailed, noteFolderSyncFailure, syncFolderChain } from '../../src/bot/internalSetup/utils/folderChain';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';

const ROOT = path.resolve(DATA_ROOT);
const GRAVEYARD = path.resolve(dataPath('_graveyard'));
let guilds = 871_200_000_000_000_000n;
const freshGuild = () => String(++guilds);
const errno = (code: string) => Object.assign(new Error(`${code}: stubbed`), { code });
const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

interface Gate {
  reached: Promise<void>;
  release(): void;
}
function gate(): Gate & { wait: () => Promise<void> } {
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { reached: reachedP, release, wait: async () => { reached(); await released; } };
}

type DirRule = { dir: string; on: 'open' | 'sync'; code: string };
type OpenRule = { match: (p: string, flags: unknown) => boolean; run: () => Promise<void> };

/** The folder syncs this file sees and answers (the host's own folder fsync is not what Linux does), and holds or hooks on file opens. */
const disk = {
  synced: [] as string[],
  dirRules: [] as DirRule[],
  openRules: [] as OpenRule[],
  onAppendClose: null as ((p: string) => void) | null,
  /** Holds the next 'w' open of the temp file of target until released; then fails it with code, or lets it run. */
  holdWrite(target: string, code?: string): Gate {
    const g = gate();
    this.openRules.push({
      match: (p, flags) => flags === 'w' && p.startsWith(`${target}.`) && p.endsWith('.tmp'),
      run: async () => {
        await g.wait();
        if (code) throw errno(code);
      },
    });
    return g;
  },
};

function fakeDisk(): void {
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags: any, ...rest: any[]) => {
    const at = path.resolve(String(p));
    if ((flags === 'r' || flags === undefined) && isDir(at)) {
      const take = (on: DirRule['on']) => {
        const i = disk.dirRules.findIndex(r => r.dir === at && r.on === on);
        return i < 0 ? null : disk.dirRules.splice(i, 1)[0].code;
      };
      const opened = take('open');
      if (opened) throw errno(opened);
      return {
        stat: (options?: any) => fs.promises.stat(at, options),
        sync: async () => {
          disk.synced.push(at);
          const code = take('sync');
          if (code) throw errno(code);
        },
        close: async () => {},
      };
    }
    const i = disk.openRules.findIndex(r => r.match(at, flags));
    if (i >= 0) await disk.openRules.splice(i, 1)[0].run();
    const handle = await (open as any)(p, flags, ...rest);
    if (flags !== 'a+') return handle;
    return new Proxy(handle, {
      get(target, prop, receiver) {
        if (prop === 'close') return async () => { disk.onAppendClose?.(at); return target.close(); };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }) as any);
}

let errorSpy: ReturnType<typeof vi.spyOn>;
const lines = (): string[] => errorSpy.mock.calls.map((c: unknown[]) => c.map(String).join(' '));

beforeEach(() => {
  disk.synced = [];
  disk.dirRules = [];
  disk.openRules = [];
  disk.onAppendClose = null;
  fs.mkdirSync(GRAVEYARD, { recursive: true });
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  fakeDisk();
});
afterEach(async () => {
  disk.openRules = [];
  disk.dirRules = [];
  await flushAll();
  vi.restoreAllMocks();
});
afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
});

describe('forgetting the durable folders', () => {
  it('after forgetDurableFiles the next chain syncs every folder up to /data again', async () => {
    const g = freshGuild();
    const m = path.resolve(dataPath(g, 'm'));
    fs.mkdirSync(m, { recursive: true });
    await syncFolderChain(m);
    disk.synced = [];
    await syncFolderChain(m);
    expect(disk.synced).toEqual([m]);
    forgetDurableFiles();
    disk.synced = [];
    expect(await syncFolderChain(m)).toEqual({ failed: false });
    expect(disk.synced).toEqual([m, path.resolve(dataPath(g)), ROOT]);
  });

  it('after forgetGuildDurableFiles the next chain of a folder of that guild syncs up to /data again', async () => {
    const g = freshGuild();
    const m = path.resolve(dataPath(g, 'm'));
    fs.mkdirSync(m, { recursive: true });
    await syncFolderChain(m);
    disk.synced = [];
    await syncFolderChain(m);
    expect(disk.synced).toEqual([m]);
    forgetGuildDurableFiles(g);
    disk.synced = [];
    await syncFolderChain(m);
    expect(disk.synced).toEqual([m, path.resolve(dataPath(g)), ROOT]);
  });
});

describe('an append whose lines land while a folder sync of the process failed', () => {
  it('a folder sync error set while the append closes its file leaves the lines unconfirmed, not saved', async () => {
    const g = freshGuild();
    const file = dataPath(g, 'm', 'log.jsonl');
    const other = path.resolve(dataPath(g, 'other'));
    disk.onAppendClose = p => { if (p === path.resolve(file)) noteFolderSyncFailure(other, 'EIO'); };
    enqueueAppend(file, '{"a":1}\n');
    const ticket = fileTicket(file);
    expect(await confirmFile(ticket, 5000)).toBe('unavailable');
    expect(fileTicketState(ticket)).toBe('unconfirmed');
    expect(fileTicketFailure(ticket)).toEqual({ errno: 'EIO', cut: false, what: 'lines', kind: 'earlier', dir: other });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}\n');
    expect(lines().some(l => l.startsWith(`[Data] ${file}: 1 appended line(s) are in the file and synced, but no folder sync is trusted since`))).toBe(true);
  });

  it("a failed sync of the append's own folder is reported as that folder's sync, not as an earlier failure", async () => {
    const g = freshGuild();
    const file = dataPath(g, 'm', 'log.jsonl');
    const m = path.resolve(dataPath(g, 'm'));
    fs.mkdirSync(m, { recursive: true });
    disk.dirRules.push({ dir: m, on: 'sync', code: 'EIO' });
    enqueueAppend(file, '{"a":1}\n');
    const ticket = fileTicket(file);
    expect(await confirmFile(ticket, 5000)).toBe('unavailable');
    expect(fileTicketFailure(ticket)).toEqual({ errno: 'EIO', cut: false, what: 'lines', kind: 'sync', dir: m });
    expect(lines()).toContain(`[Data] ${file}: 1 appended line(s) are in the file and synced, but the disk did not confirm the sync of ${m} (EIO); they are not written again; can't confirm they are stored. Check the disk, then restart the machine.`);
  });
});

describe('a deposition cancel whose wait stops', () => {
  it('answers nothing later: a write it never answered stays queued after the exit hook', async () => {
    const g = freshGuild();
    const file = dataPath(g, 'm', 'a.json');
    const held = disk.holdWrite(path.resolve(file), 'EIO');
    enqueueWrite(file, '{"a":1}');
    await held.reached;
    expect(pathOnTheWire(file)).toBe(true);
    const answers: CancelOutcome[] = [];
    const stopped = cancelQueued([file], async () => { throw new Error('[Test] the wait was stopped'); }, { freeze: true, onAnswer: a => answers.push(a) });
    await expect(stopped).rejects.toThrow('[Test] the wait was stopped');
    held.release();
    await vi.waitFor(() => expect(pathOnTheWire(file)).toBe(false), { timeout: 5000, interval: 5 });
    answerEndedTries();
    expect(answers).toEqual([]);
    expect(getPending(file)).toMatchObject({ op: 'write', content: '{"a":1}' });
  });
});

describe('fsyncDataDirs on Linux', () => {
  it('an EIO opening /data is the sync answer and sets the process flag', async () => {
    disk.dirRules.push({ dir: ROOT, on: 'open', code: 'EIO' });
    expect(await fsyncDataDirs()).toEqual({ failed: true, dir: DATA_ROOT, code: 'EIO', kind: 'sync' });
    expect(folderSyncFailed()).toBe(true);
  });

  it('an EIO syncing /data sets the process flag', async () => {
    disk.dirRules.push({ dir: ROOT, on: 'sync', code: 'EIO' });
    expect(await fsyncDataDirs()).toEqual({ failed: true, dir: DATA_ROOT, code: 'EIO', kind: 'sync' });
    expect(folderSyncFailed()).toBe(true);
  });
});

describe('confirmFile and the whole writes a newer write replaced', () => {
  it('fails only the replaced writes that hold its op, and none once they are answered', async () => {
    const g = freshGuild();
    const file = dataPath(g, 'm', 'w.json');
    const m = path.resolve(dataPath(g, 'm'));
    const target = path.resolve(file);

    const holdA = disk.holdWrite(target);
    enqueueWrite(file, '"a"');
    const ta = fileTicket(file);
    await holdA.reached;
    enqueueWrite(file, '"a2"');
    const ta2 = fileTicket(file);
    const holdA2 = disk.holdWrite(target);
    disk.dirRules.push({ dir: m, on: 'open', code: 'EMFILE' });
    holdA.release();
    await holdA2.reached;

    // A's chain failed while A2 replaced it: A is a replaced write, failed once its ticket is read.
    expect(await confirmFile(ta, 0)).toBe('unavailable');
    expect(fileTicketState(ta)).toBe('unconfirmed');
    // With no replaced write left, A2's ticket is still only pending.
    expect(await confirmFile(ta2, 0)).toBe('pending');

    enqueueWrite(file, '"c"');
    const tc = fileTicket(file);
    const holdC = disk.holdWrite(target);
    holdA2.release();
    await holdC.reached;
    expect(fileTicketState(ta2)).toBe('landed');

    enqueueWrite(file, '"d"');
    const td = fileTicket(file);
    const holdD = disk.holdWrite(target);
    disk.dirRules.push({ dir: m, on: 'open', code: 'EMFILE' });
    holdC.release();
    await holdD.reached;

    // C is replaced by D after its chain failed; A's ticket does not reach it, so C stays open for D to answer.
    const before = lines().length;
    expect(await confirmFile(ta, 0)).toBe('unavailable');
    expect(fileTicketState(tc)).toBe('open');
    expect(lines().length).toBe(before);

    holdD.release();
    expect(await confirmFile(td, 5000)).toBe('ok');
    expect(fileTicketState(tc)).toBe('landed');
    expect(await confirmFile(tc, 1000)).toBe('ok');
    expect(fs.readFileSync(file, 'utf8')).toBe('"d"');
  });
});
