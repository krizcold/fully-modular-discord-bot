import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB8 test 1: one row per state x exit cell, named <phase>.<exit>, driven through the real modules. Each part of the
// build adds the cells of its own layer.

const h = vi.hoisted(() => ({
  syncFolder: null as null | ((dir: string) => Promise<unknown> | null),
  syncFolderSync: null as null | ((dir: string) => unknown),
}));
const safety = vi.hoisted(() => ({ recordCrash: () => undefined, isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolder: (dir: string) => h.syncFolder?.(dir) ?? real.syncFolder(dir),
    syncFolderSync: (dir: string) => h.syncFolderSync?.(dir) ?? real.syncFolderSync(dir),
  };
});

import { dataPath } from '../../src/utils/dataRoot';
import { BotManager } from '../../src/webui/botManager';
import { _setTakeTimingForTests as setLocalTiming, takeSnapshotLocal } from '../../src/bot/internalSetup/utils/backups/snapshotTake';
import { readSnapshot } from '../../src/bot/internalSetup/utils/backups/snapshotList';
import { configureWriterLock, releaseWriterLock as releaseLocal, writerLockDepth as localDepth, writerLockPath as localLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { folderSyncFlag } from '../../src/bot/internalSetup/utils/folderChain';

const seams = { pid: () => process.pid, alive: () => true, startOf: (pid: number) => `start-${pid}`, now: () => Date.now() };
const locks: Array<{ writerLockDepth(): number; releaseWriterLock(): void }> = [];
const snaps = () => dataPath('_snapshots');
const err = (code: string) => Object.assign(new Error(`${code}: stubbed`), { code });

async function bot() {
  vi.resetModules();
  const lock = await import('../../src/bot/internalSetup/utils/writerLock');
  fs.rmSync(lock.writerLockPath(), { force: true });
  lock.configureWriterLock('bot', seams);
  lock.takeWriterLock();
  locks.push(lock);
  const take = await import('../../src/bot/internalSetup/utils/backups/snapshotTake');
  take._setTakeTimingForTests({ pollMs: 5 }, seams);
  return { take, chain: await import('../../src/bot/internalSetup/utils/folderChain') };
}

beforeEach(() => {
  for (const e of fs.readdirSync(dataPath())) fs.rmSync(dataPath(e), { recursive: true, force: true });
  fs.mkdirSync(dataPath('123', 'mod'), { recursive: true });
  fs.writeFileSync(dataPath('123', 'mod', 'a.json'), '{"a":1}');
  h.syncFolder = null;
  h.syncFolderSync = null;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const lock of locks.splice(0)) while (lock.writerLockDepth() > 0) lock.releaseWriterLock();
});

describe('the take in the bot process', () => {
  it("T2.f: a record of this boot at the child's start answers diskFlag with no attempt", async () => {
    const m = await bot();
    m.chain._setBootIdForTests('b1');
    m.chain.setDiskRole('web panel');
    m.chain.noteFolderSyncFailure(dataPath('global'), 'EIO');
    const record = JSON.parse(fs.readFileSync(path.join(snaps(), 'disk-error-b1.json'), 'utf8'));
    m.chain.resetFolderSyncFailureForTests();
    m.chain._setBootIdForTests('b1');
    m.chain.setDiskRole('bot');
    const answer = await m.take.takeSnapshot({ name: 'hourly-2026-11-13T04-00-00-000Z', kind: 'hourly' });
    expect(answer).toEqual({
      ok: false,
      diskFlag: { dir: '/data/global', errno: 'EIO', at: record.at, by: 'web panel', files: [path.join(snaps(), 'disk-error-b1.json')], unreadable: false },
    });
    expect(fs.readdirSync(snaps())).toEqual(['disk-error-b1.json']);
  });

  it("T4.f: the take's sync before its rename answering 'open' keeps nothing and sets no flag", async () => {
    const m = await bot();
    h.syncFolder = dir => (path.basename(dir) === 'data' ? Promise.resolve({ failed: true, kind: 'open', dir, errno: 'EMFILE', error: err('EMFILE') }) : null);
    const answer = await m.take.takeSnapshot({ name: 'hourly-2026-11-13T05-00-00-000Z', kind: 'hourly' });
    const staging = (answer as { error: string }).error.split(' could not be opened')[0];
    expect(answer).toEqual({
      ok: false,
      error: `${staging} could not be opened for its sync while the backup's folders were synced (EMFILE), so can't confirm the backup is on disk; the backup was not kept.`,
    });
    expect(staging).toMatch(/^\/data\/_snapshots\/\.taking-.+\/data$/);
    expect(m.chain.folderSyncFlag()).toBeNull();
    expect(fs.readdirSync(snaps())).toEqual([]);
  });
});

