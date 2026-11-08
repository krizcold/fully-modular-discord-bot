// WebuiDataReader - READ-ONLY database access for the webui fork parent.
// The parent has no Working Set and must never write postgres or touch
// fencing; postgres-routed guild reads in the routes go through this reader.

import { Client as PgClient, Pool } from 'pg';
import type { PoolClient, QueryConfig } from 'pg';
import { guardPoolClients } from '../../bot/internalSetup/utils/pgClient';
import { loadCredentials } from '../../utils/envLoader';
import { canonicalGuildKey } from '../../bot/internalSetup/utils/dataKeys';
import { HOLDER_CHECK_SQL } from '../../bot/internalSetup/utils/dataBackends/guildRequestSql';
import { addressListInUse, parseAddressList, pgConfig, showEntry, type ListEntry } from '../../utils/databaseAddress';
import { decideMain, mainTagOf, probePass, type NoticeRead, type ProbeAnswer, type StoreReport } from '../../bot/internalSetup/utils/dataBackends/mainDatabase';
import { MarkerUnreadable, readMarkerStoreId } from '../../bot/internalSetup/utils/dataBackends/recognitionGuard';
import { readNewestNotice } from '../../utils/ownerMessages';

const READER_ERROR = 'data backend unreachable';
const READER_MAX = 2;
const QUERY_BOUND_MS = 5000;
const OWN_CHOICE_EVERY_MS = 10_000;
/** One notice read of chooseNow(): up to four requests of 10 s on the first Discord read of the process. */
const OWN_READ_BUDGET_MS = 40_000;

export const STARTING_REFUSAL = 'the bot process is starting; try again once it has started';
export const CHOOSING_REFUSAL = 'choosing the main database';

/**
 * NB5 decision 17: the entry the web UI's pools use, with `held` while the bot process confirms it, or a refusal. `tag`
 * is the entry's main tag (NB6 C23): the report's, or the own choice's; null when the report carries none.
 */
export type WebuiResolution = { entry: string; tag: string | null; held?: { reason: string } } | { refusal: string };

/**
 * Decision 17's case: no bot process (or a maintenance boot, which reports no store) takes the web UI's own choice; a
 * bot process in a normal boot is starting until its first data:store, then its report is the answer.
 */
export type WebuiChildCase =
  | { kind: 'none' }
  | { kind: 'maintenance' }
  | { kind: 'starting' }
  | { kind: 'reported'; report: StoreReport };

let childCase: WebuiChildCase = { kind: 'none' };
let reportCount = 0;

/** A data:store message of the bot process; null when no bot process runs (child exit, a stop that gave up). */
export function setWebuiDataStoreUrl(report: StoreReport | null): void {
  reportCount += 1;
  forgetOwnChoice();
  if (report === null) {
    childCase = { kind: 'none' };
    return;
  }
  const url = typeof report.url === 'string' && report.url.trim() ? report.url.trim() : null;
  childCase = {
    kind: 'reported',
    report: {
      url,
      ...(url === null ? { choosing: true as const } : {}),
      ...(url !== null && report.held === true ? { held: true as const } : {}),
      ...(typeof report.reason === 'string' ? { reason: report.reason } : {}),
      ...(url !== null && typeof report.tag === 'string' ? { tag: report.tag } : {}),
    },
  };
}

/** A change of decision 17's case that is no data:store message: a child started, ended, or booted in maintenance. */
export function noteWebuiChild(event: 'started' | 'gone' | 'maintenance-boot'): void {
  reportCount += 1;
  forgetOwnChoice();
  childCase = event === 'started' ? { kind: 'starting' } : event === 'gone' ? { kind: 'none' } : { kind: 'maintenance' };
}

/** Rises at every change of the report or of the case, so a caller can tell whether either changed between two moments. */
export function webuiReportCount(): number {
  return reportCount;
}

export function webuiChildCase(): WebuiChildCase {
  return childCase;
}

export interface WebuiChoiceDeps {
  entries(): ListEntry[];
  probe(entries: ListEntry[]): Promise<ProbeAnswer[]>;
  readNotice(own: boolean): Promise<NoticeRead>;
  markerStoreId(): string | null;
  noticeCheckOff(): boolean;
}

