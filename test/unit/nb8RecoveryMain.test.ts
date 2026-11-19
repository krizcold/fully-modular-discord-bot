import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB8 test 13, main()'s rows (decisions 44, 49, 58, 62, 67, N6, K6): src/index.ts loaded afresh with a stand-in web UI
// and a real BotManager over forkMock children. main() sets its disk role and removes other boots' records first, reads
// the journal before the populate, skips the populate while the restore stands, and starts the bot with recovery's op
// as its own once recovery ends; in safe mode it starts nothing and logs the safe-mode line.

const h = vi.hoisted(() => ({ webStarted: 0 }));
const safety = vi.hoisted(() => ({ recordCrash: () => undefined, isInSafeMode: () => false, getStatus: () => ({}), validateHealth: async () => undefined }));
vi.mock('tsconfig-paths', () => ({ register: () => undefined }));
vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/webui/utils/logCapture', () => ({ initLogCapture: () => undefined }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/webui', () => ({
  startWebUI: async () => { h.webStarted += 1; },
  flushBeforeExit: async () => undefined,
}));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});

import { dataPath } from '../../src/utils/dataRoot';
import { forks } from '../helpers/forkMock';
import { exitChild, logged, resetForks } from '../helpers/nb10Rig';

const NAME = 'hourly-2026-11-13T04-00-00-000Z';
let logs: ReturnType<typeof vi.spyOn>;
let warns: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;
const lines = (): string[] => [...logged(logs), ...logged(warns), ...logged(errors)];
const fatal = (): string[] => lines().filter(l => l.startsWith('[Main] Fatal error'));

/** A journal as postRestore writes it at `staged`, with its staging copy. */
async function stagedJournal(): Promise<void> {
  const { writeRestoreJournal } = await import('../../src/webui/backups/state');
  fs.mkdirSync(dataPath('_snapshots', '.restore-t', 'data', '123'), { recursive: true });
  writeRestoreJournal({ format: 1, name: NAME, startedAt: 1, stage: 'staged', staging: '.restore-t', preRestore: 'pre-restore-t' });
}

async function runMain(): Promise<{ starts: unknown[][] }> {
  const { BotManager } = await import('../../src/webui/botManager');
  const start = vi.spyOn(BotManager.prototype, 'start');
  await import('../../src/index');
  await vi.waitFor(() => expect(logged(logs).includes('  System Ready') || fatal().length > 0).toBe(true), { timeout: 10_000, interval: 10 });
  return { starts: start.mock.calls };
}

beforeEach(() => {
  vi.resetModules();
  for (const e of fs.readdirSync(dataPath())) fs.rmSync(dataPath(e), { recursive: true, force: true });
  resetForks();
  h.webStarted = 0;
  logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
  const realOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...a: any[]) => unknown) => {
    if (event === 'SIGTERM' || event === 'SIGINT' || event === 'exit') return process;
    return realOn(event as any, handler);
  }) as typeof process.on);
});

afterEach(async () => {
  const argv = process.argv.indexOf('--safe-mode');
  if (argv >= 0) process.argv.splice(argv, 1);
  for (const child of forks.children) if (child.exitCode === null && child.signalCode === null) exitChild(child, 0);
  const lock = await import('../../src/bot/internalSetup/utils/writerLock');
  while (lock.writerLockDepth() > 0) lock.releaseWriterLock();
  vi.restoreAllMocks();
});

