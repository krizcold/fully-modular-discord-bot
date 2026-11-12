import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueWrite,
  flushAll,
  flushGuild,
  guildFailingWrite,
  guildKeyStored,
  restoreGuildDirFromGraveyard,
  setGuildViewCache,
  type FileRestoreHooks,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';

const X = 1000;
let guilds = 841_200_000_000_000_000n;
const freshGuild = () => String(++guilds);
const graveyard = () => dataPath('_graveyard');
const entryDir = (g: string, ms: number) => path.join(graveyard(), `${g}-${ms}`);
const errno = (code: string) => Object.assign(new Error(code), { code });
const base = (p: unknown) => path.basename(String(p));
const lines = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((c: unknown[]) => c.map(String).join(' '));
const asides = (g: string) => fs.readdirSync(graveyard()).filter(n => n.startsWith(`.sweep-restore-${g}-`));
const restores = (g: string) => fs.readdirSync(graveyard()).filter(n => n.startsWith(`.restore-${g}-`) || n.startsWith(`.copy-${g}-`));
const isDrop = (dest: string) => base(dest).startsWith('.sweep-restore-');

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
function bury(g: string, ms: number, files: Record<string, string>, noteText?: string): void {
  writeTree(entryDir(g, ms), files);
  fs.writeFileSync(path.join(entryDir(g, ms), '.graveyard.json'), noteText ?? JSON.stringify({ guildId: g, reason: 'webui-operator-delete', ts: ms }));
}
const noteOf = (g: string, ms: number) => JSON.parse(fs.readFileSync(path.join(entryDir(g, ms), '.graveyard.json'), 'utf8'));

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

