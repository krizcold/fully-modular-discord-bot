import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The modules read the platform once at load: they load here as on Linux, where production runs, whatever runs the test.
const platform = vi.hoisted(() => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  return real;
});

import { flushAll, restoreGuildDirFromGraveyard, type FileRestoreHooks } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { syncFolderChain, type ChainAnswer } from '../../src/bot/internalSetup/utils/folderChain';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';

// A restore moves /data/G: every folder sync record made before the move, or by a chain still on the wire across it,
// is forgotten, so a later save syncs its folders up to /data again.

const ROOT = path.resolve(DATA_ROOT);
const X = 1000;
let guilds = 871_300_000_000_000_000n;
const freshGuild = () => String(++guilds);
const graveyard = () => dataPath('_graveyard');
const errno = (code: string) => Object.assign(new Error(`${code}: stubbed`), { code });
const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function bury(g: string, ms: number, files: Record<string, string>): void {
  const dir = path.join(graveyard(), `${g}-${ms}`);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  fs.writeFileSync(path.join(dir, '.graveyard.json'), JSON.stringify({ guildId: g, reason: 'webui-operator-delete', ts: ms }));
}

const disk = { synced: [] as string[], held: null as { dir: string; released: Promise<void> } | null };

/** Folders opened through fs.promises.open get a handle whose fsync succeeds (the host's own folder fsync is not what Linux does), or waits while held. */
function fakeDisk(): void {
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags: any, ...rest: any[]) => {
    const at = path.resolve(String(p));
    if ((flags === 'r' || flags === undefined) && isDir(at)) {
      return {
        stat: (options?: any) => fs.promises.stat(at, options),
        sync: async () => {
          disk.synced.push(at);
          if (disk.held?.dir === at) await disk.held.released;
        },
        close: async () => {},
      };
    }
    return (open as any)(p, flags, ...rest);
  }) as any);
}

/** A chain sync of another guild's folder, started now and held at its first folder until released. */
function chainOnTheWire(dir: string): { done: Promise<ChainAnswer>; release(): void } {
  let release!: () => void;
  disk.held = { dir, released: new Promise<void>(resolve => { release = resolve; }) };
  return { done: syncFolderChain(dir), release };
}

/** Whether a fresh chain of dir walks up to /data: it does unless dir's folders were recorded as durable. */
async function walksToTop(dir: string): Promise<boolean> {
  disk.held = null;
  disk.synced = [];
  expect(await syncFolderChain(dir)).toEqual({ failed: false });
  return disk.synced.at(-1) === ROOT;
}

function hooks(over: Partial<FileRestoreHooks> = {}): FileRestoreHooks {
  return {
    stop: () => null,
    writerLost: () => false,
    writerTaken: () => false,
    replace: false,
    enterSection: () => () => {},
    progress: { renamed: false, moved: null },
    ...over,
  };
}

/** The K5 rename of the copy into /data/G fails every try; the retry's waits are shortened. */
function failPut(g: string, onTry: () => void = () => {}): void {
  const rename = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
    if (path.basename(String(from)).startsWith(`.restore-${g}-`) && path.resolve(String(to)) === path.resolve(dataPath(g))) {
      onTry();
      throw errno('EIO');
    }
    return rename(from, to);
  }) as typeof fs.promises.rename);
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...a: unknown[]) => void, _ms?: number, ...args: unknown[]) => realTimeout(fn, 0, ...args)) as never);
}

beforeEach(() => {
  disk.synced = [];
  disk.held = null;
  fs.mkdirSync(graveyard(), { recursive: true });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  fakeDisk();
});
afterEach(async () => {
  disk.held = null;
  vi.restoreAllMocks();
  await flushAll();
});
afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
});

const FILES = { 'm/a.json': '{"x":1}' };

