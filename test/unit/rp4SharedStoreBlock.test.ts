import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import {
  _resetRowQueue, awaitStoreTicket, configureRowFlush, flushRows, rowMirrorsWritten, rowOutcome, rowQueue, shaOf, UPSERT_SQL, useStoreLanding,
  type RowBackend, type RowTicket, type StoreLanding,
} from '../../src/bot/internalSetup/utils/sharedStore';
import type { SharedStatement, SharedTxOutcome, SharedTxSpec } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

// L5 run A, chunk rp4 (sharedStore.ts): the landing block of an App Store key run by the flush (decision 53): the store
// mutex it takes, its retry waits, its failure line and the ticket waiters it wakes.

const CATEGORY = 'rp4store';
const keyOf = (name: string) => `global/appstore/${CATEGORY}/${name}`;
const fileOf = (name: string) => dataPath('global', 'appstore', CATEGORY, name);
const buf = (text: string) => Buffer.from(text, 'utf8');
const STORE_RECORD = () => dataPath('global', 'appstore', 'cache', '.shared-mirror.json');

type Stored = { body: Buffer; sha: string; updated_by: string; updated_at: Date };

function fakeBackend() {
  const docs = new Map<string, Stored>();
  const control: { fail: (call: number) => boolean } = { fail: () => false };
  let calls = 0;
  const backend: RowBackend = {
    async sharedTx<S>(spec: SharedTxSpec<S>): Promise<SharedTxOutcome<S>> {
      calls += 1;
      if (control.fail(calls)) return { kind: 'failed', step: 'connect', detail: 'connect ECONNREFUSED' };
      const plan = spec.statements(null);
      if (plan === 'landed') return { kind: 'landed' };
      if (!Array.isArray(plan)) return { kind: 'stopped', value: plan.stop };
      const queue: SharedStatement<S>[] = [...plan];
      const writes: Array<() => void> = [];
      const results: any[] = [];
      while (queue.length > 0) {
        const st = queue.shift()!;
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
      for (const w of writes) w();
      return { kind: 'committed', results };
    },
  };
  return { backend, docs, control };
}

const NONE = Symbol('none');
type Answer = 'hold' | 'none' | Promise<'hold' | 'none'>;

/** appStoreManager's store mutex and store lock as the flush sees them, each answer of the mutex scripted. */
function fakeLanding() {
  const answers: Answer[] = [];
  const s = { acquires: 0, locks: 0, releases: 0, failing: NONE as unknown };
  const landing: StoreLanding = {
    async acquire() {
      s.acquires += 1;
      const answer = await (answers.shift() ?? 'hold');
      return answer === 'hold' ? { release: () => { s.releases += 1; } } : null;
    },
    locked<T>(fn: () => T): T {
      s.locks += 1;
      if (s.failing !== NONE) throw s.failing;
      return fn();
    },
  };
  return { landing, answers, s };
}

let fake: ReturnType<typeof fakeBackend>;
let store: ReturnType<typeof fakeLanding>;
let errors: string[];

const accept = (name: string, body: string, base = 'absent'): RowTicket =>
  rowQueue.accept(keyOf(name), fileOf(name), { body: buf(body) }, { sha: base, caller: false });

const copyLines = (name: string) =>
  errors.filter(l => l === `[Shared] ${fileOf(name)} is stored in the database, but this machine could not write its copy (EACCES); the App Store on this machine shows the previous version until it is written, and it tries again`);

const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>(resolve => { setImmediate(resolve); });
}

async function settleMirrors(): Promise<unknown> {
  try {
    await rowMirrorsWritten();
    return null;
  } catch (error) {
    return error ?? 'rejected';
  }
}

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  _resetRowQueue();
  fs.rmSync(dataPath('global', 'appstore', CATEGORY), { recursive: true, force: true });
  fs.rmSync(STORE_RECORD(), { force: true });
  fake = fakeBackend();
  store = fakeLanding();
  configureRowFlush({ backend: () => fake.backend });
  useStoreLanding(store.landing);
});

