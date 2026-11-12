import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushAll,
  guildKeyStored,
  placeGuildWrite,
  restoreGuildDirFromGraveyard,
  setGuildViewCache,
  type FileRestoreHooks,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';

const X = 1000;
let guilds = 864_100_000_000_000_000n;
const freshGuild = () => String(++guilds);
const graveyard = () => dataPath('_graveyard');
const entryDir = (g: string, ms: number) => path.join(graveyard(), `${g}-${ms}`);
const errno = (code: string) => Object.assign(new Error(code), { code });
const lines = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((c: unknown[]) => c.map(String).join(' '));
const restores = (g: string) => fs.readdirSync(graveyard()).filter(n => n.startsWith(`.restore-${g}-`) || n.startsWith(`.copy-${g}-`));
const inCopy = (g: string, p: string) => path.resolve(p).split(path.sep).some(s => s.startsWith(`.copy-${g}-`));

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
}
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out[r] = fs.readFileSync(path.join(dir, r), 'utf8');
    }
  };
  walk('');
  return out;
}
function bury(g: string, ms: number, files: Record<string, string>): void {
  writeTree(entryDir(g, ms), files);
  fs.writeFileSync(path.join(entryDir(g, ms), '.graveyard.json'), JSON.stringify({ guildId: g, reason: 'webui-operator-delete', ts: ms }));
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

/** Each fs.promises.open of a copied file ('r+', the copy's fsync) goes through hook first, with its 1-based count. */
function onCopyFileOpen(g: string, hook: (count: number, p: string) => void): void {
  const open = fs.promises.open.bind(fs.promises);
  let count = 0;
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags: any, ...rest: any[]) => {
    if (flags === 'r+' && inCopy(g, String(p))) hook(++count, String(p));
    return (open as any)(p, flags, ...rest);
  }) as any);
}

const realSetTimeout = globalThis.setTimeout;

async function drive<T>(promise: Promise<T>): Promise<T> {
  let result: { ok: true; value: T } | { ok: false; error: unknown } | null = null;
  promise.then(value => { result = { ok: true, value }; }, error => { result = { ok: false, error }; });
  const deadline = vi.getRealSystemTime() + 5000;
  while (!result && vi.getRealSystemTime() < deadline) {
    await vi.advanceTimersByTimeAsync(25);
    await new Promise<void>(resolve => realSetTimeout(resolve, 1));
  }
  if (!result) throw new Error('the restore did not settle');
  const r = result as { ok: true; value: T } | { ok: false; error: unknown };
  if (!r.ok) throw r.error;
  return r.value;
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fs.mkdirSync(graveyard(), { recursive: true });
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setGuildViewCache(false);
  await flushAll();
});

const FILES = { 'm/a.json': '{"x":1}', 'm/c.json': '{"c":3}' };
const writerLostLine = (g: string) => `[DataManager] Cannot restore guild ${g} from the graveyard: another process took the data files`;
const copyLine = (g: string, code: string) => `[DataManager] Cannot restore guild ${g}: graveyard entry ${g}-${X} could not be copied: Error: ${code}`;

describe('the gates read during the copy', () => {
  it('a writer lost once the last copied file is synced refuses before the copy is renamed', async () => {
    const g = freshGuild();
    bury(g, X, FILES);
    let lost = false;
    onCopyFileOpen(g, count => { if (count === 2) lost = true; });
    expect(await restoreGuildDirFromGraveyard(g, X, hooks({ writerLost: () => lost }))).toEqual({ ok: false, why: 'writer-lost' });
    expect(lines(errorSpy)).toContain(writerLostLine(g));
    expect(fs.existsSync(dataPath(g))).toBe(false);
    expect(tree(entryDir(g, X))).toMatchObject(FILES);
  });

  it('a writer lost after the first copied file is synced refuses before the next file is opened', async () => {
    const g = freshGuild();
    bury(g, X, FILES);
    let lost = false;
    onCopyFileOpen(g, count => {
      if (count === 1) lost = true;
      if (count === 2) throw errno('EIO');
    });
    expect(await restoreGuildDirFromGraveyard(g, X, hooks({ writerLost: () => lost }))).toEqual({ ok: false, why: 'writer-lost' });
    expect(lines(errorSpy).filter(l => l.includes('could not be copied'))).toEqual([]);
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('on Windows a copied folder is not followed by a gate read: the next folder is read', async () => {
    const g = freshGuild();
    bury(g, X, { 'a/1.json': '{"a":1}', 'b/2.json': '{"b":2}' });
    let lost = false;
    onCopyFileOpen(g, (_count, p) => { if (path.basename(p) === '1.json') lost = true; });
    const readdir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: any, ...rest: any[]) => {
      if (lost && inCopy(g, String(p)) && path.basename(String(p)) === 'b') throw errno('EIO');
      return (readdir as any)(p, ...rest);
    }) as any);
    expect(await restoreGuildDirFromGraveyard(g, X, hooks({ writerLost: () => lost }))).toEqual({ ok: false, why: 'copy', x: X, code: 'EIO' });
    expect(lines(errorSpy)).toContain(copyLine(g, 'EIO'));
  });
});

