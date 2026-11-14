import fs from 'fs';
import { createHash } from 'crypto';
import type { QueryResult } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dataPath } from '../../src/utils/dataRoot';
import { cancelQueued } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { sharedPlan, type SharedTxOutcome, type SharedTxSpec } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import {
  APPEND_SQL, CHECKED_SQL, DELETE_SQL, LOCK_SQL, OP_SQL, OPS_SQL, UNKNOWN_TOO_OLD, UPSERT_SQL,
  _resetRowQueue, awaitStoreTicket, configureRowFlush, flushRows, rowMirrorsWritten, rowOpenPaths, rowOutcome, rowQueue,
  rowTicketState, unconfirmUnansweredRows, useOutsideChain, useStoreLanding, withMirrorLock,
  type RowBackend, type RowTicket, type RowWork, type StoreLanding,
} from '../../src/bot/internalSetup/utils/sharedStore';

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const DOC_PREFIX = 'SELECT body, sha, updated_by, updated_at FROM smdb_data.shared_docs';

interface Row { body: Buffer; sha: string; updated_by: string; updated_at: Date }
type Step = 'commit' | 'lose' | 'drop' | SharedTxOutcome<any> | ((spec: SharedTxSpec<any>) => SharedTxOutcome<any> | Promise<SharedTxOutcome<any>>);

const db = {
  docs: new Map<string, Row>(),
  ops: new Set<string>(),
  now: new Date('2026-11-13T10:00:00.000Z'),
  script: [] as Step[],
};

const result = (rows: any[]): QueryResult => ({ rows, rowCount: rows.length, command: '', oid: 0, fields: [] }) as QueryResult;

function answer(text: string, values: unknown[], tx: { docs: Map<string, Row | null>; ops: string[] }): any[] {
  const view = (key: unknown): Row | null => {
    const k = String(key);
    if (tx.docs.has(k)) return tx.docs.get(k) ?? null;
    return db.docs.get(k) ?? null;
  };
  if (text === LOCK_SQL) return [{ now: db.now }];
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
    const after = st.next(res);
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

/** A transaction that waits on the wire until open() is called, then runs as mode says. */
function gated(mode: 'commit' | 'lose' | 'drop' = 'commit') {
  let open!: () => void;
  const released = new Promise<void>(resolve => { open = resolve; });
  const g = {
    started: false,
    open: () => open(),
    step: (async (spec: SharedTxSpec<any>) => {
      g.started = true;
      await released;
      return runSpec(spec, mode);
    }) as Step,
  };
  return g;
}

const fileOf = (name: string) => dataPath('global', 'rp3', name);
const keyOf = (name: string) => `global/rp3/${name}`;
const storeFileOf = (name: string) => dataPath('global', 'appstore', name);
const storeKeyOf = (name: string) => `global/appstore/${name}`;
const body = (value: unknown) => Buffer.from(JSON.stringify(value));

function accept(name: string, bytes: Buffer | null, base: string): RowTicket {
  return rowQueue.accept(keyOf(name), fileOf(name), { body: bytes }, { sha: base, caller: true });
}

function acceptStore(name: string, bytes: Buffer | null, base: string): RowTicket {
  return rowQueue.accept(storeKeyOf(name), storeFileOf(name), { body: bytes }, { sha: base, caller: true });
}

async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise<void>(resolve => { setImmediate(resolve); });
}

const turns = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise<void>(resolve => { setImmediate(resolve); });
};

let errors: ReturnType<typeof vi.spyOn>;
const errorLines = (): string[] => errors.mock.calls.map((c: unknown[]) => String(c[0]));

