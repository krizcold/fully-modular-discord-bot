/**
 * Persistent Panel Storage System
 */

import { Client, TextChannel } from 'discord.js';
import { loadGlobalModuleData, loadModuleData, saveGlobalModuleData, saveModuleData } from '../dataManager';
import { PersistentPanelInstance, PersistentPanelStorage } from '@bot/types/panelTypes';

const STORAGE_FILE = 'persistent-panels.json';
const STORAGE_NAMESPACE = '_panels';

/**
 * Load persistent panel data from the guild's data (global when no guild)
 */
export async function loadPersistentPanels(guildId?: string): Promise<any> {
  const data = guildId
    ? loadModuleData<any>(STORAGE_FILE, guildId, STORAGE_NAMESPACE, {})
    : loadGlobalModuleData<any>(STORAGE_FILE, STORAGE_NAMESPACE, {});
  return data && typeof data === 'object' ? data : {};
}

/**
 * Save persistent panel data: false when the write did not land
 */
export async function savePersistentPanels(storage: any, guildId?: string): Promise<boolean> {
  try {
    const saved = guildId
      ? saveModuleData(STORAGE_FILE, guildId, STORAGE_NAMESPACE, storage)
      : saveGlobalModuleData(STORAGE_FILE, STORAGE_NAMESPACE, storage);
    if (!saved) console.error(`[PersistentPanels] Panel records for ${guildId ?? 'global'} were not saved`);
    return saved;
  } catch (error) {
    console.error(`[PersistentPanels] Panel records for ${guildId ?? 'global'} were not saved:`, error);
    return false;
  }
}

/**
 * Get a specific persistent panel instance
 */
export async function getPersistentPanel(
  panelId: string,
  guildId?: string,
  sessionId?: string
): Promise<PersistentPanelInstance | null> {
  const storage = await loadPersistentPanels(guildId);
  const panelData = storage[panelId];

  if (!panelData) {
    return null;
  }

  if (sessionId && typeof panelData === 'object' && 'sessions' in panelData) {
    return panelData.sessions[sessionId] || null;
  }

  if (typeof panelData === 'object' && 'messageId' in panelData) {
    return panelData;
  }

  return null;
}

/**
 * Store a persistent panel instance
 */
export async function storePersistentPanel(
  panelId: string,
  instance: PersistentPanelInstance,
  guildId?: string,
  sessionId?: string,
  maxInstances: number = 1
): Promise<{ success: boolean; replacedInstance?: PersistentPanelInstance }> {
  const storage = await loadPersistentPanels(guildId);
  let replacedInstance: PersistentPanelInstance | undefined;

  if (sessionId) {
    if (!storage[panelId] || typeof storage[panelId] !== 'object' || !('sessions' in storage[panelId])) {
      storage[panelId] = { sessions: {} };
    }

    const sessions = (storage[panelId] as any).sessions;
    sessions[sessionId] = {
      ...instance,
      lastUpdated: Date.now()
    };
  }
  else {
    if (maxInstances === 1) {
      const existing = storage[panelId] as PersistentPanelInstance;
      if (existing && existing.messageId) {
        replacedInstance = existing;
      }
    }

    storage[panelId] = {
      ...instance,
      lastUpdated: Date.now()
    };
  }

  if (!(await savePersistentPanels(storage, guildId))) {
    return { success: false };
  }

  return { success: true, replacedInstance };
}

/**
 * Update a persistent panel's state
 */
export async function updatePersistentPanelState(
  panelId: string,
  state: string,
  guildId?: string,
  sessionId?: string,
  additionalData?: any
): Promise<boolean> {
  const instance = await getPersistentPanel(panelId, guildId, sessionId);

  if (!instance) {
    return false;
  }

  instance.state = state;
  instance.lastUpdated = Date.now();

  if (additionalData) {
    instance.sessionData = { ...instance.sessionData, ...additionalData };
  }

  const result = await storePersistentPanel(panelId, instance, guildId, sessionId);
  return result.success;
}

/**
 * Remove a persistent panel instance
 */
export async function removePersistentPanel(
  panelId: string,
  guildId?: string,
  sessionId?: string
): Promise<boolean> {
  const storage = await loadPersistentPanels(guildId);

  if (sessionId) {
    // Remove session-based panel
    if (storage[panelId] && typeof storage[panelId] === 'object' && 'sessions' in storage[panelId]) {
      const sessions = (storage[panelId] as any).sessions;
      if (sessions[sessionId]) {
        delete sessions[sessionId];

          if (Object.keys(sessions).length === 0) {
          delete storage[panelId];
        }

        return savePersistentPanels(storage, guildId);
      }
    }
  } else {
    // Remove single-instance panel
    if (storage[panelId]) {
      delete storage[panelId];
      return savePersistentPanels(storage, guildId);
    }
  }

  return false;
}

