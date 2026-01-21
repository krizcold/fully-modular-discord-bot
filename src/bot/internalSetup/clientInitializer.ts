import { Client, GatewayIntentBits, Collection, Interaction, ButtonInteraction, StringSelectMenuInteraction, MessageFlags } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import getAllFiles from './utils/getAllFiles';
import 'dotenv/config';
import { RegisteredButtonInfo, RegisteredDropdownInfo, RegisteredModalInfo, RegisteredReactionInfo, RegisteredReactionRemoveInfo } from '../types/commandTypes';
import { getPanelManager } from './utils/panelManager';
import { setupPanelIPCHandlers } from './utils/ipcPanelHandler';
import { loadCredentials } from '../../utils/envLoader';
import { ModuleLoader } from './utils/moduleLoader';
import { getModuleRegistry } from './utils/moduleRegistry';
import { LoadedModule } from '../types/moduleTypes';
import { ensureConfigPopulated } from './utils/configManager';

// Load credentials from /data/.env (Web-UI managed) or environment variables
const credentials = loadCredentials();
// Update process.env with loaded credentials so rest of bot can access them
if (credentials.DISCORD_TOKEN) process.env.DISCORD_TOKEN = credentials.DISCORD_TOKEN;
if (credentials.CLIENT_ID) process.env.CLIENT_ID = credentials.CLIENT_ID;
if (credentials.GUILD_ID) process.env.GUILD_ID = credentials.GUILD_ID;
if (credentials.MAIN_GUILD_ID) process.env.MAIN_GUILD_ID = credentials.MAIN_GUILD_ID;

const isProd = process.env.NODE_ENV !== 'development';
const projectRoot = isProd
  ? path.join(__dirname, '..', '..')      // Production: dist/bot/internalSetup -> dist
  : path.join(__dirname, '..', '..', '..'); // Development: src/bot/internalSetup -> project root

const scanRoot = isProd ? '' : 'src';
const validIntentValues = new Set(Object.values(GatewayIntentBits).filter(v => typeof v === 'number'));

// --- collectRequiredIntents and mergeIntents functions ---
function collectRequiredIntents(...relativeDirs: string[]): number[] {
  const intents = new Set<number>();
  function findIntentsRecursive(directory: string) {
    const filesInDir = getAllFiles(directory, false);
    for (const file of filesInDir) {
      if (file.split(path.sep).includes('disabled')) continue;
      try {
        delete require.cache[require.resolve(file)];
        const mod = require(file);
        let intentsArray: number[] | undefined;
        if (mod?.requiredIntents && Array.isArray(mod.requiredIntents)) {
          intentsArray = mod.requiredIntents;
        } else if (typeof mod === 'object' && mod !== null && mod.default?.requiredIntents && Array.isArray(mod.default.requiredIntents)) {
          intentsArray = mod.default.requiredIntents;
        }
        if (intentsArray) {
          intentsArray
            .filter((intent): intent is number => typeof intent === 'number' && validIntentValues.has(intent))
            .forEach(intent => intents.add(intent));
        }
      } catch (error) { console.error(`Error loading file for intents ${file}:`, error); }
    }
    const subDirs = getAllFiles(directory, true);
    for (const subDir of subDirs) {
      if (path.basename(subDir) === 'disabled' || subDir.split(path.sep).includes('disabled')) continue;
      findIntentsRecursive(subDir);
    }
  }
  for (const relativeDir of relativeDirs) {
    const absoluteDir = path.join(projectRoot, relativeDir);
    try {
      if (!fs.existsSync(absoluteDir)) { console.warn(`[collectRequiredIntents] Directory not found: ${absoluteDir}. Skipping.`); continue; }
      findIntentsRecursive(absoluteDir);
    } catch (error) { console.warn(`Warning: Could not fully scan directory for intents ${absoluteDir}. Error: ${(error as Error).message}`); }
  }
  return Array.from(intents);
}
function mergeIntents(...intentArrays: number[][]): number[] {
  const merged = new Set<number>();
  intentArrays.forEach(arr => arr.forEach(i => merged.add(i)));
  return Array.from(merged);
}


// --- Store modules needing initialization ---
const modulesToInitialize: any[] = [];

// --- Store loaded modules from module system ---
let loadedModules: LoadedModule[] = [];

/**
 * Load all modules using ModuleLoader and extract intents
 */
