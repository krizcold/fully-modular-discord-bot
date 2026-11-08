import { createHash } from 'crypto';
import type { Answer } from './scriptedPg';

// The shared tables (NB6 C1) as scriptedPg's answer: smdb_data.shared_docs, shared_lines, shared_ops and the module
// tables, written by the
// statements the row flush sends and read by the mirror pass's, each client's writes kept apart until its COMMIT and
// dropped at ROLLBACK, as the server does. Notifications go out at COMMIT only. A fault answers a statement before the model does, at once or
// through a promise: an Error to throw, 'lose' to apply the statement and then throw (a COMMIT's answer lost), or
// undefined to let the model answer.

export interface DocRow {
  body: Buffer;
  sha: string;
  rev: string;
  updated_at: Date;
  updated_by: string;
}

type Fault = Error | 'lose' | undefined;

export interface LineRow {
  key: string;
  seq: number;
  line: Buffer;
}

type LineWrite = { kind: 'insert'; key: string; id: string; line: Buffer } | { kind: 'delete'; key: string; ids: string[] };

export interface ModuleRow {
  sha: string;
  rev: string;
  version: string | null;
  file_count: number;
  bytes: number;
  updated_by: string;
}

export interface StatusRow {
  node_name: string;
  sha: string;
  state: string;
  error: string | null;
  at: string;
  process_id: string;
  seq: number;
}

export interface ModuleFileRow {
  bytes: Buffer;
  mode: number;
}

export const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const lost = () => new Error('Connection terminated unexpectedly');
export const pgError = (code: string, message = `error ${code}`) => Object.assign(new Error(message), { code, severity: 'ERROR' });

