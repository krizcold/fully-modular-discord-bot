import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB8 test 12 (decisions 11, 25, 27 to 29, 34, 35, 48, 51, 54 to 56, 62, 65, 68, 70, 72, 73, C13, C19, C20, N5, B1 and
// B2 of code review 2): the POST's restore through postRestore() with a real BotManager (forkMock children), the real
// writer lock and journal under the test's data folder, and a snapshot taken by the real local take. Folder syncs pass
// through a folderChain mock that records them and can answer 'sync' or 'open'; renames are recorded by a spy.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
const h = vi.hoisted(() => ({
  order: [] as string[],
  root: '',
  sync: null as null | ((dir: string) => unknown),
  hold: null as null | Promise<void>,
  holdAt: null as null | ((dir: string) => Promise<void> | null),
}));
vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolder: async (dir: string) => {
      h.order.push(`sync ${h.root ? path.relative(h.root, dir).split(path.sep).join('/') : dir}`);
      if (h.hold) await h.hold;
      const wait = h.holdAt?.(dir);
      if (wait) await wait;
      const answer = h.sync?.(dir);
      return answer ?? real.syncFolder(dir);
    },
  };
});
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<any>();
  return { ...real, forgetSharedFileKnowledge: () => { h.order.push('forget'); real.forgetSharedFileKnowledge(); } };
});

import { BotManager } from '../../src/webui/botManager';
import { EXIT_DEPOSED } from '../../src/bot/internalSetup/utils/dataManager';
import { postRestore, recordReplacedData, restoreSettled, restoreView, _setRestoreTimingForTests } from '../../src/webui/backups/restore';
import { _resetRestoreStateForTests, restoreLatch, restoreOp, setBackupWorkRunning } from '../../src/webui/backups/restoreState';
import { writeRestoreJournal } from '../../src/webui/backups/state';
import { readRestoreJournal, restoreJournalPath, type RestoreJournal } from '../../src/bot/internalSetup/utils/backups/restoreJournal';
import { listSnapshots, readSnapshot, snapshotsRoot } from '../../src/bot/internalSetup/utils/backups/snapshotList';
import { _setTakeTimingForTests, takeSnapshotLocal } from '../../src/bot/internalSetup/utils/backups/snapshotTake';
import { _setBootIdForTests, noteFolderSyncFailure, setDiskRole, timeText } from '../../src/bot/internalSetup/utils/folderChain';
import { releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { forks, forkStage } from '../helpers/forkMock';
import { exitChild, freshWriterLock, logged, resetForks, tick } from '../helpers/nb10Rig';

const seams = { pid: () => process.pid, alive: () => true, startOf: (pid: number) => `start-${pid}`, now: () => Date.now() };
const NAME = 'hourly-2026-11-13T04-00-00-000Z';
const err = (code: string) => Object.assign(new Error(`${code}: stubbed`), { code });
const syncFailed = (code: string, kind: 'sync' | 'open' = 'sync') => (dir: string) => ({ failed: true, kind, dir, errno: code, error: err(code) });
const OLD = { '123/mod/a.json': '{"v":"old"}', '456/m/b.json': '{"b":"old"}', 'global/mod/x.json': '{"x":"old"}', 'owner-channel.json': '{"c":"old"}' };
const NEW = { '123/mod/a.json': '{"v":"new!"}', '789/m/c.json': '{"c":1}', 'global/mod/x.json': '{"x":"new"}' };

let managers: BotManager[] = [];
let errors: ReturnType<typeof vi.spyOn>;
let warns: ReturnType<typeof vi.spyOn>;
let logs: ReturnType<typeof vi.spyOn>;

function fresh(): BotManager {
  const m = new BotManager();
  managers.push(m);
  return m;
}

function clearLive(): void {
  for (const e of fs.readdirSync(dataPath())) if (e !== '_snapshots') fs.rmSync(dataPath(e), { recursive: true, force: true });
}

function writeTree(files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(dataPath(rel)), { recursive: true });
    fs.writeFileSync(dataPath(rel), text);
  }
}

/** The files under a root, by POSIX path, with work files and the lock left out. */
function tree(root: string = dataPath()): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && (e.name === '_snapshots' || e.name.startsWith('.') || e.name === 'maintenance.json')) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out[r] = fs.readFileSync(path.join(dir, e.name), 'utf8');
    }
  };
  walk(root, '');
  return out;
}

/** A snapshot of OLD taken by the real local take, then the live data set to NEW. */
async function snapshot(name = NAME): Promise<string> {
  clearLive();
  writeTree(OLD);
  const answer = await takeSnapshotLocal({ name, kind: 'hourly' }, fresh());
  expect(answer).toMatchObject({ ok: true });
  clearLive();
  writeTree(NEW);
  return name;
}

/** Records renames under the data root and the stage of each journal written. */
function recordRenames(fail?: (from: string, to: string, stage: string | null) => string | null): void {
  const real = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    const rel = (p: fs.PathLike) => path.relative(dataPath(), String(p)).split(path.sep).join('/');
    const stage = String(to) === restoreJournalPath() ? (JSON.parse(fs.readFileSync(from, 'utf8')).stage as string) : null;
    const code = fail?.(rel(from), rel(to), stage);
    if (code) throw err(code);
    h.order.push(stage ? `journal ${stage}` : `rename ${rel(from)} -> ${rel(to)}`);
    return real(from, to);
  }) as typeof fs.renameSync);
  syncBuiltinESMExports();
}

const journal = (): RestoreJournal => {
  const read = readRestoreJournal();
  if (read.state !== 'read') throw new Error(`no journal: ${read.state}`);
  return read.journal;
};

async function settle(): Promise<void> {
  await restoreSettled();
}

const lines = (): string[] => [...logged(logs), ...logged(warns), ...logged(errors)];

async function startedChild(m: BotManager): Promise<any> {
  const result = await m.start();
  expect(result.success).toBe(true);
  await tick(5);
  return forks.children.at(-1);
}

/**
 * A fake child that exits `ms` after its first stop signal, as Node reports a forked child: 'exit', then its channel's
 * close ('disconnect', `connected` false). `before` runs before its exit, `between` after it and before the close.
 */
function exitsOnStop(child: any, ms: number, at: { before?: () => void; between?: () => void } = {}): void {
  child.connected = true;
  child.kill = vi.fn((signal: string) => {
    child.signals.push(signal);
    child.killed = true;
    if (child.signals.length === 1) {
      setTimeout(() => {
        at.before?.();
        child.exitCode = 0;
        child.emit('exit', 0, null);
        at.between?.();
        child.connected = false;
        child.emit('disconnect');
      }, ms);
    }
    return true;
  });
}

/** A standby the current child asks for, forked by NB9's reshard path. */
async function standbyOf(m: BotManager, child: any): Promise<any> {
  m.noteMemoryReading({ room: true, useMb: 300, freeMb: 900, at: new Date().toISOString() });
  child.emit('message', { type: 'control:reshard-standby', data: { attempt: 'a-1', to: 8, intents: 513, maxConcurrency: 1, json: true } });
  await tick(5);
  const standby = forks.children.at(-1);
  expect(standby).not.toBe(child);
  return standby;
}

beforeEach(() => {
  for (const e of fs.readdirSync(dataPath())) fs.rmSync(dataPath(e), { recursive: true, force: true });
  resetForks();
  forkStage.stages = ['shared', 'guild'];
  freshWriterLock('webui');
  _setTakeTimingForTests({ pollMs: 5 }, seams);
  _setRestoreTimingForTests({ stopMs: 2000 });
  _resetRestoreStateForTests();
  h.order = [];
  h.root = dataPath();
  h.sync = null;
  h.hold = null;
  h.holdAt = null;
  logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  managers = [];
});

