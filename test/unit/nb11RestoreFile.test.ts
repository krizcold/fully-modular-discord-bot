import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ existsThrow: null as string | null }));
vi.mock('fs', async importOriginal => {
  const real = await importOriginal<any>();
  const existsSync = (p: any) => {
    if (h.existsThrow && String(p).includes(h.existsThrow)) throw new Error('lookup failed');
    return real.existsSync(p);
  };
  return { ...real, default: { ...real, existsSync }, existsSync };
});

import fs from 'fs';
import { gateCauseNow, gateEventDispatch } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { dropPendingForGuild, enqueueWrite, guildHasQueuedOps, listGraveyardEntries, sweepGraveyard as sweepFiles } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import {
  appendDataTracked,
  confirmWrite,
  deleteDataTracked,
  deleteGuildNamespace,
  deleteRawAtomic,
  drainForExit,
  flushAll,
  guildDataOpOf,
  loadData,
  restoreGuildFromGraveyard,
  saveData,
  saveDataTracked,
  sweepGraveyard,
  updateData,
  writeRawAtomic,
  type WriteTicket,
} from '../../src/bot/internalSetup/utils/dataManager';
import { setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

// NB11 tests 2 (wip-redesign/sheets/NB11.md, decisions 13, 14 and 20): the restore and the delete on a JSON bot.

const NO_ENTRY = 'no graveyard entry for this guild';
const DELETE_RUNNING = "a delete of this server's data is running; nothing was restored; try again once it ends";
const ALREADY = 'a restore of this server is already running; nothing was restored; its answer comes within a minute';
const RESTORE_RUNNING = 'a restore of this server from the graveyard is running; nothing was removed; try again once it ends';
const NODE_STOPPING = '[Data] This process is stopping; nothing was restored';
const OUT_OF_TIME = 'the restore ran out of its 40 s before it could commit; nothing was restored; try again in a moment';
const DELETE_FLUSH = "the server's unsaved changes are not confirmed saved yet; nothing was removed; try again in a moment";
const DELETE_OUT_OF_TIME = 'the delete ran out of its 40 s before it could commit; nothing was removed; try again in a moment';
const liveText = (g: string, r: number) => `server ${g} has data saved since entry ${r} was deleted; nothing was restored. To put entry ${r} in place and move the current data to the graveyard as a new entry, run: smdb graveyard restore ${g} ${r} --replace`;
const liveReply = (g: string, r: number) => ({ ok: false, code: 'invalid', refusal: 'live-data', retiredAt: r, error: liveText(g, r) });
const failingText = (file: string, code: string) => `a file of this server keeps failing to save (${file}: ${code}); nothing was removed; free disk space or fix the file's permissions, then try again`;

let guilds = 800_000_000_000_000_000n;
const freshGuild = () => String(++guilds);
const entryDir = (g: string, ms: number) => dataPath('_graveyard', `${g}-${ms}`);
const tick = (ms = 5) => new Promise<void>(resolve => setTimeout(resolve, ms));
const monoIn = (ms: number) => process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
const opts = (guildId: string) => ({ guildId, category: 'm' });
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};
const errno = (code: string) => Object.assign(new Error(code), { code });
const same = (a: unknown, b: unknown) => path.resolve(String(a)) === path.resolve(String(b));

function bury(g: string, ms: number, files: Record<string, string> = { 'm/a.json': '{"n":5}' }, reason = 'webui-operator-delete'): void {
  const dir = entryDir(g, ms);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  fs.writeFileSync(path.join(dir, '.graveyard.json'), JSON.stringify({ guildId: g, reason, ts: ms }, null, 2));
}

const listed = async (g: string) => (await listGraveyardEntries()).filter(e => e.guildId === g);
/** The entry untouched: listed with its reason, its files byte-equal, and no live folder for the guild. */
async function expectEntryKept(g: string, ms: number, files: Record<string, string> = { 'm/a.json': '{"n":5}' }, reason = 'webui-operator-delete'): Promise<void> {
  expect(await listed(g)).toEqual([{ guildId: g, retiredAt: ms, reason }]);
  for (const [rel, body] of Object.entries(files)) expect(fs.readFileSync(path.join(entryDir(g, ms), rel), 'utf8')).toBe(body);
  expect(fs.existsSync(dataPath(g))).toBe(false);
}
/** Holds listGraveyardEntries' readdir of the graveyard until the returned release is called. */
function holdLookup(): () => void {
  const lookup = deferred();
  const readdir = fs.promises.readdir.bind(fs.promises);
  let held = true;
  vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: any[]) => {
    if (held && same(args[0], dataPath('_graveyard'))) {
      held = false;
      await lookup.promise;
    }
    return (readdir as any)(...args);
  }) as any);
  return () => lookup.resolve();
}
/** Holds the open of the stamp's temp file in g's entry at ms until the returned release is called; reached resolves once it waits. */
function holdStamp(g: string, ms: number): { release: () => void; reached: Promise<void> } {
  const gate = deferred();
  const reached = deferred();
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
    if (same(path.dirname(String(p)), entryDir(g, ms)) && String(p).endsWith('.tmp')) {
      reached.resolve();
      await gate.promise;
    }
    return (open as any)(p, ...rest);
  }) as any);
  return { release: () => gate.resolve(), reached: reached.promise };
}
/** The rename of g's copy into place. */
const isPut = (g: string) => (from: unknown, to: unknown) => path.basename(String(from)).startsWith(`.restore-${g}-`) && same(to, dataPath(g));
const event = (g: string) => [{ guildId: g }];
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setBackendKind('file');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  h.existsThrow = null;
  vi.restoreAllMocks();
  setMaintenanceGate(null);
  await flushAll();
});

