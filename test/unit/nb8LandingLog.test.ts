import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Answer = { failed: false } | { failed: true; kind: 'sync'; dir: string; errno: string; error: unknown };

const h = vi.hoisted(() => ({ fail: new Set<string>() }));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  const nodePath = await import('path');
  return {
    ...real,
    syncFolderChain: async (dir: string): Promise<Answer> => {
      const at = nodePath.resolve(dir);
      if (h.fail.has(at)) return { failed: true, kind: 'sync', dir: at, errno: 'EIO', error: Object.assign(new Error('EIO: stubbed'), { code: 'EIO' }) };
      return real.syncFolderChain(dir);
    },
  };
});

import {
  beginDataOp,
  cancelQueued,
  dataOpsInFlight,
  dirEpoch,
  enqueueAppend,
  enqueueDelete,
  enqueueWrite,
  flushAll,
  forgetDurableFiles,
  getPending,
  graveyardGuildDir,
  landClock,
  landedAt,
  noteDataOp,
  pathOnTheWire,
  recoverGraveyardRestores,
  restoreGuildDirFromGraveyard,
  setGuildViewCache,
  sweepGraveyard,
  watchLandings,
  type FileRestoreHooks,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { storePersistentPanel } from '../../src/bot/internalSetup/utils/panel/persistentPanelStorage';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { stubAppendHandles, type AppendStub } from '../helpers/fileHandleStub';

// NB8 test 6 (decisions 17, 21 and 45, C2 to C4, C8): the landing log, the counted directory operations and the writer
// lock's reads.

const DAY_MS = 24 * 60 * 60 * 1000;
const X = 1000;
let n = 0;
let guilds = 868_100_000_000_000_000n;
const freshGuild = () => String(++guilds);
const graveyard = () => dataPath('_graveyard');
const entryDir = (g: string, ms: number) => path.join(graveyard(), `${g}-${ms}`);
const same = (a: unknown, b: string) => path.resolve(String(a)) === path.resolve(b);
const errno = (code: string) => Object.assign(new Error(`${code}: stubbed`), { code });

let dir = '';
let stub: AppendStub;
let drop: (() => void) | null = null;
const fresh = (name: string) => path.join(dir, `${++n}-${name}`);

function writeTree(at: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(at, rel)), { recursive: true });
    fs.writeFileSync(path.join(at, rel), body);
  }
}
function bury(g: string, ms: number): void {
  writeTree(entryDir(g, ms), { 'm/a.json': '{"x":1}' });
  fs.writeFileSync(path.join(entryDir(g, ms), '.graveyard.json'), JSON.stringify({ guildId: g, reason: 'webui-operator-delete', ts: ms }));
}
const hooks = (over: Partial<FileRestoreHooks> = {}): FileRestoreHooks => ({
  stop: () => null, writerLost: () => false, writerTaken: () => false, replace: false, enterSection: () => () => undefined, progress: { renamed: false, moved: null }, ...over,
});

