/**
 * The divergence proof behind the failback (PLAN_REPLICATION 20.5, B6 map F31):
 * is this node's own database a PREFIX of the database it follows? Postgres
 * records the answer itself. A promoted copy's newest .history file lists every
 * ancestor timeline with the position where that timeline ended, so this
 * node's data is a prefix exactly when its own timeline appears there and its
 * last position is at or before that row's switch point; otherwise the byte gap
 * is what a re-seed from the followed database would destroy. Unknown is
 * neither: the run asks.
 */
import { Client } from 'pg';
import { CONTROL_SCHEMA } from './postgresControlStore';
import { lsnBytes } from './slotStatus';

export type LineageVerdict = 'prefix' | 'diverged' | 'unknown';

export interface LineageFact {
  verdict: LineageVerdict;
  /** This node's own database: its timeline and its last written (or, in recovery, replayed) position. */
  ownTimeline: number | null;
  ownLsn: string | null;
  ownInRecovery: boolean | null;
  /** The followed database's current timeline, and the position where this node's timeline ended in its history. */
  followedTimeline: number | null;
  switchLsn: string | null;
  /** Bytes of WAL this node's database holds past the switch point, whatever they are; null when none or unread. */
  bytesPast: number | null;
  /** Row changes past the switch point to tables outside the control schema, by table; empty means none could be attributed to one (bookkeeping, maintenance and hint images, or, with verdict unknown, changes to relations the catalog no longer knows); null when the WAL could not be classified. */
  dataChanges: LineageChange[] | null;
  reason: string;
  checkedAt: number;
}

export interface LineageChange {
  schema: string;
  table: string;
  transactions: number;
  changes: number;
}

/** Neither position moves while a node holds, so the refresh only catches a side that was unreadable. */
export const LINEAGE_REFRESH_MS = 60_000;

const QUERY_TIMEOUT_MS = 5000;

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: QUERY_TIMEOUT_MS, query_timeout: QUERY_TIMEOUT_MS });
  client.on('error', () => { /* surfaced by the query that fails */ });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end().catch(() => { /* best effort */ });
  }
}

const HISTORY_NAME = /^[0-9A-F]{8}\.history$/;

/**
 * This database's own position. The control file names the timeline of the
 * last checkpoint, which a fresh promote has not written yet, while the newest
 * history file is named after the live timeline, so the higher of the two wins.
 */
