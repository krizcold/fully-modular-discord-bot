/**
 * Settings Validation
 *
 * Comprehensive validation system for module settings.
 * Handles value validation, condition evaluation, and batch validation.
 */

import type {
  SettingsSchema,
  SettingDefinition,
  SettingValue,
  ValidationRules,
  SingleValidationResult,
  ValidationResult,
  ValidationError,
  ConditionEvaluationResult,
  ConditionRule,
  ConditionGroup,
  SettingConditions,
  HardLimitOverride,
} from '@bot/types/settingsTypes';

// ============================================================================
// Effective Limits (merges schema defaults with hard limit overrides)
// ============================================================================

/**
 * Effective limits after merging schema defaults with hard limit overrides
 */
export interface EffectiveLimits {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

/**
 * Get effective limits for a setting by merging schema defaults with hard limit overrides
 * Hard limit overrides take priority over schema defaults
 */
export function getEffectiveLimits(
  definition: SettingDefinition,
  hardLimitOverride?: HardLimitOverride
): EffectiveLimits {
  const validation = definition.validation || {};
  const override = hardLimitOverride || {};

  return {
    min: override.min ?? validation.min,
    max: override.max ?? validation.max,
    minLength: override.minLength ?? validation.minLength,
    maxLength: override.maxLength ?? validation.maxLength,
    minItems: override.minItems ?? validation.minItems,
    maxItems: override.maxItems ?? validation.maxItems,
  };
}

/**
 * Validate that hard limit values are within absolute limits
 * Returns error message if invalid, null if valid
 */
export function validateHardLimits(
  limits: HardLimitOverride,
  validation: ValidationRules | undefined,
  settingType: string
): string | null {
  if (!validation) return null;

  // Number type validations
  if (settingType === 'number') {
    const { absoluteMin, absoluteMax } = validation;

    if (limits.min !== undefined) {
      if (absoluteMin !== undefined && limits.min < absoluteMin) {
        return `Hard limit min (${limits.min}) cannot be below absolute minimum (${absoluteMin})`;
      }
      if (absoluteMax !== undefined && limits.min > absoluteMax) {
        return `Hard limit min (${limits.min}) cannot exceed absolute maximum (${absoluteMax})`;
      }
    }

    if (limits.max !== undefined) {
      if (absoluteMin !== undefined && limits.max < absoluteMin) {
        return `Hard limit max (${limits.max}) cannot be below absolute minimum (${absoluteMin})`;
      }
      if (absoluteMax !== undefined && limits.max > absoluteMax) {
        return `Hard limit max (${limits.max}) cannot exceed absolute maximum (${absoluteMax})`;
      }
    }

    if (limits.min !== undefined && limits.max !== undefined && limits.min > limits.max) {
      return `Hard limit min (${limits.min}) cannot be greater than max (${limits.max})`;
    }
  }

  // String type validations
  if (settingType === 'string') {
    const { absoluteMinLength, absoluteMaxLength } = validation;

    if (limits.minLength !== undefined) {
      if (absoluteMinLength !== undefined && limits.minLength < absoluteMinLength) {
        return `Hard limit minLength (${limits.minLength}) cannot be below absolute minimum (${absoluteMinLength})`;
      }
      if (absoluteMaxLength !== undefined && limits.minLength > absoluteMaxLength) {
        return `Hard limit minLength (${limits.minLength}) cannot exceed absolute maximum (${absoluteMaxLength})`;
      }
    }

    if (limits.maxLength !== undefined) {
      if (absoluteMinLength !== undefined && limits.maxLength < absoluteMinLength) {
        return `Hard limit maxLength (${limits.maxLength}) cannot be below absolute minimum (${absoluteMinLength})`;
      }
      if (absoluteMaxLength !== undefined && limits.maxLength > absoluteMaxLength) {
        return `Hard limit maxLength (${limits.maxLength}) cannot exceed absolute maximum (${absoluteMaxLength})`;
      }
    }

    if (limits.minLength !== undefined && limits.maxLength !== undefined && limits.minLength > limits.maxLength) {
      return `Hard limit minLength (${limits.minLength}) cannot be greater than maxLength (${limits.maxLength})`;
    }
  }

  // Multi-select type validations
  if (['multiSelect', 'multiChannel', 'multiRole'].includes(settingType)) {
    const { absoluteMinItems, absoluteMaxItems } = validation;

    if (limits.minItems !== undefined) {
      if (absoluteMinItems !== undefined && limits.minItems < absoluteMinItems) {
        return `Hard limit minItems (${limits.minItems}) cannot be below absolute minimum (${absoluteMinItems})`;
      }
      if (absoluteMaxItems !== undefined && limits.minItems > absoluteMaxItems) {
        return `Hard limit minItems (${limits.minItems}) cannot exceed absolute maximum (${absoluteMaxItems})`;
      }
    }

    if (limits.maxItems !== undefined) {
      if (absoluteMinItems !== undefined && limits.maxItems < absoluteMinItems) {
        return `Hard limit maxItems (${limits.maxItems}) cannot be below absolute minimum (${absoluteMinItems})`;
      }
      if (absoluteMaxItems !== undefined && limits.maxItems > absoluteMaxItems) {
        return `Hard limit maxItems (${limits.maxItems}) cannot exceed absolute maximum (${absoluteMaxItems})`;
      }
    }

    if (limits.minItems !== undefined && limits.maxItems !== undefined && limits.minItems > limits.maxItems) {
      return `Hard limit minItems (${limits.minItems}) cannot be greater than maxItems (${limits.maxItems})`;
    }
  }

  return null;
}

/**
 * Validate a single value against validation rules
 *
 * @param value - Value to validate
 * @param rules - Validation rules from schema
 * @param settingType - The setting type for type-specific validation
 * @returns Validation result with valid flag and optional error
 */
export function validateValue(
  value: SettingValue,
  rules: ValidationRules | undefined,
  settingType: string
): SingleValidationResult {
  // No rules = always valid
  if (!rules) {
    return { valid: true };
  }

  // Required check
  if (rules.required) {
    if (value === null || value === undefined) {
      return { valid: false, error: 'This field is required' };
    }
    if (typeof value === 'string' && value.trim() === '') {
      return { valid: false, error: 'This field is required' };
    }
    if (Array.isArray(value) && value.length === 0) {
      return { valid: false, error: 'At least one selection is required' };
    }
  }

  // Skip further validation if value is empty and not required
  if (value === null || value === undefined || value === '') {
    return { valid: true };
  }

  // Number validation
  if (settingType === 'number' && typeof value === 'number') {
    if (isNaN(value)) {
      return { valid: false, error: 'Must be a valid number' };
    }
    // Absolute limits take priority (immutable bounds)
    if (rules.absoluteMin !== undefined && value < rules.absoluteMin) {
      return { valid: false, error: `Value cannot be below ${rules.absoluteMin}` };
    }
    if (rules.absoluteMax !== undefined && value > rules.absoluteMax) {
      return { valid: false, error: `Value cannot exceed ${rules.absoluteMax}` };
    }
    // Then check effective limits (min/max)
    if (rules.min !== undefined && value < rules.min) {
      return { valid: false, error: `Value must be at least ${rules.min}` };
    }
    if (rules.max !== undefined && value > rules.max) {
      return { valid: false, error: `Value must be at most ${rules.max}` };
    }
  }

  // String validation
  if (settingType === 'string' && typeof value === 'string') {
    // Absolute limits take priority (immutable bounds)
    if (rules.absoluteMinLength !== undefined && value.length < rules.absoluteMinLength) {
      return { valid: false, error: `Length cannot be below ${rules.absoluteMinLength} characters` };
    }
    if (rules.absoluteMaxLength !== undefined && value.length > rules.absoluteMaxLength) {
      return { valid: false, error: `Length cannot exceed ${rules.absoluteMaxLength} characters` };
    }
    // Then check effective limits
    if (rules.minLength !== undefined && value.length < rules.minLength) {
      return { valid: false, error: `Must be at least ${rules.minLength} characters` };
    }
    if (rules.maxLength !== undefined && value.length > rules.maxLength) {
      return { valid: false, error: `Must be at most ${rules.maxLength} characters` };
    }
    if (rules.pattern) {
      try {
        const regex = new RegExp(rules.pattern);
        if (!regex.test(value)) {
          return {
            valid: false,
            error: rules.patternMessage || 'Value does not match required format',
          };
        }
      } catch {
        // Invalid regex pattern in schema - skip pattern validation
        console.warn(`[SettingsValidation] Invalid regex pattern: ${rules.pattern}`);
      }
    }
  }

  // Array validation (multiSelect, multiChannel, multiRole)
  if (Array.isArray(value)) {
    // Absolute limits take priority (immutable bounds)
    if (rules.absoluteMinItems !== undefined && value.length < rules.absoluteMinItems) {
      return { valid: false, error: `Cannot select fewer than ${rules.absoluteMinItems} item(s)` };
    }
    if (rules.absoluteMaxItems !== undefined && value.length > rules.absoluteMaxItems) {
      return { valid: false, error: `Cannot select more than ${rules.absoluteMaxItems} item(s)` };
    }
    // Then check effective limits
    if (rules.minItems !== undefined && value.length < rules.minItems) {
      return { valid: false, error: `Select at least ${rules.minItems} item(s)` };
    }
    if (rules.maxItems !== undefined && value.length > rules.maxItems) {
      return { valid: false, error: `Select at most ${rules.maxItems} item(s)` };
    }
  }

  return { valid: true };
}

/**
 * Validate all settings against the schema
 *
 * @param values - Object with setting key-value pairs
 * @param schema - Settings schema
 * @returns Validation result with all errors
 */
export function validateAllSettings(
  values: Record<string, SettingValue>,
  schema: SettingsSchema
): ValidationResult {
  const errors: ValidationError[] = [];

  for (const [key, definition] of Object.entries(schema.settings)) {
    const value = values[key];
    const result = validateValue(value, definition.validation, definition.type);

    if (!result.valid && result.error) {
      errors.push({
        field: key,
        message: result.error,
        value,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Evaluate a single condition rule
 *
 * @param rule - The condition rule to evaluate
 * @param values - Current settings values
 * @returns true if condition is met
 */
function evaluateConditionRule(
  rule: ConditionRule,
  values: Record<string, SettingValue>
): boolean {
  const fieldValue = values[rule.field];

  switch (rule.operator) {
    case 'equals':
      return fieldValue === rule.value;

    case 'notEquals':
      return fieldValue !== rule.value;

    case 'greaterThan':
      if (typeof fieldValue === 'number' && typeof rule.value === 'number') {
        return fieldValue > rule.value;
      }
      return false;

    case 'lessThan':
      if (typeof fieldValue === 'number' && typeof rule.value === 'number') {
        return fieldValue < rule.value;
      }
      return false;

    case 'greaterThanOrEquals':
      if (typeof fieldValue === 'number' && typeof rule.value === 'number') {
        return fieldValue >= rule.value;
      }
      return false;

    case 'lessThanOrEquals':
      if (typeof fieldValue === 'number' && typeof rule.value === 'number') {
        return fieldValue <= rule.value;
      }
      return false;

    case 'contains':
      if (Array.isArray(fieldValue)) {
        return fieldValue.includes(rule.value as string);
      }
      if (typeof fieldValue === 'string' && typeof rule.value === 'string') {
        return fieldValue.includes(rule.value);
      }
      return false;

    case 'notContains':
      if (Array.isArray(fieldValue)) {
        return !fieldValue.includes(rule.value as string);
      }
      if (typeof fieldValue === 'string' && typeof rule.value === 'string') {
        return !fieldValue.includes(rule.value);
      }
      return true;

    case 'isEmpty':
      if (fieldValue === null || fieldValue === undefined) return true;
      if (typeof fieldValue === 'string') return fieldValue.trim() === '';
      if (Array.isArray(fieldValue)) return fieldValue.length === 0;
      return false;

    case 'isNotEmpty':
      if (fieldValue === null || fieldValue === undefined) return false;
      if (typeof fieldValue === 'string') return fieldValue.trim() !== '';
      if (Array.isArray(fieldValue)) return fieldValue.length > 0;
      return true;

    default:
      return true;
  }
}

/**
 * Recursively evaluate a condition (rule or group)
 *
 * @param condition - Condition rule or group to evaluate
 * @param values - Current settings values
 * @returns true if condition is met
 */
function evaluateCondition(
  condition: ConditionRule | ConditionGroup,
  values: Record<string, SettingValue>
): boolean {
  // Check if it's a group
  if ('all' in condition || 'any' in condition) {
    const group = condition as ConditionGroup;

    if (group.all && group.all.length > 0) {
      // All conditions must be true
      return group.all.every(c => evaluateCondition(c, values));
    }

    if (group.any && group.any.length > 0) {
      // Any condition must be true
      return group.any.some(c => evaluateCondition(c, values));
    }

    // Empty group = true
    return true;
  }

  // It's a rule
  return evaluateConditionRule(condition as ConditionRule, values);
}

/**
 * Evaluate visibility and disabled state conditions for a setting
 *
 * @param conditions - Setting conditions from schema
 * @param values - Current settings values
 * @returns Object with visible and disabled flags
 */
export function evaluateConditions(
  conditions: SettingConditions | undefined,
  values: Record<string, SettingValue>
): ConditionEvaluationResult {
  const result: ConditionEvaluationResult = {
    visible: true,
    disabled: false,
  };

  if (!conditions) {
    return result;
  }

  // Evaluate show condition
  if (conditions.show) {
    result.visible = evaluateCondition(conditions.show, values);
  }

  // Evaluate disable condition
  if (conditions.disable) {
    result.disabled = evaluateCondition(conditions.disable, values);
  }

  return result;
}

/**
 * Get all visible settings after evaluating conditions
 *
 * @param schema - Settings schema
 * @param values - Current settings values
 * @returns Object with setting keys and their visibility/disabled state
 */
export function getVisibleSettings(
  schema: SettingsSchema,
  values: Record<string, SettingValue>
): Record<string, ConditionEvaluationResult> {
  const results: Record<string, ConditionEvaluationResult> = {};

  for (const [key, definition] of Object.entries(schema.settings)) {
    results[key] = evaluateConditions(definition.conditions, values);
  }

  return results;
}

/**
 * Validate only visible settings (skip hidden settings)
 *
 * @param values - Object with setting key-value pairs
 * @param schema - Settings schema
 * @returns Validation result with only errors for visible settings
 */
export function validateVisibleSettings(
  values: Record<string, SettingValue>,
  schema: SettingsSchema
): ValidationResult {
  const visibilityStates = getVisibleSettings(schema, values);
  const errors: ValidationError[] = [];

  for (const [key, definition] of Object.entries(schema.settings)) {
    // Skip hidden settings
    if (!visibilityStates[key]?.visible) {
      continue;
    }

    const value = values[key];
    const result = validateValue(value, definition.validation, definition.type);

    if (!result.valid && result.error) {
      errors.push({
        field: key,
        message: result.error,
        value,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Parse a string value into the appropriate type for a setting
 *
 * @param value - String value (e.g., from modal input)
 * @param settingType - Target setting type
 * @returns Parsed value or null if parsing failed
 */
export function parseSettingValue(
  value: string,
  settingType: string
): SettingValue {
  switch (settingType) {
    case 'boolean':
      return value.toLowerCase() === 'true';

    case 'number':
      const num = parseFloat(value);
      return isNaN(num) ? null : num;

    case 'string':
      return value;

    case 'select':
      return value;

    case 'multiSelect':
    case 'multiChannel':
    case 'multiRole':
      // These come from select menus, not string parsing
      // But if we receive a comma-separated string, split it
      return value.split(',').map(v => v.trim()).filter(v => v);

    case 'channel':
    case 'role':
      return value;

    default:
      return value;
  }
}

/**
 * Format validation errors into a human-readable summary
 */
export function formatValidationErrors(errors: ValidationError[], schema: SettingsSchema): string {
  if (errors.length === 0) return '';
  return errors.map(err => {
    const label = schema.settings[err.field]?.label || err.field;
    return `• **${label}**: ${err.message}`;
  }).join('\n');
}

/** Validate a value against a setting definition (convenience wrapper) */
export function validateSettingValue(value: SettingValue, definition: SettingDefinition): SingleValidationResult {
  return validateValue(value, definition.validation, definition.type);
}

/**
 * Validate a value using effective limits (hard limit overrides applied)
 * Use this for guild panel validation where hard limits should constrain values
 */
export function validateValueWithEffectiveLimits(
  value: SettingValue,
  definition: SettingDefinition,
  hardLimitOverride?: HardLimitOverride
): SingleValidationResult {
  const effectiveLimits = getEffectiveLimits(definition, hardLimitOverride);
  const validation = definition.validation || {};

  // Build effective validation rules
  const effectiveRules: ValidationRules = {
    ...validation,
    min: effectiveLimits.min,
    max: effectiveLimits.max,
    minLength: effectiveLimits.minLength,
    maxLength: effectiveLimits.maxLength,
    minItems: effectiveLimits.minItems,
    maxItems: effectiveLimits.maxItems,
  };

  return validateValue(value, effectiveRules, definition.type);
}
