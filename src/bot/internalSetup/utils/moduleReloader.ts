/**
 * Module Reloader
 *
 * Orchestrates the hot-reload cycle for modules:
 * unload → recompile → clear cache → re-import → register → re-attach events/panels
 *
 * Delegates actual module loading to ModuleLoader.loadModule(), single source of truth.
 * Handles both single module and bulk reload.
 */

import { Client, ApplicationCommandType } from 'discord.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { getModuleRegistry } from './moduleRegistry';
import { getModuleEventManager } from './moduleEventManager';
import { ModuleLoader, hotLoadRefusal } from './moduleLoader';
import { LoadedModule, ModuleManifest } from '../../types/moduleTypes';
import { getPanelManager } from './panelManager';
import {
  findModuleManifests,
  getModuleDataPath,
  getBuildRoot
} from './pathHelpers';
import { applyComponentToggleState } from './ipcToggleHandler';
import { reRegisterSlashCommands } from './commandUtils';
import { isAutoCleanupEnabled } from '../events/clientReady/registerCommands';
import { clearSchemaCache, getModulesWithSettings } from './settings/settingsDiscovery';
import { createAllSettingsPanels } from './settings/settingsPanelFactory';
import { STOPPED_SERVING_TEXT, stoppedServing } from './servingGate';
import { getMetricsCollector } from './metrics/metricsCollector';
import { resolveClientApplication } from './clientApplication';
import { beginReload, endReload, recordHeldBack, recordLoadFailure } from './loadFailures';
import {
  applyOfStart, applyTails, closeWindow, endStart, INITIALIZER_LATE_MS, INITIALIZER_WAIT_MS, markLate, openWindow, startEndFailed, startModule,
  startShaOf, startStateOf, type ModuleStart, type StartResult, type StartState,
} from './moduleCrashes';

/** T31 (decisions 93, 104 and 109): a reload refused while the module's start is open or its last change unfinished. */
export function reloadRefusedText(module: string, state: StartState): string {
  switch (state) {
    case 'a':
      return `${module} was not reloaded: this machine is still running its start-up code, and waits for it for at most 10 minutes after it began. Try again once it finishes.`;
    case 'c':
      return `${module} was not reloaded: this machine is still starting it. Its start-up code runs once the bot has connected to Discord, loaded its data and started the modules before it, and the bot waits for it for at most 10 minutes. Try again after that.`;
    case 'd':
      return `${module} was not reloaded: this machine is loading it right now. Try again once that load finishes.`;
    case 'e':
      return `${module} was not reloaded: finishing its last change failed on this machine (see the bot's log), and the bot finishes it at its next start. Restart the bot, then try again.`;
    case 'f':
      return `${module} was not reloaded: this machine is still finishing its last change of ${module}. Try again in a few minutes.`;
  }
}

/** T24's running forms (decision 92): a reload of a version held back in place. */
export function heldBackText(module: string, version: string): { log: string; answer: string } {
  return {
    log: `[Reloader] ${module} ${version} was not loaded: this machine holds it back after the bot stopped twice while it was starting it (see the App Store tab)`,
    answer: `${module} ${version} was not loaded: this machine holds it back after the bot stopped twice while it was starting it. Update ${module}, or uninstall and install it again, to load it on this machine.`,
  };
}

/** Why a module start refused a load: T24's answer for a held version, T31's for a start that is open. */
function refusedLoad(module: string, version: string, answer: 'held' | 'starting'): string {
  if (answer === 'held') {
    const text = heldBackText(module, version);
    recordHeldBack(module);
    console.error(text.log);
    return text.answer;
  }
  return reloadRefusedText(module, startStateOf(module) ?? 'd');
}

/** T31 (e) or (f): the entry's `applying` set with no start open and no apply running (decision 101). */
function unfinishedChange(module: string): string | null {
  const state = startStateOf(module);
  return state === 'e' || state === 'f' ? reloadRefusedText(module, state) : null;
}

interface CapturedCommand {
  name: string;
  type: number;
  testOnly: boolean;
}

