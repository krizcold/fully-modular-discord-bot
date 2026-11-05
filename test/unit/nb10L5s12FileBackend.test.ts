import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelQueued, droppedByDeposition, dropPendingForGuild, enqueueAppend, enqueueDelete, enqueueWrite, fileTicket, flushAll,
  flushFailing, graveyardGuildDir, listGraveyardEntries, restoreGuildDirFromGraveyard, writeRawAtomic,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';

// NB10 file queue: an append starts on its own line, a failed flush names its errno until one lands, a deposition's
// cancel holds every flush of its paths and drops no write queued after it, and the graveyard moves keep their texts.

let n = 0;
const fresh = (ext = 'json') => dataPath('global', 'nb10l5s12', `f${++n}.${ext}`);
const freshIn = (dir: string) => dataPath('global', 'nb10l5s12', dir, `f${++n}.json`);
const realOpen = fs.promises.open.bind(fs.promises);
const realMkdir = fs.promises.mkdir.bind(fs.promises);
const read = (p: string) => fs.readFileSync(p, 'utf8');

/** The flush's mkdir of this dir fails with the given error while `on.fail` holds. */
function failMkdir(dir: string, error: () => unknown): { fail: boolean } {
  const on = { fail: true };
  vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (d: fs.PathLike, ...rest: any[]) => {
    if (on.fail && String(d) === dir) throw error();
    return (realMkdir as any)(d, ...rest);
  }) as typeof fs.promises.mkdir);
  return on;
}

/** The first flush mkdir of this dir waits on the gate: its flush stays on the wire until release. */
function holdFirstFlush(dir: string): { entered: Promise<void>; release: () => void } {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (d: fs.PathLike, ...rest: any[]) => {
    if (first && String(d) === dir) {
      first = false;
      enter();
      await gate;
    }
    return (realMkdir as any)(d, ...rest);
  }) as typeof fs.promises.mkdir);
  return { entered, release };
}

