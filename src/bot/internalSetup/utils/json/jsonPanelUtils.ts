/**
 * JSON Panel Utilities - Discord panel helpers for JSON operations
 */

import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  AttachmentBuilder,
  FileUploadBuilder,
  LabelBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { PanelContext, PanelResponse } from '@bot/types/panelTypes';
import { createV2Response, V2Colors } from '../panel/v2';
import { validateAndSanitizeJson, JsonValidationOptions, JsonValidationResult } from './jsonUtils';

// Discord modal text input limit
const MAX_MODAL_LENGTH = 4000;

/**
 * Result of JSON upload handling
 */
export type JsonUploadResult<T = any> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Options for JSON edit modal
 */
export interface JsonEditModalOptions {
  /** Custom ID prefix (e.g., 'panel_myPanel_modal') */
  customIdPrefix: string;
  /** Action suffix for the modal ID (e.g., 'edit_fileKey') */
  actionSuffix: string;
  /** Modal title (truncated to 45 chars) */
  title: string;
  /** Current data to pre-populate */
  currentData: any;
  /** Input field label */
  label?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Maximum input length (default: 4000) */
  maxLength?: number;
}

/**
 * Options for JSON upload modal
 */
export interface JsonUploadModalOptions {
  /** Custom ID prefix (e.g., 'panel_myPanel_modal') */
  customIdPrefix: string;
  /** Action suffix for the modal ID (e.g., 'upload_fileKey') */
  actionSuffix: string;
  /** Modal title (truncated to 45 chars) */
  title: string;
  /** Description shown under the upload field */
  description?: string;
  /** File input custom ID (default: 'json_file') */
  fileFieldId?: string;
}

/**
 * Options for JSON download
 */
export interface JsonDownloadOptions {
  /** Filename for the download */
  filename: string;
  /** Description for the attachment */
  description?: string;
  /** Send as ephemeral message (default: true) */
  ephemeral?: boolean;
  /** Content message above the file */
  content?: string;
}

/**
 * Handle JSON file upload from Discord modal or Web-UI
 * For Discord: Fetches file from Discord CDN
 * For Web-UI: Uses directly provided content (no fetch needed)
 */
export async function handleJsonUpload<T = any>(
  context: PanelContext,
  fileFieldId: string = 'json_file',
  validationOptions?: JsonValidationOptions
): Promise<JsonUploadResult<T>> {
  const interaction = context.interaction;
  if (!interaction || !('fields' in interaction)) {
    return { success: false, error: 'Invalid interaction' };
  }

  const modalFields = interaction.fields as any;
  const uploadedFiles = modalFields.getUploadedFiles?.(fileFieldId);

  if (!uploadedFiles || uploadedFiles.size === 0) {
    return { success: false, error: 'No file uploaded. Please select a JSON file.' };
  }

  const attachment = uploadedFiles.first();
  if (!attachment || (!attachment.url && !attachment.content)) {
    return { success: false, error: 'Could not access uploaded file.' };
  }

  try {
    let jsonText: string;

    // Check if content is directly available (Web-UI uploads)
    if (attachment.content) {
      jsonText = attachment.content;
    } else {
      // Fetch from URL (Discord CDN or data URL)
      const response = await fetch(attachment.url);
      if (!response.ok) {
        return { success: false, error: 'Failed to download the uploaded file.' };
      }
      jsonText = await response.text();
    }

    const result = validateAndSanitizeJson<T>(jsonText, validationOptions);

    if (!result.valid) {
      return { success: false, error: result.error };
    }

    return { success: true, data: result.data };
  } catch (error) {
    console.error('[jsonPanelUtils] Upload error:', error);
    return { success: false, error: `Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}` };
  }
}

/**
 * Handle JSON download - sends file as ephemeral followUp
 * Returns null on success (caller should return editor view), error PanelResponse on failure
 */
