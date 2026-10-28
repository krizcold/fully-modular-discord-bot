/**
 * Persistent Panel Storage System
 */

import * as fs from 'fs';
import * as path from 'path';
import { Client, TextChannel } from 'discord.js';
import {
  areGuildWritesClosed,
  isClosedForExit,
  loadGlobalModuleData,
  loadModuleData,
  updateGlobalModuleData,
  updateModuleData,
} from '../dataManager';
import { getPending } from '../dataBackends/fileBackend';
import { PersistentPanelInstance } from '@bot/types/panelTypes';
import { DATA_ROOT } from '../../../../utils/dataRoot';
import { resolveDataBackend } from '../../../../utils/envLoader';

const STORAGE_FILE = 'persistent-panels.json';
const STORAGE_NAMESPACE = '_panels';

function readPanels(guildId?: string): any {
  const data = guildId
    ? loadModuleData<any>(STORAGE_FILE, guildId, STORAGE_NAMESPACE, {})
    : loadGlobalModuleData<any>(STORAGE_FILE, STORAGE_NAMESPACE, {});
  return data && typeof data === 'object' ? data : {};
}

/**
 * Load persistent panel data from the guild's data (global when no guild)
 */
export async function loadPersistentPanels(guildId?: string): Promise<any> {
  return readPanels(guildId);
}

/**
 * Moves a panel registry file that exists on disk, has no queued write and does not parse (an empty file included)
 * aside, so the update that follows starts from no records instead of being refused. A file that cannot be read stays
 * where it is. A guild served by Postgres has no file here, so its unparsable document stays refused. Nothing moves
 * once the exit drain has closed writes, or, for a guild, while guild writes are closed.
 */
function moveUnparsableAside(guildId: string | undefined): void {
  if (isClosedForExit() || (guildId && areGuildWritesClosed())) return;
  if (guildId && resolveDataBackend() === 'postgres') return;
  const file = path.join(DATA_ROOT, guildId ?? 'global', STORAGE_NAMESPACE, STORAGE_FILE);
  if (getPending(file)) return;
  let bytes: string;
  try {
    bytes = fs.readFileSync(file, 'utf-8');
  } catch {
    return;
  }
  try {
    JSON.parse(bytes);
    return;
  } catch {}
  const aside = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, aside);
  } catch (error) {
    console.error(`[Panels] The panel registry ${file} does not parse and could not be moved aside:`, error);
    return;
  }
  console.error(`[Panels] The panel registry ${file} did not parse; it was moved to ${aside} and panels start from no records`);
}

/**
 * Change the stored panel records in one update: change edits the records it is handed, which are the stored ones
 * at that moment. False when the write was not accepted.
 */
function updatePanels(guildId: string | undefined, change: (storage: any) => void): boolean {
  const apply = (current: any) => {
    const storage = current && typeof current === 'object' ? current : {};
    change(storage);
    return storage;
  };
  try {
    moveUnparsableAside(guildId);
    const result = guildId
      ? updateModuleData(STORAGE_FILE, guildId, STORAGE_NAMESPACE, {}, apply)
      : updateGlobalModuleData(STORAGE_FILE, STORAGE_NAMESPACE, {}, apply);
    if (result.outcome !== 'saved') console.error(`[PersistentPanels] Panel records for ${guildId ?? 'global'} were not saved`);
    return result.outcome === 'saved';
  } catch (error) {
    console.error(`[PersistentPanels] Panel records for ${guildId ?? 'global'} were not saved:`, error);
    return false;
  }
}

function findInstance(storage: any, panelId: string, sessionId?: string): PersistentPanelInstance | null {
  const panelData = storage[panelId];
  if (!panelData) return null;
  if (sessionId && typeof panelData === 'object' && 'sessions' in panelData) return panelData.sessions[sessionId] || null;
  if (typeof panelData === 'object' && 'messageId' in panelData) return panelData;
  return null;
}

/** Removes one panel instance (only while it is still messageId, when given); true when it removed one. */
function removeFrom(storage: any, panelId: string, sessionId?: string, messageId?: string): boolean {
  const panelData = storage[panelId];
  if (!panelData) return false;
  if (sessionId) {
    if (typeof panelData !== 'object' || !('sessions' in panelData)) return false;
    const sessions = panelData.sessions;
    const session = sessions[sessionId];
    if (!session || (messageId !== undefined && session.messageId !== messageId)) return false;
    delete sessions[sessionId];
    if (Object.keys(sessions).length === 0) delete storage[panelId];
    return true;
  }
  if (messageId !== undefined && panelData.messageId !== messageId) return false;
  delete storage[panelId];
  return true;
}

/**
 * Get a specific persistent panel instance
 */
