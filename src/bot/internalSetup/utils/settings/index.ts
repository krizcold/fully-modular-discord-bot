/**
 * Settings Utilities
 *
 * Exports all settings-related utilities for the Module Settings Panel System.
 */

// Discovery
export {
  findSettingsSchemas,
  loadSchemaFromPath,
  loadSettingsSchema,
  getModulesWithSettings,
  clearSchemaCache,
  getCachedSchema,
  hasSettingsSchema,
  getSettingsSchema,
} from './settingsDiscovery';

// Components
export { buildSettingComponent } from './settingComponents';
export type { SettingComponent, SettingComponentOptions } from './settingComponents';

// Panel Builders
export {
  buildSettingsPanel,
  buildEditModal,
  buildResetModal,
  buildUploadModal,
  buildErrorPanel,
  buildSelectEditModal,
  buildChannelEditModal,
  buildRoleEditModal,
  buildColorEditModal,
  findColorPreset,
  formatColorDisplay,
} from './settingsBuilder';
export type { SettingsPanelOptions } from './settingsBuilder';

// Validation
export {
  validateValue,
  validateAllSettings,
  evaluateConditions,
  getVisibleSettings,
  validateVisibleSettings,
  parseSettingValue,
  formatValidationErrors,
  validateSettingValue,
} from './settingsValidation';

// Storage
export {
  loadModuleSettings,
  saveModuleSetting,
  saveModuleSettings,
  resetModuleSetting,
  resetAllModuleSettings,
  getSettingDefault,
  getModuleSetting,
  exportModuleSettings,
  importModuleSettings,
} from './settingsStorage';

// Panel Factory
export {
  createSettingsPanel,
  createAllSettingsPanels,
  getStoredState,
  setStoredState,
} from './settingsPanelFactory';
export type { SettingsPanelState, RenderFunction, PanelScopeType } from './settingsPanelFactory';

// Handlers (for advanced use cases)
export {
  handleSettingsButton,
  handleSettingsDropdown,
  handleSettingsModal,
} from './settingsHandlers';
export type { HandlerContext } from './settingsHandlers';

// Types and constants are re-exported for convenience
export type {
  SettingsSchema,
  SectionDefinition,
  SettingDefinition,
  SettingType,
  SettingValue,
  SelectOption,
  ValidationRules,
  SettingConditions,
  ConditionRule,
  ConditionOperator,
  ConditionGroup,
  SingleValidationResult,
  ValidationResult,
  ValidationError,
  ConditionEvaluationResult,
  MergedSettings,
  ModuleWithSettings,
  ColorPreset,
} from '@bot/types/settingsTypes';

export { COLOR_PRESETS } from '@bot/types/settingsTypes';
