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

  /** Tiny escaper for the Patreon callback's text/html error pages. */
  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    } as Record<string, string>)[c] || c);
  }

  /**
   * GET /guild/api/subscriptions/patreon/callback
   * Public endpoint - Patreon redirects the user here after they authorize.
   * Must be registered BEFORE the `/:guildId` wildcard below or the param
   * match swallows it and `requireOAuth` blocks the inbound redirect (which
   * can't carry our session cookie cross-domain).
   *
   * Replay safety: the auth `code` is single-use at Patreon's end, so a
   * leaked URL can't be reused. The `state` parameter is decoded by the
   * provider and used purely for routing the install (guildId / tierId /
   * offeringId / variantId we encoded at initiate time).
   */
  router.get('/patreon/callback', async (req: Request, res: Response) => {
    const provider = getPaymentRegistry().get('patreon');
    if (!provider || !provider.handleOAuthCallback) {
      return res.status(503).type('html').send(
        '<h2>Patreon is not configured on this bot.</h2><p>Ask the host to set Patreon credentials.</p>'
      );
    }
    let result;
    try {
      result = await provider.handleOAuthCallback(req.query as Record<string, string>);
    } catch (err: any) {
      const msg = err?.message || 'Patreon callback failed';
      return res.status(400).type('html').send(
        `<h2>Patreon link failed</h2><p>${escapeHtml(msg)}</p>` +
        `<p><a href="javascript:history.back()">Go back</a></p>`
      );
    }

    const mgr = getPremiumManager();

    // Anti-duplicate: one Patreon account can't link to multiple guilds.
    // If a previous link exists on a different guild, surface the conflicting
    // guildId so the user knows where to take action, and link to the unlink
    // endpoint they can hit while signed in to the OTHER server's Web UI.
    const existing = mgr.getAccountLink(provider.id, result.externalAccountId);
    if (existing && existing !== result.guildId) {
      const unlinkPath = `/guild/${encodeURIComponent(existing)}/subscription`;
      return res.status(409).type('html').send(
        `<h2>Patreon account already linked elsewhere</h2>` +
        `<p>Your Patreon account is currently linked to Discord server <code>${escapeHtml(existing)}</code>. ` +
        `One Patreon account can only back one server's premium at a time.</p>` +
        `<p>Sign in to that server's subscription page and click "Unlink Patreon", then start the link flow here again:</p>` +
        `<p><a href="${unlinkPath}">Open the other server's subscription page</a></p>`
      );
    }
    mgr.linkAccount(provider.id, result.externalAccountId, result.guildId);

    // Install via the standard async-create event so stacking + audit
    // run through the same path as Stripe / LS webhook installs.
    getPaymentRegistry().emitEvent({
      type: 'subscription.created',
      providerId: provider.id,
      providerSubId: `patreon:${result.externalAccountId}:${result.guildId}`,
      guildId: result.guildId,
      tierId: result.tierId,
      offeringId: result.offeringId,
      variantId: result.variantId,
      state: result.state,
    });

    // Redirect back to the guild's subscription page; the ?subscribe=success
    // query triggers the neutral-processing-page poll from Stage 3 polish.
    res.redirect(`/guild/${encodeURIComponent(result.guildId)}/subscription?subscribe=success`);
  });

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
   * Body: { code, providerId, variantId? }
   * Forwards to the provider's validateCoupon for pre-checkout preview. The
   * provider is the source of truth for coupons (Stripe Promotion Codes,
   * Dummy's local registry, etc.); we just round-trip the code through it.
   */
  router.post('/:guildId/coupon/preview', requireOAuth, requireGuildAccess, async (req: Request, res: Response) => {
    try {
      const { code, providerId, variantId } = req.body || {};
      if (!code || typeof code !== 'string' || !code.trim()) {
        return res.status(400).json({ success: false, error: 'code is required' });
      }
      if (!providerId || typeof providerId !== 'string') {
        return res.status(400).json({ success: false, error: 'providerId is required' });
      }
      const provider = getPaymentRegistry().get(providerId);
      if (!provider) {
        return res.status(404).json({ success: false, error: `Provider '${providerId}' is not registered` });
      }
      if (!provider.capabilities.supportsCoupons || !provider.validateCoupon) {
        return res.json({
          success: true,
          valid: false,
          reason: `${provider.displayName} does not support coupons.`,
        });
      }
      const v = await provider.validateCoupon(code, typeof variantId === 'string' ? variantId : undefined);
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
   * Body: { tierId, offeringId, providerId, variantId, couponCode?, autoRenewOptOut? }
   * Initiates a paid subscription through the offering's provider.
   */
  router.post('/:guildId/paid', requireOAuth, requireGuildAccess, async (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      const { tierId, offeringId, providerId, variantId, couponCode, autoRenewOptOut } = req.body || {};
      if (!tierId || typeof tierId !== 'string') {
        return res.status(400).json({ success: false, error: 'tierId is required' });
      }
      if (!offeringId || typeof offeringId !== 'string') {
        return res.status(400).json({ success: false, error: 'offeringId is required' });
      }
      if (!providerId || typeof providerId !== 'string') {
        return res.status(400).json({ success: false, error: 'providerId is required' });
      }
      if (!variantId || typeof variantId !== 'string') {
        return res.status(400).json({ success: false, error: 'variantId is required' });
      }
      const mgr = getPremiumManager();
      const userId = (req.user as any)?.id;
      const result = await mgr.initiatePaidSubscription(guildId, tierId, offeringId, {
        providerId,
        variantId,
        couponCode,
        userId,
        autoRenewOptOut: !!autoRenewOptOut,
      });
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

  /**
   * POST /guild/api/subscriptions/:guildId/paid/expire-now
   * Force-expire the active paid subscription right now: drop the cache
   * record so the slot is free, hard-cancel at the provider, and let the
   * next paused entry resume.
   */
  router.post('/:guildId/paid/expire-now', requireOAuth, requireGuildAccess, async (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      const mgr = getPremiumManager();
      const success = await mgr.cancelPaidSubscriptionImmediately(guildId);
      if (!success) {
        return res.status(404).json({ success: false, error: 'No active paid subscription to expire' });
      }
      res.json({ success, subscriptions: mgr.getSubscriptions(guildId) });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * GET /guild/api/subscriptions/:guildId/orphans
   * List provider-side subscriptions for this guild that the local cache
   * doesn't track. Returns [] when state is consistent.
   */
  router.get('/:guildId/orphans', requireOAuth, requireGuildAccess, async (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      const mgr = getPremiumManager();
      const orphans = await mgr.findOrphansForGuild(guildId);
      res.json({ success: true, orphans });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * POST /guild/api/subscriptions/:guildId/orphans/:providerId/:providerSubId/adopt
   * Re-link a provider-side subscription into the local cache, routing
   * through the same install + stacking logic as a normal async install.
   */
  router.post('/:guildId/orphans/:providerId/:providerSubId/adopt', requireOAuth, requireGuildAccess, async (req: Request, res: Response) => {
    try {
      const { guildId, providerId, providerSubId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      const mgr = getPremiumManager();
      await mgr.adoptOrphan(guildId, providerId, providerSubId);
      res.json({ success: true, subscriptions: mgr.getSubscriptions(guildId) });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  /**
   * DELETE /guild/api/subscriptions/:guildId/orphans/:providerId/:providerSubId
   * Cancel a provider-side orphan. Local cache is unaffected.
   */
  router.delete('/:guildId/orphans/:providerId/:providerSubId', requireOAuth, requireGuildAccess, async (req: Request, res: Response) => {
    try {
      const { guildId, providerId, providerSubId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      const mgr = getPremiumManager();
      await mgr.cancelOrphan(providerId, providerSubId);
      res.json({ success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  /**
   * POST /guild/api/subscriptions/:guildId/paid/billing-portal
   * Body: { returnUrl?: string }
   * Create a hosted "manage subscription" portal session at the active
   * sub's provider and return the redirect URL.
   */
  router.post('/:guildId/paid/billing-portal', requireOAuth, requireGuildAccess, async (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      const mgr = getPremiumManager();
      const subs = mgr.getSubscriptions(guildId);
      const active = subs.active;
      if (!active || active.source !== 'paid' || !active.providerId || !active.providerSubId) {
        return res.status(404).json({ success: false, error: 'No active paid subscription on this guild' });
      }
      const provider = getPaymentRegistry().get(active.providerId);
      if (!provider || !provider.createBillingPortalSession) {
        return res.status(400).json({ success: false, error: `Provider '${active.providerId}' does not have a managed portal` });
      }
      const returnUrl = (req.body?.returnUrl && typeof req.body.returnUrl === 'string')
        ? req.body.returnUrl
        : `${req.protocol}://${req.get('host')}/guild?guildId=${encodeURIComponent(guildId)}`;
      const result = await provider.createBillingPortalSession(active.providerSubId, returnUrl);
      res.json({ success: true, portalUrl: result.portalUrl });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  /**
   * DELETE /guild/api/subscriptions/:guildId/paused/:subscriptionId
   * Cancel a paused (queued) subscription identified by its local id.
   * Works for both manual and paid paused entries; for paid the provider
   * is hard-cancelled before the queue entry is dropped.
   */
  router.delete('/:guildId/paused/:subscriptionId', requireOAuth, requireGuildAccess, async (req: Request, res: Response) => {
    try {
      const { guildId, subscriptionId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      if (!subscriptionId || typeof subscriptionId !== 'string') {
        return res.status(400).json({ success: false, error: 'subscriptionId is required' });
      }
      const mgr = getPremiumManager();
      const success = await mgr.cancelAndRemovePausedSubscription(guildId, subscriptionId);
      if (!success) {
        return res.status(404).json({ success: false, error: 'No paused subscription matched that id' });
      }
      res.json({ success, subscriptions: mgr.getSubscriptions(guildId) });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * DELETE /guild/api/subscriptions/:guildId/provider-links/:providerId
   * Clear this guild's external-account link for a provider (e.g. Patreon)
   * AND revoke any associated paid subs. Lets the guild owner free their
   * Patreon account so it can be linked to a different server.
   *
   * Walks paused subs too: anything backed by `providerId` is removed,
   * not just the active slot.
   */
  router.delete('/:guildId/provider-links/:providerId', requireOAuth, requireGuildAccess, async (req: Request, res: Response) => {
    try {
      const { guildId, providerId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      const mgr = getPremiumManager();
      // Find the externalAccountId by reverse-lookup over providerAccountLinks.
      const all = mgr.getFullConfig().providerAccountLinks?.[providerId] || {};
      const externalAccountId = Object.entries(all).find(([, gid]) => gid === guildId)?.[0];
      if (!externalAccountId) {
        return res.status(404).json({ success: false, error: `No ${providerId} link on this guild` });
      }
      mgr.unlinkAccount(providerId, externalAccountId);
      // Revoke any paid subs from this provider on this guild. Walk active
      // and paused; cancel-and-remove each.
      const subs = mgr.getSubscriptions(guildId);
      const targets: string[] = [];
      if (subs.active && subs.active.source === 'paid' && subs.active.providerId === providerId) {
        // Hard-cancel via the standard route so stacking + audit are uniform.
        await mgr.cancelPaidSubscriptionImmediately(guildId);
      }
      for (const p of (subs.paused || [])) {
        if (p.source === 'paid' && p.providerId === providerId && p.id) {
          targets.push(p.id);
        }
      }
      for (const subscriptionId of targets) {
        await mgr.cancelAndRemovePausedSubscription(guildId, subscriptionId);
      }
      res.json({ success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * GET /guild/api/subscriptions/:guildId/migrations
   * Pending migrations affecting this guild. Each entry includes the
   * decision the guild already recorded ('pending' until they choose).
   */
  router.get('/:guildId/migrations', requireOAuth, requireGuildAccess, (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      const mgr = getPremiumManager();
      const all = mgr.getPendingMigrationsForGuild(guildId);
      // Strip other-guild decisions before returning so we don't leak the
      // affected-guild list to one guild owner.
      const filtered = all.map(m => ({
        ...m,
        decisions: m.decisions.filter(d => d.guildId === guildId),
      }));
      res.json({ success: true, migrations: filtered });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * PUT /guild/api/subscriptions/:guildId/migrations/:migrationId
   * Body: { decision: 'accepted' | 'declined' }
   */
  router.put('/:guildId/migrations/:migrationId', requireOAuth, requireGuildAccess, (req: Request, res: Response) => {
    try {
      const { guildId, migrationId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      const decision = (req.body || {}).decision;
      if (decision !== 'accepted' && decision !== 'declined') {
        return res.status(400).json({ success: false, error: 'decision must be "accepted" or "declined"' });
      }
      const mgr = getPremiumManager();
      const ok = mgr.recordMigrationDecision(migrationId, guildId, decision);
      if (!ok) return res.status(404).json({ success: false, error: 'No matching pending migration for this guild' });
      res.json({ success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * PUT /guild/api/subscriptions/:guildId/notifications-channel
   * Body: { channelId: string | null }
   * Set or clear the per-guild fallback notifications channel. Empty string
   * or null means "use the guild's system channel". Validation of channel
   * existence is the bot's job at delivery time; we just persist the id.
   */
  router.put('/:guildId/notifications-channel', requireOAuth, requireGuildAccess, (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      const raw = (req.body || {}).channelId;
      const channelId: string | null = (raw === null || raw === undefined || raw === '')
        ? null
        : (typeof raw === 'string' && /^[0-9]{17,20}$/.test(raw) ? raw : '__INVALID__');
      if (channelId === '__INVALID__') {
        return res.status(400).json({ success: false, error: 'channelId must be a Discord channel id (17-20 digits) or null/empty to clear' });
      }
      const mgr = getPremiumManager();
      mgr.setNotificationsChannelId(guildId, channelId);
      res.json({ success: true, subscriptions: mgr.getSubscriptions(guildId) });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  return router;
}