export async function deleteModuleCommandsFromDiscord(
  client: Client,
  commands: CapturedCommand[]
): Promise<void> {
  if (commands.length === 0) return;
  if (!isAutoCleanupEnabled()) return;

  try {
    const guildId = process.env.GUILD_ID;
    const application = await resolveClientApplication(client);
    if (!application) {
      console.error(`[Reloader] Commands not deleted from Discord (${commands.map(c => c.name).join(', ')}): the bot application could not be resolved`);
      return;
    }
    const globalCommands = await application.commands.fetch();
    const hasTestOnly = commands.some(c => c.testOnly);
    if (hasTestOnly && !guildId) {
      console.error('[Reloader] Test-only commands not deleted from Discord: GUILD_ID is not set');
    }
    const guildCommands = hasTestOnly && guildId ? await application.commands.fetch({ guildId }) : undefined;

    for (const cmd of commands) {
      const list = cmd.testOnly ? guildCommands : globalCommands;
      if (!list) continue;

      const match = list.find(c => c.name === cmd.name && c.type === cmd.type);
      if (!match) continue;

      try {
        await application.commands.delete(match.id, cmd.testOnly ? guildId : undefined);
        console.log(`[Reloader] Deleted ${cmd.testOnly ? 'local' : 'global'} command "${cmd.name}" from Discord`);
      } catch (err: any) {
        if (err?.code === 10063) {
          console.debug(`[Reloader] Command "${cmd.name}" already gone on Discord (10063)`);
        } else {
          console.error(`[Reloader] Failed to delete command "${cmd.name}":`, err);
        }
      }
    }
  } catch (err) {
    console.error('[Reloader] Failed during targeted command cleanup:', err);
  }
}

// Guard against concurrent reloads of the same module
const reloadingModules: Set<string> = new Set();

/** Decision 60: the apply holds a module's reload mark through its whole run. */
export function isReloading(module: string): boolean {
  return reloadingModules.has(module);
}

export function markReloading(module: string): void {
  reloadingModules.add(module);
}

export function unmarkReloading(module: string): void {
  reloadingModules.delete(module);
}

export interface ReloadResult {
  success: boolean;
  moduleName: string;
  error?: string;
  duration?: number;
}

export interface BulkReloadResult {
  success: boolean;
  reloaded: string[];
  failed: Array<{ moduleName: string; error: string }>;
  compileDuration: number;
  totalDuration: number;
}

const execAsync = promisify(exec);

/**
 * Recompile TypeScript (incremental, non-blocking).
 * Uses async exec so the event loop stays alive (Discord heartbeats, etc.).
 * Serialized: only one recompile runs at a time.
 */
const ASSET_EXTENSIONS = new Set(['.json', '.css', '.html', '.jsx', '.js']);

function copyBuildAssetsToDist(): void {
  const buildRoot = getBuildRoot();
  const distRoot = path.join(process.cwd(), 'dist');
  if (!fs.existsSync(buildRoot) || buildRoot === distRoot) return;

  const walk = (srcDir: string, dstDir: string) => {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const dstPath = path.join(dstDir, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, dstPath);
      } else if (ASSET_EXTENSIONS.has(path.extname(entry.name))) {
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  };

  try {
    walk(buildRoot, distRoot);
  } catch (err) {
    console.error('[Reloader] Asset copy failed:', err);
  }
}

/** One tsc error: `file` relative to the working directory, '/'-separated (decision 46). */
export interface CompileDiagnostic {
  file: string;
  line: number;
  code: number;
  text: string;
}

export interface CompileResult {
  success: boolean;
  error?: string;
  duration: number;
  diagnostics: CompileDiagnostic[];
}

const DIAGNOSTIC_LINE = /^(.+)\((\d+),(\d+)\): error TS(\d+): (.*)$/;

/** tsc's `<file>(<line>,<col>): error TS<code>: <text>` lines of its stdout and stderr. */
export function parseDiagnostics(output: string, cwd: string = process.cwd()): CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = DIAGNOSTIC_LINE.exec(raw.trim());
    if (!match) continue;
    const file = path.relative(cwd, path.resolve(cwd, match[1])).split(path.sep).join('/');
    out.push({ file, line: Number(match[2]), code: Number(match[4]), text: match[5] });
  }
  return out;
}

