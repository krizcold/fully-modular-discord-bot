import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB14 tests 2 (wip-redesign/sheets/NB14.md, decisions 3, 6, 9 to 11, 14, 19, 20; rulings C1 to C3, C17, D1 to D4):
// the JSON restore and replace, the boot's recovery, the sweep and the notes.

const h = vi.hoisted(() => ({
  renameSync: null as null | ((real: (a: any, b: any) => void, a: any, b: any) => void),
  readFileSync: null as null | ((real: (...args: any[]) => any, ...args: any[]) => any),
  syncCalls: [] as string[],
}));
vi.mock('fs', async importOriginal => {
  const real = await importOriginal<any>();
  const renameSync = (a: any, b: any) => {
    h.syncCalls.push(`renameSync ${String(a)} -> ${String(b)}`);
    return h.renameSync ? h.renameSync(real.renameSync, a, b) : real.renameSync(a, b);
  };
  const readFileSync = (...args: any[]) => (h.readFileSync ? h.readFileSync(real.readFileSync, ...args) : real.readFileSync(...args));
  const fsyncSync = (fd: any) => {
    h.syncCalls.push('fsyncSync');
    return real.fsyncSync(fd);
  };
  const rmSync = (...args: any[]) => {
    h.syncCalls.push(`rmSync ${String(args[0])}`);
    return real.rmSync(...args);
  };
  const over = { renameSync, readFileSync, fsyncSync, rmSync };
  return { ...real, ...over, default: { ...real, ...over } };
});

import fs from 'fs';
import { gateEventDispatch } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import {
  enqueueWrite,
  graveyardGuildDir,
  listGraveyardEntries,
  nextGraveyardName,
  recoverGraveyardRestores,
  setGuildViewCache,
  sweepGraveyard as sweepFiles,
  writeGraveyardNote,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { importBundle, writeBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import {
  appendDataTracked,
  flushAll,
  loadData,
  restoreGuildFromGraveyard,
  saveData,
  saveDataTracked,
  sweepGraveyard as sweepAll,
} from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { checkWriterLock, configureWriterLock, deposedText, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

const X = 1000;
const OTHER = 424242;
const NO_ENTRY = 'no graveyard entry for this guild';
const WRITER_LOST = "Another process took over the bot's data files, so nothing was restored. Please try again in a moment.";
const OUT_OF_TIME = 'the restore ran out of its 40 s before it could commit; nothing was restored; try again in a moment';
const BARRIER_LINE = "it comes from a command that started before the server's data was restored from the graveyard";
const DAY = 24 * 60 * 60 * 1000;
const copyDeadline = (x: number, k: number) => `entry ${x} could not be copied before the restore's deadline (${k} file(s) copied); nothing was restored`;
const undoText = (x: number, code: string) => `the copy of entry ${x} could not be put in place (${code}); nothing was restored; the server's data is back in place; try again in a moment`;
const halfText = (g: string, x: number, r: number, code: string, undoCode: string) => `the server's data was moved to graveyard entry ${r}, but the copy of entry ${x} could not be put in place (${code}) and the data could not be moved back (${undoCode}). The server had no data when this answer was made; nothing is lost: entries ${r} and ${x} are both in \`smdb graveyard list\`. To put the server's data back, run: smdb graveyard restore ${g} ${r} --replace; to restore entry ${x} instead: smdb graveyard restore ${g} ${x} --replace`;
const halfTakenText = (g: string, x: number, r: number, code: string) => `another process took over the bot's data files during the restore, after the server's data was moved to graveyard entry ${r}: the copy of entry ${x} could not be put in place (${code}), and this process did not move the data back. Can't confirm what the server holds now: no data, entry ${x}'s data (if the bot that took over finished this restore when it started), or data that process saved since. Nothing is lost: entries ${r} and ${x} are both in \`smdb graveyard list\`. To put the server's data back, run: smdb graveyard restore ${g} ${r} --replace; to restore entry ${x} instead: smdb graveyard restore ${g} ${x} --replace`;
const undoTakenText = (x: number, code: string) => `the copy of entry ${x} could not be put in place (${code}); nothing was restored. The server's data was moved back, but another process took over the bot's data files at the same moment: can't confirm that it saved nothing over those files, and a file it replaced then is in no graveyard entry. Entry ${x} stays listed. Check the server's data before you try again.`;
const stampText = (x: number, code: string) => `entry ${x} could not be marked as restored (${code}); nothing was restored; try again in a moment`;
const k6Line = (g: string, r: number) => `[DataManager] Graveyard entry ${g}-${r} holds guild ${g}'s data from before the replace; its note was not written: another process took the data files`;

let guilds = 810_000_000_000_000_000n;
const freshGuild = () => String(++guilds);
const entryDir = (g: string, ms: number) => dataPath('_graveyard', `${g}-${ms}`);
const tick = (ms = 5) => new Promise<void>(resolve => setTimeout(resolve, ms));
const monoIn = (ms: number) => process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
const opts = (guildId: string) => ({ guildId, category: 'm' });
const errno = (code: string) => Object.assign(new Error(code), { code });
const same = (a: unknown, b: unknown) => path.resolve(String(a)) === path.resolve(String(b));
const base = (p: unknown) => path.basename(String(p));
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};

const PREV = { 'm/a.json': '{"prev":1}', 'm/balances.json': '{"b":7}' };
const XFILES = { 'm/a.json': '{"x":1}', 'm/c.json': '{"c":3}' };

/** An entry as graveyardGuildDir leaves it: the folder and its note. */
function bury(g: string, ms: number, files: Record<string, string> = XFILES, reason = 'webui-operator-delete'): void {
  writeTree(entryDir(g, ms), files);
  fs.writeFileSync(path.join(entryDir(g, ms), '.graveyard.json'), JSON.stringify({ guildId: g, reason, ts: ms }, null, 2));
}
function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
}
/** Every file under dir by its path relative to dir, the note left out unless asked. */
function tree(dir: string, withNote = false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (withNote || e.name !== '.graveyard.json') out[r] = fs.readFileSync(path.join(dir, r), 'utf8');
    }
  };
  walk('');
  return out;
}
const note = (g: string, ms: number) => JSON.parse(fs.readFileSync(path.join(entryDir(g, ms), '.graveyard.json'), 'utf8'));
const listed = async (g: string) => (await listGraveyardEntries()).filter(e => e.guildId === g);
const hidden = (g: string) => fs.readdirSync(dataPath('_graveyard')).filter(n => n.startsWith('.') && n.includes(`-${g}-`));
const replace = (g: string, x?: number, deadline = monoIn(40_000)) => restoreGuildFromGraveyard(g, x, deadline, true);

type Hook = (src: string, dest: string, real: () => Promise<void>) => Promise<void>;
/** Every fs.promises.rename goes through the hook, which runs the real rename when it calls real(). */
function onRename(hook: Hook): void {
  const rename = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementation((async (a: any, b: any) => hook(String(a), String(b), () => rename(a, b))) as any);
}
const isK4 = (g: string) => (src: string) => same(src, dataPath(g));
const isK5 = (g: string) => (src: string, dest: string) => base(src).startsWith('.restore-') && same(dest, dataPath(g));
const isRestoreRename = (src: string) => base(src).startsWith('.copy-');
const isDrop = (_src: string, dest: string) => base(dest).startsWith('.sweep-restore-');

const CLOSED = { cause: 'hook' as const, message: 'maintenance' };
const takeOver = () => fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const lines = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((c: unknown[]) => c.map(String).join(' '));

beforeEach(() => {
  setBackendKind('file');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  fs.rmSync(`${writerLockPath()}.takeover`, { recursive: true, force: true });
  const live = new Set([process.pid, OTHER]);
  configureWriterLock('bot', { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() });
  expect(takeWriterLock().kind).toBe('taken');
  h.syncCalls.length = 0;
});

afterEach(async () => {
  h.renameSync = null;
  h.readFileSync = null;
  vi.restoreAllMocks();
  setMaintenanceGate(null);
  setGuildViewCache(false);
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  await flushAll();
  await tick(20);
});

