// The panel handlers' auto-defer (R13-J9). A panel handler may answer with a modal, which must be the interaction's
// first response, so it cannot defer at once; a slow handler is acknowledged 2.5 s from the interaction's emit, the
// window it had from its own start before the hold, so a press held and then admitted is acknowledged before
// Discord's 3 s run out.

import { DiscordAPIError, MessageFlags, RESTJSONErrorCodes } from 'discord.js';
import { ledgerOf } from '../dataBackends/writeLedger';

const AUTO_DEFER_MS = 2500;

/** From the interaction's emit; with no ledger (no real interaction), from the handler's start. */
function dueIn(interaction: any): number {
  const openedAt = ledgerOf(interaction)?.openedAt;
  return openedAt === undefined ? AUTO_DEFER_MS : Math.max(0, openedAt + AUTO_DEFER_MS - performance.now());
}

/** The member's text when a handler's modal came after the acknowledgement, which a modal can never follow. */
export const LATE_FORM_TEXT = 'This took too long to open its form; please try again.';

/**
 * Runs the handler against the auto-defer. expired: Discord no longer knew the interaction when it was acknowledged,
 * so nothing more can be sent; the handler's action ran all the same.
 */
export async function withAutoDefer<T>(interaction: any, handler: Promise<T>): Promise<{ response: T; expired: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const due = new Promise<'due'>(resolve => {
    timer = setTimeout(() => resolve('due'), dueIn(interaction));
  });
  const first = await Promise.race([handler.then(response => ({ response })), due]);
  clearTimeout(timer);
  if (first !== 'due') return { response: first.response, expired: false };
  let expired = false;
  try {
    await acknowledgeIfNone(interaction);
  } catch (error) {
    if (!(error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownInteraction)) throw error;
    expired = true;
  }
  return { response: await handler, expired };
}

// The reply gate shows its own acknowledgements in these flags from the moment they are due (replyGate.ts, the intent
// flags), so this one is never a second. An update on a component's message, else an ephemeral deferral, as the gate
// acknowledges.
async function acknowledgeIfNone(interaction: any): Promise<void> {
  if (interaction.deferred || interaction.replied) return;
  if (interaction.message) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
}

/** A modal that came after the acknowledgement: the member is told to try again instead of seeing nothing. */
export async function tellLateForm(interaction: any, where: string): Promise<void> {
  console.warn(`[${where}] Cannot show modal after deferring for: ${interaction.customId}`);
  await interaction.followUp({ content: LATE_FORM_TEXT, flags: MessageFlags.Ephemeral }).catch((error: unknown) => {
    console.warn(`[${where}] Could not tell the member the form came too late:`, error);
  });
}
