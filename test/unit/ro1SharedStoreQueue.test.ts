import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import {
  _resetRowQueue, configureRowFlush, flushRows, latestRowTicket, mirrorBytes, OP_SQL, ROW_ACCEPT_BYTES, rowBackend, rowChange, rowCommitOwed,
  rowMirrorsWritten, rowOpenPaths, rowOutcome, rowQueue, rowTicketState, shaOf, sharedKeyFor, UPSERT_SQL, useOutsideChain, useWebuiSessions,
  type RowBackend, type RowTicket, type RowWork, type WebuiSessionDeps,
} from '../../src/bot/internalSetup/utils/sharedStore';
import type { SharedStatement, SharedTxOutcome, SharedTxSpec } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { setBackendKind } from '../helpers/backendKind';

// L5 run A, chunk ro1 (sharedStore.ts): the local global files, the mirror read, the row queue's accept and its bounds,
// the backend choice, the retry waits and the timers the test reset stops.

const CATEGORY = 'ro1queue';
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const fileOf = (name: string) => dataPath('global', CATEGORY, name);
const buf = (text: string) => Buffer.from(text, 'utf8');
const plain = (text: string) => ({ body: buf(text) });
const noBase = { sha: 'absent', caller: false };

function work(bytes: number): RowWork {
  return { bytes, spec: () => { throw new Error('a lines op is not sent in this test'); } };
}

type Stored = { body: Buffer; sha: string; updated_by: string; updated_at: Date };

/** A shared transaction run against an in-memory shared_docs: each statement answered, next followed, COMMIT applied. */
function fakeBackend(start: Record<string, Stored> = {}) {
  const docs = new Map(Object.entries(start));
  const sent: string[] = [];
  let commits = 0;
  let calls = 0;
  const backend: RowBackend = {
    async sharedTx<S>(spec: SharedTxSpec<S>): Promise<SharedTxOutcome<S>> {
      calls += 1;
      const plan = spec.statements(null);
      if (plan === 'landed') return { kind: 'landed' };
      if (!Array.isArray(plan)) return { kind: 'stopped', value: plan.stop };
      const queue: SharedStatement<S>[] = [...plan];
      const writes: Array<() => void> = [];
      const results: any[] = [];
      while (queue.length > 0) {
        const st = queue.shift()!;
        sent.push(st.text);
        let res: any = { rows: [], rowCount: 0 };
        if (st.text.includes('pg_advisory_xact_lock')) res = { rows: [{ now: new Date() }], rowCount: 1 };
        else if (st.text.startsWith('SELECT body, sha, updated_by, updated_at FROM smdb_data.shared_docs')) {
          const row = docs.get(String(st.values[0]));
          res = row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
        } else if (st.text === UPSERT_SQL) {
          const [key, body, sha, by] = st.values as [string, Buffer, string, string];
          writes.push(() => docs.set(key, { body: Buffer.from(body), sha, updated_by: by, updated_at: new Date() }));
          res = { rows: [{ rev: '1' }], rowCount: 1 };
        }
        results.push(res);
        if (!st.next) continue;
        const after = st.next(res);
        if (Array.isArray(after)) queue.unshift(...after);
        else if (after) return { kind: 'stopped', value: after.stop };
      }
      spec.onCommitSent?.();
      commits += 1;
      for (const w of writes) w();
      return { kind: 'committed', results };
    },
  };
  return { backend, docs, sent, commits: () => commits, calls: () => calls };
}

const failing: RowBackend = {
  sharedTx: async () => ({ kind: 'failed', step: 'connect', detail: 'connect ECONNREFUSED' }),
};

let errors: string[];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  _resetRowQueue();
  configureRowFlush({ backend: () => null });
  fs.rmSync(dataPath('global', CATEGORY), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
});

