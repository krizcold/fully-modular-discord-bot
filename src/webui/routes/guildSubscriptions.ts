// Guild Subscription Routes: Guild-owner subscription management via OAuth

import { Router, Request, Response } from 'express';
import { requireOAuth, requireGuildAccess } from '../auth/oauthMiddleware';
import { getPremiumManager } from '../../bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../bot/internalSetup/utils/payment/paymentRegistry';

export function createGuildSubscriptionRoutes(): Router {
  const router = Router();

  function validateGuildId(guildId: string): boolean {
    return typeof guildId === 'string' &&
           /^[0-9]+$/.test(guildId) &&
           guildId.length >= 17 &&
           guildId.length <= 19;
  }

  /**
   * GET /guild/api/subscriptions/:guildId
   * Returns: { success, subscriptions, effective, tiers, providers }
   * Guild admins (Manage Server) only.
   */
  router.get('/:guildId', requireOAuth, requireGuildAccess, (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      const mgr = getPremiumManager();
      const subscriptions = mgr.getSubscriptions(guildId);
      const resolved = mgr.resolveActiveTier(guildId);
      const tiers = mgr.getAllTiers();
      const activated = mgr.getActivatedProviders();
      const registry = getPaymentRegistry();
      // Only surface providers that are activated system-wide AND configured.
      // The guild owner can only pay through those.
      const providers = registry.listAll()
        .filter(p => !!activated[p.id] && p.isConfigured())
        .map(p => ({
          id: p.id,
          displayName: p.displayName,
          capabilities: p.capabilities,
        }));
      res.json({
        success: true,
        subscriptions,
        effective: { tierId: resolved.tierId, tier: resolved.tier, source: resolved.source },
        tiers,
        providers,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * POST /guild/api/subscriptions/:guildId/coupon/preview
   * Body: { code, tierId? }
   * Validates a coupon code without consuming it. Used by the subscribe modal
   * to show the discount effect before the user clicks Subscribe. Returns
   * only the effectText; never leaks percentOff/extraDays raw values so the
   * coupon definition itself stays admin-only. `tierId` is passed so
   * tier-restricted coupons validate against the actual target tier.
   */
  router.post('/:guildId/coupon/preview', requireOAuth, requireGuildAccess, (req: Request, res: Response) => {
    try {
      const { code, tierId } = req.body || {};
      if (!code || typeof code !== 'string' || !code.trim()) {
        return res.status(400).json({ success: false, error: 'code is required' });
      }
      const mgr = getPremiumManager();
      const v = mgr.validateCoupon(code, typeof tierId === 'string' ? tierId : undefined);
      res.json({
        success: true,
        valid: v.valid,
        effectText: v.effectText,
        reason: v.reason,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * POST /guild/api/subscriptions/:guildId/paid
   * Body: { tierId, offeringId, couponCode? }
   * Initiates a paid subscription through the offering's provider.
   */
  router.post('/:guildId/paid', requireOAuth, requireGuildAccess, async (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      const { tierId, offeringId, providerId, couponCode } = req.body || {};
      if (!tierId || typeof tierId !== 'string') {
        return res.status(400).json({ success: false, error: 'tierId is required' });
      }
      if (!offeringId || typeof offeringId !== 'string') {
        return res.status(400).json({ success: false, error: 'offeringId is required' });
      }
      if (!providerId || typeof providerId !== 'string') {
        return res.status(400).json({ success: false, error: 'providerId is required' });
      }
      const mgr = getPremiumManager();
      const userId = (req.user as any)?.id;
      const result = await mgr.initiatePaidSubscription(guildId, tierId, offeringId, { providerId, couponCode, userId });
      res.json({
        success: true,
        result,
        subscriptions: mgr.getSubscriptions(guildId),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * DELETE /guild/api/subscriptions/:guildId/paid
   * Cancel the paid subscription (autoRenew=false, keeps remaining days).
   */
  router.delete('/:guildId/paid', requireOAuth, requireGuildAccess, async (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      const mgr = getPremiumManager();
      const success = await mgr.cancelPaidSubscription(guildId);
      res.json({ success, subscriptions: mgr.getSubscriptions(guildId) });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * POST /guild/api/subscriptions/:guildId/paid/reactivate
   * Reactivate the paid subscription while still within its active window.
   */
  router.post('/:guildId/paid/reactivate', requireOAuth, requireGuildAccess, async (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      const mgr = getPremiumManager();
      const success = await mgr.reactivatePaidSubscription(guildId);
      res.json({ success, subscriptions: mgr.getSubscriptions(guildId) });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  return router;
}
