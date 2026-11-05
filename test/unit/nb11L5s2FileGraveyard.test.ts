import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dropPendingForGuild,
  enqueueWrite,
  fileFlushOnTheWire,
  graveyardGuildDir,
  restoreGuildDirFromGraveyard,
  sweepGraveyard,
  type FileRestoreHooks,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';

// NB11 (wip-redesign/sheets/NB11.md): the file restore from the graveyard and the TTL sweep, at the edges the
// mutation gate found untested: what each refusal answers and logs, the note written back, the rename backoff, and
// which folders a sweep removes.

const DAY_MS = 24 * 60 * 60 * 1000;
let guilds = 820_000_000_000_000_000n;
const freshGuild = () => String(++guilds);
const graveyard = () => dataPath('_graveyard');
const entryDir = (g: string, ms: number) => path.join(graveyard(), `${g}-${ms}`);
const same = (a: unknown, b: unknown) => path.resolve(String(a)) === path.resolve(String(b));
const errno = (code: string) => Object.assign(new Error(code), { code });
const tick = (ms = 5) => new Promise<void>(resolve => setTimeout(resolve, ms));
const NOTE = (g: string, ms: number) => JSON.stringify({ guildId: g, reason: 'webui-operator-delete', ts: ms }, null, 2);

function bury(g: string, ms: number, withNote = true): void {
  const dir = entryDir(g, ms);
  fs.mkdirSync(path.join(dir, 'm'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'm', 'a.json'), '{"n":5}');
  if (withNote) fs.writeFileSync(path.join(dir, '.graveyard.json'), NOTE(g, ms));
}
function makeDir(name: string): string {
  const dir = path.join(graveyard(), name);
  fs.mkdirSync(path.join(dir, 'm'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'm', 'a.json'), '{"n":1}');
  return dir;
}
const hooks = (over: Partial<FileRestoreHooks> = {}): FileRestoreHooks => ({ stop: () => null, writerLost: () => false, progress: { renamed: false }, ...over });

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
const TTL_BEFORE = process.env.GRAVEYARD_TTL_DAYS;

beforeEach(() => {
  delete process.env.GRAVEYARD_TTL_DAYS;
  fs.mkdirSync(graveyard(), { recursive: true });
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (TTL_BEFORE === undefined) delete process.env.GRAVEYARD_TTL_DAYS;
  else process.env.GRAVEYARD_TTL_DAYS = TTL_BEFORE;
});

const warned = (text: string) => warnSpy.mock.calls.some((c: unknown[]) => c[0] === text);
const logged = (text: string) => logSpy.mock.calls.some((c: unknown[]) => c[0] === text);

