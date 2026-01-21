import { Client, ButtonInteraction, MessageFlags, Interaction, PermissionsBitField, GuildMember, PermissionResolvable } from 'discord.js';
import { RegisteredButtonInfo, SpecialUserRule } from '../../../types/commandTypes';
import { getConfigPropertyForGuild } from '../../utils/configManager';

// Default timeout duration (15 minutes in milliseconds)
const DEFAULT_BUTTON_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_USER_LEVEL = -1;

/**
 * Handles incoming button interactions, checking permissions and special user rules.
 * Supports exact customId matches and then prefix-based matches.
 */
async function handleButtonInteraction(client: Client, interaction: ButtonInteraction) {
  if (!interaction.isButton()) return;

  const registeredButtons = client.buttonHandlers;
  if (!registeredButtons || registeredButtons.size === 0) {
    console.error("[handleButtonInteraction] client.buttonHandlers map not found or is empty!");
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'An internal error occurred (Button map missing/empty).', flags: MessageFlags.Ephemeral });
      }
    } catch (replyError) {
      console.error("Failed to send error reply for missing button map:", replyError);
    }
    return;
  }

  const incomingCustomId = interaction.customId;
  let buttonInfo: RegisteredButtonInfo | undefined = undefined;
  let matchedKey: string | undefined = undefined; // To store the key that led to the handler (exact ID or prefix)

  // 1. Check for an exact match first
  if (registeredButtons.has(incomingCustomId)) {
    buttonInfo = registeredButtons.get(incomingCustomId);
    matchedKey = incomingCustomId;
    // console.log(`[ButtonHandler] Exact match found for customId: ${incomingCustomId}`);
  } else {
    // 2. If no exact match, check for a prefix match
    // Iterate to find the longest matching prefix if multiple could match (e.g. "prefix" and "prefix_action")
    // For simplicity, this uses the first one found. For more complex scenarios, sort keys by length descending.
    for (const [registeredPrefix, info] of registeredButtons.entries()) {
      // Ensure it's a prefix and not just a substring within another ID part
      if (incomingCustomId.startsWith(registeredPrefix) && 
          (incomingCustomId.length === registeredPrefix.length || incomingCustomId.charAt(registeredPrefix.length) === '_')) {
        buttonInfo = info;
        matchedKey = registeredPrefix; // The prefix used for registration
        // console.log(`[ButtonHandler] Prefix match found. Incoming: ${incomingCustomId}, Matched Prefix: ${registeredPrefix}`);
        break;
      }
    }
  }

  if (!buttonInfo || !matchedKey) {
    console.warn(`No handler found for button customId: ${incomingCustomId} (neither exact nor prefix match).`);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.deferUpdate();
      }
    } catch (deferError) {
      console.error("Failed to defer update for unknown button interaction:", deferError);
    }
    return;
  }

  // --- Permission Check (Denial) ---
  if (buttonInfo.permissionsRequired?.length) {
    if (!interaction.inGuild() || !(interaction.member instanceof GuildMember)) {
        console.warn(`Button ${incomingCustomId} (handler for ${matchedKey}) requires permissions, but interaction is not in a guild or member data is unavailable.`);
         try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'This button cannot be used here.', flags: MessageFlags.Ephemeral });
            }
         } catch (replyError) { /* Ignore */ }
        return;
    }
    for (const permission of buttonInfo.permissionsRequired) {
      if (!interaction.member.permissions.has(permission)) {
        console.log(`User ${interaction.user.tag} lacks permission '${permission}' for button ${incomingCustomId} (handler for ${matchedKey})`);
        try {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'You do not have permission to use this button.', flags: MessageFlags.Ephemeral });
          }
        } catch (replyError) { /* Ignore */ }
        return;
      }
    }
  }
  // --- End Permission Check ---

  // --- Special User Check (Determine Response Level) ---
  let userLevel = DEFAULT_USER_LEVEL;
  if (buttonInfo.specialUsers?.length && interaction.inGuild() && interaction.member instanceof GuildMember) {
    for (const rule of buttonInfo.specialUsers) {
      let match = false;
      if (rule.type === 'user' && interaction.user.id === rule.id) {
        match = true;
      } else if (rule.type === 'permission' && interaction.member.permissions.has(rule.id)) {
        match = true;
      }
      if (match) {
        userLevel = rule.value;
        break;
      }
    }
  }
  // --- End Special User Check ---

  // Perform Expiration Check
  const { handler, timeoutMs } = buttonInfo;
  if (timeoutMs !== null) {
    const messageAge = interaction.createdTimestamp - interaction.message.createdTimestamp;
    const defaultTimeout = getConfigPropertyForGuild<number>('interaction.buttonTimeoutMs', interaction.guildId);
    const effectiveTimeout = timeoutMs > 0 ? timeoutMs : defaultTimeout;
    if (messageAge > effectiveTimeout) {
      console.log(`Button interaction expired and ignored: ${incomingCustomId}`);
      try {
        if (!interaction.replied && !interaction.deferred) { await interaction.deferUpdate(); }
      } catch (error) { /* Ignore */ }
      return;
    }
  }

  // Execute the Handler
  try {
    await handler(client, interaction, userLevel);
  } catch (error) {
    console.error(`Error executing button handler for customId "${incomingCustomId}" (registered as ${matchedKey}, UserLevel: ${userLevel}):`, error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'There was an error processing this button click.', flags: MessageFlags.Ephemeral });
      } else if (!interaction.replied) {
        await interaction.editReply({ content: 'There was an error processing this button click.' });
      } else {
        await interaction.followUp({ content: 'There was an error processing this button click.', flags: MessageFlags.Ephemeral });
      }
    } catch (replyError) { /* Ignore */ }
  }
}