async function loadModules(client: Client): Promise<number[]> {
  console.log('[ModuleLoader] Loading modules...');

  try {
    const moduleLoader = new ModuleLoader(client);
    loadedModules = await moduleLoader.loadAllModules();

    // Extract intents from all loaded modules
    const moduleIntents = new Set<number>();

    for (const module of loadedModules) {
      if (module.manifest.requiredIntents) {
        for (const intentName of module.manifest.requiredIntents) {
          // Convert string intent names to numbers
          const intentValue = GatewayIntentBits[intentName as keyof typeof GatewayIntentBits];
          if (typeof intentValue === 'number') {
            moduleIntents.add(intentValue);
          }
        }
      }
    }

    console.log(`[ModuleLoader] Loaded ${loadedModules.length} modules`);
    console.log(`[ModuleLoader] Module intents:`, Array.from(moduleIntents).map(i => {
      const name = Object.entries(GatewayIntentBits).find(([_, v]) => v === i)?.[0];
      return name || i;
    }));

    return Array.from(moduleIntents);
  } catch (error) {
    console.error('[ModuleLoader] Error loading modules:', error);
    return [];
  }
}

/**
 * Register module commands and events
 */
function registerModuleComponents(client: Client) {
  console.log('[ModuleLoader] Registering module components...');

  for (const module of loadedModules) {
    // Collect command initializers from modules
    for (const command of module.commands) {
      if (typeof command.initialize === 'function') {
        if (!modulesToInitialize.some(mod => mod === command)) {
          modulesToInitialize.push(command);
        }
      }
    }

    // Register module event handlers
    for (const [eventName, handlers] of module.events) {
      for (const handler of handlers) {
        if (typeof handler === 'function') {
          client.on(eventName, async (...args) => {
            try {
              await handler(client, ...args);
            } catch (error) {
              console.error(`[ModuleLoader] Error in ${module.manifest.name} ${eventName} handler:`, error);
            }
          });
        }
      }
    }

    console.log(`[ModuleLoader] Registered ${module.manifest.displayName}: ${module.commands.length} commands, ${module.events.size} event types`);
  }
}

/**
 * Collect initializers from internal commands (internalSetup/commands/)
 */
function collectInternalCommandInitializers() {
  const internalCommandsDir = path.join(projectRoot, scanRoot, 'bot', 'internalSetup', 'commands');

  if (!fs.existsSync(internalCommandsDir)) {
    console.log('[Initializer] No internal commands directory found');
    return;
  }

  const fileExtension = isProd ? '.js' : '.ts';
  const files = fs.readdirSync(internalCommandsDir)
    .filter(file => file.endsWith(fileExtension) && !file.endsWith('.disabled' + fileExtension));

  let initializerCount = 0;

  for (const file of files) {
    try {
      const filePath = path.join(internalCommandsDir, file);
      // Clear cache in development for hot-reloading
      if (!isProd) {
        delete require.cache[require.resolve(filePath)];
      }
      const command = require(filePath);
      const commandDef = command.default || command;

      if (commandDef && typeof commandDef.initialize === 'function') {
        if (!modulesToInitialize.some(mod => mod === commandDef)) {
          modulesToInitialize.push(commandDef);
          initializerCount++;
        }
      }
    } catch (error) {
      console.error(`[Initializer] Error loading internal command ${file}:`, error);
    }
  }

  if (initializerCount > 0) {
    console.log(`[Initializer] Collected ${initializerCount} internal command initializers`);
  }
}

/**
 * Loads event handlers and collects modules needing initialization from event files.
 */
