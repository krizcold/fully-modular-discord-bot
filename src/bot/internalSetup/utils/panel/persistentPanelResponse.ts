/**
 * Persistent Panel Response Utilities
 */

import {
  Client,
  Message,
  TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  Colors,
  ButtonInteraction,
  CommandInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  InteractionResponse,
  MessageFlags,
} from 'discord.js';
import { PanelContext, PanelResponse, PanelOptions, PersistentPanelInstance } from '@bot/types/panelTypes';
import {
  getPersistentPanel,
  storePersistentPanel,
  removePersistentPanel,
  updatePersistentPanelState
} from './persistentPanelStorage';
import { injectReturnButtonIfNeeded } from './panelResponseUtils';
import { serializePanelResponse } from '../panelSerializer';
import { DISCORD_EPHEMERAL_FLAG } from '@bot/constants';

/**
 * Create a new persistent panel message
 */
export async function createPersistentPanel(
  context: PanelContext,
  panel: PanelOptions,
  response: PanelResponse,
  sessionId?: string
): Promise<Message | null> {
  if (!context.interaction || !context.interaction.channel) {
    console.error('Cannot create persistent panel without interaction or channel');
    return null;
  }

  try {
    const cleanedResponse = {
      ...response,
      flags: MessageFlags.IsComponentsV2 as number,
      ephemeral: undefined
    };

    const channel = context.interaction.channel;
    if (!channel || !('send' in channel)) {
      console.error('Cannot send persistent panel - invalid channel');
      return null;
    }

    const message = await channel.send(cleanedResponse);

    if (message && message instanceof Message) {
      const instance: PersistentPanelInstance = {
        messageId: message.id,
        channelId: message.channelId,
        userId: context.userId,
        guildId: context.guildId || undefined,
        createdAt: Date.now(),
        lastUpdated: Date.now(),
        state: 'active',
        sessionData: response,
        accessMethod: context.accessMethod
      };

      const result = await storePersistentPanel(
        panel.id,
        instance,
        context.guildId || undefined,
        sessionId,
        panel.maxActiveInstances
      );

      if (result.replacedInstance) {
        if (panel.unique) {
          // For unique panels, delete the old message entirely
          await deletePanelMessage(context.client, result.replacedInstance);
        } else {
          // For non-unique panels, just show error state
          await convertPanelToError(
            context.client,
            result.replacedInstance,
            'A new instance of this panel has been opened. This panel is now inactive.'
          );
        }
      }

      return message;
    }

    return null;
  } catch (error) {
    console.error('Error creating persistent panel:', error);
    return null;
  }
}

/**
 * Update existing persistent panel message
 */
export async function updatePersistentPanel(
  client: Client,
  panelId: string,
  response: PanelResponse | null,
  guildId?: string,
  sessionId?: string,
  newState?: string
): Promise<boolean> {
  // Skip update if response is null (e.g., message was deleted by handler)
  if (!response) {
    return true;
  }

  try {
    const instance = await getPersistentPanel(panelId, guildId, sessionId);
    if (!instance) {
      console.error(`Persistent panel not found: ${panelId}`);
      return false;
    }

    const channel = await client.channels.fetch(instance.channelId);
    if (!channel || !channel.isTextBased()) {
      console.error(`Channel not found or not text-based: ${instance.channelId}`);
      await removePersistentPanel(panelId, guildId, sessionId);
      return false;
    }

    const message = await (channel as TextChannel).messages.fetch(instance.messageId);
    if (!message) {
      console.error(`Message not found: ${instance.messageId}`);
      await removePersistentPanel(panelId, guildId, sessionId);
      return false;
    }

    const accessMethod = instance.accessMethod || 'direct_command';

    const injectionContext: PanelContext = {
      client,
      interaction: null,
      panelId,
      userId: instance.userId,
      guildId: instance.guildId || null,
      accessMethod,
      navigationStack: []
    };

    const injectedResponse = injectReturnButtonIfNeeded(response, injectionContext);

    const cleanedResponse = {
      ...injectedResponse,
      flags: MessageFlags.IsComponentsV2 as number,
      ephemeral: undefined
    };

    await message.edit(cleanedResponse);

    // Send IPC notification for Web-UI real-time update
    if (process.send) {
      try {
        const serialized = serializePanelResponse(injectedResponse);
        process.send({
          type: 'panel:live_update',
          data: {
            panelId,
            guildId: guildId || null,
            sessionId: sessionId || null,
            response: serialized
          }
        });
      } catch (ipcError) {
        console.error('[PersistentPanel] Error sending IPC live update:', ipcError);
      }
    }

    if (newState) {
      await updatePersistentPanelState(panelId, newState, guildId, sessionId);
    }

    instance.sessionData = response;
    instance.lastUpdated = Date.now();
    await storePersistentPanel(panelId, instance, guildId, sessionId);

    return true;
  } catch (error: any) {
    console.error('Error updating persistent panel:', error);

    if (error.code === 10008 || error.message?.includes('Unknown Message')) {
      await removePersistentPanel(panelId, guildId, sessionId);
    }

    return false;
  }
}

