// src/utils/envLoader.ts

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import { dataPath } from './dataRoot';

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
  // Fleet / sharding control plane (Phase 1). Resolved in the bot child:
  // explicit BOT_NODE_ROLE wins; else MASTER_URL present = co-worker; else
  // standalone master.
  BOT_NODE_ROLE?: string;
  MASTER_URL?: string;
  /** Ordered comma-separated master candidate list (PLAN_STANDBY 3.4); MASTER_URL is the single-entry fallback. */
  MASTER_URLS?: string;
  /** '1' designates this co-worker as the backup master (promote surface). */
  FLEET_BACKUP_MASTER?: string;
  CONTROL_SECRET?: string;
  CONTROL_PORT?: string;
  FLEET_PUBLIC_URL?: string;
  NODE_NAME?: string;
  PIN_TEST_GUILD_SHARD?: string;
  FLEET_SHARD_COUNT?: string;
  FLEET_SHARD_CAPACITY?: string;
  TRANSFER_URL?: string;
  TRANSFER_PORT?: string;
  // OAuth Configuration (Optional - for Guild Web-UI)
  ENABLE_GUILD_WEBUI?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  OAUTH_CALLBACK_URL?: string;
  SESSION_SECRET?: string;
  // Data backend: file (default) | postgres, the Postgres connection string,
  // and the optional control-store location override.
  DATA_BACKEND?: string;
  DATA_BACKEND_URL?: string;
  /** Host-reachable form of DATA_BACKEND_URL, delivered to remote workers (same-host consumers cannot hairpin it). */
  DATA_BACKEND_PUBLIC_URL?: string;
  /** Container-name form as delivered, kept verbatim so this node can re-deliver the pair if it becomes master. */
  DATA_BACKEND_LOCAL_URL?: string;
  CONTROL_STORE_URL?: string;
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

/**
 * Loads environment variables with priority:
 * 1. Docker-compose environment variables (process.env)
 * 2. /data/.env file (overrides docker-compose if exists)
 *
 * This ensures CasaOS compatibility while allowing Web-UI to manage credentials.
 */
