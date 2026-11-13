import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { rerunUpdate } from '../../src/bot/internalSetup/utils/dataManager';
import { oversizeFailure, type SharedStatement, type SharedTxOutcome, type SharedTxSpec } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import {
  _resetRowQueue,
  APPEND_SQL,
  CHECKED_SQL,
  configureRowFlush,
  DELETE_SQL,
  flushRows,
  LOCK_SQL,
  NOTIFY_SQL,
  OP_SQL,
  OPS_SQL,
  rowOutcome,
  rowQueue,
  setCheckedKeyApplier,
  UPSERT_SQL,
  type RowBackend,
  type RowTicket,
} from '../../src/bot/internalSetup/utils/sharedStore';
import { FLUSH_STATEMENT_BYTES } from '../../src/bot/internalSetup/utils/storableData';
import { dataPath } from '../../src/utils/dataRoot';

// L5 run A, chunk ro2: what the row flush sends and stores for a doc op: the rows it reads, the locks and checks it
// takes, the pieces of a large body, a delete's notification and the re-run of an update on a newer stored version.

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

interface Row { body: unknown; sha: string; updated_by: string | null; updated_at: Date; rev: number }

let docs: Map<string, Row>;
let sent: Array<{ text: string; values: unknown[] }>;
let opIds: unknown[];
let rev: number;
let deleteRows: ((key: string) => any[]) | null;
let outcomes: Array<SharedTxOutcome<any>>;
const NOW = new Date('2026-11-13T09:00:00.000Z');

function answer(st: { text: string; values: unknown[] }): { rows: any[] } {
  const key = st.values[0] as string;
  const row = docs.get(key);
  switch (st.text) {
    case LOCK_SQL: return { rows: [{ now: NOW }] };
    case OPS_SQL: return { rows: [] };
    case CHECKED_SQL: return { rows: row ? [{ sha: row.sha, updated_by: row.updated_by, updated_at: row.updated_at }] : [] };
    case UPSERT_SQL: {
      rev += 1;
      docs.set(key, { body: Buffer.from(st.values[1] as Buffer), sha: st.values[2] as string, updated_by: st.values[3] as string, updated_at: NOW, rev });
      return { rows: [{ rev: String(rev) }] };
    }
    case APPEND_SQL: {
      row!.body = Buffer.concat([row!.body as Buffer, st.values[1] as Buffer]);
      return { rows: [] };
    }
    case DELETE_SQL: {
      if (deleteRows) return { rows: deleteRows(key) };
      docs.delete(key);
      return { rows: row ? [{ rev: String(row.rev) }] : [] };
    }
    case OP_SQL: opIds.push(...st.values); return { rows: [] };
    case NOTIFY_SQL: return { rows: [] };
    default:
      if (st.text.startsWith('SELECT body, sha')) return { rows: row ? [{ body: row.body, sha: row.sha, updated_by: row.updated_by, updated_at: row.updated_at }] : [] };
      return { rows: [] };
  }
}

/** The shared transaction as PostgresBackend.sharedTx runs it: each answer goes to next, a throw there or an oversized statement fails the build. */
async function sharedTx<S>(spec: SharedTxSpec<S>): Promise<SharedTxOutcome<S>> {
  const queued = outcomes.shift();
  if (queued) return queued as SharedTxOutcome<S>;
  let checkRows: any[] | null = null;
  if (spec.check) checkRows = spec.check.map(st => { sent.push(st); return answer(st); });
  let plan: ReturnType<SharedTxSpec<S>['statements']>;
  try {
    plan = spec.statements(checkRows);
  } catch (error) {
    return { kind: 'failed', step: 'build', detail: String(error) };
  }
  if (plan === 'landed') return { kind: 'landed' };
  if (!Array.isArray(plan)) return { kind: 'stopped', value: plan.stop };
  const queue: SharedStatement<S>[] = [...plan];
  const results: any[] = [];
  while (queue.length > 0) {
    const st = queue.shift()!;
    const oversize = oversizeFailure(st);
    if (oversize) return oversize;
    sent.push(st);
    const res = answer(st);
    results.push(res);
    if (!st.next) continue;
    let after: ReturnType<NonNullable<SharedStatement<S>['next']>>;
    try {
      after = st.next(res as any);
    } catch (error) {
      return { kind: 'failed', step: 'build', detail: error instanceof Error ? error.message : String(error) };
    }
    if (Array.isArray(after)) queue.unshift(...after);
    else if (after) return { kind: 'stopped', value: after.stop };
  }
  spec.onCommitSent?.();
  return { kind: 'committed', results };
}

