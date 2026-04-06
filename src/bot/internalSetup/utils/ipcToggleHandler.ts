/**
 * IPC Toggle Handler
 *
 * Handles component:toggle IPC messages from the web server process.
 * Immediately registers/unregisters commands, events, and panels at runtime.
 *
 * Also exports applyComponentToggleState() for use after hot-reload
 * to re-disable components that should stay off.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'discord.js';
import { getModuleRegistry } from './moduleRegistry';
import { getModuleEventManager } from './moduleEventManager';
import { getPanelManager } from './panelManager';
import getLocalCommands from './getLocalCommands';
import { LoadedModule } from '../../types/moduleTypes';

let clientRef: Client | null = null;

// Keys to strip from command definitions before sending to Discord API
const INTERNAL_KEYS = [
  'callback', 'requiredIntents', 'permissionsRequired',
  'testOnly', 'botPermissions', 'devOnly', 'messageTriggerSafe', 'initialize'
];

/**
 * Read component-config.json and return disabled entries.
 */
function loadDisabledComponents(): Record<string, false> {
  try {
    const configPath = path.join(process.env.DATA_DIR || '/data', 'global', 'appstore', 'component-config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const disabled: Record<string, false> = {};
      for (const [key, value] of Object.entries(config)) {
        if (value === false) disabled[key] = false;
      }
      return disabled;
    }
  } catch { /* ignore */ }
  return {};
}

/**
 * Build a Discord API payload from a local command definition.
 */
function buildCommandPayload(commandDef: any): any {
  const payload: any = {};
  for (const key in commandDef) {
    if (!INTERNAL_KEYS.includes(key) && commandDef.hasOwnProperty(key)) {
      payload[key] = commandDef[key];
    }
  }
  return payload;
}

/**
 * Find a command definition by name from loaded modules + internal commands.
 */
function findCommandDef(commandName: string): any | null {
  const allCommands = getLocalCommands();
  return allCommands.find((c: any) => c.name === commandName) || null;
}

// ─── Toggle Handlers ───

async function toggleCommand(
  client: Client,
  commandName: string,
  enabled: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    const guildId = process.env.GUILD_ID;
    const guild = guildId ? client.guilds.cache.get(guildId) : null;
    const commandDef = findCommandDef(commandName);

    if (enabled) {
      // RE-REGISTER with Discord
      if (!commandDef) {
        return { success: false, error: `Command definition not found for "${commandName}"` };
      }

      const payload = buildCommandPayload(commandDef);
      const targetManager = commandDef.testOnly && guild ? guild.commands : client.application?.commands;
      if (!targetManager) return { success: false, error: 'Command manager not available' };

      await targetManager.create(payload);
      console.log(`[Toggle] Registered command: ${commandName}`);
      return { success: true };
    } else {
      // UNREGISTER from Discord
      const commandType = commandDef?.type ?? 1; // ChatInput default
      const isTestOnly = commandDef?.testOnly === true;

      // Fetch current commands to find the ID
      const commands = isTestOnly && guild
        ? await guild.commands.fetch()
        : await client.application?.commands.fetch();

      const existing = commands?.find(
        (cmd: any) => cmd.name === commandName && cmd.type === commandType
      );

      if (existing) {
        const mgr = isTestOnly && guild ? guild.commands : client.application?.commands;
        await mgr?.delete(existing.id);
        console.log(`[Toggle] Unregistered command: ${commandName}`);
      }
      return { success: true };
    }
  } catch (error: any) {
    return { success: false, error: error.message || String(error) };
  }
}

async function toggleEvent(
  moduleName: string,
  eventName: string,
  enabled: boolean
): Promise<{ success: boolean; error?: string }> {
  const eventManager = getModuleEventManager();
  const registry = getModuleRegistry();

  if (enabled) {
    // Re-attach from stored module event handlers
    const module = registry.getModule(moduleName);
    if (!module) return { success: false, error: `Module ${moduleName} not loaded` };

    const handlers = module.events.get(eventName);
    if (!handlers || handlers.length === 0) {
      return { success: false, error: `No handlers for event ${eventName} in ${moduleName}` };
    }

    for (const handler of handlers) {
      if (typeof handler === 'function') {
        eventManager.registerListener(moduleName, eventName, handler);
      }
    }
    console.log(`[Toggle] Re-attached ${handlers.length} listener(s) for ${moduleName}:${eventName}`);
    return { success: true };
  } else {
    const removed = eventManager.removeEventListeners(moduleName, eventName);
    console.log(`[Toggle] Detached ${removed} listener(s) for ${moduleName}:${eventName}`);
    return { success: true };
  }
}

// Cache of disabled panel definitions (so they can be re-registered on enable)
const disabledPanelCache: Map<string, any> = new Map();

