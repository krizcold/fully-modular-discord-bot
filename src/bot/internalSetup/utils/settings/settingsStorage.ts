/**
 * Settings Storage - File I/O for module settings
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SettingValue, MergedSettings, HardLimitOverride } from '@bot/types/settingsTypes';
import { dataPath } from '../../../../utils/dataRoot';
import { getSettingsSchema } from './settingsDiscovery';
import { validateSettingValue, validateValueWithEffectiveLimits } from './settingsValidation';

const SETTINGS_FILENAME = 'settings.json';

function getSettingsFilePath(moduleName: string, guildId?: string | null): string {
  if (guildId) {
    return dataPath(guildId, moduleName, SETTINGS_FILENAME);
  }
  return dataPath('global', moduleName, SETTINGS_FILENAME);
}

function loadRawSettings(moduleName: string, guildId?: string | null): Record<string, SettingValue> {
  const filePath = getSettingsFilePath(moduleName, guildId);
  if (!fs.existsSync(filePath)) return {};

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8') || '{}');
  } catch (error) {
    console.error(`[SettingsStorage] Error reading ${moduleName}:`, error);
    return {};
  }
}

function saveRawSettings(moduleName: string, settings: Record<string, SettingValue>, guildId?: string | null): void {
  const filePath = getSettingsFilePath(moduleName, guildId);
  const dirPath = path.dirname(filePath);

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
}

/** Load module settings with 4-tier merge: Guild > Paid tier delta > Global / Free baseline > Schema defaults */
export function loadModuleSettings(moduleName: string, guildId?: string | null): MergedSettings | null {
  const schema = getSettingsSchema(moduleName);
  if (!schema) return null;

  // Global / Free baseline values + per-guild overrides. The global file is
  // also the canonical Free-tier baseline in the unified model; reading it
  // here gives us the "no paid sub" view.
  const globalSettings = loadRawSettings(moduleName, null);
  const guildSettings = guildId ? loadRawSettings(moduleName, guildId) : {};

  // Active-paid-tier delta on top of global. Free guilds and no-guild
  // contexts return `{}` here so the merge naturally falls through to
  // the global baseline.
  let tierOverrides: Record<string, any> = {};
  if (guildId) {
    try {
      const { getPremiumManager } = require('../premiumManager');
      const pm = getPremiumManager();
      const raw = pm.getPaidTierDelta(guildId, moduleName);
      // Filter out internal keys (_moduleEnabled, _disabledCommands, _hardLimits)
      for (const [k, v] of Object.entries(raw)) {
        if (!k.startsWith('_')) tierOverrides[k] = v;
      }
    } catch { /* premium manager not available */ }
  }

  // Merged hard limits (system + tier) for read-time clamping. Clamping is
  // purely a read-time view: storage retains whatever was saved, so a later
  // tier upgrade auto-restores the original value without any re-write.
  const mergedHardLimits = getMergedHardLimits(moduleName, guildId);

  const values: Record<string, SettingValue> = {};
  const sources: Record<string, 'default' | 'global' | 'tier' | 'guild'> = {};
  const clamped: Record<string, { stored: SettingValue; effective: SettingValue }> = {};

  for (const [key, definition] of Object.entries(schema.settings)) {
    let value: SettingValue;
    if (guildId && guildSettings.hasOwnProperty(key)) {
      value = guildSettings[key];
      sources[key] = 'guild';
    } else if (tierOverrides.hasOwnProperty(key)) {
      value = tierOverrides[key];
      sources[key] = 'tier';
    } else if (globalSettings.hasOwnProperty(key)) {
      value = globalSettings[key];
      sources[key] = 'global';
    } else {
      value = definition.default;
      sources[key] = 'default';
    }
    const effective = clampValueByHardLimit(value, definition.type, mergedHardLimits[key]);
    values[key] = effective;
    if (effective !== value) {
      clamped[key] = { stored: value, effective };
    }
  }

  const result: MergedSettings = { values, sources, schema };
  if (Object.keys(clamped).length > 0) result.clamped = clamped;
  return result;
}

