import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import { syncBuiltinESMExports } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';

// NB8 test 8 (decisions 17, 39, 40): a writer that writes A, waits until A landed, then writes B, each with one counter;
// every snapshot holds A's counter at or above B's, so no snapshot shows a state that never existed.

const seams = { pid: () => process.pid, alive: () => true, startOf: (pid: number) => `start-${pid}`, now: () => Date.now() };
const locks: Array<{ writerLockDepth(): number; releaseWriterLock(): void }> = [];
const A = () => dataPath('123', 'premium.json');
const B = () => dataPath('123', 'premium-events.json');
let hour = 0;
const nextName = () => `hourly-${new Date(Date.UTC(2026, 10, 13) + ++hour * 3600_000).toISOString().replace(/[:.]/g, '-')}`;

async function load(beforeTurn?: () => unknown) {
  vi.resetModules();
  const lock = await import('../../src/bot/internalSetup/utils/writerLock');
  fs.rmSync(lock.writerLockPath(), { force: true });
  lock.configureWriterLock('bot', seams);
  lock.takeWriterLock();
  locks.push(lock);
  const take = await import('../../src/bot/internalSetup/utils/backups/snapshotTake');
  take._setTakeTimingForTests({ pollMs: 5, beforeTurn }, seams);
  return { take, fb: await import('../../src/bot/internalSetup/utils/dataBackends/fileBackend') };
}

function counters(name: string): { a: number; b: number } {
  const read = (p: string) => JSON.parse(fs.readFileSync(path.join(dataPath('_snapshots'), name, 'data', path.relative(dataPath(), p)), 'utf8')).n as number;
  return { a: read(A()), b: read(B()) };
}

beforeEach(() => {
  for (const e of fs.readdirSync(dataPath())) fs.rmSync(dataPath(e), { recursive: true, force: true });
  fs.mkdirSync(dataPath('123'), { recursive: true });
  fs.writeFileSync(A(), '{"n":0}');
  fs.writeFileSync(B(), '{"n":0}');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const lock of locks.splice(0)) while (lock.writerLockDepth() > 0) lock.releaseWriterLock();
});

describe('the cut holds a state that existed', () => {
  it('with the writer running through three takes, A is at or above B in each', async () => {
    const m = await load();
    let stop = false;
    let n = 0;
    const writer = (async () => {
      while (!stop) {
        n += 1;
        m.fb.enqueueWrite(A(), JSON.stringify({ n }));
        await m.fb.flushAll();
        m.fb.enqueueWrite(B(), JSON.stringify({ n }));
        await m.fb.flushAll();
      }
    })();
    const seen: Array<{ a: number; b: number }> = [];
    for (let i = 0; i < 3; i++) {
      const name = nextName();
      const answer = await m.take.takeSnapshot({ name, kind: 'hourly' });
      if (answer.ok) seen.push(counters(name));
    }
    stop = true;
    await writer;
    expect(seen.length).toBeGreaterThan(0);
    for (const c of seen) expect(c.a).toBeGreaterThanOrEqual(c.b);
  });

  it('property: writes placed before random turns never leave B ahead of A', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 4 }), async steps => {
        fs.rmSync(dataPath('_snapshots'), { recursive: true, force: true });
        fs.writeFileSync(A(), '{"n":0}');
        fs.writeFileSync(B(), '{"n":0}');
        let turn = 0;
        let step = 0;
        const m = await load(async () => {
          const count = steps[turn++] ?? 0;
          for (let i = 0; i < count; i++) {
            step += 1;
            const n = Math.ceil(step / 2);
            m.fb.enqueueWrite(step % 2 === 1 ? A() : B(), JSON.stringify({ n }));
            await m.fb.flushAll();
          }
        });
        const name = nextName();
        const answer = await m.take.takeSnapshot({ name, kind: 'hourly' });
        if (!answer.ok) return;
        const c = counters(name);
        expect(c.a).toBeGreaterThanOrEqual(c.b);
        expect(c.a - c.b).toBeLessThanOrEqual(1);
      }),
      { numRuns: 15 },
    );
  });
});

const snapshotOf = async (name: string) => {
  const list = await import('../../src/bot/internalSetup/utils/backups/snapshotList');
  const verify = await import('../../src/bot/internalSetup/utils/backups/snapshotVerify');
  const entry = list.readSnapshot(name);
  if (entry.state !== 'complete') throw new Error(`not complete: ${JSON.stringify(entry)}`);
  return { manifest: entry.manifest, verdict: await verify.verifyTree(path.join(dataPath('_snapshots'), name, 'data'), entry.manifest) };
};
const under = (p: unknown, dir: string) => path.resolve(String(p)).startsWith(path.resolve(dir) + path.sep);

describe('Q2: a guild moved to the graveyard between the turn and the cleanup', () => {
  it('the snapshot holds the guild as it was at the cut', async () => {
    fs.mkdirSync(dataPath('123', 'mod'), { recursive: true });
    fs.writeFileSync(dataPath('123', 'mod', 'a.json'), '{"a":1}');
    const m = await load(once(async () => {
      m.fb.enqueueDelete(dataPath('123', 'mod', 'a.json'));
      m.fb.enqueueWrite(A(), '{"n":1}');
      await m.fb.flushAll();
    }));
    let cut = false;
    let moved: boolean | null = null;
    const realRead = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (String(p).endsWith('.writer.lock')) cut = true;
      return (realRead as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags: any, ...rest: any[]) => {
      if (cut && moved === null && flags === 'wx' && under(p, dataPath('_snapshots'))) moved = await m.fb.graveyardGuildDir('123', 'test');
      return realOpen(p, flags, ...rest);
    }) as any);
    const name = nextName();
    const answer = await m.take.takeSnapshot({ name, kind: 'hourly' });
    const got = await snapshotOf(name);
    expect(moved).toBe(true);
    expect(fs.existsSync(dataPath('123'))).toBe(false);
    expect(answer).toMatchObject({ ok: true });
    expect(got.verdict).toEqual({ ok: true });
    expect(got.manifest.files.map(f => f.path)).toEqual(['123/premium-events.json', '123/premium.json']);
    expect(counters(name)).toEqual({ a: 1, b: 0 });
  });
});

function once(fn: () => unknown): () => unknown {
  let ran = false;
  return () => {
    if (ran) return undefined;
    ran = true;
    return fn();
  };
}
