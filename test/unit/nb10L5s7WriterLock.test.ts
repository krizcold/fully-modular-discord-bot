import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import {
  checkWriterLock, configureWriterLock, onDeposed, readWriterHolder, releaseWriterLock, reportWriterStage, takeWriterLock,
  takeWriterLockForBoot, writerLockDepth, writerLockPath,
} from '../../src/bot/internalSetup/utils/writerLock';
import { enqueueWrite, flushAll } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';

// NB10: the writer lock's check, deposition and boot wait, as the logs, reports and files show them.

type Act = 'real' | { throw: unknown };

const live = new Set<number>([process.pid, 4242, 4343]);
const realRead = fs.readFileSync;
const realOpen = fs.openSync;
const realClose = fs.closeSync;
let reads: Act[] = [];
let opens: Act[] = [];
let throwInListener: unknown = null;
let sent: any[] = [];
let errors: unknown[][] = [];
let warns: string[] = [];
let logs: string[] = [];
const originalSend = process.send;

onDeposed(() => {
  if (throwInListener !== null) throw throwInListener;
});

function code(c: string): Error {
  return Object.assign(new Error(`${c}: scripted`), { code: c });
}

function scriptFs(): { closed: number[]; opened: number[] } {
  const closed: number[] = [];
  const opened: number[] = [];
  vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
    if (String(p) === writerLockPath() && reads.length) {
      const a = reads.shift()!;
      if (a !== 'real') throw a.throw;
    }
    return (realRead as any)(p, ...rest);
  }) as typeof fs.readFileSync);
  vi.spyOn(fs, 'openSync').mockImplementation(((p: any, ...rest: any[]) => {
    if (String(p) === writerLockPath() && opens.length) {
      const a = opens.shift()!;
      if (a !== 'real') throw a.throw;
    }
    const fd = (realOpen as any)(p, ...rest);
    if (String(p) === writerLockPath()) opened.push(fd);
    return fd;
  }) as typeof fs.openSync);
  vi.spyOn(fs, 'closeSync').mockImplementation(((fd: number) => {
    closed.push(fd);
    return realClose(fd);
  }) as typeof fs.closeSync);
  syncBuiltinESMExports();
  return { closed, opened };
}

function errorLines(): string[] {
  return errors.map(c => String(c[0]));
}

function holderText(pid: number, role?: string, start: string | null = `start-${pid}`): string {
  return JSON.stringify({ pid, start, ...(role === undefined ? {} : { role }), at: Date.now() });
}

beforeEach(() => {
  reads = [];
  opens = [];
  throwInListener = null;
  sent = [];
  errors = [];
  warns = [];
  logs = [];
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  configureWriterLock('webui', { pid: () => process.pid, alive: p => live.has(p), startOf: p => `start-${p}`, now: () => Date.now() });
  (process as any).send = (msg: unknown) => { sent.push(msg); return true; };
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  (process as any).send = originalSend;
  while (writerLockDepth() > 0) releaseWriterLock();
});

describe('readWriterHolder on a read that fails', () => {
  it('names the errno of the failure', () => {
    scriptFs();
    reads = [{ throw: code('EACCES') }];
    expect(readWriterHolder()).toEqual({ kind: 'unreadable', errno: 'EACCES' });
  });

  it('answers EIO for an error without a code, and for a thrown undefined', () => {
    scriptFs();
    reads = [{ throw: new Error('no code') }, { throw: undefined }];
    expect(readWriterHolder()).toEqual({ kind: 'unreadable', errno: 'EIO' });
    expect(readWriterHolder()).toEqual({ kind: 'unreadable', errno: 'EIO' });
  });
});

describe('the check of a holder whose read fails', () => {
  it('logs EIO for a thrown undefined and for an error without a code, and keeps holding', () => {
    expect(takeWriterLock().kind).toBe('taken');
    scriptFs();
    reads = [{ throw: undefined }];
    expect(checkWriterLock()).toEqual({ kind: 'held' });
    expect(errorLines()).toEqual([`[Data] Cannot read ${writerLockPath()} (EIO); this process keeps writing and checks again in 5 s`]);
    errors = [];
    reads = [{ throw: code('EACCES') }, { throw: new Error('no code') }];
    expect(checkWriterLock()).toEqual({ kind: 'held' });
    expect(checkWriterLock()).toEqual({ kind: 'held' });
    expect(errorLines()).toEqual([
      `[Data] Cannot read ${writerLockPath()} (EACCES); this process keeps writing and checks again in 5 s`,
      `[Data] Cannot read ${writerLockPath()} (EIO); this process keeps writing and checks again in 5 s`,
    ]);
  });
});

