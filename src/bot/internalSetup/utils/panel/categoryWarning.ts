/**
 * Category Warning System
 * Shows a warning before opening panels from certain categories
 */

import {
  ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
} from 'discord.js';
import { PanelResponse } from '@bot/types/panelTypes';
import { createV2Response, V2Colors } from './v2/v2Builders';

// Categories that require a warning before access
export const CATEGORIES_REQUIRING_WARNING: Record<string, {
  icon: string;
  title: string;
  message: string;
}> = {
  'Advanced': {
    icon: '⚠️',
    title: 'Advanced Category Warning',
    message: 'This category contains panels that can modify **configuration files** and **raw data**. Incorrect changes may cause the bot to malfunction or lose data.\n\n**Only proceed if you understand the risks.**'
  }
};

/**
 * Check if a category requires a warning
 */
export function categoryRequiresWarning(categoryName: string): boolean {
  return categoryName in CATEGORIES_REQUIRING_WARNING;
}

/**
 * Create the warning panel for a category
 */
export function createCategoryWarning(
  categoryName: string,
  targetButtonId: string,
  scope: 'guild' | 'system'
): PanelResponse {
  const warningConfig = CATEGORIES_REQUIRING_WARNING[categoryName];
  if (!warningConfig) {
    throw new Error(`No warning config for category: ${categoryName}`);
  }

  const container = new ContainerBuilder()
    .setAccentColor(V2Colors.warning);

  // Title
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${warningConfig.icon} ${warningConfig.title}`)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Warning message
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(warningConfig.message)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Buttons
  const buttonRow = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`category_warning_confirm_${scope}_${targetButtonId}`)
        .setLabel('I Understand, Proceed')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('⚠️'),
      new ButtonBuilder()
        .setCustomId(`category_warning_cancel_${scope}`)
        .setLabel('Go Back')
        .setStyle(ButtonStyle.Secondary)
    );

  container.addActionRowComponents(buttonRow);

  return createV2Response([container]);
}

/**
 * Handle cancel button - returns to main menu
 */
export async function handleCategoryWarningCancel(
  interaction: ButtonInteraction,
  scope: 'guild' | 'system',
  generateAdminPanel: (page: number, category?: string, guildId?: string | null, scope?: 'guild' | 'system') => PanelResponse
): Promise<void> {
  const response = generateAdminPanel(0, undefined, interaction.guildId, scope);
  await interaction.update(response);
}
