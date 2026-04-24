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

  /** Initiate a paid subscription. Body: { tierId, offeringId, providerId, couponCode? } */
  async subscribePaid(guildId, tierId, offeringId, providerId, couponCode) {
    const response = await guildFetch(`${GUILD_API_BASE}/subscriptions/${guildId}/paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tierId,
        offeringId,
        providerId,
        ...(couponCode ? { couponCode } : {}),
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
   * Preview a coupon before subscribing. Returns { valid, effectText, reason }.
   * `tierId` is required so tier-restricted coupons validate correctly.
   */
  async previewCoupon(guildId, code, tierId) {
    const response = await guildFetch(`${GUILD_API_BASE}/subscriptions/${guildId}/coupon/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, tierId }),
    });
    return await response.json();
  },
};