const realChoiceDeps: WebuiChoiceDeps = {
  entries: () => parseAddressList(addressListInUse()),
  probe: entries => probePass(entries, { session: config => new PgClient(config) }),
  readNotice: own => (own ? readNewestNotice({ own: true, budgetMs: OWN_READ_BUDGET_MS }) : readNewestNotice()),
  markerStoreId: () => readMarkerStoreId(),
  noticeCheckOff: () => (loadCredentials().DATA_NOTICE_CHECK || '').trim().toLowerCase() === 'off',
};
let choiceDeps: WebuiChoiceDeps = realChoiceDeps;

/** Tests give a fake prober and notice read; null restores the real ones. */
export function _setWebuiChoiceDeps(over: Partial<WebuiChoiceDeps> | null): void {
  choiceDeps = over ? { ...realChoiceDeps, ...over } : realChoiceDeps;
}

/** A marker that can't be read: no choice is made on a guess at the store this machine records. */
export function unknownStoreWords(error: unknown): string {
  const why = error instanceof MarkerUnreadable ? error.why : error instanceof Error ? error.message : String(error);
  return `${why}, so the bot can't confirm which store this machine records`;
}

/** The deps of the verify pass of switch-notice, which takes the same list and prober. */
export function webuiChoiceDeps(): WebuiChoiceDeps {
  return choiceDeps;
}

let ownLast: WebuiResolution | null = null;
let ownRunning: Promise<void> | null = null;
let ownStartedAt = -Infinity;
let ownSeq = 0;

/** Decision 17: a change of case drops the own choice's result, so no read is answered from before it. */
function forgetOwnChoice(): void {
  ownLast = null;
  ownRunning = null;
  ownStartedAt = -Infinity;
  ownSeq += 1;
}

export function _resetWebuiChoice(): void {
  forgetOwnChoice();
}

/** One choice by decision 4's pass, decision 8's notice read and decideMain with the marker's store id. */
async function choose(ownRead: boolean): Promise<WebuiResolution> {
  const deps = choiceDeps;
  const answers = await deps.probe(deps.entries());
  let markerStoreId: string | null;
  try {
    markerStoreId = deps.markerStoreId();
  } catch (error) {
    return { refusal: unknownStoreWords(error) };
  }
  const options = { markerStoreId, noticeCheckOff: deps.noticeCheckOff() };
  let decision = decideMain(answers, undefined, options);
  if (decision.outcome === 'needs-notice') decision = decideMain(answers, await deps.readNotice(ownRead), options);
  if (decision.outcome === 'chosen') return { entry: decision.chosen.entry, tag: mainTagOf(decision.generation, decision.machine) };
  if (decision.outcome === 'needs-notice') return { refusal: CHOOSING_REFUSAL };
  return { refusal: decision.reason };
}

function ownChoice(): WebuiResolution {
  if (!ownRunning && Date.now() - ownStartedAt >= OWN_CHOICE_EVERY_MS) {
    ownStartedAt = Date.now();
    const seq = ownSeq;
    const run = choose(false)
      .then(answer => { if (seq === ownSeq) ownLast = answer; })
      .catch(error => { if (seq === ownSeq) ownLast = { refusal: error instanceof Error ? error.message : String(error) }; })
      .finally(() => { if (ownRunning === run) ownRunning = null; });
    ownRunning = run;
  }
  return ownLast ?? { refusal: CHOOSING_REFUSAL };
}

/** The own choice's last result as it stands, without starting one: the PUT's first check reads it. */
export function ownChoiceLast(): WebuiResolution {
  return ownLast ?? { refusal: CHOOSING_REFUSAL };
}

/** Decision 17: the database the web UI's pools use, by the case that holds at the moment of the call. No fallback. */
export function resolveWebuiDatabase(): WebuiResolution {
  const current = childCase;
  if (current.kind === 'starting') return { refusal: STARTING_REFUSAL };
  if (current.kind === 'reported') {
    const report = current.report;
    if (report.url === null) return { refusal: report.reason ?? CHOOSING_REFUSAL };
    const tag = report.tag ?? null;
    return report.held ? { entry: report.url, tag, held: { reason: report.reason ?? '' } } : { entry: report.url, tag };
  }
  return ownChoice();
}

/**
 * A choice of its own, started now whatever case holds and never joining one already running, answered with the
 * report count read when it started (decision 23's PUT). Its result becomes the own choice's last result.
 */
