import { Client, Message, PartialMessage } from 'discord.js';
import { unregisterReactionHandler } from '../messageReactionAdd/reactionHandler';
import { unregisterReactionRemoveHandler } from '../messageReactionRemove/reactionRemoveHandler';

// Reaction handlers registered on a deleted message are dead by definition -
// prune them so the client maps only hold live messageIds
export default async function (client: Client, message: Message | PartialMessage) {
  unregisterReactionHandler(client, message.id);
  unregisterReactionRemoveHandler(client, message.id);
}
