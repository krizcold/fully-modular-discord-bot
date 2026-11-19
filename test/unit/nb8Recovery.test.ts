import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB8 test 13 (decisions 12, 24, 34, 35, 48, 49, 59, 72, C20, K3, L3): main()'s recovery through beginRecovery() with a
// real BotManager. Each journal on disk is left by the real restore (postRestore) stopped at a point by an injected
// rename error or a latch, then this process's memory is reset as a new process's would be.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
const h = vi.hoisted(() => ({ order: [] as string[], sync: null as null | ((dir: string) => unknown) }));
vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return { ...real, syncFolder: async (dir: string) => (h.sync?.(dir) ?? real.syncFolder(dir)) };
});

import { BotManager } from '../../src/webui/botManager';
import { beginRecovery, postRestore, restoreSettled, waitingLine, _setRestoreTimingForTests } from '../../src/webui/backups/restore';
import { _resetRestoreStateForTests, restoreLatch, restoreOp, setRestoreOp } from '../../src/webui/backups/restoreState';
import { readRestoreJournal, restoreJournalPath, type RestoreJournal } from '../../src/bot/internalSetup/utils/backups/restoreJournal';
import { _setTakeTimingForTests, takeSnapshotLocal } from '../../src/bot/internalSetup/utils/backups/snapshotTake';
import { _setBootIdForTests, noteFolderSyncFailure, removeOtherBootRecords, resetFolderSyncFailureForTests, setDiskRole } from '../../src/bot/internalSetup/utils/folderChain';
import { releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { dataPath } from '../../src/utils/dataRoot';
import { forks, forkStage } from '../helpers/forkMock';
import { exitChild, freshWriterLock, logged, resetForks, tick } from '../helpers/nb10Rig';

const seams = { pid: () => process.pid, alive: () => true, startOf: (pid: number) => `start-${pid}`, now: () => Date.now() };
const NAME = 'hourly-2026-11-13T04-00-00-000Z';
const INTERRUPTED = 'The restore was interrupted before any data was changed.';
const err = (code: string) => Object.assign(new Error(`${code}: stubbed`), { code });
const OLD = { '123/mod/a.json': '{"v":"old"}', '456/m/b.json': '{"b":"old"}', 'global/mod/x.json': '{"x":"old"}' };
const NEW = { '123/mod/a.json': '{"v":"new!"}', '789/m/c.json': '{"c":1}', 'global/mod/x.json': '{"x":"new"}' };

let managers: BotManager[] = [];
let warns: ReturnType<typeof vi.spyOn>;
let logs: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;

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

function tree(root: string = dataPath()): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && (e.name === '_snapshots' || e.name.startsWith('.'))) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out[r] = fs.readFileSync(path.join(dir, e.name), 'utf8');
    }
  };
  walk(root, '');
  return out;
}

const journal = (): RestoreJournal => {
  const read = readRestoreJournal();
  if (read.state !== 'read') throw new Error(`no journal: ${read.state}`);
  return read.journal;
};

/** As a new process: the memory of the restore state and of the disk flag reset, the mocks restored. */
function newProcess(): void {
  vi.mocked(fs.renameSync).mockRestore?.();
  syncBuiltinESMExports();
  _resetRestoreStateForTests();
  resetFolderSyncFailureForTests();
  while (writerLockDepth() > 0) releaseWriterLock();
  h.sync = null;
  h.order = [];
}

/**
 * A real restore of OLD over NEW, stopped by `fail` (a rename error code by rename) at a point; the journal then holds
 * what that point leaves. `latchStuck` makes the stuck write throw too, so the journal stays at the stage before it.
 */