describe("the web UI's local take (T6)", () => {
  const stubOpen = (match: (target: string, flags: unknown) => boolean, code: string) => {
    const real = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, f: any, ...rest: any[]) => {
      if (match(path.resolve(String(p)), f)) throw err(code);
      return (real as any)(p, f, ...rest);
    }) as any);
  };

  function local(name: string, beforeTurn?: () => unknown) {
    while (localDepth() > 0) releaseLocal();
    fs.rmSync(localLockPath(), { force: true });
    configureWriterLock('webui', seams);
    setLocalTiming({ pollMs: 5, beforeTurn }, seams);
    return takeSnapshotLocal({ name, kind: 'hourly' }, new BotManager());
  }

  afterEach(() => {
    setLocalTiming();
    while (localDepth() > 0) releaseLocal();
  });

  it('T6.c: catch-ups end within the caps, the final op walks under the lock, and the snapshot is complete', async () => {
    const name = 'hourly-2026-11-13T06-00-00-000Z';
    const answer = await local(name);
    expect(answer).toMatchObject({ ok: true, name, counts: { files: 1, guilds: 1 } });
    expect(readSnapshot(name)).toMatchObject({ state: 'complete' });
    expect(fs.existsSync(localLockPath())).toBe(false);
  });

  it('T6.f: a read error removes the staging folder and fails with its text', async () => {
    stubOpen(target => target === path.resolve(dataPath('123', 'mod', 'a.json')), 'EIO');
    const answer = await local('hourly-2026-11-13T07-00-00-000Z');
    expect(answer).toEqual({ ok: false, error: 'Could not read /data/123/mod/a.json (EIO); the backup was not kept.' });
    expect(fs.readdirSync(snaps())).toEqual([]);
  });

  it("T6.f: the take's sync after the final op answering 'open' keeps nothing and sets no flag", async () => {
    h.syncFolder = dir => (path.basename(dir) === 'data' ? Promise.resolve({ failed: true, kind: 'open', dir, errno: 'EMFILE', error: err('EMFILE') }) : null);
    const answer = await local('hourly-2026-11-13T08-00-00-000Z');
    const staging = (answer as { error: string }).error.split(' could not be opened')[0];
    expect(answer).toEqual({
      ok: false,
      error: `${staging} could not be opened for its sync while the backup's folders were synced (EMFILE), so can't confirm the backup is on disk; the backup was not kept.`,
    });
    expect(staging).toMatch(/^\/data\/_snapshots\/\.taking-.+\/data$/);
    expect(folderSyncFlag()).toBeNull();
    expect(fs.readdirSync(snaps())).toEqual([]);
  });

  it('T6.d: ENOSPC on a copy removes the staging folder with the disk text', async () => {
    stubOpen((target, flags) => flags === 'wx' && target.startsWith(path.resolve(snaps())) && path.basename(target).startsWith('a.json.'), 'ENOSPC');
    const answer = await local('hourly-2026-11-13T09-00-00-000Z');
    expect(answer).toEqual({ ok: false, error: 'The disk filled up while the backup was copied (/data/123/mod/a.json); the partial copy was removed.' });
    expect(fs.readdirSync(snaps())).toEqual([]);
  });

  it('T6.w: a file another process replaced between the catch-ups and the final op is in the snapshot as replaced', async () => {
    const name = 'hourly-2026-11-13T10-00-00-000Z';
    const replaced = '{"a":2,"by":"import"}';
    const answer = await local(name, () => {
      fs.writeFileSync(dataPath('123', 'mod', 'a.json.new'), replaced);
      fs.renameSync(dataPath('123', 'mod', 'a.json.new'), dataPath('123', 'mod', 'a.json'));
    });
    expect(answer).toMatchObject({ ok: true, name });
    expect(fs.readFileSync(path.join(snaps(), name, 'data', '123', 'mod', 'a.json'), 'utf8')).toBe(replaced);
  });
});

