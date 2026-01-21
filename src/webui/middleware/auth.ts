// src/webui/middleware/auth.ts

import { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'crypto';

/**
 * Perform timing-safe comparison of two hash values
 * Prevents timing attacks by using constant-time comparison
 * @param provided - Hash provided by client
 * @param expected - Expected hash value
 * @returns true if hashes match, false otherwise
 */
function validateHashTimingSafe(provided: string | undefined, expected: string): boolean {
  if (!provided || provided.trim() === '') {
    return false;
  }

  try {
    // Use timing-safe comparison to prevent timing attacks
    // Hash both values to ensure equal length for comparison
    const providedBuffer = Buffer.from(createHash('sha256').update(provided).digest('hex'));
    const expectedBuffer = Buffer.from(createHash('sha256').update(expected).digest('hex'));

    return timingSafeEqual(providedBuffer, expectedBuffer);
  } catch (error) {
    console.error('[Auth] Error during hash validation:', error);
    return false;
  }
}

/**
 * Authentication middleware that validates AUTH_HASH
 * Development mode (NODE_ENV=development): Auth is bypassed
 * Production mode: Requires valid AUTH_HASH via query param or header
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const AUTH_HASH = process.env.AUTH_HASH;
  const isDevelopment = process.env.NODE_ENV === 'development';

  // Development mode: Skip auth entirely
  if (isDevelopment) {
    next();
    return;
  }

  // Production mode: Reject if hash is not set
  if (!AUTH_HASH || AUTH_HASH.trim() === '') {
    console.warn('[Auth] Request rejected - AUTH_HASH not configured');
    res.status(503).json({
      error: 'Service unavailable',
      message: 'Authentication system not configured. Please set AUTH_HASH environment variable.'
    });
    return;
  }

  // Get hash from query parameter or header
  const providedHash = req.query.hash as string || req.headers['x-auth-hash'] as string;

  // Validate hash using timing-safe comparison
  if (!validateHashTimingSafe(providedHash, AUTH_HASH)) {
    console.warn('[Auth] Unauthorized access attempt from', req.ip);
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or missing authentication hash'
    });
    return;
  }

  // Hash is valid, proceed
  next();
}

/**
 * Optional middleware for routes that don't require auth
 * Adds 'authenticated' flag to request object based on hash validation
 *
 * Note: This function is currently unused as all API routes now require authentication.
 * Kept for backward compatibility or future use cases.
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const AUTH_HASH = process.env.AUTH_HASH;

  if (!AUTH_HASH || AUTH_HASH.trim() === '') {
    // No auth configured, allow through
    (req as any).authenticated = false;
    next();
    return;
  }

  const providedHash = req.query.hash as string || req.headers['x-auth-hash'] as string;

  // Use timing-safe comparison for consistency
  if (validateHashTimingSafe(providedHash, AUTH_HASH)) {
    // Valid hash provided
    (req as any).authenticated = true;
  } else {
    // Invalid or no hash
    (req as any).authenticated = false;
  }

  next();
}
