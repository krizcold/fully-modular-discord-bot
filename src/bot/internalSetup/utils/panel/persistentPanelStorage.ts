/**
 * Persistent Panel Storage System
 */

import { Client, TextChannel } from 'discord.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PersistentPanelInstance, PersistentPanelStorage } from '@bot/types/panelTypes';

// Storage paths
const GLOBAL_STORAGE_PATH = '/data/global/persistent-panels.json';

/**
 * Get the storage path for a specific guild or global
 */
function getStoragePath(guildId?: string): string {
  if (!guildId) {
    return GLOBAL_STORAGE_PATH;
  }
  return path.join('/data', guildId, 'persistent-panels.json');
}

/**
 * Load persistent panel data from storage
 */
export async function loadPersistentPanels(guildId?: string): Promise<any> {
  const storagePath = getStoragePath(guildId);

  try {
    const data = await fs.readFile(storagePath, 'utf-8');
    return JSON.parse(data);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return {};
    }
    console.error(`Error loading persistent panels from ${storagePath}:`, error);
    return {};
  }
}

/**
 * Save persistent panel data to storage
 */
export async function savePersistentPanels(storage: any, guildId?: string): Promise<void> {
  const storagePath = getStoragePath(guildId);

  try {
    // Ensure directory exists
    const dir = path.dirname(storagePath);
    await fs.mkdir(dir, { recursive: true });

    // Save data
    await fs.writeFile(storagePath, JSON.stringify(storage, null, 2));
  } catch (error) {
    console.error(`Error saving persistent panels to ${storagePath}:`, error);
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

  await savePersistentPanels(storage, guildId);

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

  await storePersistentPanel(panelId, instance, guildId, sessionId);
  return true;
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

        await savePersistentPanels(storage, guildId);
        return true;
      }
    }
  } else {
    // Remove single-instance panel
    if (storage[panelId]) {
      delete storage[panelId];
      await savePersistentPanels(storage, guildId);
      return true;
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
 * Check if a message ID is the current active instance for a unique panel
 * Returns true if the message is the active instance, false otherwise
 */
export async function isActiveInstance(
  panelId: string,
  messageId: string,
  guildId?: string,
  sessionId?: string
): Promise<boolean> {
  const instance = await getPersistentPanel(panelId, guildId, sessionId);

  if (!instance) {
    return false;
  }

  return instance.messageId === messageId;
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
 * Migrate persistent panels on bot startup
 */
export async function migratePersistentPanels(client: Client): Promise<void> {
  console.log('Migrating persistent panels...');

  // Clean up global panels
  const globalCleaned = await cleanupInvalidPanels(client);
  if (globalCleaned > 0) {
    console.log(`Cleaned up ${globalCleaned} invalid global persistent panels`);
  }

  // Clean up expired global panels
  const globalExpired = await cleanupExpiredPanels(client);
  if (globalExpired > 0) {
    console.log(`Cleaned up ${globalExpired} expired global persistent panels`);
  }


  console.log('Persistent panel migration complete');
}