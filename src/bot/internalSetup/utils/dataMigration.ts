// Offline data migration between the JSON files under /data and the Postgres store (NB3). It runs in the web UI
// process while the bot process is stopped or in its maintenance boot, copies every guild document, append file and
// graveyard entry, verifies the copy, retires a Postgres source by renaming its schema aside, and switches the marker
// and, on a bot without a manager, DATA_BACKEND in /data/.env. Nothing it moves or renames aside is deleted.

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { DATA_ROOT, dataPath } from '../../../utils/dataRoot';
import { atomicWriteFileSync } from './atomicWrite';
import { canonicalGuildKey, isCanonicalGuildKey } from './dataKeys';
import { decodeStorable, fold, keyRefusal, KeyTree, pathKeyOf } from './storableData';
import {
  MARKER_FILE, MIGRATION_FILE, STORES_FILE, readDataFacts, writeMarkerStrict,
  type BackendStateMarker, type DataFacts, type JournalAddress, type MigrationCounts, type MigrationJournal, type MigrationStage,
} from './dataBackends/recognitionGuard';
import {
  credentialsReadError, isContainerPinned, loadCredentials, readEnvFileDataBackend, resetDataBackendCache, writeEnvDataBackend,
  type DataBackendKind,
} from '../../../utils/envLoader';
import { flushAll, queuedFilePaths } from './dataBackends/fileBackend';
import { commitMayHaveLanded, isLoginRefused, provisionStoreInTransaction } from './dataBackends/postgresBackend';
import { isGuildDataPath } from './dataManager';
import { shortLivedClient } from './pgClient';
import { getNodeId } from '../fleet/nodeIdentity';

const LOCK_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 5_000;
const PROBE_BOUND_MS = 2_000;
const DRAIN_BOUND_MS = 10_000;
const INSERT_BATCH = 500;
const CLIENT_KEEPALIVE_MS = 30_000;
const COMMIT_BOUND_MS = 120_000;
const ANSWER_BOUND_MS = 120_000;
const CLOSE_BOUND_MS = 5_000;
const SECOND_LOOK_MS = 1_000;
const MAX_LOOKS = 3;
const TCP_USER_TIMEOUT_MS = 60_000;
const CONNECTION_CHECK_MS = 10_000;
export const MAX_BATCH_BYTES = 16 * 1024 * 1024;
const BIGINT_MAX = 9223372036854775807n;
const KEEPALIVES = '-c tcp_keepalives_idle=30 -c tcp_keepalives_interval=10 -c tcp_keepalives_count=3';
const WEBUI_READER_APP = 'smdb-webui-reader';
const MIGRATE_APP = 'smdb-migrate:';
const GUILD_TABLES = 'smdb_data.guild_data, smdb_data.guild_append, smdb_data.guild_data_graveyard, smdb_data.guild_ownership';
const OLD_STORE_NOT_RETIRED = 'The old store was not retired; nothing was switched';
const ENV_UNFINISHED = 'The switch is made; run the migration again to finish the env';
const LOGIN_REFUSED = "The database refused the bot's login";
const ADDRESS_LIST = 'DATA_BACKEND_URL must be one address; a list of addresses is refused until the address picker exists';

export const JOB_ID = /^[A-Za-z0-9-]{8,40}$/;

export interface RunningMigration {
  jobId: string;
  to: DataBackendKind;
}

/** What the job needs from the web UI process's BotManager. */
export interface MigrationHost {
  takeMigrationLock(job: RunningMigration): boolean;
  releaseMigrationLock(): void;
  migrationRunning(): RunningMigration | null;
  migrationBotState(): { ok: true } | { ok: false; error: string };
}

export interface PgSession {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; command?: string }>;
  end(): Promise<void>;
}

export interface ServiceOptions {
  /** Opens a job session (default: openJobSession). */
  connect?: (url: string, application: string, kind: 'job' | 'probe') => Promise<PgSession>;
  /** Called at named points of the job; a throw there is a failure at that point (tests). */
  fault?: (point: string) => void | Promise<void>;
  nodeId?: () => string;
  lockTimeoutMs?: number;
  /** How long the job waits for a COMMIT's answer (default 120 s). */
  commitBoundMs?: number;
  /** How long a ROLLBACK or the end of a session may take before its socket is destroyed (default 5 s). */
  closeBoundMs?: number;
  /** How long a job statement other than COMMIT may go without a byte in either direction before the probe (default 120 s). */
  answerBoundMs?: number;
  /** How long after a first look at the role's other sessions the second look runs (default 1 s). */
  secondLookMs?: number;
  /** How long the probe of a silent job session may take (default 2 s). */
  probeBoundMs?: number;
}

export interface MigrationAnswer {
  status: number;
  body: Record<string, any>;
}

class Refusal extends Error {}
class Interrupted extends Error {}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDeath(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { simulateDeath?: unknown }).simulateDeath === true;
}

/** A pg DatabaseError: the server's ErrorResponse, which carries a severity and a SQLSTATE. */
function isDatabaseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  return typeof severity === 'string' && typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

export function isValidJobId(id: unknown): id is string {
  return typeof id === 'string' && JOB_ID.test(id);
}

function isManaged(): boolean {
  return (process.env.BOT_MANAGER_UPDATE_TOKEN || '').trim() !== '';
}

// ============================================================================
// ADDRESSES, NAMES, THE STORE LIST AND THE JOURNAL
// ============================================================================

export function isAddressList(url: string): boolean {
  return url.includes(',') || /\s/.test(url.trim());
}

/** host lowercased, port 5432 when absent, the database name without a trailing slash; no user, password or parameters. */
export function normalizeAddress(url: string): JournalAddress {
  const parsed = new URL(url);
  return {
    host: parsed.hostname.toLowerCase(),
    port: parsed.port ? Number(parsed.port) : 5432,
    database: decodeURIComponent(parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')),
  };
}

export function sameAddress(a: JournalAddress | null | undefined, b: JournalAddress | null | undefined): boolean {
  if (!a || !b) return false;
  return a.host.toLowerCase() === b.host.toLowerCase() && Number(a.port || 5432) === Number(b.port || 5432)
    && a.database.replace(/\/+$/, '') === b.database.replace(/\/+$/, '');
}

const showAddress = (a: JournalAddress | null | undefined) => (a ? `${a.host}:${a.port}/${a.database}` : 'an unknown address');

/** `20261029T012345678Z-<jobId>`: the UTC time with ms and no colon. */
export function supersededName(jobId: string, at: Date = new Date()): string {
  return `${at.toISOString().replace(/[-:.]/g, '')}-${jobId}`;
}

export function readStoreList(): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(STORES_FILE, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw new Error(`${STORES_FILE} cannot be read: ${message(error)}`);
  }
  const parsed = JSON.parse(raw) as { storeIds?: unknown };
  if (!parsed || !Array.isArray(parsed.storeIds) || !parsed.storeIds.every(id => typeof id === 'string')) {
    throw new Error(`${STORES_FILE} does not hold a list of store ids`);
  }
  return parsed.storeIds as string[];
}

/** Adds a store id to /data/.stores.json; never removes one. */
export function addToStoreList(storeId: string): void {
  const ids = readStoreList();
  if (ids.includes(storeId)) return;
  atomicWriteFileSync(STORES_FILE, JSON.stringify({ storeIds: [...ids, storeId] }, null, 2));
}

function writeJournal(journal: MigrationJournal): void {
  atomicWriteFileSync(MIGRATION_FILE, JSON.stringify(journal, null, 2));
}

// ============================================================================
// THE STATUS READ
// ============================================================================

const STAGE_NOTE: Partial<Record<MigrationStage, string>> = {
  committing: 'The copy may have been written; a retry verifies',
  'retire-source': "can't confirm whether the old store was renamed aside",
};

function jobView(journal: MigrationJournal, state: string, stage: MigrationStage, error?: string): Record<string, unknown> {
  return {
    jobId: journal.jobId,
    state,
    to: journal.to,
    stage,
    startedAt: journal.startedAt,
    ...(journal.finishedAt !== undefined ? { finishedAt: journal.finishedAt } : {}),
    ...(journal.counts ? { counts: journal.counts } : {}),
    ...(journal.storeId ? { storeId: journal.storeId } : {}),
    ...(journal.to === 'postgres' && journal.destination ? { destination: journal.destination } : {}),
    ...(journal.envSwitched !== undefined ? { envSwitched: journal.envSwitched } : {}),
    ...(journal.leftOut?.length ? { leftOut: journal.leftOut } : {}),
    ...(journal.shadow?.length ? { shadow: journal.shadow } : {}),
    ...(journal.closedTails?.length ? { closedTails: journal.closedTails } : {}),
    ...(error ? { error } : {}),
  };
}

function markerNamesJob(marker: BackendStateMarker | null, journal: MigrationJournal): boolean {
  return !!marker && marker.live === journal.to && marker.migration === journal.jobId;
}

const doneUnnamedText = (jobId: string) => `can't confirm; migration ${jobId} says done, but /data/.backend.json does not name it`;

function markerMatches(marker: BackendStateMarker | null, journal: MigrationJournal): boolean {
  if (!marker || marker.live !== journal.to || marker.migration !== journal.jobId) return false;
  return (marker.storeId ?? null) === (journal.to === 'postgres' ? journal.storeId ?? null : null);
}

/** The state of the last migration, derived from the journal, the marker and (unmanaged) /data/.env. */
export function deriveStatus(facts: DataFacts, opts: { running: { jobId: string } | null; managed: boolean }): MigrationAnswer {
  if (!facts.ok) return { status: 200, body: { success: false, error: facts.reason } };
  const journal = facts.journal;
  if (!journal) return { status: 200, body: { success: true, job: null } };
  if (opts.running && opts.running.jobId === journal.jobId) return { status: 200, body: { success: true, job: jobView(journal, 'running', journal.stage) } };
  if (journal.result === 'done') {
    if (markerNamesJob(facts.marker, journal)) return { status: 200, body: { success: true, job: jobView(journal, 'done', journal.stage) } };
    return { status: 409, body: { success: false, error: doneUnnamedText(journal.jobId), jobId: journal.jobId, to: journal.to } };
  }
  if (markerMatches(facts.marker, journal)) {
    if (!opts.managed && readEnvFileDataBackend() !== journal.to) {
      return { status: 200, body: { success: true, job: jobView(journal, 'interrupted', 'env', ENV_UNFINISHED) } };
    }
    return { status: 200, body: { success: true, job: jobView(journal, 'done', journal.stage) } };
  }
  if (journal.result === 'failed') return { status: 200, body: { success: true, job: jobView(journal, 'failed', journal.stage, journal.error) } };
  if (journal.stage === 'checking') {
    return { status: 200, body: { success: true, job: jobView(journal, 'failed', 'checking', journal.error ?? 'The job stopped at its first checks; nothing was changed') } };
  }
  const note = STAGE_NOTE[journal.stage];
  const error = journal.stage === 'switching' || journal.stage === 'env'
    ? journal.error ?? 'The job stopped before it finished; run the migration again to finish it'
    : note ?? journal.error ?? 'The job stopped before it finished; the old store still serves';
  return { status: 200, body: { success: true, job: jobView(journal, 'interrupted', journal.stage, error) } };
}

// ============================================================================
// SNAPSHOTS: THE STORE AS ONE SET OF ITEMS
// ============================================================================

export interface SnapItem {
  guildId: string;
  grave: boolean;
  retiredAt?: number;
  module: string;
  filename: string;
  kind: 'doc' | 'append';
  bytes: Buffer;
  /** A stream whose bytes did not end in a newline: the reader added one, and every hash is taken from those bytes. */
  closedTail?: boolean;
}

