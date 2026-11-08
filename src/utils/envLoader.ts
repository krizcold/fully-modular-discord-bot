// src/utils/envLoader.ts

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import { dataPath } from './dataRoot';
import { atomicWriteFileSync } from '../bot/internalSetup/utils/atomicWrite';

/**
 * Deployment mode.
 * - `managed`: bot runs under the external docker-discord-bot-manager; bot credentials (DISCORD_TOKEN,
 *   CLIENT_ID, GUILD_ID) are owned by the manager and MUST NOT be editable from this Web-UI.
 * - `standalone`: bot runs on its own; all credential fields are editable.
 */
export type DeploymentMode = 'managed' | 'standalone';

export function getDeploymentMode(): DeploymentMode {
  return process.env.BUILD_MODE === 'managed' ? 'managed' : 'standalone';
}

export interface BotCredentials {
  DISCORD_TOKEN?: string;
  CLIENT_ID?: string;
  GUILD_ID?: string;
  MAIN_GUILD_ID?: string;
  // Sharding, read in the bot child.
  NODE_NAME?: string;
  FLEET_SHARD_COUNT?: string;
  FLEET_SHARD_CAPACITY?: string;
  FLEET_TAKEOVER_SECONDS?: string;
  FLEET_SHARD_RETURN?: string;
  FLEET_RESHARD_OVERLAP?: string;
  // OAuth Configuration (Optional - for Guild Web-UI)
  ENABLE_GUILD_WEBUI?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  OAUTH_CALLBACK_URL?: string;
  SESSION_SECRET?: string;
  // Data backend: file (default) | postgres, and the Postgres connection string.
  DATA_BACKEND?: string;
  DATA_BACKEND_URL?: string;
  // 'off' starts the bot on its databases alone when the switch notices cannot be read.
  DATA_NOTICE_CHECK?: string;
  // Payment provider credentials are arbitrary env-var keys the providers
  // declare via getCredentialFields(); they're addressable through the
  // [string]: string | undefined index signature below. The per-provider
  // credentials modal in the Premium panel reads/writes them directly via
  // /api/appstore/premium/providers/:id/credentials.
  [key: string]: string | undefined;
}

export interface CredentialValidation {
  isValid: boolean;
  missing: string[];
  reason?: string;
}

// Keys whose process.env value was seeded from /data/.env by THIS process
// rather than provided by the container environment. For these the file stays
// authoritative across reloads (edits re-apply, deletions unset); genuine
// compose env is never in this set and keeps its precedence.
const fileSeededEnvKeys = new Set<string>();

// Why the last loadCredentials could not read /data/.env (null: read, or no file).
let envReadError: string | null = null;

/**
 * Non-null when the last loadCredentials found /data/.env in place but could
 * not read it, so its answer is the container env alone: a caller must not
 * decide or write anything from that view.
 */
export function credentialsReadError(): string | null {
  return envReadError;
}

function isPlaceholderValue(value?: string): boolean {
  if (!value) return true;
  const v = value.trim().toUpperCase();
  return v.startsWith('REPLACE WITH') ||
         v.startsWith('OPTIONAL') ||
         v === '' ||
         v.includes('WILL BE AUTO-GENERATED');
}

/**
 * True when the container environment PINS this key: a real value is present in
 * process.env that /data/.env cannot override (genuine compose env wins by
 * design). Call after loadCredentials(), so the seeded-key set reflects the
 * current file. Lets a caller refuse before doing work that a later write to
 * /data/.env would silently fail to take effect for.
 */
export function isContainerPinned(key: string): boolean {
  const value = process.env[key];
  if (typeof value !== 'string' || isPlaceholderValue(value)) return false;
  return !fileSeededEnvKeys.has(key);
}

/**
 * Loads environment variables with priority:
 * 1. Docker-compose environment variables (process.env)
 * 2. /data/.env file (overrides docker-compose if exists)
 *
 * This ensures CasaOS compatibility while allowing Web-UI to manage credentials.
 */
