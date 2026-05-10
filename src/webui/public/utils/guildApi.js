// Guild API utilities - OAuth-based API calls for guild Web-UI

/**
 * Guild API base URL
 */
const GUILD_API_BASE = '/guild/api';

/**
 * fetch wrapper for guild-scoped API calls.
 * On 401 Unauthorized (session expired), redirect the user into the Discord
 * OAuth flow. The backend session stores req.originalUrl and sends the user
 * back here after login.
 *
 * Do NOT use this for `/auth/*` endpoints; those legitimately 401 when the
 * user isn't logged in, and the OAuthLogin screen renders the login button
 * based on that state.
 */
async function guildFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    console.warn('[guildApi] Session expired, redirecting to Discord OAuth');
    window.location.href = '/auth/discord';
    throw new Error('Session expired: redirecting to login');
  }
  if (response.status === 503) {
    // Guild Web-UI got disabled mid-session. Send user back to /guild which
    // renders the "Disabled" page with a link to the Main Web-UI.
    console.warn('[guildApi] Guild Web-UI disabled, redirecting');
    window.location.href = '/guild';
    throw new Error('Guild Web-UI is disabled');
  }
  return response;
}

/**
 * Guild API client
 */
const guildApi = {
  /**
   * Check authentication status
   */
  async checkAuth() {
    const response = await fetch('/auth/status');
    return await response.json();
  },

  /**
   * Get current user info
   */
  async getMe() {
    const response = await fetch('/auth/me');
    return await response.json();
  },

  /**
   * Logout
   */
  async logout() {
    const response = await fetch('/auth/logout');
    return await response.json();
  },

  /**
   * Get list of guilds user can access
   */
  async getGuilds() {
    const response = await guildFetch(`${GUILD_API_BASE}/panels/guilds`);
    return await response.json();
  },

  /**
   * Get list of guild panels
   */
  async getPanelList(guildId) {
    const response = await guildFetch(`${GUILD_API_BASE}/panels/list?guildId=${guildId}`);
    return await response.json();
  },

  /**
   * Get list of channels for a guild
   */
  async getChannels(guildId) {
    const response = await guildFetch(`${GUILD_API_BASE}/panels/channels?guildId=${guildId}`);
    return await response.json();
  },

  /**
   * Get list of roles for a guild
   */
  async getRoles(guildId) {
    const response = await guildFetch(`${GUILD_API_BASE}/panels/roles?guildId=${guildId}`);
    return await response.json();
  },

  /**
   * Execute a guild panel
   */
  async executePanel(panelId, guildId, channelId = null) {
    const response = await guildFetch(`${GUILD_API_BASE}/panels/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ panelId, guildId, channelId })
    });
    return await response.json();
  },

  /**
   * Handle button interaction
   */
  async handleButton(panelId, buttonId, guildId, channelId = null) {
    const response = await guildFetch(`${GUILD_API_BASE}/panels/button`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ panelId, buttonId, guildId, channelId })
    });
    return await response.json();
  },

  /**
   * Handle dropdown interaction
   */
  async handleDropdown(panelId, values, guildId, dropdownId, channelId = null) {
    const response = await guildFetch(`${GUILD_API_BASE}/panels/dropdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ panelId, values, guildId, dropdownId, channelId })
    });
    return await response.json();
  },

  /**
   * Handle modal submission
   */
  async handleModal(panelId, modalId, fields, guildId, channelId = null) {
    const response = await guildFetch(`${GUILD_API_BASE}/panels/modal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ panelId, modalId, fields, guildId, channelId })
    });
    return await response.json();
  },

  // ── Subscriptions ──

  /** Fetch current subscriptions + effective tier + tiers + providers for a guild */
  async getSubscription(guildId) {
    const response = await guildFetch(`${GUILD_API_BASE}/subscriptions/${guildId}`);
    return await response.json();
  },

  /** Initiate a paid subscription. Body: { tierId, offeringId, providerId, variantId, couponCode?, autoRenewOptOut? } */
  async subscribePaid(guildId, tierId, offeringId, providerId, variantId, couponCode, autoRenewOptOut) {
    const response = await guildFetch(`${GUILD_API_BASE}/subscriptions/${guildId}/paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tierId,
        offeringId,
        providerId,
        variantId,
        ...(couponCode ? { couponCode } : {}),
        ...(autoRenewOptOut ? { autoRenewOptOut: true } : {}),
      }),
    });
    return await response.json();
  },

  /** Cancel paid subscription (keeps remaining days) */
  async cancelPaidSubscription(guildId) {
    const response = await guildFetch(`${GUILD_API_BASE}/subscriptions/${guildId}/paid`, {
      method: 'DELETE',
    });
    return await response.json();
  },

  /** Reactivate a cancelled paid subscription while still active */
  async reactivatePaidSubscription(guildId) {
    const response = await guildFetch(`${GUILD_API_BASE}/subscriptions/${guildId}/paid/reactivate`, {
      method: 'POST',
    });
    return await response.json();
  },

  /**
   * Cancel + remove a paused (queued) subscription. `subscriptionId` is the
   * local id stored on the Subscription record (manual or paid alike); the
   * backend routes to provider.cancelSubscription for paid entries.
   */
  async cancelPausedSubscription(guildId, subscriptionId) {
    const response = await guildFetch(
      `${GUILD_API_BASE}/subscriptions/${guildId}/paused/${encodeURIComponent(subscriptionId)}`,
      { method: 'DELETE' },
    );
    return await response.json();
  },

  /** Force-expire the active paid subscription right now (loses remaining days) */
  async cancelPaidSubscriptionImmediately(guildId) {
    const response = await guildFetch(
      `${GUILD_API_BASE}/subscriptions/${guildId}/paid/expire-now`,
      { method: 'POST' },
    );
    return await response.json();
  },

  /** List provider-side subscriptions the local cache doesn't track. */
  async listOrphans(guildId) {
    const response = await guildFetch(`${GUILD_API_BASE}/subscriptions/${guildId}/orphans`);
    return await response.json();
  },

  /** Re-link an orphan into the local cache. */
  async adoptOrphan(guildId, providerId, providerSubId) {
    const response = await guildFetch(
      `${GUILD_API_BASE}/subscriptions/${guildId}/orphans/${encodeURIComponent(providerId)}/${encodeURIComponent(providerSubId)}/adopt`,
      { method: 'POST' },
    );
    return await response.json();
  },

  /** Cancel an orphan at the provider (no local cache change). */
  async cancelOrphan(guildId, providerId, providerSubId) {
    const response = await guildFetch(
      `${GUILD_API_BASE}/subscriptions/${guildId}/orphans/${encodeURIComponent(providerId)}/${encodeURIComponent(providerSubId)}`,
      { method: 'DELETE' },
    );
    return await response.json();
  },

  /**
   * Open a hosted "manage subscription" portal at the provider for the
   * active paid sub. Returns { portalUrl } that the caller redirects to.
   */
  async openBillingPortal(guildId, returnUrl) {
    const response = await guildFetch(
      `${GUILD_API_BASE}/subscriptions/${guildId}/paid/billing-portal`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(returnUrl ? { returnUrl } : {}),
      },
    );
    return await response.json();
  },

  /**
   * Preview a coupon before subscribing. Returns { valid, effectText, reason }.
   * Forwards to provider.validateCoupon (provider is source of truth in the
   * new model). `variantId` is optional but helps providers that tie coupons
   * to specific variants (e.g. LS).
   */
  async previewCoupon(guildId, providerId, code, variantId) {
    const response = await guildFetch(`${GUILD_API_BASE}/subscriptions/${guildId}/coupon/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        providerId,
        ...(variantId ? { variantId } : {}),
      }),
    });
    return await response.json();
  },

  /**
   * Set or clear the per-guild fallback notifications channel. Pass
   * channelId = null (or empty string) to clear and fall back to the
   * guild's system channel.
   */
  async setNotificationsChannel(guildId, channelId) {
    const response = await guildFetch(
      `${GUILD_API_BASE}/subscriptions/${guildId}/notifications-channel`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: channelId || null }),
      },
    );
    return await response.json();
  },

  /** List the bot-visible text channels for a guild. Used by the
   * notifications-channel picker in the subscription panel. */
  async listGuildChannels(guildId) {
    const response = await guildFetch(`/guild/api/panels/channels?guildId=${encodeURIComponent(guildId)}`);
    return await response.json();
  },

  /** Pending price/variant migrations affecting this guild. */
  async listPendingMigrations(guildId) {
    const response = await guildFetch(`${GUILD_API_BASE}/subscriptions/${guildId}/migrations`);
    return await response.json();
  },

  /** Accept or decline a scheduled migration. decision = 'accepted'|'declined'. */
  async recordMigrationDecision(guildId, migrationId, decision) {
    const response = await guildFetch(
      `${GUILD_API_BASE}/subscriptions/${guildId}/migrations/${encodeURIComponent(migrationId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      },
    );
    return await response.json();
  },

  /** Clear an external-account provider link (e.g. Patreon) and revoke any
   * subs backed by it. Used to free a Patreon account so it can be linked
   * to a different server. */
  async unlinkProvider(guildId, providerId) {
    const response = await guildFetch(
      `${GUILD_API_BASE}/subscriptions/${guildId}/provider-links/${encodeURIComponent(providerId)}`,
      { method: 'DELETE' },
    );
    return await response.json();
  },
};
