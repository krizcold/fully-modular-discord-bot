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

const MARKER_FILE = path.join(DATA_ROOT, '.backend.json');

export interface BackendStateMarker {
  live: DataBackendKind;
  storeId: string | null;
  flippedAt: number;
}

export type GuardVerdict =
  | { state: 'boot'; live: DataBackendKind }
  | { state: 'refused'; reason: string };

export function readFileMarker(): BackendStateMarker | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(MARKER_FILE, 'utf-8'));
    if (parsed && (parsed.live === 'file' || parsed.live === 'postgres')) {
      return {
        live: parsed.live,
        storeId: typeof parsed.storeId === 'string' ? parsed.storeId : null,
        flippedAt: typeof parsed.flippedAt === 'number' ? parsed.flippedAt : 0,
      };
    }
  } catch { /* absent or unreadable = no marker */ }
  return null;
}

export function writeFileMarker(marker: BackendStateMarker): void {
  try {
    fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true });
    const tmp = `${MARKER_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(marker, null, 2));
    fs.renameSync(tmp, MARKER_FILE);
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
  const configured = resolveDataBackend();
  const marker = readFileMarker();

  if (marker?.live === configured) {
    return { state: 'boot', live: configured };
  }

  const reason = recognitionRefusal();
  if (reason) {
    if (!marker) writeFileMarker({ live: 'file', storeId: null, flippedAt: Date.now() });
    return { state: 'refused', reason };
  }
  writeFileMarker({ live: configured, storeId: null, flippedAt: Date.now() });
  return { state: 'boot', live: configured };
}

/** Why the bot refuses to serve with this marker and DATA_BACKEND, or null; reads only, so the web UI can ask too. */
export function recognitionRefusal(): string | null {
  const configured = resolveDataBackend();
  const live = readFileMarker()?.live;
  if (live === configured) return null;
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
export async function verifyStoreIdentity(url: string, adopt: boolean): Promise<{ ok: true } | { ok: false; reason: string; pending?: true }> {
  let dbStoreId: string | null;
  try {
    dbStoreId = await readStoreId(url);
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
    });
  }
  return { ok: true };
}

export { PostgresUnreachableError };
