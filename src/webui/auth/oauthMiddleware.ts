// OAuth Middleware - Request authentication and authorization middleware

import { Request, Response, NextFunction } from 'express';
import { DiscordUser, isGuildWebUIEnabled, isOAuthConfigured } from './oauthConfig';
import { hasSystemAccess, hasGuildAccess } from './permissionChecker';
import { refreshUserGuilds } from './guildPermissionRefresher';

/**
 * Middleware: Require the Guild Web-UI to be currently enabled AND OAuth configured.
 * Evaluated at request time so credentials can be added / removed via the
 * Credentials panel without restarting the bot.
 */
export function requireGuildWebUIEnabled(req: Request, res: Response, next: NextFunction): void {
  if (!isGuildWebUIEnabled()) {
    res.status(503).json({
      success: false,
      error: 'Guild Web-UI is currently disabled. Configure credentials in the Main Web-UI to enable it.'
    });
    return;
  }
  if (!isOAuthConfigured()) {
    res.status(503).json({
      success: false,
      error: 'Guild Web-UI is enabled but OAuth credentials are incomplete. Check DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and OAUTH_CALLBACK_URL.'
    });
    return;
  }
  next();
}

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

  // Refresh user guilds from Discord API (with caching) and persist the
  // refreshed user back into the session. We deliberately DO NOT use
  // req.login(): passport >= 0.6 regenerates the session ID on every
  // req.login() call (fixation protection), which races with parallel
  // requests (e.g. the guild-click triggers getPanelList + getSubscription
  // simultaneously) and leaves the client with a session cookie the server
  // doesn't recognise, looking like a spurious logout.
  refreshUserGuilds(user)
    .then(refreshedUser => new Promise<DiscordUser>((resolve, reject) => {
      const tokensChanged = refreshedUser.accessToken !== user.accessToken
        || refreshedUser.tokenExpiresAt !== user.tokenExpiresAt;
      const guildsChanged = refreshedUser.guilds !== user.guilds;
      if (!tokensChanged && !guildsChanged) {
        // Nothing changed: skip the session write entirely.
        resolve(refreshedUser);
        return;
      }
      // Mutate passport's session user in place, then persist.
      const sess = req.session as any;
      if (sess && sess.passport) sess.passport.user = refreshedUser;
      (req as any).user = refreshedUser;
      req.session.save((err) => err ? reject(err) : resolve(refreshedUser));
    }))
    .then(refreshedUser => {
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
      console.error('[requireGuildAccess] Error refreshing or re-saving user guilds:', error);
      // Fall back to the pre-refresh session user
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