export async function chooseNow(): Promise<{ resolution: WebuiResolution; countAtStart: number }> {
  const countAtStart = reportCount;
  const seq = ownSeq;
  let resolution: WebuiResolution;
  try {
    resolution = await choose(true);
  } catch (error) {
    resolution = { refusal: error instanceof Error ? error.message : String(error) };
  }
  if (seq === ownSeq) {
    ownLast = resolution;
    ownStartedAt = Date.now();
  }
  return { resolution, countAtStart };
}

export const REPORT_CHANGED_REFUSAL = 'the bot process reported a change of its database during the check';

/** A write check's refusal: NB5's reason, and `held` for the bot process's held report (its confirming words). */
export type WebuiCheckRefusal = { refusal: string; held: boolean };

/** The bot process's report as every write check reads it: a refusal, or null when it lets the entry through. */
function reportCheck(entry: string | null): WebuiCheckRefusal | null {
  const current = childCase;
  if (current.kind === 'starting') return { refusal: STARTING_REFUSAL, held: false };
  if (current.kind !== 'reported') return null;
  const report = current.report;
  if (report.url === null) return { refusal: report.reason ?? CHOOSING_REFUSAL, held: false };
  if (report.held) return { refusal: report.reason ?? '', held: true };
  if (entry !== null && report.url !== entry) {
    return { refusal: `a check of the databases made now picks ${showEntry(entry)}, while the bot process uses ${showEntry(report.url)}`, held: false };
  }
  return null;
}

/** NB6 D7's first write check: the report, and the own choice with no bot process or in a maintenance boot. */
export function webuiFirstCheck(): WebuiCheckRefusal | null {
  const report = reportCheck(null);
  if (report) return report;
  const current = childCase;
  if (current.kind === 'none' || current.kind === 'maintenance') {
    const own = resolveWebuiDatabase();
    if ('refusal' in own) return { refusal: own.refusal, held: false };
  }
  return null;
}

/** D7's second write check, once chooseNow() answered: the choice, the report on the chosen entry, the report count. */
export function webuiSecondCheck(resolution: WebuiResolution, countAtStart: number): { entry: string; tag: string | null } | WebuiCheckRefusal {
  if ('refusal' in resolution) return { refusal: resolution.refusal, held: false };
  const report = reportCheck(resolution.entry);
  if (report) return report;
  if (reportCount !== countAtStart) return { refusal: REPORT_CHANGED_REFUSAL, held: false };
  const current = childCase;
  return { entry: resolution.entry, tag: current.kind === 'reported' ? current.report.tag ?? null : resolution.tag };
}

/** D7's check right before COMMIT is sent, synchronous: the report on the entry and the report count. */
export function webuiCommitCheck(entry: string, countAtStart: number): WebuiCheckRefusal | null {
  const report = reportCheck(entry);
  if (report) return report;
  if (reportCount !== countAtStart) return { refusal: REPORT_CHANGED_REFUSAL, held: false };
  return null;
}

/** The entry a web UI shared transaction opens its session on: the first check, a fresh choice, the second check. */
export async function webuiWriteTarget(): Promise<{ entry: string; tag: string | null; countAtStart: number } | WebuiCheckRefusal> {
  const first = webuiFirstCheck();
  if (first) return first;
  const { resolution, countAtStart } = await chooseNow();
  const second = webuiSecondCheck(resolution, countAtStart);
  return 'refusal' in second ? second : { ...second, countAtStart };
}

/** The reason a resolution refused, carried by the reader's `data backend unreachable` error; null for another error. */
export function unreachableReason(error: unknown): string | null {
  if (!(error instanceof Error) || !error.message.startsWith(`${READER_ERROR} (`)) return null;
  return error.message.slice(READER_ERROR.length + 2, -1);
}