describe('a replace and a plain restore copy', () => {
  it('a replace copies X in and moves the live folder to R', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    const reply = await replace(g, X);
    const r = (await listed(g))[0].retiredAt;
    expect(reply).toEqual({ ok: true, retiredAt: X, reason: 'webui-operator-delete', keptUntil: expect.any(Number), replaced: { retiredAt: r, reason: `replaced-by-restore-${X}` } });
    expect(tree(dataPath(g), true)).toEqual(XFILES);
    expect(tree(entryDir(g, r))).toEqual(PREV);
    expect(note(g, r)).toMatchObject({ guildId: g, reason: `replaced-by-restore-${X}` });
    expect(tree(entryDir(g, X))).toEqual(XFILES);
    expect(note(g, X)).toMatchObject({ guildId: g, reason: 'webui-operator-delete', ts: X, usedAt: expect.any(Number) });
    expect(await listed(g)).toEqual([
      { guildId: g, retiredAt: r, reason: `replaced-by-restore-${X}` },
      { guildId: g, retiredAt: X, reason: 'webui-operator-delete' },
    ]);
    await tick(20);
    expect(hidden(g)).toEqual([]);
  });

  it('a plain restore copies and keeps the entry listed', async () => {
    const g = freshGuild();
    bury(g, X);
    expect(await restoreGuildFromGraveyard(g, X)).toEqual({ ok: true, retiredAt: X, reason: 'webui-operator-delete', keptUntil: expect.any(Number) });
    expect(tree(dataPath(g), true)).toEqual(XFILES);
    expect(await listed(g)).toEqual([{ guildId: g, retiredAt: X, reason: 'webui-operator-delete' }]);
    expect(tree(entryDir(g, X))).toEqual(XFILES);
  });

  it('a replace with no live folder is a plain restore', async () => {
    const g = freshGuild();
    bury(g, X);
    expect(await replace(g)).toEqual({ ok: true, retiredAt: X, reason: 'webui-operator-delete', keptUntil: expect.any(Number), replaced: null });
    expect(tree(dataPath(g))).toEqual(XFILES);
    expect(await listed(g)).toEqual([{ guildId: g, retiredAt: X, reason: 'webui-operator-delete' }]);
  });

  it('R is newer than every entry, and so is a delete\'s', async () => {
    const g = freshGuild();
    const now = Date.now();
    bury(g, 100);
    bury(g, now + 60_000);
    writeTree(dataPath(g), PREV);
    const reply = await replace(g, 100);
    expect(reply).toMatchObject({ ok: true, replaced: { retiredAt: now + 60_001 } });
    expect(await graveyardGuildDir(g, 'test')).toBe(true);
    expect((await listed(g)).map(e => e.retiredAt)).toEqual([now + 60_002, now + 60_001, now + 60_000, 100]);
  });

  it('a stale module copy loses no version', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), { 'm/config.json': '{"v":"old"}' });
    bury(g, X, { 'm/config.json': '{"v":"x"}' });
    const reply = await replace(g, X) as any;
    expect(reply.ok).toBe(true);
    saveData('config.json', opts(g), { v: 'old' });
    await flushAll();
    expect(fs.readFileSync(path.join(entryDir(g, X), 'm', 'config.json'), 'utf8')).toBe('{"v":"x"}');
    expect(fs.readFileSync(path.join(entryDir(g, reply.replaced.retiredAt), 'm', 'config.json'), 'utf8')).toBe('{"v":"old"}');
    const again = await replace(g, X) as any;
    expect(again).toMatchObject({ ok: true, retiredAt: X });
    expect(fs.readFileSync(dataPath(g, 'm', 'config.json'), 'utf8')).toBe('{"v":"x"}');
    expect(JSON.parse(fs.readFileSync(path.join(entryDir(g, again.replaced.retiredAt), 'm', 'config.json'), 'utf8'))).toEqual({ v: 'old' });
  });
});

describe('the keep time and the stamp', () => {
  it('a restore restarts the keep time', async () => {
    const g = freshGuild();
    process.env.GRAVEYARD_TTL_DAYS = '14';
    try {
      const x = Date.now() - 14 * DAY + 60 * 60 * 1000;
      bury(g, x);
      writeTree(dataPath(g), PREV);
      const before = Date.now();
      const reply = await replace(g, x) as any;
      expect(reply.keptUntil).toBeGreaterThanOrEqual(before + 14 * DAY);
      expect(reply.keptUntil).toBeLessThanOrEqual(Date.now() + 14 * DAY);
      expect(note(g, x)).toMatchObject({ reason: 'webui-operator-delete', usedAt: reply.keptUntil - 14 * DAY });
      const realNow = Date.now;
      for (const ahead of [2 * 60 * 60 * 1000, DAY]) {
        vi.spyOn(Date, 'now').mockReturnValue(realNow() + ahead);
        await sweepFiles();
        expect(tree(entryDir(g, x))).toEqual(XFILES);
        vi.mocked(Date.now).mockRestore();
      }
      vi.spyOn(Date, 'now').mockReturnValue(reply.keptUntil + 1000);
      await sweepFiles();
      expect(fs.existsSync(entryDir(g, x))).toBe(false);
    } finally {
      delete process.env.GRAVEYARD_TTL_DAYS;
    }
  });

  it('a refused try keeps the stamp only', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    vi.spyOn(fs.promises, 'cp').mockRejectedValueOnce(errno('ENOSPC'));
    expect(await replace(g, X)).toEqual({ ok: false, code: 'io-error', error: `entry ${X} could not be copied (ENOSPC); nothing was restored; free disk space, then try again` });
    expect(note(g, X).usedAt).toEqual(expect.any(Number));
    expect(tree(dataPath(g))).toEqual(PREV);
    expect(await listed(g)).toHaveLength(1);

    const g2 = freshGuild();
    bury(g2, X);
    onRename(async (src, dest, real) => {
      if (base(dest) === '.graveyard.json' && same(path.dirname(dest), entryDir(g2, X))) throw errno('EPERM');
      return real();
    });
    const cp = vi.spyOn(fs.promises, 'cp');
    cp.mockClear();
    expect(await restoreGuildFromGraveyard(g2, X)).toEqual({ ok: false, code: 'io-error', error: stampText(X, 'EPERM') });
    expect(cp).not.toHaveBeenCalled();
    expect(note(g2, X)).toEqual({ guildId: g2, reason: 'webui-operator-delete', ts: X });
  });

  it('an entry with no note restores, and a note read error refuses', async () => {
    const g = freshGuild();
    writeTree(entryDir(g, X), XFILES);
    expect(await restoreGuildFromGraveyard(g, X)).toMatchObject({ ok: true, retiredAt: X, reason: '' });
    expect(note(g, X)).toEqual({ guildId: g, reason: '', ts: X, usedAt: expect.any(Number) });

    const g2 = freshGuild();
    writeTree(dataPath(g2), PREV);
    bury(g2, X);
    const before = fs.readFileSync(path.join(entryDir(g2, X), '.graveyard.json'), 'utf8');
    const readFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'readFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (same(p, path.join(entryDir(g2, X), '.graveyard.json'))) throw errno('EMFILE');
      return (readFile as any)(p, ...rest);
    }) as any);
    const cp = vi.spyOn(fs.promises, 'cp');
    expect(await replace(g2, X)).toEqual({ ok: false, code: 'io-error', error: stampText(X, 'EMFILE') });
    expect(fs.readFileSync(path.join(entryDir(g2, X), '.graveyard.json'), 'utf8')).toBe(before);
    expect(cp).not.toHaveBeenCalled();
    expect(tree(dataPath(g2))).toEqual(PREV);
  });

  it('the stamp never makes X\'s folder', async () => {
    for (const kind of ['replace', 'plain'] as const) {
      const g = freshGuild();
      if (kind === 'replace') writeTree(dataPath(g), PREV);
      bury(g, X);
      const open = fs.promises.open.bind(fs.promises);
      vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
        if (same(path.dirname(String(p)), entryDir(g, X)) && String(p).endsWith('.tmp')) fs.renameSync(entryDir(g, X), dataPath('_graveyard', `.sweep-${g}-${X}`));
        return (open as any)(p, ...rest);
      }) as any);
      expect(await restoreGuildFromGraveyard(g, X, monoIn(40_000), kind === 'replace')).toEqual({ ok: false, code: 'invalid', error: NO_ENTRY });
      expect(fs.existsSync(entryDir(g, X))).toBe(false);
      if (kind === 'replace') expect(tree(dataPath(g))).toEqual(PREV);
      else expect(fs.existsSync(dataPath(g))).toBe(false);
      await tick(20);
      expect(hidden(g).filter(n => !n.startsWith('.sweep-'))).toEqual([]);
      vi.restoreAllMocks();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    }

    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    onRename(async (src, dest, real) => {
      await real();
      if (isRestoreRename(src)) fs.rmSync(entryDir(g, X), { recursive: true });
    });
    expect(await replace(g, X)).toEqual({ ok: false, code: 'invalid', error: NO_ENTRY });
    expect(tree(dataPath(g))).toEqual(PREV);
    await tick(20);
    expect(hidden(g).filter(n => !n.startsWith('.sweep-'))).toEqual([]);
  });
});