/** NB13 decision 12: a stream's open tail gets one newline, so the next line appended after the copy starts its own. */
function closeTail(kind: 'doc' | 'append', bytes: Buffer): { bytes: Buffer; closedTail?: boolean } {
  if (kind !== 'append' || bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return { bytes };
  return { bytes: Buffer.concat([bytes, Buffer.from('\n')]), closedTail: true };
}

export interface SnapGrave {
  guildId: string;
  retiredAt: number;
  reason: string;
}

export interface SnapShadow {
  guildId: string;
  retiredAt?: number;
  module: string;
  filename: string;
  bytes: Buffer;
}

export interface Snapshot {
  items: SnapItem[];
  graves: SnapGrave[];
  /** Guilds with a live item: each gets one ownership row. */
  guilds: string[];
  leftOut: string[];
  shadow: SnapShadow[];
}

const itemId = (i: { kind: string; guildId: string; retiredAt?: number; grave?: boolean; module: string; filename: string }) =>
  JSON.stringify([i.kind, i.grave ? `${i.guildId}-${i.retiredAt}` : i.guildId, i.module, i.filename]);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** sha256 per document under its canonical key; shadow rows count too, so a second read sees them again. */
export function snapshotHashes(snap: Snapshot, withShadow = true): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of snap.items) out.set(itemId(item), sha256(item.bytes));
  if (withShadow) {
    for (const s of snap.shadow) out.set(itemId({ ...s, kind: 'shadow', grave: s.retiredAt !== undefined }), sha256(s.bytes));
  }
  return out;
}

export function snapshotCounts(snap: Snapshot): MigrationCounts {
  return {
    documents: snap.items.filter(i => !i.grave && i.kind === 'doc').length,
    appendFiles: snap.items.filter(i => !i.grave && i.kind === 'append').length,
    graveyardEntries: snap.graves.length,
    bytes: snap.items.reduce((sum, i) => sum + i.bytes.length, 0),
  };
}

function compareHashes(expected: Map<string, string>, actual: Map<string, string>, what: string): void {
  const differ: string[] = [];
  for (const [key, hash] of expected) if (actual.get(key) !== hash) differ.push(key);
  for (const key of actual.keys()) if (!expected.has(key)) differ.push(key);
  if (differ.length > 0) {
    const named = differ.slice(0, 5).map(k => (JSON.parse(k) as string[]).slice(1).join('/')).join(', ');
    throw new Error(`${what} differs from the source in ${differ.length} document(s): ${named}`);
  }
}

function compareGraves(expected: SnapGrave[], actual: SnapGrave[], what: string): void {
  const key = (g: SnapGrave) => `${g.guildId}-${g.retiredAt}|${g.reason}`;
  const a = expected.map(key).sort().join('\n');
  const b = actual.map(key).sort().join('\n');
  if (a !== b) throw new Error(`${what} holds other graveyard entries or reasons than the source`);
}

function decodeStrict(bytes: Buffer, where: string): string {
  const decoded = decodeStorable(bytes);
  if (decoded.ok) return decoded.text;
  if (decoded.reason.includes('U+0000')) throw new Refusal(`${where} holds U+0000, which Postgres cannot store`);
  throw new Refusal(`${where} is not valid UTF-8 text`);
}

function fitsBigint(id: string): boolean {
  return /^\d+$/.test(id) && BigInt(id) <= BIGINT_MAX;
}

// ============================================================================
// THE JSON SIDE
// ============================================================================

/** Walks one folder: calls onFile for each regular file (rel with '/'); returns how many it found. Strict. */
async function walkFolder(dir: string, rel: string, leftOut: string[], onFile: (rel: string, bytes: Buffer, full: string) => void): Promise<number> {
  let names: Buffer[];
  try {
    names = await fs.promises.readdir(dir, { encoding: 'buffer' }) as unknown as Buffer[];
  } catch (error) {
    throw new Refusal(`The folder ${dir} cannot be read: ${message(error)}`);
  }
  let found = 0;
  for (const raw of names) {
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw new Refusal(`A file name under ${dir} is not valid UTF-8`);
    }
    const full = path.join(dir, name);
    const childRel = rel ? `${rel}/${name}` : name;
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(full);
    } catch (error) {
      throw new Refusal(`${full} cannot be read: ${message(error)}`);
    }
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) {
      throw new Refusal(`${full} is neither a regular file nor a folder`);
    }
    if (st.isDirectory()) {
      const inner = await walkFolder(full, childRel, leftOut, onFile);
      if (inner === 0) leftOut.push(full);
      found += inner;
      continue;
    }
    if (name.endsWith('.tmp')) {
      leftOut.push(full);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(full);
    } catch (error) {
      throw new Refusal(`${full} cannot be read: ${message(error)}`);
    }
    onFile(childRel, bytes, full);
    found += 1;
  }
  return found;
}

function itemFrom(guildId: string, rel: string, bytes: Buffer, full: string, grave?: number): SnapItem {
  decodeStrict(bytes, full);
  let key;
  try {
    key = canonicalGuildKey('', rel);
  } catch (error) {
    throw new Refusal(`The key ${rel} of ${full} has no file form (${message(error)}); nothing was written`);
  }
  const refusal = keyRefusal(pathKeyOf(key.module, key.filename));
  if (refusal) throw new Refusal(`The key ${rel} of ${full}: ${refusal}; nothing was written`);
  const kind = key.filename.endsWith('.jsonl') ? 'append' : 'doc';
  return {
    guildId, module: key.module, filename: key.filename, kind, ...closeTail(kind, bytes),
    grave: grave !== undefined, ...(grave !== undefined ? { retiredAt: grave } : {}),
  };
}

/** One guild folder or one graveyard entry: the most the job holds in memory at a time. */
export interface SourceUnit {
  guildId: string;
  retiredAt?: number;
  /** A Postgres graveyard entry's retired_at as the text Postgres returned. */
  retiredText?: string;
  /** The folder of a JSON unit. */
  dir?: string;
}

const unitKey = (u: { guildId: string; retiredAt?: number }) => (u.retiredAt === undefined ? u.guildId : `${u.guildId}-${u.retiredAt}`);

function emptySnapshot(): Snapshot {
  return { items: [], graves: [], guilds: [], leftOut: [], shadow: [] };
}

async function readNames(dir: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(dir, { encoding: 'buffer' }) as unknown as Buffer[]).map(b => b.toString('utf8')).sort();
  } catch (error) {
    throw new Refusal(`The folder ${dir} cannot be read: ${message(error)}`);
  }
}

async function lstatStrict(full: string): Promise<fs.Stats> {
  try {
    return await fs.promises.lstat(full);
  } catch (error) {
    throw new Refusal(`${full} cannot be read: ${message(error)}`);
  }
}

const NOT_A_FOLDER = (full: string) => `${full} is a link or another entry that is not a folder, so its data cannot be copied exactly`;

/** The guild folders and graveyard entries under root, without reading them (decision 7). */
export async function listJsonUnits(root: string, leftOut: string[]): Promise<SourceUnit[]> {
  const units: SourceUnit[] = [];
  for (const name of await readNames(root)) {
    const full = path.join(root, name);
    const numeric = /^\d+$/.test(name);
    if (!numeric && name !== '_graveyard') continue;
    const st = await lstatStrict(full);
    if (numeric && st.isFile()) continue;
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Refusal(NOT_A_FOLDER(full));
    if (numeric) {
      if (fitsBigint(name)) units.push({ guildId: name, dir: full });
      else leftOut.push(full);
      continue;
    }
    for (const entry of await readNames(full)) {
      const entryPath = path.join(full, entry);
      const est = await lstatStrict(entryPath);
      if (est.isSymbolicLink() || !est.isDirectory()) throw new Refusal(NOT_A_FOLDER(entryPath));
      const match = /^(\d+)-(\d+)$/.exec(entry);
      if (!match || !fitsBigint(match[1]) || !Number.isSafeInteger(Number(match[2]))) {
        leftOut.push(entryPath);
        continue;
      }
      units.push({ guildId: match[1], retiredAt: Number(match[2]), dir: entryPath });
    }
  }
  return units;
}

/** One JSON unit read whole, as a snapshot of that unit alone. */
export async function readJsonUnit(unit: SourceUnit): Promise<Snapshot> {
  const snap = emptySnapshot();
  const dir = unit.dir!;
  if (unit.retiredAt === undefined) {
    const count = await walkFolder(dir, '', snap.leftOut, (rel, bytes, file) => snap.items.push(itemFrom(unit.guildId, rel, bytes, file)));
    if (count === 0) snap.leftOut.push(dir);
    else snap.guilds.push(unit.guildId);
    return snap;
  }
  const retiredAt = unit.retiredAt;
  let reason = '';
  const items: SnapItem[] = [];
  await walkFolder(dir, '', snap.leftOut, (rel, bytes, file) => {
    if (rel === '.graveyard.json') {
      try {
        const note = JSON.parse(bytes.toString('utf8')) as { reason?: unknown };
        if (typeof note?.reason === 'string') reason = note.reason;
      } catch { /* a note that cannot be parsed gives reason '' */ }
      return;
    }
    items.push(itemFrom(unit.guildId, rel, bytes, file, retiredAt));
  });
  if (items.length === 0) {
    snap.leftOut.push(dir);
    return snap;
  }
  snap.items.push(...items);
  snap.graves.push({ guildId: unit.guildId, retiredAt, reason });
  return snap;
}

function mergeInto(into: Snapshot, part: Snapshot): void {
  into.items.push(...part.items);
  into.graves.push(...part.graves);
  into.guilds.push(...part.guilds);
  into.leftOut.push(...part.leftOut);
  into.shadow.push(...part.shadow);
}

/** Every guild folder and graveyard entry under root, read whole; fails on anything it cannot copy exactly. */
export async function walkJsonSource(root: string): Promise<Snapshot> {
  const snap = emptySnapshot();
  for (const unit of await listJsonUnits(root, snap.leftOut)) mergeInto(snap, await readJsonUnit(unit));
  return snap;
}