afterEach(async () => {
  await restoreSettled();
  vi.useRealTimers();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  setBackendKind(null);
  for (const m of managers) m.cancelCrashRestart();
  for (const child of forks.children) if (child.exitCode === null && child.signalCode === null) exitChild(child, 0);
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  _setTakeTimingForTests();
  _setRestoreTimingForTests();
  _resetRestoreStateForTests();
});

describe('a whole restore', () => {
  it('places the snapshot, keeps the replaced data as a complete pre-restore backup, and syncs in order', async () => {
    const name = await snapshot();
    const m = fresh();
    recordRenames();
    h.order = [];
    expect(await postRestore(m, name)).toEqual({ status: 202, body: { success: true, state: 'started', name } });
    expect(restoreOp()).toMatchObject({ kind: 'restore', name });
    await settle();

    const placed = journal();
    expect(placed).toMatchObject({ stage: 'placed', name });
    expect(restoreOp()).toBeNull();
    expect(restoreLatch()).toBeNull();
    expect(tree()).toEqual(OLD);
    expect(fs.existsSync(dataPath('_snapshots', placed.staging))).toBe(false);

    // The swapping record, one sync of _snapshots, then phase A's first rename (decision 55).
    const swap = h.order.indexOf('journal swapping');
    expect(h.order[swap + 1]).toBe('sync _snapshots');
    expect(h.order[swap + 2]).toMatch(/^rename \d+|^rename global|^rename owner/);
    // Every live unit moved aside before placing, the knowledge dropped after phase B, before placed.
    const placing = h.order.indexOf('journal placing');
    expect(h.order.slice(swap, placing).filter(x => x.startsWith('rename ') && x.includes('-> _snapshots/.pre-restore-'))).toHaveLength(Object.keys(NEW).length);
    expect(h.order.lastIndexOf('forget')).toBeGreaterThan(placing);
    expect(h.order.lastIndexOf('forget')).toBeLessThan(h.order.indexOf('journal placed'));

    // Step 8 at the tick: hash, manifest, rename, one sync of _snapshots, then done.
    h.order = [];
    expect(await recordReplacedData()).toBe('done');
    expect(h.order).toEqual([expect.stringMatching(new RegExp(`^rename _snapshots/\.${placed.preRestore}/manifest\.json\..+\.tmp -> _snapshots/\.${placed.preRestore}/manifest\.json$`)), `rename _snapshots/.${placed.preRestore} -> _snapshots/${placed.preRestore}`, 'sync _snapshots', 'journal done']);
    expect(journal()).toMatchObject({ stage: 'done', result: 'done' });
    const pre = readSnapshot(placed.preRestore);
    expect(pre).toMatchObject({ state: 'complete', kind: 'pre-restore' });
    expect(tree(dataPath('_snapshots', placed.preRestore, 'data'))).toEqual(NEW);
    expect((await listSnapshots()).map(s => s.name)).toContain(placed.preRestore);
  });

  it('a rerun of step 8 that finds the pre-restore backup complete syncs, then writes done only', async () => {
    const name = await snapshot();
    await postRestore(fresh(), name);
    await settle();
    const placed = journal();
    const real = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === restoreJournalPath()) {
        throw err('EIO');
      }
      return real(from, to);
    }) as typeof fs.renameSync);
    syncBuiltinESMExports();
    expect(await recordReplacedData()).toBe('latched');
    expect(journal().stage).toBe('placed');
    expect(readSnapshot(placed.preRestore).state).toBe('complete');
    spy.mockRestore();
    _resetRestoreStateForTests();
    recordRenames();
    h.order = [];
    expect(await recordReplacedData()).toBe('done');
    expect(h.order).toEqual(['sync _snapshots', 'journal done']);
  });
});

