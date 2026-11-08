import fs from 'fs';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { DataBackendUnavailableError } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { getPending } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { _resetRowQueue, rowQueue, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sharedRows } from '../helpers/sharedRows';

// NB6 test 2 (wip-redesign/sheets/NB6.md section 5 rows 1, 3 to 6, 79 and 167, as decisions 22, 23, 26, 39, 50 and 51
// amend them; part 4, and rows 78 and 166 in part 5): the row queue's accept on a Postgres bot. Mirrors are written by the facade's own save on a
// JSON bot first, as a mirror holds what a write stored.

const CATEGORY = 'nb6accept';
const file = (name: string) => dataPath('global', CATEGORY, name);
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const opts = (extra: Partial<dm.DataOptions> = {}): dm.DataOptions => ({ scope: 'global', category: CATEGORY, ...extra });
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const text = (value: unknown) => JSON.stringify(value, null, 2);

async function mirror(name: string, value: unknown): Promise<Buffer> {
  setBackendKind('file');
  expect(dm.saveDataTracked(name, opts(), value).outcome).toBe('saved');
  await dm.flushAll();
  setBackendKind('postgres');
  return fs.readFileSync(file(name));
}

function rowTicket(res: dm.SaveTracked): RowTicket {
  expect(res.outcome).toBe('saved');
  const ticket = (res as { ticket: { kind: string } }).ticket;
  expect(ticket.kind).toBe('row');
  return ticket as unknown as RowTicket;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetRowQueue();
  setBackendKind('postgres');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  dm.setGuildWriteGate(null);
});

describe('row 1: a shared save', () => {
  it('is queued with the sha of the mirror bytes as base; the mirror and the file queue are untouched', async () => {
    const before = await mirror('r1.json', { v: 1 });
    const ticket = rowTicket(dm.saveDataTracked('r1.json', opts(), { v: 2 }));
    expect(ticket.key).toBe(keyOf('r1.json'));
    expect(ticket.op.base).toBe(sha(before));
    expect(ticket.op.body?.toString('utf8')).toBe(text({ v: 2 }));
    expect(rowQueue.ops(keyOf('r1.json'))).toEqual([ticket.op]);
    expect(getPending(file('r1.json'))).toBeUndefined();
    await dm.flushAll();
    expect(fs.readFileSync(file('r1.json')).equals(before)).toBe(true);
  });

  it('with no mirror, the base is absent', () => {
    const ticket = rowTicket(dm.saveDataTracked('r1-new.json', opts(), { v: 1 }));
    expect(ticket.op.base).toBe('absent');
  });

  it('a raw write of the root config and a delete enter the queue; reads answer the queued body', async () => {
    await mirror('r1-del.json', { v: 1 });
    const root = dataPath('dist', 'bot', 'config.json');
    expect(dm.writeRawAtomicTracked(root, '{"a":1}')).toEqual({ accepted: true });
    expect(rowQueue.ops('config.json')[0].body?.toString('utf8')).toBe('{"a":1}');
    expect(dm.readRaw(root)).toBe('{"a":1}');
    expect(fs.existsSync(root)).toBe(false);
    const res = dm.deleteDataTracked('r1-del.json', opts());
    expect(res.outcome).toBe('deleted');
    expect(rowQueue.ops(keyOf('r1-del.json'))[0].body).toBeNull();
    expect(dm.loadData('r1-del.json', opts(), 'default')).toBe('default');
    expect(dm.dataExists('r1-del.json', opts())).toBe(false);
    expect(fs.existsSync(file('r1-del.json'))).toBe(true);
  });
});

describe('row 3: the migration lock held', () => {
  it('refuses a shared save, update, delete and raw write with the migration refusal; nothing is queued', async () => {
    await mirror('r3.json', { v: 1 });
    dm.setGuildWriteGate(() => 'A data migration is running');
    const refusals: unknown[] = [];
    const tries = [
      () => dm.saveDataTracked('r3.json', opts(), { v: 2 }),
      () => dm.updateData('r3.json', opts(), {}, (v: any) => ({ ...v, n: 1 })),
      () => dm.deleteDataTracked('r3.json', opts()),
      () => dm.writeRawAtomicTracked(dataPath('dist', 'bot', 'config.json'), '{}'),
    ];
    for (const attempt of tries) {
      try {
        attempt();
        refusals.push('accepted');
      } catch (error) {
        refusals.push(error);
      }
    }
    for (const error of refusals) {
      expect(error).toBeInstanceOf(DataBackendUnavailableError);
      expect((error as DataBackendUnavailableError).causeKey).toBe('maintenance');
      expect((error as Error).message).toBe('[Data] A data migration is running; the write was not saved');
    }
    expect(rowQueue.keys()).toEqual([]);
  });
});

