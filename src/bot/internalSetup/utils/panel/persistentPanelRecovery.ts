/**
 * Persistent Panel Recovery System
 */

import { Client, TextChannel, EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import {
  loadPersistentPanels,
  getPersistentPanel,
  updatePersistentPanelState,
  getAllPersistentPanels,
  removePersistentPanel
} from './persistentPanelStorage';
import { updatePersistentPanel } from './persistentPanelResponse';
import { updatePanelDynamic } from './persistentPanelResponse';
import { storeNavigationContext } from './panelButtonHandler';
import { PanelResponse, PanelContext } from '@bot/types/panelTypes';
import { getBotUpdateStatus, checkForBotUpdates, checkForAllBotUpdates } from '../botManagerAPI';
import { buildPanelView } from '../../panels/updateManager';

/**
 * Recover persistent panels after bot restart
 */
export async function recoverPersistentPanels(client: Client): Promise<void> {
  console.log('[PersistentPanelRecovery] Starting panel recovery...');

  try {
    await recoverPanelsForScope(client);

    for (const [guildId, guild] of client.guilds.cache) {
      await recoverPanelsForScope(client, guildId);
    }

    console.log('[PersistentPanelRecovery] Panel recovery complete');
  } catch (error) {
    console.error('[PersistentPanelRecovery] Error during recovery:', error);
  }
}

/**
 * Recover panels for scope
 */
async function recoverPanelsForScope(client: Client, guildId?: string): Promise<void> {
  const storage = await loadPersistentPanels(guildId);

  for (const [panelId, data] of Object.entries(storage)) {
    try {
      if (panelId === 'update_manager') {
        await recoverUpdatePanel(client, data as any);
      }
      else {
        await recoverGenericPanel(client, panelId, data, guildId);
      }
    } catch (error) {
      console.error(`[PersistentPanelRecovery] Error recovering panel ${panelId}:`, error);
    }
  }
}

/**
 * Recover UPDATE panel after bot restart.
 * Reuses the live panel's buildPanelView so the recovered message
 * matches the current V2 component format exactly.
 */
async function recoverUpdatePanel(
  client: Client,
  instance: any
): Promise<void> {
  if (!instance.messageId || !instance.channelId) {
    return;
  }

  const guildId = instance.guildId;

  let channel;
  try {
    channel = await client.channels.fetch(instance.channelId);
  } catch (error: any) {
    if (error.code === 10003) {
      console.log('[PersistentPanelRecovery] UPDATE panel channel no longer exists, removing from storage');
      await removePersistentPanel('update_manager', guildId);
      return;
    }
    throw error;
  }

  if (!channel || !channel.isTextBased()) {
    console.log('[PersistentPanelRecovery] UPDATE panel channel invalid, removing from storage');
    await removePersistentPanel('update_manager', guildId);
    return;
  }

  let message;
  try {
    message = await (channel as TextChannel).messages.fetch(instance.messageId);
  } catch (error: any) {
    if (error.code === 10008) {
      console.log('[PersistentPanelRecovery] UPDATE panel message no longer exists, removing from storage');
      await removePersistentPanel('update_manager', guildId);
      return;
    }
    throw error;
  }

  if (!message) {
    console.log('[PersistentPanelRecovery] UPDATE panel message not found, removing from storage');
    await removePersistentPanel('update_manager', guildId);
    return;
  }

  const accessMethod = instance.accessMethod || 'direct_command';
  storeNavigationContext(message.id, [], accessMethod);

  const context: PanelContext = {
    client,
    interaction: null,
    panelId: 'update_manager',
    userId: instance.userId || '',
    guildId: guildId || '',
    accessMethod,
    navigationStack: []
  };

  console.log('[PersistentPanelRecovery] Recovered UPDATE panel, triggering auto-check...');

  setImmediate(async () => {
    try {
      const combinedCheck = await checkForAllBotUpdates();
      const response = buildPanelView(context, 'main', combinedCheck || {
        success: false,
        lastChecked: new Date().toISOString(),
        baseCode: { checked: false, hasUpdates: false, error: 'Failed to check for updates' },
        modules: { checked: false, hasUpdates: false, totalInstalled: 0, updatesAvailable: 0, updates: [], errors: [] },
        summary: { totalUpdatesAvailable: 0, hasAnyUpdates: false }
      });

      await updatePanelDynamic(context, 'update_manager', response);

      await updatePersistentPanelState('update_manager', 'recovered', guildId, undefined, {
        lastCheckResult: combinedCheck
      });

      console.log('[PersistentPanelRecovery] UPDATE panel auto-check complete');
    } catch (error) {
      console.error('[PersistentPanelRecovery] Error during auto-check:', error);
    }
  });
}

/**
 * Recover generic persistent panel
 */
async function recoverGenericPanel(
  client: Client,
  panelId: string,
  data: any,
  guildId?: string
): Promise<void> {
  if (data.sessions) {
    for (const [sessionId, instance] of Object.entries(data.sessions)) {
      await recoverPanelInstance(client, panelId, instance as any, guildId, sessionId);
    }
  }
  else if (data.messageId) {
    await recoverPanelInstance(client, panelId, data, guildId);
  }
}

/**
 * Recover panel instance
 */
async function recoverPanelInstance(
  client: Client,
  panelId: string,
  instance: any,
  guildId?: string,
  sessionId?: string
): Promise<void> {
  // Try to fetch channel
  let channel;
  try {
    channel = await client.channels.fetch(instance.channelId);
  } catch (error: any) {
    if (error.code === 10003) {
      // Unknown Channel - remove stored panel
      await removePersistentPanel(panelId, guildId, sessionId);
      return;
    }
    throw error;
  }

  if (!channel || !channel.isTextBased()) {
    await removePersistentPanel(panelId, guildId, sessionId);
    return;
  }

  // Try to fetch message
  let message;
  try {
    message = await (channel as TextChannel).messages.fetch(instance.messageId);
  } catch (error: any) {
    if (error.code === 10008) {
      // Unknown Message - remove stored panel
      await removePersistentPanel(panelId, guildId, sessionId);
      return;
    }
    throw error;
  }

  if (!message) {
    await removePersistentPanel(panelId, guildId, sessionId);
    return;
  }

  // Update embed footer to show recovery
  const embed = message.embeds[0];
  if (embed) {
    const recoveredEmbed = EmbedBuilder.from(embed)
      .setFooter({
        text: `Panel recovered after bot restart | ${embed.footer?.text || ''}`.trim()
      });

    await message.edit({
      embeds: [recoveredEmbed],
      components: message.components
    });
  }

  const accessMethod = instance.accessMethod || 'direct_command';
  storeNavigationContext(message.id, [], accessMethod);

  console.log(`[PersistentPanelRecovery] Recovered panel ${panelId}${sessionId ? ` (session: ${sessionId})` : ''} (accessMethod: ${accessMethod})`);
}

/**
 * Check if panel needs recovery
 */
export async function needsRecovery(panelId: string, guildId?: string): Promise<boolean> {
  const instances = await getAllPersistentPanels(panelId, guildId);

  for (const instance of instances) {
    if (instance.state && ['updating', 'update_triggered', 'checking_updates'].includes(instance.state)) {
      return true;
    }
  }

  return false;
}

/**
 * Mark all panels as recovered
 */
export async function markAllPanelsRecovered(client: Client): Promise<void> {
  console.log('[PersistentPanelRecovery] Marking all panels as recovered');
}