// Panel Response Utilities - Utilities for manipulating panel responses

import {
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ContainerBuilder,
  MessageFlags,
} from 'discord.js';
import { PanelContext, PanelResponse, isV2Response } from '../../../types/panelTypes';
import { DISCORD_MAX_COMPONENT_ROWS } from '../../../constants';
import {
  createContainer,
  createTitledContainer,
  createV2Response,
  createSeparator,
  createButtonRow,
  createBackButton,
  V2Colors,
  createText,
} from './v2';

/**
 * Create a return button for panel navigation
 * Button ID and label change based on access method and navigation context
 */
export function createReturnButton(context: PanelContext): ButtonBuilder | null {
  // Only create return buttons for panel/web UI access methods
  if (context.accessMethod === 'direct_command') {
    return null;
  }

  // Generate button ID from access method
  // Use new admin_panel_{scope}_back format for guild/system panels
  let buttonId: string;
  let label: string;

  switch (context.accessMethod) {
    case 'system_panel':
      buttonId = 'admin_panel_system_back';
      label = 'Return to System Panel Menu';
      break;
    case 'guild_panel':
      buttonId = 'admin_panel_guild_back';
      label = 'Return to Guild Panel Menu';
      break;
    case 'web_ui':
      buttonId = 'web_ui_refresh';
      label = 'Return to Panel List';
      break;
    default:
      buttonId = `${context.accessMethod}_refresh`;
      label = 'Return';
  }

  return new ButtonBuilder()
    .setCustomId(buttonId)
    .setLabel(label)
    .setStyle(ButtonStyle.Secondary);
}

/**
 * Create a close button for the INJECTED navigation row
 * Only shown when accessed via panel systems (guild_panel/system_panel)
 * @internal Used by injectReturnButtonIfNeeded
 */
function createInjectedCloseButton(context: PanelContext): ButtonBuilder | null {
  // Only create close buttons for panel access methods (not web_ui or direct_command)
  if (context.accessMethod === 'direct_command' || context.accessMethod === 'web_ui') {
    return null;
  }

  return new ButtonBuilder()
    .setCustomId('admin_panel_close')
    .setLabel('Close')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('✖');
}

/**
 * Standard close button for panels to use
 *
 * This function is CONDITIONAL based on access method:
 * - direct_command: Returns the close button (panel shows its own close)
 * - guild_panel/system_panel: Returns null (injected row handles close)
 * - web_ui: Returns null (web UI has its own close mechanism)
 *
 * Usage in panel render:
 * ```typescript
 * const closeBtn = createPanelCloseButton(context);
 * if (closeBtn) {
 *   actionRow.addComponents(closeBtn);
 * }
 * ```
 *
 * Handler is registered by guildPanel.ts with timeoutMs: null
 */
export function createPanelCloseButton(context: PanelContext): ButtonBuilder | null {
  // Only show close button for direct command access
  // For panel access methods, the injected row handles the close button
  if (context.accessMethod !== 'direct_command') {
    return null;
  }

  return new ButtonBuilder()
    .setCustomId('admin_panel_close')
    .setLabel('Close')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('✖');
}

/**
 * Inject a return button into panel response if accessed via panel list or web UI
 * Works for both V1 (embeds + ActionRows) and V2 (Containers) responses
 */
export function injectReturnButtonIfNeeded(response: PanelResponse, context: PanelContext): PanelResponse {
  // If response is null/undefined, return as-is (modal consumption case)
  if (!response) {
    return response;
  }

  // Only inject return button if accessed via panel systems (not direct commands)
  const shouldInjectButton = ['system_panel', 'guild_panel', 'web_ui'].includes(context.accessMethod);
  if (!shouldInjectButton) {
    return response;
  }

  // Initialize components array if it doesn't exist
  if (!response.components) {
    response.components = [];
  }

  // Check for V2 response
  if (isV2Response(response)) {
    return injectReturnButtonV2(response, context);
  }

  // V1 logic (traditional embeds + ActionRows)
  const hasReturnButton = response.components.some(row => {
    if (row instanceof ActionRowBuilder) {
      const components = (row as any).components || [];
      return components.some((comp: any) => {
        const customId = comp.data?.custom_id;
        return customId === 'admin_panel_system_back' ||
               customId === 'admin_panel_guild_back' ||
               customId === 'web_ui_refresh';
      });
    }
    return false;
  });

  if (hasReturnButton) {
    return response;
  }

  // Check if we can add another row (Discord limit)
  if (response.components.length >= DISCORD_MAX_COMPONENT_ROWS) {
    console.warn(`[PanelResponseUtils] Cannot add return button - component limit reached (${DISCORD_MAX_COMPONENT_ROWS} rows)`);
    return response;
  }

  // Always create a NEW dedicated row for the return and close buttons
  const returnButton = createReturnButton(context);
  const closeButton = createInjectedCloseButton(context);

  if (returnButton || closeButton) {
    const navRow = new ActionRowBuilder<ButtonBuilder>();
    if (returnButton) navRow.addComponents(returnButton);
    if (closeButton) navRow.addComponents(closeButton);
    response.components.push(navRow);
  }

  return response;
}

/**
 * Inject return button into V2 response (adds to last container)
 */