async function writeSynced(file: string, bytes: Buffer | string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.promises.open(file, 'w');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFolder(dir: string): Promise<void> {
  try {
    const handle = await fs.promises.open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch { /* folders cannot be fsynced on Windows */ }
}

function stagedPath(staging: string, item: { guildId: string; grave?: boolean; retiredAt?: number; module: string; filename: string }): string {
  const base = item.grave ? path.join(staging, '_graveyard', `${item.guildId}-${item.retiredAt}`) : path.join(staging, item.guildId);
  return path.join(base, ...(item.module ? [item.module] : []), ...item.filename.split('/'));
}

/** Writes every item and graveyard note under staging, each fsynced. */
export async function stageSnapshot(snap: Snapshot, staging: string): Promise<void> {
  await fs.promises.mkdir(staging, { recursive: true });
  for (const item of snap.items) await writeSynced(stagedPath(staging, item), item.bytes);
  for (const g of snap.graves) {
    const note = JSON.stringify({ guildId: g.guildId, reason: g.reason, ts: g.retiredAt }, null, 2);
    await writeSynced(path.join(staging, '_graveyard', `${g.guildId}-${g.retiredAt}`, '.graveyard.json'), note);
  }
  await syncFolder(staging);
}

/** Moves an earlier run's staging folders into this run's superseded folder. */
export async function moveEarlierStaging(root: string, superseded: string, current?: string): Promise<string[]> {
  const moved: string[] = [];
  for (const name of await fs.promises.readdir(root)) {
    if (!name.startsWith('.migrate-') || /\.tmp$/.test(name)) continue;
    const from = path.join(root, name);
    if (current && path.resolve(from) === path.resolve(current)) continue;
    const st = await fs.promises.lstat(from).catch(() => null);
    if (!st?.isDirectory()) continue;
    const to = path.join(superseded, name);
    if (fs.existsSync(to)) throw new Refusal(`${to} exists; nothing was moved`);
    await fs.promises.mkdir(superseded, { recursive: true });
    await fs.promises.rename(from, to);
    moved.push(from);
  }
  return moved;
}

/**
 * Moves the stale guild folders and graveyard entries of root into superseded, then the staged ones into place guild
 * by guild. Every target is checked before the first move: a target that exists refuses with nothing moved.
 */
export async function placeStaged(root: string, staging: string, superseded: string, onBegin?: () => void): Promise<void> {
  const stale: Array<[string, string]> = [];
  for (const name of await fs.promises.readdir(root)) {
    const full = path.join(root, name);
    if (/^\d+$/.test(name) && (await fs.promises.lstat(full)).isDirectory()) stale.push([full, path.join(superseded, name)]);
  }
  const graveRoot = path.join(root, '_graveyard');
  if (fs.existsSync(graveRoot)) {
    for (const name of await fs.promises.readdir(graveRoot)) stale.push([path.join(graveRoot, name), path.join(superseded, '_graveyard', name)]);
  }
  const incoming: Array<[string, string]> = [];
  for (const name of await fs.promises.readdir(staging)) {
    if (name === '_graveyard') continue;
    incoming.push([path.join(staging, name), path.join(root, name)]);
  }
  const stagedGraves = path.join(staging, '_graveyard');
  if (fs.existsSync(stagedGraves)) {
    for (const name of await fs.promises.readdir(stagedGraves)) incoming.push([path.join(stagedGraves, name), path.join(graveRoot, name)]);
  }
  for (const [, to] of stale) if (fs.existsSync(to)) throw new Refusal(`${to} exists; nothing was moved`);
  const staleSources = new Set(stale.map(([from]) => path.resolve(from)));
  for (const [, to] of incoming) {
    if (fs.existsSync(to) && !staleSources.has(path.resolve(to))) throw new Refusal(`${to} exists; nothing was moved`);
  }
  onBegin?.();
  for (const [from, to] of stale) {
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    await fs.promises.rename(from, to);
  }
  if (incoming.some(([, to]) => to.startsWith(graveRoot + path.sep))) await fs.promises.mkdir(graveRoot, { recursive: true });
  for (const [from, to] of incoming) await fs.promises.rename(from, to);
  await syncFolder(root);
  await fs.promises.rm(staging, { recursive: true, force: true });
}

/** Lands the web UI process's queued guild writes; answers the guild paths still queued when the bound passes. */
export async function drainGuildWrites(boundMs = DRAIN_BOUND_MS): Promise<string[]> {
  const deadline = Date.now() + boundMs;
  for (;;) {
    await flushAll();
    const stuck = queuedFilePaths().filter(isGuildDataPath);
    if (stuck.length === 0) return [];
    if (Date.now() >= deadline) return stuck;
    await new Promise(resolve => { setTimeout(resolve, 100); });
  }
}

function bundleImportsPresent(): string[] {
  try {
    return fs.readdirSync(DATA_ROOT).filter(name => name.startsWith('.bundle-import-')).map(name => path.join(DATA_ROOT, name));
  } catch {
    return [];
  }
}

// ============================================================================
// THE POSTGRES SIDE
// ============================================================================

/** A session of the job: its application_name and the server-side keepalives in the startup packet, no statement timeout. */
export async function openJobSession(url: string, application: string, kind: 'job' | 'probe', lockTimeoutMs = LOCK_TIMEOUT_MS): Promise<PgSession> {
  const probe = kind === 'probe';
  const timeouts = probe
    ? `-c statement_timeout=${PROBE_BOUND_MS} -c idle_in_transaction_session_timeout=${PROBE_BOUND_MS} -c lock_timeout=${PROBE_BOUND_MS}`
    : `-c statement_timeout=0 -c idle_in_transaction_session_timeout=0 -c lock_timeout=${lockTimeoutMs}`;
  const client = shortLivedClient({
    connectionString: url,
    application_name: application,
    options: `${KEEPALIVES} ${timeouts}`,
    connectionTimeoutMillis: probe ? PROBE_BOUND_MS : CONNECT_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: CLIENT_KEEPALIVE_MS,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return client as unknown as PgSession;
}

async function readMetaStoreId(session: PgSession, schema: string): Promise<string | null> {
  const res = await session.query(`SELECT value FROM "${schema}".meta WHERE key = 'store_id'`);
  if (res.rows.length === 0) return null;
  const parsed: unknown = JSON.parse(res.rows[0].value);
  return typeof parsed === 'string' ? parsed : null;
}

/** Waits at most boundMs for work; undefined when the bound passed first. */
async function within<T>(work: Promise<T>, boundMs: number): Promise<{ value: T } | undefined> {
  work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then(value => ({ value })),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), boundMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Destroys a session's socket, so the server ends the session and releases its locks. */
function destroySession(session: PgSession): void {
  try {
    (session as { connection?: { stream?: { destroy?: () => void } } }).connection?.stream?.destroy?.();
  } catch { /* already gone */ }
}

function statementKind(sql: string): string {
  const words = sql.trim().split(/\s+/).map(w => w.toUpperCase());
  return ['LOCK', 'ALTER', 'CREATE'].includes(words[0]) && words[1] ? `${words[0]} ${words[1]}` : words[0] || 'statement';
}

/** A backend's start in microseconds as text: with the pid it names one backend, since a pid is reused. */
const BACKEND_START = '(extract(epoch from backend_start) * 1000000)::bigint::text';

export interface JobBackend {
  pid: number | null;
  started: string | null;
}

/** The SQLSTATEs with which a server refuses a setting itself; any other error, of any severity, ends the job. */
const REFUSED_SETTING = new Set(['22023', '42704', '0A000', '55P02', '42501']);

/** A setting the server refuses (a platform without it answers 22023) is skipped; the session goes on without it. */
async function bestEffortSet(session: PgSession, sql: string): Promise<void> {
  try {
    await session.query(sql);
  } catch (error) {
    if (!isDatabaseError(error) || !REFUSED_SETTING.has((error as { code: string }).code)) throw error;
    console.warn(`[Migration] The database refused "${sql}"; the migration goes on without it: ${message(error)}`);
  }
}

/**
 * The server settings of a job session, set after the connect since an unknown setting in the startup packet fails
 * the connection on an older server. Answers the server version (server_version_num) and the session's backend.
 */
export async function jobSessionSettings(session: PgSession): Promise<{ version: number } & JobBackend> {
  const row = (await session.query(
    `SELECT current_setting('server_version_num')::int AS version, pg_backend_pid() AS pid, (SELECT ${BACKEND_START} FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS started`,
  )).rows[0] ?? {};
  const version = Number(row.version);
  const pid = Number(row.pid);
  const known = Number.isSafeInteger(version) ? version : 0;
  if (known >= 120000) await bestEffortSet(session, `SET tcp_user_timeout = ${TCP_USER_TIMEOUT_MS}`);
  if (known >= 140000) await bestEffortSet(session, `SET client_connection_check_interval = ${CONNECTION_CHECK_MS}`);
  return {
    version: known,
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    started: typeof row.started === 'string' && row.started !== '' ? row.started : null,
  };
}

/**
 * Asks the database on a probe session whether the backend with this pid and start runs a statement and does not
 * wait on the client. False when the probe cannot reach the database within boundMs, or the backend is gone (another
 * start under the same pid is another backend), idle or waits on the client.
 */
export async function probeBackend(open: () => Promise<PgSession>, backend: JobBackend, boundMs: number): Promise<boolean> {
  const { pid, started } = backend;
  if (pid === null || started === null) return false;
  let settled = false;
  let probe: PgSession | null = null;
  const work = (async () => {
    const opening = open();
    opening.then(s => { if (settled) void s.end().catch(() => undefined); }, () => undefined);
    probe = await opening;
    if (settled) return false;
    const res = await probe.query(`SELECT state, wait_event_type FROM pg_stat_activity WHERE pid = $1 AND ${BACKEND_START} = $2`, [pid, started]);
    const row = res.rows[0];
    return !!row && row.state === 'active' && row.wait_event_type !== 'Client';
  })();
  try {
    const answered = await within(work, boundMs).catch(() => undefined);
    return answered?.value === true;
  } finally {
    settled = true;
    const s = probe as PgSession | null;
    if (s) void s.end().catch(() => undefined);
  }
}

type WatchedStream = {
  on?: (event: string, fn: () => void) => void;
  bytesWritten?: number;
  writableLength?: number;
};

/**
 * The bytes a statement sends: its text and its parameters as pg writes them (pg/lib/utils.js). A string parameter
 * is its UTF-8 length and a Buffer its length. An array is an array literal: 2 for its braces and one comma between
 * each pair of elements; each string element its UTF-8 length plus 2 (quotes) plus one per `"` or `\`; each Buffer
 * element `\\x` and hex, 2 x its length plus 3; each null 4; each nested array its own count. Counted without
 * building a copy.
 */
export function statementBytes(text: string, params?: unknown[]): number {
  const asText = (v: unknown): string => (typeof v === 'object' ? JSON.stringify(v) ?? '' : String(v));
  const escapes = (s: string): number => {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 34 || c === 92) n += 1;
    }
    return n;
  };
  const element = (v: unknown): number => {
    if (v === null || v === undefined) return 4;
    if (Array.isArray(v)) return array(v);
    if (Buffer.isBuffer(v)) return 2 * v.length + 3;
    const s = asText(v);
    return Buffer.byteLength(s) + 2 + escapes(s);
  };
  const array = (v: unknown[]): number => {
    let n = 2 + Math.max(0, v.length - 1);
    for (const x of v) n += element(x);
    return n;
  };
  let bytes = Buffer.byteLength(text);
  for (const p of params ?? []) {
    if (p === null || p === undefined) continue;
    if (Array.isArray(p)) bytes += array(p);
    else if (Buffer.isBuffer(p)) bytes += p.length;
    else bytes += Buffer.byteLength(asText(p));
  }
  return bytes;
}

/**
 * No keepalive probe goes out while sent bytes are unacknowledged, so a statement to a vanished host is ended here.
 * Bytes received, and bytes handed to the kernel, are progress. A statement's bound is boundMs plus 1 s per MB it
 * sends, since the kernel takes a large write as one piece. When the statements in flight have made no progress for
 * the bound, `busy` asks the database whether the backend still works on them; only a session that is not busy is
 * destroyed.
 */
export function watchSession(session: PgSession, boundMs: number, busy?: () => Promise<boolean>): PgSession {
  const inFlight = new Set<{ kind: string; bound: number; reject: (error: Error) => void }>();
  const limit = () => Math.max(boundMs, ...[...inFlight].map(s => s.bound));
  const stream = (session as { connection?: { stream?: WatchedStream } }).connection?.stream;
  const sent = () => Number(stream?.bytesWritten ?? 0) - Number(stream?.writableLength ?? 0);
  let lastByte = Date.now();
  let sentMark = sent();
  let timer: NodeJS.Timeout | null = null;
  let probing = false;
  const arm = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, Math.max(1, delay));
    timer.unref?.();
  };
  const progressed = () => {
    const now = sent();
    if (now > sentMark) {
      sentMark = now;
      lastByte = Date.now();
    }
  };
  const expire = () => {
    destroySession(session);
    const seconds = limit() / 1000;
    for (const s of [...inFlight]) s.reject(new Error(`The ${s.kind} got no answer from the database within ${seconds} s`));
    inFlight.clear();
  };
  const check = () => {
    timer = null;
    if (inFlight.size === 0 || probing) return;
    progressed();
    const idle = Date.now() - lastByte;
    if (idle < limit()) {
      arm(limit() - idle);
      return;
    }
    if (!busy) {
      expire();
      return;
    }
    probing = true;
    void busy().catch(() => false).then(isBusy => {
      probing = false;
      if (inFlight.size === 0) return;
      progressed();
      if (isBusy) lastByte = Date.now();
      const quiet = Date.now() - lastByte;
      if (quiet < limit()) arm(limit() - quiet);
      else expire();
    });
  };
  stream?.on?.('data', () => { lastByte = Date.now(); });
  const watched = {
    query(text: string, params?: unknown[]): Promise<{ rows: any[]; command?: string }> {
      const work = session.query(text, params);
      if (/^\s*COMMIT\s*$/i.test(text)) return work;
      const bound = boundMs + Math.floor(statementBytes(text, params) * 1000 / (1024 * 1024));
      let entry!: { kind: string; bound: number; reject: (error: Error) => void };
      const expired = new Promise<never>((_, reject) => { entry = { kind: statementKind(text), bound, reject }; });
      const first = inFlight.size === 0;
      inFlight.add(entry);
      if (first) {
        lastByte = Date.now();
        arm(bound);
      }
      const settle = () => {
        inFlight.delete(entry);
        lastByte = Date.now();
        if (inFlight.size === 0 && timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
      work.then(settle, settle);
      return Promise.race([work, expired]);
    },
    end: () => session.end(),
  };
  Object.defineProperty(watched, 'connection', { get: () => (session as { connection?: unknown }).connection });
  return watched;
}

/** Ends a session, destroying its socket when the end takes longer than the bound. */
export async function closeSession(session: PgSession, boundMs = CLOSE_BOUND_MS): Promise<void> {
  const ended = await within(session.end(), boundMs).catch(() => ({ value: undefined }));
  if (!ended) destroySession(session);
}

/** The other sessions of the role; the statistics snapshot is cleared first, so a read inside a transaction sees the sessions of now. */
async function candidateSessions(session: PgSession, jobId: string): Promise<Array<{ pid: number; started: string; app: string }>> {
  await session.query('SELECT pg_stat_clear_snapshot()');
  const res = await session.query(
    `SELECT pid, ${BACKEND_START} AS started, coalesce(application_name, '') AS app FROM pg_stat_activity WHERE usename = current_user AND backend_type = 'client backend' AND pid <> pg_backend_pid() AND coalesce(application_name, '') <> ALL($1::text[])`,
    [[`smdb-migrate:${jobId}`, WEBUI_READER_APP]]);
  return res.rows.map(r => ({ pid: Number(r.pid), started: String(r.started ?? ''), app: String(r.app ?? '') }));
}

/**
 * The other sessions of the role by application_name, counting only a backend (pid and backend_start) present at the
 * last two of up to MAX_LOOKS looks, secondLookMs apart, so a login that comes and goes (pg_isready) does not count.
 * A look that finds a backend the look before it did not is followed by another look.
 */
async function otherSessions(session: PgSession, jobId: string, secondLookMs: number): Promise<Array<{ app: string; n: number }>> {
  const key = (c: { pid: number; started: string }) => `${c.pid}/${c.started}`;
  let last = await candidateSessions(session, jobId);
  if (last.length === 0) return [];
  let seen = new Set<string>();
  for (let look = 2; look <= MAX_LOOKS; look++) {
    await new Promise(resolve => { setTimeout(resolve, secondLookMs); });
    seen = new Set(last.map(key));
    last = await candidateSessions(session, jobId);
    if (last.every(c => seen.has(key(c)))) break;
  }
  const by = new Map<string, number>();
  for (const c of last) {
    if (seen.has(key(c))) by.set(c.app, (by.get(c.app) ?? 0) + 1);
  }
  return [...by].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([app, n]) => ({ app, n }));
}

/** Who holds the sessions S2 and later name: this bot's last job before this one; and the wait before the second look. */
interface SessionContext {
  lastJobId: string | null;
  secondLookMs: number;
}

async function refuseOtherSessions(session: PgSession, jobId: string, known: SessionContext): Promise<void> {
  const groups = await otherSessions(session, jobId, known.secondLookMs);
  const jobs = groups.filter(g => g.app.startsWith(MIGRATE_APP));
  const bots = groups.filter(g => !g.app.startsWith(MIGRATE_APP));
  const parts: string[] = [];
  const n = bots.reduce((sum, g) => sum + g.n, 0);
  if (n > 0) {
    const named = bots.map(g => `${g.app === '' ? 'unnamed' : g.app}: ${g.n}`).join(', ');
    parts.push(`${n} other session(s) of the bot's database role are connected (${named}); stop every bot on this database first`);
  }
  for (const g of jobs) parts.push(sessionOpenText(g.app.slice(MIGRATE_APP.length), known.lastJobId));
  if (parts.length > 0) throw new Refusal(parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('. '));
}

/**
 * NB4 decision 25: the claims of a bot process that may still save into the store, an unreleased row whose holder's
 * node row names that process and was seen within its takeover delay. A store with no claims tables has none.
 */
async function liveShardClaims(session: PgSession): Promise<Array<{ shardId: number; name: string; seenAgoS: number; takeoverSeconds: number }>> {
  const tables = (await session.query(`SELECT to_regclass('smdb_data.shard_claims') IS NOT NULL AND to_regclass('smdb_data.shard_nodes') IS NOT NULL AS present`)).rows[0];
  if (tables?.present !== true) return [];
  const rows = (await session.query(`
    SELECT c.shard_id, n.node_name, n.takeover_seconds,
           floor(extract(epoch FROM (now() - n.seen_at)))::int AS seen_ago_s
      FROM smdb_data.shard_claims c
      JOIN smdb_data.shard_nodes n ON n.node_id = c.holder_node AND n.process_id = c.holder_process
     WHERE NOT c.released AND n.seen_at > now() - make_interval(secs => n.takeover_seconds)
     ORDER BY c.shard_count, c.shard_id`)).rows;
  return rows.map((r: any) => ({ shardId: Number(r.shard_id), name: String(r.node_name), seenAgoS: Number(r.seen_ago_s), takeoverSeconds: Number(r.takeover_seconds) }));
}

function sessionOpenText(jobId: string, lastJobId: string | null): string {
  if (jobId !== lastJobId) {
    return `migration ${jobId}, which is not this bot's last one, holds a session on this database; run this migration once it no longer shows`;
  }
  return `migration ${jobId}'s database session is still open; the database ends it once it notices the connection is gone; run the migration again once it no longer shows`;
}

async function schemaPresent(session: PgSession): Promise<boolean> {
  const res = await session.query(`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'smdb_data') AS present`);
  return res.rows[0]?.present === true;
}

/** The rows of a Postgres source as one snapshot, keys made canonical (decision 8). */
export function snapshotFromPgRows(dataRows: any[], appendRows: any[], graveRows: any[]): Snapshot {
  const snap: Snapshot = { items: [], graves: [], guilds: [], leftOut: [], shadow: [] };
  type Row = { module: string; filename: string; kind: 'doc' | 'append'; text: string };
  const scopes = new Map<string, { guildId: string; retiredAt?: number; reason?: string; rows: Row[] }>();
  const scopeOf = (guildId: string, retiredAt?: number, reason?: string) => {
    if (!fitsBigint(String(guildId))) throw new Refusal(`The database holds rows of "${guildId}", which is not a guild id; nothing was written`);
    const id = retiredAt === undefined ? guildId : `${guildId}-${retiredAt}`;
    let s = scopes.get(id);
    if (!s) {
      s = { guildId, ...(retiredAt !== undefined ? { retiredAt, reason: reason ?? '' } : {}), rows: [] };
      scopes.set(id, s);
    }
    return s;
  };
  for (const r of dataRows) scopeOf(String(r.guild_id)).rows.push({ module: r.module, filename: r.filename, kind: 'doc', text: r.doc });
  const streams = new Map<string, Row>();
  for (const r of appendRows) {
    const k = JSON.stringify([r.guild_id, r.module, r.filename]);
    const existing = streams.get(k);
    if (existing) existing.text += r.chunk;
    else {
      const row: Row = { module: r.module, filename: r.filename, kind: 'append', text: r.chunk };
      streams.set(k, row);
      scopeOf(String(r.guild_id)).rows.push(row);
    }
  }
  for (const r of graveRows) {
    const retiredAt = Number(r.retired_at);
    scopeOf(String(r.guild_id), retiredAt, r.reason).rows.push({ module: r.module, filename: r.filename, kind: r.kind === 'append' ? 'append' : 'doc', text: r.doc });
  }

  for (const scope of scopes.values()) {
    const where = scope.retiredAt === undefined ? `guild ${scope.guildId}` : `graveyard entry ${scope.guildId}-${scope.retiredAt}`;
    const byKey = new Map<string, Row[]>();
    for (const row of scope.rows) {
      let key;
      try {
        key = canonicalGuildKey(row.module, row.filename);
      } catch (error) {
        throw new Refusal(`The key ${row.module}/${row.filename} of ${where} has no file form (${message(error)}); nothing was written`);
      }
      if (scope.retiredAt !== undefined && key.module === '' && key.filename === '.graveyard.json') {
        throw new Refusal(`A document named .graveyard.json at the root of ${where} would take the place of its note; nothing was written`);
      }
      const last = key.filename.split('/').pop() ?? '';
      if (last.endsWith('.tmp')) throw new Refusal(`The key ${key.module}/${key.filename} of ${where} ends in .tmp; nothing was written`);
      if (row.kind === 'append' && !key.filename.endsWith('.jsonl')) throw new Refusal(`The stream ${key.module}/${key.filename} of ${where} does not end in .jsonl; nothing was written`);
      if (row.kind === 'doc' && key.filename.endsWith('.jsonl')) throw new Refusal(`The document ${key.module}/${key.filename} of ${where} ends in .jsonl, which marks a stream; nothing was written`);
      const id = `${key.module}/${key.filename}`;
      byKey.set(id, [...(byKey.get(id) ?? []), row]);
    }
    const paths: string[] = [];
    for (const [id, rows] of byKey) {
      const kinds = new Set(rows.map(r => r.kind));
      if (kinds.size > 1) throw new Refusal(`The key ${id} of ${where} is both a document and a stream; nothing was written`);
      const canonical = rows.filter(r => isCanonicalGuildKey(r.module, r.filename));
      if (canonical.length !== 1 && rows.length > 1) {
        throw new Refusal(`The keys ${rows.map(r => `('${r.module}', '${r.filename}')`).join(', ')} of ${where} all name ${id}; nothing was written`);
      }
      const winner = canonical[0] ?? rows[0];
      const key = canonicalGuildKey(winner.module, winner.filename);
      paths.push(key.module ? `${key.module}/${key.filename}` : key.filename);
      snap.items.push({
        guildId: scope.guildId, module: key.module, filename: key.filename, kind: winner.kind, ...closeTail(winner.kind, Buffer.from(winner.text, 'utf8')),
        grave: scope.retiredAt !== undefined, ...(scope.retiredAt !== undefined ? { retiredAt: scope.retiredAt } : {}),
      });
      for (const other of rows) {
        if (other === winner) continue;
        snap.shadow.push({ guildId: scope.guildId, ...(scope.retiredAt !== undefined ? { retiredAt: scope.retiredAt } : {}), module: other.module, filename: other.filename, bytes: Buffer.from(other.text, 'utf8') });
      }
    }
    const exact = new Set(paths);
    const folded = new Map(paths.map(p => [fold(p), p]));
    if (scope.retiredAt !== undefined) {
      for (const p of paths) {
        if (fold(p.split('/')[0]) === '.graveyard.json') {
          throw new Refusal(`The key ${p} of ${where} would take the place of its note; nothing was written`);
        }
      }
    }
    for (const p of paths) {
      const refusal = keyRefusal(p);
      if (refusal) throw new Refusal(`The key ${p} of ${where}: ${refusal}; nothing was written`);
    }
    for (const p of paths) {
      const segments = p.split('/');
      for (let i = 1; i < segments.length; i++) {
        const prefix = segments.slice(0, i).join('/');
        if (exact.has(prefix)) throw new Refusal(`${prefix} of ${where} is both a file and a folder; nothing was written`);
        const file = folded.get(fold(prefix));
        if (file !== undefined) throw new Refusal(`The file ${file} and the folder of ${p} of ${where} differ only in letter case; nothing was written`);
      }
    }
    const lower = new Map<string, string>();
    for (const p of paths) {
      const seen = lower.get(fold(p));
      if (seen && seen !== p) throw new Refusal(`The keys ${seen} and ${p} of ${where} differ only in letter case; nothing was written`);
      lower.set(fold(p), p);
    }
    const tree = new KeyTree();
    for (const p of paths) {
      const collision = tree.add(p);
      if (!collision) continue;
      const depth = collision.entry.split('/').length;
      const mine = p.split('/').slice(0, depth).join('/');
      throw new Refusal(`The folders ${collision.entry} and ${mine} of ${where} differ only in letter case; nothing was written`);
    }
    if (scope.retiredAt !== undefined) snap.graves.push({ guildId: scope.guildId, retiredAt: scope.retiredAt, reason: scope.reason ?? '' });
    else if (scope.rows.length > 0) snap.guilds.push(scope.guildId);
  }
  return snap;
}

/** The guilds and graveyard entries of a Postgres source: keys only. An entry whose retired_at no folder name can carry exactly goes to leftOut. */
export async function listPgUnits(session: PgSession, leftOut: string[]): Promise<SourceUnit[]> {
  const live = await session.query('SELECT guild_id FROM smdb_data.guild_data UNION SELECT guild_id FROM smdb_data.guild_append ORDER BY 1');
  const grave = await session.query('SELECT guild_id, retired_at::text AS retired_at FROM smdb_data.guild_data_graveyard GROUP BY guild_id, retired_at ORDER BY 1, 2');
  const units: SourceUnit[] = live.rows.map(r => ({ guildId: String(r.guild_id) }));
  for (const r of grave.rows) {
    const guildId = String(r.guild_id);
    const text = String(r.retired_at);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
      leftOut.push(`graveyard entry ${guildId}-${text} in the database (its retired_at cannot name a folder exactly)`);
      continue;
    }
    units.push({ guildId, retiredAt: Number(text), retiredText: text });
  }
  return units;
}

