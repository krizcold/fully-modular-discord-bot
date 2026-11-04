import { createHash } from 'crypto';

// An in-memory stand-in for the statements NB3's job sends (dataMigration.ts). A transaction works on a copy of the
// schemas and COMMIT puts the copy in place; locks are not modelled. Tests script failures by statement text.

export interface Row { [k: string]: any }
export interface FakeStore {
  storeId: string | null;
  data: Row[];
  append: Row[];
  grave: Row[];
  owners: Row[];
  /** A schema with no meta table: its store id read answers 42P01. */
  noMeta?: boolean;
}

const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const clone = (m: Map<string, FakeStore>) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]));
const pgError = (code: string, message: string) => Object.assign(new Error(message), { code, severity: 'ERROR' });

export function emptyStore(storeId: string | null): FakeStore {
  return { storeId, data: [], append: [], grave: [], owners: [] };
}

export class FakeDb {
  schemas = new Map<string, FakeStore>();
  sessions: string[] = [];
  encoding = 'UTF8';
  log: Array<{ app: string; sql: string }> = [];
  /** Return an error to throw for a statement, 'hang' for a COMMIT with no answer, or 'rollback' for a COMMIT the server rolls back. */
  fail: ((sql: string, app: string) => Error | 'hang' | 'rollback' | undefined) | null = null;
  refuseLogin = false;
  unreachable = false;
  appendSeq = 1;
  /** server_version_num as the job reads it. */
  serverVersion = 160000;
  pidSeq = 100;
  clients = new Map<number, FakeClient>();
  /** pg_stat_activity of a backend pid as the watchdog's probe reads it; by default an open session waits on its client. */
  backendState: ((pid: number, app: string) => Row | null) | null = null;
  /** The backend of the n-th session named app in `sessions`, given on first sight; pid and start stay until restart(). */
  backends = new Map<string, { pid: number; started: string }>();
  /** Reads of the role's other sessions so far; beforeSessionRead runs before each, so a test can add or drop a session for one read. */
  sessionReads = 0;
  beforeSessionRead: ((read: number) => void) | null = null;

  backendOf(app: string, nth: number): { pid: number; started: string } {
    const key = `${app}#${nth}`;
    let b = this.backends.get(key);
    if (!b) {
      const pid = ++this.pidSeq;
      b = { pid, started: String(1800000000000000 + pid) };
      this.backends.set(key, b);
    }
    return b;
  }

  /** The n-th session named app is now another backend under the same pid. */
  restart(app: string, nth = 0): void {
    const b = this.backendOf(app, nth);
    b.started = String(Number(b.started) + 1);
  }

  connect(app: string): FakeClient {
    if (this.refuseLogin) throw pgError('28000', 'role is not permitted to log in');
    if (this.unreachable) throw new Error('connect ECONNREFUSED');
    return new FakeClient(this, app);
  }

  statements(app?: string): string[] {
    return this.log.filter(e => app === undefined || e.app === app).map(e => e.sql);
  }
}

export class FakeClient {
  private view: Map<string, FakeStore> | null = null;
  /** Set after a statement error inside a transaction: every statement but ROLLBACK answers 25P02, as in Postgres. */
  aborted = false;
  private savepoints: Array<{ name: string; view: Map<string, FakeStore> }> = [];
  /** pg_stat_activity as first read in this transaction: Postgres answers from it until pg_stat_clear_snapshot() or the transaction's end. */
  private statSnapshot: string[] | null = null;
  ended = false;
  readonly pid: number;
  /** backend_start as the job reads it; a test changes it to model another backend under the same pid. */
  started: string;

  constructor(private db: FakeDb, readonly app: string) {
    db.sessions.push(app);
    this.pid = ++db.pidSeq;
    this.started = String(1800000000000000 + this.pid);
    db.clients.set(this.pid, this);
  }

  private get schemas(): Map<string, FakeStore> {
    return this.view ?? this.db.schemas;
  }

  private store(name = 'smdb_data'): FakeStore {
    const s = this.schemas.get(name);
    if (!s) throw pgError('42P01', `relation "${name}.meta" does not exist`);
    return s;
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.endTransaction();
    const i = this.db.sessions.indexOf(this.app);
    if (i >= 0) this.db.sessions.splice(i, 1);
    this.db.clients.delete(this.pid);
  }

