import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB8 test 16 (decisions 13, 15, 44, 54, 61, C14, C20, E11 as F3, F4 and G2, B5 as K2 and L1, I2, L3, N4): the routes
// at /api/backups mounted as server.ts mounts them, in front of a real BotManager (forkMock children), the real writer
// lock, journal and state files under the test's data folder, and snapshots taken by the real local take. The folder
// syncs answer 'earlier' once the flag is set, as on Linux, so the rows run on Windows too; a row can hold a sync.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
const h = vi.hoisted(() => ({ hold: null as null | Promise<void> }));
vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  const earlier = () => {
    const flag = real.folderSyncFlag();
    return { failed: true, kind: 'earlier', dir: flag.dir, errno: flag.errno, error: null };
  };
  return {
    ...real,
    syncFolder: async (dir: string) => {
      if (h.hold) await h.hold;
      return real.syncFolder(dir);
    },
    syncFolderSync: (dir: string) => (real.folderSyncFailed() ? earlier() : real.syncFolderSync(dir)),
    syncFolderChainSync: (dir: string) => (real.folderSyncFailed() ? earlier() : real.syncFolderChainSync(dir)),
  };
});

import { BotManager } from '../../src/webui/botManager';
import { createBackupRoutes, _setBackupRouteLimitsForTests } from '../../src/webui/routes/backups';
import { createControlRoutes } from '../../src/webui/routes/control';
import { latchLine, postRestore, recordReplacedData, restoreSettled, stuckText, unreadableLine, _setRestoreTimingForTests } from '../../src/webui/backups/restore';
import { _resetRestoreStateForTests, setRestoreLatch, type RestoreLatch } from '../../src/webui/backups/restoreState';
import {
  defaultState, readSettings, settingsPath, settingsUnreadableText, statePath, stateUnreadableText, writeRestoreJournal, writeSettings, writeState,
} from '../../src/webui/backups/state';
import { readRestoreJournal, restoreJournalPath, type RestoreJournal } from '../../src/bot/internalSetup/utils/backups/restoreJournal';
import { _setTakeTimingForTests, takeSnapshotLocal } from '../../src/bot/internalSetup/utils/backups/snapshotTake';
import {
  _setBootIdForTests, folderSyncFlag, noteFolderSyncFailure, removeOtherBootRecords, resetFolderSyncFailureForTests, setDiskRole, timeText,
  writtenUnconfirmedText,
} from '../../src/bot/internalSetup/utils/folderChain';
import { releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { dataPath } from '../../src/utils/dataRoot';
import { startApp, call } from '../helpers/configRig';
import { forks, forkStage } from '../helpers/forkMock';
import { exitChild, freshWriterLock, resetForks, tick } from '../helpers/nb10Rig';

const seams = { pid: () => process.pid, alive: () => true, startOf: (pid: number) => `start-${pid}`, now: () => Date.now() };
const NAME = 'hourly-2026-11-13T04-00-00-000Z';
const OLDER = 'hourly-2026-11-13T03-00-00-000Z';
const PRE = 'pre-restore-2026-11-13T05-00-00-000Z';
const err = (code: string) => Object.assign(new Error(`${code}: stubbed`), { code });
const NOT_ENOUGH = "a restart of the bot's container is not enough after a disk error";

let managers: BotManager[] = [];
let app: { url: string; close: () => Promise<void> } | null = null;

function fresh(): BotManager {
  const m = new BotManager();
  managers.push(m);
  return m;
}

function writeTree(files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(dataPath(rel)), { recursive: true });
    fs.writeFileSync(dataPath(rel), text);
  }
}

function clearLive(): void {
  for (const e of fs.readdirSync(dataPath())) if (e !== '_snapshots') fs.rmSync(dataPath(e), { recursive: true, force: true });
}

/** A snapshot of `files` taken by the real local take; the live data is left as it was taken. */
async function snapshot(name: string, files: Record<string, string> = { '123/mod/a.json': '{"v":1}', 'global/mod/x.json': '{"x":1}' }): Promise<void> {
  clearLive();
  writeTree(files);
  expect(await takeSnapshotLocal({ name, kind: 'hourly' }, fresh())).toMatchObject({ ok: true });
}

