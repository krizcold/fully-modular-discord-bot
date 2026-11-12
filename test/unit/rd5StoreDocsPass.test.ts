import { createHash } from 'crypto';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The web UI's App Store docs pass (NB6 decision 31) run directly through runStoreDocsPass, its reads answered by a
// table of rows kept here: what the pass answers, the mirror bytes and store record it leaves, the lines it logs and
// the applied hooks it runs.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, landStoreDoc, rowQueue, useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror, runStoreDocsPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { readStoreRecord, storeRecordPath, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { setMainChooser } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { setBackendKind } from '../helpers/backendKind';
import { setView } from '../helpers/nb6Mirror';

const LIST_SQL = 'SELECT key, sha FROM smdb_data.shared_docs';
const BODY_SQL = 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1';
const TAG = '1:ALPHA';
const KEY = 'global/appstore/rd5.json';
const FILE = dataPath('global', 'appstore', 'rd5.json');
const A = Buffer.from('{"v":"a"}');
const B = Buffer.from('{"v":"b"}');
const C = Buffer.from('{"v":"c"}');
const X = Buffer.from('{"v":"edited by hand"}');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const WRITTEN = "the database's version is back in its place";
const NO_ROW = 'the database holds no such file, so nothing was put back';
const writeFailed = (errno: string) => `the database's version could not be written (${errno}); the next pass tries again`;
const HEAD_A = ': it differed from the version this machine last took from the database (changed outside the bot, or left by a crash); ';

let db: Map<string, Buffer>;
let reads: Array<{ text: string; values: unknown[] }>;
let listFault: Error | null;
let bodyFault: Error | null;
let lines: string[];
let hooks: string[];
let offHook: (() => void) | null;

const direct = <T>(fn: () => T): T => fn();

beforeEach(() => {
  db = new Map();
  reads = [];
  listFault = null;
  bodyFault = null;
  lines = [];
  hooks = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  _resetRowQueue();
  _resetSharedMirror();
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.rmSync(dataPath('_superseded'), { recursive: true, force: true });
  fs.mkdirSync(dataPath('global', 'appstore'), { recursive: true });
  setBackendKind('postgres');
  setView(1, 'ALPHA');
  dm.setGuildDataBackend(null);
  offHook = dm.onSharedApplied('global/', k => { hooks.push(k); });
  useWebuiSessions({
    target: () => new Promise(() => undefined),
    commitCheck: () => null,
    select: async (text, values) => {
      reads.push({ text, values });
      // pg refuses a bind whose parameter count differs from the statement's placeholders.
      const want = new Set(text.match(/\$\d+/g) ?? []).size;
      if (values.length !== want) throw new Error(`bind message supplies ${values.length} parameters, but prepared statement "" requires ${want}`);
      if (text === LIST_SQL) {
        if (listFault) throw listFault;
        return { rows: [...db].map(([key, body]) => ({ key, sha: sha(body) })) };
      }
      if (text === BODY_SQL) {
        if (bodyFault) throw bodyFault;
        const body = db.get(String(values[0]));
        return { rows: body ? [{ body, sha: sha(body) }] : [] };
      }
      throw new Error(`unexpected statement: ${text}`);
    },
    tag: () => TAG,
  });
});

afterEach(() => {
  vi.useRealTimers();
  offHook?.();
  useWebuiSessions(null);
  _resetRowQueue();
  _resetSharedMirror();
  setMainChooser(null);
  setBackendKind(null);
  vi.restoreAllMocks();
});

const entryOf = (key: string) => {
  const read = readStoreRecord();
  if (!read.ok) throw new Error(read.reason);
  return read.record.docs[key];
};

function setRecord(docs: Record<string, { sha: string; stamp: null; main: string | null }>): void {
  writeStoreRecord({ docs, modules: {} });
}

