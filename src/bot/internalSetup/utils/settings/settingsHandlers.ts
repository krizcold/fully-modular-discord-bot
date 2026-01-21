/**
 * Settings Handlers
 *
 * Button, dropdown, and modal handlers for settings panels.
 * Extracted from settingsPanelFactory for better organization.
 */

import {
  AttachmentBuilder,
  ModalSubmitInteraction,
  MessageFlags,
} from 'discord.js';
import type { PanelContext, PanelResponse } from '@bot/types/panelTypes';
import type { SettingsSchema, SettingValue, HardLimitOverride } from '@bot/types/settingsTypes';
import { createV2Response } from '../panel/v2';
import { parsePageFromCustomId } from '../panel/paginationUtils';
import { validateAndSanitizeJson } from '../json';
import {
  buildEditModal,
  buildResetModal,
  buildUploadModal,
  buildErrorPanel,
  buildSelectEditModal,
  buildChannelEditModal,
  buildRoleEditModal,
  buildColorEditModal,
  buildSystemNumberEditModal,
  buildSystemStringEditModal,
  buildSystemMultiSelectEditModal,
} from './settingsBuilder';
import {
  loadModuleSettings,
  saveModuleSetting,
  resetAllModuleSettings,
  exportModuleSettings,
  loadHardLimits,
  saveHardLimit,
} from './settingsStorage';
import { parseSettingValue, validateSettingValue, validateHardLimits, getEffectiveLimits } from './settingsValidation';

// Types duplicated here to avoid circular dependency with settingsPanelFactory
export interface SettingsPanelState {
  currentSection: string;
  currentPage: number;
  pendingChanges: Record<string, SettingValue>;
}

export type RenderFunction = (state: SettingsPanelState) => PanelResponse;

/**
 * Parse hex color from various formats and normalize to 0xRRGGBB
 * Accepts: 0xFFFFFF, 0xFFF, FFFFFF, FFF, #FFFFFF, #FFF, $FFFFFF, $FFF
 */
function parseHexColor(input: string): string | null {
  // Remove common prefixes and normalize
  let hex = input.trim().toUpperCase();

  // Remove prefix if present
  if (hex.startsWith('0X')) {
    hex = hex.slice(2);
  } else if (hex.startsWith('#') || hex.startsWith('$')) {
    hex = hex.slice(1);
  }

  // Validate hex characters
  if (!/^[0-9A-F]+$/.test(hex)) {
    return null;
  }

  // Expand shorthand (FFF -> FFFFFF)
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }

  // Must be exactly 6 characters after expansion
  if (hex.length !== 6) {
    return null;
  }

  return `0x${hex}`;
}

/**
 * Get modal field value from context (text input)
 */
function getModalFieldValue(context: PanelContext, fieldId: string): string {
  const interaction = context.interaction as ModalSubmitInteraction | null;
  if (!interaction || !('fields' in interaction)) return '';
  try {
    return interaction.fields.getTextInputValue(fieldId) || '';
  } catch {
    return '';
  }
}

/**
 * Get modal select values from context (string select menus)
 */
function getModalSelectValues(context: PanelContext, fieldId: string): string[] {
  const interaction = context.interaction as ModalSubmitInteraction | null;
  if (!interaction || !('fields' in interaction)) return [];
  try {
    const values = interaction.fields.getStringSelectValues(fieldId);
    return values ? [...values] : [];
  } catch {
    return [];
  }
}

/**
 * Get modal entity select values from context (channel/role select menus)
 */
function getModalEntityValues(context: PanelContext, fieldId: string): string[] {
  const interaction = context.interaction as ModalSubmitInteraction | null;
  if (!interaction || !('fields' in interaction)) return [];
  try {
    const field = interaction.fields.getField(fieldId);
    if (field && 'values' in field) {
      const values = (field as any).values;
      return Array.isArray(values) ? values : (values ? [values] : []);
    }
    return [];
  } catch {
    return [];
  }
}

export interface HandlerContext {
  context: PanelContext;
  moduleName: string;
  category: string;
  schema: SettingsSchema;
  defaultSection: string;
  panelId: string;
  getState: () => SettingsPanelState;
  setState: (state: SettingsPanelState) => void;
  render: RenderFunction;
}