const COMPILE_TIMEOUT_MS = 60_000;

async function compileOnce(timeoutMs: number): Promise<CompileResult> {
  const start = Date.now();
  try {
    const tscBin = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
    await execAsync(`"${tscBin}" -p tsconfig.json`, {
      cwd: process.cwd(),
      timeout: timeoutMs
    });
    copyBuildAssetsToDist();
    if (process.platform !== 'win32') await execAsync('sync', { timeout: COMPILE_TIMEOUT_MS });
    return { success: true, duration: Date.now() - start, diagnostics: [] };
  } catch (error: any) {
    const stderr = error.stderr?.toString() || error.message || 'Unknown compilation error';
    const diagnostics = parseDiagnostics(`${error.stdout?.toString() ?? ''}\n${error.stderr?.toString() ?? ''}`);
    // tsconfigprod.json has no noEmitOnError: with type errors the JS is still emitted, and its assets go beside it.
    if (diagnostics.length > 0) copyBuildAssetsToDist();
    return { success: false, error: stderr, duration: Date.now() - start, diagnostics };
  }
}

let compileRun: Promise<CompileResult> | null = null;
let compileNext: { timeoutMs: number; result: Promise<CompileResult> } | null = null;

function startCompile(timeoutMs: number): Promise<CompileResult> {
  const run = compileOnce(timeoutMs).finally(() => {
    if (compileRun === run) compileRun = null;
  });
  compileRun = run;
  return run;
}

/**
 * Recompile TypeScript (incremental, non-blocking). A call while a compile runs waits for it to end and shares the
 * next one, which starts after every call that joined it, so every caller gets a compile that started after its call
 * (decision 46). A shared compile runs with the largest `timeoutMs` of its callers (81).
 */
export function recompileTypeScript(opts: { timeoutMs?: number } = {}): Promise<CompileResult> {
  const timeoutMs = opts.timeoutMs ?? COMPILE_TIMEOUT_MS;
  if (compileNext) {
    compileNext.timeoutMs = Math.max(compileNext.timeoutMs, timeoutMs);
    return compileNext.result;
  }
  if (!compileRun) return startCompile(timeoutMs);
  const next: { timeoutMs: number; result: Promise<CompileResult> } = { timeoutMs, result: Promise.resolve(null as unknown as CompileResult) };
  next.result = compileRun.then(() => undefined, () => undefined).then(() => {
    compileNext = null;
    return startCompile(next.timeoutMs);
  });
  compileNext = next;
  return next.result;
}

/**
 * Find a module's manifest by name and pass it through the boot loader's gates.
 * Two manifests with one name are refused: boot would load only the first, and
 * a reload by name cannot tell which copy is meant.
 */
function resolveHotLoad(
  client: Client,
  moduleName: string
): { manifest: ModuleManifest; modulePath: string } | { error: string } {
  const matches: Array<{ manifest: ModuleManifest; manifestPath: string }> = [];
  for (const manifestPath of findModuleManifests()) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      if (manifest.name === moduleName) matches.push({ manifest, manifestPath });
    } catch {
      continue;
    }
  }
  if (matches.length === 0) return { error: 'Module manifest not found' };
  if (matches.length > 1) {
    return {
      error: `Two modules are named "${moduleName}" (${matches.map(m => path.dirname(m.manifestPath)).join(', ')}); remove or rename one, then restart the bot`
    };
  }
  const refusal = hotLoadRefusal(matches[0].manifest, client);
  if (refusal) return { error: refusal };
  return { manifest: matches[0].manifest, modulePath: path.dirname(matches[0].manifestPath) };
}

/**
 * After loading a module, register its events/panels/commands and call lifecycle hooks.
 * ModuleLoader.loadModule() only creates the LoadedModule, it doesn't attach to the client.
 */