beforeEach(() => {
  _resetRowQueue();
  db.docs.clear();
  db.ops.clear();
  db.now = new Date('2026-11-13T10:00:00.000Z');
  db.script = [];
  configureRowFlush({ backend: () => fake });
  fs.mkdirSync(dataPath('global', 'rp3'), { recursive: true });
  fs.mkdirSync(dataPath('global', 'appstore', 'cache'), { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  _resetRowQueue();
  useOutsideChain(null);
  useStoreLanding(null);
  configureRowFlush({ backend: () => null, rerun: () => ({ ok: false, reason: 'no update runner' }) });
  vi.restoreAllMocks();
});

describe("the web UI chain's cancel and the ops it accepted outside its chain", () => {
  it('leaves an outside op alone, does not list its path, and the op is stored later', async () => {
    configureRowFlush({ backend: () => null });
    useOutsideChain(() => true);
    const outside = accept('o1.json', body({ o: 1 }), 'absent');
    useOutsideChain(null);
    await turns(2);
    expect(rowOpenPaths()).toEqual([]);
    const answers = await cancelQueued([fileOf('o1.json')]);
    expect(answers).toEqual([{ path: fileOf('o1.json'), outcome: 'landed' }]);
    expect(outside.op.frozen).toBe(false);
    expect(outside.op.state).toBe('queued');
    configureRowFlush({ backend: () => fake });
    await flushRows();
    expect(rowTicketState(outside)).toBe('landed');
    expect(db.docs.get(keyOf('o1.json'))?.body.toString()).toBe('{"o":1}');
  });

  it('lists the path of an op of its own chain', async () => {
    configureRowFlush({ backend: () => null });
    accept('o2.json', body({ o: 2 }), 'absent');
    useOutsideChain(() => true);
    accept('o3.json', body({ o: 3 }), 'absent');
    useOutsideChain(null);
    expect(rowOpenPaths()).toEqual([fileOf('o2.json')]);
  });
});

describe('a cancel that waits for an attempt on the wire', () => {
  it('answers as soon as the attempt ends, with no timer of its own', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const g = gated();
    db.script = [g.step];
    const t = accept('w1.json', body({ w: 1 }), 'absent');
    await until(() => g.started);
    let answers: unknown = null;
    void cancelQueued([fileOf('w1.json')]).then(a => { answers = a; });
    await turns(3);
    expect(answers).toBeNull();
    g.open();
    await until(() => answers !== null, 300);
    expect(answers).toEqual([{ path: fileOf('w1.json'), outcome: 'landed', row: true }]);
    expect(rowTicketState(t)).toBe('landed');
  });

  it('answers landed for an op that was stored and written while the cancel waited on another path', async () => {
    const gx = gated();
    const gy = gated();
    db.script = [gx.step, gy.step];
    const x = accept('x.json', body({ x: 1 }), 'absent');
    const y = accept('y.json', body({ y: 1 }), 'absent');
    await until(() => gx.started && gy.started);
    const pending = cancelQueued([fileOf('x.json'), fileOf('y.json')]);
    gy.open();
    await until(() => y.op.state === 'landed');
    expect(y.op.state).toBe('landed');
    gx.open();
    expect(await pending).toEqual([
      { path: fileOf('x.json'), outcome: 'landed', row: true },
      { path: fileOf('y.json'), outcome: 'landed', row: true },
    ]);
    expect(rowTicketState(x)).toBe('landed');
    expect(rowTicketState(y)).toBe('landed');
    expect(fs.readFileSync(fileOf('y.json'), 'utf8')).toBe('{"y":1}');
  });

  it('answers unconfirmed when the flush check on the wire found the lost attempt too old', async () => {
    db.script = ['drop'];
    const t = accept('u1.json', body({ u: 1 }), 'absent');
    await flushRows();
    expect(t.op.unknown).toHaveLength(1);
    db.now = new Date(db.now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const g = gated();
    db.script = [g.step];
    const flushed = flushRows();
    await until(() => g.started);
    const pending = cancelQueued([fileOf('u1.json')]);
    g.open();
    expect(await pending).toEqual([{ path: fileOf('u1.json'), outcome: 'unconfirmed', errno: 'no answer', cut: false, row: true }]);
    await flushed;
    expect(rowTicketState(t)).toBe('unconfirmed');
    expect(errorLines()).toContain(
      `[Shared] Can't confirm whether ${keyOf('u1.json')} was saved: the database's answer to the save was lost and could not be checked (${UNKNOWN_TOO_OLD})`,
    );
  });

  it('answers "no answer" for an op that ended unconfirmed with no cause recorded', async () => {
    const g = gated();
    db.script = [g.step];
    const work: RowWork = {
      bytes: 4,
      spec: op => ({
        check: null,
        statements: () => [{ text: LOCK_SQL, values: [op.key], next: () => ({ stop: { kind: 'unconfirmed', cause: 'the lines lock answered nothing' } }) }],
      }),
    };
    const t = rowQueue.acceptWork(keyOf('l1.jsonl'), fileOf('l1.jsonl'), work);
    await until(() => g.started);
    const pending = cancelQueued([fileOf('l1.jsonl')]);
    g.open();
    expect(await pending).toEqual([{ path: fileOf('l1.jsonl'), outcome: 'unconfirmed', errno: 'no answer', cut: false, row: true }]);
    expect(rowTicketState(t)).toBe('unconfirmed');
  });

  it('answers cancelled with the refusal of an op refused while the cancel waited', async () => {
    const other = body({ r: 'other' });
    db.docs.set(keyOf('r1.json'), { body: other, sha: sha(other), updated_by: 'other-node/p1', updated_at: new Date('2026-11-12T09:00:00.000Z') });
    const g = gated();
    db.script = [g.step];
    const t = accept('r1.json', body({ r: 1 }), 'absent');
    await until(() => g.started);
    const pending = cancelQueued([fileOf('r1.json')]);
    g.open();
    expect(await pending).toEqual([{ path: fileOf('r1.json'), outcome: 'cancelled', errno: 'changed-elsewhere', row: true }]);
    expect(await rowOutcome(t)).toEqual({ refused: { cause: 'changed-elsewhere', by: 'other-node', at: new Date('2026-11-12T09:00:00.000Z') } });
    expect(db.docs.get(keyOf('r1.json'))?.body.toString()).toBe('{"r":"other"}');
  });
});

describe("the cancel's landing check of an op whose answer was lost", () => {
  it('cancels an op the check found unstored, and logs no unconfirmed line', async () => {
    db.script = ['drop'];
    const t = accept('c1.json', body({ c: 1 }), 'absent');
    await flushRows();
    expect(t.op.unknown).toHaveLength(1);
    const answers = await cancelQueued([fileOf('c1.json')]);
    expect(answers).toEqual([{ path: fileOf('c1.json'), outcome: 'cancelled', errno: 'no answer', row: true }]);
    expect(rowTicketState(t)).toBe('refused');
    expect(db.docs.has(keyOf('c1.json'))).toBe(false);
    expect(errorLines().filter(l => l.includes("Can't confirm"))).toEqual([]);
  });

  it('answers unconfirmed with cut false and logs it when the check gets no answer', async () => {
    db.script = ['drop', { kind: 'failed', step: 'check', detail: 'SQLSTATE 57P01: terminating connection', code: '57P01' }];
    const t = accept('c2.json', body({ c: 2 }), 'absent');
    await flushRows();
    const answers = await cancelQueued([fileOf('c2.json')]);
    expect(answers).toEqual([{ path: fileOf('c2.json'), outcome: 'unconfirmed', errno: 'no answer', cut: false, row: true }]);
    expect(rowTicketState(t)).toBe('unconfirmed');
    expect(errorLines()).toContain(
      `[Shared] Can't confirm whether ${keyOf('c2.json')} was saved: the database's answer to the save was lost and could not be checked (no answer)`,
    );
  });

  it('lets the next write of the key be stored by a later flush', async () => {
    const one = body({ n: 1 });
    db.script = ['lose'];
    const a = accept('n1.json', one, 'absent');
    await flushRows();
    expect(a.op.unknown).toHaveLength(1);
    expect(await cancelQueued([fileOf('n1.json')])).toEqual([{ path: fileOf('n1.json'), outcome: 'landed', row: true }]);
    const b = accept('n1.json', body({ n: 2 }), sha(one));
    await flushRows();
    expect(rowTicketState(b)).toBe('landed');
    expect(db.docs.get(keyOf('n1.json'))?.body.toString()).toBe('{"n":2}');
  });

  it('starts the write accepted behind the op once the check ends, with no further flush', async () => {
    const one = body({ q: 1 });
    db.script = ['lose'];
    const a = accept('q1.json', one, 'absent');
    await flushRows();
    const g = gated();
    db.script = [g.step];
    const pending = cancelQueued([fileOf('q1.json')]);
    await until(() => g.started);
    const b = accept('q1.json', body({ q: 2 }), sha(one));
    await turns(2);
    expect(b.op.attempts).toBe(0);
    g.open();
    expect(await pending).toEqual([{ path: fileOf('q1.json'), outcome: 'landed', row: true }]);
    expect(rowTicketState(a)).toBe('landed');
    await until(() => rowTicketState(b) === 'landed', 250);
    expect(rowTicketState(b)).toBe('landed');
    expect(db.docs.get(keyOf('q1.json'))?.body.toString()).toBe('{"q":2}');
  });

  it("makes a flush wait for the cancel's check of the key", async () => {
    db.script = ['lose'];
    accept('k1.json', body({ k: 1 }), 'absent');
    await flushRows();
    const g = gated();
    db.script = [g.step];
    const pending = cancelQueued([fileOf('k1.json')]);
    await until(() => g.started);
    let flushed = false;
    void flushRows().then(() => { flushed = true; });
    await turns(5);
    expect(flushed).toBe(false);
    g.open();
    await until(() => flushed);
    expect(flushed).toBe(true);
    expect(await pending).toEqual([{ path: fileOf('k1.json'), outcome: 'landed', row: true }]);
  });
});

describe("a section's wait for an App Store ticket", () => {
  const blockedMutex = () => {
    const acquired: number[] = [];
    const landing: StoreLanding = {
      acquire: boundMs => {
        acquired.push(boundMs);
        return new Promise(() => undefined);
      },
      locked: fn => fn(),
    };
    return { landing, acquired };
  };

  it("runs the landing block in the caller's hold for an op already stored", async () => {
    const { landing, acquired } = blockedMutex();
    useStoreLanding(landing);
    const t = acceptStore('s1.json', body({ s: 1 }), 'absent');
    await until(() => t.op.state === 'store');
    expect(t.op.state).toBe('store');
    expect(acquired).toHaveLength(1);
    expect(await awaitStoreTicket(t, 300)).toBe('landed');
    expect(fs.readFileSync(storeFileOf('s1.json'), 'utf8')).toBe('{"s":1}');
  });

  it('runs the landing block in the hold of a wait still running after an earlier wait of the same op ended', async () => {
    const { landing, acquired } = blockedMutex();
    useStoreLanding(landing);
    const g = gated();
    db.script = [g.step];
    const t = acceptStore('s2.json', body({ s: 2 }), 'absent');
    await until(() => g.started);
    let second: unknown = null;
    void awaitStoreTicket(t, 2000).then(r => { second = r; });
    await turns(2);
    expect(await awaitStoreTicket(t, 1)).toBe('open');
    g.open();
    await until(() => second !== null, 500);
    expect(second).toBe('landed');
    expect(acquired).toEqual([]);
    expect(fs.readFileSync(storeFileOf('s2.json'), 'utf8')).toBe('{"s":2}');
  });

  it("does not write an earlier op's pending mirror when the awaited op is not stored", async () => {
    let failOnce = true;
    const landing: StoreLanding = {
      acquire: async () => ({ release: () => undefined }),
      locked: fn => {
        if (failOnce) {
          failOnce = false;
          throw Object.assign(new Error('disk busy'), { code: 'EBUSY' });
        }
        return fn();
      },
    };
    useStoreLanding(landing);
    const one = body({ s: 3 });
    const a = acceptStore('s3.json', one, 'absent');
    await until(() => a.op.state === 'mirror');
    expect(a.op.state).toBe('mirror');
    configureRowFlush({ backend: () => null });
    const b = acceptStore('s3.json', body({ s: 4 }), sha(one));
    expect(await awaitStoreTicket(b, 1)).toBe('open');
    expect(a.op.state).toBe('mirror');
    expect(fs.existsSync(storeFileOf('s3.json'))).toBe(false);
  });

  it('answers unconfirmed for an op that ended unconfirmed', async () => {
    db.script = ['drop'];
    const t = acceptStore('s5.json', body({ s: 5 }), 'absent');
    await flushRows();
    unconfirmUnansweredRows('the exit drain ended');
    expect(await awaitStoreTicket(t, 200)).toBe('unconfirmed');
  });

  it('leaves no timer behind once the wait has its answer', async () => {
    const t = accept('t1.json', body({ t: 1 }), 'absent');
    await flushRows();
    expect(rowTicketState(t)).toBe('landed');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect(vi.getTimerCount()).toBe(0);
    expect(await awaitStoreTicket(t, 60_000)).toBe('landed');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the flush's mirror step", () => {
  it('a flush after a second landing waits for the mirror write of the later version', async () => {
    let open0!: () => void;
    let open1!: () => void;
    const gate0 = new Promise<void>(resolve => { open0 = resolve; });
    const gate1 = new Promise<void>(resolve => { open1 = resolve; });
    const key = keyOf('m1.json');
    const held0 = withMirrorLock(key, () => gate0);
    const one = body({ m: 1 });
    const a = accept('m1.json', one, 'absent');
    await until(() => a.op.state === 'mirror');
    expect(a.op.state).toBe('mirror');
    const held1 = withMirrorLock(key, () => gate1);
    const b = accept('m1.json', body({ m: 2 }), sha(one));
    await until(() => b.op.state === 'mirror');
    expect(b.op.state).toBe('mirror');
    open0();
    await held0;
    await until(() => a.op.state === 'landed');
    expect(a.op.state).toBe('landed');
    await turns(2);
    expect(rowMirrorsWritten()).not.toBeNull();
    const flushed = flushRows();
    open1();
    await held1;
    await flushed;
    expect(fs.readFileSync(fileOf('m1.json'), 'utf8')).toBe('{"m":2}');
    expect(b.op.state).toBe('landed');
  });
});
