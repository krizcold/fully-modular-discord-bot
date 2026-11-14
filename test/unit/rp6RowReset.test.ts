import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import type { SharedTxOutcome, SharedTxSpec } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import {
  _resetRowQueue, awaitStoreTicket, configureRowFlush, dropOwedStoreDoc, landStoreDoc, rowBackend, rowChange, rowQueue,
  useStoreLanding, useWebuiSessions, webuiSessionsOpen, withMirrorLock, type RowBackend, type RowTicket, type StoreLanding,
} from '../../src/bot/internalSetup/utils/sharedStore';
import { docRecordPath, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { setBackendKind } from '../helpers/backendKind';

// L5 run A, rp6 chunk of sharedStore.ts: decision 49's mirror mutex (one per key, first in, first out), and what a
// reset of the row queue forgets: attempts on the wire, mirror runs asked for again, waiters, store waits, owed store
// docs, mirror locks and the web UI's session marks. The flush sends on a fake data pool whose shared transactions
// answer when the test says; an op it lands holds no bytes, so each op here is a delete.

const KEY = 'global/rp6m/a.json';
const FILE = dataPath('global', 'rp6m', 'a.json');
const STORE_KEY = 'global/appstore/rp6s.json';
const STORE_FILE = dataPath('global', 'appstore', 'rp6s.json');
const X = Buffer.from('{"v":"x"}');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

let errors: string[];
let answers: Array<(outcome: SharedTxOutcome<unknown>) => void>;
let autoCommit: boolean;
let txCalls: number;

const pool: RowBackend = {
  sharedTx: <S>(_spec: SharedTxSpec<S>): Promise<SharedTxOutcome<S>> => {
    txCalls += 1;
    if (autoCommit) return Promise.resolve({ kind: 'committed' } as unknown as SharedTxOutcome<S>);
    return new Promise(resolve => { answers.push(resolve as (outcome: SharedTxOutcome<unknown>) => void); });
  },
};

const tick = (ms = 5) => new Promise(resolve => { setTimeout(resolve, ms); });

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

const accept = (key = KEY, file = FILE): RowTicket => rowQueue.accept(key, file, { body: null }, { sha: 'absent', caller: false });

beforeEach(() => {
  errors = [];
  answers = [];
  autoCommit = false;
  txCalls = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  _resetRowQueue();
  useStoreLanding(null);
  for (const dir of [dataPath('global'), dataPath('_superseded')]) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(docRecordPath(), { force: true });
  fs.mkdirSync(dataPath('global', 'appstore'), { recursive: true });
  fs.mkdirSync(dataPath('global', 'rp6m'), { recursive: true });
  configureRowFlush({ backend: () => pool });
});

afterEach(() => {
  vi.useRealTimers();
  configureRowFlush({ backend: () => null });
  useStoreLanding(null);
  useWebuiSessions(null);
  setBackendKind(null);
  _resetRowQueue();
  vi.restoreAllMocks();
});

describe("decision 49's mirror mutex", () => {
  it('runs the holders of one key one at a time, in the order they asked (rp6-12, rp6-13, rp6-14, rp6-16)', async () => {
    const log: string[] = [];
    const a = deferred();
    const b = deferred();
    const first = withMirrorLock(KEY, async () => { log.push('a start'); await a.promise; log.push('a end'); });
    const second = withMirrorLock(KEY, async () => { log.push('b start'); await b.promise; log.push('b end'); });
    await tick();
    expect(log).toEqual(['a start']);
    a.resolve();
    await first;
    await until(() => log.includes('b start'), 'the second holder');
    const third = withMirrorLock(KEY, async () => { log.push('c'); });
    await tick(20);
    expect(log).toEqual(['a start', 'a end', 'b start']);
    b.resolve();
    await Promise.all([second, third]);
    expect(log).toEqual(['a start', 'a end', 'b start', 'b end', 'c']);
  });

});

describe('a reset of the row queue', () => {
  it('forgets a mirror lock held before it, so a holder after it runs at once (rp6-25)', async () => {
    const held = deferred();
    const before = withMirrorLock(KEY, () => held.promise);
    await tick();
    _resetRowQueue();
    let ran = false;
    const after = withMirrorLock(KEY, async () => { ran = true; });
    await until(() => ran, 'the holder after the reset', 500).catch(() => undefined);
    expect(ran).toBe(true);
    held.resolve();
    await Promise.all([before, after]);
  });

  it('forgets an attempt on the wire, so an op of its key accepted after it is sent (rp6-17)', async () => {
    const first = accept();
    await until(() => first.op.state === 'wire', 'the first attempt');
    expect(txCalls).toBe(1);
    _resetRowQueue();
    const second = accept();
    await until(() => second.op.state === 'wire', 'the attempt after the reset', 500).catch(() => undefined);
    expect(second.op.state).toBe('wire');
    expect(txCalls).toBe(2);
  });

  it("drops the waiters of an op from before it: the op's later settle wakes none (rp6-22)", async () => {
    const first = accept();
    await until(() => first.op.state === 'wire', 'the first attempt');
    let woke = false;
    void rowChange(first).then(() => { woke = true; });
    _resetRowQueue();
    answers[0]({ kind: 'refused', phase: 'held', detail: 'rp6 refusal' } as unknown as SharedTxOutcome<unknown>);
    await until(() => first.op.state === 'queued', 'the settle');
    await tick(20);
    expect(woke).toBe(false);
  });

  it('forgets a mirror run asked for again, so a failed mirror write after it is tried 1 s, then 2 s later (rp6-18)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    autoCommit = true;
    const held = deferred();
    const lock = withMirrorLock(KEY, () => held.promise);
    const one = accept();
    await settleMicrotasks();
    expect(one.op.state).toBe('mirror');
    const two = accept();
    await settleMicrotasks();
    expect(two.op.state).toBe('mirror');
    _resetRowQueue();
    fs.writeFileSync(docRecordPath(), 'not json');
    const three = accept();
    await settleMicrotasks();
    expect(errors.filter(l => l.startsWith(`[Shared] Saved ${KEY} in the database, but could not write ${FILE} (`))).toHaveLength(1);
    expect(three.op.state).toBe('mirror');
    await vi.advanceTimersByTimeAsync(1500);
    await settleMicrotasks();
    expect(three.op.state).toBe('mirror');
    fs.rmSync(docRecordPath(), { force: true });
    await vi.advanceTimersByTimeAsync(1000);
    await settleMicrotasks();
    expect(three.op.state).toBe('mirror');
    await vi.advanceTimersByTimeAsync(500);
    await settleMicrotasks();
    expect(three.op.state).toBe('landed');
    held.resolve();
    await lock;
  });

  it('forgets the store waits, so an op from before it that lands after it leaves the landing block to the store mutex (rp6-23)', async () => {
    fs.writeFileSync(STORE_FILE, X);
    writeStoreRecord({ docs: { [STORE_KEY]: { sha: sha(X), stamp: null, main: null } }, modules: {} });
    const first = accept(STORE_KEY, STORE_FILE);
    await until(() => first.op.state === 'wire', 'the first attempt');
    const waiting = awaitStoreTicket(first, 300);
    _resetRowQueue();
    const grants: Array<() => void> = [];
    let locks = 0;
    const landing: StoreLanding = {
      acquire: () => new Promise(resolve => { grants.push(() => resolve({ release: () => undefined })); }),
      locked: <T>(fn: () => T): T => { locks += 1; return fn(); },
    };
    useStoreLanding(landing);
    autoCommit = true;
    const second = accept(STORE_KEY, STORE_FILE);
    await until(() => second.op.state === 'store' && grants.length === 1, 'the second op waiting on the store mutex');
    answers[0]({ kind: 'committed' } as unknown as SharedTxOutcome<unknown>);
    await until(() => first.op.state === 'store', 'the first op stored');
    await tick(20);
    expect(locks).toBe(0);
    expect(fs.readFileSync(STORE_FILE).equals(X)).toBe(true);
    grants[0]();
    await until(() => locks === 1, 'the landing block in the hold');
    expect(fs.existsSync(STORE_FILE)).toBe(false);
    expect(await waiting).toBe('open');
  });

  it("forgets the owed store docs, so a later drop of the key keeps the mirror step's failure logged once (rp6-24)", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const real = fs.openSync;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const s = String(p);
      if (s.startsWith(`${STORE_FILE}.`) && s.endsWith('.tmp')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.openSync);
    landStoreDoc(STORE_KEY, X, sha(X), null);
    openSpy.mockRestore();
    _resetRowQueue();
    fs.writeFileSync(STORE_FILE, X);
    writeStoreRecord({ docs: { [STORE_KEY]: { sha: sha(X), stamp: null, main: null } }, modules: {} });
    const realUnlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === STORE_FILE) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return realUnlink(p);
    }) as typeof fs.unlinkSync);
    autoCommit = true;
    const op = accept(STORE_KEY, STORE_FILE);
    await settleMicrotasks();
    const failed = (l: string) => l.startsWith(`[Shared] ${STORE_FILE} is stored in the database, but this machine could not write its copy (EACCES)`);
    expect(op.op.state).toBe('mirror');
    expect(errors.filter(failed)).toHaveLength(1);
    dropOwedStoreDoc(STORE_KEY);
    await vi.advanceTimersByTimeAsync(1100);
    await settleMicrotasks();
    expect(errors.filter(failed)).toHaveLength(1);
    expect(fs.readFileSync(STORE_FILE).equals(X)).toBe(true);
  });

  it("forgets the web UI's session marks (rp6-26)", async () => {
    configureRowFlush({ backend: () => null });
    setBackendKind('postgres');
    const held = deferred();
    let sent = 0;
    useWebuiSessions({
      target: async () => ({ entry: 'postgres://bot:pw@a.example:5432/bot', tag: '1:M', countAtStart: 0 }),
      commitCheck: () => null,
      select: async () => ({ rows: [] }),
      tag: () => '1:M',
      session: () => ({
        connect: async () => undefined,
        query: async (q: { text: string }) => {
          sent += 1;
          if (q.text === 'SELECT 1') await held.promise;
          return { rows: [] };
        },
        end: async () => undefined,
        destroy: () => undefined,
      }),
    });
    const run = rowBackend()!.sharedTx({ check: null, statements: () => [{ text: 'SELECT 1', values: [] }] });
    await until(() => sent >= 2, 'the statement on the wire');
    expect(webuiSessionsOpen()).toBe(1);
    _resetRowQueue();
    expect(webuiSessionsOpen()).toBe(0);
    held.resolve();
    await run;
  });
});
