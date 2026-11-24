// Guild Subscription Routes: Guild-owner subscription management via OAuth

import { Router, Request, Response } from 'express';
import { requireOAuth, requireGuildAccess } from '../auth/oauthMiddleware';
import { getPremiumManager } from '../../bot/internalSetup/utils/premiumManager';
import { guildHolder, holderWords, parseHolder, userHolder, type HolderKey } from '../../bot/internalSetup/utils/premiumHolder';
import { getPaymentRegistry } from '../../bot/internalSetup/utils/payment/paymentRegistry';
import type { PaymentProvider } from '../../bot/internalSetup/utils/payment/paymentTypes';
import type { LinkState } from '../../bot/internalSetup/utils/payment/patreonProvider';
import type { LinkResult } from '../../bot/internalSetup/utils/sharedOps';
import { loadCredentials } from '../../utils/envLoader';
import type { BotManager } from '../botManager';
import { SharedOpAnswered, sharedOpFailure, sharedOpRunner } from './hopFailure';

/** The Patreon provider's link pieces the member routes call (sheet P7, 4.2). */
interface PatreonLinkRoutes {
  linkBaseUrl(): string | null;
  linkStart(userId: string, holder: HolderKey): { url: string; nonce: string; expires: number };
  readLinkState(state: unknown): LinkState | null;
}

/** Tiny escaper for the Patreon pages' text. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c] || c);
}

/** The callback's page for the op's answer (PT16, PT17, PT18a, PT18c, PT18b, PT21). */
export function linkPage(result: unknown): { status: number; html: string } {
  const r = (result ?? {}) as Partial<LinkResult> & Record<string, any>;
  if (r.refused === 'linked-elsewhere') {
    return { status: 409, html: '<h2>Patreon account already linked</h2><p>This Patreon account is linked to another Discord account, so nothing was linked. That account unlinks it first.</p>' };
  }
  if (r.refused === 'other-account') {
    return { status: 409, html: '<h2>Another Patreon account is linked</h2><p>Your Discord account is already linked to another Patreon account, so nothing was linked. Unlink it first.</p>' };
  }
  if (r.refused === 'not-owner') {
    return { status: 403, html: "<h2>Not the server's owner</h2><p>Only the server's owner can back it with a Patreon pledge, and Discord names another user as its owner, so nothing was linked.</p>" };
  }
  if (r.refused === 'not-visible') {
    return { status: 403, html: '<h2>Patreon link not completed</h2><p>The bot is not in this server, or cannot see it, so it cannot check who owns it. Nothing was linked; add the bot to the server first.</p>' };
  }
  if (r.refused === 'cant-confirm-owner') {
    return { status: 503, html: `<h2>Patreon link not completed</h2><p>Can't confirm that you own this server: the bot could not ask Discord (${escapeHtml(String(r.reason ?? 'no reason given'))}). Nothing was linked; try again in a few minutes.</p>` };
  }
  const holder = parseHolder(r.linked);
  if (!holder || typeof r.where !== 'string') {
    return {
      status: 502,
      html: "<h2>Patreon link not confirmed</h2><p>Can't confirm whether your Patreon account was linked: the bot's answer did not say what it linked. "
        + 'Open your subscription page to see whether the link is there before you start it again.</p><p><a href="/guild">Back to the server page</a></p>',
    };
  }
  const where = escapeHtml(r.where);
  const soon = (reason: string) => `<p>Can't confirm the tier yet: ${escapeHtml(reason)}. The bot checks again within 10 minutes.</p>`;
  const hour = (reason: string) => `<p>Can't confirm the tier yet: ${escapeHtml(reason)}. The bot checks again within an hour; if the tier has not appeared by then, start the link again.</p>`;
  const parts = [`<h2>Patreon linked</h2><p>Your Patreon account now backs ${where}. The bot gives the tier your pledge pays for while Patreon shows it as paid.</p>`];
  const paid: Array<{ ptier: string; title: string }> = Array.isArray(r.paid) ? r.paid : [];
  const held: Array<{ ptier: string; tier: string; status: string }> = Array.isArray(r.held) ? r.held : [];
  const uncharged: string[] = Array.isArray(r.uncharged) ? r.uncharged : [];
  if (r.pledge === 'none') parts.push('<p>Patreon shows no paid pledge to this creator on your account now.</p>');
  else if (r.pledge === 'deferred') parts.push(r.recheck ? "<p>Patreon's answer may lag a recent change; the bot checks again within 10 minutes.</p>" : hour("Patreon's answer may lag a recent change"));
  else if (r.pledge === 'failed') parts.push((r.recheck ? soon : hour)(String(r.reason ?? 'Patreon did not answer')));
  else if (r.pledge === 'read') {
    if (r.trial) parts.push('<p>Patreon shows a free trial; the tier starts with its first charge.</p>');
    else if (paid.length === 0) parts.push('<p>Patreon shows no paid pledge to this creator on your account now.</p>');
    else {
      for (const h of held) {
        parts.push(h.status === 'active'
          ? `<p>${escapeHtml(h.tier)} is now active on ${where}.</p>`
          : `<p>${escapeHtml(h.tier)} is queued on ${where} behind a higher plan; Patreon keeps charging it.</p>`);
      }
      for (const p of paid) {
        if (held.some(h => h.ptier === p.ptier)) continue;
        if (uncharged.includes(p.ptier)) {
          parts.push(`<p>Patreon shows ${escapeHtml(p.title)} on your pledge but no paid charge for it yet, so the bot gives no tier for it on ${where} until Patreon shows a paid charge.</p>`);
          continue;
        }
        parts.push(`<p>Patreon shows ${escapeHtml(p.title)} as paid, but the bot gave no tier for it on ${where}; the bot's log says why (the tier may not be set up here, or ${where} already has a plan at that level).</p>`);
      }
    }
  } else parts.push(hour(String(r.reason ?? "Patreon's answer about your memberships could not be read")));
  if (holder.kind === 'guild') parts.push(`<p><a href="/guild/${encodeURIComponent(holder.id)}/subscription">Back to the server page</a></p>`);
  return { status: 200, html: parts.join('') };
}