export function loadCredentials(): BotCredentials {
  // Helper to check if a value is a placeholder
  const isPlaceholder = (value?: string) => {
    if (!value) return true;
    const v = value.trim().toUpperCase();
    return v.startsWith('REPLACE WITH') ||
           v.startsWith('OPTIONAL') ||
           v === '' ||
           v.includes('WILL BE AUTO-GENERATED');
  };

  // Start with docker-compose env vars (CasaOS compatibility)
  const credentials: BotCredentials = {
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    CLIENT_ID: process.env.CLIENT_ID,
    GUILD_ID: process.env.GUILD_ID,
    MAIN_GUILD_ID: process.env.MAIN_GUILD_ID,
    // Fleet fields (flow to the bot child via the botManager env spread)
    BOT_NODE_ROLE: process.env.BOT_NODE_ROLE,
    MASTER_URL: process.env.MASTER_URL,
    MASTER_URLS: process.env.MASTER_URLS,
    FLEET_BACKUP_MASTER: process.env.FLEET_BACKUP_MASTER,
    CONTROL_SECRET: process.env.CONTROL_SECRET,
    CONTROL_PORT: process.env.CONTROL_PORT,
    FLEET_PUBLIC_URL: process.env.FLEET_PUBLIC_URL,
    NODE_NAME: process.env.NODE_NAME,
    PIN_TEST_GUILD_SHARD: process.env.PIN_TEST_GUILD_SHARD,
    FLEET_SHARD_COUNT: process.env.FLEET_SHARD_COUNT,
    FLEET_SHARD_CAPACITY: process.env.FLEET_SHARD_CAPACITY,
    TRANSFER_URL: process.env.TRANSFER_URL,
    TRANSFER_PORT: process.env.TRANSFER_PORT,
    // OAuth fields
    ENABLE_GUILD_WEBUI: process.env.ENABLE_GUILD_WEBUI,
    DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
    OAUTH_CALLBACK_URL: process.env.OAUTH_CALLBACK_URL,
    SESSION_SECRET: process.env.SESSION_SECRET,
    DATA_BACKEND: process.env.DATA_BACKEND,
    DATA_BACKEND_URL: process.env.DATA_BACKEND_URL,
    DATA_BACKEND_PUBLIC_URL: process.env.DATA_BACKEND_PUBLIC_URL,
    DATA_BACKEND_LOCAL_URL: process.env.DATA_BACKEND_LOCAL_URL,
    CONTROL_STORE_URL: process.env.CONTROL_STORE_URL,
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
  if (fs.existsSync(dataEnvPath)) {
    try {
      const dataEnv = dotenv.parse(fs.readFileSync(dataEnvPath));
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
      // everywhere so e.g. a cleared MASTER_URLS stays cleared.
      for (const key of [...fileSeededEnvKeys]) {
        if (!(key in dataEnv)) {
          delete process.env[key];
          credentials[key] = undefined;
          fileSeededEnvKeys.delete(key);
        }
      }
      console.log('[EnvLoader] Loaded credentials from /data/.env');
    } catch (error) {
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

// Fleet-delivered backend decision (register reply; workers follow the master).
// Takes precedence over process env and /data/.env when set.
let fleetDataBackend: { backend: DataBackendKind; url?: string } | null = null;
let cachedEnvBackend: DataBackendKind | null = null;

export function setFleetDataBackend(info: { backend: DataBackendKind; url?: string } | null): void {
  fleetDataBackend = info;
}

/**
 * The deployment's data backend. Absent/empty DATA_BACKEND means file; any
 * value other than file/postgres refuses boot.
 */
export function resolveDataBackend(): DataBackendKind {
  if (fleetDataBackend) return fleetDataBackend.backend;
  if (cachedEnvBackend === null) {
    const raw = (loadCredentials().DATA_BACKEND || '').trim().toLowerCase();
    if (raw === '' || raw === 'file') cachedEnvBackend = 'file';
    else if (raw === 'postgres') cachedEnvBackend = 'postgres';
    else throw new Error(`[EnvLoader] Invalid DATA_BACKEND value "${raw}" (expected "file" or "postgres")`);
  }
  return cachedEnvBackend;
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
 * Upsert exactly the given keys into /data/.env, preserving every other line
 * verbatim (saveCredentials would freeze compose-provided values into the
 * file). Atomic temp + rename. Used by the master-delivered backend apply.
 */
export function upsertCredentials(patch: Record<string, string>): { success: boolean; error?: string } {
  const dataEnvPath = dataPath('.env');
  try {
    fs.mkdirSync(path.dirname(dataEnvPath), { recursive: true });
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(dataEnvPath, 'utf-8').split(/\r?\n/);
    } catch { /* no file yet */ }
    const remaining = new Set(Object.keys(patch));
    const updated = lines.map(line => {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
      if (match && remaining.has(match[1])) {
        remaining.delete(match[1]);
        return `${match[1]}=${patch[match[1]]}`;
      }
      return line;
    });
    while (updated.length > 0 && updated[updated.length - 1] === '') updated.pop();
    for (const key of remaining) updated.push(`${key}=${patch[key]}`);
    const tmp = `${dataEnvPath}.tmp`;
    fs.writeFileSync(tmp, updated.join('\n') + '\n', { encoding: 'utf-8' });
    fs.renameSync(tmp, dataEnvPath);
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[EnvLoader] Error upserting credentials:', errorMessage);
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
    CONTROL_STORE_URL: {
      set: !!(credentials.CONTROL_STORE_URL && credentials.CONTROL_STORE_URL.length > 10),
      value: credentials.CONTROL_STORE_URL && credentials.CONTROL_STORE_URL.length > 10 ? '[••••••••] (Set)' : '[Empty] (Not Set)'
    },
    // Payment provider credentials are surfaced through the per-provider
    // /api/appstore/premium/providers/:id/credentials endpoint instead of
    // here; the Credentials tab no longer renders any provider fields.
  };
}
