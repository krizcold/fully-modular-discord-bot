/**
 * Persistent Panel Warning System
 */

import {
  ButtonInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionResponse,
  Message,
  CommandInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  Colors,
  MessageFlags,
} from 'discord.js';
import { PanelContext, PanelOptions, PanelResponse, PanelInteraction } from '@bot/types/panelTypes';
import { getPanelManager } from '../panelManager';
import { storePersistentPanel } from './persistentPanelStorage';
import { storeNavigationContext } from './panelButtonHandler';
import { injectReturnButtonIfNeeded } from './panelResponseUtils';
import { DISCORD_EPHEMERAL_FLAG } from '@bot/constants';

/**
 * Create the warning message for a persistent panel
 */
export function createPersistentPanelWarning(
  panel: PanelOptions,
  context: PanelContext
): PanelResponse {
  const warningMessage = panel.persistentWarningMessage ||
    'This panel will be visible to everyone in this channel and will persist even after you close Discord.';

  const embed = new EmbedBuilder()
    .setTitle('⚠️ Persistent Panel Warning')
    .setDescription(warningMessage)
    .setColor(Colors.Yellow)
    .addFields(
      {
        name: 'Panel Information',
        value: `**Name:** ${panel.name}\n**Description:** ${panel.description}`,
        inline: false
      }
    )
    .setFooter({ text: 'Click the button below to open the persistent panel' });

  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`persistent_warning_${panel.id}_${context.accessMethod}`)
        .setLabel('Open Persistent Panel')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📋')
    );

  row.addComponents(
    new ButtonBuilder()
      .setCustomId('persistent_warning_cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [row],
    flags: DISCORD_EPHEMERAL_FLAG
  };
}

/**
 * Handle the warning button click
 */
export async function handlePersistentWarningButton(
  interaction: ButtonInteraction,
  panelId: string,
  accessMethod: 'system_panel' | 'guild_panel' | 'direct_command' | 'web_ui' = 'direct_command'
): Promise<void> {
  const panel = getPanelManager().getPanel(panelId);
  if (!panel) {
    await interaction.update({
      content: '❌ Panel not found',
      embeds: [],
      components: []
    });
    return;
  }

  const context: PanelContext = {
    client: interaction.client,
    interaction: interaction as PanelInteraction,
    panelId,
    userId: interaction.user.id,
    guildId: interaction.guildId,
    accessMethod,
    navigationStack: []
  };

  try {
    await interaction.deferUpdate();

    let response = await panel.callback(context);

    response = injectReturnButtonIfNeeded(response, context);

    const channel = interaction.channel;
    if (!channel || !('send' in channel)) {
      await interaction.editReply({
        content: '❌ Failed to create persistent panel - invalid channel',
        embeds: [],
        components: []
      });
      return;
    }

    const message = await channel.send({
      ...response,
      flags: MessageFlags.IsComponentsV2 as number
    });

    if (message instanceof Message) {
      await storePersistentPanel(
        panelId,
        {
          messageId: message.id,
          channelId: message.channelId,
          userId: interaction.user.id,
          guildId: interaction.guildId || undefined,
          createdAt: Date.now(),
          lastUpdated: Date.now(),
          state: 'active',
          accessMethod
        },
        interaction.guildId || undefined,
        undefined,
        panel.maxActiveInstances
      );

      storeNavigationContext(message.id, [], accessMethod);

      // Call the panel's onPersistentCreated callback if defined (for dynamic update registration)
      if (panel.onPersistentCreated && interaction.guildId) {
        try {
          panel.onPersistentCreated(interaction.client, interaction.guildId, message.id, message.channelId);
        } catch (error) {
          console.error(`[PersistentPanelWarning] Error in onPersistentCreated callback for ${panelId}:`, error);
        }
      }

      try {
        await interaction.deleteReply();
      } catch {}
    }
  } catch (error) {
    console.error(`Error opening persistent panel ${panelId}:`, error);
    try {
      await interaction.editReply({
        content: '❌ Failed to open persistent panel',
        embeds: [],
        components: []
      });
    } catch (e) {
      console.error('[PersistentPanelWarning] Failed to send error message:', e);
    }
  }
}

/**
 * Handle cancel button
 */
export async function handlePersistentWarningCancel(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate();
  await interaction.deleteReply();
}

/**
 * Check if panel should show warning
 */
export function shouldShowPersistentWarning(
  panel: PanelOptions,
  context: PanelContext
): boolean {
  if (!panel.persistent) {
    return false;
  }

  if (context.accessMethod === 'web_ui') {
    return false;
  }

  if (context.interaction &&
      (context.interaction instanceof ButtonInteraction ||
       context.interaction instanceof StringSelectMenuInteraction ||
       context.interaction instanceof ModalSubmitInteraction) &&
       context.interaction.customId.includes(`panel_${panel.id}_`)) {
    return false;
  }

  return true;
}

/**
 * Initialize persistent panel
 */
export async function initializePersistentPanel(
  panel: PanelOptions,
  context: PanelContext,
  sessionId?: string
): Promise<PanelResponse> {
  if (panel.maxActiveInstances === 1 && !sessionId) {
  }

  return await panel.callback(context);
}

/**
 * Convert response to persistent (keep V2 flag, remove ephemeral)
 */
export function makePersistentResponse(response: PanelResponse): PanelResponse {
  return {
    ...response,
    flags: MessageFlags.IsComponentsV2 as number,
    ephemeral: undefined
  };
}

/**
 * Register persistent warning handlers
 */
export function registerPersistentWarningHandlers(client: any): void {
  console.log('Persistent panel warning handlers registered');
}