async function stoppedRestore(fail: (from: string, to: string, stage: string | null, n: { asideRenames: number; placeRenames: number }) => string | null): Promise<RestoreJournal> {
  clearLive();
  writeTree(OLD);
  expect(await takeSnapshotLocal({ name: NAME, kind: 'hourly' }, fresh())).toMatchObject({ ok: true });
  clearLive();
  writeTree(NEW);
  const real = fs.renameSync;
  const n = { asideRenames: 0, placeRenames: 0 };
  vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    const rel = (p: fs.PathLike) => path.relative(dataPath(), String(p)).split(path.sep).join('/');
    const stage = String(to) === restoreJournalPath() ? (JSON.parse(fs.readFileSync(from, 'utf8')).stage as string) : null;
    const f = rel(from);
    const t = rel(to);
    if (!stage && t.startsWith('_snapshots/.pre-restore-') && !f.startsWith('_snapshots')) n.asideRenames += 1;
    if (!stage && f.startsWith('_snapshots/.restore-') && !t.startsWith('_snapshots')) n.placeRenames += 1;
    const code = fail(f, t, stage, n);
    if (code) throw err(code);
    return real(from, to);
  }) as typeof fs.renameSync);
  syncBuiltinESMExports();
  expect((await postRestore(fresh(), NAME)).status).toBe(202);
  await restoreSettled();
  newProcess();
  return journal();
}

/** main()'s recovery, then its start with the op as its own, as src/index.ts runs them. */
async function mainRecovery(m: BotManager = fresh()): Promise<{ end: string | null; started: boolean; refused?: string }> {
  const recovery = beginRecovery(m);
  const end = recovery ? await recovery : null;
  const op = restoreOp();
  if (end === 'exiting' || restoreLatch()) {
    setRestoreOp(null);
    return { end, started: false };
  }
  const result = await m.start(end && op ? { restoreOp: op } : {});
  setRestoreOp(null);
  return { end, started: result.success, ...(result.success ? {} : { refused: result.error }) };
}

const lines = (): string[] => [...logged(logs), ...logged(warns), ...logged(errors)];

beforeEach(() => {
  for (const e of fs.readdirSync(dataPath())) fs.rmSync(dataPath(e), { recursive: true, force: true });
  resetForks();
  forkStage.stages = ['shared', 'guild'];
  freshWriterLock('webui');
  _setTakeTimingForTests({ pollMs: 5 }, seams);
  _setRestoreTimingForTests({ heldRetryMs: 10, slowRetryMs: 20, journalReadMs: 20 });
  _resetRestoreStateForTests();
  h.order = [];
  h.sync = null;
  logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  managers = [];
});

afterEach(async () => {
  await restoreSettled();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const m of managers) m.cancelCrashRestart();
  for (const child of forks.children) if (child.exitCode === null && child.signalCode === null) exitChild(child, 0);
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  _setTakeTimingForTests();
  _setRestoreTimingForTests();
  _resetRestoreStateForTests();
  _setBootIdForTests(null);
});