function injectReturnButtonV2(response: PanelResponse, context: PanelContext): PanelResponse {
  if (!response.components || response.components.length === 0) {
    return response;
  }

  // Get the last container
  const lastContainer = response.components[response.components.length - 1];
  if (!(lastContainer instanceof ContainerBuilder)) {
    return response;
  }

  // Check if container already has a return button by looking at JSON data
  const containerData = lastContainer.toJSON() as any;
  const hasReturnButton = containerData.components?.some((comp: any) => {
    if (comp.type === 1) { // ActionRow
      return comp.components?.some((innerComp: any) => {
        const customId = innerComp.custom_id;
        return customId === 'admin_panel_system_back' ||
               customId === 'admin_panel_guild_back' ||
               customId === 'web_ui_refresh';
      });
    }
    return false;
  });

  if (hasReturnButton) {
    return response;
  }

  // Add separator and navigation buttons to the last container
  const returnButton = createReturnButton(context);
  const closeButton = createInjectedCloseButton(context);

  if (returnButton || closeButton) {
    lastContainer.addSeparatorComponents(createSeparator());
    const navRow = new ActionRowBuilder<ButtonBuilder>();
    if (returnButton) navRow.addComponents(returnButton);
    if (closeButton) navRow.addComponents(closeButton);
    lastContainer.addActionRowComponents(navRow);
  }

  return response;
}

/**
 * Create a standardized error message for panels.
 *
 * Returns a V2 components-based response so it can replace a V2 admin
 * panel message via `interaction.update()` without hitting Discord's
 * "MessageFlags.IS_COMPONENTS_V2 cannot be removed" error. V1→V2 upgrade
 * is allowed by Discord; V2→V1 downgrade is not.
 *
 * Optional `actions` are surfaced as a V2 action row inside the container,
 * for example a "Go subscribe" Link button on a tier-blocked response.
 */
export function createPanelError(
  title: string,
  message: string,
  details?: string,
  actions?: ButtonBuilder[]
): PanelResponse {
  const container = createTitledContainer(`❌ ${title}`, undefined, V2Colors.danger);
  container.addTextDisplayComponents(createText(message));
  if (details) {
    container.addTextDisplayComponents(createText(`\`\`\`${details}\`\`\``));
  }
  if (actions && actions.length > 0) {
    container.addSeparatorComponents(createSeparator());
    container.addActionRowComponents(createButtonRow(...actions));
  }
  return createV2Response([container]);
}

/**
 * Create a standardized success message for panels.
 * V2-native so it can replace V2 admin-panel messages via interaction.update().
 */
export function createPanelSuccess(
  title: string,
  message: string,
  details?: string
): PanelResponse {
  const container = createTitledContainer(`✅ ${title}`, undefined, V2Colors.success);
  container.addTextDisplayComponents(createText(message));
  if (details) {
    container.addTextDisplayComponents(createText(`\`\`\`${details}\`\`\``));
  }
  return createV2Response([container]);
}

/**
 * Create a standardized warning message for panels.
 * V2-native so it can replace V2 admin-panel messages via interaction.update().
 */
export function createPanelWarning(
  title: string,
  message: string,
  details?: string
): PanelResponse {
  const container = createTitledContainer(`⚠️ ${title}`, undefined, V2Colors.warning);
  container.addTextDisplayComponents(createText(message));
  if (details) {
    container.addTextDisplayComponents(createText(`\`\`\`${details}\`\`\``));
  }
  return createV2Response([container]);
}

/**
 * Create a standardized info message for panels.
 * V2-native so it can replace V2 admin-panel messages via interaction.update().
 */
export function createPanelInfo(
  title: string,
  message: string,
  details?: string
): PanelResponse {
  const container = createTitledContainer(`ℹ️ ${title}`, undefined, V2Colors.info);
  container.addTextDisplayComponents(createText(message));
  if (details) {
    container.addTextDisplayComponents(createText(`\`\`\`${details}\`\`\``));
  }
  return createV2Response([container]);
}

/**
 * Add a notification to a panel response
 * The notification will be shown as an ephemeral followUp on Discord
 * and as a toast/popup in the Web-UI
 */
export function withNotification(
  response: PanelResponse,
  type: 'error' | 'warning' | 'success' | 'info',
  message: string,
  title?: string
): PanelResponse {
  return {
    ...response,
    notification: { type, message, title }
  };
}

/**
 * Create a notification-only response (no panel update, just show notification)
 * Useful when you want to show an error but keep the panel in its current state
 */
export function createNotification(
  type: 'error' | 'warning' | 'success' | 'info',
  message: string,
  title?: string
): PanelResponse {
  return {
    notification: { type, message, title }
  };
}

/**
 * Close the panel with a success notification
 * Use this when a panel action completes successfully (e.g., created giveaway, published role assignment)
 *
 * On Discord: Shows an ephemeral success message, then deletes the panel (unless silent)
 * On Web-UI: Shows a success toast, then returns to panel list (always shown)
 *
 * @param message - The success message to display
 * @param title - Optional title for the notification
 * @param silent - If true, Discord won't show the ephemeral message (Web-UI still shows popup)
 */
export function closePanelWithSuccess(message: string, title?: string, silent?: boolean): PanelResponse {
  return {
    closePanel: true,
    notification: { type: 'success', message, title, silent }
  };
}

/**
 * Close the panel with a notification of any type
 * Use for non-success cases like info messages or warnings when closing
 *
 * @param type - The notification type
 * @param message - The message to display
 * @param title - Optional title for the notification
 * @param silent - If true, Discord won't show the ephemeral message (Web-UI still shows popup)
 */
export function closePanelWithNotification(
  type: 'error' | 'warning' | 'success' | 'info',
  message: string,
  title?: string,
  silent?: boolean
): PanelResponse {
  return {
    closePanel: true,
    notification: { type, message, title, silent }
  };
}
