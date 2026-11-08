// The lines keys of a Postgres bot (NB6 decisions 8, 40, 47, 48 and 54; C5, C12, D5): appends, lines-only ops and
// deletes of shared_lines rows, each an op of the row queue under its lines key, so a key's ops go out one at a time in
// accept order and a delete is sent only after every earlier op of its key settled; and the read of a key's lines.

import { randomUUID } from 'crypto';
import type { SharedStatement, SharedTxSpec } from './dataBackends/postgresBackend';
import {
  LOCK_SQL,
  mirrorPathOf,
  OP_SQL,
  OPS_SQL,
  rowBackend,
  rowQueue,
  UNKNOWN_TOO_OLD,
  unknownTooOld,
  type RowOp,
  type RowStop,
  type RowTicket,
} from './sharedStore';

/** Decision 40: the premium events journal. */
export const JOURNAL_KEY = 'global/premium-tiers.events.jsonl';

const INSERT_SQL = 'INSERT INTO smdb_data.shared_lines (key, id, line) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING';
const DELETE_SQL = 'DELETE FROM smdb_data.shared_lines WHERE key = $1 AND id = ANY($2)';
const READ_SQL = 'SELECT id, line FROM smdb_data.shared_lines WHERE key = $1 ORDER BY seq';
const READ_BOUND_MS = 10_000;

/** A line as its writer built it: the shared_lines id minted then, and its bytes (a string is stored as UTF-8). */
export interface SharedLine {
  id: string;
  line: string | Buffer;
}

const bytesOf = (line: string | Buffer): Buffer => (Buffer.isBuffer(line) ? line : Buffer.from(line, 'utf8'));

const inserts = (key: string, lines: Array<{ id: string; line: Buffer }>): SharedStatement<RowStop>[] =>
  lines.map(l => ({ text: INSERT_SQL, values: [key, l.id, l.line] }));

/**
 * A transaction under one advisory lock that inserts its op id (decision 24): an attempt after one whose answer was
 * lost checks those ids under the lock first, and a found id lands the op with nothing sent again.
 */
function lockedSpec(lockKey: string, statements: SharedStatement<RowStop>[]) {
  return (op: RowOp, attemptId: string, noteNow: (now: Date | null) => void): SharedTxSpec<RowStop> => {
    const body = [...statements, { text: OP_SQL, values: [attemptId] }];
    if (op.unknown.length === 0) {
      return {
        check: null,
        statements: () => [{ text: LOCK_SQL, values: [lockKey], next: res => { noteNow(res.rows[0]?.now ?? null); } }, ...body],
      };
    }
    return {
      check: [{ text: LOCK_SQL, values: [lockKey] }, { text: OPS_SQL, values: [op.unknown.map(u => u.id)] }],
      statements: rows => {
        noteNow(rows![0].rows[0]?.now ?? null);
        if (rows![1].rows.length > 0) return 'landed';
        if (unknownTooOld(op, rows![0].rows[0]?.now ?? null)) return { stop: { kind: 'unconfirmed', cause: UNKNOWN_TOO_OLD } };
        // Under the lock no earlier attempt can still be running, and none landed.
        op.unknown = [];
        return body;
      },
    };
  };
}

/**
 * Decision 8: an append of one line, with the id the appender minted when it accepted the line. Its insert is `ON
 * CONFLICT (id) DO NOTHING`, so an attempt after a lost answer stores the line once; it takes no lock and no op id.
 */
export function appendLine(key: string, line: string | Buffer, id: string = randomUUID()): RowTicket {
  const bytes = bytesOf(line);
  return rowQueue.acceptWork(key, mirrorPathOf(key), {
    bytes: bytes.length,
    spec: () => ({ check: null, statements: () => inserts(key, [{ id, line: bytes }]) }),
  });
}

/**
 * Decisions 47 and 48: a lines-only op. It takes the advisory lock of lockKey (the doc whose save the lines record;
 * the lines key itself when none is given), inserts each line with its own id and inserts its op id; it has no base.
 */
export function carryLines(key: string, lines: SharedLine[], opts: { lockKey?: string } = {}): RowTicket {
  const built = lines.map(l => ({ id: l.id, line: bytesOf(l.line) }));
  return rowQueue.acceptWork(key, mirrorPathOf(key), {
    bytes: built.reduce((n, l) => n + l.line.length, 0),
    spec: lockedSpec(opts.lockKey ?? key, inserts(key, built)),
  });
}

/** Decision 40: deletes the key's lines of the given ids, in one transaction with its op id, under the key's lock. */
export function deleteLines(key: string, ids: string[]): RowTicket {
  return rowQueue.acceptWork(key, mirrorPathOf(key), {
    bytes: 0,
    spec: lockedSpec(key, [{ text: DELETE_SQL, values: [key, [...ids]] }]),
  });
}

/** The lines the database holds for a key, in seq order, decoded as text (C12). */
export type LinesRead = { ok: true; lines: Array<{ id: string; line: string }> } | { ok: false; cause: string };

/** Decision 40's read of a lines key, on the data pool with a 10 s client bound and no place (C5). */
export async function readLines(key: string): Promise<LinesRead> {
  const pool = rowBackend();
  if (!pool?.sharedSelect) return { ok: false, cause: "this process has no connection to the bot's database" };
  try {
    const res = await pool.sharedSelect(READ_SQL, [key], READ_BOUND_MS);
    return {
      ok: true,
      lines: res.rows.map(row => ({ id: String(row.id), line: (Buffer.isBuffer(row.line) ? row.line : Buffer.from(String(row.line ?? ''), 'utf8')).toString('utf8') })),
    };
  } catch (error) {
    return { ok: false, cause: error instanceof Error ? error.message : String(error) };
  }
}

/** The premium events journal's lines (decision 40). */
export function readJournal(): Promise<LinesRead> {
  return readLines(JOURNAL_KEY);
}
