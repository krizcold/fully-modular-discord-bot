import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import {
  closeSharedWritesLost,
  DataBackendUnavailableError,
  deleteGuildNamespace,
  deleteRawAtomicTracked,
  reopenSharedWrites,
  setGuildDataBackend,
  setGuildWriteGate,
  updateRawTracked,
  writeRawAtomicTracked,
} from '../../src/bot/internalSetup/utils/dataManager';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { _resetRowQueue, rowQueue, shaOf } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';

// L5 run A, chunk rk1: raw writes, updates and deletes of a shared key on a Postgres bot answer and record each refusal
// under the file they touched, queue the op on the base the facade holds, and a delete answers 'absent' for nothing held.

let n = 0;
let errors: string[];

function sharedFile(): { abs: string; key: string } {
  const name = `rk1-${process.pid}-${++n}.json`;
  return { abs: dataPath('global', name), key: `global/${name}` };
}

function onDisk(abs: string, text: string): void {
  fs.mkdirSync(dataPath('global'), { recursive: true });
  fs.writeFileSync(abs, text);
}

beforeEach(() => {
  _resetRowQueue();
  setGuildDataBackend(null);
  reopenSharedWrites();
  setGuildWriteGate(null);
  setBackendKind('postgres');
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  reopenSharedWrites();
  setGuildWriteGate(null);
  setGuildDataBackend(null);
  _resetRowQueue();
});

describe('a raw write of a shared key', () => {
  it('while the row queue is closed: refused database-backlog, recorded under its file, nothing queued', () => {
    const { abs, key } = sharedFile();
    vi.spyOn(rowQueue, 'closed').mockReturnValue(true);
    const ledger = openLedger('panel');
    expect(runInLedger(ledger, 'mod', () => writeRawAtomicTracked(abs, '{"a":1}'))).toEqual({ accepted: false, cause: 'database-backlog' });
    expect(ledger.refusedDocs()).toEqual([expect.objectContaining({ cause: 'database-backlog', doc: `file:${abs}` })]);
    expect(rowQueue.ops(key)).toHaveLength(0);
  });

  it('accepted: the ledger records it as a whole rewrite of its file', () => {
    const { abs, key } = sharedFile();
    const ledger = openLedger('panel');
    expect(runInLedger(ledger, 'mod', () => writeRawAtomicTracked(abs, '{"a":1}'))).toEqual({ accepted: true });
    expect(ledger.rewriteSeq(`file:${abs}`)).toBeGreaterThan(0);
    expect(rowQueue.entryOf(key)!.body!.toString('utf8')).toBe('{"a":1}');
  });
});