/**
 * Clamp a stored setting value by its merged hard limit, type-aware.
 * Numbers honor min/max, strings minLength/maxLength (truncating from the
 * end if too long, not extending), arrays minItems/maxItems (truncating
 * from the end). Anything outside these types passes through.
 *
 * Storage is unchanged on read - this is purely a view-time clamp so a
 * later tier upgrade returns the original saved value automatically.
 */
function clampValueByHardLimit(
  value: SettingValue,
  type: string,
  limit: HardLimitOverride | undefined
): SettingValue {
  if (!limit) return value;

  if (type === 'number' && typeof value === 'number') {
    let v = value;
    if (typeof limit.min === 'number' && v < limit.min) v = limit.min;
    if (typeof limit.max === 'number' && v > limit.max) v = limit.max;
    return v;
  }

  if (type === 'string' && typeof value === 'string') {
    let v = value;
    if (typeof limit.maxLength === 'number' && v.length > limit.maxLength) {
      v = v.slice(0, limit.maxLength);
    }
    return v;
  }

  if (Array.isArray(value)) {
    let arr = value;
    if (typeof limit.maxItems === 'number' && arr.length > limit.maxItems) {
      arr = arr.slice(0, limit.maxItems);
    }
    return arr as SettingValue;
  }

  return value;
}

/**
 * Merge system-panel hard limits (global, in /data/global/{module}/settings.json)
 * with per-guild tier-supplied hard limits (from premiumManager). Tier wins on
 * overlap, mirroring settingsPanelFactory.ts:206-220.
 *
 * Returns a per-setting-key map of HardLimitOverride. Used by read-time
 * clamping (loadModuleSettings) and save-time validation (settingsHandlers).
 */
export function getMergedHardLimits(moduleName: string, guildId?: string | null): Record<string, HardLimitOverride> {
  const merged: Record<string, HardLimitOverride> = { ...loadHardLimits(moduleName) };
  if (!guildId) return merged;

  try {
    const { getPremiumManager } = require('../premiumManager');
    const tierLimits = getPremiumManager().getTierHardLimits(guildId, moduleName) as Record<string, HardLimitOverride>;
    if (tierLimits && typeof tierLimits === 'object') {
      for (const [k, v] of Object.entries(tierLimits)) {
        merged[k] = { ...(merged[k] || {}), ...v };
      }
    }
  } catch { /* premium manager not available */ }

  return merged;
}

/** Save a single setting */
export function saveModuleSetting(moduleName: string, key: string, value: SettingValue, guildId?: string | null): boolean {
  const schema = getSettingsSchema(moduleName);
  if (!schema?.settings[key]) return false;

  const settings = loadRawSettings(moduleName, guildId);
  settings[key] = value;

  try {
    saveRawSettings(moduleName, settings, guildId);
    return true;
  } catch {
    return false;
  }
}

/** Save multiple settings */
export function saveModuleSettings(moduleName: string, updates: Record<string, SettingValue>, guildId?: string | null): boolean {
  const schema = getSettingsSchema(moduleName);
  if (!schema) return false;

  const settings = loadRawSettings(moduleName, guildId);
  for (const [key, value] of Object.entries(updates)) {
    if (schema.settings[key]) settings[key] = value;
  }

  try {
    saveRawSettings(moduleName, settings, guildId);
    return true;
  } catch {
    return false;
  }
}

/** Reset a single setting to default */
export function resetModuleSetting(moduleName: string, key: string, guildId?: string | null): boolean {
  const settings = loadRawSettings(moduleName, guildId);
  if (!settings.hasOwnProperty(key)) return true;

  delete settings[key];
  try {
    saveRawSettings(moduleName, settings, guildId);
    return true;
  } catch {
    return false;
  }
}

