import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import {
  dropPendingForGuild,
  getPending,
  graveyardGuildDir,
  placeGuildWrite,
  queuedFilePaths,
  restoreGuildDirFromGraveyard,
  setGuildViewCache,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { KeyTree, fold } from '../../src/bot/internalSetup/utils/storableData';
import { MetricsCollector } from '../../src/bot/internalSetup/utils/metrics/metricsCollector';
import { METRICS_NAMESPACE, TOTALS_FILENAME } from '../../src/bot/internalSetup/utils/metrics/constants';
import { setBackendKind } from '../helpers/backendKind';
import { DISKS, type Disk, type DiskName, caseSensitiveWhereAllowed, useDisk } from '../helpers/caseInsensitiveDisk';
import { FakeStore, tokenFor } from '../helpers/fakeStore';
import { ServerStore } from '../helpers/serverStore';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

// NB12 item 2 (wip-redesign/sheets/NB12.md), the file route's rows: the bot process (view cache on) and the web UI
// process (cache off), on the real disk and on the case-insensitive helper.

let guilds = 9_300_000_000;
let errors: string[];
// The 'case-sensitive' disk is the host's own. On Windows the data folder is made case-sensitive with fsutil; where
// that is refused, or on macOS, the rows that need two spellings apart are skipped, so the skip shows in the run.
const realFolds = caseSensitiveWhereAllowed(dataPath());
const foldsHere = (disk: DiskName) => disk === 'case-sensitive' && realFolds;

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dm.flushAll();
  setGuildViewCache(false);
});

interface Rig {
  guildId: string;
  o: dm.DataOptions;
  disk: Disk;
  p: (...rel: string[]) => string;
  /** Folders the code listed under the guild folder since the last reset, relative ('' for the guild folder). */
  listed: () => string[];
  /** The guild folder's paths with an op queued. */
  queued: () => string[];
}

function rig(disk: DiskName, cache: boolean, files: Record<string, string> = {}, dirs: string[] = []): Rig {
  setBackendKind('file');
  setGuildViewCache(cache);
  const guildId = String(++guilds);
  const d = useDisk(disk, dataPath());
  const p = (...rel: string[]) => dataPath(guildId, ...rel.flatMap(r => r.split('/')));
  for (const dir of dirs) fs.mkdirSync(p(dir), { recursive: true });
  for (const [key, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(p(key)), { recursive: true });
    fs.writeFileSync(p(key), text);
  }
  d.reset();
  const root = p();
  return {
    guildId,
    o: { guildId },
    disk: d,
    p,
    listed: () => (d.calls.get('readdirSync') ?? []).filter(x => x === root || x.startsWith(root + path.sep)).map(x => path.relative(root, x).split(path.sep).join('/')),
    queued: () => queuedFilePaths().filter(x => x.startsWith(root + path.sep)),
  };
}

const refusedFor = (answer: { outcome: string }, cause: string, names: string) => {
  expect(answer).toMatchObject({ outcome: 'refused', cause });
  expect((answer as { reason?: string }).reason).toContain(names);
};

const refusedExactly = (answer: { outcome: string }, cause: string, reason: string) => {
  expect(answer).toMatchObject({ outcome: 'refused', cause, reason });
};

/** Wraps fn on holder so a call whose first argument matches waits for release; other calls run as before. */
function hold(holder: any, fn: string, match: (p: string) => boolean) {
  const spy = vi.mocked(holder[fn]) as any;
  const prev = spy.getMockImplementation() ?? holder[fn].bind(holder);
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let reach!: () => void;
  const reached = new Promise<void>(resolve => { reach = resolve; });
  spy.mockImplementation(async (...args: unknown[]) => {
    if (match(String(args[0]))) {
      reach();
      await released;
    }
    return prev(...args);
  });
  return { release, reached };
}

/** Makes calls of fn whose first argument matches throw code, times times (Infinity until lift). */
function failing(holder: any, fn: string, code: string, match: (p: string) => boolean, times = Infinity) {
  const spy = vi.mocked(holder[fn]) as any;
  const prev = spy.getMockImplementation() ?? holder[fn].bind(holder);
  let left = times;
  let lifted = false;
  spy.mockImplementation((...args: unknown[]) => {
    if (!lifted && left > 0 && match(String(args[0]))) {
      left -= 1;
      const error = Object.assign(new Error(`${code} (stub)`), { code });
      if (fn.endsWith('Sync')) throw error;
      return Promise.reject(error);
    }
    return prev(...args);
  });
  return { lift: () => { lifted = true; }, left: () => left };
}

const tmpsIn = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.tmp')) : []);
const later = (ms: number) => {
  const now = performance.now();
  vi.spyOn(performance, 'now').mockReturnValue(now + ms);
};

const MODES: Array<{ disk: DiskName; cache: boolean }> = DISKS.flatMap(disk => [true, false].map(cache => ({ disk, cache })));
const process_ = (cache: boolean) => (cache ? 'bot' : 'web UI');

describe.each(MODES)('letter case, $disk disk, cache $cache', ({ disk, cache }) => {
  it("'m/a.json' saved, then 'm/A.json' and 'M/b.json' are refused", async () => {
    const r = rig(disk, cache);
    expect(dm.saveDataTracked('m/a.json', r.o, 1).outcome).toBe('saved');
    refusedFor(dm.saveDataTracked('m/A.json', r.o, 2), 'unstorable', 'm/a.json');
    refusedExactly(dm.saveDataTracked('M/b.json', r.o, 3), 'unstorable', 'it differs only in letter case from m');
    expect(r.queued().map(q => path.relative(r.p(), q))).toEqual([path.join('m', 'a.json')]);
    await dm.flushAll();
    expect(fs.readdirSync(r.p('m'))).toEqual(['a.json']);
    expect(fs.readFileSync(r.p('m/a.json'), 'utf8')).toBe('1');
  });

  it("'words/kir.json' saved, then 'words/k\u0131r.json' is refused and kir's document keeps its bytes", async () => {
    const r = rig(disk, cache);
    expect(dm.saveDataTracked('words/kir.json', r.o, { v: 'kir' }).outcome).toBe('saved');
    await dm.flushAll();
    refusedFor(dm.saveDataTracked('words/k\u0131r.json', r.o, { v: 'other' }), 'unstorable', 'words/kir.json');
    await dm.flushAll();
    expect(fs.readdirSync(r.p('words'))).toEqual(['kir.json']);
    expect(fs.readFileSync(r.p('words/kir.json'), 'utf8')).toBe(JSON.stringify({ v: 'kir' }, null, 2));
  });

  it("with a delete of 'm/A.json' queued, a save of 'm/a.json' answers io naming it, and is saved after flushAll", async () => {
    const r = rig(disk, cache, { 'm/A.json': '1' });
    expect(dm.loadData('m/A.json', r.o, null)).toBe(1);
    expect(dm.deleteDataTracked('m/A.json', r.o).outcome).toBe('deleted');
    refusedFor(dm.saveDataTracked('m/a.json', r.o, 2), 'io', 'm/A.json');
    expect(getPending(r.p('m/a.json'))?.op).not.toBe('write');
    await dm.flushAll();
    expect(dm.saveDataTracked('m/a.json', r.o, 2).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readdirSync(r.p('m'))).toEqual(['a.json']);
    expect(fs.readFileSync(r.p('m/a.json'), 'utf8')).toBe('2');
  });
});

