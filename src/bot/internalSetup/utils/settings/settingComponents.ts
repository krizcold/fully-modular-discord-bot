/**
 * Setting Components - Builds UI components for settings
 */

import { SectionBuilder, TextDisplayBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { SettingDefinition, SettingValue, HardLimitOverride } from '@bot/types/settingsTypes';
import { COLOR_PRESETS } from '@bot/types/settingsTypes';
import { getEffectiveLimits } from './settingsValidation';

export type SettingComponent = SectionBuilder;

export interface SettingComponentOptions {
  panelId: string;
  settingKey: string;
  definition: SettingDefinition;
  value: SettingValue;
  source: 'default' | 'global' | 'guild';
  defaultValue: SettingValue;
  disabled?: boolean;
  moduleName?: string;
  category?: string;
  /** Whether this is the System panel (shows absolute limits, enables hard limit editing) */
  isSystemPanel?: boolean;
  /** Hard limit overrides from global settings */
  hardLimitOverride?: HardLimitOverride;
}

function buildCustomId(panelId: string, action: string, key: string, moduleName?: string, category?: string): string {
  return moduleName && category
    ? `panel_${panelId}_btn_${action}_${key}_${moduleName}_${category}`
    : `panel_${panelId}_btn_${action}_${key}`;
}

function formatColorValue(hex: string): string {
  const preset = COLOR_PRESETS.find(p => p.hex.toUpperCase() === hex.toUpperCase());
  if (preset) {
    return `${preset.emoji} \`${preset.hex}\` ${preset.name}`;
  }
  return `🎨 \`${hex}\` Custom`;
}

function formatDisplayValue(value: SettingValue, type: string): string {
  if (value === null || value === undefined) return '_Not set_';

  switch (type) {
    case 'boolean':
      return value ? '`Enabled`' : '`Disabled`';
    case 'number':
      return `\`${value}\``;
    case 'string':
      if (typeof value === 'string') {
        if (value.length === 0) return '_Empty_';
        return value.length > 30 ? `\`${value.substring(0, 30)}...\`` : `\`${value}\``;
      }
      return String(value);
    case 'color':
      if (typeof value === 'string' && value) {
        return formatColorValue(value);
      }
      return '_Not set_';
    case 'channel':
      return value ? `<#${value}>` : '_None_';
    case 'role':
      return value ? `<@&${value}>` : '_None_';
    case 'multiChannel':
      if (Array.isArray(value) && value.length > 0) {
        return value.length <= 2 ? value.map(id => `<#${id}>`).join(', ') : `${value.length} channels`;
      }
      return '_None_';
    case 'multiRole':
      if (Array.isArray(value) && value.length > 0) {
        return value.length <= 2 ? value.map(id => `<@&${id}>`).join(', ') : `${value.length} roles`;
      }
      return '_None_';
    case 'select':
      return value ? `\`${value}\`` : '_Not selected_';
    case 'multiSelect':
      if (Array.isArray(value) && value.length > 0) {
        return value.length <= 2 ? value.map(v => `\`${v}\``).join(', ') : `${value.length} selected`;
      }
      return '_None_';
    default:
      return String(value);
  }
}

interface FormatConstraintsOptions {
  definition: SettingDefinition;
  hardLimitOverride?: HardLimitOverride;
  isSystemPanel?: boolean;
}

function formatConstraints(options: FormatConstraintsOptions): string {
  const { definition, hardLimitOverride, isSystemPanel } = options;
  const parts: string[] = [];
  const v = definition.validation;
  if (!v) return '';

  // Get effective limits (hard limit overrides applied)
  const effective = getEffectiveLimits(definition, hardLimitOverride);

  if (definition.type === 'number') {
    // Show effective limits
    if (effective.min !== undefined && effective.max !== undefined) {
      parts.push(`${effective.min} → ${effective.max}`);
    } else if (effective.min !== undefined) {
      parts.push(`min: ${effective.min}`);
    } else if (effective.max !== undefined) {
      parts.push(`max: ${effective.max}`);
    }

    // Show absolute limits for System panel
    if (isSystemPanel && (v.absoluteMin !== undefined || v.absoluteMax !== undefined)) {
      const absLimits: string[] = [];
      if (v.absoluteMin !== undefined) absLimits.push(`min: ${v.absoluteMin}`);
      if (v.absoluteMax !== undefined) absLimits.push(`max: ${v.absoluteMax}`);
      parts.push(`Absolute: ${absLimits.join(', ')}`);
    }
  }

  if (definition.type === 'string') {
    // Show effective limits
    if (effective.minLength !== undefined && effective.maxLength !== undefined) {
      parts.push(`${effective.minLength}-${effective.maxLength} chars`);
    } else if (effective.minLength !== undefined) {
      parts.push(`min: ${effective.minLength} chars`);
    } else if (effective.maxLength !== undefined) {
      parts.push(`max: ${effective.maxLength} chars`);
    }

    // Show absolute limits for System panel
    if (isSystemPanel && (v.absoluteMinLength !== undefined || v.absoluteMaxLength !== undefined)) {
      const absLimits: string[] = [];
      if (v.absoluteMinLength !== undefined) absLimits.push(`min: ${v.absoluteMinLength}`);
      if (v.absoluteMaxLength !== undefined) absLimits.push(`max: ${v.absoluteMaxLength}`);
      parts.push(`Absolute: ${absLimits.join(', ')}`);
    }
  }

  if (['multiSelect', 'multiChannel', 'multiRole'].includes(definition.type)) {
    // Show effective limits
    if (effective.minItems !== undefined && effective.maxItems !== undefined) {
      parts.push(`${effective.minItems}-${effective.maxItems} items`);
    } else if (effective.minItems !== undefined) {
      parts.push(`min: ${effective.minItems} items`);
    } else if (effective.maxItems !== undefined) {
      parts.push(`max: ${effective.maxItems} items`);
    }

    // Show absolute limits for System panel
    if (isSystemPanel && (v.absoluteMinItems !== undefined || v.absoluteMaxItems !== undefined)) {
      const absLimits: string[] = [];
      if (v.absoluteMinItems !== undefined) absLimits.push(`min: ${v.absoluteMinItems}`);
      if (v.absoluteMaxItems !== undefined) absLimits.push(`max: ${v.absoluteMaxItems}`);
      parts.push(`Absolute: ${absLimits.join(', ')}`);
    }
  }

  return parts.length > 0 ? `[${parts.join(', ')}]` : '';
}

function formatDefault(defaultValue: SettingValue, type: string): string {
  if (defaultValue === null || defaultValue === undefined) return '';
  if (type === 'boolean') return `[Default: ${defaultValue ? 'Enabled' : 'Disabled'}]`;
  if (['channel', 'role', 'multiChannel', 'multiRole'].includes(type)) return '';
  if (type === 'color' && typeof defaultValue === 'string') {
    const preset = COLOR_PRESETS.find(p => p.hex.toUpperCase() === defaultValue.toUpperCase());
    return preset ? `[Default: ${preset.emoji} ${preset.name}]` : `[Default: ${defaultValue}]`;
  }
  if (Array.isArray(defaultValue)) {
    return defaultValue.length === 0 ? '[Default: None]' : `[Default: ${defaultValue.length} items]`;
  }
  return `[Default: ${defaultValue}]`;
}

function buildInfoLine(options: SettingComponentOptions): string {
  const { definition, value, defaultValue, hardLimitOverride, isSystemPanel } = options;

  // Always show value and constraints
  const displayValue = formatDisplayValue(value, definition.type);
  const constraints = formatConstraints({ definition, hardLimitOverride, isSystemPanel });
  const defaultStr = formatDefault(defaultValue, definition.type);

  const parts = [displayValue];
  const meta = [constraints, defaultStr].filter(Boolean);
  if (meta.length > 0) parts.push(`*${meta.join(' ')}*`);

  return parts.join(' ');
}

/** Build a setting component - generic for all types */
export function buildSettingComponent(options: SettingComponentOptions): SettingComponent[] {
  const { panelId, settingKey, definition, value, disabled, moduleName, category, isSystemPanel } = options;
  const infoLine = buildInfoLine(options);
  const isBoolean = definition.type === 'boolean';

  // Build content (errors are shown via ephemeral messages, not inline)
  let content = `**${definition.label}**\n${infoLine}`;
  if (definition.description) {
    content += `\n-# ${definition.description}`;
  }

  // Determine edit action: System panel uses 'sysedit' for types with limit editing
  const hasLimitEditing = ['number', 'string', 'multiSelect', 'multiChannel', 'multiRole'].includes(definition.type);
  const editAction = isSystemPanel && hasLimitEditing ? 'sysedit' : 'edit';

  const section = new SectionBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(content)
    )
    .setButtonAccessory(
      new ButtonBuilder()
        .setCustomId(buildCustomId(panelId, isBoolean ? 'toggle' : editAction, settingKey, moduleName, category))
        .setLabel(isBoolean ? (value ? 'Disable' : 'Enable') : 'Edit')
        .setStyle(isBoolean ? (value ? ButtonStyle.Secondary : ButtonStyle.Primary) : ButtonStyle.Secondary)
        .setDisabled(disabled || false)
    );

  return [section];
}
