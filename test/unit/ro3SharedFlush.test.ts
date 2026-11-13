import fs from 'fs';
import { createHash } from 'crypto';
import type { QueryResult } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dataPath } from '../../src/utils/dataRoot';
import { cancelQueued } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { sharedPlan, type SharedTxOutcome, type SharedTxSpec } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import {
  APPEND_SQL, CHECKED_SQL, DELETE_SQL, LOCK_SQL, OP_SQL, OPS_SQL, UPSERT_SQL,
  _resetRowQueue, configureRowFlush, flushRows, rowChange, rowCommitOwed, rowOpsLanded, rowOutcome, rowQueue, rowTicketState,
  unconfirmUnansweredRows, unknownTooOld, type RowBackend, type RowTicket, type RowWork,
} from '../../src/bot/internalSetup/utils/sharedStore';

// L5 run A, chunk 3 of sharedStore.ts: the row flush's landing check, how a try's outcome settles an op, the refusal
// that takes the plain ops built on a refused body, and the exit drain's unconfirmed ops. The flush runs over a fake
// row backend that answers the shared statements from an in-memory shared_docs and shared_ops.

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const DOC_PREFIX = 'SELECT body, sha, updated_by, updated_at FROM smdb_data.shared_docs';

interface Row { body: Buffer; sha: string; updated_by: string; updated_at: Date }
type Step = 'commit' | 'lose' | 'drop' | SharedTxOutcome<any> | ((spec: SharedTxSpec<any>) => SharedTxOutcome<any> | Promise<SharedTxOutcome<any>>);

const db = {
  docs: new Map<string, Row>(),
  ops: new Set<string>(),
  now: new Date('2026-11-13T10:00:00.000Z'),
  lockRows: null as any[] | null,
  script: [] as Step[],
};

const result = (rows: any[]): QueryResult => ({ rows, rowCount: rows.length, command: '', oid: 0, fields: [] }) as QueryResult;

function answer(text: string, values: unknown[], tx: { docs: Map<string, Row | null>; ops: string[] }): any[] {
  const view = (key: unknown): Row | null => {
    const k = String(key);
    if (tx.docs.has(k)) return tx.docs.get(k) ?? null;
    return key === undefined ? null : db.docs.get(k) ?? null;
  };
  if (text === LOCK_SQL) return db.lockRows ?? [{ now: db.now }];
  if (text === OPS_SQL) return (values[0] as string[]).filter(id => db.ops.has(id)).map(id => ({ id }));
  if (text === CHECKED_SQL) {
    const r = view(values[0]);
    return r ? [{ sha: r.sha, updated_by: r.updated_by, updated_at: r.updated_at }] : [];
  }
  if (text.startsWith(DOC_PREFIX)) {
    const r = view(values[0]);
    return r ? [{ ...r }] : [];
  }
  if (text === UPSERT_SQL) {
    tx.docs.set(String(values[0]), { body: Buffer.from(values[1] as Buffer), sha: String(values[2]), updated_by: String(values[3]), updated_at: db.now });
    return [{ rev: '1' }];
  }
  if (text === APPEND_SQL) {
    const r = view(values[0])!;
    tx.docs.set(String(values[0]), { ...r, body: Buffer.concat([r.body, values[1] as Buffer]) });
    return [];
  }
  if (text === DELETE_SQL) {
    tx.docs.set(String(values[0]), null);
    return [{ rev: '1' }];
  }
  if (text === OP_SQL) {
    tx.ops.push(String(values[0]));
    return [];
  }
  return [];
}