describe('a raw update of a shared key', () => {
  it('of a path that is no shared key throws with the path in its text', () => {
    const abs = dataPath('987650000000000001', 'x.json');
    expect(() => updateRawTracked(abs, {}, v => v)).toThrow(new TypeError(`[Data] ${abs} is not a shared key on this bot, so it has no raw update`));
  });

  it('while the web UI gate answers a reason: throws maintenance with that reason, nothing queued', () => {
    const { abs, key } = sharedFile();
    setGuildWriteGate(() => 'a data move is running');
    let thrown: unknown;
    try { updateRawTracked(abs, {}, () => ({ a: 1 })); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(DataBackendUnavailableError);
    expect((thrown as DataBackendUnavailableError).causeKey).toBe('maintenance');
    expect((thrown as Error).message).toBe('[Data] a data move is running; the write was not saved');
    expect(rowQueue.ops(key)).toHaveLength(0);
  });

  it('once another process took the data files: refused writer-lost, recorded under its file, nothing queued', () => {
    const { abs, key } = sharedFile();
    closeSharedWritesLost();
    const ledger = openLedger('panel');
    expect(runInLedger(ledger, 'mod', () => updateRawTracked(abs, {}, () => ({ a: 1 })))).toEqual({ accepted: false, cause: 'writer-lost' });
    expect(ledger.refusedDocs()).toEqual([expect.objectContaining({ cause: 'writer-lost', doc: `file:${abs}` })]);
    expect(rowQueue.ops(key)).toHaveLength(0);
  });

  it('with no stored text: fn gets the default and the op is built on base absent', () => {
    const { abs, key } = sharedFile();
    const seen: unknown[] = [];
    expect(updateRawTracked(abs, { count: 0 }, current => { seen.push(current); return { count: current.count + 1 }; })).toEqual({ accepted: true });
    expect(seen).toEqual([{ count: 0 }]);
    const op = rowQueue.entryOf(key)!;
    expect(op.base).toBe('absent');
    expect(op.body!.toString('utf8')).toBe(JSON.stringify({ count: 1 }, null, 2));
  });

  it('with a mirror on disk: the op is built on the sha of its bytes', () => {
    const { abs, key } = sharedFile();
    onDisk(abs, '{"count":4}');
    expect(updateRawTracked(abs, { count: 0 }, current => ({ count: current.count + 1 }))).toEqual({ accepted: true });
    expect(rowQueue.entryOf(key)!.base).toBe(shaOf(Buffer.from('{"count":4}')));
  });

  it('a mirror that is not whole JSON: refused io with the read error in the reason, logged, nothing queued', () => {
    const { abs, key } = sharedFile();
    onDisk(abs, '{"count":');
    const ledger = openLedger('panel');
    const answer = runInLedger(ledger, 'mod', () => updateRawTracked(abs, {}, v => v)) as { accepted: false; cause: string; reason: string };
    expect(answer.accepted).toBe(false);
    expect(answer.cause).toBe('io');
    expect(answer.reason).toMatch(/^the stored text could not be read whole \(.+\)$/);
    expect(errors).toEqual([`[Data] Refused a write of file:${abs}: ${answer.reason}; nothing was saved`]);
    expect(rowQueue.ops(key)).toHaveLength(0);
  });

  it('a throw from fn reaches the caller as it was, nothing queued', () => {
    const { abs, key } = sharedFile();
    const boom = new Error('rk1 fn broke');
    let thrown: unknown;
    try { updateRawTracked(abs, {}, () => { throw boom; }); } catch (error) { thrown = error; }
    expect(thrown).toBe(boom);
    expect(rowQueue.ops(key)).toHaveLength(0);
  });

  it('while the row queue is closed: refused database-backlog, recorded under its file, nothing queued', () => {
    const { abs, key } = sharedFile();
    vi.spyOn(rowQueue, 'closed').mockReturnValue(true);
    const ledger = openLedger('panel');
    expect(runInLedger(ledger, 'mod', () => updateRawTracked(abs, {}, () => ({ a: 1 })))).toEqual({ accepted: false, cause: 'database-backlog' });
    expect(ledger.refusedDocs()).toEqual([expect.objectContaining({ cause: 'database-backlog', doc: `file:${abs}` })]);
    expect(rowQueue.ops(key)).toHaveLength(0);
  });

  it('two updates in a row join one op, each fn kept in order, the second built on the first', () => {
    const { abs, key } = sharedFile();
    const first = (c: any) => ({ count: c.count + 1 });
    const second = (c: any) => ({ count: c.count * 10 });
    expect(updateRawTracked(abs, { count: 0 }, first)).toEqual({ accepted: true });
    expect(updateRawTracked(abs, { count: 0 }, second)).toEqual({ accepted: true });
    const ops = rowQueue.ops(key);
    expect(ops).toHaveLength(1);
    expect(ops[0].writes).toBe(2);
    expect(ops[0].callerBase).toBe(false);
    expect(ops[0].updates!.map(u => u.fn)).toEqual([first, second]);
    expect(ops[0].body!.toString('utf8')).toBe(JSON.stringify({ count: 10 }, null, 2));
  });

  it('accepted: the ledger records it as a whole rewrite of its file', () => {
    const { abs } = sharedFile();
    const ledger = openLedger('panel');
    expect(runInLedger(ledger, 'mod', () => updateRawTracked(abs, {}, () => ({ a: 1 })))).toEqual({ accepted: true });
    expect(ledger.rewriteSeq(`file:${abs}`)).toBeGreaterThan(0);
  });
});

describe('a raw delete of a shared key', () => {
  it('with nothing held and no mirror: answers absent and queues nothing', () => {
    const { abs, key } = sharedFile();
    expect(deleteRawAtomicTracked(abs)).toEqual({ accepted: false, cause: 'absent' });
    expect(rowQueue.ops(key)).toHaveLength(0);
  });

  it('a second delete while the first is held: answers absent', () => {
    const { abs, key } = sharedFile();
    onDisk(abs, '{"a":1}');
    expect(deleteRawAtomicTracked(abs)).toEqual({ accepted: true });
    expect(rowQueue.entryOf(key)!.body).toBeNull();
    expect(deleteRawAtomicTracked(abs)).toEqual({ accepted: false, cause: 'absent' });
    expect(rowQueue.ops(key)).toHaveLength(1);
    expect(rowQueue.ops(key)[0].writes).toBe(1);
  });

  it('of a write held and not yet on disk: accepted, the op now deletes', () => {
    const { abs, key } = sharedFile();
    expect(writeRawAtomicTracked(abs, '{"a":1}')).toEqual({ accepted: true });
    expect(fs.existsSync(abs)).toBe(false);
    expect(deleteRawAtomicTracked(abs)).toEqual({ accepted: true });
    expect(rowQueue.entryOf(key)!.body).toBeNull();
  });

  it('while the row queue is closed: refused database-backlog, recorded under its file, nothing queued', () => {
    const { abs, key } = sharedFile();
    onDisk(abs, '{"a":1}');
    vi.spyOn(rowQueue, 'closed').mockReturnValue(true);
    const ledger = openLedger('panel');
    expect(runInLedger(ledger, 'mod', () => deleteRawAtomicTracked(abs))).toEqual({ accepted: false, cause: 'database-backlog' });
    expect(ledger.refusedDocs()).toEqual([expect.objectContaining({ cause: 'database-backlog', doc: `file:${abs}` })]);
    expect(rowQueue.ops(key)).toHaveLength(0);
    expect(fs.readFileSync(abs, 'utf8')).toBe('{"a":1}');
  });
});

describe('a raw delete under a guild a retirement holds', () => {
  it('answers not-ready and the file stays', async () => {
    setBackendKind('file');
    const guildId = `98765${String(process.pid).padStart(7, '0')}${n++}`;
    const dir = dataPath(guildId);
    fs.mkdirSync(dir, { recursive: true });
    const file = `${dir}/x.json`;
    fs.writeFileSync(file, '{"kept":true}');
    const retire = deleteGuildNamespace(guildId, 'rk1');
    const answer = deleteRawAtomicTracked(file);
    await retire;
    expect(answer).toEqual({ accepted: false, cause: 'not-ready' });
  });
});
