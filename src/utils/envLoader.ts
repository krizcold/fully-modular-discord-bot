// src/utils/envLoader.ts

import * as fs from 'fs';
import * as path from 'path';
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
  AUTH_HASH?: string;
  // Fleet / sharding control plane (Phase 1). Resolved in the bot child:
  // explicit BOT_NODE_ROLE wins; else MASTER_URL present = co-worker; else
  // standalone master.
  BOT_NODE_ROLE?: string;
  MASTER_URL?: string;
  CONTROL_SECRET?: string;
  CONTROL_PORT?: string;
  FLEET_PUBLIC_URL?: string;
  NODE_NAME?: string;
  PIN_TEST_GUILD_SHARD?: string;
  FLEET_SHARD_COUNT?: string;
  // OAuth Configuration (Optional - for Guild Web-UI)
  ENABLE_GUILD_WEBUI?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  OAUTH_CALLBACK_URL?: string;
  SESSION_SECRET?: string;
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
    AUTH_HASH: process.env.AUTH_HASH,
    // Fleet fields (flow to the bot child via the botManager env spread)
    BOT_NODE_ROLE: process.env.BOT_NODE_ROLE,
    MASTER_URL: process.env.MASTER_URL,
    CONTROL_SECRET: process.env.CONTROL_SECRET,
    CONTROL_PORT: process.env.CONTROL_PORT,
    FLEET_PUBLIC_URL: process.env.FLEET_PUBLIC_URL,
    NODE_NAME: process.env.NODE_NAME,
    PIN_TEST_GUILD_SHARD: process.env.PIN_TEST_GUILD_SHARD,
    FLEET_SHARD_COUNT: process.env.FLEET_SHARD_COUNT,
    // OAuth fields
    ENABLE_GUILD_WEBUI: process.env.ENABLE_GUILD_WEBUI,
    DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
    OAUTH_CALLBACK_URL: process.env.OAUTH_CALLBACK_URL,
    SESSION_SECRET: process.env.SESSION_SECRET,
    REDIS_URL: process.env.REDIS_URL,
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
        // so apply the saved value to process.env for direct readers (e.g. the
        // web-UI AUTH_HASH middleware).
        if (process.env[key] === undefined || process.env[key] === '') {
          process.env[key] = value;
        }
        if (isPlaceholder(credentials[key])) {
          credentials[key] = value;
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
    // Payment provider credentials are surfaced through the per-provider
    // /api/appstore/premium/providers/:id/credentials endpoint instead of
    // here; the Credentials tab no longer renders any provider fields.
  };
}
