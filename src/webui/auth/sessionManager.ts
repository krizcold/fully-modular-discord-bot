// Session Manager - Handles session storage with Redis fallback to memory

import session from 'express-session';
const RedisStore = require('connect-redis').RedisStore;
import { createClient } from 'redis';
import { loadCredentials } from '../../utils/envLoader';

let sessionStore: session.Store | undefined;

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
    if (isDev) {
      console.warn('[SessionManager] Redis not available - using memory store (sessions lost on restart)');
      return undefined; // Will use default memory store
    }
    console.error('[SessionManager] Failed to connect to Redis:', error);
    console.error('[SessionManager] Redis is required for Guild Web-UI in production');
    throw new Error('Redis connection failed - Guild Web-UI will not work');
  }
}

/**
 * Get session middleware configuration
 */
export async function getSessionMiddleware(): Promise<session.SessionOptions> {
  const credentials = loadCredentials();
  const sessionSecret = credentials.SESSION_SECRET || 'default-secret-change-in-production';

  if (!credentials.SESSION_SECRET) {
    console.warn('[SessionManager] WARNING: Using default SESSION_SECRET - set SESSION_SECRET env var for production');
  }

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
