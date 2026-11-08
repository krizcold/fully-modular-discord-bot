// Modules on a Postgres bot (NB6 decisions 15, 24, 35 and 44; C4, C5, C12, C13, C22; D5, D6, D8): publishModule and
// unpublishModule, each one shared transaction that is never retried, whose COMMIT answer, when lost, is settled at
// once by the landing check; and the module fetch, which reads a module's rows into a folder.

import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { QueryResult } from 'pg';
import { processId } from '../fleet/processId';
import type { SharedStatement, SharedTimeout, SharedTxOutcome } from './dataBackends/postgresBackend';
import {
  APPEND_SQL, CHECKED_SQL, DELETE_SQL, LOCK_SQL, nodeOf, NOTIFY_SQL, OP_SQL, OPS_SQL, rowBackend, rowsDeposed, shaOf, updatedBy, UPSERT_SQL,
  type RowBackend,
} from './sharedStore';
import { FLUSH_STATEMENT_BYTES, globalKeyRefusal } from './storableData';

export const INSTALLED_KEY = 'global/appstore/installed.json';

export const credentialsKeyOf = (module: string): string => `global/appstore/credentials/${module}.json`;

const moduleLockOf = (module: string): string => `module:${module}`;

const FILES_DELETE_SQL = 'DELETE FROM smdb_data.shared_module_files WHERE module = $1';
const FILES_APPEND_SQL = 'UPDATE smdb_data.shared_module_files SET bytes = bytes || $3 WHERE module = $1 AND rel = $2';
const MODULE_UPSERT_SQL = `INSERT INTO smdb_data.shared_modules (module, sha, rev, version, file_count, bytes, updated_by)
  VALUES ($1, $2, nextval('smdb_data.shared_rev_seq'), $3, $4, $5, $6)
  ON CONFLICT (module) DO UPDATE SET sha = EXCLUDED.sha, rev = EXCLUDED.rev, version = EXCLUDED.version,
    file_count = EXCLUDED.file_count, bytes = EXCLUDED.bytes, updated_at = now(), updated_by = EXCLUDED.updated_by
  RETURNING rev`;
const MODULE_DELETE_SQL = 'DELETE FROM smdb_data.shared_modules WHERE module = $1 RETURNING rev';
const STATUS_DELETE_SQL = 'DELETE FROM smdb_data.shared_module_status WHERE module = $1';
const LIST_SQL = 'SELECT rel, mode, octet_length(bytes) AS size FROM smdb_data.shared_module_files WHERE module = $1 ORDER BY rel';
const BATCH_SQL = 'SELECT rel, bytes FROM smdb_data.shared_module_files WHERE module = $1 AND rel = ANY($2)';
const PIECE_SQL = `SELECT substring(bytes FROM $3 FOR ${FLUSH_STATEMENT_BYTES}) AS piece FROM smdb_data.shared_module_files WHERE module = $1 AND rel = $2`;
/** Rows of one file insert: 4 parameters each, far under Postgres's 65535. */
const ROWS_PER_INSERT = 1000;
const NO_DATABASE = "this process has no connection to the bot's database";

const filesInsertSql = (rows: number): string =>
  `INSERT INTO smdb_data.shared_module_files (module, rel, bytes, mode) VALUES ${Array.from({ length: rows }, (_, i) => `($${4 * i + 1}, $${4 * i + 2}, $${4 * i + 3}, $${4 * i + 4})`).join(', ')}`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ============================================================================
// A MODULE FOLDER AND ITS SHA
// ============================================================================

/** One file of a module folder: its '/'-separated path inside the folder, its bytes and its permission bits. */
export interface ModuleFile {
  rel: string;
  bytes: Buffer;
  mode: number;
}

const byRel = (a: { rel: string }, b: { rel: string }): number => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