describe('a copy that fails', () => {
  it('a failure that leaves nothing is logged with its code and answers copy', async () => {
    const g = freshGuild();
    bury(g, X, FILES);
    vi.spyOn(fs.promises, 'cp').mockImplementation((async () => { throw errno('EACCES'); }) as any);
    expect(await restoreGuildDirFromGraveyard(g, X, hooks())).toEqual({ ok: false, why: 'copy', x: X, code: 'EACCES' });
    expect(lines(errorSpy)).toContain(copyLine(g, 'EACCES'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(lines(warnSpy).filter(l => l.includes("The restore's copy"))).toEqual([]);
    expect(restores(g)).toEqual([]);
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });

  it('an entry gone during the copy answers no-entry without a log line', async () => {
    const g = freshGuild();
    bury(g, X, FILES);
    vi.spyOn(fs.promises, 'cp').mockImplementation((async () => { throw errno('ENOENT'); }) as any);
    expect(await restoreGuildDirFromGraveyard(g, X, hooks())).toEqual({ ok: false, why: 'no-entry' });
    expect(lines(errorSpy).filter(l => l.includes('could not be copied'))).toEqual([]);
  });

  it('an entry gone after part of it was copied answers no-entry and drops the part', async () => {
    const g = freshGuild();
    bury(g, X, FILES);
    vi.spyOn(fs.promises, 'cp').mockImplementation((async (_src: any, dest: any) => {
      fs.mkdirSync(String(dest), { recursive: true });
      fs.writeFileSync(path.join(String(dest), 'part.json'), '{}');
      throw errno('ENOENT');
    }) as any);
    expect(await restoreGuildDirFromGraveyard(g, X, hooks())).toEqual({ ok: false, why: 'no-entry' });
    expect(lines(errorSpy).filter(l => l.includes('could not be copied'))).toEqual([]);
    expect(restores(g)).toEqual([]);
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });
});

describe('the lock file read before the renames', () => {
  it('a replace whose lock file read answers taken opens no rename section and keeps the live folder', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), { 'm/a.json': '{"prev":1}' });
    bury(g, X, FILES);
    const enterSection = vi.fn(() => () => {});
    expect(await restoreGuildDirFromGraveyard(g, X, hooks({ replace: true, writerTaken: () => true, enterSection }))).toEqual({ ok: false, why: 'writer-lost' });
    expect(enterSection).not.toHaveBeenCalled();
    expect(tree(dataPath(g))).toEqual({ 'm/a.json': '{"prev":1}' });
  });
});

describe('a replace', () => {
  it('a live folder that cannot be moved is logged with its error and answers move', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), { 'm/a.json': '{"prev":1}' });
    bury(g, X, FILES);
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (a: any, b: any) => {
      if (path.resolve(String(a)) === path.resolve(dataPath(g))) throw errno('EBUSY');
      return rename(a, b);
    }) as any);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    expect(await drive(restoreGuildDirFromGraveyard(g, X, hooks({ replace: true })))).toEqual({ ok: false, why: 'move', x: X, code: 'EBUSY' });
    vi.useRealTimers();
    expect(lines(errorSpy)).toContain(`[DataManager] Cannot replace guild ${g}'s data: its folder could not be moved to the graveyard: Error: EBUSY`);
    expect(tree(dataPath(g))).toEqual({ 'm/a.json': '{"prev":1}' });
  });

  it('a view read before the live folder moved is not used once it moved', async () => {
    setGuildViewCache(true);
    const g = freshGuild();
    writeTree(dataPath(g), { 'm/old.json': '{"prev":1}' });
    bury(g, X, FILES);
    expect(guildKeyStored(g, 'm/old.json')).toBe(true);
    let storedAtMove: boolean | null = null;
    let moved: { r: number; x: number } | null = null;
    const progress = {
      renamed: false,
      get moved() { return moved; },
      set moved(v: { r: number; x: number } | null) {
        storedAtMove = guildKeyStored(g, 'm/old.json');
        moved = v;
      },
    };
    expect(await restoreGuildDirFromGraveyard(g, X, hooks({ replace: true, progress }))).toMatchObject({ ok: true, retiredAt: X });
    expect(storedAtMove).toBe(false);
  });

  it('a view read while the live folder was away is not used once the copy is in place', async () => {
    setGuildViewCache(true);
    const g = freshGuild();
    const kelvin = String.fromCharCode(0x212a);
    writeTree(dataPath(g), { 'm/old.json': '{"prev":1}' });
    bury(g, X, { 'k.json': '{"k":1}' });
    let moved: { r: number; x: number } | null = null;
    let renamed = false;
    let placed: unknown = null;
    const progress = {
      get renamed() { return renamed; },
      set renamed(v: boolean) {
        placed = placeGuildWrite(g, `${kelvin}.json`);
        renamed = v;
      },
      get moved() { return moved; },
      set moved(v: { r: number; x: number } | null) {
        guildKeyStored(g, 'zz.json');
        moved = v;
      },
    };
    expect(await restoreGuildDirFromGraveyard(g, X, hooks({ replace: true, progress }))).toMatchObject({ ok: true, retiredAt: X });
    expect(placed).toMatchObject({ ok: false, cause: 'unstorable' });
    expect(tree(dataPath(g))).toEqual({ 'k.json': '{"k":1}' });
  });
});