describe('writes and events during a restore', () => {
  it('a write during the restore is refused, and a later save lands in the restored folder', async () => {
    const g = freshGuild();
    bury(g, 1000, { 'm/a.json': '{"n":5}', 'm/b.json': '{"b":1}' });
    const restoring = restoreGuildFromGraveyard(g, 1000);
    expect(saveDataTracked('x.json', opts(g), { v: 1 })).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(await restoring).toEqual({ ok: true, retiredAt: 1000, reason: 'webui-operator-delete', keptUntil: expect.any(Number) });
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
    expect(fs.readFileSync(dataPath(g, 'm', 'b.json'), 'utf8')).toBe('{"b":1}');
    expect(fs.existsSync(dataPath(g, '.graveyard.json'))).toBe(false);
    expect(saveData('c.json', opts(g), { c: 1 })).toBe(true);
    await flushAll();
    expect(JSON.parse(fs.readFileSync(dataPath(g, 'm', 'c.json'), 'utf8'))).toEqual({ c: 1 });
  });

  it('an event during the restore runs on the restored folder', async () => {
    const g = freshGuild();
    bury(g, 1000);
    const lookup = deferred();
    const readdir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: any[]) => {
      await lookup.promise;
      return (readdir as any)(...args);
    }) as any);
    const restoring = restoreGuildFromGraveyard(g);
    const handled = deferred();
    const handler = async () => {
      const current = loadData<{ n: number }>('a.json', opts(g), { n: 0 });
      await tick();
      saveData('a.json', opts(g), { n: current.n + 1 });
      handled.resolve();
    };
    expect(await gateEventDispatch('messageCreate', event(g), () => { void handler(); })).toBe(false);
    expect(gateCauseNow(g, performance.now())).toBe('loading');
    lookup.resolve();
    expect(await restoring).toMatchObject({ ok: true, retiredAt: 1000 });
    await handled.promise;
    await flushAll();
    expect(JSON.parse(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8'))).toEqual({ n: 6 });
  });

  it('257 buffered events drop the oldest, and a refusal replays the buffered events at once', async () => {
    const g = freshGuild();
    fs.mkdirSync(dataPath(g), { recursive: true });
    bury(g, 1000);
    const lookup = deferred();
    const readdir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: any[]) => {
      await lookup.promise;
      return (readdir as any)(...args);
    }) as any);
    const restoring = restoreGuildFromGraveyard(g);
    const ran: number[] = [];
    for (let i = 0; i < 257; i++) expect(await gateEventDispatch('messageCreate', event(g), () => { ran.push(i); })).toBe(false);
    expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes(`Event buffer overflow for guild ${g}`))).toBe(true);
    lookup.resolve();
    expect(await restoring).toEqual(liveReply(g, 1000));
    expect(ran).toEqual(Array.from({ length: 256 }, (_v, i) => i + 1));
  });

  it('a queued op or a flush on the wire under the guild refuses the restore', async () => {
    const g = freshGuild();
    bury(g, 1000);
    enqueueWrite(dataPath(g, 'm', 'q.json'), '{"q":1}');
    expect(await restoreGuildFromGraveyard(g, 1000)).toEqual(liveReply(g, 1000));
    expect(await listed(g)).toHaveLength(1);
    await flushAll();

    for (const dropped of [false, true]) {
      const h2 = freshGuild();
      bury(h2, 1000);
      const mkdir = fs.promises.mkdir.bind(fs.promises);
      const wire = deferred();
      let onWire = false;
      vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (p: any, ...rest: any[]) => {
        if (String(p).startsWith(dataPath(h2))) {
          onWire = true;
          await wire.promise;
        }
        return (mkdir as any)(p, ...rest);
      }) as any);
      enqueueWrite(dataPath(h2, 'm', 'w.json'), '{"w":1}');
      await vi.waitFor(() => expect(onWire).toBe(true));
      // dropped: the op is on the wire and no longer queued (the case Round 1 missed).
      if (dropped) dropPendingForGuild(h2);
      expect(guildHasQueuedOps(h2)).toBe(true);
      expect(fs.existsSync(dataPath(h2))).toBe(false);
      expect(await restoreGuildFromGraveyard(h2, 1000)).toEqual(liveReply(h2, 1000));
      expect(await listed(h2)).toEqual([{ guildId: h2, retiredAt: 1000, reason: 'webui-operator-delete' }]);
      wire.resolve();
      await vi.waitFor(() => expect(guildHasQueuedOps(h2)).toBe(false));
      expect(fs.readFileSync(dataPath(h2, 'm', 'w.json'), 'utf8')).toBe('{"w":1}');
      expect(fs.existsSync(dataPath(h2, 'm', 'a.json'))).toBe(false);
      expect(fs.readFileSync(path.join(entryDir(h2, 1000), 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
      vi.restoreAllMocks();
    }
  });
});