describe('restoreGuildDirFromGraveyard refusals', () => {
  it('answers a note read that fails without an errno as EIO, logs it, and keeps the entry', async () => {
    const g = freshGuild();
    const ms = Date.now();
    bury(g, ms);
    const note = path.join(entryDir(g, ms), '.graveyard.json');
    const readFile = fs.promises.readFile.bind(fs.promises);
    const failure = new Error('read failed');
    vi.spyOn(fs.promises, 'readFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (same(p, note)) throw failure;
      return (readFile as any)(p, ...rest);
    }) as any);
    const out = await restoreGuildDirFromGraveyard(g, ms, hooks());
    expect(out).toEqual({ ok: false, why: 'note', code: 'EIO', step: 'read' });
    expect(errorSpy).toHaveBeenCalledWith(`[DataManager] Cannot restore guild ${g}: the note of graveyard entry ${g}-${ms} could not be read:`, failure);
    expect(fs.readFileSync(note, 'utf8')).toBe(NOTE(g, ms));
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });

  it('logs a note that cannot be removed and keeps the entry with its note', async () => {
    const g = freshGuild();
    const ms = Date.now();
    bury(g, ms);
    const note = path.join(entryDir(g, ms), '.graveyard.json');
    const unlink = fs.promises.unlink.bind(fs.promises);
    const failure = errno('EACCES');
    vi.spyOn(fs.promises, 'unlink').mockImplementation((async (p: any) => {
      if (same(p, note)) throw failure;
      return unlink(p);
    }) as any);
    const out = await restoreGuildDirFromGraveyard(g, ms, hooks());
    expect(out).toEqual({ ok: false, why: 'note', code: 'EACCES' });
    expect(errorSpy).toHaveBeenCalledWith(`[DataManager] Cannot restore guild ${g}: the note of graveyard entry ${g}-${ms} could not be removed:`, failure);
    expect(fs.readFileSync(note, 'utf8')).toBe(NOTE(g, ms));
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });

  it('warns when the note cannot be written back after a stop', async () => {
    const g = freshGuild();
    const ms = Date.now();
    bury(g, ms);
    const note = path.join(entryDir(g, ms), '.graveyard.json');
    const writeFile = fs.promises.writeFile.bind(fs.promises);
    const failure = errno('EROFS');
    vi.spyOn(fs.promises, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (same(p, note)) throw failure;
      return (writeFile as any)(p, ...rest);
    }) as any);
    let stops = 0;
    const out = await restoreGuildDirFromGraveyard(g, ms, hooks({ stop: () => (++stops >= 3 ? 'maintenance' : null) }));
    expect(out).toEqual({ ok: false, why: 'stopped', stop: 'maintenance' });
    expect(warnSpy).toHaveBeenCalledWith(`[DataManager] Failed to write back the note of graveyard entry ${g}-${ms}:`, failure);
    expect(fs.readFileSync(path.join(entryDir(g, ms), 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });

  it('refuses when the writer is lost after the note left, puts the note back and leaves the entry in place', async () => {
    const g = freshGuild();
    const ms = Date.now();
    bury(g, ms);
    let asks = 0;
    const h = hooks({ writerLost: () => ++asks >= 2 });
    const out = await restoreGuildDirFromGraveyard(g, ms, h);
    expect(asks).toBe(2);
    expect(out).toEqual({ ok: false, why: 'writer-lost' });
    expect(errorSpy).toHaveBeenCalledWith(`[DataManager] Cannot restore guild ${g} from the graveyard: another process took the data files`);
    expect(h.progress.renamed).toBe(false);
    expect(fs.readFileSync(path.join(entryDir(g, ms), '.graveyard.json'), 'utf8')).toBe(NOTE(g, ms));
    expect(fs.readFileSync(path.join(entryDir(g, ms), 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });

  it('retries a failing rename ten times with a growing backoff, then logs it and puts the note back', async () => {
    const g = freshGuild();
    const ms = Date.now();
    bury(g, ms);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const rename = fs.promises.rename.bind(fs.promises);
    const tries: number[] = [];
    const failure = errno('EPERM');
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (same(from, entryDir(g, ms))) {
        tries.push(Date.now());
        throw failure;
      }
      return rename(from, to);
    }) as any);
    let done = false;
    const pending = restoreGuildDirFromGraveyard(g, ms, hooks()).finally(() => { done = true; });
    for (let i = 0; !done && i < 20_000; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(5);
    }
    const out = await pending;
    vi.useRealTimers();
    expect(out).toEqual({ ok: false, why: 'rename', code: 'EPERM' });
    expect(tries.slice(1).map((t, i) => t - tries[i])).toEqual([25, 50, 75, 100, 125, 150, 175, 200, 225]);
    expect(errorSpy).toHaveBeenCalledWith(`[DataManager] Failed to move graveyard entry ${g}-${ms} back:`, failure);
    expect(fs.readFileSync(path.join(entryDir(g, ms), '.graveyard.json'), 'utf8')).toBe(NOTE(g, ms));
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });

  it('restores the entry into place and logs the restore', async () => {
    const g = freshGuild();
    const ms = Date.now();
    bury(g, ms);
    const h = hooks();
    const out = await restoreGuildDirFromGraveyard(g, ms, h);
    expect(out).toEqual({ ok: true, retiredAt: ms, reason: 'webui-operator-delete' });
    expect(h.progress.renamed).toBe(true);
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
    expect(fs.existsSync(dataPath(g, '.graveyard.json'))).toBe(false);
    expect(warned(`[DataManager] Guild ${g} restored from graveyard entry ${g}-${ms}`)).toBe(true);
    fs.rmSync(dataPath(g), { recursive: true, force: true });
  });
});

describe('graveyardGuildDir', () => {
  it('waits for a flush on the wire under the guild before moving its folder', async () => {
    const g = freshGuild();
    const file = dataPath(g, 'm', 'a.json');
    const open = fs.promises.open.bind(fs.promises);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).startsWith(file + '.')) await gate;
      return (open as any)(p, ...rest);
    }) as any);
    enqueueWrite(file, '{"saved":1}');
    for (let i = 0; i < 200 && !fileFlushOnTheWire(); i++) await tick(2);
    expect(fileFlushOnTheWire()).toBe(true);
    let settled = false;
    const moving = graveyardGuildDir(g, 'test').finally(() => { settled = true; });
    await tick(120);
    expect(settled).toBe(false);
    release();
    expect(await moving).toBe(true);
    dropPendingForGuild(g);
    const entries = fs.readdirSync(graveyard()).filter(n => n.startsWith(`${g}-`));
    expect(entries.length).toBe(1);
    expect(fs.readFileSync(path.join(graveyard(), entries[0], 'm', 'a.json'), 'utf8')).toBe('{"saved":1}');
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });
});

