import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The modules read the platform once at load: they load here as on Linux, where production runs, whatever runs the test.
const platform = vi.hoisted(() => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  return real;
});

import {
  flushAll,
  restoreGuildDirFromGraveyard,
  type FileRestoreHooks,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { resetFolderSyncFailureForTests } from '../../src/bot/internalSetup/utils/folderChain';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';

const X = 1000;
let guilds = 864_200_000_000_000_000n;
const freshGuild = () => String(++guilds);
const graveyard = () => dataPath('_graveyard');
const entryDir = (g: string, ms: number) => path.join(graveyard(), `${g}-${ms}`);
const errno = (code: string) => Object.assign(new Error(code), { code });
const lines = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((c: unknown[]) => c.map(String).join(' '));
const inCopy = (g: string, p: string) => path.resolve(p).split(path.sep).some(s => s.startsWith(`.copy-${g}-`));
const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

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

/**
 * A folder opened through fs.promises.open gets a handle whose fsync answers dirSync's code (the host's own folder
 * fsync is not what Linux does); a copied file opened 'r+' goes through onFile first, with its 1-based count.
 */
function fakeDisk(dirSync: (dir: string) => string | null, onFile: (count: number, p: string) => void = () => {}): string[] {
  const open = fs.promises.open.bind(fs.promises);
  const synced: string[] = [];
  let count = 0;
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags: any, ...rest: any[]) => {
    const at = path.resolve(String(p));
    if (isDir(at)) {
      return {
        stat: (options?: any) => fs.promises.stat(at, options),
        sync: async () => {
          synced.push(at);
          const code = dirSync(at);
          if (code) throw errno(code);
        },
        close: async () => {},
      };
    }
    if (flags === 'r+' && at.split(path.sep).some(s => s.startsWith('.copy-'))) onFile(++count, at);
    return (open as any)(p, flags, ...rest);
  }) as any);
  return synced;
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
  vi.restoreAllMocks();
  resetFolderSyncFailureForTests();
  await flushAll();
});

afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
});

const FILES = { 'm/a.json': '{"x":1}', 'm/c.json': '{"c":3}' };

describe('the folder syncs of the copy on Linux', () => {
  it('a copied folder whose fsync fails refuses the restore with copy-sync', async () => {
    const g = freshGuild();
    bury(g, X, FILES);
    fakeDisk(dir => (inCopy(g, dir) ? 'EIO' : null));
    const answer = await restoreGuildDirFromGraveyard(g, X, hooks());
    expect(answer).toMatchObject({ ok: false, why: 'copy-sync', x: X, code: 'EIO', kind: 'sync' });
    expect(fs.existsSync(dataPath(g))).toBe(false);
    expect(lines(errorSpy).some(l => l.startsWith(`[DataManager] Cannot restore guild ${g}: the copy of entry ${g}-${X} is written, but `))).toBe(true);
  });

  it('a writer lost once the folder files are synced refuses before the folder itself is synced', async () => {
    const g = freshGuild();
    bury(g, X, { 'a.json': '{"a":1}', 'c.json': '{"c":3}' });
    let lost = false;
    const synced = fakeDisk(dir => (inCopy(g, dir) ? 'EIO' : null), count => { if (count === 2) lost = true; });
    expect(await restoreGuildDirFromGraveyard(g, X, hooks({ writerLost: () => lost }))).toEqual({ ok: false, why: 'writer-lost' });
    expect(synced.filter(dir => inCopy(g, dir))).toEqual([]);
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });
});

describe('a plain restore whose folder sync after the rename fails', () => {
  it('answers restored with the code, and logs that a power cut can undo it', async () => {
    const g = freshGuild();
    bury(g, X, FILES);
    let renamed = false;
    const progress = {
      get renamed() { return renamed; },
      set renamed(v: boolean) { renamed = v; },
      moved: null,
    };
    fakeDisk(dir => (renamed && dir === path.resolve(DATA_ROOT) ? 'EIO' : null));
    expect(await restoreGuildDirFromGraveyard(g, X, hooks({ progress }))).toEqual({
      ok: true,
      retiredAt: X,
      reason: 'webui-operator-delete',
      usedAt: expect.any(Number),
      moveUnconfirmed: 'EIO',
    });
    expect(lines(errorSpy)).toContain(`[DataManager] Guild ${g} restored from graveyard entry ${g}-${X}, but the disk did not confirm the sync of ${DATA_ROOT} (EIO), so a power cut can put the folder back in the graveyard`);
    expect(lines(warnSpy)).not.toContain(`[DataManager] Guild ${g} restored from graveyard entry ${g}-${X}`);
    expect(tree(dataPath(g))).toEqual(FILES);
  });
});