describe('the stamp and the rename', () => {
  it('a rename of the copy that keeps failing keeps the entry with its note; a step that stops there lists it with its reason', async () => {
    const g = freshGuild();
    bury(g, 1000);
    const rename = fs.promises.rename.bind(fs.promises);
    let tries = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (isPut(g)(from, to)) {
        tries++;
        throw errno('EPERM');
      }
      return rename(from, to);
    }) as any);
    expect(await restoreGuildFromGraveyard(g, 1000)).toEqual({ ok: false, code: 'io-error', error: 'the copy of entry 1000 could not be put in place (EPERM); nothing was restored; try again in a moment' });
    expect(tries).toBe(10);
    expect(JSON.parse(fs.readFileSync(path.join(entryDir(g, 1000), '.graveyard.json'), 'utf8'))).toEqual({ guildId: g, reason: 'webui-operator-delete', ts: 1000, usedAt: expect.any(Number) });
    expect(await listed(g)).toEqual([{ guildId: g, retiredAt: 1000, reason: 'webui-operator-delete' }]);
    expect(fs.existsSync(dataPath(g))).toBe(false);
    vi.restoreAllMocks();

    const c = freshGuild();
    bury(c, 2000);
    const reached = deferred();
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (isPut(c)(from, to)) {
        reached.resolve();
        await new Promise(() => {});
      }
      return rename(from, to);
    }) as any);
    void restoreGuildFromGraveyard(c, 2000);
    await reached.promise;
    expect(await listed(c)).toEqual([{ guildId: c, retiredAt: 2000, reason: 'webui-operator-delete' }]);
  });

  it('the rename is retried; ENOENT at the stamp answers no entry', async () => {
    const g = freshGuild();
    bury(g, 1000, { 'm/a.json': '{"n":5}' }, 'test-reason');
    const rename = fs.promises.rename.bind(fs.promises);
    let fails = 2;
    let tries = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (isPut(g)(from, to)) {
        tries++;
        if (fails-- > 0) throw errno('EPERM');
      }
      return rename(from, to);
    }) as any);
    expect(await restoreGuildFromGraveyard(g, 1000)).toEqual({ ok: true, retiredAt: 1000, reason: 'test-reason', keptUntil: expect.any(Number) });
    expect(tries).toBe(3);
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
    vi.restoreAllMocks();

    const e = freshGuild();
    bury(e, 1000);
    const before = fs.readFileSync(path.join(entryDir(e, 1000), '.graveyard.json'), 'utf8');
    let enoent = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation((async () => { enoent++; throw errno('ENOENT'); }) as any);
    expect(await restoreGuildFromGraveyard(e, 1000)).toEqual({ ok: false, code: 'invalid', error: NO_ENTRY });
    expect(enoent).toBe(1);
    expect(fs.readFileSync(path.join(entryDir(e, 1000), '.graveyard.json'), 'utf8')).toBe(before);
  });

  it('a stamp that cannot be written refuses the restore', async () => {
    const g = freshGuild();
    bury(g, 1000);
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (same(path.dirname(String(p)), entryDir(g, 1000)) && String(p).endsWith('.tmp')) throw errno('EPERM');
      return (open as any)(p, ...rest);
    }) as any);
    const lookup = deferred();
    const readdir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: any[]) => {
      await lookup.promise;
      return (readdir as any)(...args);
    }) as any);
    const restoring = restoreGuildFromGraveyard(g);
    const ran = vi.fn();
    expect(await gateEventDispatch('messageCreate', event(g), ran)).toBe(false);
    lookup.resolve();
    expect(await restoring).toEqual({ ok: false, code: 'io-error', error: 'entry 1000 could not be marked as restored (EPERM); nothing was restored; try again in a moment' });
    expect(await listed(g)).toEqual([{ guildId: g, retiredAt: 1000, reason: 'webui-operator-delete' }]);
    expect(fs.existsSync(dataPath(g))).toBe(false);
    expect(guildDataOpOf(g)).toBeUndefined();
    expect(ran).toHaveBeenCalledTimes(1);
  });
  it('a throw in the lookup answers the error text and replays the queue', async () => {
    const g = freshGuild();
    bury(g, 1000);
    h.existsThrow = `${g}-1000`;
    const ran = vi.fn();
    const restoring = restoreGuildFromGraveyard(g, 1000);
    const buffered = gateEventDispatch('messageCreate', event(g), ran);
    expect(await restoring).toEqual({ ok: false, code: 'io-error', error: 'the restore stopped on an error in the bot (lookup failed); nothing was restored; see the bot log' });
    expect(await buffered).toBe(false);
    expect(ran).toHaveBeenCalledTimes(1);
    expect(guildDataOpOf(g)).toBeUndefined();
    expect(gateCauseNow(g, performance.now())).toBe('admit');
  });
});

describe('the file sweep', () => {
  it('a partly swept entry is never restored, and the next sweep removes the residue', async () => {
    const g = freshGuild();
    bury(g, 1000, { 'm/a.json': '{"a":1}', 'm/b.json': '{"b":1}' });
    const rm = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, 'rm').mockImplementation((async (p: any) => {
      fs.rmSync(path.join(String(p), 'm', 'a.json'), { force: true });
      throw errno('EBUSY');
    }) as any);
    await sweepFiles();
    expect(await listed(g)).toEqual([]);
    expect(await restoreGuildFromGraveyard(g, 1000)).toEqual({ ok: false, code: 'invalid', error: NO_ENTRY });
    vi.mocked(fs.promises.rm).mockImplementation(rm as any);
    await sweepFiles();
    expect(fs.readdirSync(dataPath('_graveyard')).filter(n => n.includes(g))).toEqual([]);
  });

  it('a sweep while the guild is under restore skips its entry, and the restore moves every file', async () => {
    const g = freshGuild();
    bury(g, 1000, { 'm/a.json': '{"a":1}', 'm/b.json': '{"b":1}' });
    const lookup = deferred();
    const readdir = fs.promises.readdir.bind(fs.promises);
    let held = true;
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: any[]) => {
      if (held && same(args[0], dataPath('_graveyard'))) {
        held = false;
        await lookup.promise;
      }
      return (readdir as any)(...args);
    }) as any);
    const restoring = restoreGuildFromGraveyard(g);
    await tick();
    await sweepGraveyard();
    expect(fs.existsSync(entryDir(g, 1000))).toBe(true);
    lookup.resolve();
    expect(await restoring).toMatchObject({ ok: true, retiredAt: 1000 });
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"a":1}');
    expect(fs.readFileSync(dataPath(g, 'm', 'b.json'), 'utf8')).toBe('{"b":1}');
  });

  it('the sweep\'s rename first, the restore\'s second: no entry', async () => {
    const g = freshGuild();
    bury(g, 1000);
    const rm = deferred();
    vi.spyOn(fs.promises, 'rm').mockImplementation((async () => { await rm.promise; }) as any);
    const sweeping = sweepFiles();
    await vi.waitFor(() => expect(fs.existsSync(entryDir(g, 1000))).toBe(false));
    expect(await restoreGuildFromGraveyard(g, 1000)).toEqual({ ok: false, code: 'invalid', error: NO_ENTRY });
    rm.resolve();
    await sweeping;
  });
});

