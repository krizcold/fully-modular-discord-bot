// Admin Panel UI - Generates Discord admin panel interface

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SectionBuilder,
} from 'discord.js';
import { PanelOptions, PanelResponse, PanelManagerConfig, PanelListItem } from '../../../types/panelTypes';
import { loadCredentials } from '../../../../utils/envLoader';
import { createV2Response, V2Colors } from './v2/v2Builders';
import { PAGINATION_DEFAULTS } from './paginationUtils';
import { categoryRequiresWarning } from './categoryWarning';

// Constants
const MAX_ITEMS_PREVIEW = 3; // Show up to 3 items per category (+ "..." if more)
const CATEGORIES_PER_PAGE = 6; // Categories per page

/**
 * Get list of panels suitable for admin panel display
 * Filters out mainGuildOnly panels if current guild is not the main guild
 * Optionally filters by panel scope (system/guild)
 */
export function getAdminPanelList(
  panels: Map<string, PanelOptions>,
  config: PanelManagerConfig,
  guildId?: string | null,
  scope?: 'system' | 'guild'
): PanelListItem[] {
  const items: PanelListItem[] = [];

  // Get main guild ID for filtering
  const credentials = loadCredentials();
  const mainGuildId = credentials.MAIN_GUILD_ID || credentials.GUILD_ID;

  for (const [id, panel] of panels) {
    if (panel.showInAdminPanel === true) {
      // Filter out mainGuildOnly panels if current guild is not the main guild
      if (panel.mainGuildOnly && guildId !== mainGuildId) {
        continue;
      }

      // Filter by scope if specified
      const panelScope = panel.panelScope || 'guild'; // Default to 'guild'
      if (scope && panelScope !== scope) {
        continue;
      }

      items.push({
        id,
        name: panel.name,
        description: panel.description,
        category: panel.category || config.defaultCategory,
        icon: panel.adminPanelIcon || '📋',
        order: panel.adminPanelOrder || 999,
        scope: panelScope,
        requiresChannel: panel.requiresChannel
      });
    }
  }

  // Sort by order, then by name
  return items.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Group panels by category
 */
function groupByCategory(items: PanelListItem[]): Map<string, PanelListItem[]> {
  const grouped = new Map<string, PanelListItem[]>();
  for (const item of items) {
    if (!grouped.has(item.category)) {
      grouped.set(item.category, []);
    }
    grouped.get(item.category)!.push(item);
  }
  return grouped;
}

/**
 * Generate the Discord admin panel UI with section-based categories
 * Each category shows as a section with button accessory
 */
export function generateAdminPanel(
  panels: Map<string, PanelOptions>,
  config: PanelManagerConfig,
  page: number = 0,
  category?: string,
  guildId?: string | null,
  scope?: 'system' | 'guild'
): PanelResponse {
  const allItems = getAdminPanelList(panels, config, guildId, scope);

  // If viewing a specific category, show category detail view
  if (category) {
    return generateCategoryView(allItems, config, category, page, scope);
  }

  // Main view: show categories as sections
  const categorized = groupByCategory(allItems);
  const categoryNames = Array.from(categorized.keys());

  // Pagination for categories
  const totalCategories = categoryNames.length;
  const totalPages = Math.ceil(totalCategories / CATEGORIES_PER_PAGE);
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const startIdx = currentPage * CATEGORIES_PER_PAGE;
  const pageCategories = categoryNames.slice(startIdx, startIdx + CATEGORIES_PER_PAGE);

  // Build V2 container
  const container = new ContainerBuilder()
    .setAccentColor(scope === 'system' ? V2Colors.danger : V2Colors.primary);

  // Title
  const title = scope === 'system' ? '## System Panel' : '## Guild Panel';
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(title)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Add each category as a section
  const scopePrefix = scope || 'guild';
  for (let i = 0; i < pageCategories.length; i++) {
    const categoryName = pageCategories[i];
    const categoryItems = categorized.get(categoryName)!;
    const itemCount = categoryItems.length;

    // Add separator between categories (not before the first one)
    if (i > 0) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
      );
    }

    // Build preview text (up to 3 items, "..." if more) with ↳ prefix
    const previewItems = categoryItems.slice(0, MAX_ITEMS_PREVIEW);
    const previewText = previewItems.map(item => `↳ ${item.icon} ${item.name}`).join('\n');
    const hasMore = itemCount > MAX_ITEMS_PREVIEW;
    const displayText = hasMore ? `${previewText}\n↳ ...` : previewText;

    // Create section with button accessory
    const section = new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**📁 ${categoryName}** (${itemCount})`)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(displayText)
      );

    if (itemCount === 1) {
      // Single panel - direct access button with generic icon
      const singlePanel = categoryItems[0];
      section.setButtonAccessory(
        new ButtonBuilder()
          .setCustomId(`admin_panel_${scopePrefix}_open_${singlePanel.id}`)
          .setLabel('Open')
          .setEmoji('🔍')
          .setStyle(ButtonStyle.Primary)
      );
    } else {
      // Multiple panels - folder button
      section.setButtonAccessory(
        new ButtonBuilder()
          .setCustomId(`admin_panel_${scopePrefix}_cat_${encodeURIComponent(categoryName)}_0`)
          .setLabel('Browse')
          .setEmoji('📂')
          .setStyle(ButtonStyle.Secondary)
      );
    }

    container.addSectionComponents(section);
  }

  // Footer
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# ${allItems.length} panels in ${totalCategories} categories`)
  );

  // Navigation row
  const navRow = new ActionRowBuilder<ButtonBuilder>();

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`admin_panel_${scopePrefix}_page_${currentPage - 1}`)
      .setLabel(PAGINATION_DEFAULTS.prevLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0)
  );

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId('admin_panel_page_indicator')
      .setLabel(PAGINATION_DEFAULTS.pageFormat(currentPage + 1, totalPages))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`admin_panel_${scopePrefix}_page_${currentPage + 1}`)
      .setLabel(PAGINATION_DEFAULTS.nextLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages - 1)
  );

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId('admin_panel_close')
      .setLabel('Close')
      .setEmoji('✖')
      .setStyle(ButtonStyle.Danger)
  );

  container.addActionRowComponents(navRow);

  return createV2Response([container]);
}

