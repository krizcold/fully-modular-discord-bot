import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB8 test 8's web UI rows (decisions 18, 38, 39, 41): a writer whose local ops write A, then B, each with one counter,
// around the local take's pass 1 and its final op; a guild an import replaces between pass 1 and the final op; Q3.

const safety = vi.hoisted(() => ({ recordCrash: () => undefined, isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager } from '../../src/webui/botManager';
import { _setTakeTimingForTests, takeSnapshotLocal } from '../../src/bot/internalSetup/utils/backups/snapshotTake';
import { readSnapshot } from '../../src/bot/internalSetup/utils/backups/snapshotList';
import { verifyTree } from '../../src/bot/internalSetup/utils/backups/snapshotVerify';
import { enqueueWrite, flushAll } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { configureWriterLock, releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { ProcessLock } from '../../src/bot/internalSetup/utils/processLock';
import { dataPath } from '../../src/utils/dataRoot';

const seams = { pid: () => process.pid, alive: () => true, startOf: (pid: number) => `start-${pid}`, now: () => Date.now() };
const A = () => dataPath('123', 'premium.json');
const B = () => dataPath('123', 'premium-events.json');
let hour = 0;
const nextName = () => `hourly-${new Date(Date.UTC(2026, 10, 14) + ++hour * 3600_000).toISOString().replace(/[:.]/g, '-')}`;
const managers: BotManager[] = [];
const realLstat = fs.promises.lstat.bind(fs.promises);
const under = (p: unknown, dir: string) => path.resolve(String(p)).startsWith(path.resolve(dir) + path.sep);

function counters(name: string): { a: number; b: number } {
  const read = (p: string) => JSON.parse(fs.readFileSync(path.join(dataPath('_snapshots'), name, 'data', path.relative(dataPath(), p)), 'utf8')).n as number;
  return { a: read(A()), b: read(B()) };
}

async function snapshotOf(name: string) {
  const entry = readSnapshot(name);
  if (entry.state !== 'complete') throw new Error(`not complete: ${JSON.stringify(entry)}`);
  return { manifest: entry.manifest, verdict: await verifyTree(path.join(dataPath('_snapshots'), name, 'data'), entry.manifest) };
}

function local(beforeTurn?: () => unknown) {
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  configureWriterLock('webui', seams);
  _setTakeTimingForTests({ pollMs: 5, beforeTurn }, seams);
  const manager = new BotManager();
  managers.push(manager);
  const write = (p: string, n: number) => manager.runLocalOp('write', async () => {
    enqueueWrite(p, JSON.stringify({ n }));
    await flushAll();
    return { ok: true };
  });
  return { manager, write };
}

/** Runs `fn` at each lstat of the live data, with the writer lock's depth at that call (1 inside the final op). */
function onLiveLstat(fn: (depth: number) => unknown): void {
  vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: any, ...rest: any[]) => {
    if (under(p, dataPath()) && !under(p, dataPath('_snapshots'))) await fn(writerLockDepth());
    return (realLstat as any)(p, ...rest);
  }) as any);
}

beforeEach(() => {
  for (const e of fs.readdirSync(dataPath())) fs.rmSync(dataPath(e), { recursive: true, force: true });
  fs.mkdirSync(dataPath('123'), { recursive: true });
  fs.writeFileSync(A(), '{"n":0}');
  fs.writeFileSync(B(), '{"n":0}');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const m of managers.splice(0)) m.cancelCrashRestart();
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  _setTakeTimingForTests();
});

describe("the web UI's local take", () => {
  it('property: writes before pass 1 ends, queued ahead of the final op and queued during it never leave B ahead of A', async () => {
    await fc.assert(
      fc.asyncProperty(fc.tuple(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 3 })), async ([inPass1, ahead, during]) => {
        fs.rmSync(dataPath('_snapshots'), { recursive: true, force: true });
        fs.writeFileSync(A(), '{"n":0}');
        fs.writeFileSync(B(), '{"n":0}');
        let step = 0;
        const queued: Promise<unknown>[] = [];
        const queue = (count: number) => {
          for (let i = 0; i < count; i++) {
            step += 1;
            queued.push(m.write(step % 2 === 1 ? A() : B(), Math.ceil(step / 2)));
          }
        };
        const m = local(() => queue(ahead));
        let pass1 = false;
        let final = false;
        onLiveLstat(async depth => {
          if (depth === 0 && !pass1) {
            pass1 = true;
            queue(inPass1);
            await Promise.all(queued);
          }
          if (depth === 1 && !final) {
            final = true;
            queue(during);
          }
        });
        const name = nextName();
        const answer = await takeSnapshotLocal({ name, kind: 'hourly' }, m.manager);
        await Promise.all(queued);
        expect(answer).toMatchObject({ ok: true });
        const c = counters(name);
        expect(c.a).toBeGreaterThanOrEqual(c.b);
        expect(c.a - c.b).toBeLessThanOrEqual(1);
      }),
      { numRuns: 15 },
    );
  });

  it('a guild replaced by an import holding the lock between pass 1 and the final op is in the snapshot once, as replaced', async () => {
    const m = local(() => {
      const other = new ProcessLock({ lockPath: writerLockPath(), takeoverPath: `${writerLockPath()}.takeover`, unparsableStaleMs: 10_000, takeoverStaleMs: 5_000, seams: { ...seams, pid: () => 999_999 } });
      expect(other.tryTake().kind).toBe('taken');
      const stage = dataPath('_snapshots', 'import-stage');
      fs.mkdirSync(stage, { recursive: true });
      fs.writeFileSync(path.join(stage, 'premium.json'), '{"n":7}');
      fs.writeFileSync(path.join(stage, 'fresh.json'), '{"fresh":1}');
      fs.renameSync(dataPath('123'), dataPath('_snapshots', 'import-old'));
      fs.renameSync(stage, dataPath('123'));
      fs.rmSync(dataPath('_snapshots', 'import-old'), { recursive: true, force: true });
      other.release();
    });
    const name = nextName();
    const answer = await takeSnapshotLocal({ name, kind: 'hourly' }, m.manager);
    const got = await snapshotOf(name);
    expect(answer).toMatchObject({ ok: true });
    expect(got.verdict).toEqual({ ok: true });
    expect(got.manifest.files.map(f => f.path)).toEqual(['123/fresh.json', '123/premium.json']);
    expect(got.manifest.counts.guilds).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(dataPath('_snapshots'), name, 'data', '123', 'premium.json'), 'utf8')).n).toBe(7);
  });

  // Windows refuses a rename over a file another handle holds open, so the local op cannot replace it there.
  it.skipIf(process.platform === 'win32')('Q3: a local op that replaces a file while pass 1 copies it leaves the new bytes in the snapshot', async () => {
    const m = local();
    let replaced = false;
    let live: number | null = null;
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags: any, ...rest: any[]) => {
      const handle = await realOpen(p, flags, ...rest);
      if (!replaced && flags === 'r' && path.resolve(String(p)) === path.resolve(A()) && writerLockDepth() === 0) {
        replaced = true;
        await m.write(A(), 5);
        live = JSON.parse(fs.readFileSync(A(), 'utf8')).n;
      }
      return handle;
    }) as any);
    const name = nextName();
    const answer = await takeSnapshotLocal({ name, kind: 'hourly' }, m.manager);
    expect(replaced).toBe(true);
    expect(live).toBe(5);
    expect(answer).toMatchObject({ ok: true });
    expect(counters(name).a).toBe(5);
    expect((await snapshotOf(name)).verdict).toEqual({ ok: true });
  });
});
