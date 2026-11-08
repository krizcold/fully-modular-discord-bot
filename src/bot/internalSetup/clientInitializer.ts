import { Client, GatewayIntentBits, IntentsBitField, Partials, Collection, Interaction, ButtonInteraction, StringSelectMenuInteraction, MessageFlags } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import getAllFiles from './utils/getAllFiles';
import 'dotenv/config';
import { RegisteredButtonInfo, RegisteredDropdownInfo, RegisteredModalInfo, RegisteredReactionInfo, RegisteredReactionRemoveInfo } from '../types/commandTypes';
import { getPanelManager } from './utils/panelManager';
import { setupPanelIPCHandlers } from './utils/ipcPanelHandler';
import { setupCommandIPCHandlers } from './utils/ipcCommandHandler';
import { setupDataIPCHandlers } from './utils/ipcDataHandler';
import { setupAccessLogChannel } from './utils/accessLogChannel';
import { markMetricsReady, setupMetricsIPCHandlers } from './utils/ipcMetricsHandler';
import { setupFleetIPCHandlers } from './utils/ipcFleetHandler';
import { getMetricsCollector } from './utils/metrics/metricsCollector';
import { startSamplers, stopSamplers } from './utils/metrics/samplers';
import { addReleaseStep, addStopStep, getGuildDataBackend,sweepGraveyard, DataBackendUnavailableError } from './utils/dataManager';
import { setupSharedOpsIPC } from './utils/sharedOps';
import { reportWriterStage } from './utils/writerLock';
import { initDataBackendLayer, awaitDataStartupBarrier, dispatchGated, dataUnavailableMessage } from './utils/dataBackends/boot';
import { getWorkingSet } from './utils/dataBackends/workingSet';
import { setupReloadIPCHandlers } from './utils/ipcReloadHandler';
import { setupToggleIPCHandlers, applyAllDisabledStatesOnBoot } from './utils/ipcToggleHandler';
import { setupIPCNotificationHandler } from './utils/ipcNotificationHandler';
import { getSubscriptionNotifier } from './utils/subscriptionNotifier';
import { getPaymentRegistry } from './utils/payment/paymentRegistry';
import { startPremiumTickers } from './utils/premiumManager';
import { startModuleAutoUpdater } from './utils/moduleAutoUpdater';
import { loadCredentials } from '../../utils/envLoader';
import { bootShards, getLeaseRuntime, getShardClaims } from './fleet/shardBoot';
import { guildRequestsStopStep, requestGuildRequestPass, startGuildRequestSweep } from './fleet/guildRequests';
import { bootShared, startSharedPass, stopSharedPass } from './utils/sharedMirror';
import {
  applyOfStart, applyTails, bootStartOf, closeWindow, endStart, INITIALIZER_LATE_MS, INITIALIZER_WAIT_MS, markLate, onModuleCode, openStarts, openWindow,
  startEndFailed, type ModuleStart,
} from './utils/moduleCrashes';
import { stoppedServing } from './utils/servingGate';
import { beginBootApplies, bootCompileModules, bootLoadCheck, recoverModuleApplies, setModuleApplyClient } from './utils/moduleApply';
import { getIngestService } from './ingest/ingestService';
import { installReplyGate } from './utils/dataBackends/replyGate';
import { ModuleLoader } from './utils/moduleLoader';
import { getModuleRegistry } from './utils/moduleRegistry';
import { getModuleEventManager } from './utils/moduleEventManager';
import { LoadedModule } from '../types/moduleTypes';
import { ensureConfigPopulated } from './utils/configManager';
import { decideBoot, installMaintenanceGate, markDiscordStarted, runMaintenanceBoot, setupMaintenanceIPCAtBoot, watchDataBackend } from './utils/maintenance';
import { isMaintenanceGateClosed } from './utils/maintenanceGate';
import { PostgresBackend } from './utils/dataBackends/postgresBackend';
import { noteShardReconnect, stopMainWatch } from './utils/dataBackends/mainDatabase';
import { claimsStop, endStandbyMaintenanceAnswers, l20Line, type RunBotOptions } from './fleet/standbyBoot';
import { setLoginIntents } from './fleet/state';

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
export async function loadModules(client: Client): Promise<number[]> {
  console.log('[ModuleLoader] Loading modules...');

  // Module auto-update is now handled by the periodic scheduler (moduleAutoUpdater)
  // started after the client is ready. No one-shot sync on boot.

  try {
    const moduleLoader = new ModuleLoader(client, { onModuleCode });
    const loaded = await moduleLoader.loadAllModules();
    // NB6 45 (6): on Postgres each module this boot applied is checked before its intents are read.
    loadedModules = getGuildDataBackend() instanceof PostgresBackend ? await bootLoadCheck(client, loaded) : loaded;

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
 * Register module commands and events.
 * Event handlers are tracked via ModuleEventManager for clean removal on hot-reload.
 */
export function registerModuleComponents(client: Client) {
  console.log('[ModuleLoader] Registering module components...');

  const eventManager = getModuleEventManager();
  eventManager.setClient(client);

  for (const module of loadedModules) {
    registerSingleModuleComponents(client, module);
  }
}

/**
 * Register a single module's commands and events.
 * Extracted so it can be called during hot-reload for individual modules.
 */
function registerSingleModuleComponents(client: Client, module: LoadedModule) {
  const eventManager = getModuleEventManager();

  // Collect command initializers
  for (const command of module.commands) {
    if (typeof command.initialize === 'function') {
      if (!modulesToInitialize.some(mod => mod === command)) {
        modulesToInitialize.push(command);
      }
    }
  }

  // Register module event handlers via EventManager (tracked for removal)
  for (const [eventName, handlers] of module.events) {
    for (const handler of handlers) {
      if (typeof handler === 'function') {
        eventManager.registerListener(module.manifest.name, eventName, handler);
      }
    }
  }

  console.log(`[ModuleLoader] Registered ${module.manifest.displayName}: ${module.commands.length} commands, ${module.events.size} event types, ${eventManager.getListenerCount(module.manifest.name)} listeners`);
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
  const autocompleteHandlerPath = path.join(interactionCreateDir, isProd ? 'autocompleteHandler.js' : 'autocompleteHandler.ts');
  const buttonHandlerPath = path.join(interactionCreateDir, isProd ? 'buttonHandler.js' : 'buttonHandler.ts');
  const dropdownHandlerPath = path.join(interactionCreateDir, isProd ? 'dropdownHandler.js' : 'dropdownHandler.ts');
  const modalSubmitHandlerPath = path.join(interactionCreateDir, isProd ? 'modalSubmitHandler.js' : 'modalSubmitHandler.ts');
  const orderedInternalInteractionHandlers = [
    handleCommandsPath,
    autocompleteHandlerPath,
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

    const dispatchOrdered = async (...args: any[]) => {
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
            const content = error instanceof DataBackendUnavailableError
              ? dataUnavailableMessage(error.causeKey)
              : 'An error occurred while processing your request.';
            try {
              if ((interactionOrEvent as Interaction & { replied: boolean; deferred: boolean }).replied || (interactionOrEvent as Interaction & { replied: boolean; deferred: boolean }).deferred) {
                await (interactionOrEvent as Interaction & { followUp: Function }).followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => { });
              } else {
                await (interactionOrEvent as Interaction & { reply: Function }).reply({ content, flags: MessageFlags.Ephemeral }).catch(() => { });
              }
            } catch (replyError) {
              // Ignore
            }
          }
        }
      }
    };

    // The dispatch gate (boot.ts dispatchGated): clientReady waits for the
    // startup barrier; an interaction is held and, refused, told why in one
    // ephemeral reply (an autocomplete gets an empty list); an event for a
    // guild still loading here replays in order; one for a guild this node
    // neither leases nor still holds a set for, or on a refused data layer,
    // is dropped; one whose set is still held here (frozen or fenced) runs,
    // its writes refused; an event that carries only a Guild passes; an
    // interaction is swept once its dispatch ends.
    client.on(eventName, (...args) => dispatchGated(eventName, args, dispatchOrdered));
  }
}


