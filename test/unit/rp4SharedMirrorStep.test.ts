import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { readDocRecord, writeDocRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import {
  _resetRowQueue, configureRowFlush, DELETE_SQL, flushRows, rowMirrorsWritten, rowQueue, rowTicketState, shaOf, UPSERT_SQL,
  type RowBackend, type RowTicket,
} from '../../src/bot/internalSetup/utils/sharedStore';
import type { SharedStatement, SharedTxOutcome, SharedTxSpec } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

// L5 run A, chunk rp4 (sharedStore.ts): the flush's mirror step of a doc key, its retry wait, its failure lines, and
// writeMirror's move aside, rewrite and unlink.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const CATEGORY = 'rp4mirror';
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const fileOf = (name: string) => dataPath('global', CATEGORY, name);
const buf = (text: string) => Buffer.from(text, 'utf8');
const RECORD = () => dataPath('.shared-mirror.json');

type Stored = { body: Buffer; sha: string; updated_by: string; updated_at: Date };
type Before = (call: number) => Promise<void> | 'fail' | void;

function fakeBackend() {
  const docs = new Map<string, Stored>();
  let calls = 0;
  const control: { before: Before } = { before: () => undefined };
  const backend: RowBackend = {
    async sharedTx<S>(spec: SharedTxSpec<S>): Promise<SharedTxOutcome<S>> {
      calls += 1;
      const act = control.before(calls);
      if (act === 'fail') return { kind: 'failed', step: 'connect', detail: 'connect ECONNREFUSED' };
      if (act) await act;
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
        } else if (st.text === DELETE_SQL) {
          const key = String(st.values[0]);
          const had = docs.has(key);
          writes.push(() => docs.delete(key));
          res = had ? { rows: [{ rev: '2' }], rowCount: 1 } : { rows: [], rowCount: 0 };
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
  return { backend, docs, control, calls: () => calls };
}

let fake: ReturnType<typeof fakeBackend>;
let errors: string[];
let warns: string[];

const accept = (name: string, body: string | null, base = 'absent'): RowTicket =>
  rowQueue.accept(keyOf(name), fileOf(name), { body: body === null ? null : buf(body) }, { sha: base, caller: false });

const savedLines = (name: string) =>
  errors.filter(l => l.startsWith(`[Shared] Saved ${keyOf(name)} in the database, but could not write ${fileOf(name)} (`));

const corruptRecord = () => fs.writeFileSync(RECORD(), '{');
const fixRecord = () => fs.rmSync(RECORD(), { force: true });

/** The moved-aside copies of name under /data/_superseded, by absolute path. */
function superseded(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  const root = dataPath('_superseded');
  const tail = path.join('global', CATEGORY, name);
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (abs.endsWith(tail)) out[abs] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(root);
  return out;
}

async function landFirst(name: string, text: string): Promise<void> {
  const ticket = accept(name, text);
  await flushRows();
  expect(ticket.op.state).toBe('landed');
  expect(fs.readFileSync(fileOf(name), 'utf8')).toBe(text);
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
  warns = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  _resetRowQueue();
  fs.rmSync(dataPath('global', CATEGORY), { recursive: true, force: true });
  fixRecord();
  fake = fakeBackend();
  configureRowFlush({ backend: () => fake.backend });
});

afterEach(() => {
  configureRowFlush({ backend: () => null });
  _resetRowQueue();
  fixRecord();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a failed mirror write of a doc key: its retry wait and its line', () => {
  it('is tried again after 1 s and then 2 s, and its line is logged once for the same cause', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    corruptRecord();
    const ticket = accept('wait.json', '{"w":1}');
    await flushRows();
    expect(ticket.op.state).toBe('mirror');
    expect(savedLines('wait.json')).toHaveLength(1);
    expect(savedLines('wait.json')[0]).toMatch(/is not JSON\); this machine keeps using the saved version and tries again$/);

    vi.advanceTimersByTime(999);
    expect(rowMirrorsWritten()).toBeNull();
    vi.advanceTimersByTime(1);
    const second = rowMirrorsWritten();
    expect(second).not.toBeNull();
    await second;
    expect(ticket.op.state).toBe('mirror');
    expect(savedLines('wait.json')).toHaveLength(1);

    fixRecord();
    vi.advanceTimersByTime(1999);
    expect(rowMirrorsWritten()).toBeNull();
    expect(fs.existsSync(fileOf('wait.json'))).toBe(false);
    vi.advanceTimersByTime(1);
    await rowMirrorsWritten();
    expect(fs.readFileSync(fileOf('wait.json'), 'utf8')).toBe('{"w":1}');
    expect(rowTicketState(ticket)).toBe('landed');
    expect(ticket.op.state).toBe('landed');
    expect(rowQueue.ops(keyOf('wait.json'))).toEqual([]);
  });

  it('after a write that succeeded, the next failure logs its line again and waits 1 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    corruptRecord();
    const first = accept('again.json', '{"a":1}');
    await flushRows();
    expect(savedLines('again.json')).toHaveLength(1);
    fixRecord();
    vi.advanceTimersByTime(1000);
    await rowMirrorsWritten();
    expect(first.op.state).toBe('landed');
    expect(fs.readFileSync(fileOf('again.json'), 'utf8')).toBe('{"a":1}');

    corruptRecord();
    const next = accept('again.json', '{"a":2}', shaOf(buf('{"a":1}')));
    await flushRows();
    expect(next.op.state).toBe('mirror');
    expect(savedLines('again.json')).toHaveLength(2);
    fixRecord();
    vi.advanceTimersByTime(999);
    expect(rowMirrorsWritten()).toBeNull();
    vi.advanceTimersByTime(1);
    const retry = rowMirrorsWritten();
    expect(retry).not.toBeNull();
    await retry;
    expect(fs.readFileSync(fileOf('again.json'), 'utf8')).toBe('{"a":2}');
    expect(next.op.state).toBe('landed');
  });

  it('a retry that finds every op of the key already written ends quietly', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    corruptRecord();
    const first = accept('quiet.json', '{"q":1}');
    await flushRows();
    expect(first.op.state).toBe('mirror');
    fixRecord();
    const next = accept('quiet.json', '{"q":2}', shaOf(buf('{"q":1}')));
    await flushRows();
    expect(first.op.state).toBe('landed');
    expect(next.op.state).toBe('landed');
    expect(fs.readFileSync(fileOf('quiet.json'), 'utf8')).toBe('{"q":2}');
    const before = errors.length;
    vi.advanceTimersByTime(1000);
    expect(rowMirrorsWritten()).not.toBeNull();
    expect(await settleMirrors()).toBeNull();
    expect(errors.length).toBe(before);
    expect(fs.readFileSync(fileOf('quiet.json'), 'utf8')).toBe('{"q":2}');
  });
});

