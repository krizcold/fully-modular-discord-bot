/**
 * Unified List System for Discord Panels
 *
 * Provides 4 list display modes:
 * 1. Detailed - SectionBuilder per item with Edit button accessory
 * 2. Compact - Single TextDisplayBuilder with dropdown selector
 * 3. Both - Switch View toggle between detailed and compact
 * 4. Simple - TextDisplayBuilder per item (basic pagination only)
 */

import {
  ContainerBuilder,
  TextDisplayBuilder,
  SectionBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  Client,
  Guild,
} from 'discord.js';
import { paginate, PAGINATION_DEFAULTS, PaginatedResult } from './paginationUtils';
import { resolveEmojisInText, simplifyEmojisForPlainText } from '../emojiHandler';

/**
 * View mode options for list display
 */
export type ListViewMode = 'detailed' | 'compact' | 'both' | 'simple';

/**
 * Current view state (for 'both' mode)
 */
export type ActiveView = 'detailed' | 'compact';

/**
 * Format result for detailed view items
 */
export interface DetailedItemFormat {
  /** Text lines for the section (supports markdown) */
  lines: string[];
  /** Override edit button label (default: 'Edit') */
  buttonLabel?: string;
  /** Override button style (default: Secondary) */
  buttonStyle?: ButtonStyle;
  /** Disable the button */
  buttonDisabled?: boolean;
}

/**
 * Format result for dropdown options (compact view)
 */
export interface DropdownOptionFormat {
  /** Option label (max 100 chars) */
  label: string;
  /** Option value (the item identifier) */
  value: string;
  /** Optional description (max 100 chars) */
  description?: string;
}

/**
 * State for list pagination and view mode
 */
export interface ListState {
  /** Current page (0-indexed) */
  currentPage: number;
  /** Current active view (for 'both' mode) */
  activeView: ActiveView;
}

/**
 * Configuration for list display
 */
export interface ListConfig<T> {
  /** Panel ID for button custom IDs */
  panelId: string;

  /** View mode: 'detailed', 'compact', 'both', or 'simple' */
  viewMode: ListViewMode;

  /** Default view when mode is 'both' (default: 'detailed') */
  defaultView?: ActiveView;

  /** Items per page in detailed view (default: 5) */
  detailedPerPage?: number;

  /** Items per page in compact view (default: 15) */
  compactPerPage?: number;

  /** Items per page in simple view (default: 6) */
  simplePerPage?: number;

  /**
   * Format item for detailed view (SectionBuilder with Edit button)
   * @param item The item to format
   * @param globalIndex The item's global index (0-based, across all pages)
   * @param state Current list state
   */
  formatDetailed: (item: T, globalIndex: number, state: ListState) => DetailedItemFormat;

  /**
   * Format item for compact view (single text line)
   * @param item The item to format
   * @param globalIndex The item's global index (0-based, across all pages)
   * @param state Current list state
   */
  formatCompact: (item: T, globalIndex: number, state: ListState) => string;

  /**
   * Format dropdown option for compact view (optional)
   * If not provided, uses globalIndex as value and truncated formatCompact as label
   */
  formatDropdownOption?: (item: T, globalIndex: number, state: ListState) => DropdownOptionFormat;

  /**
   * Format item for simple view (TextDisplayBuilder per item)
   * If not provided, uses formatCompact
   */
  formatSimple?: (item: T, globalIndex: number, state: ListState) => string;

  /** Edit button label in detailed view (default: 'Edit') */
  editButtonLabel?: string;

  /** Edit button style in detailed view (default: Secondary) */
  editButtonStyle?: ButtonStyle;

  /** Dropdown placeholder in compact view (default: 'Select item to edit...') */
  dropdownPlaceholder?: string;

  /** Custom dropdown ID (default: panel_{panelId}_dropdown_select) */
  dropdownCustomId?: string;

  /** Show view toggle button when mode is 'both' (default: true) */
  showViewToggle?: boolean;

  /** View toggle button label (default: 'Switch View') */
  viewToggleLabel?: string;

  /** Extra buttons to add after pagination (before toggle) */
  extraButtons?: ButtonBuilder[];

  /** Empty state message (default: 'No items found.') */
  emptyMessage?: string;

  /** Discord client (required for emoji resolution) */
  client: Client;

  /** Guild for emoji resolution (null for global/DM context) */
  guild?: Guild | null;
}

/**
 * Result of handling a list button interaction
 */
