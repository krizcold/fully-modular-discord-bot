/**
 * Settings Panel Factory
 *
 * Creates PanelOptions objects for modules that have settingsSchema.json files.
 * Each module gets its own dedicated panel(s) in the Settings category.
 * Supports both guild-scoped and system-scoped (global) settings panels.
 */

import {
  PermissionFlagsBits,
  GatewayIntentBits,
} from 'discord.js';
import type { PanelOptions, PanelContext, PanelResponse } from '@bot/types/panelTypes';
import type { ModuleWithSettings, SettingsSchema, MergedSettings } from '@bot/types/settingsTypes';
import { createV2Response } from '../panel/v2';
import { buildSettingsPanel, buildErrorPanel } from './settingsBuilder';
import { loadModuleSettings, loadHardLimits } from './settingsStorage';
import {
  handleSettingsButton,
  handleSettingsDropdown,
  handleSettingsModal,
  type HandlerContext,
  type SettingsPanelState,
  type RenderFunction,
} from './settingsHandlers';

// Re-export types for external use
export type { SettingsPanelState, RenderFunction } from './settingsHandlers';

// Panel scope type - determines guild context behavior
export type PanelScopeType = 'guild' | 'system';

// ============================================================================
// State Storage - persists settings panel state across interactions
// ============================================================================

const STATE_TTL = 30 * 60 * 1000; // 30 minutes

interface StateEntry {
  state: SettingsPanelState;
  timestamp: number;
}

const settingsStateStore = new Map<string, StateEntry>();