export async function handleJsonDownload(
  context: PanelContext,
  data: any,
  options: JsonDownloadOptions
): Promise<PanelResponse | null> {
  if (data === null || data === undefined) {
    return showJsonError('No data to download.');
  }

  const interaction = context.interaction as any;
  if (!interaction) {
    return showJsonError('Cannot send download in this context.');
  }

  const jsonString = JSON.stringify(data, null, 2);
  const { filename, description } = options;

  const attachment = new AttachmentBuilder(Buffer.from(jsonString, 'utf-8'), {
    name: filename.endsWith('.json') ? filename : `${filename}.json`,
    description: description || `JSON export: ${filename}`,
  });

  try {
    // Defer if not already deferred/replied (required before followUp)
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }

    // Send file as ephemeral followUp (separate from main response)
    await interaction.followUp({
      content: `**Download:** \`${filename}\``,
      files: [attachment],
      flags: 64, // Ephemeral flag
    });

    // Return null - caller should return the editor view
    return null;
  } catch (error) {
    console.error('[jsonPanelUtils] Download error:', error);
    return showJsonError(`Failed to send download: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Build a JSON edit modal with pre-populated data
 * Returns null if data exceeds maxLength
 */
export function buildJsonEditModal(options: JsonEditModalOptions): ModalBuilder | null {
  const {
    customIdPrefix,
    actionSuffix,
    title,
    currentData,
    label = 'Data (JSON)',
    placeholder = '{\n  "key": "value"\n}',
    maxLength = MAX_MODAL_LENGTH,
  } = options;

  const formattedJson = JSON.stringify(currentData ?? {}, null, 2);

  if (formattedJson.length >= maxLength) {
    return null; // Too large for modal
  }

  const modal = new ModalBuilder()
    .setCustomId(`${customIdPrefix}_${actionSuffix}`)
    .setTitle(title.substring(0, 45));

  const jsonInput = new TextInputBuilder()
    .setCustomId('data_json')
    .setLabel(label)
    .setStyle(TextInputStyle.Paragraph)
    .setValue(formattedJson)
    .setPlaceholder(placeholder)
    .setRequired(true)
    .setMaxLength(maxLength);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(jsonInput));

  return modal;
}

/**
 * Build a JSON upload modal with file upload component
 */
export function buildJsonUploadModal(options: JsonUploadModalOptions): ModalBuilder {
  const {
    customIdPrefix,
    actionSuffix,
    title,
    description = 'Select a .json file to upload',
    fileFieldId = 'json_file',
  } = options;

  const modal = new ModalBuilder()
    .setCustomId(`${customIdPrefix}_${actionSuffix}`)
    .setTitle(title.substring(0, 45));

  const fileUpload = new FileUploadBuilder()
    .setCustomId(fileFieldId)
    .setMinValues(1)
    .setMaxValues(1)
    .setRequired(true);

  const fileLabel = new LabelBuilder()
    .setLabel('JSON File')
    .setDescription(description)
    .setFileUploadComponent(fileUpload);

  modal.addLabelComponents(fileLabel);

  return modal;
}

/**
 * Show a JSON validation/operation error panel
 */
export function showJsonError(error: string): PanelResponse {
  const container = new ContainerBuilder()
    .setAccentColor(V2Colors.danger)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## Error\n${error}`)
    );
  return createV2Response([container]);
}

/**
 * Parse JSON from modal text input with validation
 * Convenience wrapper for modal handlers
 */
export function parseModalJson<T = any>(
  context: PanelContext,
  fieldId: string = 'data_json',
  validationOptions?: JsonValidationOptions
): JsonValidationResult<T> {
  const interaction = context.interaction;
  if (!interaction || !('fields' in interaction)) {
    return { valid: false, error: 'Invalid interaction' };
  }

  try {
    const jsonInput = (interaction as any).fields.getTextInputValue(fieldId);
    return validateAndSanitizeJson<T>(jsonInput, validationOptions);
  } catch (error) {
    return { valid: false, error: 'Could not read input field' };
  }
}

/**
 * Check if data can be edited in a modal (size check)
 */
export function canEditInModal(data: any, maxLength: number = MAX_MODAL_LENGTH): boolean {
  const jsonString = JSON.stringify(data ?? {}, null, 2);
  return jsonString.length < maxLength;
}

/**
 * Get the size of formatted JSON for display
 */
export function getFormattedJsonSize(data: any): number {
  return JSON.stringify(data ?? {}, null, 2).length;
}