describe.each(MODES)('empty folders and leftovers, $disk disk, cache $cache', ({ disk, cache }) => {
  it("'Tags/x.json' saved and deleted, then 'tags/y.json' is saved under the spelling 'tags'", async () => {
    const r = rig(disk, cache);
    expect(dm.saveDataTracked('Tags/x.json', r.o, 1).outcome).toBe('saved');
    await dm.flushAll();
    expect(dm.deleteDataTracked('Tags/x.json', r.o).outcome).toBe('deleted');
    await dm.flushAll();
    expect(fs.readdirSync(r.p())).toEqual([]);
    expect(dm.saveDataTracked('tags/y.json', r.o, 2).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readdirSync(r.p())).toEqual(['tags']);
    expect(fs.readFileSync(r.p('tags/y.json'), 'utf8')).toBe('2');
  });

  it("a folder 'm/a' and a folder 'Tags' holding only an empty folder, made before the first write, give way", async () => {
    const r = rig(disk, cache, {}, ['m/a', 'Tags/inner']);
    expect(dm.saveDataTracked('m/a', r.o, 1).outcome).toBe('saved');
    expect(dm.saveDataTracked('tags/y.json', r.o, 2).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.statSync(r.p('m/a')).isFile()).toBe(true);
    expect(fs.readFileSync(r.p('m/a'), 'utf8')).toBe('1');
    expect(fs.readdirSync(r.p()).sort()).toEqual(['m', 'tags']);
    expect(fs.readFileSync(r.p('tags/y.json'), 'utf8')).toBe('2');
  });

  it("the same with rmdirSync failing EPERM answers io 'holds no data but could not be removed', and saves once lifted", async () => {
    const r = rig(disk, cache, {}, ['m/a']);
    const stub = failing(fs, 'rmdirSync', 'EPERM', () => true);
    const answer = dm.saveDataTracked('m/a', r.o, 1);
    refusedFor(answer, 'io', 'the folder m/a holds no data but could not be removed');
    expect(r.queued()).toEqual([]);
    stub.lift();
    expect(dm.saveDataTracked('m/a', r.o, 1).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readFileSync(r.p('m/a'), 'utf8')).toBe('1');
  });
});

describe.each([true, false])('deletes of an alias on the case-insensitive helper, cache %s', cache => {
  it('each answers absent, queues nothing, and every file stays', async () => {
    const r = rig('case-insensitive', cache, { 'm/a.json': '1', 'tags/bob/info.json': '2', 'm/Users/1.json': '3' });
    for (const key of ['m/A.json', 'M/a.json', 'tags/Bob/info.json', 'm/users/1.json']) {
      expect(dm.deleteDataTracked(key, r.o).outcome).toBe('absent');
    }
    expect(r.queued()).toEqual([]);
    await dm.flushAll();
    expect(fs.readdirSync(r.p('m')).sort()).toEqual(['Users', 'a.json']);
    expect(fs.readFileSync(r.p('m/a.json'), 'utf8')).toBe('1');
    expect(fs.readdirSync(r.p('tags'))).toEqual(['bob']);
    expect(fs.readFileSync(r.p('tags/bob/info.json'), 'utf8')).toBe('2');
    expect(fs.readdirSync(r.p('m/Users'))).toEqual(['1.json']);
    expect(fs.readFileSync(r.p('m/Users/1.json'), 'utf8')).toBe('3');
  });
});

describe('the other process, bot process (cache on), case-insensitive helper', () => {
  it("a file 'm/Config.json' written beside the bot refuses 'm/config.json' and is deleted as stored", async () => {
    const r = rig('case-insensitive', true);
    expect(dm.saveDataTracked('m/x.json', r.o, 0).outcome).toBe('saved');
    await dm.flushAll();
    fs.writeFileSync(r.p('m/Config.json'), '{"web":1}');
    refusedFor(dm.saveDataTracked('m/config.json', r.o, { bot: 1 }), 'unstorable', 'm/Config.json');
    expect(fs.readFileSync(r.p('m/Config.json'), 'utf8')).toBe('{"web":1}');
    expect(dm.deleteDataTracked('m/Config.json', r.o).outcome).toBe('deleted');
    await dm.flushAll();
    expect(fs.readdirSync(r.p('m'))).toEqual(['x.json']);
  });

  it("a folder 'Tags' written beside the bot: a delete of 'tags/x.json' is absent, a save of 'tags/y.json' is refused naming Tags", async () => {
    const r = rig('case-insensitive', true);
    expect(dm.saveDataTracked('m/x.json', r.o, 0).outcome).toBe('saved');
    await dm.flushAll();
    fs.mkdirSync(r.p('Tags'));
    fs.writeFileSync(r.p('Tags/x.json'), '1');
    expect(dm.deleteDataTracked('tags/x.json', r.o).outcome).toBe('absent');
    await dm.flushAll();
    expect(fs.readFileSync(r.p('Tags/x.json'), 'utf8')).toBe('1');
    refusedFor(dm.saveDataTracked('tags/y.json', r.o, 2), 'unstorable', 'Tags');
    expect(fs.readdirSync(r.p('Tags'))).toEqual(['x.json']);
  });

  it("a stale entry: 'm/A.json' removed from disk by hand, then 'm/a.json' is saved, lands, and nothing names m/A.json", async () => {
    const r = rig('case-insensitive', true);
    expect(dm.saveDataTracked('m/A.json', r.o, 1).outcome).toBe('saved');
    await dm.flushAll();
    fs.unlinkSync(r.p('m/A.json'));
    const answer = dm.saveDataTracked('m/a.json', r.o, 2);
    expect(answer.outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readdirSync(r.p('m'))).toEqual(['a.json']);
    expect(fs.readFileSync(r.p('m/a.json'), 'utf8')).toBe('2');
    expect(errors.filter(e => e.includes('m/A.json'))).toEqual([]);
  });
});

