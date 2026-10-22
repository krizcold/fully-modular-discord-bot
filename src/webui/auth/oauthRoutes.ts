// OAuth Routes - Discord OAuth authentication routes

import { Router, Request, Response } from 'express';
import passport from 'passport';
import { DiscordUser } from './oauthConfig';
import { getUserAdminGuilds, hasSystemAccess } from './permissionChecker';
import { clearUserCache } from './guildPermissionRefresher';
import { fireAccessLog } from '../utils/accessLog';
import { sessionSaveOutcome } from './fileSessionStore';

const router = Router();

/**
 * GET /auth/discord
 * Initiates Discord OAuth flow
 */
router.get('/discord', passport.authenticate('discord'));

/**
 * GET /auth/discord/callback
 * Discord OAuth callback handler
 */
router.get(
  '/discord/callback',
  passport.authenticate('discord', {
    failureRedirect: '/guild?error=auth_failed'
  }),
  (req: Request, res: Response) => {
    // Successful guild OAuth login -> access-log event (carries the Discord user).
    const u = req.user as DiscordUser | undefined;
    fireAccessLog({
      uiKind: 'guild',
      ip: req.ip || '',
      userAgent: String(req.headers['user-agent'] || ''),
      when: Date.now(),
      user: u ? { id: u.id, username: u.username } : undefined,
    });

    res.redirect('/guild');
  }
);

/**
 * GET /auth/logout
 * Logs out the user and destroys session
 * Also clears guild permission cache
 */
router.get('/logout', (req: Request, res: Response) => {
  // Get user ID before logout
  const userId = req.user ? (req.user as DiscordUser).id : null;

  const oldSession = req.session;

  // passport saves the session without the user, then regenerates (deleting the old file): the save decides.
  req.logout((err) => {
    const saved = oldSession ? sessionSaveOutcome(oldSession) : undefined;
    if (err) console.error('[OAuth] Logout error:', err);

    if (saved === 'refused' || (saved === undefined && err)) {
      return res.status(500).json({
        success: false,
        error: 'Failed to logout'
      });
    }
    if (saved === 'pending') {
      return res.status(202).json({
        success: false,
        error: 'Logout could not be confirmed'
      });
    }

    if (userId) {
      clearUserCache(userId);
    }
    res.clearCookie('smdb.sid');
    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  });
});

/**
 * GET /auth/me
 * Returns current user information
 */
router.get('/me', (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({
      success: false,
      authenticated: false
    });
  }

  const user = req.user as DiscordUser;
  const adminGuilds = getUserAdminGuilds(user);
  const systemAccess = hasSystemAccess(user);

  res.json({
    success: true,
    authenticated: true,
    user: {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar
    },
    permissions: {
      systemAccess,
      adminGuilds
    }
  });
});

/**
 * GET /auth/status
 * Simple authentication status check
 */
router.get('/status', (req: Request, res: Response) => {
  res.json({
    success: true,
    authenticated: req.isAuthenticated()
  });
});

export default router;
