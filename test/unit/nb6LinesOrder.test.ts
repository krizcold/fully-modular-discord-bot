import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { appendLine, carryLines, deleteLines, readLines } from '../../src/bot/internalSetup/utils/sharedLines';
import { rowCommitOwed, rowQueue, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { mirrorRig } from '../helpers/nb6Mirror';
import { lost, pgError } from '../helpers/sharedRows';

// NB6 test 52 (wip-redesign/sheets/NB6.md: decisions 8, 24, 40, 47, 48 and 54, C5, C12, D5; part 9): a lines key's ops
// (appends, lines-only ops and deleteLines) run in accept order, one on the wire at a time, and a deleteLines is sent
// only after every earlier op of its key settled. Rows 178 and 179, the facade's append on a Postgres bot, the
// statements of each op and the journal read.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const m = mirrorRig('nb6lines');
const KEY = m.keyOf('log.jsonl');
const INSERT = 'INSERT INTO smdb_data.shared_lines (key, id, line) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING';
const DELETE = 'DELETE FROM smdb_data.shared_lines WHERE key = $1 AND id = ANY($2)';
const LOCK = "SELECT now() AS now, pg_advisory_xact_lock(hashtext('smdb_shared'), hashtext($1))";
const OP = 'INSERT INTO smdb_data.shared_ops (id) VALUES ($1)';
const OPS_READ = 'SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)';
const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';

/** NB5's hold, started by the silence of a lost answer, confirmed as the chooser would. */
const endHold = () => m.state.pg.backend.confirmHold((m.state.pg.backend as unknown as { epoch: number }).epoch);

beforeEach(() => m.setup());
afterEach(() => m.teardown());

/** The statements sent, SET LOCAL raises left out and BEGIN's own SET LOCAL kept in its line. */
const statements = () => m.sql().filter(sql => !/^SET LOCAL/.test(sql));
const valuesOf = (sql: string) => m.state.pg.sent.filter(s => s.sql === sql).map(s => s.params ?? (s.raw as { values?: unknown[] }).values);

/** Flushes until no op of the key is left. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10 && rowQueue.ops(KEY).length > 0; i++) await dm.flushAll();
  expect(rowQueue.ops(KEY)).toEqual([]);
}

describe('row 178: deleteLines of an id whose append is unsettled', () => {
  it('is sent only after the append settles', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    m.state.rows.fault = sql => (sql === 'COMMIT' ? held.then(() => undefined) : undefined);
    const append = appendLine(KEY, '{"n":1}', ID_A);
    await vi.waitFor(() => expect(m.sql()).toContain('COMMIT'));
    const del = deleteLines(KEY, [ID_A]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(m.sql()).not.toContain(DELETE);
    expect(rowTicketState(del)).toBe('open');
    release();
    await settle();
    expect(rowTicketState(append)).toBe('landed');
    expect(rowTicketState(del)).toBe('landed');
    expect(m.sql().indexOf(DELETE)).toBeGreaterThan(m.sql().indexOf(INSERT));
    expect(m.state.rows.lineLog).toEqual([{ kind: 'insert', key: KEY, id: ID_A }, { kind: 'delete', key: KEY, id: ID_A }]);
    expect(m.state.rows.lines.size).toBe(0);
  });
});

describe('row 179: an append whose answer was lost, then deleteLines', () => {
  it('the append is tried again and lands once; the line is deleted once and not inserted again', async () => {
    let commits = 0;
    m.state.rows.fault = sql => (sql === 'COMMIT' && ++commits === 1 ? 'lose' : undefined);
    const append = appendLine(KEY, '{"n":1}', ID_A);
    const del = deleteLines(KEY, [ID_A]);
    await dm.flushAll();
    expect(rowTicketState(append)).toBe('open');
    expect(rowCommitOwed(append)).toBe(true);
    expect(m.sql()).not.toContain(DELETE);
    endHold();
    await settle();
    expect(rowTicketState(append)).toBe('landed');
    expect(rowTicketState(del)).toBe('landed');
    expect(valuesOf(INSERT).map(v => v![1])).toEqual([ID_A, ID_A]);
    expect(valuesOf(DELETE)).toHaveLength(1);
    expect(m.state.rows.lineLog).toEqual([{ kind: 'insert', key: KEY, id: ID_A }, { kind: 'delete', key: KEY, id: ID_A }]);
    expect(m.state.rows.lines.size).toBe(0);
  });
});

describe('decision 54: one op order a lines key', () => {
  it('appends, a lines-only op and a deleteLines go out one at a time in accept order', async () => {
    const tickets = [
      appendLine(KEY, 'one', ID_A),
      carryLines(KEY, [{ id: ID_B, line: 'two' }], { lockKey: m.keyOf('doc.json') }),
      deleteLines(KEY, [ID_A]),
    ];
    await settle();
    expect(tickets.map(rowTicketState)).toEqual(['landed', 'landed', 'landed']);
    expect(m.state.rows.lineLog).toEqual([
      { kind: 'insert', key: KEY, id: ID_A },
      { kind: 'insert', key: KEY, id: ID_B },
      { kind: 'delete', key: KEY, id: ID_A },
    ]);
    const clients = m.state.pg.sent.filter(s => s.sql === 'COMMIT').map(s => s.client);
    expect(new Set(clients).size).toBe(3);
  });
});

describe("each op's transaction", () => {
  it('an append (decision 8): the insert with its own id and ON CONFLICT, no lock and no op id', async () => {
    const ticket = appendLine(KEY, Buffer.from([0xff, 0x00, 0x41]), ID_A);
    await settle();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(statements()).toEqual([expect.stringMatching(/^BEGIN; SET LOCAL statement_timeout = \d+$/), INSERT, 'COMMIT']);
    expect(valuesOf(INSERT)[0]).toEqual([KEY, ID_A, Buffer.from([0xff, 0x00, 0x41])]);
    expect(m.state.rows.lines.get(ID_A)!.line).toEqual(Buffer.from([0xff, 0x00, 0x41]));
  });

  it('a lines-only op (decision 47): the lock of its doc key, each line, its op id', async () => {
    const ticket = carryLines(KEY, [{ id: ID_A, line: 'a' }, { id: ID_B, line: 'b' }], { lockKey: m.keyOf('doc.json') });
    await settle();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(statements()).toEqual([expect.stringMatching(/^BEGIN; SET LOCAL statement_timeout = \d+$/), LOCK, INSERT, INSERT, OP, 'COMMIT']);
    expect(valuesOf(LOCK)).toEqual([[m.keyOf('doc.json')]]);
    expect(m.state.rows.ops.size).toBe(1);
    expect([...m.state.rows.lines.values()].map(r => r.line.toString('utf8'))).toEqual(['a', 'b']);
  });

  it('deleteLines (decision 40): the lock of its key, the delete, its op id', async () => {
    m.state.rows.putLine(KEY, ID_A, 'old');
    m.state.rows.putLine(KEY, ID_B, 'kept');
    const ticket = deleteLines(KEY, [ID_A]);
    await settle();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(statements()).toEqual([expect.stringMatching(/^BEGIN; SET LOCAL statement_timeout = \d+$/), LOCK, DELETE, OP, 'COMMIT']);
    expect(valuesOf(DELETE)).toEqual([[KEY, [ID_A]]]);
    expect([...m.state.rows.lines.keys()]).toEqual([ID_B]);
  });

  it('a lines-only op whose COMMIT answer was lost: the next attempt finds its op id and inserts nothing again', async () => {
    let commits = 0;
    m.state.rows.fault = sql => (sql === 'COMMIT' && ++commits === 1 ? 'lose' : undefined);
    const ticket = carryLines(KEY, [{ id: ID_A, line: 'a' }]);
    await dm.flushAll();
    expect(rowCommitOwed(ticket)).toBe(true);
    m.state.pg.sent.length = 0;
    endHold();
    await settle();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(m.sql()).toContain(OPS_READ);
    expect(m.sql()).not.toContain(INSERT);
    expect(m.sql()).toContain('ROLLBACK');
  });

  it("a refused op ('io') does not take the ops behind it", async () => {
    let first = true;
    m.state.rows.fault = sql => (sql === INSERT && first ? ((first = false), pgError('22021', 'invalid byte sequence')) : undefined);
    const refused = appendLine(KEY, 'bad', ID_A);
    const next = appendLine(KEY, 'good', ID_B);
    await settle();
    expect(rowTicketState(refused)).toBe('refused');
    expect(refused.op.refusal?.cause).toBe('io');
    expect(rowTicketState(next)).toBe('landed');
    expect([...m.state.rows.lines.keys()]).toEqual([ID_B]);
  });
});

describe('the facade (decision 8): appendData of a lines key on a Postgres bot', () => {
  it('inserts one row with an id minted at the accept, the line without its newline, and writes no file', async () => {
    const res = dm.appendDataTracked('log.jsonl', m.opts, '{"n":1}');
    expect(res.outcome).toBe('appended');
    const ticket = (res as { ticket?: RowTicket }).ticket!;
    expect(ticket.kind).toBe('row');
    await settle();
    expect(rowTicketState(ticket)).toBe('landed');
    const rows = [...m.state.rows.lines.entries()];
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(rows[0][1].key).toBe(KEY);
    expect(rows[0][1].line.toString('utf8')).toBe('{"n":1}');
    expect(fs.existsSync(m.file('log.jsonl'))).toBe(false);
  });

  it('two appends keep their order', async () => {
    dm.appendData('log.jsonl', m.opts, 'first');
    dm.appendData('log.jsonl', m.opts, 'second');
    await settle();
    const read = await readLines(KEY);
    expect(read.ok && read.lines.map(l => l.line)).toEqual(['first', 'second']);
  });

  it('a JSON bot appends to the file as today (guard)', async () => {
    dm.setGuildDataBackend(null);
    setBackendKind('file');
    expect(dm.appendData('log.jsonl', m.opts, 'line')).toBe(true);
    await dm.flushAll();
    expect(fs.readFileSync(m.file('log.jsonl'), 'utf8')).toBe('line\n');
    expect(m.state.rows.lines.size).toBe(0);
  });
});

describe('the journal read (decision 40)', () => {
  it("answers the key's lines in seq order, decoded as text", async () => {
    m.state.rows.putLine(KEY, ID_B, 'first');
    m.state.rows.putLine(KEY, ID_A, 'second');
    m.state.rows.putLine(m.keyOf('other.jsonl'), '00000000-0000-4000-8000-0000000000cc', 'not this key');
    expect(await readLines(KEY)).toEqual({ ok: true, lines: [{ id: ID_B, line: 'first' }, { id: ID_A, line: 'second' }] });
  });

  it('a read the database does not answer answers its cause', async () => {
    m.state.rows.fault = sql => (/shared_lines/.test(sql) ? lost() : undefined);
    expect(await readLines(KEY)).toEqual({ ok: false, cause: 'Connection terminated unexpectedly' });
  });

  it('a process with no data pool answers that it has none', async () => {
    dm.setGuildDataBackend(null);
    expect(await readLines(KEY)).toEqual({ ok: false, cause: "this process has no connection to the bot's database" });
  });
});
