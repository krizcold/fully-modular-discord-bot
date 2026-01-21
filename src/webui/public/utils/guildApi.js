// Guild API utilities - OAuth-based API calls for guild Web-UI

/**
 * Guild API base URL
 */
const GUILD_API_BASE = '/guild/api';

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
    const response = await fetch(`${GUILD_API_BASE}/panels/guilds`);
    return await response.json();
  },

  /**
   * Get list of guild panels
   */
  async getPanelList(guildId) {
    const response = await fetch(`${GUILD_API_BASE}/panels/list?guildId=${guildId}`);
    return await response.json();
  },

  /**
   * Get list of channels for a guild
   */
  async getChannels(guildId) {
    const response = await fetch(`${GUILD_API_BASE}/panels/channels?guildId=${guildId}`);
    return await response.json();
  },

  /**
   * Get list of roles for a guild
   */
  async getRoles(guildId) {
    const response = await fetch(`${GUILD_API_BASE}/panels/roles?guildId=${guildId}`);
    return await response.json();
  },

  /**
   * Execute a guild panel
   */
  async executePanel(panelId, guildId, channelId = null) {
    const response = await fetch(`${GUILD_API_BASE}/panels/execute`, {
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
    const response = await fetch(`${GUILD_API_BASE}/panels/button`, {
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
    const response = await fetch(`${GUILD_API_BASE}/panels/dropdown`, {
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
    const response = await fetch(`${GUILD_API_BASE}/panels/modal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ panelId, modalId, fields, guildId, channelId })
    });
    return await response.json();
  }
};