describe('the copy', () => {
  it('the copy\'s errors change nothing', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    vi.spyOn(fs.promises, 'cp').mockRejectedValueOnce(errno('ENOSPC'));
    expect(await replace(g, X)).toMatchObject({ ok: false, code: 'io-error' });
    expect(tree(dataPath(g))).toEqual(PREV);
    expect(tree(entryDir(g, X))).toEqual(XFILES);
    vi.restoreAllMocks();

    const g2 = freshGuild();
    writeTree(dataPath(g2), PREV);
    bury(g2, X);
    const cp = fs.promises.cp.bind(fs.promises);
    vi.spyOn(fs.promises, 'cp').mockImplementation((async (a: any, b: any, o: any) => {
      fs.rmSync(entryDir(g2, X), { recursive: true });
      return (cp as any)(a, b, o);
    }) as any);
    expect(await replace(g2, X)).toEqual({ ok: false, code: 'invalid', error: NO_ENTRY });
    expect(tree(dataPath(g2))).toEqual(PREV);
    vi.restoreAllMocks();

    const g3 = freshGuild();
    writeTree(dataPath(g3), PREV);
    bury(g3, X);
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags: any, ...rest: any[]) => {
      const fh = await (open as any)(p, flags, ...rest);
      if (flags === 'r+' && String(p).includes(`.copy-${g3}-`) && base(p) === 'c.json') fh.sync = async () => { throw errno('EIO'); };
      return fh;
    }) as any);
    expect(await replace(g3, X)).toEqual({ ok: false, code: 'io-error', error: `entry ${X} could not be copied (EIO); nothing was restored; try again in a moment` });
    expect(tree(dataPath(g3))).toEqual(PREV);
    await tick(20);
    expect(hidden(g3).filter(n => !n.startsWith('.sweep-'))).toEqual([]);
  });

  it.each(['replace', 'plain'] as const)('the copy stops at its deadline (%s)', async kind => {
    const g = freshGuild();
    if (kind === 'replace') writeTree(dataPath(g), PREV);
    const ten = Object.fromEntries(Array.from({ length: 10 }, (_v, i) => [`m/f${i}.json`, `{"i":${i}}`]));
    bury(g, X, ten);
    const deadline = monoIn(40_000);
    let files = 0;
    const realBig = process.hrtime.bigint;
    let offset = 0n;
    vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => realBig() + offset);
    const lstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: any, ...rest: any[]) => {
      const st = await (lstat as any)(p, ...rest);
      if (String(p).includes(`${g}-${X}`) && st.isFile() && ++files === 3) offset = 36_000_000_000n;
      return st;
    }) as any);
    expect(await restoreGuildFromGraveyard(g, X, deadline, kind === 'replace')).toEqual({ ok: false, code: 'backend-unavailable', error: copyDeadline(X, 3) });
    if (kind === 'replace') expect(tree(dataPath(g))).toEqual(PREV);
    else expect(fs.existsSync(dataPath(g))).toBe(false);
    expect(hidden(g).filter(n => n.startsWith('.copy-') || n.startsWith('.restore-'))).toEqual([]);
  });

  it('the maintenance gate closed during the copy refuses at the next file', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    const lstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: any, ...rest: any[]) => {
      const st = await (lstat as any)(p, ...rest);
      if (String(p).includes(`${g}-${X}`) && st.isFile()) setMaintenanceGate(CLOSED);
      return st;
    }) as any);
    await expect(replace(g, X)).rejects.toThrow();
    expect(tree(dataPath(g))).toEqual(PREV);
    expect(hidden(g).filter(n => n.startsWith('.copy-') || n.startsWith('.restore-'))).toEqual([]);
  });

  it('events past 256 during the copy drop the oldest', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    const held = deferred();
    const reached = deferred();
    const lstat = fs.promises.lstat.bind(fs.promises);
    let first = true;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: any, ...rest: any[]) => {
      if (first && String(p).includes(`${g}-${X}`)) {
        first = false;
        reached.resolve();
        await held.promise;
      }
      return (lstat as any)(p, ...rest);
    }) as any);
    const running = replace(g, X);
    await reached.promise;
    const ran: number[] = [];
    for (let i = 0; i < 300; i++) expect(await gateEventDispatch('messageCreate', [{ guildId: g }], () => { ran.push(i); })).toBe(false);
    expect(lines(warn).some(l => l.includes(`Event buffer overflow for guild ${g}`))).toBe(true);
    held.resolve();
    expect(await running).toMatchObject({ ok: true });
    expect(ran).toEqual(Array.from({ length: 256 }, (_v, i) => i + 44));
  });

  it('a refusal at the copy\'s first filter call drops nothing and answers at once', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    const drops: string[] = [];
    onRename(async (src, dest, real) => {
      if (isDrop(src, dest)) drops.push(base(src));
      await real();
    });
    const started = Date.now();
    expect(await replace(g, X, monoIn(4_000))).toEqual({ ok: false, code: 'backend-unavailable', error: copyDeadline(X, 0) });
    expect(Date.now() - started).toBeLessThan(100);
    expect(drops).toEqual([]);
    expect(lines(error).filter(l => l.includes('Cannot drop'))).toEqual([]);
    expect(tree(dataPath(g))).toEqual(PREV);
    expect(hidden(g)).toEqual([]);
  });

  it('a copy another process already removed is not retried, and the drop says so once', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    const deadline = monoIn(40_000);
    const realBig = process.hrtime.bigint;
    let offset = 0n;
    vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => realBig() + offset);
    const drops: string[] = [];
    onRename(async (src, dest, real) => {
      if (isDrop(src, dest)) {
        drops.push(base(src));
        fs.rmSync(src, { recursive: true, force: true });
      }
      await real();
      if (isRestoreRename(src)) offset = deadline - realBig() - 4_900_000_000n;
    });
    const started = Date.now();
    expect(await replace(g, X, deadline)).toEqual({ ok: false, code: 'backend-unavailable', error: copyDeadline(X, 2) });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatch(new RegExp(`^\\.restore-${g}-${X}-\\d+$`));
    expect(lines(warn).filter(l => l.includes('already removed'))).toEqual([`[DataManager] The restore's copy ${drops[0]} was already removed; nothing to drop`]);
    expect(lines(error).filter(l => l.includes('Cannot drop'))).toEqual([]);
    expect(tree(dataPath(g))).toEqual(PREV);
  });

  it('a graveyard folder that cannot be listed fails a restore of the newest entry, nothing moved', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    const readdir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: any, ...rest: any[]) => {
      if (same(p, dataPath('_graveyard'))) throw errno('EMFILE');
      return (readdir as any)(p, ...rest);
    }) as any);
    expect(await replace(g)).toEqual({ ok: false, code: 'io-error', error: 'the restore stopped on an error in the bot (EMFILE); nothing was restored; see the bot log' });
    vi.restoreAllMocks();
    expect(tree(dataPath(g))).toEqual(PREV);
    expect(tree(entryDir(g, X))).toEqual(XFILES);
    expect(note(g, X).usedAt).toBeUndefined();
    expect(await listed(g)).toEqual([{ guildId: g, retiredAt: X, reason: 'webui-operator-delete' }]);
    expect(hidden(g)).toEqual([]);
  });
});

