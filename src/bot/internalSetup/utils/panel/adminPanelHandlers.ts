/**
 * Shared admin panel button handlers
 * Used by both guildPanel.ts and systemPanel.ts
 */

import { Client, ButtonInteraction } from 'discord.js';
import { registerButtonHandler } from '../../events/interactionCreate/buttonHandler';
import { getPanelManager } from '../panelManager';
import { PanelContext } from '../../../types/panelTypes';
import { storeNavigationContext, getNavigationContext } from './panelButtonHandler';
import {
  categoryRequiresWarning,
  createCategoryWarning,
  handleCategoryWarningCancel
} from './categoryWarning';

let closeHandlerRegistered = false;
let categoryWarningHandlersRegistered = false;

/**
 * Register button handlers for admin panel navigation
 * All handlers use timeoutMs: null since admin panels should never expire
 */
export function registerAdminPanelHandlers(client: Client, scope: 'guild' | 'system') {
  // Page navigation: admin_panel_{scope}_page_{number}
  registerButtonHandler(client, `admin_panel_${scope}_page`, async (client, interaction) => {
    const customId = interaction.customId;
    const pageMatch = customId.match(/admin_panel_\w+_page_(-?\d+)/);
    if (!pageMatch) return;

    const page = parseInt(pageMatch[1], 10);
    if (page < 0) return;

    const panelManager = getPanelManager(client);
    const response = panelManager.generateAdminPanel(page, undefined, interaction.guildId, scope);
    await interaction.update(response);
  }, { timeoutMs: null });

  // Category navigation: admin_panel_{scope}_cat_{categoryName}_{page}
  registerButtonHandler(client, `admin_panel_${scope}_cat`, async (client, interaction) => {
    const customId = interaction.customId;
    const match = customId.match(/admin_panel_\w+_cat_(.+)_(-?\d+)$/);
    if (!match) return;

    const categoryName = decodeURIComponent(match[1]);
    const page = parseInt(match[2], 10);
    if (page < 0) return;

    // Check if category requires warning and this is the first access (page 0)
    if (page === 0 && categoryRequiresWarning(categoryName)) {
      const targetButtonId = `cat_${encodeURIComponent(categoryName)}_0`;
      const warningResponse = createCategoryWarning(categoryName, targetButtonId, scope);
      await interaction.update(warningResponse);
      return;
    }

    const panelManager = getPanelManager(client);
    const response = panelManager.generateAdminPanel(page, categoryName, interaction.guildId, scope);
    await interaction.update(response);
  }, { timeoutMs: null });

  // Open specific panel: admin_panel_{scope}_open_{panelId} or admin_panel_{scope}_open_{panelId}_fromcat_{category}
  registerButtonHandler(client, `admin_panel_${scope}_open`, async (client, interaction) => {
    const customId = interaction.customId;
    const afterPrefix = customId.replace(`admin_panel_${scope}_open_`, '');

    // Check if opened from a category: panelId_fromcat_categoryName
    let panelId: string;
    let sourceCategory: string | undefined;
    const fromCatMatch = afterPrefix.match(/^(.+)_fromcat_(.+)$/);
    if (fromCatMatch) {
      panelId = fromCatMatch[1];
      sourceCategory = decodeURIComponent(fromCatMatch[2]);
    } else {
      panelId = afterPrefix;
    }

    const context: PanelContext = {
      client,
      interaction,
      panelId,
      userId: interaction.user.id,
      guildId: interaction.guildId || undefined,
      accessMethod: `${scope}_panel`,
      navigationStack: [],
    };

    const panelManager = getPanelManager(client);
    const response = await panelManager.handlePanelInteraction(context);
    await interaction.update(response);

    storeNavigationContext(interaction.message.id, context.navigationStack || [], context.accessMethod, sourceCategory);
  }, { timeoutMs: null });

  // Back button from panels: admin_panel_{scope}_back - goes to category if source known, otherwise main menu
  registerButtonHandler(client, `admin_panel_${scope}_back`, async (client, interaction) => {
    const navContext = getNavigationContext(interaction.message.id);
    const panelManager = getPanelManager(client);

    // If we have a source category, go back to that category
    if (navContext?.sourceCategory) {
      const response = panelManager.generateAdminPanel(0, navContext.sourceCategory, interaction.guildId, scope);
      await interaction.update(response);
    } else {
      // Otherwise go to main menu
      const response = panelManager.generateAdminPanel(0, undefined, interaction.guildId, scope);
      await interaction.update(response);
    }
  }, { timeoutMs: null });

  // Menu button from category view: admin_panel_{scope}_menu - always goes to main menu
  registerButtonHandler(client, `admin_panel_${scope}_menu`, async (client, interaction) => {
    const panelManager = getPanelManager(client);
    const response = panelManager.generateAdminPanel(0, undefined, interaction.guildId, scope);
    await interaction.update(response);
  }, { timeoutMs: null });
}

/**
 * Register the shared close button handler (only once)
 * Uses deferUpdate + deleteReply pattern for ephemeral message compatibility
 */
export function registerAdminPanelCloseHandler(client: Client) {
  if (closeHandlerRegistered) return;
  closeHandlerRegistered = true;

  registerButtonHandler(client, 'admin_panel_close', async (client, interaction) => {
    try {
      await interaction.deferUpdate();
      await interaction.deleteReply();
    } catch {}
  }, { timeoutMs: null });
}

/**
 * Register category warning button handlers (only once)
 * Handles confirm and cancel buttons from category warnings
 */
export function registerCategoryWarningHandlers(client: Client) {
  if (categoryWarningHandlersRegistered) return;
  categoryWarningHandlersRegistered = true;

  // Confirm warning button: category_warning_confirm_{scope}_{targetButtonId}
  registerButtonHandler(client, 'category_warning_confirm', async (client, interaction) => {
    const customId = interaction.customId;
    // Parse: category_warning_confirm_{scope}_{targetAction}
    const match = customId.match(/^category_warning_confirm_(guild|system)_(.+)$/);
    if (!match) return;

    const scope = match[1] as 'guild' | 'system';
    const targetAction = match[2];

    // Handle category navigation: cat_{categoryName}_{page}
    const catMatch = targetAction.match(/^cat_(.+)_(\d+)$/);
    if (catMatch) {
      const categoryName = decodeURIComponent(catMatch[1]);
      const page = parseInt(catMatch[2], 10);
      const panelManager = getPanelManager(client);
      const response = panelManager.generateAdminPanel(page, categoryName, interaction.guildId, scope);
      await interaction.update(response);
      return;
    }
  }, { timeoutMs: null });

  // Cancel warning button: category_warning_cancel_{scope}
  registerButtonHandler(client, 'category_warning_cancel', async (client, interaction) => {
    const customId = interaction.customId;
    const match = customId.match(/^category_warning_cancel_(guild|system)$/);
    if (!match) return;

    const scope = match[1] as 'guild' | 'system';
    const panelManager = getPanelManager(client);
    await handleCategoryWarningCancel(
      interaction,
      scope,
      (page, category, guildId, scope) => panelManager.generateAdminPanel(page, category, guildId, scope)
    );
  }, { timeoutMs: null });
}