describe('the mirror step writes only stored ops', () => {
  it('an op queued behind the stored one is not written: the stored version is', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fake.control.before = call => (call === 1 ? gate : 'fail');
    const first = accept('behind.json', '{"b":1}');
    for (let i = 0; i < 50 && fake.calls() === 0; i++) await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(fake.calls()).toBe(1);
    const next = accept('behind.json', '{"b":2}', shaOf(buf('{"b":1}')));
    expect(next.op).not.toBe(first.op);
    release();
    await flushRows();
    await rowMirrorsWritten();
    expect(first.op.state).toBe('landed');
    expect(fs.readFileSync(fileOf('behind.json'), 'utf8')).toBe('{"b":1}');
    expect(errors.filter(l => l.startsWith('[Shared] Saved '))).toEqual([]);
    expect(next.op.state).toBe('queued');
  });
});

describe('writeMirror: what it moves aside and what it writes', () => {
  it('a delete over a hand-edited mirror moves it aside and says nothing was put back', async () => {
    await landFirst('gone.json', '{"g":1}');
    fs.writeFileSync(fileOf('gone.json'), 'hand edit');
    const ticket = accept('gone.json', null, shaOf(buf('{"g":1}')));
    await flushRows();
    expect(ticket.op.state).toBe('landed');
    expect(fs.existsSync(fileOf('gone.json'))).toBe(false);
    const moved = superseded('gone.json');
    expect(Object.values(moved)).toEqual(['hand edit']);
    const dest = Object.keys(moved)[0];
    expect(warns).toContain(`[Shared] Moved ${fileOf('gone.json')} to ${dest}: it differed from the version this machine last took from the database (changed outside the bot, or left by a crash); the database holds no such file, so nothing was put back`);
    expect(errors).toEqual([]);
    const record = readDocRecord();
    expect(record.ok && record.record.docs[keyOf('gone.json')]).toBeUndefined();
  });

  it('a delete whose unlink fails keeps the op pending and the record entry, and logs the cause', async () => {
    await landFirst('keep.json', '{"k":1}');
    const real = fs.promises.unlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'unlink').mockImplementation(async (p: fs.PathLike) => {
      if (String(p) === fileOf('keep.json')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return real(p);
    });
    const ticket = accept('keep.json', null, shaOf(buf('{"k":1}')));
    await flushRows();
    expect(ticket.op.state).toBe('mirror');
    expect(fs.readFileSync(fileOf('keep.json'), 'utf8')).toBe('{"k":1}');
    const record = readDocRecord();
    expect(record.ok && record.record.docs[keyOf('keep.json')]).toMatchObject({ sha: shaOf(buf('{"k":1}')) });
    expect(savedLines('keep.json')).toHaveLength(1);
    expect(savedLines('keep.json')[0]).toContain('(EPERM)');
  });

  it('a mirror that already holds the stored bytes is neither moved aside nor written again', async () => {
    await landFirst('same.json', '{"s":1}');
    fs.writeFileSync(fileOf('same.json'), '{"s":2}');
    const ino = fs.statSync(fileOf('same.json')).ino;
    const ticket = accept('same.json', '{"s":2}', shaOf(buf('{"s":1}')));
    await flushRows();
    expect(ticket.op.state).toBe('landed');
    expect(fs.readFileSync(fileOf('same.json'), 'utf8')).toBe('{"s":2}');
    expect(fs.statSync(fileOf('same.json')).ino).toBe(ino);
    expect(superseded('same.json')).toEqual({});
    expect(warns.filter(w => w.startsWith('[Shared] Moved '))).toEqual([]);
    const record = readDocRecord();
    expect(record.ok && record.record.docs[keyOf('same.json')]).toMatchObject({ sha: shaOf(buf('{"s":2}')) });
  });

  it('a mirror whose read fails with no error code is moved aside before the stored version is written', async () => {
    await landFirst('nocode.json', '{"n":1}');
    fs.writeFileSync(fileOf('nocode.json'), 'old bytes');
    const real = fs.readFileSync;
    let thrown = false;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (!thrown && rest.length === 0 && String(p) === fileOf('nocode.json')) {
        thrown = true;
        throw undefined;
      }
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync);
    const ticket = accept('nocode.json', '{"n":2}', shaOf(buf('{"n":1}')));
    await flushRows();
    expect(thrown).toBe(true);
    expect(errors).toEqual([]);
    expect(ticket.op.state).toBe('landed');
    expect(fs.readFileSync(fileOf('nocode.json'), 'utf8')).toBe('{"n":2}');
    expect(Object.values(superseded('nocode.json'))).toEqual(['old bytes']);
  });

  it('an unreadable mirror is moved aside even when its record entry names an empty sha', async () => {
    fs.mkdirSync(path.dirname(fileOf('empty.json')), { recursive: true });
    fs.writeFileSync(fileOf('empty.json'), 'old bytes');
    writeDocRecord({ docs: { [keyOf('empty.json')]: { sha: '', stamp: null, main: null } } });
    const real = fs.readFileSync;
    let thrown = false;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (!thrown && rest.length === 0 && String(p) === fileOf('empty.json')) {
        thrown = true;
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync);
    const ticket = accept('empty.json', '{"e":1}');
    await flushRows();
    expect(thrown).toBe(true);
    expect(ticket.op.state).toBe('landed');
    expect(fs.readFileSync(fileOf('empty.json'), 'utf8')).toBe('{"e":1}');
    expect(Object.values(superseded('empty.json'))).toEqual(['old bytes']);
  });

  it('a write after a move aside that fails with no error value logs both lines with "undefined"', async () => {
    await landFirst('undef.json', '{"u":1}');
    fs.writeFileSync(fileOf('undef.json'), 'hand edit');
    const real = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).startsWith(`${fileOf('undef.json')}.`)) throw undefined;
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.promises.open);
    const ticket = accept('undef.json', '{"u":2}', shaOf(buf('{"u":1}')));
    await flushRows();
    expect(ticket.op.state).toBe('mirror');
    expect(Object.values(superseded('undef.json'))).toEqual(['hand edit']);
    const movedLines = warns.filter(w => w.startsWith(`[Shared] Moved ${fileOf('undef.json')} to `));
    expect(movedLines).toHaveLength(1);
    expect(movedLines[0].endsWith("the database's version could not be written (undefined); this machine tries again")).toBe(true);
    expect(savedLines('undef.json')).toEqual([
      `[Shared] Saved ${keyOf('undef.json')} in the database, but could not write ${fileOf('undef.json')} (undefined); this machine keeps using the saved version and tries again`,
    ]);
  });
});
