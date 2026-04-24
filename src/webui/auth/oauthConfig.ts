// OAuth Configuration - Discord OAuth setup with passport

import passport from 'passport';
import { Strategy as DiscordStrategy, Profile } from '@oauth-everything/passport-discord';
import { loadCredentials } from '../../utils/envLoader';

/**
 * Check if Guild Web-UI is enabled.
 * Evaluated at call time; never cache the result. Credentials can be edited
 * at runtime via the Credentials panel without a restart.
 */
export function isGuildWebUIEnabled(): boolean {
  const credentials = loadCredentials();
  return credentials.ENABLE_GUILD_WEBUI === 'true';
}

/**
 * Check if OAuth has all required credentials to actually run.
 * Evaluated at call time.
 */
export function isOAuthConfigured(): boolean {
  const c = loadCredentials();
  return !!(c.DISCORD_CLIENT_ID && c.DISCORD_CLIENT_SECRET && c.OAUTH_CALLBACK_URL);
}

/** Serializers only need to be registered once per process. */
let serializersRegistered = false;

/** Remove any previously-registered Discord strategy from Passport. */
function unregisterDiscordStrategy(): void {
  const strategies = (passport as any)._strategies;
  if (strategies && strategies.discord) {
    delete strategies.discord;
  }
}

/**
 * Discord OAuth user data
 */
export interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  avatar: string | null;
  email?: string;
  verified?: boolean;
  guilds?: DiscordGuild[];
  accessToken: string;              // OAuth access token for Discord API calls
  refreshToken?: string;            // Used to refresh accessToken before Discord API calls
  tokenExpiresAt?: number;          // Unix ms when accessToken is expected to expire
}

/**
 * Discord guild data from OAuth.
 * `permissions` is a bitfield that Discord returns as a string for newer
 * applications (the value can exceed Number.MAX_SAFE_INTEGER). Older
 * payloads may still return a number. Always normalize via BigInt before
 * bitwise operations. See permissionChecker.ts.
 */
export interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string | number;
  features?: string[];
}

/**
 * Configure (or reconfigure) Passport with the Discord OAuth strategy.
 *
 * Idempotent: calling it multiple times is safe. It removes any previously
 * registered Discord strategy before installing a new one. Used both at boot
 * and when credentials change via the Credentials panel (hot-reload).
 *
 * If Guild Web-UI is disabled or credentials are missing, any existing
 * strategy is unregistered and the function returns without reinstalling.
 * Routes that depend on the strategy should gate with `requireGuildWebUIEnabled`.
 */
export function configureOAuth(): void {
  const credentials = loadCredentials();

  if (!isGuildWebUIEnabled()) {
    unregisterDiscordStrategy();
    console.log('[OAuth] Guild Web-UI disabled; Discord strategy unregistered');
    return;
  }

  const clientID = credentials.DISCORD_CLIENT_ID;
  const clientSecret = credentials.DISCORD_CLIENT_SECRET;
  const callbackURL = credentials.OAUTH_CALLBACK_URL;

  if (!clientID || !clientSecret || !callbackURL) {
    unregisterDiscordStrategy();
    console.warn('[OAuth] Missing DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / OAUTH_CALLBACK_URL; Discord strategy unregistered');
    return;
  }

  // Register the strategy (replaces any existing one)
  passport.use(
    new DiscordStrategy(
      {
        clientID,
        clientSecret,
        callbackURL,
        scope: ['identify', 'guilds', 'guilds.members.read']
      },
      (accessToken: string, refreshToken: string, profile: Profile, done: any) => {
        const rawUser = profile._raw as any;
        const profileAny = profile as any;
        const user: DiscordUser = {
          id: profile.id || rawUser?.id,
          username: profile.username || rawUser?.username || rawUser?.global_name || 'Unknown',
          discriminator: profileAny.discriminator || rawUser?.discriminator || '0',
          avatar: profileAny.avatar || rawUser?.avatar || null,
          email: rawUser?.email,
          verified: rawUser?.verified,
          guilds: [],
          accessToken,
          refreshToken,
          // Discord access tokens expire in 7 days. Store so we can refresh proactively.
          tokenExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        };

        console.log('[OAuth] User authenticated:', user.username, `(${user.id})`);
        return done(null, user);
      }
    )
  );

  // Serializers are process-global; only install once.
  if (!serializersRegistered) {
    passport.serializeUser((user: any, done) => done(null, user));
    passport.deserializeUser((user: any, done) => done(null, user));
    serializersRegistered = true;
  }

  console.log('[OAuth] Discord OAuth configured successfully');
}

/**
 * Alias for readability at callsites that re-apply credentials changes.
 */
export function reconfigureOAuth(): void {
  configureOAuth();
}
