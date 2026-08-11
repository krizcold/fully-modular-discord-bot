// Session Manager - file-backed session storage with in-memory fallback

import session from 'express-session';
import crypto from 'crypto';
import { loadCredentials } from '../../utils/envLoader';
import { FileSessionStore } from './fileSessionStore';

let sessionStore: FileSessionStore | undefined;
let sessionStoreConfigured = false;

/**
 * Last-resort fallback session secret. ensureDurableSessionSecret() persists
 * one to /data/.env at startup, so this only triggers when /data is not
 * writable; sessions then last for this process's lifetime only.
 */
let bootFallbackSecret: string | null = null;
function getBootFallbackSecret(): string {
  if (!bootFallbackSecret) {
    bootFallbackSecret = crypto.randomBytes(32).toString('hex');
    console.log('[SessionManager] Using an in-memory boot-time session secret (/data not writable?); sessions will not survive a restart.');
  }
  return bootFallbackSecret;
}

/**
 * Configure session store (file-backed, memory fallback when /data is not writable)
 */
export async function configureSessionStore(): Promise<session.Store | undefined> {
  if (sessionStoreConfigured) return sessionStore;
  sessionStoreConfigured = true;
  const store = new FileSessionStore();
  if (!store.probeOk) {
    store.stop();
    console.warn('[SessionManager] Session directory not writable - using in-memory session store; sessions will not survive a restart.');
    return undefined;
  }
  sessionStore = store;
  return sessionStore;
}

/** Stop the session store's sweep timer (clean shutdown). */
export function stopSessionStore(): void {
  sessionStore?.stop();
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