/**
 * Clean up expired persistent panels
 */
export async function cleanupExpiredPanels(client: Client, guildId?: string): Promise<number> {
  const storage = await loadPersistentPanels(guildId);
  const now = Date.now();
  const expiryTime = 24 * 60 * 60 * 1000;
  let cleanedCount = 0;

  for (const panelId in storage) {
    const panelData = storage[panelId];

      if (typeof panelData === 'object' && 'sessions' in panelData) {
      const sessions = panelData.sessions;
      for (const sessionId in sessions) {
        const session = sessions[sessionId];
        if (now - session.lastUpdated > expiryTime) {
          delete sessions[sessionId];
          cleanedCount++;
        }
      }

      if (Object.keys(sessions).length === 0) {
        delete storage[panelId];
      }
    }
      else if (typeof panelData === 'object' && 'messageId' in panelData) {
    }
  }

  if (cleanedCount > 0) {
    await savePersistentPanels(storage, guildId);
  }

  return cleanedCount;
}

/**
 * Validate that a persistent panel message still exists
 */
export async function validatePersistentPanel(
  client: Client,
  instance: PersistentPanelInstance
): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(instance.channelId);
    if (!channel || !channel.isTextBased()) {
      return false;
    }

    const message = await (channel as TextChannel).messages.fetch(instance.messageId);
    return !!message;
  } catch (error) {
    return false;
  }
}

/**
 * Clean up invalid persistent panels
 */
export async function cleanupInvalidPanels(client: Client, guildId?: string): Promise<number> {
  const storage = await loadPersistentPanels(guildId);
  let cleanedCount = 0;
  let modified = false;

  for (const panelId in storage) {
    const panelData = storage[panelId];

      if (typeof panelData === 'object' && 'sessions' in panelData) {
      const sessions = panelData.sessions;
      for (const sessionId in sessions) {
        const session = sessions[sessionId];
        const isValid = await validatePersistentPanel(client, session);
        if (!isValid) {
          delete sessions[sessionId];
          cleanedCount++;
          modified = true;
        }
      }

      if (Object.keys(sessions).length === 0) {
        delete storage[panelId];
      }
    }
      else if (typeof panelData === 'object' && 'messageId' in panelData) {
      const isValid = await validatePersistentPanel(client, panelData);
      if (!isValid) {
        delete storage[panelId];
        cleanedCount++;
        modified = true;
      }
    }
  }

  if (modified) {
    await savePersistentPanels(storage, guildId);
  }

  return cleanedCount;
}

/**
 * Whether a message is the active instance of a unique panel: 'missing' when this
 * node holds no record for the panel, which says nothing about a newer instance
 */
export async function isActiveInstance(
  panelId: string,
  messageId: string,
  guildId?: string,
  sessionId?: string
): Promise<'active' | 'replaced' | 'missing'> {
  const instance = await getPersistentPanel(panelId, guildId, sessionId);

  if (!instance) {
    return 'missing';
  }

  return instance.messageId === messageId ? 'active' : 'replaced';
}

/**
 * Get all active persistent panels for a specific panel type
 */
export async function getAllPersistentPanels(
  panelId: string,
  guildId?: string
): Promise<PersistentPanelInstance[]> {
  const storage = await loadPersistentPanels(guildId);
  const panelData = storage[panelId];

  if (!panelData) {
    return [];
  }

  if (typeof panelData === 'object' && 'sessions' in panelData) {
    return Object.values(panelData.sessions);
  }

  if (typeof panelData === 'object' && 'messageId' in panelData) {
    return [panelData];
  }

  return [];
}

/**
 * Clean up stale persistent panels on bot startup.
 * Removes entries for messages that no longer exist and panels past their expiration.
 */
export async function cleanupPersistentPanelsOnStartup(client: Client): Promise<void> {
  console.log('[PersistentPanels] Running startup cleanup...');

  const invalidCount = await cleanupInvalidPanels(client);
  if (invalidCount > 0) {
    console.log(`[PersistentPanels] Removed ${invalidCount} invalid panel${invalidCount !== 1 ? 's' : ''}`);
  }

  const expiredCount = await cleanupExpiredPanels(client);
  if (expiredCount > 0) {
    console.log(`[PersistentPanels] Removed ${expiredCount} expired panel${expiredCount !== 1 ? 's' : ''}`);
  }

  console.log('[PersistentPanels] Startup cleanup complete');
}