async function loadEventHandlers(client: Client) {
  const internalEventsDir = path.join(projectRoot, scanRoot, 'bot', 'internalSetup', 'events');

  console.log("Loading event handlers...");

  const internalEventFolders = fs.existsSync(internalEventsDir) ? getAllFiles(internalEventsDir, true) : [];

  const allEventFolderPaths = [...internalEventFolders];
  const uniqueEventNames = [...new Set(allEventFolderPaths.map(folder => path.basename(folder)))];
  const eventMap: Record<string, { internal: string[], user: string[] }> = {};

  uniqueEventNames.forEach(eventName => { eventMap[eventName] = { internal: [], user: [] }; });

  // Populate internal event map
  for (const folder of internalEventFolders) {
    const eventName = path.basename(folder);
    if (folder.includes('data') || folder.includes('disabled')) continue;
    const eventFiles = getAllFiles(folder, false);
    eventMap[eventName].internal.push(...eventFiles);
    eventMap[eventName].internal.sort((a, b) => a.localeCompare(b));
  }

  // Special handling for 'clientReady' event to ensure registerCommands runs first
  const commandInitFile = path.join(internalEventsDir, 'clientReady', isProd ? 'registerCommands.js' : 'registerCommands.ts');
  if (eventMap['clientReady']) {
    eventMap['clientReady'].internal = eventMap['clientReady'].internal.filter(file => file !== commandInitFile);
    if (fs.existsSync(commandInitFile)) {
        eventMap['clientReady'].internal.unshift(commandInitFile);
    } else {
        console.warn(`[Event Loader] registerCommands file not found at: ${commandInitFile}`);
    }
  } else {
    if (fs.existsSync(commandInitFile)) {
        eventMap['clientReady'] = { internal: [commandInitFile], user: [] };
    } else {
        console.warn(`[Event Loader] registerCommands file not found and no other 'clientReady' events found.`);
        if (!eventMap['clientReady']) eventMap['clientReady'] = { internal: [], user: [] };
    }
  }


  // Special handling for 'interactionCreate' to order internal handlers
  const interactionCreateDir = path.join(internalEventsDir, 'interactionCreate');
  const handleCommandsPath = path.join(interactionCreateDir, isProd ? 'handleCommands.js' : 'handleCommands.ts');
  const buttonHandlerPath = path.join(interactionCreateDir, isProd ? 'buttonHandler.js' : 'buttonHandler.ts');
  const dropdownHandlerPath = path.join(interactionCreateDir, isProd ? 'dropdownHandler.js' : 'dropdownHandler.ts');
  const modalSubmitHandlerPath = path.join(interactionCreateDir, isProd ? 'modalSubmitHandler.js' : 'modalSubmitHandler.ts');
  const orderedInternalInteractionHandlers = [
    handleCommandsPath,
    buttonHandlerPath,
    dropdownHandlerPath,
    modalSubmitHandlerPath
  ].filter(p => fs.existsSync(p));

  if (eventMap['interactionCreate']) {
    eventMap['interactionCreate'].internal = orderedInternalInteractionHandlers;
  } else {
    console.warn("[Event Loader] No 'interactionCreate' event folder/handlers found initially. Setting up internal handlers.");
    eventMap['interactionCreate'] = { internal: orderedInternalInteractionHandlers, user: [] };
  }


  // Register listeners and collect initializers from event files
  for (const [eventName, files] of Object.entries(eventMap)) {
    const orderedFiles = [...files.internal, ...files.user];
    if (orderedFiles.length === 0) continue;

    console.log(`Registering ${eventName} event with handlers:`, orderedFiles.map(f => path.relative(projectRoot, f)));

    client.on(eventName, async (...args) => {
      const interactionOrEvent = args[0];
      for (const eventFile of orderedFiles) {
        try {
          // Only clear cache in development mode for hot-reloading
          // In production, this prevents race conditions and improves performance
          if (process.env.NODE_ENV === 'development') {
            delete require.cache[require.resolve(eventFile)];
          }
          const eventModule = require(eventFile);
          const handler = eventModule.default || eventModule;

          // Collect Initializer from Event Module
          if (handler && typeof handler.initialize === 'function') {
            if (!modulesToInitialize.some(mod => mod === handler)) {
              modulesToInitialize.push(handler);
            }
          } else if (eventModule.default && typeof eventModule.default.initialize === 'function') {
             if (!modulesToInitialize.some(mod => mod === eventModule.default)) {
                modulesToInitialize.push(eventModule.default);
             }
          }

          // Execute handler - only files with default function export are handlers
          // Files without default export are utilities (silently ignored)
          if (eventModule.default && typeof eventModule.default === 'function') {
            // Has default function export - it's an event handler
            await eventModule.default(client, ...args);

          } else if (eventModule.default) {
            // Has default export but NOT a function - likely a mistake
            console.error(
              `[Event Loader] ${path.basename(eventFile)} exports default but it's not a function (type: ${typeof eventModule.default}). ` +
              `Event handlers must export: "export default async (client, ...args) => { }". ` +
              `For utility files, use named exports: "export const util = ..."`
            );

          } else if (typeof eventModule === 'function') {
            // Direct function export (CommonJS: module.exports = fn)
            await eventModule(client, ...args);

          } else {
            // No default export - this is a utility file with named exports or no exports
            // Skip silently (utilities should use: export { helper } or export const)
          }
        } catch (error) {
          console.error(`Error executing or processing event handler ${eventFile} for event ${eventName}:`, error);
          if (interactionOrEvent && typeof (interactionOrEvent as Interaction).isRepliable === 'function' && (interactionOrEvent as Interaction).isRepliable()) {
            try {
              if ((interactionOrEvent as Interaction & { replied: boolean; deferred: boolean }).replied || (interactionOrEvent as Interaction & { replied: boolean; deferred: boolean }).deferred) {
                await (interactionOrEvent as Interaction & { followUp: Function }).followUp({ content: 'An error occurred while processing your request.', flags: MessageFlags.Ephemeral }).catch(() => { });
              } else {
                await (interactionOrEvent as Interaction & { reply: Function }).reply({ content: 'An error occurred while processing your request.', flags: MessageFlags.Ephemeral }).catch(() => { });
              }
            } catch (replyError) {
              // Ignore
            }
          }
        }
      }
    });
  }
}


