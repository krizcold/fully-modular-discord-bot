// Boot-time recognition guard. Decides, from the local file marker and the
// configured default, whether this bot may serve or must refuse.
//
// The marker exists so a flip of DATA_BACKEND against a store that still holds
// the deployment's data is recognized instead of booting "empty": never boot
// against an empty store while data exists elsewhere.

import * as fs from 'fs';
import * as path from 'path';
import { DATA_ROOT } from '../../../../utils/dataRoot';
import { DataBackendKind, resolveDataBackend } from '../../../../utils/envLoader';
import { listGuilds } from './fileBackend';
import { readStoreId, PostgresUnreachableError, PostgresInRecoveryError } from './postgresBackend';
import type { ClientConfig } from 'pg';
import { atomicWriteFileSync } from '../atomicWrite';

export const MARKER_FILE = path.join(DATA_ROOT, '.backend.json');
export const MIGRATION_FILE = path.join(DATA_ROOT, '.migration.json');
export const STORES_FILE = path.join(DATA_ROOT, '.stores.json');
export const CANT_CONFIRM_STORE = "can't confirm which store holds the data";

export interface BackendStateMarker {
  live: DataBackendKind;
  storeId: string | null;
  flippedAt: number;
  /** The migration that last switched the store; with it set, every mismatch with DATA_BACKEND refuses. */
  migration?: string;
}

export type MigrationStage =
  | 'checking' | 'draining' | 'reading' | 'copying' | 'verifying' | 'rereading' | 'committing' | 'placing'
  | 'retire-source' | 'switching' | 'env';

export interface JournalAddress {
  host: string;
  port: number;
  database: string;
}

export interface MigrationCounts {
  documents: number;
  appendFiles: number;
  graveyardEntries: number;
  bytes: number;
}

/** /data/.migration.json: the last data migration, as its job wrote it. */
export interface MigrationJournal {
  jobId: string;
  to: DataBackendKind;
  stage: MigrationStage;
  result?: 'done' | 'failed' | 'interrupted';
  error?: string;
  startedAt: number;
  finishedAt?: number;
  sourceStoreId?: string | null;
  source?: JournalAddress | null;
  destination?: JournalAddress | null;
  storeId?: string | null;
  counts?: MigrationCounts;
  envSwitched?: boolean;
  leftOut?: string[];
  /** What the job did not copy and says so (NB5 decision 16: an unreadable owner channel setting). */
  notes?: string[];
  shadow?: string[];
  /** Streams whose last line had no newline, copied with one added (NB13 decision 12). */
  closedTails?: string[];
}

export type DataFacts =
  | { ok: true; marker: BackendStateMarker | null; journal: MigrationJournal | null; storesExist: boolean }
  | { ok: false; reason: string };

export type GuardVerdict =
  | { state: 'boot'; live: DataBackendKind }
  | { state: 'refused'; reason: string };

type FileRead = { state: 'absent' } | { state: 'bad'; why: string } | { state: 'ok'; value: unknown };