describe('the stage rules', () => {
  it('a journal at staging: staging removed first, then failed, and the bot started with the op as its own', async () => {
    const left = await stoppedRestore((_f, _t, s) => (s === 'staged' ? 'EIO' : null));
    expect(left.stage).toBe('staging');
    expect(fs.existsSync(dataPath('_snapshots', left.staging))).toBe(true);
    const order: string[] = [];
    const rm = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, 'rm').mockImplementation((async (p: any, o: any) => { order.push('rm'); return rm(p, o); }) as any);
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === restoreJournalPath()) order.push(`journal ${JSON.parse(fs.readFileSync(from, 'utf8')).stage}`);
      return real(from, to);
    }) as typeof fs.renameSync);
    syncBuiltinESMExports();
    expect(await mainRecovery()).toEqual({ end: 'ended', started: true });
    expect(order).toEqual(['rm', 'journal failed']);
    expect(journal()).toMatchObject({ stage: 'failed', error: INTERRUPTED });
    expect(fs.existsSync(dataPath('_snapshots', left.staging))).toBe(false);
    expect(tree()).toEqual(NEW);
    expect(restoreOp()).toBeNull();
  });

  it('a journal at staged ends failed with the data unchanged', async () => {
    const left = await stoppedRestore((_f, _t, s) => (s === 'swapping' ? 'EIO' : null));
    expect(left.stage).toBe('staged');
    await mainRecovery();
    expect(journal()).toMatchObject({ stage: 'failed', error: INTERRUPTED });
    expect(tree()).toEqual(NEW);
  });

  it.each([
    ['with the staging folder', false],
    ['with the staging folder absent', true],
  ])('swapping with every aside item live and none aside ends failed, nothing renamed (decision 72) %s', async (_row, absent) => {
    let swapped = false;
    h.sync = null;
    const left = await (async () => {
      const done = stoppedRestore((_f, _t, s) => { if (s === 'swapping') swapped = true; return null; });
      h.sync = (dir: string) => (swapped && dir === dataPath('_snapshots') ? { failed: true, kind: 'sync', dir, errno: 'EIO', error: err('EIO') } : null);
      return done;
    })();
    expect(left.stage).toBe('swapping');
    if (absent) fs.rmSync(dataPath('_snapshots', left.staging), { recursive: true, force: true });
    const renames = vi.spyOn(fs, 'renameSync');
    syncBuiltinESMExports();
    expect(await mainRecovery()).toMatchObject({ started: true });
    expect(renames.mock.calls.filter(c => String(c[1]) !== restoreJournalPath() && !String(c[1]).endsWith('.json'))).toEqual([]);
    expect(journal()).toMatchObject({ stage: 'failed', error: INTERRUPTED });
    expect(fs.existsSync(dataPath('_snapshots', left.staging))).toBe(false);
    expect(tree()).toEqual(NEW);
  });

  it('swapping with one item aside: the rest moved aside, synced, placed, then placed on disk and the bot started', async () => {
    const left = await stoppedRestore((_f, _t, s, n) => (s === 'stuck' || (!s && n.asideRenames === 2) ? 'EIO' : null));
    expect(left.stage).toBe('swapping');
    expect(await mainRecovery()).toMatchObject({ end: 'ended', started: true });
    const j = journal();
    expect(j.stage).toBe('placed');
    expect(tree()).toEqual(OLD);
    expect(tree(dataPath('_snapshots', `.${j.preRestore}`, 'data'))).toEqual(NEW);
    expect(fs.existsSync(dataPath('_snapshots', j.staging))).toBe(false);
  });

  it('an aside item in neither place goes to the missing list and recovery goes on', async () => {
    const left = await stoppedRestore((_f, _t, s, n) => (s === 'stuck' || (!s && n.asideRenames === 2) ? 'EIO' : null));
    const unmoved = (left.aside as string[]).filter(rel => fs.existsSync(dataPath(rel)));
    expect(unmoved.length).toBeGreaterThan(0);
    fs.rmSync(dataPath(unmoved[0]), { recursive: true, force: true });
    await mainRecovery();
    expect(journal()).toMatchObject({ stage: 'placed', missing: [unmoved[0]] });
    expect(tree()).toEqual(OLD);
  });

  it('placing with the staging folder removed ends placed with nothing moved and no stuck', async () => {
    const left = await stoppedRestore((_f, _t, s) => (s === 'placed' ? 'EIO' : null));
    expect(left.stage).toBe('placing');
    fs.rmSync(dataPath('_snapshots', left.staging), { recursive: true, force: true });
    await mainRecovery();
    expect(journal().stage).toBe('placed');
    expect(tree()).toEqual(OLD);
  });

  it('stuck at swapping with no item moved goes back to swapping and ends failed', async () => {
    const left = await stoppedRestore((_f, _t, s, n) => (!s && n.asideRenames === 1 ? 'EACCES' : null));
    expect(left).toMatchObject({ stage: 'stuck', stuckAt: 'swapping', cause: 'rename', errno: 'EACCES' });
    await mainRecovery();
    expect(journal()).toMatchObject({ stage: 'failed', error: INTERRUPTED });
    expect(tree()).toEqual(NEW);
  });

  it('stuck at placing by a rename: the restart places what is still staged', async () => {
    const left = await stoppedRestore((_f, _t, s, n) => (!s && n.placeRenames === 2 ? 'EACCES' : null));
    expect(left).toMatchObject({ stage: 'stuck', stuckAt: 'placing', cause: 'rename' });
    expect(await mainRecovery()).toMatchObject({ started: true });
    expect(journal().stage).toBe('placed');
    expect(tree()).toEqual(OLD);
  });

  it('a path in the way stays stuck, and the restart after it was moved finishes the restore', async () => {
    const left = await stoppedRestore((_f, _t, s, n) => (!s && n.placeRenames === 2 ? 'EACCES' : null));
    const unplaced = fs.readdirSync(dataPath('_snapshots', left.staging, 'data'));
    const inWay = unplaced.find(x => x !== 'global') ?? 'global';
    fs.mkdirSync(dataPath(inWay, 'hand'), { recursive: true });
    const first = await mainRecovery();
    expect(first.started).toBe(false);
    expect(first.refused).toBe('The last backup restore stopped part way, so the bot does not start; the Dashboard tab says what to do.');
    expect(journal()).toMatchObject({ stage: 'stuck', stuckAt: 'placing', cause: 'in-the-way' });
    newProcess();
    fs.rmSync(dataPath(inWay), { recursive: true, force: true });
    expect(await mainRecovery()).toMatchObject({ started: true });
    expect(journal().stage).toBe('placed');
  });

  it('the staging removal answering EACCES ends failed with the leftover named', async () => {
    await stoppedRestore((_f, _t, s) => (s === 'staged' ? 'EIO' : null));
    vi.spyOn(fs.promises, 'rm').mockRejectedValue(err('EACCES'));
    await mainRecovery();
    expect(journal()).toMatchObject({ stage: 'failed', error: INTERRUPTED, leftover: { path: expect.stringMatching(/^\/data\/_snapshots\/\.restore-/), errno: 'EACCES' } });
  });

  it('the write back to stuckAt throwing latches; main() starts nothing', async () => {
    await stoppedRestore((_f, _t, s, n) => (!s && n.placeRenames === 2 ? 'EACCES' : null));
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === restoreJournalPath()) throw err('EIO');
      return real(from, to);
    }) as typeof fs.renameSync);
    syncBuiltinESMExports();
    expect(await mainRecovery()).toEqual({ end: 'ended', started: false });
    expect(restoreLatch()).toMatchObject({ kind: 'journal', stage: 'placing', errno: 'EIO' });
    expect(journal().stage).toBe('stuck');
    expect(forks.children).toHaveLength(0);
  });

  it("the write back to swapping throwing after data was moved logs the part-way pause, as the latch line reads (code review 3, A2)", async () => {
    const left = await stoppedRestore((_f, _t, s, n) => (!s && n.asideRenames === 2 ? 'EACCES' : null));
    expect(left).toMatchObject({ stage: 'stuck', stuckAt: 'swapping', cause: 'rename' });
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === restoreJournalPath()) throw err('EIO');
      return real(from, to);
    }) as typeof fs.renameSync);
    syncBuiltinESMExports();
    expect(await mainRecovery()).toEqual({ end: 'ended', started: false });
    expect(restoreLatch()).toMatchObject({ kind: 'journal', stage: 'swapping', errno: 'EIO' });
    expect(journal().stage).toBe('stuck');
    const paused = lines().filter(l => l.startsWith(`[Backup] Restore of ${NAME} paused`));
    expect(paused).toEqual([`[Backup] Restore of ${NAME} paused: /data/_snapshots/restore.json could not be written (EIO); nothing more is moved until the container restarts`]);
  });
});