describe("main()'s recovery", () => {
  it('ends a staged restore failed before the bot starts, skips the populate, and starts the bot with its op as its own', async () => {
    await stagedJournal();
    const { starts } = await runMain();
    const { readRestoreJournal } = await import('../../src/bot/internalSetup/utils/backups/restoreJournal');
    const { restoreOp } = await import('../../src/webui/backups/restoreState');
    const read = readRestoreJournal();
    expect(read).toMatchObject({ state: 'read', journal: { stage: 'failed', error: 'The restore was interrupted before any data was changed.' } });
    expect(fs.existsSync(dataPath('_snapshots', '.restore-t'))).toBe(false);
    expect(lines()).toContain('[Main] Skipped populating config.json: a backup restore is running or did not finish; the bot populates it at its start');
    expect(starts).toHaveLength(1);
    expect(starts[0][0]).toMatchObject({ restoreOp: { kind: 'recovery', name: NAME } });
    expect(forks.children).toHaveLength(1);
    expect(restoreOp()).toBeNull();
    expect(h.webStarted).toBe(1);
  });

  it("an unreadable journal: the populate's skip line names its cause, and once it is removed main() starts the bot", async () => {
    fs.mkdirSync(dataPath('_snapshots'), { recursive: true });
    fs.writeFileSync(dataPath('_snapshots', 'restore.json'), '{"format":1');
    setTimeout(() => fs.rmSync(dataPath('_snapshots', 'restore.json')), 300);
    const { starts } = await runMain();
    expect(lines()).toContain("[Main] Skipped populating config.json: can't confirm whether a backup restore is running (/data/_snapshots/restore.json: not valid JSON); the bot populates it at its start");
    expect(starts).toHaveLength(1);
    expect(forks.children).toHaveLength(1);
  });

  it('in safe mode: recovery runs, no start, restoreOp cleared and the safe-mode line logged', async () => {
    process.argv.push('--safe-mode');
    await stagedJournal();
    const { starts } = await runMain();
    const { restoreOp } = await import('../../src/webui/backups/restoreState');
    expect(starts).toHaveLength(0);
    expect(restoreOp()).toBeNull();
    expect(lines()).toContain("[Main] [Warning] Safe mode: the backup restore's recovery ended (the restore ended failed with the data unchanged); the bot was not started and waits for a manual start");
  });

  it("a latch in recovery: main() logs its skip line and starts nothing", async () => {
    await stagedJournal();
    fs.mkdirSync(dataPath('_snapshots', '.restore-t', 'data', '123', 'x'), { recursive: true });
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === dataPath('_snapshots', 'restore.json')) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return real(from, to);
    }) as typeof fs.renameSync);
    (await import('module')).syncBuiltinESMExports();
    const { starts } = await runMain();
    vi.mocked(fs.renameSync).mockRestore();
    (await import('module')).syncBuiltinESMExports();
    expect(starts).toHaveLength(0);
    expect(lines()).toContain('[Main] Bot not started: the backup restore could not finish; the Dashboard tab says what to do');
  });

  it("sets the web panel's role first: another boot's record is removed and this boot's sets the flag", async () => {
    const chain0 = await import('../../src/bot/internalSetup/utils/folderChain');
    chain0._setBootIdForTests('b0');
    chain0.setDiskRole('bot');
    chain0.noteFolderSyncFailure(dataPath('global'), 'EIO');
    chain0.resetFolderSyncFailureForTests();
    chain0._setBootIdForTests('b1');
    chain0.setDiskRole('bot');
    chain0.noteFolderSyncFailure(dataPath('123'), 'EIO');
    chain0.resetFolderSyncFailureForTests();
    expect(fs.readdirSync(dataPath('_snapshots')).sort()).toEqual(['disk-error-b0.json', 'disk-error-b1.json']);
    vi.resetModules();
    const chain = await import('../../src/bot/internalSetup/utils/folderChain');
    chain._setBootIdForTests('b1');
    await runMain();
    expect(fs.readdirSync(dataPath('_snapshots'))).toEqual(['disk-error-b1.json']);
    expect(chain.folderSyncFlag()).toMatchObject({ source: 'record', dir: '/data/123', errno: 'EIO' });
    expect(chain.diskRecord()).toMatchObject({ files: [dataPath('_snapshots', 'disk-error-b1.json')] });
  });

  it('in safe mode, exiting during the wait for the lock writes no safe-mode line and starts nothing (decision 67)', async () => {
    process.argv.push('--safe-mode');
    await stagedJournal();
    const { BotManager } = await import('../../src/webui/botManager');
    let exiting = false;
    vi.spyOn(BotManager.prototype, 'isExiting').mockImplementation(() => exiting);
    vi.spyOn(BotManager.prototype, 'runRestoreOp').mockImplementation(async () => {
      setTimeout(() => { exiting = true; }, 50);
      return { taken: false, take: { kind: 'contended' } } as any;
    });
    const { starts } = await runMain();
    const { readRestoreJournal } = await import('../../src/bot/internalSetup/utils/backups/restoreJournal');
    const { restoreOp } = await import('../../src/webui/backups/restoreState');
    expect(fatal()).toEqual([]);
    expect(lines()).toContain(`[Backup] Restore of ${NAME} waits: another process is taking the data files at this moment; it goes on as soon as that ends`);
    expect(lines().filter(l => l.includes("Safe mode: the backup restore's recovery ended"))).toEqual([]);
    expect(starts).toHaveLength(0);
    expect(restoreOp()).toBeNull();
    expect(readRestoreJournal()).toMatchObject({ state: 'read', journal: { stage: 'staged' } });
  });

  it("in safe mode, recovery that ends placed clears the op: GET's restore runs nothing and a POST reaches its checks", async () => {
    process.argv.push('--safe-mode');
    const { writeRestoreJournal } = await import('../../src/webui/backups/state');
    fs.mkdirSync(dataPath('_snapshots', '.pre-restore-t', 'data', '123'), { recursive: true });
    fs.writeFileSync(dataPath('_snapshots', '.pre-restore-t', 'data', '123', 'a.json'), '{"v":"old"}');
    fs.mkdirSync(dataPath('123'), { recursive: true });
    fs.writeFileSync(dataPath('123', 'a.json'), '{"v":"new"}');
    writeRestoreJournal({ format: 1, name: NAME, startedAt: 1, stage: 'placing', staging: '.restore-t', preRestore: 'pre-restore-t', aside: ['123'] });
    const { starts } = await runMain();
    const restore = await import('../../src/webui/backups/restore');
    const { BotManager } = await import('../../src/webui/botManager');
    const { readRestoreJournal } = await import('../../src/bot/internalSetup/utils/backups/restoreJournal');
    expect(fatal()).toEqual([]);
    expect(readRestoreJournal()).toMatchObject({ state: 'read', journal: { stage: 'placed' } });
    expect(starts).toHaveLength(0);
    expect(lines()).toContain("[Main] [Warning] Safe mode: the backup restore's recovery ended (the data is in place); the bot was not started and waits for a manual start");
    expect(restore.restoreView(new BotManager())).toMatchObject({ name: NAME, stage: 'placed', running: false });
    expect(await restore.postRestore(new BotManager(), NAME)).toEqual({ status: 409, body: { success: false, error: 'The last restore is still recording the data it replaced; try again in a minute.' } });
  });
});