/**
 * Generate category detail view showing all panels in a category
 */
function generateCategoryView(
  allItems: PanelListItem[],
  config: PanelManagerConfig,
  category: string,
  page: number = 0,
  scope?: 'system' | 'guild'
): PanelResponse {
  const categoryItems = allItems.filter(item => item.category === category);

  // Pagination for panels within category
  const itemsPerPage = 8;
  const totalItems = categoryItems.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const startIdx = currentPage * itemsPerPage;
  const pageItems = categoryItems.slice(startIdx, startIdx + itemsPerPage);

  // Check if category requires a warning
  const hasWarning = categoryRequiresWarning(category);

  // Build V2 container - use warning color for categories with warnings
  const container = new ContainerBuilder()
    .setAccentColor(hasWarning ? V2Colors.warning : (scope === 'system' ? V2Colors.danger : V2Colors.primary));

  // Title
  const categoryTitle = hasWarning ? `# ⚠️ ${category}` : `# ${category}`;
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(categoryTitle)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Add each panel as a section with direct access button
  // Include category in button ID so return navigation knows where to go back
  const scopePrefix = scope || 'guild';
  const encodedCategory = encodeURIComponent(category);
  for (const item of pageItems) {
    const section = new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**${item.icon} ${item.name}**`)
      )
      .setButtonAccessory(
        new ButtonBuilder()
          .setCustomId(`admin_panel_${scopePrefix}_open_${item.id}_fromcat_${encodedCategory}`)
          .setLabel('Open')
          .setStyle(ButtonStyle.Primary)
      );

    container.addSectionComponents(section);
  }

  // Footer
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# ${totalItems} panels`)
  );

  // Navigation row
  const navRow = new ActionRowBuilder<ButtonBuilder>();

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`admin_panel_${scopePrefix}_cat_${encodeURIComponent(category)}_${currentPage - 1}`)
      .setLabel(PAGINATION_DEFAULTS.prevLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0)
  );

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId('admin_panel_cat_page_indicator')
      .setLabel(PAGINATION_DEFAULTS.pageFormat(currentPage + 1, totalPages))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`admin_panel_${scopePrefix}_cat_${encodeURIComponent(category)}_${currentPage + 1}`)
      .setLabel(PAGINATION_DEFAULTS.nextLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages - 1)
  );

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`admin_panel_${scopePrefix}_menu`)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId('admin_panel_close')
      .setLabel('Close')
      .setEmoji('✖')
      .setStyle(ButtonStyle.Danger)
  );

  container.addActionRowComponents(navRow);

  return createV2Response([container]);
}
