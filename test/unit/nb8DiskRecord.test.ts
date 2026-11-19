import { spawnSync } from 'child_process';
import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB8 test 25 (N1, N6, N11, N18, N19, O2, O3): the disk error record folderChain writes at a first folder sync error of a
// process with a role, and what a process reads from it. The module reads the platform once at load: it loads here as
// on Linux, where production runs, so the 'earlier' answer shows on any machine.
const platform = vi.hoisted(() => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  return real;
});

import * as chain from '../../src/bot/internalSetup/utils/folderChain';
import { dataPath } from '../../src/utils/dataRoot';
import { _resetBackupIPCForTests, setupBackupIPC } from '../../src/bot/internalSetup/utils/ipcBackupHandler';

afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
});

const SNAP = dataPath('_snapshots');
const GUILD = dataPath('guilds', 'g1');
const recordAt = (id: string) => path.join(SNAP, `disk-error-${id}.json`);
const when = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const MACHINE = "no backup is taken and no restore starts until the machine the bot runs on is restarted (a restart of the bot's container is not enough after a disk error)";
const errno = (code: string) => Object.assign(new Error(`stubbed ${code}`), { code });

let warns: string[];
beforeEach(() => {
  warns = [];
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fs.rmSync(SNAP, { recursive: true, force: true });
  fs.rmSync(dataPath('guilds'), { recursive: true, force: true });
});

/** A record written by the real writer: a process of `role` and boot `id` meets EIO on `dir`, then the state resets. */
function writeRecordAs(id: string | null, role: chain.DiskRole = 'web panel', dir = GUILD): void {
  chain._setBootIdForTests(id);
  chain.setDiskRole(role);
  chain.noteFolderSyncFailure(dir, 'EIO');
  chain.resetFolderSyncFailureForTests();
}

