import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { BotCredentials, isContainerPinned } from '../../utils/envLoader';
import { dataPath } from '../../utils/dataRoot';

/** Keys whose value an answer never repeats (the secrets, and the IDs /status masks). */
const MASKED_KEYS = new Set<string>([
  'DISCORD_TOKEN', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET', 'DATA_BACKEND_URL',
  'CLIENT_ID', 'GUILD_ID', 'DISCORD_CLIENT_ID',
]);

/** The keys stored in /data/.env itself, with their stored values; the container env is not in it. */
export function readStoredEnv(): Record<string, string> {
  const file = dataPath('.env');
  return fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {};
}

/**
 * What a save writes: the file's own keys, plus every key whose value the
 * save changed (removed when it cleared it). A value that only the container
 * env supplied is never copied into the file.
 */
export function fileAfterSave(stored: Record<string, string>, before: BotCredentials, after: BotCredentials): BotCredentials {
  const out: BotCredentials = { ...stored };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] === after[key]) continue;
    if (after[key] === undefined) delete out[key]; else out[key] = after[key];
  }
  return out;
}

/**
 * Changed or cleared keys the container env pins: the env wins over the
 * file, so each keeps its env value whatever the file now says. Call after
 * loadCredentials(). `masked` adds keys whose value the message never repeats.
 */
export function containerSetChanges(
  before: BotCredentials,
  after: BotCredentials,
  masked: (key: string) => boolean = () => false,
): Array<{ field: string; message: string }> {
  const out: Array<{ field: string; message: string }> = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] === after[key] || !isContainerPinned(key)) continue;
    const kept = MASKED_KEYS.has(key) || masked(key) ? 'its value' : process.env[key];
    out.push({ field: key, message: `${key} is set by the container environment, so it keeps ${kept}` });
  }
  return out;
}
