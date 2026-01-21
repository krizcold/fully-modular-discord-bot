import { Client, ButtonInteraction, Message } from 'discord.js';
import { registerButtonHandler } from '../../events/interactionCreate/buttonHandler';
import { PanelContext, PanelResponse } from '../../../types/panelTypes';
import { DISCORD_EPHEMERAL_FLAG } from '../../../constants';
import {
  handlePersistentWarningButton,
  handlePersistentWarningCancel
} from './persistentPanelWarning';
import { getPersistentPanel, updatePersistentPanelState, isActiveInstance } from './persistentPanelStorage';

/**
 * Navigation context storage
 * Maps message ID to navigation context (includes navigationStack and accessMethod)
 * TTL: 30 minutes
 */
interface NavigationContext {
  navigationStack: string[];
  accessMethod: 'system_panel' | 'guild_panel' | 'direct_command' | 'web_ui';
  sourceCategory?: string;  // Category the panel was opened from (for return navigation)
  panelState?: any;  // Arbitrary panel state data (view mode, page, etc.)
  timestamp: number;
}

const navigationContextMap = new Map<string, NavigationContext>();

setInterval(() => {
  const now = Date.now();
  const thirtyMinutes = 30 * 60 * 1000;

  for (const [messageId, context] of navigationContextMap.entries()) {
    if (now - context.timestamp > thirtyMinutes) {
      navigationContextMap.delete(messageId);
    }
  }
}, 5 * 60 * 1000);

/**
 * Store navigation context for a message
 */
export function storeNavigationContext(
  messageId: string,
  navigationStack: string[],
  accessMethod: string,
  sourceCategory?: string,
  panelState?: any
): void {
  navigationContextMap.set(messageId, {
    navigationStack: [...navigationStack],
    accessMethod: accessMethod as any,
    sourceCategory,
    panelState,
    timestamp: Date.now()
  });
}

/**
 * Update only the panel state for a message (preserves other context)
 */
export function updatePanelState(messageId: string, panelState: any): void {
  const existing = navigationContextMap.get(messageId);
  if (existing) {
    existing.panelState = panelState;
    existing.timestamp = Date.now();
  } else {
    // Create minimal context if none exists
    navigationContextMap.set(messageId, {
      navigationStack: [],
      accessMethod: 'direct_command',
      panelState,
      timestamp: Date.now()
    });
  }
}

/**
 * Retrieve navigation context for a message
 */
export function getNavigationContext(messageId: string): NavigationContext | null {
  return navigationContextMap.get(messageId) || null;
}

/**
 * Recursively scan components for admin panel buttons
 * Works with both V1 and V2 component structures
 */
function scanComponentsForAdminButtons(components: any[]): 'system_panel' | 'guild_panel' | null {
  for (const comp of components) {
    // Button (type 2)
    if (comp.type === 2) {
      const customId = comp.customId || comp.custom_id;
      if (customId) {
        if (customId === 'admin_panel_system_back' || customId.startsWith('admin_panel_system_')) {
          return 'system_panel';
        }
        if (customId === 'admin_panel_guild_back' || customId.startsWith('admin_panel_guild_')) {
          return 'guild_panel';
        }
      }
    }

    // Recursively check nested components (ActionRow, Container, Section, etc.)
    const nested = comp.components;
    if (nested && Array.isArray(nested) && nested.length > 0) {
      const result = scanComponentsForAdminButtons(nested);
      if (result) return result;
    }
  }
  return null;
}

/**
 * Detect access method from existing message components
 * Looks for return/close buttons that indicate how the panel was accessed
 * This allows recovery after bot restart when RAM context is lost
 */
export function detectAccessMethodFromMessage(
  message: Message
): 'system_panel' | 'guild_panel' | null {
  if (!message.components || message.components.length === 0) {
    return null;
  }

  // Convert message components to a scannable array
  // message.components can be ActionRow or Container objects from Discord API
  const componentsToScan: any[] = [];

  for (const topLevel of message.components) {
    // Try to get raw data - works for both API objects and Builders
    let componentData: any;
    if (typeof (topLevel as any).toJSON === 'function') {
      componentData = (topLevel as any).toJSON();
    } else {
      // Already raw API data
      componentData = topLevel;
    }

    componentsToScan.push(componentData);
  }

  return scanComponentsForAdminButtons(componentsToScan);
}

/**
 * Parse panel button customId: panel_{panelId}_btn_{buttonId}
 */
export function parseButtonCustomId(customId: string): { panelId: string; buttonId: string } | null {
  const parts = customId.split('_');
  if (parts.length < 4 || parts[0] !== 'panel') {
    console.log(`[PanelButtonHandler] Invalid panel button format: ${customId}`);
    return null;
  }

  const btnIndex = parts.indexOf('btn');
  if (btnIndex === -1 || btnIndex === parts.length - 1) {
    console.log(`[PanelButtonHandler] No 'btn' found or no button ID after 'btn': ${customId}`);
    return null;
  }

  const panelId = parts.slice(1, btnIndex).join('_');
  const buttonId = parts.slice(btnIndex + 1).join('_');

  return { panelId, buttonId };
}