describe('the record writer', () => {
  it('row 1: with no role a note sets the flag and writes and logs nothing', () => {
    const before = Date.now();
    chain.noteFolderSyncFailure(GUILD, 'EIO');
    const flag = chain.folderSyncFlag();
    expect(flag).toMatchObject({ dir: GUILD, errno: 'EIO', by: null, source: 'own', file: null });
    expect(flag!.at).toBeGreaterThanOrEqual(before);
    expect(fs.existsSync(SNAP)).toBe(false);
    expect(warns).toEqual([]);
  });

  it('row 2: the first note of a web panel creates _snapshots and its boot\'s record, and logs the recorded line once', () => {
    chain._setBootIdForTests('b1');
    chain.setDiskRole('web panel');
    chain.noteFolderSyncFailure(GUILD, 'EIO');
    const flag = chain.folderSyncFlag()!;
    const record = JSON.parse(fs.readFileSync(recordAt('b1'), 'utf-8'));
    expect(record).toEqual({ format: 1, bootId: 'b1', folder: '/data/guilds/g1', errno: 'EIO', at: flag.at, by: 'web panel' });
    expect(flag).toMatchObject({ dir: GUILD, errno: 'EIO', by: 'web panel', source: 'own', file: recordAt('b1') });
    expect(warns).toEqual([`[Data] Syncing the folder /data/guilds/g1 failed (EIO); ${MACHINE}`]);
  });

  it('row 3: a second note keeps the first flag and the record\'s bytes', () => {
    chain._setBootIdForTests('b1');
    chain.setDiskRole('web panel');
    chain.noteFolderSyncFailure(GUILD, 'EIO');
    const first = chain.folderSyncFlag();
    const bytes = fs.readFileSync(recordAt('b1'), 'utf-8');
    chain.noteFolderSyncFailure(dataPath('guilds', 'g2'), 'ENOSPC');
    expect(chain.folderSyncFlag()).toEqual(first);
    expect(fs.readFileSync(recordAt('b1'), 'utf-8')).toBe(bytes);
    expect(warns).toHaveLength(1);
  });

  it('O2: two processes of one boot first-set: one record, both lines recorded, both listeners told recorded', async () => {
    const outcomes: chain.FlagWrite[] = [];
    chain._setBootIdForTests('b1');
    chain.setDiskRole('bot');
    chain.onFolderSyncFlag(w => outcomes.push(w));
    vi.resetModules();
    const other: typeof chain = await import('../../src/bot/internalSetup/utils/folderChain');
    try {
      other._setBootIdForTests('b1');
      other.setDiskRole('web panel');
      other.onFolderSyncFlag(w => outcomes.push(w));
      other.noteFolderSyncFailure(GUILD, 'EIO');
      const bytes = fs.readFileSync(recordAt('b1'), 'utf-8');
      chain.noteFolderSyncFailure(dataPath('guilds', 'g2'), 'EIO');
      expect(fs.readdirSync(SNAP)).toEqual(['disk-error-b1.json']);
      expect(fs.readFileSync(recordAt('b1'), 'utf-8')).toBe(bytes);
      expect(warns).toEqual([
        `[Data] Syncing the folder /data/guilds/g1 failed (EIO); ${MACHINE}`,
        `[Data] Syncing the folder /data/guilds/g2 failed (EIO); ${MACHINE}`,
      ]);
      expect(outcomes.map(o => [o.recorded, o.tried, o.writeErrno])).toEqual([
        [true, recordAt('b1'), undefined],
        [true, recordAt('b1'), undefined],
      ]);
      expect(chain.folderSyncFlag()!.file).toBe(recordAt('b1'));
    } finally {
      other.resetFolderSyncFailureForTests();
    }
  });

  it('row 4: with no boot id the record is disk-error-unknown.json and the line names it', () => {
    chain._setBootIdForTests(null);
    chain.setDiskRole('web panel');
    chain.noteFolderSyncFailure(GUILD, 'EIO');
    expect(JSON.parse(fs.readFileSync(recordAt('unknown'), 'utf-8'))).toMatchObject({ bootId: null, folder: '/data/guilds/g1' });
    expect(warns).toEqual([
      "[Data] Syncing the folder /data/guilds/g1 failed (EIO); no backup is taken and no restore starts until /data/_snapshots/disk-error-unknown.json is deleted and the bot's container is restarted (this process cannot read the machine's boot id)",
    ]);
  });

  it('row 5: an EROFS on the create sets the flag, tells the listener not recorded, and logs B5\'s line', () => {
    const outcomes: chain.FlagWrite[] = [];
    chain._setBootIdForTests('b1');
    chain.setDiskRole('web panel');
    chain.onFolderSyncFlag(w => outcomes.push(w));
    const realOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: any[]) => {
      if (String(p).includes('disk-error-')) throw errno('EROFS');
      return (realOpen as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    chain.noteFolderSyncFailure(GUILD, 'EIO');
    expect(chain.folderSyncFlag()).toMatchObject({ dir: GUILD, errno: 'EIO', source: 'own', file: null });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ recorded: false, tried: recordAt('b1'), writeErrno: 'EROFS' });
    expect(fs.existsSync(recordAt('b1'))).toBe(false);
    expect(warns).toEqual([
      "[Data] Syncing the folder /data/guilds/g1 failed (EIO); no backup is taken and no restore starts until the bot's container restarts",
      "[Backup] The disk error could not be recorded in /data/_snapshots/disk-error-b1.json (EROFS); a restart of the bot's container would clear it",
    ]);
  });

  it('row 6: a listener registered after an own set runs once at once; one under a flag from the record never runs', () => {
    const late: chain.FlagWrite[] = [];
    chain._setBootIdForTests('b1');
    chain.setDiskRole('web panel');
    chain.noteFolderSyncFailure(GUILD, 'EIO');
    chain.onFolderSyncFlag(w => late.push(w));
    chain.noteFolderSyncFailure(dataPath('guilds', 'g2'), 'EIO');
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ recorded: true, tried: recordAt('b1'), flag: { dir: GUILD, source: 'own' } });

    chain.resetFolderSyncFailureForTests();
    const fromRecord: chain.FlagWrite[] = [];
    chain._setBootIdForTests('b1');
    chain.setDiskRole('bot');
    chain.onFolderSyncFlag(w => fromRecord.push(w));
    chain.noteFolderSyncFailure(dataPath('guilds', 'g3'), 'EIO');
    expect(chain.folderSyncFlag()!.source).toBe('record');
    expect(fromRecord).toEqual([]);
  });

  it('row 7: a bot started after a web panel\'s record starts flagged from it, writing and logging nothing', () => {
    writeRecordAs('b1');
    const bytes = fs.readFileSync(recordAt('b1'), 'utf-8');
    const mtime = fs.statSync(recordAt('b1')).mtimeMs;
    const at = JSON.parse(bytes).at as number;
    chain._setBootIdForTests('b1');
    chain.setDiskRole('bot');
    const flag = chain.folderSyncFlag();
    const answer = chain.syncFolderSync(dataPath('guilds'));
    expect(flag).toEqual({ dir: '/data/guilds/g1', errno: 'EIO', at, by: 'web panel', source: 'record', file: recordAt('b1') });
    expect(fs.readFileSync(recordAt('b1'), 'utf-8')).toBe(bytes);
    expect(fs.statSync(recordAt('b1')).mtimeMs).toBe(mtime);
    expect(warns).toEqual([`[Data] Syncing the folder /data/guilds/g1 failed (EIO); ${MACHINE}`]);
    expect(answer).toMatchObject({ failed: true, kind: 'earlier', dir: '/data/guilds/g1', errno: 'EIO' });
    expect(chain.syncWords('earlier', '/data/guilds/g1', 'EIO').why).toBe(
      `no folder sync is trusted since the disk did not confirm the sync of /data/guilds/g1 (EIO) at ${when(at)}, as /data/_snapshots/disk-error-b1.json records`,
    );
  });

  it('row 8 and O3: a record torn after its create counts as recorded, and a later start reads it as unreadable', () => {
    const outcomes: chain.FlagWrite[] = [];
    chain._setBootIdForTests('b1');
    chain.setDiskRole('web panel');
    chain.onFolderSyncFlag(w => outcomes.push(w));
    vi.spyOn(fs, 'writeSync').mockImplementation((() => { throw errno('ENOSPC'); }) as any);
    syncBuiltinESMExports();
    chain.noteFolderSyncFailure(GUILD, 'EIO');
    vi.mocked(fs.writeSync).mockRestore();
    syncBuiltinESMExports();
    expect(outcomes.map(o => o.recorded)).toEqual([true]);
    expect(warns).toEqual([`[Data] Syncing the folder /data/guilds/g1 failed (EIO); ${MACHINE}`]);
    expect(fs.readFileSync(recordAt('b1'), 'utf-8')).toBe('');

    chain.resetFolderSyncFailureForTests();
    chain._setBootIdForTests('b1');
    chain.setDiskRole('bot');
    const flag = chain.folderSyncFlag();
    const { why } = chain.syncWords('earlier', flag!.dir, flag!.errno);
    expect(flag).toEqual({ dir: '/data/_snapshots/disk-error-b1.json', errno: 'record unreadable', at: null, by: null, source: 'record', file: recordAt('b1') });
    expect(why).toBe('no folder sync is trusted since /data/_snapshots/disk-error-b1.json records a disk error on this machine, and that record cannot be read');
  });

  it('row 13: a data bundle import whose create fails logs no clause and its own write line; a create that works records its role', () => {
    chain._setBootIdForTests('b1');
    chain.setDiskRole('a data bundle import');
    const realOpen = fs.openSync;
    const open = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: any[]) => {
      if (String(p).includes('disk-error-')) throw errno('EROFS');
      return (realOpen as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    chain.noteFolderSyncFailure(GUILD, 'EIO');
    open.mockRestore();
    syncBuiltinESMExports();
    expect(warns).toEqual([
      '[Data] Syncing the folder /data/guilds/g1 failed (EIO)',
      '[Data] The disk error could not be recorded in /data/_snapshots/disk-error-b1.json (EROFS); the web panel does not see this error',
    ]);

    chain.resetFolderSyncFailureForTests();
    chain._setBootIdForTests('b1');
    chain.setDiskRole('a data bundle import');
    chain.noteFolderSyncFailure(GUILD, 'EIO');
    expect(JSON.parse(fs.readFileSync(recordAt('b1'), 'utf-8')).by).toBe('a data bundle import');
  });

  it('a bot whose create fails logs H1\'s write line with no suffix', () => {
    chain._setBootIdForTests('b1');
    chain.setDiskRole('bot');
    vi.spyOn(fs, 'mkdirSync').mockImplementation((() => { throw errno('EROFS'); }) as any);
    syncBuiltinESMExports();
    chain.noteFolderSyncFailure(GUILD, 'EIO');
    expect(warns).toEqual([
      '[Data] Syncing the folder /data/guilds/g1 failed (EIO)',
      '[Data] The disk error could not be recorded in /data/_snapshots/disk-error-b1.json (EROFS)',
    ]);
  });

  it('row 14: after the reset a note writes no file', () => {
    chain._setBootIdForTests('b1');
    chain.setDiskRole('web panel');
    chain.resetFolderSyncFailureForTests();
    chain.noteFolderSyncFailure(GUILD, 'EIO');
    expect(chain.folderSyncFlag()).toMatchObject({ by: null, file: null });
    expect(fs.existsSync(SNAP)).toBe(false);
    expect(warns).toEqual([]);
  });
});

