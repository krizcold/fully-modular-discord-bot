/**
 * Module Event Manager
 *
 * Tracks event listeners per-module so they can be removed on unload.
 * Replaces anonymous closure registration; every module event handler
 * is wrapped and stored with its reference, enabling clean removal
 * via client.removeListener().
 *
 * The wrapper also enforces module-level tier gating: when a module
 * declares a whole-module `tierRequirement` (no `gatedCommands` and
 * no `gatedFeatures` set, so the entire module is premium), event
 * handlers are skipped for guilds whose active tier is below the
 * required priority. Modules that gate at the command/feature level
 * pass events through untouched - they self-gate via
 * `pm.hasFeature(guildId, moduleName, featureName)` from inside the
 * handler when premium-only behavior runs.
 */

import { Client } from 'discord.js';

/**
 * Best-effort guildId extraction from a Discord.js event payload.
 * Returns null when the event has no guild context (DMs, clientReady,
 * etc.) - in that case we allow the event through unchanged.
 *
 * Covers the common Discord.js event shapes:
 *   - {guildId} on Message, Channel, Interaction
 *   - {guild: {id}} on GuildMember, Role, GuildBan, etc.
 *   - voiceStateUpdate(old, new) - first arg has guild.id
 */
function extractGuildId(args: any[]): string | null {
  for (const arg of args) {
    if (!arg || typeof arg !== 'object') continue;
    const direct = (arg as any).guildId;
    if (typeof direct === 'string' && direct) return direct;
    const nested = (arg as any).guild?.id;
    if (typeof nested === 'string' && nested) return nested;
  }
  return null;
}

interface TrackedListener {
  eventName: string;
  /** The wrapped handler that was actually attached to the client */
  wrappedHandler: (...args: any[]) => void;
}

/**
 * Singleton that manages module event listeners on the Discord client.
 */
class ModuleEventManager {
  private client: Client | null = null;

  /** moduleName → list of tracked listeners */
  private listeners: Map<string, TrackedListener[]> = new Map();

  /**
   * Set the Discord client. Must be called before registering any listeners.
   */
  setClient(client: Client): void {
    this.client = client;
  }

  /**
   * Register a module's event handler on the client.
   * The handler is wrapped so errors are caught and logged.
   * The wrapper reference is stored for later removal.
   */
  registerListener(
    moduleName: string,
    eventName: string,
    handler: Function
  ): void {
    if (!this.client) {
      throw new Error('[ModuleEventManager] Client not set; call setClient() first');
    }

    const wrappedHandler = async (...args: any[]) => {
      try {
        // Whole-module tier gate: looked up at fire time so manifest hot-edits
        // and tier upgrades take effect without re-registering listeners.
        // We only auto-gate when the manifest signals a module-wide premium
        // requirement (no gatedCommands and no gatedFeatures arrays). Modules
        // that gate at the command or feature level pass events through and
        // self-gate inside the handler.
        if (this.shouldSkipEvent(moduleName, args)) return;

        await handler(this.client!, ...args);
      } catch (error) {
        console.error(`[ModuleLoader] Error in ${moduleName} ${eventName} handler:`, error);
      }
    };

    this.client.on(eventName, wrappedHandler);

    if (!this.listeners.has(moduleName)) {
      this.listeners.set(moduleName, []);
    }
    this.listeners.get(moduleName)!.push({ eventName, wrappedHandler });
  }

  /**
   * Remove all event listeners for a specific module.
   * Returns the number of listeners removed.
   */
  removeModuleListeners(moduleName: string): number {
    if (!this.client) return 0;

    const tracked = this.listeners.get(moduleName);
    if (!tracked || tracked.length === 0) return 0;

    for (const { eventName, wrappedHandler } of tracked) {
      this.client.removeListener(eventName, wrappedHandler);
    }

    const count = tracked.length;
    this.listeners.delete(moduleName);
    return count;
  }

  /**
   * Remove listeners for a specific event within a module.
   * Used by component toggle to disable individual events without unloading the module.
   * Returns the number of listeners removed.
   */
  removeEventListeners(moduleName: string, eventName: string): number {
    if (!this.client) return 0;

    const tracked = this.listeners.get(moduleName);
    if (!tracked || tracked.length === 0) return 0;

    const toRemove = tracked.filter(t => t.eventName === eventName);
    const toKeep = tracked.filter(t => t.eventName !== eventName);

    for (const { wrappedHandler } of toRemove) {
      this.client.removeListener(eventName, wrappedHandler);
    }

    if (toKeep.length > 0) {
      this.listeners.set(moduleName, toKeep);
    } else {
      this.listeners.delete(moduleName);
    }

    return toRemove.length;
  }

  /**
   * Get the count of tracked listeners for a module.
   */
  getListenerCount(moduleName: string): number {
    return this.listeners.get(moduleName)?.length || 0;
  }

  /**
   * Get total listener count across all modules.
   */
  getTotalListenerCount(): number {
    let total = 0;
    for (const tracked of this.listeners.values()) {
      total += tracked.length;
    }
    return total;
  }

  /**
   * Check if a module has any registered listeners.
   */
  hasListeners(moduleName: string): boolean {
    const tracked = this.listeners.get(moduleName);
    return !!tracked && tracked.length > 0;
  }

  /**
   * Remove ALL module listeners (used during full shutdown/reset).
   */
  removeAllListeners(): number {
    let total = 0;
    for (const moduleName of this.listeners.keys()) {
      total += this.removeModuleListeners(moduleName);
    }
    return total;
  }

  /**
   * Whole-module tier gate for events. Returns true when this event should
   * be skipped because the module is wholly premium-locked AND the guild
   * resolved from the args is below the required tier priority.
   *
   * Returns false (allow) when:
   *   - The module has no `tierRequirement` manifest entry.
   *   - The module declares command-level or feature-level gates
   *     (gatedCommands / gatedFeatures present): events pass through and
   *     the module self-gates via `pm.hasFeature` from inside the handler.
   *   - No guild can be extracted from the event args (DM, clientReady,
   *     errors, etc.).
   *   - The premium manager or registry is unavailable - we never fail
   *     closed on infrastructure problems.
   */
  private shouldSkipEvent(moduleName: string, args: any[]): boolean {
    let registry: any;
    let pm: any;
    try {
      registry = require('./moduleRegistry').getModuleRegistry();
      pm = require('./premiumManager').getPremiumManager();
    } catch {
      return false;
    }

    const manifest = registry.getModule(moduleName)?.manifest;
    const tr = manifest?.tierRequirement;
    if (!tr || typeof tr.minPriority !== 'number') return false;

    const hasCommandGate = Array.isArray(tr.gatedCommands) && tr.gatedCommands.length > 0;
    const hasFeatureGate = Array.isArray(tr.gatedFeatures) && tr.gatedFeatures.length > 0;
    if (hasCommandGate || hasFeatureGate) return false;

    const guildId = extractGuildId(args);
    if (!guildId) return false;

    return !pm.hasFeatureAccess(guildId, tr.minPriority);
  }
}

// Singleton
let instance: ModuleEventManager | null = null;

export function getModuleEventManager(): ModuleEventManager {
  if (!instance) {
    instance = new ModuleEventManager();
  }
  return instance;
}