/** One guild or graveyard entry of a Postgres source, keys made canonical (decision 8). */
export async function readPgUnit(session: PgSession, unit: SourceUnit): Promise<Snapshot> {
  if (unit.retiredAt !== undefined) {
    const text = unit.retiredText ?? String(unit.retiredAt);
    const grave = await session.query(
      'SELECT guild_id, module, filename, kind, doc, retired_at, reason FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 AND retired_at = $2',
      [unit.guildId, text]);
    if (grave.rows.length === 0) throw new Refusal(`The database lists graveyard entry ${unit.guildId}-${text}, but its read found no rows`);
    return snapshotFromPgRows([], [], grave.rows);
  }
  const data = await session.query('SELECT guild_id, module, filename, doc FROM smdb_data.guild_data WHERE guild_id = $1', [unit.guildId]);
  const append = await session.query('SELECT guild_id, module, filename, chunk FROM smdb_data.guild_append WHERE guild_id = $1 ORDER BY module, filename, seq', [unit.guildId]);
  if (data.rows.length + append.rows.length === 0) throw new Refusal(`The database lists guild ${unit.guildId}, but its read found no rows`);
  return snapshotFromPgRows(data.rows, append.rows, []);
}

/** A source read unit by unit: lists the units, then hands each one's snapshot to onUnit before reading the next. */
type UnitReader = (onUnit: (part: Snapshot, unit: SourceUnit) => Promise<void>) => Promise<string[]>;

