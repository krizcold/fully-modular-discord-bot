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
import { storeNavigationContext } from './panelButtonHandler';
import { PanelResponse } from '@bot/types/panelTypes';
import { getBotUpdateStatus, checkForBotUpdates } from '../yunderaAPI';

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
 * Helper: Format date as "day month, year" (e.g., "1 December 2025")
 */
function formatDate(dateInput: string | number | undefined): string {
  if (!dateInput) return 'Unknown';
  const date = new Date(dateInput);
  if (isNaN(date.getTime())) return 'Unknown';

  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];

  return `${date.getDate()} ${months[date.getMonth()]}, ${date.getFullYear()}`;
}

/**
 * Helper: Build standard action buttons
 */
function buildRecoveryButtons(disabled: boolean = false): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('panel_update_manager_btn_architecture')
        .setLabel('🔄 Architecture')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('panel_update_manager_btn_keep_custom')
        .setLabel('🔄 Keep custom')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('panel_update_manager_btn_everything')
        .setLabel('🔄 Everything')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    );

  const row2 = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('panel_update_manager_btn_check_updates')
        .setLabel('🔍 Check Updates')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('panel_update_manager_btn_information')
        .setLabel('ℹ️ Information')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('panel_update_manager_btn_close')
        .setLabel('❌ Close')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled)
    );

  return [row1, row2];
}

/**
 * Build recovery panel response
 */
async function buildRecoveryResponse(
  client: Client,
  instance: any,
  state: 'checking' | 'result' | 'error',
  updateCheck?: any
): Promise<PanelResponse> {
  const status = getBotUpdateStatus();
  const storedData = instance.sessionData || {};

  let statusDisplay = '🟢 Ready';
  let color = 0x3498DB;

  if (state === 'checking') {
    statusDisplay = '🟡 Checking...';
    color = 0xF1C40F;
  } else if (state === 'error' || (updateCheck && !updateCheck.success)) {
    statusDisplay = '🔴 Error';
    color = 0xE74C3C;
  } else if (updateCheck?.hasUpdates) {
    statusDisplay = '🟠 Updates Available';
    color = 0xE67E22;
  } else if (updateCheck) {
    statusDisplay = '🟢 Up to Date';
    color = 0x2ECC71;
  }

  let detailsContent = 'No details available';
  if (state === 'checking') {
    detailsContent = 'Connecting to update server...\nFetching latest version information...\nComparing versions...';
  } else if (updateCheck) {
    if (!updateCheck.success && updateCheck.error) {
      detailsContent = `Error: ${updateCheck.error}\n\nPlease check:\n- API configuration\n- Network connectivity`;
    } else if (updateCheck.hasUpdates) {
      detailsContent = `Commits behind: ${updateCheck.commitsBehind || 'Unknown'}\n` +
                       `Current: ${formatDate(updateCheck.currentVersionDate)}\n` +
                       `Latest: ${formatDate(updateCheck.latestVersionDate)}`;
    } else {
      detailsContent = `Current: ${formatDate(updateCheck.currentVersionDate)}\n` +
                       `Latest: ${formatDate(updateCheck.latestVersionDate)}\n` +
                       `No updates available`;
    }
  }

  const releaseDate = updateCheck?.latestVersionDate || storedData.latestVersionDate;

  let footerText = 'Update Manager';
  let footerIcon: string | undefined;

  if (instance.userId) {
    try {
      const user = await client.users.fetch(instance.userId);
      if (user) {
        footerText = `Opened by ${user.username}`;
        footerIcon = user.displayAvatarURL();
      }
    } catch (e) {}
  }

  const embed = new EmbedBuilder()
    .setTitle('Bot Update Manager')
    .setColor(color)
    .addFields(
      { name: 'Status', value: statusDisplay, inline: true },
      { name: 'Mode', value: status.mode || 'None', inline: true },
      { name: 'Last Check', value: status.lastCheck ? formatDate(status.lastCheck) : 'Never', inline: true },
      { name: 'Release Date', value: releaseDate ? formatDate(releaseDate) : 'Unknown', inline: true },
      { name: 'Details', value: `\`\`\`\n${detailsContent}\n\`\`\``, inline: false }
    )
    .setFooter(footerIcon ? { text: footerText, iconURL: footerIcon } : { text: footerText })
    .setTimestamp();

  return {
    embeds: [embed],
    components: buildRecoveryButtons(state === 'checking')
  };
}

/**
 * Recover UPDATE panel after bot restart
 */
async function recoverUpdatePanel(
  client: Client,
  instance: any
): Promise<void> {
  if (!instance.messageId || !instance.channelId) {
    return;
  }

  const guildId = instance.guildId;

  // Try to fetch channel
  let channel;
  try {
    channel = await client.channels.fetch(instance.channelId);
  } catch (error: any) {
    if (error.code === 10003) {
      // Unknown Channel - panel message no longer exists, clean up storage
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

  // Try to fetch message
  let message;
  try {
    message = await (channel as TextChannel).messages.fetch(instance.messageId);
  } catch (error: any) {
    if (error.code === 10008) {
      // Unknown Message - panel message was deleted, clean up storage
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

  // Message exists, proceed with recovery
  const checkingResponse = await buildRecoveryResponse(client, instance, 'checking');
  await message.edit(checkingResponse);

  const accessMethod = instance.accessMethod || 'direct_command';
  storeNavigationContext(message.id, [], accessMethod);

  console.log(`[PersistentPanelRecovery] Recovered UPDATE panel (accessMethod: ${accessMethod}), triggering auto-check...`);

  setImmediate(async () => {
    try {
      const updateCheck = await checkForBotUpdates();

      const resultResponse = await buildRecoveryResponse(
        client,
        instance,
        updateCheck?.success ? 'result' : 'error',
        updateCheck || { success: false, error: 'Failed to check for updates', hasUpdates: false }
      );

      await message.edit(resultResponse);

      await updatePersistentPanelState('update_manager', 'recovered', instance.guildId, undefined, {
        latestVersionDate: updateCheck?.latestVersionDate,
        currentVersionDate: updateCheck?.currentVersionDate,
        lastCheckResult: updateCheck
      });

      console.log(`[PersistentPanelRecovery] UPDATE panel auto-check complete`);
    } catch (error) {
      console.error('[PersistentPanelRecovery] Error during auto-check:', error);

      const errorResponse = await buildRecoveryResponse(client, instance, 'error', {
        success: false,
        error: 'Error checking for updates',
        hasUpdates: false
      });

      try {
        await message.edit(errorResponse);
      } catch (e) {
        console.error('[PersistentPanelRecovery] Failed to update panel with error:', e);
      }
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