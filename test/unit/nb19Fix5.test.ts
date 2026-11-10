import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB19 round 5 fixes: confirmFile turns a covering replaced try into its kinded failed range at every 'unavailable'
// answer, also while a newer write of the path is flushing (DL-1, O1); syncStepError's 'open' next step is the step's
// own, not a save's (O2).

const h = vi.hoisted(() => ({
  chain: null as null | { dir: string; before: () => void; answer: { failed: true; kind: 'open'; dir: string; errno: string; error: null } },
  holdTemp: null as null | { file: string; until: Promise<void> },
  openFolder: null as null | string,
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolderChain: async (dir: string) => {
      const s = h.chain;
      if (s && path.resolve(dir) === s.dir) {
        h.chain = null;
        s.before();
        return s.answer;
      }
      return real.syncFolderChain(dir);
    },
    syncFolderSync: (dir: string) => {
      const at = path.resolve(dir);
      if (h.openFolder === at) return { failed: true, kind: 'open', dir: at, errno: 'EMFILE', error: null };
      return real.syncFolderSync(dir);
    },
  };
});

vi.mock('../../src/bot/internalSetup/utils/sharedStore', async orig => {
  const real = await orig<any>();
  return { ...real, rowBackend: () => ({ sharedRead: async () => ({ kind: 'read', rows: [] }) }) };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => {} }));

import fs from 'fs';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import {
  confirmFile,
  enqueueWrite,
  fileTicket,
  fileTicketFailure,
  fileTicketState,
  flushAll,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { confirmWrite } from '../../src/bot/internalSetup/utils/dataManager';
import { resetFolderSyncFailureForTests, syncStepError, syncWords, writtenUnconfirmedText } from '../../src/bot/internalSetup/utils/folderChain';
import { fetchModule } from '../../src/bot/internalSetup/utils/sharedModules';
import { deferredText } from '../../src/bot/internalSetup/utils/moduleApply';

let n = 0;
let errors: string[];
const guild = () => `8${Date.now() % 1_000_000}${++n}`;
const T2 = (p: string, dir: string) => {
  const { why, next } = syncWords('open', dir, 'EMFILE');
  return `[Data] ${p}: the file is written whole, but ${why}; it is not written again; can't confirm it is stored. ${next}`;
};

beforeEach(() => {
  h.chain = null;
  h.holdTemp = null;
  h.openFolder = null;
  resetFolderSyncFailureForTests();
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const realOpen = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation((async (file: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
    const p = String(file);
    const hold = h.holdTemp;
    if (flags === 'w' && hold && p.startsWith(`${hold.file}.`) && p.endsWith('.tmp')) await hold.until;
    return realOpen(file, flags, mode);
  }) as typeof fs.promises.open);
});
afterEach(async () => {
  h.chain = null;
  h.holdTemp = null;
  await flushAll();
  vi.restoreAllMocks();
  resetFolderSyncFailureForTests();
});

/** W1's chain answers 'open' while W2 is enqueued, and W2's temp open waits until release() runs. */
function replacedWhileNewerFlushes(name: string) {
  const p = dataPath(guild(), 'm', name);
  const dir = path.dirname(p);
  let release!: () => void;
  const until = new Promise<void>(resolve => { release = resolve; });
  h.chain = {
    dir,
    before: () => {
      enqueueWrite(p, '{"v":2}');
      h.holdTemp = { file: p, until };
    },
    answer: { failed: true, kind: 'open', dir, errno: 'EMFILE', error: null },
  };
  enqueueWrite(p, '{"v":1}');
  return { p, dir, t1: fileTicket(p), release };
}

describe('DL-1 and O1: the deadline passes while the newer write of the path is flushing', () => {
  it('confirmFile answers unavailable with the kinded range of the replaced try, logged once', async () => {
    const { p, dir, t1, release } = replacedWhileNewerFlushes('x.json');
    expect(await confirmFile(t1, 400)).toBe('unavailable');
    expect(fileTicketState(t1)).toBe('unconfirmed');
    expect(fileTicketFailure(t1)).toMatchObject({ what: 'whole', kind: 'open', dir, errno: 'EMFILE', cut: false });
    expect(fs.readFileSync(p, 'utf8')).toBe('{"v":1}');
    expect(errors.filter(e => e === T2(p, dir))).toHaveLength(1);
    release();
    await flushAll();
    expect(fs.readFileSync(p, 'utf8')).toBe('{"v":2}');
    expect(fileTicketState(t1)).toBe('unconfirmed');
    expect(errors.filter(e => e === T2(p, dir))).toHaveLength(1);
  });

  it('confirmWrite answers unavailable and the reader words T1 of kind open from the ticket', async () => {
    const { p, dir, t1, release } = replacedWhileNewerFlushes('y.json');
    expect(await confirmWrite(t1, 400)).toBe('unavailable');
    const failure = fileTicketFailure(t1);
    expect(failure?.kind).toBe('open');
    expect(writtenUnconfirmedText(p, failure!.kind!, failure!.dir!, failure!.errno ?? 'no error code'))
      .toBe(`${p} is written, but ${syncWords('open', dir, 'EMFILE').why}, so can't confirm it is stored. ${syncWords('open', dir, 'EMFILE').next}`);
    release();
  });

  it('the re-read at deadline 0 while the newer write is flushing answers unavailable too', async () => {
    const { dir, t1, release } = replacedWhileNewerFlushes('z.json');
    expect(await confirmFile(t1, 400)).toBe('unavailable');
    expect(await confirmFile(t1, 0)).toBe('unavailable');
    expect(fileTicketFailure(t1)).toMatchObject({ kind: 'open', dir });
    release();
  });
});

describe('O2: syncStepError outside a save', () => {
  it("kind open: the clause, then 'Try again.', and no save wording", () => {
    const error = syncStepError({ failed: true, kind: 'open', dir: '/data/x', errno: 'EMFILE', error: null });
    expect(error.message).toBe(`${syncWords('open', '/data/x', 'EMFILE').why}. Try again.`);
    expect(error.message).not.toContain('next save');
    expect(error).toMatchObject({ code: 'EMFILE', kind: 'open', dir: '/data/x' });
  });

  for (const kind of ['sync', 'earlier'] as const) {
    it(`kind ${kind}: the clause, then the restart`, () => {
      const error = syncStepError({ failed: true, kind, dir: '/data/x', errno: 'EIO', error: null });
      expect(error.message).toBe(`${syncWords(kind, '/data/x', 'EIO').why}. Check the disk, then restart the machine.`);
    });
  }
});

describe('O2: a fetch whose folder could not be opened for its sync', () => {
  it('answers the clause alone, no restart, and the pass text names its next pass only', async () => {
    const into = path.join(path.resolve(DATA_ROOT), `nb19-fix5-${process.pid}-${Date.now()}-${++n}`);
    h.openFolder = path.resolve(into);
    const why = syncWords('open', path.resolve(into), 'EMFILE').why;
    const answer = await fetchModule('alpha', into);
    expect(answer).toEqual({ ok: false, cause: why });
    const text = deferredText('update', 'alpha', '1.2.0', { outcome: 'deferred', reason: 'fetch', error: why, loaded: false });
    expect(text).toBe(`alpha 1.2.0 was updated. This machine applies it at its next pass (${why}).`);
    expect(text).not.toContain('next save');
    fs.rmSync(into, { recursive: true, force: true });
  });
});
