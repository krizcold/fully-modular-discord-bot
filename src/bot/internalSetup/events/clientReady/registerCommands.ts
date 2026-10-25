import {
  Client,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  RESTPostAPIContextMenuApplicationCommandsJSONBody,
  ApplicationCommand,
  ApplicationCommandType,
  PermissionsBitField } from 'discord.js';
import getLocalCommands from '../../utils/getLocalCommands';
import areCommandsDifferent from '../../utils/areCommandsDifferent';
import 'dotenv/config';
import { getConfigProperty } from '../../utils/configManager';
import { resolveNodeRole } from '../../fleet/nodeIdentity';
import { loadGlobalData, saveGlobalData } from '../../utils/dataManager';
import { dataPath } from '../../../../utils/dataRoot';
import * as fs from 'fs';
import { componentConfigPath, getLastAppliedDisabledCommands, readConfigFile, setLastAppliedDisabledCommands } from '../../utils/appStoreConfigFile';
import { resolveClientApplication } from '../../utils/clientApplication';
import { getLoadFailures } from '../../utils/loadFailures';

/** Check if auto-cleanup is enabled in AppStore config (default: false) */
export function isAutoCleanupEnabled(): boolean {
  return readAutoCleanup() === true;
}

/** The Auto Cleanup switch, or null when config.json cannot be read or parsed. */
function readAutoCleanup(): boolean | null {
  try {
    const configPath = dataPath('global', 'appstore', 'config.json');
    if (!fs.existsSync(configPath)) return false;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config.autoCleanup === true;
  } catch {
    return null;
  }
}

/** Module names in installed.json, read fresh (the web UI process writes it); null when it cannot be read or parsed. */
function readInstalledNames(): string[] | null {
  const file = dataPath('global', 'appstore', 'installed.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    console.error('[Cleanup] Cannot read installed.json:', error);
    return null;
  }
  try {
    const modules = JSON.parse(raw)?.modules;
    if (!modules || typeof modules !== 'object' || Array.isArray(modules)) {
      console.error('[Cleanup] installed.json has no module list');
      return null;
    }
    return Object.keys(modules);
  } catch (error) {
    console.error('[Cleanup] Cannot parse installed.json:', error);
    return null;
  }
}

/** Installed modules with neither a loaded module nor a manifest at this boot; null when that cannot be read. */
async function installedButAbsent(): Promise<string[] | null> {
  try {
    // Imported here: a static import of these closes a cycle through moduleReloader.
    const { getModuleRegistry } = await import('../../utils/moduleRegistry');
    const { findModuleManifests, getModuleInfo } = await import('../../utils/pathHelpers');
    const installed = readInstalledNames();
    if (installed === null) return null;
    const present = new Set(getModuleRegistry().getAllModules().map(m => m.manifest.name));
    for (const manifestPath of findModuleManifests()) present.add(getModuleInfo(manifestPath).moduleName);
    return installed.filter(n => !present.has(n));
  } catch (error) {
    console.error('[Cleanup] Cannot list installed or loaded modules:', error);
    return null;
  }
}

/** Disabled command names; on a read error, the last applied set, or null when none was applied yet. */
function getDisabledCommands(): Set<string> | null {
  const read = readConfigFile(componentConfigPath());
  if (!read.ok) {
    console.error(`[registerCommands] component-config.json cannot be read: ${read.error}`);
    return getLastAppliedDisabledCommands();
  }
  const disabled = new Set<string>();
  for (const [key, value] of Object.entries(read.config)) {
    if (value === false && key.includes(':command:')) {
      // key format: "moduleName:command:commandName"; extract commandName
      const parts = key.split(':');
      if (parts.length >= 3) {
        disabled.add(parts[parts.length - 1]);
      }
    }
  }
  setLastAppliedDisabledCommands(disabled);
  return disabled;
}

const testMode = getConfigProperty<boolean>('testMode');
const guildId = process.env.GUILD_ID;

// Tracking for last test guild (used to clean up stale commands when test guild changes)
const TRACKING_CATEGORY = 'internalSetup';
const TRACKING_FILE = 'lastTestGuild.json';

