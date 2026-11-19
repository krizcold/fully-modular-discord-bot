import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB8 test 22 (decisions 18, 19, 38, 41, 52, 54, 60, C20, N5): the web UI's local take. Pass 1 and the catch-ups run
// outside the chain after a probe that takes no lock; the final op is queued only on `local` and holds the lock for one
// walk, bounded at 60 s, ending at `exiting`; the lock is checked at its end; the syncs, the manifest and the rename run
// after it. A real BotManager with no child (or a forkMock child), the real writer lock under the test's data folder.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
const h = vi.hoisted(() => ({ onSync: null as null | ((dir: string) => void) }));
vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return { ...real, syncFolder: (dir: string) => { h.onSync?.(dir); return real.syncFolder(dir); } };
});

import { BotManager } from '../../src/webui/botManager';
import { _setTakeTimingForTests, takeSnapshotLocal, type TakeAnswer } from '../../src/bot/internalSetup/utils/backups/snapshotTake';
import { noteFolderSyncFailure, timeText } from '../../src/bot/internalSetup/utils/folderChain';
import { releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { ProcessLock } from '../../src/bot/internalSetup/utils/processLock';
import { dataPath } from '../../src/utils/dataRoot';
import { forks, forkStage } from '../helpers/forkMock';
import { exitChild, freshWriterLock, resetForks, sentTo, tick } from '../helpers/nb10Rig';

let n = 0;
const nextName = () => `hourly-2026-11-12T${String(++n).padStart(2, '0')}-00-00-000Z`;
const seams = { pid: () => process.pid, alive: () => true, startOf: (pid: number) => `start-${pid}`, now: () => Date.now() };
const managers: BotManager[] = [];
const snapshotFolders = () => fs.readdirSync(dataPath('_snapshots')).filter(x => !x.endsWith('.json'));

function fresh(): BotManager {
  const m = new BotManager();
  managers.push(m);
  return m;
}

/** Runs `fn` at each lstat of the live data, with the writer lock's depth at that call (1 inside the final op). */
function onLiveLstat(fn: (abs: string, depth: number) => unknown): void {
  const real = fs.promises.lstat.bind(fs.promises);
  vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: any, ...rest: any[]) => {
    const abs = path.resolve(String(p));
    if (!abs.startsWith(path.resolve(dataPath('_snapshots'))) && abs.startsWith(path.resolve(dataPath()))) await fn(abs, writerLockDepth());
    return (real as any)(p, ...rest);
  }) as any);
}

const refused = (words: string) => ({ ok: false, refused: true, words, startedAt: expect.any(Number) });

beforeEach(() => {
  for (const e of fs.readdirSync(dataPath())) fs.rmSync(dataPath(e), { recursive: true, force: true });
  fs.mkdirSync(dataPath('123', 'mod'), { recursive: true });
  fs.writeFileSync(dataPath('123', 'mod', 'a.json'), '{"a":1}');
  fs.writeFileSync(dataPath('123', 'mod', 'b.json'), '{"b":1}');
  resetForks();
  forkStage.stages = [];
  freshWriterLock('webui');
  _setTakeTimingForTests({ pollMs: 5 }, seams);
  h.onSync = null;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const m of managers.splice(0)) m.cancelCrashRestart();
  for (const child of forks.children) if (child.exitCode === null) exitChild(child, 0);
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  _setTakeTimingForTests();
});