describe('the retire and restore windows, bot process (cache on)', () => {
  it("a delete of 'notes/a.json' while the retire's marker write is held answers absent and queues nothing", async () => {
    const r = rig('case-sensitive', true, { 'notes/a.json': '1' });
    expect(dm.loadData('notes/a.json', r.o, null)).toBe(1);
    expect(dm.saveDataTracked('notes/b.json', r.o, 2).outcome).toBe('saved');
    await dm.flushAll();
    const marker = hold(fs.promises, 'writeFile', p => p.endsWith('.graveyard.json'));
    const retire = graveyardGuildDir(r.guildId, 'nb12 test');
    await marker.reached;
    expect(fs.existsSync(r.p())).toBe(false);
    expect(dm.deleteDataTracked('notes/a.json', r.o).outcome).toBe('absent');
    expect(r.queued()).toEqual([]);
    expect(dm.saveDataTracked('Notes/c.json', r.o, 3).outcome).toBe('saved');
    marker.release();
    expect(await retire).toBe(true);
    await dm.flushAll();
    expect(fs.readdirSync(r.p())).toEqual(['Notes']);
  });

  it("a delete of 'notes/b.json' while the retire's rename is held, after its queued write was dropped, answers absent", async () => {
    const r = rig('case-sensitive', true, { 'notes/a.json': '1' });
    expect(dm.loadData('notes/a.json', r.o, null)).toBe(1);
    expect(dm.saveDataTracked('notes/b.json', r.o, 2).outcome).toBe('saved');
    dropPendingForGuild(r.guildId);
    const rename = hold(fs.promises, 'rename', p => p === r.p());
    const retire = graveyardGuildDir(r.guildId, 'nb12 test');
    await rename.reached;
    expect(dm.deleteDataTracked('notes/b.json', r.o).outcome).toBe('absent');
    expect(r.queued()).toEqual([]);
    rename.release();
    expect(await retire).toBe(true);
  });

  it("a restore whose rename is held while a read lists the folder: then the restored keys are seen and a delete of '.graveyard.json' answers absent", async () => {
    const r = rig('case-sensitive', true, { 'notes/a.json': '1' });
    expect(dm.loadData('notes/a.json', r.o, null)).toBe(1);
    expect(await graveyardGuildDir(r.guildId, 'nb12 test')).toBe(true);
    const rename = hold(fs.promises, 'rename', p => path.basename(p).startsWith(`${r.guildId}-`));
    const restore = restoreGuildDirFromGraveyard(r.guildId, undefined, { stop: () => null, writerLost: () => false, progress: { renamed: false } });
    await rename.reached;
    expect(dm.loadData('notes/a.json', r.o, null)).toBe(null);
    rename.release();
    expect(await restore).toMatchObject({ ok: true, reason: 'nb12 test' });
    expect(dm.loadData('notes/a.json', r.o, null)).toBe(1);
    expect(dm.deleteDataTracked('.graveyard.json', r.o).outcome).toBe('absent');
    expect(dm.saveDataTracked('notes/c.json', r.o, 3).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readdirSync(r.p()).sort()).toEqual(['notes']);
    expect(fs.readdirSync(r.p('notes')).sort()).toEqual(['a.json', 'c.json']);
  });
});

describe.each(DISKS)('queued deletes and the refresh, bot process (cache on), %s disk', disk => {
  it("a delete of 'm/a/x.json' then a save of 'm/a' in one tick: deleted, then io naming it; after flushAll 'm/a' lands as a file", async () => {
    const r = rig(disk, true, { 'm/a/x.json': '1' });
    expect(dm.loadData('m/a/x.json', r.o, null)).toBe(1);
    expect(dm.deleteDataTracked('m/a/x.json', r.o).outcome).toBe('deleted');
    refusedFor(dm.saveDataTracked('m/a', r.o, 2), 'io', 'm/a/x.json');
    expect(getPending(r.p('m/a'))).toBeUndefined();
    await dm.flushAll();
    expect(fs.existsSync(r.p('m/a'))).toBe(false);
    expect(dm.saveDataTracked('m/a', r.o, 2).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readFileSync(r.p('m/a'), 'utf8')).toBe('2');
  });

  it("a delete of the file 'm/b' then a save of 'm/b/x.json' in one tick answers io naming m/b; after flushAll it lands", async () => {
    const r = rig(disk, true, { 'm/b': '1' });
    expect(dm.loadData('m/b', r.o, null)).toBe(1);
    expect(dm.deleteDataTracked('m/b', r.o).outcome).toBe('deleted');
    refusedFor(dm.saveDataTracked('m/b/x.json', r.o, 2), 'io', 'm/b');
    await dm.flushAll();
    expect(dm.saveDataTracked('m/b/x.json', r.o, 2).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readFileSync(r.p('m/b/x.json'), 'utf8')).toBe('2');
  });

  it('a delete of a sibling, or of the same path, is no obstacle', async () => {
    const r = rig(disk, true, { 'm/a.json': '1', 'm/b.json': '2' });
    expect(dm.loadData('m/a.json', r.o, null)).toBe(1);
    expect(dm.deleteDataTracked('m/a.json', r.o).outcome).toBe('deleted');
    expect(dm.saveDataTracked('m/c.json', r.o, 3).outcome).toBe('saved');
    expect(dm.deleteDataTracked('m/b.json', r.o).outcome).toBe('deleted');
    expect(dm.saveDataTracked('m/b.json', r.o, 4).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readdirSync(r.p('m')).sort()).toEqual(['b.json', 'c.json']);
    expect(fs.readFileSync(r.p('m/b.json'), 'utf8')).toBe('4');
  });
});

describe('queued deletes and the order of the checks, case-insensitive helper, cache on', () => {
  it("a delete of 'm/A.json' then a save of 'M/c.json' in one tick answers io naming m/A.json; after flushAll the save is saved", async () => {
    const r = rig('case-insensitive', true, { 'm/A.json': '1' });
    expect(dm.loadData('m/A.json', r.o, null)).toBe(1);
    expect(dm.deleteDataTracked('m/A.json', r.o).outcome).toBe('deleted');
    refusedFor(dm.saveDataTracked('M/c.json', r.o, 2), 'io', 'm/A.json');
    await dm.flushAll();
    expect(dm.deleteDataTracked('m/A.json', r.o).outcome).toBe('absent');
    expect(dm.saveDataTracked('M/c.json', r.o, 2).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readdirSync(r.p())).toEqual(['M']);
    expect(fs.readdirSync(r.p('M'))).toEqual(['c.json']);
  });

  it("a delete of 'm/a.json' held by an EPERM unlink: a save of 'm/A.json' answers io naming m/a.json, never unstorable", async () => {
    const r = rig('case-insensitive', true, { 'm/a.json': '1' });
    expect(dm.loadData('m/a.json', r.o, null)).toBe(1);
    const unlink = failing(fs.promises, 'unlink', 'EPERM', p => p.endsWith('a.json'));
    expect(dm.deleteDataTracked('m/a.json', r.o).outcome).toBe('deleted');
    await new Promise(resolve => { setTimeout(resolve, 20); });
    expect(fs.existsSync(r.p('m/a.json'))).toBe(true);
    refusedFor(dm.saveDataTracked('m/A.json', r.o, 2), 'io', 'm/a.json');
    unlink.lift();
    await dm.flushAll();
    expect(fs.existsSync(r.p('m'))).toBe(false);
  });

  it("with 'm/A.json' and 'm/b.json' landed, a delete of 'm/A.json' then a save of 'M/c.json' answers unstorable naming m", async () => {
    const r = rig('case-insensitive', true, { 'm/A.json': '1', 'm/b.json': '2' });
    expect(dm.loadData('m/b.json', r.o, null)).toBe(2);
    expect(dm.deleteDataTracked('m/A.json', r.o).outcome).toBe('deleted');
    const answer = dm.saveDataTracked('M/c.json', r.o, 3);
    refusedExactly(answer, 'unstorable', 'it differs only in letter case from m');
  });
});

