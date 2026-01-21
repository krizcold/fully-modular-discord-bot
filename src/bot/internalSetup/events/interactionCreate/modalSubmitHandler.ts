import { Client, Interaction, ModalSubmitInteraction, MessageFlags } from 'discord.js';
import { RegisteredModalInfo } from '../../../types/commandTypes'; // Import type

/**
 * Handles incoming modal submit interactions using the map attached to the client.
 * Supports exact customId matches and then prefix-based matches.
 */
async function handleModalSubmit(client: Client, interaction: Interaction) {
  // Check if it's a ModalSubmit interaction
  if (!interaction.isModalSubmit()) {
    return;
  }

  // --- Use client.modalHandlers ---
  const registeredModals = client.modalHandlers;
  if (!registeredModals || registeredModals.size === 0) {
    console.error("[handleModalSubmit] client.modalHandlers map not found or is empty!");
    try {
      // Modals always allow replying
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'An internal error occurred (Modal map missing/empty).', flags: MessageFlags.Ephemeral });
      }
    } catch (replyError) {
      console.error("Failed to send error reply for missing modal map:", replyError);
    }
    return;
  }

  const incomingCustomId = interaction.customId;
  let modalInfo: RegisteredModalInfo | undefined = undefined;
  let matchedKey: string | undefined = undefined;

  // 1. Check for an exact match first
  if (registeredModals.has(incomingCustomId)) {
    modalInfo = registeredModals.get(incomingCustomId);
    matchedKey = incomingCustomId;
    // console.log(`[ModalHandler] Exact match found for customId: ${incomingCustomId}`);
  } else {
    // 2. If no exact match, check for a prefix match
    for (const [registeredPrefix, info] of registeredModals.entries()) {
      // Ensure it's a prefix and not just a substring within another ID part
      if (incomingCustomId.startsWith(registeredPrefix) &&
          (incomingCustomId.length === registeredPrefix.length || incomingCustomId.charAt(registeredPrefix.length) === '_')) {
        modalInfo = info;
        matchedKey = registeredPrefix; // The prefix used for registration
        // console.log(`[ModalHandler] Prefix match found. Incoming: ${incomingCustomId}, Matched Prefix: ${registeredPrefix}`);
        break;
      }
    }
  }

  if (!modalInfo || !matchedKey) {
    console.warn(`No handler found for modal customId: ${incomingCustomId} (neither exact nor prefix match).`);
    try {
      if (!interaction.replied && !interaction.deferred) {
        // It's good practice to acknowledge, deferReply is safer if unsure about immediate response
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {}); // Catch potential errors
        await interaction.editReply({ content: 'This interaction is not currently handled.' }).catch(() => {});
      }
    } catch (ackError) {
      console.error("Failed to acknowledge unhandled modal interaction:", ackError);
    }
    return;
  }

  // Execute the Handler
  const { handler } = modalInfo;
  try {
    await handler(client, interaction);
  } catch (error) {
    console.error(`Error executing modal handler for customId "${incomingCustomId}" (registered as ${matchedKey}):`, error);
    try {
      // Try to reply or follow up with an error message
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'There was an error processing your submission.', flags: MessageFlags.Ephemeral });
      } else {
        // If already replied/deferred, try followup. This might happen if handler deferred then threw.
        await interaction.followUp({ content: 'There was an error processing your submission.', flags: MessageFlags.Ephemeral });
      }
    } catch (replyError) {
      console.error("Failed to send error reply/followUp for modal handler error:", replyError);
    }
  }
}

/**
 * Register a modal submit handler.
 * @param client The Client instance.
 * @param customIdOrPrefix The exact customId or a prefix for dynamic IDs.
 * @param handler The async function to execute.
 */
function registerModalHandler(
  client: Client,
  customIdOrPrefix: string, // Parameter name updated
  handler: (client: Client, interaction: ModalSubmitInteraction) => Promise<void>
) {
  if (!client.modalHandlers) {
    console.error("[registerModalHandler] client.modalHandlers map not found! Initializing fallback.");
    client.modalHandlers = new Map<string, RegisteredModalInfo>();
  }

  const registeredModals = client.modalHandlers;

  if (registeredModals.has(customIdOrPrefix)) {
    console.warn(`[!] Overwriting existing modal handler for customId/prefix: ${customIdOrPrefix}`);
  }

  registeredModals.set(customIdOrPrefix, { handler });
  console.log(`[i] Registered modal handler for customId/prefix: ${customIdOrPrefix}`);
}

// Default Export for the Event Handler System
export default async function processModalInteraction(client: Client, interaction: Interaction) {
  await handleModalSubmit(client, interaction);
}

// Named Export for commands/modules to register their modal handlers
export { registerModalHandler };