type Hook = (src: string, dest: string, real: () => Promise<void>) => Promise<void>;
function onRename(hook: Hook): void {
  const rename = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementation((async (a: any, b: any) => hook(String(a), String(b), () => rename(a, b))) as any);
}
/** Every fs.promises.rm call goes through; its promises are kept so a test can wait for them to settle. */
function watchRm(fail?: (p: string) => unknown): Promise<unknown>[] {
  const rm = fs.promises.rm.bind(fs.promises);
  const calls: Promise<unknown>[] = [];
  vi.spyOn(fs.promises, 'rm').mockImplementation(((p: any, ...rest: any[]) => {
    const err = fail?.(String(p));
    const call = err ? Promise.reject(err) : (rm as any)(p, ...rest);
    calls.push(call);
    return call;
  }) as any);
  return calls;
}
const settled = async (calls: Promise<unknown>[]) => {
  await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 1000, interval: 2 });
  await Promise.allSettled(calls);
  await new Promise<void>(resolve => setImmediate(resolve));
};
/** Runs a promise under fake setTimeout, advancing the clock until it settles. */
async function drive<T>(promise: Promise<T>): Promise<T> {
  let result: { ok: true; value: T } | { ok: false; error: unknown } | null = null;
  promise.then(value => { result = { ok: true, value }; }, error => { result = { ok: false, error }; });
  for (let i = 0; i < 5000 && !result; i++) {
    await vi.advanceTimersByTimeAsync(25);
    await new Promise<void>(resolve => setImmediate(resolve));
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

describe('a restore copy that is dropped', () => {
  it('the dropped copy is removed after the answer', async () => {
    const g = freshGuild();
    bury(g, X, FILES);
    const rmCalls = watchRm();
    expect(await restoreGuildDirFromGraveyard(g, X, hooks({ writerTaken: () => true }))).toEqual({ ok: false, why: 'writer-lost' });
    expect(lines(errorSpy)).toContain(writerLostLine(g));
    expect(restores(g)).toEqual([]);
    await vi.waitFor(() => expect(asides(g)).toEqual([]), { timeout: 1000, interval: 2 });
    await settled(rmCalls);
    expect(lines(warnSpy).filter(l => l.includes('restore copy'))).toEqual([]);
    expect(tree(entryDir(g, X))).toMatchObject(FILES);
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });

  it('a drop whose rename fails once is tried again', async () => {
    const g = freshGuild();
    bury(g, X, FILES);
    let failed = 0;
    onRename(async (src, dest, real) => {
      if (isDrop(dest) && failed++ === 0) throw errno('EBUSY');
      return real();
    });
    expect(await restoreGuildDirFromGraveyard(g, X, hooks({ writerTaken: () => true }))).toEqual({ ok: false, why: 'writer-lost' });
    expect(failed).toBe(2);
    expect(restores(g)).toEqual([]);
    expect(lines(errorSpy).filter(l => l.includes("Cannot drop the restore's copy"))).toEqual([]);
  });

  it('a drop whose rename keeps failing is logged as an error with the copy name', async () => {
    const g = freshGuild();
    bury(g, X, FILES);
    let tries = 0;
    onRename(async (src, dest, real) => {
      if (isDrop(dest)) {
        tries++;
        throw errno('EPERM');
      }
      return real();
    });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    expect(await drive(restoreGuildDirFromGraveyard(g, X, hooks({ writerTaken: () => true })))).toEqual({ ok: false, why: 'writer-lost' });
    vi.useRealTimers();
    expect(tries).toBe(10);
    const [left] = restores(g);
    expect(left).toMatch(/^\.restore-/);
    expect(lines(errorSpy)).toContain(`[DataManager] Cannot drop the restore's copy ${left} (dropped at the next sweep or boot): Error: EPERM`);
    expect(lines(warnSpy).filter(l => l.includes('was already removed'))).toEqual([]);
  });

  it('a dropped copy already gone when its removal runs is not reported', async () => {
    const g = freshGuild();
    bury(g, X, FILES);
    onRename(async (src, dest, real) => {
      await real();
      if (isDrop(dest)) fs.rmSync(dest, { recursive: true, force: true });
    });
    const rmCalls = watchRm();
    expect(await restoreGuildDirFromGraveyard(g, X, hooks({ writerTaken: () => true }))).toEqual({ ok: false, why: 'writer-lost' });
    await settled(rmCalls);
    expect(lines(warnSpy).filter(l => l.includes('restore copy'))).toEqual([]);
  });

  it('a removal of the dropped copy that fails is logged with its name', async () => {
    const g = freshGuild();
    bury(g, X, FILES);
    watchRm(p => (base(p).startsWith(`.sweep-restore-${g}-`) ? errno('EBUSY') : undefined));
    expect(await restoreGuildDirFromGraveyard(g, X, hooks({ writerTaken: () => true }))).toEqual({ ok: false, why: 'writer-lost' });
    const [aside] = asides(g);
    expect(aside).toBeDefined();
    await vi.waitFor(() => expect(lines(warnSpy)).toContain(`[DataManager] Failed to remove dropped restore copy ${aside} (removed at the next sweep): Error: EBUSY`), { timeout: 1000, interval: 2 });
  });
});

describe('a replace refused by a queued write', () => {
  it('a write that keeps failing is named in the log', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), { 'm/a.json': '{"prev":1}' });
    bury(g, X, FILES);
    const open = fs.promises.open.bind(fs.promises);
    let failing = true;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (failing && String(p).includes(`${path.sep}${g}${path.sep}m${path.sep}q.json`)) throw errno('ENOSPC');
      return (open as any)(p, ...rest);
    }) as any);
    enqueueWrite(dataPath(g, 'm', 'q.json'), '{"q":1}');
    await flushGuild(g);
    expect(guildFailingWrite(g)).toEqual({ file: 'm/q.json', code: 'ENOSPC' });
    expect(await restoreGuildDirFromGraveyard(g, X, hooks({ replace: true }))).toEqual({ ok: false, why: 'failing', file: 'm/q.json', code: 'ENOSPC' });
    expect(lines(errorSpy)).toContain(`[DataManager] Cannot replace guild ${g}'s data: m/q.json keeps failing to save (ENOSPC); nothing was restored`);
    failing = false;
    await flushAll();
    expect(fs.readFileSync(dataPath(g, 'm', 'q.json'), 'utf8')).toBe('{"q":1}');
  });

  it('a write queued during the flush is named as not saved yet', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), { 'm/a.json': '{"prev":1}' });
    bury(g, X, FILES);
    const open = fs.promises.open.bind(fs.promises);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let restoring = false;
    let queuedLate = false;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      const s = String(p);
      if (restoring && !queuedLate && s.includes(`${path.sep}${g}${path.sep}m${path.sep}q.json`)) {
        queuedLate = true;
        enqueueWrite(dataPath(g, 'm', 'r.json'), '{"r":1}');
      }
      if (s.includes(`${path.sep}${g}${path.sep}m${path.sep}r.json`)) await held;
      return (open as any)(p, ...rest);
    }) as any);
    enqueueWrite(dataPath(g, 'm', 'q.json'), '{"q":1}');
    restoring = true;
    expect(await restoreGuildDirFromGraveyard(g, X, hooks({ replace: true }))).toEqual({ ok: false, why: 'unflushed' });
    expect(queuedLate).toBe(true);
    expect(lines(errorSpy)).toContain(`[DataManager] Cannot replace guild ${g}'s data: a write of it is not saved yet; nothing was restored`);
    release();
    await flushAll();
    expect(fs.readFileSync(dataPath(g, 'm', 'r.json'), 'utf8')).toBe('{"r":1}');
    expect(fs.readFileSync(dataPath(g, 'm', 'q.json'), 'utf8')).toBe('{"q":1}');
  });
});