describe('maintenance, exit and the deadline during the lookup or the stamp', () => {
  /** Runs after each stamp temp file of g's entry at ms is opened. */
  function afterStampOpen(g: string, ms: number, then: () => Promise<void> | void): void {
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      const fh = await (open as any)(p, ...rest);
      if (same(path.dirname(String(p)), entryDir(g, ms)) && String(p).endsWith('.tmp')) await then();
      return fh;
    }) as any);
  }

  it('the gate closed during the lookup refuses; closed during the stamp refuses at the copy and keeps the entry', async () => {
    const g = freshGuild();
    bury(g, 1000);
    const lookup = deferred();
    const readdir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementationOnce((async (...args: any[]) => {
      await lookup.promise;
      return (readdir as any)(...args);
    }) as any);
    const restoring = restoreGuildFromGraveyard(g);
    await tick();
    setMaintenanceGate({ cause: 'hook', message: 'down' });
    lookup.resolve();
    expect(await restoring.catch(e => e.causeKey)).toBe('maintenance');
    expect(fs.existsSync(dataPath(g))).toBe(false);
    setMaintenanceGate(null);

    afterStampOpen(g, 1000, () => setMaintenanceGate({ cause: 'hook', message: 'down' }));
    expect(await restoreGuildFromGraveyard(g, 1000).catch(e => e.causeKey)).toBe('maintenance');
    expect(await listed(g)).toEqual([{ guildId: g, retiredAt: 1000, reason: 'webui-operator-delete' }]);
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });

  it('the deadline passing during the lookup refuses and moves nothing', async () => {
    const g = freshGuild();
    bury(g, 1000);
    const release = holdLookup();
    const restoring = restoreGuildFromGraveyard(g, undefined, monoIn(50));
    await tick(80);
    release();
    expect(await restoring).toEqual({ ok: false, code: 'backend-unavailable', error: OUT_OF_TIME });
    await expectEntryKept(g, 1000);
    expect(guildDataOpOf(g)).toBeUndefined();
  });

  it('a deadline that leaves the copy less than 5 s refuses at the copy and keeps the entry', async () => {
    const g = freshGuild();
    bury(g, 1000);
    afterStampOpen(g, 1000, () => tick(80));
    expect(await restoreGuildFromGraveyard(g, 1000, monoIn(50))).toEqual({ ok: false, code: 'backend-unavailable', error: "entry 1000 could not be copied before the restore's deadline (0 file(s) copied); nothing was restored" });
    expect(await listed(g)).toEqual([{ guildId: g, retiredAt: 1000, reason: 'webui-operator-delete' }]);
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });
});