beforeEach(() => {
  fs.mkdirSync(dataPath('global', 'nb10l5s12'), { recursive: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await flushAll();
});

describe('an append and the last byte of its file', () => {
  it('a last-byte read refused with EACCES appends nothing and keeps the append queued with that errno', async () => {
    const p = fresh('jsonl');
    fs.writeFileSync(p, 'a');
    vi.spyOn(fs.promises, 'open').mockImplementation(((pp: fs.PathLike, flags?: any, ...rest: any[]) => {
      if (String(pp) === p && flags === 'r') return Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
      return (realOpen as any)(pp, flags, ...rest);
    }) as typeof fs.promises.open);
    enqueueAppend(p, 'b\n');
    await flushAll();
    expect(read(p)).toBe('a');
    expect(await cancelQueued([p])).toEqual([{ path: p, outcome: 'cancelled', errno: 'EACCES' }]);
  });

  it('closes the handle it read the last byte through', async () => {
    const p = fresh('jsonl');
    fs.writeFileSync(p, 'a\n');
    const handles: fs.promises.FileHandle[] = [];
    vi.spyOn(fs.promises, 'open').mockImplementation((async (pp: fs.PathLike, flags?: any, ...rest: any[]) => {
      const h = await (realOpen as any)(pp, flags, ...rest);
      if (String(pp) === p && flags === 'r') handles.push(h);
      return h;
    }) as typeof fs.promises.open);
    enqueueAppend(p, 'b\n');
    await flushAll();
    try {
      expect(read(p)).toBe('a\nb\n');
      expect(handles).toHaveLength(1);
      expect(handles[0].fd).toBe(-1);
    } finally {
      for (const h of handles) if (h.fd !== -1) await h.close();
    }
  });

  it('an append whose own text ends without a newline puts the next append on its own line', async () => {
    const p = fresh('jsonl');
    enqueueAppend(p, 'a');
    await flushAll();
    expect(read(p)).toBe('a');
    enqueueAppend(p, 'b\n');
    await flushAll();
    expect(read(p)).toBe('a\nb\n');
  });

  it('after a whole-file write that ends without a newline, the next append starts on its own line', async () => {
    const p = fresh('jsonl');
    enqueueAppend(p, 'a\n');
    await flushAll();
    expect(writeRawAtomic(p, 'x')).toBe(true);
    await flushAll();
    expect(read(p)).toBe('x');
    enqueueAppend(p, 'b\n');
    await flushAll();
    expect(read(p)).toBe('x\nb\n');
  });

  it('a delete dropped before it ran forgets the tail: a guild dir restored from the graveyard gets its append on its own line', async () => {
    const G = '424242000000001201';
    const p = dataPath(G, 'x.jsonl');
    fs.mkdirSync(dataPath(G), { recursive: true });
    fs.writeFileSync(p, 'old');
    expect(await graveyardGuildDir(G, 'first')).toBe(true);
    const [entry] = (await listGraveyardEntries()).filter(e => e.guildId === G);
    enqueueAppend(p, 'a\n');
    await flushAll();
    expect(read(p)).toBe('a\n');
    enqueueDelete(p);
    dropPendingForGuild(G);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await graveyardGuildDir(G, 'second')).toBe(true);
    expect(fs.existsSync(dataPath(G))).toBe(false);
    expect(await restoreGuildDirFromGraveyard(G, entry.retiredAt, { stop: () => null, writerLost: () => false, progress: { renamed: false } })).toMatchObject({ ok: true, retiredAt: entry.retiredAt });
    expect(read(p)).toBe('old');
    enqueueAppend(p, 'b\n');
    await flushAll();
    expect(read(p)).toBe('old\nb\n');
  });
});

describe('the errno of a failed flush', () => {
  it('is EIO for a failure that carries no code', async () => {
    const p = freshIn('nocode');
    failMkdir(path.dirname(p), () => new Error('injected failure with no code'));
    enqueueWrite(p, 'x');
    await flushAll();
    expect(fs.existsSync(p)).toBe(false);
    expect(await cancelQueued([p])).toEqual([{ path: p, outcome: 'cancelled', errno: 'EIO' }]);
  });

  it('is forgotten once a later flush lands: a later cancel names no errno', async () => {
    const p = freshIn('relands');
    const on = failMkdir(path.dirname(p), () => Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }));
    enqueueWrite(p, 'x');
    await flushAll();
    expect(fs.existsSync(p)).toBe(false);
    on.fail = false;
    await flushAll();
    expect(read(p)).toBe('x');
    enqueueWrite(p, 'y');
    expect(await cancelQueued([p])).toEqual([{ path: p, outcome: 'cancelled', errno: null }]);
    expect(read(p)).toBe('x');
  });

  it('a cancel ends the retry of a failing path', async () => {
    const p = freshIn('retry');
    failMkdir(path.dirname(p), () => Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }));
    enqueueWrite(p, 'x');
    await flushAll();
    expect(flushFailing([p])).toBe(true);
    expect(await cancelQueued([p])).toEqual([{ path: p, outcome: 'cancelled', errno: 'ENOSPC' }]);
    expect(flushFailing([p])).toBe(false);
  });
});