describe("the POST's first turn (decisions 25, 51, C14, C19, C20)", () => {
  const nothingWritten = () => {
    expect(fs.existsSync(restoreJournalPath())).toBe(false);
    expect(fs.readdirSync(dataPath('_snapshots')).filter(n => n.startsWith('.restore-'))).toEqual([]);
    expect(restoreOp()).toBeNull();
  };

  it('answers 404 for a name with no complete backup', async () => {
    await snapshot();
    expect(await postRestore(fresh(), 'hourly-2020-01-01T00-00-00-000Z')).toEqual({ status: 404, body: { success: false, error: 'No complete backup is named hourly-2020-01-01T00-00-00-000Z.' } });
    nothingWritten();
  });

  it('names the format of a backup this version cannot read', async () => {
    const name = await snapshot();
    const file = dataPath('_snapshots', name, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), format: 2 }));
    expect(await postRestore(fresh(), name)).toEqual({ status: 409, body: { success: false, error: `The backup ${name} was written in a format this version cannot read (2).` } });
    nothingWritten();
  });

  it('refuses a running bot that is not in maintenance', async () => {
    const name = await snapshot();
    const m = fresh();
    await startedChild(m);
    expect(await postRestore(m, name)).toEqual({ status: 409, body: { success: false, error: 'Stop the bot, or put it in maintenance, before a restore: a running bot would keep writing the data the restore replaces.' } });
    nothingWritten();
  });

  it.each([
    ['take', 'A backup is being taken now; start the restore once it has finished.'],
    ['test', 'The daily test restore of a backup is running; start the restore once it has finished.'],
  ] as const)('refuses while a %s runs', async (work, text) => {
    const name = await snapshot();
    setBackupWorkRunning(work);
    expect(await postRestore(fresh(), name)).toEqual({ status: 409, body: { success: false, error: text } });
    nothingWritten();
  });

  it('refuses on a Postgres bot', async () => {
    const name = await snapshot();
    setBackendKind('postgres');
    expect(await postRestore(fresh(), name)).toEqual({ status: 409, body: { success: false, error: 'This bot keeps its data in Postgres; restore its database in the Bot Manager.' } });
    nothingWritten();
  });

  it('refuses while a data migration runs', async () => {
    const name = await snapshot();
    const m = fresh();
    m.takeMigrationLock({ jobId: 'j1', to: 'postgres' });
    expect(await postRestore(m, name)).toEqual({ status: 409, body: { success: false, error: 'A data migration is running or unfinished; restore once it has finished.' } });
    m.releaseMigrationLock();
    nothingWritten();
  });

  it("refuses while this boot's disk error record stands, naming the machine's restart (C20, B6)", async () => {
    const name = await snapshot();
    _setBootIdForTests('b1');
    setDiskRole('web panel');
    const at = Date.now();
    noteFolderSyncFailure(dataPath('123'), 'EIO');
    expect(await postRestore(fresh(), name)).toEqual({ status: 409, body: { success: false, error:
      `The data disk reported an error when /data/123 was synced at ${timeText(at)} (EIO), so can't confirm earlier changes are on disk. No restore can start until the machine the bot runs on is restarted (a restart of the bot's container is not enough after a disk error); check the disk first.` } });
    nothingWritten();
  });

  it.each([
    ["a take's last pass", () => setBackupWorkRunning('take')],
    ['a placed journal with no note', () => writeRestoreJournal({ format: 1, name: 'X', startedAt: 1, stage: 'placed', staging: '.restore-t', preRestore: 'pre-restore-t', placedAt: 2 } as RestoreJournal)],
  ] as const)("a standing disk record answers C20's refusal during %s (code review 3, A3)", async (_row, set) => {
    const name = await snapshot();
    set();
    _setBootIdForTests('b1');
    setDiskRole('web panel');
    const at = Date.now();
    noteFolderSyncFailure(dataPath('123'), 'EIO');
    expect(await postRestore(fresh(), name)).toEqual({ status: 409, body: { success: false, error:
      `The data disk reported an error when /data/123 was synced at ${timeText(at)} (EIO), so can't confirm earlier changes are on disk. No restore can start until the machine the bot runs on is restarted (a restart of the bot's container is not enough after a disk error); check the disk first.` } });
    expect(restoreOp()).toBeNull();
  });

  it('answers 202 running with the running op while one runs, and 409 with the placed text after it', async () => {
    const name = await snapshot();
    const m = fresh();
    let release!: () => void;
    h.hold = new Promise(resolve => { release = resolve; });
    expect((await postRestore(m, name)).status).toBe(202);
    expect(await postRestore(m, name)).toEqual({ status: 202, body: { success: true, state: 'running', name, note: `A restore of ${name} is already running.` } });
    release();
    h.hold = null;
    await settle();
    expect(await postRestore(m, name)).toEqual({ status: 409, body: { success: false, error: 'The last restore is still recording the data it replaced; try again in a minute.' } });
  });

  it.each([
    ['unfinished at staged', { stage: 'staged' }, "The restore of X did not finish (/data/_snapshots/restore.json says staged), and no restore runs now; no data was moved. The bot does not start until it ends. Restart the bot's container: the web panel then ends this restore as failed, with the data unchanged, before it starts the bot; start the restore again after that."],
    ['unfinished at swapping', { stage: 'swapping' }, "The restore of X did not finish (/data/_snapshots/restore.json says swapping), and no restore runs now. The bot does not start until it ends. Restart the bot's container: the web panel finishes the restore when it starts, or ends it failed with the data unchanged if no data had been moved yet, or finishes it, when /data held no data, before it starts the bot."],
    ['unfinished at placing', { stage: 'placing' }, "The restore of X did not finish (/data/_snapshots/restore.json says placing), and no restore runs now. The bot does not start until it finishes. Restart the bot's container: the web panel finishes the restore when it starts, before it starts the bot."],
    ['stuck, rename at placing', { stage: 'stuck', stuckAt: 'placing', cause: 'rename', path: '123', errno: 'EACCES' }, "The restore of X stopped part way: /data/123 could not be moved (EACCES). The bot does not start until the restore finishes. Fix the cause, then restart the bot's container: the web panel finishes the restore when it starts, before it starts the bot. The data the restore replaced is in /data/_snapshots/.pre-restore-t."],
    ['stuck, rename at swapping', { stage: 'stuck', stuckAt: 'swapping', cause: 'rename', path: '123', errno: 'EACCES' }, "The restore of X stopped part way: /data/123 could not be moved (EACCES). The bot does not start until the restore ends. Fix the cause, then restart the bot's container: the web panel finishes the restore when it starts, or ends it failed with the data unchanged if no data had been moved yet, before it starts the bot. Any data the restore had moved is in /data/_snapshots/.pre-restore-t."],
    ['stuck, in the way', { stage: 'stuck', stuckAt: 'placing', cause: 'in-the-way', path: '123', aside: [] }, "The restore of X stopped part way: /data/123 exists where the backup's copy must go. The bot does not start until the restore finishes. Move /data/123 out of /data (keep it if you need it), then restart the bot's container: the web panel finishes the restore when it starts, before it starts the bot. The data the restore replaced is in /data/_snapshots/.pre-restore-t."],
    ['stuck, in the way, an aside item not aside', { stage: 'stuck', stuckAt: 'placing', cause: 'in-the-way', path: '123', aside: ['123'] }, "The restore of X stopped part way: /data/123 exists where the backup's copy must go. The bot does not start until the restore finishes. Move /data/123 out of /data (keep it if you need it), then restart the bot's container: the web panel finishes the restore when it starts, before it starts the bot. /data/123 may be the data this restore was replacing: it is not in /data/_snapshots/.pre-restore-t, so keep it."],
    ['placed with a read note', { stage: 'placed', note: { cause: 'read', path: '/data/_snapshots/.pre-restore-t/data/123/a.json', errno: 'EACCES' } }, 'The last restore cannot record the data it replaced: /data/_snapshots/.pre-restore-t/data/123/a.json cannot be read (EACCES). No other restore can start until it can; the Dashboard tab says what to do.'],
    ['placed with a manifest note', { stage: 'placed', note: { cause: 'manifest', errno: 'ENOSPC' } }, 'The last restore is still recording the data it replaced (ENOSPC); it is tried again every minute, and a restore can start once it is recorded.'],
  ] as const)('answers 409 for a journal %s', async (_row, fields, text) => {
    writeRestoreJournal({ format: 1, name: 'X', startedAt: 1, staging: '.restore-t', preRestore: 'pre-restore-t', ...fields } as RestoreJournal);
    expect(await postRestore(fresh(), NAME)).toEqual({ status: 409, body: { success: false, error: text } });
  });

  it('answers the can\'t-confirm text for a journal that cannot be read', async () => {
    fs.mkdirSync(dataPath('_snapshots'), { recursive: true });
    fs.writeFileSync(restoreJournalPath(), '{"format":1');
    expect(await postRestore(fresh(), NAME)).toEqual({ status: 409, body: { success: false, error: "can't confirm the state of the last backup restore: /data/_snapshots/restore.json cannot be read (not valid JSON). The bot does not start until it can be read; if no restore ran, remove that file." } });
  });
});

