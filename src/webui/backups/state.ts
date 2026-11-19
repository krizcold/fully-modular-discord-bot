import * as fs from 'fs';
import { atomicWriteFileSync } from '../../bot/internalSetup/utils/atomicWrite';
import { restoreJournalPath, type RestoreJournal } from '../../bot/internalSetup/utils/backups/restoreJournal';
import { dataPath } from '../../utils/dataRoot';

export interface BackupSettings {
  enabled: boolean;
  hour: number;
}

export const DEFAULT_SETTINGS: Readonly<BackupSettings> = Object.freeze({ enabled: true, hour: 4 });

export interface LastAttempt {
  name: string;
  at: number;
  result: 'ok' | 'failed' | 'unknown';
  error?: string;
  cause?: string;
  tries?: number;
}

export interface LastRefusal {
  at: number;
  words: string;
  startedAt?: number;
}

export interface TestRun {
  name: string;
  startedAt: number;
  attempt: number;
}

export interface TestResult {
  name: string;
  at: number;
  result: 'passed' | 'failed';
  detail?: string;
}

export interface BackupAlert {
  since: number;
  key: string;
  text: string;
  message: { state: string; [field: string]: unknown };
}

export interface BackupState {
  lastAttempt: LastAttempt | null;
  lastRefusal: LastRefusal | null;
  watchingSince: number | null;
  test: { day: string | null; running: TestRun | null; last: TestResult | null; lastPassed: string | null };
  alerts: Record<string, BackupAlert>;
}

export function defaultState(): BackupState {
  return { lastAttempt: null, lastRefusal: null, watchingSince: null, test: { day: null, running: null, last: null, lastPassed: null }, alerts: {} };
}

export function settingsPath(): string {
  return dataPath('_snapshots', 'settings.json');
}

export function statePath(): string {
  return dataPath('_snapshots', 'state.json');
}

export function settingsUnreadableText(cause: string): string {
  return `The backup settings (/data/_snapshots/settings.json) cannot be read (${cause}); backups are taken and none is deleted until it can be read.`;
}

export function stateUnreadableText(cause: string): string {
  return `The backup record (/data/_snapshots/state.json) cannot be read (${cause}); backups are taken and none is deleted until it can be read.`;
}

export function stateWriteFailedLine(error: unknown): string {
  return `[Backup] The backup record (/data/_snapshots/state.json) could not be written (${error instanceof Error ? error.message : String(error)}); the web panel keeps the change in memory and writes it at its next check.`;
}

const isObject =(v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The file's JSON object; null with no cause when absent; null with the cause when it cannot be read. */
function readJson(file: string): { value: Record<string, unknown> | null; cause: string | null } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { value: null, cause: code === 'ENOENT' ? null : code ?? String(e) };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { value: null, cause: 'not valid JSON' };
  }
  return isObject(value) ? { value, cause: null } : { value: null, cause: 'not a JSON object' };
}

/** settings.json, synchronously; an absent file reads as the default, one that cannot be read too, with its cause. */
export function readSettings(): { settings: BackupSettings; cause: string | null } {
  const { value, cause } = readJson(settingsPath());
  if (!value) return { settings: { ...DEFAULT_SETTINGS }, cause };
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return { settings: { ...DEFAULT_SETTINGS }, cause: 'enabled is not true or false' };
  if (value.hour !== undefined && !(Number.isInteger(value.hour) && (value.hour as number) >= 0 && (value.hour as number) <= 23)) {
    return { settings: { ...DEFAULT_SETTINGS }, cause: 'hour is not a whole number from 0 to 23' };
  }
  return { settings: { enabled: (value.enabled as boolean | undefined) ?? DEFAULT_SETTINGS.enabled, hour: (value.hour as number | undefined) ?? DEFAULT_SETTINGS.hour }, cause: null };
}

/** state.json, synchronously; an absent file reads as the default state, one that cannot be read too, with its cause. */
export function readState(): { state: BackupState; cause: string | null } {
  const { value, cause } = readJson(statePath());
  if (!value) return { state: defaultState(), cause };
  for (const field of ['test', 'alerts'] as const) {
    if (value[field] !== undefined && !isObject(value[field])) return { state: defaultState(), cause: `${field} is not a JSON object` };
  }
  const base = defaultState();
  const state = { ...base, ...value, test: { ...base.test, ...(value.test as object | undefined) }, alerts: { ...(value.alerts as object | undefined) } };
  return { state: state as BackupState, cause: null };
}

const text = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Throws only before or at its rename (N4); the file then holds the previous whole state. */
export function writeState(state: BackupState): void {
  atomicWriteFileSync(statePath(), text(state), undefined, { chain: false });
}

/** Throws before its rename with the previous settings kept, or after it with a FolderSyncError and the new ones in place. */
export function writeSettings(settings: BackupSettings): void {
  atomicWriteFileSync(settingsPath(), text(settings));
}

/** Throws only before or at its rename (N4); the file then holds the previous whole journal. */
export function writeRestoreJournal(journal: RestoreJournal): void {
  atomicWriteFileSync(restoreJournalPath(), text(journal), undefined, { chain: false });
}