describe('a deposition cancel (freeze)', () => {
  it('a ticket taken after the cancel is not marked dropped, and its write lands', async () => {
    const p = fresh();
    enqueueWrite(p, 'a');
    const t1 = fileTicket(p);
    expect(await cancelQueued([p], undefined, { freeze: true })).toEqual([{ path: p, outcome: 'cancelled', errno: null }]);
    expect(droppedByDeposition(t1.record)).toBe(true);
    enqueueWrite(p, 'b');
    const t2 = fileTicket(p);
    expect(droppedByDeposition(t2.record)).toBe(false);
    await flushAll();
    expect(read(p)).toBe('b');
  });

  it('starts no new flush of a path on the wire: a write queued meanwhile is cancelled, never written', async () => {
    const p = freshIn('wire');
    const gate = holdFirstFlush(path.dirname(p));
    enqueueWrite(p, 'first');
    await gate.entered;
    const cancel = cancelQueued([p], undefined, { freeze: true });
    enqueueWrite(p, 'second');
    gate.release();
    expect(await cancel).toEqual([{ path: p, outcome: 'cancelled', errno: null }]);
    expect(read(p)).toBe('first');
  });

  it('a second freeze of a path already held leaves it held for the first', async () => {
    const p = freshIn('nested');
    const gate = holdFirstFlush(path.dirname(p));
    enqueueWrite(p, 'first');
    await gate.entered;
    let wakeOuter: (() => void) | null = null;
    let outerSleeps = 0;
    const outerSleep = (ms: number) => {
      outerSleeps++;
      if (outerSleeps === 1) return new Promise<void>(resolve => { wakeOuter = resolve; });
      return new Promise<void>(resolve => setTimeout(resolve, ms));
    };
    const outer = cancelQueued([p], outerSleep, { freeze: true });
    const inner = cancelQueued([p], undefined, { freeze: true });
    gate.release();
    expect(await inner).toEqual([{ path: p, outcome: 'landed' }]);
    enqueueWrite(p, 'second');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(read(p)).toBe('first');
    wakeOuter!();
    expect(await outer).toEqual([{ path: p, outcome: 'cancelled', errno: null }]);
    expect(read(p)).toBe('first');
  });

  it('a path not on the wire is cancelled at once, so a write queued after the call stays queued and lands', async () => {
    const p = freshIn('heldA');
    const q = freshIn('heldB');
    const gate = holdFirstFlush(path.dirname(p));
    enqueueWrite(p, 'p1');
    await gate.entered;
    enqueueWrite(q, 'q1');
    const cancel = cancelQueued([p, q], undefined, { freeze: true });
    enqueueWrite(q, 'q2');
    gate.release();
    expect(await cancel).toEqual([{ path: p, outcome: 'landed' }, { path: q, outcome: 'cancelled', errno: null }]);
    await flushAll();
    expect(read(p)).toBe('p1');
    expect(read(q)).toBe('q2');
  });
});

describe('the graveyard moves', () => {
  it('moves a guild dir by default, and refuses with its log line when another process took the data files', async () => {
    const G = '424242000000001202';
    fs.mkdirSync(dataPath(G), { recursive: true });
    fs.writeFileSync(dataPath(G, 'a.json'), '{"a":1}');
    const errors = vi.mocked(console.error);
    expect(await graveyardGuildDir(G, 'nb10', () => true)).toBe(false);
    expect(errors).toHaveBeenCalledWith(`[DataManager] Cannot move ${G} to graveyard: another process took the data files; nothing was removed`);
    expect(read(dataPath(G, 'a.json'))).toBe('{"a":1}');
    expect(await graveyardGuildDir(G, 'nb10')).toBe(true);
    expect(fs.existsSync(dataPath(G))).toBe(false);
    const [entry] = (await listGraveyardEntries()).filter(e => e.guildId === G);
    expect(entry.reason).toBe('nb10');
  });

  it('restores, and refuses with its log line when another process took the data files', async () => {
    const G = '424242000000001203';
    fs.mkdirSync(dataPath(G), { recursive: true });
    fs.writeFileSync(dataPath(G, 'a.json'), '{"a":2}');
    expect(await graveyardGuildDir(G, 'nb10')).toBe(true);
    const errors = vi.mocked(console.error);
    expect(await restoreGuildDirFromGraveyard(G, undefined, { stop: () => null, writerLost: () => true, progress: { renamed: false } })).toEqual({ ok: false, why: 'writer-lost' });
    expect(errors).toHaveBeenCalledWith(`[DataManager] Cannot restore guild ${G} from the graveyard: another process took the data files`);
    expect(fs.existsSync(dataPath(G))).toBe(false);
    expect(await restoreGuildDirFromGraveyard(G, undefined, { stop: () => null, writerLost: () => false, progress: { renamed: false } })).toMatchObject({ ok: true, reason: 'nb10' });
    expect(read(dataPath(G, 'a.json'))).toBe('{"a":2}');
  });
});