interface LastTestGuildData {
  guildId: string | null;
}

function getLastTestGuild(): string | null {
  const data = loadGlobalData<LastTestGuildData>(TRACKING_FILE, { guildId: null }, TRACKING_CATEGORY);
  return data.guildId;
}

function saveLastTestGuild(newGuildId: string): void {
  saveGlobalData<LastTestGuildData>(TRACKING_FILE, { guildId: newGuildId }, TRACKING_CATEGORY);
}

// Discord codes meaning the bot left the guild or the command is already gone.
const GUILD_GONE_CODES = new Set([10004, 50001]);
const COMMAND_GONE_CODE = 10063;

/**
 * Clean ALL guild commands from a specific guild through REST (the guild may be
 * on another node's shard or absent from the cache). done is false when any
 * fetch or delete failed, so the guild stays tracked and the next run retries.
 */
async function cleanStaleTestCommands(
  client: Client,
  targetGuildId: string
): Promise<{ deleted: number; done: boolean }> {
  const application = await resolveClientApplication(client);
  if (!application) {
    console.error(`[Cleanup] Stale commands in guild ${targetGuildId} not cleaned: the bot application could not be resolved`);
    return { deleted: 0, done: false };
  }

  let guildCommands;
  try {
    guildCommands = await application.commands.fetch({ guildId: targetGuildId });
  } catch (err: any) {
    if (GUILD_GONE_CODES.has(err?.code)) {
      console.log(`[Cleanup] Guild ${targetGuildId} not accessible (bot may have been removed)`);
      return { deleted: 0, done: true };
    }
    console.error(`[Cleanup] Failed to fetch commands from guild ${targetGuildId}; will retry on the next registration:`, err);
    return { deleted: 0, done: false };
  }

  if (guildCommands.size === 0) return { deleted: 0, done: true };
  console.log(`[Cleanup] Found ${guildCommands.size} stale command(s) in guild ${targetGuildId}`);

  let deleted = 0;
  let done = true;
  for (const guildCmd of guildCommands.values()) {
    try {
      await application.commands.delete(guildCmd.id, targetGuildId);
      console.log(`[Cleanup] Deleted "${guildCmd.name}" from guild ${targetGuildId}`);
      deleted++;
    } catch (err: any) {
      if (err?.code === COMMAND_GONE_CODE) continue;
      done = false;
      console.error(`[Cleanup] Failed to delete "${guildCmd.name}" from guild ${targetGuildId}; will retry on the next registration:`, err);
    }
  }
  return { deleted, done };
}

/**
 * Handle stale test command cleanup based on tracking state:
 * A) No tracked guild: Full scan all guilds (except current)
 * B) Different tracked guild: Clean only that guild
 * C) Same tracked guild: No cleanup needed
 */
async function handleStaleTestGuildCleanup(
  client: Client,
  currentGuildId: string
): Promise<boolean> {
  const lastGuildId = getLastTestGuild();

  // Case C: Same guild - no cleanup needed
  if (lastGuildId === currentGuildId) {
    return true;
  }

  // Case B: Different guild - clean only that one
  if (lastGuildId !== null) {
    console.log(`[i] Test guild changed from ${lastGuildId} to ${currentGuildId}, cleaning stale commands...`);
    const { deleted, done } = await cleanStaleTestCommands(client, lastGuildId);
    if (deleted > 0) {
      console.log(`[i] Cleaned ${deleted} stale command(s) from previous test guild`);
    }
    return done;
  }

  // Case A: No tracked guild - full scan of every guild the bot is in, read
  // through REST so a node holding no shard still sees them.
  console.log('[i] No previous test guild tracked, scanning all guilds for stale commands...');
  let guildIds: string[];
  try {
    guildIds = [];
    for (let after: string | undefined; ;) {
      const page = await client.guilds.fetch({ limit: 200, after });
      guildIds.push(...page.keys());
      if (page.size < 200) break;
      after = page.lastKey();
    }
  } catch (err) {
    console.error('[Cleanup] Could not list the bot\'s guilds; the stale command scan will retry on the next registration:', err);
    return false;
  }
  let totalDeleted = 0;
  let allDone = true;

  for (const scanGuildId of guildIds) {
    if (scanGuildId === currentGuildId) continue;

    const { deleted, done } = await cleanStaleTestCommands(client, scanGuildId);
    totalDeleted += deleted;
    if (!done) allDone = false;
  }

  if (!allDone) {
    console.warn(`[i] Full scan incomplete: cleaned ${totalDeleted} stale command(s); the rest retry on the next registration`);
  } else if (totalDeleted > 0) {
    console.log(`[i] Full scan complete: cleaned ${totalDeleted} stale command(s) across all guilds`);
  } else {
    console.log('[i] Full scan complete: no stale commands found');
  }
  return allDone;
}