describe('restore and delete on JSON', () => {
  it('a restore during a delete is refused, and no note lands in a live folder', async () => {
    const g = freshGuild();
    saveData('a.json', opts(g), { a: 1 });
    await flushAll();
    bury(g, 1000);
    const note = deferred();
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (path.basename(String(p)).startsWith('.graveyard.json.')) await note.promise;
      return (open as any)(p, ...rest);
    }) as any);
    const deleting = deleteGuildNamespace(g, 'test', 5000);
    await vi.waitFor(() => expect(fs.existsSync(dataPath(g))).toBe(false));
    expect(await restoreGuildFromGraveyard(g, 1000)).toEqual({ ok: false, code: 'invalid', error: DELETE_RUNNING });
    note.resolve();
    expect(await deleting).toEqual({ ok: true });
    expect(fs.existsSync(dataPath(g, '.graveyard.json'))).toBe(false);
  });

  it('interactions are held during a JSON delete', async () => {
    const g = freshGuild();
    saveData('a.json', opts(g), { a: 1 });
    await flushAll();
    const open = fs.promises.open.bind(fs.promises);
    const wire = deferred();
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).includes(`${path.sep}${g}${path.sep}`)) await wire.promise;
      return (open as any)(p, ...rest);
    }) as any);
    saveData('b.json', opts(g), { b: 1 });
    const deleting = deleteGuildNamespace(g, 'test', 5000);
    expect(guildDataOpOf(g)).toBe('delete');
    expect(gateCauseNow(g, performance.now())).toBe('loading');
    wire.resolve();
    expect(await deleting).toEqual({ ok: true });
    expect(gateCauseNow(g, performance.now())).toBe('admit');
    const [entry] = await listed(g);
    expect(JSON.parse(fs.readFileSync(path.join(entryDir(g, entry.retiredAt), 'm', 'b.json'), 'utf8'))).toEqual({ b: 1 });
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });

  it('a save during the delete\'s flush is refused, and no ticket answers unavailable', async () => {
    const g = freshGuild();
    const before = saveDataTracked('a.json', opts(g), { a: 1 });
    const open = fs.promises.open.bind(fs.promises);
    const wire = deferred();
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).includes(`${path.sep}${g}${path.sep}`)) await wire.promise;
      return (open as any)(p, ...rest);
    }) as any);
    fs.mkdirSync(dataPath(g), { recursive: true });
    const deleting = deleteGuildNamespace(g, 'test', 5000);
    await tick(20);
    expect(saveDataTracked('b.json', opts(g), { b: 1 })).toEqual({ outcome: 'refused', cause: 'not-ready' });
    wire.resolve();
    expect(await deleting).toEqual({ ok: true });
    expect(await confirmWrite((before as { ticket: WriteTicket }).ticket, 0)).toBe('ok');
  });

  it.each([['ENOSPC', 'open'], ['EPERM', 'rename']] as const)('a delete keeps a write whose flush keeps failing (%s)', async (code, call) => {
    const g = freshGuild();
    saveData('seed.json', opts(g), { s: 1 });
    await flushAll();
    const target = dataPath(g, 'm', 'a.json');
    const real = (fs.promises as any)[call].bind(fs.promises);
    vi.spyOn(fs.promises, call as 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (call === 'open' ? String(p).startsWith(`${target}.`) : same(rest[0], target)) throw errno(code);
      return real(p, ...rest);
    }) as any);
    const saved = saveDataTracked('a.json', opts(g), { a: 1 });
    expect(await deleteGuildNamespace(g, 'test', 5000)).toEqual({ ok: false, code: 'backend-unavailable', error: failingText('m/a.json', code) });
    expect(fs.existsSync(dataPath(g))).toBe(true);
    expect(await listed(g)).toEqual([]);
    expect(await confirmWrite((saved as { ticket: WriteTicket }).ticket, 0)).not.toBe('unavailable');
    vi.restoreAllMocks();
    await flushAll();
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ a: 1 });
  }, 20_000);

  it('a delete whose graveyard rename keeps failing removes nothing and drops nothing', async () => {
    const g = freshGuild();
    const saved = saveDataTracked('a.json', opts(g), { a: 1 });
    await flushAll();
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (same(from, dataPath(g))) throw errno('EPERM');
      return rename(from, to);
    }) as any);
    expect(await deleteGuildNamespace(g, 'test', 5000)).toEqual({ ok: false, code: 'io-error', error: 'guild data delete failed; nothing was removed' });
    expect(await confirmWrite((saved as { ticket: WriteTicket }).ticket, 0)).toBe('ok');
    expect(fs.existsSync(dataPath(g, 'm', 'a.json'))).toBe(true);
  });

  it('a JSON delete stops at its deadline and at the maintenance gate', async () => {
    const g = freshGuild();
    saveData('a.json', opts(g), { a: 1 });
    await flushAll();
    const open = fs.promises.open.bind(fs.promises);
    const wire = deferred();
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).includes(`${path.sep}${g}${path.sep}`)) await wire.promise;
      return (open as any)(p, ...rest);
    }) as any);
    saveData('b.json', opts(g), { b: 1 });
    const deleting = deleteGuildNamespace(g, 'test', 5000, monoIn(50));
    await tick(100);
    wire.resolve();
    expect(await deleting).toEqual({ ok: false, code: 'backend-unavailable', error: DELETE_OUT_OF_TIME });
    expect(fs.existsSync(dataPath(g, 'm', 'a.json'))).toBe(true);
    vi.restoreAllMocks();

    const rename = fs.promises.rename.bind(fs.promises);
    let tries = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (!same(from, dataPath(g))) return rename(from, to);
      tries += 1;
      await tick(80);
      throw errno('EPERM');
    }) as any);
    expect(await deleteGuildNamespace(g, 'test', 5000, monoIn(50))).toEqual({ ok: false, code: 'backend-unavailable', error: DELETE_OUT_OF_TIME });
    expect(tries).toBe(1);

    tries = 0;
    vi.mocked(fs.promises.rename).mockImplementation((async (from: any, to: any) => {
      if (!same(from, dataPath(g))) return rename(from, to);
      tries += 1;
      setMaintenanceGate({ cause: 'hook', message: 'down' });
      throw errno('EPERM');
    }) as any);
    expect(await deleteGuildNamespace(g, 'test', 5000).catch(e => e.causeKey)).toBe('maintenance');
    expect(tries).toBe(1);
    expect(fs.existsSync(dataPath(g, 'm', 'a.json'))).toBe(true);
  });

  it('a delete with no recorded failure but an op still queued answers the flush text', async () => {
    const g = freshGuild();
    saveData('a.json', opts(g), { a: 1 });
    await flushAll();
    const flushing = deleteGuildNamespace(g, 'test', 5000);
    enqueueWrite(dataPath(g, 'm', 'late.json'), '{}');
    expect(await flushing).toEqual({ ok: false, code: 'backend-unavailable', error: DELETE_FLUSH });
    expect(fs.existsSync(dataPath(g))).toBe(true);
  });
});