/**
 * Register a button handler.
 * @param client The Client instance.
 * @param customIdOrPrefix The exact customId (for non-dynamic buttons) or a prefix (for dynamic buttons).
 * @param handler The async function to execute.
 * @param options Optional settings.
 */
function registerButtonHandler(
  client: Client,
  customIdOrPrefix: string,
  handler: (client: Client, interaction: ButtonInteraction, userLevel: number) => Promise<void>,
  options?: {
      timeoutMs?: number | null;
      permissionsRequired?: PermissionResolvable[];
      specialUsers?: SpecialUserRule[];
  }
) {
  if (!client.buttonHandlers) {
    console.error("[registerButtonHandler] client.buttonHandlers map not found! Initializing fallback.");
    client.buttonHandlers = new Map<string, RegisteredButtonInfo>();
  }

  const registeredButtons = client.buttonHandlers;
  const timeoutMs = options?.timeoutMs === undefined ? DEFAULT_BUTTON_TIMEOUT_MS : options.timeoutMs;
  const permissionsRequired = options?.permissionsRequired;
  const specialUsers = options?.specialUsers;

  if (registeredButtons.has(customIdOrPrefix)) {
     console.warn(`[!] Overwriting existing button handler for customId/prefix: ${customIdOrPrefix}`);
  }

  registeredButtons.set(customIdOrPrefix, { handler, timeoutMs, permissionsRequired, specialUsers });

  const timeoutDesc = timeoutMs === null ? 'never expires' : `${timeoutMs}ms`;
  const permsDesc = permissionsRequired ? ` (Requires: ${permissionsRequired.join(', ')})` : '';
  const specialDesc = specialUsers ? ` (Special Users: ${specialUsers.length} rules)` : '';
  console.log(`[i] Registered button handler for customId/prefix: ${customIdOrPrefix} (Timeout: ${timeoutDesc})${permsDesc}${specialDesc}`);
}

// Default Export for the Event Handler System
export default async function eventFunction(client: Client, interaction: Interaction) {
  if (!interaction.isButton()) {
    return;
  }
  await handleButtonInteraction(client, interaction as ButtonInteraction);
}

// Named Export for commands/modules to register their button handlers
export { registerButtonHandler };