describe('the entry asked for and its note', () => {
  it('a plain restore of an entry that does not exist answers no-entry, though the guild has data', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), { 'm/a.json': '{"prev":1}' });
    bury(g, X, FILES);
    expect(await restoreGuildDirFromGraveyard(g, X + 5, hooks())).toEqual({ ok: false, why: 'no-entry' });
    expect(tree(dataPath(g))).toEqual({ 'm/a.json': '{"prev":1}' });
  });

  it('a note holding null restores with an empty reason and a fresh note', async () => {
    const g = freshGuild();
    bury(g, X, FILES, 'null');
    expect(await restoreGuildDirFromGraveyard(g, X, hooks())).toEqual({ ok: true, retiredAt: X, reason: '', usedAt: expect.any(Number) });
    expect(noteOf(g, X)).toEqual({ guildId: g, reason: '', ts: X, usedAt: expect.any(Number) });
    expect(tree(dataPath(g))).toEqual(FILES);
  });

  it('a note holding a number is replaced by a whole note', async () => {
    const g = freshGuild();
    bury(g, X, FILES, '5');
    expect(await restoreGuildDirFromGraveyard(g, X, hooks())).toMatchObject({ ok: true, retiredAt: X, reason: '' });
    expect(noteOf(g, X)).toEqual({ guildId: g, reason: '', ts: X, usedAt: expect.any(Number) });
  });

  it('a note with a reason that is not text answers an empty reason', async () => {
    const g = freshGuild();
    bury(g, X, FILES, JSON.stringify({ guildId: g, reason: 7, ts: X }));
    expect(await restoreGuildDirFromGraveyard(g, X, hooks())).toEqual({ ok: true, retiredAt: X, reason: '', usedAt: expect.any(Number) });
  });

  it('a stamp that cannot be written is logged and refuses', async () => {
    const g = freshGuild();
    bury(g, X, FILES);
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (path.resolve(path.dirname(String(p))) === path.resolve(entryDir(g, X)) && String(p).endsWith('.tmp')) throw errno('EACCES');
      return (open as any)(p, ...rest);
    }) as any);
    expect(await restoreGuildDirFromGraveyard(g, X, hooks())).toEqual({ ok: false, why: 'stamp', x: X, code: 'EACCES' });
    expect(lines(errorSpy)).toContain(`[DataManager] Cannot restore guild ${g}: graveyard entry ${g}-${X} could not be marked as restored: Error: EACCES`);
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });
});

describe('what the copy takes', () => {
  it('temp files are left out, and a nested file named like the note is copied', async () => {
    const g = freshGuild();
    bury(g, X, { ...FILES, 'm/a.json.123.4.tmp': 'half', 'm/.graveyard.json': '{"mine":1}' });
    expect(await restoreGuildDirFromGraveyard(g, X, hooks())).toMatchObject({ ok: true, retiredAt: X });
    expect(tree(dataPath(g))).toEqual({ ...FILES, 'm/.graveyard.json': '{"mine":1}' });
  });

  it('a failing lstat of the entry folder itself does not stop the copy', async () => {
    const g = freshGuild();
    bury(g, X, FILES);
    const lstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(entryDir(g, X))) throw errno('EIO');
      return (lstat as any)(p, ...rest);
    }) as any);
    expect(await restoreGuildDirFromGraveyard(g, X, hooks())).toMatchObject({ ok: true, retiredAt: X });
    expect(tree(dataPath(g))).toEqual(FILES);
  });
});

describe('the view of a replaced guild', () => {
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
    expect(tree(dataPath(g))).toEqual(FILES);
  });
});
