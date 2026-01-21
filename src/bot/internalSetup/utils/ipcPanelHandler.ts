// IPC Panel Handler - Handles IPC messages from Web-UI for panel operations

import { getPanelManager } from './panelManager';
import { getConfigProperty } from './configManager';

/**
 * Set up IPC message handlers for Web-UI panel integration
 */
export function setupPanelIPCHandlers(): void {
  if (!process.send) {
    console.warn('[IPCPanelHandler] process.send not available - IPC handlers not registered');
    return;
  }

  console.log('[IPCPanelHandler] Setting up IPC handlers for panel system');

  // Token bucket rate limiting: userId -> { tokens, lastRefill }
  // Configurable via config.json: system.rateLimit.bucketCapacity, system.rateLimit.refillRateMs
  const tokenBuckets = new Map<string, { tokens: number; lastRefill: number }>();

  function consumeToken(userId: string): boolean {
    const bucketCapacity = getConfigProperty<number>('system.rateLimit.bucketCapacity') || 5;
    const refillRateMs = getConfigProperty<number>('system.rateLimit.refillRateMs') || 1000;

    const now = Date.now();
    let bucket = tokenBuckets.get(userId);

    if (!bucket) {
      bucket = { tokens: bucketCapacity, lastRefill: now };
      tokenBuckets.set(userId, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = Math.floor(elapsed / refillRateMs);
    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(bucketCapacity, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now - (elapsed % refillRateMs);
    }

    if (bucket.tokens > 0) {
      bucket.tokens--;
      return true; // Allowed
    }
    return false; // Rate limited
  }

  // Cleanup old buckets periodically
  setInterval(() => {
    const now = Date.now();
    const maxAge = getConfigProperty<number>('system.rateLimit.cleanupAgeMs') || 300000;
    for (const [uid, bucket] of tokenBuckets.entries()) {
      if (now - bucket.lastRefill > maxAge) {
        tokenBuckets.delete(uid);
      }
    }
  }, 5 * 60 * 1000);


  process.on('message', async (message: any) => {
    // Validate message structure
    if (!validateMessage(message)) {
      return;
    }

    const { type, requestId, data } = message;
    const panelManager = getPanelManager();

    // Rate limiting check (skip for read-only operations that don't modify state)
    const readOnlyOperations = ['panel:list', 'dev:check', 'bot:guilds'];
    const shouldRateLimit = !readOnlyOperations.includes(type) && data && data.userId;

    if (shouldRateLimit) {
      if (!consumeToken(data.userId)) {
        console.warn(`[IPCPanelHandler] Rate limit exceeded for user ${data.userId}`);
        process.send!({
          requestId,
          data: {
            success: false,
            error: 'Rate limit exceeded. Please wait before trying again.'
          }
        });
        return;
      }
    }

    try {
      const response = await handleIPCMessage(type, data, panelManager);
      process.send!({ requestId, data: response });
    } catch (error) {
      console.error(`[IPCPanelHandler] Error handling IPC message ${type}:`, error);
      process.send!({
        requestId,
        data: {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  });
}

/**
 * Validate incoming IPC message structure
 */
function validateMessage(message: any): boolean {
  if (!message || typeof message !== 'object') {
    console.warn('[IPCPanelHandler] Received invalid IPC message: not an object');
    return false;
  }

  if (!message.type || !message.requestId) {
    console.warn('[IPCPanelHandler] Received malformed IPC message:', {
      hasType: !!message.type,
      hasRequestId: !!message.requestId
    });
    if (message.requestId) {
      process.send!({
        requestId: message.requestId,
        data: {
          success: false,
          error: 'Malformed IPC message: missing type or requestId'
        }
      });
    }
    return false;
  }

  return true;
}


/**
 * Handle IPC message and return response
 */
async function handleIPCMessage(type: string, data: any, panelManager: any): Promise<any> {
  switch (type) {
    case 'panel:list':
      return {
        success: true,
        panels: panelManager.getWebUIPanelList()
      };

    case 'panel:execute':
      if (!data || !data.panelId || !data.userId) {
        return {
          success: false,
          error: 'Missing required fields: panelId and userId'
        };
      }
      return await panelManager.executePanelForWebUI(data.panelId, data.userId, data.guildId || null, undefined, data.channelId || null);

    case 'panel:button':
      if (!data || !data.panelId || !data.buttonId || !data.userId) {
        return {
          success: false,
          error: 'Missing required fields: panelId, buttonId, and userId'
        };
      }
      return await panelManager.handleWebUIButton(data.panelId, data.buttonId, data.userId, data.guildId || null, undefined, data.channelId || null);

    case 'panel:dropdown':
      if (!data || !data.panelId || !data.values || !data.userId) {
        return {
          success: false,
          error: 'Missing required fields: panelId, values, and userId'
        };
      }
      if (!Array.isArray(data.values)) {
        return {
          success: false,
          error: 'Invalid field: values must be an array'
        };
      }
      return await panelManager.handleWebUIDropdown(data.panelId, data.values, data.userId, data.guildId || null, data.dropdownId, undefined, data.channelId || null);

    case 'panel:modal':
      if (!data || !data.panelId || !data.modalId || !data.fields || !data.userId) {
        return {
          success: false,
          error: 'Missing required fields: panelId, modalId, fields, and userId'
        };
      }
      if (typeof data.fields !== 'object') {
        return {
          success: false,
          error: 'Invalid field: fields must be an object'
        };
      }
      return await panelManager.handleWebUIModal(data.panelId, data.modalId, data.fields, data.userId, data.guildId || null, undefined, data.channelId || null);

    case 'dev:check':
      if (!data || !data.userId) {
        return {
          success: false,
          isDev: false,
          error: 'Missing required field: userId'
        };
      }
      try {
        // Get DEVS with correct priority (config.json > env > schema)
        const devs = getConfigProperty<(string | number)[]>('DEVS') || [];

        // Normalize both the userId and devs array to strings for comparison
        const userId = String(data.userId);
        const isDev = Array.isArray(devs) && devs.some(dev => String(dev) === userId);
        return {
          success: true,
          isDev: isDev
        };
      } catch (error) {
        console.error('[IPCPanelHandler] Error checking dev status:', error);
        return {
          success: false,
          isDev: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }

    case 'bot:guilds':
      try {
        const client = panelManager.getClient();
        if (!client || !client.guilds) {
          return {
            success: false,
            error: 'Bot client not available'
          };
        }

        // Get all guilds the bot is in
        const guilds = client.guilds.cache.map((guild: any) => ({
          id: guild.id,
          name: guild.name,
          icon: guild.icon,
          memberCount: guild.memberCount
        }));

        return {
          success: true,
          guilds
        };
      } catch (error) {
        console.error('[IPCPanelHandler] Error getting bot guilds:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }

    case 'guild:channels':
      if (!data || !data.guildId) {
        return {
          success: false,
          error: 'Missing required field: guildId'
        };
      }
      try {
        const client = panelManager.getClient();
        if (!client || !client.guilds) {
          return {
            success: false,
            error: 'Bot client not available'
          };
        }

        const guild = client.guilds.cache.get(data.guildId);
        if (!guild) {
          return {
            success: false,
            error: 'Guild not found'
          };
        }

        // Get text channels (type 0), announcement channels (type 5), and forum channels (type 15)
        // Filter out voice channels, categories, and other non-text channels
        const textChannelTypes = [0, 5, 15]; // GuildText, GuildAnnouncement, GuildForum
        const channels = guild.channels.cache
          .filter((channel: any) => textChannelTypes.includes(channel.type))
          .sort((a: any, b: any) => a.position - b.position)
          .map((channel: any) => ({
            id: channel.id,
            name: channel.name,
            type: channel.type,
            parentId: channel.parentId,
            parentName: channel.parent?.name || null
          }));

        return {
          success: true,
          channels
        };
      } catch (error) {
        console.error('[IPCPanelHandler] Error getting guild channels:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }

    case 'guild:roles':
      if (!data || !data.guildId) {
        return {
          success: false,
          error: 'Missing required field: guildId'
        };
      }
      try {
        const client = panelManager.getClient();
        if (!client || !client.guilds) {
          return {
            success: false,
            error: 'Bot client not available'
          };
        }

        const guild = client.guilds.cache.get(data.guildId);
        if (!guild) {
          return {
            success: false,
            error: 'Guild not found'
          };
        }

        // Get all roles except @everyone, sorted by position (highest first)
        // Filter out managed roles (bot roles, integration roles)
        const roles = guild.roles.cache
          .filter((role: any) => role.id !== guild.id && !role.managed)
          .sort((a: any, b: any) => b.position - a.position)
          .map((role: any) => ({
            id: role.id,
            name: role.name,
            color: role.color,
            position: role.position
          }));

        return {
          success: true,
          roles
        };
      } catch (error) {
        console.error('[IPCPanelHandler] Error getting guild roles:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }

    default:
      console.warn(`[IPCPanelHandler] Unknown IPC message type: ${type}`);
      return {
        success: false,
        error: `Unknown IPC message type: ${type}`
      };
  }
}