async function runSpec(spec: SharedTxSpec<any>, mode: 'commit' | 'lose' | 'drop'): Promise<SharedTxOutcome<any>> {
  const tx = { docs: new Map<string, Row | null>(), ops: [] as string[] };
  const plan = spec.check === null
    ? sharedPlan(() => spec.statements(null))
    : sharedPlan(() => spec.statements(spec.check!.map(st => result(answer(st.text, st.values, tx)))));
  if (!Array.isArray(plan)) return plan;
  const queue = [...plan];
  while (queue.length > 0) {
    const st = queue.shift()!;
    const res = result(answer(st.text, st.values, tx));
    if (!st.next) continue;
    let after: ReturnType<NonNullable<typeof st.next>>;
    try {
      after = st.next(res);
    } catch (error) {
      return { kind: 'failed', step: 'build', detail: (error as Error).message };
    }
    if (Array.isArray(after)) queue.unshift(...after);
    else if (after) return { kind: 'stopped', value: after.stop };
  }
  spec.onCommitSent?.();
  if (mode !== 'drop') {
    for (const [key, row] of tx.docs) {
      if (row) db.docs.set(key, row);
      else db.docs.delete(key);
    }
    for (const id of tx.ops) db.ops.add(id);
  }
  return mode === 'commit' ? { kind: 'committed', results: [] } : { kind: 'unknown' };
}

const fake: RowBackend = {
  async sharedTx<S>(spec: SharedTxSpec<S>): Promise<SharedTxOutcome<S>> {
    const step = db.script.shift() ?? 'commit';
    if (typeof step === 'function') return await step(spec) as SharedTxOutcome<S>;
    if (typeof step === 'object') return step as SharedTxOutcome<S>;
    return await runSpec(spec, step) as SharedTxOutcome<S>;
  },
};

const work: RowWork = {
  bytes: 4,
  spec: (op, attemptId, noteNow) => ({
    check: null,
    statements: () => [
      { text: LOCK_SQL, values: [op.key], next: res => { noteNow(res.rows[0]?.now ?? null); } },
      { text: OP_SQL, values: [attemptId] },
    ],
  }),
};

const fileOf = (name: string) => dataPath('global', 'ro3', name);
const keyOf = (name: string) => `global/ro3/${name}`;
const body = (value: unknown) => Buffer.from(JSON.stringify(value));
const buildFailed = { kind: 'failed', step: 'build', detail: 'a statement carries too many bytes; it was not sent' } as const;
const ioRefusal = { cause: 'io', reason: buildFailed.detail };

function put(name: string, bytes: Buffer): void {
  db.docs.set(keyOf(name), { body: bytes, sha: sha(bytes), updated_by: 'other-node/p1', updated_at: new Date('2026-11-12T09:00:00.000Z') });
}

function accept(name: string, bytes: Buffer | null, base: string, check?: Record<string, string | null>): RowTicket {
  return rowQueue.accept(keyOf(name), fileOf(name), { body: bytes }, { sha: base, caller: true, ...(check ? { check } : {}) });
}

async function ticks(until: () => boolean, max = 100): Promise<void> {
  for (let i = 0; i < max && !until(); i++) await new Promise<void>(resolve => { setImmediate(resolve); });
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetRowQueue();
  db.docs.clear();
  db.ops.clear();
  db.lockRows = null;
  db.script = [];
  configureRowFlush({ backend: () => fake });
  fs.mkdirSync(dataPath('global', 'ro3'), { recursive: true });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  _resetRowQueue();
  configureRowFlush({ backend: () => null, rerun: () => ({ ok: false, reason: 'no update runner' }) });
  vi.restoreAllMocks();
});