/** Every file under dir, as copyDirectory copies it (a link is read through); throws when one cannot be read. */
export function readModuleFolder(dir: string): ModuleFile[] {
  const files: ModuleFile[] = [];
  const walk = (at: string, rel: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const abs = path.join(at, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, r);
      else files.push({ rel: r, bytes: fs.readFileSync(abs), mode: fs.statSync(abs).mode & 0o777 });
    }
  };
  walk(dir, '');
  return files.sort(byRel);
}

/** A module file's path against a key's rules, except that a part may end in ".tmp": the publish stores every file of the folder. */
export function moduleRelRefusal(rel: string): string | null {
  const parts = rel.split('/');
  const asKey = parts.map(part => (part.endsWith('.tmp') ? `${part.slice(0, -4)}.tmq` : part));
  let refusal = globalKeyRefusal(asKey.join('/'));
  if (refusal === null) return null;
  parts.forEach((part, i) => { if (asKey[i] !== part) refusal = refusal!.split(`"${asKey[i]}"`).join(`"${part}"`); });
  return refusal;
}

/** C1's module sha: the sha256 hex of the sorted "<rel>\0<sha256 hex of the file's bytes>\n" list. */
export function moduleShaOf(files: Array<{ rel: string; sha: string }>): string {
  const hash = createHash('sha256');
  for (const f of [...files].sort(byRel)) hash.update(`${f.rel}\0${f.sha}\n`);
  return hash.digest('hex');
}

// ============================================================================
// THE TEXTS (T35's module forms, D8)
// ============================================================================

export type ModuleOperation = 'install' | 'update' | 'uninstall';

/** T35's <cause> form, which a publish's or an uninstall's refusal carries. */
export function moduleTimeoutCause(t: SharedTimeout): string {
  const kib = Math.ceil(t.bytes / 1024);
  const bound = Math.round(t.boundMs / 1000);
  return t.atBound
    ? `a statement of ${kib} KiB did not finish within the ${bound} s bound (SQLSTATE 57014)`
    : `a statement of ${kib} KiB was cancelled after ${(t.elapsedMs / 1000).toFixed(1)} s, before the ${bound} s bound (SQLSTATE 57014)`;
}

/** T35's module forms: the job ends, nothing saved. */
export function moduleTimeoutText(module: string, operation: ModuleOperation, t: SharedTimeout): string {
  const ended = `Nothing was saved, and the ${operation} of ${module} ended.`;
  return t.atBound
    ? `[Shared] Saving module ${module}: ${moduleTimeoutCause(t)}; a slow link to the database, a slow database or a lock held by another transaction can cause this. ${ended}`
    : `[Shared] Saving module ${module}: ${moduleTimeoutCause(t)}; a cancel request from outside the bot, such as pg_cancel_backend, ends a statement this way. ${ended}`;
}

// ============================================================================
// PUBLISH AND UNPUBLISH (decisions 15, 24, 35, 44; C4, C22; D6)
// ============================================================================

/**
 * How a publish or an uninstall ended. committed: stored (checked when the landing check found it after a lost COMMIT
 * answer); sha is the module's ('absent' for an uninstall). refused: installed.json changed after its base was read
 * (with the writer's machine and time while the row exists), or another process took the data files. failed: nothing
 * was committed. unknown: COMMIT was sent and neither its answer nor a landing check settled it.
 */
export type ModuleSaveAnswer =
  | { kind: 'committed'; sha: string; installedSha: string; checked: boolean }
  | { kind: 'refused'; cause: 'changed-elsewhere'; by?: string; at?: Date }
  | { kind: 'refused'; cause: 'writer-lost' }
  | { kind: 'failed'; cause: string }
  | { kind: 'unknown'; cause: string };

type ModuleStop = { cause: 'changed-elsewhere'; by?: string; at?: Date };

const notice = (payload: Record<string, unknown>): SharedStatement<ModuleStop> => ({ text: NOTIFY_SQL, values: [JSON.stringify(payload)] });