/** Waits for a pooled connection at most boundMs; one handed out later goes back to the pool. */
export async function connectWithin(pool: Pool, boundMs: number, poolWords: string, max: number): Promise<PoolClient> {
  const pending = pool.connect();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const busy = pool.totalCount >= max && pool.idleCount === 0;
      const seconds = Math.round(boundMs / 100) / 10;
      reject(new Error(busy
        ? `every connection of ${poolWords} was in use for ${seconds} s`
        : `the database did not take a connection within ${seconds} s`));
    }, Math.max(0, boundMs));
  });
  try {
    return await Promise.race([pending, timeout]);
  } catch (error) {
    void pending.then(client => client.release(), () => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class WebuiDataReader {
  private pool: Pool | null = null;
  private poolUrl: string | null = null;

  private getPool(): Pool {
    const resolved = resolveWebuiDatabase();
    const url = 'entry' in resolved ? resolved.entry : null;
    if (this.pool && this.poolUrl !== url) {
      void this.pool.end().catch(() => {});
      this.pool = null;
    }
    if (url === null) throw new Error(`${READER_ERROR} (${(resolved as { refusal: string }).refusal})`);
    if (!this.pool) {
      this.poolUrl = url;
      this.pool = new Pool({
        max: READER_MAX,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
        // Two hung reads would otherwise hold both clients for good: pool.query destroys a client its timeout ended.
        query_timeout: 10000,
        keepAlive: true,
        // A data migration leaves this reader's sessions out of its count of other sessions: they only read.
        application_name: 'smdb-webui-reader',
        ...pgConfig(url),
      });
      // An idle client error would otherwise crash the parent process.
      this.pool.on('error', () => {});
      guardPoolClients(this.pool, 'the web UI reader');
    }
    return this.pool;
  }

  /**
   * One statement under its own client bound, its hand-out bounded too: an error keeps its SQLSTATE, and a client
   * whose query got no answer is destroyed.
   */
  private async boundedQuery(text: string, params: unknown[], boundMs: number): Promise<{ rows: any[]; url: string }> {
    const pool = this.getPool();
    const url = this.poolUrl!;
    const started = Date.now();
    const client = await connectWithin(pool, Math.min(QUERY_BOUND_MS, boundMs), "the web UI's reader pool", READER_MAX);
    let destroy = false;
    try {
      const left = Math.max(1, Math.min(QUERY_BOUND_MS, boundMs - (Date.now() - started)));
      const result = await client.query({ text, values: params, query_timeout: left } as QueryConfig);
      return { rows: result.rows, url };
    } catch (error) {
      destroy = typeof (error as { code?: unknown })?.code !== 'string';
      throw error;
    } finally {
      client.release(destroy ? true : undefined);
    }
  }

  /**
   * NB6: one read of the shared tables under its own client bound (10 s: the reconcile's, the journal's and C21's
   * reads); an error keeps its SQLSTATE, and a client whose query got no answer is destroyed.
   */
  async sharedSelect(text: string, values: unknown[], boundMs: number): Promise<{ rows: any[] }> {
    const pool = this.getPool();
    const started = Date.now();
    const client = await connectWithin(pool, Math.min(QUERY_BOUND_MS, boundMs), "the web UI's reader pool", READER_MAX);
    let destroy = false;
    try {
      const left = Math.max(1, boundMs - (Date.now() - started));
      const result = await client.query({ text, values, query_timeout: left } as QueryConfig);
      return { rows: result.rows };
    } catch (error) {
      destroy = typeof (error as { code?: unknown })?.code !== 'string';
      throw error;
    } finally {
      client.release(destroy ? true : undefined);
    }
  }

  /**
   * NB7 decision 4: the shard of a guild and the claim row serving it, read-only (claimStore.ts holderStateOf judges it),
   * with the database URL the pool that read it was built on.
   */
  async holderOf(guildId: string, boundMs = QUERY_BOUND_MS): Promise<{ rows: any[]; url: string }> {
    return this.boundedQuery(HOLDER_CHECK_SQL, [guildId], boundMs);
  }

  /** NB5 decision 23: the owner_channel row's value, null for no row (or no meta table yet). */
  async ownerChannelRow(boundMs = QUERY_BOUND_MS): Promise<unknown | null> {
    try {
      const { rows } = await this.boundedQuery(`SELECT value FROM smdb_data.meta WHERE key = 'owner_channel'`, [], boundMs);
      return rows.length > 0 ? rows[0].value : null;
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === '42P01' || code === '3F000') return null;
      throw error;
    }
  }

  private async query(text: string, params: any[]): Promise<any[]> {
    try {
      const result = await this.getPool().query(text, params);
      return result.rows;
    } catch (error) {
      if (isDataBackendUnreachable(error)) throw error;
      throw new Error(READER_ERROR);
    }
  }

  async listGuilds(): Promise<string[]> {
    const rows = await this.query(
      `SELECT guild_id FROM smdb_data.guild_data
       UNION
       SELECT guild_id FROM smdb_data.guild_append`,
      []
    );
    return rows.map(row => row.guild_id);
  }

  async listFiles(guildId: string, category?: string): Promise<string[]> {
    // Mirrors fileBackend.listGuildDataFiles: non-recursive, .json files only.
    const rows = category === undefined
      ? await this.query(
          `SELECT filename FROM smdb_data.guild_data
           WHERE guild_id = $1 AND module = '' AND filename NOT LIKE '%/%' AND filename LIKE '%.json'
           UNION
           SELECT filename FROM smdb_data.guild_append
           WHERE guild_id = $1 AND module = '' AND filename NOT LIKE '%/%' AND filename LIKE '%.json'`,
          [guildId]
        )
      : await this.query(
          `SELECT filename FROM smdb_data.guild_data
           WHERE guild_id = $1 AND module = $2 AND filename LIKE '%.json'
           UNION
           SELECT filename FROM smdb_data.guild_append
           WHERE guild_id = $1 AND module = $2 AND filename LIKE '%.json'`,
          [guildId, category]
        );
    return rows.map(row => row.filename);
  }

  async listModules(guildId: string): Promise<string[]> {
    const rows = await this.query(
      `SELECT module FROM smdb_data.guild_data
       WHERE guild_id = $1 AND module <> ''
       UNION
       SELECT module FROM smdb_data.guild_append
       WHERE guild_id = $1 AND module <> ''`,
      [guildId]
    );
    return rows.map(row => row.module);
  }

  async exists(guildId: string, module: string, filename: string): Promise<boolean> {
    const rows = await this.query(
      `SELECT (
         EXISTS (SELECT 1 FROM smdb_data.guild_data
                 WHERE guild_id = $1 AND module = $2 AND filename = $3)
         OR EXISTS (SELECT 1 FROM smdb_data.guild_append
                    WHERE guild_id = $1 AND module = $2 AND filename = $3)
       ) AS present`,
      [guildId, module, filename]
    );
    return rows[0]?.present === true;
  }

  async listGraveyard(): Promise<Array<{ guildId: string; retiredAt: number; reason: string; rows: number }>> {
    const rows = await this.query(
      `SELECT guild_id, retired_at, reason, COUNT(*)::int AS row_count
       FROM smdb_data.guild_data_graveyard
       GROUP BY guild_id, retired_at, reason
       ORDER BY retired_at DESC`,
      []
    );
    return rows.map(row => ({
      guildId: row.guild_id,
      retiredAt: Number(row.retired_at),
      reason: row.reason,
      rows: Number(row.row_count)
    }));
  }

  /** One guild's batches, newest first, through the primary key's prefix; an error keeps its SQLSTATE. */
  async listGuildGraveyard(guildId: string, boundMs = QUERY_BOUND_MS): Promise<Array<{ guildId: string; retiredAt: number; reason: string; rows: number }>> {
    const { rows } = await this.boundedQuery(
      `SELECT guild_id, retired_at, reason, COUNT(*)::int AS row_count
       FROM smdb_data.guild_data_graveyard
       WHERE guild_id = $1
       GROUP BY guild_id, retired_at, reason
       ORDER BY retired_at DESC`,
      [guildId],
      boundMs
    );
    return rows.map(row => ({
      guildId: row.guild_id,
      retiredAt: Number(row.retired_at),
      reason: row.reason,
      rows: Number(row.row_count)
    }));
  }

  /**
   * A guild document as the bot's own read gives it (NB7 decision 10): the guild_data row under the canonical key; a
   * key that holds only appended lines reads as absent. An error keeps its SQLSTATE.
   */
  async readDoc(guildId: string, module: string, filename: string, boundMs = QUERY_BOUND_MS): Promise<string | null> {
    const key = canonicalGuildKey(module, filename);
    const { rows } = await this.boundedQuery(
      `SELECT doc FROM smdb_data.guild_data
       WHERE guild_id = $1 AND module = $2 AND filename = $3`,
      [guildId, key.module, key.filename],
      boundMs
    );
    return rows.length > 0 ? rows[0].doc : null;
  }
}

export function isDataBackendUnreachable(error: unknown): boolean {
  return error instanceof Error && (error.message === READER_ERROR || error.message.startsWith(`${READER_ERROR} (`));
}

let instance: WebuiDataReader | null = null;

export function getWebuiDataReader(): WebuiDataReader {
  if (!instance) {
    instance = new WebuiDataReader();
  }
  return instance;
}