async function togglePanel(
  moduleName: string,
  panelId: string,
  enabled: boolean
): Promise<{ success: boolean; error?: string }> {
  if (enabled) {
    // Try the disabled cache first (works for both internal and module panels)
    const cached = disabledPanelCache.get(panelId);
    if (cached) {
      try {
        getPanelManager().registerPanel(cached);
        disabledPanelCache.delete(panelId);
      } catch { /* ignore */ }
      console.log(`[Toggle] Re-registered panel: ${panelId} (from cache)`);
      return { success: true };
    }

    // Fallback: try the module registry
    const registry = getModuleRegistry();
    const module = registry.getModule(moduleName);
    if (module) {
      const panelDef = module.panels.find((p: any) => p.id === panelId);
      if (panelDef) {
        try { getPanelManager().registerPanel(panelDef); } catch { /* ignore */ }
        console.log(`[Toggle] Re-registered panel: ${panelId}`);
        return { success: true };
      }
    }

    return { success: false, error: `Panel ${panelId} definition not found` };
  } else {
    // Cache the panel definition before removing it
    try {
      const panelManager = getPanelManager();
      const panelDef = panelManager.getPanel(panelId);
      if (panelDef) {
        disabledPanelCache.set(panelId, panelDef);
      }
      panelManager.unregisterPanel(panelId);
    } catch { /* panelManager may not exist */ }
    console.log(`[Toggle] Unregistered panel: ${panelId}`);
    return { success: true };
  }
}

// ─── IPC Setup ───

export function setupToggleIPCHandlers(client: Client): void {
  if (!process.send) {
    console.warn('[IPCToggleHandler] process.send not available');
    return;
  }

  clientRef = client;
  console.log('[IPCToggleHandler] Setting up IPC handlers for component toggle');

  process.on('message', async (message: any) => {
    if (!message || typeof message !== 'object') return;
    if (!clientRef) return;

    const { type, requestId, data } = message;
    if (type !== 'component:toggle' || !requestId) return;

    try {
      const { module: moduleName, componentType, name, enabled } = data;
      let response: any;

      switch (componentType) {
        case 'command':
          response = await toggleCommand(clientRef, name, enabled);
          break;
        case 'event':
          response = await toggleEvent(moduleName, name, enabled);
          break;
        case 'panel':
          response = await togglePanel(moduleName, name, enabled);
          break;
        default:
          response = { success: false, error: `Unknown component type: ${componentType}` };
      }

      process.send!({ requestId, data: response });
    } catch (error: any) {
      process.send!({
        requestId,
        data: { success: false, error: error.message || String(error) }
      });
    }
  });
}

// ─── Hot-Reload Compatibility ───

/**
 * After a module is hot-reloaded, re-apply disabled state for its components.
 * Commands are handled by registerCommands (already reads config).
 * This handles events and panels.
 */
export async function applyComponentToggleState(
  client: Client,
  module: LoadedModule
): Promise<void> {
  const disabled = loadDisabledComponents();
  const moduleName = module.manifest.name;

  for (const key of Object.keys(disabled)) {
    const parts = key.split(':');
    if (parts.length < 3) continue;

    const keyModule = parts[0];
    const keyType = parts[1];
    const keyName = parts.slice(2).join(':');

    if (keyModule !== moduleName) continue;

    switch (keyType) {
      case 'event':
        getModuleEventManager().removeEventListeners(moduleName, keyName);
        console.log(`[Toggle] Re-applied disabled state for event ${moduleName}:${keyName}`);
        break;
      case 'panel':
        try {
          const pm = getPanelManager();
          const panelDef = pm.getPanel(keyName);
          if (panelDef) disabledPanelCache.set(keyName, panelDef);
          pm.unregisterPanel(keyName);
          console.log(`[Toggle] Re-applied disabled state for panel ${keyName}`);
        } catch { /* ignore */ }
        break;
      // Commands handled by registerCommands — no action needed here
    }
  }
}

/**
 * On boot, apply disabled states for ALL components (internal + module).
 * Called after panels and module events are registered, before clientReady.
 * Commands are handled separately by registerCommands on clientReady.
 */
export function applyAllDisabledStatesOnBoot(): void {
  const disabled = loadDisabledComponents();
  let count = 0;

  for (const key of Object.keys(disabled)) {
    const parts = key.split(':');
    if (parts.length < 3) continue;

    const moduleName = parts[0];
    const keyType = parts[1];
    const keyName = parts.slice(2).join(':');

    switch (keyType) {
      case 'event':
        // Only works for module events (tracked by moduleEventManager)
        if (moduleName !== '_internal') {
          const removed = getModuleEventManager().removeEventListeners(moduleName, keyName);
          if (removed > 0) count++;
        }
        break;
      case 'panel':
        // Works for all panels (internal + module)
        try {
          const pm = getPanelManager();
          const panelDef = pm.getPanel(keyName);
          if (panelDef) {
            disabledPanelCache.set(keyName, panelDef);
            pm.unregisterPanel(keyName);
            count++;
          }
        } catch { /* ignore */ }
        break;
    }
  }

  if (count > 0) {
    console.log(`[Toggle] Applied ${count} disabled component state(s) on boot`);
  }
}
