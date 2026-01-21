import {
  Client,
  CommandInteraction,
  GatewayIntentBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  MessageFlags
} from 'discord.js';
import { registerDropdownHandler } from '@internal/events/interactionCreate/dropdownHandler';
import { CommandOptions } from '@bot/types/commandTypes';

const DROPDOWN_PREFIX = 'example_select';

const exampleDropdownCommand: CommandOptions = {
  name: 'dropdown-example',
  description: 'Shows a simple dropdown menu example.',
  testOnly: true,
  requiredIntents: [GatewayIntentBits.Guilds],

  initialize: (client: Client) => {
    registerDropdownHandler(
      client,
      DROPDOWN_PREFIX,
      handleSelection,
      null
    );
  },

  callback: async (client: Client, interaction: CommandInteraction) => {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(DROPDOWN_PREFIX)
      .setPlaceholder('Choose an option')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Option 1')
          .setDescription('This is the first option.')
          .setValue('option_1'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Option 2')
          .setDescription('This is the second option.')
          .setValue('option_2'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Option 3')
          .setDescription('This is the third option.')
          .setValue('option_3')
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>()
      .addComponents(selectMenu);

    try {
      await interaction.reply({
        content: 'Please choose one:',
        components: [row],
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      console.error("Failed to send dropdown example reply:", error);
    }
  },
};

async function handleSelection(client: Client, interaction: StringSelectMenuInteraction): Promise<void> {
  const selectedValue = interaction.values[0];

  let responseMessage = `You selected: ${selectedValue}`;

  try {
    await interaction.update({
      content: responseMessage,
      components: []
    });
  } catch (error) {
    console.error("Failed to update interaction after dropdown selection:", error);
    try {
      await interaction.followUp({ content: 'Error updating message.', flags: MessageFlags.Ephemeral });
    } catch (followUpError) {
      // Ignore secondary error
    }
  }
}

export = exampleDropdownCommand;