function mirror(bytes: Buffer, file = FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

const heldBytes = (file = FILE): Buffer | null => (fs.existsSync(file) ? fs.readFileSync(file) : null);

/** The mirror's own write (its temp file) fails with errno; every other open goes through. */
function failMirrorWrite(errno: string, file = FILE): void {
  const real = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    const s = String(p);
    if (s.startsWith(`${file}.`) && s.endsWith('.tmp')) throw Object.assign(new Error(`${errno}: no space left on device, open '${s}'`), { code: errno });
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.openSync);
}

const movedLine = (file = FILE) => lines.find(l => l.startsWith(`[Shared] Moved ${file} to `));

describe('the answer of a store docs pass', () => {
  it('a process with no connection to the database answers why (rd5-20)', async () => {
    useWebuiSessions(null);
    expect(await runStoreDocsPass(direct)).toEqual({ ok: false, cause: "this process has no connection to the bot's database" });
  });

  it('the listing is sent with no parameters, as its statement has none (rd5-23)', async () => {
    db.set(KEY, A);
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    expect(reads.find(r => r.text === LIST_SQL)?.values).toEqual([]);
    expect(heldBytes()!.equals(A)).toBe(true);
  });

  it('a failed read of a changed row answers its cause and leaves the mirror and its entry as they are (rd5-29, rd5-30, rd5-37, rd5-38)', async () => {
    mirror(A);
    setRecord({ [KEY]: { sha: sha(A), stamp: null, main: TAG } });
    db.set(KEY, B);
    bodyFault = new Error('Query read timeout');
    expect(await runStoreDocsPass(direct)).toEqual({ ok: false, cause: 'Query read timeout' });
    expect(heldBytes()!.equals(A)).toBe(true);
    expect(entryOf(KEY)).toEqual({ sha: sha(A), stamp: null, main: TAG });
    expect(hooks).toEqual([]);
  });

  it('a key the listing does not hold is not read again: it answers ok and the file the database lacks is removed (rd5-34, rd5-35)', async () => {
    mirror(A);
    setRecord({ [KEY]: { sha: sha(A), stamp: null, main: TAG } });
    bodyFault = new Error('Query read timeout');
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    expect(heldBytes()).toBeNull();
    expect(entryOf(KEY)).toBeUndefined();
    expect(reads.filter(r => r.text === BODY_SQL)).toEqual([]);
  });

  it('a mirror that already holds the listed row is not read again; its entry is written (rd5-36)', async () => {
    mirror(A);
    db.set(KEY, A);
    bodyFault = new Error('Query read timeout');
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    expect(entryOf(KEY)).toEqual({ sha: sha(A), stamp: null, main: TAG });
    expect(heldBytes()!.equals(A)).toBe(true);
  });

  it("a key with this process's op queued is left to the op: no read, and the pass answers ok (rd5-31, rd5-32)", async () => {
    mirror(A);
    setRecord({ [KEY]: { sha: sha(A), stamp: null, main: TAG } });
    db.set(KEY, B);
    rowQueue.accept(KEY, FILE, { body: C }, { sha: sha(A), caller: false });
    expect(rowQueue.ops(KEY).length).toBe(1);
    bodyFault = new Error('Query read timeout');
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    expect(reads.filter(r => r.text === BODY_SQL)).toEqual([]);
    expect(heldBytes()!.equals(A)).toBe(true);
    expect(entryOf(KEY)).toEqual({ sha: sha(A), stamp: null, main: TAG });
  });
});

