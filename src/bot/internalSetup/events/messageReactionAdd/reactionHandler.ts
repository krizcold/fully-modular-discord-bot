import { Client, MessageReaction, User, PartialUser, PartialMessageReaction, GatewayIntentBits } from 'discord.js';
import { RegisteredReactionInfo } from '../../../types/commandTypes';

export const requiredIntents = [
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessages, // For fetching partial messages if needed
    GatewayIntentBits.DirectMessageReactions, // If used in DMs
];

async function handleReaction(client: Client, reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
    // Fetch partials first to get emoji info
    if (reaction.partial) {
        try {
            reaction = await reaction.fetch();
        } catch (error) {
            console.error('[ReactionHandler] Failed to fetch partial reaction:', error);
            return;
        }
    }
    if (user.partial) {
        try {
            user = await user.fetch();
        } catch (error) {
            console.error('[ReactionHandler] Failed to fetch partial user:', error);
            return;
        }
    }

    const messageId = reaction.message.id;
    const reactedEmojiIdentifier = reaction.emoji.id || reaction.emoji.name;
    const handlerKey = `${messageId}_${reactedEmojiIdentifier}`;

    const reactionInfo = client.reactionHandlers?.get(handlerKey);
    if (!reactionInfo) return;

    // Check bot status with allowBots option
    if (user.bot && !reactionInfo.allowBots) {
        return;
    }

    const { handler, emojiIdentifier, endTime, guildId, maxEntries, collectedUsers } = reactionInfo;

    // End time check
    if (endTime && Date.now() > endTime) {
        // Giveaway/event might have ended. The unregister should ideally happen when the event concludes.
        // For robustness, we can remove it here if it's past time.
        // unregisterReactionHandler(client, messageId); // Consider if this is the right place.
        return;
    }

    // Guild check (if specified)
    if (guildId && reaction.message.guildId !== guildId) {
        return;
    }

    // Max entries / already collected check
    if (collectedUsers.has(user.id)) {
        return;
    }
    if (maxEntries && maxEntries > 0 && collectedUsers.size >= maxEntries) {
        return;
    }

    // Execute the handler
    try {
        // Ensure full types are passed to the handler
        await handler(client, reaction as MessageReaction, user as User, reactionInfo);
        collectedUsers.add(user.id); // Mark as collected after successful handler execution
    } catch (error) {
        console.error(`[ReactionHandler] Error executing reaction handler for message ${messageId}, emoji ${emojiIdentifier}:`, error);
    }
}

export function registerReactionHandler(
    client: Client,
    messageId: string,
    emojiIdentifier: string, // Unicode char or custom emoji ID
    handler: (client: Client, reaction: MessageReaction, user: User, self: RegisteredReactionInfo) => Promise<void>,
    options: {
        endTime?: number;
        guildId?: string;
        maxEntries?: number;
        allowBots?: boolean;
    } = {}
) {
    if (!client.reactionHandlers) {
        client.reactionHandlers = new Map<string, RegisteredReactionInfo>();
    }
    const info: RegisteredReactionInfo = {
        handler,
        emojiIdentifier,
        collectedUsers: new Set<string>(),
        endTime: options.endTime,
        guildId: options.guildId,
        maxEntries: options.maxEntries,
        allowBots: options.allowBots || false,
    };
    const handlerKey = `${messageId}_${emojiIdentifier}`;
    client.reactionHandlers.set(handlerKey, info);
    console.log(`[ReactionHandler] Registered handler for message ${messageId}, emoji ${emojiIdentifier}`);
}

export function unregisterReactionHandler(client: Client, messageId: string, emojiIdentifier?: string) {
    if (emojiIdentifier) {
        const handlerKey = `${messageId}_${emojiIdentifier}`;
        if (client.reactionHandlers?.delete(handlerKey)) {
            console.log(`[ReactionHandler] Unregistered handler for message ${messageId}, emoji ${emojiIdentifier}`);
        }
    } else {
        // Remove all handlers for this message (backwards compatibility)
        let removed = 0;
        for (const key of client.reactionHandlers?.keys() || []) {
            if (key.startsWith(`${messageId}_`)) {
                client.reactionHandlers?.delete(key);
                removed++;
            }
        }
        if (removed > 0) {
            console.log(`[ReactionHandler] Unregistered ${removed} handlers for message ${messageId}`);
        }
    }
}

// Default export for clientInitializer to pick up
export default async (client: Client, reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    await handleReaction(client, reaction, user);
};