export interface ListButtonResult {
  /** Whether this was a list-related button */
  handled: boolean;
  /** New state after handling */
  newState: ListState;
  /** Action type if any */
  action?: 'page_change' | 'view_toggle' | 'item_select';
  /** Selected item index (for item_select action) */
  selectedIndex?: number;
}

// Default values
const DEFAULTS = {
  detailedPerPage: 5,
  compactPerPage: 15,
  simplePerPage: 6,
  editButtonLabel: 'Edit',
  editButtonStyle: ButtonStyle.Secondary,
  dropdownPlaceholder: 'Select item to edit...',
  viewToggleLabel: 'Switch View',
  emptyMessage: 'No items found.',
  defaultView: 'detailed' as ActiveView,
};

/**
 * Get items per page based on current view
 */
function getItemsPerPage<T>(config: ListConfig<T>, activeView: ActiveView): number {
  if (config.viewMode === 'simple') {
    return config.simplePerPage ?? DEFAULTS.simplePerPage;
  }
  if (config.viewMode === 'compact' || activeView === 'compact') {
    return config.compactPerPage ?? DEFAULTS.compactPerPage;
  }
  return config.detailedPerPage ?? DEFAULTS.detailedPerPage;
}

/**
 * Build button custom ID prefix for list
 * Includes view mode for 'both' mode to preserve state without external storage
 */
function getButtonPrefix<T>(config: ListConfig<T>, state: ListState): string {
  const base = `panel_${config.panelId}_btn_list`;
  // For 'both' mode, encode current view in prefix so state persists
  if (config.viewMode === 'both') {
    return `${base}_${state.activeView === 'compact' ? 'c' : 'd'}`;
  }
  return base;
}

/**
 * Build detailed view (SectionBuilder per item with Edit button)
 */
function buildDetailedView<T>(
  container: ContainerBuilder,
  items: T[],
  paginated: PaginatedResult<T>,
  state: ListState,
  config: ListConfig<T>
): void {
  const startIndex = state.currentPage * (config.detailedPerPage ?? DEFAULTS.detailedPerPage);
  const editLabel = config.editButtonLabel ?? DEFAULTS.editButtonLabel;
  const editStyle = config.editButtonStyle ?? DEFAULTS.editButtonStyle;

  paginated.items.forEach((item, idx) => {
    const globalIndex = startIndex + idx;
    const formatted = config.formatDetailed(item, globalIndex, state);

    const section = new SectionBuilder();

    // Add text as single component (one TextDisplayBuilder per item)
    // Always resolve emojis in user content
    const text = formatted.lines.join('\n');
    const resolvedText = resolveEmojisInText(text, config.client, config.guild);
    section.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(resolvedText)
    );

    // Add edit button accessory (per-item format can override label/style)
    section.setButtonAccessory(
      new ButtonBuilder()
        .setCustomId(`${getButtonPrefix(config, state)}_edit_${globalIndex}`)
        .setLabel(formatted.buttonLabel ?? editLabel)
        .setStyle(formatted.buttonStyle ?? editStyle)
        .setDisabled(formatted.buttonDisabled ?? false)
    );

    container.addSectionComponents(section);
  });
}

/**
 * Build compact view (single TextDisplayBuilder with dropdown)
 */