async function registerReloadedModule(client: Client, module: LoadedModule, start: ModuleStart): Promise<void> {
  // NB4 decision 6: a compile or load that ran across the deadline or a loss registers nothing and calls no module code.
  if (stoppedServing()) throw new Error(STOPPED_SERVING_TEXT);
  const registry = getModuleRegistry();
  registry.register(module);

  // Register event listeners via EventManager
  const eventManager = getModuleEventManager();
  for (const [eventName, handlers] of module.events) {
    for (const handler of handlers) {
      if (typeof handler === 'function') {
        eventManager.registerListener(module.manifest.name, eventName, handler);
      }
    }
  }

  // Snapshot BEFORE panel registration, since panels call panel.initialize(client)
  // which may register interaction handlers too.
  const bBefore = new Set(Array.from(((client as any).buttonHandlers ?? new Map()).keys()));
  const mBefore = new Set(Array.from(((client as any).modalHandlers ?? new Map()).keys()));
  const dBefore = new Set(Array.from(((client as any).dropdownHandlers ?? new Map()).keys()));
  const rBefore = new Set(Array.from(((client as any).reactionHandlers ?? new Map()).keys()));
  const rrBefore = new Set(Array.from(((client as any).reactionRemoveHandlers ?? new Map()).keys()));

  // Register module-defined panels
  try {
    const panelManager = getPanelManager();
    for (const panel of module.panels) {
      if (panel?.id) {
        panelManager.registerPanel(panel);
      }
    }

    // Generate and register auto-created settings panels from settingsSchema.json
    clearSchemaCache();
    const modulesWithSettings = getModulesWithSettings(true);
    const thisModule = modulesWithSettings.find(m => m.name === module.manifest.name);
    if (thisModule) {
      const settingsPanels = createAllSettingsPanels([thisModule]);
      for (const panel of settingsPanels) {
        panelManager.registerPanel(panel);
        if (typeof panel.initialize === 'function') {
          panel.initialize(client);
        }
      }
    }
  } catch {
    // panelManager may not be initialized
  }

  // Run command initializers (button/dropdown/modal handlers). Their promises are settled together from the calls on
  // (decision 99), so one that rejects while onLoad runs has a handler; the turn awaits them after the bookkeeping.
  const initializing: Promise<unknown>[] = [];
  for (const command of module.commands) {
    if (typeof command.initialize === 'function') {
      if (start.turnAt === null) start.turnAt = Date.now();
      try {
        const returned: unknown = command.initialize(client);
        if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') initializing.push(Promise.resolve(returned));
      } catch (error) {
        console.error(`[Reloader] Command initialize failed for ${module.manifest.name}:`, error);
      }
    }
  }
  const settled = Promise.allSettled(initializing);

  // Call onLoad hook
  if (module.hooks?.onLoad) {
    try {
      await module.hooks.onLoad({
        client,
        manifest: module.manifest,
        modulePath: module.path,
        dataPath: getModuleDataPath(module.manifest.name)
      });
    } catch (error) {
      console.error(`[Reloader] onLoad hook failed for ${module.manifest.name}:`, error);
    }
  }

  if (stoppedServing()) throw new Error(STOPPED_SERVING_TEXT);
  // Call onReady hook
  if (module.hooks?.onReady) {
    try {
      await module.hooks.onReady({
        client,
        manifest: module.manifest,
        modulePath: module.path,
        dataPath: getModuleDataPath(module.manifest.name)
      });
    } catch (error) {
      console.error(`[Reloader] onReady hook failed for ${module.manifest.name}:`, error);
    }
  }

  const bAfter = Array.from(((client as any).buttonHandlers ?? new Map()).keys()) as string[];
  const mAfter = Array.from(((client as any).modalHandlers ?? new Map()).keys()) as string[];
  const dAfter = Array.from(((client as any).dropdownHandlers ?? new Map()).keys()) as string[];
  const rAfter = Array.from(((client as any).reactionHandlers ?? new Map()).keys()) as string[];
  const rrAfter = Array.from(((client as any).reactionRemoveHandlers ?? new Map()).keys()) as string[];
  const bNew = bAfter.filter(k => !bBefore.has(k));
  const mNew = mAfter.filter(k => !mBefore.has(k));
  const dNew = dAfter.filter(k => !dBefore.has(k));
  const rNew = rAfter.filter(k => !rBefore.has(k));
  const rrNew = rrAfter.filter(k => !rrBefore.has(k));
  for (const id of bNew) { const info = (client as any).buttonHandlers.get(id); if (info) info._moduleName = module.manifest.name; }
  for (const id of mNew) { const info = (client as any).modalHandlers.get(id); if (info) info._moduleName = module.manifest.name; }
  for (const id of dNew) { const info = (client as any).dropdownHandlers.get(id); if (info) info._moduleName = module.manifest.name; }
  for (const id of rNew) { const info = (client as any).reactionHandlers.get(id); if (info) info._moduleName = module.manifest.name; }
  for (const id of rrNew) { const infos = (client as any).reactionRemoveHandlers.get(id); if (infos) for (const info of infos) info._moduleName = module.manifest.name; }
  module.registeredInteractionIds = {
    buttons: bNew,
    modals: mNew,
    dropdowns: dNew
  };
  (module as any).registeredReactionIds = {
    reactions: rNew,
    reactionRemoves: rrNew
  };

  // Re-apply component toggle state (keep disabled components off after reload)
  await applyComponentToggleState(client, module);

  await initializerTurn(module.manifest.name, start, settled);

  console.log(`[Reloader] Reloaded: ${module.manifest.displayName} v${module.manifest.version} (${module.commands.length} commands, ${module.events.size} event types, ${module.panels.length} panels)`);
}