async function serve(m: BotManager = fresh()): Promise<string> {
  app = await startApp(a => {
    a.use('/api/backups', createBackupRoutes(m));
    a.use('/api/bot', createControlRoutes(m));
  });
  return app.url;
}

const get = async (url: string) => (await call(url, 'GET', '/api/backups')).body;
const journalOf = (stage: RestoreJournal['stage'], extra: Record<string, unknown> = {}): RestoreJournal => ({
  format: 1, name: NAME, startedAt: Date.UTC(2026, 10, 13, 5), stage, staging: '.restore-2026-11-13T05-00-00-000Z', preRestore: PRE, ...extra,
});

/** The data disk line of GET's notes (C20, with B6's switch when a record of this boot stands). */
const diskNote = (folder: string, at: number, by: string, until: string) =>
  `The data disk reported an error when ${folder} was synced at ${timeText(at)} (EIO, in ${by}). ${until}, no backup is taken and no restore can start; check the disk first.`;
const MACHINE_UNTIL = `Until the machine the bot runs on is restarted (${NOT_ENOUGH})`;

beforeEach(() => {
  for (const e of fs.readdirSync(dataPath())) fs.rmSync(dataPath(e), { recursive: true, force: true });
  resetForks();
  forkStage.stages = ['shared', 'guild'];
  freshWriterLock('webui');
  _setTakeTimingForTests({ pollMs: 5 }, seams);
  _setRestoreTimingForTests({ stopMs: 2000 });
  _resetRestoreStateForTests();
  _setBackupRouteLimitsForTests();
  h.hold = null;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  managers = [];
});

afterEach(async () => {
  h.hold = null;
  await restoreSettled();
  await app?.close();
  app = null;
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const m of managers) m.cancelCrashRestart();
  for (const child of forks.children) if (child.exitCode === null && child.signalCode === null) exitChild(child, 0);
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  _setTakeTimingForTests();
  _setRestoreTimingForTests();
  _resetRestoreStateForTests();
  _setBackupRouteLimitsForTests();
  resetFolderSyncFailureForTests();
});