/**
 * Register the panel button handler with the Discord bot
 */
export function registerPanelButtonHandler(
  client: Client,
  handleButtonInteraction: (context: PanelContext, buttonId: string) => Promise<PanelResponse | null>,
  panels: Map<string, any>
): void {
  console.log('[PanelButtonHandler] Registering panel button handler for prefix: panel');

  registerButtonHandler(
    client,
    'panel',
    async (client: Client, interaction: ButtonInteraction, userLevel: number) => {
      console.log('[PanelButtonHandler] Button handler called!');
      await handleButtonFromButtonHandler(interaction, handleButtonInteraction, panels);
    },
    { timeoutMs: null }
  );

  registerButtonHandler(
    client,
    'persistent_warning',
    async (client: Client, interaction: ButtonInteraction, userLevel: number) => {
      console.log('[PanelButtonHandler] Persistent warning button handler called!');
      await handlePersistentWarningButtonFromHandler(interaction, panels);
    },
    { timeoutMs: null }
  );

  console.log('[PanelButtonHandler] Panel button handler registered');
}

/**
 * Handle button interaction from Discord
 */
async function handleButtonFromButtonHandler(
  interaction: ButtonInteraction,
  handleButtonInteraction: (context: PanelContext, buttonId: string) => Promise<PanelResponse | null>,
  panels: Map<string, any>
): Promise<void> {
  console.log(`[PanelButtonHandler] Handling button: ${interaction.customId}`);

  const customId = interaction.customId;

  const parsed = parseButtonCustomId(customId);
  if (!parsed) {
    return;
  }

  const { panelId, buttonId } = parsed;
  console.log(`[PanelButtonHandler] Parsed - panelId: ${panelId}, buttonId: ${buttonId}`);

  const panel = panels.get(panelId);
  const isPersistent = panel?.persistent;
  const isUnique = panel?.unique;

  // For unique persistent panels, validate this message is the current active instance
  // This prevents old/deactivated panel messages from affecting the current panel
  if (isPersistent && isUnique) {
    const messageId = interaction.message.id;
    const guildId = interaction.guildId || undefined;
    const isActive = await isActiveInstance(panelId, messageId, guildId);

    if (!isActive) {
      // This is an old/deactivated panel - reject the interaction
      await interaction.reply({
        content: '⚠️ This panel is no longer active. A newer instance has been opened.',
        flags: DISCORD_EPHEMERAL_FLAG
      });
      return;
    }
  }

  const navContext = getNavigationContext(interaction.message.id);

  // Determine access method:
  // 1. Use stored context if available (normal case)
  // 2. If no context (e.g., after bot restart), detect from existing message buttons
  // 3. Fall back to direct_command if neither works
  let accessMethod: 'system_panel' | 'guild_panel' | 'direct_command' | 'web_ui' = 'direct_command';

  if (navContext?.accessMethod) {
    accessMethod = navContext.accessMethod;
  } else {
    // Try to recover access method from existing message components
    // This handles the case where bot restarted and RAM context was lost
    const detectedMethod = detectAccessMethodFromMessage(interaction.message);
    if (detectedMethod) {
      accessMethod = detectedMethod;
      console.log(`[PanelButtonHandler] Recovered access method from message: ${detectedMethod}`);
    }
  }

  const context: PanelContext = {
    client: interaction.client,
    interaction,
    panelId,
    userId: interaction.user.id,
    guildId: interaction.guildId || null,
    accessMethod,
    navigationStack: navContext ? [...navContext.navigationStack, panelId] : [panelId],
    data: navContext?.panelState ? { state: navContext.panelState } : undefined
  };

  try {
    // Race between handler and auto-defer timer
    // We can't defer immediately because modals must be shown as initial response
    // But we also can't wait too long or the interaction expires (3s limit)
    let handlerCompleted = false;
    let response: PanelResponse | null = null;

    const handlerPromise = handleButtonInteraction(context, buttonId).then(r => {
      handlerCompleted = true;
      response = r;
      return r;
    });

    // Auto-defer after 2.5 seconds if handler hasn't completed
    const autoDeferPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), 2500);
    });

    const raceResult = await Promise.race([handlerPromise, autoDeferPromise]);

    if (raceResult === 'timeout' && !handlerCompleted) {
      // Handler is still running, defer now to prevent timeout
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate();
      }
      // Wait for handler to complete
      response = await handlerPromise;
    }

    // Check if response is a modal (has modal property)
    if (response && 'modal' in response && response.modal) {
      // Show modal directly - only works if we haven't deferred yet
      if (!interaction.deferred && !interaction.replied) {
        await interaction.showModal(response.modal as any);
        console.log(`[PanelButtonHandler] Modal shown for button: ${customId}`);
        return;
      } else {
        // Already deferred, can't show modal - log warning and continue
        console.warn(`[PanelButtonHandler] Cannot show modal after deferring for: ${customId}`);
      }
    }

    // For non-modal responses, defer if not already done
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }

    // Check if panel should be closed (delete the ephemeral message)
    if (response && 'closePanel' in response && response.closePanel) {
      // Send notification as followUp BEFORE deleting (if present and not silent)
      // Silent notifications skip the Discord ephemeral message (Web-UI still shows popup)
      if (response.notification && !response.notification.silent) {
        const emoji = response.notification.type === 'error' ? '❌' :
                      response.notification.type === 'warning' ? '⚠️' :
                      response.notification.type === 'success' ? '✅' : 'ℹ️';
        const title = response.notification.title ? `**${response.notification.title}**\n` : '';
        try {
          await interaction.followUp({
            content: `${emoji} ${title}${response.notification.message}`,
            flags: DISCORD_EPHEMERAL_FLAG
          });
        } catch (followUpError) {
          console.error('[PanelButtonHandler] Failed to send close notification:', followUpError);
        }
      }
      try {
        await interaction.deleteReply();
      } catch (deleteError) {
        console.error(`[PanelButtonHandler] Failed to delete panel:`, deleteError);
      }
      return;
    }

    if (response) {
      if (isPersistent) {
        storeNavigationContext(interaction.message.id, context.navigationStack || [], context.accessMethod, navContext?.sourceCategory, context.data?.state);
      } else {
        await interaction.editReply(response);
        storeNavigationContext(interaction.message.id, context.navigationStack || [], context.accessMethod, navContext?.sourceCategory, context.data?.state);
      }

      // Send notification as followUp if present and not silent
      if (response.notification && !response.notification.silent) {
        const emoji = response.notification.type === 'error' ? '❌' :
                      response.notification.type === 'warning' ? '⚠️' :
                      response.notification.type === 'success' ? '✅' : 'ℹ️';
        const title = response.notification.title ? `**${response.notification.title}**\n` : '';
        try {
          await interaction.followUp({
            content: `${emoji} ${title}${response.notification.message}`,
            flags: DISCORD_EPHEMERAL_FLAG
          });
        } catch (followUpError) {
          console.error('[PanelButtonHandler] Failed to send notification:', followUpError);
        }
      }

      console.log(`[PanelButtonHandler] Button handled successfully: ${customId}`);
    } else {
      console.log(`[PanelButtonHandler] No response from button handler: ${customId}`);
    }
  } catch (error) {
    console.error(`[PanelButtonHandler] Error handling button ${customId}:`, error);

    // Try to defer if not already done
    if (!interaction.deferred && !interaction.replied) {
      try {
        await interaction.deferUpdate();
      } catch {}
    }

    const errorResponse = {
      content: '❌ An error occurred while processing the button interaction.',
      flags: DISCORD_EPHEMERAL_FLAG
    };

    try {
      await interaction.editReply(errorResponse);
    } catch (replyError) {
      console.error('[PanelButtonHandler] Failed to send error response:', replyError);
    }
  }
}