describe('sweepGraveyard', () => {
  it('removes an expired entry and logs it', async () => {
    const name = `${freshGuild()}-${Date.now() - 30 * DAY_MS}`;
    const dir = makeDir(name);
    await sweepGraveyard();
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(graveyard(), `.sweep-${name}`))).toBe(false);
    expect(logged(`[DataManager] Swept expired graveyard entry: ${name}`)).toBe(true);
  });

  it('warns and claims no sweep when the set-aside folder cannot be removed, and removes it at the next sweep', async () => {
    const name = `${freshGuild()}-${Date.now() - 30 * DAY_MS}`;
    makeDir(name);
    const aside = path.join(graveyard(), `.sweep-${name}`);
    const rm = fs.promises.rm.bind(fs.promises);
    const failure = errno('EBUSY');
    const spy = vi.spyOn(fs.promises, 'rm').mockImplementation((async (p: any, o: any) => {
      if (same(p, aside)) throw failure;
      return rm(p, o);
    }) as any);
    await sweepGraveyard();
    expect(warnSpy).toHaveBeenCalledWith(`[DataManager] Failed to remove swept graveyard folder .sweep-${name} (removed at the next sweep):`, failure);
    expect(logged(`[DataManager] Swept expired graveyard entry: ${name}`)).toBe(false);
    expect(fs.existsSync(aside)).toBe(true);
    expect(fs.existsSync(path.join(graveyard(), name))).toBe(false);
    spy.mockRestore();
    await sweepGraveyard();
    expect(fs.existsSync(aside)).toBe(false);
  });

  it('removes a set-aside folder whatever its timestamp', async () => {
    const dir = makeDir(`.sweep-${freshGuild()}-${Date.now()}`);
    await sweepGraveyard();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('raises no failure for a set-aside folder that is already gone', async () => {
    const name = `.sweep-${freshGuild()}-${Date.now()}`;
    const readdir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: any, o: any) => {
      const got = await (readdir as any)(p, o);
      if (same(p, graveyard())) return [...got, { name, isDirectory: () => true }];
      return got;
    }) as any);
    await sweepGraveyard();
    expect(warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('Failed to remove swept graveyard folder'))).toEqual([]);
  });

  it('keeps an entry younger than the TTL', async () => {
    const name = `${freshGuild()}-${Date.now() - 1000}`;
    const dir = makeDir(name);
    await sweepGraveyard();
    expect(fs.readFileSync(path.join(dir, 'm', 'a.json'), 'utf8')).toBe('{"n":1}');
    expect(logged(`[DataManager] Swept expired graveyard entry: ${name}`)).toBe(false);
  });

  it('keeps an entry exactly at the TTL cutoff', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const name = `${freshGuild()}-${now - 14 * DAY_MS}`;
    const dir = makeDir(name);
    await sweepGraveyard();
    expect(fs.readFileSync(path.join(dir, 'm', 'a.json'), 'utf8')).toBe('{"n":1}');
  });

  it('sweeps an expired entry that names no guild even when every guild is skipped', async () => {
    const name = `-${Date.now() - 40 * DAY_MS - Number(guilds % 1000n)}`;
    const dir = makeDir(name);
    freshGuild();
    const asked: string[] = [];
    await sweepGraveyard(g => { asked.push(g); return true; });
    expect(fs.existsSync(dir)).toBe(false);
    expect(asked).not.toContain('');
    expect(logged(`[DataManager] Swept expired graveyard entry: ${name}`)).toBe(true);
  });

  it('warns and keeps an expired entry it cannot set aside', async () => {
    const name = `${freshGuild()}-${Date.now() - 30 * DAY_MS}`;
    const dir = makeDir(name);
    const rename = fs.promises.rename.bind(fs.promises);
    const failure = errno('EBUSY');
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (same(from, dir)) throw failure;
      return rename(from, to);
    }) as any);
    await sweepGraveyard();
    expect(warnSpy).toHaveBeenCalledWith(`[DataManager] Failed to sweep graveyard entry ${name} (tried again at the next sweep):`, failure);
    expect(fs.readFileSync(path.join(dir, 'm', 'a.json'), 'utf8')).toBe('{"n":1}');
    expect(logged(`[DataManager] Swept expired graveyard entry: ${name}`)).toBe(false);
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