describe('row 4: acceptance closes at the backlog', () => {
  it('at 64 MiB held in the queue: refused database-backlog, nothing queued', () => {
    const big = 'x'.repeat(4 * 1024 * 1024 - 64);
    for (let i = 0; i < 17; i++) rowTicket(dm.saveDataTracked(`big${i}.json`, opts(), big));
    expect(rowQueue.bytes()).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    let thrown: unknown;
    try {
      dm.saveDataTracked('one-more.json', opts(), { v: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DataBackendUnavailableError);
    expect((thrown as DataBackendUnavailableError).causeKey).toBe('database-backlog');
    expect(rowQueue.ops(keyOf('one-more.json'))).toEqual([]);
    expect(dm.writeRawAtomicTracked(dataPath('dist', 'bot', 'config.json'), '{}')).toEqual({ accepted: false, cause: 'database-backlog' });
    expect(rowQueue.ops('config.json')).toEqual([]);
  });

  it('once a shared write has waited 300 s: refused database-backlog, nothing queued', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    rowTicket(dm.saveDataTracked('old.json', opts(), { v: 1 }));
    vi.setSystemTime(1_000_000 + 299_999);
    rowTicket(dm.saveDataTracked('young.json', opts(), { v: 1 }));
    vi.setSystemTime(1_000_000 + 300_000);
    expect(() => dm.saveDataTracked('late.json', opts(), { v: 1 })).toThrow(DataBackendUnavailableError);
    expect(rowQueue.ops(keyOf('late.json'))).toEqual([]);
  });
});

describe('row 6: a second write of the key while its op is queued', () => {
  it('joins the op: the later body, the first base, one op', async () => {
    const before = await mirror('r6.json', { v: 1 });
    const first = rowTicket(dm.saveDataTracked('r6.json', opts(), { v: 2 }));
    const second = rowTicket(dm.saveDataTracked('r6.json', opts(), { v: 3 }));
    expect(second.op).toBe(first.op);
    expect(rowQueue.ops(keyOf('r6.json'))).toHaveLength(1);
    expect(first.op.body?.toString('utf8')).toBe(text({ v: 3 }));
    expect(first.op.base).toBe(sha(before));
    expect(first.op.updates).toBeNull();
  });

  it('two updates make one op that is rebasable, each fn kept in order', async () => {
    const before = await mirror('r6u.json', { n: 1 });
    const inc = (v: any) => ({ n: v.n + 1 });
    const dbl = (v: any) => ({ n: v.n * 2 });
    const first = rowTicket(dm.updateData('r6u.json', opts(), { n: 0 }, inc));
    const second = rowTicket(dm.updateData('r6u.json', opts(), { n: 0 }, dbl));
    expect(second.op).toBe(first.op);
    expect(first.op.base).toBe(sha(before));
    expect(first.op.body?.toString('utf8')).toBe(text({ n: 4 }));
    expect(first.op.updates?.map(step => step.fn)).toEqual([inc, dbl]);
    expect(first.op.updates?.map(step => step.defaultValue)).toEqual([{ n: 0 }, { n: 0 }]);
  });
});

describe('row 79: a plain write and an update in one op', () => {
  it.each([
    ['save, then update', ['save', 'update']],
    ['update, then save', ['update', 'save']],
  ])('%s: the op is plain', async (_name, order) => {
    const name = `r79-${order[0]}.json`;
    const before = await mirror(name, { n: 1 });
    const tickets = order.map(kind => (kind === 'save'
      ? rowTicket(dm.saveDataTracked(name, opts(), { n: 10 }))
      : rowTicket(dm.updateData(name, opts(), { n: 0 }, (v: any) => ({ n: v.n + 1 })))));
    expect(tickets[1].op).toBe(tickets[0].op);
    expect(tickets[0].op.updates).toBeNull();
    expect(tickets[0].op.base).toBe(sha(before));
    expect(tickets[0].op.body?.toString('utf8')).toBe(text(order[1] === 'save' ? { n: 10 } : { n: 11 }));
  });
});

describe('row 167: a caller-base write while a facade op of the key is queued', () => {
  it('is its own op behind it with its own base; the facade op keeps its body', async () => {
    await mirror('r167.json', { v: 1 });
    const facade = rowTicket(dm.saveDataTracked('r167.json', opts(), { v: 2 }));
    const callerBase = 'c'.repeat(64);
    const caller = rowTicket(dm.saveDataTracked('r167.json', opts({ baseSha: callerBase }), { v: 3 }));
    expect(caller.op).not.toBe(facade.op);
    expect(rowQueue.ops(keyOf('r167.json'))).toEqual([facade.op, caller.op]);
    expect(caller.op.base).toBe(callerBase);
    expect(caller.op.callerBase).toBe(true);
    expect(facade.op.body?.toString('utf8')).toBe(text({ v: 2 }));
    expect(caller.op.body?.toString('utf8')).toBe(text({ v: 3 }));
  });
});

// Last: the exit drain closes the facade for the rest of the process.
// Part 5: rows 78 and 166 need the flush; the rows above run with no data pool, so nothing is sent there. Row 5 stays last.
describe('with the flush (part 5)', () => {
  let rows: ReturnType<typeof sharedRows>;
  let rig: ReturnType<typeof scriptedBackend>;

  beforeEach(() => {
    rows = sharedRows();
    rig = scriptedBackend(rows.answer);
    dm.setGuildDataBackend(rig.backend);
  });

  afterEach(async () => {
    dm.setGuildDataBackend(null);
    _resetRowQueue();
    await rig.backend.stop();
  });

  it('row 78: a write of a key whose op is on the wire is a new op behind it, its base the sha of the body on the wire', async () => {
    let release!: () => void;
    const gate = new Promise<undefined>(resolve => { release = () => resolve(undefined); });
    rows.fault = sql => (/^SELECT body, sha/.test(sql) ? gate : undefined);
    const onWire = rowTicket(dm.saveDataTracked('r78.json', opts(), { v: 1 }));
    while (!rig.sent.some(s => /^SELECT body, sha/.test(s.sql))) await new Promise(resolve => { setTimeout(resolve, 1); });
    expect(onWire.op.state).toBe('wire');
    const behind = rowTicket(dm.saveDataTracked('r78.json', opts(), { v: 2 }));
    expect(behind.op).not.toBe(onWire.op);
    expect(behind.op.base).toBe(sha(text({ v: 1 })));
    expect(onWire.op.body?.toString('utf8')).toBe(text({ v: 1 }));
    expect(rowQueue.ops(keyOf('r78.json'))).toEqual([onWire.op, behind.op]);
    release();
    await dm.flushAll();
    await dm.flushAll();
    expect(rowTicketState(onWire)).toBe('landed');
    expect(rowTicketState(behind)).toBe('landed');
    expect(rows.docs.get(keyOf('r78.json'))?.body.toString('utf8')).toBe(text({ v: 2 }));
  });

  it('row 166: a plain save after an edit the stamp missed: the base is the hash of the bytes; refused at the flush', async () => {
    const first = rowTicket(dm.saveDataTracked('r166.json', opts(), { v: 1 }));
    await dm.flushAll();
    expect(rowTicketState(first)).toBe('landed');
    const stat = fs.statSync(file('r166.json'));
    const edited = text({ v: 8 });
    fs.writeFileSync(file('r166.json'), edited);
    fs.utimesSync(file('r166.json'), stat.atime, stat.mtime);
    const ticket = rowTicket(dm.saveDataTracked('r166.json', opts(), { v: 2 }));
    expect(ticket.op.base).toBe(sha(edited));
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('refused');
    expect(ticket.op.refusal?.cause).toBe('changed-elsewhere');
    expect(rows.docs.get(keyOf('r166.json'))?.body.toString('utf8')).toBe(text({ v: 1 }));
  });
});

describe('row 5: the exit drain has closed', () => {
  it('throws node-stopping for a shared save; nothing is queued', async () => {
    await dm.drainForExit(1000);
    expect(dm.isClosedForExit()).toBe(true);
    let thrown: unknown;
    try {
      dm.saveDataTracked('r5.json', opts(), { v: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DataBackendUnavailableError);
    expect((thrown as DataBackendUnavailableError).causeKey).toBe('node-stopping');
    expect(rowQueue.keys()).toEqual([]);
  });
});