// Code review 3, A1: a throw out of recovery's step (EIO from lstat in each phase's exists(), or from readdir in
// topItems(staging)) leaves the journal as it is; main() goes on, start() refuses with the stuck text, and the panel
// serves.
describe("main()'s recovery when its step throws", () => {
  const writeFile = (rel: string[], text: string) => {
    fs.mkdirSync(dataPath(...rel.slice(0, -1)), { recursive: true });
    fs.writeFileSync(dataPath(...rel), text);
  };
  const cases: Array<[string, () => Promise<{ call: 'lstatSync' | 'readdirSync'; at: string }>]> = [
    ["nothingMoved's exists()", async () => {
      const { writeRestoreJournal } = await import('../../src/webui/backups/state');
      writeFile(['123', 'a.json'], '{"v":"new"}');
      writeFile(['_snapshots', '.restore-t', 'data', '123', 'a.json'], '{"v":"old"}');
      writeRestoreJournal({ format: 1, name: NAME, startedAt: 1, stage: 'swapping', staging: '.restore-t', preRestore: 'pre-restore-t', aside: ['123'] });
      return { call: 'lstatSync', at: dataPath('_snapshots', '.pre-restore-t', 'data', '123') };
    }],
    ["phase A's exists()", async () => {
      const { writeRestoreJournal } = await import('../../src/webui/backups/state');
      writeFile(['456', 'b.json'], '{"b":"new"}');
      writeFile(['_snapshots', '.pre-restore-t', 'data', '123', 'a.json'], '{"v":"new"}');
      writeFile(['_snapshots', '.restore-t', 'data', '123', 'a.json'], '{"v":"old"}');
      writeRestoreJournal({ format: 1, name: NAME, startedAt: 1, stage: 'swapping', staging: '.restore-t', preRestore: 'pre-restore-t', aside: ['123', '456'] });
      return { call: 'lstatSync', at: dataPath('_snapshots', '.pre-restore-t', 'data', '456') };
    }],
    ["phase B's exists()", async () => {
      const { writeRestoreJournal } = await import('../../src/webui/backups/state');
      writeFile(['_snapshots', '.pre-restore-t', 'data', '123', 'a.json'], '{"v":"new"}');
      writeFile(['_snapshots', '.restore-t', 'data', '123', 'a.json'], '{"v":"old"}');
      writeRestoreJournal({ format: 1, name: NAME, startedAt: 1, stage: 'placing', staging: '.restore-t', preRestore: 'pre-restore-t', aside: ['123'] });
      return { call: 'lstatSync', at: dataPath('_snapshots', '.restore-t', 'data') };
    }],
    ['readdir in topItems(staging)', async () => {
      const { writeRestoreJournal } = await import('../../src/webui/backups/state');
      writeFile(['_snapshots', '.pre-restore-t', 'data', '123', 'a.json'], '{"v":"new"}');
      writeFile(['_snapshots', '.restore-t', 'data', '123', 'a.json'], '{"v":"old"}');
      writeRestoreJournal({ format: 1, name: NAME, startedAt: 1, stage: 'placing', staging: '.restore-t', preRestore: 'pre-restore-t', aside: ['123'] });
      return { call: 'readdirSync', at: dataPath('_snapshots', '.restore-t', 'data') };
    }],
  ];

  it.each(cases)('EIO from %s: main() resolves with no fatal error, the journal unchanged, and the bot not started', async (_row, setup) => {
    const { call, at } = await setup();
    const before = fs.readFileSync(dataPath('_snapshots', 'restore.json'), 'utf8');
    const real = fs[call] as (...a: any[]) => any;
    const hits: string[] = [];
    vi.spyOn(fs, call).mockImplementation(((p: fs.PathLike, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(at)) {
        hits.push(String(p));
        throw Object.assign(new Error('EIO: stubbed'), { code: 'EIO' });
      }
      return real(p, ...rest);
    }) as any);
    (await import('module')).syncBuiltinESMExports();
    const { starts } = await runMain();
    vi.mocked(fs[call]).mockRestore();
    (await import('module')).syncBuiltinESMExports();
    const { restoreOp } = await import('../../src/webui/backups/restoreState');
    expect(hits.length).toBeGreaterThan(0);
    expect(fatal()).toEqual([]);
    expect(logged(logs)).toContain('  System Ready');
    expect(lines()).toContain(`[Backup] Restore of ${NAME} stopped: EIO: stubbed; the next start of the bot's container takes it up from its record`);
    expect(fs.readFileSync(dataPath('_snapshots', 'restore.json'), 'utf8')).toBe(before);
    expect(starts).toHaveLength(1);
    expect(forks.children).toHaveLength(0);
    expect(lines()).toContain('[Main] [Error] Bot failed to start: The last backup restore stopped part way, so the bot does not start; the Dashboard tab says what to do.');
    expect(restoreOp()).toBeNull();
  });

  it('in safe mode, the same throw at placing logs the part-way safe-mode line (code review 4, A4-2)', async () => {
    process.argv.push('--safe-mode');
    const [, setup] = cases[2];
    const { call, at } = await setup();
    const real = fs[call] as (...a: any[]) => any;
    vi.spyOn(fs, call).mockImplementation(((p: fs.PathLike, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(at)) throw Object.assign(new Error('EIO: stubbed'), { code: 'EIO' });
      return real(p, ...rest);
    }) as any);
    (await import('module')).syncBuiltinESMExports();
    const { starts } = await runMain();
    vi.mocked(fs[call]).mockRestore();
    (await import('module')).syncBuiltinESMExports();
    expect(fatal()).toEqual([]);
    expect(starts).toHaveLength(0);
    expect(lines()).toContain("[Main] [Warning] Safe mode: the backup restore's recovery ended (the restore stopped part way, and the Dashboard tab says what to do); the bot was not started and waits for a manual start");
  });
});