describe('the record readers', () => {
  it('row 9: diskRecord() reads this boot\'s name, or every record while the boot id is unknown', () => {
    chain._setBootIdForTests('b1');
    expect(chain.diskRecord()).toBeNull();
    writeRecordAs('b2');
    chain._setBootIdForTests('b1');
    expect(chain.diskRecord()).toBeNull();

    writeRecordAs('b3', 'bot', dataPath('guilds', 'g3'));
    chain._setBootIdForTests(null);
    const both = chain.diskRecord();
    expect(both!.files).toEqual([recordAt('b2'), recordAt('b3')]);
    expect(both!.record).toMatchObject({ format: 1, bootId: 'b2', folder: '/data/guilds/g1', errno: 'EIO', by: 'web panel' });

    writeRecordAs('b1');
    chain._setBootIdForTests('b1');
    const realRead = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (String(p) === recordAt('b1')) throw errno('EACCES');
      return (realRead as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    const denied = chain.diskRecord();
    vi.mocked(fs.readFileSync).mockRestore();
    syncBuiltinESMExports();
    expect(denied).toEqual({ files: [recordAt('b1')], record: null });
  });

  it('row 10: diskError() answers the own flag, else the record, else null', () => {
    chain._setBootIdForTests('b1');
    expect(chain.diskError()).toBeNull();

    chain.noteFolderSyncFailure(GUILD, 'EIO');
    const own = chain.diskError();
    const flag = chain.folderSyncFlag()!;
    expect(own).toEqual({ dir: GUILD, errno: 'EIO', at: flag.at, by: null, files: [], unreadable: false });

    chain.resetFolderSyncFailureForTests();
    writeRecordAs('b1', 'bot', dataPath('guilds', 'g4'));
    chain._setBootIdForTests('b1');
    const at = JSON.parse(fs.readFileSync(recordAt('b1'), 'utf-8')).at;
    expect(chain.diskError()).toEqual({ dir: '/data/guilds/g4', errno: 'EIO', at, by: 'bot', files: [recordAt('b1')], unreadable: false });
    expect(chain.folderSyncFlag()).toBeNull();
  });

  const FOLDER_WHY = (code: string) => `no folder sync is trusted since /data/_snapshots could not be read (${code}) to look for a disk error record`;

  it('fix 1: _snapshots as a file names the folder, with no record file, for either boot id', () => {
    fs.mkdirSync(path.dirname(SNAP), { recursive: true });
    fs.writeFileSync(SNAP, 'x');
    // Windows answers ENOENT, not ENOTDIR, for a read of a path under a file, so the known boot id's case runs on Linux.
    for (const id of platform.value === 'win32' ? [null] : [null, 'b1']) {
      chain.resetFolderSyncFailureForTests();
      chain._setBootIdForTests(id);
      expect(chain.diskRecord()).toEqual({ files: [], record: null, folder: { dir: '/data/_snapshots', errno: 'ENOTDIR' } });
      chain.setDiskRole('bot');
      expect(chain.folderSyncFlag()).toMatchObject({ dir: '/data/_snapshots', errno: 'ENOTDIR', source: 'record', file: null });
      expect(chain.diskError()).toMatchObject({ dir: '/data/_snapshots', errno: 'ENOTDIR', files: [], unreadable: false });
      expect(chain.syncWords('earlier', '/data/_snapshots', 'ENOTDIR')).toEqual({ why: FOLDER_WHY('ENOTDIR'), next: 'Check the disk, then restart the machine.' });
    }
    expect(warns).toEqual([]);
  });

  it('fix 1: a listing of _snapshots that fails names the folder and its errno, with no record file', () => {
    chain._setBootIdForTests(null);
    const realReaddir = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (String(p) === SNAP) throw errno('EACCES');
      return (realReaddir as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    const found = chain.diskRecord();
    chain.setDiskRole('web panel');
    const shown = chain.diskError();
    vi.mocked(fs.readdirSync).mockRestore();
    syncBuiltinESMExports();
    expect(found).toEqual({ files: [], record: null, folder: { dir: '/data/_snapshots', errno: 'EACCES' } });
    expect(chain.folderSyncFlag()).toMatchObject({ dir: '/data/_snapshots', errno: 'EACCES', at: null, by: null, source: 'record', file: null });
    expect(shown).toMatchObject({ dir: '/data/_snapshots', errno: 'EACCES', files: [], unreadable: false });
    expect(chain.syncWords('earlier', '/data/_snapshots', 'EACCES').why).toBe(FOLDER_WHY('EACCES'));
  });

  it('row 11: a child\'s report is recorded as the bot\'s, logged as the report line only, and calls no listener', () => {
    const outcomes: chain.FlagWrite[] = [];
    chain._setBootIdForTests('b1');
    chain.setDiskRole('web panel');
    chain.onFolderSyncFlag(w => outcomes.push(w));
    const at = Date.UTC(2026, 10, 12, 21, 5);
    chain.noteReportedFolderSyncFailure({ dir: GUILD, errno: 'EIO', at });
    expect(JSON.parse(fs.readFileSync(recordAt('b1'), 'utf-8'))).toEqual({ format: 1, bootId: 'b1', folder: '/data/guilds/g1', errno: 'EIO', at, by: 'bot' });
    expect(chain.folderSyncFlag()).toEqual({ dir: GUILD, errno: 'EIO', at, by: 'bot', source: 'report', file: recordAt('b1') });
    expect(warns).toEqual([`[Backup] The bot reported a disk error when /data/guilds/g1 was synced (EIO); ${MACHINE}`]);
    expect(outcomes).toEqual([]);
    expect(chain.syncWords('earlier', GUILD, 'EIO').why).toBe(
      'no folder sync is trusted since the disk did not confirm the sync of /data/guilds/g1 (EIO) in the bot process at 2026-11-12 21:05 UTC',
    );

    chain.noteReportedFolderSyncFailure({ dir: dataPath('guilds', 'g2'), errno: 'EIO', at: at + 1 });
    expect(chain.folderSyncFlag()!.dir).toBe(GUILD);
    expect(warns).toHaveLength(1);
  });

  it('row 12: removeOtherBootRecords() removes other boots\' records only, logs a failed unlink, and removes none with no boot id', async () => {
    // Three processes take their roles before any record stands, as a process that reads none at its start does.
    const writers: Array<typeof chain> = [];
    for (const id of ['b2', 'b1', null]) {
      vi.resetModules();
      const copy: typeof chain = await import('../../src/bot/internalSetup/utils/folderChain');
      copy._setBootIdForTests(id);
      copy.setDiskRole('web panel');
      writers.push(copy);
    }
    for (const copy of writers) {
      copy.noteFolderSyncFailure(GUILD, 'EIO');
      copy.resetFolderSyncFailureForTests();
    }
    chain._setBootIdForTests(null);
    chain.removeOtherBootRecords();
    expect(fs.readdirSync(SNAP).sort()).toEqual(['disk-error-b1.json', 'disk-error-b2.json', 'disk-error-unknown.json']);

    chain._setBootIdForTests('b1');
    const realUnlink = fs.unlinkSync;
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p).endsWith('disk-error-b2.json')) throw errno('EIO');
      return realUnlink(p);
    }) as any);
    syncBuiltinESMExports();
    warns.length = 0;
    chain.removeOtherBootRecords();
    unlink.mockRestore();
    syncBuiltinESMExports();
    expect(fs.readdirSync(SNAP).sort()).toEqual(['disk-error-b1.json', 'disk-error-b2.json', 'disk-error-unknown.json']);
    expect(warns).toEqual([
      '[Backup] /data/_snapshots/disk-error-b2.json, a disk error record of an earlier boot, could not be removed (EIO); delete it by hand',
    ]);

    chain.removeOtherBootRecords();
    expect(fs.readdirSync(SNAP).sort()).toEqual(['disk-error-b1.json', 'disk-error-unknown.json']);
  });
});