const firstRejection = (results: PromiseSettledResult<unknown>[]): PromiseRejectedResult | undefined =>
  results.find((r): r is PromiseRejectedResult => r.status === 'rejected');

/**
 * The turn of a running bot (decisions 67, 78, 89, 99 and 101): the initializers' promises awaited up to 60 s. All
 * settled: the start ends there, a rejection being the module's load failure. Past 60 s: T27, the window closes, the
 * start is late, and a task nothing awaits ends it when they settle or at 10 minutes from the turn's begin (T29).
 */
async function initializerTurn(name: string, start: ModuleStart, settled: Promise<PromiseSettledResult<unknown>[]>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<'bound'>(resolve => {
    timer = setTimeout(() => resolve('bound'), INITIALIZER_WAIT_MS);
  });
  const outcome = await Promise.race([settled, bound]);
  clearTimeout(timer);
  if (outcome !== 'bound') {
    const rejected = firstRejection(outcome);
    if (rejected) {
      console.error(`[Reloader] Command initialize failed for ${name}:`, rejected.reason);
      recordLoadFailure(name);
      await endStart(start, { rejected: rejected.reason });
    } else {
      await endStart(start, 'ok');
    }
    return;
  }
  const tails = applyTails(start);
  console.warn(`[Reloader] ${name}'s initializers did not finish within 60 s; the reload goes on and waits up to 10 minutes for them${tails.t27}`);
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
      let result: StartResult = 'ok';
      if (late === 'bound') {
        console.warn(`[Reloader] ${name}'s initializers did not finish within 10 minutes; the bot counts ${name} as started${tails.t29}`);
        result = 'bound';
      } else {
        const rejected = firstRejection(late);
        if (rejected) {
          result = { rejected: rejected.reason };
          if (!applyOfStart(start)) console.error(`[Reloader] Command initialize failed for ${name}:`, rejected.reason);
        }
      }
      await endStart(start, result);
    } catch (error) {
      startEndFailed(start, error);
    }
  })();
}

/** A load of one module and its outcome; `start` and `late` when a start was opened (decision 91). */
export interface UnmarkedLoad extends ReloadResult {
  start?: ModuleStart;
  late?: boolean;
  /** startModule refused it: a version held back in place, or an open start of the module. */
  refused?: 'held' | 'starting';
}

/**
 * Decision 60: the body of a reload after its compile, with no reload mark of its own (the caller holds it): the
 * module's start opened before its code runs and before the old copy is unloaded, the load inside the start's window,
 * the old module's unload, the registration and its initializer turn. Its `finally` ends the start `{ failed }` unless
 * the turn ended it or made it late (99).
 */
