import type { SnapshotEntry } from '../../bot/internalSetup/utils/backups/snapshotList';
import { timeText } from '../../bot/internalSetup/utils/folderChain';
import { postOwnerMessage, type Answer } from '../utils/ownerNotify';
import { stateWriteFailedLine, writeState, type BackupAlert, type BackupState, type TestResult } from './state';

export type AlertCase = 'snapshot-failed' | 'test-failed';
export const ALERT_CASES: readonly AlertCase[] = ['snapshot-failed', 'test-failed'];

export const ALERT_AFTER_MS = 3 * 60 * 60 * 1000;
export const RETRY_MS = 60 * 60 * 1000;
const BUDGET_MS = 20_000;

let budgetMs = BUDGET_MS;
/** The alerts as this process last set them; state.json follows unless its write failed (A1.d). */
let memory: Partial<Record<AlertCase, BackupAlert>> | null = null;
let startedAt: number | null = null;
let unsaved = false;
/** Whether `memory` holds the alerts of a readable state.json; a call while it cannot be read loads nothing. */
let fromFile = false;

export function _setAlertTimingForTests(over: { budgetMs?: number } | null): void {
  budgetMs = over?.budgetMs ?? BUDGET_MS;
}

export function _resetAlertsForTests(): void {
  memory = null;
  startedAt = null;
  unsaved = false;
  fromFile = false;
}

/** Contract 7's key: the case and when it began. */
export function alertKey(c: AlertCase, since: number): string {
  return `bot-backup:${c}:${new Date(since).toISOString()}`;
}

const ended = (text: string): string => (text.endsWith('.') ? text : `${text}.`);

/** The newest complete hourly or daily backup's time. */
function newestTakenAt(snapshots: readonly SnapshotEntry[]): number | null {
  let newest: number | null = null;
  for (const s of snapshots) {
    if (s.state !== 'complete' || (s.kind !== 'hourly' && s.kind !== 'daily')) continue;
    if (newest === null || s.manifest.takenAt > newest) newest = s.manifest.takenAt;
  }
  return newest;
}

function lastWords(state: BackupState): string {
  const a = state.lastAttempt;
  const attempt = a && a.result !== 'ok' && typeof a.error === 'string' ? { at: a.at, error: a.error } : null;
  const r = state.lastRefusal;
  if (attempt && (!r || attempt.at >= r.at)) return `Last error: ${ended(attempt.error)}`;
  if (r) {
    return typeof r.startedAt === 'number'
      ? `The backup started at ${timeText(r.startedAt)} was not kept: ${ended(r.words)}`
      : `No backup could be started at ${timeText(r.at)}: ${ended(r.words)}`;
  }
  return 'No backup was attempted.';
}

export function snapshotFailedText(state: BackupState, newest: number | null): string {
  const since = newest !== null ? timeText(newest) : `the web panel began backing it up at ${timeText(state.watchingSince ?? 0)}`;
  return `No backup of this bot's data has succeeded since ${since}. ${lastWords(state)} The Dashboard tab of the bot's web panel lists the backups.`;
}

export function testFailedText(last: TestResult): string {
  const failed = typeof last.detail === 'string' && last.detail !== '' ? `failed: ${ended(last.detail)}` : 'failed.';
  return `The daily test restore of this bot's newest backup (${last.name}) ${failed} That backup may not restore. The Dashboard tab of the bot's web panel shows the details.`;
}

interface Condition {
  stands: boolean;
  /** Whether this process may raise a new alert of the case now. */
  mayRaise: boolean;
  text: () => string;
}

function conditionOf(c: AlertCase, tick: AlertTick, newest: number | null, since: number): Condition {
  const { now, state } = tick;
  if (c === 'test-failed') {
    const last = state.test?.last ?? null;
    return { stands: last?.result === 'failed', mayRaise: true, text: () => testFailedText(last as TestResult) };
  }
  const watching = typeof state.watchingSince === 'number' ? state.watchingSince : null;
  const base = newest === null ? watching : watching === null ? newest : Math.max(newest, watching);
  const attempted = typeof state.lastAttempt?.at === 'number' && state.lastAttempt.at >= since;
  return {
    stands: base !== null && now - base >= ALERT_AFTER_MS,
    mayRaise: attempted || now - since >= ALERT_AFTER_MS,
    text: () => snapshotFailedText(state, newest),
  };
}