const typeChat = ApplicationCommandType.ChatInput
const typeUser = ApplicationCommandType.User
const typeMessage = ApplicationCommandType.Message


// Filter out internal keys from the command object
/*
  These variables are passed from the Command scripts for internal
  purposes, or are handled in the command registration process.
  So we will filter them out before sending the command to Discord.
*/
const internalOrHandledKeys = [
  'callback',
  'requiredIntents',
  'permissionsRequired',
  'testOnly',
  'botPermissions',
  'devOnly',
  'messageTriggerSafe',
  'initialize',
];

/** What the orphan sweep did; registerCommands returns null when registration itself did not run to the end. */
export interface OrphanSweepResult {
  sweep: 'done' | 'off' | 'skipped' | 'stopped';
  deleted: number;
  note?: string;
}

export default async function registerCommands(
  client: Client,
  options: { runOrphanCleanup?: boolean } = {}
): Promise<OrphanSweepResult | null> {
  // Slash-command registration is a bot-identity-wide operation; only the
  // master node performs it (co-workers would race the same Discord state).
  if (resolveNodeRole() === 'co-worker') {
    console.log('[i] Skipping command registration (co-worker node; the master owns it)');
    return null;
  }
  const runOrphanCleanup = options.runOrphanCleanup !== false;
  console.log('[i] Registering commands...');

  if (!guildId) {
    console.error('GUILD_ID environment variable is not set.');
    console.warn('Commands will not be registered.');
    return null;
  }

  try {
    // Clean up stale guild commands from previous test guilds
    const staleCleanupDone = await handleStaleTestGuildCleanup(client, guildId);

    // Load all local commands (each file exports a command object or an array of commands)
    const localCommands = getLocalCommands();

    // Load disabled commands from component config
    const disabledCommands = getDisabledCommands();
    if (!disabledCommands) {
      console.error('[registerCommands] Commands were not registered: the disabled set cannot be read and none was applied before.');
      return null;
    }
    if (disabledCommands.size > 0) {
      console.log(`[i] ${disabledCommands.size} command(s) disabled via component config: ${[...disabledCommands].join(', ')}`);
    }

    // Fetch existing commands from Discord. On a node whose gateway never
    // became ready, the application is resolved through REST.
    const application = await resolveClientApplication(client);
    if (!application) {
      console.error('[registerCommands] Commands were not registered: the bot application could not be resolved.');
      return null;
    }
    const globalCommands = await application.commands.fetch();
    // Test (guild) commands go through the application-commands REST API scoped
    // to guildId, NOT a cached Guild object. In a fleet the test guild usually
    // lives on ANOTHER node's shard, so it is legitimately absent from this
    // client's cache; the old cache lookup aborted all registration on the
    // master. This REST manager works regardless of which shard holds the guild,
    // and never adds it to this client's cache (which would corrupt the fleet
    // guild map / this node's guild count).
    const appCommands = application.commands;
    const guildCmds = {
      fetch: () => appCommands.fetch({ guildId }),
      create: (data: any) => appCommands.create(data, guildId),
      edit: (id: string, data: any) => appCommands.edit(id, data, guildId),
      delete: (id: string) => appCommands.delete(id, guildId),
    };
    const guildCommands = await guildCmds.fetch(); // Test commands!

    // Process each local command
    for (const localCommand of localCommands) {
      // https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-structure

      const { name, testOnly, type = typeChat } = localCommand;

      if (skipCommand(localCommand)) {
        continue;
      }

      // Skip commands disabled via component config toggle
      if (disabledCommands.has(name)) {
        // If already registered on Discord, delete it
        const existing = (testOnly ? guildCommands : globalCommands)?.find(cmd => cmd.name === name && cmd.type === (type ?? typeChat));
        if (existing) {
          try {
            const mgr = testOnly ? guildCmds : client.application?.commands;
            await mgr?.delete(existing.id);
            console.log(`[i] Unregistered disabled command: ${name}`);
          } catch (e) { console.error(`[i] Failed to unregister disabled command ${name}:`, e); }
        }
        continue;
      }

      // Determine if the command should be registered as a test command or a global command
      // Based on command matching name AND type
      const existingCommand = (testOnly ? guildCommands : globalCommands)?.
      find(cmd => cmd.name === name && cmd.type === type);

      // --> Register either as a SLASH command, or a CONTEXT menu command
      const commandData: any = createBasePayload(localCommand)
      //commandData.description = testOnly ? `[TEST] ${description}` : description;

      await commandRegistration(commandData, localCommand, existingCommand, guildCmds, client);
    }


    // Remove orphan commands only if auto-cleanup is enabled (default: OFF)
    // AND the caller allows the full sweep (startup: yes; hot-reload: no).
    const switchAtStart = runOrphanCleanup ? readAutoCleanup() : false;
    let cleanupEnabled = switchAtStart === true;
    const result: OrphanSweepResult = { sweep: cleanupEnabled ? 'done' : 'off', deleted: 0 };
    if (runOrphanCleanup && switchAtStart !== true) {
      result.note = switchAtStart === null
        ? 'orphan sweep not run: the Auto Cleanup setting could not be read'
        : 'orphan sweep not run: Auto Cleanup was turned off';
    }
    const loadFailures = getLoadFailures();
    if (cleanupEnabled && loadFailures.length === 0) {
      const absent = await installedButAbsent();
      if (absent === null) loadFailures.push('the installed module list');
      else loadFailures.push(...absent);
    }
    if (cleanupEnabled && loadFailures.length > 0) {
      cleanupEnabled = false;
      result.sweep = 'skipped';
      result.note = `orphan sweep skipped: these failed to load at this boot: ${loadFailures.join(', ')}`;
      console.warn(`[Cleanup] Orphan command sweep skipped; their commands would be deleted. Failed to load: ${loadFailures.join(', ')}`);
    }
    const switchStillOn = (): boolean => {
      const on = readAutoCleanup();
      if (on === true) return true;
      const why = on === null ? 'the Auto Cleanup setting could not be read' : 'Auto Cleanup was turned off';
      result.sweep = 'stopped';
      result.note = `orphan sweep stopped after ${result.deleted} deletion(s): ${why}`;
      console.log(`[Cleanup] Orphan sweep stopped after ${result.deleted} deletion(s): ${why}`);
      return false;
    };

    // Remove global commands that are no longer present locally
    if (cleanupEnabled && globalCommands) {
      for (const appCommand of globalCommands.values()) {
        // Find local command matching name AND type
        const foundLocal = localCommands.some(localCmd =>
          localCmd.name === appCommand.name &&
          (localCmd.type ?? typeChat) === appCommand.type && // Compare type
          !localCmd.testOnly // Ensure it's marked as global locally
        );

        // Also consider testMode: If testMode is ON, we shouldn't find *any* corresponding local command unless it's testOnly
        const shouldExistGlobally = !testMode || localCommands.find(cmd => cmd.name === appCommand.name && (cmd.type ?? typeChat) === appCommand.type)?.testOnly;

        if (!foundLocal || !shouldExistGlobally) {
          // Avoid deleting if in test mode and it *should* be global (but wasn't registered)
          if (testMode && localCommands.some(cmd => cmd.name === appCommand.name && (cmd.type ?? typeChat) === appCommand.type && !cmd.testOnly)) {
            console.log(`[Test Mode] Skipping deletion of global command: ${appCommand.name} (Type: ${ApplicationCommandType[appCommand.type]})`);
            continue;
          }
          if (!switchStillOn()) break;
          try {
            await client.application?.commands.delete(appCommand.id);
            result.deleted++;
            console.log(`Deleted global command "${appCommand.name}" (Type: ${ApplicationCommandType[appCommand.type]}) as it is no longer found locally or test mode active.`);
          } catch(deleteError: any){
            if (deleteError?.code === 10063) {
              console.debug(`Global command "${appCommand.name}" already gone on Discord (10063)`);
            } else {
              console.error(`Error deleting global command "${appCommand.name}":`, deleteError);
            }
          }
        }
      }
    } else if (result.sweep === 'off' && globalCommands) {
      if (!runOrphanCleanup) {
        console.log('[i] Skipping orphan global command sweep (hot-reload context, targeted cleanup handled per module)');
      } else {
        console.log('[i] Auto-cleanup disabled, skipping orphan global command removal');
      }
    }

    // Remove local (guild) commands that are no longer present locally or shouldn't be local
    if (cleanupEnabled && result.sweep !== 'stopped') {
      for (const guildCommand of guildCommands.values()) {
        // Find local command matching name AND type
        const foundLocal = localCommands.some(localCmd =>
          localCmd.name === guildCommand.name &&
          (localCmd.type ?? typeChat) === guildCommand.type && // Compare type
          localCmd.testOnly // Ensure it's marked as testOnly locally
        );

        if (!foundLocal) {
          // Don't delete if in testMode and it *should* be a global command (we handle global deletion above)
          // This check might be redundant if the above global check works correctly, but safe to keep
          const correspondingLocal = localCommands.find(cmd => cmd.name === guildCommand.name && (cmd.type ?? typeChat) === guildCommand.type);
          if (testMode && correspondingLocal && !correspondingLocal.testOnly) {
            continue;
          }
          if (!switchStillOn()) break;
          try {
            await guildCmds.delete(guildCommand.id);
            result.deleted++;
            console.log(`Deleted local command "${guildCommand.name}" (Type: ${ApplicationCommandType[guildCommand.type]}) as it is no longer found locally or not marked testOnly.`);
          } catch(deleteError: any){
            if (deleteError?.code === 10063) {
              console.debug(`Local command "${guildCommand.name}" already gone on Discord (10063)`);
            } else {
              console.error(`Error deleting local command "${guildCommand.name}":`, deleteError);
            }
          }
        }
      }
    } else if (result.sweep === 'off') {
      if (!runOrphanCleanup) {
        console.log('[i] Skipping orphan guild command sweep (hot-reload context, targeted cleanup handled per module)');
      } else {
        console.log('[i] Auto-cleanup disabled, skipping orphan guild command removal');
      }
    }

    // Save current test guild for future cleanup tracking; an unfinished
    // stale cleanup keeps the old guild tracked so the next run retries it.
    if (staleCleanupDone) saveLastTestGuild(guildId);
    return result;
  } catch (error) {
    console.error(`There was an error while registering commands:\n${error}`);
    return null;
  }
}

