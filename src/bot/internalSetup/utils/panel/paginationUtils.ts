/**
 * Reusable Pagination System for Discord Panels
 *
 * This module provides generic pagination utilities that can be used
 * by any panel or command that needs to paginate through lists of items.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

/**
 * Default pagination button labels (emoji-style arrows)
 */
export const PAGINATION_DEFAULTS = {
  prevLabel: '◀️',
  nextLabel: '▶️',
  pageFormat: (current: number, total: number) => `${current}/${total}`,
} as const;

/**
 * Configuration for pagination behavior
 */
export interface PaginationConfig {
  /** Number of items to show per page */
  itemsPerPage: number;
  /** Prefix for button custom IDs (e.g., 'gw_main' → 'gw_main_prev', 'gw_main_next') */
  buttonPrefix: string;
}

/**
 * Optional label overrides for pagination buttons
 */
export interface PaginationLabelOptions {
  /** Label for previous button (default: ◀️) */
  prevLabel?: string;
  /** Label for next button (default: ▶️) */
  nextLabel?: string;
  /** Custom page format function (default: "1/3") */
  pageFormat?: (current: number, total: number) => string;
}

/**
 * Result of paginating a list of items
 */
export interface PaginatedResult<T> {
  /** Items for the current page */
  items: T[];
  /** Current page number (0-indexed) */
  currentPage: number;
  /** Total number of pages */
  totalPages: number;
  /** Total number of items across all pages */
  totalItems: number;
  /** Whether there is a next page */
  hasNext: boolean;
  /** Whether there is a previous page */
  hasPrev: boolean;
}

/**
 * Paginate a list of items
 *
 * @param items - The full list of items to paginate
 * @param page - The requested page number (0-indexed)
 * @param config - Pagination configuration
 * @returns Paginated result with items for the current page and metadata
 */
export function paginate<T>(
  items: T[],
  page: number,
  config: PaginationConfig
): PaginatedResult<T> {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / config.itemsPerPage));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const start = currentPage * config.itemsPerPage;
  const pageItems = items.slice(start, start + config.itemsPerPage);

  return {
    items: pageItems,
    currentPage,
    totalPages,
    totalItems,
    hasNext: currentPage < totalPages - 1,
    hasPrev: currentPage > 0,
  };
}

/**
 * Build a pagination row with Previous/Page indicator/Next buttons
 *
 * @param result - The paginated result from paginate()
 * @param buttonPrefix - Prefix for button custom IDs
 * @param extraButtons - Optional additional buttons to add at the end (e.g., Back button)
 * @param labelOptions - Optional label overrides (defaults to emoji arrows)
 * @returns ActionRow with pagination buttons
 */
export function buildPaginationRow(
  result: PaginatedResult<any>,
  buttonPrefix: string,
  extraButtons?: ButtonBuilder[],
  labelOptions?: PaginationLabelOptions
): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();

  // Use defaults with optional overrides
  const prevLabel = labelOptions?.prevLabel ?? PAGINATION_DEFAULTS.prevLabel;
  const nextLabel = labelOptions?.nextLabel ?? PAGINATION_DEFAULTS.nextLabel;
  const pageFormat = labelOptions?.pageFormat ?? PAGINATION_DEFAULTS.pageFormat;

  // Previous button
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`${buttonPrefix}_prev_${result.currentPage}`)
      .setLabel(prevLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!result.hasPrev)
  );

  // Page indicator (non-interactive)
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`${buttonPrefix}_page_${result.currentPage}`)
      .setLabel(pageFormat(result.currentPage + 1, result.totalPages))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );

  // Next button
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`${buttonPrefix}_next_${result.currentPage}`)
      .setLabel(nextLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!result.hasNext)
  );

  // Extra buttons (e.g., Back button)
  if (extraButtons) {
    extraButtons.forEach(btn => row.addComponents(btn));
  }

  return row;
}

/**
 * Parse page number from a pagination button custom ID
 *
 * @param customId - The button's custom ID
 * @param buttonPrefix - The expected button prefix
 * @returns The new page number to navigate to, or null if not a pagination button
 */
export function parsePageFromCustomId(customId: string, buttonPrefix: string): number | null {
  // Check for prev button: {prefix}_prev_{currentPage}
  const prevMatch = customId.match(new RegExp(`^${escapeRegex(buttonPrefix)}_prev_(\\d+)$`));
  if (prevMatch) {
    const currentPage = parseInt(prevMatch[1], 10);
    return currentPage - 1; // Go to previous page
  }

  // Check for next button: {prefix}_next_{currentPage}
  const nextMatch = customId.match(new RegExp(`^${escapeRegex(buttonPrefix)}_next_(\\d+)$`));
  if (nextMatch) {
    const currentPage = parseInt(nextMatch[1], 10);
    return currentPage + 1; // Go to next page
  }

  return null;
}

/**
 * Check if a custom ID is a pagination button for the given prefix
 */
export function isPaginationButton(customId: string, buttonPrefix: string): boolean {
  return parsePageFromCustomId(customId, buttonPrefix) !== null;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