describe('the waits (decisions 49, 54, 59)', () => {
  const importLock = (pid = 4242) => {
    freshWriterLock('webui', new Set([process.pid, pid]));
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid, start: null, role: 'import', at: Date.now() }));
  };

  it('a data bundle import holding the lock: the journal stays, starts and writes are refused, the line names it; its release lets recovery finish once', async () => {
    const left = await stoppedRestore((_f, _t, s, n) => (s === 'stuck' || (!s && n.asideRenames === 2) ? 'EIO' : null));
    importLock();
    const m = fresh();
    const start = vi.spyOn(m, 'start');
    const recovery = beginRecovery(m)!;
    await tick(60);
    expect(journal().stage).toBe('swapping');
    const op = restoreOp()!;
    expect(op.waiting).toMatchObject({ cause: 'held', holder: { role: 'import', pid: 4242 } });
    expect(waitingLine(op, 'swapping')).toBe(`Restoring ${NAME}: waiting, because another process holds the data files (a data bundle import, pid 4242). The web panel goes on as soon as that ends: it finishes the restore, or ends it failed with the data unchanged if no data had been moved yet, or finishes it, when /data held no data, and then starts the bot.`);
    expect(lines().filter(l => l === `[Backup] Restore of ${NAME} waits: another process holds the data files (a data bundle import, pid 4242); it goes on as soon as that ends`)).toHaveLength(1);
    expect(await fresh().start()).toMatchObject({ success: false, reason: 'restoring' });
    expect(fresh().writerRoute('shared')).toMatchObject({ code: 'restoring' });
    expect((await postRestore(fresh(), NAME)).body).toMatchObject({ state: 'running', name: NAME });
    fs.rmSync(writerLockPath(), { force: true });
    expect(await recovery).toBe('ended');
    expect(journal().stage).toBe('placed');
    expect(left.name).toBe(NAME);
    expect((await m.start({ restoreOp: op })).success).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('a young lock that does not parse gives "another process is taking the data files at this moment"', async () => {
    await stoppedRestore((_f, _t, s) => (s === 'swapping' ? 'EIO' : null));
    fs.writeFileSync(writerLockPath(), '{"pid":');
    const recovery = beginRecovery(fresh())!;
    await tick(60);
    expect(waitingLine(restoreOp()!, 'staged')).toBe(`Restoring ${NAME}: waiting, because another process is taking the data files at this moment. The web panel goes on as soon as that ends: it ends this restore as failed, with the data unchanged, and then starts the bot.`);
    fs.rmSync(writerLockPath(), { force: true });
    expect(await recovery).toBe('ended');
    expect(journal().stage).toBe('failed');
  });

  it('an unreadable journal: main() waits with the can\'t-confirm line, and its removal lets it start the bot', async () => {
    fs.mkdirSync(dataPath('_snapshots'), { recursive: true });
    fs.writeFileSync(restoreJournalPath(), '{"format":1');
    const m = fresh();
    const pending = mainRecovery(m);
    await tick(60);
    expect(restoreOp()).toMatchObject({ kind: 'recovery', name: null, waiting: { cause: 'journal', errno: 'not valid JSON' } });
    expect(waitingLine(restoreOp()!, null)).toBe("can't confirm the state of the last backup restore: /data/_snapshots/restore.json cannot be read (not valid JSON). Until it can be read, the bot cannot be started, no change to the data is saved and no backup is taken; if no restore ran, remove that file.");
    expect(lines().filter(l => l === '[Backup] /data/_snapshots/restore.json cannot be read (not valid JSON); the web panel waits before it starts the bot')).toHaveLength(1);
    fs.rmSync(restoreJournalPath());
    expect(await pending).toEqual({ end: 'ended', started: true });
  });

  it('an unreadable journal that becomes readable at swapping while an import holds the lock: the line names the restore', async () => {
    const left = await stoppedRestore((_f, _t, s, n) => (s === 'stuck' || (!s && n.asideRenames === 2) ? 'EIO' : null));
    const text = fs.readFileSync(restoreJournalPath(), 'utf8');
    fs.writeFileSync(restoreJournalPath(), '{"format":1');
    importLock();
    const recovery = beginRecovery(fresh())!;
    await tick(60);
    expect(restoreOp()!.name).toBeNull();
    fs.writeFileSync(restoreJournalPath(), text);
    await tick(80);
    expect(restoreOp()!.name).toBe(left.name);
    expect(waitingLine(restoreOp()!, 'swapping')).toMatch(new RegExp(`^Restoring ${NAME}: waiting, because another process holds the data files`));
    fs.rmSync(writerLockPath(), { force: true });
    expect(await recovery).toBe('ended');
    expect(journal().stage).toBe('placed');
  });

  it.each([
    ['the lock wait', false],
    ['the unreadable journal wait', true],
  ])('exiting during %s ends recovery with nothing written and no start', async (_row, unreadable) => {
    await stoppedRestore((_f, _t, s) => (s === 'swapping' ? 'EIO' : null));
    if (unreadable) fs.writeFileSync(restoreJournalPath(), '{"format":1');
    else importLock();
    const before = fs.readFileSync(restoreJournalPath(), 'utf8');
    const m = fresh();
    const pending = mainRecovery(m);
    await tick(60);
    m.beginExit();
    expect(await pending).toEqual({ end: 'exiting', started: false });
    expect(fs.readFileSync(restoreJournalPath(), 'utf8')).toBe(before);
    expect(forks.children).toHaveLength(0);
  });
});