describe('a chain on the wire while a restore moves a guild folder', () => {
  it('a plain restore: the chain that started before the copy was put in place records nothing', async () => {
    const g = freshGuild();
    const h = path.resolve(dataPath(freshGuild(), 'm'));
    fs.mkdirSync(h, { recursive: true });
    bury(g, X, FILES);
    let chain: ReturnType<typeof chainOnTheWire> | null = null;
    const progress = {
      get renamed() { return chain !== null; },
      set renamed(v: boolean) { if (v && !chain) chain = chainOnTheWire(h); },
      moved: null,
    };
    expect(await restoreGuildDirFromGraveyard(g, X, hooks({ progress }))).toMatchObject({ ok: true, retiredAt: X });
    expect(chain).not.toBeNull();
    chain!.release();
    expect(await chain!.done).toEqual({ failed: false });
    expect(await walksToTop(h)).toBe(true);
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"x":1}');
  });

  it('a replace whose copy cannot be put in place and whose undo finds the files taken: a chain started at the move records nothing', async () => {
    const g = freshGuild();
    const h = path.resolve(dataPath(freshGuild(), 'm'));
    fs.mkdirSync(h, { recursive: true });
    bury(g, X, FILES);
    fs.mkdirSync(dataPath(g, 'm'), { recursive: true });
    fs.writeFileSync(dataPath(g, 'm', 'a.json'), '{"live":1}');
    let chain: ReturnType<typeof chainOnTheWire> | null = null;
    let moved: { r: number; x: number } | null = null;
    const progress = {
      renamed: false,
      get moved() { return moved; },
      set moved(v: { r: number; x: number } | null) { moved = v; if (v && !chain) chain = chainOnTheWire(h); },
    };
    failPut(g);
    const answer = await restoreGuildDirFromGraveyard(g, X, hooks({ replace: true, progress, writerTaken: () => moved !== null }));
    expect(answer).toMatchObject({ ok: false, why: 'half-taken', x: X, code: 'EIO' });
    expect(chain).not.toBeNull();
    chain!.release();
    expect(await chain!.done).toEqual({ failed: false });
    expect(await walksToTop(h)).toBe(true);
  });

  it('a replace: a chain started between the move of the live folder and the put of the copy records nothing', async () => {
    const g = freshGuild();
    const h = path.resolve(dataPath(freshGuild(), 'm'));
    fs.mkdirSync(h, { recursive: true });
    bury(g, X, FILES);
    fs.mkdirSync(dataPath(g, 'm'), { recursive: true });
    fs.writeFileSync(dataPath(g, 'm', 'a.json'), '{"live":1}');
    let chain: ReturnType<typeof chainOnTheWire> | null = null;
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
      if (!chain && path.basename(String(from)).startsWith(`.restore-${g}-`) && path.resolve(String(to)) === path.resolve(dataPath(g))) chain = chainOnTheWire(h);
      return rename(from, to);
    }) as typeof fs.promises.rename);
    const answer = await restoreGuildDirFromGraveyard(g, X, hooks({ replace: true }));
    expect(answer).toMatchObject({ ok: true, retiredAt: X, replaced: { retiredAt: expect.any(Number) } });
    expect(chain).not.toBeNull();
    chain!.release();
    expect(await chain!.done).toEqual({ failed: false });
    expect(await walksToTop(h)).toBe(true);
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"x":1}');
  });

  it('a replace undone after the copy could not be put in place: a chain started before the undo records nothing', async () => {
    const g = freshGuild();
    const h = path.resolve(dataPath(freshGuild(), 'm'));
    fs.mkdirSync(h, { recursive: true });
    bury(g, X, FILES);
    fs.mkdirSync(dataPath(g, 'm'), { recursive: true });
    fs.writeFileSync(dataPath(g, 'm', 'a.json'), '{"live":1}');
    let chain: ReturnType<typeof chainOnTheWire> | null = null;
    failPut(g, () => { if (!chain) chain = chainOnTheWire(h); });
    const answer = await restoreGuildDirFromGraveyard(g, X, hooks({ replace: true }));
    expect(answer).toMatchObject({ ok: false, why: 'undone', x: X, code: 'EIO' });
    expect(chain).not.toBeNull();
    chain!.release();
    expect(await chain!.done).toEqual({ failed: false });
    expect(await walksToTop(h)).toBe(true);
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"live":1}');
  });
});