/**
 * Creates a base payload object from localCommand, copying only properties
 * that are not internal or explicitly handled elsewhere.
 * @param localCommand The command object from the local file.
 * @returns A base payload object with potentially valid API properties.
 */
function createBasePayload(localCommand: any): any {
  const payload: any = {};
  for (const key in localCommand) {
    if (!internalOrHandledKeys.includes(key) && localCommand.hasOwnProperty(key)) {
      payload[key] = localCommand[key]; // Copy other properties
    }
  }
  return payload;
}

/**
 * Checks if the command should be skipped based on its properties.
 * @param localCommand The command object from the local file.
 * @returns True if the command should be skipped, false otherwise.
 */
function skipCommand(localCommand: any) {

  const { name, testOnly, type = typeChat } = localCommand || {};

  if (testMode && !testOnly) {
    // In test mode, skip global commands
    return true;
  }

  if (!name) {
    console.warn('Command name not found in [', localCommand, ']');
    return true;
  }

  // Description check using the constant
  if (type === typeChat && !localCommand.description) {
    console.warn(`Command description not found for ChatInput command "${name}". Skipping.`);
    return true;
  }
  // Name validation for User/Message context menu commands
  // Context menus allow mixed case and spaces, just 1-32 characters
  if ((type === typeUser || type === typeMessage) && (name.length < 1 || name.length > 32)) {
    console.warn(`Name "${name}" is invalid for User/Message command. It must be 1-32 characters. Skipping.`);
    return true;
  }

  return false;
}

