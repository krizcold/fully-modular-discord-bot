/**
 * Module Event Manager
 *
 * Tracks event listeners per-module so they can be removed on unload.
 * Replaces anonymous closure registration; every module event handler
 * is wrapped and stored with its reference, enabling clean removal
 * via client.removeListener().
 */

import { Client } from 'discord.js';

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
}

// Singleton
let instance: ModuleEventManager | null = null;

export function getModuleEventManager(): ModuleEventManager {
  if (!instance) {
    instance = new ModuleEventManager();
  }
  return instance;
}