  async query(text: string, params: any[] = []): Promise<{ rows: Row[]; command?: string }> {
    const sql = text.replace(/\s+/g, ' ').trim();
    this.db.log.push({ app: this.app, sql });
    if (this.ended) throw new Error('Client was closed and is not queryable');
    const answer = this.db.fail?.(sql, this.app);
    const scripted = answer === 'rollback' && !/^COMMIT/.test(sql) ? undefined : answer;
    if (scripted === 'hang') {
      await this.end();
      throw new Error('Connection terminated unexpectedly');
    }
    const savepoint = /^ROLLBACK TO SAVEPOINT (\w+)/.exec(sql);
    if (savepoint && this.view && !scripted) {
      const i = this.savepoints.map(p => p.name).lastIndexOf(savepoint[1]);
      if (i < 0) throw pgError('3B001', `savepoint "${savepoint[1]}" does not exist`);
      this.view = clone(this.savepoints[i].view);
      this.savepoints.length = i + 1;
      this.aborted = false;
      return { rows: [], command: 'ROLLBACK' };
    }
    if (/^ROLLBACK/.test(sql) && !scripted) { this.endTransaction(); return { rows: [], command: 'ROLLBACK' }; }
    if (/^COMMIT/.test(sql)) {
      if (scripted === 'rollback') { this.endTransaction(); return { rows: [], command: 'ROLLBACK' }; }
      if (scripted) { this.endTransaction(); throw scripted; }
      if (this.aborted) { this.endTransaction(); return { rows: [], command: 'ROLLBACK' }; }
      if (this.view) this.db.schemas = this.view;
      this.endTransaction();
      return { rows: [], command: 'COMMIT' };
    }
    if (scripted && /^ROLLBACK/.test(sql)) throw scripted;
    if (this.aborted) throw pgError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
    try {
      if (scripted) throw scripted;
      return await this.answer(sql, params);
    } catch (error) {
      if (this.view) this.aborted = true;
      throw error;
    }
  }

  private endTransaction(): void {
    this.view = null;
    this.aborted = false;
    this.savepoints = [];
    this.statSnapshot = null;
  }

  private activity(): string[] {
    if (!this.view) return this.db.sessions;
    this.statSnapshot ??= [...this.db.sessions];
    return this.statSnapshot;
  }