export async function loadModuleUnmarked(client: Client, moduleName: string): Promise<UnmarkedLoad> {
  const t0 = Date.now();
  let start: ModuleStart | null = null;
  let failure: unknown;
  try {
    const registry = getModuleRegistry();
    const existingModule = registry.getModule(moduleName);
    const target = resolveHotLoad(client, moduleName);
    if ('error' in target) {
      recordLoadFailure(moduleName);
      return { success: false, moduleName, error: target.error, duration: Date.now() - t0 };
    }
    const { manifest, modulePath } = target;
    const opened = startModule(moduleName, startShaOf(moduleName), manifest.version, modulePath);
    if (opened === 'held' || opened === 'starting') {
      return { success: false, moduleName, error: refusedLoad(moduleName, manifest.version, opened), duration: Date.now() - t0, refused: opened };
    }
    start = opened;
    openWindow(start);
    try {
      const loader = new ModuleLoader(client);
      const newModule = await loader.loadModule(manifest, modulePath);
      if (existingModule) {
        await registry.unloadModule(moduleName);
        getMetricsCollector().dropModule(moduleName);
      }
      await registerReloadedModule(client, newModule, start);
    } finally {
      closeWindow(start);
    }

    await reRegisterSlashCommands(client, { runOrphanCleanup: false });

    const action = existingModule ? 'Reloaded' : 'Loaded';
    console.log(`[Reloader] ${action}: ${moduleName} (${Date.now() - t0}ms)`);
    return { success: true, moduleName, duration: Date.now() - t0, start, late: start.late };
  } catch (error: any) {
    failure = error;
    recordLoadFailure(moduleName);
    return { success: false, moduleName, error: error?.message || String(error), duration: Date.now() - t0, ...(start ? { start, late: start.late } : {}) };
  } finally {
    if (start && !start.late) await endStart(start, { failed: failure ?? new Error('the load did not finish') });
  }
}

/** Decision 60: `unloadModuleFromMemory`'s body after its reload-mark check. */
export async function unloadModuleUnmarked(client: Client, moduleName: string): Promise<ReloadResult> {
  const start = Date.now();
  const registry = getModuleRegistry();
  const existingModule = registry.getModule(moduleName);

  if (!existingModule) {
    return { success: true, moduleName, duration: 0 };
  }

  const capturedCommands: CapturedCommand[] = existingModule.commands
    .filter((c: any) => c && typeof c.name === 'string')
    .map((c: any) => ({
      name: c.name,
      type: (c.type ?? ApplicationCommandType.ChatInput) as number,
      testOnly: !!c.testOnly
    }));

  try {
    await registry.unloadModule(moduleName);
    getMetricsCollector().dropModule(moduleName);
    await deleteModuleCommandsFromDiscord(client, capturedCommands);
    await reRegisterSlashCommands(client, { runOrphanCleanup: false });

    console.log(`[Reloader] Unloaded: ${moduleName} (${Date.now() - start}ms)`);
    return { success: true, moduleName, duration: Date.now() - start };
  } catch (error: any) {
    return { success: false, moduleName, error: error.message || String(error), duration: Date.now() - start };
  }
}

/**
 * Reload a single module by name.
 * Works for both existing modules (unload → reload) and fresh installs (just load).
 */
export async function reloadModule(client: Client, moduleName: string): Promise<ReloadResult> {
  beginReload();
  try {
    return await reloadModuleBody(client, moduleName);
  } finally {
    endReload();
  }
}

async function reloadModuleBody(client: Client, moduleName: string): Promise<ReloadResult> {
  if (reloadingModules.has(moduleName)) {
    return { success: false, moduleName, error: 'Module is already being reloaded' };
  }

  const unfinished = unfinishedChange(moduleName);
  if (unfinished) return { success: false, moduleName, error: unfinished };

  reloadingModules.add(moduleName);
  const start = Date.now();

  try {
    // Atomic swap: prepare new module before touching registry so a mid-flight
    // failure leaves the old module registered.
    const compile = await recompileTypeScript();
    if (!compile.success) {
      recordLoadFailure(moduleName);
      return { success: false, moduleName, error: `Compilation failed: ${compile.error}`, duration: Date.now() - start };
    }
    const loaded = await loadModuleUnmarked(client, moduleName);
    return { success: loaded.success, moduleName, ...(loaded.error === undefined ? {} : { error: loaded.error }), duration: Date.now() - start };
  } finally {
    reloadingModules.delete(moduleName);
  }
}

