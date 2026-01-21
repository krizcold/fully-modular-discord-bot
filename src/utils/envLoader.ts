// src/utils/envLoader.ts

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

export interface BotCredentials {
  DISCORD_TOKEN?: string;
  CLIENT_ID?: string;
  GUILD_ID?: string;
  MAIN_GUILD_ID?: string;
  AUTH_HASH?: string;
  // OAuth Configuration (Optional - for Guild Web-UI)
  ENABLE_GUILD_WEBUI?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  OAUTH_CALLBACK_URL?: string;
  SESSION_SECRET?: string;
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
    // OAuth fields
    ENABLE_GUILD_WEBUI: process.env.ENABLE_GUILD_WEBUI,
    DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
    OAUTH_CALLBACK_URL: process.env.OAUTH_CALLBACK_URL,
    SESSION_SECRET: process.env.SESSION_SECRET,
  };

  // Override with /data/.env if it exists (Web-UI managed)
  const dataEnvPath = '/data/.env';
  if (fs.existsSync(dataEnvPath)) {
    try {
      const dataEnv = dotenv.parse(fs.readFileSync(dataEnvPath));
      // Only override if docker-compose value is a placeholder
      for (const [key, value] of Object.entries(dataEnv)) {
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
  const dataEnvPath = '/data/.env';

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
    }
  };
}