describe('which keys a store docs pass visits', () => {
  it('a store record entry whose file and row are both gone is dropped (rd5-25)', async () => {
    setRecord({ [KEY]: { sha: sha(A), stamp: null, main: TAG } });
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    expect(entryOf(KEY)).toBeUndefined();
  });

  it('a store doc on disk that neither the database nor the record knows is moved aside (rd5-26)', async () => {
    mirror(X);
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    expect(heldBytes()).toBeNull();
    const moved = movedLine();
    expect(moved).toBeDefined();
    expect(moved!.endsWith(HEAD_A + NO_ROW)).toBe(true);
    const dest = moved!.slice(`[Shared] Moved ${FILE} to `.length, moved!.indexOf(HEAD_A));
    expect(fs.readFileSync(dest).equals(X)).toBe(true);
  });

  it('a key of the store record outside the App Store is never touched by the store pass (rd5-28)', async () => {
    const otherKey = 'global/rd5other/x.json';
    const otherFile = dataPath('global', 'rd5other', 'x.json');
    mirror(X, otherFile);
    setRecord({ [otherKey]: { sha: sha(A), stamp: null, main: TAG } });
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    expect(heldBytes(otherFile)!.equals(X)).toBe(true);
    expect(entryOf(otherKey)).toEqual({ sha: sha(A), stamp: null, main: TAG });
    expect(movedLine(otherFile)).toBeUndefined();
    expect(fs.existsSync(dataPath('_superseded'))).toBe(false);
  });

  it('keys are applied in key order, whatever order the database lists them in (rd5-27)', async () => {
    db.set('global/appstore/rd5-b.json', B);
    db.set('global/appstore/rd5-a.json', A);
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    expect(reads.filter(r => r.text === BODY_SQL).map(r => r.values[0])).toEqual(['global/appstore/rd5-a.json', 'global/appstore/rd5-b.json']);
    expect(hooks).toEqual(['global/appstore/rd5-a.json', 'global/appstore/rd5-b.json']);
  });
});

describe("one App Store key's apply", () => {
  it('a mirror taken from the main before a switch is moved aside with the switch head (rd5-3)', async () => {
    mirror(A);
    setRecord({ [KEY]: { sha: sha(A), stamp: null, main: '0:OLD' } });
    db.set(KEY, B);
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    const moved = movedLine();
    expect(moved).toBeDefined();
    expect(moved!.endsWith(`: it held the version this machine took from the database before the switch to ALPHA (generation 1); ${WRITTEN}`)).toBe(true);
    expect(heldBytes()!.equals(B)).toBe(true);
    expect(entryOf(KEY)).toEqual({ sha: sha(B), stamp: null, main: TAG });
  });

  it('a changed mirror with no row is moved aside, nothing is put back and the entry is dropped (rd5-4)', async () => {
    mirror(X);
    setRecord({ [KEY]: { sha: sha(A), stamp: null, main: TAG } });
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    const moved = movedLine();
    expect(moved).toBeDefined();
    expect(moved!.endsWith(HEAD_A + NO_ROW)).toBe(true);
    expect(lines.some(l => l.includes('could not be written'))).toBe(false);
    expect(heldBytes()).toBeNull();
    expect(entryOf(KEY)).toBeUndefined();
    expect(hooks).toEqual([KEY]);
  });

  it('a move aside that fails leaves the mirror, logs why and runs no applied hook (rd5-2)', async () => {
    mirror(X);
    setRecord({ [KEY]: { sha: sha(A), stamp: null, main: TAG } });
    db.set(KEY, B);
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (path.resolve(String(from)) === path.resolve(FILE)) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return real(from, to);
    }) as typeof fs.renameSync);
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    expect(lines).toContain(`[Shared] Could not move ${FILE} aside (EBUSY); left it as it is and will try again at the next pass`);
    expect(heldBytes()!.equals(X)).toBe(true);
    expect(entryOf(KEY)).toEqual({ sha: sha(A), stamp: null, main: TAG });
    expect(hooks).toEqual([]);
  });

  it('a row written in place runs the applied hook once (rd5-15)', async () => {
    db.set(KEY, B);
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    expect(heldBytes()!.equals(B)).toBe(true);
    expect(entryOf(KEY)).toEqual({ sha: sha(B), stamp: null, main: TAG });
    expect(hooks).toEqual([KEY]);
  });

  it('a failed write with nothing moved aside logs row 34, records nothing and runs no hook (rd5-5, rd5-6, rd5-8, rd5-9, rd5-10, rd5-12)', async () => {
    db.set(KEY, B);
    failMirrorWrite('ENOSPC');
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    expect(lines).toEqual([`[Shared] Could not write ${FILE} (ENOSPC); retrying`]);
    expect(heldBytes()).toBeNull();
    expect(entryOf(KEY)).toBeUndefined();
    expect(hooks).toEqual([]);
  });

  it('a failed write after a move aside logs the move with the failure and runs the hook, since the mirror changed (rd5-7, rd5-11, rd5-12)', async () => {
    mirror(X);
    setRecord({ [KEY]: { sha: sha(A), stamp: null, main: TAG } });
    db.set(KEY, B);
    failMirrorWrite('ENOSPC');
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    expect(lines.length).toBe(1);
    const moved = movedLine();
    expect(moved).toBeDefined();
    expect(moved!.endsWith(HEAD_A + writeFailed('ENOSPC'))).toBe(true);
    expect(heldBytes()).toBeNull();
    expect(entryOf(KEY)).toEqual({ sha: sha(A), stamp: null, main: TAG });
    expect(hooks).toEqual([KEY]);
  });

  it('a write that worked lets the same failure be logged again later (rd5-13)', async () => {
    const failed = `[Shared] Could not write ${FILE} (ENOSPC); retrying`;
    db.set(KEY, B);
    failMirrorWrite('ENOSPC');
    await runStoreDocsPass(direct);
    expect(lines.filter(l => l === failed).length).toBe(1);
    vi.mocked(fs.openSync).mockRestore();
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    expect(heldBytes()!.equals(B)).toBe(true);
    db.set(KEY, C);
    failMirrorWrite('ENOSPC');
    await runStoreDocsPass(direct);
    expect(lines.filter(l => l === failed).length).toBe(2);
    expect(heldBytes()!.equals(B)).toBe(true);
  });

  it("a row the pass writes wins over this machine's owed publish: the publish's retry does not put its older version back (rd5-14)", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    db.set(KEY, A);
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    expect(entryOf(KEY)).toEqual({ sha: sha(A), stamp: null, main: TAG });
    failMirrorWrite('ENOSPC');
    landStoreDoc(KEY, B, sha(B), TAG);
    vi.mocked(fs.openSync).mockRestore();
    expect(heldBytes()!.equals(A)).toBe(true);
    mirror(X);
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    expect(heldBytes()!.equals(A)).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(heldBytes()!.equals(A)).toBe(true);
    expect(entryOf(KEY)).toEqual({ sha: sha(A), stamp: null, main: TAG });
  });
});

