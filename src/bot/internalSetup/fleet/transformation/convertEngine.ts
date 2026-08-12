// Per-guild data movement for the backend transformation: FileRecords out of
// either backend, the interchange namespace-hash formula on both sides, staged
// imports (file: temp dir + rename; postgres: one uncommitted transaction on a
// dedicated connection), and the ownership claim inside the destination commit.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Client } from 'pg';
import { DATA_ROOT } from '../../../../utils/dataRoot';
import { exportNamespace, FileRecord } from '../../utils/dataInterchange';
import type { FenceToken } from '../../utils/dataBackends/backend';
import { graveyardGuildDir, dropPendingForGuild, guildDirExists } from '../../utils/dataBackends/fileBackend';
import { TRANSFORM_STAGING_STATEMENT_TIMEOUT_MS } from '../constants';

const STAGING_ROOT = '_transform';
const EXCLUDED_NAMES = new Set(['.owner', '.freeze']);
const MAX_ROWS_PER_STATEMENT = 200;

function isExcluded(name: string): boolean {
  return EXCLUDED_NAMES.has(name) || name.endsWith('.tmp');
}

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function stagingDirFor(transformationId: string, guildId: string): string {
  return path.join(DATA_ROOT, STAGING_ROOT, transformationId, guildId);
}

/** Remove crashed-conversion staging; keeps the active transformation's dir when given. */
export async function sweepTransformStaging(keepTransformationId: string | null): Promise<void> {
  const base = path.join(DATA_ROOT, STAGING_ROOT);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(base);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === keepTransformationId) continue;
    await fs.promises.rm(path.join(base, entry), { recursive: true, force: true }).catch(() => { /* best effort */ });
  }
}

export async function collectFileRecords(guildId: string): Promise<FileRecord[]> {
  const out: FileRecord[] = [];
  for await (const record of exportNamespace(guildId)) out.push(record);
  return out;
}

/** Postgres rows -> interchange records; relPath mirrors the file layout (module dir, first-slash split). */
export function recordsFromRows(guildId: string, rows: { module: string; filename: string; content: string }[]): FileRecord[] {
  return rows.map(row => {
    const bytes = Buffer.from(row.content, 'utf-8');
    const relPath = row.module ? `${row.module}/${row.filename}` : row.filename;
    return { guildId, relPath, size: bytes.length, sha256: sha256Hex(bytes), bytes };
  });
}

/** Pure directory walk (no flush): the destination-side read for hashing. */
export async function collectDirRecords(guildId: string, base: string): Promise<FileRecord[]> {
  const out: FileRecord[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(base, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isExcluded(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(childRel);
      } else if (entry.isFile()) {
        const bytes = await fs.promises.readFile(path.join(base, childRel)).catch(() => null);
        if (bytes === null) continue;
        out.push({ guildId, relPath: childRel, size: bytes.length, sha256: sha256Hex(bytes), bytes });
      }
    }
  };
  await walk('');
  return out;
}

/** Exact hashNamespace formula (dataInterchange.ts): per-file digests over relPaths in raw UTF-8 byte order. */
export function hashRecords(records: FileRecord[]): { namespaceHash: string; fileCount: number; totalBytes: number } {
  const sorted = [...records].sort((a, b) => Buffer.compare(Buffer.from(a.relPath, 'utf-8'), Buffer.from(b.relPath, 'utf-8')));
  const hash = crypto.createHash('sha256');
  let totalBytes = 0;
  for (const record of sorted) {
    hash.update(`${record.relPath}\n${record.size}\n${record.sha256}\n`);
    totalBytes += record.size;
  }
  return { namespaceHash: hash.digest('hex'), fileCount: sorted.length, totalBytes };
}

// The claim mirrors the backend's fenced hydration claim with one difference:
// an explicit data import un-retires the guild (a mere re-grant never does;
// spec 2.3 keeps retired_at for graveyard restore, but imported live data would
// otherwise be invisible to every catalog read).
const IMPORT_CLAIM_UPDATE = `
  UPDATE smdb_data.guild_ownership
     SET node_id = $2, shard_id = $3, term = $4, epoch = $5, shard_count = $6, retired_at = NULL, updated_at = now()
   WHERE guild_id = $1
     AND ((term, epoch) < ($4, $5) OR ((term, epoch) = ($4, $5) AND node_id = $2))`;

const IMPORT_CLAIM_INSERT = `
  INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, term, epoch, shard_count)
  VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (guild_id) DO NOTHING`;

export type PgImportResult = { ok: true } | { ok: false; reason: string };

function splitRelPath(relPath: string): { module: string; filename: string } {
  const slash = relPath.indexOf('/');
  if (slash === -1) return { module: '', filename: relPath };
  return { module: relPath.slice(0, slash), filename: relPath.slice(slash + 1) };
}

/** A whole document is JSON; a line stream is not. Streams keep append semantics (agg reads, appendData). */
function classifyRecord(record: FileRecord): 'doc' | 'append' {
  try {
    JSON.parse(record.bytes.toString('utf-8'));
    return 'doc';
  } catch {
    return 'append';
  }
}

