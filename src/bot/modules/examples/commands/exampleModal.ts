import {
  Client,
  CommandInteraction,
  GatewayIntentBits,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
  MessageFlags
} from 'discord.js';
import { registerModalHandler } from '@internal/events/interactionCreate/modalSubmitHandler';
import { CommandOptions } from '@bot/types/commandTypes';

const MODAL_ID = 'example_feedback_modal';

const exampleModalCommand: CommandOptions = {
  name: 'modal-example',
  description: 'Shows an example modal popup.',
  testOnly: true,
  requiredIntents: [GatewayIntentBits.Guilds],

  initialize: (client: Client) => {
    registerModalHandler(
      client,
      MODAL_ID,
      handleModalSubmission
    );
  },

  callback: async (client: Client, interaction: CommandInteraction) => {
    const modal = new ModalBuilder()
      .setCustomId(MODAL_ID)
      .setTitle('My Example Modal');

    const favoriteColorInput = new TextInputBuilder()
      .setCustomId('favoriteColorInput')
      .setLabel("What's your favorite color?")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder('e.g., Blue');

    const feedbackInput = new TextInputBuilder()
      .setCustomId('feedbackInput')
      .setLabel("Any feedback for us?")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setPlaceholder('Enter your feedback here...');

    const firstActionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(favoriteColorInput);
    const secondActionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(feedbackInput);

    modal.addComponents(firstActionRow, secondActionRow);

    try {
      await interaction.showModal(modal);
    } catch (error) {
      console.error("Failed to show modal:", error);
      if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Could not display the modal.', flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
          await interaction.followUp({ content: 'Could not display the modal.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  },
};

async function handleModalSubmission(client: Client, interaction: ModalSubmitInteraction): Promise<void> {
  const favoriteColor = interaction.fields.getTextInputValue('favoriteColorInput');
  const feedback = interaction.fields.getTextInputValue('feedbackInput');

  console.log(`Modal submitted: Color='${favoriteColor}', Feedback='${feedback}' (Custom ID: ${interaction.customId})`);

  let responseMessage = `Thanks for submitting! Your favorite color is ${favoriteColor}.`;
  if (feedback) {
    responseMessage += `\nWe appreciate your feedback: "${feedback}"`;
  } else {
    responseMessage += `\nNo feedback provided.`;
  }

  try {
    await interaction.reply({
      content: responseMessage,
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.error("Failed to reply to modal submission:", error);
  }
}

export = exampleModalCommand;
