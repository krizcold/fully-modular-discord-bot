// Panel Dropdown Handler - Handles Discord dropdown interactions for panels

import { Client, StringSelectMenuInteraction, AnySelectMenuInteraction } from 'discord.js';
import { registerDropdownHandler } from '../../events/interactionCreate/dropdownHandler';
import { PanelContext, PanelResponse } from '../../../types/panelTypes';
import { DISCORD_EPHEMERAL_FLAG } from '../../../constants';
import { getNavigationContext, storeNavigationContext, detectAccessMethodFromMessage } from './panelButtonHandler';
import { isActiveInstance } from './persistentPanelStorage';

/**
 * Parse panel dropdown customId: panel_{panelId}_dropdown_{dropdownId}
 */
export function parseDropdownCustomId(customId: string): { panelId: string; dropdownId: string } | null {
  const parts = customId.split('_');
  if (parts.length < 4 || parts[0] !== 'panel') {
    console.log(`[PanelDropdownHandler] Invalid panel dropdown format: ${customId}`);
    return null;
  }

  // Find the 'dropdown' part in the array
  const dropdownIndex = parts.indexOf('dropdown');
  if (dropdownIndex === -1 || dropdownIndex === parts.length - 1) {
    console.log(`[PanelDropdownHandler] No 'dropdown' found or no dropdown ID after 'dropdown': ${customId}`);
    return null;
  }

  // Everything between 'panel' and 'dropdown' is the panel ID
  const panelId = parts.slice(1, dropdownIndex).join('_');
  // Everything after 'dropdown' is the dropdown ID
  const dropdownId = parts.slice(dropdownIndex + 1).join('_');

  return { panelId, dropdownId };
}

/**
 * Register the panel dropdown handler with the Discord bot
 */
export function registerPanelDropdownHandler(
  client: Client,
  handleDropdownInteraction: (context: PanelContext, values: string[], dropdownId?: string) => Promise<PanelResponse>,
  panels: Map<string, any>
): void {
  console.log('[PanelDropdownHandler] Registering panel dropdown handler for prefix: panel');

  // Register a prefix handler for all panel dropdowns (supports all select menu types)
  // timeoutMs: null disables expiration (panels can be persistent)
  registerDropdownHandler(
    client,
    'panel',
    async (client: Client, interaction: AnySelectMenuInteraction) => {
      console.log('[PanelDropdownHandler] Dropdown handler called!');
      await handleDropdownFromDropdownHandler(interaction, handleDropdownInteraction, panels);
    },
    null
  );

  console.log('[PanelDropdownHandler] Panel dropdown handler registered');
}

/**
 * Extract values from any select menu interaction type
 */
function extractSelectValues(interaction: AnySelectMenuInteraction): string[] {
  // For channel/user/role/mentionable selects, values are snowflake IDs
  // For string selects, values are the selected option values
  return interaction.values;
}

/**
 * Handle dropdown interaction from Discord
 */
async function handleDropdownFromDropdownHandler(
  interaction: AnySelectMenuInteraction,
  handleDropdownInteraction: (context: PanelContext, values: string[], dropdownId?: string) => Promise<PanelResponse>,
  panels: Map<string, any>
): Promise<void> {
  console.log(`[PanelDropdownHandler] Handling dropdown: ${interaction.customId} (type: ${interaction.componentType})`);

  const customId = interaction.customId;

  // Parse the panel dropdown customId
  const parsed = parseDropdownCustomId(customId);
  if (!parsed) {
    return; // Invalid format, already logged
  }

  const { panelId, dropdownId } = parsed;
  console.log(`[PanelDropdownHandler] Parsed - panelId: ${panelId}, dropdownId: ${dropdownId}`);

  const panel = panels.get(panelId);
  const isPersistent = panel?.persistent;
  const isUnique = panel?.unique;

  // For unique persistent panels, validate this message is the current active instance
  if (isPersistent && isUnique) {
    const messageId = interaction.message.id;
    const guildId = interaction.guildId || undefined;
    const isActive = await isActiveInstance(panelId, messageId, guildId);

    if (!isActive) {
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
    const detectedMethod = detectAccessMethodFromMessage(interaction.message);
    if (detectedMethod) {
      accessMethod = detectedMethod;
      console.log(`[PanelDropdownHandler] Recovered access method from message: ${detectedMethod}`);
    }
  }

  const context: PanelContext = {
    client: interaction.client,
    interaction,
    panelId,
    userId: interaction.user.id,
    guildId: interaction.guildId || null,
    accessMethod,
    navigationStack: navContext?.navigationStack || [],
    data: navContext?.panelState ? { state: navContext.panelState } : undefined
  };

  // Extract values from the select menu (works for all types)
  const values = extractSelectValues(interaction);

  try {
    const response = await handleDropdownInteraction(context, values, dropdownId);

    // Check if response is a modal (has modal property)
    if (response && 'modal' in response && response.modal) {
      // Show modal directly - no update needed
      await interaction.showModal(response.modal as any);
      console.log(`[PanelDropdownHandler] Modal shown for dropdown: ${customId}`);
      return;
    }

    if (response) {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(response);
      } else {
        await interaction.update(response);
      }

      storeNavigationContext(interaction.message.id, context.navigationStack || [], context.accessMethod, undefined, context.data?.state);

      console.log(`[PanelDropdownHandler] Dropdown handled successfully: ${customId}`);
    } else {
      console.log(`[PanelDropdownHandler] No response from dropdown handler: ${customId}`);
    }
  } catch (error) {
    console.error(`[PanelDropdownHandler] Error handling dropdown ${customId}:`, error);

    const errorResponse = {
      content: '❌ An error occurred while processing the dropdown interaction.',
      flags: DISCORD_EPHEMERAL_FLAG
    };

    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(errorResponse);
      } else {
        await interaction.update(errorResponse);
      }
    } catch (replyError) {
      console.error('[PanelDropdownHandler] Failed to send error response:', replyError);
    }
  }
}
