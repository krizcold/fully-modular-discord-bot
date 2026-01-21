/**
 * JSON Editor Subpanel - Reusable component for JSON editing
 */

import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { PanelContext, PanelResponse } from '@bot/types/panelTypes';
import { createV2Response, V2Colors } from '../panel/v2';
import {
  validateAndSanitizeJson,
  isDataEmpty,
  getDataTypeInfo,
  JsonValidationOptions,
} from './jsonUtils';
import {
  handleJsonUpload,
  handleJsonDownload,
  buildJsonEditModal,
  buildJsonUploadModal,
  canEditInModal,
} from './jsonPanelUtils';

const MAX_EDIT_SIZE = 4000;
const MAX_PREVIEW_LENGTH = 1200;
const MAX_PREVIEW_LINES = 30;
const MAX_TEMPLATE_LENGTH = 1000;
const MAX_TEMPLATE_LINES = 20;

/**
 * Truncate text by both character length and line count
 */
function truncatePreview(text: string, maxLength: number, maxLines: number): string {
  const lines = text.split('\n');

  // Check line limit first
  if (lines.length > maxLines) {
    const truncatedByLines = lines.slice(0, maxLines).join('\n');
    // Also check character limit on truncated result
    if (truncatedByLines.length > maxLength) {
      return truncatedByLines.substring(0, maxLength) + '\n... (truncated)';
    }
    return truncatedByLines + '\n... (truncated)';
  }

  // Check character limit
  if (text.length > maxLength) {
    return text.substring(0, maxLength) + '\n... (truncated)';
  }

  return text;
}

/**
 * Additional button configuration
 */
export interface JsonEditorButton {
  label: string;
  customId: string;
  style: ButtonStyle;
  disabled?: boolean;
  row?: 1 | 2;
}

/**
 * Configuration for the JSON editor subpanel
 */
export interface JsonEditorConfig {
  /** Parent panel ID (used for button/modal custom IDs) */
  panelId: string;
  /** Unique key for this data within the panel (used in button IDs) */
  dataKey: string;
  /** Title displayed in the editor (can include icon) */
  title: string;
  /** Additional info lines to display (module, file, description, etc.) */
  infoLines?: string[];
  /** Function to get current data */
  getData: () => any;
  /** Function to save data (can be async) */
  saveData: (data: any) => void | Promise<void>;
  /** Validation options for JSON parsing */
  validationOptions?: JsonValidationOptions;
  /** Template/example shown when data is empty */
  template?: any;
  /** Back button custom ID (optional) */
  backButtonId?: string;
  /** Accent color when has data (default: V2Colors.primary) */
  accentColor?: number;
  /** Accent color when empty (default: gray) */
  emptyAccentColor?: number;
  /** Additional buttons to add */
  extraButtons?: JsonEditorButton[];
  /** Whether file exists (for showing "Not created" vs "Empty") */
  fileExists?: boolean;
}

/**
 * Button action prefixes for the JSON editor
 */
const ACTIONS = {
  EDIT: 'jsonedit',
  UPLOAD: 'jsonupload',
  DOWNLOAD: 'jsondownload',
  REFRESH: 'jsonrefresh',
} as const;

/**
 * Build the custom ID for a JSON editor button
 */
function buildButtonId(config: JsonEditorConfig, action: string): string {
  return `panel_${config.panelId}_btn_${action}_${config.dataKey}`;
}

/**
 * Parse a button ID to extract action and dataKey
 */
function parseButtonId(buttonId: string): { action: string; dataKey: string } | null {
  for (const action of Object.values(ACTIONS)) {
    if (buttonId.startsWith(`${action}_`)) {
      return {
        action,
        dataKey: buttonId.substring(action.length + 1),
      };
    }
  }
  return null;
}

/**
 * Parse a modal ID to extract action and dataKey
 */
function parseModalId(modalId: string): { action: string; dataKey: string } | null {
  return parseButtonId(modalId);
}

/**
 * Build the JSON editor view container
 */