function jsonReader(root: string): UnitReader {
  return async onUnit => {
    const leftOut: string[] = [];
    for (const unit of await listJsonUnits(root, leftOut)) {
      const part = await readJsonUnit(unit);
      leftOut.push(...part.leftOut);
      await onUnit(part, unit);
    }
    return leftOut;
  };
}

function pgReader(session: PgSession): UnitReader {
  return async onUnit => {
    const leftOut: string[] = [];
    for (const unit of await listPgUnits(session, leftOut)) await onUnit(await readPgUnit(session, unit), unit);
    return leftOut;
  };
}

/** What the job keeps across units: keys, hashes and counts, never bytes. */
interface Tally {
  /** Every copied item's hash. */
  copied: Map<string, string>;
  /** The copied items' and the shadow rows' hashes. */
  all: Map<string, string>;
  counts: MigrationCounts;
  graves: SnapGrave[];
  guilds: string[];
  leftOut: string[];
  shadowNotes: string[];
  shadowUnits: SourceUnit[];
  /** Each stream copied with a newline added: "<module>/<filename> of <guild or graveyard entry>". */
  closedTails: string[];
}

async function tallySource(read: UnitReader): Promise<Tally> {
  const t: Tally = {
    copied: new Map(), all: new Map(), counts: { documents: 0, appendFiles: 0, graveyardEntries: 0, bytes: 0 },
    graves: [], guilds: [], leftOut: [], shadowNotes: [], shadowUnits: [], closedTails: [],
  };
  t.leftOut = await read(async (part, unit) => {
    for (const [k, h] of snapshotHashes(part, false)) t.copied.set(k, h);
    for (const [k, h] of snapshotHashes(part, true)) t.all.set(k, h);
    const c = snapshotCounts(part);
    t.counts.documents += c.documents;
    t.counts.appendFiles += c.appendFiles;
    t.counts.graveyardEntries += c.graveyardEntries;
    t.counts.bytes += c.bytes;
    t.graves.push(...part.graves);
    t.guilds.push(...part.guilds);
    for (const item of part.items) {
      if (!item.closedTail) continue;
      t.closedTails.push(`${item.module ? `${item.module}/` : ''}${item.filename} of ${item.grave ? `graveyard entry ${item.guildId}-${item.retiredAt}` : `guild ${item.guildId}`}`);
    }
    if (part.shadow.length > 0) {
      t.shadowUnits.push(unit);
      for (const s of part.shadow) t.shadowNotes.push(`${s.guildId}${s.retiredAt !== undefined ? `-${s.retiredAt}` : ''}: ('${s.module}', '${s.filename}')`);
    }
  });
  return t;
}

/** Inserts the rows in batches of at most 500 rows and 16 MB of values; a row larger than 16 MB goes alone. */
export async function insertRows(session: PgSession, sql: string, columns: unknown[][], maxBytes = MAX_BATCH_BYTES): Promise<void> {
  const total = columns[0]?.length ?? 0;
  const rowBytes = (i: number) => columns.reduce((sum, c) => sum + Buffer.byteLength(String(c[i] ?? '')), 0);
  let start = 0;
  while (start < total) {
    let end = start;
    let bytes = 0;
    while (end < total && end - start < INSERT_BATCH) {
      const size = rowBytes(end);
      if (end > start && bytes + size > maxBytes) break;
      bytes += size;
      end += 1;
    }
    await session.query(sql, columns.map(c => c.slice(start, end)));
    start = end;
  }
}

function shardOf(guildId: string, shardCount: number): number {
  return Number((BigInt(guildId) >> 22n) % BigInt(Math.max(1, shardCount)));
}

/** The rows of one unit's snapshot, inserted into the destination's transaction. */
async function writePgItems(session: PgSession, snap: Snapshot): Promise<void> {
  const live = snap.items.filter(i => !i.grave);
  const docs = live.filter(i => i.kind === 'doc');
  const streams = live.filter(i => i.kind === 'append');
  const graves = snap.items.filter(i => i.grave);
  const text = (i: SnapItem) => i.bytes.toString('utf8');
  await insertRows(session, 'INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])',
    [docs.map(i => i.guildId), docs.map(i => i.module), docs.map(i => i.filename), docs.map(text)]);
  await insertRows(session, 'INSERT INTO smdb_data.guild_append (guild_id, module, filename, chunk) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])',
    [streams.map(i => i.guildId), streams.map(i => i.module), streams.map(i => i.filename), streams.map(text)]);
  const reasonOf = new Map(snap.graves.map(g => [`${g.guildId}-${g.retiredAt}`, g.reason]));
  await insertRows(session,
    'INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::text[])',
    [graves.map(i => i.guildId), graves.map(i => i.module), graves.map(i => i.filename), graves.map(i => i.kind), graves.map(text),
      graves.map(i => String(i.retiredAt)), graves.map(i => reasonOf.get(`${i.guildId}-${i.retiredAt}`) ?? '')]);
}

async function writePgOwners(session: PgSession, guilds: string[], nodeId: string, shardCount: number): Promise<void> {
  await insertRows(session,
    'INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count) SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::bigint[], $5::int[])',
    [guilds, guilds.map(() => nodeId), guilds.map(g => shardOf(g, shardCount)), guilds.map(() => '0'), guilds.map(() => shardCount)]);
}

/** The destination read back in SQL: sha256 per row, the graveyard reasons and the ownership rows. */
async function readBackPg(session: PgSession): Promise<{ hashes: Map<string, string>; graves: SnapGrave[]; owners: string[] }> {
  const hashes = new Map<string, string>();
  const docs = await session.query(`SELECT guild_id, module, filename, encode(sha256(convert_to(doc, 'UTF8')), 'hex') AS h FROM smdb_data.guild_data`);
  for (const r of docs.rows) hashes.set(itemId({ kind: 'doc', guildId: r.guild_id, module: r.module, filename: r.filename }), r.h);
  // One guild per query, so the database sends rows while it aggregates a large store.
  const streamGuilds = await session.query('SELECT DISTINCT guild_id FROM smdb_data.guild_append ORDER BY 1');
  for (const g of streamGuilds.rows) {
    const streams = await session.query(
      `SELECT guild_id, module, filename, encode(sha256(convert_to(string_agg(chunk, '' ORDER BY seq), 'UTF8')), 'hex') AS h FROM smdb_data.guild_append WHERE guild_id = $1 GROUP BY guild_id, module, filename`,
      [String(g.guild_id)]);
    for (const r of streams.rows) hashes.set(itemId({ kind: 'append', guildId: r.guild_id, module: r.module, filename: r.filename }), r.h);
  }
  const grave = await session.query(
    `SELECT guild_id, retired_at::text AS retired_at, module, filename, kind, reason, encode(sha256(convert_to(doc, 'UTF8')), 'hex') AS h FROM smdb_data.guild_data_graveyard`);
  const graves = new Map<string, SnapGrave>();
  for (const r of grave.rows) {
    const retiredAt = Number(r.retired_at);
    hashes.set(itemId({ kind: r.kind, guildId: r.guild_id, grave: true, retiredAt, module: r.module, filename: r.filename }), r.h);
    graves.set(`${r.guild_id}-${retiredAt}`, { guildId: r.guild_id, retiredAt, reason: r.reason });
  }
  const owners = await session.query('SELECT guild_id FROM smdb_data.guild_ownership');
  return { hashes, graves: [...graves.values()], owners: owners.rows.map(r => String(r.guild_id)) };
}

// ============================================================================
// THE SERVICE: S0 AND THE JOB
// ============================================================================

interface JobContext {
  j: MigrationJournal;
  main: PgSession | null;
  mainTx: boolean;
  committed: boolean;
  staging: string | null;
  placingBegun: boolean;
  superseded: string;
  sessions: SessionContext;
}

type Classification =
  | { kind: 'finish'; from: 'env' | 'switch' }
  | { kind: 'stale' }
  | { kind: 'unknown'; reason: string };

interface EarlierFacts {
  dataId: string | null;
  superseded: string[];
  /** Superseded schemas whose meta read failed, with the error. */
  unreadable: Array<{ schema: string; error: string }>;
  sessions: number;
}

const PAST_READING = new Set<MigrationStage>(['copying', 'verifying', 'rereading', 'committing', 'placing', 'retire-source', 'switching', 'env']);

