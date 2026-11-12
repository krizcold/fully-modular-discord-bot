import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A, chunk 81: the order in which the exit names files whose replaced whole write never had its newer op land,
// and the next flush of an append whose entry a guild drop took while it was on the wire. The folder chain is stubbed
// as in ra36FileBackendChain.test.ts, so its failures reach the same code on Windows as on Linux.

const h = vi.hoisted(() => ({
  chainFail: new Map<string, string[]>(),
  chainHold: new Map<string, { reached: () => void; released: Promise<void> }>(),
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolderChain: async (dir: string) => {
      const at = path.resolve(dir);
      const hold = h.chainHold.get(at);
      if (hold) {
        h.chainHold.delete(at);
        hold.reached();
        await hold.released;
      }
      const errno = h.chainFail.get(at)?.shift();
      if (errno) return { failed: true, kind: 'sync', dir: at, errno, error: Object.assign(new Error(`${errno}: stubbed`), { code: errno }) };
      return { failed: false };
    },
    syncFolder: async () => ({ failed: false }),
  };
});

import {
  confirmFile,
  dropPendingForGuild,
  enqueueAppend,
  enqueueWrite,
  failReplacedTriesAtExit,
  fileTicket,
  flushAll,
  forgetDurableFiles,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { dataPath } from '../../src/utils/dataRoot';

let n = 0;
let dir = '';
let errors: string[];
const releases: Array<() => void> = [];

function failChain(d: string, errno = 'EIO') {
  const at = path.resolve(d);
  h.chainFail.set(at, [...(h.chainFail.get(at) ?? []), errno]);
}

function holdChain(d: string): { reached: Promise<void>; release: () => void } {
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  h.chainHold.set(path.resolve(d), { reached, released });
  releases.push(release);
  return { reached: reachedP, release };
}

const wholeLine = (p: string, d: string) => {
  const { why, next } = syncWords('sync', path.resolve(d), 'EIO');
  return `[Data] ${p}: the file is written whole, but ${why}; it is not written again; can't confirm it is stored. ${next}`;
};

/** A whole write of p whose chain fails while a newer write replaces it; the newer write is left in its chain. */
async function replacedTry(p: string, first: string, second: string) {
  const d = path.dirname(p);
  failChain(d);
  const one = holdChain(d);
  enqueueWrite(p, first);
  await one.reached;
  enqueueWrite(p, second);
  const two = holdChain(d);
  one.release();
  await two.reached;
  return two;
}

beforeEach(() => {
  dir = dataPath('ra81', String(Date.now()), String(++n));
  fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
  h.chainFail.clear();
  h.chainHold.clear();
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  forgetDurableFiles();
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  h.chainFail.clear();
  h.chainHold.clear();
  await flushAll();
  vi.restoreAllMocks();
});

describe('the exit names the files of replaced whole writes in the order their last replaced try came', () => {
  it('a path whose replaced try was answered by a landed write, then replaced again, comes after a path replaced in between', async () => {
    const dA = path.join(dir, 'a');
    const dB = path.join(dir, 'b');
    const pA = path.join(dA, 'w.json');
    const pB = path.join(dB, 'w.json');

    const a2 = await replacedTry(pA, 'A1\n', 'A2\n');
    enqueueWrite(pA, 'A3\n');
    const a3 = holdChain(dA);
    a2.release();
    await a3.reached;

    await replacedTry(pB, 'B1\n', 'B2\n');

    enqueueWrite(pA, 'A4\n');
    failChain(dA);
    const a4 = holdChain(dA);
    a3.release();
    await a4.reached;

    const from = errors.length;
    failReplacedTriesAtExit();
    expect(errors.slice(from)).toEqual([wholeLine(pB, dB), wholeLine(pA, dA)]);
  });

  it('a path whose replaced tries a confirm failed, then replaced again, comes after a path replaced in between', async () => {
    const dA = path.join(dir, 'a');
    const dB = path.join(dir, 'b');
    const pA = path.join(dA, 'w.json');
    const pB = path.join(dB, 'w.json');

    failChain(dA);
    const a1 = holdChain(dA);
    enqueueWrite(pA, 'A1\n');
    const t1 = fileTicket(pA);
    await a1.reached;
    enqueueWrite(pA, 'A2\n');
    const a2 = holdChain(dA);
    a1.release();
    await a2.reached;
    expect(await confirmFile(t1, 30)).toBe('unavailable');
    expect(errors.filter(e => e === wholeLine(pA, dA))).toHaveLength(1);

    await replacedTry(pB, 'B1\n', 'B2\n');

    enqueueWrite(pA, 'A3\n');
    failChain(dA);
    const a3 = holdChain(dA);
    a2.release();
    await a3.reached;

    const from = errors.length;
    failReplacedTriesAtExit();
    expect(errors.slice(from)).toEqual([wholeLine(pB, dB), wholeLine(pA, dA)]);
  });
});

describe('an append whose entry a guild drop took while it was on the wire', () => {
  it('schedules no flush of its own: an append queued after it flushes on the next turn of the loop', async () => {
    const guild = `88000000000000${String(8100 + n)}`;
    const p = dataPath(guild, 'm', 'log.jsonl');
    const folder = path.dirname(p);
    fs.mkdirSync(folder, { recursive: true });
    const realMkdir = fs.promises.mkdir.bind(fs.promises);
    let mkdirs = 0;
    vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (x: fs.PathLike, o?: fs.MakeDirectoryOptions) => {
      if (path.resolve(String(x)) === path.resolve(folder)) mkdirs += 1;
      return realMkdir(x, o);
    }) as typeof fs.promises.mkdir);
    let seen: number | null = null;
    let probed!: () => void;
    const probe = new Promise<void>(resolve => { probed = resolve; });
    let wrapped = false;
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (file: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
      const fh = await realOpen(file, flags, mode);
      if (flags !== 'a+' || path.resolve(String(file)) !== path.resolve(p) || wrapped) return fh;
      wrapped = true;
      return new Proxy(fh, {
        get(target, prop) {
          if (prop === 'close') {
            return async () => {
              await target.close();
              dropPendingForGuild(guild);
              setImmediate(() => {
                setImmediate(() => {
                  seen = mkdirs;
                  probed();
                });
                enqueueAppend(p, 'b\n');
              });
            };
          }
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    }) as typeof fs.promises.open);

    enqueueAppend(p, 'a\n');
    await probe;
    expect(seen).toBe(1);
    await flushAll();
    expect(fs.readFileSync(p, 'utf8')).toBe('a\nb\n');
    expect(mkdirs).toBe(2);
  });
});