export function buildJsonEditorView(
  config: JsonEditorConfig,
  context: PanelContext
): ContainerBuilder {
  const data = config.getData();
  const fileExists = config.fileExists ?? (data !== null);
  const isEmpty = isDataEmpty(data);
  const hasData = fileExists && !isEmpty;

  const jsonString = data !== null && data !== undefined ? JSON.stringify(data, null, 2) : '';
  const jsonSize = jsonString.length;
  const canEdit = canEditInModal(data);

  const accentColor = hasData
    ? (config.accentColor ?? V2Colors.primary)
    : (config.emptyAccentColor ?? 0x95A5A6);

  const container = new ContainerBuilder().setAccentColor(accentColor);

  // Title
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${config.title}`)
  );

  // Info lines
  if (config.infoLines && config.infoLines.length > 0) {
    let infoText = config.infoLines.join('\n');

    // Add status line
    if (!fileExists) {
      const hasTemplate = config.template && !isDataEmpty(config.template);
      infoText += hasTemplate
        ? '\n**Status:** Not created *(template available)*'
        : '\n**Status:** Not created';
    } else if (isEmpty) {
      infoText += '\n**Status:** Empty';
    } else {
      infoText += `\n**Type:** ${getDataTypeInfo(data)}`;
      infoText += `\n**Size:** ${jsonSize.toLocaleString()} characters`;
    }

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(infoText)
    );
  } else {
    // Default status display when no info lines
    let statusText = '';
    if (!fileExists) {
      const hasTemplate = config.template && !isDataEmpty(config.template);
      statusText = hasTemplate ? '**Status:** No data *(template available)*' : '**Status:** No data';
    } else if (isEmpty) {
      statusText = '**Status:** Empty';
    } else {
      statusText = `**Type:** ${getDataTypeInfo(data)}\n**Size:** ${jsonSize.toLocaleString()} characters`;
    }
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(statusText)
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Template preview if empty and template available
  if ((!fileExists || isEmpty) && config.template && !isDataEmpty(config.template)) {
    const templateJson = JSON.stringify(config.template, null, 2);
    const truncatedTemplate = truncatePreview(templateJson, MAX_TEMPLATE_LENGTH, MAX_TEMPLATE_LINES);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Template/Example:**\n\`\`\`json\n${truncatedTemplate}\n\`\`\`\n` +
        `-# *This shows the expected data structure.*`
      )
    );

    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
    );
  }

  // Data preview if has data
  if (fileExists && !isEmpty) {
    const jsonPreview = truncatePreview(jsonString, MAX_PREVIEW_LENGTH, MAX_PREVIEW_LINES);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**Current Data:**\n\`\`\`json\n${jsonPreview}\n\`\`\``)
    );

    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
    );
  }

  // Row 1 buttons: Edit, Upload, Download + extra row 1 buttons
  const row1Buttons: ButtonBuilder[] = [
    new ButtonBuilder()
      .setCustomId(buildButtonId(config, ACTIONS.EDIT))
      .setLabel(canEdit ? 'Edit' : 'Edit (Too Large)')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!canEdit),
    new ButtonBuilder()
      .setCustomId(buildButtonId(config, ACTIONS.UPLOAD))
      .setLabel('Upload')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildButtonId(config, ACTIONS.DOWNLOAD))
      .setLabel('Download')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!fileExists || isEmpty),
  ];

  // Add extra row 1 buttons
  if (config.extraButtons) {
    for (const btn of config.extraButtons.filter(b => b.row === 1)) {
      row1Buttons.push(
        new ButtonBuilder()
          .setCustomId(btn.customId)
          .setLabel(btn.label)
          .setStyle(btn.style)
          .setDisabled(btn.disabled ?? false)
      );
    }
  }

  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(...row1Buttons.slice(0, 5))
  );

  // Row 2 buttons: Extra buttons (row 2) + Refresh + Back
  const row2Buttons: ButtonBuilder[] = [];

  // Add extra row 2 buttons first
  if (config.extraButtons) {
    for (const btn of config.extraButtons.filter(b => !b.row || b.row === 2)) {
      row2Buttons.push(
        new ButtonBuilder()
          .setCustomId(btn.customId)
          .setLabel(btn.label)
          .setStyle(btn.style)
          .setDisabled(btn.disabled ?? false)
      );
    }
  }

  // Refresh button
  row2Buttons.push(
    new ButtonBuilder()
      .setCustomId(buildButtonId(config, ACTIONS.REFRESH))
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  // Back button
  if (config.backButtonId) {
    row2Buttons.push(
      new ButtonBuilder()
        .setCustomId(config.backButtonId)
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(...row2Buttons.slice(0, 5))
  );

  return container;
}

/**
 * Handle button interactions for the JSON editor
 * Returns PanelResponse for handled actions, null if not a JSON editor button
 */
export async function handleJsonEditorButton(
  config: JsonEditorConfig,
  context: PanelContext,
  buttonId: string
): Promise<PanelResponse | null> {
  const parsed = parseButtonId(buttonId);
  if (!parsed || parsed.dataKey !== config.dataKey) {
    return null;
  }

  switch (parsed.action) {
    case ACTIONS.EDIT: {
      const data = config.getData();
      const editData = isDataEmpty(data) && config.template ? config.template : data;

      const modal = buildJsonEditModal({
        customIdPrefix: `panel_${config.panelId}_modal`,
        actionSuffix: `${ACTIONS.EDIT}_${config.dataKey}`,
        title: `Edit ${config.title.replace(/^#*\s*[^\s]*\s*/, '')}`.substring(0, 45),
        currentData: editData ?? {},
      });

      if (!modal) {
        return showError(`Data is too large to edit (>${MAX_EDIT_SIZE} chars). Use Upload instead.`);
      }

      return { modal } as any;
    }

    case ACTIONS.UPLOAD: {
      const modal = buildJsonUploadModal({
        customIdPrefix: `panel_${config.panelId}_modal`,
        actionSuffix: `${ACTIONS.UPLOAD}_${config.dataKey}`,
        title: `Upload ${config.title.replace(/^#*\s*[^\s]*\s*/, '')}`.substring(0, 45),
        description: 'Select a .json file to upload',
      });

      return { modal } as any;
    }

    case ACTIONS.DOWNLOAD: {
      const data = config.getData();
      const cleanTitle = config.title.replace(/^#*\s*[^\s]*\s*/, '').trim();
      const result = await handleJsonDownload(context, data, {
        filename: `${config.dataKey}.json`,
        description: `Export: ${cleanTitle}`,
      });
      // If download succeeded (null), return the editor view; otherwise return error
      return result ?? createV2Response([buildJsonEditorView(config, context)]);
    }

    case ACTIONS.REFRESH: {
      return createV2Response([buildJsonEditorView(config, context)]);
    }

    default:
      return null;
  }
}

/**
 * Handle modal submissions for the JSON editor
 * Returns PanelResponse for handled modals, null if not a JSON editor modal
 */
export async function handleJsonEditorModal(
  config: JsonEditorConfig,
  context: PanelContext,
  modalId: string
): Promise<PanelResponse | null> {
  const parsed = parseModalId(modalId);
  if (!parsed || parsed.dataKey !== config.dataKey) {
    return null;
  }

  const interaction = context.interaction;
  if (!interaction || !('fields' in interaction)) {
    return showError('Invalid interaction');
  }

  switch (parsed.action) {
    case ACTIONS.EDIT: {
      const jsonInput = (interaction as any).fields.getTextInputValue('data_json');
      const result = validateAndSanitizeJson(jsonInput, config.validationOptions);

      if (!result.valid) {
        return showErrorAndReturnView(result.error, config, context);
      }

      try {
        await config.saveData(result.data);
      } catch (error) {
        return showErrorAndReturnView(`Save failed: ${error instanceof Error ? error.message : 'Unknown error'}`, config, context);
      }

      return createV2Response([buildJsonEditorView(config, context)]);
    }

    case ACTIONS.UPLOAD: {
      const uploadResult = await handleJsonUpload(context, 'json_file', config.validationOptions);

      if (!uploadResult.success) {
        return showErrorAndReturnView(uploadResult.error, config, context);
      }

      try {
        await config.saveData(uploadResult.data);
      } catch (error) {
        return showErrorAndReturnView(`Save failed: ${error instanceof Error ? error.message : 'Unknown error'}`, config, context);
      }

      return createV2Response([buildJsonEditorView(config, context)]);
    }

    default:
      return null;
  }
}

/**
 * Check if a button ID belongs to this JSON editor
 */
export function isJsonEditorButton(config: JsonEditorConfig, buttonId: string): boolean {
  const parsed = parseButtonId(buttonId);
  return parsed !== null && parsed.dataKey === config.dataKey;
}

/**
 * Check if a modal ID belongs to this JSON editor
 */
export function isJsonEditorModal(config: JsonEditorConfig, modalId: string): boolean {
  const parsed = parseModalId(modalId);
  return parsed !== null && parsed.dataKey === config.dataKey;
}

/**
 * Send ephemeral error message and return editor view
 */
async function showErrorAndReturnView(
  message: string,
  config: JsonEditorConfig,
  context: PanelContext
): Promise<PanelResponse> {
  const interaction = context.interaction as any;

  // Send ephemeral error message
  if (interaction) {
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate();
      }
      await interaction.followUp({
        content: `**Error:** ${message}`,
        flags: 64, // Ephemeral
      });
    } catch (e) {
      console.error('[jsonEditorSubpanel] Failed to send error followUp:', e);
    }
  }

  // Return the editor view (panel stays the same)
  return createV2Response([buildJsonEditorView(config, context)]);
}

/**
 * Show error panel (fallback when no context available)
 */
function showError(message: string): PanelResponse {
  const container = new ContainerBuilder()
    .setAccentColor(V2Colors.danger)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## Error\n${message}`)
    );
  return createV2Response([container]);
}