  private async answer(sql: string, params: any[]): Promise<{ rows: Row[]; command?: string }> {
    if (/^BEGIN/.test(sql)) { this.view = clone(this.db.schemas); return { rows: [] }; }
    const sp = /^SAVEPOINT (\w+)/.exec(sql);
    if (sp) {
      if (!this.view) throw pgError('25P01', 'SAVEPOINT can only be used in transaction blocks');
      this.savepoints.push({ name: sp[1], view: clone(this.view) });
      return { rows: [] };
    }
    if (/^RELEASE SAVEPOINT/.test(sql)) { this.savepoints.pop(); return { rows: [] }; }
    if (/SHOW server_encoding/.test(sql)) return { rows: [{ server_encoding: this.db.encoding }] };
    if (/current_setting\('server_version_num'\)/.test(sql)) return { rows: [{ version: this.db.serverVersion, pid: this.pid, started: this.started }] };
    if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
    if (/^SELECT state, wait_event_type FROM pg_stat_activity WHERE pid = \$1/.test(sql)) {
      const target = this.db.clients.get(params[0]);
      if (!target) return { rows: [] };
      if (/backend_start/.test(sql) && params[1] !== target.started) return { rows: [] };
      return { rows: [this.db.backendState?.(params[0], target.app) ?? { state: 'idle', wait_event_type: 'Client' }] };
    }
    if (/pg_stat_clear_snapshot/.test(sql)) { this.statSnapshot = null; return { rows: [] }; }
    if (/pg_stat_activity/.test(sql) && /<> ALL/.test(sql) && /AS started/.test(sql)) {
      this.db.beforeSessionRead?.(this.db.sessionReads);
      this.db.sessionReads += 1;
      const excluded: string[] = params[0];
      const nth = new Map<string, number>();
      const all = this.activity().map(app => {
        const k = nth.get(app) ?? 0;
        nth.set(app, k + 1);
        return { app, ...this.db.backendOf(app, k) };
      });
      const self = all.findIndex(a => a.app === this.app);
      if (self >= 0) all.splice(self, 1);
      return { rows: all.filter(a => !excluded.includes(a.app)) };
    }
    if (/pg_stat_activity/.test(sql)) {
      if (/<> ALL/.test(sql)) {
        const excluded: string[] = params[0];
        const others = this.activity().filter(a => !excluded.includes(a));
        return { rows: [{ n: others.length - (excluded.includes(this.app) ? 0 : 1) }] };
      }
      const named = this.activity().filter(a => a === params[0]).length - (this.app === params[0] ? 1 : 0);
      return { rows: [{ n: named }] };
    }
    if (/nspname = 'smdb_data'/.test(sql)) return { rows: [{ present: this.schemas.has('smdb_data') }] };
    if (/nspname LIKE/.test(sql)) return { rows: [...this.schemas.keys()].filter(n => n.startsWith('smdb_superseded_')).map(nspname => ({ nspname })) };
    const meta = /SELECT value FROM "?([a-z0-9_]+)"?\.meta WHERE key = 'store_id'/.exec(sql);
    if (meta) {
      const s = this.store(meta[1]);
      if (s.noMeta) throw pgError('42P01', `relation "${meta[1]}.meta" does not exist`);
      return { rows: s.storeId === null ? [] : [{ value: JSON.stringify(s.storeId) }] };
    }
    if (/AS docs/.test(sql)) {
      const s = this.store();
      return { rows: [{ docs: s.data.length, appends: s.append.length, graves: s.grave.length, owners: s.owners.length }] };
    }
    if (/^LOCK TABLE|pg_advisory_xact_lock|^SET /.test(sql)) return { rows: [] };
    const rename = /^ALTER SCHEMA smdb_data RENAME TO (\w+)/.exec(sql);
    if (rename) {
      const s = this.store();
      if (this.schemas.has(rename[1])) throw pgError('42P06', `schema "${rename[1]}" already exists`);
      this.schemas.delete('smdb_data');
      this.schemas.set(rename[1], s);
      return { rows: [] };
    }
    if (/^CREATE SCHEMA smdb_data$/.test(sql)) {
      if (this.schemas.has('smdb_data')) throw pgError('42P06', 'schema "smdb_data" already exists');
      this.schemas.set('smdb_data', emptyStore(null));
      return { rows: [] };
    }
    if (/^CREATE /.test(sql)) return { rows: [] };
    if (/INSERT INTO smdb_data\.meta/.test(sql)) {
      if (/'store_id'/.test(sql)) this.store().storeId ??= JSON.parse(params[0]);
      return { rows: [] };
    }
    if (/INSERT INTO smdb_data\.guild_data_graveyard/.test(sql)) {
      const [g, m, f, k, d, r, why] = params;
      for (let i = 0; i < g.length; i++) this.store().grave.push({ guild_id: g[i], module: m[i], filename: f[i], kind: k[i], doc: d[i], retired_at: String(r[i]), reason: why[i] });
      return { rows: [] };
    }
    if (/INSERT INTO smdb_data\.guild_data/.test(sql)) {
      const [g, m, f, d] = params;
      for (let i = 0; i < g.length; i++) {
        if (d[i].includes('\u0000')) throw pgError('22P05', 'unsupported Unicode escape sequence');
        this.store().data.push({ guild_id: g[i], module: m[i], filename: f[i], doc: d[i] });
      }
      return { rows: [] };
    }
    if (/INSERT INTO smdb_data\.guild_append/.test(sql)) {
      const [g, m, f, c] = params;
      for (let i = 0; i < g.length; i++) this.store().append.push({ guild_id: g[i], module: m[i], filename: f[i], seq: this.db.appendSeq++, chunk: c[i] });
      return { rows: [] };
    }
    if (/INSERT INTO smdb_data\.guild_ownership/.test(sql)) {
      const [g, n, sh, c, sc] = params;
      for (let i = 0; i < g.length; i++) this.store().owners.push({ guild_id: g[i], node_id: n[i], shard_id: sh[i], claim: String(c[i]), shard_count: sc[i], retired_at: null });
      return { rows: [] };
    }
    if (/FROM smdb_data\.guild_ownership WHERE retired_at IS NULL AND node_id <> \$1/.test(sql)) {
      return { rows: [{ n: this.store().owners.filter(o => o.retired_at === null && o.node_id !== params[0]).length }] };
    }
    if (/FROM smdb_data\.guild_ownership/.test(sql)) return { rows: this.store().owners.map(o => ({ ...o })) };
    if (/sha256\(convert_to\(doc, 'UTF8'\)\).*FROM smdb_data\.guild_data_graveyard/.test(sql)) {
      return { rows: this.store().grave.map(r => ({ guild_id: r.guild_id, retired_at: String(r.retired_at), module: r.module, filename: r.filename, kind: r.kind, reason: r.reason, h: sha(r.doc), bytes: Buffer.byteLength(r.doc) })) };
    }
    if (/sha256\(convert_to\(doc, 'UTF8'\)\).*FROM smdb_data\.guild_data/.test(sql)) {
      return { rows: this.store().data.map(r => ({ guild_id: r.guild_id, module: r.module, filename: r.filename, h: sha(r.doc), bytes: Buffer.byteLength(r.doc) })) };
    }
    if (/^SELECT DISTINCT guild_id FROM smdb_data\.guild_append/.test(sql)) {
      return { rows: [...new Set(this.store().append.map(r => String(r.guild_id)))].sort().map(guild_id => ({ guild_id })) };
    }
    if (/string_agg\(chunk/.test(sql)) {
      const by = new Map<string, Row[]>();
      const one = /WHERE guild_id = \$1/.test(sql);
      for (const r of this.store().append.filter(a => !one || String(a.guild_id) === params[0])) {
        const k = JSON.stringify([r.guild_id, r.module, r.filename]);
        by.set(k, [...(by.get(k) ?? []), r]);
      }
      return {
        rows: [...by].map(([k, rs]) => {
          const [guild_id, module, filename] = JSON.parse(k);
          const whole = rs.sort((a, b) => a.seq - b.seq).map(r => r.chunk).join('');
          return { guild_id, module, filename, h: sha(whole), bytes: Buffer.byteLength(whole) };
        }),
      };
    }
    if (/^SELECT guild_id FROM smdb_data\.guild_data UNION SELECT guild_id FROM smdb_data\.guild_append/.test(sql)) {
      const ids = [...new Set([...this.store().data, ...this.store().append].map(r => String(r.guild_id)))].sort();
      return { rows: ids.map(guild_id => ({ guild_id })) };
    }
    if (/FROM smdb_data\.guild_data_graveyard GROUP BY guild_id, retired_at/.test(sql)) {
      const keys = [...new Set(this.store().grave.map(r => JSON.stringify([String(r.guild_id), String(r.retired_at)])))].sort();
      return { rows: keys.map(k => { const [guild_id, retired_at] = JSON.parse(k); return { guild_id, retired_at }; }) };
    }
    if (/FROM smdb_data\.guild_data_graveyard WHERE guild_id = \$1 AND retired_at = \$2/.test(sql)) {
      return { rows: this.store().grave.filter(r => String(r.guild_id) === params[0] && String(r.retired_at) === String(params[1])).map(r => ({ ...r })) };
    }
    if (/FROM smdb_data\.guild_data WHERE guild_id = \$1/.test(sql)) {
      return { rows: this.store().data.filter(r => String(r.guild_id) === params[0]).map(r => ({ ...r })) };
    }
    if (/FROM smdb_data\.guild_append WHERE guild_id = \$1/.test(sql)) {
      return { rows: this.store().append.filter(r => String(r.guild_id) === params[0]).sort((a, b) => a.seq - b.seq).map(r => ({ ...r })) };
    }
    if (/FROM smdb_data\.guild_data_graveyard/.test(sql)) return { rows: this.store().grave.map(r => ({ ...r })) };
    if (/FROM smdb_data\.guild_data/.test(sql)) return { rows: this.store().data.map(r => ({ ...r })) };
    if (/FROM smdb_data\.guild_append/.test(sql)) {
      return { rows: [...this.store().append].sort((a, b) => a.seq - b.seq).map(r => ({ ...r })) };
    }
    throw new Error(`fakePg: no answer scripted for: ${sql}`);
  }
}
