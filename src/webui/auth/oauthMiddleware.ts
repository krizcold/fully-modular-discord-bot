// OAuth Middleware - Request authentication and authorization middleware

import { Request, Response, NextFunction } from 'express';
import { DiscordUser } from './oauthConfig';
import { hasSystemAccess, hasGuildAccess } from './permissionChecker';
import { refreshUserGuilds } from './guildPermissionRefresher';

/**
 * Extend Express types
 */
declare global {
  namespace Express {
    interface User extends DiscordUser {}
  }
}

declare module 'express-session' {
  interface SessionData {
    returnTo?: string;
  }
}

/**
 * Middleware: Require OAuth authentication
 * Redirects to /auth/discord if not authenticated
 */
export function requireOAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.isAuthenticated()) {
    return next();
  }

  // Store original URL for redirect after login
  req.session.returnTo = req.originalUrl;

  res.status(401).json({
    success: false,
    error: 'Authentication required',
    redirectTo: '/auth/discord'
  });
  return;
}

/**
 * Middleware: Require system access (DEV_USER_IDS)
 * Returns 403 if user doesn't have system access
 */
export function requireSystemAccess(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated()) {
    res.status(401).json({
      success: false,
      error: 'Authentication required'
    });
    return;
  }

  const user = req.user as DiscordUser;

  if (!hasSystemAccess(user)) {
    res.status(403).json({
      success: false,
      error: 'System access required - this feature is owner-only'
    });
    return;
  }

  next();
}

/**
 * Middleware: Require guild access
 * Validates user has admin permissions for the specified guild
 * Guild ID can come from query, body, or params
 * Refreshes user permissions from Discord API before validating
 */
export function requireGuildAccess(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated()) {
    res.status(401).json({
      success: false,
      error: 'Authentication required'
    });
    return;
  }

  const user = req.user as DiscordUser;

  // Extract guild ID from request (try multiple sources)
  const guildId = req.params.guildId || req.query.guildId || req.body.guildId;

  if (!guildId) {
    res.status(400).json({
      success: false,
      error: 'Guild ID required'
    });
    return;
  }

  // Refresh user guilds from Discord API (with caching)
  refreshUserGuilds(user)
    .then(refreshedUser => {
      // Update user in session with fresh guild data
      req.user = refreshedUser;

      // Check guild access with refreshed permissions
      if (!hasGuildAccess(refreshedUser, guildId as string)) {
        res.status(403).json({
          success: false,
          error: 'Access denied - you must be an administrator of this guild'
        });
        return;
      }

      next();
    })
    .catch(error => {
      console.error('[requireGuildAccess] Error refreshing user guilds:', error);
      // On error, check with existing session data as fallback
      if (!hasGuildAccess(user, guildId as string)) {
        res.status(403).json({
          success: false,
          error: 'Access denied - you must be an administrator of this guild'
        });
        return;
      }

      next();
    });
}

/**
 * Middleware: Optional OAuth (doesn't require authentication)
 * Adds user to request if authenticated, but allows unauthenticated access
 */
export function optionalOAuth(req: Request, res: Response, next: NextFunction): void {
  // Always proceed, authentication is optional
  next();
}
