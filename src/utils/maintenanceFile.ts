// maintenance.json under the data root: the state the manager's maintenance hook last saved. The web UI process
// writes it; the bot process reads it at boot and when its database login comes back.

import * as fs from 'fs';
import { dataPath } from './dataRoot';
import { atomicWriteFileSync } from '../bot/internalSetup/utils/atomicWrite';
import { DEFAULT_MAINTENANCE_MESSAGE } from '../bot/internalSetup/utils/maintenanceGate';

export const MAINTENANCE_FILE = 'maintenance.json';
/** A Discord reply holds 2,000 characters. */
export const MAINTENANCE_MESSAGE_MAX = 1800;

export type MaintenanceState = 'running' | 'maintenance';

export interface MaintenanceRecord {
  state: MaintenanceState;
  message: string;
  since: string | null;
}

export function maintenanceFilePath(): string {
  return dataPath(MAINTENANCE_FILE);
}

/**
 * The saved state. A missing file means running; a file that cannot be read or parsed means maintenance with the
 * default text, so a damaged file never lets module code run against data the manager may be moving.
 */
export function readMaintenanceFile(): MaintenanceRecord {
  let raw: string;
  try {
    raw = fs.readFileSync(maintenanceFilePath(), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { state: 'running', message: DEFAULT_MAINTENANCE_MESSAGE, since: null };
    console.error(`[Maintenance] ${MAINTENANCE_FILE} could not be read, so the bot stays in maintenance:`, error instanceof Error ? error.message : error);
    return { state: 'maintenance', message: DEFAULT_MAINTENANCE_MESSAGE, since: null };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MaintenanceRecord> | null;
    if (parsed && (parsed.state === 'running' || parsed.state === 'maintenance')) {
      const message = typeof parsed.message === 'string' && parsed.message.trim() !== '' ? parsed.message : DEFAULT_MAINTENANCE_MESSAGE;
      return { state: parsed.state, message, since: typeof parsed.since === 'string' ? parsed.since : null };
    }
  } catch { /* reported below */ }
  console.error(`[Maintenance] ${MAINTENANCE_FILE} does not hold a state, so the bot stays in maintenance`);
  return { state: 'maintenance', message: DEFAULT_MAINTENANCE_MESSAGE, since: null };
}

/** Saves the state crash-safely; throws when it could not be saved. */
export function writeMaintenanceFile(state: MaintenanceState, message: string): MaintenanceRecord {
  const record: MaintenanceRecord = { state, message, since: new Date().toISOString() };
  atomicWriteFileSync(maintenanceFilePath(), JSON.stringify(record, null, 2));
  return record;
}
