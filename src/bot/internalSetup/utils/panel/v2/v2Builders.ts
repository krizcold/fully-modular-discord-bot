/**
 * V2 Component Builder Helpers
 *
 * Provides convenience functions for building Discord Components V2 layouts.
 * These wrap the discord.js builders with sensible defaults and common patterns.
 */

import {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ThumbnailBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  ButtonStyle,
  SeparatorSpacingSize,
  MessageFlags,
} from 'discord.js';
import { PanelResponse } from '@bot/types/panelTypes';

// ============================================================================
// Colors - Common accent colors for containers
// ============================================================================

export const V2Colors = {
  primary: 0x5865F2,    // Discord Blurple
  success: 0x57F287,    // Green
  warning: 0xFEE75C,    // Yellow
  danger: 0xED4245,     // Red
  info: 0x5865F2,       // Blue (same as primary)
  secondary: 0x99AAB5,  // Gray
} as const;

// ============================================================================
// Container Helpers
// ============================================================================

/**
 * Create a basic container with optional accent color
 */
export function createContainer(accentColor?: number): ContainerBuilder {
  const container = new ContainerBuilder();
  if (accentColor !== undefined) {
    container.setAccentColor(accentColor);
  }
  return container;
}

/**
 * Create a container with title and description
 */
export function createTitledContainer(
  title: string,
  description?: string,
  accentColor: number = V2Colors.primary
): ContainerBuilder {
  const container = createContainer(accentColor);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${title}`)
  );
  if (description) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(description)
    );
  }
  return container;
}

// ============================================================================
// Section Helpers
// ============================================================================

/**
 * Create a section with text content and optional button accessory
 */
export function createSection(
  textContent: string | string[],
  buttonAccessory?: ButtonBuilder
): SectionBuilder {
  const section = new SectionBuilder();

  // Add text displays
  const texts = Array.isArray(textContent) ? textContent : [textContent];
  texts.slice(0, 3).forEach(text => {
    section.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  });

  // Add button accessory if provided
  if (buttonAccessory) {
    section.setButtonAccessory(buttonAccessory);
  }

  return section;
}

/**
 * Create a section with thumbnail accessory
 */
export function createSectionWithThumbnail(
  textContent: string | string[],
  thumbnailUrl: string,
  thumbnailDescription?: string
): SectionBuilder {
  const section = new SectionBuilder();

  // Add text displays
  const texts = Array.isArray(textContent) ? textContent : [textContent];
  texts.slice(0, 3).forEach(text => {
    section.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  });

  // Add thumbnail
  const thumbnail = new ThumbnailBuilder().setURL(thumbnailUrl);
  if (thumbnailDescription) {
    thumbnail.setDescription(thumbnailDescription);
  }
  section.setThumbnailAccessory(thumbnail);

  return section;
}

// ============================================================================
// Text Display Helpers
// ============================================================================

/**
 * Create a text display component
 */
export function createText(content: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(content);
}

/**
 * Create a header text (markdown #)
 */
export function createHeader(text: string, level: 1 | 2 | 3 = 1): TextDisplayBuilder {
  const prefix = '#'.repeat(level);
  return new TextDisplayBuilder().setContent(`${prefix} ${text}`);
}

// ============================================================================
// Separator Helpers
// ============================================================================

/**
 * Create a separator with optional spacing
 */
export function createSeparator(
  spacing: SeparatorSpacingSize = SeparatorSpacingSize.Small,
  divider: boolean = true
): SeparatorBuilder {
  const separator = new SeparatorBuilder().setSpacing(spacing);
  if (!divider) {
    separator.setDivider(false);
  }
  return separator;
}

// ============================================================================
// Action Row Helpers
// ============================================================================

/**
 * Create an action row with buttons
 */
export function createButtonRow(...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

/**
 * Create an action row with a select menu
 */
export function createSelectRow(select: StringSelectMenuBuilder): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

// ============================================================================
// Common Button Patterns
// ============================================================================

/**
 * Create a standard button
 */
export function createButton(
  customId: string,
  label: string,
  style: ButtonStyle = ButtonStyle.Secondary
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(style);
}

/**
 * Create a cancel button
 */
export function createCancelButton(customId: string): ButtonBuilder {
  return createButton(customId, 'Cancel', ButtonStyle.Secondary);
}

/**
 * Create a back button
 */
export function createBackButton(customId: string): ButtonBuilder {
  return createButton(customId, 'Back', ButtonStyle.Secondary);
}

/**
 * Create navigation buttons (prev/page/next)
 */
export function createPaginationButtons(
  basePanelId: string,
  currentPage: number,
  totalPages: number
): ButtonBuilder[] {
  return [
    createButton(`panel_${basePanelId}_btn_prev`, 'Prev', ButtonStyle.Secondary)
      .setDisabled(currentPage <= 1),
    createButton(`panel_${basePanelId}_btn_page`, `${currentPage}/${totalPages}`, ButtonStyle.Secondary)
      .setDisabled(true),
    createButton(`panel_${basePanelId}_btn_next`, 'Next', ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages),
  ];
}

// ============================================================================
// Panel Response Helpers
// ============================================================================

/**
 * Create a V2 panel response
 * Automatically adds IsComponentsV2 flag
 */
export function createV2Response(
  containers: ContainerBuilder[],
  ephemeral: boolean = true
): PanelResponse {
  let flags = MessageFlags.IsComponentsV2;
  if (ephemeral) {
    flags |= 64; // Ephemeral flag
  }
  return {
    components: containers,
    flags,
  };
}

/**
 * Create a simple V2 panel with title, content, and optional action buttons
 */
export function createSimpleV2Panel(
  title: string,
  content: string,
  buttons?: ButtonBuilder[],
  accentColor: number = V2Colors.primary
): PanelResponse {
  const container = createTitledContainer(title, content, accentColor);

  if (buttons && buttons.length > 0) {
    container.addSeparatorComponents(createSeparator());
    container.addActionRowComponents(createButtonRow(...buttons));
  }

  return createV2Response([container]);
}

/**
 * Create a V2 error panel
 */
export function createV2Error(
  message: string,
  details?: string,
  backButtonId?: string
): PanelResponse {
  const container = createTitledContainer('Error', undefined, V2Colors.danger);
  container.addTextDisplayComponents(createText(message));
  if (details) {
    container.addTextDisplayComponents(createText(`\`\`\`${details}\`\`\``));
  }

  if (backButtonId) {
    container.addSeparatorComponents(createSeparator());
    container.addActionRowComponents(
      createButtonRow(createBackButton(backButtonId))
    );
  }

  return createV2Response([container]);
}

/**
 * Create a V2 success panel
 */
export function createV2Success(
  message: string,
  backButtonId?: string
): PanelResponse {
  const container = createTitledContainer('Success', message, V2Colors.success);

  if (backButtonId) {
    container.addSeparatorComponents(createSeparator());
    container.addActionRowComponents(
      createButtonRow(createBackButton(backButtonId))
    );
  }

  return createV2Response([container]);
}

/**
 * Create a V2 warning panel
 */
export function createV2Warning(
  message: string,
  backButtonId?: string
): PanelResponse {
  const container = createTitledContainer('Warning', message, V2Colors.warning);

  if (backButtonId) {
    container.addSeparatorComponents(createSeparator());
    container.addActionRowComponents(
      createButtonRow(createBackButton(backButtonId))
    );
  }

  return createV2Response([container]);
}

/**
 * Create a V2 info panel
 */
export function createV2Info(
  title: string,
  message: string,
  backButtonId?: string
): PanelResponse {
  const container = createTitledContainer(title, message, V2Colors.info);

  if (backButtonId) {
    container.addSeparatorComponents(createSeparator());
    container.addActionRowComponents(
      createButtonRow(createBackButton(backButtonId))
    );
  }

  return createV2Response([container]);
}