describe('GET /api/backups (decision 13)', () => {
  it('with nothing taken yet: the defaults and no restore', async () => {
    const url = await serve();
    expect(await get(url)).toEqual({
      success: true, enabled: true, hour: 4, json: true, snapshots: [], newest: null, lastAttempt: null, lastRefusal: null,
      test: { last: null, running: null }, work: null, alerts: {}, migration: { kind: 'none' }, restore: null, notes: [],
    });
  });

  it('lists the snapshots newest first with their counts and test, a damaged one by its name, and the newest complete one', async () => {
    await snapshot(OLDER);
    await snapshot(NAME, { '123/mod/a.json': '{"v":2}', '456/m/b.json': '{"b":1}' });
    fs.mkdirSync(dataPath('_snapshots', 'hourly-2026-11-13T06-00-00-000Z'));
    const state = defaultState();
    state.test.last = { name: OLDER, at: 5, result: 'passed' };
    state.lastAttempt = { name: NAME, at: 7, result: 'ok' };
    writeState(state);
    const body = await get(await serve());
    expect(body.snapshots.map((s: any) => [s.name, s.state, s.test])).toEqual([
      ['hourly-2026-11-13T06-00-00-000Z', 'damaged', null],
      [NAME, 'complete', null],
      [OLDER, 'complete', 'passed'],
    ]);
    expect(body.snapshots[0]).toEqual({
      name: 'hourly-2026-11-13T06-00-00-000Z', kind: 'hourly', takenAt: null, files: null, bytes: null, guilds: null, graveyardEntries: null,
      test: null, state: 'damaged', cause: 'ENOENT',
    });
    expect(body.snapshots[1]).toMatchObject({ name: NAME, kind: 'hourly', files: 2, guilds: 2, graveyardEntries: 0, state: 'complete' });
    expect(typeof body.snapshots[1].takenAt).toBe('number');
    expect(body.snapshots[1].bytes).toBe('{"v":2}'.length + '{"b":1}'.length);
    expect(body.newest).toEqual(body.snapshots[1]);
    expect(body.lastAttempt).toEqual({ name: NAME, at: 7, result: 'ok' });
    expect(body.test).toEqual({ last: { name: OLDER, at: 5, result: 'passed' }, running: null });
  });

  it('puts the can\'t-read texts of both files in notes and answers the default settings', async () => {
    fs.mkdirSync(dataPath('_snapshots'), { recursive: true });
    fs.writeFileSync(settingsPath(), '{"enabled":');
    fs.writeFileSync(statePath(), '[1]');
    const body = await get(await serve());
    expect(body).toMatchObject({ enabled: true, hour: 4, lastAttempt: null, alerts: {} });
    expect(body.notes).toEqual([settingsUnreadableText('not valid JSON'), stateUnreadableText('not a JSON object')]);
  });

  it("carries the alerts, the last refusal and the running test from state.json, and a migration's state", async () => {
    const state = defaultState();
    state.alerts = { 'snapshot-failed': { since: 1, key: 'k', text: 'No backup.', message: { state: 'sent', at: 2, place: 'dm' } } };
    state.lastRefusal = { at: 3, words: 'the bot began stopping during the backup.', startedAt: 2 };
    state.test.running = { name: NAME, startedAt: 4, attempt: 1 };
    writeState(state);
    const m = fresh();
    m.takeMigrationLock({ jobId: 'job-held-0001', to: 'postgres' } as any);
    const body = await get(await serve(m));
    m.releaseMigrationLock();
    expect(body.alerts).toEqual(state.alerts);
    expect(body.lastRefusal).toEqual(state.lastRefusal);
    expect(body.test.running).toEqual(state.test.running);
    expect(body.migration).toEqual({ kind: 'running', jobId: 'job-held-0001' });
  });
});

describe("GET's notes and the POST under a disk error (C20, B5, I2, K2, L1, L3)", () => {
  it("the web panel's own error with its record written: the notes line in the machine's wording, and the POST refused", async () => {
    _setBootIdForTests('b1');
    setDiskRole('web panel');
    noteFolderSyncFailure(dataPath('123'), 'EIO');
    const at = folderSyncFlag()!.at!;
    const url = await serve();
    expect((await get(url)).notes).toEqual([diskNote('/data/123', at, 'the web panel', MACHINE_UNTIL)]);
    const post = await call(url, 'POST', '/api/backups/restore', { name: NAME });
    expect(post).toEqual({
      status: 409,
      body: { success: false, error: `The data disk reported an error when /data/123 was synced at ${timeText(at)} (EIO), so can't confirm earlier changes are on disk. No restore can start until the machine the bot runs on is restarted (${NOT_ENOUGH}); check the disk first.` },
    });
  });

  it("a data bundle import's record, read at the web panel's start: the notes line names the import and the POST is refused", async () => {
    _setBootIdForTests('b1');
    setDiskRole('a data bundle import');
    noteFolderSyncFailure(dataPath('456'), 'EIO');
    const at = folderSyncFlag()!.at!;
    resetFolderSyncFailureForTests();
    _setBootIdForTests('b1');
    setDiskRole('web panel');
    const url = await serve();
    expect((await get(url)).notes).toEqual([diskNote('/data/456', at, 'a data bundle import', MACHINE_UNTIL)]);
    expect((await call(url, 'POST', '/api/backups/restore', { name: NAME })).status).toBe(409);
    expect(readRestoreJournal()).toEqual({ state: 'none' });
  });

  it("the web panel's record write refused: the container's wording, and B5's line naming the file it tried", async () => {
    _setBootIdForTests('b1');
    setDiskRole('web panel');
    const realOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags: any, mode?: any) => {
      if (String(p).endsWith('disk-error-b1.json')) throw err('EROFS');
      return realOpen(p, flags, mode);
    }) as typeof fs.openSync);
    syncBuiltinESMExports();
    noteFolderSyncFailure(dataPath('123'), 'EIO');
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    const at = folderSyncFlag()!.at!;
    expect((await get(await serve())).notes).toEqual([
      diskNote('/data/123', at, 'the web panel', "Until the bot's container is restarted"),
      "The disk error could not be recorded in /data/_snapshots/disk-error-b1.json (EROFS), so a restart of the bot's container alone would clear it.",
    ]);
  });

  it("an earlier boot's record that could not be removed: no notes line, and the POST is not refused for it (L3)", async () => {
    _setBootIdForTests('b1');
    writeTree({ '_snapshots/disk-error-b0.json': JSON.stringify({ format: 1, bootId: 'b0', folder: '/data/123', errno: 'EIO', at: 1, by: 'web panel' }) });
    const realUnlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p).endsWith('disk-error-b0.json')) throw err('EIO');
      return realUnlink(p);
    }) as typeof fs.unlinkSync);
    syncBuiltinESMExports();
    setDiskRole('web panel');
    removeOtherBootRecords();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expect(fs.existsSync(dataPath('_snapshots', 'disk-error-b0.json'))).toBe(true);
    const url = await serve();
    expect((await get(url)).notes).toEqual([]);
    expect(await call(url, 'POST', '/api/backups/restore', { name: NAME })).toEqual({
      status: 404, body: { success: false, error: `No complete backup is named ${NAME}.` },
    });
  });
});

