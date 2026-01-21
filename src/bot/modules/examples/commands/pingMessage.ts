import {
  Client,
  MessageContextMenuCommandInteraction,
  ApplicationCommandType,
  GatewayIntentBits
} from 'discord.js';
import { ContextMenuCommandOptions } from '@bot/types/commandTypes';

const pingMessageCommand: ContextMenuCommandOptions<MessageContextMenuCommandInteraction> = {
  name: 'Ping Message',
  type: ApplicationCommandType.Message,
  testOnly: true,
  requiredIntents: [GatewayIntentBits.Guilds],
  permissionsRequired: ['SendMessages', 'ReadMessageHistory'],
  botPermissions: ['SendMessages'],

  callback: async (client: Client, interaction: MessageContextMenuCommandInteraction) => {
    try {
      await interaction.deferReply();
    } catch (deferError) {
      console.error(`Error deferring reply for Ping Message interaction:`, deferError);
      return;
    }

    const targetMessage = interaction.targetMessage;
    const replyContent = `Pong! (${client.ws.ping}ms) on message: ${targetMessage.url}`;

    try {
      await interaction.editReply(replyContent);
    } catch (error) {
      console.error(`Error editing reply for Ping Message interaction:`, error);
    }
  },
};

export = pingMessageCommand;