describe('the renames', () => {
  it('a failed rename of the copy is undone and fenced', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    const loaded = deferred<unknown>();
    const answered = deferred();
    let tries = 0;
    onRename(async (src, dest, real) => {
      if (isK5(g)(src, dest)) {
        if (tries++ === 0) {
          void runInLedger(openLedger('interaction'), 'm', async () => {
            loaded.resolve(loadData('balances.json', opts(g), { b: 0 }));
            await answered.promise;
            return saveDataTracked('balances.json', opts(g), { b: 0 });
          }).then(r => saved.resolve(r));
        }
        throw errno('EPERM');
      }
      return real();
    });
    const saved = deferred<unknown>();
    const reply = await replace(g, X);
    expect(reply).toEqual({ ok: false, code: 'io-error', error: undoText(X, 'EPERM') });
    expect(await loaded.promise).toEqual({ b: 0 });
    answered.resolve();
    expect(await saved.promise).toEqual({ outcome: 'refused', cause: 'not-ready' });
    await flushAll();
    expect(tree(dataPath(g))).toEqual(PREV);
    expect(await listed(g)).toEqual([{ guildId: g, retiredAt: X, reason: 'webui-operator-delete' }]);
  });

  it('both renames failing answer the half text, both entries listed', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    onRename(async (src, dest, real) => {
      if (isK5(g)(src, dest)) throw errno('EPERM');
      return real();
    });
    h.renameSync = (real, a, b) => {
      if (same(b, dataPath(g))) throw errno('EBUSY');
      return real(a, b);
    };
    const reply = await replace(g, X);
    const r = (await listed(g))[0].retiredAt;
    expect(reply).toEqual({ ok: false, code: 'io-error', error: halfText(g, X, r, 'EPERM', 'EBUSY') });
    expect(tree(entryDir(g, r))).toEqual(PREV);
    expect(tree(entryDir(g, X))).toEqual(XFILES);
    expect(note(g, X).reason).toBe('webui-operator-delete');
    expect(fs.existsSync(dataPath(g))).toBe(false);
    expect(hidden(g).filter(n => n.startsWith('.restore-'))).toEqual([]);
    expect(saveDataTracked('x.json', opts(g), { y: 1 }).outcome).toBe('saved');
  });

  it('R\'s note that cannot be written is not claimed', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    onRename(async (src, dest, real) => {
      if (base(dest) === '.graveyard.json' && !same(path.dirname(dest), entryDir(g, X))) throw errno('EPERM');
      return real();
    });
    const reply = await replace(g, X) as any;
    expect(reply).toMatchObject({ ok: true, retiredAt: X });
    expect(reply.replaced).toEqual({ retiredAt: expect.any(Number) });
    expect(await listed(g)).toContainEqual({ guildId: g, retiredAt: reply.replaced.retiredAt, reason: '' });
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const again = await replace(g, reply.replaced.retiredAt) as any;
    expect(again).toMatchObject({ ok: true, retiredAt: reply.replaced.retiredAt, reason: '' });
    expect(note(g, reply.replaced.retiredAt)).toMatchObject({ reason: '', usedAt: expect.any(Number) });
    expect(tree(dataPath(g))).toEqual(PREV);
    expect(tree(entryDir(g, again.replaced.retiredAt))).toEqual(XFILES);
  });

  it('queued writes refuse the replace', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    const open = fs.promises.open.bind(fs.promises);
    let failing = true;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (failing && String(p).includes(`${path.sep}${g}${path.sep}m${path.sep}q.json`)) throw errno('ENOSPC');
      return (open as any)(p, ...rest);
    }) as any);
    enqueueWrite(dataPath(g, 'm', 'q.json'), '{"q":1}');
    await vi.waitFor(() => expect(lines(error).some(l => l.includes('q.json'))).toBe(true));
    expect(await replace(g, X)).toEqual({ ok: false, code: 'backend-unavailable', error: "a file of this server keeps failing to save (m/q.json: ENOSPC); nothing was restored; free disk space or fix the file's permissions, then try again" });
    expect(tree(dataPath(g))).toEqual(PREV);
    expect(hidden(g)).toEqual([]);
    failing = false;
    await flushAll();
    expect(fs.readFileSync(dataPath(g, 'm', 'q.json'), 'utf8')).toBe('{"q":1}');
  });

  it('no gate read inside the rename section', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    onRename(async (src, dest, real) => {
      if (isK4(g)(src)) {
        await real();
        setMaintenanceGate(CLOSED);
        return;
      }
      return real();
    });
    expect(await replace(g, X)).toMatchObject({ ok: true, retiredAt: X });
    expect(tree(dataPath(g))).toEqual(XFILES);

    const g2 = freshGuild();
    writeTree(dataPath(g2), PREV);
    bury(g2, X);
    setMaintenanceGate(null);
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    onRename(async (src, dest, real) => {
      await real();
      if (isRestoreRename(src)) setMaintenanceGate(CLOSED);
    });
    await expect(replace(g2, X)).rejects.toThrow();
    expect(tree(dataPath(g2))).toEqual(PREV);
    expect(hidden(g2).filter(n => n.startsWith('.restore-'))).toEqual([]);
  });

  it('the deadline floor: 4.9 s left at the check answers the copy\'s text', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    const deadline = monoIn(40_000);
    const realBig = process.hrtime.bigint;
    let offset = 0n;
    vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => realBig() + offset);
    onRename(async (src, dest, real) => {
      await real();
      if (isRestoreRename(src)) offset = deadline - realBig() - 4_900_000_000n;
    });
    expect(await replace(g, X, deadline)).toEqual({ ok: false, code: 'backend-unavailable', error: copyDeadline(X, 2) });
    expect(tree(dataPath(g))).toEqual(PREV);
  });

  it('a view read before a replace is not used after it', async () => {
    setGuildViewCache(true);
    const g = freshGuild();
    writeTree(dataPath(g), { 'm/A.json': '{"big":1}' });
    bury(g, X, { 'm/a.json': '{"small":1}' });
    expect(loadData('A.json', opts(g), {})).toEqual({ big: 1 });
    expect(await replace(g, X)).toMatchObject({ ok: true });
    expect(saveData('a.json', opts(g), { small: 2 })).toBe(true);
    await flushAll();
    expect(fs.readdirSync(dataPath(g, 'm'))).toEqual(['a.json']);
    expect(JSON.parse(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8'))).toEqual({ small: 2 });
  });

  it('a command that read before a replace cannot save or append after it', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    const gate = deferred();
    const run = runInLedger(openLedger('interaction'), 'm', async () => {
      loadData('a.json', opts(g), {});
      await gate.promise;
      return { save: saveDataTracked('a.json', opts(g), { n: 1 }), append: appendDataTracked('l.jsonl', opts(g), 'x\n') };
    });
    expect(await replace(g, X)).toMatchObject({ ok: true });
    gate.resolve();
    expect(await run).toEqual({ save: { outcome: 'refused', cause: 'not-ready' }, append: { outcome: 'refused', cause: 'not-ready' } });
    expect(lines(warn)).toContain(`[Data] Append for guild ${g} refused: ${BARRIER_LINE}`);
    expect(tree(dataPath(g))).toEqual(XFILES);
  });
  it.skipIf(process.platform === 'win32')('the fsyncs come in order', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    const events: string[] = [];
    const label = (p: unknown): string | null => {
      if (same(p, dataPath())) return 'data';
      if (same(p, dataPath('_graveyard'))) return 'graveyard';
      if (same(p, dataPath(g))) return 'live';
      const name = base(p);
      if (name.startsWith(`.copy-${g}-`)) return 'copy';
      if (name.startsWith(`.restore-${g}-`)) return 'restore';
      if (name.startsWith(`${g}-`) && name !== `${g}-${X}`) return 'R';
      return null;
    };
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags: any, ...rest: any[]) => {
      const fh = await (open as any)(p, flags, ...rest);
      const what = flags === 'r+' && String(p).includes(`.copy-${g}-`) ? 'copy-file' : label(p);
      const sync = fh.sync.bind(fh);
      fh.sync = async () => {
        await sync();
        if (what === 'copy-file' || what === 'data' || what === 'graveyard') events.push(`sync ${what}`);
      };
      return fh;
    }) as any);
    onRename(async (src, dest, real) => {
      await real();
      const from = label(src);
      const to = label(dest);
      if (from && to) events.push(`rename ${from} -> ${to}`);
    });
    expect(await replace(g, X)).toMatchObject({ ok: true });
    const first = events.indexOf('sync copy-file');
    const put = events.indexOf('rename restore -> live');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(events.slice(first, put + 1)).toEqual([
      'sync copy-file', 'sync copy-file',
      'rename copy -> restore',
      'sync data', 'sync graveyard',
      'rename live -> R',
      'sync data', 'sync graveyard',
      'rename restore -> live',
    ]);
  });
});