describe('the barrier on JSON (decision 17)', () => {
  const BARRIER_LINE = "it comes from a command that started before the server's data was restored from the graveyard";
  /** A run opened in an interaction ledger that reads a.json, waits for gate, then tries each kind of write. */
  function olderRun(g: string, gate: Promise<void>) {
    return runInLedger(openLedger('interaction'), 'm', async () => {
      const before = loadData('a.json', opts(g), { n: 0 });
      await gate;
      return {
        before,
        save: saveDataTracked('a.json', opts(g), { n: 1 }),
        update: updateData('a.json', opts(g), { n: 0 }, (current: { n: number }) => ({ n: current.n + 1 })),
        del: deleteDataTracked('a.json', opts(g)),
        append: appendDataTracked('l.jsonl', opts(g), 'x\n'),
      };
    });
  }

  it('a command that read before a JSON restore cannot save over it', async () => {
    const g = freshGuild();
    bury(g, 1000);
    const gate = deferred();
    const running = olderRun(g, gate.promise);
    expect(await restoreGuildFromGraveyard(g, 1000)).toEqual({ ok: true, retiredAt: 1000, reason: 'webui-operator-delete', keptUntil: expect.any(Number) });
    warn.mockClear();
    gate.resolve();
    const r = await running;
    expect(r.before).toEqual({ n: 0 });
    expect(r.save).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(r.update).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(r.del).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(r.append).toEqual({ outcome: 'refused', cause: 'not-ready' });
    const lines = warn.mock.calls.map((c: unknown[]) => String(c[0]));
    for (const what of ['Write', 'Update', 'Delete', 'Append']) expect(lines).toContain(`[Data] ${what} for guild ${g} refused: ${BARRIER_LINE}`);
    await flushAll();
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
    expect(fs.existsSync(dataPath(g, 'm', 'l.jsonl'))).toBe(false);
    const later = runInLedger(openLedger('interaction'), 'm', () => saveDataTracked('a.json', opts(g), { n: 6 }));
    expect(later.outcome).toBe('saved');
    await flushAll();
    expect(JSON.parse(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8'))).toEqual({ n: 6 });
  });

  it.each([
    ['a live folder', (g: string) => { fs.mkdirSync(dataPath(g), { recursive: true }); }, (g: string) => liveReply(g, 1000)],
    ['a rename that keeps failing', (g: string) => {
      const rename = fs.promises.rename.bind(fs.promises);
      vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
        if (path.basename(String(from)).startsWith(`.restore-${g}-`) && same(to, dataPath(g))) throw errno('EPERM');
        return rename(from, to);
      }) as any);
    }, () => ({ ok: false, code: 'io-error', error: 'the copy of entry 1000 could not be put in place (EPERM); nothing was restored; try again in a moment' })],
  ] as const)('a JSON restore refused before the rename (%s) takes no barrier: the older run saves', async (_name, prepare, answer) => {
    const g = freshGuild();
    bury(g, 1000);
    prepare(g);
    const gate = deferred();
    const running = olderRun(g, gate.promise);
    expect(await restoreGuildFromGraveyard(g, 1000)).toEqual(answer(g));
    vi.restoreAllMocks();
    gate.resolve();
    const r = await running;
    expect(r.save.outcome).toBe('saved');
    expect(r.update.outcome).toBe('saved');
    expect(r.del.outcome).toBe('deleted');
    await flushAll();
    expect(fs.existsSync(dataPath(g, 'm', 'a.json'))).toBe(false);
    expect(fs.readFileSync(path.join(entryDir(g, 1000), 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
  });
});

describe('raw writes under a held guild (decision 1)', () => {
  const posix = (p: string) => p.split(path.sep).join('/');
  /** Raw writes and deletes under g's folder inside a panel ledger: each answer, and the ledger's refusals. */
  function rawTries(g: string) {
    const ledger = openLedger('panel');
    const answers = runInLedger(ledger, 'm', () => [
      writeRawAtomic(dataPath(g, 'm', 'r.json'), '{}'),
      writeRawAtomic(`${posix(dataPath(g))}/m/s.json`, '{}'),
      deleteRawAtomic(dataPath(g, 'm', 'a.json')),
    ]);
    return { answers, refused: ledger.refusedDocs().map(r => [r.cause, r.doc]) };
  }
  const refusedDocs = (g: string) => [
    ['not-ready', `file:${dataPath(g, 'm', 'r.json')}`],
    ['not-ready', `file:${posix(dataPath(g))}/m/s.json`],
    ['not-ready', `file:${dataPath(g, 'm', 'a.json')}`],
  ];

  it('during a JSON restore: refused, nothing queued, and the restored folder holds only the entry\'s files', async () => {
    const g = freshGuild();
    bury(g, 1000);
    const release = holdLookup();
    const restoring = restoreGuildFromGraveyard(g, 1000);
    expect(guildDataOpOf(g)).toBe('restore');
    const { answers, refused } = rawTries(g);
    expect(answers).toEqual([false, false, false]);
    expect(refused).toEqual(refusedDocs(g));
    expect(guildHasQueuedOps(g)).toBe(false);
    expect(fs.existsSync(dataPath(g))).toBe(false);
    release();
    expect(await restoring).toEqual({ ok: true, retiredAt: 1000, reason: 'webui-operator-delete', keptUntil: expect.any(Number) });
    await flushAll();
    expect(fs.readdirSync(dataPath(g, 'm'))).toEqual(['a.json']);
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
  });

  it('during a JSON delete held in its flush: refused, and the entry holds the guild\'s files with no live folder left', async () => {
    const g = freshGuild();
    saveData('a.json', opts(g), { a: 1 });
    await flushAll();
    const open = fs.promises.open.bind(fs.promises);
    const wire = deferred();
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).includes(`${path.sep}${g}${path.sep}`)) await wire.promise;
      return (open as any)(p, ...rest);
    }) as any);
    saveData('b.json', opts(g), { b: 1 });
    const deleting = deleteGuildNamespace(g, 'test', 5000);
    expect(guildDataOpOf(g)).toBe('delete');
    const { answers, refused } = rawTries(g);
    expect(answers).toEqual([false, false, false]);
    expect(refused).toEqual(refusedDocs(g));
    wire.resolve();
    expect(await deleting).toEqual({ ok: true });
    await flushAll();
    expect(fs.existsSync(dataPath(g))).toBe(false);
    const [entry] = await listed(g);
    expect(fs.readdirSync(path.join(entryDir(g, entry.retiredAt), 'm')).sort()).toEqual(['a.json', 'b.json']);
    expect(JSON.parse(fs.readFileSync(path.join(entryDir(g, entry.retiredAt), 'm', 'a.json'), 'utf8'))).toEqual({ a: 1 });
  });
});