async function until(what: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!what()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

/** Holds the next call of fs.promises[name] on target until released; the hold resolves once the call waits. */
function holdNext(name: 'mkdir' | 'unlink', target: string): { reached: Promise<void>; release: () => void } {
  const real = (fs.promises[name] as (...a: unknown[]) => Promise<unknown>).bind(fs.promises);
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let used = false;
  vi.spyOn(fs.promises, name).mockImplementation((async (p: unknown, ...rest: unknown[]) => {
    if (!used && same(p, target)) {
      used = true;
      reached();
      await released;
    }
    return real(p, ...rest);
  }) as never);
  return { reached: reachedP, release };
}

beforeEach(() => {
  dir = dataPath('nb8land', String(++n));
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(graveyard(), { recursive: true });
  h.fail.clear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  stub = stubAppendHandles();
  forgetDurableFiles();
  drop = watchLandings();
});

afterEach(async () => {
  h.fail.clear();
  stub.restore();
  vi.restoreAllMocks();
  setBackendKind(null);
  setGuildViewCache(false);
  await flushAll();
  drop?.();
  drop = null;
});

type TryCase = [string, (p: string) => { reached: Promise<void>; release: () => void }, (p: string) => void, string];

describe('the landing log', () => {
  const cases: TryCase[] = [
    ['a replace', p => holdNext('mkdir', path.dirname(p)), p => enqueueWrite(p, '{"a":1}'), 'a.json'],
    ['a delete', p => { fs.writeFileSync(p, '{"d":1}'); return holdNext('unlink', p); }, p => enqueueDelete(p), 'd.json'],
    ['an append that landed', p => stub.holdOpen(p), p => enqueueAppend(p, '{"x":1}\n'), 'a.jsonl'],
    ['an append that came back short', p => { stub.shortWrite(p, () => 3); return stub.holdOpen(p); }, p => enqueueAppend(p, '{"x":1}\n'), 'b.jsonl'],
    ['an append whose fsync failed', p => { stub.failSync(p, 'EIO'); return stub.holdOpen(p); }, p => enqueueAppend(p, '{"x":1}\n'), 'c.jsonl'],
    ['a replace whose rename failed', p => {
      const rename = fs.promises.rename.bind(fs.promises);
      vi.spyOn(fs.promises, 'rename').mockImplementation((async (a: unknown, b: unknown) => {
        if (same(b, p)) throw errno('EACCES');
        return rename(a as string, b as string);
      }) as never);
      return holdNext('mkdir', path.dirname(p));
    }, p => enqueueWrite(p, '{"r":1}'), 'r.json'],
  ];

  it.each(cases)('%s keeps its path on the wire from the try\'s start and bumps it as it leaves', async (_name, hold, start, file) => {
    const p = fresh(file);
    const held = hold(p);
    const c0 = landClock();
    start(p);
    await held.reached;
    const during = { onWire: pathOnTheWire(p), at: landedAt(p) };
    held.release();
    await until(() => !pathOnTheWire(p), 'the try\'s end');
    const after = { onWire: pathOnTheWire(p), at: landedAt(p) };
    vi.restoreAllMocks();
    expect(during.onWire).toBe(true);
    expect(during.at === undefined || during.at <= c0).toBe(true);
    expect(after.onWire).toBe(false);
    expect(after.at).toBeGreaterThan(c0);
  });

  it('a whole .jsonl write whose folder chain sync fails bumps its path', async () => {
    const p = fresh('w.jsonl');
    h.fail.add(path.resolve(dir));
    const c0 = landClock();
    enqueueWrite(p, '{"w":1}\n');
    await flushAll();
    const at = landedAt(p);
    expect(fs.readFileSync(p, 'utf8')).toBe('{"w":1}\n');
    expect(at).toBeGreaterThan(c0);
  });

  it('a flush of a frozen path starts no try and bumps nothing', async () => {
    const p = fresh('f.json');
    const held = holdNext('mkdir', path.dirname(p));
    enqueueWrite(p, '{"f":1}');
    await held.reached;
    let wake!: () => void;
    const cancelled = cancelQueued([p], () => new Promise<void>(resolve => { wake = resolve; }), { freeze: true });
    enqueueWrite(p, '{"f":2}');
    const c0 = landClock();
    held.release();
    await until(() => !pathOnTheWire(p), 'the first try\'s end');
    const afterTry = landClock();
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    const whileFrozen = { clock: landClock(), pending: getPending(p) !== undefined, onWire: pathOnTheWire(p) };
    wake();
    await cancelled;
    expect(afterTry).toBe(c0 + 1);
    expect(whileFrozen).toEqual({ clock: c0 + 1, pending: true, onWire: false });
    expect(landedAt(p)).toBe(c0 + 1);
  });

  it('with no watch open the clock still moves and no path has a landing', async () => {
    drop?.();
    drop = null;
    const p = fresh('n.json');
    const c0 = landClock();
    enqueueWrite(p, '{"n":1}');
    await flushAll();
    const seen = { clock: landClock(), at: landedAt(p) };
    expect(seen.clock).toBeGreaterThan(c0);
    expect(seen.at).toBeUndefined();
  });

  it('the watch ends only when its last holder drops it, and a second drop does nothing', async () => {
    const second = watchLandings();
    drop?.();
    drop?.();
    const p = fresh('t.json');
    enqueueWrite(p, '{"t":1}');
    await flushAll();
    const kept = landedAt(p);
    second();
    const gone = landedAt(p);
    drop = null;
    expect(kept).toBeGreaterThan(0);
    expect(gone).toBeUndefined();
  });
});

describe('the counted directory operations', () => {
  it('beginDataOp counts until its end, which is idempotent and moves the epoch once; noteDataOp only moves it', () => {
    const e0 = dirEpoch();
    const f0 = dataOpsInFlight();
    const end = beginDataOp();
    const inside = { epoch: dirEpoch(), inFlight: dataOpsInFlight() };
    end();
    end();
    const ended = { epoch: dirEpoch(), inFlight: dataOpsInFlight() };
    noteDataOp();
    const noted = { epoch: dirEpoch(), inFlight: dataOpsInFlight() };
    expect(inside).toEqual({ epoch: e0 + 1, inFlight: f0 + 1 });
    expect(ended).toEqual({ epoch: e0 + 2, inFlight: f0 });
    expect(noted).toEqual({ epoch: e0 + 3, inFlight: f0 });
  });

  it('a graveyard move is one op from its mkdir through its rename, ended after it', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), { 'm/a.json': '{"g":1}' });
    const seen: Array<{ at: string; inFlight: number }> = [];
    const mkdir = fs.promises.mkdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (p: unknown, o: unknown) => {
      if (same(p, graveyard())) seen.push({ at: 'mkdir', inFlight: dataOpsInFlight() });
      return mkdir(p as string, o as fs.MakeDirectoryOptions);
    }) as never);
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (a: unknown, b: unknown) => {
      if (same(a, dataPath(g))) seen.push({ at: 'rename', inFlight: dataOpsInFlight() });
      return rename(a as string, b as string);
    }) as never);
    const e0 = dirEpoch();
    const f0 = dataOpsInFlight();
    const moved = await graveyardGuildDir(g, 'test');
    const after = { epoch: dirEpoch(), inFlight: dataOpsInFlight() };
    expect(moved).toBe(true);
    expect(seen).toEqual([{ at: 'mkdir', inFlight: f0 + 1 }, { at: 'rename', inFlight: f0 + 1 }]);
    expect(after).toEqual({ epoch: e0 + 2, inFlight: f0 });
  });

  it('a graveyard move whose renames all fail still ends its op', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), { 'm/a.json': '{"g":1}' });
    vi.spyOn(fs.promises, 'rename').mockImplementation((async () => { throw errno('EBUSY'); }) as never);
    const f0 = dataOpsInFlight();
    const e0 = dirEpoch();
    const moved = await graveyardGuildDir(g, 'test');
    const after = { epoch: dirEpoch(), inFlight: dataOpsInFlight() };
    expect(moved).toBe(false);
    expect(after).toEqual({ epoch: e0 + 2, inFlight: f0 });
  });

  it('a sweep\'s expiry rename moves the epoch; its rm of a .sweep- folder and its drop of a .restore- folder do not', async () => {
    const leftover = path.join(graveyard(), `.sweep-${freshGuild()}-${Date.now()}`);
    writeTree(leftover, { 'm/a.json': '{}' });
    const g = freshGuild();
    writeTree(dataPath(g), { 'm/a.json': '{}' });
    const dropped = path.join(graveyard(), `.restore-${g}-1-2`);
    writeTree(dropped, { 'm/a.json': '{}' });
    const e0 = dirEpoch();
    await sweepGraveyard();
    const quiet = dirEpoch();
    const expired = `${freshGuild()}-${Date.now() - 30 * DAY_MS}`;
    writeTree(path.join(graveyard(), expired), { 'm/a.json': '{}' });
    await sweepGraveyard();
    const swept = dirEpoch();
    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.existsSync(dropped)).toBe(false);
    expect(fs.existsSync(path.join(graveyard(), expired))).toBe(false);
    expect(quiet).toBe(e0);
    expect(swept).toBe(e0 + 1);
  });

  it('a plain graveyard restore is one op from the check before the renames through the put\'s sync; its copy is outside it', async () => {
    stub.restore();
    const g = freshGuild();
    bury(g, X);
    const restoreAt = (name: string) => name.startsWith(`.restore-${g}-`);
    const copyAt = (name: string) => name.startsWith(`.copy-${g}-`);
    const seen: Array<{ at: string; inFlight: number; epoch: number }> = [];
    const mark = (at: string) => seen.push({ at, inFlight: dataOpsInFlight(), epoch: dirEpoch() });
    const stop = () => {
      const names = fs.readdirSync(graveyard());
      if (fs.existsSync(dataPath(g))) mark('after put');
      else if (names.some(restoreAt)) mark('check or put');
      else if (names.some(copyAt)) mark('copy');
      return null;
    };
    const cp = fs.promises.cp.bind(fs.promises);
    vi.spyOn(fs.promises, 'cp').mockImplementation((async (...a: unknown[]) => {
      mark('copy');
      return (cp as (...b: unknown[]) => Promise<void>)(...a);
    }) as never);
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      if (same(p, dataPath()) && fs.existsSync(dataPath(g))) mark('put sync');
      return (open as (...b: unknown[]) => Promise<fs.promises.FileHandle>)(p, ...rest);
    }) as never);
    const e0 = dirEpoch();
    const f0 = dataOpsInFlight();
    const outcome = await restoreGuildDirFromGraveyard(g, X, hooks({ stop }));
    const after = { epoch: dirEpoch(), inFlight: dataOpsInFlight() };
    expect(outcome.ok).toBe(true);
    const copy = seen.filter(s => s.at === 'copy');
    const counted = seen.filter(s => s.at !== 'copy');
    expect(copy.length).toBeGreaterThan(0);
    expect(copy.every(s => s.inFlight === f0 && s.epoch === e0)).toBe(true);
    expect(counted.filter(s => s.at === 'check or put').length).toBeGreaterThanOrEqual(2);
    if (process.platform !== 'win32') expect(counted.some(s => s.at === 'put sync')).toBe(true);
    expect(counted.every(s => s.inFlight === f0 + 1)).toBe(true);
    expect(after).toEqual({ epoch: e0 + 2, inFlight: f0 });
  });

  it('a replace is one op over its rename section', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), { 'm/a.json': '{"prev":1}' });
    bury(g, X);
    const seen: Array<{ at: string; inFlight: number }> = [];
    const enterSection = () => {
      seen.push({ at: 'enter', inFlight: dataOpsInFlight() });
      return () => { seen.push({ at: 'end', inFlight: dataOpsInFlight() }); };
    };
    const e0 = dirEpoch();
    const f0 = dataOpsInFlight();
    const outcome = await restoreGuildDirFromGraveyard(g, X, hooks({ replace: true, enterSection }));
    const after = { epoch: dirEpoch(), inFlight: dataOpsInFlight() };
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual([{ at: 'enter', inFlight: f0 + 1 }, { at: 'end', inFlight: f0 + 1 }]);
    expect(after).toEqual({ epoch: e0 + 2, inFlight: f0 });
  });

  it('a refusal at the check before the renames drops the copy inside the op and ends it', async () => {
    const g = freshGuild();
    bury(g, X);
    const f0 = dataOpsInFlight();
    const e0 = dirEpoch();
    const outcome = await restoreGuildDirFromGraveyard(g, X, hooks({ writerTaken: () => true }));
    const after = { epoch: dirEpoch(), inFlight: dataOpsInFlight() };
    expect(outcome).toEqual({ ok: false, why: 'writer-lost' });
    expect(after).toEqual({ epoch: e0 + 2, inFlight: f0 });
  });

  it('the boot\'s recovery of restore folders moves the epoch at its end', () => {
    const g = freshGuild();
    writeTree(path.join(graveyard(), `.copy-${g}-1-2`), { 'm/a.json': '{}' });
    const e0 = dirEpoch();
    const f0 = dataOpsInFlight();
    recoverGraveyardRestores();
    const after = { epoch: dirEpoch(), inFlight: dataOpsInFlight() };
    expect(fs.existsSync(path.join(graveyard(), `.copy-${g}-1-2`))).toBe(false);
    expect(after).toEqual({ epoch: e0 + 1, inFlight: f0 });
  });

  it('a panel registry moved aside moves the epoch; one that parses does not', async () => {
    setBackendKind('file');
    const file = dataPath('global', '_panels', 'persistent-panels.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await flushAll();
    fs.writeFileSync(file, '{"a": ');
    const e0 = dirEpoch();
    expect((await storePersistentPanel('nb8', { messageId: 'm-1', channelId: 'c-1', userId: '13', createdAt: 0, lastUpdated: 0, state: 'a' } as never)).success).toBe(true);
    const moved = dirEpoch();
    await flushAll();
    expect((await storePersistentPanel('nb8b', { messageId: 'm-2', channelId: 'c-1', userId: '13', createdAt: 0, lastUpdated: 0, state: 'a' } as never)).success).toBe(true);
    const parsed = dirEpoch();
    expect(moved).toBe(e0 + 1);
    expect(parsed).toBe(moved);
  });

  it('a graveyard move and a flush both finish while a take watches the landings', async () => {
    const g = freshGuild();
    writeTree(dataPath(g), { 'm/a.json': '{"g":1}' });
    const p = fresh('k.json');
    const c0 = landClock();
    enqueueWrite(p, '{"k":1}');
    const [moved] = await Promise.all([graveyardGuildDir(g, 'test'), flushAll()]);
    const at = landedAt(p);
    expect(moved).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('{"k":1}');
    expect(at).toBeGreaterThan(c0);
  });
});