/** Reset all settings (delete file) */
export function resetAllModuleSettings(moduleName: string, guildId?: string | null): boolean {
  const filePath = getSettingsFilePath(moduleName, guildId);
  if (!fs.existsSync(filePath)) return true;

  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Get schema default for a setting */
export function getSettingDefault(moduleName: string, key: string): SettingValue | undefined {
  const schema = getSettingsSchema(moduleName);
  return schema?.settings[key]?.default;
}

/** Get a single setting value */
export function getModuleSetting<T extends SettingValue>(moduleName: string, key: string, guildId?: string | null): T | undefined {
  const merged = loadModuleSettings(moduleName, guildId);
  return merged?.values[key] as T | undefined;
}

/** Export settings as JSON */
export function exportModuleSettings(moduleName: string, guildId?: string | null): string {
  return JSON.stringify(loadRawSettings(moduleName, guildId), null, 2);
}

/** Import settings from JSON */
export function importModuleSettings(moduleName: string, jsonData: string | Record<string, SettingValue>, guildId?: string | null): { success: boolean; errors: string[] } {
  const schema = getSettingsSchema(moduleName);
  if (!schema) return { success: false, errors: ['No schema found'] };

  let data: Record<string, SettingValue>;
  try {
    data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
  } catch {
    return { success: false, errors: ['Invalid JSON'] };
  }

  const errors: string[] = [];
  const validSettings: Record<string, SettingValue> = {};
  // Use effective limits (schema + system + tier hard limits) so an import
  // cannot bypass caps that the panel UI enforces.
  const mergedLimits = getMergedHardLimits(moduleName, guildId);

  for (const [key, value] of Object.entries(data)) {
    const definition = schema.settings[key];
    if (!definition) {
      errors.push(`Unknown: ${key}`);
      continue;
    }
    const result = validateValueWithEffectiveLimits(value, definition, mergedLimits[key]);
    if (!result.valid) {
      errors.push(`${key}: ${result.error}`);
    } else {
      validSettings[key] = value;
    }
  }

  if (Object.keys(validSettings).length > 0) {
    try {
      saveRawSettings(moduleName, validSettings, guildId);
    } catch {
      return { success: false, errors: ['Failed to save'] };
    }
  }

  return { success: errors.length === 0, errors };
}

// ============================================================================
// Hard Limits (System Panel Overrides)
// Stored in /data/global/{moduleName}/settings.json under _hardLimits
// ============================================================================

const HARD_LIMITS_KEY = '_hardLimits';

/** Load all hard limit overrides for a module (from global settings only) */
export function loadHardLimits(moduleName: string): Record<string, HardLimitOverride> {
  const filePath = getSettingsFilePath(moduleName, null);
  if (!fs.existsSync(filePath)) return {};

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '{}');
    return data[HARD_LIMITS_KEY] || {};
  } catch (error) {
    console.error(`[SettingsStorage] Error reading hard limits for ${moduleName}:`, error);
    return {};
  }
}

/** Save a hard limit override for a specific setting */
export function saveHardLimit(moduleName: string, key: string, limits: HardLimitOverride): boolean {
  const filePath = getSettingsFilePath(moduleName, null);
  const dirPath = path.dirname(filePath);

  try {
    // Load existing data
    let data: Record<string, any> = {};
    if (fs.existsSync(filePath)) {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '{}');
    }

    // Initialize _hardLimits if needed
    if (!data[HARD_LIMITS_KEY]) {
      data[HARD_LIMITS_KEY] = {};
    }

    // Check if limits object is empty (all undefined) - if so, delete the entry
    const hasValues = Object.values(limits).some(v => v !== undefined);
    if (hasValues) {
      data[HARD_LIMITS_KEY][key] = limits;
    } else {
      delete data[HARD_LIMITS_KEY][key];
    }

    // Clean up empty _hardLimits object
    if (Object.keys(data[HARD_LIMITS_KEY]).length === 0) {
      delete data[HARD_LIMITS_KEY];
    }

    // Save
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error(`[SettingsStorage] Error saving hard limit for ${moduleName}.${key}:`, error);
    return false;
  }
}

/** Get hard limit override for a specific setting */
export function getHardLimit(moduleName: string, key: string): HardLimitOverride | undefined {
  const hardLimits = loadHardLimits(moduleName);
  return hardLimits[key];
}

/** Reset hard limit for a specific setting (remove override) */
export function resetHardLimit(moduleName: string, key: string): boolean {
  return saveHardLimit(moduleName, key, {});
}

// ============================================================================
// Global Module Config (the deployment baseline)
//
// `/data/global/{moduleName}/settings.json` is the canonical source for the
// deployment baseline of a module. Conceptually identical to "what Free tier
// guilds see." Holds setting values, `_hardLimits` caps, `_moduleEnabled`
// flag, and `_disabledCommands` list.
//
// Paid tiers layer their deltas on top of this baseline at read time via
// `premiumManager.getTierOverrides`.
// ============================================================================

