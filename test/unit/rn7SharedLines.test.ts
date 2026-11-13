import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { carryLines, readLines } from '../../src/bot/internalSetup/utils/sharedLines';
import { _resetRowQueue, rowCommitOwed, rowQueue, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror } from '../../src/bot/internalSetup/utils/sharedMirror';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { lost, sharedRows } from '../helpers/sharedRows';

// sharedLines.ts (NB6 decisions 24, 40, 47 and 48): a lines-only op under its doc's lock checks its op ids after a lost
// answer and ends unconfirmed at the database's 6 days; the bytes it counts; the read of a key's lines.

const CATEGORY = 'rn7lines';
const KEY = `global/${CATEGORY}/log.jsonl`;
const DOC_KEY = `global/${CATEGORY}/doc.json`;
const LOCK = "SELECT now() AS now, pg_advisory_xact_lock(hashtext('smdb_shared'), hashtext($1))";
const INSERT = 'INSERT INTO smdb_data.shared_lines (key, id, line) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING';
const ID_A = '00000000-0000-4000-8000-0000000000a1';
const ID_B = '00000000-0000-4000-8000-0000000000b2';
const DAY = 24 * 60 * 60 * 1000;
const TOO_OLD_LOG = `[Shared] Can't confirm whether ${KEY} was saved: the database's answer to the save was lost and could not be checked (its oldest attempt was made 6 or more days ago)`;

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;
let errors: string[];
let override: ((sql: string) => unknown) | undefined;

beforeEach(() => {
  errors = [];
  override = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  _resetRowQueue();
  _resetSharedMirror();
  fs.rmSync(dataPath('global', CATEGORY), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  setBackendKind('postgres');
  rows = sharedRows();
  rig = scriptedBackend((sql, params, call, client) => override?.(sql) ?? rows.answer(sql, params, call, client));
  dm.setGuildDataBackend(rig.backend);
});

afterEach(async () => {
  _resetSharedMirror();
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  setBackendKind(null);
  await rig.backend.stop();
  vi.restoreAllMocks();
});

const endHold = () => rig.backend.confirmHold((rig.backend as unknown as { epoch: number }).epoch);
const storedLines = () => [...rows.lines.entries()].filter(([, r]) => r.key === KEY).map(([id, r]) => [id, r.line.toString('utf8')]);
const lockValues = () => rig.sent.filter(s => s.sql === LOCK).map(s => s.params ?? (s.raw as { values?: unknown[] }).values);

async function settle(): Promise<void> {
  for (let i = 0; i < 10 && rowQueue.ops(KEY).length > 0; i++) await dm.flushAll();
}

/** A lines-only op whose COMMIT answer was lost and whose COMMIT never reached the database. */
async function lostCarry(commitsLost = 1): Promise<RowTicket> {
  let commits = 0;
  rows.fault = sql => (sql === 'COMMIT' && ++commits <= commitsLost ? lost() : undefined);
  const ticket = carryLines(KEY, [{ id: ID_A, line: 'a' }], { lockKey: DOC_KEY });
  await dm.flushAll();
  expect(rowCommitOwed(ticket)).toBe(true);
  endHold();
  return ticket;
}

describe('a lines-only op after a lost answer', () => {
  it('checks its op id under the lock of its doc, finds none and stores its lines once', async () => {
    const ticket = await lostCarry();
    await settle();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(storedLines()).toEqual([[ID_A, 'a']]);
    expect(rows.ops.size).toBe(1);
    expect(lockValues()).toEqual([[DOC_KEY], [DOC_KEY]]);
  });

  it('ends unconfirmed when the check runs 6 days after the attempt by the database clock, and stores nothing', async () => {
    const ticket = await lostCarry();
    rows.clock.now = new Date(rows.clock.now.getTime() + 6 * DAY);
    await settle();
    expect(rowTicketState(ticket)).toBe('unconfirmed');
    expect(storedLines()).toEqual([]);
    expect(errors).toContain(TOO_OLD_LOG);
  });

  it('a second lost answer after a check counts its 6 days from that check', async () => {
    const ticket = await lostCarry(2);
    await dm.flushAll();
    expect(rowCommitOwed(ticket)).toBe(true);
    expect(storedLines()).toEqual([]);
    endHold();
    rows.clock.now = new Date(rows.clock.now.getTime() + 6 * DAY);
    await settle();
    expect(rowTicketState(ticket)).toBe('unconfirmed');
    expect(storedLines()).toEqual([]);
    expect(errors).toContain(TOO_OLD_LOG);
  });
});

describe('a lock answer that carries no row', () => {
  const noLockRow = (sql: string) => (sql === LOCK ? { rows: [], rowCount: 0 } : undefined);

  it('on a first attempt: the lines are stored', async () => {
    override = noLockRow;
    const ticket = carryLines(KEY, [{ id: ID_A, line: 'a' }], { lockKey: DOC_KEY });
    await settle();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(storedLines()).toEqual([[ID_A, 'a']]);
  });

  it('on the check after a lost answer: the op id is checked and the lines are stored', async () => {
    const ticket = await lostCarry();
    override = noLockRow;
    await settle();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(storedLines()).toEqual([[ID_A, 'a']]);
  });
});

describe('the bytes a lines-only op counts (decision 7)', () => {
  it('is the sum of its lines in UTF-8 while it is not stored', () => {
    carryLines(KEY, [{ id: ID_A, line: 'ab' }, { id: ID_B, line: Buffer.from([1, 2, 3]) }, { id: 'c', line: 'é' }]);
    expect(rowQueue.bytes()).toBe(7);
  });
});

describe('readLines', () => {
  it('reads a line the driver answers as text, and a missing line as an empty one', async () => {
    override = sql => (/FROM smdb_data\.shared_lines WHERE key = \$1 ORDER BY seq/.test(sql) ? { rows: [{ id: 1, line: 'as text' }, { id: ID_B, line: null }], rowCount: 2 } : undefined);
    expect(await readLines(KEY)).toEqual({ ok: true, lines: [{ id: '1', line: 'as text' }, { id: ID_B, line: '' }] });
  });
});
