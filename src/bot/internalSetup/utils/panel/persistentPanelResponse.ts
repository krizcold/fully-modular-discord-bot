/**
 * Persistent Panel Response Utilities
 */

import {
  Client,
  Message,
  TextChannel,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
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
import { answerWrites, writesConfirmed } from '../dataBackends/replyGate';
import { noteConsoleOutcome } from '../consoleInteraction';
import {
  createTitledContainer,
  createText,
  V2Colors,
} from './v2';

export type PanelEditOutcome = 'edited' | 'gone' | 'refused';

const GONE_CODES = new Set([10003, 10008]);
const REFUSED_CODES = new Set([50001, 50013]);

/**
 * Edit (or delete) a stored panel message by its id, with no read of the message first. A missing channel or message
 * answers 'gone'; a missing permission answers 'refused' and is logged by name, leaving the caller to keep the record.
 */
export async function editPanelMessageById(
  client: Client,
  instance: Pick<PersistentPanelInstance, 'channelId' | 'messageId'>,
  payload: any | null
): Promise<PanelEditOutcome> {
  try {
    const channel = await client.channels.fetch(instance.channelId);
    if (!channel || !channel.isTextBased()) return 'gone';
    if (payload === null) await (channel as TextChannel).messages.delete(instance.messageId);
    else await (channel as TextChannel).messages.edit(instance.messageId, payload);
    return 'edited';
  } catch (error: any) {
    if (GONE_CODES.has(error?.code)) return 'gone';
    if (REFUSED_CODES.has(error?.code)) {
      const missing = error.code === 50001 ? 'View Channel' : 'the permission to edit or delete its own message';
      console.warn(`[PersistentPanel] Panel message ${instance.messageId} in channel ${instance.channelId} was not changed: the bot lacks ${missing}. The record is kept.`);
      return 'refused';
    }
    throw error;
  }
}

/**
 * Show the inactive view on, or delete, a panel message a newer instance replaced.
 */
export async function retireReplacedPanel(
  client: Client,
  panel: PanelOptions,
  replaced: PersistentPanelInstance
): Promise<void> {
  if (panel.unique) await deletePanelMessage(client, replaced);
  else await convertPanelToError(client, replaced, 'A new instance of this panel has been opened. This panel is now inactive.');
}

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

    // Posted only once the callback's writes are confirmed. When they are not by the ack deadline, the panel is not
    // posted: the caller's own response then carries the truth, or the view if the writes land by its own confirm.
    // The console's answer says so, since no success may cover a missing post.
    if (!(await writesConfirmed(context.interaction))) {
      console.warn(`[PersistentPanel] Panel ${panel.id} was not posted: the writes its callback made are not confirmed`);
      noteConsoleOutcome(context.interaction, { refusal: 'the panel was not posted: its writes were not confirmed in time' });
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

      if (!result.success) {
        console.error(`[PersistentPanels] The record for panel ${panel.id} was not saved; removing the new message and keeping the previous instance`);
        const removed = await deletePanelMessage(context.client, instance);
        throw new PanelNotRecordedError(removed);
      }

      if (result.replacedInstance && result.replacedInstance.messageId !== message.id) {
        await retireReplacedPanel(context.client, panel, result.replacedInstance);
      }

      return message;
    }

    return null;
  } catch (error) {
    if (error instanceof PanelNotRecordedError) throw error;
    console.error('Error creating persistent panel:', error);
    return null;
  }
}

export class PanelNotRecordedError extends Error {
  constructor(messageRemoved = true) {
    super(messageRemoved
      ? "The panel's record could not be saved, so the panel was not opened. Try again shortly."
      : "The panel's record could not be saved, and its new message could not be removed; that message will not work. Delete it and try again shortly.");
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
  newState?: string,
  originMessageId?: string
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

    if (originMessageId && instance.messageId !== originMessageId) {
      console.warn(`[PersistentPanel] Result for panel ${panelId} dropped: it started on message ${originMessageId}, which is no longer the panel's message`);
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

    const outcome = await editPanelMessageById(client, instance, cleanedResponse);
    if (outcome === 'gone') {
      console.error(`Panel message not found: ${instance.messageId}`);
      const current = await getPersistentPanel(panelId, guildId, sessionId);
      if (current?.messageId === instance.messageId) await removePersistentPanel(panelId, guildId, sessionId);
      return false;
    }
    if (outcome === 'refused') return false;

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

    const current = await getPersistentPanel(panelId, guildId, sessionId);
    if (current?.messageId === instance.messageId) {
      instance.sessionData = response;
      instance.lastUpdated = Date.now();
      await storePersistentPanel(panelId, instance, guildId, sessionId);
    }

    return true;
  } catch (error: any) {
    console.error('Error updating persistent panel:', error);
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
    const outcome = await editPanelMessageById(client, instance, null);
    if (outcome === 'edited') console.log(`[PersistentPanel] Deleted old panel message: ${instance.messageId}`);
    return outcome !== 'refused';
  } catch (error) {
    console.error('[PersistentPanel] Error deleting panel message:', error);
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
    // V2-native edit: the persistent panel was originally posted with the
    // IsComponentsV2 flag, and Discord rejects edits that try to remove
    // that flag. Build the inactive-state notice as a V2 container.
    const container = createTitledContainer('⚠️ Panel Inactive', undefined, V2Colors.danger);
    container.addTextDisplayComponents(createText(errorMessage));
    container.addTextDisplayComponents(createText('-# This panel is no longer active'));

    await editPanelMessageById(client, instance, {
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      embeds: [],
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

  // The shared message shows the handler's writes only once they are confirmed; otherwise the member has the truth.
  // A modal is the member's own response, not a view of the panel: it leaves the shared message as it was.
  if (panel.persistent && !response.modal && await answerWrites(context.interaction)) {
    const updated = await updatePersistentPanel(
      context.client,
      panel.id,
      response,
      context.guildId || undefined,
      sessionId,
      undefined,
      (context.interaction as any)?.message?.id
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

  if (panel.persistent && await answerWrites(context.interaction)) {
    const updated = await updatePersistentPanel(
      context.client,
      panel.id,
      response,
      context.guildId || undefined,
      sessionId,
      undefined,
      (context.interaction as any)?.message?.id
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
  sessionId?: string,
  originMessageId?: string
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
    sessionId,
    undefined,
    originMessageId ?? (context.interaction as any)?.message?.id
  );
}