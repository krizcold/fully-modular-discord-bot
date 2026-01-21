import {
  Client,
  CommandInteraction,
  GatewayIntentBits,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ButtonInteraction,
  MessageFlags
} from 'discord.js';

import { registerButtonHandler } from '@internal/events/interactionCreate/buttonHandler';
import { CommandOptions } from '@bot/types/commandTypes';

const BUTTON_PREFIX = 'ping-response';

const pingButtonCommand: CommandOptions = {
  name: 'ping-button',
  description: 'Sends a ping button!',
  testOnly: true,
  requiredIntents: [GatewayIntentBits.Guilds],

  initialize: (client: Client) => {
    registerButtonHandler(
      client,
      BUTTON_PREFIX,
      async (btnClient: Client, btnInteraction: ButtonInteraction) => {
        await btnInteraction.reply({ content: `Pong! 🏓`, flags: MessageFlags.Ephemeral });
      },
      { timeoutMs: null }
    );
  },

  callback: async (client: Client, interaction: CommandInteraction) => {
    console.log("Ping button command executed");

    const button = new ButtonBuilder()
      .setCustomId(BUTTON_PREFIX)
      .setLabel('Click me!')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

    try {
        await interaction.reply({
          content: 'Click the button below to test!',
          components: [row],
          flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        console.error("Failed to send ping button reply:", error);
    }
  },
};

export = pingButtonCommand;
