/**
 * IPC Toggle Handler
 *
 * Handles component:toggle IPC messages from the web server process.
 * Immediately registers/unregisters commands, events, and panels at runtime.
 *
 * Also exports applyComponentToggleState() for use after hot-reload
 * to re-disable components that should stay off.
 */

import { Client } from 'discord.js';
import { getModuleRegistry } from './moduleRegistry';
import { getModuleEventManager } from './moduleEventManager';
import { getPanelManager } from './panelManager';
import getLocalCommands from './getLocalCommands';
import { buildCommandPayload } from './commandUtils';
import { resolveClientApplication } from './clientApplication';
import { LoadedModule } from '../../types/moduleTypes';
import { componentConfigPath, getLastAppliedDisabledCommands, readConfigFile, setLastAppliedDisabledCommands } from './appStoreConfigFile';

let clientRef: Client | null = null;

let lastAppliedDisabled: Record<string, false> | null = null;

/**
 * Read component-config.json and return disabled entries; on a read error, the last applied entries.
 */
function loadDisabledComponents(): Record<string, false> {
  const read = readConfigFile(componentConfigPath());
  if (!read.ok) {
    if (lastAppliedDisabled) {
      console.error(`[Toggle] component-config.json cannot be read, keeping the last applied disabled set: ${read.error}`);
      return lastAppliedDisabled;
    }
    console.error(`[Toggle] component-config.json cannot be read and no disabled set was applied yet: disabled events and panels stay on until it is fixed: ${read.error}`);
    return {};
  }
  const disabled: Record<string, false> = {};
  for (const [key, value] of Object.entries(read.config)) {
    if (value === false) disabled[key] = false;
  }
  lastAppliedDisabled = disabled;
  return disabled;
}

function recordAppliedToggle(moduleName: string, componentType: string, name: string, enabled: boolean): void {
  if (componentType === 'command') {
    const current = getLastAppliedDisabledCommands();
    if (!current) return;
    const next = new Set(current);
    if (enabled) next.delete(name); else next.add(name);
    setLastAppliedDisabledCommands(next);
    return;
  }
  if (!lastAppliedDisabled) return;
  const key = `${moduleName}:${componentType}:${name}`;
  const next = { ...lastAppliedDisabled };
  if (enabled) delete next[key]; else next[key] = false;
  lastAppliedDisabled = next;
}

/**
 * Find a command definition by name from loaded modules + internal commands.
 */
function findCommandDef(commandName: string): any | null {
  const allCommands = getLocalCommands();
  return allCommands.find((c: any) => c.name === commandName) || null;
}

// ─── Toggle Handlers ───

export async function toggleCommand(
  client: Client,
  commandName: string,
  enabled: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    const guildId = process.env.GUILD_ID;
    const commandDef = findCommandDef(commandName);
    // Test commands go through the application-commands REST API scoped to
    // guildId, NOT a cached Guild object: the test guild may be absent from the
    // cache, and a cache lookup here would silently fall back to
    // the GLOBAL registry (see registerCommands.ts).
    const appCommands = (await resolveClientApplication(client))?.commands;
    if (!appCommands) return { success: false, error: 'Command manager not available' };

    if (enabled) {
      // RE-REGISTER with Discord
      if (!commandDef) {
        return { success: false, error: `Command definition not found for "${commandName}"` };
      }

      const payload = buildCommandPayload(commandDef);
      if (commandDef.testOnly && guildId) {
        await appCommands.create(payload, guildId);
      } else {
        await appCommands.create(payload);
      }
      console.log(`[Toggle] Registered command: ${commandName}`);
      return { success: true };
    } else {
      // UNREGISTER from Discord
      const commandType = commandDef?.type ?? 1; // ChatInput default
      const isTestOnly = commandDef?.testOnly === true;

      // Fetch current commands to find the ID
      const commands = isTestOnly && guildId
        ? await appCommands.fetch({ guildId })
        : await appCommands.fetch();

      const existing = commands?.find(
        (cmd: any) => cmd.name === commandName && cmd.type === commandType
      );

      if (existing) {
        if (isTestOnly && guildId) {
          await appCommands.delete(existing.id, guildId);
        } else {
          await appCommands.delete(existing.id);
        }
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

    if (eventManager.hasEventListeners(moduleName, eventName)) {
      console.log(`[Toggle] ${moduleName}:${eventName} is already attached`);
      return { success: true };
    }

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

  const toggleChains = new Map<string, Promise<void>>();

  process.on('message', (message: any) => {
    if (!message || typeof message !== 'object') return;
    if (!clientRef) return;

    const { type, requestId, data } = message;
    if (type !== 'component:toggle' || !requestId) return;

    const key = `${data?.module}:${data?.componentType}:${data?.name}`;
    const run = (toggleChains.get(key) ?? Promise.resolve()).then(() => applyToggle(requestId, data));
    toggleChains.set(key, run);
    run.finally(() => { if (toggleChains.get(key) === run) toggleChains.delete(key); });
  });
}

async function applyToggle(requestId: string, data: any): Promise<void> {
    if (!clientRef) return;
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

      if (response?.success) recordAppliedToggle(moduleName, componentType, name, enabled);
      process.send!({ requestId, data: response });
    } catch (error: any) {
      process.send!({
        requestId,
        data: { success: false, error: error.message || String(error) }
      });
    }
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
      // Commands handled by registerCommands; no action needed here
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