export function sharedRows() {
  const docs = new Map<string, DocRow>();
  const lines = new Map<string, LineRow>();
  /** Each committed line insert that stored a row, and each line a committed delete removed, in order. */
  const lineLog: Array<{ kind: 'insert' | 'delete'; key: string; id: string }> = [];
  let seq = 0;
  const ops = new Map<string, Date>();
  /** NB4's shard_nodes as the liveness test of a journal line's writer reads it, by process id. */
  const nodes = new Map<string, { takeoverSeconds: number; live: boolean }>();
  const notices: string[] = [];
  /** The database's now() at each prune of shared_ops the pass sent. */
  const prunes: Date[] = [];
  /** Each committed write of a key: the sha before and after it, with the op ids its transaction inserted. */
  const history: Array<{ key: string; before: string; after: string; ids: string[] }> = [];
  const clock = { now: new Date('2026-11-07T10:00:00.000Z') };
  let rev = 0;
  /** shared_modules, shared_module_files (by module, then rel) and shared_module_status (by module, then node id). */
  const modules = new Map<string, ModuleRow>();
  const moduleFiles = new Map<string, Map<string, ModuleFileRow>>();
  const moduleStatus = new Map<string, Map<string, StatusRow>>();
  type Tx = {
    docs: Map<string, DocRow | null>;
    ops: string[];
    notices: string[];
    lines: LineWrite[];
    modules: Map<string, ModuleRow | null>;
    files: Map<string, Map<string, ModuleFileRow>>;
    status: Set<string>;
    upserts: Array<{ module: string; node: string; row: StatusRow }>;
  };
  const newTx = (): Tx => ({ docs: new Map(), ops: [], notices: [], lines: [], modules: new Map(), files: new Map(), status: new Set(), upserts: [] });
  const txs = new Map<number, Tx>();
  const state = { fault: undefined as ((sql: string, params: unknown[] | undefined, client: number) => Fault | Promise<Fault | void>) | undefined };

  const view = (client: number, key: string): DocRow | null => {
    const tx = txs.get(client);
    if (tx?.docs.has(key)) return tx.docs.get(key) ?? null;
    return docs.get(key) ?? null;
  };
  const commit = (client: number) => {
    const tx = txs.get(client);
    txs.delete(client);
    if (!tx) return;
    for (const [key, row] of tx.docs) {
      history.push({ key, before: docs.get(key)?.sha ?? 'absent', after: row?.sha ?? 'absent', ids: [...tx.ops] });
      if (row) docs.set(key, row);
      else docs.delete(key);
    }
    for (const id of tx.ops) ops.set(id, clock.now);
    for (const [name, row] of tx.modules) {
      if (row) modules.set(name, row);
      else modules.delete(name);
    }
    for (const [name, files] of tx.files) {
      if (files.size > 0) moduleFiles.set(name, files);
      else moduleFiles.delete(name);
    }
    for (const name of tx.status) moduleStatus.delete(name);
    for (const u of tx.upserts) {
      const rows = moduleStatus.get(u.module) ?? new Map<string, StatusRow>();
      const old = rows.get(u.node);
      // decision 83's WHERE: another process's row is replaced; within one process only by a higher seq.
      if (!old || old.process_id !== u.row.process_id || old.seq < u.row.seq) rows.set(u.node, u.row);
      moduleStatus.set(u.module, rows);
    }
    for (const w of tx.lines) {
      if (w.kind === 'insert') {
        if (lines.has(w.id)) continue;
        seq += 1;
        lines.set(w.id, { key: w.key, seq, line: w.line });
        lineLog.push({ kind: 'insert', key: w.key, id: w.id });
        continue;
      }
      for (const id of w.ids) {
        if (lines.get(id)?.key !== w.key) continue;
        lines.delete(id);
        lineLog.push({ kind: 'delete', key: w.key, id });
      }
    }
    notices.push(...tx.notices);
  };
  const txOf = (client: number) => {
    let tx = txs.get(client);
    if (!tx) {
      tx = newTx();
      txs.set(client, tx);
    }
    return tx;
  };
  const filesView = (client: number, name: string): Map<string, ModuleFileRow> => txs.get(client)?.files.get(name) ?? moduleFiles.get(name) ?? new Map();
  const filesFor = (client: number, name: string): Map<string, ModuleFileRow> => {
    const tx = txOf(client);
    let files = tx.files.get(name);
    if (!files) {
      files = new Map([...(moduleFiles.get(name) ?? new Map<string, ModuleFileRow>())].map(([rel, f]) => [rel, { ...f }]));
      tx.files.set(name, files);
    }
    return files;
  };
  const moduleView = (client: number, name: string): ModuleRow | null => {
    const tx = txs.get(client);
    if (tx?.modules.has(name)) return tx.modules.get(name) ?? null;
    return modules.get(name) ?? null;
  };

  const modelModules = (sql: string, p: unknown[], client: number): unknown => {
    if (sql === 'DELETE FROM smdb_data.shared_module_files WHERE module = $1') {
      const files = filesFor(client, String(p[0]));
      const n = files.size;
      files.clear();
      return { rows: [], rowCount: n };
    }
    if (sql.startsWith('INSERT INTO smdb_data.shared_module_files (module, rel, bytes, mode) VALUES ')) {
      for (let i = 0; i < p.length; i += 4) filesFor(client, String(p[i])).set(String(p[i + 1]), { bytes: Buffer.from(p[i + 2] as Buffer), mode: Number(p[i + 3]) });
      return { rows: [], rowCount: p.length / 4 };
    }
    if (sql === 'UPDATE smdb_data.shared_module_files SET bytes = bytes || $3 WHERE module = $1 AND rel = $2') {
      const file = filesFor(client, String(p[0])).get(String(p[1]));
      if (!file) return { rows: [], rowCount: 0 };
      file.bytes = Buffer.concat([file.bytes, p[2] as Buffer]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO smdb_data.shared_modules ')) {
      rev += 1;
      txOf(client).modules.set(String(p[0]), {
        sha: String(p[1]), rev: String(rev), version: p[2] === null ? null : String(p[2]), file_count: Number(p[3]), bytes: Number(p[4]), updated_by: String(p[5]),
      });
      return { rows: [{ rev: String(rev) }], rowCount: 1 };
    }
    if (sql === 'DELETE FROM smdb_data.shared_modules WHERE module = $1 RETURNING rev') {
      const row = moduleView(client, String(p[0]));
      txOf(client).modules.set(String(p[0]), null);
      return row ? { rows: [{ rev: row.rev }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql === 'SELECT module, sha, version, updated_by FROM smdb_data.shared_modules') {
      const rows = [...modules].map(([module, row]) => ({ module, sha: row.sha, version: row.version, updated_by: row.updated_by }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('INSERT INTO smdb_data.shared_module_status ')) {
      txOf(client).upserts.push({
        module: String(p[0]),
        node: String(p[1]),
        row: { node_name: String(p[2]), sha: String(p[3]), state: String(p[4]), error: p[5] === null ? null : String(p[5]), at: String(p[6]), process_id: String(p[7]), seq: Number(p[8]) },
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql === "SELECT s.module, s.node_name, s.sha, s.error, m.version FROM smdb_data.shared_module_status s LEFT JOIN smdb_data.shared_modules m ON m.module = s.module AND m.sha = s.sha WHERE s.state = 'failed' ORDER BY s.module, s.node_name") {
      const rows = [...moduleStatus].flatMap(([module, byNode]) => [...byNode.values()]
        .filter(row => row.state === 'failed')
        .map(row => ({ module, node_name: row.node_name, sha: row.sha, error: row.error, version: modules.get(module)?.sha === row.sha ? modules.get(module)!.version : null })))
        .sort((a, b) => (a.module < b.module ? -1 : a.module > b.module ? 1 : a.node_name < b.node_name ? -1 : a.node_name > b.node_name ? 1 : 0));
      return { rows, rowCount: rows.length };
    }
    if (sql === 'DELETE FROM smdb_data.shared_module_status WHERE module = $1') {
      txOf(client).status.add(String(p[0]));
      return { rows: [], rowCount: moduleStatus.get(String(p[0]))?.size ?? 0 };
    }
    if (sql === 'SELECT rel, mode, octet_length(bytes) AS size FROM smdb_data.shared_module_files WHERE module = $1 ORDER BY rel') {
      const rows = [...filesView(client, String(p[0]))].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([rel, f]) => ({ rel, mode: f.mode, size: f.bytes.length }));
      return { rows, rowCount: rows.length };
    }
    if (sql === 'SELECT rel, bytes FROM smdb_data.shared_module_files WHERE module = $1 AND rel = ANY($2)') {
      const want = new Set(p[1] as string[]);
      const rows = [...filesView(client, String(p[0]))].filter(([rel]) => want.has(rel)).map(([rel, f]) => ({ rel, bytes: Buffer.from(f.bytes) }));
      return { rows, rowCount: rows.length };
    }
    if (sql === 'SELECT substring(bytes FROM $3 FOR 4194304) AS piece FROM smdb_data.shared_module_files WHERE module = $1 AND rel = $2') {
      const file = filesView(client, String(p[0])).get(String(p[1]));
      if (!file) return { rows: [], rowCount: 0 };
      const from = Number(p[2]) - 1;
      return { rows: [{ piece: Buffer.from(file.bytes.subarray(from, from + 4194304)) }], rowCount: 1 };
    }
    return undefined;
  };

  const model = (sql: string, p: unknown[], client: number): unknown => {
    if (/^BEGIN/.test(sql)) {
      txs.set(client, newTx());
      return undefined;
    }
    if (/smdb_data\.shared_module/.test(sql)) return modelModules(sql, p, client);
    if (/^SET LOCAL/.test(sql)) return undefined;
    if (sql === 'COMMIT') return commit(client);
    if (sql === 'ROLLBACK') {
      txs.delete(client);
      return undefined;
    }
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [{ now: clock.now, pg_advisory_xact_lock: '' }], rowCount: 1 };
    if (/^SELECT id FROM smdb_data\.shared_ops WHERE id = ANY\(\$1\)$/.test(sql)) {
      const ids = (p[0] as string[]).filter(id => ops.has(id));
      return { rows: ids.map(id => ({ id })), rowCount: ids.length };
    }
    if (/^SELECT (body, )?sha, updated_by, updated_at FROM smdb_data\.shared_docs WHERE key = \$1$/.test(sql)) {
      const row = view(client, String(p[0]));
      if (!row) return { rows: [], rowCount: 0 };
      const out: Record<string, unknown> = { sha: row.sha, updated_by: row.updated_by, updated_at: row.updated_at };
      if (sql.includes('body')) out.body = Buffer.from(row.body);
      return { rows: [out], rowCount: 1 };
    }
    if (sql === 'SELECT key, sha FROM smdb_data.shared_docs') {
      const all = [...docs.entries()].map(([key, row]) => ({ key, sha: row.sha }));
      return { rows: all, rowCount: all.length };
    }
    if (sql === 'SELECT key, sha FROM smdb_data.shared_docs WHERE key = ANY($1)') {
      const want = new Set(p[0] as string[]);
      const some = [...docs.entries()].filter(([key]) => want.has(key)).map(([key, row]) => ({ key, sha: row.sha }));
      return { rows: some, rowCount: some.length };
    }
    if (sql === 'SELECT body FROM smdb_data.shared_docs WHERE key = $1') {
      const row = view(client, String(p[0]));
      return row ? { rows: [{ body: Buffer.from(row.body) }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql === 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1') {
      const row = view(client, String(p[0]));
      return row ? { rows: [{ body: Buffer.from(row.body), sha: row.sha }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql === "DELETE FROM smdb_data.shared_ops WHERE at < now() - interval '7 days'") {
      prunes.push(clock.now);
      return { rows: [], rowCount: 0 };
    }
    if (/^INSERT INTO smdb_data\.shared_docs/.test(sql)) {
      rev += 1;
      txOf(client).docs.set(String(p[0]), { body: Buffer.from(p[1] as Buffer), sha: String(p[2]), rev: String(rev), updated_at: clock.now, updated_by: String(p[3]) });
      return { rows: [{ rev: String(rev) }], rowCount: 1 };
    }
    if (/^UPDATE smdb_data\.shared_docs SET body = body \|\| \$2 WHERE key = \$1$/.test(sql)) {
      const row = view(client, String(p[0]))!;
      txOf(client).docs.set(String(p[0]), { ...row, body: Buffer.concat([row.body, p[1] as Buffer]) });
      return { rows: [], rowCount: 1 };
    }
    if (/^DELETE FROM smdb_data\.shared_docs WHERE key = \$1 RETURNING rev$/.test(sql)) {
      const row = view(client, String(p[0]));
      txOf(client).docs.set(String(p[0]), null);
      return row ? { rows: [{ rev: row.rev }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/^INSERT INTO smdb_data\.shared_ops \(id\) VALUES \(\$1\)$/.test(sql)) {
      txOf(client).ops.push(String(p[0]));
      return { rows: [], rowCount: 1 };
    }
    if (sql === 'INSERT INTO smdb_data.shared_lines (key, id, line) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING') {
      txOf(client).lines.push({ kind: 'insert', key: String(p[0]), id: String(p[1]), line: Buffer.from(p[2] as Buffer) });
      return { rows: [], rowCount: lines.has(String(p[1])) ? 0 : 1 };
    }
    if (sql === 'DELETE FROM smdb_data.shared_lines WHERE key = $1 AND id = ANY($2)') {
      txOf(client).lines.push({ kind: 'delete', key: String(p[0]), ids: [...(p[1] as string[])] });
      return { rows: [], rowCount: 0 };
    }
    if (sql === 'SELECT id, line FROM smdb_data.shared_lines WHERE key = $1 ORDER BY seq') {
      const some = [...lines.entries()].filter(([, row]) => row.key === String(p[0])).sort((a, b) => a[1].seq - b[1].seq)
        .map(([id, row]) => ({ id, line: Buffer.from(row.line) }));
      return { rows: some, rowCount: some.length };
    }
    if (sql.startsWith('SELECT process_id, takeover_seconds, seen_at > now() - make_interval(secs => takeover_seconds) AS live FROM smdb_data.shard_nodes WHERE process_id = ANY($1)')) {
      const want = new Set(p[0] as string[]);
      const some = [...nodes.entries()].filter(([id]) => want.has(id)).map(([process_id, n]) => ({ process_id, takeover_seconds: n.takeoverSeconds, live: n.live }));
      return { rows: some, rowCount: some.length };
    }
    if (/^SELECT pg_notify\('smdb_shared', \$1\)$/.test(sql)) {
      txOf(client).notices.push(String(p[0]));
      return { rows: [{ pg_notify: '' }], rowCount: 1 };
    }
    return undefined;
  };

  const answer: Answer = async (sql, params, _call, client) => {
    const fault = (await state.fault?.(sql, params, client)) as Fault;
    if (fault instanceof Error) return fault;
    if (fault === 'lose') {
      model(sql, params ?? [], client);
      return lost();
    }
    return model(sql, params ?? [], client);
  };

  return {
    docs,
    lines,
    lineLog,
    nodes,
    ops,
    notices,
    prunes,
    history,
    clock,
    modules,
    moduleFiles,
    moduleStatus,
    answer,
    /** A line another machine stored. */
    putLine(key: string, id: string, line: string) {
      seq += 1;
      lines.set(id, { key, seq, line: Buffer.from(line, 'utf8') });
    },
    /** A row another machine stored. */
    put(key: string, body: string | Buffer, by = 'BRAVO/p-bravo') {
      rev += 1;
      const bytes = Buffer.from(body);
      docs.set(key, { body: bytes, sha: sha(bytes), rev: String(rev), updated_at: clock.now, updated_by: by });
    },
    set fault(fn: ((sql: string, params: unknown[] | undefined, client: number) => Fault | Promise<Fault | void>) | undefined) {
      state.fault = fn;
    },
  };
}