export async function getPersistentPanel(
  panelId: string,
  guildId?: string,
  sessionId?: string
): Promise<PersistentPanelInstance | null> {
  return findInstance(readPanels(guildId), panelId, sessionId);
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
  let replacedInstance: PersistentPanelInstance | undefined;

  const saved = updatePanels(guildId, storage => {
    if (sessionId) {
      if (!storage[panelId] || typeof storage[panelId] !== 'object' || !('sessions' in storage[panelId])) {
        storage[panelId] = { sessions: {} };
      }
      storage[panelId].sessions[sessionId] = {
        ...instance,
        lastUpdated: Date.now()
      };
      return;
    }
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
  });

  if (!saved) {
    return { success: false };
  }

  return { success: true, replacedInstance };
}

/**
 * Update a persistent panel's state, only while its stored instance is still the given message
 */
export async function updatePersistentPanelState(
  panelId: string,
  state: string,
  messageId: string,
  guildId?: string,
  sessionId?: string,
  additionalData?: any
): Promise<boolean> {
  const current = (storage: any) => {
    const instance = findInstance(storage, panelId, sessionId);
    return instance?.messageId === messageId ? instance : null;
  };
  if (!current(readPanels(guildId))) {
    return false;
  }

  return updatePanels(guildId, storage => {
    const instance = current(storage);
    if (!instance) return;
    instance.state = state;
    instance.lastUpdated = Date.now();
    if (additionalData) {
      instance.sessionData = { ...instance.sessionData, ...additionalData };
    }
  });
}

/**
 * Record a panel's latest response on its stored instance, only while that instance is still the given message
 */
export async function recordPersistentPanelResponse(
  panelId: string,
  sessionData: any,
  messageId: string,
  guildId?: string,
  sessionId?: string
): Promise<boolean> {
  const current = (storage: any) => {
    const instance = findInstance(storage, panelId, sessionId);
    return instance?.messageId === messageId ? instance : null;
  };
  if (!current(readPanels(guildId))) {
    return false;
  }

  return updatePanels(guildId, storage => {
    const instance = current(storage);
    if (!instance) return;
    instance.sessionData = sessionData;
    instance.lastUpdated = Date.now();
  });
}

/**
 * Remove a persistent panel instance; with messageId, only while the stored instance is still that message
 */
export async function removePersistentPanel(
  panelId: string,
  guildId?: string,
  sessionId?: string,
  messageId?: string
): Promise<boolean> {
  if (!removeFrom(readPanels(guildId), panelId, sessionId, messageId)) {
    return false;
  }

  return updatePanels(guildId, storage => { removeFrom(storage, panelId, sessionId, messageId); });
}

const PANEL_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Removes the sessions not updated for a day, and panels left with none; returns how many sessions it removed. */
function removeExpired(storage: any, now: number): number {
  let cleanedCount = 0;
  for (const panelId in storage) {
    const panelData = storage[panelId];
    if (typeof panelData === 'object' && 'sessions' in panelData) {
      const sessions = panelData.sessions;
      for (const sessionId in sessions) {
        if (now - sessions[sessionId].lastUpdated > PANEL_EXPIRY_MS) {
          delete sessions[sessionId];
          cleanedCount++;
        }
      }
      if (Object.keys(sessions).length === 0) {
        delete storage[panelId];
      }
    }
  }
  return cleanedCount;
}

/**
 * Clean up expired persistent panels
 */
export async function cleanupExpiredPanels(client: Client, guildId?: string): Promise<number> {
  const now = Date.now();
  if (removeExpired(readPanels(guildId), now) === 0) {
    return 0;
  }

  let cleanedCount = 0;
  const saved = updatePanels(guildId, storage => { cleanedCount = removeExpired(storage, now); });
  return saved ? cleanedCount : 0;
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
  const storage = readPanels(guildId);
  const invalid: { panelId: string; sessionId?: string; messageId: string }[] = [];

  for (const panelId in storage) {
    const panelData = storage[panelId];
    if (typeof panelData === 'object' && 'sessions' in panelData) {
      for (const sessionId in panelData.sessions) {
        const session = panelData.sessions[sessionId];
        if (!(await validatePersistentPanel(client, session))) invalid.push({ panelId, sessionId, messageId: session.messageId });
      }
    } else if (typeof panelData === 'object' && 'messageId' in panelData) {
      if (!(await validatePersistentPanel(client, panelData))) invalid.push({ panelId, messageId: panelData.messageId });
    }
  }

  if (invalid.length === 0) {
    return 0;
  }

  // A panel stored again on a new message while its old one was checked is kept.
  let cleanedCount = 0;
  const saved = updatePanels(guildId, current => {
    cleanedCount = invalid.filter(entry => removeFrom(current, entry.panelId, entry.sessionId, entry.messageId)).length;
  });
  return saved ? cleanedCount : 0;
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