type HandlerMaps = { b: Set<unknown>; m: Set<unknown>; d: Set<unknown>; r: Set<unknown>; rr: Set<unknown> };

function handlerSnapshot(client: Client): HandlerMaps {
  const c = client as any;
  return {
    b: new Set(Array.from(c.buttonHandlers?.keys() ?? [])),
    m: new Set(Array.from(c.modalHandlers?.keys() ?? [])),
    d: new Set(Array.from(c.dropdownHandlers?.keys() ?? [])),
    r: new Set(Array.from(c.reactionHandlers?.keys() ?? [])),
    rr: new Set(Array.from(c.reactionRemoveHandlers?.keys() ?? [])),
  };
}

/** Files the handlers registered since `before` under the module (the handler-id bookkeeping). */
function fileNewHandlers(client: Client, mod: LoadedModule, before: HandlerMaps): void {
  const c = client as any;
  const bNew = (Array.from(c.buttonHandlers?.keys() ?? []) as string[]).filter(k => !before.b.has(k));
  const mNew = (Array.from(c.modalHandlers?.keys() ?? []) as string[]).filter(k => !before.m.has(k));
  const dNew = (Array.from(c.dropdownHandlers?.keys() ?? []) as string[]).filter(k => !before.d.has(k));
  const rNew = (Array.from(c.reactionHandlers?.keys() ?? []) as string[]).filter(k => !before.r.has(k));
  const rrNew = (Array.from(c.reactionRemoveHandlers?.keys() ?? []) as string[]).filter(k => !before.rr.has(k));
  for (const id of bNew) { const info = c.buttonHandlers.get(id); if (info) info._moduleName = mod.manifest.name; }
  for (const id of mNew) { const info = c.modalHandlers.get(id); if (info) info._moduleName = mod.manifest.name; }
  for (const id of dNew) { const info = c.dropdownHandlers.get(id); if (info) info._moduleName = mod.manifest.name; }
  for (const id of rNew) { const info = c.reactionHandlers.get(id); if (info) info._moduleName = mod.manifest.name; }
  for (const id of rrNew) { const infos = c.reactionRemoveHandlers.get(id); if (infos) for (const info of infos) info._moduleName = mod.manifest.name; }
  const existing = mod.registeredInteractionIds ?? { buttons: [], modals: [], dropdowns: [] };
  mod.registeredInteractionIds = {
    buttons: [...existing.buttons, ...bNew],
    modals: [...existing.modals, ...mNew],
    dropdowns: [...existing.dropdowns, ...dNew]
  };
  const existingReactions = (mod as any).registeredReactionIds ?? { reactions: [], reactionRemoves: [] };
  (mod as any).registeredReactionIds = {
    reactions: [...existingReactions.reactions, ...rNew],
    reactionRemoves: [...existingReactions.reactionRemoves, ...rrNew]
  };
}

