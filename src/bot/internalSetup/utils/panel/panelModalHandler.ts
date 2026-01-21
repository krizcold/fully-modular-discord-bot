// Panel Modal Handler - Handles Discord modal submit interactions for panels

import { Client, ModalSubmitInteraction } from 'discord.js';
import { registerModalHandler } from '../../events/interactionCreate/modalSubmitHandler';
import { PanelContext, PanelResponse } from '../../../types/panelTypes';
import { DISCORD_EPHEMERAL_FLAG } from '../../../constants';
import { getNavigationContext, storeNavigationContext, detectAccessMethodFromMessage } from './panelButtonHandler';

/**
 * Parse panel modal customId: panel_{panelId}_modal_{modalId}
 */
export function parseModalCustomId(customId: string): { panelId: string; modalId: string } | null {
  const parts = customId.split('_');
  if (parts.length < 4 || parts[0] !== 'panel') {
    console.log(`[PanelModalHandler] Invalid panel modal format: ${customId}`);
    return null;
  }

  // Find the 'modal' part in the array
  const modalIndex = parts.indexOf('modal');
  if (modalIndex === -1 || modalIndex === parts.length - 1) {
    console.log(`[PanelModalHandler] No 'modal' found or no modal ID after 'modal': ${customId}`);
    return null;
  }

  // Everything between 'panel' and 'modal' is the panel ID
  const panelId = parts.slice(1, modalIndex).join('_');
  // Everything after 'modal' is the modal ID
  const modalId = parts.slice(modalIndex + 1).join('_');

  return { panelId, modalId };
}

/**
 * Register the panel modal handler with the Discord bot
 */
export function registerPanelModalHandler(
  client: Client,
  handleModalInteraction: (context: PanelContext, modalId: string) => Promise<PanelResponse | null>,
  panels: Map<string, any>
): void {
  console.log('[PanelModalHandler] Registering panel modal handler for prefix: panel');

  // Register a prefix handler for all panel modals
  registerModalHandler(
    client,
    'panel',
    async (client: Client, interaction: ModalSubmitInteraction) => {
      console.log('[PanelModalHandler] Modal handler called!');
      await handleModalFromModalHandler(interaction, handleModalInteraction, panels);
    }
  );

  console.log('[PanelModalHandler] Panel modal handler registered');
}

/**
 * Handle modal interaction from Discord
 */
async function handleModalFromModalHandler(
  interaction: ModalSubmitInteraction,
  handleModalInteraction: (context: PanelContext, modalId: string) => Promise<PanelResponse | null>,
  panels: Map<string, any>
): Promise<void> {
  console.log(`[PanelModalHandler] Handling modal: ${interaction.customId}`);

  const customId = interaction.customId;

  // Parse the panel modal customId
  const parsed = parseModalCustomId(customId);
  if (!parsed) {
    return; // Invalid format, already logged
  }

  const { panelId, modalId } = parsed;
  console.log(`[PanelModalHandler] Parsed - panelId: ${panelId}, modalId: ${modalId}`);

  const navContext = interaction.message ? getNavigationContext(interaction.message.id) : null;

  // Determine access method:
  // 1. Use stored context if available (normal case)
  // 2. If no context but has message (e.g., after bot restart), detect from message buttons
  // 3. Fall back to direct_command if neither works
  let accessMethod: 'system_panel' | 'guild_panel' | 'direct_command' | 'web_ui' = 'direct_command';

  if (navContext?.accessMethod) {
    accessMethod = navContext.accessMethod;
  } else if (interaction.message) {
    const detectedMethod = detectAccessMethodFromMessage(interaction.message);
    if (detectedMethod) {
      accessMethod = detectedMethod;
      console.log(`[PanelModalHandler] Recovered access method from message: ${detectedMethod}`);
    }
  }

  const context: PanelContext = {
    client: interaction.client,
    interaction,
    panelId,
    userId: interaction.user.id,
    guildId: interaction.guildId || null,
    accessMethod,
    navigationStack: navContext?.navigationStack || []
  };

  try {
    const response = await handleModalInteraction(context, modalId);

    if (response) {
      // If modal came from a button (has message), update the original message
      if (interaction.message) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.deferUpdate();
        }
        await interaction.editReply(response);
        storeNavigationContext(interaction.message.id, context.navigationStack || [], context.accessMethod);
      } else {
        // Modal came from slash command - use regular reply
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply(response);
        } else {
          await interaction.reply(response);

          // Auto-delete after 2 seconds if it's an ephemeral success/error message
          if (response.flags && (response.embeds?.[0]?.data?.title?.startsWith('✅') ||
                                 response.embeds?.[0]?.data?.title?.startsWith('❌'))) {
            setTimeout(async () => {
              try {
                await interaction.deleteReply();
              } catch (err) {
                // Ignore errors (message may already be deleted)
              }
            }, 2000);
          }
        }
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
          console.error('[PanelModalHandler] Failed to send notification:', followUpError);
        }
      }

      console.log(`[PanelModalHandler] Modal handled successfully: ${customId}`);
    } else {
      console.log(`[PanelModalHandler] No response from modal handler: ${customId}`);
    }
  } catch (error) {
    console.error(`[PanelModalHandler] Error handling modal ${customId}:`, error);

    const errorResponse = {
      content: '❌ An error occurred while processing the modal submission.',
      flags: DISCORD_EPHEMERAL_FLAG
    };

    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(errorResponse);
      } else if (interaction.message) {
        await interaction.deferUpdate();
        await interaction.editReply(errorResponse);
      } else {
        await interaction.reply(errorResponse);
      }
    } catch (replyError) {
      console.error('[PanelModalHandler] Failed to send error response:', replyError);
    }
  }
}