/**
 * Registers or updates a command based on its existence and properties.
 * @param commandData The command data to be registered or updated.
 * @param localCommand The local command object.
 * @param existingCommand The existing command object from Discord, if any.
 * @param guildCmds The guild-scoped command manager (REST) for test commands.
 * @param client The Discord client instance.
 */
async function commandRegistration(
  commandData: any,
  localCommand: any,
  existingCommand: ApplicationCommand | undefined,
  guildCmds: any,
  client: Client,
) {

  const {testOnly = false, permissionsRequired, options, type = typeChat } = localCommand;

  let finalCommand: any = JSON.parse(JSON.stringify(commandData)); // Deep copy to avoid mutation
  //finalCommand.default_member_permissions = permissionsRequired ? String(permissionsRequired) : null;


  // Handle description: Overwrite if ChatInput and testOnly, Delete if not ChatInput
  if (type === typeChat) {
    // Tag test commands with [TEST] in the description
    finalCommand.description = testOnly ? `[TEST] ${localCommand.description}` : localCommand.description;
    finalCommand.options = options || [];
  } else {
    // Ensure description and options are removed for Context Menu types
    delete finalCommand.description;
    delete finalCommand.options;
  }


  // Calculate and set default_member_permissions (overwrites if present in basePayload)
  if (permissionsRequired?.length) {
    try {
      const resolvedPermissions = PermissionsBitField.resolve(permissionsRequired);
      finalCommand.default_member_permissions = String(resolvedPermissions);
    } catch (error) {
      console.error(`Error resolving permissions for command "${finalCommand.name}":`, error);
      finalCommand.default_member_permissions = null;
    }
  } else {
    // Ensure it's null if not specified, overwriting any potential copied value
    finalCommand.default_member_permissions = null;
  }


  // ---> Assert correct type before sending <---
  let finalCommandDataTyped: RESTPostAPIChatInputApplicationCommandsJSONBody | RESTPostAPIContextMenuApplicationCommandsJSONBody;

  if (type === typeChat) {
      finalCommandDataTyped = finalCommand as RESTPostAPIChatInputApplicationCommandsJSONBody;
  } else if (type === typeUser || type === typeMessage) {
      finalCommandDataTyped = finalCommand as RESTPostAPIContextMenuApplicationCommandsJSONBody;
  } else {
      console.error(`Invalid type encountered in commandRegistration for "${finalCommand.name}".`);
      return;
  }

  
  // ---> Perform Registration/Edit <---
  const targetManager = localCommand.testOnly ? guildCmds : client.application?.commands;
  if (!targetManager) return; // what lmao how

  try {
      if (existingCommand) {
        // Compare existingCommand with the final typed payload
        if (areCommandsDifferent(existingCommand, finalCommandDataTyped)) {
          await targetManager.edit(existingCommand.id, finalCommandDataTyped);
          console.log(`Edited ${localCommand.testOnly ? 'local' : 'global'} command: ${finalCommand.name} (Type: ${ApplicationCommandType[type]})`);
        }
      } else {
        await targetManager.create(finalCommandDataTyped);
        console.log(`Registered ${localCommand.testOnly ? 'local' : 'global'} command: ${finalCommand.name} (Type: ${ApplicationCommandType[type]})`);
      }
  } catch (error) {
      console.error(`Error creating/editing command "${finalCommand.name}" (Type: ${ApplicationCommandType[type]}):`, error);
      console.error('Payload causing error:', JSON.stringify(finalCommandDataTyped, null, 2));
  }
}