describe('the boot\'s recovery and the sweep', () => {
  /** Runs a replace whose step hangs forever once the rename matched has run (after: the real rename runs first). */
  async function abandonAt(g: string, match: (src: string, dest: string) => boolean, after: boolean): Promise<void> {
    const reached = deferred();
    onRename(async (src, dest, real) => {
      if (match(src, dest)) {
        if (after) await real();
        reached.resolve();
        await new Promise<never>(() => {});
      }
      return real();
    });
    void replace(g, X);
    await reached.promise;
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  }
  /** Every file of PREV and of X is live or in a listed entry. */
  async function nothingLost(g: string): Promise<void> {
    const sets = [fs.existsSync(dataPath(g)) ? tree(dataPath(g)) : {}];
    for (const e of await listed(g)) sets.push(tree(entryDir(g, e.retiredAt)));
    for (const files of [PREV, XFILES]) expect(sets).toContainEqual(files);
  }

  it('a crash before K4 is dropped by the boot; one after K4 is finished; one after K5 needs nothing', async () => {
    const g1 = freshGuild();
    writeTree(dataPath(g1), PREV);
    bury(g1, X);
    await abandonAt(g1, isK4(g1), false);
    expect(hidden(g1).filter(n => n.startsWith('.restore-'))).toHaveLength(1);
    h.syncCalls.length = 0;
    recoverGraveyardRestores();
    expect(h.syncCalls.some(c => c.startsWith('rmSync'))).toBe(false);
    expect(hidden(g1).filter(n => n.startsWith('.restore-') || n.startsWith('.copy-'))).toEqual([]);
    expect(tree(dataPath(g1))).toEqual(PREV);
    await nothingLost(g1);

    const g2 = freshGuild();
    writeTree(dataPath(g2), PREV);
    bury(g2, X);
    await abandonAt(g2, isK4(g2), true);
    expect(fs.existsSync(dataPath(g2))).toBe(false);
    recoverGraveyardRestores();
    expect(tree(dataPath(g2))).toEqual(XFILES);
    const r = (await listed(g2))[0];
    expect(r.reason).toBe(`replaced-by-restore-${X}`);
    expect(tree(entryDir(g2, r.retiredAt))).toEqual(PREV);
    await nothingLost(g2);

    const g3 = freshGuild();
    writeTree(dataPath(g3), PREV);
    bury(g3, X);
    await abandonAt(g3, isK5(g3), true);
    recoverGraveyardRestores();
    expect(tree(dataPath(g3))).toEqual(XFILES);
    expect((await listed(g3))[0].reason).toBe('');
    await nothingLost(g3);

    await sweepFiles();
    for (const g of [g1, g2, g3]) expect(hidden(g)).toEqual([]);

    // The abandoned steps still hold their guilds in the old module graph: the next start is a fresh one.
    vi.resetModules();
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    for (const g of [g1, g2, g3]) {
      for (const e of await listed(g)) {
        expect(await dm.restoreGuildFromGraveyard(g, e.retiredAt, monoIn(40_000), true)).toMatchObject({ ok: true, retiredAt: e.retiredAt });
        await nothingLost(g);
      }
    }
  });

  it('a crash during the copy leaves a .copy- folder the boot drops', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    const reached = deferred();
    const lstat = fs.promises.lstat.bind(fs.promises);
    let n = 0;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: any, ...rest: any[]) => {
      const st = await (lstat as any)(p, ...rest);
      if (String(p).includes(`${g}-${X}`) && st.isFile() && ++n === 2) {
        reached.resolve();
        await new Promise<never>(() => {});
      }
      return st;
    }) as any);
    void replace(g, X);
    await reached.promise;
    vi.restoreAllMocks();
    expect(hidden(g).filter(x => x.startsWith('.copy-'))).toHaveLength(1);
    recoverGraveyardRestores();
    expect(hidden(g).filter(x => x.startsWith('.copy-'))).toEqual([]);
    expect(tree(dataPath(g))).toEqual(PREV);
  });

  it('the boot\'s recovery is synchronous, and a note it cannot write is logged once', async () => {
    const g = freshGuild();
    const r = Date.now() + 5000;
    writeTree(entryDir(g, X), XFILES);
    writeTree(entryDir(g, r), PREV);
    writeTree(dataPath('_graveyard', `.restore-${g}-${X}-${r}`), XFILES);
    const promiseCalls: string[] = [];
    for (const name of ['rename', 'open', 'writeFile', 'rm', 'mkdir', 'readdir'] as const) {
      const real = (fs.promises as any)[name].bind(fs.promises);
      vi.spyOn(fs.promises, name as any).mockImplementation((async (...args: any[]) => { promiseCalls.push(name); return real(...args); }) as any);
    }
    h.syncCalls.length = 0;
    recoverGraveyardRestores();
    expect(promiseCalls).toEqual([]);
    expect(h.syncCalls[0]).toContain(`.restore-${g}-${X}-${r}`);
    expect(h.syncCalls).toContain('fsyncSync');
    expect(h.syncCalls.filter(c => c.startsWith('renameSync')).length).toBeGreaterThanOrEqual(2);
    expect(tree(dataPath(g))).toEqual(XFILES);
    expect(note(g, r)).toMatchObject({ guildId: g, reason: `replaced-by-restore-${X}` });

    const g2 = freshGuild();
    writeTree(entryDir(g2, X), XFILES);
    writeTree(entryDir(g2, r), PREV);
    writeTree(dataPath('_graveyard', `.restore-${g2}-${X}-${r}`), XFILES);
    h.renameSync = (real, a, b) => {
      if (base(b) === '.graveyard.json') throw errno('EPERM');
      return real(a, b);
    };
    error.mockClear();
    recoverGraveyardRestores();
    expect(tree(dataPath(g2))).toEqual(XFILES);
    expect(lines(error).filter(l => l.includes(`${g2}-${r}`) && l.includes('EPERM'))).toHaveLength(1);
    expect(await listed(g2)).toContainEqual({ guildId: g2, retiredAt: r, reason: '' });
  });

  it('a reserved number is never reused', async () => {
    const g = freshGuild();
    const r = Date.now() + 60_000;
    bury(g, X);
    writeTree(dataPath(g), PREV);
    writeTree(dataPath('_graveyard', `.restore-${g}-${X}-${r}`), XFILES);
    expect(nextGraveyardName(g)).toBe(r + 1);
    expect(await graveyardGuildDir(g, 'test')).toBe(true);
    expect((await listed(g))[0].retiredAt).toBe(r + 1);
    recoverGraveyardRestores();
    expect(fs.existsSync(dataPath(g))).toBe(false);
    expect(hidden(g).filter(n => n.startsWith('.restore-'))).toEqual([]);

    const g2 = freshGuild();
    bury(g2, X);
    const n = Date.now() + 60_000;
    writeTree(dataPath('_graveyard', `.restore-${g2}-${X}-${n}`), XFILES);
    expect(await restoreGuildFromGraveyard(g2, X)).toMatchObject({ ok: true });
    expect(tree(dataPath(g2))).toEqual(XFILES);
  });

  it('the sweep drops leftovers of a guild not under restore and leaves those of one under restore', async () => {
    const g = freshGuild();
    bury(g, Date.now());
    writeTree(dataPath('_graveyard', `.copy-${g}-${X}-5`), XFILES);
    writeTree(dataPath('_graveyard', `.restore-${g}-${X}-6`), XFILES);
    writeTree(dataPath('_graveyard', `.sweep-restore-${g}-${X}-4`), XFILES);
    await sweepFiles(id => id === g);
    expect(hidden(g).sort()).toEqual([`.copy-${g}-${X}-5`, `.restore-${g}-${X}-6`]);
    await sweepFiles();
    expect(hidden(g)).toEqual([]);
    expect(await listed(g)).toHaveLength(1);
  });

  it('a note that cannot be read keeps its entry', async () => {
    const g = freshGuild();
    const old = Date.now() - 30 * DAY;
    bury(g, old);
    fs.writeFileSync(path.join(entryDir(g, old), '.graveyard.json'), JSON.stringify({ guildId: g, reason: 'r', ts: old, usedAt: Date.now() }));
    h.readFileSync = (real, ...args) => {
      if (same(args[0], path.join(entryDir(g, old), '.graveyard.json'))) throw errno('EMFILE');
      return real(...args);
    };
    await sweepFiles();
    expect(fs.existsSync(entryDir(g, old))).toBe(true);
    expect(lines(error).concat(lines(warn))).toContain(`[DataManager] Graveyard entry ${g}-${old} kept: its note could not be read (EMFILE)`);
    h.readFileSync = null;
    await sweepFiles();
    expect(fs.existsSync(entryDir(g, old))).toBe(true);
    const keptUntil = note(g, old).usedAt + 14 * DAY;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockReturnValue(keptUntil - 60_000);
    await sweepFiles();
    expect(fs.existsSync(entryDir(g, old))).toBe(true);
    vi.mocked(Date.now).mockReturnValue(keptUntil + 60_000);
    await sweepFiles();
    expect(fs.existsSync(entryDir(g, old))).toBe(false);
    vi.mocked(Date.now).mockImplementation(realNow);

    const g2 = freshGuild();
    bury(g2, old);
    fs.writeFileSync(path.join(entryDir(g2, old), '.graveyard.json'), '{"torn');
    await sweepFiles();
    expect(fs.existsSync(entryDir(g2, old))).toBe(true);
    expect(lines(error).concat(lines(warn))).toContain(`[DataManager] Graveyard entry ${g2}-${old} kept: its note could not be read (parse)`);

    const g3 = freshGuild();
    writeTree(entryDir(g3, old), XFILES);
    const g4 = freshGuild();
    bury(g4, old);
    await sweepFiles();
    expect(fs.existsSync(entryDir(g3, old))).toBe(false);
    expect(fs.existsSync(entryDir(g4, old))).toBe(false);
  });

  it('the sweep decides and renames with no await, and skips a guild under restore', async () => {
    const g = freshGuild();
    const old = Date.now() - 30 * DAY;
    bury(g, old);
    const held = deferred();
    const reached = deferred();
    const cp = fs.promises.cp.bind(fs.promises);
    vi.spyOn(fs.promises, 'cp').mockImplementation((async (...args: any[]) => {
      reached.resolve();
      await held.promise;
      return (cp as any)(...args);
    }) as any);
    const running = restoreGuildFromGraveyard(g, old);
    await reached.promise;
    await sweepAll();
    expect(fs.existsSync(entryDir(g, old))).toBe(true);
    held.resolve();
    expect(await running).toMatchObject({ ok: true });
    await sweepFiles();
    expect(fs.existsSync(entryDir(g, old))).toBe(true);

    const g2 = freshGuild();
    bury(g2, old);
    const calls: string[] = [];
    for (const name of ['readdir', 'readFile', 'rename', 'rm', 'open', 'stat', 'lstat', 'access', 'writeFile', 'mkdir', 'cp'] as const) {
      const real = (fs.promises as any)[name].bind(fs.promises);
      vi.spyOn(fs.promises, name as any).mockImplementation((async (...args: any[]) => { calls.push(`${name} ${base(args[0])}`); return real(...args); }) as any);
    }
    h.renameSync = (real, a, b) => {
      calls.push(`renameSync ${base(a)}`);
      return real(a, b);
    };
    await sweepAll();
    h.renameSync = null;
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const listing = calls.lastIndexOf('readdir _graveyard');
    const renamed = calls.indexOf(`renameSync ${g2}-${old}`);
    expect(listing).toBeGreaterThanOrEqual(0);
    expect(renamed).toBeGreaterThan(listing);
    expect(calls.slice(listing + 1, renamed).filter(c => !c.startsWith('renameSync'))).toEqual([]);
    expect(await restoreGuildFromGraveyard(g2, old)).toEqual({ ok: false, code: 'invalid', error: NO_ENTRY });
    expect(fs.existsSync(entryDir(g2, old))).toBe(false);
  });

  it('every note is written whole into an existing folder', async () => {
    const g = freshGuild();
    await expect(writeGraveyardNote(entryDir(g, X), { guildId: g, reason: 'r', ts: X })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fs.existsSync(entryDir(g, X))).toBe(false);
    writeTree(dataPath(g), PREV);
    expect(await graveyardGuildDir(g, 'test')).toBe(true);
    const e = (await listed(g))[0];
    expect(note(g, e.retiredAt)).toMatchObject({ guildId: g, reason: 'test' });
    expect(fs.readdirSync(entryDir(g, e.retiredAt)).filter(n => n.endsWith('.tmp'))).toEqual([]);
  });
  it('a drop is one rename: a half-removed drop is never finished, and a drop whose rename failed is', async () => {
    const half = async (dropFails: boolean) => {
      const g = freshGuild();
      writeTree(dataPath(g), PREV);
      bury(g, X);
      let r = 0;
      onRename(async (src, dest, real) => {
        if (isK5(g)(src, dest)) throw errno('EPERM');
        if (dropFails && isDrop(src, dest)) throw errno('EPERM');
        if (isK4(g)(src)) r = Number(base(dest).slice(g.length + 1));
        return real();
      });
      h.renameSync = (real, a, b) => {
        if (same(b, dataPath(g)) && base(a).startsWith(`${g}-`)) throw errno('EPERM');
        return real(a, b);
      };
      let rmWorks = false;
      const rm = fs.promises.rm.bind(fs.promises);
      vi.spyOn(fs.promises, 'rm').mockImplementation((async (p: any, ...rest: any[]) => {
        if (!rmWorks && base(p).startsWith(`.sweep-restore-${g}-`)) {
          fs.rmSync(path.join(String(p), 'm', 'a.json'));
          throw errno('EIO');
        }
        return (rm as any)(p, ...rest);
      }) as any);
      expect(await replace(g, X)).toEqual({ ok: false, code: 'io-error', error: halfText(g, X, r, 'EPERM', 'EPERM') });
      await tick(50);
      h.renameSync = null;
      return { g, r, enableRm: () => { rmWorks = true; } };
    };

    const a = await half(false);
    expect(hidden(a.g)).toEqual([`.sweep-restore-${a.g}-${X}-${a.r}`]);
    vi.mocked(console.log).mockClear();
    recoverGraveyardRestores();
    expect(fs.existsSync(dataPath(a.g))).toBe(false);
    expect(lines(vi.mocked(console.log)).filter(l => l.includes('Finished'))).toEqual([]);
    a.enableRm();
    await sweepFiles();
    expect(hidden(a.g)).toEqual([]);
    expect(tree(entryDir(a.g, a.r))).toEqual(PREV);
    expect(tree(entryDir(a.g, X))).toEqual(XFILES);
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const b = await half(true);
    expect(hidden(b.g)).toEqual([`.restore-${b.g}-${X}-${b.r}`]);
    expect(tree(dataPath('_graveyard', `.restore-${b.g}-${X}-${b.r}`))).toEqual(XFILES);
    recoverGraveyardRestores();
    expect(tree(dataPath(b.g))).toEqual(XFILES);
    expect(await listed(b.g)).toEqual([
      { guildId: b.g, retiredAt: b.r, reason: `replaced-by-restore-${X}` },
      { guildId: b.g, retiredAt: X, reason: 'webui-operator-delete' },
    ]);
    expect(tree(entryDir(b.g, b.r))).toEqual(PREV);
    expect(hidden(b.g)).toEqual([]);
  }, 20_000);
});