describe.each(DISKS)('a folder the delete could not remove, %s disk, cache on', disk => {
  it('rmdir EBUSY once: the one-tick save answers io; then the folder stays empty, the next save of its name lands, and m/ is not refused 31 s on', async () => {
    const r = rig(disk, true, { 'm/a/x.json': '1' });
    expect(dm.loadData('m/a/x.json', r.o, null)).toBe(1);
    const rmdir = failing(fs.promises, 'rmdir', 'EBUSY', () => true, 1);
    expect(dm.deleteDataTracked('m/a/x.json', r.o).outcome).toBe('deleted');
    refusedFor(dm.saveDataTracked('m/a', r.o, 2), 'io', 'm/a/x.json');
    expect(getPending(r.p('m/a'))).toBeUndefined();
    await dm.flushAll();
    expect(rmdir.left()).toBe(0);
    expect(fs.statSync(r.p('m/a')).isDirectory()).toBe(true);
    expect(fs.readdirSync(r.p('m/a'))).toEqual([]);
    expect(dm.saveDataTracked('m/a', r.o, 2).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readFileSync(r.p('m/a'), 'utf8')).toBe('2');
    later(31_000);
    expect(dm.saveDataTracked('m/b.json', r.o, 3).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readFileSync(r.p('m/b.json'), 'utf8')).toBe('3');
  });

  it("with rmdirSync failing EBUSY too, the save of 'm/a' answers io 'holds no data but could not be removed', and saves once lifted", async () => {
    const r = rig(disk, true, { 'm/a/x.json': '1' });
    expect(dm.loadData('m/a/x.json', r.o, null)).toBe(1);
    failing(fs.promises, 'rmdir', 'EBUSY', () => true, 1);
    const sync = failing(fs, 'rmdirSync', 'EBUSY', () => true);
    expect(dm.deleteDataTracked('m/a/x.json', r.o).outcome).toBe('deleted');
    await dm.flushAll();
    refusedFor(dm.saveDataTracked('m/a', r.o, 2), 'io', 'the folder m/a holds no data but could not be removed');
    expect(r.queued()).toEqual([]);
    sync.lift();
    expect(dm.saveDataTracked('m/a', r.o, 2).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readFileSync(r.p('m/a'), 'utf8')).toBe('2');
  });
});

describe.each(DISKS)('temp files left by a failed try, %s disk, cache on', disk => {
  /** The next temp file opened under dir gets a handle whose method throws code once. */
  function handleFailsOnce(dir: string, method: 'writeFile' | 'sync', code: string): Promise<void> {
    const spy = vi.mocked(fs.promises.open) as any;
    const prev = spy.getMockImplementation() ?? fs.promises.open;
    let done = false;
    let thrown!: () => void;
    const threw = new Promise<void>(resolve => { thrown = resolve; });
    spy.mockImplementation(async (...args: unknown[]) => {
      const fh = await prev(...args);
      const p = String(args[0]);
      if (!done && p.endsWith('.tmp') && path.dirname(p) === dir) {
        done = true;
        const real = fh[method].bind(fh);
        fh[method] = async () => {
          fh[method] = real;
          thrown();
          throw Object.assign(new Error(`${code} (stub)`), { code });
        };
      }
      return fh;
    });
    return threw;
  }

  it.each([['writeFile', 'ENOSPC'], ['sync', 'EIO']] as const)('fh.%s failing %s once leaves no temp file; the write, its delete and a save of m/a all land', async (method, code) => {
    const r = rig(disk, true);
    fs.mkdirSync(r.p('m/a'), { recursive: true });
    const threw = handleFailsOnce(r.p('m/a'), method, code);
    expect(dm.saveDataTracked('m/a/x.json', r.o, 1).outcome).toBe('saved');
    await threw;
    await new Promise(resolve => { setTimeout(resolve, 50); });
    expect(tmpsIn(r.p('m/a'))).toEqual([]);
    await dm.flushAll();
    expect(fs.readFileSync(r.p('m/a/x.json'), 'utf8')).toBe('1');
    expect(dm.deleteDataTracked('m/a/x.json', r.o).outcome).toBe('deleted');
    await dm.flushAll();
    expect(fs.existsSync(r.p('m/a'))).toBe(false);
    expect(dm.saveDataTracked('m/a', r.o, 2).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readFileSync(r.p('m/a'), 'utf8')).toBe('2');
  });

  it("a rename that gives up with EPERM and a temp unlink failing EPERM: the temp file stays, and after the delete a save of 'm/a' removes it and lands", async () => {
    const r = rig(disk, true);
    let firstTmp: string | null = null;
    const rename = failing(fs.promises, 'rename', 'EPERM', p => {
      if (!p.endsWith('.tmp') || !p.startsWith(r.p('m', 'a'))) return false;
      firstTmp ??= p;
      return p === firstTmp;
    });
    const unlink = failing(fs.promises, 'unlink', 'EPERM', p => p === firstTmp);
    expect(dm.saveDataTracked('m/a/x.json', r.o, 1).outcome).toBe('saved');
    await dm.flushAll();
    rename.lift();
    unlink.lift();
    await dm.flushAll();
    expect(fs.readFileSync(r.p('m/a/x.json'), 'utf8')).toBe('1');
    expect(tmpsIn(r.p('m/a'))).toHaveLength(1);
    expect(dm.deleteDataTracked('m/a/x.json', r.o).outcome).toBe('deleted');
    await dm.flushAll();
    expect(fs.readdirSync(r.p('m/a'))).toHaveLength(1);
    expect(dm.saveDataTracked('m/a', r.o, 2).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readFileSync(r.p('m/a'), 'utf8')).toBe('2');
  }, 20_000);

  it("the removal step keeps a temp file of this pid that a held write has open, and the held rename then lands", async () => {
    const r = rig(disk, true);
    const rename = hold(fs.promises, 'rename', p => p.endsWith('.tmp') && path.dirname(p) === r.p('m', 'a'));
    expect(dm.saveDataTracked('m/a/x.json', r.o, 1).outcome).toBe('saved');
    const flushing = dm.flushAll();
    await rename.reached;
    const open = tmpsIn(r.p('m/a'));
    expect(open).toHaveLength(1);
    dropPendingForGuild(r.guildId);
    const answer = placeGuildWrite(r.guildId, 'm/a');
    expect(answer).toMatchObject({ ok: false, cause: 'io' });
    expect((answer as { reason: string }).reason).toContain('the folder m/a holds no data but could not be removed');
    expect(tmpsIn(r.p('m/a'))).toEqual(open);
    rename.release();
    await flushing;
    await vi.waitFor(() => { expect(fs.existsSync(r.p('m/a/x.json'))).toBe(true); });
    expect(fs.readFileSync(r.p('m/a/x.json'), 'utf8')).toBe('1');
    expect(tmpsIn(r.p('m/a'))).toEqual([]);
    expect(errors.filter(e => e.includes('ENOENT'))).toEqual([]);
  });

  it.each([[10 * 60_000, 'io'], [2 * 3_600_000, 'saved']] as const)('another pid\'s temp file %d ms old in m/a: the save of m/a answers %s', async (age, outcome) => {
    const r = rig(disk, true, {}, ['m/a']);
    const tmp = r.p('m/a', `x.json.4242424.${Date.now() - age}.0.tmp`);
    fs.writeFileSync(tmp, 'partial');
    const old = new Date(Date.now() - age);
    fs.utimesSync(tmp, old, old);
    const answer = dm.saveDataTracked('m/a', r.o, 1);
    if (outcome === 'io') {
      refusedFor(answer, 'io', 'the folder m/a holds no data but could not be removed');
      expect(fs.readFileSync(tmp, 'utf8')).toBe('partial');
    } else {
      expect(answer.outcome).toBe('saved');
      await dm.flushAll();
      expect(fs.readFileSync(r.p('m/a'), 'utf8')).toBe('1');
    }
  });
});

