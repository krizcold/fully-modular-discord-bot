// NB23's record of the keys the notify-owner route posted: /data/owner-messages.json on every machine and, on a
// Postgres bot, a smdb_data.meta row owner-message:<key> per key. Each key holds its posted time.

import fs from 'fs';
import { dataPath } from '../../../utils/dataRoot';

export const OWNER_KEY_PREFIX = 'owner-message:';
export const OWNER_KEYS_DAYS = 90;
export const OWNER_KEYS_MAX = 1000;

export type KeyTimes = Record<string, string>;

export function ownerMessagesFile(): string {
  return dataPath('owner-messages.json');
}

/** The file's keys; a missing file holds none. */
export function readKeyFile(file: string): { ok: true; keys: KeyTimes } | { ok: false; cause: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 'ENOENT') return { ok: true, keys: {} };
    return { ok: false, cause: typeof code === 'string' ? code : error instanceof Error ? error.message : String(error) };
  }
  try {
    const parsed = JSON.parse(text) as { keys?: unknown };
    const keys = parsed?.keys;
    if (!keys || typeof keys !== 'object' || Array.isArray(keys) || Object.values(keys).some(v => typeof v !== 'string')) {
      return { ok: false, cause: 'it holds no record of keys' };
    }
    return { ok: true, keys: { ...(keys as KeyTimes) } };
  } catch (error) {
    return { ok: false, cause: error instanceof Error ? error.message : String(error) };
  }
}

/** The keys a record keeps: none older than 90 days and at most the newest 1000. */
export function keptKeys(keys: KeyTimes, now: number): KeyTimes {
  const kept = Object.entries(keys)
    .filter(([, at]) => now - Date.parse(at) <= OWNER_KEYS_DAYS * 86_400_000)
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, OWNER_KEYS_MAX);
  return Object.fromEntries(kept);
}

/** Both records in one; a key in both keeps its earlier posted time. */
export function mergeEarlier(a: KeyTimes, b: KeyTimes): KeyTimes {
  const out: KeyTimes = { ...a };
  for (const [key, at] of Object.entries(b)) {
    const held = out[key] === undefined ? NaN : Date.parse(out[key]);
    if (out[key] === undefined || (Number.isFinite(Date.parse(at)) && !(held <= Date.parse(at)))) out[key] = at;
  }
  return out;
}

/** The meta rows' keys with their posted times: the earlier of the value's time and updated_at. */
export function keyTimesOfRows(rows: Array<{ key: unknown; value: unknown; updated_at: unknown }>): KeyTimes {
  const out: KeyTimes = {};
  for (const row of rows) {
    const key = String(row.key);
    if (!key.startsWith(OWNER_KEY_PREFIX)) continue;
    let value: unknown = row.value;
    try {
      value = JSON.parse(String(row.value));
    } catch {
      value = String(row.value);
    }
    const times = [typeof value === 'string' ? Date.parse(value) : NaN, new Date(row.updated_at as string | Date).getTime()].filter(t => Number.isFinite(t));
    if (times.length === 0) continue;
    out[key.slice(OWNER_KEY_PREFIX.length)] = new Date(Math.min(...times)).toISOString();
  }
  return out;
}

/** Each time written as Date.toISOString(); a key whose time does not parse is left out. */
export function isoTimes(keys: KeyTimes): KeyTimes {
  const out: KeyTimes = {};
  for (const [key, at] of Object.entries(keys)) {
    const t = Date.parse(at);
    if (Number.isFinite(t)) out[key] = new Date(t).toISOString();
  }
  return out;
}

export function sameKeys(a: KeyTimes, b: KeyTimes): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every(k => b[k] !== undefined && Date.parse(a[k]) === Date.parse(b[k]));
}
