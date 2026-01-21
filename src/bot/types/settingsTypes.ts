/**
 * Settings Types
 *
 * Core interfaces for the Module Settings Panel System.
 * These types define the structure of settingsSchema.json files
 * and the runtime settings management system.
 */

import { ChannelType } from 'discord.js';

/**
 * Root schema definition for module settings
 */
export interface SettingsSchema {
  /** Unique identifier for this schema */
  id: string;
  /** Schema version (semver) */
  version: string;
  /** Display name for the settings panel */
  name: string;
  /** Optional description shown in the panel header */
  description?: string;
  /** Optional icon for the settings panel (emoji) */
  icon?: string;
  /** Scope determines where settings can be configured */
  scope: 'global' | 'guild' | 'both';
  /** Sections for organizing settings */
  sections: SectionDefinition[];
  /** Setting definitions keyed by setting ID */
  settings: Record<string, SettingDefinition>;
}

/**
 * Section definition for grouping related settings
 */
export interface SectionDefinition {
  /** Unique section ID */
  id: string;
  /** Display name for the section tab */
  name: string;
  /** Optional description shown when section is selected */
  description?: string;
  /** Optional emoji icon for the section */
  icon?: string;
  /** Display order (lower numbers first) */
  order: number;
}

/**
 * Individual setting definition
 */
export interface SettingDefinition {
  /** Setting type determines the UI component and validation */
  type: SettingType;
  /** Default value (used when no override exists) */
  default: SettingValue;
  /** Display label for the setting */
  label: string;
  /** Optional description/help text */
  description?: string;
  /** Section ID this setting belongs to */
  section: string;
  /** Display order within section (lower numbers first) */
  order: number;
  /** Validation rules */
  validation?: ValidationRules;
  /** Conditional display/disable rules */
  conditions?: SettingConditions;
  /** Options for 'select' type */
  options?: SelectOption[];
  /** Channel types for 'channel' and 'multiChannel' types */
  channelTypes?: ChannelType[];
  /** Placeholder text for string/number inputs */
  placeholder?: string;
}

/**
 * Supported setting types
 */
export type SettingType =
  | 'boolean'      // Toggle switch
  | 'string'       // Text input (modal)
  | 'number'       // Number input (modal) with optional min/max
  | 'color'        // Color picker (dropdown presets + custom hex input)
  | 'select'       // Single select dropdown
  | 'multiSelect'  // Multi-select dropdown
  | 'channel'      // Single channel picker
  | 'role'         // Single role picker
  | 'multiChannel' // Multiple channel picker
  | 'multiRole';   // Multiple role picker

/**
 * Color preset for the color picker
 */
export interface ColorPreset {
  /** Hex value (0xRRGGBB format) */
  hex: string;
  /** Color name */
  name: string;
  /** Emoji to display */
  emoji: string;
}

/**
 * Standard color presets for the color picker
 */
export const COLOR_PRESETS: ColorPreset[] = [
  { hex: '0xE74C3C', name: 'Red', emoji: '🔴' },
  { hex: '0xF39C12', name: 'Orange', emoji: '🟠' },
  { hex: '0xF1C40F', name: 'Yellow', emoji: '🟡' },
  { hex: '0x2ECC71', name: 'Green', emoji: '🟢' },
  { hex: '0x3498DB', name: 'Blue', emoji: '🔵' },
  { hex: '0x9B59B6', name: 'Purple', emoji: '🟣' },
  { hex: '0x2C3E50', name: 'Dark', emoji: '⚫' },
  { hex: '0xECF0F1', name: 'Light', emoji: '⚪' },
  { hex: '0x8B4513', name: 'Brown', emoji: '🟤' },
  { hex: '0x5865F2', name: 'Discord Blurple', emoji: '🔷' },
  { hex: '0x57F287', name: 'Discord Green', emoji: '💚' },
  { hex: '0xFEE75C', name: 'Discord Yellow', emoji: '💛' },
  { hex: '0xEB459E', name: 'Discord Fuchsia', emoji: '💗' },
  { hex: '0xED4245', name: 'Discord Red', emoji: '❤️' },
];

/**
 * Possible setting values
 */
export type SettingValue =
  | boolean
  | string
  | number
  | string[]   // For multiSelect, multiChannel, multiRole
  | null;

/**
 * Option for select/multiSelect types
 */
export interface SelectOption {
  /** Value stored when selected */
  value: string;
  /** Display label */
  label: string;
  /** Optional description */
  description?: string;
  /** Optional emoji */
  emoji?: string;
}

/**
 * Validation rules for settings
 *
 * Limit Hierarchy:
 * 1. Absolute Limits (schema) - IMMUTABLE, prevents logic-breaking values
 * 2. Hard Limits (System panel overrides min/max) - Constrains guild values
 * 3. Guild Values - Set within Hard Limits
 */