export function loadCredentials(): BotCredentials {
  const isPlaceholder = isPlaceholderValue;

  // Start with docker-compose env vars (CasaOS compatibility)
  const credentials: BotCredentials = {
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    CLIENT_ID: process.env.CLIENT_ID,
    GUILD_ID: process.env.GUILD_ID,
    MAIN_GUILD_ID: process.env.MAIN_GUILD_ID,
    // Sharding fields (flow to the bot child via the botManager env spread)
    NODE_NAME: process.env.NODE_NAME,
    FLEET_SHARD_COUNT: process.env.FLEET_SHARD_COUNT,
    FLEET_SHARD_CAPACITY: process.env.FLEET_SHARD_CAPACITY,
    FLEET_TAKEOVER_SECONDS: process.env.FLEET_TAKEOVER_SECONDS,
    FLEET_SHARD_RETURN: process.env.FLEET_SHARD_RETURN,
    FLEET_RESHARD_OVERLAP: process.env.FLEET_RESHARD_OVERLAP,
    // OAuth fields
    ENABLE_GUILD_WEBUI: process.env.ENABLE_GUILD_WEBUI,
    DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
    OAUTH_CALLBACK_URL: process.env.OAUTH_CALLBACK_URL,
    SESSION_SECRET: process.env.SESSION_SECRET,
    DATA_BACKEND: process.env.DATA_BACKEND,
    DATA_BACKEND_URL: process.env.DATA_BACKEND_URL,
    DATA_NOTICE_CHECK: process.env.DATA_NOTICE_CHECK,
  };

  // Payment provider env vars are dynamic per provider; copy through any
  // process.env keys that match the registered providers' declared
  // credential prefixes so process-env-only deployments work without
  // /data/.env.
  for (const key of Object.keys(process.env)) {
    if (key in credentials) continue;
    if (key.startsWith('STRIPE_')
      || key.startsWith('LEMONSQUEEZY_')
      || key.startsWith('PAYPAL_')
      || key.startsWith('PATREON_')
      || key === 'DISCORD_APPLICATION_ID'
      || key === 'BOOST_TARGET_GUILD_ID'
      || key === 'WEBUI_BASE_URL') {
      credentials[key] = process.env[key];
    }
  }

  // Override with /data/.env if it exists (Web-UI managed)
  const dataEnvPath = dataPath('.env');
  envReadError = null;
  let raw: Buffer | null = null;
  try {
    raw = fs.readFileSync(dataEnvPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      envReadError = error instanceof Error ? error.message : String(error);
      console.error('[EnvLoader] Error loading /data/.env:', error);
    }
  }
  if (raw !== null) {
    try {
      const dataEnv = dotenv.parse(raw);
      // Only override if docker-compose value is a placeholder
      for (const [key, value] of Object.entries(dataEnv)) {
        // Compose defaults like ${VAR:-} leave the var set to an empty string,
        // which dotenv would treat as "already set"; empty means unset intent,
        // so apply the saved value to process.env for direct readers. A key
        // this loader itself seeded stays FILE-authoritative on later loads:
        // without that, the first load pins the value into process.env and a
        // web-UI edit (or clear) never takes effect until the whole container
        // is recreated. Genuine compose-provided env still wins forever.
        if (process.env[key] === undefined || process.env[key] === '' || fileSeededEnvKeys.has(key)) {
          process.env[key] = value;
          fileSeededEnvKeys.add(key);
        }
        if (isPlaceholder(credentials[key]) || fileSeededEnvKeys.has(key)) {
          credentials[key] = value;
        }
      }
      // A seeded key deleted from the file was explicitly cleared: unset it
      // everywhere so e.g. a cleared NODE_NAME stays cleared.
      for (const key of [...fileSeededEnvKeys]) {
        if (!(key in dataEnv)) {
          delete process.env[key];
          credentials[key] = undefined;
          fileSeededEnvKeys.delete(key);
        }
      }
      console.log('[EnvLoader] Loaded credentials from /data/.env');
    } catch (error) {
      envReadError = error instanceof Error ? error.message : String(error);
      console.error('[EnvLoader] Error loading /data/.env:', error);
    }
  }

  // Clean up placeholder values - set them to undefined
  for (const [key, value] of Object.entries(credentials)) {
    if (isPlaceholder(value)) {
      credentials[key] = undefined;
    }
  }

  // Default MAIN_GUILD_ID to GUILD_ID if not set
  if (!credentials.MAIN_GUILD_ID || credentials.MAIN_GUILD_ID.trim() === '') {
    credentials.MAIN_GUILD_ID = credentials.GUILD_ID;
    console.log('[EnvLoader] MAIN_GUILD_ID not set, defaulting to GUILD_ID');
  }

  // Auto-generate OAUTH_CALLBACK_URL if not set but OAuth is enabled
  if (credentials.ENABLE_GUILD_WEBUI === 'true' && !credentials.OAUTH_CALLBACK_URL) {
    // We can't get the domain here, so this will be handled by the OAuth config
    console.log('[EnvLoader] OAUTH_CALLBACK_URL will be auto-generated');
  }

  return credentials;
}

/**
 * Durable SESSION_SECRET: generate once and APPEND to /data/.env (append-only
 * on purpose - round-tripping the whole credentials object would freeze
 * compose-env values into the file). Sessions then survive restarts.
 */
