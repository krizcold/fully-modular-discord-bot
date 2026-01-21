// OAuth Configuration - Discord OAuth setup with passport

import passport from 'passport';
import { Strategy as DiscordStrategy, Profile } from '@oauth-everything/passport-discord';
import { loadCredentials } from '../../utils/envLoader';

/**
 * Check if Guild Web-UI is enabled
 */
export function isGuildWebUIEnabled(): boolean {
  const credentials = loadCredentials();
  return credentials.ENABLE_GUILD_WEBUI === 'true';
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
  accessToken: string; // OAuth access token for Discord API calls
}

/**
 * Discord guild data from OAuth
 */
export interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: number;  // Discord returns this as a number (bitfield)
  features?: string[];  // Optional - Discord may not include this field
}

/**
 * Configure passport with Discord OAuth strategy
 */
export function configureOAuth(): void {
  const credentials = loadCredentials();

  // Only configure if Guild Web-UI is enabled
  if (!isGuildWebUIEnabled()) {
    console.log('[OAuth] Guild Web-UI disabled - OAuth not configured');
    return;
  }

  const clientID = credentials.DISCORD_CLIENT_ID;
  const clientSecret = credentials.DISCORD_CLIENT_SECRET;
  const callbackURL = credentials.OAUTH_CALLBACK_URL || 'http://localhost:3000/auth/discord/callback';

  if (!clientID || !clientSecret) {
    console.warn('[OAuth] Missing DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET - OAuth disabled');
    return;
  }

  // Configure Discord strategy
  passport.use(
    new DiscordStrategy(
      {
        clientID,
        clientSecret,
        callbackURL,
        scope: ['identify', 'guilds', 'guilds.members.read']
      },
      (accessToken: string, refreshToken: string, profile: Profile, done: any) => {
        // Transform Discord profile to our user format
        // Note: guilds are fetched separately via Discord API using the accessToken
        // Profile structure: profile.id, profile.username, profile.discriminator, profile.avatar, profile._raw
        const rawUser = profile._raw as any;

        const profileAny = profile as any;
        const user: DiscordUser = {
          id: profile.id || rawUser?.id,
          username: profile.username || rawUser?.username || rawUser?.global_name || 'Unknown',
          discriminator: profileAny.discriminator || rawUser?.discriminator || '0',
          avatar: profileAny.avatar || rawUser?.avatar || null,
          email: rawUser?.email,
          verified: rawUser?.verified,
          guilds: [],  // Guilds will be fetched separately using the accessToken
          accessToken: accessToken  // Store access token for Discord API calls
        };

        console.log('[OAuth] User authenticated:', user.username, `(${user.id})`);
        return done(null, user);
      }
    )
  );

  // Serialize user to session
  passport.serializeUser((user: any, done) => {
    done(null, user);
  });

  // Deserialize user from session
  passport.deserializeUser((user: any, done) => {
    done(null, user);
  });

  console.log('[OAuth] Discord OAuth configured successfully');
}
