/**
 * Shared command utilities
 *
 * Used by moduleReloader, ipcToggleHandler, and ipcReloadHandler
 * to avoid duplicating command payload building and re-registration logic.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'discord.js';

/**
 * Keys that are internal to our command system and should NOT
 * be sent to the Discord API when registering commands.
 */
export const COMMAND_INTERNAL_KEYS = [
  'callback',
  'requiredIntents',
  'permissionsRequired',
  'testOnly',
  'botPermissions',
  'devOnly',
  'messageTriggerSafe',
  'initialize',
];

/**
 * Build a Discord API payload from a local command definition,
 * stripping internal-only keys.
 */
export function buildCommandPayload(commandDef: any): any {
  const payload: any = {};
  for (const key in commandDef) {
    if (!COMMAND_INTERNAL_KEYS.includes(key) && commandDef.hasOwnProperty(key)) {
      payload[key] = commandDef[key];
    }
  }
  return payload;
}

/**
 * Re-register all slash commands with Discord.
 * Calls the existing registerCommands event handler (which handles
 * registration, updates, disabled commands, and optional orphan cleanup).
 *
 * Pass `{ runOrphanCleanup: false }` when calling from hot-reload paths —
 * the in-memory ModuleRegistry is transient during install/uninstall, so the
 * full orphan sweep can wrongly delete valid commands. Startup (clientReady)
 * callers should omit the option so the sweep runs normally.
 */
export async function reRegisterSlashCommands(
  client: Client,
  options: { runOrphanCleanup?: boolean } = {}
): Promise<void> {
  try {
    const isProd = process.env.NODE_ENV !== 'development';
    const registerPath = isProd
      ? path.join(process.cwd(), 'dist', 'bot', 'internalSetup', 'events', 'clientReady', 'registerCommands.js')
      : path.join(process.cwd(), 'src', 'bot', 'internalSetup', 'events', 'clientReady', 'registerCommands.ts');

    if (!fs.existsSync(registerPath)) {
      console.warn('[CommandUtils] registerCommands not found, skipping slash command sync');
      return;
    }

    const resolved = require.resolve(registerPath);
    delete require.cache[resolved];

    const registerModule = require(registerPath);
    const registerFn = registerModule.default || registerModule;

    if (typeof registerFn === 'function') {
      await registerFn(client, options);
      console.log('[CommandUtils] Slash commands re-registered with Discord');
    }
  } catch (error) {
    console.error('[CommandUtils] Failed to re-register slash commands:', error);
  }
}
