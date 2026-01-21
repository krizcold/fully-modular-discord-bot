import { Client, CommandInteraction, GatewayIntentBits } from 'discord.js';
import { CommandOptions } from '@bot/types/commandTypes';

const pingCommand: CommandOptions = {
  name: 'ping',
  description: 'Pong!',
  testOnly: true,
  requiredIntents: [
    GatewayIntentBits.Guilds,
  ],

  callback: (client: Client, interaction: CommandInteraction) => {
    interaction.reply(`Pong! ${client.ws.ping}ms.`);
  },
};

export = pingCommand;