// Periodic cleanup of stale state entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of settingsStateStore.entries()) {
    if (now - entry.timestamp > STATE_TTL) {
      settingsStateStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

function getStateKey(guildId: string | null | undefined, userId: string, panelId: string): string {
  return `${guildId || 'global'}:${userId}:${panelId}`;
}

export function getStoredState(
  guildId: string | null | undefined,
  userId: string,
  panelId: string,
  defaultSection: string
): SettingsPanelState {
  const key = getStateKey(guildId, userId, panelId);
  const entry = settingsStateStore.get(key);
  if (entry) {
    entry.timestamp = Date.now();
    return entry.state;
  }
  return {
    currentSection: defaultSection,
    currentPage: 0,
    pendingChanges: {},
  };
}

export function setStoredState(
  guildId: string | null | undefined,
  userId: string,
  panelId: string,
  state: SettingsPanelState
): void {
  const key = getStateKey(guildId, userId, panelId);
  settingsStateStore.set(key, { state, timestamp: Date.now() });
}

// ============================================================================
// Panel Creation
// ============================================================================

interface CreatePanelOptions {
  moduleInfo: ModuleWithSettings;
  panelScope: PanelScopeType;
}

/**
 * Create a settings panel for a module with specified scope
 */
export function createSettingsPanel(options: CreatePanelOptions): PanelOptions {
  const { moduleInfo, panelScope } = options;
  const { name: moduleName, displayName, category, schema } = moduleInfo;

  const isSystemScope = panelScope === 'system';
  const panelId = isSystemScope ? `settings_global_${moduleName}` : `settings_${moduleName}`;
  const defaultSection = schema.sections[0]?.id || 'general';

  // For system scope, always use null guildId
  const getEffectiveGuildId = (context: PanelContext): string | null => {
    return isSystemScope ? null : (context.guildId || null);
  };

  // Create render function for this panel
  const createRenderFn = (context: PanelContext): RenderFunction => {
    return (state: SettingsPanelState): PanelResponse => {
      const effectiveGuildId = getEffectiveGuildId(context);
      return renderSettingsPanel(effectiveGuildId, moduleName, category, schema, state, panelId, isSystemScope);
    };
  };

  // Create handler context factory
  const createHandlerCtx = (context: PanelContext): HandlerContext => {
    const effectiveGuildId = getEffectiveGuildId(context);
    const getState = () => getStoredState(effectiveGuildId, context.userId, panelId, defaultSection);
    const setState = (state: SettingsPanelState) => setStoredState(effectiveGuildId, context.userId, panelId, state);

    // Create modified context with effective guildId for handlers
    const modifiedContext: PanelContext = {
      ...context,
      guildId: effectiveGuildId,
    };

    return {
      context: modifiedContext,
      moduleName,
      category,
      schema,
      defaultSection,
      panelId,
      getState,
      setState,
      render: createRenderFn(context),
    };
  };

  const panel: PanelOptions = {
    id: panelId,
    name: isSystemScope ? `${displayName} Settings (Global)` : `${displayName} Settings`,
    description: isSystemScope
      ? `Configure global default settings for ${displayName}`
      : (schema.description || `Configure ${displayName} settings`),
    category: 'Settings',

    showInAdminPanel: true,
    adminPanelOrder: isSystemScope ? 45 : 50, // Global panels appear before guild panels
    adminPanelIcon: schema.icon || '\u2699\uFE0F',

    requiredPermissions: [PermissionFlagsBits.Administrator],
    requiredIntents: [GatewayIntentBits.Guilds],

    // Set panel scope for proper context handling
    panelScope: panelScope,

    callback: async (context: PanelContext): Promise<PanelResponse> => {
      const effectiveGuildId = getEffectiveGuildId(context);
      const state = getStoredState(effectiveGuildId, context.userId, panelId, defaultSection);
      return renderSettingsPanel(effectiveGuildId, moduleName, category, schema, state, panelId, isSystemScope);
    },

    handleButton: async (context: PanelContext, buttonId: string): Promise<PanelResponse | null> => {
      return handleSettingsButton(createHandlerCtx(context), buttonId);
    },

    handleDropdown: async (context: PanelContext, values: string[], dropdownId?: string): Promise<PanelResponse> => {
      return handleSettingsDropdown(createHandlerCtx(context), values, dropdownId);
    },

    handleModal: async (context: PanelContext, modalId: string): Promise<PanelResponse> => {
      return handleSettingsModal(createHandlerCtx(context), modalId);
    },
  };

  return panel;
}

/**
 * Render the settings panel
 */
function renderSettingsPanel(
  guildId: string | null,
  moduleName: string,
  category: string,
  schema: SettingsSchema,
  state: SettingsPanelState,
  panelId: string,
  isGlobal: boolean
): PanelResponse {
  const settings = loadModuleSettings(moduleName, guildId, category);

  if (!settings) {
    return createV2Response(buildErrorPanel('Failed to load settings. Schema may be invalid.'));
  }

  // Load hard limits for this module (always from global settings)
  const hardLimits = loadHardLimits(moduleName);

  // Apply pending changes to display
  const displaySettings: MergedSettings = {
    values: { ...settings.values, ...state.pendingChanges },
    sources: { ...settings.sources },
    schema: settings.schema,
  };

  // Mark pending changes with appropriate source
  const pendingSource = isGlobal ? 'global' : 'guild';
  for (const key of Object.keys(state.pendingChanges)) {
    displaySettings.sources[key] = pendingSource;
  }

  const isDirty = Object.keys(state.pendingChanges).length > 0;

  const containers = buildSettingsPanel({
    schema,
    settings: displaySettings,
    currentSection: state.currentSection,
    currentPage: state.currentPage,
    moduleName,
    category,
    panelId,
    isDirty,
    isSystemPanel: isGlobal,
    hardLimits,
  });

  return createV2Response(containers);
}

/**
 * Create all settings panels for modules with schemas
 * Creates both guild and system panels based on module scope
 */
export function createAllSettingsPanels(modulesWithSettings: ModuleWithSettings[]): PanelOptions[] {
  const panels: PanelOptions[] = [];

  for (const moduleInfo of modulesWithSettings) {
    const { schema } = moduleInfo;

    // Create panels based on schema scope
    switch (schema.scope) {
      case 'global':
        // Only system panel
        panels.push(createSettingsPanel({ moduleInfo, panelScope: 'system' }));
        break;

      case 'guild':
        // Only guild panel
        panels.push(createSettingsPanel({ moduleInfo, panelScope: 'guild' }));
        break;

      case 'both':
      default:
        // Both panels - system first, then guild
        panels.push(createSettingsPanel({ moduleInfo, panelScope: 'system' }));
        panels.push(createSettingsPanel({ moduleInfo, panelScope: 'guild' }));
        break;
    }
  }

  return panels;
}