/** Decision 15's base check of installed.json, read under the locks. */
function baseCheck(base: string): SharedStatement<ModuleStop> {
  return {
    text: CHECKED_SQL,
    values: [INSTALLED_KEY],
    next: res => {
      const row = res.rows[0];
      if ((row ? String(row.sha) : 'absent') === base) return;
      return { stop: { cause: 'changed-elsewhere', ...(row ? { by: nodeOf(String(row.updated_by ?? '')), at: new Date(row.updated_at) } : {}) } };
    },
  };
}

/** A doc row written whole, its body in pieces of at most 4 MiB of values a statement (C4); onRev takes its rev. */
function docWrite(key: string, body: Buffer, sha: string, by: string, onRev: (rev: number) => void): SharedStatement<ModuleStop>[] {
  const first = FLUSH_STATEMENT_BYTES - Buffer.byteLength(key) - Buffer.byteLength(sha) - Buffer.byteLength(by);
  const piece = FLUSH_STATEMENT_BYTES - Buffer.byteLength(key);
  const pieces: Buffer[] = [];
  for (let at = Math.min(first, body.length); at < body.length; at += piece) pieces.push(body.subarray(at, Math.min(body.length, at + piece)));
  return [{
    text: UPSERT_SQL,
    values: [key, body.subarray(0, Math.min(first, body.length)), sha, by],
    next: res => {
      onRev(Number(res.rows[0]?.rev ?? 0));
      return pieces.map(p => ({ text: APPEND_SQL, values: [key, p] }));
    },
  }];
}

/**
 * C4: the file rows in inserts of at most 4 MiB of values; a file larger than that is its first piece as an insert,
 * then an append per further piece.
 */
function fileStatements(module: string, files: ModuleFile[]): SharedStatement<ModuleStop>[] {
  const out: SharedStatement<ModuleStop>[] = [];
  const nameBytes = Buffer.byteLength(module);
  let batch: unknown[] = [];
  let batchBytes = 0;
  const flush = () => {
    if (batch.length === 0) return;
    out.push({ text: filesInsertSql(batch.length / 4), values: batch });
    batch = [];
    batchBytes = 0;
  };
  for (const f of files) {
    const fixed = nameBytes + Buffer.byteLength(f.rel) + String(f.mode).length;
    if (fixed + f.bytes.length > FLUSH_STATEMENT_BYTES) {
      flush();
      const first = FLUSH_STATEMENT_BYTES - fixed;
      const piece = FLUSH_STATEMENT_BYTES - nameBytes - Buffer.byteLength(f.rel);
      if (first <= 0) throw new Error(`the path of ${f.rel} in ${module} leaves no room for its bytes in a statement`);
      out.push({ text: filesInsertSql(1), values: [module, f.rel, f.bytes.subarray(0, first), f.mode] });
      for (let at = first; at < f.bytes.length; at += piece) out.push({ text: FILES_APPEND_SQL, values: [module, f.rel, f.bytes.subarray(at, Math.min(f.bytes.length, at + piece))] });
      continue;
    }
    if (batchBytes + fixed + f.bytes.length > FLUSH_STATEMENT_BYTES || batch.length / 4 >= ROWS_PER_INSERT) flush();
    batch.push(module, f.rel, f.bytes, f.mode);
    batchBytes += fixed + f.bytes.length;
  }
  flush();
  return out;
}

/** D6's landing check as a transaction of its own, for a backend whose sharedTx runs none at once (the web UI's). */
async function checkLanded(backend: RowBackend, check: SharedStatement[]): Promise<QueryResult[] | null> {
  let answers: QueryResult[] | null = null;
  try {
    const outcome = await backend.sharedTx<null>({
      check,
      statements: rows => {
        answers = rows;
        return { stop: null };
      },
    });
    return outcome.kind === 'stopped' ? answers : null;
  } catch {
    return null;
  }
}