export async function readOwnPosition(url: string): Promise<{ timeline: number; lsn: string; inRecovery: boolean } | { error: string }> {
  try {
    return await withClient(url, async client => {
      const res = await client.query(`SELECT pg_is_in_recovery() AS rec,
        (pg_control_checkpoint()).timeline_id AS tli,
        (CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn() ELSE pg_current_wal_lsn() END)::text AS lsn,
        (SELECT max(name) FROM pg_ls_waldir() WHERE name LIKE '%.history') AS hist`);
      const row = res.rows[0] ?? {};
      const fromControl = Number(row.tli);
      const fromHistory = typeof row.hist === 'string' && HISTORY_NAME.test(row.hist) ? parseInt(row.hist.slice(0, 8), 16) : NaN;
      const timeline = Number.isFinite(fromHistory) ? Math.max(fromControl, fromHistory) : fromControl;
      if (!Number.isFinite(timeline) || typeof row.lsn !== 'string' || lsnBytes(row.lsn) === null) return { error: 'the position could not be read' };
      return { timeline, lsn: row.lsn, inRecovery: row.rec === true };
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export interface TimelineHistory {
  timeline: number;
  rows: { parentTimeline: number; switchLsn: string }[];
}

/** The followed database's branch history; null when it was never promoted (timeline 1 writes no history file). */
export async function readTimelineHistory(url: string): Promise<TimelineHistory | null | { error: string }> {
  try {
    return await withClient(url, async client => {
      const names = await client.query(`SELECT name FROM pg_ls_waldir() WHERE name LIKE '%.history' ORDER BY name DESC LIMIT 1`);
      const name = names.rows.length > 0 ? String(names.rows[0].name) : '';
      if (!HISTORY_NAME.test(name)) return null;
      const file = await client.query('SELECT pg_read_file($1) AS body', ['pg_wal/' + name]);
      const rows = String(file.rows[0]?.body ?? '').split('\n')
        .map(line => line.trim())
        .filter(line => line !== '' && !line.startsWith('#'))
        .map(line => { const parts = line.split(/\s+/); return { parentTimeline: Number(parts[0]), switchLsn: parts[1] ?? '' }; })
        .filter(row => Number.isFinite(row.parentTimeline) && lsnBytes(row.switchLsn) !== null);
      return { timeline: parseInt(name.slice(0, 8), 16), rows };
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

interface WalClassification {
  changes: LineageChange[];
  /** Row changes to relations the catalog no longer knows (dropped or rewritten past the switch point), which no table can be named for. */
  unattributed: { changes: number; transactions: number } | null;
}

/**
 * Row changes in the WAL between two positions, by table, outside the system
 * schemas: what a re-seed would destroy that is DATA. A master's own boot
 * writes control rows before its fence decides, autovacuum prunes and freezes,
 * and wal_log_hints logs page images on plain reads, so bytes past the switch
 * point say nothing by themselves; postgres's own WAL inspector does.
 */
async function classifyWalPast(url: string, from: string, to: string): Promise<WalClassification | { error: string }> {
  try {
    return await withClient(url, async client => {
      // Never a write on the database being judged: a copy fenced read-only
      // refuses even CREATE EXTENSION IF NOT EXISTS, while the inspector's
      // reads work under the fence. The writable primary installs it at boot
      // (postgresControlStore), so a copy of it carries it already.
      const installed = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_walinspect'`);
      if ((installed.rowCount ?? 0) === 0) {
        try {
          await client.query('CREATE EXTENSION pg_walinspect');
        } catch (error) {
          return { error: `the WAL inspector (pg_walinspect) is not installed on this database and could not be installed here (${error instanceof Error ? error.message : String(error)})` };
        }
      }
      // pg_filenode_relation resolves the mapped catalogs too, so a null there
      // is a relation that is really gone; its changes are counted apart
      // rather than dropped by a join, because dropped is what reads prefix.
      const res = await client.query(`WITH refs AS (
          SELECT b.xid, pg_filenode_relation(b.reltablespace, b.relfilenode) AS rel
          FROM pg_get_wal_block_info($1::pg_lsn, $2::pg_lsn) b
          WHERE b.resource_manager IN ('Heap', 'Heap2')
            AND b.record_type IN ('INSERT', 'UPDATE', 'DELETE', 'HOT_UPDATE', 'INSERT+INIT', 'UPDATE+INIT', 'HOT_UPDATE+INIT', 'MULTI_INSERT', 'MULTI_INSERT+INIT', 'TRUNCATE')
            AND b.reldatabase = (SELECT oid FROM pg_database WHERE datname = current_database()))
        SELECT coalesce(n.nspname, '') AS schema, coalesce(c.relname, '') AS table, count(DISTINCT r.xid::text)::int AS transactions, count(*)::int AS changes
        FROM refs r
        LEFT JOIN pg_class c ON c.oid = r.rel
        LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE r.rel IS NULL OR (c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'pg_toast', 'information_schema'))
        GROUP BY 1, 2 ORDER BY 3 DESC, 4 DESC`, [from, to]);
      const rows = res.rows.map(r => ({ schema: String(r.schema), table: String(r.table), transactions: Number(r.transactions), changes: Number(r.changes) }));
      const gone = rows.find(r => r.schema === '' && r.table === '') ?? null;
      return { changes: rows.filter(r => r !== gone), unattributed: gone ? { changes: gone.changes, transactions: gone.transactions } : null };
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The verdict for this node's own database (ownUrl) against the database it follows (followedUrl). */
export async function judgeLineage(ownUrl: string, followedUrl: string): Promise<LineageFact> {
  const checkedAt = Date.now();
  const fact = (verdict: LineageVerdict, reason: string, fields: Partial<LineageFact> = {}): LineageFact => ({
    verdict, ownTimeline: null, ownLsn: null, ownInRecovery: null, followedTimeline: null, switchLsn: null, bytesPast: null, dataChanges: null, reason, checkedAt, ...fields,
  });
  const own = await readOwnPosition(ownUrl);
  if ('error' in own) return fact('unknown', `this node's own database could not be read: ${own.error}`);
  const ownFields = { ownTimeline: own.timeline, ownLsn: own.lsn, ownInRecovery: own.inRecovery };
  const history = await readTimelineHistory(followedUrl);
  if (history && 'error' in history) return fact('unknown', `the database this node follows could not be read: ${history.error}`, ownFields);
  if (history === null) return fact('unknown', 'the database this node follows was never promoted (timeline 1), so it records no branch point to compare against', ownFields);
  const row = history.rows.find(r => r.parentTimeline === own.timeline);
  if (!row) {
    return fact('unknown', `this database's timeline ${own.timeline} is not an ancestor of the followed database's timeline ${history.timeline}, so the two are not on one line of descent`, { ...ownFields, followedTimeline: history.timeline });
  }
  const past = lsnBytes(own.lsn)! - lsnBytes(row.switchLsn)!;
  const shared = { ...ownFields, followedTimeline: history.timeline, switchLsn: row.switchLsn };
  const branch = `${row.switchLsn}, the point where the followed database's timeline ${history.timeline} branched from its timeline ${own.timeline}`;
  if (past <= 0n) {
    return fact('prefix', `this database ended at ${own.lsn} on timeline ${own.timeline}, at or before ${branch}; it holds nothing the followed database lacks`, { ...shared, dataChanges: [] });
  }
  const changes = await classifyWalPast(ownUrl, row.switchLsn, own.lsn);
  const bytes = { ...shared, bytesPast: Number(past) };
  if ('error' in changes) {
    return fact('unknown', `this database holds ${past} bytes of WAL past ${branch}, and what they change could not be read (${changes.error}); treat them as data`, bytes);
  }
  const data = changes.changes.filter(c => c.schema !== CONTROL_SCHEMA);
  const gone = changes.unattributed;
  const goneText = gone ? `${plural(gone.changes, 'row change')} in ${plural(gone.transactions, 'transaction')} to relations this database's catalog no longer knows (dropped or rewritten here)` : '';
  if (data.length > 0) {
    const named = data.map(c => `${c.schema}.${c.table} (${plural(c.changes, 'row change')} in ${plural(c.transactions, 'transaction')})`).join(', ');
    return fact('diverged', `this database changed application data past ${branch}: ${named}${gone ? `, and ${goneText}` : ''}; those rows exist nowhere else`, { ...bytes, dataChanges: data });
  }
  if (gone) {
    return fact('unknown', `this database holds ${past} bytes of WAL past ${branch}, including ${goneText}, which cannot be attributed to a table; treat them as data`, { ...bytes, dataChanges: [] });
  }
  return fact('prefix', `this database holds ${past} bytes of WAL past ${branch}, none of it a change to application data (its own control rows, maintenance and page images only); it holds no application data the followed database lacks`, { ...bytes, dataChanges: [] });
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
