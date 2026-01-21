/**
 * Settings Storage - File I/O for module settings
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SettingValue, MergedSettings, HardLimitOverride } from '@bot/types/settingsTypes';
import { getSettingsSchema } from './settingsDiscovery';
import { validateSettingValue } from './settingsValidation';

const SETTINGS_FILENAME = 'settings.json';

function getSettingsFilePath(moduleName: string, guildId?: string | null): string {
  if (guildId) {
    return path.join('/data', guildId, moduleName, SETTINGS_FILENAME);
  }
  return path.join('/data/global', moduleName, SETTINGS_FILENAME);
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

/** Load module settings with 3-tier merge: Guild > Global > Schema defaults */
export function loadModuleSettings(moduleName: string, guildId?: string | null, category?: string): MergedSettings | null {
  const schema = getSettingsSchema(moduleName, category);
  if (!schema) return null;

  const globalSettings = loadRawSettings(moduleName, null);
  const guildSettings = guildId ? loadRawSettings(moduleName, guildId) : {};

  const values: Record<string, SettingValue> = {};
  const sources: Record<string, 'default' | 'global' | 'guild'> = {};

  for (const [key, definition] of Object.entries(schema.settings)) {
    if (guildId && guildSettings.hasOwnProperty(key)) {
      values[key] = guildSettings[key];
      sources[key] = 'guild';
    } else if (globalSettings.hasOwnProperty(key)) {
      values[key] = globalSettings[key];
      sources[key] = 'global';
    } else {
      values[key] = definition.default;
      sources[key] = 'default';
    }
  }

  return { values, sources, schema };
}

/** Save a single setting */
export function saveModuleSetting(moduleName: string, key: string, value: SettingValue, guildId?: string | null, category?: string): boolean {
  const schema = getSettingsSchema(moduleName, category);
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
export function saveModuleSettings(moduleName: string, updates: Record<string, SettingValue>, guildId?: string | null, category?: string): boolean {
  const schema = getSettingsSchema(moduleName, category);
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
export function getSettingDefault(moduleName: string, key: string, category?: string): SettingValue | undefined {
  const schema = getSettingsSchema(moduleName, category);
  return schema?.settings[key]?.default;
}

/** Get a single setting value */
export function getModuleSetting<T extends SettingValue>(moduleName: string, key: string, guildId?: string | null, category?: string): T | undefined {
  const merged = loadModuleSettings(moduleName, guildId, category);
  return merged?.values[key] as T | undefined;
}

/** Export settings as JSON */
export function exportModuleSettings(moduleName: string, guildId?: string | null): string {
  return JSON.stringify(loadRawSettings(moduleName, guildId), null, 2);
}

/** Import settings from JSON */
export function importModuleSettings(moduleName: string, jsonData: string | Record<string, SettingValue>, guildId?: string | null, category?: string): { success: boolean; errors: string[] } {
  const schema = getSettingsSchema(moduleName, category);
  if (!schema) return { success: false, errors: ['No schema found'] };

  let data: Record<string, SettingValue>;
  try {
    data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
  } catch {
    return { success: false, errors: ['Invalid JSON'] };
  }

  const errors: string[] = [];
  const validSettings: Record<string, SettingValue> = {};

  for (const [key, value] of Object.entries(data)) {
    const definition = schema.settings[key];
    if (!definition) {
      errors.push(`Unknown: ${key}`);
      continue;
    }
    const result = validateSettingValue(value, definition);
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