describe.skipIf(process.platform === 'win32')('the directories are fsynced before the answer', () => {
  it('for a restore and for a delete each directory is synced once before the answer, and a sync that throws still answers ok, naming the unconfirmed move', async () => {
    const synced = new Map<string, number>();
    let hold: ReturnType<typeof deferred<void>> | null = null;
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags?: any, ...rest: any[]) => {
      const handle = await (open as any)(p, flags, ...rest);
      if (flags === 'r' && (same(p, dataPath()) || same(p, dataPath('_graveyard')))) {
        const dir = path.resolve(String(p));
        handle.sync = async () => {
          synced.set(dir, (synced.get(dir) ?? 0) + 1);
          if (hold) await hold.promise;
          throw errno('EIO');
        };
      }
      return handle;
    }) as any);
    const once = new Map([[path.resolve(dataPath()), 1], [path.resolve(dataPath('_graveyard')), 1]]);
    const g = freshGuild();
    bury(g, 1000);
    const d = freshGuild();
    saveData('a.json', opts(d), { a: 1 });
    await flushAll();
    const runs: [string, () => Promise<unknown>, unknown][] = [
      ['restore', () => restoreGuildFromGraveyard(g, 1000), { ok: false, code: 'io-error', error: 'the disk did not confirm the copy of entry 1000 (EIO); nothing was restored; check the disk, then try again' }],
      ['delete', () => deleteGuildNamespace(d, 'test', 5000), { ok: true, moveUnconfirmed: 'EIO' }],
    ];
    for (const [, run, expected] of runs) {
      synced.clear();
      const held = deferred();
      hold = held;
      let answered = false;
      const answer = run().then(value => { answered = true; return value; });
      await vi.waitFor(() => expect(synced.size).toBe(1));
      await tick(20);
      expect(answered).toBe(false);
      hold = null;
      held.resolve();
      expect(await answer).toEqual(expected);
      expect(synced).toEqual(once);
    }
    expect(fs.existsSync(dataPath(g))).toBe(false);
    expect((await listed(g)).length).toBe(1);
  });
});