/**
 * Handle persistent warning button interaction
 */
async function handlePersistentWarningButtonFromHandler(
  interaction: ButtonInteraction,
  panels: Map<string, any>
): Promise<void> {
  const customId = interaction.customId;
  console.log(`[PanelButtonHandler] Handling persistent warning button: ${customId}`);

  if (customId === 'persistent_warning_cancel') {
    await handlePersistentWarningCancel(interaction);
    return;
  }

  const parts = customId.split('_');
  if (parts.length < 3) {
    await interaction.update({
      content: '❌ Invalid button format',
      embeds: [],
      components: []
    });
    return;
  }

  const validAccessMethods = ['system_panel', 'guild_panel', 'direct_command', 'web_ui'];
  const lastPart = parts[parts.length - 1];
  const secondLastPart = parts.length > 3 ? parts[parts.length - 2] : null;
  const combinedLast = secondLastPart ? `${secondLastPart}_${lastPart}` : lastPart;

  let panelId: string;
  let accessMethod: 'system_panel' | 'guild_panel' | 'direct_command' | 'web_ui' = 'direct_command';

  if (validAccessMethods.includes(combinedLast)) {
    accessMethod = combinedLast as typeof accessMethod;
    panelId = parts.slice(2, -2).join('_');
  } else if (validAccessMethods.includes(lastPart)) {
    accessMethod = lastPart as typeof accessMethod;
    panelId = parts.slice(2, -1).join('_');
  } else {
    panelId = parts.slice(2).join('_');
  }

  const panel = panels.get(panelId);
  if (!panel) {
    await interaction.update({
      content: '❌ Panel not found',
      embeds: [],
      components: []
    });
    return;
  }

  await handlePersistentWarningButton(interaction, panelId, accessMethod);
}