describe('a maintenance child (decisions 11, 29, 51, 56)', () => {
  async function maintenanceChild(m: BotManager): Promise<any> {
    writeMaintenanceFile('maintenance', 'restoring');
    return startedChild(m);
  }

  it('is stopped for the restore and started again once the data is placed', async () => {
    const name = await snapshot();
    const m = fresh();
    const child = await maintenanceChild(m);
    expect((await postRestore(m, name)).status).toBe(202);
    await settle();
    expect(child.signals).toEqual(['SIGTERM']);
    expect(journal().stage).toBe('placed');
    expect(forks.children).toHaveLength(2);
    expect(m.isRunning()).toBe(true);
    expect(lines()).toContain(`[Backup] Restore of ${name}: started the bot again`);
  });

  it('a lock left naming the stopped child fails the restore before any move and starts the child again', async () => {
    const name = await snapshot();
    const m = fresh();
    const child = await maintenanceChild(m);
    child.kill = vi.fn((signal: string) => {
      child.signals.push(signal);
      fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: child.pid, start: null, role: 'bot', at: Date.now() }));
      setTimeout(() => exitChild(child, 0), 5);
      return true;
    });
    await postRestore(m, name);
    await settle();
    expect(journal()).toMatchObject({ stage: 'failed', error: "The bot stopped while changes were still being written to disk, so can't confirm they were saved; check the bot's log and the disk, then try again." });
    expect(tree()).toEqual(NEW);
    expect(fs.existsSync(dataPath('_snapshots', journal().staging))).toBe(false);
    expect(forks.children).toHaveLength(2);
  });

  it('a killed child that left the lock fails with the killed cause', async () => {
    const name = await snapshot();
    const m = fresh();
    const child = await maintenanceChild(m);
    vi.spyOn(m, 'shutdown').mockImplementation(async () => {
      fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: child.pid, start: null, role: 'bot', at: Date.now() }));
      exitChild(child, null);
      return { killed: true };
    });
    await postRestore(m, name);
    await settle();
    expect(journal()).toMatchObject({ stage: 'failed', error: "The bot did not stop within 40 seconds and was killed, so can't confirm it saved every change; check its log, then try again." });
    expect(tree()).toEqual(NEW);
  });

  it("a POST while the op's own start runs after placed answers 202 running; after it, the placed text", async () => {
    const name = await snapshot();
    const m = fresh();
    await maintenanceChild(m);
    const realStart = m.start.bind(m);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let ownStart = false;
    vi.spyOn(m, 'start').mockImplementation(async opts => {
      if (opts?.restoreOp) {
        ownStart = true;
        await gate;
      }
      return realStart(opts);
    });
    await postRestore(m, name);
    await vi.waitFor(() => expect(ownStart).toBe(true), { timeout: 5000, interval: 5 });
    expect(journal().stage).toBe('placed');
    expect((await postRestore(fresh(), name)).body).toMatchObject({ state: 'running', name });
    release();
    await settle();
    expect(restoreOp()).toBeNull();
    expect((await postRestore(fresh(), name)).body.error).toBe('The last restore is still recording the data it replaced; try again in a minute.');
  });

  it("a child that emits 'error' and then 'exit' answers gone after its exit, and the restore goes on (code review 2, B1)", async () => {
    const name = await snapshot();
    const m = fresh();
    const child = await maintenanceChild(m);
    vi.spyOn(m, 'shutdown').mockImplementation(async () => {
      child.emit('error', err('EPIPE'));
      setTimeout(() => exitChild(child, 1), 50);
      return { killed: false };
    });
    await postRestore(m, name);
    await settle();
    expect(journal().stage).toBe('placed');
    expect(tree()).toEqual(OLD);
  });

  it("a child that emits 'error' while it keeps running answers running until it exits: failed at 60 s (code review 2, B1)", async () => {
    const name = await snapshot();
    _setRestoreTimingForTests({ stopMs: 300 });
    const m = fresh();
    const child = await maintenanceChild(m);
    vi.spyOn(m, 'shutdown').mockImplementation(async () => {
      child.emit('error', err('ESRCH'));
      return { killed: false };
    });
    await postRestore(m, name);
    await settle();
    expect(child.exitCode).toBeNull();
    expect(journal()).toMatchObject({ stage: 'failed', error: 'The bot did not stop within 60 seconds.' });
    expect(tree()).toEqual(NEW);
  });

  it("a lock take refused by a bot process this web panel started gives C19's cause (code review 2, B2)", async () => {
    const name = await snapshot();
    const m = fresh();
    vi.spyOn(m, 'runRestoreOp').mockResolvedValue({ taken: false, take: { kind: 'previous', pid: 2001 } });
    await postRestore(m, name);
    await settle();
    expect(journal()).toMatchObject({ stage: 'failed', error: 'Another process holds the data files (a bot process this web panel started, pid 2001).' });
    expect(tree()).toEqual(NEW);
  });

  it("a lock held by a data bundle import fails with decision 31's held cause", async () => {
    const name = await snapshot();
    freshWriterLock('webui', new Set([process.pid, 4242]));
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 4242, start: null, role: 'import', at: Date.now() }));
    const m = fresh();
    await postRestore(m, name);
    await settle();
    expect(journal()).toMatchObject({ stage: 'failed', error: 'Another process holds the data files (a data bundle import, pid 4242).' });
    expect(tree()).toEqual(NEW);
  });

  it('a standby alive at step 4 is stopped and waited for before the swapping record (C19)', async () => {
    const name = await snapshot();
    const m = fresh();
    const child = await maintenanceChild(m);
    const standby = await standbyOf(m, child);
    exitsOnStop(standby, 300);
    let goneAtSwap: boolean | null = null;
    recordRenames((_f, _t, s) => {
      if (s === 'swapping') goneAtSwap = standby.exitCode !== null && standby.connected === false;
      return null;
    });
    expect((await postRestore(m, name)).status).toBe(202);
    await settle();
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(goneAtSwap).toBe(true);
    expect(journal().stage).toBe('placed');
    expect(tree()).toEqual(OLD);
  });

  it("a standby that outlives step 4's wait fails the restore with the did-not-stop text, the data unchanged (C19)", async () => {
    const name = await snapshot();
    _setRestoreTimingForTests({ stopMs: 300 });
    const m = fresh();
    const child = await maintenanceChild(m);
    const standby = await standbyOf(m, child);
    standby.connected = true;
    standby.kill = vi.fn((signal: string) => {
      standby.signals.push(signal);
      standby.killed = true;
      return true;
    });
    await postRestore(m, name);
    await settle();
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(standby.exitCode).toBeNull();
    expect(journal()).toMatchObject({ stage: 'failed', error: 'The bot did not stop within 60 seconds.' });
    expect(tree()).toEqual(NEW);
  });

  it('with no running child and a crash timer pending, step 4 calls no shutdown(); the refused timer start sets stopped and the op starts the bot (C19)', async () => {
    const name = await snapshot();
    const m = fresh();
    const child = await startedChild(m);
    exitChild(child, 1);
    await tick(5);
    expect(m.isRunning()).toBe(false);
    const shutdown = vi.spyOn(m, 'shutdown');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let swapped = false;
    recordRenames((_f, _t, s) => { if (s === 'swapping') swapped = true; return null; });
    h.holdAt = dir => (swapped && dir === dataPath('_snapshots') ? held : null);
    expect((await postRestore(m, name)).status).toBe(202);
    await vi.waitFor(() => expect(restoreOp()?.stopped).toBe(true), { timeout: 8000, interval: 20 });
    expect(forks.children).toHaveLength(1);
    expect(journal().stage).toBe('swapping');
    release();
    await settle();
    expect(shutdown).not.toHaveBeenCalled();
    expect(journal().stage).toBe('placed');
    expect(forks.children).toHaveLength(2);
    expect(m.isRunning()).toBe(true);
  }, 15_000);

  it('runRestoreOp with a standby that has not exited answers previous with its pid and runs nothing (C19)', async () => {
    const m = fresh();
    const child = await startedChild(m);
    const standby = await standbyOf(m, child);
    standby.connected = true;
    standby.kill = vi.fn((signal: string) => {
      standby.signals.push(signal);
      standby.killed = true;
      return true;
    });
    await m.shutdown(false);
    expect(m.isRunning()).toBe(false);
    expect(standby.exitCode).toBeNull();
    let ran = false;
    const answer = await m.runRestoreOp(async () => { ran = true; });
    expect(answer).toEqual({ taken: false, take: { kind: 'previous', pid: standby.pid } });
    expect(ran).toBe(false);
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });

  it.each([
    ['before its exit', 'before'],
    ["after its exit, before its channel closed", 'between'],
  ] as const)("a disk error the child reports %s fails step 4 with C20's bot cause, and the op starts the bot again (E2)", async (_when, point) => {
    const name = await snapshot();
    _setBootIdForTests('b1');
    setDiskRole('web panel');
    const m = fresh();
    const child = await maintenanceChild(m);
    const report = () => child.emit('message', { type: 'disk:folder-sync-failed', data: { dir: '/data/123', errno: 'EIO', at: Date.now() } });
    exitsOnStop(child, 20, { [point]: report });
    await postRestore(m, name);
    await settle();
    expect(journal()).toMatchObject({ stage: 'failed', error: "The disk reported an error when /data/123 was synced (EIO) before the restore moved any data, so can't confirm the bot's last changes are on disk; check the disk, then restart the machine the bot runs on (a restart of the bot's container is not enough after a disk error) before you try again." });
    expect(tree()).toEqual(NEW);
    expect(forks.children).toHaveLength(2);
    expect(lines()).toContain(`[Backup] Restore of ${name}: started the bot again`);
  });
});