describe('test/checkSyncSites.cjs', () => {
  const CHECK = path.join(__dirname, '..', 'checkSyncSites.cjs');
  let tree: string;
  beforeEach(() => { tree = fs.mkdtempSync(path.join(os.tmpdir(), 'nb8-sync-sites-')); });
  afterEach(() => { fs.rmSync(tree, { recursive: true, force: true }); });

  const plant = (rel: string, lines: string[]) => {
    fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
    fs.writeFileSync(path.join(tree, rel), lines.join('\n'));
  };
  const check = (...args: string[]) => spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8' });

  it('row 15: a planted handle sync in a file with no table entry fails, naming file:line', () => {
    plant('webui/backups/state.ts', ['export async function f(fh: any) {', '  await fh.sync();', '}']);
    const run = check(tree);
    expect(run.status).toBe(1);
    expect(run.stderr.trim().split('\n').slice(1)).toEqual(['webui/backups/state.ts:2 (found 1, allowed 0)']);
  });

  it('row 16: a second fsyncSync in atomicWrite.ts fails, naming both lines', () => {
    plant('bot/internalSetup/utils/atomicWrite.ts', ['const fd = 1;', 'fs.fsyncSync(fd);', 'fs.closeSync(fd);', 'fs.fsyncSync(fd);']);
    const run = check(tree);
    expect(run.status).toBe(1);
    expect(run.stderr.trim().split('\n').slice(1)).toEqual([
      'bot/internalSetup/utils/atomicWrite.ts:2 (found 2, allowed 1)',
      'bot/internalSetup/utils/atomicWrite.ts:4 (found 2, allowed 1)',
    ]);
  });

  it('row 17: folderChain.ts with any number of calls passes, and so does a comment that says fsync', () => {
    plant('bot/internalSetup/utils/folderChain.ts', ['fs.fsyncSync(fd);', 'await dh.sync();', 'await fh.datasync();', 'fs.fdatasyncSync(fd);']);
    plant('webui/backups/state.ts', ['// fsync the folder after the rename, then sync its parent', 'export const x = 1;']);
    plant('bot/internalSetup/utils/atomicWrite.ts', ['fs.fsyncSync(fd);']);
    const run = check(tree);
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
  });

  it('row 18: src/ as built passes', () => {
    const run = check();
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
  });
});

