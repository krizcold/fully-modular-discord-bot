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
  saveModuleSettings,
  resetAllModuleSettings,
  exportModuleSettings,
  loadHardLimits,
  saveHardLimit,
  getMergedHardLimits,
  loadGlobalModuleConfig,
} from './settingsStorage';
import { getPremiumManager } from '../premiumManager';
import { parseSettingValue, parseWholeNumber, validateSettingValue, validateValueWithEffectiveLimits, validateHardLimits, getEffectiveLimits } from './settingsValidation';

// Types duplicated here to avoid circular dependency with settingsPanelFactory
export interface SettingsPanelState {
  currentSection: string;
  currentPage: number;
  pendingChanges: Record<string, SettingValue>;
}

const SYSTEM_CAP_FIELDS: Record<string, Array<{ id: string; key: keyof HardLimitOverride; label: string; integer: boolean }>> = {
  number: [
    { id: 'hard_min', key: 'min', label: 'Hard Limit Min', integer: false },
    { id: 'hard_max', key: 'max', label: 'Hard Limit Max', integer: false },
  ],
  string: [
    { id: 'hard_min_length', key: 'minLength', label: 'Hard Limit Min Length', integer: true },
    { id: 'hard_max_length', key: 'maxLength', label: 'Hard Limit Max Length', integer: true },
  ],
  multiSelect: [
    { id: 'hard_min_items', key: 'minItems', label: 'Hard Limit Min Items', integer: true },
    { id: 'hard_max_items', key: 'maxItems', label: 'Hard Limit Max Items', integer: true },
  ],
};
SYSTEM_CAP_FIELDS.multiChannel = SYSTEM_CAP_FIELDS.multiSelect;
SYSTEM_CAP_FIELDS.multiRole = SYSTEM_CAP_FIELDS.multiSelect;

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
function getModalEntityValues(context: PanelContext, fieldId: string): string[] | null {
  const interaction = context.interaction as ModalSubmitInteraction | null;
  if (!interaction || !('fields' in interaction)) return null;
  try {
    const field = interaction.fields.getField(fieldId);
    if (!field) return null;
    const values = (field as any).values;
    return Array.isArray(values) ? values : (values ? [values] : []);
  } catch {
    return null;
  }
}

/** Discord's limit on the entries one select menu can hold or show as defaults. */
const DISCORD_SELECT_MAX = 25;

const isEntityList = (type: string) => type === 'multiRole' || type === 'multiChannel';

function sameEntityValue(a: SettingValue | undefined, b: SettingValue | undefined): boolean {
  const ids = (v: SettingValue | undefined) => (Array.isArray(v) ? v : (v === null || v === undefined || v === '' ? [] : [v])).map(String);
  const left = ids(a);
  const right = ids(b);
  return left.length === right.length && left.every(id => right.includes(id));
}

