/**
 * IPC Reload Handler
 *
 * Handles module reload IPC messages from the Web-UI process.
 * Runs in the bot process where the Discord client lives.
 * Uses the same { type, requestId, data } → { requestId, data } pattern as ipcPanelHandler.
 */

import * as path from 'path';
import { Client } from 'discord.js';
import { reloadModule, reloadModules, unloadModuleFromMemory } from './moduleReloader';
import { getModuleRegistry } from './moduleRegistry';

let clientRef: Client | null = null;

/**
 * Set up IPC message handlers for module hot-reload.
 * Must be called after the Discord client is created.
 */
export function setupReloadIPCHandlers(client: Client): void {
  if (!process.send) {
    console.warn('[IPCReloadHandler] process.send not available — IPC handlers not registered');
    return;
  }

  clientRef = client;
  console.log('[IPCReloadHandler] Setting up IPC handlers for module hot-reload');

  process.on('message', async (message: any) => {
    if (!message || typeof message !== 'object') return;
    if (!clientRef) return;

    const { type, requestId, data } = message;
    if (!type || !requestId) return;

    // Only handle module/commands-related messages
    if (!type.startsWith('module:') && type !== 'commands:reregister') return;

    try {
      let response: any;

      switch (type) {
        case 'module:reload': {
          const result = await reloadModule(clientRef, data.moduleName);
          response = result;
          break;
        }

        case 'module:reload-all': {
          const result = await reloadModules(clientRef, data.moduleNames);
          response = result;
          break;
        }

        case 'module:load': {
          // Load a newly installed module into memory (fresh install, not reload)
          const loadResult = await reloadModule(clientRef, data.moduleName);
          response = loadResult;
          break;
        }

        case 'module:unload': {
          // Unload a module from memory (uninstall)
          const unloadResult = await unloadModuleFromMemory(clientRef, data.moduleName);
          response = unloadResult;
          break;
        }

        case 'module:list-loaded': {
          const registry = getModuleRegistry();
          const modules = registry.getAllModules().map(m => ({
            name: m.manifest.name,
            displayName: m.manifest.displayName,
            version: m.manifest.version,
            commands: m.commands.length,
            events: m.events.size,
            panels: m.panels.length
          }));
          response = { success: true, modules };
          break;
        }

        case 'commands:reregister': {
          // Re-run registerCommands (includes orphan cleanup if autoCleanup is enabled)
          try {
            const isProd = process.env.NODE_ENV !== 'development';
            const registerPath = isProd
              ? path.join(process.cwd(), 'dist', 'bot', 'internalSetup', 'events', 'clientReady', 'registerCommands.js')
              : path.join(process.cwd(), 'src', 'bot', 'internalSetup', 'events', 'clientReady', 'registerCommands.ts');
            const resolved = require.resolve(registerPath);
            delete require.cache[resolved];
            const registerFn = require(resolved).default || require(resolved);
            if (typeof registerFn === 'function') {
              await registerFn(clientRef);
            }
            response = { success: true };
          } catch (err: any) {
            response = { success: false, error: err.message || String(err) };
          }
          break;
        }

        default:
          return; // Unknown type, let other handlers deal with it
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
