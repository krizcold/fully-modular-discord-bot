// Boot-time recognition guard (single-node paths). Decides, from the local
// file marker and the configured default, whether this node may serve, must
// serve from the OTHER backend (transformation-required), or must refuse.
// The fleet-delivered paths (active transformation record, master-delivered
// backend) layer on top of this in the fleet stage.
//
// The marker exists so a flip of DATA_BACKEND against a store that still holds
// the deployment's data is recognized instead of booting "empty": never boot
// against an empty store while data exists elsewhere.

import * as fs from 'fs';
import * as path from 'path';
import { DATA_ROOT } from '../../../../utils/dataRoot';
import { DataBackendKind, resolveDataBackend } from '../../../../utils/envLoader';
import { forceRouteDefault } from './routeResolver';
import { listGuilds } from './fileBackend';
import { readStoreId, PostgresUnreachableError } from './postgresBackend';
import type { BackendStateMarker } from './postgresBackend';

const MARKER_FILE = path.join(DATA_ROOT, '.backend.json');

export type GuardVerdict =
  | { state: 'boot'; live: DataBackendKind }
  | { state: 'transformation-required'; live: DataBackendKind; configured: DataBackendKind }
  | { state: 'refused'; reason: string };

export function readFileMarker(): BackendStateMarker | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(MARKER_FILE, 'utf-8'));
    if (parsed && (parsed.live === 'file' || parsed.live === 'postgres')) {
      return {
        live: parsed.live,
        storeId: typeof parsed.storeId === 'string' ? parsed.storeId : null,
        flippedAt: typeof parsed.flippedAt === 'number' ? parsed.flippedAt : 0,
        transformationId: typeof parsed.transformationId === 'string' ? parsed.transformationId : null,
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

  if (!marker) {
    // Lazy init. No marker means pre-milestone data (or a fresh install):
    // anything that exists lives in files.
    if (configured === 'file' || listGuilds().length === 0) {
      writeFileMarker({ live: configured, storeId: null, flippedAt: Date.now(), transformationId: null });
      return { state: 'boot', live: configured };
    }
    // Configured postgres with guild data on disk: the live backend is file.
    writeFileMarker({ live: 'file', storeId: null, flippedAt: Date.now(), transformationId: null });
    return { state: 'transformation-required', live: 'file', configured };
  }

  if (marker.live === configured) {
    return { state: 'boot', live: configured };
  }

  if (marker.live === 'file') {
    return { state: 'transformation-required', live: 'file', configured };
  }

  // Marker says the data lives in postgres while DATA_BACKEND says file: keep
  // serving from postgres (needs the URL still configured; boot checks that).
  return { state: 'transformation-required', live: 'postgres', configured };
}

/**
 * Webui-parent counterpart of the bot child's transformation-required route
 * override: the parent evaluates the same marker so both processes route a
 * guild to the same live backend. Read-only - never writes the marker, never
 * refuses (the child owns serving posture).
 */
export function applyRouteDefaultFromMarker(): void {
  try {
    const marker = readFileMarker();
    if (marker && marker.live !== resolveDataBackend()) forceRouteDefault(marker.live);
  } catch { /* invalid DATA_BACKEND surfaces per-route in the child's refusal */ }
}

/**
 * Store-identity verdict (the mistyped-or-swapped-URL case that otherwise
 * looks exactly like a fresh install). Call once the database answers; throws
 * PostgresUnreachableError while it cannot be asked so the caller retries.
 * On first contact with a provisioned store the marker adopts its store_id.
 */
export async function verifyStoreIdentity(url: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const dbStoreId = await readStoreId(url);
  const marker = readFileMarker();
  if (marker?.storeId && dbStoreId && marker.storeId !== dbStoreId) {
    // The binding only protects data that actually lives (or is mid-window
    // converting) in postgres. On a quiet live:file marker it is residue from
    // an aborted or abandoned window: rebind instead of refusing.
    if (marker.live === 'postgres' || marker.transformationId !== null) {
      return { ok: false, reason: `the configured database is not the one this deployment's data lives in (store ${dbStoreId} vs recorded ${marker.storeId})` };
    }
    writeFileMarker({ ...marker, storeId: dbStoreId });
    return { ok: true };
  }
  if (marker?.live === 'postgres' && marker.storeId && dbStoreId === null) {
    return { ok: false, reason: 'the marker records data living in postgres but the configured database carries no store identity' };
  }
  if (dbStoreId && (!marker || marker.storeId === null)) {
    writeFileMarker({
      live: marker?.live ?? 'postgres',
      storeId: dbStoreId,
      flippedAt: marker?.flippedAt ?? Date.now(),
      transformationId: marker?.transformationId ?? null,
    });
  }
  return { ok: true };
}

export { PostgresUnreachableError };