/**
 * Delete a persistent panel's Discord message
 * Used when a unique panel is replaced by a new instance
 */
export async function deletePanelMessage(
  client: Client,
  instance: PersistentPanelInstance
): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(instance.channelId);
    if (!channel || !channel.isTextBased()) {
      // Channel doesn't exist or isn't text-based - nothing to delete
      return true;
    }

    try {
      const message = await (channel as TextChannel).messages.fetch(instance.messageId);
      if (message) {
        await message.delete();
        console.log(`[PersistentPanel] Deleted old panel message: ${instance.messageId}`);
      }
    } catch (fetchError: any) {
      // Message already deleted or doesn't exist - that's fine
      if (fetchError.code === 10008) { // Unknown Message
        return true;
      }
      throw fetchError;
    }

    return true;
  } catch (error: any) {
    // Permission errors or other issues - log but don't fail
    if (error.code === 50013) { // Missing Permissions
      console.warn('[PersistentPanel] Missing permissions to delete old panel message');
    } else {
      console.error('[PersistentPanel] Error deleting panel message:', error);
    }
    return false;
  }
}

/**
 * Convert panel to error state (for non-unique panels or timeouts)
 */
export async function convertPanelToError(
  client: Client,
  instance: PersistentPanelInstance,
  errorMessage: string
): Promise<void> {
  try {
    const channel = await client.channels.fetch(instance.channelId);
    if (!channel || !channel.isTextBased()) {
      return;
    }

    const message = await (channel as TextChannel).messages.fetch(instance.messageId);
    if (!message) {
      return;
    }

    const errorEmbed = new EmbedBuilder()
      .setTitle('⚠️ Panel Inactive')
      .setDescription(errorMessage)
      .setColor(Colors.Red)
      .setTimestamp()
      .setFooter({ text: 'This panel is no longer active' });

    await message.edit({
      embeds: [errorEmbed],
      components: []
    });
  } catch (error) {
    console.error('Error converting panel to error state:', error);
  }
}

/**
 * Get or create persistent panel
 */
export async function getOrCreatePersistentPanel(
  context: PanelContext,
  panel: PanelOptions,
  response: PanelResponse,
  sessionId?: string
): Promise<{ message: Message | null; isNew: boolean }> {
  const existing = await getPersistentPanel(
    panel.id,
    context.guildId || undefined,
    sessionId
  );

  if (existing) {
    try {
      const channel = await context.client.channels.fetch(existing.channelId);
      if (channel && channel.isTextBased()) {
        const message = await (channel as TextChannel).messages.fetch(existing.messageId);
        if (message) {
          await updatePersistentPanel(
            context.client,
            panel.id,
            response,
            context.guildId || undefined,
            sessionId
          );
          return { message, isNew: false };
        }
      }
    } catch (error) {
      console.error('Existing persistent panel message not found, creating new one');
    }
  }

  const message = await createPersistentPanel(context, panel, response, sessionId);
  return { message, isNew: true };
}

