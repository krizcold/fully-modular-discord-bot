import {
  ANSWER_READ_BACK_SQL,
  ANSWER_SQL,
  CLEANUP_SQL,
  REQUEST_CLAIM_SQL,
  REQUEST_INSERT_SQL,
  REQUEST_POLL_SQL,
  SETTLE_INSERT_SQL,
  SETTLE_UPDATE_SQL,
  UNANSWERED_BATCHES_SQL,
  UNAPPLIED_REPLY,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import type { RequestDb } from '../../src/webui/utils/guildRequests';
import type { SweepDb } from '../../src/bot/internalSetup/fleet/guildRequests';

// NB7's model store: smdb_data.guild_requests and the one claim row, each statement of decisions 6 to 8 and 16
// applied atomically by its SQL conditions on the database's own clock. A statement's fate decides whether it runs
// and answers, runs and loses its answer, waits to run later (after other statements), or never runs. The database can
// be away (every connect and statement fails, nothing runs) and can fail over: a standby promoted behind the same URL
// holds the rows as last shipped, under another server identity, and the old server's late statements die with it.

export type Fate = 'ok' | 'lost-after' | 'late' | 'lost-before' | 'wire';

export interface Row {
  state: 'pending' | 'applying' | 'done' | 'expired';
  op: string;
  forProcess: string;
  shardCount: number;
  shardId: number;
  claimBy: number;
  answerBy: number;
  batch: string | null;
  reply: string | null;
}

/**
 * Bites: the draft's started-map pass in place of the unanswered-batch statement; a settle that never holds the id; a
 * poll that reads a 'done' row as 'applying', so the sender misses an answer it could read; a settle that leaves a
 * pending row pending and returns nothing, so the sender ends its follow with no answer for a row nobody took.
 */
export interface Bites {
  startedMap?: () => Set<string>;
  settleHoldsNothing?: boolean;
  doneReadsApplying?: boolean;
  settleLeavesPending?: boolean;
  /** The round 3 statement: the unanswered batches' rows are answered unapplied, started or not. */
  leavesNoneOut?: boolean;
}

const lostError = () => new Error('Connection terminated unexpectedly');
const SENDER_SQL = new Set([REQUEST_INSERT_SQL, REQUEST_POLL_SQL, SETTLE_INSERT_SQL, SETTLE_UPDATE_SQL]);
const clone = (rows: Map<string, Row>) => new Map([...rows].map(([id, r]) => [id, { ...r }]));

export class ModelDb {
  now = 0;
  rows = new Map<string, Row>();
  claim = { shardCount: 2, shardId: 1, claim: 9, holderProcess: 'p-b', released: false };
  late: Array<{ server: number; run: () => void }> = [];
  server = 1;
  away = false;
  /** A login refused: every statement and connect answers 28000. */
  loginRefused = false;
  /** Request ids a statement of the sender did not answer for (lost, late, or the database away). */
  senderLost = new Set<string>();
  /** Request ids a claim moved to 'applying'. */
  claimed = new Set<string>();
  /** The database time each row became 'done', by an answer write or the unanswered-batch statement. */
  doneAt = new Map<string, number>();
  /** The ids of the inserts sent, in order, whatever their fate. */
  sentInserts: string[] = [];
  /** Requests whose sender process is gone: their statements no longer reach the database. */
  dead = new Set<string>();
  /** Holder processes that crashed: nothing they send reaches the database any more. */
  deadPids = new Set<string>();
  /** Each statement's text in the order sent. */
  sentSql: string[] = [];
  /** Statements on the wire: sent, not run, not answered; each ends by deliver(), cut() or its client bound. */
  wire: Array<{ server: number; sql: string; run: () => void; cut: (runIt: boolean) => void }> = [];
  private shipped = new Map<string, Row>();
  private forced: Fate[] = [];
  private forcedSql: Array<{ sql: string; fate: Fate }> = [];
  private fateAt = 0;

  constructor(private readonly fates: Fate[], private readonly bites: Bites = {}) {}

  /** The next statement's fate, ahead of the cycle. */
  force(fate: Fate): void {
    this.forced.push(fate);
  }

  /** The next statement with this text gets this fate. */
  forceSql(sql: string, fate: Fate): void {
    this.forcedSql.push({ sql, fate });
  }

  /** The oldest statement on the wire reaches the server, runs and answers. */
  deliver(): void {
    this.wire.shift()?.run();
  }

  /** The oldest statement on the wire loses its connection: run first when ran, its answer lost either way. */
  cut(ran = false): void {
    this.wire.shift()?.cut(ran);
  }

  /** The standby has every row as it is now. */
  ship(): void {
    this.shipped = clone(this.rows);
  }

  /** The row as the standby holds it. */
  shippedRow(id: string): Row | undefined {
    return this.shipped.get(id);
  }

  /** The standby is promoted behind the same URL: the rows as last shipped, another identity, no old statement runs. */
  failover(): void {
    this.rows = clone(this.shipped);
    for (const id of [...this.doneAt.keys()]) if (this.rows.get(id)?.state !== 'done') this.doneAt.delete(id);
    this.server += 1;
    this.late = this.late.filter(l => l.server === this.server);
    for (const w of this.wire.splice(0)) w.cut(false);
  }

  private nextFate(sql: string): Fate {
    const at = this.forcedSql.findIndex(f => f.sql === sql);
    if (at >= 0) return this.forcedSql.splice(at, 1)[0].fate;
    if (this.forced.length > 0) return this.forced.shift()!;
    if (this.fates.length === 0) return 'ok';
    return this.fates[this.fateAt++ % this.fates.length];
  }

  exec(sql: string, v: any[]): { rows: any[]; rowCount: number } {
    const row = (id: string) => this.rows.get(id);
    if (sql === REQUEST_INSERT_SQL) {
      if (this.rows.has(v[0])) throw Object.assign(new Error('duplicate key value violates unique constraint "guild_requests_pkey"'), { code: '23505' });
      this.rows.set(v[0], { state: 'pending', op: v[5], forProcess: v[4], shardCount: v[2], shardId: v[3], claimBy: this.now + v[8] * 1000, answerBy: this.now + v[9] * 1000, batch: null, reply: null });
      return { rows: [], rowCount: 1 };
    }
    if (sql === REQUEST_POLL_SQL) {
      const r = row(v[0]);
      const state = this.bites.doneReadsApplying && r?.state === 'done' ? 'applying' : r?.state;
      return r ? { rows: [{ state, reply: r.reply, pickup_over: this.now >= r.claimBy, answer_over: this.now >= r.answerBy + 5000 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql === SETTLE_INSERT_SQL) {
      const r = row(v[0]);
      if (!r) {
        if (!this.bites.settleHoldsNothing) this.rows.set(v[0], { state: 'expired', op: v[5], forProcess: v[4], shardCount: v[2], shardId: v[3], claimBy: this.now, answerBy: this.now, batch: null, reply: null });
        return { rows: [{ state: 'expired' }], rowCount: 1 };
      }
      if (r.state !== 'pending' || this.bites.settleLeavesPending) return { rows: [], rowCount: 0 };
      r.state = 'expired';
      return { rows: [{ state: 'expired' }], rowCount: 1 };
    }
    if (sql === SETTLE_UPDATE_SQL) {
      const r = row(v[0]);
      if (!r || r.state !== 'pending' || this.bites.settleLeavesPending) return { rows: [], rowCount: 0 };
      r.state = 'expired';
      return { rows: [{ state: 'expired' }], rowCount: 1 };
    }
    if (sql === REQUEST_CLAIM_SQL) {
      const [pid, batch, counts, shards, claims, limit] = v;
      const c = this.claim;
      const paired = counts.some((n: number, i: number) => n === c.shardCount && shards[i] === c.shardId && claims[i] === c.claim);
      if (!paired || c.holderProcess !== pid || c.released) return { rows: [], rowCount: 0 };
      const out: any[] = [];
      for (const [id, r] of this.rows) {
        if (out.length >= limit) break;
        if (r.state !== 'pending' || r.forProcess !== pid || r.claimBy <= this.now || r.shardCount !== c.shardCount || r.shardId !== c.shardId) continue;
        r.state = 'applying';
        r.batch = batch;
        this.claimed.add(id);
        out.push({ id, guild_id: String(1n << 22n), op: r.op, body: JSON.stringify({ module: 'm', filename: id, contentJson: JSON.stringify({ id }) }), requested_by: 'ALPHA', left_ms: Math.max(r.answerBy - this.now, 0) });
      }
      return { rows: out, rowCount: out.length };
    }
    if (sql === UNANSWERED_BATCHES_SQL) {
      const params = Math.max(...[...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
      if (v.length !== params) throw Object.assign(new Error(`bind message supplies ${v.length} parameters, but prepared statement "" requires ${params}`), { code: '08P01' });
      const leftOut: string[] = params >= 2 && !this.bites.leavesNoneOut ? v[1] : [];
      let n = 0;
      for (const [id, r] of this.rows) {
        if (r.batch !== null && v[0].includes(r.batch) && r.state === 'applying' && !leftOut.includes(id)) {
          r.state = 'done';
          r.reply = UNAPPLIED_REPLY;
          this.doneAt.set(id, this.now);
          n += 1;
        }
      }
      return { rows: [], rowCount: n };
    }
    if (sql === ANSWER_SQL) {
      const r = row(v[0]);
      if (!r || r.batch !== v[1] || r.state !== 'applying') return { rows: [], rowCount: 0 };
      r.state = 'done';
      r.reply = v[2];
      this.doneAt.set(v[0], this.now);
      return { rows: [], rowCount: 1 };
    }
    if (sql === ANSWER_READ_BACK_SQL) {
      const r = row(v[0]);
      return r ? { rows: [{ state: r.state, reply: r.reply }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql === CLEANUP_SQL) return { rows: [], rowCount: 0 };
    throw new Error(`the model has no statement ${sql.slice(0, 40)}`);
  }

  /** The draft's pass: every applying row of the process that its started map, as it was at the send, leaves out. */
  private startedMapPass(pid: string, started: Set<string>): () => { rows: any[]; rowCount: number } {
    return () => {
      let n = 0;
      for (const [id, r] of this.rows) {
        if (r.state === 'applying' && r.forProcess === pid && !started.has(id)) {
          r.state = 'done';
          r.reply = UNAPPLIED_REPLY;
          this.doneAt.set(id, this.now);
          n += 1;
        }
      }
      return { rows: [], rowCount: n };
    };
  }

  /** One statement under its fate; pid names the process that sends it on the holder's side. */
  run(sql: string, values: any[], pid?: string, boundMs?: number): Promise<{ rows: any[]; rowCount: number }> {
    if (sql === REQUEST_INSERT_SQL) this.sentInserts.push(values[0]);
    this.sentSql.push(sql);
    const sender = SENDER_SQL.has(sql);
    if (sender && this.dead.has(values[0])) return Promise.reject(lostError());
    if (pid && this.deadPids.has(pid)) return Promise.reject(lostError());
    if (this.loginRefused) return Promise.reject(Object.assign(new Error('role is not permitted to log in'), { code: '28000' }));
    if (this.away) {
      if (sender) this.senderLost.add(values[0]);
      return Promise.reject(lostError());
    }
    const fate = sql === CLEANUP_SQL ? 'ok' : this.nextFate(sql);
    if (sender && fate !== 'ok' && fate !== 'wire') this.senderLost.add(values[0]);
    let work = () => this.exec(sql, values);
    if (sql === UNANSWERED_BATCHES_SQL && this.bites.startedMap && pid) work = this.startedMapPass(pid, new Set(this.bites.startedMap()));
    if (fate === 'wire') {
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const entry = {
          server: this.server,
          sql,
          run: () => {
            if (timer) clearTimeout(timer);
            try { resolve(work()); } catch (error) { reject(error); }
          },
          cut: (runIt: boolean) => {
            if (timer) clearTimeout(timer);
            if (sender) this.senderLost.add(values[0]);
            if (runIt) { try { work(); } catch { /* its answer is lost */ } }
            reject(lostError());
          },
        };
        this.wire.push(entry);
        // The client's bound ends the wait; the statement stays on the wire and may still run.
        if (boundMs !== undefined) {
          timer = setTimeout(() => {
            if (sender) this.senderLost.add(values[0]);
            entry.run = () => { try { work(); } catch { /* nobody waits for it */ } };
            entry.cut = (runIt: boolean) => { if (runIt) { try { work(); } catch { /* nobody waits */ } } };
            reject(Object.assign(new Error('Query read timeout')));
          }, boundMs);
        }
      });
    }
    try {
      if (fate === 'ok') return Promise.resolve(work());
      if (fate === 'lost-after') {
        work();
        return Promise.reject(lostError());
      }
      if (fate === 'late') this.late.push({ server: this.server, run: () => { try { work(); } catch { /* a late statement's error reaches nobody */ } } });
      return Promise.reject(lostError());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  runLate(): void {
    this.late.shift()?.run();
  }

  requestDb(): RequestDb {
    return {
      connect: async () => {
        if (this.loginRefused) throw Object.assign(new Error('role is not permitted to log in'), { code: '28000' });
        if (this.away) throw new Error('connect ECONNREFUSED');
        return { server: `model-${this.server}`, query: (sql: string, values: unknown[], boundMs: number) => this.run(sql, values as any[], undefined, boundMs), release: () => undefined };
      },
      end: async () => undefined,
    };
  }

  sweepDb(pid: string): SweepDb {
    return { query: (sql: string, values: unknown[], boundMs: number) => this.run(sql, values as any[], pid, boundMs) };
  }
}