describe('the writer lock reads', () => {
  const seams = { pid: () => process.pid, alive: () => true, startOf: (p: number) => `start-${p}`, now: () => Date.now() };

  async function freshLock() {
    vi.resetModules();
    const lock = await import('../../src/bot/internalSetup/utils/writerLock');
    fs.rmSync(lock.writerLockPath(), { force: true });
    lock.configureWriterLock('webui', seams);
    return lock;
  }

  it('a re-create of the lock bumps recreateCount by one and keeps heldText', async () => {
    const lock = await freshLock();
    try {
      expect(lock.takeWriterLock().kind).toBe('taken');
      const text = lock.heldText();
      const before = lock.recreateCount();
      fs.unlinkSync(lock.writerLockPath());
      const checked = lock.checkWriterLock();
      const seen = { count: lock.recreateCount(), text: lock.heldText(), file: fs.readFileSync(lock.writerLockPath(), 'utf8') };
      expect(checked).toEqual({ kind: 'held' });
      expect(before).toBe(0);
      expect(seen).toEqual({ count: 1, text, file: text });
    } finally {
      while (lock.writerLockDepth() > 0) lock.releaseWriterLock();
    }
  });

  it('readLockText reads the lock file under DATA_DIR and throws as the read does', async () => {
    const lock = await freshLock();
    try {
      lock.takeWriterLock();
      const read = lock.readLockText();
      const held = lock.heldText();
      expect(lock.writerLockPath()).toBe(dataPath('.writer.lock'));
      expect(read).toBe(fs.readFileSync(dataPath('.writer.lock'), 'utf8'));
      expect(read).toBe(held);
      fs.unlinkSync(lock.writerLockPath());
      let code: unknown = null;
      try { lock.readLockText(); } catch (error) { code = (error as { code?: unknown }).code; }
      expect(code).toBe('ENOENT');
    } finally {
      while (lock.writerLockDepth() > 0) lock.releaseWriterLock();
    }
  });

  it('heldText is null with no lock held, before a take and after the release', async () => {
    const lock = await freshLock();
    const before = lock.heldText();
    lock.takeWriterLock();
    const during = lock.heldText();
    lock.releaseWriterLock();
    const after = lock.heldText();
    expect(before).toBeNull();
    expect(typeof during).toBe('string');
    expect(after).toBeNull();
  });
});