describe('the check of a holder whose lock file is gone', () => {
  it('closes the file it re-created', () => {
    expect(takeWriterLock().kind).toBe('taken');
    const written = fs.readFileSync(writerLockPath(), 'utf8');
    fs.unlinkSync(writerLockPath());
    const { closed, opened } = scriptFs();
    expect(checkWriterLock()).toEqual({ kind: 'held' });
    expect(opened.length).toBe(1);
    expect(closed).toContain(opened[0]);
    expect(realRead(writerLockPath(), 'utf8')).toBe(written);
  });

  it('logs a re-create that failed with its errno and keeps holding', () => {
    expect(takeWriterLock().kind).toBe('taken');
    scriptFs();
    reads = [{ throw: code('ENOENT') }];
    opens = [{ throw: code('EACCES') }];
    expect(checkWriterLock()).toEqual({ kind: 'held' });
    expect(errorLines()).toEqual([`[Data] ${writerLockPath()} was removed while this process held it and could not be re-created (EACCES); checking again in 5 s`]);
  });

  it('logs EIO for a re-create that threw undefined or an error without a code', () => {
    expect(takeWriterLock().kind).toBe('taken');
    scriptFs();
    reads = [{ throw: code('ENOENT') }, { throw: code('ENOENT') }];
    opens = [{ throw: undefined }, { throw: new Error('no code') }];
    expect(checkWriterLock()).toEqual({ kind: 'held' });
    expect(checkWriterLock()).toEqual({ kind: 'held' });
    const line = `[Data] ${writerLockPath()} was removed while this process held it and could not be re-created (EIO); checking again in 5 s`;
    expect(errorLines()).toEqual([line, line]);
  });

  it('reads again once after an EEXIST and deposes for the other process it finds', () => {
    expect(takeWriterLock().kind).toBe('taken');
    fs.writeFileSync(writerLockPath(), holderText(4242, 'bot'));
    scriptFs();
    reads = [{ throw: code('ENOENT') }];
    opens = [{ throw: code('EEXIST') }];
    expect(checkWriterLock()).toMatchObject({ kind: 'deposed', holder: { pid: 4242 } });
  });

  it('logs a second EEXIST in a row as a failed re-create', () => {
    expect(takeWriterLock().kind).toBe('taken');
    scriptFs();
    reads = [{ throw: code('ENOENT') }, { throw: code('ENOENT') }];
    opens = [{ throw: code('EEXIST') }, { throw: code('EEXIST') }];
    expect(checkWriterLock()).toEqual({ kind: 'held' });
    expect(errorLines()).toEqual([`[Data] ${writerLockPath()} was removed while this process held it and could not be re-created (EEXIST); checking again in 5 s`]);
  });
});

describe('the check against the text the holder wrote', () => {
  it('logs nothing while the file holds that text', () => {
    expect(takeWriterLock().kind).toBe('taken');
    expect(checkWriterLock()).toEqual({ kind: 'held' });
    expect(errors).toEqual([]);
  });

  it('logs a text naming this process with another at, and keeps holding', () => {
    expect(takeWriterLock().kind).toBe('taken');
    const mine = JSON.parse(fs.readFileSync(writerLockPath(), 'utf8'));
    fs.writeFileSync(writerLockPath(), JSON.stringify({ ...mine, at: mine.at + 5 }));
    expect(checkWriterLock()).toEqual({ kind: 'held' });
    expect(errorLines()).toEqual([`[Data] ${writerLockPath()} holds text this process did not write; it keeps writing and checks again in 5 s`]);
  });

  it('deposes for a text naming this pid with another process start', () => {
    expect(takeWriterLock().kind).toBe('taken');
    fs.writeFileSync(writerLockPath(), holderText(process.pid, 'bot', 'start-reused'));
    expect(checkWriterLock()).toMatchObject({ kind: 'deposed', holder: { pid: process.pid, start: 'start-reused' } });
    expect(writerLockDepth()).toBe(0);
  });
});

describe('a deposition', () => {
  it('logs that this process writes no data file from now on, naming the holder', () => {
    expect(takeWriterLock().kind).toBe('taken');
    fs.writeFileSync(writerLockPath(), holderText(4242, 'bot'));
    expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
    expect(errorLines()).toContain("[Data] Another process (a bot process, pid 4242) took the data files' lock; this process writes no data file from now on");
  });

  it('stops the 5 s check', () => {
    vi.useFakeTimers();
    expect(takeWriterLock().kind).toBe('taken');
    expect(vi.getTimerCount()).toBe(1);
    fs.writeFileSync(writerLockPath(), holderText(4242, 'bot'));
    expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs a listener that throws, with its error', () => {
    expect(takeWriterLock().kind).toBe('taken');
    const boom = new Error('listener failed');
    throwInListener = boom;
    fs.writeFileSync(writerLockPath(), holderText(4242, 'bot'));
    expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
    expect(errors.filter(c => c[0] === '[Data] A step after the data files were taken failed:')).toEqual([['[Data] A step after the data files were taken failed:', boom]]);
  });

  it('keeps a queued session file write, which lands', async () => {
    expect(takeWriterLock().kind).toBe('taken');
    const session = dataPath('_sessions', 'nb10L5s7.json');
    fs.mkdirSync(dataPath('_sessions'), { recursive: true });
    enqueueWrite(session, '{"kept":true}');
    fs.writeFileSync(writerLockPath(), holderText(4242, 'bot'));
    expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
    await new Promise(r => setTimeout(r, 20));
    await flushAll();
    expect(realRead(session, 'utf8')).toBe('{"kept":true}');
    expect(errorLines().some(l => l.startsWith('[Data] Not saved'))).toBe(false);
  });
});