describe('cost, bot process (cache on), real disk', () => {
  it('a guild folder of 10,000 files: each write lists and lstats only what its path needs', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) files[`m/f${i}.json`] = '1';
    for (let i = 0; i < 5000; i++) files[`n/users/${i}.json`] = '1';
    const r = rig('case-sensitive', true, files);
    expect(dm.saveDataTracked('m/x.json', r.o, 0).outcome).toBe('saved');
    expect(r.listed().sort()).toEqual(['', 'm']);
    r.disk.reset();
    for (let i = 0; i < 1000; i++) expect(dm.saveDataTracked('m/x.json', r.o, i).outcome).toBe('saved');
    expect(r.listed()).toEqual([]);
    expect(r.disk.count('lstatSync', r.p())).toBe(0);
    r.disk.reset();
    expect(dm.saveDataTracked('m/y.json', r.o, 1).outcome).toBe('saved');
    expect(r.listed()).toEqual([]);
    expect(r.disk.count('lstatSync', r.p())).toBe(2);
    r.disk.reset();
    expect(dm.saveDataTracked('n/users/1.json', r.o, 1).outcome).toBe('saved');
    expect(r.listed().sort()).toEqual(['n', 'n/users']);
    await dm.flushAll();
    expect(fs.readFileSync(r.p('m/x.json'), 'utf8')).toBe('999');
  }, 60_000);

  it.skipIf(realFolds)("with 'M/' also on disk, the first write of 'm/x.json' walks M/ and no other folder", async () => {
    const r = rig('case-sensitive', true, { 'm/a.json': '1', 'M/b.json': '2', 'n/c.json': '3' });
    expect(dm.saveDataTracked('m/x.json', r.o, 0).outcome).toBe('saved');
    expect(r.listed().sort()).toEqual(['', 'M', 'm']);
    await dm.flushAll();
    expect(fs.readFileSync(r.p('m/x.json'), 'utf8')).toBe('0');
    expect(fs.readdirSync(r.p('M'))).toEqual(['b.json']);
    expect(fs.readFileSync(r.p('M/b.json'), 'utf8')).toBe('2');
  });

  it('the totals flush over many guilds lists each guild folder and its metrics folder, no module folder, and nothing the second time', async () => {
    setBackendKind('file');
    setGuildViewCache(true);
    const ids: string[] = [];
    for (let g = 0; g < 50; g++) {
      const id = String(++guilds);
      ids.push(id);
      fs.mkdirSync(dataPath(id, 'leveling', 'users'), { recursive: true });
      for (let i = 0; i < 20; i++) fs.writeFileSync(dataPath(id, 'leveling', 'users', `${i}.json`), '1');
      fs.mkdirSync(dataPath(id, METRICS_NAMESPACE));
      fs.writeFileSync(dataPath(id, METRICS_NAMESPACE, TOTALS_FILENAME), '{}');
    }
    const disk = useDisk('case-sensitive', dataPath());
    const collector = new MetricsCollector() as any;
    collector.enabled = true;
    collector.seeded = true;
    for (const id of ids) collector.activeSinceFlush.add(id);
    collector.flushTotals();
    const listedRel = () => (disk.calls.get('readdirSync') ?? []).filter(p => ids.some(id => p === dataPath(id) || p.startsWith(dataPath(id) + path.sep)));
    const listedNow = listedRel();
    for (const id of ids) {
      expect(listedNow.filter(p => p === dataPath(id))).toHaveLength(1);
      expect(listedNow.filter(p => p === dataPath(id, METRICS_NAMESPACE))).toHaveLength(1);
    }
    expect(listedNow.filter(p => p.includes(`${path.sep}leveling`))).toEqual([]);
    await dm.flushAll();
    for (const id of ids) expect(fs.existsSync(dataPath(id, METRICS_NAMESPACE, TOTALS_FILENAME))).toBe(true);
    disk.reset();
    for (const id of ids) collector.activeSinceFlush.add(id);
    collector.flushTotals();
    expect(listedRel()).toEqual([]);
  }, 60_000);

  it('the web UI process (cache off) lists the folders on the path of each write and no other', () => {
    const r = rig('case-sensitive', false, { 'm/a.json': '1', 'n/users/1.json': '2', 'o/x.json': '3' });
    expect(dm.saveDataTracked('n/users/2.json', r.o, 0).outcome).toBe('saved');
    expect(r.listed().sort()).toEqual(['', 'n', 'n/users']);
    r.disk.reset();
    expect(dm.saveDataTracked('n/users/2.json', r.o, 1).outcome).toBe('saved');
    expect(r.listed().sort()).toEqual(['', 'n', 'n/users']);
  });

  it('the set route: 1,000 new keys in a set of 100,000 read no whole-set key list', async () => {
    setBackendKind('postgres');
    const store = new FakeStore();
    const guildId = String(++guilds);
    for (let i = 0; i < 100_000; i++) store.docs.set(`${guildId}|m/k${i}.json`, '1');
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    const listAll = vi.spyOn(ws, 'listAllKeys');
    for (let i = 0; i < 1000; i++) expect(dm.saveDataTracked(`m/new${i}.json`, { guildId }, i).outcome).toBe('saved');
    expect(listAll).not.toHaveBeenCalled();
    expect(await ws.flushGuildNow(guildId, 5000)).toBe('ok');
    expect(store.docs.get(`${guildId}|m/new999.json`)).toBe('999');
  }, 60_000);
});