export function createGuildSubscriptionRoutes(botManager: BotManager): Router {
  const shared = sharedOpRunner(botManager);
  const router = Router();

  /**
   * Unlinks the buyer's Patreon link at the holder, link first, and answers PT22 or PT22c by the records the unlink
   * run ended, or PT22b; a refused link save answers the failure, with nothing changed.
   */
  async function unlinkPatreon(res: Response, holder: HolderKey, buyerId: string): Promise<void> {
    const reply = await botManager.runSharedOp('premium.unlinkProviderAccount', { args: [holder, 'patreon', buyerId] });
    const backed = typeof reply?.ended === 'number' && reply.ended > 0;
    const words = holderWords(holder);
    if (reply?.ok && reply.result === false) {
      res.status(404).json({ success: false, error: 'This Patreon link is gone already; nothing changed.' });
      return;
    }
    if (reply?.ok) {
      res.json({ success: true, message: backed ? `Your Patreon account is unlinked, and its tier was removed from ${words}.` : 'Your Patreon account is unlinked; it gave no tier here, so nothing else changed.' });
      return;
    }
    if (reply?.partial) {
      res.json({ success: true, message: `Your Patreon account is unlinked, but can't confirm its tier was removed from ${words}: the save that ends it was not confirmed. The bot removes it within an hour.` });
      return;
    }
    const failure = sharedOpFailure(reply) ?? { status: 500, error: 'The Patreon link was not removed.' };
    res.status(failure.status).json({ success: false, error: failure.error });
  }

  function validateGuildId(guildId: string): boolean {
    return typeof guildId === 'string' &&
           /^[1-9][0-9]+$/.test(guildId) &&
           guildId.length >= 17 &&
           guildId.length <= 19;
  }

  const patreon = (): (PaymentProvider & Partial<PatreonLinkRoutes>) | undefined =>
    getPaymentRegistry().get('patreon') as (PaymentProvider & Partial<PatreonLinkRoutes>) | undefined;
  const NOT_CONFIGURED = '<h2>Patreon is not configured on this bot.</h2><p>Ask the host to set Patreon credentials.</p>';
  const sessionUser = (req: Request): string | null => {
    const id = (req.user as { id?: unknown } | undefined)?.id;
    return typeof id === 'string' && id && (typeof req.isAuthenticated !== 'function' || req.isAuthenticated()) ? id : null;
  };
  const originOf = (url: unknown): string | null => {
    try {
      return typeof url === 'string' && url ? new URL(url).origin : null;
    } catch {
      return null;
    }
  };

  /**
   * GET /guild/api/subscriptions/patreon/start?for=me|<guildId>
   * The signed-in Discord user starts a Patreon link for their own VIP or a server they own (sheet P7, 4.2 step 1):
   * a nonce, the holder and an expiry are kept in this session, and the browser goes to Patreon's authorize page. A
   * request whose Sec-Fetch-Site is cross-site is refused.
   */
  router.get('/patreon/start', (req: Request, res: Response) => {
    const provider = patreon();
    const base = provider?.linkBaseUrl?.() ?? null;
    if (!provider || !provider.linkStart || !provider.isConfigured() || !base) return res.status(503).type('html').send(NOT_CONFIGURED);
    const site = req.headers?.['sec-fetch-site'];
    if (typeof site === 'string' && site.trim().toLowerCase() === 'cross-site') {
      return res.status(403).type('html').send(
        "<h2>Patreon link not started</h2><p>This link was opened from another site, so nothing was linked. Copy the link into your browser's address bar and open it from there.</p>"
      );
    }
    const baseUrl = new URL(base);
    // Cookies are kept per host name, not per port; behind a trusted proxy req.hostname is the forwarded one.
    if (req.hostname !== baseUrl.hostname) return res.redirect(`${baseUrl.origin}${req.originalUrl}`);
    const signIn = originOf(loadCredentials().OAUTH_CALLBACK_URL);
    if (signIn !== null && signIn !== baseUrl.origin) {
      return res.status(503).type('html').send(
        `<h2>Patreon linking is not set up correctly</h2><p>This bot's Discord sign-in returns to ${escapeHtml(signIn)}, but Patreon links return to ${escapeHtml(baseUrl.origin)}, so a link cannot complete. ` +
        `The bot's operator sets OAUTH_CALLBACK_URL and WEBUI_BASE_URL to the same address. Nothing was linked.</p>`
      );
    }
    const user = sessionUser(req);
    if (!user) return res.redirect('/auth/discord');
    const pick = req.query.for;
    const holder = pick === 'me' ? userHolder(user) : typeof pick === 'string' && validateGuildId(pick) ? guildHolder(pick) : null;
    if (!holder || !req.session) {
      return res.status(400).type('html').send('<h2>Patreon link not started</h2><p>The link names neither your own VIP nor a server, so nothing was linked.</p>');
    }
    const started = provider.linkStart(user, holder);
    (req.session as unknown as Record<string, unknown>).patreonLink = { nonce: started.nonce, holder, expires: started.expires };
    res.redirect(started.url);
  });

  /**
   * GET /guild/api/subscriptions/patreon/callback
   * Patreon sends the browser back here after the member approves. The callback runs only in the session that started
   * the link, for that session's Discord user, once (4.2 step 2); the op then runs in the process that writes premium.
   * Registered before the `/:guildId` routes, whose parameter would match it.
   */
  router.get('/patreon/callback', async (req: Request, res: Response) => {
    const provider = patreon();
    if (!provider || !provider.handleOAuthCallback || !provider.readLinkState) return res.status(503).type('html').send(NOT_CONFIGURED);
    const session = req.session as unknown as Record<string, any> | undefined;
    const pending = session?.patreonLink;
    const user = sessionUser(req);
    const state = provider.readLinkState(req.query.state);
    if (session) delete session.patreonLink;
    if (!user || !pending || !state || state.u !== user || state.n !== pending.nonce || state.h !== pending.holder
      || state.x !== pending.expires || !(state.x > Date.now())) {
      return res.status(400).type('html').send(
        '<h2>Patreon link not completed</h2><p>This link was started from another sign-in, more than 10 minutes ago, or was already used, so nothing was linked. ' +
        'Sign in with Discord on this site and start the link again.</p>'
      );
    }
    const reply = await botManager.runSharedOp('payment.oauthCallback', { providerId: 'patreon', query: req.query, userId: user });
    if (reply?.noAnswer) {
      return res.status(504).type('html').send(
        "<h2>Patreon link not confirmed</h2><p>Can't confirm whether your Patreon account was linked: the bot did not answer in time. " +
        'Start the link again in a minute; if the first one was saved, nothing changes twice.</p>'
      );
    }
    if (!reply?.ok && reply?.code === 'unconfirmed') {
      const failure = sharedOpFailure(reply) ?? { status: 503, error: 'premium did not confirm the save' };
      return res.status(failure.status).type('html').send(
        "<h2>Patreon link not confirmed</h2><p>Can't confirm whether your Patreon account was linked: premium did not confirm every save.</p>" +
        `<p>${escapeHtml(failure.error)}</p><p>Open your subscription page to see whether the link is there before you start it again.</p>` +
        '<p><a href="/guild">Back to the server page</a></p>'
      );
    }
    if (!reply?.ok) {
      const failure = sharedOpFailure(reply) ?? { status: 500, error: 'Patreon callback failed' };
      return res.status(reply?.code === 'invalid' ? 400 : failure.status).type('html').send(
        `<h2>Patreon link failed</h2><p>${escapeHtml(failure.error)}</p>` +
        `<p><a href="/guild">Back to the server page</a></p>`
      );
    }
    const page = linkPage(reply.result);
    res.status(page.status).type('html').send(page.html);
  });

  /**
   * DELETE /guild/api/subscriptions/patreon/link
   * The signed-in member unlinks their own Patreon account, whatever holder it backs (4.7); its records there end.
   */
  router.delete('/patreon/link', requireOAuth, async (req: Request, res: Response) => {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ success: false, error: 'Authentication required' });
    const found = Object.entries(getPremiumManager().getFullConfig().providerAccountLinks?.patreon ?? {}).find(([, link]) => link.buyerId === user);
    if (!found) return res.status(404).json({ success: false, error: 'Your Discord account has no Patreon link.' });
    await unlinkPatreon(res, found[1].holder, user);
  });

  /**
   * GET /guild/api/subscriptions/:guildId
   * Returns: { success, subscriptions, effective, tiers, providers, registeredProviders }
   * Guild admins (Manage Server) only.
   */
  router.get('/:guildId', requireOAuth, requireGuildAccess, (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      const mgr = getPremiumManager();
      const subscriptions = mgr.getSubscriptionsFollowed(guildHolder(guildId));
      const resolved = mgr.resolveActiveTier(guildId);
      const tiers = mgr.getAllTiers('guild');
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
        registeredProviders: registry.listAll().map(p => p.id),
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
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
      if (error instanceof SharedOpAnswered) return;
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
      const buyerId = (req.user as any)?.id;
      const result = await shared(res, 'premium.initiatePaidSubscription', [guildHolder(guildId), tierId, offeringId, {
        providerId,
        variantId,
        couponCode,
        buyerId,
        autoRenewOptOut: !!autoRenewOptOut,
        buyerSignedIn: true,
      }]);
      res.json({
        success: true,
        result,
        subscriptions: mgr.getSubscriptions(guildHolder(guildId)),
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
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
      const success = await shared(res, 'premium.cancelPaidSubscription', [guildHolder(guildId)]);
      res.json({ success, subscriptions: mgr.getSubscriptions(guildHolder(guildId)) });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
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
      const success = await shared(res, 'premium.reactivatePaidSubscription', [guildHolder(guildId)]);
      res.json({ success, subscriptions: mgr.getSubscriptions(guildHolder(guildId)) });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
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
      const success = await shared(res, 'premium.cancelPaidSubscriptionImmediately', [guildHolder(guildId)]);
      if (!success) {
        return res.status(404).json({ success: false, error: 'No active paid subscription to expire' });
      }
      res.json({ success, subscriptions: mgr.getSubscriptions(guildHolder(guildId)) });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
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
      const orphans = await mgr.findOrphansFor(guildHolder(guildId));
      res.json({ success: true, orphans });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
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
      await shared(res, 'premium.adoptOrphan', [guildHolder(guildId), providerId, providerSubId, req.body?.plan]);
      res.json({ success: true, subscriptions: mgr.getSubscriptions(guildHolder(guildId)) });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
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
      await shared(res, 'premium.cancelOrphan', [providerId, providerSubId]);
      res.json({ success: true });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  /**
   * POST /guild/api/subscriptions/:guildId/paid/billing-portal
   * Opens the provider's portal for the active paid subscription's payer, through the read-only op
   * payment.billingPortal, and returns the redirect URL. The return address is always this server's page.
   */
  router.post('/:guildId/paid/billing-portal', requireOAuth, requireGuildAccess, async (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      const mgr = getPremiumManager();
      const subs = mgr.getSubscriptions(guildHolder(guildId));
      const active = subs.active;
      if (!active || active.source !== 'paid' || !active.providerId || !active.providerSubId) {
        return res.status(404).json({ success: false, error: 'No active paid subscription on this guild' });
      }
      const buyerId = (req.user as any)?.id;
      if (typeof buyerId !== 'string' || active.buyerId !== buyerId) {
        return res.status(403).json({ success: false, error: 'Only the member who pays for this subscription can open its billing portal.' });
      }
      const returnUrl = `${req.protocol}://${req.get('host')}/guild/${encodeURIComponent(guildId)}/subscription`;
      const reply = await botManager.runSharedOp('payment.billingPortal', {
        providerId: active.providerId, providerSubId: active.providerSubId, returnUrl, buyerId,
      });
      if (reply?.ok && typeof reply.result?.portalUrl === 'string') {
        return res.json({ success: true, portalUrl: reply.result.portalUrl });
      }
      if (reply?.noAnswer) {
        return res.status(503).json({ success: false, error: 'The billing portal did not open: the bot did not answer in time. Try again.' });
      }
      if (reply?.refreshFailed) {
        const cause = typeof reply.error === 'string' ? reply.error.trim().replace(/\.+$/, '') : 'unknown cause';
        return res.status(503).json({ success: false, error: `The billing portal did not open: the bot could not bring its billing records up to date (${cause}).` });
      }
      const failure = sharedOpFailure(reply) ?? { status: 500, error: 'The billing portal did not open: the bot gave no portal address.' };
      res.status(failure.status).json({ success: false, error: failure.error });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
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
      const success = await shared(res, 'premium.cancelAndRemovePausedSubscription', [guildHolder(guildId), subscriptionId]);
      if (!success) {
        return res.status(404).json({ success: false, error: 'No paused subscription matched that id' });
      }
      res.json({ success, subscriptions: mgr.getSubscriptions(guildHolder(guildId)) });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * DELETE /guild/api/subscriptions/:guildId/provider-links/:providerId
   * Clears this server's external-account link for a provider, link first, and ends the paid subscriptions it backed
   * there, queued ones too. A Patreon link is unlinked only by the member who linked it (sheet P7, 4.7).
   */
  router.delete('/:guildId/provider-links/:providerId', requireOAuth, requireGuildAccess, async (req: Request, res: Response) => {
    try {
      const { guildId, providerId } = req.params;
      if (!validateGuildId(guildId)) {
        return res.status(400).json({ success: false, error: 'Invalid guild ID' });
      }
      if (providerId === 'patreon') {
        const user = sessionUser(req);
        const holder = guildHolder(guildId);
        const here = Object.entries(getPremiumManager().getFullConfig().providerAccountLinks?.patreon ?? {}).filter(([, link]) => link.holder === holder);
        if (here.length === 0) return res.status(404).json({ success: false, error: `No ${providerId} link on this guild` });
        const found = here.find(([, link]) => link.buyerId === user);
        if (!user || !found) return res.status(403).json({ success: false, error: 'Only the member who linked this Patreon pledge can unlink it.' });
        return await unlinkPatreon(res, holder, user);
      }
      const unlinked = await shared(res, 'premium.unlinkProviderAccount', [guildHolder(guildId), providerId]);
      if (!unlinked) {
        return res.status(404).json({ success: false, error: `No ${providerId} link on this guild` });
      }
      res.json({ success: true });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
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
      const holder = guildHolder(guildId);
      const all = mgr.getPendingMigrationsFor(holder);
      // Strip other-guild decisions before returning so we don't leak the
      // affected-guild list to one guild owner.
      const filtered = all.map(m => ({
        ...m,
        decisions: m.decisions.filter(d => d.holder === holder),
      }));
      res.json({ success: true, migrations: filtered });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * PUT /guild/api/subscriptions/:guildId/migrations/:migrationId
   * Body: { decision: 'accepted' | 'declined' }
   */
  router.put('/:guildId/migrations/:migrationId', requireOAuth, requireGuildAccess, async (req: Request, res: Response) => {
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
      const ok = await shared(res, 'premium.recordMigrationDecision', [migrationId, guildHolder(guildId), decision]);
      if (!ok) return res.status(404).json({ success: false, error: 'No matching pending migration for this guild' });
      res.json({ success: true });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
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
  router.put('/:guildId/notifications-channel', requireOAuth, requireGuildAccess, async (req: Request, res: Response) => {
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
      await shared(res, 'premium.setNotificationsChannelId', [guildHolder(guildId), channelId]);
      res.json({ success: true, subscriptions: mgr.getSubscriptions(guildHolder(guildId)) });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  return router;
}
