import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { DataBackendUnavailableError } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { _resetRowQueue, rowQueue, ROW_ACCEPT_WINDOW_MS, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';

// L5 run A, chunk rk2 (dataManager.ts): updates, appends, deletes and dataExists of shared keys and global files.

const CATEGORY = 'rk2shared';
const G = '880000000000000211';
const NUL = String.fromCharCode(0);
const file = (name: string) => dataPath('global', CATEGORY, name);
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const opts = (extra: Partial<dm.DataOptions> = {}): dm.DataOptions => ({ scope: 'global', category: CATEGORY, ...extra });

let logs: string[];

function put(target: string, text: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

function ticketOf(res: { outcome: string }): RowTicket {
  const ticket = (res as { ticket?: { kind: string } }).ticket;
  expect(ticket?.kind).toBe('row');
  return ticket as unknown as RowTicket;
}

function backlogged(name: string): void {
  const ticket = ticketOf(dm.saveDataTracked(name, opts(), { aged: true }));
  (ticket.op as { acceptedAt: number }).acceptedAt = Date.now() - ROW_ACCEPT_WINDOW_MS - 1_000;
  expect(rowQueue.closed()).toBe(true);
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetRowQueue();
});

afterEach(async () => {
  vi.restoreAllMocks();
  dm.setGuildWriteGate(null);
  _resetRowQueue();
  setBackendKind('file');
  await dm.flushAll();
  setBackendKind(null);
});

describe('an update of a shared key on a Postgres bot', () => {
  it('with no row and no mirror, builds the row op on the base absent', () => {
    setBackendKind('postgres');
    const ticket = ticketOf(dm.updateData('u7.json', opts(), { n: 0 }, v => ({ n: v.n + 1 })));
    expect(ticket.key).toBe(keyOf('u7.json'));
    expect(ticket.op.base).toBe('absent');
    expect(JSON.parse(ticket.op.body!.toString('utf8'))).toEqual({ n: 1 });
  });

  it('while the migration lock is held, is refused before its function runs', () => {
    setBackendKind('postgres');
    dm.setGuildWriteGate(() => 'A data migration is running');
    const fn = vi.fn((v: { n: number }) => ({ n: v.n + 1 }));
    const error = thrown(() => dm.updateData('u8.json', opts(), { n: 0 }, fn));
    expect(error).toBeInstanceOf(DataBackendUnavailableError);
    expect((error as DataBackendUnavailableError).causeKey).toBe('maintenance');
    expect(fn).not.toHaveBeenCalled();
    expect(rowQueue.ops(keyOf('u8.json'))).toEqual([]);
  });
});

describe('the text rule of an appended line', () => {
  it('a guild line with U+0000 is refused with the database reason', () => {
    setBackendKind('file');
    const res = dm.appendDataTracked('rk2.jsonl', { guildId: G, category: 'rk2' }, `a${NUL}b`);
    expect(res).toEqual({ outcome: 'refused', cause: 'unstorable', reason: 'it holds U+0000 at character 1, which the database cannot store' });
  });

  it('a global line with U+0000 is refused with the global text rule', () => {
    setBackendKind('file');
    const res = dm.appendDataTracked('rk2.jsonl', opts(), `a${NUL}b`);
    expect(res).toEqual({ outcome: 'refused', cause: 'unstorable', reason: 'it holds U+0000 at character 1' });
  });
});

describe('the row queue closed by its backlog', () => {
  it('refuses an append to a lines key with database-backlog and queues no line', () => {
    setBackendKind('postgres');
    backlogged('aged12.json');
    const error = thrown(() => dm.appendDataTracked('j12.jsonl', opts(), '{"e":1}'));
    expect(error).toBeInstanceOf(DataBackendUnavailableError);
    expect((error as DataBackendUnavailableError).causeKey).toBe('database-backlog');
    expect(rowQueue.ops(keyOf('j12.jsonl'))).toEqual([]);
  });

  it('refuses a delete of a shared key with database-backlog and leaves its queued write', () => {
    setBackendKind('postgres');
    backlogged('d23.json');
    const error = thrown(() => dm.deleteDataTracked('d23.json', opts()));
    expect(error).toBeInstanceOf(DataBackendUnavailableError);
    expect((error as DataBackendUnavailableError).causeKey).toBe('database-backlog');
    const ops = rowQueue.ops(keyOf('d23.json'));
    expect(ops).toHaveLength(1);
    expect(JSON.parse(ops[0].body!.toString('utf8'))).toEqual({ aged: true });
  });
});

describe('dataExists of a shared key', () => {
  it('answers true for a queued write with no mirror on disk', () => {
    setBackendKind('postgres');
    dm.saveDataTracked('e14.json', opts(), { a: 1 });
    expect(fs.existsSync(file('e14.json'))).toBe(false);
    expect(dm.dataExists('e14.json', opts())).toBe(true);
  });
});

describe('a delete of a shared key on a Postgres bot', () => {
  it('a second delete while the first is queued answers absent with the first one\'s ticket and logs it', () => {
    setBackendKind('postgres');
    put(file('d18.json'), '{"v":1}');
    const first = dm.deleteDataTracked('d18.json', opts());
    expect(first.outcome).toBe('deleted');
    const firstTicket = ticketOf(first);
    logs.length = 0;
    const second = dm.deleteDataTracked('d18.json', opts());
    expect(second.outcome).toBe('absent');
    expect(ticketOf(second).op).toBe(firstTicket.op);
    expect(rowQueue.ops(keyOf('d18.json'))).toHaveLength(1);
    expect(logs).toContain(`[DataManager] File not found for deletion: ${file('d18.json')}`);
  });

  it('with no row op and no mirror answers absent with no ticket', () => {
    setBackendKind('postgres');
    expect(dm.deleteDataTracked('d21.json', opts())).toEqual({ outcome: 'absent' });
    expect(rowQueue.ops(keyOf('d21.json'))).toEqual([]);
  });

  it('a delete of a key whose write is queued is accepted', () => {
    setBackendKind('postgres');
    dm.saveDataTracked('d19.json', opts(), { a: 1 });
    const res = dm.deleteDataTracked('d19.json', opts());
    expect(res.outcome).toBe('deleted');
    expect(rowQueue.ops(keyOf('d19.json'))[0].body).toBeNull();
    expect(dm.dataExists('d19.json', opts())).toBe(false);
  });
});

describe('a global delete on a JSON bot', () => {
  it('drops the key from the global keys, so a folder of that name can be saved afterwards', async () => {
    setBackendKind('file');
    const at = { scope: 'global' as const, category: 'rk2tree' };
    expect(dm.saveDataTracked('k.json', at, { a: 1 }).outcome).toBe('saved');
    await dm.flushAll();
    expect(dm.deleteDataTracked('k.json', at).outcome).toBe('deleted');
    await dm.flushAll();
    expect(fs.existsSync(dataPath('global', 'rk2tree', 'k.json'))).toBe(false);
    const res = dm.saveDataTracked('in.json', { scope: 'global', category: 'rk2tree/k.json' }, { b: 1 });
    expect(res.outcome).toBe('saved');
    await dm.flushAll();
    expect(JSON.parse(fs.readFileSync(dataPath('global', 'rk2tree', 'k.json', 'in.json'), 'utf8'))).toEqual({ b: 1 });
  });
});