/**
 * One publish or uninstall: the locks in sorted order, then the statements build gives (their last one inserts the op
 * id), as one shared transaction that is not retried (C22). A COMMIT answer lost is settled by the landing check at
 * once (D6): in the bot inside sharedTx, on a new client within the transaction's places; elsewhere as a transaction of
 * its own.
 */
async function saveModule(
  module: string,
  operation: ModuleOperation,
  locks: string[],
  build: (attemptId: string) => SharedStatement<ModuleStop>[],
  result: { sha: string; installedSha: string },
): Promise<ModuleSaveAnswer> {
  if (rowsDeposed()) return { kind: 'refused', cause: 'writer-lost' };
  const backend = rowBackend();
  if (!backend) return { kind: 'failed', cause: NO_DATABASE };
  const attemptId = randomUUID();
  const lockStatements = locks.map(key => ({ text: LOCK_SQL, values: [key] }));
  const check: SharedStatement[] = [...lockStatements, { text: OPS_SQL, values: [[attemptId]] }];
  let outcome: SharedTxOutcome<ModuleStop>;
  try {
    outcome = await backend.sharedTx<ModuleStop>({ check: null, statements: () => [...lockStatements, ...build(attemptId)], checkAtOnce: check });
  } catch (error) {
    outcome = { kind: 'failed', step: 'statements', detail: messageOf(error) };
  }
  switch (outcome.kind) {
    case 'committed':
    case 'landed':
      return { kind: 'committed', ...result, checked: false };
    case 'stopped':
      return { kind: 'refused', ...outcome.value };
    case 'refused':
      return { kind: 'failed', cause: outcome.detail };
    case 'failed':
      if (outcome.timeout) {
        console.error(moduleTimeoutText(module, operation, outcome.timeout));
        return { kind: 'failed', cause: moduleTimeoutCause(outcome.timeout) };
      }
      return { kind: 'failed', cause: outcome.detail };
    case 'unknown': {
      const cause = outcome.detail ?? 'no answer';
      const answers = outcome.checked !== undefined ? outcome.checked : await checkLanded(backend, check);
      if (!answers) return { kind: 'unknown', cause };
      // Under the locks no attempt of this call can still be running: no row means it was not stored.
      return answers[answers.length - 1].rows.length > 0 ? { kind: 'committed', ...result, checked: true } : { kind: 'failed', cause };
    }
  }
}

/**
 * Decisions 15 and 35: a module folder (35's staged copy) and installed.json's new body, in one transaction under the
 * advisory locks of `module:<name>` and installed.json: installed.json's base checked, the module's file rows replaced
 * by every file under dir, the manifest row, the installed.json row, the op id, one notification for each.
 */
export async function publishModule(
  name: string,
  dir: string,
  installedBody: string | Buffer,
  installedBase: string,
  opts: { operation: 'install' | 'update'; version?: string | null },
): Promise<ModuleSaveAnswer> {
  if (rowsDeposed()) return { kind: 'refused', cause: 'writer-lost' };
  let files: ModuleFile[];
  try {
    files = readModuleFolder(dir);
  } catch (error) {
    return { kind: 'failed', cause: `could not read ${dir} (${messageOf(error)})` };
  }
  const sha = moduleShaOf(files.map(f => ({ rel: f.rel, sha: shaOf(f.bytes) })));
  const installed = Buffer.isBuffer(installedBody) ? installedBody : Buffer.from(installedBody, 'utf8');
  const installedSha = shaOf(installed);
  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  const by = updatedBy();
  return saveModule(name, opts.operation, [INSTALLED_KEY, moduleLockOf(name)].sort(), attemptId => {
    const revs = { module: 0, installed: 0 };
    return [
      baseCheck(installedBase),
      { text: FILES_DELETE_SQL, values: [name] },
      ...fileStatements(name, files),
      { text: MODULE_UPSERT_SQL, values: [name, sha, opts.version ?? null, files.length, total, by], next: res => { revs.module = Number(res.rows[0]?.rev ?? 0); } },
      ...docWrite(INSTALLED_KEY, installed, installedSha, by, rev => { revs.installed = rev; }),
      {
        text: OP_SQL,
        values: [attemptId],
        next: () => [
          notice({ k: 'module', module: name, sha, rev: revs.module, by: processId() }),
          notice({ k: 'doc', key: INSTALLED_KEY, sha: installedSha, rev: revs.installed, by: processId() }),
        ],
      },
    ];
  }, { sha, installedSha });
}