/**
 * Runs all collected initialize functions.
 */
function runInitializers(client: Client) {
  console.log(`[Initializer] Running initialization for ${modulesToInitialize.length} modules...`);
  if (modulesToInitialize.length === 0) { return; }
  for (const module of modulesToInitialize) {
    let moduleName = module?.name || module?.default?.name || 'Unnamed Module';
    try {
      module.initialize(client);
    } catch (error) {
      console.error(`[Initializer] Error running initialize function for module: ${moduleName}`, error);
    }
  }
  console.log(`[Initializer] Initialization complete.`);
}


/**
 * Main function that initializes the client.
 */
async function main() {
  // PHASE 0: Ensure config.json is fully populated with schema
  console.log('[Bot] Synchronizing config.json with schema...');
  ensureConfigPopulated();

  // Create a temporary client for module loading (intents will be determined after)
  const tempClient = new Client({ intents: [GatewayIntentBits.Guilds] });

  // PHASE 1: Load modules and extract intents
  const moduleIntents = await loadModules(tempClient);

  // PHASE 2: Collect intents from internal framework events
  const internalEventsDirRelative = path.join(scanRoot, 'bot', 'internalSetup', 'events');
  const internalEventIntents = collectRequiredIntents(internalEventsDirRelative);

  // PHASE 3: Merge all intents (modules + internal events)
  const requiredIntents = mergeIntents(moduleIntents, internalEventIntents);
  const defaultIntents = [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions ];
  const intents = requiredIntents.length > 0 ? requiredIntents : defaultIntents;
  const finalIntents = intents.map(intent => typeof intent === 'string' ? GatewayIntentBits[intent as keyof typeof GatewayIntentBits] : intent).filter(i => typeof i === 'number');
  const intentsList = finalIntents.map((i) => { const n = Object.entries(GatewayIntentBits).find(([_,v])=>v===i)?.[0]; return n||i; });
  console.log('Logging in with intents:', intentsList);

  // PHASE 4: Create the real client with all required intents
  const client = new Client({ intents: finalIntents });

  client.buttonHandlers = new Map<string, RegisteredButtonInfo>();
  client.dropdownHandlers = new Map<string, RegisteredDropdownInfo>();
  client.modalHandlers = new Map<string, RegisteredModalInfo>();
  client.reactionHandlers = new Map<string, RegisteredReactionInfo>();
  client.reactionRemoveHandlers = new Map<string, RegisteredReactionRemoveInfo[]>();

  // PHASE 5: Register module components
  registerModuleComponents(client);

  // PHASE 5.5: Collect internal command initializers
  collectInternalCommandInitializers();

  // PHASE 6: Load framework event handlers
  await loadEventHandlers(client);

  // Initialize panel manager and load panels
  console.log('[Bot] Initializing panel manager...');
  try {
    const panelManager = getPanelManager(client);
    await panelManager.loadPanels();

    // Register panels from loaded modules
    console.log('[Bot] Registering module panels...');
    let modulePanelCount = 0;
    for (const module of loadedModules) {
      for (const panel of module.panels) {
        panelManager.registerPanel(panel);
        modulePanelCount++;
        console.log(`[Bot] Registered panel '${panel.id}' from module '${module.manifest.displayName}'`);
      }
    }
    console.log(`[Bot] Registered ${modulePanelCount} module panels`);

    console.log('[Bot] Panel manager initialized successfully');
  } catch (error) {
    console.error('[Bot] Error during panel manager initialization:', error);
  }

  client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user?.tag}!`);

    // Run all module initializers (after client is ready)
    runInitializers(client);

    // Log module statistics
    const registry = getModuleRegistry();
    const stats = registry.getStats();
    console.log('[ModuleRegistry] Modules loaded:', stats.total);
    console.log('[ModuleRegistry] By category:', stats.byCategory);

    // Recover persistent panels now that client is ready
    try {
      const panelMgr = getPanelManager();
      await panelMgr.recoverPanels();
      console.log('[Bot] Persistent panels recovered');
    } catch (error) {
      console.error('[Bot] Error recovering persistent panels:', error);
    }
  });

  // Set up IPC message handlers for Web-UI panel integration
  setupPanelIPCHandlers();

  client.login(process.env.DISCORD_TOKEN);
}

main().catch(console.error);