describe("the web UI's local take", () => {
  it('takes no lock before the final op, takes it for the final walk only, and the chain releases it', async () => {
    const manager = fresh();
    const depths: number[] = [];
    let otherTook: string | null = null;
    const reads = vi.spyOn(fs, 'readFileSync');
    syncBuiltinESMExports();
    onLiveLstat((_abs, depth) => {
      depths.push(depth);
      if (otherTook === null) {
        const other = new ProcessLock({ lockPath: writerLockPath(), takeoverPath: `${writerLockPath()}.takeover`, unparsableStaleMs: 10_000, takeoverStaleMs: 5_000, seams: { ...seams, pid: () => 999_999 } });
        otherTook = other.tryTake().kind;
        other.release();
      }
    });
    const name = nextName();
    const answer = await takeSnapshotLocal({ name, kind: 'hourly' }, manager);
    expect(answer).toMatchObject({ ok: true, name, counts: { files: 2, guilds: 1 } });
    expect(otherTook).toBe('taken');
    expect(depths).toContain(0);
    expect(depths).toContain(1);
    expect(fs.existsSync(writerLockPath())).toBe(false);
    expect(writerLockDepth()).toBe(0);
    expect(reads.mock.calls.some(c => String(c[0]) === '/data/.writer.lock')).toBe(false);
  });

  it("a probe that answers starting before a catch-up ends the take with no attempt and no staging", async () => {
    const manager = fresh();
    let forked = false;
    onLiveLstat(() => {
      if (!forked) {
        forked = true;
        void manager.start();
      }
    });
    const answer = await takeSnapshotLocal({ name: nextName(), kind: 'hourly' }, manager);
    expect(answer).toEqual(refused('the bot was starting and had not opened its data files yet.'));
    expect(snapshotFolders()).toEqual([]);
  });

  it('a fake import that takes the lock during pass 1 is named by the probe before a catch-up', async () => {
    const manager = fresh();
    freshWriterLock('webui', new Set([process.pid, 4242]));
    let held = false;
    onLiveLstat(() => {
      if (!held) {
        held = true;
        fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 4242, start: null, role: 'import', at: Date.now() }));
      }
    });
    const answer = await takeSnapshotLocal({ name: nextName(), kind: 'hourly' }, manager);
    expect(answer).toEqual(refused('another process held the data files (a data bundle import, pid 4242).'));
    expect(snapshotFolders()).toEqual([]);
  });

  it('the final op queued behind another op and re-routed starting after a fork ends the take', async () => {
    const manager = fresh();
    let release!: () => void;
    const blocker = manager.runLocalOp('block', () => new Promise(resolve => { release = () => resolve({ ok: true }); }));
    _setTakeTimingForTests({
      pollMs: 5,
      beforeTurn: async () => {
        setTimeout(() => {
          void manager.start();
          release();
        }, 20);
      },
    }, seams);
    const answer = await takeSnapshotLocal({ name: nextName(), kind: 'hourly' }, manager);
    await blocker;
    expect(answer).toEqual(refused('the bot was starting and had not opened its data files yet.'));
    expect(snapshotFolders()).toEqual([]);
  });

  it("writerRoute answering child for the final op sends nothing and records the final pass's words", async () => {
    const manager = fresh();
    forkStage.stages = ['shared', 'guild'];
    _setTakeTimingForTests({
      pollMs: 5,
      beforeTurn: async () => {
        await manager.start();
        await tick(10);
      },
    }, seams);
    const answer = await takeSnapshotLocal({ name: nextName(), kind: 'hourly' }, manager);
    expect(answer).toEqual(refused("the bot was started during the backup's final pass."));
    const child = forks.children.at(-1);
    expect(sentTo(child).filter(m => m.type === 'shared:op' || m.type === 'backup:take')).toEqual([]);
    expect(snapshotFolders()).toEqual([]);
  });

  it('the final op past its bound fails with its text, and the lock is released', async () => {
    const manager = fresh();
    _setTakeTimingForTests({ pollMs: 5, finalMs: 60 }, seams);
    onLiveLstat((_abs, depth) => (depth === 1 ? new Promise(() => undefined) : undefined));
    const answer = await takeSnapshotLocal({ name: nextName(), kind: 'hourly' }, manager);
    expect(answer).toEqual({ ok: false, error: "The backup's final pass took longer than 60 seconds while it held the data files, so it was stopped; the backup was not kept." });
    await tick(20);
    expect(fs.existsSync(writerLockPath())).toBe(false);
    expect(snapshotFolders()).toEqual([]);
  });

  it('exiting set during the final walk ends it within one entry, with no attempt', async () => {
    const manager = fresh();
    let after = -1;
    onLiveLstat((_abs, depth) => {
      if (depth !== 1) return;
      if (after < 0) {
        manager.beginExit();
        after = 0;
      } else {
        after += 1;
      }
    });
    const answer = await takeSnapshotLocal({ name: nextName(), kind: 'hourly' }, manager);
    expect(answer).toEqual(refused('the web panel was shutting down.'));
    expect(after).toBeLessThanOrEqual(1);
    expect(snapshotFolders()).toEqual([]);
  });

  it('an op queued behind the final op runs after it, while the take still syncs its folders', async () => {
    const manager = fresh();
    const order: string[] = [];
    let answered = false;
    let queued: Promise<unknown> | null = null;
    onLiveLstat((_abs, depth) => {
      if (depth === 1 && !queued) queued = manager.runLocalOp('after', async () => { order.push(answered ? 'op after the answer' : 'op'); return { ok: true }; });
    });
    h.onSync = () => { if (!order.includes('sync')) order.push('sync'); };
    const answer: TakeAnswer = await takeSnapshotLocal({ name: nextName(), kind: 'hourly' }, manager).then(a => { answered = true; return a; });
    await queued;
    expect(answer.ok).toBe(true);
    expect(order).toContain('op');
    expect(order).not.toContain('op after the answer');
  });

  it("the lock rewritten during the final walk gives no attempt with the lock words", async () => {
    const manager = fresh();
    let done = false;
    onLiveLstat((_abs, depth) => {
      if (depth === 1 && !done) {
        done = true;
        fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: process.pid, start: null, role: 'webui', at: 1 }));
      }
    });
    const answer = await takeSnapshotLocal({ name: nextName(), kind: 'hourly' }, manager);
    expect(answer).toEqual(refused("the data files' lock (/data/.writer.lock) was removed or changed during the backup."));
    expect(snapshotFolders()).toEqual([]);
  });

  it("an unreadable lock at the op's end gives the web panel's can't-confirm words", async () => {
    const manager = fresh();
    let armed = false;
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (armed && path.resolve(String(p)) === path.resolve(writerLockPath())) {
        armed = false;
        throw Object.assign(new Error('EACCES: stubbed'), { code: 'EACCES' });
      }
      return (real as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    onLiveLstat((_abs, depth) => { if (depth === 1) armed = true; });
    const answer = await takeSnapshotLocal({ name: nextName(), kind: 'hourly' }, manager);
    expect(answer).toEqual(refused("can't confirm the web panel still held the data files (/data/.writer.lock: EACCES)."));
  });

  it("a folder sync error flagged during the final op fails the take with the disk text, nothing kept", async () => {
    const manager = fresh();
    let at = 0;
    onLiveLstat((_abs, depth) => {
      if (depth === 1 && at === 0) {
        noteFolderSyncFailure(dataPath('123'), 'EIO');
        at = Date.now();
      }
    });
    const answer = await takeSnapshotLocal({ name: nextName(), kind: 'hourly' }, manager);
    expect((answer as { error: string }).error).toMatch(/^The disk reported an error when \/data\/123 was synced at .+ UTC \(EIO\), so can't confirm the backup is on disk; the backup was not kept\.$/);
    expect((answer as { error: string }).error).toContain(timeText(at).slice(0, 13));
    expect(snapshotFolders()).toEqual([]);
  });
});