/**
 * Decisions 15 and 44: an uninstall, in one transaction under the locks of the module, installed.json and the module's
 * credentials doc: installed.json's base checked, the file rows, the manifest row, the module's status rows and the
 * credentials doc deleted, installed.json written, the op id, a notification for each row that changed.
 */
export async function unpublishModule(name: string, installedBody: string | Buffer, installedBase: string): Promise<ModuleSaveAnswer> {
  const credentials = credentialsKeyOf(name);
  const installed = Buffer.isBuffer(installedBody) ? installedBody : Buffer.from(installedBody, 'utf8');
  const installedSha = shaOf(installed);
  const by = updatedBy();
  return saveModule(name, 'uninstall', [credentials, INSTALLED_KEY, moduleLockOf(name)].sort(), attemptId => {
    const revs: { module: number | null; credentials: number | null; installed: number } = { module: null, credentials: null, installed: 0 };
    const deletedRev = (res: QueryResult): number | null => (res.rows.length > 0 ? Number(res.rows[0].rev) : null);
    return [
      baseCheck(installedBase),
      { text: FILES_DELETE_SQL, values: [name] },
      { text: MODULE_DELETE_SQL, values: [name], next: res => { revs.module = deletedRev(res); } },
      { text: STATUS_DELETE_SQL, values: [name] },
      { text: DELETE_SQL, values: [credentials], next: res => { revs.credentials = deletedRev(res); } },
      ...docWrite(INSTALLED_KEY, installed, installedSha, by, rev => { revs.installed = rev; }),
      {
        text: OP_SQL,
        values: [attemptId],
        next: () => [
          ...(revs.module === null ? [] : [notice({ k: 'module', module: name, sha: 'absent', rev: revs.module, by: processId() })]),
          ...(revs.credentials === null ? [] : [notice({ k: 'doc', key: credentials, sha: 'absent', rev: revs.credentials, by: processId() })]),
          notice({ k: 'doc', key: INSTALLED_KEY, sha: installedSha, rev: revs.installed, by: processId() }),
        ],
      },
    ];
  }, { sha: 'absent', installedSha });
}

// ============================================================================
// THE MODULE FETCH (decision 43 step 1; C4; D5)
// ============================================================================

/** The fetched folder's sha, file count and bytes, recomputed from the bytes written; or why the fetch stopped. */
export type ModuleFetch = { ok: true; sha: string; files: number; bytes: number } | { ok: false; cause: string };

class FetchStop extends Error {}