async function stagingClient(url: string): Promise<Client> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000, keepAlive: true });
  await client.connect();
  // The staging transaction is held across export, hashing and the commit
  // decision, so this session opts out of the tight pool defaults.
  await client.query(`SET statement_timeout = ${TRANSFORM_STAGING_STATEMENT_TIMEOUT_MS}; SET idle_in_transaction_session_timeout = 0`);
  return client;
}

async function claimInTxn(client: Client, guildId: string, fence: FenceToken): Promise<boolean> {
  const params = [guildId, fence.nodeId, fence.shardId, fence.term, fence.epoch, fence.shardCount];
  const updated = await client.query(IMPORT_CLAIM_UPDATE, params);
  if (updated.rowCount === 1) return true;
  const inserted = await client.query(IMPORT_CLAIM_INSERT, params);
  return inserted.rowCount === 1;
}

/** Claim-only transaction for the idempotent short-circuit (destination already carries the data). */
export async function claimGuildOwnership(url: string, guildId: string, fence: FenceToken): Promise<PgImportResult> {
  let client: Client | null = null;
  try {
    client = await stagingClient(url);
    await client.query('BEGIN');
    const claimed = await claimInTxn(client, guildId, fence);
    if (!claimed) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'deposed' };
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => { /* connection gone */ });
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await client?.end().catch(() => { /* best effort */ });
  }
}

/**
 * Staged postgres import: replace the guild's rows, read them back inside the
 * same transaction, verify the namespace hash, claim ownership, then commit.
 * Nothing is visible until COMMIT; any failure discards everything.
 */
export async function importRecordsToPostgres(
  url: string,
  guildId: string,
  records: FileRecord[],
  fence: FenceToken,
  expectedHash: string,
): Promise<PgImportResult> {
  let client: Client | null = null;
  try {
    client = await stagingClient(url);
    await client.query('BEGIN');
    await client.query(`DELETE FROM smdb_data.guild_data WHERE guild_id = $1`, [guildId]);
    await client.query(`DELETE FROM smdb_data.guild_append WHERE guild_id = $1`, [guildId]);

    const docs: { module: string; filename: string; content: string }[] = [];
    const streams: { module: string; filename: string; content: string }[] = [];
    for (const record of records) {
      const key = splitRelPath(record.relPath);
      const target = classifyRecord(record) === 'doc' ? docs : streams;
      target.push({ module: key.module, filename: key.filename, content: record.bytes.toString('utf-8') });
    }
    for (let i = 0; i < docs.length; i += MAX_ROWS_PER_STATEMENT) {
      const batch = docs.slice(i, i + MAX_ROWS_PER_STATEMENT);
      const values: unknown[] = [guildId];
      const tuples = batch.map((row, j) => {
        values.push(row.module, row.filename, row.content);
        const base = 2 + j * 3;
        return `($1, $${base}, $${base + 1}, $${base + 2})`;
      });
      await client.query(
        `INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ${tuples.join(', ')}`,
        values);
    }
    for (const stream of streams) {
      await client.query(
        `INSERT INTO smdb_data.guild_append (guild_id, module, filename, chunk) VALUES ($1, $2, $3, $4)`,
        [guildId, stream.module, stream.filename, stream.content]);
    }

    const docsBack = await client.query(
      `SELECT module, filename, doc AS content FROM smdb_data.guild_data WHERE guild_id = $1`, [guildId]);
    const appendsBack = await client.query(
      `SELECT module, filename, string_agg(chunk, '' ORDER BY seq) AS content
         FROM smdb_data.guild_append WHERE guild_id = $1 GROUP BY module, filename`,
      [guildId]);
    const readBack = recordsFromRows(guildId, [...docsBack.rows, ...appendsBack.rows]);
    const { namespaceHash } = hashRecords(readBack);
    if (namespaceHash !== expectedHash) {
      await client.query('ROLLBACK');
      return { ok: false, reason: `staged verify mismatch: ${namespaceHash} != ${expectedHash}` };
    }

    const claimed = await claimInTxn(client, guildId, fence);
    if (!claimed) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'deposed' };
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => { /* connection gone */ });
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await client?.end().catch(() => { /* best effort */ });
  }
}

/** Swap a verified staging dir into place; an existing live dir goes to the graveyard first. */
export async function commitStagedFileDir(guildId: string, stagingDir: string, replaceReason: string): Promise<{ ok: boolean; reason?: string }> {
  dropPendingForGuild(guildId);
  if (guildDirExists(guildId)) {
    const moved = await graveyardGuildDir(guildId, replaceReason);
    if (!moved) return { ok: false, reason: 'could not graveyard the existing guild dir' };
  }
  try {
    await fs.promises.rename(stagingDir, path.join(DATA_ROOT, guildId));
  } catch (error) {
    return { ok: false, reason: `staging rename failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true };
}