describe('the restore (R3, R5, R6, R8)', () => {
  const NAME = 'hourly-2026-11-13T11-00-00-000Z';
  let restore: typeof import('../../src/webui/backups/restore');
  let state: typeof import('../../src/webui/backups/restoreState');
  let chain: typeof import('../../src/bot/internalSetup/utils/folderChain');
  const journalStage = (): string | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(snaps(), 'restore.json'), 'utf8')).stage;
    } catch {
      return null;
    }
  };
  const failed = (dir: string, errno: string, kind: 'sync' | 'open') => ({ failed: true, kind, dir, errno, error: err(errno) });

  beforeEach(async () => {
    restore = await import('../../src/webui/backups/restore');
    state = await import('../../src/webui/backups/restoreState');
    chain = await import('../../src/bot/internalSetup/utils/folderChain');
    state._resetRestoreStateForTests();
    while (localDepth() > 0) releaseLocal();
    fs.rmSync(localLockPath(), { force: true });
    configureWriterLock('webui', seams);
    setLocalTiming({ pollMs: 5 }, seams);
    expect(await takeSnapshotLocal({ name: NAME, kind: 'hourly' }, new BotManager())).toMatchObject({ ok: true });
    fs.writeFileSync(dataPath('123', 'mod', 'a.json'), '{"a":"new"}');
  });

  afterEach(async () => {
    await restore.restoreSettled();
    setLocalTiming();
    state._resetRestoreStateForTests();
    while (localDepth() > 0) releaseLocal();
  });

  async function restored(): Promise<Record<string, any>> {
    expect((await restore.postRestore(new BotManager(), NAME)).status).toBe(202);
    await restore.restoreSettled();
    return JSON.parse(fs.readFileSync(path.join(snaps(), 'restore.json'), 'utf8'));
  }

  it("R3.f: step 3's sync answering 'open' removes staging and ends failed with the copy cause's open form; no latch, no flag", async () => {
    h.syncFolder = dir => (dir.includes('.restore-') ? Promise.resolve(failed(dir, 'EMFILE', 'open')) : null);
    const j = await restored();
    expect(j.stage).toBe('failed');
    expect(j.error).toMatch(/^\/data\/_snapshots\/\.restore-.+ could not be opened for its sync while the copied backup was synced \(EMFILE\), so can't confirm the copy is on disk\.$/);
    expect(fs.existsSync(path.join(snaps(), j.staging))).toBe(false);
    expect(state.restoreLatch()).toBeNull();
    expect(chain.folderSyncFlag()).toBeNull();
    expect(fs.readFileSync(dataPath('123', 'mod', 'a.json'), 'utf8')).toBe('{"a":"new"}');
  });

  it("R5.f: the swapping record's own best-effort sync answers EIO: the write returns, the journal reads swapping, the latch is disk", async () => {
    let at = 0;
    h.syncFolderSync = dir => {
      if (path.resolve(dir) !== path.resolve(snaps()) || journalStage() !== 'swapping' || at) return null;
      at = Date.now();
      chain.noteFolderSyncFailure(dir, 'EIO');
      return failed(dir, 'EIO', 'sync');
    };
    const j = await restored();
    expect(j.stage).toBe('swapping');
    expect(fs.readFileSync(dataPath('123', 'mod', 'a.json'), 'utf8')).toBe('{"a":"new"}');
    const latch = state.restoreLatch()!;
    expect(latch).toMatchObject({ kind: 'disk', stage: 'swapping', errno: 'EIO' });
    expect(restore.latchLine(latch)).toBe(`The restore of ${NAME} stopped before any data was moved: the disk reported an error (EIO) when /data/_snapshots was synced at ${chain.timeText(at)}, so can't confirm the restore's record is on disk. The data is unchanged. Until the bot's container is restarted, nothing is moved, no change to the data is saved and the bot cannot be started. Check the disk, then restart the bot's container: the web panel then ends this restore as failed, with the data unchanged, or finishes it, when /data held no data, before it starts the bot; start the restore again if it ended failed.`);
  });

  it("R6.f: a flag set by the placing write's own folder sync: placing on disk, step 6 latches disk", async () => {
    let at = 0;
    h.syncFolderSync = dir => {
      if (path.resolve(dir) !== path.resolve(snaps()) || journalStage() !== 'placing' || at) return null;
      at = Date.now();
      chain.noteFolderSyncFailure(dir, 'EIO');
      return failed(dir, 'EIO', 'sync');
    };
    const j = await restored();
    expect(j.stage).toBe('placing');
    const latch = state.restoreLatch()!;
    expect(latch).toMatchObject({ kind: 'disk', stage: 'placing', errno: 'EIO' });
    expect(restore.latchLine(latch)).toBe(`The restore of ${NAME} stopped part way: the disk reported an error (EIO) when /data/_snapshots was synced at ${chain.timeText(at)}, so can't confirm the restore's moves are on disk. Until the bot's container is restarted, nothing more is moved, no change to the data is saved and the bot cannot be started. Check the disk, then restart the bot's container: the web panel syncs the folders again and finishes the restore when it starts, before it starts the bot. The data the restore replaced is in /data/_snapshots/.${j.preRestore}.`);
  });

  it("R8.f: step 8's sync answering 'open' latches fsync with its open text; nothing written", async () => {
    const j = await restored();
    expect(j.stage).toBe('placed');
    h.syncFolder = dir => (path.resolve(dir) === path.resolve(snaps()) ? Promise.resolve(failed(dir, 'EMFILE', 'open')) : null);
    expect(await restore.recordReplacedData()).toBe('latched');
    expect(JSON.parse(fs.readFileSync(path.join(snaps(), 'restore.json'), 'utf8'))).toEqual(j);
    const latch = state.restoreLatch()!;
    expect(latch).toMatchObject({ kind: 'fsync', stage: 'placed', open: true });
    expect(restore.latchLine(latch)).toBe(`Restored ${NAME} at ${chain.timeText(j.placedAt)}. The data it replaced is in /data/_snapshots/${j.preRestore}, but /data/_snapshots could not be opened for its sync (EMFILE) after that folder was renamed, so can't confirm its new name is on disk, and the restore's record was not finished. No other restore can start until the bot's container is restarted. After the restart the web panel syncs the folder again and finishes the record within a minute.`);
  });
});