/**
 * Send an ephemeral error message to the user
 * Following the pattern from jsonEditorSubpanel.ts
 */
async function sendEphemeralError(context: PanelContext, message: string): Promise<void> {
  const interaction = context.interaction as any;
  if (!interaction) return;

  try {
    // Defer the update first so the panel can be updated afterward
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
    // Send error as ephemeral followUp
    await interaction.followUp({ content: `❌ ${message}`, flags: MessageFlags.Ephemeral });
  } catch {
    // Ignore errors - ephemeral message is best-effort
  }
}

/**
 * Handle button interactions
 */
export async function handleSettingsButton(
  ctx: HandlerContext,
  buttonId: string
): Promise<PanelResponse | null> {
  const { context, moduleName, category, schema, panelId, getState, setState, render } = ctx;
  const state = getState();
  const parts = buttonId.split('_');
  const action = parts[0];

  switch (action) {
    case 'nav': {
      const navButtonPrefix = `nav_${moduleName}_${category}`;
      const newPage = parsePageFromCustomId(buttonId, navButtonPrefix);
      if (newPage !== null && newPage >= 0) {
        state.currentPage = newPage;
        setState(state);
      }
      return render(state);
    }

    case 'toggle': {
      const settingKey = parts[1];
      const settings = loadModuleSettings(moduleName, context.guildId, category);
      if (!settings) return createV2Response(buildErrorPanel('Failed to load settings.'));

      const currentValue = state.pendingChanges.hasOwnProperty(settingKey)
        ? state.pendingChanges[settingKey]
        : settings.values[settingKey];
      state.pendingChanges[settingKey] = !currentValue;
      setState(state);
      return render(state);
    }

    case 'edit': {
      const settingKey = parts[1];
      const definition = schema.settings[settingKey];
      if (!definition) return createV2Response(buildErrorPanel(`Setting "${settingKey}" not found.`));

      const settings = loadModuleSettings(moduleName, context.guildId, category);
      const currentValue = state.pendingChanges.hasOwnProperty(settingKey)
        ? state.pendingChanges[settingKey]
        : settings?.values[settingKey];

      let modal;
      switch (definition.type) {
        case 'select':
        case 'multiSelect':
          modal = buildSelectEditModal(panelId, settingKey, moduleName, category, definition, currentValue);
          break;
        case 'channel':
        case 'multiChannel':
          modal = buildChannelEditModal(panelId, settingKey, moduleName, category, definition);
          break;
        case 'role':
        case 'multiRole':
          modal = buildRoleEditModal(panelId, settingKey, moduleName, category, definition);
          break;
        case 'color':
          modal = buildColorEditModal(panelId, settingKey, moduleName, category, definition, currentValue);
          break;
        default:
          modal = buildEditModal(panelId, settingKey, moduleName, category, definition, currentValue);
      }
      return { modal } as any;
    }

    // System panel edit with hard limit editing
    case 'sysedit': {
      const settingKey = parts[1];
      const definition = schema.settings[settingKey];
      if (!definition) return createV2Response(buildErrorPanel(`Setting "${settingKey}" not found.`));

      const settings = loadModuleSettings(moduleName, null, category); // System uses global settings
      const currentValue = state.pendingChanges.hasOwnProperty(settingKey)
        ? state.pendingChanges[settingKey]
        : settings?.values[settingKey];
      const currentHardLimits = loadHardLimits(moduleName)[settingKey] || {};

      let modal;
      switch (definition.type) {
        case 'number':
          modal = buildSystemNumberEditModal(
            panelId, settingKey, moduleName, category,
            definition, currentValue, currentHardLimits, definition.validation
          );
          break;
        case 'string':
          modal = buildSystemStringEditModal(
            panelId, settingKey, moduleName, category,
            definition, currentValue, currentHardLimits, definition.validation
          );
          break;
        case 'multiSelect':
        case 'multiChannel':
        case 'multiRole':
          modal = buildSystemMultiSelectEditModal(
            panelId, settingKey, moduleName, category,
            definition, currentHardLimits, definition.validation
          );
          break;
        default:
          // Fall back to regular edit modal for other types
          modal = buildEditModal(panelId, settingKey, moduleName, category, definition, currentValue);
      }
      return { modal } as any;
    }

    case 'save': {
      if (Object.keys(state.pendingChanges).length === 0) {
        return render(state);
      }

      // Validate all pending changes
      const errorMessages: string[] = [];
      for (const [key, value] of Object.entries(state.pendingChanges)) {
        const definition = schema.settings[key];
        if (definition) {
          const result = validateSettingValue(value, definition);
          if (!result.valid && result.error) {
            errorMessages.push(`**${definition.label}**: ${result.error}`);
          }
        }
      }

      if (errorMessages.length > 0) {
        // Send ephemeral error with all validation errors
        await sendEphemeralError(context, errorMessages.join('\n'));
        return render(state);
      }

      for (const [key, value] of Object.entries(state.pendingChanges)) {
        saveModuleSetting(moduleName, key, value, context.guildId, category);
      }

      state.pendingChanges = {};
      setState(state);
      return render(state);
    }

    case 'reset':
      return { modal: buildResetModal(panelId, moduleName, category) } as any;

    case 'upload':
      return { modal: buildUploadModal(panelId, moduleName, category, schema.name) } as any;

    case 'download': {
      const exported = exportModuleSettings(moduleName, context.guildId);
      if (!exported) return createV2Response(buildErrorPanel('Failed to export settings.'));

      const interaction = context.interaction as any;
      if (!interaction) return createV2Response(buildErrorPanel('Cannot send download in this context.'));

      const filename = context.guildId
        ? `${moduleName}_settings_${context.guildId}.json`
        : `${moduleName}_settings_global.json`;

      const attachment = new AttachmentBuilder(
        Buffer.from(exported, 'utf-8'),
        { name: filename, description: `Settings export for ${moduleName}` }
      );

      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
      await interaction.followUp({
        content: `📥 **Download:** \`${filename}\``,
        files: [attachment],
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }

    default:
      return createV2Response(buildErrorPanel(`Unknown action: ${action}`));
  }
}

/**
 * Handle dropdown interactions
 */
export async function handleSettingsDropdown(
  ctx: HandlerContext,
  values: string[],
  dropdownId: string | undefined
): Promise<PanelResponse> {
  const { defaultSection, getState, setState, render } = ctx;
  const state = getState();

  if (!dropdownId) return createV2Response(buildErrorPanel('Missing dropdown ID'));

  const parts = dropdownId.split('_');
  const type = parts[0];

  // Section selector
  if (type === 'section') {
    state.currentSection = values[0] || defaultSection;
    state.currentPage = 0;
    setState(state);
    return render(state);
  }

  // Setting value selectors
  const settingKey = parts[1];
  const isSingleValue = ['select', 'channel', 'role'].includes(type);

  state.pendingChanges[settingKey] = isSingleValue ? (values[0] || null) : values;
  setState(state);
  return render(state);
}

/**
 * Handle modal submissions
 */
export async function handleSettingsModal(
  ctx: HandlerContext,
  modalId: string
): Promise<PanelResponse> {
  const { context, moduleName, category, schema, getState, setState, render } = ctx;
  const state = getState();
  const parts = modalId.split('_');
  const action = parts[0];

  switch (action) {
    case 'edit': {
      const settingKey = parts[1];
      const definition = schema.settings[settingKey];
      if (!definition) return createV2Response(buildErrorPanel(`Setting "${settingKey}" not found.`));

      const rawValue = getModalFieldValue(context, 'value');
      const parsed = parseSettingValue(rawValue, definition.type);
      const result = validateSettingValue(parsed, definition);

      if (!result.valid && result.error) {
        // Send ephemeral error message instead of storing in state
        await sendEphemeralError(context, result.error);
      } else {
        state.pendingChanges[settingKey] = parsed;
      }
      setState(state);
      return render(state);
    }

    // System edit modal - handles value + hard limits
    case 'sysedit': {
      const settingKey = parts[1];
      const definition = schema.settings[settingKey];
      if (!definition) return createV2Response(buildErrorPanel(`Setting "${settingKey}" not found.`));

      const errors: string[] = [];

      // Parse based on setting type
      if (definition.type === 'number') {
        const rawValue = getModalFieldValue(context, 'value');
        const rawMin = getModalFieldValue(context, 'hard_min');
        const rawMax = getModalFieldValue(context, 'hard_max');

        // Parse value
        if (rawValue.trim() !== '') {
          const parsed = parseSettingValue(rawValue, 'number');
          const result = validateSettingValue(parsed, definition);
          if (!result.valid && result.error) {
            errors.push(`Value: ${result.error}`);
          } else {
            state.pendingChanges[settingKey] = parsed;
          }
        }

        // Parse and validate hard limits
        const newHardLimits: HardLimitOverride = {};
        if (rawMin.trim() !== '') {
          const parsedMin = parseFloat(rawMin);
          if (isNaN(parsedMin)) {
            errors.push('Hard Limit Min must be a valid number');
          } else {
            newHardLimits.min = parsedMin;
          }
        }
        if (rawMax.trim() !== '') {
          const parsedMax = parseFloat(rawMax);
          if (isNaN(parsedMax)) {
            errors.push('Hard Limit Max must be a valid number');
          } else {
            newHardLimits.max = parsedMax;
          }
        }

        // Validate hard limits against absolute limits
        if (Object.keys(newHardLimits).length > 0) {
          const hardLimitError = validateHardLimits(newHardLimits, definition.validation, definition.type);
          if (hardLimitError) {
            errors.push(hardLimitError);
          } else {
            // Save hard limits
            saveHardLimit(moduleName, settingKey, newHardLimits);
          }
        }
      } else if (definition.type === 'string') {
        const rawValue = getModalFieldValue(context, 'value');
        const rawMinLength = getModalFieldValue(context, 'hard_min_length');
        const rawMaxLength = getModalFieldValue(context, 'hard_max_length');

        // Parse value
        if (rawValue.trim() !== '') {
          state.pendingChanges[settingKey] = rawValue;
        }

        // Parse and validate hard limits
        const newHardLimits: HardLimitOverride = {};
        if (rawMinLength.trim() !== '') {
          const parsedMinLength = parseInt(rawMinLength, 10);
          if (isNaN(parsedMinLength)) {
            errors.push('Hard Limit Min Length must be a valid number');
          } else {
            newHardLimits.minLength = parsedMinLength;
          }
        }
        if (rawMaxLength.trim() !== '') {
          const parsedMaxLength = parseInt(rawMaxLength, 10);
          if (isNaN(parsedMaxLength)) {
            errors.push('Hard Limit Max Length must be a valid number');
          } else {
            newHardLimits.maxLength = parsedMaxLength;
          }
        }

        // Validate hard limits against absolute limits
        if (Object.keys(newHardLimits).length > 0) {
          const hardLimitError = validateHardLimits(newHardLimits, definition.validation, definition.type);
          if (hardLimitError) {
            errors.push(hardLimitError);
          } else {
            saveHardLimit(moduleName, settingKey, newHardLimits);
          }
        }
      } else if (['multiSelect', 'multiChannel', 'multiRole'].includes(definition.type)) {
        const rawMinItems = getModalFieldValue(context, 'hard_min_items');
        const rawMaxItems = getModalFieldValue(context, 'hard_max_items');

        // Parse and validate hard limits
        const newHardLimits: HardLimitOverride = {};
        if (rawMinItems.trim() !== '') {
          const parsedMinItems = parseInt(rawMinItems, 10);
          if (isNaN(parsedMinItems)) {
            errors.push('Hard Limit Min Items must be a valid number');
          } else {
            newHardLimits.minItems = parsedMinItems;
          }
        }
        if (rawMaxItems.trim() !== '') {
          const parsedMaxItems = parseInt(rawMaxItems, 10);
          if (isNaN(parsedMaxItems)) {
            errors.push('Hard Limit Max Items must be a valid number');
          } else {
            newHardLimits.maxItems = parsedMaxItems;
          }
        }

        // Validate hard limits against absolute limits
        if (Object.keys(newHardLimits).length > 0) {
          const hardLimitError = validateHardLimits(newHardLimits, definition.validation, definition.type);
          if (hardLimitError) {
            errors.push(hardLimitError);
          } else {
            saveHardLimit(moduleName, settingKey, newHardLimits);
          }
        }
      }

      if (errors.length > 0) {
        await sendEphemeralError(context, errors.join('\n'));
      }

      setState(state);
      return render(state);
    }

    case 'reset': {
      const confirmText = getModalFieldValue(context, 'confirm_text');
      if (confirmText.toUpperCase() !== 'RESET') {
        await sendEphemeralError(context, 'Reset cancelled. Type RESET to confirm.');
        return render(state);
      }
      resetAllModuleSettings(moduleName, context.guildId);
      state.pendingChanges = {};
      setState(state);
      return render(state);
    }

    case 'upload': {
      const interaction = context.interaction as ModalSubmitInteraction;
      const modalFields = interaction.fields as any;
      const uploadedFiles = modalFields.getUploadedFiles?.('json_file');

      if (!uploadedFiles || uploadedFiles.size === 0) {
        return createV2Response(buildErrorPanel('No file uploaded. Please select a JSON file.'));
      }

      const attachment = uploadedFiles.first();
      if (!attachment?.url) {
        return createV2Response(buildErrorPanel('Could not access uploaded file.'));
      }

      try {
        const response = await fetch(attachment.url);
        if (!response.ok) return createV2Response(buildErrorPanel('Failed to download the uploaded file.'));

        const jsonText = await response.text();
        const result = validateAndSanitizeJson<Record<string, any>>(jsonText, { requiredType: 'object' });
        if (!result.valid) {
          return createV2Response(buildErrorPanel(result.error));
        }
        const parsedSettings = result.data;

        for (const [key, value] of Object.entries(parsedSettings)) {
          const definition = schema.settings[key];
          if (definition && validateSettingValue(value, definition).valid) {
            saveModuleSetting(moduleName, key, value, context.guildId, category);
          }
        }

        state.pendingChanges = {};
        setState(state);
        return render(state);
      } catch (error) {
        console.error('[SettingsPanel] Upload error:', error);
        return createV2Response(buildErrorPanel(`Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`));
      }
    }

    // Select menus from modals
    case 'select':
    case 'multiselect': {
      const settingKey = parts[1];
      const values = getModalSelectValues(context, 'value');
      state.pendingChanges[settingKey] = action === 'select' ? (values[0] || null) : values;
      setState(state);
      return render(state);
    }

    case 'channel':
    case 'multichannel':
    case 'role':
    case 'multirole': {
      const settingKey = parts[1];
      const values = getModalEntityValues(context, 'value');
      const isSingle = action === 'channel' || action === 'role';
      state.pendingChanges[settingKey] = isSingle ? (values[0] || null) : values;
      setState(state);
      return render(state);
    }

    case 'color': {
      const settingKey = parts[1];
      const customHex = getModalFieldValue(context, 'custom_hex').trim().toUpperCase();
      const presetValues = getModalSelectValues(context, 'color_preset');
      const presetHex = presetValues[0] || '';

      // Determine final hex value
      let finalHex: string | null = null;

      // Custom hex input takes priority if filled
      if (customHex !== '') {
        const normalized = parseHexColor(customHex);
        if (!normalized) {
          await sendEphemeralError(context, 'Invalid hex color format');
          return render(state);
        }
        finalHex = normalized;
      } else if (presetHex && presetHex !== '__custom__') {
        // Use preset if selected and not the "Custom" placeholder
        finalHex = presetHex;
      } else {
        // "Custom" selected but no hex entered
        await sendEphemeralError(context, 'Please enter a custom hex value');
        return render(state);
      }

      state.pendingChanges[settingKey] = finalHex;
      setState(state);
      return render(state);
    }

    default:
      return createV2Response(buildErrorPanel(`Unknown modal action: ${action}`));
  }
}