describe('reportWriterStage', () => {
  it('logs a send that throws', () => {
    const boom = new Error('channel closed');
    (process as any).send = () => { throw boom; };
    reportWriterStage('opening');
    expect(errors).toEqual([['[Data] Could not tell the web UI where the bot stands:', boom]]);
  });
});

describe('the boot take', () => {
  function waitingReports(): any[] {
    return sent.filter(m => m.type === 'data:writer' && m.data.stage === 'waiting').map(m => m.data);
  }

  it('waits 100 ms between polls by default', async () => {
    vi.useFakeTimers();
    fs.writeFileSync(writerLockPath(), holderText(4242, 'bot'));
    let done = false;
    const boot = takeWriterLockForBoot(undefined, () => 0).then(() => { done = true; });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    fs.unlinkSync(writerLockPath());
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await boot;
    expect(done).toBe(true);
  });

  it('logs the wait again once exactly 30 s passed, then the release', async () => {
    fs.writeFileSync(writerLockPath(), holderText(4242, 'bot'));
    let clock = 1_000;
    let sleeps = 0;
    await takeWriterLockForBoot(async () => {
      sleeps++;
      if (sleeps === 1) clock += 30_000;
      else fs.unlinkSync(writerLockPath());
    }, () => clock);
    const line = '[Data] Waiting for a bot process (pid 4242) to release the data files before the bot opens them';
    expect(warns).toEqual([line, line]);
    expect(logs).toContain('[Data] The data files were released; the bot holds them now and opens them');
    expect(sent.at(-1)).toEqual({ type: 'data:writer', data: { stage: 'opening' } });
  });

  it('reports again when the holder changes pid, or role under the same pid', async () => {
    fs.writeFileSync(writerLockPath(), holderText(4242, 'bot'));
    const next = [holderText(4343, 'bot'), holderText(4343, 'webui'), null];
    await takeWriterLockForBoot(async () => {
      const text = next.shift();
      if (text) fs.writeFileSync(writerLockPath(), text);
      else fs.unlinkSync(writerLockPath());
    }, () => 0);
    expect(waitingReports()).toEqual([
      { stage: 'waiting', holder: { role: 'bot', pid: 4242 } },
      { stage: 'waiting', holder: { role: 'bot', pid: 4343 } },
      { stage: 'waiting', holder: { role: 'webui', pid: 4343 } },
    ]);
  });

  it('takes a holder with an empty role and one with no role for the same holder', async () => {
    fs.writeFileSync(writerLockPath(), holderText(4242, ''));
    const next = [holderText(4242), null];
    await takeWriterLockForBoot(async () => {
      const text = next.shift();
      if (text) fs.writeFileSync(writerLockPath(), text);
      else fs.unlinkSync(writerLockPath());
    }, () => 0);
    expect(waitingReports()).toEqual([{ stage: 'waiting', holder: { role: '', pid: 4242 } }]);
  });

  it('reports again when the errno of a lock file it cannot create changes', async () => {
    scriptFs();
    opens = [{ throw: code('EACCES') }, { throw: code('EROFS') }];
    await takeWriterLockForBoot(async () => {}, () => 0);
    expect(waitingReports()).toEqual([{ stage: 'waiting', cause: 'EACCES' }, { stage: 'waiting', cause: 'EROFS' }]);
    expect(warns).toEqual([
      `[Data] Cannot create ${writerLockPath()} (EACCES); the bot waits until /data takes writes`,
      `[Data] Cannot create ${writerLockPath()} (EROFS); the bot waits until /data takes writes`,
    ]);
  });

  it('names a holder it cannot read as a process taking the data files at this moment', async () => {
    fs.writeFileSync(writerLockPath(), 'not json');
    await takeWriterLockForBoot(async () => { fs.unlinkSync(writerLockPath()); }, () => 0);
    expect(waitingReports()).toEqual([{ stage: 'waiting', holder: null }]);
    expect(warns).toEqual(['[Data] Waiting for another process that is taking the data files at this moment to release them before the bot opens them']);
  });
});

describe('the 5 s check timer', () => {
  it('does not keep the process alive', () => {
    const timers: NodeJS.Timeout[] = [];
    const real = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => {
      const t = real(fn, ms);
      timers.push(t);
      return t;
    }) as typeof setInterval);
    expect(takeWriterLock().kind).toBe('taken');
    expect(timers.length).toBe(1);
    expect(timers[0].hasRef()).toBe(false);
    releaseWriterLock();
  });
});