describe('the prune (P1)', () => {
  const H = 60 * 60 * 1000;
  let scheduler: typeof import('../../src/webui/backups/scheduler');
  let state: typeof import('../../src/webui/backups/restoreState');
  let files: typeof import('../../src/webui/backups/state');
  let list: typeof import('../../src/bot/internalSetup/utils/backups/snapshotList');
  let names: typeof import('../../src/bot/internalSetup/utils/backups/snapshotNames');
  const now = Date.UTC(2026, 10, 13, 12, 30);

  beforeEach(async () => {
    scheduler = await import('../../src/webui/backups/scheduler');
    state = await import('../../src/webui/backups/restoreState');
    files = await import('../../src/webui/backups/state');
    list = await import('../../src/bot/internalSetup/utils/backups/snapshotList');
    names = await import('../../src/bot/internalSetup/utils/backups/snapshotNames');
    state._resetRestoreStateForTests();
    while (localDepth() > 0) releaseLocal();
    fs.rmSync(localLockPath(), { force: true });
    configureWriterLock('webui', seams);
    setLocalTiming({ pollMs: 5 }, seams);
  });
  afterEach(() => {
    setLocalTiming();
    state._resetRestoreStateForTests();
    while (localDepth() > 0) releaseLocal();
  });

  /** An old hourly and the newest, taken by the real local take, plus a `.delete-*` leftover and two `.tmp` files. */
  async function fixture(): Promise<{ old: string; newest: string }> {
    const m = new BotManager();
    const old = names.formatSnapshotName('hourly', now - 3 * 24 * H);
    const newest = names.formatSnapshotName('hourly', now - H);
    for (const name of [old, newest]) expect(await takeSnapshotLocal({ name, kind: 'hourly' }, m)).toMatchObject({ ok: true });
    fs.mkdirSync(path.join(snaps(), '.delete-hourly-x', 'data'), { recursive: true });
    fs.writeFileSync(path.join(snaps(), 'state.json.123.tmp'), 'x');
    fs.utimesSync(path.join(snaps(), 'state.json.123.tmp'), new Date(now - 2 * H), new Date(now - 2 * H));
    fs.writeFileSync(path.join(snaps(), 'state.json.456.tmp'), 'x');
    fs.utimesSync(path.join(snaps(), 'state.json.456.tmp'), new Date(now - 10 * 60_000), new Date(now - 10 * 60_000));
    return { old, newest };
  }

  it('P1.c: each removal renamed to .delete-* then removed; the leftovers and the old .tmp go, the newest stays', async () => {
    const { old, newest } = await fixture();
    const renames: string[] = [];
    const real = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      renames.push(`${path.basename(String(from))} -> ${path.basename(String(to))}`);
      return real(from, to);
    }) as typeof fs.renameSync);
    syncBuiltinESMExports();
    await scheduler.prune(now, await list.listSnapshots(), files.defaultState());
    spy.mockRestore();
    syncBuiltinESMExports();
    expect(renames).toEqual([`${old} -> .delete-${old}`]);
    expect(fs.readdirSync(snaps()).sort()).toEqual([newest, 'state.json.456.tmp']);
  });

  it.each([
    ['running', () => state.setRestoreOp({ kind: 'restore', name: 'hourly-x' })],
    ['stuck', () => files.writeRestoreJournal({ format: 1, name: 'hourly-x', startedAt: 1, stage: 'stuck', staging: '.restore-x', preRestore: 'pre-restore-x', stuckAt: 'placing', cause: 'rename', path: '/data/123', errno: 'EIO' })],
    ['unfinished', () => files.writeRestoreJournal({ format: 1, name: 'hourly-x', startedAt: 1, stage: 'placing', staging: '.restore-x', preRestore: 'pre-restore-x' })],
    ['unknown', () => fs.writeFileSync(path.join(snaps(), 'restore.json'), '{')],
  ] as Array<[string, () => void]>)('P1.w: the gate %s: the prune removes nothing', async (_t, close) => {
    const { old, newest } = await fixture();
    close();
    await scheduler.prune(now, await list.listSnapshots(), files.defaultState());
    expect(fs.readdirSync(snaps()).filter(n => n !== 'restore.json').sort()).toEqual(['.delete-hourly-x', newest, old, 'state.json.123.tmp', 'state.json.456.tmp'].sort());
  });

  it('P1.w: a POST between two removals stops the prune before the next', async () => {
    const { old, newest } = await fixture();
    const real = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, 'rm').mockImplementation((async (p: fs.PathLike, o?: fs.RmOptions) => {
      await real(p, o);
      state.setRestoreOp({ kind: 'restore', name: newest });
    }) as typeof fs.promises.rm);
    await scheduler.prune(now, await list.listSnapshots(), files.defaultState());
    expect(fs.readdirSync(snaps()).sort()).toEqual(['.delete-hourly-x', newest, 'state.json.123.tmp', 'state.json.456.tmp'].sort());
    expect(fs.existsSync(path.join(snaps(), old))).toBe(false);
  });

  it("P1.w: a failed journal's leftover .restore-<t> is kept, an older unnamed one removed", async () => {
    await fixture();
    const kept = names.restoreFolderName(now - 2 * H);
    const gone = names.restoreFolderName(now - 3 * H);
    for (const n of [kept, gone]) fs.mkdirSync(path.join(snaps(), n, 'data'), { recursive: true });
    files.writeRestoreJournal({ format: 1, name: 'hourly-x', startedAt: 1, stage: 'failed', staging: kept, preRestore: 'pre-restore-x', leftover: { path: `/data/_snapshots/${kept}`, errno: 'EBUSY' } });
    await scheduler.prune(now, await list.listSnapshots(), files.defaultState());
    expect(fs.existsSync(path.join(snaps(), kept))).toBe(true);
    expect(fs.existsSync(path.join(snaps(), gone))).toBe(false);
  });
});