describe('step 3 (decisions 35, 51, 70, N5)', () => {
  it('a copy that differs from its manifest fails before phase A, with staging removed first', async () => {
    const name = await snapshot();
    fs.writeFileSync(dataPath('_snapshots', name, 'data', '123', 'mod', 'a.json'), '{"v":"bad"}');
    recordRenames();
    const rm = vi.spyOn(fs.promises, 'rm');
    await postRestore(fresh(), name);
    await settle();
    expect(journal()).toMatchObject({ stage: 'failed', error: 'The copy differs from what was recorded when the backup was taken: 1 difference, first 123/mod/a.json (content).' });
    expect(tree()).toEqual(NEW);
    expect(rm).toHaveBeenCalled();
    expect(h.order.filter(x => x.startsWith('rename '))).toEqual([]);
    expect(restoreLatch()).toBeNull();
  });

  it("a sync error fails the restore with decision 70's cause and no latch; the next POST runs", async () => {
    const name = await snapshot();
    h.sync = dir => (dir.includes('.restore-') ? syncFailed('EIO')(dir) : null);
    await postRestore(fresh(), name);
    await settle();
    const failed = journal();
    expect(failed.stage).toBe('failed');
    expect(failed.error).toMatch(/^The disk reported an error while the copied backup was synced \(\/data\/_snapshots\/\.restore-[^:]+: EIO\), so can't confirm the copy is on disk\.$/);
    expect(restoreLatch()).toBeNull();
    h.sync = null;
    expect((await postRestore(fresh(), name)).status).toBe(202);
    await settle();
    expect(journal().stage).toBe('placed');
  });

  it("the disk flag set by another write during the copy fails it with N5's cause", async () => {
    const name = await snapshot();
    const at = Date.now();
    h.sync = dir => {
      if (dir.includes('.restore-')) noteFolderSyncFailure(dataPath('global'), 'EIO');
      return null;
    };
    await postRestore(fresh(), name);
    await settle();
    expect(journal()).toMatchObject({ stage: 'failed', error: `The disk reported an error when /data/global was synced at ${timeText(at)} (EIO), so can't confirm the copy is on disk.` });
    expect(restoreLatch()).toBeNull();
  });

  it('a manifest whose counts alone differ fails with the counts text (fix 11b, decision 3)', async () => {
    const name = await snapshot();
    const file = dataPath('_snapshots', name, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const files = manifest.counts.files;
    manifest.counts.files += 1;
    fs.writeFileSync(file, JSON.stringify(manifest));
    await postRestore(fresh(), name);
    await settle();
    expect(journal()).toMatchObject({ stage: 'failed', error: `The copy differs from what was recorded when the backup was taken: 1 count differs, first the number of files (${files} found, ${files + 1} recorded).` });
    expect(tree()).toEqual(NEW);
  });

  it('ENOSPC in the copy removes staging, then writes failed with the copy text, and nothing live moves', async () => {
    const name = await snapshot();
    recordRenames();
    const rel = (p: fs.PathLike) => path.relative(dataPath(), String(p)).split(path.sep).join('/');
    const realRm = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, 'rm').mockImplementation((async (p: fs.PathLike, opts?: fs.RmOptions) => {
      h.order.push(`rm ${rel(p)}`);
      return realRm(p, opts);
    }) as typeof fs.promises.rm);
    let src = '';
    vi.spyOn(fs.promises, 'copyFile').mockImplementationOnce((async (from: fs.PathLike, to: fs.PathLike) => {
      src = rel(from);
      throw Object.assign(new Error(`ENOSPC: no space left on device, copyfile '${from}' -> '${to}'`), { errno: -28, code: 'ENOSPC', syscall: 'copyfile', path: String(from), dest: String(to) });
    }) as typeof fs.promises.copyFile);
    h.order = [];
    await postRestore(fresh(), name);
    await settle();
    const failed = journal();
    expect(src).toMatch(new RegExp(`^_snapshots/${name}/data/`));
    expect(failed).toMatchObject({ stage: 'failed', result: 'failed', error: `Could not copy the backup into /data/_snapshots/${failed.staging}: /data/${src} (ENOSPC).` });
    expect(failed.leftover).toBeUndefined();
    const rm = h.order.indexOf(`rm _snapshots/${failed.staging}`);
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(rm).toBeLessThan(h.order.indexOf('journal failed'));
    expect(h.order.filter(x => x.startsWith('rename '))).toEqual([]);
    expect(fs.existsSync(dataPath('_snapshots', failed.staging))).toBe(false);
    expect(tree()).toEqual(NEW);
    expect(restoreLatch()).toBeNull();
  });

  it('a removal error names the leftover in the failed journal', async () => {
    const name = await snapshot();
    fs.writeFileSync(dataPath('_snapshots', name, 'data', '123', 'mod', 'a.json'), '{"v":"bad"}');
    vi.spyOn(fs.promises, 'rm').mockRejectedValue(err('EACCES'));
    await postRestore(fresh(), name);
    await settle();
    expect(journal()).toMatchObject({ stage: 'failed', leftover: { path: expect.stringMatching(/^\/data\/_snapshots\/\.restore-/), errno: 'EACCES' } });
  });
});

describe('the latch (decisions 48, 54, 55, 62, 65, 73)', () => {
  it("a staging write that throws answers 500 with the did-not-start line, leaves the journal as it was, and later POSTs 409", async () => {
    const name = await snapshot();
    recordRenames((_f, _t, stage) => (stage === 'staging' ? 'EIO' : null));
    const text = `The restore of ${name} did not start: its record (/data/_snapshots/restore.json) could not be written (EIO). Nothing was changed. No restore can start until the bot's container is restarted; check the disk first.`;
    expect(await postRestore(fresh(), name)).toEqual({ status: 500, body: { success: false, error: text } });
    expect(fs.existsSync(restoreJournalPath())).toBe(false);
    expect(restoreOp()).toBeNull();
    expect(lines()).toContain(`[Backup] Restore of ${name} did not start: /data/_snapshots/restore.json could not be written (EIO); no restore can start until the container restarts`);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expect(await postRestore(fresh(), name)).toEqual({ status: 409, body: { success: false, error: text } });
  });

  it.each([
    ['staged', 'staging', true],
    ['swapping', 'staged', true],
    ['placing', 'swapping', false],
    ['placed', 'placing', false],
  ] as const)('a %s write that throws latches; nothing more moves and the POST answers the latch line', async (stage, onDisk, beforeMoves) => {
    const name = await snapshot();
    recordRenames((_f, _t, s) => (s === stage ? 'EIO' : null));
    await postRestore(fresh(), name);
    await settle();
    expect(journal().stage).toBe(onDisk);
    expect(restoreLatch()).toMatchObject({ kind: 'journal', stage, errno: 'EIO' });
    expect(restoreOp()).toBeNull();
    const answer = await postRestore(fresh(), name);
    expect(answer.status).toBe(409);
    expect(answer.body.error).toBe(beforeMoves
      ? `The restore of ${name} stopped before any data was moved: its record (/data/_snapshots/restore.json) could not be written (EIO). The data is unchanged. Until the bot's container is restarted, no change made in the web panel is saved and a stopped bot cannot be started. Check the disk, then restart the bot's container: the web panel then ends this restore as failed, with the data unchanged, before it starts the bot; start the restore again after that.`
      : `The restore of ${name} stopped part way: its record (/data/_snapshots/restore.json) could not be written (EIO), so can't confirm the disk took the restore's last step. Until the bot's container is restarted, nothing more is moved, no change to the data is saved and the bot cannot be started. Check the disk, then restart the bot's container: the web panel takes the restore up again from its record when it starts, before it starts the bot; when the record says swapping, it finishes the restore, or ends it failed with the data unchanged if no data had been moved yet.`);
    if (beforeMoves) expect(tree()).toEqual(NEW);
  });

  it("an error at the swapping record's sync latches journal-sync before any rename (decisions 55, 73)", async () => {
    const name = await snapshot();
    let swapped = false;
    recordRenames((_f, _t, s) => { if (s === 'swapping') swapped = true; return null; });
    h.sync = dir => (swapped && dir === dataPath('_snapshots') ? syncFailed('EIO')(dir) : null);
    await postRestore(fresh(), name);
    await settle();
    expect(journal().stage).toBe('swapping');
    expect(tree()).toEqual(NEW);
    expect(restoreLatch()).toMatchObject({ kind: 'journal-sync', stage: 'swapping', errno: 'EIO' });
    expect((await postRestore(fresh(), name)).body.error).toBe(`The restore of ${name} stopped before any data was moved: the disk reported an error (EIO) when /data/_snapshots was synced after the restore's record was written, so can't confirm the record is on disk. The data is unchanged. Until the bot's container is restarted, nothing is moved, no change to the data is saved and the bot cannot be started. Check the disk, then restart the bot's container: the web panel then ends this restore as failed, with the data unchanged, or finishes it, when /data held no data, before it starts the bot; start the restore again if it ended failed.`);
    expect(lines()).toContain(`[Backup] Restore of ${name} paused before moving any data: syncing /data/_snapshots failed (EIO); nothing is moved until the container restarts`);
  });

  // N's three test 12 rows: the 'open' answer at each sync from the swapping record on.
  it("'open' at the swapping record's sync gives journal-sync with its open text", async () => {
    const name = await snapshot();
    let swapped = false;
    recordRenames((_f, _t, s) => { if (s === 'swapping') swapped = true; return null; });
    h.sync = dir => (swapped && dir === dataPath('_snapshots') ? syncFailed('EMFILE', 'open')(dir) : null);
    await postRestore(fresh(), name);
    await settle();
    expect(restoreLatch()).toMatchObject({ kind: 'journal-sync', open: true });
    expect((await postRestore(fresh(), name)).body.error).toBe(`The restore of ${name} stopped before any data was moved: /data/_snapshots could not be opened for its sync (EMFILE) after the restore's record was written, so can't confirm the record is on disk. The data is unchanged. Until the bot's container is restarted, nothing is moved, no change to the data is saved and the bot cannot be started. Restart the bot's container: the web panel then ends this restore as failed, with the data unchanged, before it starts the bot; start the restore again after that.`);
    expect(tree()).toEqual(NEW);
  });

  it("'open' at the sync before placing gives fsync with its open text", async () => {
    const name = await snapshot();
    let moved = false;
    recordRenames((f, t) => { if (t.includes('.pre-restore-') && !f.startsWith('_snapshots')) moved = true; return null; });
    h.sync = dir => (moved && dir === dataPath('global') ? syncFailed('EMFILE', 'open')(dir) : null);
    await postRestore(fresh(), name);
    await settle();
    const j = journal();
    expect(j.stage).toBe('swapping');
    expect(restoreLatch()).toMatchObject({ kind: 'fsync', stage: 'swapping', open: true });
    expect((await postRestore(fresh(), name)).body.error).toBe(`The restore of ${name} stopped part way: /data/global could not be opened for its sync (EMFILE) after the current data was moved aside, so can't confirm that move is on disk. Until the bot's container is restarted, nothing more is moved, no change to the data is saved and the bot cannot be started. Restart the bot's container: the web panel syncs the folders again and finishes the restore when it starts, before it starts the bot. The data the restore replaced is in /data/_snapshots/.${j.preRestore}.`);
  });

  it("'open' at step 6 gives fsync with its open text", async () => {
    const name = await snapshot();
    let placing = false;
    recordRenames((_f, _t, s) => { if (s === 'placing') placing = true; return null; });
    h.sync = dir => (placing && dir === dataPath('global') ? syncFailed('ENOENT', 'open')(dir) : null);
    await postRestore(fresh(), name);
    await settle();
    const j = journal();
    expect(j.stage).toBe('placing');
    expect(restoreLatch()).toMatchObject({ kind: 'fsync', stage: 'placing', open: true });
    expect((await postRestore(fresh(), name)).body.error).toBe(`The restore of ${name} stopped after moving the data: /data/global could not be opened for its sync (ENOENT), so can't confirm the moved data is on disk. Until the bot's container is restarted, nothing more is moved, no change to the data is saved and the bot cannot be started. Restart the bot's container: the web panel syncs the folders again and finishes the restore when it starts, before it starts the bot. The data the restore replaced is in /data/_snapshots/.${j.preRestore}.`);
  });

  it('a sync error at step 6 latches fsync, writes no stuck, and keeps a stopped child stopped', async () => {
    const name = await snapshot();
    writeMaintenanceFile('maintenance', 'restoring');
    const m = fresh();
    await startedChild(m);
    let placing = false;
    recordRenames((_f, _t, s) => { if (s === 'placing') placing = true; return null; });
    h.sync = dir => (placing && dir === dataPath() ? syncFailed('EIO')(dir) : null);
    await postRestore(m, name);
    await settle();
    expect(journal().stage).toBe('placing');
    expect(restoreLatch()).toMatchObject({ kind: 'fsync', stage: 'placing', errno: 'EIO' });
    expect(forks.children).toHaveLength(1);
    expect(m.isRunning()).toBe(false);
    expect(lines()).toContain(`[Backup] Restore of ${name} paused: syncing /data failed (EIO); nothing more is moved until the container restarts`);
  });

  it("step 8's sync error latches fsync at placed, writes nothing, and a fresh module's step 8 syncs then writes done", async () => {
    const name = await snapshot();
    await postRestore(fresh(), name);
    await settle();
    const j = journal();
    let renamed = false;
    recordRenames((_f, t) => { if (t === `_snapshots/${j.preRestore}`) renamed = true; return null; });
    h.sync = dir => (renamed ? syncFailed('EIO')(dir) : null);
    expect(await recordReplacedData()).toBe('latched');
    expect(journal()).toEqual(j);
    expect(restoreLatch()).toMatchObject({ kind: 'fsync', stage: 'placed', errno: 'EIO' });
    expect((await postRestore(fresh(), name)).body.error).toMatch(new RegExp(`^Restored ${name} at .+\\. The data it replaced is in /data/_snapshots/${j.preRestore}, but the disk reported an error \\(EIO\\) when /data/_snapshots was synced after that folder was renamed`));
    expect(await recordReplacedData()).toBe('not-run');
    _resetRestoreStateForTests();
    h.sync = null;
    h.order = [];
    expect(await recordReplacedData()).toBe('done');
    expect(h.order).toEqual(['sync _snapshots', 'journal done']);
  });

  it('step 8 leaves a note for an aside file it cannot read and keeps the file; the POST names it', async () => {
    const name = await snapshot();
    await postRestore(fresh(), name);
    await settle();
    const j = journal();
    const realOpen = fs.promises.open.bind(fs.promises);
    const bad = path.join(dataPath('_snapshots', `.${j.preRestore}`, 'data', '123', 'mod', 'a.json'));
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === bad) throw err('EACCES');
      return (realOpen as any)(p, ...rest);
    }) as any);
    expect(await recordReplacedData()).toBe('note');
    expect(journal()).toMatchObject({ stage: 'placed', note: { cause: 'read', path: bad, errno: 'EACCES' } });
    expect(fs.readFileSync(bad, 'utf8')).toBe(NEW['123/mod/a.json']);
    expect((await postRestore(fresh(), name)).body.error).toBe(`The last restore cannot record the data it replaced: /data/_snapshots/.${j.preRestore}/data/123/mod/a.json cannot be read (EACCES). No other restore can start until it can; the Dashboard tab says what to do.`);
    vi.restoreAllMocks();
    expect(await recordReplacedData()).toBe('done');
  });
});