describe('a lost writer (C1, D1) and an answer after K4 (D2)', () => {
  it.each(['K1\'s read', 'K2', 'the third file of K3\'s filter'] as const)('a takeover read at %s refuses, nothing moved and no copy left', async point => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    const ten = Object.fromEntries(Array.from({ length: 10 }, (_v, i) => [`m/f${i}.json`, `{"i":${i}}`]));
    bury(g, X, ten);
    const take = () => {
      takeOver();
      checkWriterLock();
    };
    if (point === 'K2') {
      const readdir = fs.promises.readdir.bind(fs.promises);
      vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: any, ...rest: any[]) => {
        const out = await (readdir as any)(p, ...rest);
        if (same(p, dataPath('_graveyard'))) take();
        return out;
      }) as any);
    }
    if (point === 'the third file of K3\'s filter') {
      const lstat = fs.promises.lstat.bind(fs.promises);
      let n = 0;
      vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: any, ...rest: any[]) => {
        const st = await (lstat as any)(p, ...rest);
        if (String(p).includes(`${g}-${X}`) && st.isFile() && ++n === 3) take();
        return st;
      }) as any);
    }
    const running = point === 'K2' ? replace(g) : replace(g, X);
    if (point === 'K1\'s read') take();
    expect(await running).toEqual({ ok: false, code: 'invalid', error: WRITER_LOST });
    expect(tree(dataPath(g))).toEqual(PREV);
    expect(tree(entryDir(g, X))).toEqual(ten);
    if (point === 'the third file of K3\'s filter') expect(note(g, X).usedAt).toEqual(expect.any(Number));
    else expect(note(g, X).usedAt).toBeUndefined();
    await tick(20);
    expect(hidden(g).filter(n => n.startsWith('.copy-') || n.startsWith('.restore-'))).toEqual([]);
  });

  it('a takeover read by the 5 s check during the copy refuses', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    const lstat = fs.promises.lstat.bind(fs.promises);
    let n = 0;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: any, ...rest: any[]) => {
      const st = await (lstat as any)(p, ...rest);
      if (String(p).includes(`${g}-${X}`) && st.isFile() && ++n === 1) {
        takeOver();
        checkWriterLock();
      }
      return st;
    }) as any);
    expect(await replace(g, X)).toEqual({ ok: false, code: 'invalid', error: WRITER_LOST });
    expect(tree(dataPath(g))).toEqual(PREV);
    expect(hidden(g).filter(x => x.startsWith('.copy-') || x.startsWith('.restore-'))).toEqual([]);
  });

  it('a takeover after the rename to .restore- is read at the check before the renames', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    onRename(async (src, _dest, real) => {
      await real();
      if (isRestoreRename(src)) takeOver();
    });
    expect(await replace(g, X)).toEqual({ ok: false, code: 'invalid', error: WRITER_LOST });
    expect(tree(dataPath(g))).toEqual(PREV);
  });

  it('a takeover in K4\'s first try is read before the second', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    let first = true;
    onRename(async (src, _dest, real) => {
      if (isK4(g)(src) && first) {
        first = false;
        takeOver();
        throw errno('EPERM');
      }
      return real();
    });
    expect(await replace(g, X)).toEqual({ ok: false, code: 'invalid', error: WRITER_LOST });
    expect(tree(dataPath(g))).toEqual(PREV);
  });

  it('a plain restore with a takeover in K5\'s first try is refused, and the IPC answers held-elsewhere', async () => {
    const g = freshGuild();
    bury(g, X);
    let first = true;
    onRename(async (src, dest, real) => {
      if (isK5(g)(src, dest) && first) {
        first = false;
        takeOver();
        throw errno('EPERM');
      }
      return real();
    });
    const reply = await applyOperatorDataWrite({ op: 'restore-graveyard', guildId: g, contentJson: JSON.stringify({ retiredAt: X }) } as any);
    expect(reply).toEqual({ ok: false, code: 'held-elsewhere', error: deposedText({ role: 'bot', pid: OTHER } as any) });
    expect(fs.existsSync(dataPath(g))).toBe(false);
    expect(hidden(g).filter(x => x.startsWith('.restore-'))).toEqual([]);
  });

  it('a lock file deleted during the step is re-created and the replace goes on', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    onRename(async (src, _dest, real) => {
      await real();
      if (isRestoreRename(src)) fs.rmSync(writerLockPath());
    });
    expect(await replace(g, X)).toMatchObject({ ok: true });
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid).toBe(process.pid);
    expect(lines(error).filter(l => l.includes('was removed while this process held it; re-created it.'))).toHaveLength(1);
  });

  it('after K4 the step goes on, and R\'s note is not written', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    onRename(async (src, _dest, real) => {
      await real();
      if (isK4(g)(src)) takeOver();
    });
    const reply = await replace(g, X) as any;
    expect(reply).toMatchObject({ ok: true, retiredAt: X });
    const r = reply.replaced.retiredAt;
    expect(reply.replaced).toEqual({ retiredAt: r });
    expect(fs.existsSync(path.join(entryDir(g, r), '.graveyard.json'))).toBe(false);
    expect(lines(error).filter(l => l === k6Line(g, r))).toHaveLength(1);
    expect(tree(dataPath(g))).toEqual(XFILES);
  });

  it('the reviewer\'s order loses nothing', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    let k5 = 0;
    onRename(async (src, dest, real) => {
      if (isK4(g)(src)) {
        takeOver();
        recoverGraveyardRestores();
        return real();
      }
      if (isK5(g)(src, dest) || (base(src).startsWith('.restore-') && !base(dest).startsWith('.sweep-'))) {
        if (++k5 === 10) fs.mkdirSync(dataPath(g));
        return real();
      }
      return real();
    });
    error.mockClear();
    const reply = await replace(g, X);
    const r = (await listed(g))[0].retiredAt;
    expect(reply).toEqual({ ok: false, code: 'io-error', error: halfTakenText(g, X, r, 'ENOENT') });
    expect(fs.readdirSync(dataPath(g))).toEqual([]);
    expect(tree(entryDir(g, r))).toEqual(PREV);
    expect(tree(entryDir(g, X))).toEqual(XFILES);
    expect(note(g, X).reason).toBe('webui-operator-delete');
    expect(h.syncCalls.some(c => c.startsWith('renameSync') && c.includes(`${g}-${r} ->`))).toBe(false);
  });

  it('a takeover after K5\'s tries leaves the copy to the next start', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    let k5 = 0;
    onRename(async (src, dest, real) => {
      if (isK5(g)(src, dest)) {
        if (++k5 === 10) takeOver();
        throw errno('EPERM');
      }
      return real();
    });
    error.mockClear();
    const reply = await replace(g, X);
    const r = (await listed(g))[0].retiredAt;
    expect(reply).toEqual({ ok: false, code: 'io-error', error: halfTakenText(g, X, r, 'EPERM') });
    expect(tree(dataPath('_graveyard', `.restore-${g}-${X}-${r}`))).toEqual(XFILES);
    expect(await listed(g)).toContainEqual({ guildId: g, retiredAt: r, reason: '' });
    expect(lines(error).filter(l => l.startsWith(`[DataManager] Guild ${g}: another process took the data files after the server's data moved to graveyard entry ${g}-${r}`))).toHaveLength(1);
    vi.restoreAllMocks();
    recoverGraveyardRestores();
    expect(tree(dataPath(g))).toEqual(XFILES);
    expect(note(g, r).reason).toBe(`replaced-by-restore-${X}`);
  });

  it.skipIf(process.platform === 'win32')('a takeover inside the undo\'s run is reported', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    onRename(async (src, dest, real) => {
      if (isK5(g)(src, dest)) throw errno('EPERM');
      return real();
    });
    h.renameSync = (real, a, b) => {
      if (same(b, dataPath(g)) && base(a).startsWith(`${g}-`)) {
        takeOver();
        fs.mkdirSync(dataPath(g));
      }
      return real(a, b);
    };
    error.mockClear();
    const reply = await replace(g, X);
    expect(reply).toEqual({ ok: false, code: 'io-error', error: undoTakenText(X, 'EPERM') });
    expect(tree(dataPath(g))).toEqual(PREV);
    expect(hidden(g).filter(x => x.startsWith('.restore-'))).toHaveLength(1);
    expect(lines(error).filter(l => l.includes('while another process took the data files; a save of that process may have replaced one of its files'))).toHaveLength(1);
  });

  it('an answer after K4 passes a deposition whole', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    onRename(async (src, dest, real) => {
      if (isK5(g)(src, dest)) throw errno('EPERM');
      if (isDrop(src, dest)) {
        await real();
        takeOver();
        checkWriterLock();
        return;
      }
      return real();
    });
    const reply = await applyOperatorDataWrite({ op: 'restore-graveyard', guildId: g, contentJson: JSON.stringify({ retiredAt: X, replace: true }) } as any);
    expect(reply).toEqual({ ok: false, code: 'io-error', error: undoText(X, 'EPERM') });
  });

  it('a half text after a deposition passes whole', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    onRename(async (src, dest, real) => {
      if (isK5(g)(src, dest)) throw errno('EPERM');
      return real();
    });
    let undo = 0;
    h.renameSync = (real, a, b) => {
      if (same(b, dataPath(g))) {
        if (++undo === 10) {
          takeOver();
          checkWriterLock();
        }
        throw errno('EPERM');
      }
      return real(a, b);
    };
    const reply = await applyOperatorDataWrite({ op: 'restore-graveyard', guildId: g, contentJson: JSON.stringify({ retiredAt: X, replace: true }) } as any) as any;
    expect(reply.code).toBe('io-error');
    expect(reply.error).toMatch(/^the server's data was moved to graveyard entry \d+, but the copy of entry 1000 could not be put in place \(EPERM\) and the data could not be moved back \(EPERM\)/);
  });
});

