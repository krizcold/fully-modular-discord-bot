import { ApplicationCommandOptionType, ChatInputCommandInteraction, Client, CommandInteraction, MessageFlags } from 'discord.js';
import { CommandOptions } from '@bot/types/commandTypes';

/**
 * Dev-only control for the web-UI listener. `stop` closes the HTTP listener (the
 * bot stays connected to Discord); `start` re-opens it. This is the Discord-side
 * recovery path after the access-log channel's "Shut down web-UI" button.
 */
const webuiCommand: CommandOptions = {
  name: 'webui',
  description: 'Start or stop the bot web-UI listener (developers only)',
  devOnly: true,
  options: [
    {
      name: 'action',
      description: 'start or stop the web-UI listener',
      type: ApplicationCommandOptionType.String,
      required: true,
      choices: [
        { name: 'start', value: 'start' },
        { name: 'stop', value: 'stop' },
      ],
    },
  ],

  callback: async (_client: Client, interaction: CommandInteraction) => {
    const action = (interaction as ChatInputCommandInteraction).options.getString('action') === 'stop' ? 'stop' : 'start';
    process.send?.({ type: action === 'stop' ? 'control:stop-webui' : 'control:start-webui' });
    await interaction.reply({
      content: action === 'stop' ? 'Stopping the web-UI listener.' : 'Restarting the web-UI listener.',
      flags: MessageFlags.Ephemeral,
    });
  },
};

export = webuiCommand;