function buildCompactView<T>(
  container: ContainerBuilder,
  items: T[],
  paginated: PaginatedResult<T>,
  state: ListState,
  config: ListConfig<T>
): void {
  const startIndex = state.currentPage * (config.compactPerPage ?? DEFAULTS.compactPerPage);

  // Build text block with all items
  const lines = paginated.items.map((item, idx) => {
    const globalIndex = startIndex + idx;
    return config.formatCompact(item, globalIndex, state);
  });

  // Always resolve emojis in user content
  const text = lines.join('\n');
  const resolvedText = resolveEmojisInText(text, config.client, config.guild);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(resolvedText)
  );

  // Build dropdown for selection
  // Use simplifyEmojisForPlainText since dropdowns can't render custom emojis
  const dropdownOptions = paginated.items.map((item, idx) => {
    const globalIndex = startIndex + idx;

    if (config.formatDropdownOption) {
      const opt = config.formatDropdownOption(item, globalIndex, state);
      // Simplify custom emojis to :shortcode: format (dropdowns can't render <:name:id>)
      const simplifiedLabel = simplifyEmojisForPlainText(opt.label);
      const optionBuilder = new StringSelectMenuOptionBuilder()
        .setLabel(simplifiedLabel.substring(0, 100))
        .setValue(opt.value);
      if (opt.description) {
        const simplifiedDesc = simplifyEmojisForPlainText(opt.description);
        optionBuilder.setDescription(simplifiedDesc.substring(0, 100));
      }
      return optionBuilder;
    }

    // Default: use index as value, truncated compact format as label
    const compactLine = config.formatCompact(item, globalIndex, state);
    // Simplify emojis, then strip markdown for dropdown
    const simplifiedLine = simplifyEmojisForPlainText(compactLine);
    const cleanLine = simplifiedLine.replace(/[`*_~|]/g, '').substring(0, 100);
    return new StringSelectMenuOptionBuilder()
      .setLabel(cleanLine || `Item ${globalIndex + 1}`)
      .setValue(String(globalIndex));
  });

  const dropdownId = config.dropdownCustomId ?? `panel_${config.panelId}_dropdown_select`;
  const dropdown = new StringSelectMenuBuilder()
    .setCustomId(dropdownId)
    .setPlaceholder(config.dropdownPlaceholder ?? DEFAULTS.dropdownPlaceholder)
    .addOptions(dropdownOptions);

  container.addActionRowComponents(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(dropdown)
  );
}

/**
 * Build simple view (TextDisplayBuilder per item)
 */
function buildSimpleView<T>(
  container: ContainerBuilder,
  items: T[],
  paginated: PaginatedResult<T>,
  state: ListState,
  config: ListConfig<T>
): void {
  const startIndex = state.currentPage * (config.simplePerPage ?? DEFAULTS.simplePerPage);
  const formatFn = config.formatSimple ?? config.formatCompact;

  // Build all items as single text block
  const lines = paginated.items.map((item, idx) => {
    const globalIndex = startIndex + idx;
    return formatFn(item, globalIndex, state);
  });

  // Always resolve emojis in user content
  const text = lines.join('\n\n');
  const resolvedText = resolveEmojisInText(text, config.client, config.guild);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(resolvedText)
  );
}

/**
 * Build pagination and action buttons row
 */
function buildPaginationRow<T>(
  container: ContainerBuilder,
  paginated: PaginatedResult<T>,
  state: ListState,
  config: ListConfig<T>
): void {
  const prefix = getButtonPrefix(config, state);
  const buttons: ButtonBuilder[] = [];

  // Pagination buttons (always show, disabled at boundaries)
  buttons.push(
    new ButtonBuilder()
      .setCustomId(`${prefix}_prev_${state.currentPage}`)
      .setLabel(PAGINATION_DEFAULTS.prevLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!paginated.hasPrev),
    new ButtonBuilder()
      .setCustomId(`${prefix}_page_${state.currentPage}`)
      .setLabel(PAGINATION_DEFAULTS.pageFormat(paginated.currentPage + 1, paginated.totalPages))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`${prefix}_next_${state.currentPage}`)
      .setLabel(PAGINATION_DEFAULTS.nextLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!paginated.hasNext)
  );

  // Extra buttons
  if (config.extraButtons) {
    buttons.push(...config.extraButtons);
  }

  // View toggle button (only for 'both' mode)
  // Encodes current activeView in button ID so state persists without external storage
  if (config.viewMode === 'both' && config.showViewToggle !== false) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${prefix}_toggle_${state.activeView}`)
        .setLabel(config.viewToggleLabel ?? DEFAULTS.viewToggleLabel)
        .setStyle(ButtonStyle.Secondary)
    );
  }

  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)
  );
}

/**
 * Build list view into container
 *
 * @param container The container to add list components to
 * @param items All items to display (not paginated)
 * @param state Current list state (page, view mode)
 * @param config List configuration
 */