type CurrentRun = RunningMigration & { promise: Promise<void> | null; classifying: Promise<MigrationAnswer> | null };

export class MigrationService {
  private current: CurrentRun | null = null;
  private readonly backends = new WeakMap<PgSession, JobBackend>();

  constructor(private readonly host: MigrationHost, private readonly opts: ServiceOptions = {}) {}

  /** The running job's promise (tests and shutdown); resolves at once when none runs. */
  idle(): Promise<void> {
    return this.current?.promise ?? Promise.resolve();
  }

  running(): RunningMigration | null {
    return this.current ? { jobId: this.current.jobId, to: this.current.to } : null;
  }

  status(): MigrationAnswer {
    return deriveStatus(readDataFacts(), { running: this.current, managed: isManaged() });
  }

  private async connect(url: string, application: string, kind: 'job' | 'probe'): Promise<PgSession> {
    const session = this.opts.connect
      ? await this.opts.connect(url, application, kind)
      : await openJobSession(url, application, kind, this.opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS);
    if (kind !== 'job') return session;
    const backend: JobBackend = { pid: null, started: null };
    const watched = watchSession(session, this.opts.answerBoundMs ?? ANSWER_BOUND_MS,
      () => probeBackend(() => this.connect(url, application, 'probe'), backend, this.opts.probeBoundMs ?? PROBE_BOUND_MS));
    this.backends.set(watched, backend);
    return watched;
  }

  /** The server settings of a job session; records its backend for the watchdog's probe. */
  private async configure(session: PgSession): Promise<void> {
    const settings = await jobSessionSettings(session);
    const backend = this.backends.get(session);
    if (backend) {
      backend.pid = settings.pid;
      backend.started = settings.started;
    }
  }

  private async fault(point: string): Promise<void> {
    await this.opts.fault?.(point);
  }

  /** POST: the manager's hook and the panel route. Answers within 5 s. */
  async post(body: unknown): Promise<MigrationAnswer> {
    const req = (body && typeof body === 'object' ? body : {}) as { jobId?: unknown; to?: unknown; url?: unknown };
    if (!isValidJobId(req.jobId)) return { status: 400, body: { success: false, error: "jobId must be 8 to 40 letters, digits and '-'" } };
    if (req.to !== 'postgres' && req.to !== 'file') return { status: 400, body: { success: false, error: "to must be 'postgres' or 'file'" } };
    if (req.url !== undefined && (typeof req.url !== 'string' || req.url.trim() === '')) return { status: 400, body: { success: false, error: 'url must be a database address' } };
    const jobId = req.jobId;
    const to: DataBackendKind = req.to;
    const url = typeof req.url === 'string' ? req.url.trim() : undefined;

    const run = this.current;
    if (run) {
      if (run.classifying) {
        const first = await run.classifying;
        return run.to === to ? first : this.post(body);
      }
      if (run.to === to) return { status: 200, body: { success: true, jobId: run.jobId, to: run.to, state: 'running' } };
      return { status: 409, body: { success: false, error: `Migration ${run.jobId} (--to ${run.to}) is running`, jobId: run.jobId, to: run.to } };
    }
    if (!this.host.takeMigrationLock({ jobId, to })) {
      const held = this.host.migrationRunning();
      return { status: 409, body: { success: false, error: held ? `Migration ${held.jobId} (--to ${held.to}) is running` : 'A data migration is running', ...(held ?? {}) } };
    }
    let answerFirst!: (answer: MigrationAnswer) => void;
    const classifying = new Promise<MigrationAnswer>(resolve => { answerFirst = resolve; });
    const current: CurrentRun = { jobId, to, promise: null, classifying };
    this.current = current;
    let started = false;
    let answer: MigrationAnswer | undefined;
    try {
      const classified = await this.classify(jobId, to, url);
      answer = 'start' in classified ? this.begin(jobId, to, url, classified.start.lastJobId) : classified;
      started = answer.body.state === 'started';
      return answer;
    } catch (error) {
      console.error(`[Migration] The request could not be answered: ${message(error)}`);
      answer = { status: 500, body: { success: false, error: `The request could not be answered: ${message(error)}` } };
      return answer;
    } finally {
      current.classifying = null;
      if (!started) {
        if (this.current === current) this.current = null;
        this.host.releaseMigrationLock();
      }
      answerFirst(answer ?? { status: 500, body: { success: false, error: 'The request could not be answered' } });
    }
  }

  /** S0 after the lock: answers the request, or names the last job before the new one it starts. */
  private async classify(jobId: string, to: DataBackendKind, url: string | undefined): Promise<MigrationAnswer | { start: { lastJobId: string | null } }> {
    const refuse = (error: string, extra: Record<string, unknown> = {}): MigrationAnswer => ({ status: 409, body: { success: false, error, ...extra } });
    const facts = readDataFacts();
    if (!facts.ok) return refuse(facts.reason);
    if (url !== undefined && isAddressList(url)) return refuse(ADDRESS_LIST);
    const earlier = facts.journal;
    const marker = facts.marker;
    if (earlier && earlier.to === to) {
      const c = await this.classifyEarlier(earlier, marker, jobId, url);
      if (c.kind === 'unknown') return refuse(c.reason, { jobId: earlier.jobId, to: earlier.to });
      if (c.kind === 'finish') return this.finish(earlier, url, c.from);
      if (earlier.result !== 'failed') {
        try {
          writeJournal({ ...earlier, result: 'failed', error: OLD_STORE_NOT_RETIRED, finishedAt: Date.now() });
        } catch (error) {
          return refuse(`The earlier journal could not be written, so nothing was started: ${message(error)}`);
        }
      }
      console.warn(`[Migration] Migration ${earlier.jobId}: ${OLD_STORE_NOT_RETIRED}; starting migration ${jobId}`);
      return { start: { lastJobId: earlier.jobId } };
    }
    if (earlier && earlier.jobId === jobId) {
      const derived = deriveStatus(facts, { running: null, managed: isManaged() });
      if (derived.body.success !== true) return derived;
      const st = derived.body.job;
      return { status: 200, body: { success: true, jobId: st.jobId, to: st.to, state: st.state, stage: st.stage, ...(st.error ? { error: st.error } : {}) } };
    }
    const markerTo: DataBackendKind = marker ? marker.live : 'file';
    if (markerTo === to) {
      if (earlier) {
        const st = deriveStatus(facts, { running: null, managed: isManaged() }).body.job;
        if (st?.state === 'interrupted') {
          return refuse(`The data is already on ${to}; migration ${earlier.jobId} (--to ${earlier.to}) is unfinished at ${st.stage}; run it again with --to ${earlier.to}`,
            { jobId: earlier.jobId, to: earlier.to });
        }
      }
      return refuse(`The data is already on ${to}`);
    }
    if (!marker && !earlier && !facts.storesExist) {
      try {
        writeMarkerStrict({ live: 'file', storeId: null, flippedAt: Date.now() });
      } catch (error) {
        return refuse(`${MARKER_FILE} could not be written, so nothing was started: ${message(error)}`);
      }
    }
    return { start: { lastJobId: earlier?.jobId ?? null } };
  }

  private async classifyEarlier(earlier: MigrationJournal, marker: BackendStateMarker | null, jobId: string, url: string | undefined): Promise<Classification> {
    const unknown = (why: string): Classification => ({ kind: 'unknown', reason: `can't confirm; ${why}` });
    if (markerNamesJob(marker, earlier)) return { kind: 'finish', from: 'env' };
    if (earlier.result === 'done') return { kind: 'unknown', reason: doneUnnamedText(earlier.jobId) };
    if (marker && marker.live === earlier.to) return unknown(`the marker /data/.backend.json names ${earlier.to} under ${marker.migration ? `migration ${marker.migration}` : 'no migration'}, not migration ${earlier.jobId}`);
    if (earlier.to === 'postgres') {
      if (marker && marker.live !== 'file') return unknown('the facts of the earlier migration match no known state');
      return this.earlierCopySession(earlier, jobId, url);
    }
    const sourceId = earlier.sourceStoreId ?? marker?.storeId ?? null;
    if (!marker || marker.live !== 'postgres' || !sourceId) return unknown(`no store id is recorded for the source of migration ${earlier.jobId}`);
    const dbUrl = (loadCredentials().DATA_BACKEND_URL || '').trim();
    if (!dbUrl || isAddressList(dbUrl)) return unknown('DATA_BACKEND_URL is not one database address');
    let address: JournalAddress;
    try {
      address = normalizeAddress(dbUrl);
    } catch {
      return unknown('DATA_BACKEND_URL cannot be parsed');
    }
    if (earlier.source && !sameAddress(address, earlier.source)) {
      return unknown(`DATA_BACKEND_URL names ${showAddress(address)}, not ${showAddress(earlier.source)}, where migration ${earlier.jobId} read its source`);
    }
    const read = await this.readEarlierFacts(dbUrl, address, 'DATA_BACKEND_URL', earlier.jobId, jobId, true);
    if ('error' in read) return { kind: 'unknown', reason: read.error };
    if (read.sessions > 0) return unknown(sessionOpenText(earlier.jobId, earlier.jobId));
    const dataHolds = read.dataId === sourceId;
    const supHolds = read.superseded.includes(sourceId);
    if (supHolds && !dataHolds) return { kind: 'finish', from: 'switch' };
    if (dataHolds && supHolds) return unknown(`both smdb_data and a superseded schema hold store ${sourceId}`);
    if (read.unreadable.length > 0) {
      return unknown(read.unreadable.map(u => `the meta of ${u.schema} could not be read: ${u.error}`).join('; '));
    }
    if (dataHolds) return { kind: 'stale' };
    return unknown(`neither smdb_data nor a superseded schema holds store ${sourceId}`);
  }

  /** A move to Postgres that ended after S4: its own session may still be open on the destination (NB3-R2-OPS-4). */
  private async earlierCopySession(earlier: MigrationJournal, jobId: string, url: string | undefined): Promise<Classification> {
    if (!PAST_READING.has(earlier.stage) || !earlier.destination) return { kind: 'stale' };
    const source = url !== undefined ? 'the address given in the request' : 'DATA_BACKEND_URL';
    const dbUrl = (url ?? loadCredentials().DATA_BACKEND_URL ?? '').trim();
    if (!dbUrl || isAddressList(dbUrl)) return { kind: 'stale' };
    let address: JournalAddress;
    try {
      address = normalizeAddress(dbUrl);
    } catch {
      return { kind: 'stale' };
    }
    if (!sameAddress(address, earlier.destination)) return { kind: 'stale' };
    const read = await this.readEarlierFacts(dbUrl, address, source, earlier.jobId, jobId, false);
    if ('error' in read) return { kind: 'unknown', reason: read.error };
    if (read.sessions > 0) return { kind: 'unknown', reason: `can't confirm; ${sessionOpenText(earlier.jobId, earlier.jobId)}` };
    return { kind: 'stale' };
  }