export interface ValidationRules {
  /** Whether the setting is required (can't be empty/null) */
  required?: boolean;

  // === Default Limits (can be overridden by System panel as "Hard Limits") ===
  /** Minimum value for numbers */
  min?: number;
  /** Maximum value for numbers */
  max?: number;
  /** Minimum length for strings */
  minLength?: number;
  /** Maximum length for strings */
  maxLength?: number;
  /** Minimum items for multi-select types */
  minItems?: number;
  /** Maximum items for multi-select types */
  maxItems?: number;

  // === Absolute Limits (IMMUTABLE - prevents logic-breaking values) ===
  // Use sparingly: only for values that would break logic (0/negative) or external limits (Discord API)
  /** Absolute minimum for numbers - even System can't go below this */
  absoluteMin?: number;
  /** Absolute maximum for numbers - for external limits like Discord API caps */
  absoluteMax?: number;
  /** Absolute minimum length for strings */
  absoluteMinLength?: number;
  /** Absolute maximum length for strings */
  absoluteMaxLength?: number;
  /** Absolute minimum items for multi-select types */
  absoluteMinItems?: number;
  /** Absolute maximum items for multi-select types - e.g., 25 for Discord dropdowns */
  absoluteMaxItems?: number;

  /** Regex pattern for strings */
  pattern?: string;
  /** Custom error message for pattern validation */
  patternMessage?: string;
}

/**
 * Hard limit overrides set by System panel
 * Stored in /data/global/{module}/settings.json under _hardLimits
 */
export interface HardLimitOverride {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

/**
 * Conditional display/disable rules
 */
export interface SettingConditions {
  /** Condition to show the setting (hidden if false) */
  show?: ConditionRule | ConditionGroup;
  /** Condition to disable the setting (grayed out if true) */
  disable?: ConditionRule | ConditionGroup;
}

/**
 * Single condition rule
 */
export interface ConditionRule {
  /** Field/setting ID to check */
  field: string;
  /** Comparison operator */
  operator: ConditionOperator;
  /** Value to compare against (not needed for isEmpty/isNotEmpty) */
  value?: SettingValue;
}

/**
 * Condition operators
 */
export type ConditionOperator =
  | 'equals'
  | 'notEquals'
  | 'greaterThan'
  | 'lessThan'
  | 'greaterThanOrEquals'
  | 'lessThanOrEquals'
  | 'contains'      // For arrays/strings
  | 'notContains'   // For arrays/strings
  | 'isEmpty'
  | 'isNotEmpty';

/**
 * Group of conditions with logical operator
 */
export interface ConditionGroup {
  /** All conditions must be true (AND) */
  all?: (ConditionRule | ConditionGroup)[];
  /** Any condition must be true (OR) */
  any?: (ConditionRule | ConditionGroup)[];
}

/**
 * Result of validating a single value
 */
export interface SingleValidationResult {
  /** Whether the value is valid */
  valid: boolean;
  /** Error message if invalid */
  error?: string;
}

/**
 * Result of validating all settings
 */
export interface ValidationResult {
  /** Whether all settings are valid */
  valid: boolean;
  /** List of validation errors */
  errors: ValidationError[];
}

/**
 * Individual validation error
 */
export interface ValidationError {
  /** Setting field that has the error */
  field: string;
  /** Error message */
  message: string;
  /** The invalid value */
  value: SettingValue;
}

/**
 * Result of evaluating conditions
 */
export interface ConditionEvaluationResult {
  /** Whether the setting should be visible */
  visible: boolean;
  /** Whether the setting should be disabled */
  disabled: boolean;
}

/**
 * Merged settings with metadata
 */
export interface MergedSettings {
  /** The merged setting values */
  values: Record<string, SettingValue>;
  /** Source of each value ('default' | 'global' | 'guild') */
  sources: Record<string, 'default' | 'global' | 'guild'>;
  /** The schema used */
  schema: SettingsSchema;
}

/**
 * Settings panel state for UI management
 */
export interface SettingsPanelState {
  /** Module ID being edited */
  moduleId: string;
  /** Current scope being edited */
  scope: 'global' | 'guild';
  /** Currently selected section */
  currentSection: string;
  /** Pending changes not yet saved */
  pendingChanges: Record<string, SettingValue>;
  /** Validation errors by field */
  validationErrors: Record<string, string>;
  /** Whether there are unsaved changes */
  isDirty: boolean;
}

/**
 * Discovered module with settings
 */
export interface ModuleWithSettings {
  /** Module name (folder name) */
  name: string;
  /** Module display name */
  displayName: string;
  /** Module category */
  category: string;
  /** Path to the module */
  path: string;
  /** The loaded settings schema */
  schema: SettingsSchema;
}