describe("the pass's stop line once per cause until a pass answers", () => {
  const stoppedLine = '[Shared] The pass over the shared files stopped (rd5 lock lost); it tries again at the next pass';
  const throwing = <T>(): T => { throw new Error('rd5 lock lost'); };

  it('an answered pass logs the same stop again the next time it happens (rd5-16)', async () => {
    db.set(KEY, A);
    expect(await runStoreDocsPass(throwing)).toEqual({ ok: false, cause: 'rd5 lock lost' });
    expect(await runStoreDocsPass(direct)).toEqual({ ok: true });
    expect(await runStoreDocsPass(throwing)).toEqual({ ok: false, cause: 'rd5 lock lost' });
    expect(lines.filter(l => l === stoppedLine).length).toBe(2);
  });

  it('a pass whose listing failed does not, so the stop is logged once (rd5-17)', async () => {
    db.set(KEY, A);
    expect(await runStoreDocsPass(throwing)).toEqual({ ok: false, cause: 'rd5 lock lost' });
    listFault = new Error('connect ECONNREFUSED 10.0.0.1:5432');
    expect(await runStoreDocsPass(direct)).toEqual({ ok: false, cause: 'connect ECONNREFUSED 10.0.0.1:5432' });
    listFault = null;
    expect(await runStoreDocsPass(throwing)).toEqual({ ok: false, cause: 'rd5 lock lost' });
    expect(lines.filter(l => l === stoppedLine).length).toBe(1);
  });
});