describe('the state x exit table (JSON cells)', () => {
  it.each([
    ['J1 no entry', (_g: string) => {}, NO_ENTRY],
    ['J1 a live folder', (g: string) => { bury(g, 1000); fs.mkdirSync(dataPath(g), { recursive: true }); }, null],
  ] as const)('%s', async (_name, prepare, error) => {
    const g = freshGuild();
    prepare(g);
    expect(await restoreGuildFromGraveyard(g, 1000)).toEqual(error === null ? liveReply(g, 1000) : { ok: false, code: 'invalid', error });
    expect(guildDataOpOf(g)).toBeUndefined();
    if (error !== NO_ENTRY) {
      expect(await listed(g)).toEqual([{ guildId: g, retiredAt: 1000, reason: 'webui-operator-delete' }]);
      expect(fs.readdirSync(dataPath(g))).toEqual([]);
    }
  });

  it('J0 maintenance: refused before anything', async () => {
    const g = freshGuild();
    bury(g, 1000);
    setMaintenanceGate({ cause: 'hook', message: 'down' });
    expect(await restoreGuildFromGraveyard(g, 1000).catch(e => e.causeKey)).toBe('maintenance');
    await expectEntryKept(g, 1000);
  });

  it('J0 the deadline already passed: out-of-time, nothing moved', async () => {
    const g = freshGuild();
    bury(g, 1000);
    expect(await restoreGuildFromGraveyard(g, 1000, process.hrtime.bigint() - 1n)).toEqual({ ok: false, code: 'backend-unavailable', error: OUT_OF_TIME });
    await expectEntryKept(g, 1000);
  });

  it('J0 resume and J1 delete of G: a second restore and a delete during the lookup are refused; the first restore completes', async () => {
    const g = freshGuild();
    bury(g, 1000);
    const release = holdLookup();
    const restoring = restoreGuildFromGraveyard(g);
    expect(await restoreGuildFromGraveyard(g)).toEqual({ ok: false, code: 'invalid', error: ALREADY });
    expect(await deleteGuildNamespace(g, 'test', 5000)).toEqual({ ok: false, code: 'invalid', error: RESTORE_RUNNING });
    release();
    expect(await restoring).toEqual({ ok: true, retiredAt: 1000, reason: 'webui-operator-delete', keptUntil: expect.any(Number) });
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
    expect(await listed(g)).toEqual([{ guildId: g, retiredAt: 1000, reason: 'webui-operator-delete' }]);
  });

  it('K2 delete of G: a delete during the stamp is refused; the restore completes without the note', async () => {
    const g = freshGuild();
    bury(g, 1000);
    const stamp = holdStamp(g, 1000);
    const restoring = restoreGuildFromGraveyard(g, 1000);
    await stamp.reached;
    expect(await deleteGuildNamespace(g, 'test', 5000)).toEqual({ ok: false, code: 'invalid', error: RESTORE_RUNNING });
    stamp.release();
    expect(await restoring).toMatchObject({ ok: true, retiredAt: 1000 });
    expect(fs.readdirSync(dataPath(g)).sort()).toEqual(['m']);
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
  });

  it('K5 maintenance read before a rename try: refused, nothing moved', async () => {
    const g = freshGuild();
    bury(g, 1000);
    const rename = fs.promises.rename.bind(fs.promises);
    let tries = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (!isPut(g)(from, to)) return rename(from, to);
      tries += 1;
      setMaintenanceGate({ cause: 'hook', message: 'down' });
      throw errno('EPERM');
    }) as any);
    expect(await restoreGuildFromGraveyard(g, 1000).catch(e => e.causeKey)).toBe('maintenance');
    expect(tries).toBe(1);
    setMaintenanceGate(null);
    await expectEntryKept(g, 1000);
  });

  it('K5 the deadline read before a rename try: out-of-time, nothing moved', async () => {
    const g = freshGuild();
    bury(g, 1000);
    const realBig = process.hrtime.bigint;
    let offset = 0n;
    vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => realBig() + offset);
    const rename = fs.promises.rename.bind(fs.promises);
    let tries = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (!isPut(g)(from, to)) return rename(from, to);
      tries += 1;
      offset += 41_000_000_000n;
      throw errno('EPERM');
    }) as any);
    expect(await restoreGuildFromGraveyard(g, 1000)).toEqual({ ok: false, code: 'backend-unavailable', error: OUT_OF_TIME });
    expect(tries).toBe(1);
    await expectEntryKept(g, 1000);
  });

  it('K5 delete of G: a delete during the rename is refused; the restore completes', async () => {
    const g = freshGuild();
    bury(g, 1000);
    const gate = deferred();
    const reached = deferred();
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (isPut(g)(from, to)) {
        reached.resolve();
        await gate.promise;
      }
      return rename(from, to);
    }) as any);
    const restoring = restoreGuildFromGraveyard(g, 1000);
    await reached.promise;
    expect(await deleteGuildNamespace(g, 'test', 5000)).toEqual({ ok: false, code: 'invalid', error: RESTORE_RUNNING });
    gate.resolve();
    expect(await restoring).toMatchObject({ ok: true });
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
  });

  it('K6 then a restore again: live data naming the entry, which stays listed', async () => {
    const g = freshGuild();
    bury(g, 1000);
    expect(await restoreGuildFromGraveyard(g, 1000)).toMatchObject({ ok: true });
    expect(await restoreGuildFromGraveyard(g, 1000)).toEqual(liveReply(g, 1000));
    bury(g, 500, { 'm/old.json': '{"o":1}' });
    expect(await restoreGuildFromGraveyard(g)).toEqual(liveReply(g, 1000));
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
    expect(fs.existsSync(dataPath(g, 'm', 'old.json'))).toBe(false);
    expect(await listed(g)).toEqual([{ guildId: g, retiredAt: 1000, reason: 'webui-operator-delete' }, { guildId: g, retiredAt: 500, reason: 'webui-operator-delete' }]);
  });

  it('K6 then a delete: runs as any delete and moves the restored files to a new graveyard entry', async () => {
    const g = freshGuild();
    bury(g, 1000);
    expect(await restoreGuildFromGraveyard(g, 1000)).toMatchObject({ ok: true });
    expect(await deleteGuildNamespace(g, 'test', 5000)).toEqual({ ok: true });
    const [entry] = await listed(g);
    expect(entry.reason).toBe('test');
    expect(fs.readFileSync(path.join(entryDir(g, entry.retiredAt), 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });
});

// Last: the exit drain closes the facade for the rest of this file.
describe('the exit', () => {
  it('the exit drain during the lookup or the stamp refuses node-stopping; nothing moved', async () => {
    const a = freshGuild();
    const b = freshGuild();
    bury(a, 1000);
    bury(b, 1000);
    const stamp = holdStamp(b, 1000);
    const releaseLookup = holdLookup();
    const duringStamp = restoreGuildFromGraveyard(b, 1000).catch(e => e);
    await stamp.reached;
    const duringLookup = restoreGuildFromGraveyard(a).catch(e => e);
    await drainForExit(200);
    releaseLookup();
    stamp.release();
    for (const thrown of [await duringLookup, await duringStamp]) {
      expect(thrown.causeKey).toBe('node-stopping');
      expect(thrown.message).toBe(NODE_STOPPING);
    }
    await expectEntryKept(a, 1000);
    await expectEntryKept(b, 1000);
    expect(guildDataOpOf(a)).toBeUndefined();
    expect(guildDataOpOf(b)).toBeUndefined();
  });

  it('a restore after the exit drain closed the facade is refused node-stopping and moves nothing', async () => {
    const g = freshGuild();
    bury(g, 1000);
    await drainForExit(200);
    const thrown: any = await restoreGuildFromGraveyard(g, 1000).catch(e => e);
    expect(thrown.causeKey).toBe('node-stopping');
    await expectEntryKept(g, 1000);
  });
});
