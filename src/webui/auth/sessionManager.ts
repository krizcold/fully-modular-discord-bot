// Session Manager - Handles session storage with Redis fallback to memory

import session from 'express-session';
const RedisStore = require('connect-redis').RedisStore;
import { createClient } from 'redis';
import crypto from 'crypto';
import { loadCredentials } from '../../utils/envLoader';

let sessionStore: session.Store | undefined;

/**
 * Stable-per-process fallback session secret, used only when the user has
 * not configured SESSION_SECRET. Generated once at first request and kept
 * for the bot process's lifetime so sessions stay valid within a single run.
 * Sessions WILL be invalidated on restart in this mode; set SESSION_SECRET
 * explicitly for cross-restart stability.
 */
let bootFallbackSecret: string | null = null;
function getBootFallbackSecret(): string {
  if (!bootFallbackSecret) {
    bootFallbackSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[SessionManager] SESSION_SECRET not set; generated a random boot-time secret. Sessions will not survive a bot restart. Set SESSION_SECRET in the Credentials panel for persistence.');
  }
  return bootFallbackSecret;
}

/**
 * Configure session store (Redis with memory fallback for dev)
 */
export async function configureSessionStore(): Promise<session.Store | undefined> {
  const credentials = loadCredentials();
  const redisUrl = credentials.REDIS_URL || 'redis://redis:6379';
  const isDev = process.env.NODE_ENV === 'development';

  try {
    console.log(`[SessionManager] Connecting to Redis at ${redisUrl}...`);

    const redisClient = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: isDev ? 3000 : 10000, // Shorter timeout in dev
        reconnectStrategy: (retries) => {
          if (retries > (isDev ? 2 : 10)) {
            console.error(`[SessionManager] Redis connection failed after ${retries} retries`);
            return false; // Stop retrying
          }
          return Math.min(retries * 100, 3000);
        }
      }
    });

    redisClient.on('error', (err) => {
      // Only log once, not on every retry
      if (!sessionStore) {
        console.error('[SessionManager] Redis error:', err.message);
      }
    });

    await redisClient.connect();

    // connect-redis v9 - RedisStore is the constructor
    sessionStore = new RedisStore({
      client: redisClient,
      prefix: 'smdb:sess:'
    });

    console.log('[SessionManager] Redis session store configured successfully');
    return sessionStore;
  } catch (error) {
    console.warn('[SessionManager] Redis not available - using memory store (sessions lost on restart)');
    if (!isDev) {
      console.warn('[SessionManager] Production without Redis: sessions will not persist across restarts');
    }
    return undefined; // Will use default memory store
  }
}

/**
 * Get session middleware configuration
 */
export async function getSessionMiddleware(): Promise<session.SessionOptions> {
  const credentials = loadCredentials();
  const sessionSecret = credentials.SESSION_SECRET || getBootFallbackSecret();

  const store = await configureSessionStore();

  return {
    store,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production', // HTTPS only in production
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      sameSite: 'lax'
    },
    name: 'smdb.sid' // Custom session cookie name
  };
}