describe.each([true, false])('a pair stored before NB12 on a case-sensitive disk, cache %s (decision 8)', cache => {
  const noRefusal = () => {
    expect(errors.filter(e => e.startsWith('[Data] Refused'))).toEqual([]);
    expect(errors.filter(e => e.includes('the folder M') || e.includes('the folder m/Users'))).toEqual([]);
  };

  it.skipIf(realFolds)("with 'm/a.json' and 'M/b.json' stored, new keys and overwrites under either spelling are saved and land", async () => {
    const r = rig('case-sensitive', cache, { 'm/a.json': '1', 'M/b.json': '2' });
    for (const [key, value] of [['m/x.json', 10], ['m/a.json', 11], ['M/b.json', 12], ['M/y.json', 13], ['m/a.json', 14]] as const) {
      expect(dm.saveDataTracked(key, r.o, value)).toMatchObject({ outcome: 'saved' });
    }
    await dm.flushAll();
    expect(fs.readdirSync(r.p()).sort()).toEqual(['M', 'm']);
    expect(fs.readdirSync(r.p('m')).sort()).toEqual(['a.json', 'x.json']);
    expect(fs.readdirSync(r.p('M')).sort()).toEqual(['b.json', 'y.json']);
    expect(fs.readFileSync(r.p('m/x.json'), 'utf8')).toBe('10');
    expect(fs.readFileSync(r.p('m/a.json'), 'utf8')).toBe('14');
    expect(fs.readFileSync(r.p('M/b.json'), 'utf8')).toBe('12');
    expect(fs.readFileSync(r.p('M/y.json'), 'utf8')).toBe('13');
    noRefusal();
  });

  it.skipIf(realFolds)("an overwrite of 'm/a.json' alone is saved, and M/b.json keeps its bytes", async () => {
    const r = rig('case-sensitive', cache, { 'm/a.json': '1', 'M/b.json': '{"keep":true}' });
    expect(dm.saveDataTracked('m/a.json', r.o, 2).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readFileSync(r.p('m/a.json'), 'utf8')).toBe('2');
    expect(fs.readFileSync(r.p('M/b.json'), 'utf8')).toBe('{"keep":true}');
    noRefusal();
  });

  it.skipIf(realFolds)("a pair one level down, 'm/users/1.json' and 'm/Users/2.json': new keys in either folder are saved and land", async () => {
    const r = rig('case-sensitive', cache, { 'm/users/1.json': '1', 'm/Users/2.json': '2' });
    expect(dm.saveDataTracked('m/users/3.json', r.o, 3).outcome).toBe('saved');
    expect(dm.saveDataTracked('m/Users/4.json', r.o, 4).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readdirSync(r.p('m')).sort()).toEqual(['Users', 'users']);
    expect(fs.readdirSync(r.p('m/users')).sort()).toEqual(['1.json', '3.json']);
    expect(fs.readdirSync(r.p('m/Users')).sort()).toEqual(['2.json', '4.json']);
    expect(fs.readFileSync(r.p('m/users/3.json'), 'utf8')).toBe('3');
    expect(fs.readFileSync(r.p('m/Users/4.json'), 'utf8')).toBe('4');
    expect(fs.readFileSync(r.p('m/Users/2.json'), 'utf8')).toBe('2');
    noRefusal();
  });

  it.skipIf(realFolds)("with the pair stored, a new spelling 'M/' or 'm/USERS' is still refused, naming a stored spelling", async () => {
    const r = rig('case-sensitive', cache, { 'm/a.json': '1', 'M/b.json': '2', 'n/users/1.json': '3', 'n/Users/2.json': '4' });
    refusedFor(dm.saveDataTracked('m/A.json', r.o, 5), 'unstorable', 'm/a.json');
    refusedFor(dm.saveDataTracked('n/USERS/5.json', r.o, 5), 'unstorable', 'it differs only in letter case from n/');
    await dm.flushAll();
    expect(fs.readdirSync(r.p('m'))).toEqual(['a.json']);
    expect(fs.readdirSync(r.p('n')).sort()).toEqual(['Users', 'users']);
  });
});

describe('the same pair on the working-set route (decision 8, invariant 3)', () => {
  it("with 'm/a.json' and 'M/b.json' stored, new keys and overwrites under either spelling are saved and stored", async () => {
    setBackendKind('postgres');
    const store = new ServerStore();
    const guildId = String(++guilds);
    store.docs.set(`${guildId}|m/a.json`, '1');
    store.docs.set(`${guildId}|M/b.json`, '2');
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    for (const [key, value] of [['m/x.json', 10], ['m/a.json', 11], ['M/b.json', 12], ['M/y.json', 13], ['m/a.json', 14]] as const) {
      expect(dm.saveDataTracked(key, { guildId }, value)).toMatchObject({ outcome: 'saved' });
    }
    refusedFor(dm.saveDataTracked('m/A.json', { guildId }, 5), 'unstorable', 'm/a.json');
    expect(await ws.flushGuildNow(guildId, 1000)).toBe('ok');
    expect([...store.docs.entries()].filter(([k]) => k.startsWith(`${guildId}|`)).sort()).toEqual([
      [`${guildId}|M/b.json`, '12'],
      [`${guildId}|M/y.json`, '13'],
      [`${guildId}|m/a.json`, '14'],
      [`${guildId}|m/x.json`, '10'],
    ]);
    ws.evict(guildId);
  });
});

describe.each([true, false])('pairs the code folds and NTFS keeps apart, case-insensitive helper, cache %s (a guard)', cache => {
  it("'m/\u00DF.json' saved: 'm/ss.json' and 'm/\u1E9E.json' are refused naming it, and the helper keeps 'ss.json' a separate file", async () => {
    const r = rig('case-insensitive', cache);
    expect(dm.saveDataTracked('m/\u00DF.json', r.o, 1).outcome).toBe('saved');
    await dm.flushAll();
    refusedFor(dm.saveDataTracked('m/ss.json', r.o, 2), 'unstorable', 'm/\u00DF.json');
    refusedFor(dm.saveDataTracked('m/\u1E9E.json', r.o, 3), 'unstorable', 'm/\u00DF.json');
    await dm.flushAll();
    expect(fs.readdirSync(r.p('m'))).toEqual(['\u00DF.json']);
    expect(fs.readFileSync(r.p('m/\u00DF.json'), 'utf8')).toBe('1');
    fs.writeFileSync(r.p('m/ss.json'), 'other');
    expect(fs.readdirSync(r.p('m')).sort()).toEqual(['ss.json', '\u00DF.json']);
    expect(fs.readFileSync(r.p('m/\u00DF.json'), 'utf8')).toBe('1');
    expect(fs.readFileSync(r.p('m/ss.json'), 'utf8')).toBe('other');
  });
});