let n = 0;
const keyOf = (name: string) => `global/ro2/${name}`;
const fileOf = (key: string) => dataPath(...key.split('/'));
const newKey = () => keyOf(`doc${++n}.json`);
const storedRow = (body: unknown, rowSha: string, by: string | null = 'node-b/77'): Row => ({ body, sha: rowSha, updated_by: by, updated_at: NOW, rev: 3 });

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetRowQueue();
  docs = new Map();
  sent = [];
  opIds = [];
  rev = 10;
  deleteRows = null;
  outcomes = [];
  fs.mkdirSync(fileOf(keyOf('')), { recursive: true });
  configureRowFlush({ backend: () => ({ sharedTx } as unknown as RowBackend), rerun: rerunUpdate });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  setCheckedKeyApplier(null);
  _resetRowQueue();
  configureRowFlush({ backend: () => null });
});

const write = (key: string, body: Buffer | null, base: string, more: Record<string, unknown> = {}): RowTicket =>
  rowQueue.accept(key, fileOf(key), { body, ...more } as any, { sha: base, caller: false });

describe('a stored row the driver answers in another form', () => {
  it('a body answered as text is stored as its UTF-8 bytes', async () => {
    const key = newKey();
    const text = '{"a":"' + String.fromCharCode(0xe9) + '"}';
    docs.set(key, storedRow(text, sha(Buffer.from(text, 'utf8'))));
    const ticket = write(key, Buffer.from(text, 'utf8'), sha(Buffer.from(text, 'utf8')));
    await flushRows();
    expect(await rowOutcome(ticket)).toBe('landed');
    expect(ticket.op.body!.equals(Buffer.from(text, 'utf8'))).toBe(true);
    expect(fs.readFileSync(fileOf(key), 'utf8')).toBe(text);
  });

  it('a body answered as null is the empty body: the mirror is written empty', async () => {
    const key = newKey();
    docs.set(key, storedRow(null, sha('')));
    const ticket = write(key, Buffer.alloc(0), sha(''));
    await flushRows();
    expect(await rowOutcome(ticket)).toBe('landed');
    expect(ticket.op.body!.length).toBe(0);
    expect(fs.readFileSync(fileOf(key)).length).toBe(0);
  });

  it('a newer row with no writer named: the refusal names no machine', async () => {
    const key = newKey();
    docs.set(key, storedRow(Buffer.from('{"v":2}'), sha('{"v":2}'), null));
    const ticket = write(key, Buffer.from('{"v":3}'), 'absent');
    expect(await rowOutcome(ticket)).toEqual({ refused: { cause: 'changed-elsewhere', by: '', at: NOW } });
    expect(warn).toHaveBeenCalledWith(`[Shared] Not saved: ${key}:  changed it at ${NOW.toISOString()} after this machine read it; this machine now holds that version`);
  });
});