describe("a .pre-restore folder no open journal names (F3, F4, G2)", () => {
  const folder = `.${PRE}`;
  const words = `/data/_snapshots/${folder}`;
  const holds = (n: string) => `${words} is a folder a restore left under that name. It holds ${n}, which may be the data that restore replaced; nothing offers them as a backup, and can't confirm they are complete. Copy what you need from it by hand, then delete it.`;
  const leave = (files: number) => {
    fs.mkdirSync(dataPath('_snapshots', folder, 'data'), { recursive: true });
    for (let i = 0; i < files; i++) writeTree({ [`_snapshots/${folder}/data/123/m/f${i}.json`]: '{}' });
  };

  it.each([
    ['no journal', null],
    ['a done journal that names it', 'done'],
    ['a failed journal that names it', 'failed'],
  ] as const)('is named with its file count under %s', async (_label, stage) => {
    leave(2);
    if (stage) writeRestoreJournal(journalOf(stage, { result: stage, finishedAt: 9 }));
    expect((await get(await serve())).notes).toEqual([holds('2 files')]);
  });

  it('is not named while an open journal names it', async () => {
    leave(2);
    writeRestoreJournal(journalOf('placed', { placedAt: 9 }));
    expect((await get(await serve())).notes).toEqual([]);
  });

  it('is not named while the journal cannot be read', async () => {
    leave(2);
    fs.writeFileSync(restoreJournalPath(), '{"format":1,"stage":');
    expect((await get(await serve())).notes).toEqual([]);
  });

  it('names an empty folder as one to delete, and one file in the singular', async () => {
    fs.mkdirSync(dataPath('_snapshots', folder), { recursive: true });
    const url = await serve();
    expect((await get(url)).notes).toEqual([`${words} is a folder a restore left under that name; it holds no file, so it can be deleted.`]);
    fs.rmSync(dataPath('_snapshots', folder), { recursive: true });
    leave(1);
    expect((await get(url)).notes).toEqual([holds('1 file')]);
  });

  it('stops counting at its limit, and counts again only when the folder changed', async () => {
    _setBackupRouteLimitsForTests({ countMax: 3 });
    leave(5);
    const realReaddir = fs.promises.readdir;
    let walks = 0;
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: fs.PathLike, o?: any) => {
      if (String(p) === dataPath('_snapshots', folder)) walks++;
      return realReaddir(p, o);
    }) as typeof fs.promises.readdir);
    const url = await serve();
    expect((await get(url)).notes).toEqual([holds('more than 3 files')]);
    expect((await get(url)).notes).toEqual([holds('more than 3 files')]);
    expect(walks).toBe(1);
    fs.rmSync(dataPath('_snapshots', folder, 'data'), { recursive: true });
    fs.utimesSync(dataPath('_snapshots', folder), new Date(), new Date(Date.now() + 5000));
    expect((await get(url)).notes).toEqual([`${words} is a folder a restore left under that name; it holds no file, so it can be deleted.`]);
    expect(walks).toBe(2);
  });
});