const initializerLine = (name: string) => `[Initializer] Error running initialize function for module: ${name}`;
const commandName = (command: any): string => command?.name || 'Unnamed Module';

/**
 * A module's boot turn (decisions 67, 78, 82, 89, 99 and 105) in its start's window: the snapshot, each initializer
 * called with its promise kept, the bookkeeping, then the promises awaited up to 60 s. All settled: the start ends
 * there. Past 60 s: T27, the next turn begins, and a task nothing awaits ends the start when they settle or at 10
 * minutes from the turn's begin (T29).
 */
async function bootTurn(client: Client, mod: LoadedModule, cmds: any[], start: ModuleStart): Promise<void> {
  const name = mod.manifest.name;
  if (cmds.length === 0) {
    await endStart(start, 'ok');
    return;
  }
  const kept: Array<{ command: string; promise: Promise<unknown> }> = [];
  openWindow(start);
  try {
    const before = handlerSnapshot(client);
    for (const command of cmds) {
      if (start.turnAt === null) start.turnAt = Date.now();
      try {
        const returned: unknown = command.initialize(client);
        if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') kept.push({ command: commandName(command), promise: Promise.resolve(returned) });
      } catch (error) {
        console.error(initializerLine(commandName(command)), error);
      }
    }
    fileNewHandlers(client, mod, before);
  } catch (error) {
    closeWindow(start);
    if (!applyOfStart(start)) console.error(initializerLine(name), error);
    await endStart(start, { rejected: error });
    return;
  }
  const settled = Promise.allSettled(kept.map(k => k.promise));
  const rejectionOf = (results: PromiseSettledResult<unknown>[]) => {
    const at = results.findIndex(r => r.status === 'rejected');
    return at < 0 ? null : { command: kept[at].command, reason: (results[at] as PromiseRejectedResult).reason };
  };
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<'bound'>(resolve => {
    timer = setTimeout(() => resolve('bound'), INITIALIZER_WAIT_MS);
  });
  const outcome = await Promise.race([settled, bound]);
  clearTimeout(timer);
  if (outcome !== 'bound') {
    closeWindow(start);
    const rejected = rejectionOf(outcome);
    if (rejected && !applyOfStart(start)) console.error(initializerLine(rejected.command), rejected.reason);
    await endStart(start, rejected ? { rejected: rejected.reason } : 'ok');
    return;
  }
  const tails = applyTails(start);
  console.warn(`[Initializer] ${name}'s initializers did not finish within 60 s; the bot goes on with the other modules and waits up to 10 minutes for them${tails.t27}`);
  closeWindow(start);
  markLate(start);
  const lateAt = (start.turnAt ?? Date.now()) + INITIALIZER_LATE_MS;
  void (async () => {
    try {
      let lateTimer: NodeJS.Timeout | undefined;
      const lateBound = new Promise<'bound'>(resolve => {
        lateTimer = setTimeout(() => resolve('bound'), Math.max(0, lateAt - Date.now()));
        lateTimer.unref?.();
      });
      const late = await Promise.race([settled, lateBound]);
      clearTimeout(lateTimer);
      if (late === 'bound') {
        console.warn(`[Initializer] ${name}'s initializers did not finish within 10 minutes; the bot counts ${name} as started${tails.t29}`);
        void settled.then(results => {
          const rejected = rejectionOf(results);
          if (rejected) console.error(initializerLine(rejected.command), rejected.reason);
        });
        await endStart(start, 'bound');
        return;
      }
      const rejected = rejectionOf(late);
      if (rejected && !applyOfStart(start)) console.error(initializerLine(rejected.command), rejected.reason);
      await endStart(start, rejected ? { rejected: rejected.reason } : 'ok');
    } catch (error) {
      startEndFailed(start, error);
    }
  })();
}