describe('decision 102: the locks and checks of an op built on other keys', () => {
  const checkedWrite = (key: string, check: Record<string, string | null>): RowTicket =>
    rowQueue.accept(key, fileOf(key), { body: Buffer.from('{"m":1}') }, { sha: 'absent', caller: true, check });

  it('the locks go out in the sorted order of the keys, the op key among them', async () => {
    const key = keyOf('m.json');
    const ticket = checkedWrite(key, { [keyOf('b.json')]: null, [keyOf('a.json')]: null });
    await flushRows();
    expect(await rowOutcome(ticket)).toBe('landed');
    expect(sent.filter(st => st.text === LOCK_SQL).map(st => st.values[0])).toEqual([keyOf('a.json'), keyOf('b.json'), key]);
    expect(sent.filter(st => st.text === CHECKED_SQL).map(st => st.values[0])).toEqual([keyOf('a.json'), keyOf('b.json')]);
  });

  it('two checked keys both changed: the refusal names the first in sorted order', async () => {
    const key = keyOf('m.json');
    docs.set(keyOf('a.json'), storedRow(Buffer.from('1'), sha('1'), 'node-a/1'));
    docs.set(keyOf('b.json'), storedRow(Buffer.from('2'), sha('2'), 'node-b/2'));
    const applied: string[] = [];
    setCheckedKeyApplier(k => applied.push(k));
    const ticket = checkedWrite(key, { [keyOf('b.json')]: null, [keyOf('a.json')]: null });
    expect(await rowOutcome(ticket)).toEqual({ refused: { cause: 'changed-elsewhere', by: 'node-a', at: NOW } });
    expect(applied).toEqual([keyOf('a.json')]);
    expect(warn).toHaveBeenCalledWith(`[Shared] Not saved: ${key}: it was built on ${keyOf('a.json')}, which node-a changed at ${NOW.toISOString()} after this machine read it; this machine now holds that version`);
  });

  it('the landing check of an attempt of unknown fate checks the keys in sorted order and names the first changed', async () => {
    const key = keyOf('m.json');
    outcomes.push({ kind: 'unknown', detail: 'Connection terminated unexpectedly' });
    const ticket = checkedWrite(key, { [keyOf('b.json')]: null, [keyOf('a.json')]: null });
    await flushRows();
    expect(ticket.op.unknown.length).toBe(1);
    docs.set(keyOf('a.json'), storedRow(Buffer.from('1'), sha('1'), 'node-a/1'));
    docs.set(keyOf('b.json'), storedRow(Buffer.from('2'), sha('2'), 'node-b/2'));
    await flushRows();
    expect(await rowOutcome(ticket)).toEqual({ refused: { cause: 'changed-elsewhere', by: 'node-a', at: NOW } });
    expect(sent.filter(st => st.text === LOCK_SQL).map(st => st.values[0])).toEqual([keyOf('a.json'), keyOf('b.json'), key]);
    expect(sent.filter(st => st.text === CHECKED_SQL).map(st => st.values[0])).toEqual([keyOf('a.json'), keyOf('b.json')]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`it was built on ${keyOf('a.json')}, which node-a changed`));
  });

  it('a changed checked key with no writer named: the refusal and the log name no machine', async () => {
    const key = keyOf('m.json');
    docs.set(keyOf('a.json'), storedRow(Buffer.from('1'), sha('1'), null));
    const ticket = checkedWrite(key, { [keyOf('a.json')]: null });
    expect(await rowOutcome(ticket)).toEqual({ refused: { cause: 'changed-elsewhere', by: '', at: NOW } });
    expect(warn).toHaveBeenCalledWith(`[Shared] Not saved: ${key}: it was built on ${keyOf('a.json')}, which  changed at ${NOW.toISOString()} after this machine read it; this machine now holds that version`);
  });
});

