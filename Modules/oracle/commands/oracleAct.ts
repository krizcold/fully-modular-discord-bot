import { ApplicationCommandOptionType, Client, CommandInteraction, GatewayIntentBits, MessageFlags } from 'discord.js';
import { CommandOptions } from '@bot/types/commandTypes';
import { saveAction } from '../oracleSave';

type WithNonce = { options: { getString(name: string): string | null } };

const oracleActCommand: CommandOptions = {
  name: 'oracle-act',
  description: 'Saves one oracle action doc for the live tests.',
  testOnly: false,
  requiredIntents: [GatewayIntentBits.Guilds],
  options: [{ name: 'nonce', description: 'The act run\'s nonce', type: ApplicationCommandOptionType.String, required: true }],

  callback: async (_client: Client, interaction: CommandInteraction) => {
    const nonce = (interaction as unknown as WithNonce).options.getString('nonce');
    const file = await saveAction(interaction.guildId, nonce, 'invoke');
    await interaction.reply({ content: `Saved ${file}.`, flags: MessageFlags.Ephemeral });
  },
};

// The command loader takes `default` when a module has it (getLocalCommands.ts:35).
export default oracleActCommand;