describe('the disk error record (C20, K3, L3)', () => {
  it("this boot's record latches disk before any move", async () => {
    const left = await stoppedRestore((_f, _t, s) => (s === 'placed' ? 'EIO' : null));
    expect(left.stage).toBe('placing');
    _setBootIdForTests('b1');
    setDiskRole('web panel');
    noteFolderSyncFailure(dataPath('global'), 'EIO');
    resetFolderSyncFailureForTests();
    _setBootIdForTests('b1');
    setDiskRole('web panel');
    const before = tree();
    expect(await mainRecovery()).toEqual({ end: 'ended', started: false });
    expect(restoreLatch()).toMatchObject({ kind: 'disk', stage: 'placing', errno: 'EIO' });
    expect(tree()).toEqual(before);
    expect(journal().stage).toBe('placing');
  });

  it("another boot's record is removed at the start and recovery finishes", async () => {
    await stoppedRestore((_f, _t, s) => (s === 'placed' ? 'EIO' : null));
    _setBootIdForTests('b0');
    setDiskRole('web panel');
    noteFolderSyncFailure(dataPath('global'), 'EIO');
    expect(fs.existsSync(dataPath('_snapshots', 'disk-error-b0.json'))).toBe(true);
    resetFolderSyncFailureForTests();
    _setBootIdForTests('b1');
    setDiskRole('web panel');
    removeOtherBootRecords();
    expect(fs.existsSync(dataPath('_snapshots', 'disk-error-b0.json'))).toBe(false);
    expect(await mainRecovery()).toMatchObject({ started: true });
    expect(journal().stage).toBe('placed');
  });

  it("a folder sync error during the wait for a held lock latches disk at recovery's next sync step", async () => {
    await stoppedRestore((_f, _t, s, n) => (s === 'stuck' || (!s && n.asideRenames === 2) ? 'EIO' : null));
    freshWriterLock('webui', new Set([process.pid, 4242]));
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 4242, start: null, role: 'import', at: Date.now() }));
    const pending = mainRecovery();
    await tick(40);
    noteFolderSyncFailure(dataPath('_snapshots'), 'EIO');
    fs.rmSync(writerLockPath(), { force: true });
    expect(await pending).toEqual({ end: 'ended', started: false });
    expect(restoreLatch()).toMatchObject({ kind: 'disk', errno: 'EIO' });
    expect(journal().stage).toBe('swapping');
  });
});
