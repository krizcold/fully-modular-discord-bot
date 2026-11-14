import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB8 test 15, the web UI side (C12, G1, F1, I3, J4, decisions 19 and 32): `backup:take` is a shared-stage message,
// takeSnapshotVia passes the child's answer through or names what it cannot confirm, and a child's
// `disk:folder-sync-failed` reaches noteReportedFolderSyncFailure from any child BotManager forked until its exit and
// disconnect. The child side is nb8Ipc.test.ts. lastRefusal and the words are the scheduler's (part 10b).

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});

import { BotManager, ipcStageOf } from '../../src/webui/botManager';
import { _setBootIdForTests, folderSyncFlag, setDiskRole } from '../../src/bot/internalSetup/utils/folderChain';
import { dataPath } from '../../src/utils/dataRoot';
import { forks, forkStage } from '../helpers/forkMock';
import { answering, exitChild, freshWriterLock, logged, resetForks, sentTo, startedWith, tick } from '../helpers/nb10Rig';

const NAME = 'hourly-2026-11-13T04-00-00-000Z';
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetForks();
  forkStage.stages = [];
  freshWriterLock('webui');
  fs.rmSync(dataPath('_snapshots'), { recursive: true, force: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.useRealTimers();
  for (const child of forks.children) if (child.exitCode === null) exitChild(child, 0);
  vi.restoreAllMocks();
});

describe('backup:take from the web UI (C12, decision 19)', () => {
  it("is a shared-stage message", () => {
    expect(ipcStageOf('backup:take')).toBe('shared');
  });

  it('is sent to a child that reported shared and not guild yet, and its answer passes through', async () => {
    const { manager, child } = await startedWith([{ stage: 'shared' }]);
    const answer = { ok: true, name: NAME, counts: { files: 1, bytes: 2, dirs: 1, guilds: 1, graveyardEntries: 0 }, linked: 0 };
    answering(child, m => (m.type === 'backup:take' ? answer : undefined));
    expect(await manager.takeSnapshotVia({ name: NAME, kind: 'hourly' })).toEqual(answer);
    expect(sentTo(child, 'backup:take').map(m => m.data)).toEqual([{ name: NAME, kind: 'hourly' }]);
  });

  it.each([
    [{ ok: false, stopping: true }],
    [{ ok: false, busy: true }],
    [{ ok: false, lockLost: true, words: "the data files' lock (/data/.writer.lock) was removed or changed during the backup." }],
    [{ ok: false, error: 'Could not read /data/123/a.json (EIO); the backup was not kept.' }],
  ])('passes the answer %j through', async answer => {
    const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
    answering(child, () => answer);
    expect(await manager.takeSnapshotVia({ name: NAME, kind: 'hourly' })).toEqual(answer);
  });

  it("answers can't confirm when the child exits before its answer", async () => {
    const { manager, child } = await startedWith([{ stage: 'guild' }]);
    answering(child, () => undefined);
    const pending = manager.takeSnapshotVia({ name: NAME, kind: 'hourly' });
    exitChild(child, 1);
    expect(await pending).toEqual({ ok: false, unknown: true, error: "can't confirm whether the backup was taken: the bot stopped before answering." });
  });

  it("answers can't confirm after 12 minutes with no answer", async () => {
    const { manager, child } = await startedWith([{ stage: 'guild' }]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    answering(child, () => undefined);
    const pending = manager.takeSnapshotVia({ name: NAME, kind: 'hourly' });
    await vi.advanceTimersByTimeAsync(12 * 60_000 - 10);
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toEqual({ ok: false, unknown: true, error: "can't confirm whether the backup was taken: the bot did not answer within 12 minutes." });
  });
});

describe("a child's disk error report (G1, F1, I3, J4)", () => {
  const report = (child: any, at: number) => child.emit('message', { type: 'disk:folder-sync-failed', data: { dir: '/data/123', errno: 'EIO', at } });

  it("the current child's report makes the web UI write the record with by bot", async () => {
    _setBootIdForTests('b1');
    setDiskRole('web panel');
    const { child } = await startedWith([{ stage: 'guild' }]);
    report(child, 1_700_000_000_000);
    expect(folderSyncFlag()).toEqual({ dir: '/data/123', errno: 'EIO', at: 1_700_000_000_000, by: 'bot', source: 'report', file: dataPath('_snapshots', 'disk-error-b1.json') });
    expect(JSON.parse(fs.readFileSync(dataPath('_snapshots', 'disk-error-b1.json'), 'utf8'))).toEqual({ format: 1, bootId: 'b1', folder: '/data/123', errno: 'EIO', at: 1_700_000_000_000, by: 'bot' });
    expect(logged(warn)).toEqual([
      "[Backup] The bot reported a disk error when /data/123 was synced (EIO); no backup is taken and no restore starts until the machine the bot runs on is restarted (a restart of the bot's container is not enough after a disk error)",
    ]);
  });

  it('a report a previous child sends after its exit, before its channel closed, is taken', async () => {
    _setBootIdForTests('b1');
    setDiskRole('web panel');
    const { child } = await startedWith([{ stage: 'guild' }]);
    child.connected = true;
    exitChild(child, 0);
    await tick();
    report(child, 1_700_000_000_001);
    expect(folderSyncFlag()).toMatchObject({ source: 'report', by: 'bot', at: 1_700_000_000_001 });
  });

  it('a report from a child whose exit and disconnect were both seen is not taken', async () => {
    _setBootIdForTests('b1');
    setDiskRole('web panel');
    const { child } = await startedWith([{ stage: 'guild' }]);
    child.connected = false;
    exitChild(child, 0);
    child.emit('disconnect');
    report(child, 1_700_000_000_002);
    expect(folderSyncFlag()).toBeNull();
  });

  it('a report with a field missing changes nothing', async () => {
    const { child } = await startedWith([{ stage: 'guild' }]);
    child.emit('message', { type: 'disk:folder-sync-failed', data: { dir: '/data/123', errno: 'EIO' } });
    expect(folderSyncFlag()).toBeNull();
  });
});