describe.skipIf(process.platform === 'win32')('a failed directory sync (C2)', () => {
  /** The nth sync of the graveyard folder (1-based) fails with EIO; every other sync passes. */
  function failGraveyardSync(nth: number): void {
    const open = fs.promises.open.bind(fs.promises);
    let n = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      const fh = await (open as any)(p, ...rest);
      if (same(p, dataPath('_graveyard'))) {
        const sync = fh.sync.bind(fh);
        fh.sync = async () => {
          if (++n === nth) throw errno('EIO');
          return sync();
        };
      }
      return fh;
    }) as any);
  }

  it('a failed sync at K3 refuses; one at K4 answers ok with moveUnconfirmed', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    failGraveyardSync(1);
    expect(await replace(g, X)).toEqual({ ok: false, code: 'io-error', error: `the disk did not confirm the copy of entry ${X} (EIO); nothing was restored; check the disk, then try again` });
    expect(tree(dataPath(g))).toEqual(PREV);
    vi.restoreAllMocks();

    const g2 = freshGuild();
    writeTree(dataPath(g2), PREV);
    bury(g2, X);
    failGraveyardSync(2);
    expect(await replace(g2, X)).toMatchObject({ ok: true, moveUnconfirmed: 'EIO' });
    expect(tree(dataPath(g2))).toEqual(XFILES);
  });

  it('an undo whose sync failed adds the unconfirmed clause', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    let r = 0;
    onRename(async (src, dest, real) => {
      if (isK5(g)(src, dest)) throw errno('EPERM');
      if (isK4(g)(src)) r = Number(base(dest).slice(g.length + 1));
      return real();
    });
    const open = fs.promises.open.bind(fs.promises);
    let n = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      const fh = await (open as any)(p, ...rest);
      if (same(p, dataPath('_graveyard'))) {
        const sync = fh.sync.bind(fh);
        fh.sync = async () => {
          if (++n === 3) throw errno('EIO');
          return sync();
        };
      }
      return fh;
    }) as any);
    const reply = await replace(g, X) as any;
    expect(r).toBeGreaterThan(X);
    expect(reply).toEqual({ ok: false, code: 'io-error', error: `${undoText(X, 'EPERM')} The disk did not confirm the move back (EIO), so after a power cut the server's data can be in graveyard entry ${r} instead; it stays listed there, and smdb graveyard restore ${g} ${r} --replace puts it back.` });
  });
});