afterEach(() => {
  configureRowFlush({ backend: () => null });
  useStoreLanding(null);
  _resetRowQueue();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the flush's wait for the store mutex", () => {
  it('a wait that passed its bound is tried again on the backoff, 0.5 s then 1 s at the lowest jitter', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    store.answers.push('none', 'none', 'hold');
    const ticket = accept('wait.json', '{"w":1}');
    await flushRows();
    expect(store.s.acquires).toBe(1);
    expect(ticket.op.state).toBe('store');
    vi.advanceTimersByTime(499);
    expect(store.s.acquires).toBe(1);
    vi.advanceTimersByTime(1);
    expect(store.s.acquires).toBe(2);
    await rowMirrorsWritten();
    expect(ticket.op.state).toBe('store');
    vi.advanceTimersByTime(999);
    expect(store.s.acquires).toBe(2);
    vi.advanceTimersByTime(1);
    expect(store.s.acquires).toBe(3);
    await rowMirrorsWritten();
    expect(ticket.op.state).toBe('landed');
    expect(fs.readFileSync(fileOf('wait.json'), 'utf8')).toBe('{"w":1}');
  });

  it('a retry finds only an unsent op of the key: it takes no store mutex', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    store.answers.push('none');
    fake.control.fail = call => call > 1;
    const first = accept('unsent.json', '{"u":1}');
    await flushRows();
    expect(store.s.acquires).toBe(1);
    expect(await awaitStoreTicket(first, 1000)).toBe('landed');
    expect(first.op.state).toBe('landed');
    const next = accept('unsent.json', '{"u":2}', shaOf(buf('{"u":1}')));
    await flushRows();
    expect(next.op.state).toBe('queued');
    vi.advanceTimersByTime(500);
    await rowMirrorsWritten();
    expect(store.s.acquires).toBe(1);
    expect(fs.readFileSync(fileOf('unsent.json'), 'utf8')).toBe('{"u":1}');
  });

  it('a section that landed the op while the flush waited for the mutex leaves the flush nothing to do', async () => {
    let grant!: (answer: 'hold') => void;
    store.answers.push(new Promise<'hold'>(resolve => { grant = resolve; }));
    const ticket = accept('section.json', '{"s":1}');
    for (let i = 0; i < 50 && store.s.acquires === 0; i++) await ticks(1);
    expect(store.s.acquires).toBe(1);
    expect(ticket.op.state).toBe('store');
    expect(await awaitStoreTicket(ticket, 1000)).toBe('landed');
    expect(store.s.locks).toBe(1);
    const run = rowMirrorsWritten();
    expect(run).not.toBeNull();
    grant('hold');
    expect(await settleMirrors()).toBeNull();
    expect(store.s.locks).toBe(1);
    expect(store.s.releases).toBe(1);
    expect(errors).toEqual([]);
    expect(fs.readFileSync(fileOf('section.json'), 'utf8')).toBe('{"s":1}');
  });
});

describe('the waiters of an App Store op', () => {
  it('a landing block that fails wakes the waiter, which answers landed', async () => {
    store.s.failing = eacces();
    const ticket = accept('woke.json', '{"o":1}');
    let outcome: unknown = null;
    void rowOutcome(ticket).then(o => { outcome = o; });
    await flushRows();
    await ticks(3);
    expect(ticket.op.state).toBe('mirror');
    expect(outcome).toBe('landed');
    expect(copyLines('woke.json')).toHaveLength(1);
  });

  it('a landing block the flush ran wakes the waiter, which answers landed', async () => {
    const ticket = accept('done.json', '{"d":1}');
    let outcome: unknown = null;
    void rowOutcome(ticket).then(o => { outcome = o; });
    await flushRows();
    await ticks(3);
    expect(ticket.op.state).toBe('landed');
    expect(outcome).toBe('landed');
    expect(fs.readFileSync(fileOf('done.json'), 'utf8')).toBe('{"d":1}');
  });
});

describe('a failed landing block after one that succeeded', () => {
  it('logs its line again and is tried again after 1 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    store.s.failing = eacces();
    const first = accept('again.json', '{"a":1}');
    await flushRows();
    expect(first.op.state).toBe('mirror');
    expect(copyLines('again.json')).toHaveLength(1);
    store.s.failing = NONE;
    vi.advanceTimersByTime(1000);
    await rowMirrorsWritten();
    expect(first.op.state).toBe('landed');
    expect(fs.readFileSync(fileOf('again.json'), 'utf8')).toBe('{"a":1}');

    store.s.failing = eacces();
    const next = accept('again.json', '{"a":2}', shaOf(buf('{"a":1}')));
    await flushRows();
    expect(next.op.state).toBe('mirror');
    expect(copyLines('again.json')).toHaveLength(2);
    store.s.failing = NONE;
    vi.advanceTimersByTime(999);
    expect(rowMirrorsWritten()).toBeNull();
    vi.advanceTimersByTime(1);
    const retry = rowMirrorsWritten();
    expect(retry).not.toBeNull();
    await retry;
    expect(next.op.state).toBe('landed');
    expect(fs.readFileSync(fileOf('again.json'), 'utf8')).toBe('{"a":2}');
  });
});