  /** S0's one database read: bounded at 2 s to connect and 2 s for its transaction. withStores also reads the store ids. */
  private async readEarlierFacts(url: string, address: JournalAddress, source: string, earlierJob: string, jobId: string, withStores: boolean): Promise<EarlierFacts | { error: string }> {
    let session: PgSession | null = null;
    let settled = false;
    const where = `at ${showAddress(address)} (from ${source})`;
    const bound = <T>(work: Promise<T>, what: string): Promise<T> => Promise.race([
      work,
      new Promise<T>((_, reject) => { setTimeout(() => reject(new Error(`${what} took longer than ${PROBE_BOUND_MS / 1000} s`)), PROBE_BOUND_MS).unref(); }),
    ]);
    try {
      const connecting = this.connect(url, `smdb-migrate:${jobId}`, 'probe');
      // A connect that answers after its bound is closed at once.
      connecting.then(s => { if (settled) void s.end().catch(() => undefined); }, () => undefined);
      session = await bound(connecting, 'the connection to the database');
      const s = session;
      return await bound((async () => {
        await s.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        let dataId: string | null = null;
        const superseded: string[] = [];
        const unreadable: Array<{ schema: string; error: string }> = [];
        if (withStores) {
          try {
            dataId = await readMetaStoreId(s, 'smdb_data');
          } catch (error) {
            const code = (error as { code?: string })?.code;
            if (code !== '42P01' && code !== '3F000') throw error;
            await s.query('ROLLBACK');
            await s.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          }
          const names = await s.query(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'smdb\\_superseded\\_%'`);
          for (const r of names.rows) {
            // A schema whose meta cannot be read would abort the transaction; the savepoint keeps the others readable.
            await s.query('SAVEPOINT superseded_meta');
            let id: string | null = null;
            let failed = false;
            try {
              id = await readMetaStoreId(s, r.nspname);
            } catch (error) {
              failed = true;
              unreadable.push({ schema: String(r.nspname), error: message(error) });
            }
            await s.query(failed ? 'ROLLBACK TO SAVEPOINT superseded_meta' : 'RELEASE SAVEPOINT superseded_meta');
            if (id) superseded.push(id);
          }
        }
        const open = await s.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()`, [`smdb-migrate:${earlierJob}`]);
        await s.query('ROLLBACK');
        return { dataId, superseded, unreadable, sessions: Number(open.rows[0]?.n ?? 0) };
      })(), 'the read of the database');
    } catch (error) {
      if (isLoginRefused(error)) return { error: `${LOGIN_REFUSED} ${where}` };
      return { error: `can't confirm; the database ${where} could not be read: ${message(error)}` };
    } finally {
      settled = true;
      const s = session as PgSession | null;
      if (s) void s.end().catch(() => undefined);
    }
  }

  /** G7's checks of the env and of /data; throws a Refusal naming what failed. */
  private checkEnvAndData(managed: boolean): void {
    const probe = path.join(DATA_ROOT, `.migrate-probe-${process.pid}-${Date.now()}.tmp`);
    try {
      const fd = fs.openSync(probe, 'w');
      try {
        fs.writeFileSync(fd, 'probe');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.unlinkSync(probe);
    } catch (error) {
      try { fs.unlinkSync(probe); } catch { /* never created */ }
      throw new Refusal(`${DATA_ROOT} cannot take a temp file (${probe}): ${message(error)}`);
    }
    if (managed) return;
    const envPath = dataPath('.env');
    loadCredentials();
    const readError = credentialsReadError();
    if (readError) throw new Refusal(`${envPath} cannot be read: ${readError}`);
    try {
      fs.readFileSync(envPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new Refusal(`${envPath} cannot be read: ${message(error)}`);
    }
    if (isContainerPinned('DATA_BACKEND')) {
      throw new Refusal('DATA_BACKEND is set by the container environment, so the migration cannot switch it; remove DATA_BACKEND from the container environment (keep it in /data/.env), restart the container, and run the migration again');
    }
  }

  /** S10 to S12 for an earlier job whose copy is in place (G5, cases 1 and 2). */
  private async finish(earlier: MigrationJournal, url: string | undefined, from: 'env' | 'switch'): Promise<MigrationAnswer> {
    const managed = isManaged();
    try {
      this.checkEnvAndData(managed);
    } catch (error) {
      return { status: 409, body: { success: false, error: message(error), jobId: earlier.jobId, to: earlier.to } };
    }
    if (earlier.to === 'postgres' && earlier.destination) {
      const fromRequest = managed && url !== undefined;
      const source = fromRequest ? 'the destination address given in the request' : 'DATA_BACKEND_URL';
      const inEffect = ((fromRequest ? url : loadCredentials().DATA_BACKEND_URL) || '').trim();
      let address: JournalAddress | null = null;
      let problem = '';
      if (!inEffect) problem = `${source} is not set`;
      else {
        try { address = normalizeAddress(inEffect); } catch { problem = `${source} cannot be parsed as a database address`; }
      }
      if (!sameAddress(address, earlier.destination)) {
        const copied = `migration ${earlier.jobId} copied to ${showAddress(earlier.destination)} (store ${earlier.storeId ?? 'unknown'})`;
        return {
          status: 409,
          body: {
            success: false, jobId: earlier.jobId, to: earlier.to,
            error: `can't confirm; ${copied}, ${problem ? `and ${problem}` : `not ${showAddress(address)} (from ${source})`}`,
          },
        };
      }
    }
    let j: MigrationJournal = { ...earlier };
    let changed = false;
    const stage = (s: MigrationStage) => {
      const next = { ...j, stage: s };
      writeJournal(next);
      j = next;
      changed = true;
    };
    try {
      if (from === 'switch') {
        stage('switching');
        this.switchMarker(j);
      }
      if (!managed && readEnvFileDataBackend() !== j.to) {
        stage('env');
        this.switchEnv(j.to);
      }
      resetDataBackendCache();
      const wasDone = earlier.result === 'done';
      if (!wasDone || changed) {
        const finishedAt = wasDone && earlier.finishedAt !== undefined ? earlier.finishedAt : Date.now();
        const done: MigrationJournal = { ...j, result: 'done', error: undefined, finishedAt, envSwitched: !managed };
        try {
          writeJournal(done);
          j = done;
        } catch (error) {
          console.error(`[Migration] Migration ${j.jobId} is done, but its journal's done could not be written: ${message(error)}`);
        }
      }
      console.log(`[Migration] Migration ${j.jobId} (--to ${j.to}) is finished`);
      return { status: 200, body: { success: true, jobId: j.jobId, to: j.to, state: 'done', stage: j.stage, envSwitched: !managed } };
    } catch (error) {
      const error2 = message(error);
      try { writeJournal({ ...j, result: 'interrupted', error: error2, finishedAt: Date.now() }); } catch { /* a missing result reads as interrupted */ }
      console.error(`[Migration] Migration ${j.jobId} could not be finished at ${j.stage}: ${error2}`);
      return { status: 200, body: { success: true, jobId: j.jobId, to: j.to, state: 'interrupted', stage: j.stage, error: error2 } };
    }
  }

  /** The marker write of S10, with the reread after a throw; throws Interrupted when the marker did not land. */
  private switchMarker(j: MigrationJournal): void {
    const bundles = bundleImportsPresent();
    if (bundles.length > 0) throw new Interrupted(`A bundle import is in progress (${bundles.join(', ')}); the marker was not switched`);
    const want: BackendStateMarker = { live: j.to, storeId: j.to === 'postgres' ? j.storeId ?? null : null, flippedAt: Date.now(), migration: j.jobId };
    try {
      writeMarkerStrict(want);
    } catch (error) {
      const back = readDataFacts();
      const m = back.ok ? back.marker : null;
      if (m && m.live === want.live && (m.storeId ?? null) === want.storeId && m.migration === want.migration) {
        console.warn(`[Migration] The marker write of migration ${j.jobId} reported an error, but the marker reads back as written: ${message(error)}`);
        return;
      }
      throw new Interrupted(`The marker could not be switched: ${message(error)}`);
    }
  }

  private switchEnv(to: DataBackendKind): void {
    try {
      writeEnvDataBackend(to);
    } catch (error) {
      console.error(`[Migration] DATA_BACKEND in /data/.env could not be written: ${message(error)}`);
      throw new Interrupted(ENV_UNFINISHED);
    }
  }

  /** S1: the journal at checking, then the job runs on behind the answer. */
  private begin(jobId: string, to: DataBackendKind, url: string | undefined, lastJobId: string | null): MigrationAnswer {
    const j: MigrationJournal = { jobId, to, stage: 'checking', startedAt: Date.now() };
    try {
      writeJournal(j);
    } catch (error) {
      return { status: 200, body: { success: true, jobId, to, state: 'failed', stage: 'checking', error: `The journal could not be written: ${message(error)}` } };
    }
    console.log(`[Migration] Migration ${jobId} (--to ${to}) started`);
    const promise = this.run(j, url, lastJobId).finally(() => {
      this.current = null;
      this.host.releaseMigrationLock();
    });
    if (this.current) this.current.promise = promise;
    return { status: 200, body: { success: true, jobId, to, state: 'started', stage: 'checking' } };
  }

  private async run(journal: MigrationJournal, url: string | undefined, lastJobId: string | null): Promise<void> {
    const ctx: JobContext = {
      j: journal, main: null, mainTx: false, committed: false, staging: null, placingBegun: false,
      superseded: path.join(DATA_ROOT, '_superseded', supersededName(journal.jobId)),
      sessions: { lastJobId, secondLookMs: this.opts.secondLookMs ?? SECOND_LOOK_MS },
    };
    try {
      await this.steps(ctx, url);
    } catch (error) {
      await this.fail(ctx, error);
    } finally {
      if (ctx.main) await closeSession(ctx.main, this.closeBound());
    }
  }

  private closeBound(): number {
    return this.opts.closeBoundMs ?? CLOSE_BOUND_MS;
  }

  private async fail(ctx: JobContext, error: unknown): Promise<void> {
    if (isDeath(error)) return;
    const why = message(error);
    if (ctx.mainTx && ctx.main) {
      const main = ctx.main;
      const rolledBack = await within(main.query('ROLLBACK'), this.closeBound()).catch(() => ({ value: undefined }));
      if (!rolledBack) {
        destroySession(main);
        ctx.main = null;
      }
    }
    ctx.mainTx = false;
    const interrupted = error instanceof Interrupted || ctx.committed || ctx.j.stage === 'switching' || ctx.j.stage === 'env';
    if (!interrupted && ctx.staging && !ctx.placingBegun) await fs.promises.rm(ctx.staging, { recursive: true, force: true }).catch(() => undefined);
    let stage = ctx.j.stage;
    if (!interrupted && stage === 'committing') stage = 'rereading';
    if (!interrupted && stage === 'retire-source') stage = 'placing';
    const result = interrupted ? 'interrupted' : 'failed';
    try {
      writeJournal({ ...ctx.j, stage, result, error: why, finishedAt: Date.now() });
    } catch (writeError) {
      console.error(`[Migration] The journal of migration ${ctx.j.jobId} could not be written: ${message(writeError)}`);
    }
    console.error(`[Migration] Migration ${ctx.j.jobId} ${interrupted ? 'was interrupted' : 'failed'} at ${stage}: ${why}`);
  }

  /** The COMMIT of S8 or S9; `point` is the fault point immediately before the statement is sent. */
  private async commit(ctx: JobContext, point: string): Promise<void> {
    const session = ctx.main!;
    await this.fault(point);
    ctx.committed = true;
    let res: { command?: string };
    try {
      const bound = this.opts.commitBoundMs ?? COMMIT_BOUND_MS;
      const answered = await within(session.query('COMMIT'), bound);
      if (!answered) {
        ctx.mainTx = false;
        destroySession(session);
        ctx.main = null;
        throw new Interrupted(`The COMMIT got no answer within ${Math.round(bound / 1000)} s`);
      }
      res = answered.value;
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      ctx.mainTx = false;
      // An answer that ends the session may follow a commit record already written; any other answer is a refusal when the session still answers.
      if (isDatabaseError(error) && !commitMayHaveLanded(error)) {
        let answered: { value: unknown } | undefined | 'failed';
        try {
          answered = await within(session.query('SELECT 1'), this.closeBound());
        } catch {
          answered = 'failed';
        }
        if (answered && answered !== 'failed') {
          ctx.committed = false;
          throw new Error(`The database refused the COMMIT: ${message(error)}`);
        }
        if (!answered) {
          destroySession(session);
          ctx.main = null;
        }
      }
      throw new Interrupted(`can't confirm whether the COMMIT landed: ${message(error)}`);
    }
    ctx.mainTx = false;
    if (res.command === 'ROLLBACK') {
      ctx.committed = false;
      throw new Error('The database rolled the transaction back at its COMMIT');
    }
  }

  private async steps(ctx: JobContext, reqUrl: string | undefined): Promise<void> {
    const to = ctx.j.to;
    const from: DataBackendKind = to === 'postgres' ? 'file' : 'postgres';
    const jobId = ctx.j.jobId;
    const managed = isManaged();
    const app = `smdb-migrate:${jobId}`;
    const stage = (s: MigrationStage, extra: Partial<MigrationJournal> = {}) => {
      const next = { ...ctx.j, ...extra, stage: s };
      writeJournal(next);
      ctx.j = next;
    };
    const record = (extra: Partial<MigrationJournal>) => stage(ctx.j.stage, extra);

    // S2: the checks.
    await this.fault('S2');
    const bot = this.host.migrationBotState();
    if (!bot.ok) throw new Refusal(bot.error);
    this.checkEnvAndData(managed);
    const bundles = bundleImportsPresent();
    if (bundles.length > 0) throw new Refusal(`A bundle import is in progress (${bundles.join(', ')}); run the migration once it ends`);
    const facts = readDataFacts();
    if (!facts.ok) throw new Refusal(facts.reason);
    const marker = facts.marker;
    if ((marker?.live ?? 'file') !== from) throw new Refusal(`The data is already on ${to}`);
    const fromRequest = to === 'postgres' && reqUrl !== undefined;
    const pgUrl = ((fromRequest ? reqUrl : undefined) ?? loadCredentials().DATA_BACKEND_URL ?? '').trim();
    if (!pgUrl) throw new Refusal('DATA_BACKEND_URL is not set, so the database is unknown');
    if (isAddressList(pgUrl)) throw new Refusal(ADDRESS_LIST);
    let address: JournalAddress;
    try {
      address = normalizeAddress(pgUrl);
    } catch {
      throw new Refusal(fromRequest
        ? 'The destination address given in the request cannot be parsed as a database address'
        : 'DATA_BACKEND_URL cannot be parsed as a database address');
    }
    try {
      ctx.main = await this.connect(pgUrl, app, 'job');
    } catch (error) {
      if (isLoginRefused(error)) throw new Refusal(LOGIN_REFUSED);
      const source = fromRequest ? 'the address given in the request' : 'DATA_BACKEND_URL';
      throw new Refusal(`can't reach the database at ${showAddress(address)} (from ${source}): ${message(error)}`);
    }
    const main = ctx.main;
    await this.configure(main);
    const storeIdAt = async (): Promise<string | null> => {
      try {
        return await readMetaStoreId(main, 'smdb_data');
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code === '42P01' || code === '3F000') return null;
        throw new Refusal(`can't confirm the store id of smdb_data at ${showAddress(address)}: ${message(error)}`);
      }
    };
    const encoding = String((await main.query('SHOW server_encoding')).rows[0]?.server_encoding ?? '');
    if (encoding.toUpperCase() !== 'UTF8') throw new Refusal(`The database's server_encoding is ${encoding}, not UTF8`);
    await refuseOtherSessions(main, jobId, ctx.sessions);
    let renameDest: string | null = null;
    if (from === 'postgres') {
      const storeId = await storeIdAt();
      if (!marker?.storeId || storeId !== marker.storeId) {
        throw new Refusal(`The database holds store ${storeId ?? 'none'}, not the store /data/.backend.json names (${marker?.storeId ?? 'none'})`);
      }
      record({ sourceStoreId: storeId, source: address });
      addToStoreList(storeId);
    } else if (await schemaPresent(main)) {
      const storeId = await storeIdAt();
      const counts = (await main.query(
        `SELECT (SELECT count(*) FROM smdb_data.guild_data)::int AS docs, (SELECT count(*) FROM smdb_data.guild_append)::int AS appends, `
        + `(SELECT count(*) FROM smdb_data.guild_data_graveyard)::int AS graves, (SELECT count(*) FROM smdb_data.guild_ownership)::int AS owners`)).rows[0];
      if (!storeId || !readStoreList().includes(storeId)) {
        const empty = Number(counts.docs) + Number(counts.appends) + Number(counts.graves) + Number(counts.owners) === 0;
        throw new Refusal(`The database already holds store ${storeId ?? 'with no id'} in schema smdb_data (${counts.docs} documents, ${counts.appends} streams, `
          + `${counts.graves} graveyard rows, ${counts.owners} ownership rows), which this deployment never served${empty ? '; the schema holds no guild rows, so it can be dropped' : ''}`);
      }
      renameDest = storeId;
    }

    // S3: the drain, and an earlier run's staging folder aside.
    stage('draining');
    await this.fault('S3');
    const stuck = await drainGuildWrites();
    if (stuck.length > 0) throw new Refusal(`Guild writes of the web UI are still queued and could not be written: ${stuck.join(', ')}`);
    await moveEarlierStaging(DATA_ROOT, ctx.superseded);

    // S4: the read of the source, one guild or graveyard entry at a time; only keys, hashes and counts are kept.
    stage('reading');
    await this.fault('S4');
    let tally: Tally;
    if (from === 'file') {
      tally = await tallySource(jsonReader(DATA_ROOT));
    } else {
      await main.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      ctx.mainTx = true;
      await main.query(`LOCK TABLE ${GUILD_TABLES} IN SHARE MODE`);
      await refuseOtherSessions(main, jobId, ctx.sessions);
      const again = await readMetaStoreId(main, 'smdb_data');
      if (again !== ctx.j.sourceStoreId) throw new Refusal(`The database's store changed to ${again ?? 'none'} since the first check (${ctx.j.sourceStoreId})`);
      tally = await tallySource(pgReader(main));
    }
    const counts = tally.counts;

    // S5: the copy, fed guild by guild.
    stage('copying', { counts, ...(to === 'postgres' ? { destination: address } : {}), leftOut: tally.leftOut, closedTails: tally.closedTails });
    for (const tail of tally.closedTails) {
      console.warn(`[Migration] The stream ${tail} did not end in a newline; it was copied with one added, so its last line stays a line of its own`);
    }
    await this.fault('S5');
    if (to === 'postgres') {
      await main.query('BEGIN');
      ctx.mainTx = true;
      await main.query(`SELECT pg_advisory_xact_lock(hashtext('smdb_data_bootstrap'))`);
      if (renameDest) {
        await main.query('LOCK TABLE smdb_data.meta, smdb_data.guild_ownership, smdb_data.guild_data, smdb_data.guild_append, smdb_data.guild_data_graveyard IN ACCESS EXCLUSIVE MODE');
        const again = await readMetaStoreId(main, 'smdb_data');
        if (again !== renameDest) throw new Refusal(`The database's store changed from ${renameDest} to ${again ?? 'none'} since the first check; it was not renamed`);
        await refuseOtherSessions(main, jobId, ctx.sessions);
        const live = await liveShardClaims(main);
        if (live.length > 0) {
          const window = Math.max(...live.map(c => c.takeoverSeconds));
          const list = live.map(c => `shard ${c.shardId} held by ${c.name} (seen ${c.seenAgoS} s ago)`).join(', ');
          throw new Refusal(`Store ${renameDest} has shard claims of bot processes seen in the last ${window} s: ${list}; stop the bot on those machines (a clean stop releases its claims), then retry; it was not renamed`);
        }
        await main.query(`ALTER SCHEMA smdb_data RENAME TO smdb_superseded_${Date.now()}`);
      }
      await provisionStoreInTransaction(main);
      const creds = loadCredentials();
      const shardCount = Number.parseInt(creds.FLEET_SHARD_COUNT ?? '', 10);
      await jsonReader(DATA_ROOT)(part => writePgItems(main, part));
      await writePgOwners(main, tally.guilds, this.opts.nodeId?.() ?? getNodeId(), Number.isSafeInteger(shardCount) && shardCount > 0 ? shardCount : 1);
    } else {
      const staging = path.join(DATA_ROOT, `.migrate-${Date.now()}`);
      ctx.staging = staging;
      await fs.promises.mkdir(staging, { recursive: true });
      await pgReader(main)(part => stageSnapshot(part, staging));
    }

    // S6: the read-back of the destination.
    stage('verifying');
    await this.fault('S6');
    if (to === 'postgres') {
      const back = await readBackPg(main);
      compareHashes(tally.copied, back.hashes, 'The copy in the database');
      compareGraves(tally.graves, back.graves, 'The copy in the database');
      if ([...back.owners].sort().join(',') !== [...tally.guilds].sort().join(',')) throw new Error('The copy in the database has other ownership rows than the guilds copied');
    } else {
      const back = await tallySource(jsonReader(ctx.staging!));
      compareHashes(tally.copied, back.copied, 'The staged copy');
      compareGraves(tally.graves, back.graves, 'The staged copy');
    }

    // S7: the source read again.
    stage('rereading');
    await this.fault('S7');
    if (from === 'file') {
      compareHashes(tally.all, (await tallySource(jsonReader(DATA_ROOT))).all, 'The source read a second time');
    } else {
      const second = await this.connect(pgUrl, app, 'job');
      try {
        await this.configure(second);
        await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const again = await tallySource(pgReader(second));
        await second.query('ROLLBACK');
        compareHashes(tally.all, again.all, 'The source read a second time');
      } finally {
        await closeSession(second, this.closeBound());
      }
    }

    // S8: the commit of a Postgres copy, or the placement of a JSON one.
    if (to === 'postgres') {
      const newId = await readMetaStoreId(main, 'smdb_data');
      if (!newId) throw new Error('The new store has no store id');
      addToStoreList(newId);
      record({ storeId: newId });
      await this.fault('before-commit');
      await refuseOtherSessions(main, jobId, ctx.sessions);
      stage('committing');
      await this.commit(ctx, 'commit-send');
    } else {
      stage('placing', { shadow: tally.shadowNotes });
      await this.fault('S8');
      await refuseOtherSessions(main, jobId, ctx.sessions);
      for (const unit of tally.shadowUnits) {
        const part = await readPgUnit(main, unit);
        for (const s of part.shadow) {
          const name = `${encodeURIComponent(s.module)}__${encodeURIComponent(s.filename)}`;
          const target = path.join(ctx.superseded, 'shadow', unitKey(s), name);
          if (fs.existsSync(target)) throw new Refusal(`${target} exists; nothing was moved`);
          await writeSynced(target, s.bytes);
        }
      }
      await placeStaged(DATA_ROOT, ctx.staging!, ctx.superseded, () => { ctx.placingBegun = true; });

      // S9: the source retired.
      await this.fault('S9');
      await main.query(`LOCK TABLE ${GUILD_TABLES} IN ACCESS EXCLUSIVE MODE`);
      await main.query(`ALTER SCHEMA smdb_data RENAME TO smdb_superseded_${Date.now()}`);
      stage('retire-source');
      await this.fault('before-retire-commit');
      await this.commit(ctx, 'retire-commit-send');
      await this.fault('after-retire-commit');
    }

    // S10: the switch.
    stage('switching');
    await this.fault('S10');
    this.switchMarker(ctx.j);

    // S11: the env of a bot without a manager.
    if (!managed) {
      stage('env');
      await this.fault('S11');
      this.switchEnv(to);
    }

    // S12.
    await this.fault('S12');
    resetDataBackendCache();
    try {
      writeJournal({ ...ctx.j, result: 'done', error: undefined, finishedAt: Date.now(), envSwitched: !managed });
    } catch (error) {
      console.error(`[Migration] Migration ${jobId} is done, but its journal's done could not be written: ${message(error)}`);
    }
    console.log(`[Migration] Migration ${jobId} (--to ${to}) is done: ${counts.documents} documents, ${counts.appendFiles} streams, ${counts.graveyardEntries} graveyard entries`
      + (tally.leftOut.length > 0 ? `; left out: ${tally.leftOut.join(', ')}` : ''));
  }
}