describe("GET's restore and its line (decisions 13, 44, 54, 62)", () => {
  it('a whole restore through the route: started, its running line, then recording, then the done line with the bot stopped', async () => {
    await snapshot(NAME);
    writeTree({ '123/mod/a.json': '{"v":"new"}' });
    let release: () => void = () => undefined;
    h.hold = new Promise<void>(resolve => { release = resolve; });
    const url = await serve();
    expect(await call(url, 'POST', '/api/backups/restore', { name: NAME })).toEqual({
      status: 202, body: { success: true, state: 'started', name: NAME },
    });
    const during = (await get(url)).restore;
    expect(during).toMatchObject({ name: NAME, stage: 'staging', state: 'running', running: true, waiting: null, latch: null });
    expect(during.line).toBe(`Restoring ${NAME}: copying and checking the backup.`);
    expect(during.aside).toBeUndefined();
    expect((await call(url, 'POST', '/api/backups/restore', { name: OLDER })).body).toEqual({
      success: true, state: 'running', name: NAME, note: `A restore of ${NAME} is already running.`,
    });
    h.hold = null;
    release();
    await restoreSettled();
    expect((await get(url)).restore).toMatchObject({ stage: 'placed', running: false, line: `Restoring ${NAME}: recording the replaced data.` });
    expect(await recordReplacedData()).toBe('done');
    const done = (await get(url)).restore;
    const j = readRestoreJournal();
    if (j.state !== 'read') throw new Error('no journal');
    expect(done).toMatchObject({ name: NAME, stage: 'done', result: 'done', state: 'clear', running: false, preRestore: j.journal.preRestore });
    expect(done.line).toBe(`Restored ${NAME} (taken ${timeText(j.journal.takenAt as number)}) at ${timeText(j.journal.finishedAt as number)}: 2 files. The data it replaced is kept as backup ${j.journal.preRestore}. The bot is now stopped.`);
  });

  it('the done line names the paths found in neither place and a bot running in maintenance', async () => {
    writeRestoreJournal(journalOf('done', { result: 'done', takenAt: Date.UTC(2026, 10, 13, 4), finishedAt: Date.UTC(2026, 10, 13, 6), files: 3, missing: ['456', 'global/m'] }));
    writeMaintenanceFile('maintenance', 'restoring');
    const m = fresh();
    expect((await m.start()).success).toBe(true);
    await tick(5);
    const { restore } = await get(await serve(m));
    expect(restore.line).toBe(`Restored ${NAME} (taken 2026-11-13 04:00 UTC) at 2026-11-13 06:00 UTC: 3 files. The data it replaced is kept as backup ${PRE}. /data/456, /data/global/m were in neither /data nor the pre-restore folder, so the pre-restore backup does not have them. The bot is now running in maintenance.`);
  });

  it('the failed line with its leftover, then the bot state', async () => {
    writeRestoreJournal(journalOf('failed', {
      result: 'failed', error: 'The bot did not stop within 60 seconds.', finishedAt: 9,
      leftover: { path: '/data/_snapshots/.restore-2026-11-13T05-00-00-000Z', errno: 'EBUSY' },
    }));
    const m = fresh();
    expect((await m.start()).success).toBe(true);
    await tick(5);
    const { restore } = await get(await serve(m));
    expect(restore).toMatchObject({ stage: 'failed', result: 'failed', error: 'The bot did not stop within 60 seconds.', state: 'clear' });
    expect(restore.line).toBe(`The restore of ${NAME} failed before any data was changed: The bot did not stop within 60 seconds. The copy in /data/_snapshots/.restore-2026-11-13T05-00-00-000Z could not be removed (EBUSY); delete that folder. The bot is now running.`);
  });

  it("the placed lines by step 8's note", async () => {
    writeRestoreJournal(journalOf('placed', { placedAt: Date.UTC(2026, 10, 13, 6), note: { cause: 'read', path: '/data/_snapshots/.pre-restore-2026-11-13T05-00-00-000Z/data/123/a.json', errno: 'EACCES' } }));
    const url = await serve();
    expect((await get(url)).restore.line).toBe(`Restored ${NAME} at 2026-11-13 06:00 UTC. The data it replaced is in /data/_snapshots/.${PRE}, but its record cannot be written: /data/_snapshots/.pre-restore-2026-11-13T05-00-00-000Z/data/123/a.json cannot be read (EACCES). Make that file readable by the bot, or move it out of /data/_snapshots and keep it (the pre-restore backup then does not have it); the record is written within a minute after that. No other restore can start until then.`);
    writeRestoreJournal(journalOf('placed', { placedAt: Date.UTC(2026, 10, 13, 6), note: { cause: 'rename', errno: 'EBUSY' } }));
    expect((await get(url)).restore.line).toBe(`Restored ${NAME} at 2026-11-13 06:00 UTC. The data it replaced is in /data/_snapshots/.${PRE}; its record could not be written yet (the folder's rename: EBUSY) and is tried again every minute.`);
  });

  it('a stuck journal gives its stuck text; an unreadable one the can\'t-confirm line', async () => {
    const stuck = journalOf('stuck', { stuckAt: 'placing', path: '123', cause: 'rename', errno: 'EBUSY' });
    writeRestoreJournal(stuck);
    const url = await serve();
    expect((await get(url)).restore).toMatchObject({ state: 'stuck', stage: 'stuck', running: false, line: stuckText(stuck) });
    fs.writeFileSync(restoreJournalPath(), '{"format":1,"stage":');
    expect((await get(url)).restore).toEqual({
      name: null, stage: null, state: 'unknown', cause: 'not valid JSON', running: false, waiting: null, latch: null, line: unreadableLine('not valid JSON'),
    });
  });

  it("a latch with no journal (the staging write) gives the latch's line", async () => {
    const latch: RestoreLatch = { at: 1, name: NAME, kind: 'journal', stage: 'staging', errno: 'EIO' };
    setRestoreLatch(latch);
    const { restore } = await get(await serve());
    expect(restore).toMatchObject({ name: NAME, stage: null, running: false, latch: latchLine(latch), line: latchLine(latch) });
  });
});