describe("C13: an automatic start refused during the POST's op is made at the op's end", () => {
  it('a crash during the copy: the crash restart is refused, stopped set, and the op starts the bot after placed', async () => {
    const name = await snapshot();
    writeMaintenanceFile('maintenance', 'restoring');
    const m = fresh();
    const child = await startedChild(m);
    let release!: () => void;
    h.hold = new Promise(resolve => { release = resolve; });
    await postRestore(m, name);
    exitChild(child, 1);
    await tick(5_400);
    expect(forks.children).toHaveLength(1);
    expect(restoreOp()?.stopped).toBe(true);
    release();
    h.hold = null;
    await settle();
    expect(journal().stage).toBe('placed');
    expect(forks.children).toHaveLength(2);
    expect(lines()).toContain(`[Backup] Restore of ${name}: started the bot again`);
  }, 15_000);

  // The other automatic starts (E7). The restart a migration left for later cannot meet a POST's op: its start is
  // deferred only under the migration lock, which refuses the POST, and restart() is refused while the op runs; its row
  // is the restart whose stop began before the POST.
  type Case = { before?: (m: BotManager, child: any) => Promise<void>; during: (m: BotManager, child: any) => Promise<void> };
  const cases: Array<[string, Case]> = [
    ['the deposed-exit timer', {
      during: async (_m, child) => {
        exitChild(child, EXIT_DEPOSED);
        await tick(5_400);
      },
    }],
    ["the deferred crash start at the migration lock's release", {
      during: async (m, child) => {
        writeMaintenanceFile('running', '');
        m.takeMigrationLock({ jobId: 'j1', to: 'postgres' } as any);
        exitChild(child, 1);
        await tick(5_400);
        expect(lines()).toContain('[BotManager] The automatic start waits: a data migration is running; it runs once the migration ends');
        m.releaseMigrationLock();
        await tick(10);
      },
    }],
    ["promote()'s start after a retire that began before the POST", {
      before: async (_m, child) => {
        forks.holdExit = true;
        child.emit('message', { type: 'control:reshard-retire', data: { attempt: 'a-1' } });
        await tick(10);
      },
      during: async (_m, child) => {
        exitChild(child, 0);
        await tick(10);
      },
    }],
    ['the start of a restart whose stop began before the POST', {
      before: async (m, child) => {
        forks.holdExit = true;
        void m.restart();
        await tick(10);
        expect(child.signals).toEqual(['SIGTERM']);
      },
      during: async (_m, child) => {
        exitChild(child, 0);
        await tick(10);
      },
    }],
  ];

  it.each(cases)("%s: refused while the op runs, and started at the op's end", async (_name, c) => {
    const name = await snapshot();
    writeMaintenanceFile('maintenance', 'restoring');
    const m = fresh();
    const child = await startedChild(m);
    await c.before?.(m, child);
    let release!: () => void;
    h.hold = new Promise(resolve => { release = resolve; });
    expect((await postRestore(m, name)).status).toBe(202);
    await c.during(m, child);
    expect(m.isRunning()).toBe(false);
    expect(forks.children).toHaveLength(1);
    expect(restoreOp()?.stopped).toBe(true);
    release();
    h.hold = null;
    await settle();
    expect(journal().stage).toBe('placed');
    expect(forks.children).toHaveLength(2);
    expect(m.isRunning()).toBe(true);
    expect(lines()).toContain(`[Backup] Restore of ${name}: started the bot again`);
  }, 15_000);
});