function readJsonFile(file: string): FileRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { state: 'absent' };
    return { state: 'bad', why: `${file} cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
  try {
    return { state: 'ok', value: JSON.parse(raw) };
  } catch {
    return { state: 'bad', why: `${file} cannot be parsed` };
  }
}

function markerFrom(value: unknown): BackendStateMarker | null {
  const parsed = value as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object' || (parsed.live !== 'file' && parsed.live !== 'postgres')) return null;
  return {
    live: parsed.live,
    storeId: typeof parsed.storeId === 'string' ? parsed.storeId : null,
    flippedAt: typeof parsed.flippedAt === 'number' ? parsed.flippedAt : 0,
    ...(typeof parsed.migration === 'string' ? { migration: parsed.migration } : {}),
  };
}

function journalFrom(value: unknown): MigrationJournal | null {
  const parsed = value as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.jobId !== 'string' || (parsed.to !== 'file' && parsed.to !== 'postgres') || typeof parsed.stage !== 'string') return null;
  return parsed as unknown as MigrationJournal;
}

/**
 * The marker, the journal and whether the store list exists. A file that does not exist is told apart from one that
 * cannot be read or parsed; the marker counts as missing when it does not exist beside the journal or the store list,
 * and the journal when it does not exist beside the store list or a marker that names a migration. Any of those
 * answers "can't confirm which store holds the data", naming the files, and the caller writes nothing over them.
 */
export function readDataFacts(): DataFacts {
  const problems: string[] = [];
  const m = readJsonFile(MARKER_FILE);
  const j = readJsonFile(MIGRATION_FILE);
  let storesExist = false;
  try {
    fs.statSync(STORES_FILE);
    storesExist = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      problems.push(`${STORES_FILE} cannot be read (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  let marker: BackendStateMarker | null = null;
  let journal: MigrationJournal | null = null;
  if (m.state === 'bad') problems.push(m.why);
  else if (m.state === 'ok') {
    marker = markerFrom(m.value);
    if (!marker) problems.push(`${MARKER_FILE} does not name file or postgres`);
  }
  if (j.state === 'bad') problems.push(j.why);
  else if (j.state === 'ok') {
    journal = journalFrom(j.value);
    if (!journal) problems.push(`${MIGRATION_FILE} does not hold a job id, a direction and a stage`);
  }
  if (m.state === 'absent' && (j.state !== 'absent' || storesExist)) {
    problems.push(`${MARKER_FILE} is missing beside ${j.state !== 'absent' ? MIGRATION_FILE : STORES_FILE}`);
  }
  if (j.state === 'absent' && (storesExist || marker?.migration)) {
    problems.push(`${MIGRATION_FILE} is missing beside ${storesExist ? STORES_FILE : `${MARKER_FILE}, which names migration ${marker?.migration}`}`);
  }
  if (problems.length > 0) return { ok: false, reason: `${CANT_CONFIRM_STORE}: ${problems.join('; ')}` };
  return { ok: true, marker, journal, storesExist };
}

export function readFileMarker(): BackendStateMarker | null {
  const read = readJsonFile(MARKER_FILE);
  return read.state === 'ok' ? markerFrom(read.value) : null;
}

/**
 * The store id the marker records, for a store that lacks its store_id row: null when there is no marker or it records
 * none. Throws when the marker exists but can't be read or parsed, so no store id is written on a guess.
 */
export function readMarkerStoreId(): string | null {
  const read = readJsonFile(MARKER_FILE);
  if (read.state === 'absent') return null;
  const unknown = 'so the store id it records is unknown; no store id was written and nothing was refused';
  if (read.state === 'bad') throw new Error(`this machine's marker ${read.why}, ${unknown}`);
  const marker = markerFrom(read.value);
  if (!marker) throw new Error(`this machine's marker ${MARKER_FILE} does not name file or postgres, ${unknown}`);
  return marker.storeId;
}

/** The migration's own marker write: throws when it fails, and reads the file back. */
export function writeMarkerStrict(marker: BackendStateMarker): void {
  const text = JSON.stringify(marker, null, 2);
  atomicWriteFileSync(MARKER_FILE, text);
  const back = fs.readFileSync(MARKER_FILE, 'utf-8');
  if (back !== text) throw new Error(`${MARKER_FILE} does not read back as written`);
}

export function writeFileMarker(marker: BackendStateMarker): void {
  try {
    atomicWriteFileSync(MARKER_FILE, JSON.stringify(marker, null, 2));
  } catch (error) {
    console.error('[Data] Failed to write backend marker:', error);
  }
}

/**
 * Local, synchronous half of the guard: file marker vs configured default.
 * The store-identity half (postgres reachable) runs async in
 * verifyStoreIdentity once the database can be asked.
 */
export function evaluateRecognitionGuard(): GuardVerdict {
  const facts = readDataFacts();
  if (!facts.ok) return { state: 'refused', reason: facts.reason };
  const configured = resolveDataBackend();
  const marker = facts.marker;

  const retired = retiredSourceRefusal(facts);
  if (retired) return { state: 'refused', reason: retired };

  if (marker?.live === configured) {
    return { state: 'boot', live: configured };
  }

  const reason = refusalFrom(facts, configured);
  if (reason) {
    if (!marker) writeFileMarker({ live: 'file', storeId: null, flippedAt: Date.now() });
    return { state: 'refused', reason };
  }
  writeFileMarker({ live: configured, storeId: null, flippedAt: Date.now(), ...(marker?.migration ? { migration: marker.migration } : {}) });
  return { state: 'boot', live: configured };
}

/**
 * A move to JSON renamed its Postgres source aside (or may have) and the marker still names that source: no boot may
 * reach the database, where it would provision an empty store.
 */
function retiredSourceRefusal(facts: Extract<DataFacts, { ok: true }>): string | null {
  const journal = facts.journal;
  if (!journal || journal.to !== 'file' || journal.result === 'done') return null;
  if (!journal.sourceStoreId || journal.sourceStoreId !== facts.marker?.storeId) return null;
  if (journal.stage === 'switching') {
    return `A migration is unfinished; run it again with --to file to finish it (migration ${journal.jobId})`;
  }
  if (journal.stage !== 'retire-source') return null;
  if (journal.result === 'failed') return `The old store still serves; run it again to start over (migration ${journal.jobId})`;
  return `can't confirm whether migration ${journal.jobId} retired the old store; run it again with --to file to finish it or start over`;
}

/** Why the bot refuses to serve with this marker and DATA_BACKEND, or null; reads only, so the web UI can ask too. */
export function recognitionRefusal(): string | null {
  const facts = readDataFacts();
  if (!facts.ok) return facts.reason;
  return refusalFrom(facts, resolveDataBackend());
}

function refusalFrom(facts: Extract<DataFacts, { ok: true }>, configured: DataBackendKind): string | null {
  const live = facts.marker?.live;
  if (live === configured) return null;
  const migration = facts.marker?.migration;
  if (migration) {
    const journal = facts.journal;
    if (journal && journal.jobId === migration && journal.result !== 'done') {
      return `A migration is unfinished; run it again with --to ${journal.to} to finish it (migration ${migration})`;
    }
    return `Migration ${migration} moved the data to ${live}; set DATA_BACKEND to ${live}, or run a migration`;
  }
  if (live === 'postgres') {
    return `this deployment's data lives in postgres but DATA_BACKEND is ${configured}; set DATA_BACKEND back to postgres`;
  }
  // No marker, or one naming files: anything that exists lives in files.
  if (configured === 'file' || listGuilds().length === 0) return null;
  return `guild data lives in files under ${DATA_ROOT} but DATA_BACKEND is postgres, which would start without it; set DATA_BACKEND back to file`;
}

/**
 * Store-identity verdict (the mistyped-or-swapped-URL case that otherwise
 * looks exactly like a fresh install). Call once the database answers; throws
 * PostgresUnreachableError while it cannot be asked so the caller retries.
 * A marker with no store id adopts the store's only when adopt is set (provisioning passed); until then the verdict
 * is pending, so a database refused for its schema version never leaves its id in the marker.
 */
export async function verifyStoreIdentity(config: ClientConfig, adopt: boolean): Promise<{ ok: true } | { ok: false; reason: string; pending?: true }> {
  let dbStoreId: string | null;
  try {
    dbStoreId = await readStoreId(config);
  } catch (error) {
    if (error instanceof PostgresInRecoveryError) return { ok: false, reason: error.message, pending: true };
    throw error;
  }
  const marker = readFileMarker();
  if (marker?.storeId && dbStoreId && marker.storeId !== dbStoreId) {
    return { ok: false, reason: `the configured database is not the one this deployment's data lives in (store ${dbStoreId} vs recorded ${marker.storeId})` };
  }
  if (marker?.live === 'postgres' && marker.storeId && dbStoreId === null) {
    // A store still provisioning carries none yet: the caller asks again.
    return { ok: false, reason: 'the marker records data living in postgres but the configured database carries no store identity', pending: true };
  }
  if (dbStoreId && (!marker || marker.storeId === null)) {
    if (!adopt) return { ok: false, reason: 'the store id is adopted once provisioning passes', pending: true };
    writeFileMarker({
      live: marker?.live ?? 'postgres',
      storeId: dbStoreId,
      flippedAt: marker?.flippedAt ?? Date.now(),
      ...(marker?.migration ? { migration: marker.migration } : {}),
    });
  }
  return { ok: true };
}

export { PostgresUnreachableError };