describe.each(DISKS)('sub-folders listed but never walked, bot process (cache on), %s disk', disk => {
  it.skipIf(foldsHere(disk))("'m/users/1.json' on disk: 'm/Users/2.json' and 'm/USERS' are refused naming m/users, with m/ listed once and m/users walked once", () => {
    const r = rig(disk, true, { 'm/users/1.json': '1' });
    expect(dm.saveDataTracked('m/x.json', r.o, 0).outcome).toBe('saved');
    expect(r.listed().sort()).toEqual(['', 'm']);
    r.disk.reset();
    refusedExactly(dm.saveDataTracked('m/Users/2.json', r.o, 2), 'unstorable', 'it differs only in letter case from m/users');
    refusedExactly(dm.saveDataTracked('m/USERS', r.o, 3), 'unstorable', 'it differs only in letter case from m/users');
    // m/ is listed only by decision 8's disk check before each refusal (NB12.md, 'Gatekeeper rulings on the code review').
    expect(r.listed().filter(x => x === 'm')).toEqual(['m', 'm']);
    expect(r.listed().filter(x => x === 'm/users')).toEqual(['m/users']);
    r.disk.reset();
    expect(dm.saveDataTracked('m/users/2.json', r.o, 2).outcome).toBe('saved');
    expect(r.listed().filter(x => x === 'm/users').length).toBeLessThanOrEqual(1);
  });

  it.skipIf(foldsHere(disk))("'m/a.json' and 'm/users/old/1.json' on disk, an absent delete first: the aliases are refused, m/users/old listed once", () => {
    const r = rig(disk, true, { 'm/a.json': '1', 'm/users/old/1.json': '2' });
    expect(dm.deleteDataTracked('m/users/gone.json', r.o).outcome).toBe('absent');
    expect(r.listed().sort()).toEqual(['', 'm', 'm/users']);
    r.disk.reset();
    refusedExactly(dm.saveDataTracked('m/Users/2.json', r.o, 2), 'unstorable', 'it differs only in letter case from m/users');
    expect(r.listed().filter(x => x === 'm/users/old')).toEqual(['m/users/old']);
    r.disk.reset();
    refusedExactly(dm.saveDataTracked('m/USERS', r.o, 3), 'unstorable', 'it differs only in letter case from m/users');
    expect(r.listed()).toEqual(['m']);
  });

  it.skipIf(foldsHere(disk))("the same with a save of 'm/users/x.json' and its landed delete in place of the absent delete", async () => {
    const r = rig(disk, true, { 'm/a.json': '1', 'm/users/old/1.json': '2' });
    expect(dm.saveDataTracked('m/users/x.json', r.o, 1).outcome).toBe('saved');
    await dm.flushAll();
    expect(dm.deleteDataTracked('m/users/x.json', r.o).outcome).toBe('deleted');
    await dm.flushAll();
    expect(fs.readdirSync(r.p('m/users'))).toEqual(['old']);
    r.disk.reset();
    refusedExactly(dm.saveDataTracked('m/Users/2.json', r.o, 2), 'unstorable', 'it differs only in letter case from m/users');
    expect(r.listed().filter(x => x === 'm/users/old')).toEqual(['m/users/old']);
    r.disk.reset();
    refusedExactly(dm.saveDataTracked('m/USERS', r.o, 3), 'unstorable', 'it differs only in letter case from m/users');
    expect(r.listed()).toEqual(['m']);
  });

  it.skipIf(foldsHere(disk))("a guard: the same landed delete with m/users/old emptied by hand, then 'm/Users/2.json' is saved", async () => {
    const r = rig(disk, true, { 'm/a.json': '1', 'm/users/old/1.json': '2' });
    expect(dm.saveDataTracked('m/users/x.json', r.o, 1).outcome).toBe('saved');
    await dm.flushAll();
    expect(dm.deleteDataTracked('m/users/x.json', r.o).outcome).toBe('deleted');
    await dm.flushAll();
    fs.unlinkSync(r.p('m/users/old/1.json'));
    expect(dm.saveDataTracked('m/Users/2.json', r.o, 2).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readFileSync(r.p('m/Users/2.json'), 'utf8')).toBe('2');
    expect(fs.readFileSync(r.p('m/a.json'), 'utf8')).toBe('1');
  });

  it.skipIf(foldsHere(disk))("a guard: 'm/users/old/1.json' deleted and landed removes both folders, then 'm/Users/2.json' is saved", async () => {
    const r = rig(disk, true, { 'm/a.json': '1', 'm/users/old/1.json': '2' });
    expect(dm.loadData('m/users/old/1.json', r.o, null)).toBe(2);
    expect(dm.deleteDataTracked('m/users/old/1.json', r.o).outcome).toBe('deleted');
    await dm.flushAll();
    expect(fs.readdirSync(r.p('m'))).toEqual(['a.json']);
    expect(dm.saveDataTracked('m/Users/2.json', r.o, 2).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readFileSync(r.p('m/Users/2.json'), 'utf8')).toBe('2');
  });
});