const MODULE_ENABLED_KEY = '_moduleEnabled';
const DISABLED_COMMANDS_KEY = '_disabledCommands';

/** Full shape of a module's global config, parsed from the settings file. */
export interface GlobalModuleConfig {
  values: Record<string, SettingValue>;
  hardLimits: Record<string, HardLimitOverride>;
  /** Default `true`; set to `false` to disable the module bot-wide. */
  moduleEnabled: boolean;
  /** Command names disabled bot-wide. */
  disabledCommands: string[];
}

/** Load the full global config for a module. */
export function loadGlobalModuleConfig(moduleName: string): GlobalModuleConfig {
  const filePath = getSettingsFilePath(moduleName, null);
  const empty: GlobalModuleConfig = {
    values: {},
    hardLimits: {},
    moduleEnabled: true,
    disabledCommands: [],
  };
  if (!fs.existsSync(filePath)) return empty;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '{}');
    const {
      [HARD_LIMITS_KEY]: hl,
      [MODULE_ENABLED_KEY]: me,
      [DISABLED_COMMANDS_KEY]: dc,
      ...rest
    } = data;
    return {
      values: rest,
      hardLimits: hl && typeof hl === 'object' ? hl : {},
      moduleEnabled: me !== false,
      disabledCommands: Array.isArray(dc) ? dc.filter((c): c is string => typeof c === 'string') : [],
    };
  } catch (error) {
    console.error(`[SettingsStorage] Error reading global config for ${moduleName}:`, error);
    return empty;
  }
}

/**
 * Partial update of the global module config. Field semantics:
 *
 * - `values` (REPLACE): if present, all existing non-internal keys in the
 *   file are removed first, then the new values are written. Callers who
 *   want to update a single setting must send the FULL desired values
 *   object. Pass `{}` to clear all setting values back to schema defaults.
 *   Omit the field entirely to leave existing values alone.
 * - `hardLimits` (REPLACE): if present, replaces the `_hardLimits` block.
 *   Pass `{}` to clear all caps. Omit to leave existing caps alone.
 * - `moduleEnabled`: `true` deletes the stored `_moduleEnabled` flag
 *   (true is the default); `false` writes it. Omit to leave as-is.
 * - `disabledCommands`: replaces the `_disabledCommands` list. Pass `[]`
 *   to clear. Omit to leave as-is.
 *
 * The Discord System Panel and the Web Premium Tiers > Free tier view are
 * both expected to send the FULL desired state per module so the file
 * mirrors the in-memory editor view exactly.
 */
export function saveGlobalModuleConfig(
  moduleName: string,
  partial: Partial<GlobalModuleConfig>,
): boolean {
  const filePath = getSettingsFilePath(moduleName, null);
  const dirPath = path.dirname(filePath);
  try {
    let data: Record<string, any> = {};
    if (fs.existsSync(filePath)) {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '{}');
    }

    if (partial.values !== undefined) {
      for (const k of Object.keys(data)) {
        if (k.startsWith('_')) continue;
        delete data[k];
      }
      for (const [k, v] of Object.entries(partial.values)) {
        data[k] = v;
      }
    }
    if (partial.hardLimits !== undefined) {
      const hl = partial.hardLimits;
      if (!hl || Object.keys(hl).length === 0) {
        delete data[HARD_LIMITS_KEY];
      } else {
        data[HARD_LIMITS_KEY] = hl;
      }
    }
    if (partial.moduleEnabled !== undefined) {
      if (partial.moduleEnabled === true) {
        delete data[MODULE_ENABLED_KEY];
      } else {
        data[MODULE_ENABLED_KEY] = false;
      }
    }
    if (partial.disabledCommands !== undefined) {
      const list = partial.disabledCommands;
      if (!Array.isArray(list) || list.length === 0) {
        delete data[DISABLED_COMMANDS_KEY];
      } else {
        data[DISABLED_COMMANDS_KEY] = list;
      }
    }

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error(`[SettingsStorage] Error saving global config for ${moduleName}:`, error);
    return false;
  }
}