describe('the landing check of an op whose first answer was lost', () => {
  it('stores the op when both checked keys still hold the versions it was built on', async () => {
    const c1 = body({ c: 1 });
    const c2 = body({ c: 2 });
    put('c1.json', c1);
    put('c2.json', c2);
    db.script = ['drop'];
    const t = accept('k1.json', body({ k: 1 }), 'absent', { [keyOf('c1.json')]: sha(c1), [keyOf('c2.json')]: sha(c2) });
    await flushRows();
    expect(t.op.unknown).toHaveLength(1);
    await flushRows();
    expect(await rowOutcome(t)).toBe('landed');
    expect(db.docs.get(keyOf('k1.json'))?.body.toString()).toBe('{"k":1}');
  });

  it('stores the op when the lock answers with no row for now()', async () => {
    db.lockRows = [];
    db.script = ['drop'];
    const t = accept('k2.json', body({ k: 2 }), 'absent');
    await flushRows();
    expect(t.op.unknown).toHaveLength(1);
    await flushRows();
    expect(await rowOutcome(t)).toBe('landed');
    expect(db.docs.get(keyOf('k2.json'))?.body.toString()).toBe('{"k":2}');
  });

  it('a cancel whose check finds no earlier attempt stored cancels the op and stores nothing', async () => {
    db.script = ['drop'];
    const t = accept('k3.json', body({ k: 3 }), 'absent');
    await flushRows();
    expect(t.op.unknown).toHaveLength(1);
    const answers = await cancelQueued([fileOf('k3.json')]);
    expect(answers).toEqual([{ path: fileOf('k3.json'), outcome: 'cancelled', errno: 'no answer', row: true }]);
    expect(db.docs.has(keyOf('k3.json'))).toBe(false);
    expect(rowTicketState(t)).toBe('refused');
  });

  it('an op frozen while its check is on the wire wakes its waiters when the check ends', async () => {
    db.script = ['drop'];
    const t = accept('k4.json', body({ k: 4 }), 'absent');
    await flushRows();
    expect(t.op.unknown).toHaveLength(1);
    let woke = false;
    void rowChange(t).then(() => { woke = true; });
    db.script = [spec => {
      t.op.frozen = true;
      return runSpec(spec, 'commit');
    }];
    await flushRows();
    await ticks(() => woke, 5);
    expect(woke).toBe(true);
    expect(t.op.state).toBe('queued');
    expect(db.docs.has(keyOf('k4.json'))).toBe(false);
  });

  it('a lost answer with no detail is reported as "no answer" when the cancel cannot check it', async () => {
    db.script = ['drop', { kind: 'failed', step: 'check', detail: 'SQLSTATE 57P01: terminating connection', code: '57P01' }];
    const t = accept('k5.json', body({ k: 5 }), 'absent');
    await flushRows();
    expect(t.op.lostCause).toBe('no answer');
    const answers = await cancelQueued([fileOf('k5.json')]);
    expect(answers).toEqual([{ path: fileOf('k5.json'), outcome: 'unconfirmed', errno: 'no answer', cut: false, row: true }]);
    expect(error.mock.calls.map((c: unknown[]) => String(c[0]))).toContain(
      `[Shared] Can't confirm whether ${keyOf('k5.json')} was saved: the database's answer to the save was lost and could not be checked (no answer)`,
    );
  });

  it('a delete found stored by the check records the key as absent', async () => {
    const x = body({ x: 1 });
    put('k6.json', x);
    fs.writeFileSync(fileOf('k6.json'), x);
    db.script = ['lose'];
    const t = accept('k6.json', null, sha(x));
    await flushRows();
    expect(t.op.unknown).toHaveLength(1);
    expect(db.docs.has(keyOf('k6.json'))).toBe(false);
    await flushRows();
    expect(rowTicketState(t)).toBe('landed');
    expect(t.op.stored?.sha).toBe('absent');
    expect(fs.existsSync(fileOf('k6.json'))).toBe(false);
  });

  it('a delete of a key no row holds is recorded as absent', async () => {
    const t = accept('k7.json', null, 'absent');
    await flushRows();
    expect(rowTicketState(t)).toBe('landed');
    expect(t.op.stored?.sha).toBe('absent');
  });
});

