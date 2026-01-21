import {
  Client,
  Interaction,
  StringSelectMenuInteraction,
  ChannelSelectMenuInteraction,
  AnySelectMenuInteraction,
  MessageFlags
} from 'discord.js';
import { RegisteredDropdownInfo } from '../../../types/commandTypes'; // Import the type
import { getConfigPropertyForGuild } from '../../utils/configManager';

// Default timeout (e.g., 15 minutes), can be adjusted or removed if not needed for dropdowns
const DEFAULT_DROPDOWN_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Handles incoming select menu interactions, using the map attached to the client.
 * Supports exact customId matches and then prefix-based matches.
 */
async function handleDropdownInteraction(client: Client, interaction: Interaction) {
  // Check if it's any type of select menu interaction
  if (!interaction.isAnySelectMenu()) {
    return;
  }

  // --- Use client.dropdownHandlers ---
  const registeredDropdowns = client.dropdownHandlers;
  if (!registeredDropdowns) {
      console.error("[handleDropdownInteraction] client.dropdownHandlers map not found!");
      try {
          if (!interaction.replied && !interaction.deferred) {
              await interaction.reply({ content: 'An internal error occurred (Dropdown map missing).', flags: MessageFlags.Ephemeral });
          }
      } catch (replyError) {
          console.error("Failed to send error reply for missing dropdown map:", replyError);
      }
      return;
  }

  const incomingCustomId = interaction.customId;
  let dropdownInfo: RegisteredDropdownInfo | undefined = undefined;
  let matchedKey: string | undefined = undefined;

  // 1. Check for an exact match first
  if (registeredDropdowns.has(incomingCustomId)) {
    dropdownInfo = registeredDropdowns.get(incomingCustomId);
    matchedKey = incomingCustomId;
    // console.log(`[DropdownHandler] Exact match found for customId: ${incomingCustomId}`);
  } else {
    // 2. If no exact match, check for a prefix match
    for (const [registeredPrefix, info] of registeredDropdowns.entries()) {
      if (incomingCustomId.startsWith(registeredPrefix) &&
          (incomingCustomId.length === registeredPrefix.length || incomingCustomId.charAt(registeredPrefix.length) === '_')) {
        dropdownInfo = info;
        matchedKey = registeredPrefix; // The prefix used for registration
        // console.log(`[DropdownHandler] Prefix match found. Incoming: ${incomingCustomId}, Matched Prefix: ${registeredPrefix}`);
        break;
      }
    }
  }


  // Check if handler exists for this customId
  if (!dropdownInfo || !matchedKey) {
    // Log which specific customId wasn't found
    console.warn(`No handler found for dropdown customId: ${incomingCustomId} (neither exact nor prefix match).`);
    try {
      if (!interaction.replied && !interaction.deferred) {
          await interaction.deferUpdate();
      }
    } catch (deferError) {
      console.error("Failed to defer update for unknown dropdown interaction:", deferError);
    }
    return;
  }

  // Perform Expiration Check
  const { handler, timeoutMs } = dropdownInfo;
  if (timeoutMs !== null) {
    const messageAge = interaction.createdTimestamp - interaction.message.createdTimestamp;
    const defaultTimeout = getConfigPropertyForGuild<number>('interaction.dropdownTimeoutMs', interaction.guildId);
    const effectiveTimeout = timeoutMs > 0 ? timeoutMs : defaultTimeout;
    if (messageAge > effectiveTimeout) {
      console.log(`Dropdown interaction expired and ignored: ${incomingCustomId} (handler for ${matchedKey})`);
      try {
        if (!interaction.replied && !interaction.deferred) {
            await interaction.deferUpdate();
        }
      } catch (error) {
        console.error(`Error deferring update for expired dropdown interaction:`, error);
      }
      return;
    }
  }

  // Execute the Handler
  try {
    await handler(client, interaction); // interaction is any select menu type
  } catch (error) {
    // Log error with the specific customId
    console.error(`Error executing dropdown handler for customId "${incomingCustomId}" (registered as ${matchedKey}):`, error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'There was an error processing your selection.', flags: MessageFlags.Ephemeral });
      } else if (!interaction.replied) { // implies deferred
        await interaction.editReply({ content: 'There was an error processing your selection.' });
      } else { // implies replied
        await interaction.followUp({ content: 'There was an error processing your selection.', flags: MessageFlags.Ephemeral });
      }
    } catch (replyError) {
      console.error("Failed to send error reply/followUp for dropdown handler error:", replyError);
    }
  }
}

/**
 * Register a dropdown handler FOR THE GIVEN CLIENT INSTANCE.
 * @param client The Client instance to attach the handler map to.
 * @param customIdOrPrefix The exact customId (for non-dynamic menus) or a prefix (for dynamic menus).
 * @param handler The async function to execute when a matching dropdown is used.
 * @param timeoutMs Optional timeout duration (null for never expire based on message age).
 */
function registerDropdownHandler<TInteraction extends AnySelectMenuInteraction = AnySelectMenuInteraction>(
  client: Client,
  customIdOrPrefix: string,
  handler: (client: Client, interaction: TInteraction) => Promise<void>,
  timeoutMs: number | null = DEFAULT_DROPDOWN_TIMEOUT_MS
) {
  if (!client.dropdownHandlers) {
    console.error("[registerDropdownHandler] client.dropdownHandlers map not found! Initializing fallback. This should not happen if clientInitializer is correct.");
    client.dropdownHandlers = new Map<string, RegisteredDropdownInfo>();
  }

  const registeredDropdowns = client.dropdownHandlers;

  if (registeredDropdowns.has(customIdOrPrefix)) {
     console.warn(`[!] Overwriting existing dropdown handler for customId/prefix: ${customIdOrPrefix}`);
  }

  registeredDropdowns.set(customIdOrPrefix, { handler: handler as any, timeoutMs });
  const timeoutDesc = timeoutMs === null ? 'never expires' : `${timeoutMs}ms`;
  console.log(`[i] Registered dropdown handler for customId/prefix: ${customIdOrPrefix} (Timeout: ${timeoutDesc})`);
}

// Default Export for the Event Handler System
export default async function processDropdownInteraction(client: Client, interaction: Interaction) {
    await handleDropdownInteraction(client, interaction);
}

// Named Export for commands/modules to register their dropdown handlers
export { registerDropdownHandler };