/** Holds the POST's `stat` or `statfs` await until released; `answer` changes what the real call answered. */
function holdAwait(call: 'stat' | 'statfs', answer?: (p: string, real: any) => any): { entered: Promise<void>; release: () => void } {
  let release!: () => void;
  let enter!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const real = (fs.promises[call] as any).bind(fs.promises);
  vi.spyOn(fs.promises, call).mockImplementation((async (p: any, ...rest: any[]) => {
    enter();
    await gate;
    const got = await real(p, ...rest);
    return answer ? answer(String(p), got) : got;
  }) as any);
  return { entered, release };
}

describe("GET's restore while a POST's op has no journal of its own (code review 3, C5)", () => {
  it.each([
    ['another backup', false],
    ['the same backup again', true],
  ] as const)("the last journal of %s is not shown as this restore's", async (_row, same) => {
    const name = await snapshot();
    const other = same ? name : 'hourly-2026-11-12T04-00-00-000Z';
    writeRestoreJournal({ format: 1, name: other, startedAt: 1, stage: 'done', result: 'done', finishedAt: 3, staging: '.restore-t', preRestore: 'pre-restore-t', takenAt: 0, files: 3, placedAt: 2 } as RestoreJournal);
    const hold = holdAwait('statfs');
    const m = fresh();
    const post = postRestore(m, name);
    await hold.entered;
    expect(restoreView(m)).toEqual({ name, stage: null, state: 'running', running: true, waiting: null, latch: null, line: `Restoring ${name}: copying and checking the backup.` });
    hold.release();
    expect((await post).status).toBe(202);
    await settle();
    expect(restoreView(m)).toMatchObject({ name, stage: 'placed', running: false });
  });
});

