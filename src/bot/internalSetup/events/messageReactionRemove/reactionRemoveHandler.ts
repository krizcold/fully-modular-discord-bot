import { Client, MessageReaction, User, PartialUser, PartialMessageReaction, GatewayIntentBits } from 'discord.js';
import { RegisteredReactionRemoveInfo } from '@bot/types/commandTypes';

export const requiredIntents = [
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessages,
];

async function handleReactionRemove(client: Client, reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
    // Ignore bot reactions
    if (user.partial === false && user.bot) {
        return;
    }

    // Fetch partials
    if (reaction.partial) {
        try {
            reaction = await reaction.fetch();
        } catch (error) {
            console.error('[ReactionRemoveHandler] Failed to fetch partial reaction:', error);
            return;
        }
    }
    if (user.partial) {
        try {
            user = await user.fetch();
        } catch (error) {
            console.error('[ReactionRemoveHandler] Failed to fetch partial user:', error);
            return;
        }
    }

    if (user.bot) return;

    const messageId = reaction.message.id;
    const handlers = client.reactionRemoveHandlers?.get(messageId);

    if (!handlers || handlers.length === 0) return;

    const reactedEmojiIdentifier = reaction.emoji.id || reaction.emoji.name;

    for (const info of handlers) {
        if (info.emojiIdentifier !== reactedEmojiIdentifier) continue;
        if (info.guildId && reaction.message.guildId !== info.guildId) continue;

        try {
            await info.handler(client, reaction as MessageReaction, user as User);
        } catch (error) {
            console.error(`[ReactionRemoveHandler] Error executing handler for message ${messageId}:`, error);
        }
    }
}

export function registerReactionRemoveHandler(
    client: Client,
    messageId: string,
    emojiIdentifier: string,
    handler: (client: Client, reaction: MessageReaction, user: User) => Promise<void>,
    options: { guildId?: string } = {}
) {
    if (!client.reactionRemoveHandlers) {
        client.reactionRemoveHandlers = new Map<string, RegisteredReactionRemoveInfo[]>();
    }

    const info: RegisteredReactionRemoveInfo = {
        handler,
        emojiIdentifier,
        guildId: options.guildId,
    };

    const existing = client.reactionRemoveHandlers.get(messageId) || [];
    existing.push(info);
    client.reactionRemoveHandlers.set(messageId, existing);
}

export function unregisterReactionRemoveHandler(client: Client, messageId: string) {
    client.reactionRemoveHandlers?.delete(messageId);
}

export default async (client: Client, reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    await handleReactionRemove(client, reaction, user);
};