describe('decision 5: an update re-run on a newer stored version', () => {
  const update = (fn: (c: any) => any, defaultValue: unknown) => ({ update: { fn, defaultValue } });

  it('a stored body that is no JSON refuses the op with the parse error, and nothing is stored', async () => {
    const key = newKey();
    docs.set(key, storedRow(Buffer.from('not json'), sha('not json')));
    let parseError = '';
    try { JSON.parse('not json'); } catch (error) { parseError = (error as Error).message; }
    const ticket = write(key, Buffer.from('{"n":1}'), sha('{"n":0}'), update(() => ({ n: 1 }), { n: 0 }));
    const outcome = await rowOutcome(ticket);
    expect(outcome).toEqual({
      refused: {
        cause: 'changed-elsewhere',
        reason: `${key}: the update could not be applied to the newer version another machine saved (${parseError})`,
        by: 'node-b',
        at: NOW,
      },
    });
    expect(sent.some(st => st.text === UPSERT_SQL)).toBe(false);
    expect((docs.get(key)!.body as Buffer).toString()).toBe('not json');
  });

  it('two joined updates with the row gone: the second runs on the first one\'s result, from the default', async () => {
    const key = newKey();
    const bump = (c: { n: number }) => ({ n: c.n + 1 });
    const first = write(key, Buffer.from('{"n":6}'), sha('{"n":5}'), update(bump, { n: 0 }));
    const second = write(key, Buffer.from('{"n":7}'), sha('{"n":5}'), update(bump, { n: 0 }));
    expect(second.op).toBe(first.op);
    await flushRows();
    expect(await rowOutcome(second)).toBe('landed');
    expect(JSON.parse((docs.get(key)!.body as Buffer).toString('utf8'))).toEqual({ n: 2 });
  });
});

describe("a delete's notification", () => {
  const notified = () => JSON.parse(sent.find(st => st.text === NOTIFY_SQL)!.values[0] as string);

  it('carries the rev the DELETE returned', async () => {
    const key = newKey();
    docs.set(key, { ...storedRow(Buffer.from('x'), sha('x')), rev: 7 });
    const ticket = write(key, null, sha('x'));
    await flushRows();
    expect(await rowOutcome(ticket)).toBe('landed');
    expect(docs.has(key)).toBe(false);
    expect(notified()).toMatchObject({ k: 'doc', key, sha: 'absent', rev: 7 });
  });

  it('a DELETE that finds the row already gone still commits, with rev 0', async () => {
    const key = newKey();
    docs.set(key, storedRow(Buffer.from('x'), sha('x')));
    deleteRows = k => { docs.delete(k); return []; };
    const ticket = write(key, null, sha('x'));
    await flushRows();
    expect(await rowOutcome(ticket)).toBe('landed');
    expect(notified()).toMatchObject({ k: 'doc', key, sha: 'absent', rev: 0 });
  });
});

describe('C4: a body past the statement bound goes out in pieces', () => {
  it('every statement stays within the bound and the pieces store the body whole', async () => {
    const key = newKey();
    const body = Buffer.alloc(2 * FLUSH_STATEMENT_BYTES + 1000);
    for (let i = 0; i < body.length; i++) body[i] = 97 + (i % 26);
    const ticket = write(key, body, 'absent');
    await flushRows();
    expect(await rowOutcome(ticket)).toBe('landed');
    expect(sent.filter(st => st.text === APPEND_SQL).length).toBe(2);
    for (const st of sent) expect(oversizeFailure(st)).toBeNull();
    expect((docs.get(key)!.body as Buffer).equals(body)).toBe(true);
  });
});

describe('decision 47: a no-change write with carried lines', () => {
  it('stores its op id with no doc write', async () => {
    const key = newKey();
    docs.set(key, storedRow(Buffer.from('{"same":1}'), sha('{"same":1}')));
    const ticket = write(key, Buffer.from('{"same":1}'), sha('{"same":1}'), {
      lines: { key: keyOf('audit.jsonl'), lines: [{ id: 'line-1', line: Buffer.from('{"e":1}') }] },
    });
    await flushRows();
    expect(await rowOutcome(ticket)).toBe('landed');
    expect(sent.some(st => st.text === UPSERT_SQL || st.text === NOTIFY_SQL)).toBe(false);
    expect(opIds).toHaveLength(1);
    expect(opIds[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