describe('property: generated histories on both routes and both file disks, with restarts', () => {
  const KEYS = [
    'm/a', 'm/a/x.json', 'm/A/y.json', 'm/a.json', 'm/A.json', 'M/b.json', 'm/b.json',
    'tags/x.json', 'Tags/y.json', 'words/kir.json', 'words/k\u0131r.json',
    'm/log.jsonl', 'm/a/l.jsonl', 'M/log.jsonl', 'm/users/old/1.json', 'm/Users/2.json', 'm/users',
    'cache.tmp/x.json', 'm/con.json', 'm/s\u017F.json', 'm/ss.json',
  ];
  const drawnKey = fc.array(
    fc.oneof(
      fc.constantFrom('m', 'M', 'a', 'A', 'i', 'I', '\u0130', '\u0131', 'x.json', 'X.JSON', 'l.jsonl'),
      fc.string({ unit: 'binary', minLength: 1, maxLength: 3 }).filter(part => !part.includes('/')),
    ),
    { minLength: 1, maxLength: 3 },
  ).map(parts => parts.join('/'));
  const key = fc.oneof(fc.constantFrom(...KEYS), drawnKey);
  type Step =
    | { op: 'save'; key: string; value: number }
    | { op: 'append'; key: string; line: string }
    | { op: 'delete'; key: string }
    | { op: 'flush' }
    | { op: 'restart' };
  const step: fc.Arbitrary<Step> = fc.oneof(
    { weight: 4, arbitrary: fc.record({ op: fc.constant('save' as const), key, value: fc.integer({ min: 0, max: 99 }) }) },
    { weight: 2, arbitrary: fc.record({ op: fc.constant('append' as const), key, line: fc.string({ unit: 'binary', maxLength: 4 }).map(s => `${s}\n`) }) },
    { weight: 3, arbitrary: fc.record({ op: fc.constant('delete' as const), key }) },
    { weight: 1, arbitrary: fc.constant({ op: 'flush' as const }) },
    { weight: 1, arbitrary: fc.constant({ op: 'restart' as const }) },
  );

  const answerOf = (a: { outcome: string; cause?: string }) => (a.outcome === 'refused' ? `refused ${a.cause}` : a.outcome);

  /** The stored key or folder a collision reason names, null for a reason that names none. */
  function namedEntry(reason: string): string | null {
    const m = /^it differs only in letter case from (.+)$/s.exec(reason)
      ?? /^the folder (.+) of it is a file$/s.exec(reason)
      ?? /^(.+) names a folder that holds other keys$/s.exec(reason);
    return m ? m[1] : null;
  }

  /** Invariant 3's 'in the way': a queued delete d of another spelling of key, of a key under it, of a file named as
   * one of its folders, or of a key in another spelling of one of its folders. */
  function inTheWay(d: string, key: string): boolean {
    if (d === key) return false;
    const fd = fold(d);
    const fk = fold(key);
    if (fd === fk || fd.startsWith(`${fk}/`)) return true;
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/');
      const ff = fold(folder);
      if (fd === ff) return true;
      if (fd.startsWith(`${ff}/`) && d.slice(0, folder.length) !== folder) return true;
    }
    return false;
  }

  /** Every stored key of the model and every folder above one, spelled as stored. */
  function storedEntries(model: Map<string, string>): string[] {
    const out = new Set<string>();
    for (const key of model.keys()) {
      out.add(key);
      const parts = key.split('/');
      for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('/'));
    }
    return [...out];
  }

  /** The data files under root as keys, temp files left out, spelled as the disk holds them. */
  function filesUnder(root: string): string[] {
    if (!fs.existsSync(root)) return [];
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const key = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), key);
        else if (!entry.name.endsWith('.tmp')) out.push(key);
      }
    };
    walk(root, '');
    return out.sort();
  }

  async function run(disk: DiskName, history: Step[], flushFirst: boolean): Promise<void> {
    const store = new ServerStore();
    const ws = initWorkingSet(store);
    const setGuild = String(++guilds);
    const fileGuild = String(++guilds);
    setBackendKind('postgres');
    expect(await ws.hydrate(setGuild, tokenFor())).toBe('ready');
    setBackendKind('file');
    setGuildViewCache(true);
    const d = useDisk(disk, dataPath());
    const model = new Map<string, string>();
    const flushBoth = async () => {
      await dm.flushAll();
      expect(await ws.flushGuildNow(setGuild, 1000)).toBe('ok');
    };
    const both = async (written: string, write: (o: dm.DataOptions) => { outcome: string; cause?: string; reason?: string }) => {
      // NB13 decision 12: a save of a .jsonl name and an append to any other name throw a TypeError on both routes.
      const fn = (o: dm.DataOptions): { outcome: string; cause?: string; reason?: string } => {
        try {
          return write(o);
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          return { outcome: 'threw', reason: error.message };
        }
      };
      setBackendKind('postgres');
      const onSet = fn({ guildId: setGuild });
      setBackendKind('file');
      let onFile = fn({ guildId: fileGuild });
      const queuedDelete = onFile.outcome === 'refused' && onFile.cause === 'io' ? /^a delete of (.*) is still being written$/s.exec(onFile.reason ?? '') : null;
      if (!flushFirst && queuedDelete) {
        const named = queuedDelete[1];
        expect(getPending(dataPath(fileGuild, ...named.split('/')))?.op).toBe('delete');
        expect(inTheWay(named, written)).toBe(true);
        await flushBoth();
        onFile = fn({ guildId: fileGuild });
      }
      expect(answerOf(onFile)).toBe(answerOf(onSet));
      if (onSet.outcome === 'threw') expect(onFile.reason).toBe(onSet.reason);
      if (onSet.outcome === 'refused' && onSet.cause === 'unstorable') {
        expect(onFile.reason).toBe(onSet.reason);
        const named = namedEntry(onSet.reason ?? '');
        if (named !== null) expect(storedEntries(model)).toContain(named);
      }
      return onSet;
    };
    try {
      for (const s of history) {
        if (s.op === 'flush') {
          await flushBoth();
        } else if (s.op === 'restart') {
          await flushBoth();
          setGuildViewCache(true);
          ws.evict(setGuild);
          setBackendKind('postgres');
          expect(await ws.hydrate(setGuild, tokenFor())).toBe('ready');
          setBackendKind('file');
        } else if (s.op === 'save') {
          if (flushFirst) await flushBoth();
          const a = await both(s.key, o => dm.saveDataTracked(s.key, o, s.value));
          if (a.outcome === 'saved') model.set(s.key, String(s.value));
        } else if (s.op === 'append') {
          if (flushFirst) await flushBoth();
          const a = await both(s.key, o => dm.appendDataTracked(s.key, o, s.line));
          if (a.outcome === 'appended') model.set(s.key, (model.get(s.key) ?? '') + s.line);
        } else {
          const a = await both(s.key, o => dm.deleteDataTracked(s.key, o));
          if (a.outcome === 'deleted') model.delete(s.key);
        }
      }
      await flushBoth();
      const kept = new KeyTree();
      for (const [key, text] of model) {
        expect(kept.add(key)).toBeNull();
        expect(fs.readFileSync(dataPath(fileGuild, ...key.split('/')), 'utf8')).toBe(text);
        const row = `${setGuild}|${key.includes('/') ? key : `/${key}`}`;
        expect(key.endsWith('.jsonl') ? store.streams.get(row) : store.docs.get(row)).toBe(text);
      }
      const ownRows = (rows: Map<string, string>) => [...rows.keys()].filter(k => k.startsWith(`${setGuild}|`)).map(k => k.slice(setGuild.length + 1).replace(/^\//, '')).sort();
      expect(ownRows(store.docs)).toEqual([...model.keys()].filter(k => !k.endsWith('.jsonl')).sort());
      expect(ownRows(store.streams)).toEqual([...model.keys()].filter(k => k.endsWith('.jsonl')).sort());
      expect(filesUnder(dataPath(fileGuild))).toEqual([...model.keys()].sort());
    } finally {
      d.reset();
      vi.restoreAllMocks();
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      ws.evict(setGuild);
    }
  }

  for (const disk of DISKS) {
    it.skipIf(foldsHere(disk))(`with a flush before each write, ${disk} disk: the routes answer alike and every accepted write reads back`, async () => {
      await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 25 }), history => run(disk, history, true)), { numRuns: 25 });
    }, 120_000);

    it.skipIf(foldsHere(disk))(`without it, ${disk} disk: the file route answers io only behind a queued delete, and the same write after a flush answers as the set`, async () => {
      await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 25 }), history => run(disk, history, false)), { numRuns: 25 });
    }, 120_000);
  }
});