/**
 * Runs the collected initializers: the unattributed ones first, as before; then every module the registry holds gets
 * its turn, one module at a time, in its boot start's window when the boot loop handed it one (decisions 67, 78, 99
 * and 105). A module whose boot start is gone runs its initializers as before, with no window or bound.
 */
export async function runInitializers(client: Client): Promise<void> {
  console.log(`[Initializer] Running initialization for ${modulesToInitialize.length} modules...`);

  const registry = getModuleRegistry();
  const loadedModules = registry.getAllModules();
  const commandToModule = new Map<any, LoadedModule>();
  for (const mod of loadedModules) {
    for (const cmd of mod.commands) commandToModule.set(cmd, mod);
  }

  const byModule = new Map<string, any[]>();
  const unattributed: any[] = [];
  for (const cmd of modulesToInitialize) {
    const mod = commandToModule.get(cmd);
    if (mod) {
      const arr = byModule.get(mod.manifest.name) ?? [];
      arr.push(cmd);
      byModule.set(mod.manifest.name, arr);
    } else {
      unattributed.push(cmd);
    }
  }

  for (const command of unattributed) {
    const moduleName = command?.name || command?.default?.name || 'Unnamed Module';
    try {
      command.initialize(client);
    } catch (error) {
      console.error(initializerLine(moduleName), error);
    }
  }

  for (const mod of loadedModules) {
    const cmds = byModule.get(mod.manifest.name) ?? [];
    const handed = bootStartOf(mod.manifest.name);
    if (handed && openStarts.get(mod.manifest.name) === handed) {
      await bootTurn(client, mod, cmds, handed);
      continue;
    }
    if (cmds.length === 0) continue;
    const before = handlerSnapshot(client);
    for (const command of cmds) {
      try {
        command.initialize(client);
      } catch (error) {
        console.error(initializerLine(commandName(command)), error);
      }
    }
    fileNewHandlers(client, mod, before);
  }

  console.log(`[Initializer] Initialization complete.`);
}


