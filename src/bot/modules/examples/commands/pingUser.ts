import {
  Client,
  UserContextMenuCommandInteraction,
  ApplicationCommandType,
  GatewayIntentBits,
} from 'discord.js';

import { ContextMenuCommandOptions } from '@bot/types/commandTypes';

const pingUserCommand: ContextMenuCommandOptions<UserContextMenuCommandInteraction> = {
  name: 'Ping User',
  type: ApplicationCommandType.User,
  testOnly: true,
  requiredIntents: [GatewayIntentBits.Guilds],

  callback: async (client: Client, interaction: UserContextMenuCommandInteraction) => {
    try {
      await interaction.deferReply();
    } catch (deferError) {
      console.error(`Error deferring reply for Ping User interaction:`, deferError);
      return;
    }

    const targetUser = interaction.targetUser;
    const replyContent = `Pong! ${targetUser} (${client.ws.ping}ms)`;

    try {
      await interaction.editReply(replyContent);
    } catch (error) {
      console.error(`Error editing reply for Ping User interaction:`, error);
      await interaction.followUp({ content: 'An error occurred.' });
    }
  },
};

export = pingUserCommand;