/** The stored guild ids of an entity list that the read-time clamp hid from the editor. */
function clampHiddenIds(settings: ReturnType<typeof loadModuleSettings>, key: string): string[] {
  const clamped = settings?.clamped?.[key];
  if (!clamped || settings?.sources[key] !== 'guild') return [];
  if (!Array.isArray(clamped.stored) || !Array.isArray(clamped.effective)) return [];
  const shown = clamped.effective.map(String);
  return clamped.stored.map(String).filter(id => !shown.includes(id));
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

function rangeText(limits: { min?: number; max?: number }): string {
  if (limits.min !== undefined && limits.max !== undefined) return ` (allowed ${limits.min} to ${limits.max})`;
  if (limits.min !== undefined) return ` (allowed ${limits.min} or more)`;
  if (limits.max !== undefined) return ` (allowed up to ${limits.max})`;
  return '';
}

function sameHardLimits(a: HardLimitOverride, b: HardLimitOverride): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof HardLimitOverride)[]);
  return [...keys].every(k => a[k] === b[k]);
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
      const settings = loadModuleSettings(moduleName, context.guildId);
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

      const settings = loadModuleSettings(moduleName, context.guildId);
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
        case 'role':
        case 'multiRole':
          if (Array.isArray(currentValue) && currentValue.length > DISCORD_SELECT_MAX) {
            return createV2Response(buildErrorPanel(`**${definition.label}** holds more entries than Discord can edit (at most ${DISCORD_SELECT_MAX}). Change it with Upload.`));
          }
          modal = definition.type === 'channel' || definition.type === 'multiChannel'
            ? buildChannelEditModal(panelId, settingKey, moduleName, category, definition, currentValue)
            : buildRoleEditModal(panelId, settingKey, moduleName, category, definition, currentValue);
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

      const settings = loadModuleSettings(moduleName, null); // System uses global settings
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

      // Validate all pending changes against effective limits (schema +
      // system-panel hard limits + tier-supplied hard limits). Without this
      // a guild user could save a value above the cap they see in the UI.
      const mergedLimits = getMergedHardLimits(moduleName, context.guildId);
      const stored = loadModuleSettings(moduleName, context.guildId);
      const updates: Record<string, SettingValue> = { ...state.pendingChanges };
      const errorMessages: string[] = [];
      for (const [key, value] of Object.entries(state.pendingChanges)) {
        const listed = schema.settings[key];
        if (listed && isEntityList(listed.type) && Array.isArray(value) && value.length > 0) {
          const kept = clampHiddenIds(stored, key).filter(id => !value.includes(id));
          if (kept.length > 0) updates[key] = [...value, ...kept];
        }
        const definition = schema.settings[key];
        if (definition) {
          const result = validateValueWithEffectiveLimits(value, definition, mergedLimits[key]);
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

      if (Object.keys(updates).length > 0 && !saveModuleSettings(moduleName, updates, context.guildId)) {
        await sendEphemeralError(context, 'Save not applied: the settings could not be written now (the data is not ready or the database is unavailable); your changes are kept, try again shortly.');
        return render(state);
      }

      state.pendingChanges = {};
      setState(state);
      return render(state);
    }

    case 'reset':
      return { modal: buildResetModal(panelId, moduleName, category, !context.guildId) } as any;

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

    case 'modtoggle': {
      // System Panel-only toggle for the module's `_moduleEnabled` flag in
      // Global config (the deployment baseline). Flips the persisted state
      // and re-renders so the button label updates. Per-guild and tier
      // edits use other surfaces; this one is the host's quick on/off.
      try {
        const pm = getPremiumManager();
        const current = loadGlobalModuleConfig(moduleName).moduleEnabled;
        pm.setGlobalModuleConfig(moduleName, { moduleEnabled: !current });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to toggle module';
        await sendEphemeralError(context, msg);
      }
      return render(state);
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
      // Validate against effective limits (schema + system + tier) so the cap
      // shown in the modal label is also enforced on submit.
      const mergedLimits = getMergedHardLimits(moduleName, context.guildId);
      if (definition.type === 'number' && rawValue.trim() !== '' && parsed === null) {
        await sendEphemeralError(context, `**${definition.label}**: "${rawValue.trim()}" is not a number${rangeText(getEffectiveLimits(definition, mergedLimits[settingKey]))}; the value was not changed.`);
        return render(state);
      }
      const result = validateValueWithEffectiveLimits(parsed, definition, mergedLimits[settingKey]);

      if (!result.valid && result.error) {
        await sendEphemeralError(context, definition.type === 'number'
          ? `**${definition.label}**: "${rawValue.trim()}" refused: ${result.error}${rangeText(getEffectiveLimits(definition, mergedLimits[settingKey]))}; the value was not changed.`
          : result.error);
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

      const capFields = SYSTEM_CAP_FIELDS[definition.type];
      if (!capFields) {
        setState(state);
        return render(state);
      }

      const errors: string[] = [];
      const notes: string[] = [];

      if (definition.type === 'number' || definition.type === 'string') {
        const rawValue = getModalFieldValue(context, 'value');
        if (rawValue.trim() !== '') {
          const parsed = definition.type === 'number' ? parseWholeNumber(rawValue) : rawValue;
          if (parsed === null) {
            errors.push(`Value: "${rawValue.trim()}" is not a number${rangeText(getEffectiveLimits(definition, loadHardLimits(moduleName)[settingKey]))}; the value was not changed`);
          } else {
            const result = validateSettingValue(parsed, definition);
            if (!result.valid && result.error) {
              errors.push(definition.type === 'number'
                ? `Value: "${rawValue.trim()}" refused: ${result.error}${rangeText(getEffectiveLimits(definition, loadHardLimits(moduleName)[settingKey]))}; the value was not changed`
                : `Value: ${result.error}; the value was not changed`);
            } else {
              state.pendingChanges[settingKey] = parsed;
            }
          }
        }
      }

      const newHardLimits: HardLimitOverride = {};
      let capsParsed = true;
      for (const field of capFields) {
        const raw = getModalFieldValue(context, field.id).trim();
        if (raw === '') continue;
        const parsed = parseWholeNumber(raw);
        const whole = field.integer || definition.validation?.integer === true;
        if (parsed === null || (whole && !Number.isInteger(parsed))) {
          errors.push(`${field.label}: "${raw}" is not ${whole ? 'a whole number' : 'a number'}`);
          capsParsed = false;
        } else {
          newHardLimits[field.key] = parsed;
        }
      }

      if (!capsParsed) {
        notes.push('Hard limits were not changed.');
      } else {
        const hardLimitError = validateHardLimits(newHardLimits, definition.validation, definition.type);
        if (hardLimitError) {
          errors.push(hardLimitError);
          notes.push('Hard limits were not changed.');
        } else if (!sameHardLimits(newHardLimits, loadHardLimits(moduleName)[settingKey] ?? {}) && !saveHardLimit(moduleName, settingKey, newHardLimits)) {
          errors.push('Hard limits not saved: the settings could not be written now; try again shortly.');
        }
      }

      if (errors.length > 0) {
        await sendEphemeralError(context, [...errors, ...notes].join('\n'));
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
      const reset = context.guildId
        ? resetAllModuleSettings(moduleName, context.guildId)
        : getPremiumManager().setGlobalModuleConfig(moduleName, { values: {} });
      if (!reset) {
        await sendEphemeralError(context, 'Reset not applied: the settings could not be deleted now (the data is not ready or the database is unavailable); nothing was changed, try again shortly.');
        return render(state);
      }
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

        // Validate each imported value against effective limits so a JSON
        // upload cannot bypass the caps the user sees in the panel UI.
        for (const [key, value] of Object.entries(parsedSettings)) {
          const definition = schema.settings[key];
          if (definition && isEntityList(definition.type) && Array.isArray(value) && value.length > DISCORD_SELECT_MAX) {
            return createV2Response(buildErrorPanel(`Upload refused: **${definition.label}** lists ${value.length} entries; Discord allows at most ${DISCORD_SELECT_MAX}. Nothing was changed.`));
          }
        }

        const mergedLimits = getMergedHardLimits(moduleName, context.guildId);
        const accepted: Record<string, any> = {};
        const notRestored: string[] = [];
        for (const [key, value] of Object.entries(parsedSettings)) {
          const definition = schema.settings[key];
          if (definition && validateValueWithEffectiveLimits(value, definition, mergedLimits[key]).valid) accepted[key] = value;
          else notRestored.push(key);
        }
        if (Object.keys(accepted).length > 0 && !saveModuleSettings(moduleName, accepted, context.guildId)) {
          return createV2Response(buildErrorPanel('Upload failed: the settings could not be written now (the data is not ready or the database is unavailable); nothing was changed, try again shortly.'));
        }

        if (Object.keys(parsedSettings).length === 0) {
          await sendEphemeralError(context, 'Upload not applied: the file holds no settings; nothing was changed.');
          return render(state);
        }
        if (Object.keys(accepted).length === 0) {
          await sendEphemeralError(context, `Upload not applied: none of the keys could be restored (no matching setting, or the value is invalid): ${notRestored.join(', ')}; nothing was changed.`);
          return render(state);
        }
        if (notRestored.length > 0) {
          await sendEphemeralError(context, `Upload applied, but these keys were not restored (no matching setting, or the value is invalid): ${notRestored.join(', ')}`);
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
      if (values === null) return render(state);
      const isSingle = action === 'channel' || action === 'role';
      const submitted = isSingle ? (values[0] || null) : values;
      if (sameEntityValue(submitted, loadModuleSettings(moduleName, context.guildId)?.values[settingKey])) {
        delete state.pendingChanges[settingKey];
      } else {
        state.pendingChanges[settingKey] = submitted;
      }
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
        finalHex = parseHexColor(presetHex);
        if (!finalHex) {
          await sendEphemeralError(context, 'Invalid preset color; the value was not changed');
          return render(state);
        }
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