/** The absolute path of rel under into, or null when rel would leave it. */
function targetOf(into: string, rel: string): string | null {
  const parts = rel.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..' || p.includes('\0') || (process.platform === 'win32' && /[\\:]/.test(p)))) return null;
  const root = path.resolve(into);
  const abs = path.resolve(root, ...parts);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/** Writes every byte of data at the file's position; a write that takes none throws, so no part of a file passes as whole. */
function writeAll(fd: number, data: Buffer): void {
  for (let at = 0; at < data.length;) {
    const n = fs.writeSync(fd, data, at, data.length - at);
    if (n <= 0) throw new Error(`a write took no bytes after ${at} of ${data.length}`);
    at += n;
  }
}

function syncDir(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Decision 43 step 1: the module's rows written into `into` (made when absent), each SELECT in its own read-only
 * transaction with at most 4 MiB of file bytes (a larger file in pieces), every file and folder fsynced; the answer
 * carries the sha of the bytes written, which the caller compares with the row's. Rows changed meanwhile give another
 * sha. Nothing is written outside `into`.
 */
export async function fetchModule(name: string, into: string): Promise<ModuleFetch> {
  const backend = rowBackend();
  if (!backend?.sharedRead) return { ok: false, cause: NO_DATABASE };
  const read = async (text: string, values: unknown[]): Promise<any[]> => {
    const out = await backend.sharedRead!(text, values);
    if (out.kind === 'read') return out.rows;
    throw new FetchStop(out.kind === 'failed' && out.timeout ? moduleTimeoutCause(out.timeout) : out.detail);
  };
  try {
    const listed = (await read(LIST_SQL, [name])).map(row => ({ rel: String(row.rel), mode: Number(row.mode), size: Number(row.size) }));
    const targets = new Map<string, string>();
    for (const f of listed) {
      const abs = targetOf(into, f.rel);
      if (!abs) throw new FetchStop(`the database holds a file path that leaves ${name}'s folder: ${f.rel}`);
      targets.set(f.rel, abs);
    }
    fs.mkdirSync(into, { recursive: true });
    const dirs = new Set<string>([path.resolve(into)]);
    const shas: Array<{ rel: string; sha: string }> = [];
    let bytes = 0;
    const open = (rel: string, mode: number): number => {
      const abs = targets.get(rel)!;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      for (let d = path.dirname(abs); d.startsWith(path.resolve(into)) && !dirs.has(d); d = path.dirname(d)) dirs.add(d);
      return fs.openSync(abs, 'w', mode);
    };
    const close = (rel: string, fd: number, mode: number) => {
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.chmodSync(targets.get(rel)!, mode);
    };
    const writeWhole = (rel: string, mode: number, data: Buffer) => {
      const fd = open(rel, mode);
      try {
        writeAll(fd, data);
      } finally {
        close(rel, fd, mode);
      }
      shas.push({ rel, sha: shaOf(data) });
      bytes += data.length;
    };
    const asBuffer = (v: unknown): Buffer => (Buffer.isBuffer(v) ? v : Buffer.from(String(v ?? ''), 'utf8'));

    let batch: typeof listed = [];
    let batchBytes = 0;
    const readBatch = async () => {
      if (batch.length === 0) return;
      const modes = new Map(batch.map(f => [f.rel, f.mode]));
      const rows = await read(BATCH_SQL, [name, batch.map(f => f.rel)]);
      batch = [];
      batchBytes = 0;
      for (const row of rows) {
        const rel = String(row.rel);
        if (modes.has(rel)) writeWhole(rel, modes.get(rel)!, asBuffer(row.bytes));
      }
    };
    for (const f of listed) {
      if (f.size > FLUSH_STATEMENT_BYTES) {
        const hash = createHash('sha256');
        let written = 0;
        let fd: number | null = null;
        try {
          for (let from = 1; from <= f.size; from += FLUSH_STATEMENT_BYTES) {
            const rows = await read(PIECE_SQL, [name, f.rel, from]);
            if (rows.length === 0) break;
            const piece = asBuffer(rows[0].piece);
            if (fd === null) fd = open(f.rel, f.mode);
            writeAll(fd, piece);
            hash.update(piece);
            written += piece.length;
            if (piece.length < FLUSH_STATEMENT_BYTES) break;
          }
        } finally {
          if (fd !== null) close(f.rel, fd, f.mode);
        }
        if (fd !== null) {
          shas.push({ rel: f.rel, sha: hash.digest('hex') });
          bytes += written;
        }
        continue;
      }
      if (batchBytes + f.size > FLUSH_STATEMENT_BYTES) await readBatch();
      batch.push(f);
      batchBytes += f.size;
    }
    await readBatch();
    for (const dir of dirs) syncDir(dir);
    return { ok: true, sha: moduleShaOf(shas), files: shas.length, bytes };
  } catch (error) {
    return { ok: false, cause: messageOf(error) };
  }
}