/** Tests: the modules this process loaded and the initializers it collected. */
export function _resetBootModules(): void {
  loadedModules = [];
  modulesToInitialize.length = 0;
}

/** The normal boot. */
export async function main(): Promise<void> {
  return runBot({});
}

/**
 * The bot process's boot. A promoted standby (NB9 28) passes what it took and the Client it logged in; every other step
 * runs as in a normal boot.
 */
export async function runBot(opts: RunBotOptions): Promise<void> {
  const { taken, client: adopted, releaseInjected } = opts;
  // The saved maintenance state (and a refused database login) is read before the data backend opens.
  const boot = await decideBoot();
  if (boot.mode === 'maintenance') {
    if (releaseInjected) await releaseInjected();
    // NB9 D3: in the turn the maintenance boot's listener starts.
    endStandbyMaintenanceAnswers();
    await runMaintenanceBoot(boot);
    return;
  }

  // NB4 decisions 12 and 19: this boot's steps of the one stop (dataManager.ts, which drains between them), added
  // before anything that can start a leave; each runs once what it acts on exists. The claims lane renews through the
  // gateway close and the drain, then releases.
  let stopSteps: { client: Client | null; metricsReady: boolean } = { client: null, metricsReady: false };
  addStopStep(async () => {
    getShardClaims()?.beginStop();
    if (stopSteps.metricsReady) stopSamplers();
    // No event is handled while the writes drain: a gateway left up keeps
    // taking writes the drain may never reach. Bounded, since a destroy
    // stalls on a shard caught mid-connect.
    await Promise.race([
      getIngestService().close('shutting down').catch(err => console.warn('[clientInitializer] Could not close the gateway on shutdown:', err)),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ]);
    if (stopSteps.metricsReady && !isMaintenanceGateClosed()) getMetricsCollector().flushTotals(); // writes via saveData, so it must precede the drain
  });
  // NB7 decision 16: the answers of the requests applied so far are written before the claims are released.
  // NB5 C1 and G10: the watch stops after the exit drain, before any release step writes to the database.
  addReleaseStep(() => stopMainWatch());
  addReleaseStep(guildRequestsStopStep);
  addReleaseStep(() => claimsStop('serving'));

  // NB9 D3: no await since decideBoot, so the standby's answers end in the turn this listener starts.
  endStandbyMaintenanceAnswers();
  setupMaintenanceIPCAtBoot();

  // Data backend boot runs FIRST so the readiness driver exists when the
  // shards are granted (bootShards). File mode is
  // a no-op; postgres mode constructs the backend held until its store
  // identity verifies.
  initDataBackendLayer();
  const backend = getGuildDataBackend();
  watchDataBackend(backend instanceof PostgresBackend ? backend : null);

  setupFleetIPCHandlers();
  setupMetricsIPCHandlers();
  setupSharedOpsIPC();
  reportWriterStage('shared');

  // Every shard runs in this process.
  const fleet = taken ? await bootShards({ taken }) : await bootShards();

  // NB6 decision 14, C25 and D4: the populate builds on the root config's row, so the shared files come first.
  if (backend instanceof PostgresBackend) addStopStep(stopSharedPass);
  // NB6 45 (1) and (3): the applies a stop cut off are put back first; the boot pass's applies stop after their swap.
  if (backend instanceof PostgresBackend) {
    recoverModuleApplies();
    beginBootApplies();
  }
  if ((await bootShared()) === 'stopped') return new Promise<never>(() => undefined);
  if (backend instanceof PostgresBackend) await bootCompileModules();

  // PHASE 0: Ensure config.json is fully populated with schema
  console.log('[Bot] Synchronizing config.json with schema...');
  ensureConfigPopulated();

  // Create a temporary client for module loading (intents will be determined after)
  const tempClient = new Client({ intents: [GatewayIntentBits.Guilds] });

  // PHASE 1: Load modules and extract intents
  const moduleIntents = await loadModules(tempClient);
  if (backend instanceof PostgresBackend) startSharedPass({ guildRequests: requestGuildRequestPass });

  // PHASE 2: Collect intents from internal framework events
  const internalEventsDirRelative = path.join(scanRoot, 'bot', 'internalSetup', 'events');
  const internalEventIntents = collectRequiredIntents(internalEventsDirRelative);

  // PHASE 2b: Collect intents from registered payment providers. Each
  // provider declares what it needs via `getRequiredIntents()`; e.g.
  // ServerBoostingProvider needs GuildMembers to resolve guild.ownerId
  // and read member.premiumSince on the target guild. Without this the
  // bot would log in without those bits and the provider's tick would
  // silently grant nothing.
  const providerIntents: number[] = [];
  try {
    const registry = getPaymentRegistry();
    for (const provider of registry.listAll()) {
      if (typeof provider.getRequiredIntents !== 'function') continue;
      for (const name of provider.getRequiredIntents()) {
        const value = GatewayIntentBits[name as keyof typeof GatewayIntentBits];
        if (typeof value === 'number') providerIntents.push(value);
      }
    }
  } catch (err) {
    console.warn('[clientInitializer] Failed to collect payment-provider intents:', err);
  }

  // PHASE 3: Merge all intents (modules + internal events + providers)
  const requiredIntents = mergeIntents(moduleIntents, internalEventIntents, providerIntents);
  const defaultIntents = [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions ];
  const intents = requiredIntents.length > 0 ? requiredIntents : defaultIntents;
  const finalIntents = intents.map(intent => typeof intent === 'string' ? GatewayIntentBits[intent as keyof typeof GatewayIntentBits] : intent).filter(i => typeof i === 'number');
  const intentsList = finalIntents.map((i) => { const n = Object.entries(GatewayIntentBits).find(([_,v])=>v===i)?.[0]; return n||i; });
  if (!adopted) console.log('Logging in with intents:', intentsList);
  const loggedInBits = adopted ? Number(new IntentsBitField(adopted.options.intents).bitfield) : Number(new IntentsBitField(finalIntents as number[]).bitfield);
  setLoginIntents(loggedInBits);

  // PHASE 4: Create the real client with all required intents.
  // Partials are REQUIRED for reaction events on uncached messages (e.g. a
  // giveaway or halloffame message from before a restart) - without them
  // discord.js silently drops those events. Every internal and module
  // reaction handler already fetches partials before use.
  // Construction goes through IngestService: {shards, shardCount} come from
  // this process's lease (the whole shard set). Every
  // interaction gets its write ledger and its reply gate (BT-3).
  const client = adopted
    ? getIngestService().adoptClient(adopted, installReplyGate)
    : getIngestService().buildClient({
      intents: finalIntents,
      partials: [Partials.Message, Partials.Reaction, Partials.User],
    }, installReplyGate);
  installMaintenanceGate(client);
  client.on('shardReady', () => noteShardReconnect());
  client.on('shardResume', () => noteShardReconnect());

  client.buttonHandlers = new Map<string, RegisteredButtonInfo>();
  client.dropdownHandlers = new Map<string, RegisteredDropdownInfo>();
  client.modalHandlers = new Map<string, RegisteredModalInfo>();
  client.reactionHandlers = new Map<string, RegisteredReactionInfo>();
  client.reactionRemoveHandlers = new Map<string, RegisteredReactionRemoveInfo[]>();

  // Set client on registry for unload context
  getModuleRegistry().setClient(client);
  if (backend instanceof PostgresBackend) setModuleApplyClient(client);

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

    console.log('[Bot] Registering module panels...');
    let modulePanelCount = 0;
    for (const module of loadedModules) {
      if (module.panels.length === 0) continue;

      const c = client as any;
      const bBefore = new Set(Array.from(c.buttonHandlers?.keys() ?? []));
      const mBefore = new Set(Array.from(c.modalHandlers?.keys() ?? []));
      const dBefore = new Set(Array.from(c.dropdownHandlers?.keys() ?? []));
      const rBefore = new Set(Array.from(c.reactionHandlers?.keys() ?? []));
      const rrBefore = new Set(Array.from(c.reactionRemoveHandlers?.keys() ?? []));

      const handed = bootStartOf(module.manifest.name);
      const start = handed && openStarts.get(module.manifest.name) === handed ? handed : null;
      if (start) openWindow(start);
      try {
        for (const panel of module.panels) {
          panelManager.registerPanel(panel);
          modulePanelCount++;
          console.log(`[Bot] Registered panel '${panel.id}' from module '${module.manifest.displayName}'`);
        }
      } finally {
        if (start) closeWindow(start);
      }

      const bAfter = Array.from(c.buttonHandlers?.keys() ?? []) as string[];
      const mAfter = Array.from(c.modalHandlers?.keys() ?? []) as string[];
      const dAfter = Array.from(c.dropdownHandlers?.keys() ?? []) as string[];
      const rAfter = Array.from(c.reactionHandlers?.keys() ?? []) as string[];
      const rrAfter = Array.from(c.reactionRemoveHandlers?.keys() ?? []) as string[];
      const bNew = bAfter.filter(k => !bBefore.has(k));
      const mNew = mAfter.filter(k => !mBefore.has(k));
      const dNew = dAfter.filter(k => !dBefore.has(k));
      const rNew = rAfter.filter(k => !rBefore.has(k));
      const rrNew = rrAfter.filter(k => !rrBefore.has(k));
      for (const id of bNew) { const info = c.buttonHandlers.get(id); if (info) info._moduleName = module.manifest.name; }
      for (const id of mNew) { const info = c.modalHandlers.get(id); if (info) info._moduleName = module.manifest.name; }
      for (const id of dNew) { const info = c.dropdownHandlers.get(id); if (info) info._moduleName = module.manifest.name; }
      for (const id of rNew) { const info = c.reactionHandlers.get(id); if (info) info._moduleName = module.manifest.name; }
      for (const id of rrNew) { const infos = c.reactionRemoveHandlers.get(id); if (infos) for (const info of infos) info._moduleName = module.manifest.name; }
      const existing = module.registeredInteractionIds ?? { buttons: [], modals: [], dropdowns: [] };
      module.registeredInteractionIds = {
        buttons: [...existing.buttons, ...bNew],
        modals: [...existing.modals, ...mNew],
        dropdowns: [...existing.dropdowns, ...dNew]
      };
      const existingReactions = (module as any).registeredReactionIds ?? { reactions: [], reactionRemoves: [] };
      (module as any).registeredReactionIds = {
        reactions: [...existingReactions.reactions, ...rNew],
        reactionRemoves: [...existingReactions.reactionRemoves, ...rrNew]
      };
    }
    console.log(`[Bot] Registered ${modulePanelCount} module panels`);

    // Apply disabled component states from config (panels + events)
    // Commands are handled by registerCommands on clientReady
    applyAllDisabledStatesOnBoot();

    console.log('[Bot] Panel manager initialized successfully');
  } catch (error) {
    console.error('[Bot] Error during panel manager initialization:', error);
  }

  const NOT_STARTED = '[Shards] Module initializers, panel recovery and the module auto-updater do not start: this process stopped serving its shards';
  client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user?.tag}!`);
    if (stoppedServing()) {
      console.log(NOT_STARTED);
      return;
    }
    if (isMaintenanceGateClosed()) {
      console.log('[Maintenance] Module initializers, panel recovery and the module auto-updater start with the restart that ends maintenance');
      return;
    }

    // Module initializers bulk-read guild data; hold them behind the same
    // startup barrier as the clientReady event fan-out (no-op in file mode).
    await awaitDataStartupBarrier();
    if (stoppedServing()) {
      console.log(NOT_STARTED);
      return;
    }
    if (isMaintenanceGateClosed()) {
      console.log('[Maintenance] Module initializers, panel recovery and the module auto-updater start with the restart that ends maintenance');
      return;
    }

    // Run all module initializers (after client is ready), one module at a time
    await runInitializers(client);

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

    if (stoppedServing()) {
      console.log('[Shards] Panel recovery and the module auto-updater stopped: this process stopped serving its shards');
      return;
    }
    // Start module auto-update scheduler (checks every 30min if enabled).
    startModuleAutoUpdater(client);
  });

  // Set up IPC message handlers for Web-UI panel integration
  setupPanelIPCHandlers();

  // Set up IPC handler for console `cmd invoke` (synthetic slash-command dispatch)
  setupCommandIPCHandlers();

  // Set up IPC handlers for the webui's guild data writes and reads
  setupDataIPCHandlers();

  // Set up the optional access-log channel (embed + dev-only shutdown buttons)
  setupAccessLogChannel(client);

  markMetricsReady();

  // Set up IPC message handlers for module hot-reload
  setupReloadIPCHandlers(client);

  // Set up IPC message handlers for component toggle
  setupToggleIPCHandlers(client);

  // Subscription notifier (DM owner / channel fallback) lives in the bot
  // process because it needs the Discord client. The web-UI process drives
  // most state changes and forwards notification requests via IPC.
  getSubscriptionNotifier().setClient(client);
  startPremiumTickers();
  setupIPCNotificationHandler();
  reportWriterStage('guild');
  // NB7 decision 7: on postgres, the changes other machines' web panels send to this process are read from here on.
  startGuildRequestSweep(() => getLeaseRuntime()?.getCurrent() ?? null);

  // Discord App Monetization: bridge gateway entitlement events into our
  // payment-registry event stream. Only the bot process has the client;
  // web-UI process never sees these events.
  try {
    const registry = getPaymentRegistry();
    const discord = registry.get('discord');
    if (discord && (discord as any).attachGatewayBridge) {
      (discord as any).attachGatewayBridge((eventName: string, handler: (payload: any) => void) => {
        client.on(eventName as any, handler);
      });
    }
    // ServerBoostingProvider polls Discord's premium-subscriptions endpoint
    // on the configured target guild. Its setClient() also fires an
    // immediate tick if the timer is already running, so we don't have
    // to call start() again here.
    const boost = registry.get('boost');
    if (boost && (boost as any).setClient) {
      (boost as any).setClient(client);
    }
  } catch (err) {
    console.warn('[clientInitializer] Failed to attach payment provider gateway bridges:', err);
  }

  // Metrics: seed persisted totals, start samplers (needs the client for the
  // per-guild RAM estimate), flush on shutdown. The bot child has no other
  // signal handlers, so this hook is the only shutdown path.
  const metrics = getMetricsCollector();
  metrics.seedTotals();
  startSamplers(client);
  stopSteps = { client, metricsReady: true };

  // Graveyard TTL sweep: at boot and every 24h. unref() so it never keeps the
  // process alive.
  void sweepGraveyard().catch(err => console.warn('[clientInitializer] Graveyard sweep failed:', err));
  const graveyardTimer = setInterval(() => {
    void sweepGraveyard().catch(err => console.warn('[clientInitializer] Graveyard sweep failed:', err));
  }, 24 * 60 * 60 * 1000);
  graveyardTimer.unref();

  // No identify without a held claim; a Postgres process holding none logs in nothing.
  markDiscordStarted();
  // NB9 D1: a promoted standby whose sessions stayed runs the ready work once, as after a login.
  if (fleet.keptSessions === true && !stoppedServing()) {
    const wanted = Number(new IntentsBitField(finalIntents as number[]).bitfield);
    const missing = Object.entries(GatewayIntentBits)
      .filter(([, bit]) => typeof bit === 'number' && (wanted & bit) !== 0 && (loggedInBits & bit) === 0)
      .map(([name]) => name);
    if (missing.length > 0) console.warn(l20Line(missing));
    client.emit('clientReady', client as Client<true>);
  }
  fleet.startIngest(process.env.DISCORD_TOKEN);
}