/**
 * Unload a module from memory (for uninstall).
 * Removes events, panels, commands, cache. Module is fully gone from runtime.
 */
export async function unloadModuleFromMemory(client: Client, moduleName: string): Promise<ReloadResult> {
  if (reloadingModules.has(moduleName)) {
    return { success: false, moduleName, error: 'Module is currently being reloaded' };
  }
  return unloadModuleUnmarked(client, moduleName);
}

/**
 * Reload multiple modules. Recompiles once, then reloads each module.
 */
export async function reloadModules(client: Client, moduleNames: string[]): Promise<BulkReloadResult> {
  beginReload();
  try {
    return await reloadModulesBody(client, moduleNames);
  } finally {
    endReload();
  }
}

async function reloadModulesBody(client: Client, moduleNames: string[]): Promise<BulkReloadResult> {
  // Filter out modules that are already being reloaded
  const available = moduleNames.filter(n => !reloadingModules.has(n));
  const skipped = moduleNames.filter(n => reloadingModules.has(n));

  const start = Date.now();
  const registry = getModuleRegistry();
  const result: BulkReloadResult = {
    success: true,
    reloaded: [],
    failed: skipped.map(n => ({ moduleName: n, error: 'Module is already being reloaded' })),
    compileDuration: 0,
    totalDuration: 0
  };

  for (const name of available) reloadingModules.add(name);
  const starts: ModuleStart[] = [];
  let thrown: unknown;

  try {
    // 1. Single recompile for all changes, so the gate reads the manifest the compile produced
    const compile = await recompileTypeScript();
    result.compileDuration = compile.duration;
    if (!compile.success) {
      result.success = false;
      for (const name of available) {
        recordLoadFailure(name);
        result.failed.push({ moduleName: name, error: `Compilation failed: ${compile.error}` });
      }
      result.totalDuration = Date.now() - start;
      return result;
    }

    // Each module's start opens before step 2's unloads (decision 89); a refused one is neither unloaded nor loaded.
    const targets = new Map<string, { manifest: ModuleManifest; modulePath: string; start: ModuleStart }>();
    for (const name of available) {
      const unfinished = unfinishedChange(name);
      if (unfinished) {
        result.failed.push({ moduleName: name, error: unfinished });
        continue;
      }
      const target = resolveHotLoad(client, name);
      if ('error' in target) {
        recordLoadFailure(name);
        result.failed.push({ moduleName: name, error: target.error });
        continue;
      }
      const opened = startModule(name, startShaOf(name), target.manifest.version, target.modulePath);
      if (opened === 'held' || opened === 'starting') {
        result.failed.push({ moduleName: name, error: refusedLoad(name, target.manifest.version, opened) });
        continue;
      }
      starts.push(opened);
      targets.set(name, { ...target, start: opened });
    }
    const accepted = [...targets.keys()];

    // 2. Unload only the accepted modules
    for (const name of accepted) {
      const existing = registry.getModule(name);
      if (existing) {
        await registry.unloadModule(name);
        getMetricsCollector().dropModule(name);
      }
    }

    // 3. Reload each module via ModuleLoader
    const loader = new ModuleLoader(client);
    for (const name of accepted) {
      const { manifest, modulePath, start: begun } = targets.get(name)!;
      openWindow(begun);
      try {
        const module = await loader.loadModule(manifest, modulePath);
        await registerReloadedModule(client, module, begun);
        result.reloaded.push(name);
      } catch (error: any) {
        recordLoadFailure(name);
        result.failed.push({ moduleName: name, error: error.message || String(error) });
        if (!begun.late) await endStart(begun, { failed: error });
      } finally {
        closeWindow(begun);
      }
    }

    if (result.reloaded.length > 0) {
      await reRegisterSlashCommands(client, { runOrphanCleanup: false });
    }

    result.success = result.failed.length === 0;
    result.totalDuration = Date.now() - start;
    return result;
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    // Decision 106: no start of this run stays open past it, whatever threw; a late one is its late task's.
    for (const begun of starts) {
      if (!begun.late) await endStart(begun, { failed: thrown ?? new Error('the load did not finish') });
    }
    for (const name of available) reloadingModules.delete(name);
  }
}