afterEach(() => {
  configureRowFlush({ backend: () => null });
  useOutsideChain(null);
  useWebuiSessions(null);
  _resetRowQueue();
  vi.useRealTimers();
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('the web UI chain frame of an accept', () => {
  it('before any frame is named, an accepted op belongs to the local chain', () => {
    rowQueue.accept(keyOf('first.json'), fileOf('first.json'), plain('{"a":1}'), noBase);
    expect(rowOpenPaths()).toEqual([fileOf('first.json')]);
  });

  it('after the frame is turned off again, an accepted op belongs to the local chain', () => {
    useOutsideChain(() => true);
    useOutsideChain(null);
    rowQueue.accept(keyOf('off.json'), fileOf('off.json'), plain('{"a":1}'), noBase);
    expect(rowOpenPaths()).toEqual([fileOf('off.json')]);
  });

  it('a write outside the chain does not join an op accepted inside it', () => {
    const key = keyOf('frames.json');
    const inside = rowQueue.accept(key, fileOf('frames.json'), plain('{"a":1}'), noBase);
    useOutsideChain(() => true);
    const outside = rowQueue.accept(key, fileOf('frames.json'), plain('{"a":2}'), noBase);
    expect(outside.op).not.toBe(inside.op);
    expect(rowQueue.ops(key)).toHaveLength(2);
    expect(inside.op.body!.toString('utf8')).toBe('{"a":1}');
  });
});

describe('which files under /data/global stay on one machine', () => {
  it('the fleet folder and the App Store cache folder have no shared key', () => {
    expect(sharedKeyFor(dataPath('global', 'fleet'))).toBeNull();
    expect(sharedKeyFor(dataPath('global', 'appstore', 'cache'))).toBeNull();
    expect(sharedKeyFor(dataPath('global', 'appstore', 'other.json'))).toBe('global/appstore/other.json');
  });
});

describe('the mirror read', () => {
  it('rethrows a read error other than a missing file', () => {
    const dir = fileOf('a-folder');
    fs.mkdirSync(dir, { recursive: true });
    expect(() => mirrorBytes(dir)).toThrow();
    expect(mirrorBytes(fileOf('missing.json'))).toBeNull();
  });
});

describe('the accept of a write', () => {
  it('a plain write joins the queued op and gets the next write count', () => {
    const key = keyOf('join.json');
    const first = rowQueue.accept(key, fileOf('join.json'), plain('{"n":1}'), noBase);
    const second = rowQueue.accept(key, fileOf('join.json'), plain('{"n":2}'), noBase);
    expect(second.op).toBe(first.op);
    expect(second.seq).toBe(2);
    expect(latestRowTicket(key)!.seq).toBe(2);
    expect(first.op.body!.toString('utf8')).toBe('{"n":2}');
  });

  it('a write with a check starts an op of its own and keeps its check', () => {
    const key = keyOf('check.json');
    rowQueue.accept(key, fileOf('check.json'), plain('{"n":1}'), noBase);
    const checked = rowQueue.accept(key, fileOf('check.json'), plain('{"n":2}'), { ...noBase, check: { [keyOf('other.json')]: null } });
    expect(rowQueue.ops(key)).toHaveLength(2);
    expect(checked.op.check).toEqual({ [keyOf('other.json')]: null });
  });

  it('a write carrying lines starts an op of its own that holds the lines', () => {
    const key = keyOf('carry.json');
    rowQueue.accept(key, fileOf('carry.json'), plain('{"n":1}'), noBase);
    const lines = { key: keyOf('audit.jsonl'), lines: [{ id: 'l1', line: buf('{"x":1}\n') }] };
    const carrying = rowQueue.accept(key, fileOf('carry.json'), { body: buf('{"n":2}'), lines }, noBase);
    expect(rowQueue.ops(key)).toHaveLength(2);
    expect(carrying.op.carried).toEqual(lines);
  });

  it('a write after a try that failed starts a new op', async () => {
    const key = keyOf('tried.json');
    const first = rowQueue.accept(key, fileOf('tried.json'), plain('{"n":1}'), noBase);
    configureRowFlush({ backend: () => failing });
    await flushRows();
    configureRowFlush({ backend: () => null });
    expect(first.op.state).toBe('queued');
    expect(first.op.attempts).toBe(1);
    const second = rowQueue.accept(key, fileOf('tried.json'), plain('{"n":2}'), noBase);
    expect(second.op).not.toBe(first.op);
    expect(first.op.body!.toString('utf8')).toBe('{"n":1}');
  });

  it('a write that joins an op starts the flush', async () => {
    const key = keyOf('kick.json');
    rowQueue.accept(key, fileOf('kick.json'), plain('{"n":1}'), noBase);
    await new Promise<void>(resolve => { setImmediate(resolve); });
    const fake = fakeBackend();
    configureRowFlush({ backend: () => fake.backend });
    const ticket = rowQueue.accept(key, fileOf('kick.json'), plain('{"n":2}'), noBase);
    for (let i = 0; i < 50 && fake.calls() === 0; i++) await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(fake.calls()).toBe(1);
    expect(await rowOutcome(ticket)).toBe('landed');
    expect(fake.docs.get(key)!.body.toString('utf8')).toBe('{"n":2}');
    await rowMirrorsWritten();
  });

  it('a write with an empty list of lines and the stored bytes stores nothing and sends no op id', async () => {
    const key = keyOf('same.json');
    const body = buf('{"same":true}');
    const fake = fakeBackend({ [key]: { body, sha: shaOf(body), updated_by: 'BRAVO/p', updated_at: new Date() } });
    configureRowFlush({ backend: () => fake.backend });
    const ticket = rowQueue.accept(key, fileOf('same.json'), { body, lines: { key: keyOf('a.jsonl'), lines: [] } }, { sha: shaOf(body), caller: true });
    expect(ticket.op.carried).toBeNull();
    expect(await rowOutcome(ticket)).toBe('landed');
    expect(fake.sent).not.toContain(OP_SQL);
    expect(fake.commits()).toBe(0);
    await rowMirrorsWritten();
  });

  it('an update over a changed row with no update runner is refused with that reason', async () => {
    const key = keyOf('upd.json');
    const stored = buf('{"n":5}');
    const fake = fakeBackend({ [key]: { body: stored, sha: shaOf(stored), updated_by: 'BRAVO/p-bravo', updated_at: new Date() } });
    configureRowFlush({ backend: () => fake.backend });
    const ticket = rowQueue.accept(key, fileOf('upd.json'), { body: buf('{"n":1}'), update: { fn: (v: any) => ({ n: v.n + 1 }), defaultValue: { n: 0 } } }, noBase);
    const outcome = await rowOutcome(ticket);
    expect(outcome).toMatchObject({ refused: { cause: 'changed-elsewhere', reason: 'no update runner', by: 'BRAVO' } });
    expect(fake.docs.get(key)!.body.toString('utf8')).toBe('{"n":5}');
  });
});

describe('an op of a lines key', () => {
  it('takes no later doc write of the same key', () => {
    const key = keyOf('w.jsonl');
    const lines = rowQueue.acceptWork(key, fileOf('w.jsonl'), work(10));
    const doc = rowQueue.accept(key, fileOf('w.jsonl'), plain('x'), noBase);
    expect(doc.op).not.toBe(lines.op);
    expect(rowQueue.ops(key)).toHaveLength(2);
    expect(lines.op.body).toBeNull();
  });

  it('owes no commit answer before it is sent', () => {
    const ticket = rowQueue.acceptWork(keyOf('owe.jsonl'), fileOf('owe.jsonl'), work(10));
    expect(rowCommitOwed(ticket)).toBe(false);
    expect(rowTicketState(ticket)).toBe('open');
  });

  it('is never the entry a read of the key answers from', () => {
    const key = keyOf('entry.json');
    const doc = rowQueue.accept(key, fileOf('entry.json'), plain('{"d":1}'), noBase);
    rowQueue.acceptWork(key, fileOf('entry.json'), work(10));
    expect(rowQueue.entryOf(key)).toBe(doc.op);
    expect(latestRowTicket(key)!.op).toBe(doc.op);
  });
});

describe("decision 7's byte bound", () => {
  it('counts a doc op body and the lines it carries', () => {
    const lines = { key: keyOf('l.jsonl'), lines: [{ id: 'a', line: buf('12345') }, { id: 'b', line: buf('1234567') }] };
    rowQueue.accept(keyOf('bytes.json'), fileOf('bytes.json'), { body: buf('0123456789'), lines }, noBase);
    expect(rowQueue.bytes()).toBe(22);
  });

  it('closes acceptance at exactly 64 MiB', () => {
    rowQueue.acceptWork(keyOf('big.jsonl'), fileOf('big.jsonl'), work(ROW_ACCEPT_BYTES));
    expect(rowQueue.closed()).toBe(true);
  });

  it('counts an op while its attempt is on the wire', async () => {
    let started!: () => void;
    const onWire = new Promise<void>(resolve => { started = resolve; });
    let answer!: (o: SharedTxOutcome<any>) => void;
    const held: RowBackend = {
      sharedTx: () => {
        started();
        return new Promise(resolve => { answer = resolve; });
      },
    };
    configureRowFlush({ backend: () => held });
    const ticket = rowQueue.accept(keyOf('wire.json'), fileOf('wire.json'), plain('0123456789'), noBase);
    await onWire;
    expect(ticket.op.state).toBe('wire');
    expect(rowQueue.bytes()).toBe(10);
    configureRowFlush({ backend: () => null });
    answer({ kind: 'failed', step: 'connect', detail: 'stop' });
    await rowChange(ticket);
  });
});

describe('the backend the flush sends on', () => {
  it('is none with no data pool and no web UI sessions', () => {
    setBackendKind('postgres');
    expect(rowBackend()).toBeNull();
  });

  it('is none for web UI sessions on a JSON bot', () => {
    setBackendKind('file');
    const sessions: WebuiSessionDeps = {
      target: async () => ({ refusal: 'test', held: false }),
      commitCheck: () => null,
      select: async () => ({ rows: [] }),
      tag: () => null,
    };
    useWebuiSessions(sessions);
    expect(rowBackend()).toBeNull();
  });
});

describe('the retry waits', () => {
  it('the second failed try waits about twice as long as the first', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const ticket = rowQueue.accept(keyOf('backoff.json'), fileOf('backoff.json'), plain('{"b":1}'), noBase);
    configureRowFlush({ backend: () => failing });
    await flushRows();
    await flushRows();
    configureRowFlush({ backend: () => null });
    expect(ticket.op.triesFailed).toBe(2);
    expect(ticket.op.retryAt - Date.now()).toBeGreaterThan(1500);
  });

  function blockedMirror(name: string): { key: string; file: string; blocker: string } {
    const blocker = fileOf(`${name}-blocker`);
    fs.mkdirSync(path.dirname(blocker), { recursive: true });
    fs.writeFileSync(blocker, 'not a folder');
    return { key: keyOf(`${name}.json`), file: path.join(blocker, 'doc.json'), blocker };
  }

  async function storeWithFailedMirror(key: string, file: string, text: string, base = noBase): Promise<RowTicket> {
    const ticket = rowQueue.accept(key, file, plain(text), base);
    expect(await rowOutcome(ticket)).toBe('landed');
    await rowMirrorsWritten();
    expect(ticket.op.state).toBe('mirror');
    return ticket;
  }

  it('a failed mirror write is tried again after 1 s, not at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = fakeBackend();
    configureRowFlush({ backend: () => fake.backend });
    const { key, file, blocker } = blockedMirror('retry');
    const ticket = await storeWithFailedMirror(key, file, '{"m":1}');
    expect(errors.some(e => e.startsWith(`[Shared] Saved ${key} in the database, but could not write`))).toBe(true);
    fs.rmSync(blocker, { force: true });
    vi.advanceTimersByTime(5);
    expect(rowMirrorsWritten()).toBeNull();
    vi.advanceTimersByTime(1000);
    await rowMirrorsWritten();
    expect(fs.readFileSync(file, 'utf8')).toBe('{"m":1}');
    expect(rowQueue.ops(key)).toHaveLength(0);
    expect(rowTicketState(ticket)).toBe('landed');
  });

  it('the test reset stops a pending mirror retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = fakeBackend();
    configureRowFlush({ backend: () => fake.backend });
    const { key, file } = blockedMirror('reset');
    await storeWithFailedMirror(key, file, '{"r":1}');
    _resetRowQueue();
    vi.advanceTimersByTime(500);
    await storeWithFailedMirror(key, file, '{"r":2}', { sha: shaOf(buf('{"r":1}')), caller: false });
    vi.advanceTimersByTime(600);
    expect(rowMirrorsWritten()).toBeNull();
  });
});