describe("the POST's awaits and the op's start (code review 3, A5)", () => {
  it("a crash restart refused during the awaits, then a staging write that throws: the 500, one start() with the op as its own, then restoreOp cleared", async () => {
    const name = await snapshot();
    writeMaintenanceFile('maintenance', 'restoring');
    const m = fresh();
    const child = await startedChild(m);
    const hold = holdAwait('statfs');
    recordRenames((_f, _t, s) => (s === 'staging' ? 'EIO' : null));
    const realStart = m.start.bind(m);
    const own: Array<{ op: unknown; set: boolean }> = [];
    vi.spyOn(m, 'start').mockImplementation(async opts => {
      if (opts?.restoreOp) own.push({ op: opts.restoreOp, set: restoreOp() === opts.restoreOp });
      return realStart(opts);
    });
    const post = postRestore(m, name);
    await hold.entered;
    const op = restoreOp();
    exitChild(child, 1);
    await tick(5_400);
    expect(forks.children).toHaveLength(1);
    expect(op?.stopped).toBe(true);
    hold.release();
    expect(await post).toEqual({ status: 500, body: { success: false, error: `The restore of ${name} did not start: its record (/data/_snapshots/restore.json) could not be written (EIO). Nothing was changed. No restore can start until the bot's container is restarted; check the disk first.` } });
    expect(own).toEqual([{ op, set: true }]);
    expect(forks.children).toHaveLength(2);
    expect(restoreOp()).toBeNull();
  }, 15_000);

  it.each([
    ['the device check', 'stat' as const, (p: string, st: any) => (path.resolve(p) === path.resolve(snapshotsRoot()) ? { ...st, dev: st.dev + 1 } : st),
      /^The backups folder is on another file system than \/data, so a restore cannot move the data into place\.$/],
    ['the free space check', 'statfs' as const, (_p: string, st: any) => ({ ...st, bavail: 1, bsize: 1024 }),
      /^Not enough free disk space under \/data: 0\.0 MiB free, \d+\.\d MiB needed \(the backup's size plus 256 MiB\)\.$/],
  ])('%s refusing clears restoreOp, writes nothing, and starts the bot a crash stopped during the awaits (R1.f, decision 56)', async (_row, call, answer, text) => {
    const name = await snapshot();
    writeMaintenanceFile('maintenance', 'restoring');
    const m = fresh();
    const child = await startedChild(m);
    const hold = holdAwait(call, answer);
    const post = postRestore(m, name);
    await hold.entered;
    expect(restoreOp()).toMatchObject({ kind: 'restore', name });
    exitChild(child, 1);
    await tick(5_400);
    expect(forks.children).toHaveLength(1);
    expect(restoreOp()?.stopped).toBe(true);
    hold.release();
    const refused = await post;
    expect(refused.status).toBe(409);
    expect(String(refused.body.error)).toMatch(text);
    expect(restoreOp()).toBeNull();
    expect(fs.existsSync(restoreJournalPath())).toBe(false);
    expect(fs.readdirSync(dataPath('_snapshots')).filter(n => n.startsWith('.restore-'))).toEqual([]);
    expect(forks.children).toHaveLength(2);
    expect(m.isRunning()).toBe(true);
    expect(lines()).toContain(`[Backup] Restore of ${name}: started the bot again`);
  }, 15_000);

  it("GET reads the starting words while a refused POST's op starts the bot a crash stopped (code review 4, A4-1)", async () => {
    const name = await snapshot();
    writeMaintenanceFile('maintenance', 'restoring');
    const m = fresh();
    const child = await startedChild(m);
    const hold = holdAwait('stat', (p, st) => (path.resolve(p) === path.resolve(snapshotsRoot()) ? { ...st, dev: st.dev + 1 } : st));
    const realStart = m.start.bind(m);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let ownStart = false;
    vi.spyOn(m, 'start').mockImplementation(async opts => {
      if (opts?.restoreOp) {
        ownStart = true;
        await gate;
      }
      return realStart(opts);
    });
    const post = postRestore(m, name);
    await hold.entered;
    exitChild(child, 1);
    await tick(5_400);
    expect(restoreOp()?.stopped).toBe(true);
    hold.release();
    await vi.waitFor(() => expect(ownStart).toBe(true), { timeout: 5000, interval: 5 });
    expect(restoreView(m)).toMatchObject({ name, stage: null, running: true, line: `Restoring ${name}: starting the bot again.` });
    release();
    expect((await post).status).toBe(409);
    expect(restoreOp()).toBeNull();
  }, 15_000);

  it('with DATA_DIR in a temp folder a whole restore ends done with no latch, and no open reaches /data/_snapshots', async () => {
    const outside = path.resolve('/data/_snapshots');
    expect(path.resolve(dataPath('_snapshots'))).not.toBe(outside);
    const name = await snapshot();
    const opened: string[] = [];
    const openSync = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: any, ...rest: any[]) => { opened.push(path.resolve(String(p))); return (openSync as any)(p, ...rest); }) as any);
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => { opened.push(path.resolve(String(p))); return (open as any)(p, ...rest); }) as any);
    syncBuiltinESMExports();
    expect((await postRestore(fresh(), name)).status).toBe(202);
    await settle();
    expect(await recordReplacedData()).toBe('done');
    expect(journal().stage).toBe('done');
    expect(restoreLatch()).toBeNull();
    expect(opened.some(p => p.startsWith(path.resolve(dataPath('_snapshots'))))).toBe(true);
    expect(opened.filter(p => p.startsWith(outside))).toEqual([]);
  });

  it("a POST while the op's own start runs after failed answers 202 running", async () => {
    const name = await snapshot();
    const m = fresh();
    writeMaintenanceFile('maintenance', 'restoring');
    const child = await startedChild(m);
    child.kill = vi.fn((signal: string) => {
      child.signals.push(signal);
      fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: child.pid, start: null, role: 'bot', at: Date.now() }));
      setTimeout(() => exitChild(child, 0), 5);
      return true;
    });
    const realStart = m.start.bind(m);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let ownStart = false;
    vi.spyOn(m, 'start').mockImplementation(async opts => {
      if (opts?.restoreOp) {
        ownStart = true;
        await gate;
      }
      return realStart(opts);
    });
    await postRestore(m, name);
    await vi.waitFor(() => expect(ownStart).toBe(true), { timeout: 5000, interval: 5 });
    expect(journal().stage).toBe('failed');
    expect(await postRestore(fresh(), name)).toEqual({ status: 202, body: { success: true, state: 'running', name, note: `A restore of ${name} is already running.` } });
    release();
    await settle();
    expect(restoreOp()).toBeNull();
    expect(m.isRunning()).toBe(true);
  });
});

describe("step 8's note and done writes that throw (R8.f)", () => {
  it('the done write: the latch with the step 8 line naming the complete folder, the journal placed, step 8 not run again', async () => {
    const name = await snapshot();
    await postRestore(fresh(), name);
    await settle();
    const j = journal();
    recordRenames((_f, _t, s) => (s === 'done' ? 'EIO' : null));
    expect(await recordReplacedData()).toBe('latched');
    expect(journal()).toEqual(j);
    expect(restoreLatch()).toMatchObject({ kind: 'journal', stage: 'done', step8: true });
    expect((await postRestore(fresh(), name)).body.error).toBe(`Restored ${name} at ${timeText(j.placedAt as number)}. The data it replaced is in /data/_snapshots/${j.preRestore}, but the restore's record (/data/_snapshots/restore.json) could not be written (EIO). No other restore can start until the bot's container is restarted; check the disk first. After the restart the web panel tries again to write the record within a minute.`);
    expect(lines()).toContain(`[Backup] Restore of ${name}: the record of the replaced data could not be written (EIO); no restore can start until the container restarts`);
    expect(await recordReplacedData()).toBe('not-run');
  });

  it('the note write: the latch with the step 8 line naming the aside folder and the file that cannot be read', async () => {
    const name = await snapshot();
    await postRestore(fresh(), name);
    await settle();
    const j = journal();
    const realOpen = fs.promises.open.bind(fs.promises);
    const bad = path.join(dataPath('_snapshots', `.${j.preRestore}`, 'data', '123', 'mod', 'a.json'));
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === bad) throw err('EACCES');
      return (realOpen as any)(p, ...rest);
    }) as any);
    recordRenames((_f, _t, s) => (s === 'placed' ? 'EIO' : null));
    expect(await recordReplacedData()).toBe('latched');
    expect(journal()).toEqual(j);
    expect(restoreLatch()).toMatchObject({ kind: 'journal', stage: 'placed', step8: true });
    expect((await postRestore(fresh(), name)).body.error).toBe(`Restored ${name} at ${timeText(j.placedAt as number)}. The data it replaced is in /data/_snapshots/.${j.preRestore}, but the restore's record (/data/_snapshots/restore.json) could not be written (EIO). No other restore can start until the bot's container is restarted; check the disk first. After the restart the record still cannot be written while /data/_snapshots/.${j.preRestore}/data/123/mod/a.json cannot be read (EACCES): make that file readable by the bot, or move it out of /data/_snapshots and keep it (the pre-restore backup then does not have it).`);
    expect(lines()).toContain(`[Backup] Restore of ${name}: the record of the replaced data could not be written (EIO); no restore can start until the container restarts`);
    expect(await recordReplacedData()).toBe('not-run');
  });
});
