import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dropPendingForGuild,
  enqueueDelete,
  enqueueWrite,
  flushAll,
  graveyardGuildDir,
  listGraveyardEntries,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';

// NB11 (sheets/NB11.md): a delete moves the guild's folder to the graveyard after the guild's flush on the wire
// settles, and that wait is bounded; a flush of another guild never holds it.

let guilds = 880_000_000_000_000_000n;
const freshGuild = () => String(++guilds);
const errno = (code: string) => Object.assign(new Error(code), { code });
const same = (a: unknown, b: unknown) => path.resolve(String(a)) === path.resolve(String(b));
const isTmpOf = (p: unknown, target: string) => {
  const s = path.resolve(String(p));
  const t = path.resolve(target);
  return s.startsWith(t + '.') && s.endsWith('.tmp');
};
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const late = (ms: number) => sleep(ms).then(() => 'late' as const);
async function until(check: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 3000) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const realOpen = fs.promises.open;
/** Holds the temp-file open of a write to target until released; other opens are real. */
function holdOpen(target: string) {
  const held = deferred<void>();
  const tmps: string[] = [];
  vi.spyOn(fs.promises, 'open').mockImplementation(((p: any, ...rest: any[]) => {
    if (isTmpOf(p, target)) {
      tmps.push(String(p));
      return held.promise.then(() => (realOpen as any).call(fs.promises, p, ...rest));
    }
    return (realOpen as any).call(fs.promises, p, ...rest);
  }) as any);
  return { tmps, release: () => held.resolve(), fail: (e: unknown) => held.reject(e) };
}

function seed(g: string, body = '{"n":1}'): string {
  const file = dataPath(g, 'm', 'a.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}
const listed = async (g: string) => (await listGraveyardEntries()).filter(e => e.guildId === g);
async function entryFile(g: string): Promise<string> {
  const [entry] = await listed(g);
  return fs.readFileSync(dataPath('_graveyard', `${g}-${entry.retiredAt}`, 'm', 'a.json'), 'utf8');
}

afterEach(async () => {
  vi.restoreAllMocks();
  await flushAll();
});

describe('graveyardGuildDir', () => {
  it('moves the folder when called with only the guild and the reason', async () => {
    const g = freshGuild();
    seed(g);
    expect(await graveyardGuildDir(g, 'nb11-defaults')).toBe(true);
    expect(fs.existsSync(dataPath(g))).toBe(false);
    expect((await listed(g)).map(e => e.reason)).toEqual(['nb11-defaults']);
    expect(await entryFile(g)).toBe('{"n":1}');
  });

  it("waits for the guild's file flush on the wire, then moves the folder holding its bytes", async () => {
    const g = freshGuild();
    const file = seed(g, '{"n":1}');
    const hold = holdOpen(file);
    enqueueWrite(file, '{"n":2}');
    await until(() => hold.tmps.length === 1, 'the flush on the wire');

    const moved = graveyardGuildDir(g, 'nb11-wait');
    try {
      await sleep(80);
      expect(fs.existsSync(dataPath(g))).toBe(true);
      expect(await listed(g)).toEqual([]);
    } finally {
      hold.release();
    }
    expect(await moved).toBe(true);
    expect(fs.existsSync(dataPath(g))).toBe(false);
    expect(await entryFile(g)).toBe('{"n":2}');
  });

  it('waits for an op on the wire on the guild folder path itself', async () => {
    const g = freshGuild();
    seed(g);
    const src = dataPath(g);
    const held = deferred<void>();
    let calls = 0;
    const realUnlink = fs.promises.unlink;
    vi.spyOn(fs.promises, 'unlink').mockImplementation(((p: any) => {
      if (same(p, src)) {
        calls += 1;
        return held.promise;
      }
      return (realUnlink as any).call(fs.promises, p);
    }) as any);
    enqueueDelete(src);
    await until(() => calls === 1, 'the delete on the wire');

    const moved = graveyardGuildDir(g, 'nb11-dir-op');
    try {
      await sleep(80);
      expect(fs.existsSync(src)).toBe(true);
      expect(await listed(g)).toEqual([]);
    } finally {
      held.reject(errno('ENOENT'));
    }
    expect(await moved).toBe(true);
    expect(fs.existsSync(src)).toBe(false);
    expect(await entryFile(g)).toBe('{"n":1}');
  });

  it("does not wait for another guild's flush on the wire", async () => {
    const gA = freshGuild();
    const gB = freshGuild();
    seed(gA);
    const fileB = seed(gB);
    const hold = holdOpen(fileB);
    enqueueWrite(fileB, '{"n":2}');
    await until(() => hold.tmps.length === 1, 'the flush on the wire');

    try {
      expect(await Promise.race([graveyardGuildDir(gA, 'nb11-other'), late(1000)])).toBe(true);
      expect(fs.existsSync(dataPath(gA))).toBe(false);
      expect(await entryFile(gA)).toBe('{"n":1}');
    } finally {
      hold.release();
    }
    await flushAll();
    expect(fs.readFileSync(fileB, 'utf8')).toBe('{"n":2}');
  });

  it('stops waiting at its 5 s bound, not one tick later', async () => {
    const g = freshGuild();
    const file = seed(g);
    const hold = holdOpen(file);
    enqueueWrite(file, '{"n":2}');
    await until(() => hold.tmps.length === 1, 'the flush on the wire');

    const start = performance.now();
    vi.spyOn(performance, 'now').mockReturnValueOnce(start).mockReturnValue(start + 5000);
    const moved = graveyardGuildDir(g, 'nb11-bound');
    vi.mocked(performance.now).mockRestore();
    try {
      expect(await Promise.race([moved, late(1000)])).toBe(true);
      expect(await entryFile(g)).toBe('{"n":1}');
    } finally {
      hold.fail(errno('EIO'));
      dropPendingForGuild(g);
    }
    await moved;
  });
});