describe('how a try that ends without an outcome leaves the op', () => {
  it('a COMMIT answered with an error leaves no commit owed', async () => {
    db.script = [spec => {
      spec.onCommitSent?.();
      return { kind: 'failed', step: 'statements', detail: 'SQLSTATE 40001: could not serialize access', code: '40001' };
    }];
    const t = accept('f1.json', body({ f: 1 }), 'absent');
    await flushRows();
    expect(t.op.state).toBe('queued');
    expect(rowCommitOwed(t)).toBe(false);
  });

  it('a build failure refuses the op with cause io and its detail', async () => {
    db.script = [buildFailed];
    const t = accept('f2.json', body({ f: 2 }), 'absent');
    await flushRows();
    expect(t.op.state).toBe('refused');
    expect(await rowOutcome(t)).toEqual({ refused: ioRefusal });
  });

  it('a check failure with a 54 code is tried again, not refused', async () => {
    db.script = [{ kind: 'failed', step: 'check', detail: 'SQLSTATE 54000: program limit exceeded', code: '54000' }];
    const t = accept('f3.json', body({ f: 3 }), 'absent');
    await flushRows();
    expect(t.op.state).toBe('queued');
    expect(t.op.refusal).toBeNull();
    expect(t.op.triesFailed).toBe(1);
  });

  it('a statement failure whose code only contains 23 past its start is tried again', async () => {
    db.script = [{ kind: 'failed', step: 'statements', detail: 'SQLSTATE 42723: function already exists', code: '42723' }];
    const t = accept('f4.json', body({ f: 4 }), 'absent');
    await flushRows();
    expect(t.op.state).toBe('queued');
    expect(t.op.refusal).toBeNull();
  });

  it('a failed try wakes the op\'s waiters', async () => {
    db.script = [{ kind: 'failed', step: 'connect', detail: 'connect ECONNREFUSED' }];
    const t = accept('f5.json', body({ f: 5 }), 'absent');
    let woke = false;
    void rowChange(t).then(() => { woke = true; });
    await flushRows();
    await ticks(() => woke, 5);
    expect(woke).toBe(true);
  });

  it('a failed try is tried again after its backoff even when the data pool was gone at its end', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let available = true;
    configureRowFlush({ backend: () => (available ? fake : null) });
    db.script = [() => {
      available = false;
      return { kind: 'failed', step: 'connect', detail: 'connect ECONNREFUSED' };
    }];
    const t = accept('f6.json', body({ f: 6 }), 'absent');
    await flushRows();
    expect(t.op.state).toBe('queued');
    available = true;
    await vi.advanceTimersByTimeAsync(1000);
    await ticks(() => rowTicketState(t) === 'landed');
    expect(rowTicketState(t)).toBe('landed');
    expect(db.docs.get(keyOf('f6.json'))?.body.toString()).toBe('{"f":6}');
  });

  it('a refusal without a log line writes no warning', async () => {
    const t = accept('f7.json', body({ f: 7 }), sha('a version no row holds'));
    await flushRows();
    expect(t.op.state).toBe('refused');
    expect(t.op.refusal).toEqual({ cause: 'changed-elsewhere' });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('a lines key\'s op', () => {
  it('stored, it counts as landed and leaves the file at its path alone', async () => {
    fs.writeFileSync(fileOf('w1.jsonl'), 'keep\n');
    const before = rowOpsLanded();
    const t = rowQueue.acceptWork(keyOf('w1.jsonl'), fileOf('w1.jsonl'), work);
    await flushRows();
    expect(rowTicketState(t)).toBe('landed');
    expect(rowOpsLanded()).toBe(before + 1);
    expect(fs.readFileSync(fileOf('w1.jsonl'), 'utf8')).toBe('keep\n');
    expect(t.op.stored).toBeNull();
  });

  it('found stored by its landing check, it leaves the file at its path alone', async () => {
    fs.writeFileSync(fileOf('w2.jsonl'), 'keep\n');
    db.script = ['lose', { kind: 'landed' }];
    const t = rowQueue.acceptWork(keyOf('w2.jsonl'), fileOf('w2.jsonl'), work);
    await flushRows();
    expect(t.op.unknown).toHaveLength(1);
    await flushRows();
    expect(rowTicketState(t)).toBe('landed');
    expect(fs.readFileSync(fileOf('w2.jsonl'), 'utf8')).toBe('keep\n');
    expect(t.op.stored).toBeNull();
  });

  it('a lost answer keeps the database\'s now() for the 6-day bound', async () => {
    db.script = ['drop'];
    const t = rowQueue.acceptWork(keyOf('w3.jsonl'), fileOf('w3.jsonl'), work);
    await flushRows();
    expect(t.op.unknown).toEqual([{ id: expect.any(String), at: db.now }]);
    expect(unknownTooOld(t.op, new Date(db.now.getTime() + 6 * 24 * 60 * 60 * 1000))).toBe(true);
  });
});

describe('a refused op takes the plain ops built on its body', () => {
  it('each op behind built on the one before is refused with the same refusal', async () => {
    const a = body({ v: 'a' });
    const b = body({ v: 'b' });
    db.script = [buildFailed];
    const ta = accept('r1.json', a, 'absent');
    const tb = accept('r1.json', b, sha(a));
    const tc = accept('r1.json', body({ v: 'c' }), sha(b));
    await flushRows();
    expect(ta.op.refusal).toEqual(ioRefusal);
    expect(tb.op.refusal).toEqual(ioRefusal);
    expect(tc.op.refusal).toEqual(ioRefusal);
  });

  it('a refused delete takes the op built on no file', async () => {
    const x = body({ v: 'x' });
    put('r2.json', x);
    db.script = [buildFailed];
    accept('r2.json', null, sha(x));
    const tb = accept('r2.json', body({ v: 'b' }), 'absent');
    await flushRows();
    expect(tb.op.refusal).toEqual(ioRefusal);
  });

  it('a delete taken with it passes the refusal to the op built on no file behind it', async () => {
    const a = body({ v: 'a' });
    db.script = [buildFailed];
    accept('r3.json', a, 'absent');
    const tb = accept('r3.json', null, sha(a));
    const tc = accept('r3.json', body({ v: 'c' }), 'absent');
    await flushRows();
    expect(tb.op.refusal).toEqual(ioRefusal);
    expect(tc.op.refusal).toEqual(ioRefusal);
  });

  it('an op behind built on another version is stored', async () => {
    db.script = [buildFailed];
    const ta = accept('r4.json', body({ v: 'a' }), 'absent');
    const tb = accept('r4.json', body({ v: 'b' }), 'absent');
    await flushRows();
    expect(ta.op.refusal).toEqual(ioRefusal);
    expect(await rowOutcome(tb)).toBe('landed');
    expect(db.docs.get(keyOf('r4.json'))?.body.toString()).toBe('{"v":"b"}');
  });

  it('an update behind built on the refused body is run again and stored', async () => {
    configureRowFlush({ rerun: (_what, fn, stored) => { const value = fn(stored); return { ok: true, text: JSON.stringify(value), value }; } });
    const a = body({ n: 1 });
    db.script = [buildFailed];
    accept('r5.json', a, 'absent');
    const tb = rowQueue.accept(keyOf('r5.json'), fileOf('r5.json'), { body: body({ n: 2 }), update: { fn: cur => ({ ...cur, n: 2 }), defaultValue: {} } }, { sha: sha(a), caller: true });
    await flushRows();
    expect(await rowOutcome(tb)).toBe('landed');
    expect(db.docs.get(keyOf('r5.json'))?.body.toString()).toBe('{"n":2}');
  });

  it('a refused delete leaves a lines op behind it to be stored', async () => {
    db.script = [buildFailed];
    accept('r6.jsonl', null, 'absent');
    const tb = rowQueue.acceptWork(keyOf('r6.jsonl'), fileOf('r6.jsonl'), work);
    await flushRows();
    expect(await rowOutcome(tb)).toBe('landed');
  });

  it('a refused lines op takes no plain op behind it', async () => {
    db.script = [buildFailed];
    const ta = rowQueue.acceptWork(keyOf('r7.jsonl'), fileOf('r7.jsonl'), work);
    const tb = accept('r7.jsonl', Buffer.from('{"l":1}\n'), 'absent');
    await flushRows();
    expect(ta.op.refusal).toEqual(ioRefusal);
    expect(await rowOutcome(tb)).toBe('landed');
    expect(db.docs.get(keyOf('r7.jsonl'))?.body.toString()).toBe('{"l":1}\n');
  });
});

describe('the exit drain\'s end', () => {
  it('leaves an op whose landing check is on the wire to that check', async () => {
    db.script = ['drop'];
    const t = accept('e1.json', body({ e: 1 }), 'absent');
    await flushRows();
    expect(t.op.unknown).toHaveLength(1);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    db.script = [async spec => {
      await gate;
      return runSpec(spec, 'commit');
    }];
    const flushing = flushRows();
    expect(t.op.state).toBe('wire');
    unconfirmUnansweredRows('the exit drain ended');
    expect(t.op.state).toBe('wire');
    expect(error).not.toHaveBeenCalled();
    release();
    await flushing;
    expect(await rowOutcome(t)).toBe('landed');
  });
});