export function buildListView<T>(
  container: ContainerBuilder,
  items: T[],
  state: ListState,
  config: ListConfig<T>
): void {
  // Handle empty state
  if (items.length === 0) {
    const emptyMsg = config.emptyMessage ?? DEFAULTS.emptyMessage;
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(resolveEmojisInText(emptyMsg, config.client, config.guild))
    );

    // Still show pagination (disabled) for consistency
    const emptyPaginated: PaginatedResult<T> = {
      items: [],
      currentPage: 0,
      totalPages: 1,
      totalItems: 0,
      hasNext: false,
      hasPrev: false,
    };
    buildPaginationRow(container, emptyPaginated, state, config);
    return;
  }

  // Determine active view
  const activeView = config.viewMode === 'both'
    ? state.activeView
    : (config.viewMode === 'compact' ? 'compact' : 'detailed');

  // Calculate items per page based on view
  const itemsPerPage = getItemsPerPage(config, activeView);

  // Paginate items
  const paginated = paginate(items, state.currentPage, {
    itemsPerPage,
    buttonPrefix: getButtonPrefix(config, state),
  });

  // Update state if page is out of bounds
  if (paginated.currentPage !== state.currentPage) {
    state.currentPage = paginated.currentPage;
  }

  // Build view based on mode
  if (config.viewMode === 'simple') {
    buildSimpleView(container, items, paginated, state, config);
  } else if (config.viewMode === 'compact' || (config.viewMode === 'both' && activeView === 'compact')) {
    buildCompactView(container, items, paginated, state, config);
  } else {
    buildDetailedView(container, items, paginated, state, config);
  }

  // Add page indicator text
  const viewLabel = config.viewMode === 'both'
    ? ` - ${activeView === 'compact' ? 'Compact' : 'Detailed'} view`
    : '';
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# Page ${paginated.currentPage + 1} of ${paginated.totalPages}${viewLabel}`
    )
  );

  // Build pagination and action buttons
  buildPaginationRow(container, paginated, state, config);
}

/**
 * Handle list button interactions
 *
 * @param buttonId The button ID (after panel_xxx_btn_ prefix stripped)
 * @param items All items (needed for bounds checking)
 * @param state Current list state
 * @param config List configuration
 * @returns Result with new state and action, or null if not a list button
 */
export function handleListButton<T>(
  buttonId: string,
  items: T[],
  state: ListState,
  config: ListConfig<T>
): ListButtonResult | null {
  // Check if this is a list button
  if (!buttonId.startsWith('list_')) {
    return null;
  }

  let listButtonId = buttonId.replace('list_', '');
  const newState = { ...state };

  // For 'both' mode, extract encoded view from prefix (d_ or c_)
  if (config.viewMode === 'both') {
    if (listButtonId.startsWith('d_')) {
      newState.activeView = 'detailed';
      listButtonId = listButtonId.substring(2);
    } else if (listButtonId.startsWith('c_')) {
      newState.activeView = 'compact';
      listButtonId = listButtonId.substring(2);
    }
  }

  // Handle prev button
  if (listButtonId.startsWith('prev_')) {
    newState.currentPage = Math.max(0, state.currentPage - 1);
    return { handled: true, newState, action: 'page_change' };
  }

  // Handle next button
  if (listButtonId.startsWith('next_')) {
    const itemsPerPage = getItemsPerPage(config, newState.activeView);
    const totalPages = Math.max(1, Math.ceil(items.length / itemsPerPage));
    newState.currentPage = Math.min(totalPages - 1, state.currentPage + 1);
    return { handled: true, newState, action: 'page_change' };
  }

  // Handle view toggle (button ID encodes current view: toggle_detailed or toggle_compact)
  if (listButtonId.startsWith('toggle_')) {
    const currentView = listButtonId.replace('toggle_', '') as ActiveView;
    newState.activeView = currentView === 'compact' ? 'detailed' : 'compact';
    newState.currentPage = 0; // Reset to first page when switching views
    return { handled: true, newState, action: 'view_toggle' };
  }

  // Handle item edit (detailed view)
  if (listButtonId.startsWith('edit_')) {
    const index = parseInt(listButtonId.replace('edit_', ''), 10);
    if (!isNaN(index) && index >= 0 && index < items.length) {
      return { handled: true, newState, action: 'item_select', selectedIndex: index };
    }
  }

  return null;
}

/**
 * Handle list dropdown selection
 * Returns same structure as handleListButton for unified handling
 *
 * @param selectedValue The selected dropdown value
 * @param items All items
 * @param state Current list state
 * @returns Result with action and selected index, or null if invalid
 */
export function handleListDropdown<T>(
  selectedValue: string,
  items: T[],
  state: ListState
): ListButtonResult | null {
  const index = parseInt(selectedValue, 10);
  if (!isNaN(index) && index >= 0 && index < items.length) {
    return {
      handled: true,
      newState: { ...state },
      action: 'item_select',
      selectedIndex: index,
    };
  }
  return null;
}

/**
 * Create initial list state
 */
export function createListState(defaultView: ActiveView = 'detailed'): ListState {
  return {
    currentPage: 0,
    activeView: defaultView,
  };
}