describe('the exit drain (decision 11)', () => {
  /** A fresh module graph: the exit drain cannot be undone, so each row runs on its own data layer. */
  async function freshLayer() {
    vi.resetModules();
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    return dm;
  }

  it('the exit drain waits for the section, and every section', async () => {
    const dm = await freshLayer();
    const a = freshGuild();
    const b = freshGuild();
    for (const g of [a, b]) {
      writeTree(dataPath(g), PREV);
      bury(g, X);
    }
    const heldA = deferred();
    const reachedA = deferred();
    const order: string[] = [];
    onRename(async (src, dest, real) => {
      if (isK5(a)(src, dest)) {
        reachedA.resolve();
        await heldA.promise;
      }
      return real();
    });
    const replacingA = dm.restoreGuildFromGraveyard(a, X, monoIn(40_000), true).then(r => { order.push('a answered'); return r; });
    await reachedA.promise;
    expect(await dm.restoreGuildFromGraveyard(b, X, monoIn(40_000), true)).toMatchObject({ ok: true });
    const draining = dm.drainForExit(5000).then(() => { order.push('drained'); });
    await tick(50);
    expect(order).toEqual([]);
    heldA.resolve();
    expect(await replacingA).toMatchObject({ ok: true });
    await draining;
    expect(order).toContain('drained');
    expect(tree(dataPath(a))).toEqual(XFILES);
    expect(note(a, (await listed(a))[0].retiredAt).reason).toBe(`replaced-by-restore-${X}`);
  });

  it('a drain begun before the check before the renames refuses, and nothing moves', async () => {
    const dm = await freshLayer();
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    bury(g, X);
    const held = deferred();
    const reached = deferred();
    onRename(async (src, _dest, real) => {
      if (isRestoreRename(src)) {
        reached.resolve();
        await held.promise;
      }
      return real();
    });
    const replacing = dm.restoreGuildFromGraveyard(g, X, monoIn(40_000), true);
    const settled = replacing.then(() => null, (e: Error) => e);
    await reached.promise;
    const draining = dm.drainForExit(5000);
    await vi.waitFor(() => expect(dm.isClosedForExit()).toBe(true));
    held.resolve();
    expect(String(await settled)).toContain('This process is stopping; nothing was restored');
    await draining;
    expect(tree(dataPath(g))).toEqual(PREV);
    expect(hidden(g).filter(n => n.startsWith('.restore-') || n.startsWith('.copy-'))).toEqual([]);
  });
});

describe('the K cells of the state x exit table', () => {
  type Cell = [string, 'replace' | 'plain', (g: string) => void, (g: string) => unknown, 'prev' | 'x' | 'none'];
  const failRename = (match: (g: string) => (src: string, dest: string) => boolean, code = 'EPERM') => (g: string) => onRename(async (src, dest, real) => {
    if (match(g)(src, dest)) throw errno(code);
    return real();
  });
  const cells: Cell[] = [
    ['K0 the deadline passed: out-of-time', 'replace', () => undefined, () => ({ ok: false, code: 'backend-unavailable', error: OUT_OF_TIME }), 'prev'],
    ['K2 no entry', 'replace', g => fs.rmSync(entryDir(g, X), { recursive: true }), () => ({ ok: false, code: 'invalid', error: NO_ENTRY }), 'prev'],
    ['K2 a plain restore with a live folder: live data', 'plain', () => undefined, g => ({ ok: false, code: 'invalid', refusal: 'live-data', retiredAt: X, error: `server ${g} has data saved since entry ${X} was deleted; nothing was restored. To put entry ${X} in place and move the current data to the graveyard as a new entry, run: smdb graveyard restore ${g} ${X} --replace` }), 'prev'],
    ['K2 the note read fails: the stamp text', 'replace', g => {
      const readFile = fs.promises.readFile.bind(fs.promises);
      vi.spyOn(fs.promises, 'readFile').mockImplementation((async (p: any, ...rest: any[]) => {
        if (same(p, path.join(entryDir(g, X), '.graveyard.json'))) throw errno('EIO');
        return (readFile as any)(p, ...rest);
      }) as any);
    }, () => ({ ok: false, code: 'io-error', error: stampText(X, 'EIO') }), 'prev'],
    ['K3 the copy fails: the copy text', 'replace', () => { vi.spyOn(fs.promises, 'cp').mockRejectedValueOnce(errno('EACCES')); }, () => ({ ok: false, code: 'io-error', error: `entry ${X} could not be copied (EACCES); nothing was restored; try again in a moment` }), 'prev'],
    ['K4 the live folder cannot move: the move text', 'replace', failRename(isK4), () => ({ ok: false, code: 'io-error', error: "the server's current data could not be moved to the graveyard (EPERM); nothing was restored; try again in a moment" }), 'prev'],
    ['K5 a plain restore whose copy cannot be put in place', 'plain', failRename(isK5), () => ({ ok: false, code: 'io-error', error: `the copy of entry ${X} could not be put in place (EPERM); nothing was restored; try again in a moment` }), 'none'],
    ['K5 a replace whose copy cannot be put in place: undone', 'replace', failRename(isK5), () => ({ ok: false, code: 'io-error', error: undoText(X, 'EPERM') }), 'prev'],
    ['K6 continue: ok', 'replace', () => undefined, () => ({ ok: true, retiredAt: X, reason: 'webui-operator-delete', keptUntil: expect.any(Number), replaced: { retiredAt: expect.any(Number), reason: `replaced-by-restore-${X}` } }), 'x'],
  ];

  it.each(cells)('%s', async (name, kind, prepare, answer, live) => {
    const g = freshGuild();
    if (kind === 'replace' || name.includes('live folder')) writeTree(dataPath(g), PREV);
    bury(g, X);
    prepare(g);
    const deadline = name.startsWith('K0') ? process.hrtime.bigint() - 1n : monoIn(40_000);
    expect(await restoreGuildFromGraveyard(g, X, deadline, kind === 'replace')).toEqual(answer(g));
    if (live === 'prev') expect(tree(dataPath(g))).toEqual(PREV);
    else if (live === 'x') expect(tree(dataPath(g))).toEqual(XFILES);
    else expect(fs.existsSync(dataPath(g))).toBe(false);
    if (!name.startsWith('K2 no entry')) expect(tree(entryDir(g, X))).toEqual(XFILES);
    await tick(20);
    expect(hidden(g).filter(n => n.startsWith('.copy-') || n.startsWith('.restore-'))).toEqual([]);
  });
});

describe('the bundle import', () => {
  it('a bundle import names its entry above every entry and reserved number, and its note is whole', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    const file = dataPath(`nb14-${g}.dbex`);
    await writeBundle(g, file);
    const now = Date.now();
    bury(g, now + 60_000);
    writeTree(dataPath('_graveyard', `.restore-${g}-${X}-${now + 60_001}`), XFILES);
    await importBundle(file);
    const entries = (await listed(g)).map(e => e.retiredAt);
    expect(entries[0]).toBeGreaterThanOrEqual(now + 60_002);
    expect(entries[0]).toBeLessThan(now + 61_000);
    expect(note(g, entries[0])).toMatchObject({ guildId: g, reason: 'replaced by bundle import' });
    expect(fs.readdirSync(entryDir(g, entries[0])).filter(n => n.endsWith('.tmp'))).toEqual([]);
    expect(tree(entryDir(g, entries[0]))).toEqual(PREV);
    fs.rmSync(file, { force: true });
  });
});

describe('the copy and the exit', () => {
  it('the exit drain set at the third file of the copy stops it at the next file; nothing moved', async () => {
    vi.resetModules();
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const g = freshGuild();
    writeTree(dataPath(g), PREV);
    const ten = Object.fromEntries(Array.from({ length: 10 }, (_v, i) => [`m/f${i}.json`, `{"i":${i}}`]));
    bury(g, X, ten);
    const held = deferred();
    const reached = deferred();
    const lstat = fs.promises.lstat.bind(fs.promises);
    let files = 0;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: any, ...rest: any[]) => {
      const st = await (lstat as any)(p, ...rest);
      if (String(p).includes(`${g}-${X}`) && st.isFile() && ++files === 3) {
        reached.resolve();
        await held.promise;
      }
      return st;
    }) as any);
    const replacing = dm.restoreGuildFromGraveyard(g, X, monoIn(40_000), true).then(() => null, (e: Error) => e);
    await reached.promise;
    const draining = dm.drainForExit(5000);
    await vi.waitFor(() => expect(dm.isClosedForExit()).toBe(true));
    held.resolve();
    expect(String(await replacing)).toContain('This process is stopping; nothing was restored');
    await draining;
    expect(files).toBe(3);
    expect(tree(dataPath(g))).toEqual(PREV);
    expect(tree(entryDir(g, X))).toEqual(ten);
    expect(hidden(g).filter(n => n.startsWith('.copy-') || n.startsWith('.restore-'))).toEqual([]);
  });
});