function loaded(alerts: unknown): Partial<Record<AlertCase, BackupAlert>> {
  const out: Partial<Record<AlertCase, BackupAlert>> = {};
  if (!alerts || typeof alerts !== 'object') return out;
  for (const c of ALERT_CASES) {
    const a = (alerts as Record<string, any>)[c];
    if (a && typeof a === 'object' && typeof a.since === 'number' && typeof a.key === 'string' && typeof a.text === 'string'
      && a.message && typeof a.message === 'object' && typeof a.message.state === 'string') {
      out[c] = a as BackupAlert;
    }
  }
  return out;
}

function save(state: BackupState, fileCause: string | null): void {
  state.alerts = JSON.parse(JSON.stringify(memory ?? {}));
  if (fileCause !== null) {
    unsaved = true;
    return;
  }
  try {
    writeState(state);
    unsaved = false;
  } catch (error) {
    unsaved = true;
    console.error(stateWriteFailedLine(error));
  }
}

const errorOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** C17's fates of one post. */
async function post(alert: BackupAlert, at: number): Promise<BackupAlert['message']> {
  let answer: Answer;
  try {
    answer = await postOwnerMessage({ text: alert.text, key: alert.key }, budgetMs);
  } catch (error) {
    return { state: 'failed', at, error: errorOf(error) };
  }
  const { status, body } = answer;
  const note = typeof body.note === 'string' ? { note: body.note } : {};
  if (status === 200 && body.posted === true) {
    return { state: 'sent', at, ...(body.place === 'dm' || body.place === 'channel' ? { place: body.place } : {}), ...note };
  }
  if (status === 200 && body.posted === false) return { state: 'already', at, ...note };
  const error = typeof body.error === 'string' ? body.error : `HTTP ${status}`;
  if (status === 502 && body.unknown === true) return { state: 'unknown', at, error };
  return { state: 'failed', at, error };
}

/**
 * Code review 3, D4: a bot that is not a JSON bot keeps no backup alert. Clears both in memory and in state.json,
 * sending nothing; writes only when one stands (or an earlier write is owed), and nothing while state.json cannot be read.
 */
export function clearAlerts(state: BackupState, fileCause: string | null): void {
  if (fileCause !== null) return;
  const standing = Object.keys(state.alerts ?? {}).length > 0 || Object.keys(memory ?? {}).length > 0;
  memory = {};
  fromFile = true;
  if (standing || unsaved) save(state, null);
}

export interface AlertTick {
  now: number;
  /** The tick's state; the alerts set `alerts` in it and write it. */
  state: BackupState;
  snapshots: readonly SnapshotEntry[];
  /** Why state.json could not be read at this tick: the alerts then stay in memory, unwritten. */
  fileCause?: string | null;
}

/**
 * Decision 10's alerts at one tick: each case raised, sent, sent again or cleared, with state.json written at each
 * step. A write that throws, or one skipped while state.json cannot be read, keeps the alerts in memory; the next tick
 * that can write writes them. While state.json cannot be read no alert is cleared; the file's alerts are added at the
 * first call that reads it.
 */
export async function updateAlerts(tick: AlertTick): Promise<void> {
  const { now, state } = tick;
  const cause = tick.fileCause ?? null;
  if (startedAt === null) startedAt = now;
  if (memory === null) memory = {};
  if (cause === null && !fromFile) {
    const file = loaded(state.alerts);
    for (const c of ALERT_CASES) if (!memory[c] && file[c]) memory[c] = file[c];
    fromFile = true;
  }
  const held = memory;
  const newest = newestTakenAt(tick.snapshots);
  let wrote = false;
  for (const c of ALERT_CASES) {
    const condition = conditionOf(c, tick, newest, startedAt);
    let alert = held[c];
    if (!condition.stands) {
      if (alert && cause === null) {
        delete held[c];
        save(state, cause);
        wrote = true;
      }
      continue;
    }
    if (!alert) {
      if (!condition.mayRaise) continue;
      alert = { since: now, key: alertKey(c, now), text: condition.text(), message: { state: 'sending', at: now } };
      held[c] = alert;
    } else {
      const { state: fate, at } = alert.message;
      const retry = fate === 'failed' && (typeof at !== 'number' || now - at >= RETRY_MS);
      if (fate !== 'sending' && !retry) continue;
      alert.message = { state: 'sending', at: now };
    }
    save(state, cause);
    alert.message = await post(alert, now);
    save(state, cause);
    wrote = true;
  }
  if (unsaved && !wrote) save(state, cause);
}