/**
 * Handle persistent panel button
 */
export async function handlePersistentPanelButton(
  context: PanelContext,
  panel: PanelOptions,
  buttonId: string,
  sessionId?: string
): Promise<PanelResponse | null> {
  if (!panel.handleButton) {
    console.error(`Panel ${panel.id} does not have a button handler`);
    return null;
  }

  let response = await panel.handleButton(context, buttonId);

  // If handler returned null, it handled the interaction directly (e.g., file download)
  if (response === null) {
    return null;
  }

  response = injectReturnButtonIfNeeded(response, context);

  if (panel.persistent) {
    const updated = await updatePersistentPanel(
      context.client,
      panel.id,
      response,
      context.guildId || undefined,
      sessionId
    );

    if (!updated) {
      console.error(`Failed to update persistent panel ${panel.id}`);
    }
  }

  return response;
}

/**
 * Handle persistent panel modal
 */
export async function handlePersistentPanelModal(
  context: PanelContext,
  panel: PanelOptions,
  modalId: string,
  sessionId?: string
): Promise<PanelResponse | null> {
  if (!panel.handleModal) {
    console.error(`Panel ${panel.id} does not have a modal handler`);
    return null;
  }

  let response = await panel.handleModal(context, modalId);

  response = injectReturnButtonIfNeeded(response, context);

  if (panel.persistent) {
    const updated = await updatePersistentPanel(
      context.client,
      panel.id,
      response,
      context.guildId || undefined,
      sessionId
    );

    if (!updated) {
      console.error(`Failed to update persistent panel ${panel.id} after modal`);
    }
  }

  return response;
}

/**
 * Clean up persistent panel
 */
export async function cleanupPersistentPanel(
  client: Client,
  panelId: string,
  guildId?: string,
  sessionId?: string,
  reason: string = 'Panel timed out'
): Promise<void> {
  const instance = await getPersistentPanel(panelId, guildId, sessionId);
  if (instance) {
    await convertPanelToError(client, instance, reason);
    await removePersistentPanel(panelId, guildId, sessionId);
  }
}

/**
 * Check if panel should be persistent
 */
export function shouldBePersistent(
  panel: PanelOptions,
  context: PanelContext
): boolean {
  if (!panel.persistent) {
    return false;
  }

  if (context.accessMethod === 'web_ui') {
    return false;
  }

  return true;
}

/**
 * Broadcast panel update to Web-UI clients via IPC
 * Use this when you need to update Web-UI without a Discord message
 */
export function broadcastPanelUpdate(
  panelId: string,
  response: PanelResponse,
  guildId?: string,
  sessionId?: string
): void {
  if (!process.send) {
    return;
  }

  try {
    const serialized = serializePanelResponse(response);

    process.send({
      type: 'panel:live_update',
      data: {
        panelId,
        guildId: guildId || null,
        sessionId: sessionId || null,
        response: serialized
      }
    });
  } catch (error) {
    console.error('[PersistentPanel] Error broadcasting panel update:', error);
  }
}

/**
 * Update panel dynamically based on access method
 * - Web-UI: Broadcasts via IPC only (no Discord message)
 * - Discord: Updates persistent panel message + broadcasts via IPC
 */
export async function updatePanelDynamic(
  context: PanelContext,
  panelId: string,
  response: PanelResponse,
  sessionId?: string
): Promise<boolean> {
  // Inject return button if needed
  const injectedResponse = injectReturnButtonIfNeeded(response, context);

  if (context.accessMethod === 'web_ui') {
    // Web-UI: Just broadcast, no Discord message to update
    broadcastPanelUpdate(panelId, injectedResponse, context.guildId || undefined, sessionId);
    return true;
  }

  // Discord: Update the persistent panel message (which also broadcasts)
  return await updatePersistentPanel(
    context.client,
    panelId,
    response,  // Don't pass injected - updatePersistentPanel does its own injection
    context.guildId || undefined,
    sessionId
  );
}