describe('POST /api/backups/restore (decisions 13, 25, 51)', () => {
  it.each([
    ['no body', undefined],
    ['no name', {}],
    ['a name that is not a string', { name: 5 }],
    ['an empty name', { name: '' }],
  ])('answers 400 for %s and changes nothing', async (_label, body) => {
    const res = await call(await serve(), 'POST', '/api/backups/restore', body);
    expect(res).toEqual({ status: 400, body: { success: false, error: 'name is required: the name of a backup' } });
    expect(readRestoreJournal()).toEqual({ state: 'none' });
  });

  it('answers 409 for a running bot with nothing written', async () => {
    await snapshot(NAME);
    const m = fresh();
    expect((await m.start()).success).toBe(true);
    await tick(5);
    const res = await call(await serve(m), 'POST', '/api/backups/restore', { name: NAME });
    expect(res).toEqual({ status: 409, body: { success: false, error: 'Stop the bot, or put it in maintenance, before a restore: a running bot would keep writing the data the restore replaces.' } });
    expect(readRestoreJournal()).toEqual({ state: 'none' });
  });
});

describe('PUT /api/backups/settings (decision 13, N4)', () => {
  it('saves a changed setting whose expected value is the stored one', async () => {
    const url = await serve();
    expect(await call(url, 'PUT', '/api/backups/settings', { enabled: false, expected: { enabled: true } })).toEqual({
      status: 200, body: { success: true, settings: { enabled: false, hour: 4 } },
    });
    expect(readSettings()).toEqual({ settings: { enabled: false, hour: 4 }, cause: null });
    expect(await get(url)).toMatchObject({ enabled: false, hour: 4 });
  });

  it('answers 409 with the stored settings when a setting changed elsewhere since, and writes nothing', async () => {
    writeSettings({ enabled: true, hour: 7 });
    const before = fs.readFileSync(settingsPath(), 'utf8');
    const res = await call(await serve(), 'PUT', '/api/backups/settings', { hour: 5, enabled: false, expected: { hour: 4, enabled: true } });
    expect(res).toEqual({
      status: 409,
      body: { success: false, error: 'The backup settings changed since they were read; nothing was saved. Read them again, then save.', settings: { enabled: true, hour: 7 } },
    });
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(before);
  });

  it.each([
    ['an hour of 24', { hour: 24, expected: { hour: 4 } }, 'hour must be a whole number from 0 to 23'],
    ['an hour of 3.5', { hour: 3.5, expected: { hour: 4 } }, 'hour must be a whole number from 0 to 23'],
    ['enabled as text', { enabled: 'yes', expected: { enabled: true } }, 'enabled must be true or false'],
    ['no expected', { hour: 5 }, 'expected is required: the stored value of each setting you change'],
    ['a changed setting missing from expected', { hour: 5, enabled: false, expected: { hour: 4 } }, 'expected is required: the stored value of each setting you change'],
    ['nothing to change', { expected: {} }, 'enabled or hour is required'],
  ])('answers 400 for %s and writes nothing', async (_label, body, error) => {
    const res = await call(await serve(), 'PUT', '/api/backups/settings', body);
    expect(res).toEqual({ status: 400, body: { success: false, error } });
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it("under a set flag answers 500 that the settings can't be confirmed as saved, and GET shows the new settings", async () => {
    writeSettings({ enabled: true, hour: 4 });
    noteFolderSyncFailure(dataPath('123'), 'EIO');
    const flag = folderSyncFlag()!;
    const url = await serve();
    const res = await call(url, 'PUT', '/api/backups/settings', { hour: 6, expected: { hour: 4 } });
    expect(res).toEqual({
      status: 500,
      body: { success: false, error: `The backup settings can't be confirmed as saved: ${writtenUnconfirmedText(settingsPath(), 'earlier', flag.dir, flag.errno)}` },
    });
    expect(await get(url)).toMatchObject({ enabled: true, hour: 6 });
  });

  it('a temp file write that throws EROFS answers 500 that the settings could not be written, and GET shows the old ones', async () => {
    writeSettings({ enabled: true, hour: 4 });
    const realOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags: any, mode?: any) => {
      if (String(p).startsWith(`${settingsPath()}.`) && String(p).endsWith('.tmp')) throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
      return realOpen(p, flags, mode);
    }) as typeof fs.openSync);
    syncBuiltinESMExports();
    const url = await serve();
    const res = await call(url, 'PUT', '/api/backups/settings', { enabled: false, expected: { enabled: true } });
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expect(res).toEqual({ status: 500, body: { success: false, error: 'The backup settings could not be written: EROFS: read-only file system' } });
    expect(await get(url)).toMatchObject({ enabled: true, hour: 4 });
  });
});

describe('GET /api/bot/status carries backups (decision 13)', () => {
  it('answers the alert and whether a restore stands', async () => {
    writeRestoreJournal(journalOf('stuck', { stuckAt: 'placing', path: '123', cause: 'rename', errno: 'EBUSY' }));
    const res = await call(await serve(), 'GET', '/api/bot/status');
    expect(res.body.status.backups).toEqual({ alert: null, restoring: true });
  });
});

describe("postRestore is the route's answer", () => {
  it('a name the route passes is the one postRestore reads', async () => {
    const m = fresh();
    const direct = await postRestore(m, 'hourly-2026-01-01T00-00-00-000Z');
    const routed = await call(await serve(m), 'POST', '/api/backups/restore', { name: 'hourly-2026-01-01T00-00-00-000Z' });
    expect(routed).toEqual({ status: direct.status, body: direct.body });
  });
});