export function ensureDurableSessionSecret(): void {
  const credentials = loadCredentials();
  if (credentials.SESSION_SECRET && credentials.SESSION_SECRET.trim() !== '') {
    if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = credentials.SESSION_SECRET;
    return;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  const dataEnvPath = dataPath('.env');
  try {
    fs.mkdirSync(path.dirname(dataEnvPath), { recursive: true });
    const needsNewline = fs.existsSync(dataEnvPath)
      && fs.statSync(dataEnvPath).size > 0
      && !fs.readFileSync(dataEnvPath, 'utf-8').endsWith('\n');
    fs.appendFileSync(dataEnvPath, `${needsNewline ? '\n' : ''}SESSION_SECRET=${secret}\n`, 'utf-8');
    process.env.SESSION_SECRET = secret;
    console.log('[EnvLoader] Generated durable SESSION_SECRET in /data/.env');
  } catch (error) {
    // Read-only /data: the sessionManager boot fallback covers this run.
    console.warn('[EnvLoader] Could not persist SESSION_SECRET:', error instanceof Error ? error.message : error);
  }
}

export type DataBackendKind = 'file' | 'postgres';

let cachedEnvBackend: DataBackendKind | null = null;

/**
 * The deployment's data backend. Absent/empty DATA_BACKEND means file; any
 * value other than file/postgres refuses boot.
 */
export function resolveDataBackend(): DataBackendKind {
  if (cachedEnvBackend === null) {
    const raw = (loadCredentials().DATA_BACKEND || '').trim().toLowerCase();
    if (raw === '' || raw === 'file') cachedEnvBackend = 'file';
    else if (raw === 'postgres') cachedEnvBackend = 'postgres';
    else throw new Error(`[EnvLoader] Invalid DATA_BACKEND value "${raw}" (expected "file" or "postgres")`);
  }
  return cachedEnvBackend;
}

/** FLEET_SHARD_CAPACITY when blank or unset: shards spread one per machine. */
export const DEFAULT_SHARD_CAPACITY = 1;
export const DEFAULT_TAKEOVER_SECONDS = 30;
const MIN_TAKEOVER_SECONDS = 15;
const MAX_TAKEOVER_SECONDS = 3600;

const loggedSettings = new Set<string>();

function rejectSetting(key: string, raw: string, used: string): void {
  if (loggedSettings.has(`${key}=${raw}`)) return;
  loggedSettings.add(`${key}=${raw}`);
  console.warn(`[EnvLoader] ${key}="${raw}" is not valid (${used})`);
}

/** This machine's shard target on a database bot: how many shards it takes before any other machine does. */
export function shardCapacity(): number {
  const raw = (process.env.FLEET_SHARD_CAPACITY ?? '').trim();
  if (raw === '') return DEFAULT_SHARD_CAPACITY;
  if (/^[0-9]+$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw);
  rejectSetting('FLEET_SHARD_CAPACITY', raw, `expected 0 or a positive whole number; using ${DEFAULT_SHARD_CAPACITY}`);
  return DEFAULT_SHARD_CAPACITY;
}

/** The takeover delay of the claims this machine holds, in seconds. */
export function takeoverSeconds(): number {
  const raw = (process.env.FLEET_TAKEOVER_SECONDS ?? '').trim();
  if (raw === '') return DEFAULT_TAKEOVER_SECONDS;
  const value = Number(raw);
  if (/^[0-9]+$/.test(raw) && value >= MIN_TAKEOVER_SECONDS && value <= MAX_TAKEOVER_SECONDS) return value;
  rejectSetting('FLEET_TAKEOVER_SECONDS', raw, `expected a whole number from ${MIN_TAKEOVER_SECONDS} to ${MAX_TAKEOVER_SECONDS}; using ${DEFAULT_TAKEOVER_SECONDS}`);
  return DEFAULT_TAKEOVER_SECONDS;
}

/** Whether this machine gives shards back to their home machine and moves shards above its target. */
export function shardReturnEnabled(): boolean {
  const raw = (process.env.FLEET_SHARD_RETURN ?? '').trim();
  if (raw === '' || raw === 'true') return true;
  if (raw === 'false') return false;
  rejectSetting('FLEET_SHARD_RETURN', raw, 'expected true or false; using true');
  return true;
}

/** Whether this machine allows a reshard beside the running shards (NB9 decision 20, C12). */
export function reshardOverlap(): boolean {
  const raw = (process.env.FLEET_RESHARD_OVERLAP ?? '').trim();
  if (raw === '' || raw === 'true') return true;
  if (raw === 'false') return false;
  rejectSetting('FLEET_RESHARD_OVERLAP', raw, 'expected true or false; using true');
  return true;
}

/** A migration switched DATA_BACKEND: the next resolveDataBackend reads it again. */
export function resetDataBackendCache(): void {
  cachedEnvBackend = null;
}

/** DATA_BACKEND as /data/.env holds it now (lowercased), or null when the file or the key is absent or unreadable. */
export function readEnvFileDataBackend(): string | null {
  try {
    const value = dotenv.parse(fs.readFileSync(dataPath('.env'))).DATA_BACKEND;
    return typeof value === 'string' ? value.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

// dotenv 16.6.1's LINE (node_modules/dotenv/lib/main.js:9), with match indices.
const DOTENV_LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mgd;

const hasOwn = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/** /data/.env's bytes as text, or null when they are not valid UTF-8; a BOM stays in the text. */
export function envTextOf(raw: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    return null;
  }
}

const notUtf8 = (what: string) => `${dataPath('.env')} is not valid UTF-8, so ${what} without changing other bytes; save it as UTF-8, then run the migration again`;
export const NOT_UTF8_KEYS = () => notUtf8('the payment provider keys cannot be written to it');
const NOT_UTF8_BACKEND = () => notUtf8('the migration cannot write DATA_BACKEND to it');

interface EnvSpan {
  key: string;
  /** The span in the original text: the start of the key's line to the end of its value's last line. */
  start: number;
  end: number;
  /** The end of the span's line break (end when there is none). */
  next: number;
}

/** Each match of dotenv's parse, as the lines it covers in the original text. */
function envSpans(text: string): EnvSpan[] {
  const at: number[] = [];
  let norm = '';
  for (let i = 0; i < text.length; i++) {
    at.push(i);
    if (text[i] === '\r') {
      norm += '\n';
      if (text[i + 1] === '\n') i++;
    } else {
      norm += text[i];
    }
  }
  at.push(text.length);
  const spans: EnvSpan[] = [];
  const line = new RegExp(DOTENV_LINE.source, 'mgd');
  for (let m = line.exec(norm); m !== null; m = line.exec(norm)) {
    const indices = m.indices!;
    const keyAt = indices[1][0];
    let start = norm.lastIndexOf('\n', keyAt - 1) + 1;
    if (start === 0 && norm[0] === '\uFEFF') start = 1;
    const value = indices[2];
    const last = value && value[1] > value[0] ? value[1] - 1 : keyAt;
    const lineEnd = norm.indexOf('\n', last) < 0 ? norm.length : norm.indexOf('\n', last);
    spans.push({ key: m[1], start: at[start], end: at[lineEnd], next: at[lineEnd < norm.length ? lineEnd + 1 : lineEnd] });
  }
  return spans;
}

function renderEnv(text: string, spans: EnvSpan[], edits: Map<number, string | null>, appended: Array<{ line: string; gap: boolean }>): string {
  let out = '';
  let pos = 0;
  spans.forEach((s, i) => {
    if (!edits.has(i)) return;
    out += text.slice(pos, s.start);
    const replacement = edits.get(i);
    if (replacement === null || replacement === undefined) {
      pos = s.next;
    } else {
      out += replacement;
      pos = s.end;
    }
  });
  out += text.slice(pos);
  for (const a of appended) {
    if (out.length > 0 && !/[\r\n]$/.test(out)) out += '\n';
    out += `${a.gap ? '\n' : ''}${a.line}\n`;
  }
  return out;
}

const listed = (keys: string[]) => keys.join(', ');

/**
 * /data/.env's text with each changed key written (a string) or removed (null), every other byte kept: the spans
 * dotenv's own parse reads are edited (NB6F V1). `unread` names the provider of a key removed because its entry in the
 * database cannot be read. Throws, in this order, when the result would change another key, misread a set key, or
 * still set a removed key.
 */
export function envKeysText(text: string, changes: Record<string, string | null>, unread: Record<string, string> = {}): string {
  const envPath = dataPath('.env');
  const keys = Object.keys(changes);
  const spans = envSpans(text);
  const before = dotenv.parse(text);
  const edits = new Map<number, string | null>();
  const lastOf = new Map<string, number>();
  spans.forEach((s, i) => {
    if (!hasOwn(changes, s.key)) return;
    if (changes[s.key] === null) edits.set(i, null);
    else lastOf.set(s.key, i);
  });
  spans.forEach((s, i) => {
    if (hasOwn(changes, s.key) && typeof changes[s.key] === 'string' && lastOf.get(s.key) !== i) edits.set(i, null);
  });
  const setKeys = keys.filter(k => typeof changes[k] === 'string');
  const order = [
    ...setKeys.filter(k => lastOf.has(k)).sort((a, b) => lastOf.get(a)! - lastOf.get(b)!),
    ...setKeys.filter(k => !lastOf.has(k)),
  ];
  const outsideKept = (after: Record<string, string>) =>
    [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => !hasOwn(changes, k) && before[k] !== after[k]);
  const reads = (after: Record<string, string>, placed: string[]) => placed.every(k => after[k] === changes[k]);
  const nullsGone = (after: Record<string, string>) => keys.every(k => changes[k] !== null || !hasOwn(after, k));
  const appended: Array<{ line: string; gap: boolean }> = [];
  const placed: string[] = [];
  for (const key of order) {
    const value = changes[key] as string;
    const span = lastOf.get(key);
    const forms = [value, `'${value}'`, `"${value}"`, `\`${value}\``];
    const tries = (span === undefined ? [false, true] : [false]).flatMap(gap => forms.map(form => ({ form, gap })));
    const apply = (t: { form: string; gap: boolean }) => {
      if (span === undefined) appended.push({ line: `${key}=${t.form}`, gap: t.gap });
      else edits.set(span, `${key}=${t.form}`);
    };
    const parsedWith = (t: { form: string; gap: boolean }) => {
      apply(t);
      const after = dotenv.parse(renderEnv(text, spans, edits, appended));
      if (span === undefined) appended.pop();
      return after;
    };
    const chosen = tries.find(t => { const a = parsedWith(t); return outsideKept(a).length === 0 && reads(a, [...placed, key]) && nullsGone(a); })
      ?? tries.find(t => { const a = parsedWith(t); return outsideKept(a).length === 0 && reads(a, placed); })
      ?? tries[0];
    apply(chosen);
    placed.push(key);
  }
  const out = renderEnv(text, spans, edits, appended);
  const after = dotenv.parse(out);
  const others = outsideKept(after);
  if (others.length === 1) throw new Error(`Writing ${listed(keys)} would change the value of ${others[0]} in ${envPath}; edit that line of ${envPath}, then run the migration again`);
  if (others.length > 1) throw new Error(`Writing ${listed(keys)} would change the values of ${listed(others)} in ${envPath}; edit those lines of ${envPath}, then run the migration again`);
  const wrong = order.find(k => after[k] !== changes[k]);
  if (wrong !== undefined) {
    const tail = wrong === 'DATA_BACKEND'
      ? `edit the DATA_BACKEND lines of ${envPath}, then run the migration again`
      : `change ${wrong} in the premium tab, then run the migration again`;
    throw new Error(`The value of ${wrong} cannot be written to ${envPath} so that it reads back the same; ${tail}`);
  }
  const still = keys.filter(k => changes[k] === null && hasOwn(after, k));
  const cleared = still.filter(k => !hasOwn(unread, k));
  if (cleared.length === 1) throw new Error(`${cleared[0]} was cleared in the database, but a line of ${envPath} still sets it; remove that line, then run the migration again`);
  if (cleared.length > 1) throw new Error(`${listed(cleared)} were cleared in the database, but lines of ${envPath} still set them; remove those lines, then run the migration again`);
  if (still.length > 0) {
    const id = unread[still[0]];
    const ofId = still.filter(k => unread[k] === id);
    throw new Error(ofId.length === 1
      ? `The database's keys of ${id} cannot be read, so ${ofId[0]} must not be set, but a line of ${envPath} still sets it; remove that line, then run the migration again`
      : `The database's keys of ${id} cannot be read, so ${listed(ofId)} must not be set, but lines of ${envPath} still set them; remove those lines, then run the migration again`);
  }
  return out;
}

/** envKeysText over /data/.env as it is (temp file, fsync, rename, fsync of /data), keeping its mode, uid and gid. */
function writeEnvLines(changes: Record<string, string | null>, unread: Record<string, string>, notUtf8Text: string): void {
  const envPath = dataPath('.env');
  let raw: Buffer | null = null;
  let keep: { mode: number; uid: number; gid: number } | undefined;
  try {
    raw = fs.readFileSync(envPath);
    const st = fs.statSync(envPath);
    keep = { mode: st.mode, uid: st.uid, gid: st.gid };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  const text = raw === null ? '' : envTextOf(raw);
  if (text === null) throw new Error(notUtf8Text);
  atomicWriteFileSync(envPath, envKeysText(text, changes, unread), keep);
}

/**
 * Why DATA_BACKEND cannot be written to /data/.env (the text given, or the file as it is) so that it reads `to` and
 * every other byte stays, or null when it can (NB6F U3, W5, Y3).
 */
export function envSwitchRefusal(to: DataBackendKind, text?: string): string | null {
  const envPath = dataPath('.env');
  let current = text;
  if (current === undefined) {
    let raw: Buffer | null = null;
    try {
      raw = fs.readFileSync(envPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return `${envPath} cannot be read: ${causeOf(error)}`;
    }
    const decoded = raw === null ? '' : envTextOf(raw);
    if (decoded === null) return NOT_UTF8_BACKEND();
    current = decoded;
  }
  try {
    envKeysText(current, { DATA_BACKEND: to });
    return null;
  } catch (error) {
    return causeOf(error);
  }
}

/**
 * Rewrites the DATA_BACKEND lines of /data/.env and nothing else (temp file, fsync, rename, fsync of /data), then reads
 * it back; throws when the write or the read back fails.
 */
export function writeEnvDataBackend(value: DataBackendKind): void {
  const envPath = dataPath('.env');
  writeEnvLines({ DATA_BACKEND: value }, {}, NOT_UTF8_BACKEND());
  if (readEnvFileDataBackend() !== value) throw new Error(`${envPath} does not read back DATA_BACKEND=${value}`);
}

/**
 * Writes the payment provider keys a migration to JSON carries into /data/.env (NB6F D5), then reads each one back.
 * `kept` is where the file as it was is kept, null when there was none.
 */
export function writeEnvKeys(changes: Record<string, string | null>, unread: Record<string, string>, kept: string | null): void {
  const envPath = dataPath('.env');
  writeEnvLines(changes, unread, NOT_UTF8_KEYS());
  const back = dotenv.parse(fs.readFileSync(envPath));
  const wrong = Object.keys(changes).filter(k => (changes[k] === null ? hasOwn(back, k) : back[k] !== changes[k]));
  if (wrong.length > 0) {
    const where = kept ? `the file as it was is kept at ${kept}` : `there was no ${envPath} before`;
    throw new Error(`${envPath} was written but does not read back ${listed(wrong)} as written; ${where}; run the migration again`);
  }
}

/** The keys of each built-in payment provider that the credentials doc may hold (NB6 decision 57). */
const BUILTIN_PROVIDER_KEYS: Record<string, (key: string) => boolean> = {
  stripe: key => key.startsWith('STRIPE_'),
  paypal: key => key.startsWith('PAYPAL_'),
  patreon: key => key.startsWith('PATREON_'),
  lemonsqueezy: key => key.startsWith('LEMONSQUEEZY_'),
  discord: key => key === 'DISCORD_APPLICATION_ID',
  boost: key => key === 'BOOST_TARGET_GUILD_ID',
};

/** Whether the credentials doc holds this key of this provider: a built-in provider's own key (decision 57). */
export function providerDocKey(providerId: string, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_PROVIDER_KEYS, providerId) && BUILTIN_PROVIDER_KEYS[providerId](key);
}

/** The credentials doc under /data/global: `{ "<providerId>": { "<KEY>": "<value>" | null } }`. */
export const PROVIDER_CREDENTIALS_FILE = 'payment-providers/credentials.json';

export function providerCredentialsPath(): string {
  return dataPath('global', ...PROVIDER_CREDENTIALS_FILE.split('/'));
}

/**
 * Reads a file as the data facade holds it: undefined when the path is no shared doc on this bot (a JSON bot), null
 * when there is none, the text otherwise; throws when it cannot be read. Set by dataManager.ts when it loads.
 */
export type SharedDocReader = (absPath: string) => string | null | undefined;

let sharedDocReader: SharedDocReader | null = null;

export function useSharedDocReader(read: SharedDocReader | null): void {
  sharedDocReader = read;
}

const causeOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `provider` names the provider when the cause is in its own entry, so only its keys read as not set. */
type DocEntry = { entry: Record<string, string | null> } | { unread: string; provider?: string };

/** The provider's entry of the doc: undefined when it has none, the cause when the doc or the entry cannot be read. */
function docEntry(read: SharedDocReader, providerId: string): DocEntry | undefined {
  let raw: string | null | undefined;
  try {
    raw = read(providerCredentialsPath());
  } catch (error) {
    return { unread: causeOf(error) };
  }
  if (raw === undefined || raw === null) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { unread: 'it is not valid JSON' };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { unread: 'it holds no object' };
  if (!Object.prototype.hasOwnProperty.call(doc, providerId)) return undefined;
  const entry = (doc as Record<string, unknown>)[providerId];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return { unread: `the entry of ${providerId} is not an object`, provider: providerId };
  for (const value of Object.values(entry)) {
    if (value !== null && typeof value !== 'string') return { unread: `a key of ${providerId} holds no text`, provider: providerId };
  }
  return { entry: entry as Record<string, string | null> };
}

/** The doc's entry for a built-in provider on this bot; undefined on a JSON bot, for a custom provider, or with no entry. */
function providerEntry(providerId: string): DocEntry | undefined {
  if (!Object.prototype.hasOwnProperty.call(BUILTIN_PROVIDER_KEYS, providerId)) return undefined;
  if (sharedDocReader) return docEntry(sharedDocReader, providerId);
  return resolveDataBackend() === 'postgres' ? { unread: 'this process has not loaded the data layer' } : undefined;
}

const loggedUnread = new Set<string>();

const unreadWords = (read: { unread: string; provider?: string }): string =>
  `${PROVIDER_CREDENTIALS_FILE} cannot be read${read.provider ? ` for ${read.provider}` : ''} (${read.unread})`;

/**
 * Why the credentials doc cannot be read for this provider's keys ("<file> cannot be read (<cause>)", or "... cannot
 * be read for <provider> (<cause>)" for a cause in its own entry), or null when it can (or the provider reads none of
 * them from it): the premium tab says it can't confirm whether those keys are set.
 */
export function providerCredentialsUnread(providerId: string): string | null {
  const read = providerEntry(providerId);
  return read && 'unread' in read ? unreadWords(read) : null;
}

/**
 * The credentials a payment provider reads (NB6 decision 57, owner question 2's answer (a)): loadCredentials(), and on
 * a Postgres bot, for the six built-in providers, each of the provider's own keys that the credentials doc holds wins
 * (null means not set). A doc that cannot be read leaves those keys not set, so no key cleared there is taken from
 * /data/.env. Custom providers and a JSON bot read the environment alone.
 */
export function providerCredentials(providerId: string): BotCredentials {
  const credentials = loadCredentials();
  if (!Object.prototype.hasOwnProperty.call(BUILTIN_PROVIDER_KEYS, providerId)) return credentials;
  const owns = BUILTIN_PROVIDER_KEYS[providerId];
  const read = providerEntry(providerId);
  if (read !== undefined && 'unread' in read) {
    const words = unreadWords(read);
    if (!loggedUnread.has(words)) {
      loggedUnread.add(words);
      const whose = read.provider ? `the keys of ${read.provider}` : "the built-in providers' keys";
      console.error(`[Payment] ${words}; ${whose} read as not set until it can be read`);
    }
    for (const key of Object.keys(credentials)) {
      if (owns(key)) credentials[key] = undefined;
    }
    return credentials;
  }
  if (read === undefined) return credentials;
  for (const [key, value] of Object.entries(read.entry)) {
    if (!owns(key)) continue;
    credentials[key] = value === null || isPlaceholderValue(value) ? undefined : value;
  }
  return credentials;
}

/**
 * The built-in providers' keys this machine reads now (NB6F D6), as the credentials doc the premium tab's op writes:
 * `{ <id>: { <KEY>: <value> } }`, ids in the order of BUILTIN_PROVIDER_KEYS and keys sorted; null when none is set.
 * Throws when /data/.env cannot be read.
 */
export function providerKeysFromEnv(): { body: Buffer | null; keys: number } {
  const credentials = loadCredentials();
  const readError = credentialsReadError();
  if (readError) throw new Error(`${dataPath('.env')} cannot be read: ${readError}`);
  const doc: Record<string, Record<string, string>> = {};
  let keys = 0;
  for (const [id, owns] of Object.entries(BUILTIN_PROVIDER_KEYS)) {
    const owned = Object.keys(credentials).filter(k => owns(k) && typeof credentials[k] === 'string').sort();
    if (owned.length === 0) continue;
    doc[id] = Object.fromEntries(owned.map(k => [k, credentials[k] as string]));
    keys += owned.length;
  }
  return keys === 0 ? { body: null, keys: 0 } : { body: Buffer.from(JSON.stringify(doc, null, 2)), keys };
}

/** A key the container environment pins whose value a JSON bot would read otherwise than Postgres does. */
export interface PinnedKey {
  key: string;
  /** 'set': the doc's entry holds the key; 'doc': the doc cannot be read; 'entry': the provider's entry cannot be read. */
  kind: 'set' | 'doc' | 'entry';
  provider: string;
}

/** What a migration to JSON writes to /data/.env so each built-in provider reads what it reads on Postgres (NB6F D6). */
export interface EnvKeyPlan {
  changes: Record<string, string | null>;
  /** Each key removed because its provider's keys cannot be read, with that provider. */
  unread: Record<string, string>;
  /** The owned keys the doc's readable entries hold, strings and nulls. */
  held: number;
  /** The doc's cause when it cannot be read; each provider whose entry cannot be read, with its cause. */
  unreadDoc: string | null;
  unreadEntries: Array<{ provider: string; cause: string }>;
  pinned: PinnedKey[];
  /** /data/.env's text (lossy when it is not valid UTF-8; empty when it was not read or is absent). */
  text: string;
  utf8: boolean;
}

/**
 * The plan for the credentials doc's text (null: no row): with no entry in it, /data/.env is not read and nothing
 * changes. Throws when /data/.env cannot be read.
 */
export function providerKeysToEnv(docText: string | null): EnvKeyPlan {
  const plan: EnvKeyPlan = { changes: {}, unread: {}, held: 0, unreadDoc: null, unreadEntries: [], pinned: [], text: '', utf8: true };
  if (docText === null) return plan;
  const entries = Object.keys(BUILTIN_PROVIDER_KEYS)
    .map(id => [id, docEntry(() => docText, id)] as const)
    .filter((e): e is readonly [string, DocEntry] => e[1] !== undefined);
  if (entries.length === 0) return plan;
  const envPath = dataPath('.env');
  loadCredentials();
  const readError = credentialsReadError();
  if (readError) throw new Error(`${envPath} cannot be read: ${readError}`);
  let raw: Buffer | null = null;
  try {
    raw = fs.readFileSync(envPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new Error(`${envPath} cannot be read: ${causeOf(error)}`);
  }
  const strict = raw === null ? '' : envTextOf(raw);
  plan.utf8 = strict !== null;
  plan.text = strict ?? raw!.toString('utf8');
  const file = dotenv.parse(plan.text);
  for (const [id, read] of entries) {
    const owns = BUILTIN_PROVIDER_KEYS[id];
    if ('unread' in read) {
      if (read.provider) plan.unreadEntries.push({ provider: id, cause: read.unread });
      else plan.unreadDoc = read.unread;
      for (const key of Object.keys(file).filter(owns).sort()) {
        plan.changes[key] = null;
        plan.unread[key] = id;
      }
      for (const key of Object.keys(process.env).filter(owns).sort()) {
        if (isContainerPinned(key)) plan.pinned.push({ key, kind: read.provider ? 'entry' : 'doc', provider: id });
      }
      continue;
    }
    for (const [key, value] of Object.entries(read.entry)) {
      if (!owns(key)) continue;
      plan.held += 1;
      if (typeof value === 'string') {
        if (file[key] !== value) plan.changes[key] = value;
      } else if (hasOwn(file, key)) {
        plan.changes[key] = null;
      }
      const onPostgres = value === null || isPlaceholderValue(value) ? undefined : value;
      if (isContainerPinned(key) && process.env[key] !== onPostgres) plan.pinned.push({ key, kind: 'set', provider: id });
    }
  }
  return plan;
}

/**
 * Validates bot credentials
 */
export function validateCredentials(credentials: BotCredentials): CredentialValidation {
  const requiredFields = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'];
  const missing: string[] = [];

  for (const field of requiredFields) {
    if (!credentials[field] || credentials[field]?.trim() === '' || credentials[field] === 'REPLACE WITH YOUR DISCORD BOT TOKEN' || credentials[field] === 'REPLACE WITH YOUR DISCORD TEST SERVER ID' || credentials[field] === 'REPLACE WITH THE BOT CLIENT ID') {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    return {
      isValid: false,
      missing,
      reason: `Missing or invalid credentials: ${missing.join(', ')}`
    };
  }

  return { isValid: true, missing: [] };
}

/**
 * Saves credentials to /data/.env
 * @param credentials Credentials to save
 * @returns Success status
 */
export function saveCredentials(credentials: BotCredentials): { success: boolean; error?: string } {
  const dataEnvPath = dataPath('.env');

  try {
    // Ensure /data directory exists
    const dataDir = path.dirname(dataEnvPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Format as env file
    const envContent = Object.entries(credentials)
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    fs.writeFileSync(dataEnvPath, envContent + '\n', { encoding: 'utf-8' });
    console.log('[EnvLoader] Credentials saved to /data/.env');

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[EnvLoader] Error saving credentials:', errorMessage);
    return { success: false, error: errorMessage };
  }
}

/**
 * Gets masked credential status (for Web-UI display)
 * Never returns actual credential values for security
 */
export function getCredentialStatus(credentials: BotCredentials): Record<string, { set: boolean; value: string }> {
  return {
    DISCORD_TOKEN: {
      set: !!(credentials.DISCORD_TOKEN && credentials.DISCORD_TOKEN.length > 10 && !credentials.DISCORD_TOKEN.startsWith('REPLACE')),
      value: credentials.DISCORD_TOKEN && credentials.DISCORD_TOKEN.length > 10 && !credentials.DISCORD_TOKEN.startsWith('REPLACE') ? '[••••••••] (Set)' : '[Empty] (Not Set)'
    },
    CLIENT_ID: {
      set: !!(credentials.CLIENT_ID && credentials.CLIENT_ID.length > 10 && !credentials.CLIENT_ID.startsWith('REPLACE')),
      value: credentials.CLIENT_ID && credentials.CLIENT_ID.length > 10 && !credentials.CLIENT_ID.startsWith('REPLACE') ? '[••••••••] (Set)' : '[Empty] (Not Set)'
    },
    GUILD_ID: {
      set: !!(credentials.GUILD_ID && credentials.GUILD_ID.length > 10 && !credentials.GUILD_ID.startsWith('REPLACE')),
      value: credentials.GUILD_ID && credentials.GUILD_ID.length > 10 && !credentials.GUILD_ID.startsWith('REPLACE') ? '[••••••••] (Set)' : '[Empty] (Not Set)'
    },
    MAIN_GUILD_ID: {
      // Only "set" if explicitly configured AND different from GUILD_ID (not using fallback)
      set: !!(credentials.MAIN_GUILD_ID && credentials.MAIN_GUILD_ID.length > 10 &&
              !credentials.MAIN_GUILD_ID.startsWith('REPLACE') &&
              credentials.MAIN_GUILD_ID !== credentials.GUILD_ID),
      value: credentials.MAIN_GUILD_ID && credentials.MAIN_GUILD_ID.length > 10 && !credentials.MAIN_GUILD_ID.startsWith('REPLACE')
        ? credentials.MAIN_GUILD_ID === credentials.GUILD_ID
          ? '[Using GUILD_ID]'
          : `[${credentials.MAIN_GUILD_ID}] (Set)`
        : '[Empty] (Defaults to GUILD_ID)'
    },
    // OAuth Credentials (Optional)
    ENABLE_GUILD_WEBUI: {
      set: credentials.ENABLE_GUILD_WEBUI === 'true',
      value: credentials.ENABLE_GUILD_WEBUI === 'true' ? 'true' : 'false' // Return actual boolean as string for checkbox
    },
    DISCORD_CLIENT_ID: {
      set: !!(credentials.DISCORD_CLIENT_ID && credentials.DISCORD_CLIENT_ID.length > 10),
      value: credentials.DISCORD_CLIENT_ID && credentials.DISCORD_CLIENT_ID.length > 10 ? '[••••••••] (Set)' : '[Empty] (Not Set)'
    },
    DISCORD_CLIENT_SECRET: {
      set: !!(credentials.DISCORD_CLIENT_SECRET && credentials.DISCORD_CLIENT_SECRET.length > 10),
      value: credentials.DISCORD_CLIENT_SECRET && credentials.DISCORD_CLIENT_SECRET.length > 10 ? '[••••••••] (Set)' : '[Empty] (Not Set)'
    },
    OAUTH_CALLBACK_URL: {
      set: !!(credentials.OAUTH_CALLBACK_URL && credentials.OAUTH_CALLBACK_URL.length > 10),
      value: credentials.OAUTH_CALLBACK_URL || '[Empty] (Not Set)'
    },
    SESSION_SECRET: {
      set: !!(credentials.SESSION_SECRET && credentials.SESSION_SECRET.length > 10),
      value: credentials.SESSION_SECRET && credentials.SESSION_SECRET.length > 10 ? '[••••••••] (Set)' : '[Empty] (Not Set)'
    },
    // Data backend settings (standalone-editable)
    DATA_BACKEND: {
      set: !!(credentials.DATA_BACKEND && credentials.DATA_BACKEND.trim() !== ''),
      value: credentials.DATA_BACKEND && credentials.DATA_BACKEND.trim() !== '' ? credentials.DATA_BACKEND : 'file'
    },
    DATA_BACKEND_URL: {
      set: !!(credentials.DATA_BACKEND_URL && credentials.DATA_BACKEND_URL.length > 10),
      value: credentials.DATA_BACKEND_URL && credentials.DATA_BACKEND_URL.length > 10 ? '[••••••••] (Set)' : '[Empty] (Not Set)'
    },
    // Payment provider credentials are surfaced through the per-provider
    // /api/appstore/premium/providers/:id/credentials endpoint instead of
    // here; the Credentials tab no longer renders any provider fields.
  };
}