describe('fix 6: a regular file at _snapshots', () => {
  it('a bot\'s first folder sync error is not recorded (the mkdir\'s EEXIST), logs the not-recorded line and sends the report', () => {
    const sent: unknown[] = [];
    const realSend = process.send;
    const before = process.listeners('message');
    (process as { send?: unknown }).send = (message: unknown) => { sent.push(message); return true; };
    try {
      chain._setBootIdForTests('b1');
      chain.setDiskRole('bot');
      _resetBackupIPCForTests();
      setupBackupIPC();
      const outcomes: chain.FlagWrite[] = [];
      chain.onFolderSyncFlag(w => outcomes.push(w));
      fs.mkdirSync(path.dirname(SNAP), { recursive: true });
      fs.writeFileSync(SNAP, 'x');
      chain.noteFolderSyncFailure(GUILD, 'EIO');
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ recorded: false, tried: recordAt('b1'), writeErrno: 'EEXIST' });
      expect(chain.folderSyncFlag()).toMatchObject({ dir: GUILD, errno: 'EIO', source: 'own', file: null });
      expect(warns).toEqual([
        '[Data] Syncing the folder /data/guilds/g1 failed (EIO)',
        '[Data] The disk error could not be recorded in /data/_snapshots/disk-error-b1.json (EEXIST)',
      ]);
      expect(sent).toEqual([{ type: 'disk:folder-sync-failed', data: { dir: '/data/guilds/g1', errno: 'EIO', at: outcomes[0].flag.at } }]);
    } finally {
      (process as { send?: unknown }).send = realSend;
      for (const listener of process.listeners('message')) if (!before.includes(listener)) process.off('message', listener);
      _resetBackupIPCForTests();
      chain.resetFolderSyncFailureForTests();
    }
  });
});
